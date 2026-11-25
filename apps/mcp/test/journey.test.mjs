import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { env, execPath } from 'node:process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig } from '../dist/local-config.js';
import { getCheckRegistry } from '../dist/local-plugins.js';

const apiBinary = env.CAIRUL_TEST_API_BIN;
const backendRequired = apiBinary ? false : 'Set CAIRUL_TEST_API_BIN to a cairul API executable.';
const pluginMCP = new URL('../../../plugins/cairul/mcp.json', import.meta.url);

test('local journeys pin YAML, run checks by phase, and resume from disk', { timeout: 10000 }, async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'cairul-local-'));
  const nested = join(project, 'src');
  const config = join(project, '.kair0');
  let client;
  t.after(async () => {
    await client?.close();
    await rm(project, { recursive: true, force: true });
  });
  const plugin = await pluginLauncher(project);
  const connect = async () => {
    client = new Client({ name: 'local-journey-test', version: '0.1.0' });
    await client.connect(
      new StdioClientTransport({
        command: plugin.command,
        args: plugin.args,
        cwd: nested,
        env: { PATH: plugin.path, CAIRUL_API_URL: 'http://127.0.0.1:1' },
      })
    );
  };
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    return result.structuredContent;
  };
  const checks = [
    'checks:',
    '  - name: Gate',
    '    command: test -f ready',
    '  - name: Record run',
    '    kind: shell.command',
    '    options:',
    '      command: echo ran >> runs',
    '',
  ].join('\n');
  const plans = [
    'plans:',
    '  - match: "*"',
    '    name: Fallback',
    '  - match: "https://tracker.example/acme/*"',
    '    name: Project plan',
    '    instructions: Follow the checklist.',
    '    phases:',
    '      - name: Build',
    '        checks: [Gate, Record run]',
    '      - name: Verify',
    '        checks:',
    '          - name: Final check',
    '            kind: shell.command',
    '            options:',
    '              command: touch final',
    '',
  ].join('\n');
  await Promise.all([mkdir(config), mkdir(nested)]);
  await Promise.all([writeFile(join(config, 'checks.yml'), checks), writeFile(join(config, 'plans.yaml'), plans)]);
  await connect();
  assert.deepEqual(await call('cairul_health'), { status: 'ok', backend_enabled: false });
  const started = await call('journey_start', {
    work_item_url: 'https://tracker.example/acme/42',
    session_id: 'local-session',
  });
  assert.equal(started.plan.name, 'Project plan');
  assert.equal(started.plan.instructions, 'Follow the checklist.');
  assert.deepEqual(started.plan.phases[1].checks[0].action, { type: 'local_command', kind: 'shell.command' });
  const journey = { journey_id: started.journey_id };
  const snapshot = join(config, 'journeys', started.journey_id);
  assert.equal(await readFile(join(snapshot, 'checks.yml'), 'utf8'), checks);
  assert.equal(await readFile(join(snapshot, 'plans.yaml'), 'utf8'), plans);
  assert.equal((await client.callTool({ name: 'journey_complete', arguments: journey })).isError, true);
  await assert.rejects(readFile(join(project, 'runs')), { code: 'ENOENT' });

  const blocked = await call('journey_status', journey);
  assert.equal(blocked.phase, 'Build');
  assert.deepEqual(
    blocked.incomplete_checks.map(({ name }) => name),
    ['Gate']
  );
  assert.equal(blocked.incomplete_checks[0].last_result.detail, 'Exited with code 1.');
  await assert.rejects(readFile(join(project, 'final')), { code: 'ENOENT' });
  await client.close();
  const db = new DatabaseSync(join(snapshot, 'journey.db'));
  try {
    const { local_actions, ...state } = JSON.parse(db.prepare('SELECT state FROM journey WHERE id = 1').get().state);
    state.version = 1;
    state.commands = Object.fromEntries(
      Object.entries(local_actions).map(([id, action]) => [id, action.options.command])
    );
    db.prepare('UPDATE journey SET state = ? WHERE id = 1').run(JSON.stringify(state));
  } finally {
    db.close();
  }
  await Promise.all([
    writeFile(join(config, 'checks.yml'), 'changed after start'),
    writeFile(join(config, 'plans.yaml'), 'changed after start'),
    writeFile(join(project, 'ready'), ''),
  ]);
  await connect();
  const ready = await call('journey_status', journey);
  assert.equal(ready.phase, 'Verify');
  assert.equal(ready.ready_to_complete, true);
  assert.equal(await readFile(join(project, 'runs'), 'utf8'), 'ran\n');
  assert.equal(await readFile(join(project, 'final'), 'utf8'), '');
  assert.equal((await call('journey_complete', journey)).status, 'completed');
  assert.equal((await call('journey_status', journey)).status, 'completed');
});

