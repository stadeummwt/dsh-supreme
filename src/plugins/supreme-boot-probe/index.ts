/**
 * supreme-boot-probe — CORE/STANDARD composition marker plugin.
 *
 * No injects: loadable in every composition. ~600ms after activation (when
 * the whole entry tree has settled) it writes one marker line listing which
 * Supreme services are present in the REAL booted context, probed via
 * ctx.get() (the no-inject optional pattern from vendor/cordis/src/reflect.ts).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import '../context-types';
export const name = 'supreme-boot-probe';

export const inject: string[] = [];

export const Config = z.object({
  markerPath: z.string().default('dsh-supreme/data/real/boot-probe.markers.jsonl'),
});

const PROBED_SERVICES = [
  'llm',
  'sessions',
  'systemPrompt',
  'tokenMeter',
  'credentials',
  'subagents',
  'workflowEngine',
  'supremePolicy',
  'supremeObservability',
  'supremeBenchmark',
  'supremeRouter',
  'supremeVerifier',
  'supremeMemoryPolicy',
  'supremeWorkflowPolicy',
] as const;

export function apply(ctx: import('@deepseek-ai/cordis').Context, config: z.infer<typeof Config>): void {
  const markerPath = resolve(config.markerPath);
  ctx.effect(() => {
  const timer = setTimeout(() => {
    const present: Record<string, boolean> = {};
    for (const service of PROBED_SERVICES) {
      present[service] = ctx.get(service) !== undefined;
    }
    mkdirSync(dirname(markerPath), { recursive: true });
    appendFileSync(
      markerPath,
      JSON.stringify({ event: 'BOOT_PROBE', ts: Date.now(), present }) + '\n',
    );
  }, 600);
  return () => {
    clearTimeout(timer);
  };
  }, 'supreme-boot-probe.probe');
  // Cleanup on unload — no dangling timers (Spec §30).
}
