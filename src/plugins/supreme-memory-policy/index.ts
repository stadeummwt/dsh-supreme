/**
 * @dsh-supreme/memory-policy — Cordis adapter (REAL pinned plugin shape).
 *
 * SERVICE = supremeMemoryPolicy
 * INJECTED DSH SERVICES = ['sessions', 'systemPrompt']
 *
 * Verified against pinned upstream:
 *   - ctx.sessions:     packages/core/session/src/index.ts:892 (super(ctx, 'sessions')),
 *                       read-only use: SessionStore.list() / Session.snapshotEvents()
 *   - ctx.systemPrompt: packages/core/system-prompt/src/index.ts (section(): () => void)
 *   - renderer identity seam:
 *       packages/core/agent/src/dispatch.ts:174 assembleContextFor() →
 *       `{ agent, scope: agent }` is passed to EVERY prompt assembly, and
 *       @deepseek-ai/dsh-agent augments AssembleContext with `agent?: Agent`
 *       (runtime-types.ts:20-23). Agent.session.id / Agent.id are the durable
 *       branded SessionId strings — the REAL identity the renderer binds to.
 *   - cleanup seam: `session/disposed` (pinned emit event,
 *       packages/core/session/src/index.ts:61) releases the whole session's
 *       selections; the Cordis dispose effect clears the entire store.
 *
 * v1.3.1 — SESSION/TASK ISOLATION (P1 external review fix): selections are
 * keyed by (sessionId, taskId) in a bounded LRU store (default 128 entries).
 * There is NO shared "latest selection": a renderer or lookup with an
 * unknown/missing identity renders/returns NOTHING (fail-closed). Intentional
 * cross-session sharing exists ONLY for the opt-in project namespace
 * (config.projectKnowledge → SHARED_KNOWLEDGE_SCOPE='project'), which is
 * identical for every session by design and never stored per-identity.
 *
 * Session history is NEVER duplicated — this plugin only reads projections to
 * compute token pressure context. The system-prompt section is conditional:
 * it renders '' when no memory is selected (no giant permanent block).
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { resolve } from 'node:path';
import {
  DEFAULT_INSTINCT_PARAMS,
  NOOP_LONG_TERM_PROVIDER,
  NoteLedger,
  SelectionStore,
  SHARED_KNOWLEDGE_SCOPE,
  clampSelectionStoreCap,
  estimateTokens,
  identityOf,
  ledgerNotesToItems,
  needsMemory,
  selectLedgerNotes,
  selectMemory,
  type LedgerNote,
  type LedgerStats,
  type LongTermProvider,
  type MemoryItem,
  type MemorySelection,
  type ProviderState,
  type SelectionStoreStats,
} from './engine';

import '../context-types';
export const name = 'supreme-memory-policy';

export const inject = ['sessions', 'systemPrompt'];

export const Config = z.object({
  /** Default context budget for memory selection. */
  defaultBudgetTokens: z.number().int().min(128).max(100_000).default(2048),
  /** Register the conditional system-prompt section. */
  registerPromptSection: z.boolean().default(true),
  /** Project knowledge entries (id + text); tags optional. */
  projectKnowledge: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        priority: z.number().min(0).max(100).default(50),
        tags: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** v1.2: enable the bounded append-only note ledger (opt-in storage). */
  ledgerEnabled: z.boolean().default(false),
  /** v1.2: ledger directory (cwd-relative, like observability dataDir). */
  ledgerDir: z.string().default('dsh-supreme/data/ledger'),
  ledgerFileName: z.string().default('ledger.jsonl'),
  /** v1.2: ledger is bounded — the memory view keeps the newest N entries. */
  ledgerMaxEntries: z.number().int().min(10).max(10_000).default(500),
  /** v1.2 instinct params: notes below this confidence never inject. */
  minConfidence: z.number().min(0).max(1).default(0.7),
  /** v1.2 instinct params: hard cap on injected notes per selection. */
  maxInjected: z.number().int().min(1).max(20).default(6),
  /** v1.2 instinct params: relevance-ranked ordering (deterministic token overlap). */
  relevanceRanking: z.boolean().default(true),
  /**
   * v1.3.1: bounded LRU capacity (entries) for session/task-scoped selections.
   * The store NEVER grows past this cap; the oldest selection is evicted
   * deterministically. Default 128 (documented in the plugin README).
   */
  selectionStoreCap: z.number().int().min(8).max(4096).default(128),
});

