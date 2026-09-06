# Runbook — Rollback

Goal: return the system to a verified-good state after a bad change. The guiding fact: **the upstream checkout is never touched by this project, so rollback never involves the upstream** — it is always a restore of project-owned files (or a config revert).

## Decision table

| What broke | Rollback action | Upstream touched? |
|---|---|---|
| A plugin engine/adapter change misbehaves | restore the previous `src/plugins/<name>/{engine,index}.ts`, re-run the build loop, re-run the suite | No |
| A composition change breaks a boot | revert `config/<profile>.cordis.yml` to the previous content; `--setup` re-installs the profile | No |
| dist bundles stale/corrupt | re-run the [build loop](./build.md) — dist is fully derived, never authoritative | No |
| Bad data in `dsh-supreme/data/` | delete the offending JSONL/markers; they are regenerated on the next boot. **A sentinel leak is a code bug — find the writer first** | No |
| API/dashboard regression | revert `src/app/api/supreme/**` / `src/lib/supreme-suite.ts`; the CLI suite is unaffected | No |
| Suite itself fails after a pin-update attempt | revert the `DSH_COMMIT` constant + docs (see [upgrade-pinned-dsh.md](./upgrade-pinned-dsh.md) §Rollback) | No |
| Someone modified `/home/z/deepseek-harness` | treat as an integrity incident — see below | **n/a — detect, never repair in place** |

## Standard rollback sequence (project files)

```bash
# 1. Restore the files you changed (git or backup)
git -C /home/z/my-project checkout -- dsh-supreme/src/plugins/<name>/      # if version-controlled

# 2. Rebuild dist (dist is always derived from src)
cd /home/z/my-project
for p in supreme-policy supreme-observability supreme-benchmark supreme-router \
         supreme-verifier supreme-memory-policy supreme-workflow-policy \
         supreme-minimal-probe supreme-boot-probe supreme-gate-driver supreme-fake-llm; do
  NODE_OPTIONS='--max-old-space-size=2048' bun build \
    dsh-supreme/src/plugins/$p/index.ts \
    --outfile dsh-supreme/dist/plugins/$p/index.mjs \
    --format esm --target node --external zod
done

# 3. Re-verify
bun run dsh-supreme/src/suite/cli.ts
```

Exit `0` with `VERDICT COMPLETE` closes the incident.

## Config reverts

Composition templates in `config/` are the source of truth; the installed profiles under `$DSH_HOME/profiles/<name>/` are derived. After reverting a config file:

```bash
node dsh-supreme/real/boot.mjs --profile <name> --setup   # --setup rewrites cordis.patch.yml
```

LAB-specific values (`allowPaid: true`, `allowCommands: true`) must only ever reappear in `lab.cordis.yml` — the suite blocks release if `allowPaid: true` appears in `core` / `standard` / `supreme`.

## Upstream checkout is never repaired in place

If the integrity gate reports `UPSTREAM_COMMIT_CHANGED` or `UPSTREAM_WORKTREE_DIRTY`:

1. **Stop.** Do not edit, `git checkout --`, or `reset --hard` inside `/home/z/deepseek-harness` as an informal fix.
2. Identify what changed (`git -C /home/z/deepseek-harness status --porcelain`; `git diff`).
3. If the change was accidental and uncommitted: restoring the pristine tree with `git -C /home/z/deepseek-harness restore .` is the *only* permitted upstream operation, and it must be recorded (what/when/why) in the worklog.
4. If the pin itself must move: that is not a rollback — follow [upgrade-pinned-dsh.md](./upgrade-pinned-dsh.md) end to end.

## Post-rollback checks

- [ ] `bun run dsh-supreme/src/suite/cli.ts` → `VERDICT COMPLETE`
- [ ] `git -C /home/z/deepseek-harness rev-parse HEAD` → `d347e703908d0406b7a7ef80e3a0e594d86b2215`, worktree clean
- [ ] Marker files under `dsh-supreme/data/real/` show fresh LOAD/DISPOSE (and gate) lines from a post-rollback boot
- [ ] Docs that cited the reverted behavior are updated or reverted with it
