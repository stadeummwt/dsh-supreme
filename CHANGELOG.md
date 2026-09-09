# Changelog

All notable changes to DSH Supreme are documented here.

## 1.3.1 — Review-hardening (branch `review/v1.3.1`)

Response to an external v1.3.0 review: five findings **reproduced before
patching** (failing test on the original code), fixed, and proven, plus three
improvement areas. Per-issue evidence — reproduction commands, root causes,
before/after outputs, remaining limits, rollback (bash + PowerShell) — in
[`docs/REVIEW-FIXES-v1.3.1.md`](./docs/REVIEW-FIXES-v1.3.1.md). No upstream
change (`d347e703` untouched, patches=0); no new dependencies; no gate
weakened.

**Fixes (each proven by a standalone verifier, 465 probes total):**
- **FIX-A (P1)** cost policy now enforced PRE-dispatch on LLM requests:
  `agent/request` consult + `llm/stream` backstop (pinned seam, now in
  `OFFICIAL_SEAMS` with citation); deny throws before `next()` → zero adapter
  calls; UNKNOWN/unlisted models denied in production RM0; LAB exception
  contract unchanged; free-claim evidence metadata (source/checkedAt/status).
  → `V131_COST_FIX_VERIFIED` (37 probes).
- **FIX-B (P1)** verifier `allowedRoots`: native realpath validation of roots
  AND targets before any content read; traversal, sibling-prefix, missing
  files rejected; check-vs-open race reduced and documented (NOT race-proof);
  Linux tested, Windows untested. → `V131_VERIFIER_FIX_VERIFIED` (43).
- **FIX-C (P1)** memory isolation: selections bound to (session, task);
  unknown identity → empty section (no latest-fallback); bounded LRU
  (cap 128) + release on task end/cancel/dispose; shared project knowledge
  stays opt-in. → `V131_MEMORY_FIX_VERIFIED` (88).
- **FIX-D (P2)** A2A contact guard no longer misfires on ordinary tools:
  trusted comms-tool registry (default set + `commsToolNames`) gates recipient
  extraction; post-fact emits remain detect-only; malformed comms calls get an
  explicit reason. → `V131_A2A_FIX_VERIFIED` (63).
- **FIX-E (P2)** JSON Schema validation no longer false-PASSes:
  deterministic validator enforces `additionalProperties` (bool+schema),
  items, composition, bounds; unsupported keywords → `ERROR`/`UNAVAILABLE`
  with a reason, never silent downgrade; remote `$ref` → `UNAVAILABLE`.

**Improvements (§3 of the review):**
- **Evidence-bound verification** (IMP-V): PASS records carry
  taskId/attempt/artifact-hash; stale evidence invalidated on artifact change;
  HIGH-risk closes need current evidence; verifier unavailable → explicit
  `UNAVAILABLE`; confidence/trace length can never substitute evidence.
  → `V131_EVIDENCE_BINDING_VERIFIED` (82).
- **Outcome-based routing + fast path/recovery** (IMP-R): per-(candidate,
  taskClass) scoring = freshness-decayed Wilson lower bound (formula
  documented); outcome circuit breaker (consecutive failures → open, half-open
  probe) fed by `agent/request-error`; deterministic failure classification
  (rate_limit/timeout/credential/verifier); bounds (`maxRetries` 3,
  `maxFanout` 4, `wallClockBudgetMs` 0=off); cross-provider fallback plan
  restricted to verified-free candidates; deterministic fast path skips
  fanout for simple tasks; checkpoint/resume gated on current artifact hashes
  (no side-effect repetition); `task_latency` event (durations only). Also
  fixed dead wiring: `classSamples()` was never exposed by the benchmark
  service, so class-aware scoring was inert at adapter level.
  → `V131_OUTCOME_ROUTING_VERIFIED` (80).
- **Failure injection & regression harness** (IMP-T): timeout, provider
  unavailable, corrupted evidence, cancellation scenarios + adversarial/benign
  guard pairs + audit-metadata canary bounds; deterministic fixtures under
  `tests/fixtures/`. → `V131_FAILURE_INJECTION_VERIFIED` (72).

