const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const source = path.join(__dirname, "../src/app/api/profile/route.ts");

let signedIn = { id: 12, role: "driver" };
let current = { email: "driver@example.com", password_hash: "hash:old-secret123", is_active: true };
let cleared = 0;
let writes = [];
let conflict = false;
const originalLoad = Module._load;
const mock = {
  "next/server": { NextResponse: { json: (data, options = {}) => Response.json(data, { status: options.status ?? 200, headers: options.headers }) } },
  "@/lib/db": { pool: { connect: async () => ({
    query: async (sql, params) => {
      writes.push(sql);
      if (sql.includes("SELECT email,password_hash")) return { rows: [{ ...current }] };
      if (sql.includes("SET email=")) {
        if (conflict) { const error = new Error("duplicate"); error.code = "23505"; throw error; }
        current.email = params[0];
      }
      if (sql.includes("SET password_hash=")) current.password_hash = params[0];
      return { rows: [] };
    },
    release() {},
  }) } },
  "@/lib/migrations": { ensureDatabase: async () => {} },
  "@/lib/auth": {
    getCurrentUser: async () => signedIn,
    verifyPassword: async (password, storedHash) => storedHash === `hash:${password}`,
    hashPassword: async (password) => `hash:${password}`,
    clearSessionCookie: async () => { cleared++; },
  },
  "@/lib/audit": { writeAuditLog: async () => {} },
};
let api;
Module._load = function(request, parent, isMain) {
  if (parent?.filename === source && Object.hasOwn(mock, request)) return mock[request];
  return originalLoad.call(this, request, parent, isMain);
};
try {
  const mod = new Module(source, module); mod.filename = source; mod.paths = Module._nodeModulePaths(path.dirname(source));
  mod._compile(ts.transpileModule(fs.readFileSync(source, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, source);
  api = mod.exports;
} finally { Module._load = originalLoad; }

function reset() {
  signedIn = { id: 12, role: "driver" };
  current = { email: "driver@example.com", password_hash: "hash:old-secret123", is_active: true };
  cleared = 0;
  writes = [];
  conflict = false;
}
function patch(body, origin = "https://saswavlo.makhara.ge") {
  return api.PATCH(new Request("https://saswavlo.makhara.ge/api/profile", {
    method: "PATCH", headers: { origin, host: "saswavlo.makhara.ge", "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

test("profile API blocks unauthenticated updates and cross-site origins", async () => {
  reset(); signedIn = null;
  assert.equal((await patch({ action: "email", email: "new@example.com", currentPassword: "old-secret123" })).status, 401);
  signedIn = { id: 12, role: "driver" };
  assert.equal((await patch({ action: "email", email: "new@example.com", currentPassword: "old-secret123" }, "https://attacker.test")).status, 403);
  assert.equal(writes.length, 0);
});
test("profile requires current password for email changes", async () => {
  reset();
  assert.equal((await patch({ action: "email", email: "new@example.com", currentPassword: "wrong" })).status, 400);
  assert.equal(current.email, "driver@example.com");
  assert.equal((await patch({ action: "email", email: "New@Example.com", currentPassword: "old-secret123" })).status, 200);
  assert.equal(current.email, "new@example.com");
  assert.equal(cleared, 0);
});
test("profile rejects duplicate email and preserves prior value", async () => {
  reset(); conflict = true;
  assert.equal((await patch({ action: "email", email: "taken@example.com", currentPassword: "old-secret123" })).status, 409);
  assert.equal(current.email, "driver@example.com");
  assert.equal(writes.some((statement) => statement.includes("ROLLBACK")), true);
});
test("profile password update requires confirmation, revokes sessions", async () => {
  reset();
  assert.equal((await patch({ action: "password", currentPassword: "old-secret123", newPassword: "short" })).status, 400);
  assert.equal((await patch({ action: "password", currentPassword: "old-secret123", newPassword: "old-secret123" })).status, 400);
  const response = await patch({ action: "password", currentPassword: "old-secret123", newPassword: "new-secret123" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).relogin, true);
  assert.equal(current.password_hash, "hash:new-secret123");
  assert.equal(writes.some((statement) => statement.includes("active_session_id=$2")), true);
  assert.equal(cleared, 1);
});
