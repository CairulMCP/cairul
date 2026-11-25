import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { test } from 'node:test';
import { URL } from 'node:url';
import nodeTest from '../node-test-plugin/index.mjs';
import goTest from '../go-test-plugin/index.mjs';
import unittest from '../unittest-plugin/index.mjs';

const context = (projectDir, timeoutMs = 15000) => ({
  projectDir,
  workItemUrl: 'https://example.com/work/1',
  signal: globalThis.AbortSignal.timeout(timeoutMs),
});

test('Node executes a selected case and rejects empty and skipped selections', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cairul-node-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'sample.mjs'),
    [
      "import { test } from 'node:test';",
      "test('runs', () => {});",
      "test('skips', {skip: true}, () => {});",
      "test('fails', () => { throw new Error('selected failure'); });",
    ].join('\n')
  );
  const check = nodeTest().checkKinds['node-test.run'];
  assert.throws(() => check.validate({ select: {} }), /selector/);
  assert.throws(() => check.validate({ select: { all: true, files: ['sample.mjs'] } }), /narrower/);
  const run = (namePattern) => check.run({ select: { files: ['sample.mjs'], namePattern } }, context(directory));
  assert.equal((await run('^runs$')).status, 'passed');
  assert.match((await run('^unknown$')).detail, /No selected tests matched/);
  assert.match((await run('^skips$')).detail, /All selected tests were skipped/);
  const fail = await run('^fails$');
  assert.equal(fail.status, 'pending');
  assert.match(fail.detail, /fails/);
});

test('Go executes selected subtests without counting unmatched parent tests', async (t) => {
  const probe = await import('node:child_process').then(({ spawnSync }) => spawnSync('go', ['version']));
  if (probe.status !== 0) return t.skip('Go is unavailable.');
  const directory = await mkdtemp(join(tmpdir(), 'cairul-go-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(directory, 'go.mod'), 'module example.test/probe\n\ngo 1.20\n'),
    writeFile(
      join(directory, 'main_test.go'),
      'package probe\nimport "testing"\nfunc TestNested(t *testing.T) { t.Run("child", func(t *testing.T) {}) }\n'
    ),
  ]);
  const check = goTest().checkKinds['go-test.run'];
  const run = (namePattern) =>
    check.run({ select: { packages: ['.'], namePattern } }, context(directory, 120000));
  const selected = await run('^TestNested$/^child$');
  assert.equal(selected.status, 'passed', selected.detail);
  assert.match((await run('^TestNested$/^missing$')).detail, /No selected tests matched/);
});

test('unittest accepts fully qualified tests and distinguishes all-skipped runs', async (t) => {
  const probe = await import('node:child_process').then(({ spawnSync }) => spawnSync('python3', ['--version']));
  if (probe.status !== 0) return t.skip('Python is unavailable.');
  const directory = await mkdtemp(join(tmpdir(), 'cairul-python-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'test_sample.py'),
    [
      'import unittest',
      'class Sample(unittest.TestCase):',
      '    def test_pass(self): pass',
      '    @unittest.skip("fixture")',
      '    def test_skip(self): pass',
    ].join('\n')
  );
  const check = unittest().checkKinds['unittest.run'];
  const run = (name) => check.run({ select: { names: [name] } }, context(directory));
  assert.equal((await run('test_sample.Sample.test_pass')).status, 'passed');
  assert.match((await run('test_sample.Sample.test_skip')).detail, /All selected tests were skipped/);
});

test('runner timeouts terminate the child before it can produce a result', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cairul-runner-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'hang.mjs'),
    'import { setTimeout } from "node:timers/promises"; await setTimeout(60000);'
  );
  const check = nodeTest({ command: [execPath, join(directory, 'hang.mjs')] }).checkKinds['node-test.run'];
  const result = await check.run({ select: { all: true }, timeoutSeconds: 1 }, context(directory));
  assert.equal(result.status, 'error');
  assert.match(result.detail, /timed out/);
});

test('every framework runner validates a native selector', async () => {
  const fixtures = [
    ['vitest', { files: ['unit.test.ts'] }],
    ['jest', { namePattern: '^checkout$' }],
    ['node-test', { namePattern: '^smoke$' }],
    ['mocha', { titleIncludes: 'payments' }],
    ['playwright', { locations: [{ file: 'ui.spec.ts', line: 42 }] }],
    ['cypress', { specs: ['checkout.cy.ts'] }],
    ['webdriverio', { suites: ['checkout'] }],
    ['pytest', { nodeIds: ['test_x.py::test_case[one]'] }],
    ['unittest', { names: ['test_suite.Test.test_one'] }],
    ['django', { labels: ['shop.tests'] }],
    ['junit', { methods: ['shop.Unit#verify'] }],
    ['testng', { suites: ['testng.xml'] }, { command: ['java', '-cp', 'out', 'org.testng.TestNG'] }],
    ['gradle', { task: ':app:integrationTest', tests: ['shop.Unit.verify'] }],
    ['maven', { lifecycle: 'integration', tests: ['OrdersIT#verify'] }],
    ['cucumber', { locations: [{ file: 'features/checkout.feature', line: 11 }], tags: '@smoke' }],
    ['nunit', { project: 'Tests.csproj', categories: ['Smoke'] }],
    ['xunit', { traits: [{ name: 'Category', value: 'Smoke' }] }],
    ['mstest', { names: ['App.Tests.Unit.Verify'] }],
    ['go-test', { packages: ['./shop'], namePattern: '^TestCart$' }],
    ['nextest', { binaries: ['orders'], names: ['checkout'] }],
    ['rspec', { locations: [{ file: 'spec/cart_spec.rb', line: 9 }] }],
    ['minitest', { files: ['test/cart_test.rb'] }],
    ['phpunit', { suites: ['unit'] }],
    ['pest', { groups: ['smoke'] }],
    ['ctest', { buildDirectory: 'build', namePattern: '^cart$' }],
    ['googletest', { executable: 'build/tests', cases: ['Cart.IsEmpty'] }],
    ['flutter', { paths: ['test/cart_test.dart'] }],
    ['xctest', { methods: ['AppTests/CartTests/testEmpty'] }, { scheme: 'App' }],
  ];
  for (const [name, select, settings] of fixtures) {
    const { default: plugin } = await import(new URL('../' + name + '-plugin/index.mjs', import.meta.url));
    const run = plugin(settings).checkKinds[name + '.run'];
    assert.equal(run.execution, 'background', name);
    assert.doesNotThrow(() => run.validate({ select }), name);
  }
});
