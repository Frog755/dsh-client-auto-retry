# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-11-21

### Fixed（0.5.1 在真实 0.2.2 上仍有三个问题，本版修复）

真机调试（headless Chrome + CDP 抓真实控制台）发现 0.5.1 只修好了「卡片/按钮能渲染」，
引擎仍然起不来，所以按钮「有但点不动」。

- **`sessions` 服务是竞态，不是不存在**：apply 时 `ctx.get("sessions")` 为 `undefined`
  （实测日志 `sessions=false`），约 2s 后才就绪。0.5.1 只探测一次就放弃 → `current` 为 null
  → 按钮渲染出来但点击直接 return。现改为**惰性重探**：未就绪时用 `ctx.interval` 每 2s
  重探，最多 30 次，拿到即启动引擎。

- **动态包禁用全局定时器**：`DYNAMIC_CLIENT_REDIRECTS` 把 `setTimeout/setInterval/
  clearTimeout/clearInterval` 全部替换成抛错桩，宽限期与指数退避会当场崩。
  现全部改用 `cordis-plugin-timer` 注入的 `ctx.timeout/ctx.interval`（disposer 语义），
  并在 `inject` 中加入 `timer`。

- **`scanOnBoot` 会向无关会话盲发「继续」**：旧逻辑只按 `updatedAt` 新鲜度筛选，
  **从不检查上一回合是否真的中断**，页面一加载就对最近会话发「继续」。
  现改为：只处理**用户已打开（retain）**的会话，并读取其事件日志中最后一个
  `turn/end` 的 `reason.kind`，仅当为 `error` / `interrupted` / `max-tokens` 时才排期。

- **`sessions.scope(id)` 只对已 retain 的会话有效**：发送「继续」时若会话未打开会报
  `no-session`。现改用 `sessions.using(id, { source: "auto-retry" }, ref => ...)`，
  由它负责 retain → await ready → 执行 → release。

### Verified（真机）

- 引擎启动：`传输层: 类型化 ctx.sessions → 传输层就绪, 启动引擎 → 已订阅会话事件 …`
- 按钮点击实测：`⏹ 停止自动重试` → 点击 → `▶ 恢复自动重试` ✓
- 启动扫描误发：`扫描完成, 检查 0 个最近会话`（不再盲发）✓

## [0.5.1] - 2026-11-21

### Fixed（修正 0.5.0 的错误定位）

- **0.5.0 定位错了版本**：当时按 `0.1.6` 分析（`connection.api` 消失），但用户实际运行的是
  **DSH `0.2.2-rc.3`**。0.2.x 的问题完全不同，且更严重。

- **插件在 0.2.x 上完全不执行**：`inject` 里声明了 `settingsScope`，而该服务在 0.2.x
  **已不存在**。动态客户端插件 mount 时会 `await fiber.await()`，声明的服务缺失就**永久挂起**，
  `apply()` 一次都不跑 —— 所以设置面板、输入区按钮、自动重试引擎全都没了，且**连日志都没有**。
  现 `inject` 只保留两代都存在的 `slots` / `locale`，其余服务一律用 `ctx.get(name)` 运行时探测。

- **0.2.x 设置体系换代**：
  - `settings.register()` 已移除 → 改为导出插件 `Config`（schema 来源）+ `settings.configure({auto:false})`。
  - `settingsScope` 已移除 → 客户端改用 `ctx.configForms.get(entryId)`（entry id 即 `auto-retry`）。
  - 0.2.x 的 `describe()` **只投影 volatile 字段**，没有 volatile 字段时整个 entry 被排除、
    卡片读不到值 → 所有字段标记 volatile（`volatile()` 不可用时退回 `extra('volatile', true)`，
    以兼容插件内置的 schemastery 3.18.x）。

### Changed

- 新增 `createConfigSource()`：`configForms`（0.2.x）与 `settingsScope`（0.1.x）统一成同一读取/写入面。
- 传输层继续双路：`sessions`（0.1.6+/0.2.x）或 `connection.api`（rc.7）。
- `documentPath`/配置写入走 0.2.x 的 profile patch（由 `remote.settings.mutate` 完成）。

### Note

- **host 侧改动需要重启 DSH**（Cordis 插件进程内只加载一次）；client 侧 `apply` 的改动刷新页面即可。
- 0.5.0 的错误分析保留在 git 历史里，`docs/COMPATIBILITY.md` 已按 0.2.x 重写。

## [0.5.0] - 2026-11-18

### Fixed

- **设置面板消失、输入区开关按钮消失（DSH `0.1.6` 起）**：`apply()` 开头以
  `ctx.connection.api` 做前置判断，而 0.1.6 的 `connection` 句柄只剩
  `isLoopback / generation / state / rpc / reconnect / registerGenerationSource / start`，
  **已无 `api` 字段**。该判断恒为真，`apply` 第一行就 `return`，导致后面所有注册
  （设置卡片、输入区停止/恢复按钮）全部不执行——连自动重试引擎本身也没起来。
  现改为：设置卡片与按钮**无条件注册**；只有重试引擎依赖传输层。
