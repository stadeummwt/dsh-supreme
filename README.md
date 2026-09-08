# DSH SUPREME v1.1

**Seven host-side policy plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), composed through DSH's vendored Cordis runtime — installable as a [`dsh` bundle](#install-as-a-dsh-bundle-v11) since v1.1.**

DSH Supreme adds governance — cost/risk policy, observability, benchmark evidence, model routing, deterministic verification, memory selection policy, and workflow limits — **without modifying a single line of the pinned upstream**. Every Supreme plugin is an ordinary Cordis plugin (`name` / `inject` / `Config` / `apply(ctx, config)`) that mounts next to the DSH core and consumes official DSH services and event seams.

> **Authoritative record:** [`SOURCE-OF-TRUTH.md`](./SOURCE-OF-TRUTH.md) records the build's upstream basis. The historical "upstream absent" gate recorded there was **unblocked** during Task 2: the real upstream was located, cloned, and pinned. See [Pinned upstream](#pinned-upstream) below — this README documents only behavior verified against that pin.

---

## Pinned upstream

| Item | Value |
|---|---|
| Repository | `https://github.com/deepseek-ai/deepseek-harness` |
| Pinned commit | `d347e703908d0406b7a7ef80e3a0e594d86b2215` (master, tag `dsh-v0.1.3-alpha.1`) |
| DSH version | `0.1.3-alpha.1` |
| Vendored Cordis | `4.0.2` (`vendor/cordis`) |
| Upstream worktree | kept **pristine** — `UPSTREAM_CORE_MODIFIED = NO`, patch count `0` |
| Toolchain | Node v24 (v24.19.0), pnpm 11.7.0, Bun 1.3.14 (bundler) |

The pinned upstream checkout is **read-only** for this project. It is resolved at runtime: `DSH_UPSTREAM_ROOT` env override → sibling `../deepseek-harness` → in-project `node_modules/.upstream/deepseek-harness`. Prefer the sibling location: some upstream builds (pnpm + declaration emit) reject checkouts nested under a `node_modules` directory. All Supreme code lives in project-owned paths.

## Frozen plugin scope

Exactly **seven Supreme policy plugins**. This scope is frozen (see [AGENTS.md](./AGENTS.md)); no new Supreme plugins may be added without a proven blocker.

| # | Plugin (directory) | Provided service | Purpose |
|---|---|---|---|
| 1 | `supreme-policy` | `supremePolicy` | Cost-class / risk / delegation admission. UNKNOWN cost ⇒ DENY, hard rule. Paid/trial overrides are LAB-only. |
| 2 | `supreme-observability` | `supremeObservability` | Append-only JSONL metadata log over official DSH event seams. Allowlisted fields, secret-sentinel scrub, fail-open. |
| 3 | `supreme-benchmark` | `supremeBenchmark` | Reproducible task/run/score evidence as JSONL; per-model aggregation consumed by the router. |
| 4 | `supreme-router` | `supremeRouter` | Deterministic route selection: 8 hard gates → normalized weighted scoring. No paid fallback. |
| 5 | `supreme-verifier` | `supremeVerifier` | Deterministic validator registry (exact-text, regex, JSON, file, command). Evidence > model self-confidence. |
| 6 | `supreme-memory-policy` | `supremeMemoryPolicy` | Memory *selection policy* only. DSH `ctx.sessions` stays canonical; NOOP long-term provider is a legitimate state. |
| 7 | `supreme-workflow-policy` | `supremeWorkflowPolicy` | When/how `ctx.subagents` / `ctx.workflowEngine` may be used: limits, degradation ladder, `DENY_ALL` secret policy. |

Four **support plugins** (not part of the frozen seven, fixture-classified, no model-facing tools):

| Plugin | Role |
|---|---|
| `supreme-minimal-probe` | Task 2 real-loader gate: writes `MINIMAL_PLUGIN_LOAD` / `MINIMAL_PLUGIN_OBSERVABLE_EFFECT` / `MINIMAL_PLUGIN_DISPOSE` markers. |
| `supreme-boot-probe` | Writes a `BOOT_PROBE` marker ~600 ms after activation listing which services exist in the real booted context. |
| `supreme-gate-driver` | Runs the keyless synthetic end-to-end scenario and writes the 9 `SUPREME_GATES` results (supreme/lab compositions). |
| `supreme-fake-llm` | LAB-only scripted LLM adapter (`synthetic-free`) registered through the official `ctx.llm.registerAdapter()` seam. |

