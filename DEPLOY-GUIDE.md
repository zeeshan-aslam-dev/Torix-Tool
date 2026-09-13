# Torix Lead Engine — VPS Deployment Guide (Hostinger KVM 2)

Har step is order mein karo. Har command ke upar likha hai woh kahan chalani hai — **VPS par** (SSH ke andar) ya **apni Windows machine par**.

**Server:** Hostinger KVM 2 — Ubuntu 26.04 LTS
**IP:** `145.79.12.185`
**Hostname (Hostinger ne di hai, free):** `srv1976742.hstgr.cloud`
**SSH username:** `root`
**Repo:** `https://github.com/zeeshan-aslam-dev/Torix-Tool.git`

> Hostinger ne har VPS ko ek free hostname (`srv1976742.hstgr.cloud`) di hai jo already tumhari IP par resolve hoti hai — isi liye tumhe alag se domain kharidne ki zaroorat nahi, aur Step 7 mein isi se free HTTPS mil jayegi.

---

## Roz-marra ka workflow — koi bhi naya code change VPS par kaise le jayein

Ye poora deployment sirf **ek dafa** karna hai (Step 1-8 neeche). Uske baad jab bhi code mein koi change ho (chahe main karu ya tum khud), sirf ye do hisse chalane hain:

**A) Apni Windows machine par — GitHub par push karo:**

```bash
cd "D:\torix solutions\files\torix-tool"
git add -A
git commit -m "apna message yahan"
git push
```

(Agar main khud koi change karta hoon, main ye khud chala kar bata dunga — tumhe sirf batana hoga "push kar do".)

**B) VPS console par — GitHub se latest le kar rebuild karo:**

```bash
cd /opt/torix-tool
sudo -u torix git pull
sudo -u torix npm ci
sudo -u torix npx prisma generate && sudo -u torix npx prisma db push
sudo -u torix npm run build
sudo systemctl restart torix-tool
```

Bas itna hi — koi setup dobara nahi karna, koi data dobara copy nahi karna. Ye wahi commands hain jo neeche **Step 9** mein bhi hain, yahan sirf jald dhoondne ke liye upar rakhe hain.

> **Chhota change** (sirf ek line, jaise ek text ya config) ho to `npm ci` aur `prisma` wale steps skip kar ke sirf `git pull → npm run build → systemctl restart` bhi kaafi hai — lekin agar `package.json` ya `prisma/schema.prisma` change hua ho to poora block chalao.

---

## Shuru karne se pehle

- hPanel mein VPS ka root password set/reset kar chuke ho (agar nahi kiya, "Forgot root password? Reset password" wala button use karo).
- Tumhari Windows machine par `prisma/dev.db` mein already national data (182k+ leads) ban chuka hai — isko VPS par copy karna hai, dobara import nahi karna (free hai, lekin time bachta hai).
- Tumhare paas SerpAPI aur (agar liya hai) MillionVerifier ki real API keys hain — yeh sirf tumhare local `.env` mein hain, kahin aur likhi hui nahi.

---

## Step 1 — VPS se connect karo (hPanel Browser Console)

hPanel mein login karo → **VPS** → apna server select karo → sidebar mein **Browser terminal** (kabhi "Console" bhi likha hota hai) par click karo. Nayi terminal window khul jayegi, `root` se pehle se logged in hoga — alag se SSH client ya password ki zaroorat nahi.

Baaki saare steps isi console ke andar chalane hain, jab tak "Apni Windows machine par" na likha ho (Step 3 mein ek command sirf Windows se chalti hai, kyunke woh Windows → VPS file transfer hai).

> **Do zaroori baatein browser console ke liye:**
> 1. **Paste** karne ke liye normal `Ctrl+V` kaam nahi karta — right-click karke "Paste" choose karo, ya `Ctrl+Shift+V` try karo.
> 2. Browser console band/refresh hone se chalta hua command ruk sakta hai (jaise SSH session band karne se hota hai). Lambe steps (jaise Step 2 ka setup script, ~2-5 min) ke liye tab ko khula rakho. Agar zyada safe rehna ho, sabse pehle yeh chala lo taake command background mein mehfooz rahe chahe tab galti se band ho jaye:
>    ```bash
>    apt-get install -y tmux
>    tmux new -s deploy
>    ```
>    Console disconnect ho jaye to hPanel se dobara browser terminal khol kar `tmux attach -t deploy` se wapas usi session mein aa jaoge.

