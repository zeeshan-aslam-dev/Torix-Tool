import fs from 'fs';
import prisma from '../../../../lib/prisma';
import { resolveDataFile, findDataFileByPrefix, formatBytes } from '../../../../lib/dataDir';
import { streamNppesFile, field, normalizeOrgName, buildLeadKey, HeaderIndex } from '../../../../lib/nppes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

const TAXONOMY_COLS = Array.from({ length: 15 }, (_, i) => `Healthcare Provider Taxonomy Code_${i + 1}`);

const COL = {
  npi: 'NPI',
  entityType: 'Entity Type Code',
  orgName: 'Provider Organization Name (Legal Business Name)',
  lastName: 'Provider Last Name (Legal Name)',
  firstName: 'Provider First Name',
  address: 'Provider First Line Business Practice Location Address',
  city: 'Provider Business Practice Location Address City Name',
  state: 'Provider Business Practice Location Address State Name',
  zip: 'Provider Business Practice Location Address Postal Code',
  phone: 'Provider Business Practice Location Address Telephone Number',
  fax: 'Provider Business Practice Location Address Fax Number',
  aoLast: 'Authorized Official Last Name',
  aoFirst: 'Authorized Official First Name',
  aoTitle: 'Authorized Official Title or Position',
  aoPhone: 'Authorized Official Telephone Number',
  enumeration: 'Provider Enumeration Date',
  lastUpdate: 'Last Update Date',
  deactivation: 'NPI Deactivation Date',
  reactivation: 'NPI Reactivation Date',
  soleProprietor: 'Is Sole Proprietor',
  subpart: 'Is Organization Subpart',
  parentLbn: 'Parent Organization LBN',
};

/** NPPES writes dates as MM/DD/YYYY. */
function parseNppesDate(value: string): Date | null {
  const m = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  return Number.isNaN(d.getTime()) ? null : d;
}

type FilterRequest = {
  fileName?: string;
  states?: string;
  taxonomy?: string;
  /**
   * "merge" keeps every existing lead and updates it in place — the safe default.
   * "reset" deletes the selected states first, which also cascades away their
   * contacts and outreach history, so it is never chosen implicitly.
   */
  mode?: 'merge' | 'reset';
};

type Group = {
  organization: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  npi: string;
  taxonomy: string;
  providers: number;
  entityType: string;
  phone: string;
  fax: string;
  aoName: string;
  aoTitle: string;
  aoPhone: string;
  lastUpdate: Date | null;
  enumeration: Date | null;
  soleProprietor: string;
  subpart: string;
  parentLbn: string;
};

/**
 * Streams a raw NPPES CSV straight off disk, keeps rows matching the target states
 * and taxonomy codes, groups them into one Lead per practice location, and writes
 * them to the DB. Responds with an NDJSON progress stream so the UI can show live
 * logs while an 11GB file is being chewed through.
 */
