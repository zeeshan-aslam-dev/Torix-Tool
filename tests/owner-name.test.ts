import { detectOwnerName } from '../lib/webVerify';

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
}

// This exists to cross-check NPPES's Authorized Official against what the
// practice's own site says, on pages Step 4 has already fetched for email —
// no extra request. It never overwrites NPPES; it only surfaces a name to
// compare against it.

// --- real patterns it has to catch -----------------------------------------
check('a plain "Owner:" label',
  detectOwnerName('<p>Owner: Jane Kimball</p>')?.name, 'Jane Kimball');

check('a name with a credential after it (the comma is punctuation, not part of the name)',
  detectOwnerName('<p>Owner: Dr. Jane Kimball, OD</p>')?.name, 'Dr. Jane Kimball OD');

check('"Founded by"',
  detectOwnerName('Moab Eyecare was founded by Robert Kimball in 1998.')?.name, 'Robert Kimball');

check('"owned by"',
  detectOwnerName('The practice is owned by Andrew Reheisse.')?.name, 'Andrew Reheisse');

check('"Meet the owner,"',
  detectOwnerName('Meet the owner, Sarah Chen. She has practiced here for 12 years.')?.name, 'Sarah Chen');

// Caught on a live site during real testing: an <h2>"Meet The Owner"</h2>
// heading flows straight into the name of the very next block once tags are
// stripped, with no comma anywhere near it.
check('a bare "Meet The Owner" heading with no comma, name in the next block',
  detectOwnerName('<h2>Meet The Owner</h2><p>Jenny McKay APRN Graduated from Concordia University...</p>')?.name,
  'Jenny McKay');

check('phrase is reported alongside the name',
  detectOwnerName('Founder: William Albrecht')?.phrase, 'founder:');

check('keeps a sentence of context',
  detectOwnerName('Welcome to our clinic. Owner: Jane Kimball. Call us today.')?.context,
  'Owner: Jane Kimball.');

// --- traps a loose phrase list would fall into ------------------------------
// The acquisition detector's first version matched a bare "part of" and hit
// 15 false positives out of 15 on live pages. These are the equivalent traps
// for ownership language.
check('ignores praise for an employee, not a label',
  detectOwnerName('Our team is amazing and the owner really cares about every patient.'), null);

check('ignores a single name with no last name',
  detectOwnerName('Owner: Jane'), null);

check('ignores a sentence fragment with no real name after the phrase',
  detectOwnerName('Owner: the friendly staff at our front desk'), null);

check('ignores inline script text',
  detectOwnerName("<script>var owner = getOwner(); // founder: init()</script><p>Welcome</p>"), null);

check('strips html before matching',
  detectOwnerName('<div>Owner: <b>Jane</b> <b>Kimball</b></div>')?.name, 'Jane Kimball');

check('nothing on an ordinary page',
  detectOwnerName('<h1>Welcome to Moab Eyecare</h1><p>Book an appointment today.</p>'), null);

check('ignores "owned by" followed by a car, not a person',
  detectOwnerName('This vehicle is owned by the previous tenant and left in the parking lot.'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
