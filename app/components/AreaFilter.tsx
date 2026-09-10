"use client";

import { useEffect, useState } from "react";
import { MapPin, AlertTriangle, Loader2 } from "lucide-react";
import styles from "./AreaFilter.module.css";

export type Area = {
  cities: string;
  zips: string;
  radiusZip: string;
  radiusMiles: string;
};

export const EMPTY_AREA: Area = { cities: "", zips: "", radiusZip: "", radiusMiles: "" };

/** The shape every pipeline route accepts, so callers can spread it into a body. */
export function areaToRequest(area: Area) {
  return {
    cities: area.cities,
    zips: area.zips,
    radiusZip: area.radiusZip,
    radiusMiles: area.radiusMiles ? Number(area.radiusMiles) : undefined,
  };
}

type Preview = {
  description: string;
  warnings: string[];
  leadsImported: number;
  hotLeads: number;
  radius: { center: string; miles: number; matched: number } | null;
};

type Props = {
  states: string;
  value: Area;
  onChange: (area: Area) => void;
  disabled?: boolean;
};

/**
 * City, ZIP and radius narrowing, on top of the state picker.
 *
 * A radius is entered as two numbers and silently becomes a list of dozens of
 * ZIPs, so the preview is not decoration: without it the scope is invisible until
 * a run has already spent queries against it.
 */
export default function AreaFilter({ states, value, onChange, disabled }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);

  const set = (patch: Partial<Area>) => onChange({ ...value, ...patch });

  const { cities, zips, radiusZip, radiusMiles } = value;

  useEffect(() => {
    // Debounced: this fires on every keystroke and the route hits the database.
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/pipeline/scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            states,
            cities,
            zips,
            radiusZip,
            radiusMiles: radiusMiles ? Number(radiusMiles) : undefined,
          }),
        });
        setPreview(res.ok ? await res.json() : null);
      } catch {
        setPreview(null);
      } finally {
        setLoading(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [states, cities, zips, radiusZip, radiusMiles]);

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Cities (comma-separated)</label>
          <input
            type="text"
            className="input-base"
            placeholder="PROVO, OREM"
            value={cities}
            onChange={e => set({ cities: e.target.value })}
            disabled={disabled}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>ZIP codes</label>
          <input
            type="text"
            className="input-base"
            placeholder="84074, 84601, 840*"
            value={zips}
            onChange={e => set({ zips: e.target.value })}
            disabled={disabled}
          />
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Within radius of ZIP</label>
          <input
            type="text"
            className="input-base"
            placeholder="84074"
            value={radiusZip}
            onChange={e => set({ radiusZip: e.target.value })}
            disabled={disabled}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Miles</label>
          <input
            type="number"
            className="input-base"
            min={1}
            max={500}
            placeholder="25"
            value={radiusMiles}
            onChange={e => set({ radiusMiles: e.target.value })}
            disabled={disabled}
          />
        </div>
      </div>

      <p className={styles.hint}>
        Leave all four blank to use the states above on their own. A trailing{" "}
        <code>*</code> matches a ZIP prefix, so <code>840*</code> covers the whole
        840xx range.
      </p>

      <div className={styles.preview}>
        {loading && !preview ? (
          <span className={styles.muted}>
            <Loader2 size={13} className={styles.spin} /> checking...
          </span>
        ) : preview ? (
          <>
            <span className={styles.scope}>
              <MapPin size={13} /> {preview.description}
            </span>
            <span className={styles.counts}>
              {preview.leadsImported.toLocaleString()} imported ·{" "}
              <strong>{preview.hotLeads.toLocaleString()} HOT</strong>
            </span>
          </>
        ) : (
          <span className={styles.muted}>preview unavailable</span>
        )}
      </div>

      {preview?.warnings.map(warning => (
        <p key={warning} className={styles.warning}>
          <AlertTriangle size={13} /> {warning}
        </p>
      ))}

      {preview && preview.leadsImported === 0 && (
        <p className={styles.warning}>
          <AlertTriangle size={13} /> Nothing imported for this area yet — run Step 1
          with it selected first.
        </p>
      )}
    </div>
  );
}