---

## Step 2 — Setup script chalao

Ek hi script sab kuch install kar deti hai — Node.js, nginx, firewall, app user, repo clone, dependencies, database, build, aur systemd service.

**VPS par:**

```bash
curl -fsSL https://raw.githubusercontent.com/zeeshan-aslam-dev/Torix-Tool/main/deploy/setup.sh -o setup.sh
sudo bash setup.sh
```

Yeh **2–5 minutes** lagegi. Script khud karti hai:

- 2GB swap add karti hai (agar VPS par pehle se koi swap nahi hai)
- Node 20, nginx, ufw firewall install karti hai
- `torix` naam ka system user banati hai (app root se nahi chalti)
- Repo ko `/opt/torix-tool` mein clone karti hai
- `.env` ka blank template bana deti hai
- `npm ci`, Prisma setup, aur `npm run build` chalati hai
- systemd service + nginx reverse proxy install kar ke enable kar deti hai — nginx ki `server_name` Hostinger ki hostname (`srv1976742.hstgr.cloud`) par set hoti hai, taake Step 7 mein SSL lagayi ja sake

> Script ke end mein ek warning aayegi ke `.env` abhi khaali hai — normal hai, agle steps mein bharenge.

---

## Step 3 — Apna existing data VPS par copy karo

Tumne already Windows par national NPPES import + scoring kar rakhi hai. Wapas VPS par re-import karne ki zaroorat nahi — seedha database file copy kar do.

**Recommended:** existing `dev.db` copy karo — 182k+ leads jo already imported/scored hain, wahi VPS par mil jayenge.
**Alternative:** VPS par fresh start — 11GB NPPES file upload kar ke Step 1/2 wahan se re-run karo. Sirf tab karo agar VPS par bilkul nayi/alag scope chahiye.

Pehle VPS par service roko (taake copy ke waqt database file mein likhai na ho rahi ho):

**VPS par:**

```bash
sudo systemctl stop torix-tool
```

Ye ek step hai jo browser console se nahi ho sakta (usse Windows ki local files nahi dikhtin) — apni Windows machine par PowerShell ya Git Bash khol kar chalao (root password wahi jo hPanel mein set kiya tha maangega):

**Apni Windows machine par:**

```bash
scp "D:\torix solutions\files\torix-tool\prisma\dev.db" root@145.79.12.185:/opt/torix-tool/prisma/dev.db
```

Yeh file ~115MB hai, connection ke hisaab se 1–5 minute lagenge. Agar `scp` command not found ka error aaye, WinSCP (GUI tool) use kar lo — same destination path.

Copy hone ke baad, VPS par ownership theek karo aur service wapas start karo:

**VPS par:**

```bash
sudo chown torix:torix /opt/torix-tool/prisma/dev.db
sudo systemctl start torix-tool
```

> **Agar Windows se `scp`/`ssh` kaam na kare** (password baar-baar "Permission denied" de, ya sirf hPanel ka Browser terminal hi use ho raha ho): Google Drive ke zariye transfer karo — koi terminal command Windows par chalane ki zaroorat nahi.
> 1. Apne Windows browser se `drive.google.com` par `dev.db` upload karo, phir Share → "Anyone with the link" kar ke link se FILE_ID nikaal lo (link ke `/d/` aur `/view` ke beech wala hissa).
> 2. VPS web console par:
>    ```bash
>    sudo systemctl stop torix-tool
>    FILEID="PASTE_FILE_ID"
>    wget --load-cookies /tmp/cookies.txt "https://docs.google.com/uc?export=download&confirm=$(wget --quiet --save-cookies /tmp/cookies.txt --keep-session-cookies --no-check-certificate "https://docs.google.com/uc?export=download&id=${FILEID}" -O- | sed -rn 's/.*confirm=([0-9A-Za-z_]+).*/\1\n/p')&id=${FILEID}" -O /opt/torix-tool/prisma/dev.db
>    rm -f /tmp/cookies.txt
>    ls -lh /opt/torix-tool/prisma/dev.db
>    sudo chown torix:torix /opt/torix-tool/prisma/dev.db
>    sudo systemctl start torix-tool
>    ```
> 3. `ls -lh` se size confirm karo (~115M), phir Google Drive se woh file delete kar do — real lead data hai, wahan pade rehne ki zaroorat nahi.

