import type { MCPRequestObservation, RecordingEndObservationReasonEnum } from '@cairul/sdk';
import { log } from '../logging.js';
import { CodexRollout, readCodexCall, type CodexCall, type RolloutEvent } from './codex-rollout.js';
import { Execution, timestamp } from './execution.js';
import type { HarnessTracker, JourneyState, RequestOutcome } from './harness.js';
import type { ObservationPublisher, Recording } from './publisher.js';

class Capture {
  private readonly reader: CodexRollout;
  private readonly batches = new Set<Execution>();
  private readonly calls = new Map<string, Execution>();
  private readonly completedCalls = new Set<string>();
  private readonly responses = new Set<string>();
  private deferred: RolloutEvent[] = [];
  private current?: Execution;
  private model?: string;
  private provider?: string;
  private turn: string;
  private openingInferencePending = false;
  pendingTerminalCalls = 0;

  constructor(
    private readonly recording: Recording,
    private readonly opening: CodexCall,
    public journey: JourneyState,
    private readonly started: number
  ) {
    this.reader = new CodexRollout(opening.thread);
    this.model = opening.model;
    this.turn = opening.turn;
  }

  async drain(cutoff: number) {
    const deferred = this.deferred;
    this.deferred = [];
    for (const event of deferred) this.acceptBefore(event, cutoff);
    for await (const event of this.reader.read()) this.acceptBefore(event, cutoff);
  }

  private acceptBefore(event: RolloutEvent, cutoff: number) {
    if (event.at > cutoff) {
      this.deferred.push(event);
      return;
    }
    if (event.type === 'session') {
      this.provider = event.provider;
      return;
    }
    // The opening tool can finish after activation, but its inference was already in flight.
    if (event.type === 'tool' && event.call === this.opening.call) {
      this.openingInferencePending = true;
      return;
    }
    if (event.type === 'generation' && this.openingInferencePending) {
      this.openingInferencePending = false;
      if (event.turn === this.opening.turn) return;
    }
    if (event.at < this.started) return;

    switch (event.type) {
      case 'turn':
        if (event.turn !== this.turn) this.changeTurn(event.turn);
        if (event.model) this.model = event.model;
        break;
      case 'output':
        this.batch(event.at);
        break;
      case 'generation':
        if (this.responses.has(event.response)) return;
        if (event.turn !== this.turn) this.changeTurn(event.turn);
        this.responses.add(event.response);
        this.batch(event.at).generation(event.at, event.response, event.usage, this.model, this.provider);
        break;
      case 'tool':
        this.declareTool(event.call, event.name, event.at);
        break;
      case 'tool_end':
        if (event.call === this.opening.call || (event.started !== undefined && event.started < this.started)) return;
        if (event.name && this.current)
          this.declareTool(event.call, event.name, event.started ?? event.at, this.current);
        this.completeTool(event.call, event.at, event.failed, event.started);
        break;
      case 'stop':
      case 'interrupt':
        if (event.turn === this.turn) this.closeBatches(event.type);
        break;
    }
  }

  private changeTurn(turn: string) {
    this.closeBatches('next_turn');
    this.turn = turn;
    this.model = undefined;
  }

  private batch(at: number) {
    if (this.current?.response !== undefined) {
      this.current.sealed = true;
      this.closeIfFinished(this.current);
      this.current = undefined;
    }
    if (!this.current) {
      this.current = new Execution(this.turn, Math.max(at, this.started));
      this.batches.add(this.current);
    }
    return this.current;
  }

  private declareTool(call: string, name: string, at: number, existing?: Execution) {
    if (this.completedCalls.has(call)) return;
    const batch = this.calls.get(call) ?? existing ?? this.batch(at);
    batch.declareTool(call, name, at);
    this.calls.set(call, batch);
    return batch;
  }

  beginTool(call: CodexCall) {
    if (call.turn !== this.turn) this.changeTurn(call.turn);
    if (call.model) this.model = call.model;
    this.declareTool(call.call, call.tool, call.at)?.beginMCP(call.call, call.at);
  }

  completeTool(call: string, at: number, failed?: boolean, started?: number, request?: MCPRequestObservation) {
    const execution = this.calls.get(call);
    if (!execution) return;
    execution.completeTool(call, at, started, failed, request);
    this.calls.delete(call);
    this.completedCalls.add(call);
    this.closeIfFinished(execution);
  }

  private closeIfFinished(batch: Execution) {
    if (!batch.sealed || batch.tools.size) return;
    this.collect(batch, 'next_model_response');
    this.batches.delete(batch);
  }

  private closeBatches(reason: string, cutoff?: number) {
    for (const batch of this.batches) this.collect(batch, reason, cutoff);
    this.batches.clear();
    this.calls.clear();
    this.current = undefined;
  }

