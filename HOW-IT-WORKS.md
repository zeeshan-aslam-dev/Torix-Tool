# Torix Tool — Paid Key Lagne Ke Baad Ki Working

Ye document batata hai ke SerpAPI ki paid key `.env` me lagne ke baad tool **poora kya karta hai**, kaun sa hissa kaun si service se chalta hai, aur data kis raaste se guzarta hai.

Har number asal run se measured hai — projections alag se mark hain.

---

## Abhi ki position

| | |
|---|---|
| Code | ✅ poora ready, tests pass |
| Data | ✅ pura US (all 51 states) loaded — 182,147 leads, national scan se |
| SerpAPI key | ✅ **paid $75 plan active** (5,000 queries/mahina) |
| MillionVerifier | ⬜ optional, iske baghair bhi kaam chalta hai (MX-check free hai) |
| Instantly | ⬜ abhi inactive — Step 5 CSV export karta hai |
| Deployment | ✅ Hostinger VPS par live (`http://145.79.12.185/pipeline`) |
| LinkedIn extraction | ✅ Step 3 mein har business ka LinkedIn (company ya personal page) bhi nikalta hai |

Key badalni ho to: `.env` me `SERPAPI_KEY=` update karo, phir **server restart karo** (Next.js env sirf boot par parhta hai — VPS par `sudo systemctl restart torix-tool`).

---

## Ek line me

> 11 GB ki US government healthcare file se **call aur email karne layak practice list** banata hai — naam, malik ka naam, direct phone, website, aur email.

---

## Kaun sa tool kya karta hai

| Service | Kaam | Kahan lagta hai | Kharcha |
|---|---|---|---|
| **NPPES file** (CMS) | 9.7M providers ka raw data | Step 1 | free |
| **Apna code** | filter, scoring, blocklist, dedupe | Step 1-2 | free |
| **SerpAPI** | website dhoondna + **LinkedIn link** | Step 3 | 1 query/lead (LinkedIn isi query se free milta hai) |
| **SerpAPI (Maps)** | rating, category, **closed flag** | Step 3, optional | +1 query/lead |
| **Website scraping** | email + owner ka naam cross-check | Step 4 | free |
| **DNS / MX** | murda domain reject | Step 4 | free |
| **MillionVerifier** | mailbox confirm | Step 4, optional | $27 / 100k |
| **Instantly** | bhejna + reply tracking | Step 5, optional | $37/mo |

**Sirf SerpAPI compulsory hai.** Baqi sab ke baghair tool chalta hai, bas kam data deta hai.

---

## Poora flow

```
NPPES file (10.8 GB, 9.7M rows)
        │
   [Step 0]  Scope — state / city / zip / radius
        │
   [Step 1]  Scan + group          31 sec        FREE
        │    9,726,865 rows padhe
        ▼
   34,562 leads (5 states)
        │
   [Step 2]  Score + blocklist     54 sec        FREE
        │    435 hospital chains nikal diye
        ▼
    2,987 HOT  |  7,949 VERIFY  |  23,626 EXCLUDE
        │
   [Step 3]  Website dhoondo                     SERPAPI
        │    endpoint → guess → search → maps
        ▼
   ~1,970 websites (66%)
        │
   [Step 4]  Email nikalo + verify               FREE
        │    scrape → syntax → MX → (verifier)
        ▼
     ~830 emails (42%)
        │
   [Step 5]  CSV export / Instantly              FREE
        ▼
   Outreach-ready list
```

---

## Har step ki tafseel

### Step 0 — Scope

Kahan search karna hai, ye pehle tay hota hai. Chaar tarah se:

```
States    UT, NV, ID, AZ, CO
Cities    PROVO, OREM
ZIPs      84601, 84604
Prefix    846*                    ← poora 846xx range
Radius    84601 se 25 mile        ← 28 ZIPs
```

Radius US Census 2024 ke **33,791 ZIP centroids** se banta hai (file repo me hai, kisi API par depend nahi).

Live preview dikhata hai ke kitne leads aayenge — **radius do numbers me likha jata hai aur chupke se dozens ZIPs ban jata hai**, is liye chalane se pehle dekhna zaroori hai.

