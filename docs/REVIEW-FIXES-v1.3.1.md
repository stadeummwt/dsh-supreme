# REVIEW FIXES — v1.3.1 (review/v1.3.1)

Response to the v1.3.0 external code review. Five findings (FIX-A…FIX-E) were
reproduced, fixed, and proven; three improvement areas (§3A–§3D) landed in the
same cycle. **Every number in this document comes from a command executed on
this tree during the v1.3.1 integration run** — the reproduction blocks were
re-derived honestly by stashing the fix (`git stash push -- src/plugins/<area>`)
and running the verifier against the reverted v1.3.0 code, then restoring it
(`git stash pop`; no stashes left behind). Anything not verified by a run is
marked **NOT_VERIFIED** or **NOT_RUN**.

Branch: `review/v1.3.1` (uncommitted at the time of this run; orchestrator
commits). Upstream pin unchanged: `deepseek-ai/deepseek-harness @ d347e703908d`
(suite reports `COMMIT d347e703908d (unchanged=true)`, `WORKTREE CLEAN`,
`patches=0` on every run).

---

## 1. The five review findings

### FIX-A — Cost policy not enforced on LLM dispatch (P1, supreme-router)

**REPRODUCTION** (before fix — router sources reverted to v1.3.0):

```bash
git stash push -- src/plugins/supreme-router
bun real/v131-cost-enforce.mjs repro        # exit 0
git stash pop
```

Observed output (v1.3.0 code):

```text
== FIX-A repro — paid/unknown-model requests sail through without cost checks ==
  agent/request paid    : dispatched=true result={"provider":"synthetic-paid","model":"synthetic-paid-large","_canary":"V131_COST_SECRET_PAYLOAD_canary_42"}
  agent/request unknown : dispatched=true result={"provider":"unlisted-provider","model":"never-allowlisted-model","_canary":"V131_COST_SECRET_PAYLOAD_canary_42"}
  llm/stream paid       : dispatched=true error=none
V131_COST_BUG_REPRODUCED — paid/unknown-model request dispatched with no deny
```

The same reverted tree fails the verify mode with `27 probe(s) failed`
(`V131_COST_FIX_VERIFICATION_FAILED`, exit 1).

**ROOT CAUSE** — the v1.3.0 `agent/request` hook only adjusted
`reasoningEffort`; there was no cost check at dispatch, so paid/unknown-model
requests reached the LLM adapter unchecked. Model-facing cost enforcement
existed only inside `selectRoute`'s candidate gate — not on the request path.

**FIX** — `src/plugins/supreme-router/index.ts` + `engine.ts`:
- New pre-dispatch cost gate (`routeCostGate` → engine `buildRouteCostGate`)
  consulting `supremePolicy.evaluateRoute` (the cost-policy **owner**) with the
  RESOLVED provider/model/cost-class at **both** pinned seams:
  1. `agent/request` (packages/core/agent/src/runtime-types.ts:276-289) — deny
     returns a provider/model-less config; the pinned loop throws BEFORE
     `llm.prepareCall/stream` (agent-loop/src/agent.ts:527-529) — zero adapter
     calls. The waterfall re-fires per retry attempt, so a changed route is
     re-validated at its new key.
  2. `llm/stream` (packages/llm/llm/src/index.ts:58-74 + 1093-1107) — deny
     throws BEFORE `next()` (the backstop for direct `ctx.llm.stream` callers
     the agent/request seam never sees). The seam is now in the suite's
     `OFFICIAL_SEAMS` with the pinned citation (surface-audit gate).
- Fail-closed: missing/unusable policy service ⇒ deny
  (`COST_POLICY_UNAVAILABLE`). UNKNOWN/unlisted model ⇒ deny even if a
  misconfigured policy claimed allow (belt-and-braces rule in the engine).
- Free-claim evidence metadata (`source/checkedAt/status/expiresAt` — no
  credentials) recorded once per route key; `route_cost_denied` /
  `free_route_evidence` audit events carry labels/ids only. LAB exception
  follows the existing policy contract; re-validation runs on every exposed
  upstream path. Engine checks: `policy.route-decision-gate-contract`,
  `router.cost-gate-predispatch`, `router.cost-gate-free-claim-currency`.

**EVIDENCE** (fixed tree):

```bash
bun real/v131-cost-enforce.mjs verify        # exit 0
```

```text
V131_COST_FIX_VERIFIED — cost policy enforced pre-dispatch on every probed path; free/LAB usage intact
```

