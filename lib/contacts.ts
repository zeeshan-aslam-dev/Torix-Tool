/**
 * Step 4 — finding a contact for each lead, without paying for an enrichment API.
 *
 * Two free sources:
 *   1. NPPES Authorized Official — a real name, title and phone, present on every
 *      organization record. No email, but it is the person who can sign.
 *   2. The practice's own website — mailto links and addresses on the contact page.
 *
 * Emails are ranked, not just collected: one whose local part matches the decision
 * maker beats a generic office@ address, which in turn beats a careers@ inbox.
 */

export type EmailCandidate = {
  email: string;
  confidence: number;
  why: string;
};

/** Local parts that are never worth emailing a sales pitch to. */
const REJECT_LOCAL = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'postmaster', 'abuse',
  'webmaster', 'hostmaster', 'privacy', 'legal', 'dmca', 'unsubscribe',
  'careers', 'jobs', 'recruiting', 'hr', 'resume', 'spam', 'security',
  // wrong-department inboxes: a sales pitch here goes straight to the bin
  'humanresources', 'human-resources', 'human.resources', 'employment',
  'apply', 'applications', 'volunteer', 'internship', 'students',
];

/**
 * Placeholder addresses printed on a page as an example of the house format.
 * They look perfectly valid and will bounce, so they have to go before export.
 */
const PLACEHOLDER_LOCAL = new Set([
  'firstname.lastname', 'firstname_lastname', 'firstnamelastname',
  'first.last', 'first_last', 'firstlast', 'fname.lname', 'f.last',
  'name', 'yourname', 'your.name', 'youremail', 'your.email', 'email',
  'username', 'user', 'someone', 'somebody', 'anyone', 'test', 'testing',
  'john.doe', 'johndoe', 'jane.doe', 'janedoe', 'sample',
]);

/** Domains that show up in page source but belong to tooling, not the practice. */
const REJECT_DOMAINS = [
  'example.com', 'example.org', 'domain.com', 'email.com', 'yourdomain.com',
  'sentry.io', 'wixpress.com', 'wix.com', 'squarespace.com', 'godaddy.com',
  'shopify.com', 'cloudflare.com', 'w3.org', 'schema.org', 'googlemail.com',
  'sentry-next.wixpress.com', 'jquery.com', 'fontawesome.com',
];

/** Generic mailboxes that are still perfectly fine to contact. */
const ROLE_LOCAL = [
  'info', 'contact', 'office', 'frontdesk', 'front-desk', 'reception', 'hello',
  'admin', 'staff', 'appointments', 'scheduling', 'billing', 'inquiries', 'care',
];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function isJunkEmail(email: string): boolean {
  const [local, domain] = email.toLowerCase().split('@');
  if (!local || !domain) return true;
  if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ico)$/.test(domain)) return true;
  if (/^[0-9a-f]{16,}$/.test(local)) return true; // tracking hashes
  if (local.length > 64 || domain.length > 100) return true;
  if (REJECT_LOCAL.some((r) => local === r || local.startsWith(r + '.'))) return true;
  if (PLACEHOLDER_LOCAL.has(local)) return true;
  if (REJECT_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return true;
  return false;
}

/**
 * Pulls every plausible email out of a page and scores it against the lead.
 * `siteDomain` is the practice's own domain — addresses on it are far more likely
 * to be real than a stray gmail in a testimonial.
 */
