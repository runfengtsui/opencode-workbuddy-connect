import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CODEBUDDY_CONFIG_DIR_ENV,
  DESKTOP_CONFIG_FOLDERS,
  PRODUCT_CONFIG_FILE,
  type WBRegion,
  WORKBUDDY_CONFIG_DIR_ENV,
} from "./constants.js";
import { DEFAULT_EFFORTS, readEnvSafe } from "./env-helpers.js";
import { logPlugin } from "./log.js";

// Model tables for WorkBuddy AI, one per integration point.
//
// Resolution order, freshest wins:
//   1. the live console catalogue (catalogue.ts -- CN answers it; the
//      international endpoint is known to answer 500 for some accounts)
//   2. the desktop app's product config cache (per-region path, below)
//   3. the bundled table for THAT REGION
//
// (3) is region-split on purpose. The old single table was the union of both
// catalogues, which is how `hy4-preview-f` -- an international id -- ended up
// registered against CN, where no such model exists. An id the integration
// point does not list is not a model that account can buy, so guessing the
// union hands users a request-time error instead of an honest absence.
//
// The CN table below was transcribed from a live `GET /console/enterprises/
// personal/models` response; the international one is the pre-existing bundled
// table (its endpoint could not be verified from a CN credential, and
// cross-region requests are refused by design -- see auth.ts).
//
// Context windows are the real gateway budgets. The 1M models accept a million
// input tokens WITHOUT any wire parameter -- 1M is a property of the model, not
// a mode. The plugin's job is to register the number honestly so opencode's
// compaction threshold follows it instead of compacting at 200k.

export type WorkBuddyModelDefinition = {
  id: string;
  name: string;
  reasoning: boolean;
  /** Thinking levels accepted as `reasoning_effort`. Empty = never send it. */
  efforts: string[];
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  /** Credit multiplier as billed, normalised to "x0.00" / "x0.16" for display. */
  credits?: string;
};

/** Upstream sends two shapes for the same value: "x0.79" and "x0.79 credits". */
export function normalizeCredits(credits: unknown): string | undefined {
  if (typeof credits !== "string") return undefined;
  const trimmed = credits.trim().replace(/\s+credits$/iu, "");
  return trimmed === "" ? undefined : trimmed;
}

function freeCredits(credits: string | undefined): boolean {
  const value = normalizeCredits(credits);
  return value !== undefined && /^x?0(?:\.0+)?$/u.test(value);
}

export function isFreeModel(model: WorkBuddyModelDefinition): boolean {
  return freeCredits(model.credits);
}

// --- bundled tables ---------------------------------------------------------

const BUNDLED_INTL_MODELS: WorkBuddyModelDefinition[] = [
  // --- 1M context tier -----------------------------------------------------
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek-V4-Flash",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 50_000,
    credits: "x0.06",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 50_000,
    credits: "x0.16",
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 48_000,
    credits: "x0.79",
  },
  {
    id: "kimi-k3-1",
    name: "Kimi-K3",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    credits: "x1.62",
  },
  // --- international builtins (pi-workbuddy-connect parity) ----------------
  {
    id: "deepseek-v4.1-flash",
    name: "Deepseek-V4.1-Flash",
    reasoning: true,
    efforts: ["low", "high", "max"],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    credits: "x0.00",
  },
  {
    id: "hy4-preview-f",
    name: "Hy4 Preview",
    reasoning: true,
    efforts: ["high"],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    credits: "x0.00",
  },
  // --- smaller windows -----------------------------------------------------
  {
    id: "hy3",
    name: "Hy3",
    reasoning: true,
    efforts: ["low", "high"],
    input: ["text", "image"],
    contextWindow: 192_000,
    maxTokens: 64_000,
    credits: "x0.00",
  },
  {
    id: "minimax-m3",
    name: "MiniMax-M3",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 512_000,
    maxTokens: 128_000,
    credits: "x0.25",
  },
  {
    id: "kimi-k2.7",
    name: "Kimi-K2.7",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 256_000,
    maxTokens: 32_000,
    credits: "x0.57",
  },
  {
    id: "kimi-k2.5",
    name: "Kimi-K2.5",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 256_000,
    maxTokens: 32_000,
  },
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 48_000,
  },
];

