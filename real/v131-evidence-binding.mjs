#!/usr/bin/env bun
/**
 * dsh-supreme/real/v131-evidence-binding.mjs — v1.3.1 IMP-V proof for
 * Improvement §3A "Evidence-bound verification" (supreme-verifier) and the
 * close-gate tie-in (supreme-workflow-policy requireVerifierPassOnClose).
 *
 * What it proves, on the REAL code (no simulation):
 *   (a) a PASS is recorded BOUND to identity — taskId, attempt and the
 *       sha-256 of the exact artifact bytes verified — and when the artifact
 *       changes, isEvidenceCurrent(evidence, current) turns FALSE and the
 *       workflow close gate BLOCKS (stale PASS = no-PASS);
 *   (b) a HIGH-risk task without current evidence cannot close (clear reason
 *       code), and closes only with a bound PASS covering the CURRENT artifact;
 *   (c) an unavailable verifier yields an explicit UNAVAILABLE evidence
 *       record (and an injected runtime failure an explicit ERROR), the close
 *       is blocked, and NO PASS is fabricated anywhere;
 *   (d) model confidence and reasoning-trace presence/length can NEVER
 *       produce a PASS — the deterministic validators FAIL such subjects and
 *       recordEvidence structurally REFUSES confidence/trace inputs;
 *   (e) audit events are value-free: canary artifact content, hidden-CoT
 *       canaries and secret sentinels never appear in any emitted event.
 *
 * Exercises the REAL engines (src/plugins/.../engine.ts imported directly by
 * bun) AND the REAL Cordis adapters mounted on the REAL pinned cordis
 * (@deepseek-ai/cordis): the REAL supreme-verifier adapter (with real fs
 * runtime: realpath/stat/open-fstat/hashBytes) and the REAL
 * supreme-workflow-policy adapter, wired together the way a host wires them:
 * verifier.hashArtifact → verifier.runAndRecord → workflow.canCloseTask.
 *
 * FIX-BE hardening (realpath confinement + bounded JSON-schema validator)
 * is exercised in the SAME engine and must stay intact ([F] regression).
 *
 * Deterministic only: no ML, no network, no upstream modification, no new
 * dependencies. Fixtures are synthetic (temp dir under os.tmpdir()); printed
 * evidence carries ids/hashes/labels only — artifact CONTENT (canaries) must
 * never appear in any output. Exit 0 only when ALL probes pass; the final
 * line is the exact marker V131_EVIDENCE_BINDING_VERIFIED.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url);
const verifierEngineHref = new URL('src/plugins/supreme-verifier/engine.ts', ROOT).href;
const verifierAdapterHref = new URL('src/plugins/supreme-verifier/index.ts', ROOT).href;
const workflowEngineHref = new URL('src/plugins/supreme-workflow-policy/engine.ts', ROOT).href;
const workflowAdapterHref = new URL('src/plugins/supreme-workflow-policy/index.ts', ROOT).href;

// REAL pinned cordis (node_modules dependency), with the pinned-vendor fallback.
let Context;
try {
  ({ Context } = await import('@deepseek-ai/cordis'));
} catch {
  const candidates = [
    new URL('../node_modules/.upstream/deepseek-harness/vendor/cordis/src/index.ts', ROOT),
    new URL('../../node_modules/.upstream/deepseek-harness/vendor/cordis/src/index.ts', ROOT),
  ];
  let loaded = null;
  for (const url of candidates) {
    try { loaded = await import(url.href); break; } catch { /* try next */ }
  }
  if (!loaded || typeof loaded.Context !== 'function') {
    throw new Error('pinned cordis unavailable: install @deepseek-ai/cordis or check out deepseek-harness');
  }
  ({ Context } = loaded);
}

const vEngine = await import(verifierEngineHref);
const wEngine = await import(workflowEngineHref);

const checks = [];
const probe = (name, ok, detail = '') => {
  checks.push({ name, ok: ok === true, detail });
  console.log(`  ${ok === true ? 'PASS' : 'FAIL'}  ${name}${ok === true ? '' : `  << ${detail}`}`);
};
const jsonOf = (value) => JSON.stringify(value);
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Canaries: content that must NEVER leak into any evidence record or event.
const ARTIFACT_CANARY = 'EVIDENCE_ARTIFACT_CONTENT_CANARY_42';
const HIDDEN_COT_CANARY = 'HIDDEN_COT_CANARY_never_evidence_42';
const SECRET_SENTINEL = 'SECRET_SENTINEL_CANARY_9f2c';

// ---------------------------------------------------------------------------
// Fixture (synthetic, under os.tmpdir()):
//   <tmp>/root/artifact.txt        the artifact under verification (in root)
//   <tmp>/root/link-outside        symlink -> <tmp>/outside/secret.txt (FIX-BE)
//   <tmp>/outside/secret.txt       CANARY content, OUTSIDE any allowed root
// ---------------------------------------------------------------------------
const buildFixture = () => {
  const base = mkdtempSync(join(tmpdir(), 'v131-evidence-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  const artifactPath = join(root, 'artifact.txt');
  const secretTxt = join(outside, 'secret.txt');
  writeFileSync(artifactPath, `${ARTIFACT_CANARY}\nrevision one\n`);
  writeFileSync(secretTxt, `${ARTIFACT_CANARY}\n${SECRET_SENTINEL}\n`);
  symlinkSync(secretTxt, join(root, 'link-outside'));
  const hashOf = (p) => sha256Hex(readFileSync(p));
  return { base, root, outside, artifactPath, secretTxt, hashOf };
};

let CLEANUP = null;
const cleanup = () => { if (CLEANUP) { try { rmSync(CLEANUP, { recursive: true, force: true }); } catch { /* best effort */ } } };

// Real fs runtime mirroring the production adapter contract (v1.3.1 members).
const makeRuntime = () => {
  const fsmod = process.getBuiltinModule('node:fs');
  return {
    fsExists: async (p) => fsmod.existsSync(p),
    fsRead: async (p) => { try { return await fsmod.promises.readFile(p, 'utf8'); } catch { return null; } },
    sha256: async (p) => { try { return sha256Hex(await fsmod.promises.readFile(p)); } catch { return null; } },
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
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
        const st = await fh.stat();
        const bytes = await fh.readFile();
        return { bytes, dev: st.dev, ino: st.ino, size: st.size };
      } catch { return null; }
      finally { try { await fh?.close(); } catch { /* already closed */ } }
    },
    hashBytes: async (bytes) => sha256Hex(bytes),
  };
};

