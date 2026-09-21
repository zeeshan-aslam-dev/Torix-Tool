import {
  finalizeContactsCsvRows,
  buildContactsCsv,
  phonesAreSame,
  digitsPhone,
  ContactExportRow,
  CONTACTS_CSV_MAX_BRANCHES,
  CONTACTS_CSV_MAX_PROVIDERS,
  filterUploadedContactsCsv,
  parseContactsCsvText,
  splitCsvLine,
} from '../lib/contacts';

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
}

function row(partial: Partial<ContactExportRow> & { organization: string }): ContactExportRow {
  return {
    organization: partial.organization,
    npi: '1234567890',
    city: 'PROVO',
    state: 'UT',
    zip: '84000',
    nLocations: 1,
    nProviders: 3,
    practicePhone: '8011111111',
    decisionMakerName: 'Jane Doe',
    decisionMakerTitle: 'Owner',
    decisionMakerPhone: '8012222222',
    email: null,
    emailConfidence: null,
    emailVerifyStatus: null,
    sendable: false,
    website: null,
    linkedin: null,
    webOwnerName: null,
    score: 70,
    tag: 'HOT',
    ...partial,
  };
}

check('digitsPhone keeps last 10', digitsPhone('+1 (801) 350-4111'), '8013504111');
check('phonesAreSame ignores formatting', phonesAreSame('801-350-4111', '(801) 350 4111'), true);
check('phonesAreSame detects different', phonesAreSame('8013504111', '8014637415'), false);

const dupPhone = finalizeContactsCsvRows([
  row({ organization: 'SAME PHONE LLC', practicePhone: '8013504111', decisionMakerPhone: '8013504111' }),
  row({ organization: 'DIFF PHONE LLC', practicePhone: '8013504111', decisionMakerPhone: '8014637415' }),
]);
check('drops same practice and DM phone', dupPhone.map((r) => r.organization), ['DIFF PHONE LLC']);

const missingAo = finalizeContactsCsvRows([
  row({ organization: 'NO AO PHONE', practicePhone: '8013504111', decisionMakerPhone: null }),
]);
check('drops missing decision-maker phone', missingAo.length, 0);

const branches = finalizeContactsCsvRows([
  row({ organization: 'FOOT CLINIC INC', city: 'BRIGHAM CITY', zip: '84302', nLocations: 2, score: 80, decisionMakerPhone: '4358814494' }),
  row({ organization: 'FOOT CLINIC INC', city: 'LOGAN', zip: '84321', nLocations: 2, score: 85, decisionMakerPhone: '4358814494' }),
  row({ organization: 'FOOT CLINIC, INC.', city: 'LOGAN', zip: '84321', nLocations: 2, score: 70, decisionMakerPhone: '4358814494' }),
]);
check('one row per org after normalize', branches.length, 1);
check('keeps highest-score main office', branches[0].city, 'LOGAN');
check('stamps branch count', branches[0].branchCount, 2);

const chain = finalizeContactsCsvRows([
  row({ organization: 'BIG CHAIN PC', city: 'A', zip: '1', nLocations: 7, decisionMakerPhone: '8019990001' }),
  row({ organization: 'BIG CHAIN PC', city: 'B', zip: '2', nLocations: 7, decisionMakerPhone: '8019990001' }),
]);
check('drops orgs above max branches', chain.length, 0);
check('max branches constant is 2', CONTACTS_CSV_MAX_BRANCHES, 2);
check('max providers constant is 15', CONTACTS_CSV_MAX_PROVIDERS, 15);

const tooManyProviders = finalizeContactsCsvRows([
  row({ organization: 'BIG STAFF PC', nProviders: 16, decisionMakerPhone: '8019990002' }),
]);
check('drops sites above max providers', tooManyProviders.length, 0);

const atProviderCap = finalizeContactsCsvRows([
  row({ organization: 'FIFTEEN DOCS PC', nProviders: 15, decisionMakerPhone: '8019990003' }),
]);
check('keeps sites at exactly 15 providers', atProviderCap.length, 1);

const csv = buildContactsCsv([
  row({ organization: 'KEEP ME', city: 'PROVO', zip: '84601', npi: '1999999999', practicePhone: '8011110000', decisionMakerPhone: '8012220000', score: 90 }),
]);
check('CSV has NPI column', csv.includes('NPI'), true);
check('CSV has Branches column', csv.includes('Branches'), true);
check('CSV has Providers column', csv.includes('Providers'), true);
check('CSV has ZIP column', csv.includes('ZIP'), true);
check('CSV includes NPI value', csv.includes('1999999999'), true);
check('CSV includes zip value', csv.includes('84601'), true);

check('splitCsvLine respects quotes', splitCsvLine('"A, B","C"'), ['A, B', 'C']);

const uploaded = [
  '"Organization","City","State","Branches","Providers"',
  '"SMALL CLINIC","PROVO","UT","1","4"',
  '"CHAIN CLINIC","OREM","UT","5","3"',
  '"STAFF HEAVY","LEHI","UT","1","20"',
].join('\r\n');

const filtered = filterUploadedContactsCsv(uploaded, () => null);
check('upload filter keeps small clinic from CSV columns', filtered.kept, 1);
check('upload filter drops oversize from CSV columns', filtered.droppedOversize, 2);
check('upload filter output includes NPI header', filtered.csv.includes('NPI'), true);
check('upload filter keeps SMALL CLINIC row', filtered.csv.includes('SMALL CLINIC'), true);
check('upload filter drops CHAIN CLINIC', filtered.csv.includes('CHAIN CLINIC'), false);

const withLookup = filterUploadedContactsCsv(
  '"Organization","City","State"\r\n"LOOKUP ME","PROVO","UT"\r\n',
  (r) => (r.Organization === 'LOOKUP ME'
    ? { npi: '1112223333', branches: 1, providers: 2 }
    : null)
);
check('upload filter enriches from lookup', withLookup.kept, 1);
check('upload filter writes NPI from lookup', withLookup.csv.includes('1112223333'), true);

const parsed = parseContactsCsvText(uploaded);
check('parseContactsCsvText row count', parsed.rows.length, 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
