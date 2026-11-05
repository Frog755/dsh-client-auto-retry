// dsh-client-auto-retry Host half for DeepSeek Harness 0.2.x.
// The current DSH settings pipeline discovers the named Config export from the
// plugin entry. Every browser-editable field must be volatile so it appears in
// the live ConfigForms mirror.
import z from "@deepseek-ai/schemastery";

const NS = "auto-retry";

/** Live settings consumed by the browser half through ctx.configForms. */
export const Config = z.object({
  graceMs: z.natural().default(5000).volatile(),
  cooldownMs: z.natural().default(20000).volatile(),
  maxConsecutive: z.natural().min(1).default(4).volatile(),
  maxBackoffMs: z.natural().min(1000).default(300000).volatile(),
  continueText: z.string().min(1).max(200).default("继续").volatile(),
  echoWindowMs: z.natural().default(30000).volatile(),
  scanOnBoot: z.boolean().default(true).volatile(),
  freshMs: z.natural().default(15 * 60 * 1000).volatile(),
  verbose: z.boolean().default(true).volatile(),
});

// Kept as a source-compatible alias for downstream tooling that imported the
// old name. DSH itself uses the named Config export above.
export const AutoRetrySchema = Config;
export { NS };

/** Disable DSH's generic auto-generated page; the client half owns its card. */
export function apply(ctx) {
  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
}