const pathMod = { resolve, relative, isAbsolute };
const CFG = (roots) => ({
  allowCommands: false,
  allowNetwork: false,
  allowedRoots: roots.map((r) => resolve(r)),
  commandTimeoutMs: 1000,
});

// ---------------------------------------------------------------------------
// Harness: mount the REAL supreme-verifier adapter AND the REAL
// supreme-workflow-policy adapter on the REAL pinned cordis, wired like a
// host: the workflow close gate consumes the verifier's evidence records and
// artifact hashes. A stub supremeObservability captures every audit event;
// the other injected slots are unused stubs.
// ---------------------------------------------------------------------------
const mkHost = async ({ verifierConfig, workflowConfig }) => {
  const events = [];
  const root = new Context();
  root.provide('supremePolicy', {});
  root.provide('subagents', {});
  root.provide('workflowEngine', {});
  root.provide('supremeObservability', {
    record(event, fields) { events.push({ event, fields }); },
  });
  const vmod = await import(verifierAdapterHref);
  const wmod = await import(workflowAdapterHref);
  if (vmod.name !== 'supreme-verifier' || wmod.name !== 'supreme-workflow-policy') {
    throw new Error('adapter module shape unexpected');
  }
  await root.plugin(vmod, verifierConfig); // cordis resolves the REAL zod Config BEFORE apply
  await root.plugin(wmod, workflowConfig);
  const verifier = root.get('supremeVerifier');
  const workflow = root.get('supremeWorkflowPolicy');
  if (!verifier || typeof verifier.runAndRecord !== 'function' || !workflow || typeof workflow.canCloseTask !== 'function') {
    throw new Error('services missing after mount');
  }
  const eventsNamed = (name) => events.filter((e) => e.event === name);
  const dispose = () => root.fiber.dispose();
  return { root, verifier, workflow, events, eventsNamed, dispose };
};

const engineThrows = async (fn) => {
  try { await fn(); return null; } catch (err) { return err; }
};

console.log('== v1.3.1 evidence-bound verification — REAL engines + REAL pinned-cordis adapters ==');

// ---------------------------------------------------------------------------
// [0] Surface — engine exports the §3A contract.
// ---------------------------------------------------------------------------
console.log('[0] evidence-binding surface (both engines)');
probe('EVIDENCE_SCHEMA_VERSION exported', vEngine.EVIDENCE_SCHEMA_VERSION === 'dsh-supreme/evidence@1', String(vEngine.EVIDENCE_SCHEMA_VERSION));
probe('EVIDENCE_HASH_ALGORITHM is sha256', vEngine.EVIDENCE_HASH_ALGORITHM === 'sha256', String(vEngine.EVIDENCE_HASH_ALGORITHM));
probe('recordEvidence / isEvidenceCurrent / evaluateEvidenceForClose exported',
  typeof vEngine.recordEvidence === 'function' && typeof vEngine.isEvidenceCurrent === 'function' && typeof vEngine.evaluateEvidenceForClose === 'function');
probe('EvidenceError exported', typeof vEngine.EvidenceError === 'function');
probe('FORBIDDEN_EVIDENCE_FIELDS bans confidence + reasoning traces',
  ['confidence', 'modelConfidence', 'reasoningTrace', 'chainOfThought', 'trace'].every((f) => vEngine.FORBIDDEN_EVIDENCE_FIELDS.includes(f)),
  jsonOf(vEngine.FORBIDDEN_EVIDENCE_FIELDS));
probe('workflow engine exports CLOSE_GATE_EVENT', wEngine.CLOSE_GATE_EVENT === 'close_gate', String(wEngine.CLOSE_GATE_EVENT));
probe('workflow engine exports the evidence mirror + validator',
  typeof wEngine.validateCloseEvidenceRecord === 'function' && typeof wEngine.canCloseTask === 'function');

