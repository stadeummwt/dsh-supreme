# Research: Ekosistem Plugin DSH + Plugin-Bundle — status #802/#1045 & dua blocker bundle

**Tarikh:** 2026-09-09 · **Skop:** research (tiada kod diubah) · **Pinned upstream:** `d347e703908d0406b7a7ef80e3a0e594d86b2215` (`dsh-v0.1.3-alpha.1`, commit date **2026-09-04**)
**Status laporan owner yang dikaji:** v13+v131 gates PASS · build upstream OK (tsdown) · `plugin add` PASS + `node_modules/.pnpm/dsh-supreme` wujud · **blocked**: `bundle:verify` (obs stats 0) + `composition:verify` (relative dataDir)

---

## 1. Kaedah & sumber (semua disemak langsung sesi ini)

| Sumber | Cara | Keputusan |
|---|---|---|
| Discussion **#802** upstream | GitHub GraphQL (REST issues = 404 — ia *discussion*, bukan issue) | **Terverifikasi** — tajuk, badan penuh, 2 komen |
| Discussion **#1045** upstream | GitHub GraphQL | **Terverifikasi** — katalog komuniti |
| Nota senibina upstream `2026-08-30-retain-ignorable-external-session-events.md` | raw file (status: **implemented**) | Dibaca penuh |
| `packages/core/session/src/{types,index}.ts` @ **pinned** & @ master | raw file + diff | Diff nama event = **kosong** |
| `packages/bundle/README.md` @ master | raw file | Mekanisme bundle rasmi |
| Katalog rasmi `awesome-dsh-plugin/awesome-dsh-plugin` | raw README 984,529 B | **3,431 entri / 24 kategori** (badge rasmi: 3,408 — fluktuasi biasa) |
| Carian GitHub (repo/code) `dsh-plugin`, `dsh-bundle`, `ignorable`, `tsdown` | REST search | Senarai di §2–3 |

---

## 2. Sensus ekosistem (katalog rasmi, 3,431 entri)

