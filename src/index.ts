import { type Hooks, type PluginOptions, tool } from "@opencode-ai/plugin";
import type { PluginContext } from "@opencode-ai/plugin/v2/promise";
import {
  parseWorkBuddyAuth,
  pollPluginCredential,
  resolveWorkBuddyCredentials,
  startPluginLogin,
  type WorkBuddyProviderOptions,
} from "./auth.js";
import {
  PROVIDER_ID,
  PROVIDER_NAME,
  USER_AGENT,
  WORKBUDDY_BASE_URL_ENV,
  WORKBUDDY_INTL_BASE,
  ZERO_COST,
} from "./constants.js";
import { readEnvSafe } from "./env-helpers.js";
import { createWorkBuddy, WorkBuddyLanguageModel } from "./language-model.js";
import { errorMessage, logPlugin } from "./log.js";
import { displayName, WORKBUDDY_MODELS, type WorkBuddyModelDefinition } from "./models.js";

export { createWorkBuddy, WorkBuddyLanguageModel };

type WorkBuddyPluginOptions = PluginOptions & {
  providerID?: string;
  setDefault?: boolean;
  apiKey?: string;
  userID?: string;
  baseUrl?: string;
};

function optionString(options: PluginOptions | undefined, key: keyof WorkBuddyPluginOptions): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function providerID(options?: PluginOptions): string {
  return optionString(options, "providerID") || PROVIDER_ID;
}

// The limits opencode acts on. context drives the window, input drives the
// auto-compaction threshold -- for the 1M models BOTH are a million, so a
// conversation genuinely runs to ~1M tokens before compaction instead of the
// legacy 200k cliff. WorkBuddy needs no wire parameter for this: 1M is the
// model's native budget (deepseek-v4-pro/flash, glm-5.2, kimi-k3-1).
function modelLimit(model: WorkBuddyModelDefinition): { context: number; input: number; output: number } {
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
    config.variants = Object.fromEntries(model.efforts.map((effort) => [effort, { reasoningEffort: effort }]));
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

function applyLegacyConfig(cfg: LegacyConfig, options?: PluginOptions): void {
  const id = providerID(options);
  cfg.provider ??= {};
  cfg.provider[id] ??= {};
  const current = cfg.provider[id];
  current.name ??= PROVIDER_NAME;
  current.npm ??= import.meta.url;
  current.options ??= {};
  const apiKey = optionString(options, "apiKey");
  if (apiKey && current.options.apiKey === undefined) current.options.apiKey = apiKey;
  const userID = optionString(options, "userID");
  if (userID && current.options.userID === undefined) current.options.userID = userID;
  const baseUrl = optionString(options, "baseUrl");
  if (baseUrl && current.options.baseUrl === undefined) current.options.baseUrl = baseUrl;
  current.options.baseURL ??= loginBase();
  current.models ??= {};
  for (const model of WORKBUDDY_MODELS) {
    current.models[model.id] = { ...legacyModelConfig(model), ...(current.models[model.id] ?? {}) };
  }
  if (options?.setDefault === true && !cfg.model) cfg.model = `${id}/hy3`;
  logPlugin(`legacy: registered ${WORKBUDDY_MODELS.length} models (1M tier included)`);

  // Subagents on the free model; the main agent keeps the user's choice.
  cfg.agent ??= {};
  const agents = cfg.agent;
  const ensureAgent = (name: string, value: LegacyAgentConfig): void => {
    if (agents[name] || cfg.agents?.[name]) return;
    agents[name] = value;
  };
  ensureAgent("plan", { model: `${id}/hy3` });
  ensureAgent("general", { model: `${id}/hy3` });
  ensureAgent("explore", { model: `${id}/hy3` });
  ensureAgent("title", { model: `${id}/hy3` });
  // Compaction sees the WHOLE conversation: pin it to a 1M-capable model so a
  // 1M chat can still compact without escalating anything.
  ensureAgent("compaction", { model: `${id}/hy3` });
}

function v2ModelConfig(model: WorkBuddyModelDefinition) {
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
      url: loginBase(),
      settings: {},
    },
    capabilities: { tools: true, input: model.input, output: ["text"] },
    variants: model.efforts.map((effort) => ({ id: effort, headers: {}, body: { reasoningEffort: effort } })),
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active" as const,
    enabled: true,
    limit: modelLimit(model),
  };
}

