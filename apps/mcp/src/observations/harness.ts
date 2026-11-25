import { z } from 'zod';

export const capturePolicy = z.object({
  mode: z.enum(['all', 'failed_tools', 'none']).optional(),
  tool_names: z.array(z.string().min(1).max(200)).max(64).optional(),
});

export const journeyState = z.object({
  id: z.uuid(),
  status: z.enum(['active', 'completed', 'aborted']),
  updated_at: z.string(),
  capture_policy: capturePolicy.extend({ version: z.literal(1), mode: z.enum(['all', 'failed_tools', 'none']) }),
});

export type JourneyState = z.infer<typeof journeyState>;
export type CapturePolicy = JourneyState['capture_policy'];

export interface RequestOutcome {
  failed: boolean;
  endedAt: number;
  httpStatus?: number;
  journey?: JourneyState;
}

export interface HarnessTracker {
  beginTool(
    metadata: unknown,
    tool: string,
    at: number
  ): Promise<((outcome: RequestOutcome) => Promise<void>) | undefined>;
  shutdown(): Promise<void>;
}

export const withoutHarness: HarnessTracker = {
  async beginTool() {
    return undefined;
  },
  async shutdown() {},
};