Katalog rasmi = **`awesome-dsh-plugin/awesome-dsh-plugin`** (15,049★) — inilah yang dsh-market auto-feed. Pasaran dalam-harness = `dsh-market/dsh-market` (3,510★). Katalog komuniti kedua (#1045) = `Wanbinyu/deepseek-harness-community-catalog` (dsh-billing · dsh-plugin-git-inspect · dsh-launcher).

**24 kategori, 3,431 entri:**

| Kategori | Entri | | Kategori | Entri |
|---|---|---|---|---|
| UI Enhancements | 567 | | Skills | 141 |
| Tools & Capabilities | 459 | | Notifications & Integrations | 138 |
| Development & Runtime | 264 | | Themes & Appearance | 123 |
| **Sessions & Messages** | **216** | | **Security & Permissions** | **114** |
| **Workflow & Automation** | **208** | | Just for Fun | 108 |
| **Usage & Billing** | **188** | | Remote & Mobile | 106 |
| **Memory** | **162** | | Vision & Multimodal | 101 |
| **Models & Providers** | **148** | | Git & Code Review | 85 |
| | | | Plugin Markets & Managers | 75 |
| | | | Voice & Audio | 51 |
| | | | Docs & Rendering | 49 |
| | | | WSL & Windows Interop | 34 |
| | | | Identity & Communication | 13 |
| | | | AGI Architecture Exploration | 3 |

**⚠️ DSH Supreme BELUM tersenarai** (`rg -i "supreme|stadeummwt"` atas katalog = kosong). Artefak penghantaran sudah siap dalam `distribution/` — penyerahan manual owner masih tertangguh (polisi repo).

### Landsaing governance (saingan terdekat, kategori Security & Permissions 114 entri)

| Plugin | Apa buat | Beza dengan Supreme |
|---|---|---|
| `863683348/dsh-gov` | "Agent governance suite": tool gating allow/deny/ask wildcard | Paling hampir secara nama; tool-gating sahaja — tiada cost-class/RM0 routing, tiada verifier, tiada benchmark evidence, tiada proof wall |
| `940842546/dsh-permissions` | Permission rules engine gaya Claude Code (hard/deny/ask/allow) | Permissions sahaja; tiada bukti boleh-lari |
| `173787247/dsh-tool-budget` | Hard-stop tool calls lepas budget per-sesi | Satu domain (tool count) vs 7 domain + cost-class UNKNOWN⇒DENY |
| `173787247/dsh-repeat-stop` | Hard-stop tool call serupa berturut-turut | Subset kecil; Supreme cover deny-circumvention + taint |
| `cdxiaodong/dsh-guardian` | Intercept & audit setiap tool call | Audit-only; tiada verdict gate |
| `030611/dsh-verification-receipt` | JSONL ringkasan verifikasi per-turn | Paling dekat dgn supreme-verifier/observability; tunggal, tiada stack |
| `030611/qiushi-dsh-evidence-audit` | Resit JSONL hash-chained utk tool results | Bukti hash-chain; Supreme: schemas published + suite |
| `030611/dsh-telemetry-redactor` | Redact secret pattern dari telemetry export | Satu surface; Supreme: secret-sentinel + 6-surface audit |
| Plugin scanner (`plugin-sentinel`, `guardwall`, `plugin-security-review`, `provenance`) | Audit pra-pemasangan plugin pihak ketiga | Static/pre-install; Supreme ialah runtime governance |

Usage & Billing (188) — `dsh-cost-tracker`, `dsh-token-ledger-pro` (136 model pricing + budget bar) dll. = **perakaunan/panel UI**, bukan **kuatkuasa** (tiada DENY pada UNKNOWN/paid). Memory (162) — memori store/index; bukan *selection policy* dgn admission gate. Models & Providers (148) — provider/routing; tiada RM0-first + evidence-weighted + circuit breaker yang terverifikasi.

**Kesimpulan kedudukan:** tiada satu pun entri katalog yang buat gabungan 7-domain + proof-as-product. Nis jurang Supreme kekal: (1) masuk katalog rasmi, (2) bukti tanpa-senarai masih tiada bukti.

---

## 3. Mekanisme plugin-bundle (dokumen rasmi upstream)

- Setiap bundle nyatakan **`package.json → dsh.bundle.patch`** → dokumen patch (`cordis.patch.yml`); **launcher menglonggok (stack) patch layers** untuk bina profil ber nama (`packages/bundle/README.md`).
- **In-box**: `base / web-app / headless / acp-app / sdk-app / sdk-minimal` — resolve dari instalasi dsh. **Out-of-tree**: `dsh plugin --profile <nama> add <pkg>` → dipasang ke `node_modules` profil (struktur `.pnpm` yang owner nampak = **normal pnpm**), reconciler tambah entri ke `dsh.profile.bundles`.
- Rekabentuk: nota `2026-08-05-profile-plugin-bundles.md` (implemented); layering "last write wins" per row id — Supreme guna ini untuk bukti user-patch override dalam `bundle:verify`.
- **Tiada isu pada laluan pemasangan owner**: `plugin add` PASS + `.pnpm/dsh-supreme` wujud + boot OK + 13 services mount = mekanisme bundle **berfungsi** dalam env owner. Blocker berlaku selepas mount, pada bukti event/data.

---

## 4. Status sebenar #802 di pinned — "belum lengkap" itu TEPAT, tapi dua bahagian

**#802 (discussion, masih relevan):** *"Downstream plugins cannot safely persist their own Session events"* — plugin luar boleh `session.append('budget/exceeded', …)` (declaration-merge), tapi:
1. event itu tiada dalam `KNOWN_SESSION_EVENT_TYPES` (dijana repo), dan
2. **`Session.append()` tiada cara untuk set `ignorable: true`** pada envelope.

Akibat: sesi tersimpan **tak boleh dimuat balik** oleh proses Harness seterusnya ("poisoned session"). Komen #802 dokumentasi kes sebenar: `dsh-message-edit` meracuni **2/20 sesi** pada `0.1.0-rc.6` / `0.1.1-rc.2`.

**Yang SUDAH lengkap di pinned `d347e70` (2026-09-04 > nota fix 2026-08-30):**
- Envelope `SessionEvent.ignorable?: true` dikekalkan (types.ts:465, nota implemented 2026-08-30 — mengembalikan apa yang PR #3087 buang).
- **Reader-side**: `validateStoredEvents` terima event tak-dikenal **jika** envelope tersimpan bawa `ignorable: true` (`known-event-types.ts`, master & pinned).

**Yang MASIH TIADA (write-side) di pinned — bukti:**
```ts
// packages/core/session/src/index.ts:699-702 @ d347e70
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []   // ← tiada ignorable
): SessionEvent<T>
```
→ Plugin pihak ketiga **masih tak boleh menghasilkan** event durable yang patuh — #802 secara dasarnya **belum selesai**; yang siap ialah toleransi bacaan. Tambahan: migrasi v0→v1 kekal menolak SEMUA jenis tak-dikenal (nota `2026-08-31-alpha-historical-unknown-event-refusal`).

**Hubung kait dgn blocker owner (hipotesis tersusun, lihat §6):** sesi beracun pra-fix dari plugin pihak ketiga lain dalam `~/.dsh` boleh buat laluan session service gagal → tiada `session/created` ditembak → obs stats 0.

---

## 5. Fakta kontrak yang MENOLAK satu hipotesis: bukan rename seam

Supreme-observability melanggan: `session/created`, `session/disposed`, `session/event` (+ jenis `turn/*`, `step/*`, `tool/call`).

Diff pinned vs master (`packages/core/session/src/index.ts`):
```
pinned: 'session/created' 'session/disposed' 'session/end-seed' 'session/event' 'session/flush'
master: 'session/created' 'session/disposed' 'session/end-seed' 'session/event' 'session/flush'
```
**Identik.** Tiada drift nama seam antara pinned dan master terkini → "upstream tukar nama event" **ditolak** sebagai punca.

Juga disemak: pinned memang guna **tsdown** (`build:lib:host = tsc -b && tsdown`) → "tsdown berjaya" owner = build normal pinned, bukan tanda upstream lain dipin.

---

## 6. Diagnosis dua blocker (matriks ujian konkrit)

`bundle:verify` gagal di **langkah 6**: cipta sesi `bundle-e2e` → tunggu 300 ms → wajib `obs.stats().written ≥ 1` + JSONL override ada baris. `composition:verify` gagal di bukti yang sama (event → `<cwd>/.supreme-data/`). **Kedua-dua kongsi satu punca: 0 rekod mendarat.**

Reka-bentuk observability: **fail-open** (`if (!writer) return;` — rekod dibungkam senyap, agen tak terjejas). Maka `written=0` **tidak boleh dibezakan dari luar** antara tiga punca — kecuali dgn `dropped`:

| Keputusan stats | Maksud | Ujian | Remedi |
|---|---|---|---|
| `written=0, dropped=0` | Event tak pernah sampai ke listener `ctx.on` | Boot dgn **DSH_HOME kosong segar** (bypass sesi beracun #802); kalau lulus → env lama beracun | Bersihkan/arkib sesi beracun; atau profil khusus utk verify |
| `written=0, dropped>0` | Writer buka OK tapi **tulis gagal** (kebenaran/NTFS/antivirus) | Bandingkan `dropped`; cuba dataDir **mutlak** | Baiki kebenaran folder; whitelist antivirus |
| `writer=null` | Init gagal sebelum guna (fail-open) | Semak stderr `ctx.logger` masa boot | Perbaiki dataDir (mutlak ujian) |

**Penilaian jujur:** "bukan path" owner belum terbukti daripada luar — fail-open menyembunyikan beza antara *tiada event* vs *tulis gagal*. `dropped` ialah pembektu satu-baris.

**Apa yang BOLEH dibuat di sisi Supreme (tanpa patch upstream):**
1. Verifier `bundle`/`composition` cetak **`stats()` penuh (written+dropped+rotations)** dalam mesej gagal — sekarang hanya bukti objek tanpa `dropped`.
2. Boot-time **self-check** audit: sekali log (stderr/logger, tiada nilai) status open-writer + path resolved — membuat punca `writer=null/erreur` kelihatan.
3. Runbook: pembersihan/arkib sesi terjejas #802 (`DSH_HOME` segar utk verification).
4. (Pilihan) Workflow verification guna event yang TAK bergantung pada persistence session (mis. trigger `tools/execute` audit yang tulis terus) — kurangkan permukaan #802.

**Yang perlu upstream (jejak, jangan patch sendiri):** API write-side `ignorable` (sambung discussion #802), toleransi migrasi v0→v1, mekanisme daftar event plugin.

---

## 7. Cadangan kedudukan (ikut bukti §2)

1. **Hantar `distribution/awesome-dsh-entry.yml` ke katalog rasmi** — 3,431 entri dan Supreme tiada; kategori paling padan: *Security & Permissions* (114) — bukti kelas atas (verdict gates, 101/101, proof wall) adalah pembedah langsung vs 114 entri itu.
2. Jejak #802 — jangan bina apa-apa pada session-persistence event pihak ketiga sehingga write-side siap (sudah jadi reka-bentuk Supreme: JSONL sendiri, fail-open).
3. Tambah `dropped` pada mesej gagal verifier (improvement kecil, bukti lebih tajam).
4. Katalog komuniti #1045 ≠ katalog rasmi; kalau nak dua-dua pun boleh, tapi rasmi dulu (dsh-market auto-feed darinya).

## 8. Had jujur research ini

- Tiada larian dalam env owner (Windows?) — semua diagnosis dari kod + API; matriks §6 direka supaya owner boleh piket satu larian.
- Katalog 3,431 entri diproses automatik (parser atas struktur Markdown rasmi) — nombor kategori mungkin ±beberapa entri berbanding count.json rasmi (3,408).
- Discussion #802 status "open" tidak diambil sebagai isu bertarikh — ia discussion, bukan issue berstate.
- PAT GitHub digunakan secara transient (header API) untuk kadar had — tiada PAT dalam repo.
