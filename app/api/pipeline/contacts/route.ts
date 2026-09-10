import prisma from '../../../../lib/prisma';
import { mapWithConcurrency, detectOwnerName } from '../../../../lib/webVerify';
import { resolveScope, scopeWhere, describeScope } from '../../../../lib/scope';
import { nameLikelyMatches } from '../../../../lib/nppes';
import {
  extractEmails,
  extractLinkedIn,
  contactPageLinks,
  fetchPage,
  titleCase,
  EmailCandidate,
} from '../../../../lib/contacts';
import {
  verifyEmail,
  emailVerifierConfigured,
  isSendable,
  EmailVerdict,
  VerifyStatus,
} from '../../../../lib/emailVerify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

type ContactsRequest = {
  tags?: string[];
  states?: string;
  limit?: number;
  concurrency?: number;
  minEmailConfidence?: number;
  scrapeWebsites?: boolean;
  recheck?: boolean;
  cities?: string;
  zips?: string;
  radiusZip?: string;
  radiusMiles?: number;
  verifyEmails?: boolean;
  allowRiskyEmails?: boolean;
};

/**
 * Step 4 — builds a Contact for each lead from free sources only.
 *
 * The NPPES Authorized Official gives a name, title and phone for every
 * organization. Email is not in NPPES at all, so it comes from the practice's own
 * website when Step 3 found one: mailto links and addresses on the contact page.
 *
 * Every address found is then verified before it can reach Step 5. A scraped
 * address is the least trustworthy field in the pipeline, and a bounce rate over
 * roughly 5% burns a sending domain permanently.
 */
