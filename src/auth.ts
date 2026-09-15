import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AUTH_FILE_CANDIDATES,
  REFRESH_SKEW_MS,
  USER_AGENT,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_BASE_URL_ENV,
  WORKBUDDY_INTL_BASE,
  WORKBUDDY_TOKEN_ENV,
  WORKBUDDY_UID_ENV,
} from "./constants.js";
import { readEnvSafe } from "./env-helpers.js";
import { errorMessage, logPlugin } from "./log.js";

export interface WorkBuddyCredentials {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry in ms epoch; 0 = unknown. */
  expiresAtMs: number;
  uid: string;
  domain: string;
  enterpriseId?: string;
  nickname?: string;
}

export interface WorkBuddyProviderOptions {
  /** A raw access token. Pair with `userID`; no exchange step. */
  apiKey?: string;
  userID?: string;
  /** Base URL override. Default derives from the credential's domain. */
  baseUrl?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Desktop auth files answer expiresAt in ms; the plugin-token answers in
// relative seconds. Values above 1e12 are already ms.
function expiryToMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1e12 ? value : value * 1000;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parses the WorkBuddy desktop / plugin auth document:
 *   { account: { uid, nickname, enterpriseId? }, auth: { accessToken,
 *   refreshToken, expiresAt, domain } }
 * A flat document (no `auth` wrapper) is also accepted.
 */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const document = asRecord(parsed);
  if (!document) return undefined;
  const nested = asRecord(document.auth);
  const auth = nested ?? document;
  const identity = nested ? (asRecord(document.account) ?? document) : document;
  const accessToken = typeof auth.accessToken === "string" ? auth.accessToken : "";
  if (accessToken === "") return undefined;
  const enterpriseId = optionalString(identity.enterpriseId) ?? optionalString(auth.enterpriseId);
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
    expiresAtMs:
      typeof auth.expiresAt === "number"
        ? expiryToMs(auth.expiresAt)
        : typeof auth.expiresIn === "number" && auth.expiresIn > 0
          ? Date.now() + auth.expiresIn * 1000
          : 0,
    uid: optionalString(identity.uid) ?? optionalString(identity.uin) ?? uidFromJwt(accessToken) ?? "",
    domain: optionalString(auth.domain) ?? "",
    nickname: optionalString(identity.nickname) ?? optionalString(identity.preferred_username),
    ...(enterpriseId ? { enterpriseId } : {}),
  };
}

// The access token is a JWT; `sub`/`uid` is the same id the account block
// carries. Used only when a hand-supplied token has no sidecar uid.
export function uidFromJwt(token: string): string | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const padded = part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = asRecord(JSON.parse(Buffer.from(padded, "base64").toString("utf8")));
    return optionalString(payload?.uid) ?? optionalString(payload?.sub);
  } catch {
    return undefined;
  }
}

function parseOwnStore(text: string): WorkBuddyCredentials | undefined {
  const document = asRecord(safeJson(text));
  if (!document || document.version !== 1) return undefined;
  const stored = asRecord(document.credential);
  if (!stored) return undefined;
  const accessToken = typeof stored.accessToken === "string" ? stored.accessToken : "";
  if (!accessToken) return undefined;
  const enterpriseId = optionalString(stored.enterpriseId);
  return {
    accessToken,
    refreshToken: typeof stored.refreshToken === "string" ? stored.refreshToken : "",
    expiresAtMs: typeof stored.expiresAtMs === "number" ? stored.expiresAtMs : 0,
    uid: optionalString(stored.uid) ?? "",
    domain: optionalString(stored.domain) ?? "",
    nickname: optionalString(stored.nickname),
    ...(enterpriseId ? { enterpriseId } : {}),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The credential the browser login stored, in opencode's config dir. */
function ownStorePath(): string {
  const base = readEnvSafe("XDG_CONFIG_HOME") || join(homedir(), ".config");
  return join(base, "opencode", "workbuddy-auth.json");
}

function readOwnStore(): WorkBuddyCredentials | undefined {
  try {
    if (!existsSync(ownStorePath())) return undefined;
    return parseOwnStore(readFileSync(ownStorePath(), "utf8"));
  } catch {
    return undefined;
  }
}

export function saveOwnStore(cred: WorkBuddyCredentials): void {
  try {
    const file = ownStorePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, credential: cred }), { mode: 0o600 });
  } catch (error) {
    logPlugin(`auth: could not persist credential (${errorMessage(error)})`);
  }
}

