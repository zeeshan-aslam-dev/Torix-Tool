'use client';

import { useState } from 'react';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import styles from '../pipeline/page.module.css';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function downloadCsvFile(payload: { csv: string; filename: string }) {
  const blob = new Blob([payload.csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = payload.filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function CsvFormatPage() {
  const [file, setFile] = useState<File | null>(null);
  const [merge, setMerge] = useState(true);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [ready, setReady] = useState<{ csv: string; filename: string; rows: number } | null>(null);

  const addLog = (line: string) =>
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${line}`]);

  const runFormat = async () => {
    if (!file) {
      addLog('Pick a CSV file first.');
      return;
    }
    setBusy(true);
    setReady(null);
    addLog(`Formatting ${file.name} into dialer columns…`);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('merge', merge ? 'true' : 'false');
      const res = await fetch('/api/pipeline/format-csv', { method: 'POST', body: form });
      const raw = await res.text();
      let data: {
        error?: string;
        csv?: string;
        filename?: string;
        kept?: number;
        message?: string;
      };
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Server returned non-JSON (HTTP ${res.status})`);
      }
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setReady({
        csv: data.csv ?? '',
        filename: data.filename ?? 'dialer-format.csv',
        rows: data.kept ?? 0,
      });
      addLog(data.message ?? `Formatted ${data.kept} rows.`);
    } catch (e) {
      addLog(`Error: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-container">
      <div className={styles.pipelineContainer}>
        <div>
          <h1>CSV Format Fix</h1>
          <p style={{ color: 'var(--text-secondary)' }}>
            Rewrite an old contacts CSV into dialer column order — no size filter, no AI, no row drops
            for missing NPPES matches.
          </p>
        </div>

        <div className={`glass-panel ${styles.panel}`}>
          <div className={styles.csvUpload}>
            <div>
              <strong>Upload contacts CSV</strong>
              <div className={styles.hint}>
                Output front columns: NPI, Practice_Name, Authorized_Person, Authorized_Title, Phone,
                Address, City, State, ZIP, taxonomy, Enumeration_Date, Time_Zone, PKT_Call_Window —
                then Providers, Email, Website, and the rest. Maps legacy names (Organization →
                Practice_Name, Decision Maker Name → Authorized_Person, Specialty → taxonomy, …).
              </div>
              <input
                type="file"
                accept=".csv,text/csv"
                className={styles.fileInput}
                disabled={busy}
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setReady(null);
                }}
              />
              <label className={styles.checkboxRow} style={{ marginTop: 12 }}>
                <input
                  type="checkbox"
                  checked={merge}
                  onChange={(e) => setMerge(e.target.checked)}
                  disabled={busy}
                />
                Merge same-org dual owners and same-owner dual orgs
              </label>
            </div>
            <button className="btn btn-primary" onClick={runFormat} disabled={busy || !file}>
              {busy ? (
                'Formatting…'
              ) : (
                <>
                  <FileSpreadsheet size={16} /> Format CSV
                </>
              )}
            </button>
          </div>

          {ready && (
            <div className={styles.csvReady}>
              <div>
                <strong>{ready.filename}</strong>
                <div className={styles.hint}>{ready.rows.toLocaleString()} rows formatted</div>
              </div>
              <button className="btn btn-primary" onClick={() => downloadCsvFile(ready)}>
                <Download size={16} /> Download Formatted CSV
              </button>
            </div>
          )}

          <div className={styles.logs}>
            {log.length === 0 ? 'Waiting for upload…' : log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
