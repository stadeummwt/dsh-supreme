# Changelog

All notable changes to DSH Supreme are documented here.

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
