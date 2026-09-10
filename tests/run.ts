import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Runs every *.test.ts in this folder in its own process.
 *
 * Separate processes rather than one: the modules under test cache things at
 * module scope — the blocklist file, DNS answers — and a shared process would
 * let one file's state decide another file's result.
 */
const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort();

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file} ${'='.repeat(Math.max(0, 56 - file.length))}`);
  const result = spawnSync(
    process.execPath,
    [require.resolve('tsx/cli'), path.join(dir, file)],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) failed++;
}

console.log(`\n${files.length - failed}/${files.length} test files passed.`);
process.exit(failed === 0 ? 0 : 1);
