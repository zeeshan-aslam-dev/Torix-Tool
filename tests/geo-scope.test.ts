import { zipCount, zipCentroid, haversineMiles, zipsWithinRadius, normalizeZip, zipCounty, countyCount, usTimezone } from '../lib/geo';
import { resolveScope, scopeWhere, makeScopeMatcher, describeScope, scopeIsEmpty } from '../lib/scope';

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
}
function near(name: string, actual: number, expected: number, tolerance: number) {
  const ok = Math.abs(actual - expected) <= tolerance;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${expected} ±${tolerance}, got ${actual}`}`);
}

// --- the centroid file ----------------------------------------------------
check('every US ZIP is loaded', zipCount() > 33000, true);
check('a known ZIP resolves', zipCentroid('84074') !== null, true);
check('ZIP+4 is truncated to five digits', normalizeZip('84074-1234'), '84074');
check('a non-existent ZIP resolves to null', zipCentroid('00000'), null);

// --- county crosswalk -------------------------------------------------------
check('every US ZCTA has a county', countyCount() > 33000, true);
check('a known Utah ZIP resolves to its county', zipCounty('84074'), 'Tooele County');
check('a non-existent ZIP resolves to null', zipCounty('00000'), null);

// --- time zone --------------------------------------------------------------
check('Utah is Mountain by state default', usTimezone('UT'), 'Mountain');
check('Texas is Central by state default', usTimezone('TX'), 'Central');
check('El Paso County overrides Texas to Mountain', usTimezone('TX', 'El Paso County'), 'Mountain');
check('the Florida panhandle overrides to Central', usTimezone('FL', 'Bay County'), 'Central');
check('peninsular Florida keeps the state default of Eastern', usTimezone('FL', 'Miami-Dade County'), 'Eastern');
check('an unlisted county falls back to the state default', usTimezone('UT', 'Salt Lake County'), 'Mountain');
check('an unknown state returns null', usTimezone('ZZ'), null);
check('no county given still returns the state default', usTimezone('CO', null), 'Mountain');

// --- distance, against real-world figures ---------------------------------
const ny = zipCentroid('10001')!;
const la = zipCentroid('90001')!;
near('New York to Los Angeles', haversineMiles(ny, la), 2445, 30);
near('a ZIP to itself is zero', haversineMiles(ny, ny), 0, 0.001);

// --- radius ---------------------------------------------------------------
const r25 = zipsWithinRadius('84074', 25);
const r50 = zipsWithinRadius('84074', 50);
check('the centre ZIP is included', r25.zips.includes('84074'), true);
check('a wider radius is a superset', r25.zips.every((z) => r50.zips.includes(z)), true);
check('a wider radius finds more', r50.zips.length > r25.zips.length, true);
check('an unknown centre is reported, not guessed', zipsWithinRadius('00000', 25).unknownCenter, true);
check('an unknown centre yields nothing', zipsWithinRadius('00000', 25).zips, []);

// --- scope parsing --------------------------------------------------------
check('states are upper-cased', resolveScope({ states: 'ut, nv' }).states, ['UT', 'NV']);
check('cities are upper-cased', resolveScope({ cities: 'provo, orem' }).cities, ['PROVO', 'OREM']);
check('an exact ZIP is kept', resolveScope({ zips: '84074' }).zips, ['84074']);
check('a prefix is separated out', resolveScope({ zips: '840*' }).zipPrefixes, ['840']);
check('a prefix is not also an exact ZIP', resolveScope({ zips: '840*' }).zips, []);

// Junk in the box must not silently narrow the run to nothing.
const junk = resolveScope({ zips: '84074, 8407, abc, 84601' });
check('short and non-numeric ZIPs are dropped', junk.zips, ['84074', '84601']);
check('and each one is reported', junk.warnings.length, 2);

// A radius merges into the ZIP list rather than becoming a separate dimension.
const radius = resolveScope({ states: 'UT', radiusZip: '84074', radiusMiles: 25 });
check('a radius fills the ZIP list', radius.zips.length, r25.zips.length);
check('a radius records what it matched', radius.radius?.matched, r25.zips.length);
check('a radius without miles is refused', resolveScope({ radiusZip: '84074' }).radius, null);
check('and says why', resolveScope({ radiusZip: '84074' }).warnings.length, 1);
check('an unknown centre warns instead of silently matching everything',
  resolveScope({ radiusZip: '00000', radiusMiles: 25 }).warnings.length, 1);

// --- the Prisma fragment --------------------------------------------------
check('an empty scope filters nothing', scopeWhere(resolveScope({})), {});
check('one dimension needs no AND',
  scopeWhere(resolveScope({ states: 'UT' })), { state: { in: ['UT'] } });
check('a prefix becomes startsWith',
  scopeWhere(resolveScope({ zips: '840*' })), { zip: { startsWith: '840' } });
check('exact ZIPs and prefixes are ORed',
  scopeWhere(resolveScope({ zips: '84074, 850*' })),
  { OR: [{ zip: { in: ['84074'] } }, { zip: { startsWith: '850' } }] });
check('separate dimensions are ANDed',
  scopeWhere(resolveScope({ states: 'UT', cities: 'PROVO' })),
  { AND: [{ state: { in: ['UT'] } }, { city: { in: ['PROVO'] } }] });

// --- the streaming matcher must agree with the query ----------------------
const matcher = makeScopeMatcher(resolveScope({ states: 'UT', zips: '84074, 850*' }));
check('an exact ZIP matches', matcher({ state: 'UT', city: 'TOOELE', zip: '84074' }), true);
check('a prefix matches', matcher({ state: 'UT', city: 'TOOELE', zip: '85012' }), true);
check('a ZIP outside both fails', matcher({ state: 'UT', city: 'TOOELE', zip: '84601' }), false);
check('the wrong state fails even with a matching ZIP',
  matcher({ state: 'AZ', city: 'TOOELE', zip: '84074' }), false);
check('ZIP+4 in the source file still matches',
  matcher({ state: 'UT', city: 'TOOELE', zip: '840741234' }), true);

const cityOnly = makeScopeMatcher(resolveScope({ cities: 'provo' }));
check('city matching is case-insensitive', cityOnly({ state: 'UT', city: 'Provo', zip: '84601' }), true);
check('a different city fails', cityOnly({ state: 'UT', city: 'OREM', zip: '84057' }), false);

const nothing = makeScopeMatcher(resolveScope({}));
check('an empty scope matches everything', nothing({ state: 'AZ', city: 'MESA', zip: '85201' }), true);
check('and reports itself as empty', scopeIsEmpty(resolveScope({})), true);

// --- the log line ---------------------------------------------------------
check('an empty scope says so', describeScope(resolveScope({})), 'everything (no geographic filter)');
check('a radius is described in miles',
  describeScope(radius).includes('within 25 mi of 84074'), true);
check('a long ZIP list is counted, not listed',
  describeScope(resolveScope({ zips: '84001,84002,84003,84004,84005,84006,84007' })).includes('7 ZIPs'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
