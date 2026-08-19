# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
