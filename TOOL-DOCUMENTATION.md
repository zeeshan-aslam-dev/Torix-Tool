# Torix Lead Engine — Complete Technical Documentation

Ye document batata hai tool **andar se kya karta hai** — NPPES ki raw file se le kar outreach-ready lead tak, har step ka mechanism, har filter ka criteria, aur har number kahan se aata hai. Saare numbers is document mein **asal database se nikale gaye hain** (national import, 182,147 leads, 51 states), guess nahi hain.

---

## 1. Tool ka maqsad

Torix Lead Engine ek 11GB ki US government healthcare provider file (NPPES) ko process kar ke aisi practice list banata hai jise seedha call ya email kiya ja sake — har lead ke sath business ka naam, address, phone, decision-maker ka naam/title/phone, website, LinkedIn, aur (jahan mile) email address hota hai. Poora kaam 5 steps mein hota hai, aur har step ka apna alag kaam hai — pehle steps data ikattha karte hain, baad wale usay enrich (website/email/LinkedIn) karte hain.

---

## 2. Data source — NPPES file

**NPPES** (National Plan and Provider Enumeration System) CMS (US government) ki official file hai jismein **har** healthcare provider aur organization ka record hota hai jisne kabhi apna NPI (National Provider Identifier) register karaya ho. Ye file:

- **~11GB** size, **~9.7 million rows**, har row **~330 columns**
- Har row mein zyada tar columns khaali hote hain (koi bhi provider itni saari fields nahi bharta)
- Ek row = ek provider ka registration record (chahe wo individual ho ya organization)
- File monthly update hoti hai (naye providers, address changes, deactivations)

Tool ye poori file kabhi RAM mein load nahi karta — line-by-line **stream** karta hai, taake kam memory (measured: ~468MB peak) mein bhi kaam ho sake.

---

## 3. Step 1 — NPPES se leads filter karna

Har raw row **6 filters** se guzarti hai, is exact order mein:

### Filter 1 — State match

Row ka "Business Practice Location State" field check hota hai — sirf tumhari chuni hui states ki list mein ho to aage badhta hai. Speed ke liye ek "pre-filter" bhi hai: poori row ko 330-column mein split karne se pehle, sirf ye dekha jata hai ke line mein target state ka code (jaise `"UT"`) kahin text mein maujood hai — agar nahi, line turant reject, bina split kiye (bohot tez hai, kyunke zyada tar rows kisi aur state ki hoti hain).

**Targeted states — konsi aur kyun:** national import mein **saari 51 states (50 states + Washington DC)** chuni gayi thin — koi bhi state exclude nahi ki gayi. Isi liye database mein har state ka data maujood hai. "Target states" ka option isliye diya gaya hai taake chaho to jaan-boojh kar chhoti scope (jaise sirf ek state) chala sako — jaise chhota test run karna ho ya kisi specific market par focus karna ho — lekin national import mein ye har state ke liye "on" tha.

### Filter 2 — City / ZIP / Radius (optional)

State ke andar bhi tum chaho to sirf specific cities, ZIP codes, ya "kisi ZIP se X miles ke andar" wala area target kar sakte ho. National import mein ye **khaali chhoda gaya tha**, isliye har state ke andar **har city** included hai — isi wajah se database mein **9,255 alag cities** hain.

Radius wala option US Census 2024 ke 33,791 ZIP centroids se calculate hota hai (koi live API call nahi, ek file hai project mein) — lekin ye approximate hai kyunke ZIP boundary asal postal boundary jaisi exact nahi hoti.

### Filter 3 — Taxonomy (specialty) match

"Taxonomy code" NPPES ka apna standard classification hai jo batata hai provider/organization **kis specialty mein kaam karta hai**. Har row mein **15 alag taxonomy slots** hote hain (ek provider ki multiple specialties ho sakti hain) — inmein se koi ek bhi tumhari chuni hui list se match kare to row pass.

National import mein **3 specialties** chuni gayi thin:

| Taxonomy Code | Specialty | Kitne leads mile |
|---|---|---|
| `207Q00000X` | Family Medicine | 75,546 |
| `111N00000X` | Chiropractor | 66,463 |
| `152W00000X` | Optometrist | 40,138 |

