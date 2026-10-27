/**
 * AvtoInfo — E-Polis (ersp.e-osgo.uz) adapter.
 *
 * Manba: Oʻzbekiston Yagona sugʻurta reestri (ERSP) ochiq tekshiruv xizmati.
 * Soʻrov:  POST {EPOLIS_ENDPOINT}  JSON { govNumber, techPassportSeria, techPassportNumber }
 *
 * Sabablar bilan himoyalangan (bu jonli tashqi xizmat, u qanday javob berishi
 * oldindan aytib boʻlmaydi):
 *   - qattiq timeout (default 6 s) — ilova hech qachon osib qolmaydi;
 *   - agar birinchi soʻrov CSRF sababli 400 qaytarsa, sahifadan `_csrf` tokenini olib
 *     qayta urinadi (ERSP Yii2 da shunday ishlaydi);
 *   - baʼzi runtimelar `Origin` sarlavhasini yuborishga yoʻl qoʻymaydi — bunda
 *     minimal sarlavhalar bilan yana bir marta urinadi;
 *   - HTML javob (sahifa) JSON sifatida oʻqilmaydi → `html_response` sababi;
 *   - hech qachon throw qilmaydi: hamma xato `{ ok:false, reason }` koʻrinishida qaytadi.
 *
 * Javob sxemasi:
 *   {
 *     ok, found, reason, httpStatus,
 *     vehicle:   { model, year, vin, engineNumber } | null,
 *     insurance: { company, policy, startDate, endDate, status, tone } | null
 *   }
 */

import { insuranceStatus, parseDate } from "./check.mjs";

export const EPOLIS_ORIGIN = "https://ersp.e-osgo.uz";
export const EPOLIS_ENDPOINT = `${EPOLIS_ORIGIN}/api/v1/public/check/osgo`;
export const EPOLIS_TIMEOUT_MS = 6000;

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalar = (value) =>
  value !== null && value !== undefined && (typeof value === "string" || typeof value === "number");

/* -------------------------------- payload -------------------------------- */

/** Soʻrov tanasi — spesifikatsiyadagidek. */
export function buildEpolisPayload(plate, techSeries, techNumber) {
  return {
    govNumber: String(plate ?? "").replace(/\s+/g, "").toUpperCase(),
    techPassportSeria: String(techSeries ?? "").replace(/\s+/g, "").toUpperCase(),
    techPassportNumber: String(techNumber ?? "").replace(/\s+/g, ""),
  };
}

/* ------------------------------- parser ---------------------------------- */

/** Birinchi topilgan qiymat (kalitlar ustuvorlik tartibida, manbalar boʻyicha). */
function firstOf(sources, keys) {
  for (const key of keys) {
    for (const source of sources) {
      const value = source?.[key];
      if (isScalar(value) && String(value).trim() !== "") return value;
    }
  }
  return null;
}

/** ERSP JSON ichidagi ehtimoliy yozuv konteynerlari. */
function candidates(payload) {
  if (Array.isArray(payload)) return payload.filter(isObject);
  if (!isObject(payload)) return [];

  const list = [];
  const queue = [{ node: payload, depth: 0 }];
  const seen = new Set();

  while (queue.length > 0) {
    const { node, depth } = queue.shift();
    if (seen.has(node)) continue;
    seen.add(node);
    list.push(node);
    if (depth >= 3) continue;

    for (const value of Object.values(node)) {
      if (isObject(value)) queue.push({ node: value, depth: depth + 1 });
      else if (Array.isArray(value)) {
        value.filter(isObject).forEach((item) =>
          queue.push({ node: item, depth: depth + 1 })
        );
      }
    }
  }

  return list;
}

function hasAny(list, keys) {
  return list.some(
    (source) =>
      keys.some((key) => isScalar(source?.[key]) && String(source[key]).trim() !== "")
  );
}

function uzbekDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = parseDate(raw);
  if (!date) return raw;
  return `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.${date.getFullYear()}`;
}

const VEHICLE_KEYS = [
  "modelCustomName",
  "modelName",
  "model",
  "carModel",
  "vehicleModel",
  "bodyNumber",
  "vin",
  "issueYear",
  "year",
  "engineNumber",
];
const INSURANCE_KEYS = [
  "companyName",
  "company",
  "insurer",
  "policyNumber",
  "policyNo",
  "contractNumber",
  "polisNumber",
  "startDate",
  "endDate",
  "validUntil",
  "validTo",
  "expiry",
  "toDate",
  "fromDate",
  "status",
  "policyStatus",
];