test('check configuration rejects unknown kinds, bad references, and duplicate phase names', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'cairul-config-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const config = join(project, '.cairul');
  await mkdir(config);
  const checks = join(config, 'checks.yaml');
  const plans = join(config, 'plans.yaml');
  const registry = await getCheckRegistry(project);
  const load = () => loadConfig(project, 'https://tracker.example/acme/42', registry);

  await writeFile(checks, 'checks: [{name: Gate, kind: missing.check, options: {}}]');
  await writeFile(plans, 'invalid: plans');
  await assert.rejects(load, /checks\.yaml.*[\s\S]*Unknown check kind/);

  await writeFile(checks, 'checks: [{name: Gate, kind: shell.command, options: {command: "true"}}]');
  const plan = 'plans: [{match: "*", phases: [{name: Verify, checks: ';
  await writeFile(plans, plan + '[Missing]}]}]');
  await assert.rejects(load, /Unknown local check "Missing" in phase "Verify"/);

  await writeFile(plans, plan + '[Gate, {name: Gate, kind: shell.command, options: {command: "true"}}]}]}]');
  await assert.rejects(load, /Duplicate names in checks in phase "Verify"/);
});

test(
  'the local MCP loads project plugins at startup and runs their registered checks',
  { timeout: 10000 },
  async (t) => {
    const project = await mkdtemp(join(tmpdir(), 'cairul-plugins-'));
    const client = new Client({ name: 'plugin-test', version: '1.0.0' });
    t.after(async () => {
      await client.close();
      await rm(project, { recursive: true, force: true });
    });

    const config = join(project, '.cairul');
    const pkg = join(project, 'node_modules', '@acme', 'cairul-plugin-demo');
    await Promise.all([mkdir(config), mkdir(pkg, { recursive: true })]);
    await Promise.all([
      writeFile(join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: { import: './index.js' } })),
      writeFile(
        join(pkg, 'index.js'),
        `
      import { appendFile, readFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function plugin({ organization }) {
        console.log('test plugin initialized');
        await appendFile(join(import.meta.dirname, 'startup'), organization);
        return {
          checkKinds: {
            'demo.approval': {
              async validate({ filename }) {
                if (typeof filename !== 'string') throw new Error('filename is required');
              },
              async run({ filename }, { projectDir, workItemUrl, signal }) {
                signal.throwIfAborted();
                const approved = await readFile(join(projectDir, filename), 'utf8');
                return approved === organization + ' ' + workItemUrl
                  ? { status: 'passed' }
                  : { status: 'pending', detail: 'Waiting for approval' };
              },
            },
          },
        };
      }
    `
      ),
      writeFile(
        join(config, 'plugins.yaml'),
        ['plugins:', '  - package: "@acme/cairul-plugin-demo"', '    options:', '      organization: my-org'].join('\n')
      ),
      writeFile(
        join(config, 'checks.yaml'),
        ['checks:', '  - name: Approval', '    kind: demo.approval', '    options:', '      filename: approval'].join(
          '\n'
        )
      ),
      writeFile(join(config, 'plans.yaml'), 'plans: [{match: "*", phases: [{name: Verify, checks: [Approval]}]}]'),
      writeFile(join(project, 'approval'), ''),
    ]);

    await client.connect(
      new StdioClientTransport({
        command: execPath,
        args: [fileURLToPath(new URL('../bin/cairul-mcp.mjs', import.meta.url))],
        env: { CAIRUL_PROJECT_DIR: project },
      })
    );
    assert.equal(await readFile(join(pkg, 'startup'), 'utf8'), 'my-org');

    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
      return result.structuredContent;
    };
    const url = 'https://tracker.example/acme/42';
    const started = await call('journey_start', { work_item_url: url, session_id: 'plugin-session' });
    assert.deepEqual(started.plan.phases[0].checks[0].action, { type: 'local_check', kind: 'demo.approval' });
    const journey = { journey_id: started.journey_id };
    const blocked = await call('journey_status', journey);
    assert.equal(blocked.incomplete_checks[0].last_result.detail, 'Waiting for approval');

    await writeFile(join(project, 'approval'), `my-org ${url}`);
    assert.equal((await call('journey_status', journey)).ready_to_complete, true);
    assert.equal(await readFile(join(pkg, 'startup'), 'utf8'), 'my-org');
  }
);

