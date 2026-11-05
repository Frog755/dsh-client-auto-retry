import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
// Official client.js is a normal script containing a ModuleLoader registration;
// parsing it as a script catches the exact web-boot Illegal return regression.
new Function(source)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let loadedModule

globalThis.window = {
  setTimeout,
  clearTimeout,
  __ModuleLoader__: {
    load(module) {
      loadedModule = module
    },
  },
}

function createHarness({ initialEvents = [], rowRunning = false, updatedAt = Date.now(), scanOnBoot = false } = {}) {
  let windowSnapshot = { entries: initialEvents.map(event => ({ type: 'event', event })), hasMore: false }
  const eventListeners = new Set()
  const listListeners = new Set()
  const formListeners = new Set()
  const promptCalls = []
  const releases = []
  const registrations = []
  let requestNumber = 0

  const eventSource = {
    getSnapshot: () => windowSnapshot,
    subscribe: listener => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
  }
  const session = {
    sessionId: 's1',
    beginSubmission: ({ text }) => {
      const requestId = `auto-${++requestNumber}`
      return { requestId, abandon() {} , text }
    },
    prompt: async (content, mode, signal, requestId) => {
      promptCalls.push({ content, mode, signal, requestId })
      return { ok: true, value: { accepted: true } }
    },
  }
  const binding = { sessionId: 's1', session, eventSource }
  const reference = {
    ready: Promise.resolve(binding),
    release: () => releases.push('s1'),
  }
  const listSnapshot = {
    ids: ['s1'],
    byId: {
      s1: { id: 's1', sessionId: 's1', updatedAt, running: rowRunning, displayTitle: 'test', retainedBy: {} },
    },
    phase: 'ready',
  }
  const form = {
    getSnapshot: () => ({ status: 'ready', value: {
      graceMs: 0,
      cooldownMs: 0,
      maxConsecutive: 3,
      maxBackoffMs: 1000,
      continueText: '继续',
      echoWindowMs: 5000,
      scanOnBoot,
      freshMs: 900000,
      verbose: false,
    }, writable: true, revision: 0 }),
    subscribe: listener => { formListeners.add(listener); return () => formListeners.delete(listener) },
    mutate: async () => true,
  }
  const sessions = {
    list: {
      getSnapshot: () => listSnapshot,
      subscribe: listener => { listListeners.add(listener); return () => listListeners.delete(listener) },
    },
    retain: () => reference,
  }
  const disposers = []
  const ctx = {
    sessions,
    configForms: { get: () => form },
    locale: { register: () => () => {} },
    effect: factory => {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    slots: {
      inject: (_name, factory) => { registrations.push(factory()) },
      register: (options, component) => ({ options, component }),
    },
  }
  return {
    ctx,
    listSnapshot,
    eventSource,
    promptCalls,
    releases,
    registrations,
    setRunning(value) {
      listSnapshot.byId.s1.running = value
      for (const listener of listListeners) listener()
    },
    emit(events) {
      windowSnapshot = { entries: events.map(event => ({ type: 'event', event })), hasMore: false }
      for (const listener of eventListeners) listener()
    },
    dispose() { for (const disposer of disposers) disposer() },
  }
}

const React = {
  createElement: (...args) => ({ args }),
  useState: value => [value, () => {}],
  useEffect: () => undefined,
}
const factory = new Function(
  'React', 'console', 'styles', 'host', 'harness',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'require', 'process', 'Buffer',
  `return (async () => {\n${source}\n})()`,
)
await factory(React, console, {}, { call: async () => undefined }, {},
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined)
assert.equal(loadedModule.id, '@frog755/dsh-client-auto-retry')
const plugin = loadedModule.factory(name => {
  if (name === 'react') return React
  throw new Error(`unexpected module request: ${name}`)
})
assert.equal(typeof plugin.apply, 'function', 'official DSH ModuleLoader factory must return a plugin object')
assert.deepEqual(plugin.inject, ['slots', 'locale', 'sessions', 'configForms'])

const harness = createHarness()
plugin.apply(harness.ctx)
harness.setRunning(true)
await Promise.resolve()
await Promise.resolve()

harness.emit([
  { type: 'turn/start', seq: 1, data: {} },
  { type: 'turn/end', seq: 2, data: { reason: { kind: 'error' } } },
])
await sleep(15)
assert.equal(harness.promptCalls.length, 1, 'recoverable turn/end should send one queued prompt')
assert.equal(harness.promptCalls[0].mode, 'queue')
assert.equal(harness.promptCalls[0].requestId, 'auto-1')

// The current DSH durable echo carries rpcId. It must not be mistaken for a
// human message and must not reset the consecutive-attempt guard.
harness.emit([{ type: 'user/message', seq: 3, data: {
  source: { kind: 'user', rpcId: 'auto-1' },
  content: [{ type: 'text', text: '继续' }],
} }])
harness.emit([{ type: 'turn/end', seq: 4, data: { reason: { kind: 'error' } } }])
await sleep(15)
assert.equal(harness.promptCalls.length, 2, 'request-id matched echo must preserve retry arming')

// A same-text message without the generated rpcId is human input and stops
// the loop rather than being swallowed by the echo window.
harness.emit([{ type: 'user/message', seq: 5, data: {
  source: { kind: 'user' },
  content: [{ type: 'text', text: '继续' }],
} }])
harness.emit([{ type: 'turn/end', seq: 6, data: { reason: { kind: 'error' } } }])
await sleep(15)
assert.equal(harness.promptCalls.length, 2, 'human same-text input must stop automatic retry')

harness.dispose()
assert.ok(harness.releases.length >= 1, 'disposing the plugin must release retained Session references')

// Boot recovery must inspect the retained event tail rather than blindly
// retrying every recent Session.
const bootInterrupted = createHarness({
  scanOnBoot: true,
  initialEvents: [{ type: 'turn/end', seq: 7, data: { reason: { kind: 'interrupted' } } }],
})
plugin.apply(bootInterrupted.ctx)
await sleep(300)
assert.equal(bootInterrupted.promptCalls.length, 1, 'recent interrupted tail should be recovered on boot')
bootInterrupted.dispose()

const bootCompleted = createHarness({
  scanOnBoot: true,
  initialEvents: [{ type: 'turn/end', seq: 8, data: { reason: { kind: 'completed' } } }],
})
plugin.apply(bootCompleted.ctx)
await sleep(300)
assert.equal(bootCompleted.promptCalls.length, 0, 'recent completed tail must not be retried on boot')
bootCompleted.dispose()

console.log('auto-retry smoke: ok')
