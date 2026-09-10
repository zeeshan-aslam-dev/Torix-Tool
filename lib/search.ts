/**
 * Web search for Step 3.
 *
 * This is the only part of the pipeline that costs money, so it is deliberately
 * the last resort: the verify route only reaches for it once the free sources
 * have failed, and it stays disabled unless a provider key is set.
 *
 * Two providers are supported because they are priced for different shapes of
 * work. SerpAPI sells a monthly allowance that expires; Serper sells credits
 * that do not. Resolution here is bursty — one large sweep per state, then a
 * trickle — so Serper is preferred when both keys are present.
 */

export type SearchHit = {
  title: string;
  link: string;
  snippet: string;
};

export type SearchProvider = 'serper' | 'serpapi';

/** Which provider the keys in .env select, or null when neither is set. */
export function searchProvider(): SearchProvider | null {
  if (process.env.SERPER_KEY?.trim()) return 'serper';
  if (process.env.SERPAPI_KEY?.trim()) return 'serpapi';
  return null;
}

export function searchConfigured(): boolean {
  return searchProvider() !== null;
}

/** Domains that are directories or listings rather than a practice's own site. */
const DIRECTORY_DOMAINS = [
  'healthgrades.com', 'vitals.com', 'webmd.com', 'zocdoc.com', 'yelp.com',
  'facebook.com', 'linkedin.com', 'instagram.com', 'twitter.com', 'x.com',
  'npidb.org', 'npino.com', 'doctor.com', 'ratemds.com', 'sharecare.com',
  'yellowpages.com', 'mapquest.com', 'bbb.org', 'indeed.com', 'glassdoor.com',
  'wikipedia.org', 'medicare.gov', 'cms.gov', 'npiprofile.com', 'hipaaspace.com',
  'findadoctor.com', 'caredash.com', 'wellness.com', 'youtube.com', 'tiktok.com',
  // aggregators and payer directories seen in live results during testing
  'solvhealth.com', 'optum.com', 'medicalnewstoday.com', 'health.usnews.com',
  'md.com', 'healthline.com', 'castleconnolly.com', 'docinfo.org',
  'opencare.com', 'zoominfo.com', 'crunchbase.com', 'apple.com', 'google.com',
];

export function isDirectoryDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return DIRECTORY_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return true;
  }
}

/**
 * A LinkedIn company or personal profile URL, cleaned to its canonical form.
 *
 * Prefers a company page over a personal one when a result page happens to
 * carry both — a business's own LinkedIn presence is the more useful record
 * for outreach than whichever employee's profile Google chose to rank.
 */
const LINKEDIN_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(company|in)\/[A-Za-z0-9._%-]+/i;

export function findLinkedInUrl(urls: (string | undefined | null)[]): string | null {
  let personal: string | null = null;
  for (const url of urls) {
    if (!url) continue;
    const match = url.match(LINKEDIN_RE);
    if (!match) continue;
    const clean = match[0].replace(/\/$/, '');
    if (match[1].toLowerCase() === 'company') return clean;
    personal = personal ?? clean;
  }
  return personal;
}

export type WebSearchResult = {
  /** Organic results with directories and socials removed — the website candidates. */
  hits: SearchHit[];
  /** A LinkedIn page pulled from the same results, before that filter ran. */
  linkedIn: string | null;
};

/**
 * Runs one Google search through whichever provider is configured.
 *
 * linkedin.com is on the directory list because it is never the practice's own
 * site, but the same query already paid for the page — so a LinkedIn hit is
 * read out of the raw results before that filter runs, rather than spending a
 * second query on a dedicated LinkedIn search.
 */
export async function webSearch(query: string, timeoutMs = 15000): Promise<WebSearchResult> {
  const provider = searchProvider();
  if (!provider) throw new Error('No search key set — add SERPER_KEY or SERPAPI_KEY to .env');

  const raw = provider === 'serper'
    ? await serperSearch(query, timeoutMs)
    : await serpApiSearch(query, timeoutMs);

  return {
    hits: raw.filter((r) => r.link && !isDirectoryDomain(r.link)),
    linkedIn: findLinkedInUrl(raw.map((r) => r.link)),
  };
}

