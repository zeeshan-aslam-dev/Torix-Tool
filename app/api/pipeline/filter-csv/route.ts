import prisma from '../../../../lib/prisma';
import { normalizeOrgName } from '../../../../lib/nppes';
import {
  filterUploadedContactsCsv,
  parseContactsCsvText,
  csvRowMatchKey,
  CONTACTS_CSV_MAX_BRANCHES,
  CONTACTS_CSV_MAX_PROVIDERS,
  PracticeSize,
  CsvRecord,
} from '../../../../lib/contacts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Filters a previously exported contacts CSV to practices with ≤2 branches and
 * ≤15 NPPES providers. Size comes from the live Lead table (matched by NPI or
 * organization + city + state); Branches/Providers columns on the file are a
 * fallback when the DB has no match.
 */
export async function POST(req: Request) {
  try {
    const contentType = req.headers.get('content-type') || '';
    let csvText = '';
    let maxBranches = CONTACTS_CSV_MAX_BRANCHES;
    let maxProviders = CONTACTS_CSV_MAX_PROVIDERS;

    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return Response.json({ error: 'Upload a CSV file under the "file" field.' }, { status: 400 });
      }
      csvText = await file.text();
      const mb = Number(form.get('maxBranches'));
      const mp = Number(form.get('maxProviders'));
      if (Number.isFinite(mb) && mb >= 1) maxBranches = mb;
      if (Number.isFinite(mp) && mp >= 1) maxProviders = mp;
    } else {
      const body = await req.json().catch(() => ({} as { csv?: string; maxBranches?: number; maxProviders?: number }));
      csvText = typeof body.csv === 'string' ? body.csv : '';
      if (Number.isFinite(body.maxBranches) && Number(body.maxBranches) >= 1) {
        maxBranches = Number(body.maxBranches);
      }
      if (Number.isFinite(body.maxProviders) && Number(body.maxProviders) >= 1) {
        maxProviders = Number(body.maxProviders);
      }
    }

    if (!csvText.trim()) {
      return Response.json({ error: 'CSV is empty.' }, { status: 400 });
    }

    const { rows } = parseContactsCsvText(csvText);
    if (rows.length === 0) {
      return Response.json({ error: 'No data rows found in the CSV.' }, { status: 400 });
    }

    const lookup = await buildSizeLookup(rows);
    const result = filterUploadedContactsCsv(csvText, (row) => lookupSize(row, lookup), {
      maxBranches,
      maxProviders,
    });

    const filename = `filtered-contacts-${new Date().toISOString().slice(0, 10)}.csv`;

    return Response.json({
      csv: result.csv,
      filename,
      kept: result.kept,
      droppedOversize: result.droppedOversize,
      unmatched: result.unmatched,
      total: result.total,
      maxBranches,
      maxProviders,
      message:
        `Kept ${result.kept.toLocaleString()} of ${result.total.toLocaleString()} rows ` +
        `(≤${maxBranches} branches, ≤${maxProviders} providers)` +
        `${result.droppedOversize ? `; dropped ${result.droppedOversize.toLocaleString()} oversize` : ''}` +
        `${result.unmatched ? `; ${result.unmatched.toLocaleString()} unmatched in the database` : ''}.`,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

type SizeIndex = {
  byNpi: Map<string, PracticeSize>;
  byOrgCityState: Map<string, PracticeSize>;
};

async function buildSizeLookup(rows: CsvRecord[]): Promise<SizeIndex> {
  const npis = new Set<string>();
  const rawOrgs = new Set<string>();

  for (const row of rows) {
    const key = csvRowMatchKey(row);
    if (key.npi) npis.add(key.npi);
    const org = row['Organization'] || row['Company Name'] || row['Company'] || '';
    // Also try case variants from the normalised key itself.
    if (org.trim()) rawOrgs.add(org.trim());
  }

  const byNpi = new Map<string, PracticeSize>();
  const byOrgCityState = new Map<string, PracticeSize>();

  const indexLead = (lead: {
    npi: string | null;
    organization: string;
    city: string;
    state: string;
    n_locations_detected: number;
    n_providers_at_location: number;
  }) => {
    const size: PracticeSize = {
      npi: lead.npi,
      branches: lead.n_locations_detected ?? 1,
      providers: lead.n_providers_at_location ?? 0,
    };
    if (lead.npi) byNpi.set(lead.npi, size);
    const orgKey = normalizeOrgName(lead.organization);
    byOrgCityState.set(
      `${orgKey}|${(lead.city || '').toUpperCase()}|${(lead.state || '').toUpperCase()}`,
      size
    );
    if (!byOrgCityState.has(`${orgKey}||`)) {
      byOrgCityState.set(`${orgKey}||`, size);
    }
  };

  const select = {
    npi: true,
    organization: true,
    city: true,
    state: true,
    n_locations_detected: true,
    n_providers_at_location: true,
  } as const;

  const npiList = Array.from(npis);
  for (let i = 0; i < npiList.length; i += 400) {
    const found = await prisma.lead.findMany({
      where: { npi: { in: npiList.slice(i, i + 400) } },
      select,
    });
    for (const lead of found) indexLead(lead);
  }

  const orgList = Array.from(rawOrgs);
  for (let i = 0; i < orgList.length; i += 100) {
    const slice = orgList.slice(i, i + 100);
    const found = await prisma.lead.findMany({
      where: { organization: { in: slice } },
      select,
    });
    for (const lead of found) indexLead(lead);
  }

  return { byNpi, byOrgCityState };
}

function lookupSize(row: CsvRecord, index: SizeIndex): PracticeSize | null {
  const key = csvRowMatchKey(row);
  if (key.npi && index.byNpi.has(key.npi)) return index.byNpi.get(key.npi)!;

  const cityState = `${key.orgKey}|${key.city}|${key.state}`;
  if (key.orgKey && index.byOrgCityState.has(cityState)) {
    return index.byOrgCityState.get(cityState)!;
  }

  const orgOnly = `${key.orgKey}||`;
  if (key.orgKey && index.byOrgCityState.has(orgOnly)) {
    return index.byOrgCityState.get(orgOnly)!;
  }

  return null;
}
