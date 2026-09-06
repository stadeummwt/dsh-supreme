# Runbook — Build

Goal: fresh `dsh-supreme/dist/plugins/<name>/index.mjs` bundles for all 11 plugins (7 Supreme + 4 support), loadable by the real DSH Loader.

## What gets built

One self-contained ESM bundle per plugin. Bundles externalize only `zod` and Node builtins; `@deepseek-ai/cordis` appears solely as erased type imports, so dist has no dependency on project TypeScript.

## Build loop (verified)

Run from the project root. `NODE_OPTIONS='--max-old-space-size=2048'` is part of the verified command; keep it.

```bash
cd /home/z/my-project

PLUGINS="supreme-policy supreme-observability supreme-benchmark supreme-router \
supreme-verifier supreme-memory-policy supreme-workflow-policy \
supreme-minimal-probe supreme-boot-probe supreme-gate-driver supreme-fake-llm"

for p in $PLUGINS; do
  NODE_OPTIONS='--max-old-space-size=2048' bun build \
    dsh-supreme/src/plugins/$p/index.ts \
    --outfile dsh-supreme/dist/plugins/$p/index.mjs \
    --format esm --target node --external zod
done
```

This exact command was verified to reproduce the committed `dist/plugins/supreme-policy/index.mjs` byte-for-byte.

## Verify the build

```bash
# 1. All 11 bundles exist and are non-trivial
ls dsh-supreme/dist/plugins/*/index.mjs | wc -l          # expected: 11

# 2. Bundles load and export the Cordis plugin shape
node -e "import('./dsh-supreme/dist/plugins/supreme-policy/index.mjs').then(m => console.log(m.name, Array.isArray(m.inject), typeof m.apply))"
# expected: supreme-policy true function
```

## Upstream rebuild (only when needed)

Rebuild upstream libraries only after a **new, deliberate** upstream pin (see [upgrade-pinned-dsh.md](./upgrade-pinned-dsh.md)) or after an upstream clean. The pinned checkout is never modified by this project, so its build outputs are stable:

```bash
cd /home/z/deepseek-harness
NODE_OPTIONS='--max-old-space-size=2048' pnpm build:lib
```

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `error: Could not resolve "zod"` at Loader time | dist built without `--external zod` | rebuild with the exact loop above |
| Boot fails with `ERR_MODULE_NOT_FOUND` for a dist path | stale dist after adding/renaming a plugin | re-run the full loop; check `config/*.cordis.yml` paths |
| Bun OOM during build | heap cap missing | prefix `NODE_OPTIONS='--max-old-space-size=2048'` |
| Suite reports `COMPOSITION:*` FAILs right after edits | dist not rebuilt after source changes | re-run the loop, then re-run the suite |
