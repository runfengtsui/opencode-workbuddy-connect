import type { Plugin, PluginOptions } from "@opencode/plugin";

type PluginContext = Plugin.Context;
import {
  hasWorkBuddyCredentials,
  pollPluginCredential,
  resolveWorkBuddyCredentials,
  startPluginLogin,
  type WorkBuddyProviderOptions,
} from "./auth.js";
import { refreshModelCatalogue } from "./catalogue.js";
import {
  CN_STORE_NAME,
  INTL_STORE_NAME,
  PROVIDER_ID,
  PROVIDER_ID_CN,
  PROVIDER_NAME,
  USER_AGENT,
  WORKBUDDY_CN_BASE,
  WORKBUDDY_INTL_BASE,
  type WBRegion,
} from "./constants.js";
import { readEnvSafe } from "./env-helpers.js";
import { createWorkBuddy, WorkBuddyLanguageModel } from "./language-model.js";
import { errorMessage, logError, logInfo, logPlugin, logWarn } from "./log.js";
import {
  defaultModelID,
  displayName,
  OFFLINE_MODEL,
  type WorkBuddyModelDefinition,
} from "./models.js";
import { dailyCheckin, fetchQuota, formatQuota } from "./quota.js";

export { createWorkBuddy, WorkBuddyLanguageModel };
export { parseWorkBuddyAuth } from "./auth.js";
export type WorkBuddyRegion = "intl" | "cn";

export type WorkBuddyPluginOptions = PluginOptions & {
  region?: WBRegion;
  providerID?: string;
  providerName?: string;
  storeName?: string;
  setDefault?: boolean;
  apiKey?: string;
  userID?: string;
  baseUrl?: string;
};

interface Region {
  moduleID: string;
  region: WBRegion;
  providerID: string;
  providerName: string;
  storeName: string;
  baseUrl?: string;
}

const INTL_REGION: Region = {
  moduleID: "opencode-workbuddy-connect",
  region: "intl",
  providerID: PROVIDER_ID,
  providerName: PROVIDER_NAME,
  storeName: INTL_STORE_NAME,
};

const CN_REGION: Region = {
  moduleID: "opencode-workbuddy-connect-cn",
  region: "cn",
  providerID: PROVIDER_ID_CN,
  providerName: `${PROVIDER_NAME} (CN)`,
  storeName: CN_STORE_NAME,
  baseUrl: WORKBUDDY_CN_BASE,
};

function withRegion(region: Region, options?: PluginOptions): WorkBuddyPluginOptions {
  return {
    region: region.region,
    providerID: region.providerID,
    providerName: region.providerName,
    storeName: region.storeName,
    ...(region.baseUrl ? { baseUrl: region.baseUrl } : {}),
    ...(options as WorkBuddyPluginOptions | undefined),
  };
}

function str(options: PluginOptions | undefined, key: keyof WorkBuddyPluginOptions): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The integration point these options describe. An explicit `region` wins,
 * then the provider id. */
function regionOf(options?: PluginOptions): WBRegion {
  const explicit = str(options, "region");
  if (explicit === "cn" || explicit === "intl") return explicit;
  return str(options, "providerID") === PROVIDER_ID_CN ? "cn" : "intl";
}

function providerID(options?: PluginOptions): string {
  return str(options, "providerID") || PROVIDER_ID;
}

function providerName(options?: PluginOptions): string {
  return str(options, "providerName") || PROVIDER_NAME;
}

function loginBase(options?: PluginOptions): string {
  return (
    str(options, "baseUrl") ||
    readEnvSafe("WORKBUDDY_BASE_URL") ||
    (regionOf(options) === "cn" ? WORKBUDDY_CN_BASE : WORKBUDDY_INTL_BASE)
  ).replace(/\/+$/, "");
}

/** The limits opencode acts on. context/input both drive the 1M compaction
 * threshold; WorkBuddy needs no wire parameter for a 1M window. */
function modelLimit(model: WorkBuddyModelDefinition): { context: number; input: number; output: number } {
  return { context: model.contextWindow, input: model.contextWindow, output: model.maxTokens };
}