// ---------------------------------------------------------------------------
// [A1] Engine level — a PASS is recorded BOUND to identity; artifact change
// ⇒ stale (isEvidenceCurrent false).
// ---------------------------------------------------------------------------
console.log('[A1] engine: PASS bound to taskId/attempt/artifact-hash + staleness');
{
  const fx = buildFixture();
  CLEANUP = fx.base;
  try {
    const H1 = fx.hashOf(fx.artifactPath);
    const pass = await vEngine.runValidator({
      spec: { validatorId: 'artifact-intact', type: 'file-hash', config: { path: fx.artifactPath, sha256: H1 } },
      config: CFG([fx.root]),
      runtime: makeRuntime(),
      pathMod,
      labPolicyConfirmed: false,
    });
    probe('A1: deterministic file-hash PASS on the real bytes', pass.status === 'PASS', jsonOf(pass));

    const evidence = await vEngine.recordEvidence({
      result: pass,
      taskId: 'task-evidence-1',
      attempt: 3,
      artifact: { path: fx.artifactPath, sha256: H1, revision: 'rev-1' },
      recordedAt: 1_700_000_000_000,
    });
    probe('A1: record carries verbatim PASS status', evidence.status === 'PASS' && evidence.reasonCode === 'OK', jsonOf(evidence));
    probe('A1: record bound to taskId + attempt', evidence.taskId === 'task-evidence-1' && evidence.attempt === 3, jsonOf(evidence));
    probe('A1: record carries the sha-256 of the verified bytes', evidence.artifact.sha256 === H1 && /^[0-9a-f]{64}$/.test(evidence.artifact.sha256), String(evidence.artifact.sha256));
    probe('A1: record carries revision + schemaVersion + validator identity',
      evidence.artifact.revision === 'rev-1' && evidence.schemaVersion === 'dsh-supreme/evidence@1' && evidence.validatorId === 'artifact-intact' && evidence.validatorType === 'file-hash', jsonOf(evidence));
    probe('A1: record is frozen (immutable)', Object.isFrozen(evidence) && Object.isFrozen(evidence.artifact));

    // Hash computed from RAW BYTES via the runtime hash member (deterministic).
    const bytes = new TextEncoder().encode('bytes-built evidence');
    const evBytes = await vEngine.recordEvidence({
      result: pass,
      taskId: 'task-bytes',
      attempt: 1,
      artifact: { bytes },
      hashBytes: makeRuntime().hashBytes,
    });
    probe('A1: hash computed deterministically from artifact bytes', evBytes.artifact.sha256 === sha256Hex(bytes), String(evBytes.artifact.sha256));

    probe('A1: isEvidenceCurrent TRUE against the same artifact', vEngine.isEvidenceCurrent(evidence, { sha256: H1 }) === true);
    probe('A1: evaluateEvidenceForClose verdict EVIDENCE_CURRENT_PASS',
      vEngine.evaluateEvidenceForClose(evidence, { sha256: H1, revision: 'rev-1' }).reasonCode === 'EVIDENCE_CURRENT_PASS');

    // THE STALENESS RULE: the artifact changes ⇒ the PASS is stale.
    writeFileSync(fx.artifactPath, `${ARTIFACT_CANARY}\nrevision two — artifact CHANGED\n`);
    const H2 = fx.hashOf(fx.artifactPath);
    probe('A1: artifact really changed (H2 != H1)', H2 !== H1);
    probe('A1: isEvidenceCurrent FALSE after the artifact changed (stale)', vEngine.isEvidenceCurrent(evidence, { sha256: H2 }) === false);
    probe('A1: stale verdict is EVIDENCE_STALE', vEngine.evaluateEvidenceForClose(evidence, { sha256: H2 }).reasonCode === 'EVIDENCE_STALE');
    probe('A1: revision bump alone counts as stale', vEngine.isEvidenceCurrent(evidence, { sha256: H1, revision: 'rev-2' }) === false);
    probe('A1: unbound/malformed record is never current', vEngine.isEvidenceCurrent({ taskId: 'x', status: 'PASS' }, { sha256: H1 }) === false
      && vEngine.evaluateEvidenceForClose({ taskId: 'x', status: 'PASS' }, { sha256: H1 }).reasonCode === 'EVIDENCE_UNBOUND');
    probe('A1: a PASS without the artifact hash is NOT recordable (EvidenceError)',
      (await engineThrows(() => vEngine.recordEvidence({ result: pass, taskId: 't', attempt: 1, artifact: { path: fx.artifactPath } }))) instanceof vEngine.EvidenceError);
  } finally {
    cleanup();
    CLEANUP = null;
  }
}