Ye poori tool ka **target market** define karta hai. Koi aur specialty (Dentist, Physical Therapist, Mental Health, etc.) chahiye ho to uska taxonomy code Step 1 mein add kar ke dobara import chalana hoga — merge mode mein purana data safe rehta hai, sirf naya add hota hai.

### Filter 4 — Deactivated NPI check

Har provider/organization ko registration ke waqt ek NPI number milta hai. Agar business band ho gayi ya fraud ki wajah se NPI cancel hui, NPPES us record par "Deactivation Date" laga deti hai. Agar ye date bhari hai **aur** koi "Reactivation Date" nahi hai, row discard ho jati hai — warna file mein aisi practices bhi aa jatin jo asal mein exist hi nahi kartin.

### Filter 5 — Entity Type (Individual vs Organization)

NPPES har record ko do types mein rakhti hai:

- **Type 1 — Individual**: ek insaan ka apna NPI (jaise "Dr. Jane Kimball")
- **Type 2 — Organization**: ek business/facility ka NPI (jaise "Kimball Family Practice LLC")

**Type 1 kabhi lead nahi banta** — code mein ye hard rule hai. Wajah: ek individual record sirf batata hai "ye insaan kahin practice karta hai", na ke kis business mein, na uska koi contract-signing ikhtiyar hota hai (aksar wo kisi organization ka employee hota hai). Aisi row seedha **discard nahi hoti** — uska naam+phone ek "fallback lookup" list mein rakh diya jata hai (state ke andar, naam se indexed), taake agar koi facility ka Authorized Official khud bhi apni individual NPI rakhta ho (alag phone number ke sath), to Step 1 naam+state match kar ke wo doosra number bhi lead par jod de (`alternateOfficialPhone` field).

**Real limitation (honestly flag karna zaroori hai):** NPPES ke rules ke mutabiq, ek **sole proprietor** apni practice sirf Type 1 (individual) ke taur par register kar sakta hai — usay alag se koi Type 2 "organization" NPI banane ki zaroorat nahi. Matlab agar koi akela chiropractor/optometrist apni practice khud chalata hai aur usne kabhi separate business-NPI register nahi ki, to wo hamesha Type 1 rahega — aur is tool ka rule hai **Type 1 kabhi lead nahi banta**, chahe wo asal mein us practice ka 100% malik ho. Aise solo-owner practices is pipeline mein bilkul nazar nahi aatin — na HOT, na VERIFY, na EXCLUDE, sirf skip ho jati hain. Iska exact size (kitne aise practices national data mein miss hue) count nahi hai kyunke ye ek running counter tha, permanently store nahi hua.

### Filter 6 — Same-location dedup (merge)

NPPES file mein **ek row per provider** hoti hai — agar ek clinic mein 5 doctors kaam karte hain, to us clinic ki 5 alag rows hongi (sabki apni NPI, lekin same organization naam/address). Tool organization naam + address + city + state + zip ko **normalize** kar ke (punctuation/extra spaces hata kar) ek "key" banata hai, aur usi key wali saari rows ko **ek** lead mein merge kar deta hai — `n_providers_at_location` field mein count save hota hai.

Normalize karna zaroori hai kyunke `"IHC HEALTH SERVICES INC"` aur `"IHC HEALTH SERVICES, INC."` asal mein ek hi business hai, sirf likhne ka style alag hai — bina normalize kiye ye do alag leads ban jatin.

### Neetijah (result) — 11GB se 115MB kaise bani

```
9.7 million raw rows
   → state + city/zip filter
   → taxonomy filter (3 specialties)
   → deactivated NPI discard
   → Type 1 (individual) discard as standalone lead
   → same-location merge
   ─────────────────────────────
   182,147 leads (51 states, 9,255 cities) = ~115MB
```

Size itni chhoti isliye hai kyunke: (a) 330 columns mein se sirf ~50 zaroori fields rakhe jate hain, (b) SQLite binary format CSV text se compact hota hai, (c) dozens providers ek location par ek row mein merge ho jate hain, (d) Type-1 individuals apni alag row nahi banate.

---

## 4. Step 2 — Scoring (HOT / VERIFY / EXCLUDE)

Step 1 sirf itna tay karta hai ke koi row **database mein aayegi ya nahi**. Step 2 tay karta hai ke jo already database mein hai, **wo achi lead hai ya nahi** — koi row delete nahi hoti, sirf tag lagta hai.

### Hard-exclude rules (points se pehle, seedha score 0)

