/**
 * dsh-supreme suite CLI — executes the release verification and prints the
 * report. Exit 0 when every executable gate passed (see verdict + blockingGates
 * for the honest DSH-upstream status per Spec §34).
 *
 * Run: bun run dsh-supreme/src/suite/cli.ts [--skip-real-boots] [--expect-partial] [--json]
 *
 * --expect-partial (CI keyless mode): the DOCUMENTED keyless outcome is
 * VERDICT PARTIAL where the only permitted blockers are the upstream-absence
 * pair { REAL_BOOT_SKIPPED, UPSTREAM_CHECKOUT_UNAVAILABLE }. Exit 0 iff the
 * report matches exactly that shape (blockers must be a SUBSET of the pair and
 * REAL_BOOT_SKIPPED must be present); any real failure — UNIT:*, leaks,
 * hygiene/audit/schema findings — adds a blocker outside the pair and exits 1.
 */
import { runFullSuite } from './runner';

const argv = process.argv.slice(2);
const skipRealBoots = argv.includes('--skip-real-boots');
const expectPartial = argv.includes('--expect-partial');
const asJson = argv.includes('--json');

const report = await runFullSuite({ skipRealBoots });

if (!asJson) {
  const line = '═'.repeat(64);
  console.log(line);
  console.log('DSH SUPREME V1 — RELEASE VERIFICATION SUITE');
  console.log(line);
  console.log(`UPSTREAM   ${report.upstream.repository}`);
  console.log(`COMMIT     ${report.upstream.commit.slice(0, 12)} (unchanged=${report.upstream.commitUnchanged})`);
  console.log(`WORKTREE   ${report.upstream.worktreeClean ? 'CLEAN' : 'DIRTY'} (patches=${report.upstream.upstreamPatchCount})`);
  console.log(`DSH ${report.upstream.dshVersion} · cordis ${report.upstream.cordisVersion} · node ${report.upstream.nodeVersion}`);
  console.log(line);
  for (const p of report.plugins) {
    const failed = p.checks.filter((c) => c.status !== 'PASS');
    console.log(`PLUGIN ${p.unit.padEnd(4)} ${p.name} (${p.checks.length} checks${failed.length ? `, ${failed.length} failed` : ''})`);
    for (const c of failed) console.log(`         ${c.status} ${c.id}: ${c.detail ?? ''}`);
  }
  console.log(line);
  for (const c of report.compositions) {
    console.log(`BOOT   ${c.status.padEnd(4)} ${c.name.padEnd(16)} boot=${c.bootMs ?? 'n/a'}ms dispose=${c.disposeMs ?? 'n/a'}ms`);
    for (const g of c.gates ?? []) {
      if (g.status !== 'PASS') console.log(`         ${g.status} ${g.gate}: ${g.detail}`);
    }
  }
  console.log(line);
  console.log(`MINIMAL REAL GATE  load=${report.minimalGate.load} effect=${report.minimalGate.observableEffect} dispose=${report.minimalGate.dispose} loader=${report.minimalGate.realLoader}`);
  console.log(`SECURITY           sentinelLeaks=${report.security.sentinelLeaks} paidAutomaticFallback=${report.security.paidAutomaticFallback}`);
  console.log(`PERFORMANCE        router=${report.performance.routerDecisionMs}ms/1k obs=${report.performance.observabilityWriteMs}ms/1k`);
  console.log(line);
  console.log(`VERDICT            ${report.verdict}`);
  if (report.blockingGates.length > 0) {
    console.log(`BLOCKING GATES     ${report.blockingGates.join(', ')}`);
  }
  console.log(line);
} else {
  console.log(JSON.stringify(report, null, 2));
}

if (expectPartial) {
  const keylessBlockers = new Set(['REAL_BOOT_SKIPPED', 'UPSTREAM_CHECKOUT_UNAVAILABLE']);
  const matchesKeylessContract =
    report.verdict === 'PARTIAL' &&
    report.blockingGates.includes('REAL_BOOT_SKIPPED') &&
    report.blockingGates.every((g) => keylessBlockers.has(g));
  if (!matchesKeylessContract) {
    if (!asJson) {
      console.log(`EXPECT-PARTIAL MISMATCH  blockers=[${report.blockingGates.join(', ')}] verdict=${report.verdict}`);
    }
    process.exit(1);
  }
  process.exit(0);
}
process.exit(report.blockingGates.length === 0 ? 0 : 1);