37 probes PASS (deny before any dispatch on both seams, paid LAB passthrough
intact, free route + effort pacing intact, value-free audits).

---

### FIX-B — Symlink escape bypassed verifier `allowedRoots` (P1, supreme-verifier)

**REPRODUCTION** (before fix — verifier sources reverted to v1.3.0):

```bash
git stash push -- src/plugins/supreme-verifier
bun real/v131-verifier-hardening.mjs repro   # exit 0
bun real/v131-verifier-hardening.mjs verify  # exit 1 (43 cases, 24 failed)
git stash pop
```

Observed output (v1.3.0 code):

```text
  [B] file-hash via out-of-root symlink -> status=PASS reason=OK evidence="sha256 285d9bb26fd2…"
  [B] BUG PRESENT: out-of-root file content was read and hash-verified through a symlink (allowedRoots bypassed).
  [E] extra property vs additionalProperties:false -> status=PASS reason=OK evidence="schema subset ok"
  [E] BUG PRESENT: object with an extra property PASSED although additionalProperties:false.
V131_VERIFIER_BUGS_REPRODUCED
```

Verify mode on the same reverted tree: `cases=43 failed=24` →
`V131_VERIFIER_FIX_FAILED`.

**ROOT CAUSE** — the file validators used `path.resolve()` only: a symlink
*inside* an allowed root pointing *outside* was read and hash-verified because
confinement was checked lexically on the link path, never on the target.

**FIX** — `src/plugins/supreme-verifier/engine.ts` (+ README):
- REAL-path confinement (`resolveRealConfinement`): allowedRoots AND the target
  are resolved through `fs.realpath`; containment is computed with
  `path.relative` and rejects `..`/absolute leftovers — which also kills
  sibling-prefix roots (`/data` vs `/database`). Outcomes map to explicit
  verdicts: missing → FAIL, outside → UNAVAILABLE (confinement),
  unresolvable → ERROR (fail visible). A missing root contributes nothing;
  zero resolvable roots ⇒ outside.
- Race check-vs-open narrowed via stat-after-open dev/ino identity and an
  optional fused open+read+fstat seam (best-effort; **NOT** claimed
  race-proof).
- Windows junctions are handled by realpath semantics but **Windows is
  UNTESTED** (see §4 limits).

**EVIDENCE** (fixed tree):

```bash
bun real/v131-verifier-hardening.mjs verify   # exit 0
```

```text
  cases=43 failed=0
V131_VERIFIER_FIX_VERIFIED
```

43/43 cases; canary B2: out-of-root file content never appears in any output.
Engine check: `verifier.realpath-confinement` (symlink escape + sibling prefix
+ missing/unresolvable + end-to-end UNAVAILABLE through `runValidator`).

---

### FIX-C — Cross-session/cross-task memory contamination (P1, supreme-memory-policy)

**REPRODUCTION** (before fix — memory-policy sources reverted to v1.3.0):

```bash
git stash push -- src/plugins/supreme-memory-policy
bun real/v131-memory-isolation.mjs repro     # exit 0
bun real/v131-memory-isolation.mjs verify    # exit 1
git stash pop
```

Observed output (v1.3.0 code):

```text
== v1.3.1 memory isolation — REPRO on current code ==
  render(as session-B)      = "…[memory:LONG_TERM] LONGTERM_ALPHA
[memory:PROJECT_CONTEXT] PROJECT_SHARED_KNOWLEDGE_canary"
  render(unknown identity)  = "…[memory:LONG_TERM] LONGTERM_ALPHA
[memory:PROJECT_CONTEXT] PROJECT_SHARED_KNOWLEDGE_canary"
  BUG CONFIRMED: session B's render received session A's memory selection.
  BUG CONFIRMED: a request with unknown/missing identity received the stale previous selection.
V131_MEMORY_BUG_REPRODUCED
```

Verify mode on the same reverted tree exits 1 (`V131_MEMORY_FIX_NOT_VERIFIED`).

**ROOT CAUSE** — `latestSelection` was a single field on the plugin instance:
the last selector of ANY session/task overwrote it, and the renderer handed
that stale value to every later render — including renders with an unknown
identity (a fallback that should never exist).

**FIX** — `src/plugins/supreme-memory-policy/engine.ts` + `index.ts`:
- `SelectionStore`: bounded LRU map keyed by the exact `(sessionId, taskId)`
  identity (`identityOf`/`identityKey`); lookups are exact-identity only,
  collision-checked, fail-closed — unknown/missing identity ⇒ `""` (renders
  nothing), never a fallback.