Chaar cheezein hain jo kisi bhi lead ko seedha EXCLUDE kar deti hain, chahe baaki record kitna bhi achha ho:

1. **Entity Type 1** (individual) — kabhi lead nahi
2. **Hospital blocklist match** — 77 named health systems ki ek static list (config file mein, jaise Intermountain, HCA, etc.) — agar organization ka naam match kare
3. **Web-detected acquisition** — Step 3 ne kisi search result/website par "part of", "acquired by" jaisi zabaan dekhi ho
4. **Google Business Profile "permanently closed"** — Step 3 ke GBP lookup se pata chale practice band ho chuki hai

### Point system (baaki sab par)

| Factor | Points |
|---|---|
| Registered organization (Entity Type 2) | **+25** |
| Sole proprietor | +10 |
| Individual/employed (agar yahan tak pahunche) | -15 |
| Decision-maker title milta hai (Owner/President/CEO/Founder/Partner/etc.) | **+20** |
| Gatekeeper title milta hai (Manager/Director/Administrator/CFO/COO) | +10 |
| Sirf naam hai, koi title nahi | +5 |
| 2-10 locations (ideal size — web-presence chahiye) | **+20** |
| 11-20 locations (kuch internal resources ho sakte hain) | +5 |
| 21+ locations (bara chain, apni marketing team hoti hai) | -30 |
| 5+ providers isi location par | +15 |
| 2-4 providers | +8 |
| Record 2 saal se kam purana update hua | +15 |
| Record 2-5 saal purana | +5 |
| Record 5-10 saal purana | -5 |
| Record 10+ saal purana | -20 |
| Koi update date hi nahi | -10 |
| Phone number maujood | +5 |
| Phone number nahi | -10 |
| Kisi bari organization ka subsidiary/subpart | **-20** |

Total 0-100 ke beech clamp hota hai. **HOT** = 55+, **VERIFY** = 30-54, **EXCLUDE** = 0-29 (ya koi hard-exclude rule lagi ho).

### Organization-affiliation detect karne ke 3 tareeqe (aur unke asal numbers)

| Tareeqa | Kab check hota hai | Kitne leads flag hue (national) |
|---|---|---|
| Hospital blocklist (77 named systems) | Step 2 | **3,204** |
| NPPES ka apna subpart/parent field | Step 1 mein capture, Step 2 mein -20 | **10,439** |
| Web par "part of"/"acquired by" zabaan | Step 3 (search/website scan) | **0 abhi tak** — Step 3 poore national data par chalaya hi nahi gaya |

### Worked example — Utah se asal data (4,553 leads)

```
4,553 total UT leads
  - 2,960  Entity Type 1 (individual) → EXCLUDE, score 0
  ───────
  1,593  asal organizations

  1,593 organizations
     369  HOT      (55+)
     871  VERIFY   (30-54)
     353  EXCLUDE  (<30, ya subsidiary/blocklist)
```

**HOT example** — `MY FAMILY DOCTOR LLC` (score 85):
```
+25  registered organization
+20  decision maker on file (OWNER)
+20  4 locations, needs multi-location web presence
+15  record updated within 2 years
+5   phone on file
```

**VERIFY example** — `MA BO INC` (score 53, HOT se sirf 2 point kam):
```
+25  registered organization
+10  contact on file (PRACTICE MANAGER)   ← Owner nahi, isliye +10 na ke +20
+20  2 locations
+8   2 providers
+5   record 2 years old
+5   phone on file
-20  subsidiary of MA BO INC              ← ye na hota to 73 hota, HOT ban jata
```

**EXCLUDE example (organization hone ke bawajood)** — `NORTHERN UTAH EYE CENTER` (score 25):
```
+25  registered organization
+20  decision maker on file (OWNER)
-5   record 9 years old
+5   phone on file
-20  subsidiary of NORTHERN UTAH EYE CENTER
```

**Khulasa:** HOT hone ke liye lagbhag ye sab sahi hona chahiye — registered organization + owner-level contact + 2-10 locations ka ideal size + haal hi ki updated record + phone, aur koi subsidiary/parent flag na ho. Sabse bara "score killer" **subsidiary/parent flag (-20)** hai, uske baad **owner-level title na hona** (+5/+10 vs +20 ka farq), phir **record staleness**.

---

## 5. Step 3 — Website, LinkedIn, aur Google Business Profile

