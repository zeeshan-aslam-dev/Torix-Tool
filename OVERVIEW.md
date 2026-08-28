# Torix Lead Engine — Technical Overview

Turning an 11 GB government dump into a call list.

CMS publishes every licensed US healthcare provider as a single flat CSV — **9.7M rows,
330 columns, no emails, no websites, no index**. This reads the whole thing in about 30
seconds, scores what survives the filter, resolves each practice to a live site, and hands
back rows with a named owner and a working phone number.

**Stack:** Next.js 14 (App Router) · TypeScript · Prisma + SQLite · NDJSON streaming ·
SerpAPI · Instantly v2

---

## Measured, not estimated

Every figure comes from a run against the real August 2026 dissemination file. Nothing here
is projected except where it says so.

| Metric | Value | Context |
|---|---|---|
| Full scan | **31s** | 9,726,865 rows, single state filter |
| Peak RSS | **312 MB** | 5-state run, production build |
| Parse rate | **31k rows/s** | 3× faster than `csv-parser` |
| Site resolution | **66%** | up from 12% on free sources |
| Name + phone | **100%** | on every shortlisted lead |
| Unit tests | **77** | scoring, extraction, CSV, blocklist |

---

## The pipeline

Five stages, each its own route. All stream NDJSON back to the browser, so a thirty-minute
import reports progress instead of hanging on one request.

### 01 · Ingest — working

Line-by-line read with a hand-rolled CSV splitter. Building a 330-key object per row was
the bottleneck, so rows become arrays and columns are read by index. A cheap substring
pre-filter rejects lines without the target state before the split runs at all. Rows are
grouped into one lead per practice location.

```
9,726,865 rows scanned in 31s
    4,571 matching providers
    4,553 distinct practice locations
```

### 02 · Score — working

A pure function over the ingested fields: business type, decision-maker seniority, location
count, providers per site, record freshness, ownership flags. Weights are explicit and every
lead stores **the sentence explaining its own score**. Named health systems are disqualified
outright by a blocklist, independent of points.

```
HOT 345  |  VERIFY 1,017  |  EXCLUDE 3,191
118 removed by the hospital blocklist
scored in 2.1s
```

### 03 · Resolve website — working

Three sources, cheapest first: NPPES electronic endpoints, then domain guessing from the
trade name, then SerpAPI. Each candidate is fetched and scored against the lead's own phone,
city, zip and street number, so a domain only counts as confirmed when the page proves it.
**Paid search only fires on what the free tiers failed to resolve.**

```
found 66 | bot-blocked 12 | parked 1 | none 21
by source — endpoint 2, guessed 12, search 52
86 paid queries per 100 leads
```

### 04 · Contacts — working

Name, title and phone come free from the NPI record's authorized official. Email does not
exist in the source at all, so it is scraped from the resolved site — mailto links and
contact pages, then ranked. An address matching the decision maker outranks a generic office
inbox; placeholder and wrong-department addresses are dropped.

```
100%  jennymckaynp@mckayfamilypractice.com
      Jenny Mckay · NP/Owner · (801) 210-2445
 95%  office@revivesportspine.com
      Andrew Reheisse · Owner
```

### 05 · Send — working

Instantly v2 when a key is present, CSV export in Instantly's import shape otherwise.
Suppression is checked before every push and written after — **keyed on both address and
practice, in a table with no relation to `Lead`** — so no re-import or reset can erase the
fact that someone was already contacted.

---

## Decisions worth knowing about

### Practice identity, not NPI

Leads are keyed on a normalised `org + address` composite, not the NPI. NPPES spells the
same company three ways across its own rows — `IHC HEALTH SERVICES INC`, `IHC HEALTH
SERVICES, INC`, `IHC HEALTH SERVICES, INC.` — which split one 93-location chain into four
small ones and let it score as an independent practice. Normalising the name fixed the
location counts and the scoring at the same time.

### Imports upsert, they do not replace

The original import deleted the target states and reinserted them, which cascaded through
contacts and outreach and **silently destroyed the send history** — the exact records the
no-duplicate-contact rule depends on. Re-import now updates in place and leaves scores,
websites and contacts untouched. The destructive path still exists, but it is an explicit
choice and it reports what it removed.

### Free sources exhausted before paid ones

Website resolution runs endpoint domains and name guessing before it touches SerpAPI, and
stops as soon as confidence clears the threshold. On a 100-lead run that meant 86 paid
queries rather than 100, and re-runs skip anything already resolved. The same ordering will
apply to enrichment: **a domain has to exist before it is worth paying to look up who works
there.**

### Extraction is ranked, not collected

Both the email finder and the acquisition detector return a confidence and the evidence
behind it, not a boolean. The first acquisition detector matched the bare phrase "part of"
and produced **15 false positives out of 15** on live pages — testimonials, cookie banners,
inline JavaScript. It now requires a plausible organisation name after the phrase and strips
script bodies first. Same run, zero false positives.

