# dsh-commandcode-go

在 DeepSeek Harness（DSH）里使用 **Command Code Go** 订阅的 LLM 适配器，并带一个可拖动的用量悬浮窗。

> 由 **DeepSeek（大肥鱼）** 编写。它是一个标准的 DSH 双半边插件：Host 侧注册模型
> provider 和用量接口，Client 侧在 Web 界面挂一个悬浮窗。

> 非官方插件，与 Command Code 官方无关。它复刻的是 Command Code CLI 使用的
> `/alpha/generate` 传输协议，而不是官方 Provider API。Go 套餐没有 Provider API，
> 请求走 Provider API 会返回 `403 upgrade_required`。该传输未被官方文档化，可能随
> CLI 更新失效，也可能触及服务条款；请自行评估后再使用。

## 为什么需要它

Command Code 的不同套餐能力不同：

- Provider / GOAT / Pro / Max 等套餐可以使用 `https://api.commandcode.ai/provider/v1`
  的 Provider API。
- **Go** 套餐没有 Provider API，官方 CLI 改用 `POST https://api.commandcode.ai/alpha/generate`。
- DSH 本身只接受注册到 `ctx.llm` 的适配器，不会自动调用某个外部 CLI。

本插件在 DSH 进程内注册一个 `commandcode-go` provider，把 DSH 的
`GenerateOptions` 转换成 CLI 的 alpha envelope，再把 NDJSON 事件流转换回 DSH
的 `StreamChunk`。它不是本地 HTTP 反向代理，不需要额外启动端口或后台进程。

## 功能

- 实时读取 Command Code 模型目录，按套餐过滤；离线时使用内置 Go 模型列表兜底。
- 文本、图片输入、工具调用、工具结果、reasoning effort、流式输出。
- 正确回放历史 reasoning（DeepSeek thinking 模式工具循环必需）。
- 图片按 1568 长边、1 MiB 编码上限压缩；总图片预算 20 MiB。
- 网关级输出上限 131072；`moonshotai/Kimi-K3.1-Pro` 自动省略固定 temperature。
- 设置页由 DSH 根据插件 `Config` 自动生成，API key 字段为 write-only secret。
- Web 端的可拖动用量悬浮窗：额度、5 小时 / 每周窗口、本期请求与 token 统计。

## 安装

### 通过插件名称安装

发布到 npm 后，可以在 DSH 插件页直接填写包名，或执行：

```bash
dsh plugin --profile <profile> add dsh-commandcode-go
```

插件名就是 npm 包名 `dsh-commandcode-go`。当前仓库版本的包还没有发布到 npm，
所以下面的本地安装方式可以直接用。

### 本地目录（普通 profile）

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-commandcode-go
```

例如：

```bash
dsh plugin --profile web add link:~/dsh-commandcode-go
```

然后在 DSH 的 **Settings → Plugins → Command Code Go** 中填写 API key，重启或
重新加载 profile。

### DSH Desktop

Desktop 的 `desktop` profile 由 Electron 管理，`dsh plugin --profile desktop` 会拒绝
执行。可以手动安装：

1. 把整个 `dsh-commandcode-go` 目录复制到
   `~/.dsh/profiles/desktop/node_modules/dsh-commandcode-go`。
2. 编辑 `~/.dsh/profiles/desktop/package.json`，在
   `dsh.profile.bundles` 末尾加入 `"dsh-commandcode-go"`。
3. 重启 DSH Desktop。插件自带的 `cordis.patch.yml` 会把自己插入 loader。

开发时可以把这个目录软链到 `node_modules/dsh-commandcode-go`，这样修改源码后只需
重启（或重载插件），不必反复复制。用量悬浮窗是独立的 Client 半边，首次安装或
升级后必须让 Host 重新加载插件才会出现。

如果桌面端提供“从本地目录安装插件”的入口，也可以直接选择本目录。

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKey` | 空 | Command Code API key，通常以 `user_` 开头。secret 字段，保存后不回显。 |
| `apiKeyEnv` | `CMD_API_KEY` | `apiKey` 为空时读取的环境变量；也会尝试 `COMMAND_CODE_API_KEY`。 |
| `baseURL` | `https://api.commandcode.ai/provider/v1` | 只取 origin，拼成 `/alpha/generate`。 |
| `alphaVersion` | `1.88.3` | 发送为 `x-command-code-version`。 |
| `plan` | `individual-go` | 模型过滤：`individual-go`、`individual-goat`、`individual-pro`、`individual-provider`、`individual-max`、`all`。 |
| `models` | 空数组 | 为空时使用实时目录；非空时严格按给定 id/顺序提供模型。 |
| `defaultMaxTokens` | `32768` | 默认输出上限，最终还会被模型上限、上下文和 131072 网关上限收紧。 |
| `defaultContextWindow` | `262144` | 目录缺少 context_length 时的兜底值。 |
| `streamTimeoutMs` | `300000` | 单次 alpha 流超时。 |
| `retries` | `3` | 交给 DSH 的可重试次数。 |
| `usageWidget` | `true` | 是否在 Web 界面显示用量悬浮窗。 |
| `usageRefreshSeconds` | `60` | 悬浮窗自动刷新间隔（秒），范围 15–3600。 |

