/**
 * AvtoInfo — Telegram Mini App
 * Screen state machine: input → loading (server check) → results
 */

import { initTelegram, setBackButton, haptics } from "./telegram.js";
import {
  cleanNumber,
  cleanRegion,
  cleanSeries,
  formatPlateNumber,
  isPlateNumberValid,
  isRegionValid,
} from "./plate.js";
import { formatMoney, formatShortTime, requestReport } from "./report.js";
import { downloadReportPdf } from "./pdf.js";

const $ = (id) => document.getElementById(id);

const el = {
  screens: {
    input: $("screen-input"),
    loading: $("screen-loading"),
    results: $("screen-results"),
  },
  form: $("check-form"),
  region: $("region"),
  plate: $("plateNumber"),
  plateBox: $("plate"),
  plateError: $("plate-error"),
  tpSeries: $("tpSeries"),
  tpNumber: $("tpNumber"),
  tpError: $("tp-error"),
  steps: Array.from(document.querySelectorAll(".step")),
  progress: $("progress-bar"),
  loadingPlate: $("loading-plate"),
  resultRegion: $("result-region"),
  resultPlate: $("result-plate"),
  resultTp: $("result-tp-text"),
  resultTime: $("result-time"),
  verdict: $("verdict"),
  verdictText: $("verdict-text"),
  verdictCount: $("verdict-count"),
  notice: $("data-notice"),
  noticeText: $("data-notice-text"),
  sourceLine: $("results-source"),
  results: $("results"),
  pdfBtn: $("pdf-btn"),
  resetBtn: $("reset-btn"),
  cancelBtn: $("cancel-btn"),
  toast: $("toast"),
  toastText: $("toast-text"),
};

const state = {
  screen: "input",
  report: null,
  runId: 0,
};

const LOAD_STEPS = [
  { ms: 1150, progress: 38 },
  { ms: 1400, progress: 76 },
  { ms: 1000, progress: 95 },
];

const ICONS = {
  shield:
    '<path d="M12 3l7 3v6c0 4.3-2.9 7.7-7 9-4.1-1.3-7-4.7-7-9V6l7-3Z" /><path d="m9 12 2 2 4-4" />',
  receipt:
    '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5v3a2.5 2.5 0 0 0 0 5v3A2.5 2.5 0 0 1 17.5 22h-11A2.5 2.5 0 0 1 4 19.5v-3a2.5 2.5 0 0 0 0-5v-3Z" /><path d="M12 2v20" stroke-dasharray="2 3" />',
  lock:
    '<rect x="4.5" y="10" width="15" height="10.5" rx="2.5" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /><path d="M12 14v2.5" />',
  clock:
    '<path d="M12 3l7.5 3.2v5.6c0 4.6-3.1 8.2-7.5 9.4-4.4-1.2-7.5-4.8-7.5-9.4V6.2L12 3Z" /><path d="M12 8v4l2.5 1.5" />',
};

/* ------------------------------- screens -------------------------------- */

function showScreen(name) {
  state.screen = name;

  Object.entries(el.screens).forEach(([key, node]) => {
    node.classList.toggle("is-active", key === name);
  });

  window.scrollTo(0, 0);
  setBackButton(name !== "input", goBack);
}

function goBack() {
  if (state.screen === "loading") {
    cancelCheck();
    return;
  }
  if (state.screen === "results") {
    startNewCheck();
  }
}

/* -------------------------------- errors -------------------------------- */

function setPlateError(message) {
  if (!message) {
    el.plateError.hidden = true;
    el.plateError.textContent = "";
    return;
  }
  el.plateError.textContent = message;
  el.plateError.hidden = false;
  el.plateBox.classList.remove("is-invalid");
  void el.plateBox.offsetWidth; // restart the shake animation
  el.plateBox.classList.add("is-invalid");
}

function setTpError(message) {
  el.tpError.textContent = message || "";
  el.tpError.hidden = !message;
}

/* ------------------------------- inputs --------------------------------- */

el.region.addEventListener("input", () => {
  el.region.value = cleanRegion(el.region.value);
  setPlateError("");
  if (el.region.value.length === 2) el.plate.focus({ preventScroll: true });
});

el.region.addEventListener("blur", () => {
  el.region.value = cleanRegion(el.region.value);
});

