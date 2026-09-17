# opencode-workbuddy-connect

English | [简体中文](README.zh-CN.md)

An [opencode](https://opencode.ai) provider plugin that connects [WorkBuddy AI](https://www.workbuddy.ai) — the Tencent CodeBuddy / WorkBuddy assistant models — to opencode as a first-class provider, **including the 1M-token context models**.

Zero-credential setup if you use the WorkBuddy / CodeBuddy desktop app: the plugin auto-discovers its auth file. No API key to paste, no quota to buy.

## Features

- **Real 1M context** — every 1M-tier model is registered with `limit.context = limit.input = 1_000_000`, so opencode compacts at ~1M instead of the 200k default. The 1M window is native to these models; no wire parameter is needed. Six on the international endpoint (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4.1-flash`, `glm-5.2`, `kimi-k3-1`, `hy4-preview-f`) and ten on CN (`hy4-preview`, `hy4-preview-x`, `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `kimi-k3-1`, `kimi-k2.8-preview`, `deepseek-v4-flash`, `deepseek-v4.1-flash`, `deepseek-v4-pro`).
- **Live model discovery** — the plugin asks the gateway which models *your* account can actually buy, at its real token budgets, and merges that over a bundled per-region table. Renames, new releases and context-window changes land without a plugin update, and no discovery failure can affect auth.
- **Pure OpenAI-compatible SSE** against `https://www.workbuddy.{ai|cn}/v2/chat/completions`, with `reasoning_content` streamed as native thinking.
- **Full agentic tool use** — parallel tool calls, streaming tool-argument deltas, and `tool`-role result replay verified against the live gateway.
- **Credential discovery chain** — plugin options → environment → own store → desktop app auth file. Works out of the box next to a logged-in WorkBuddy desktop.
- **Account tools** — read your remaining credits per grant (`_quota`), claim the daily check-in (`_checkin`) and inspect which credential is live (`_account`). Strictly off the request path: every failure is returned as a message rather than thrown, and both billing tools can be switched off by environment variable without a plugin update.
- **Self-healing auth** — a 401/403 triggers one token refresh (via the desktop refresh endpoint) and one automatic replay of the request.
- **Browser login in `opencode auth login`** — OAuth-style login with polling, stored to `~/.config/opencode/workbuddy-auth.json`.
- **Reasoning-effort variants** (`low` / `medium` / `high` / `xhigh` / `max`) exposed as opencode model variants.
- **Loop guard** — the flash models are known to burn budget in `OK / Let me write / Go` reasoning loops; their `max_tokens` is capped at 16,384 per request (upstream behavior copied from the reference adapter).

## Requirements

- opencode with the v2 plugin API (tested on 1.18.30)
- Node.js ≥ 20 (global `fetch`)
- A WorkBuddy account: either the desktop app logged in on this machine, or a token you can paste

## Install

```bash
git clone <this-repo> F:/code/opencode-workbuddy-connect
cd F:/code/opencode-workbuddy-connect
npm install
npm run build
```

Register the plugin in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["F:/code/opencode-workbuddy-connect"]
}
```

The plugin registers itself as provider `workbuddy` and publishes all models automatically.

## Integration points

WorkBuddy has two independent endpoints, and an account on one does **not**
work on the other. The plugin ships both, as two provider ids:

| Provider | Endpoint | Browser Login opens | Credential store |
|---|---|---|---|
| `workbuddy` | `www.workbuddy.ai` (international) | international login | `~/.config/opencode/workbuddy-auth.json` |
| `workbuddy-cn` | `www.workbuddy.cn` (CN) | CN login | `~/.config/opencode/workbuddy-cn-auth.json` |

Each is its own plugin instance with its own login, its own credential store
and its own base URL, so **logging into one never overwrites the other** and
CN traffic can never leak to the international endpoint. Pick by model name:
`workbuddy-cn/hy3` vs `workbuddy/hy3`.

Because an auth hook binds exactly one provider per instance, both endpoints
need two loaded copies of the plugin. Two entry files are already published:

```jsonc
{
  "plugin": [
    ["opencode-workbuddy-connect", {}],
    ["opencode-workbuddy-connect/dist/index.js", { "providerID": "workbuddy-cn", "providerName": "WorkBuddy AI (CN)", "baseUrl": "https://www.workbuddy.cn", "storeName": "workbuddy-cn-auth.json" }]
  ]
}
```

If your opencode loads plugins from `~/.config/opencode/plugin/` instead, drop
in two shim files (one per region) that call the exported factory:

```js
// ~/.config/opencode/plugin/workbuddy.js
import { definePlugin } from "opencode-workbuddy-connect";
export default definePlugin("intl");