NPPES mein koi website field hoti hi nahi — har website **dhoondni** padti hai. 4 sources try hote hain, **sasta pehle**, jaise hi confidence 75%+ mil jaye rukk jata hai:

1. **NPPES endpoint file** (free) — kai organizations apna website khud NPPES ko de dete hain (`Endpoint` field mein), seedha wahan se milta hai.
2. **Naam se guess** (free) — organization ka naam domain-jaisa bana kar try kiya jata hai.
3. **Google Business Profile lookup** (paid, optional checkbox) — **yahan SerpAPI use hoti hai**.
4. **Web search** (paid, optional checkbox) — **yahan bhi SerpAPI use hoti hai**.

### SerpAPI — exact do jagah, kahin aur nahi

SerpAPI **sirf Step 3 mein**, aur sirf in do calls ke through use hoti hai:

**Call 1 — Google Business Profile (Maps) lookup:**
- Organization naam + city + state se Google Maps search karti hai
- Best matching listing chunti hai (naam/address similarity se)
- Wapas milta hai: rating, category, phone, website, aur **status** (Operational / Closed) — yehi ek jagah hai jahan se "band ho chuki practice" pata chalti hai (NPPES ye kabhi nahi batati)
- Cost: 1 query per lead jinke liye free sources (1 aur 2) ne pehle website nahi di

**Call 2 — Web Search:**
- Organization naam + city + state se normal web search karti hai
- Top 3 results ki websites fetch/verify hoti hain
- **Free byproduct 1 — LinkedIn:** isi search ke results mein se LinkedIn link bhi nikal liya jata hai (company page `/company/...` ko personal profile `/in/...` par tarjeeh di jati hai) — koi extra query nahi lagti
- **Free byproduct 2 — Acquisition detection:** results ke titles/snippets mein "part of", "acquired by", "a member of" jaisi zabaan bhi yahin scan ho jati hai
- Cost: 1 query per lead

### Website confirm kaise hoti hai (sirf "mil gayi" kaafi nahi)

Koi candidate website sirf accept nahi hoti — uska homepage **khola jata hai** aur us page ke andar lead ka **phone, city, address, ya naam** dhoonda jata hai. Match jitna zyada, confidence utni zyada (0-100%). Sirf tumhare set kiye hue threshold se upar wala candidate accept hota hai — is se galat website (kisi aur "Family Medicine" practice ki) lead par lagne se bachav hota hai.

---

## 6. Step 4 — Owner/Contact data nikalna

### Naam, title, direct phone — kahan se aata hai

**Seedha NPPES se, koi scraping ya API nahi.** Har organization apni NPPES registration mein ek "Authorized Official" declare karti hai (legally signing authority). Ye field Step 1 mein hi, raw file scan hote waqt, capture ho jati hai. Isi wajah se coverage **100%** hoti hai un leads par jinhone ye field bhari ho — Utah ke 369 HOT mein se **369/369 (100%)** ka naam mila, aur **274/369 (74%)** ka title explicitly ownership-level (Owner/President/CEO/Founder) tha.

### Email — website scrape se

Sirf un leads ke liye try hota hai jinki website Step 3 mein mili ho:

1. Website ka homepage fetch hota hai, phir "Contact"/"About" jaisi links bhi follow hoti hain
2. Har page se email nikalta hai do tareeqon se: `mailto:` links, aur plain-text mein likhe addresses
3. Har candidate email ko score milta hai:

| Factor | Points |
|---|---|
| Decision-maker ke naam se match kare | +45 |
| Practice ke apne domain par ho | +40 |
| mailto link mein tha | +20 |
| `office@`/`info@` jaisa generic | +15 |
| Kisi bilkul alag domain par | -10 |

`hr@`, `careers@`, `noreply@`, aur placeholder addresses reject ho jate hain.

### Owner cross-check (free byproduct)

Wahi page jo email ke liye scrape ho raha hota hai, agar usme likha ho "Owner: John Smith" ya "Founded by...", to ye naam NPPES ke Authorized Official se compare hota hai. Match kare to kuch nahi hota (normal case). **Mismatch ho to** lead par ek alag flag (`webOwnerName`) lag jata hai — CSV/Instantly export mein bhi ye column dikhta hai, taake insaan khud verify kar sake asal decision-maker kaun hai. NPPES ka apna field kabhi overwrite nahi hota, ye sirf ek "worth checking" flag hai.