function coreOptions(options: PluginOptions | undefined, region: WBRegion, storeName: string, baseUrl?: string): WorkBuddyProviderOptions {
  return {
    apiKey: str(options, "apiKey"),
    userID: str(options, "userID"),
    baseUrl,
    storeName,
    providerID: providerID(options),
  };
}

async function credentialFromConnection(
  ctx: PluginContext,
  id: string,
): Promise<{ apiKey?: string; userID?: string; baseUrl?: string }> {
  try {
    const active = await ctx.integration.connection.active(id);
    if (!active) return {};
    const value = await ctx.integration.connection.resolve(active);
    if (!value) return {};
    if (value.type === "oauth") {
      const metadata = (value.metadata ?? {}) as Record<string, unknown>;
      return {
        apiKey: value.access,
        userID: typeof metadata.userID === "string" ? metadata.userID : undefined,
        baseUrl: typeof metadata.baseUrl === "string" ? metadata.baseUrl : undefined,
      };
    }
    if (value.type === "key") {
      const [token, uid, base] = String(value.key ?? "").split("|");
      return { apiKey: token || undefined, userID: uid || undefined, baseUrl: base || undefined };
    }
  } catch {
    /* fall through to the own-store / env / desktop resolution */
  }
  return {};
}

function v2ModelInfo(model: WorkBuddyModelDefinition, id: string): Record<string, unknown> {
  return {
    id: model.id,
    modelID: model.id,
    providerID: id,
    name: displayName(model),
    family: model.id,
    capabilities: { tools: true, input: model.input, output: ["text"] },
    variants: model.efforts.map((effort) => ({
      id: effort,
      headers: {},
      body: { reasoningEffort: effort },
    })),
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: modelLimit(model),
  };
}