// ---------------------------------------------------------------------------
// [A2/B] Adapter level — REAL pinned-cordis mount of BOTH plugins wired like
// a host: (a) PASS recorded with the artifact hash; artifact changes ⇒
// isEvidenceCurrent false and the close gate BLOCKS. (b) HIGH-risk close
// matrix: without current evidence blocked with a clear reason; with current
// evidence allowed.
// ---------------------------------------------------------------------------
console.log('[A2] adapters: PASS recorded with artifact hash; change ⇒ stale + close blocked');
console.log('[B]  close gate: HIGH risk needs current evidence (clear reasons)');
{
  const fx = buildFixture();
  CLEANUP = fx.base;
  try {
    const H1 = fx.hashOf(fx.artifactPath);
    const host = await mkHost({
      verifierConfig: CFG([fx.root]),
      workflowConfig: { requireVerifierPassOnClose: true },
    });
    const { verifier, workflow } = host;

    probe('A2: hashArtifact hashes the CURRENT bytes (node crypto sha-256)',
      (await verifier.hashArtifact(fx.artifactPath)).sha256 === H1, String((await verifier.hashArtifact(fx.artifactPath)).sha256));
    probe('A2: hashArtifact refuses paths outside allowedRoots (fail-closed null)',
      (await verifier.hashArtifact(fx.secretTxt)).sha256 === null);

    verifier.register({ validatorId: 'artifact-intact', type: 'file-hash', config: { path: fx.artifactPath, sha256: H1 } });
    const evidenceA = await verifier.runAndRecord('artifact-intact', {
      taskId: 'task-evidence-A',
      attempt: 1,
      artifact: { path: fx.artifactPath, revision: 'rev-1' }, // no sha256 ⇒ hashed from current bytes at record time
    });
    probe('A2: runAndRecord returns a PASS bound to the artifact hash',
      evidenceA.status === 'PASS' && evidenceA.artifact.sha256 === H1 && evidenceA.taskId === 'task-evidence-A' && evidenceA.attempt === 1, jsonOf(evidenceA));
    probe('A2: isEvidenceCurrent true while the artifact is unchanged',
      vEngine.isEvidenceCurrent(evidenceA, { sha256: await (verifier.hashArtifact(fx.artifactPath)).then((r) => r.sha256) }) === true);

    // THE ATTACK: artifact changes after the PASS was recorded.
    writeFileSync(fx.artifactPath, `${ARTIFACT_CANARY}\nrevision two — artifact CHANGED\n`);
    const H2 = fx.hashOf(fx.artifactPath);
    const current = (await verifier.hashArtifact(fx.artifactPath)).sha256;
    probe('A2: current hash reflects the changed bytes', current === H2 && current !== H1);
    probe('A2: isEvidenceCurrent(evidence, CURRENT) is FALSE (stale)',
      vEngine.isEvidenceCurrent(evidenceA, { sha256: current }) === false);
    const staleClose = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'PASS', evidence: evidenceA, artifact: { sha256: current } });
    probe('A2: close gate BLOCKS the stale PASS (stale PASS = no-PASS)',
      staleClose.closable === false && staleClose.reasonCode === 'EVIDENCE_STALE', jsonOf(staleClose));
    const staleCloseEngine = wEngine.canCloseTask({ requireVerifierPassOnClose: true }, { risk: 'HIGH', verifierStatus: 'PASS', evidence: evidenceA, artifact: { sha256: current } });
    probe('A2: engine mirror agrees with the adapter verdict', staleCloseEngine.reasonCode === staleClose.reasonCode && staleCloseEngine.closable === staleClose.closable);

    console.log('[B]  HIGH-risk close matrix on the mounted adapter');
    const noEvidence = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'MISSING' });
    probe('B: HIGH risk without any evidence is blocked with a clear reason',
      noEvidence.closable === false && noEvidence.reasonCode === 'VERIFIER_MISSING_BLOCKS_CLOSE', jsonOf(noEvidence));
    const artifactNoEvidence = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'PASS', artifact: { sha256: current } });
    probe('B: artifact tracked but NO bound evidence ⇒ blocked (EVIDENCE_CURRENCY_UNVERIFIED)',
      artifactNoEvidence.closable === false && artifactNoEvidence.reasonCode === 'EVIDENCE_CURRENCY_UNVERIFIED', jsonOf(artifactNoEvidence));
    const evidenceNoArtifact = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'PASS', evidence: evidenceA });
    probe('B: PASS evidence with no current-artifact identity ⇒ blocked (currency unknowable)',
      evidenceNoArtifact.closable === false && evidenceNoArtifact.reasonCode === 'EVIDENCE_CURRENCY_UNVERIFIED', jsonOf(evidenceNoArtifact));
    const garbageEvidence = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'PASS', evidence: { status: 'PASS', taskId: 'fake' }, artifact: { sha256: current } });
    probe('B: unbound/fabricated evidence record ⇒ blocked (EVIDENCE_UNBOUND)',
      garbageEvidence.closable === false && garbageEvidence.reasonCode === 'EVIDENCE_UNBOUND', jsonOf(garbageEvidence));

    // WITH current evidence: re-verify the CHANGED artifact and close.
    verifier.register({ validatorId: 'artifact-intact-v2', type: 'file-hash', config: { path: fx.artifactPath, sha256: H2 } });
    const evidenceB = await verifier.runAndRecord('artifact-intact-v2', {
      taskId: 'task-evidence-A',
      attempt: 2,
      artifact: { path: fx.artifactPath, sha256: H2, revision: 'rev-2' },
    });
    const currentClose = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'PASS', evidence: evidenceB, artifact: { sha256: current, revision: 'rev-2' } });
    probe('B: HIGH risk closes WITH a bound PASS covering the CURRENT artifact',
      currentClose.closable === true && currentClose.reasonCode === 'EVIDENCE_CURRENT_PASS', jsonOf(currentClose));
    const revisionConflict = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'PASS', evidence: evidenceB, artifact: { sha256: current, revision: 'rev-3' } });
    probe('B: revision/etag mismatch blocks even when the hash matches',
      revisionConflict.closable === false && revisionConflict.reasonCode === 'EVIDENCE_STALE', jsonOf(revisionConflict));
    const currentCloseEngine = wEngine.canCloseTask({ requireVerifierPassOnClose: true }, { risk: 'HIGH', verifierStatus: 'PASS', evidence: evidenceB, artifact: { sha256: current } });
    probe('B: engine mirror agrees on the allowed verdict too', currentCloseEngine.closable === true && currentCloseEngine.reasonCode === 'EVIDENCE_CURRENT_PASS');

    const lowRisk = workflow.canCloseTask({ risk: 'LOW', verifierStatus: 'MISSING' });
    const mediumRisk = workflow.canCloseTask({ risk: 'MEDIUM', verifierStatus: 'MISSING' });
    probe('B: LOW/MEDIUM risk close unrestricted (risk machinery unchanged)',
      lowRisk.closable === true && lowRisk.reasonCode === 'CLOSE_UNRESTRICTED' && mediumRisk.closable === true, jsonOf(lowRisk));

    // v1.2 back-compat surface (suite contract) still holds on the adapter.
    const v12Pass = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'PASS' });
    probe('B: v1.2 status-only PASS path unchanged (documented back-compat)',
      v12Pass.closable === true && v12Pass.reasonCode === 'VERIFIER_PASS_RECORDED', jsonOf(v12Pass));

    // close_gate audit: one event per HIGH verdict under the ACTIVE gate,
    // ids + hash prefixes + reason codes only.
    const gateEvents = host.eventsNamed('close_gate');
    probe('B: close_gate audit emitted for the HIGH verdicts', gateEvents.length >= 6, String(gateEvents.length));
    probe('B: close_gate events carry ids/hash-prefix/reason ONLY (value-free shape)',
      gateEvents.every((e) => {
        const keys = Object.keys(e.fields);
        const detail = String(e.fields.detail ?? '');
        return keys.every((k) => ['task', 'artifact', 'detail'].includes(k))
          && /^risk:(LOW|MEDIUM|HIGH):outcome:(ALLOWED|BLOCKED):reason:[A-Z0-9_]+$/.test(detail)
          && (e.fields.artifact === undefined || /^[0-9a-f]{12}$/.test(String(e.fields.artifact)));
      }),
      jsonOf(gateEvents));
    probe('B: close_gate outcome matches the decision (BLOCKED for stale, ALLOWED for current)',
      gateEvents.some((e) => String(e.fields.detail).includes('outcome:BLOCKED:reason:EVIDENCE_STALE'))
      && gateEvents.some((e) => String(e.fields.detail).includes('outcome:ALLOWED:reason:EVIDENCE_CURRENT_PASS')),
      jsonOf(gateEvents));

    // Gate disabled ⇒ unrestricted (v1.2 semantics preserved end to end).
    const offHost = await mkHost({
      verifierConfig: CFG([fx.root]),
      workflowConfig: { requireVerifierPassOnClose: false },
    });
    probe('B: gate disabled ⇒ close unrestricted even with stale evidence',
      offHost.workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'PASS', evidence: evidenceA, artifact: { sha256: current } }).closable === true);
    probe('B: gate disabled ⇒ NO close_gate audit (gate not active)',
      offHost.eventsNamed('close_gate').length === 0, jsonOf(offHost.eventsNamed('close_gate')));
    await offHost.dispose();
    await host.dispose();
  } finally {
    cleanup();
    CLEANUP = null;
  }
}

