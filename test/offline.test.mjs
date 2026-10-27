/**
 * AvtoInfo — oflayn testlar (`npm test`).
 *
 * Tarmoqqa chiqilmaydi: ERSP (E-Polis) va MIB oʻrniga lokal stub serverlar koʻtariladi,
 * shuning uchun testlar haqiqiy bazalarga bogʻliq emas va CI da barqaror ishlaydi.
 *
 * Qamrov: VIN dekoder, MIB adapteri (clean/banned/wanted/unavailable), E-Polis parseri,
 * parallel ishga tushirish, toʻliq hisobot tuzilishi, HTTP handler va "soxta maʼlumot
 * yoʻq" qoidasi.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import handler from "../api/check.js";
import { buildReport, cleanRegion, insuranceStatus, normalizePlate } from "../lib/check.mjs";
import { buildEpolisPayload, fetchEpolisData, normalizeEpolisPayload } from "../lib/epolis.mjs";
import { buildMibPayload, checkMibBan, normalizeMibResponse } from "../lib/mib.mjs";
import { decodeVin, formatVinSummary, isVinValid } from "../lib/vin.mjs";

/* ------------------------------- helpers ------------------------------- */

const BODY = {
  plateNumber: "01 A 777 AA",
  techPassportSeries: "AAF",
  techPassportNumber: "1234567",
};

const CAR = {
  data: {
    car: {
      modelCustomName: "Chevrolet Cobalt",
      issueYear: 2021,
      vin: "XWBJAPRRJM6123456",
      engineNumber: "B15D2-1234567",
    },
    insurance: {
      companyName: "Oʻzbekiston Sugʻurta AJ",
      policyNumber: "AB 9988776",
      startDate: "01.06.2026",
      endDate: "30.05.2027",
      status: "Amal qiladi",
    },
  },
};

/** Hech qachon oʻylab topilgan namunaviy qiymat hisobotga tushmasligi kerak. */
const FORBIDDEN = ["680000", "680 000", "340000", "Universal Sug", "AS 8472915", "2 ta jarima", "TOZA", "Garovda emas"];

function startStub(onRequest) {
  return new Promise((resolve) => {
    const server = createServer(onRequest);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      // Biror tasdiq yiqilsa `closeAll` chaqirilmay qoladi; unref boʻlmasa ochiq stub
      // test jarayonini osib qoʻyadi va CI da 3 daqiqalik kutishga aylanadi.
      server.unref();
      resolve({ server, port, url: `http://127.0.0.1:${port}/api` });
    });
  });
}

const jsonReply = (payload, { status = 200, delay = 0 } = {}) => (req, res) => {
  const send = () => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  };
  if (delay > 0) setTimeout(send, delay);
  else send();
};

const closeAll = (stubs) => Promise.all(stubs.map(({ server }) => new Promise((r) => server.close(r))));

