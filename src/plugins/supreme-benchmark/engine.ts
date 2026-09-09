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
