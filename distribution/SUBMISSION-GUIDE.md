# Submission guide — awesome-dsh-plugin / dsh-market (MANUAL, owner-driven)

Policy of this repository: **no pull requests are opened on third-party
repositories on the owner's behalf.** Everything below is a prepared artifact
so that the owner can run the submission personally, review every step, and
press the final button. Nothing here has been auto-submitted.

## 0. How distribution actually works (researched 2026-09-08)

- `dsh-market/dsh-market` (the market app, npm `dshmarket`) is **not** the
  catalog. It rebuilds from `awesome-dsh-plugin.com/plugins.json` on every
  open and never accepts plugin submissions directly (CI `wrong-repo-guard`
  rejects any PR touching its registry snapshot).
- The single submission channel is **one yml file PR** to
  `awesome-dsh-plugin/awesome-dsh-plugin`:
  `data/plugins/stadeummwt__dsh-supreme.yml`.
- After a maintainer merges, READMEs and `plugins.json` regenerate on main,
  the market app and dshmarket.com pick the entry up on the next daily
  refresh (usually within a day). No further action needed.

## 1. Pre-flight checklist (all verified satisfied as of v1.2)

| Catalog gate (pr-gate.yml) | Status |
|---|---|
| `dsh.bundle` manifest in a `package.json` anywhere in the tree | OK — root `package.json` → `dsh.bundle.patch: ./cordis.patch.yml` |
| Repo not archived, not a fork, not deepseek-ai/deepseek-harness | OK |
| Repo age ≥ 1 day | OK — repo created 2026-09-08; `regate.yml` re-runs every 6 h so the bar self-clears |
| ≤ 3 changed catalog entries per PR | OK — exactly one new file |
| GitHub topic `dsh-plugin` on the repo | OK — set on stadeummwt/dsh-supreme (plus 10 related topics) |
| No duplicate entry (no `supreme`/`stadeummwt` in data/plugins) | OK — checked against the catalog tree |

## 2. Manual submission steps

```sh
# 1) fork + clone the catalog (your own GitHub account, your click)
git clone https://github.com/<YOU>/awesome-dsh-plugin && cd awesome-dsh-plugin

# 2) copy the prepared entry (single file, nothing else)
cp /path/to/dsh-supreme/distribution/awesome-dsh-entry.yml \
   data/plugins/stadeummwt__dsh-supreme.yml

# 3) validate exactly like CI does (unauthenticated)
npm ci
node scripts/generate-readme.mjs --check
npx awesome-lint

# 4) commit + push + open the PR yourself
git checkout -b add-stadeummwt-dsh-supreme
git add data/plugins/stadeummwt__dsh-supreme.yml
git commit -m "Add stadeummwt/dsh-supreme (security)"
git push -u origin add-stadeummwt-dsh-supreme
```

- **PR title (catalog convention):** `Add stadeummwt/dsh-supreme (security)`
- Category `security` = the catalog's `### Security & Permissions` section;
  ordering/TOC are regenerated automatically, do not hand-edit them.
- CI on the PR: stale-fork guard, yml-only check, README↔data match,
  awesome-lint, site build, then the token-scoped submission gate; a human
  reviewer checks description-vs-code accuracy afterwards.

## 3. npm publish (optional)

`package.json` is publish-ready since v1.2.0 (`private` removed, full
metadata: repository/keywords incl. `dsh-plugin`/homepage/bugs). If you want
an npm entry in the market listing (downloads column), publish with your own
token; the catalog's `probe-npm.mjs` links npm automatically **only** because
`repository` points back at this repo.

## 4. Post-merge expectations

- `added` date comes from git history of the entry file; stars/downloads are
  refreshed nightly as floors.
- The market app shows the plugin after the next catalog rebuild — allow one
  day after merge.

## 5. History note (honesty record)

2026-09-08: a submission PR (#4686) had been opened on the catalog from a
fork of this account; the owner does not permit PRs to third-party repos on
their behalf, so the PR was closed as not-planned and the fork was deleted
the same day. This guide + `awesome-dsh-entry.yml` are the replacement
artifacts. Nothing was ever merged.
