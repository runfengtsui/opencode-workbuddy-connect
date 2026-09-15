# opencode-workbuddy-connect

[English](README.md) | 简体中文

[opencode](https://opencode.ai) 的 provider 插件，把 [WorkBuddy AI](https://www.workbuddy.ai)（腾讯 CodeBuddy / WorkBuddy 助手模型）作为一等 provider 接入 opencode，**并完整暴露 1M 上下文档位的模型**。

只要你本机登录过 WorkBuddy / CodeBuddy 桌面端，就完全不需要配置凭据：插件会自动发现它的 auth 文件。不用贴 API key，不用买额度。

## 特性

- **真实 1M 上下文** — `deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4.1-flash`、`glm-5.2`、`kimi-k3-1`、`hy4-preview-f` 以 `limit.context = limit.input = 1_000_000` 注册，opencode 会在约 1M token 处才触发压缩，而不是默认的 200k 断崖。1M 是这些模型的原生窗口，不需要任何额外线上参数。
- **纯 OpenAI 兼容 SSE** — 直连 `https://www.workbuddy.{ai|cn}/v2/chat/completions`，`reasoning_content` 以原生思考流呈现。
- **完整 agentic 工具调用** — 并行 tool call、工具参数增量流、`tool` 角色结果回传，均已对真实网关验证。
- **凭据自动发现链** — 插件 options → 环境变量 → 自身存储 → 桌面端 auth 文件。与已登录的 WorkBuddy 桌面端共存时开箱即用。
- **认证自愈** — 401/403 会触发一次 token 刷新（走桌面端刷新接口）并自动重放请求一次。
- **`opencode auth login` 浏览器登录** — OAuth 式登录 + 轮询取回凭据，落盘到 `~/.config/opencode/workbuddy-auth.json`。
- **思考强度变体**（`low` / `medium` / `high` / `xhigh` / `max`），以 opencode model variant 暴露。
- **循环防护** — flash 系模型在预算充足时会陷入 `OK / 让我写 / 走起` 式思考循环烧预算；插件把它们的 `max_tokens` 封顶为 16,384（沿用参考适配器的上游行为）。

## 环境要求

- 支持 v2 插件 API 的 opencode（实测 1.18.31）
- Node.js ≥ 20（依赖全局 `fetch`）
- 一个 WorkBuddy 账号：本机桌面端已登录，或有可粘贴的 token

## 安装

```bash
git clone <本仓库> F:/code/opencode-workbuddy-connect
cd F:/code/opencode-workbuddy-connect
npm install
npm run build
```

在 `~/.config/opencode/opencode.json` 注册插件：

```json
{
  "plugin": ["F:/code/opencode-workbuddy-connect"]
}
```

插件会以 `workbuddy` 为 provider 自动注册全部模型。

## 认证

以下来源按顺序取第一个命中的：

1. **插件 options** — 在 provider（或 `opencode.json` 的插件条目）上配 `"options": { "apiKey": "<token>", "userID": "<uid>", "baseUrl": "https://www.workbuddy.cn" }`。
2. **环境变量** — `WORKBUDDY_TOKEN` + `WORKBUDDY_UID`；可选 `WORKBUDDY_BASE_URL`、`WORKBUDDY_AUTH_FILE`。
3. **自身存储** — `~/.config/opencode/workbuddy-auth.json`（下面的浏览器登录会写入它，每次刷新成功也会更新它）。
4. **桌面端 auth 文件** — 自动定位
   `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
   （CN 桌面端，`www.workbuddy.cn`）或 `workbuddy-desktop-ai.info`（国际版）。

如果你本机跑着已登录的 WorkBuddy / CodeBuddy 桌面端，**什么都不用配**——第 4 步会给每个请求签名。

### 交互式登录

```bash
opencode auth login   # 选择 "WorkBuddy AI"
```

提供两种方式：

- **Access Token** — 直接粘贴 token；也可写成 `token|uid|https://www.workbuddy.cn` 以同时指定账号与站点。
- **Browser Login** — 打开 WorkBuddy 登录页并轮询取回凭据。CN 桌面端账号请先设 `WORKBUDDY_BASE_URL=https://www.workbuddy.cn`（默认登录基址是国际版 `www.workbuddy.ai`）。

## 模型

所有模型均支持图片输入、流式思考。使用时写作 `workbuddy/<id>`：

| 模型 | 上下文 | 最大输出 | 思考强度变体 | 备注 |
|---|---|---|---|---|
| `deepseek-v4-flash` | **1,000,000** | 50,000 | low…max | 单次输出封顶 16,384（循环防护） |
| `deepseek-v4-pro` | **1,000,000** | 50,000 | low…max | |
| `deepseek-v4.1-flash` | **1,000,000** | 128,000 | low…max | 单次输出封顶 16,384（循环防护） |
| `glm-5.2` | **1,000,000** | 48,000 | low…max | |
| `kimi-k3-1` | **1,000,000** | 32,000 | low…max | |
| `hy4-preview-f` | **1,000,000** | 64,000 | high | |
| `minimax-m3` | 512,000 | 128,000 | low…max | |
| `kimi-k2.7` | 256,000 | 32,000 | low…max | |
| `kimi-k2.5` | 256,000 | 32,000 | low…max | |
| `glm-5.1` | 200,000 | 48,000 | low…max | |
| `hy3` | 192,000 | 64,000 | low, high | |

若存在桌面端的账号模型目录缓存 `~/.workbuddy-ai/cache/acc-product-config-v3.json`，插件会把它叠加到上表之上——新发布的模型无需更新插件即可出现。

## 用法

选择模型（比如 1M 档）：

```bash
opencode run -m workbuddy/deepseek-v4-flash "hello"
```

或设为默认：

```json
{ "model": "workbuddy/glm-5.2" }
```

**思考强度** — 用模型变体：

```json
{ "model": "workbuddy/deepseek-v4-pro", "variant": "max" }
```

**插件 options**（写在插件条目上，或 `provider.workbuddy.options` 下）：

| 选项 | 作用 |
|---|---|
| `apiKey` / `userID` / `baseUrl` | 显式凭据，链上最高优先级 |
| `providerID` | 以其他 id 注册（默认 `workbuddy`） |
| `setDefault: true` | 在未显式设置 `model` 时把 `workbuddy/hy3` 设为默认模型 |
| （agent 预置） | 若你未配置，`plan` / `general` / `explore` / `title` / `compaction` 子代理会被钉到 `workbuddy/hy3` |

所有模型的计费都注册为 `0` —— 桌面端凭据的额度由 WorkBuddy 侧结算，与 opencode 无关。

### 查看认证状态

插件自带 `workbuddy_account` 工具（agent 可见），报告当前解析出的 uid、过期时间、基址与凭据来源——绝不输出 token 本身。直接问 agent：*"现在用的是哪个 WorkBuddy 账号？"*

## 排障

插件日志行一律带 `[workbuddy]` 前缀、写到 stderr——在 `opencode run` 的输出里可见。

- **刷新之后仍然 `401`/`403`** — 桌面端会话过期：重新登录 WorkBuddy 桌面端，或用 `opencode auth login`。
- **Browser Login 一直等不到结果** — 登录的站点和账号不匹配（国际版页面 vs CN 账号，或反之）。设 `WORKBUDDY_BASE_URL=https://www.workbuddy.cn`（或 `.ai`）后重试。
- **flash 模型答非所问、输出极短循环** — 防护封顶已生效；若仍异常，换非 flash 模型。
- **`languageModel is not a function`** — `dist/` 未构建或已过期：跑 `npm run build`。

## 测试

带真实网络、用你本机桌面端凭据的冒烟测试：

```bash
node test/plugin.mjs        # 注册契约（无网络）
node test/live.mjs hy3      # 流式 + usage 走真实模型
node test/tools.mjs         # 两轮工具往返
```

## 开发

```bash
npm run build   # tsc -> dist/
```

ESM、TypeScript strict、`@ai-sdk/provider` 的 `LanguageModelV3`。`src/index.ts` 同时接好旧版 `config` hook 注册与 v2 `setup`/catalog/`aisdk.language` 路径；线上格式由 `src/language-model.ts` 负责。
