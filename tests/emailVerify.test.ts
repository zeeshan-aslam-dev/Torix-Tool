import { isSendable, VerifyStatus } from '../lib/emailVerify';

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
}

// --- what may reach Step 5 ------------------------------------------------
check('a confirmed mailbox sends', isSendable('ok'), true);

// Without a verifier key every real address lands on mx_ok. If that were held
// back, turning verification on would send less mail than having it off — the
// bug this status exists to prevent.
check('mx-only sends when no verifier key is set', isSendable('mx_ok'), true);

check('a dead domain never sends', isSendable('invalid'), false);
check('a dead domain never sends, even risky', isSendable('invalid', true), false);
check('a throwaway never sends', isSendable('disposable'), false);
check('a throwaway never sends, even risky', isSendable('disposable', true), false);

// A verifier that ran and declined to confirm is a different case from one that
// was never asked: the caller opts in rather than getting these by default.
check('catch-all is held back by default', isSendable('catch_all'), false);
check('catch-all sends when risky is allowed', isSendable('catch_all', true), true);
check('unknown is held back by default', isSendable('unknown'), false);
check('unknown sends when risky is allowed', isSendable('unknown', true), true);

// Contacts built before verification existed carry no status at all. They keep
// the old behaviour rather than being silently dropped from every send.
check('an unverified contact still sends', isSendable(null), true);
check('an undefined status still sends', isSendable(undefined), true);

// --- the send route builds its filter from the same two sets --------------
const strict: VerifyStatus[] = ['ok', 'mx_ok'];
const risky: VerifyStatus[] = ['ok', 'mx_ok', 'catch_all', 'unknown'];
const all: VerifyStatus[] = ['ok', 'mx_ok', 'catch_all', 'unknown', 'invalid', 'disposable'];

check('strict list matches isSendable', all.filter((s) => isSendable(s)), strict);
check('risky list matches isSendable', all.filter((s) => isSendable(s, true)), risky);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
