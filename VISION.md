# DSH Supreme — v1 Vision (frozen architecture contract)

> **Status note (added at v1 release):** this document is the original frozen v1
> target and design contract. The seven-plugin implementation described by it now
> exists in this repository and is verified by executable gates — see
> [`README.md`](./README.md) for verified status and [`CHANGELOG.md`](./CHANGELOG.md)
> for the release record. The honesty posture below is unchanged.

A self-routing, self-verifying intelligence layer for DeepSeek Harness.
Right model. Right context. Right workflow. Verified result.

DSH Supreme is an experimental, plugin-first intelligence and control layer for DeepSeek Harness (dsh).

It is designed to make a DSH-based agent runtime more adaptive, measurable, and verifiable by adding:

- deterministic policy enforcement
- safe observability
- benchmark-informed model routing
- deterministic verification
- memory-selection policy
- controlled subagent/workflow policy
- explicit RM0-first routing constraints

DSH Supreme does not replace DeepSeek Harness and does not attempt to build a second agent framework beside it.

DeepSeek Harness remains the runtime. DSH Supreme extends it through supported DSH/Cordis composition and plugin seams.

**This document is a design contract, not a substitute for evidence.** Every behavioral claim in this repository is backed by an executable gate in the release suite.

DSH Supreme is an independent community project and is not affiliated with or endorsed by DeepSeek AI.

## Why DSH Supreme?

A powerful base model is useful, but a real agent system has more decisions to make than simply:

> "Which model should answer?"

For a production-grade task, the harness may need to decide:

- Which provider is currently healthy?
- Which model is valid and capable for this task?
- Is the route free, limited, trial, paid, or unknown?
- Is the required context window sufficient?
- Which tools should be exposed?
- Which skills are relevant?
- Is additional memory useful?
- Should the task run directly or be delegated?
- Should a workflow be generated?
- Can the result be verified deterministically?
- Did this route perform well on similar tasks before?
- Why did a previous route fail?
- Should the system retry, degrade, or block?

DSH Supreme is designed around those decisions.

## Core Idea

```text
USER TASK
   │
   ▼
DeepSeek Harness
   │
   ▼
Supreme Policy
   │
   ▼
Supreme Router ───────────────────────┐
   │                                  │
   ▼                                  │
DSH LLM / Tools / Skills              │
   │                                  │
   ├── Memory Policy                  │
   ├── Subagents                      │
   └── Workflow Policy                │
   │                                  │
   ▼                                  │
Supreme Verifier                      │
   │                                  │
   ▼                                  │
RESULT                                │
   │                                  │
   ├── Observability ─────────────────┤
   └── Benchmark Evidence ────────────┘
                     │
                     ▼
           Better future routing
```

The project focuses on end-to-end system quality, not unsupported claims that one raw model is universally better than another.

## Core Design Principles

DSH Supreme v1 follows these non-negotiable principles:

1. DeepSeek Harness is the platform.
2. Cordis is the composition and lifecycle framework.
3. Plugin-first and composition-first.
4. Pinned upstream revision.
5. No normal-path fork of DSH core.
6. Reuse DSH capabilities instead of rebuilding them.
7. DSH Session remains canonical session history.
8. Deterministic evidence beats model self-confidence.
9. No silent paid fallback.
10. Unknown cost state is treated conservatively.
11. Production and LAB remain separate.
12. Measure before optimizing.
13. Mock fixtures never substitute for real DSH Loader integration.
14. Secrets must never enter observability or benchmark output.
15. A plugin is not complete until real composition passes.

## Upstream Baseline

The initial DSH Supreme development baseline is pinned to the official DeepSeek Harness repository:

| Item | Value |
|---|---|
| Repository | deepseek-ai/deepseek-harness |
| Branch | master |
| Commit | d347e703908d0406b7a7ef80e3a0e594d86b2215 |
| Release | dsh@0.1.3-alpha.1 |

Pinned revision: https://github.com/deepseek-ai/deepseek-harness/commit/d347e703908d0406b7a7ef80e3a0e594d86b2215

DeepSeek Harness is currently developer-preview software and may introduce compatibility-breaking changes. DSH Supreme therefore treats every upstream upgrade as a controlled migration.

### Upstream Upgrade Gate

