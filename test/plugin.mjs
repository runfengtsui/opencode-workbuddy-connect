// Plugin entry contract test (no network): each integration point must
// register its own provider, every model at its true limit (1M where native),
// effort variants, auth methods, a region-unique account tool, and a
// credential store that cannot clobber the other region's.
//
// v2 note: `definePlugin(region).setup(ctx)` registers everything through v2
// transform editors / hooks instead of returning a `{ config, auth, tool }`
// bag. A mock context (test/helpers/v2-context.mjs) captures those registrations.
// Run: node test/plugin.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "../dist/index.js";
import { modelTable } from "../dist/models.js";
import { createV2Context, runLanguageHook } from "./helpers/v2-context.mjs";

// Isolate every on-disk source of credentials AND models. v2 reads the desktop
// product-config cache through homedir(), so HOME must be sandboxed too or the
// real machine's cached model table leaks into the "static" assertions.
const sandbox = mkdtempSync(join(tmpdir(), "wb-plugin-"));
process.env.HOME = sandbox;
process.env.XDG_CONFIG_HOME = join(sandbox, "config");
process.env.XDG_CACHE_HOME = join(sandbox, "cache");
process.env.WORKBUDDY_DISABLE_MODEL_DISCOVERY = "1";
for (const key of [
  "WORKBUDDY_CONFIG_DIR",
  "CODEBUDDY_CONFIG_DIR",
  "WORKBUDDYAI_PRODUCT_CONFIG",
  "WORKBUDDYAI_CN_PRODUCT_CONFIG",
])
  delete process.env[key];

let fail = 0;
const check = (cond, msg) => {
  if (!cond) {
    console.log(`FAIL: ${msg}`);
    fail++;
  }
};

// --- no-auth pass: neither region logged in -------------------------------
// Both integration points share one process, but v2 no longer has a single
// shared config hook that can stay silent: each region registers its OWN
// provider and exposes exactly the offline placeholder until it logs in.
{
  process.env.WORKBUDDY_AUTH_FILE = "/nonexistent/workbuddy-test/no-such-file.info";
  delete process.env.WORKBUDDY_TOKEN;
  delete process.env.WORKBUDDY_CN_TOKEN;

  const seen = new Map();
  for (const region of ["intl", "cn"]) {
    const { ctx, state } = createV2Context({
      storeName: `workbuddy-test-nonexistent-${region}.json`,
    });
    await definePlugin(region).setup(ctx);
    const pid = region === "intl" ? "workbuddy" : "workbuddy-cn";
    const ids = state.providers.find((p) => p.info.id === pid)?.models.map((m) => m.id) ?? [];
    seen.set(region, ids);
  }
  check(seen.size === 2, "both regions must register their own provider");
  for (const [region, ids] of seen)
    check(
      ids.length === 1 && ids[0] === "workbuddy-offline",
      `${region}: unauthenticated provider must expose only the offline placeholder; got ${ids.join(",")}`,
    );
  console.log(
    `offline placeholders: ${[...seen].map(([region, ids]) => `${region}=${ids.join(",")}`).join(", ")}`,
  );
}

// With no auth, the placeholder model must reject with a login instruction.
{
  const { WorkBuddyLanguageModel } = await import("../dist/language-model.js");
  let threw;
  try {
    const lm = new WorkBuddyLanguageModel("workbuddy-offline", { providerID: "workbuddy" });
    await lm.doStream({ prompt: [], messages: [], mode: {}, inputFormat: "messages" });
  } catch (error) {
    threw = error;
  }
  check(
    threw &&
      /offline|logged in/i.test(String(threw.message)) &&
      /connect workbuddy/.test(String(threw.message)),
    `offline model should ask to /connect, got: ${threw?.message}`,
  );
}

// With both token envs present, each region is "authenticated" and must
// register its full per-region static table (see the offline gating above).
process.env.WORKBUDDY_TOKEN = "intl-test-token";
process.env.WORKBUDDY_CN_TOKEN = "cn-test-token";

const EXPECT = {
  intl: {
    region: "intl",
    pluginID: "opencode-workbuddy-connect",
    providerID: "workbuddy",
    name: "WorkBuddy AI",
    store: "workbuddy-auth.json",
    tool: ["workbuddy_account", "workbuddy_quota", "workbuddy_checkin"],
    // International is not pinned: WORKBUDDY_BASE_URL must still win.
    baseUrl: undefined,
    baseURL: "https://www.workbuddy.ai/v2",
  },
  cn: {
    region: "cn",
    pluginID: "opencode-workbuddy-connect-cn",
    providerID: "workbuddy-cn",
    name: "WorkBuddy AI (CN)",
    store: "workbuddy-cn-auth.json",
    tool: ["workbuddy_cn_account", "workbuddy_cn_quota", "workbuddy_cn_checkin"],
    baseUrl: "https://www.workbuddy.cn",
    baseURL: "https://www.workbuddy.cn/v2",
  },
};

