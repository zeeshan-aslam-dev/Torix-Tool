/**
 * SerpAPI lookup for Step 3.
 *
 * This is the only part of the pipeline that costs money, so it is deliberately
 * the last resort: the verify route only reaches for it once the free sources
 * have failed, and it stays disabled unless SERPAPI_KEY is set.
 */

export type SearchHit = {
  title: string;
  link: string;
  snippet: string;
};

export function serpApiConfigured(): boolean {
  return Boolean(process.env.SERPAPI_KEY?.trim());
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
  'md.com', 'healthline.com', 'castleconnolly.com', 'docinfo.org', 'npino.com',
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
 * Runs one Google search through SerpAPI and returns the organic results,
 * directory and social listings already removed.
 */
export async function serpApiSearch(query: string, timeoutMs = 15000): Promise<SearchHit[]> {
  const key = process.env.SERPAPI_KEY?.trim();
  if (!key) throw new Error('SERPAPI_KEY is not set');

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

    return (data.organic_results ?? [])
      .filter((r) => r.link && !isDirectoryDomain(r.link))
      .map((r) => ({
        title: r.title ?? '',
        link: r.link as string,
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