const post = (payload = BODY) =>
  handler(
    new Request("http://localhost/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
  );

const reportWith = async (env, payload = BODY) => {
  const response = await postWith(payload, env);
  return (await response.json()).report;
};

const postWith = async (payload, env) => {
  const previous = { ...process.env };
  Object.assign(process.env, env ?? {});
  try {
    return await post(payload);
  } finally {
    for (const key of ["EPOLIS_API_URL", "EPOLIS_API_KEY", "EPOLIS_TIMEOUT_MS", "MIB_API_URL", "MIB_API_KEY", "MIB_TIMEOUT_MS"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
};

const cardOf = (report, id) => report.checks.find((check) => check.id === id);

const assertNoInventedData = (report) => {
  const text = JSON.stringify(report);
  const hits = FORBIDDEN.filter((value) => text.includes(value));
  assert.deepEqual(hits, [], `hisobotda soxta namunaviy qiymat qoldi: ${hits.join(", ")}`);
};

/* ------------------------------- VIN decoder ------------------------------- */

describe("lib/vin.mjs — oflayn VIN dekoder", () => {
  it("XWB VIN: UzAuto Motors, Oʻzbekiston, model yili 10-belgidan", () => {
    const decoded = decodeVin("XWBJAPRRJM6123456");

    assert.equal(decoded.valid, true);
    assert.equal(decoded.wmi, "XWB");
    assert.equal(decoded.manufacturer, "UzAuto Motors");
    assert.equal(decoded.country, "Oʻzbekiston");
    assert.equal(decoded.modelYear, 2021); // M → 2021 (2010+ sikli)
    assert.equal(decoded.plantCode, "6");
    // Zavod kodlari tasdiqlanmagan — taxmin qilinmaydi.
    assert.equal(decoded.assemblyPlant, null);
  });

  it("WMI jadvali: KL1 (Koreya), TMA (Chexiya), LC0 va LBV (Xitoy)", () => {
    assert.equal(decodeVin("KL1JAPRRJM6123456").manufacturer, "GM Korea (Chevrolet)");
    assert.equal(decodeVin("KL1JAPRRJM6123456").country, "Janubiy Koreya");
    assert.equal(decodeVin("TMAJAPRRJM6123456").country, "Chexiya");
    assert.equal(decodeVin("TMAJAPRRJM6123456").manufacturer, "Hyundai Motor Manufacturing Czech");
    assert.equal(decodeVin("LC0JAPRRJM6123456").country, "Xitoy");
    assert.equal(decodeVin("LBVJAPRRJM6123456").manufacturer, "BMW Brilliance");
  });

  it("WMI jadvalda boʻlmasa — faqat hudud boʻyicha mamlakat", () => {
    const decoded = decodeVin("ZZZJAPRRJM6123456");

    assert.equal(decoded.valid, true);
    assert.equal(decoded.manufacturer, null);
    assert.equal(decoded.country, "Italiya");
  });

  it("model yili sikli 7-belgiga qarab tanlanadi (raqam → 1980+, harf → 2010+)", () => {
    // 7-belgi raqam → eski sikl; M → 1991
    assert.equal(decodeVin("XWBJA69RJM6123456").modelYear, 1991);
    // 7-belgi harf → yangi sikl; M → 2021
    assert.equal(decodeVin("XWBJAPRRJM6123456").modelYear, 2021);
    // 10-belgi raqam: 6 → 2006 (eski sikl)
    assert.equal(decodeVin("XWBJA69RJ66123456").modelYear, 2006);
  });

  it("notoʻgʻri VIN uchun xatolik tashlamaydi, { valid:false } qaytaradi", () => {
    assert.equal(decodeVin("").valid, false);
    assert.equal(decodeVin(null).valid, false);
    assert.equal(decodeVin("XWB123").reason, "length");
    // "O" harfi VIN da boʻlmaydi
    assert.equal(decodeVin("XWBJAPRRJM612345O").reason, "charset");
    assert.equal(decodeVin("XWBJAPRRJM612345O").valid, false);
    assert.equal(isVinValid("XWBJAPRRJM6123456"), true);
    assert.equal(isVinValid("not-a-vin"), false);
  });

  it("formatVinSummary kartochka/PDF uchun qator beradi", () => {
    assert.equal(formatVinSummary(decodeVin("XWBJAPRRJM6123456")), "UzAuto Motors (Oʻzbekiston) · 2021 yil");
    assert.equal(formatVinSummary(decodeVin("bad")), null);
  });
});

/* -------------------------------- MIB adapter -------------------------------- */

describe("lib/mib.mjs — MIB taqiq/qidiruv adapteri", () => {
  it("payload davlat raqamini normallashtiradi", () => {
    assert.deepEqual(buildMibPayload("01 a 777 aa"), { govNumber: "01A777AA" });
    assert.deepEqual(buildMibPayload(""), { govNumber: "" });
  });

  it("JSON javobni tolerant oʻqiydi: ban, qidiruv, toza", () => {
    const banned = normalizeMibResponse({ data: { hasBan: true, details: ["Sud qarori 2026-14"] } });
    assert.equal(banned.status, "banned");
    assert.equal(banned.hasBan, true);
    assert.deepEqual(banned.details, ["Sud qarori 2026-14"]);

    const wanted = normalizeMibResponse({ result: { wanted: true } });
    assert.equal(wanted.status, "wanted");
    assert.equal(wanted.hasSearch, true);

    const clean = normalizeMibResponse({ data: { hasBan: false, hasSearch: false } });
    assert.equal(clean.status, "clean");
    assert.equal(clean.hasBan, false);

    // Boʻsh javob — xato emas, "taqiq yoʻq" ham emas: clean deb belgilanadi, lekin checked=true.
    const empty = normalizeMibResponse({ success: true, data: {} });
    assert.equal(empty.status, "clean");
  });

  it("MIB_API_URL berilmasa tarmoqqa chiqmaydi va unavailable qaytaradi", async () => {
    const started = Date.now();
    const result = await checkMibBan("01 A 777 AA", {});

    assert.deepEqual(
      { checked: result.checked, status: result.status, reason: result.reason },
      { checked: false, status: "unavailable", reason: "not_configured" }
    );
    assert.ok(Date.now() - started < 100, "not_configured holatida tarmoq kutilmaydi");
  });

  it("haqiqiy javob: toza, taqiqli, 500 va HTML holatlari", async () => {
    const clean = await startStub(jsonReply({ data: { hasBan: false, hasSearch: false } }));
    const cleanResult = await checkMibBan("01 A 777 AA", { MIB_API_URL: clean.url });
    assert.equal(cleanResult.checked, true);
    assert.equal(cleanResult.status, "clean");

    const banned = await startStub(jsonReply({ data: { hasBan: true } }));
    const bannedResult = await checkMibBan("01 A 777 AA", { MIB_API_URL: banned.url });
    assert.equal(bannedResult.status, "banned");

    const broken = await startStub(jsonReply({ error: "boom" }, { status: 500 }));
    const brokenResult = await checkMibBan("01 A 777 AA", { MIB_API_URL: broken.url });
    assert.equal(brokenResult.checked, false);
    assert.equal(brokenResult.status, "unavailable");
    assert.equal(brokenResult.reason, "http_500");

    const html = await startStub((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html><body>Taqiq: yoʻq</body></html>");
    });
    const htmlResult = await checkMibBan("01 A 777 AA", { MIB_API_URL: html.url });
    assert.equal(htmlResult.status, "unavailable");
    assert.equal(htmlResult.reason, "html_response");

    await closeAll([clean, banned, broken, html]);
  });

  it("osilib qolgan xizmat timeout bilan toʻxtatiladi", async () => {
    const slow = await startStub(() => {
      /* javob yoʻq — ataylab osilgan */
    });
    const started = Date.now();
    const result = await checkMibBan("01 A 777 AA", {
      MIB_API_URL: slow.url,
      MIB_TIMEOUT_MS: "200",
    });

    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "timeout");
    assert.ok(Date.now() - started < 2000, "timeout belgilangan vaqtda toʻxtatilishi kerak");

    await closeAll([slow]);
  });
});

/* --------------------------------- E-Polis --------------------------------- */

describe("lib/epolis.mjs — parser va adapter", () => {
  it("payload va tolerant parser", () => {
    assert.deepEqual(buildEpolisPayload("01 A 777 AA", " aaf ", " 1234567 "), {
      govNumber: "01A777AA",
      techPassportSeria: "AAF",
      techPassportNumber: "1234567",
    });

    const parsed = normalizeEpolisPayload(CAR);
    assert.equal(parsed.found, true);
    assert.equal(parsed.vehicle.model, "Chevrolet Cobalt");
    assert.equal(parsed.vehicle.year, "2021");
    assert.equal(parsed.vehicle.vin, "XWBJAPRRJM6123456");
    assert.equal(parsed.insurance.company, "Oʻzbekiston Sugʻurta AJ");
    assert.equal(parsed.insurance.policy, "AB 9988776");

    assert.deepEqual(normalizeEpolisPayload(null), { found: false, vehicle: null, insurance: null });
  });

  it("CSRF rad etilsa sahifadagi token bilan qayta urinadi", async () => {
    let sawToken = false;
    const stub = await startStub(async (req, res) => {
      if (req.method === "GET") {
        res.setHeader("content-type", "text/html");
        res.end('<html><head><meta name="csrf-token" content="tok-42"></head></html>');
        return;
      }

      for await (const _chunk of req) {
        /* body oʻqildi */
      }

      if (!req.headers["x-csrf-token"]) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: false }));
        return;
      }

      sawToken = true;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(CAR));
    });

    const result = await fetchEpolisData("01 A 777 AA", "AAF", "1234567", { EPOLIS_API_URL: stub.url });
    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.equal(sawToken, true);

    await closeAll([stub]);
  });
});

