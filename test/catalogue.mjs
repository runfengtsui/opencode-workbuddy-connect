// Offline catalogue-layer test: parses a captured endpoint shape, verifies the
// region split and the merge rules, and exercises the cache fallback ladder.
//
// No network, no real credentials: XDG_* point at a throwaway dir, so the CN
// store on this machine cannot leak in and make the failure path unreachable.
// Run: node test/catalogue.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "wb-cat-"));
process.env.XDG_CONFIG_HOME = join(sandbox, "config");
process.env.XDG_CACHE_HOME = join(sandbox, "cache");
delete process.env.WORKBUDDY_TOKEN;
delete process.env.WORKBUDDY_UID;
delete process.env.WORKBUDDY_CN_TOKEN;
delete process.env.WORKBUDDY_CN_UID;
delete process.env.WORKBUDDY_BASE_URL;
delete process.env.WORKBUDDY_MODEL_FIXTURE;
delete process.env.WORKBUDDY_DISABLE_MODEL_DISCOVERY;

const {
  applyCatalogue,
  bundledModels,
  defaultModelID,
  getModelDefinition,
  isFreeModel,
  modelTable,
  normalizeCredits,
  parseProductModel,
  resetModelTablesForTests,
  staticModels,
} = await import("../dist/models.js");
const {
  CACHE_VERSION,
  catalogueCachePath,
  catalogueStatus,
  catalogueURL,
  parseCataloguePayload,
  refreshModelCatalogue,
} = await import("../dist/catalogue.js");
const { CN_STORE_NAME, INTL_STORE_NAME, modelCataloguePaths, PROVIDER_ID, PROVIDER_ID_CN } =
  await import("../dist/constants.js");

let fail = 0;
const check = (cond, msg) => {
  if (!cond) {
    console.log(`FAIL: ${msg}`);
    fail++;
  } else console.log(`  ok  ${msg}`);
};
const section = (title) => console.log(`\n--- ${title} ---`);

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "wb-cn-models.json"), "utf8"),
);
const writeCache = (file, payload) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(payload));
};

// ---------------------------------------------------------------------------
section("payload parsing");
{
  const rows = parseCataloguePayload(fixture);
  check(
    rows.length === 5,
    `expected 5 usable rows, got ${rows.length} (hunyuan-image-v3.0 has no token budget)`,
  );
  check(
    !rows.some((r) => r.model.id === "hunyuan-image-v3.0"),
    "a text-to-image model must not be registered",
  );

  const hy3 = rows.find((r) => r.model.id === "hy3");
  check(
    hy3?.model.credits === "x0.00",
    `credits normalised from "x0.00 credits" -> ${hy3?.model.credits}`,
  );
  check(isFreeModel(hy3.model), 'hy3 ("x0.00 credits") detected as free');
  check(hy3.effortsAdvertised === false, "hy3 has no supportedEfforts -> not advertised");
  check(
    JSON.stringify(hy3.model.efforts) === JSON.stringify(["low", "medium", "high", "xhigh", "max"]),
    `unadvertised row parses to the inferred ladder (${hy3.model.efforts.join(",")})`,
  );

  const glm = rows.find((r) => r.model.id === "glm-5.3");
  check(glm?.effortsAdvertised === true, "glm-5.3 advertises its ladder");
  check(
    glm?.model.efforts.join(",") === "low,high,max",
    `advertised ladder kept (${glm?.model.efforts.join(",")})`,
  );

  const dsv4 = rows.find((r) => r.model.id === "deepseek-v4-flash");
  check(
    dsv4?.model.credits === "x0.17",
    `bare "x0.17" survives unchanged (${dsv4?.model.credits})`,
  );
  check(dsv4?.model.contextWindow === 1_000_000, "1M budget read from maxInputTokens");
}

check(
  normalizeCredits("  x0.79 credits ") === "x0.79",
  "normalizeCredits trims and strips the suffix",
);
check(normalizeCredits("x0.79 Credits") === "x0.79", "suffix match is case-insensitive");
check(normalizeCredits(undefined) === undefined, "absent credits stays absent");
check(
  parseProductModel({ id: "nope", maxInputTokens: 100 }) === undefined,
  "a row without output budget drops",
);

// ---------------------------------------------------------------------------
section("region isolation");
{
  resetModelTablesForTests();
  const intl = bundledModels("intl").map((m) => m.id);
  const cn = bundledModels("cn").map((m) => m.id);
  check(intl.includes("gpt-6-astra"), "gpt-6-astra belongs to the international table");
  check(
    !cn.includes("gpt-6-astra"),
    "gpt-6-astra is absent from the CN table (endpoint never lists it)",
  );
  check(
    cn.includes("glm-5.3") && cn.includes("kimi-k2.6"),
    "CN table carries the models CN actually sells",
  );
  check(
    getModelDefinition("gpt-6-astra", "cn") === undefined,
    "an intl-only id does not resolve on CN",
  );
  check(!!getModelDefinition("gpt-6-astra", "intl"), "the same id resolves on intl");
  check(
    getModelDefinition("hunyuan-2.0-thinking", "intl") === undefined,
    "a CN-only id does not resolve on intl",
  );
  const hy4 = getModelDefinition("hy4-preview", "intl");
  check(
    hy4?.credits === "x0.29",
    `intl hy4-preview is billed x0.29, not the stale "x0.00" (${hy4?.credits})`,
  );
  const kimi = getModelDefinition("kimi-k2.5", "cn");
  check(
    kimi?.contextWindow === 164_000,
    `CN kimi-k2.5 at its true 164k window (was over-stated at 256k)`,
  );
}

