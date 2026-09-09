# Review Pelan v3 + `supreme-policy.cordis.yml` (V3-REVIEW)

Tarikh: 2026-09-09 · Input: `upload/cadangan-improvement-dsh-supreme-v3.md` + `upload/supreme-policy.cordis.yml`
Kaedah: setiap klaim dibandingkan dengan **kod sebenar** (`src/plugins/*`), **semantik patch upstream** (`vendor/include`), dan **boot sebenar** (`real/v3-config-verify.mjs` → `V3_CONFIG_REVIEW_EVIDENCE`).

Prinsip review = prinsip projek sendiri: **evidence > klaim**. Statistik luaran dalam dokumen v3
(25.5% hidden-Unicode, 17.0% fake-completion, HNSW 1.9–4.7×, 65% token, harga/benchmark Astra, dst.)
**TIDAK dapat diverifikasi** dari repo (rujukan `[n]` tidak resolvable) — dilabel UNVERIFIED. Mekanisme
cadangan dinilai atas merit sendiri, bukan atas angka tersebut.

---

## 1. Verdict ringkas

| Bahagian v3 | Verdict | Alasan sepintas |
|---|---|---|
| yml `supreme-policy` | ❌→✅ **BETULKAN** | 5/6 key fiction (silently stripped — dibuktikan hidup), `executionClass` tiada |
| §1 Unicode taint scrub | ✅ ADOPT | Deterministik, tiada LLM, vektor sebenar; **belum wujud** dalam suite |
| §1 Cyber signature DB | ⚠️ ADAPT | Hadkan ke args *sensitive-sink* sahaja (elak false-positive swamp) |
| §1 Sandbox Mirage / FUSE | ❌ REJECT | Plugin tak boleh mount FUSE/kontainer = langgar zero-patch/host-side; `allowCommands=false` + `allowedRoots` sudah beri sifat keselamatan sama |
| §2 Note-Keeping Ledger | ✅ ADOPT | JSONL append-only = selari invarian sedia ada |
| §2 HNSW / AgentDB / ReasoningBank | ❌ DEFER | ANN penganggaran = tak deterministik dalam laluan polisi; dep berat = permukaan rantaian bekalan (kontradik §4B sendiri) |
| §3 Classifying tugasan sifar-token | ⚠️ ADAPT | Seam input (`requiredCapabilities`) SUDAH ada; auto-classifier regex deterministik boleh tambah |
| §3 Pacing reasoning effort | ✅ ADOPT | Pemetaan deterministik costClass→effort; eskalasi hanya bila verifier FAIL (bukan penilaian model) |
| §3 Ollama / model percuma | ✅ ADOPT | Tulen config — calon router ialah data, bukan kod |
| §4 Surgical scope | ✅ ADOPT | `buildDelegationScope` sedia ada; tambah `allowedPaths`/`blockedPaths` |
| §4 TDD fail-closed | ✅ ADOPT | Kebanyakan wayar sedia: `requireVerificationForHighRisk` (polisi) + gerbang penutupan workflow |
| §4 Bumblebee (alat luaran) | ⚠️ ADAPT | Tolak dep luaran; jadikan **suite check pinned-ref** deterministik |
| §5 "model-visible = logged" | ✅ SUDAH ADA | Append-only JSONL + allowlist + sentinel scrub (`engine.ts:75-78`) — v3 mengesahkan rekabentuk semasa |
| §5 CoT anchoring (suntik prompt) | ❌ REJECT→⚠️ ADAPT | Suntikan prompt = tadbir urus tak boleh bukti; ganti dengan **gerbang kehadiran CoT** deterministik |
| §5 Fail-open ops / fail-closed audit | ✅ SUDAH ADA | Penulis fail-open sedia ada |
| §6 JSON IR terikat commit | ✅ ADOPT prinsip | Padan 100% dgn proof-first; enjin luaran Archify = DEFER (dep tak disahkan) |
| Runbook boot/suite | ✅ SAH | `--profile/--setup` real (`boot.mjs:44-51`), `bun run suite` real |

**Skor jujur:** daripada 17 cadangan berbeza → 7 ADOPT, 5 ADAPT, 3 REJECT, 2 SUDAH ADA.
Dokumen v3 ialah **lobi arah yang baik dengan anatomi config yang salah** — nilainya pada ARAH,
bukan pada key yml.