**Suite:** 78 → **101 Level-A checks** (policy 17, observability 7,
benchmark 11, router 23, verifier 11, memory 13, workflow 19), all PASS;
full real-loader suite **101/101 + 5/5 boots → `VERDICT COMPLETE`**
(boots 51–986 ms measured; sentinel leaks 0; router ≈ 0.038 ms/1k).
New script: `bun run v131:verify` (all 7 markers). Shipped `dist/` rebuilt
for the six touched plugins with the exact CI command.

## 1.3.0 — ASTRA-hardening (v1.3)

Seven deterministic hardening features from the ASTRA-1 backlog
([`research/gpt6-astra-2026-09.md`](./research/gpt6-astra-2026-09.md) §7 —
Sol fail mode #1: retry-around-deny; Astra residual: broader permission than
the task requires; sandbagged benchmark claims). Every feature binds to a real
pinned upstream seam, ships engine checks, and is proven end-to-end by three
dedicated verifiers. Zero new plugins, zero new dependencies, upstream still
unpatched.

### Added — supreme-policy (4 features)

- **CoT visibility profiles + risk-gated CoT** (`cotVisibilityProfiles`,
  `riskGatedCoT`): a route declared `cotVisibility: none` (Astra-class models
  legitimately produce empty traces) NEVER denies on `cot_missing` — ENFORCE
  downgrades to audit-only (`COT_VISIBILITY_NONE_DOWNGRADED`). Resolution
  order: explicit signal > route profile > `verbose` default. With
  `riskGatedCoT`, ENFORCE applies only to HIGH-risk tools (deterministic
  command/network/write name classifier); non-HIGH tools keep AUDIT.
- **Deny-circumvention guard** (`denyCircumventionGuard: true` — the one
  deliberate default-ON): after a deny on `tools/pre-execute`, a same-shape
  retry (tool name + argument NAMES/TYPES signature — values can never enter
  it) is refused with reason code `deny_retry` + audit event. First-time calls
  are never affected; `resetDenyCircumvention(sessionId)` is the documented
  operator escape hatch.
- **Encoding-blob taint scan** (`enableEncodingScan: false` default): detects
  ≥256-char contiguous base64/hex runs in tool arguments (hex is more specific
  and reported first; one class per string keeps reports deterministic).
  Extends the v1.2 taint surface — same `taint_detected` event, same
  `taintPolicy` enforcement, same value-free rule (argument NAME + run LENGTH
  only; without encoding hits the detail is byte-identical to v1.2).
- **Capability-class gate** (`capabilityClassGate: 'OFF'` default,
  `sanctionedCapabilityClasses`, `labCapabilityClassAllowlist`): requests
  carrying the shared `CapabilitySignal.capabilityClass` label are gated
  OFF/AUDIT/ENFORCE. The LAB allowlist is ADDITIVE and binds only on the LAB
  floor (no leak to STANDARD); there is NO implicit `ROUTINE` exemption — a
  self-declared label can only RESTRICT, never grant.
- Shared contract exported: `CapabilitySignal { capabilityClass?, cotVisibility? }`
  (type-only import in the router — no runtime coupling).

### Added — supreme-workflow-policy (2 features)

- **A2A contact policy** (`agentContactPolicy: 'LOG_ONLY'`,
  `allowedContacts`): the DECLARED contact graph is a directed `{ from, to }`
  edge list (trim-exact ids/roles; empty graph = policy inert).
  Out-of-graph inter-agent contacts (spawn/message) are audited as
  `a2a_contact`; under `DENY` the pre-fact `tools/pre-execute` waterfall
  refuses the call with `a2a_contact_denied`. Emit-mode lifecycle seams
  (`subagent/start`, `workflow/agent-start`) are post-fact and DETECT-only.
- **Overreach audit** (`maxRiskLevel: 'HIGH'`, `approvalRequiredFor`):
  delegation requests above the risk ceiling (explicit level or tool-name
  derived, MEDIUM delegation tier added), listed task classes without an
  approval flag, or paths outside the v1.2 scope are audited as
  `overreach_suspected` — labels, levels, flags, config globs; never content.

### Added — supreme-router + supreme-benchmark (1 feature, two halves)

