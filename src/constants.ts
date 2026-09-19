export const PROVIDER_ID = "workbuddy";
export const PROVIDER_ID_CN = "workbuddy-cn";
export const PROVIDER_NAME = "WorkBuddy AI";

export const WORKBUDDY_INTL_BASE = "https://www.workbuddy.ai";
export const WORKBUDDY_CN_BASE = "https://www.workbuddy.cn";
export const USER_AGENT = "CLI/2.63.2 CodeBuddy/2.63.2";

// Own-credential-store file names (under $XDG_CONFIG_HOME/opencode). One per
// integration point so a CN login never clobbers an international login.
export const INTL_STORE_NAME = "workbuddy-auth.json";
export const CN_STORE_NAME = "workbuddy-cn-auth.json";

export const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
export const WORKBUDDY_BASE_URL_ENV = "WORKBUDDY_BASE_URL";
// Which integration point a shared desktop auth file belongs to. Only an
// override: the store file name already decides it (see auth.ts).
export const WORKBUDDY_REGION_ENV = "WORKBUDDY_REGION";
// One token env per integration point. `WORKBUDDY_TOKEN` used to be read by
// BOTH regions, which meant a CN token also lit up the international provider
// -- whose endpoint then answered 401 ("credentials lost") because the token is
// not valid there. CN now reads its own variable and nothing else.
export const WORKBUDDY_TOKEN_ENV = "WORKBUDDY_TOKEN";
export const WORKBUDDY_UID_ENV = "WORKBUDDY_UID";
export const WORKBUDDY_CN_TOKEN_ENV = "WORKBUDDY_CN_TOKEN";
export const WORKBUDDY_CN_UID_ENV = "WORKBUDDY_CN_UID";

export const AUTH_FILE_CANDIDATES = [
  "workbuddy-desktop-ai.info",
  "workbuddy-desktop.info",
] as const;

// Where the desktop app keeps its own cache. Both names are honoured by the
// client (the CN build and the dedicated-cloud build use different folders),
// so a reader must try every candidate rather than assume one.
export const WORKBUDDY_CONFIG_DIR_ENV = "WORKBUDDY_CONFIG_DIR";
export const CODEBUDDY_CONFIG_DIR_ENV = "CODEBUDDY_CONFIG_DIR";
export const DESKTOP_CONFIG_FOLDERS = [".workbuddy-ai", ".workbuddy"] as const;
/** Desktop product-config cache, relative to the desktop config dir. */
export const PRODUCT_CONFIG_FILE = ["cache", "acc-product-config-v3.json"] as const;

// --- live model catalogue ---------------------------------------------------

/**
 * The WorkBuddy console model-list endpoint (per region, same-origin with the
 * credential). Verified live against CN. Upstream is known to answer 500 for
 * some international accounts, so this is an optimisation, never a dependency:
 * every failure path falls back to the static table.
 */
export const MODEL_CATALOGUE_PATH = "/console/enterprises/personal/models";

/**
 * The desktop client's own product config. This is the list the official
 * clients render in their model pickers, and the credits it carries are the
 * rates the gateway actually bills -- verified live against BOTH regions
 * (2026-09). It is the primary source for international and a fallback for CN.
 */
export const MODEL_CATALOGUE_PATH_V3 = "/v3/config";

/**
 * Legacy international model-list path. Reference gateway implementations
 * report `/v2/...` answers 200, and it does -- but its model set is stale and
 * narrower (18 entries, no DeepSeek variants, and credits that go out of date:
 * it advertises `hy4-preview` as `x0.00` while `/v3/config` and the gateway
 * bill `x0.29`). Kept only as a fallback probe before the static table.
 */
export const MODEL_CATALOGUE_PATH_INTL = "/v2/enterprises/personal/models";

/** Candidate catalogue paths per region, in probe order. */
export function modelCataloguePaths(region: WBRegion): readonly string[] {
  return region === "intl"
    ? ([MODEL_CATALOGUE_PATH_V3, MODEL_CATALOGUE_PATH_INTL, MODEL_CATALOGUE_PATH] as const)
    : ([MODEL_CATALOGUE_PATH, MODEL_CATALOGUE_PATH_V3] as const);
}

