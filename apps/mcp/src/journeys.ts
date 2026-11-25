import { randomUUID } from 'node:crypto';
import { cwd } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { JourneysApi } from '@cairul/sdk';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { setting } from './environment.js';
import { errorResponse } from './api/index.js';
import { findProject, loadConfig } from './local-config.js';
import { backendStart, backendStatus, startLocalJourney, updateLocalJourney } from './local-journeys.js';
import { getCheckRegistry } from './local-plugins.js';
import { log } from './logging.js';
import { readCodexIdentity, readCodexProject } from './observations/codex-rollout.js';
import { capturePolicy, journeyState } from './observations/harness.js';
import { type PluginRequest, instrumentTools } from './observations/mcp.js';

const journeyInput = z.object({
  journey_id: z
    .uuid()
    .transform((id) => id.toLowerCase())
    .describe('ID returned by journey_start'),
});

export async function readJourneyState(api: JourneysApi, id: string) {
  const { raw } = await api.getJourneyStatusRaw({ id }, { signal: AbortSignal.timeout(1000) });
  return journeyState.parse(await raw.json());
}

const updates = {
  status: 'getJourneyStatusRaw',
  abort: 'abortJourneyRaw',
  complete: 'completeJourneyRaw',
} as const;

async function projectDirectory(server: McpServer, threadId: string | undefined, signal: AbortSignal) {
  const configuredProject = setting('PROJECT_DIR');
  if (configuredProject) return findProject(configuredProject);
  const project = threadId && (await readCodexProject(threadId).catch(() => undefined));
  if (project) return findProject(project);
  if (server.server.getClientCapabilities()?.roots) {
    const response = await server.server.listRoots(undefined, { signal, timeout: 1000 }).catch(() => undefined);
    const roots = response?.roots.filter(({ uri }) => uri.startsWith('file:')) ?? [];
    if (roots.length > 1) throw new Error('Set CAIRUL_PROJECT_DIR when the harness exposes multiple project roots.');
    if (roots.length === 1) return findProject(fileURLToPath(roots[0].uri));
  }
  return findProject(cwd());
}