- **Anti-sandbagging routing**: benchmark score claims are flagged
  `evidenceBacked: false` unless the scored run carries verifier-PASS evidence
  (`requireEvidenceForScores: false` default; last-write-wins re-evaluation
  when verification lands late; `scoredSamples`/`evidenceBackedScores` added
  to aggregates and the published JSON schema). The router applies a FIXED
  multiplicative downweight `unscoredEvidenceWeight` (default `1` =
  back-compat; e.g. `0.5` halves unevidenced claims) and records the ids +
  factors on the decision (`unscored_evidence` events carry ids only). The
  router also carries the shared `CapabilitySignal` labels from candidates
  onto the selected `RouteDecision` (carrier, not enforcer).

### Added — suite, compositions, surface audit

- **+17 Level-A engine checks** (policy +7, observability +1, benchmark +2,
  router +3, workflow +4): every v1.3 feature is now exercised at engine
  level in the keyless suite — **78/78 checks** (was 61).
- **`real/v13-policy-verify.mjs`** (`bun run v13:verify` runs all three) —
  85 probes: `V13_POLICY_E2E_COMPLETE`; **`real/v13-workflow-verify.mjs`** —
  82 probes: `V13_WORKFLOW_E2E_COMPLETE`; **`real/v13-routing-verify.mjs`** —
  17 probes: `V13_ROUTING_E2E_COMPLETE`. All run the REAL engines + REAL
  pinned-cordis adapters (no upstream build needed).
- **Composition fragments** now showcase the v1.3 keys with safe defaults:
  standard/supreme run the new policy layers audit-only; lab demos ENFORCE +
  LAB allowlist, the CoT-visibility profile, `unscoredEvidenceWeight: 0.5`
  and a declared contact graph; core pins the deliberate default-ON
  deny-circumvention guard. Production rows stay behavior-conservative.
- **Surface-audit sync**: the pinned-verified `workflow/agent-start` seam
  (packages/workflow/workflow/src/index.ts:68 @ d347e703) was added to
  `OFFICIAL_SEAMS` and the observability pinned-event map; the workflow
  adapter's registration is a string literal again (the v1.2
  disclosed-constant workaround removed).
- `dist/plugins/` rebuilt for the four touched plugins (supreme-policy,
  supreme-workflow-policy, supreme-router, supreme-benchmark) — real-boot
  gates run against the v1.3 code.

### Verified status (v1.3)

- Suite: **78/78 Level-A checks, 5/5 real-loader boots, VERDICT COMPLETE**
  (config hygiene + pinned refs + six-surface audit + schema contract all
  PASS; sentinel leaks 0).
- E2E: `V13_POLICY_E2E_COMPLETE` (85/85) · `V13_WORKFLOW_E2E_COMPLETE`
  (82/82) · `V13_ROUTING_E2E_COMPLETE` (17/17) · `BUNDLE_E2E_COMPLETE` ·
  `COMPOSITIONS_E2E_COMPLETE` · `V3_CONFIG_REVIEW_EVIDENCE` ·
  `V12_E2E_COMPLETE` — upstream untouched (`patches=0`).

## 1.2.4 — CI fix 2: upstream resolution in published/CI layout

Follow-up to 1.2.3's CI fixes: the full-suite job then reached the suite but
every boot failed with `UPSTREAM_CHECKOUT_UNAVAILABLE` even though the pinned
upstream had just been cloned and built successfully.

### Root cause

`resolveRoots()` treats "parent contains `dsh-supreme/`" as the monorepo
signature. A GitHub Actions checkout lives at `<ws>/dsh-supreme/dsh-supreme`
— the repo dir is itself named `dsh-supreme` — so the published layout
resolved `PROJECT_ROOT` one level too high, and every `PROJECT_ROOT`-relative
upstream candidate missed the workflow's `../deepseek-harness` clone.

### Fixed

- `resolveDshRoot` (runner + `real/boot.mjs` + the four `real/*verify.mjs`)
  gained two **SUPREME_ROOT-relative candidates**, correct in BOTH layouts:
  monorepo → `<project>/node_modules/.upstream/deepseek-harness`;
  published CI → `<ws>/dsh-supreme/deepseek-harness` (the workflow clone dir).
  The monorepo self-match signature is deliberately kept (an initial
  self-match exclusion broke the monorepo layout — caught by regression
  before push, documented here for honesty).

### Verified (three real layouts)

1. Monorepo: `bun run suite` → **VERDICT COMPLETE**, 61/61 checks, 5/5 boots
   (58–909 ms), exit 0 — no regression.
