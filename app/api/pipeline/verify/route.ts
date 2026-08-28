import prisma from '../../../../lib/prisma';
import { findDataFileByPrefix } from '../../../../lib/dataDir';
import { streamNppesFile, field } from '../../../../lib/nppes';
import {
  VerifyTarget,
  VerifyResult,
  AcquisitionSignal,
  detectAcquisition,
  domainFromEndpoint,
  domainCandidates,
  fetchHomepage,
  scorePageMatch,
  mapWithConcurrency,
} from '../../../../lib/webVerify';
import { serpApiConfigured, serpApiSearch, buildQuery } from '../../../../lib/serpapi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

type Candidate = VerifyResult & { host: string };

type VerifyRequest = {
  tags?: string[];
  states?: string;
  limit?: number;
  minConfidence?: number;
  concurrency?: number;
  useSerpApi?: boolean;
  recheck?: boolean;
};

/**
 * Step 3 — finds and confirms each lead's website.
 *
 * Sources run cheapest-first: NPPES endpoint domains, then guessed domains, then
 * (only if a key is present and the caller asked for it) a paid SerpAPI search.
 * A result is only written to `website_found` once the fetched page confirms the
 * lead by phone, city, address or name.
 */
export async function POST(req: Request) {
  let body: VerifyRequest = {};
  try {
    body = await req.json();
  } catch {
    // defaults are fine
  }

  const tags = body.tags?.length ? body.tags : ['HOT'];
  const stateList = (body.states ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const limit = Math.max(1, Math.min(Number(body.limit) || 100, 5000));
  const minConfidence = Number.isFinite(body.minConfidence) ? Number(body.minConfidence) : 40;
  const concurrency = Math.max(1, Math.min(Number(body.concurrency) || 5, 20));
  const wantSerpApi = Boolean(body.useSerpApi);
  const recheck = Boolean(body.recheck);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };

      try {
        const startedAt = Date.now();

        const leads = await prisma.lead.findMany({
          where: {
            tag: { in: tags },
            ...(stateList.length ? { state: { in: stateList } } : {}),
            ...(recheck ? {} : { websiteCheckedAt: null }),
          },
          orderBy: [{ score: 'desc' }, { id: 'asc' }],
          take: limit,
          select: {
            id: true, npi: true, organization: true, dbaNames: true,
            address: true, city: true, state: true, zip: true, phone: true,
          },
        });

        if (leads.length === 0) {
          send({
            type: 'error',
            message: recheck
              ? 'No leads match those tags. Run Step 2 first.'
              : 'Nothing left to check — every matching lead already has a result. Tick "re-check" to run them again.',
          });
          return;
        }

        send({
          type: 'log',
          message: `Verifying ${leads.length.toLocaleString()} ${tags.join('/')} leads (accept at confidence >= ${minConfidence}).`,
        });

        // --- Source 1: endpoint domains already in NPPES ---------------------
        const endpointDomains = await loadEndpointDomains(
          new Set(leads.map((l) => l.npi).filter(Boolean) as string[]),
          send
        );

        const serpApiReady = wantSerpApi && serpApiConfigured();
        if (wantSerpApi && !serpApiReady) {
          send({
            type: 'log',
            message: 'SerpAPI requested but SERPAPI_KEY is not set — running free sources only.',
          });
        }

        const stats = {
          found: 0, blocked: 0, parked: 0, none: 0, acquisitions: 0,
          bySource: { endpoint: 0, guess: 0, serpapi: 0 } as Record<string, number>,
          serpApiCalls: 0,
        };
        let processed = 0;

        await mapWithConcurrency(leads, concurrency, async (lead) => {
          const target: VerifyTarget = lead;
          // Held on an object rather than a plain `let`: TypeScript cannot see
          // assignments made inside keepBetter() and would narrow it to null.
          const state: { best: Candidate | null; acquisition: AcquisitionSignal | null } = {
            best: null,
            acquisition: null,
          };

          /** Fetches one host and keeps it only if it beats what we already have. */
          const consider = async (host: string, source: VerifyResult['source']): Promise<Candidate | null> => {
            const outcome = await fetchHomepage(host);
            const scored = scorePageMatch(target, outcome, host);
            return { ...scored, source, host };
          };

          const keepBetter = (candidate: Candidate | null) => {
            if (!candidate) return;
            // Worth recording even from a page that loses on confidence — the claim
            // is about ownership, not about which domain is the real website.
            state.acquisition = state.acquisition ?? candidate.acquisition;
            if (!state.best || candidate.confidence > state.best.confidence) state.best = candidate;
          };

          const confidenceSoFar = () => (state.best ? state.best.confidence : -1);

          for (const domain of endpointDomains.get(lead.npi ?? '') ?? []) {
            if (confidenceSoFar() >= 75) break;
            keepBetter(await consider(domain, 'endpoint'));
          }

          if (confidenceSoFar() < minConfidence) {
            for (const candidate of domainCandidates(target)) {
              if (confidenceSoFar() >= 75) break;
              keepBetter(await consider(candidate, 'guess'));
            }
          }

          // --- Source 3: paid search, only for what is still unresolved ------
          if (serpApiReady && confidenceSoFar() < minConfidence) {
            try {
              stats.serpApiCalls++;
              const hits = await serpApiSearch(buildQuery(lead.organization, lead.city, lead.state));

              // A search snippet often states the acquisition more plainly than the
              // practice's own homepage does, so read them before following links.
              for (const hit of hits) {
                const signal = detectAcquisition(`${hit.title}. ${hit.snippet}`);
                if (signal) {
                  state.acquisition = state.acquisition ?? signal;
                  break;
                }
              }

              for (const hit of hits.slice(0, 3)) {
                keepBetter(await consider(new URL(hit.link).hostname, 'serpapi'));
                if (confidenceSoFar() >= minConfidence) break;
              }
            } catch (e) {
              send({
                type: 'log',
                message: `SerpAPI failed for ${lead.organization}: ${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }

          const winner = state.best;
          const accepted = winner && winner.confidence >= minConfidence ? winner : null;

          if (accepted) {
            stats.found++;
            stats.bySource[accepted.source ?? 'guess'] = (stats.bySource[accepted.source ?? 'guess'] ?? 0) + 1;
          } else if (winner?.snippet.includes('bot-blocked')) {
            stats.blocked++;
          } else if (winner?.snippet.includes('parked')) {
            stats.parked++;
          } else {
            stats.none++;
          }

          const acquisition = state.acquisition;
          if (acquisition) stats.acquisitions++;

          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              website_found: accepted?.website ?? null,
              websiteSource: accepted?.source ?? null,
              websiteConfidence: winner?.confidence ?? 0,
              search_snippet: acquisition
                ? `ACQUIRED? "${acquisition.phrase}" — ${acquisition.context}`
                : winner?.snippet ?? 'no candidate produced',
              websiteCheckedAt: new Date(),
              // Only ever set here, never cleared: an earlier run may have found the
              // evidence on a page that has since been taken down.
              ...(acquisition ? { possible_acquisition: true } : {}),
            },
          });

          processed++;
          if (processed % 10 === 0 || processed === leads.length) {
            send({
              type: 'progress',
              processed,
              total: leads.length,
              percent: (processed / leads.length) * 100,
              found: stats.found,
            });
          }

          return accepted;
        });

        send({
          type: 'log',
          message:
            `Websites found ${stats.found.toLocaleString()} | bot-blocked ${stats.blocked} | ` +
            `parked ${stats.parked} | nothing ${stats.none}`,
        });
        send({
          type: 'log',
          message:
            `By source — endpoint ${stats.bySource.endpoint}, guessed ${stats.bySource.guess}, ` +
            `search ${stats.bySource.serpapi}${stats.serpApiCalls ? ` (${stats.serpApiCalls} paid queries)` : ''}`,
        });

        const samples = await prisma.lead.findMany({
          where: { id: { in: leads.map((l) => l.id) }, website_found: { not: null } },
          orderBy: { websiteConfidence: 'desc' },
          take: 5,
          select: { organization: true, website_found: true, websiteConfidence: true, search_snippet: true },
        });
        for (const s of samples) {
          send({
            type: 'log',
            message: `  ${s.websiteConfidence}% ${s.website_found} — ${s.organization}`,
          });
        }

        if (stats.acquisitions > 0) {
          send({
            type: 'log',
            message:
              `${stats.acquisitions.toLocaleString()} flagged as possibly acquired — ` +
              `their reason field carries the sentence that said so.`,
          });
        }

        send({
          type: 'done',
          processed,
          found: stats.found,
          stats,
          elapsedMs: Date.now() - startedAt,
          message: `Checked ${processed.toLocaleString()} leads in ${((Date.now() - startedAt) / 1000).toFixed(0)}s — ${stats.found.toLocaleString()} websites confirmed.`,
        });
      } catch (error) {
        send({ type: 'error', message: errorMessage(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}

/** NPI -> usable domains taken from the NPPES endpoint pipe-file. */
async function loadEndpointDomains(
  npis: Set<string>,
  send: (event: Record<string, unknown>) => void
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const file = findDataFileByPrefix('endpoint_pfile');

  if (!file) {
    send({ type: 'log', message: 'No endpoint_pfile found — skipping that source.' });
    return result;
  }

  await streamNppesFile(file, {
    prefilter: (line) => npis.has(line.slice(1, 11)),
    onRow: (fields, index) => {
      const npi = field(fields, index, 'NPI').trim();
      if (!npis.has(npi)) return;
      const domain = domainFromEndpoint(field(fields, index, 'Endpoint'));
      if (!domain) return;
      const list = result.get(npi) ?? [];
      if (!list.includes(domain)) {
        list.push(domain);
        result.set(npi, list);
      }
    },
    progressEvery: 500_000,
  });

  const total = Array.from(result.values()).reduce((n, list) => n + list.length, 0);
  send({
    type: 'log',
    message: `Endpoint file gave ${total} candidate domains for ${result.size} leads.`,
  });
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
