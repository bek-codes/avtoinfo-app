/**
 * AvtoInfo — oflayn VIN dekoder (lib/vin.mjs).
 *
 * 17 belgili VIN ni tarmoqqa umuman chiqmasdan tahlil qiladi:
 *   - 1–3 belgi (WMI)  → ishlab chiqaruvchi va mamlakat;
 *   - 10-belgi         → model yili (49 CFR §565.15 jadvali, 30 yillik sikl);
 *   - 11-belgi         → zavod kodi (assemblyPlant faqat tasdiqlangan jadval boʻlsa toʻladi).
 *
 * Muhim: WMI ishlab chiqaruvchini bildiradi, avtomobil aynan qayerda yigʻilganini emas.
 * Shuning uchun zavod nomi faqat tasdiqlangan kod jadvalida boʻlsa qaytariladi, aks holda
 * `assemblyPlant: null` va xom `plantCode` beriladi — hech qachon taxmin qilinmaydi.
 *
 * Natija: { valid, wmi, country, manufacturer, modelYear, assemblyPlant, ... }
 * Notoʻgʻri yoki boʻsh VIN uchun: { valid: false, reason } — hech qachon throw qilmaydi.
 */

const VIN_LENGTH = 17;

/** I, O, Q harflari VIN da ishlatilmaydi (1 va 0 bilan chalkashadi). */
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

/** Model yili kodlari: I, O, Q, U, Z yoʻq — 30 ta belgi, har biri 30 yilda takrorlanadi. */
const MODEL_YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789";
const FIRST_CYCLE = 1980; // A → 1980 … 9 → 2009
const SECOND_CYCLE = 2010; // A → 2010 … 9 → 2039

/**
 * WMI → ishlab chiqaruvchi va mamlakat.
 * Manba: ochiq WMI roʻyxati (wikibooks VIN codes) — roʻyxat ishlab chiqaruvchini bildiradi,
 * yakuniy yigʻish joyini emas.
 */
const WMI_TABLE = {
  XWB: { manufacturer: "UzAuto Motors", country: "Oʻzbekiston" },
  XW8: { manufacturer: "Volkswagen Group Rus", country: "Rossiya" },
  KL1: { manufacturer: "GM Korea (Chevrolet)", country: "Janubiy Koreya" },
  KL4: { manufacturer: "GM Korea (Buick)", country: "Janubiy Koreya" },
  TMA: { manufacturer: "Hyundai Motor Manufacturing Czech", country: "Chexiya" },
  TMB: { manufacturer: "Škoda Auto", country: "Chexiya" },
  LC0: { manufacturer: "BYD Auto", country: "Xitoy" },
  LBV: { manufacturer: "BMW Brilliance", country: "Xitoy" },
  LGW: { manufacturer: "Great Wall Motor", country: "Xitoy" },
  LVS: { manufacturer: "Changan Ford", country: "Xitoy" },
  SB1: { manufacturer: "Toyota Motor Manufacturing UK", country: "Buyuk Britaniya" },
  WVW: { manufacturer: "Volkswagen", country: "Germaniya" },
  JHM: { manufacturer: "Honda", country: "Yaponiya" },
  JT2: { manufacturer: "Toyota", country: "Yaponiya" },
  KMH: { manufacturer: "Hyundai", country: "Janubiy Koreya" },
  "1HG": { manufacturer: "Honda", country: "AQSh" },
  "4T1": { manufacturer: "Toyota", country: "AQSh" },
  WBA: { manufacturer: "BMW", country: "Germaniya" },
  WDD: { manufacturer: "Mercedes-Benz", country: "Germaniya" },
  VF1: { manufacturer: "Renault", country: "Fransiya" },
  ZFA: { manufacturer: "Fiat", country: "Italiya" },
  Z8M: { manufacturer: "Marussia", country: "Rossiya" },
};

