/** @module lib/taxi.mjs — Yo'nalishsiz taksi litsenziyasi reyestri */

/**
 * Transport vazirligi / yo'nalishsiz taksi litsenziyasi reyestridan
 * berilgan davlat raqami uchun taksi litsenziyasining mavjudligi tekshiriladi.
 * Hozircha tashqi integratsiya hali sozlanmagan — shuning uchun adaptorda
 * hech qanday soxta javob (masalan "litsenziya mavjud") ko'rsatilmaydi,
 * faqat mo'ljallangan holat: { checked:false, status:"unavailable" }.
 */

export const TAXI_TIMEOUT_MS = 4000;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Manzil berilmagan yoki ishlamagan holda qaytariladigan standart holat. */
const unavailable = (reason, httpStatus = null) => ({
  checked: false,
  isTaxi: false,
  licenseInfo: null,
  status: "unavailable",
  reason,
  httpStatus,
});

function reasonFromError(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "timeout";
  return "unreachable";
}

/**
 * Taksi litsenziyasi reyistridan ma'lumot olish.
 *
 * @param {string} plateNumber davlat raqami ("01 A 777 AA")
 * @param {object} [env] { TAXI_API_URL, TAXI_API_KEY, TAXI_TIMEOUT_MS }
 * @returns masa oralig'ida qaytadigan obyekt — hech qanday xato mumkin emas.
 */
export async function checkTaxiLicense(plateNumber, env = {}) {
  const endpoint = String(env.TAXI_API_URL ?? "").trim();
  if (!endpoint) return unavailable("not_configured");

  const payload = {
    govNumber: String(plateNumber ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
  };
  if (!payload.govNumber) return unavailable("bad_payload");

  const timeoutMs =
    Number(env.TAXI_TIMEOUT_MS) > 0 ? Number(env.TAXI_TIMEOUT_MS) : TAXI_TIMEOUT_MS;

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
        ...(env.TAXI_API_KEY ? { authorization: `Bearer ${env.TAXI_API_KEY}` } : {}),
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
    return unavailable("html_response", status);
  }

  let data = null;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return unavailable("invalid_json", status);
  }

  if (data === null || data === undefined) return unavailable("empty", status);

  // Javob qabul qilingan — real ma'lumotlar natijasini yagona holatga keltirish.
  // "isTaxi" yoki "licenseInfo" kaliti javobda uchratsa, xizmat javob bergan hisoblanadi
  // (isTaxi:false — bu ham haqiqiy javob: "litsenziya yo'q"), aks holda javob o'qilmagan.
  let isTaxi = false;
  let licenseInfo = null;
  let answered = false;

  if (isObject(data)) {
    if (typeof data.isTaxi === "boolean") {
      isTaxi = data.isTaxi;
      answered = true;
    } else if (typeof data.isTaxi === "string") {
      const text = data.isTaxi.trim().toLowerCase();
      isTaxi = text === "true" || text === "ha" || text === "1" || text === "yes";
      answered = true;
    }

    if (data.licenseInfo !== undefined && data.licenseInfo !== null) {
      licenseInfo = isObject(data.licenseInfo)
        ? data.licenseInfo
        : { info: String(data.licenseInfo) };
      answered = true;
      if (!isTaxi) isTaxi = true; // litsenziya ma'lumoti bor — taksi demak
    }
  }

  if (!answered) return unavailable("no_taxi_data", status);

  return {
    checked: true,
    isTaxi,
    licenseInfo,
    status: isTaxi ? "taxi" : "clean",
    reason: null,
    httpStatus: status,
  };
}
