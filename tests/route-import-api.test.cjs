const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { PGlite } = require("@electric-sql/pglite");
const bundled = require("../data/imports/simulatori-gori-route-1.json");

test("bundled route import is authorised, atomic and idempotent across retries and edits", async (t) => {
  const db = new PGlite();
  const srcRoot = path.join(__dirname, "../src");
  let currentUser = { id: 1, role: "admin" };
  let failCheckpointInsert = false;
  let failAudit = false;
  const auditCalls = [];
  const loggedErrors = [];
  const importLocks = [];
  const query = async (sql, params = []) => {
    if (sql.includes("pg_advisory_xact_lock") && params.some((value) => typeof value === "string" && value.includes("simulatori-gori-route-"))) {
      importLocks.push(params);
    }
    if (failCheckpointInsert && /^\s*INSERT INTO route_checkpoints/.test(sql)) {
      throw new Error("Synthetic checkpoint insert failure");
    }
    const result = params.length ? await db.query(sql, params) : (await db.exec(sql)).at(-1);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  // PGlite has one physical connection. Queue checked-out clients so each
  // test transaction has the same isolation as a PostgreSQL pool client.
  let checkout = Promise.resolve();
  const pool = {
    query,
    connect: async () => {
      const previous = checkout;
      let release;
      checkout = new Promise((resolve) => { release = resolve; });
      await previous;
      return { query, release };
    },
  };
  const oldLoad = Module._load;
  const oldTs = require.extensions[".ts"];
  Module._load = function (request, parent, isMain) {
    if (request === "server-only") return {};
    if (request === "@/lib/auth") return { getCurrentUser: async () => currentUser };
    if (request === "@/lib/audit") return { writeAuditLog: async (entry) => {
      if (failAudit) throw new Error("Synthetic audit failure");
      auditCalls.push(entry);
    } };
    if (request === "@/lib/logger") return { logOperationError: (...args) => loggedErrors.push(args) };
    if ((request === "./db" && parent?.filename.startsWith(path.join(srcRoot, "lib"))) || request === "@/lib/db") return { pool };
    if (request.startsWith("@/")) return oldLoad.call(this, path.join(srcRoot, request.slice(2) + ".ts"), parent, isMain);
    return oldLoad.call(this, request, parent, isMain);
  };
  require.extensions[".ts"] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, file);
  try {
    const { ensureDatabase } = require("../src/lib/migrations.ts");
    const repo = require("../src/lib/repository.ts");
    const { POST } = require("../src/app/api/routes/import/route.ts");
    await ensureDatabase();
    await query("INSERT INTO app_users(name,email,password_hash,role) VALUES($1,$2,$3,$4)", ["Import fixture admin", "import@example.test", "fictional-hash", "admin"]);
    const input = { source: "simulatori-gori-route-1" };
    const post = (body = input) => POST(new Request("http://fixture.test/api/routes/import", {
      method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    }));
    const count = async (table) => Number((await query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count);

    await t.test("only administrators can import the allowed bundled source", async () => {
      currentUser = null;
      assert.equal((await post()).status, 401);
      currentUser = { id: 1, role: "driver", canUseRoutes: true };
      assert.equal((await post()).status, 403);
      currentUser = { id: 1, role: "admin" };
      assert.equal((await post("{invalid-json")).status, 400);
      assert.equal((await post({ source: "other-route" })).status, 400);
      assert.equal((await post({ ...input, isPublished: true, speedZones: [] })).status, 400);
      assert.equal(await count("exam_routes"), 0);
    });

    let imported;
    await t.test("concurrent clicks create one complete unpublished route and initial snapshot", async () => {
      const responses = await Promise.all([post(), post()]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
      const results = await Promise.all(responses.map((response) => response.json()));
      imported = results.find((result) => !result.reused).route;
      assert.equal(results[0].route.id, results[1].route.id);
      assert.equal(await count("exam_routes"), 1);
      assert.equal(await count("route_versions"), 1);
      assert.equal(await count("route_checkpoints"), bundled.checkpoints.length);
      assert.ok(importLocks.length >= 2, "both import transactions acquire a source advisory lock");
      assert.equal(imported.isPublished, false);
      assert.equal(imported.fieldTestedAt, null);
      assert.equal(imported.version, 1);
      assert.deepEqual(imported.coordinates, bundled.coordinates);
      assert.deepEqual(imported.waypointCoordinateIndices, bundled.waypointCoordinateIndices);
      assert.deepEqual(imported.speedZones, []);
      assert.ok(imported.checkpoints.every((checkpoint) => checkpoint.speedLimit === null));
      assert.equal(imported.checkpoints.length, bundled.checkpoints.length);
      imported.checkpoints.forEach((checkpoint, index) => {
        assert.equal(checkpoint.orderIndex, index);
        assert.equal(checkpoint.routeCoordinateIndex, bundled.checkpoints[index].routeCoordinateIndex);
        assert.equal(checkpoint.voice, bundled.checkpoints[index].voice);
        assert.deepEqual(checkpoint.evaluation, bundled.checkpoints[index].evaluation ?? {});
      });
      const initial = await repo.getRouteVersionSnapshot(imported.id, 1);
      assert.equal(initial.importSource, input.source);
      assert.deepEqual(initial.coordinates, bundled.coordinates);
      assert.deepEqual(initial.checkpoints, bundled.checkpoints);
      assert.equal(initial.isPublished, false);
      assert.deepEqual(initial.speedZones, []);
      assert.equal(auditCalls.length, 1);
      assert.equal(auditCalls[0].action, "route.imported");
    });

    await t.test("retry after editing reuses the route and preserves the administrator's changes", async () => {
      imported = await repo.saveRoute(imported.id, { ...imported, name: "Edited imported route", description: "Reviewed description" }, 1, imported.version);
      const response = await post();
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.reused, true);
      assert.equal(result.route.id, imported.id);
      assert.equal(result.route.name, "Edited imported route");
      assert.equal(result.route.description, "Reviewed description");
      assert.equal(result.route.version, 2);
      assert.equal(await count("exam_routes"), 1);
      assert.equal((await repo.getRouteVersionSnapshot(imported.id, 1)).importSource, input.source);
      assert.equal(auditCalls.length, 1);
    });

    await t.test("audit outage does not report a committed import as failed", async () => {
      assert.equal(await repo.deleteRoute(imported.id, imported.version), true);
      failAudit = true;
      const response = await post();
      failAudit = false;
      assert.equal(response.status, 201);
      const result = await response.json();
      imported = result.route;
      assert.equal(result.reused, false);
      assert.equal(await count("exam_routes"), 1);
      assert.ok(loggedErrors.some(([operation]) => operation === "route-import-audit"));
      assert.equal((await post()).status, 200);
    });

    await t.test("failed checkpoint insertion rolls back route and version and permits retry", async () => {
      assert.equal(await repo.deleteRoute(imported.id, imported.version), true);
      failCheckpointInsert = true;
      const response = await post();
      failCheckpointInsert = false;
      assert.equal(response.status, 500);
      assert.equal(await count("exam_routes"), 0);
      assert.equal(await count("route_checkpoints"), 0);
      assert.equal(await count("route_versions"), 0);
      assert.equal((await post()).status, 201);
      assert.equal(await count("exam_routes"), 1);
      assert.equal(await count("route_checkpoints"), bundled.checkpoints.length);
      assert.equal(await count("route_versions"), 1);
    });
    await t.test("four licensed Gori sources import once each", async () => {
      const catalog = require("../data/imports/catalog.json");
      const ids = new Set();
      for (const entry of catalog) {
        const response = await post({ source: entry.source });
        assert.equal(response.status, entry.source === "simulatori-gori-route-1" ? 200 : 201);
        const result = await response.json();
        ids.add(result.route.id);
        const expected = require(`../data/imports/${entry.source}.json`);
        assert.equal(result.route.name, expected.name);
        assert.equal(result.route.city, expected.city);
        assert.deepEqual(result.route.coordinates, expected.coordinates);
        assert.equal(result.route.checkpoints.length, expected.checkpoints.length);
        assert.deepEqual(result.route.checkpoints.map((point) => point.voice), expected.checkpoints.map((point) => point.voice));
        assert.equal((await repo.getRouteVersionSnapshot(result.route.id, 1)).importSource, entry.source);
        const retry = await post({ source: entry.source });
        assert.equal(retry.status, 200);
        const retried = await retry.json();
        assert.equal(retried.route.id, result.route.id);
        assert.equal(retried.reused, true);
      }
      assert.equal(ids.size, 4);
      assert.equal(await count("exam_routes"), 4);
      assert.equal(await count("route_versions"), 4);
      assert.equal(await count("route_checkpoints"), 142);
    });

  } finally {
    Module._load = oldLoad;
    if (oldTs) require.extensions[".ts"] = oldTs; else delete require.extensions[".ts"];
    await db.close();
  }
});
