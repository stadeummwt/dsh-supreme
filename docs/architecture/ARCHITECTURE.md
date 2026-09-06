# ARCHITECTURE — DSH Supreme v1

The layer map, the verified real-API evidence, the event seams, and how compositions are layered. Companion documents: [README](../../README.md), [AGENTS.md](../../AGENTS.md), ADRs in [`docs/decisions/`](../decisions/), procedures in [`docs/runbooks/`](../runbooks/).

Pinned basis: `deepseek-harness` @ `d347e703908d0406b7a7ef80e3a0e594d86b2215` (DSH `0.1.3-alpha.1`, vendored cordis `4.0.2`). Every service/event name below was verified against that checkout; line numbers refer to it.

---

## 1. Layer map

```text
┌─────────────────────────────────────────────────────────────────────┐
│ L3 — API / DASHBOARD PROJECTION (project Next.js app, dev/LAB only) │
│  GET  /api/supreme/status        scope + upstream integrity snapshot│
│  GET  /api/supreme/report        last SuiteReport (in-memory)       │
│  POST /api/supreme/suite/run     execute suite — 403 in production  │
│  GET  /api/supreme/suite/runs/:id   one run record                   │
│  Owns NO runtime state. Reads/trigger only. In-memory store ≤ 20.   │
└──────────────────────────────▲──────────────────────────────────────┘
                               │ imports runFullSuite/DSH_COMMIT from
                               │ @dsh-supreme/suite/runner
┌──────────────────────────────┴──────────────────────────────────────┐
│ L2 — SUITE / VERIFICATION (dsh-supreme/src/suite, project-owned)    │
│  cli.ts → runner.ts → engine-checks.ts (Level A, 46 checks)         │
│            └→ spawns real/boot.mjs (Level B/C real boots)           │
└──────────────────────────────▲──────────────────────────────────────┘
                               │ boots + observes
┌──────────────────────────────┴──────────────────────────────────────┐
│ L2 — SUPREME PLUGIN LAYER (dsh-supreme/dist/plugins, project-owned) │
│  Frozen seven: supremePolicy · supremeObservability ·               │
│  supremeBenchmark · supremeRouter · supremeVerifier ·               │
│  supremeMemoryPolicy · supremeWorkflowPolicy                        │
│  Support/fixture: minimal-probe · boot-probe · gate-driver ·        │
│  fake-llm (no model-facing tools)                                   │
│  Cordis plugin shape: name / inject / Config(Standard Schema) /     │
│  apply(ctx, config); ctx.provide services; ctx.effect disposers     │
└──────────────────────────────▲──────────────────────────────────────┘
                               │ inject (hard deps) + ctx.get (optional)
┌──────────────────────────────┴──────────────────────────────────────┐
│ L1 — DSH CORE (pinned upstream — READ-ONLY, patch count 0)          │
│  Services: ctx.llm · ctx.sessions · ctx.systemPrompt ·              │
│            ctx.tokenMeter · ctx.credentials · ctx.subagents ·       │
│            ctx.workflowEngine                                       │
│  Events: session/created · session/disposed · session/event ·       │
│          agent/request · agent/request-error · tools/execute ·      │
│          subagent/start · subagent/end · workflow/start ·           │
│          workflow/end                                               │
│  Runtime: boot() from @deepseek-ai/dsh-app-boot + vendored Cordis   │
│  Loader; root-fiber dispose in reverse order                        │
└─────────────────────────────────────────────────────────────────────┘
```

Dependency direction is strictly upward and acyclic (L1 → L2 services injected; L2 → L3 data flow; nothing injects *into* L1). Internal Supreme edges: `policy → {verifier, router, workflow-policy}`, `observability → {router, verifier(optional), workflow-policy}`, `benchmark → router` **only** (benchmark never depends on router), `verifier → workflow-policy`.

## 2. Verified real-API evidence table

Service names as they exist on the real booted context (probe-verified by `real/boot.mjs` and `supreme-boot-probe`; source-verified in the pinned checkout):