// ---------------------------------------------------------------------------
section("merge rules");
{
  resetModelTablesForTests();
  const rows = parseCataloguePayload(fixture);
  const table = applyCatalogue("cn", rows);
  check(table.length === rows.length, `catalogue is authoritative for ids (${table.length})`);
  check(!table.some((m) => m.id === "kimi-k2.5"), "an id the catalogue omits stops being offered");
  check(
    table.some((m) => m.id === "brand-new-model"),
    "a new id is offered",
  );
  check(
    table.find((m) => m.id === "hy3")?.efforts.join(",") === "low,high",
    "unadvertised ladder falls back to the static table, not the inferred 5 levels",
  );
  check(
    table.find((m) => m.id === "glm-5.3")?.efforts.join(",") === "low,high,max",
    "advertised ladder wins",
  );
  check(
    table.find((m) => m.id === "deepseek-v4-flash")?.maxTokens === 50_000,
    "numbers come from the catalogue",
  );
  check(defaultModelID("cn") === "hy3", "the subagent pin survives a catalogue refresh");
  check(modelTable("cn").length === table.length, "the adopted catalogue is what requests read");
  check(
    modelTable("intl").length === staticModels("intl").length,
    "adopting for CN left intl untouched",
  );

  // An implausibly short list is transport noise, not a product decision.
  const before = modelTable("cn").length;
  const truncated = applyCatalogue("cn", rows.slice(0, 2));
  check(
    truncated.length === before,
    `a 2-row catalogue was rejected, keeping the ${truncated.length} in force`,
  );
  check(
    modelTable("cn").length === before,
    "the rejection did not fork registration away from id lookup",
  );
  check(
    applyCatalogue("cn", rows).length === rows.length,
    "a plausible catalogue is adopted again after the rejection",
  );

  // Hidden models from the static table survive live catalogue replacement.
  resetModelTablesForTests();
  const intlRows = parseCataloguePayload(fixture).filter((r) => r.model.id !== "hy4-preview-f");
  const intlTable = applyCatalogue("intl", intlRows);
  check(
    intlTable.some((m) => m.id === "hy4-preview-f" && m.hidden),
    "hy4-preview-f is preserved via the hidden flag when the live catalogue omits it",
  );
  check(
    intlTable.filter((m) => m.id === "hy4-preview-f").length === 1,
    "hidden model appears exactly once (no duplicates)",
  );
  // But if the live catalogue DOES include it, the hidden flag is not duplicated.
  const withF = [...intlRows, { model: getModelDefinition("hy4-preview-f", "intl"), effortsAdvertised: true }];
  const intlTableWithF = applyCatalogue("intl", withF);
  check(
    intlTableWithF.filter((m) => m.id === "hy4-preview-f").length === 1,
    "no duplicate when the live catalogue also includes the hidden id",
  );
}