---

## 2. Bedah `supreme-policy.cordis.yml` (bukti hidup)

Schema Config SEBENAR (`src/plugins/supreme-policy/index.ts`):

```ts
executionClass: z.enum(['CORE','STANDARD','SUPREME','LAB']).default('STANDARD'),
allowPaid: z.boolean().default(false),
allowTrial: z.boolean().default(false),
allowUnknownCost: z.literal(false).default(false),   // UNKNOWN hard-DENY — tak boleh diaktifkan langsung
requireVerificationForHighRisk: z.boolean().default(true),
maxDelegationDepth: z.number().int().min(1).max(8).default(3),
```

Run hidup (`bun run v3:verify` → `V3_CONFIG_REVIEW_EVIDENCE`, real CLI install + boot):

| Key yml ko | Status | Bukti |
|---|---|---|
| `enableUnicodeSanitization: true` | ❌ STRIPPED | tiada dalam `seenByPlugin` |
| `logTaintAttempts: true` | ❌ STRIPPED | tiada dalam `seenByPlugin` |
| `unknownCostPolicy: 'DENY'` | ❌ STRIPPED | key sebenar ialah `allowUnknownCost` (literal `false` — DENY kekal tanpa config) |
| `allowPaid: false` | ✅ HONORED | satu-satunya key yang sampai |
| `enableSensitiveSinkBlocking: true` | ❌ STRIPPED | tiada dalam `seenByPlugin` |
| `logLevel: 'info'` | ❌ STRIPPED | bukan key plugin (logger ctx, bukan config) |
| **`executionClass`** | ⚠️ **TIADA DALAM YML** | jatuh ke default `STANDARD` — operator ingat SUPREME aktif padahal tidak |

**Bahaya sebenar:** `z.object()` default zod **menanggalkan key asing secara senyap** — boot lulus,
log nampak normal, tapi 5 lapisan "tadbir urus" yang ko rasa aktif itu TIDAK WUJUD. Ini tepat
"fictional slop" yang §6 dokumen v3 sendiri nak elakkan — terjadi pada paras config.

### Yml dibetulkan (tersimpan: `config/examples/supreme-policy.cordis.yml`)

```yaml
- id: supreme-policy
  name: './dist/plugins/supreme-policy/index.mjs'
  config:
    executionClass: SUPREME              # ← kunci tadbir urus PALING PENTING (tiada dalam yml asal)
    allowPaid: false                     # honore ✓ (yml asal betul)
    allowTrial: false
    allowUnknownCost: false              # DENY ialah SIFAT KEKAL literal-false; key ini dokumenhasikan niat
    requireVerificationForHighRisk: true # ganti "sensitive sink blocking" yang sebenar
    maxDelegationDepth: 3
```

Nota struktur: yml asal **hanya daftar 1 plugin**. Untuk suite penuh, guna bundle
(`dsh plugin add`) + fragmen komposisi `config/compositions/supreme.patch.yml` — jangan
hand-roll satu row; dan `name: './dist/...'` hanya resolve bila fail duduk **sebelah `dist/`**
(ankor patch) — dalam profile `cordis.yml` ia akan resolve ke lokasi salah.

---

## 3. Review per-bahagian (dengan seam kod sebenar)

### §1 Pertahanan suntikan — ADOPT 2, ADAPT 1, REJECT 1
- **Unicode taint scrub → IMPLEMENT SEBAGAI FEATURE v1.2.** Saat ini TIADA scrub unicode dalam
  suite (grep: hanya `sanitizeEvidence` verifier — had panjang — dan sentinel scrub observability).
  Bentuk pelaksanaan yang padan dengan arkitek: effect event di `supreme-policy`
  (`ctx.on` seam rasmi, pola sama dengan observability) yang imbas arg string pada event
  tool-execute untuk julat aksara halimunan (U+200B–200F, U+2060–206F, bidi U+202A–202E,
  tag U+E0000+) → `logTaintAttempts` ke observability + block konfigurasi. Suite check baharu:
  arg di-taint → jangkaan scrub/block deterministik. Key config `enableUnicodeSanitization`/
  `logTaintAttempts` yang ko cadangkan **boleh dijadikan real** — tambah ke schema (backwards-safe,
  default true/false).
