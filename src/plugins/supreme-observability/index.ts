/**
 * @dsh-supreme/observability — Cordis adapter (REAL pinned plugin shape).
 *
 * SERVICE = supremeObservability
 * INJECTED DSH SERVICES = none (consumes official event seams via ctx.on)
 *
 * Safety contract (Spec §10):
 *  - metadata allowlisting only; never serializes payloads, arguments,
 *    prompts, responses, credentials, or environment values;
 *  - writer failure fails open (records dropped, agent unaffected);
 *  - disabled=true makes the plugin a complete no-op;
 *  - every ctx.on registration is a Cordis effect and unwinds on unload;
 *  - dispose flushes the writer queue.
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { dirname, resolve } from 'node:path';
import {
  buildRecord,
  JsonlWriter,
  readRecent,
  type ObservabilityConfig,
  type SafeRecord,
} from './engine';
import { classifyError, type SessionEventView, type SessionView } from './event-map';

import '../context-types';
export const name = 'supreme-observability';

/** No hard DSH service dependencies; all consumption is via official events. */
export const inject: string[] = [];

export const Config = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default('dsh-supreme/data/observability'),
  fileName: z.string().default('observability.jsonl'),
  maxFileBytes: z.number().int().min(10_000).default(5_000_000),
  maxLineChars: z.number().int().min(256).default(2048),
});

export type ObservabilityService = {
  isEnabled(): boolean;
  /** Record an already-safe, allowlisted event (host-side use, e.g. router). */
  record(event: string, fields: Record<string, unknown>): void;
  stats(): { written: number; dropped: number; rotations: number; seq: number };
  /**
   * Await the pending write queue (deterministic drain for hosts/verifiers).
   * Resolves with the FULL writer stats — including dropped + lastWriteError —
   * so a fail-open writer never has to mean fail-silent.
   */
  flush(): Promise<{
    written: number;
    dropped: number;
    rotations: number;
    lastWriteError: string | null;
  }>;
  recent(count: number): Promise<SafeRecord[]>;
};

