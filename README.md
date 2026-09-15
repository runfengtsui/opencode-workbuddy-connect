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

## Authentication

The first successful source wins, in this order:

1. **Plugin options** — `"options": { "apiKey": "<token>", "userID": "<uid>", "baseUrl": "https://www.workbuddy.cn" }` on the provider (or on the plugin entry in `opencode.json`).
2. **Environment** — `WORKBUDDY_TOKEN` + `WORKBUDDY_UID`; optionally `WORKBUDDY_BASE_URL` and `WORKBUDDY_AUTH_FILE`.
3. **Own store** — `~/.config/opencode/workbuddy-auth.json` (written by Browser Login below, and by every successful token refresh).
4. **Desktop auth file** — automatically located in
   `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
   (CN desktop, `www.workbuddy.cn`) or `workbuddy-desktop-ai.info` (international).

If you already run the WorkBuddy / CodeBuddy desktop app signed in, **nothing to do** — step 4 signs every request.

### Interactive login

```bash
opencode auth login   # pick "WorkBuddy AI"
```

Two methods are offered:

- **Access Token** — paste a raw token; optionally in the form `token|uid|https://www.workbuddy.cn` to pin the account and host.
- **Browser Login** — opens the WorkBuddy login page and polls for the credential. For a CN desktop account set `WORKBUDDY_BASE_URL=https://www.workbuddy.cn` first (the default login base is the international `www.workbuddy.ai`).

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
| `setDefault: true` | make `workbuddy/hy3` the default model unless `model` is already set |
| (agent pins) | `plan` / `general` / `explore` / `title` / `compaction` subagents are pinned to `workbuddy/hy3` if you haven't configured them |

All models are registered with cost `0` — the desktop credential's quota is billed by WorkBuddy, not by opencode.

### Inspecting auth

The plugin ships a `workbuddy_account` tool (visible to the agent) that reports the resolved uid, expiry, base URL and credential source — never the token value. Ask the agent: *"which WorkBuddy account is active?"*

## Troubleshooting

Every plugin log line is prefixed `[workbuddy]` and written to stderr — visible in `opencode run` output.

- **`401`/`403` even after refresh** — the desktop session expired: sign in to the WorkBuddy desktop app again, or use `opencode auth login`.
- **Browser Login never completes** — you logged into the *international* page but the account is CN (or vice-versa). Set `WORKBUDDY_BASE_URL=https://www.workbuddy.cn` (or `.ai`) and retry.
- **Flash models answering with tiny loops** — intended guard is active; if it still misbehaves, pick a non-flash model.
- **`languageModel is not a function`** — you're importing an unbuilt `dist/`; run `npm run build`.

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