2. Published/CI layout (full repo copy at `<tmp>/work/dsh-supreme/dsh-supreme`)
   with sibling upstream present → sibling resolved (`UPSTREAM_CHECKOUT_UNAVAILABLE`
   gone; only the honest commit-check blocker for a stand-in dir).
3. Same layout without upstream (= CI keyless state) → `suite:keyless:ci`
   exit 0 with exactly the documented blockers.

## 1.2.3 — CI: make both jobs honestly green

Fixes for the first two failing CI runs (`full-suite` at 34 s, `keyless-suite`
at 6 s). Suite semantics for humans are unchanged; the CI-side expectations
now encode the documented outcomes instead of fighting them.

### Fixed

- **full-suite** failed at upstream build (`0/217 refs`) because the workflow
  cloned the pinned upstream but never installed its dependencies —
  `./node_modules/typescript/bin/tsc` did not exist. New step installs the
  pinned upstream deps via **corepack + the upstream's own `packageManager`
  pin** (the exact flow proven during the sandbox re-verification), before
  `build:upstream`.
- **keyless-suite** failed because the keyless verdict is honestly `PARTIAL`
  (real boots skipped) and the CLI exits non-zero on any blocking gate — the
  job treated the documented outcome as failure. New `--expect-partial` CLI
  flag + `suite:keyless:ci` script: exit 0 iff verdict is `PARTIAL` and every
  blocking gate is inside the documented upstream-absence pair
  (`REAL_BOOT_SKIPPED`, `UPSTREAM_CHECKOUT_UNAVAILABLE`); ANY real failure
  (`UNIT:*`, `SECRET_SENTINEL_LEAKS`, hygiene/audit/schema findings) still
  exits 1 and fails CI.
- keyless job now also pins Node 24 (was the runner default).

### Verified

- Local real run: `bun run suite:keyless` → `VERDICT PARTIAL`, exit 1
  (unchanged honest default); `bun run suite:keyless:ci` → exit 0 with only
  the permitted blockers.

## 1.2.2 — README overhaul (showcase-grade, evidence-bound)

Full README redesign for ecosystem presentation. **No code changes** —
plugins, suite verdicts and E2E evidence are untouched from 1.2.1.

### Changed

- New hero section (centered badge wall, positioning line, anchor nav) +
  "Why Supreme" positioning table grounded in the 2026-09 ecosystem research
  (3,421 catalog entries reviewed; single-domain tools vs full-stack
  governance with executable proof).
- "60-second install" section up front: one-line bundle install + safe
  defaults + one-line composition fragments.
- **Proof wall**: all five runnable verdict commands mapped to what each
  proves (every referenced script + verdict marker verified present in
  `real/` and `package.json`).
- New **Security guarantees** table (guarantee → mechanism → proof), **FAQ**,
  expanded **Honest limitations** (incl. deferred HNSW/Archify, zero-by-default
  router candidates).
- Directory layout updated (compositions/, examples/, suite v1.2 modules);
  documentation map now lists `research/` and `CHANGELOG.md`.
- Reorganized: pinned upstream + compositions under Architecture; build &
  verify instructions consolidated under "Build & verify from source".

## 1.2.1 — distribution policy correction (manual, owner-driven)

