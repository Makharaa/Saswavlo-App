const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const matcher = require("../.test-build/utils/road-trace-match.js");
const source = path.join(__dirname, "../src/app/api/map/match/route.ts");
let user = { id: 7, role: "admin" };
const oldLoad = Module._load;
let handlers;
Module._load = function(request, parent, isMain) {
  if (parent?.filename === source) {
    if (request === "@/lib/auth") return { getCurrentUser: async () => user };
    if (request === "@/lib/logger") return { logOperationError() {} };
    if (request === "@/utils/road-trace-match") return matcher;
  }
  return oldLoad.call(this, request, parent, isMain);
};
try {
  const mod = new Module(source, module); mod.filename = source; mod.paths = Module._nodeModulePaths(path.dirname(source));
  mod._compile(ts.transpileModule(fs.readFileSync(source, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, source);
  handlers = mod.exports;
} finally { Module._load = oldLoad; }
const samples = [0, 1, 2, 3].map(i => ({ lng: 44.1, lat: 41.98 + i * 0.0001, accuracy: 8, timestamp: 1800000000000 + i * 1000 }));
const body = () => ({ code: "Ok", tracepoints: samples.map((s, i) => ({ location: [s.lng, s.lat], matchings_index: 0, waypoint_index: i, alternatives_count: 0 })),
  matchings: [{ confidence: 0.99, legs: samples.slice(1).map((s, i) => ({ steps: [{ geometry: { coordinates: [[samples[i].lng, samples[i].lat], [s.lng, s.lat]] } }] })) }] });
const post = (input, signal) => handlers.POST(new Request("http://fixture.test/api/map/match", { method: "POST", body: typeof input === "string" ? input : JSON.stringify(input), signal }));

test("only admins can submit a GPS trace and malformed requests never contact the router", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("should not fetch"); };
  try {
    user = null; assert.equal((await post({ samples })).status, 403);
    user = { id: 7, role: "driver" }; assert.equal((await post({ samples })).status, 403);
    user = { id: 7, role: "admin" };
    assert.equal((await post("{invalid")).status, 400);
    assert.equal((await post({ samples: samples.slice().reverse() })).status, 400);
    assert.equal((await post({ samples, hints: ["too few"] })).status, 400);
    assert.equal(calls, 0);
  } finally { user = { id: 7, role: "admin" }; global.fetch = originalFetch; }
});

test("the authenticated endpoint requests temporal map matching, leg curves and local anchor hints", async () => {
  const originalFetch = global.fetch;
  const previousBase = process.env.ROUTING_BASE_URL;
  process.env.ROUTING_BASE_URL = "https://routing.fixture.test///";
  global.fetch = async (url, options) => {
    const target = new URL(url);
    assert.ok(target.pathname.startsWith("/match/v1/driving/"));
    assert.equal(target.hostname, "routing.fixture.test");
    assert.equal(target.searchParams.get("timestamps"), samples.map(s => Math.floor(s.timestamp / 1000)).join(";"));
    assert.equal(target.searchParams.get("radiuses"), "8;8;8;8");
    assert.equal(target.searchParams.get("hints"), ";confirmed-road;;");
    assert.equal(target.searchParams.get("steps"), "true");
    assert.equal(target.searchParams.get("gaps"), "split");
    assert.equal(target.searchParams.has("bearings"), false);
    assert.equal(options.cache, "no-store");
    return { ok: true, json: async () => body() };
  };
  try {
    const response = await post({ samples, hints: [null, "confirmed-road", null, null] });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.json()).matchings[0].legs.length, 3);
  } finally {
    global.fetch = originalFetch;
    if (previousBase == null) delete process.env.ROUTING_BASE_URL; else process.env.ROUTING_BASE_URL = previousBase;
  }
});

test("NoMatch, an outage and invalid upstream geometry are recoverable errors", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, json: async () => ({ code: "NoMatch" }) });
    assert.equal((await post({ samples })).status, 422);
    global.fetch = async () => { throw new Error("synthetic router outage"); };
    assert.equal((await post({ samples })).status, 502);
    global.fetch = async () => { const output = body(); output.tracepoints[1].location[0] += 0.01; return { ok: true, json: async () => output }; };
    assert.equal((await post({ samples })).status, 502);
  } finally { global.fetch = originalFetch; }
});

test("cancelling an old recording aborts its upstream match request", async () => {
  const originalFetch = global.fetch;
  const cancel = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  global.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
    started(); signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  try {
    const pending = post({ samples }, cancel.signal);
    await ready; cancel.abort();
    assert.equal((await pending).status, 504);
  } finally { global.fetch = originalFetch; }
});