- Active-task pointer per session, set ONLY by that session's own scoped
  select; releasing it never resurrects an older selection.
- Cleanup is real: `releaseTask` / `releaseSession` / task-end / cancel /
  session/disposed seam / plugin dispose empty the store; LRU evictions are
  counted; adapter config cap clamped at the boundary
  (`clampSelectionStoreCap`, floor 8, default 128).
- Shared `projectKnowledge` namespace remains shared **by design** (documented).

**EVIDENCE** (fixed tree):

```bash
bun real/v131-memory-isolation.mjs verify    # exit 0
```

```text
88/88 probes passed
V131_MEMORY_FIX_VERIFIED
```

Engine checks: `memory.identity-fail-closed`, `memory.store-own-selection-only`,
`memory.store-lru-bounded`, `memory.store-cap-clamped`.

---

### FIX-D — Ordinary tools misclassified as A2A contact (P2, supreme-workflow-policy)

**REPRODUCTION** (before fix — workflow-policy sources reverted to v1.3.0):

```bash
git stash push -- src/plugins/supreme-workflow-policy
bun real/v131-a2a-falsepositive.mjs repro    # exit 0
bun real/v131-a2a-falsepositive.mjs verify   # exit 1
git stash pop
```

Observed output (v1.3.0 code):

```text
== FIX-D repro — copy_file { target } misclassified as A2A contact ==
  copy_file decision : {"kind":"deny","reason":"supreme-workflow-policy: inter-agent message outside the declared contact graph (a2a_contact_denied)"}
  action executed    : false
  a2a_contact events : [{"event":"a2a_contact","fields":{"tool":"copy_file","detail":"channel:message:from:agent-a:to:b.txt:reason:CONTACT_OUTSIDE_GRAPH:outcome:DENIED:mode:DENY:origin:tools_pre_execute"}}]
V131_A2A_BUG_REPRODUCED — ordinary copy_file tool call treated as A2A contact
```

Verify mode on the same reverted tree exits 1 (guard reports the missing
v1.3.1 fix surface).

**ROOT CAUSE** — the v1.3.0 `tools/pre-execute` listener extracted a
"recipient" from ANY tool whose arguments happened to contain
`agent_id`/`to`/`target` (identity never established first; sender-only gate),
so `copy_file { target: 'b.txt' }` was denied as inter-agent contact with
`to: b.txt` (a filename treated as an agent id).

**FIX** — `src/plugins/supreme-workflow-policy/engine.ts` + `index.ts`:
- Trusted communication-tool **registry** (`DEFAULT_COMMS_TOOL_REGISTRY`, 12
  frozen entries: pinned upstream spawn/steering tool names + classic
  delegation spellings; `name → fixed channel`). Tool identity is established
  FIRST from the registry; recipient extraction happens only after a call is
  registry-identified — never from argument names alone, never from
  model-provided labels.
- Hosts extend via `commsToolNames` (config, ADD-ONLY — an extension can never
  shadow a pinned default channel or remove one; channel for extensions
  inferred by a fixed spawn-token rule).
- Malformed message-channel calls (no resolvable recipient) get an explicit
  `a2a_recipient_unresolvable` audit and are denied pre-fact only when
  `agentContactPolicy: DENY` (fail-closed; LOG_ONLY audits without blocking).
- Real enforcement is unchanged: out-of-graph comms are denied pre-fact at
  `tools/pre-execute` under DENY; `subagent/start` + `workflow/agent-start`
  emits stay DETECT-only; no argument values in events.

**EVIDENCE** (fixed tree):

```bash
bun real/v131-a2a-falsepositive.mjs verify   # exit 0
```

```text
all 63 probes passed (real engine + real pinned-cordis adapter)
V131_A2A_FIX_VERIFIED
```

Engine checks: `workflow.comms-registry-identity`,
`workflow.a2a-unresolvable-recipient`.

---

### FIX-E — JSON-schema validator false PASS (P2, supreme-verifier)

**REPRODUCTION** — same script/commands as FIX-B (the two findings share
`real/v131-verifier-hardening.mjs`). Observed before fix:

```text
  [E] extra property vs additionalProperties:false -> status=PASS reason=OK evidence="schema subset ok"
  [E] BUG PRESENT: object with an extra property PASSED although additionalProperties:false.
```

(and, in verify mode, 24 of 43 cases failed — including `additionalProperties`
ignored, unsupported keywords silently ignored, non-local `$ref` PASSing,
boolean-false schema PASSing.)

