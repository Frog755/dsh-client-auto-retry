# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [0.5.1] - 2026-11-05

### Fixed

- Restored the official DSH client-module contract: `client.js` now registers its lazy factory through `window.__ModuleLoader__.load()` instead of using a top-level `return`.
- Added a sandbox regression test that parses the real client script and executes its ModuleLoader factory, preventing another Web Boot `Illegal return statement` crash.
- Added the official `dsh.client.immediately` manifest flag.

## [0.5.0] - 2026-11-05

### Changed

- Migrated the Host half to the current DSH `Config` / `.volatile()` settings pipeline.
- Replaced legacy connection/session APIs with the current Session Controller while retaining the official client ModuleLoader wrapper.
- Reworked settings editing around `ctx.configForms` and current DSH slot contracts.

### Fixed

- Boot scan now verifies the retained Session event tail is actually retryable instead of retrying every recent Session.
- Added per-Session event-sequence deduplication, retention lifecycle cleanup, in-flight prompt locking, request-id echo matching, exponential backoff, permanent-error stopping, and sticky manual stop.
- Updated package compatibility metadata to DSH `>=0.2.1-rc.5 <0.3.0`.

## [Unreleased]

### Planned

- Optional browser notifications when the plugin stops for manual intervention.
