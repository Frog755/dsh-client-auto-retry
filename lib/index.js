// dsh-client-auto-retry host half: 注册 auto-retry 配置 schema。
// 纯客户端行为(监听事件流+发继续)都在 lib/client.js; host 只提供可配置项。
import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

const NS = "auto-retry";

const AutoRetrySchema = z.object({
  /** 宽限期: 中断后等多少毫秒再自动发送「继续」。 */
  graceMs: z.natural().default(5000),
  /** 冷却期: 同一会话两次自动继续的最小间隔。 */
  cooldownMs: z.natural().default(20000),
  /** 最多连续自动继续次数, 超过后等待人工介入。 */
  maxConsecutive: z.natural().min(1).default(4),
  /** 指数退避上限: 第 n 次重试等待 graceMs * 2^(n-1), 封顶此值 (ms)。防连续失败时立刻继续烧 token。 */
  maxBackoffMs: z.natural().min(1000).default(300000),
  /** 发送的继续文本。 */
  continueText: z.string().default("继续"),
  /** 自身回显窗口: 自动发送「继续」后, 此窗口内收到内容相同的 user/message 视为自身回显, 不计为人工输入 (ms)。 */
  echoWindowMs: z.natural().default(30000),
  /** 页面加载时扫描最近被中断的会话并恢复。 */
  scanOnBoot: z.boolean().default(true),
  /** 扫描窗口: 只恢复此时间段内被中断的会话 (ms)。 */
  freshMs: z.natural().default(15 * 60 * 1000),
  /** 调试日志。 */
  verbose: z.boolean().default(true)
});

function apply(ctx) {
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.register(settingsNamespace(NS), AutoRetrySchema, {
      applies: "live"
    });
  });
}

export { NS, AutoRetrySchema, apply };
