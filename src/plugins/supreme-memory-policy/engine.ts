/**
 * @dsh-supreme/memory-policy — selection policy engine.
 *
 * ARCHITECTURAL RULE (Spec §13 original): this plugin owns memory SELECTION
 * POLICY, not storage. DSH ctx.sessions remains canonical session history —
 * it is never duplicated. Three distinct things stay separate:
 *   SESSION HISTORY (DSH ctx.sessions — canonical, read-only for us)
 *   PROJECT KNOWLEDGE (explicitly configured project artifacts)
 *   LONG-TERM USER MEMORY (project-owned provider seam; NOOP is valid)
 */

export const MEMORY_CLASSES = ['CORE_PROFILE', 'PROJECT_CONTEXT', 'TASK_RELEVANT', 'LONG_TERM'] as const;
export type MemoryClass = (typeof MEMORY_CLASSES)[number];

export const PROVIDER_STATES = ['AVAILABLE', 'UNAVAILABLE', 'DEGRADED'] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];

export interface MemoryItem {
  id: string;
  class: MemoryClass;
  source: string;
  text: string;
  estimatedTokens: number;
  priority: number;
  tags?: string[];
}

export interface LongTermProvider {
  name: string;
  status: ProviderState;
  /** List candidate memory items for a task. Must never return credentials. */
  list(task: { taskText: string; limit: number }): MemoryItem[];
}

/**
 * The legitimate initial provider: NOOP. It claims nothing — no persistence
 * is invented just so the feature can be said to exist (Spec §13).
 */
export const NOOP_LONG_TERM_PROVIDER: Readonly<LongTermProvider> = Object.freeze({
  name: 'noop',
  status: 'UNAVAILABLE',
  list: () => [],
});

export interface MemorySelection {
  selected: Array<{ item: MemoryItem; reason: string }>;
  excluded: Array<{ id: string; reason: string }>;
  totalEstimatedTokens: number;
  budgetTokens: number;
  withinBudget: true;
  providerState: ProviderState;
}

/** Patterns that categorize an item as credential-bearing — always excluded. */
const SECRET_PATTERNS: RegExp[] = [
  /SECRET_SENTINEL[A-Z0-9_]*/,
  /sk-[a-zA-Z0-9]{8,}/,
  /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/,
  /Authorization:\s*Bearer/i,
  /api[-_]?key\s*[:=]/i,
  /password\s*[:=]/i,
];

export function isSecretBearing(item: MemoryItem): boolean {
  const haystack = `${item.source}\n${item.tags?.join(' ') ?? ''}\n${item.text}`;
  return SECRET_PATTERNS.some((re) => re.test(haystack));
}

/** Rough deterministic token estimate (≈4 chars/token, bounded). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Deterministic selection:
 *  1. exclude secret-bearing items (never enter model context),
 *  2. sort by (priority desc, estimatedTokens asc),
 *  3. greedily fill the budget.
 */
export function selectMemory(input: {
  taskText: string;
  budgetTokens: number;
  items: MemoryItem[];
  providerState: ProviderState;
}): MemorySelection {
  const { budgetTokens, providerState } = input;
  const selected: MemorySelection['selected'] = [];
  const excluded: MemorySelection['excluded'] = [];

  const candidates = [...input.items];
  for (const item of candidates) {
    if (isSecretBearing(item)) excluded.push({ id: item.id, reason: 'SECRET_CATEGORY' });
    else if (item.estimatedTokens > budgetTokens && selected.length === 0 && item.priority < 50) {
      excluded.push({ id: item.id, reason: 'ITEM_EXCEEDS_BUDGET' });
    }
  }
  const eligible = candidates.filter((item) => !excluded.some((e) => e.id === item.id));
  eligible.sort((a, b) => b.priority - a.priority || a.estimatedTokens - b.estimatedTokens);

  let used = 0;
  for (const item of eligible) {
    if (used + item.estimatedTokens <= budgetTokens) {
      selected.push({
        item,
        reason: item.class === 'TASK_RELEVANT' ? 'TASK_RELEVANT' : item.class,
      });
      used += item.estimatedTokens;
    } else {
      excluded.push({ id: item.id, reason: 'BUDGET_EXCEEDED' });
    }
  }

  return {
    selected,
    excluded,
    totalEstimatedTokens: used,
    budgetTokens,
    withinBudget: true,
    providerState,
  };
}

