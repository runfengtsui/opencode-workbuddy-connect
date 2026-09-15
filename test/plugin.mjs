// Plugin entry contract test (no network): each integration point must
// register its own provider, every model at its true limit (1M where native),
// effort variants, auth methods, a region-unique account tool, and a
// credential store that cannot clobber the other region's.
// Run: node test/plugin.mjs
import { createPlugin } from "../dist/index.js";

const EXPECT = {
  intl: {
    pluginID: "opencode-workbuddy-connect",
    providerID: "workbuddy",
    name: "WorkBuddy AI",
    store: "workbuddy-auth.json",
    tool: "workbuddy_account",
    // International is not pinned: WORKBUDDY_BASE_URL must still win.
    baseUrl: undefined,
    baseURL: "https://www.workbuddy.ai",
  },
  cn: {
    pluginID: "opencode-workbuddy-connect-cn",
    providerID: "workbuddy-cn",
    name: "WorkBuddy AI (CN)",
    store: "workbuddy-cn-auth.json",
    tool: "workbuddy_cn_account",
    baseUrl: "https://www.workbuddy.cn",
    baseURL: "https://www.workbuddy.cn",
  },
};

let fail = 0;
const check = (cond, msg) => {
  if (!cond) {
    console.log(`FAIL: ${msg}`);
    fail++;
  }
};

for (const [region, want] of Object.entries(EXPECT)) {
  console.log(`\n--- ${region} ---`);
  const plugin = createPlugin(region);
  check(plugin.id === want.pluginID, `plugin id ${plugin.id} != ${want.pluginID}`);
  check(typeof plugin.server === "function", "plugin.server missing");
  check(typeof plugin.setup === "function", "plugin.setup missing");

  const hooks = await plugin.server({ project: {}, client: {} }, {});
  for (const need of ["config", "auth", "tool"]) check(need in hooks, `hook ${need} missing`);

  // The auth hook binds exactly one provider -- that is why a region needs
  // its own plugin instance.
  check(hooks.auth.provider === want.providerID, `auth.provider ${hooks.auth.provider} != ${want.providerID}`);

  const cfg = { provider: {}, model: undefined };
  await hooks.config(cfg);

  // One integration point must never register under the other's id.
  check(Object.keys(cfg.provider).join() === want.providerID, `providers registered: ${Object.keys(cfg.provider)}`);
  const p = cfg.provider[want.providerID];
  check(!!p, "provider not registered");
  check(p.name === want.name, `provider name ${p.name} != ${want.name}`);

  // These are what createWorkBuddy receives: the store keeps logins apart and
  // the pinned base keeps CN traffic off the international endpoint.
  check(p.options.providerID === want.providerID, `options.providerID ${p.options.providerID}`);
  check(p.options.storeName === want.store, `options.storeName ${p.options.storeName} != ${want.store}`);
  check(p.options.baseURL === want.baseURL, `options.baseURL ${p.options.baseURL} != ${want.baseURL}`);
  check(p.options.baseUrl === want.baseUrl, `options.baseUrl ${p.options.baseUrl} != ${want.baseUrl}`);

  const models = Object.values(p.models);
  console.log(`provider=${p.name} models=${models.length} store=${p.options.storeName} base=${p.options.baseURL}`);
  for (const m of models) check(m.limit?.context && m.limit.context === m.limit.input, `limit ${m.name}`);
  const flash = p.models["deepseek-v4-flash"];
  check(flash?.limit?.context === 1_000_000, "deepseek-v4-flash ctx not 1M");
  check(!!flash?.variants?.max?.reasoningEffort, "effort variants missing");

  // Default config must not clobber a user-set model.
  check(!cfg.model, "setDefault not requested but cfg.model set");
  check(!Object.keys(cfg.agent ?? {}).some((k) => !["plan", "general", "explore", "title", "compaction"].includes(k)), "unexpected agent pin");
  for (const [name, agent] of Object.entries(cfg.agent ?? {})) {
    check(agent.model === `${want.providerID}/hy3`, `agent ${name} -> ${agent.model}`);
  }

  const methods = hooks.auth.methods.map((m) => m.type);
  check(methods.includes("api") && methods.includes("oauth"), `auth methods ${methods}`);
  const oauth = hooks.auth.methods.find((m) => m.type === "oauth");
  check(oauth.label.includes(want.name), `oauth label "${oauth.label}" lacks ${want.name}`);
  console.log(`auth: ${methods.join(",")} / ${oauth.label}`);

  const tools = Object.keys(hooks.tool);
  check(tools.join() === want.tool, `tool ${tools} != ${want.tool}`);
  console.log(`account tool: ${tools.join(",")}`);

  // Options from a tuple entry still override the region defaults.
  const overridden = await createPlugin(region).server({}, { baseUrl: "https://gateway.example.test", storeName: "x.json" });
  const ocfg = { provider: {} };
  await overridden.config(ocfg);
  const op = ocfg.provider[want.providerID].options;
  check(op.baseUrl === "https://gateway.example.test", `option override baseUrl lost: ${op.baseUrl}`);
  check(op.storeName === "x.json", `option override store lost: ${op.storeName}`);
  check(op.baseURL === "https://gateway.example.test", `baseURL not derived from override: ${op.baseURL}`);
}

console.log(`\ndefault export = intl: ${JSON.stringify((await import("../dist/index.js")).default.id)}`);

if (fail) {
  console.log(`FAIL x${fail}`);
  process.exit(1);
}
console.log("PASS");
