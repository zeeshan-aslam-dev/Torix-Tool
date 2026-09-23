import {
  finalizeContactsCsvRows,
  buildContactsCsv,
  phonesAreSame,
  digitsPhone,
  ContactExportRow,
  CONTACTS_CSV_MAX_BRANCHES,
  CONTACTS_CSV_MAX_PROVIDERS,
  filterUploadedContactsCsv,
  formatUploadedContactsCsv,
  parseContactsCsvText,
  splitCsvLine,
  normalizeDecisionMakerTitle,
  taxonomySpecialtyLabel,
  formatTaxonomyCell,
  pktCallWindow,
  reorderCsvHeaders,
  mergeDialerCsvRows,
  CsvRecord,
} from '../lib/contacts';
import { parseGeminiProviderJson, htmlToPlainText, openRouterFreeModels, DEFAULT_OPENROUTER_FREE_MODELS, parseKeysField, AiKeyRotator, resolveAiKeyBundle } from '../lib/geminiProviders';

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
}

function row(partial: Partial<ContactExportRow> & { organization: string }): ContactExportRow {
  return {
    npi: '1234567890',
    taxonomy: '207Q00000X',
    address: '100 Main St',
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
    enumerationDate: new Date('2020-01-15T00:00:00Z'),
    timezone: 'Mountain',
    ...partial,
  };
}

check('digitsPhone keeps last 10', digitsPhone('+1 (801) 350-4111'), '8013504111');
check('phonesAreSame ignores formatting', phonesAreSame('801-350-4111', '(801) 350 4111'), true);
check('phonesAreSame detects different', phonesAreSame('8013504111', '8014637415'), false);

check('CEO + President normalises', normalizeDecisionMakerTitle('CEO / President'), 'CEO/President');
check('family medicine specialty label', taxonomySpecialtyLabel('207Q00000X'), 'Family Medicine');
check('taxonomy cell merges label and code', formatTaxonomyCell('207Q00000X'), 'Family Medicine (207Q00000X)');
check('taxonomy cell code-only when unknown', formatTaxonomyCell('999X00000X'), '999X00000X');

check('PKT Eastern', pktCallWindow('Eastern'), '6:00 PM – 10:00 PM PKT');
check('PKT Mountain', pktCallWindow('Mountain'), '8:00 PM – 12:00 AM PKT');
check('PKT Pacific', pktCallWindow('Pacific'), '9:00 PM – 1:00 AM PKT');
check('PKT blank unknown', pktCallWindow(''), '');

const dupPhone = finalizeContactsCsvRows([
  row({ organization: 'SAME PHONE LLC', practicePhone: '8013504111', decisionMakerPhone: '8013504111' }),
  row({ organization: 'DIFF PHONE LLC', practicePhone: '8013504111', decisionMakerPhone: '8014637415' }),
]);
check('drops same practice and DM phone', dupPhone.map((r) => r.organization), ['DIFF PHONE LLC']);

check('max branches constant is 2', CONTACTS_CSV_MAX_BRANCHES, 2);
check('max providers constant is 15', CONTACTS_CSV_MAX_PROVIDERS, 15);

const csv = buildContactsCsv([
  row({
    organization: 'KEEP ME', city: 'PROVO', zip: '84601', npi: '1999999999',
    taxonomy: '207Q00000X', decisionMakerTitle: 'CEO and President',
    practicePhone: '8011110000', decisionMakerPhone: '8012220000', score: 90,
  }),
]);
const header = csv.split('\r\n')[0];
check('CSV header starts with dialer NPI', header.startsWith('"NPI","Practice_Name","Authorized_Person"'), true);
check('CSV has taxonomy column', header.includes('"taxonomy"'), true);
check('CSV has ZIP column', header.includes('"ZIP"'), true);
check('CSV has PKT_Call_Window', header.includes('"PKT_Call_Window"'), true);
check('CSV includes specialty+code taxonomy', csv.includes('Family Medicine (207Q00000X)'), true);
check('CSV normalises CEO/President title', csv.includes('CEO/President'), true);
check('CSV includes PKT window for Mountain', csv.includes('8:00 PM – 12:00 AM PKT'), true);

