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

// ---------------------------------------------------------------------------
// v1.3.1 — Session/task-scoped selection store (cross-session isolation, P1).
//
// The v1.3.0 adapter kept ONE `latestSelection` on the plugin instance, so the
// renderer and any later reader observed whatever task selected last —
// concurrent or successive sessions received each other's memory selections
// (cross-session contamination found by the v1.3.0 external review).
//
// The store below binds every selection to the REAL identity pair
// (sessionId, taskId) taken from the actual context/session objects:
//   - sessionId comes from the pinned Agent/Session seam — the agent loop
//     passes the live Agent into every prompt assembly
//     (packages/core/agent/src/dispatch.ts:174 `assembleContextFor` →
//     `{ agent, scope: agent }`; `Agent.session.id`/`Agent.id` are the durable
//     branded SessionId strings, packages/core/agent/src/types.ts:14);
//   - taskId is the caller-owned request/task identifier supplied together
//     with the selection.
//
// Properties (all deterministic):
//   BOUNDED    — LRU eviction at the configured cap (default 128 entries);
//   FAIL-CLOSED— lookups with unknown/missing identity return nothing; there
//                is NO "latest selection" fallback anywhere;
//   RELEASED   — explicit releaseTask/releaseSession/releaseAll, the pinned
//                `session/disposed` emit seam, and the plugin dispose effect
//                all actually remove entries (verifiable via stats()).
//
// SHARED-KNOWLEDGE BOUNDARY: `config.projectKnowledge` is the ONLY
// intentionally-shared namespace (SHARED_KNOWLEDGE_SCOPE = 'project'). It is
// opt-in (the host must explicitly configure each entry) and identical for
// every session BY DESIGN; it is never stored in this per-identity map — it
// flows into a session's context only through that session's own select()
// call. Task-specific selections never leave their (sessionId, taskId) key.
// ---------------------------------------------------------------------------

/** The intentionally-shared, opt-in project namespace (never per-task). */
export const SHARED_KNOWLEDGE_SCOPE = 'project' as const;

/** Default bounded LRU capacity for session/task-scoped selections. */
export const DEFAULT_SELECTION_STORE_CAP = 128;

/** Lower floor for the cap — keeps the store meaningful while bounded. */
export const MIN_SELECTION_STORE_CAP = 8;

/** Real identity pair a selection is owned by. Both parts are required. */
export interface MemoryIdentity {
  sessionId: string;
  taskId: string;
}

/**
 * Normalize one identity part: strings are trimmed; anything empty or
 * non-string is NOT an identity (null) — callers must treat null as
 * "unknown identity" and fail closed, never fall back to other state.
 */
export function normalizeIdentityText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the identity of a select/lookup input: BOTH parts must normalize.
 * Missing, empty, or non-string parts ⇒ null (unknown identity).
 */
export function identityOf(input: { sessionId?: unknown; taskId?: unknown }): MemoryIdentity | null {
  const sessionId = normalizeIdentityText(input.sessionId);
  const taskId = normalizeIdentityText(input.taskId);
  return sessionId !== null && taskId !== null ? { sessionId, taskId } : null;
}

/** Deterministic composite map key (NUL separator avoids concat ambiguity). */
export function identityKey(identity: MemoryIdentity): string {
  return `${identity.sessionId}\u0000${identity.taskId}`;
}

/** Clamp a configured cap into [MIN_SELECTION_STORE_CAP, ∞) deterministically. */
export function clampSelectionStoreCap(cap: number | undefined): number {
  if (typeof cap !== 'number' || !Number.isFinite(cap)) return DEFAULT_SELECTION_STORE_CAP;
  return Math.max(MIN_SELECTION_STORE_CAP, Math.floor(cap));
}

/** Ids/counts only — never selection content. Safe for audit serialization. */
export interface SelectionStoreStats {
  capacity: number;
  entries: number;
  activeTasks: number;
  evictions: number;
}

interface SelectionEntry {
  identity: MemoryIdentity;
  selection: MemorySelection;
}