/* ------------------------------ hisobot tuzilishi ------------------------------ */

describe("lib/check.mjs — hisobot (E-Polis + MIB parallel)", () => {
  it("toza javob: yashil MIB, real avtomobil, VIN zavod qatori, soxta raqam yoʻq", async () => {
    const epolis = await startStub(jsonReply(CAR));
    const mib = await startStub(jsonReply({ data: { hasBan: false } }));

    const report = await reportWith({ EPOLIS_API_URL: epolis.url, MIB_API_URL: mib.url });

    assert.equal(report.verdict.tone, "ok");
    assert.equal(cardOf(report, "prohibitions").status, "Taqiq yoʻq");
    assert.equal(cardOf(report, "prohibitions").tone, "ok");
    assert.equal(cardOf(report, "vehicle").status, "Topildi");
    assert.match(cardOf(report, "vehicle").detail, /Chevrolet Cobalt · 2021 yil/);
    assert.match(cardOf(report, "vehicle").note, /Zavod: UzAuto Motors \(Oʻzbekiston\) · 2021 yil/);
    assert.equal(report.vin.valid, true);
    assert.equal(report.vin.wmi, "XWB");
    assert.equal(report.mib.status, "clean");
    assert.equal(report.totals.bans, 0);
    assertNoInventedData(report);

    await closeAll([epolis, mib]);
  });

  it("MIB taqiqi: qizil kartochka va qizil verdict", async () => {
    const epolis = await startStub(jsonReply(CAR));
    const mib = await startStub(jsonReply({ data: { hasBan: true, details: ["Sud ijro hujjati №14"] } }));

    const report = await reportWith({ EPOLIS_API_URL: epolis.url, MIB_API_URL: mib.url });

    assert.equal(cardOf(report, "prohibitions").status, "Taqiq bor");
    assert.equal(cardOf(report, "prohibitions").tone, "danger");
    assert.match(cardOf(report, "prohibitions").note, /№14/);
    assert.equal(report.verdict.tone, "danger");
    assert.equal(report.mib.status, "banned");
    assert.equal(report.totals.bans, 1);
    assertNoInventedData(report);

    await closeAll([epolis, mib]);
  });

  it("MIB ishlamasa: kulrang «Tekshirilmadi» va ochiq ogohlantirish", async () => {
    const epolis = await startStub(jsonReply(CAR));

    const report = await reportWith({ EPOLIS_API_URL: epolis.url, MIB_API_URL: "" });

    assert.equal(cardOf(report, "prohibitions").status, "Tekshirilmadi");
    assert.equal(cardOf(report, "prohibitions").tone, "muted");
    assert.equal(report.mib.checked, false);
    assert.match(report.notice, /MIB .*tekshirilmadi/);
    assertNoInventedData(report);

    await closeAll([epolis]);
  });

  it("E-Polis topmasa: VIN yoʻq, holatlar halol qoladi", async () => {
    const epolis = await startStub(jsonReply({ data: null }));
    const mib = await startStub(jsonReply({ data: { hasBan: false } }));

    const report = await reportWith({ EPOLIS_API_URL: epolis.url, MIB_API_URL: mib.url });

    assert.equal(report.vin, null);
    assert.equal(cardOf(report, "vehicle").status, "Topilmadi");
    assert.equal(cardOf(report, "insurance").status, "Polis topilmadi");
    assert.equal(cardOf(report, "prohibitions").status, "Taqiq yoʻq");
    assertNoInventedData(report);

    await closeAll([epolis, mib]);
  });

  it("ikkala manba parallel ishlaydi (ketma-ket emas)", async () => {
    const epolis = await startStub(jsonReply(CAR, { delay: 300 }));
    const mib = await startStub(jsonReply({ data: { hasBan: false } }, { delay: 300 }));

    const started = Date.now();
    await reportWith({ EPOLIS_API_URL: epolis.url, MIB_API_URL: mib.url });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 560, `parallel ishlashi kerak, ketma-ket boʻlsa ~600ms boʻlardi (${elapsed}ms)`);

    await closeAll([epolis, mib]);
  });
});

