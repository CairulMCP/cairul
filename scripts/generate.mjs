import { execFileSync } from 'node:child_process';
import { error as logError } from 'node:console';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const specURL = URL.parse(process.env.CAIRUL_OPENAPI_URL ?? process.env.KAIR0_OPENAPI_URL ?? '');
if (!specURL || !['http:', 'https:'].includes(specURL.protocol)) {
  throw new Error('Set CAIRUL_OPENAPI_URL to an HTTP or HTTPS OpenAPI endpoint.');
}

const response = await globalThis.fetch(specURL, { signal: globalThis.AbortSignal.timeout(15000) });
if (!response.ok) {
  throw new Error(`Could not fetch the OpenAPI spec (HTTP ${response.status}).`);
}
const spec = JSON.stringify(await response.json());
const destination = 'packages/sdk/src/generated';
const temp = mkdtempSync('packages/sdk/.generate-');
const input = join(temp, 'openapi.json');
const generated = join(temp, 'generated');
const previous = join(temp, 'previous');

try {
  writeFileSync(input, spec);
  execFileSync(
    'openapi-generator-cli',
    [
      'generate',
      '-g',
      'typescript-fetch',
      '-i',
      input,
      '-o',
      generated,
      '--additional-properties=importFileExtension=.js,hideGenerationTimestamp=true',
      '--global-property=apis,models,supportingFiles=runtime.ts:index.ts,apiDocs=false,modelDocs=false,apiTests=false,modelTests=false',
    ],
    { stdio: 'inherit' }
  );
  rmSync(join(generated, '.openapi-generator'), { recursive: true, force: true });
  execFileSync('prettier', ['--write', generated], { stdio: 'inherit' });

  if (process.argv.includes('--check')) {
    try {
      execFileSync('git', ['diff', '--no-index', '--no-ext-diff', '--', destination, generated], { stdio: 'inherit' });
    } catch (error) {
      if (error.status !== 1) throw error;
      logError(`${destination} is out of date. Run pnpm generate and commit the generated changes.`);
      process.exitCode = 1;
    }
  } else {
    if (existsSync(destination)) renameSync(destination, previous);
    try {
      renameSync(generated, destination);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
