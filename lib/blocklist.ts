import fs from 'fs';
import path from 'path';
import { normalizeOrgName } from './nppes';

/**
 * Named health systems and national chains that should never be pitched.
 *
 * The NPPES parent-organisation field only catches the ones that filled it in,
 * and it misses the case that matters most: a national system with a handful of
 * locations in the target state, which otherwise scores like a small independent
 * practice. This list is the explicit answer to that.
 *
 * Held in config/hospital-blocklist.json so it can be edited without a rebuild.
 */

export type BlocklistHit = {
  entry: string;
};

const BLOCKLIST_PATH = path.join(process.cwd(), 'config', 'hospital-blocklist.json');

let cache: { entries: string[][]; loadedAt: number; mtimeMs: number } | null = null;

/** Reloads the file when it changes on disk, so edits take effect on the next run. */
function load(): string[][] {
  try {
    const stat = fs.statSync(BLOCKLIST_PATH);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.entries;

    const raw = JSON.parse(fs.readFileSync(BLOCKLIST_PATH, 'utf8')) as { entries?: string[] };
    const entries = (raw.entries ?? [])
      .map((entry) => normalizeOrgName(entry).split(' ').filter(Boolean))
      .filter((tokens) => tokens.length > 0)
      // Longest first: the most specific entry is the one worth reporting.
      .sort((a, b) => b.length - a.length);

    cache = { entries, loadedAt: Date.now(), mtimeMs: stat.mtimeMs };
    return entries;
  } catch {
    // A missing or malformed file must not take scoring down with it.
    return [];
  }
}

export function blocklistSize(): number {
  return load().length;
}

/**
 * True when the blocklist entry's words appear as a consecutive run inside the
 * practice name. Matching on a run rather than a substring stops "OPTUM" from
 * firing on "OPTUMISTIC EYE CARE", and stops short entries from matching mid-word.
 */
function containsRun(nameTokens: string[], entryTokens: string[]): boolean {
  if (entryTokens.length > nameTokens.length) return false;

  outer: for (let i = 0; i <= nameTokens.length - entryTokens.length; i++) {
    for (let j = 0; j < entryTokens.length; j++) {
      if (nameTokens[i + j] !== entryTokens[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Returns the blocklist entry this practice belongs to, or null. */
export function matchBlocklist(organization: string): BlocklistHit | null {
  const nameTokens = normalizeOrgName(organization).split(' ').filter(Boolean);
  if (nameTokens.length === 0) return null;

  for (const entryTokens of load()) {
    if (containsRun(nameTokens, entryTokens)) {
      return { entry: entryTokens.join(' ') };
    }
  }
  return null;
}
