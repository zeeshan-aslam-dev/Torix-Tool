"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./page.module.css";
import { FolderOpen, Play, CheckCircle2, RefreshCw, FileText, Flame, Globe, Users, Send, Download } from "lucide-react";
import classNames from "classnames";
import StateSelect from "../components/StateSelect";
import AreaFilter, { Area, EMPTY_AREA, areaToRequest } from "../components/AreaFilter";

const num = (value: number | undefined) => (value ?? 0).toLocaleString();
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const STEPS = [
  { id: 0, label: "Load NPPES" },
  { id: 1, label: "Filter & Score" },
  { id: 2, label: "Web Verify" },
  { id: 3, label: "Find Contacts" },
  { id: 4, label: "Send to Instantly" },
];

type DataFile = {
  name: string;
  dir: string;
  size: number;
  sizeLabel: string;
  modified: string;
};

type ScoreCounts = { HOT: number; VERIFY: number; EXCLUDE: number };

/** One NDJSON line from a streaming pipeline endpoint. */
type StreamEvent = {
  type: "log" | "progress" | "done" | "error";
  message?: string;
  stage?: string;
  rowsRead?: number;
  matched?: number;
  locations?: number;
  percent?: number;
  inserted?: number;
  updated?: number;
  total?: number;
  processed?: number;
  counts?: ScoreCounts;
  found?: number;
  emails?: number;
  sendable?: number;
  sent?: number;
  failed?: number;
  mode?: string;
  csv?: string | null;
  filename?: string;
};

