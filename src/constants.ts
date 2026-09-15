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
export const WORKBUDDY_TOKEN_ENV = "WORKBUDDY_TOKEN";
export const WORKBUDDY_UID_ENV = "WORKBUDDY_UID";

export const AUTH_FILE_CANDIDATES = ["workbuddy-desktop-ai.info", "workbuddy-desktop.info"] as const;

export const REFRESH_SKEW_MS = 5 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 15 * 1000;
export const LOGIN_POLL_TIMEOUT_MS = 15 * 60 * 1000;

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

// Models that are known to loop on reasoning when given a big enough budget
// ("OK / Let me write / Go."). Cap their max_tokens so the budget can't be
// burned by the loop. Reference: pi-workbuddy-connect FLASH_MAX_TOKENS.
const FLASH_MAX_TOKENS = 16_384;
const FLASH_LOOP_IDS: ReadonlySet<string> = new Set([
  "deepseek-v4.1-flash",
  "deepseek-v4-flash",
]);

export function flashMaxTokensCap(modelID: string, requested: number): number {
  if (!FLASH_LOOP_IDS.has(modelID)) return requested;
  return Math.min(requested, FLASH_MAX_TOKENS);
}
