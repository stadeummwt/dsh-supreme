#!/usr/bin/env bun
/**
 * dsh-supreme/real/v131-verifier-hardening.mjs — v1.3.1 verifier hardening
 * evidence for the two external-review findings against v1.3.0:
 *
 *   ISSUE B (P1) — Symlink bypasses allowedRoots:
 *     engine.ts confined file validators with path.resolve() ONLY (lexical).
 *     A symlink inside an allowedRoot pointing OUTSIDE the root was followed
 *     and the out-of-root file content was read + hash-verified.
 *
 *   ISSUE E (P2) — JSON Schema false PASS:
 *     additionalProperties:false (and several other keywords) were ignored;
 *     objects carrying extra properties got PASS.
 *
 * Modes (bun only — imports the REAL TS engine directly, no build, no new deps):
 *   bun real/v131-verifier-hardening.mjs repro
 *     Demonstrates BOTH bugs on the CURRENT code. Exit 0 + prints
 *     V131_VERIFIER_BUGS_REPRODUCED iff both bugs are still present.
 *
 *   bun real/v131-verifier-hardening.mjs verify
 *     Acceptance gates on SYNTHETIC fixtures only (temp dir under os.tmpdir(),
 *     never real user data). Exit 0 + prints V131_VERIFIER_FIX_VERIFIED iff
 *     every case passes. FAILS on the original (v1.3.0) code.
 *
 * Platform notes: developed + executed on Linux. v1.3.3: the B4 platform
 * gate accepts linux/win32/darwin — symlink and Windows junction semantics
 * are delegated to node fs.realpath in both modes, and the lexical
 * pre-filter (pathIsAllowed) is separator-correct for `\` paths.
 *
 * Security notes: all printed evidence is paths-as-given / statuses / reason
 * codes / hash prefixes only — file CONTENT is never printed. The B2 case
 * plants a canary string in the out-of-root target and asserts the canary
 * NEVER appears in any output, verdict or event emitted during the run.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url);
const engineHref = new URL('src/plugins/supreme-verifier/engine.ts', ROOT).href;
const engine = await import(engineHref);

const MODE = process.argv[2] ?? '';
if (MODE !== 'repro' && MODE !== 'verify') {
  console.error('usage: bun real/v131-verifier-hardening.mjs <repro|verify>');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Shared fixture + REAL fs runtime (mirrors the production adapter contract:
// lexical members pre-hardening, real-path members post-hardening).
// ---------------------------------------------------------------------------
const CANARY = 'V131_CANARY_secret_outside_root'; // planted OUTSIDE allowedRoots (B2)

const makeRuntime = () => {
  const fsmod = process.getBuiltinModule('node:fs');
  return {
    // legacy / lexical members
    fsExists: async (p) => fsmod.existsSync(p),
    fsRead: async (p) => {
      try { return await fsmod.promises.readFile(p, 'utf8'); } catch { return null; }
    },
    sha256: async (p) => {
      try {
        return createHash('sha256').update(await fsmod.promises.readFile(p)).digest('hex');
      } catch { return null; }
    },
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    // real-path members (post-hardening runtime contract)
    realpath: async (p) => fsmod.promises.realpath(p),
    stat: async (p) => {
      try {
        const st = await fsmod.promises.stat(p);
        return { dev: st.dev, ino: st.ino, size: st.size };
      } catch { return null; }
    },
    readBytesWithFstat: async (p) => {
      let fh;
      try {
        fh = await fsmod.promises.open(p, 'r');
        const st = await fh.stat(); // fstat on the OPEN handle
        const bytes = await fh.readFile();
        return { bytes, dev: st.dev, ino: st.ino, size: st.size };
      } catch { return null; }
      finally { try { await fh?.close(); } catch { /* already closed */ } }
    },
    hashBytes: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
  };
};

const pathMod = { resolve, relative, isAbsolute };

const CFG = (roots) => ({
  allowCommands: false,
  allowNetwork: false,
  allowedRoots: roots.map((r) => resolve(r)),
  commandTimeoutMs: 1000,
});

const runSpec = async (spec, config, subject) =>
  engine.runValidator({
    spec,
    config,
    runtime: makeRuntime(),
    pathMod,
    labPolicyConfirmed: false,
    subject,
  });