Measured:
```
states UT                        →  4,553 leads,  344 HOT
states UT, cities PROVO/OREM     →    389 leads,   28 HOT
states UT, within 25 mi of 84601 →  1,075 leads,   95 HOT
```

### Step 1 — Ingest (free)

10.8 GB file line-by-line parhi jati hai — RAM me nahi aati.

- Har row 330 columns ki hai, magar object nahi banta (array + index se parhte hain)
- Row me target state ka code na ho to split se **pehle hi** reject
- Ek practice location = ek lead (multiple providers merge ho jate hain)
- **Naam normalize hota hai** — `IHC HEALTH SERVICES INC` / `IHC HEALTH SERVICES, INC.` ek hi cheez hain

```
9,726,865 rows scanned in 31s
Peak RAM: 312 MB
```

> **Ahem:** Step 1 hamesha **"merge" mode** me chalao. "reset" leads delete kar ke dobara banata hai — websites aur contacts ud jate hain. Pehle 86 paid queries is tarah zaya ho chuki hain.

### Step 2 — Scoring (free)

Har lead ko points milte hain, aur **har lead apni score ki wajah likh kar rakhta hai**:

```
+25 registered organization
+20 decision maker on file (CEO)
+20 2-10 locations
+15 5+ providers at this location
+15 record updated recently
+5  phone on file
────
 85  → HOT
```

Seedha EXCLUDE hone ki do wajahein (points se koi farq nahi padta):
1. **Hospital blocklist** — 77 named health systems
2. **Google kehta hai practice band ho chuki** ← ye Step 3 ke baad kaam karta hai

```
HOT 2,987  |  VERIFY 7,949  |  EXCLUDE 23,626
har HOT lead ka phone AUR naam dono maujood — 100%
```

### Step 3 — Website (SerpAPI) ⚠️ yahan paisa lagta hai

Chaar source, **sasta pehle**:

| # | Source | Kharcha | Coverage |
|---|---|---|---|
| 1 | NPPES endpoint file | free | ~9% |
| 2 | Naam se domain guess | free | ~5% |
| 3 | **SerpAPI web search** | 1 query | → 66% |
| 4 | **SerpAPI Maps (GBP)** | +1 query | optional |

Har candidate website **kholi jati hai** aur uske page par lead ka phone / city / zip / street number match kiya jata hai. **Match ho jaye tabhi** website confirm hoti hai — sirf Google ke kehne par nahi.

**Google Business Profile (optional)** se ye extra milta hai:

```
EYE CLINIC & CONTACT LENS CENTER OF UTAH VALLEY PC
  match 85%   Eye Clinic & Aesthetics of Provo    ← asal trading name
              Eye care center · 5.0 · 1,178 reviews
              (801) 373-4550                       ← phone match se confirm
```

Sabse bara faida: **"permanently closed" flag.** NPPES ke 41% records 10+ saal purane hain — band clinic aur chalti clinic file me bilkul ek jaisi lagti hai. Sirf Google batata hai.

Matching me **phone ko sabse zyada weight** diya gaya hai — "FAMILY PRACTICE" ek shehar me dozens listings se match karta hai, 10-digit number ek se.

**LinkedIn (free byproduct):** yehi search query jo website dhoondti hai, usi ke results se LinkedIn link bhi nikal liya jata hai — company page (`/company/...`) ko personal profile (`/in/...`) par tarjeeh di jati hai. Koi extra query nahi lagti.

**Query budget:**
```
86 paid queries per 100 HOT leads     ← measured (free sources pehle chalte hain)

Utah      344 HOT  →  ~296 queries   (GBP ke sath ~590)
5 states  2,987    →  ~2,570         (GBP ke sath ~5,140)
```

### Step 4 — Contacts (free)

**Naam, title, direct phone** NPPES se — 100% leads par, koi API nahi.

**Email** website se scrape hota hai: mailto links, contact page. Phir rank hota hai:

```
+45  decision maker ke naam se match karta hai
+40  practice ke apne domain par hai
+20  mailto link me tha
+15  office@ / info@ jaisa
-10  kisi aur domain par
```

