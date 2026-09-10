/**
 * Step 3 — finding and confirming a practice's website.
 *
 * NPPES has no website field, so a site has to be found. This module keeps the
 * three sources behind one interface and orders them by cost, cheapest first:
 *
 *   1. endpoint  — domains already in the NPPES endpoint file. Free, instant, but
 *                  only covers ~9% of leads and is mostly EHR vendor noise.
 *   2. guess     — <practicename>.com and friends, confirmed by fetching the page.
 *                  Free apart from the HTTP request; needs parked-domain checks.
 *   3. search    — a real search. Costs money and needs SERPER_KEY or SERPAPI_KEY.
 *   4. gbp       — the Google Business Profile listing. Same cost as a search,
 *                  and the only source that says whether the practice is still
 *                  trading.
 *
 * Whatever is found is only accepted once the page itself confirms the lead:
 * the practice phone, city, street number or name has to appear on it.
 */

import { PlaceHit, phoneDigits } from './search';
import { normalizeOrgName } from './nppes';

export type VerifyTarget = {
  id: number;
  organization: string;
  dbaNames?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  npi?: string | null;
};

export type VerifyResult = {
  website: string | null;
  source: 'endpoint' | 'guess' | 'search' | 'gbp' | null;
  confidence: number;
  snippet: string;
  /** Set when the page or a search snippet says the practice joined a network. */
  acquisition: AcquisitionSignal | null;
};

export type AcquisitionSignal = {
  phrase: string;
  /** The sentence the phrase appeared in, so a human can judge it. */
  context: string;
};

/** Domains that belong to EHR / clearinghouse vendors, not to the practice. */
const VENDOR_DOMAINS = [
  'officeally.io', 'officeally.com', 'eclinicaldirectplus.com', 'direct-address.net',
  'direct-ci.net', 'hcadirect.net', 'surescripts.net', 'updox.com', 'athenahealth.com',
  'nextgen.com', 'allscripts.com', 'medallies.com', 'intelichart.com', 'phimail.com',
  'directnppes.com', 'medicasoft.us', 'maxmd.net', 'secure-health.net', 'iqhealth.com',
  'credentialing.com', 'inteligentmedicalobjects.com',
];

const FREE_MAIL_DOMAINS = [
  'gmail.com', 'hotmail.com', 'yahoo.com', 'aol.com', 'outlook.com', 'icloud.com',
  'live.com', 'msn.com', 'comcast.net', 'me.com',
];

/** Markers that mean the domain resolved but is parked or for sale. */
const PARKED_MARKERS = [
  'hugedomains.com', 'domain_profile.cfm', 'this domain is for sale', 'domain for sale',
  'sedo.com/search', 'afternic.com', 'buy this domain', 'godaddy.com/forsale',
  'parkingcrew', 'domainmarket.com', 'is available for purchase', 'dan.com',
];

const LEGAL_SUFFIXES = new Set([
  'INC', 'INCORPORATED', 'LLC', 'PLLC', 'LLP', 'LP', 'PC', 'PA', 'PSC', 'LTD',
  'LIMITED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'DBA', 'THE', 'OF', 'AND',
]);

/** Strips a Direct-messaging prefix so direct.imail.org resolves to imail.org. */
export function baseDomain(host: string): string {
  let h = host.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  h = h.replace(/^(direct|esmd|edi|secure|mail|smtp|portal)\./, '');
  return h;
}

export function isUsableDomain(host: string): boolean {
  const d = baseDomain(host);
  if (!d.includes('.')) return false;
  if (FREE_MAIL_DOMAINS.includes(d)) return false;
  if (VENDOR_DOMAINS.some((v) => d === v || d.endsWith('.' + v))) return false;
  // "…direct-something.net" style relay hosts
  if (/(^|\.)direct[-.]/.test(d)) return false;
  return true;
}

