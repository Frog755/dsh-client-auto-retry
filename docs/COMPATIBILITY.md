# 兼容性指南 · DeepSeek Harness 各版本适配

> 本插件最初针对 **DSH `0.1.0-rc.7`** 编写；**v0.5.1** 起同时适配 **DSH `0.2.x`**（含 `0.2.2-rc.3`）
> 与 **`0.1.x` / `0.1.6`**。
> DeepSeek Harness 有 web / 桌面端 / headless 等多种形态，且版本迭代很快，不同构建的
> 客户端 API 可能存在差异。装不上、不生效、或设置卡片不出现时，按本文档逐项核对。

## 0.2.x 的关键断裂（v0.5.1 已修复）

DSH `0.2.x` 重做了设置体系，和 `0.1.x` 是完全不同的两套机制。旧插件在 0.2.x 上**一行都不会执行**，
表现为：**设置面板没有、输入区开关没有、自动重试也不工作**，控制台连 `[auto-retry]` 日志都没有。

### 根因 1：inject 声明了不存在的服务 → 插件永久挂起（最致命）

动态客户端插件的 `inject` 是静态数组。客户端 runner 在 mount 时会 `await fiber.await()`，
**只要声明的服务不存在，它就永远等下去，`apply()` 一次都不会被调用**。
旧代码的 `inject` 里有 `settingsScope`，而它在 0.2.x 已经**不存在**（0 个提供者）——
于是设置卡片、按钮、引擎全都没注册，连日志都没有，极难排查。

> 铁律：**inject 里只能写当前版本确实存在的服务。** 其它一律用 `ctx.get(name)` 运行时探测
> （沙箱明确允许：`readService(name, false)` 不需要声明）。现在 `inject` 只保留
> `slots` 和 `locale` 这两个两代都有的服务。

### 根因 2：设置机制换代

| 依赖点 | 0.1.x | 0.2.x | v0.5.1 处理 |
| --- | --- | --- | --- |
| 配置 schema | `settings.register(ns, schema, {applies})` | **方法已移除**；schema 来自插件模块导出的 `Config` | 导出 `Config`，并对旧版回退 `register` |
| 设置页策略 | 无 | `settings.configure({ auto }, fiber)` | 0.2.x 调 `configure({auto:false})`（本插件自带卡片，避免双入口） |
| 字段可见性 | 全部 | **只有 `volatile` 字段进入表单**，没有则整个 entry 被 `describe()` 排除 | 每个字段标记 volatile（`volatile()` 缺失时退回 `extra('volatile', true)`） |
| 命名空间 | `auto-retry` | **profile entry id**（`cordis.patch.yml` 的 insert id，同样是 `auto-retry`） | 统一用 `auto-retry` |
| 读配置 | `ctx.settingsScope.bind({namespace})` | **`ctx.configForms.get(entryId)`** | 适配层二选一，两者快照形状一致 |
| 写配置 | `scope.set/unset` | `form.set/unset` → `remote.settings.mutate(entryId, ops, revision)` | 适配层统一 |
| 会话事件 | `api.events.mux()` 或 `session.eventSource` | `session.eventSource` | 已有 typed 路径复用 |
| 发送继续 | `api.sessions.prompt(...)` | `sessions.scope(id)` → `sessionOf()` → `session.prompt(content,'queue')` | 已有 typed 路径复用 |

### 0.2.x 另外两个坑（v0.5.2 修复）

- **服务是竞态的**：`ctx.get("sessions")` 在 `apply()` 时返回 `undefined`，约 2s 后才就绪。
  只探测一次会**静默失败**（按钮渲染出来但 `current` 为 null，点击无反应）。必须惰性重探。
- **全局定时器被禁用**：动态包沙箱把 `setTimeout/setInterval/clearTimeout/clearInterval`
  全替换成抛错桩。延时一律用 `cordis-plugin-timer` 的 `ctx.timeout/ctx.interval`
  （需 `inject: ['timer']`），返回值是 disposer 而非 id。

> 教训一：**不要把「服务是否存在」当成「能力是否存在」**。
> 教训二：**纯 UI 注册不要放在能力前置判断之后** —— 否则一个探测失败就让整个面板消失。

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