export function extractEmails(
  html: string,
  siteDomain: string,
  decisionMakerName?: string | null
): EmailCandidate[] {
  const found = new Map<string, EmailCandidate>();

  /**
   * Decodes URL-escaping and re-extracts the email shape from the result.
   *
   * A source-authored "mailto: office@..." (space after the colon) commonly
   * reaches us HTML-encoded as "mailto:%20office@...". `%` is also a legal
   * RFC 5322 local-part character, so a plain scan of the page text accepts
   * "%20office@theeyepros.com" as a valid address just as readily as the
   * mailto capture does — both sources need the same decode-and-reconfirm
   * pass, or the two disagree on the same address and both versions survive.
   */
  const normalizeCandidate = (text: string): string | null => {
    let value = text;
    try {
      value = decodeURIComponent(value);
    } catch {
      // A malformed % escape should not break extraction — fall back to the raw text.
    }
    const match = value.match(EMAIL_RE);
    return match ? match[0].toLowerCase() : null;
  };

  // mailto links are the strongest signal — someone deliberately published them
  const mailtos = new Set<string>();
  Array.from(html.matchAll(/mailto:([^"'?>\s]+)/gi)).forEach((m) => {
    const email = normalizeCandidate(m[1]);
    if (email) mailtos.add(email);
  });

  const raw = new Set<string>([
    ...Array.from(mailtos),
    ...Array.from(html.matchAll(EMAIL_RE))
      .map((m) => normalizeCandidate(m[0]))
      .filter((e): e is string => e !== null),
  ]);

  const nameParts = (decisionMakerName ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length > 2);

  for (const candidate of Array.from(raw)) {
    const email = candidate.replace(/[.,;:)]+$/, '');
    if (isJunkEmail(email)) continue;

    const [local, domain] = email.split('@');
    let confidence = 20;
    const why: string[] = [];

    if (domain === siteDomain || domain.endsWith('.' + siteDomain)) {
      confidence += 40;
      why.push('own domain');
    } else {
      confidence -= 10;
      why.push('off-domain');
    }

    if (mailtos.has(email)) {
      confidence += 20;
      why.push('mailto link');
    }

    if (nameParts.length && nameParts.some((p) => local.includes(p))) {
      // Reaching the named decision maker is the whole point, so this has to
      // outrank a generic office inbox even when that inbox is a mailto link.
      confidence += 45;
      why.push('matches decision maker');
    } else if (ROLE_LOCAL.some((r) => local === r || local.startsWith(r))) {
      confidence += 15;
      why.push('role mailbox');
    }

    const scored = {
      email,
      confidence: Math.max(0, Math.min(100, confidence)),
      why: why.join(', '),
    };
    const existing = found.get(email);
    if (!existing || scored.confidence > existing.confidence) found.set(email, scored);
  }

  return Array.from(found.values()).sort((a, b) => b.confidence - a.confidence);
}

/** Company or personal LinkedIn URLs published on the site. */
export function extractLinkedIn(html: string): string | null {
  const m = html.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9._%-]+/i);
  return m ? m[0] : null;
}

/** Words that usually mark a page carrying contact details. */
const CONTACT_HINTS = ['contact', 'about', 'staff', 'team', 'our-team', 'providers', 'location'];

/**
 * Picks a handful of internal links most likely to hold an email address.
 * Deliberately small — this is a lead-research lookup, not a crawl.
 */
export function contactPageLinks(html: string, baseUrl: string, max = 3): string[] {
  const base = new URL(baseUrl);
  const out: string[] = [];
  const seen = new Set<string>([base.href]);

  for (const m of Array.from(html.matchAll(/href=["']([^"'#]+)["']/gi))) {
    const href = m[1].trim();
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;

    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.hostname !== base.hostname) continue;
    if (!/\.(html?|php|aspx?)$|\/$|^[^.]*$/.test(url.pathname)) continue;

    const path = url.pathname.toLowerCase();
    if (!CONTACT_HINTS.some((h) => path.includes(h))) continue;

    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push(url.href);
    if (out.length >= max) break;
  }

  return out;
}

/** Fetches one page, returning null rather than throwing on any failure. */
export async function fetchPage(url: string, timeoutMs = 10000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TorixLeadResearch/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html')) return null;
    return (await res.text()).slice(0, 300_000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Title-cases the SHOUTED names NPPES stores. */
export function titleCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Ii|Iii|Iv|Md|Do|Dds|Dc|Od|Pa|Np|Rn|Ceo|Cfo|Coo)\b/g, (s) => s.toUpperCase());
}
