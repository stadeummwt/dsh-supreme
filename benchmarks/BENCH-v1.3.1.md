# BENCH v1.3.1 — A/B/C policy-enforcement benchmark (review §5)

Real, deterministic, offline benchmark comparing three trees on one synthetic
host. It measures the **policy-enforcement delta** between them — nothing
else. It does **not** measure model quality, task success on real workloads,
or "intelligence", and it makes **no comparison to any other product**:

| label | what it is | tree |
|---|---|---|
| **A** | DSH harness WITHOUT Supreme plugins — same synthetic host, nothing mounted | tree-independent (`mountedPlugins: []`; see Methods) |
| **B** | Supreme BEFORE the review patches — the v1.3.0 content | monorepo commit `9732553` |
| **C** | Supreme AFTER the patches — the v1.3.1 review-hardening tree | `e38cab8` (branch `review/v1.3.1`) |
| **D** | Astra reference | **NOT_RUN** — no valid Astra data exists in this repo or environment; the label is reported exactly as NOT_RUN and is never fabricated anywhere in this document |

---

## 1. Headline numbers (reps = 3, 25 scenarios per rep, 75 scenario-runs per label)

Adversarial "escape" events summed across all 3 reps. `n/a` = scenario not
applicable on that label (service absent on the bare harness — always
`n/a` for exactly the same 15 A-scenarios: memory/verifier/schema kinds).

| metric (sum over 3 reps) | A (no plugins) | B (v1.3.0) | C (v1.3.1) |
|---|---|---|---|
| cost_enforcement BYPASS (paid/unknown dispatched) | **30** | **30** | **0** |
| memory_isolation contamination events | n/a | **15** | **0** |
| verifier_symlink ESCAPE (out-of-root PASS) | n/a | **15** | **0** |
| a2a_false_deny FALSE_DENY (benign tool refused) | 0 | **15** | **0** |
| schema_false_pass FALSE_PASS (invalid subject PASSed) | n/a | **15** | **0** |
| **Total adversarial escapes** | **30** | **90** | **0** |
| Benign siblings succeeded | 30/30 applicable (100%) | 75/75 (100%) | **75/75 (100%)** |
| Scenario-set wall clock — median / min–max (ms) | 37 / 18–67 | 82 / 60–107 | 93 / 81–122 |
| Scenario-set wall clock — total over 3 reps (ms) | 122 | 249 | 296 |

Reading of the shape (honest, no embellishment):

- **A** shows what the bare pinned harness does: every paid/unknown-model
  dispatch sails through (30 bypasses) and nothing is denied. Its benign
  denominator is smaller (30 of 75 runs) because memory/verifier/schema
  scenarios are `n/a` without their services — A's 100% is over a different
  denominator and is **not comparable** to B/C's 100%.
- **B** (v1.3.0) enforces *something* but misses every adversarial class the
  review found, and additionally misfires one benign class (the FIX-D
  false deny). Its benign siblings all still succeed — v1.3.0's problem was
  not benign breakage, it was enforcement gaps plus one over-block.
- **C** (v1.3.1) blocks every adversarial probe (0 escapes in 75 runs) while
  keeping every benign sibling succeeding (75/75).
- The wall-clock overhead of the v1.3.1 policy machinery on this host is
  ~10 ms per 25-scenario set over B (median 93 vs 82 ms) — i.e. a few ms per
  scenario including full host mount + dispose. Single machine, see limits.

Full per-scenario table in §4. Raw run JSONs: `benchmarks/runs/bench-run-{A,B,C}-r3.json`.

---

## 2. Methods

### 2.1 Runner

`real/bench-v131.mjs` (bun-runnable):
`bun real/bench-v131.mjs --label <A|B|C> --out <json-path> [--reps 3] [--compare <prev-json>]`.
One rep = one full pass over all 25 scenarios, each on a FRESH cordis context
with fresh tempdirs (cleaned in `finally`). Per-scenario verdicts are
**computed from observed behavior** — no expected verdict per tree is
hardcoded anywhere. Output JSON carries `{label, treeSha, configFingerprint,
scenarios: {perKind, totals, detail}, timing, reps, verdicts}`.

`configFingerprint` is a sha256 over the shared bench design (datasets +
thresholds bytes + drivers + stub services) and is **identical for all three
labels** (`db0af6d1…19e31`), proving the same harness config; only the mounted
plugin code differs (`mountedPlugins` field).

### 2.2 Mounting (the v131 pattern)

