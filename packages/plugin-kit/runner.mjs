import { stripVTControlCharacters } from 'node:util';
import { constants } from 'node:fs';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { env, kill, platform } from 'node:process';
import { Buffer } from 'node:buffer';
import spawn from 'cross-spawn';
import { check, error, projectFile, readProjectFile, text, verdict, z } from './checks.mjs';

export const argument = text.refine(
  (arg) => !arg.startsWith('-') && !arg.includes('\0'),
  'Expected a selector value, without a leading dash.'
);
export const list = z.array(argument).min(1).optional();
export const value = argument.optional();
export const lineLocations = z
  .array(z.strictObject({ file: argument, line: z.number().int().positive() }))
  .min(1)
  .optional();
export const repeat = (flag, values = []) => values.flatMap((item) => [flag, item]);
export const option = (flag, item) => (item === undefined ? [] : [flag, item]);
export const alternation = (values = []) => values.join('|');
export const locations = (entries = []) => entries.map(({ file, line }) => `${file}:${line}`);
export const counts = (passed = 0, failed = 0, skipped = 0) => ({ passed, failed, skipped });

export function selectors(shape, keys = Object.keys(shape)) {
  return z.strictObject({ all: z.literal(true).optional(), ...shape }).superRefine((select, context) => {
    const filtering = keys.some((key) => select[key] !== undefined);
    if (select.all === true && filtering)
      context.addIssue({ code: 'custom', message: 'Choose all or a narrower selector.' });
    if (select.all !== true && !filtering)
      context.addIssue({ code: 'custom', message: 'Provide a test selector or set all: true.' });
  });
}

export function requireExclusive(...values) {
  if (values.filter((item) => item !== undefined).length > 1)
    throw new Error('These selectors must be used separately.');
}

function binPath(cwd) {
  const paths = [];
  for (let directory = cwd; ; directory = dirname(directory)) {
    paths.push(join(directory, 'node_modules', '.bin'));
    if (dirname(directory) === directory) return paths.join(delimiter);
  }
}

function runProcess(command, args, cwd, environment, signal, capture) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const detached = platform !== 'win32';
    const child = spawn(command, args, {
      cwd,
      env: environment,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let tail = '';
    const output = [];
    let size = 0;
    const append = (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-1400);
    };
    function collect(chunk) {
      if (size > 16 * 1024 * 1024) return;
      output.push(chunk);
      size += chunk.length;
    }
    child.stdout.on('data', (chunk) => {
      append(chunk);
      if (capture === true || capture === 'combined') collect(chunk);
    });
    child.stderr.on('data', (chunk) => {
      append(chunk);
      if (capture === 'stderr' || capture === 'combined') collect(chunk);
    });
    const stop = () => {
      if (!child.pid) return;
      try {
        if (detached) kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    child.once('error', (cause) => {
      signal.removeEventListener('abort', stop);
      reject(cause);
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', stop);
      resolve({
        code,
        tail: stripVTControlCharacters(tail).trim().slice(-900),
        stdout: size > 16 * 1024 * 1024 ? undefined : Buffer.concat(output).toString('utf8'),
      });
    });
  });
}

function evidence(source, parse) {
  const failures = [];
  const result = parse(source, (name) => {
    if (failures.length < 5) failures.push(name);
  });
  return { ...result, failures };
}

export const report = (name, parse) => async (temp, _output, signal) =>
  evidence(await readProjectFile(temp, name, signal), parse);

export function reportsIn(extension, parse) {
  return async (temp, _output, signal) => {
    const entries = await readdir(temp, { recursive: true });
    const paths = entries.filter((entry) => entry.endsWith(extension));
    if (!paths.length) throw new Error('Runner created no test reports.');
    const total = counts();
    const failures = [];
    for (const path of paths) {
      const result = evidence(await readProjectFile(temp, path, signal), parse);
      for (const key of Object.keys(total)) total[key] += result[key];
      if (failures.length < 5) failures.push(...result.failures.slice(0, 5 - failures.length));
    }
    return { ...total, failures };
  };
}

export const stdout = (parse) => (_temp, output) => {
  if (output === undefined) throw new Error('Runner output exceeded the report size limit.');
  return parse(output);
};