/** Register one integration point against the OpenCode v2 plugin context. */
async function setupV2(ctx: PluginContext, opts: WorkBuddyPluginOptions): Promise<void> {
  const options = { ...opts, ...(ctx.options ?? {}) } as WorkBuddyPluginOptions;
  const id = providerID(options);
  const region = regionOf(options);
  const name = providerName(options);
  const storeName = str(options, "storeName") || (region === "cn" ? CN_STORE_NAME : INTL_STORE_NAME);
  const base = loginBase(options);
  const core = coreOptions(options, region, storeName, str(options, "baseUrl"));

  // 1. Integration + authentication methods (browser OAuth + pasted token).
  await ctx.integration.transform((editor) => {
    editor.update(id, (integration) => {
      integration.name = name;
    });
    editor.method.update({
      integrationID: id,
      method: { type: "key", label: `${name} Access Token (token|uid|base optional)` },
    });
    editor.method.update({
      integrationID: id,
      method: { id: "oauth", type: "oauth", label: `Browser Login (${name})` },
      authorize: (async () => {
        const { state, authUrl } = await startPluginLogin(base);
        return {
          url: authUrl,
          instructions: `Complete the ${name} login in the browser, then return to opencode.`,
          mode: "auto" as const,
          callback: (async () => {
            const cred = await pollPluginCredential(state, base, storeName);
            return {
              type: "oauth" as const,
              methodID: "oauth" as never,
              refresh: cred.refreshToken || "",
              access: cred.accessToken,
              expires:
                cred.expiresAtMs > 0
                  ? Math.floor(cred.expiresAtMs)
                  : Math.floor(Date.now() + 7 * 24 * 3600 * 1000),
              metadata: {
                userID: cred.uid,
                baseUrl: cred.domain ? `https://${cred.domain}` : base,
                storeName,
                providerID: id,
              },
            };
          })(),
        };
      }) as never,
    });
  });

  // 2. Provider + model catalogue (live discovery first, static/offline fallback).
  const authenticated = hasWorkBuddyCredentials(core);
  let models: WorkBuddyModelDefinition[];
  if (authenticated) {
    try {
      models = await refreshModelCatalogue(region, core);
    } catch (error) {
      logWarn(`catalogue failed: ${errorMessage(error)}`);
      models = [OFFLINE_MODEL];
    }
  } else {
    models = [OFFLINE_MODEL];
  }
  logInfo(`registering ${models.length} models for ${region}`);

  await ctx.provider.transform((editor) => {
    editor.add({
      info: {
        id,
        name,
        activation: "enabled",
        // The OpenAI-compatible package supplies the wire protocol; the
        // aisdk "language" hook below replaces its model with ours.
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${base}/v2`, apiKey: "placeholder" },
      },
      models: models.map((model) => v2ModelInfo(model, id)),
    } as never);
  });

  // 3. AISDK language hook: use the WorkBuddy LanguageModelV3.
  await ctx.aisdk.hook(
    "language",
    async (event) => {
      if ((event.model as { providerID?: string }).providerID !== id) return;
      try {
        const fromConnection = await credentialFromConnection(ctx, id);
        let resolved: { accessToken: string; uid: string } | undefined;
        try {
          resolved = await resolveWorkBuddyCredentials(core);
        } catch {
          /* unauthenticated: the language model will report the missing credential */
        }
        const modelID = String(
          (event.model as { id?: string; modelID?: string }).id ??
            (event.model as { modelID?: string }).modelID ??
            "",
        );
        event.language = new WorkBuddyLanguageModel(modelID, {
          apiKey: fromConnection.apiKey || resolved?.accessToken || core.apiKey,
          userID: fromConnection.userID || resolved?.uid || core.userID,
          baseUrl: fromConnection.baseUrl || str(options, "baseUrl"),
          storeName,
          providerID: id,
        });
        logPlugin(`language hook: ${modelID}`);
      } catch (error) {
        logError(`language hook failed: ${errorMessage(error)}`);
        throw error;
      }
    },
    { providerID: id },
  );

  // 4. Account tools (account / quota / checkin) via ctx.tool.
  const prefix = id.replace(/-/g, "_");
  const emptyInput = { type: "object", properties: {}, additionalProperties: false } as never;
  await ctx.tool.transform((editor) => {
    editor.add({
      name: `${prefix}_account`,
      description: `Show the ${name} credential currently in effect (token shape, never the value), uid, expiry, base URL and source. Use when auth fails or the user asks which ${name} account is active.`,
      input: emptyInput,
      execute: async () => {
        try {
          const cred = await resolveWorkBuddyCredentials(core);
          const b = cred.domain ? `https://${cred.domain}` : base;
          return {
            content:
              `provider=${id}\n` +
              `uid=${cred.uid || "(none)"}\n` +
              `expires ${cred.expiresAtMs ? new Date(cred.expiresAtMs).toISOString() : "unknown"}\n` +
              `base ${b} · UA ${USER_AGENT}`,
          };
        } catch (error) {
          return { content: `Not authenticated: ${errorMessage(error)}` };
        }
      },
    } as never);
    editor.add({
      name: `${prefix}_quota`,
      description: `Read the ${name} account's remaining credits across every active package. Use when the user asks about balance, quota, 额度 / 配额 / 余额 / credits.`,
      input: emptyInput,
      execute: async () => {
        try {
          return { content: formatQuota(await fetchQuota(region, core)) };
        } catch (error) {
          return { content: `Balance unavailable: ${errorMessage(error)}` };
        }
      },
    } as never);
    editor.add({
      name: `${prefix}_checkin`,
      description: `Claim today's daily check-in credits on the ${name} account. Idempotent; call only when the user explicitly asks to check in / 签到 / 领积分.`,
      input: emptyInput,
      execute: async () => {
        try {
          const result = await dailyCheckin(region, core);
          return { content: `checkin[${region}]: ${result.status} -- ${result.message}` };
        } catch (error) {
          return { content: `checkin[${region}]: failed (${errorMessage(error)})` };
        }
      },
    } as never);
  });

  // 5. Optional default model.
  if (options.setDefault === true) {
    await ctx.model.transform((editor) => {
      editor.default.set(id, defaultModelID(region));
    });
  }

  logPlugin("setup[v2]: complete");
}

/**
 * Build one integration point. Auth binds a single provider per instance, so
 * the international and CN endpoints use separate instances of this module.
 */
export function definePlugin(region: WorkBuddyRegion = "intl") {
  const r = region === "cn" ? CN_REGION : INTL_REGION;
  return {
    id: r.moduleID,
    setup: (ctx: PluginContext) => setupV2(ctx, withRegion(r, ctx.options)),
  };
}

export default definePlugin("intl");