// Snapshot of the CN catalogue as actually served by the live endpoint.
// `hunyuan-image-v3.0` is deliberately absent: it carries no token budget at
// all (it is a text-to-image model), and parseProductModel drops it anyway.
const BUNDLED_CN_MODELS: WorkBuddyModelDefinition[] = [
  {
    id: "auto",
    name: "Auto",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 168_000,
    maxTokens: 32_000,
  },
  {
    id: "hy3",
    name: "Hy3",
    reasoning: true,
    efforts: ["low", "high"],
    input: ["text", "image"],
    contextWindow: 192_000,
    maxTokens: 64_000,
    credits: "x0.00",
  },
  {
    id: "hy3-x",
    name: "Hy3",
    reasoning: true,
    efforts: ["low", "high"],
    input: ["text", "image"],
    contextWindow: 192_000,
    maxTokens: 64_000,
    credits: "x0.05",
  },
  {
    id: "hy4-preview",
    name: "Hy4 preview",
    reasoning: true,
    efforts: ["high"],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    credits: "x0.29",
  },
  {
    id: "hy4-preview-x",
    name: "Hy4 preview",
    reasoning: true,
    efforts: ["high"],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    credits: "x0.29",
  },
  {
    id: "default",
    name: "Default",
    reasoning: false,
    efforts: [],
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 24_000,
    credits: "x2.20",
  },
  {
    id: "glm-5v-turbo",
    name: "GLM-5V-Turbo",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 64_000,
    credits: "x0.71",
  },
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    reasoning: true,
    efforts: ["low", "high", "max"],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    credits: "x0.52",
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    reasoning: true,
    efforts: ["low", "high", "max"],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    credits: "x0.11",
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    credits: "x0.79",
  },
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 48_000,
    credits: "x0.79",
  },
  {
    id: "glm-5.0",
    name: "GLM-5.0",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 48_000,
    credits: "x0.80",
  },
  {
    id: "glm-4.7",
    name: "GLM-4.7",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 32_000,
    credits: "x0.23",
  },
  {
    id: "glm-4.6",
    name: "GLM-4.6",
    reasoning: false,
    efforts: [],
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 32_000,
    credits: "x0.18",
  },
  {
    id: "glm-4.6v",
    name: "GLM-4.6V",
    reasoning: false,
    efforts: [],
    input: ["text", "image"],
    contextWindow: 64_000,
    maxTokens: 16_000,
    credits: "x0.77",
  },
  {
    id: "minimax-m3",
    name: "MiniMax-M3",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 512_000,
    maxTokens: 64_000,
    credits: "x0.25",
  },
  {
    id: "minimax-m2.5",
    name: "MiniMax-M2.5",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 64_000,
    credits: "x0.18",
  },
  {
    id: "kimi-k3-1",
    name: "Kimi-K3",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    credits: "x1.62",
  },
  {
    id: "kimi-k2.8-preview",
    name: "Kimi-K2.8-Preview",
    reasoning: true,
    efforts: ["low", "high", "max"],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    credits: "x0.54",
  },
  {
    id: "kimi-k2.7",
    name: "Kimi-K2.7",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 256_000,
    maxTokens: 32_000,
    credits: "x0.57",
  },
  {
    id: "kimi-k2.6",
    name: "Kimi-K2.6",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 256_000,
    maxTokens: 32_000,
    credits: "x0.45",
  },
  {
    id: "kimi-k2.5",
    name: "Kimi-K2.5",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 164_000,
    maxTokens: 32_000,
    credits: "x0.45",
  },
  {
    id: "kimi-k2-thinking",
    name: "Kimi-K2-Thinking",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text"],
    contextWindow: 256_000,
    maxTokens: 16_000,
    credits: "x0.29",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek-V4-Flash",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 50_000,
    credits: "x0.17",
  },
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek-V4.1-Flash",
    reasoning: true,
    efforts: ["low", "high", "max"],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    credits: "x0.03",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    credits: "x0.51",
  },
  {
    id: "deepseek-v3-2-volc",
    name: "DeepSeek-V3.2",
    reasoning: false,
    efforts: [],
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 64_000,
    credits: "x0.06",
  },
  {
    id: "hunyuan-2.0-thinking",
    name: "Hunyuan-2.0-Thinking",
    reasoning: true,
    efforts: [...DEFAULT_EFFORTS],
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 24_000,
    credits: "x0.04",
  },
  {
    id: "hunyuan-chat",
    name: "Hunyuan-Turbos",
    reasoning: false,
    efforts: [],
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
];

export function bundledModels(region: WBRegion): WorkBuddyModelDefinition[] {
  return region === "cn" ? BUNDLED_CN_MODELS : BUNDLED_INTL_MODELS;
}

/**
 * A single stand-in model shown only when NEITHER integration point is logged
 * in: it proves the plugin loaded without pretending to offer models the
 * account cannot buy. Selecting it fails loudly with a login prompt, and the
 * provider it lives under still exposes /connect so the user can authenticate.
 */
