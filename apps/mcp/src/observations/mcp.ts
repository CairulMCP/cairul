import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import type { HarnessTracker, JourneyState } from './harness.js';

export interface PluginRequest {
  signal: AbortSignal;
  journey?: JourneyState;
  httpStatus?: number;
}

export function instrumentTools(tracker: HarnessTracker) {
  return async (
    name: string,
    context: ServerContext,
    run: (request: PluginRequest) => Promise<CallToolResult>
  ): Promise<CallToolResult> => {
    const finish = await tracker.beginTool(context.mcpReq._meta, name, Date.now());
    const request: PluginRequest = { signal: context.mcpReq.signal };
    let failed = true;
    try {
      const result = await run(request);
      failed = result.isError === true;
      return result;
    } finally {
      await finish?.({ failed, endedAt: Date.now(), journey: request.journey, httpStatus: request.httpStatus });
    }
  };
}
