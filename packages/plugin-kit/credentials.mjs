import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { env, platform } from 'node:process';
import { URL } from 'node:url';
import { z } from 'zod';

export const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const secretPath = z.string().trim().refine(isAbsolute, 'Credential file path must be absolute.');

export function environment(name) {
  return name ? env[name]?.trim() || undefined : undefined;
}

export function setting(prefix, suffix, fallback) {
  return environment('CAIRUL_' + prefix + '_' + suffix) ?? fallback;
}

export async function readCredential(file, signal) {
  let handle;
  try {
    if (!isAbsolute(file)) throw new Error('Expected absolute path.');
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536 || (platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('Expected a private, regular credential file.');
    }
    const secret = (await handle.readFile({ encoding: 'utf8', signal })).trim();
    if (!secret || secret.length > 65536) throw new Error('Invalid credential file.');
    return secret;
  } catch {
    throw new Error(
      'Could not read the configured credential file. Use an absolute path to a private file (mode 0600 on Unix).'
    );
  } finally {
    await handle?.close();
  }
}

export function credential(prefix, suffix, options = {}) {
  const variable = 'CAIRUL_' + prefix + '_' + suffix;
  const fileVariable = variable + '_FILE';
  const pointerVariable = variable + '_ENV';
  return async (signal) => {
    const raw = environment(variable);
    if (raw) return raw;
    const file = environment(fileVariable);
    if (file) return readCredential(file, signal);

    const alias = environment(pointerVariable) ?? options.envName;
    if (alias) {
      if (!envName.safeParse(alias).success) throw new Error('Invalid credential environment variable name.');
      const value = environment(alias);
      if (value) return value;
      if (environment(pointerVariable)) throw new Error('Set the configured credential environment variable.');
    }

    const legacy = environment(options.legacy);
    if (legacy) return legacy;
    if (options.file) return readCredential(options.file, signal);
    if (options.required || alias) throw new Error('Set ' + variable + ' or configure a credential file.');
  };
}

export function safeEndpoint(value) {
  const parsed = z.url({ protocol: /^https?$/ }).safeParse(value);
  if (!parsed.success) throw new Error('Configure a valid HTTP or HTTPS service base URL.');
  const url = new URL(parsed.data);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Use a service base URL without credentials, query, or fragment.');
  }
  return url;
}

export function requireSecureTransport(url) {
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Credentials require HTTPS, except on loopback addresses.');
  }
}

export function authenticationMode(prefix, yaml, choices, fallback) {
  const selected = setting(prefix, 'AUTH_MODE', yaml ?? fallback);
  if (!choices.includes(selected)) throw new Error('Choose authMode from: ' + choices.join(', ') + '.');
  return selected;
}
