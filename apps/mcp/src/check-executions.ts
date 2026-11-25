import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kill, pid } from 'node:process';
import { z } from 'zod';

export const executionSchema = z.object({
  id: z.uuid(),
  owner: z.number().int().positive(),
  deadline: z.number().int().positive(),
});
type Execution = z.infer<typeof executionSchema>;
const outcomeSchema = z.object({ detail: z.string().max(2000).optional() });
const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
let stopping = false;

export function createExecution(timeout: number): Execution {
  return { id: randomUUID(), owner: pid, deadline: Date.now() + timeout };
}

const file = (folder: string, id: string, suffix: string) => join(folder, 'executions', `${id}.${suffix}`);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export function launchExecution(
  folder: string,
  execution: Execution,
  run: (signal: AbortSignal) => Promise<string | undefined>
) {
  const controller = new AbortController();
  const { id, deadline } = execution;
  if (stopping) controller.abort();
  const done = (async () => {
    const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const signal = AbortSignal.any([controller.signal, timeout]);
    const timer = setInterval(() => {
      void readFile(file(folder, id, 'cancel')).then(
        () => controller.abort(),
        () => undefined
      );
    }, 250);
    timer.unref();
    try {
      const result = await run(signal).catch(() => 'Test execution failed.');
      const detail = signal.aborted
        ? timeout.aborted
          ? 'Test execution timed out.'
          : 'Test execution was cancelled.'
        : result;
      await mkdir(join(folder, 'executions'), { mode: 0o700, recursive: true });
      const temporary = file(folder, id, 'tmp');
      await writeFile(temporary, JSON.stringify({ detail }), { mode: 0o600 });
      await rename(temporary, file(folder, id, 'json'));
    } finally {
      clearInterval(timer);
    }
  })()
    .catch(() => undefined)
    .finally(() => active.delete(id));
  active.set(id, { controller, done });
}

export async function observeExecution(folder: string, execution: Execution) {
  try {
    const result = outcomeSchema.parse(JSON.parse(await readFile(file(folder, execution.id, 'json'), 'utf8')));
    return { ...result };
  } catch (error) {
    if (!missing(error)) return { detail: 'Test execution result could not be read.' };
  }
  if (Date.now() > execution.deadline + 5000) return { detail: 'Test execution did not finish before its deadline.' };
  if (execution.owner === pid) {
    return active.has(execution.id) ? undefined : { detail: 'Test execution ended before saving a result.' };
  }
  try {
    kill(execution.owner, 0);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
    return { detail: 'The MCP process running the test exited.' };
  }
}

export async function cancelExecution(folder: string, execution: Execution) {
  active.get(execution.id)?.controller.abort();
  await mkdir(join(folder, 'executions'), { mode: 0o700, recursive: true });
  await writeFile(file(folder, execution.id, 'cancel'), '', { mode: 0o600 });
}

export async function removeExecution(folder: string, execution: Execution) {
  await rm(file(folder, execution.id, 'json'), { force: true });
}

export async function shutdownExecutions() {
  stopping = true;
  const jobs = [...active.values()];
  for (const job of jobs) job.controller.abort();
  await Promise.all(jobs.map(({ done }) => done));
}