// ---------------------------------------------------------------------------
// [C] Verifier unavailable ⇒ explicit UNAVAILABLE record, close blocked, and
// NO PASS fabricated. Injected failures: unknown validator, dual-gated
// command execution (capability gap), and a throwing runtime (ERROR).
// ---------------------------------------------------------------------------
console.log('[C] verifier unavailable ⇒ UNAVAILABLE record, close blocked, no PASS fabricated');
{
  const fx = buildFixture();
  CLEANUP = fx.base;
  try {
    const H1 = fx.hashOf(fx.artifactPath);
    const host = await mkHost({
      verifierConfig: CFG([fx.root]),
      workflowConfig: { requireVerifierPassOnClose: true },
    });
    const { verifier, workflow } = host;

    const unavailable = await verifier.runAndRecord('no-such-validator', {
      taskId: 'task-unavailable',
      attempt: 1,
      artifact: { path: fx.artifactPath, sha256: H1 },
    });
    probe('C: unknown validator ⇒ explicit UNAVAILABLE record (VALIDATOR_NOT_FOUND)',
      unavailable.status === 'UNAVAILABLE' && unavailable.reasonCode === 'VALIDATOR_NOT_FOUND', jsonOf(unavailable));
    const c1 = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: unavailable.status, evidence: unavailable, artifact: { sha256: H1 } });
    probe('C: UNAVAILABLE record blocks the HIGH-risk close',
      c1.closable === false && c1.reasonCode === 'VERIFIER_UNAVAILABLE_BLOCKS_CLOSE', jsonOf(c1));

    // Capability gap (deterministic): command validators are dual-gated — no
    // LAB policy ⇒ UNAVAILABLE, never a fabricated PASS.
    const noLab = await vEngine.runValidator({
      spec: { validatorId: 'cmd', type: 'command-exit', config: { command: 'true' } },
      config: CFG([fx.root]),
      runtime: makeRuntime(),
      pathMod,
      labPolicyConfirmed: false,
    });
    const evNoLab = await vEngine.recordEvidence({ result: noLab, taskId: 'task-unavailable', attempt: 2, artifact: { sha256: H1 } });
    probe('C: dual-gated command validator ⇒ UNAVAILABLE record (COMMAND_EXECUTION_DISABLED)',
      evNoLab.status === 'UNAVAILABLE' && evNoLab.reasonCode === 'COMMAND_EXECUTION_DISABLED', jsonOf(evNoLab));
    const c2 = wEngine.canCloseTask({ requireVerifierPassOnClose: true }, { risk: 'HIGH', verifierStatus: evNoLab.status, evidence: evNoLab, artifact: { sha256: H1 } });
    probe('C: engine close gate blocks the UNAVAILABLE record too', c2.closable === false && c2.reasonCode === 'VERIFIER_UNAVAILABLE_BLOCKS_CLOSE', jsonOf(c2));

    // Injected runtime failure (stat throws) ⇒ ERROR (fail visible), not PASS.
    const brokenRuntime = makeRuntime();
    brokenRuntime.stat = async () => { throw new Error('injected fs failure'); };
    const errored = await vEngine.runValidator({
      spec: { validatorId: 'artifact-intact', type: 'file-hash', config: { path: fx.artifactPath, sha256: H1 } },
      config: CFG([fx.root]),
      runtime: brokenRuntime,
      pathMod,
      labPolicyConfirmed: false,
    });
    const evError = await vEngine.recordEvidence({ result: errored, taskId: 'task-unavailable', attempt: 3, artifact: { sha256: H1 } });
    probe('C: injected runtime failure ⇒ ERROR record (fail visible, never PASS)',
      errored.status === 'ERROR' && errored.reasonCode === 'VALIDATOR_EXCEPTION' && evError.status === 'ERROR', jsonOf(evError));
    const c3 = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: evError.status, evidence: evError, artifact: { sha256: H1 } });
    probe('C: ERROR record blocks the close as well', c3.closable === false && c3.reasonCode === 'VERIFIER_ERROR_BLOCKS_CLOSE', jsonOf(c3));

    // NO PASS was fabricated for the unavailable task: every record kept for
    // it is non-PASS, and the verifier service holds no magic PASS path.
    const recorded = [unavailable, evNoLab, evError];
    probe('C: NO PASS fabricated — all records for the unavailable task are non-PASS',
      recorded.every((e) => e.status !== 'PASS' && vEngine.isEvidenceCurrent(e, { sha256: H1 }) === false), jsonOf(recorded.map((e) => e.status)));
    probe('C: fabricated PASS cannot be smuggled past the close gate (status conflict)',
      workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'PASS', evidence: unavailable, artifact: { sha256: H1 } })
        .reasonCode === 'EVIDENCE_STATUS_CONFLICT', 'conflict check');
    await host.dispose();
  } finally {
    cleanup();
    CLEANUP = null;
  }
}

