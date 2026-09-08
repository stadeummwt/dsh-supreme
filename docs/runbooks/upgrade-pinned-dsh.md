# Runbook — Upgrade the pinned DSH upstream

Goal: move DSH Supreme to a newer upstream commit **safely**, keeping every claim in this repository honest. The old checkout is never mutated.

## Ground rules

- The current pin is `d347e703908d0406b7a7ef80e3a0e594d86b2215` (DSH `0.1.3-alpha.1`, cordis `4.0.2`, tag `dsh-v0.1.3-alpha.1`).
- The suite hard-fails on `UPSTREAM_COMMIT_CHANGED` / `UPSTREAM_WORKTREE_DIRTY` — an upgrade must therefore update the pin **in code** (`src/suite/runner.ts` → `DSH_COMMIT`) as part of the procedure, never by relaxing the gate.
- Cordis `inject`/`Config`/`ctx.provide`/`ctx.effect` semantics, service names, and event names must be **re-verified**, not assumed.

## Procedure

### 1. Record the old state (before touching anything)

```bash
git -C <dsh-upstream-checkout> rev-parse HEAD            # e.g. d347e703… — record this
git -C <dsh-upstream-checkout> status --porcelain        # must be empty
cp dsh-supreme/SOURCE-OF-TRUTH.md /tmp/sot-backup.md      # keep the old record
```

Record: old commit, DSH version, cordis version, and the last suite verdict (expected `COMPLETE`).

### 2. Obtain the new upstream — never mutate the old checkout

```bash
# Preferred: clone fresh / fetch into a NEW directory (old one stays pristine)
git clone https://github.com/deepseek-ai/deepseek-harness <dsh-upstream-checkout>-next
git -C <dsh-upstream-checkout>-next checkout <new-commit-or-tag>
git -C <dsh-upstream-checkout>-next status --porcelain   # must be empty
```

Do **not** `git pull` inside `<dsh-upstream-checkout>`. If the new revision is rejected, the old checkout must still be byte-identical to the old pin.

### 3. Re-run the evidence mapping

Point the tools at the new checkout and re-verify every upstream assumption:

```bash
export DSH_UPSTREAM_ROOT=<dsh-upstream-checkout>-next
```

- **Service names**: confirm `ctx.llm`, `ctx.sessions`, `ctx.systemPrompt`, `ctx.tokenMeter`, `ctx.credentials`, `ctx.subagents`, `ctx.workflowEngine` still exist with the same names and shapes (see the evidence table in [`docs/architecture/ARCHITECTURE.md`](../architecture/ARCHITECTURE.md); re-check each cited file/line).
- **Event seams**: re-verify every name in `src/plugins/supreme-observability/event-map.ts` against the new source, including the session-log event types. Update the map **only** there (single-file rule) and update its citation table.
- **Cordis conventions**: re-check `vendor/cordis/src/registry.ts` / `fiber.ts` / `reflect.ts` — plugin object shape (`apply(ctx, config)`), `inject`, Standard Schema `Config` resolution, `ctx.provide`, and the `ctx.effect` disposer semantics (execute runs immediately, return value is the disposer).
- **Patch format**: confirm the profile patch (`cordis.patch.yml`, `insert` blocks) and `boot()`/`loadProfile()` signatures in `@deepseek-ai/dsh-app-boot`.

### 4. Re-build

```bash
cd "$DSH_UPSTREAM_ROOT"
NODE_OPTIONS='--max-old-space-size=2048' pnpm install
NODE_OPTIONS='--max-old-space-size=2048' pnpm build:lib
```

Then rebuild all Supreme bundles and reinstall project deps if `@deepseek-ai/*` versions changed (see [build.md](./build.md) and [install.md](./install.md)).

### 5. Update the pin in code and re-run the suite

```bash
# src/suite/runner.ts: set DSH_COMMIT to the new commit
bun run dsh-supreme/src/suite/cli.ts
```

Required: `VERDICT COMPLETE` — 46/46 Level-A checks, 5/5 real boots (fresh timings recorded in the new boot runbooks), 9/9 scenario gates, sentinel leaks 0.

### 6. Re-record everything

- Update `DSH_COMMIT` in `src/suite/runner.ts` (and the same constant's use in `src/app/api/supreme/status/route.ts` via the import — it reads from the runner).
- Update `SOURCE-OF-TRUTH.md`, the README pinned-upstream table, and `docs/architecture/ARCHITECTURE.md` evidence table with the new commit/versions/line numbers.
- Update the boot runbooks' expected times/markers from the fresh suite report.
- Swap the checkouts deliberately (`<dsh-upstream-checkout>-next` → becomes the new pin path) — archive or delete the old checkout only after the new suite is green.

## Rollback of an upgrade attempt

Revert the pin commit (runner constant + docs), point `DSH_UPSTREAM_ROOT` back to the untouched old checkout, rebuild dist if needed, and re-run the suite — it must return to `COMPLETE` with zero upstream-side changes, because the old checkout was never mutated.