Reject: `firstname.lastname@`, `hr@`, `careers@`, `noreply@`, placeholder addresses.

**Owner cross-check (free byproduct):** website scrape karte waqt agar page khud kisi ko "owner"/"founder" bataye, to woh naam NPPES ke Authorized Official se compare hota hai. Dono match karein to kuch nahi hota (normal case); disagree karein to lead par `webOwnerName` field mein flag lag jati hai — Step 5 ke CSV/Instantly export mein bhi ye column dikhta hai, taake insaan khud check kar sake asal decision maker kaun hai.

**Phir verification** — do layer, sasta pehle:

```
Layer 1 (FREE)   syntax → disposable list → MX lookup
Layer 2 ($27)    MillionVerifier mailbox check    ← sirf layer 1 pass karne walon par
```

Verdicts:

| Status | Matlab | Bhejein? |
|---|---|---|
| `ok` | mailbox confirm | ✅ |
| `mx_ok` | domain zinda, mailbox check nahi (koi key nahi) | ✅ |
| `catch_all` | server sab accept karta hai | ⚠️ opt-in |
| `unknown` | server ne jawab nahi diya | ⚠️ opt-in |
| `invalid` | domain/mailbox exist nahi karta | ❌ kabhi nahi |
| `disposable` | throwaway address | ❌ kabhi nahi |

Ye zaroori kyun hai: **5%+ bounce rate par sending domain hamesha ke liye jal jata hai.**

### Step 5 — Send (free)

CSV export Instantly ki shape me, ya seedha API se (key ho to).

Bhejne se pehle **teen** check:
1. Email `invalid` / `disposable` to nahi?
2. Google ne "permanently closed" to nahi kaha?
3. **Suppression list** — is practice ko pehle to contact nahi kiya?

Suppression table **`Lead` se alag** rakha gaya hai jaan bujh kar — koi bhi re-import ya reset usay mita nahi sakta. Test kiya gaya: database reset kiya, sab leads dobara aaye, suppression ne phir bhi block kiya.

---

## Aakhir me kya milega

**Utah (344 HOT) — expected:**

```
344  practice ka naam + poora address
344  practice phone                        100%
344  decision maker ka naam + title         100%
344  uska DIRECT phone                      100%   ← gatekeeper cross karne ki zarurat nahi
~225 website                                65%
 ~95 email                                  28%
 (LinkedIn) — jinke liye search call hui unmein se ek hissa, koi extra cost nahi
```

**Titles jo milte hain:**
```
132  OWNER          ← contract yehi sign karta hai
 28  PRESIDENT
 17  CEO
 13  MANAGER / EXECUTIVE DIRECTOR
```

**5 states (2,987 HOT) — projected:**
```
2,987  phone + naam
~1,970 websites
  ~830 emails
```

---

## Kya NAHI milega

| | |
|---|---|
| **~35% leads ka website nahi milega** | bot-blocked, parked, ya website hai hi nahi |
| **Website walon me 58% par email nahi** | contact form hota hai, ya JS me chhupa |
| **Zyadatar `office@` / `info@`** | owner ka personal email kam |
| **Bina MillionVerifier ke `ok` nahi** | sab `mx_ok` — domain zinda, mailbox confirm nahi |
| **Closed detection sirf Google jitni achhi** | jis practice ka Google presence nahi, wo "open" lagti hai |
| **Radius approximate hai** | ZCTA boundary postal boundary nahi — border par lead idhar-udhar ho sakti hai |

**Ye phone-first list hai.** Phone coverage 100% hai, email 28%. Email scale ka channel hai, entry ka nahi.

---

## Chalane ka tareeqa

**Live VPS (asal production):**

```
http://145.79.12.185/pipeline
```

(SSL lagne ke baad `https://srv1976742.hstgr.cloud/pipeline` — dekho `DEPLOY-GUIDE.md`)

**Apni Windows machine par local testing ke liye:**

```bash
cd "d:/torix solutions/files/torix-tool"
npm run dev
```

Browser: **http://localhost:3000/pipeline**

