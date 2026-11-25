import { randomUUID } from 'node:crypto';
import type { ExecutionObservation, MCPRequestObservation, ModelObservation, TokenUsage } from '@cairul/sdk';

type PendingTool = { name: string; at: number; mcpAt?: number };

export const timestamp = (ms: number) => new Date(ms).toISOString();

export class Execution {
  readonly tools = new Map<string, PendingTool>();
  private readonly completed: ExecutionObservation['tools'] = [];
  private model?: ModelObservation;
  sealed = false;
  private last: number;

  constructor(
    readonly turnId: string,
    private readonly at: number
  ) {
    this.last = at;
  }

  get response() {
    return this.model?.responseId;
  }

  generation(at: number, response: string, usage: TokenUsage, name?: string, provider?: string) {
    this.model = { responseId: response, observedAt: timestamp(Math.max(at, this.at)), usage, name, provider };
    this.last = Math.max(this.last, at);
  }

  declareTool(call: string, name: string, at: number) {
    if (this.tools.has(call)) return;
    this.tools.set(call, { name, at });
  }

  beginMCP(call: string, at: number) {
    const tool = this.tools.get(call);
    if (tool) tool.mcpAt = at;
  }

  completeTool(call: string, at: number, started?: number, failed?: boolean, request?: MCPRequestObservation) {
    const tool = this.tools.get(call);
    if (!tool) return;
    const start = Math.max(this.at, tool.mcpAt ?? started ?? tool.at);
    const end = Math.max(start, at);
    this.completed.push({
      callId: call,
      name: tool.name,
      startedAt: timestamp(start),
      endedAt: timestamp(end),
      failed,
      request,
      timing: tool.mcpAt !== undefined ? 'mcp_request' : started !== undefined ? 'runtime' : 'rollout',
    });
    this.last = Math.max(this.last, end);
    this.tools.delete(call);
  }

  close(reason: string, cutoff = Infinity) {
    if (this.at > cutoff) return;
    const end = Math.min(Math.max(this.last, this.at), cutoff);
    const occurredAt = timestamp(end);
    const model = this.model && this.model.observedAt <= occurredAt ? this.model : undefined;
    const tools = this.completed
      .filter((tool) => tool.startedAt <= occurredAt)
      .map((tool) =>
        tool.endedAt && tool.endedAt > occurredAt
          ? { ...tool, endedAt: undefined, failed: undefined, request: undefined }
          : tool
      );
    for (const [callId, tool] of this.tools) {
      const start = tool.mcpAt ?? tool.at;
      if (start > cutoff) continue;
      tools.push({
        callId,
        name: tool.name,
        startedAt: timestamp(Math.min(end, Math.max(this.at, start))),
        timing: tool.mcpAt !== undefined ? 'mcp_request' : 'rollout',
      });
    }
    const execution: ExecutionObservation = {
      id: randomUUID(),
      turnId: this.turnId,
      observedStartedAt: timestamp(this.at),
      model,
      tools,
      partial: model === undefined || tools.some((tool) => tool.endedAt === undefined),
      endReason: reason,
    };
    return { occurredAt, execution };
  }
}
