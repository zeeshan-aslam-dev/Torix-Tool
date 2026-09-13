/**
 * Dumps every table in prisma/dev.db into one Excel workbook, one sheet per
 * table, so the raw data can be opened/filtered outside the app. Run with:
 *   npm run export:excel
 */
import XLSX from 'xlsx';
import path from 'path';
import prisma from '../lib/prisma';

async function main() {
  const [leads, contacts, outreach, suppression, clients, logs] = await Promise.all([
    prisma.lead.findMany(),
    prisma.contact.findMany(),
    prisma.outreach.findMany(),
    prisma.suppression.findMany(),
    prisma.client.findMany(),
    prisma.responseLog.findMany(),
  ]);

  const workbook = XLSX.utils.book_new();
  const addSheet = (name: string, rows: Record<string, unknown>[]) => {
    const sheet = XLSX.utils.json_to_sheet(rows, { cellDates: true });
    XLSX.utils.book_append_sheet(workbook, sheet, name);
    console.log(`  ${name}: ${rows.length.toLocaleString()} rows`);
  };

  console.log('Reading tables...');
  addSheet('Leads', leads);
  addSheet('Contacts', contacts);
  addSheet('Outreach', outreach);
  addSheet('Suppression', suppression);
  addSheet('Clients', clients);
  addSheet('ResponseLog', logs);

  const outPath = path.join(process.cwd(), 'exports', `torix-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
  XLSX.writeFile(workbook, outPath);
  console.log(`\nWritten to ${outPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
