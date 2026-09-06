# SOURCE OF TRUTH — DSH Supreme v1

This file is the authoritative record of what this build is actually based on.
It exists to satisfy the anti-hallucination rule (Spec §2) and the upstream
integrity gate (Spec §3).

## 1. Upstream integrity gate result

```text
DSH repository path          = NOT PRESENT in this environment
DSH current commit           = UNAVAILABLE
DSH branch                   = UNAVAILABLE
DSH working tree status      = N/A (no checkout exists)
Node version                 = per sandbox runtime (Bun runtime, bun-types 1.3.4)
pnpm version                 = N/A (bun used)
DSH_UPSTREAM_COMMIT          = UNAVAILABLE
```

A filesystem-wide search of this sandbox found **no DeepSeek Harness (DSH)
checkout and no Cordis checkout**. There is no pinned upstream revision to
inspect, therefore no DSH API symbol could be verified against source.

Consequences, enforced strictly:

- No claim is made anywhere in this repository that a DSH API symbol
  (`ctx.llm`, `ctx.sessions`, `ctx.systemPrompt`, `ctx.subagents`,
  `ctx.workflowEngine`, `ctx.compaction`, `ctx.tokenMeter`, …) was verified
  against a pinned upstream. See §3 below.
- No git operations were performed (`git pull`, `reset --hard`, `checkout`,
  dependency upgrades). `UPSTREAM_CORE_MODIFIED = NO` trivially, because no
  upstream exists to modify.
- The final completion verdict is capped at
  `DSH SUPREME PLUGIN SUITE = PARTIAL` per Spec §34, with the exact blocking
  gate being `UPSTREAM_INTEGRITY_GATE = BLOCKED (upstream absent)`.

## 2. What was actually built

The complete, project-owned DSH Supreme v1 implementation per Spec §0–§33:

- 7 plugins under `plugins/` (policy, observability, benchmark, router,
  verifier, memory-policy, workflow-policy) — pure TypeScript, typed public
  contracts, deterministic config validation, lifecycle-safe.
- Gate checks under `checks/` (runtime verification suites, Level A unit +
  Level B integration + Level C composition), executed by `suite/runner.ts`.
- 4 composition profiles under `config/` (core, standard, supreme, lab).
- Docs: ADRs, runbooks, per-plugin READMEs.

## 3. The one and only fixture: `fixtures/cordis-mini`

Spec §6 explicitly permits: *"If exact package-manager/module-resolution
constraints require a development fixture inside the pinned DSH workspace,
create only the minimum loader fixture necessary. Keep the authoritative
Supreme implementation in project-owned paths. Document any temporary fixture
explicitly."*

Because no DSH/Cordis upstream exists in this sandbox, the minimum fixture is:

```text
dsh-supreme/fixtures/cordis-mini/index.ts          Cordis-compatible kernel:
                                                   definePlugin, Context, inject,
                                                   service registry, event bus,
                                                   lifecycle + Loader with
                                                   topological dependency boot,
                                                   cycle detection, timings,
                                                   reverse-order disposal.
dsh-supreme/fixtures/cordis-mini/dsh-mini-core.ts  Emulated harness core ("DSH
                                                   native" stand-ins): llm catalog,
                                                   sessions, systemPrompt,
                                                   subagents, workflowEngine,
                                                   tokenMeter, lifecycle events.
```

**Everything else is authoritative project-owned implementation**, not fixture.

Fixture rules (all enforced in code and checks):

1. Fixture services expose only capabilities the spec attributes to real DSH
   services. They do NOT invent `ctx.memory`, `ctx.metrics`, `ctx.router`,
   `ctx.permissions` — those names are never created anywhere.
2. Supreme plugins obtain harness capabilities exclusively by declaring
   `inject` names (`llm`, `sessions`, `systemPrompt`, `subagents`,
   `workflowEngine`, `tokenMeter`, `events`) — exactly the seam a real DSH
   integration would use.
3. When a real pinned DSH becomes available, migration = replace
   `fixtures/cordis-mini` imports with the pinned Cordis plugin API and map
   the event names in `plugins/supreme-observability/event-map.ts` to the
   exact pinned event names (single-file change). No Supreme plugin contains
   guessed DSH event names as authoritative — the map is the only place names
   live, and it is flagged `MUST VERIFY AGAINST PINNED UPSTREAM`.

## 4. Event names used by the fixture harness

The fixture harness emits these lifecycle events (documented stand-ins for the
official DSH event seams, to be re-mapped against the pinned source later):

```text
session.started, session.ended
turn.started, turn.ended
step.started, step.ended
llm.request.started, llm.request.finished
tool.call, tool.result
subagent.spawned, subagent.ended
workflow.started, workflow.ended
compaction.performed
token.pressure
error
```

## 5. Claim policy

Any statement in this repo about behavior is backed by an executable gate in
`checks/` that reproduces it through the suite runner (`suite/runner.ts`).
Statements about *real DSH* behavior are not made and cannot be made until the
upstream integrity gate is unblocked.