export const OFFLINE_MODEL_ID = "workbuddy-offline";

export const OFFLINE_MODEL: WorkBuddyModelDefinition = {
  id: OFFLINE_MODEL_ID,
  name: "WorkBuddy (offline — login required)",
  reasoning: false,
  efforts: [],
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8_192,
};

// --- product config cache (same file the WorkBuddy desktop writes) ---------

export type RawProductModel = {
  id?: unknown;
  name?: unknown;
  credits?: unknown;
  maxInputTokens?: unknown;
  maxOutputTokens?: unknown;
  supportsImages?: unknown;
  supportsReasoning?: unknown;
  disabledMultimodal?: unknown;
  reasoning?: { supportedEfforts?: unknown; defaultEffort?: unknown; canDisableThinking?: unknown };
};

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string =>
    (DEFAULT_EFFORTS as readonly string[]).includes(String(item)),
  );
}

/** True when upstream named the ladder instead of us inferring one. */
export function modelAdvertisesEfforts(row: RawProductModel): boolean {
  return parseEfforts(row.reasoning?.supportedEfforts).length > 0;
}

export function parseProductModel(row: RawProductModel): WorkBuddyModelDefinition | undefined {
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) return undefined;
  const contextWindow = positiveNumber(row.maxInputTokens) ?? 0;
  const maxTokens = positiveNumber(row.maxOutputTokens) ?? 0;
  if (contextWindow <= 0 || maxTokens <= 0) return undefined;
  const reasoning = row.supportsReasoning === true;
  const efforts = reasoning ? parseEfforts(row.reasoning?.supportedEfforts) : [];
  const credits = normalizeCredits(row.credits);
  return {
    id,
    name: typeof row.name === "string" && row.name !== "" ? row.name : id,
    reasoning,
    // Upstream lists `supportedEfforts` for some models only, and the reference
    // clients read an absent list as "unknown" -- never as "all levels". Filling
    // the ladder keeps the bundled table's behaviour for models the endpoint
    // stays quiet about; applyCatalogue() puts the static ladder back, which is
    // the more accurate of the two guesses.
    efforts: reasoning && efforts.length === 0 ? [...DEFAULT_EFFORTS] : efforts,
    input:
      row.supportsImages === true && row.disabledMultimodal !== true ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens,
    ...(credits ? { credits } : {}),
  };
}

/**
 * Candidate product-config paths for one integration point.
 *
 * The region-specific override wins (`WORKBUDDYAI_CN_PRODUCT_CONFIG` for CN),
 * then the legacy single-path override for international, then the desktop's own
 * layout: $WORKBUDDY_CONFIG_DIR / $CODEBUDDY_CONFIG_DIR when set, otherwise
 * every known data folder -- the client ships under more than one, and nothing
 * inside the file says which build wrote it.
 */
export function productConfigCandidates(region: WBRegion): string[] {
  // Deliberately not one shared variable: `WORKBUDDYAI_PRODUCT_CONFIG` stays the
  // international knob and CN gets its own, so pointing a CN build at a cache
  // can never re-union the two tables (which is how hy4-preview-f got here).
  const pinned = readEnvSafe(
    region === "cn" ? "WORKBUDDYAI_CN_PRODUCT_CONFIG" : "WORKBUDDYAI_PRODUCT_CONFIG",
  );
  if (pinned) return [pinned];
  const home = homedir();
  const roots: string[] = [];
  for (const name of [WORKBUDDY_CONFIG_DIR_ENV, CODEBUDDY_CONFIG_DIR_ENV]) {
    const value = readEnvSafe(name);
    if (value) roots.push(value);
  }
  for (const folder of DESKTOP_CONFIG_FOLDERS) roots.push(join(home, folder));
  return [...new Set(roots.map((root) => join(root, ...PRODUCT_CONFIG_FILE)))];
}

function loadProductConfigModels(region: WBRegion): WorkBuddyModelDefinition[] | undefined {
  for (const file of productConfigCandidates(region)) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { models?: unknown };
      if (!Array.isArray(parsed.models)) continue;
      const models = parsed.models
        .map((row) => parseProductModel((row ?? {}) as RawProductModel))
        .filter((model): model is WorkBuddyModelDefinition => model !== undefined);
      if (models.length === 0) continue;
      logPlugin(`models[${region}]: ${models.length} entries from product config cache (${file})`);
      return models;
    } catch {
      /* unreadable candidate -- try the next */
    }
  }
  return undefined;
}

