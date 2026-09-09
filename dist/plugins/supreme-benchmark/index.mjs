// src/plugins/supreme-benchmark/index.ts
import { z } from "zod";
import { resolve } from "node:path";

// src/plugins/supreme-benchmark/engine.ts
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
function isVerifierPassEvidence(verification) {
  return verification?.status === "PASS";
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
    if (rec.commitHash !== undefined) {
      assertCondition(rec.commitHash === "UNAVAILABLE" || typeof rec.commitHash === "string" && /^[a-f0-9]{40}$/.test(rec.commitHash), issues, "commitHash must be a 40-hex sha or UNAVAILABLE");
    }
    if (rec.irVersion !== undefined) {
      assertCondition(typeof rec.irVersion === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(rec.irVersion), issues, "irVersion must match [A-Za-z0-9._-]{1,32}");
    }
    if (rec.qualityScore !== undefined) {
      assertCondition(typeof rec.qualityScore === "number" && rec.qualityScore >= 0 && rec.qualityScore <= 1, issues, "qualityScore must be within [0,1]");
    }
    if (rec.failureClass !== undefined) {
      assertCondition(typeof rec.failureClass === "string" && FAILURE_CLASSES.includes(rec.failureClass), issues, "failureClass must be a known FailureClass");
    }
    if (rec.evidenceBacked !== undefined) {
      assertCondition(typeof rec.evidenceBacked === "boolean", issues, "evidenceBacked must be a boolean");
    }
  } else if (kind === "score") {
    assertCondition(typeof rec.runId === "string", issues, "runId required");
    assertCondition(typeof rec.qualityScore === "number" && rec.qualityScore >= 0 && rec.qualityScore <= 1, issues, "qualityScore must be within [0,1]");
    assertCondition(typeof rec.scoredAt === "number", issues, "scoredAt required");
    if (rec.evidenceBacked !== undefined) {
      assertCondition(typeof rec.evidenceBacked === "boolean", issues, "evidenceBacked must be a boolean");
    }
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
    const scoredRuns = bucket.filter((r) => typeof r.qualityScore === "number");
    const evidenceBackedScores = scoredRuns.filter((r) => r.evidenceBacked === true).length;
    out.push({
      provider,
      model,
      samples: bucket.length,
      successRate: bucket.length > 0 ? successes / bucket.length : 0,
      avgQuality: qualities.length > 0 ? qualities.reduce((a, b) => a + b, 0) / qualities.length : null,
      avgLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      failureBreakdown,
      scoredSamples: scoredRuns.length,
      evidenceBackedScores
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
  requireEvidenceForScores;
  constructor(filePath, fsImpl, options = {}) {
    this.filePath = filePath;
    this.fsImpl = fsImpl;
    this.requireEvidenceForScores = options.requireEvidenceForScores === true;
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
      commitHash: input.commitHash,
      irVersion: input.irVersion,
      startedAt: input.startedAt ?? Date.now()
    };
    validateBenchmarkRecord(run);
    await this.persist(run);
    return run;
  }
  async finishRun(runId, outcome) {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run)
      return;
    Object.assign(run, outcome, { finishedAt: outcome.finishedAt ?? Date.now() });
    if (this.requireEvidenceForScores && typeof run.qualityScore === "number") {
      run.evidenceBacked = isVerifierPassEvidence(run.verification);
    }
    await this.persist(run);
    return run;
  }
  async recordScore(input) {
    if (input.qualityScore < 0 || input.qualityScore > 1) {
      throw new BenchmarkValidationError(["qualityScore must be within [0,1]"]);
    }
    const run = this.runs.find((r) => r.runId === input.runId);
    const evidenceBacked = this.requireEvidenceForScores ? isVerifierPassEvidence(run?.verification) : undefined;
    const score = {
      schemaVersion: 1,
      kind: "score",
      runId: input.runId,
      qualityScore: input.qualityScore,
      validatorId: input.validatorId,
      scoredAt: input.scoredAt ?? Date.now(),
      ...evidenceBacked !== undefined ? { evidenceBacked } : {}
    };
    await this.persist(score);
    if (run) {
      run.qualityScore = score.qualityScore;
      if (evidenceBacked !== undefined)
        run.evidenceBacked = evidenceBacked;
    }
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
    const idx = Math.max(this.filePath.lastIndexOf("/"), this.filePath.lastIndexOf("\\"));
    return idx > 0 ? this.filePath.slice(0, idx) : ".";
  }
}
function classSampleRows(runs, limit = 512) {
  const bounded = Math.max(1, Math.min(4096, Math.floor(limit)));
  return runs.filter((r) => r.finishedAt !== undefined && typeof r.taskCategory === "string" && r.taskCategory.length > 0 && typeof r.success === "boolean").sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt)).slice(0, bounded).map((r) => ({
    provider: r.provider,
    model: r.model,
    taskClass: r.taskCategory,
    success: r.success === true,
    at: r.finishedAt ?? r.startedAt
  }));
}
function aggregateTaskLatency(runs) {
  const groups = new Map;
  for (const run of runs) {
    if (run.finishedAt === undefined)
      continue;
    const duration = typeof run.latencyMs === "number" && run.latencyMs >= 0 ? run.latencyMs : run.finishedAt - run.startedAt;
    if (!Number.isFinite(duration) || duration < 0)
      continue;
    const category = typeof run.taskCategory === "string" && run.taskCategory.length > 0 ? run.taskCategory : "UNCLASSIFIED";
    const bucket = groups.get(category);
    if (bucket)
      bucket.push(duration);
    else
      groups.set(category, [duration]);
  }
  const out = [];
  for (const [taskCategory, durations] of groups) {
    const sorted = [...durations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    out.push({
      taskCategory,
      samples: sorted.length,
      avgLatencyMs: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
      medianLatencyMs: median,
      maxLatencyMs: sorted[sorted.length - 1]
    });
  }
  return out.sort((a, b) => a.taskCategory.localeCompare(b.taskCategory));
}
var CHECKPOINT_STATUSES = ["active", "completed", "interrupted"];

class CheckpointValidationError extends Error {
  issues;
  constructor(issues) {
    super(`invalid checkpoint record: ${issues.join("; ")}`);
    this.issues = issues;
    this.name = "CheckpointValidationError";
  }
}
var ARTIFACT_HASH_PATTERN = /^[A-Za-z0-9._:/+-]{1,128}$/;
function validateCheckpointRecord(raw) {
  const issues = [];
  if (!raw || typeof raw !== "object")
    throw new CheckpointValidationError(["record must be an object"]);
  const rec = raw;
  assertCondition(rec.schemaVersion === 1, issues, "schemaVersion must be 1");
  assertCondition(rec.kind === "checkpoint", issues, "kind must be checkpoint");
  assertCondition(typeof rec.taskId === "string" && rec.taskId.length > 0 && rec.taskId.length <= 128, issues, "taskId must be 1..128 chars");
  assertCondition(typeof rec.stepIndex === "number" && Number.isInteger(rec.stepIndex) && rec.stepIndex >= 0, issues, "stepIndex must be an integer >= 0");
  if (!Array.isArray(rec.artifactRefs) || rec.artifactRefs.length > 16) {
    issues.push("artifactRefs must be an array of at most 16 strings");
  } else {
    for (const ref of rec.artifactRefs) {
      assertCondition(typeof ref === "string" && ref.length > 0 && ref.length <= 128, issues, "each artifactRef must be 1..128 chars");
    }
  }
  if (rec.artifactHashes !== undefined) {
    if (!Array.isArray(rec.artifactHashes) || rec.artifactHashes.length > 16) {
      issues.push("artifactHashes must be an array of at most 16 {ref, hash} pairs");
    } else {
      for (const pair of rec.artifactHashes) {
        const p = pair;
        assertCondition(!!p && typeof p.ref === "string" && p.ref.length > 0 && p.ref.length <= 128 && typeof p.hash === "string" && ARTIFACT_HASH_PATTERN.test(p.hash), issues, "each artifactHash must be {ref: 1..128 chars, hash: bounded token}");
      }
    }
  }
  if (rec.sideEffectsRegistered !== undefined) {
    assertCondition(typeof rec.sideEffectsRegistered === "boolean", issues, "sideEffectsRegistered must be a boolean");
  }
  assertCondition(typeof rec.status === "string" && CHECKPOINT_STATUSES.includes(rec.status), issues, "status must be active|completed|interrupted");
  assertCondition(typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt), issues, "updatedAt must be a finite number");
  if (issues.length > 0)
    throw new CheckpointValidationError(issues);
  return raw;
}
function checkArtifactHashes(recorded, current) {
  if (current === undefined || recorded === undefined || recorded.length === 0)
    return "unverified";
  for (const pair of recorded) {
    const now = current[pair.ref];
    if (now === undefined || now !== pair.hash)
      return "mismatch";
  }
  return "verified";
}
function planResumeFromRecords(taskId, records, currentArtifactHashes) {
  const latest = new Map;
  for (const rec of records) {
    if (rec.taskId !== taskId)
      continue;
    const prev = latest.get(rec.stepIndex);
    if (prev === undefined || rec.updatedAt >= prev.updatedAt)
      latest.set(rec.stepIndex, rec);
  }
  const steps = [...latest.entries()].sort((a, b) => a[0] - b[0]).map(([stepIndex, rec]) => {
    const hashCheck = checkArtifactHashes(rec.artifactHashes, currentArtifactHashes);
    return {
      stepIndex,
      status: rec.status,
      redo: rec.status !== "completed" || hashCheck === "mismatch",
      artifactRefs: [...rec.artifactRefs],
      updatedAt: rec.updatedAt,
      ...rec.sideEffectsRegistered !== undefined ? { sideEffectsRegistered: rec.sideEffectsRegistered } : {},
      ...rec.artifactHashes !== undefined ? { artifactHashes: rec.artifactHashes.map((p) => ({ ...p })) } : {},
      ...currentArtifactHashes !== undefined || rec.artifactHashes !== undefined ? { hashCheck } : {}
    };
  });
  return {
    taskId,
    steps,
    completedCount: steps.filter((s) => s.status === "completed").length,
    redoCount: steps.filter((s) => s.redo).length
  };
}
class CheckpointStore {
  filePath;
  fsImpl;
  records = [];
  corruptLines = 0;
  queue = Promise.resolve();
  loaded = false;
  maxEntries;
  constructor(filePath, fsImpl, opts = {}) {
    this.filePath = filePath;
    this.fsImpl = fsImpl;
    const cap = opts.maxEntries ?? 1024;
    this.maxEntries = Number.isFinite(cap) ? Math.max(16, Math.min(65536, Math.floor(cap))) : 1024;
  }
  async init() {
    if (this.loaded)
      return this.stats();
    this.loaded = true;
    const raw = await this.fsImpl.readFile(this.filePath).catch(() => null);
    if (raw) {
      const parsed = [];
      for (const line of raw.split(`
`)) {
        if (line.length === 0)
          continue;
        try {
          parsed.push(validateCheckpointRecord(JSON.parse(line)));
        } catch {
          this.corruptLines++;
        }
      }
      this.records.push(...parsed.slice(-this.maxEntries));
    }
    return this.stats();
  }
  async persist(record) {
    this.records.push(record);
    if (this.records.length > this.maxEntries) {
      this.records.shift();
    }
    const line = JSON.stringify(record) + `
`;
    this.queue = this.queue.then(async () => {
      await this.fsImpl.mkdir(this.dirOf());
      await this.fsImpl.appendFile(this.filePath, line);
    }).catch(() => {});
    return this.queue;
  }
  async record(input) {
    const full = {
      schemaVersion: 1,
      kind: "checkpoint",
      taskId: input.taskId,
      stepIndex: input.stepIndex,
      artifactRefs: [...input.artifactRefs ?? []],
      ...input.artifactHashes !== undefined ? { artifactHashes: input.artifactHashes.map((p) => ({ ref: p.ref, hash: p.hash })) } : {},
      ...input.sideEffectsRegistered !== undefined ? { sideEffectsRegistered: input.sideEffectsRegistered === true } : {},
      status: input.status ?? "active",
      updatedAt: input.updatedAt ?? Date.now()
    };
    validateCheckpointRecord(full);
    await this.persist(full);
    return full;
  }
  recordsFor(taskId) {
    return this.records.filter((r) => r.taskId === taskId);
  }
  resumePlan(taskId) {
    return planResumeFromRecords(taskId, this.records);
  }
  resume(taskId, currentArtifactHashes) {
    return planResumeFromRecords(taskId, this.records, currentArtifactHashes);
  }
  stats() {
    return { checkpoints: this.records.length, corruptLines: this.corruptLines };
  }
  async flush() {
    await this.queue.catch(() => {
      return;
    });
  }
  dirOf() {
    const idx = Math.max(this.filePath.lastIndexOf("/"), this.filePath.lastIndexOf("\\"));
    return idx > 0 ? this.filePath.slice(0, idx) : ".";
  }
}

