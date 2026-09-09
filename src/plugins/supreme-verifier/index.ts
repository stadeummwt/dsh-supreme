/**
 * @dsh-supreme/verifier — Cordis adapter (REAL pinned plugin shape).
 *
 * SERVICE = supremeVerifier
 * INJECTED DSH SERVICES = ['supremePolicy']
 * (Frozen dependency graph: policy → verifier; verifier MUST NOT require workflow-policy.)
 *
 * Command execution uses Node child_process ONLY when allowCommands=true AND
 * the mounted supremePolicy reports executionClass=LAB. This mirrors the
 * sandbox/approval boundary — the verifier never bypasses DSH policy seams.
 *
 * v1.3.1 hardening: the runtime provides REAL-path fs primitives (realpath,
 * stat, open+fstat read, hashBytes). File validators confine on REAL paths —
 * a symlink inside an allowedRoot that points outside is rejected BEFORE any
 * content read; file-hash additionally cross-checks the pre-open stat
 * identity (dev/ino) against the open-handle (fstat) identity. This reduces
 * (does NOT eliminate) the check-vs-open race; Windows junction handling is
 * delegated to fs.realpath but is untested on this Linux environment.
 *
 * v1.3.1 evidence binding (Improvement §3A): the service exposes
 * `hashArtifact(path)` (deterministic node-crypto sha-256 over the CURRENT
 * artifact bytes, same confinement + read bounds as file validators) and
 * `runAndRecord(validatorId, { taskId, attempt, artifact })`, which runs the
 * REAL registered validator and binds its verbatim status — PASS, FAIL,
 * ERROR or UNAVAILABLE — into a VerificationEvidence carrying the artifact
 * hash. Verification consumes artifacts, test results and reviewable result
 * summaries ONLY; model confidence and reasoning traces are structurally
 * excluded by the engine (FORBIDDEN_EVIDENCE_FIELDS) and can never produce
 * or promote a PASS.
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { resolve as resolvePath, relative as relativePath, isAbsolute as isAbsolutePath } from 'node:path';
import {
  DEFAULT_MAX_FILE_READ_BYTES,
  pathIsAllowed,
  recordEvidence,
  resolveRealConfinement,
  runValidator,
  VALIDATOR_TYPES,
  type ValidatorType,
  type VerifierConfig,
  type VerifierResult,
  type VerificationEvidence,
  type VerifierSpec,
} from './engine';

const VALIDATOR_TYPE_SET = new Set<string>(VALIDATOR_TYPES);
import type { PolicyService } from '../supreme-policy/index';
export const name = 'supreme-verifier';

export const inject = ['supremePolicy'];

export const Config = z.object({
  allowCommands: z.boolean().default(false),
  allowNetwork: z.boolean().default(false),
  allowedRoots: z.array(z.string()).default([]),
  commandTimeoutMs: z.number().int().min(100).default(30_000),
  maxFileReadBytes: z.number().int().min(1).default(DEFAULT_MAX_FILE_READ_BYTES),
});

export type VerifierService = {
  register(spec: { validatorId: string; type: ValidatorType; config: Record<string, unknown> }): () => void;
  list(): string[];
  run(validatorId: string, subject?: string): Promise<VerifierResult>;
  runAll(subject?: string): Promise<VerifierResult[]>;
  config(): VerifierConfig;
  /**
   * v1.3.1 §3A: deterministic sha-256 (node crypto) of the CURRENT artifact
   * bytes at `path`, under the SAME real-path confinement and read bounds as
   * the file validators. `{ sha256: null }` when the path is missing,
   * outside the allowed roots, or beyond maxFileReadBytes — callers must
   * treat null as "currency unknowable" (fail-closed), never as a match.
   */
  hashArtifact(path: string): Promise<{ sha256: string | null }>;
  /**
   * v1.3.1 §3A: run the registered validator and RECORD its verbatim status
   * into a VerificationEvidence bound to { taskId, attempt, artifact }. When
   * `artifact.sha256` is omitted but `artifact.path` is given, the hash of
   * the current bytes is computed at record time (record immediately after
   * the run). Throws EvidenceError on malformed identity — never fabricates
   * a record, never rewrites a non-PASS status.
   */
  runAndRecord(
    validatorId: string,
    identity: { taskId: string; attempt: number; artifact: { path?: string; sha256?: string; revision?: string } },
    subject?: string,
  ): Promise<VerificationEvidence>;
};

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  const policy: PolicyService = ctx.supremePolicy;
  const verifierConfig: VerifierConfig = {
    allowCommands: config.allowCommands,
    allowNetwork: config.allowNetwork,
    allowedRoots: config.allowedRoots.map((r) => resolvePath(r)),
    commandTimeoutMs: config.commandTimeoutMs,
    maxFileReadBytes: config.maxFileReadBytes,
  };

  const registry = new Map<string, VerifierSpec>();

  const runtime = {
    fsExists: async (p: string) => process.getBuiltinModule('node:fs').existsSync(p),
    fsRead: async (p: string) => {
      try {
        return await process.getBuiltinModule('node:fs').promises.readFile(p, 'utf8');
      } catch {
        return null;
      }
    },
    // Legacy whole-path hash — kept for interface compatibility; file-hash
    // no longer uses it (content reads require the real-path members below).
    sha256: async (p: string) => {
      try {
        const nodeCrypto = process.getBuiltinModule('node:crypto');
        return nodeCrypto.createHash('sha256').update(await process.getBuiltinModule('node:fs').promises.readFile(p)).digest('hex');
      } catch {
        return null;
      }
    },
    exec: (command: string, args: string[], cwd: string, timeoutMs: number) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolveSpawn, rejectSpawn) => {
        const childProcess = process.getBuiltinModule('node:child_process');
        const child = childProcess.spawn(command, args, { cwd, timeout: timeoutMs });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        child.on('error', rejectSpawn);
        child.on('close', (code: number | null) => resolveSpawn({ code: code ?? -1, stdout: stdout.slice(0, 2048), stderr: stderr.slice(0, 2048) }));
      }),
    // --- v1.3.1 real-path confinement members (required by file validators) ---
    realpath: async (p: string) => process.getBuiltinModule('node:fs').promises.realpath(p),
    stat: async (p: string) => {
      try {
        const st = await process.getBuiltinModule('node:fs').promises.stat(p);
        return { dev: st.dev, ino: st.ino, size: st.size };
      } catch {
        return null;
      }
    },
    // Fused open + read + fstat: the returned dev/ino identify the OPEN file
    // handle, letting the engine detect a path swap between stat and open.
    readBytesWithFstat: async (p: string) => {
      const fsmod = process.getBuiltinModule('node:fs');
      let fh: Awaited<ReturnType<typeof fsmod.promises.open>> | undefined;
      try {
        fh = await fsmod.promises.open(p, 'r');
        const st = await fh.stat();
        const bytes = await fh.readFile();
        return { bytes, dev: st.dev, ino: st.ino, size: st.size };
      } catch {
        return null;
      } finally {
        try {
          await fh?.close();
        } catch {
          // already closed
        }
      }
    },
    hashBytes: async (bytes: Uint8Array) => process.getBuiltinModule('node:crypto').createHash('sha256').update(bytes).digest('hex'),
  };

  const labPolicyConfirmed = (): boolean => {
    try {
      return policy.config.executionClass === 'LAB';
    } catch {
      return false;
    }
  };

  const pathMod = { resolve: resolvePath, relative: relativePath, isAbsolute: isAbsolutePath };

  const runOne = (spec: VerifierSpec, subject?: string): Promise<VerifierResult> =>
    runValidator({
      spec,
      config: verifierConfig,
      runtime,
      // relative/isAbsolute unlock REAL-path containment (path.relative escape
      // checks); the engine degrades loudly when they are absent.
      pathMod,
      labPolicyConfirmed: labPolicyConfirmed(),
      subject,
    });

  /** Optional observability write — ctx.get() requires no inject declaration. */
  const recordVerificationEvent = (spec: VerifierSpec, result: VerifierResult): void => {
    ctx.get('supremeObservability')?.record('verification', {
      verificationId: spec.validatorId,
      verificationStatus: result.status,
      detail: result.reasonCode,
    });
  };

  // v1.3.1 §3A: hash the CURRENT artifact bytes (node crypto sha-256) under
  // the same confinement + read bounds as the file validators.
  const hashArtifact = async (p: string): Promise<{ sha256: string | null }> => {
    if (typeof p !== 'string' || p.length === 0) return { sha256: null };
    if (!pathIsAllowed(p, verifierConfig.allowedRoots, pathMod)) return { sha256: null };
    if (
      typeof runtime.realpath === 'function' &&
      typeof runtime.stat === 'function' &&
      typeof runtime.readBytesWithFstat === 'function' &&
      typeof runtime.hashBytes === 'function'
    ) {
      const conf = await resolveRealConfinement(p, verifierConfig.allowedRoots, pathMod, runtime.realpath);
      if (conf.kind !== 'ok') return { sha256: null };
      const maxBytes = verifierConfig.maxFileReadBytes ?? DEFAULT_MAX_FILE_READ_BYTES;
      const st = await runtime.stat(conf.realTarget);
      if (st === null || !Number.isFinite(st.size) || st.size > maxBytes) return { sha256: null };
      const read = await runtime.readBytesWithFstat(conf.realTarget);
      if (read === null) return { sha256: null };
      return { sha256: await runtime.hashBytes(read.bytes) };
    }
    // Runtime without real-path capability: refuse content reads entirely
    // (same posture as file-hash — never a lexical-only read).
    return { sha256: null };
  };

  const service: VerifierService = {
    register(spec) {
      if (registry.has(spec.validatorId)) {
        throw new Error(`validator "${spec.validatorId}" already registered`);
      }
      if (!VALIDATOR_TYPE_SET.has(spec.type)) {
        throw new Error(`unsupported validator type "${String(spec.type)}"`);
      }
      registry.set(spec.validatorId, spec);
      return () => registry.delete(spec.validatorId);
    },
    list: () => [...registry.keys()],
    run: async (validatorId, subject) => {
      const spec = registry.get(validatorId);
      if (!spec) {
        return {
          validatorId,
          type: 'exact-text',
          status: 'UNAVAILABLE',
          evidence: 'validator not registered',
          durationMs: 0,
          reasonCode: 'VALIDATOR_NOT_FOUND',
        };
      }
      const result = await runOne(spec, subject);
      recordVerificationEvent(spec, result);
      return result;
    },
    runAll: async (subject) => {
      const results: VerifierResult[] = [];
      for (const spec of registry.values()) {
        results.push(await runOne(spec, subject));
      }
      return results;
    },
    config: () => verifierConfig,
    hashArtifact,
    runAndRecord: async (validatorId, identity, subject) => {
      const spec = registry.get(validatorId);
      // Unknown validator ⇒ explicit UNAVAILABLE record (never a fabricated
      // PASS) bound to the caller's identity, so the close gate sees exactly
      // why the verification could not run.
      const result: VerifierResult = spec
        ? await runOne(spec, subject)
        : {
            validatorId,
            type: 'exact-text',
            status: 'UNAVAILABLE',
            evidence: 'validator not registered',
            durationMs: 0,
            reasonCode: 'VALIDATOR_NOT_FOUND',
          };
      // Every runAndRecord — including the UNAVAILABLE one — is reflected in
      // the optional verification event trail (ids/status/reason only).
      recordVerificationEvent({ validatorId, type: result.type, config: {} }, result);
      // Bind to the CURRENT bytes at record time when the host gave a path
      // but no hash — record immediately after the run (small race window,
      // same class as the file-hash check-vs-open reduction; the close gate
      // re-checks currency against a FRESH hash at close time anyway).
      let artifact = identity.artifact;
      if ((artifact.sha256 === undefined || artifact.sha256 === null) && typeof artifact.path === 'string') {
        const computed = await hashArtifact(artifact.path);
        if (computed.sha256 !== null) artifact = { ...artifact, sha256: computed.sha256 };
      }
      // recordEvidence copies result.status VERBATIM (FAIL/ERROR/UNAVAILABLE
      // stay non-PASS), REQUIRES the artifact hash on PASS records, and
      // throws EvidenceError on malformed identity — a PASS without the
      // verified artifact hash is never fabricated.
      return recordEvidence({
        result,
        taskId: identity.taskId,
        attempt: identity.attempt,
        artifact,
        hashBytes: runtime.hashBytes,
      });
    },
  };

  ctx.provide('supremeVerifier', Object.freeze(service));
  ctx.logger.info(
    'supreme-verifier active (commands=%s, roots=%d)',
    String(verifierConfig.allowCommands),
    verifierConfig.allowedRoots.length,
  );
}

