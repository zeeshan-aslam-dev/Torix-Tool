'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Plus, Trash2, X } from 'lucide-react';
import styles from './page.module.css';

export type AiKeysState = {
  openrouter: string[];
  groq: string[];
  gemini: string[];
};

const STORAGE_KEY = 'torix.aiKeys.v1';

export const EMPTY_AI_KEYS: AiKeysState = {
  openrouter: [''],
  groq: [''],
  gemini: [''],
};

export function loadAiKeysFromStorage(): AiKeysState {
  if (typeof window === 'undefined') return EMPTY_AI_KEYS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_AI_KEYS;
    const parsed = JSON.parse(raw) as Partial<AiKeysState>;
    return {
      openrouter: Array.isArray(parsed.openrouter) && parsed.openrouter.length ? parsed.openrouter : [''],
      groq: Array.isArray(parsed.groq) && parsed.groq.length ? parsed.groq : [''],
      gemini: Array.isArray(parsed.gemini) && parsed.gemini.length ? parsed.gemini : [''],
    };
  } catch {
    return EMPTY_AI_KEYS;
  }
}

export function saveAiKeysToStorage(keys: AiKeysState): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

/** Non-empty trimmed keys ready to send to the API. */
export function compactAiKeys(keys: AiKeysState): AiKeysState {
  const clean = (arr: string[]) => arr.map((k) => k.trim()).filter(Boolean);
  return {
    openrouter: clean(keys.openrouter),
    groq: clean(keys.groq),
    gemini: clean(keys.gemini),
  };
}

export function countAiKeys(keys: AiKeysState): number {
  const c = compactAiKeys(keys);
  return c.openrouter.length + c.groq.length + c.gemini.length;
}

type Props = {
  open: boolean;
  initial: AiKeysState;
  onClose: () => void;
  onSave: (keys: AiKeysState) => void;
};

function KeyPlatformBlock({
  title,
  hint,
  values,
  onChange,
}: {
  title: string;
  hint: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className={styles.aiKeyPlatform}>
      <div className={styles.aiKeyPlatformHead}>
        <strong>{title}</strong>
        <span className={styles.hint}>{hint}</span>
      </div>
      {values.map((value, i) => (
        <div key={i} className={styles.aiKeyRow}>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={styles.aiKeyInput}
            placeholder={`${title} API key #${i + 1}`}
            value={value}
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              onChange(next);
            }}
          />
          <button
            type="button"
            className="btn"
            title="Remove key"
            disabled={values.length <= 1 && !value}
            onClick={() => {
              if (values.length <= 1) onChange(['']);
              else onChange(values.filter((_, j) => j !== i));
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => onChange([...values, ''])}
      >
        <Plus size={14} /> Add another {title} key
      </button>
    </div>
  );
}

export default function AiKeysModal({ open, initial, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<AiKeysState>(initial);

  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  if (!open) return null;

  const save = () => {
    const next = {
      openrouter: draft.openrouter.length ? draft.openrouter : [''],
      groq: draft.groq.length ? draft.groq : [''],
      gemini: draft.gemini.length ? draft.gemini : [''],
    };
    saveAiKeysToStorage(next);
    onSave(next);
    onClose();
  };

  return (
    <div className={styles.aiKeyOverlay} role="dialog" aria-modal="true" aria-labelledby="ai-keys-title">
      <div className={styles.aiKeyModal}>
        <div className={styles.aiKeyModalHead}>
          <div>
            <h2 id="ai-keys-title">
              <KeyRound size={18} style={{ marginRight: 8, verticalAlign: 'text-bottom' }} />
              AI API keys
            </h2>
            <p className={styles.hint} style={{ margin: '6px 0 0' }}>
              Add multiple keys per platform. On rate limits the server rotates to the next key
              (OpenRouter → Groq → Gemini). Stored only in this browser (localStorage), not in
              the repo. Keys are sent with each Filter CSV run.
            </p>
          </div>
          <button type="button" className="btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className={styles.aiKeyModalBody}>
          <KeyPlatformBlock
            title="OpenRouter"
            hint="Preferred for free models (e.g. Gemma 4 31B)"
            values={draft.openrouter}
            onChange={(openrouter) => setDraft((d) => ({ ...d, openrouter }))}
          />
          <KeyPlatformBlock
            title="Groq"
            hint="Fallback when OpenRouter is rate-limited"
            values={draft.groq}
            onChange={(groq) => setDraft((d) => ({ ...d, groq }))}
          />
          <KeyPlatformBlock
            title="Gemini"
            hint="Last fallback (needs a working Google API project)"
            values={draft.gemini}
            onChange={(gemini) => setDraft((d) => ({ ...d, gemini }))}
          />
        </div>

        <div className={styles.aiKeyModalFoot}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            Save keys
          </button>
        </div>
      </div>
    </div>
  );
}
