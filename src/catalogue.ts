import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chatHeaders, resolveWorkBuddyCredentials, type WorkBuddyProviderOptions } from "./auth.js";
import {
  MODEL_CATALOGUE_CACHE_ENV,
  MODEL_CATALOGUE_DISABLE_ENV,
  MODEL_CATALOGUE_ERROR_TTL_MS,
  MODEL_CATALOGUE_FIXTURE_ENV,
  MODEL_CATALOGUE_TTL_ENV,
  MODEL_CATALOGUE_TTL_MS,
  modelCacheName,
  modelCataloguePaths,
  type WBRegion,
} from "./constants.js";
import { envBool, opencodeCacheFile, readEnvSafe, writeJsonAtomic } from "./env-helpers.js";
import { errorMessage, logPlugin, logWarn } from "./log.js";
import {
  applyCatalogue,
  type CatalogueRow,
  modelAdvertisesEfforts,
  normalizeCredits,
  parseProductModel,
  type RawProductModel,
  staticModels,
  type WorkBuddyModelDefinition,
} from "./models.js";

/**
 * The live model catalogue, mirroring the reference clients' `FetchModels`.
 *
 * `GET {base}/console/enterprises/personal/models` answers with the models that
 * credential can actually buy, at the gateway's real token budgets -- the only
 * way the table stays true after WorkBuddy renames or re-tunes a model. The
 * international endpoint is reported to answer 500 even for valid accounts, so
 * this whole module is an optimisation: every path out of it lands on the
 * static table, and a failure NEVER invalidates a credential. The model list is
 * capability discovery, not authentication (see the reference client's note
 * about not feeding a /models failure into the breaker).
 */

/** Shorter than the chat timeout: this runs on the plugin's startup path. */
const CATALOGUE_TIMEOUT_MS = 8_000;

export type CatalogueSource = "fixture" | "cache" | "live" | "static";

export type CatalogueState = {
  region: WBRegion;
  source: CatalogueSource;
  models: WorkBuddyModelDefinition[];
  fetchedAtMs: number;
  /** Set when the last attempt failed; the next one waits out the error TTL. */
  failedAtMs?: number;
  error?: string;
};

const STATES = new Map<WBRegion, CatalogueState>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function catalogueDisabled(): boolean {
  return envBool(MODEL_CATALOGUE_DISABLE_ENV);
}

function cacheTTLMs(): number {
  const seconds = Number.parseInt(readEnvSafe(MODEL_CATALOGUE_TTL_ENV), 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : MODEL_CATALOGUE_TTL_MS;
}

/**
 * Cache file for the given region. Honors `WORKBUDDY_MODEL_DISK_CACHE` verbatim
 * as an exact file path, OR as a directory when the value ends in a path
 * separator or refers to an existing directory: then the per-region filename
 * (`opencode-workbuddy[-cn]-models.json`) is written inside it. The directory
 * form is the one to use when both `workbuddy` and `workbuddy-cn` are loaded
 * simultaneously -- a shared exact path would let whichever region wrote last
 * serve its model list to the other, which is the cross-region leak this whole
 * module exists to prevent.
 */
function cachePath(region: WBRegion): string {
  const override = readEnvSafe(MODEL_CATALOGUE_CACHE_ENV);
  if (!override) return opencodeCacheFile(modelCacheName(region));
  const looksLikeDir =
    override.endsWith("/") ||
    override.endsWith("\\") ||
    (existsSync(override) && statSync(override).isDirectory());
  if (looksLikeDir) return join(override, modelCacheName(region));
  return override;
}

type CachedFile = {
  version?: unknown;
  fetchedAt?: unknown;
  failedAt?: unknown;
  models?: unknown;
};

function readCache(region: WBRegion): CachedFile | undefined {
  const file = cachePath(region);
  try {
    if (!existsSync(file)) return undefined;
    const parsed = asRecord(JSON.parse(readFileSync(file, "utf8")));
    if (parsed?.version !== 1) return undefined;
    return parsed as CachedFile;
  } catch (error) {
    // A missing cache is the normal fresh state; a broken one is worth a trace,
    // because it is indistinguishable from "never fetched" from here on.
    logWarn(`catalogue[${region}]: could not read ${file} (${errorMessage(error)})`);
    return undefined;
  }
}

/** Persist the PARSED rows, not the raw body: an upstream shape change then
 * cannot invalidate what we already understood. */
function writeCache(region: WBRegion, rows: CatalogueRow[]): void {
  try {
    writeJsonAtomic(cachePath(region), {
      version: 1,
      fetchedAt: Date.now(),
      models: rows,
    });
  } catch (error) {
    logPlugin(`catalogue[${region}]: cache write failed (${errorMessage(error)})`);
  }
}

function writeCacheFailure(region: WBRegion, previous: CachedFile | undefined): void {
  try {
    writeJsonAtomic(cachePath(region), {
      version: 1,
      fetchedAt: typeof previous?.fetchedAt === "number" ? previous.fetchedAt : 0,
      failedAt: Date.now(),
      models: Array.isArray(previous?.models) ? previous.models : [],
    });
  } catch (error) {
    logPlugin(`catalogue[${region}]: failure cache write failed (${errorMessage(error)})`);
  }
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Restores a cached row. The cache holds ALREADY-PARSED definitions (see
 * writeCache), so this must NOT feed them back through parseProductModel,
 * which expects raw `maxInputTokens` field names and would drop every row.
 * It re-validates instead: a hand-edited or half-written cache must not
 * smuggle a 0-context or non-string-id model into the table.
 */
function restoreModel(value: unknown): WorkBuddyModelDefinition | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return undefined;
  const contextWindow = positiveInt(record.contextWindow);
  const maxTokens = positiveInt(record.maxTokens);
  if (contextWindow === undefined || maxTokens === undefined) return undefined;
  if (!Array.isArray(record.input) || record.input.length === 0) return undefined;
  const input = (record.input as unknown[])
    .filter((m): m is "text" | "image" => m === "text" || m === "image")
    .slice()
    .filter((m, i, a) => a.indexOf(m) === i) as Array<"text" | "image">;
  if (input.length === 0) return undefined;
  const efforts = Array.isArray(record.efforts)
    ? record.efforts.filter((e): e is string => typeof e === "string" && e !== "")
    : [];
  const credits = normalizeCredits(record.credits);
  return {
    id,
    name: typeof record.name === "string" && record.name !== "" ? record.name : id,
    reasoning: record.reasoning === true,
    efforts,
    input,
    contextWindow,
    maxTokens,
    ...(credits ? { credits } : {}),
  };
}

function rowsFrom(value: unknown): CatalogueRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: CatalogueRow[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const model = restoreModel(record.model);
    if (!model) continue;
    rows.push({ model, effortsAdvertised: record.effortsAdvertised === true });
  }
  return rows;
}

