"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Check, X, Search } from "lucide-react";
import classNames from "classnames";
import styles from "./StateSelect.module.css";
import { US_STATES, TOP_MARKETS, stateName, UsState } from "../../lib/usStates";

type Props = {
  /** Comma-separated codes, the shape the pipeline API already takes. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Shown when nothing is selected — some steps treat empty as "all states". */
  emptyLabel?: string;
};

/**
 * Multi-select for the NPPES location codes.
 *
 * Kept as a comma-separated string in and out so the pipeline routes, which parse
 * exactly that, did not need to change.
 */
export default function StateSelect({ value, onChange, disabled, emptyLabel = "No state selected" }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => value.split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
    [value]
  );
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Close on an outside click or Escape, the way a native select behaves.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const commit = (codes: string[]) => {
    // Keep the canonical file order rather than click order, so the label is stable.
    const ordered = US_STATES.filter(s => codes.includes(s.code)).map(s => s.code);
    onChange(ordered.join(","));
  };

  const toggle = (code: string) => {
    commit(selectedSet.has(code) ? selected.filter(c => c !== code) : [...selected, code]);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return US_STATES;
    return US_STATES.filter(
      s => s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
    );
  }, [query]);

  const grouped = useMemo(() => {
    const map = new Map<UsState["group"], UsState[]>();
    for (const s of filtered) {
      const list = map.get(s.group) ?? [];
      list.push(s);
      map.set(s.group, list);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const label =
    selected.length === 0
      ? emptyLabel
      : selected.length === 1
        ? `${stateName(selected[0])} (${selected[0]})`
        : `${selected.length} states selected`;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={classNames("input-base", styles.trigger, { [styles.triggerOpen]: open })}
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        aria-expanded={open}
      >
        <span className={classNames(styles.triggerLabel, { [styles.placeholder]: selected.length === 0 })}>
          {label}
        </span>
        <ChevronDown size={16} className={classNames(styles.chevron, { [styles.chevronOpen]: open })} />
      </button>

      {selected.length > 0 && (
        <div className={styles.chips}>
          {selected.map(code => (
            <span key={code} className={styles.chip}>
              {code}
              {!disabled && (
                <button
                  type="button"
                  className={styles.chipRemove}
                  onClick={() => toggle(code)}
                  aria-label={`Remove ${stateName(code)}`}
                >
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className={styles.panel}>
          <div className={styles.searchRow}>
            <Search size={14} />
            <input
              autoFocus
              className={styles.search}
              placeholder="Search state or code..."
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </div>

          <div className={styles.quickRow}>
            <button type="button" className={styles.quick} onClick={() => commit(TOP_MARKETS)}>
              Top 10 markets
            </button>
            <button
              type="button"
              className={styles.quick}
              onClick={() => commit(US_STATES.filter(s => s.group === "State").map(s => s.code))}
            >
              All 50 states
            </button>
            <button type="button" className={styles.quick} onClick={() => commit([])}>
              Clear
            </button>
          </div>

          <div className={styles.list}>
            {grouped.length === 0 && <div className={styles.empty}>No match for “{query}”</div>}
            {grouped.map(([group, items]) => (
              <div key={group}>
                <div className={styles.groupLabel}>{group}</div>
                {items.map(s => {
                  const isOn = selectedSet.has(s.code);
                  return (
                    <button
                      type="button"
                      key={s.code}
                      className={classNames(styles.option, { [styles.optionOn]: isOn })}
                      onClick={() => toggle(s.code)}
                    >
                      <span className={styles.checkbox}>{isOn && <Check size={12} />}</span>
                      <span className={styles.optionName}>{s.name}</span>
                      <span className={styles.optionCode}>{s.code}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {selected.length > 7 && (
            <div className={styles.warning}>
              {selected.length} states selected. Filtering groups results in memory —
              very large runs can get heavy.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