/** WMI jadvalda boʻlmasa — faqat hudud (birinchi belgi) boʻyicha mamlakat taxmini. */
const REGION_BY_FIRST_CHAR = {
  1: "AQSh",
  2: "Kanada",
  3: "Meksika",
  4: "AQSh",
  5: "AQSh",
  6: "Avstraliya",
  7: "Yangi Zelandiya",
  8: "Argentina",
  9: "Braziliya",
  J: "Yaponiya",
  K: "Janubiy Koreya",
  L: "Xitoy",
  M: "Hindiston",
  N: "Turkiya",
  S: "Buyuk Britaniya",
  V: "Fransiya",
  W: "Germaniya",
  X: "Rossiya",
  Y: "Shvetsiya",
  Z: "Italiya",
};

/**
 * Tasdiqlangan zavod kodlari: kalit `WMI + 11-belgi`.
 *
 * Boʻsh turishi ataylab: zavod kodlarini har bir ishlab chiqaruvchi oʻzi eʼlon qiladi va
 * UzAuto Motors (Asaka / Xorazm-Pitnak) uchun ochiq, tasdiqlangan jadval topilmadi.
 * Kod tasdiqlangach shu yerga qoʻshiladi va `assemblyPlant` avtomatik toʻladi.
 */
const PLANT_CODES = {};

const isString = (value) => typeof value === "string";

/** 10-belgini yilga aylantiradi; sikl 7-belgiga qarab tanlanadi (raqam → 1980+, harf → 2010+). */
function modelYearFromCode(code, seventh) {
  const index = MODEL_YEAR_CODES.indexOf(code);
  if (index < 0) return null;

  const cycle = /\d/.test(seventh ?? "") ? FIRST_CYCLE : SECOND_CYCLE;
  return cycle + index;
}

/**
 * VIN ni dekod qiladi. Har qanday kirish uchun obyekt qaytaradi (notoʻgʻri boʻlsa valid:false).
 *
 * @param {string} value — 17 belgili VIN
 * @returns {{valid: boolean, wmi?: string, country?: string|null, manufacturer?: string|null,
 *            modelYear?: number|null, assemblyPlant?: string|null, plantCode?: string,
 *            region?: string, serial?: string, reason?: string}}
 */
export function decodeVin(value) {
  const raw = String(value ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "");

  if (!raw) return { valid: false, reason: "empty" };
  if (raw.length !== VIN_LENGTH) return { valid: false, reason: "length" };
  if (!VIN_PATTERN.test(raw)) return { valid: false, reason: "charset" };

  const wmi = raw.slice(0, 3);
  const plantCode = raw[10];
  const seventh = raw[6];
  const known = WMI_TABLE[wmi] ?? null;

  return {
    valid: true,
    wmi,
    country: known?.country ?? REGION_BY_FIRST_CHAR[raw[0]] ?? null,
    manufacturer: known?.manufacturer ?? null,
    modelYear: modelYearFromCode(raw[9], seventh),
    assemblyPlant: PLANT_CODES[`${wmi}${plantCode}`] ?? null,
    plantCode,
    region: raw.slice(0, 8),
    serial: raw.slice(11),
  };
}

/** Qulay yordamchi: VIN yaroqli va dekodlangan boʻlsa `true`. */
export function isVinValid(value) {
  return VIN_PATTERN.test(
    String(value ?? "")
      .toUpperCase()
      .replace(/[\s-]/g, "")
  );
}

/** Kartochka/PDF uchun bir qatorli izoh: "Ishlab chiqaruvchi (mamlakat) · 2019 yil". */
export function formatVinSummary(decoded) {
  if (!decoded?.valid) return null;

  const parts = [
    decoded.manufacturer && decoded.country
      ? `${decoded.manufacturer} (${decoded.country})`
      : decoded.manufacturer ?? decoded.country,
    decoded.modelYear ? `${decoded.modelYear} yil` : null,
    decoded.assemblyPlant,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : null;
}