Correction release: a listing PR (#4686) had been opened against
`awesome-dsh-plugin/awesome-dsh-plugin` from a fork on the owner's account.
Per owner policy, no pull requests are opened on third-party repositories on
their behalf — the PR was closed as not-planned (nothing merged) and the fork
was deleted the same day.

### Changed

- **`distribution/` (new)** — `awesome-dsh-entry.yml` (catalog-ready entry,
  validator-conformant keys only) + `SUBMISSION-GUIDE.md` (how dsh-market
  auto-feeds from the awesome-dsh-plugin catalog, pre-flight gate checklist,
  exact manual submission commands, npm-publish note). Listing is now an
  explicit owner-driven manual step.
- README: new "Distribution (manual, owner-driven)" section + directory
  layout entry. Code, plugins, suite verdicts and E2E evidence unchanged
  from 1.2.0 (61/61 checks, 5/5 boots, `V12_E2E_COMPLETE`,
  `BUNDLE_E2E_COMPLETE`, `COMPOSITIONS_E2E_COMPLETE`).

## 1.2.0 — deterministic enforcement + evidence surface (ECC/v3-review backlog implemented)

Every v1.2 feature binds to a REAL pinned upstream seam, ships with engine
checks (61/61 Level-A PASS) and boot-level proof (`bun run v12:verify` →
`V12_E2E_COMPLETE`, 29 assertions through the real CLI install path).
Zero new plugins (frozen scope honored), zero new runtime deps beyond `yaml`
(suite-only), upstream still unpatched.

### Added — supreme-policy

- **Unicode taint scanning** (`enableUnicodeSanitization: true`,
  `logTaintAttempts: true`): deterministic bounded scan of tool arguments for
  zero-width (U+200B–200F), bidi-isolate (U+2060–206F), bidi-override
  (U+202A–202E), BOM (U+FEFF) and tag (U+E0000–E007F) codepoints. Audit events
  carry CLASS NAMES only — values are never echoed.
- **Taint denial** (`taintPolicy: DENY`): refuses tainted tool calls through
  the official `tools/pre-execute` seam (`{ kind: 'deny', reason }` — upstream
  materializes the error result; policy never fabricates tool output). The
  LOG_ONLY default audits without blocking. Rationale: upstream deep-freezes
  tool arguments after logging and allows wrappers to change only
  `exec.signal`, so rewrite-in-place is excluded by the pinned contract —
  detect→audit→deny is the enforceable posture.
- **Chain-of-thought presence gate** (`reasoningTracePolicy: OFF|AUDIT|ENFORCE`):
  tracks per-session reasoning evidence from the pinned `assistant/message`
  events (reasoning content blocks + reasoning-chunks stream records) and
  records `cot_missing` audit events; `ENFORCE` additionally denies that
  session's tool calls. Deterministic audit, NOT prompt injection; unknown
  evidence is never denied; `ENFORCE` is refused on the CORE floor.

### Added — supreme-router

- **RM0-first routing** (`costFirst: true` default): among eligible
  candidates, only the cheapest cost class is scored — `FREE_CONFIRMED` beats
  a rate-limited peer with better benchmark history. Hard-gate evidence for
  ALL candidates is preserved; `costFirstApplied` + `COST_FIRST_*` reason code
  recorded on the decision; `false` restores pure weighted scoring.
- **Deterministic effort pacing** (`effortPacing.enabled`, opt-in): maps cost
  classes to reasoning effort over the pinned `agent/request` seam
  (`LlmCallConfig.reasoningEffort` is upstream-overridable). Levels are the
  pinned DeepSeek adapter set `off/low/high/max`; **escalation fires only on
  verifier FAIL evidence** (`reportVerifierOutcome()` / `effortFor(...,
  { verifierFailed })`), never model self-confidence; a recorded PASS
  recovers. Bounded escalation state (256 keys).

### Added — supreme-workflow-policy

- **Surgical path scope** (`allowedPaths` / `blockedPaths`): zero-dependency
  deterministic globs (`**` crosses segments; `*`/`?` stay in-segment).
  `blockedPaths` always win; an empty allowlist is unrestricted.
- **Verifier-gated close** (`requireVerifierPassOnClose`): HIGH-risk tasks
  close only with recorded verifier PASS evidence (`canCloseTask` +
  `closeGate: VERIFIER_PASS_REQUIRED` on workflow decisions). Honest posture
  for STANDARD where the verifier cannot execute commands.

### Added — supreme-memory-policy

- **Note-Keeping Ledger** (`ledgerEnabled`, opt-in): bounded append-only
  JSONL note store (`ledgerDir`/`ledgerFileName`/`ledgerMaxEntries`) with
  admission validation — credential-bearing notes are rejected, corrupt lines
  counted, memory view trimmed to the newest `maxEntries`.
- **Instinct-style injection gates** (`minConfidence: 0.7`,
  `maxInjected: 6`, `relevanceRanking: true`): deterministic confidence gate +
  hard cap + task-token-overlap ranking (ECC continuous-learning-v2 analogue
  without ML/ANN). Selected notes flow through the standard secret-excluding
  memory selection pipeline as `TASK_RELEVANT` items.

### Added — supreme-benchmark

- **Provenance binding**: run records accept `commitHash` (40-hex sha or
  `UNAVAILABLE`) and `irVersion` (`[A-Za-z0-9._-]{1,32}`); record validation
  rejects malformed values at `startRun` and on replay.

### Added — suite + evidence surface

- **`src/suite/config-hygiene.ts`** — every shipped YAML config row validated
  against the plugin's REAL zod Config schema: unknown keys (which zod would
  silently strip — the trap proven live by `v3:verify`) and value violations
  are blocking findings. Includes the **pinned-ref scan** (external URL/git
  references in shipped configs must carry a 40-hex sha or semver tag).