export async function POST(req: Request) {
  let body: ContactsRequest = {};
  try {
    body = await req.json();
  } catch {
    // defaults are fine
  }

  const tags = body.tags?.length ? body.tags : ['HOT'];
  const scope = resolveScope(body);
  const limit = Math.max(1, Math.min(Number(body.limit) || 500, 5000));
  const concurrency = Math.max(1, Math.min(Number(body.concurrency) || 5, 20));
  const minEmailConfidence = Number.isFinite(body.minEmailConfidence)
    ? Number(body.minEmailConfidence)
    : 45;
  const scrapeWebsites = body.scrapeWebsites !== false;
  const recheck = Boolean(body.recheck);
  // On by default: the local layer costs nothing and rejects dead domains.
  const verifyEmails = body.verifyEmails !== false;
  const allowRiskyEmails = Boolean(body.allowRiskyEmails);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };

      try {
        const startedAt = Date.now();

        send({ type: 'log', message: `Scope: ${describeScope(scope)}.` });
        for (const warning of scope.warnings) send({ type: 'log', message: `Scope warning: ${warning}.` });

        const leads = await prisma.lead.findMany({
          where: {
            tag: { in: tags },
            ...scopeWhere(scope),
            ...(recheck ? {} : { contact: { is: null } }),
          },
          orderBy: [{ score: 'desc' }, { id: 'asc' }],
          take: limit,
          select: {
            id: true, organization: true, city: true, phone: true,
            authorizedOfficialName: true, authorizedOfficialTitle: true,
            authorizedOfficialPhone: true, website_found: true,
          },
        });

        if (leads.length === 0) {
          send({
            type: 'error',
            message: recheck
              ? 'No leads match those tags. Run Step 2 first.'
              : 'Every matching lead already has a contact. Tick "re-check" to run them again.',
          });
          return;
        }

        const withSite = leads.filter((l) => l.website_found).length;
        send({
          type: 'log',
          message:
            `Building contacts for ${leads.length.toLocaleString()} ${tags.join('/')} leads — ` +
            `${withSite.toLocaleString()} have a website to scrape for email.`,
        });

        if (verifyEmails) {
          send({
            type: 'log',
            message: emailVerifierConfigured()
              ? 'Email verification on — MillionVerifier for anything that clears the free checks.'
              : 'Email verification on — syntax and MX only. Set MILLIONVERIFIER_KEY for the mailbox-level check.',
          });
        }

        const stats = {
          named: 0, phones: 0, emails: 0, sendable: 0, linkedin: 0, scraped: 0,
          ownerFound: 0, ownerDisagreements: 0,
          verdicts: { ok: 0, mx_ok: 0, catch_all: 0, unknown: 0, invalid: 0, disposable: 0 } as Record<VerifyStatus, number>,
        };
        let processed = 0;

        await mapWithConcurrency(leads, concurrency, async (lead) => {
          // --- Source 1: NPPES authorized official ------------------------
          const name = lead.authorizedOfficialName ? titleCase(lead.authorizedOfficialName) : null;
          const title = lead.authorizedOfficialTitle ? titleCase(lead.authorizedOfficialTitle) : null;
          const phone = lead.authorizedOfficialPhone || lead.phone || null;

          if (name) stats.named++;
          if (phone) stats.phones++;

          // --- Source 2: the practice website -----------------------------
          let email: EmailCandidate | null = null;
          let linkedIn: string | null = null;
          // A name the site itself states as owner/founder — read off pages
          // already fetched for email, so it costs nothing extra. Compared
          // against NPPES below rather than trusted outright: NPPES stays the
          // field of record, this is only ever a flag to go look.
          let webOwner: { name: string; source: string } | null = null;

          if (scrapeWebsites && lead.website_found) {
            const siteDomain = safeHostname(lead.website_found);
            const pages: string[] = [];

            const home = await fetchPage(lead.website_found);
            if (home) {
              stats.scraped++;
              pages.push(home);
              for (const link of contactPageLinks(home, lead.website_found)) {
                const page = await fetchPage(link);
                if (page) pages.push(page);
              }
            }

            for (let i = 0; i < pages.length; i++) {
              const page = pages[i];
              if (!linkedIn) linkedIn = extractLinkedIn(page);
              if (!webOwner) {
                const signal = detectOwnerName(page);
                if (signal) webOwner = { name: signal.name, source: i === 0 ? 'homepage' : 'contact page' };
              }
              const candidates = extractEmails(page, siteDomain, name);
              const best = candidates[0];
              if (best && (!email || best.confidence > email.confidence)) email = best;
            }
          }

          // Only worth writing when it actually disagrees with NPPES — the
          // common case is the site naming the exact same person with a
          // credential or title attached, which is not a disagreement.
          const ownerDiffers = webOwner && !(name && nameLikelyMatches(name, webOwner.name));
          if (webOwner) stats.ownerFound++;
          if (ownerDiffers) stats.ownerDisagreements++;

          const acceptedEmail = email && email.confidence >= minEmailConfidence ? email : null;
          if (acceptedEmail) stats.emails++;
          if (linkedIn) stats.linkedin++;

          // --- Source 3: verification ------------------------------------
          let verdict: EmailVerdict | null = null;
          if (acceptedEmail && verifyEmails) {
            verdict = await verifyEmail(acceptedEmail.email);
            stats.verdicts[verdict.status]++;
          }

          // A rejected address is kept on the record rather than discarded — it
          // is evidence of what the site actually published, and Step 5 filters
          // on the status instead of on the field being empty.
          const sendable = Boolean(acceptedEmail) && isSendable(verdict?.status, allowRiskyEmails);
          if (sendable) stats.sendable++;

          const data = {
            decisionMakerName: name,
            decisionMakerTitle: title,
            decisionMakerPhone: phone,
            decisionMakerEmail: acceptedEmail?.email ?? null,
            decisionMakerLinkedIn: linkedIn,
            emailSource: acceptedEmail ? 'website' : null,
            emailConfidence: email?.confidence ?? null,
            emailVerifyStatus: verdict?.status ?? null,
            emailVerifiedAt: verdict ? new Date() : null,
            contactCheckedAt: new Date(),
          };

          await prisma.contact.upsert({
            where: { leadId: lead.id },
            create: { leadId: lead.id, ...data },
            update: data,
          });

          // Lives on the Lead, not the Contact — this is a claim about who owns
          // the business, the same kind of fact NPPES's Authorized Official is,
          // not a piece of the scraped contact record.
          if (webOwner) {
            await prisma.lead.update({
              where: { id: lead.id },
              data: { webOwnerName: webOwner.name, webOwnerNameSource: webOwner.source },
            });
          }

          // A re-check can drop an address that a later filter rejected. Anything
          // queued on the strength of it was never actually mailed, so release it
          // rather than leaving a dead row blocking a future send. Rows already
          // marked Sent are left alone — those really did go out.
          if (!sendable) {
            await prisma.outreach.updateMany({
              where: { leadId: lead.id, emailStatus: 'Queued' },
              data: { emailStatus: 'Not sent', emailCampaign: null, exportedAt: null },
            });
          }

          processed++;
          if (processed % 10 === 0 || processed === leads.length) {
            send({
              type: 'progress',
              processed,
              total: leads.length,
              percent: (processed / leads.length) * 100,
              emails: stats.emails,
              sendable: stats.sendable,
            });
          }

          return sendable ? acceptedEmail : null;
        });

        send({
          type: 'log',
          message:
            `Named contacts ${stats.named.toLocaleString()} | phones ${stats.phones.toLocaleString()} | ` +
            `emails ${stats.emails.toLocaleString()} | LinkedIn ${stats.linkedin.toLocaleString()} ` +
            `(scraped ${stats.scraped} sites)`,
        });

        if (stats.ownerFound > 0) {
          send({
            type: 'log',
            message:
              `Owner name on the site — ${stats.ownerFound} found, ${stats.ownerDisagreements} of them ` +
              `naming someone other than the NPPES Authorized Official (kept on the lead as` +
              ` webOwnerName — not merged in, worth a human look).`,
          });
        }

        if (verifyEmails && stats.emails > 0) {
          const v = stats.verdicts;
          send({
            type: 'log',
            message:
              `Verified — ok ${v.ok} | mx-only ${v.mx_ok} | catch-all ${v.catch_all} | ` +
              `unknown ${v.unknown} | invalid ${v.invalid} | disposable ${v.disposable}`,
          });
          const rejected = stats.emails - stats.sendable;
          if (rejected > 0) {
            send({
              type: 'log',
              message:
                `${rejected.toLocaleString()} address${rejected === 1 ? '' : 'es'} held back from Step 5` +
                `${allowRiskyEmails ? '' : ' (catch-all and unknown are excluded — tick "allow risky" to include them)'}.`,
            });
          }
        }

        // Filtered by when it was checked, not by an `id IN (...)` list — that
        // list is every lead this run touched, and at full multi-state scale
        // (thousands of ids) SQLite's per-query parameter limit rejects it
        // outright once a NOT/negation filter (decisionMakerEmail: not null)
        // is in the same query, since Prisma cannot split that combination
        // across batches. Caught at 2,996 HOT leads across 5 states; this is
        // only ever a handful of sample rows for the log, so it does not need
        // the id list at all.
        const samples = await prisma.contact.findMany({
          where: { contactCheckedAt: { gte: new Date(startedAt) }, decisionMakerEmail: { not: null } },
          orderBy: { emailConfidence: 'desc' },
          take: 6,
          select: {
            decisionMakerName: true, decisionMakerTitle: true,
            decisionMakerEmail: true, emailConfidence: true,
            lead: { select: { organization: true } },
          },
        });
        for (const c of samples) {
          send({
            type: 'log',
            message:
              `  ${c.emailConfidence}% ${c.decisionMakerEmail} — ${c.decisionMakerName ?? '?'}` +
              `${c.decisionMakerTitle ? ` (${c.decisionMakerTitle})` : ''}, ${c.lead.organization}`,
          });
        }

        send({
          type: 'done',
          processed,
          stats,
          elapsedMs: Date.now() - startedAt,
          message:
            `Built ${processed.toLocaleString()} contacts in ${((Date.now() - startedAt) / 1000).toFixed(0)}s — ` +
            `${stats.sendable.toLocaleString()} sendable email${stats.sendable === 1 ? '' : 's'}, ` +
            `${stats.phones.toLocaleString()} with a phone.`,
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

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}
