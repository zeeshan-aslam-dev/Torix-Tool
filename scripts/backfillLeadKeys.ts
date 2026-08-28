/**
 * One-time migration: gives every existing lead the stable `leadKey` that
 * imports now upsert on.
 *
 * Rows imported before the key existed have `leadKey = null`, which would make
 * the next import treat them as brand new and insert duplicates. Run this once
 * after upgrading:
 *
 *   npx tsx scripts/backfillLeadKeys.ts
 *
 * Safe to run repeatedly — it only touches rows that still have no key.
 */
import { PrismaClient } from '@prisma/client';
import { buildLeadKey } from '../lib/nppes';

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.lead.findMany({
    where: { leadKey: null },
    select: { id: true, organization: true, address: true, city: true, state: true, zip: true },
  });

  if (rows.length === 0) {
    console.log('Every lead already has a key — nothing to do.');
    return;
  }

  console.log(`Backfilling ${rows.length.toLocaleString()} leads...`);

  // Keys already in the table have to be respected too, or the unique index
  // rejects the update halfway through the run.
  const taken = new Set(
    (await prisma.lead.findMany({ where: { leadKey: { not: null } }, select: { leadKey: true } }))
      .map((r) => r.leadKey as string)
  );

  let written = 0;
  const duplicates: number[] = [];

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const updates = [];

    for (const row of chunk) {
      const key = buildLeadKey(row);
      if (taken.has(key)) {
        // Two rows describing the same location — a leftover from the old
        // delete-and-reinsert import. Collect rather than crash.
        duplicates.push(row.id);
        continue;
      }
      taken.add(key);
      updates.push(prisma.lead.update({ where: { id: row.id }, data: { leadKey: key } }));
    }

    await prisma.$transaction(updates);
    written += updates.length;
    process.stdout.write(`\r  ${written.toLocaleString()} / ${rows.length.toLocaleString()}`);
  }

  console.log(`\nKeyed ${written.toLocaleString()} leads.`);

  if (duplicates.length > 0) {
    console.log(
      `\n${duplicates.length.toLocaleString()} rows describe a location that already exists.\n` +
      `They were left unkeyed so you can review them:\n` +
      `  npx prisma studio   →  Lead  →  filter leadKey is null\n` +
      `Deleting them is usually right, but that is your call, not this script's.`
    );
  }

  const remaining = await prisma.lead.count({ where: { leadKey: null } });
  console.log(`Rows still without a key: ${remaining.toLocaleString()}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