el.plate.addEventListener("input", () => {
  const atEnd = el.plate.selectionStart === el.plate.value.length;
  const formatted = formatPlateNumber(el.plate.value);

  if (formatted !== el.plate.value) {
    el.plate.value = formatted;
    if (atEnd) el.plate.setSelectionRange(formatted.length, formatted.length);
  }

  setPlateError("");
  if (formatted.length >= 9) el.tpSeries.focus({ preventScroll: true });
});

el.plate.addEventListener("blur", () => {
  el.plate.value = formatPlateNumber(el.plate.value);
});

el.tpSeries.addEventListener("input", () => {
  el.tpSeries.value = cleanSeries(el.tpSeries.value);
  setTpError("");
  if (el.tpSeries.value.length === 3) el.tpNumber.focus({ preventScroll: true });
});

el.tpNumber.addEventListener("input", () => {
  el.tpNumber.value = cleanNumber(el.tpNumber.value);
  setTpError("");
});

/* ------------------------------ submission ------------------------------ */

el.form.addEventListener("submit", (event) => {
  event.preventDefault();

  const region = cleanRegion(el.region.value);
  const plate = formatPlateNumber(el.plate.value);

  if (!isRegionValid(region) || !isPlateNumberValid(plate)) {
    el.region.value = region;
    el.plate.value = plate;
    setPlateError("Raqamni toʻliq kiriting — masalan: 01 · A 777 AA");
    haptics.error();
    (region.length === 2 ? el.plate : el.region).focus({ preventScroll: true });
    return;
  }

  const tpSeries = cleanSeries(el.tpSeries.value);
  const tpNumber = cleanNumber(el.tpNumber.value);

  if ((tpSeries || tpNumber) && (tpSeries.length !== 3 || tpNumber.length !== 7)) {
    setTpError("Texnik pasport: seriya 3 harf (AAF), raqam 7 raqam (1234567)");
    haptics.error();
    return;
  }

  setPlateError("");
  setTpError("");
  haptics.tap();

  void startCheck({ region, plate, tpSeries, tpNumber });
});

async function startCheck(payload) {
  const runId = (state.runId += 1);
  state.report = null;

  el.steps.forEach((step) => step.classList.remove("is-active", "is-done"));
  setProgress(6);
  el.loadingPlate.textContent = `${payload.region} · ${payload.plate}`;
  el.results.replaceChildren();
  showScreen("loading");

  // The real check runs on the server while the progress steps play out.
  const pending = requestReport(payload);
  pending.catch(() => {}); // handled below; avoids an unhandled rejection on cancel

  for (let index = 0; index < LOAD_STEPS.length; index += 1) {
    const step = LOAD_STEPS[index];
    const node = el.steps[index];

    node.classList.add("is-active");
    setProgress(step.progress);

    const alive = await sleep(step.ms, runId);
    if (!alive) return;

    node.classList.remove("is-active");
    node.classList.add("is-done");
  }

  let report;
  try {
    report = await pending;
  } catch (error) {
    if (state.runId !== runId) return;
    setProgress(0);
    el.steps.forEach((step) => step.classList.remove("is-active", "is-done"));
    showScreen("input");
    haptics.error();

    const message = error?.message || "Tekshiruvni bajarish imkonsiz boʻldi.";
    if (error?.code === "invalid_tech_passport") {
      setTpError(message);
    } else if (error?.code === "invalid_plate" || error?.code === "invalid_region") {
      setPlateError(message);
    } else {
      toast(message);
    }
    return;
  }

  if (state.runId !== runId) return;

  setProgress(100);
  state.report = report;
  renderResults(report);
  showScreen("results");
  if (report.notice) haptics.error();
  else haptics.success();
}

function cancelCheck() {
  state.runId += 1;
  el.steps.forEach((step) => step.classList.remove("is-active", "is-done"));
  setProgress(0);
  showScreen("input");
  haptics.tap();
}

function startNewCheck() {
  state.runId += 1;
  state.report = null;

  el.region.value = "";
  el.plate.value = "";
  el.tpSeries.value = "";
  el.tpNumber.value = "";

  setPlateError("");
  setTpError("");
  setProgress(0);
  el.steps.forEach((step) => step.classList.remove("is-active", "is-done"));
  el.results.replaceChildren();

  showScreen("input");
  haptics.tap();
}

/* ------------------------------- rendering ------------------------------ */

