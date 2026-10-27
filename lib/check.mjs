/**
 * AvtoInfo — Vercel Serverless Function logic (server-side only).
 *
 * Every number in the report comes from a real source (lib/epolis.mjs) or is explicitly
 * marked as not checked. Nothing is invented: when the source is silent, the blocks say so
 * instead of showing placeholder values. The builder "never throws": every failure becomes
 * a structured report with an honest state, never a crash.
 *
 * Credentials must stay on the server. Never call these sources from the browser.
 */

export const MAX_BODY_BYTES = 4096;
export const EPOLIS_TIMEOUT_MS = 4000;

/* ------------------------------- helpers -------------------------------- */

export function cleanRegion(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 2);
}
export function cleanSeries(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3);
}
export function cleanTechNumber(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 7);
}

/** Accepts "a777aa" or "A 777 AA" and returns the canonical "A 777 AA". */
export function normalizePlate(value) {
  const raw = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = raw.match(/^([A-Z])(\d{3})([A-Z]{2})$/);
  return match ? `${match[1]} ${match[2]} ${match[3]}` : "";
}

const pad2 = (value) => String(value).padStart(2, "0");

/** "12.11.2026" | "2026-11-12" → Date (local, day precision). Returns null when unusable. */
export function parseDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const uz = raw.match(/^(\d{1,2})[./\\-](\d{1,2})[./\\-](\d{4})$/);
  if (uz) {
    const [, day, month, year] = uz;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, year, month, day] = iso;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

