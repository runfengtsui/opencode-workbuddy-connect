# opencode-workbuddy-connect

English | [简体中文](README.zh-CN.md)

An [opencode](https://opencode.ai) provider plugin that connects [WorkBuddy AI](https://www.workbuddy.ai) — the Tencent CodeBuddy / WorkBuddy assistant models — to opencode as a first-class provider, **including the 1M-token context models**.

Zero-credential setup if you use the WorkBuddy / CodeBuddy desktop app: the plugin auto-discovers its auth file. No API key to paste, no quota to buy.

## Features

- **Real 1M context** — `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4.1-flash`, `glm-5.2`, `kimi-k3-1` and `hy4-preview-f` are registered with `limit.context = limit.input = 1_000_000`, so opencode compacts at ~1M instead of the 200k default. The 1M window is native to these models; no wire parameter is needed.
- **Pure OpenAI-compatible SSE** against `https://www.workbuddy.{ai|cn}/v2/chat/completions`, with `reasoning_content` streamed as native thinking.
- **Full agentic tool use** — parallel tool calls, streaming tool-argument deltas, and `tool`-role result replay verified against the live gateway.
- **Credential discovery chain** — plugin options → environment → own store → desktop app auth file. Works out of the box next to a logged-in WorkBuddy desktop.
- **Self-healing auth** — a 401/403 triggers one token refresh (via the desktop refresh endpoint) and one automatic replay of the request.
- **Browser login in `opencode auth login`** — OAuth-style login with polling, stored to `~/.config/opencode/workbuddy-auth.json`.
- **Reasoning-effort variants** (`low` / `medium` / `high` / `xhigh` / `max`) exposed as opencode model variants.
- **Loop guard** — the flash models are known to burn budget in `OK / Let me write / Go` reasoning loops; their `max_tokens` is capped at 16,384 per request (upstream behavior copied from the reference adapter).

## Requirements

- opencode with the v2 plugin API (tested on 1.18.31)
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

## Authentication

The first successful source wins, in this order:

1. **Plugin options** — `"options": { "apiKey": "<token>", "userID": "<uid>", "baseUrl": "https://www.workbuddy.cn" }` on the provider (or on the plugin entry in `opencode.json`).
2. **Environment** — `WORKBUDDY_TOKEN` + `WORKBUDDY_UID`; optionally `WORKBUDDY_BASE_URL` and `WORKBUDDY_AUTH_FILE`.
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

All models accept image input and stream reasoning. IDs are used as `workbuddy/<id>`:

| Model | Context | Max output | Effort variants | Notes |
|---|---|---|---|---|
| `deepseek-v4-flash` | **1,000,000** | 50,000 | low…max | output capped to 16,384 (loop guard) |
| `deepseek-v4-pro` | **1,000,000** | 50,000 | low…max | |
| `deepseek-v4.1-flash` | **1,000,000** | 128,000 | low…max | output capped to 16,384 (loop guard) |
| `glm-5.2` | **1,000,000** | 48,000 | low…max | |
| `kimi-k3-1` | **1,000,000** | 32,000 | low…max | |
| `hy4-preview-f` | **1,000,000** | 64,000 | high | |
| `minimax-m3` | 512,000 | 128,000 | low…max | |
| `kimi-k2.7` | 256,000 | 32,000 | low…max | |
| `kimi-k2.5` | 256,000 | 32,000 | low…max | |
| `glm-5.1` | 200,000 | 48,000 | low…max | |
| `hy3` | 192,000 | 64,000 | low, high | |

The plugin also reads `~/.workbuddy-ai/cache/acc-product-config-v3.json` (the desktop app's account model catalog) when present and layers it over the table above, so newly released models can appear without a plugin update.

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
| `setDefault: true` | make `workbuddy/hy3` the default model unless `model` is already set |
| (agent pins) | `plan` / `general` / `explore` / `title` / `compaction` subagents are pinned to `workbuddy/hy3` if you haven't configured them |

`definePlugin("intl" | "cn")` pre-fills `providerID`, `providerName`, `storeName` and (for CN) `baseUrl`; anything you pass on the entry overrides them.

All models are registered with cost `0` — the desktop credential's quota is billed by WorkBuddy, not by opencode.

### Inspecting auth

The plugin ships an account tool — `workbuddy_account` for the international integration point, `workbuddy_cn_account` for the CN one (both visible to the agent). It reports the resolved provider, uid, expiry, base URL and credential source — never the token value. Ask the agent: *"which WorkBuddy account is active?"*

## Troubleshooting

Every plugin log line is prefixed `[workbuddy]` and written to stderr — visible in `opencode run` output.

- **`401`/`403` even after refresh** — the desktop session expired: sign in to the WorkBuddy desktop app again, or use `opencode auth login`.
- **Browser Login never completes** — the account belongs to the *other* endpoint. Pick the matching integration point (`WorkBuddy AI` vs `WorkBuddy AI (CN)`); each one opens its own login page, so no `WORKBUDDY_BASE_URL` juggling is needed.
- **`WorkBuddy credentials not found. Run /connect workbuddy-cn`** — that integration point has never logged in. Its store is separate from `workbuddy`'s by design; sign in once per endpoint.
- **Flash models answering with tiny loops** — intended guard is active; if it still misbehaves, pick a non-flash model.
- **`languageModel is not a function`** — either you're importing an unbuilt `dist/` (run `npm run build`), or your own entry file exports something named `create*` before `createWorkBuddy`: opencode's legacy provider loader calls the module's **first** `create*` export and expects an AI-SDK provider, so that prefix is reserved. Use the exported `definePlugin()` for entry files.

## Tests

Live, network-backed smoke tests against your own desktop credential:

```bash
node test/plugin.mjs        # registration contract (no network)
node test/live.mjs hy3      # stream + usage through the real model
node test/tools.mjs         # two-turn tool round-trip
```

## Development

```bash
npm run build   # tsc -> dist/
```

ESM, TypeScript strict, `@ai-sdk/provider` `LanguageModelV3`. `src/index.ts` wires both the legacy `config`-hook registration and the v2 `setup`/catalog/`aisdk.language` path; `src/language-model.ts` owns the wire format.
