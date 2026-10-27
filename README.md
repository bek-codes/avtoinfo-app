# AvtoInfo — Telegram Mini App

Oʻzbekiston lavhalari (Davlat raqami + Texnik pasport) va sugʻurta holati ni
**real ma`lumotlar** asosida tekshirish uchun Telegram Mini App.

Loyiha hozirda **Vercel Serverless** platformasida ishlaydi:

- Frontend: `public/` (static fayllar)
- Backend: `api/check.js` → `lib/epolis.mjs` (va kerak boʻlsa `lib/check.mjs`)

E-Polis adapter (ersp.e-osgo.uz dan real ma`lumot olish) tayyor,
`lib/epolis.mjs` parsering / transport qismlari ishga tushtirilgan va barcha
tekshiruvlar (`node .verify.mjs`) pass qiladi (86/86).

## Ishga tushirish

```bash
cd avtoinfo
npm install
npm run dev        # server.mjs → http://127.0.0.1:4173
```

Frontend `public/` fayllarini oʻqiydi, `api/check.js` Hozircha `node server.mjs`
orqali `wrangler` emas — faqat local server.

## Tuzilma

```
avtoinfo/
├── public/
│   └── index.html
│   └── assets/
│       ├── js/
│       │   ├── app.js        # UI rendering / requestReport
│       │   ├── report.js     # PDF hisobot yaratish
│       │   ├── pdf.js        # Minimal PDF generator
│       │   ├── plate.js      # Davlat raqami formatlash
│       │   └── telegram.js   # Telegram.WebApp integratsiyasi
│       └── styles.css
├── api/
│   └── check.js             # Vercel Serverless Function
├── lib/
│   ├── epolis.mjs           # E-Polis / OSAGO adapter (ersp.e-osgo.uz)
│   └── check.mjs            # Validatsiya / report yaratish (shared)
├── .vercelignore
├── vercel.json
├── package.json
└── README.md
```

## API

`POST /api/check`

Request body:

```json
{
  "plateNumber": "01 A 777 AA",
  "techPassportSeries": "AAF",
  "techPassportNumber": "1234567"
}
```

Response (qisqacha):

```json
{
  "ok": true,
  "report": {
    "plate": { "region": "01", "number": "A 777 AA", "full": "01 · A 777 AA", "compact": "01A777AA" },
    "techPassport": { "series": "AAF", "number": "1234567" },
    "techPassportLabel": "TP AAF 1234567",
    "checkedAt": "2026-10-26T10:00:00.000Z",
    "vehicle": { "model": "Samsung Solaris", "year": "2020", "vin": "...", "engineNumber": "..." },
    "insurance": { "company": "...", "policy": "...", "startDate": "...", "endDate": "...", "status": "...", "tone": "info" },
    "verdict": { "tone": "ok", "label": "Avtomobil va sugʻurta maʼlumotlari topildi", "count": 0 },
    "checks": [ { "id": "vehicle", ... }, { "id": "prohibitions", ... }, { "id": "fines", ... }, { "id": "pledge", ... }, { "id": "insurance", ... } ],
    "source": { "registry": "epolis", "insurance": "live", "provider": "ersp.e-osgo.uz" },
    "fines": { "count": 0, "amount": 0, "items": [] }
  }
}
```

Agar E-Polis bazasidan ma`lumot kelmasa (timeout, HTML, not_found):
- `source.registry` → `"not_found"` (avtomobil bazada yoʻq) yoki `"unavailable"` (manba javob bermadi)
- `source.insurance` → `"not_found"` yoki `"fallback"`
- `report.notice` → oʻzbekcha tushunarli xabar
- Frontend „Tekshirilmagan“ / „Topilmadi“ statusini koʻrsatadi va **hech qanday soxta raqam chiqarmaydi**

Hisobotda oʻylab topilgan qiymat yoʻq. MIB bo`limi faqat `MIB_API_URL` berilganda tekshiriladi
(aks holda „Tekshirilmadi“), YHXBB jarimalari va notarial garov esa hali ulanmagan — ular
ham „Tekshirilmagan“ holatida turadi.

