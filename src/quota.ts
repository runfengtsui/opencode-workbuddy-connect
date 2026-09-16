import {
  chatHeaders,
  resolveWorkBuddyCredentials,
  type WorkBuddyCredentials,
  type WorkBuddyProviderOptions,
} from "./auth.js";
import {
  BILLING_CHECKIN_PATH,
  BILLING_DISABLE_ENV,
  BILLING_RESOURCE_PATH,
  CHECKIN_ALREADY_CODE,
  CHECKIN_DISABLE_ENV,
  type WBRegion,
} from "./constants.js";
import { envBool } from "./env-helpers.js";
import { errorMessage, logPlugin, logWarn } from "./log.js";

/**
 * Account credit balance and the daily check-in, mirroring the reference
 * gateway's `UserResourceDetail` / `DailyCheckin`.
 *
 * Like model discovery, this is account *information*, never authentication:
 * every failure path here returns a report marked `ok: false` and cannot touch
 * a credential. The balance endpoint is same-origin with the credential but
 * wraps its payload one level deeper than chat (`data.Response.Data.Accounts`),
 * so it gets its own envelope reader rather than reusing the catalogue one.
 */

const BILLING_TIMEOUT_MS = 8_000;

/** One credit grant. Rows share a `PackageCode` when the same package was top
 *  up repeatedly (daily check-ins each mint a fresh instance with its own cycle). */
export type QuotaPackage = {
  code: string;
  name: string;
  unit: string;
  /** Credits still spendable in the current cycle. */
  remain: number;
  /** Cycle capacity the instance was minted with. */
  total: number;
  used: number;
  /** 0 = active, 3 = exhausted/finished (observed); kept raw for display. */
  status: number;
  /** When this instance's credits stop being spendable; 0 = unknown. */
  expiresAtMs: number;
};

export type QuotaReport = {
  ok: boolean;
  region: WBRegion;
  base: string;
  /** Total spendable credits across every active instance. */
  totalRemain: number;
  /** Total capacity granted across every instance (active + spent). */
  totalCapacity: number;
  packages: QuotaPackage[];
  /** Earliest expiry among instances that still hold credits; 0 = none. */
  soonestExpiryMs: number;
  /** Gateway's own aggregate, when it sent one -- cross-checks totalRemain. */
  reportedTotal?: number;
  error?: string;
  /** True when a kill-switch env, not a network fault, stopped the call. */
  disabled?: boolean;
};

export type CheckinResult = {
  /**
   * "claimed" today's grant was minted, "already" nothing to claim, "failed"
   * (endpoint refused/unreachable), "disabled" (kill-switch env, no call made).
   */
  status: "claimed" | "already" | "failed" | "disabled";
  region: WBRegion;
  message: string;
};

/**
 * Kill-switch state. Checked BEFORE any credential resolution: resolving can
 * refresh + persist a token, and a disabled campaign must trigger none of that.
 * Returns the env var to blame, or undefined when the call may proceed.
 */
function billingDisabledBy(): string | undefined {
  if (envBool(BILLING_DISABLE_ENV)) return BILLING_DISABLE_ENV;
  return undefined;
}

function checkinDisabledBy(): string | undefined {
  return billingDisabledBy() ?? (envBool(CHECKIN_DISABLE_ENV) ? CHECKIN_DISABLE_ENV : undefined);
}

