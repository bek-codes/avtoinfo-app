/**
 * Davlat raqami va texnik pasport maydonlari uchun kiritishni tozalash/formatlash.
 *
 * Qoidalar serverdagi bilan bir xil (lib/check.mjs → cleanRegion / cleanSeries /
 * cleanTechNumber / normalizePlate), shuning uchun foydalanuvchi ekranda koʻrgan raqam
 * serverga ham aynan shunday yetib boradi.
 */

const PLATE_PATTERN = /^[A-Z]\d{3}[A-Z]{2}$/;

/** Viloyat kodi: faqat raqam, 2 xona ("01"). */
export function cleanRegion(value) {
  return String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, 2);
}

/** Texnik pasport seriyasi: faqat harf, 3 xona ("AAF"). */
export function cleanSeries(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3);
}

/** Texnik pasport raqami: faqat raqam, 7 xona ("1234567"). */
export function cleanNumber(value) {
  return String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, 7);
}

export function isRegionValid(value) {
  return /^\d{2}$/.test(cleanRegion(value));
}

/**
 * "a777aa" / "A777AA" → "A 777 AA" — yozish jarayonida ham ishlaydi ("A7" → "A 7").
 * Raqam toʻliq boʻlgach oxiriga bitta boʻsh joy qoʻshiladi, shunda app.js avtomatik
 * keyingi maydonga (texnik pasport seriyasi) oʻtadi.
 */
export function formatPlateNumber(value) {
  const raw = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);

  const groups = raw.match(/^([A-Z]?)(\d{0,3})([A-Z]{0,2})/);
  const formatted = groups
    ? [groups[1], groups[2], groups[3]].filter(Boolean).join(" ")
    : raw;

  return PLATE_PATTERN.test(formatted.replace(/ /g, "")) ? `${formatted} ` : formatted;
}

/** "A 777 AA" / "A777AA" → true */
export function isPlateNumberValid(value) {
  return PLATE_PATTERN.test(
    String(value ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
  );
}
