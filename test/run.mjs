// Offline suite runner: every test here runs without credentials, without the
// network, and against a sandboxed cache/config root. `npm test` gates on this.
//
// The network-backed smoke tests (live.mjs, tools.mjs) are NOT part of this
// suite because they need a real WorkBuddy login for the access point they
// target; run them with `npm run test:live` and a region argument.
import { spawn } from "node:child_process";
import { join } from "node:path";

const OFFLINE = ["catalogue.mjs", "plugin.mjs", "log.mjs", "stream.mjs"];

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, file)], {
      stdio: "inherit",
      env: { ...process.env, WORKBUDDY_DISABLE_MODEL_DISCOVERY: "1" },
    });
    child.on("close", (code) => resolve({ file, code }));
  });
}

const results = [];
for (const file of OFFLINE) {
  console.log(`\n=== ${file} ===`);
  results.push(await run(file));
}

console.log("\n=== summary ===");
let failed = 0;
for (const { file, code } of results) {
  if (code === 0) {
    console.log(`  PASS  ${file}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${file} (exit ${code})`);
  }
}
process.exit(failed === 0 ? 0 : 1);