/** Parses the `{ code, data: { models: [...] } }` envelope. */
export function parseCataloguePayload(payload: unknown): CatalogueRow[] {
  const document = asRecord(payload);
  const data = asRecord(document?.data) ?? document ?? {};
  const models = Array.isArray(data.models) ? data.models : [];
  const rows: CatalogueRow[] = [];
  for (const entry of models) {
    const row = asRecord(entry) as RawProductModel | undefined;
    if (!row) continue;
    const parsed = parseProductModel(row);
    if (!parsed) continue;
    rows.push({ model: parsed, effortsAdvertised: modelAdvertisesEfforts(row) });
  }
  return rows;
}

/** The URL a region's discovery starts with. */
export function catalogueURL(base: string, region: WBRegion): string {
  return `${base.replace(/\/+$/, "")}${modelCataloguePaths(region)[0]}`;
}

/**
 * Fetch the catalogue, trying each candidate path for the region until one
 * answers. The international endpoint is the reason this loops at all: it
 * answers 500 on `/console/...` but 200 on `/v2/...`, so a single hard-coded
 * prefix would leave that region permanently on the static table. Every path
 * that can fail throws; the caller turns the aggregate into a fallback.
 */
async function fetchCatalogueRows(
  region: WBRegion,
  options: WorkBuddyProviderOptions,
): Promise<{ rows: CatalogueRow[]; base: string }> {
  const credentials = await resolveWorkBuddyCredentials(options);
  const base = credentials.domain
    ? `https://${credentials.domain}`
    : options.baseUrl
      ? options.baseUrl.replace(/\/+$/, "")
      : "";
  if (!/^https?:\/\//u.test(base)) throw new Error("no base URL for this region");
  const failures: string[] = [];
  for (const path of modelCataloguePaths(region)) {
    const url = `${base.replace(/\/+$/, "")}${path}`;
    let response: Response;
    let payload: Record<string, unknown> | undefined;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: chatHeaders(credentials, options),
        signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
      });
      payload = asRecord(await response.json().catch(() => undefined));
    } catch (error) {
      failures.push(`${path}: ${errorMessage(error)}`);
      continue;
    }
    if (!response.ok) {
      const code = typeof payload?.code === "number" ? ` code=${payload.code}` : "";
      failures.push(`${path}: HTTP ${response.status}${code}`);
      continue;
    }
    if (typeof payload?.code === "number" && payload.code !== 0) {
      failures.push(`${path}: envelope code=${payload.code}`);
      continue;
    }
    const rows = parseCataloguePayload(payload);
    if (rows.length === 0) {
      failures.push(`${path}: listed no usable models`);
      continue;
    }
    if (failures.length > 0) {
      logPlugin(`catalogue[${region}]: ${failures.join("; ")} -- recovered on a later path`);
    }
    return { rows, base: url };
  }
  throw new Error(failures.join("; ") || "no usable catalogue path");
}

