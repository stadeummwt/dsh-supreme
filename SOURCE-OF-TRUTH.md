# SOURCE OF TRUTH — DSH Supreme v1

This file is the authoritative record of what this build is actually based on.
It exists to satisfy the anti-hallucination rule (Spec §2) and the upstream
integrity gate (Spec §3).

## 1. Upstream integrity gate result — RESOLVED

```text
DSH repository path          = /home/z/deepseek-harness
                               (github.com/deepseek-ai/deepseek-harness, cloned read-only)
DSH current commit           = d347e703908d0406b7a7ef80e3a0e594d86b2215
DSH branch                   = master
DSH release                  = 0.1.3-alpha.1 (root package.json @deepseek-ai/dsh-root)
DSH working tree status      = CLEAN (git status --porcelain empty; verified by the suite runner)
Node version                 = v24.3.0 (engines: ^22.19.0 || >=24.0.0)
pnpm version                 = 11.7.0 (packageManager pin honored)
CORDIS_VERSION_OR_SOURCE     = @deepseek-ai/cordis 4.0.2, vendored at vendor/cordis
                               (upstream pin recorded in vendor/README.md:
                                cordis 4.0.0-rc.7 @ cordiverse/cordis 56b3d4f7)
DSH_UPSTREAM_COMMIT          = d347e703908d0406b7a7ef80e3a0e594d86b2215
```

History: at build start no upstream was present and a documented cordis-mini
fixture was created (ADR-0000). The real repository was then located via web
search, cloned, pinned, built (`pnpm build:lib:host` + `pnpm build:lib:client`,
the official build path), and every plugin was re-authored against the REAL
pinned APIs. The fixture remains ONLY as a Level-A lifecycle harness
(`src/harness/cordis-mini`) and is never cited as DSH-compatibility evidence.

No git operations were performed on the upstream checkout beyond clone and
read-only inspection. `UPSTREAM_CORE_MODIFIED = NO`, `UPSTREAM_PATCH_COUNT = 0`
(verified every suite run; the suite FAILS if the commit changes or the
worktree becomes dirty).

## 2. API evidence map (verified against the pinned source)

Every DSH service consumed by Supreme code, with its pinned source location:

```text
SERVICE = ctx.llm
PACKAGE = @deepseek-ai/dsh-llm
SOURCE_FILE = packages/llm/llm/src/index.ts
EXACT_SYMBOL = LlmRuntime (super(ctx, 'llm') :339)
METHOD_OR_SIGNATURE = listProviders(): LlmProviderInfo[] :466;
                      resolveModelInfo(provider, model, signal?) :726;
                      registerAdapter(providers, adapter) :384
PINNED_COMMIT = d347e703908d0406b7a7ef80e3a0e594d86b2215

SERVICE = ctx.sessions
PACKAGE = @deepseek-ai/dsh-session
SOURCE_FILE = packages/core/session/src/index.ts
EXACT_SYMBOL = SessionStore (super(ctx, 'sessions') :892)
METHOD_OR_SIGNATURE = create(id?, options?): Session :~890
PINNED_COMMIT = d347e703908d0406b7a7ef80e3a0e594d86b2215

SERVICE = ctx.systemPrompt
PACKAGE = @deepseek-ai/dsh-system-prompt
SOURCE_FILE = packages/core/system-prompt/src/index.ts
EXACT_SYMBOL = SystemPrompt (super(ctx, 'systemPrompt'))
METHOD_OR_SIGNATURE = section(section: PromptSection): () => void
                      (PromptSection = { name, order, text | (ctx) => string })
PINNED_COMMIT = d347e703908d0406b7a7ef80e3a0e594d86b2215

SERVICE = ctx.tokenMeter
PACKAGE = @deepseek-ai/dsh-token-meter
SOURCE_FILE = packages/llm/token-meter/src/index.ts
EXACT_SYMBOL = TokenMeter (super(ctx, 'tokenMeter') :110)
METHOD_OR_SIGNATURE = measure(session, requestHeader?): TokenMeasurement
PINNED_COMMIT = d347e703908d0406b7a7ef80e3a0e594d86b2215

SERVICE = ctx.subagents
PACKAGE = @deepseek-ai/dsh-subagent
SOURCE_FILE = packages/subagent/subagent/src/index.ts
EXACT_SYMBOL = SubagentRuntime (super(ctx, 'subagents') :137)
METHOD_OR_SIGNATURE = registerProvider(provider), start(name, request), list()
PINNED_COMMIT = d347e703908d0406b7a7ef80e3a0e594d86b2215

SERVICE = ctx.workflowEngine
PACKAGE = @deepseek-ai/dsh-workflow
SOURCE_FILE = packages/workflow/workflow/src/index.ts
EXACT_SYMBOL = WorkflowEngine, abstract seam (:33; impl = dsh-workflow-worker-thread)
METHOD_OR_SIGNATURE = start(request: WorkflowStartRequest): WorkflowRun
PINNED_COMMIT = d347e703908d0406b7a7ef80e3a0e594d86b2215

SERVICE = ctx.credentials
PACKAGE = @deepseek-ai/dsh-credentials
SOURCE_FILE = packages/credentials/credentials/src/index.ts
EXACT_SYMBOL = CredentialProvider, abstract seam (:172)
METHOD_OR_SIGNATURE = describe(ref): CredentialInfo {configured, source?, writable} — value-free
PINNED_COMMIT = d347e703908d0406b7a7ef80e3a0e594d86b2215

EVENT SEAMS (consumed by supreme-observability; full map with line refs):
packages/core/session/src/index.ts:39-83  (session/created, session/disposed, session/event)
packages/core/agent/src/runtime-types.ts  (agent/request, agent/request-error)
packages/core/tools/src/index.ts:134-179  (tools/execute)
packages/subagent/subagent/src/index.ts   (subagent/start, subagent/end)
packages/workflow/workflow/src/index.ts   (workflow/start, workflow/end)
Session-log event vocabulary: packages/core/session/src/types.ts:260-376
(data-bearing shape: {type, seq, time, data: {...}}; compaction vocabulary is
merged via @deepseek-ai/dsh-session/types module augmentation)
```

