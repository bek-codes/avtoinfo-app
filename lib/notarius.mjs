/** @module lib/notarius.mjs — E-Notarius umumiy taqiq, sud xatolari, soliq va bank/garovi qidiruvi */

/**
 * E-Notarius / general-notarius.uz umumiy avtotransport qidiruvi:
 * avtoraqam + texnik pasport berilganda bir vaqtning o'zida:
 *   - Davlat ijrochisi (MIB) taqiqlari
 *   - Sud xatlovlari / arestlar
 *   - Soliq org. taqiqlari
 *   - Bank / lizing garovlari
 *
 * Integratsiya talqin qilinmaydi, ochiq manba hali ishlatilmagan — shuning uchun shu vaqtda
 * adaptorda hech qanday soxta javob (masalan "TOZA", "2 ta jarima") ko'rsatilmaydi.
 * Manzil berilmagan yoki hech qanday so'rov muvaffaqiyatsiz tugaganda qaytadigan holat
 * faqat belgilangan struktura: { checked:false, status:"unavailable" }.
 */

export const NOTARIUS_TIMEOUT_MS = 4000;

/** Taqiqni bildiruvchi kalitlar (MIB yoki sud taqiqlari).
 *  adaptordagi kalitlar nomlari: https://github.com/bek-codes/avtoinfo-app/issues/42 */
const BAN_KEYS = new Set([
  "hasban",
  "ban",
  "banned",
  "isbanned",
  "taqiq",
  "taqiqlangan",
  "prohibition",
  "prohibitions",
  "restriction",
  "arrest",
  "arrests",
  "isarrested",
]);

/** Bank / lizing garovini bildiruvchi kalitlar. */
const PLEDGE_KEYS = new Set([
  "ispledged",
  "pledge",
  "pledged",
  "garov",
  "garovi",
  "zalog",
  "mortgage",
  "lien",
  "haspledge",
  "pledges",
]);

/** Qidiriladigan izohlar (satrlar, obyekt qisqlari). */
const DETAIL_KEYS = new Set([
  "details",
  "items",
  "list",
  "results",
  "reasons",
  "organizations",
  "restrictions",
  "prohibitions",
  "arrests",
  "messages",
  "pledgeDetails",
  "garovDetails",
]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** "true" / "1" / to'lmagan ro'yhat — mavjud deb hisoblanadi. */
function isTruthy(v) {
  if (v === true) return true;
  if (typeof v === "number") return v > 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (!t) return false;
    return !["false", "0", "no", "yo'q", "yoq", "none", "null", "clean", "toza", "garovda emas"].includes(t);
  }
  if (Array.isArray(v)) return v.length > 0;
  if (isObject(v)) return Object.keys(v).length > 0;
  return false;
}

/** Javobdan o'qiladigan konteynerlar: ildiz + ehtimoliy wrap kalitlar. */
function candidates(payload) {
  const list = [payload];
  const wrapKeys = ["data", "result", "results", "response", "payload", "body", "vehicle", "ban", "bans"];

  for (const key of wrapKeys) {
    const value = payload?.[key];
    if (isObject(value) || Array.isArray(value)) {
      list.push(value);
      if (isObject(value)) {
        for (const inner of wrapKeys) {
          if (isObject(value[inner])) list.push(value[inner]);
        }
      }
    }
  }
  return list;
}

/** Kalit nomini taqqoslash uchun normallashtirish: "has_ban" -> "hasban". */
const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, "");

function flagFrom(sources, keys) {
  const wanted = new Set(keys);
  for (const source of sources) {
    if (!isObject(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (wanted.has(normalizeKey(key)) && isTruthy(value)) return true;
    }
  }
  return false;
}

/** Izohlar: satrlar va obyekt qisqlarini o'qiydi (max 5 ta). */
function detailsFrom(sources) {
  const wanted = new Set(DETAIL_KEYS);
  const out = [];

  const push = (value) => {
    if (out.length >= 5) return;
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text && !out.includes(text)) out.push(text);
      return;
    }
    if (isObject(value)) {
      const readable = ["reason", "title", "name", "organization", "authority", "date", "description"]
        .map((k) => value[k])
        .filter((item) => typeof item === "string" || typeof item === "number")
        .map((item) => String(item).trim())
        .filter(Boolean);
      if (readable.length > 0) push(readable.join(" · "));
    }
  };

  for (const source of sources) {
    if (!isObject(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (!wanted.has(normalizeKey(key))) continue;
      if (Array.isArray(value)) value.forEach(push);
      else if (isObject(value)) Object.values(value).forEach(push);
      else push(value);
    }
  }
  return out;
}

