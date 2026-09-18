import { parseTaxonomyFilter, taxonomyFilterIsEmpty, taxonomyMatches } from '../lib/taxonomy';

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
}

const dentistsAndMds = parseTaxonomyFilter('1223*,207*,208*');

check('parses three prefixes', dentistsAndMds.prefixes.sort(), ['1223', '207', '208']);
check('prefix-only filter is not empty', taxonomyFilterIsEmpty(dentistsAndMds), false);
check('empty input is empty', taxonomyFilterIsEmpty(parseTaxonomyFilter('')), true);
check('whitespace-only is empty', taxonomyFilterIsEmpty(parseTaxonomyFilter('  ,  ')), true);

check('dentist general practice matches 1223*', taxonomyMatches('1223G0001X', dentistsAndMds), true);
check('dentist root code matches 1223*', taxonomyMatches('122300000X', dentistsAndMds), true);
check('family medicine matches 207*', taxonomyMatches('207Q00000X', dentistsAndMds), true);
check('pediatrics matches 208*', taxonomyMatches('208000000X', dentistsAndMds), true);
check('chiropractor does not match', taxonomyMatches('111N00000X', dentistsAndMds), false);
check('optometrist does not match', taxonomyMatches('152W00000X', dentistsAndMds), false);
check('dental hygienist 124Q does not match 1223*', taxonomyMatches('124Q00000X', dentistsAndMds), false);

const exact = parseTaxonomyFilter('207Q00000X, 122300000X');
check('exact family medicine matches', taxonomyMatches('207Q00000X', exact), true);
check('other 207 specialty does not match exact-only filter', taxonomyMatches('207R00000X', exact), false);
check('exact and prefix can mix',
  taxonomyMatches('111N00000X', parseTaxonomyFilter('111N00000X,207*')), true);
check('prefix still works in a mixed filter',
  taxonomyMatches('207R00000X', parseTaxonomyFilter('111N00000X,207*')), true);

check('empty code never matches', taxonomyMatches('', dentistsAndMds), false);
check('case is normalised', taxonomyMatches('207q00000x', dentistsAndMds), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