| Service | Pinned source (file · line) | Consumed by (Supreme) |
|---|---|---|
| `ctx.llm` | `packages/llm/llm/src/index.ts` — `llm: LlmRuntime` declared at :55; `registerAdapter` :384; `listProviders(): LlmProviderInfo[]` :466; `listModels` :688; `resolveModelInfo` :726 | router (`listProviders`, `resolveModelInfo`), fake-llm (`registerAdapter`) |
| `ctx.sessions` | `packages/core/session/src/index.ts` — `sessions: SessionStore` declared at the module's Context augmentation; `super(ctx, 'sessions')` at :892 | memory-policy (read-only), gate-driver (`sessions.create()`) |
| `ctx.systemPrompt` | `packages/core/system-prompt/src/index.ts` — `systemPrompt: SystemPrompt` :15; `super(ctx, 'systemPrompt')` :405; `section()` | memory-policy (one conditional section) |
| `ctx.tokenMeter` | `packages/llm/token-meter/src/index.ts` — `super(ctx, 'tokenMeter')` :110 | memory-policy (optional `ctx.get` probe) |
| `ctx.credentials` | `packages/credentials/credentials/src/index.ts` — `super(ctx, 'credentials')` :172 | router (optional `describe()` in `credentialMode: 'service'`, fail-closed) |
| `ctx.subagents` | `packages/subagent/subagent/src/index.ts` — `subagents: SubagentRuntime` :137 | workflow-policy (declared seam only — never started by it) |
| `ctx.workflowEngine` | `packages/workflow/workflow/src/index.ts` — `workflowEngine: WorkflowEngine` :33 | workflow-policy (declared seam only) |

Real-boot proof that these names resolve: `BOOT_PROBE` markers in `dsh-supreme/data/real/boot-probe-core.markers.jsonl` and `boot-probe-standard.markers.jsonl` (per-composition presence maps) and the `services` map printed by every `real/boot.mjs` run.

Upstream framework seams verified and relied upon by every plugin:

| Seam | Pinned source | Supreme usage |
|---|---|---|
| Plugin object (`name`/`inject`/`Config`/`apply(ctx, config)`) | `vendor/cordis/src/registry.ts` (Object plugin, inject shapes) | all 11 plugins |
| `Config` as Standard Schema | `vendor/cordis/src/fiber.ts` (resolved before `apply`; zod 4 compliant) | all 11 plugins |
| `ctx.provide(name, value)` | `vendor/cordis/src/reflect.ts` | 7 service registrations |
| `ctx.effect(execute, label)` — execute runs immediately, **return value is the disposer** | `vendor/cordis/src/fiber.ts` (`Effect = Disposable \| Promise<Disposable>`) | writer flush, store flush, adapter unregister, timers, markers |
| `ctx.get(name)` optional lookup (no inject declaration) | `vendor/cordis/src/reflect.ts` | verifier → observability; memory-policy → tokenMeter; router → credentials |
| Profile patch insert blocks (`cordis.patch.yml`) | `packages/boot/app-boot` (`PROFILE_PATCH_FILENAME = 'cordis.patch.yml'`) | all 5 compositions |

## 3. Event seams used by observability

The exact subscription set, from `src/plugins/supreme-observability/event-map.ts` (`SUBSCRIBED_BUS_EVENTS` + `OBSERVED_LOG_EVENT_TYPES`). Every name carries its pinned-upstream citation in that file; the dispatch modes below are verified.

