#!/usr/bin/env node
const assert = require("node:assert/strict");
const http = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const next = require("next");
const { version } = require("maplibre-gl/package.json");

async function main() {
  const root = path.resolve(__dirname, "..");
  if (process.cwd() !== root) process.chdir(root);
  const app = next({ dev: false, dir: root });
  await app.prepare();
  const handler = app.getRequestHandler();
  const server = http.createServer((request, response) => handler(request, response));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const source = await readFile(path.join(root, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"), "utf8");
    for (const suffix of ["", `?v=${encodeURIComponent(version)}`]) {
      const response = await fetch(`${origin}/api/map/worker${suffix}`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200, "The worker must be public and respond with HTTP 200");
      assert.match(response.headers.get("content-type"), /^(?:application|text)\/javascript(?:;|$)/);
      assert.equal(await response.text(), source, "The response must be the installed worker module, never an HTML page");
      assert.equal(response.headers.get("cache-control"), suffix ? "public, max-age=31536000, immutable" : "no-cache");
    }
    const oldVersion = await fetch(`${origin}/api/map/worker?v=0.0.0`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(oldVersion.status, 409, "A cached incompatible client must not receive a different worker version");
    assert.equal(oldVersion.headers.get("cache-control"), "no-store");
    console.log(`MapLibre ${version} worker: HTTP 200, JavaScript MIME, exact module bytes, no login and versioned caching verified.`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