// ---------------------------------------------------------------------------
// [D] Confidence / long-trace can NEVER produce PASS.
// ---------------------------------------------------------------------------
console.log('[D] confidence/long-trace can never produce PASS');
{
  const fx = buildFixture();
  CLEANUP = fx.base;
  try {
    const H1 = fx.hashOf(fx.artifactPath);
    const host = await mkHost({
      verifierConfig: CFG([fx.root]),
      workflowConfig: { requireVerifierPassOnClose: true },
    });
    const { verifier, workflow } = host;

    // The acceptance check demands EVIDENCE fields, never self-reports.
    verifier.register({
      validatorId: 'artifact-acceptance',
      type: 'json-schema',
      config: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['artifactSha256', 'testsPassed'],
          properties: {
            artifactSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            testsPassed: { type: 'boolean' },
          },
        },
      },
    });
    const selfReport = JSON.stringify({
      confidence: 0.99,
      modelConfidence: 0.99,
      reasoningTrace: `${HIDDEN_COT_CANARY} ${'x'.repeat(4096)}`, // long hidden trace
      conclusion: 'I am sure the task is done, please accept',
    });
    const d1 = await verifier.run('artifact-acceptance', selfReport);
    probe('D: high-confidence + long-trace subject FAILS the deterministic validator',
      d1.status === 'FAIL' && d1.reasonCode === 'SCHEMA_VIOLATION', jsonOf(d1));
    const d1e = await verifier.runAndRecord('artifact-acceptance', {
      taskId: 'task-confidence',
      attempt: 1,
      artifact: { sha256: H1 },
    }, selfReport);
    probe('D: the recorded evidence status is FAIL — not PASS', d1e.status === 'FAIL', jsonOf(d1e));
    probe('D: FAIL evidence cannot close a HIGH-risk task',
      workflow.canCloseTask({ risk: 'HIGH', verifierStatus: d1e.status, evidence: d1e, artifact: { sha256: H1 } }).closable === false);
    probe('D: the hidden-trace canary NEVER lands in the evidence record',
      !jsonOf(d1e).includes(HIDDEN_COT_CANARY), jsonOf(d1e));

    // recordEvidence structurally REFUSES confidence/trace inputs — there is
    // no parameter, shape or length that can promote them into a PASS.
    const realFail = { validatorId: 'artifact-acceptance', type: 'json-schema', status: 'FAIL', reasonCode: 'SCHEMA_VIOLATION', durationMs: 1, evidence: '' };
    const withConfidence = await engineThrows(() => vEngine.recordEvidence({
      result: realFail, taskId: 't', attempt: 1, artifact: { sha256: H1 }, confidence: 0.99,
    }));
    const withTrace = await engineThrows(() => vEngine.recordEvidence({
      result: realFail, taskId: 't', attempt: 1, artifact: { sha256: H1 }, reasoningTrace: 'x'.repeat(100000),
    }));
    const resultWithConfidence = await engineThrows(() => vEngine.recordEvidence({
      result: { ...realFail, confidence: 0.99 }, taskId: 't', attempt: 1, artifact: { sha256: H1 },
    }));
    const validInput = await engineThrows(() => vEngine.recordEvidence({
      result: realFail, taskId: 't', attempt: 1, artifact: { sha256: H1 },
    }));
    probe('D: recordEvidence REJECTS confidence inputs (EvidenceError, fail visible)',
      withConfidence instanceof vEngine.EvidenceError && String(withConfidence.issues?.[0] ?? withConfidence).includes('confidence'), String(withConfidence));
    probe('D: recordEvidence REJECTS reasoning-trace inputs (any length)',
      withTrace instanceof vEngine.EvidenceError && String(withTrace.issues?.[0] ?? withTrace).includes('reasoningTrace'), String(withTrace));
    probe('D: recordEvidence REJECTS a result carrying self-report fields',
      resultWithConfidence instanceof vEngine.EvidenceError, String(resultWithConfidence));
    probe('D: the same input WITHOUT self-report fields records fine (no false rejection)',
      validInput === null, String(validInput));

    // Status is copied verbatim for EVERY status — nothing flips a non-PASS.
    const statuses = ['FAIL', 'ERROR', 'UNAVAILABLE'];
    const verbatim = [];
    for (const status of statuses) {
      const ev = await vEngine.recordEvidence({
        result: { validatorId: 'v', type: 'exact-text', status, reasonCode: 'X', durationMs: 0, evidence: '' },
        taskId: 't', attempt: 1, artifact: { sha256: H1 },
      });
      verbatim.push(ev.status === status);
    }
    probe('D: FAIL/ERROR/UNAVAILABLE are recorded verbatim (no promotion path)', verbatim.every(Boolean), jsonOf(verbatim));
    probe('D: even a 100k-char trace input is rejected, not truncated into evidence',
      (await engineThrows(() => vEngine.recordEvidence({
        result: realFail, taskId: 't', attempt: 1, artifact: { sha256: H1 }, reasoningTrace: 'y'.repeat(100000), chainOfThought: 'z'.repeat(100000),
      }))) instanceof vEngine.EvidenceError);
    await host.dispose();
  } finally {
    cleanup();
    CLEANUP = null;
  }
}