check('splitCsvLine respects quotes', splitCsvLine('"A, B","C"'), ['A, B', 'C']);

const reordered = reorderCsvHeaders(['Email', 'Organization', 'NPI', 'City']);
check('reorder puts NPI first', reordered[0], 'NPI');
check('reorder puts Practice_Name second', reordered[1], 'Practice_Name');
check('reorder puts taxonomy 10th', reordered[9], 'taxonomy');

const sameOrg: CsvRecord[] = [
  {
    Practice_Name: 'FOOT CLINIC', Authorized_Person: 'Alice', Authorized_Title: 'Owner',
    Score: '90', City: 'A', State: 'UT',
  },
  {
    Practice_Name: 'FOOT CLINIC', Authorized_Person: 'Bob', Authorized_Title: 'CEO',
    Score: '80', City: 'A', State: 'UT',
  },
];
const mergedOrg = mergeDialerCsvRows(sameOrg);
check('same org merges to one row', mergedOrg.length, 1);
check('same org combines people', mergedOrg[0].Authorized_Person, 'Alice / Bob');
check('same org combines titles', mergedOrg[0].Authorized_Title, 'Owner / CEO');

const sameOwner: CsvRecord[] = [
  {
    Practice_Name: 'CLINIC A', Authorized_Person: 'Jane Doe', Authorized_Title: 'Owner',
    Score: '85', Phone: '8011110001', City: 'A', State: 'UT',
  },
  {
    Practice_Name: 'CLINIC B', Authorized_Person: 'Jane Doe', Authorized_Title: 'Owner',
    Score: '70', Phone: '8011110002', City: 'B', State: 'UT',
  },
];
const mergedOwner = mergeDialerCsvRows(sameOwner);
check('same owner merges to one row', mergedOwner.length, 1);
check('same owner combines practice names', mergedOwner[0].Practice_Name, 'CLINIC A / CLINIC B');

const uploaded = [
  '"Organization","City","State","Branches","Providers","Decision Maker Title","Decision Maker Name"',
  '"SMALL CLINIC","PROVO","UT","1","4","Chief Executive Officer and President","Alex CEO"',
  '"CHAIN CLINIC","OREM","UT","5","3","Owner","Big Boss"',
].join('\r\n');

const filtered = filterUploadedContactsCsv(uploaded, (r) => {
  if (r.Organization === 'SMALL CLINIC' || r.Practice_Name === 'SMALL CLINIC') {
    return {
      npi: '1112223333',
      branches: 1,
      providers: 4,
      taxonomy: '207Q00000X',
      address: '1 Main',
      zip: '84601',
      timezone: 'Mountain',
      enumerationDate: '2019-05-01',
      decisionMakerTitle: 'Chief Executive Officer and President',
      decisionMakerName: 'Alex CEO',
    };
  }
  if (r.Organization === 'CHAIN CLINIC') {
    return { npi: '999', branches: 5, providers: 3 };
  }
  return null;
});
check('upload filter keeps small clinic', filtered.kept, 1);
check('upload filter drops oversize', filtered.droppedOversize, 1);
check('upload filter dialer header starts NPI', filtered.csv.split('\r\n')[0].startsWith('"NPI","Practice_Name"'), true);
check('upload filter taxonomy merged cell', filtered.csv.includes('Family Medicine (207Q00000X)'), true);
check('upload filter ZIP present', filtered.csv.includes('84601'), true);
check('upload filter PKT window', filtered.csv.includes('8:00 PM – 12:00 AM PKT'), true);