function disabledNotice(env: string): string {
  return `Disabled by ${env}=1. Unset that variable to re-enable.`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

/**
 * Expiry arrives in three shapes across regions and package types: epoch
 * millis (number), epoch seconds, or a `"2026-09-30 23:59:59"` / ISO string.
 * Accept them all; anything else is "unknown" rather than a crash.
 */
export function parseExpiryMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim() !== "") {
    // "2026-09-30 23:59:59" is not spec-parsable everywhere; normalise the space.
    const iso = value.trim().replace(" ", "T");
    const ms = Date.parse(iso.endsWith("Z") || /[+-]\d\d:\d\d$/u.test(iso) ? iso : `${iso}Z`);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

function billingHeaders(
  cred: WorkBuddyCredentials,
  options: WorkBuddyProviderOptions,
): Record<string, string> {
  const headers = chatHeaders(cred, options);
  headers["Content-Type"] = "application/json";
  if (cred.enterpriseId) headers["X-Tenant-Id"] = cred.enterpriseId;
  return headers;
}

/** Sends one billing request; throws on transport/HTTP errors (callers wrap). */
async function postBilling(
  cred: WorkBuddyCredentials,
  options: WorkBuddyProviderOptions,
  path: string,
  body: Record<string, unknown>,
): Promise<{
  status: number;
  code: number;
  msg: string;
  data: Record<string, unknown>;
  base: string;
}> {
  const base = cred.domain ? `https://${cred.domain}` : "";
  if (!base) throw new Error("no base URL for this region");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: billingHeaders(cred, options),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
  });
  const payload = asRecord(await response.json().catch(() => undefined)) ?? {};
  const data = asRecord(payload.data) ?? {};
  // The gateway ALWAYS answers with a numeric business `code`, on success and
  // on failure alike. No code therefore means "this is not the gateway":
  // an HTML login wall, a proxy page, a changed endpoint, a truncated body.
  // Treating that as code 0 would silently report a campaign mutation as
  // SUCCESS, which is the one outcome worse than a loud failure.
  const code = typeof payload.code === "number" ? payload.code : -1;
  return {
    status: response.status,
    code,
    msg:
      typeof payload.msg === "string"
        ? payload.msg
        : code === -1
          ? `HTTP ${response.status}: response carried no gateway business code`
          : "",
    data,
    base,
  };
}

/**
 * Read the account's credit balance. `Status` filtering is left to the gateway:
 * it returns active and finished instances together, and the exhausted ones
 * carry the history the "why is my balance lower than yesterday" question needs.
 */
export async function fetchQuota(
  region: WBRegion,
  options: WorkBuddyProviderOptions = {},
): Promise<QuotaReport> {
  const empty: QuotaReport = {
    ok: false,
    region,
    base: "",
    totalRemain: 0,
    totalCapacity: 0,
    packages: [],
    soonestExpiryMs: 0,
  };
  const env = billingDisabledBy();
  if (env) return { ...empty, disabled: true, error: disabledNotice(env) };
  try {
    const cred = await resolveWorkBuddyCredentials(options);
    empty.base = cred.domain ? `https://${cred.domain}` : "";
    const res = await postBilling(cred, options, BILLING_RESOURCE_PATH, {
      PageNumber: 1,
      PageSize: 100,
    });
    if (res.code !== 0) {
      const message = `code=${res.code} ${res.msg}`.trim();
      logWarn(`quota[${region}]: ${message}`);
      return { ...empty, ok: false, error: message };
    }
    // Double-wrapped: data.Response.Data.Accounts (the reference client's doJSON
    // already unwrapped `data`, so its reader starts one level higher).
    const inner = asRecord(asRecord(res.data?.Response)?.Data) ?? {};
    const accounts = Array.isArray(inner.Accounts) ? inner.Accounts : [];
    const packages: QuotaPackage[] = [];
    for (const entry of accounts) {
      const record = asRecord(entry);
      if (!record) continue;
      const total = numberField(record, "CycleCapacitySize", "CapacitySize");
      const remain = Math.max(0, numberField(record, "CycleCapacityRemain", "CapacityRemain"));
      const used = numberField(record, "CycleCapacityUsed", "CapacityUsed");
      const code = typeof record.PackageCode === "string" ? record.PackageCode : "";
      const name =
        typeof record.PackageName === "string" && record.PackageName ? record.PackageName : code;
      packages.push({
        code,
        name,
        unit: typeof record.CapacityUnit === "string" ? record.CapacityUnit : "credits",
        remain,
        total,
        used,
        status: numberField(record, "Status"),
        expiresAtMs:
          parseExpiryMs(record.DeductionEndTime) ||
          parseExpiryMs(record.ExpiredTime) ||
          parseExpiryMs(record.CycleEndTime),
      });
    }
    let totalRemain = 0;
    let totalCapacity = 0;
    let soonestExpiryMs = 0;
    for (const pkg of packages) {
      totalRemain += pkg.remain;
      totalCapacity += pkg.total;
      // Only instances that still hold credits represent real expiry pressure.
      if (pkg.remain > 0 && pkg.expiresAtMs > 0) {
        if (soonestExpiryMs === 0 || pkg.expiresAtMs < soonestExpiryMs)
          soonestExpiryMs = pkg.expiresAtMs;
      }
    }
    const reportedTotal = numberField(inner, "TotalDosage");
    const model = { ...empty, ok: true, packages, totalRemain, totalCapacity, soonestExpiryMs };
    logPlugin(`quota[${region}]: ${packages.length} packages, ${totalRemain} credits remaining`);
    return reportedTotal > 0 ? { ...model, reportedTotal } : model;
  } catch (error) {
    const message = errorMessage(error);
    logWarn(`quota[${region}]: unavailable (${message})`);
    return { ...empty, ok: false, error: message };
  }
}