// ---------------------------------------------------------------------------
// [E] Audit events are VALUE-FREE (canary assert): artifact content, hidden
// CoT and secret sentinels never appear in any emitted event.
// ---------------------------------------------------------------------------
console.log('[E] audit events value-free (canary assert)');
{
  const fx = buildFixture();
  CLEANUP = fx.base;
  try {
    const H1 = fx.hashOf(fx.artifactPath);
    const host = await mkHost({
      verifierConfig: CFG([fx.root]),
      workflowConfig: { requireVerifierPassOnClose: true },
    });
    const { verifier, workflow } = host;

    verifier.register({ validatorId: 'artifact-intact', type: 'file-hash', config: { path: fx.artifactPath, sha256: H1 } });
    const evPass = await verifier.runAndRecord('artifact-intact', { taskId: 'task-canary', attempt: 1, artifact: { path: fx.artifactPath, revision: 'rev-1' } });
    // Artifact changes ⇒ stale close block; then an intentional FAIL (old expected hash).
    writeFileSync(fx.artifactPath, `${ARTIFACT_CANARY}\nrevision two ${HIDDEN_COT_CANARY}\n`);
    const H2 = fx.hashOf(fx.artifactPath);
    const stale = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: 'PASS', evidence: evPass, artifact: { sha256: H2 } });
    const evFail = await verifier.runAndRecord('artifact-intact', { taskId: 'task-canary', attempt: 2, artifact: { sha256: H2 } });
    const blocked = workflow.canCloseTask({ risk: 'HIGH', verifierStatus: evFail.status, evidence: evFail, artifact: { sha256: H2 } });
    await verifier.runAndRecord('missing-validator', { taskId: 'task-canary', attempt: 3, artifact: { sha256: H2 } });

    probe('E: scenario really ran (stale block + FAIL block recorded)',
      stale.closable === false && blocked.closable === false, jsonOf([stale, blocked]));
    const allJson = jsonOf(host.events);
    probe('E: NO artifact content canary in ANY event', !allJson.includes(ARTIFACT_CANARY), 'artifact canary leaked');
    probe('E: NO hidden-CoT canary in ANY event', !allJson.includes(HIDDEN_COT_CANARY), 'hidden-CoT canary leaked');
    probe('E: NO secret sentinel in ANY event (defense in depth)', !allJson.includes(SECRET_SENTINEL), 'sentinel leaked');
    probe('E: NO artifact bytes/hash-input content anywhere in the event stream',
      !allJson.includes('revision one') && !allJson.includes('revision two'), 'content leaked');
    probe('E: events observed (verification + close_gate)', host.eventsNamed('verification').length >= 3 && host.eventsNamed('close_gate').length >= 2, jsonOf(host.events.map((e) => e.event)));
    probe('E: verification events carry ids/status/reason only',
      host.eventsNamed('verification').every((e) => jsonOf(Object.keys(e.fields).sort()) === jsonOf(['detail', 'verificationId', 'verificationStatus'])),
      jsonOf(host.eventsNamed('verification')));
    // The evidence RECORDS themselves are also value-free (hashes/ids only).
    probe('E: evidence records carry ids/hashes/labels only — never content',
      !jsonOf([evPass, evFail]).includes(ARTIFACT_CANARY) && !jsonOf([evPass, evFail]).includes(HIDDEN_COT_CANARY),
      jsonOf([evPass, evFail]));
    await host.dispose();
  } finally {
    cleanup();
    CLEANUP = null;
  }
}

