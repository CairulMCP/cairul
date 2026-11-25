import { spawn } from 'node:child_process';
import { kill, platform } from 'node:process';
import { z } from 'zod';
import type { LocalAction } from '../check-kinds.js';
import type { PluginFactory } from '../plugin.js';

export const shellKind = 'shell.command';
export const shellOptions = z.strictObject({
  command: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !value.includes('\0'), 'Command contains a null byte.'),
});

export const shellAction = (command: string): LocalAction => ({ kind: shellKind, options: { command } });

const shellPlugin: PluginFactory = () => ({
  checkKinds: {
    [shellKind]: {
      validate(options) {
        shellOptions.parse(options);
      },
      async run(options, { projectDir, signal }) {
        const detail = await runCommand(shellOptions.parse(options), projectDir, signal);
        return detail ? { status: 'pending', detail } : { status: 'passed' };
      },
    },
  },
});

export default shellPlugin;

async function runCommand(
  { command }: { command: string },
  cwd: string,
  signal: AbortSignal
): Promise<string | undefined> {
  if (signal.aborted) return 'Check interrupted.';
  return new Promise((resolve) => {
    const detached = platform !== 'win32';
    const child = spawn(command, { shell: true, cwd, detached, stdio: 'ignore' });
    const stop = () => {
      if (!child.pid) return;
      try {
        if (detached) kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    const finish = (detail?: string) => {
      signal.removeEventListener('abort', stop);
      resolve(detail);
    };
    signal.addEventListener('abort', stop, { once: true });
    child.once('error', () => finish('Could not launch the shell command.'));
    child.once('close', (code, termination) => {
      if (signal.aborted) finish('Check timed out or was interrupted.');
      else if (code === 0) finish();
      else finish(code === null ? `Terminated by ${termination}.` : `Exited with code ${code}.`);
    });
  });
}
