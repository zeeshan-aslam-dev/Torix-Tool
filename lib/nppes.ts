import fs from 'fs';
import readline from 'readline';

/**
 * Splits one line of the NPPES CSV into fields.
 *
 * The dissemination files quote every field and use "" for a literal quote, so a
 * hand-rolled splitter is safe here and is ~3x faster than building a 330-key
 * object per row, which matters a lot across ~9M rows.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Maps column name -> position, built from the header row. */
export type HeaderIndex = Map<string, number>;

export function buildHeaderIndex(headerLine: string): HeaderIndex {
  const index: Map<string, number> = new Map();
  splitCsvLine(headerLine).forEach((name, i) => {
    index.set(name.replace(/^﻿/, '').trim(), i);
  });
  return index;
}

export type StreamOptions = {
  /**
   * Cheap test run against the raw line before it is split. Returning false skips
   * the row entirely. Must never reject a row that would have matched — it is a
   * coarse pre-filter, the real check still runs on the parsed fields.
   */
  prefilter?: (line: string) => boolean;
  onRow: (fields: string[], index: HeaderIndex) => void;
  onProgress?: (p: { rowsRead: number; bytesRead: number }) => void;
  progressEvery?: number;
};

/** Streams a pipe-file line by line, yielding split rows to `onRow`. */
export async function streamNppesFile(filePath: string, opts: StreamOptions) {
  const { prefilter, onRow, onProgress, progressEvery = 250_000 } = opts;

  const readStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: readStream, crlfDelay: Infinity });

  let index: HeaderIndex | null = null;
  let rowsRead = 0;

  try {
    for await (const line of lines) {
      if (!index) {
        index = buildHeaderIndex(line);
        continue;
      }
      if (!line) continue;

      rowsRead++;
      if (onProgress && rowsRead % progressEvery === 0) {
        onProgress({ rowsRead, bytesRead: readStream.bytesRead });
      }

      if (prefilter && !prefilter(line)) continue;
      onRow(splitCsvLine(line), index);
    }
  } finally {
    lines.close();
    readStream.destroy();
  }

  return { rowsRead, index };
}

/** Reads a field by column name, returning '' when the column is absent. */
export function field(fields: string[], index: HeaderIndex, name: string): string {
  const i = index.get(name);
  return i === undefined ? '' : (fields[i] ?? '');
}

/** Legal suffixes that show up inconsistently on the same company's NPI records. */
const LEGAL_SUFFIXES = new Set([
  'INC', 'INCORPORATED', 'LLC', 'PLLC', 'LLP', 'LP', 'PC', 'PA', 'PSC',
  'LTD', 'LIMITED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'DBA', 'THE',
]);

/**
 * Collapses the spelling variants NPPES carries for one organization, so that
 * "IHC HEALTH SERVICES INC", "IHC HEALTH SERVICES, INC" and "IHC HEALTH SERVICES, INC."
 * are counted as the same company when detecting how many locations it runs.
 *
 * Only used for grouping — the original name is what gets displayed.
 */
export function normalizeOrgName(name: string): string {
  const s = name
    .toUpperCase()
    // Periods and apostrophes are dropped rather than spaced, so "P.C." and
    // "L.L.C." collapse to the same token as "PC" and "LLC".
    .replace(/[.']/g, '')
    .replace(/\s*&\s*/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip trailing legal suffixes repeatedly: "FOO MEDICAL GROUP, P.C., INC." -> "FOO MEDICAL GROUP"
  const tokens = s.split(' ');
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[0])) {
    tokens.shift();
  }

  return tokens.join(' ') || s;
}

/**
 * The stable identity of one practice location.
 *
 * Built from the normalised organisation name plus the address, so the same
 * practice produces the same key on every import even when NPPES spells the
 * company differently between runs. Imports upsert on this rather than deleting
 * and reinserting, which is what keeps contacts and outreach history alive.
 */
export function buildLeadKey(parts: {
  organization: string;
  address: string;
  city: string;
  state: string;
  zip: string;
}): string {
  const tidy = (value: string) =>
    value.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

  return [
    normalizeOrgName(parts.organization),
    tidy(parts.address),
    tidy(parts.city),
    parts.state.toUpperCase().trim(),
    parts.zip.trim().slice(0, 5),
  ].join('|');
}