| Bus event | Pinned source (file · line) | Dispatch | Records emitted |
|---|---|---|---|
| `session/created` | `packages/core/session/src/index.ts` :51 | emit | `session_started` |
| `session/disposed` | same file :61 | emit | `session_ended` |
| `session/event` | same file :73 | emit | per log-type below |
| `agent/request` | `packages/core/agent/src/runtime-types.ts` :289 | waterfall | `llm_request` (provider, model, latency) — `next()` called exactly once |
| `agent/request-error` | same file :305 | waterfall | `llm_request_error` (errorClass) — pass-through |
| `tools/execute` | `packages/core/tools/src/index.ts` :155 | waterfall | `tool_executed` (tool, latency, isError) |
| `subagent/start` | `packages/subagent/subagent/src/index.ts` :163 | emit | `subagent_started` |
| `subagent/end` | same file :172 | emit | `subagent_ended` |
| `workflow/start` | `packages/workflow/workflow/src/index.ts` :43 | emit | `workflow_started` |
| `workflow/end` | same file :89 | emit | `workflow_ended` |

Session-log event types translated inside `session/event` (`OBSERVED_LOG_EVENT_TYPES`): `turn/start`, `turn/end`, `step/start`, `step/end`, `tool/call`, `tool/result`, `assistant/message`, `request/context`, `compaction/start`, `compaction/end`. Unknown types are observed but not recorded — the allowlist stays tight. (`agent/assistant-stream`, declared at `runtime-types.ts` :315, is deliberately **not** subscribed — content must never be serialized.)

Host-side synthetic events recorded via the service (not bus events): `route_decision` (router), `workflow_decision` (workflow-policy), `verification` (verifier, optional), `gate_driver_event` (gate driver).

## 4. Composition layering

Compositions are **profile bundles + patch inserts over absolute dist paths** — no Supreme code is ever copied into the upstream tree.

**Layer 1 — profile manifest.** `real/boot.mjs --setup` generates `$DSH_HOME/profiles/<name>/package.json` declaring the bundle set:

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"], "patchReload": "startup" } } }
```

All profiles except `supreme-minimal` load the `@deepseek-ai/dsh-base` bundle (the DSH core: llm, sessions, system prompt, tools, subagents, workflow, credentials, token meter). `supreme-minimal` declares `bundles: []` — a bare Loader, proving the Loader itself works with zero DSH functionality present.

**Layer 2 — patch inserts.** The composition template `dsh-supreme/config/<name>.cordis.yml` is written verbatim to `$DSH_HOME/profiles/<name>/cordis.patch.yml` (the upstream's `PROFILE_PATCH_FILENAME`) with two placeholders substituted:

- `__SUPREME_DIST__` → `<project>/dsh-supreme/dist/plugins` — so each insert block's `name:` points at the exact built bundle,
- `__PROJECT_ROOT__` → the project root — used for data directories and verifier `allowedRoots`.

Each insert block carries a stable `id`, the absolute module path, and the plugin's config, which the vendored Cordis resolves through the plugin's Standard Schema `Config` before `apply`. Insert order is mount order; composition order respects the inject graph (policy before its consumers, gate-driver last).

**Layer 3 — real boot.** `real/boot.mjs` calls `loadProfile(...)` + `healProfilesModuleFallback(...)`, collects `profile.layers.flatMap(l => l.patches)` plus `profile.patches`, and passes them to `boot('supreme', cordis.yml, patches)` — the same call apps/cli makes. Shutdown is `await ctx.fiber.dispose()` (reverse-order effects; ~20–30 ms), which triggers every plugin's disposer: marker writes, writer flushes, adapter unregistration, timer cleanup.

```text
config/supreme.cordis.yml          (project-owned template)
        │  --setup: placeholder substitution
$DSH_HOME/profiles/supreme/
├── package.json                   (bundle: @deepseek-ai/dsh-base)
├── cordis.yml                     ([])
└── cordis.patch.yml               (insert blocks → dist/plugins/*/index.mjs)
        │  loadProfile + boot()   (REAL pinned Loader)
ctx (root fiber) ──dispose()──► all effects unwound in reverse order
```

The five verified compositions and their service-presence expectations are tabulated in the README; per-profile boot procedures, expected timings (supreme-minimal ≈ 60 ms; core/standard/supreme/lab ≈ 750–900 ms), gates, and marker files are in the boot runbooks.