**ROOT CAUSE** — the v1.3.0 subset validator ignored
`additionalProperties: false` (objects with extra properties PASSed) and
silently skipped keywords it did not implement — an unsupported keyword or
dialect degraded to a silent PASS instead of a visible refusal.

**FIX** — `src/plugins/supreme-verifier/engine.ts` (+ README):
- Deterministic in-repo JSON Schema validator (bounded subset, documented
  limits): type / properties / required / additionalProperties (boolean and
  schema forms) / items / enum / const / numeric+string+array bounds /
  pattern / allOf / anyOf / oneOf / not / local `$ref` (`#/…` only).
- `additionalProperties: false` is enforced — extra properties FAIL with the
  property name in the issue.
- Unsupported keyword / dialect / remote `$ref` ⇒ `UNAVAILABLE`
  (`SCHEMA_UNSUPPORTED`) or ERROR (`SCHEMA_INVALID`) with the reason — never a
  PASS. FAIL (subject) / ERROR (schema) / UNAVAILABLE (capability) are
  distinct outcomes; the back-compat `validateJsonSchemaSubset` wrapper can
  never return a silent empty list for a broken schema.

**EVIDENCE** (fixed tree): `bun real/v131-verifier-hardening.mjs verify` →
`cases=43 failed=0`, `V131_VERIFIER_FIX_VERIFIED` (shared with FIX-B). Engine
checks: `verifier.schema-additional-properties`,
`verifier.schema-unsupported-visible`.

---

## 2. Improvements landed (§3A–§3D)

| Area | What landed | Proof |
|---|---|---|
| **§3A Evidence binding** (IMP-V) | Verifier evidence records bound to task identity + artifact bytes (`dsh-supreme/evidence@1`, sha-256); `evaluateEvidenceForClose`/`isEvidenceCurrent` map verdicts (`EVIDENCE_UNBOUND` / `EVIDENCE_NOT_PASS` / `EVIDENCE_STALE` / `EVIDENCE_CURRENT_PASS`); workflow close gate consumes bound records — a HIGH-risk close needs a PASS covering the CURRENT artifact (stale hash, bare status, UNAVAILABLE, label conflict, unbound record all block, fail-closed) | `bun real/v131-evidence-binding.mjs verify` → 82/82 probes, `V131_EVIDENCE_BINDING_VERIFIED`; engine checks `verifier.evidence-close-binding`, `workflow.close-evidence-record-validation`, `workflow.close-gate-evidence-bound` |
| **§3B Outcome routing** (IMP-R §1–§4) | Class-aware per-(candidate, taskClass) scoring with fixed Wilson lower-bound (z = 1.96) + 1-hour freshness half-life, fed from real benchmark history (`classSamples` wiring); outcome circuit breaker (3 consecutive real failures → open → single half-open probe; deterministic `classifyFailure` over pinned upstream codes); bounds + `AttemptLedger` against retry storms (maxRetries 3 / maxFanout 4 / wall-clock OFF by default); cross-provider fallback plan admitting ONLY current-evidence FREE candidates (PAID never planned; empty plan is the honest degradation); deterministic fast path (opt-in, label-driven, risk-gated, fanout 0) | `bun real/v131-outcome-routing.mjs verify` → 80/80 probes, `V131_OUTCOME_ROUTING_VERIFIED`; engine checks `router.class-aware-wilson`, `router.outcome-circuit`, `router.attempt-ledger-bounded`, `router.fallback-verified-free-only`, `router.fast-path-deterministic` |
| **§3C Checkpoint/resume + latency** (IMP-R §5 + §6) | Checkpoint records `{taskId, stepIndex, artifactRefs, artifactHashes, sideEffectsRegistered, status, updatedAt}` append-only in the benchmark-owned `checkpoints.jsonl` (in-memory bounded 1024); `planResumeFromRecords` re-plans from TRUE state — completed+hash-verified steps never redo, stale hashes surface `hashCheck: 'mismatch'` but are NEVER auto-executed (`assertNoRepeatedSideEffects`); end-to-end `task_latency` event (durations only) via observability | same verifier (probes [i]–[j]); engine checks `benchmark.checkpoint-hash-binding`, `benchmark.resume-never-repeats-side-effects`, `benchmark.class-samples-latency` |
| **§3D Failure-injection harness** (IMP-T) | Adversarial/benign paired scenarios over the REAL pinned-cordis adapters: cost-gate guard pairs, symlink verifier, A2A registry, memory isolation + audit-metadata bounds (every record inside the real allowlist, zero canaries in 8 scenario streams) + fixtures under `tests/fixtures/` | `bun real/v131-failure-injection.mjs verify` → 72/72 probes, `V131_FAILURE_INJECTION_VERIFIED` (stable across 3 consecutive runs) |