function desktopCandidates(): string[] {
  const env = readEnvSafe(WORKBUDDY_AUTH_FILE_ENV);
  if (env) return [env];
  const home = homedir();
  const rel = ["CodeBuddyExtension", "Data", "Public", "auth"] as const;
  const files: string[] = [];
  if (process.platform === "darwin") {
    for (const name of AUTH_FILE_CANDIDATES) files.push(join(home, "Library", "Application Support", ...rel, name));
  } else if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const roaming = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    for (const root of [local, roaming]) {
      for (const name of AUTH_FILE_CANDIDATES) files.push(join(root, ...rel, name));
    }
  } else {
    const config = readEnvSafe("XDG_CONFIG_HOME") || join(home, ".config");
    for (const name of AUTH_FILE_CANDIDATES) files.push(join(config, ...rel, name));
  }
  return files;
}

function readDesktopCredential(): WorkBuddyCredentials | undefined {
  for (const path of desktopCandidates()) {
    try {
      if (!existsSync(path)) continue;
      const cred = parseWorkBuddyAuth(readFileSync(path, "utf8"));
      if (cred) return cred;
    } catch {
      /* unreadable candidate -- fall through */
    }
  }
  return undefined;
}

function isFresh(cred: WorkBuddyCredentials): boolean {
  if (cred.expiresAtMs === 0) return true; // unknown lifetime: use until rejected
  return Date.now() + REFRESH_SKEW_MS < cred.expiresAtMs;
}

/**
 * Credential resolution order (reference parity):
 *   1. provider options apiKey (+ userID)
 *   2. WORKBUDDY_TOKEN / WORKBUDDY_UID env
 *   3. the browser-login store (written by /connect workbuddy)
 *   4. the WorkBuddy desktop app's auth file
 * The freshest of (3)/(4) wins when both exist: a login done inside opencode
 * must not be shadowed by a stale desktop token, and vice versa.
 */
export async function resolveWorkBuddyCredentials(
  options: WorkBuddyProviderOptions = {},
): Promise<WorkBuddyCredentials> {
  const explicit = readEnvSafe(WORKBUDDY_TOKEN_ENV);
  const token = options.apiKey || explicit;
  if (token) {
    const uid = options.userID || readEnvSafe(WORKBUDDY_UID_ENV) || uidFromJwt(token) || "";
    return {
      accessToken: token,
      refreshToken: "",
      expiresAtMs: 0,
      uid,
      domain: "",
    };
  }

  const own = readOwnStore();
  const desktop = readDesktopCredential();
  let cred: WorkBuddyCredentials | undefined;
  if (own && desktop) cred = own.expiresAtMs >= desktop.expiresAtMs ? own : desktop;
  else cred = own ?? desktop;
  if (!cred) {
    throw new Error(
      "WorkBuddy credentials not found. Run `/connect workbuddy` in opencode, log in to the WorkBuddy desktop app, or set WORKBUDDY_TOKEN.",
    );
  }
  if (isFresh(cred)) return cred;

  const refreshed = await refreshWorkBuddyToken(cred).catch((error) => {
    logPlugin(`auth: refresh failed (${errorMessage(error)})`);
    return undefined;
  });
  if (refreshed) {
    saveOwnStore(refreshed);
    return refreshed;
  }
  // Refresh failed. If the old token is not yet hard-expired, spend it anyway
  // and let the request path surface a rejection; a transient outage should
  // not block a still-usable credential.
  if (cred.expiresAtMs > Date.now()) return cred;
  throw new Error("WorkBuddy access token expired and refresh failed. Re-run /connect workbuddy.");
}

export function baseUrlFor(cred: WorkBuddyCredentials, options: WorkBuddyProviderOptions = {}): string {
  const configured = options.baseUrl || readEnvSafe(WORKBUDDY_BASE_URL_ENV);
  if (configured) return configured.replace(/\/+$/, "");
  if (cred.domain) return `https://${cred.domain}`;
  return WORKBUDDY_INTL_BASE;
}

function browserHeaders(base: string): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Origin: base,
    Referer: `${base}/`,
    "User-Agent": USER_AGENT,
  };
}

/** The header set a chat (or billing) request must carry. */
export function chatHeaders(cred: WorkBuddyCredentials): Record<string, string> {
  const base = baseUrlFor(cred);
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: base,
    Referer: `${base}/`,
    "User-Agent": USER_AGENT,
    Authorization: `Bearer ${cred.accessToken}`,
    ...(cred.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": cred.uid }),
    ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : { "X-No-Enterprise-Id": "1" }),
    ...(cred.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": cred.domain }),
    "X-Product": "SaaS",
  };
}

/**
 * Renew an access token. Reference: pi-workbuddy-connect refreshAccess() --
 * the refresh token rides a header, not the body, and the envelope answers
 * `{ code, msg, data: { accessToken, refreshToken?, expiresIn?, domain? } }`.
 */
