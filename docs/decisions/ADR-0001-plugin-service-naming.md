# ADR-0001: Plugin service naming — `supremePolicy` … `supremeWorkflowPolicy` via `ctx.provide`

**STATUS:** Accepted
**DATE:** DSH Supreme v1 documentation pass

## CONTEXT

Cordis plugins publish capabilities by registering services on the shared context (`ctx.provide(name, value)`). The pinned upstream's own packages use short, domain-owned names for their services — `ctx.llm`, `ctx.sessions`, `ctx.systemPrompt`, `ctx.subagents`, `ctx.workflowEngine`, `ctx.tokenMeter`, `ctx.credentials` (declared via `declare module '@deepseek-ai/cordis' { interface Context { … } }` in each package). Supreme needed seven services of its own that must:

- never collide with current or future upstream service names,
- be recognizable as Supreme-owned in any context dump, and
- be stable, because the boot probe, gate driver, suite, and API all key on the exact strings.

## DECISION

1. All seven Supreme services are provided under a frozen namespace: `supremePolicy`, `supremeObservability`, `supremeBenchmark`, `supremeRouter`, `supremeVerifier`, `supremeMemoryPolicy`, `supremeWorkflowPolicy`.
2. Each service is registered exactly once per plugin via `ctx.provide('<name>', Object.freeze(service))`.
3. The upstream `Service` **class** pattern (subclassing Cordis `Service`, as upstream packages do — e.g. `super(ctx, 'sessions')`, `super(ctx, 'tokenMeter')`) is **reserved for upstream packages**. Supreme plugins use plain frozen objects: simpler, no lifecycle coupling to upstream internals, and no claim on upstream naming conventions.
4. Plugin ids (kebab-case, `supreme-*`) mirror the service names (camelCase) 1:1.

## EVIDENCE

- Real upstream service pattern: `packages/core/session/src/index.ts` (`super(ctx, 'sessions')` at the constructor, interface declaration at the top of the file), `packages/llm/token-meter/src/index.ts` (`super(ctx, 'tokenMeter')`), `packages/credentials/credentials/src/index.ts` (`super(ctx, 'credentials')`).
- Supreme registration sites: `ctx.provide('supremePolicy', …)` in `src/plugins/supreme-policy/index.ts` and the six analogous adapters.
- Real-boot proof that the names resolve in the real context: `dsh-supreme/real/boot.mjs` probes all seven names plus seven upstream names via `ctx.get()`; `BOOT_PROBE` markers in `dsh-supreme/data/real/boot-probe-{core,standard}.markers.jsonl` show exactly the expected presence sets per composition.
- Keyless synthetic gates `session_canonical`, `policy_loads_and_gates_cost`, etc., resolve the services by these exact names in the real booted tree (`src/plugins/supreme-gate-driver/index.ts`).

## ALTERNATIVES

- **Prefix-free names (`policy`, `router`, …).** Rejected: collision-prone with upstream and with any other plugin ecosystem; a future upstream `ctx.router` would break every composition.
- **Nested namespace object (`ctx.supreme.policy`).** Rejected: Cordis services are top-level registry entries; nesting would fight the resolution model and complicate inject declarations.
- **Using the upstream `Service` class for Supreme plugins.** Rejected: that pattern is upstream's own convention; adopting it would couple Supreme to upstream base-class internals for no benefit and would blur the ownership boundary documented in the canonical ownership table.

## CONSEQUENCES

- Positive: unambiguous ownership in any context; inject declarations read clearly (`inject = ['llm', 'supremePolicy', …]`); the boot probe doubles as a naming regression test.
- Negative: seven new top-level names on the context — accepted, because the `supreme` prefix makes ownership self-evident and the set is frozen.
- Neutral: renaming is a breaking change for compositions, gates, and the API; the namespace is therefore declared frozen (AGENTS.md §1).

## ROLLBACK

A rename is a mechanical, single-pass change: each adapter's `ctx.provide` call, the corresponding `inject` arrays, the boot-probe `PROBED_SERVICES` list, the gate driver, and the suite's plugin table. Roll back by reverting the rename commit and re-running the suite; no data files or configs embed the service names.