## Verified status

Claims below are backed by executable gates. Re-run them with the suite (next section); do not trust prose.

```text
Level A unit checks      46/46 PASS   (policy 6 · observability 5 · benchmark 5 · router 10
                                       verifier 7 · memory 5 · workflow 8)
Real-loader boots        5/5 PASS     (supreme-minimal, core, standard, supreme, lab)
  boot times             supreme-minimal ~60 ms · core/standard/supreme/lab ~750–900 ms
  dispose                ~20–30 ms, clean root-fiber unwind
Keyless scenario         9/9 gates PASS in supreme + lab (real DSH session created;
                         router selects synthetic free route — latest markers record
                         score=0.8125; PAID candidate rejected by policy_cost)
Security                 sentinel leaks = 0 · paid automatic fallback = DISABLED ·
                         production configs never set allowPaid
Upstream integrity       commit unchanged, worktree clean, patches = 0
Performance              router decision ~0.02 ms / 1k iterations ·
                         observability serialize ~0.003 ms / 1k
VERDICT                  COMPLETE (suite runner, per Spec §34)
```

**Important honesty rule:** the real-loader path via `real/boot.mjs` is the **only** real-integration evidence. The Level-A lifecycle harness under `src/harness/cordis-mini` is a fixture that exercises plugin lifecycles; it **never** proves DSH compatibility and is never cited as such.

## Quick start

Prerequisites: Node ≥ 24, pnpm 11.7.0 (upstream build), Bun ≥ 1.3. Commands below assume the repo root (`dsh-supreme/` as published; inside the companion Next.js workspace the suite auto-detects both layouts).

```bash
# 1. Install dependencies
bun install

# 2. Clone the pinned DSH upstream (default lookup: sibling ../deepseek-harness;
#    any location works via DSH_UPSTREAM_ROOT — avoid nesting it under node_modules)
git clone https://github.com/deepseek-ai/deepseek-harness.git ../deepseek-harness
git -C ../deepseek-harness checkout d347e703908d0406b7a7ef80e3a0e594d86b2215

# 3. Build the pinned upstream libraries — official tsconfig graph, memory-batched
#    per reference (one tsc -b over the 217-ref host graph needs ~4 GB headroom;
#    the batched runner keeps each invocation under 2 GB)
npm run build:upstream

# 4. Bundle every Supreme plugin to dist/ (one ESM file per plugin; zod external)
PLUGINS="supreme-policy supreme-observability supreme-benchmark supreme-router \
supreme-verifier supreme-memory-policy supreme-workflow-policy \
supreme-minimal-probe supreme-boot-probe supreme-gate-driver supreme-fake-llm"
for p in $PLUGINS; do
  bun build src/plugins/$p/index.ts \
    --outfile dist/plugins/$p/index.mjs \
    --format esm --target node --external zod
done
```

Each dist bundle externalizes only `zod` and Node builtins; `@deepseek-ai/cordis` appears solely as erased type imports. This exact command was verified to reproduce the committed `dist/plugins/supreme-policy/index.mjs` byte-for-byte.

### Real boot (the only real-integration evidence)

```bash
# Boot any composition through the REAL pinned DSH Loader and dispose cleanly.
# --setup installs the profile under $DSH_HOME/profiles/<name>/ from config/.
node real/boot.mjs --profile supreme-minimal --setup
node real/boot.mjs --profile core         --setup
node real/boot.mjs --profile standard     --setup
node real/boot.mjs --profile supreme      --setup
node real/boot.mjs --profile lab          --setup
```

Each run prints one JSON result (`bootMs`, `disposeMs`, `services` presence map, gate results) and exits non-zero on any failure. Gate markers are appended under `data/real/` — see the [runbooks](./docs/runbooks/) for expected markers per profile.