export function registerJourneyTools(
  server: McpServer,
  api: JourneysApi | undefined,
  instrument: ReturnType<typeof instrumentTools>,
  harness: string
) {
  server.registerTool(
    'journey_start',
    {
      description: 'Start a journey for a work item URL and pin its plan and local check configuration.',
      inputSchema: z.object({
        session_id: z.string().trim().min(1).max(200).describe('Session ID issued by the agent harness.'),
        user_id: z.string().trim().min(1).max(200).optional().describe('User ID from the harness, when known.'),
        work_item_url: z.url({ protocol: /^https?$/ }).describe('Work item URL'),
        capture_policy: capturePolicy.optional().describe('Optional whole-execution filter for backend observations.'),
      }),
      annotations: { destructiveHint: false },
    },
    ({ session_id, user_id, work_item_url, capture_policy }, context) =>
      instrument('journey_start', context, (call) =>
        respond('journey_start', call, async () => {
          const identity = harness === 'codex' ? readCodexIdentity(context.mcpReq._meta) : undefined;
          if (identity && identity.sessionId !== session_id) {
            throw new Error('Pass the Codex session ID for this session as session_id.');
          }
          const mode = capture_policy?.mode ?? 'all';
          const toolNames = [...new Set(capture_policy?.tool_names)].sort();
          if (mode === 'none' && toolNames.length) throw new Error('Capture mode none cannot include tool names.');
          const project = await projectDirectory(server, identity?.threadId, call.signal);
          const config = await loadConfig(project, work_item_url, await getCheckRegistry(project));
          const eventPublication = {
            version: 1,
            type: 'journey.start' as const,
            id: randomUUID(),
            start: {
              sessionId: session_id,
              harness,
              harnessVersion: identity?.harnessVersion,
              threadId: identity?.threadId,
              userId: user_id,
              workItemUrl: work_item_url,
              capturePolicy: { mode, toolNames },
              localCheckNames: Array.from(config.catalog.keys()),
            },
          };
          const remote =
            api && config.selected?.mode !== 'override'
              ? {
                  start: async () => {
                    const body = await backendRequest(call, async (signal) => {
                      const send = () => api.publishEventRaw({ eventPublication }, { signal });
                      try {
                        return await send();
                      } catch (error) {
                        const status = errorResponse(error)?.status;
                        if (signal.aborted || (status !== undefined && status < 500)) throw error;
                        return send();
                      }
                    });
                    return backendStart.parse(body.started);
                  },
                  update: async (action: keyof typeof updates, id: string) =>
                    backendStatus.parse(
                      await backendRequest(call, (signal) => api[updates[action]]({ id }, { signal }))
                    ),
                }
              : undefined;
          const result = await startLocalJourney(
            project,
            config,
            {
              work_item_url,
              identity: {
                session_id,
                harness,
                harness_version: identity?.harnessVersion,
                thread_id: identity?.threadId,
                user_id,
              },
              capture_policy: { version: 1, mode, ...(toolNames.length && { tool_names: toolNames }) },
            },
            remote
          );
          call.journey = result.backend;
          return result.payload;
        })
      )
  );

  const tools = [
    { action: 'status', description: 'Run pending local checks and return the current phase and incomplete checks.' },
    { action: 'abort', description: 'Abort an active journey even when checks are incomplete.' },
    { action: 'complete', description: 'Complete a journey after every phase and check is satisfied.' },
  ] as const;
  for (const { action, description } of tools) {
    const name = `journey_${action}`;
    server.registerTool(
      name,
      {
        description,
        inputSchema: journeyInput,
        annotations: { destructiveHint: action !== 'complete', idempotentHint: action !== 'status' },
      },
      ({ journey_id }, context) =>
        instrument(name, context, (call) =>
          respond(name, call, async () => {
            const identity = harness === 'codex' ? readCodexIdentity(context.mcpReq._meta) : undefined;
            const project = await projectDirectory(server, identity?.threadId, call.signal);
            const remote =
              api &&
              ((action: keyof typeof updates, id: string) =>
                backendRequest(call, (signal) => api[updates[action]]({ id }, { signal })));
            const result = await updateLocalJourney(
              project,
              journey_id,
              action,
              call.signal,
              () => getCheckRegistry(project),
              remote && (async (action, id) => backendStatus.parse(await remote(action, id)))
            );
            if (result) {
              call.journey = result.backend;
              return result.journey;
            }
            if (!remote) throw new Error(`Journey ${journey_id} was not found in ${project}.`);
            const payload = await remote(action, journey_id);
            call.journey = journeyState.safeParse(payload).data;
            return payload;
          })
        )
    );
  }
}

async function backendRequest(call: PluginRequest, send: (signal: AbortSignal) => Promise<{ raw: Response }>) {
  try {
    const { raw } = await send(AbortSignal.any([call.signal, AbortSignal.timeout(5000)]));
    call.httpStatus = raw.status;
    return (await raw.json()) as Record<string, unknown>;
  } catch (error) {
    const response = errorResponse(error);
    if (response) {
      call.httpStatus = response.status;
      const body: unknown = await response.json().catch(() => null);
      if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
        throw new Error(body.message, { cause: error });
      }
    }
    throw new Error('The cairul API request failed.', { cause: error });
  }
}

async function respond(tool: string, call: PluginRequest, run: () => Promise<Record<string, unknown>>) {
  const started = Date.now();
  try {
    const payload = await run();
    log('debug', 'journey tool succeeded', { tool, status: call.httpStatus ?? 0, duration_ms: Date.now() - started });
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], structuredContent: payload };
  } catch (error) {
    log(call.signal.aborted ? 'debug' : 'warn', 'journey tool failed', {
      tool,
      status: call.httpStatus ?? 0,
      duration_ms: Date.now() - started,
      error_type: error instanceof Error ? error.name : 'unknown',
    });
    return {
      isError: true,
      content: [
        { type: 'text' as const, text: error instanceof Error ? error.message : 'The journey request failed.' },
      ],
    };
  }
}
