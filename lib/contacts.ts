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

import { csvCell } from './instantly';
import { normalizeOrgName } from './nppes';

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

/**
 * One row of Step 4's own CSV export — every lead this run touched, not just
 * the ones that came out sendable. Useful for a human to review what Step 4
 * actually found (including rejected/unverified addresses) without waiting
 * on Step 5's stricter filtering.
 */
export type ContactExportRow = {
  organization: string;
  /** NPPES National Provider Identifier for this practice location. */
  npi: string | null;
  /** NUCC taxonomy code from NPPES (e.g. 207Q00000X). */
  taxonomy: string | null;
  address: string | null;
  city: string;
  state: string;
  zip: string;
  /** Distinct practice locations known for this org (from Step 1). */
  nLocations: number;
  /** NPPES providers sharing this org + address (from Step 1). */
  nProviders: number;
  practicePhone: string | null;
  decisionMakerName: string | null;
  decisionMakerTitle: string | null;
  decisionMakerPhone: string | null;
  email: string | null;
  emailConfidence: number | null;
  emailVerifyStatus: string | null;
  sendable: boolean;
  website: string | null;
  linkedin: string | null;
  webOwnerName: string | null;
  score: number;
  tag: string | null;
  enumerationDate?: Date | string | null;
  timezone?: string | null;
  /** Filled by finalizeContactsCsvRows — how many branches this org kept. */
  branchCount?: number;
};

/** Orgs with more locations than this are treated as chains and dropped from the CSV. */
export const CONTACTS_CSV_MAX_BRANCHES = 2;
/** Sites with more NPPES providers than this are dropped from the CSV. */
export const CONTACTS_CSV_MAX_PROVIDERS = 15;

/** Dialer-facing columns — always first, in this exact order. */
export const DIALER_FRONT_COLUMNS = [
  'NPI',
  'Practice_Name',
  'Authorized_Person',
  'Authorized_Title',
  'Phone',
  'Address',
  'City',
  'State',
  'ZIP',
  'taxonomy',
  'Enumeration_Date',
  'Time_Zone',
  'PKT_Call_Window',
] as const;

/** Extra columns appended after the dialer block. */
export const DIALER_TRAILING_COLUMNS = [
  'Providers',
  'Branches',
  'Tag',
  'Score',
  'Email',
  'Email Confidence',
  'Email Verify Status',
  'Sendable',
  'Website',
  'LinkedIn',
  'Site-Stated Owner (if different from NPPES)',
] as const;

/** Last 10 digits of a US phone, or '' if too short to compare. */
export function digitsPhone(phone: string | null | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

export function phonesAreSame(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = digitsPhone(a);
  const db = digitsPhone(b);
  return da.length >= 10 && da === db;
}

/**
 * Step 4 CSV shaping:
 * 1. Drop rows where practice phone and decision-maker phone are the same number.
 * 2. Keep only orgs with 1–2 branches (max 2); drop larger chains.
 * 3. Keep only sites with ≤15 NPPES providers at the location.
 * 4. One row per org — the highest-scoring location as the main office.
 * 5. Stamp branchCount for the CSV column.
 */
export function finalizeContactsCsvRows(rows: ContactExportRow[]): ContactExportRow[] {
  const withDistinctPhones = rows.filter((r) => {
    if (!r.practicePhone || !r.decisionMakerPhone) return false;
    return !phonesAreSame(r.practicePhone, r.decisionMakerPhone);
  });

  const byOrg = new Map<string, ContactExportRow[]>();
  for (const row of withDistinctPhones) {
    if ((row.nProviders ?? 0) > CONTACTS_CSV_MAX_PROVIDERS) continue;
    const key = normalizeOrgName(row.organization);
    const list = byOrg.get(key);
    if (list) list.push(row);
    else byOrg.set(key, [row]);
  }

  const out: ContactExportRow[] = [];
  for (const group of Array.from(byOrg.values())) {
    const fromFile = new Set(
      group.map((r) => `${(r.city || '').toUpperCase()}|${r.zip || ''}|${(r.state || '').toUpperCase()}`)
    ).size;
    const branchCount = Math.max(
      fromFile,
      ...group.map((r) => r.nLocations || 0),
      1
    );
    if (branchCount > CONTACTS_CSV_MAX_BRANCHES) continue;

    const main = group.reduce((best, row) => {
      if (row.score !== best.score) return row.score > best.score ? row : best;
      const a = `${best.city}|${best.zip}`;
      const b = `${row.city}|${row.zip}`;
      return b < a ? row : best;
    });

    out.push({ ...main, branchCount });
  }

  out.sort((a, b) => b.score - a.score || a.organization.localeCompare(b.organization));
  return out;
}

function formatEnumerationDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toISOString().slice(0, 10);
}