> **Optional — sirf agar VPS par future mein Step 1 dobara chalana ho** (jaise koi naya state/specialty add karna): tab hi 11GB NPPES raw CSV file ko `/opt/nppes-data` mein upload karna hoga. Woh file itni badi hai ke plain `scp` resume nahi karta — WinSCP ya `rsync` use karo. Abhi ke liye skip kar sakte ho, kyunke tumhara data already dev.db mein maujood hai.

---

## Step 4 — .env mein API keys bharo

Bina in keys ke Step 3 (website/email search) aur Step 5 (Instantly send) free/manual mode mein chalenge, paid features off rahenge.

**VPS par:**

```bash
sudo nano /opt/torix-tool/.env
```

Apni local `.env` (Windows machine) khol kar wahi values yahan paste karo:

| Key | Status | Kaam |
|---|---|---|
| `DATABASE_URL` | already set | Script ne pehle se sahi kar diya hai, mat chhero. |
| `SERPAPI_KEY` | **Required** | Website + email discovery (Step 3) ke liye — tumne yeh already kharida hai. |
| `MILLIONVERIFIER_KEY` | Optional | Agar liya hai to Step 4 email verification behtar karega. Bina iske bhi MX-check free chalti rehti hai. |
| `INSTANTLY_API_KEY` / `INSTANTLY_CAMPAIGN_ID` | Optional | Abhi inactive — bharne se Step 5 seedha Instantly ko bhejega, warna CSV export karega. |
| `NPPES_DATA_DIR` | Optional | Sirf tab set karo agar VPS par raw NPPES file bhi upload ki ho (`/opt/nppes-data`). |

Save karne ke liye: `Ctrl+O`, Enter, phir `Ctrl+X`.

---

## Step 5 — Service ko naye keys ke saath restart karo

.env change karne ke baad app ko dobara start karna zaroori hai taake naye keys load hon.

**VPS par:**

```bash
sudo systemctl restart torix-tool
sudo systemctl status torix-tool
```

Status mein `active (running)` hara likha dikhna chahiye. Agar `failed` dikhe, Troubleshooting section neeche dekho.

---

## Step 6 — Browser mein kholo aur verify karo

**Apni Windows machine par** (koi bhi browser):

```
http://145.79.12.185/pipeline
```

Pipeline page khulna chahiye aur agar Step 3 mein dev.db copy kiya tha, dashboard mein pehle se 182k+ leads dikhne chahiye.

---

## Step 7 — Free HTTPS lagao (Hostinger ki hostname se)

Abhi tak sab kuch plain HTTP par hai — koi encryption nahi. Chunke Hostinger ne pehle se ek real hostname (`srv1976742.hstgr.cloud`) di hai jo tumhari IP par resolve hoti hai, Let's Encrypt se bilkul free SSL certificate mil sakta hai, koi domain kharide bina.

**VPS par:**

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d srv1976742.hstgr.cloud
```

Yeh ek email address poochega (renewal reminders ke liye) aur terms accept karwayega — apni email khud daal dena. Certbot khud nginx config update kar dega taake `https://srv1976742.hstgr.cloud` kaam kare aur HTTP se HTTPS par redirect ho jaye. Certificate har 90 din mein khud renew hota hai, kuch aur karne ki zaroorat nahi.

Ab se browser mein yeh URL use karo:

```
https://srv1976742.hstgr.cloud/pipeline
```

---

## Step 8 — Password protection lagao

App ke andar koi login system nahi hai — jo bhi is URL ko jaanta ho, tumhara real lead data (naam, email, phone) bina password ke dekh sakta hai. **Ye step skip mat karo.** (Step 7 ke baad karo, taake password encrypted connection par jaye, plaintext mein nahi.)

**VPS par:** ek username/password file banao:

```bash
sudo apt-get install -y apache2-utils
sudo htpasswd -c /etc/nginx/.torix-htpasswd admin
```

