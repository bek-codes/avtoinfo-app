/**
 * AvtoInfo — Cloudflare Worker (Freebuff Sites)
 *
 * Serves the Mini App static assets and the car-history check endpoint:
 *   POST /api/check  →  { ok: true, report }
 *
 * Validation, report building and the real E-Polis (ersp.e-osgo.uz) insurance lookup plus the
 * MIB ban/search adapter live in lib/check.mjs → lib/epolis.mjs / lib/mib.mjs / lib/vin.mjs,
 * the same modules the Vercel Serverless Function (api/check.js) uses, so both runtimes answer
 * identically. EPOLIS_* / MIB_* are read from the Worker env — they must never be exposed to
 * the browser. A missing MIB_API_URL is not an error: that block reports "Tekshirilmadi".
 */

import {
  MAX_BODY_BYTES,
  fail,
  handleCheckPayload,
  readJsonBody,
  tooLarge,
} from './lib/check.mjs';

const toResponse = ({ status, body }) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/check') {
      if (request.method !== 'POST') {
        return toResponse(
          fail('method_not_allowed', 'Faqat POST soʻrovi qabul qilinadi.', null, 405)
        );
      }

      const length = Number(request.headers.get('content-length') ?? 0);
      if (length > MAX_BODY_BYTES) return toResponse(tooLarge());

      const raw = await request.text();
      const { payload, error } = await readJsonBody(raw);
      if (error) return toResponse(error);

      // env vars (EPOLIS_* / MIB_*) come from the Worker bindings/vars.
      return toResponse(await handleCheckPayload(payload, env));
    }

    if (url.pathname.startsWith('/api/')) {
      return toResponse(fail('not_found', 'Bunday API manzili mavjud emas.', null, 404));
    }

    return env.ASSETS.fetch(request);
  },
};
