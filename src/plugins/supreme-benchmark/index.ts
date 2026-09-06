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
  type BenchmarkFs,
  type BenchmarkRunData,
  type BenchmarkRun,
  type HistoryFilter,
  type ModelPerformance,
} from './engine';

export const name = 'supreme-benchmark';

export const inject: string[] = [];

export const Config = z.object({
  dataDir: z.string().default('dsh-supreme/data/benchmark'),
  fileName: z.string().default('benchmark.jsonl'),
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
};

export function apply(ctx: Context, config: { dataDir: string; fileName: string }): void {
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

  const store = new BenchmarkStore(resolve(config.dataDir, config.fileName), fsImpl);
  const ready = store.init();

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
      return store.finishRun(runId, {
        ...outcome,
        failureClass: outcome.failureClass as BenchmarkRunData['failureClass'],
        verification: outcome.verification as BenchmarkRunData['verification'],
      });
    },
    recordScore: async (input) => {
      await ready;
      await store.recordScore(input);
    },
    queryHistory: (filter) => store.queryHistory(filter),
    aggregateModelPerformance: () => store.aggregateModelPerformance(),
    stats: () => store.stats(),
  };

  ctx.provide('supremeBenchmark', Object.freeze(service));
  ctx.effect(() => () => store.flush(), 'supreme-benchmark.flush');
  ctx.logger.info('supreme-benchmark store at %s', resolve(config.dataDir, config.fileName));
}

function genId(prefix: string): string {
  const g = globalThis as { crypto?: { randomUUID?(): string } };
  const rand = g.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
