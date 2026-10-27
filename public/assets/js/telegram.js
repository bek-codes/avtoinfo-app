/**
 * Telegram WebApp SDK bilan yupqa integratsiya.
 *
 * Ilova Telegram ichida ham, oddiy brauzerda ham ochilishi mumkin — shuning uchun
 * har bir chaqiruv ixtiyoriy (?. ) va try/catch ichida: SDK yoʻq boʻlsa hech narsa
 * buzilmaydi, shunchaki hech qanday effekt boʻlmaydi.
 */

const webApp = () =>
  typeof window === "undefined" ? null : window.Telegram?.WebApp ?? null;

export function expand() {
  const app = webApp();
  try {
    app?.expand?.();
  } catch {
    /* Telegram tashqarisida — eʼtiborsiz */
  }
  return app;
}

export function isReady() {
  const app = webApp();
  return typeof app?.isReady === "function" ? Boolean(app.isReady()) : true;
}

/** Ilova ochilganda bir marta: toʻliq ekran, fon rangi (dark theme), back-tugma yopiq. */
export function initTelegram() {
  const app = webApp();
  if (!app) return null;

  try {
    app.expand?.();
    app.disableVerticalSwipes?.();
    app.setHeaderColor?.("#060a13");
    app.setBackgroundColor?.("#060a13");
    app.BackButton?.hide?.();
  } catch {
    /* eski Telegram klientlarida bu metodlar boʻlmasligi mumkin */
  }

  app.ready?.();
  return app;
}

let backHandler = null;
let backBound = false;

/**
 * Telegram back-tugmasi. onClick har chaqiruvda yangi handler qoʻshib yubormasligi uchun
 * SDK ga bir marta ulanadi va joriy sahifaning handleriga yoʻnaltiradi.
 */
export function setBackButton(visible, handler) {
  backHandler = typeof handler === "function" ? handler : null;

  const button = webApp()?.BackButton;
  if (!button) return;

  if (!backBound && typeof button.onClick === "function") {
    button.onClick(() => {
      if (typeof backHandler === "function") backHandler();
    });
    backBound = true;
  }

  try {
    if (visible) button.show?.();
    else button.hide?.();
  } catch {
    /* eʼtiborsiz */
  }
}

const impact = (style) => {
  try {
    webApp()?.HapticFeedback?.impactOccurred?.(style);
  } catch {
    /* eʼtiborsiz */
  }
};

const notify = (type) => {
  try {
    webApp()?.HapticFeedback?.notificationOccurred?.(type);
  } catch {
    /* eʼtiborsiz */
  }
};

/** Tugmalar uchun teginish sezgisi: haptics.tap() / .success() / .error() */
export const haptics = {
  tap: () => impact("light"),
  success: () => notify("success"),
  error: () => notify("error"),
};