All improvements are **behavior-preserving at their defaults**: fast path is
opt-in, checkpoints write nothing until used, class-aware scoring activates
only when a request carries a task class, circuit/ledger act only on real
outcome events, evidence binding only tightens closes that opt into
`requireVerifierPassOnClose`.

---

## 3. Suite growth — before/after (measured)

```text
                       BEFORE (v1.3.0)                    AFTER (v1.3.1)
bun run suite:keyless  78/78 PASS                         101/101 PASS
  supreme-policy       16                                 17   (+1 cost-gate contract)
  supreme-observability 7                                 7
  supreme-benchmark     8                                 11   (+3 checkpoint/latency)
  supreme-router       16                                 23   (+7 cost gate + IMP-R)
  supreme-verifier      7                                 11   (+4 realpath/schema/evidence)
  supreme-memory-policy 9                                 13   (+4 identity/LRU/clamp)
  supreme-workflow-policy 15                              19   (+4 registry/close gate)
VERDICT                PARTIAL (REAL_BOOT_SKIPPED only)   PARTIAL (REAL_BOOT_SKIPPED only)
```

Keyless is **honestly PARTIAL by design** (`--skip-real-boots` can never
produce COMPLETE). The full `bun run suite` result for v1.3.1 is recorded in
§5 below. v1.3.1 verifier probes added: 37 + 43 + 88 + 63 + 82 + 80 + 72
(= 465 probes across the 7 v1.3.1 verifiers).

---

## 4. Remaining limits (honest)

- **Windows is untested** for the realpath confinement (FIX-B). Symlink and
  junction resolution is delegated to node `fs.realpath`, but every run here
  was Linux; a Windows smoke test is **NOT_RUN**.
- **Resume hash-checking depends on the host** supplying current artifact
  digests (`currentArtifactHashes`). The engine is deterministic and does no
  fs access of its own; without host-supplied hashes the honest
  `'unverified'` result applies and stale side effects cannot be detected.
- **A2A coverage is registry-based**: only tools in the default registry or
  `commsToolNames` are inspected. A communication tool the host never declared
  is NOT A2A-checked — the host obligation is documented in the plugin README
  and the composition fragments. Coverage of *undeclared* tools is out of
  scope by design (identity must come from a trusted declaration).
- **llm/stream backstop covers stream paths only via the pinned API**: the
  `agent/request` + `llm/stream` waterfalls cover the agent loop (every retry
  attempt), prepared-call dispatches, and direct `ctx.llm.stream` callers
  (compaction summarize, session-title providers). A host that performs
  provider HTTP *outside* `ctx.llm` bypasses Supreme entirely — that is the
  API boundary and is not protectable from inside the harness.
- The **failure-injection harness** uses small real sleeps (≤ 200 ms) for
  circuit cooldown; it was run 3× consecutively with stable results
  (72/72 each). No claim is made beyond those observed runs.
- **Performance claims are bounded to measured runs**: suite-reported
  router ≈ 0.022–0.036 ms / 1k selects and observability ≈ 0.002–0.008 ms / 1k
  serializations on this sandbox. No other performance numbers are claimed.
- **Shared project namespace is by design**: `projectKnowledge` is shared
  across sessions (FIX-C scoping covers session/task *selections*, not the
  project namespace).
- `schemas/benchmark-record.schema.json` was **not extended** with the new
  checkpoint fields (schemas dir treated as frozen in this cycle); checkpoint
  validation is engine-enforced instead.
- The Astra references in this project are **documented motivation only**
  (`research/gpt6-astra-2026-09.md`); no benchmark was run against any Astra
  model and no such claim is made anywhere.

---

## 5. Full verification record (v1.3.1 integration run)

Executed in order on this tree (bun 1.3.14, node v24.19.0 sandbox):

