# Runbook — Boot `core`

Goal: boot the CORE composition — a clean DSH baseline (`@deepseek-ai/dsh-base` bundle) plus the minimal Supreme surface: `supreme-policy` only, with both probe plugins.

## What this profile is

Composition source: `config/core.cordis.yml`. Mounted plugins (insert blocks):

| Plugin | Config |
|---|---|
| `supreme-minimal-probe` | marker path `data/real/minimal-probe.markers.jsonl` |
| `supreme-boot-probe` | marker path `data/real/boot-probe-core.markers.jsonl` |
| `supreme-policy` | `executionClass: CORE` (paid/trial/unknown all denied, depth ≤ 3) |

## Command

```bash
node dsh-supreme/real/boot.mjs --profile core --setup
```

`--setup` writes the profile under `$DSH_HOME/profiles/core/` — `package.json` with `bundles: ['@deepseek-ai/dsh-base']`, `cordis.yml` (`[]`), and `cordis.patch.yml` generated from the template.

## Expected result

- Exit code `0`; JSON output with:
  - `bootMs` ≈ **750–900 ms** (bundle load dominates),
  - `disposeMs` ≈ **20–30 ms**, `disposeError: null`,
  - `services`: `llm`, `sessions`, `systemPrompt`, `tokenMeter`, `credentials`, `subagents`, `workflowEngine`, `supremePolicy` → `true`; `supremeObservability`, `supremeBenchmark`, `supremeRouter`, `supremeVerifier`, `supremeMemoryPolicy`, `supremeWorkflowPolicy` → `false`,
  - `gates`: one entry — the `BOOT_PROBE` marker line.
- Marker files under `dsh-supreme/data/real/`:
  - `minimal-probe.markers.jsonl` — new `MINIMAL_PLUGIN_LOAD` / `MINIMAL_PLUGIN_OBSERVABLE_EFFECT` at boot; `MINIMAL_PLUGIN_DISPOSE` after dispose;
  - `boot-probe-core.markers.jsonl` — new `BOOT_PROBE` line with the presence map above (written ~600 ms after activation).

```bash
tail -1 dsh-supreme/data/real/boot-probe-core.markers.jsonl
```

## Failure triage

| Symptom | Likely cause |
|---|---|
| `boot failed after …ms` mentioning a bundle | upstream `@deepseek-ai/dsh-base` missing — re-run the upstream build (see [install.md](./install.md)) |
| `supremePolicy: false` in the probe | dist not rebuilt or patch file stale — rebuild ([build.md](./build.md)) and re-run with `--setup` |
| no new `BOOT_PROBE` line | boot-probe timer disposed early or patch file missing the insert block |