/** Whether additional memory should be consulted for this task at all. */
export function needsMemory(input: { taskText: string; tokenPressure?: number }): { required: boolean; reason: string } {
  const pressure = input.tokenPressure ?? 0;
  if (pressure > 0.85) return { required: false, reason: 'TOKEN_PRESSURE_HIGH' };
  if (input.taskText.length === 0) return { required: false, reason: 'NO_TASK' };
  return { required: true, reason: 'DEFAULT_ON' };
}

// ---------------------------------------------------------------------------
// v1.2 — Note-Keeping Ledger (v3 plan §2A, ADOPTED) + instinct-style policy
// gates (ECC continuous-learning-v2 analogue, DETERMINISTIC — no ML, no ANN).
//
// The ledger is a bounded, append-only JSONL note store. Injection policy is
// pure gating: confidence threshold (default 0.7), max injected notes (6),
// deterministic relevance ranking by tag/token overlap, and the SAME secret
// exclusion rules as every other memory class. Storage stays opt-in:
// ledgerEnabled=false keeps the plugin a pure selection policy (NOOP state).
// ---------------------------------------------------------------------------

export interface LedgerNote {
  id: string;
  text: string;
  tags: string[];
  priority: number;
  /** Confidence in [0,1] — recorded evidence quality, NOT model self-assessment. */
  confidence: number;
  createdAt: number;
  source: string;
}