export function apply(ctx: Context, config: ObservabilityConfig): void {
  const observed: ObservabilityConfig = { ...config };

  let seq = 0;
  let writer: JsonlWriter | null = null;
  let fileWriter = true;

  if (observed.enabled) {
    // Node fs implementation bound at apply time (fail-open wrapper below).
    const fs = process.getBuiltinModule('node:fs').promises;
    const filePath = resolve(observed.dataDir, observed.fileName);
    writer = new JsonlWriter(
      filePath,
      filePath + '.1',
      observed.maxFileBytes,
      observed.maxLineChars,
      {
        appendFile: (p, d) => fs.appendFile(p, d, 'utf8'),
        stat: async (p) => {
          const s = await fs.stat(p);
          return { size: s.size };
        },
        rename: (f, t) => fs.rename(f, t),
        mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => undefined),
      },
    );
    ctx.logger.info('supreme-observability writing to %s', filePath);
    // Boot-time self-check: materialize the store directory EAGERLY so a
    // broken dataDir (permissions, antivirus lock, bad path) is visible in
    // the boot log at boot — fail-open must never mean fail-silent.
    const storeDir = dirname(filePath);
    fs.mkdir(storeDir, { recursive: true }).then(
      () => ctx.logger.info('supreme-observability store ready: %s', storeDir),
      (err: unknown) =>
        ctx.logger.warn(
          'supreme-observability store mkdir FAILED (%s): %s — records will be dropped until fixed',
          storeDir,
          err instanceof Error ? err.message : String(err),
        ),
    );
  } else {
    fileWriter = false;
    ctx.logger.info('supreme-observability disabled — no-op mode');
  }

  const emit = (event: string, fields: Record<string, unknown>): void => {
    if (!writer) return;
    seq += 1;
    writer.write(buildRecord(seq, Date.now(), event, fields));
  };

  const disposers: Array<() => void> = [];

  // --- Official event seams (names verified — see event-map.ts) -------------

  // Handler types are INFERRED from the pinned typed Events declarations
  // (packages/core/session/src/index.ts:39-83) — no local reshaping.
  disposers.push(
    ctx.on('session/created', (session) => {
      emit('session_started', { sessionId: String(session.id) });
    }),
  );
  disposers.push(
    ctx.on('session/disposed', (session) => {
      emit('session_ended', { sessionId: String(session.id) });
    }),
  );

  disposers.push(
    ctx.on('session/event', (session, event) => {
      const sessionId = String(session.id);
      switch (event.type) {
        case 'turn/start':
        case 'turn/end':
        case 'step/start':
        case 'step/end': {
          const d = event.data;
          emit(event.type.replace('/', '_'), {
            sessionId,
            turn: 'turn' in d ? d.turn : undefined,
            step: 'step' in d ? d.step : undefined,
          });
          break;
        }
        case 'tool/call': {
          const d = event.data;
          emit('tool_call', {
            sessionId,
            turn: d.turn,
            step: d.step,
            tool: d.name,
            // Never serialize d.arguments (may bear secrets).
          });
          break;
        }
        case 'tool/result': {
          const d = event.data;
          emit('tool_result', {
            sessionId,
            turn: d.turn,
            step: d.step,
            toolError: d.error !== undefined,
            errorClass: d.error ? classifyError(d.error) : undefined,
          });
          break;
        }
        case 'assistant/message': {
          const d = event.data;
          emit('assistant_message', {
            sessionId,
            turn: d.turn,
            step: d.step,
            usageIn: d.usage?.inputTokens,
            usageOut: d.usage?.outputTokens,
            // Never serialize d.message / d.stream content.
          });
          break;
        }
        case 'request/context': {
          emit('request_context', {
            sessionId,
            provider: event.data.provider,
            model: event.data.model,
          });
          break;
        }
        case 'compaction/start':
          emit('compaction_started', { sessionId, detail: 'compaction' });
          break;
        case 'compaction/end':
          emit('compaction_ended', {
            sessionId,
            errorClass: event.data.error ? classifyError(event.data.error) : undefined,
          });
          break;
        default:
          // Observed but not recorded — keep the allowlist tight.
          break;
      }
    }),
  );

  // LLM request lifecycle (waterfall — must call next() exactly once).
  disposers.push(
    ctx.on('agent/request', async (payload, next) => {
      const started = Date.now();
      const call = await next();
      emit('llm_request', {
        sessionId: payload.agent?.session ? String(payload.agent.session.id) : undefined,
        turn: payload.turn,
        step: payload.step,
        provider: call.provider,
        model: call.model,
        latencyMs: Date.now() - started,
      });
      return call;
    }),
  );

  disposers.push(
    ctx.on('agent/request-error', (payload, next) =>
      // Observe, then pass through unchanged.
      next().then((action) => {
        emit('llm_request_error', {
          provider: payload.provider,
          turn: payload.turn,
          step: payload.step,
          errorClass: classifyError(payload.failure),
        });
        return action;
      }),
    ),
  );

  disposers.push(
    ctx.on('tools/execute', async (exec, next) => {
      const started = Date.now();
      const result = await next();
      emit('tool_executed', {
        tool: exec.name,
        latencyMs: Date.now() - started,
        toolError: result.isError === true,
      });
      return result;
    }),
  );

  disposers.push(
    ctx.on('subagent/start', (info) => {
      emit('subagent_started', {
        subagent: safeName(info),
        sessionId: sessionIdOf(info),
      });
    }),
  );
  disposers.push(
    ctx.on('subagent/end', (info) => {
      emit('subagent_ended', { subagent: safeName(info), sessionId: sessionIdOf(info) });
    }),
  );
  disposers.push(
    ctx.on('workflow/start', (info) => {
      emit('workflow_started', { workflow: safeName(info) });
    }),
  );
  disposers.push(
    ctx.on('workflow/end', (info) => {
      emit('workflow_ended', { workflow: safeName(info) });
    }),
  );

  const service: ObservabilityService = {
    isEnabled: () => fileWriter,
    record: (event, fields) => emit(event, fields),
    stats: () => ({
      written: writer?.getStats().written ?? 0,
      dropped: writer?.getStats().dropped ?? 0,
      rotations: writer?.getStats().rotations ?? 0,
      seq,
    }),
    flush: async () => {
      if (!writer) {
        return { written: 0, dropped: 0, rotations: 0, lastWriteError: null };
      }
      return writer.flush();
    },
    recent: async (count) => {
      if (!writer) return [];
      const fs = process.getBuiltinModule('node:fs').promises;
      return readRecent(writer.filePath, count, {
        readFile: async (p) => {
          try {
            return await fs.readFile(p, 'utf8');
          } catch {
            return null;
          }
        },
      });
    },
  };

  ctx.provide('supremeObservability', Object.freeze(service));

  // Flush on unload: execute returns the disposer (reverse-order unwind).
  ctx.effect(() => {
    return () => {
      return writer?.dispose().then((stats) => {
        if (stats && stats.dropped > 0) {
          ctx.logger.warn('observability flushed with %d dropped records', stats.dropped);
        }
      });
    };
  }, 'supreme-observability.flush');
}

function safeName(info: unknown): string | undefined {
  if (info && typeof info === 'object') {
    const rec = info as Record<string, unknown>;
    if (typeof rec.label === 'string') return rec.label.slice(0, 128);
    if (typeof rec.name === 'string') return rec.name.slice(0, 128);
    if (typeof rec.id === 'string') return rec.id.slice(0, 128);
    if (typeof rec.meta === 'object' && rec.meta !== null) {
      const meta = rec.meta as Record<string, unknown>;
      if (typeof meta.name === 'string') return meta.name.slice(0, 128);
    }
  }
  return undefined;
}

function sessionIdOf(info: unknown): string | undefined {
  if (info && typeof info === 'object') {
    const rec = info as Record<string, unknown>;
    if (typeof rec.sessionId === 'string') return rec.sessionId.slice(0, 128);
    if (typeof rec.parentSessionId === 'string') return rec.parentSessionId.slice(0, 128);
  }
  return undefined;
}