const CONTACTS_CSV_COLUMNS: { header: string; get: (r: ContactExportRow) => string }[] = [
  { header: 'NPI', get: (r) => r.npi ?? '' },
  { header: 'Practice_Name', get: (r) => r.organization },
  { header: 'Authorized_Person', get: (r) => r.decisionMakerName ?? '' },
  { header: 'Authorized_Title', get: (r) => normalizeDecisionMakerTitle(r.decisionMakerTitle) },
  { header: 'Phone', get: (r) => r.practicePhone ?? '' },
  { header: 'Address', get: (r) => r.address ?? '' },
  { header: 'City', get: (r) => r.city },
  { header: 'State', get: (r) => r.state },
  { header: 'ZIP', get: (r) => r.zip },
  { header: 'taxonomy', get: (r) => formatTaxonomyCell(r.taxonomy) },
  { header: 'Enumeration_Date', get: (r) => formatEnumerationDate(r.enumerationDate) },
  { header: 'Time_Zone', get: (r) => r.timezone ?? '' },
  { header: 'PKT_Call_Window', get: (r) => pktCallWindow(r.timezone) },
  { header: 'Providers', get: (r) => String(r.nProviders ?? '') },
  { header: 'Branches', get: (r) => String(r.branchCount ?? r.nLocations ?? '') },
  { header: 'Tag', get: (r) => r.tag ?? '' },
  { header: 'Score', get: (r) => String(r.score) },
  { header: 'Email', get: (r) => r.email ?? '' },
  { header: 'Email Confidence', get: (r) => (r.emailConfidence == null ? '' : String(r.emailConfidence)) },
  { header: 'Email Verify Status', get: (r) => r.emailVerifyStatus ?? '' },
  { header: 'Sendable', get: (r) => (r.sendable ? 'Yes' : 'No') },
  { header: 'Website', get: (r) => r.website ?? '' },
  { header: 'LinkedIn', get: (r) => r.linkedin ?? '' },
  { header: 'Site-Stated Owner (if different from NPPES)', get: (r) => r.webOwnerName ?? '' },
];

/** Preferred column order for Step 4 exports and the upload/edit-CSV path. */
export const PREFERRED_CSV_COLUMN_ORDER = CONTACTS_CSV_COLUMNS.map((c) => c.header);

export function normalizeDecisionMakerTitle(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (!text) return '';

  const upper = text.toUpperCase().replace(/\s+/g, ' ');
  const hasCeo = /\bCEO\b/.test(upper) || upper.includes('CHIEF EXECUTIVE');
  const hasPresident = /\bPRESIDENT\b/.test(upper);
  const hasOwner = /\bOWNER\b/.test(upper) || /\bPROPRIETOR\b/.test(upper);
  const hasMedDir = upper.includes('MEDICAL DIRECTOR');

  if (hasCeo && hasPresident) {
    const extras: string[] = [];
    if (hasOwner) extras.push('Owner');
    if (hasMedDir) extras.push('Medical Director');
    return extras.length ? `CEO/President/${extras.join('/')}` : 'CEO/President';
  }

  if (hasCeo && !hasPresident) {
    if (/^CHIEF EXECUTIVE OFFICER$/i.test(text.trim())) return 'CEO';
  }

  return text;
}

export function taxonomySpecialtyLabel(code: string | null | undefined): string {
  const tax = (code ?? '').trim().toUpperCase();
  if (!tax) return '';

  const PREFIX_LABELS: Array<[string, string]> = [
    ['1223G', 'General Dentistry'],
    ['1223', 'Dentist'],
    ['207Q', 'Family Medicine'],
    ['207R', 'Internal Medicine'],
    ['207V', 'Obstetrics & Gynecology'],
    ['207X', 'Orthopaedic Surgery'],
    ['2080', 'Pediatrics'],
    ['2084', 'Psychiatry & Neurology'],
    ['208D', 'General Practice'],
    ['213E', 'Podiatrist'],
    ['152W', 'Optometrist'],
    ['111N', 'Chiropractor'],
    ['363L', 'Nurse Practitioner'],
    ['363A', 'Physician Assistant'],
  ];

  for (const [prefix, label] of PREFIX_LABELS) {
    if (tax.startsWith(prefix)) return label;
  }
  return '';
}

