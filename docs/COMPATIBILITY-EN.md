# Compatibility Guide · Adapting to Other DeepSeek Harness Builds

> This plugin was written and verified against **DSH `0.1.0-rc.7`** (web profile; the
> desktop runtime here ships the same rc.7). DeepSeek Harness comes in web / desktop /
> headless forms and release candidates move fast — different builds may expose
> different client APIs. If the plugin does not install, does not fire, or the
> settings card never appears, walk through the table below item by item.

## DSH API surface this plugin depends on (9 items)

| # | Dependency | Shape in rc.7 | Possible changes elsewhere |
| --- | --- | --- | --- |
| 1 | Opening the event stream | `api.events.mux({}, signal)` → `AsyncIterable<RpcRequest<MuxFrame>>` | method name, args, return type |
| 2 | Mux frame envelope | Frames are RPC envelopes `{ rpcId, payload }`; content lives in `payload` (`session/event`, …) | Some builds push raw frames; the plugin accepts both (`onMuxFrame`) |
| 3 | Turn-end reason | `turn/end` `data.reason.kind ∈ { completed, aborted, blocked, error, 'max-tokens', interrupted }` | enum names grow/shrink; `TurnEndReasonMap` is designed to be plugin-merged |
| 4 | Sending continue | `api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] })` → `{ result: { ok } }` | request/response shape may change |
| 5 | Session list | `api.sessions.list({})` → `result.value` / `result.data` array; fields `s.id`/`s.sessionId`, `s.updatedAt`/`s.lastActivityAt` | field names may change (plugin reads both) |
| 6 | Client module format | `window.__ModuleLoader__.load({ id, factory })` (`@deepseek-ai/dsh-client-runtime`) | desktop or other builds may use a different loader |
| 7 | Settings schema (host) | `settingsNamespace(NS)` + `ctx.settings.register(ns, schema, { applies: 'live' })` (`@deepseek-ai/dsh-settings`) | registration API or `applies` values may change |
| 8 | Settings card (client) | `ctx.slots.inject('settings.general.item')` + `slots.register(...)` + `locale.register` + `settingsScope.bind` + `runtime.defineStore` | slot id, locale/scope/store APIs may change |
| 9 | Bundle mechanism | `dsh.bundle.patch` in `package.json` → `cordis.patch.yml` `- insert: { id, name }` | older builds need a manual insert in the profile `cordis.patch.yml`, or a totally different mechanism |

## Debugging checklist

1. Open DevTools console and look for `[auto-retry]` logs (`verbose` is on by default).
2. Plugin row not loading: confirm `dsh.profile.bundles` in the profile `package.json`
   includes `@frog755/dsh-client-auto-retry`, and DSH was restarted.
3. Loaded but never fires: call `api.events.mux({}, signal)` manually and inspect the
   frame shape — compare with rows #2/#3 above.
4. Fires but send fails: check `sessions.prompt` / `sessions.list` shapes (rows #4/#5).
5. No settings card: check settings/slots registration (rows #7/#8).

## Common pitfalls

- **Host-side changes need a DSH restart** — `lib/index.js` changes do not apply on refresh alone.
- **Don't set `maxConsecutive` too high** — if the provider keeps failing, retries burn tokens.
- **`scanOnBoot` only touches sessions within `freshMs`** — stale sessions won't be poked.
- **It is not an error fallback** — it only sends "continue"; configure failover in DSH's
  model routing if you need provider switching.

## Index of modification points (for fork authors)

- Frame envelope / event protocol: `lib/client.js` → `onMuxFrame()`, `pumpStream()`
- Retry trigger conditions: `lib/client.js` → `turn/end` branch in `onMuxFrame()`
- Send action: `lib/client.js` → `fire()`
- Session scan: `lib/client.js` → `scanInterrupted()`
- Settings schema: `lib/index.js` → `AutoRetrySchema`
- Settings card registration: `lib/client.js` → slots/locale/store part of `apply()`