// ~/.config/opencode/plugin/workbuddy-cn.js
import { definePlugin } from "opencode-workbuddy-connect";
export default definePlugin("cn");
```

Options passed to an entry always win over the region defaults, so you can pin
a custom `baseUrl` / `storeName` per integration point.

### What shows when nothing is logged in

The model list tracks login state, so it never advertises models the account
cannot actually buy:

- **Neither endpoint logged in** — a single offline placeholder model
  `workbuddy-offline` (named *WorkBuddy (offline — login required)*) is shown,
  proving the plugin loaded; the other endpoint stays silent. Selecting it
  prompts a `/connect` login instead of firing a request that cannot succeed.
- **Exactly one logged in** — only that account's model list is shown; the
  unauthenticated endpoint shows no models.
- **Both logged in** — both endpoints' model lists render normally (each
  independent and region-isolated).

The decision uses a **non-network** credential-existence check (env var / own
store / desktop auth file), so being unauthenticated never pings the endpoint
or logs any login failure.

## Authentication

The first successful source wins, in this order:

1. **Plugin options** — `"options": { "apiKey": "<token>", "userID": "<uid>", "baseUrl": "https://www.workbuddy.cn" }` on the provider (or on the plugin entry in `opencode.json`).
2. **Environment** — `WORKBUDDY_TOKEN` + `WORKBUDDY_UID` for the international point, `WORKBUDDY_CN_TOKEN` + `WORKBUDDY_CN_UID` for the CN one. The split is deliberate: a single token variable would let a CN credential sign international requests (and light up a provider you never logged into). Optionally `WORKBUDDY_BASE_URL` and `WORKBUDDY_AUTH_FILE`.
3. **Own store** — the per-integration-point file from the table above (written by Browser Login below, and by every successful token refresh).
4. **Desktop auth file** — automatically located in
   `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
   (CN desktop, `www.workbuddy.cn`) or `workbuddy-desktop-ai.info` (international).

If you already run the WorkBuddy / CodeBuddy desktop app signed in, **nothing to do** — step 4 signs every request.

### Interactive login

```bash
opencode auth login   # pick "WorkBuddy AI" or "WorkBuddy AI (CN)"
```

Two methods are offered per integration point:

- **Access Token** — paste a raw token; optionally in the form `token|uid|https://www.workbuddy.cn` to pin the account and host.
- **Browser Login** — opens that integration point's own login page and polls for the credential. No environment variable needed: `WorkBuddy AI (CN)` already opens `www.workbuddy.cn`.

## Models

Each integration point has its **own** model table, because the two sites sell different catalogues under the same names.

**`workbuddy` (international)** — 11 models, default `hy3`. All 11 stream reasoning and accept image input:

| Model | Context | Max output | Effort variants | Notes |
|---|---|---|---|---|
| `deepseek-v4-flash` | **1,000,000** | 50,000 | low…max | |
| `deepseek-v4-pro` | **1,000,000** | 50,000 | low…max | |
| `deepseek-v4.1-flash` | **1,000,000** | 128,000 | low…max | free; output capped to 16,384 (loop guard) |
| `glm-5.2` | **1,000,000** | 48,000 | low…max | |
| `kimi-k3-1` | **1,000,000** | 32,000 | low…max | |
| `hy4-preview-f` | **1,000,000** | 64,000 | high | free; international only |
| `minimax-m3` | 512,000 | 128,000 | low…max | |
| `kimi-k2.7` | 256,000 | 32,000 | low…max | |
| `kimi-k2.5` | 256,000 | 32,000 | low…max | |
| `glm-5.1` | 200,000 | 48,000 | low…max | |
| `hy3` | 192,000 | 64,000 | low, high | free |