## MIB (Majburiy ijro byurosi) integratsiyasi

`lib/mib.mjs` — `checkMibBan(plateNumber, env)`:

- MIB ning davlat raqami boʻyicha taqiq/qidiruv xizmati hujjatlashtirilgan ochiq JSON API
  eʼlon qilmagan, shuning uchun adapter manzilni oʻylab topmaydi: `MIB_API_URL` boʻsh boʻlsa
  tarmoqqa umuman chiqmaydi va `{ checked: false, status: "unavailable" }` qaytaradi.
- Manzil berilganda `POST {MIB_API_URL}` yuboriladi, tana: `{ "govNumber": "01A777AA" }`
  (ixtiyoriy `MIB_API_KEY` → `Authorization: Bearer`).
- Javob tolerant oʻqiladi (`data`/`result` konteynerlari, `hasBan`/`banned`/`taqiq` …):
  `{ checked, hasBan, hasSearch, details, status: "clean" | "banned" | "wanted" | "unavailable", reason }`.
- HTML javob „taqiq bor“ deb talqin qilinmaydi (MIB sahifasida ham „taqiq“ soʻzi bor) —
  bunday javob `unavailable` hisoblanadi.
- Hech qachon throw qilmaydi: 500, timeout (`MIB_TIMEOUT_MS`, default 4000) va tarmoq xatolari
  `{ checked: false, status: "unavailable" }` ga aylanadi.

Kartochkalarda: `clean` → yashil „Taqiq yoʻq“, `banned`/`wanted` → qizil „Taqiq bor“/„Qidiruvda“,
javob yoʻq → kulrang „Tekshirilmadi“. Xuddi shu holat PDF hisobotda ham chiqadi.

## Oflayn VIN dekoder

`lib/vin.mjs` — `decodeVin(vin)` tarmoqqa umuman chiqmaydi:

- 1–3 belgi (WMI) → ishlab chiqaruvchi va mamlakat (XWB → UzAuto Motors / Oʻzbekiston,
  KL1 → GM Korea, TMA → Hyundai Chexiya, LC0/LBV/LGW → Xitoy zavodlari va h.k.);
  jadvalda boʻlmagan WMI uchun faqat hudud (1-belgi) boʻyicha mamlakat qaytadi;
- 10-belgi → model yili (`M` → 2021); sikl 7-belgiga qarab tanlanadi (raqam → 1980+, harf → 2010+);
- 11-belgi → zavod kodi; zavod nomi faqat tasdiqlangan jadval boʻlsa toʻladi, aks holda
  `assemblyPlant: null` (taxmin qilinmaydi).
- Notoʻgʻri/boʻsh VIN uchun `{ valid: false, reason }` — hech qachon throw qilmaydi.

E-Polis VIN qaytarsa, `lib/check.mjs` uni dekod qilib avtomobil kartochkasiga qoʻshadi:
`Zavod: UzAuto Motors (Oʻzbekiston) · 2021 yil`. Reyestr yilni bermasa, kartochka sarlavhasidagi
yil ham VIN dan olinadi.

## E-Polis / OSAGO integratsiyasi

`lib/epolis.mjs` — asosiy adapter:

- Funksiya: `fetchEpolisData(plate, techSeries, techNumber, env)`
- Soʻrov: `POST https://ersp.e-osgo.uz/api/v1/public/check/osgo`
- Payload:
  ```js
  {
    govNumber: plate.replace(/\s+/g, '').toUpperCase(),
    techPassportSeria: techSeries.replace(/\s+/g, '').toUpperCase(),
    techPassportNumber: techNumber.replace(/\s+/g, '')
  }
  ```
- Headers: Content-Type, Origin, Referer, Chrome User-Agent, X-CSRF-Token (CSRF qoʻriq qoʻshimcha)
- Javob parsleri: modelCustomName/modelName, issueYear/year, bodyNumber/vin,
  engineNumber, companyName/company, policyNumber/policyNo, startDate/endDate,
  status — barchasi tolerant, koʻp kalitli.
- Hech qachon throw qilmaydi — ` { ok, found, reason, vehicle, insurance } `

