import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { ensureDataDir, dataRoots, formatBytes } from '../../../../lib/dataDir';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Lists the CSV files in every data root so the UI can pick one without uploading. */
export async function GET() {
  try {
    ensureDataDir();
    const roots = dataRoots();

    const files = roots
      .flatMap((dir) =>
        fs
          .readdirSync(dir)
          .filter((name) => ['.csv', '.txt'].includes(path.extname(name).toLowerCase()))
          // header-only companion files carry no records
          .filter((name) => !name.toLowerCase().endsWith('_fileheader.csv'))
          .map((name) => {
            const stat = fs.statSync(path.join(dir, name));
            return {
              name,
              dir,
              size: stat.size,
              sizeLabel: formatBytes(stat.size),
              modified: stat.mtime.toISOString(),
            };
          })
      )
      .sort((a, b) => b.size - a.size);

    return NextResponse.json({ dirs: roots, files });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
