import { z } from 'zod';
import type { CheckContext, CheckKind, CheckResult, CairulPlugin } from './plugin.js';

export const kindName = z.string().regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/, 'Use a namespaced check kind.');
export const optionsSchema = z.record(z.string(), z.json());

export const localActionSchema = z.strictObject({
  kind: kindName,
  options: optionsSchema.default({}),
});

export type LocalAction = z.infer<typeof localActionSchema>;

const resultSchema = z.object({
  status: z.enum(['passed', 'pending', 'error']),
  detail: z.string().trim().max(2000).optional(),
});
const pluginSchema: z.ZodType<CairulPlugin> = z.object({
  checkKinds: z.record(
    kindName,
    z.object({
      execution: z.literal('background').optional(),
      validate: z.custom<NonNullable<CheckKind['validate']>>((value) => typeof value === 'function').optional(),
      run: z.custom<CheckKind['run']>((value) => typeof value === 'function'),
    })
  ),
});

export class CheckRegistry {
  private readonly kinds = new Map<string, CheckKind>();

  use(plugin: unknown) {
    const { checkKinds } = pluginSchema.parse(plugin);
    for (const kind of Object.keys(checkKinds)) {
      if (this.kinds.has(kind)) throw new Error(`Check kind "${kind}" is already registered.`);
    }
    for (const [kind, implementation] of Object.entries(checkKinds)) this.kinds.set(kind, implementation);
  }

  backgroundTimeout(action: LocalAction) {
    if (this.kinds.get(action.kind)?.execution !== 'background') return;
    const seconds = z.number().int().min(1).max(3600).catch(120).parse(action.options.timeoutSeconds);
    return seconds * 1000;
  }

  async validate(action: LocalAction) {
    const kind = this.kinds.get(action.kind);
    if (!kind) throw new Error(`Unknown check kind "${action.kind}".`);
    await kind.validate?.(action.options);
  }

  async run(action: LocalAction, context: CheckContext) {
    const kind = this.kinds.get(action.kind);
    if (!kind) return `Check kind "${action.kind}" is unavailable.`;
    const { signal } = context;
    const interrupted = 'Check timed out or was interrupted.';
    if (signal.aborted) return interrupted;
    let abort: (() => void) | undefined;
    const timeout = new Promise<CheckResult>((resolve) => {
      abort = () => resolve({ status: 'error', detail: interrupted });
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const result = resultSchema.parse(await Promise.race([kind.run(action.options, context), timeout]));
      if (result.status === 'passed') return;
      return result.detail || (result.status === 'pending' ? 'Check is pending.' : 'Check reported an error.');
    } catch {
      return `Check kind "${action.kind}" failed to run or returned an invalid result.`;
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }
}
