/**
 * @dsh-supreme/observability — REAL pinned event map.
 *
 * Every event name below was verified against the pinned upstream
 * deepseek-harness @ d347e703908d0406b7a7ef80e3a0e594d86b2215.
 * DO NOT add names from memory — cite the source file next to each name.
 *
 * | Event                       | Declared in (pinned source)                                   | Dispatch |
 * |-----------------------------|---------------------------------------------------------------|----------|
 * | session/created             | packages/core/session/src/index.ts:39                          | emit     |
 * | session/disposed            | packages/core/session/src/index.ts:41                          | emit     |
 * | session/event               | packages/core/session/src/index.ts:43                          | emit     |
 * | agent/request               | packages/core/agent/src/runtime-types.ts:~270                  | waterfall|
 * | agent/request-error         | packages/core/agent/src/runtime-types.ts:~277                  | waterfall|
 * | agent/assistant-stream      | packages/core/agent/src/runtime-types.ts:~288                  | emit     |
 * | tools/execute               | packages/core/tools/src/index.ts:~140                          | waterfall|
 * | subagent/start              | packages/subagent/subagent/src/index.ts:~152                   | emit     |
 * | subagent/end                | packages/subagent/subagent/src/index.ts:~154                   | emit     |
 * | workflow/start              | packages/workflow/workflow/src/index.ts:~37                    | emit     |
 * | workflow/end                | packages/workflow/workflow/src/index.ts:~42                    | emit     |
 *
 * Session-log event types (reached via `session/event`, declared in
 * packages/core/session/src/types.ts:260-376 and compaction/src/types.ts):
 *   turn/start, turn/end, step/start, step/end, tool/call, tool/result,
 *   assistant/message, request/context, compaction/start, compaction/summary,
 *   compaction/end, approval/asked, approval/decided
 */

/** Structurally-typed views of pinned payloads (defensive: only allowlisted fields are read). */

export interface SessionEventView {
  type: string;
  seq?: number;
  [key: string]: unknown;
}

export interface SessionView {
  id: string;
  [key: string]: unknown;
}

/** Names this plugin subscribes to on the Cordis event bus. */
export const SUBSCRIBED_BUS_EVENTS = [
  'session/created',
  'session/disposed',
  'session/event',
  'agent/request',
  'agent/request-error',
  'tools/execute',
  'subagent/start',
  'subagent/end',
  'workflow/start',
  'workflow/end',
] as const;

export type SubscribedBusEvent = (typeof SUBSCRIBED_BUS_EVENTS)[number];

/** Session-log event types we translate into records. */
export const OBSERVED_LOG_EVENT_TYPES = [
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'tool/call',
  'tool/result',
  'assistant/message',
  'request/context',
  'compaction/start',
  'compaction/end',
] as const;

/** Extract an error class from a tool result / request failure (bounded vocabulary). */
export function classifyError(input: unknown): string {
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name : undefined;
    const code = typeof rec.code === 'string' ? rec.code : undefined;
    if (code) return code.slice(0, 64);
    if (name) return name.slice(0, 64);
    const failure = rec.failure;
    if (failure && typeof failure === 'object') return classifyError(failure);
  }
  return 'UNKNOWN';
}
