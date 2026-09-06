# Runbook — Install

Goal: a working environment for DSH Supreme: project dependencies, pinned upstream libraries, and the bundler.

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | v24 (verified on v24.19.0; upstream engines `^22.19.0 \|\| >=24.0.0`) | `node --version` |
| pnpm | 11.7.0 (upstream `packageManager`) | `pnpm --version` |
| Bun | ≥ 1.3 (verified on 1.3.14) | `bun --version` |
| Pinned DSH checkout | `/home/z/deepseek-harness` @ `d347e703908d0406b7a7ef80e3a0e594d86b2215` | see below |

Environment overrides (both optional): `SUPREME_PROJECT_ROOT` (default `/home/z/my-project`), `DSH_UPSTREAM_ROOT` (default `/home/z/deepseek-harness`), `DSH_HOME` (default `<project>/.dsh-home`).

## 1. Verify the pinned upstream is intact

```bash
git -C /home/z/deepseek-harness rev-parse HEAD
# expected: d347e703908d0406b7a7ef80e3a0e594d86b2215
git -C /home/z/deepseek-harness status --porcelain
# expected: (empty output — clean worktree)
```

If either check fails, stop. Never "fix" the upstream; see [rollback.md](./rollback.md) and [upgrade-pinned-dsh.md](./upgrade-pinned-dsh.md).

## 2. Install project dependencies

```bash
cd /home/z/my-project
pnpm install
```

This installs the Next.js app dependencies and the `@deepseek-ai/*` packages (including `@deepseek-ai/cordis` 4.0.2 and `@deepseek-ai/dsh-app-boot`) that both the suite and the boot harness import.

## 3. Build the pinned upstream libraries

The upstream must be built once (per checkout) so the official libraries exist:

```bash
cd /home/z/deepseek-harness
NODE_OPTIONS='--max-old-space-size=2048' pnpm build:lib
```

`build:lib` runs `build:lib:host` then `build:lib:client` (the official build path). The heap cap keeps the TypeScript build inside sandbox memory limits.

## 4. Verify

```bash
cd /home/z/my-project
bun run dsh-supreme/src/suite/cli.ts --skip-real-boots
```

Expected: all seven plugins report `PASS` on their Level-A checks (46 checks total). Real boots need the dist bundles first — continue with [build.md](./build.md).