export type MemoryPolicyService = {
  /**
   * Decide + select memory for a task inside the given budget.
   *
   * v1.3.1: when BOTH `sessionId` and `taskId` are supplied (non-empty
   * strings), the selection is stored under that (sessionId, taskId) identity
   * and becomes that session's active task selection (renderable by that
   * session's prompt assemblies). Without a full identity the result is
   * TRANSIENT — returned to the caller and never stored, never rendered.
   */
  select(input: {
    taskText: string;
    budgetTokens?: number;
    sessionId?: string;
    taskId?: string;
  }): MemorySelection;
  /**
   * v1.3.1: return ONLY the selection owned by exactly this (sessionId,
   * taskId) pair; `null` when the identity is unknown or the entry was
   * released/evicted. NEVER falls back to another task's or session's state.
   */
  lookup(identity: { sessionId: string; taskId: string }): MemorySelection | null;
  /**
   * v1.3.1: release one task's selection (task end OR cancel). Returns whether
   * an entry was removed. Releasing the session's active task leaves the
   * session with NO renderable selection (no fallback to older tasks).
   */
  releaseTask(identity: { sessionId: string; taskId: string }): boolean;
  /** v1.3.1: release every selection owned by one session. Returns the count removed. */
  releaseSession(sessionId: string): number;
  /** v1.3.1: release everything (host-invoked). Returns the count removed. */
  releaseAll(): number;
  /**
   * v1.3.1: internal-state accessor — ids/counts ONLY (capacity, entries,
   * activeTasks, evictions). Exists so gates can assert real cleanup; never
   * carries selection content.
   */
  selectionStoreStats(): SelectionStoreStats;
  /**
   * v1.3.1: the intentionally-shared project namespace (opt-in config entries,
   * SHARED_KNOWLEDGE_SCOPE='project'). These items are the same for every
   * session BY DESIGN; task-specific selections are never included here.
   */
  sharedKnowledge(): MemoryItem[];
  /** Read-only pressure probe through the official tokenMeter seam (optional). */
  tokenPressure(): number | null;
  /** Canonical statement: DSH Session owns history; we never duplicate it. */
  sessionHistoryOwner(): 'DSH_CTX_SESSIONS';
  registerLongTermProvider(provider: LongTermProvider): () => void;
  longTermProviderState(): ProviderState;
  /** v1.2: append a note to the bounded ledger (fails when disabled/invalid). */
  ledgerAppend(note: Omit<LedgerNote, 'createdAt'> & { createdAt?: number }): Promise<{ ok: boolean; reason?: string }>;
  /** v1.2: deterministic instinct-style note selection (confidence gate + cap + ranking). */
  ledgerSelect(taskText: string): MemoryItem[];
  /** v1.2: bounded ledger stats. */
  ledgerStats(): LedgerStats | null;
};

