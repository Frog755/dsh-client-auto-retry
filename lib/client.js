// dsh-client-auto-retry client half — DSH ModuleLoader 格式
// 监听会话事件流, 检测回合被中断/出错/超长时自动发送「继续」。
// 设置卡片通过 settings.general.item 注册（参照 dsh-wallpaper 模式）。
//
// 事件协议:
//   api.events.mux({}, signal) -> 帧: { type: "session/event", sessionId, event: { type, data } }
//   turn/end 事件的 data.reason.kind ∈ { completed, aborted, blocked, interrupted, error, max-tokens }

window.__ModuleLoader__.load({
  id: "@frog755/dsh-client-auto-retry",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const runtime = require("@deepseek-ai/dsh-client-runtime/client");

    const NS = "auto-retry";

    const DEFAULTS = {
      graceMs: 5000,
      cooldownMs: 20000,
      maxConsecutive: 5,
      continueText: "继续",
      scanOnBoot: true,
      freshMs: 15 * 60 * 1000,
      verbose: true
    };

    const FIELDS = [
      { field: "graceMs", label: "宽限期 (ms)", hint: "中断后等多少毫秒再自动发送「继续」", type: "number" },
      { field: "cooldownMs", label: "冷却期 (ms)", hint: "同一会话两次自动继续的最小间隔", type: "number" },
      { field: "maxConsecutive", label: "最多连续次数", hint: "连续自动继续多少次后停下等人工介入", type: "number" },
      { field: "continueText", label: "继续文本", hint: "自动发送的文本内容", type: "text" },
      { field: "scanOnBoot", label: "启动时扫描", hint: "页面加载时扫描最近被中断的会话", type: "bool" },
      { field: "freshMs", label: "扫描窗口 (ms)", hint: "只恢复此时间段内被中断的会话", type: "number" },
      { field: "verbose", label: "调试日志", hint: "在控制台输出 [auto-retry] 日志", type: "bool" }
    ];

    function resolveConfig(value) {
      const v = value && typeof value === "object" ? value : {};
      const out = {};
      for (const key of Object.keys(DEFAULTS)) {
        const val = v[key];
        out[key] = val === undefined || val === null ? DEFAULTS[key] : val;
      }
      return out;
    }

    function log(verbose, msg) {
      if (verbose) console.log("[auto-retry] " + msg);
    }

    async function pumpStream(open, onFrame, onReconnect, backoffMs, verbose, signal) {
      let attempts = 0;
      while (!signal.aborted) {
        attempts++;
        try {
          console.log("[auto-retry] 尝试连接 mux, 第 " + attempts + " 次");
          const stream = open(signal);
          const isAsyncIter = stream && typeof stream[Symbol.asyncIterator] === "function";
          console.log("[auto-retry] mux 返回类型: " + (typeof stream) + (isAsyncIter ? " (async iterable)" : " (NOT iterable!)"));
          let frameCount = 0;
          if (!isAsyncIter) {
            console.log("[auto-retry] mux 不是 async iterable, 无法迭代");
            return;
          }
          for await (const frame of stream) {
            frameCount++;
            if (signal.aborted) return;
            try { onFrame(frame); } catch (err) { log(verbose, "frame error: " + err.message); }
          }
          console.log("[auto-retry] mux 流自然结束, 共收到 " + frameCount + " 帧");
        } catch (err) {
          console.log("[auto-retry] mux 流错误: " + (err && err.message ? err.message : String(err)));
        }
        if (signal.aborted) return;
        log(verbose, "stream closed, reconnecting in " + backoffMs + "ms");
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, backoffMs);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    }

    class AutoRetryRunner {
      constructor(api, getConfig) {
        this.api = api;
        this.getConfig = getConfig;
        this.states = new Map();
        this.abort = new AbortController();
        this._scanTimer = null;
        this._started = false;
      }

      state(sessionId) {
        let s = this.states.get(sessionId);
        if (!s) {
          s = {
            consecutive: 0,
            lastAttemptAt: 0,
            pendingTimer: undefined,
            queued: 0,
            running: false,
            subagent: false
          };
          this.states.set(sessionId, s);
        }
        return s;
      }

      start() {
        if (this._started) return;
        this._started = true;
        const config = this.getConfig();
        void pumpStream(
          (signal) => this.api.events.mux({}, signal),
          (frame) => this.onMuxFrame(frame),
          () => this.scanInterrupted(),
          Math.min(config.cooldownMs || 20000, 5000),
          config.verbose,
          this.abort.signal
        );
        if (config.scanOnBoot) {
          this._scanTimer = setTimeout(() => void this.scanInterrupted(), 5000);
        }
      }

      dispose() {
        this.abort.abort();
        if (this._scanTimer) clearTimeout(this._scanTimer);
        for (const s of this.states.values()) {
          if (s.pendingTimer) clearTimeout(s.pendingTimer);
        }
        this.states.clear();
      }

      onMuxFrame(frame) {
        const config = this.getConfig();
        // mux 帧是 RPC envelope: { rpcId, payload }, 实际内容在 payload 里
        const payload = (frame && frame.payload) || frame;
        if (!payload || payload.type !== "session/event") return;
        const sessionId = payload.sessionId;
        if (!sessionId) return;
        const state = this.state(sessionId);
        const event = payload.event;
        if (!event || !event.type) return;

        if (event.type === "turn/start") {
          state.running = true;
          this.cancelPending(sessionId);
        } else if (event.type === "turn/end") {
          state.running = false;
          this.cancelPending(sessionId);
          const reason = event.data && event.data.reason;
          const kind = reason && reason.kind;
          const errCode = reason && reason.error ? (reason.error.code || "") : "";
          const errMsg = reason && reason.error ? (reason.error.message || "") : "";
          log(config.verbose, "turn/end kind=" + String(kind) + " err=" + String(errCode) + " " + String(errMsg).slice(0, 80));
          if (kind === "completed" || kind === "aborted" || kind === "blocked") {
            state.consecutive = 0;
            return;
          }
          if (kind === "error" || kind === "interrupted" || kind === "max-tokens") {
            this.schedule(sessionId, "turn/end:" + kind);
          } else {
            log(config.verbose, "turn/end kind=" + String(kind) + " 未处理");
          }
        } else if (event.type === "user/message") {
          if (event.data && event.data.source && event.data.source.kind === "user") {
            state.consecutive = 0;
            this.cancelPending(sessionId);
          }
        }
      }

      schedule(sessionId, reason) {
        const config = this.getConfig();
        const state = this.state(sessionId);
        if (state.subagent) return;
        if (state.pendingTimer !== undefined) return;
        if (Date.now() - state.lastAttemptAt < config.cooldownMs) return;
        if (state.consecutive >= config.maxConsecutive) {
          log(config.verbose, "跳过 " + sessionId + "(" + reason + "): 已连续自动继续 " + state.consecutive + " 次, 等待人工");
          return;
        }
        if (state.queued > 0) return;

        const timer = setTimeout(() => {
          if (state.pendingTimer !== timer) return;
          state.pendingTimer = undefined;
          void this.fire(sessionId, reason);
        }, config.graceMs);
        state.pendingTimer = timer;
        log(config.verbose, "检测到中断 " + sessionId + "(" + reason + "), " + config.graceMs + "ms 后自动发送「" + config.continueText + "」");
      }

      cancelPending(sessionId) {
        const state = this.state(sessionId);
        if (state.pendingTimer === undefined) return;
        clearTimeout(state.pendingTimer);
        state.pendingTimer = undefined;
      }

      async fire(sessionId, reason) {
        const config = this.getConfig();
        const state = this.state(sessionId);
        if (state.running) return;
        if (state.queued > 0) return;
        if (state.subagent) return;

        state.lastAttemptAt = Date.now();
        try {
          const response = await this.api.sessions.prompt({
            sessionId: sessionId,
            mode: "queue",
            content: [{ type: "text", text: config.continueText }]
          });
          if (response && response.result && response.result.ok) {
            state.consecutive += 1;
            log(config.verbose, "已自动发送「" + config.continueText + "」到 " + sessionId + "(" + reason + "), 第 " + state.consecutive + " 次");
          } else {
            const err = response && response.result && response.result.error;
            log(config.verbose, "发送失败 " + sessionId + ": " + (err ? err.code + " " + err.message : "unknown"));
          }
        } catch (err) {
          log(config.verbose, "发送异常 " + sessionId + ": " + err.message);
        }
      }

      async scanInterrupted() {
        const config = this.getConfig();
        if (!config.scanOnBoot) return;
        try {
          const resp = await this.api.sessions.list({});
          if (!resp || !resp.result || !resp.result.ok) return;
          const sessions = resp.result.value || resp.result.data || [];
          if (!Array.isArray(sessions)) return;
          const now = Date.now();
          let scanned = 0;
          for (const s of sessions) {
            if (scanned >= 8) break;
            const sessionId = s.id || s.sessionId;
            if (!sessionId) continue;
            const state = this.state(sessionId);
            if (state.subagent) continue;
            const updated = s.updatedAt || s.lastActivityAt;
            if (!updated) continue;
            const updatedMs = typeof updated === "number" ? updated : Date.parse(updated);
            if (isNaN(updatedMs)) continue;
            if (now - updatedMs > config.freshMs) continue;
            scanned += 1;
            this.schedule(sessionId, "scan:interrupted");
          }
          log(config.verbose, "扫描完成, 检查 " + scanned + " 个最近会话");
        } catch (err) {
          log(config.verbose, "扫描失败: " + err.message);
        }
      }
    }

    // ---------- 设置卡片 (参照 dsh-wallpaper 模式) ----------
    const zh = {
      "autoRetry.title": "断联自动重试",
      "autoRetry.hint": "检测到回合中断/出错/超长时自动发送「继续」",
      "autoRetry.save": "保存",
      "autoRetry.saved": "已保存",
      "autoRetry.saving": "保存中…",
      "autoRetry.reset": "重置为默认",
      "autoRetry.overridden": "已覆盖",
      "autoRetry.readonly": "只读部署, 无法修改"
    };
    const en = {
      "autoRetry.title": "Auto Retry",
      "autoRetry.hint": "Auto-send 「继续」 when a turn is interrupted/errored/overlong",
      "autoRetry.save": "Save",
      "autoRetry.saved": "Saved",
      "autoRetry.saving": "Saving…",
      "autoRetry.reset": "Reset to default",
      "autoRetry.overridden": "Overridden",
      "autoRetry.readonly": "Read-only deployment"
    };

    function AutoRetryRow(props) {
      console.log("[auto-retry] AutoRetryRow 渲染, props keys:", Object.keys(props || {}).join(","));
      const t = props.t || function (k) { return k; };
      const useStore = props.useStore || function () { return {}; };
      const setConfig = props.setConfig;
      const resetConfig = props.resetConfig;
      const config = useStore(function (state) { return state.value; }) || {};
      const value = resolveConfig(config);
      const writable = useStore(function (state) { return state.writable; }) !== false;
      const draftsState = React.useState({});
      const drafts = draftsState[0];
      const setDrafts = draftsState[1];
      const savedState = React.useState(false);
      const saved = savedState[0];
      const setSaved = savedState[1];
      const savingState = React.useState(false);
      const saving = savingState[0];
      const setSaving = savingState[1];

      function stage(field, text) {
        setDrafts(function (d) { const nd = Object.assign({}, d); nd[field] = text; return nd; });
        setSaved(false);
      }

      function display(field) {
        if (field in drafts) return drafts[field];
        const v = value[field];
        return v === undefined ? "" : String(v);
      }

      async function save() {
        setSaving(true);
        try {
          for (const f of FIELDS) {
            if (!(f.field in drafts)) continue;
            const text = String(drafts[f.field]).trim();
            let parsed;
            if (f.type === "number") {
              parsed = Number(text);
              if (!Number.isFinite(parsed)) continue;
            } else if (f.type === "bool") {
              parsed = text === "true" || text === "1";
            } else {
              parsed = text;
            }
            await setConfig(f.field, parsed);
          }
          setDrafts({});
          setSaved(true);
        } catch (err) {
          console.log("[auto-retry] 保存失败:", err);
        } finally {
          setSaving(false);
        }
      }

      const rows = FIELDS.map(function (f) {
        return React.createElement(
          "div", { key: f.field, style: { marginBottom: 10 } },
          React.createElement("label", { style: { fontWeight: 600, fontSize: 13, display: "block" } },
            f.label
          ),
          React.createElement("input", {
            type: f.type === "bool" ? "checkbox" : f.type === "number" ? "number" : "text",
            value: f.type === "bool" ? undefined : display(f.field),
            checked: f.type === "bool" ? display(f.field) === "true" : undefined,
            onChange: function (ev) { stage(f.field, f.type === "bool" ? String(ev.target.checked) : ev.target.value); },
            disabled: !writable,
            style: { marginTop: 4, padding: "4px 8px", borderRadius: 6, border: "1px solid #444", background: "#1e1e1e", color: "#eee", width: "100%", boxSizing: "border-box" }
          }),
          React.createElement("div", { style: { fontSize: 11, color: "#888", marginTop: 2 } }, f.hint)
        );
      });

      return React.createElement("div", { style: { padding: 12 } },
        React.createElement("div", { style: { fontSize: 13, color: "#aaa", marginBottom: 12 } }, t("autoRetry.hint")),
        rows,
        React.createElement("div", { style: { marginTop: 12, display: "flex", gap: 8, alignItems: "center" } },
          React.createElement("button", {
            onClick: function () { void save(); },
            disabled: !writable || saving,
            style: { padding: "6px 16px", borderRadius: 6, border: "none", background: writable ? "#2563eb" : "#444", color: "#fff", cursor: writable ? "pointer" : "not-allowed" }
          }, saving ? t("autoRetry.saving") : t("autoRetry.save")),
          saved ? React.createElement("span", { style: { color: "#22c55e", fontSize: 12 } }, t("autoRetry.saved")) : null,
          !writable ? React.createElement("span", { style: { color: "#f87171", fontSize: 11 } }, t("autoRetry.readonly")) : null
        )
      );
    }

    let current = null;
    let cardActions = null;

    function apply(ctx) {
      const api = ctx.connection && ctx.connection.api;
      if (api === undefined) {
        console.log("[auto-retry] connection.api 不可用, 跳过");
        return;
      }

      // 绑定 settings scope
      let scope = null;
      try {
        if (ctx.settingsScope !== undefined) {
          scope = ctx.settingsScope.bind({ namespace: NS });
        }
      } catch (err) {
        console.log("[auto-retry] settingsScope 不可用:", err.message);
      }

      function getConfig() {
        if (scope) {
          try { return resolveConfig(scope.getSnapshot().value); } catch (err) {}
        }
        return resolveConfig(undefined);
      }

      // 引擎
      ctx.effect(function () {
        if (current) current.dispose();
        current = new AutoRetryRunner(api, getConfig);
        current.start();
        return function () { if (current) { current.dispose(); current = null; } };
      });

      // locale + 设置卡片 (settings.general.item, 参照 dsh-wallpaper)
      console.log("[auto-retry] 检查服务: slots=" + (ctx.slots !== undefined) + " locale=" + (ctx.locale !== undefined) + " settingsScope=" + (ctx.settingsScope !== undefined));
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "auto-retry: locale");
        console.log("[auto-retry] locale 注册已调用");
      } catch (err) {
        console.log("[auto-retry] locale 注册失败:", err.message);
      }

      try {
        const slots = ctx.slots;
        if (slots !== undefined) {
          console.log("[auto-retry] slots 可用, 开始注册卡片");
          // store 保存配置值 + writable（参照 dsh-wallpaper: defineStore({init, actions})）
          const store = runtime.defineStore({
            init: () => {
              const snap = scope ? scope.getSnapshot() : { value: undefined, writable: false };
              return { value: snap.value, writable: snap.writable !== false };
            },
            actions: {
              setValue: (draft, value) => { draft.value = value; },
              setWritable: (draft, writable) => { draft.writable = writable; }
            }
          });
          // 订阅 scope 变化更新 store
          if (scope) {
            ctx.effect(function () {
              return scope.subscribe(function () {
                const snap = scope.getSnapshot();
                const created = store.create();
                created.actions.setValue(snap.value);
                created.actions.setWritable(snap.writable !== false);
              });
            });
          }
          ctx.slots.inject("settings.general.item", function () {
            console.log("[auto-retry] settings.general.item inject 回调执行");
            return ctx.slots.register({
              name: "settings.general.item",
              id: "auto-retry",
              order: 90,
              store: store,
              locale: NS,
              inject: function (bound) {
                cardActions = bound;
                return {
                  setConfig: function (field, val) {
                    if (scope) return scope.set(field, val);
                    return Promise.resolve();
                  },
                  resetConfig: function (field) {
                    if (scope) return scope.unset(field);
                    return Promise.resolve();
                  }
                };
              }
            }, AutoRetryRow);
          });
        }
      } catch (err) {
        console.log("[auto-retry] 设置卡片注册失败:", err.message);
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "connection", "settingsScope"];
    exports.NS = NS;
    return module.exports;
  }
});