function createCard(check, index) {
  const card = document.createElement("article");
  card.className = "rcard";
  card.dataset.tone = check.tone;
  card.style.setProperty("--i", String(index));

  const icon = document.createElement("div");
  icon.className = "rcard__icon";
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    ICONS[check.icon] ?? ICONS.shield
  }</svg>`;

  const body = document.createElement("div");
  body.className = "rcard__body";

  const top = document.createElement("div");
  top.className = "rcard__top";

  const title = document.createElement("h3");
  title.className = "rcard__title";
  title.textContent = check.title;

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = check.status;

  top.append(title, badge);
  body.append(top);

  if (typeof check.amount === "number") {
    const amount = document.createElement("p");
    amount.className = "rcard__amount";
    amount.append(document.createTextNode(`${formatMoney(check.amount)} `));

    const unit = document.createElement("small");
    unit.textContent = "soʻm";
    amount.append(unit);
    body.append(amount);
  }

  if (check.detail) {
    const detail = document.createElement("p");
    detail.className = check.note ? "rcard__sub rcard__sub--strong" : "rcard__sub";
    detail.textContent = check.detail;
    body.append(detail);
  }

  if (check.note) {
    const note = document.createElement("p");
    note.className = "rcard__sub rcard__sub--muted";
    note.textContent = check.note;
    body.append(note);
  }

  if (Array.isArray(check.items) && check.items.length > 0) {
    const list = document.createElement("ul");
    list.className = "fines";

    check.items.forEach((item) => {
      const row = document.createElement("li");

      const date = document.createElement("span");
      date.className = "fines__date";
      date.textContent = item.date;

      const reason = document.createElement("span");
      reason.className = "fines__desc";
      reason.textContent = item.reason;

      const sum = document.createElement("span");
      sum.className = "fines__sum";
      sum.textContent = formatMoney(item.amount);

      row.append(date, reason, sum);
      list.append(row);
    });

    body.append(list);
  }

  card.append(icon, body);
  return card;
}

function renderResults(report) {
  el.resultRegion.textContent = report.plate.region;
  el.resultPlate.textContent = report.plate.number;
  el.resultTp.textContent = report.techPassportLabel;
  el.resultTime.textContent = formatShortTime(report.checkedAt);

  el.verdictText.textContent = report.verdict.label;
  el.verdictCount.textContent = String(report.verdict.count);
  el.verdict.classList.toggle("verdict--ok", report.verdict.tone === "ok");

  renderSource(report);
  el.results.replaceChildren(...report.checks.map(createCard));
}

/**
 * Honest sourcing: the banner only appears when the real insurance source failed and the
 * report fell back to sample data; the caption under the buttons always says where each
 * block came from.
 */
function renderSource(report) {
  const notice = typeof report.notice === "string" ? report.notice.trim() : "";
  el.notice.hidden = notice.length === 0;
  el.noticeText.textContent = notice;

  const insuranceLive = report.source?.insurance === "live";
  el.sourceLine.textContent = insuranceLive
    ? "Avtomobil va sugʻurta: E-Polis (ersp.e-osgo.uz) · MIB, YHXBB va garov — integratsiya ulanmagan"
    : "E-Polis maʼlumoti olinmadi · MIB, YHXBB va garov boʻlimlari boʻsh holda";
}

/* ------------------------------- helpers -------------------------------- */

function setProgress(value) {
  el.progress.style.width = `${value}%`;
}

function sleep(ms, runId) {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(state.runId === runId), ms);
  });
}

let toastTimer = null;

function toast(message) {
  el.toastText.textContent = message;
  el.toast.hidden = false;

  requestAnimationFrame(() => el.toast.classList.add("is-visible"));

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toast.classList.remove("is-visible");
    window.setTimeout(() => {
      if (!el.toast.classList.contains("is-visible")) el.toast.hidden = true;
    }, 320);
  }, 3200);
}

/* ------------------------------- actions -------------------------------- */

el.cancelBtn.addEventListener("click", cancelCheck);
el.resetBtn.addEventListener("click", startNewCheck);

el.pdfBtn.addEventListener("click", () => {
  if (!state.report) return;
  haptics.tap();

  try {
    const fileName = downloadReportPdf(state.report);
    haptics.success();
    toast(`${fileName} yuklab olindi`);
  } catch (error) {
    console.error("[AvtoInfo] PDF generation failed", error);
    haptics.error();
    toast("PDF yaratishda xatolik yuz berdi");
  }
});

/* --------------------------------- boot --------------------------------- */

initTelegram();
showScreen("input");