| # | Command | Result |
|---|---|---|
| 1 | `bun run suite:keyless` | **101/101 checks PASS** (policy 17 · observability 7 · benchmark 11 · router 23 · verifier 11 · memory 13 · workflow 19), `VERDICT PARTIAL`, blocking gates = `REAL_BOOT_SKIPPED` only (keyless exit 1 is by design) |
| 2 | `bun run v131:verify` | exit 0 — all 7 markers: `V131_COST_FIX_VERIFIED` · `V131_VERIFIER_FIX_VERIFIED` (43/43) · `V131_MEMORY_FIX_VERIFIED` (88/88) · `V131_A2A_FIX_VERIFIED` (63/63) · `V131_EVIDENCE_BINDING_VERIFIED` (82/82) · `V131_OUTCOME_ROUTING_VERIFIED` (80/80) · `V131_FAILURE_INJECTION_VERIFIED` (72/72) |
| 3 | `bun real/v12-config-verify.mjs` | green (`V12_E2E_COMPLETE`, exit 0) |
| 4 | `bun real/v13-policy-verify.mjs` | green (`V13_POLICY_E2E_COMPLETE`, 85 probes) |
| 5 | `bun real/v13-workflow-verify.mjs` | green (`V13_WORKFLOW_E2E_COMPLETE`, 82 probes) |
| 6 | `bun real/v13-routing-verify.mjs` | green (`V13_ROUTING_E2E_COMPLETE`, 17 probes) |
| 7 | `bun run bundle:verify` | green (`BUNDLE_E2E_COMPLETE`, exit 0) |
| 8 | `bun run composition:verify` | green (`COMPOSITIONS_E2E_COMPLETE`, exit 0) — config-hygiene stays PASS with the new v1.3.1 keys |
| 9 | `bun run v3:verify` | green (`V3_CONFIG_REVIEW_EVIDENCE`, exit 0) |
| 10 | `bun run suite` (FULL, real boots over rebuilt dist) | see result below |
| 11 | `bun run lint` | 0 errors / 0 warnings, exit 0 |

Full-suite (step 10) result: **NOT_RECORDED_YET_AT_DOC_WRITE_TIME — filled
from the live run at the end of the integration pass; if this line still says
NOT_RECORDED, the orchestrator run log is authoritative.**

*(Integration note: steps 1–9 and 11 were executed and recorded during this
session; the full real-boot suite result is appended here by the same session
once the rebuilt dist has been exercised — see the worklog `Task ID: INTG`
entry for the captured output.)*

---

## 6. Rollback + install/test

### Install & test — Linux/macOS (bash)

```bash
git clone https://github.com/stadeummwt/dsh-supreme.git
cd dsh-supreme
git checkout review/v1.3.1        # post-merge: main
bun install
bun run suite:keyless             # 101/101 PASS — VERDICT PARTIAL (REAL_BOOT_SKIPPED only)
bun run v131:verify               # all 7 v1.3.1 verifiers green
bun run suite                     # needs the pinned upstream checkout → VERDICT COMPLETE
```

### Install & test — Windows (PowerShell)

```powershell
git clone https://github.com/stadeummwt/dsh-supreme.git
cd dsh-supreme
git checkout review/v1.3.1        # post-merge: main
bun install
bun run suite:keyless             # 101/101 PASS — VERDICT PARTIAL (REAL_BOOT_SKIPPED only)
bun run v131:verify               # all 7 v1.3.1 verifiers green
bun run suite                     # needs the pinned upstream checkout → VERDICT COMPLETE
```

> **Windows caveat:** the toolchain commands are the same in PowerShell, but
> this release was verified on Linux only; the realpath confinement and the
> real-boot path are UNTESTED on Windows (see §4).

### Rollback to v1.3.0 — Linux/macOS (bash)

```bash
cd dsh-supreme
git checkout main                 # back to v1.3.0
git branch -D review/v1.3.1       # drop the review branch
git checkout -- .                 # discard any uncommitted v1.3.1 edits (restores dist/ too)
git clean -fd real/ tests/ docs/  # remove v1.3.1-only untracked files (v131 verifiers, fixtures, this doc) — review the list first
bun install
bun run suite:keyless             # back to 78/78 PARTIAL
bun run suite                     # COMPLETE on v1.3.0
```

### Rollback to v1.3.0 — Windows (PowerShell)

```powershell
cd dsh-supreme
git checkout main
git branch -D review/v1.3.1
git checkout -- .
git clean -fd real/ tests/ docs/
bun install
bun run suite:keyless             # back to 78/78 PARTIAL
bun run suite                     # COMPLETE on v1.3.0
```

The `git clean` step deletes untracked v1.3.1 artifacts — run
`git clean -nd real/ tests/ docs/` first to preview. No committed history is
rewritten by any rollback step.
