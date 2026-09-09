/**
 * @dsh-supreme/benchmark — Cordis adapter (REAL pinned plugin shape).
 *
 * SERVICE = supremeBenchmark
 * INJECTED DSH SERVICES = none.
 *
 * Anti-cycle rule honored (Spec §6): benchmark MUST NOT depend on router.
 * Router consumes benchmark history, never the reverse.
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { resolve } from 'node:path';
import {
  BenchmarkStore,
  CheckpointStore,
  aggregateTaskLatency,
  classSampleRows,
  type BenchmarkFs,
  type BenchmarkRunData,
  type BenchmarkRun,
  type CheckpointRecord,
  type ClassSampleRow,
  type HistoryFilter,
  type ModelPerformance,
  type ResumePlan,
  type TaskLatencyStat,
} from './engine';

export const name = 'supreme-benchmark';

export const inject: string[] = [];

export const Config = z.object({
  dataDir: z.string().default('dsh-supreme/data/benchmark'),
  fileName: z.string().default('benchmark.jsonl'),
  /**
   * v1.3 anti-sandbagging: when true, quality-score claims WITHOUT verifier-PASS
   * evidence are flagged `evidenceBacked: false` and audited (`unscored_evidence`).
   * Default false — behavior-preserving.
   */
  requireEvidenceForScores: z.boolean().default(false),
  /**
   * v1.3.1 (IMP-R §5): recovery checkpoints — an append-only checkpoints.jsonl
   * in the dataDir this plugin ALREADY owns (same BenchmarkFs seam). Bounds:
   * in-memory store capped at `maxEntries` records (oldest evicted, disk stays
   * append-only; reload keeps the most recent tail), ≤16 artifact refs and
   * ≤16 {ref, hash} pairs per record. No file is written until a host calls
   * checkpoint() — default behavior is unchanged.
   */
  checkpoints: z
    .object({
      fileName: z.string().default('checkpoints.jsonl'),
      maxEntries: z.number().int().min(16).max(65_536).default(1024),
    })
    .default({ fileName: 'checkpoints.jsonl', maxEntries: 1024 }),
});

export type BenchmarkService = {
  recordTask(task: { taskId: string; category: string; description?: string }): Promise<string>;
  startRun(input: {
    taskId: string;
    taskCategory: string;
    provider: string;
    model: string;
    profile: string;
    sessionId?: string;
    /** v1.2: 40-hex upstream sha or UNAVAILABLE — bound the run to its provenance. */
    commitHash?: string;
    /** v1.2: task IR version bound to this run. */
    irVersion?: string;
  }): Promise<string>;
  finishRun(
    runId: string,
    outcome: {
      success: boolean;
      latencyMs?: number;
      ttftMs?: number;
      usageIn?: number;
      usageOut?: number;
      toolCount?: number;
      subagentCount?: number;
      workflowCount?: number;
      failureClass?: string;
      verification?: { validatorId: string; status: string; reasonCode?: string };
    },
  ): Promise<BenchmarkRun | undefined>;
  recordScore(input: { runId: string; qualityScore: number; validatorId?: string }): Promise<void>;
  queryHistory(filter?: HistoryFilter): BenchmarkRun[];
  aggregateModelPerformance(): ModelPerformance[];
  stats(): { tasks: number; runs: number; scores: number; corruptLines: number };
  /**
   * v1.3.1 (IMP-R §1): per-task-class outcome sample rows (most-recent-first,
   * bounded) built from REAL finished runs — the router's class-aware scoring
   * input (ids/labels/booleans/timestamps only).
   */
  classSamples(limit?: number): ClassSampleRow[];
  /**
   * v1.3.1 (IMP-R §6): end-to-end task latency per task category
   * (durations only) over finished runs.
   */
  taskLatency(): TaskLatencyStat[];
  /**
   * v1.3.1 (IMP-R §5): append one recovery checkpoint — {taskId, step,
   * artifact refs + hashes, sideEffectsRegistered, status}. Ids/digests only;
   * never artifact content. Audited through the observability record() path.
   */
  checkpoint(input: {
    taskId: string;
    step: number;
    artifactRefs?: string[];
    artifactHashes?: Array<{ ref: string; hash: string }>;
    sideEffectsRegistered?: boolean;
    status?: 'active' | 'completed' | 'interrupted';
  }): Promise<CheckpointRecord>;
  /**
   * v1.3.1 (IMP-R §5): PURE resume plan from the REAL current store state.
   * When `currentArtifactHashes` is supplied, every recorded hash is
   * re-checked against it — a completed step whose artifact hash no longer
   * matches is NOT reported resumable (hashCheck 'mismatch'); completed side
   * effects are NEVER auto-repeated (resumeActions excludes them and
   * assertNoRepeatedSideEffects throws on any attempt).
   */
  resumeCheckpoint(taskId: string, currentArtifactHashes?: Record<string, string>): Promise<ResumePlan>;
  /** v1.3.1 (IMP-R §5): bounded checkpoint store stats. */
  checkpointStats(): { checkpoints: number; corruptLines: number };
};

