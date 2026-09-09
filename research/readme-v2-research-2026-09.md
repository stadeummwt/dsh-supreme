# Research: README.md v2 — Comprehensive + Efficient + Hero Image

**Tarikh:** 2026-09-09 · **Skop:** research sahaja (TIADA pelaksanaan — menunggu arahan owner)
**Baseline:** `README.md` semasa = 652 baris, v1.3.1 (showcase-grade, proof-wall, 8 shields) — kukuh pada kandungan, lemah pada visual hero + navigasi.

---

## 1. Sumber yang dirujuk (semua awam, semasa sesi ini)

| Sumber | Apa yang diambil |
|---|---|
| `github.com/matiassingers/awesome-readme` | Senarai rujukan kanonik README terbaik + alat (diakses, tajuk disahkan) |
| `github.com/kyechan99/capsule-render` | API banner SVG dinamik — **62 contoh URL diekstrak dari README rasmi** (bukti parameter di §4) |
| `github.blog/2023-02-02-how-to-make-your-images-in-markdown-on-github-adjust-to-dark-and-light-modes` | Teknik rasmi `<picture>` + `prefers-color-scheme` (tajuk disahkan via search; sintaks standard §4.3) |
| `freecodecamp.org/news/how-to-write-a-good-readme-file` | Struktur seksyen standard (fetch 504 — kandungan dari pengetahuan, ditanda) |
| Hasil carian: dev.to / daily.dev / profile-crest "15 Expert Tips 2026" | Corak aesthetic: badges, TOC, collapsible, contribution graph |
| Dokumentasi rasmi GitHub (pengetahuan sedia, disokong hasil carian #35545/GitLab #386438) | Mermaid native, `details/summary`, had Markdown GH |

**Jujur:** 2 halaman gagal di-fetch (504) — kandungan mereka diganti dengan pengetahuan standard yang boleh disemak; tiada klaim dibina atas halaman yang gagal.

---

## 2. Penilaian baseline README semasa

**Kekuatan (kekal):** proof-wall "every claim executable"; badge CI sebenar; jadual perbandingan; install 60-saat; docs map; v1.2/v1.3 feature sections; FAQ.

**Celah (sasaran v2):**
1. **Tiada hero visual** — header teks + badges sahaja; repo card GitHub tiada social preview custom.
2. **652 baris tanpa collapsible** — jadual komposisi/docs map panjang menolak kandungan kritikal ke bawah.
3. **Tiada TOC** dengan anchor penuh (ada quick-links sebahagian).
4. **Tiada diagram** — senibina 7 plugin hanya teks/jadual.
5. Badge `upstream-d347e703908d` masih baca 78/78 (stale vs suite 101) — semak konsistensi nombor bila naik v2.
6. Tiada "at a glance" quick-facts (suite, probes, boots, benchmark) dalam satu pandangan.

---

## 3. Fakta platform GitHub yang mengikat reka bentuk

1. **GitHub Markdown TIDAK sokong CSS** — `background-image`, `style=`, `<style>` disingkir. "Background image" sebenar mustahil; yang boleh ialah **imej hero full-width di atas** + **social preview** pada repo card.
2. **`<picture>` + `prefers-color-scheme` DISOKONG** (rasmi sejak Feb 2023) — imej berlainan untuk mode gelap/terang.
3. **Mermaid native** dalam fenced code block ```mermaid — diagram tanpa imej.
4. **`<details>/<summary>` DISOKONG** — collapsible sections.
5. `<img src width="100%">` DISOKONG (width/height attributes); `loading="lazy"` tidak konsisten — jangan bergantung.
6. Imej luar (capsule-render/shields) = **dependency masa pandang** — jika servis down, README rosak sebahagian. Prinsip repo (*bukti sebenar > klaim*, self-contained) → **commit aset statik** adalah pilihan selari dengan nilai repo.

---

## 4. Teknik hero/background (disusun ikut kesesuaian)

### 4.1 capsule-render (SVG dinamik, paling popular)
Bukti parameter dari README rasmi (62 contoh URL diekstrak): `type` venom/wave/waving/transparent/rect/rounded/cylinder/shark/egg/blur · `color=0:HEX,50:HEX,100:HEX` gradient · `height` · `text` · `desc` (+`descSize`,`descAlign`) · `section=header|footer` · `reversal` · `animation=fadeIn|twinkling|blinking|scaling` · `stroke`/`strokeWidth` · `textBg` · `fontFamily`.

Contoh tuning jenama Supreme (GELAP→EMERALD→AMBER; **elak biru/indigo** — serasi dengan identiti "proof/PASS hijau" + peraturan warna rumah):

```markdown
![header](https://capsule-render.vercel.app/api?type=venom&height=220&text=DSH%20SUPREME&desc=The%20governance%20layer%20for%20DeepSeek%20Harness%20%C2%B7%20seven%20policy%20plugins%20%C2%B7%20every%20claim%20executable&descSize=15&color=0:111827,50:10B981,100:F59E0B&stroke=10B981&strokeWidth=1&animation=fadeIn&section=header)
```

Footer berkaca (reversal):
```markdown
![footer](https://capsule-render.vercel.app/api?type=waving&height=110&color=0:F59E0B,50:10B981,100:111827&section=footer&reversal=true)
```

**Trade-off:** servis pihak ketiga dipanggil setiap view (availability + log pihak ketiga). **Mitigasi selari prinsip repo:** render sekali, muat turun SVG, commit ke `assets/header.svg` — sama rupa, zero dependency.

### 4.2 Aset hero statik committed (paling selari dengan prinsip repo)
- **Pilihan A — SVG tangan sendiri** (gradient + teks + grid "shield") ~2–4 KB, tajam semua saiz, boleh audit kandungan fail.
- **Pilihan B — PNG hasil AI** (image-generation): banner cinematic "governance shield over code" → `assets/hero.png`; mesti dimampam <200 KB, width 100%.
- **Pilihan C — screenshot terminal suite hijau** (bukti sebenar!) sebagai hero — paling "DSH Supreme": imej larian `suite` COMPLETE sebenar.

### 4.3 Dark/light automatik (rasmi GitHub)
```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/hero-dark.svg">
  <img alt="DSH SUPREME — governance layer for DeepSeek Harness" src="./assets/hero-light.svg">
</picture>
```
Wajib `alt` deskriptif (aksesibiliti). Simpan kedua-dua varian jika kontras berbeza.

### 4.4 Pelengkap visual murah
- **Social preview** (repo Settings → Social preview) — upload banner 1280×640: "background" sebenar pada repo card, bukan pada README, tiada kos masa pandang.
- **Repobeats** (`repobeats.axiom.co/api/embed.svg?url=...`) — analytics heat ribbon; opsyenal.
- Shields endpoint dinamik (`.../badge/endpoint.svg?url=...`) untuk nombor hidup — TIDAK disyorkan pada nombor suite (mesti datang dari CI, bukan render masa pandang).

---

## 5. Struktur comprehensive yang disyorkan (v2 skeleton)

```text
HERO IMEJ (picture dark/light) → H1 + tagline + badge row (12→10, kemas) → install one-liner
QUICK LINKS / TOC (anchor emoji headers)
AT A GLANCE — 1 jadual 8 sel: suite 101/101 · probes 465+184 · boots 5/5 · bench 0-escape · router 0.038ms/1k · leaks 0 · upstream patches 0 · license MIT
WHY SUPREME (kekal, ringkas)
THE SEVEN PLUGINS — mermaid architecture (baru) + jadual ringkas; detail per plugin → <details>
60-SECOND INSTALL (kekal) + compositions → <details><summary>
PROOF WALL (kekal — pembedah utama; front-load 5 baris teratas, selebihnya <details>)
FEATURES v1.3.1 / v1.3 / v1.2 → <details> bertingkat
BENCHMARKS v1.3.1 (baru — ringkasan A/B/C 1 jadual + pautan benchmarks/)
VERIFICATION (macam mana nak lari sendiri — suite:v131:verify dsb.)
DOCS MAP → <details>
FAQ / TROUBLESHOOTING → <details>
LIMITS (batas jujur — kekal)
CONTRIBUTING · SECURITY · LICENSE · FOOTER capsule/statik
```

Anggaran: teks penuh turun 652 → ~480–520 baris PANDANG (kandungan sama, 30% dilipat), dengan nombor v1.3.1 dikemas kini (badge suite 78→101, tambah bench badge).

---

## 6. Kecekapan (efficiency) — peraturan yang dikenal pasti

1. **Front-load**: 3 perkara pertama pengunjung lihat = apa ini / install / bukti. Semua lain boleh dilipat.
2. **Satu sumber kebenaran per nombor**: nombor suite/probes ditulis SEKALI (at-a-glance) dan dirujuk — elak 8 tempat berbeza yang mungkin stale (bug #5 di §2).
3. **Imej**: SVG statik > PNG; setiap imej <200 KB; `width="100%"`; alt text wajib; maksimum 2 imej besar (header+footer).
4. **Pautan relatif** (`./docs/...`) bukan URL penuh — jimat & tahan rename.
5. **Jangan duplikasi docs/** — README ringkasan + pautan; kandungan panjang tinggal dalam docs/.
6. **Anchor TOC** mesti ikut corak GitHub (emoji → `#-why-supreme` — sudah betul dalam README semasa; kekalkan).

---

## 7. Had jujur

- "Background image" penuh (behind text) **tidak wujud** pada GitHub README — hanya hero atas + footer + social preview. Mana-mana tutorial yang mengaku CSS background pada GH = salah.
- capsule-render hidup = dependency luar; varian statik disyorkan.
- 2 sumber (freecodecamp, github.blog penuh) gagal di-fetch semasa research — struktur standard dan sintaks `<picture>` disokong oleh pengetahuan platform + hasil carian tajuk, boleh disemak sendiri.
- Tiada larian A/B engagement — cadangan susunan adalah best-practice, bukan data pengguna (repo privat kecil).

---

## 8. Pelaksanaan disyorkan bila owner arahan (belum mula)

1. Jana aset: `assets/hero-{light,dark}.svg` (atau PNG AI) + footer → commit.
2. Susun semula README ikut §5 (tiada kandungan dipadam — dilipat `<details>`).
3. Kemas kini semua nombor ke v1.3.1 + tambah badge bench.
4. Upload social preview (arahan manual owner).
5. Verifikasi: render preview locally (VS Code/GitHub preview), semak semua anchor TOC, saiz aset, hygiene check token (corak ghp-asterisk) bersih.
