import { randomUUID } from 'node:crypto';
import type {
  ExecutionObservation,
  HarnessIdentity,
  JourneysApi,
  MCPRequestObservation,
  ObservationEvent,
  RecordingEndObservationReasonEnum,
} from '@cairul/sdk';
import { errorResponse } from '../api/index.js';
import { log } from '../logging.js';
import { timestamp } from './execution.js';
import type { CapturePolicy } from './harness.js';

type Event = Omit<ObservationEvent, 'id' | 'sequence'>;

export class Recording {
  readonly id = randomUUID();
  readonly pending: ObservationEvent[] = [];
  private sequence = 0;
  private observed = 0;
  private retained = 0;
  closed = false;
  private discarded = false;

  constructor(
    readonly journeyId: string,
    readonly harness: HarnessIdentity,
    private readonly policy: CapturePolicy,
    at: number,
    request: MCPRequestObservation
  ) {
    this.enqueue({
      type: 'recording.started',
      occurredAt: timestamp(at),
      started: { policyVersion: policy.version, request },
    });
  }

  collect(observation: { occurredAt: string; execution: ExecutionObservation }) {
    this.observed++;
    if (!this.matches(observation.execution.tools)) return;
    this.retained++;
    this.enqueue({ type: 'execution.observed', ...observation });
  }

  close(reason: RecordingEndObservationReasonEnum, at: number, sourceAvailable: boolean) {
    this.closed = true;
    this.enqueue({
      type: 'recording.ended',
      occurredAt: timestamp(at),
      ended: { reason, observed: this.observed, retained: this.retained, sourceAvailable },
    });
  }

  private matches(tools: ExecutionObservation['tools']) {
    const { mode, tool_names: names = [] } = this.policy;
    if (mode === 'none') return false;
    if (mode === 'all' && names.length === 0) return true;
    return tools.some(
      (tool) => (names.length === 0 || names.includes(tool.name)) && (mode !== 'failed_tools' || tool.failed)
    );
  }

  discard() {
    this.discarded = true;
    this.pending.length = 0;
  }

  private enqueue(event: Event) {
    if (this.discarded) return;
    const id = event.execution?.id ?? randomUUID();
    this.pending.push({ ...event, id, sequence: ++this.sequence });
  }
}

export class ObservationPublisher {
  private readonly recordings = new Set<Recording>();
  private sending?: Promise<void>;

  constructor(private readonly api: JourneysApi) {}

  open(journeyId: string, harness: HarnessIdentity, policy: CapturePolicy, at: number, request: MCPRequestObservation) {
    const recording = new Recording(journeyId, harness, policy, at, request);
    this.recordings.add(recording);
    return recording;
  }

  flush() {
    this.sending ??= Promise.all([...this.recordings].map((recording) => this.send(recording)))
      .then(() => undefined)
      .finally(() => {
        this.sending = undefined;
      });
    return this.sending;
  }

  private async send(recording: Recording) {
    let batchSize = 25;
    while (recording.pending.length > 0) {
      const events = recording.pending.slice(0, batchSize);
      try {
        await this.api.publishEvent(
          {
            eventPublication: {
              version: 1,
              type: 'journey.observations',
              journeyId: recording.journeyId,
              observations: { recordingId: recording.id, harness: recording.harness, events },
            },
          },
          { signal: AbortSignal.timeout(2000) }
        );
        recording.pending.splice(0, events.length);
        batchSize = 25;
      } catch (error) {
        const status = errorResponse(error)?.status;
        if (status === 413 && events.length > 1) {
          batchSize = Math.ceil(events.length / 2);
          continue;
        }
        log('warn', 'journey observations were not accepted', {
          recording_id: recording.id,
          ...(status && { status }),
        });
        if (status && status >= 400 && status < 500 && status !== 429) {
          recording.discard();
          this.recordings.delete(recording);
        }
        return;
      }
    }
    if (recording.closed) this.recordings.delete(recording);
  }

  async shutdown() {
    await this.sending;
    await this.flush();
  }
}
