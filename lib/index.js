// dsh-client-auto-retry host half: 声明 auto-retry 的可配置 schema。
// 纯客户端行为(监听会话事件+发继续)都在 lib/client.js; host 只提供配置面。
//
// 两代 DSH 的设置机制不同:
//   0.1.x : settings.register(ns, schema, { applies }) —— 独立 settings 命名空间
//   0.2.x : 设置表单来自**插件自己的 Config 导出**, settings.configure() 只登记页面策略。
//           且只有 volatile 字段会进入 describe(), 否则整个 entry 不进设置表单。
import z from "@deepseek-ai/schemastery";

const NS = "auto-retry";

/**
 * 把字段标记为 volatile —— 0.2.x 的 SettingsForms.describe() 只投影 volatile 字段，
 * 一个都没有时整个 entry 不会进入设置表单（卡片就读不到值）。
 * 旧版 schemastery 没有 volatile() 方法时退回 extra("volatile", true)，
 * 两者都不可用则原样返回（此时只能靠插件内置 DEFAULTS）。
 */
function live(schema) {
  if (typeof schema.volatile === "function") return schema.volatile();
  if (typeof schema.extra === "function") return schema.extra("volatile", true);
  return schema;
}

/** 字段默认值（单一事实来源）。 */
const DEFAULTS = {
  graceMs: 5000,
  cooldownMs: 20000,
  maxConsecutive: 4,
  maxBackoffMs: 300000,
  continueText: "继续",
  echoWindowMs: 30000,
  scanOnBoot: true,
  freshMs: 15 * 60 * 1000,
  verbose: true
};

const Fields = {
  /** 宽限期: 中断后等多少毫秒再自动发送「继续」。 */
  graceMs: z.natural().default(DEFAULTS.graceMs),
  /** 冷却期: 同一会话两次自动继续的最小间隔。 */
  cooldownMs: z.natural().default(DEFAULTS.cooldownMs),
  /** 最多连续自动继续次数, 超过后等待人工介入。 */
  maxConsecutive: z.natural().min(1).default(DEFAULTS.maxConsecutive),
  /** 指数退避上限: 第 n 次重试等待 graceMs * 2^(n-1), 封顶此值 (ms)。 */
  maxBackoffMs: z.natural().min(1000).default(DEFAULTS.maxBackoffMs),
  /** 发送的继续文本。 */
  continueText: z.string().default(DEFAULTS.continueText),
  /** 自身回显窗口: 自动发送后此窗口内收到相同文本视为自身回显 (ms)。 */
  echoWindowMs: z.natural().default(DEFAULTS.echoWindowMs),
  /** 页面加载时扫描最近被中断的会话并恢复。 */
  scanOnBoot: z.boolean().default(DEFAULTS.scanOnBoot),
  /** 扫描窗口: 只恢复此时间段内被中断的会话 (ms)。 */
  freshMs: z.natural().default(DEFAULTS.freshMs),
  /** 调试日志。 */
  verbose: z.boolean().default(DEFAULTS.verbose)
};

/** 0.2.x: 本插件的 Config schema —— 设置表单与 live 编辑都从这里投影。 */
const Config = z.object({
  graceMs: live(Fields.graceMs),
  cooldownMs: live(Fields.cooldownMs),
  maxConsecutive: live(Fields.maxConsecutive),
  maxBackoffMs: live(Fields.maxBackoffMs),
  continueText: live(Fields.continueText),
  echoWindowMs: live(Fields.echoWindowMs),
  scanOnBoot: live(Fields.scanOnBoot),
  freshMs: live(Fields.freshMs),
  verbose: live(Fields.verbose)
});

/** 0.1.x 沿用旧名字。 */
const AutoRetrySchema = Config;

function apply(ctx) {
  ctx.inject(["settings"], (settingsCtx) => {
    const settings = settingsCtx.settings;
    if (settings === undefined || settings === null) {
      console.log("[auto-retry] settings 服务不可用, 使用内置默认配置");
      return;
    }

    // 0.2.x: schema 已由 Config 导出声明, 这里只登记"不要自动生成设置页"
    // (本插件自带设置卡片, 避免设置里出现两个入口)。
    if (typeof settings.register !== "function" && typeof settings.configure === "function") {
      try {
        settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber), "auto-retry: settings page policy");
      } catch (err) {
        console.log("[auto-retry] settings.configure 失败:", err && err.message);
      }
      return;
    }

    // 0.1.x: 注册独立 settings 命名空间。
    if (typeof settings.register === "function") {
      try {
        settings.register(NS, AutoRetrySchema, { applies: "live" });
      } catch (err) {
        console.log("[auto-retry] settings.register 失败:", err && err.message);
      }
    }
  });
}

export { NS, DEFAULTS, Config, AutoRetrySchema, apply };