export function testRunner(reportFactory, kind, adapter) {
  return (pluginOptions = {}) => {
    const configured = z
      .strictObject({
        command: z.array(text).min(1).optional(),
        ...adapter.settings,
      })
      .parse(pluginOptions);
    const checkSchema = z.strictObject({
      select: adapter.select,
      cwd: text.optional(),
      timeoutSeconds: z.number().int().min(1).max(3600).default(120),
    });
    function plan(options, temp) {
      const result = adapter.build(options.select, temp, configured);
      const command = configured.command ?? result.command ?? adapter.command;
      if (!command?.length)
        throw new Error('Set plugin options.command to the installed runner and its fixed arguments.');
      return { ...result, command };
    }
    const run = check(checkSchema, async (options, context) => {
      const timeout = globalThis.AbortSignal.timeout(options.timeoutSeconds * 1000);
      const signal = globalThis.AbortSignal.any([context.signal, timeout]);
      let temp;
      try {
        const cwd = await projectFile(context.projectDir, options.cwd ?? '.');
        temp = await mkdtemp(join(tmpdir(), 'cairul-test-'));
        const invocation = plan(options, temp);
        await invocation.prepare?.();
        const [executable, ...fixed] = invocation.command;
        const command = executable.startsWith('.') && !isAbsolute(executable) ? join(cwd, executable) : executable;
        if (isAbsolute(command)) await access(command, constants.X_OK);
        const environment = { ...env, PATH: `${binPath(cwd)}${delimiter}${env.PATH ?? ''}`, ...invocation.env };
        delete environment.NODE_TEST_CONTEXT;
        const result = await runProcess(
          command,
          [...fixed, ...invocation.args],
          cwd,
          environment,
          signal,
          invocation.capture
        );
        if (signal.aborted)
          return error(timeout.aborted ? 'Test execution timed out.' : 'Test execution was cancelled.');
        if (invocation.noMatches?.includes(result.code)) return verdict(false, 'No selected tests matched.');
        let evidence;
        try {
          evidence = await invocation.read(temp, result.stdout, signal);
        } catch {
          if (result.code === 0) return error('Runner exited without a readable test result.');
        }
        const details = evidence?.failures?.length ? 'Failed tests: ' + evidence.failures.join(', ') : result.tail;
        const tail = details ? '\n' + details.slice(0, 900) : '';
        if (!evidence)
          return error(`Test runner exited with ${result.code ?? 'a signal'} before reporting results.${tail}`);
        if (evidence.failed || result.code !== 0) {
          if (!evidence.passed && !evidence.failed && !evidence.skipped)
            return verdict(false, 'No selected tests matched.');
          return verdict(
            false,
            `${evidence.failed} failed, ${evidence.passed} passed, ${evidence.skipped} skipped (exit ${result.code ?? 'signal'}).${tail}`
          );
        }
        if (!evidence.passed)
          return verdict(false, evidence.skipped ? 'All selected tests were skipped.' : 'No selected tests matched.');
        return verdict(true, `${evidence.passed} passed, ${evidence.skipped} skipped.`);
      } catch (cause) {
        if (signal.aborted)
          return error(timeout.aborted ? 'Test execution timed out.' : 'Test execution was cancelled.');
        if (cause?.code === 'ENOENT')
          return error('Test runner or working directory is missing. Install the runner or configure its command.');
        return error(cause instanceof Error ? cause.message.slice(0, 1000) : 'Test execution failed.');
      } finally {
        if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      }
    });
    return {
      checkKinds: {
        ...reportFactory().checkKinds,
        [kind]: {
          ...run,
          execution: 'background',
          validate(options) {
            plan(checkSchema.parse(options), '.');
          },
        },
      },
    };
  };
}

export function pythonSummary(output) {
  const total = [...output.matchAll(/^Ran (\d+) tests? in /gm)].at(-1);
  if (!total) throw new Error('Python runner returned no test summary.');
  const summary = /^(?:OK|FAILED)(?:\s*\(([^\n]*)\))?\s*$/m.exec(output);
  const fields = Object.fromEntries(
    [...(summary?.[1] ?? '').matchAll(/([\w ]+)=(\d+)/g)].map(([, key, value]) => [key.trim(), Number(value)])
  );
  const failed = (fields.failures ?? 0) + (fields.errors ?? 0) + (fields['unexpected successes'] ?? 0);
  const skipped = (fields.skipped ?? 0) + (fields['expected failures'] ?? 0);
  return counts(Math.max(0, Number(total[1]) - skipped - failed), failed, skipped);
}

export async function writeRunnerFile(path, source) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, source, { mode: 0o600 });
}

export function dotnetAdapter(properties) {
  return {
    command: ['dotnet'],
    select: selectors(
      {
        project: value,
        names: list,
        categories: list,
        traits: z
          .array(z.strictObject({ name: argument.regex(/^[\w.]+$/), value: argument }))
          .min(1)
          .optional(),
        filter: value,
      },
      ['names', 'categories', 'traits', 'filter']
    ),
    build(select, temp) {
      const { project, names, categories, traits, filter } = select;
      if (!properties.categories && categories) throw new Error('Use traits or a native filter with this framework.');
      if (!properties.traits && traits) throw new Error('Use categories or a native filter with this framework.');
      if (filter && (names || categories || traits))
        throw new Error('Use the native filter separately from structured selectors.');
      function expression(property, values) {
        if (!values?.length) return;
        if (values.some((entry) => /[&|=~!()\\]/.test(entry)))
          throw new Error('Use a native filter for names containing filter operators.');
        return '(' + values.map((entry) => property + '=' + entry).join('|') + ')';
      }
      const query =
        filter ??
        [
          expression('FullyQualifiedName', names),
          expression(properties.categories, categories),
          ...(traits ?? []).map((entry) => expression(entry.name, [entry.value])),
        ]
          .filter(Boolean)
          .join('&');
      return {
        args: [
          'test',
          ...(project ? [project] : []),
          '--logger',
          'trx;LogFilePrefix=cairul',
          '--results-directory',
          temp,
          ...option('--filter', query || undefined),
        ],
        read: reportsIn('.trx', properties.parse),
      };
    },
  };
}

export async function executeRunner(command, args, cwd, signal) {
  const result = await runProcess(command, args, cwd, env, signal, true);
  if (result.code !== 0 || result.stdout === undefined) throw new Error('Could not read the test result bundle.');
  return result.stdout;
}
