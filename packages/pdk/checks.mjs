import { Buffer } from 'node:buffer';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { URL } from 'node:url';
import { z } from 'zod';
import {
  authenticationMode,
  credential,
  envName,
  requireSecureTransport,
  safeEndpoint,
  secretPath,
  setting,
} from './credentials.mjs';

export { z };
export {
  authenticationMode,
  credential,
  envName,
  environment,
  readCredential,
  requireSecureTransport,
  safeEndpoint,
  secretPath,
  setting,
} from './credentials.mjs';

export const text = z.string().trim().min(1);
export const count = z.number().int().nonnegative();
export const positiveID = z.coerce.string().regex(/^[1-9]\d*$/);
export function segment(value) {
  if (value === '.' || value === '..') throw new Error('Invalid resource identifier.');
  return encodeURIComponent(value);
}

export function check(schema, evaluate) {
  return {
    validate(options) {
      schema.parse(options);
    },
    run(options, context) {
      return evaluate(schema.parse(options), context);
    },
  };
}

export function verdict(matches, detail) {
  return matches ? { status: 'passed', detail } : { status: 'pending', detail };
}

export const error = (detail) => ({ status: 'error', detail });

export function states(value) {
  return Array.isArray(value) ? value : [value];
}

export const stateOption = z.union([text, z.array(text).min(1)]);

export { oauth1Authorization, oauthEncode } from './oauth1.mjs';

export function bearer(token) {
  return { authorization: 'Bearer ' + token };
}

export function basic(token, username) {
  if (username == null) throw new Error('Configure the account email or username for Basic authentication.');
  return { authorization: 'Basic ' + Buffer.from(username + ':' + token).toString('base64') };
}

const endpointOptions = z.strictObject({
  authMode: text.optional(),
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
  tokenEnv: envName.optional(),
  tokenFile: secretPath.optional(),
  workspace: text.optional(),
  email: text.optional(),
});

export function workURL(workItemUrl, allowedHosts) {
  const url = new URL(workItemUrl);
  if (!allowedHosts.includes(url.host)) throw new Error('Work item belongs to a different service host.');
  return url;
}

export function fromPath(url, pattern) {
  const result = pattern.exec(url.pathname);
  if (!result) throw new Error('Work item URL does not identify the expected resource.');
  return result.slice(1).map(decodeURIComponent);
}

export function target(explicit, workItemUrl, hosts, pattern) {
  return explicit ?? fromPath(workURL(workItemUrl, hosts), pattern)[0];
}

export class ServiceError extends Error {
  constructor(status) {
    super(`Service returned HTTP ${status}.`);
    this.status = status;
  }
}

export function connection(options, defaults) {
  const prefix = defaults.prefix;
  const config = endpointOptions.parse(options);
  const base = safeEndpoint(defaults.endpoint ?? setting(prefix, 'BASE_URL', config.baseUrl ?? defaults.baseUrl));
  const workspace = setting(prefix, 'WORKSPACE', config.workspace);
  const email = setting(prefix, 'EMAIL', config.email);
  const methods = defaults.authModes;
  if (!methods && config.authMode)
    throw new Error('This integration uses the same request authentication for all of its token types.');
  const mode =
    methods &&
    authenticationMode(
      prefix,
      config.authMode,
      Object.keys(methods),
      defaults.defaultAuth?.(email) ?? Object.keys(methods)[0]
    );
  const authorize = methods?.[mode] ?? defaults.auth ?? bearer;
  const explicitMode = config.authMode ?? setting(prefix, 'AUTH_MODE');
  const getToken =
    defaults.credential ??
    credential(prefix, 'TOKEN', {
      envName: config.tokenEnv,
      file: config.tokenFile,
      legacy: typeof defaults.tokenEnv === 'function' ? defaults.tokenEnv(mode) : defaults.tokenEnv,
      required: defaults.required || (methods && explicitMode),
    });

  async function request(path, { signal, body, method, query } = {}) {
    const token = await getToken(signal);
    if (token) requireSecureTransport(base);
    const url = new URL(base);
    url.pathname = `${base.pathname.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    const headers = { accept: 'application/json', ...defaults.headers };
    if (token)
      Object.assign(headers, await authorize(token, email, signal, { url, path, method: method ?? 'GET', body }));
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await globalThis.fetch(url, {
        headers,
        signal,
        redirect: 'error',
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('Service request failed.');
    }
    if (!response.ok) throw new ServiceError(response.status);
    try {
      return await response.json();
    } catch {
      throw new Error('Service returned invalid JSON.');
    }
  }

  return { request, host: base.host, origin: base.origin, pathname: base.pathname, workspace, authMode: mode };
}

export function query(connection, path, body, signal) {
  return connection.request(path, { signal, method: 'POST', body });
}

export async function service(evaluate) {
  try {
    return await evaluate();
  } catch (cause) {
    return error(cause instanceof Error ? cause.message.slice(0, 1000) : 'Service request failed.');
  }
}

export function matchesState(actual, allowed, subject) {
  if (typeof actual !== 'string') return error(`Service returned no ${subject} state.`);
  const expected = states(allowed);
  return verdict(expected.includes(actual), `${subject} state is "${actual}". Expected ${expected.join(', ')}.`);
}

export function includesAll(actual, required, subject) {
  if (!Array.isArray(actual)) return error(`Service returned no ${subject}.`);
  const missing = required.filter((value) => !actual.includes(value));
  return verdict(
    missing.length === 0,
    missing.length ? `Missing ${subject}: ${missing.join(', ')}.` : `Required ${subject} present.`
  );
}

function contained(root, candidate) {
  const difference = relative(root, candidate);
  return difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

export async function projectFile(projectDir, file) {
  if (isAbsolute(file)) throw new Error('Paths must be relative to the project.');
  const root = await realpath(projectDir);
  const candidate = resolve(root, file);
  if (!contained(root, candidate)) throw new Error('Path must stay inside the project.');
  const resolved = await realpath(candidate);
  if (!contained(root, resolved)) throw new Error('Path symlink must stay inside the project.');
  return resolved;
}

export async function readProjectFile(projectDir, file, signal) {
  signal.throwIfAborted();
  const path = await projectFile(projectDir, file);
  const handle = await open(path, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > 16 * 1024 * 1024) throw new Error('Expected a report file of at most 16 MiB.');
    const data = await handle.readFile({ encoding: 'utf8', signal });
    if (data.length > 16 * 1024 * 1024) throw new Error('Report exceeds 16 MiB.');
    return data;
  } finally {
    await handle.close();
  }
}

export function resourceCheck({ api, identifier, parseURL, path, query: parameters, shape = {}, evaluate }) {
  return check(z.strictObject({ [identifier]: text.optional(), ...shape }), (options, context) =>
    service(async () => {
      const id = options[identifier] ?? parseURL(context.workItemUrl);
      return evaluate(await api.request(path(id), { signal: context.signal, query: parameters }), options);
    })
  );
}
