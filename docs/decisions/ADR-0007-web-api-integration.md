# ADR-0007: Web/API integration — dashboard is a projection over `/api/supreme/*`; suite execution dev/LAB-only; no second backend framework

**STATUS:** Accepted
**DATE:** DSH Supreme v1 documentation pass

## CONTEXT

The project sandbox is a Next.js 16 application; a natural temptation is to build a dashboard that "manages" DSH Supreme — owning suite runs, state, and scheduling in the web tier. That would create a second backend framework beside the DSH host, a second place where runtime state lives, and a surface where a browser request could trigger expensive or unsafe work in production. The spec requires the dashboard to be a *projection* and suite execution to be a development/LAB capability.

## DECISION

1. **No second backend framework.** The DSH host (pinned upstream, booted via `real/boot.mjs`) and the suite CLI (`bun run dsh-supreme/src/suite/cli.ts`) remain the only execution backends. The Next.js app adds **only** thin read-mostly HTTP projections.
2. **The dashboard owns no runtime state.** Suite run records live in an in-memory store (latest 20, `globalThis`-anchored) inside the Node process (`src/lib/supreme-suite.ts`). The web tier reads them; it never persists, schedules, or mutates plugin state.
3. **API surface (all `runtime = "nodejs"`, `dynamic = "force-dynamic"`):**
   - `GET /api/supreme/status` — suite scope (frozen 7 plugins + compositions), upstream commit/pinned commit/branch/worktree cleanliness, DSH + cordis versions, runtime info. Always available.
   - `GET /api/supreme/report` — last `SuiteReport`; `404` with a pointer to `POST /api/supreme/suite/run` when nothing has run.
   - `POST /api/supreme/suite/run` — executes the full suite (including the 5 real boots). **dev/LAB only:** `suiteEnabled()` returns false when `NODE_ENV === 'production'` unless `SUPREME_ENABLE_SUITE=1`; disabled environments get `403`.
   - `GET /api/supreme/suite/runs/:id` — one run record (`runId`, `startedAt`, `durationMs`, full report); `404` for unknown ids.
4. **Suite execution is dev/LAB-only** — in production the only remaining capability is the read-only `status` projection.

## EVIDENCE

- Route handlers: `src/app/api/supreme/status/route.ts`, `src/app/api/supreme/report/route.ts`, `src/app/api/supreme/suite/run/route.ts`, `src/app/api/supreme/suite/runs/[id]/route.ts` (project app, outside `dsh-supreme/`).
- Store + gate: `src/lib/supreme-suite.ts` — `suiteEnabled()` (`NODE_ENV !== 'production'` or `SUPREME_ENABLE_SUITE=1`), `executeSuite()` calling the same `runFullSuite()` the CLI uses, bounded 20-run store, `getLastReport()`.
- Single-suite-source proof: the API imports `runFullSuite` / `DSH_COMMIT` / `DSH_ROOT` / `PROJECT_ROOT` from `@dsh-supreme/suite/runner` (tsconfig path `@dsh-supreme/*` → `./dsh-supreme/src/*`) — there is exactly one suite implementation and one pinned-commit constant.
- Report shape consumed by the API is the suite's own `SuiteReport` (`verdict`, `blockingGates`, per-plugin checks, compositions, security, performance) — no parallel dashboard-side data model exists.

## ALTERNATIVES

- **A dedicated Express/Fastify service for the dashboard.** Rejected: a second backend framework doubles deployment surface and splits runtime state; the Next.js route handlers are sufficient projections.
- **Dashboard-owned run scheduling (cron from the web tier).** Rejected: web-tier schedulers restart, duplicate, and race; suite execution belongs to the operator (CLI) or an explicit dev/LAB POST.
- **Persisting run records to a database.** Rejected: suite reports are artifacts of a verification run; the JSON report from the CLI is the durable form, the in-memory store is a convenience for the projection.
- **Allowing suite execution in production.** Rejected outright: five real boots plus perf loops are a heavy operation and must never be triggerable by a public request path in production.

## CONSEQUENCES

- Positive: single source of suite truth; zero state divergence between CLI and API; production surface is read-only by default; the API re-uses the suite's types verbatim.
- Negative: run history is per-process and lost on restart (bounded at 20 runs by design); the POST is not authenticated beyond the environment gate — acceptable only because it is dev/LAB-only.
- Neutral: the dashboard renders whatever the suite reports; dashboard improvements never require plugin changes and vice versa.

## ROLLBACK

Delete the four route handlers and `src/lib/supreme-suite.ts` — the suite CLI and all plugin code are unaffected (no plugin imports anything from the web tier). To tighten further, remove `SUPREME_ENABLE_SUITE` handling so suite execution is impossible in production even with operator override.
