import { matchBlocklist, blocklistSize } from '../lib/blocklist';
import { detectAcquisition } from '../lib/webVerify';
import { scoreLead, DEFAULT_THRESHOLDS } from '../lib/scoring';

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
}

console.log(`blocklist loaded: ${blocklistSize()} entries\n`);

// --- blocklist matching ---------------------------------------------------
check('matches across spelling variants', matchBlocklist('IHC HEALTH SERVICES, INC.')?.entry, 'IHC HEALTH SERVICES');
check('matches the plain form', matchBlocklist('IHC HEALTH SERVICES INC')?.entry, 'IHC HEALTH SERVICES');
check('matches a national system', matchBlocklist('CATHOLIC HEALTH INITIATIVES COLORADO')?.entry, 'CATHOLIC HEALTH INITIATIVES');
check('matches an optical chain', matchBlocklist('MYEYEDR OPTOMETRY OF WASHINGTON, PLLC')?.entry, 'MYEYEDR');
check('leaves an independent practice alone', matchBlocklist('MCKAY FAMILY PRACTICE'), null);
check('leaves a small chiropractor alone', matchBlocklist('PETERSON CHIROPRACTIC INC'), null);
check('does not fire mid-word', matchBlocklist('OPTUMISTIC EYE CARE'), null);
check('does not fire on a shared word', matchBlocklist('MERCY STREET DENTAL'), null);

// --- blocklist forces EXCLUDE regardless of score -------------------------
const wouldBeHot = {
  organization: 'IHC HEALTH SERVICES, INC',
  entityType: '2', n_locations_detected: 3, n_providers_at_location: 8,
  authorizedOfficialTitle: 'OWNER', authorizedOfficialName: 'Someone',
  phone: '8015551234', lastUpdateDate: new Date(),
};
const withBlock = scoreLead(wouldBeHot, DEFAULT_THRESHOLDS, new Date(), matchBlocklist);
const withoutBlock = scoreLead(wouldBeHot, DEFAULT_THRESHOLDS, new Date());
check('would score HOT without the blocklist', withoutBlock.tag, 'HOT');
check('blocklist forces EXCLUDE', withBlock.tag, 'EXCLUDE');
check('blocklist zeroes the score', withBlock.score, 0);
check('blocklist reason names the system', withBlock.reason, 'blocklisted: part of IHC HEALTH SERVICES');
check('blocklist flags possible acquisition', withBlock.possibleAcquisition, true);

// --- acquisition phrase detection ----------------------------------------
check('finds "is now part of"',
  detectAcquisition('<p>Valley Eye Care is now part of Vision Group Holdings. Same great team.</p>')?.phrase,
  'is now part of');
check('finds "acquired by"',
  detectAcquisition('Our practice was acquired by Mountain Health in 2024.')?.phrase,
  'was acquired by');
check('finds "a division of"',
  detectAcquisition('Summit Chiropractic, a division of Peak Wellness Group, serves the valley.')?.phrase,
  'a division of');
check('keeps the sentence as context',
  detectAcquisition('Welcome. Valley Eye Care is now part of Vision Group. Call us.')?.context,
  'Valley Eye Care is now part of Vision Group.');

// Real false positives caught in a live 100-lead run — all of these used to fire.
check('ignores a testimonial',
  detectAcquisition('McGuire has been our eye doctor for over seven years and he makes us feel like we are a part of his family.'), null);
check('ignores marketing copy',
  detectAcquisition('We believe getting the right prescription is an important part of good eye care.'), null);
check('ignores a community invite',
  detectAcquisition('Become part of our community! Interact with the largest community of students in Europe.'), null);
check('ignores a cookie policy',
  detectAcquisition('Without a subpoena, voluntary compliance on the part of your Internet Service Provider, information stored is not usable.'), null);
check('ignores inline script text',
  detectAcquisition("<script>var s = new Swiper('.swiper-pagination', { modules: [A11y, Navigation] }); // part of the slider</script><p>Welcome</p>"), null);
check('ignores a careers line',
  detectAcquisition('Continuous education is a crucial part of their career at our clinic.'), null);
check('ignores "part of our family"', detectAcquisition('You are part of our family here at Smile Dental.'), null);

// Real acquisitions still have to be caught.
check('catches a named acquirer',
  detectAcquisition('Cedar Ridge Family Medicine is now part of Revere Health.')?.phrase, 'is now part of');
check('catches "has joined"',
  detectAcquisition('Dr. Olsen has joined Mountain West Medical Group as of January.')?.phrase, 'has joined');
check('catches "affiliated with"',
  detectAcquisition('Our office is affiliated with Wasatch Vision Partners.')?.phrase, 'is affiliated with');
check('rejects a phrase with no organisation after it',
  detectAcquisition('The practice has joined us in celebrating twenty years.'), null);
check('ignores "is now open"', detectAcquisition('Our new location is now open on Main Street.'), null);
check('ignores "be part of"', detectAcquisition('We would love for you to be part of the community.'), null);
check('nothing on an ordinary page', detectAcquisition('<h1>Welcome to Moab Eyecare</h1><p>Book an appointment today.</p>'), null);
check('strips html before matching',
  detectAcquisition('<div>Cedar <b>Ridge</b> is now part of <a href="#">Big Health</a>.</div>')?.phrase,
  'is now part of');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
