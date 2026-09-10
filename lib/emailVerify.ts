import { promises as dns, Resolver } from 'dns';

/**
 * Email verification for Step 4.
 *
 * Scraped addresses are the least trustworthy thing in the pipeline: the clinic
 * closed, the staff member left, or the page simply has a typo. A bounce rate
 * over about 5% gets a sending domain flagged permanently, so nothing should
 * reach Step 5 unchecked.
 *
 * Two layers, cheapest first — the same ordering the website resolution uses:
 *
 *   1. local  — syntax, disposable domains, and an MX lookup. Free, no key,
 *               and it catches dead domains outright, which is where a large
 *               share of bounces actually come from.
 *   2. paid   — MillionVerifier's SMTP-level check, for addresses that survive
 *               the local pass. Only runs when MILLIONVERIFIER_KEY is set, so
 *               no credit is ever spent on something already known to be bad.
 */

export type VerifyStatus =
  | 'ok'          // mailbox confirmed by the paid verifier
  | 'mx_ok'       // syntax and MX pass; mailbox never checked (no verifier key)
  | 'catch_all'   // server accepts everything — cannot be proven either way
  | 'unknown'     // server would not answer
  | 'invalid'     // mailbox or domain does not exist
  | 'disposable'; // throwaway address

export type EmailVerdict = {
  status: VerifyStatus;
  reason: string;
  /** Which layer decided. 'local' costs nothing. */
  checkedBy: 'local' | 'millionverifier';
};

export function emailVerifierConfigured(): boolean {
  return Boolean(process.env.MILLIONVERIFIER_KEY?.trim());
}

/**
 * Whether an address is safe to hand to Step 5.
 *
 * `mx_ok` passes because it means every check available actually ran and cleared
 * — without a verifier key there is nothing further to ask, and holding it back
 * would send less mail than the pipeline did before it could verify at all.
 *
 * `catch_all` and `unknown` are different: a verifier did run and declined to
 * confirm. Those are a judgement call, excluded unless the caller opts in.
 */
export function isSendable(status: VerifyStatus | null | undefined, allowRisky = false): boolean {
  if (!status) return true; // never verified — the old behaviour, no worse than before
  if (status === 'ok' || status === 'mx_ok') return true;
  if (status === 'invalid' || status === 'disposable') return false;
  return allowRisky;
}

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'throwawaymail.com', 'yopmail.com', 'trashmail.com', 'getnada.com',
  'sharklasers.com', 'temp-mail.org', 'dispostable.com', 'maildrop.cc',
  'fakeinbox.com', 'mailnesia.com', 'tempinbox.com', 'spamgourmet.com',
  'mintemail.com', 'emailondeck.com', 'moakt.com', 'tempr.email',
]);

// Deliberately loose: this only has to reject text that could never be an
// address. Anything cleverer starts rejecting real, unusual mailboxes.
const SYNTAX = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** A domain that resolves, one that provably does not, and one we could not ask about. */
type MailHost = 'yes' | 'no' | 'unresolved';

/** Cached per process — one domain covers many practices. Never caches 'unresolved'. */
const mxCache = new Map<string, 'yes' | 'no'>();

/**
 * MX queries go to explicit public resolvers rather than the machine's own.
 *
 * Node's record queries follow /etc/resolv.conf, which on a developer machine is
 * often a stub listener that answers plain hostname lookups but refuses record
 * queries outright. That refusal is indistinguishable from a real failure unless
 * we ask someone who will actually answer. Override with DNS_SERVERS if the
 * network blocks external resolvers.
 */
let resolver: Resolver | null = null;
function getResolver(): Resolver {
  if (resolver) return resolver;
  const servers = (process.env.DNS_SERVERS ?? '1.1.1.1,8.8.8.8')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  resolver = new Resolver();
  try {
    resolver.setServers(servers);
  } catch {
    // A malformed DNS_SERVERS should not take verification down — fall back to
    // whatever the system is configured with.
  }
  return resolver;
}