test(
  'local plans extend backend phases or replace the backend plan',
  { timeout: 15000, skip: backendRequired },
  async (t) => {
    const project = await mkdtemp(join(tmpdir(), 'cairul-extended-'));
    const client = new Client({ name: 'extended-journey-test', version: '0.1.0' });
    let api;
    t.after(async () => {
      await client.close();
      await api?.close();
      await rm(project, { recursive: true, force: true });
    });
    const config = join(project, '.cairul');
    await mkdir(config);
    await writeFile(
      join(config, 'checks.yaml'),
      [
        'checks:',
        '  - name: PR is merged',
        '    command: test -f merged',
        '  - name: Project verification',
        '    command: test -f verified',
        '',
      ].join('\n')
    );
    await writeFile(
      join(config, 'plans.yml'),
      [
        'plans:',
        '  - match: "https://github.com/acme/service/*"',
        '    mode: extend',
        '    instructions: Run project verification.',
        '    phases:',
        '      - name: Verify',
        '        checks:',
        '          - Project verification',
        '          - name: Local report',
        '            kind: shell.command',
        '            options:',
        '              command: touch local-report',
        '  - match: "*"',
        '    mode: override',
        '    name: Local override',
        '',
      ].join('\n')
    );
    api = await startAPI(join(project, 'api.db'));
    const backendPlan = await api.post('/plans', {
      name: 'GitHub Pull Request',
      instructions: 'Review the pull request.',
      phases: [
        {
          name: 'PRs Merged',
          checks: [
            {
              name: 'PR is merged',
              action: { type: 'github_pull_request_status', options: { expected_status: 'merged' } },
            },
            { name: 'Approval', action: { type: 'manual' } },
          ],
        },
      ],
    });
    await api.post(`/plans/${backendPlan.id}/activate`);
    await client.connect(
      new StdioClientTransport({
        command: execPath,
        args: [fileURLToPath(new URL('../bin/cairul-mcp.mjs', import.meta.url))],
        cwd: project,
        env: { CAIRUL_BACKEND_ENABLED: 'true', CAIRUL_API_URL: api.url },
      })
    );
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
      return result.structuredContent;
    };
    const start = (work_item_url) => call('journey_start', { work_item_url, session_id: 'local-session' });
    const override = await start('https://tracker.example/acme/42');
    assert.equal(override.plan.name, 'Local override');
    assert.equal(override.journey.backend_journey_id, undefined);
    const started = await start('https://github.com/acme/service/pull/42');
    assert.match(started.plan.instructions, /pull request.*\n\nRun project verification\./);
    assert.deepEqual(
      started.plan.phases.map(({ name }) => name),
      ['PRs Merged', 'Verify']
    );
    assert.equal(started.plan.phases[0].checks[0].action.type, 'local_command');
    const journey = { journey_id: started.journey_id };
    const backendID = started.journey.backend_journey_id;
    assert.notEqual(backendID, started.journey_id);
    const remote = await api.get(`/journeys/${backendID}`);
    assert.deepEqual(
      remote.incomplete_checks.map(({ name }) => name),
      ['Approval']
    );
    assert.equal((await call('journey_status', journey)).phase, 'PRs Merged');
    await writeFile(join(project, 'merged'), '');
    const blocked = await call('journey_status', journey);
    assert.deepEqual(
      blocked.incomplete_checks.map(({ name }) => name),
      ['Approval']
    );
    await api.post(`/journeys/${backendID}/checks/${remote.incomplete_checks[0].id}/complete`);
    assert.equal((await call('journey_status', journey)).phase, 'Verify');
    assert.equal((await client.callTool({ name: 'journey_complete', arguments: journey })).isError, true);
    await writeFile(join(project, 'verified'), '');
    assert.equal((await call('journey_status', journey)).ready_to_complete, true);
    assert.equal(await readFile(join(project, 'local-report'), 'utf8'), '');
    assert.equal((await call('journey_complete', journey)).status, 'completed');
    assert.equal((await api.get(`/journeys/${backendID}`)).status, 'completed');
  }
);

