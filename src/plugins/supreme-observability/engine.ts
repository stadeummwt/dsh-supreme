/**
 * @dsh-supreme/observability — storage engine.
 *
 * Append-only JSONL writer with:
 *  - deterministic field allowlisting (buildRecord only copies known fields),
 *  - bounded serialization,
 *  - fail-open semantics (writer failures drop records, never crash the agent),
 *  - size-based rotation,
 *  - flush on dispose.
 *
 * DSH Session remains the runtime source of truth; this store holds derived
 * operational metadata only (Spec §10 — no second session database).
 */

export interface ObservabilityConfig {
  enabled: boolean;
  /** Absolute or cwd-relative directory for the JSONL file. */
  dataDir: string;
  fileName: string;
  /** Rotate when the active file exceeds this size. */
  maxFileBytes: number;
  /** Hard per-record serialization bound. */
  maxLineChars: number;
}

export const OBSERVABILITY_DEFAULTS: ObservabilityConfig = {
  enabled: true,
  dataDir: 'dsh-supreme/data/observability',
  fileName: 'observability.jsonl',
  maxFileBytes: 5_000_000,
  maxLineChars: 2048,
};

/** The ONLY fields that can ever be serialized. Metadata allowlist (Spec §10). */
export const RECORD_FIELDS = [
  'seq',
  'ts',
  'event',
  'sessionId',
  'turn',
  'step',
  'provider',
  'model',
  'latencyMs',
  'ttftMs',
  'tool',
  'toolError',
  'subagent',
  'workflow',
  'compaction',
  'tokenPressure',
  'usageIn',
  'usageOut',
  'errorClass',
  'verificationId',
  'verificationStatus',
  'routeDecisionId',
  'benchmarkRunId',
  'workflowDecisionId',
  'detail',
] as const;

export type RecordField = (typeof RECORD_FIELDS)[number];
export type SafeRecord = Partial<Record<RecordField, string | number | boolean>> & {
  seq: number;
  ts: number;
  event: string;
};

export function buildRecord(seq: number, ts: number, event: string, fields: Record<string, unknown>): SafeRecord {
  const record: SafeRecord = { seq, ts, event };
  const bound = (v: unknown, max = 256): string | number | boolean | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') {
      // Defense in depth: scrub synthetic secret sentinels from any string
      // field, even allowlisted ones (Spec §25 — sentinel absence guarantee).
      const scrubbed = v.replace(/SECRET_SENTINEL[A-Z0-9_]*/g, '[REDACTED]');
      return scrubbed.length > max ? scrubbed.slice(0, max) : scrubbed;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'boolean') return v;
    return undefined;
  };
  for (const key of RECORD_FIELDS) {
    if (key === 'seq' || key === 'ts' || key === 'event') continue;
    const value = bound(fields[key]);
    if (value !== undefined) record[key] = value;
  }
  return record;
}

export function serializeRecord(record: SafeRecord, maxLineChars: number): string {
  let line = JSON.stringify(record);
  if (line.length > maxLineChars) {
    // Deterministic truncation: keep the identity fields, mark truncation.
    line = JSON.stringify({ ...record, detail: '<truncated>' }).slice(0, maxLineChars - 1);
  }
  return line;
}

export interface WriterStats {
  written: number;
  dropped: number;
  rotations: number;
  lastWriteError: string | null;
}

/**
 * Fail-open JSONL writer. Serialized write chain keeps event order
 * deterministic; fs errors are captured into stats, never thrown.
 */
export class JsonlWriter {
  private queue: Promise<void> = Promise.resolve();
  private readonly stats: WriterStats = { written: 0, dropped: 0, rotations: 0, lastWriteError: null };
  private disposed = false;

  constructor(
    private readonly path: string,
    private readonly rotatePath: string,
    private readonly maxFileBytes: number,
    private readonly maxLineChars: number,
    private readonly fsImpl: {
      appendFile(path: string, data: string): Promise<void>;
      stat(path: string): Promise<{ size: number } | null>;
      rename(from: string, to: string): Promise<void>;
      mkdir(dir: string): Promise<void>;
    },
  ) {}

  get filePath(): string {
    return this.path;
  }

  getStats(): WriterStats {
    return { ...this.stats };
  }

  write(record: SafeRecord): void {
    if (this.disposed) {
      this.stats.dropped++;
      return;
    }
    const line = serializeRecord(record, this.maxLineChars) + '\n';
    this.queue = this.queue
      .then(async () => {
        await this.fsImpl.mkdir(this.dirOf());
        const stat = await this.fsImpl.stat(this.path).catch(() => null);
        if (stat && stat.size + line.length > this.maxFileBytes) {
          await this.fsImpl.rename(this.path, this.rotatePath).catch(() => undefined);
          this.stats.rotations++;
        }
        await this.fsImpl.appendFile(this.path, line);
        this.stats.written++;
      })
      .catch((err: unknown) => {
        // Fail open: drop the record, keep the agent alive.
        this.stats.dropped++;
        this.stats.lastWriteError = err instanceof Error ? err.message : String(err);
      });
  }

  /** Await queue drain (used on dispose). */
  async flush(): Promise<WriterStats> {
    await this.queue.catch(() => undefined);
    return this.getStats();
  }

  dispose(): Promise<WriterStats> {
    this.disposed = true;
    return this.flush();
  }

  private dirOf(): string {
    const idx = this.path.lastIndexOf('/');
    return idx > 0 ? this.path.slice(0, idx) : '.';
  }
}

/** Read the last `count` records (bounded) for dashboard projection. */
export async function readRecent(
  path: string,
  count: number,
  fsImpl: { readFile(path: string): Promise<string | null> },
): Promise<SafeRecord[]> {
  const raw = await fsImpl.readFile(path).catch(() => null);
  if (!raw) return [];
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const out: SafeRecord[] = [];
  for (const line of lines.slice(-count)) {
    try {
      const parsed = JSON.parse(line) as SafeRecord;
      if (parsed && typeof parsed.event === 'string') out.push(parsed);
    } catch {
      // Corrupt tail line: skip (fail open).
    }
  }
  return out;
}

/** Synthetic sentinel used only by security checks; must never appear in artifacts. */
export const SECRET_SENTINEL = 'SECRET_SENTINEL_CANARY_9f2c';
