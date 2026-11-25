import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { test } from 'node:test';
import { URL } from 'node:url';
import { goTest, jest, junit, nunit, playwright, tap, trx, xunit } from './reports.mjs';

const packages = new URL('../', import.meta.url);
const junitPass = '<testsuites><testsuite><testcase name="ok"/></testsuite></testsuites>';
const triplet = (passed, failed, skipped) => ({ passed, failed, skipped });
const contextFor = (url, projectDir = '.') => ({
  projectDir,
  workItemUrl: url,
  signal: globalThis.AbortSignal.timeout(5000),
});

test('report adapters recognize failure, empty suites, incomplete data, and unsafe XML', () => {
  assert.deepEqual(junit(junitPass), triplet(1, 0, 0));
  assert.deepEqual(
    junit('<testsuites errors="1"><testsuite><testcase><skipped/></testcase></testsuite></testsuites>'),
    triplet(0, 1, 1)
  );
  assert.deepEqual(junit('<testsuite/>'), triplet(0, 0, 0));
  assert.deepEqual(
    junit('<testsuite><testcase name="DISABLED_case" status="notrun" result="suppressed"/></testsuite>'),
    triplet(0, 0, 1)
  );
  assert.throws(
    () => junit('<!DOCTYPE testsuite [<!ENTITY x SYSTEM "file:///secret">]><testsuite>&x;</testsuite>'),
    /DOCTYPE/
  );
  assert.throws(() => junit('<testsuite><testcase/>'));
  assert.deepEqual(
    jest('{"success":false,"numPassedTests":1,"numFailedTests":0,"numPendingTests":0,"numFailedTestSuites":1}'),
    triplet(1, 1, 0)
  );
  assert.deepEqual(playwright('{"stats":{"expected":1,"unexpected":0,"flaky":1,"skipped":2}}'), triplet(1, 1, 2));
  assert.deepEqual(
    trx('<TestRun><ResultSummary><Counters total="3" executed="2" passed="1"/></ResultSummary></TestRun>'),
    triplet(1, 1, 1)
  );
  assert.throws(() => trx('<TestRun><Counters total="1" executed="2" passed="1"/></TestRun>'));
  assert.deepEqual(
    nunit('<test-run total="3" passed="1" failed="0" skipped="1" inconclusive="1" result="Inconclusive"/>'),
    triplet(1, 1, 1)
  );
  assert.deepEqual(
    xunit('<assemblies><assembly total="2" passed="1" failed="0" skipped="1" errors="1"/></assemblies>'),
    triplet(1, 1, 1)
  );
  assert.deepEqual(tap('TAP version 13\nok 1 - passing\nnot ok 2 - todo # TODO\n1..2\n'), triplet(1, 0, 1));
  assert.throws(() => tap('ok 1\n1..2\n'));
  const event = (Action, Package, Test) => JSON.stringify({ Action, Package, Test });
  assert.throws(() => goTest(event('start', 'p')), /incomplete/);
  assert.deepEqual(
    goTest(
      [event('start', 'p'), event('pass', 'p', 'TestWorks'), event('pass', 'p'), event('fail', 'broken')].join('\n')
    ),
    triplet(1, 1, 0)
  );
});