```text
CURRENT PIN
    │
    ▼
NEW UPSTREAM CANDIDATE
    │
    ├── build
    ├── upstream tests
    ├── Supreme unit tests
    ├── Supreme integration tests
    ├── real Loader tests
    ├── composition tests
    ├── security regression
    ├── benchmark comparison
    └── migration report
    │
    ▼
PROMOTE / REJECT
```

No blind git pull into a validated Supreme baseline.

## Architecture

DSH Supreme is intentionally not a second harness.

```text
┌──────────────────────────────────────────────────────────────┐
│                   DEEPSEEK HARNESS / CORDIS                 │
│                                                              │
│   LLM   Tools   Sessions   Skills   Prompt   Subagents       │
│    │      │        │         │       │         │             │
│    ├──────┼────────┼─────────┼───────┼─────────┤             │
│    │          Native DSH services remain authoritative      │
└────┼─────────────────────────────────────────────────────────┘
     │
     ▼
┌──────────────────────────────────────────────────────────────┐
│                      DSH SUPREME LAYER                      │
│                                                              │
│  Policy ──► Observability ──► Benchmark ──► Router           │
│    │                                      │                  │
│    ├────────────► Verifier                │                  │
│    ├────────────► Memory Policy           │                  │
│    └────────────► Workflow Policy ◄───────┘                  │
│                          │                                   │
│                          ▼                                   │
│              DSH Subagents / Workflow Engine                │
└──────────────────────────────────────────────────────────────┘
```

### DSH Supreme does not rebuild

Where DSH already provides a suitable capability, Supreme consumes it instead of duplicating it. The project is not intended to create another:

agent loop · session engine · LLM adapter framework · tool registry · skill engine · subagent framework · workflow engine · system-prompt engine · token meter · compaction engine · credential store · sandbox · approval framework

A DSH core patch is a last resort.

## The Seven Supreme Plugins

### 1. supreme-policy

Deterministic policy authority for execution profile, cost eligibility, risk classification, delegation limits, and verification requirements.

Default production posture:

```text
PAID       → DENY
TRIAL      → DENY unless explicitly enabled
UNKNOWN    → DENY / ESCALATE
HIGH RISK  → VERIFICATION REQUIRED
```

### 2. supreme-observability

Safe runtime visibility without creating a second conversation database.

Target signals: session/turn references · provider/model · request latency / TTFT · tool activity · subagent/workflow activity · compaction · token pressure · normalized failures · route / verification / benchmark IDs.

Never collect secrets, authorization headers, cookies, arbitrary env values, or raw prompts/responses by default.

### 3. supreme-benchmark

Stores reproducible end-to-end evidence: task category · provider/model · execution profile · latency · token metrics · tool/subagent/workflow counts · validator outcome · success/failure · quality score.

Benchmark evidence informs routing. It is not model training.

### 4. supreme-router

Applies hard gates first, then scores only eligible candidates.

Potential gates: policy · cost class · provider availability · credentials · model validity · capability · context · health · quota.

Initial conceptual scoring:

| Signal | Weight |
|---|---|
| Historical task quality | 30% |
| Health | 20% |
| Quota headroom | 15% |
| Reliability | 10% |
| Latency | 10% |
| Capability fit | 10% |
| Failure-domain diversity | 5% |

If no route is eligible: `BLOCKED_NO_ELIGIBLE_ROUTE`. No silent paid fallback.

### 5. supreme-verifier

Verification is first-class:

```text
DETERMINISTIC EVIDENCE  >  MODEL SELF-CONFIDENCE
```

Possible validators: exact/predicate · JSON / JSON Schema · file existence/hash · command exit status · build/lint/typecheck · unit/integration tests · HTTP/schema · project-specific validators.

Unavailable verification returns `UNAVAILABLE`, not fake PASS.

### 6. supreme-memory-policy

Separates SESSION HISTORY · PROJECT KNOWLEDGE · LONG-TERM MEMORY.

DSH Session remains authoritative. This plugin owns selection policy and context budgeting. If no approved long-term memory backend exists, `LONG_TERM_PROVIDER = NOOP` is valid.

### 7. supreme-workflow-policy

Controls DIRECT · SUBAGENT · WORKFLOW · SUPREME_WORKFLOW · DENY — with bounded concurrency, depth, timeouts, provider allowlists, scoped permissions, and explicit secret restrictions.

It consumes official DSH subagent/workflow capabilities rather than replacing them.