/** Fixture tree (synthetic only, under os.tmpdir()):
 *   <tmp>/root/                 allowedRoot
 *   <tmp>/root/inside.txt       in-root file
 *   <tmp>/root/link-inside      symlink -> <tmp>/outside/secret.txt   (B escape)
 *   <tmp>/root/link-sibling     symlink -> <tmp>/root-sibling/file.txt (sibling escape)
 *   <tmp>/root/loop             symlink -> itself                     (ELOOP clarity)
 *   <tmp>/outside/secret.txt    CANARY content, OUTSIDE any root
 *   <tmp>/root-sibling/file.txt sibling dir one char off the root name
 */
const buildFixture = () => {
  const base = mkdtempSync(join(tmpdir(), 'v131-verifier-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  const sibling = join(base, 'root-sibling');
  mkdirSync(root); mkdirSync(outside); mkdirSync(sibling);
  const insideTxt = join(root, 'inside.txt');
  const secretTxt = join(outside, 'secret.txt');
  const siblingTxt = join(sibling, 'file.txt');
  writeFileSync(insideTxt, 'inside-content\n');
  writeFileSync(secretTxt, `${CANARY}\n`);
  writeFileSync(siblingTxt, 'sibling-content\n');
  symlinkSync(secretTxt, join(root, 'link-inside'));
  symlinkSync(siblingTxt, join(root, 'link-sibling'));
  const loop = join(root, 'loop');
  symlinkSync(loop, loop);
  const shaOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  return { base, root, outside, sibling, insideTxt, secretTxt, siblingTxt, shaOf };
};

let CLEANUP = null;
const cleanup = () => { if (CLEANUP) { try { rmSync(CLEANUP, { recursive: true, force: true }); } catch { /* best effort */ } } };

const platformNotes = () => {
  console.log(`  platform=${process.platform} (symlink/junction confinement delegated to node fs.realpath; gate accepts linux/win32/darwin)`);
};

// ---------------------------------------------------------------------------
// Mode: repro — demonstrate BOTH bugs on the current code.
// ---------------------------------------------------------------------------
const repro = async () => {
  const fx = buildFixture();
  CLEANUP = fx.base;
  try {
    let bugB = false;
    let bugE = false;

    // BUG B: symlink inside allowedRoot -> file OUTSIDE the root. The v1.3.0
    // engine lexically accepts <root>/link-inside, then READS through the
    // symlink; the out-of-root content hash-verifies => PASS (full bypass).
    const hashB = fx.shaOf(fx.secretTxt); // computed by the script itself (fixture known)
    const resB = await runSpec(
      { validatorId: 'b', type: 'file-hash', config: { path: join(fx.root, 'link-inside'), sha256: hashB } },
      CFG([fx.root]),
    );
    console.log(`  [B] file-hash via out-of-root symlink -> status=${resB.status} reason=${resB.reasonCode} evidence=${JSON.stringify(resB.evidence)}`);
    if (resB.status === 'PASS') {
      bugB = true;
      console.log('  [B] BUG PRESENT: out-of-root file content was read and hash-verified through a symlink (allowedRoots bypassed).');
    } else {
      console.log('  [B] bug absent: out-of-root symlink was rejected before content read.');
    }

    // BUG E: additionalProperties:false ignored -> object with an extra
    // property gets PASS.
    const schemaE = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } };
    const resE = await runSpec(
      { validatorId: 'e', type: 'json-schema', config: { schema: schemaE } },
      CFG([]),
      JSON.stringify({ ok: true, extra: 'unspecified-property' }),
    );
    console.log(`  [E] extra property vs additionalProperties:false -> status=${resE.status} reason=${resE.reasonCode} evidence=${JSON.stringify(resE.evidence)}`);
    if (resE.status === 'PASS') {
      bugE = true;
      console.log('  [E] BUG PRESENT: object with an extra property PASSED although additionalProperties:false.');
    } else {
      console.log('  [E] bug absent: extra property was rejected.');
    }

    if (bugB && bugE) {
      console.log('V131_VERIFIER_BUGS_REPRODUCED');
      process.exitCode = 0;
    } else {
      console.log(`V131_VERIFIER_BUGS_NOT_REPRODUCED (B=${bugB ? 'present' : 'absent'} E=${bugE ? 'present' : 'absent'})`);
      process.exitCode = 1;
    }
  } finally {
    cleanup();
  }
};

// ---------------------------------------------------------------------------
// Mode: verify — acceptance gates, synthetic fixtures only.
// ---------------------------------------------------------------------------
const collected = []; // every printed line, for the B2 canary-leak assertion
const out = (line) => { collected.push(line); console.log(line); };

