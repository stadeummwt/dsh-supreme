# Changelog

All notable changes to DSH Supreme are documented here.

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
