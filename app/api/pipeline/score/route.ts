import prisma from '../../../../lib/prisma';
import { scoreLead, DEFAULT_THRESHOLDS, DEFAULT_SIZE_POLICY, Thresholds, SizePolicy } from '../../../../lib/scoring';
import { matchBlocklist, blocklistSize } from '../../../../lib/blocklist';
import { resolveScope, scopeWhere, describeScope } from '../../../../lib/scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;

type ScoreRequest = {
  hotThreshold?: number;
  verifyThreshold?: number;
  /**
   * At or above this many locations a lead is treated as a chain and
   * penalised outright, rather than getting the multi-location bonus.
   * Exposed here rather than left as a constant in lib/scoring.ts so the
   * ideal-customer size can be dialled in from the UI, indefinitely, without
   * a code change.
   */
  maxLocations?: number;
  states?: string;
  cities?: string;
  zips?: string;
  radiusZip?: string;
  radiusMiles?: number;
};

/**
 * Step 2 — scores every lead already in the DB and tags it HOT / VERIFY / EXCLUDE.
 *
 * Runs entirely on fields captured in Step 1, so it needs no API keys and can be
 * re-run as often as the thresholds are tweaked. Streams NDJSON progress like the
 * filter route so the UI shows live logs.
 */
export async function POST(req: Request) {
  let body: ScoreRequest = {};
  try {
    body = await req.json();
  } catch {
    // an empty body is fine — fall back to defaults
  }

  const thresholds: Thresholds = {
    hot: Number.isFinite(body?.hotThreshold) ? Number(body.hotThreshold) : DEFAULT_THRESHOLDS.hot,
    verify: Number.isFinite(body?.verifyThreshold) ? Number(body.verifyThreshold) : DEFAULT_THRESHOLDS.verify,
  };

  if (thresholds.hot <= thresholds.verify) {
    return jsonError('HOT threshold must be higher than the VERIFY threshold', 400);
  }

  const sizePolicy: SizePolicy = {
    ...DEFAULT_SIZE_POLICY,
    ...(Number.isFinite(body?.maxLocations) && Number(body.maxLocations) > DEFAULT_SIZE_POLICY.idealMin
      ? { chainCutoff: Number(body.maxLocations) }
      : {}),
  };

  const scope = resolveScope(body);
  const where = scopeWhere(scope);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };

      try {
        const startedAt = Date.now();
        const total = await prisma.lead.count({ where });

        if (total === 0) {
          send({
            type: 'error',
            message: 'No leads to score. Run Step 1 first.',
          });
          return;
        }

        send({ type: 'log', message: `Scope: ${describeScope(scope)}.` });
        for (const warning of scope.warnings) send({ type: 'log', message: `Scope warning: ${warning}.` });
        send({
          type: 'log',
          message:
            `Scoring ${total.toLocaleString()} leads (HOT >= ${thresholds.hot}, VERIFY >= ${thresholds.verify}) ` +
            `against ${blocklistSize()} blocklisted health systems...`,
        });

        const counts = { HOT: 0, VERIFY: 0, EXCLUDE: 0 };
        let blockedCount = 0;
        const now = new Date();
        const PAGE = 500;
        let processed = 0;
        let cursor: number | undefined;

        // Keyset pagination: the scored rows keep moving under an offset-based
        // query, so page by id instead.
        for (;;) {
          const page = await prisma.lead.findMany({
            where,
            take: PAGE,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            orderBy: { id: 'asc' },
            select: {
              id: true,
              organization: true,
              entityType: true,
              n_locations_detected: true,
              n_providers_at_location: true,
              authorizedOfficialTitle: true,
              authorizedOfficialName: true,
              phone: true,
              lastUpdateDate: true,
              isSoleProprietor: true,
              isOrganizationSubpart: true,
              parentOrganizationLbn: true,
              gbpStatus: true,
              webAcquisitionFlag: true,
            },
          });

          if (page.length === 0) break;
          cursor = page[page.length - 1].id;

          const updates = page.map((lead) => {
            const result = scoreLead(
              { ...lead, possibleAcquisition: lead.webAcquisitionFlag },
              thresholds,
              now,
              matchBlocklist,
              sizePolicy
            );
            if (result.reason.startsWith('blocklisted:')) blockedCount++;
            counts[result.tag]++;
            return prisma.lead.update({
              where: { id: lead.id },
              data: {
                score: result.score,
                tag: result.tag,
                reason: result.reason,
                possible_acquisition: result.possibleAcquisition,
                scoredAt: now,
              },
            });
          });

          await prisma.$transaction(updates);

          processed += page.length;
          send({
            type: 'progress',
            processed,
            total,
            counts,
            percent: (processed / total) * 100,
          });
        }

        // Everything the outreach steps can actually act on.
        const actionable = await prisma.lead.count({
          where: { ...where, tag: 'HOT', phone: { not: null } },
        });
        const withDecisionMaker = await prisma.lead.count({
          where: { ...where, tag: 'HOT', authorizedOfficialName: { not: null } },
        });

        const topReasons = await prisma.lead.findMany({
          where: { ...where, tag: 'HOT' },
          orderBy: [{ score: 'desc' }, { n_locations_detected: 'desc' }],
          take: 5,
          select: { organization: true, city: true, score: true, authorizedOfficialTitle: true },
        });

        send({
          type: 'log',
          message:
            `HOT ${counts.HOT.toLocaleString()}  |  VERIFY ${counts.VERIFY.toLocaleString()}  |  ` +
            `EXCLUDE ${counts.EXCLUDE.toLocaleString()}`,
        });
        send({
          type: 'log',
          message: `${actionable.toLocaleString()} HOT leads have a phone, ${withDecisionMaker.toLocaleString()} have a named decision maker.`,
        });
        if (blockedCount > 0) {
          send({
            type: 'log',
            message: `${blockedCount.toLocaleString()} excluded by the hospital blocklist.`,
          });
        }
        for (const lead of topReasons) {
          send({
            type: 'log',
            message: `  top: ${lead.score} — ${lead.organization} (${lead.city})${lead.authorizedOfficialTitle ? ` — ${lead.authorizedOfficialTitle}` : ''}`,
          });
        }

        send({
          type: 'done',
          processed,
          counts,
          actionable,
          withDecisionMaker,
          elapsedMs: Date.now() - startedAt,
          message: `Scored ${processed.toLocaleString()} leads in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