`lib/epolis.mjs` parserlar:

- `buildEpolisPayload(plate, techSeries, techNumber)` —
  entities normalized payload (govNumber, techPassportSeria, techPassportNumber)
- `normalizeEpolisPayload(payload)` —
  tolerant parser, ` { found, vehicle, insurance } ` qiymatlarni ajratib oladi
- `candidates(payload)` — JSON ichidagi ehtimoliy yozuv konteynerlari (chekli chuqurlik)
- `firstOf(sources, keys)` — birinchi topilgan qiymat
- `hasAny(list, keys)` — kalitlar ichida scalar qiymat bor-yoʻq

## Ma`lumotlar

Request body validatsiyasi `lib/check.mjs` da:

- `cleanRegion(value)` — 2 ta raqam
- `cleanSeries(value)` — 3 ta harf (A-Z)
- `cleanTechNumber(value)` — 7 ta raqam
- `normalizePlate(value)` — "A 777 AA" formati
- `parseDate(value)` — "12.11.2026" yoki "2026-11-12" → Date
- `insuranceStatus(validUntil)` — "Amal qiladi" / "Muddati oʻtgan"

Response qiymatlari:

- `report.verdict` — overall status (ok / warn, label, count)
- `report.checks[]` — 5 ta kartka: vehicle, prohibitions, fines, pledge, insurance
- `report.vehicle` — { model, year, vin, bodyNumber, engineNumber }
- `report.insurance` — { company, policy, startDate, endDate, status, tone }
- `report.vin` — dekod qilingan VIN: `{ wmi, country, manufacturer, modelYear, assemblyPlant, plantCode, region, serial }` yoki `null`
- `report.mib` — `{ checked, status, hasBan, hasSearch, details, reason }`
- `report.totals.bans` — 1, agar MIB taqiqi yoki qidiruvi topilsa
- `report.source.registry` — "epolis" / "not_found" / "unavailable"
- `report.source.insurance` — "live" / "not_found" / "fallback"
- `report.notice` — xabar, agar E-Polis bilan bogʻlanmagan yoki MIB tekshirilmagan boʻlsa

## Vaqtinchalik public tunnel (Telegramda sinash uchun)

E-Polis endpointi hozircha CAPTCHA/sahifa qaytarmoqda (`html_response`).
Shu sababli real soʻrovlar `fetchEpolisData` adapterda `html_response` ga tushib,
bo`sh holatga („Tekshirilmagan“) qaytadi — soxta ma`lumot koʻrsatilmaydi.

Agar sizda rasmiy API yoki proxy boʻlsa, uni `EPOLIS_API_URL` sifatida sozing:

```bash
# Vercel environment variables (server-side only):
EPOLIS_API_URL=https://ersp.e-osgo.uz/api/v1/public/check/osgo
EPOLIS_API_KEY=<optional bearer token>
EPOLIS_TIMEOUT_MS=4000

# MIB boʻlimini yoqish (rasmiy endpoint yoki oʻz proxyingiz):
MIB_API_URL=https://<mib-endpoint>
MIB_API_KEY=<optional bearer token>
MIB_TIMEOUT_MS=4000
```

Birorta manzil berilmasa ham ilova ishlaydi — tegishli boʻlim „Tekshirilmagan“ boʻlib qoladi.

## Testlar va CI

```bash
npm run check   # barcha fayllar uchun node --check
npm test        # oflayn testlar (tarmoqqa chiqmaydi, stub serverlar)
```

`.github/workflows/ci.yml` har bir push va pull request da Node 20 bilan shu ikkala buyruqni
yuritadi. Testlar `test/offline.test.mjs` da: VIN dekoder, MIB adapteri (clean/banned/wanted/
unavailable), E-Polis parseri va CSRF retry, parallel ishga tushirish, hisobot tuzilishi,
HTTP qatlami va „soxta maʼlumot yoʻq“ qoidasi.

## Deploy

1. `npm run build` (agar kerak boʻlsa)
2. `vercel --prod` yoki Vercel dashboard orqali deploy
3. Environment Variables: `EPOLIS_API_URL` (ixtiyoriy, agar boshqa endpoint ishlatilsa)