**`workbuddy-cn` (CN)** — 29 models, default `hy3`. The CN catalogue is mixed: some entries neither stream reasoning nor take images, so capability varies per model rather than being uniform. Notable entries (full list is published at startup):

| Model | Context | Max output | Effort variants |
|---|---|---|---|
| `auto` | 168,000 | 32,000 | low…max |
| `hy3` | 192,000 | 64,000 | low, high |
| `hy3-x` | 192,000 | 64,000 | low, high |
| `hy4-preview` | **1,000,000** | 64,000 | high |
| `hy4-preview-x` | **1,000,000** | 64,000 | high |
| `glm-5.3` | **1,000,000** | 64,000 | low, high, max |
| `glm-5.3-flash` | **1,000,000** | 32,000 | low, high, max |
| `glm-5.2` | **1,000,000** | 64,000 | low…max |
| `kimi-k3-1` | **1,000,000** | 32,000 | low…max |
| `kimi-k2.8-preview` | **1,000,000** | 64,000 | low, high, max |
| `deepseek-v4-flash` | **1,000,000** | 50,000 | low…max |
| `deepseek-v4.1-flash` | **1,000,000** | 128,000 | low, high, max |
| `deepseek-v4-pro` | **1,000,000** | 128,000 | low…max |
| `minimax-m3` | 512,000 | 64,000 | low…max |
| `kimi-k2.7` | 256,000 | 32,000 | low…max |
| `kimi-k2.5` | 164,000 | 32,000 | low…max |
| … | 13 more | | |