/** ERSP JSON ini bizning sxemamizga moslaydi. */
export function normalizeEpolisPayload(payload) {
  const list = candidates(payload);

  if (list.length === 0) return { found: false, vehicle: null, insurance: null };

  const sources = [...list];
  for (const source of list) {
    for (const key of ["policy", "osago", "insurance", "contract", "polis"]) {
      if (isObject(source[key])) sources.push(source[key]);
    }
  }

  const model = firstOf(
    sources,
    ["modelCustomName", "modelName", "model", "carModel", "vehicleModel", "brandModel"]
  );
  const year = firstOf(sources, [
    "issueYear",
    "year",
    "manufactureYear",
    "yearOfIssue",
    "productionYear",
  ]);
  const vin = firstOf(
    sources,
    ["bodyNumber", "vin", "chassisNumber", "bodyNo", "frameNumber"]
  );
  const engine = firstOf(sources, ["engineNumber", "motorNumber", "engineNo", "engine"]);

  const vehicle =
    model || year || vin || engine
      ? {
          model: model ? String(model) : null,
          year: year ? String(year) : null,
          issueYear: year ? String(year) : null,
          vin: vin ? String(vin) : null,
          bodyNumber: vin ? String(vin) : null,
          engineNumber: engine ? String(engine) : null,
        }
      : null;

  const company = firstOf(
    sources,
    ["companyName", "company", "insurer", "insurerName", "insuranceCompany", "orgName"]
  );
  const policy = firstOf(
    sources,
    [
      "policyNumber",
      "policyNo",
      "contractNumber",
      "polisNumber",
      "polis",
      "policy",
      "serialNumber",
    ]
  );
  const start = firstOf(sources, [
    "startDate",
    "fromDate",
    "beginDate",
    "issueDate",
    "start",
    "effectiveFrom",
  ]);
  const end = firstOf(sources, [
    "endDate",
    "toDate",
    "expirationDate",
    "validUntil",
    "validTo",
    "expiry",
    "end",
    "effectiveTo",
  ]);
  const rawStatus = firstOf(
    sources,
    ["status", "state", "policyStatus", "statusName", "polisStatus"]
  );

  let insurance = null;
  if (company || policy || start || end || rawStatus) {
    const computed = end ? insuranceStatus(end) : null;
    const activeByText = /amal|active|haqiqiy|valid|degan/i.test(
      String(rawStatus ?? "")
    );

    insurance = {
      company: company ? String(company) : null,
      policy: policy ? String(policy) : null,
      startDate: uzbekDate(start),
      endDate: uzbekDate(end),
      status: computed?.status ?? (rawStatus ? String(rawStatus) : "Nomaʼlum"),
      tone: computed?.tone ?? (activeByText ? "info" : "warn"),
    };
  }

  const explicitNo =
    payload?.found === false ||
    payload?.success === false ||
    payload?.exists === false ||
    payload?.matched === false ||
    payload?.notFound === true ||
    payload?.error === true;

  const found = !explicitNo && hasAny(list, [...VEHICLE_KEYS, ...INSURANCE_KEYS]);

  return { found, vehicle, insurance };
}

/* ------------------------------- transport ------------------------------- */

function timeoutSignal(deadline) {
  const remaining = Math.max(deadline - Date.now(), 1);
  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), remaining) : null;
  return { controller, timer, remaining };
}

function collectCookies(response) {
  const headers = response?.headers;
  if (!headers) return "";
  const cookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie")]
        : [];
  return cookies.map((cookie) => String(cookie).split(";")[0]).join("; ");
}