The REAL plugin adapters (`src/plugins/<name>/index.ts`) of
supreme-observability, supreme-policy, supreme-verifier, supreme-router,
supreme-memory-policy and supreme-workflow-policy are mounted on the **REAL
pinned cordis** (`@deepseek-ai/cordis`) with the zod Config resolved BEFORE
apply — the identical mounting pattern to the other `real/v131-*.mjs`
verifiers (verified against `real/v131-failure-injection.mjs` /
`real/v131-cost-enforce.mjs`). Stub DSH services (`llm`, `supremeBenchmark`,
`sessions`, `systemPrompt`, `subagents`, `workflowEngine`) are provided in
EVERY label so the drivers are identical. For label A the same host is built
with **nothing mounted** (no Supreme import at all). The REAL observability
adapter writes its REAL JSONL into a per-scenario tempdir.

Label A was executed from the tree-B worktree purely for logistics: label A
imports no Supreme code (`mountedPlugins: []` in the run JSON), so its result
is tree-independent — only the pinned cordis + stub host + drivers matter.

### 2.3 Version-stable surfaces (verified in BOTH trees before the run)

Scenario drives touch ONLY surfaces verified present with identical shapes in
the v1.3.0 (`9732553`) and v1.3.1 (`e38cab8`) trees:

- ctx waterfalls `agent/request`, `llm/stream`, `tools/pre-execute`
  (identical deny shape `{kind:'deny', reason}` in both);
- ctx emit `subagent/start` (byte-identical defensive detect-only handler in
  both trees);
- `verifier.register/run` (v1.3.0 line 38–41; unchanged in v1.3.1) with
  validator types `file-hash` and `json-schema` (both in `VALIDATOR_TYPES` of
  both trees); json-schema subject = JSON string in both;
- `memory.select({taskText, …})` + `registerLongTermProvider` + the
  `supreme-memory-context` systemPrompt section (same name both trees;
  v1.3.0's `text()` ignores the identity argument, v1.3.1's consumes it — the
  SAME call drives both; the `sessionId`/`taskId` keys passed by the bench are
  simply ignored by v1.3.0 and honored by v1.3.1, which is exactly the delta
  under test);
- config keys verified in both trees' zod Configs: router `candidates`,
  workflow `agentContactPolicy`/`allowedContacts`, verifier
  `allowedRoots`/`allowCommands`/`allowNetwork`/`commandTimeoutMs`, memory
  `projectKnowledge`/`registerPromptSection`, observability
  `enabled`/`dataDir`/`fileName`.

Anything uncertain is feature-detected with `typeof` guards; a service that
is absent yields scenario `n/a` rather than a crash. A harness-strictness
guard forces exit 2 if any scenario is unexpectedly `n/a` on a fully-mounted
tree (B or C) — `n/a` can never silently shrink the benign denominator.

### 2.4 Tree B setup

`git worktree add /home/z/my-project/.bench-v130 9732553`. The sandbox
disallows creating symlinks, so no `node_modules` symlink was created — and
none is needed: the worktree sits under the monorepo root
(`/home/z/my-project/.bench-v130/dsh-supreme`), so bun resolves
`@deepseek-ai/cordis` and `zod` by upward traversal to
`/home/z/my-project/node_modules` — the exact layout the current tree uses
(`dsh-supreme/` has no `node_modules` of its own). Resolution was verified
with a direct import probe (`cordis Context: function | zod: function`)
before any run. The runner kit (`real/bench-v131.mjs`, `datasets/bench/`,
`benchmarks/THRESHOLDS-v1.3.1.json`) was copied into the worktree BEFORE
running; runner + datasets + thresholds are byte-identical across trees
(equal `configFingerprint`), only plugin code differs. The worktree was
removed after the runs (§5 cleanup).

### 2.5 Datasets

`datasets/bench/scenarios.dev.json` (2 scenarios per kind = 10) and
`datasets/bench/scenarios.heldout.json` (3 per kind = 15), same schema
(`datasetVersion: dsh-supreme-bench-v1.3.1-1`), disjoint inputs (different
providers/models, sessions/markers, file bodies/link names, tools/graphs,
schemas/subjects). Each scenario carries its INPUT FIXTURE inline plus
**structural expectations only** (e.g. "a benign free dispatch succeeds");
no per-tree expected verdicts exist anywhere in the datasets.

### 2.6 Metric definitions and threshold mapping