test(
  'the MCP command configured by the plugin manages SQLite-backed journeys',
  { timeout: 20000, skip: backendRequired },
  async (t) => {
    const temp = await mkdtemp(join(tmpdir(), 'cairul-journey-'));
    const database = join(temp, 'cairul.db');
    const client = new Client({ name: 'journey-test', version: '0.1.0' });
    let api;

    t.after(async () => {
      try {
        await client.close();
        await api?.close();
      } finally {
        await rm(temp, { force: true, recursive: true });
      }
    });

    const plugin = await pluginLauncher(temp);

    api = await startAPI(database);
    const port = new URL(api.url).port;
    await client.connect(
      new StdioClientTransport({
        command: plugin.command,
        args: plugin.args,
        cwd: temp,
        env: {
          PATH: plugin.path,
          CAIRUL_API_URL: api.url,
          CAIRUL_BACKEND_ENABLED: 'true',
          CAIRUL_TELEMETRY: 'false',
        },
      })
    );

    const sessionID = 'opaque-harness-session';
    const custom = await api.post('/plans', {
      name: 'Unrelated plan',
      instructions: 'Confirm the review.',
      phases: [{ name: 'review', checks: [{ name: 'Review', action: { type: 'manual' } }] }],
    });
    assert.deepEqual(await api.get(`/plans/${custom.id}`), custom);
    await api.post('/plans', { name: 'Empty', instructions: 'No phases', phases: [] }, 400);
    await api.post('/journeys', { plan_id: custom.id, session_id: sessionID }, 400);
    await api.post(
      '/journeys',
      { work_item_url: 'https://github.com.evil.example/acme/service/issues/42', session_id: sessionID },
      400
    );

    const call = (name, args) => client.callTool({ name, arguments: args });
    const success = async (name, args) => {
      const result = await call(name, args);
      assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
      return result.structuredContent;
    };
    const start = (work_item_url) => success('journey_start', { work_item_url, session_id: sessionID });
    const issueURL = 'https://github.com/acme/service/issues/42';
    const prURL = 'https://github.com/acme/service/pull/7';
    const issue = await start(issueURL + '?ref=work#top');
    assert.equal(issue.journey_id, issue.journey.id);
    assert.equal(issue.journey.session_id, sessionID);
    assert.deepEqual(await api.get(`/identities/${issue.journey.identity_id}`), {
      id: issue.journey.identity_id,
      session_id: sessionID,
      harness: 'codex',
      created_at: issue.journey.created_at,
    });
    assert.equal(issue.journey.work_item_url, issueURL);
    assert.equal(issue.plan.name, 'GitHub Issue');
    assert.deepEqual(
      issue.plan.phases.map(({ name }) => name),
      ['PRs Merged', 'Issue Closed']
    );
    assert.deepEqual(
      issue.plan.phases.map(({ checks }) => checks.map(({ action }) => action)),
      [
        [{ type: 'github_issue_pull_requests_status', options: { expected_status: 'merged' } }],
        [{ type: 'github_issue_status', options: { expected_status: 'closed' } }],
      ]
    );
    assert.notEqual(issue.plan.id, custom.id);
    assert.equal(issue.journey.status, 'active');
    assert.equal(issue.journey.phase, 'PRs Merged');
    assert.deepEqual(issue.journey.incomplete_checks, issue.plan.phases[0].checks);

    const pr = await start(prURL);
    assert.equal(pr.plan.name, 'GitHub Pull Request');
    assert.notEqual(pr.journey.identity_id, issue.journey.identity_id);
    assert.deepEqual(
      pr.plan.phases.map(({ name }) => name),
      ['PRs Merged']
    );
    assert.deepEqual(pr.plan.phases[0].checks[0].action, {
      type: 'github_pull_request_status',
      options: { expected_status: 'merged' },
    });
    assert.equal(pr.journey.work_item_url, prURL);
    const prArgs = { journey_id: pr.journey_id };
    assert.equal((await success('journey_status', prArgs)).ready_to_complete, false);
    assert.equal((await call('journey_complete', prArgs)).isError, true);
    await api.post(`/journeys/${pr.journey_id}/checks/${pr.plan.phases[0].checks[0].id}/complete`, undefined, 409);
    assert.equal((await success('journey_abort', prArgs)).status, 'aborted');
    assert.equal((await call('journey_complete', prArgs)).isError, true);
    const unsupported = await call('journey_start', {
      work_item_url: 'https://linear.app/acme/issue/ENG-42',
      session_id: sessionID,
    });
    assert.equal(unsupported.isError, true);
    assert.match(unsupported.content[0].text, /GitHub issue or pull request URL/);

    await api.close();
    const legacy = new DatabaseSync(database);
    try {
      legacy.exec(`
      ALTER TABLE journeys ADD COLUMN pull_request_owner TEXT;
      ALTER TABLE journeys ADD COLUMN pull_request_repo TEXT;
      ALTER TABLE journeys ADD COLUMN pull_request_number INTEGER;
    `);
      legacy
        .prepare(
          'UPDATE journeys SET work_item_url = NULL, pull_request_owner = ?, pull_request_repo = ?, pull_request_number = ? WHERE id = ?'
        )
        .run('acme', 'service', 7, pr.journey_id);
    } finally {
      legacy.close();
    }
    api = await startAPI(database, port);
    const restarted = await success('journey_status', prArgs);
    assert.equal(restarted.work_item_url, prURL);
    assert.equal(restarted.status, 'aborted');
    assert.equal((await start(issueURL)).plan.id, issue.plan.id);
    assert.equal((await start(prURL)).plan.id, pr.plan.id);
    const candidate = await api.post('/plans', {
      name: issue.plan.name,
      instructions: 'Confirm the issue is completed after its linked PRs merge.',
      phases: [
        {
          name: 'Revised checks',
          checks: [
            {
              name: 'Issue is closed',
              action: { type: 'github_issue_status', options: { expected_status: 'closed' } },
            },
          ],
        },
      ],
    });
    assert.equal(issue.plan.revision, 1);
    assert.equal(issue.plan.active, true);
    assert.equal(candidate.revision, 2);
    assert.equal(candidate.active, false);
    assert.equal((await start(issueURL)).plan.id, issue.plan.id);
    assert.equal((await api.post(`/plans/${candidate.id}/activate`)).active, true);
    assert.equal((await api.get(`/plans/${issue.plan.id}`)).active, false);
    assert.equal((await start(issueURL)).plan.id, candidate.id);
    assert.equal((await success('journey_status', { journey_id: issue.journey_id })).plan_id, issue.plan.id);
    assert.equal((await api.post(`/plans/${issue.plan.id}/activate`)).active, true);
    assert.equal((await start(issueURL)).plan.id, issue.plan.id);
    assert.equal((await call('journey_status', { journey_id: 'eff85cc3-aa02-4ed0-898b-b38afdaa48c0' })).isError, true);
  }
);