function state(region: WBRegion, partial: Omit<CatalogueState, "region">): CatalogueState {
  const value: CatalogueState = { region, ...partial };
  STATES.set(region, value);
  return value;
}

/**
 * Refresh (or serve from cache) and return the region's model table.
 * Never throws and never rejects: the caller is registering a provider.
 */
export async function refreshModelCatalogue(
  region: WBRegion,
  options: WorkBuddyProviderOptions = {},
): Promise<WorkBuddyModelDefinition[]> {
  const fallback = () =>
    state(region, { source: "static", models: staticModels(region), fetchedAtMs: 0 }).models;

  if (catalogueDisabled()) return fallback();

  const cache = readCache(region);
  const cachedRows = rowsFrom(cache?.models);
  const fetchedAtMs = typeof cache?.fetchedAt === "number" ? cache.fetchedAt : 0;
  const failedAtMs = typeof cache?.failedAt === "number" ? cache.failedAt : 0;
  const fresh = fetchedAtMs > 0 && Date.now() - fetchedAtMs < cacheTTLMs();
  const coolingDown = failedAtMs > 0 && Date.now() - failedAtMs < MODEL_CATALOGUE_ERROR_TTL_MS;

  const fixture = readEnvSafe(MODEL_CATALOGUE_FIXTURE_ENV);
  if (fixture) {
    try {
      const rows = parseCataloguePayload(JSON.parse(readFileSync(fixture, "utf8")));
      if (rows.length > 0) {
        const models = applyCatalogue(region, rows);
        logPlugin(`catalogue[${region}]: ${models.length} models from fixture ${fixture}`);
        return state(region, { source: "fixture", models, fetchedAtMs: Date.now() }).models;
      }
      logWarn(`catalogue[${region}]: fixture ${fixture} yielded no models`);
    } catch (error) {
      logWarn(`catalogue[${region}]: fixture ${fixture} unreadable (${errorMessage(error)})`);
    }
    return fallback();
  }

  if (fresh && cachedRows && cachedRows.length > 0) {
    const models = applyCatalogue(region, cachedRows);
    logPlugin(
      `catalogue[${region}]: ${models.length} models from disk cache (age ${Math.round((Date.now() - fetchedAtMs) / 1000)}s)`,
    );
    return state(region, { source: "cache", models, fetchedAtMs }).models;
  }
  if (coolingDown) {
    // Still serve a stale catalogue: it is closer to the truth than the bundle.
    if (cachedRows && cachedRows.length > 0) {
      const models = applyCatalogue(region, cachedRows);
      logPlugin(
        `catalogue[${region}]: ${models.length} models from disk cache (stale, retrying in ${Math.ceil((MODEL_CATALOGUE_ERROR_TTL_MS - (Date.now() - failedAtMs)) / 1000)}s)`,
      );
      return state(region, { source: "cache", models, fetchedAtMs, failedAtMs }).models;
    }
    logPlugin(`catalogue[${region}]: no usable cache, using static table (retrying soon)`);
    return fallback();
  }

  try {
    const { rows } = await fetchCatalogueRows(region, options);
    writeCache(region, rows);
    const models = applyCatalogue(region, rows);
    logPlugin(`catalogue[${region}]: ${models.length} models fetched live`);
    return state(region, { source: "live", models, fetchedAtMs: Date.now() }).models;
  } catch (error) {
    const message = errorMessage(error);
    writeCacheFailure(region, cache);
    logPlugin(`catalogue[${region}]: live fetch skipped (${message})`);
    if (cachedRows && cachedRows.length > 0) {
      const models = applyCatalogue(region, cachedRows);
      logPlugin(
        `catalogue[${region}]: live fetch failed, serving ${models.length} models from disk cache`,
      );
      return state(region, {
        source: "cache",
        models,
        fetchedAtMs,
        failedAtMs: Date.now(),
        error: message,
      }).models;
    }
    logPlugin(`catalogue[${region}]: live fetch failed, serving the static table`);
    return {
      ...state(region, {
        source: "static",
        models: staticModels(region),
        fetchedAtMs: 0,
        error: message,
      }),
    }.models;
  }
}

/** Last resolution for a region -- what happened and why. */
export function catalogueStatus(region: WBRegion): CatalogueState | undefined {
  return STATES.get(region);
}

export function catalogueCachePath(region: WBRegion): string {
  return cachePath(region);
}