## Runtime Profiles

| Profile | Purpose |
|---|---|
| CORE | Minimal baseline for debugging and integration. |
| STANDARD | Normal runtime with policy, observability, memory selection, verification, and optional routing. |
| SUPREME | All seven plugins plus DSH tools, skills, routing, subagents, and workflow capabilities. |
| LAB | Diagnostics and experiments only. LAB behavior must never silently become production policy. |

## RM0-First Routing Policy

Cost classes: FREE_CONFIRMED · FREE_LIMITED · TRIAL · PAID · UNKNOWN.

| Cost class | Production default |
|---|---|
| FREE_CONFIRMED | Eligible |
| FREE_LIMITED | Eligible subject to quota/policy |
| TRIAL | Denied unless explicitly enabled |
| PAID | Denied unless explicitly enabled |
| UNKNOWN | Denied / unresolved |

RM0-first is a routing policy, not a claim that provider terms never change.

## Verification-First Execution

```text
TASK → ROUTE → EXECUTE → VERIFY
   ├── PASS ──► RESULT
   ├── FAIL ──► bounded repair/retry
   └── UNAVAILABLE ──► explicit degraded state
```

## Benchmark-Informed Routing

Historical scoring should require enough samples before materially affecting routing.

## Failure Model

Initial taxonomy: AUTH · RATE_LIMIT · QUOTA · TIMEOUT · NETWORK · SERVER · INVALID_MODEL · INVALID_SCHEMA · WRONG_TOOL · TOOL_EXECUTION · WRONG_ANSWER · FORMAT · CONTEXT · COST_POLICY · VERIFICATION · UNKNOWN.

## Real Integration Gate

```text
UNIT FIXTURE → SERVICE INTEGRATION → REAL DSH LOADER → REAL cordis.yml
             → OBSERVABLE EFFECT → CLEAN DISPOSAL
```

Mock success is not real DSH compatibility.

## Security Model

DeepSeek Harness itself is experimental developer-preview software and has not completed a security audit.

DSH Supreme assumes: least privilege · narrow workspace access · explicit approvals · isolated/disposable environments where practical · no secrets in observability · no secrets in benchmark stores · no credential inspection by subagents · no arbitrary environment dumps · no silent paid routing · strict LAB vs production separation.

Upstream safety notice: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/SAFETY.md

> **WARNING:** DSH Supreme is experimental and should not be treated as a security boundary or production-ready infrastructure until appropriate audits and release gates have passed.

## Secret-Safety Rules

Operational artifacts must never contain: API keys · passwords · bearer tokens · authorization headers · cookies · private credentials · arbitrary .env values · secret-bearing tool arguments.

Release requirement: `SECRET_SENTINEL_LEAKS = 0`.

## Frontier-Model Comparisons

DSH Supreme aims to improve system-level outcomes through routing, specialization, verification, recovery, historical evidence, and orchestration. It does not claim smaller/free models are universally stronger than frontier models.

Future comparisons must publish: exact tasks · provider/model identities · configuration · verification method · success criteria · latency · token/cost data · repeated runs · failures as well as wins.

No unsupported "beats model X" claim should be published before reproducible evidence exists.

## Planned Benchmark Categories

reasoning · planning · coding · debugging · repository work · tool calling · tool recovery · web research · source verification · structured output · long context · memory selection · multi-agent orchestration · workflows · failure recovery · adversarial critique · self-correction · multi-step execution

## Definition of Done for v1

```text
7 SUPREME PLUGINS              PASS
REAL DSH LOADER                PASS
CORE COMPOSITION               PASS
STANDARD COMPOSITION           PASS
SUPREME COMPOSITION            PASS
LAB COMPOSITION                PASS
SECURITY REGRESSION            PASS
SECRET SENTINEL LEAKS          0
UPSTREAM CORE MODIFIED         NO
UPSTREAM PATCH COUNT           0
```

Current verified status for every line above: [`README.md`](./README.md) ("Verified status").

## Project Statement

DSH Supreme is a plugin-first, composition-driven intelligence layer for a pinned DeepSeek Harness upstream. It aims to select the right model and capabilities for each task, verify outcomes with evidence, learn from benchmark history, and orchestrate complex work without turning the upstream harness into a custom fork.

**Build less framework. Make better decisions. Verify the result.**