  private collect(batch: Execution, reason: string, cutoff?: number) {
    const observation = batch.close(reason, cutoff);
    if (observation) this.recording.collect(observation);
  }

  async close(reason: RecordingEndObservationReasonEnum, at: number) {
    this.closeBatches(reason, at);
    this.recording.close(reason, at, this.reader.available);
    await this.reader.close();
  }
}

export class CodexTracker implements HarnessTracker {
  private readonly captures = new Map<string, Capture>();
  private queue = Promise.resolve<unknown>(undefined);
  private readonly timer: NodeJS.Timeout;
  private stopping = false;
  private checking = false;

  constructor(
    private readonly publisher: ObservationPublisher,
    private readonly readJourney: (id: string) => Promise<JourneyState>
  ) {
    this.timer = setInterval(() => {
      void this.poll();
      void this.publisher.flush();
    }, 1000).unref();
  }

  private async poll() {
    if (this.stopping || this.checking || this.captures.size === 0) return;
    this.checking = true;
    try {
      await Promise.all(
        [...this.captures].map(async ([thread, capture]) => {
          const observedAt = Date.now();
          const state = await this.readJourney(capture.journey.id).catch(() => undefined);
          if (!state || this.stopping) return;
          await this.enqueue(async () => {
            if (this.captures.get(thread) !== capture) return;
            if (state.status === 'active') {
              await capture.drain(observedAt);
              if (Date.parse(state.updated_at) >= Date.parse(capture.journey.updated_at)) capture.journey = state;
            } else if (capture.pendingTerminalCalls === 0) {
              const terminal = Date.parse(state.updated_at);
              const now = Date.now();
              await this.finishJourney(
                thread,
                capture,
                state,
                Number.isFinite(terminal) ? Math.min(terminal, now) : now
              );
            }
          });
        })
      );
    } finally {
      this.checking = false;
    }
  }

  beginTool(
    input: unknown,
    name: string,
    at: number
  ): Promise<((outcome: RequestOutcome) => Promise<void>) | undefined> {
    const call = readCodexCall(input, name, at);
    if (!call || this.stopping) return Promise.resolve(undefined);
    return this.enqueue(async () => {
      const capture = this.captures.get(call.thread);
      await capture?.drain(at);
      capture?.beginTool(call);
      const terminal = capture && (name === 'journey_complete' || name === 'journey_abort') ? capture : undefined;
      if (terminal) terminal.pendingTerminalCalls++;
      return ({ failed, endedAt, journey, httpStatus }: RequestOutcome) =>
        this.enqueue(async () => {
          if (terminal) terminal.pendingTerminalCalls--;
          const request: MCPRequestObservation = {
            callId: call.call,
            tool: name,
            startedAt: timestamp(at),
            endedAt: timestamp(endedAt),
            failed,
            httpStatus,
          };
          capture?.completeTool(call.call, endedAt, failed, undefined, request);
          if (!journey || this.stopping) return;
          const current = this.captures.get(call.thread);
          if (journey.status === 'active') {
            if (current?.journey.id === journey.id) {
              current.journey = journey;
            } else {
              if (current) await this.close(call.thread, 'journey_switched', endedAt);
              const policy = journey.capture_policy;
              if (policy.mode === 'none') return;
              const recording = this.publisher.open(
                journey.id,
                {
                  name: 'codex',
                  sessionId: call.session,
                  threadId: call.thread,
                  version: call.version,
                },
                policy,
                endedAt,
                request
              );
              this.captures.set(call.thread, new Capture(recording, call, journey, endedAt));
            }
          } else if (current?.journey.id === journey.id) {
            await this.finishJourney(call.thread, current, journey, endedAt);
          }
        });
    });
  }

  private async finishJourney(thread: string, capture: Capture, journey: JourneyState, at: number) {
    await capture.drain(at);
    capture.journey = journey;
    await this.close(thread, journey.status === 'completed' ? 'completed' : 'aborted', at);
    void this.publisher.flush();
  }

  async shutdown() {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.timer);
    await this.enqueue(async () => {
      const now = Date.now();
      for (const [thread, capture] of this.captures) {
        await capture.drain(now);
        await this.close(thread, 'session_end', now);
      }
    });
    await this.publisher.shutdown();
  }

  private async close(thread: string, reason: RecordingEndObservationReasonEnum, at: number) {
    const capture = this.captures.get(thread);
    this.captures.delete(thread);
    await capture?.close(reason, at);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T | undefined> {
    const next = this.queue.then(work).catch((error: unknown) => {
      log('warn', 'Codex telemetry collection failed', { error_type: error instanceof Error ? error.name : 'unknown' });
      return undefined;
    });
    this.queue = next;
    return next;
  }
}
