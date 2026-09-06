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
 *
 * Session history is NEVER duplicated — this plugin only reads projections to
 * compute token pressure context. The system-prompt section is conditional:
 * it renders '' when no memory is selected (no giant permanent block).
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  NOOP_LONG_TERM_PROVIDER,
  estimateTokens,
  needsMemory,
  selectMemory,
  type LongTermProvider,
  type MemoryItem,
  type MemorySelection,
  type ProviderState,
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
});

export type MemoryPolicyService = {
  /** Decide + select memory for a task inside the given budget. */
  select(input: { taskText: string; budgetTokens?: number }): MemorySelection;
  /** Read-only pressure probe through the official tokenMeter seam (optional). */
  tokenPressure(): number | null;
  /** Canonical statement: DSH Session owns history; we never duplicate it. */
  sessionHistoryOwner(): 'DSH_CTX_SESSIONS';
  registerLongTermProvider(provider: LongTermProvider): () => void;
  longTermProviderState(): ProviderState;
};

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  // Optional pressure probe — ctx.get() is the no-inject optional pattern.
  const tokenMeter = ctx.get('tokenMeter') as
    | { measure(session: unknown): { totalTokens: number } }
    | undefined;

  let longTerm: LongTermProvider = NOOP_LONG_TERM_PROVIDER;
  let latestSelection: MemorySelection | null = null;

  const projectItems = (): MemoryItem[] =>
    config.projectKnowledge.map((entry) => ({
      id: entry.id,
      class: 'PROJECT_CONTEXT' as const,
      source: 'config.projectKnowledge',
      text: entry.text,
      estimatedTokens: estimateTokens(entry.text),
      priority: entry.priority,
      tags: entry.tags,
    }));

  const service: MemoryPolicyService = {
    select(input) {
      const budget = input.budgetTokens ?? config.defaultBudgetTokens;
      const items = [...projectItems(), ...longTerm.list({ taskText: input.taskText, limit: 50 })];
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
        latestSelection = empty;
        return empty;
      }
      const selection = selectMemory({
        taskText: input.taskText,
        budgetTokens: budget,
        items,
        providerState: longTerm.status,
      });
      latestSelection = selection;
      return selection;
    },

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
  };

  ctx.provide('supremeMemoryPolicy', Object.freeze(service));

  if (config.registerPromptSection) {
    // Conditional section: renders '' when no memory was selected for the
    // current task (Spec §13: no giant permanent memory block).
    ctx.systemPrompt.section({
      name: 'supreme-memory-context',
      order: 500,
      text: () => {
        if (!latestSelection || latestSelection.selected.length === 0) return '';
        return latestSelection.selected
          .map(({ item }) => `[memory:${item.class}] ${item.text}`)
          .join('\n')
          .slice(0, config.defaultBudgetTokens * 4);
      },
    });
  }

  ctx.logger.info(
    'supreme-memory-policy active (budget=%d, knowledge=%d, longTerm=%s/%s)',
    config.defaultBudgetTokens,
    config.projectKnowledge.length,
    longTerm.name,
    longTerm.status,
  );
}