test(
  'startup migrates numeric workflow IDs and retains pinned revisions and completed checks',
  { timeout: 15000, skip: backendRequired },
  async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'cairul-legacy-'));
    const database = join(folder, 'legacy.db');
    let api;
    t.after(async () => {
      await api?.close();
      await rm(folder, { recursive: true, force: true });
    });
    const db = new DatabaseSync(database);
    db.exec(`
    CREATE TABLE identities (id INTEGER PRIMARY KEY, name TEXT, created_at DATETIME);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, identity_id INTEGER REFERENCES identities(id), created_at DATETIME);
    CREATE TABLE plans (id INTEGER PRIMARY KEY, name TEXT, instructions TEXT, created_at DATETIME, default_for TEXT);
    CREATE TABLE phases (id INTEGER PRIMARY KEY, plan_id INTEGER REFERENCES plans(id), position INTEGER, name TEXT);
    CREATE TABLE checkpoints (id INTEGER PRIMARY KEY, phase_id INTEGER REFERENCES phases(id), name TEXT, action_type TEXT, action_instructions TEXT, action_delay_seconds INTEGER);
    CREATE TABLE journeys (id INTEGER PRIMARY KEY, plan_id INTEGER REFERENCES plans(id), session_id INTEGER REFERENCES sessions(id),
      pull_request_owner TEXT, pull_request_repo TEXT, pull_request_number INTEGER,
      status TEXT, phase_index INTEGER, phase_started_at DATETIME, next_check_at DATETIME, created_at DATETIME, updated_at DATETIME);
    CREATE TABLE checkpoint_results (journey_id INTEGER REFERENCES journeys(id), checkpoint_id INTEGER REFERENCES checkpoints(id), completed_at DATETIME);
    INSERT INTO identities VALUES (7, 'Operator', CURRENT_TIMESTAMP);
    INSERT INTO sessions VALUES (8, 7, CURRENT_TIMESTAMP);
    INSERT INTO plans VALUES (9, 'GitHub Pull Request', 'First instructions', CURRENT_TIMESTAMP, 'github_pull_request');
    INSERT INTO plans VALUES (10, 'GitHub Pull Request', 'Draft instructions', CURRENT_TIMESTAMP, NULL);
    INSERT INTO phases VALUES (11, 9, 0, 'Verify');
    INSERT INTO phases VALUES (12, 10, 0, 'Verify');
    INSERT INTO checkpoints VALUES (13, 11, 'Confirm', 'manual', '', 0);
    INSERT INTO journeys VALUES (14, 9, 8, 'acme', 'service', 7, 'active', 0, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO checkpoint_results VALUES (14, 13, CURRENT_TIMESTAMP);
  `);
    db.close();

    api = await startAPI(database);
    const migrated = new DatabaseSync(database);
    assert.equal(migrated.prepare("SELECT name FROM sqlite_schema WHERE name = 'sessions'").get(), undefined);
    const row = migrated.prepare('SELECT id, plan_id, identity_id FROM journeys').get();
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    migrated.close();
    for (const id of Object.values(row)) assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal((await api.get(`/identities/${row.identity_id}`)).name, 'Operator');
    const plan = await api.get(`/plans/${row.plan_id}`);
    assert.equal(plan.active, true);
    assert.equal(plan.revision, 1);
    const journey = await api.get(`/journeys/${row.id}`);
    assert.equal(journey.ready_to_complete, true);
    assert.equal(journey.session_id, undefined);
    assert.equal(journey.identity_id, row.identity_id);
    assert.equal(journey.work_item_url, 'https://github.com/acme/service/pull/7');
    assert.equal((await api.post(`/journeys/${row.id}/complete`)).status, 'completed');
    const entries = await api.get(`/journeys/${row.id}/timeline`);
    assert.deepEqual(
      entries.map(({ type }) => type),
      ['journey.started', 'check.passed', 'journey.status_changed']
    );
    assert.equal(entries[1].data.name, 'Confirm');
  }
);