export class LedgerValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid ledger note: ${issues.join('; ')}`);
    this.name = 'LedgerValidationError';
  }
}

/** Deterministic note validation (bounded fields, secret patterns rejected at admission). */
export function validateLedgerNote(raw: unknown): LedgerNote {
  const issues: string[] = [];
  if (!raw || typeof raw !== 'object') throw new LedgerValidationError(['note must be an object']);
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== 'string' || rec.id.length === 0 || rec.id.length > 128) issues.push('id required (≤128 chars)');
  if (typeof rec.text !== 'string' || rec.text.length === 0 || rec.text.length > 2000) issues.push('text required (≤2000 chars)');
  if (!Array.isArray(rec.tags) || rec.tags.length > 16 || rec.tags.some((t) => typeof t !== 'string' || t.length > 64)) {
    issues.push('tags must be ≤16 strings (≤64 chars)');
  }
  if (typeof rec.priority !== 'number' || rec.priority < 0 || rec.priority > 100) issues.push('priority must be within [0,100]');
  if (typeof rec.confidence !== 'number' || rec.confidence < 0 || rec.confidence > 1) issues.push('confidence must be within [0,1]');
  if (typeof rec.createdAt !== 'number' || !Number.isFinite(rec.createdAt)) issues.push('createdAt required');
  if (typeof rec.source !== 'string' || rec.source.length === 0 || rec.source.length > 128) issues.push('source required (≤128 chars)');
  if (issues.length > 0) throw new LedgerValidationError(issues);
  const note = raw as LedgerNote;
  if (isSecretBearing({ id: note.id, class: 'LONG_TERM', source: note.source, text: note.text, estimatedTokens: 0, priority: note.priority, tags: note.tags })) {
    throw new LedgerValidationError(['note is credential-bearing and is rejected at admission']);
  }
  return note;
}

export interface LedgerFs {
  readFile(path: string): Promise<string | null>;
  appendFile(path: string, line: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

export interface LedgerStats {
  entries: number;
  loadedCorrupt: number;
  appended: number;
  rejected: number;
}

/** Bounded append-only JSONL note ledger (memory view trimmed to maxEntries). */
export class NoteLedger {
  private notes: LedgerNote[] = [];
  private loadedCorrupt = 0;
  private appended = 0;
  private rejected = 0;
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly fsImpl: LedgerFs,
    private readonly maxEntries: number,
  ) {}

  async init(): Promise<LedgerStats> {
    if (this.loaded) return this.stats();
    this.loaded = true;
    const raw = await this.fsImpl.readFile(this.filePath).catch(() => null);
    if (raw) {
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue;
        try {
          this.notes.push(validateLedgerNote(JSON.parse(line)));
        } catch {
          this.loadedCorrupt++;
        }
      }
      this.trim();
    }
    return this.stats();
  }

  private trim(): void {
    if (this.notes.length > this.maxEntries) {
      // Deterministic: keep the NEWEST maxEntries (append order = creation order).
      this.notes = this.notes.slice(this.notes.length - this.maxEntries);
    }
  }

  /** Append one note; validation failures are counted, never thrown to the host. */
  async append(note: LedgerNote): Promise<boolean> {
    try {
      validateLedgerNote(note);
    } catch {
      this.rejected++;
      return false;
    }
    this.notes.push(note);
    this.trim();
    this.appended++;
    const line = JSON.stringify(note) + '\n';
    this.queue = this.queue
      .then(async () => {
        await this.fsImpl.mkdir(this.dirOf());
        await this.fsImpl.appendFile(this.filePath, line);
      })
      .catch(() => undefined); // fail-open: in-memory note retained
    await this.queue;
    return true;
  }

  private queue: Promise<void> = Promise.resolve();

  list(): LedgerNote[] {
    return [...this.notes];
  }

  stats(): LedgerStats {
    return { entries: this.notes.length, loadedCorrupt: this.loadedCorrupt, appended: this.appended, rejected: this.rejected };
  }

  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private dirOf(): string {
    const idx = this.filePath.lastIndexOf('/');
    return idx > 0 ? this.filePath.slice(0, idx) : '.';
  }
}

/** Deterministic token set: lowercase alnum words, length ≥ 3. */
function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) out.add(word);
  return out;
}

/** Deterministic relevance = |token overlap(task, text+tags)| (not ML — counting). */
export function ledgerRelevanceScore(note: LedgerNote, taskTokens: Set<string>): number {
  const noteTokens = tokenSet(`${note.text} ${note.tags.join(' ')}`);
  let overlap = 0;
  for (const t of noteTokens) if (taskTokens.has(t)) overlap++;
  return overlap;
}

export interface InstinctParams {
  /** Notes below this confidence never inject (ECC analogue default 0.7). */
  minConfidence: number;
  /** Hard cap on injected notes per selection (ECC analogue default 6). */
  maxInjected: number;
  /** Relevance-ranked ordering (task-token overlap first) vs pure priority order. */
  relevanceRanking: boolean;
}

export const DEFAULT_INSTINCT_PARAMS: Readonly<InstinctParams> = Object.freeze({
  minConfidence: 0.7,
  maxInjected: 6,
  relevanceRanking: true,
});

/**
 * Deterministic instinct-style note selection:
 *  1. confidence gate (>= minConfidence),
 *  2. rank by (relevance desc when enabled, priority desc, createdAt desc, id asc),
 *  3. cap at maxInjected.
 */
export function selectLedgerNotes(
  notes: LedgerNote[],
  taskText: string,
  params: InstinctParams,
): LedgerNote[] {
  const taskTokens = tokenSet(taskText);
  const eligible = notes.filter((n) => n.confidence >= params.minConfidence);
  const scored = eligible.map((n) => ({ note: n, relevance: ledgerRelevanceScore(n, taskTokens) }));
  scored.sort((a, b) =>
    params.relevanceRanking
      ? b.relevance - a.relevance || b.note.priority - a.note.priority || b.note.createdAt - a.note.createdAt || a.note.id.localeCompare(b.note.id)
      : b.note.priority - a.note.priority || b.note.createdAt - a.note.createdAt || a.note.id.localeCompare(b.note.id),
  );
  return scored.slice(0, params.maxInjected).map((s) => s.note);
}

/** Ledger notes → MemoryItem projection (TASK_RELEVANT class, ledger source). */
export function ledgerNotesToItems(notes: LedgerNote[]): MemoryItem[] {
  return notes.map((n) => ({
    id: `ledger:${n.id}`,
    class: 'TASK_RELEVANT' as const,
    source: `ledger:${n.source}`,
    text: n.text,
    estimatedTokens: estimateTokens(n.text),
    priority: n.priority,
    tags: n.tags,
  }));
}
