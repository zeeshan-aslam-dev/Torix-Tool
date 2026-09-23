/**
 * Optional AI lookup for how many providers work at a practice.
 *
 * Fetches the practice website / GBP page, then asks an LLM to count clinicians
 * from that text. Supports multiple API keys per platform (OpenRouter, Groq,
 * Gemini); rotates to the next key on rate limits (429/503).
 * Preference: OpenRouter → Groq → Gemini.
 */

export type ProviderCountInput = {
  organization: string;
  city?: string;
  state?: string;
  website?: string | null;
  gbpWebsite?: string | null;
};

export type ProviderCountResult = {
  providerCount: number | null;
  evidence: string;
  backend?: 'openrouter' | 'groq' | 'gemini' | 'none';
};

/** Keys supplied from the UI (and/or merged with .env). */
export type AiKeyBundle = {
  openrouter: string[];
  groq: string[];
  gemini: string[];
};

/** @deprecated alias */
export type GeminiProviderInput = ProviderCountInput;
/** @deprecated alias */
export type GeminiProviderResult = ProviderCountResult;

const MAX_PAGE_CHARS = 6_000;
const DEFAULT_GROQ_MODEL = 'qwen/qwen3.8-27b';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

export const DEFAULT_OPENROUTER_FREE_MODELS = [
  'google/gemma-4-31b-it:free',
  'qwen/qwen3.8-27b:free',
  'google/gemma-4-26b-a4b-it:free',
  'nex-agi/nex-n2.5-mini:free',
] as const;