// --- the effective per-region table ----------------------------------------

export type CatalogueRow = {
  model: WorkBuddyModelDefinition;
  /** Upstream listed supportedEfforts for this row (rather than us inferring). */
  effortsAdvertised: boolean;
};

/**
 * Live catalogue rows land here from catalogue.ts. Request-path reads stay
 * synchronous, so a refresh that finishes after setup still takes effect on
 * the next lookup instead of needing a reload.
 */
const LIVE_TABLES = new Map<WBRegion, WorkBuddyModelDefinition[]>();
const STATIC_TABLES = new Map<WBRegion, WorkBuddyModelDefinition[]>();

/** Bundled + product-config, with no network input. Memoised per region. */
export function staticModels(region: WBRegion): WorkBuddyModelDefinition[] {
  let table = STATIC_TABLES.get(region);
  if (!table) {
    const byId = new Map<string, WorkBuddyModelDefinition>();
    for (const model of bundledModels(region)) byId.set(model.id, model);
    const cached = loadProductConfigModels(region);
    if (cached) for (const model of cached) byId.set(model.id, model);
    table = [...byId.values()];
    STATIC_TABLES.set(region, table);
  }
  return table;
}

export function modelTable(region: WBRegion): WorkBuddyModelDefinition[] {
  return LIVE_TABLES.get(region) ?? staticModels(region);
}

export function liveModelTable(region: WBRegion): WorkBuddyModelDefinition[] | undefined {
  return LIVE_TABLES.get(region);
}

/**
 * A catalogue shorter than this is transport noise, not a product decision:
 * WorkBuddy has offered 29-30 models on CN and ~10 on international, and an
 * auth-scope-truncated response would otherwise delete every pin below
 * (including `hy3`, which the subagent defaults are bound to).
 */
const MIN_PLAUSIBLE_CATALOGUE = 3;

/**
 * Adopt a live catalogue as a region's table.
 *
 * Authoritative for ids, numbers and credits -- that is the point of fetching
 * it -- so an id it omits stops being offered. Not authoritative for the effort
 * ladder: where upstream stayed quiet, the static table's ladder (taken from
 * the desktop client) is kept, because "absent" means unknown.
 */
export function applyCatalogue(region: WBRegion, rows: CatalogueRow[]): WorkBuddyModelDefinition[] {
  const staticById = new Map(staticModels(region).map((model) => [model.id, model]));
  const table = rows
    .map((row) => {
      const previous = staticById.get(row.model.id);
      if (!previous || row.effortsAdvertised || previous.efforts.length === 0) return row.model;
      return { ...row.model, efforts: previous.efforts };
    })
    .filter((model) => model.contextWindow > 0 && model.maxTokens > 0);
  if (table.length < MIN_PLAUSIBLE_CATALOGUE) {
    const current = LIVE_TABLES.get(region) ?? staticModels(region);
    logPlugin(
      `models[${region}]: catalogue listed ${table.length} usable models -- implausible, keeping ${current.length}`,
    );
    // Return what is already installed. Replacing the live table with the
    // static one here would make the caller register a different set of models
    // than the request path resolves ids against.
    return current;
  }
  LIVE_TABLES.set(region, table);
  return table;
}

/** Forget any adopted catalogue (tests). */
export function resetModelTablesForTests(): void {
  LIVE_TABLES.clear();
  STATIC_TABLES.clear();
}

export function getModelDefinition(
  modelID: string,
  region: WBRegion = "intl",
): WorkBuddyModelDefinition | undefined {
  return modelTable(region).find((model) => model.id === modelID);
}

const PREFERRED_DEFAULT = "hy3";

/**
 * The model the plugin pins itself to (subagents, setDefault). Free where
 * possible, and always present in the table it is chosen from -- a pin to a
 * dropped id turns every subagent into an unknown-model error.
 */
export function defaultModelID(region: WBRegion): string {
  const table = modelTable(region);
  const preferred = table.find((model) => model.id === PREFERRED_DEFAULT);
  if (preferred) return preferred.id;
  const free = table.find((model) => isFreeModel(model));
  return free?.id ?? table[0]?.id ?? PREFERRED_DEFAULT;
}

export function displayName(model: WorkBuddyModelDefinition): string {
  const parts: string[] = [];
  if (model.credits) parts.push(model.credits);
  const mega =
    model.contextWindow >= 1_000_000 ? "1M" : `${Math.round(model.contextWindow / 1000)}K`;
  parts.push(mega);
  return `${model.name} (${parts.join(", ")})`;
}
