/**
 * AvtoInfo — MIB (Majburiy ijro byurosi) taqiq/qidiruv adapteri.
 *
 * MUHIM (ochiq manba tekshiruvi): MIB ning avtotransportni davlat raqami boʻyicha tekshirish
 * xizmati mib.uz saytining “Interaktiv xizmatlar” boʻlimida bor, lekin uning
 * hujjatlashtirilgan ochiq JSON API manzili eʼlon qilinmagan. Shu sababli bu adapter manzilni
 * oʻzi oʻylab topmaydi: `MIB_API_URL` berilmasa tarmoqqa umuman chiqmaydi va
 * `{ checked: false, status: "unavailable" }` qaytaradi. Manzil (rasmiy endpoint yoki oʻz
 * proxyingiz) berilganda esa JSON javobni tolerant oʻqiydi.
 *
 * Nima uchun HTML javob oson oʻqilmaydi: mib.uz sahifasining oʻzida ham “taqiq”, “qidiruv”
 * soʻzlari forma sarlavhalarida uchraydi — ularni matn qidiruvi bilan tahlil qilish yolgʻon
 * “taqiq bor” degan xulosaga olib keladi. Shu sababli HTML javob `unavailable` deb belgilanadi,
 * taxmin qilinmaydi.
 *
 * Javob sxemasi (hech qachon throw qilmaydi):
 *   {
 *     checked: boolean,
 *     hasBan: boolean,
 *     hasSearch: boolean,
 *     details: string[],
 *     status: "clean" | "banned" | "wanted" | "unavailable",
 *     reason: string|null, httpStatus: number|null
 *   }
 */

export const MIB_TIMEOUT_MS = 4000;

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0.0.0 Safari/537.36";

/** Taqiqni bildiruvchi kalitlar. */
const BAN_KEYS = [
  "hasban",
  "ban",
  "banned",
  "isbanned",
  "taqiq",
  "taqiqlangan",
  "prohibition",
  "prohibitions",
  "restriction",
  "restrictions",
  "arrest",
  "arrests",
  "isarrested",
];

/** Qidiruvni (розыск) bildiruvchi kalitlar. */
const SEARCH_KEYS = [
  "hassearch",
  "search",
  "wanted",
  "wantedlist",
  "iswanted",
  "qidiruv",
  "qidiruvda",
  "rozisk",
];

/** Izohlar roʻyxati olinadigan kalitlar. */
const DETAIL_KEYS = [
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
];

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** "true"/"1"/toʻlmagan roʻyxat — mavjud deb hisoblanadi. */
function isTruthy(value) {
  if (value === true) return true;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (!text) return false;
    return !["false", "0", "no", "yoʻq", "yoq", "none", "null", "clean", "toza"].includes(text);
  }
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return false;
}

/** Javobdan qidiriladigan konteynerlar: ildiz + keng tarqalgan wrap kalitlar. */
function candidates(payload) {
  const list = [payload];
  const wrapKeys = ["data", "result", "results", "response", "payload", "body"];

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

/** Kalit nomini taqqoslash uchun normallashtirish: "has_ban" → "hasban". */
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

/** Izohlar: satrlar va obyektlardan oʻqiladigan qisqa matnlar (koʻpi bilan 5 ta). */
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
        .map((key) => value[key])
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

/** MIB javobini yagona holatga keltiradi. */
export function normalizeMibResponse(payload) {
  const sources = candidates(payload);
  const hasBan = flagFrom(sources, BAN_KEYS);
  const hasSearch = flagFrom(sources, SEARCH_KEYS);
  const details = detailsFrom(sources);

  const status = hasBan ? "banned" : hasSearch ? "wanted" : "clean";

  return { hasBan, hasSearch, details, status };
}

/** MIB soʻrovi uchun payload: davlat raqami boʻsh joysiz, katta harflarda. */
export function buildMibPayload(plateNumber) {
  return {
    govNumber: String(plateNumber ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, ""),
  };
}

const unavailable = (reason, httpStatus = null) => ({
  checked: false,
  hasBan: false,
  hasSearch: false,
  details: [],
  status: "unavailable",
  reason,
  httpStatus,
});

function reasonFromError(error) {
  const name = error?.name;
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  return "unreachable";
}

/**
 * MIB bazasidan avtoraqam boʻyicha taqiq/qidiruvni tekshiradi.
 *
 * @param {string} plateNumber — davlat raqami ("01 A 777 AA")
 * @param {object} [env] — { MIB_API_URL, MIB_API_KEY, MIB_TIMEOUT_MS }
 */
export async function checkMibBan(plateNumber, env = {}) {
  const endpoint = String(env.MIB_API_URL ?? "").trim();
  if (!endpoint) return unavailable("not_configured");

  const payload = buildMibPayload(plateNumber);
  if (!payload.govNumber) return unavailable("bad_plate");

  const timeoutMs =
    Number(env.MIB_TIMEOUT_MS) > 0 ? Number(env.MIB_TIMEOUT_MS) : MIB_TIMEOUT_MS;

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": CHROME_UA,
        ...(env.MIB_API_KEY ? { authorization: `Bearer ${env.MIB_API_KEY}` } : {}),
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
    // HTML/xato sahifasi — taxmin qilinmaydi (yuqoridagi izohga qarang).
    return unavailable("html_response", status);
  }

  let data = null;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return unavailable("invalid_json", status);
  }

  if (data === null || data === undefined) return unavailable("empty", status);

  return { checked: true, ...normalizeMibResponse(data), reason: null, httpStatus: status };
}