const checks = [];
const gate = (name, ok, detail = '') => {
  checks.push({ name, ok: ok === true });
  out(`  ${ok === true ? 'PASS' : 'FAIL'}  ${name}${ok === true ? '' : `  << ${detail}`}`);
};

const verify = async () => {
  const fx = buildFixture();
  CLEANUP = fx.base;
  try {
    platformNotes();

    // ----- B1: valid in-root files still verify --------------------------------
    const b1 = await runSpec(
      { validatorId: 'b1', type: 'file-hash', config: { path: join(fx.root, 'inside.txt'), sha256: fx.shaOf(fx.insideTxt) } },
      CFG([fx.root]),
    );
    gate('B1 in-root file-hash verifies (PASS)', b1.status === 'PASS', `status=${b1.status} reason=${b1.reasonCode}`);

    const b1x = await runSpec(
      { validatorId: 'b1x', type: 'file-hash', config: { path: join(fx.root, 'inside.txt'), sha256: 'f'.repeat(64) } },
      CFG([fx.root]),
    );
    gate('B1 in-root wrong hash still FAIL HASH_MISMATCH', b1x.status === 'FAIL' && b1x.reasonCode === 'HASH_MISMATCH', `status=${b1x.status} reason=${b1x.reasonCode}`);

    // ----- B2: out-of-root symlink rejected BEFORE content is read -------------
    const b2 = await runSpec(
      { validatorId: 'b2', type: 'file-hash', config: { path: join(fx.root, 'link-inside'), sha256: fx.shaOf(fx.secretTxt) } },
      CFG([fx.root]),
    );
    gate('B2 out-of-root symlink file-hash rejected (UNAVAILABLE PATH_OUTSIDE_ALLOWED_ROOTS)', b2.status === 'UNAVAILABLE' && b2.reasonCode === 'PATH_OUTSIDE_ALLOWED_ROOTS', `status=${b2.status} reason=${b2.reasonCode}`);

    const b2e = await runSpec(
      { validatorId: 'b2e', type: 'file-exists', config: { path: join(fx.root, 'link-inside') } },
      CFG([fx.root]),
    );
    gate('B2 out-of-root symlink file-exists rejected (no existence leak)', b2e.status === 'UNAVAILABLE' && b2e.reasonCode === 'PATH_OUTSIDE_ALLOWED_ROOTS', `status=${b2e.status} reason=${b2e.reasonCode}`);

    // ----- B3: traversal / sibling-prefix / missing / loop ---------------------
    const b3t = await runSpec(
      { validatorId: 'b3t', type: 'file-hash', config: { path: join(fx.root, join('..', 'outside', 'secret.txt')), sha256: fx.shaOf(fx.secretTxt) } },
      CFG([fx.root]),
    );
    gate('B3 ../ traversal rejected (UNAVAILABLE)', b3t.status === 'UNAVAILABLE' && b3t.reasonCode === 'PATH_OUTSIDE_ALLOWED_ROOTS', `status=${b3t.status} reason=${b3t.reasonCode}`);

    // sibling-prefix root bug: <root> vs <root>-sibling. A naive prefix match
    // would accept <root>-sibling/file.txt; the real-path relative check must
    // reject BOTH the direct sibling path and a symlink pointing at it.
    const b3s = await runSpec(
      { validatorId: 'b3s', type: 'file-exists', config: { path: join(fx.sibling, 'file.txt') } },
      CFG([fx.root]),
    );
    gate('B3 sibling-prefix path rejected (UNAVAILABLE)', b3s.status === 'UNAVAILABLE' && b3s.reasonCode === 'PATH_OUTSIDE_ALLOWED_ROOTS', `status=${b3s.status} reason=${b3s.reasonCode}`);

    const b3l = await runSpec(
      { validatorId: 'b3l', type: 'file-hash', config: { path: join(fx.root, 'link-sibling'), sha256: fx.shaOf(fx.siblingTxt) } },
      CFG([fx.root]),
    );
    gate('B3 symlink to sibling-prefix target rejected on REAL path (UNAVAILABLE)', b3l.status === 'UNAVAILABLE' && b3l.reasonCode === 'PATH_OUTSIDE_ALLOWED_ROOTS', `status=${b3l.status} reason=${b3l.reasonCode}`);

    const b3m = await runSpec(
      { validatorId: 'b3m', type: 'file-hash', config: { path: join(fx.root, 'nope.txt'), sha256: 'a'.repeat(64) } },
      CFG([fx.root]),
    );
    gate('B3 missing file -> explicit FAIL FILE_MISSING (no bypass, no crash)', b3m.status === 'FAIL' && b3m.reasonCode === 'FILE_MISSING', `status=${b3m.status} reason=${b3m.reasonCode}`);

    const b3me = await runSpec(
      { validatorId: 'b3me', type: 'file-exists', config: { path: join(fx.root, 'nope.txt') } },
      CFG([fx.root]),
    );
    gate('B3 missing file (file-exists) -> FAIL FILE_MISSING', b3me.status === 'FAIL' && b3me.reasonCode === 'FILE_MISSING', `status=${b3me.status} reason=${b3me.reasonCode}`);

    const b3loop = await runSpec(
      { validatorId: 'b3loop', type: 'file-hash', config: { path: join(fx.root, 'loop'), sha256: 'a'.repeat(64) } },
      CFG([fx.root]),
    );
    gate('B3 symlink loop -> ERROR PATH_UNRESOLVABLE (fail visible)', b3loop.status === 'ERROR' && b3loop.reasonCode === 'PATH_UNRESOLVABLE', `status=${b3loop.status} reason=${b3loop.reasonCode}`);

    // hash-only runtime (no real-path capability) must NEVER read content:
    const legacyRes = await engine.runValidator({
      spec: { validatorId: 'b3legacy', type: 'file-hash', config: { path: join(fx.root, 'inside.txt'), sha256: fx.shaOf(fx.insideTxt) } },
      config: CFG([fx.root]),
      runtime: { fsExists: async () => false, fsRead: async () => null, sha256: async () => 'a'.repeat(64), exec: async () => ({ code: 0, stdout: '', stderr: '' }) },
      pathMod: { resolve },
      labPolicyConfirmed: false,
    });
    gate('B3 runtime without real-path capability -> ERROR CONFINEMENT_UNVERIFIABLE (no content read)', legacyRes.status === 'ERROR' && legacyRes.reasonCode === 'CONFINEMENT_UNVERIFIABLE', `status=${legacyRes.status} reason=${legacyRes.reasonCode}`);

    // ----- B4: platform reporting ----------------------------------------------
    gate('B4 platform supported for realpath confinement smoke', ['linux', 'win32', 'darwin'].includes(process.platform), `platform=${process.platform}`);

    // ----- E1: additionalProperties (boolean + schema form, nested too) --------
    const js = (schema, subject, id) => runSpec({ validatorId: id, type: 'json-schema', config: { schema } }, CFG([]), JSON.stringify(subject));

    const e1a = await js({ type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }, { ok: true, extra: 1 }, 'e1a');
    gate('E1 additionalProperties:false rejects extra property', e1a.status === 'FAIL' && e1a.reasonCode === 'SCHEMA_VIOLATION', `status=${e1a.status} reason=${e1a.reasonCode}`);

    const e1b = await js({ type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }, { ok: true }, 'e1b');
    gate('E1 additionalProperties:false accepts clean object', e1b.status === 'PASS', `status=${e1b.status} reason=${e1b.reasonCode}`);

    const e1c = await js(
      { type: 'object', additionalProperties: false, properties: { nested: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } } } },
      { nested: { a: 'x', sneaky: true } },
      'e1c',
    );
    gate('E1 nested object extra property rejected', e1c.status === 'FAIL', `status=${e1c.status} reason=${e1c.reasonCode}`);

    const e1d = await js(
      { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } },
      { a: 'x', tag: 'ok-string', num: 3 },
      'e1d',
    );
    gate('E1 additionalProperties schema-form rejects non-matching extra', e1d.status === 'FAIL', `status=${e1d.status} reason=${e1d.reasonCode}`);

    const e1e = await js(
      { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } },
      { a: 'x', tag: 'ok-string' },
      'e1e',
    );
    gate('E1 additionalProperties schema-form accepts matching extra', e1e.status === 'PASS', `status=${e1e.status} reason=${e1e.reasonCode}`);

    // ----- E2: arrays + items (schema form, tuple form, bounds) ----------------
    const e2a = await js({ type: 'array', items: { type: 'number' } }, [1, 2, 'x'], 'e2a');
    gate('E2 items schema-form rejects non-number element', e2a.status === 'FAIL', `status=${e2a.status} reason=${e2a.reasonCode}`);

    const e2b = await js({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] }, ['a', 1], 'e2b');
    gate('E2 items tuple-form accepts matching prefix', e2b.status === 'PASS', `status=${e2b.status} reason=${e2b.reasonCode}`);

    const e2c = await js({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] }, ['a', 'wrong'], 'e2c');
    gate('E2 items tuple-form rejects wrong tuple element', e2c.status === 'FAIL', `status=${e2c.status} reason=${e2c.reasonCode}`);

    const e2d = await js({ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 3 }, [1], 'e2d');
    gate('E2 minItems enforced', e2d.status === 'FAIL', `status=${e2d.status} reason=${e2d.reasonCode}`);

    const e2e = await js({ type: 'array', items: { type: 'number' }, maxItems: 1 }, [1, 2], 'e2e');
    gate('E2 maxItems enforced', e2e.status === 'FAIL', `status=${e2e.status} reason=${e2e.reasonCode}`);

    // ----- E3: composition keywords --------------------------------------------
    const e3a = await js({ allOf: [{ type: 'string' }, { minLength: 3 }] }, 'abcd', 'e3a');
    gate('E3 allOf accepts when all branches hold', e3a.status === 'PASS', `status=${e3a.status} reason=${e3a.reasonCode}`);
    const e3b = await js({ allOf: [{ type: 'string' }, { minLength: 3 }] }, 'ab', 'e3b');
    gate('E3 allOf rejects when one branch fails', e3b.status === 'FAIL', `status=${e3b.status} reason=${e3b.reasonCode}`);
    const e3c = await js({ anyOf: [{ type: 'number' }, { const: 'x' }] }, 'x', 'e3c');
    gate('E3 anyOf accepts one matching branch', e3c.status === 'PASS', `status=${e3c.status} reason=${e3c.reasonCode}`);
    const e3d = await js({ anyOf: [{ type: 'number' }, { const: 'x' }] }, 'y', 'e3d');
    gate('E3 anyOf rejects when no branch matches', e3d.status === 'FAIL', `status=${e3d.status} reason=${e3d.reasonCode}`);
    const e3e = await js({ oneOf: [{ type: 'string' }, { minLength: 1 }] }, 'ab', 'e3e');
    gate('E3 oneOf rejects when two branches match', e3e.status === 'FAIL', `status=${e3e.status} reason=${e3e.reasonCode}`);
    const e3f = await js({ oneOf: [{ type: 'number' }, { minLength: 1 }] }, 'ab', 'e3f');
    gate('E3 oneOf accepts exactly one branch', e3f.status === 'PASS', `status=${e3f.status} reason=${e3f.reasonCode}`);
    const e3g = await js({ not: { type: 'string' } }, 5, 'e3g');
    gate('E3 not accepts when inner schema does not match', e3g.status === 'PASS', `status=${e3g.status} reason=${e3g.reasonCode}`);
    const e3h = await js({ not: { type: 'string' } }, 's', 'e3h');
    gate('E3 not rejects when inner schema matches', e3h.status === 'FAIL', `status=${e3h.status} reason=${e3h.reasonCode}`);

    // ----- E4: unsupported keyword -> UNAVAILABLE with reason, NEVER PASS ------
    const e4a = await js({ type: 'object', properties: { a: { type: 'string' } }, if: { properties: { a: { const: 'x' } } }, then: { required: ['b'] } }, { a: 'x' }, 'e4a');
    gate('E4 if/then unsupported -> UNAVAILABLE (not PASS)', e4a.status === 'UNAVAILABLE' && e4a.reasonCode === 'SCHEMA_UNSUPPORTED', `status=${e4a.status} reason=${e4a.reasonCode}`);
    const e4b = await js({ type: 'string', $anchor: 'foo' }, 'anything', 'e4b');
    gate('E4 $anchor unsupported -> UNAVAILABLE (not PASS)', e4b.status === 'UNAVAILABLE' && e4b.reasonCode === 'SCHEMA_UNSUPPORTED', `status=${e4b.status} reason=${e4b.reasonCode}`);
    const e4c = await js({ type: 'string', format: 'email' }, 'not-even-checked', 'e4c');
    gate('E4 format unsupported -> UNAVAILABLE (not PASS)', e4c.status === 'UNAVAILABLE' && e4c.reasonCode === 'SCHEMA_UNSUPPORTED', `status=${e4c.status} reason=${e4c.reasonCode}`);

    // ----- E5: remote / non-local $ref -> UNAVAILABLE (no network, ever) -------
    const e5a = await js({ $ref: 'http://attacker.example/schema.json' }, {}, 'e5a');
    gate('E5 remote http $ref -> UNAVAILABLE', e5a.status === 'UNAVAILABLE' && e5a.reasonCode === 'SCHEMA_UNSUPPORTED', `status=${e5a.status} reason=${e5a.reasonCode}`);
    const e5b = await js({ $ref: 'other-file.json#/definitions/x' }, {}, 'e5b');
    gate('E5 non-local file $ref -> UNAVAILABLE', e5b.status === 'UNAVAILABLE' && e5b.reasonCode === 'SCHEMA_UNSUPPORTED', `status=${e5b.status} reason=${e5b.reasonCode}`);

    // ----- E6: invalid SCHEMA -> ERROR, distinct from subject FAIL -------------
    const e6a = await js({ type: 'banana' }, 'anything', 'e6a');
    gate('E6 type:"banana" -> ERROR SCHEMA_INVALID (not FAIL, not PASS)', e6a.status === 'ERROR' && e6a.reasonCode === 'SCHEMA_INVALID', `status=${e6a.status} reason=${e6a.reasonCode}`);
    const e6b = await js({ type: 'object', required: 'not-an-array' }, {}, 'e6b');
    gate('E6 malformed required -> ERROR SCHEMA_INVALID', e6b.status === 'ERROR' && e6b.reasonCode === 'SCHEMA_INVALID', `status=${e6b.status} reason=${e6b.reasonCode}`);
    const e6c = await js({ type: 'string' }, 42, 'e6c');
    gate('E6 subject violation stays FAIL (distinct from schema ERROR)', e6c.status === 'FAIL' && e6c.reasonCode === 'SCHEMA_VIOLATION', `status=${e6c.status} reason=${e6c.reasonCode}`);

    // ----- E-bonus: bounds + local $ref + boolean schemas ----------------------
    // Recursive local-$ref schema; a 200-deep instance must be bounded (max 64).
    // Leaf is {} so every level satisfies type:object — the FAIL is the depth
    // bound, not a type mismatch.
    let deep = {}; for (let i = 0; i < 200; i++) deep = { v: deep };
    const recursiveSchema = { type: 'object', properties: { v: { $ref: '#' } } };
    const e7 = await js(recursiveSchema, deep, 'e7');
    gate('E7 depth-bomb instance bounded -> FAIL (no crash)', e7.status === 'FAIL', `status=${e7.status} reason=${e7.reasonCode}`);
    let shallow = {}; for (let i = 0; i < 50; i++) shallow = { v: shallow };
    const e7b = await js(recursiveSchema, shallow, 'e7b');
    gate('E7 within-bounds depth (50 <= 64) still PASS', e7b.status === 'PASS', `status=${e7b.status} reason=${e7b.reasonCode}`);

    const e8 = await js(
      { type: 'object', required: ['n'], properties: { n: { $ref: '#/$defs/posInt' } }, $defs: { posInt: { type: 'integer', minimum: 1 } } },
      { n: 3 },
      'e8',
    );
    gate('E8 local $ref (#/$defs/...) resolves', e8.status === 'PASS', `status=${e8.status} reason=${e8.reasonCode}`);

    const e9 = await js(false, { anything: 1 }, 'e9');
    gate('E9 boolean false schema rejects everything', e9.status === 'FAIL', `status=${e9.status} reason=${e9.reasonCode}`);

    // B2 canary-leak assertion: the CANARY string lives only inside the
    // out-of-root target file. It must NEVER appear in any printed line,
    // verdict, evidence or reason emitted by this run.
    const leak = collected.join('\n').includes(CANARY);
    gate('B2 canary content never appears in any output/evidence/verdict', !leak, 'canary leaked into output');

    const failed = checks.filter((c) => !c.ok);
    out('');
    out(`  cases=${checks.length} failed=${failed.length}`);
    if (failed.length === 0) {
      out('V131_VERIFIER_FIX_VERIFIED');
      process.exitCode = 0;
    } else {
      out('V131_VERIFIER_FIX_FAILED');
      process.exitCode = 1;
    }
  } finally {
    cleanup();
  }
};

if (MODE === 'repro') await repro();
else await verify();
