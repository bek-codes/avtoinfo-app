/**
 * Minimal PDF generator (no dependencies).
 * Produces a single A4 page report using the standard Helvetica fonts,
 * which keeps the Mini App payload tiny and works inside Telegram's WebView.
 */

import { formatDateTime, formatMoney } from "./report.js";

const PAGE = { width: 595, height: 842 };
const MARGIN = 40;
const RIGHT = PAGE.width - MARGIN;

const COLORS = {
  navy: "#0B1220",
  ink: "#111C2E",
  gray: "#64748B",
  light: "#94A3B8",
  border: "#E2E8F0",
  bg: "#F6F8FC",
  white: "#FFFFFF",
  brand: "#4F8DFF",
  ok: "#047857",
  okTint: "#ECFDF5",
  warn: "#B45309",
  warnTint: "#FFF7E6",
  info: "#1D4ED8",
  infoTint: "#EFF6FF",
  danger: "#B91C1C",
  dangerTint: "#FEF2F2",
  muted: "#475569",
  mutedTint: "#F1F5F9",
};

/* ----------------------------- text helpers ----------------------------- */

function ascii(value) {
  return String(value)
    .replace(/[ʻʼʽ‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[→]/g, ">")
    .replace(/[«»]/g, '"')
    .replace(/[^\x20-\x7E]/g, " ");
}

function esc(value) {
  return ascii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

const NARROW = {
  " ": 0.278,
  ".": 0.278,
  ",": 0.278,
  ":": 0.278,
  "/": 0.278,
  "'": 0.191,
  "-": 0.333,
  '"': 0.355,
  "(": 0.333,
  ")": 0.333,
  "|": 0.26,
  "·": 0.28,
};

/** Rough Helvetica width measurement — accurate enough for right alignment. */
function measure(text, size, bold = false) {
  let width = 0;
  for (const ch of ascii(text)) {
    if (/\d/.test(ch)) width += 0.556;
    else if (NARROW[ch] !== undefined) width += NARROW[ch];
    else if (/[A-Z]/.test(ch)) width += bold ? 0.71 : 0.66;
    else if (/[a-z]/.test(ch)) width += bold ? 0.585 : 0.53;
    else width += 0.62;
  }
  return width * size;
}

function rgb(hex) {
  const clean = hex.replace("#", "");
  const value = parseInt(
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean,
    16
  );
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
}

/* ------------------------------ canvas API ------------------------------ */

function createCanvas() {
  const ops = [];

  // y is measured from the top of the page.
  const baseline = (y) => PAGE.height - y;

  const api = {
    ops,

    rect(x, y, w, h, { fill, stroke, lineWidth = 1 } = {}) {
      if (fill) ops.push(`${rgb(fill)} rg ${x} ${baseline(y + h)} ${w} ${h} re f`);
      if (stroke) {
        ops.push(
          `${rgb(stroke)} RG ${lineWidth} w ${x} ${baseline(y + h)} ${w} ${h} re S`
        );
      }
      return api;
    },

    line(x1, y1, x2, y2, { color = COLORS.border, lineWidth = 1 } = {}) {
      ops.push(
        `${rgb(color)} RG ${lineWidth} w ${x1} ${baseline(y1)} m ${x2} ${baseline(
          y2
        )} l S`
      );
      return api;
    },

    text(value, x, y, { size = 10, bold = false, color = COLORS.ink, align = "left" } = {}) {
      const str = String(value);
      const drawX = align === "right" ? x - measure(str, size, bold) : x;
      ops.push(
        `BT /${bold ? "F2" : "F1"} ${size} Tf ${rgb(color)} rg 1 0 0 1 ${drawX.toFixed(
          2
        )} ${baseline(y).toFixed(2)} Tm (${esc(str)}) Tj ET`
      );
      return api;
    },

    /** Small filled chip with centred label. Returns its width. */
    chip(label, xRight, y, { size = 8, fg = COLORS.ink, bg = "#F1F5F9" } = {}) {
      const text = ascii(label).toUpperCase();
      const width = measure(text, size, true) + 18;
      const x = xRight - width;
      api.rect(x, y, width, 21, { fill: bg });
      api.text(text, x + 9, y + 14.5, { size, bold: true, color: fg });
      return width;
    },
  };

  return api;
}

/* -------------------------------- report -------------------------------- */

function drawHeader(c, report) {
  c.rect(0, 0, PAGE.width, 118, { fill: COLORS.navy });
  c.rect(0, 118, PAGE.width, 3, { fill: COLORS.brand });

  c.rect(MARGIN, 30, 32, 32, { fill: COLORS.brand });
  c.text("A", MARGIN + 10.5, 52, { size: 17, bold: true, color: COLORS.white });

  c.text("AvtoInfo", MARGIN + 44, 50, {
    size: 21,
    bold: true,
    color: COLORS.white,
  });
  c.text("Avtomobil tarixi hisoboti", MARGIN + 44, 66, {
    size: 9.5,
    color: "#9FB3D1",
  });

  c.text("HISOBOT", RIGHT, 44, {
    size: 8.5,
    bold: true,
    color: "#7C93B5",
    align: "right",
  });
  c.text(formatDateTime(report.checkedAt), RIGHT, 62, {
    size: 11,
    bold: true,
    color: COLORS.white,
    align: "right",
  });
  c.text(`ID: AI-${report.plate.compact}-${String(report.checkedAt.getTime()).slice(-5)}`, RIGHT, 76, {
    size: 8,
    color: "#7C93B5",
    align: "right",
  });
}

function drawPlate(c, report) {
  c.text("DAVLAT RAQAMI", MARGIN, 148, { size: 8, bold: true, color: COLORS.gray });

  c.rect(MARGIN, 158, 330, 70, { fill: COLORS.white, stroke: "#D8E1EE", lineWidth: 1 });
  c.rect(MARGIN, 158, 40, 70, { fill: "#0B62C4" });
  c.text("UZ", MARGIN + 13, 197, { size: 10, bold: true, color: COLORS.white });

  c.text(report.plate.region, MARGIN + 58, 201, {
    size: 24,
    bold: true,
    color: COLORS.navy,
    align: "right",
  });

  c.line(MARGIN + 112, 172, MARGIN + 112, 214, { color: COLORS.navy, lineWidth: 1.6 });

  c.text(report.plate.number, MARGIN + 128, 201, {
    size: 24,
    bold: true,
    color: COLORS.navy,
  });

  const x = RIGHT - 175;
  c.rect(x, 158, 175, 70, { fill: "#F3F6FB", stroke: COLORS.border });
  c.text("Tekshiruv vaqti", x + 12, 178, { size: 8, color: COLORS.gray });
  c.text(
    `${String(report.checkedAt.getDate()).padStart(2, "0")}.${String(
      report.checkedAt.getMonth() + 1
    ).padStart(2, "0")}.${report.checkedAt.getFullYear()}`,
    x + 12,
    196,
    { size: 12, bold: true, color: COLORS.navy }
  );
  c.text(
    `${String(report.checkedAt.getHours()).padStart(2, "0")}:${String(
      report.checkedAt.getMinutes()
    ).padStart(2, "0")}`,
    x + 12,
    211,
    { size: 9, color: COLORS.gray }
  );

  c.text(
    report.techPassport
      ? `Texnik pasport: ${report.techPassport.series} ${report.techPassport.number}`
      : "Texnik pasport: ko'rsatilmagan",
    MARGIN,
    246,
    { size: 10, color: "#475569" }
  );
}

function drawSectionTitle(c, label, y) {
  c.text(label, MARGIN, y, { size: 8.5, bold: true, color: COLORS.gray });
  c.line(MARGIN + measure(label, 8.5, true) + 10, y - 3, RIGHT, y - 3, {
    color: COLORS.border,
  });
}

/** PDF bir qatorli: kartochka chetidan chiqib ketmasligi uchun matn qisqartiriladi. */
function fit(text, maxWidth, size, bold = false) {
  const raw = ascii(text);
  if (measure(raw, size, bold) <= maxWidth) return raw;

  let out = "";
  for (const ch of raw) {
    if (measure(`${out}${ch}...`, size, bold) > maxWidth) break;
    out += ch;
  }
  return `${out.trimEnd()}...`;
}

const ROW = 60;
const ROW_GAP = 8;
const ROW_TEXT_WIDTH = RIGHT - MARGIN - 34;

function drawRow(c, y, { title, detail, note, status, tone }) {
  const palettes = {
    ok: { fg: COLORS.ok, bg: COLORS.okTint, bar: "#10B981" },
    warn: { fg: COLORS.warn, bg: COLORS.warnTint, bar: "#F59E0B" },
    info: { fg: COLORS.info, bg: COLORS.infoTint, bar: "#3B82F6" },
    danger: { fg: COLORS.danger, bg: COLORS.dangerTint, bar: "#DC2626" },
    muted: { fg: COLORS.muted, bg: COLORS.mutedTint, bar: "#94A3B8" },
  };

  // Nomaʼlum ton PDF generatsiyasini yiqitmasligi kerak — neytral rangga tushadi.
  const palette = palettes[tone] ?? palettes.info;

  c.rect(MARGIN, y, RIGHT - MARGIN, ROW, { fill: COLORS.white, stroke: COLORS.border });
  c.rect(MARGIN, y, 3.5, ROW, { fill: palette.bar });

  c.text(fit(title, ROW_TEXT_WIDTH, 12, true), MARGIN + 18, y + 24, {
    size: 12,
    bold: true,
    color: COLORS.navy,
  });
  c.text(fit(detail, ROW_TEXT_WIDTH, 9), MARGIN + 18, y + 41, {
    size: 9,
    color: COLORS.gray,
  });
  if (note) {
    c.text(fit(note, ROW_TEXT_WIDTH, 7.5), MARGIN + 18, y + 52, {
      size: 7.5,
      color: COLORS.light,
    });
  }
  c.chip(status, RIGHT - 14, y + 19.5, { size: 8, fg: palette.fg, bg: palette.bg });
}

function drawFindings(c, report) {
  drawSectionTitle(c, "TEKSHIRUV NATIJALARI", 284);

  let y = 296;

  report.checks.forEach((check, index) => {
    if (index > 0) y += ROW + ROW_GAP;

    const detail =
      check.detail ??
      (typeof check.amount === "number"
        ? `${check.status} — ${formatMoney(check.amount)} so'm`
        : check.status);

    drawRow(c, y, {
      title: check.title,
      detail,
      // Izoh alohida qatorda: VIN, dvigatel va zavod maʼlumotlari sigʻadi.
      note: check.note ?? null,
      status: check.amount > 0 ? "TO'LANMAGAN" : check.status,
      tone: check.tone,
    });
  });

  return y + ROW;
}

function drawFines(c, report, y) {
  const fines = report.checks.find((check) => check.id === "fines");
  if (!fines || !Array.isArray(fines.items) || fines.items.length === 0) return y;

  c.text("Jarimalar tafsiloti", MARGIN, y + 32, {
    size: 10.5,
    bold: true,
    color: COLORS.navy,
  });

  let rowY = y + 48;
  c.line(MARGIN, rowY, RIGHT, rowY, { color: COLORS.border });

  fines.items.forEach((item) => {
    rowY += 20;
    c.text(item.date, MARGIN, rowY, { size: 9.5, color: COLORS.gray });
    c.text(item.reason, MARGIN + 78, rowY, { size: 9.5, color: COLORS.ink });
    c.text(`${formatMoney(item.amount)} so'm`, RIGHT, rowY, {
      size: 9.5,
      bold: true,
      color: COLORS.warn,
      align: "right",
    });
    rowY += 8;
    c.line(MARGIN, rowY, RIGHT, rowY, { color: "#EEF2F7" });
  });

  rowY += 16;
  c.text("Jami", MARGIN, rowY, { size: 9.5, bold: true, color: COLORS.navy });
  c.text(`${formatMoney(fines.amount)} so'm`, RIGHT, rowY, {
    size: 10.5,
    bold: true,
    color: COLORS.navy,
    align: "right",
  });

  return rowY + 12;
}

/** MIB bo'limi PDF'da faqat haqiqiy javobga tayanadi (tekshirilmagan / taqiq / qidiruv / toza). */
function mibLine(report) {
  const mib = report?.mib;
  if (!mib?.checked) return "MIB: tekshirilmadi";
  if (mib.hasBan) return "MIB: taqiq bor";
  if (mib.hasSearch) return "MIB: qidiruvda";
  return "MIB: taqiq yo'q";
}

function drawDisclaimer(c, y, report) {
  const insuranceLive = report?.source?.insurance === "live";
  const notice = typeof report?.notice === "string" ? report.notice.trim() : "";

  const sourceLine = notice
    ? notice
    : insuranceLive
      ? "Manba: E-Polis (ersp.e-osgo.uz) — avtomobil va sug'urta bo'limlari."
      : "Manba: E-Polis'dan ma'lumot olinmadi — bo'limlar tekshirilmagan holda ko'rsatilgan.";

  c.rect(MARGIN, y + 14, RIGHT - MARGIN, 72, { fill: "#FFFBEB", stroke: "#FDE68A" });
  c.text("DIQQAT", MARGIN + 14, y + 34, { size: 8, bold: true, color: COLORS.warn });
  c.text(
    insuranceLive
      ? "Ushbu hisobotdagi avtomobil va sug'urta ma'lumotlari E-Polis reestridan olindi."
      : "Ushbu hisobotda avtomobil va sug'urta ma'lumotlari E-Polis reestridan olinmadi — hisobotdagi bo'limlar tekshirilmagan.",
    MARGIN + 14,
    y + 50,
    { size: 8.5, color: "#7C5A16" }
  );
  c.text(
    `${mibLine(report)}. YHXBB jarimalari va notarial garov bo'limlari hozircha ulanmagan — «Tekshirilmagan» deb ko'rsatilgan.`,
    MARGIN + 14,
    y + 63,
    { size: 7.5, color: "#7C5A16" }
  );
  c.text(sourceLine, MARGIN + 14, y + 76, { size: 8.5, color: "#7C5A16" });
}

function drawFooter(c, report) {
  c.line(MARGIN, 782, RIGHT, 782, { color: COLORS.border });
  c.text("AvtoInfo · Telegram Mini App", MARGIN, 798, { size: 8, color: COLORS.light });
  c.text(
    `Yaratilgan: ${formatDateTime(report.checkedAt)}`,
    PAGE.width / 2,
    798,
    { size: 8, color: COLORS.light, align: "right" }
  );
  c.text("1 / 1", RIGHT, 798, { size: 8, color: COLORS.light, align: "right" });
}

/** Builds the PDF binary for a report object. */
export function buildPdf(report) {
  const c = createCanvas();

  c.rect(0, 0, PAGE.width, PAGE.height, { fill: COLORS.bg });
  drawHeader(c, report);
  drawPlate(c, report);
  const findingsBottom = drawFindings(c, report);
  const finesBottom = drawFines(c, report, findingsBottom);
  drawDisclaimer(c, finesBottom, report);
  drawFooter(c, report);

  // Every string op already goes through esc(), so the stream stays pure ASCII.
  const content = c.ops.join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Title (${esc(`AvtoInfo ${report.plate.full}`)}) /Author (AvtoInfo) /Creator (AvtoInfo Mini App) >>`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];

  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

/** Triggers the browser download. Returns the file name. */
export function downloadReportPdf(report) {
  const bytes = buildPdf(report);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const fileName = `AvtoInfo-${report.plate.compact}.pdf`;

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 20000);
  return fileName;
}
