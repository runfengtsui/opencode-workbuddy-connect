import { type Hooks, type PluginInput, type PluginOptions, tool } from "@opencode-ai/plugin";
import type { PluginContext } from "@opencode-ai/plugin/v2/promise";
import {
  parseWorkBuddyAuth,
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
  type WBRegion,
  WORKBUDDY_BASE_URL_ENV,
  WORKBUDDY_CN_BASE,
  WORKBUDDY_INTL_BASE,
  ZERO_COST,
} from "./constants.js";
import { readEnvSafe } from "./env-helpers.js";
import { createWorkBuddy, WorkBuddyLanguageModel } from "./language-model.js";
import {
  errorMessage,
  installLogSink,
  type LogClient,
  logError,
  logInfo,
  logPlugin,
} from "./log.js";
import { defaultModelID, displayName, type WorkBuddyModelDefinition } from "./models.js";
import { dailyCheckin, fetchQuota, formatQuota } from "./quota.js";

export { createWorkBuddy, WorkBuddyLanguageModel };

type WorkBuddyPluginOptions = PluginOptions & {
  /** Integration point. Set by the region instance; a tuple-form entry may
   * override it, which is also what re-points the model table and token env. */
  region?: WBRegion;
  providerID?: string;
  providerName?: string;
  storeName?: string;
  setDefault?: boolean;
  apiKey?: string;
  userID?: string;
  baseUrl?: string;
};

// ---------------------------------------------------------------------------
// Integration points (接入点). AuthHook binds ONE provider per plugin instance,
// so each region is its own instance: two plugin files, two createPlugin()
// calls. Everything region-specific lives here.
// ---------------------------------------------------------------------------

interface Region {
  /** opencode plugin module id -- must differ per instance. */
  moduleID: string;
  /** Which model catalogue, token env and desktop cache this instance reads. */
  region: WBRegion;
  providerID: string;
  providerName: string;
  /** Own-credential-store file, so a CN login never clobbers an intl one. */
  storeName: string;
  /** Pinned login base. INTL leaves this unset so WORKBUDDY_BASE_URL still
   * wins (legacy escape hatch); CN always pins *.workbuddy.cn. */
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

function optionString(
  options: PluginOptions | undefined,
  key: keyof WorkBuddyPluginOptions,
): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function providerID(options?: PluginOptions): string {
  return optionString(options, "providerID") || PROVIDER_ID;
}

function providerName(options?: PluginOptions): string {
  return optionString(options, "providerName") || PROVIDER_NAME;
}

/** The integration point these options describe. An explicit `region` wins,
 * then the provider id -- so a hand-authored shim still gets the right table. */
function regionOf(options?: PluginOptions): WBRegion {
  const explicit = optionString(options, "region");
  if (explicit === "cn" || explicit === "intl") return explicit;
  return providerID(options) === PROVIDER_ID_CN ? "cn" : "intl";
}

// The login/refresh base URL: an explicit option (a pinned region sets one)
// beats WORKBUDDY_BASE_URL, which beats the international default. A CN
// desktop login (domain www.workbuddy.cn) is discovered at request time;
// auth.ts routes chat/refresh from the credential's domain.
function loginBase(options?: PluginOptions): string {
  return (
    optionString(options, "baseUrl") ||
    readEnvSafe(WORKBUDDY_BASE_URL_ENV) ||
    WORKBUDDY_INTL_BASE
  ).replace(/\/+$/, "");
}

// The limits opencode acts on. context drives the window, input drives the
// auto-compaction threshold -- for the 1M models BOTH are a million, so a
// conversation genuinely runs to ~1M tokens before compaction instead of the
// legacy 200k cliff. WorkBuddy needs no wire parameter for this: 1M is the
// model's native budget (deepseek-v4-pro/flash, glm-5.2, kimi-k3-1).
function modelLimit(model: WorkBuddyModelDefinition): {
  context: number;
  input: number;
  output: number;
} {
  return { context: model.contextWindow, input: model.contextWindow, output: model.maxTokens };
}

function legacyModelConfig(model: WorkBuddyModelDefinition): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: displayName(model),
    reasoning: model.reasoning,
    tool_call: true,
    attachment: model.input.includes("image"),
    cost: ZERO_COST,
    limit: modelLimit(model),
    modalities: { input: model.input, output: ["text"] },
  };
  // Thinking-strength picker: v1 Record form survives opencode's config
  // schema and rides the request as body.reasoningEffort.
  if (model.efforts.length > 0) {
    config.variants = Object.fromEntries(
      model.efforts.map((effort) => [effort, { reasoningEffort: effort }]),
    );
  }
  return config;
}

