import { Console } from 'node:console';
import process, { cwd, stderr, stdin } from 'node:process';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { setting } from './environment.js';
import { backend, errorResponse } from './api/index.js';
import { shutdownExecutions } from './check-executions.js';
import { readJourneyState, registerJourneyTools } from './journeys.js';
import { findProject } from './local-config.js';
import { getCheckRegistry } from './local-plugins.js';
import { log } from './logging.js';
import { CodexTracker } from './observations/codex.js';
import { withoutHarness } from './observations/harness.js';
import { instrumentTools } from './observations/mcp.js';
import { ObservationPublisher } from './observations/publisher.js';
import { observationsEnabled } from './observations/settings.js';

// Reserve stdout for MCP messages, including while project plugins load.
globalThis.console = new Console({ stdout: stderr, stderr });
const startupProject = await findProject(setting('PROJECT_DIR') || cwd());
await getCheckRegistry(startupProject);

const api = backend?.health;
const journeys = backend?.journeys;

const harnessName = setting('HARNESS') ?? 'codex';
const tracker =
  journeys && observationsEnabled() && harnessName === 'codex'
    ? new CodexTracker(new ObservationPublisher(journeys), (id) => readJourneyState(journeys, id))
    : withoutHarness;
const instrument = instrumentTools(tracker);

const serverHandle = serveStdio(
  () => {
    const server = new McpServer({ name: 'cairul', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.registerTool(
      'cairul_health',
      {
        description: 'Check cairul health, including backend availability when enabled.',
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      (context) =>
        instrument('cairul_health', context, async (call) => {
          if (!api) {
            const health = { status: 'ok', backend_enabled: false };
            return { content: [{ type: 'text', text: JSON.stringify(health) }], structuredContent: health };
          }
          const started = Date.now();
          try {
            const signal = AbortSignal.any([call.signal, AbortSignal.timeout(5000)]);
            const result = await api.getHealthRaw({ signal });
            call.httpStatus = result.raw.status;
            const health = await result.value();
            log('debug', 'API health check succeeded', { duration_ms: Date.now() - started });
            return {
              content: [{ type: 'text', text: JSON.stringify(health) }],
              structuredContent: { ...health },
            };
          } catch (error) {
            call.httpStatus = errorResponse(error)?.status;
            const errorType = error instanceof Error ? error.name : 'unknown';
            log('warn', 'API health check failed', { duration_ms: Date.now() - started, error_type: errorType });
            return {
              isError: true,
              content: [{ type: 'text', text: 'The cairul API health check failed.' }],
            };
          }
        })
    );
    registerJourneyTools(server, journeys, instrument, harnessName);
    return server;
  },
  { onerror: (error) => log('error', 'MCP transport error', { error_type: error.name }) }
);

let shutdown: Promise<void> | undefined;
function stop() {
  shutdown ??= (async () => {
    await shutdownExecutions();
    await serverHandle.close();
    await tracker.shutdown();
  })().catch((error: unknown) => {
    log('warn', 'MCP shutdown did not finish', { error_type: error instanceof Error ? error.name : 'unknown' });
  });
}
stdin.once('end', stop);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

log('info', 'cairul MCP server started');
