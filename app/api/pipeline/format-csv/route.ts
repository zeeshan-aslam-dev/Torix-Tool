import { formatUploadedContactsCsv } from '../../../../lib/contacts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Format-only: dialer column order + field aliases. Does not size-filter or call AI.
 */
export async function POST(req: Request) {
  try {
    const contentType = req.headers.get('content-type') || '';
    let csvText = '';
    let merge = true;

    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return Response.json({ error: 'Upload a CSV file under the "file" field.' }, { status: 400 });
      }
      csvText = await file.text();
      const m = form.get('merge');
      if (m === 'false' || m === '0') merge = false;
    } else {
      const body = await req.json().catch(() => ({} as { csv?: string; merge?: boolean }));
      csvText = typeof body.csv === 'string' ? body.csv : '';
      if (body.merge === false) merge = false;
    }

    if (!csvText.trim()) {
      return Response.json({ error: 'CSV is empty.' }, { status: 400 });
    }

    const result = formatUploadedContactsCsv(csvText, { merge });
    if (result.total === 0) {
      return Response.json({ error: 'No data rows found in the CSV.' }, { status: 400 });
    }

    const filename = `dialer-format-${new Date().toISOString().slice(0, 10)}.csv`;
    return Response.json({
      csv: result.csv,
      filename,
      total: result.total,
      kept: result.kept,
      mergedAway: result.mergedAway,
      message:
        `Formatted ${result.kept.toLocaleString()} of ${result.total.toLocaleString()} rows ` +
        `into dialer column order (NPI → Practice_Name → … → PKT_Call_Window)` +
        (result.mergedAway
          ? `; merged ${result.mergedAway.toLocaleString()} duplicate org/owner rows`
          : '') +
        '.',
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
