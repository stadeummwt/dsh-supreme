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
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { resolve as resolvePath } from 'node:path';
import {
  runValidator,
  VALIDATOR_TYPES,
  type ValidatorType,
  type VerifierConfig,
  type VerifierResult,
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
});

export type VerifierService = {
  register(spec: { validatorId: string; type: ValidatorType; config: Record<string, unknown> }): () => void;
  list(): string[];
  run(validatorId: string, subject?: string): Promise<VerifierResult>;
  runAll(subject?: string): Promise<VerifierResult[]>;
  config(): VerifierConfig;
};

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  const policy: PolicyService = ctx.supremePolicy;
  const verifierConfig: VerifierConfig = {
    allowCommands: config.allowCommands,
    allowNetwork: config.allowNetwork,
    allowedRoots: config.allowedRoots.map((r) => resolvePath(r)),
    commandTimeoutMs: config.commandTimeoutMs,
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
  };

  const labPolicyConfirmed = (): boolean => {
    try {
      return policy.config.executionClass === 'LAB';
    } catch {
      return false;
    }
  };

  const runOne = (spec: VerifierSpec, subject?: string): Promise<VerifierResult> =>
    runValidator({
      spec,
      config: verifierConfig,
      runtime,
      pathMod: { resolve: resolvePath },
      labPolicyConfirmed: labPolicyConfirmed(),
      subject,
    });

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
      // Optional write — ctx.get() requires no inject declaration (reflect.ts).
      ctx.get('supremeObservability')?.record('verification', {
        verificationId: spec.validatorId,
        verificationStatus: result.status,
        detail: result.reasonCode,
      });
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
  };

  ctx.provide('supremeVerifier', Object.freeze(service));
  ctx.logger.info(
    'supreme-verifier active (commands=%s, roots=%d)',
    String(verifierConfig.allowCommands),
    verifierConfig.allowedRoots.length,
  );
}

