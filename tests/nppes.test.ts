import { normalizePersonName, nameLikelyMatches, buildLeadKey } from '../lib/nppes';

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
}

// This is what lets the individual-NPI backup lookup (Step 1) match a
// facility's Authorized Official against their own personal NPI record, even
// though NPPES spells names inconsistently between the two record types.

check('matches identical names', normalizePersonName('Jenny', 'Mckay'), normalizePersonName('Jenny', 'Mckay'));
check('is case-insensitive', normalizePersonName('JENNY', 'MCKAY'), normalizePersonName('jenny', 'mckay'));
check('drops a middle initial on the first-name field',
  normalizePersonName('Jenny M', 'Mckay'), normalizePersonName('Jenny', 'Mckay'));
check('ignores an apostrophe', normalizePersonName('Jenny', "O'Mckay"), normalizePersonName('Jenny', 'OMckay'));
check('ignores a period', normalizePersonName('Jenny', 'Mckay Jr.'), normalizePersonName('Jenny', 'Mckay Jr'));
check('a different last name does not match',
  normalizePersonName('Jenny', 'Mckay') === normalizePersonName('Jenny', 'Smith'), false);
check('a different first name does not match',
  normalizePersonName('Jenny', 'Mckay') === normalizePersonName('Andrew', 'Mckay'), false);
check('shape is "FIRST|LAST"', normalizePersonName('Jenny', 'Mckay'), 'JENNY|MCKAY');

// --- comparing an NPPES name against free text from a website -------------
// This decides whether a name Step 4 found on a practice's own site is worth
// flagging against NPPES's Authorized Official, or is just noise.
check('an exact match', nameLikelyMatches('Jane Kimball', 'Jane Kimball'), true);
check('extra title and credentials do not break a match',
  nameLikelyMatches('Jane Kimball', 'Dr. Jane Kimball OD'), true);
check('word order does not matter', nameLikelyMatches('Jane Kimball', 'Kimball, Jane'), true);
check('a genuinely different name does not match',
  nameLikelyMatches('Jane Kimball', 'Robert Anderson'), false);
check('a shared last name but different first name does not match',
  nameLikelyMatches('Jane Kimball', 'Robert Kimball'), false);
check('an empty NPPES name never matches', nameLikelyMatches('', 'Jane Kimball'), false);

// --- lead keys --------------------------------------------------------------
// Step 1 used to group rows into practice locations on a hand-rolled key
// that kept the raw address, while the leadKey written to the database ran
// the address through buildLeadKey's own normalisation. Two rows whose
// address differed only by punctuation or spacing landed in separate
// in-memory groups but produced the same leadKey at insert time — invisible
// at a few thousand locations, but `createMany` crashed outright on a
// national import once two such rows actually collided. The fix was to key
// the groups on buildLeadKey itself, so what would collide merges first
// instead — these lock in the guarantee that relies on.
const base = { organization: 'Mckay Family Practice', address: '123 Main St', city: 'West Jordan', state: 'UT', zip: '84088' };

check('a trailing period on the address does not change the key',
  buildLeadKey(base), buildLeadKey({ ...base, address: '123 Main St.' }));

check('extra internal whitespace does not change the key',
  buildLeadKey(base), buildLeadKey({ ...base, address: '123  Main   St' }));

check('a comma in the city does not change the key',
  buildLeadKey(base), buildLeadKey({ ...base, city: 'West Jordan,' }));

check('a genuinely different address changes the key',
  buildLeadKey(base) === buildLeadKey({ ...base, address: '456 Main St' }), false);

check('a ZIP+4 is truncated to five digits, same as elsewhere in the pipeline',
  buildLeadKey(base), buildLeadKey({ ...base, zip: '84088-1234' }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
