# ADR-0005: Memory provider boundary — NOOP long-term provider is legitimate; DSH sessions canonical; selection policy only

**STATUS:** Accepted
**DATE:** DSH Supreme v1 documentation pass

## CONTEXT

"Memory" fails when three distinct concerns are merged: (1) session history — what happened in this conversation; (2) project knowledge — explicit artifacts the operator wants in context; (3) long-term user memory — persistent facts across conversations. DSH already owns (1) canonically (`ctx.sessions`). Building a storage system for (3) would duplicate host responsibilities, invent persistence "just so the feature can be said to exist", and create a second secret-bearing data store — all rejected by the spec.

## DECISION

1. **`supremeMemoryPolicy` owns memory SELECTION POLICY, not storage.** It decides whether memory is consulted for a task (`needsMemory`), selects items within a token budget (`selectMemory`: exclude secret-bearing → sort by priority desc / size asc → greedy fill), and contributes the selection through one bounded, conditional system-prompt section.
2. **DSH sessions are canonical.** `ctx.sessions` is consumed read-only for projections; `sessionHistoryOwner()` returns `'DSH_CTX_SESSIONS'` as a machine-checkable statement. Session history is **never duplicated**.
3. **The NOOP long-term provider is a legitimate, shipped state** — not a stub to be ashamed of: `NOOP_LONG_TERM_PROVIDER` (`name: 'noop'`, `status: 'UNAVAILABLE'`, `list: () => []`). It claims nothing. A real provider can be registered later via `registerLongTermProvider(provider)` (which returns the disposer restoring NOOP) and must satisfy the `LongTermProvider` contract — including "must never return credentials".
4. **Project knowledge is explicit config** (`projectKnowledge[]` with id/text/priority/tags), so what enters context is auditable in the composition file itself.
5. **Secret exclusion is structural:** pattern-based `isSecretBearing` check (sentinels, `sk-…` keys, private-key headers, bearer tokens, api-key/password assignments) removes items from selection entirely (`SECRET_CATEGORY`).
6. The prompt section renders `''` when nothing was selected — **no giant permanent memory block** — and is bounded by `defaultBudgetTokens * 4` characters.

## EVIDENCE

- Engine: `src/plugins/supreme-memory-policy/engine.ts` (`NOOP_LONG_TERM_PROVIDER`, `selectMemory`, `isSecretBearing`, `needsMemory`); adapter: `src/plugins/supreme-memory-policy/index.ts` (read-only `sessions` inject, conditional `systemPrompt.section({ name: 'supreme-memory-context' })`, frozen service).
- Verified upstream seams cited in the adapter header: `ctx.sessions` (`packages/core/session/src/index.ts`), `ctx.systemPrompt` (`packages/core/system-prompt/src/index.ts`, `section()`).
- Level-A checks (5/5 PASS): `memory.budget-enforced`, `memory.priority-order`, `memory.secret-exclusion`, `memory.noop-provider-valid` (NOOP is asserted legitimate, not an error), `memory.needs-memory-conditional`.
- Real boots: gate `memory_respects_budget` PASS (scenario selection stayed within the 400-token budget in every supreme/lab run); shipped compositions set `registerPromptSection: false` with a single bounded project-knowledge entry.

## ALTERNATIVES

- **Build a vector store / embedding memory in v1.** Rejected: invents persistence without a proven need; adds retrieval nondeterminism to a deterministic policy layer; expands the secret-bearing surface.
- **Treat NOOP as a failure state that must be replaced before release.** Rejected: it forces fake persistence; the spec explicitly forbids inventing storage so a feature can be claimed.
- **Dump full session history into the prompt.** Rejected: duplicates the canonical owner (DSH sessions) and blows the context budget.
- **Unbounded system-prompt memory block.** Rejected: contradicts the "no giant permanent block" rule; the section is conditional and capped.

## CONSEQUENCES

- Positive: honest feature surface (selection policy works, storage honestly absent); zero new secret-bearing stores; model context stays bounded; long-term memory becomes an explicit, contract-checked upgrade path.
- Negative: no cross-session recall until a real long-term provider is registered; `tokenPressure()` returns `null` without a live session, so pressure-based suppression relies on caller input in v1.
- Neutral: the `LongTermProvider` seam is the single extension point; registering a provider is a code-level (not config-level) act today.

## ROLLBACK

Set `registerPromptSection: false` (as shipped) to remove even the conditional prompt surface, or unmount the plugin from the composition — nothing else depends on `supremeMemoryPolicy` (verified: no other Supreme plugin injects it). The NOOP provider requires no rollback by definition: it retains nothing.