- **0.1.6 会话事件源**：旧代码用 `api.events.mux()` 开 RPC 流，0.1.6 已改为各会话
  自己的事件日志。现新增 typed 传输层，订阅 `sessions.list` 并为每个会话的
  `eventSource` 附加观察，条目形状 `{ event: { seq, type, data } }` 复用原有
  `turn/end` / `user/message` 解析。

### Added

- **跨版本传输适配层**（`createTransport`）：
  - `legacy`：`ctx.connection.api`（rc.7 及更早），沿用 `events.mux` / `sessions.prompt|list`。
  - `typed`：`ctx.sessions`（`0.1.6+`），用 `sessions.scope(id)` → `sessionOf()` →
    `session.prompt(content, 'queue')`，事件走 `eventSource`。
  - 两者都不可用时只跳过重试引擎，**设置卡片仍然可用**（不再整块消失）。
- `inject` 增加 `sessions`。

### Changed

- Host 侧移除未经验证的 `settings.configure(...)` 猜测分支；`settings.register` 不可用时
  只打日志并回落到内置默认值，不再可能误调用不存在的 API。
- `peerDependencies` 的 `dsh-settings` 增加 `^0.1.6`。

## [0.4.0] - 2026-09-10

### Fixed

- **「最多连续次数」上限失效（一直发「继续」）**：`sessions.prompt` 自动发送的「继续」其
  `source.kind` 也是 `'user'`，会被插件的 `user/message` 分支当作「人工输入」把 `consecutive`
  清零——计数器永远在 0↔1 振荡，`maxConsecutive` 闸门永不触发。现按「文本相同 + 发送后
  `echoWindowMs` 窗口内」识别自身回显并忽略，计数器能正常累计到上限。
- **发送失败也计入连续次数**：原先只有 `ok:true` 才 `consecutive += 1`，发送失败/异常时
  计数器不涨，失败路径会无限重试。现无论成败都计数，`maxConsecutive` 在失败路径同样生效。

### Added

- **手动退出机制**：
  - 输入框工具行左侧新增「⏹ 停止重试 / ▶ 恢复自动重试」小按钮（会话级，`conversation.input.left`），
    点击停止后取消待发计时器、该会话不再自动发送「继续」；若上一轮以中断结尾，恢复会立即重新排期。
  - 自动重试循环中收到人工输入（`consecutive > 0` 或有待发计时器时）立即整条退出，等待人工接管。
  - 一轮正常完成（`turn/end` kind=completed）自动重新武装，恢复自动重试。
- 新增设置项 `echoWindowMs`（默认 `30000`，自身回显识别窗口）。
- `maxConsecutive` 默认值由 `5` 调整为 `4`。

## [0.3.0] - 2026-08-18

### Added

- Initial public release on npm as `@frog755/dsh-client-auto-retry`.
- Auto-resume interrupted turns: on `turn/end` with `reason.kind ∈ { error, interrupted, max-tokens }`,
  automatically sends 「继续」 to the same session after a configurable grace period.
- No model/provider switching — the plugin only re-prompts the existing session.
- Settings card in **设置 → 通用 → 断联自动重试** (host-side schema via `@deepseek-ai/dsh-settings`,
  live-applies config).
- Configurable fields: `graceMs`, `cooldownMs`, `maxConsecutive`, `continueText`,
  `scanOnBoot`, `freshMs`, `verbose`.
- Safety guards: cooldown between attempts, max consecutive retries cap, subagent-session
  exclusion, user-message reset.
- Boot-time scan: recovers recently interrupted sessions within a `freshMs` window.
- Robust mux stream handling: RPC-envelope (`{ rpcId, payload }`) and raw-frame compatible,
  auto-reconnect with backoff.
- Bilingual README (中文 + English) with a version-compatibility matrix for other DSH builds.

## [0.3.1] - 2026-08-19

### Fixed

- **设置卡片不显示最新值**：`scope.subscribe` 回调原先每次用 `store.create()` 新建一个无人渲染的 store 实例，
  导致保存后卡片仍显示旧值。现改为捕获渲染中实例的 actions（`liveActions`）并直接更新它，保存后立即显示新值
  （与 dsh-wallpaper 的 `actions.sync` 模式一致）。
- **设置卡片硬编码黑底**：输入框/复选框/保存按钮原来写死 `#1e1e1e` / `#444` / `#2563eb` 等颜色，
  不跟随主题。现全部改用 DSH 主题 token（`--dsw-alias-*`），自动适配明/暗主题，输入框获得
  圆角、hover/focus 高亮等更自然的观感。

## [Unreleased]

### Planned

- Error-code classification (skip permanent failures like 401/403, quota/balance errors).
- Browser notifications when the plugin stops for manual intervention.
