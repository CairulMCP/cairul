import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from 'import-meta-resolve';
import { z } from 'zod';
import { CheckRegistry, optionsSchema } from './check-kinds.js';
import shellPlugin from './checks/shell.js';
import { configDirectory, readConfig } from './local-config.js';
import type { PluginFactory } from './plugin.js';

const packageName = z
  .string()
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, 'Use an installed package name.');

const pluginConfig = z.strictObject({
  plugins: z.array(z.strictObject({ package: packageName, options: optionsSchema.default({}) })),
});

const builtInPlugins: readonly PluginFactory[] = [shellPlugin];

async function loadRegistry(project: string) {
  const registry = new CheckRegistry();
  for (const factory of builtInPlugins) registry.use(await factory({}));
  const directory = await configDirectory(project);
  const configured = await readConfig(directory, 'plugins', pluginConfig);
  if (!configured) return registry;

  const { plugins } = configured.data;
  const packages = new Set(plugins.map((plugin) => plugin.package));
  if (packages.size !== plugins.length)
    throw new Error(`Duplicate plugin packages in ${join(directory, configured.file.name)}.`);

  const parent = pathToFileURL(join(project, 'package.json')).href;
  for (const plugin of plugins) {
    try {
      const entrypoint = resolve(plugin.package, parent);
      const module = (await import(entrypoint)) as { default?: unknown };
      if (typeof module.default !== 'function') throw new Error('Expected a default plugin factory export.');
      const factory = module.default as PluginFactory;
      registry.use(await factory(plugin.options));
    } catch (error) {
      throw new Error(
        `Could not load plugin "${plugin.package}" for ${project}. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
  return registry;
}

const registries = new Map<string, Promise<CheckRegistry>>();

export function getCheckRegistry(project: string) {
  let registry = registries.get(project);
  if (!registry) {
    registry = loadRegistry(project).catch((error: unknown) => {
      registries.delete(project);
      throw error;
    });
    registries.set(project, registry);
  }
  return registry;
}
