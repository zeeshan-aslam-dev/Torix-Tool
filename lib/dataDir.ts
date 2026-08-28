import fs from 'fs';
import path from 'path';

/** Project-local drop folder for raw NPPES CSVs. */
export const DATA_DIR = path.join(process.cwd(), 'data');

/**
 * Extra folders to read CSVs from, so a multi-GB NPPES dissemination folder can be
 * used in place without copying it into the project.
 * Set NPPES_DATA_DIR in .env (semicolon-separated for more than one).
 */
export function dataRoots(): string[] {
  const extra = (process.env.NPPES_DATA_DIR || '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));

  return [DATA_DIR, ...extra].filter(
    (dir, i, all) => all.indexOf(dir) === i && fs.existsSync(dir)
  );
}

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

/**
 * Resolve a user-supplied file name to an absolute path inside one of the data roots.
 * Returns null if the name escapes those folders or the file does not exist.
 */
export function resolveDataFile(fileName: string): string | null {
  if (!fileName) return null;
  const safeName = path.basename(fileName);

  for (const root of dataRoots()) {
    const full = path.join(root, safeName);
    const rel = path.relative(root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

/**
 * Finds a companion dissemination file by prefix (e.g. "othername_pfile"),
 * ignoring the header-only "_fileheader" variants. Returns null when absent.
 */
export function findDataFileByPrefix(prefix: string): string | null {
  for (const root of dataRoots()) {
    const match = fs
      .readdirSync(root)
      .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
      .filter((name) => !name.toLowerCase().endsWith('_fileheader.csv'))
      .filter((name) => name.toLowerCase().endsWith('.csv'))
      .sort()
      .pop();
    if (match) return path.join(root, match);
  }
  return null;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}