function uniqKeys(keys: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    const t = (k || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Merge UI-supplied keys with single keys from .env (unless clientOnly). */
export function resolveAiKeyBundle(
  fromClient?: Partial<AiKeyBundle> | null,
  opts?: { clientOnly?: boolean }
): AiKeyBundle {
  const clientOnly = Boolean(opts?.clientOnly);
  if (clientOnly) {
    return {
      openrouter: uniqKeys(fromClient?.openrouter ?? []),
      groq: uniqKeys(fromClient?.groq ?? []),
      gemini: uniqKeys(fromClient?.gemini ?? []),
    };
  }
  return {
    openrouter: uniqKeys([
      ...(fromClient?.openrouter ?? []),
      process.env.OPENROUTER_API_KEY,
    ]),
    groq: uniqKeys([...(fromClient?.groq ?? []), process.env.GROQ_API_KEY]),
    gemini: uniqKeys([...(fromClient?.gemini ?? []), process.env.GEMINI_API_KEY]),
  };
}

export function openRouterConfigured(bundle?: AiKeyBundle | null): boolean {
  return resolveAiKeyBundle(bundle).openrouter.length > 0;
}

export function groqConfigured(bundle?: AiKeyBundle | null): boolean {
  return resolveAiKeyBundle(bundle).groq.length > 0;
}

export function geminiConfigured(bundle?: AiKeyBundle | null): boolean {
  return resolveAiKeyBundle(bundle).gemini.length > 0;
}

export function aiProviderConfigured(bundle?: AiKeyBundle | null): boolean {
  const b = resolveAiKeyBundle(bundle);
  return b.openrouter.length + b.groq.length + b.gemini.length > 0;
}

export function activeAiBackendLabel(bundle?: AiKeyBundle | null): string {
  const b = resolveAiKeyBundle(bundle);
  if (b.openrouter.length) return 'OpenRouter';
  if (b.groq.length) return 'Groq';
  if (b.gemini.length) return 'Gemini';
  return 'none';
}

export function openRouterFreeModels(): string[] {
  const raw = process.env.OPENROUTER_MODEL?.trim() || process.env.OPENROUTER_FREE_MODELS?.trim();
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [...DEFAULT_OPENROUTER_FREE_MODELS];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Shared rotator for one Filter CSV run.
 * Rate-limited keys cool down temporarily (free tiers reset), then become
 * usable again — they are not permanently killed for the rest of the job.
 */
export class AiKeyRotator {
  readonly bundle: AiKeyBundle;
  private orIdx = 0;
  private groqIdx = 0;
  private geminiIdx = 0;
  private coolUntilOr: number[] = [];
  private coolUntilGroq: number[] = [];
  private coolUntilGemini: number[] = [];
  rotations = 0;
  waits = 0;

  constructor(bundle: AiKeyBundle) {
    this.bundle = bundle;
    this.coolUntilOr = bundle.openrouter.map(() => 0);
    this.coolUntilGroq = bundle.groq.map(() => 0);
    this.coolUntilGemini = bundle.gemini.map(() => 0);
  }

  private pickReady(
    len: number,
    start: number,
    coolUntil: number[]
  ): number | null {
    if (len === 0) return null;
    const now = Date.now();
    for (let step = 0; step < len; step++) {
      const i = (start + step) % len;
      if (coolUntil[i] <= now) return i;
    }
    return null;
  }

  private soonestReady(coolUntil: number[]): number {
    if (!coolUntil.length) return 0;
    return Math.min(...coolUntil);
  }

  /** Wait until at least one key is ready (capped), or return null if none. */
  private async waitForReady(
    coolUntil: number[],
    maxWaitMs: number
  ): Promise<boolean> {
    if (!coolUntil.length) return false;
    const now = Date.now();
    if (coolUntil.some((t) => t <= now)) return true;
    const wait = Math.min(maxWaitMs, Math.max(0, this.soonestReady(coolUntil) - now));
    if (wait <= 0) return coolUntil.some((t) => t <= Date.now());
    this.waits++;
    await sleep(wait);
    return true;
  }

  async acquireOpenRouter(maxWaitMs = 20_000): Promise<{ key: string; index: number } | null> {
    const len = this.bundle.openrouter.length;
    if (!len) return null;
    let i = this.pickReady(len, this.orIdx, this.coolUntilOr);
    if (i == null) {
      if (!(await this.waitForReady(this.coolUntilOr, maxWaitMs))) return null;
      i = this.pickReady(len, this.orIdx, this.coolUntilOr);
    }
    if (i == null) return null;
    this.orIdx = i;
    return { key: this.bundle.openrouter[i], index: i };
  }

  /** @deprecated use acquireOpenRouter */
  currentOpenRouter(): { key: string; index: number } | null {
    const i = this.pickReady(this.bundle.openrouter.length, this.orIdx, this.coolUntilOr);
    if (i == null) return null;
    this.orIdx = i;
    return { key: this.bundle.openrouter[i], index: i };
  }

  markOpenRouterLimited(): void {
    this.rotations++;
    this.orIdx = (this.orIdx + 1) % Math.max(1, this.bundle.openrouter.length);
  }

  async acquireGroq(maxWaitMs = 15_000): Promise<{ key: string; index: number } | null> {
    const len = this.bundle.groq.length;
    if (!len) return null;
    let i = this.pickReady(len, this.groqIdx, this.coolUntilGroq);
    if (i == null) {
      if (!(await this.waitForReady(this.coolUntilGroq, maxWaitMs))) return null;
      i = this.pickReady(len, this.groqIdx, this.coolUntilGroq);
    }
    if (i == null) return null;
    this.groqIdx = i;
    return { key: this.bundle.groq[i], index: i };
  }

  currentGroq(): { key: string; index: number } | null {
    const i = this.pickReady(this.bundle.groq.length, this.groqIdx, this.coolUntilGroq);
    if (i == null) return null;
    this.groqIdx = i;
    return { key: this.bundle.groq[i], index: i };
  }

  markGroqLimited(): void {
    this.rotations++;
    this.groqIdx = (this.groqIdx + 1) % Math.max(1, this.bundle.groq.length);
  }

  async acquireGemini(maxWaitMs = 15_000): Promise<{ key: string; index: number } | null> {
    const len = this.bundle.gemini.length;
    if (!len) return null;
    let i = this.pickReady(len, this.geminiIdx, this.coolUntilGemini);
    if (i == null) {
      if (!(await this.waitForReady(this.coolUntilGemini, maxWaitMs))) return null;
      i = this.pickReady(len, this.geminiIdx, this.coolUntilGemini);
    }
    if (i == null) return null;
    this.geminiIdx = i;
    return { key: this.bundle.gemini[i], index: i };
  }

  currentGemini(): { key: string; index: number } | null {
    const i = this.pickReady(this.bundle.gemini.length, this.geminiIdx, this.coolUntilGemini);
    if (i == null) return null;
    this.geminiIdx = i;
    return { key: this.bundle.gemini[i], index: i };
  }

  markGeminiLimited(): void {
    this.rotations++;
    this.geminiIdx = (this.geminiIdx + 1) % Math.max(1, this.bundle.gemini.length);
  }

  summary(): string {
    return (
      `keys OR=${this.bundle.openrouter.length} Groq=${this.bundle.groq.length} Gemini=${this.bundle.gemini.length}` +
      `; rotations=${this.rotations}; cooldownWaits=${this.waits}`
    );
  }
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPracticePageText(
  url: string,
  fetchImpl: typeof fetch
): Promise<{ text: string; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { text: '', error: 'invalid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { text: '', error: 'unsupported URL scheme' };
  }

  try {
    const res = await fetchImpl(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'TorixLeadTool/1.0 (+provider-count; contact ops)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { text: '', error: `page HTTP ${res.status}` };
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype && !ctype.includes('html') && !ctype.includes('text') && !ctype.includes('xml')) {
      return { text: '', error: `non-HTML content-type ${ctype}` };
    }
    const raw = await res.text();
    const text = htmlToPlainText(raw).slice(0, MAX_PAGE_CHARS);
    if (text.length < 40) return { text: '', error: 'page text too short' };
    return { text };
  } catch (e) {
    return {
      text: '',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function buildProviderPrompt(
  input: ProviderCountInput,
  site: string,
  pageText: string
): string {
  const location = [input.city, input.state].filter(Boolean).join(', ');
  return [
    'You estimate how many clinical providers work at one US healthcare practice.',
    'Count only: physicians (MD/DO), dentists (DDS/DMD), NPs, and PAs.',
    'Do NOT count: hygienists, dental assistants, nurses (RN/LPN), front-desk, billing, or admin staff.',
    'Use ONLY the website text provided below (fetched from the practice site or Google Business Profile).',
    'Do not invent numbers from memory or from directory sites (Healthgrades, Zocdoc, etc.).',
    'If the text does not make the headcount clear, return providerCount as null.',
    'Respond with ONLY compact JSON: {"providerCount": <integer|null>, "evidence": "<short reason>"}',
    `Organization: ${input.organization}`,
    location ? `Location: ${location}` : '',
    `Source URL: ${site}`,
    '--- website text start ---',
    pageText,
    '--- website text end ---',
  ]
    .filter(Boolean)
    .join('\n');
}

function isRateLimitStatus(status: number): boolean {
  return status === 429 || status === 503;
}

async function askOpenRouter(
  prompt: string,
  rotator: AiKeyRotator,
  fetchImpl: typeof fetch
): Promise<ProviderCountResult> {
  // Try at most 2 free models — cycling all 4 per key made runs take ~1 hour.
  const models = openRouterFreeModels().slice(0, 2);
  const errors: string[] = [];
  let guard = 0;
  const maxAttempts = Math.max(2, rotator.bundle.openrouter.length) * 2;

  while (guard++ < maxAttempts) {
    const slot = await rotator.acquireOpenRouter(12_000);
    if (!slot) break;

    // Try every free model on this key before rotating — a 429 on one model
    // (often a shared free-tier pool saturated upstream) doesn't mean the key
    // itself is limited; another model in the list may still work right now.
    for (const model of models) {
      try {
        const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${slot.key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://torix-tool.local',
            'X-Title': process.env.OPENROUTER_APP_TITLE || 'Torix Lead Tool',
          },
          body: JSON.stringify({
            model,
            temperature: 0.1,
            max_tokens: 128,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: AbortSignal.timeout(25_000),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          errors.push(`key#${slot.index + 1}/${model} HTTP ${res.status}`);
          if (body) errors[errors.length - 1] += `: ${body.slice(0, 80)}`;
          continue;
        }

        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
          error?: { message?: string; code?: number };
        };
        if (data.error?.message) {
          errors.push(`key#${slot.index + 1}/${model}: ${data.error.message.slice(0, 100)}`);
          continue;
        }
        const text = data.choices?.[0]?.message?.content ?? '';
        if (!text.trim()) {
          errors.push(`key#${slot.index + 1}/${model}: empty`);
          continue;
        }
        return { ...parseProviderCountJson(text), backend: 'openrouter' };
      } catch (e) {
        errors.push(
          `key#${slot.index + 1}/${model}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    // Every model failed on this key — move to the next key (if any).
    rotator.markOpenRouterLimited();
  }

  return {
    providerCount: null,
    evidence: `OpenRouter failed — ${errors.slice(-2).join('; ') || 'no keys ready'}`,
    backend: 'openrouter',
  };
}

async function askGroq(
  prompt: string,
  rotator: AiKeyRotator,
  fetchImpl: typeof fetch
): Promise<ProviderCountResult> {
  const model = (process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL).trim();
  const errors: string[] = [];
  let guard = 0;
  const maxAttempts = Math.max(2, rotator.bundle.groq.length) * 3;

  while (guard++ < maxAttempts) {
    const slot = await rotator.acquireGroq();
    if (!slot) break;

    try {
      const res = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${slot.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 256,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(45_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        errors.push(`key#${slot.index + 1} HTTP ${res.status}`);
        if (isRateLimitStatus(res.status)) {
          rotator.markGroqLimited();
          continue;
        }
        if (body) errors[errors.length - 1] += `: ${body.slice(0, 80)}`;
        rotator.markGroqLimited();
        continue;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) {
        errors.push(`key#${slot.index + 1}: empty`);
        rotator.markGroqLimited();
        continue;
      }
      return { ...parseProviderCountJson(text), backend: 'groq' };
    } catch (e) {
      errors.push(`key#${slot.index + 1}: ${e instanceof Error ? e.message : String(e)}`);
      rotator.markGroqLimited();
    }
  }

  return {
    providerCount: null,
    evidence: `Groq failed — ${errors.slice(-2).join('; ') || 'no keys ready'}`,
    backend: 'groq',
  };
}

async function askGemini(
  prompt: string,
  rotator: AiKeyRotator,
  fetchImpl: typeof fetch
): Promise<ProviderCountResult> {
  const model = (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
  const errors: string[] = [];
  let guard = 0;
  const maxAttempts = Math.max(2, rotator.bundle.gemini.length) * 2;

  while (guard++ < maxAttempts) {
    const slot = await rotator.acquireGemini();
    if (!slot) break;

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(slot.key)}`;

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
        }),
        signal: AbortSignal.timeout(45_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        errors.push(`key#${slot.index + 1} HTTP ${res.status}`);
        if (isRateLimitStatus(res.status) || res.status === 403) {
          rotator.markGeminiLimited();
          continue;
        }
        if (body) errors[errors.length - 1] += `: ${body.slice(0, 80)}`;
        rotator.markGeminiLimited();
        continue;
      }

      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text.trim()) {
        errors.push(`key#${slot.index + 1}: empty`);
        rotator.markGeminiLimited();
        continue;
      }
      return { ...parseProviderCountJson(text), backend: 'gemini' };
    } catch (e) {
      errors.push(`key#${slot.index + 1}: ${e instanceof Error ? e.message : String(e)}`);
      rotator.markGeminiLimited();
    }
  }

  return {
    providerCount: null,
    evidence: `Gemini failed — ${errors.slice(-2).join('; ') || 'no keys ready'}`,
    backend: 'gemini',
  };
}

/**
 * Fetches practice page text, then asks OpenRouter → Groq → Gemini with key rotation.
 */
export async function lookupProviderCountWithAi(
  input: ProviderCountInput,
  fetchImpl: typeof fetch = fetch,
  rotator?: AiKeyRotator
): Promise<ProviderCountResult> {
  const rot = rotator ?? new AiKeyRotator(resolveAiKeyBundle());
  if (!aiProviderConfigured(rot.bundle)) {
    return {
      providerCount: null,
      evidence: 'No OpenRouter / Groq / Gemini API keys provided',
      backend: 'none',
    };
  }

  const site = (input.website || input.gbpWebsite || '').trim();
  if (!site) {
    return {
      providerCount: null,
      evidence: 'no website/GBP URL — keeping NPPES Providers',
      backend: 'none',
    };
  }

  const page = await fetchPracticePageText(site, fetchImpl);
  if (!page.text) {
    return {
      providerCount: null,
      evidence: page.error || 'could not fetch practice page',
      backend: 'none',
    };
  }

  const prompt = buildProviderPrompt(input, site, page.text);
  let lastFail = '';

  // Use one platform per row (OpenRouter preferred). Falling OR→Groq on every
  // miss roughly doubled runtime on free-tier rate limits.
  if (rot.bundle.openrouter.length) {
    const r = await askOpenRouter(prompt, rot, fetchImpl);
    if (r.providerCount != null) return r;
    if (!/^OpenRouter failed/i.test(r.evidence || '')) return r;
    lastFail = r.evidence || lastFail;
    // Only fall through to Groq when OpenRouter has no ready keys left this round.
    if (rot.currentOpenRouter()) {
      return { providerCount: null, evidence: lastFail || 'OpenRouter returned null', backend: 'openrouter' };
    }
  }
  if (rot.bundle.groq.length) {
    const r = await askGroq(prompt, rot, fetchImpl);
    if (r.providerCount != null) return r;
    if (!/^Groq failed/i.test(r.evidence || '')) return r;
    lastFail = r.evidence || lastFail;
  }
  if (rot.bundle.gemini.length) {
    return askGemini(prompt, rot, fetchImpl);
  }

  return {
    providerCount: null,
    evidence: lastFail || 'All AI backends exhausted or returned null',
    backend: 'none',
  };
}

/** @deprecated */
export async function lookupProviderCountWithGemini(
  input: ProviderCountInput,
  fetchImpl: typeof fetch = fetch
): Promise<ProviderCountResult> {
  return lookupProviderCountWithAi(input, fetchImpl);
}

export function parseProviderCountJson(text: string): ProviderCountResult {
  const trimmed = text.trim();
  const fenced = trimmed.match(/\{[\s\S]*\}/);
  const raw = fenced ? fenced[0] : trimmed;
  try {
    const parsed = JSON.parse(raw) as { providerCount?: unknown; evidence?: unknown };
    const n = parsed.providerCount;
    const count =
      typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 500
        ? Math.floor(n)
        : null;
    return {
      providerCount: count,
      evidence: typeof parsed.evidence === 'string' ? parsed.evidence.slice(0, 300) : '',
    };
  } catch {
    return { providerCount: null, evidence: 'unparseable AI response' };
  }
}

export const parseGeminiProviderJson = parseProviderCountJson;

export async function mapProviderCountLookups<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        await worker(items[index], index);
      }
    }
  );
  await Promise.all(runners);
}

export const mapGeminiProviderCounts = mapProviderCountLookups;

/** Parse JSON or newline/comma-separated keys from a form field. */
export function parseKeysField(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return uniqKeys(raw.map((x) => String(x)));
  }
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const t = raw.trim();
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed)) return uniqKeys(parsed.map((x) => String(x)));
    } catch {
      /* fall through */
    }
  }
  return uniqKeys(t.split(/[\n,]+/));
}
