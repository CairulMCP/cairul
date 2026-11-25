import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env, platform } from 'node:process';
import { test } from 'node:test';
import { URL } from 'node:url';
import github from '../github-plugin/index.mjs';
import jira from '../jira-plugin/index.mjs';
import trello from '../trello-plugin/index.mjs';
import azureDevOps from '../azure-devops-plugin/index.mjs';
import perforce from '../perforce-plugin/index.mjs';
import gitlab from '../gitlab-plugin/index.mjs';
import linear from '../linear-plugin/index.mjs';
import bitbucket from '../bitbucket-plugin/index.mjs';
import { connection, credential, readCredential } from './checks.mjs';

function set(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = env[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
    t.after(() => {
      if (previous === undefined) delete env[key];
      else env[key] = previous;
    });
  }
}

async function fixture(t, handler) {
  const server = createServer((req, res) => {
    const result = handler(req);
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...result.headers });
    res.end(JSON.stringify(result.data ?? {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

const signal = () => globalThis.AbortSignal.timeout(4000);
const context = () => ({ projectDir: '.', workItemUrl: 'https://example.com/work', signal: signal() });

test('shared credentials prioritize environment values and reject public credential files', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'cairul-credentials-'));
  t.after(() => rm(folder, { force: true, recursive: true }));
  const yamlFile = join(folder, 'yaml');
  const envFile = join(folder, 'env');
  await writeFile(yamlFile, 'yaml-secret\n', { mode: 0o600 });
  await writeFile(envFile, 'env-file-secret\n', { mode: 0o600 });
  const load = credential('FIXTURE', 'TOKEN', {
    file: yamlFile,
    envName: 'CAIRUL_FIXTURE_ALIAS',
    legacy: 'CAIRUL_FIXTURE_LEGACY',
  });
  set(t, {
    CAIRUL_FIXTURE_TOKEN: 'env-secret',
    CAIRUL_FIXTURE_TOKEN_FILE: envFile,
    CAIRUL_FIXTURE_TOKEN_ENV: 'CAIRUL_FIXTURE_ENV_ALIAS',
    CAIRUL_FIXTURE_ENV_ALIAS: 'env-alias-secret',
    CAIRUL_FIXTURE_ALIAS: 'yaml-alias-secret',
    CAIRUL_FIXTURE_LEGACY: 'legacy-secret',
  });

  assert.equal(await load(signal()), 'env-secret');
  delete env.CAIRUL_FIXTURE_TOKEN;
  assert.equal(await load(signal()), 'env-file-secret');
  delete env.CAIRUL_FIXTURE_TOKEN_FILE;
  assert.equal(await load(signal()), 'env-alias-secret');
  delete env.CAIRUL_FIXTURE_TOKEN_ENV;
  assert.equal(await load(signal()), 'yaml-alias-secret');
  delete env.CAIRUL_FIXTURE_ALIAS;
  assert.equal(await load(signal()), 'legacy-secret');
  delete env.CAIRUL_FIXTURE_LEGACY;
  assert.equal(await load(signal()), 'yaml-secret');
  await chmod(yamlFile, 0o644);
  if (platform !== 'win32') {
    await assert.rejects(
      readCredential(yamlFile, signal()),
      (error) => /private file/.test(error.message) && !error.message.includes('yaml-secret')
    );
  }
});

test('environment overrides Jira, Trello, and Azure connection settings and YAML rejects inline secrets', async (t) => {
  const requests = [];
  const endpoint = await fixture(t, (req) => {
    requests.push({ path: req.url, auth: req.headers.authorization });
    if (req.url.startsWith('/rest/api/3/issue/APP-1')) return { data: { fields: { status: { name: 'Done' } } } };
    if (req.url.startsWith('/cards/card')) return { data: { idList: 'closed' } };
    if (req.url.startsWith('/env-org/_apis/wit/workitems/1')) return { data: { fields: { 'System.State': 'Done' } } };
    return { status: 404 };
  });
  set(t, {
    CAIRUL_JIRA_BASE_URL: endpoint,
    CAIRUL_JIRA_EMAIL: 'env@example.test',
    CAIRUL_JIRA_TOKEN: 'env-jira',
    CAIRUL_TRELLO_BASE_URL: endpoint,
    CAIRUL_TRELLO_KEY: 'env-trello-key',
    CAIRUL_TRELLO_TOKEN: 'env-trello-token',
    CAIRUL_AZURE_DEVOPS_BASE_URL: endpoint,
    CAIRUL_AZURE_DEVOPS_WORKSPACE: 'env-org',
    CAIRUL_AZURE_DEVOPS_TOKEN: 'env-azure',
  });
  for (const [plugin, config, kind, options] of [
    [
      jira,
      { baseUrl: 'https://yaml.example.test', email: 'yaml@example.test' },
      'jira.issue-status',
      { issue: 'APP-1', state: 'Done' },
    ],
    [
      trello,
      { baseUrl: 'https://yaml.example.test', keyEnv: 'MISSING_TRELLO_KEY' },
      'trello.card-list',
      { card: 'card', listId: 'closed' },
    ],
    [
      azureDevOps,
      { baseUrl: 'https://yaml.example.test', workspace: 'yaml-org' },
      'azure-devops.work-item-state',
      { workItem: '1', state: 'Done' },
    ],
  ])
    assert.equal((await plugin(config).checkKinds[kind].run(options, context())).status, 'passed');

  assert.equal(requests[0].auth, 'Basic ' + Buffer.from('env@example.test:env-jira').toString('base64'));
  assert.equal(requests[1].auth, 'OAuth oauth_consumer_key="env-trello-key", oauth_token="env-trello-token"');
  assert.equal(requests[2].auth, 'Basic ' + Buffer.from(':env-azure').toString('base64'));
  let error;
  try {
    jira({ token: 'never-print-this-secret' });
  } catch (cause) {
    error = cause;
  }
  assert.ok(error);
  assert.doesNotMatch(String(error), /never-print-this-secret/);
  assert.throws(() => github({ privateKey: 'inline-pem' }), /Unrecognized key/);
});

test('service requests refuse authenticated HTTP and redirects', async (t) => {
  const secure = connection({}, { prefix: 'FIXTURE_HTTP', baseUrl: 'http://example.com' });
  set(t, { CAIRUL_FIXTURE_HTTP_TOKEN: 'env-token' });
  await assert.rejects(secure.request('record', { signal: signal() }), /require HTTPS/);
  let redirected = false;
  const downstream = await fixture(t, () => {
    redirected = true;
    return {};
  });
  const endpoint = await fixture(t, () => ({ status: 302, headers: { location: downstream } }));
  const api = connection({}, { prefix: 'FIXTURE_HTTP', baseUrl: endpoint });
  await assert.rejects(api.request('record', { signal: signal() }), /Service request failed/);
  assert.equal(redirected, false);
});

test('GitHub App signs with the environment PEM, caches the scoped installation token, and supports a YAML key path', async (t) => {
  const requests = [];
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const endpoint = await fixture(t, (req) => {
    requests.push({ path: req.url, method: req.method, auth: req.headers.authorization });
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(req.url)) {
      return { data: { token: 'installation-fixture', expires_at: new Date(Date.now() + 3600000).toISOString() } };
    }
    return { data: { state: 'closed' } };
  });
  set(t, {
    CAIRUL_GITHUB_BASE_URL: endpoint,
    CAIRUL_GITHUB_AUTH_MODE: 'app',
    CAIRUL_GITHUB_APP_ID: '123',
    CAIRUL_GITHUB_INSTALLATION_ID: '456',
    CAIRUL_GITHUB_APP_PRIVATE_KEY: pem,
  });
  const config = { appId: 11, installationId: 22, privateKeyFile: '/unread/yaml.pem' };
  const check = github(config).checkKinds['github.issue-state'];
  const run = (check) => check.run({ repository: 'acme/service', number: 1, state: 'closed' }, context());
  assert.deepEqual(
    (await Promise.all([run(check), run(check)])).map(({ status }) => status),
    ['passed', 'passed']
  );
  assert.deepEqual(
    requests.map(({ path }) => path),
    ['/app/installations/456/access_tokens', '/repos/acme/service/issues/1', '/repos/acme/service/issues/1']
  );
  assert.equal(requests[0].method, 'POST');
  const [header, payload, signature] = requests[0].auth.replace(/^Bearer /, '').split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, '123');
  assert.ok(verify('RSA-SHA256', Buffer.from(header + '.' + payload), publicKey, Buffer.from(signature, 'base64url')));
  assert.ok(requests.slice(1).every(({ auth }) => auth === 'Bearer installation-fixture'));

  delete env.CAIRUL_GITHUB_APP_PRIVATE_KEY;
  const folder = await mkdtemp(join(tmpdir(), 'cairul-app-key-'));
  t.after(() => rm(folder, { force: true, recursive: true }));
  const file = join(folder, 'github.pem');
  await writeFile(file, pem, { mode: 0o600 });
  assert.equal(
    (await run(github({ ...config, privateKeyFile: file }).checkKinds['github.issue-state'])).status,
    'passed'
  );
  assert.equal(requests.at(-2).path, '/app/installations/456/access_tokens');
  assert.throws(() => github({ ...config, graphqlUrl: 'https://unrelated.example.test' }), /same service origin/);
  delete env.CAIRUL_GITHUB_AUTH_MODE;
  delete env.CAIRUL_GITHUB_APP_ID;
  delete env.CAIRUL_GITHUB_INSTALLATION_ID;
  set(t, { CAIRUL_GITHUB_TOKEN: 'environment-pat' });
  const tokenMode = github({ ...config, authMode: 'app' }).checkKinds['github.issue-state'];
  assert.equal((await run(tokenMode)).status, 'passed');
  assert.equal(requests.at(-1).auth, 'Bearer environment-pat');
});