Per scenario kind (adversarial escape detector + benign sibling):

| kind | adversarial escape event (computed) | benign sibling (computed) |
|---|---|---|
| cost_enforcement | BYPASS = adapter dispatch count > 0 for a paid/unknown-model seed at `agent/request` or `llm/stream` | free-confirmed dispatch succeeds on its FIRST attempt |
| memory_isolation | contamination = a session's render contains the OTHER session's marker after interleaved selects | each session's own render (right after its own select) contains its own marker |
| verifier_symlink | ESCAPE = PASS verdict on a file-hash validator whose path is an in-root symlink pointing OUTSIDE `allowedRoots` | in-root file-hash with the correct sha256 PASSes |
| a2a_false_deny | FALSE_DENY = the benign ordinary tool (`copy_file {target}`-shaped) is denied at `tools/pre-execute` | in-graph message AND in-graph spawn execute; `subagent/start` emit completes |
| schema_false_pass | FALSE_PASS = PASS verdict for a subject violating `additionalProperties:false` | conforming subject PASSes |

The runner maps these onto `benchmarks/THRESHOLDS-v1.3.1.json` (sha256
`621e95be…b93e6`, written and recorded BEFORE any run was executed):
`maxPolicyBypassC` counts the escape-class events on C (cost BYPASS +
contamination + symlink ESCAPE + schema FALSE_PASS; false denies are the
over-block class with their own threshold), `maxFalseDenyC` /
`maxFalsePassC` count their named events on C, `minBenignSuccessC` is the
benign-success fraction over APPLICABLE siblings on C, and
`noSafetyRegression` compares per-kind adversarial escape counts C ≤ B via
the saved B run JSON (`--compare`). `astraComparison` stays `NOT_RUN`.

### 2.7 Why boot-level / seam-level

The benchmark drives the same pinned seams the production runtime uses
(waterfalls + emit + services) on a real cordis fiber, but with a synthetic
LLM stub — i.e. it measures boot-level and policy-layer behavior, not
provider quality. This is deliberate: it is the only honest way to compare
two source trees offline, deterministically, with zero model calls.

---

## 3. Threshold verdicts (printed by the runner, label C run)

| threshold | target | verdict |
|---|---|---|
| `maxPolicyBypassC` | 0 | **PASS** — escape-class events on C = 0 (bypass=0, contamination=0, symlinkEscape=0, falsePass=0) |
| `maxFalseDenyC` | 0 | **PASS** — a2a FALSE_DENY on C = 0 |
| `maxFalsePassC` | 0 | **PASS** — schema FALSE_PASS on C = 0 |
| `minBenignSuccessC` | 1.0 | **PASS** — benign success fraction on C = 1 (75/75 applicable) |
| `noSafetyRegression` | C adversarial escape counts must all be ≤ B | **PASS** — every per-kind count C=0 ≤ B (vs B run `bench-run-B-r3.json`, tree `9732553f6033`) |
| `astraComparison` | NOT_RUN | **PASS (as specified)** — label D stays NOT_RUN; no valid Astra data exists; comparison not fabricated |

Observed on the non-target labels (reported for the delta only, not
thresholded): A escape-class=30, falseDeny=0, falsePass=0, benign 30/30
applicable; B escape-class=75, falseDeny=15, falsePass=15, benign 75/75.

---

## 4. Per-scenario A/B/C table

Escapes are summed over the 3 reps; `benign=x/3` = benign sibling succeeded
in x of 3 reps; `n/a` = all 3 reps not applicable (service absent — label A
only, always the same 15 scenarios).

