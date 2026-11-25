import { glob, open, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import type { TokenUsage } from '@cairul/sdk';
import { z } from 'zod';

const identifier = z.string().regex(/^[\w.:/-]{1,200}$/);
const identityMetadata = z.object({
  sessionId: z.uuid(),
  threadId: z.uuid(),
  'x-codex-turn-metadata': z.object({ codex_version: identifier.optional() }).optional(),
});

export function readCodexIdentity(input: unknown) {
  const meta = identityMetadata.safeParse(input);
  if (!meta.success) return;
  return {
    sessionId: meta.data.sessionId,
    threadId: meta.data.threadId,
    harnessVersion: meta.data['x-codex-turn-metadata']?.codex_version,
  };
}

const metadata = identityMetadata.extend({
  callId: identifier,
  'x-codex-turn-metadata': z.object({
    turn_id: identifier,
    model: identifier.optional(),
    codex_version: identifier.optional(),
  }),
});

export function readCodexCall(input: unknown, name: string, at: number) {
  const meta = metadata.safeParse(input);
  if (!meta.success) return;
  const { sessionId, threadId, callId, 'x-codex-turn-metadata': turn } = meta.data;
  return {
    session: sessionId,
    thread: threadId,
    call: callId,
    turn: turn.turn_id,
    model: turn.model,
    version: turn.codex_version,
    tool: 'mcp__cairul__' + name,
    at,
  };
}
export type CodexCall = NonNullable<ReturnType<typeof readCodexCall>>;

export type RolloutEvent =
  | { type: 'session'; at: number; provider?: string; version?: string }
  | { type: 'turn'; at: number; turn: string; model?: string }
  | { type: 'output'; at: number }
  | { type: 'generation'; at: number; turn: string; response: string; usage: TokenUsage }
  | { type: 'tool'; at: number; call: string; name: string }
  | { type: 'tool_end'; at: number; call: string; name?: string; started?: number; failed?: boolean }
  | { type: 'stop' | 'interrupt'; at: number; turn: string };

const tokens = {
  input_tokens: 'inputTokens',
  output_tokens: 'outputTokens',
  cached_input_tokens: 'cachedInputTokens',
  cache_write_input_tokens: 'cacheWriteInputTokens',
  reasoning_output_tokens: 'reasoningOutputTokens',
} as const;

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
}

function id(value: unknown) {
  return identifier.safeParse(value).data;
}

function toolName(payload: Record<string, unknown>) {
  const name = id(payload.name);
  const namespace = id(payload.namespace);
  return namespace && name ? namespace + '__' + name : name;
}

function decode(line: Buffer, thread: string): RolloutEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line.toString('utf8'));
  } catch {
    return;
  }
  const record = object(value);
  const payload = object(record?.payload);
  if (!record || !payload || typeof record.timestamp !== 'string') return;
  const at = Date.parse(record.timestamp);
  if (!Number.isFinite(at) || (payload.thread_id && payload.thread_id !== thread)) return;
  const turn = id(payload.turn_id);
  if (record.type === 'session_meta' && payload.id === thread) {
    return { type: 'session', at, provider: id(payload.model_provider), version: id(payload.cli_version) };
  }
  if (record.type === 'turn_context' && turn) return { type: 'turn', at, turn, model: id(payload.model) };
  if (record.type === 'token_usage_record' && turn) {
    const response = id(payload.response_id);
    if (!response) return;
    const usage = object(payload.usage);
    const values: TokenUsage = {};
    for (const [field, attr] of Object.entries(tokens)) {
      const count = usage?.[field];
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) values[attr] = count;
    }
    return { type: 'generation', at, turn, response, usage: values };
  }
  if (record.type === 'response_item') {
    const call = id(payload.call_id);
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const name = toolName(payload);
      if (call && name) return { type: 'tool', at, call, name };
    }
    if (call && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')) {
      const success = object(payload.output)?.success;
      return { type: 'tool_end', at, call, failed: typeof success === 'boolean' ? !success : undefined };
    }
    if (payload.type === 'reasoning' || (payload.type === 'message' && payload.role === 'assistant')) {
      return { type: 'output', at };
    }
  }
  if (record.type !== 'event_msg' || !turn) return;
  if (payload.type === 'task_started') return { type: 'turn', at, turn };
  if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
    return { type: payload.type === 'task_complete' ? 'stop' : 'interrupt', at, turn };
  }
  if (payload.type === 'item_completed') {
    const item = object(payload.item);
    const call = id(item?.id);
    if (!item || !call) return;
    const server = id(item.server);
    const tool = id(item.tool);
    const name =
      item.type === 'McpToolCall' && server && tool
        ? 'mcp__' + server + '__' + tool
        : item.type === 'CommandExecution'
          ? 'exec_command'
          : item.type === 'FileChange'
            ? 'apply_patch'
            : item.type === 'WebSearch'
              ? 'web_search'
              : undefined;
    if (!name) return;
    const started = typeof payload.started_at_ms === 'number' ? payload.started_at_ms : undefined;
    const ended = typeof payload.completed_at_ms === 'number' ? payload.completed_at_ms : at;
    const failed = ['failed', 'declined', 'cancelled'].includes(String(item.status))
      ? true
      : item.status === 'completed'
        ? false
        : undefined;
    return { type: 'tool_end', at: Math.min(at, ended), call, name, started, failed };
  }
}