### Suite execution

```bash
bun run suite            # full suite incl. 5 real boots (needs the built upstream)
bun run suite:json       # machine-readable SuiteReport
bun run suite:keyless    # Level A only — runs without the upstream; verdict stays
                         # PARTIAL (REAL_BOOT_SKIPPED, UPSTREAM_CHECKOUT_UNAVAILABLE)
```

The suite exits `0` only when every mandatory gate passes (`verdict: COMPLETE`). Any failure prints the exact blocking gates.

## Install as a dsh bundle (v1.1)

The repository IS the bundle: `package.json` declares `dsh.bundle.patch` →
[`cordis.patch.yml`](./cordis.patch.yml), which inserts the seven frozen plugins
as profile rows. Any profile can adopt Supreme through the official plugin flow:

```bash
# from a local checkout…
dsh plugin --profile <your-profile> add /path/to/dsh-supreme
# …or straight from GitHub
dsh plugin --profile <your-profile> add github:stadeummwt/dsh-supreme

# prove an install end-to-end (runs the real CLI install + boot + layering checks)
bun run bundle:verify
```

The bundle mounts the seven plugins with safe production defaults
(PAID/TRIAL denied, commands/network off, zero router candidates). Extend
candidates, project knowledge, and workflow limits from YOUR profile patch
layer — the composer applies `last write wins` per row id, so user config
always beats bundle defaults. The four support/fixture plugins
(`supreme-minimal-probe`, `supreme-boot-probe`, `supreme-gate-driver`,
`supreme-fake-llm`) are NOT part of the bundle: they are test fixtures for the
suite and never ship into user profiles.

## Architecture summary

```text
┌────────────────────────────────────────────────────────────────────┐
│  Next.js dashboard (project app) — PROJECTION only, owns no state  │
│  GET/POST /api/supreme/*  (dev/LAB only)                           │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ reads suite reports / triggers runs
┌──────────────────────────────▼─────────────────────────────────────┐
│  SUPREME PLUGIN LAYER (dsh-supreme/dist/plugins, project-owned)    │
│  policy · observability · benchmark · router · verifier ·          │
│  memory-policy · workflow-policy  (+ 4 support/fixture plugins)    │
│  Cordis conventions: name/inject/Config(Standard Schema)/apply     │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ inject: official DSH service names
┌──────────────────────────────▼─────────────────────────────────────┐
│  DSH CORE (pinned upstream — never modified)                       │
│  ctx.llm · ctx.sessions · ctx.systemPrompt · ctx.tokenMeter ·      │
│  ctx.credentials · ctx.subagents · ctx.workflowEngine              │
│  Events: session/* · agent/request* · tools/execute ·              │
│          subagent/* · workflow/*                                   │
└────────────────────────────────────────────────────────────────────┘
```

**Dependency direction (acyclic, enforced):**

```text
DSH core services  →  Supreme plugins        (injected seams)
supremePolicy      →  verifier, router, workflow-policy
supremeObservability → router, verifier (optional), workflow-policy
supremeBenchmark   →  router                 (router reads history; benchmark NEVER depends on router)
supremeVerifier    →  workflow-policy        (verification evidence consulted)
```

Compositions mount subsets per execution profile (`config/*.cordis.yml`):

| Profile | Bundle | Mounted Supreme plugins |
|---|---|---|
| `supreme-minimal` | none (bare Loader) | minimal probe only |
| `core` | `@deepseek-ai/dsh-base` | minimal probe, boot probe, **supreme-policy** (CORE) |
| `standard` | `@deepseek-ai/dsh-base` | + observability, memory-policy, verifier |
| `supreme` | `@deepseek-ai/dsh-base` | all 7 + fake-llm + gate-driver (SUPREME policy) |
| `lab` | `@deepseek-ai/dsh-base` | all 7 + fake-llm + gate-driver, LAB-only overrides (`allowPaid: true`, `allowCommands: true`, `maxConcurrentAgents: 4`) |

Full layer map and the verified real-API evidence table: [`docs/architecture/ARCHITECTURE.md`](./docs/architecture/ARCHITECTURE.md).