export async function apply(ctx: Context, config: z.infer<typeof Config>): Promise<void> {
  // Optional pressure probe — ctx.get() is the no-inject optional pattern.
  const tokenMeter = ctx.get('tokenMeter') as
    | { measure(session: unknown): { totalTokens: number } }
    | undefined;

  let longTerm: LongTermProvider = NOOP_LONG_TERM_PROVIDER;

  // v1.3.1: session/task-scoped, bounded LRU store. Replaces the v1.3.0
  // plugin-instance `latestSelection` (a single shared slot that leaked one
  // session's selection into every other session's render — P1). The config
  // value is zod-validated (int ≥ 8) AND routed through the engine clamp so
  // the bounded floor holds even if the schema is ever loosened.
  const store = new SelectionStore(clampSelectionStoreCap(config.selectionStoreCap));

  // Optional audit (never injected — same idiom as supreme-policy): events
  // carry ids/counts ONLY, never selection content (Spec §10 allowlist).
  const audit = (event: string, fields: Record<string, unknown>): void => {
    try {
      const observability = ctx.get('supremeObservability') as
        | { record(event: string, fields: Record<string, unknown>): void }
        | undefined;
      if (!observability || typeof observability.record !== 'function') return;
      observability.record(event, fields);
    } catch {
      // Audit must never break memory policy — including during dispose.
    }
  };

  // v1.2: opt-in bounded note ledger. Disabled ⇒ pure selection policy (NOOP).
  let ledger: NoteLedger | null = null;
  if (config.ledgerEnabled) {
    const fs = process.getBuiltinModule('node:fs').promises;
    const ledgerPath = resolve(config.ledgerDir, config.ledgerFileName);
    ledger = new NoteLedger(
      ledgerPath,
      {
        readFile: async (p) => {
          try {
            return await fs.readFile(p, 'utf8');
          } catch {
            return null;
          }
        },
        appendFile: (p, line) => fs.appendFile(p, line, 'utf8'),
        mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => undefined),
      },
      config.ledgerMaxEntries,
    );
    await ledger.init();
    ctx.logger.info('supreme-memory-policy ledger at %s (%d entries)', ledgerPath, ledger.stats().entries);
  }

  const instinctParams = {
    minConfidence: config.minConfidence,
    maxInjected: config.maxInjected,
    relevanceRanking: config.relevanceRanking,
  };

  const ledgerItemsForTask = (taskText: string): MemoryItem[] => {
    if (!ledger) return [];
    return ledgerNotesToItems(selectLedgerNotes(ledger.list(), taskText, instinctParams));
  };

  /**
   * The ONLY intentionally-shared namespace (SHARED_KNOWLEDGE_SCOPE='project'):
   * opt-in config entries that are identical for every session BY DESIGN.
   * These items are never stored in the per-identity selection store — they
   * enter a session's context exclusively through that session's own select()
   * call, so the shared namespace still cannot leak one session's TASK
   * selections into another.
   */
  const projectItems = (): MemoryItem[] =>
    config.projectKnowledge.map((entry) => ({
      id: entry.id,
      class: 'PROJECT_CONTEXT' as const,
      source: `config.projectKnowledge:${SHARED_KNOWLEDGE_SCOPE}`,
      text: entry.text,
      estimatedTokens: estimateTokens(entry.text),
      priority: entry.priority,
      tags: entry.tags,
    }));

  /** Store a freshly built selection ONLY under a full (sessionId, taskId). */
  const storeScoped = (input: { sessionId?: string; taskId?: string }, selection: MemorySelection): void => {
    const identity = identityOf(input);
    if (!identity) return; // unknown/missing identity ⇒ transient, never stored
    store.record(identity, selection);
    audit('memory_selection_scoped', {
      sessionId: identity.sessionId,
      detail: `task:${identity.taskId} selected:${selection.selected.length} tokens:${selection.totalEstimatedTokens} entries:${store.stats().entries}`,
    });
  };

  /**
   * Resolve the REAL session id of a prompt assembly from the pinned seam:
   * the agent loop passes `{ agent, scope: agent }` into every assembly
   * (packages/core/agent/src/dispatch.ts:174), and Agent.session.id /
   * Agent.id are the durable SessionId strings. Anything else (diagnostics
   * assemblies, foreign callers) ⇒ null ⇒ the renderer fails CLOSED.
   */
  const sessionIdFromAssembleContext = (assemblyContext: unknown): string | null => {
    if (!assemblyContext || typeof assemblyContext !== 'object') return null;
    const agent = (assemblyContext as { agent?: unknown }).agent;
    if (!agent || typeof agent !== 'object') return null;
    const session = (agent as { session?: unknown }).session;
    const sessionId = session && typeof session === 'object' ? (session as { id?: unknown }).id : undefined;
    const agentId = (agent as { id?: unknown }).id;
    const raw = sessionId !== undefined ? sessionId : agentId;
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    return raw;
  };

  const service: MemoryPolicyService = {
    select(input) {
      const budget = input.budgetTokens ?? config.defaultBudgetTokens;
      const items = [...projectItems(), ...ledgerItemsForTask(input.taskText), ...longTerm.list({ taskText: input.taskText, limit: 50 })];
      const decision = needsMemory({ taskText: input.taskText });
      if (!decision.required) {
        const empty: MemorySelection = {
          selected: [],
          excluded: items.map((item) => ({ id: item.id, reason: decision.reason })),
          totalEstimatedTokens: 0,
          budgetTokens: budget,
          withinBudget: true,
          providerState: longTerm.status,
        };
        storeScoped(input, empty);
        return empty;
      }
      const selection = selectMemory({
        taskText: input.taskText,
        budgetTokens: budget,
        items,
        providerState: longTerm.status,
      });
      storeScoped(input, selection);
      return selection;
    },

    lookup(identity) {
      const resolved = identityOf(identity);
      if (!resolved) return null; // unknown identity ⇒ nothing, never a fallback
      return store.get(resolved) ?? null;
    },

    releaseTask(identity) {
      const resolved = identityOf(identity);
      if (!resolved) return false;
      const removed = store.releaseTask(resolved);
      audit('memory_selection_released', {
        sessionId: resolved.sessionId,
        detail: `scope:task task:${resolved.taskId} released:${removed ? 1 : 0} entries:${store.stats().entries}`,
      });
      return removed;
    },

    releaseSession(sessionId) {
      const resolved = sessionId && typeof sessionId === 'string' ? sessionId.trim() : '';
      if (resolved.length === 0) return 0;
      const removed = store.releaseSession(resolved);
      audit('memory_selection_released', {
        sessionId: resolved,
        detail: `scope:session released:${removed} entries:${store.stats().entries}`,
      });
      return removed;
    },

    releaseAll() {
      const removed = store.clear();
      audit('memory_selection_released', {
        detail: `scope:plugin released:${removed} entries:${store.stats().entries}`,
      });
      return removed;
    },

    selectionStoreStats: () => store.stats(),

    sharedKnowledge: () => projectItems(),

    tokenPressure() {
      // Real pressure requires a live Session; without one, report null (unknown).
      return null;
    },

    sessionHistoryOwner: () => 'DSH_CTX_SESSIONS',

    registerLongTermProvider(provider) {
      longTerm = provider;
      return () => {
        longTerm = NOOP_LONG_TERM_PROVIDER;
      };
    },

    longTermProviderState: () => longTerm.status,

    async ledgerAppend(note) {
      if (!ledger) return { ok: false, reason: 'LEDGER_DISABLED' };
      const accepted = await ledger.append({ ...note, createdAt: note.createdAt ?? Date.now() });
      return accepted ? { ok: true } : { ok: false, reason: 'LEDGER_NOTE_REJECTED' };
    },

    ledgerSelect: (taskText) => ledgerItemsForTask(taskText),

    ledgerStats: () => ledger?.stats() ?? null,
  };

  ctx.provide('supremeMemoryPolicy', Object.freeze(service));
  if (ledger) {
    ctx.effect(() => () => ledger?.flush(), 'supreme-memory-policy.ledger-flush');
  }

  // v1.3.1 cleanup seam (pinned emit event — official seam per the surface
  // audit): a session leaving the store releases ALL of its selections.
  ctx.on('session/disposed', (session) => {
    const rawId = (session as { id?: unknown } | null | undefined)?.id;
    const sessionId = typeof rawId === 'string' ? rawId.trim() : '';
    if (sessionId.length === 0) return;
    const removed = store.releaseSession(sessionId);
    audit('memory_selection_released', {
      sessionId,
      detail: `scope:session_disposed released:${removed} entries:${store.stats().entries}`,
    });
  });

  // v1.3.1 dispose: the whole per-identity store is cleared on fiber unload
  // (Cordis effect semantics: the returned disposer runs on dispose).
  ctx.effect(
    () => () => {
      const removed = store.clear();
      audit('memory_selection_disposed', {
        detail: `scope:plugin released:${removed} entries:${store.stats().entries}`,
      });
    },
    'supreme-memory-policy.selection-store-dispose',
  );

  if (config.registerPromptSection) {
    // Conditional section: renders '' unless the calling assembly's OWN
    // session has an active task selection (Spec §13: no giant permanent
    // memory block; v1.3.1: no cross-session/stale fallback — unknown or
    // missing identity renders NOTHING).
    ctx.systemPrompt.section({
      name: 'supreme-memory-context',
      order: 500,
      text: (assemblyContext: unknown): string => {
        const sessionId = sessionIdFromAssembleContext(assemblyContext);
        if (sessionId === null) return ''; // unknown identity ⇒ empty, NEVER latest
        const taskId = store.activeTaskOf(sessionId);
        if (taskId === undefined) return ''; // session owns no active task
        const selection = store.get({ sessionId, taskId });
        if (!selection || selection.selected.length === 0) return '';
        return selection.selected
          .map(({ item }) => `[memory:${item.class}] ${item.text}`)
          .join('\n')
          .slice(0, config.defaultBudgetTokens * 4);
      },
    });
  }

  ctx.logger.info(
    'supreme-memory-policy active (budget=%d, knowledge=%d, longTerm=%s/%s, ledger=%s, instinct[minConfidence=%s maxInjected=%d relevanceRanking=%s], selectionStore[cap=%d scope=identity shared=%s])',
    config.defaultBudgetTokens,
    config.projectKnowledge.length,
    longTerm.name,
    longTerm.status,
    config.ledgerEnabled ? 'on' : 'off',
    String(config.minConfidence),
    config.maxInjected,
    String(config.relevanceRanking),
    store.stats().capacity,
    SHARED_KNOWLEDGE_SCOPE,
  );
}
