import { zipsWithinRadius, normalizeZip } from './geo';

/**
 * The geographic filter every step shares.
 *
 * Each stage used to parse `states` on its own, which meant a narrower scope
 * could be chosen in Step 1 and silently widen again by Step 4. One resolver,
 * one shape, and every route reports the scope it actually applied.
 *
 * Dimensions combine with AND: states AND cities AND zips. A radius is just a
 * way of writing a long ZIP list, so it merges into the ZIP dimension rather
 * than forming a fourth one.
 */

export type ScopeInput = {
  states?: string;
  cities?: string;
  zips?: string;
  radiusZip?: string;
  radiusMiles?: number;
};

export type Scope = {
  states: string[];
  cities: string[];
  /** Exact five-digit ZIPs. */
  zips: string[];
  /** ZIP prefixes written as "840*", matched with startsWith. */
  zipPrefixes: string[];
  radius: { center: string; miles: number; matched: number } | null;
  warnings: string[];
};

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function resolveScope(input: ScopeInput): Scope {
  const warnings: string[] = [];

  const states = splitList(input.states).map((s) => s.toUpperCase());
  const cities = splitList(input.cities).map((s) => s.toUpperCase());

  const zips = new Set<string>();
  const zipPrefixes = new Set<string>();

  for (const raw of splitList(input.zips)) {
    if (raw.endsWith('*')) {
      const prefix = raw.slice(0, -1).replace(/\D/g, '');
      if (prefix) zipPrefixes.add(prefix);
      else warnings.push(`ignored ZIP pattern "${raw}" — no digits before the *`);
      continue;
    }
    const zip = normalizeZip(raw.replace(/[^0-9]/g, ''));
    if (zip.length === 5) zips.add(zip);
    else warnings.push(`ignored ZIP "${raw}" — not five digits`);
  }

  // --- radius, folded into the ZIP list ------------------------------------
  let radius: Scope['radius'] = null;
  const centerZip = (input.radiusZip ?? '').trim();
  const miles = Number(input.radiusMiles);

  if (centerZip && Number.isFinite(miles) && miles > 0) {
    const result = zipsWithinRadius(centerZip, miles);
    if (result.unknownCenter) {
      warnings.push(
        `ZIP ${result.center} has no Census centroid — PO-box-only and some military ZIPs are absent, so no radius could be applied`
      );
    } else {
      for (const zip of result.zips) zips.add(zip);
      radius = { center: result.center, miles: result.miles, matched: result.zips.length };
    }
  } else if (centerZip && !(miles > 0)) {
    warnings.push(`radius ZIP ${centerZip} given without a positive distance — ignored`);
  }

  return {
    states,
    cities,
    zips: Array.from(zips).sort(),
    zipPrefixes: Array.from(zipPrefixes).sort(),
    radius,
    warnings,
  };
}

export function scopeIsEmpty(scope: Scope): boolean {
  return (
    scope.states.length === 0 &&
    scope.cities.length === 0 &&
    scope.zips.length === 0 &&
    scope.zipPrefixes.length === 0
  );
}

type WhereFragment = Record<string, unknown>;

/**
 * The Prisma `where` fragment for steps 2-5, which filter rows already imported.
 *
 * ZIPs are stored as five digits, so an exact list and the prefixes are ORed
 * together into a single ZIP condition, and that condition ANDs with the rest.
 */
export function scopeWhere(scope: Scope): WhereFragment {
  const clauses: WhereFragment[] = [];

  if (scope.states.length) clauses.push({ state: { in: scope.states } });
  if (scope.cities.length) clauses.push({ city: { in: scope.cities } });

  const zipClauses: WhereFragment[] = [];
  if (scope.zips.length) zipClauses.push({ zip: { in: scope.zips } });
  for (const prefix of scope.zipPrefixes) zipClauses.push({ zip: { startsWith: prefix } });
  if (zipClauses.length) clauses.push(zipClauses.length === 1 ? zipClauses[0] : { OR: zipClauses });

  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0];
  return { AND: clauses };
}

/**
 * The row-level test for Step 1, which streams the CSV and has no database to
 * query. Deliberately built from the same Scope so the two paths cannot drift.
 */
export function makeScopeMatcher(scope: Scope) {
  const states = new Set(scope.states);
  const cities = new Set(scope.cities);
  const zips = new Set(scope.zips);
  const prefixes = scope.zipPrefixes;
  const checkZip = zips.size > 0 || prefixes.length > 0;

  return (row: { state: string; city: string; zip: string }): boolean => {
    if (states.size && !states.has(row.state.toUpperCase())) return false;
    if (cities.size && !cities.has(row.city.toUpperCase())) return false;

    if (checkZip) {
      const zip = normalizeZip(row.zip);
      if (zips.has(zip)) return true;
      return prefixes.some((p) => zip.startsWith(p));
    }

    return true;
  };
}

/** One line naming exactly what was applied, for the run log. */
export function describeScope(scope: Scope): string {
  const parts: string[] = [];

  if (scope.states.length) parts.push(`states ${scope.states.join('/')}`);
  if (scope.cities.length) parts.push(`cities ${scope.cities.join('/')}`);

  if (scope.radius) {
    parts.push(
      `within ${scope.radius.miles} mi of ${scope.radius.center} (${scope.radius.matched} ZIPs)`
    );
    const listed = scope.zips.length - scope.radius.matched;
    if (listed > 0) parts.push(`plus ${listed} listed ZIP${listed === 1 ? '' : 's'}`);
  } else if (scope.zips.length) {
    parts.push(
      scope.zips.length <= 6
        ? `ZIPs ${scope.zips.join('/')}`
        : `${scope.zips.length} ZIPs`
    );
  }

  if (scope.zipPrefixes.length) {
    parts.push(`ZIP prefixes ${scope.zipPrefixes.map((p) => p + '*').join('/')}`);
  }

  return parts.length ? parts.join(', ') : 'everything (no geographic filter)';
}