Explicitly NOT invented anywhere in this repository: `ctx.memory`,
`ctx.metrics`, `ctx.router`, `ctx.permissions` (the pinned source does not
declare them; permission behavior lives in ctx.approval/permissionPresets).

## 3. Composition mechanism (verified)

- cordis.yml = top-level entry list; DSH profiles compose from patch layers:
  bundle layers (`dsh.bundle.patch`) → profile `cordis.patch.yml` → home layer
  → `--patch` overlays (apps/cli/src/profile-boot.ts, vendor/include).
- Programmatic boot: `boot(binName, absoluteConfigPath, patches?, prepare?)`
  from `@deepseek-ai/dsh-app-boot` — the same call the CLI makes. The
  project-owned harness `real/boot.mjs` uses loadProfile + heal + boot +
  `ctx.fiber.dispose()` exactly like apps/cli/src/profile-boot.ts.
- Plugin conventions: Object plugin `{name, inject, Config, apply(ctx, config)}`;
  Config = any StandardSchemaV1 (zod 4 used; schemastery is the in-repo default);
  `ctx.provide(name, service)` registers; `ctx.effect(execute)` runs execute at
  apply and treats the RETURN VALUE as the disposer; `ctx.on(name, handler)`
  returns an unsubscribe effect.

## 4. Claim policy

Every behavioral claim is reproduced by an executable gate:
`bun run dsh-supreme/src/suite/cli.ts` (46 unit checks + 5 real-loader boots +
sentinel scan + upstream integrity + performance baselines). The current
recorded verdict is `COMPLETE` — see `dsh-supreme/README.md` for the numbers.
Statements about future upstream revisions must be re-verified via
docs/runbooks/upgrade-pinned-dsh.md.

## 5. Re-verification record (post sandbox wipe)

The sandbox was cleaned between sessions and `/home/z/deepseek-harness` (plus
project `node_modules/@deepseek-ai` links) was removed. Full recovery was
performed and every gate was re-executed fresh:

```text
RE-CLONE          = github.com/deepseek-ai/deepseek-harness @ d347e703908d0406b7a7ef80e3a0e594d86b2215 (verified via git log -1)
BUILD             = official tsconfig graph, memory-batched: tsc -b per reference
                    (host 217/217 refs, client 60/60 refs, 0 errors) + tsdown host/client faces
                    [batching only because the sandbox has 3.9 GiB RAM; a single
                     tsc -b over 217 refs OOMs. Same tsconfigs, same graph, per-ref
                     invocations with a fresh 2 GB heap each. No upstream file modified.]
RESOLUTION        = node_modules/@deepseek-ai/{dsh-app-boot,cordis} symlinks recreated
MINIMAL REAL GATE = load=PASS effect=PASS dispose=PASS (fresh run)
4 COMPOSITIONS    = core ok (supreme7=[1000000]), standard ok ([1100110]),
                    supreme ok (9/9 gates), lab ok (9/9 gates), disposeError=null
SUITE             = exit 0, 46/46 unit checks, 5/5 real boots, sentinelLeaks=0,
                    paidAutomaticFallback=DISABLED, patches=0, worktree CLEAN,
                    VERDICT=COMPLETE
DASHBOARD E2E     = browser run: click "Run Full Verification" → COMPLETE rendered,
                    no console errors, no mobile (390px) horizontal overflow
BENCHMARK EVIDENCE = live routing score improved 0.6925 → 0.8125 as synthetic-free
                    samples accumulated 1 → 9 across runs (historical-quality signal,
                    benchmark-informed routing confirmed on the real runtime)
```

## 6. Publication record

```text
REMOTE      = github.com/stadeummwt/dsh-supreme.git (branch main)
PUBLISHED   = subtree of dsh-supreme/ as repo root; head e9f0c56
METHOD      = git subtree split --prefix=dsh-supreme; upstream checkout NOT included
CLONER PATH = fresh clone -> bun install -> clone pinned upstream to ../deepseek-harness
              -> npm run build:upstream -> bun run suite == VERDICT COMPLETE (exit 0),
              verified end-to-end in a scratch clone after push
KEYLESS     = bun run suite:keyless runs without any upstream: 46/46 Level-A checks PASS,
              verdict honestly PARTIAL (REAL_BOOT_SKIPPED, UPSTREAM_CHECKOUT_UNAVAILABLE)
NOTABLE     = upstream builds reject node_modules-nested checkouts (pnpm declaration emit,
              TS2883) -> sibling location is the documented default; tsdown inside such a
              checkout needs --config-loader tsx; tsdown host MUST precede client tsc
```
