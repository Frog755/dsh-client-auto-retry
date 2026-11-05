# 兼容性指南 · DeepSeek Harness 0.2.x

本插件 `0.5.x` 针对 **DSH `0.2.1-rc.5` 及后续 0.2.x** 编写并验证，目标是当前 0.2.x 的动态 Cordis client half、Session Controller 和 ConfigForms API。它不再兼容 0.1.x rc 的旧 ModuleLoader 和 `connection.api` API。

## 依赖的当前 API 面

| # | 依赖点 | DSH 0.2.x 形态 |
| --- | --- | --- |
| 1 | client half | `lib/client.js` 作为动态闭包执行，必须直接返回 `{ inject, apply }`；不能使用 `require`、JSX 或 `window.__ModuleLoader__`。 |
| 2 | 会话列表 | `ctx.sessions.list.getSnapshot()` 返回 `{ ids, byId }`，并通过 `subscribe()` 发布更新。 |
| 3 | 会话事件 | `ctx.sessions.retain(id, { source })` 返回 `SessionReference`；`reference.ready` 得到 `SessionBinding`，其 `eventSource` 发布 `{ type: 'event', event }`，事件用 `seq` 去重。 |
| 4 | 发送 prompt | `binding.session.beginSubmission({ mode: 'queue', text, attachments })` 后调用 `session.prompt([{ type: 'text', text }], 'queue', signal, requestId)`，结果为 `RemoteResult`。 |
| 5 | 自身回显 | 自动 prompt 的 request id 会出现在 `user/message.source.rpcId`；应按 request id 精确识别，文本/时间窗口只作为旧历史数据 fallback。 |
| 6 | 配置 Host | 导出命名 `Config`，可编辑字段使用 `z.*.volatile()`；Host 侧通过 `ctx.settings.configure({ auto: false })` 关闭自动配置页。 |
| 7 | 配置 Client | `ctx.configForms.get(namespace)` 提供 `getSnapshot/subscribe/set/unset/mutate`；写入使用 revision，失败后由 ConfigForm 自动恢复镜像。 |
| 8 | UI slots | `settings.general.item` 是 root/list；`conversation.input.left` 是 session/list，组件可接收标准 `sessionId` prop。 |
| 9 | 包兼容性 | `package.json.engines.dsh` 声明当前范围；`dsh.bundle.patch` 仍通过 `cordis.patch.yml` 把插件行插入 bundle roster。 |

## 排查步骤

1. 确认 profile 的 `dsh.profile.bundles` 包含本包，并完全重启 DSH（Host half 只在进程加载时执行）。
2. 检查浏览器控制台中的 `[auto-retry]` 日志；当前 client evaluator 不会提供 `require` 或旧 `window.__ModuleLoader__`。
3. 检查 `ctx.sessions.list` 中目标 Session 是否存在，且不是 `origin: 'subagent'`；插件只 retain 普通会话。
4. 发送失败时检查 Session `RemoteResult.error.code` 和 retain/open 日志；插件会把永久认证、配额和余额错误停在人工介入状态。
5. 设置卡片不出现时，确认 `@deepseek-ai/dsh-client-ui-settings`、locale、renderer 和 Session Controller 已由 bundle 组合，并确认 Host `Config` 字段带 `.volatile()`。

## 行为安全阈值

- 每个 Session 独立维护 pending timer、in-flight 锁、连续次数和事件 seq，慢 prompt 不会并发发送。
- `graceMs` 指数退避并受 `maxBackoffMs` 封顶；所有 prompt 失败也计入 `maxConsecutive`。
- `scanOnBoot` 只检查 `freshMs` 内最近会话，并要求事件尾部确实为可恢复 `turn/end`；正常完成、人工输入、运行中和旧会话不会被伪造恢复。
- 自动回显优先按 `source.rpcId` 识别；同文本人工输入不会因落在 echo 时间窗口内而被误吞。
- 401/403、认证失败、配额/余额不足及明显的永久 invalid-request 错误会停止自动重试，避免继续消耗额度。
- 手动停止状态保持到用户点击恢复；`resume` 会清零计数并显式跳过旧冷却期。

## 修改点索引

- Host schema 与 ConfigForms presentation：`lib/index.js`
- Session retention、eventSource、prompt、boot scan、backoff：`lib/client.js` 的 `AutoRetryRunner`
- 设置卡与输入区按钮：`lib/client.js` 的 `AutoRetryRow` / `AutoRetryStopButton`
- bundle roster：`cordis.patch.yml`

## 版本边界

- 已验证：DSH `0.2.1-rc.5`（当前环境）和同一 0.2.x API 面。
- 包声明：`>=0.2.1-rc.5 <0.3.0`。
- 不承诺兼容：DSH `0.1.x` 及仍暴露 `api.events.mux`、`api.sessions.prompt`、`settingsNamespace` 的旧构建。