test(
  'the journal combines filtered Codex executions, workflow checks, and lifecycle events',
  { timeout: 15000, skip: backendRequired },
  async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'cairul-journal-'));
    const database = join(folder, 'cairul.db');
    const client = new Client({ name: 'journal-test', version: '0.1.0' });
    const api = await startAPI(database);
    t.after(async () => {
      await client.close();
      await api.close();
      await rm(folder, { recursive: true, force: true });
    });
    const plan = await api.post('/plans', {
      name: 'GitHub Issue',
      instructions: 'Confirm the fixture review.',
      phases: [{ name: 'Review', checks: [{ name: 'Confirm', action: { type: 'manual' } }] }, { name: 'Finish' }],
    });
    await api.post(`/plans/${plan.id}/activate`);

    const workItemURL = 'https://github.com/acme/fixture/issues/7';
    const harnessSession = randomUUID();
    const startPublication = {
      type: 'journey.start',
      version: 1,
      id: randomUUID(),
      start: { session_id: harnessSession, work_item_url: workItemURL, harness: 'codex' },
    };
    const published = await api.post('/events', startPublication, 200);
    const replay = (await api.post('/events', startPublication, 200)).started;
    assert.equal(replay.journey_id, published.started.journey_id);
    assert.equal(replay.journey.identity_id, published.started.journey.identity_id);
    await api.post(
      '/events',
      {
        ...startPublication,
        start: { ...startPublication.start, work_item_url: workItemURL + '8' },
      },
      409
    );
    const replayJournal = await api.get(`/journeys/${published.started.journey_id}/timeline`);
    assert.deepEqual(
      replayJournal.map(({ type }) => type),
      ['journey.started']
    );
    assert.equal(replayJournal[0].id, startPublication.id);
    assert.equal(replayJournal[0].data.identity_id, replay.journey.identity_id);
    assert.equal(replayJournal[0].data.session_id, harnessSession);

    const thread = randomUUID();
    const turn = randomUUID();
    const sessions = join(folder, 'sessions', '2026', '11', '21');
    await mkdir(sessions, { recursive: true });
    const rollout = join(sessions, 'rollout-fixture-' + thread + '.jsonl');
    const line = (type, payload, at = Date.now()) =>
      JSON.stringify({
        type,
        payload,
        timestamp: new Date(at).toISOString(),
      }) + '\n';
    const record = (type, payload, at) => appendFile(rollout, line(type, payload, at));
    const generation = (response_id, at) =>
      record(
        'token_usage_record',
        {
          thread_id: thread,
          turn_id: turn,
          response_id,
          usage: { input_tokens: 150, output_tokens: 10, cached_input_tokens: 25, reasoning_output_tokens: 2 },
        },
        at
      );
    const tool = (name, call_id, namespace, at) =>
      record(
        'response_item',
        {
          type: 'function_call',
          name,
          namespace,
          call_id,
          arguments: 'secret arguments',
        },
        at
      );
    const result = (call_id, success = true) =>
      record('response_item', {
        type: 'function_call_output',
        call_id,
        output: { success, content: 'secret output' },
      });
    const call = (name, callId, args) =>
      client.callTool({
        name,
        arguments: args,
        _meta: {
          callId,
          threadId: thread,
          sessionId: harnessSession,
          'x-codex-turn-metadata': { turn_id: turn, model: 'gpt-test', codex_version: '0.171.0' },
        },
      });

    await client.connect(
      new StdioClientTransport({
        command: execPath,
        args: [fileURLToPath(new URL('../bin/cairul-mcp.mjs', import.meta.url))],
        cwd: folder,
        env: { CAIRUL_API_URL: api.url, CAIRUL_BACKEND_ENABLED: 'true', CODEX_HOME: folder },
      })
    );
    const past = Date.now() - 5000;
    await record('session_meta', { id: thread, model_provider: 'openai' }, past);
    await tool('journey_start', 'opening-call', 'mcp__cairul', past);
    await generation('outside-before', past);
    await writeFile(
      join(sessions, 'rollout-fixture-' + randomUUID() + '.jsonl'),
      line('token_usage_record', {
        turn_id: turn,
        response_id: 'unrelated-thread',
      })
    );
    const mismatch = await call('journey_start', 'wrong-session', { session_id: thread, work_item_url: workItemURL });
    assert.equal(mismatch.isError, true);
    const started = await call('journey_start', 'opening-call', {
      session_id: harnessSession,
      user_id: 'user-test',
      work_item_url: workItemURL,
      capture_policy: { tool_names: ['apply_patch', 'mcp__cairul__journey_complete'] },
    });
    assert.equal(started.isError ?? false, false, JSON.stringify(started));
    const { journey_id: id } = started.structuredContent;
    assert.equal(started.structuredContent.plan.id, plan.id);
    const agentIdentity = await api.get(`/identities/${started.structuredContent.journey.identity_id}`);
    assert.deepEqual(agentIdentity, {
      id: started.structuredContent.journey.identity_id,
      session_id: harnessSession,
      harness: 'codex',
      harness_version: '0.171.0',
      thread_id: thread,
      user_id: 'user-test',
      created_at: started.structuredContent.journey.created_at,
    });
    const timelineURL = `/journeys/${id}/timeline`;
    await setTimeout(5);
    await result('opening-call');

    await tool('exec_command', 'skip');
    await generation('filtered-out');
    await result('skip');
    await tool('apply_patch', 'edit');
    await tool('exec_command', 'shell');
    await tool('journey_status', 'observe-status', 'mcp__cairul');
    await generation('batch-one');
    await result('shell', false);
    await result('edit');
    assert.equal((await call('journey_status', 'observe-status', { journey_id: id })).isError ?? false, false);

    const checkId = plan.phases[0].checks[0].id;
    await api.post(`/journeys/${id}/checks/${checkId}/complete`);
    await tool('journey_complete', 'closing-call', 'mcp__cairul');
    await generation('batch-two');
    assert.equal((await call('journey_complete', 'closing-call', { journey_id: id })).isError ?? false, false);
    await setTimeout(5);
    await generation('outside-after');

    let entries;
    for (let retry = 0; retry < 50; retry++) {
      entries = await api.get(timelineURL);
      if (entries.some(({ type }) => type === 'recording.ended')) break;
      await setTimeout(60);
    }
    const serverEvents = entries.filter(({ source }) => source === 'backend');
    assert.deepEqual(
      serverEvents.map(({ type }) => type),
      [
        'journey.started',
        'check.passed',
        'journey.phase_changed',
        'journey.ready_to_complete',
        'journey.status_changed',
      ]
    );
    assert.equal(serverEvents.at(-1).data.status, 'completed');
    const observations = entries.filter(({ source }) => source === 'harness');
    assert.deepEqual(
      observations.map(({ type }) => type),
      ['recording.started', 'execution.observed', 'execution.observed', 'recording.ended']
    );
    assert.deepEqual(
      observations.map(({ sequence }) => sequence),
      [1, 2, 3, 4]
    );
    assert.ok(
      observations.every(({ harness }) => harness.thread_id === thread && harness.session_id === harnessSession)
    );
    assert.equal(observations[0].data.started.request.call_id, 'opening-call');
    const first = observations[1].data.execution;
    const second = observations[2].data.execution;
    assert.notEqual(first.id, second.id);
    assert.equal(first.turn_id, second.turn_id);
    assert.equal(first.model.response_id, 'batch-one');
    assert.equal(first.model.usage.input_tokens, 150);
    assert.deepEqual(
      first.tools.map(({ call_id }) => call_id),
      ['shell', 'edit', 'observe-status']
    );
    assert.equal(first.tools[0].failed, true);
    assert.equal(first.tools[2].request.call_id, 'observe-status');
    assert.equal(second.tools[0].request.http_status, 200);
    assert.deepEqual(observations.at(-1).data.ended, {
      reason: 'completed',
      observed: 3,
      retained: 2,
      source_available: true,
    });
    assert.doesNotMatch(JSON.stringify(entries), /secret|outside-before|outside-after|unrelated-thread|filtered-out/);

    const firstPage = await api.get(timelineURL + '?limit=2');
    assert.deepEqual(firstPage, entries.slice(0, 2));
    assert.deepEqual(await api.get(timelineURL + '?after=' + firstPage.at(-1).cursor), entries.slice(2));

    const retry = {
      version: 1,
      type: 'journey.observations',
      journey_id: id,
      observations: {
        recording_id: observations[0].recording_id,
        harness: observations[0].harness,
        events: observations.map(({ id, type, sequence, occurred_at, data }) => ({
          id,
          type,
          sequence,
          occurred_at,
          ...data,
        })),
      },
    };
    assert.equal((await api.post('/events', retry, 200)).accepted, 0);
    const changed = globalThis.structuredClone(retry);
    changed.observations.events[1].execution.model.name = 'changed';
    await api.post('/events', changed, 409);

    const bypass = globalThis.structuredClone(retry);
    bypass.observations.recording_id = randomUUID();
    bypass.observations.events = bypass.observations.events.slice(0, 2);
    for (const observation of bypass.observations.events) observation.id = randomUUID();
    bypass.observations.events[1].execution.tools = [first.tools[0]];
    await api.post('/events', bypass, 400);
    assert.deepEqual(await api.get(timelineURL), entries);

    await tool('journey_start', 'external-start', 'mcp__cairul');
    await generation('external-opening');
    const external = await call('journey_start', 'external-start', {
      session_id: harnessSession,
      work_item_url: workItemURL,
    });
    assert.equal(external.isError ?? false, false);
    const externalID = external.structuredContent.journey_id;
    await setTimeout(5);
    await generation('before-external-end');
    await api.post(`/journeys/${externalID}/abort`);
    await setTimeout(5);
    await generation('after-external-end');
    let externalEntries;
    for (let retry = 0; retry < 50; retry++) {
      externalEntries = await api.get(`/journeys/${externalID}/timeline`);
      if (externalEntries.some(({ type }) => type === 'recording.ended')) break;
      await setTimeout(60);
    }
    assert.deepEqual(
      externalEntries
        .filter(({ type }) => type === 'execution.observed')
        .map((entry) => entry.data.execution.model.response_id),
      ['before-external-end']
    );
    assert.equal(externalEntries.find(({ type }) => type === 'recording.ended')?.data.ended.reason, 'aborted');
  }
);

