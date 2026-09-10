import { extractEmails, extractLinkedIn, contactPageLinks, isJunkEmail, titleCase } from '../lib/contacts';

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
}

// --- junk filtering -------------------------------------------------------
check('rejects noreply', isJunkEmail('noreply@moabeyecare.com'), true);
check('rejects careers', isJunkEmail('careers@moabeyecare.com'), true);
check('rejects sentry noise', isJunkEmail('abc@sentry.wixpress.com'), true);
check('rejects image filename', isJunkEmail('logo@2x.png'), true);
check('rejects tracking hash', isJunkEmail('a1b2c3d4e5f60718@moabeyecare.com'), true);
check('keeps a real address', isJunkEmail('info@moabeyecare.com'), false);
check('rejects firstname.lastname placeholder', isJunkEmail('firstname.lastname@ogdenclinic.com'), true);
check('rejects yourname placeholder', isJunkEmail('yourname@clinic.com'), true);
check('rejects john.doe placeholder', isJunkEmail('john.doe@clinic.com'), true);
check('keeps a real person named first', isJunkEmail('jenny.mckay@clinic.com'), false);
check('rejects humanresources inbox', isJunkEmail('humanresources@ogdenclinic.com'), true);
check('rejects employment inbox', isJunkEmail('employment@clinic.com'), true);
check('keeps billing inbox', isJunkEmail('billing@clinic.com'), false);

// --- ranking on a realistic page -----------------------------------------
const html = `
<html><head><title>Moab Eyecare</title></head><body>
  <a href="mailto:info@moabeyecare.com">Email us</a>
  <p>Billing questions: billing@moabeyecare.com</p>
  <p>Careers: careers@moabeyecare.com</p>
  <p>Site by <a href="mailto:hello@somewebshop.com">Some Web Shop</a></p>
  <p>Dr. Jane Kimball: jane.kimball@moabeyecare.com</p>
  <a href="https://www.linkedin.com/company/moab-eyecare">LinkedIn</a>
  <a href="/contact-us/">Contact</a>
  <a href="/about/">About</a>
  <a href="/blog/eye-tips/">Blog</a>
  <a href="https://facebook.com/moabeyecare">Facebook</a>
</body></html>`;

const ranked = extractEmails(html, 'moabeyecare.com', 'Jane Kimball');
console.log('\n  ranked:', ranked.map(r => `${r.confidence} ${r.email} (${r.why})`).join('\n           '));

check('decision maker email ranks first', ranked[0].email, 'jane.kimball@moabeyecare.com');
check('careers address dropped', ranked.some(r => r.email.startsWith('careers')), false);
check('web shop ranked below own domain',
  ranked.findIndex(r => r.email === 'hello@somewebshop.com') > ranked.findIndex(r => r.email === 'info@moabeyecare.com'), true);
check('mailto boosts info@', ranked.find(r => r.email === 'info@moabeyecare.com')!.why.includes('mailto'), true);

// --- mailto with URL-encoded debris ---------------------------------------
// Caught on a live site during the first paid Step 3 run: the source HTML had
// "mailto: office@theeyepros.com" (a stray space after the colon), which the
// page served back as "mailto:%20office@theeyepros.com". The raw capture had
// no way to tell that apart from a legitimate local part starting with "%20".
const encodedHtml = `
<html><body>
  <a href="mailto:%20office@theeyepros.com">Email</a>
</body></html>`;
const encodedRanked = extractEmails(encodedHtml, 'theeyepros.com', null);
check('decodes a URL-encoded leading space out of a mailto link',
  encodedRanked.map(r => r.email), ['office@theeyepros.com']);

// --- linkedin + contact links --------------------------------------------
check('finds linkedin', extractLinkedIn(html), 'https://www.linkedin.com/company/moab-eyecare');
const links = contactPageLinks(html, 'https://moabeyecare.com/');
check('picks contact + about, skips blog and facebook', links, [
  'https://moabeyecare.com/contact-us/',
  'https://moabeyecare.com/about/',
]);

// --- name formatting ------------------------------------------------------
check('title cases a shouted name', titleCase('RUSSELL STEINHORST'), 'Russell Steinhorst');
check('keeps credentials upper', titleCase('CHIEF EXECUTIVE OFFICER'), 'Chief Executive Officer');

// --- no website, no crash -------------------------------------------------
check('empty page yields nothing', extractEmails('', 'x.com', null), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