/**
 * Notarius javobini yagona holatga keltiradi.
 * {
 *   checked, hasBan, isPledged, details, status: "clean"|"banned"|"pledged"|"unavailable"
 * }
 */
export function normalizeNotariusResponse(payload) {
  const sources = candidates(payload);
  const hasBan = flagFrom(sources, BAN_KEYS);
  const isPledged = flagFrom(sources, PLEDGE_KEYS);
  const details = detailsFrom(sources);

  let status;
  if (hasBan) status = "banned";
  else if (isPledged) status = "pledged";
  else status = "clean";

  return { hasBan, isPledged, details, status };
}

/** Notarius so'rovi uchun payload: davlat raqami + texpasport seriya/raqam. */
export function buildNotariusPayload(plateNumber, techSeries, techNumber) {
  return {
    govNumber: String(plateNumber ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
    techPassportSeria: String(techSeries ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
    techPassportNumber: String(techNumber ?? "").replace(/[^0-9]/g, ""),
  };
}

/** xato xulosasi. */
const unavailable = (reason, httpStatus = null) => ({
  checked: false,
  hasBan: false,
  isPledged: false,
  details: [],
  status: "unavailable",
  reason,
  httpStatus,
});

function reasonFromError(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "timeout";
  return "unreachable";
}

/**
 * O'zbekiston umumiy taqiq / garov qidiruvidan ma'lumot olish.
 *
 * @param {string} plateNumber    davlat raqami ("01 A 777 AA")
 * @param {string} techSeries     texnik pasport seriyasi ("AAF")
 * @param {string} techNumber     texnik pasport raqami ("1234567")
 * @param {object} [env]          { NOTARIUS_API_URL, NOTARIUS_API_KEY, NOTARIUS_TIMEOUT_MS }
 * @returns masa oralig'ida qaytadigan obyekt — hech qanday xato mumkin emas.
 */
export async function checkVehicleBans({ plateNumber, techSeries, techNumber }, env = {}) {
  const endpoint = String(env.NOTARIUS_API_URL ?? "").trim();
  if (!endpoint) return unavailable("not_configured");

  const payload = buildNotariusPayload(plateNumber, techSeries, techNumber);
  if (!payload.govNumber && !payload.techPassportSeria && !payload.techPassportNumber) {
    return unavailable("bad_payload");
  }

  const timeoutMs =
    Number(env.NOTARIUS_TIMEOUT_MS) > 0 ? Number(env.NOTARIUS_TIMEOUT_MS) : NOTARIUS_TIMEOUT_MS;

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "Mozilla/5.0 (compatible; AvtoInfo/1.1)",
        ...(env.NOTARIUS_API_KEY ? { authorization: `Bearer ${env.NOTARIUS_API_KEY}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
  } catch (error) {
    return unavailable(reasonFromError(error));
  } finally {
    if (timer) clearTimeout(timer);
  }

  const status = response.status;
  if (status >= 400) return unavailable(`http_${status}`, status);

  let text = "";
  try {
    text = await response.text();
  } catch {
    return unavailable("unreadable", status);
  }

  const contentType = String(response.headers?.get?.("content-type") ?? "");
  const trimmed = text.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !/json/i.test(contentType)) {
    // HTML/xato sahifasi — taxmin qilinmaydi.
    return unavailable("html_response", status);
  }

  let data = null;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return unavailable("invalid_json", status);
  }

  if (data === null || data === undefined) return unavailable("empty", status);

  const normalized = normalizeNotariusResponse(data);
  return { checked: true, reason: null, httpStatus: status, ...normalized };
}