---

## Scale and cost

Lead volume scales linearly. Paid lookups are largely a one-time cost per practice, since a
resolved website is not searched again.

| Scope | Providers | Shortlisted | Note |
|---|---|---|---|
| 1 state (UT) | 4,571 | 345 | measured |
| 5 states | 34,777 | 3,020 | measured — UT, NV, ID, AZ, CO |
| All 50 states | 496,341 | ~37,500 | projected from a full-file count |

| Service | Role | Monthly |
|---|---|---|
| SerpAPI / Serper | website resolution | $50 |
| Email finder | domain → addresses | $20–50 |
| Verifier | bounce protection | ~$1 |
| Instantly | sending + reply tracking | $40–200 |
| Mailboxes + domains | deliverability | $10–105 |
| VPS | hosting | $6–40 |

Roughly **$150–250/month** at 2,000 sends, **$300–450** at 10,000. A first national pass adds
**$500–800 one-time** for the initial resolution and enrichment sweep. Vendor pricing should
be re-checked before committing — it moves.

---

## Known limits

Stated plainly, because these shape what can be promised.

**Email coverage** — The source file contains **no email column at all**. Addresses come only
from resolved websites, so coverage tracks site resolution and stays well below phone
coverage. Phone is 100%; treat this as a phone-first dataset.

**Record staleness** — **41% of NPI records were last updated 10+ years ago.** Scoring
penalises age, but no API can confirm the named official is still there. Nothing fixes this;
it is the source data.

**Verify throughput** — 2.7s per lead at concurrency 4. Fine for a few thousand, **roughly 28
hours for a national run**. Needs a resumable queue before that is attempted.

**In-memory grouping** — Location grouping happens in a `Map` before the write. Comfortable to
~35k leads; a national pass needs chunked flushing and Postgres rather than SQLite.

**No auth yet** — There is no login. Bind to localhost behind an SSH tunnel, or put basic auth
in front, until a real session layer lands.

**Deliverability** — Volume is capped by sending infrastructure, not by the tool. 10k sends a
month means 10–15 warmed domains and mailboxes — **a separate build from this one.**

---

## What is still stubbed

| Area | State | What is missing |
|---|---|---|
| CRM table | Partial | Schema holds every column; the UI shows six, capped at 50 rows. No sorting, filtering or inline editing. |
| Pipeline stages | Partial | Field exists with all seven stages; nothing writes to it. |
| Dialer | Partial | Renders a lead and a call script. The buttons do not persist an outcome. |
| Reply queue | Not built | Needs the Instantly webhook, a draft table, and an approval screen. Nothing auto-sends by design. |
| Invoicing | Not built | `Client` model exists and has never held a row. No conversion trigger, no ledger, no PDF. |
| Scheduling | Not built | No headless runner and no cron; every stage is triggered from the UI. |

---

## Repository map

```
app/
  api/pipeline/
    files/      list CSVs in the data folders
    filter/     stage 01 — ingest, group, upsert
    score/      stage 02 — scoring + blocklist
    verify/     stage 03 — website resolution
    contacts/   stage 04 — decision maker + email
    send/       stage 05 — Instantly / CSV + suppression
  pipeline/     the five-stage runner UI
  crm/ dialer/ clients/    read-only today
  components/StateSelect   multi-state picker

lib/
  nppes.ts      CSV splitter, header index, name normalisation, lead keys
  scoring.ts    pure scoring function
  blocklist.ts  health-system matching
  webVerify.ts  candidate domains, page match scoring, acquisition detection
  serpapi.ts    paid search, directory filtering
  contacts.ts   email extraction and ranking
  instantly.ts  CSV builder + Instantly v2 client
  dataDir.ts    resolves data folders, path-traversal guard
  usStates.ts   NPPES location codes

config/hospital-blocklist.json   editable, reloaded on change
scripts/backfillLeadKeys.ts      one-time migration
prisma/schema.prisma             Lead, Contact, Outreach, ResponseLog, Client, Suppression
```

---

## Running it

```bash
npm ci
npx prisma generate && npx prisma db push
npm run build && npm start
```

`.env` — copy from `.env.example`:

```
DATABASE_URL="file:./dev.db"
NPPES_DATA_DIR="/path/to/NPPES_Data_Dissemination_..."   # keeps the 11 GB file out of the repo
SERPAPI_KEY=
APOLLO_API_KEY=
INSTANTLY_API_KEY=
INSTANTLY_CAMPAIGN_ID=
```

Behind nginx, the long streaming runs need:

```nginx
proxy_read_timeout 3600s;
proxy_buffering off;
```

Without those, a scan is cut off mid-run and live progress arrives only at the end.

---

*Figures measured against the August 2026 NPPES dissemination file published by CMS.
Public business registry data only — no patient information is read, stored or transmitted.*