// The login/refresh base URL. The international product is the default; a CN
// desktop login (domain www.workbuddy.cn) is discovered from the desktop
// auth file at request time -- only chat/refresh need the right host, and
// auth.ts derives it from the credential. The browser-login picker needs an
// explicit host, so override with WORKBUDDY_BASE_URL for CN.
function loginBase(): string {
  return (readEnvSafe(WORKBUDDY_BASE_URL_ENV) || WORKBUDDY_INTL_BASE).replace(/\/+$/, "");
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

async function setupV2(ctx: PluginContext): Promise<void> {
  const id = providerID(ctx.options);
  logPlugin("setup[v2]: begin");
  try {
    await ctx.integration.transform((integrations) => {
      integrations.update(id, (integration) => {
        integration.name = PROVIDER_NAME;
      });
      integrations.method.update({
        integrationID: id,
        method: { type: "key", label: "WorkBuddy Access Token (token|uid|base optional)" },
      });
    });
    logPlugin("setup[v2]: integration ok");

    await ctx.catalog.transform((catalog) => {
      catalog.provider.update(id, (provider) => {
        provider.name = PROVIDER_NAME;
        provider.integrationID = id;
        provider.api = { type: "aisdk", package: import.meta.url, url: loginBase(), settings: {} };
        provider.request = { headers: {}, body: {} };
        const apiKey = optionString(ctx.options, "apiKey");
        if (apiKey) provider.request.body.apiKey = apiKey;
      });
      for (const model of WORKBUDDY_MODELS) {
        catalog.model.update(id, model.id, (draft) => {
          Object.assign(draft, v2ModelConfig(model));
        });
      }
      if (ctx.options?.setDefault === true) catalog.model.default.set(id, "hy3");
    });
    logPlugin("setup[v2]: catalog ok");

    await ctx.aisdk.language(async (event) => {
      try {
        if (event.model.providerID !== id) return;
        const connection = await ctx.integration.connection
          .active(id)
          .then(async (active) =>
            active ? ((await ctx.integration.connection.resolve(active)) as StoredCredentialShape | undefined) : undefined,
          )
          .catch(() => undefined);
        const options = connection ? storedToOptions(connection) : {};
        event.language = new WorkBuddyLanguageModel(String(event.model.api?.id ?? event.model.id), {
          ...options,
          apiKey: options.apiKey || optionString(ctx.options, "apiKey") || event.options.apiKey,
          baseUrl: options.baseUrl || optionString(ctx.options, "baseUrl"),
        });
        logPlugin(`setup[v2]: language handler hit model=${event.model.id}`);
      } catch (error) {
        logPlugin(`setup[v2]: language handler error: ${errorMessage(error)}`);
        throw error;
      }
    });
    logPlugin("setup[v2]: complete");
  } catch (error) {
    logPlugin(`setup[v2]: FAILED -- ${errorMessage(error)}`);
    throw error;
  }
}

function legacyHooks(options?: PluginOptions): Hooks {
  const id = providerID(options);
  return {
    config: async (cfg) => applyLegacyConfig(cfg as unknown as LegacyConfig, options),
    auth: {
      provider: id,
      loader: async (auth) => {
        const stored = (await auth()) as StoredCredentialShape | undefined;
        return stored ? storedToOptions(stored) : {};
      },
      methods: [
        {
          type: "api",
          label: "Access Token (token|uid|base optional)",
        },
        {
          type: "oauth",
          label: "Browser Login (WorkBuddy AI)",
          authorize: async () => {
            const base = loginBase();
            try {
              const { state, authUrl } = await startPluginLogin(base);
              return {
                url: authUrl,
                instructions: "Complete the WorkBuddy login in the browser, then return to opencode.",
                method: "auto" as const,
                callback: async () => {
                  try {
                    const cred = await pollPluginCredential(state, base);
                    return {
                      type: "success" as const,
                      provider: id,
                      refresh: cred.refreshToken,
                      access: cred.accessToken,
                      expires: cred.expiresAtMs,
                      accountId: cred.uid,
                      metadata: { userID: cred.uid, baseUrl: cred.domain ? `https://${cred.domain}` : base },
                    };
                  } catch (error) {
                    logPlugin(`auth: browser login failed: ${error instanceof Error ? error.message : String(error)}`);
                    return { type: "failed" as const };
                  }
                },
              };
            } catch (error) {
              logPlugin(`auth: login start failed: ${error instanceof Error ? error.message : String(error)}`);
              return { url: base, instructions: "WorkBuddy login start failed; check WORKBUDDY_BASE_URL.", method: "auto" as const, callback: async () => ({ type: "failed" as const }) };
            }
          },
        },
      ],
    },
    tool: {
      workbuddy_account: tool({
        description:
          "Show the WorkBuddy credential currently in effect: token shape (never the value), account uid, " +
          "expiry, resolved base URL and the credential source. Use when auth fails or the user asks which " +
          "WorkBuddy account is active.",
        args: {},
        execute: async () => {
          try {
            const cred = await resolveWorkBuddyCredentials({});
            const base = cred.domain ? `https://${cred.domain}` : WORKBUDDY_INTL_BASE;
            return {
              output:
                `uid=${cred.uid || "(none)"} nickname=${cred.nickname ?? "(none)"}\n` +
                `expires ${cred.expiresAtMs ? new Date(cred.expiresAtMs).toISOString() : "unknown"}\n` +
                `base ${base} · UA ${USER_AGENT}`,
              data: { uid: cred.uid, expiresAtMs: cred.expiresAtMs, base },
            };
          } catch (error) {
            return { output: `Not authenticated: ${error instanceof Error ? error.message : String(error)}`, data: { ok: false } };
          }
        },
      }),
    },
  };
}

const plugin = {
  id: "opencode-workbuddy-connect",
  setup: setupV2,
  server: async (_input: unknown, options?: PluginOptions) => legacyHooks(options),
};

export default plugin;

// Re-exported for tooling that wants the credential-file parser.
export { parseWorkBuddyAuth };
