import fs from 'fs';
import path from 'path';

/**
 * ZIP centroids, for radius search.
 *
 * Backed by the US Census Bureau's 2024 ZCTA Gazetteer — public domain, shipped
 * in the repo rather than fetched, so a radius search never depends on a third
 * party being up. A ZCTA is the Census approximation of a ZIP delivery area, not
 * the postal boundary itself, so a radius is a good filter and a poor survey
 * instrument: a practice a few hundred metres past the line can fall either way.
 *
 * PO-box-only and some military ZIPs have no ZCTA and are simply absent. Those
 * are asked for by name rather than found by radius.
 */

const CENTROID_PATH = path.join(process.cwd(), 'config', 'zip-centroids.txt');

export type Centroid = { lat: number; lng: number };

let cache: Map<string, Centroid> | null = null;

function load(): Map<string, Centroid> {
  if (cache) return cache;

  const map = new Map<string, Centroid>();
  try {
    const raw = fs.readFileSync(CENTROID_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [zip, lat, lng] = line.split(',');
      const la = Number(lat);
      const ln = Number(lng);
      if (zip?.length === 5 && Number.isFinite(la) && Number.isFinite(ln)) {
        map.set(zip, { lat: la, lng: ln });
      }
    }
  } catch {
    // A missing file must not take the pipeline down — radius search simply
    // finds nothing and the caller reports it.
  }

  cache = map;
  return map;
}

export function zipCount(): number {
  return load().size;
}

/** Normalises "84074-1234", " 84074 " and 84074 to "84074". */
export function normalizeZip(zip: string | number): string {
  return String(zip).trim().slice(0, 5);
}

export function zipCentroid(zip: string): Centroid | null {
  return load().get(normalizeZip(zip)) ?? null;
}

const EARTH_RADIUS_MILES = 3958.7613;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in miles. */
export function haversineMiles(a: Centroid, b: Centroid): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type RadiusResult = {
  center: string;
  miles: number;
  zips: string[];
  /** True when the centre ZIP itself has no centroid, so nothing could be measured. */
  unknownCenter: boolean;
};

/**
 * Every ZIP whose centroid lies within `miles` of the centre ZIP's centroid.
 *
 * A bounding box is applied before the distance so a 25-mile search does not run
 * haversine over all 33,791 ZIPs. The centre is always included when it exists,
 * even at radius 0.
 */
export function zipsWithinRadius(centerZip: string, miles: number): RadiusResult {
  const center = normalizeZip(centerZip);
  const origin = zipCentroid(center);
  const radius = Math.max(0, miles);

  if (!origin) return { center, miles: radius, zips: [], unknownCenter: true };

  // One degree of latitude is ~69 miles anywhere; longitude shrinks with latitude.
  const latPad = radius / 69 + 0.01;
  const cosLat = Math.max(0.01, Math.cos(toRad(origin.lat)));
  const lngPad = radius / (69 * cosLat) + 0.01;

  const found: string[] = [];
  load().forEach((point, zip) => {
    if (Math.abs(point.lat - origin.lat) > latPad) return;
    if (Math.abs(point.lng - origin.lng) > lngPad) return;
    if (haversineMiles(origin, point) <= radius) found.push(zip);
  });

  found.sort();
  return { center, miles: radius, zips: found, unknownCenter: false };
}

/** Expands every centre ZIP in one pass, de-duplicated. */
export function expandRadius(centerZips: string[], miles: number): RadiusResult[] {
  return centerZips.map((zip) => zipsWithinRadius(zip, miles));
}

// ---------------------------------------------------------------------------
// County — for the Time Zone > State > City > County grouping requested for
// outreach scheduling. NPPES carries no county field at all, so this joins
// the ZIP already on every lead against a Census crosswalk shipped in the repo.
// ---------------------------------------------------------------------------

const COUNTY_PATH = path.join(process.cwd(), 'config', 'zip-county.txt');

let countyCache: Map<string, string> | null = null;

function loadCounties(): Map<string, string> {
  if (countyCache) return countyCache;

  const map = new Map<string, string>();
  try {
    const raw = fs.readFileSync(COUNTY_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [zip, county] = line.split(',');
      if (zip?.length === 5 && county) map.set(zip, county.trim());
    }
  } catch {
    // Missing file must not take Step 1 down — county simply stays unset.
  }

  countyCache = map;
  return map;
}

export function countyCount(): number {
  return loadCounties().size;
}

