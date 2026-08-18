# 兼容性指南 · DeepSeek Harness 各版本适配

> 本插件最初是针对 **DSH `0.1.0-rc.7`**（web 端 profile；desktop runtime 同版本）编写并验证的。
> DeepSeek Harness 有 web / 桌面端 / headless 等多种形态，且 rc 版本迭代很快，不同构建的
> 客户端 API 可能存在差异。装不上、不生效、或设置卡片不出现时，按本文档逐项核对。

## 插件依赖的 API 面（9 项）

| # | 依赖点 | rc.7 中的形态 | 其他版本可能的变化 |
| --- | --- | --- | --- |
| 1 | 事件流打开 | `api.events.mux({}, signal)` 返回 `AsyncIterable<RpcRequest<MuxFrame>>` | 方法名、参数、返回类型 |
| 2 | mux 帧信封 | 帧是 RPC 信封 `{ rpcId, payload }`，内容在 `payload`（`session/event` 等） | 有的版本直接推裸帧；插件已双兼容（`onMuxFrame`） |
| 3 | 回合结束原因 | `turn/end` 的 `data.reason.kind ∈ { completed, aborted, blocked, error, 'max-tokens', interrupted }` | 枚举增减；`TurnEndReasonMap` 设计上可被插件 merge 扩展 |
| 4 | 发送继续 | `api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] })` → `{ result: { ok } }` | 请求/响应结构可能变 |
| 5 | 会话列表 | `api.sessions.list({})` → `result.value` / `result.data` 数组；字段 `s.id`/`s.sessionId`、`s.updatedAt`/`s.lastActivityAt` | 字段名可能变（插件已兼容取值） |
| 6 | 客户端加载格式 | `window.__ModuleLoader__.load({ id, factory })`（`@deepseek-ai/dsh-client-runtime`） | 桌面端或其他构建可能用不同 loader |
| 7 | 设置 schema（Host） | `settingsNamespace(NS)` + `ctx.settings.register(ns, schema, { applies: 'live' })`（`@deepseek-ai/dsh-settings`） | 注册 API 或 `applies` 取值可能变 |
| 8 | 设置卡片（Client） | `ctx.slots.inject('settings.general.item')` + `slots.register(...)` + `locale.register` + `settingsScope.bind` + `runtime.defineStore` | slot id、locale/scope/store API 可能变 |
| 9 | bundle 机制 | `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` `- insert: { id, name }` | 旧版需在 profile `cordis.patch.yml` 手动 insert，或机制完全不同 |

## 排查步骤

1. 打开浏览器 DevTools 控制台，看 `[auto-retry]` 日志（`verbose` 默认开）。
2. 插件行没加载：确认 profile `package.json` 的 `dsh.profile.bundles` 包含
   `@frog755/dsh-client-auto-retry`，且已重启 DSH。
3. 加载了但不触发：控制台手动调 `api.events.mux({}, signal)` 观察帧结构，
   对照第 2、3 条。
4. 触发了但发送失败：对照第 4、5 条检查 `sessions.prompt` / `sessions.list`。
5. 设置卡片不出现：对照第 7、8 条检查 settings / slots 注册。

## 常见坑

- **Host 侧改动需重启 DSH**：`lib/index.js` 改动只刷新页面不生效。
- **`maxConsecutive` 别调太大**：provider 持续报错时自动重试会反复烧 token。
- **`scanOnBoot` 只扫 `freshMs` 窗口**：重启很久后打开页面不会误触老会话。
- **它不是错误兜底**：只发「继续」，不做模型/provider 切换；需要故障转移请在 DSH
  模型路由里配置。

## 修改点索引（给想要适配的开发者）

- 帧信封/事件协议：`lib/client.js` → `onMuxFrame()`、`pumpStream()`
- 重试触发条件：`lib/client.js` → `onMuxFrame()` 里 `turn/end` 分支
- 发送动作：`lib/client.js` → `fire()`
- 会话扫描：`lib/client.js` → `scanInterrupted()`
- 设置 schema：`lib/index.js` → `AutoRetrySchema`
- 设置卡片注册：`lib/client.js` → `apply()` 里的 slots/locale/store 部分
