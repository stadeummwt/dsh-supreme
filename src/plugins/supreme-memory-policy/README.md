# supreme-memory-policy

Cordis adapter: `index.ts` · Engine: `engine.ts` · Service: **`supremeMemoryPolicy`**

## Purpose

Memory **selection policy** — not memory storage. Decides whether extra memory should be consulted for a task, selects items within a token budget (excluding credential-bearing items), and contributes them through one conditional system-prompt section. Three things stay separate by design: **SESSION HISTORY** (DSH `ctx.sessions` — canonical, read-only for us), **PROJECT KNOWLEDGE** (configured items), **LONG-TERM USER MEMORY** (provider seam whose legitimate initial state is NOOP).

## When to mount

- Compositions that want project knowledge in context: `standard`, `supreme`, `lab`.
- Mount after the DSH core services exist (`sessions`, `systemPrompt` are hard injects).

## When NOT to mount

- Never as a session store or history backup: duplicating DSH session history is architecturally forbidden (see `sessionHistoryOwner()` → `'DSH_CTX_SESSIONS'`).
- `core` omits it (no memory requirement in the clean baseline).
- Not mounted where an empty permanent prompt block is unacceptable unless `registerPromptSection: false` is set (the shipped compositions set it `false` and rely on explicit selection).

## Injected services

Exact names:

```ts
export const inject = ['sessions', 'systemPrompt'];
```

Verified against the pin: `ctx.sessions` (`packages/core/session/src/index.ts`, `super(ctx, 'sessions')`) used read-only; `ctx.systemPrompt` (`packages/core/system-prompt/src/index.ts`, `section()`). Optional seam via `ctx.get('tokenMeter')` for pressure probing (no inject declaration).

## Config

| Field | Type | Default | Notes |
|---|---|---|---|
| `defaultBudgetTokens` | integer 128–100 000 | `2048` | Default context budget for selection. |
| `registerPromptSection` | boolean | `true` | Registers the conditional `supreme-memory-context` system-prompt section. |
| `projectKnowledge[]` | array | `[]` | `{ id, text, priority (0–100, default 50), tags (default []) }` — explicit project artifacts. |

## Public service contract (`supremeMemoryPolicy`)

| Method | Returns | Description |
|---|---|---|
| `select({ taskText, budgetTokens? })` | `MemorySelection` | Decides + selects items within budget: `{ selected (item + reason), excluded (id + reason), totalEstimatedTokens, budgetTokens, withinBudget, providerState }`. |
| `tokenPressure()` | `number \| null` | Pressure probe; returns `null` (unknown) without a live session in v1. |
| `sessionHistoryOwner()` | `'DSH_CTX_SESSIONS'` | Canonical ownership statement — history is never duplicated. |
| `registerLongTermProvider(provider)` | `() => void` | Swaps the long-term provider seam; returns the disposer restoring NOOP. |
| `longTermProviderState()` | `AVAILABLE \| UNAVAILABLE \| DEGRADED` | Current provider status (`UNAVAILABLE` for NOOP). |

Selection algorithm (deterministic): exclude secret-bearing items (`SECRET_CATEGORY`) → sort by (priority desc, estimatedTokens asc) → greedily fill the budget (`BUDGET_EXCEEDED` for the rest). `needsMemory` returns `required: false` when token pressure > 0.85 or the task text is empty.

## Security boundary

- Secret-bearing items **never enter model context**: pattern exclusion for synthetic sentinels, `sk-…` API keys, private-key PEM headers, `Authorization: Bearer`, `api_key=`, `password=`.
- The long-term provider contract (`LongTermProvider.list`) explicitly must never return credentials; the exclusion pass is defense in depth.
- The system-prompt section is bounded: renders `''` when nothing is selected (no giant permanent block), and its rendered output is capped at `defaultBudgetTokens * 4` characters.

## Data retained

None. All items come from config (`projectKnowledge`) or the registered provider; the latest selection is held in memory only. No files are written.

## Model-visible behavior

Exactly one bounded surface: the optional `supreme-memory-context` system-prompt section, which renders `[memory:<class>] <text>` lines for selected items and `''` when nothing was selected. No tools, no events, nothing else.

## Limitations

- `tokenPressure()` reports `null` in v1 (needs a live session probe); pressure-based suppression is therefore config-driven in tests.
- No retrieval/relevance ranking: selection is priority + size ordering over the provided candidate list (provider `limit: 50` call in `select`).
- Long-term memory ships as NOOP (`name: 'noop'`, status `UNAVAILABLE`) by design — any real provider must be registered explicitly via `registerLongTermProvider`.

## Verification commands

```bash
bun run dsh-supreme/src/suite/cli.ts --skip-real-boots   # Level A: memory.* (5 checks incl. noop-provider-valid, secret-exclusion)
node dsh-supreme/real/boot.mjs --profile standard --setup
node dsh-supreme/real/boot.mjs --profile supreme --setup # gate: memory_respects_budget (used ≤ 400 in scenario)
```
