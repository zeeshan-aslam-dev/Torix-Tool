import prisma from '../../../../lib/prisma';
import { normalizeOrgName } from '../../../../lib/nppes';
import {
  filterUploadedContactsCsv,
  parseContactsCsvText,
  csvRowMatchKey,
  buildDialerCsvFromRecords,
  CONTACTS_CSV_MAX_BRANCHES,
  CONTACTS_CSV_MAX_PROVIDERS,
  PracticeSize,
  CsvRecord,
} from '../../../../lib/contacts';
import {
  aiProviderConfigured,
  lookupProviderCountWithAi,
  mapProviderCountLookups,
  activeAiBackendLabel,
  resolveAiKeyBundle,
  AiKeyRotator,
  parseKeysField,
  AiKeyBundle,
} from '../../../../lib/geminiProviders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

function readKeyBundleFromForm(form: FormData): Partial<AiKeyBundle> {
  return {
    openrouter: parseKeysField(form.get('openrouterKeys')),
    groq: parseKeysField(form.get('groqKeys')),
    gemini: parseKeysField(form.get('geminiKeys')),
  };
}

/**
 * Edits a previously exported contacts CSV into dialer column order.
 * Optional AI pass refreshes Providers; multiple keys per platform rotate on 429.
 * Streams NDJSON with real-time progress.
 */