async function pluginLauncher(directory) {
  const { mcpServers } = JSON.parse(await readFile(pluginMCP, 'utf8'));
  const config = mcpServers.cairul;
  const mcpPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(config.type, 'stdio');
  assert.equal(config.command, 'cairul-mcp');
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await symlink(
    fileURLToPath(new URL(mcpPackage.bin[config.command], new URL('../', import.meta.url))),
    join(bin, config.command)
  );
  return { command: config.command, args: config.args, path: [bin, env.PATH].join(delimiter) };
}

async function startAPI(database, port = '0') {
  const child = spawn(apiBinary, ['--addr', `127.0.0.1:${port}`, '--db', database], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, CAIRUL_GITHUB_APP_ID: '', CAIRUL_GITHUB_POLL_INTERVAL: '15s', CAIRUL_LOG_LEVEL: 'info' },
  });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => (diagnostics += chunk));
  let address;
  try {
    address = await Promise.race([
      (async () => {
        for await (const line of lines) {
          if (line.startsWith('{')) {
            const entry = JSON.parse(line);
            if (entry.msg === 'http(s) server started') return entry.address;
          }
        }
        throw new Error(`API closed without listening. ${diagnostics}`);
      })(),
      exited.then(([code]) => {
        throw new Error(`API exited (${code}) before listening. ${diagnostics}`);
      }),
      setTimeout(8000, undefined, { ref: false }).then(() => {
        throw new Error(`API did not start within 8 seconds. ${diagnostics}`);
      }),
    ]);
  } catch (error) {
    child.kill();
    await exited.catch(() => {});
    throw error;
  }

  const url = `http://${address}`;
  const request = async (method, path, body, status) => {
    const response = await globalThis.fetch(url + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, status, JSON.stringify(payload));
    return payload;
  };
  return {
    url,
    get: (path) => request('GET', path, undefined, 200),
    post: (path, body, status = body === undefined ? 200 : 201) => request('POST', path, body, status),
    async close() {
      child.kill();
      const [code] = await exited;
      assert.equal(code, 0, diagnostics);
    },
  };
}
