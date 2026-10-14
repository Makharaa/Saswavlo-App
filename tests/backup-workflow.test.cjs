const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveexam-backup-"));
  const bin = path.join(root, "bin"), scripts = path.join(root, "scripts");
  fs.mkdirSync(bin); fs.mkdirSync(scripts);
  for (const file of ["db-command.cjs", "backup-db.sh", "restore-db.sh", "check-restore.sh", "install-backup-cron.sh"]) fs.copyFileSync(path.join(__dirname, "../scripts", file), path.join(scripts, file));
  const fake = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const command=path.basename(process.argv[1]),args=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({command,args,database:process.env.PGDATABASE,user:process.env.PGUSER,password:process.env.PGPASSWORD})+'\\n');
if(command==='pg_dump'){if(process.env.FAIL_DUMP)process.exit(2);process.stdout.write('PGDMP synthetic test archive');}
if(command==='pg_restore'&&args.includes('--list')){if(process.env.FAIL_LIST)process.exit(3);process.stdout.write('Synthetic archive listing');}
if(command==='crontab'){if(args[0]==='-l'){if(!fs.existsSync(process.env.TEST_CRON))process.exit(1);process.stdout.write(fs.readFileSync(process.env.TEST_CRON));}else fs.copyFileSync(args[0],process.env.TEST_CRON);}
`;
  for (const name of ["pg_dump", "pg_restore", "psql", "crontab"]) fs.writeFileSync(path.join(bin, name), fake, { mode: 0o700 });
  const password = "fixture-only-$-`-password";
  const env = { ...process.env, DATABASE_URL: `postgresql://fixture:${encodeURIComponent(password)}@127.0.0.1:5432/driveexam_prod`,
    RESTORE_TEST_DATABASE_URL: `postgresql://fixture:${encodeURIComponent(password)}@127.0.0.1:5432/driveexam_restore_test`,
    PATH: bin + path.delimiter + process.env.PATH, NODE_BINARY: process.execPath, TEST_CALLS: path.join(root, "calls.jsonl"), TEST_CRON: path.join(root, "cron") };
  const run = (script, args = [], overrides = {}) => spawnSync("bash", [path.join(scripts, script), ...args], { cwd: root, env: { ...env, ...overrides }, encoding: "utf8" });
  const calls = () => fs.existsSync(env.TEST_CALLS) ? fs.readFileSync(env.TEST_CALLS, "utf8").trim().split("\n").map(JSON.parse) : [];
  const clean = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, env, password, run, calls, clean };
}
test("backups are atomic, private, checksummed and credentials stay out of command arguments", () => {
  const s = sandbox();
  try {
    const result = s.run("backup-db.sh"); assert.equal(result.status, 0, result.stderr);
    const files = fs.readdirSync(path.join(s.root, "backups"));
    const archive = files.find(file => file.endsWith(".dump")); assert.ok(archive);
    assert.equal(fs.statSync(path.join(s.root, "backups", archive)).mode & 0o777, 0o600);
    const checksum = spawnSync("sha256sum", ["--check", archive + ".sha256"], { cwd: path.join(s.root, "backups"), encoding: "utf8" });
    assert.equal(checksum.status, 0);
    const dump = s.calls().find(call => call.command === "pg_dump");
    assert.equal(dump.database, "driveexam_prod"); assert.equal(dump.password, s.password);
    assert.equal(dump.args.some(arg => arg.includes(s.password) || arg.includes("postgresql://")), false);
    assert.equal((result.stdout + result.stderr).includes(s.password), false);
  } finally { s.clean(); }
});
test("failed dumps and invalid archives never leave a successful backup behind", () => {
  for (const failure of ["FAIL_DUMP", "FAIL_LIST"]) {
    const s = sandbox();
    try { assert.notEqual(s.run("backup-db.sh", [], { [failure]: "1" }).status, 0); assert.deepEqual(fs.readdirSync(path.join(s.root, "backups")), []); }
    finally { s.clean(); }
  }
});
test("restore checks refuse production and restoration uses one transaction with a rollback backup", () => {
  const s = sandbox();
  try {
    assert.equal(s.run("backup-db.sh").status, 0);
    const archive = path.join(s.root, "backups", fs.readdirSync(path.join(s.root, "backups")).find(file => file.endsWith(".dump")));
    const before = s.calls().length;
    assert.notEqual(s.run("check-restore.sh", [archive], { RESTORE_TEST_DATABASE_URL: s.env.DATABASE_URL }).status, 0);
    assert.equal(s.calls().length, before, "the guard must fail before any database command");
    assert.equal(s.run("check-restore.sh", [archive]).status, 0);
    const isolated = s.calls().find(call => call.command === "pg_restore" && call.args.includes("--single-transaction"));
    assert.equal(isolated.database, "driveexam_restore_test"); assert.ok(isolated.args.includes("--exit-on-error"));
    assert.equal(s.run("restore-db.sh", [archive]).status, 0);
    assert.equal(fs.readdirSync(path.join(s.root, "backups")).filter(file => file.endsWith(".dump")).length, 2);
    const restore = s.calls().filter(call => call.command === "pg_restore" && call.args.includes("--single-transaction")).at(-1);
    assert.equal(restore.database, "driveexam_prod"); assert.ok(restore.args.includes("--clean"));
  } finally { s.clean(); }
});
test("backup cron installation preserves other jobs and replaces its own block", () => {
  const s = sandbox();
  try {
    fs.writeFileSync(s.env.TEST_CRON, "15 * * * * /usr/bin/true\n");
    assert.equal(s.run("install-backup-cron.sh").status, 0);
    assert.equal(s.run("install-backup-cron.sh", ["30 2 * * *"]).status, 0);
    const cron = fs.readFileSync(s.env.TEST_CRON, "utf8");
    assert.ok(cron.includes("15 * * * * /usr/bin/true"));
    assert.equal(cron.split("# BEGIN DriveExam backup").length - 1, 1);
    assert.ok(cron.includes("30 2 * * *"));
    assert.notEqual(s.run("install-backup-cron.sh", ["* * * * *\ninvalid"]).status, 0);
  } finally { s.clean(); }
});