- **Signature DB** → hadkan ke args *sensitive-sink* (pola `rm -rf`, `curl | sh`, dsb.) — deterministik.
  Imbasan umum "kod eksploit" pada output model = rawan false-positive; tolak.
- **Sandbox Mirage/FUSE** → REJECT: plugin polisi host-side tak boleh mount FS/kontainer tanpa
  memiliki runtime (langgar zero-patch, patches=0 kekal). Sifat keselamatan yang sama sudah
  diwarisi: `allowCommands=false` + `allowNetwork=false` + `allowedRoots` (verifier). Sandbox ialah
  keputusan hos/upstream, bukan polisi plugin.

### §2 Memori — ADOPT ledger, REJECT vektor
- **Note-Keeping Ledger → ADOPT.** Bentuk deterministik: JSONL append-only (invarian sedia ada),
  had entri + retensi (polisi, bukan ML), pilihan masuk prompt-section mengikut
  priority/tags — sambung terus pola `projectKnowledge` yang sudah wujud dalam memory-policy Config.
  Key cadangan: `ledgerEnabled`, `ledgerMaxEntries`, `ledgerRetainTurns`.
- **HNSW/AgentDB → DEFER (v1.4+).** Tiga sebab: (1) ANN tak menjamin susunan deterministik —
  tak boleh masuk laluan polisi; (2) dep native berat = permukaan rantaian bekalan, kontradik
  hasrat §4B sendiri; (3) angka 1.9–4.7× / 65% = UNVERIFIED. Pada skala ledger (entries dihadkan),
  retrieval tag/priority O(n) cukup pantas dan 100% boleh bukti.

### §3 Router — ADOPT pacing, ADAPT classifier, ADOPT contoh Ollama
- **Pacing reasoning effort → ADOPT.** Key: `reasoningEffortByCostClass`
  (`FREE_CONFIRMED→low`, `PAID→medium`, default), deterministic; eskalasi `high` HANYA bila
  `verifier` melaporkan FAIL (keputusan mekanikal, bukan keyakinan model). Upstream API effort
  real (rejection "empty reasoning efforts" pernah direkod dalam worklog).
- **Classifying sifar-token → seam SUDAH ADA** (`selectRoute` terima `requiredCapabilities`/
  `requiredContextTokens` dari pemanggil). Yang boleh ditambah: `taskClassHints` (regex→capability)
  deterministik di hos. Nilai tambah sederhana; bukan keutamaan.
- **Temuan daripada review yang tak ada dalam v3:** berat skor router (`quality/quota/latency/...`)
  **tiada komponen kos** — antara calon FREE, tiada ikatan RM0-first pada paras skor. Cadangan:
  tambah weight `cost` / aturan costClass-first bila capability setara. Ini improvement paling
  murah dengan impak kos paling besar.
- **Ollama/Gemma/Qwen calon** → tulen config (calon = data). Sediakan contoh profile config dalam
  docs. Kos kod: sifar.

### §4 Workflow — ADOPT dua, ADAPT satu
- **Surgical scope → ADOPT.** `buildDelegationScope` sudah wujud; tambah `allowedPaths`/`blockedPaths`
  (glob) ke Config workflow-policy; DENY deterministik bila edit di luar skop. Verifier
  `allowedRoots` kekal sebagai sandaran fs-level.
- **TDD fail-closed → ADOPT sebagai wayar sedia:** `requireVerificationForHighRisk` (polisi, SUDAH ADA)
  + key workflow baharu `requireVerifierPassOnClose`. Dalam STANDARD (`allowCommands=false`) ujian
  tak boleh dijalankan oleh verifier — jadi polisi jujur ialah: tugasan HIGH wajib rekod PASS verifier;
  LAB boleh laksana ujian sebenar.
- **Bumblebee → REJECT dep luaran, ADAPT prinsip:** suite check baharu "pinned-ref enforcement" —
  imbas profil/konfigurasi: sebarang rujukan skill/MCP/dep luaran wajib pinned commit/versi.
  Deterministik, kos rendah, selari dengan prinsip pinning yang suite sudah amalkan pada upstream.

