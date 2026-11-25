import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execPath } from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entrypoint = fileURLToPath(new URL('../dist/index.js', import.meta.url));
test('stdio health tool calls the API through the SDK', { timeout: 10000 }, async (t) => {
  let healthy = true;
  const requests = [];
  const backend = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: healthy ? 'ok' : 'unavailable' }));
  }).listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => backend.close(resolve)));
  await once(backend, 'listening');

  const client = new Client({ name: 'cairul-test', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: execPath,
    args: [entrypoint],
    env: {
      KAIR0_API_URL: `http://127.0.0.1:${backend.address().port}/`,
      CAIRUL_BACKEND_ENABLED: 'true',
      CAIRUL_LOG_LEVEL: 'debug',
      CAIRUL_TELEMETRY: 'false',
    },
    stderr: 'pipe',
  });
  let logs = '';
  transport.stderr.on('data', (chunk) => (logs += chunk));
  t.after(async () => {
    await client.close();
    assert.match(logs, /"level":"DEBUG","msg":"API health check succeeded"/);
    assert.match(logs, /"level":"WARN","msg":"API health check failed"/);
  });
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), [
    'cairul_health',
    'journey_abort',
    'journey_complete',
    'journey_start',
    'journey_status',
  ]);
  const result = await client.callTool({ name: 'cairul_health' });
  assert.equal(result.isError ?? false, false);
  assert.deepEqual(result.structuredContent, { status: 'ok' });

  healthy = false;
  const unavailable = await client.callTool({ name: 'cairul_health' });
  assert.equal(unavailable.isError, true);
  assert.deepEqual(requests, ['GET /healthz', 'GET /healthz']);
});
