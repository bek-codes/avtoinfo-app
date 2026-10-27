/**
 * AvtoInfo — Vercel Serverless Function
 *   POST /api/check  →  { ok: true, report }
 *
 * Static assets are served by Vercel from /public (see vercel.json).
 * Validation, report building and the real E-Polis (ersp.e-osgo.uz) insurance + vehicle
 * lookup live in lib/check.mjs → lib/epolis.mjs, so this file stays a thin adapter: it only
 * reads the body, forwards it and shapes the HTTP response.
 *
 * Runtime vars (Project → Settings → Environment Variables, keep them server-side):
 *   EPOLIS_API_URL    optional — override the default ERSP endpoint
 *   EPOLIS_API_KEY    optional — bearer token for that endpoint
 *   EPOLIS_TIMEOUT_MS optional — request timeout in ms (default 4000)
 *   MIB_API_URL       optional — MIB ban/search endpoint (no public JSON API is documented,
 *                      so without it the MIB block honestly reports "Tekshirilmadi")
 *   MIB_API_KEY       optional — bearer token for that endpoint
 *   MIB_TIMEOUT_MS    optional — request timeout in ms (default 4000)
 *
 * Every adapter returns "not configured" instead of inventing an answer, so a missing
 * variable degrades the affected block to an explicit "Tekshirilmadi" state.
 *
 * The handler accepts both Vercel signatures: the Web one (Request → Response) and the
 * Node one (IncomingMessage, ServerResponse), so the runtime choice never breaks it.
 */

import {
  MAX_BODY_BYTES,
  fail,
  handleCheckPayload,
  readJsonBody,
  tooLarge,
} from '../lib/check.mjs';

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const failure = ({ status, body }) => ({
  status,
  headers,
  body: JSON.stringify(body),
});

const headerOf = (req, name) => {
  const source = req?.headers;
  if (!source) return null;
  if (typeof source.get === 'function') return source.get(name);
  const value = source[name] ?? source[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
};

/** Body as text, for both a Web `Request` and a Node `IncomingMessage`. */
async function readRaw(req) {
  if (typeof req?.text === 'function') return req.text();

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The runtime vars, from process.env — never from the client.
 * Every variable an adapter can read must be forwarded here, otherwise the adapter would
 * silently behave as "not configured" in production even though the variable is set.
 */
const RUNTIME_VARS = [
  'EPOLIS_API_URL',
  'EPOLIS_API_KEY',
  'EPOLIS_TIMEOUT_MS',
  'MIB_API_URL',
  'MIB_API_KEY',
  'MIB_TIMEOUT_MS',
];

const runtimeEnv = () =>
  Object.fromEntries(RUNTIME_VARS.map((name) => [name, process.env?.[name] ?? '']));

async function check(req) {
  if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
    return failure(fail('method_not_allowed', 'Faqat POST soʻrovi qabul qilinadi.', null, 405));
  }

  const declared = Number(headerOf(req, 'content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return failure(tooLarge());

  let raw = '';
  try {
    raw = await readRaw(req);
  } catch {
    return failure(fail('bad_request', 'Soʻrovni oʻqib boʻlmadi.'));
  }

  if (raw.length > MAX_BODY_BYTES) return failure(tooLarge());

  const { payload, error } = await readJsonBody(raw);
  if (error) return failure(error);

  return failure(await handleCheckPayload(payload, runtimeEnv()));
}

export default async function handler(req, res) {
  const result = await check(req);

  // Web signature: the runtime expects a Response back.
  if (typeof res === 'undefined' || res === null) {
    return new Response(result.body, { status: result.status, headers: result.headers });
  }

  // Node signature.
  res.statusCode = result.status;
  for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
  res.end(result.body);
}