/* -------------------------------- HTTP handler -------------------------------- */

describe("api/check.js — HTTP qatlami", () => {
  it("POST haqiqiy soʻrov → 200, no-store, hisobot", async () => {
    const epolis = await startStub(jsonReply(CAR));
    const mib = await startStub(jsonReply({ data: { hasSearch: true } }));

    const response = await postWith(BODY, { EPOLIS_API_URL: epolis.url, MIB_API_URL: mib.url });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(payload.ok, true);
    assert.equal(payload.report.plate.full, "01 · A 777 AA");
    assert.equal(payload.report.checks.length, 5);
    assert.equal(payload.report.mib.status, "wanted");

    await closeAll([epolis, mib]);
  });

  it("GET → 405, notoʻgʻri tanasi → 400, katta tanasi → 413", async () => {
    const getResponse = await handler(new Request("http://localhost/api/check"));
    assert.equal(getResponse.status, 405);

    const badBody = await handler(
      new Request("http://localhost/api/check", { method: "POST", body: "not json" })
    );
    assert.equal(badBody.status, 400);

    const tooBig = await handler(
      new Request("http://localhost/api/check", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "999999" },
        body: "{}",
      })
    );
    assert.equal(tooBig.status, 413);
  });

  it("validatsiya: viloyat, davlat raqami va texpasport", async () => {
    const cases = [
      [{ plate: "AA 777 AA", region: "x" }, "invalid_region"],
      [{ region: "01", plate: "77" }, "invalid_plate"],
      [{ plateNumber: "01 A 777 AA", techPassportSeries: "AF", techPassportNumber: "123" }, "invalid_tech_passport"],
    ];

    for (const [payload, code] of cases) {
      const response = await post(payload);
      const body = await response.json();
      assert.equal(response.status, 400, `${code} uchun 400 kutilgan`);
      assert.equal(body.error.code, code);
    }
  });
});

/* ------------------------------- yordamchilar ------------------------------- */

describe("lib/check.mjs — yordamchi funksiyalar", () => {
  it("cleanRegion / normalizePlate / insuranceStatus", () => {
    assert.equal(cleanRegion("0a1b2"), "01");
    assert.equal(normalizePlate("a777aa"), "A 777 AA");
    assert.equal(normalizePlate("nope"), "");

    const active = insuranceStatus("31.12.2099");
    assert.equal(active.status, "Amal qiladi");
    assert.equal(active.tone, "info");

    const expired = insuranceStatus("01.01.2000");
    assert.equal(expired.status, "Muddati oʻtgan");
    assert.equal(expired.tone, "warn");

    assert.equal(insuranceStatus("").status, "Muddati nomaʼlum");
  });
});