/**
 * Bounded LRU map of (sessionId, taskId) → MemorySelection, plus the
 * per-session ACTIVE-task pointer the renderer needs.
 *
 * Why an active-task pointer: the pinned system-prompt assembly context
 * (`AssembleContext`) carries the agent (⇒ session id) but NO task id, so the
 * renderer binds to the session's active task — a pointer that is set ONLY by
 * that same session's own scoped select() call and cleared by release APIs.
 * A session with no active task renders nothing (fail-closed). Releasing the
 * active task does NOT resurrect an older selection of the same session —
 * that would be the exact "previous selection" fallback this store removes.
 *
 * Both internal maps are bounded by the same LRU cap; evictions are counted.
 */
export class SelectionStore {
  private readonly capacity: number;
  /** insertion order = LRU order (Map semantics); touch = delete + re-set. */
  private readonly entries = new Map<string, SelectionEntry>();
  private readonly activeTask = new Map<string, string>();
  private evictions = 0;

  constructor(capacity: number = DEFAULT_SELECTION_STORE_CAP) {
    // Raw MECHANICAL capacity: any finite number ≥ 1 is honored (floored) so
    // the LRU mechanics are exercisable at small caps; anything else falls
    // back to the documented default. Host/adapter CONFIG values must be
    // clamped through clampSelectionStoreCap() (floor MIN_SELECTION_STORE_CAP)
    // BEFORE construction — the adapter does exactly that.
    this.capacity =
      typeof capacity === 'number' && Number.isFinite(capacity) && capacity >= 1
        ? Math.floor(capacity)
        : DEFAULT_SELECTION_STORE_CAP;
  }

  /** Store a selection for an identity and mark it the session's active task. */
  record(identity: MemoryIdentity, selection: MemorySelection): void {
    const key = identityKey(identity);
    this.entries.delete(key);
    this.entries.set(key, { identity, selection });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
    this.activeTask.delete(identity.sessionId);
    this.activeTask.set(identity.sessionId, identity.taskId);
    while (this.activeTask.size > this.capacity) {
      const oldest = this.activeTask.keys().next();
      if (oldest.done) break;
      this.activeTask.delete(oldest.value);
      this.evictions += 1;
    }
  }

  /** Exact-identity lookup (LRU refresh). Collision-checked via stored identity. */
  get(identity: MemoryIdentity): MemorySelection | undefined {
    const key = identityKey(identity);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.identity.sessionId !== identity.sessionId || entry.identity.taskId !== identity.taskId) {
      return undefined; // key collision (pathological ids) ⇒ fail closed
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.selection;
  }

  /** The active task id of a session, or undefined when the session has none. */
  activeTaskOf(sessionId: string): string | undefined {
    const taskId = this.activeTask.get(sessionId);
    if (taskId === undefined) return undefined;
    this.activeTask.delete(sessionId);
    this.activeTask.set(sessionId, taskId);
    return taskId;
  }

  /** Release one task's selection. Clears the active pointer only if it points at this task. */
  releaseTask(identity: MemoryIdentity): boolean {
    const removed = this.entries.delete(identityKey(identity));
    const active = this.activeTask.get(identity.sessionId);
    if (active === identity.taskId) this.activeTask.delete(identity.sessionId);
    return removed;
  }

  /** Release EVERYTHING owned by one session. Returns the number of entries removed. */
  releaseSession(sessionId: string): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.identity.sessionId === sessionId) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    this.activeTask.delete(sessionId);
    return removed;
  }

  /** Release everything (plugin dispose). Returns the number of entries removed. */
  clear(): number {
    const removed = this.entries.size;
    this.entries.clear();
    this.activeTask.clear();
    return removed;
  }

  /** Internal-state accessor: ids/counts only, for gates and honest assertions. */
  stats(): SelectionStoreStats {
    return { capacity: this.capacity, entries: this.entries.size, activeTasks: this.activeTask.size, evictions: this.evictions };
  }
}