test('Perforce native settings use environment values before YAML', async (t) => {
  if (platform === 'win32') return t.skip('POSIX executable fixture.');
  const directory = await mkdtemp(join(tmpdir(), 'cairul-p4-config-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const executable = join(directory, 'p4-fixture');
  await writeFile(
    executable,
    [
      '#!/usr/bin/env node',
      'if (process.env.P4USER !== "env-user" || process.env.P4PORT !== "native-port" ||',
      '    process.env.P4CLIENT !== "yaml-client" || process.env.P4PASSWD !== "env-password") process.exit(1);',
      'console.log(JSON.stringify({ status: "submitted" }));',
    ].join('\n'),
    { mode: 0o700 }
  );
  set(t, {
    CAIRUL_PERFORCE_EXECUTABLE: executable,
    CAIRUL_PERFORCE_USER: 'env-user',
    CAIRUL_PERFORCE_PORT: undefined,
    P4PORT: 'native-port',
    CAIRUL_PERFORCE_CLIENT: undefined,
    P4CLIENT: undefined,
    CAIRUL_PERFORCE_PASSWORD: 'env-password',
  });
  const plugin = perforce({ executable: 'unused', port: 'yaml-port', user: 'yaml-user', client: 'yaml-client' });
  const check = plugin.checkKinds['perforce.changelist-submitted'];
  assert.equal((await check.run({ change: 1 }, { ...context(), projectDir: directory })).status, 'passed');
});

test('Codex forwards canonical environment settings for all work-item services', async () => {
  const { readFile } = await import('node:fs/promises');
  const { mcpServers } = JSON.parse(await readFile(new URL('../../plugins/cairul/mcp.json', import.meta.url), 'utf8'));
  const forwarded = new Set(mcpServers.cairul.env_vars);
  for (const prefix of [
    'GITHUB',
    'GITLAB',
    'PERFORCE',
    'LINEAR',
    'JIRA',
    'TRELLO',
    'ASANA',
    'CLICKUP',
    'MONDAY',
    'NOTION',
    'AZURE_DEVOPS',
    'BITBUCKET',
    'YOUTRACK',
  ]) {
    for (const suffix of ['BASE_URL', 'TOKEN', 'TOKEN_FILE', 'TOKEN_ENV']) {
      assert.ok(forwarded.has('CAIRUL_' + prefix + '_' + suffix), prefix + '_' + suffix);
    }
  }
});

test('GitHub token mode accepts both classic and fine-grained PATs', async (t) => {
  const received = [];
  const endpoint = await fixture(t, (req) => {
    received.push(req.headers.authorization);
    return { data: { state: 'closed' } };
  });
  set(t, { CAIRUL_GITHUB_AUTH_MODE: 'token', CAIRUL_GITHUB_TOKEN: 'ghp_classic_fixture' });
  const check = github({ baseUrl: endpoint }).checkKinds['github.issue-state'];
  const options = { repository: 'acme/service', number: 1, state: 'closed' };
  assert.equal((await check.run(options, context())).status, 'passed');
  env.CAIRUL_GITHUB_TOKEN = 'github_pat_fine_grained_fixture';
  assert.equal((await check.run(options, context())).status, 'passed');
  assert.deepEqual(received, ['Bearer ghp_classic_fixture', 'Bearer github_pat_fine_grained_fixture']);
});

test('OAuth bearer, GitLab job and cookie modes, and Basic auth send their native headers', async (t) => {
  const received = [];
  const endpoint = await fixture(t, (req) => {
    received.push(req.headers);
    if (req.url.startsWith('/graphql')) return { data: { data: { issue: { state: { name: 'Done' } } } } };
    if (req.url.includes('/_apis/')) return { data: { fields: { 'System.State': 'Done' } } };
    if (req.url.startsWith('/repositories/')) return { data: { state: 'MERGED' } };
    return { data: { state: 'closed' } };
  });
  set(t, {
    CAIRUL_GITLAB_TOKEN: undefined,
    CAIRUL_GITLAB_TOKEN_FILE: undefined,
    CAIRUL_GITLAB_TOKEN_ENV: undefined,
    GITLAB_TOKEN: 'gitlab-fixture',
    CI_JOB_TOKEN: 'job-fixture',
    CAIRUL_TEST_GITLAB_COOKIE: 'cookie-fixture',
    CAIRUL_LINEAR_TOKEN: 'linear-oauth',
    CAIRUL_AZURE_DEVOPS_TOKEN: 'entra-oauth',
    CAIRUL_BITBUCKET_TOKEN: 'bitbucket-fixture',
    CAIRUL_GITLAB_AUTH_MODE: undefined,
    CAIRUL_LINEAR_AUTH_MODE: undefined,
    CAIRUL_AZURE_DEVOPS_AUTH_MODE: undefined,
    CAIRUL_BITBUCKET_AUTH_MODE: undefined,
  });
  const issue = { project: 'acme/service', iid: 1, state: 'closed' };
  for (const [plugin, config, kind, options] of [
    [gitlab, { authMode: 'bearer' }, 'gitlab.issue-state', issue],
    [gitlab, { authMode: 'job-token' }, 'gitlab.issue-state', issue],
    [gitlab, { authMode: 'session', tokenEnv: 'CAIRUL_TEST_GITLAB_COOKIE' }, 'gitlab.issue-state', issue],
    [gitlab, { sudoUser: 'example' }, 'gitlab.issue-state', issue],
    [linear, { authMode: 'bearer' }, 'linear.issue-state', { issue: 'CRM-1', state: 'Done' }],
    [
      azureDevOps,
      { workspace: 'acme', authMode: 'bearer' },
      'azure-devops.work-item-state',
      { workItem: '1', state: 'Done' },
    ],
    [
      bitbucket,
      { authMode: 'basic', email: 'account@example.test' },
      'bitbucket.pr-merged',
      { repository: 'acme/service', number: 1 },
    ],
  ]) {
    const result = await plugin({ baseUrl: endpoint, ...config }).checkKinds[kind].run(options, context());
    assert.equal(result.status, 'passed', result.detail);
  }
  assert.equal(received[0].authorization, 'Bearer gitlab-fixture');
  assert.equal(received[1]['job-token'], 'job-fixture');
  assert.equal(received[2].cookie, '_gitlab_session=cookie-fixture');
  assert.equal(received[3].sudo, 'example');
  assert.equal(received[3]['private-token'], 'gitlab-fixture');
  assert.equal(received[4].authorization, 'Bearer linear-oauth');
  assert.equal(received[5].authorization, 'Bearer entra-oauth');
  assert.equal(
    received[6].authorization,
    'Basic ' + Buffer.from('account@example.test:bitbucket-fixture').toString('base64')
  );
});

test('Trello signs OAuth 1.0 requests and Jira signs Connect requests with the correct QSH', async (t) => {
  const received = [];
  const endpoint = await fixture(t, (req) => {
    received.push({ path: req.url, method: req.method, auth: req.headers.authorization });
    return req.url.startsWith('/cards/')
      ? { data: { idList: 'complete' } }
      : { data: { fields: { status: { name: 'Done' } } } };
  });
  set(t, {
    CAIRUL_TRELLO_AUTH_MODE: 'oauth1',
    CAIRUL_TRELLO_KEY: 'consumer',
    CAIRUL_TRELLO_KEY_SECRET: 'consumer-secret',
    CAIRUL_TRELLO_TOKEN: 'token',
    CAIRUL_TRELLO_TOKEN_SECRET: 'token-secret',
    CAIRUL_JIRA_AUTH_MODE: 'connect',
    CAIRUL_JIRA_CONNECT_APP_KEY: 'example-app',
    CAIRUL_JIRA_TOKEN: 'shared-secret',
  });
  const card = trello({ baseUrl: endpoint, authMode: 'bearer' }).checkKinds['trello.card-list'];
  assert.equal((await card.run({ card: 'card', listId: 'complete' }, context())).status, 'passed');
  const headers = Object.fromEntries(
    [...received[0].auth.matchAll(/(oauth_[a-z_]+)="([^"]*)"/g)].map(([, key, val]) => [key, decodeURIComponent(val)])
  );
  assert.equal(headers.oauth_signature_method, 'HMAC-SHA1');
  const params = Object.entries(headers)
    .filter(([key]) => key !== 'oauth_signature')
    .sort()
    .map(([key, val]) => key + '=' + encodeURIComponent(val))
    .join('&');
  const base = ['GET', endpoint + '/cards/card', params].map(encodeURIComponent).join('&');
  assert.equal(
    headers.oauth_signature,
    createHmac('sha1', 'consumer-secret&token-secret').update(base).digest('base64')
  );

  const issue = jira({ baseUrl: endpoint, siteUrl: 'https://acme.atlassian.net' }).checkKinds['jira.issue-status'];
  const issueContext = { ...context(), workItemUrl: 'https://acme.atlassian.net/browse/CRM-1' };
  assert.equal((await issue.run({ state: 'Done' }, issueContext)).status, 'passed');
  const [head, payload, signature] = received[1].auth.replace(/^JWT /, '').split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, 'example-app');
  assert.equal(claims.qsh, createHash('sha256').update('GET&/rest/api/3/issue/CRM-1&fields=status').digest('hex'));
  assert.equal(
    signature,
    createHmac('sha256', 'shared-secret')
      .update(head + '.' + payload)
      .digest('base64url')
  );
});

test('ClickUp OAuth uses a Bearer token', async (t) => {
  const { default: clickup } = await import('../clickup-plugin/index.mjs');
  let received;
  const endpoint = await fixture(t, (req) => {
    received = req.headers.authorization;
    return { data: { status: { status: 'complete' } } };
  });
  set(t, { CAIRUL_CLICKUP_TOKEN: 'oauth-fixture', CAIRUL_CLICKUP_AUTH_MODE: 'bearer' });
  const check = clickup({ baseUrl: endpoint, authMode: 'api-token' }).checkKinds['clickup.task-status'];
  assert.equal((await check.run({ task: '1', state: 'complete' }, context())).status, 'passed');
  assert.equal(received, 'Bearer oauth-fixture');
});

test('Jira Connect signs the GET query for JQL searches', async (t) => {
  let request;
  const endpoint = await fixture(t, (req) => {
    request = { method: req.method, jwt: req.headers.authorization };
    return { data: { issues: [{ key: 'CRM-1' }] } };
  });
  set(t, {
    CAIRUL_JIRA_AUTH_MODE: 'connect',
    CAIRUL_JIRA_TOKEN: 'shared-secret',
    CAIRUL_JIRA_CONNECT_APP_KEY: 'fixture-app',
  });
  const check = jira({ baseUrl: endpoint }).checkKinds['jira.jql-matches'];
  assert.equal((await check.run({ jql: 'project=CRM' }, context())).status, 'passed');
  assert.equal(request.method, 'GET');
  const claims = JSON.parse(Buffer.from(request.jwt.split('.')[1], 'base64url'));
  assert.equal(
    claims.qsh,
    createHash('sha256').update('GET&/rest/api/3/search/jql&fields=key&jql=project%3DCRM&maxResults=1').digest('hex')
  );
});

test('monday OAuth 2.1 uses a Bearer token', async (t) => {
  const { default: monday } = await import('../monday-plugin/index.mjs');
  let received;
  const endpoint = await fixture(t, (req) => {
    received = req.headers.authorization;
    return { data: { data: { items: [{ column_values: [{ text: 'Done' }] }] } } };
  });
  set(t, { CAIRUL_MONDAY_TOKEN: 'oauth-2.1-fixture', CAIRUL_MONDAY_AUTH_MODE: 'bearer' });
  const check = monday({ baseUrl: endpoint, authMode: 'api-token' }).checkKinds['monday.item-status'];
  assert.equal((await check.run({ item: 1, column: 'status', state: 'Done' }, context())).status, 'passed');
  assert.equal(received, 'Bearer oauth-2.1-fixture');
});
