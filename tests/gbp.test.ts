import { scorePlaceMatch, pickPlace, placeIsClosed, VerifyTarget } from '../lib/webVerify';
import { PlaceHit, phoneDigits } from '../lib/search';
import { scoreLead, DEFAULT_THRESHOLDS } from '../lib/scoring';

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
}

const lead: VerifyTarget = {
  id: 1,
  organization: 'MCKAY FAMILY PRACTICE',
  address: '1055 N 500 W',
  city: 'PROVO',
  state: 'UT',
  zip: '84604',
  phone: '8012102445',
};

const place = (over: Partial<PlaceHit>): PlaceHit => ({
  name: '', address: '', phone: '', website: '', category: '',
  rating: null, reviews: null, placeId: '', status: '', ...over,
});

// --- phone normalisation --------------------------------------------------
check('formatting is stripped', phoneDigits('(801) 210-2445'), '8012102445');
check('a leading 1 is dropped', phoneDigits('1-801-210-2445'), '8012102445');
check('a short number keeps its digits', phoneDigits('555'), '555');
check('null is empty', phoneDigits(null), '');

// --- matching -------------------------------------------------------------
// Phone dominates on purpose: "FAMILY PRACTICE" matches dozens of listings in one
// city, but a ten-digit number is effectively unique and NPPES gives us one for
// every lead.
const byPhone = scorePlaceMatch(lead, place({ name: 'Totally Different Name', phone: '(801) 210-2445' }));
check('a phone match alone is strong', byPhone.confidence >= 50, true);
check('and says why', byPhone.evidence.includes('phone matches'), true);

const byNameOnly = scorePlaceMatch(lead, place({ name: 'McKay Family Practice' }));
check('a name match alone is weak', byNameOnly.confidence < 50, true);

const both = scorePlaceMatch(lead, place({
  name: 'McKay Family Practice',
  address: '1055 N 500 W, Provo, UT 84604',
  phone: '801-210-2445',
}));
check('name and phone together are conclusive', both.confidence >= 90, true);

const unrelated = scorePlaceMatch(lead, place({ name: 'Joe Pizza', address: '12 Main St, Mesa, AZ' }));
check('an unrelated listing scores nothing', unrelated.confidence, 0);

// --- picking the right listing from several -------------------------------
const picked = pickPlace(lead, [
  place({ name: 'Provo Family Dentistry', address: 'Provo, UT' }),
  place({ name: 'McKay Family Practice', address: '1055 N 500 W, Provo, UT', phone: '8012102445' }),
  place({ name: 'McKay Auto Repair', address: 'Provo, UT' }),
]);
check('the best listing wins', picked?.place.name, 'McKay Family Practice');

check('a weak field of candidates is refused', pickPlace(lead, [
  place({ name: 'Provo Family Dentistry', address: 'Provo, UT' }),
  place({ name: 'Some Clinic', address: 'Provo, UT' }),
]), null);
check('no listings means no match', pickPlace(lead, []), null);

// --- closure --------------------------------------------------------------
check('permanently closed is closed', placeIsClosed('CLOSED_PERMANENTLY'), true);
check('temporarily closed is not', placeIsClosed('CLOSED_TEMPORARILY'), false);
check('operational is not', placeIsClosed('OPERATIONAL'), false);
check('an absent status is not a closure', placeIsClosed(''), false);

// --- scoring acts on the closure -----------------------------------------
// A closed practice is otherwise indistinguishable from an open one in NPPES, so
// this is the only signal that removes it.
const strong = {
  organization: 'MCKAY FAMILY PRACTICE',
  entityType: '2', n_locations_detected: 3, n_providers_at_location: 8,
  authorizedOfficialTitle: 'OWNER', authorizedOfficialName: 'Jenny Mckay',
  phone: '8012102445', lastUpdateDate: new Date(),
};
check('it would be HOT while trading', scoreLead(strong, DEFAULT_THRESHOLDS, new Date()).tag, 'HOT');

const closed = scoreLead({ ...strong, gbpStatus: 'CLOSED_PERMANENTLY' }, DEFAULT_THRESHOLDS, new Date());
check('a closed practice is excluded', closed.tag, 'EXCLUDE');
check('and zeroed', closed.score, 0);
check('and the reason names the source', closed.reason.includes('Google Business Profile'), true);

check('temporarily closed still scores normally',
  scoreLead({ ...strong, gbpStatus: 'CLOSED_TEMPORARILY' }, DEFAULT_THRESHOLDS, new Date()).tag, 'HOT');
check('an unchecked lead scores normally',
  scoreLead({ ...strong, gbpStatus: null }, DEFAULT_THRESHOLDS, new Date()).tag, 'HOT');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
