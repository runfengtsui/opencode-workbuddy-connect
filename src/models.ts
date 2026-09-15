import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EFFORTS, readEnvSafe } from "./env-helpers.js";
import { logPlugin } from "./log.js";

// Model table for WorkBuddy AI.
//
// Two sources, in order:
//   1. the desktop app's product config cache
//      (~/.workbuddy-ai/cache/acc-product-config-v3.json, or
//      $WORKBUDDYAI_PRODUCT_CONFIG). This is what the reference plugin reads:
//      models[].maxInputTokens / maxOutputTokens / supportsReasoning /
//      reasoning.supportedEfforts / supportsImages / credits ("x0.00" = free).
//      It is the only way paid-for models and effort ladders stay accurate
//      without a live listing endpoint -- WorkBuddy has no model-list API.
//   2. the bundled table below, taken from the desktop client's own
//      product.json. Context windows are the real gateway budgets: the four
//      1M models (deepseek-v4-pro, deepseek-v4-flash, glm-5.2, kimi-k3-1)
//      accept a million input tokens WITHOUT any wire parameter -- 1M is a
//      property of the model, not a mode. The plugin's job is to register the
//      number honestly so opencode's compaction threshold follows it instead
//      of compacting at 200k.

export type WorkBuddyModelDefinition = {
  id: string;
  name: string;
  reasoning: boolean;
  /** Thinking levels accepted as `reasoning_effort`. Empty = never send it. */
  efforts: string[];
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  /** Credit multiplier string as billed ("x0.00", "x0.16"...), for display. */
  credits?: string;
};

function freeCredits(credits: string | undefined): boolean {
  return typeof credits === "string" && /^x?0(?:\.0+)?$/u.test(credits.trim());
}

export function isFreeModel(model: WorkBuddyModelDefinition): boolean {
  return freeCredits(model.credits);
}

const BUNDLED_MODELS: WorkBuddyModelDefinition[] = [
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
    efforts: [...DEFAULT_EFFORTS],
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

// --- product config cache (same file the WorkBuddy desktop writes) ---------

type RawProductModel = {
  id?: unknown;
  name?: unknown;
  credits?: unknown;
  maxInputTokens?: unknown;
  maxOutputTokens?: unknown;
  supportsImages?: unknown;
  supportsReasoning?: unknown;
  disabledMultimodal?: unknown;
  reasoning?: { supportedEfforts?: unknown; canDisableThinking?: unknown };
};

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => (DEFAULT_EFFORTS as readonly string[]).includes(String(item)));
}

function parseProductModel(row: RawProductModel): WorkBuddyModelDefinition | undefined {
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) return undefined;
  const contextWindow = positiveNumber(row.maxInputTokens) ?? 0;
  const maxTokens = positiveNumber(row.maxOutputTokens) ?? 0;
  if (contextWindow <= 0 || maxTokens <= 0) return undefined;
  const reasoning = row.supportsReasoning === true;
  const efforts = reasoning ? parseEfforts(row.reasoning?.supportedEfforts) : [];
  return {
    id,
    name: typeof row.name === "string" && row.name !== "" ? row.name : id,
    reasoning,
    efforts: reasoning && efforts.length === 0 ? [...DEFAULT_EFFORTS] : efforts,
    input: row.supportsImages === true && row.disabledMultimodal !== true ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens,
    credits: typeof row.credits === "string" && row.credits.trim() !== "" ? row.credits.trim() : undefined,
  };
}

function productConfigPath(): string {
  const override = readEnvSafe("WORKBUDDYAI_PRODUCT_CONFIG");
  if (override) return override;
  return join(homedir(), ".workbuddy-ai", "cache", "acc-product-config-v3.json");
}

function loadProductConfigModels(): WorkBuddyModelDefinition[] | undefined {
  try {
    const file = productConfigPath();
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return undefined;
    const models = parsed.models
      .map((row) => parseProductModel((row ?? {}) as RawProductModel))
      .filter((model): model is WorkBuddyModelDefinition => model !== undefined);
    if (models.length === 0) return undefined;
    logPlugin(`models: ${models.length} entries from product config cache`);
    return models;
  } catch {
    return undefined;
  }
}

function buildModelTable(): WorkBuddyModelDefinition[] {
  const byId = new Map<string, WorkBuddyModelDefinition>();
  for (const model of BUNDLED_MODELS) byId.set(model.id, model);
  // The cache is the fresher authority for ids it covers; the bundled table
  // backfills ids the cache does not list (and carries the whole table when
  // the cache is absent -- a machine without the desktop app installed).
  const cached = loadProductConfigModels();
  if (cached) for (const model of cached) byId.set(model.id, model);
  return [...byId.values()];
}

export const WORKBUDDY_MODELS: WorkBuddyModelDefinition[] = buildModelTable();

export function getModelDefinition(modelID: string): WorkBuddyModelDefinition | undefined {
  return WORKBUDDY_MODELS.find((model) => model.id === modelID);
}

export function displayName(model: WorkBuddyModelDefinition): string {
  const parts: string[] = [];
  if (model.credits) parts.push(model.credits);
  const mega = model.contextWindow >= 1_000_000 ? "1M" : `${Math.round(model.contextWindow / 1000)}K`;
  parts.push(mega);
  return parts.length > 0 ? `${model.name} (${parts.join(", ")})` : model.name;
}