// --- billing (quota + daily check-in) ---------------------------------------

/**
 * Credit balance endpoint. Same-origin with the credential, unlike chat it
 * answers with a double-wrapped envelope (`data.Response.Data.Accounts`).
 * Each row is one GRANT INSTANCE, not one package: the same `PackageCode`
 * appears repeatedly (daily check-ins each grant a fresh instance) with its
 * own expiry, which is why "soonest expiring" is worth surfacing.
 */
export const BILLING_RESOURCE_PATH = "/v2/billing/meter/get-user-resource";

/**
 * Claims today's check-in credit grant. It is a MUTATION, so the plugin only
 * fires it from an explicit tool call, never on startup.
 */
export const BILLING_CHECKIN_PATH = "/v2/billing/meter/daily-checkin";

/**
 * Campaign kill-switch. The daily check-in is a MUTATION against an endpoint
 * that may disappear (campaign ends), change shape, or start rate-limiting.
 * When set, the check-in tool short-circuits BEFORE resolving credentials
 * (resolving can refresh + persist a token), so a disabled check-in makes zero
 * network calls and cannot disturb the chat path.
 */
export const CHECKIN_DISABLE_ENV = "WORKBUDDY_DISABLE_CHECKIN";

/** Umbrella switch: disables balance *and* check-in together. */
export const BILLING_DISABLE_ENV = "WORKBUDDY_DISABLE_BILLING";

/** Business code meaning "already checked in today" -- success-shaped, not a fault. */
export const CHECKIN_ALREADY_CODE = 10001;
/** Mirror of the reference client's hour-long catalogue TTL. */
export const MODEL_CATALOGUE_TTL_MS = 60 * 60 * 1000;
/** Failures retry sooner -- a transient 500 must not cost an hour. */
export const MODEL_CATALOGUE_ERROR_TTL_MS = 60 * 1000;
/** Disk-cache TTL override / kill switch. */
export const MODEL_CATALOGUE_TTL_ENV = "WORKBUDDY_MODEL_CACHE_SECONDS";
export const MODEL_CATALOGUE_DISABLE_ENV = "WORKBUDDY_DISABLE_MODEL_DISCOVERY";
export const MODEL_CATALOGUE_CACHE_ENV = "WORKBUDDY_MODEL_DISK_CACHE";
/** A raw snapshot on disk replaces the network call; used by the tests. */
export const MODEL_CATALOGUE_FIXTURE_ENV = "WORKBUDDY_MODEL_FIXTURE";

export const REFRESH_SKEW_MS = 5 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 15 * 1000;
export const LOGIN_POLL_TIMEOUT_MS = 15 * 60 * 1000;

/** Which integration point a conversation is on. Drives every per-region table. */
export type WBRegion = "intl" | "cn";

export function regionOfProvider(providerID: string | undefined): WBRegion {
  return providerID === PROVIDER_ID_CN ? "cn" : "intl";
}

/** Per-region model-list cache file name, under the opencode cache dir. */
export function modelCacheName(region: WBRegion): string {
  return region === "cn" ? "opencode-workbuddy-cn-models.json" : "opencode-workbuddy-models.json";
}

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

// Models that are known to loop on reasoning when given a big enough budget
// ("OK / Let me write / Go."). Cap their max_tokens so the budget can't be
// burned by the loop. Reference: pi-workbuddy-connect FLASH_MAX_TOKENS.
const FLASH_MAX_TOKENS = 16_384;
const FLASH_LOOP_IDS: ReadonlySet<string> = new Set(["deepseek-v4.1-flash", "deepseek-v4-flash"]);

export function flashMaxTokensCap(modelID: string, requested: number): number {
  if (!FLASH_LOOP_IDS.has(modelID)) return requested;
  return Math.min(requested, FLASH_MAX_TOKENS);
}
