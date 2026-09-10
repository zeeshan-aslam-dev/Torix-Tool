import { buildCsv, splitName, batchLabel, SendableLead } from '../lib/instantly';

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
}

// --- name splitting -------------------------------------------------------
check('two-part name', splitName('Jenny Mckay'), { firstName: 'Jenny', lastName: 'Mckay' });
check('three-part name keeps middle with first', splitName('Mary Jo Smith'), { firstName: 'Mary Jo', lastName: 'Smith' });
check('single name', splitName('Cher'), { firstName: 'Cher', lastName: '' });
check('empty name', splitName(null), { firstName: '', lastName: '' });

// --- CSV shape ------------------------------------------------------------
const lead = (over: Partial<SendableLead>): SendableLead => ({
  leadId: 1, leadKey: 'MCKAY FAMILY PRACTICE|123 MAIN ST|WEST JORDAN|UT|84088', email: 'info@clinic.com', firstName: 'Jenny', lastName: 'Mckay',
  companyName: 'MCKAY FAMILY PRACTICE', phone: '8012102445', title: 'Owner',
  website: 'https://clinic.com', linkedin: null, city: 'WEST JORDAN', state: 'UT',
  county: null, timezone: null, alternatePhone: null, webOwnerName: null, score: 85, ...over,
});

const csv = buildCsv([lead({})]);
const lines = csv.trim().split('\r\n');
check('header row', lines[0],
  '"Email","First Name","Last Name","Company Name","Phone","Title","Website","City","State","Lead Score","LinkedIn","Time Zone","County","Alternate Phone","Site-Stated Owner (if different from NPPES)"');
check('data row', lines[1],
  '"info@clinic.com","Jenny","Mckay","MCKAY FAMILY PRACTICE","8012102445","Owner","https://clinic.com","WEST JORDAN","UT","85","","","","",""');

// LinkedIn is appended, not inserted — a re-import must not shift every column
// after it into the wrong field just because this one is now populated.
const withLinkedin = buildCsv([lead({ linkedin: 'https://www.linkedin.com/company/mckay-family-practice' })]);
check('LinkedIn column sits where it was added, ahead of the newer columns',
  withLinkedin.trim().split('\r\n')[1],
  '"info@clinic.com","Jenny","Mckay","MCKAY FAMILY PRACTICE","8012102445","Owner","https://clinic.com","WEST JORDAN","UT","85","https://www.linkedin.com/company/mckay-family-practice","","","",""');

// Time zone, county, alternate phone and a site-stated owner name all land in
// their own columns, appended after LinkedIn for the same reason LinkedIn was
// appended after the original columns — never reorder what is already there.
const withNewFields = buildCsv([lead({
  county: 'Utah County', timezone: 'Mountain', alternatePhone: '8015550199', webOwnerName: 'Jenny McKay',
})]);
check('the geography, alternate-phone and owner-flag columns are last, in that order',
  withNewFields.trim().split('\r\n')[1],
  '"info@clinic.com","Jenny","Mckay","MCKAY FAMILY PRACTICE","8012102445","Owner","https://clinic.com","WEST JORDAN","UT","85","","Mountain","Utah County","8015550199","Jenny McKay"');
check('CRLF line endings', csv.includes('\r\n'), true);

// --- injection / quoting --------------------------------------------------
const nasty = buildCsv([lead({ companyName: 'SMITH, JONES & CO "THE CLINIC"', title: '=cmd|calc', phone: null })]);
check('comma and quotes escaped', nasty.includes('"SMITH, JONES & CO ""THE CLINIC"""'), true);
check('formula prefix neutralised', nasty.includes(`"'=cmd|calc"`), true);
check('null phone becomes empty cell', nasty.includes('"",'), true);

// --- empty input ----------------------------------------------------------
check('header only when no leads', buildCsv([]).trim().split('\r\n').length, 1);

// --- batch label ----------------------------------------------------------
check('batch label shape', batchLabel(new Date('2026-08-25T10:30:00Z')), 'export-20260825-103000');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
