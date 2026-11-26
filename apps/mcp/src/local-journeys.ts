import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kill, pid } from 'node:process';
import { z } from 'zod';
import {
  cancelExecution,
  createExecution,
  executionSchema,
  launchExecution,
  observeExecution,
  removeExecution,
} from './check-executions.js';
import { type CheckRegistry, localActionSchema, optionsSchema } from './check-kinds.js';
import { shellAction } from './checks/shell.js';
import {
  checkSchema,
  configDirectory,
  effectivePlan,
  isMissing,
  planSchema,
  type LocalConfig,
} from './local-config.js';
import { journeyState, type CapturePolicy } from './observations/harness.js';

export const backendStatus = journeyState.extend({
  phase: z.string(),
  incomplete_checks: z.array(checkSchema),
  ready_to_complete: z.boolean(),
});
export const backendStart = z.object({
  journey_id: z.uuid(),
  plan: planSchema,
  journey: backendStatus.extend({
    identity_id: z.uuid(),
    work_item_url: z.url(),
    created_at: z.string(),
  }),
});

type BackendStatus = z.infer<typeof backendStatus>;
type BackendStart = z.infer<typeof backendStart>;
type Action = 'status' | 'abort' | 'complete';
type BackendUpdate = (action: Action, id: string) => Promise<BackendStatus>;

const resultFields = z.object({
  attempts: z.number().int().positive(),
  checked_at: z.string(),
  detail: z.string().optional(),
});
const checkResult = z.discriminatedUnion('status', [
  resultFields.extend({ status: z.literal('running'), execution: executionSchema }),
  resultFields.extend({ status: z.enum(['passed', 'failed']) }),
]);
const journeyFields = z.object({
  id: z.uuid(),
  identity: z.object({
    id: z.uuid(),
    session_id: z.string(),
    harness: z.string(),
    harness_version: z.string().optional(),
    thread_id: z.string().optional(),
    user_id: z.string().optional(),
  }),
  work_item_url: z.string(),
  status: journeyState.shape.status,
  capture_policy: journeyState.shape.capture_policy,
  created_at: z.string(),
  updated_at: z.string(),
  plan: planSchema,
  phase: z.number().int().nonnegative(),
  results: z.record(z.uuid(), checkResult),
  backend: z.object({ phases: z.array(z.string()), status: backendStatus }).optional(),
});
const storedAction = z.union([
  localActionSchema.required({ options: true }),
  localActionSchema
    .omit({ options: true })
    .extend({ config: optionsSchema })
    .transform(({ kind, config }) => ({
      kind,
      options: config,
    })),
]);
const storedJourney = z.union([
  journeyFields.extend({ version: z.literal(2), local_actions: z.record(z.uuid(), storedAction) }),
  journeyFields
    .extend({ version: z.literal(1), commands: z.record(z.uuid(), z.string()) })
    .transform(({ commands, ...state }) => ({
      ...state,
      version: 2 as const,
      local_actions: Object.fromEntries(Object.entries(commands).map(([id, command]) => [id, shellAction(command)])),
    })),
]);
type StoredJourney = z.infer<typeof storedJourney>;

