/**
 * dsh-supreme/suite — gate check harness.
 *
 * Runtime verification (NOT a test framework): executable gates producing
 * PASS/FAIL evidence for the DSH Supreme release report (Spec §19/§22).
 */

export type CheckStatus = 'PASS' | 'FAIL' | 'ERROR';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail?: string;
  durationMs: number;
}

export interface Check {
  id: string;
  title: string;
  run(): void | Promise<void>;
}

export class CheckAssertionError extends Error {}

export function expectTrue(value: unknown, message: string): void {
  if (value !== true) throw new CheckAssertionError(message);
}

export function expectEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new CheckAssertionError(`${message} (actual=${String(actual)} expected=${String(expected)})`);
  }
}

export function expectThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new CheckAssertionError(`${message} (did not throw)`);
}

export function check(id: string, title: string, run: () => void | Promise<void>): Check {
  return { id, title, run };
}

/** Run a list of checks, isolating failures per check. */
export async function runChecks(checks: Check[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    const started = Date.now();
    try {
      await c.run();
      results.push({ id: c.id, title: c.title, status: 'PASS', durationMs: Date.now() - started });
    } catch (err) {
      const status: CheckStatus = err instanceof CheckAssertionError ? 'FAIL' : 'ERROR';
      results.push({
        id: c.id,
        title: c.title,
        status,
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      });
    }
  }
  return results;
}
