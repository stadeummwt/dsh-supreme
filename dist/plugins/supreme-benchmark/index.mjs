// dsh-supreme/src/plugins/supreme-benchmark/index.ts
import { z } from "zod";
import { resolve } from "node:path";

// dsh-supreme/src/plugins/supreme-benchmark/engine.ts
var FAILURE_CLASSES = [
  "AUTH",
  "RATE_LIMIT",
  "QUOTA",
  "TIMEOUT",
  "NETWORK",
  "SERVER",
  "INVALID_MODEL",
  "INVALID_SCHEMA",
  "WRONG_TOOL",
  "TOOL_EXECUTION",
  "WRONG_ANSWER",
  "FORMAT",
  "CONTEXT",
  "COST_POLICY",
  "VERIFICATION",
  "UNKNOWN"
];

class BenchmarkValidationError extends Error {
  issues;
  constructor(issues) {
    super(`invalid benchmark record: ${issues.join("; ")}`);
    this.issues = issues;
    this.name = "BenchmarkValidationError";
  }
}
function assertCondition(ok, issues, message) {
  if (!ok)
    issues.push(message);
}
function validateBenchmarkRecord(raw) {
  const issues = [];
  if (!raw || typeof raw !== "object")
    throw new BenchmarkValidationError(["record must be an object"]);
  const rec = raw;
  assertCondition(rec.schemaVersion === 1, issues, "schemaVersion must be 1");
  const kind = rec.kind;
  if (kind === "task") {
    assertCondition(typeof rec.taskId === "string" && rec.taskId.length > 0, issues, "taskId required");
    assertCondition(typeof rec.category === "string", issues, "category required");
    assertCondition(typeof rec.createdAt === "number", issues, "createdAt required");
  } else if (kind === "run") {
    assertCondition(typeof rec.runId === "string" && rec.runId.length > 0, issues, "runId required");
    assertCondition(typeof rec.taskId === "string", issues, "taskId required");
    assertCondition(typeof rec.provider === "string", issues, "provider required");
    assertCondition(typeof rec.model === "string", issues, "model required");
    assertCondition(typeof rec.startedAt === "number", issues, "startedAt required");
    if (rec.qualityScore !== undefined) {
      assertCondition(typeof rec.qualityScore === "number" && rec.qualityScore >= 0 && rec.qualityScore <= 1, issues, "qualityScore must be within [0,1]");
    }
    if (rec.failureClass !== undefined) {
      assertCondition(typeof rec.failureClass === "string" && FAILURE_CLASSES.includes(rec.failureClass), issues, "failureClass must be a known FailureClass");
    }
  } else if (kind === "score") {
    assertCondition(typeof rec.runId === "string", issues, "runId required");
    assertCondition(typeof rec.qualityScore === "number" && rec.qualityScore >= 0 && rec.qualityScore <= 1, issues, "qualityScore must be within [0,1]");
    assertCondition(typeof rec.scoredAt === "number", issues, "scoredAt required");
  } else {
    issues.push("kind must be task|run|score");
  }
  if (issues.length > 0)
    throw new BenchmarkValidationError(issues);
  return raw;
}
function aggregateRuns(runs) {
  const groups = new Map;
  for (const run of runs) {
    if (run.success === undefined)
      continue;
    const key = `${run.provider}::${run.model}`;
    const bucket = groups.get(key);
    if (bucket)
      bucket.push(run);
    else
      groups.set(key, [run]);
  }
  const out = [];
  for (const [key, bucket] of groups) {
    const [provider, model] = key.split("::");
    const finished = bucket.filter((r) => r.finishedAt !== undefined);
    const latencies = finished.map((r) => r.latencyMs).filter((v) => typeof v === "number");
    const qualities = bucket.map((r) => r.qualityScore).filter((v) => typeof v === "number");
    const successes = bucket.filter((r) => r.success === true).length;
    const failureBreakdown = {};
    for (const run of bucket) {
      if (run.success === false && run.failureClass) {
        failureBreakdown[run.failureClass] = (failureBreakdown[run.failureClass] ?? 0) + 1;
      }
    }
    out.push({
      provider,
      model,
      samples: bucket.length,
      successRate: bucket.length > 0 ? successes / bucket.length : 0,
      avgQuality: qualities.length > 0 ? qualities.reduce((a, b) => a + b, 0) / qualities.length : null,
      avgLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      failureBreakdown
    });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

class BenchmarkStore {
  filePath;
  fsImpl;
  tasks = [];
  runs = [];
  scores = [];
  corruptLines = 0;
  queue = Promise.resolve();
  loaded = false;
  constructor(filePath, fsImpl) {
    this.filePath = filePath;
    this.fsImpl = fsImpl;
  }
  async init() {
    if (this.loaded)
      return this.stats();
    this.loaded = true;
    const raw = await this.fsImpl.readFile(this.filePath).catch(() => null);
    if (raw) {
      for (const line of raw.split(`
`)) {
        if (line.length === 0)
          continue;
        try {
          this.indexRecord(validateBenchmarkRecord(JSON.parse(line)));
        } catch {
          this.corruptLines++;
        }
      }
    }
    return this.stats();
  }
  indexRecord(record) {
    if (record.kind === "task") {
      const existing = this.tasks.findIndex((t) => t.taskId === record.taskId);
      if (existing >= 0)
        this.tasks[existing] = record;
      else
        this.tasks.push(record);
    } else if (record.kind === "run") {
      const existing = this.runs.findIndex((r) => r.runId === record.runId);
      if (existing >= 0)
        this.runs[existing] = record;
      else
        this.runs.push(record);
    } else {
      this.scores.push(record);
    }
  }
  async persist(record) {
    this.indexRecord(record);
    const line = JSON.stringify(record) + `
`;
    this.queue = this.queue.then(async () => {
      await this.fsImpl.mkdir(this.dirOf());
      await this.fsImpl.appendFile(this.filePath, line);
    }).catch(() => {
      this.corruptLines += 0;
    });
    return this.queue;
  }
  async recordTask(task) {
    const full = {
      schemaVersion: 1,
      kind: "task",
      taskId: task.taskId,
      category: task.category,
      description: task.description,
      createdAt: task.createdAt ?? Date.now()
    };
    await this.persist(full);
    return full;
  }
  async startRun(input) {
    const run = {
      schemaVersion: 1,
      kind: "run",
      runId: input.runId,
      taskId: input.taskId,
      taskCategory: input.taskCategory,
      provider: input.provider,
      model: input.model,
      profile: input.profile,
      sessionId: input.sessionId,
      startedAt: input.startedAt ?? Date.now()
    };
    await this.persist(run);
    return run;
  }
  async finishRun(runId, outcome) {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run)
      return;
    Object.assign(run, outcome, { finishedAt: outcome.finishedAt ?? Date.now() });
    await this.persist(run);
    return run;
  }
  async recordScore(input) {
    if (input.qualityScore < 0 || input.qualityScore > 1) {
      throw new BenchmarkValidationError(["qualityScore must be within [0,1]"]);
    }
    const score = {
      schemaVersion: 1,
      kind: "score",
      runId: input.runId,
      qualityScore: input.qualityScore,
      validatorId: input.validatorId,
      scoredAt: input.scoredAt ?? Date.now()
    };
    await this.persist(score);
    const run = this.runs.find((r) => r.runId === input.runId);
    if (run)
      run.qualityScore = score.qualityScore;
    return score;
  }
  queryHistory(filter = {}) {
    let out = this.runs.filter((r) => r.finishedAt !== undefined);
    if (filter.provider)
      out = out.filter((r) => r.provider === filter.provider);
    if (filter.model)
      out = out.filter((r) => r.model === filter.model);
    if (filter.taskId)
      out = out.filter((r) => r.taskId === filter.taskId);
    if (filter.success !== undefined)
      out = out.filter((r) => r.success === filter.success);
    out = out.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    return filter.limit ? out.slice(0, filter.limit) : out;
  }
  aggregateModelPerformance() {
    return aggregateRuns(this.runs);
  }
  stats() {
    return {
      tasks: this.tasks.length,
      runs: this.runs.length,
      scores: this.scores.length,
      corruptLines: this.corruptLines
    };
  }
  async flush() {
    await this.queue.catch(() => {
      return;
    });
  }
  dirOf() {
    const idx = this.filePath.lastIndexOf("/");
    return idx > 0 ? this.filePath.slice(0, idx) : ".";
  }
}

// dsh-supreme/src/plugins/supreme-benchmark/index.ts
var name = "supreme-benchmark";
var inject = [];
var Config = z.object({
  dataDir: z.string().default("dsh-supreme/data/benchmark"),
  fileName: z.string().default("benchmark.jsonl")
});
function apply(ctx, config) {
  const fs = process.getBuiltinModule("node:fs").promises;
  const fsImpl = {
    readFile: async (p) => {
      try {
        return await fs.readFile(p, "utf8");
      } catch {
        return null;
      }
    },
    appendFile: (p, line) => fs.appendFile(p, line, "utf8"),
    mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {
      return;
    })
  };
  const store = new BenchmarkStore(resolve(config.dataDir, config.fileName), fsImpl);
  const ready = store.init();
  const service = {
    recordTask: async (task) => {
      await ready;
      const full = await store.recordTask(task);
      return full.taskId;
    },
    startRun: async (input) => {
      await ready;
      const run = await store.startRun({ runId: genId("benchrun"), ...input });
      return run.runId;
    },
    finishRun: async (runId, outcome) => {
      await ready;
      return store.finishRun(runId, {
        ...outcome,
        failureClass: outcome.failureClass,
        verification: outcome.verification
      });
    },
    recordScore: async (input) => {
      await ready;
      await store.recordScore(input);
    },
    queryHistory: (filter) => store.queryHistory(filter),
    aggregateModelPerformance: () => store.aggregateModelPerformance(),
    stats: () => store.stats()
  };
  ctx.provide("supremeBenchmark", Object.freeze(service));
  ctx.effect(() => () => store.flush(), "supreme-benchmark.flush");
  ctx.logger.info("supreme-benchmark store at %s", resolve(config.dataDir, config.fileName));
}
function genId(prefix) {
  const g = globalThis;
  const rand = g.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
export {
  name,
  inject,
  apply,
  Config
};