/**
 * The county a ZIP mostly falls in.
 *
 * A ZCTA occasionally straddles a county line; the crosswalk this reads was
 * built by keeping whichever county holds the largest land area for that ZIP,
 * so the answer is the practical majority case, not a guarantee for every
 * address inside the ZIP.
 */
export function zipCounty(zip: string): string | null {
  return loadCounties().get(normalizeZip(zip)) ?? null;
}

// ---------------------------------------------------------------------------
// Time zone — state-level by default, since NPPES gives no coordinate finer
// than the ZIP already resolved above. Fourteen states are genuinely split
// across two zones; the override list below covers the counties one would
// otherwise misfile most often. This is deliberately not a full boundary map —
// treat it as "correct for the large majority of addresses," not authoritative
// for a county not listed here.
// ---------------------------------------------------------------------------

export type UsTimezone = 'Eastern' | 'Central' | 'Mountain' | 'Pacific' | 'Alaska' | 'Hawaii' | 'Atlantic' | 'Chamorro' | 'Samoa';

const STATE_TIMEZONE: Record<string, UsTimezone> = {
  CT: 'Eastern', DE: 'Eastern', DC: 'Eastern', FL: 'Eastern', GA: 'Eastern', ME: 'Eastern',
  MD: 'Eastern', MA: 'Eastern', NH: 'Eastern', NJ: 'Eastern', NY: 'Eastern', NC: 'Eastern',
  OH: 'Eastern', PA: 'Eastern', RI: 'Eastern', SC: 'Eastern', VT: 'Eastern', VA: 'Eastern',
  WV: 'Eastern', MI: 'Eastern', IN: 'Eastern', KY: 'Eastern', TN: 'Eastern',

  AL: 'Central', AR: 'Central', IL: 'Central', IA: 'Central', KS: 'Central', LA: 'Central',
  MN: 'Central', MS: 'Central', MO: 'Central', NE: 'Central', ND: 'Central', OK: 'Central',
  SD: 'Central', TX: 'Central', WI: 'Central',

  AZ: 'Mountain', CO: 'Mountain', ID: 'Mountain', MT: 'Mountain', NM: 'Mountain',
  UT: 'Mountain', WY: 'Mountain',

  CA: 'Pacific', NV: 'Pacific', OR: 'Pacific', WA: 'Pacific',

  AK: 'Alaska', HI: 'Hawaii',
  PR: 'Atlantic', VI: 'Atlantic',
  GU: 'Chamorro', MP: 'Chamorro',
  AS: 'Samoa',
};

/**
 * County name (as it appears in `zipCounty`) mapped to the zone that county
 * actually observes, for the best-documented splits: the Florida panhandle,
 * western Kentucky, western Indiana border counties, the Upper Peninsula's
 * western counties, East Tennessee, the Texas border around El Paso, and
 * North Idaho.
 *
 * Keyed on "STATE|COUNTY" rather than county name alone — "Washington County"
 * exists in both Florida and Tennessee wanting opposite answers, and the same
 * clash repeats for Hancock and Union. A bare county-name key would let the
 * second state silently overwrite the first.
 */
