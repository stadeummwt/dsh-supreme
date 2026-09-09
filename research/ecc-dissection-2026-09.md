# ECC Dissection — apa yang relevan untuk DSH Supreme (ECC-1 + IMPROVE-1)

Tarikh: 2026-09-09 · Sumber: GitHub API (authenticated, transient) — `affaan-m/ECC` @ v2.2.1
Data mentah: `/tmp/ecc/` (ecc-readme.md 118KB, ecc-tree.json 4,801 entri, install-profiles.json, .claude-plugin manifests, hooks.json)

---

## 1. Pengenalan repo

| Item | Nilai (evidence: `ecc-meta.json`) |
|---|---|
| Repo | `affaan-m/ECC` — "The agent harness performance optimization system. Skills, instincts, memory, security, and research-first development" |
| Stars / forks | **253,948★ / 38,080 forks** (checkpoint 2026-09-08) |
| Versi | v2.2.1 (`plugin.json`) |
| Saiz | 4,801 path; docs 2,151 fail, **skills 286 entri**, agents 68, commands 94, rules 144, tests 303 |
| Model | "The root is the source of truth. Platform adapters package or map these same workflows" — satu set kandungan, banyak adapter (Claude Code, Codex, OpenCode, Cursor, Hermes, Kimi, …) |

ECC bukan setara 1:1 dengan Supreme. ECC = **config/kandungan breadth pack** (skill/agent/rule & runtime hooks); Supreme = **governance & verification depth** (policy gates, proof-first, deterministik). Perbezaan ini penting untuk positioning.

## 2. Anatomi komponen (dari tree + README)

```
ECC/
├── agents/           68 subagent .md (planner, architect, code-reviewer, security-reviewer,
│                     10-language reviewers/build-resolvers, harness-optimizer, loop-operator)
├── skills/           286 workflow packages (coding-standards, tdd-workflow, security-review,
│                     continuous-learning-v2, verification-loop, eval-harness, …)
├── commands/         94 slash-command shims (+legacy-command-shims opt-in)
├── rules/            common/ + 12 language dirs (ts, py, go, java, kotlin, rust, cpp, php, perl, arkts…)
├── hooks/            hooks.json (PreToolUse/PostToolUse/SessionStart/Stop dispatchers)
│                     + memory-persistence/
├── manifests/        install-components.json, install-modules.json, install-profiles.json
├── schemas/          11 JSON Schemas: hooks, plugin, install-*, memory, provenance, state-store,
│                     package-manager
├── .claude-plugin/   plugin.json (userConfig, skills[], commands[]) + marketplace.json
├── contexts/         dev.md | research.md | review.md  ← research-first session contexts
├── scripts/          292 (install-plan.js, install-apply.js, checks, orchestration)
├── ecc2/             Rust control-plane ALPHA (dashboard/start/sessions/status/daemon)
├── ecc_dashboard.py  Tkinter desktop GUI
└── docs/             2,151 fail termasuk the-longform-guide.md, the-security-guide.md
```

### Komponen runtime yang menonjol

1. **Hooks runtime dengan profil** — `ECC_HOOK_PROFILE=minimal|standard|strict` + `ECC_DISABLED_HOOKS=…`
   gating TANPA edit fail hook. PreToolUse Bash dispatcher konsolidasi (quality, tmux, push, GateGuard).
2. **GateGuard** — "gates destructive shell commands (including `rm`, force/path `git checkout`, and
   destructive `find -exec`) before they run" (README §security).
3. **AgentShield** — "audits your own agent, hook, MCP, permission, and secret surfaces (`/security-scan`)"
   — 6 permukaan: prompts, hooks, MCP config, permissions, secrets, agent files.
4. **Unified Memory Vault** — `ecc memory` satu format Markdown lokal untuk handoffs lintas-harness
   (Claude/Codex/Hermes/OpenClaw/Kimi), `ecc-memory-mcp` stdio server, surface bounded
   `save/search/read/doctor`. "Bounded" = ada had saiz/retensi.
