/**
 * Local preview server (no dependencies).
 * Dispatches every request through worker.js with a disk-backed ASSETS binding,
 * so the Mini App and /api/check behave exactly like the deployed Worker.
 *
 * The EPOLIS_*, NOTARIUS_* and TAXI_* variables are passed through from the shell, so a local
 * run can point the adapters at stubs — the same way Vercel reads them from Project settings.
 *
 *   npm start  →  http://127.0.0.1:4173
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "./worker.js";

const ROOT = resolve(fileURLToPath(new URL("./public", import.meta.url)));
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".pdf": "application/pdf",
};

async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const target = normalize(join(ROOT, clean === "/" ? "index.html" : clean));

  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;

  try {
    const info = await stat(target);
    if (info.isDirectory()) return resolveFile(join(clean, "index.html"));
    return target;
  } catch {
    return null;
  }
}

const env = {
  // Same variables Vercel/Workers provide at runtime; empty EPOLIS_API_URL means "use the
  // ERSP default", empty NOTARIUS_API_URL / TAXI_API_URL mean "not wired up yet".
  EPOLIS_API_URL: process.env.EPOLIS_API_URL ?? "",
  EPOLIS_API_KEY: process.env.EPOLIS_API_KEY ?? "",
  EPOLIS_TIMEOUT_MS: process.env.EPOLIS_TIMEOUT_MS ?? "",
  NOTARIUS_API_URL: process.env.NOTARIUS_API_URL ?? "",
  NOTARIUS_API_KEY: process.env.NOTARIUS_API_KEY ?? "",
  NOTARIUS_TIMEOUT_MS: process.env.NOTARIUS_TIMEOUT_MS ?? "",
  TAXI_API_URL: process.env.TAXI_API_URL ?? "",
  TAXI_API_KEY: process.env.TAXI_API_KEY ?? "",
  TAXI_TIMEOUT_MS: process.env.TAXI_TIMEOUT_MS ?? "",
  ASSETS: {
    async fetch(request) {
      const path = await resolveFile(new URL(request.url).pathname);

      if (!path) {
        return new Response("404 — topilmadi", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      const body = await readFile(path);

      return new Response(body, {
        status: 200,
        headers: {
          "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    },
  },
};

const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    let size = 0;

    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        break;
      }
      chunks.push(chunk);
    }

    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    const webRequest = new Request(
      `http://${request.headers.host ?? `${HOST}:${PORT}`}${request.url}`,
      {
        method: request.method,
        headers: request.headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      }
    );

    const webResponse = await worker.fetch(webRequest, env);
    const body = Buffer.from(await webResponse.arrayBuffer());
    const headers = {};

    webResponse.headers.forEach((value, key) => {
      headers[key] = value;
    });

    response.writeHead(webResponse.status, headers);
    response.end(body);
  } catch (error) {
    console.error("[server]", error);
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("500 — server xatosi");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AvtoInfo → http://${HOST}:${PORT}`);
});