export default function PipelinePage() {
  const [currentStep, setCurrentStep] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const [files, setFiles] = useState<DataFile[]>([]);
  const [dataDirs, setDataDirs] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [states, setStates] = useState("UT");
  const [taxonomy, setTaxonomy] = useState("111N00000X,152W00000X,207Q00000X");
  const [importMode, setImportMode] = useState<"merge" | "reset">("merge");
  const [area, setArea] = useState<Area>(EMPTY_AREA);

  const [verifyTags, setVerifyTags] = useState<string[]>(["HOT"]);
  const [verifyLimit, setVerifyLimit] = useState(100);
  const [minConfidence, setMinConfidence] = useState(40);
  const [concurrency, setConcurrency] = useState(5);
  const [useSerpApi, setUseSerpApi] = useState(false);
  const [useGbp, setUseGbp] = useState(false);
  const [recheck, setRecheck] = useState(false);

  const [contactTags, setContactTags] = useState<string[]>(["HOT"]);
  const [contactLimit, setContactLimit] = useState(500);
  const [minEmailConfidence, setMinEmailConfidence] = useState(45);
  const [scrapeWebsites, setScrapeWebsites] = useState(true);
  const [contactRecheck, setContactRecheck] = useState(false);
  const [verifyEmails, setVerifyEmails] = useState(true);
  const [allowRiskyEmails, setAllowRiskyEmails] = useState(false);

  const [sendTags, setSendTags] = useState<string[]>(["HOT"]);
  const [sendLimit, setSendLimit] = useState(500);
  const [sendMode, setSendMode] = useState<"csv" | "api">("csv");
  const [resend, setResend] = useState(false);
  const [csvReady, setCsvReady] = useState<{ csv: string; filename: string; rows: number } | null>(null);

  const [hotThreshold, setHotThreshold] = useState(55);
  const [verifyThreshold, setVerifyThreshold] = useState(30);
  const [maxLocations, setMaxLocations] = useState(21);
  const [counts, setCounts] = useState<ScoreCounts | null>(null);

  const addLog = (msg: string) =>
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  const loadFiles = useCallback(async () => {
    try {
      const res = await fetch("/api/pipeline/files", { cache: "no-store" });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setFiles(data.files);
      setDataDirs(data.dirs ?? []);
      setSelectedFile(prev =>
        prev && data.files.some((f: DataFile) => f.name === prev) ? prev : data.files[0]?.name ?? ""
      );
    } catch (e) {
      addLog(`Could not read the data folders: ${errorMessage(e)}`);
    }
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleNextStep = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  /**
   * POSTs to an NDJSON endpoint and feeds each event to `onEvent` as it arrives,
   * so a long-running import reports progress instead of hanging on one request.
   * Resolves true only when the server sent a `done` event.
   */
  const runStream = async (
    url: string,
    body: unknown,
    onEvent: (event: StreamEvent) => void
  ): Promise<boolean> => {
    setIsProcessing(true);
    let succeeded = false;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? "Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event: StreamEvent = JSON.parse(line);
          if (event.type === "done") succeeded = true;
          if (event.type === "error") addLog(`Error: ${event.message ?? "unknown"}`);
          onEvent(event);
        }
      }
    } catch (e) {
      addLog(`Error: ${errorMessage(e)}`);
    } finally {
      setIsProcessing(false);
    }

    return succeeded;
  };

  const runFilter = async () => {
    if (!selectedFile) {
      addLog("Select a CSV from the data folder first.");
      return;
    }

    addLog(`Starting filter on ${selectedFile}...`);

    const ok = await runStream(
      "/api/pipeline/filter",
      { fileName: selectedFile, states, taxonomy, mode: importMode, ...areaToRequest(area) },
      event => {
        if (event.type === "log" || event.type === "done") {
          addLog(event.message ?? "");
        } else if (event.stage === "insert") {
          addLog(
            `Saving: ${num(event.inserted)} new, ${num(event.updated)} updated / ${num(event.total)}`
          );
        } else if (event.type === "progress") {
          addLog(
            `Read ${num(event.rowsRead)} rows (${(event.percent ?? 0).toFixed(1)}%) — ` +
              `${num(event.matched)} matches, ${num(event.locations)} locations`
          );
        }
      }
    );

    if (ok) {
      setCounts(null);
      handleNextStep();
    }
  };

  const runScore = async () => {
    addLog(`Scoring leads with thresholds HOT >= ${hotThreshold}, VERIFY >= ${verifyThreshold}, max locations ${maxLocations}...`);
    setCounts(null);

    const ok = await runStream(
      "/api/pipeline/score",
      { hotThreshold, verifyThreshold, maxLocations, states, ...areaToRequest(area) },
      event => {
        if (event.type === "log" || event.type === "done") {
          addLog(event.message ?? "");
        } else if (event.type === "progress" && event.counts) {
          addLog(
            `Scored ${num(event.processed)} / ${num(event.total)} ` +
              `(${(event.percent ?? 0).toFixed(0)}%) — HOT ${num(event.counts.HOT)}, ` +
              `VERIFY ${num(event.counts.VERIFY)}, EXCLUDE ${num(event.counts.EXCLUDE)}`
          );
        }
        if (event.type === "done" && event.counts) setCounts(event.counts);
      }
    );

    // Scoring is meant to be re-run while tuning, so the step stays put on success.
    if (ok) addLog("Adjust the thresholds and re-run, or move on to Web Verify.");
  };

  const runVerify = async () => {
    if (verifyTags.length === 0) {
      addLog("Pick at least one tag to verify.");
      return;
    }

    addLog(`Verifying websites for ${verifyTags.join("/")} leads (limit ${verifyLimit})...`);

    await runStream(
      "/api/pipeline/verify",
      {
        tags: verifyTags, states, limit: verifyLimit, minConfidence, concurrency,
        useSerpApi, useGbp, recheck, ...areaToRequest(area),
      },
      event => {
        if (event.type === "log" || event.type === "done") {
          addLog(event.message ?? "");
        } else if (event.type === "progress") {
          addLog(
            `Checked ${num(event.processed)} / ${num(event.total)} (${(event.percent ?? 0).toFixed(0)}%) — ` +
              `${num(event.found)} websites found`
          );
        }
      }
    );
  };

  const runContacts = async () => {
    if (contactTags.length === 0) {
      addLog("Pick at least one tag.");
      return;
    }

    addLog(`Building contacts for ${contactTags.join("/")} leads...`);

    await runStream(
      "/api/pipeline/contacts",
      {
        tags: contactTags, states, limit: contactLimit,
        minEmailConfidence, scrapeWebsites, recheck: contactRecheck, concurrency,
        verifyEmails, allowRiskyEmails, ...areaToRequest(area),
      },
      event => {
        if (event.type === "log" || event.type === "done") {
          addLog(event.message ?? "");
        } else if (event.type === "progress") {
          addLog(
            `Processed ${num(event.processed)} / ${num(event.total)} (${(event.percent ?? 0).toFixed(0)}%) — ` +
              `${num(event.emails)} emails found, ${num(event.sendable)} sendable`
          );
        }
      }
    );
  };

  const runSend = async () => {
    if (sendTags.length === 0) {
      addLog("Pick at least one tag.");
      return;
    }

    addLog(`Preparing ${sendTags.join("/")} leads for ${sendMode === "api" ? "Instantly" : "CSV export"}...`);
    setCsvReady(null);

    await runStream(
      "/api/pipeline/send",
      {
        tags: sendTags, states, limit: sendLimit, mode: sendMode, resend, concurrency,
        allowRiskyEmails, ...areaToRequest(area),
      },
      event => {
        if (event.type === "log" || event.type === "done") {
          addLog(event.message ?? "");
        } else if (event.type === "progress") {
          addLog(
            `Processed ${num(event.processed)} / ${num(event.total)} (${(event.percent ?? 0).toFixed(0)}%)` +
              (event.sent !== undefined ? ` — sent ${num(event.sent)}, failed ${num(event.failed)}` : "")
          );
        }
        if (event.type === "done" && event.csv && event.filename) {
          setCsvReady({ csv: event.csv, filename: event.filename, rows: event.sent ?? 0 });
        }
      }
    );
  };

  const downloadCsv = () => {
    if (!csvReady) return;
    const blob = new Blob([csvReady.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvReady.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog(`Downloaded ${csvReady.filename}`);
  };

  const toggleSendTag = (tag: string) =>
    setSendTags(prev => (prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]));

  const toggleContactTag = (tag: string) =>
    setContactTags(prev => (prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]));

  const toggleTag = (tag: string) =>
    setVerifyTags(prev => (prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]));

  const simulateProcessing = async (stepId: number) => {
    setIsProcessing(true);
    addLog(`Starting ${STEPS[stepId].label}...`);

    // Simulate API work
    await new Promise(r => setTimeout(r, 2000));

    addLog(`Completed ${STEPS[stepId].label} successfully.`);
    setIsProcessing(false);
    handleNextStep();
  };

  const logPanel = (
    <div className={styles.logs}>
      {logs.length === 0 ? "Waiting to start..." : logs.map((l, i) => <div key={i}>{l}</div>)}
      {isProcessing && <div style={{ animation: "pulse 1.5s infinite" }}>Processing...</div>}
    </div>
  );

  return (
    <div className="page-container">
      <div className={styles.pipelineContainer}>
        <div>
          <h1>Lead Pipeline Runner</h1>
          <p style={{ color: 'var(--text-secondary)' }}>Process raw NPPES data down to verified hot leads ready for outreach.</p>
        </div>

        <div className={styles.stepper}>
          {STEPS.map((step) => (
            <div
              key={step.id}
              className={classNames(styles.step, {
                [styles.active]: currentStep === step.id,
                [styles.completed]: currentStep > step.id
              })}
              onClick={() => !isProcessing && setCurrentStep(step.id)}
              role="button"
              tabIndex={0}
            >
              <div className={styles.stepIcon}>
                {currentStep > step.id ? <CheckCircle2 size={20} /> : step.id + 1}
              </div>
              <div className={styles.stepLabel}>{step.label}</div>
            </div>
          ))}
        </div>

        <div className={`glass-panel ${styles.panel}`}>
          {currentStep === 0 && (
            <>
              <h2>Step 1: Pick Raw NPPES CSV</h2>
              <div className={styles.formGroup}>
                <label className={styles.label}>Target States</label>
                <StateSelect
                  value={states}
                  onChange={setStates}
                  disabled={isProcessing}
                  emptyLabel="Pick at least one state"
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.label}>Narrow the area (optional)</label>
                <AreaFilter
                  states={states}
                  value={area}
                  onChange={setArea}
                  disabled={isProcessing}
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.label}>Taxonomy Codes (comma-separated)</label>
                <input
                  type="text"
                  className="input-base"
                  value={taxonomy}
                  onChange={e => setTaxonomy(e.target.value)}
                  placeholder="e.g. 111N00000X"
                />
              </div>

              <div className={styles.formGroup}>
                <div className={styles.fileHeader}>
                  <label className={styles.label}>Source file (read from disk, never uploaded)</label>
                  <button className="btn" onClick={loadFiles} disabled={isProcessing}>
                    <RefreshCw size={14} /> Refresh
                  </button>
                </div>

                {files.length === 0 ? (
                  <div className={styles.fileDrop}>
                    <FolderOpen size={48} color="var(--brand-primary)" />
                    <div style={{ textAlign: 'center' }}>
                      <h3 style={{ margin: 0 }}>No CSV found</h3>
                      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
                        Drop a file into <code>data/</code>, or point <code>NPPES_DATA_DIR</code> in
                        <code> .env</code> at your dissemination folder, then hit Refresh.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className={styles.fileList}>
                    {files.map(file => (
                      <label
                        key={`${file.dir}/${file.name}`}
                        className={classNames(styles.fileItem, {
                          [styles.fileItemActive]: selectedFile === file.name,
                        })}
                      >
                        <input
                          type="radio"
                          name="dataFile"
                          checked={selectedFile === file.name}
                          onChange={() => setSelectedFile(file.name)}
                          disabled={isProcessing}
                        />
                        <FileText size={16} />
                        <span className={styles.fileName}>
                          {file.name}
                          <span className={styles.filePath}>{file.dir}</span>
                        </span>
                        <span className={styles.fileMeta}>{file.sizeLabel}</span>
                      </label>
                    ))}
                  </div>
                )}
                {dataDirs.length > 0 && (
                  <p className={styles.hint}>Scanning: {dataDirs.join("  •  ")}</p>
                )}
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>If a practice is already in the database</label>
                <div className={styles.modeChoice}>
                  <label
                    className={classNames(styles.modeOption, {
                      [styles.modeOptionActive]: importMode === "merge",
                    })}
                  >
                    <input
                      type="radio"
                      name="importMode"
                      checked={importMode === "merge"}
                      onChange={() => setImportMode("merge")}
                      disabled={isProcessing}
                    />
                    <span>
                      <strong>Update it</strong>
                      <span className={styles.modeHint}>
                        Refreshes the details from the file and adds anything new.
                        Scores, websites, contacts and send history are kept.
                      </span>
                    </span>
                  </label>

                  <label
                    className={classNames(styles.modeOption, styles.modeDanger, {
                      [styles.modeOptionActive]: importMode === "reset",
                    })}
                  >
                    <input
                      type="radio"
                      name="importMode"
                      checked={importMode === "reset"}
                      onChange={() => setImportMode("reset")}
                      disabled={isProcessing}
                    />
                    <span>
                      <strong>Start these states over</strong>
                      <span className={styles.modeHint}>
                        Deletes every lead in the selected states first, along with their
                        contacts and send history. The suppression list survives, so nothing
                        already emailed can be emailed again.
                      </span>
                    </span>
                  </label>
                </div>
              </div>

              {logPanel}

              <div className={styles.actionRow}>
                <button
                  className="btn btn-primary"
                  onClick={runFilter}
                  disabled={isProcessing || !selectedFile}
                >
                  {isProcessing ? 'Processing...' : <><Play size={16} /> Run Filter</>}
                </button>
              </div>
            </>
          )}

          {currentStep === 1 && (
            <>
              <h2>Step 2: Filter &amp; Score</h2>
              <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
                Scores every imported lead on business type, decision maker, size, data freshness
                and ownership, then tags it HOT, VERIFY or EXCLUDE. Individual providers (Entity
                Type 1) and anything the blocklist or a Step 3 web search flagged as part of
                another organisation are excluded outright, before any points are counted. Runs
                on data already in the database — no API keys, no cost, safe to re-run.
              </p>

              <div className={styles.thresholdRow}>
                <div className={styles.formGroup}>
                  <label className={styles.label}>HOT threshold (score &ge;)</label>
                  <input
                    type="number"
                    className="input-base"
                    min={0}
                    max={100}
                    value={hotThreshold}
                    onChange={e => setHotThreshold(Number(e.target.value))}
                    disabled={isProcessing}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label}>VERIFY threshold (score &ge;)</label>
                  <input
                    type="number"
                    className="input-base"
                    min={0}
                    max={100}
                    value={verifyThreshold}
                    onChange={e => setVerifyThreshold(Number(e.target.value))}
                    disabled={isProcessing}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label}>Max locations (chain cutoff)</label>
                  <input
                    type="number"
                    className="input-base"
                    min={2}
                    max={9999}
                    value={maxLocations}
                    onChange={e => setMaxLocations(Number(e.target.value))}
                    disabled={isProcessing}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label}>Limit to states</label>
                  <StateSelect
                    value={states}
                    onChange={setStates}
                    disabled={isProcessing}
                    emptyLabel="All states"
                  />
                </div>
              </div>

              {counts && (
                <div className={styles.scoreCards}>
                  <div className={classNames(styles.scoreCard, styles.hot)}>
                    <Flame size={18} />
                    <span className={styles.scoreValue}>{counts.HOT.toLocaleString()}</span>
                    <span className={styles.scoreLabel}>HOT</span>
                  </div>
                  <div className={classNames(styles.scoreCard, styles.verify)}>
                    <span className={styles.scoreValue}>{counts.VERIFY.toLocaleString()}</span>
                    <span className={styles.scoreLabel}>VERIFY</span>
                  </div>
                  <div className={classNames(styles.scoreCard, styles.exclude)}>
                    <span className={styles.scoreValue}>{counts.EXCLUDE.toLocaleString()}</span>
                    <span className={styles.scoreLabel}>EXCLUDE</span>
                  </div>
                </div>
              )}

              {logPanel}

              <div className={styles.actionRow}>
                <button className="btn" onClick={handleNextStep} disabled={isProcessing || !counts}>
                  Next step
                </button>
                <button className="btn btn-primary" onClick={runScore} disabled={isProcessing}>
                  {isProcessing ? 'Scoring...' : <><Play size={16} /> Run Scoring</>}
                </button>
              </div>
            </>
          )}

          {currentStep === 2 && (
            <>
              <h2>Step 3: Web Verify</h2>
              <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
                NPPES has no website field, so each site has to be found. Sources run
                cheapest first: domains already in the NPPES endpoint file, then guessed
                domains, then a paid search. A site is only saved once the page itself
                confirms the lead by phone, city, address or name.
              </p>

              <div className={styles.formGroup}>
                <label className={styles.label}>Verify leads tagged</label>
                <div className={styles.tagToggles}>
                  {(["HOT", "VERIFY", "EXCLUDE"] as const).map(tag => (
                    <label
                      key={tag}
                      className={classNames(styles.tagToggle, {
                        [styles.tagToggleActive]: verifyTags.includes(tag),
                      })}
                    >
                      <input
                        type="checkbox"
                        checked={verifyTags.includes(tag)}
                        onChange={() => toggleTag(tag)}
                        disabled={isProcessing}
                      />
                      {tag}
                    </label>
                  ))}
                </div>
              </div>

              <div className={styles.thresholdRow}>
                <div className={styles.formGroup}>
                  <label className={styles.label}>Max leads this run</label>
                  <input
                    type="number" className="input-base" min={1} max={5000}
                    value={verifyLimit}
                    onChange={e => setVerifyLimit(Number(e.target.value))}
                    disabled={isProcessing}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label}>Accept at confidence &ge;</label>
                  <input
                    type="number" className="input-base" min={0} max={100}
                    value={minConfidence}
                    onChange={e => setMinConfidence(Number(e.target.value))}
                    disabled={isProcessing}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label}>Parallel requests</label>
                  <input
                    type="number" className="input-base" min={1} max={20}
                    value={concurrency}
                    onChange={e => setConcurrency(Number(e.target.value))}
                    disabled={isProcessing}
                  />
                </div>
              </div>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox" checked={recheck}
                  onChange={e => setRecheck(e.target.checked)}
                  disabled={isProcessing}
                />
                Re-check leads that already have a result
              </label>

              <div className={styles.formGroup}>
                <label className={styles.label}>Area</label>
                <AreaFilter
                  states={states}
                  value={area}
                  onChange={setArea}
                  disabled={isProcessing}
                />
              </div>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox" checked={useSerpApi}
                  onChange={e => setUseSerpApi(e.target.checked)}
                  disabled={isProcessing}
                />
                Use paid search for whatever the free sources miss (needs <code>SERPER_KEY</code> or{' '}
                <code>SERPAPI_KEY</code> in <code>.env</code>)
              </label>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox" checked={useGbp}
                  onChange={e => setUseGbp(e.target.checked)}
                  disabled={isProcessing || !useSerpApi}
                />
                Also look up the Google Business Profile — adds rating, category and a
                &ldquo;permanently closed&rdquo; flag. <strong>Costs one extra query per
                unresolved lead.</strong>
              </label>

              {logPanel}

              <div className={styles.actionRow}>
                <button className="btn" onClick={handleNextStep} disabled={isProcessing}>
                  Next step
                </button>
                <button className="btn btn-primary" onClick={runVerify} disabled={isProcessing}>
                  {isProcessing ? 'Checking...' : <><Globe size={16} /> Run Web Verify</>}
                </button>
              </div>
            </>
          )}

          {currentStep === 3 && (
            <>
              <h2>Step 4: Find Contacts</h2>
              <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
                Builds a contact per lead from free sources. The NPPES authorized
                official supplies a name, title and phone for every organization.
                Email is not in NPPES at all, so it is scraped from the practice&apos;s
                own site for the leads where Step 3 found one, then verified before
                it is allowed anywhere near Step 5.
              </p>

              <div className={styles.formGroup}>
                <label className={styles.label}>Build contacts for leads tagged</label>
                <div className={styles.tagToggles}>
                  {(["HOT", "VERIFY", "EXCLUDE"] as const).map(tag => (
                    <label
                      key={tag}
                      className={classNames(styles.tagToggle, {
                        [styles.tagToggleActive]: contactTags.includes(tag),
                      })}
                    >
                      <input
                        type="checkbox"
                        checked={contactTags.includes(tag)}
                        onChange={() => toggleContactTag(tag)}
                        disabled={isProcessing}
                      />
                      {tag}
                    </label>
                  ))}
                </div>
              </div>

              <div className={styles.thresholdRow}>
                <div className={styles.formGroup}>
                  <label className={styles.label}>Max leads this run</label>
                  <input
                    type="number" className="input-base" min={1} max={5000}
                    value={contactLimit}
                    onChange={e => setContactLimit(Number(e.target.value))}
                    disabled={isProcessing}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label}>Accept email at confidence &ge;</label>
                  <input
                    type="number" className="input-base" min={0} max={100}
                    value={minEmailConfidence}
                    onChange={e => setMinEmailConfidence(Number(e.target.value))}
                    disabled={isProcessing}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label}>Parallel requests</label>
                  <input
                    type="number" className="input-base" min={1} max={20}
                    value={concurrency}
                    onChange={e => setConcurrency(Number(e.target.value))}
                    disabled={isProcessing}
                  />
                </div>
              </div>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox" checked={scrapeWebsites}
                  onChange={e => setScrapeWebsites(e.target.checked)}
                  disabled={isProcessing}
                />
                Scrape practice websites for email and LinkedIn
              </label>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox" checked={contactRecheck}
                  onChange={e => setContactRecheck(e.target.checked)}
                  disabled={isProcessing}
                />
                Re-check leads that already have a contact
              </label>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox" checked={verifyEmails}
                  onChange={e => setVerifyEmails(e.target.checked)}
                  disabled={isProcessing}
                />
                Verify each address before accepting it — syntax and MX are free;{' '}
                <code>MILLIONVERIFIER_KEY</code> adds the mailbox-level check
              </label>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox" checked={allowRiskyEmails}
                  onChange={e => setAllowRiskyEmails(e.target.checked)}
                  disabled={isProcessing || !verifyEmails}
                />
                Allow catch-all and unknown addresses through (higher volume, higher bounce risk)
              </label>

              {logPanel}

              <div className={styles.actionRow}>
                <button className="btn" onClick={handleNextStep} disabled={isProcessing}>
                  Next step
                </button>
                <button className="btn btn-primary" onClick={runContacts} disabled={isProcessing}>
                  {isProcessing ? 'Working...' : <><Users size={16} /> Run Find Contacts</>}
                </button>
              </div>
            </>
          )}

          {currentStep === 4 && (
            <>
              <h2>Step 5: Send to Instantly</h2>
              <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
                Only leads that have an email address go out — Instantly is an email
                channel. Leads already queued or sent are skipped, so running this
                twice cannot mail the same practice twice.
              </p>

              <div className={styles.formGroup}>
                <label className={styles.label}>Send leads tagged</label>
                <div className={styles.tagToggles}>
                  {(["HOT", "VERIFY", "EXCLUDE"] as const).map(tag => (
                    <label
                      key={tag}
                      className={classNames(styles.tagToggle, {
                        [styles.tagToggleActive]: sendTags.includes(tag),
                      })}
                    >
                      <input
                        type="checkbox"
                        checked={sendTags.includes(tag)}
                        onChange={() => toggleSendTag(tag)}
                        disabled={isProcessing}
                      />
                      {tag}
                    </label>
                  ))}
                </div>
              </div>

              <div className={styles.thresholdRow}>
                <div className={styles.formGroup}>
                  <label className={styles.label}>Max leads this run</label>
                  <input
                    type="number" className="input-base" min={1} max={5000}
                    value={sendLimit}
                    onChange={e => setSendLimit(Number(e.target.value))}
                    disabled={isProcessing}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label}>Delivery</label>
                  <select
                    className="input-base"
                    value={sendMode}
                    onChange={e => setSendMode(e.target.value as "csv" | "api")}
                    disabled={isProcessing}
                  >
                    <option value="csv">CSV export (no API key needed)</option>
                    <option value="api">Instantly API (needs INSTANTLY_API_KEY)</option>
                  </select>
                </div>
              </div>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox" checked={resend}
                  onChange={e => setResend(e.target.checked)}
                  disabled={isProcessing}
                />
                Re-send leads already queued or sent
              </label>

              {csvReady && (
                <div className={styles.csvReady}>
                  <div>
                    <strong>{csvReady.filename}</strong>
                    <div className={styles.hint}>
                      {csvReady.rows.toLocaleString()} leads, ready to import into Instantly
                    </div>
                  </div>
                  <button className="btn btn-primary" onClick={downloadCsv}>
                    <Download size={16} /> Download CSV
                  </button>
                </div>
              )}

              {logPanel}

              <div className={styles.actionRow}>
                <button className="btn btn-primary" onClick={runSend} disabled={isProcessing}>
                  {isProcessing ? 'Working...' : <><Send size={16} /> Run Send to Instantly</>}
                </button>
              </div>
            </>
          )}

          {currentStep > 4 && (
            <>
              <h2>Ready for {STEPS[currentStep].label}</h2>
              <p style={{ color: 'var(--text-secondary)' }}>
                Not built yet — this button still simulates the work. See Steps 3-5 in the plan.
              </p>
              {logPanel}
              <div className={styles.actionRow}>
                <button
                  className="btn btn-primary"
                  onClick={() => simulateProcessing(currentStep)}
                  disabled={isProcessing}
                >
                  {isProcessing ? 'Processing...' : <><Play size={16} /> Run {STEPS[currentStep].label}</>}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
