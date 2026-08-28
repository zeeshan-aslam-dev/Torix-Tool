import prisma from '../../../../lib/prisma';
import { mapWithConcurrency } from '../../../../lib/webVerify';
import {
  extractEmails,
  extractLinkedIn,
  contactPageLinks,
  fetchPage,
  titleCase,
  EmailCandidate,
} from '../../../../lib/contacts';

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
};

/**
 * Step 4 — builds a Contact for each lead from free sources only.
 *
 * The NPPES Authorized Official gives a name, title and phone for every
 * organization. Email is not in NPPES at all, so it comes from the practice's own
 * website when Step 3 found one: mailto links and addresses on the contact page.
 */
export async function POST(req: Request) {
  let body: ContactsRequest = {};
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
  const concurrency = Math.max(1, Math.min(Number(body.concurrency) || 5, 20));
  const minEmailConfidence = Number.isFinite(body.minEmailConfidence)
    ? Number(body.minEmailConfidence)
    : 45;
  const scrapeWebsites = body.scrapeWebsites !== false;
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

        const stats = { named: 0, phones: 0, emails: 0, linkedin: 0, scraped: 0 };
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

            for (const page of pages) {
              if (!linkedIn) linkedIn = extractLinkedIn(page);
              const candidates = extractEmails(page, siteDomain, name);
              const best = candidates[0];
              if (best && (!email || best.confidence > email.confidence)) email = best;
            }
          }

          const acceptedEmail = email && email.confidence >= minEmailConfidence ? email : null;
          if (acceptedEmail) stats.emails++;
          if (linkedIn) stats.linkedin++;

          const data = {
            decisionMakerName: name,
            decisionMakerTitle: title,
            decisionMakerPhone: phone,
            decisionMakerEmail: acceptedEmail?.email ?? null,
            decisionMakerLinkedIn: linkedIn,
            emailSource: acceptedEmail ? 'website' : null,
            emailConfidence: email?.confidence ?? null,
            contactCheckedAt: new Date(),
          };

          await prisma.contact.upsert({
            where: { leadId: lead.id },
            create: { leadId: lead.id, ...data },
            update: data,
          });

          // A re-check can drop an address that a later filter rejected. Anything
          // queued on the strength of it was never actually mailed, so release it
          // rather than leaving a dead row blocking a future send. Rows already
          // marked Sent are left alone — those really did go out.
          if (!acceptedEmail) {
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
            });
          }

          return acceptedEmail;
        });

        send({
          type: 'log',
          message:
            `Named contacts ${stats.named.toLocaleString()} | phones ${stats.phones.toLocaleString()} | ` +
            `emails ${stats.emails.toLocaleString()} | LinkedIn ${stats.linkedin.toLocaleString()} ` +
            `(scraped ${stats.scraped} sites)`,
        });

        const samples = await prisma.contact.findMany({
          where: { leadId: { in: leads.map((l) => l.id) }, decisionMakerEmail: { not: null } },
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
            `${stats.emails.toLocaleString()} with an email, ${stats.phones.toLocaleString()} with a phone.`,
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