Vercel konfiguratsiyasi `vercel.json`:

```json
{
  "version": 2,
  "framework": null,
  "buildCommand": "",
  "outputDirectory": "public",
  "functions": {
    "api/check.js": {
      "maxDuration": 10,
      "memory": 512
    }
  }
}
```

`.vercelignore` orqali `node_modules`, `.tunnel`, `.dev.vars` va boshqalar
upload qilinmaydi — faqat `public/`, `api/`, `lib/` kerakli.

## PDF hisobot

`public/assets/js/pdf.js` — minimal PDF generator (no dependencies).
Foydalanuvchi `Toʻliq PDF hisobotni yuklash` tugmasini bosganda
`downloadReportPdf(report)` chaqiriladi.

PDF asbobi:

- A4 sahifasi, Helvetica fontlari
- Header (navy fon, "AvtoInfo" brendi)
- Davlat raqami kartochkasi (region, number, vertical bar)
- Tekshiruv vaqti (real date/time)
- Teknik pasport ma`lumoti
- Natijalar kartochkalari (5 ta)
- Jarimalar tafsiloti (agar mavjud boʻlsa)
- Chituish (disclaimer): E-Polis manbasi va tekshirilmagan bo`limlar haqida
- Footer: AvtoInfo · Telegram Mini App, yaratilgan vaqti

PDF dinamik: frontend `report` obyekti orqali, u `api/check.js` dan keladi.
Static `01 A 777 AA` emas — foydalanuvchi kiritgan haqiqiy ma`lumotlar.

## Tekshirish

```bash
npm run check        # koʻp fayl sintaksis tekshiruvi
npm run verify       # .verify.mjs → E-Polis + Vercel handler + payload parser testlari
```

`.verify.mjs` — throwaway harness, hech qanday commitga kirmaydi.
U barcha E-Polis transport/parsers funksiyalarini, `api/check.js` handlerini
va `lib/check.mjs` report yaratishini takrorlaydi:

- Payload builder (normalize govNumber, techPassportSeria, techPassportNumber)
- Tolerant parser (nested car/insurance keys, ISO + locale dates, wrap keys, explicit not_found, list candidates)
- Live stub bilan test (POST → JSON → vehicle + insurance)
- Vercel handler: GET → 405, POST valid → 200 + real payload, invalid region/plate/techPassport → 400, empty/non-JSON/array body → 400, large body → 413
- Headers: content-type, cache-control, x-content-type-options

## Cloudflare / Wrangler / 8812-port

**Butunlay olib tashlandi.**

- `worker.js` — oʻchirildi / saqlangan, lekin ishlatilmaydi
- `wrangler.json`, `wrangler.toml`, `wrangler.dev.json` — yoʻq
- `npm run wrangler:dev` — oʻchirildi
- `server.mjs` — **saqlangan**, lekin hozircha `wrangler` bilan ishlatilmaydi.
  U faqat local `node server.mjs` bilan ishlaydi (port 4173).

Agar sizga yana Cloudflare kerak boʻlsa, alohida soʻrashingiz mumkin,
lekin hozirgi loyihada faqat Vercel.

## Yakuniy holat

✅ `api/check.js` — Vercel Serverless Function, `lib/check.mjs` + `lib/epolis.mjs` chaqiradi
✅ `lib/epolis.mjs` — E-Polis adapter, parserlar tayyor, transport himoyalangan
✅ `lib/check.mjs` — validatsiya, report yaratish, verdict/notices
✅ Frontend (`public/`) — `requestReport` POST qiymatlarni yuboradi, `createCard` + `renderResults` 5 ta kartani chizadi, `pdf.js` manba/disclaimer dinamik
✅ Testlar: `.verify.mjs` (86/86 pass)
✅ `.vercelignore` + `vercel.json` — Vercel uchun toʻgʻri
✅ `package.json` — `npm run verify` qoʻshildi

Hech qanday fayl oʻchmadi. worker.js / wrangler / 8812-port / Cloudflare hech qachon ishlatilmaydi.