// src/plugins/supreme-benchmark/index.ts
var name = "supreme-benchmark";
var inject = [];
var Config = z.object({
  dataDir: z.string().default("dsh-supreme/data/benchmark"),
  fileName: z.string().default("benchmark.jsonl"),
  requireEvidenceForScores: z.boolean().default(false),
  checkpoints: z.object({
    fileName: z.string().default("checkpoints.jsonl"),
    maxEntries: z.number().int().min(16).max(65536).default(1024)
  }).default({ fileName: "checkpoints.jsonl", maxEntries: 1024 })
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
  const store = new BenchmarkStore(resolve(config.dataDir, config.fileName), fsImpl, {
    requireEvidenceForScores: config.requireEvidenceForScores
  });
  const ready = store.init();
  const checkpointStore = new CheckpointStore(resolve(config.dataDir, config.checkpoints.fileName), fsImpl, {
    maxEntries: config.checkpoints.maxEntries
  });
  const checkpointsReady = checkpointStore.init();
  const observability = () => ctx.get("supremeObservability");
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
      const run = await store.finishRun(runId, {
        ...outcome,
        failureClass: outcome.failureClass,
        verification: outcome.verification
      });
      if (run && run.finishedAt !== undefined) {
        const duration = typeof run.latencyMs === "number" && run.latencyMs >= 0 ? run.latencyMs : run.finishedAt - run.startedAt;
        if (Number.isFinite(duration) && duration >= 0) {
          observability()?.record("task_latency", {
            benchmarkRunId: run.runId,
            latencyMs: duration,
            detail: `task:${run.taskCategory}`.slice(0, 256)
          });
        }
      }
      return run;
    },
    recordScore: async (input) => {
      await ready;
      const score = await store.recordScore(input);
      if (score.evidenceBacked === false) {
        ctx.get("supremeObservability")?.record("unscored_evidence", {
          recordId: score.runId,
          kind: "score",
          reason: "score_without_verifier_pass"
        });
      }
    },
    queryHistory: (filter) => store.queryHistory(filter),
    aggregateModelPerformance: () => store.aggregateModelPerformance(),
    stats: () => store.stats(),
    classSamples: (limit) => classSampleRows(store.queryHistory(), limit),
    taskLatency: () => aggregateTaskLatency(store.queryHistory()),
    checkpoint: async (input) => {
      await checkpointsReady;
      const record = await checkpointStore.record({
        taskId: input.taskId,
        stepIndex: input.step,
        artifactRefs: input.artifactRefs,
        artifactHashes: input.artifactHashes,
        sideEffectsRegistered: input.sideEffectsRegistered,
        status: input.status
      });
      observability()?.record("checkpoint_recorded", {
        detail: `task:${input.taskId}:step:${input.step}:${record.status}:effects:${record.sideEffectsRegistered === true ? "registered" : "none"}`.slice(0, 256)
      });
      return record;
    },
    resumeCheckpoint: async (taskId, currentArtifactHashes) => {
      await checkpointsReady;
      const plan = checkpointStore.resume(taskId, currentArtifactHashes);
      observability()?.record("checkpoint_resumed", {
        detail: `task:${plan.taskId}:steps:${plan.steps.length}:completed:${plan.completedCount}:redo:${plan.redoCount}`.slice(0, 256)
      });
      return plan;
    },
    checkpointStats: () => checkpointStore.stats()
  };
  ctx.provide("supremeBenchmark", Object.freeze(service));
  ctx.effect(() => () => Promise.all([store.flush(), checkpointStore.flush()]), "supreme-benchmark.flush");
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