/** Date → "12.11.2026" */
function toUzbekDate(date) {
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/**
 * The only place that decides whether an OSAGO policy is active.
 * Expired means the expiry day is strictly before today.
 */
export function insuranceStatus(validUntil, now = new Date()) {
  const until = parseDate(validUntil);
  if (!until) return { status: "Muddati nomaʼlum", tone: "warn" };

  const endOfDay = new Date(
    until.getFullYear(),
    until.getMonth(),
    until.getDate(),
    23,
    59,
    59,
    999
  );
  const active = endOfDay.getTime() >= now.getTime();

  return active
    ? { status: "Amal qiladi", tone: "info" }
    : { status: "Muddati oʻtgan", tone: "warn" };
}

/* --------------------------- E-Polis adapter ---------------------------- */

import { fetchEpolisData } from "./epolis.mjs";
import { checkMibBan } from "./mib.mjs";
import { decodeVin, formatVinSummary } from "./vin.mjs";

/** Manba kutilmagan xato bersa ishlatiladigan xavfsiz holat (Promise.allSettled uchun). */
const EPOLIS_UNAVAILABLE = {
  ok: false,
  found: false,
  reason: "unreachable",
  httpStatus: null,
  vehicle: null,
  insurance: null,
  mode: "plain",
  endpoint: null,
};

const MIB_UNAVAILABLE = {
  checked: false,
  hasBan: false,
  hasSearch: false,
  details: [],
  status: "unavailable",
  reason: "unreachable",
  httpStatus: null,
};

/* -------------------------------- report -------------------------------- */

/**
 * MIB kartochkasi — faqat haqiqiy javobga tayanadi:
 *   javob yoʻq → kulrang "Tekshirilmadi", taqiq/qidiruv → qizil, toza → yashil.
 * Izohlar roʻyxati `items` ga emas, `note` ga tushadi — chunki `items` jarimalar jadvali
 * uchun ajratilgan (sana/sabab/summa).
 */
function buildMibCheck(mib) {
  const base = { id: "prohibitions", icon: "lock", title: "MIB / Sud taqiqlari" };

  if (!mib.checked) {
    const notConfigured = mib.reason === "not_configured";

    return {
      ...base,
      status: "Tekshirilmadi",
      tone: "muted",
      detail: notConfigured
        ? "MIB integratsiyasi sozlanmagan (MIB_API_URL berilmagan)"
        : "MIB xizmatidan javob olinmadi",
      note: notConfigured
        ? "Manzil berilgach taqiq va qidiruv holati avtomatik tekshiriladi"
        : "Keyinroq qayta urinib koʻring",
    };
  }

  if (mib.hasBan || mib.hasSearch) {
    return {
      ...base,
      status: mib.hasBan ? "Taqiq bor" : "Qidiruvda",
      tone: "danger",
      detail: mib.hasBan
        ? "MIB bazasida bu avtomobilga taqiq qoʻyilgan"
        : "Avtomobil MIB qidiruv roʻyxatida",
      note: mib.details.length > 0 ? mib.details.join(" · ") : null,
    };
  }

  return {
    ...base,
    status: "Taqiq yoʻq",
    tone: "ok",
    detail: "MIB bazasida taqiq va qidiruv topilmadi",
    note: null,
  };
}

/**
 * The complete check block set — it is used for every outcome, so the screen never
 * needs a placeholder set:
 *   - vehicle (avtomobil kartochka) shows the real record when E-Polis returned one,
 *     enriched with the offline VIN decode (manufacturer / country / model year);
 *   - MIB reflects the real ban/search answer;
 *   - fines / pledge are not wired up yet and say "Tekshirilmagan" — with no numbers;
 *   - insurance uses the live E-Polis values, or states plainly that no policy was found.
 */
function buildChecks({ epolis, mib, vin }) {
  const vehicleCheck = (() => {
    if (!epolis.ok) {
      return {
        id: "vehicle",
        icon: "shield",
        title: "Avtomobil",
        status: "Maʼlumot yoʻq",
        tone: "warn",
        detail: "E-Polis bazasiga ulanib boʻlmadi",
        note: "Tekshiruvni bir necha soniyadan soʻng qayta urinib koʻring",
      };
    }

    if (!epolis.found || !epolis.vehicle) {
      return {
        id: "vehicle",
        icon: "shield",
        title: "Avtomobil",
        status: "Topilmadi",
        tone: "warn",
        detail: epolis.ok
          ? "ERSP bazasida bu davlat raqami boʻyicha yozuv yoʻq"
          : "E-Polis bazasidan maʼlumot olinmadi",
        note: "Davlat raqami va texpasport seriyasini tekshiring",
      };
    }

    const { model, year, vin: vinCode, engineNumber } = epolis.vehicle;
    const factory = formatVinSummary(vin);
    // Reyestr yilni bermasa, oflayn VIN dekoderining 10-belgidan topilgan yili ishlatiladi.
    const resolvedYear = year ?? (vin?.valid && vin.modelYear ? String(vin.modelYear) : null);
    const headline = [model, resolvedYear ? `${resolvedYear} yil` : null]
      .filter(Boolean)
      .join(" · ") || "Modeli nomaʼlum";
    const ids = [
      vinCode ? `Kuzov (VIN): ${vinCode}` : null,
      engineNumber ? `Dvigatel: ${engineNumber}` : null,
      factory ? `Zavod: ${factory}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      id: "vehicle",
      icon: "shield",
      title: "Avtomobil",
      status: "Topildi",
      tone: "ok",
      detail: headline,
      note: ids || "Qoʻshimcha raqamlar keltirilmagan",
      vin: vin?.valid ? vin : null,
    };
  })();

  const insuranceCheck = (() => {
    const base = { id: "insurance", icon: "clock", title: "Sugʻurta (OSAGO)" };

    if (!epolis.ok) {
      return {
        ...base,
        status: "Maʼlumot yoʻq",
        tone: "warn",
        detail: "E-Polis bazasiga ulanib boʻlmadi",
        note: "Polis maʼlumoti hozircha mavjud emas",
      };
    }

    if (!epolis.insurance) {
      return {
        ...base,
        status: "Polis topilmadi",
        tone: "warn",
        detail: epolis.found
          ? "E-Polis bazasida polis yozuvi yoʻq"
          : "Avtomobil bazada topilmadi",
        note: "Sugʻurta tashkiloti yoki polis raqamini tekshiring",
      };
    }

    const { company, policy, startDate, endDate, status, tone } = epolis.insurance;
    const period = startDate && endDate
      ? `${startDate} — ${endDate}`
      : endDate
        ? `${endDate} gacha`
        : null;

    return {
      ...base,
      status,
      tone: tone || "info",
      detail: period
        ? `Amal qilish muddati: ${period}`
        : "Amal qilish muddati koʻrsatilmagan",
      note:
        [policy ? `Polis: ${policy}` : null, company]
          .filter(Boolean)
          .join(" · ") || null,
      policy: policy ?? null,
      company: company ?? null,
      startDate: startDate ?? null,
      endDate: endDate ?? null,
    };
  })();

  return [
    vehicleCheck,
    buildMibCheck(mib),
    {
      id: "fines",
      icon: "receipt",
      title: "YHXBB jarimalari",
      status: "Tekshirilmagan",
      tone: "info",
      detail: "YHXBB boʻyicha integratsiya hozircha ulanmagan",
      items: [],
    },
    {
      id: "pledge",
      icon: "lock",
      title: "Notarial garov (Zalog)",
      status: "Tekshirilmagan",
      tone: "info",
      detail: "Notarial garov boʻyicha integratsiya hozircha ulanmagan",
    },
    insuranceCheck,
  ];
}

function verdictFor(epolis, mib) {
  // Taqiq yoki qidiruv — eng muhim xabar, shuning uchun eng birinchi tekshiriladi.
  if (mib.checked && (mib.hasBan || mib.hasSearch)) {
    return {
      tone: "danger",
      label: mib.hasBan ? "MIB taqiqi aniqlandi" : "Avtomobil MIB qidiruvida",
      count: 0,
    };
  }

  if (!epolis.ok) return { tone: "warn", label: "E-Polis bazasiga ulanib boʻlmadi", count: 0 };
  if (!epolis.found) return { tone: "warn", label: "Avtomobil E-Polis bazasida topilmadi", count: 0 };
  if (!epolis.insurance) return { tone: "warn", label: "Sugʻurta polisi topilmadi", count: 0 };
  if (epolis.insurance.tone === "warn") {
    return {
      tone: "warn",
      label: `Sugʻurta holati: ${epolis.insurance.status.toLowerCase()}`,
      count: 0,
    };
  }
  return { tone: "ok", label: "Avtomobil va sugʻurta maʼlumotlari topildi", count: 0 };
}

/** MIB tekshirilmagan boʻlsa, hisobotning toʻliq emasligini ochiq aytadi. */
function mibNotice(mib) {
  if (mib.checked) return null;

  return mib.reason === "not_configured"
    ? "MIB taqiqlari boʻyicha integratsiya hali sozlanmagan — bu boʻlim tekshirilmadi."
    : "MIB xizmatidan javob olinmadi — taqiq va qidiruv holati tekshirilmadi.";
}

function noticeFor(epolis) {
  if (epolis.ok) return null;

  const reason = epolis.reason;
  if (!reason) return "E-Polis bazasidan maʼlumot olinmadi.";

  if (reason === "html_response") {
    return "E-Polis bazasi hozircha JSON javob bermayapti — avtomobil maʼlumotlari koʻrsatilmadi.";
  }
  if (reason === "invalid_json") {
    return "E-Polis javobini oʻqib boʻlmadi — avtomobil maʼlumotlari koʻrsatilmadi.";
  }
  if (reason === "empty") {
    return "E-Polis bazasi boʻsh javob qaytardi — avtomobil maʼlumotlari koʻrsatilmadi.";
  }
  if (reason === "not_found") {
    return "Avtomobil E-Polis bazasida topilmadi — davlat raqami va texpasport maʼlumotlarini tekshiring.";
  }
  if (reason?.startsWith("http_")) {
    return `E-Polis bazasi ${reason.replace("http_", "")} xatosini qaytardi — avtomobil maʼlumotlari koʻrsatilmadi.`;
  }

  if (reason === "timeout") {
    return "E-Polis bazasi muddatida javob bermadi — avtomobil maʼlumotlari koʻrsatilmadi.";
  }
  if (reason === "unreachable") {
    return "E-Polis bazasiga ulanib boʻlmadi — avtomobil maʼlumotlari koʻrsatilmadi.";
  }

  return "E-Polis bazasidan maʼlumot olinmadi.";
}

/**
 * Builds the report for an already-validated query.
 * Everything except `plate`/`techPassport`/`checkedAt` comes from the server, so the browser
 * can only format — never invent — what is shown.
 */
export async function buildReport({ region, plate, techPassport, checkedAt }, env = {}) {
  const query = `${region} ${plate}`;

  // E-Polis va MIB bir-birini kutmasligi uchun parallel ishga tushadi; ikkala adapter ham
  // hech qachon throw qilmaydi, allSettled esa kutilmagan xatoga qarshi ikkinchi parda.
  const [epolisSettled, mibSettled] = await Promise.allSettled([
    fetchEpolisData(query, techPassport?.series ?? "", techPassport?.number ?? "", env),
    checkMibBan(query, env),
  ]);

  const epolis = epolisSettled.status === "fulfilled" ? epolisSettled.value : EPOLIS_UNAVAILABLE;
  const mib = mibSettled.status === "fulfilled" ? mibSettled.value : MIB_UNAVAILABLE;

  // VIN faqat E-Polis haqiqiy yozuv qaytarganda mavjud — dekod oflayn, tarmoqsiz.
  const vin = epolis.ok && epolis.found ? decodeVin(epolis.vehicle?.vin) : { valid: false, reason: "no_vin" };

  // One and the same block set for every outcome: real values where we have them,
  // "Tekshirilmagan" where we do not. No placeholder numbers exist in this file.
  const checks = buildChecks({ epolis, mib, vin });

  const verdict = verdictFor(epolis, mib);
  const notice = [noticeFor(epolis), mibNotice(mib)].filter(Boolean).join(" ") || null;

  const warnings = checks.filter((check) => check.tone === "warn" || check.tone === "danger").length;

  return {
    plate: {
      region,
      number: plate,
      full: `${region} · ${plate}`,
      compact: `${region}${plate.replace(/\s/g, "")}`,
    },
    techPassport,
    techPassportLabel: techPassport
      ? `TP ${techPassport.series} ${techPassport.number}`
      : "TP koʻrsatilmagan",
    checkedAt,
    vehicle: epolis.ok && epolis.found ? epolis.vehicle : null,
    insurance: epolis.ok && epolis.insurance ? epolis.insurance : null,
    verdict,
    checks,
    vin: vin.valid ? vin : null,
    // YHXBB va garov hali ulanmagan — boʻsh, ammo strukturalangan bloklar.
    fines: { count: 0, amount: 0, items: [] },
    mib: {
      checked: mib.checked,
      status: mib.status,
      hasBan: mib.hasBan,
      hasSearch: mib.hasSearch,
      details: mib.details,
      reason: mib.reason ?? null,
    },
    pledge: { status: "Tekshirilmagan", items: [] },
    totals: {
      fines: 0,
      finesTotal: 0,
      warnings,
      bans: mib.checked && (mib.hasBan || mib.hasSearch) ? 1 : 0,
    },
    source: {
      registry: epolis.ok && epolis.found ? "epolis" : epolis.ok ? "not_found" : "unavailable",
      insurance: epolis.ok && epolis.insurance ? "live" : epolis.ok ? "not_found" : "fallback",
      provider: "ersp.e-osgo.uz",
    },
    notice,
    sourceLine: null,
    insuredUntil: epolis.insurance?.endDate ?? null,
  };
}

/* ------------------------------- endpoint ------------------------------- */

const ok = (body, status = 200) => ({ status, body });

export const fail = (code, message, field = null, status = 400) => ({
  status,
  body: { ok: false, error: { code, message, field } },
});

/**
 * Validates the POSTed payload and returns { status, body }.
 * `payload` must already be a parsed object; `env` carries the runtime bindings/vars.
 */
export async function handleCheckPayload(payload, env = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return fail("bad_request", "Soʻrov formati notoʻgʻri.");
  }

  // Yangi (E-Polis uslubi) va eski kalitlar birga qoʻllab-quvvatlanadi:
  //   plateNumber: "01 A 777 AA"  |  plate: "A 777 AA" + region: "01"
  let compact = String(payload.plate || payload.plateNumber || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  let region = cleanRegion(payload.region);
  if (/^\d{2}/.test(compact)) {
    if (!region) region = compact.slice(0, 2);
    compact = compact.slice(2);
  }

  if (!/^\d{2}$/.test(region)) {
    return fail(
      "invalid_region",
      "Viloyat kodi 2 ta raqamdan iborat boʻlishi kerak (masalan 01).",
      "region"
    );
  }

  const plate = normalizePlate(compact);
  if (!plate) {
    return fail("invalid_plate", "Davlat raqami notoʻgʻri. Namuna: 01 · A 777 AA", "plate");
  }

  const series = cleanSeries(payload.techPassportSeries || payload.tpSeries);
  const number = cleanTechNumber(payload.techPassportNumber || payload.tpNumber);
  let techPassport = null;

  if (series || number) {
    if (series.length !== 3 || number.length !== 7) {
      return fail(
        "invalid_tech_passport",
        "Texnik pasport: seriya 3 harf (AAF), raqam 7 raqam (1234567).",
        "techPassport"
      );
    }
    techPassport = { series, number };
  }

  const report = await buildReport(
    {
      region,
      plate,
      techPassport,
      checkedAt: new Date().toISOString(),
    },
    env
  );

  return ok({ ok: true, report });
}

/** Parses the raw request body, returning `{ payload }` or `{ error }`. */
export async function readJsonBody(raw) {
  const text = String(raw ?? "").trim();
  if (!text)
    return { error: fail("bad_request", "Soʻrov formati notoʻgʻri (JSON kutilgan).") };

  try {
    const payload = JSON.parse(text);
    return { payload };
  } catch {
    return { error: fail("bad_request", "Soʻrov formati notoʻgʻri (JSON kutilgan).") };
  }
}

export function tooLarge() {
  return fail("payload_too_large", "Soʻrov hajmi juda katta.", null, 413);
}
