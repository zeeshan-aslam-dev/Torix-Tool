# Torix Tool — Paid Key Lagne Ke Baad Ki Working

Ye document batata hai ke SerpAPI ki paid key `.env` me lagne ke baad tool **poora kya karta hai**, kaun sa hissa kaun si service se chalta hai, aur data kis raaste se guzarta hai.

Har number asal run se measured hai — projections alag se mark hain.

---

## Abhi ki position

| | |
|---|---|
| Code | ✅ poora ready, 153 tests pass |
| Data | ✅ 5 states loaded — 34,562 leads, 2,987 HOT |
| SerpAPI key | ⬜ abhi **Free Plan** (250/mahina) — paid key lagni baqi hai |
| MillionVerifier | ⬜ optional, iske baghair bhi kaam chalta hai |
| Instantly | ⬜ abhi zarurat nahi |

Paid key lagane ka tareeqa: `.env` me `SERPAPI_KEY=` update karo, phir **server restart karo** (Next.js env sirf boot par parhta hai).

---

## Ek line me

> 11 GB ki US government healthcare file se **call aur email karne layak practice list** banata hai — naam, malik ka naam, direct phone, website, aur email.

---

## Kaun sa tool kya karta hai

| Service | Kaam | Kahan lagta hai | Kharcha |
|---|---|---|---|
| **NPPES file** (CMS) | 9.7M providers ka raw data | Step 1 | free |
| **Apna code** | filter, scoring, blocklist, dedupe | Step 1-2 | free |
| **SerpAPI** | website dhoondna | Step 3 | 1 query/lead |
| **SerpAPI (Maps)** | rating, category, **closed flag** | Step 3, optional | +1 query/lead |
| **Website scraping** | email + LinkedIn | Step 4 | free |
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

```bash
cd "d:/torix solutions/files/torix-tool"
npm run dev
```

Browser: **http://localhost:3000/pipeline**

> Is machine par port 3000 kabhi kabhi kisi doosre project ke qabze me hota hai
> (server start hi nahi hota, ya request us doosre app par chali jati hai).
> Agar `npm run dev` fail ho ya `/pipeline` 404 de, dusra port use karo:
> `PORT=3001 npm run dev` — phir **http://localhost:3001/pipeline** kholo.

```
Step 1   Scope choose karo   →  merge mode  →  Run
Step 2   Run                 →  free
Step 3   Paid search ON      →  ⚠️ yahan queries lagti hain
Step 4   Verify ON           →  free
Step 5   CSV export          →  free
```

CRM: **http://localhost:3000/crm** (ya `:3001` agar upar wala note lagu ho)

Tests: `npm test`

---

## Warnings

1. **Step 1 hamesha "merge"** — "reset" contacts aur websites uda deta hai
2. **Radius me ZIP ka typo scope BARA kar deta hai, chhota nahi** — `00000` daalo to poori state chal jayegi (344 HOT, 95 nahi). Preview zaroor dekho
3. **SerpAPI credits har mahine expire** — plan lene ke baad usi mahine run karo
4. **GBP query cost double kar deta hai** — pehle sirf Utah par test karo

---

*Numbers August 2026 ki NPPES dissemination file par asal run se measured hain. Email aur website ke figures 100-lead sample se project kiye gaye hain.*
