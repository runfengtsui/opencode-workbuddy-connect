# opencode-workbuddy-connect

[English](README.md) | 简体中文

[opencode](https://opencode.ai) 的 provider 插件，把 [WorkBuddy AI](https://www.workbuddy.ai)（腾讯 CodeBuddy / WorkBuddy 助手模型）作为一等 provider 接入 opencode，**并完整暴露 1M 上下文档位的模型**。

只要你本机登录过 WorkBuddy / CodeBuddy 桌面端，就完全不需要配置凭据：插件会自动发现它的 auth 文件。不用贴 API key，不用买额度。

## 特性

- **真实 1M 上下文** — 所有 1M 档模型都以 `limit.context = limit.input = 1_000_000` 注册，opencode 会在约 1M token 处才触发压缩，而不是默认的 200k 断崖。1M 是这些模型的原生窗口，不需要任何额外线上参数。国际版有 6 个（`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4.1-flash`、`glm-5.2`、`kimi-k3-1`、`hy4-preview-f`），国内版有 10 个（`hy4-preview`、`hy4-preview-x`、`glm-5.3`、`glm-5.3-flash`、`glm-5.2`、`kimi-k3-1`、`kimi-k2.8-preview`、`deepseek-v4-flash`、`deepseek-v4.1-flash`、`deepseek-v4-pro`）。
- **实时模型发现** — 插件会去问网关：*你的账号*实际买得到哪些模型、真实 token 预算各是多少，并把结果叠加到内置的区域专属表之上。WorkBuddy 改名、上新或调整上下文窗口后无需更新插件即可生效，且任何发现失败都不可能影响认证。
- **纯 OpenAI 兼容 SSE** — 直连 `https://www.workbuddy.{ai|cn}/v2/chat/completions`，`reasoning_content` 以原生思考流呈现。
- **完整 agentic 工具调用** — 并行 tool call、工具参数增量流、`tool` 角色结果回传，均已对真实网关验证。
- **凭据自动发现链** — 插件 options → 环境变量 → 自身存储 → 桌面端 auth 文件。与已登录的 WorkBuddy 桌面端共存时开箱即用。
- **账号工具** — 按发放记录读取剩余积分（`_quota`）、领取每日签到（`_checkin`）、查看当前生效的凭据（`_account`）。完全不在请求路径上：所有失败都以消息返回而不是抛出，且两个 billing 工具都能用环境变量关掉，无需更新插件。
- **认证自愈** — 401/403 会触发一次 token 刷新（走桌面端刷新接口）并自动重放请求一次。
- **`opencode auth login` 浏览器登录** — OAuth 式登录 + 轮询取回凭据，落盘到 `~/.config/opencode/workbuddy-auth.json`。
- **思考强度变体**（`low` / `medium` / `high` / `xhigh` / `max`），以 opencode model variant 暴露。
- **循环防护** — flash 系模型在预算充足时会陷入 `OK / 让我写 / 走起` 式思考循环烧预算；插件把它们的 `max_tokens` 封顶为 16,384（沿用参考适配器的上游行为）。

## 环境要求

- 支持 v2 插件 API 的 opencode（实测 1.18.30）
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

## 两个接入点

WorkBuddy 有两个互相独立的站点，**同一账号在另一个站点上用不了**。插件同时提供两个 provider：

| Provider | 站点 | 浏览器登录打开 | 凭据存储 |
|---|---|---|---|
| `workbuddy` | `www.workbuddy.ai`（国际版） | 国际版登录页 | `~/.config/opencode/workbuddy-auth.json` |
| `workbuddy-cn` | `www.workbuddy.cn`（国内版） | 国内版登录页 | `~/.config/opencode/workbuddy-cn-auth.json` |

每个接入点都是独立的插件实例：独立登录、独立凭据存储、独立基址。因此**登录其中一个绝不会覆盖另一个**，CN 流量也不可能漏到国际版端点。选哪个看模型名即可：`workbuddy-cn/hy3` 与 `workbuddy/hy3`。

由于一个 auth hook 只能绑定一个 provider，两个接入点需要加载两份插件。已提供两个入口文件：

```jsonc
{
  "plugin": [
    ["opencode-workbuddy-connect", {}],
    ["opencode-workbuddy-connect/dist/index.js", { "providerID": "workbuddy-cn", "providerName": "WorkBuddy AI (CN)", "baseUrl": "https://www.workbuddy.cn", "storeName": "workbuddy-cn-auth.json" }]
  ]
}
```

若你的 opencode 从 `~/.config/opencode/plugin/` 目录加载插件，放两个 shim 文件（每区域一个），各自调用导出的工厂函数：

```js
// ~/.config/opencode/plugin/workbuddy.js
import { definePlugin } from "opencode-workbuddy-connect";
export default definePlugin("intl");

// ~/.config/opencode/plugin/workbuddy-cn.js
import { definePlugin } from "opencode-workbuddy-connect";
export default definePlugin("cn");
```

条目上显式传入的 options 永远覆盖区域默认值，因此每个接入点都可以自定义 `baseUrl` / `storeName`。

### 没登录时显示什么

模型列表跟着登录状态走，不会在没登录时谎报该账号买不到的模型：

- **两个接入点都没登录** — 只显示一个离线占位模型 `workbuddy-offline`（名为 *WorkBuddy (offline — login required)*），证明插件已经成功加载；另一个接入点保持静默。选中它会直接提示去 `/connect` 登录，而不是发一个注定失败的请求。
- **只登录了一个** — 只显示那个已登录账号的模型列表，未登录的接入点不显示任何模型。
- **两个都登录了** — 两个接入点的模型列表都正常显示（各自独立、区域隔离）。

判定用的是**非联网**的凭证存在性检查（环境变量 / 自身存储 / 桌面端 auth 文件），所以未登录时不会去敲接口，也不会有任何登录失败日志。

## 认证

以下来源按顺序取第一个命中的：

1. **插件 options** — 在 provider（或 `opencode.json` 的插件条目）上配 `"options": { "apiKey": "<token>", "userID": "<uid>", "baseUrl": "https://www.workbuddy.cn" }`。
2. **环境变量** — 国际版接入点读 `WORKBUDDY_TOKEN` + `WORKBUDDY_UID`，国内版读 `WORKBUDDY_CN_TOKEN` + `WORKBUDDY_CN_UID`。这个拆分是刻意的：只用一个 token 变量的话，CN 凭据就会去签国际版请求，把一个你从没登录过的 provider 点亮。可选 `WORKBUDDY_BASE_URL`、`WORKBUDDY_AUTH_FILE`。
3. **自身存储** — 上表中该接入点专属的文件（下面的浏览器登录会写入它，每次刷新成功也会更新它）。
4. **桌面端 auth 文件** — 自动定位
   `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
   （CN 桌面端，`www.workbuddy.cn`）或 `workbuddy-desktop-ai.info`（国际版）。

如果你本机跑着已登录的 WorkBuddy / CodeBuddy 桌面端，**什么都不用配**——第 4 步会给每个请求签名。

### 交互式登录

```bash
opencode auth login   # 选择 "WorkBuddy AI" 或 "WorkBuddy AI (CN)"
```

每个接入点都提供两种方式：

- **Access Token** — 直接粘贴 token；也可写成 `token|uid|https://www.workbuddy.cn` 以同时指定账号与站点。
- **Browser Login** — 打开**该接入点自己的**登录页并轮询取回凭据。无需再设环境变量：选 `WorkBuddy AI (CN)` 就是 `www.workbuddy.cn`。

## 模型

每个接入点都有**自己的**模型表，因为两个站点在同一批名字下卖的是不同的目录。

**`workbuddy`（国际版）** — 11 个模型，默认 `hy3`。11 个全部支持流式思考与图片输入：

| 模型 | 上下文 | 最大输出 | 思考强度变体 | 备注 |
|---|---|---|---|---|
| `deepseek-v4-flash` | **1,000,000** | 50,000 | low…max | |
| `deepseek-v4-pro` | **1,000,000** | 50,000 | low…max | |
| `deepseek-v4.1-flash` | **1,000,000** | 128,000 | low…max | 免费；单次输出封顶 16,384（循环防护） |
| `glm-5.2` | **1,000,000** | 48,000 | low…max | |
| `kimi-k3-1` | **1,000,000** | 32,000 | low…max | |
| `hy4-preview-f` | **1,000,000** | 64,000 | high | 免费；仅国际版 |
| `minimax-m3` | 512,000 | 128,000 | low…max | |
| `kimi-k2.7` | 256,000 | 32,000 | low…max | |
| `kimi-k2.5` | 256,000 | 32,000 | low…max | |
| `glm-5.1` | 200,000 | 48,000 | low…max | |
| `hy3` | 192,000 | 64,000 | low, high | 免费 |

**`workbuddy-cn`（国内版）** — 29 个模型，默认 `hy3`。CN 目录是混合的：部分条目既不支持流式思考、也不接受图片输入，能力逐模型不同而非统一。以下为重点条目（完整列表在启动时发布）：

| 模型 | 上下文 | 最大输出 | 思考强度变体 |
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
| … | 另有 13 个 | | |

以上是*内置静态表*。插件启动时还会查询线上目录接口，用你的账号真正买得到的模型把它替换掉（见下文[模型发现](#模型发现)）。

## 模型发现

网关暴露的正是 WorkBuddy CLI 用的那个接口：

```
CN:    GET {baseUrl}/console/enterprises/personal/models
Intl:  GET {baseUrl}/v2/enterprises/personal/models   （回退 /console）
```

两个接入点并不共用前缀：国际版网关对 `/console/...` 返回 `500`、对 `/v2/...` 返回 `200`，因此按顺序探测，先答应的胜出。单个失效前缀因此不可能让整个区域失去模型发现能力。

它返回**你的**凭据实际可用的模型，以及网关侧真实的 token 预算——这是 WorkBuddy 改名或调整上下文窗口之后，模型表还能保持准确的唯一办法。插件在启动时（最多每小时一次）拉取它，把结果按区域写进 `~/.cache/opencode/` 下的磁盘缓存，然后应用：

- **模型 id 以接口为准**：接口不列的模型就不再提供，新出现的就会提供。
- **数字**（`contextWindow`、`maxOutputTokens`、`credits`）取自网关。比如 `kimi-k2.5` 其实是 164k 而不是 256k，只有这里能知道。
- **思考强度档位**在接口沉默时回落到静态表。接口只给部分模型列 `supportedEfforts`；若像 `hy3`（实际只接受 `low`/`high`）那样凭空补出完整 `low…max` 阶梯，只会换来 `400 invalid effort`。因此"缺省"按**未知**处理，而不是"五档全支持"。

发现环节无论如何都不可能搞坏认证。500、超时、空响应，或小得看起来被截断的响应，都只记一行日志然后忽略，继续提供上一份好表——最坏情况是静态表。失败后退回 60 秒，避免每次启动都去敲一个坏掉的接口。CN 接口已确认实时可用；国际版 `/v2` 路径取自参考网关实现，**本仓库并未用国际版凭据确认过**——万一它不对，探测会落到 `/console`，再不行就是静态表，代价仅是一行警告。

| 环境变量 | 作用 |
|---|---|
| `WORKBUDDY_DISABLE_MODEL_DISCOVERY=1` | 完全不调用接口，只用静态表。 |
| `WORKBUDDY_MODEL_CACHE_SECONDS=<n>` | 修改刷新间隔（默认 3600）。 |
| `WORKBUDDY_MODEL_DISK_CACHE=<path>` | 迁移缓存位置。**请以 `/` 结尾（或指向一个已存在的目录）**，这样每个区域各写自己的文件——两个接入点同时加载时，若给的是一个裸文件路径，该文件会被共用，最后写入的那个区域会把自己的模型表喂给另一个。 |
| `WORKBUDDY_MODEL_FIXTURE=<path>` | 用一份留存的响应替换网络。用于调试与测试；作用于当前刷新的区域。 |

想知道某区域最终用了哪个来源，去 opencode 日志里 grep `catalogue[<区域>]: N models …`——它会写明来源（`live`、`cache`、`fixture` 或 `static`）。

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
| `providerName` | `/connect` 与选择器里的显示名（默认 `WorkBuddy AI`） |
| `storeName` | 该接入点读写哪个自身存储文件 |
| `setDefault: true` | 在未显式设置 `model` 时把 `<provider>/hy3` 设为默认模型 |
| （agent 预置） | 若你未配置，`plan` / `general` / `explore` / `title` / `compaction` 子代理会被钉到 `<provider>/hy3` |

`definePlugin("intl" | "cn")` 会预填 `providerID`、`providerName`、`storeName`，以及（CN 的）`baseUrl`；条目上显式传入的值优先于这些默认。

所有模型的计费都注册为 `0` —— 桌面端凭据的额度由 WorkBuddy 侧结算，与 opencode 无关。

### 账号工具

每个接入点自带三个 agent 可见的工具，按 provider 命名（国际版 `workbuddy_*`，国内版 `workbuddy_cn_*`）：

| 工具 | 作用 |
|---|---|
| `_account` | 当前 provider、解析出的 uid、过期时间、基址与凭据来源——绝不输出 token 本身。*"现在用的是哪个 WorkBuddy 账号？"* |
| `_quota` | 所有生效发放的剩余积分：每个包的剩余/总量、到期时间，以及最快到期的那笔。*"我还有多少额度？"* |
| `_checkin` | 领取每日签到积分。幂等：同一天第二次调用返回 `already`。 |

余额接口比 chat 多包一层（`data.Response.Data.Accounts`），且每一行是一个**发放实例**而不是一个包：重复充值与每日签到都会各自生成一行、各自带到期时间——这也是为什么"快要到期的那笔"值得和总额分开显示。

直接问 agent：*"查一下 WorkBuddy 余额"*、*"签到"*——它会按你所处接入点选用对应工具。

**`_checkin` 会写你的账号。** 它只会因为一次显式的工具调用而触发——绝不在启动时、绝不在请求路径上，也从不重试。活动结束、接口改形、接口消失，都不会弄坏任何东西：每种失败都作为一条 agent 可读的消息返回，凭据分毫不动。两个开关无需更新插件即可关闭它：

| 环境变量 | 作用 |
|---|---|
| `WORKBUDDY_DISABLE_CHECKIN=1` | `_checkin` 在解析凭据**之前**就短路，零网络调用；`_quota` 照常可用。 |
| `WORKBUDDY_DISABLE_BILLING=1` | 总开关：`_quota` 与 `_checkin` 一起停用。 |

这种隔离不只是嘴上说说，而是有测试兜底的：`test/quota.mjs` 注入传输失败、HTTP 500、以 `200` 返回的 HTML 登录页、被清空的响应体、活动下线（`404`）以及无凭据环境，逐一断言 billing 函数是 **返回** 失败而不是抛出异常、凭据文件逐字节未被改动、以及在每个 billing 请求都抛错的情况下插件仍然正常注册工具、非-billing 调用照常响应。

唯一值得留意的一点：一个**不带网关业务码**的 `200` 会被判为失败而非成功。否则一张 HTML 页面或代理拦截页就会被读成"签到成功"，让你以为拿到了从未真正到账的积分。

## 排障

插件会保持终端干净。生命周期摘要（启动、模型注册、`setup[v2]` 各阶段）通过 `client.app.log` 写进 **opencode 自己的日志文件**，而不是 stderr。只有带 `[workbuddy]` 前缀、写到 stderr 的 `warn`/`error` 行才会出现在终端里——因为那些才是需要你处理的。

- **终端出现 `[workbuddy] warn: ...` / `[workbuddy] error: ...`** — 真实问题：刷新失败、登录失败、凭据被拒。需要处理。
- **想看完整追踪** — 设 `WORKBUDDY_DEBUG=1`，把每个级别（debug/info/warn/error）都镜像到 stderr，便于命令行调试。
- **调整写进日志文件的内容** — `WORKBUDDY_LOG=debug|info|warn|error` 移动下限（默认 `info`）；`debug` 会额外记录每次请求的细节（成功恢复的 token 刷新、handler 命中、被丢弃的 SSE 行）。`WORKBUDDY_LOG=off` 把插件彻底静音，终端和文件都不写。

日志文件在 `~/.local/share/opencode/log/`，可用 `catalogue[`（每个区域最终用了哪个模型来源）、`registered`（最终模型数量）或 `setup[v2]` 去 grep。

- **你以为会在的模型不见了** — 模型 id 以实时目录为准，所以接口没给某个账号列出的模型，插件就不再提供。查日志里的 `catalogue[<区域>]: N models <来源>`：来源是 `live|cache` 就是网关在决定；设 `WORKBUDDY_DISABLE_MODEL_DISCOVERY=1` 回到内置表，确认该模型是否重新出现。

- **刷新之后仍然 `401`/`403`** — 桌面端会话过期：重新登录 WorkBuddy 桌面端，或用 `opencode auth login`。
- **Browser Login 一直等不到结果** — 账号属于另一个站点。改选匹配的接入点（`WorkBuddy AI` 或 `WorkBuddy AI (CN)`）即可；每个接入点打开的是自己的登录页，不再需要折腾 `WORKBUDDY_BASE_URL`。
- **`WorkBuddy credentials not found. Run /connect workbuddy-cn`** — 该接入点还没登录过。它与 `workbuddy` 的存储本就是分开的，两个站点各登录一次。
- **flash 模型答非所问、输出极短循环** — 防护封顶已生效；若仍异常，换非 flash 模型。
- **回答变成一个 token 一行** — 每个流式 chunk 都错误地关闭了文本块（见 `test/stream.mjs`）。已修复；若上游变更后复发，跑 `node test/stream.mjs` 对比 `blocks:` 行——一段连续回答应当只有一对 `text-start`/`text-end`。
- **`languageModel is not a function`** — 要么 `dist/` 未构建或已过期（跑 `npm run build`）；要么你自己的入口文件里 `create*` 导出排在了 `createWorkBuddy` 前面：opencode 的旧版 provider loader 调用模块的**第一个** `create*` 导出并期望拿到 AI-SDK provider，所以该前缀已被占用。入口文件请用导出的 `definePlugin()`。

## 测试

```bash
npm test          # 构建 + tsc + biome + 离线套件
npm run test:live # 需要已登录凭据
```

离线套件不需要凭据、不碰网络，且跑在被沙箱化的 cache/config 根目录上：

| 文件 | 覆盖内容 |
|---|---|
| `test/plugin.mjs` | 两个接入点的注册契约、区域专属模型表 |
| `test/catalogue.mjs` | 响应解析、credits 归一、合并规则、区域隔离、缓存回退阶梯、缓存路径覆盖 |
| `test/quota.mjs` | billing 隔离性：传输失败、HTTP 500、以 `200` 返回的 HTML 登录页、被清空的响应体、活动下线、无凭据、两个开关、到期时间解析——以及这些情况都不能抛异常、不能改动凭据、不能弄丢已注册的工具 |
| `test/stream.mjs` | SSE 分块（一段连续回答必须只有一对 `text-start`/`text-end`） |
| `test/log.mjs` | 日志策略：终端干净、完整追踪进日志文件 |

`test/live.mjs [model] [intl|cn]` 与 `test/tools.mjs [model] [intl|cn]` 打真实网关，需要目标接入点已登录（`hy3` 在两个站点都免费，是最省额度的默认选择）。两者也都读 `$WORKBUDDY_REGION`。

## 开发

```bash
npm run build     # tsc -> dist/
npm run check     # tsc --noEmit
npm run lint      # biome check .
npm run lint:fix  # biome check --write .
```

ESM、TypeScript strict、`@ai-sdk/provider` 的 `LanguageModelV3`，lint 与格式化统一用 Biome。`src/index.ts` 同时接好旧版 `config` hook 注册与 v2 `setup`/catalog/`aisdk.language` 路径；`src/models.ts` 负责区域专属表与目录合并规则；`src/catalogue.ts` 负责模型发现与缓存；线上格式由 `src/language-model.ts` 负责。