export function apply(ctx: Context, config: { dataDir: string; fileName: string; requireEvidenceForScores: boolean; checkpoints: { fileName: string; maxEntries: number } }): void {
  const fs = process.getBuiltinModule('node:fs').promises;
  const fsImpl: BenchmarkFs = {
    readFile: async (p) => {
      try {
        return await fs.readFile(p, 'utf8');
      } catch {
        return null;
      }
    },
    appendFile: (p, line) => fs.appendFile(p, line, 'utf8'),
    mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => undefined),
  };

  const store = new BenchmarkStore(resolve(config.dataDir, config.fileName), fsImpl, {
    requireEvidenceForScores: config.requireEvidenceForScores,
  });
  const ready = store.init();

  // v1.3.1 (IMP-R §5): recovery checkpoints live in the dataDir this plugin
  // already owns, written through the SAME fs seam — no second storage stack.
  const checkpointStore = new CheckpointStore(resolve(config.dataDir, config.checkpoints.fileName), fsImpl, {
    maxEntries: config.checkpoints.maxEntries,
  });
  const checkpointsReady = checkpointStore.init();
  const observability = () =>
    ctx.get('supremeObservability') as { record(event: string, fields: Record<string, unknown>): void } | undefined;

  const service: BenchmarkService = {
    recordTask: async (task) => {
      await ready;
      const full = await store.recordTask(task);
      return full.taskId;
    },
    startRun: async (input) => {
      await ready;
      const run = await store.startRun({ runId: genId('benchrun'), ...input });
      return run.runId;
    },
    finishRun: async (runId, outcome) => {
      await ready;
      const run = await store.finishRun(runId, {
        ...outcome,
        failureClass: outcome.failureClass as BenchmarkRunData['failureClass'],
        verification: outcome.verification as BenchmarkRunData['verification'],
      });
      // v1.3.1 (IMP-R §6): END-TO-END task latency timing event through the
      // observability record() path — DURATIONS ONLY (the run's own latencyMs
      // when recorded, else finishedAt − startedAt), plus the run id and the
      // task-class label. Never content, never payloads.
      if (run && run.finishedAt !== undefined) {
        const duration =
          typeof run.latencyMs === 'number' && run.latencyMs >= 0
            ? run.latencyMs
            : run.finishedAt - run.startedAt;
        if (Number.isFinite(duration) && duration >= 0) {
          observability()?.record('task_latency', {
            benchmarkRunId: run.runId,
            latencyMs: duration,
            detail: `task:${run.taskCategory}`.slice(0, 256),
          });
        }
      }
      return run;
    },
    recordScore: async (input) => {
      await ready;
      const score = await store.recordScore(input);
      // v1.3 anti-sandbagging audit: record id + reason label ONLY — never the
      // score value. Optional seam: ctx.get() requires no inject declaration
      // (same idiom as the verifier) and the plugin stays dependency-free.
      if (score.evidenceBacked === false) {
        ctx.get('supremeObservability')?.record('unscored_evidence', {
          recordId: score.runId,
          kind: 'score',
          reason: 'score_without_verifier_pass',
        });
      }
    },
    queryHistory: (filter) => store.queryHistory(filter),
    aggregateModelPerformance: () => store.aggregateModelPerformance(),
    stats: () => store.stats(),
    // v1.3.1 (IMP-R §1): bounded most-recent-first class sample rows for the
    // router's class-aware scoring (finished runs only, ids/labels/booleans).
    classSamples: (limit) => classSampleRows(store.queryHistory(), limit),
    // v1.3.1 (IMP-R §6): durations-only latency aggregate over finished runs.
    taskLatency: () => aggregateTaskLatency(store.queryHistory()),
    // v1.3.1 (IMP-R §5): checkpoint append (validated + bounded) + audit.
    checkpoint: async (input) => {
      await checkpointsReady;
      const record = await checkpointStore.record({
        taskId: input.taskId,
        stepIndex: input.step,
        artifactRefs: input.artifactRefs,
        artifactHashes: input.artifactHashes,
        sideEffectsRegistered: input.sideEffectsRegistered,
        status: input.status,
      });
      observability()?.record('checkpoint_recorded', {
        detail: `task:${input.taskId}:step:${input.step}:${record.status}:effects:${record.sideEffectsRegistered === true ? 'registered' : 'none'}`.slice(0, 256),
      });
      return record;
    },
    // v1.3.1 (IMP-R §5): PURE resume read of the REAL current store state;
    // optional caller-measured artifact digests re-check recorded hashes.
    resumeCheckpoint: async (taskId, currentArtifactHashes) => {
      await checkpointsReady;
      const plan = checkpointStore.resume(taskId, currentArtifactHashes);
      observability()?.record('checkpoint_resumed', {
        detail: `task:${plan.taskId}:steps:${plan.steps.length}:completed:${plan.completedCount}:redo:${plan.redoCount}`.slice(0, 256),
      });
      return plan;
    },
    checkpointStats: () => checkpointStore.stats(),
  };

  ctx.provide('supremeBenchmark', Object.freeze(service));
  ctx.effect(() => () => Promise.all([store.flush(), checkpointStore.flush()]), 'supreme-benchmark.flush');
  ctx.logger.info('supreme-benchmark store at %s', resolve(config.dataDir, config.fileName));
}

function genId(prefix: string): string {
  const g = globalThis as { crypto?: { randomUUID?(): string } };
  const rand = g.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