const withLookup = filterUploadedContactsCsv(
  '"Organization","City","State"\r\n"LOOKUP ME","PROVO","UT"\r\n',
  (r) => (r.Organization === 'LOOKUP ME'
    ? {
        npi: '1112223333',
        branches: 1,
        providers: 2,
        taxonomy: '122300000X',
        address: '9 Oak',
        zip: '84604',
        timezone: 'Mountain',
        decisionMakerName: 'Doc',
        decisionMakerTitle: 'President',
      }
    : null)
);
check('upload filter enriches from lookup', withLookup.kept, 1);
check('upload filter writes NPI', withLookup.csv.includes('1112223333'), true);
check('upload filter writes dentist taxonomy', withLookup.csv.includes('Dentist (122300000X)'), true);

check(
  'gemini parser reads count',
  parseGeminiProviderJson('{"providerCount": 4, "evidence": "team page lists 4 doctors"}').providerCount,
  4
);
check(
  'gemini parser null',
  parseGeminiProviderJson('```json\n{"providerCount": null, "evidence": "unclear"}\n```').providerCount,
  null
);
check(
  'htmlToPlainText strips tags',
  htmlToPlainText('<html><script>x</script><body><h1>Dr A</h1><p>Dr B</p></body></html>'),
  'Dr A Dr B'
);
check(
  'openrouter defaults start with gemma-4-31b free',
  openRouterFreeModels()[0],
  'google/gemma-4-31b-it:free'
);
check('openrouter defaults include qwen free', DEFAULT_OPENROUTER_FREE_MODELS.includes('qwen/qwen3.8-27b:free'), true);
check('parseKeysField JSON array', parseKeysField('["a","b","a"]'), ['a', 'b']);
check('parseKeysField newlines', parseKeysField('k1\nk2'), ['k1', 'k2']);
{
  const rot = new AiKeyRotator({ openrouter: ['or1', 'or2'], groq: [], gemini: [] });
  check('rotator starts on first key', rot.currentOpenRouter()?.index, 0);
  rot.markOpenRouterLimited(0, 60_000);
  check('rotator advances after limit', rot.currentOpenRouter()?.key, 'or2');
  check('rotator rotation count', rot.rotations, 1);
}
check(
  'resolveAiKeyBundle merges client keys',
  resolveAiKeyBundle({ openrouter: ['ui-key'], groq: [], gemini: [] }).openrouter.includes('ui-key'),
  true
);
check(
  'resolveAiKeyBundle clientOnly ignores empty gemini',
  resolveAiKeyBundle({ openrouter: ['or1'], groq: ['g1'], gemini: [] }, { clientOnly: true }).gemini,
  []
);
check(
  'resolveAiKeyBundle clientOnly keeps only UI openrouter',
  resolveAiKeyBundle({ openrouter: ['or1', 'or2'], groq: [], gemini: [] }, { clientOnly: true }).openrouter,
  ['or1', 'or2']
);

const parsed = parseContactsCsvText(uploaded);
check('parseContactsCsvText row count', parsed.rows.length, 2);

const legacyCsv =
  'Organization,Decision Maker Name,Decision Maker Title,Practice Phone,City,State,Specialty,Time Zone\r\n' +
  '"ACME DENTAL","Jane Doe","Owner","8015551212","PROVO","UT","122300000X","Mountain"\r\n';
const formatted = formatUploadedContactsCsv(legacyCsv, { merge: false });
const fmtParsed = parseContactsCsvText(formatted.csv);
check('format-only keeps all rows', formatted.kept, 1);
check('format-only header starts NPI', fmtParsed.headers[0], 'NPI');
check('format-only Practice_Name second', fmtParsed.headers[1], 'Practice_Name');
check('format-only has PKT_Call_Window', fmtParsed.headers.includes('PKT_Call_Window'), true);
check('format-only maps Organization', formatted.csv.includes('ACME DENTAL'), true);
check('format-only writes PKT for Mountain', formatted.csv.includes('8:00 PM'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