> Is machine par port 3000 kabhi kabhi kisi doosre project ke qabze me hota hai
> (server start hi nahi hota, ya request us doosre app par chali jati hai).
> Agar `npm run dev` fail ho ya `/pipeline` 404 de, dusra port use karo:
> `PORT=3001 npm run dev` — phir **http://localhost:3001/pipeline** kholo.

### UI mein har step par kya karna hai (screen ke exact naam)

**Step 1: Pick Raw NPPES CSV**
1. **Target States** mein state(s) chuno (jaise `UT`).
2. Chaho to **Narrow the area (optional)** mein Cities, ZIP codes, ya "Within radius of ZIP" + Miles bhar do — chhoti scope ke liye.
3. **Taxonomy Codes** mein specialty code(s) daalo (jaise `111N00000X`).
4. Neeche list mein woh raw NPPES CSV file chuno jo scan honi hai.
5. **"If a practice is already in the database"** mein hamesha **"Update it"** rakho — **"Start these states over"** kabhi mat chuno jab tak jaan-boojh kar sab delete na karna ho (isse websites/contacts/emails sab ud jate hain).
6. **Run Filter** button dabao — progress log dikhega, aakhir mein "X new, Y updated" milega.

**Step 2: Filter & Score**
1. Chaho to HOT/VERIFY thresholds ya "Max locations (chain cutoff)" adjust karo (default theek hain, chhedne ki zaroorat nahi).
2. **Run Scoring** dabao — free hai, jitni baar chaho chala sakte ho.
3. Neeche HOT / VERIFY / EXCLUDE ke counts dikhenge.

**Step 3: Web Verify** ⚠️ yahan SerpAPI credits lagte hain
1. **Verify leads tagged** mein `HOT` chuna hua rakho (default).
2. **"Use paid search..."** checkbox tick karo — warna sirf free sources (endpoint/guess) try honge, coverage bohot kam milegi.
3. Chaho to **"Also look up the Google Business Profile"** bhi tick karo — closed-business detection aur rating milta hai, lekin **1 extra query per lead** lagti hai, isliye pehle chhoti scope par test karo.
4. **Run Web Verify** dabao. Isi run se LinkedIn links bhi (jahan milein) free mein sath aa jate hain.

**Step 4: Find Contacts** (free)
1. Tags same rakho (`HOT`).
2. **"Scrape practice websites for email and LinkedIn"** aur **"Verify each address..."** dono on rakho (default).
3. **"Allow catch-all and unknown addresses"** ko off hi rehne do jab tak bulk volume chahiye ho — warna bounce rate barh sakta hai.
4. **Run Find Contacts** dabao.

**Step 5: Send to Instantly**
1. **Delivery** dropdown mein "CSV export" chuno (Instantly key set nahi ki to yehi kaam karega) ya "Instantly API" (agar `.env` mein key daali ho).
2. **Run** dabao — CSV mode mein file download ho jayegi, seedha Instantly mein import kar dena.
3. "Re-send leads already queued or sent" ko off hi rakho, warna same lead dobara mail ho sakti hai.

```
Step 1   Scope choose karo   →  merge mode  →  Run
Step 2   Run                 →  free
Step 3   Paid search ON      →  ⚠️ yahan queries lagti hain (LinkedIn free milta hai)
Step 4   Verify ON           →  free
Step 5   CSV export ya Instantly push →  free
```

CRM: **/crm** (usi domain/port par)

Tests: `npm test`

---

## Warnings

1. **Step 1 hamesha "merge"** — "reset" contacts aur websites uda deta hai
2. **Radius me ZIP ka typo scope BARA kar deta hai, chhota nahi** — `00000` daalo to poori state chal jayegi (344 HOT, 95 nahi). Preview zaroor dekho
3. **SerpAPI credits har mahine expire** — plan lene ke baad usi mahine run karo
4. **GBP query cost double kar deta hai** — pehle sirf Utah par test karo

---

*Numbers August 2026 ki NPPES dissemination file par asal run se measured hain. Email aur website ke figures 100-lead sample se project kiye gaye hain.*