5. **Instincts (continuous-learning-v2)** — pembelajaran dengan **confidence scoring**:
   `ECC_INSTINCT_CONFIDENCE_THRESHOLD=0.7` (default), `ECC_MAX_INJECTED_INSTINCTS=6`,
   `ECC_INSTINCT_RELEVANCE_RANKING=on` (boost untuk instinct project-scoped/stack-matched),
   SessionStart inject top-N, `ECC_SESSION_RETENTION_DAYS` (default 30).
6. **Selective install** — manifest-driven: `install-plan.js` + `install-apply.js`, state store SQLite,
   **profiles = set modules**: `minimal / core / developer / security / research / full`
   (evidence: `manifests/install-profiles.json`).
7. **Deterministic harness audit** — `/harness-audit`, `/quality-gate`, `/model-route` (v1.8: "Deterministic
   harness audit scoring", "observer loop prevention with 5-layer guard").
8. **Packaging** — `plugin.json` (`userConfig`, `skills: ["./skills/"]`, `commands: ["./commands/"]`) +
   `marketplace.json` (katalog plugin untuk `/plugin marketplace add`).

## 3. Analisis: komponen mana RELEVAN untuk Supreme

| # | Komponen ECC | Status Supreme v1.1 | Relevan? | Tindakan |
|---|---|---|---|---|
| 1 | **GateGuard** (gate shell destruktif, profil minimal/standard/strict) | supreme-policy dah gate execution class/PAID-TRIAL; command-level gate ada dalam verifier limits | ✅ Tinggi | v1.2: angkat pola `hook profile` → `supreme.policy.profile` (core/standard/supreme) supaya gate keras boleh dilonggarkan per-profil secara deterministik |
| 2 | **AgentShield 6-surface audit** | secret sentinel scan output sahaja (1 permukaan) | ✅ Tinggi | v1.2: kembangkan sentinel → audit 6 permukaan (prompts, plugin config, MCP rows, permissions, secrets, agent files) sebagai check suite baharu |
| 3 | **Instincts confidence policy** (threshold 0.7, cap 6, relevance ranking, retention) | supreme-memory-policy = policy gate (budget/retention), tiada konsep confidence injection | ✅ Tinggi | v1.2: tambah params deterministik `minConfidence`, `maxInjected`, `relevanceRanking` pada memory-policy — kekal tanpa LLM, cuma gate |
| 4 | **install-profiles manifest** (modules→profiles) | 4 komposisi dalam `config/*.cordis.yml` dengan placeholder fixture | ✅ Sederhana | **Sudah dibuat (v1.1)**: `config/compositions/*.patch.yml` — fragmen patch yang resolve melalui `dsh-supreme/dist/...` untuk pengguna bundle (lihat §5) |
| 5 | **plugin.json / marketplace.json** packaging | `dsh.bundle` manifest dah ada & E2E verified | ✅ Dah selari | kekal; format bundle DSH berbeza tapi konsep sama (manifest + kandungan + katalog) |
| 6 | **Schemas (provenance, state-store, memory)** | tiada schema diterbitkan | ⚠️ Sederhana | v1.2: terbitkan `schemas/suite-report.schema.json` supaya laporan suite boleh divalidasi pihak ketiga |
| 7 | **harness-audit scoring deterministik** | supreme-benchmark dah ukur latensi & gates | ⚠️ Rendah | tiada perubahan; nota positioning sahaja |
| 8 | **contexts dev/research/review** | supreme-memory-policy `registerPromptSection` | ⚠️ Rendah | contoh content untuk prompt section dalam README |

**TIDAK relevan** (elak scope creep): 286 breadth skills, 68 language-reviewer agents, operator/business
skills, prediction-market packs, Tkinter dashboard GUI, ecc2 Rust control-plane, PM2/orchestrator family,
multi-platform adapter matrix. Ini semua kandungan/breadth — bukan governance. Supreme kecil, boleh bukti,
deterministik; jangan jadi ECC.

## 4. Cadangan improvement projek Supreme (IMPROVE-1)

### Keutamaan 1 — Distribusi (gap terbesar, kos rendah)
1. **Submit ke dsh-market** (`dsh-market/dsh-market`, 3,436★, ~82.5k installs — saluran utama pengguna DSH).
2. **PR ke `awesome-dsh-plugin/awesome-dsh-plugin`** (14,903★) — kategori security/governance; data
   struktur entri sudah dikumpul semasa RESEARCH-1.
3. **Tag repo `dsh-plugin`** + topik relevan supaya muncul dalam carian ecosystem.
4. README badge (stars, pinned commit, suite verdict) + link E2E proof.

### Keutamaan 2 — Bundle v1.1 lengkap (dilaksanakan sesi ini)
5. ✅ `dsh.bundle` manifest + `cordis.patch.yml` + E2E `real/bundle-verify.mjs` → **BUNDLE_E2E_COMPLETE**
   (real CLI install → 13 services, boot 903ms, user-patch override wins, upstream untouched).
6. ✅ `config/compositions/{core,standard,supreme,lab}.patch.yml` — fragmen komposisi bundle-resolvable
   (analog ECC install-profiles, kekal zero-patch-on-core).
7. ✅ README: arahan install bundle + nota `dist/` dikomit → **tiada `prepare` build, tiada pnpm
   allowBuilds friction** untuk `dsh plugin add github:stadeummwt/dsh-supreme`.

### Keutamaan 3 — v1.2 roadmap (dari bedah ECC)
8. Sentinel → **6-surface audit** (AgentShield analog, kekal offline/deterministik).
9. Memory-policy → **instinct params** (minConfidence/maxInjected/relevanceRanking) sebagai policy gates.
10. **JSON Schema diterbitkan** untuk suite report + run records (provenance analog).
11. Komposisi profil → **hardened profile presets** yang user copy 1 baris (reduce onboarding).

### Keutamaan 4 — Positioning (nasihat)
- Jangan tiru breadth ECC. Kekuatan Supreme adalah **proof-first governance**: 46/46 checks, 9/9 gates,
  sentinel leaks=0, patches=0, deterministik ~0.02ms router, RM0-first. ECC tiada apa-apa seperti ini —
  laporan ecosystem (RESEARCH-1) sahukkan tiada pesaing DSH buat 7-domain gates komprehensif.
- Ayat positioning dicadangkan: *"ECC gives your harness breadth. Supreme gives it a conscience."*

## 5. Bukti bahagian bundle v1.1 (BUNDLE-1)

Format sahih dari docs upstream (`docs/user/develop/basic/publish.md` @ pinned commit):
- Bundle = pakej npm dengan `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`.
- Profile = `$DSH_HOME/profiles/<name>` + `dsh.profile.bundles` — DIURUS oleh
  `dsh plugin --profile <name> add <pkg>` (forward ke pnpm, reconciler append bundle).
- Layer order: bundle patches (ikut susunan) → profile `cordis.patch.yml` → `$DSH_HOME` patch → `--patch`.
- Relative plugin names resolve **beside their patch file**; nama pakej resolve melalui node_modules.

Run E2E (sandbox ini, upstream @ pinned commit, pnpm 10.34.5):
```json
{ "ok": true, "verdict": "BUNDLE_E2E_COMPLETE", "profile": "supreme-bundle",
  "bundles": ["@deepseek-ai/dsh-base", "dsh-supreme"], "bootMs": 903, "disposeMs": 24,
  "servicesMounted": 13,
  "layeringProof": "user patch override (dataDir) won last write; real session event recorded",
  "upstreamUntouched": true }
```
Nota: CLI memerlukan `pnpm` pada PATH (dipasang `npm i -g pnpm@10` dalam sandbox).

## 6. Nota keselamatan
- PAT GitHub digunakan secara TRANSIENT dalam env var sahaja; TIDAK ditulis ke mana-mana fail yang
  di-commit. `/tmp/ecc/` adalah cache baca-sahja tanpa kredensial.
- **Reminder kekal: revoke/rotate PAT tersebut selepas sesi.**