/** Single `taxonomy` cell: "Family Medicine (207Q00000X)" when both exist. */
export function formatTaxonomyCell(code: string | null | undefined): string {
  const tax = (code ?? '').trim();
  if (!tax) return '';
  const label = taxonomySpecialtyLabel(tax);
  if (label) return `${label} (${tax.toUpperCase()})`;
  return tax.toUpperCase();
}

/** Pakistan call window derived from the US practice time zone. */
export function pktCallWindow(timezone: string | null | undefined): string {
  const tz = (timezone ?? '').trim().toLowerCase();
  if (!tz) return '';
  if (tz.includes('eastern')) return '6:00 PM – 10:00 PM PKT';
  if (tz.includes('central')) return '7:00 PM – 11:00 PM PKT';
  if (tz.includes('mountain')) return '8:00 PM – 12:00 AM PKT';
  if (tz.includes('pacific')) return '9:00 PM – 1:00 AM PKT';
  if (tz.includes('alaska')) return '10:00 PM – 2:00 AM PKT';
  if (tz.includes('hawaii')) return '12:00 AM – 4:00 AM PKT';
  if (tz.includes('atlantic')) return '5:00 PM – 9:00 PM PKT';
  return '';
}

/** Normalise a person name for merge keys (case / punctuation). */
export function normalizePersonKey(name: string | null | undefined): string {
  return (name ?? '')
    .toUpperCase()
    .replace(/[.']/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildContactsCsv(rows: ContactExportRow[]): string {
  const finalized = finalizeContactsCsvRows(rows);
  const header = CONTACTS_CSV_COLUMNS.map((c) => csvCell(c.header)).join(',');
  const body = finalized.map((row) => CONTACTS_CSV_COLUMNS.map((c) => csvCell(c.get(row))).join(','));
  return [header, ...body].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Upload-and-filter an existing contacts CSV
// ---------------------------------------------------------------------------

/** One parsed CSV row as header → cell. */
export type CsvRecord = Record<string, string>;

export type PracticeSize = {
  npi: string | null;
  branches: number;
  providers: number;
  taxonomy?: string | null;
  decisionMakerTitle?: string | null;
  decisionMakerName?: string | null;
  address?: string | null;
  zip?: string | null;
  enumerationDate?: string | null;
  timezone?: string | null;
  website?: string | null;
  gbpWebsite?: string | null;
};

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseContactsCsvText(text: string): { headers: string[]; rows: CsvRecord[] } {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows: CsvRecord[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row: CsvRecord = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = (cells[i] ?? '').trim();
    }
    rows.push(row);
  }
  return { headers, rows };
}

export function cell(row: CsvRecord, ...names: string[]): string {
  for (const name of names) {
    const exact = row[name];
    if (exact != null && exact !== '') return exact;
  }
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const v = lower[name.toLowerCase()];
    if (v != null && v !== '') return v;
  }
  return '';
}

function parsePositiveInt(raw: string): number | null {
  const n = Number(String(raw).replace(/,/g, '').trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export function sizeFromCsvRow(row: CsvRecord): Partial<PracticeSize> {
  const npi = cell(row, 'NPI', 'NPPES Number', 'NPPES', 'npi') || null;
  const branches = parsePositiveInt(cell(row, 'Branches', 'Branch Count', 'Locations', 'n_locations_detected'));
  const providers = parsePositiveInt(cell(row, 'Providers', 'Provider Count', 'n_providers_at_location'));
  const taxonomyRaw = cell(row, 'taxonomy', 'Taxonomy', 'Taxonomy Code');
  const taxonomyMatch = taxonomyRaw.match(/\(([A-Z0-9]+)\)\s*$/i);
  const taxonomy = taxonomyMatch ? taxonomyMatch[1].toUpperCase() : (taxonomyRaw || null);
  return {
    npi: npi || null,
    ...(branches != null ? { branches } : {}),
    ...(providers != null ? { providers } : {}),
    ...(taxonomy ? { taxonomy } : {}),
  };
}

export function csvRowMatchKey(row: CsvRecord): {
  npi: string | null;
  orgKey: string;
  personKey: string;
  city: string;
  state: string;
  zip: string;
} {
  const npi = cell(row, 'NPI', 'NPPES Number', 'NPPES', 'npi') || null;
  const org = cell(row, 'Practice_Name', 'Organization', 'Company Name', 'Company');
  const person = cell(row, 'Authorized_Person', 'Decision Maker Name');
  return {
    npi: npi && /^\d{10}$/.test(npi) ? npi : npi || null,
    orgKey: normalizeOrgName(org),
    personKey: normalizePersonKey(person),
    city: cell(row, 'City').toUpperCase(),
    state: cell(row, 'State').toUpperCase(),
    zip: cell(row, 'ZIP', 'Zip', 'Postal Code').slice(0, 5),
  };
}

export function reorderCsvHeaders(existing: string[]): string[] {
  const byLower = new Map(existing.map((h) => [h.toLowerCase(), h]));
  const out: string[] = [];
  const used = new Set<string>();

  for (const name of PREFERRED_CSV_COLUMN_ORDER) {
    out.push(name);
    const prior = byLower.get(name.toLowerCase());
    used.add((prior ?? name).toLowerCase());
  }

  // Drop superseded legacy headers so they are not duplicated at the end.
  const skipLegacy = new Set([
    'organization', 'company name', 'company', 'decision maker name',
    'decision maker title', 'practice phone', 'specialty', 'taxonomy code',
    'nppes', 'nppes number', 'zip code', 'postal code',
  ]);

  for (const h of existing) {
    const lower = h.toLowerCase();
    if (used.has(lower) || skipLegacy.has(lower)) continue;
    out.push(h);
    used.add(lower);
  }
  return out;
}

function joinUnique(parts: string[], sep = ' / '): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const key = t.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.join(sep);
}

function scoreOf(row: CsvRecord): number {
  const n = Number(cell(row, 'Score') || '0');
  return Number.isFinite(n) ? n : 0;
}

/**
 * Merge same-org / different-owner rows and same-owner / different-org rows.
 */
export function mergeDialerCsvRows(rows: CsvRecord[]): CsvRecord[] {
  // Pass 1 — same organization, combine owners.
  const byOrg = new Map<string, CsvRecord[]>();
  for (const row of rows) {
    const key = csvRowMatchKey(row).orgKey || `__row_${byOrg.size}`;
    const list = byOrg.get(key);
    if (list) list.push(row);
    else byOrg.set(key, [row]);
  }

  const afterOrg: CsvRecord[] = [];
  for (const group of Array.from(byOrg.values())) {
    if (group.length === 1) {
      afterOrg.push(group[0]);
      continue;
    }
    const primary = group.reduce((best, row) => (scoreOf(row) > scoreOf(best) ? row : best));
    const people = group.map((r) => cell(r, 'Authorized_Person', 'Decision Maker Name'));
    const titles = group.map((r) =>
      normalizeDecisionMakerTitle(cell(r, 'Authorized_Title', 'Decision Maker Title'))
    );
    afterOrg.push({
      ...primary,
      Authorized_Person: joinUnique(people),
      Authorized_Title: joinUnique(titles),
      Practice_Name:
        cell(primary, 'Practice_Name', 'Organization') || primary['Practice_Name'] || '',
    });
  }

  // Pass 2 — same owner, combine organizations.
  const byPerson = new Map<string, CsvRecord[]>();
  const noPerson: CsvRecord[] = [];
  for (const row of afterOrg) {
    const person = normalizePersonKey(cell(row, 'Authorized_Person', 'Decision Maker Name'));
    if (!person) {
      noPerson.push(row);
      continue;
    }
    const list = byPerson.get(person);
    if (list) list.push(row);
    else byPerson.set(person, [row]);
  }

  const out: CsvRecord[] = [...noPerson];
  for (const group of Array.from(byPerson.values())) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const primary = group.reduce((best, row) => (scoreOf(row) > scoreOf(best) ? row : best));
    const orgs = group.map((r) => cell(r, 'Practice_Name', 'Organization'));
    const phones = group.map((r) => cell(r, 'Phone', 'Practice Phone'));
    out.push({
      ...primary,
      Practice_Name: joinUnique(orgs),
      Phone: joinUnique(phones.filter((p) => p)),
    });
  }

  return out;
}

/**
 * Filters an uploaded contacts CSV to practices within the size caps, merges
 * duplicate org/owner rows, and rewrites dialer column order with NPPES enrichment.
 */
export function filterUploadedContactsCsv(
  csvText: string,
  resolveSize: (row: CsvRecord) => PracticeSize | null,
  opts: { maxBranches?: number; maxProviders?: number } = {}
): {
  csv: string;
  kept: number;
  droppedOversize: number;
  unmatched: number;
  total: number;
  rows: CsvRecord[];
} {
  const maxBranches = opts.maxBranches ?? CONTACTS_CSV_MAX_BRANCHES;
  const maxProviders = opts.maxProviders ?? CONTACTS_CSV_MAX_PROVIDERS;
  const { headers: rawHeaders, rows } = parseContactsCsvText(csvText);

  if (!rawHeaders.length) {
    return { csv: '', kept: 0, droppedOversize: 0, unmatched: 0, total: 0, rows: [] };
  }

  const keptRows: CsvRecord[] = [];
  let droppedOversize = 0;
  let unmatched = 0;

  for (const row of rows) {
    const fromCsv = sizeFromCsvRow(row);
    const fromDb = resolveSize(row);
    const branches = fromDb?.branches ?? fromCsv.branches;
    const providers = fromDb?.providers ?? fromCsv.providers;
    const npi = fromDb?.npi ?? fromCsv.npi ?? '';
    const taxonomyCode = fromDb?.taxonomy ?? fromCsv.taxonomy ?? '';

    if (branches == null || providers == null) {
      unmatched++;
      continue;
    }
    if (branches > maxBranches || providers > maxProviders) {
      droppedOversize++;
      continue;
    }

    const next: CsvRecord = {};
    for (const h of rawHeaders) next[h] = row[h] ?? '';

    const practiceName =
      cell(row, 'Practice_Name', 'Organization', 'Company Name', 'Company') || '';
    const person =
      cell(row, 'Authorized_Person', 'Decision Maker Name') ||
      fromDb?.decisionMakerName ||
      '';
    const titleRaw =
      cell(row, 'Authorized_Title', 'Decision Maker Title') ||
      fromDb?.decisionMakerTitle ||
      '';
    const timezone =
      fromDb?.timezone ||
      cell(row, 'Time_Zone', 'Time Zone', 'Timezone') ||
      '';

    next['NPI'] = npi || cell(row, 'NPI', 'NPPES Number', 'NPPES', 'npi');
    next['Practice_Name'] = practiceName;
    next['Authorized_Person'] = person;
    next['Authorized_Title'] = normalizeDecisionMakerTitle(titleRaw);
    next['Phone'] = cell(row, 'Phone', 'Practice Phone') || '';
    next['Address'] = fromDb?.address || cell(row, 'Address') || '';
    next['City'] = cell(row, 'City') || '';
    next['State'] = cell(row, 'State') || '';
    next['ZIP'] = fromDb?.zip || cell(row, 'ZIP', 'Zip', 'Postal Code') || '';
    next['taxonomy'] = formatTaxonomyCell(taxonomyCode) || cell(row, 'taxonomy', 'Taxonomy', 'Specialty');
    next['Enumeration_Date'] =
      fromDb?.enumerationDate ||
      cell(row, 'Enumeration_Date', 'Enumeration Date') ||
      '';
    next['Time_Zone'] = timezone;
    next['PKT_Call_Window'] = pktCallWindow(timezone);

    next['Providers'] = String(providers);
    next['Branches'] = String(branches);
    if (!next['Tag']) next['Tag'] = cell(row, 'Tag');
    if (!next['Score']) next['Score'] = cell(row, 'Score');
    if (!next['Email']) next['Email'] = cell(row, 'Email');
    if (!next['Website']) next['Website'] = fromDb?.website || cell(row, 'Website');
    if (!next['LinkedIn']) next['LinkedIn'] = cell(row, 'LinkedIn');
    if (fromDb?.gbpWebsite && !next['Website']) next['Website'] = fromDb.gbpWebsite;

    keptRows.push(next);
  }

  const merged = mergeDialerCsvRows(keptRows);
  const headers = reorderCsvHeaders([
    ...rawHeaders,
    ...PREFERRED_CSV_COLUMN_ORDER,
  ]);

  const headerLine = headers.map((h) => csvCell(h)).join(',');
  const body = merged.map((row) => headers.map((h) => csvCell(row[h] ?? '')).join(','));
  const csv = [headerLine, ...body].join('\r\n') + '\r\n';

  return {
    csv,
    kept: merged.length,
    droppedOversize,
    unmatched,
    total: rows.length,
    rows: merged,
  };
}

/** Rebuild CSV text from dialer rows after an optional Gemini pass. */
export function buildDialerCsvFromRecords(rows: CsvRecord[], extraHeaders: string[] = []): string {
  const headers = reorderCsvHeaders([...PREFERRED_CSV_COLUMN_ORDER, ...extraHeaders]);
  const headerLine = headers.map((h) => csvCell(h)).join(',');
  const body = rows.map((row) => headers.map((h) => csvCell(row[h] ?? '')).join(','));
  return [headerLine, ...body].join('\r\n') + '\r\n';
}