// ---------------------------------------------------------------------------
// [F] Regression — v1.2 close matrix + FIX-BE hardening intact (same engine).
// ---------------------------------------------------------------------------
console.log('[F] regression: v1.2 close matrix + FIX-BE validator hardening intact');
{
  const fx = buildFixture();
  CLEANUP = fx.base;
  try {
    // v1.2 close-gate matrix (mirrors the suite checks exactly).
    const limits = { requireVerifierPassOnClose: true };
    probe('F: v1.2 FAIL blocks close', wEngine.canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'FAIL' }).closable === false);
    probe('F: v1.2 MISSING blocks close', wEngine.canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'MISSING' }).closable === false);
    probe('F: v1.2 PASS closes', wEngine.canCloseTask(limits, { risk: 'HIGH', verifierStatus: 'PASS' }).closable === true);
    probe('F: v1.2 LOW risk unrestricted', wEngine.canCloseTask(limits, { risk: 'LOW', verifierStatus: 'MISSING' }).closable === true);
    probe('F: v1.2 disabled gate unrestricted',
      wEngine.canCloseTask({ requireVerifierPassOnClose: false }, { risk: 'HIGH', verifierStatus: 'FAIL' }).closable === true);

    // FIX-BE #1: symlink escape still rejected BEFORE any content read.
    const outsideHash = fx.hashOf(fx.secretTxt);
    const symlinked = await vEngine.runValidator({
      spec: { validatorId: 'symlink', type: 'file-hash', config: { path: join(fx.root, 'link-outside'), sha256: outsideHash } },
      config: CFG([fx.root]),
      runtime: makeRuntime(),
      pathMod,
      labPolicyConfirmed: false,
    });
    probe('F: FIX-BE intact — out-of-root symlink file-hash still UNAVAILABLE PATH_OUTSIDE_ALLOWED_ROOTS',
      symlinked.status === 'UNAVAILABLE' && symlinked.reasonCode === 'PATH_OUTSIDE_ALLOWED_ROOTS', jsonOf(symlinked));

    // FIX-BE #1b: a runtime without real-path capability can never read content.
    const legacy = await vEngine.runValidator({
      spec: { validatorId: 'legacy', type: 'file-hash', config: { path: fx.artifactPath, sha256: fx.hashOf(fx.artifactPath) } },
      config: CFG([fx.root]),
      runtime: { fsExists: async () => false, fsRead: async () => null, sha256: async () => 'a'.repeat(64), exec: async () => ({ code: 0, stdout: '', stderr: '' }) },
      pathMod: { resolve },
      labPolicyConfirmed: false,
    });
    probe('F: FIX-BE intact — runtime without realpath ⇒ ERROR CONFINEMENT_UNVERIFIABLE',
      legacy.status === 'ERROR' && legacy.reasonCode === 'CONFINEMENT_UNVERIFIABLE', jsonOf(legacy));

    // FIX-BE #2: bounded JSON-schema validator still rejects extra properties,
    // supports local $ref, and reports unsupported keywords as UNAVAILABLE.
    const schemaCase = (spec) => vEngine.runValidator({ spec, config: CFG([]), runtime: makeRuntime(), pathMod, labPolicyConfirmed: false, subject: spec.subject });
    const extraProp = await schemaCase({ validatorId: 'e1', type: 'json-schema', config: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } } }, subject: JSON.stringify({ ok: true, extra: 1 }) });
    probe('F: FIX-BE intact — additionalProperties:false still rejects extras',
      extraProp.status === 'FAIL' && extraProp.reasonCode === 'SCHEMA_VIOLATION', jsonOf(extraProp));
    const refCase = await schemaCase({ validatorId: 'e2', type: 'json-schema', config: { schema: { type: 'object', required: ['n'], properties: { n: { $ref: '#/$defs/p' } }, $defs: { p: { type: 'integer', minimum: 1 } } } }, subject: JSON.stringify({ n: 3 }) });
    probe('F: FIX-BE intact — local $ref still resolves', refCase.status === 'PASS', jsonOf(refCase));
    const ifThen = await schemaCase({ validatorId: 'e3', type: 'json-schema', config: { schema: { type: 'object', if: { properties: { a: { const: 'x' } } }, then: { required: ['b'] } } }, subject: JSON.stringify({ a: 'x' }) });
    probe('F: FIX-BE intact — unsupported keyword still UNAVAILABLE (never PASS)',
      ifThen.status === 'UNAVAILABLE' && ifThen.reasonCode === 'SCHEMA_UNSUPPORTED', jsonOf(ifThen));

    // Cross-check: the workflow evidence mirror accepts records produced by
    // the verifier engine (shared-shape contract on REAL records).
    const H1 = fx.hashOf(fx.artifactPath);
    const shared = await vEngine.recordEvidence({
      result: { validatorId: 'v', type: 'exact-text', status: 'PASS', reasonCode: 'OK', durationMs: 0, evidence: '' },
      taskId: 'task-shared', attempt: 1, artifact: { sha256: H1 },
    });
    probe('F: mirror accepts REAL verifier-engine records (validateCloseEvidenceRecord)',
      wEngine.validateCloseEvidenceRecord(shared) !== null
      && wEngine.canCloseTask({ requireVerifierPassOnClose: true }, { risk: 'HIGH', verifierStatus: 'PASS', evidence: shared, artifact: { sha256: H1 } }).closable === true,
      jsonOf(shared));
    probe('F: mirror rejects a tampered record (hash rewritten)',
      wEngine.canCloseTask({ requireVerifierPassOnClose: true }, {
        risk: 'HIGH', verifierStatus: 'PASS',
        evidence: { ...shared, artifact: { ...shared.artifact, sha256: 'f'.repeat(64) } },
        artifact: { sha256: H1 },
      }).reasonCode === 'EVIDENCE_STALE', 'tamper not caught');
  } finally {
    cleanup();
    CLEANUP = null;
  }
}

// ---------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('----------------------------------------------------------------');
if (failed.length > 0) {
  console.error(`V131 EVIDENCE BINDING FAILED: ${failed.length}/${checks.length} probes failed:`);
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log(`all ${checks.length} probes passed (real engines + real pinned-cordis adapters)`);
console.log('V131_EVIDENCE_BINDING_VERIFIED');
process.exit(0);