(Yeh naya password poochega — yaad rakh lena.)

Ab nginx config mein password check add karo:

```bash
sudo sed -i '/proxy_pass/i\    auth_basic "Torix";\n    auth_basic_user_file /etc/nginx/.torix-htpasswd;' /etc/nginx/sites-available/torix-tool
sudo nginx -t
sudo systemctl restart nginx
```

Ab browser mein page kholne par username/password maanga jayega.

---

## Step 9 — Future updates deploy karna

Jab bhi code mein koi naya change karke GitHub par push karo, VPS par yeh chaar commands chala kar live kar dena.

**VPS par:**

```bash
cd /opt/torix-tool
sudo -u torix git pull
sudo -u torix npm ci
sudo -u torix npx prisma generate && sudo -u torix npx prisma db push
sudo -u torix npm run build
sudo systemctl restart torix-tool
```

Isko ek `deploy.sh` script bana kar bhi save kar sakte ho, taake future mein ek hi command se chal jaye.

---

## Troubleshooting

**Browser mein "502 Bad Gateway" aa raha hai**
Matlab nginx chal raha hai lekin app crash ho gayi ya start nahi hui. Check karo: `sudo systemctl status torix-tool` aur `sudo journalctl -u torix-tool -n 50`. Zyada tar wajah galat `.env` value ya build fail hona hoti hai.

**Browser se IP/hostname hi open nahi ho raha (connection timed out)**
Firewall check karo: `sudo ufw status` — "Nginx Full" allowed dikhna chahiye. hPanel mein VPS ke "Firewall" tab mein bhi dekh lo ke port 80/443 block to nahi.

**Service start nahi ho rahi (failed status)**
`sudo journalctl -u torix-tool -n 80 --no-pager` chala kar exact error dekho. Aam wajahain: `.env` mein `DATABASE_URL` galat ho gaya, ya `/opt/torix-tool` ki ownership `torix` user ke paas nahi hai (`sudo chown -R torix:torix /opt/torix-tool` se theek karo).

**Certbot fail ho raha hai ("Challenge failed")**
Confirm karo `srv1976742.hstgr.cloud` abhi bhi tumhari IP (`145.79.12.185`) par resolve ho rahi hai — `ping srv1976742.hstgr.cloud` se check karo. Aur confirm karo port 80 firewall mein khula hai (Let's Encrypt validation isi port se hoti hai).

**Setup script "Unable to acquire the dpkg frontend lock" error de kar ruk gayi**
Fresh VPS boot hone ke turant baad Ubuntu khud background mein `unattended-upgrades` chalata hai jo kuch waqt ke liye package system lock kar deta hai. Bas thoda wait kar ke dobara chalao — script dobara chalana safe hai, pehle ho chuke steps khud skip ho jayenge:
```bash
sudo bash setup.sh
```
Agar phir bhi same error aaye:
```bash
sudo systemctl stop unattended-upgrades
sudo dpkg --configure -a
sudo bash setup.sh
```

**NPPES import (agar VPS par chalaya) beech mein ruk gaya / memory error**
Confirm karo swap active hai: `swapon --show` (setup.sh ne 2GB banaya hoga). Agar phir bhi issue ho, `free -h` se live memory dekho jabke import chal raha ho.

**dev.db copy karne ke baad purana data nahi dikh raha**
Confirm karo service copy ke *baad* restart hui (Step 3 ke end mein). Agar restart se pehle copy hote hue service chal rahi thi, file corrupt ho sakti hai — dobara copy karo, is baar pehle `systemctl stop` zaroor karo.

---

## Quick reference

| Command | Kaam |
|---|---|
| `sudo systemctl status torix-tool` | Service chal rahi hai ya nahi |
| `sudo systemctl restart torix-tool` | App restart karo (.env change ke baad zaroori) |
| `sudo journalctl -u torix-tool -f` | Live logs dekho |
| `df -h /` | Disk space baqi hai ya nahi |
| `free -h` | RAM/swap usage |
| `sudo nginx -t` | nginx config test karo config badalne ke baad |
| `sudo certbot renew --dry-run` | SSL renewal test karo (auto-renew waise bhi chalta hai) |