设置完成后，在 **Models** 页面选择 provider `commandcode-go` 和任意 Go 模型，例如：

- `deepseek/deepseek-v4-flash`
- `deepseek/deepseek-v4-pro`
- `moonshotai/Kimi-K3`
- `gpt-6-luna`
- `z-ai/glm-5.3-flash`

## API key 与登录

本插件接受 Command Code 的 `user_...` API key，解析顺序为：

1. Settings 里的 `apiKey`；
2. `apiKeyEnv`（默认 `CMD_API_KEY`），以及 `COMMAND_CODE_API_KEY`；
3. Command Code CLI 的登录文件 `~/.commandcode/auth.json`。

因此，如果你已经用官方 CLI 登录过，通常不需要再手动填 key；插件会读取其中的
`apiKey` / `accessToken` / `token` 字段。也可以通过 `COMMANDCODE_AUTH_FILE`
指定其他路径。

若你的 Go 订阅只能在官方 CLI 中通过浏览器登录、且没有可读取的 auth 文件，可以
改用支持浏览器登录的
[`@mars-sea/dsh-commandcode-provider`](https://github.com/Mars-Sea/dsh-commandcode-provider)；
它同样支持 Go 的 alpha 传输，并带有账户/额度/登录 UI。

不要把 API key 提交到仓库。插件的 secret 字段只写入当前 profile 的 patch，
读取设置时会脱敏。

## 用量悬浮窗

插件在 Web 界面注册了一个浮动窗口，数据来自插件自己的只读路由
`/dsh-commandcode-go/usage`；API key 只留在 Host 进程里，不会进入浏览器。

- 按住卡片任意位置（按钮和链接除外）即可拖动，位置与折叠状态保存在浏览器 localStorage。
- 标题栏的刷新按钮立即拉取；其余时间按 `usageRefreshSeconds` 自动刷新（Host 侧
  另有约 20 秒缓存，避免频繁打到上游）。
- 点击右侧的横线按钮折叠成悬浮球，球上的圆环显示本期额度使用比例；点击球展开。
- 窗口展示：剩余 / 总额度、本期已用百分比、5 小时窗口（Go 为 $3）、每周窗口
  （Go 为 $6）、重置倒计时、本期请求数、token 数、周期结束/续费状态。
- “查看账单与用量”跳转到你的 Command Code billing 页面。
- 不想看时，在 **Settings → Plugins → Command Code Go** 关闭 `usageWidget`，
  刷新页面后窗口消失。

窗口本身是 Client 插件（`client.js` + `dsh.client`），挂在布局的
`shell.overlay` 槽位上，因此换页面不会丢失；它只读取 `whoami`、`credits`、
`subscriptions`、`usage/summary` 四个 alpha 接口，不发送任何对话内容。

## 它是怎么做的

更细的模块划分、路由契约和 Client 生命周期见 [docs/architecture.md](docs/architecture.md)。

插件是一个标准的 DSH bundle，Host 与 Client 两个半边各司其职：

```text
Browser overlay  ──GET /dsh-commandcode-go/usage──▶  Host route (lib/index.js)
                                                          │
                                                          ▼
                                                   lib/usage.js
                                                          │  Bearer key（只在 Host）
                                                          ▼
                                            api.commandcode.ai alpha 接口
                                                          │
                                                          ▼
                                              投影后的 JSON（不含 key）
```

- **Host / 模型**：`lib/adapter.js` 把 DSH 的 `GenerateOptions` 转成 Command Code CLI
  使用的 `/alpha/generate` envelope，再把 NDJSON 事件流还原成 `StreamChunk`，通过
  `ctx.llm.registerAdapter` 注册为 `commandcode-go` provider。
- **Host / 用量**：`lib/usage.js` 只读 `whoami`、`billing/credits`、
  `billing/subscriptions`、`usage/summary` 四个 alpha 接口，算出额度池、5 小时 /
  每周窗口和到期状态；`lib/index.js` 用 `webServer.register` 暴露
  `/dsh-commandcode-go/usage`，带 20 秒缓存。API key 只在这里使用，浏览器拿不到。
- **Client**：`client.js` 通过 `dsh.client` 声明和 `window.__ModuleLoader__.load`
  的 lazy factory 加载，注册到布局的 `shell.overlay` 槽位。它只负责轮询 Host 路由、
  渲染卡片、处理拖动/折叠/本地持久化。
- **配置**：`lib/config.js` 手写 schema，DSH 设置页据此自动生成表单；`usageWidget`
  和 `usageRefreshSeconds` 也在其中。

## 开发与测试

```bash
cd dsh-commandcode-go
node --test
```

仓库自带 GitHub Actions 工作流（目前手动触发：`workflow_dispatch`），它只负责跑同一套
`node --test`，不参与插件运行。本地测试才是发布前的判据。

测试覆盖：

- Config 默认值、secret/volatile schema、URL/plan 校验；
- alpha thread id、envelope、system `" "`、reasoning 回放、131072 clamp；
- NDJSON/SSE 解析、文本/reasoning/工具块生命周期、usage、finish、错误分类；
- 模型目录过滤/别名/离线兜底；
- adapter 注册、retry policy、图片缺省、固定 temperature 模型；
- 用量投影（额度池、窗口、周期）、缺 key / 401 / 429 降级、Host 路由注册。

## 协议要点

请求：

```json
{
  "config": {
    "workingDir": "",
    "date": "YYYY-MM-DD",
    "environment": "external",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": "",
  "taste": "",
  "skills": "",
  "permissionMode": "standard",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "system": " ",
    "messages": [],
    "tools": [],
    "stream": true,
    "max_tokens": 32768
  },
  "threadId": "uuid-v5"
}
```

- `params.system` 至少要有一个空格，否则上游会注入自己的大段默认提示词。
- `threadId` 必须是 UUID；插件用 conversation/session id 派生稳定的 UUID v5，保持
  provider 前缀缓存命中。
- 历史 assistant reasoning 必须以 `{"type":"reasoning","text":...}` 放在 content 中回放。
- 响应是 NDJSON；插件也兼容 SSE `data:` 前缀和 `[DONE]`。

## 已知限制

- alpha 传输未文档化，Command Code 改动后可能需要更新 `alphaVersion` 或适配事件。
- 仅支持文本/图片；文件输入会由 DSH 转成文本句柄，不会作为二进制上传。
- 图片只扫描消息顶层 content；工具结果里的图片目前不会额外拆分。
- 不内置浏览器登录；使用 Settings key、环境变量或 CLI 的 `~/.commandcode/auth.json`。
- 用量接口同样是未文档化的 alpha 接口，Command Code 改版后悬浮窗可能先失效；
  失败时窗口会显示原因，但不会影响模型调用。
- 不重试；重试由 DSH 的 `providerRetryPolicy` 负责。

## License

MIT。协议行为参考了 Command Code CLI 的公开可观察行为，以及
`Mars-Sea/dsh-commandcode-provider` 与 `patlux/pi-commandcode-provider` 的 MIT
实现说明；本项目没有复制其代码。
