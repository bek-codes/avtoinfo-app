/**
 * AvtoInfo — Vercel Serverless Function logic (server-side only).
 *
 * Handles the real E-Polis source (lib/epolis.mjs) and a bundled demo fallback so the UI
 * keeps a stable layout. Both paths are "never throws": every failure becomes a structured
 * report, never a crash.
 *
 * Credentials must stay on the server. Never call these sources from the browser.
 */

export const MAX_BODY_BYTES = 4096;
export const EPOLIS_TIMEOUT_MS = 4000;

/* ------------------------------ sample data ------------------------------ */

const REGISTRY = {
  prohibitions: {
    status: "TOZA",
    detail: "Taqiqlar va sud qarorlari topilmadi",
  },
  fines: {
    total: 680000,
    items: [
      { date: "14.09.2026", reason: "Tezlikni oshirish (modda 128-3)", amount: 340000 },
      { date: "02.08.2026", reason: "Toʻxtash qoidasini buzish (modda 135)", amount: 340000 },
    ],
  },
  pledge: {
    status: "Garovda emas",
    detail: "Notarial garov va cheklovlar mavjud emas",
  },
  insurance: {
    company: "“Universal Sugʻurta” AJ",
    policy: "AS 8472915",
    validUntil: "12.11.2026",
  },
};

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

function fallbackNotice(reason) {
  return reason === "timeout"
    ? "Sugʻurta bazasi muddatida javob bermadi — namuna maʼlumotlar koʻrsatildi."
    : "Sugʻurta bazasiga ulanib boʻlmadi — namuna maʼlumotlar koʻrsatildi.";
}

/* -------------------------------- report -------------------------------- */

/**
 * The E-Polis-driven check block set:
 *   - vehicle (avtomobil kartochka) is shown when E-Polis returned a car record,
 *     even when insurance itself is missing.
 *   - MIB / fines / pledge stay in the report so the UI keeps its layout, but they
 *     stay "tekshirilmagan" until those integrations are wired.
 *   - insurance uses the live E-Polis values; when E-Polis didn't return insurance,
 *     the report says so explicitly.
 */
function buildEpolisChecks(epolis) {
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

    const { model, year, vin, engineNumber } = epolis.vehicle;
    const headline = [model, year ? `${year} yil` : null]
      .filter(Boolean)
      .join(" · ") || "Modeli nomaʼlum";
    const ids = [
      vin ? `Kuzov (VIN): ${vin}` : null,
      engineNumber ? `Dvigatel: ${engineNumber}` : null,
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
    {
      id: "prohibitions",
      icon: "lock",
      title: "MIB / Sud taqiqlari",
      status: "Tekshirilmagan",
      tone: "info",
      detail: "MIB va sud boʻyicha integratsiya hozircha ulanmagan",
    },
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

/**
 * Bundled registry report (used as a demo fallback when E-Polis is silent).
 */
function buildRegistryChecks() {
  const fines = REGISTRY.fines;
  const insurance = insuranceStatus(REGISTRY.insurance.validUntil);

  return [
    {
      id: "prohibitions",
      icon: "shield",
      title: "MIB / Sud taqiqlari",
      status: REGISTRY.prohibitions.status,
      tone: "ok",
      detail: REGISTRY.prohibitions.detail,
    },
    {
      id: "fines",
      icon: "receipt",
      title: "YHXBB jarimalari",
      status: `${fines.items.length} ta jarima`,
      tone: "warn",
      amount: fines.total,
      items: fines.items,
    },
    {
      id: "pledge",
      icon: "lock",
      title: "Notarial garov (Zalog)",
      status: REGISTRY.pledge.status,
      tone: "ok",
      detail: REGISTRY.pledge.detail,
    },
    {
      id: "insurance",
      icon: "clock",
      title: "Sugʻurta (OSAGO)",
      status: insurance.status,
      tone: insurance.tone,
      detail: `Amal qilish muddati: ${REGISTRY.insurance.validUntil} gacha`,
      note: `Sugʻurta polisi: ${REGISTRY.insurance.policy} · ${REGISTRY.insurance.company}`,
      policy: REGISTRY.insurance.policy,
      company: REGISTRY.insurance.company,
      validUntil: REGISTRY.insurance.validUntil,
    },
  ];
}

function verdictFor(epolis) {
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
  const epolis = await fetchEpolisData(
    `${region} ${plate}`,
    techPassport?.series ?? "",
    techPassport?.number ?? "",
    env
  );

  const checks = epolis.ok && epolis.found ? buildEpolisChecks(epolis) : buildRegistryChecks();

  const verdict = verdictFor(epolis);
  const notice = noticeFor(epolis);

  const finesCheck = checks.find((check) => check.id === "fines");
  const fineCount = finesCheck?.items?.length ?? 0;

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
    vehicle: epolis.ok && epolis.vehicle ? epolis.vehicle : epolis.ok ? null : null,
    insurance: epolis.ok && epolis.insurance ? epolis.insurance : null,
    verdict,
    checks,
    // MIB / YHXBB / garov — E-Polis-integatsiyagacha boʻsh, ammo strukturalangan bloklar.
    fines: { count: 0, amount: 0, items: [] },
    mib: { status: "Tekshirilmagan", items: [] },
    pledge: { status: "Tekshirilmagan", items: [] },
    totals: {
      fines: fineCount,
      finesTotal: finesCheck?.amount ?? 0,
      warnings: (epolis.ok ? 0 : 1) + (fineCount > 0 ? 1 : 0),
    },
    source: {
      registry: epolis.ok && epolis.found ? "epolis" : "sample",
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
