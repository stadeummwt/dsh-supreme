/**
 * real/lib/obs-proof.mjs — shared deterministic observability proof helpers
 * for the e2e verifiers (bundle / composition / v12).
 *
 * Replaces the old fixed 300ms wait (a race on slow / antivirus-scanned /
 * Windows filesystems where mkdir+stat+append can exceed 300ms — the writer
 * only counts `written` AFTER appendFile resolves) with:
 *   1. poll `stats()` until written >= 1 (bounded, default 10s),
 *   2. await the writer queue via the service `flush()` so written/dropped are
 *      FINAL before asserting.
 * On failure `diagnoseObs` prints the FULL stats plus an actionable fix —
 * the fail-open writer must never mean fail-silent (see
 * research/dsh-ecosystem-bundle-2026-09.md §6 matrix).
 */
import { existsSync, readFileSync } from 'node:fs';

/**
 * Poll until at least one record is written, then drain the queue.
 * Returns the final writer stats (written/dropped/rotations/lastWriteError).
 */
export async function awaitObsRecord(obs, { timeoutMs = 10_000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let stats = obs.stats();
  while (stats.written < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    stats = obs.stats();
  }
  if (typeof obs?.flush === 'function') {
    const final = await obs.flush();
    return { ...final };
  }
  // Installed copy without the flush() service surface: polling is the best
  // available evidence (stats are still final once written >= 1 stabilized).
  return {
    written: stats.written,
    dropped: stats.dropped,
    rotations: stats.rotations,
    lastWriteError: null,
  };
}

/** True when the JSONL exists and has at least one non-empty line. */
export function fileHasLines(path) {
  return existsSync(path) && readFileSync(path, 'utf8').trim().length > 0;
}

/**
 * Actionable diagnosis for a failed observability proof. Returns '' on success.
 * Matrix mirrors research/dsh-ecosystem-bundle-2026-09.md §6.
 */
export function diagnoseObs(kind, stats, fileOk, filePath) {
  if (stats.written >= 1 && fileOk) return '';
  const lines = [];
  lines.push(
    `observability proof failed (${kind}) — full stats: written=${stats.written} dropped=${stats.dropped} rotations=${stats.rotations} lastWriteError=${JSON.stringify(stats.lastWriteError ?? null)}`,
  );
  if (stats.dropped > 0) {
    lines.push(
      `diagnosis: events REACHED the writer but append FAILED (${stats.dropped} dropped; lastWriteError above).`,
    );
    lines.push(
      'fix: check dataDir permissions / antivirus lock / disk space for the directory above; an absolute dataDir in your patch layer removes cwd ambiguity.',
    );
  } else if (stats.written === 0 && stats.dropped === 0) {
    lines.push('diagnosis: no session event reached the ctx.on listener (nothing written AND nothing dropped).');
    lines.push(
      'fix: boot with a FRESH DSH_HOME — a poisoned session store can stop session events entirely (upstream discussion #802); also check the boot log for "supreme-observability store" lines (writer init / mkdir failures).',
    );
  } else if (!fileOk) {
    lines.push(`diagnosis: stats report writes but the JSONL is not visible at ${filePath}.`);
    lines.push('fix: relative dataDir defaults resolve against the dsh process working directory — check where you launched dsh from.');
  }
  return lines.join('\n');
}
