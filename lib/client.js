// dsh-client-auto-retry browser half for DeepSeek Harness 0.2.x.
//
// This file follows the official DSH client-module contract: the browser half
// registers a lazy factory through window.__ModuleLoader__.load(). The factory
// receives React through require('react'); the old connection.api facade is not used.

window.__ModuleLoader__.load({
  id: '@frog755/dsh-client-auto-retry',
  factory(require) {
    const React = require('react');
    return {
  name: "@frog755/dsh-client-auto-retry",
  inject: [
    "slots",
    "locale",
    "sessions",
    "configForms",
  ],
  apply(ctx) {
    const NS = "auto-retry";
    const form = ctx.configForms.get(NS);

    const DEFAULTS = {
      graceMs: 5000,
      cooldownMs: 20000,
      maxConsecutive: 4,
      maxBackoffMs: 300000,
      continueText: "继续",
      echoWindowMs: 30000,
      scanOnBoot: true,
      freshMs: 15 * 60 * 1000,
      verbose: true,
    };

    const RETRYABLE_KINDS = new Set(["error", "interrupted", "max-tokens"]);
    const TERMINAL_KINDS = new Set(["completed", "aborted", "blocked"]);
    const changeListeners = new Set();
    const timerWindow = typeof window === "object" ? window : null;

    // Dynamic client packages must not call the lexical setTimeout global. The
    // evaluator intentionally withholds it; the browser timer object remains
    // the normal DOM capability used by current DSH UI packages.
    function later(fn, delay) {
      if (!timerWindow || typeof timerWindow.setTimeout !== "function") return undefined;
      return timerWindow.setTimeout(fn, Math.max(0, delay));
    }
    function cancelLater(timer) {
      if (timer !== undefined && timerWindow && typeof timerWindow.clearTimeout === "function") {
        timerWindow.clearTimeout(timer);
      }
    }

    function emitChange() {
      for (const listener of Array.from(changeListeners)) {
        try { listener(); } catch (_) {}
      }
    }

    function rawValue(value) {
      if (value && typeof value === "object" && typeof value.get === "function") {
        try { return value.get(); } catch (_) {}
      }
      return value;
    }

    function resolveConfig(value) {
      const source = value && typeof value === "object" ? value : {};
      const result = {};
      for (const key of Object.keys(DEFAULTS)) {
        const candidate = rawValue(source[key]);
        result[key] = candidate === undefined || candidate === null
          ? DEFAULTS[key]
          : candidate;
      }
      result.graceMs = Number.isFinite(Number(result.graceMs)) ? Math.max(0, Number(result.graceMs)) : DEFAULTS.graceMs;
      result.cooldownMs = Number.isFinite(Number(result.cooldownMs)) ? Math.max(0, Number(result.cooldownMs)) : DEFAULTS.cooldownMs;
      result.maxConsecutive = Number.isFinite(Number(result.maxConsecutive)) ? Math.max(1, Math.floor(Number(result.maxConsecutive))) : DEFAULTS.maxConsecutive;
      result.maxBackoffMs = Number.isFinite(Number(result.maxBackoffMs)) ? Math.max(1000, Number(result.maxBackoffMs)) : DEFAULTS.maxBackoffMs;
      result.echoWindowMs = Number.isFinite(Number(result.echoWindowMs)) ? Math.max(0, Number(result.echoWindowMs)) : DEFAULTS.echoWindowMs;
      result.freshMs = Number.isFinite(Number(result.freshMs)) ? Math.max(0, Number(result.freshMs)) : DEFAULTS.freshMs;
      result.continueText = String(result.continueText || DEFAULTS.continueText).slice(0, 200);
      result.scanOnBoot = Boolean(result.scanOnBoot);
      result.verbose = Boolean(result.verbose);
      return result;
    }

    function configSnapshot() {
      try { return resolveConfig(form.getSnapshot().value); } catch (_) { return resolveConfig(undefined); }
    }

    function log(verbose, message) {
      if (verbose) console.log("[auto-retry] " + message);
    }

    function eventEntries(snapshot) {
      const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
      return entries.filter((entry) => entry && entry.type === "event" && entry.event);
    }

    function isPermanentFailure(error) {
      const code = String(error && (error.code || error.name || error.message) || "").toLowerCase();
      return /(^|[^0-9])(401|403)([^0-9]|$)/.test(code)
        || /unauthor|forbidden|quota|balance|insufficient|invalid[_ -]?request|authentication/.test(code);
    }

    class AutoRetryRunner {
      constructor(sessions, getConfig) {
        this.sessions = sessions;
        this.getConfig = getConfig;
        this.states = new Map();
        this.bindings = new Map();
        this.abort = false;
        this.started = false;
        this.listStop = undefined;
        this.scanTimer = undefined;
      }

      state(id) {
        let state = this.states.get(id);
        if (!state) {
          state = {
            consecutive: 0,
            lastAttemptAt: 0,
            lastAutoAt: 0,
            lastEndKind: null,
            lastSeq: -1,
            pendingTimer: undefined,
            inFlight: false,
            running: false,
            stopped: false,
            subagent: false,
            autoRequestIds: new Set(),
          };
          this.states.set(id, state);
        }
        return state;
      }

      start() {
        if (this.started) return;
        this.started = true;
        this.listStop = this.sessions.list.subscribe(() => this.reconcile());
        this.reconcile();
        const config = this.getConfig();
        if (config.scanOnBoot) {
          this.scanTimer = later(() => { this.scanInterrupted(); }, 250);
        }
      }

      dispose() {
        this.abort = true;
        if (this.listStop) this.listStop();
        cancelLater(this.scanTimer);
        this.scanTimer = undefined;
        for (const state of this.states.values()) {
          this.cancelPendingState(state);
        }
        for (const [id, entry] of this.bindings) {
          try { if (entry.stop) entry.stop(); } catch (_) {}
          try { entry.reference.release(); } catch (_) {}
          this.bindings.delete(id);
        }
        this.states.clear();
      }

      reconcile() {
        if (this.abort) return;
        const snapshot = this.sessions.list.getSnapshot();
        const rows = snapshot && snapshot.byId ? snapshot.byId : {};
        const ids = Array.isArray(snapshot && snapshot.ids) ? snapshot.ids : Object.keys(rows);
        const seen = new Set();
        for (const id of ids) {
          const row = rows[id];
          if (!row || row.origin === "subagent") continue;
          seen.add(id);
          const state = this.state(id);
          state.subagent = false;
          if (row.running) {
            state.running = true;
            this.ensureBinding(id);
          }
          // A retained binding is needed while a retry is pending or the
          // session is running. The latest event, not a list boolean, owns the
          // transition back to idle.
          if (state.pendingTimer !== undefined || state.inFlight || state.consecutive > 0) {
            this.ensureBinding(id);
          }
        }
        for (const [id, entry] of Array.from(this.bindings)) {
          if (seen.has(id)) continue;
          try { if (entry.stop) entry.stop(); } catch (_) {}
          try { entry.reference.release(); } catch (_) {}
          this.bindings.delete(id);
          const state = this.states.get(id);
          if (state) {
            this.cancelPendingState(state);
            state.running = false;
          }
        }
      }

      ensureBinding(id) {
        if (this.abort || this.bindings.has(id)) return this.bindings.get(id);
        let reference;
        try {
          reference = this.sessions.retain(id, { source: "autoRetry" });
        } catch (error) {
          log(this.getConfig().verbose, "无法保留会话 " + id + ": " + String(error && error.message || error));
          return undefined;
        }
        const entry = { reference, binding: undefined, stop: undefined, ready: undefined };
        this.bindings.set(id, entry);
        entry.ready = reference.ready.then((binding) => {
          if (this.abort || this.bindings.get(id) !== entry) return binding;
          entry.binding = binding;
          const source = binding.eventSource;
          entry.stop = source.subscribe(() => { this.processWindow(id, source.getSnapshot()); });
          this.processWindow(id, source.getSnapshot());
          return binding;
        }).catch((error) => {
          log(this.getConfig().verbose, "打开会话 " + id + " 失败: " + String(error && error.message || error));
          if (this.bindings.get(id) === entry) this.bindings.delete(id);
          try { reference.release(); } catch (_) {}
          return undefined;
        });
        return entry;
      }

      processWindow(id, snapshot) {
        const state = this.state(id);
        for (const entry of eventEntries(snapshot)) {
          const event = entry.event;
          const seq = Number(event.seq);
          if (Number.isFinite(seq) && seq <= state.lastSeq) continue;
          if (Number.isFinite(seq)) state.lastSeq = seq;
          this.processEvent(id, event);
        }
      }

      processEvent(id, event) {
        const config = this.getConfig();
        const state = this.state(id);
        if (!event || !event.type) return;
        if (event.type === "turn/start") {
          state.running = true;
          state.lastEndKind = null;
          this.cancelPending(id);
          emitChange();
          return;
        }
        if (event.type === "turn/end") {
          state.running = false;
          this.cancelPending(id);
          const reason = event.data && event.data.reason;
          const kind = reason && reason.kind;
          state.lastEndKind = kind || null;
          log(config.verbose, "turn/end " + id + " kind=" + String(kind));
          if (TERMINAL_KINDS.has(kind)) {
            state.consecutive = 0;
            // A manual stop is deliberately sticky. The user must click
            // Resume, even when a later turn happens to complete normally.
            emitChange();
            return;
          }
          if (RETRYABLE_KINDS.has(kind)) this.schedule(id, "turn/end:" + kind);
          emitChange();
          return;
        }
        if (event.type === "user/message") {
          const data = event.data || {};
          const source = data.source || {};
          if (source.kind !== "user") return;
          const requestId = source.rpcId;
          const isOwnRequest = typeof requestId === "string" && state.autoRequestIds.has(requestId);
          // Current DSH always carries source.rpcId for beginSubmission echoes.
          // Do not fall back to text/time matching: a human can intentionally
          // send the same configured text and must be allowed to take over.
          if (isOwnRequest) {
            if (requestId) state.autoRequestIds.delete(requestId);
            log(config.verbose, "忽略自动继续回显 " + id);
            return;
          }
          const inRetryLoop = state.consecutive > 0 || state.pendingTimer !== undefined || state.inFlight;
          state.consecutive = 0;
          state.lastEndKind = null;
          this.cancelPending(id);
          if (inRetryLoop) {
            state.stopped = true;
            log(config.verbose, "检测到人工输入，停止自动重试 " + id);
          }
          emitChange();
        }
      }

      cancelPendingState(state) {
        cancelLater(state.pendingTimer);
        state.pendingTimer = undefined;
      }

      cancelPending(id) {
        const state = this.state(id);
        this.cancelPendingState(state);
        emitChange();
      }

      schedule(id, reason) {
        const config = this.getConfig();
        const state = this.state(id);
        if (this.abort || state.subagent || state.stopped || state.running || state.inFlight) return;
        if (state.pendingTimer !== undefined) return;
        if (!this.bindings.has(id)) {
          const binding = this.ensureBinding(id);
          if (!binding) return;
        }
        if (Date.now() - state.lastAttemptAt < config.cooldownMs) return;
        if (state.consecutive >= config.maxConsecutive) {
          state.stopped = true;
          log(config.verbose, "达到连续重试上限，等待人工介入 " + id);
          emitChange();
          return;
        }
        const delay = Math.min(config.graceMs * Math.pow(2, state.consecutive), config.maxBackoffMs);
        state.pendingTimer = later(() => {
          state.pendingTimer = undefined;
          void this.fire(id, reason);
        }, delay);
        log(config.verbose, "检测到可恢复中断 " + id + "，" + delay + "ms 后发送继续");
        emitChange();
      }

      stopRetry(id) {
        const state = this.state(id);
        state.stopped = true;
        this.cancelPendingState(state);
        emitChange();
      }

      resumeRetry(id) {
        const state = this.state(id);
        state.stopped = false;
        state.consecutive = 0;
        // Manual resume is an explicit user action and therefore overrides
        // the previous attempt's cooldown.
        state.lastAttemptAt = 0;
        this.ensureBinding(id);
        if (RETRYABLE_KINDS.has(state.lastEndKind)) this.schedule(id, "resume:" + state.lastEndKind);
        emitChange();
      }

      async fire(id, reason) {
        const config = this.getConfig();
        const state = this.state(id);
        const entry = this.bindings.get(id);
        if (this.abort || !entry || !entry.binding || state.running || state.inFlight || state.stopped) return;
        const session = entry.binding.session;
        state.inFlight = true;
        state.lastAttemptAt = Date.now();
        state.lastAutoAt = Date.now();
        let requestId;
        let result;
        try {
          const submission = session.beginSubmission({ mode: "queue", text: config.continueText, attachments: [] });
          requestId = submission.requestId;
          state.autoRequestIds.add(requestId);
          result = await session.prompt(
            [{ type: "text", text: config.continueText }],
            "queue",
            undefined,
            requestId,
          );
          if (!result || result.ok !== true) {
            const failure = result && result.error;
            if (isPermanentFailure(failure)) state.stopped = true;
            log(config.verbose, "继续发送失败 " + id + ": " + String(failure && (failure.code || failure.message) || "unknown"));
          } else {
            log(config.verbose, "已发送继续到 " + id + "，原因=" + reason);
          }
        } catch (error) {
          if (requestId) state.autoRequestIds.delete(requestId);
          if (isPermanentFailure(error)) state.stopped = true;
          log(config.verbose, "继续发送异常 " + id + ": " + String(error && error.message || error));
        } finally {
          // Count every attempt, including rejected and thrown prompts, so a
          // broken provider cannot bypass maxConsecutive forever.
          state.consecutive += 1;
          state.inFlight = false;
          emitChange();
        }
        if (!this.abort && !state.stopped && !state.running && (!result || result.ok !== true)) {
          this.schedule(id, "prompt-failure");
        }
      }

      async scanInterrupted() {
        const config = this.getConfig();
        if (this.abort || !config.scanOnBoot) return;
        const snapshot = this.sessions.list.getSnapshot();
        const rows = snapshot && snapshot.byId ? snapshot.byId : {};
        const ids = Array.isArray(snapshot && snapshot.ids) ? snapshot.ids : Object.keys(rows);
        const now = Date.now();
        let scanned = 0;
        for (const id of ids) {
          if (scanned >= 8) break;
          const row = rows[id];
          if (!row || row.running || row.origin === "subagent") continue;
          const updated = Number(row.updatedAt);
          if (!Number.isFinite(updated) || now - updated < 0 || now - updated > config.freshMs) continue;
          scanned += 1;
          const entry = this.ensureBinding(id);
          if (!entry) continue;
          await entry.ready;
          const state = this.state(id);
          // processWindow has already folded the retained tail. Only a latest
          // retryable turn/end can arm boot recovery; completed/user tails do not.
          if (!state.running && RETRYABLE_KINDS.has(state.lastEndKind)) {
            this.schedule(id, "scan:interrupted");
          }
        }
        log(config.verbose, "启动扫描完成，检查 " + scanned + " 个最近会话");
      }
    }

    let current = null;
    let settingsForm = form;

    const zh = {
      "autoRetry.title": "断联自动重试",
      "autoRetry.hint": "检测到回合中断、出错或超长时自动发送「继续」",
      "autoRetry.save": "保存",
      "autoRetry.saved": "已保存",
      "autoRetry.reset": "重置为默认",
      "autoRetry.saving": "保存中…",
      "autoRetry.readonly": "只读部署，无法修改",
      "autoRetry.stop": "⏹ 停止自动重试",
      "autoRetry.resume": "▶ 恢复自动重试",
      "autoRetry.stopCount": "⏹ 停止重试 ({count})",
      "autoRetry.graceMs": "宽限期 (ms)",
      "autoRetry.cooldownMs": "冷却期 (ms)",
      "autoRetry.maxConsecutive": "最多连续次数",
      "autoRetry.maxBackoffMs": "退避上限 (ms)",
      "autoRetry.continueText": "继续文本",
      "autoRetry.echoWindowMs": "回显窗口 (ms)",
      "autoRetry.scanOnBoot": "启动时扫描",
      "autoRetry.freshMs": "扫描窗口 (ms)",
      "autoRetry.verbose": "调试日志",
    };
    const en = {
      "autoRetry.title": "Auto Retry",
      "autoRetry.hint": "Auto-send 「继续」 after an interrupted, errored, or overlong turn",
      "autoRetry.save": "Save",
      "autoRetry.saved": "Saved",
      "autoRetry.reset": "Reset to default",
      "autoRetry.saving": "Saving…",
      "autoRetry.readonly": "Read-only deployment",
      "autoRetry.stop": "⏹ Stop auto retry",
      "autoRetry.resume": "▶ Resume auto retry",
      "autoRetry.stopCount": "⏹ Stop retry ({count})",
      "autoRetry.graceMs": "Grace period (ms)",
      "autoRetry.cooldownMs": "Cooldown (ms)",
      "autoRetry.maxConsecutive": "Maximum consecutive attempts",
      "autoRetry.maxBackoffMs": "Backoff cap (ms)",
      "autoRetry.continueText": "Continue text",
      "autoRetry.echoWindowMs": "Echo window (ms)",
      "autoRetry.scanOnBoot": "Scan on startup",
      "autoRetry.freshMs": "Scan window (ms)",
      "autoRetry.verbose": "Debug logging",
    };

    const fields = [
      { field: "graceMs", type: "number" },
      { field: "cooldownMs", type: "number" },
      { field: "maxConsecutive", type: "number" },
      { field: "maxBackoffMs", type: "number" },
      { field: "continueText", type: "text" },
      { field: "echoWindowMs", type: "number" },
      { field: "scanOnBoot", type: "bool" },
      { field: "freshMs", type: "number" },
      { field: "verbose", type: "bool" },
    ];

    function useFormVersion() {
      const pair = React.useState(0);
      React.useEffect(() => {
        if (!settingsForm || typeof settingsForm.subscribe !== "function") return undefined;
        return settingsForm.subscribe(() => { pair[1]((value) => value + 1); });
      }, []);
      return pair[0];
    }

    function AutoRetryRow(props) {
      const t = props.t || ((key) => key);
      useFormVersion();
      const snapshot = settingsForm && settingsForm.getSnapshot
        ? settingsForm.getSnapshot()
        : { value: undefined, writable: false };
      const value = resolveConfig(snapshot.value);
      const writable = snapshot.writable !== false;
      const draftState = React.useState({});
      const savedState = React.useState(false);
      const savingState = React.useState(false);
      const drafts = draftState[0];
      const setDrafts = draftState[1];
      const saved = savedState[0];
      const setSaved = savedState[1];
      const saving = savingState[0];
      const setSaving = savingState[1];

      function display(field) {
        return Object.prototype.hasOwnProperty.call(drafts, field) ? drafts[field] : String(value[field]);
      }
      function stage(field, next) {
        setDrafts((old) => Object.assign({}, old, { [field]: next }));
        setSaved(false);
      }
      async function save() {
        setSaving(true);
        try {
          const ops = [];
          for (const field of fields) {
            if (!Object.prototype.hasOwnProperty.call(drafts, field.field)) continue;
            const text = String(drafts[field.field]).trim();
            let parsed;
            if (field.type === "number") {
              parsed = Number(text);
              if (!Number.isFinite(parsed) || parsed < 0) throw new Error("invalid number");
              parsed = Math.floor(parsed);
            } else if (field.type === "bool") {
              parsed = text === "true" || text === "1";
            } else {
              parsed = text.slice(0, 200);
              if (!parsed) throw new Error("continue text cannot be empty");
            }
            ops.push({ op: "set", path: [field.field], value: parsed });
          }
          if (ops.length > 0 && !(await settingsForm.mutate(ops))) throw new Error("settings write rejected");
          setDrafts({});
          setSaved(true);
        } catch (error) {
          console.error("[auto-retry] settings save failed:", error);
          setSaved(false);
        } finally {
          setSaving(false);
        }
      }
      async function reset() {
        setSaving(true);
        try {
          const ops = fields.map((field) => ({ op: "unset", path: [field.field] }));
          if (!(await settingsForm.mutate(ops))) throw new Error("settings reset rejected");
          setDrafts({});
          setSaved(true);
        } catch (error) {
          console.error("[auto-retry] settings reset failed:", error);
          setSaved(false);
        } finally {
          setSaving(false);
        }
      }

      const rows = fields.map((field) => React.createElement(
        "div", { key: field.field, style: { marginBottom: 8 } },
        React.createElement("label", { style: { display: "block", color: "var(--dsw-alias-label-primary)", fontWeight: 500, fontSize: 13, lineHeight: "20px" } }, t("autoRetry." + field.field)),
        React.createElement("input", {
          className: field.type === "bool" ? "ar2-check" : "ar2-input",
          type: field.type === "bool" ? "checkbox" : field.type,
          value: field.type === "bool" ? undefined : display(field.field),
          checked: field.type === "bool" ? display(field.field) === "true" : undefined,
          onChange: (event) => stage(field.field, field.type === "bool" ? String(event.target.checked) : event.target.value),
          disabled: !writable || saving,
        }),
      ));

      return React.createElement("div", { style: { padding: "4px 2px" } },
        React.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 13, lineHeight: "20px", marginBottom: 6 } }, t("autoRetry.hint")),
        rows,
        React.createElement("div", { style: { marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
          React.createElement("button", { className: "ar2-btn", onClick: () => { void save(); }, disabled: !writable || saving }, saving ? t("autoRetry.saving") : t("autoRetry.save")),
          React.createElement("button", { className: "ar2-btn ar2-btn-secondary", onClick: () => { void reset(); }, disabled: !writable || saving }, t("autoRetry.reset")),
          saved ? React.createElement("span", { style: { color: "var(--dsw-alias-state-success-primary)", fontSize: 12 } }, t("autoRetry.saved")) : null,
          !writable ? React.createElement("span", { style: { color: "var(--dsw-alias-state-warn-primary)", fontSize: 11 } }, t("autoRetry.readonly")) : null,
        ),
      );
    }

    function AutoRetryStopButton(props) {
      const sessionId = props && props.sessionId;
      const tick = React.useState(0);
      React.useEffect(() => {
        const listener = () => { tick[1]((value) => value + 1); };
        changeListeners.add(listener);
        return () => { changeListeners.delete(listener); };
      }, []);
      const state = current && sessionId ? current.state(sessionId) : undefined;
      const stopped = !!(state && state.stopped);
      const count = state ? state.consecutive : 0;
      const t = props.t || ((key) => key);
      const label = stopped ? t("autoRetry.resume") : count > 0 ? t("autoRetry.stopCount", { count }) : t("autoRetry.stop");
      return React.createElement("button", {
        type: "button",
        className: "ar2-stop" + (stopped ? " ar2-stop-off" : count > 0 ? " ar2-stop-on" : ""),
        onClick: () => {
          if (!current || !sessionId) return;
          if (stopped) current.resumeRetry(sessionId); else current.stopRetry(sessionId);
        },
        title: label,
        "data-auto-retry-stop": "1",
      }, label);
    }

    function installStyles() {
      if (typeof document === "undefined" || !document.head || document.getElementById("auto-retry-styles")) return;
      const style = document.createElement("style");
      style.id = "auto-retry-styles";
      style.textContent = [
        ".ar2-input{box-sizing:border-box;width:100%;margin-top:4px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none}",
        ".ar2-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}",
        ".ar2-input:disabled,.ar2-check:disabled{opacity:.55;cursor:not-allowed}",
        ".ar2-check{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px;margin-top:6px;cursor:pointer}",
        ".ar2-btn{display:inline-flex;align-items:center;padding:6px 14px;border:0;border-radius:8px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-inverse,#fff);font:inherit;font-size:13px;cursor:pointer}",
        ".ar2-btn-secondary{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}",
        ".ar2-btn:disabled{opacity:.55;cursor:not-allowed}",
        ".ar2-stop{display:inline-flex;align-items:center;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}",
        ".ar2-stop-on{border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary) 55%,transparent);color:var(--dsw-alias-state-danger-primary)}",
        ".ar2-stop-off{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent);color:var(--dsw-alias-state-success-primary)}",
      ].join("");
      document.head.append(style);
    }

    installStyles();
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "auto-retry: locale");
    current = new AutoRetryRunner(ctx.sessions, configSnapshot);
    current.start();
    ctx.effect(() => () => {
      if (current) current.dispose();
      current = null;
      const style = typeof document !== "undefined" ? document.getElementById("auto-retry-styles") : null;
      if (style) style.remove();
    }, "auto-retry: runner");

    ctx.slots.inject("settings.general.item", () => ctx.slots.register({
      name: "settings.general.item",
      id: "auto-retry",
      order: 90,
      locale: NS,
    }, AutoRetryRow));

    ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
      name: "conversation.input.left",
      id: "auto-retry-stop",
      order: 20,
      locale: NS,
    }, AutoRetryStopButton));
  },
};

  },
});