// ---------------------------------------------------------------------------
section("fallback ladder");
{
  resetModelTablesForTests();
  const cache = catalogueCachePath("cn");
  check(cache.includes(join(sandbox, "cache")), `cache is sandboxed (${cache})`);
  check(catalogueCachePath("intl") !== cache, "intl and CN get separate cache files");
  check(
    catalogueURL("https://www.workbuddy.cn/", "cn") ===
      "https://www.workbuddy.cn/console/enterprises/personal/models",
    "CN discovery hits /console on the credential's own base",
  );
  // International leads with /v3/config (the desktop client's own product
  // config); /v2 is stale and narrower, so it is only a fallback probe.
  check(
    catalogueURL("https://www.workbuddy.ai", "intl") === "https://www.workbuddy.ai/v3/config",
    "intl discovery leads with /v3/config",
  );
  check(
    modelCataloguePaths("intl").join(",") ===
      "/v3/config,/v2/enterprises/personal/models,/console/enterprises/personal/models",
    "intl falls back to /v2 then /console",
  );
  check(
    modelCataloguePaths("cn").join(",") === "/console/enterprises/personal/models,/v3/config",
    "CN leads with /console and falls back to /v3/config",
  );

  // 1. discovery off -> static, nothing read.
  process.env.WORKBUDDY_DISABLE_MODEL_DISCOVERY = "1";
  let models = await refreshModelCatalogue("cn", {
    providerID: PROVIDER_ID_CN,
    storeName: CN_STORE_NAME,
  });
  check(models.length === staticModels("cn").length, "discovery disabled: static table");
  delete process.env.WORKBUDDY_DISABLE_MODEL_DISCOVERY;

  // 2. fresh cache -> served without touching the network (no creds exist here).
  const rows = parseCataloguePayload(fixture);
  writeCache(cache, { version: CACHE_VERSION, fetchedAt: Date.now(), models: rows });
  resetModelTablesForTests();
  models = await refreshModelCatalogue("cn", {
    providerID: PROVIDER_ID_CN,
    storeName: CN_STORE_NAME,
  });
  check(
    models.some((m) => m.id === "brand-new-model"),
    "fresh disk cache is applied",
  );

  // 3. stale cache + unreachable endpoint -> the stale rows still beat the bundle.
  writeCache(cache, { version: CACHE_VERSION, fetchedAt: Date.now() - 86_400_000, models: rows });
  resetModelTablesForTests();
  models = await refreshModelCatalogue("cn", {
    providerID: PROVIDER_ID_CN,
    storeName: CN_STORE_NAME,
  });
  check(
    models.some((m) => m.id === "brand-new-model"),
    "stale cache still serves when the fetch fails",
  );

  // 4. no cache at all, no credentials -> static, and the failure is recorded
  //    against THIS region only.
  writeCache(cache, { version: CACHE_VERSION, fetchedAt: 0, failedAt: 0, models: [] });
  resetModelTablesForTests();
  const intlBefore = modelTable("intl").length;
  models = await refreshModelCatalogue("cn", {
    providerID: PROVIDER_ID_CN,
    storeName: CN_STORE_NAME,
  });
  check(models.length === staticModels("cn").length, "empty cache + no credentials: static table");
  check(
    modelTable("intl").length === intlBefore,
    "a CN failure never degrades the international table",
  );
  const written = JSON.parse(readFileSync(cache, "utf8"));
  check(
    Number.isFinite(written.failedAt) && written.failedAt > 0,
    "the failure stamped an error-TTL marker",
  );
  check(written.fetchedAt === 0, "the failure kept the older success timestamp");
}

// ---------------------------------------------------------------------------
section("cache path override");
{
  resetModelTablesForTests();
  delete process.env.WORKBUDDY_DISABLE_MODEL_DISCOVERY;
  delete process.env.WORKBUDDY_MODEL_FIXTURE;

  // An exact file path is honoured verbatim (single-instance debugging).
  const exact = join(sandbox, "cache", "pinned.json");
  process.env.WORKBUDDY_MODEL_DISK_CACHE = exact;
  check(catalogueCachePath("cn") === exact, "exact path honoured verbatim");
  check(catalogueCachePath("intl") === exact, "exact path is shared -- the documented caveat");

  // A trailing separator means "directory": each region keeps its own file, so
  // loading both access points can never let one serve the other's model list.
  const dir = join(sandbox, "cache", "relocated");
  mkdirSync(dir, { recursive: true });
  process.env.WORKBUDDY_MODEL_DISK_CACHE = `${dir}${process.platform === "win32" ? "\\" : "/"}`;
  const cnInDir = catalogueCachePath("cn");
  const intlInDir = catalogueCachePath("intl");
  check(cnInDir.startsWith(dir), `trailing separator treated as a directory (${cnInDir})`);
  check(cnInDir !== intlInDir, "relocated cache still isolates the two regions");
  check(
    cnInDir.endsWith("opencode-workbuddy-cn-models.json"),
    "CN keeps its region-tagged filename inside the directory",
  );

  // An existing directory is detected without a separator.
  process.env.WORKBUDDY_MODEL_DISK_CACHE = dir;
  check(catalogueCachePath("cn") === cnInDir, "an existing directory is detected as such");

  // Writer and reader must agree: a fresh cache at the resolved path is served
  // without touching the network (no credentials exist in this sandbox).
  const rows = parseCataloguePayload(fixture);
  writeCache(cnInDir, { version: CACHE_VERSION, fetchedAt: Date.now(), models: rows });
  const served = await refreshModelCatalogue("cn", {
    providerID: PROVIDER_ID_CN,
    storeName: CN_STORE_NAME,
    baseUrl: "https://www.workbuddy.cn",
  });
  check(
    catalogueStatus("cn").source === "cache" && served.some((m) => m.id === "brand-new-model"),
    "the relocated cache is the one actually read back",
  );

  delete process.env.WORKBUDDY_MODEL_DISK_CACHE;
  resetModelTablesForTests();
}

// ---------------------------------------------------------------------------
section("fixture override");
{
  resetModelTablesForTests();
  process.env.WORKBUDDY_MODEL_FIXTURE = join(import.meta.dirname, "fixtures", "wb-cn-models.json");
  const models = await refreshModelCatalogue("intl", {
    providerID: PROVIDER_ID,
    storeName: INTL_STORE_NAME,
  });
  check(
    models.some((m) => m.id === "brand-new-model"),
    "fixture replaces the network for a region without creds",
  );
  delete process.env.WORKBUDDY_MODEL_FIXTURE;
  resetModelTablesForTests();
}

if (fail) {
  console.log(`\nFAIL x${fail}`);
  process.exit(1);
}
console.log("\nPASS");