test('all packaged plugins export distinct check kinds and framework plugins accept a supported report', async (t) => {
  const names = (await readdir(packages)).filter((name) => name.endsWith('-plugin'));
  const directory = await mkdtemp(join(tmpdir(), 'cairul-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = 'report.xml';
  const goReport = 'go.json';
  const trxReport = 'suite.trx';
  await Promise.all([
    writeFile(join(directory, report), junitPass),
    writeFile(
      join(directory, goReport),
      '{"Action":"start","Package":"p"}\n{"Action":"pass","Package":"p","Test":"TestOk"}\n{"Action":"pass","Package":"p"}\n'
    ),
    writeFile(
      join(directory, trxReport),
      '<TestRun><ResultSummary><Counters total="1" executed="1" passed="1"/></ResultSummary></TestRun>'
    ),
  ]);
  const kinds = new Set();
  for (const name of names) {
    const { default: factory } = await import(new URL(`${name}/index.mjs`, packages));
    const config = {
      'jira-plugin': { baseUrl: 'https://example.atlassian.net' },
      'youtrack-plugin': { baseUrl: 'https://example.youtrack.cloud' },
      'azure-devops-plugin': { workspace: 'acme' },
    }[name];
    const { checkKinds } = await factory(config ?? {});
    assert.ok(Object.keys(checkKinds).length > 0, name);
    for (const [kind, check] of Object.entries(checkKinds)) {
      assert.ok(!kinds.has(kind), kind);
      kinds.add(kind);
      if (!kind.endsWith('.passed')) continue;
      const framework = name.replace(/-plugin$/, '');
      const inputs =
        framework === 'go-test'
          ? { reports: goReport }
          : ['nunit', 'xunit', 'mstest'].includes(framework)
            ? { reports: trxReport }
            : { reports: report, format: 'junit' };
      if (framework === 'node-test') {
        await writeFile(join(directory, 'node.tap'), 'ok 1\n1..1\n');
        Object.assign(inputs, { reports: 'node.tap', format: 'tap' });
      }
      check.validate(inputs);
      const context = contextFor('https://example.com/task', directory);
      assert.equal((await check.run(inputs, context)).status, 'passed', kind);
      assert.equal((await check.run({ ...inputs, minTests: 2 }, context)).status, 'pending', kind);
      assert.equal((await check.run({ ...inputs, reports: 'missing.xml' }, context)).status, 'pending', kind);
      assert.equal((await check.run({ ...inputs, reports: '../outside.xml' }, context)).status, 'error', kind);
    }
  }
  assert.ok(kinds.has('vitest.passed'));
  assert.ok(kinds.has('github.issue-state'));
});

test('service plugins use the configured API origin, authenticate, and evaluate provider-specific data', async (t) => {
  const fixtures = new Map([
    ['/repos/acme/app/issues/42', { state: 'closed' }],
    ['/projects/acme%2Fapp/merge_requests/42', { head_pipeline: { status: 'success' } }],
    ['/graphql', { data: { issue: { state: { name: 'Done' } } } }],
    ['/rest/api/3/issue/APP-42', { fields: { status: { name: 'Done' } } }],
    ['/cards/task/checklists', [{ name: 'Review', checkItems: [{ state: 'complete' }] }]],
    ['/tasks/42', { data: { completed: true } }],
    ['/task/42', { status: { status: 'closed' } }],
    ['/v2', { data: { items: [{ column_values: [{ id: 'status', text: 'Done' }] }] } }],
    ['/pages/task', { properties: { Status: { status: { name: 'Done' } } } }],
    ['/acme/_apis/wit/workitems/42', { fields: { 'System.State': 'Closed' } }],
    ['/repositories/acme/app/pullrequests/42', { state: 'MERGED' }],
    ['/api/issues/APP-42', { resolved: 123 }],
    ['/reviews/42', { review: { state: 'approved' } }],
  ]);
  const requests = [];
  const server = createServer(async (req, res) => {
    const payload = [];
    for await (const chunk of req) payload.push(chunk.toString());
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({
      path: url.pathname,
      credential: req.headers.authorization ?? req.headers['private-token'],
      payload: payload.join(''),
    });
    res.writeHead(fixtures.has(url.pathname) ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fixtures.get(url.pathname) ?? {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tokenEnv = 'CAIRUL_PLUGIN_TEST_TOKEN';
  const previous = env[tokenEnv];
  env[tokenEnv] = 'fixture-token';
  t.after(() => {
    if (previous === undefined) delete env[tokenEnv];
    else env[tokenEnv] = previous;
  });
  const cases = [
    ['github', 'issue-state', { repository: 'acme/app', number: 42, state: 'closed' }],
    ['gitlab', 'pipeline-passed', { project: 'acme/app', iid: 42 }],
    ['linear', 'issue-state', { issue: 'APP-42', state: 'Done' }],
    ['jira', 'issue-status', { issue: 'APP-42', state: 'Done' }],
    ['trello', 'checklist-complete', { card: 'task', name: 'Review' }],
    ['asana', 'task-complete', { task: '42' }],
    ['clickup', 'task-status', { task: '42', state: 'closed' }],
    ['monday', 'item-status', { item: 42, column: 'status', state: 'Done' }],
    ['notion', 'page-status', { page: 'task', property: 'Status', state: 'Done' }],
    ['azure-devops', 'work-item-state', { workItem: '42', state: 'Closed' }, { workspace: 'acme' }],
    ['bitbucket', 'pr-merged', { repository: 'acme/app', number: 42 }],
    ['youtrack', 'issue-resolved', { issue: 'APP-42' }],
    ['perforce', 'review-state', { review: 42 }],
  ];
  for (const [name, kind, options, extra] of cases) {
    const { default: factory } = await import(new URL(`${name}-plugin/index.mjs`, packages));
    const check = factory({ baseUrl, tokenEnv, ...extra }).checkKinds[`${name}.${kind}`];
    check.validate(options);
    const result = await check.run(options, contextFor('https://not-a-service.example/item'));
    assert.equal(result.status, 'passed', `${name}: ${result.detail}`);
  }
  assert.equal(requests.length, cases.length);
  assert.ok(requests.every(({ credential }) => credential));
  assert.equal(requests.find(({ path }) => path === '/graphql').credential, 'fixture-token');
  assert.equal(JSON.parse(requests.find(({ path }) => path === '/graphql').payload).variables.id, 'APP-42');

  const { default: github } = await import(new URL('github-plugin/index.mjs', packages));
  const issue = github({ baseUrl, tokenEnv }).checkKinds['github.issue-state'];
  const untrusted = await issue.run({ state: 'closed' }, contextFor('https://unexpected.example/acme/app/issues/42'));
  assert.equal(untrusted.status, 'error');
  assert.equal(requests.length, cases.length);

  const tokenDir = await mkdtemp(join(tmpdir(), 'cairul-token-'));
  t.after(() => rm(tokenDir, { recursive: true, force: true }));
  const tokenFile = join(tokenDir, 'token');
  await writeFile(tokenFile, 'file-token\n', { mode: 0o600 });
  const fileAuth = github({ baseUrl, tokenFile }).checkKinds['github.issue-state'];
  assert.equal(
    (await fileAuth.run({ repository: 'acme/app', number: 42, state: 'closed' }, contextFor(baseUrl))).status,
    'passed'
  );
  assert.equal(requests.at(-1).credential, 'Bearer file-token');

  fixtures.set('/repos/acme/app/issues/42', { state: 'open' });
  assert.equal(
    (await issue.run({ repository: 'acme/app', number: 42, state: 'closed' }, contextFor(baseUrl))).status,
    'pending'
  );
  fixtures.delete('/repos/acme/app/issues/42');
  assert.equal(
    (await issue.run({ repository: 'acme/app', number: 42, state: 'closed' }, contextFor(baseUrl))).status,
    'error'
  );
});

test('specialized gate plugins evaluate report data and reject missing evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cairul-gates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    [
      'coverage',
      'lcov-threshold',
      { minimum: 75 },
      'SF:src/main.js\nLF:4\nLH:3\nend_of_record\n',
      'SF:src/main.js\nLF:4\nLH:2\nend_of_record\n',
    ],
    [
      'axe',
      'violations',
      {},
      '{"passes":[{}],"violations":[],"incomplete":[]}',
      '{"passes":[{}],"violations":[{"impact":"critical"}],"incomplete":[]}',
    ],
    [
      'k6',
      'thresholds-passed',
      {},
      '{"metrics":{"latency":{"thresholds":{"p(95)<300":{"ok":true}}}}}',
      '{"metrics":{}}',
    ],
    [
      'visual',
      'pixel-diff',
      { maximum: 2 },
      '{"comparisons":[{"differentPixels":1}]}',
      '{"comparisons":[{"differentPixels":3}]}',
    ],
  ];
  for (const [name, kind, inputs, passingReport, failingReport] of cases) {
    const { default: plugin } = await import(new URL(`${name}-plugin/index.mjs`, packages));
    const check = plugin({}).checkKinds[`${name}.${kind}`];
    const options = { ...inputs, report: `${name}.report` };
    const context = contextFor('https://example.com/task', directory);
    assert.equal((await check.run(options, context)).status, 'pending', name);
    await writeFile(join(directory, options.report), passingReport);
    assert.equal((await check.run(options, context)).status, 'passed', name);
    await writeFile(join(directory, options.report), failingReport);
    assert.equal((await check.run(options, context)).status, 'pending', name);
  }
});