## HTTP API (dashboard projection — dev/LAB only)

The Next.js app exposes a thin, read-mostly projection over the suite. It owns **no runtime state**; runs live in an in-memory store (latest 20 runs) and suite execution is disabled in production (`NODE_ENV=production` returns `403` unless `SUPREME_ENABLE_SUITE=1`).

| Endpoint | Method | Behavior |
|---|---|---|
| `/api/supreme/status` | GET | Suite scope (frozen 7 plugins, compositions), upstream commit/cleanliness, DSH/cordis versions, runtime info. Always safe. |
| `/api/supreme/report` | GET | Last `SuiteReport` from memory; `404` if no run yet (`POST /api/supreme/suite/run` first). |
| `/api/supreme/suite/run` | POST | Executes the full suite (including 5 real boots). **dev/LAB only** — `403` in production without `SUPREME_ENABLE_SUITE=1`. |
| `/api/supreme/suite/runs/:id` | GET | One run record (`runId`, `startedAt`, `durationMs`, full report); `404` for unknown ids. |

Implementation: `src/app/api/supreme/**` + `src/lib/supreme-suite.ts` (project app, outside `dsh-supreme/`).

## Directory layout

```text
dsh-supreme/                      (repo root as published)
├── README.md                  ← this file
├── VISION.md                  ← original v1 project vision (frozen architecture contract)
├── CHANGELOG.md
├── AGENTS.md                  ← engineering rules for future agents
├── SOURCE-OF-TRUTH.md         ← upstream integrity record (historical + current)
├── package.json               # suite/boot/build scripts (zod only runtime dep)
├── config/
│   ├── supreme-minimal.cordis.yml   # bare-Loader probe gate
│   ├── core.cordis.yml              # CORE composition
│   ├── standard.cordis.yml          # STANDARD composition
│   ├── supreme.cordis.yml           # SUPREME composition (all 7)
│   └── lab.cordis.yml               # LAB composition (LAB-only overrides)
├── real/
│   ├── boot.mjs               # REAL DSH boot harness (Loader + root-fiber dispose)
│   └── build-batched.sh       # memory-batched official upstream build
├── dist/plugins/<name>/index.mjs    # bun-built ESM bundles loaded by the real Loader
├── data/
│   ├── observability/observability.jsonl   # runtime metadata log
│   ├── benchmark/benchmark.jsonl           # routing evidence store
│   └── real/*.markers.jsonl                # boot/gate markers (verified evidence)
├── src/
│   ├── plugins/               # engine.ts (pure logic) + index.ts (Cordis adapter) per plugin
│   │   ├── supreme-policy/  supreme-observability/  supreme-benchmark/
│   │   ├── supreme-router/  supreme-verifier/  supreme-memory-policy/
│   │   ├── supreme-workflow-policy/
│   │   └── supreme-minimal-probe/  supreme-boot-probe/  supreme-gate-driver/  supreme-fake-llm/
│   ├── suite/                 # runner.ts + cli.ts + engine-checks.ts + harness.ts
│   └── harness/cordis-mini/   # Level-A lifecycle FIXTURE only (never cited as DSH proof)
└── docs/
    ├── architecture/ARCHITECTURE.md
    ├── decisions/ADR-0000 … ADR-0007
    └── runbooks/              # install, build, test, boot-*, upgrade-pinned-dsh, rollback
```

## Documentation map

| Doc | Contents |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | Frozen scope, upstream rules, Cordis conventions, ownership table, verification requirements |
| [`docs/architecture/ARCHITECTURE.md`](./docs/architecture/ARCHITECTURE.md) | Layer map, verified real-API evidence table, event seams, composition layering |
| [`docs/decisions/`](./docs/decisions/) | ADR-0000 (fixture history) + ADR-0001…0007 (one per major decision) |
| [`docs/runbooks/`](./docs/runbooks/) | install, build, test, boot-core/standard/supreme/lab, upgrade-pinned-dsh, rollback |
| Per-plugin READMEs | `src/plugins/<name>/README.md` — purpose, config tables, contracts, security boundaries |
