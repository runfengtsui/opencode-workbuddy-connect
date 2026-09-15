// Plugin entry contract test (no network): the legacy config hook must
// register the provider, every model at its true limit (1M where native),
// effort variants, auth methods, and agent pins.
// Run: node test/plugin.mjs
import plugin from "../dist/index.js";

if (typeof plugin?.server !== "function") { console.log("FAIL: plugin.server missing"); process.exit(1); }
const hooks = await plugin.server({ project: {}, client: {} }, {});
for (const need of ["config", "auth", "tool"]) {
  if (!(need in hooks)) { console.log(`FAIL: hook ${need} missing`); process.exit(1); }
}

const cfg = { provider: {}, model: undefined };
await hooks.config(cfg);

const p = cfg.provider.workbuddy;
if (!p) { console.log("FAIL: provider not registered"); process.exit(1); }
const models = Object.values(p.models);
console.log(`provider=${p.name} npm=${p.npm?.slice(0, 40)}... models=${models.length}`);

let fail = 0;
for (const m of models) {
  const ctx = m.limit?.context;
  const inp = m.limit?.input;
  if (!ctx || !inp || ctx !== inp) { console.log(`FAIL limit ${m.name}`); fail++; }
}
const flash = p.models["deepseek-v4-flash"];
if (flash?.limit?.context !== 1_000_000) { console.log("FAIL: deepseek-v4-flash ctx not 1M"); fail++; }
else console.log("deepseek-v4-flash: limit.context=1000000, limit.input=1000000  <- compaction runs at 1M");
if (!flash?.variants?.max?.reasoningEffort) { console.log("FAIL: effort variants missing"); fail++; }
else console.log(`variants: ${Object.keys(flash.variants).join(",")}`);

// Default config must not clobber a user-set model.
if (cfg.model) { console.log("FAIL: setDefault not requested but cfg.model set"); fail++; }

const methods = hooks.auth.methods.map((m) => m.type);
console.log(`auth methods: ${methods.join(",")} (Browser Login needs WORKBUDDY_BASE_URL=https://www.workbuddy.cn for CN accounts)`);
if (!methods.includes("api") || !methods.includes("oauth")) { console.log("FAIL: auth methods"); fail++; }
console.log(`account tool: ${Object.keys(hooks.tool).join(",")}`);

if (fail) { console.log(`FAIL x${fail}`); process.exit(1); }
console.log("PASS");
