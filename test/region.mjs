// Shared region selection for the network-backed smoke tests.
//
// Mirrors what `definePlugin(region)` bakes into each integration point: the CN
// access point pins its own store file *and* a base URL, while the international
// one deliberately leaves `baseUrl` unpinned so `WORKBUDDY_BASE_URL` still works
// as an escape hatch. Passing these options is what lets `test/live.mjs` and
// `test/tools.mjs` exercise a specific access point instead of always defaulting
// to international.
import {
  CN_STORE_NAME,
  INTL_STORE_NAME,
  PROVIDER_ID,
  PROVIDER_ID_CN,
  WORKBUDDY_CN_BASE,
} from "../dist/constants.js";

export const REGION_CHOICES = ["intl", "cn", "workbuddy", "workbuddy-cn"];

/**
 * Turn a region name into the provider options the plugin would use for it.
 * Source precedence: explicit argument, then `WORKBUDDY_REGION`, then `intl`.
 */
export function regionOptions(raw = process.env.WORKBUDDY_REGION || "intl") {
  const key = String(raw).trim().toLowerCase();
  if (key === "cn" || key === "workbuddy-cn") {
    return { providerID: PROVIDER_ID_CN, storeName: CN_STORE_NAME, baseUrl: WORKBUDDY_CN_BASE };
  }
  if (key === "" || key === "intl" || key === "workbuddy") {
    return { providerID: PROVIDER_ID, storeName: INTL_STORE_NAME };
  }
  console.error(`unknown region "${raw}" -- expected one of: ${REGION_CHOICES.join(", ")}`);
  process.exit(2);
}

/** Human-readable identity for the chosen access point. */
export function describeRegion(options) {
  return `${options.providerID} (store=${options.storeName}, base=${options.baseUrl ?? "default/env"})`;
}