interface LegacyProviderConfig {
  name?: string;
  env?: string[];
  npm?: string;
  options?: Record<string, unknown>;
  models?: Record<string, Record<string, unknown>>;
}
interface LegacyConfig {
  provider?: Record<string, LegacyProviderConfig>;
  model?: string;
  agent?: Record<string, LegacyAgentConfig>;
  agents?: Record<string, LegacyAgentConfig>;
}
interface LegacyAgentConfig {
  model?: string;
  variant?: string;
}

async function applyLegacyConfig(cfg: LegacyConfig, options?: PluginOptions): Promise<void> {
  const id = providerID(options);
  const region = regionOf(options);
  cfg.provider ??= {};
  cfg.provider[id] ??= {};
  const current = cfg.provider[id];
  current.name ??= providerName(options);
  current.npm ??= import.meta.url;
  current.options ??= {};
  // The npm loader calls createWorkBuddy(current.options); these three are
  // what put the RIGHT store, host and provider label on every request.
  if (current.options.providerID === undefined) current.options.providerID = id;
  if (current.options.region === undefined) current.options.region = region;
  const store = optionString(options, "storeName");
  if (store && current.options.storeName === undefined) current.options.storeName = store;
  const apiKey = optionString(options, "apiKey");
  if (apiKey && current.options.apiKey === undefined) current.options.apiKey = apiKey;
  const userID = optionString(options, "userID");
  if (userID && current.options.userID === undefined) current.options.userID = userID;
  const baseUrl = optionString(options, "baseUrl");
  if (baseUrl && current.options.baseUrl === undefined) current.options.baseUrl = baseUrl;
  current.options.baseURL ??= loginBase(options);
  current.models ??= {};
  // Ask the endpoint for the models this credential can actually buy first; on
  // any failure this falls back to the per-region static table (never throws).
  const models = await refreshModelCatalogue(region, {
    apiKey: optionString(options, "apiKey"),
    userID: optionString(options, "userID"),
    baseUrl: optionString(options, "baseUrl"),
    storeName: store,
    providerID: id,
  });
  for (const model of models) {
    current.models[model.id] = { ...legacyModelConfig(model), ...(current.models[model.id] ?? {}) };
  }
  const pin = `${id}/${defaultModelID(region)}`;
  if (options?.setDefault === true && !cfg.model) cfg.model = pin;
  logInfo(`legacy: registered ${models.length} models for ${region} (1M tier included)`);

  // Subagents on the free model; the main agent keeps the user's choice.
  cfg.agent ??= {};
  const agents = cfg.agent;
  const ensureAgent = (name: string, value: LegacyAgentConfig): void => {
    if (agents[name] || cfg.agents?.[name]) return;
    agents[name] = value;
  };
  ensureAgent("plan", { model: pin });
  ensureAgent("general", { model: pin });
  ensureAgent("explore", { model: pin });
  ensureAgent("title", { model: pin });
  // Compaction sees the WHOLE conversation: pin it to a 1M-capable model so a
  // 1M chat can still compact without escalating anything.
  ensureAgent("compaction", { model: pin });
}

function v2ModelConfig(model: WorkBuddyModelDefinition, options?: PluginOptions) {
  return {
    name: displayName(model),
    family: model.id,
    api: {
      id: model.id,
      type: "aisdk" as const,
      // Must be this plugin's own module URL: opencode resolves the SDK by
      // package and calls its first `create*` export (createWorkBuddy), which
      // puts WorkBuddyLanguageModel on the wire instead of the generic
      // openai-compatible client.
      package: import.meta.url,
      url: loginBase(options),
      settings: {},
    },
    capabilities: { tools: true, input: model.input, output: ["text"] },
    variants: model.efforts.map((effort) => ({
      id: effort,
      headers: {},
      body: { reasoningEffort: effort },
    })),
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active" as const,
    enabled: true,
    limit: modelLimit(model),
  };
}