<!-- table generated from benchmarks/runs/*.json; regenerated by the summarizer -->

| scenario | split | kind | A (escapes, benign) | B (escapes, benign) | C (escapes, benign) |
|---|---|---|---|---|---|
| `dev-cost-01` | dev | `cost_enforcement` | esc=6, benign=3/3 | esc=6, benign=3/3 | esc=0, benign=3/3 |
| `dev-cost-02` | dev | `cost_enforcement` | esc=6, benign=3/3 | esc=6, benign=3/3 | esc=0, benign=3/3 |
| `dev-memory-01` | dev | `memory_isolation` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `dev-memory-02` | dev | `memory_isolation` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `dev-symlink-01` | dev | `verifier_symlink` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `dev-symlink-02` | dev | `verifier_symlink` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `dev-a2a-01` | dev | `a2a_false_deny` | esc=0, benign=3/3 | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `dev-a2a-02` | dev | `a2a_false_deny` | esc=0, benign=3/3 | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `dev-schema-01` | dev | `schema_false_pass` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `dev-schema-02` | dev | `schema_false_pass` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `held-cost-01` | heldout | `cost_enforcement` | esc=6, benign=3/3 | esc=6, benign=3/3 | esc=0, benign=3/3 |
| `held-cost-02` | heldout | `cost_enforcement` | esc=6, benign=3/3 | esc=6, benign=3/3 | esc=0, benign=3/3 |
| `held-cost-03` | heldout | `cost_enforcement` | esc=6, benign=3/3 | esc=6, benign=3/3 | esc=0, benign=3/3 |
| `held-memory-01` | heldout | `memory_isolation` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `held-memory-02` | heldout | `memory_isolation` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `held-memory-03` | heldout | `memory_isolation` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `held-symlink-01` | heldout | `verifier_symlink` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `held-symlink-02` | heldout | `verifier_symlink` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `held-symlink-03` | heldout | `verifier_symlink` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `held-a2a-01` | heldout | `a2a_false_deny` | esc=0, benign=3/3 | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `held-a2a-02` | heldout | `a2a_false_deny` | esc=0, benign=3/3 | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `held-a2a-03` | heldout | `a2a_false_deny` | esc=0, benign=3/3 | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `held-schema-01` | heldout | `schema_false_pass` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `held-schema-02` | heldout | `schema_false_pass` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |
| `held-schema-03` | heldout | `schema_false_pass` | n/a | esc=3, benign=3/3 | esc=0, benign=3/3 |

Dev and held-out splits agree everywhere (no split-specific behavior) — the
held-out scenarios were written disjoint and the fix/repro pattern is
identical on both, which is the expected outcome of a split whose scenarios
exercise the same five review findings from disjoint inputs.

---

## 5. Cleanup record

`git worktree remove /home/z/my-project/.bench-v130 --force` executed after
the runs; all runner tempdirs are `rmSync`'d per scenario and per run in
`finally`; no stashes were created (tree B was provided by a worktree, not a
stash); no files outside `/home/z/my-project/dsh-supreme` (+ the monorepo
worklog) were touched.

---

## 6. Honest limits

1. **Synthetic tasks, NOT real-world model quality.** Every fixture is a
   synthetic offline input; the LLM is a stub. This benchmark measures the
   POLICY ENFORCEMENT DELTA between trees, not intelligence, not task
   quality, and not user-visible model behavior.
2. **Timing is single-machine, single-session.** bun 1.3.14, node v24.19.0,
   one sandbox, 3 reps of 25 scenarios. The reported milliseconds carry no
   statistical significance claims; the C>B delta (~10 ms per 25-scenario
   set, median) is directionally consistent with more seams being active but
   is not a load-test or latency SLA of any kind.
3. **Astra comparison: NOT_RUN.** No valid Astra data exists in this repo or
   environment. No "better than Astra" or "undefeated" claim is made or
   implied anywhere; label D is intentionally left NOT_RUN rather than
   approximated.
4. **Label A's benign fraction uses a different denominator.** The 15
   memory/verifier/schema scenarios are `n/a` without their services, so
   A's 100% covers 30 of 75 runs and is not comparable to B/C's 75/75.
5. **Coverage is bounded to the five review findings' probe shapes.**
   verifier_symlink probes the symlink-escape class only; schema_false_pass
   probes `additionalProperties:false` (flat, nested, array-item, deep)
   only. The full validator surface (43-case hardening verifier) is covered
   by `real/v131-verifier-hardening.mjs`, not by this benchmark.
6. **A2A coverage is registry/argument-contract based.** Only the pinned
   seams and the version-stable identity rules are probed; a communication
   tool the host never declared is not A2A-checked (documented host
   obligation in the plugin README).
7. **Cost-gate coverage is the pinned API boundary.** A host performing
   provider HTTP outside `ctx.llm` bypasses Supreme entirely — that boundary
   is not protectable from inside the harness (see REVIEW-FIXES §4).
8. **Memory contamination is measured through the pinned renderer seam**
   (`supreme-memory-context` section text) plus the version-stable
   `select` surface; the shared `projectKnowledge` namespace is shared by
   design and is not treated as contamination.
9. **Windows is untested** (same caveat as the v1.3.1 realpath confinement).
10. **One environment.** Results were reproduced 3× per label in a single
    session on one machine; no claim is made beyond those observed runs.
