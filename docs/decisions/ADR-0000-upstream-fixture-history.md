# ADR-0000: Upstream fixture history — cordis-mini and its reduced role

**STATUS:** Accepted
**DATE:** DSH Supreme v1 documentation pass
**SUPERSEDES-CONTEXT:** `SOURCE-OF-TRUTH.md` §3 (written while the upstream gate was blocked)

## CONTEXT

DSH Supreme v1 started in an environment with **no DeepSeek Harness checkout and no Cordis checkout**. The upstream integrity gate (`DSH_UPSTREAM_COMMIT = UNAVAILABLE`) was honestly recorded in `SOURCE-OF-TRUTH.md`, and per the spec's escape hatch a **minimum loader fixture** was created so plugin lifecycles could be exercised before a real upstream existed:

```text
src/harness/cordis-mini/index.ts  (~407 lines)  Cordis-compatible kernel: definePlugin,
                                                Context (provide/resolve/tryResolve/onDispose),
                                                event bus, lifecycle, Loader with topological
                                                boot, cycle detection, timings, reverse-order
                                                disposal.
```

Task 2 subsequently **unblocked the gate**: the real upstream was located and pinned at `d347e703908d0406b7a7ef80e3a0e594d86b2215` (DSH `0.1.3-alpha.1`, vendored cordis `4.0.2`), and every Supreme plugin was re-authored against the real pinned APIs. All real-integration evidence now flows through `real/boot.mjs`.

## DECISION

1. The real pinned upstream is the **only** integration basis. The real-loader path (`real/boot.mjs` → `boot()` from `@deepseek-ai/dsh-app-boot`) is the only real-integration evidence.
2. The cordis-mini fixture **remains in the tree only as a Level-A lifecycle harness** under `src/harness/cordis-mini/`, used to exercise plugin lifecycle logic (boot order, disposal, service resolution) in keyless unit runs.
3. **cordis-mini never proves DSH compatibility.** No document, check, or commit message may cite it as such. Its header comment states exactly this limitation.

## EVIDENCE

- Fixture file: `src/harness/cordis-mini/index.ts` (header documents the fixture status and the migration rule).
- Historical record: `SOURCE-OF-TRUTH.md` (upstream-absent gate, fixture rules, migration plan).
- Real gate that made the fixture non-authoritative: Task 2 minimal probe through the **real** Loader — markers `MINIMAL_PLUGIN_LOAD` / `MINIMAL_PLUGIN_OBSERVABLE_EFFECT` / `MINIMAL_PLUGIN_DISPOSE` in `dsh-supreme/data/real/minimal-probe.markers.jsonl`; then 5/5 real boots PASS (supreme-minimal, core, standard, supreme, lab).
- Suite verdict `COMPLETE` requires real boots (`REAL_BOOT_SKIPPED` blocks COMPLETE) — the fixture can never produce the verdict alone.

## ALTERNATIVES

- **Delete cordis-mini entirely.** Rejected: the Level-A lifecycle harness still runs keyless, deterministic lifecycle checks that are useful for fast iteration; deleting it would remove coverage without adding safety.
- **Keep developing against the fixture.** Rejected outright: the fixture emulates, it does not implement, the real Cordis semantics (e.g. the real `ctx.effect` disposer semantics, Standard Schema Config resolution, waterfall events). Divergence would silently invalidate every integration claim.
- **Vendoring Cordis into the project.** Rejected: duplicates the pinned `vendor/cordis` and creates a second source of truth.

## CONSEQUENCES

- Positive: fast, keyless lifecycle feedback loop remains; the honest history of the upstream-absent phase is preserved in one place.
- Negative: a small risk that future agents mistake the fixture for an integration target — mitigated by this ADR, the AGENTS.md verification rules, and the fixture's own header.
- Neutral: the fixture is not loaded by any composition (`config/*.cordis.yml` reference only real dist bundles).

## ROLLBACK

If the fixture ever causes confusion or drift: delete `src/harness/cordis-mini/` and re-run the suite — every mandatory gate passes without it (the suite's COMPLETE verdict does not depend on the fixture). No config, dist, or real-boot artifact references the fixture.
