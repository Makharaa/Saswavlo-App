#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
function mainDatabaseURL() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const file = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(file)) throw Error("Database configuration is missing.");
  const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((line) => /^\s*(?:export\s+)?DATABASE_URL\s*=/.test(line));
  if (!line) throw Error("Database configuration is missing.");
  let value = line.slice(line.indexOf("=") + 1).trim();
  if ((value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
  else value = value.replace(/\s+#.*$/, "");
  return value;
}
function connection(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw Error("Database configuration is invalid."); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw Error("Database configuration must use PostgreSQL.");
  const env = { ...process.env, PGCONNECT_TIMEOUT: "10", PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    PGHOST: parsed.searchParams.get("host") || parsed.hostname || "localhost", PGPORT: parsed.port || "5432" };
  if (!env.PGDATABASE) throw Error("Database name is missing.");
  if (parsed.username) env.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  const options = { sslmode: "PGSSLMODE", sslrootcert: "PGSSLROOTCERT", sslcert: "PGSSLCERT", sslkey: "PGSSLKEY", options: "PGOPTIONS", channel_binding: "PGCHANNELBINDING" };
  for (const [name, variable] of Object.entries(options)) if (parsed.searchParams.has(name)) env[variable] = parsed.searchParams.get(name);
  return env;
}
try {
  const args = process.argv.slice(2);
  const test = args[0] === "--test";
  if (test) args.shift();
  const command = args.shift();
  if (command === "assert-test") {
    const actual = connection(mainDatabaseURL());
    const isolated = connection(process.env.RESTORE_TEST_DATABASE_URL || "");
    if (!isolated.PGDATABASE.endsWith("_restore_test") || isolated.PGDATABASE === actual.PGDATABASE) throw Error("Restoration checks require a different database ending in _restore_test.");
    console.log("Isolated restoration target confirmed.");
    process.exit(0);
  }
  if (!["pg_dump", "pg_restore", "psql"].includes(command)) throw Error("Unsupported database command.");
  const needsConnection = !(command === "pg_restore" && args.includes("--list"));
  const env = needsConnection ? connection(test ? process.env.RESTORE_TEST_DATABASE_URL || "" : mainDatabaseURL()) : process.env;
  if (needsConnection && command !== "pg_dump") args.push(`--dbname=${env.PGDATABASE}`);
  const child = spawnSync(command, args, { env, stdio: "inherit" });
  if (child.error) throw Error(`${command} is unavailable. Install the PostgreSQL client tools.`);
  process.exit(child.status ?? 1);
} catch (error) {
  console.error(error.message?.startsWith("Database") || error.message?.startsWith("Restoration") || error.message?.includes("unavailable") || error.message?.includes("Unsupported") ? error.message : "Database operation failed.");
  process.exit(1);
}
