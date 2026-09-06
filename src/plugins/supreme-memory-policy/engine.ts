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
