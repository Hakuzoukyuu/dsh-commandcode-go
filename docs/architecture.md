# 架构说明

`dsh-commandcode-go` 是一个标准的 DSH bundle，由 Host 半边和可选的 Client 半边组成。
两半共享同一个 npm 包名，安装后由 DSH 的 Loader 一起加载。

## Host 半边（`lib/`）

| 模块 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口（`name` / `inject` / `apply`）。注册 LLM adapter，并注册用量 HTTP 路由。 |
| `lib/adapter.js` | 把 DSH 的 `GenerateOptions` 转成 Command Code CLI 的 `/alpha/generate` envelope，把 NDJSON 流还原为 `StreamChunk`；同时负责 API key 解析。 |
| `lib/alpha.js` | alpha 传输细节：thread id、envelope、NDJSON/SSE 解析、错误分类。 |
| `lib/catalog.js` | 模型目录：实时拉取、按套餐过滤、离线兜底。 |
| `lib/usage.js` | 用量聚合：只读四个 alpha 接口，投影额度池、窗口、周期。 |
| `lib/config.js` | 手写 schemastery 风格 schema，DSH 设置页据此生成表单。 |

注册顺序：

```js
apply(ctx, config) {
  ctx.llm.registerAdapter(["commandcode-go"], adapter)
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path: "/dsh-commandcode-go/usage",
      resource,
    }), "dsh-commandcode-go: usage endpoint")
  })
}
```

`webServer.register` 返回 disposer，放在 `ctx.effect` 里，插件卸载时会自动注销路由；
重复注册同一路径会抛错，所以必须走 effect。

## 用量路由

- 路径：`/dsh-commandcode-go/usage`
- 方法：仅 `GET` / `HEAD`（`webServer` 的资源路由只接受这两种）
- 认证：走 API key（Settings → 环境变量 `CMD_API_KEY` → `~/.commandcode/auth.json`）
- 缓存：成功 20 秒，失败 5 秒；缓存按插件实例保存
- 失败形态：仍然返回 200 和可渲染的 `{ ok: false, error: { code, message } }`，
  并带上 `widgetEnabled` / `refreshSeconds`，方便 Client 决定显示还是隐藏

响应的核心字段：

```json
{
  "ok": true,
  "account": { "userName": "exblowa4k5" },
  "plan": { "name": "Go", "monthlyCredits": 10, "daysLeft": 29 },
  "credits": { "totalRemaining": 9.87, "totalPool": 10, "usagePercent": 1.3 },
  "windows": {
    "fiveHour": { "used": 0, "cap": 3, "percent": 0, "resetInMs": 0 },
    "weekly": { "used": 0.13, "cap": 6, "percent": 2.17, "resetInMs": 531597928 }
  },
  "usage": { "requests": 55, "totalTokens": 4142547, "totalCost": 0.13 },
  "links": { "billing": "https://commandcode.ai/<user>/settings/billing" }
}
```

额度池规则与 Command Code CLI 的 `projectUsageView` 一致：订阅有效时
`totalPool = max(planCredits, monthlyRemaining) + purchased + free`，否则
`totalSpent + totalRemaining`；`used = totalPool - totalRemaining`。

## Client 半边（`client.js`）

- 声明在 `package.json` 的 `dsh.client`：`{ "platform": "web", "immediately": true }`，
  并从 `exports["./client"]` 暴露。
- 顶部调用 `window.__ModuleLoader__.load({ id: "dsh-commandcode-go", factory })`，
  `id` 必须等于 Loader entry 名，否则 ModuleLoader 会报 “loaded without registering”。
- `factory(require)` 里只能 `require("react")`，不能 import 其他 DSH Client 包。
- `apply(ctx)` 通过 `ctx.slots.inject("shell.overlay", () => ctx.slots.register(...))`
  挂到布局的全局 overlay 槽位；槽位本身 `pointer-events: none`，条目需要自己开启。
- 组件内部：
  - 拖动：在卡片上 `pointerdown`，之后在 `window` 上监听 `pointermove` / `pointerup`，
    因此拖动不受 overlay 的 pointer-events 规则和 pointer capture 丢失影响；
    `button` / `a` / `[data-ccu-no-drag]` 不触发拖动。
  - 折叠：展开态是 268px 卡片，折叠态是 46px 圆球，圆环用 conic-gradient 表示额度占比。
  - 位置：`position: fixed`，拖动和窗口 resize 时都会 clamp 到视口内；
    位置/折叠状态写入 `localStorage` 的 `dsh-commandcode-go:usage-window:v1`。
  - 数据：挂载时拉一次，之后按 `usageRefreshSeconds` 轮询；顶部按钮可手动刷新。
- 样式全部使用 `--dsw-alias-*` 主题变量；类名统一 `ccu-` 前缀，避免污染宿主。

## 测试

- `test/config.test.mjs`：默认值、schema、secret/volatile。
- `test/adapter.test.mjs` / `test/alpha.test.mjs` / `test/catalog.test.mjs`：传输与模型目录。
- `test/usage.test.mjs`：投影、窗口、重置时间、错误降级。
- `test/index.test.mjs`：adapter 与用量路由注册、路由响应。
- `test/client.test.mjs`：用假 React 冒烟渲染 Client bundle，验证槽位注册与关键文案。

运行：

```bash
node --test
```