export async function refreshWorkBuddyToken(
  cred: WorkBuddyCredentials,
  baseOverride?: string,
): Promise<WorkBuddyCredentials> {
  if (!cred.refreshToken) throw new Error("no refresh token available");
  const base = baseOverride ?? baseUrlFor(cred);
  const response = await fetch(`${base}/v2/plugin/auth/token/refresh`, {
    method: "POST",
    headers: {
      ...browserHeaders(base),
      "X-Refresh-Token": cred.refreshToken,
      "X-Auth-Refresh-Source": "workbuddy",
      ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = asRecord(await response.json().catch(() => undefined)) ?? {};
  const data = asRecord(envelope.data) ?? {};
  const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
  if (!response.ok || envelope.code !== 0 || accessToken === "") {
    throw new Error(
      typeof envelope.msg === "string" && envelope.msg !== "" ? envelope.msg : `refresh HTTP ${response.status}`,
    );
  }
  return {
    ...cred,
    accessToken,
    refreshToken:
      typeof data.refreshToken === "string" && data.refreshToken !== "" ? data.refreshToken : cred.refreshToken,
    expiresAtMs:
      typeof data.expiresIn === "number" && data.expiresIn > 0 ? Date.now() + data.expiresIn * 1000 : cred.expiresAtMs,
    domain: typeof data.domain === "string" && data.domain !== "" ? data.domain : cred.domain,
  };
}

// --- browser login (opencode's /connect workbuddy) --------------------------

export async function startPluginLogin(base: string): Promise<{ state: string; authUrl: string }> {
  const nonce = cryptoRandom();
  const response = await fetch(`${base}/v2/plugin/auth/state?platform=CLI&nonce=${nonce}`, {
    method: "POST",
    headers: { ...browserHeaders(base), "X-Product": "SaaS", "X-No-Authorization": "true", "X-No-User-Id": "1", "X-No-Enterprise-Id": "1", "X-No-Department-Info": "1" },
    body: JSON.stringify({ nonce }),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = asRecord(await response.json().catch(() => undefined)) ?? {};
  const data = asRecord(envelope.data) ?? {};
  const state = typeof data.state === "string" ? data.state : "";
  const authUrl = typeof data.authUrl === "string" ? data.authUrl : "";
  if (!response.ok || envelope.code !== 0 || !state || !authUrl) {
    throw new Error(typeof envelope.msg === "string" && envelope.msg ? envelope.msg : "workbuddy login start failed");
  }
  return { state, authUrl };
}

function cryptoRandom(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/**
 * Poll until the browser session is authorized (15 min deadline). Code 11217
 * means "not yet" and is the loop's continue signal; any other non-zero code
 * is final.
 */
export async function pollPluginCredential(
  state: string,
  base: string,
  shouldAbort?: () => boolean,
): Promise<WorkBuddyCredentials> {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    if (shouldAbort?.()) throw new Error("workbuddy login cancelled");
    const response = await fetch(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
      headers: { ...browserHeaders(base), "X-Product": "SaaS", "X-No-Authorization": "true", "X-No-User-Id": "1", "X-No-Enterprise-Id": "1", "X-No-Department-Info": "1" },
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = asRecord(await response.json().catch(() => undefined)) ?? {};
    if (envelope.code === 11217) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    const data = asRecord(envelope.data) ?? {};
    const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
    if (!response.ok || envelope.code !== 0 || accessToken === "") {
      throw new Error(typeof envelope.msg === "string" && envelope.msg ? envelope.msg : "workbuddy login failed");
    }
    const jwt = asRecord(safeJson(Buffer.from((accessToken.split(".")[1] ?? "").padEnd(Math.ceil((accessToken.split(".")[1] ?? "").length / 4) * 4, "="), "base64url").toString("utf8"))) ?? {};
    const uid =
      optionalString(data.uid) ?? optionalString(jwt.uid) ?? optionalString(jwt.sub) ?? "";
    const enterpriseId = optionalString(data.enterpriseId) ?? optionalString(data.enterprise_id);
    const cred: WorkBuddyCredentials = {
      accessToken,
      refreshToken: optionalString(data.refreshToken) ?? "",
      expiresAtMs: typeof data.expiresIn === "number" && data.expiresIn > 0 ? Date.now() + data.expiresIn * 1000 : 0,
      uid,
      domain: optionalString(data.domain) ?? "www.workbuddy.ai",
      nickname: optionalString(data.nickname) ?? optionalString(jwt.email) ?? optionalString(jwt.name),
      ...(enterpriseId ? { enterpriseId } : {}),
    };
    saveOwnStore(cred);
    return cred;
  }
  throw new Error("workbuddy login timed out");
}
