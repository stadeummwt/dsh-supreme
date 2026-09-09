/**
 * @dsh-supreme/benchmark — canonical types + JSONL storage engine.
 *
 * Records reproducible end-to-end task performance as ROUTING EVIDENCE
 * (Spec §10 original — not model training). Pure framework-free engine;
 * the Cordis adapter lives in ./index.ts.
 *
 * Storage preference order honored (Spec §10): simple portable storage first
 * (append-only JSONL + in-process aggregation). The store interface is
 * abstract enough that a backend migration does not affect router logic.
 */

export const FAILURE_CLASSES = [
  'AUTH',
  'RATE_LIMIT',
  'QUOTA',
  'TIMEOUT',
  'NETWORK',
  'SERVER',
  'INVALID_MODEL',
  'INVALID_SCHEMA',
  'WRONG_TOOL',
  'TOOL_EXECUTION',
  'WRONG_ANSWER',
  'FORMAT',
  'CONTEXT',
  'COST_POLICY',
  'VERIFICATION',
  'UNKNOWN',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type ValidatorStatus = 'PASS' | 'FAIL' | 'ERROR' | 'UNAVAILABLE';

export interface ValidatorResult {
  validatorId: string;
  status: ValidatorStatus;
  reasonCode?: string;
}

export interface BenchmarkTaskData {
  taskId: string;
  category: string;
  description?: string;
  createdAt: number;
}

export interface BenchmarkTask extends BenchmarkTaskData {
  schemaVersion: 1;
  kind: 'task';
}

export interface BenchmarkRunData {
  runId: string;
  taskId: string;
  taskCategory: string;
  /** DSH session reference — the session log stays canonical. */
  sessionId?: string;
  provider: string;
  model: string;
  profile: string;
  /** v1.2: upstream/IR provenance — 40-hex commit sha or UNAVAILABLE. */
  commitHash?: string;
  /** v1.2: task IR version bound to this run (bounded identifier). */
  irVersion?: string;
  startedAt: number;
  finishedAt?: number;
  latencyMs?: number;
  ttftMs?: number;
  usageIn?: number;
  usageOut?: number;
  toolCount?: number;
  subagentCount?: number;
  workflowCount?: number;
  success?: boolean;
  qualityScore?: number;
  failureClass?: FailureClass;
  verification?: ValidatorResult;
  /**
   * v1.3 anti-sandbagging: present ONLY when requireEvidenceForScores is
   * enabled — true iff the quality claim on this run is backed by
   * verifier-PASS evidence (evidence > self-confidence).
   */
  evidenceBacked?: boolean;
}

export interface BenchmarkRun extends BenchmarkRunData {
  schemaVersion: 1;
  kind: 'run';
}

export interface BenchmarkScore {
  schemaVersion: 1;
  kind: 'score';
  runId: string;
  qualityScore: number;
  validatorId?: string;
  scoredAt: number;
  /** v1.3 anti-sandbagging: present ONLY when requireEvidenceForScores is enabled. */
  evidenceBacked?: boolean;
}

export type BenchmarkRecord =
  | ({ schemaVersion: 1; kind: 'task' } & BenchmarkTask)
  | ({ schemaVersion: 1; kind: 'run' } & BenchmarkRun)
  | BenchmarkScore;

export interface HistoryFilter {
  provider?: string;
  model?: string;
  taskId?: string;
  success?: boolean;
  limit?: number;
}

export interface ModelPerformance {
  provider: string;
  model: string;
  samples: number;
  successRate: number;
  avgQuality: number | null;
  avgLatencyMs: number | null;
  failureBreakdown: Partial<Record<FailureClass, number>>;
  /** v1.3 anti-sandbagging: samples carrying a qualityScore claim. */
  scoredSamples: number;
  /** v1.3 anti-sandbagging: of those, claims backed by verifier-PASS evidence. */
  evidenceBackedScores: number;
}

export interface BenchmarkStats {
  tasks: number;
  runs: number;
  scores: number;
  corruptLines: number;
}

export class BenchmarkValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid benchmark record: ${issues.join('; ')}`);
    this.name = 'BenchmarkValidationError';
  }
}

/**
 * v1.3 anti-sandbagging — deterministic evidence rule: a score claim counts as
 * evidence-backed ONLY when the scored run carries a verifier-PASS result.
 * Never ML, never heuristic: evidence > self-confidence.
 */
export function isVerifierPassEvidence(verification: ValidatorResult | undefined): boolean {
  return verification?.status === 'PASS';
}

function assertCondition(ok: boolean, issues: string[], message: string): void {
  if (!ok) issues.push(message);
}

/** Deterministic record validation (bounded, secret-free by construction). */
export function validateBenchmarkRecord(raw: unknown): BenchmarkRecord {
  const issues: string[] = [];
  if (!raw || typeof raw !== 'object') throw new BenchmarkValidationError(['record must be an object']);
  const rec = raw as Record<string, unknown>;
  assertCondition(rec.schemaVersion === 1, issues, 'schemaVersion must be 1');
  const kind = rec.kind;
  if (kind === 'task') {
    assertCondition(typeof rec.taskId === 'string' && rec.taskId.length > 0, issues, 'taskId required');
    assertCondition(typeof rec.category === 'string', issues, 'category required');
    assertCondition(typeof rec.createdAt === 'number', issues, 'createdAt required');
  } else if (kind === 'run') {
    assertCondition(typeof rec.runId === 'string' && rec.runId.length > 0, issues, 'runId required');
    assertCondition(typeof rec.taskId === 'string', issues, 'taskId required');
    assertCondition(typeof rec.provider === 'string', issues, 'provider required');
    assertCondition(typeof rec.model === 'string', issues, 'model required');
    assertCondition(typeof rec.startedAt === 'number', issues, 'startedAt required');
    if (rec.commitHash !== undefined) {
      assertCondition(
        rec.commitHash === 'UNAVAILABLE' || (typeof rec.commitHash === 'string' && /^[a-f0-9]{40}$/.test(rec.commitHash)),
        issues,
        'commitHash must be a 40-hex sha or UNAVAILABLE',
      );
    }
    if (rec.irVersion !== undefined) {
      assertCondition(
        typeof rec.irVersion === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(rec.irVersion),
        issues,
        'irVersion must match [A-Za-z0-9._-]{1,32}',
      );
    }
    if (rec.qualityScore !== undefined) {
      assertCondition(
        typeof rec.qualityScore === 'number' && rec.qualityScore >= 0 && rec.qualityScore <= 1,
        issues,
        'qualityScore must be within [0,1]',
      );
    }
    if (rec.failureClass !== undefined) {
      assertCondition(
        typeof rec.failureClass === 'string' && (FAILURE_CLASSES as readonly string[]).includes(rec.failureClass),
        issues,
        'failureClass must be a known FailureClass',
      );
    }
    if (rec.evidenceBacked !== undefined) {
      assertCondition(typeof rec.evidenceBacked === 'boolean', issues, 'evidenceBacked must be a boolean');
    }
  } else if (kind === 'score') {
    assertCondition(typeof rec.runId === 'string', issues, 'runId required');
    assertCondition(
      typeof rec.qualityScore === 'number' && rec.qualityScore >= 0 && rec.qualityScore <= 1,
      issues,
      'qualityScore must be within [0,1]',
    );
    assertCondition(typeof rec.scoredAt === 'number', issues, 'scoredAt required');
    if (rec.evidenceBacked !== undefined) {
      assertCondition(typeof rec.evidenceBacked === 'boolean', issues, 'evidenceBacked must be a boolean');
    }
  } else {
    issues.push('kind must be task|run|score');
  }
  if (issues.length > 0) throw new BenchmarkValidationError(issues);
  return raw as BenchmarkRecord;
}

/** Aggregation over finished runs (group by provider+model). */
export function aggregateRuns(runs: BenchmarkRun[]): ModelPerformance[] {
  const groups = new Map<string, BenchmarkRun[]>();
  for (const run of runs) {
    if (run.success === undefined) continue;
    const key = `${run.provider}::${run.model}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(run);
    else groups.set(key, [run]);
  }
  const out: ModelPerformance[] = [];
  for (const [key, bucket] of groups) {
    const [provider, model] = key.split('::');
    const finished = bucket.filter((r) => r.finishedAt !== undefined);
    const latencies = finished
      .map((r) => r.latencyMs)
      .filter((v): v is number => typeof v === 'number');
    const qualities = bucket
      .map((r) => r.qualityScore)
      .filter((v): v is number => typeof v === 'number');
    const successes = bucket.filter((r) => r.success === true).length;
    const failureBreakdown: Partial<Record<FailureClass, number>> = {};
    for (const run of bucket) {
      if (run.success === false && run.failureClass) {
        failureBreakdown[run.failureClass] = (failureBreakdown[run.failureClass] ?? 0) + 1;
      }
    }
    // v1.3 anti-sandbagging counts: claims vs verifier-PASS-backed claims.
    const scoredRuns = bucket.filter((r) => typeof r.qualityScore === 'number');
    const evidenceBackedScores = scoredRuns.filter((r) => r.evidenceBacked === true).length;
    out.push({
      provider,
      model,
      samples: bucket.length,
      successRate: bucket.length > 0 ? successes / bucket.length : 0,
      avgQuality: qualities.length > 0 ? qualities.reduce((a, b) => a + b, 0) / qualities.length : null,
      avgLatencyMs:
        latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      failureBreakdown,
      scoredSamples: scoredRuns.length,
      evidenceBackedScores,
    });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

/** Minimal fs seam so the engine is testable without the real fs. */
export interface BenchmarkFs {
  readFile(path: string): Promise<string | null>;
  appendFile(path: string, line: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

/** v1.3 anti-sandbagging store options (all optional → v1.2 constructions keep working). */
export interface BenchmarkStoreOptions {
  /**
   * When true, every quality-score claim without verifier-PASS evidence is
   * flagged `evidenceBacked: false` on the score record and its run.
   * Default false — behavior-preserving.
   */
  requireEvidenceForScores?: boolean;
}

export class BenchmarkStore {
  private tasks: BenchmarkTask[] = [];
  private runs: BenchmarkRun[] = [];
  private scores: BenchmarkScore[] = [];
  private corruptLines = 0;
  private queue: Promise<void> = Promise.resolve();
  private loaded = false;
  private readonly requireEvidenceForScores: boolean;

  constructor(
    private readonly filePath: string,
    private readonly fsImpl: BenchmarkFs,
    options: BenchmarkStoreOptions = {},
  ) {
    this.requireEvidenceForScores = options.requireEvidenceForScores === true;
  }

  /** Load history once; corrupt lines are skipped and counted, never fatal. */
  async init(): Promise<BenchmarkStats> {
    if (this.loaded) return this.stats();
    this.loaded = true;
    const raw = await this.fsImpl.readFile(this.filePath).catch(() => null);
    if (raw) {
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue;
        try {
          this.indexRecord(validateBenchmarkRecord(JSON.parse(line)));
        } catch {
          this.corruptLines++;
        }
      }
    }
    return this.stats();
  }

  private indexRecord(record: BenchmarkRecord): void {
    if (record.kind === 'task') {
      // Last write wins per taskId (append-only log replays updates).
      const existing = this.tasks.findIndex((t) => t.taskId === record.taskId);
      if (existing >= 0) this.tasks[existing] = record;
      else this.tasks.push(record);
    } else if (record.kind === 'run') {
      const existing = this.runs.findIndex((r) => r.runId === record.runId);
      if (existing >= 0) this.runs[existing] = record;
      else this.runs.push(record);
    } else {
      this.scores.push(record);
    }
  }

  private async persist(record: BenchmarkRecord): Promise<void> {
    this.indexRecord(record);
    const line = JSON.stringify(record) + '\n';
    this.queue = this.queue
      .then(async () => {
        await this.fsImpl.mkdir(this.dirOf());
        await this.fsImpl.appendFile(this.filePath, line);
      })
      .catch(() => {
        // Fail open: in-memory evidence retained, disk write dropped.
        this.corruptLines += 0; // writer failures do not corrupt reads
      });
    return this.queue;
  }

  async recordTask(
    task: { taskId: string; category: string; description?: string; createdAt?: number },
  ): Promise<BenchmarkTask> {
    const full: BenchmarkTask = {
      schemaVersion: 1,
      kind: 'task',
      taskId: task.taskId,
      category: task.category,
      description: task.description,
      createdAt: task.createdAt ?? Date.now(),
    };
    await this.persist(full);
    return full;
  }

  async startRun(input: {
    runId: string;
    taskId: string;
    taskCategory: string;
    provider: string;
    model: string;
    profile: string;
    sessionId?: string;
    commitHash?: string;
    irVersion?: string;
    startedAt?: number;
  }): Promise<BenchmarkRun> {
    const run: BenchmarkRun = {
      schemaVersion: 1,
      kind: 'run',
      runId: input.runId,
      taskId: input.taskId,
      taskCategory: input.taskCategory,
      provider: input.provider,
      model: input.model,
      profile: input.profile,
      sessionId: input.sessionId,
      commitHash: input.commitHash,
      irVersion: input.irVersion,
      startedAt: input.startedAt ?? Date.now(),
    };
    validateBenchmarkRecord(run);
    await this.persist(run);
    return run;
  }

  async finishRun(
    runId: string,
    outcome: {
      finishedAt?: number;
      latencyMs?: number;
      ttftMs?: number;
      usageIn?: number;
      usageOut?: number;
      toolCount?: number;
      subagentCount?: number;
      workflowCount?: number;
      success: boolean;
      failureClass?: FailureClass;
      verification?: ValidatorResult;
    },
  ): Promise<BenchmarkRun | undefined> {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run) return undefined;
    Object.assign(run, outcome, { finishedAt: outcome.finishedAt ?? Date.now() });
    // v1.3 anti-sandbagging: last-write-wins replay semantics — when the final
    // verification lands, re-evaluate the evidence flag of an already-claimed
    // score (deterministic, toggle-gated).
    if (this.requireEvidenceForScores && typeof run.qualityScore === 'number') {
      run.evidenceBacked = isVerifierPassEvidence(run.verification);
    }
    await this.persist(run);
    return run;
  }

  async recordScore(input: { runId: string; qualityScore: number; validatorId?: string; scoredAt?: number }): Promise<BenchmarkScore> {
    if (input.qualityScore < 0 || input.qualityScore > 1) {
      throw new BenchmarkValidationError(['qualityScore must be within [0,1]']);
    }
    const run = this.runs.find((r) => r.runId === input.runId);
    // v1.3 anti-sandbagging: claimed scores need verifier-PASS evidence.
    // Flag present ONLY when the toggle is on (default config writes no key).
    const evidenceBacked = this.requireEvidenceForScores
      ? isVerifierPassEvidence(run?.verification)
      : undefined;
    const score: BenchmarkScore = {
      schemaVersion: 1,
      kind: 'score',
      runId: input.runId,
      qualityScore: input.qualityScore,
      validatorId: input.validatorId,
      scoredAt: input.scoredAt ?? Date.now(),
      ...(evidenceBacked !== undefined ? { evidenceBacked } : {}),
    };
    await this.persist(score);
    if (run) {
      run.qualityScore = score.qualityScore;
      if (evidenceBacked !== undefined) run.evidenceBacked = evidenceBacked;
    }
    return score;
  }

  queryHistory(filter: HistoryFilter = {}): BenchmarkRun[] {
    let out = this.runs.filter((r) => r.finishedAt !== undefined);
    if (filter.provider) out = out.filter((r) => r.provider === filter.provider);
    if (filter.model) out = out.filter((r) => r.model === filter.model);
    if (filter.taskId) out = out.filter((r) => r.taskId === filter.taskId);
    if (filter.success !== undefined) out = out.filter((r) => r.success === filter.success);
    out = out.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  aggregateModelPerformance(): ModelPerformance[] {
    return aggregateRuns(this.runs);
  }

  stats(): BenchmarkStats {
    return {
      tasks: this.tasks.length,
      runs: this.runs.length,
      scores: this.scores.length,
      corruptLines: this.corruptLines,
    };
  }

  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private dirOf(): string {
    const idx = this.filePath.lastIndexOf('/');
    return idx > 0 ? this.filePath.slice(0, idx) : '.';
  }
}

// ---------------------------------------------------------------------------
// v1.3.1 (IMP-R) — Routing based on work outcomes (support surfaces).
//
// All additions are deterministic: fixed formulas, ids/labels/counts/durations
// only, no ML, no network. They extend the store WITHOUT changing any v1.2/
// v1.3 record shape (schemas/benchmark-record.schema.json untouched).
// ---------------------------------------------------------------------------

// --- §1 support: per-task-class outcome samples for the router -------------

export interface ClassSampleRow {
  provider: string;
  model: string;
  /** Benchmark taskCategory (the class label). */
  taskClass: string;
  success: boolean;
  /** Epoch ms of the finish (or start when unfinished) — recency input. */
  at: number;
}

/**
 * Most-recent-first bounded sample rows for class-aware routing (IMP-R §1).
 * Only finished runs with a defined taskCategory and success outcome qualify.
 */
export function classSampleRows(runs: BenchmarkRun[], limit = 512): ClassSampleRow[] {
  const bounded = Math.max(1, Math.min(4_096, Math.floor(limit)));
  return runs
    .filter((r) => r.finishedAt !== undefined && typeof r.taskCategory === 'string' && r.taskCategory.length > 0 && typeof r.success === 'boolean')
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
    .slice(0, bounded)
    .map((r) => ({
      provider: r.provider,
      model: r.model,
      taskClass: r.taskCategory,
      success: r.success === true,
      at: r.finishedAt ?? r.startedAt,
    }));
}

// --- §6 support: end-to-end task latency (durations only) -------------------

export interface TaskLatencyStat {
  taskCategory: string;
  samples: number;
  avgLatencyMs: number | null;
  medianLatencyMs: number | null;
  maxLatencyMs: number | null;
}

/**
 * End-to-end task latency per task category over finished runs. The duration
 * is the run's own latencyMs when recorded, else finishedAt − startedAt —
 * the same span the observability task_latency event measures from task
 * begin to close. Durations only; no content.
 */
export function aggregateTaskLatency(runs: BenchmarkRun[]): TaskLatencyStat[] {
  const groups = new Map<string, number[]>();
  for (const run of runs) {
    if (run.finishedAt === undefined) continue;
    const duration = typeof run.latencyMs === 'number' && run.latencyMs >= 0 ? run.latencyMs : run.finishedAt - run.startedAt;
    if (!Number.isFinite(duration) || duration < 0) continue;
    const category = typeof run.taskCategory === 'string' && run.taskCategory.length > 0 ? run.taskCategory : 'UNCLASSIFIED';
    const bucket = groups.get(category);
    if (bucket) bucket.push(duration);
    else groups.set(category, [duration]);
  }
  const out: TaskLatencyStat[] = [];
  for (const [taskCategory, durations] of groups) {
    const sorted = [...durations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    out.push({
      taskCategory,
      samples: sorted.length,
      avgLatencyMs: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
      medianLatencyMs: median,
      maxLatencyMs: sorted[sorted.length - 1],
    });
  }
  return out.sort((a, b) => a.taskCategory.localeCompare(b.taskCategory));
}

// --- §5: recovery checkpoints (minimal) --------------------------------------
//
// checkpoint = { taskId, stepIndex, artifactRefs, artifactHashes,
// sideEffectsRegistered, status, updatedAt } — an append-only JSONL file
// (checkpoints.jsonl) in the benchmark dataDir the plugin ALREADY owns,
// written through the same BenchmarkFs seam. Replay is last-write-wins per
// (taskId, stepIndex).
//
// v1.3.1 (IMP-R §5) record shape (all additive/optional — older records stay
// valid):
//   artifactHashes         — [{ref, hash}] content digests of the artifacts
//                            the step produced (ids + digests only, never
//                            artifact content; ≤16 pairs, ref/hash ≤128 chars)
//   sideEffectsRegistered  — true when the host REGISTERED the step's real
//                            side effects (artifacts written) at checkpoint
//                            time; surfaced on every resume step.
//
// Resume semantics (documented contract):
//   - The resume API is a PURE read of the CURRENT store state (records are
//     reloaded from the JSONL the plugin owns) and NEVER auto-repeats side
//     effects: steps whose latest record is 'completed' with VERIFIED hashes
//     are never marked redo, and assertNoRepeatedSideEffects throws before
//     any action could target a completed step.
//   - When the caller supplies currentArtifactHashes (the REAL current state
//     of the artifacts, measured by the host), every recorded hash is
//     re-checked: a 'completed' step whose recorded hash no longer matches
//     the current artifact (or whose artifact is missing) is reported
//     hashCheck:'mismatch' + redo:true — but it is NEVER included in
//     resumeActions (auto-repeat is forbidden); the host must explicitly
//     re-record or repair before redoing such a step.
//   - Bounds: the in-memory store keeps at most `maxEntries` records (default
//     1024, oldest evicted first; the disk file stays append-only), ≤16
//     artifact refs and ≤16 hash pairs per record.

export const CHECKPOINT_STATUSES = ['active', 'completed', 'interrupted'] as const;
export type CheckpointStatus = (typeof CHECKPOINT_STATUSES)[number];

export interface CheckpointRecord {
  schemaVersion: 1;
  kind: 'checkpoint';
  taskId: string;
  stepIndex: number;
  /** Artifact references (ids/paths-as-ids, bounded) — never artifact content. */
  artifactRefs: string[];
  /**
   * v1.3.1 (IMP-R §5): content digests for (a subset of) the artifacts —
   * pairs of ref → hash. Ids + digests only, never artifact content.
   */
  artifactHashes?: Array<{ ref: string; hash: string }>;
  /**
   * v1.3.1 (IMP-R §5): true when the host registered the step's real side
   * effects (e.g. artifacts written) at checkpoint time.
   */
  sideEffectsRegistered?: boolean;
  status: CheckpointStatus;
  updatedAt: number;
}

export class CheckpointValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid checkpoint record: ${issues.join('; ')}`);
    this.name = 'CheckpointValidationError';
  }
}

/** Bounded hash token: digests or deterministic synthetic ids (no spaces). */
const ARTIFACT_HASH_PATTERN = /^[A-Za-z0-9._:/+-]{1,128}$/;

/** Deterministic checkpoint validation (bounded, id/label-only fields). */
export function validateCheckpointRecord(raw: unknown): CheckpointRecord {
  const issues: string[] = [];
  if (!raw || typeof raw !== 'object') throw new CheckpointValidationError(['record must be an object']);
  const rec = raw as Record<string, unknown>;
  assertCondition(rec.schemaVersion === 1, issues, 'schemaVersion must be 1');
  assertCondition(rec.kind === 'checkpoint', issues, 'kind must be checkpoint');
  assertCondition(typeof rec.taskId === 'string' && rec.taskId.length > 0 && rec.taskId.length <= 128, issues, 'taskId must be 1..128 chars');
  assertCondition(typeof rec.stepIndex === 'number' && Number.isInteger(rec.stepIndex) && rec.stepIndex >= 0, issues, 'stepIndex must be an integer >= 0');
  if (!Array.isArray(rec.artifactRefs) || rec.artifactRefs.length > 16) {
    issues.push('artifactRefs must be an array of at most 16 strings');
  } else {
    for (const ref of rec.artifactRefs) {
      assertCondition(typeof ref === 'string' && ref.length > 0 && ref.length <= 128, issues, 'each artifactRef must be 1..128 chars');
    }
  }
  // v1.3.1 (IMP-R §5): artifact hash pairs + side-effect registration flag.
  if (rec.artifactHashes !== undefined) {
    if (!Array.isArray(rec.artifactHashes) || rec.artifactHashes.length > 16) {
      issues.push('artifactHashes must be an array of at most 16 {ref, hash} pairs');
    } else {
      for (const pair of rec.artifactHashes) {
        const p = pair as Record<string, unknown> | null;
        assertCondition(
          !!p && typeof p.ref === 'string' && p.ref.length > 0 && p.ref.length <= 128 &&
            typeof p.hash === 'string' && ARTIFACT_HASH_PATTERN.test(p.hash),
          issues,
          'each artifactHash must be {ref: 1..128 chars, hash: bounded token}',
        );
      }
    }
  }
  if (rec.sideEffectsRegistered !== undefined) {
    assertCondition(typeof rec.sideEffectsRegistered === 'boolean', issues, 'sideEffectsRegistered must be a boolean');
  }
  assertCondition(
    typeof rec.status === 'string' && (CHECKPOINT_STATUSES as readonly string[]).includes(rec.status),
    issues,
    'status must be active|completed|interrupted',
  );
  assertCondition(typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt), issues, 'updatedAt must be a finite number');
  if (issues.length > 0) throw new CheckpointValidationError(issues);
  return raw as CheckpointRecord;
}

export type ArtifactHashCheck = 'verified' | 'mismatch' | 'unverified';

export interface ResumeStep {
  stepIndex: number;
  status: CheckpointStatus;
  /**
   * true when work is needed: the latest record is NOT 'completed', OR the
   * step is 'completed' but its recorded artifact hashes NO LONGER match the
   * caller-provided current state (stale side effect — surfaced, never
   * auto-redone; see resumeActions).
   */
  redo: boolean;
  artifactRefs: string[];
  updatedAt: number;
  /** v1.3.1 (IMP-R §5): carried from the latest record (absent when unrecorded). */
  sideEffectsRegistered?: boolean;
  /** v1.3.1 (IMP-R §5): carried from the latest record (absent when unrecorded). */
  artifactHashes?: Array<{ ref: string; hash: string }>;
  /**
   * v1.3.1 (IMP-R §5): result of re-checking the recorded hashes against the
   * caller-provided current state — 'verified' when every recorded hash still
   * matches, 'mismatch' when any ref is missing or differs, 'unverified' when
   * no current-state map was supplied (or the step recorded no hashes).
   */
  hashCheck?: ArtifactHashCheck;
}

export interface ResumePlan {
  taskId: string;
  steps: ResumeStep[];
  completedCount: number;
  redoCount: number;
}

/**
 * Re-check a step's recorded artifact hashes against the caller-provided
 * REAL current state (deterministic; no fs access inside the engine — the
 * host measures the artifacts and passes the digests in).
 */
export function checkArtifactHashes(
  recorded: Array<{ ref: string; hash: string }> | undefined,
  current: Record<string, string> | undefined,
): ArtifactHashCheck {
  if (current === undefined || recorded === undefined || recorded.length === 0) return 'unverified';
  for (const pair of recorded) {
    const now = current[pair.ref];
    if (now === undefined || now !== pair.hash) return 'mismatch';
  }
  return 'verified';
}

/**
 * PURE resume planning from the CURRENT store state. A step is `redo` iff
 * its latest record status is not 'completed', OR the step IS 'completed'
 * but its recorded artifact hashes no longer match the supplied current
 * state (stale evidence). Completed side effects with VERIFIED hashes are
 * NEVER re-planned. Steps never recorded are reported with status 'active'
 * and redo=true (fresh work, nothing to repeat).
 */
export function planResumeFromRecords(
  taskId: string,
  records: CheckpointRecord[],
  currentArtifactHashes?: Record<string, string>,
): ResumePlan {
  const latest = new Map<number, CheckpointRecord>();
  for (const rec of records) {
    if (rec.taskId !== taskId) continue;
    const prev = latest.get(rec.stepIndex);
    if (prev === undefined || rec.updatedAt >= prev.updatedAt) latest.set(rec.stepIndex, rec);
  }
  const steps: ResumeStep[] = [...latest.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([stepIndex, rec]) => {
      const hashCheck = checkArtifactHashes(rec.artifactHashes, currentArtifactHashes);
      return {
        stepIndex,
        status: rec.status,
        redo: rec.status !== 'completed' || hashCheck === 'mismatch',
        artifactRefs: [...rec.artifactRefs],
        updatedAt: rec.updatedAt,
        ...(rec.sideEffectsRegistered !== undefined ? { sideEffectsRegistered: rec.sideEffectsRegistered } : {}),
        ...(rec.artifactHashes !== undefined ? { artifactHashes: rec.artifactHashes.map((p) => ({ ...p })) } : {}),
        ...(currentArtifactHashes !== undefined || rec.artifactHashes !== undefined ? { hashCheck } : {}),
      };
    });
  return {
    taskId,
    steps,
    completedCount: steps.filter((s) => s.status === 'completed').length,
    redoCount: steps.filter((s) => s.redo).length,
  };
}

export class ResumeSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeSafetyError';
  }
}

/**
 * Side-effect safety assertion (IMP-R §5): throws when any intended action
 * targets a step whose CURRENT latest status is 'completed' — i.e. resume
 * must NEVER auto-repeat an already-executed side effect. Fresh steps
 * (never recorded) and steps whose latest status is 'active'/'interrupted'
 * are allowed.
 */
export function assertNoRepeatedSideEffects(
  plan: ResumePlan,
  actions: Array<{ stepIndex: number }>,
): void {
  const byIndex = new Map(plan.steps.map((s) => [s.stepIndex, s]));
  for (const action of actions) {
    const step = byIndex.get(action.stepIndex);
    if (step && step.status === 'completed') {
      throw new ResumeSafetyError(
        `resume would repeat a completed side effect: task ${plan.taskId} step ${action.stepIndex} is already completed`,
      );
    }
  }
}

/**
 * Pure action derivation for a resume: the steps that may be AUTO-run, with
 * the safety assertion applied. Only steps whose latest record is not
 * 'completed' qualify — hash-mismatched 'completed' steps are surfaced by
 * the plan (redo=true, hashCheck:'mismatch') but are NEVER auto-runnable
 * (resume must not auto-repeat a side effect it cannot prove is stale-safe
 * to redo; the host decides after inspection). Runs of this planner NEVER
 * include completed steps.
 */
export function resumeActions(plan: ResumePlan): ResumeStep[] {
  const actions = plan.steps.filter((s) => s.redo && s.status !== 'completed');
  // Assert-in-code: completed steps can never appear in the action list.
  assertNoRepeatedSideEffects(plan, actions);
  return actions;
}

/** Minimal fs seam is REUSED from the benchmark store (BenchmarkFs). */
export class CheckpointStore {
  private readonly records: CheckpointRecord[] = [];
  private corruptLines = 0;
  private queue: Promise<void> = Promise.resolve();
  private loaded = false;
  private readonly maxEntries: number;

  constructor(
    private readonly filePath: string,
    private readonly fsImpl: BenchmarkFs,
    opts: { maxEntries?: number } = {},
  ) {
    // Bounded memory: at most maxEntries records retained (oldest evicted
    // first, insertion order — deterministic). The disk file stays
    // append-only; reload keeps the most recent tail of the log.
    const cap = opts.maxEntries ?? 1024;
    this.maxEntries = Number.isFinite(cap) ? Math.max(16, Math.min(65_536, Math.floor(cap))) : 1024;
  }

  /** Load history once; corrupt lines are skipped and counted, never fatal. */
  async init(): Promise<{ checkpoints: number; corruptLines: number }> {
    if (this.loaded) return this.stats();
    this.loaded = true;
    const raw = await this.fsImpl.readFile(this.filePath).catch(() => null);
    if (raw) {
      const parsed: CheckpointRecord[] = [];
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue;
        try {
          parsed.push(validateCheckpointRecord(JSON.parse(line)));
        } catch {
          this.corruptLines++;
        }
      }
      // Bounded load: keep only the most recent tail of the append-only log.
      this.records.push(...parsed.slice(-this.maxEntries));
    }
    return this.stats();
  }

  private async persist(record: CheckpointRecord): Promise<void> {
    this.records.push(record);
    if (this.records.length > this.maxEntries) {
      // Bounded memory: drop the oldest record (insertion order is
      // deterministic; last-write-wins replay keeps the latest per key).
      this.records.shift();
    }
    const line = JSON.stringify(record) + '\n';
    this.queue = this.queue
      .then(async () => {
        await this.fsImpl.mkdir(this.dirOf());
        await this.fsImpl.appendFile(this.filePath, line);
      })
      .catch(() => {
        // Fail open: in-memory evidence retained, disk write dropped.
      });
    return this.queue;
  }

  /** Append one checkpoint record (validated, bounded). */
  async record(input: {
    taskId: string;
    stepIndex: number;
    artifactRefs?: string[];
    /** v1.3.1 (IMP-R §5): ref → content-digest pairs (bounded). */
    artifactHashes?: Array<{ ref: string; hash: string }>;
    /** v1.3.1 (IMP-R §5): whether the step's real side effects were registered. */
    sideEffectsRegistered?: boolean;
    status?: CheckpointStatus;
    updatedAt?: number;
  }): Promise<CheckpointRecord> {
    const full: CheckpointRecord = {
      schemaVersion: 1,
      kind: 'checkpoint',
      taskId: input.taskId,
      stepIndex: input.stepIndex,
      artifactRefs: [...(input.artifactRefs ?? [])],
      ...(input.artifactHashes !== undefined
        ? { artifactHashes: input.artifactHashes.map((p) => ({ ref: p.ref, hash: p.hash })) }
        : {}),
      ...(input.sideEffectsRegistered !== undefined
        ? { sideEffectsRegistered: input.sideEffectsRegistered === true }
        : {}),
      status: input.status ?? 'active',
      updatedAt: input.updatedAt ?? Date.now(),
    };
    validateCheckpointRecord(full);
    await this.persist(full);
    return full;
  }

  /** Current records for a task (append order). */
  recordsFor(taskId: string): CheckpointRecord[] {
    return this.records.filter((r) => r.taskId === taskId);
  }

  /** Resume plan computed from the REAL current store state (pure read). */
  resumePlan(taskId: string): ResumePlan {
    return planResumeFromRecords(taskId, this.records);
  }

  /**
   * v1.3.1 (IMP-R §5): resume with REAL-state re-check — the caller supplies
   * the CURRENT artifact digests it measured; every recorded hash must still
   * match for a completed step to be reported resumable (hashCheck
   * 'verified'). Pure read; never mutates state, never repeats side effects.
   */
  resume(taskId: string, currentArtifactHashes?: Record<string, string>): ResumePlan {
    return planResumeFromRecords(taskId, this.records, currentArtifactHashes);
  }

  stats(): { checkpoints: number; corruptLines: number } {
    return { checkpoints: this.records.length, corruptLines: this.corruptLines };
  }

  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private dirOf(): string {
    const idx = this.filePath.lastIndexOf('/');
    return idx > 0 ? this.filePath.slice(0, idx) : '.';
  }
}