async function serperSearch(query: string, timeoutMs: number): Promise<SearchHit[]> {
  const key = process.env.SERPER_KEY!.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 10 }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Serper returned ${res.status}`);

    const data = (await res.json()) as {
      message?: string;
      organic?: Array<{ title?: string; link?: string; snippet?: string }>;
    };
    if (data.message) throw new Error(data.message);

    return (data.organic ?? []).map((r) => ({
      title: r.title ?? '',
      link: r.link ?? '',
      snippet: r.snippet ?? '',
    }));
  } finally {
    clearTimeout(timer);
  }
}

async function serpApiSearch(query: string, timeoutMs: number): Promise<SearchHit[]> {
  const key = process.env.SERPAPI_KEY!.trim();

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('num', '10');
  url.searchParams.set('api_key', key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`SerpAPI returned ${res.status}`);

    const data = (await res.json()) as {
      error?: string;
      organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
    };
    if (data.error) throw new Error(data.error);

    return (data.organic_results ?? []).map((r) => ({
      title: r.title ?? '',
      link: r.link ?? '',
      snippet: r.snippet ?? '',
    }));
  } finally {
    clearTimeout(timer);
  }
}

/** The search string most likely to surface a practice's own site. */
export function buildQuery(organization: string, city?: string | null, state?: string | null): string {
  return [organization, city, state].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Google Business Profile
// ---------------------------------------------------------------------------

/**
 * A business listing, as Google Maps knows it.
 *
 * Worth a separate call from web search because it answers a question the
 * organic results cannot: whether the practice is still trading. NPPES records
 * go stale — 41% were last touched over ten years ago — and a closed clinic is
 * indistinguishable from an open one in the file itself.
 */
export type PlaceHit = {
  name: string;
  address: string;
  phone: string;
  website: string;
  category: string;
  rating: number | null;
  reviews: number | null;
  placeId: string;
  /** OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY | '' when not stated. */
  status: string;
};

/** Digits only, so "(801) 210-2445" and "8012102445" compare equal. */
export function phoneDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
}

const asNumber = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Normalises the many shapes a "closed" flag arrives in. Providers variously
 * send a status enum, a boolean, or nothing at all, and an absent flag means
 * "not stated" rather than "open".
 */
function normalizeStatus(raw: Record<string, unknown>): string {
  const explicit = String(raw.business_status ?? raw.businessStatus ?? '').toUpperCase();
  if (explicit) return explicit;

  if (raw.permanently_closed === true || raw.permanentlyClosed === true) return 'CLOSED_PERMANENTLY';

  const text = String(raw.type ?? raw.description ?? raw.title ?? '').toLowerCase();
  if (text.includes('permanently closed')) return 'CLOSED_PERMANENTLY';
  if (text.includes('temporarily closed')) return 'CLOSED_TEMPORARILY';

  return '';
}

function toPlace(raw: Record<string, unknown>): PlaceHit {
  return {
    name: String(raw.title ?? raw.name ?? ''),
    address: String(raw.address ?? raw.formatted_address ?? ''),
    phone: String(raw.phone ?? raw.phoneNumber ?? ''),
    website: String(raw.website ?? ''),
    category: String(raw.type ?? raw.category ?? (Array.isArray(raw.types) ? raw.types[0] : '') ?? ''),
    rating: asNumber(raw.rating),
    reviews: asNumber(raw.reviews ?? raw.ratingCount ?? raw.user_ratings_total),
    placeId: String(raw.place_id ?? raw.placeId ?? raw.cid ?? ''),
    status: normalizeStatus(raw),
  };
}

/** Runs one Google Maps search through whichever provider is configured. */
export async function mapsSearch(query: string, timeoutMs = 15000): Promise<PlaceHit[]> {
  const provider = searchProvider();
  if (!provider) throw new Error('No search key set — add SERPER_KEY or SERPAPI_KEY to .env');

  const rows = provider === 'serper'
    ? await serperPlaces(query, timeoutMs)
    : await serpApiMaps(query, timeoutMs);

  return rows.map(toPlace).filter((p) => p.name);
}

async function serperPlaces(query: string, timeoutMs: number): Promise<Record<string, unknown>[]> {
  const key = process.env.SERPER_KEY!.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://google.serper.dev/places', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Serper places returned ${res.status}`);

    const data = (await res.json()) as { message?: string; places?: Record<string, unknown>[] };
    if (data.message) throw new Error(data.message);
    return data.places ?? [];
  } finally {
    clearTimeout(timer);
  }
}

async function serpApiMaps(query: string, timeoutMs: number): Promise<Record<string, unknown>[]> {
  const key = process.env.SERPAPI_KEY!.trim();

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_maps');
  url.searchParams.set('type', 'search');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`SerpAPI maps returned ${res.status}`);

    const data = (await res.json()) as {
      error?: string;
      local_results?: Record<string, unknown>[];
      place_results?: Record<string, unknown>;
    };
    if (data.error) throw new Error(data.error);

    // A query specific enough to identify one business returns place_results
    // instead of a list, so both shapes have to be handled.
    if (Array.isArray(data.local_results) && data.local_results.length) return data.local_results;
    if (data.place_results) return [data.place_results];
    return [];
  } finally {
    clearTimeout(timer);
  }
}