interface StoredCredentialShape {
  type?: string;
  key?: string;
  access?: string;
  refresh?: string;
  accountId?: string;
  metadata?: Record<string, unknown>;
}

function storedToOptions(stored: StoredCredentialShape): WorkBuddyProviderOptions {
  if (stored.type === "oauth") {
    const metadata = stored.metadata ?? {};
    return {
      apiKey: stored.access,
      userID: typeof metadata.userID === "string" ? metadata.userID : stored.accountId,
      baseUrl: typeof metadata.baseUrl === "string" ? metadata.baseUrl : undefined,
    };
  }
  if (stored.type === "key" || stored.type === "api") {
    // The "api"/"key" method stores a raw token (optionally
    // "token|uid|base" for hand-pasted CN credentials).
    const raw = stored.key ?? "";
    const [token, uid, base] = raw.split("|");
    return {
      apiKey: token || undefined,
      userID: uid || undefined,
      baseUrl: base || undefined,
    };
  }
  return {};
}

async function setupV2(ctx: PluginContext, opts: WorkBuddyPluginOptions): Promise<void> {
  const id = providerID(opts);
  const name = providerName(opts);
  logInfo(`setup[v2]: begin (${id})`);
  try {
    await ctx.integration.transform((integrations) => {
      integrations.update(id, (integration) => {
        integration.name = name;
      });
      integrations.method.update({
        integrationID: id,
        method: { type: "key", label: `${name} Access Token (token|uid|base optional)` },
      });
    });
    logPlugin("setup[v2]: integration ok");

    const region = regionOf(opts);
    const models = await refreshModelCatalogue(region, {
      apiKey: optionString(opts, "apiKey"),
      userID: optionString(opts, "userID"),
      baseUrl: optionString(opts, "baseUrl"),
      storeName: optionString(opts, "storeName"),
      providerID: id,
    });
    await ctx.catalog.transform((catalog) => {
      catalog.provider.update(id, (provider) => {
        provider.name = name;
        provider.integrationID = id;
        provider.api = {
          type: "aisdk",
          package: import.meta.url,
          url: loginBase(opts),
          settings: {},
        };
        provider.request = { headers: {}, body: {} };
        const apiKey = optionString(opts, "apiKey");
        if (apiKey) provider.request.body.apiKey = apiKey;
      });
      for (const model of models) {
        catalog.model.update(id, model.id, (draft) => {
          Object.assign(draft, v2ModelConfig(model, opts));
        });
      }
      if (opts.setDefault === true) catalog.model.default.set(id, defaultModelID(region));
    });
    logPlugin(`setup[v2]: catalog ok (${models.length} models, ${region})`);

    await ctx.aisdk.language(async (event) => {
      try {
        if (event.model.providerID !== id) return;
        const connection = await ctx.integration.connection
          .active(id)
          .then(async (active) =>
            active
              ? ((await ctx.integration.connection.resolve(active)) as
                  | StoredCredentialShape
                  | undefined)
              : undefined,
          )
          .catch(() => undefined);
        const stored = connection ? storedToOptions(connection) : {};
        event.language = new WorkBuddyLanguageModel(String(event.model.api?.id ?? event.model.id), {
          ...stored,
          apiKey: stored.apiKey || optionString(opts, "apiKey") || event.options.apiKey,
          baseUrl: stored.baseUrl || optionString(opts, "baseUrl"),
          storeName: stored.storeName || optionString(opts, "storeName"),
          providerID: id,
        });
        logPlugin(`setup[v2]: language handler hit model=${event.model.id}`);
      } catch (error) {
        logError(`setup[v2]: language handler error: ${errorMessage(error)}`);
        throw error;
      }
    });
    logPlugin("setup[v2]: complete");
  } catch (error) {
    logError(`setup[v2]: FAILED -- ${errorMessage(error)}`);
    throw error;
  }
}

