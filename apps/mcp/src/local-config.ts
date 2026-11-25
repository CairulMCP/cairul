import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { type CheckRegistry, type LocalAction, localActionSchema } from './check-kinds.js';
import { shellAction, shellKind, shellOptions } from './checks/shell.js';

const label = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\r\n\t\0]+$/);
function checkConfigFor(registry: CheckRegistry) {
  return z
    .union([
      localActionSchema.extend({ name: label }),
      shellOptions.extend({ name: label }).transform(({ name, command }) => ({ name, ...shellAction(command) })),
    ])
    .superRefine(async ({ name, ...action }, context) => {
      try {
        await registry.validate(action);
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: `Check "${name}": ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
}

const planConfig = (checkConfig: ReturnType<typeof checkConfigFor>) =>
  z.strictObject({
    match: z.string().regex(/^[^*\s]*\*$/, 'Use a URL prefix followed by * or a standalone *.'),
    mode: z.enum(['extend', 'override']).default('extend'),
    name: label.optional(),
    instructions: z.string().trim().min(1).optional(),
    phases: z
      .array(z.strictObject({ name: label, checks: z.array(z.union([label, checkConfig])).default([]) }))
      .default([]),
  });

export const checkSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  action: z.looseObject({ type: z.string() }),
});
const phaseSchema = z.object({ id: z.uuid(), name: z.string(), checks: z.array(checkSchema) });
export const planSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  instructions: z.string(),
  revision: z.number().int().positive(),
  active: z.boolean(),
  created_at: z.string(),
  phases: z.array(phaseSchema).min(1),
});

export const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

async function existingConfigDirectory(project: string) {
  for (const name of ['.cairul', '.kair0', '.nauxt', '.minerva']) {
    const path = join(project, name);
    const entry = await lstat(path).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    if (!entry) continue;
    if (!entry.isDirectory()) throw new Error(`${path} must be a directory.`);
    return path;
  }
}

export async function configDirectory(project: string) {
  return (await existingConfigDirectory(project)) ?? join(project, '.cairul');
}

export async function findProject(start: string) {
  if (!isAbsolute(start)) throw new Error('The Cairul project directory must be an absolute path.');
  const cwd = await realpath(start);
  if (!(await stat(cwd)).isDirectory()) throw new Error('The Cairul project path must be a directory.');
  let gitRoot: string | undefined;
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (await existingConfigDirectory(dir)) return dir;
    gitRoot ??=
      (await lstat(join(dir, '.git')).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
        return undefined;
      })) && dir;
    if (dirname(dir) === dir) return gitRoot ?? cwd;
  }
}

export async function readConfig<T>(directory: string, stem: string, schema: z.ZodType<T>) {
  const files = await Promise.all(
    ['yaml', 'yml'].map(async (extension) => {
      const name = `${stem}.${extension}`;
      try {
        const path = join(directory, name);
        if (!(await lstat(path)).isFile()) throw new Error(`${path} must be a regular file.`);
        return { name, source: await readFile(path, 'utf8') };
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    })
  );
  const present = files.filter((file) => file !== undefined);
  if (present.length > 1) throw new Error(`Use only one of ${stem}.yaml and ${stem}.yml in ${directory}.`);
  const [file] = present;
  if (!file) return;
  try {
    return { file, data: await schema.parseAsync(parse(file.source, { maxAliasCount: 0 })) };
  } catch (error) {
    throw new Error(
      `Invalid ${join(directory, file.name)}. ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      }
    );
  }
}

function requireUnique(names: string[], location: string) {
  if (new Set(names).size !== names.length) throw new Error(`Duplicate names in ${location}.`);
}

export async function loadConfig(project: string, url: string, registry: CheckRegistry) {
  const directory = await configDirectory(project);
  const checkConfig = checkConfigFor(registry);
  const checks = await readConfig(directory, 'checks', z.strictObject({ checks: z.array(checkConfig) }));
  const definitions = checks?.data.checks ?? [];
  requireUnique(
    definitions.map(({ name }) => name),
    'checks'
  );
  const catalog = new Map(definitions.map((check) => [check.name, check]));
  const plans = await readConfig(directory, 'plans', z.strictObject({ plans: z.array(planConfig(checkConfig)) }));
  const candidates = plans?.data.plans ?? [];
  requireUnique(
    candidates.map(({ match }) => match),
    'plan patterns'
  );
  const resolvedPlans = candidates.map((plan) => {
    requireUnique(
      plan.phases.map(({ name }) => name),
      `phases for ${plan.match}`
    );
    const phases = plan.phases.map((phase) => {
      const checks = phase.checks.map((entry) => {
        if (typeof entry !== 'string') return { definition: entry, inline: true };
        const definition = catalog.get(entry);
        if (!definition) throw new Error(`Unknown local check "${entry}" in phase "${phase.name}".`);
        return { definition, inline: false };
      });
      requireUnique(
        checks.map(({ definition }) => definition.name),
        `checks in phase "${phase.name}" for ${plan.match}`
      );
      return { ...phase, checks };
    });
    return { ...plan, phases };
  });
  const selected = resolvedPlans
    .filter(({ match }) => url.startsWith(match.slice(0, -1)))
    .sort((left, right) => right.match.length - left.match.length)[0];
  const files = [checks?.file, plans?.file].filter((file) => file !== undefined);
  return { selected, catalog, files };
}

export type LocalConfig = Awaited<ReturnType<typeof loadConfig>>;
export type Plan = z.infer<typeof planSchema>;

export function effectivePlan({ selected, catalog }: LocalConfig, backend?: Plan) {
  const overlays = new Map(selected?.phases.map((phase) => [phase.name, phase.checks]));
  const configuredChecks = new Map<string, LocalAction>();
  const localCheck = ({ name, ...action }: LocalAction & { name: string }) => {
    const id = randomUUID();
    configuredChecks.set(id, action);
    return {
      id,
      name,
      action: { type: action.kind === shellKind ? 'local_command' : 'local_check', kind: action.kind },
    };
  };

  const phases = (backend?.phases ?? []).map((phase) => {
    const additions = overlays.get(phase.name) ?? [];
    overlays.delete(phase.name);
    const existing = new Set(phase.checks.map(({ name }) => name));
    const localAdditions = additions.filter(({ definition, inline }) => {
      if (!existing.has(definition.name)) return true;
      if (inline) {
        throw new Error(
          `Inline check "${definition.name}" in phase "${phase.name}" conflicts with a backend check. Use a different name or a named check in checks.yaml.`
        );
      }
      return false;
    });
    return {
      ...phase,
      checks: [
        ...phase.checks.map((check) => {
          const definition = catalog.get(check.name);
          return definition ? localCheck(definition) : check;
        }),
        ...localAdditions.map(({ definition }) => localCheck(definition)),
      ],
    };
  });
  for (const [name, checks] of overlays)
    phases.push({ id: randomUUID(), name, checks: checks.map(({ definition }) => localCheck(definition)) });
  if (!phases.length) phases.push({ id: randomUUID(), name: 'Work item', checks: [] });

  const customized = Boolean(selected || configuredChecks.size);
  const instructions = [backend?.instructions, selected?.instructions].filter(Boolean).join('\n\n');
  const plan = {
    id: backend && !customized ? backend.id : randomUUID(),
    name: selected?.name ?? backend?.name ?? 'Local',
    instructions,
    revision: backend && !customized ? backend.revision : 1,
    active: true,
    created_at: backend && !customized ? backend.created_at : new Date().toISOString(),
    phases,
  };
  return { plan, customized, actions: Object.fromEntries(configuredChecks) };
}
