/**
 * supreme-minimal-probe — TASK 2 REAL LOADER GATE PLUGIN.
 *
 * The smallest possible plugin authored against the pinned Cordis conventions:
 *   - declares its name
 *   - apply(ctx, config) produces ONE deterministic observable startup effect
 *   - registers a disposal effect that produces the dispose marker
 *   - no inject, no services, no tools
 *
 * Markers prove, through the REAL DSH Loader:
 *   MINIMAL_PLUGIN_LOAD, MINIMAL_PLUGIN_OBSERVABLE_EFFECT, MINIMAL_PLUGIN_DISPOSE
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const name = 'supreme-minimal-probe';

export const inject: string[] = [];

export const Config = z.object({
  markerPath: z.string().default('dsh-supreme/data/real/minimal-probe.markers.jsonl'),
  label: z.string().default('minimal'),
});

export function apply(ctx: import('@deepseek-ai/cordis').Context, config: z.infer<typeof Config>): void {
  const markerPath = resolve(config.markerPath);
  const write = (event: string): void => {
    mkdirSync(dirname(markerPath), { recursive: true });
    appendFileSync(markerPath, JSON.stringify({ event, label: config.label, ts: Date.now() }) + '\n');
  };

  // Cordis effect: execute() runs at apply; its RETURN VALUE is the disposer
  // (vendor/cordis/src/fiber.ts — Effect = Disposable | Promise<Disposable>).
  ctx.effect(() => {
    write('MINIMAL_PLUGIN_LOAD');
    write('MINIMAL_PLUGIN_OBSERVABLE_EFFECT');
    return () => {
      write('MINIMAL_PLUGIN_DISPOSE');
    };
  }, 'supreme-minimal-probe.markers');

  ctx.logger.info('supreme-minimal-probe active (label=%s)', config.label);
}