- **`src/suite/surface-audit.ts`** — six-surface offline security audit
  (AgentShield analogue): prompts · hooks (all `ctx.on` seams must belong to
  the official pinned Events map) · mcp (Supreme ships none) · permissions
  (production configs never enable paid/trial/commands/network/LAB) · secrets
  (sentinel + credential patterns over artifacts/dist) · agent_files (every
  delegation scope pins `secretPolicy: 'DENY_ALL'`).
- **`schemas/`** — published JSON Schemas for the SuiteReport, benchmark
  records and ledger notes; a schema-contract check keeps them in sync with
  the runtime (drift = blocking gate). Third parties can validate `suite:json`
  output.
- **`real/v12-config-verify.mjs`** (`bun run v12:verify`) — END-TO-END proof
  of the v1.2 config surface: real CLI install → user patch carrying EVERY
  v1.2 key → boot → assert every key ARRIVED at its service → functional
  probes (taint scan, effort escalation via verifier FAIL/recover, path
  scope, close gate, ledger append→select, observability write-through).
  Verified: `V12_E2E_COMPLETE`, 29/29 assertions, boot ~0.9 s.
- **`.github/workflows/ci.yml`** — keyless suite on every push/PR plus a full
  suite job (clones the pinned upstream, builds via the batched official
  path, runs 5 real-loader boots). README badges.
- **`LICENSE`** (MIT) + full package metadata (`repository`, `keywords`
  incl. `dsh-plugin`, `homepage`, `bugs`) — `private` flag dropped so npm
  publish becomes possible once an npm token exists (npm mapping requires
  the repository field, which is now present).
- **Fix (v1.1 UX wart)**: `bun run suite` from INSIDE `dsh-supreme/` in the
  monorepo layout no longer fakes `UPSTREAM_CHECKOUT_UNAVAILABLE` — entry-
  script-based root resolution now precedes the cwd rules.

### Verified status (v1.2)

- Suite: **61/61 Level-A checks, 5/5 real-loader boots, VERDICT COMPLETE**
  (config hygiene + pinned refs + six-surface audit + schema contract all PASS).
- E2E: `BUNDLE_E2E_COMPLETE` · `COMPOSITIONS_E2E_COMPLETE` ·
  `V3_CONFIG_REVIEW_EVIDENCE` · `V12_E2E_COMPLETE` — all green, upstream
  untouched (`patches=0`).

## 1.1.0 — dsh.bundle: installable via `dsh plugin add`

### Added

- **`cordis.patch.yml`** (package root) — the `dsh.bundle.patch` manifest target.
  Inserts the seven frozen Supreme plugins as profile rows with `config: {}`
  (every plugin's zod Config defaults fill in: PAID/TRIAL denied, commands and
  network off, zero router candidates). The four support/fixture plugins are
  deliberately NOT part of the bundle.
- **`package.json`** declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
  (v1.1.0). Row `name` values are patch-relative (`./dist/plugins/<p>/index.mjs`),
  anchored to `file://` URLs by the profile composer, so the bundle installs
  from any location without generated paths.
- **`real/bundle-verify.mjs`** (`bun run bundle:verify`) — END-TO-END proof of
  the real install path, no simulation:
  1. runs the REAL `dsh plugin --profile supreme-bundle add <package>` CLI
     (pnpm forwarder + reconciler from the pinned upstream),
  2. asserts the reconciler appended `dsh-supreme` to `dsh.profile.bundles`,
  3. asserts the packed copy carries `cordis.patch.yml` + `dist/`,
  4. writes a USER patch layer override (observability `dataDir`) and boots
     through `loadProfile` + `boot()` — proving bundle rows mount next to
     `dsh-base` and the user layer still wins last write per row id,
  5. creates a REAL session and asserts the event lands in the overridden
     store through the bundle-installed instance,
  6. disposes cleanly via the root fiber.
  Verified result: `BUNDLE_E2E_COMPLETE` — bundles `[@deepseek-ai/dsh-base,
  dsh-supreme]`, 13 services mounted, boot ~0.9 s, dispose ~23 ms.
