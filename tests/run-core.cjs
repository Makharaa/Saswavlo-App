const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

// Direct execution reports each node:test assertion across supported Node
// versions, including hosts whose isolated runner only reports file totals.
for (const file of readdirSync(__dirname).filter((name) => name.endsWith(".test.cjs")).sort()) {
  const result = spawnSync(process.execPath, [join(__dirname, file)], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