/**
 * Only ENOTFOUND and ENODATA are answers. Everything else — a refused resolver,
 * a timeout, SERVFAIL — means the question never got asked, which is not the
 * same as the domain being dead. Treating those as dead would permanently mark
 * good addresses invalid on nothing worse than a DNS hiccup.
 */
function isDefiniteMiss(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA';
}

async function hasMailExchanger(domain: string): Promise<MailHost> {
  const cached = mxCache.get(domain);
  if (cached) return cached;

  const remember = (v: 'yes' | 'no'): MailHost => {
    mxCache.set(domain, v);
    return v;
  };

  const r = getResolver().resolveMx.bind(getResolver());
  const mx = await new Promise<{ ok: boolean; error?: unknown }>((resolve) => {
    r(domain, (error, records) => {
      if (error) resolve({ ok: false, error });
      else resolve({ ok: (records?.length ?? 0) > 0 });
    });
  });

  if (mx.ok) return remember('yes');

  // No MX is not proof on its own — a domain may take mail on its A record. This
  // second question goes through the OS resolver, which answers plain lookups even
  // where record queries are refused, so a missing MX still gets a real verdict.
  try {
    await dns.lookup(domain);
    return remember('yes');
  } catch (error) {
    if (isDefiniteMiss(error) || isDefiniteMiss(mx.error)) return remember('no');
    return 'unresolved';
  }
}

/** The free pass. Returns null when the address survives it and is worth paying to check. */
async function localCheck(email: string): Promise<EmailVerdict | null> {
  const address = email.trim().toLowerCase();

  if (!SYNTAX.test(address)) {
    return { status: 'invalid', reason: 'not a valid address', checkedBy: 'local' };
  }

  const domain = address.slice(address.lastIndexOf('@') + 1);

  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { status: 'disposable', reason: `throwaway domain ${domain}`, checkedBy: 'local' };
  }

  const host = await hasMailExchanger(domain);
  if (host === 'no') {
    return { status: 'invalid', reason: `${domain} does not exist`, checkedBy: 'local' };
  }
  if (host === 'unresolved') {
    return { status: 'unknown', reason: `DNS did not answer for ${domain}`, checkedBy: 'local' };
  }

  return null;
}

type MillionVerifierResponse = {
  result?: string;
  subresult?: string;
  error?: string;
  credits?: number;
};

async function millionVerifier(email: string, timeoutMs: number): Promise<EmailVerdict> {
  const key = process.env.MILLIONVERIFIER_KEY!.trim();

  const url = new URL('https://api.millionverifier.com/api/v3/');
  url.searchParams.set('api', key);
  url.searchParams.set('email', email);
  url.searchParams.set('timeout', '10');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`MillionVerifier returned ${res.status}`);

    const data = (await res.json()) as MillionVerifierResponse;
    if (data.error) throw new Error(data.error);

    const status = normalizeResult(data.result);
    return {
      status,
      reason: data.subresult ? `${data.result} (${data.subresult})` : String(data.result ?? 'unknown'),
      checkedBy: 'millionverifier',
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeResult(result: string | undefined): VerifyStatus {
  switch (result) {
    case 'ok': return 'ok';
    case 'invalid': return 'invalid';
    case 'catch_all': return 'catch_all';
    case 'disposable': return 'disposable';
    default: return 'unknown';
  }
}

/**
 * Verifies one address. Never throws — a verifier being down must not cost the
 * pipeline a contact, so a failed paid check degrades to the local verdict.
 */
export async function verifyEmail(email: string, timeoutMs = 15000): Promise<EmailVerdict> {
  const local = await localCheck(email).catch(() => null);
  if (local) return local;

  if (!emailVerifierConfigured()) {
    return { status: 'mx_ok', reason: 'syntax and MX pass; mailbox not checked', checkedBy: 'local' };
  }

  try {
    return await millionVerifier(email, timeoutMs);
  } catch (error) {
    return {
      status: 'unknown',
      reason: `verifier unavailable: ${error instanceof Error ? error.message : String(error)}`,
      checkedBy: 'local',
    };
  }
}