- **`config/compositions/{core,standard,supreme,lab}.patch.yml`** — the four
  v1 compositions as ready-made overlay fragments for bundle users (the
  bundle-world analogue of manifest-driven install profiles). Each fragment
  UPDATE-patches the bundle rows by id — whole-`config` replacement, and
  `disabled: true` for rows outside the composition — and deliberately omits
  `name` restatement (an update patch's name must match the installed row's
  resolved name verbatim, which is install-location-dependent). Core=policy
  only; standard=+observability/memory-policy/verifier; supreme=all seven
  with the synthetic keyless router pair; lab=all seven + LAB-only overrides.
- **`real/composition-verify.mjs`** (`bun run composition:verify`) — END-TO-END
  proof of the fragments through the real install + boot path: per-composition
  service presence AND absence assertions (disabled rows must not mount),
  plus a write-through proof that the shipped relative `dataDir` default
  lands records in `<cwd>/.supreme-data/observability/`. Verified result:
  `COMPOSITIONS_E2E_COMPLETE` for all four compositions, upstream untouched.
- **`research/ecc-dissection-2026-09.md`** — bedah of `affaan-m/ECC`
  (253,948★): component-by-component relevance analysis for Supreme
  (GateGuard hook profiles, AgentShield 6-surface audit, instinct confidence
  policy, install-profiles manifest → the composition fragments here), an
  improvement roadmap (dsh-market submission, awesome-dsh-plugin PR, JSON
  schemas, v1.2 candidates), and positioning guidance.

### Usage

```sh
# from a checkout of this repo (pnpm file: spec), a git URL also works:
dsh plugin --profile <your-profile> add /path/to/dsh-supreme
# or from GitHub once pushed:
dsh plugin --profile <your-profile> add github:stadeummwt/dsh-supreme
```

The bundle mounts the seven plugins with safe defaults; extend candidates,
knowledge, and limits from your own profile patch layer (`last write wins`
per row id). Verify an install with `bun run bundle:verify`.

## 1.0.0 — v1 release (pinned upstream `d347e703`)

### Verified (executable gates, `bun run suite`)

- **Seven Supreme plugins** (supreme-policy, supreme-observability, supreme-benchmark,
  supreme-router, supreme-verifier, supreme-memory-policy, supreme-workflow-policy):
  46/46 Level-A unit checks PASS.
- **Real DSH Loader integration**: minimal probe gate (load / observable effect /
  dispose / loader) PASS through `boot()` from `@deepseek-ai/dsh-app-boot` at the
  pinned commit.
- **Five compositions** boot through the real Loader and dispose cleanly:
  `supreme-minimal`, `core`, `standard`, `supreme`, `lab`.
  - core mounts policy only (DSH core + `supremePolicy`).
  - standard adds observability, verifier, memory-policy.
  - supreme + lab mount all seven; keyless synthetic end-to-end scenario
    **9/9 gates PASS** (real DSH session created, PAID route denied by policy,
    router selects eligible free route, verifier executes, memory budget
    respected, workflow limits respected, observability writes safely).
- **Benchmark-informed routing** demonstrated live: router score improved
  0.6925 → 0.8125 as synthetic-free samples accumulated across runs.
- **Security**: secret-sentinel leaks = 0; paid automatic fallback = DISABLED;
  production configs never set `allowPaid`.
- **Upstream integrity**: commit unchanged, worktree clean, `UPSTREAM_PATCH_COUNT = 0`.

### Platform

- Pinned upstream: `deepseek-ai/deepseek-harness` @ `d347e703908d0406b7a7ef80e3a0e594d86b2215`
  (master, `dsh@0.1.3-alpha.1`, vendored cordis `4.0.2`).
- Official upstream build path supported on memory-constrained hosts via
  `real/build-batched.sh` (same tsconfig graph, per-reference `tsc -b` invocations).
- Both layouts verified end-to-end: monorepo (`dsh-supreme/` inside an app
  workspace) and standalone repo root.
- Companion Next.js dashboard/API is a **projection only** (dev/LAB);
  it owns no runtime state.

### Honest limitations

- No security audit has been performed; experimental software.
- `cordis-mini` fixture is lifecycle-test-only and is never cited as
  DSH-compatibility evidence.
- Public benchmark categories beyond the keyless synthetic scenario are future work.