These are the *statically bundled* tables. The plugin also queries the live catalogue endpoint at startup and replaces them with whatever your account can actually buy (see [Model discovery](#model-discovery) below).

## Model discovery

The gateway exposes the same endpoint the WorkBuddy CLI uses:

```
CN:    GET {baseUrl}/console/enterprises/personal/models
Intl:  GET {baseUrl}/v2/enterprises/personal/models   (falls back to /console)
```

The two integration points do not share a prefix: the international gateway answers `500` on `/console/...` and `200` on `/v2/...`, so the paths are probed in order and the first that answers wins. A dead prefix therefore cannot disable discovery for a region.

It returns the models *your* credential is allowed to use, at the gateway's true token budgets — the only way the table stays accurate after WorkBuddy renames a model or moves its context window. On startup (and at most once per hour) the plugin fetches it, writes a per-region disk cache under `~/.cache/opencode/`, and applies the result:

- **ids** are authoritative: a model the endpoint omits stops being offered, a new one starts.
- **numbers** (`contextWindow`, `maxOutputTokens`, `credits`) come from the gateway. The endpoint is the only place the plugin learns that e.g. `kimi-k2.5` is 164k, not 256k.
- **effort ladders** fall back to the static table where the endpoint is silent. The endpoint only lists `supportedEfforts` for some models; inventing the full `low…max` ladder for a model like `hy3` (which really only accepts `low`/`high`) would produce `400 invalid effort` responses, so "absent" is treated as *unknown*, not as "all five".

Nothing about discovery can break auth. A 500, a timeout, an empty response, or a response so small it looks truncated is logged and ignored, and the last good table is served — worst case the static table. Failures back off for 60 s so a broken endpoint isn't hammered on every startup. The CN endpoint is confirmed answering live; the international `/v2` path is taken from the reference gateway implementations and is *not* confirmed against an international credential here — if it is ever wrong, the probe falls through to `/console` and then to the static table, which costs a warning line and nothing else.

| Variable | Effect |
|---|---|
| `WORKBUDDY_DISABLE_MODEL_DISCOVERY=1` | Never call the endpoint; use only the static tables. |
| `WORKBUDDY_MODEL_CACHE_SECONDS=<n>` | Change the refresh interval (default 3600). |
| `WORKBUDDY_MODEL_DISK_CACHE=<path>` | Relocate the cache. **End it with `/` (or point it at an existing directory)** so each region writes its own file — with both integration points loaded, a bare file path would be shared and the last region to write would serve its catalogue to the other. |
| `WORKBUDDY_MODEL_FIXTURE=<path>` | Replace the network with a saved response. For debugging and tests; applies to whichever region is refreshed. |

To see what a region resolved to, check opencode's log for `catalogue[<region>]: N models …` — it names the source (`live`, `cache`, `fixture` or `static`).

## Usage

Pick a model (e.g. the 1M one):

```bash
opencode run -m workbuddy/deepseek-v4-flash "hello"
```

or set it as the default:

```json
{ "model": "workbuddy/glm-5.2" }
```

**Reasoning effort** — use the model variant:

```json
{ "model": "workbuddy/deepseek-v4-pro", "variant": "max" }
```

**Plugin options** (on the plugin entry, or under `provider.workbuddy.options`):

| Option | Effect |
|---|---|
| `apiKey` / `userID` / `baseUrl` | explicit credentials, top of the chain |
| `providerID` | register under a different id (default `workbuddy`) |
| `providerName` | display name in `/connect` and the picker (default `WorkBuddy AI`) |
| `storeName` | which own-store file this integration point reads/writes |
| `setDefault: true` | make `<provider>/hy3` the default model unless `model` is already set |
| (agent pins) | `plan` / `general` / `explore` / `title` / `compaction` subagents are pinned to `<provider>/hy3` if you haven't configured them |

`definePlugin("intl" | "cn")` pre-fills `providerID`, `providerName`, `storeName` and (for CN) `baseUrl`; anything you pass on the entry overrides them.

All models are registered with cost `0` — the desktop credential's quota is billed by WorkBuddy, not by opencode.

### Account tools

Each integration point ships three agent-visible tools, named after the provider (`workbuddy_*` international, `workbuddy_cn_*` CN):

| Tool | What it does |
|---|---|
| `_account` | Resolved provider, uid, expiry, base URL and credential source — never the token value. *"which WorkBuddy account is active?"* |
| `_quota` | Remaining credits across every active grant: per-package remain/total, expiry, and which one expires first. *"how much quota do I have left?"* |
| `_checkin` | Claims the daily check-in grant. Idempotent: a second call the same day reports `already`. |

The balance endpoint wraps one level deeper than chat (`data.Response.Data.Accounts`) and each row is a **grant instance**, not a package — repeated top-ups and daily check-ins each mint their own row with its own expiry, which is why an expiring-soon row is worth showing separately from your total.

Ask the agent: *"check my WorkBuddy balance"*, *"签到"* — it picks the tool for the integration point you're on.

**`_checkin` writes to your account.** It is only ever fired from an explicit tool call — never on startup, never on a request path, and it is never retried. If the campaign ends, changes shape, or the endpoint goes away, nothing breaks: every failure is returned as a message the agent can read, and the credential is untouched. Two switches turn it off without a plugin update:

| Variable | Effect |
|---|---|
| `WORKBUDDY_DISABLE_CHECKIN=1` | `_checkin` short-circuits before even resolving credentials; zero network calls. `_quota` still works. |
| `WORKBUDDY_DISABLE_BILLING=1` | Umbrella: disables `_quota` and `_checkin` together. |

This isolation is not just claimed, it is tested: `test/quota.mjs` injects a transport failure, an HTTP 500, an HTML login wall served at `200`, an emptied payload, a vanished campaign (`404`) and a credential-less environment, and asserts on each one that the billing functions *return* a failure instead of throwing, that the credential file is byte-for-byte unchanged, and that with every billing request throwing the plugin still registers its tools and answers non-billing calls normally.

The one case worth knowing about: a `200` response that carries **no gateway business code** is treated as a failure, not a success. An HTML page or a proxy interstitial would otherwise read as "check-in claimed" and silently report credits you never got.

## Troubleshooting

The plugin keeps the terminal clean. Lifecycle summaries (startup, model
registration, `setup[v2]` phases) go to **opencode's own log file** via
`client.app.log`, not to stderr. Only `warn`/`error` lines — prefixed
`[workbuddy]` and written to stderr — surface in your terminal, because those
are the ones that need you.

- **`[workbuddy] warn: ...` / `[workbuddy] error: ...` in the terminal** —
  a real problem: refresh failed, login failed, credential rejected. Act on it.
- **Need the full trace** — set `WORKBUDDY_DEBUG=1` to mirror every level
  (debug/info/warn/error) to stderr, for CLI debugging.
- **Adjust what lands in the log file** — `WORKBUDDY_LOG=debug|info|warn|error`
  moves the floor (default `info`); `debug` adds the per-request detail (token
  refreshes that recovered, handler hits, dropped SSE lines). `WORKBUDDY_LOG=off`
  mutes the plugin entirely, terminal and file both.

Find the file under `~/.local/share/opencode/log/` and grep it for
`catalogue[` (which model source won for each region), `registered` (final model
counts) or `setup[v2]`.

- **A model you expected is missing** — the live catalogue is authoritative for ids, so if the endpoint doesn't list a model for your account, the plugin won't offer it. Check the log line `catalogue[<region>]: N models <source>`: with `source=live|cache` the gateway is deciding; set `WORKBUDDY_DISABLE_MODEL_DISCOVERY=1` to go back to the bundled table and confirm the model reappears.

- **`401`/`403` even after refresh** — the desktop session expired: sign in to the WorkBuddy desktop app again, or use `opencode auth login`.
- **Browser Login never completes** — the account belongs to the *other* endpoint. Pick the matching integration point (`WorkBuddy AI` vs `WorkBuddy AI (CN)`); each one opens its own login page, so no `WORKBUDDY_BASE_URL` juggling is needed.
- **`WorkBuddy credentials not found. Run /connect workbuddy-cn`** — that integration point has never logged in. Its store is separate from `workbuddy`'s by design; sign in once per endpoint.
- **Flash models answering with tiny loops** — intended guard is active; if it still misbehaves, pick a non-flash model.
- **Answer renders as one token per line** — each streamed chunk was closing the open text block (see `test/stream.mjs`). Fixed; if it reappears after an upstream change, run `node test/stream.mjs` and compare the `blocks:` line — one contiguous answer must be exactly one `text-start`/`text-end` pair.
- **`languageModel is not a function`** — either you're importing an unbuilt `dist/` (run `npm run build`), or your own entry file exports something named `create*` before `createWorkBuddy`: opencode's legacy provider loader calls the module's **first** `create*` export and expects an AI-SDK provider, so that prefix is reserved. Use the exported `definePlugin()` for entry files.

## Tests

```bash
npm test          # build + tsc + biome + the offline suite
npm run test:live # needs a signed-in credential
```

The offline suite runs with no credentials and no network, against a sandboxed cache/config root:

| File | Covers |
|---|---|
| `test/plugin.mjs` | registration contract for both integration points, per-region tables |
| `test/catalogue.mjs` | payload parsing, credits normalisation, merge rules, region isolation, the cache fallback ladder, cache-path overrides |
| `test/quota.mjs` | billing isolation: transport failure, HTTP 500, an HTML wall served at `200`, an emptied payload, a vanished campaign, missing credentials, both kill-switches, expiry parsing — and that none of it can throw, mutate a credential, or unregister a tool |
| `test/stream.mjs` | SSE framing (one answer must be one `text-start`/`text-end` pair) |
| `test/log.mjs` | logging policy: clean terminal, full trace to the log file |

`test/live.mjs [model] [intl|cn]` and `test/tools.mjs [model] [intl|cn]` hit the real gateway and need a login for the access point they target (`hy3` is free on both, so it is the cheapest default). Both also read `$WORKBUDDY_REGION`.

## Development

```bash
npm run build     # tsc -> dist/
npm run check     # tsc --noEmit
npm run lint      # biome check .
npm run lint:fix  # biome check --write .
```

ESM, TypeScript strict, `@ai-sdk/provider` `LanguageModelV3`, Biome for lint + format. `src/index.ts` wires both the legacy `config`-hook registration and the v2 `setup`/catalog/`aisdk.language` path; `src/models.ts` owns the per-region tables and the catalogue merge rules; `src/catalogue.ts` owns discovery and caching; `src/language-model.ts` owns the wire format.
