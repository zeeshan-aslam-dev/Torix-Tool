import { findLinkedInUrl, isDirectoryDomain } from '../lib/search';

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
}

// --- directory filtering ---------------------------------------------------
check('linkedin is a directory domain (never the practice site)',
  isDirectoryDomain('https://www.linkedin.com/company/moab-eyecare'), true);
check('a real practice domain is not', isDirectoryDomain('https://moabeyecare.com'), false);

// --- LinkedIn extraction from raw search results ---------------------------
// This is the whole point: linkedin.com gets filtered out of the website
// candidates by isDirectoryDomain above, so the LinkedIn link has to be pulled
// out of the *raw* results before that filter runs — findLinkedInUrl is that
// read, done for free on a query already paid for by the same search.
check('finds a company page',
  findLinkedInUrl(['https://moabeyecare.com', 'https://www.linkedin.com/company/moab-eyecare']),
  'https://www.linkedin.com/company/moab-eyecare');

check('strips a trailing slash', findLinkedInUrl(['https://www.linkedin.com/company/moab-eyecare/']),
  'https://www.linkedin.com/company/moab-eyecare');

check('finds a personal profile when no company page exists',
  findLinkedInUrl(['https://healthgrades.com/x', 'https://www.linkedin.com/in/jane-kimball-od']),
  'https://www.linkedin.com/in/jane-kimball-od');

check('prefers a company page over a personal one, regardless of order',
  findLinkedInUrl([
    'https://www.linkedin.com/in/jane-kimball-od',
    'https://www.linkedin.com/company/moab-eyecare',
  ]),
  'https://www.linkedin.com/company/moab-eyecare');

check('a regional subdomain still matches', findLinkedInUrl(['https://uk.linkedin.com/company/moab-eyecare']),
  'https://uk.linkedin.com/company/moab-eyecare');

check('returns null when nothing looks like linkedin',
  findLinkedInUrl(['https://moabeyecare.com', 'https://facebook.com/moabeyecare']), null);

check('ignores undefined and empty entries without throwing',
  findLinkedInUrl([undefined, '', null as unknown as string, 'https://www.linkedin.com/company/moab-eyecare']),
  'https://www.linkedin.com/company/moab-eyecare');

check('rejects a linkedin url that is not a company or profile page',
  findLinkedInUrl(['https://www.linkedin.com/pulse/some-article']), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