const stateFile = (folder: string) => join(folder, 'state.json');
const serializeState = (state: StoredJourney) => `${JSON.stringify(state, null, 2)}\n`;
const directoryOccupied = (error: unknown) =>
  ['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '');

async function removeEmptyLock(lock: string) {
  await rmdir(lock).catch((error: unknown) => {
    if (!isMissing(error) && !directoryOccupied(error)) throw error;
  });
}

async function lockState(folder: string) {
  const lock = join(folder, '.state-lock');
  const staging = await mkdtemp(join(folder, '.locking-'));
  const owner = `${pid}-${randomUUID()}`;
  try {
    await writeFile(join(staging, owner), '', { mode: 0o600 });
    // Publish an already populated directory so an empty lock is always safe to replace.
    for (;;) {
      try {
        await rename(staging, lock);
        return { lock, draft: join(lock, owner) };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const denied = code === 'EPERM' || code === 'EACCES';
        if (!directoryOccupied(error) && !(denied && (await isDirectory(lock)))) throw error;
      }
      const [currentOwner] = await readdir(lock).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
        return [];
      });
      if (!currentOwner) {
        await removeEmptyLock(lock);
        continue;
      }
      const ownerPid = /^(\d+)-[a-f\d-]+$/.exec(currentOwner)?.[1];
      if (ownerPid) {
        try {
          kill(Number(ownerPid), 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            // Another request may already have taken over. Remove only the abandoned owner's file.
            await rm(join(lock, currentOwner), { force: true });
            await removeEmptyLock(lock);
            continue;
          }
        }
      }
      throw new Error('Another request is updating this journey. Retry after it finishes.');
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function isDirectory(path: string) {
  const entry = await lstat(path).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
  if (entry && !entry.isDirectory()) throw new Error(`${path} must be a directory.`);
  return Boolean(entry);
}

export async function startLocalJourney(
  project: string,
  config: LocalConfig,
  input: {
    work_item_url: string;
    identity: Omit<StoredJourney['identity'], 'id'>;
    capture_policy: CapturePolicy;
  },
  remote?: { start: () => Promise<BackendStart>; update: BackendUpdate }
) {
  const root = join(await configDirectory(project), 'journeys');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await isDirectory(root);
  const staging = await mkdtemp(join(root, '.starting-'));
  let started: BackendStart | undefined;
  try {
    await Promise.all(config.files.map(({ name, source }) => writeFile(join(staging, name), source, { mode: 0o600 })));
    started = await remote?.start();
    const { plan, actions, customized } = effectivePlan(config, started?.plan);
    const now = started?.journey.created_at ?? new Date().toISOString();
    const state: StoredJourney = {
      ...input,
      version: 2,
      id: started && !customized ? started.journey_id : randomUUID(),
      identity: { ...input.identity, id: started?.journey.identity_id ?? randomUUID() },
      work_item_url: started?.journey.work_item_url ?? input.work_item_url,
      capture_policy: started?.journey.capture_policy ?? input.capture_policy,
      status: started?.journey.status ?? 'active',
      created_at: now,
      updated_at: started?.journey.updated_at ?? now,
      phase: 0,
      plan,
      local_actions: actions,
      results: {},
      backend: started && { phases: started.plan.phases.map(({ name }) => name), status: started.journey },
    };
    advance(state);
    await writeFile(stateFile(staging), serializeState(state), { mode: 0o600 });
    await rename(staging, join(root, state.id));
    return {
      payload: { journey_id: state.id, plan: state.plan, journey: view(state) },
      backend: state.backend?.status,
    };
  } catch (error) {
    if (started && remote) await remote.update('abort', started.journey_id).catch(() => undefined);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function pending(state: StoredJourney) {
  const { backend } = state;
  const phase = state.plan.phases[state.phase];
  const backendPhase = backend?.phases.indexOf(backend.status.phase) ?? -1;
  const phaseOnBackend = backend?.phases.indexOf(phase.name) ?? -1;
  return phase.checks.filter(({ id }) => {
    if (Object.hasOwn(state.local_actions, id)) return state.results[id]?.status !== 'passed';
    if (!backend || backend.status.status === 'completed' || backendPhase > phaseOnBackend) return false;
    if (backendPhase < phaseOnBackend) return true;
    return backend.status.incomplete_checks.some((check) => check.id === id);
  });
}

function ready(state: StoredJourney) {
  const remote = state.backend?.status;
  return (
    state.status === 'active' &&
    state.phase === state.plan.phases.length - 1 &&
    pending(state).length === 0 &&
    (!remote || remote.ready_to_complete || remote.status === 'completed')
  );
}

function advance(state: StoredJourney) {
  if (state.status !== 'active') return;
  while (state.phase < state.plan.phases.length - 1 && pending(state).length === 0) state.phase++;
}

function view(state: StoredJourney) {
  const phase = state.plan.phases[state.phase];
  return {
    id: state.id,
    identity_id: state.identity.id,
    session_id: state.identity.session_id,
    ...(state.backend && { backend_journey_id: state.backend.status.id }),
    work_item_url: state.work_item_url,
    status: state.status,
    capture_policy: state.capture_policy,
    created_at: state.created_at,
    updated_at: state.updated_at,
    plan_id: state.plan.id,
    plan_name: state.plan.name,
    plan_revision: state.plan.revision,
    phase: phase.name,
    incomplete_checks: pending(state).map((check) => {
      const result = state.results[check.id];
      if (!result) return check;
      if (result.status !== 'running') return { ...check, last_result: result };
      const { execution, ...visible } = result;
      return { ...check, last_result: { ...visible, detail: `Test execution ${execution.id} is running.` } };
    }),
    ready_to_complete: ready(state),
  };
}

async function refreshChecks(
  state: StoredJourney,
  project: string,
  folder: string,
  registry: CheckRegistry,
  signal: AbortSignal,
  afterCommit: (() => void)[]
) {
  const budget = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
  while (!budget.aborted) {
    const phase = state.phase;
    for (const check of pending(state)) {
      if (budget.aborted) break;
      const action = state.local_actions[check.id];
      if (!action) continue;
      const previous = state.results[check.id];
      if (previous?.status === 'running') {
        const outcome = await observeExecution(folder, previous.execution);
        if (outcome) {
          state.results[check.id] = {
            status: outcome.detail ? 'failed' : 'passed',
            attempts: previous.attempts,
            checked_at: new Date().toISOString(),
            detail: outcome.detail,
          };
          afterCommit.push(() => {
            void removeExecution(folder, previous.execution).catch(() => undefined);
          });
        }
        continue;
      }
      const attempts = (previous?.attempts ?? 0) + 1;
      const checked_at = new Date().toISOString();
      const run = (signal: AbortSignal) =>
        registry.run(action, { projectDir: project, workItemUrl: state.work_item_url, signal });
      const timeout = registry.backgroundTimeout(action);
      if (timeout !== undefined) {
        if (Object.values(state.results).some((result) => result.status === 'running')) continue;
        const execution = createExecution(timeout);
        state.results[check.id] = { status: 'running', attempts, checked_at, execution };
        afterCommit.push(() => launchExecution(folder, execution, run));
        continue;
      }
      const detail = await run(AbortSignal.any([budget, AbortSignal.timeout(15_000)]));
      state.results[check.id] = { status: detail ? 'failed' : 'passed', attempts, checked_at, detail };
    }
    advance(state);
    if (state.phase === phase) break;
  }
}

export async function updateLocalJourney(
  project: string,
  id: string,
  action: Action,
  signal: AbortSignal,
  registry: () => Promise<CheckRegistry>,
  updateBackend?: BackendUpdate
) {
  const root = join(await configDirectory(project), 'journeys');
  const folder = join(root, id);
  if (!(await isDirectory(root)) || !(await isDirectory(folder))) return;
  const path = stateFile(folder);
  const { lock, draft } = await lockState(folder);
  try {
    const entry = await lstat(path).catch((error: unknown) => {
      if (isMissing(error)) throw new Error('The local journey is missing state.json.', { cause: error });
      throw error;
    });
    if (!entry.isFile()) throw new Error('The local journey state must be a regular file.');
    const previous: unknown = JSON.parse(await readFile(path, 'utf8'));
    const state = storedJourney.parse(previous);
    if (state.id !== id || state.phase >= state.plan.phases.length) throw new Error('Invalid local journey state.');
    let conflict: string | undefined;
    const afterCommit: (() => void)[] = [];
    if (state.status === 'active') {
      if (state.backend) {
        if (!updateBackend) throw new Error('Set CAIRUL_BACKEND_ENABLED=true to update this backend-linked journey.');
        const remote = state.backend;
        remote.status = await updateBackend('status', remote.status.id);
        if (remote.status.id === id) advance(state);
        if (remote.status.status === 'aborted' || (remote.status.status === 'completed' && remote.status.id === id)) {
          state.status = remote.status.status;
        }
      }

      if (state.status === 'active') {
        if (action === 'status') {
          await refreshChecks(state, project, folder, await registry(), signal, afterCommit);
        } else if (action === 'abort') {
          if (state.backend?.status.status === 'active') {
            state.backend.status = await updateBackend!('abort', state.backend.status.id);
          }
          state.status = 'aborted';
        } else {
          advance(state);
          if (ready(state)) {
            if (state.backend?.status.status === 'active') {
              state.backend.status = await updateBackend!('complete', state.backend.status.id);
            }
            state.status = 'completed';
          }
        }
      }
    }

    if (state.status === 'aborted') {
      for (const [id, result] of Object.entries(state.results)) {
        if (result.status !== 'running') continue;
        await cancelExecution(folder, result.execution);
        state.results[id] = {
          status: 'failed',
          attempts: result.attempts,
          checked_at: new Date().toISOString(),
          detail: 'Test execution was cancelled.',
        };
      }
    }
    if (action === 'abort' && state.status !== 'aborted') conflict = 'A completed journey cannot be aborted.';
    if (action === 'complete' && state.status !== 'completed') {
      conflict =
        'Journey can complete only after every phase and check is satisfied. Call journey_status to run local checks.';
    }
    if (JSON.stringify(state) !== JSON.stringify(previous)) {
      state.updated_at = new Date().toISOString();
      await writeFile(draft, serializeState(state));
      await rename(draft, path);
    }
    for (const execute of afterCommit) execute();
    if (conflict) throw new Error(conflict);
    return { journey: view(state), backend: state.backend?.status };
  } finally {
    await rm(draft, { force: true });
    await removeEmptyLock(lock);
  }
}