### §5 Observability — 2 SUDAH ADA, 1 REJECT→ADAPT
- "Model-visible = logged", fail-open/fail-closed, sentinel scrub → **SUDAH TERLAKSANA**
  (`engine.ts`: append-only JSONL, allowlist, `Never serialize d.arguments`, scrub
  `SECRET_SENTINEL*` → `[REDACTED]`, writer fail-open). Dokumen v3 mengesahkan rekabentuk —
  tak perlu kerja.
- **CoT anchoring (suntik arahan paksaan) → REJECT.** Menukar prompt model untuk "paksa telus"
  ialah tadbir urus atas kepercayaan diri model — tepat benda yang §1B v3 sendiri tolak
  ("tidak boleh bergantung kepada penilaian keyakinan diri model"). ADAPT deterministik:
  **gerbang kehadiran CoT** — tindakan sensitif tanpa jejak penaakulan → event audit
  `cot_missing` (+ pilihan deny melalui verificationRequirement). Boleh bukti, hos-side.

### §6 Archify — ADOPT prinsip, DEFER enjin
- Prinsip JSON IR + susunan deterministik + terikat commit + compare 5 kelas kata nama = **100%
  selari dengan proof-first**. Tapi: `tt-a1i/archify` TIDAK muncul dalam research ecosystem kami
  (RESEARCH-1/2) — dep tak disahkan. v1.2: tambah `irVersion` + validasi zod IR + medan
  `commitHash` terikat pada rekod benchmark (murah, deterministik). Enjin render penuh → v1.3+
  atau alat luaran DI LUAR laluan polisi.

### Runbook — SAH
`node real/boot.mjs --profile supreme --setup` + `bun run suite` disahkan real
(`boot.mjs:44-51`). Tambah dua arahan bukti v1.1: `bun run bundle:verify`,
`bun run composition:verify`, dan `bun run v3:verify` (bukti review ini).

---

## 4. Backlog keutamaan (guna data v3, terikat seam sebenar)

| # | Item | Asal | Plugin/seam | Saat ini | Usaha |
|---|---|---|---|---|---|
| 1 | Contoh yml dibetulkan + check "config-key-hygiene" (validasi semua key dalam config/*.yml menentang schema) | yml review | suite + `config/examples/` | ✅ yml masuk repo kali ini | S |
| 2 | Unicode taint scrub + `logTaintAttempts` | §1A | supreme-policy event effect | belum ada | M |
| 3 | `reasoningEffortByCostClass` + eskalasi on-verifier-FAIL | §3B | supreme-router Config + decision | belum ada | M |
| 4 | Berat/aturan **cost-first** antara calon FREE | temuan review §3 | supreme-router engine | belum ada | S |
| 5 | `allowedPaths/blockedPaths` surgical scope | §4A | supreme-workflow-policy | belum ada | M |
| 6 | `requireVerifierPassOnClose` | §4A | supreme-workflow-policy + verifier | separa (polisi ada) | S |
| 7 | Note-Keeping Ledger deterministik | §2A | supreme-memory-policy | belum ada | M |
| 8 | Gate kehadiran CoT (audit event, bukan suntikan) | §5 | supreme-observability + policy | belum ada | M |
| 9 | Suite check pinned-ref utk rujukan luaran | §4B | src/suite | belum ada | S |
| 10 | IR versioning + `commitHash` binding | §6 | supreme-benchmark | belum ada | S |
| 11 | HNSW/AgentDB | §2B | — | DEFER v1.4+ | L |
| 12 | Enjin Archify penuh / FUSE sandbox | §6/§1 | — | DEFER/REJECT | L |

**Susunan disyorkan v1.2:** #1 → #4 → #2 → #5 → #3 → #6 (semua deterministik, tiada dep baharu,
setiap satu dengan suite check + bukti boot). #7–#10 v1.2-late/v1.3. #11–#12DEFER.

---

## 5. Nota integriti data
- Semua angka sitasi v3 (kadar serangan, benchmark Astra, HNSW, 65%) = UNVERIFIED-EXTERNAL;
  jangan guna dalam README/market copy sampai disumberkan.
- Bukti review ini: `bun run v3:verify` (real CLI install → boot → dump config yang sampai ke
  plugin). Tiada fail upstream disentuh; `upstreamUntouched: true`.