export async function POST(req: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };

      try {
    const contentType = req.headers.get('content-type') || '';
    let csvText = '';
    let maxBranches = CONTACTS_CSV_MAX_BRANCHES;
    let maxProviders = CONTACTS_CSV_MAX_PROVIDERS;
    let useAiProviders = false;
    let clientKeys: Partial<AiKeyBundle> = {};
    let keysFromUi = false;
    let aiRowStart = 0; // 0 = no lower bound
    let aiRowEnd = 0; // 0 = no upper bound

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
      const ai = form.get('useAiProviders') ?? form.get('useGeminiProviders');
      useAiProviders = ai === 'true' || ai === '1' || ai === 'on';
      const rs = Number(form.get('aiRowStart'));
      const re = Number(form.get('aiRowEnd'));
      if (Number.isFinite(rs) && rs >= 1) aiRowStart = Math.floor(rs);
      if (Number.isFinite(re) && re >= 1) aiRowEnd = Math.floor(re);
      // If the modal sent key fields, use ONLY those (do not pull Gemini/etc from .env).
      keysFromUi =
        form.has('openrouterKeys') || form.has('groqKeys') || form.has('geminiKeys');
      clientKeys = readKeyBundleFromForm(form);
    } else {
      const body = await req.json().catch(
        () =>
          ({} as {
            csv?: string;
            maxBranches?: number;
            maxProviders?: number;
            useAiProviders?: boolean;
            useGeminiProviders?: boolean;
            aiRowStart?: number;
            aiRowEnd?: number;
            openrouterKeys?: string[] | string;
            groqKeys?: string[] | string;
            geminiKeys?: string[] | string;
          })
      );
      csvText = typeof body.csv === 'string' ? body.csv : '';
      if (Number.isFinite(body.maxBranches) && Number(body.maxBranches) >= 1) {
        maxBranches = Number(body.maxBranches);
      }
      if (Number.isFinite(body.maxProviders) && Number(body.maxProviders) >= 1) {
        maxProviders = Number(body.maxProviders);
      }
      useAiProviders = Boolean(body.useAiProviders ?? body.useGeminiProviders);
      if (Number.isFinite(body.aiRowStart) && Number(body.aiRowStart) >= 1) {
        aiRowStart = Math.floor(Number(body.aiRowStart));
      }
      if (Number.isFinite(body.aiRowEnd) && Number(body.aiRowEnd) >= 1) {
        aiRowEnd = Math.floor(Number(body.aiRowEnd));
      }
      keysFromUi =
        body.openrouterKeys !== undefined ||
        body.groqKeys !== undefined ||
        body.geminiKeys !== undefined;
      clientKeys = {
        openrouter: parseKeysField(body.openrouterKeys),
        groq: parseKeysField(body.groqKeys),
        gemini: parseKeysField(body.geminiKeys),
      };
    }

    if (!csvText.trim()) {
      send({ type: 'error', message: 'CSV is empty.' });
      controller.close();
      return;
    }

    const { rows } = parseContactsCsvText(csvText);
    if (rows.length === 0) {
      send({ type: 'error', message: 'No data rows found in the CSV.' });
      controller.close();
      return;
    }

    send({ type: 'log', message: `Filtering by size (≤${maxBranches} branches, ≤${maxProviders} providers)...` });

    const lookup = await buildSizeLookup(rows);
    const result = filterUploadedContactsCsv(csvText, (row) => lookupSize(row, lookup), {
      maxBranches,
      maxProviders,
    });

    let aiUpdated = 0;
    let aiSkipped = 0;
    let aiFailed = 0;
    let aiEligibleTotal = 0;
    const finalRows = result.rows;
    const failReasons = new Map<string, number>();
    const keyBundle = resolveAiKeyBundle(clientKeys, { clientOnly: keysFromUi });
    const backendLabel = activeAiBackendLabel(keyBundle);
    let rotator: AiKeyRotator | null = null;

    send({ type: 'log', message: `Kept ${result.kept} of ${result.total} rows.` });

    if (useAiProviders) {
      if (!aiProviderConfigured(keyBundle)) {
        send({ type: 'error', message: 'AI provider refresh requested but no API keys were provided.' });
        controller.close();
        return;
      }

      rotator = new AiKeyRotator(keyBundle);
      const started = Date.now();
      // nginx proxy_read_timeout is 3600s — finish with JSON before that.
      const aiDeadlineMs = Date.now() + 58 * 60 * 1000;
      let aiTimedOut = false;
      // Parallelism = number of keys, uncapped — batches are now sized manually
      // via the row-range inputs, so there's no need to throttle concurrency here.
      const keyCount =
        keyBundle.openrouter.length + keyBundle.groq.length + keyBundle.gemini.length;
      const concurrency = Math.max(1, keyCount);

      const eligibleRows = finalRows.filter((row) => {
        const org = row['Practice_Name'] || '';
        const website = (row['Website'] || '').trim();
        if (!org || !website) {
          aiSkipped++;
          return false;
        }
        return true;
      });
      aiEligibleTotal = eligibleRows.length;

      // 1-indexed inclusive range over eligibleRows, so re-uploading the same
      // downloaded CSV with a different row range (and a fresh key) picks up
      // where the last batch left off — e.g. 1-130 then 131-260.
      const rangeStart = aiRowStart >= 1 ? aiRowStart : 1;
      const rangeEnd = aiRowEnd >= 1 ? Math.min(aiRowEnd, eligibleRows.length) : eligibleRows.length;
      const workRows =
        rangeStart <= rangeEnd
          ? eligibleRows.slice(rangeStart - 1, rangeEnd)
          : [];
      const outOfRangeCount = eligibleRows.length - workRows.length;
      if (outOfRangeCount > 0) aiSkipped += outOfRangeCount;

      send({ type: 'log', message: `Starting AI provider refresh on rows ${rangeStart}-${rangeEnd} (${workRows.length} rows)...` });

      let rowIndex = 0;
      await mapProviderCountLookups(workRows, concurrency, async (row) => {
        rowIndex++;
        if (Date.now() >= aiDeadlineMs) {
          aiTimedOut = true;
          aiFailed++;
          failReasons.set('AI pass hit time budget — partial Providers in download', 1);
          return;
        }
        if (aiTimedOut) return;

        const looked = await lookupProviderCountWithAi(
          {
            organization: (row['Practice_Name'] || '').split(' / ')[0].trim(),
            city: row['City'],
            state: row['State'],
            website: (row['Website'] || '').trim(),
            gbpWebsite: null,
          },
          fetch,
          rotator!
        );
        if (looked.providerCount != null) {
          row['Providers'] = String(looked.providerCount);
          aiUpdated++;
        } else {
          aiFailed++;
          const reason = (looked.evidence || 'unknown').slice(0, 120);
          failReasons.set(reason, (failReasons.get(reason) || 0) + 1);
        }
        // Progress update every 5 rows or at the end
        if (rowIndex % 5 === 0 || rowIndex === workRows.length) {
          send({
            type: 'progress',
            current: rowIndex,
            total: workRows.length,
            updated: aiUpdated,
            failed: aiFailed,
            message: `Row ${rowIndex}/${workRows.length} — updated ${aiUpdated}, failed ${aiFailed}`,
          });
        }
      });

      if (aiTimedOut) {
        failReasons.set(
          `AI pass stopped early after ${Math.round((Date.now() - started) / 1000)}s to avoid proxy timeout — download has partial Providers`,
          1
        );
      }
    }

    const csv = buildDialerCsvFromRecords(finalRows);
    const filename = `filtered-contacts-${new Date().toISOString().slice(0, 10)}.csv`;

    const topFails = Array.from(failReasons.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, n]) => `${n}× ${reason}`)
      .join('; ');

    const rotNote = rotator ? `; ${rotator.summary()}` : '';
    const rangeNote = useAiProviders
      ? ` (AI rows ${aiRowStart || 1}-${aiRowEnd || aiEligibleTotal || '∞'} of ${aiEligibleTotal} eligible)`
      : '';
    const aiNote = useAiProviders
      ? `; ${backendLabel} providers — updated ${aiUpdated}, unchanged ${aiFailed}, skipped ${aiSkipped}` +
        rangeNote +
        rotNote +
        (topFails ? ` (sample fails: ${topFails})` : '')
      : '';

    const message =
      `Kept ${result.kept.toLocaleString()} of ${result.total.toLocaleString()} rows ` +
      `(≤${maxBranches} branches, ≤${maxProviders} providers); ` +
      `dialer columns (NPI…PKT_Call_Window) with taxonomy / ZIP from NPPES` +
      `${result.droppedOversize ? `; dropped ${result.droppedOversize.toLocaleString()} oversize` : ''}` +
      `${result.unmatched ? `; ${result.unmatched.toLocaleString()} unmatched in the database` : ''}` +
      aiNote +
      '.';

    send({
      type: 'done',
      csv,
      filename,
      kept: result.kept,
      droppedOversize: result.droppedOversize,
      unmatched: result.unmatched,
      total: result.total,
      maxBranches,
      maxProviders,
      aiUpdated,
      aiFailed,
      aiSkipped,
      aiEligibleTotal,
      aiRowStart: aiRowStart || 1,
      aiRowEnd: aiRowEnd || aiEligibleTotal,
      keyRotations: rotator?.rotations ?? 0,
      message,
    });
    controller.close();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      send({ type: 'error', message: msg });
      controller.close();
    }
  },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    },
  });
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
    const org =
      row['Practice_Name'] ||
      row['Organization'] ||
      row['Company Name'] ||
      row['Company'] ||
      '';
    if (org.trim()) {
      // Merged names may be "A / B" — look up each part.
      for (const part of org.split(' / ')) {
        if (part.trim()) rawOrgs.add(part.trim());
      }
    }
  }

  const byNpi = new Map<string, PracticeSize>();
  const byOrgCityState = new Map<string, PracticeSize>();

  const indexLead = (lead: {
    npi: string | null;
    organization: string;
    address: string;
    city: string;
    state: string;
    zip: string;
    taxonomy: string | null;
    authorizedOfficialTitle: string | null;
    authorizedOfficialName: string | null;
    enumerationDate: Date | null;
    timezone: string | null;
    website_found: string | null;
    gbpWebsite: string | null;
    n_locations_detected: number;
    n_providers_at_location: number;
  }) => {
    const size: PracticeSize = {
      npi: lead.npi,
      branches: lead.n_locations_detected ?? 1,
      providers: lead.n_providers_at_location ?? 0,
      taxonomy: lead.taxonomy,
      decisionMakerTitle: lead.authorizedOfficialTitle,
      decisionMakerName: lead.authorizedOfficialName,
      address: lead.address,
      zip: lead.zip,
      enumerationDate: lead.enumerationDate
        ? lead.enumerationDate.toISOString().slice(0, 10)
        : null,
      timezone: lead.timezone,
      website: lead.website_found,
      gbpWebsite: lead.gbpWebsite,
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
    address: true,
    city: true,
    state: true,
    zip: true,
    taxonomy: true,
    authorizedOfficialTitle: true,
    authorizedOfficialName: true,
    enumerationDate: true,
    timezone: true,
    website_found: true,
    gbpWebsite: true,
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

  // Merged Practice_Name "A / B" — try each part.
  const practice = row['Practice_Name'] || row['Organization'] || '';
  for (const part of practice.split(' / ')) {
    const orgKey = normalizeOrgName(part.trim());
    if (!orgKey) continue;
    const cityState = `${orgKey}|${key.city}|${key.state}`;
    if (index.byOrgCityState.has(cityState)) return index.byOrgCityState.get(cityState)!;
    const orgOnly = `${orgKey}||`;
    if (index.byOrgCityState.has(orgOnly)) return index.byOrgCityState.get(orgOnly)!;
  }

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