const COUNTY_TIMEZONE_OVERRIDE: Record<string, UsTimezone> = {
  // Florida panhandle — Central, not the state default of Eastern
  'FL|BAY COUNTY': 'Central', 'FL|CALHOUN COUNTY': 'Central', 'FL|ESCAMBIA COUNTY': 'Central',
  'FL|GULF COUNTY': 'Central', 'FL|HOLMES COUNTY': 'Central', 'FL|JACKSON COUNTY': 'Central',
  'FL|OKALOOSA COUNTY': 'Central', 'FL|SANTA ROSA COUNTY': 'Central', 'FL|WALTON COUNTY': 'Central',
  'FL|WASHINGTON COUNTY': 'Central',

  // Western Kentucky — Central, not the state default of Eastern
  'KY|CALDWELL COUNTY': 'Central', 'KY|CHRISTIAN COUNTY': 'Central', 'KY|CRITTENDEN COUNTY': 'Central',
  'KY|DAVIESS COUNTY': 'Central', 'KY|FULTON COUNTY': 'Central', 'KY|GRAVES COUNTY': 'Central',
  'KY|HANCOCK COUNTY': 'Central', 'KY|HENDERSON COUNTY': 'Central', 'KY|HICKMAN COUNTY': 'Central',
  'KY|HOPKINS COUNTY': 'Central', 'KY|LIVINGSTON COUNTY': 'Central', 'KY|LYON COUNTY': 'Central',
  'KY|MARSHALL COUNTY': 'Central', 'KY|MCCRACKEN COUNTY': 'Central', 'KY|MCLEAN COUNTY': 'Central',
  'KY|MUHLENBERG COUNTY': 'Central', 'KY|OHIO COUNTY': 'Central', 'KY|TODD COUNTY': 'Central',
  'KY|TRIGG COUNTY': 'Central', 'KY|UNION COUNTY': 'Central', 'KY|WEBSTER COUNTY': 'Central',

  // Indiana border counties — Central, not the state default of Eastern
  'IN|GIBSON COUNTY': 'Central', 'IN|JASPER COUNTY': 'Central', 'IN|LAKE COUNTY': 'Central',
  'IN|LAPORTE COUNTY': 'Central', 'IN|NEWTON COUNTY': 'Central', 'IN|PORTER COUNTY': 'Central',
  'IN|POSEY COUNTY': 'Central', 'IN|PULASKI COUNTY': 'Central', 'IN|SPENCER COUNTY': 'Central',
  'IN|STARKE COUNTY': 'Central', 'IN|VANDERBURGH COUNTY': 'Central', 'IN|WARRICK COUNTY': 'Central',

  // Michigan Upper Peninsula, western counties — Central, not Eastern
  'MI|GOGEBIC COUNTY': 'Central', 'MI|IRON COUNTY': 'Central', 'MI|DICKINSON COUNTY': 'Central',
  'MI|MENOMINEE COUNTY': 'Central',

  // East Tennessee — Eastern, not the state default of Central
  'TN|ANDERSON COUNTY': 'Eastern', 'TN|BLOUNT COUNTY': 'Eastern', 'TN|BRADLEY COUNTY': 'Eastern',
  'TN|CAMPBELL COUNTY': 'Eastern', 'TN|CARTER COUNTY': 'Eastern', 'TN|CLAIBORNE COUNTY': 'Eastern',
  'TN|COCKE COUNTY': 'Eastern', 'TN|GRAINGER COUNTY': 'Eastern', 'TN|GREENE COUNTY': 'Eastern',
  'TN|HAMBLEN COUNTY': 'Eastern', 'TN|HAMILTON COUNTY': 'Eastern', 'TN|HANCOCK COUNTY': 'Eastern',
  'TN|HAWKINS COUNTY': 'Eastern', 'TN|JEFFERSON COUNTY': 'Eastern', 'TN|JOHNSON COUNTY': 'Eastern',
  'TN|KNOX COUNTY': 'Eastern', 'TN|LOUDON COUNTY': 'Eastern', 'TN|MCMINN COUNTY': 'Eastern',
  'TN|MEIGS COUNTY': 'Eastern', 'TN|MONROE COUNTY': 'Eastern', 'TN|MORGAN COUNTY': 'Eastern',
  'TN|POLK COUNTY': 'Eastern', 'TN|RHEA COUNTY': 'Eastern', 'TN|ROANE COUNTY': 'Eastern',
  'TN|SCOTT COUNTY': 'Eastern', 'TN|SEVIER COUNTY': 'Eastern', 'TN|SULLIVAN COUNTY': 'Eastern',
  'TN|UNICOI COUNTY': 'Eastern', 'TN|UNION COUNTY': 'Eastern', 'TN|WASHINGTON COUNTY': 'Eastern',

  // Far west Texas — Mountain, not the state default of Central
  'TX|EL PASO COUNTY': 'Mountain', 'TX|HUDSPETH COUNTY': 'Mountain',

  // North Idaho panhandle — Pacific, not the state default of Mountain
  'ID|BENEWAH COUNTY': 'Pacific', 'ID|BONNER COUNTY': 'Pacific', 'ID|BOUNDARY COUNTY': 'Pacific',
  'ID|CLEARWATER COUNTY': 'Pacific', 'ID|IDAHO COUNTY': 'Pacific', 'ID|KOOTENAI COUNTY': 'Pacific',
  'ID|LATAH COUNTY': 'Pacific', 'ID|LEWIS COUNTY': 'Pacific', 'ID|NEZ PERCE COUNTY': 'Pacific',
  'ID|SHOSHONE COUNTY': 'Pacific',
};

/**
 * Best-effort US time zone for a lead. State-level by default; a county name
 * (from `zipCounty`) upgrades the answer for the documented splits above.
 */
export function usTimezone(state: string, county?: string | null): UsTimezone | null {
  const st = state.toUpperCase().trim();
  const base = STATE_TIMEZONE[st] ?? null;
  if (!county) return base;

  const override = COUNTY_TIMEZONE_OVERRIDE[`${st}|${county.toUpperCase().trim()}`];
  return override ?? base;
}