/** Pulls a hostname out of a URL, an email address or a bare domain. */
export function domainFromEndpoint(endpoint: string): string | null {
  const e = (endpoint || '').trim();
  if (!e) return null;
  let host: string | null = null;

  const url = e.match(/^[a-z]+:\/\/([^/:?#]+)/i);
  if (url) host = url[1];
  else if (e.includes('@')) host = e.split('@').pop() ?? null;
  else if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(e)) host = e;

  if (!host) return null;
  const d = baseDomain(host);
  return isUsableDomain(d) ? d : null;
}

/** Candidate hostnames built from the legal name and any trade names. */
export function domainCandidates(target: VerifyTarget, limit = 6): string[] {
  const names = [target.organization, ...(target.dbaNames ?? '').split('|')]
    .map((n) => (n || '').trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const name of names) {
    const tokens = name
      .toUpperCase()
      .replace(/[.']/g, '')
      .replace(/[^A-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter((t) => t && !LEGAL_SUFFIXES.has(t));

    if (!tokens.length) continue;

    const joined = tokens.join('').toLowerCase();
    const hyphen = tokens.join('-').toLowerCase();

    for (const base of [joined, hyphen]) {
      if (base.length < 4 || base.length > 40) continue;
      out.push(`${base}.com`);
      if (out.length === 1) out.push(`${base}.net`);
    }
  }

  return Array.from(new Set(out)).slice(0, limit);
}

export type FetchOutcome = {
  ok: boolean;
  status?: number;
  finalUrl?: string;
  html?: string;
  error?: string;
};

/**
 * Fetches a homepage, trying https then http, following redirects.
 * A 403 counts as "the site exists but blocks us" rather than a failure.
 */
export async function fetchHomepage(host: string, timeoutMs = 10000): Promise<FetchOutcome> {
  let lastError = 'unreachable';

  for (const scheme of ['https', 'http']) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${scheme}://${host}`, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TorixLeadResearch/1.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });

      if (res.status === 403 || res.status === 401 || res.status === 429) {
        return { ok: false, status: res.status, finalUrl: res.url, error: 'blocked' };
      }
      if (!res.ok) {
        lastError = `http ${res.status}`;
        continue;
      }

      const html = (await res.text()).slice(0, 300_000);
      return { ok: true, status: res.status, finalUrl: res.url, html };
    } catch (e) {
      const err = e as { name?: string; cause?: { code?: string }; message?: string };
      lastError = err.name === 'AbortError' ? 'timeout' : err.cause?.code ?? err.message ?? 'error';
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, error: lastError };
}

const digitsOnly = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/**
 * Decides whether a fetched page actually belongs to this lead, and how sure we are.
 * Anything below the caller's threshold is reported but not saved as the website.
 */
export function scorePageMatch(target: VerifyTarget, outcome: FetchOutcome, host: string): VerifyResult {
  if (!outcome.ok) {
    // A blocked page still tells us the domain is a live site, just unverifiable.
    const confidence = outcome.error === 'blocked' ? 20 : 0;
    return {
      website: null,
      source: null,
      confidence,
      snippet: outcome.error === 'blocked'
        ? `${host} responded ${outcome.status} (bot-blocked) — exists but could not be confirmed`
        : `${host}: ${outcome.error}`,
      acquisition: null,
    };
  }

  const html = outcome.html ?? '';
  const lower = html.toLowerCase();

  const parked = PARKED_MARKERS.find((m) => lower.includes(m))
    ?? (outcome.finalUrl && PARKED_MARKERS.find((m) => outcome.finalUrl!.toLowerCase().includes(m)));
  if (parked) {
    return {
      website: null, source: null, confidence: 0,
      snippet: `${host} is parked or for sale (${parked})`,
      acquisition: null,
    };
  }

  const title = (html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  const pageDigits = lower.replace(/\D/g, '');
  const hits: string[] = [];
  let confidence = 0;

  const phone = digitsOnly(target.phone).slice(-10);
  if (phone.length === 10 && pageDigits.includes(phone)) {
    confidence += 40;
    hits.push('phone');
  }

  if (target.city && lower.includes(target.city.toLowerCase())) {
    confidence += 25;
    hits.push('city');
  }

  const streetNumber = (target.address ?? '').trim().split(/\s+/)[0];
  if (/^\d+$/.test(streetNumber) && lower.includes(streetNumber.toLowerCase())) {
    confidence += 10;
    hits.push('street no');
  }

  if (target.zip && lower.includes(target.zip)) {
    confidence += 10;
    hits.push('zip');
  }

  // Distinctive words from the practice name appearing on the page
  const nameTokens = target.organization
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 3 && !LEGAL_SUFFIXES.has(t));
  const nameHits = nameTokens.filter((t) => lower.includes(t.toLowerCase())).length;
  if (nameTokens.length && nameHits / nameTokens.length >= 0.5) {
    confidence += 20;
    hits.push('name');
  }

  confidence = Math.min(100, confidence);

  return {
    website: outcome.finalUrl ?? `https://${host}`,
    source: null,
    confidence,
    snippet: `${title || host}${hits.length ? ` — matched ${hits.join(', ')}` : ' — no lead details found on page'}`,
    acquisition: detectAcquisition(html),
  };
}

/**
 * Wording a practice uses once it has been absorbed into a larger group.
 *
 * Every phrase here has to be followed by something that reads like an
 * organisation name — a bare "part of" matches testimonials ("part of his
 * family"), marketing copy ("part of good eye care") and cookie banners, which is
 * exactly what an earlier, looser version of this did.
 */
const ACQUISITION_PHRASES = [
  'is now part of',
  'is now a part of',
  'now a part of',
  'has been acquired by',
  'was acquired by',
  'has been purchased by',
  'acquired by',
  'has joined',
  'have joined',
  'is proud to join',
  'proudly part of',
  'is a division of',
  'a division of',
  'is a subsidiary of',
  'a subsidiary of',
  'is an affiliate of',
  'an affiliate of',
  'is affiliated with',
  'affiliated with',
  'is a member of the',
  'is now doing business as',
];

/** Words that make a trailing phrase read as a company rather than a sentiment. */
const ORG_WORDS = [
  'health', 'healthcare', 'medical', 'clinic', 'clinics', 'group', 'partners',
  'associates', 'care', 'system', 'systems', 'network', 'physicians', 'practice',
  'practices', 'vision', 'eye', 'dental', 'chiropractic', 'wellness', 'hospital',
  'center', 'centers', 'centre', 'institute', 'holdings', 'management', 'services',
  'inc', 'llc', 'pllc', 'pc', 'corp', 'company', 'ltd', 'md', 'family',
];

/** Reads like page furniture or script output rather than a sentence about ownership. */
function looksLikeCode(text: string): boolean {
  return /[{}();=]|=>|var|function|wp-content|swiper|slider|\.js|\.css/i.test(text);
}

/**
 * Decides whether what follows the phrase names an organisation.
 *
 * Requires a capitalised run of one to six words carrying at least one corporate
 * or clinical word, which is what separates "is now part of Revere Health" from
 * "we are a part of his family".
 */
function namesAnOrganisation(after: string): string | null {
  const words = after.trim().split(/\s+/).slice(0, 8);
  const taken: string[] = [];

  for (const raw of words) {
    const word = raw.replace(/^[^A-Za-z0-9&]+|[^A-Za-z0-9&.]+$/g, '');
    if (!word) break;
    // Capitalised, an initialism, or a legal suffix keeps the run going.
    const isNameish = /^[A-Z][A-Za-z&.'-]*$/.test(word) || /^[A-Z]{2,}$/.test(word);
    const isJoiner = taken.length > 0 && /^(of|and|the|for|at|de|del)$/i.test(word);
    if (!isNameish && !isJoiner) break;
    taken.push(word);
    if (taken.length >= 6) break;
  }

  while (taken.length && /^(of|and|the|for|at)$/i.test(taken[taken.length - 1])) taken.pop();
  if (taken.length === 0) return null;

  const phrase = taken.join(' ');
  const lower = phrase.toLowerCase();

  // A single capitalised word is only convincing when it is itself a company word.
  if (taken.length === 1 && !ORG_WORDS.includes(lower)) return null;
  if (!ORG_WORDS.some((w) => lower.split(/[^a-z]+/).includes(w))) return null;

  return phrase;
}

/**
 * Looks for a statement that this practice belongs to a bigger organisation.
 *
 * Returns the sentence it found rather than just a boolean — an acquisition is a
 * judgement call, and whoever reviews the lead needs to read the wording itself.
 */
export function detectAcquisition(text: string): AcquisitionSignal | null {
  const flat = text
    // Script and style bodies survive a naive tag strip and produce nonsense matches.
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();

  for (const phrase of ACQUISITION_PHRASES) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(phrase, from);
      if (at === -1) break;
      from = at + phrase.length;

      const after = flat.slice(at + phrase.length, at + phrase.length + 90);
      const owner = namesAnOrganisation(after);
      if (!owner) continue;

      const start = Math.max(0, flat.lastIndexOf('.', at) + 1);
      const stop = flat.indexOf('.', at + phrase.length);
      const context = flat
        .slice(start, stop === -1 ? Math.min(flat.length, at + phrase.length + 90) : stop + 1)
        .trim();

      if (context.length < 15 || context.length > 400) continue;
      if (looksLikeCode(context)) continue;

      return { phrase, context: context.slice(0, 300) };
    }
  }

  return null;
}

/** Runs a list of async jobs with a fixed number in flight at a time. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onDone?: (result: R, index: number) => void
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      onDone?.(results[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Google Business Profile matching
// ---------------------------------------------------------------------------

export type PlaceMatch = {
  place: PlaceHit;
  confidence: number;
  evidence: string[];
};

/**
 * How confident we are that a Maps listing is this lead's practice.
 *
 * Phone dominates deliberately. A practice name like "FAMILY MEDICINE" matches
 * dozens of listings in one city, but a ten-digit number is effectively unique,
 * and NPPES gives us one for every lead. Name agreement alone is treated as weak
 * evidence rather than proof.
 */
export function scorePlaceMatch(target: VerifyTarget, place: PlaceHit): PlaceMatch {
  const evidence: string[] = [];
  let confidence = 0;

  const leadPhone = phoneDigits(target.phone);
  const placePhone = phoneDigits(place.phone);
  if (leadPhone && placePhone && leadPhone === placePhone) {
    confidence += 60;
    evidence.push('phone matches');
  }

  const haystack = `${place.name} ${place.address}`.toUpperCase();

  const leadName = normalizeOrgName(target.organization);
  if (leadName && haystack.includes(leadName)) {
    confidence += 25;
    evidence.push('name matches');
  } else if (leadName) {
    // Partial credit when the distinctive words line up but the legal form or
    // word order does not — "MCKAY FAMILY PRACTICE" against "McKay Family Med".
    const words = leadName.split(' ').filter((w: string) => w.length > 3);
    const hits = words.filter((w: string) => haystack.includes(w)).length;
    if (words.length && hits / words.length >= 0.6) {
      confidence += 15;
      evidence.push(`${hits}/${words.length} name words match`);
    }
  }

  if (target.city && haystack.includes(target.city.toUpperCase())) {
    confidence += 10;
    evidence.push('city matches');
  }

  const streetNumber = (target.address ?? '').trim().split(/\s+/)[0];
  if (streetNumber && /^\d+$/.test(streetNumber) && place.address.includes(streetNumber)) {
    confidence += 10;
    evidence.push('street number matches');
  }

  if (target.zip && place.address.includes(target.zip.slice(0, 5))) {
    confidence += 5;
    evidence.push('zip matches');
  }

  return { place, confidence: Math.min(100, confidence), evidence };
}

/** The best-matching listing at or above `minConfidence`, or null. */
export function pickPlace(
  target: VerifyTarget,
  places: PlaceHit[],
  minConfidence = 50
): PlaceMatch | null {
  let best: PlaceMatch | null = null;
  for (const place of places) {
    const scored = scorePlaceMatch(target, place);
    if (!best || scored.confidence > best.confidence) best = scored;
  }
  return best && best.confidence >= minConfidence ? best : null;
}

/** True when Google says the practice has stopped trading. */
export function placeIsClosed(status: string): boolean {
  return status === 'CLOSED_PERMANENTLY';
}

// ---------------------------------------------------------------------------
// Owner-name discovery — cross-checking NPPES's Authorized Official
// ---------------------------------------------------------------------------

/**
 * Phrases that introduce whoever owns or founded the practice. Deliberately
 * narrow and label-shaped ("Owner:", "Founded by") rather than anything that
 * could read as praise for an employee — a page saying "our owner is amazing"
 * is not the sentence this needs to catch, and loosening the phrase list is
 * exactly how the acquisition detector ended up with 15 false positives out
 * of 15 on its first pass.
 */
const OWNER_PHRASES = [
  'practice owner:', 'clinic owner:', 'owner:', 'owned by', 'is owned by',
  'founder:', 'founded by', 'proprietor:',
  // Both punctuated and bare-heading forms — a real page ("Meet The Owner"
  // as an <h2>, the name starting the very next block) collapses to this
  // once tags are stripped, with no comma anywhere near it.
  'meet the owner,', 'meet the owner', 'meet our owner,', 'meet our owner',
];

const CREDENTIAL_SUFFIXES = new Set([
  'MD', 'DO', 'DDS', 'DMD', 'DVM', 'DC', 'OD', 'NP', 'PA', 'DPT', 'RN', 'PHD', 'MBA',
]);

const NAME_TITLES = /^(DR|MR|MRS|MS)\.?$/i;

/**
 * Decides whether what follows an owner phrase is a person's name, and
 * returns it with any leading title or trailing credential kept but not
 * counted toward the two-word minimum — "Dr. Jane Kimball, OD" needs "Jane"
 * and "Kimball" to both be there, not just "Dr." and a certification.
 */
function looksLikePersonName(after: string): string | null {
  const words = after.trim().split(/\s+/).slice(0, 6);
  const taken: string[] = [];
  let realNameWords = 0;

  for (const raw of words) {
    const word = raw.replace(/^[^A-Za-z.'-]+|[^A-Za-z.'-]+$/g, '');
    if (!word) break;

    const bare = word.replace(/\.$/, '').toUpperCase();
    if (CREDENTIAL_SUFFIXES.has(bare)) {
      taken.push(word);
      continue;
    }
    if (NAME_TITLES.test(word)) {
      taken.push(word);
      continue;
    }
    // An all-caps word that is not a recognised credential — "PLLC", or a
    // credential this list does not happen to carry — reads as a stop, not
    // as a name. Checked before the general pattern below because that
    // pattern is deliberately loose enough to allow "McKay" or "MacDonald"
    // (a capital letter partway through a real surname), which would
    // otherwise just as happily swallow an unrecognised all-caps token too.
    if (/^[A-Z]{2,}\.?$/.test(word)) break;
    // A capitalised word — including one with a second capital partway
    // through, like "McKay" or "O'Brien" — or an initial like "M.". The
    // trailing "." is allowed either way, because the last name in a
    // sentence carries the full stop right on it ("...owner: Jane
    // Kimball.") and there is nothing here to tell that apart from a
    // genuine abbreviation.
    if (/^[A-Z][A-Za-z'-]*\.?$/.test(word) || /^[A-Z]\.$/.test(word)) {
      taken.push(word);
      realNameWords++;
      // A period ends the name-phrase either way — stop here rather than
      // reading into the next sentence, which is also capitalised as often
      // as not ("Owner: Sarah Chen. She has practiced..." must not swallow
      // "She").
      if (word.endsWith('.')) break;
      continue;
    }
    break;
  }

  if (realNameWords < 2) return null;

  // Now that matching is done, a sentence-ending "." on the last word is
  // punctuation, not part of the name — drop it unless what is left is a
  // single letter, which means it was actually an initial.
  const last = taken[taken.length - 1];
  if (last.endsWith('.') && last.length > 2) {
    taken[taken.length - 1] = last.slice(0, -1);
  }

  return taken.join(' ');
}

export type OwnerNameSignal = {
  name: string;
  /** Which phrase in OWNER_PHRASES matched. */
  phrase: string;
  context: string;
};

/**
 * Looks for the page stating, in so many words, who owns or founded the
 * practice. Meant to run on pages Step 4 already fetched for email — this is
 * a free by-product of that fetch, not a reason for a new one.
 *
 * Returns the name found so it can be compared against NPPES's Authorized
 * Official, not merged into it automatically: NPPES stays the field of
 * record unless a person looks at both and decides the site is right.
 */
export function detectOwnerName(text: string): OwnerNameSignal | null {
  const flat = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();

  for (const phrase of OWNER_PHRASES) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(phrase, from);
      if (at === -1) break;
      from = at + phrase.length;

      const after = flat.slice(at + phrase.length, at + phrase.length + 60);
      const name = looksLikePersonName(after);
      if (!name) continue;

      const start = Math.max(0, flat.lastIndexOf('.', at) + 1);
      const stop = flat.indexOf('.', at + phrase.length);
      // An "about the owner" bio is often one long run-on sentence with no
      // period for a while, so — unlike detectAcquisition, which discards a
      // match whose sentence runs unusually long — nothing here rejects the
      // match just because of that. The name was already confirmed from the
      // tightly-bounded `after` slice above; the context below is only ever
      // used for display, and is truncated for that regardless.
      const context =
        stop === -1
          ? flat.slice(start, Math.min(flat.length, at + phrase.length + 200)).trim()
          : flat.slice(start, stop + 1).trim();

      if (looksLikeCode(context)) continue;

      return { name, phrase, context: (context || after.trim()).slice(0, 300) };
    }
  }

  return null;
}
