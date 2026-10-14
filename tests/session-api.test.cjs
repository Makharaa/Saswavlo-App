const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const fixture = require("./fixtures/stop-left-real.json");
const normalize = require("../.test-build/utils/session-normalizer.js");
const validation = require("../.test-build/utils/session-validation.js");
const source = path.join(__dirname, "../src/app/api/sessions/route.ts");
let currentUser = { id: 7, role: "driver", canUseRoutes: true }, lookup = null, failDatabase = false;
const listCalls = [];
const repository = {
  findDrivingSessionId: async () => { if (failDatabase) throw new Error("synthetic outage"); return lookup; },
  getRoute: async () => ({ ...fixture.route, id: 1, version: 2 }),
  getRouteVersionSnapshot: async () => ({ ...fixture.route, isPublished: true }),
  saveDrivingSession: async (result) => ({ id: 42, checkpointsCompleted: result.checkpointsCompleted }),
  listDrivingSessions: async (...args) => { listCalls.push(args); return []; },
};
const oldLoad = Module._load;
let handlers;
Module._load = function(request, parent, isMain) {
  if (parent?.filename === source) {
    if (request === "@/lib/repository") return repository;
    if (request === "@/lib/history-page-query") return { readHistoryOptions: () => ({}) };
    if (request === "@/lib/auth") return { getCurrentUser: async () => currentUser };
    if (request === "@/lib/logger") return { logOperationError() {} };
    if (request === "@/utils/session-normalizer") return normalize;
    if (request === "@/utils/session-validation") return validation;
  }
  return oldLoad.call(this, request, parent, isMain);
};
try {
  const mod = new Module(source, module); mod.filename = source; mod.paths = Module._nodeModulePaths(path.dirname(source));
  mod._compile(ts.transpileModule(fs.readFileSync(source, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, source);
  handlers = mod.exports;
} finally { Module._load = oldLoad; }
const input = () => ({ clientSessionId: "api-fixture", routeId: 1, routeVersion: 2, mode: "real", assistMode: "exam",
  startedAt: fixture.trace[0].observedAt, finishedAt: fixture.trace.at(-1).observedAt, durationSeconds: 0,
  distanceMeters: 0, maxSpeedKmh: 0, speedingEvents: 0, offRouteEvents: 0, checkpointsCompleted: 0, checkpointsTotal: 2,
  events: [], trace: fixture.trace, traceComplete: true });
const post = (body) => handlers.POST(new Request("http://fixture.test/api/sessions", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

test("invalid JSON is a client error while database outages remain retryable", async () => {
  assert.equal((await post("{invalid-json")).status, 400);
  failDatabase = true;
  try { assert.equal((await post(input())).status, 500); } finally { failDatabase = false; }
});
test("an acknowledged retry succeeds after deletion and new sessions are replayed", async () => {
  lookup = 99;
  try { const response = await post(input()); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { id: 99, duplicate: true }); }
  finally { lookup = null; }
  const response = await post(input()); assert.equal(response.status, 201);
  assert.equal((await response.json()).checkpointsCompleted, 2);
});
test("drivers can list only their own sessions and disabled access cannot submit", async () => {
  await handlers.GET(new Request("http://fixture.test/api/sessions?limit=9999"));
  assert.deepEqual(listCalls.at(-1), [500, 7, 0]);
  currentUser = { ...currentUser, role: "admin" };
  await handlers.GET(new Request("http://fixture.test/api/sessions")); assert.deepEqual(listCalls.at(-1), [50, undefined, 0]);
  currentUser = { id: 7, role: "driver", canUseRoutes: false };
  assert.equal((await post(input())).status, 403);
  currentUser = null; assert.equal((await post(input())).status, 401);
  currentUser = { id: 7, role: "driver", canUseRoutes: true };
});