/**
 * Claim today's check-in grant. Idempotent per day on the gateway side: a
 * second call answers business code {@link CHECKIN_ALREADY_CODE} ("already
 * checked in today"), which is a *result*, not a failure.
 */
export async function dailyCheckin(
  region: WBRegion,
  options: WorkBuddyProviderOptions = {},
): Promise<CheckinResult> {
  const env = checkinDisabledBy();
  if (env) return { status: "disabled", region, message: disabledNotice(env) };
  try {
    const cred = await resolveWorkBuddyCredentials(options);
    const res = await postBilling(cred, options, BILLING_CHECKIN_PATH, {});
    if (res.code === 0) {
      logPlugin(`checkin[${region}]: daily credits claimed`);
      return { status: "claimed", region, message: res.msg || "Daily check-in claimed." };
    }
    if (res.code === CHECKIN_ALREADY_CODE) {
      return { status: "already", region, message: res.msg || "Already checked in today." };
    }
    logWarn(`checkin[${region}]: code=${res.code} ${res.msg}`);
    return {
      status: "failed",
      region,
      message: `code=${res.code} ${res.msg || `HTTP ${res.status}`}`.trim(),
    };
  } catch (error) {
    const message = errorMessage(error);
    logWarn(`checkin[${region}]: failed (${message})`);
    return { status: "failed", region, message };
  }
}

/** Render a report for the agent tool. Puts expiring-soon credits first. */
export function formatQuota(report: QuotaReport): string {
  if (report.disabled) return `Balance reporting disabled: ${report.error ?? "no reason given"}`;
  if (!report.ok) return `Balance unavailable: ${report.error ?? "unknown error"}`;
  const lines: string[] = [];
  lines.push(`Account: ${report.base} (${report.region})`);
  lines.push(
    `Total left: ${report.totalRemain} credits (granted ${report.totalCapacity} this cycle)`,
  );
  if (report.reportedTotal !== undefined && report.reportedTotal !== report.totalRemain) {
    lines.push(`gateway reports total remaining: ${report.reportedTotal}`);
  }
  if (report.soonestExpiryMs > 0) {
    lines.push(`first expiry: ${new Date(report.soonestExpiryMs).toISOString()}`);
  }
  const sorted = [...report.packages].sort((a, b) => {
    if (a.remain > 0 && b.remain === 0) return -1;
    if (a.remain === 0 && b.remain > 0) return 1;
    if (a.expiresAtMs && b.expiresAtMs) return a.expiresAtMs - b.expiresAtMs;
    return a.expiresAtMs ? -1 : 1;
  });
  for (const pkg of sorted) {
    const expiry = pkg.expiresAtMs ? new Date(pkg.expiresAtMs).toISOString().slice(0, 10) : "n/a";
    const state = pkg.status !== 0 ? ` [status ${pkg.status}]` : "";
    lines.push(
      `  ${pkg.name}: ${pkg.remain}/${pkg.total} ${pkg.unit}  exp ${expiry}${state}  (${pkg.code})`,
    );
  }
  if (sorted.length === 0) lines.push("  (no packages reported)");
  return lines.join("\n");
}