const chunkSize = 64 * 1024;
const tailSize = 512 * 1024;
const maxLine = 2 * 1024 * 1024;

async function locateRollout(thread: string) {
  const codexHome = env.CODEX_HOME ?? join(homedir(), '.codex');
  const cwd = join(codexHome, 'sessions');
  for await (const name of glob('**/rollout-*-' + thread + '.jsonl', { cwd })) {
    return open(join(cwd, name), 'r');
  }
}

export async function readCodexProject(thread: string) {
  const file = await locateRollout(thread);
  if (!file) return;
  try {
    const buffer = Buffer.allocUnsafe(chunkSize);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    if (newline === -1) return;
    const record = object(JSON.parse(buffer.toString('utf8', 0, newline)));
    const payload = object(record?.payload);
    if (record?.type === 'session_meta' && payload?.id === thread && typeof payload.cwd === 'string') {
      return payload.cwd;
    }
  } finally {
    await file.close();
  }
}

export class CodexRollout {
  private file?: FileHandle;
  private offset = 0;
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private skipLine = false;
  private nextLookup = 0;

  constructor(private readonly thread: string) {}

  private async locate() {
    if (Date.now() < this.nextLookup) return;
    this.nextLookup = Date.now() + 1000;
    const file = await locateRollout(this.thread);
    if (file) {
      this.file = file;
      this.offset = Math.max(0, (await file.stat()).size - tailSize);
      this.skipLine = this.offset > 0;
    }
  }

  async *read(): AsyncGenerator<RolloutEvent> {
    if (!this.file) await this.locate();
    const file = this.file;
    if (!file) return;
    const size = (await file.stat()).size;
    const buffer = Buffer.allocUnsafe(chunkSize);
    while (this.offset < size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - this.offset), this.offset);
      if (bytesRead === 0) break;
      this.offset += bytesRead;
      for (let pos = 0; pos < bytesRead;) {
        const lf = buffer.indexOf(10, pos);
        const complete = lf >= 0 && lf < bytesRead;
        const end = complete ? lf : bytesRead;
        const part = buffer.subarray(pos, end);
        if (this.pending.length + part.length > maxLine) this.skipLine = true;
        if (complete) {
          const line = this.pending.length ? Buffer.concat([this.pending, part]) : part;
          const event = this.skipLine ? undefined : decode(line, this.thread);
          this.pending = Buffer.alloc(0);
          this.skipLine = false;
          if (event) yield event;
        } else if (!this.skipLine) {
          this.pending = this.pending.length ? Buffer.concat([this.pending, part]) : Buffer.from(part);
        }
        pos = end + 1;
      }
    }
  }

  get available() {
    return this.file !== undefined;
  }

  async close() {
    await this.file?.close();
  }
}
