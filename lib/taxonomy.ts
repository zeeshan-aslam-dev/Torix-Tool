/**
 * Taxonomy filter for Step 1: exact NUCC codes and prefixes (e.g. "207*").
 *
 * Prefixes are how "all physicians" / "all dentists" are expressed without
 * pasting every specialty code into the UI.
 */

export type TaxonomyFilter = {
  /** Exact ten-character (or otherwise full) codes. */
  exact: Set<string>;
  /** Prefixes from entries ending in "*", matched with startsWith. */
  prefixes: string[];
};

export function parseTaxonomyFilter(raw: string): TaxonomyFilter {
  const exact = new Set<string>();
  const prefixes = new Set<string>();

  for (const part of raw.split(',')) {
    const token = part.trim().toUpperCase();
    if (!token) continue;
    if (token.endsWith('*')) {
      const prefix = token.slice(0, -1).replace(/[^A-Z0-9]/g, '');
      if (prefix) prefixes.add(prefix);
      continue;
    }
    exact.add(token);
  }

  return { exact, prefixes: Array.from(prefixes) };
}

export function taxonomyFilterIsEmpty(filter: TaxonomyFilter): boolean {
  return filter.exact.size === 0 && filter.prefixes.length === 0;
}

/** Whether one taxonomy code from an NPPES row passes the filter. */
export function taxonomyMatches(code: string, filter: TaxonomyFilter): boolean {
  const tax = code.trim().toUpperCase();
  if (!tax) return false;
  if (filter.exact.has(tax)) return true;
  return filter.prefixes.some((p) => tax.startsWith(p));
}
