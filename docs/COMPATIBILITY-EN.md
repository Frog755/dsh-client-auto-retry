# Compatibility Guide · DeepSeek Harness 0.2.x

Version `0.5.x` targets **DSH `0.2.1-rc.5` and later 0.2.x builds** with the same plugin API surface. It uses the dynamic Cordis client half, Session Controller, and ConfigForms. It does not support the 0.1.x ModuleLoader / `connection.api` API.

## Current API surface

| # | Dependency | DSH 0.2.x shape |
| --- | --- | --- |
| 1 | Client half | `lib/client.js` is evaluated as a dynamic closure and must return `{ inject, apply }`; no `require`, JSX, or `window.__ModuleLoader__`. |
| 2 | Session list | `ctx.sessions.list.getSnapshot()` returns `{ ids, byId }` and publishes via `subscribe()`. |
| 3 | Session events | `ctx.sessions.retain(id, { source })` returns a `SessionReference`; `reference.ready` gives a `SessionBinding` whose `eventSource` publishes `{ type: 'event', event }` entries with durable `seq`. |
| 4 | Prompt | Call `beginSubmission({ mode: 'queue', text, attachments })`, then `session.prompt([{ type: 'text', text }], 'queue', signal, requestId)`. The result is a `RemoteResult`. |
| 5 | Echo identity | A prompt echo contains `source.rpcId`; the plugin matches that id exactly and never consumes a human same-text message as an echo. |
| 6 | Host settings | Export named `Config` with `.volatile()` fields. Host `apply()` calls `settings.configure({ auto: false })` because the client owns the custom card. |
| 7 | Client settings | `ctx.configForms.get(namespace)` provides `getSnapshot/subscribe/mutate`; current revision and recovery are handled by ConfigForms. |
| 8 | UI slots | `settings.general.item` is a root/list slot; `conversation.input.left` is a session/list slot and supplies the standard `sessionId` prop. |
| 9 | Package compatibility | `engines.dsh` declares the supported range; `dsh.bundle.patch` still inserts the plugin into the profile roster. |

## Troubleshooting

1. Add the package to `dsh.profile.bundles` and fully restart DSH; Host code is loaded once per process.
2. Check `[auto-retry]` console messages. The current evaluator intentionally does not provide `require` or the old ModuleLoader.
3. Verify that the target appears in `ctx.sessions.list`, is not a subagent (`origin: 'subagent'`), and can be retained/opened.
4. For prompt failures, inspect the Session `RemoteResult.error.code`; permanent authentication, quota, balance, and invalid-request errors stop the loop.
5. If the settings card is missing, verify that the profile composes the current settings, locale, renderer, and Session Controller bundles and that every Host `Config` field is `.volatile()`.

## Safety behavior

- Each Session has its own pending timer, in-flight lock, retry count, and event-sequence cursor.
- Exponential backoff is capped by `maxBackoffMs`; rejected and thrown prompts also count toward `maxConsecutive`.
- Boot recovery only considers recent Sessions whose retained event tail ends in a retryable `turn/end`; completed, running, user-controlled, and old Sessions are ignored.
- Request IDs are the only current echo identity. Human messages with the same configured text are not swallowed.
- Manual stop is sticky until Resume is clicked. Resume clears the count and intentionally bypasses the previous attempt cooldown.

## Version boundary

- Verified: DSH `0.2.1-rc.5` in the current environment and the later 0.2.x API surface.
- Declared package range: `>=0.2.1-rc.5 <0.3.0`.
- Not supported: DSH `0.1.x` builds that still expose `api.events.mux`, `api.sessions.prompt`, or `settingsNamespace`.