### Email verification — do layer

```
Layer 1 (FREE)   syntax check → disposable-domain list → DNS MX lookup
Layer 2 ($)      MillionVerifier — asal mailbox exist karta hai ya nahi
```

| Verdict | Matlab | Step 5 tak jaye? |
|---|---|---|
| `ok` | Mailbox confirm | ✅ |
| `mx_ok` | Domain zinda hai, mailbox check nahi hua (koi paid key nahi) | ✅ |
| `catch_all` | Server har address accept karta hai | ⚠️ sirf "allow risky" on ho to |
| `unknown` | Server ne jawab nahi diya | ⚠️ sirf "allow risky" on ho to |
| `invalid` | Domain/mailbox exist nahi karta | ❌ kabhi nahi |
| `disposable` | Throwaway address | ❌ kabhi nahi |

Ye zaroori isliye hai kyunke **5%+ bounce rate par sending domain hamesha ke liye "burn" ho jata hai** — email service providers usay spam maan kar block karna shuru kar dete hain.

---

## 7. Step 5 — Send karne se pehle final checks

Bhejne se pehle **teen** cheezein check hoti hain:

1. Email `invalid`/`disposable` na ho
2. Google ne "permanently closed" na kaha ho
3. **Suppression list** — ye practice ya email pehle kabhi contact to nahi ki gayi

Suppression table jaan-boojh kar `Lead` table se **alag** rakha gaya hai — koi bhi re-import, reset, ya database wipe ise mita nahi sakta, kyunke ye "hum ne kisay mail kiya" ka permanent record hai, na ke lead data ka hissa. Duplicate email addresses (agar ek address kai leads par ho) sirf ek dafa count hoti hain. Result CSV ban jata hai (Instantly ki shape mein) ya seedha API se push ho jata hai.

---

## 8. Abhi ka live data snapshot

**National (poore US ka dev.db):**

```
Total leads:        182,147   (51 states, 9,255 cities)
  HOT:                39,223
  VERIFY:             91,305
  EXCLUDE:            51,619
    of which:
      Entity Type 1 (legacy, harmless): 22,565
      Hospital blocklist:                3,204
      Subsidiary/parent flag:           10,439
      Web-detected acquisition:              0  (Step 3 abhi national scale par nahi chala)
```

**Utah (test scope):**

```
Total UT leads:  4,553
  HOT:              369
  VERIFY:           871
  EXCLUDE:        3,313  (2,960 individual + 353 low-score organizations)

HOT leads mein se:
  Named decision-maker:        369/369  (100%)
  Owner-level title:           274/369  (74%)
  Step 4 Contact already built: 346/369  (pehle test se)
```

---

## 9. Jo cheezein tool **nahi** deta (honest limitations)

| Limitation | Wajah |
|---|---|
| Solo-owner practices jinki koi separate organization NPI nahi | Type 1 (individual) hone ki wajah se hamesha skip hoti hain, chahe wo asal owner hi kyun na ho |
| ~35% leads ka website nahi milta | Bot-blocked, parked domain, ya website hai hi nahi |
| Website milne walon mein se ~58% par email nahi | Contact form hota hai, ya email JavaScript mein chhupa hota hai |
| Zyada tar `office@`/`info@` milta hai, owner ka personal email kam | Websites generic inbox hi public karte hain |
| MillionVerifier ke bina koi email `ok` verdict nahi paata | Sab `mx_ok` rehta hai — domain zinda hai, lekin mailbox confirm nahi |
| "Closed" detection sirf utni achi jitni Google ki apni data | Jis practice ka Google presence hi nahi, wo hamesha "open" lagegi |
| Radius approximate hai | ZIP centroid boundary, asal postal boundary nahi — border ke leads idhar-udhar ho sakti hain |
| Web-detected acquisition abhi 0 hai | Sirf Step 3 chalne ke baad hi ye signal milega — national scale par abhi tak nahi chalaya gaya |

**Cumulative picture:** Ye ek **phone-first** list hai. Phone + decision-maker naam coverage HOT leads par ~100% hoti hai (NPPES se free milta hai), lekin email coverage ~28% ke aas-paas rehti hai (paid + scraping par depend karta hai). Email scale badhane ka channel hai, entry point nahi — phone hi asal reliable pehla contact hai.
