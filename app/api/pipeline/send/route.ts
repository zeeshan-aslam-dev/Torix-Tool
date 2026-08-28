import prisma from '../../../../lib/prisma';
import { mapWithConcurrency } from '../../../../lib/webVerify';
import {
  buildCsv,
  splitName,
  readInstantlyConfig,
  pushToInstantly,
  batchLabel,
  SendableLead,
} from '../../../../lib/instantly';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

type SendRequest = {
  tags?: string[];
  states?: string;
  limit?: number;
  concurrency?: number;
  mode?: 'csv' | 'api';
  resend?: boolean;
};

/**
 * Step 5 — pushes contacted leads into the email tool.
 *
 * Leads without an email address are skipped outright; Instantly is an email
 * channel, and a row without one is noise on import. Leads already queued or sent
 * are skipped too unless `resend` is set, so pressing the button twice cannot mail
 * the same practice twice.
 */
export async function POST(req: Request) {
  let body: SendRequest = {};
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
  const limit = Math.max(1, Math.min(Number(body.limit) || 500, 5000));
  const concurrency = Math.max(1, Math.min(Number(body.concurrency) || 3, 10));
  const resend = Boolean(body.resend);

  const config = readInstantlyConfig();
  const mode: 'csv' | 'api' = body.mode === 'api' && config ? 'api' : 'csv';

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };

      try {
        const startedAt = Date.now();

        if (body.mode === 'api' && !config) {
          send({
            type: 'log',
            message:
              'INSTANTLY_API_KEY / INSTANTLY_CAMPAIGN_ID are not set in .env — falling back to CSV export.',
          });
        }

        const candidates = await prisma.lead.findMany({
          where: {
            tag: { in: tags },
            ...(stateList.length ? { state: { in: stateList } } : {}),
            contact: { is: { decisionMakerEmail: { not: null } } },
            ...(resend
              ? {}
              : { OR: [{ outreach: { is: null } }, { outreach: { is: { emailStatus: 'Not sent' } } }] }),
          },
          orderBy: [{ score: 'desc' }, { id: 'asc' }],
          take: limit,
          select: {
            id: true, leadKey: true, organization: true, city: true, state: true, score: true,
            phone: true, website_found: true,
            contact: {
              select: { decisionMakerName: true, decisionMakerTitle: true, decisionMakerEmail: true, decisionMakerPhone: true },
            },
          },
        });

        const withEmail = await prisma.lead.count({
          where: {
            tag: { in: tags },
            ...(stateList.length ? { state: { in: stateList } } : {}),
            contact: { is: { decisionMakerEmail: { not: null } } },
          },
        });

        if (candidates.length === 0) {
          send({
            type: 'error',
            message:
              withEmail === 0
                ? `No ${tags.join('/')} leads have an email address. Run Step 4, or add websites in Step 3 first.`
                : `All ${withEmail} emailable leads were already queued or sent. Tick "re-send" to include them.`,
          });
          return;
        }

        const leads: SendableLead[] = candidates.map((lead) => {
          const { firstName, lastName } = splitName(lead.contact?.decisionMakerName);
          return {
            leadId: lead.id,
            leadKey: lead.leadKey,
            email: lead.contact!.decisionMakerEmail!,
            firstName,
            lastName,
            companyName: lead.organization,
            phone: lead.contact?.decisionMakerPhone ?? lead.phone,
            title: lead.contact?.decisionMakerTitle ?? null,
            website: lead.website_found,
            city: lead.city,
            state: lead.state,
            score: lead.score,
          };
        });

        // One address can front several practice locations — mailing it once is enough.
        const seen = new Set<string>();
        const deduped = leads.filter((lead) => {
          const key = lead.email.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const duplicates = leads.length - deduped.length;

        // The suppression list outlives imports and resets, so it is the real
        // answer to "have we contacted this practice before?" — not the Lead table,
        // which a re-import can rewrite.
        const suppressed = new Set(
          (
            await prisma.suppression.findMany({
              where: {
                OR: [
                  { kind: 'email', value: { in: deduped.map((l) => l.email.toLowerCase()) } },
                  { kind: 'practice', value: { in: deduped.map((l) => l.leadKey ?? '').filter(Boolean) } },
                ],
              },
              select: { kind: true, value: true },
            })
          ).map((row) => `${row.kind}:${row.value}`)
        );

        const unique = resend
          ? deduped
          : deduped.filter(
              (lead) =>
                !suppressed.has(`email:${lead.email.toLowerCase()}`) &&
                !suppressed.has(`practice:${lead.leadKey ?? ''}`)
            );
        const blocked = deduped.length - unique.length;

        if (blocked > 0) {
          send({
            type: 'log',
            message: `${blocked.toLocaleString()} skipped — already on the suppression list from an earlier run.`,
          });
        }

        if (unique.length === 0) {
          send({
            type: 'error',
            message:
              'Every matching lead has already been contacted. Tick "re-send" only if you intend to mail them again.',
          });
          return;
        }

        send({
          type: 'log',
          message:
            `${withEmail.toLocaleString()} ${tags.join('/')} leads have an email — ` +
            `${unique.length.toLocaleString()} ready to ${mode === 'api' ? 'push to Instantly' : 'export'}` +
            (duplicates ? `, ${duplicates} duplicate address${duplicates === 1 ? '' : 'es'} collapsed.` : '.'),
        });

        const batch = batchLabel();
        const now = new Date();
        let sent = 0;
        let failed = 0;
        let processed = 0;

        if (mode === 'api') {
          send({ type: 'log', message: `Pushing into Instantly campaign ${config!.campaignId}...` });

          await mapWithConcurrency(unique, concurrency, async (lead) => {
            const result = await pushToInstantly(lead, config!);

            if (result.ok) {
              sent++;
              await recordOutreach(lead.leadId, 'Sent', now, config!.campaignId);
              await suppress('email', lead.email, 'sent', config!.campaignId);
              if (lead.leadKey) await suppress('practice', lead.leadKey, 'sent', config!.campaignId);
            } else {
              failed++;
              send({
                type: 'log',
                message: `  failed ${lead.email} — ${result.status ?? ''} ${result.error ?? ''}`.trim(),
              });
            }

            processed++;
            if (processed % 5 === 0 || processed === unique.length) {
              send({
                type: 'progress',
                processed, total: unique.length,
                percent: (processed / unique.length) * 100,
                sent, failed,
              });
            }
          });
        } else {
          // CSV path: mark the rows queued, hand back the file for a manual import.
          for (const lead of unique) {
            await recordOutreach(lead.leadId, 'Queued', now, batch);
            await suppress('email', lead.email, 'queued', batch);
            if (lead.leadKey) await suppress('practice', lead.leadKey, 'queued', batch);
            processed++;
            if (processed % 25 === 0 || processed === unique.length) {
              send({
                type: 'progress',
                processed, total: unique.length,
                percent: (processed / unique.length) * 100,
              });
            }
          }
          sent = unique.length;
        }

        const csv = mode === 'csv' ? buildCsv(unique) : null;

        for (const lead of unique.slice(0, 5)) {
          send({
            type: 'log',
            message: `  ${lead.email} — ${lead.firstName} ${lead.lastName}, ${lead.companyName} (score ${lead.score})`,
          });
        }

        send({
          type: 'done',
          mode,
          processed,
          sent,
          failed,
          batch,
          csv,
          filename: `instantly-${batch}.csv`,
          elapsedMs: Date.now() - startedAt,
          message:
            mode === 'api'
              ? `Pushed ${sent.toLocaleString()} leads to Instantly` +
                (failed ? `, ${failed.toLocaleString()} failed.` : '.')
              : `${sent.toLocaleString()} leads queued and written to CSV — download it and import into Instantly.`,
        });
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
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

/**
 * Writes the permanent "we have contacted this" record.
 *
 * Kept separate from Outreach on purpose: Outreach hangs off Lead and dies with it,
 * while this survives every import, reset and re-score.
 */
async function suppress(kind: 'email' | 'practice', value: string, reason: string, note?: string) {
  // Email addresses are case-insensitive, so they are stored folded. A leadKey is
  // already normalised and upper-cased — folding it too would mean the lookup on
  // the way back in never matches, and nothing would ever be suppressed.
  const key = kind === 'email' ? value.trim().toLowerCase() : value.trim();
  if (!key) return;
  await prisma.suppression.upsert({
    where: { kind_value: { kind, value: key } },
    create: { kind, value: key, reason, note },
    update: { reason, note },
  });
}

/** Creates or advances the Outreach row that tracks this lead's email touch. */
async function recordOutreach(leadId: number, status: string, when: Date, campaign: string) {
  const data = {
    emailStatus: status,
    emailDate: status === 'Sent' ? when : null,
    exportedAt: when,
    emailCampaign: campaign,
    pipelineStage: status === 'Sent' ? 'Contacted' : 'New',
  };
  await prisma.outreach.upsert({
    where: { leadId },
    create: { leadId, ...data },
    update: data,
  });
}