function legacyHooks(options?: WorkBuddyPluginOptions): Hooks {
  const id = providerID(options);
  const name = providerName(options);
  const store = optionString(options, "storeName");
  const accountTool = `${id.replace(/-/g, "_")}_account`;
  const quotaTool = `${id.replace(/-/g, "_")}_quota`;
  const checkinTool = `${id.replace(/-/g, "_")}_checkin`;
  const region = regionOf(options);
  const billingOpts = (): WorkBuddyProviderOptions => ({
    apiKey: optionString(options, "apiKey"),
    userID: optionString(options, "userID"),
    baseUrl: optionString(options, "baseUrl"),
    storeName: store,
    providerID: id,
  });
  return {
    config: async (cfg) => applyLegacyConfig(cfg as unknown as LegacyConfig, options),
    auth: {
      provider: id,
      loader: async (auth) => {
        const stored = (await auth()) as StoredCredentialShape | undefined;
        const fromStored = stored ? storedToOptions(stored) : {};
        const resolved: WorkBuddyProviderOptions = {
          ...fromStored,
          baseUrl: fromStored.baseUrl || optionString(options, "baseUrl"),
          storeName: store,
          providerID: id,
        };
        return resolved as Record<string, unknown>;
      },
      methods: [
        {
          type: "api",
          label: `${name} Access Token (token|uid|base optional)`,
        },
        {
          type: "oauth",
          label: `Browser Login (${name})`,
          authorize: async () => {
            const base = loginBase(options);
            try {
              const { state, authUrl } = await startPluginLogin(base);
              return {
                url: authUrl,
                instructions: `Complete the ${name} login in the browser, then return to opencode.`,
                method: "auto" as const,
                callback: async () => {
                  try {
                    const cred = await pollPluginCredential(state, base, store);
                    return {
                      type: "success" as const,
                      provider: id,
                      refresh: cred.refreshToken,
                      access: cred.accessToken,
                      expires: cred.expiresAtMs,
                      accountId: cred.uid,
                      metadata: {
                        userID: cred.uid,
                        baseUrl: cred.domain ? `https://${cred.domain}` : base,
                      },
                    };
                  } catch (error) {
                    logError(
                      `auth: browser login failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    return { type: "failed" as const };
                  }
                },
              };
            } catch (error) {
              logError(
                `auth: login start failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              return {
                url: base,
                instructions: `${name} login start failed; check WORKBUDDY_BASE_URL / provider options.`,
                method: "auto" as const,
                callback: async () => ({ type: "failed" as const }),
              };
            }
          },
        },
      ],
    },
    tool: {
      [accountTool]: tool({
        description:
          `Show the ${name} credential currently in effect: token shape (never the value), account uid, ` +
          "expiry, resolved base URL and the credential source. Use when auth fails or the user asks which " +
          `${name} account is active.`,
        args: {},
        execute: async () => {
          try {
            const cred = await resolveWorkBuddyCredentials({
              apiKey: optionString(options, "apiKey"),
              userID: optionString(options, "userID"),
              baseUrl: optionString(options, "baseUrl"),
              storeName: store,
              providerID: id,
            });
            const base = cred.domain ? `https://${cred.domain}` : loginBase(options);
            return {
              output:
                `provider=${id}\n` +
                `uid=${cred.uid || "(none)"} nickname=${cred.nickname ?? "(none)"}\n` +
                `expires ${cred.expiresAtMs ? new Date(cred.expiresAtMs).toISOString() : "unknown"}\n` +
                `base ${base} · UA ${USER_AGENT}`,
              data: { providerID: id, uid: cred.uid, expiresAtMs: cred.expiresAtMs, base },
            };
          } catch (error) {
            return {
              output: `Not authenticated: ${error instanceof Error ? error.message : String(error)}`,
              data: { ok: false },
            };
          }
        },
      }),
      [quotaTool]: tool({
        description:
          `Read the ${name} account's remaining credits across every active ` +
          "package: per-instance grant, remaining/total, expiry, and the " +
          "earliest expiring. Never reports the token. Use when the user asks " +
          "about balance, quota, 额度 / 配额 / 余额 / credits, or whether they " +
          "can afford a paid model.",
        args: {},
        execute: async () => {
          // Last-line defence. fetchQuota/dailyCheckin already swallow every
          // network fault, so nothing here should throw -- but this is an
          // account-information tool bolted onto a chat plugin, and a future
          // refactor must never be able to surface an exception into the tool
          // dispatcher and disturb the session.
          try {
            const report = await fetchQuota(region, billingOpts());
            const packages = report.packages.map((p) => ({
              code: p.code,
              name: p.name,
              unit: p.unit,
              remain: p.remain,
              total: p.total,
              used: p.used,
              status: p.status,
              expiresAtMs: p.expiresAtMs,
            }));
            return {
              output: formatQuota(report),
              data: {
                ok: report.ok,
                region,
                disabled: report.disabled ?? false,
                totalRemain: report.totalRemain,
                totalCapacity: report.totalCapacity,
                soonestExpiryMs: report.soonestExpiryMs,
                packages,
                ...(report.error ? { error: report.error } : {}),
              },
            };
          } catch (error) {
            return {
              output: `Balance unavailable: ${error instanceof Error ? error.message : String(error)}`,
              data: { ok: false, region, packages: [] },
            };
          }
        },
      }),
      [checkinTool]: tool({
        description:
          `Claim today's daily check-in credits on the ${name} account. This is ` +
          "a MUTATION (minted as a fresh 100-credit instance per gateway " +
          "policy) but is idempotent: a second call today reports status " +
          "`already` with no side effect. Use only when the user explicitly " +
          "asks to check in / 签到 / 领积分.",
        args: {},
        execute: async () => {
          try {
            const result = await dailyCheckin(region, billingOpts());
            const lines = [`checkin[${region}]: ${result.status} -- ${result.message}`];
            let balance: number | undefined;
            if (result.status === "claimed") {
              // Only worth a second request if this call actually minted credits.
              const follow = await fetchQuota(region, billingOpts());
              balance = follow.totalRemain;
              if (follow.ok) {
                lines.push(
                  `balance now: ${follow.totalRemain}/${follow.totalCapacity} credits across ${follow.packages.length} packages`,
                );
              }
            }
            return {
              output: lines.join("\n"),
              data: { status: result.status, region, message: result.message, balance },
            };
          } catch (error) {
            // Same contract as the balance tool: a check-in that cannot run is
            // reported, never thrown. The campaign may vanish entirely and the
            // plugin must keep working.
            return {
              output: `checkin[${region}]: failed (${error instanceof Error ? error.message : String(error)})`,
              data: { status: "failed", region },
            };
          }
        },
      }),
    },
  };
}

export type WorkBuddyRegion = "intl" | "cn";

/**
 * Build one integration point. AuthHook binds a single provider, so the
 * international and CN endpoints are two instances of this module.
 *
 * NOTE the name: opencode's legacy npm loader calls the module's FIRST
 * `create*` export (namespace keys sort alphabetically, so `createPlugin`
 * would win over `createWorkBuddy`) and expects an AI-SDK provider with
 * `.languageModel()`. Only createWorkBuddy may carry that prefix.
 */
export function definePlugin(region: WorkBuddyRegion = "intl") {
  const r = region === "cn" ? CN_REGION : INTL_REGION;
  return {
    id: r.moduleID,
    setup: (ctx: PluginContext) => setupV2(ctx, withRegion(r, ctx.options)),
    server: async (input: PluginInput, options?: PluginOptions) => {
      // First thing that happens: route the trace into opencode's own log
      // file so a normal session shows only real problems on screen.
      installLogSink(input?.client as LogClient | undefined);
      return legacyHooks(withRegion(r, options));
    },
  };
}

export default definePlugin("intl");

// Re-exported for tooling that wants the credential-file parser.
export { parseWorkBuddyAuth };