export async function POST(req: Request) {
  let body: FilterRequest;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid request body', 400);
  }

  const fileName: string = body?.fileName ?? '';
  const statesParam: string = body?.states ?? '';
  const taxonomyParam: string = body?.taxonomy ?? '';
  const mode: 'merge' | 'reset' = body?.mode === 'reset' ? 'reset' : 'merge';

  const filePath = resolveDataFile(fileName);
  if (!filePath) {
    return jsonError(`File not found in the data folders: ${fileName || '(none selected)'}`, 400);
  }

  const stateList = statesParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const taxonomyList = taxonomyParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);

  if (stateList.length === 0) return jsonError('At least one target state is required', 400);
  if (taxonomyList.length === 0) return jsonError('At least one taxonomy code is required', 400);

  const states = new Set(stateList);
  const taxonomyCodes = new Set(taxonomyList);

  // Coarse pre-filter: a matching row must contain the quoted state code somewhere on
  // the line, so lines without it can be skipped before the ~330-field split. Other
  // columns (license state, mailing state) cause false positives, which the real
  // check below discards — false negatives are impossible.
  const statePatterns = stateList.map((s) => `"${s}"`);
  const prefilter = (line: string) => statePatterns.some((p) => line.includes(p));

  const encoder = new TextEncoder();
  const totalBytes = fs.statSync(filePath).size;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };

      try {
        const startedAt = Date.now();
        send({
          type: 'log',
          message: `Reading ${fileName} (${formatBytes(totalBytes)}) from disk — no upload needed.`,
        });

        const groups = new Map<string, Group>();
        const orgLocations = new Map<string, Set<string>>();
        let matched = 0;
        let skippedInactive = 0;

        const onRow = (fields: string[], index: HeaderIndex) => {
          const state = field(fields, index, COL.state).trim().toUpperCase();
          if (!states.has(state)) return;

          let matchedTaxonomy = '';
          for (const col of TAXONOMY_COLS) {
            const tax = field(fields, index, col).trim().toUpperCase();
            if (tax && taxonomyCodes.has(tax)) {
              matchedTaxonomy = tax;
              break;
            }
          }
          if (!matchedTaxonomy) return;

          // Deactivated NPIs are dead leads unless they were reactivated later.
          if (field(fields, index, COL.deactivation).trim() && !field(fields, index, COL.reactivation).trim()) {
            skippedInactive++;
            return;
          }

          matched++;

          const entityType = field(fields, index, COL.entityType).trim();
          const organization =
            field(fields, index, COL.orgName).trim() ||
            [field(fields, index, COL.lastName), field(fields, index, COL.firstName)]
              .filter(Boolean)
              .join(', ')
              .trim() ||
            'Unknown';
          const address = field(fields, index, COL.address).trim();
          const city = field(fields, index, COL.city).trim();
          const zip = field(fields, index, COL.zip).trim().slice(0, 5);
          const aoLast = field(fields, index, COL.aoLast).trim();
          const aoFirst = field(fields, index, COL.aoFirst).trim();

          const row: Group = {
            organization,
            address,
            city,
            state,
            zip,
            npi: field(fields, index, COL.npi).trim(),
            taxonomy: matchedTaxonomy,
            providers: 1,
            entityType,
            phone: field(fields, index, COL.phone).trim(),
            fax: field(fields, index, COL.fax).trim(),
            aoName: [aoFirst, aoLast].filter(Boolean).join(' '),
            aoTitle: field(fields, index, COL.aoTitle).trim(),
            aoPhone: field(fields, index, COL.aoPhone).trim(),
            lastUpdate: parseNppesDate(field(fields, index, COL.lastUpdate)),
            enumeration: parseNppesDate(field(fields, index, COL.enumeration)),
            soleProprietor: field(fields, index, COL.soleProprietor).trim(),
            subpart: field(fields, index, COL.subpart).trim(),
            parentLbn: field(fields, index, COL.parentLbn).trim(),
          };

          // Group on the normalized name so the same company spelled three
          // different ways lands in one location, and one location count.
          const orgKey = normalizeOrgName(organization);
          const key = `${orgKey}|${address}|${city}|${state}|${zip}`.toUpperCase();
          const existing = groups.get(key);

          if (!existing) {
            groups.set(key, row);
          } else {
            existing.providers++;
            mergeGroup(existing, row);
          }

          let locs = orgLocations.get(orgKey);
          if (!locs) {
            locs = new Set();
            orgLocations.set(orgKey, locs);
          }
          locs.add(key);
        };

        const { rowsRead } = await streamNppesFile(filePath, {
          prefilter,
          onRow,
          onProgress: ({ rowsRead, bytesRead }) => {
            send({
              type: 'progress',
              rowsRead,
              matched,
              locations: groups.size,
              bytesRead,
              percent: totalBytes ? Math.min(99, (bytesRead / totalBytes) * 100) : 0,
              elapsedMs: Date.now() - startedAt,
            });
          },
        });

        send({
          type: 'log',
          message:
            `Scanned ${rowsRead.toLocaleString()} rows in ${((Date.now() - startedAt) / 1000).toFixed(0)}s — ` +
            `${matched.toLocaleString()} matching providers across ${groups.size.toLocaleString()} locations` +
            (skippedInactive ? ` (${skippedInactive.toLocaleString()} deactivated NPIs skipped).` : '.'),
        });

        if (mode === 'reset') {
          const doomed = await prisma.lead.count({ where: { state: { in: stateList } } });
          const contacts = await prisma.contact.count({ where: { lead: { state: { in: stateList } } } });
          const outreach = await prisma.outreach.count({ where: { lead: { state: { in: stateList } } } });
          await prisma.lead.deleteMany({ where: { state: { in: stateList } } });
          send({
            type: 'log',
            message:
              `RESET: removed ${doomed.toLocaleString()} leads for ${stateList.join(', ')}, ` +
              `along with ${contacts.toLocaleString()} contacts and ${outreach.toLocaleString()} outreach records. ` +
              `The suppression list is untouched, so nothing already mailed can be mailed twice.`,
          });
        }

        // Trade names live in a separate 48MB pipe-file. They are what a practice
        // actually calls itself, so they drive Step 3's website candidates.
        const dbaByNpi = await loadTradeNames(
          new Set(Array.from(groups.values()).map((g) => g.npi).filter(Boolean)),
          send
        );

        const rows = Array.from(groups.values()).map((g) => ({
          leadKey: buildLeadKey(g),
          organization: g.organization,
          address: g.address,
          city: g.city,
          state: g.state,
          zip: g.zip,
          npi: g.npi,
          taxonomy: g.taxonomy,
          n_providers_at_location: g.providers,
          n_locations_detected: orgLocations.get(normalizeOrgName(g.organization))?.size ?? 1,
          entityType: g.entityType || null,
          phone: g.phone || null,
          fax: g.fax || null,
          authorizedOfficialName: g.aoName || null,
          authorizedOfficialTitle: g.aoTitle || null,
          authorizedOfficialPhone: g.aoPhone || null,
          lastUpdateDate: g.lastUpdate,
          enumerationDate: g.enumeration,
          isSoleProprietor: g.soleProprietor || null,
          isOrganizationSubpart: g.subpart || null,
          parentOrganizationLbn: g.parentLbn || null,
          dbaNames: dbaByNpi.get(g.npi)?.join('|') || null,
        }));

        // Split on what the database already knows, so new practices are bulk
        // inserted and known ones are updated in place. Scores, websites, contacts
        // and outreach history all survive a re-import this way.
        const existing = new Map<string, number>();
        const KEY_CHUNK = 900;
        const allKeys = rows.map((r) => r.leadKey);
        for (let i = 0; i < allKeys.length; i += KEY_CHUNK) {
          const found = await prisma.lead.findMany({
            where: { leadKey: { in: allKeys.slice(i, i + KEY_CHUNK) } },
            select: { id: true, leadKey: true },
          });
          for (const row of found) if (row.leadKey) existing.set(row.leadKey, row.id);
        }

        const fresh = rows.filter((r) => !existing.has(r.leadKey));
        const known = rows.filter((r) => existing.has(r.leadKey));

        const CHUNK = 500;
        let inserted = 0;
        let updated = 0;

        for (let i = 0; i < fresh.length; i += CHUNK) {
          const chunk = fresh.slice(i, i + CHUNK);
          await prisma.lead.createMany({ data: chunk });
          inserted += chunk.length;
          send({ type: 'progress', stage: 'insert', inserted, updated, total: rows.length });
        }

        for (let i = 0; i < known.length; i += CHUNK) {
          const chunk = known.slice(i, i + CHUNK);
          await prisma.$transaction(
            chunk.map((row) =>
              prisma.lead.update({
                where: { id: existing.get(row.leadKey) },
                // Only the NPPES-sourced fields are refreshed. tag, score, reason,
                // website_found and search_snippet are left alone — they are the
                // work of later steps, not of this file.
                data: {
                  organization: row.organization,
                  npi: row.npi,
                  taxonomy: row.taxonomy,
                  n_providers_at_location: row.n_providers_at_location,
                  n_locations_detected: row.n_locations_detected,
                  entityType: row.entityType,
                  phone: row.phone,
                  fax: row.fax,
                  authorizedOfficialName: row.authorizedOfficialName,
                  authorizedOfficialTitle: row.authorizedOfficialTitle,
                  authorizedOfficialPhone: row.authorizedOfficialPhone,
                  lastUpdateDate: row.lastUpdateDate,
                  enumerationDate: row.enumerationDate,
                  isSoleProprietor: row.isSoleProprietor,
                  isOrganizationSubpart: row.isOrganizationSubpart,
                  parentOrganizationLbn: row.parentOrganizationLbn,
                  dbaNames: row.dbaNames,
                },
              })
            )
          );
          updated += chunk.length;
          send({ type: 'progress', stage: 'insert', inserted, updated, total: rows.length });
        }

        const withContact = rows.filter((r) => r.authorizedOfficialName).length;
        send({
          type: 'done',
          rowsRead,
          matched,
          locations: groups.size,
          inserted,
          updated,
          withContact,
          elapsedMs: Date.now() - startedAt,
          message:
            `${inserted.toLocaleString()} new, ${updated.toLocaleString()} updated in ` +
            `${((Date.now() - startedAt) / 1000).toFixed(0)}s ` +
            `(${withContact.toLocaleString()} with a named contact). Ready for scoring.`,
        });
      } catch (error) {
        send({ type: 'error', message: errorMessage(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}

/**
 * Several NPI rows can share one practice location — typically the organization
 * plus the individual providers working there. The organization row carries the
 * authorized official and ownership flags, so let it win, and otherwise just fill
 * in whatever the earlier row left blank.
 */
function mergeGroup(target: Group, incoming: Group) {
  const incomingIsOrg = incoming.entityType === '2';
  const targetIsOrg = target.entityType === '2';

  if (incomingIsOrg && !targetIsOrg) {
    target.entityType = incoming.entityType;
    target.aoName = incoming.aoName;
    target.aoTitle = incoming.aoTitle;
    target.aoPhone = incoming.aoPhone;
    target.subpart = incoming.subpart;
    target.parentLbn = incoming.parentLbn;
    target.npi = incoming.npi;
  }

  target.phone = target.phone || incoming.phone;
  target.fax = target.fax || incoming.fax;
  target.aoName = target.aoName || incoming.aoName;
  target.aoTitle = target.aoTitle || incoming.aoTitle;
  target.aoPhone = target.aoPhone || incoming.aoPhone;
  target.soleProprietor = target.soleProprietor || incoming.soleProprietor;
  target.subpart = target.subpart || incoming.subpart;
  target.parentLbn = target.parentLbn || incoming.parentLbn;

  // Freshest signal wins — one active provider keeps the location alive.
  if (incoming.lastUpdate && (!target.lastUpdate || incoming.lastUpdate > target.lastUpdate)) {
    target.lastUpdate = incoming.lastUpdate;
  }
  if (incoming.enumeration && (!target.enumeration || incoming.enumeration < target.enumeration)) {
    target.enumeration = incoming.enumeration;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads othername_pfile for the NPIs we kept, returning NPI -> trade names.
 * Silently returns an empty map when the companion file is not present.
 */
async function loadTradeNames(
  npis: Set<string>,
  send: (event: Record<string, unknown>) => void
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const file = findDataFileByPrefix('othername_pfile');

  if (!file) {
    send({ type: 'log', message: 'No othername_pfile found — skipping trade names.' });
    return result;
  }

  let rows = 0;
  await streamNppesFile(file, {
    prefilter: (line) => {
      const npi = line.slice(1, 11);
      return npis.has(npi);
    },
    onRow: (fields, index) => {
      const npi = field(fields, index, 'NPI').trim();
      if (!npis.has(npi)) return;
      const name = field(fields, index, 'Provider Other Organization Name').trim();
      if (!name) return;
      const list = result.get(npi) ?? [];
      if (!list.includes(name)) {
        list.push(name);
        result.set(npi, list);
      }
      rows++;
    },
    progressEvery: 500_000,
  });

  send({
    type: 'log',
    message: `Loaded ${rows.toLocaleString()} trade names for ${result.size.toLocaleString()} leads.`,
  });
  return result;
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
