import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('MCP loads standalone framework plugins beside the built-in shell check', { timeout: 10000 }, async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'cairul-packaged-'));
  const client = new Client({ name: 'packaged-plugin-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await rm(project, { recursive: true, force: true });
  });
  const config = join(project, '.cairul');
  const scope = join(project, 'node_modules', '@cairul');
  await Promise.all([mkdir(config), mkdir(scope, { recursive: true })]);
  for (const name of ['vitest-plugin', 'playwright-plugin']) {
    const source = fileURLToPath(new URL(`../../../packages/${name}`, import.meta.url));
    await symlink(source, join(scope, name), 'junction');
  }
  await Promise.all([
    writeFile(
      join(config, 'plugins.yaml'),
      'plugins: [{package: "@cairul/vitest-plugin"}, {package: "@cairul/playwright-plugin"}]\n'
    ),
    writeFile(
      join(config, 'checks.yaml'),
      `checks:
  - name: Unit tests
    kind: vitest.passed
    options: { reports: vitest.xml }
`
    ),
    writeFile(
      join(config, 'plans.yaml'),
      `plans:
  - match: "*"
    phases:
      - name: Verify
        checks:
          - Unit tests
          - name: Browser tests
            kind: playwright.passed
            options: { reports: playwright.json }
          - name: Report exists
            command: test -f vitest.xml
`
    ),
    writeFile(join(project, 'vitest.xml'), '<testsuite><testcase name="ok"/></testsuite>'),
  ]);
  await client.connect(
    new StdioClientTransport({
      command: execPath,
      args: [fileURLToPath(new URL('../bin/cairul-mcp.mjs', import.meta.url))],
      cwd: project,
      env: { CAIRUL_BACKEND_ENABLED: 'false' },
    })
  );
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    return result.structuredContent;
  };
  const { journey_id } = await call('journey_start', {
    session_id: 'fixture',
    work_item_url: 'https://example.com/tasks/1',
  });
  const blocked = await call('journey_status', { journey_id });
  assert.deepEqual(
    blocked.incomplete_checks.map(({ name }) => name),
    ['Browser tests']
  );
  await writeFile(join(project, 'playwright.json'), '{"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0}}');
  assert.equal((await call('journey_status', { journey_id })).ready_to_complete, true);
});

test('journey status observes one background test execution and abort cancels it', { timeout: 15000 }, async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'cairul-background-'));
  const client = new Client({ name: 'test-background-runner', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await rm(project, { recursive: true, force: true });
  });
  const config = join(project, '.cairul');
  const scope = join(project, 'node_modules', '@cairul');
  await Promise.all([mkdir(config), mkdir(scope, { recursive: true })]);
  await symlink(
    fileURLToPath(new URL('../../../packages/node-test-plugin', import.meta.url)),
    join(scope, 'node-test-plugin'),
    'junction'
  );
  await Promise.all([
    writeFile(join(config, 'plugins.yaml'), 'plugins: [{ package: "@cairul/node-test-plugin" }]'),
    writeFile(
      join(config, 'plans.yaml'),
      [
        'plans:',
        '  - match: "*"',
        '    phases:',
        '      - name: Verify',
        '        checks:',
        '          - name: Test execution',
        '            kind: node-test.run',
        '            options:',
        '              select: { files: [background.mjs], namePattern: "^blocked$" }',
      ].join('\n')
    ),
    writeFile(
      join(project, 'background.mjs'),
      [
        "import { test } from 'node:test';",
        "import { appendFile, stat } from 'node:fs/promises';",
        "import { setTimeout } from 'node:timers/promises';",
        "test('blocked', async () => {",
        "  await appendFile('started', 'one\\n');",
        "  while (!(await stat('release').catch(() => undefined))) await setTimeout(25);",
        "  await appendFile('completed', 'one\\n');",
        '});',
      ].join('\n')
    ),
  ]);
  await client.connect(
    new StdioClientTransport({
      command: execPath,
      args: [fileURLToPath(new URL('../bin/cairul-mcp.mjs', import.meta.url))],
      cwd: project,
      env: { CAIRUL_BACKEND_ENABLED: 'false' },
    })
  );
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    return result.structuredContent;
  };
  const start = async () => {
    const { journey_id } = await call('journey_start', {
      session_id: 'background',
      work_item_url: 'https://example.com/work/1',
    });
    return { journey_id };
  };
  const status = (journey) => call('journey_status', journey);
  async function waitFor(read) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const result = await read();
      if (result) return result;
      await setTimeout(25);
    }
    assert.fail('Timed out waiting for the test execution.');
  }

  const journey = await start();
  const first = (await status(journey)).incomplete_checks[0].last_result;
  assert.equal(first.status, 'running');
  const running = (await status(journey)).incomplete_checks[0].last_result;
  assert.deepEqual(running, first);
  await waitFor(() => readFile(join(project, 'started'), 'utf8').catch(() => undefined));
  await writeFile(join(project, 'release'), '');
  await waitFor(async () => (await status(journey)).ready_to_complete);
  assert.equal(await readFile(join(project, 'started'), 'utf8'), 'one\n');

  await rm(join(project, 'release'));
  const aborted = await start();
  assert.equal((await status(aborted)).incomplete_checks[0].last_result.status, 'running');
  await waitFor(async () => (await readFile(join(project, 'started'), 'utf8')) === 'one\none\n');
  assert.equal((await call('journey_abort', aborted)).status, 'aborted');
  await writeFile(join(project, 'release'), '');
  await setTimeout(100);
  assert.equal(await readFile(join(project, 'completed'), 'utf8'), 'one\n');
});
