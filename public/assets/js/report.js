/**
 * Report client.
 * All findings come from POST /api/check (Vercel Serverless Function); the browser only formats them.
 */

const MONTHS = [
  "yanvar", "fevral", "mart", "aprel", "may", "iyun",
  "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr",
];

export class ApiError extends Error {
  constructor(message, { status = 0, code = "unknown" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function formatMoney(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/** 26.10.2026, 14:32 */
export function formatDateTime(date = new Date()) {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}, ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** "bugun, 14:32" */
export function formatShortTime(date = new Date()) {
  return `bugun, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatLongDate(date = new Date()) {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** How long the client waits for /api/check before giving up (the server has its own
 * 4s upstream timeout for the insurance source, so 15s means the backend itself is stuck). */
export const REQUEST_TIMEOUT_MS = 15000;

/**
 * Runs the server-side check and returns the report with a real Date.
 * The body uses the E-Polis naming (plateNumber / techPassportSeries / techPassportNumber);
 * the server also accepts the legacy short keys.
 * @param {{region: string, plate: string, tpSeries?: string, tpNumber?: string}} input
 */
export async function requestReport({ region, plate, tpSeries, tpNumber }) {
  let response;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

  try {
    response = await fetch("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        region,
        plateNumber: [region, plate].filter(Boolean).join(" "),
        techPassportSeries: tpSeries ?? "",
        techPassportNumber: tpNumber ?? "",
      }),
      signal: controller?.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new ApiError("Server juda sekin javob bermoqda. Bir necha soniyadan soʻng yana urinib koʻring.", {
        code: "timeout",
      });
    }
    throw new ApiError("Server bilan aloqa oʻrnatilmadi. Internetni tekshiring.", {
      code: "network_error",
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    /* non-JSON error page */
  }

  if (!response.ok || !data?.ok) {
    const upstream = response.status >= 500 || response.status === 429;
    throw new ApiError(
      data?.error?.message ??
        (upstream
          ? "Tekshiruv xizmati vaqtincha ishlamayapti. Birozdan soʻng yana urinib koʻring."
          : "Tekshiruvni bajarish imkonsiz boʻldi. Keyinroq urinib koʻring."),
      { status: response.status, code: data?.error?.code ?? "server_error" }
    );
  }

  return { ...data.report, checkedAt: new Date(data.report.checkedAt) };
}