for (const [region, want] of Object.entries(EXPECT)) {
  console.log(`\n--- ${region} ---`);
  const plugin = definePlugin(region);
  check(plugin.id === want.pluginID, `plugin id ${plugin.id} != ${want.pluginID}`);
  check(typeof plugin.setup === "function", "plugin.setup missing");

  const { ctx, state } = createV2Context({});
  await plugin.setup(ctx);

  // One integration point must never register under the other's id.
  const registered = state.providers.map((p) => p.info.id);
  check(
    registered.length === 1 && registered[0] === want.providerID,
    `providers registered: ${registered.join(",")}`,
  );
  const p = state.providers[0];
  check(!!p, "provider not registered");
  check(p.info.name === want.name, `provider name ${p.info.name} != ${want.name}`);
  check(
    p.info.settings.baseURL === want.baseURL,
    `settings.baseURL ${p.info.settings.baseURL} != ${want.baseURL}`,
  );

  // The integration owns the auth methods; v2 binds one integration per region.
  check(
    state.integrations.get(want.providerID)?.name === want.name,
    `integration ${want.providerID} name mismatch`,
  );

  // storeName / baseUrl / providerID now live in the language hook closure, so
  // fire the hook and inspect the model it installs on the event.
  const lm = await runLanguageHook(state, want.providerID);
  const popts = lm.providerOptions;
  check(popts.providerID === want.providerID, `hook providerID ${popts.providerID}`);
  check(popts.storeName === want.store, `hook storeName ${popts.storeName} != ${want.store}`);
  check(popts.baseUrl === want.baseUrl, `hook baseUrl ${popts.baseUrl} != ${want.baseUrl}`);

  const models = p.models;
  console.log(
    `provider=${p.info.name} models=${models.length} store=${popts.storeName} base=${p.info.settings.baseURL}`,
  );
  for (const m of models)
    check(m.limit?.context && m.limit.context === m.limit.input, `limit ${m.name}`);
  const flash = models.find(
    (m) => m.id === (want.region === "intl" ? "deepseek-v4.1-flash" : "deepseek-v4-flash"),
  );
  check(flash?.limit?.context === 1_000_000, "deepseek flash ctx not 1M");
  check(
    flash?.variants?.some((v) => v.id === "max" && v.body?.reasoningEffort === "max"),
    "effort variants missing",
  );

  // Each integration point must offer ITS OWN catalogue. This is the guard
  // against the old single union table, which sold CN users `gpt-6-astra` --
  // an international id the CN endpoint has never listed.
  const staticIds = new Set(modelTable(want.region).map((m) => m.id));
  check(
    models.length === staticIds.size,
    `registered ${models.length} != static ${staticIds.size}`,
  );
  for (const m of models)
    check(staticIds.has(m.id), `model ${m.id} not in the ${want.region} table`);
  check(staticIds.has("hy3"), `${want.region} table lost hy3 (the subagent pin)`);
  check(
    staticIds.has("gpt-6-astra") === (want.region === "intl"),
    `gpt-6-astra must be intl-only, seen on ${want.region}`,
  );

  // Default model is opt-in via ctx.options.setDefault in v2; it was not asked for.
  check(state.defaultModel === undefined, "setDefault not requested but a default was set");

  const methods = state.methods
    .filter((m) => m.integrationID === want.providerID)
    .map((m) => m.method);
  check(
    methods.some((m) => m.type === "key") && methods.some((m) => m.type === "oauth"),
    `auth methods ${methods.map((m) => m.type)}`,
  );
  const oauth = methods.find((m) => m.type === "oauth");
  check(oauth.label.includes(want.name), `oauth label "${oauth.label}" lacks ${want.name}`);
  console.log(`auth: ${methods.map((m) => m.type).join(",")} / ${oauth.label}`);

  const tools = state.tools.map((t) => t.name);
  check(tools.join() === want.tool.join(), `tools ${tools} != ${want.tool.join()}`);
  console.log(`tools: ${tools.join(",")}`);

  // Options passed through the v2 context still override the region defaults.
  const overridden = createV2Context({
    baseUrl: "https://gateway.example.test",
    storeName: "x.json",
  });
  await definePlugin(region).setup(overridden.ctx);
  const op = (await runLanguageHook(overridden.state, want.providerID)).providerOptions;
  check(
    op.baseUrl === "https://gateway.example.test",
    `option override baseUrl lost: ${op.baseUrl}`,
  );
  check(op.storeName === "x.json", `option override store lost: ${op.storeName}`);
  const opProvider = overridden.state.providers.find((p) => p.info.id === want.providerID);
  check(
    opProvider.info.settings.baseURL === "https://gateway.example.test/v2",
    `baseURL not derived from override: ${opProvider.info.settings.baseURL}`,
  );
}

console.log(
  `\ndefault export = intl: ${JSON.stringify((await import("../dist/index.js")).default.id)}`,
);

if (fail) {
  console.log(`FAIL x${fail}`);
  process.exit(1);
}
console.log("PASS");