function readCsrfToken(html) {
  const match = String(html).match(
    /name=["']csrf-token["']\s+content=["']([^"']+)["']/i
  );
  return match ? match[1] : null;
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** Standart spesifikatsiya soʻrovi (Origin/Referer/Chrome UA bilan). */
async function postJson(endpoint, payload, extraHeaders, deadline) {
  const { controller, timer, remaining } = timeoutSignal(deadline);
  try {
    return await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: EPOLIS_ORIGIN,
        referer: `${EPOLIS_ORIGIN}/`,
        "user-agent": CHROME_UA,
        "x-requested-with": "XMLHttpRequest",
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Minimal sarlavhalar (runtime `Origin` ni rad etsa ishlatiladi). */
async function postJsonBare(endpoint, payload, deadline) {
  const { controller, timer } = timeoutSignal(deadline);
  try {
    return await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Sahifadan `_csrf` tokeni va cookie larni oladi (Yii2 CSRF qoʻriqlashi uchun). */
async function readCsrf(endpoint, deadline) {
  const { controller, timer } = timeoutSignal(deadline);
  try {
    const response = await fetch(endpoint, {
      headers: { accept: "text/html", "user-agent": CHROME_UA },
      signal: controller?.signal,
    });
    const html = await safeText(response);
    return { token: readCsrfToken(html), cookie: collectCookies(response) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reasonFromError(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError")
    return "timeout";
  return "unreachable";
}

/* ------------------------------- main entry ------------------------------ */

/**
 * E-Polis dan avtomobil va sugʻurta maʼlumotini oladi. Hech qachon throw qilmaydi.
 *
 * @param {string} plate      davlat raqami ("01 A 777 AA" yoki "A 777 AA")
 * @param {string} techSeries texpasport seriyasi ("AAF")
 * @param {string} techNumber texpasport raqami ("1234567")
 * @param {object} [env]      { EPOLIS_API_URL, EPOLIS_API_KEY, EPOLIS_TIMEOUT_MS }
 * @returns {Promise<{ok: boolean, found: boolean, reason: string|null, httpStatus: number|null,
 *                    vehicle: object|null, insurance: object|null, mode: string, endpoint: string}>}
 */
export async function fetchEpolisData(plate, techSeries, techNumber, env = {}) {
  const endpoint = env.EPOLIS_API_URL || EPOLIS_ENDPOINT;
  const timeoutMs =
    Number(env.EPOLIS_TIMEOUT_MS) > 0 ? Number(env.EPOLIS_TIMEOUT_MS) : EPOLIS_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const payload = buildEpolisPayload(plate, techSeries, techNumber);

  const failure = (reason, httpStatus = null) => ({
    ok: false,
    found: false,
    reason,
    httpStatus,
    vehicle: null,
    insurance: null,
    mode: "plain",
    endpoint,
  });

  let response = null;
  let mode = "plain";
  let transportError = undefined;

  // 1) standart soʻrov
  try {
    response = await postJson(
      endpoint,
      payload,
      env.EPOLIS_API_KEY
        ? { authorization: `Bearer ${env.EPOLIS_API_KEY}` }
        : {},
      deadline
    );
  } catch (error) {
    transportError = error;
  }

  // 2) CSRF yoki sarlavha rad etilgani uchun qayta urinishlar
  if (!response || !response.ok) {
    try {
      const { token, cookie } = await readCsrf(endpoint, deadline);
      if (token || cookie) {
        const headers = {};
        if (token) headers["x-csrf-token"] = token;
        if (cookie) headers.cookie = cookie;
        const retry = await postJson(endpoint, payload, headers, deadline);
        if (retry && (retry.ok || (retry.status !== 400 && retry.status !== 403))) {
          response = retry;
          mode = "csrf";
        }
      }
    } catch {
      transportError = undefined;
    }
  }

  if (!response || !response.ok) {
    try {
      response = await postJsonBare(endpoint, payload, deadline);
      if (response && (response.ok || (response.status !== 400 && response.status !== 403))) {
        mode = "minimal";
      }
    } catch {
      transportError = undefined;
    }
  }

  if (!response) return failure(reasonFromError(transportError));

  const status = response.status;

  if (status >= 400) return failure(`http_${status}`, status);

  const text = await safeText(response);
  const contentType = String(response.headers?.get?.("content-type") ?? "");
  const trimmed = text.trim();
  const looksJson =
    trimmed.startsWith("{") || trimmed.startsWith("[") || /json/i.test(contentType);

  if (!looksJson) {
    if (status >= 500) return failure(`http_${status}`, status);
    if (status >= 400) return failure(`http_${status}`, status);
    return failure("html_response", status);
  }

  let data = null;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return failure("invalid_json", status);
  }

  if (data === null || data === undefined) return failure("empty", status);

  const normalized = normalizeEpolisPayload(data);

  return {
    ok: true,
    found: normalized.found,
    reason: normalized.found ? null : "not_found",
    httpStatus: status,
    vehicle: normalized.found ? normalized.vehicle : null,
    insurance: normalized.found ? normalized.insurance : null,
    mode,
    endpoint,
  };
}
