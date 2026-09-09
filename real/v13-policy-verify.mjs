#!/usr/bin/env bun
/**
 * dsh-supreme/real/v13-policy-verify.mjs — END-TO-END proof of the four
 * v1.3 "ASTRA-hardening" policy features (ASTRA-1 backlog, research/
 * gpt6-astra-2026-09.md §7):
 *
 *   P1  CoT visibility profile + risk-gated CoT requirement
 *   P1  Deny-circumvention guard (deny_retry)
 *   P2  Encoding-layer taint scan (encoding_blob)
 *   P3  Capability-class gating (capability_class_unsanctioned)
 *
 * Exercises the REAL code, not a simulation:
 *   - the REAL engine (src/plugins/supreme-policy/engine.ts) imported directly
 *     by bun — no upstream build needed;
 *   - the REAL Cordis adapter (src/plugins/supreme-policy/index.ts) mounted on
 *     the REAL pinned cordis (@deepseek-ai/cordis, an existing node_modules
 *     dependency) — the zod Config schema resolves the config BEFORE apply
 *     (the v3-review lesson: keys must ARRIVE at the service), the REAL
 *     session/event evidence tracker and the REAL tools/pre-execute waterfall
 *     deny seam are driven end-to-end, with a stub supremeObservability
 *     capturing the emitted audit events.
 *
 * NO upstream file is modified. No new npm dependencies. Exit 0 only if ALL
 * probes pass; the final line is the exact marker V13_POLICY_E2E_COMPLETE.
 */
// REAL pinned cordis: prefer the installed dependency (monorepo node_modules);
// fall back to the pinned upstream checkout (vendor/cordis TS source) so a
// standalone repo clone also works — same source of truth, no extra deps.
const ROOT = new URL('..', import.meta.url);
const engineHref = new URL('src/plugins/supreme-policy/engine.ts', ROOT).href;
const adapterHref = new URL('src/plugins/supreme-policy/index.ts', ROOT).href;
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
const checks = [];
const probe = (name, ok, detail = '') => {
  checks.push({ name, ok: ok === true, detail });
  console.log(`  ${ok === true ? 'PASS' : 'FAIL'}  ${name}${ok === true ? '' : `  << ${detail}`}`);
};

// ---------------------------------------------------------------------------
// Harness: mount the REAL adapter on the REAL pinned cordis with a stub
// supremeObservability that records every emitted audit event.
// ---------------------------------------------------------------------------
const mkHost = async (config) => {
  const events = [];
  const root = new Context();
  root.provide('supremeObservability', {
    record(event, fields) { events.push({ event, fields }); },
  });
  const mod = await import(adapterHref);
  if (mod.name !== 'supreme-policy' || Array.isArray(mod.inject) === false) {
    throw new Error('adapter module shape unexpected');
  }
  await root.plugin(mod, config);
  const service = root.get('supremePolicy');
  const firePreExecute = (exec) =>
    root.events.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }));
  const emitAssistantMessage = (sessionId, hasReasoning) =>
    root.emit('session/event', { id: sessionId }, {
      type: 'assistant/message',
      data: hasReasoning
        ? { message: { content: [{ type: 'reasoning' }, { type: 'text', text: 'thinking done' }] } }
        : { message: { content: [{ type: 'text', text: 'no trace' }] } },
    });
  const execOf = (sessionId, name, args, extra = {}) => ({
    callId: `call-${Math.random().toString(36).slice(2, 8)}`,
    name,
    arguments: args,
    agent: sessionId === null ? undefined : { id: sessionId },
    signal: new AbortController().signal,
    ...extra,
  });
  const dispose = () => root.fiber.dispose();
  return { root, service, events, firePreExecute, emitAssistantMessage, execOf, dispose };
};

const engine = await import(engineHref);
console.log('== v1.3 policy E2E — REAL engine + REAL pinned-cordis adapter ==');

// ---------------------------------------------------------------------------
// Probe 0 — shared surface exists (exact exported names) + config defaults.
// ---------------------------------------------------------------------------
console.log('[0] engine surface + behavior-preserving defaults');
probe('COT_VISIBILITIES exported', JSON.stringify(engine.COT_VISIBILITIES) === JSON.stringify(['verbose', 'terse', 'none']), JSON.stringify(engine.COT_VISIBILITIES));
probe('CAPABILITY_CLASSES exported', JSON.stringify(engine.CAPABILITY_CLASSES) === JSON.stringify(['ROUTINE', 'CYBER_OFFENSIVE', 'DESTRUCTIVE_OPS']), JSON.stringify(engine.CAPABILITY_CLASSES));
probe('ENCODING_BLOB_CLASS exported', engine.ENCODING_BLOB_CLASS === 'encoding_blob', String(engine.ENCODING_BLOB_CLASS));
probe('DENY_RETRY_REASON_CODE exported', engine.DENY_RETRY_REASON_CODE === 'deny_retry', String(engine.DENY_RETRY_REASON_CODE));
probe('PRODUCTION_DEFAULTS.riskGatedCoT=false', engine.PRODUCTION_DEFAULTS.riskGatedCoT === false);
probe('PRODUCTION_DEFAULTS.enableEncodingScan=false', engine.PRODUCTION_DEFAULTS.enableEncodingScan === false);
probe('PRODUCTION_DEFAULTS.capabilityClassGate=OFF', engine.PRODUCTION_DEFAULTS.capabilityClassGate === 'OFF');
probe('PRODUCTION_DEFAULTS.denyCircumventionGuard=true (documented choice)', engine.PRODUCTION_DEFAULTS.denyCircumventionGuard === true);
probe('PRODUCTION_DEFAULTS.cotVisibilityProfiles empty', Object.keys(engine.PRODUCTION_DEFAULTS.cotVisibilityProfiles ?? { NULLED: 1 }).length === 0);
probe('PRODUCTION_DEFAULTS sanctioned lists empty', engine.PRODUCTION_DEFAULTS.sanctionedCapabilityClasses.length === 0 && engine.PRODUCTION_DEFAULTS.labCapabilityClassAllowlist.length === 0);

// v1.2-only config (no v1.3 keys) must validate with all v1.3 defaults applied.
const v12Only = engine.validatePolicyConfig({ executionClass: 'SUPREME', reasoningTracePolicy: 'ENFORCE' });
probe('v1.2-only config keeps working', v12Only.executionClass === 'SUPREME' && v12Only.reasoningTracePolicy === 'ENFORCE');
probe('v1.2-only config gains v1.3 defaults', v12Only.enableEncodingScan === false && v12Only.capabilityClassGate === 'OFF' && v12Only.riskGatedCoT === false && v12Only.denyCircumventionGuard === true);

// Deterministic config validation rejects bad v1.3 values.
const badVisibility = (() => { try { engine.validatePolicyConfig({ cotVisibilityProfiles: { r: 'bogus' } }); return false; } catch (e) { return e instanceof engine.PolicyConfigError; } })();
probe('bad cotVisibilityProfiles value rejected', badVisibility);
const badGate = (() => { try { engine.validatePolicyConfig({ capabilityClassGate: 'ON' }); return false; } catch (e) { return e instanceof engine.PolicyConfigError; } })();
probe('bad capabilityClassGate value rejected', badGate);
const badList = (() => { try { engine.validatePolicyConfig({ sanctionedCapabilityClasses: 'CYBER_OFFENSIVE' }); return false; } catch (e) { return e instanceof engine.PolicyConfigError; } })();
probe('non-array sanctionedCapabilityClasses rejected', badList);

// ---------------------------------------------------------------------------
// Probe A — P1 CoT visibility profile: visibility 'none' + ENFORCE ⇒ NO deny
// on an ordinary assistant message (downgraded to audit-only).
// ---------------------------------------------------------------------------
console.log('[A] P1 CoT visibility profile (none ⇒ audit-only under ENFORCE)');
probe('resolveCotVisibility: explicit beats profile', engine.resolveCotVisibility({ explicit: 'terse', profile: 'none' }) === 'terse');
probe('resolveCotVisibility: profile beats default', engine.resolveCotVisibility({ profile: 'none' }) === 'none');
probe('resolveCotVisibility: invalid explicit falls through', engine.resolveCotVisibility({ explicit: 'SHOUTY', profile: 'terse' }) === 'terse');
probe('resolveCotVisibility: default verbose', engine.resolveCotVisibility({}) === 'verbose');
probe('engine: ENFORCE + visibility none + absent trace ⇒ AUDIT (never DENY)', engine.evaluateCoTEnforcement('ENFORCE', { reasoningTracePresent: false, tool: 'bash', visibility: 'none' }).decision === 'AUDIT');
probe('engine: downgrade carries reason code', engine.evaluateCoTEnforcement('ENFORCE', { reasoningTracePresent: false, tool: 'bash', visibility: 'none' }).reasonCodes.includes('COT_VISIBILITY_NONE_DOWNGRADED'));
probe('engine: ENFORCE + verbose + absent trace still DENY (v1.2 preserved)', engine.evaluateCoTEnforcement('ENFORCE', { reasoningTracePresent: false, tool: 'bash', visibility: 'verbose' }).decision === 'DENY');

{
  const host = await mkHost({
    executionClass: 'SUPREME',
    reasoningTracePolicy: 'ENFORCE',
    cotVisibilityProfiles: { 'route-none': 'none' },
  });
  host.emitAssistantMessage('route-none', false); // ordinary assistant message WITHOUT reasoning
  host.emitAssistantMessage('route-verbose', false);
  const noneDecision = await host.firePreExecute(host.execOf('route-none', 'search', { q: 'ordinary call' }));
  probe('adapter: none-route ordinary call is NOT denied', noneDecision.kind === 'allow', JSON.stringify(noneDecision));
  const noneAudit = host.events.filter((e) => e.event === 'cot_missing');
  probe('adapter: none-route downgraded cot_missing is audit-only', noneAudit.length === 1 && String(noneAudit[0].fields.detail).includes('COT_VISIBILITY_NONE_DOWNGRADED'), JSON.stringify(noneAudit));
  const verboseDecision = await host.firePreExecute(host.execOf('route-verbose', 'search', { q: 'ordinary call' }));
  probe('adapter: verbose-route (no profile) still denies under ENFORCE', verboseDecision.kind === 'deny', JSON.stringify(verboseDecision));
  // (a)-explicit: cotVisibility rides the request payload under the EXACT field
  // name. Distinct argument shape ({q,lang}) so the deny-circumvention guard
  // (which takes precedence over the CoT check for same-shape retries) is not
  // triggered by the earlier denied verbose-route call.
  const explicitNone = await host.firePreExecute(host.execOf('route-verbose', 'search', { q: 'x', lang: 'en' }, { cotVisibility: 'none' }));
  probe('adapter: explicit payload cotVisibility=none overrides profile (no deny)', explicitNone.kind === 'allow', JSON.stringify(explicitNone));
  const explicitVerbose = await host.firePreExecute(host.execOf('route-none', 'search', { q: 'x', lang: 'en' }, { cotVisibility: 'verbose' }));
  probe('adapter: explicit payload cotVisibility=verbose overrides none-profile (deny)', explicitVerbose.kind === 'deny', JSON.stringify(explicitVerbose));
  host.dispose();
}

// ---------------------------------------------------------------------------
// Probe B — P1 risk-gated CoT: riskGatedCoT:true ⇒ ENFORCE only for HIGH-risk
// (command/network/write) tool calls; non-HIGH keeps AUDIT.
// ---------------------------------------------------------------------------
console.log('[B] P1 risk-gated CoT requirement');
probe('classifyToolRisk: bash ⇒ HIGH', engine.classifyToolRisk('bash') === 'HIGH');
probe('classifyToolRisk: net.fetch ⇒ HIGH', engine.classifyToolRisk('net.fetch') === 'HIGH');
probe('classifyToolRisk: write_file ⇒ HIGH', engine.classifyToolRisk('write_file') === 'HIGH');
probe('classifyToolRisk: read_file ⇒ LOW', engine.classifyToolRisk('read_file') === 'LOW');
probe('classifyToolRisk: notebook ⇒ LOW (token match, no substring hits)', engine.classifyToolRisk('notebook') === 'LOW');
probe('engine: riskGated ENFORCE + LOW tool ⇒ AUDIT', engine.evaluateCoTEnforcement('ENFORCE', { reasoningTracePresent: false, tool: 'search', riskGated: true, toolRisk: 'LOW' }).decision === 'AUDIT');
probe('engine: riskGated ENFORCE + HIGH tool ⇒ DENY', engine.evaluateCoTEnforcement('ENFORCE', { reasoningTracePresent: false, tool: 'bash', riskGated: true, toolRisk: 'HIGH' }).decision === 'DENY');

{
  const host = await mkHost({
    executionClass: 'SUPREME',
    reasoningTracePolicy: 'ENFORCE',
    riskGatedCoT: true,
  });
  host.emitAssistantMessage('sess-b', false); // HIGH-risk command without CoT this turn
  const high = await host.firePreExecute(host.execOf('sess-b', 'bash', { cmd: 'deploy.sh' }));
  probe('adapter: HIGH-risk command without CoT ⇒ deny', high.kind === 'deny', JSON.stringify(high));
  const low = await host.firePreExecute(host.execOf('sess-b', 'search', { q: 'x' }));
  probe('adapter: non-HIGH tool keeps AUDIT behavior (no deny)', low.kind === 'allow', JSON.stringify(low));
  const lowAudit = host.events.filter((e) => e.event === 'cot_missing').at(-1);
  probe('adapter: non-HIGH audit event emitted', lowAudit !== undefined && String(lowAudit.fields.detail).includes('COT_TRACE_MISSING'), JSON.stringify(lowAudit));
  host.dispose();
}

// ---------------------------------------------------------------------------
// Probe C — P1 deny-circumvention guard: deny → same-shape retry ⇒ second deny
// with `deny_retry`; different tool / different shape unaffected; reset works.
// ---------------------------------------------------------------------------
console.log('[C] P1 deny-circumvention guard');
{
  const host = await mkHost({
    executionClass: 'SUPREME',
    enableUnicodeSanitization: true,
    taintPolicy: 'DENY', // deterministic first-deny source: hidden unicode in args
  });
  const tainted = { cmd: 'ok\u200Bhidden' };
  const first = await host.firePreExecute(host.execOf('sess-c', 'bash', tainted));
  probe('guard: first call denied (unicode taint)', first.kind === 'deny', JSON.stringify(first));
  const retry = await host.firePreExecute(host.execOf('sess-c', 'bash', { cmd: 'a perfectly clean retry' }));
  probe('guard: same-shape retry ⇒ deny with deny_retry', retry.kind === 'deny' && String(retry.reason).includes('deny_retry'), JSON.stringify(retry));
  const retryAudit = host.events.filter((e) => e.event === 'deny_retry');
  probe('guard: deny_retry audit event emitted', retryAudit.length === 1 && retryAudit[0].fields.tool === 'bash', JSON.stringify(retryAudit));
  const otherShape = await host.firePreExecute(host.execOf('sess-c', 'bash', { cmd: 'x', cwd: '/tmp' }));
  probe('guard: different arg shape unaffected', otherShape.kind === 'allow', JSON.stringify(otherShape));
  const otherTool = await host.firePreExecute(host.execOf('sess-c', 'search', { q: 'y' }));
  probe('guard: different tool unaffected', otherTool.kind === 'allow', JSON.stringify(otherTool));
  // Engine-level: signature is shape-only — values NEVER enter it.
  const sig1 = engine.denySignature('bash', { cmd: 'rm -rf /important' });
  const sig2 = engine.denySignature('bash', { cmd: 'ls' });
  probe('guard: signature identical for different values of same shape', sig1 === sig2, `${sig1} vs ${sig2}`);
  probe('guard: signature carries NO value substring', !sig1.includes('rm -rf'), sig1);
  // Service-level API + operator escape hatch.
  host.service.recordDeny('sess-z', 'bash', { cmd: 'x' });
  probe('guard: service recordDeny/denyCircumventionCheck wired', host.service.denyCircumventionCheck('sess-z', 'bash', { cmd: 'y' }).reasonCodes.includes('deny_retry'));
  host.service.resetDenyCircumvention('sess-z');
  probe('guard: resetDenyCircumvention clears session', host.service.denyCircumventionCheck('sess-z', 'bash', { cmd: 'y' }).denied === false);
  host.dispose();
}

// ---------------------------------------------------------------------------
// Probe D — P2 encoding-layer taint scan: 512-char base64 arg ⇒ taint_detected
// class `encoding_blob`; NO argument value anywhere in the emitted events.
// ---------------------------------------------------------------------------
console.log('[D] P2 encoding-layer taint scan (encoding_blob, value-free audits)');
{
  // Exactly 512 contiguous base64 characters (384 bytes ⇒ 512 base64 chars,
  // mixed case + digits so it is genuinely base64, not a pure hex run).
  const raw = new Uint8Array(384);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + 3) % 256;
  const blob = Buffer.from(raw).toString('base64');
  if (blob.length !== 512 || /^[0-9a-fA-F]+$/.test(blob)) throw new Error('blob fixture must be 512 mixed-alphabet base64 chars');
  const args = { data: blob };
  const host = await mkHost({
    executionClass: 'SUPREME',
    enableEncodingScan: true,
    enableUnicodeSanitization: false,
    taintPolicy: 'LOG_ONLY',
  });
  const decision = await host.firePreExecute(host.execOf('sess-d', 'fs.write', args));
  probe('encoding: LOG_ONLY keeps the call allowed', decision.kind === 'allow', JSON.stringify(decision));
  const evt = host.events.find((e) => e.event === 'taint_detected');
  probe('encoding: taint_detected event emitted', evt !== undefined, JSON.stringify(host.events));
  probe('encoding: event detail carries class encoding_blob', evt !== undefined && String(evt.fields.detail).includes('encoding_blob'), JSON.stringify(evt));
  probe('encoding: event detail carries arg NAME + run length', evt !== undefined && String(evt.fields.detail).includes('arg:data') && String(evt.fields.detail).includes('len:512'), JSON.stringify(evt));
  const allEventsJson = JSON.stringify(host.events);
  const valueSlices = [blob.slice(0, 48), blob.slice(200, 248), blob.slice(464, 512)];
  probe('encoding: NO argument value in ANY emitted event', !valueSlices.some((s) => allEventsJson.includes(s)) && !allEventsJson.includes(blob), 'value leaked into events');
  // Engine-level detail builder + scan findings.
  const findings = engine.scanToolArguments(args, { unicode: false, encoding: true });
  probe('encoding: scanToolArguments finds encoding_blob', findings.tainted === true && findings.hits.includes('encoding_blob'), JSON.stringify(findings));
  probe('encoding: hit records kind+length', findings.encoding.length === 1 && findings.encoding[0].kind === 'base64' && findings.encoding[0].length === 512, JSON.stringify(findings.encoding));
  const detail = engine.formatTaintEventDetail(findings);
  probe('encoding: formatTaintEventDetail value-free', !detail.includes(blob.slice(0, 48)), detail);
  // Hex variant + short-run negative.
  const hexFindings = engine.scanToolArguments({ payload: 'a'.repeat(256) + 'zz' }, { unicode: false, encoding: true });
  probe('encoding: 256-char pure-hex run reported as hex kind', hexFindings.encoding[0]?.kind === 'hex' && hexFindings.encoding[0]?.length === 256, JSON.stringify(hexFindings.encoding));
  probe('encoding: pure-hex run also maps to class encoding_blob', hexFindings.hits.includes('encoding_blob'), JSON.stringify(hexFindings));
  const shortFindings = engine.scanToolArguments({ data: 'A'.repeat(255) }, { unicode: false, encoding: true });
  probe('encoding: 255-char run does NOT qualify (≥256 rule)', shortFindings.tainted === false && shortFindings.encoding.length === 0, JSON.stringify(shortFindings));
  probe('encoding: unicode-disabled scan misses zero-width chars when only encoding toggled', engine.scanToolArguments({ x: 'a\u200Bb' }, { unicode: false, encoding: true }).tainted === false);
  host.dispose();
}
{
  // Enforcement respects taintPolicy=DENY; default (toggle off) preserves v1.2.
  const host = await mkHost({
    executionClass: 'SUPREME',
    enableEncodingScan: true,
    enableUnicodeSanitization: false,
    taintPolicy: 'DENY',
  });
  const denied = await host.firePreExecute(host.execOf('sess-d2', 'fs.write', { data: Buffer.alloc(300, 65, 'latin1').toString('latin1') }));
  probe('encoding: taintPolicy=DENY refuses the call', denied.kind === 'deny' && String(denied.reason).includes('encoding_blob'), JSON.stringify(denied));
  probe('encoding: deny reason carries no argument value', !JSON.stringify(denied).includes('A'.repeat(64)), JSON.stringify(denied));
  host.dispose();
  const hostOff = await mkHost({ executionClass: 'SUPREME', enableUnicodeSanitization: false, taintPolicy: 'DENY' });
  const offDecision = await hostOff.firePreExecute(hostOff.execOf('sess-d3', 'fs.write', { data: Buffer.alloc(512, 65, 'latin1').toString('latin1') }));
  probe('encoding: toggle default (off) preserves v1.2 behavior', offDecision.kind === 'allow' && hostOff.events.length === 0, JSON.stringify(offDecision));
  hostOff.dispose();
}

// ---------------------------------------------------------------------------
// Probe E — P3 capability-class gating: ENFORCE in production ⇒ deny for
// CYBER_OFFENSIVE; LAB + labCapabilityClassAllowlist ⇒ pass; AUDIT mode emits
// capability_class_unsanctioned; unlabeled requests pass untouched.
// ---------------------------------------------------------------------------
console.log('[E] P3 capability-class gating');
probe('capability: ROUTINE is a declared class', engine.CAPABILITY_CLASSES.includes('ROUTINE'));
probe('engine: production STANDARD + ENFORCE + CYBER_OFFENSIVE ⇒ DENY', engine.evaluateCapabilityGate({ ...engine.PRODUCTION_DEFAULTS, executionClass: 'STANDARD', capabilityClassGate: 'ENFORCE' }, { capabilityClass: 'CYBER_OFFENSIVE' }).decision === 'DENY');
probe('engine: LAB allowlist sanctions additively', engine.evaluateCapabilityGate({ ...engine.PRODUCTION_DEFAULTS, executionClass: 'LAB', capabilityClassGate: 'ENFORCE', labCapabilityClassAllowlist: ['CYBER_OFFENSIVE'] }, { capabilityClass: 'CYBER_OFFENSIVE' }).decision === 'ALLOW');
probe('engine: LAB allowlist does NOT sanction on STANDARD (no LAB leak)', engine.evaluateCapabilityGate({ ...engine.PRODUCTION_DEFAULTS, executionClass: 'STANDARD', capabilityClassGate: 'ENFORCE', labCapabilityClassAllowlist: ['CYBER_OFFENSIVE'] }, { capabilityClass: 'CYBER_OFFENSIVE' }).decision === 'DENY');
probe('engine: absent class passes untouched (UNKNOWN-cost posture unchanged)', engine.evaluateCapabilityGate({ ...engine.PRODUCTION_DEFAULTS, capabilityClassGate: 'ENFORCE' }, {}).decision === 'ALLOW');
probe('engine: normalization is case-insensitive', engine.evaluateCapabilityGate({ ...engine.PRODUCTION_DEFAULTS, executionClass: 'LAB', capabilityClassGate: 'ENFORCE', labCapabilityClassAllowlist: ['cyber_offensive'] }, { capabilityClass: 'CYBER_OFFENSIVE' }).decision === 'ALLOW');
probe('engine: gate OFF passes even unsanctioned class', engine.evaluateCapabilityGate({ ...engine.PRODUCTION_DEFAULTS, capabilityClassGate: 'OFF' }, { capabilityClass: 'DESTRUCTIVE_OPS' }).decision === 'ALLOW');

{
  const host = await mkHost({
    executionClass: 'STANDARD',
    capabilityClassGate: 'ENFORCE',
  });
  const deny = await host.firePreExecute(host.execOf('sess-e', 'delegate', { target: 'sub-agent', capabilityClass: 'CYBER_OFFENSIVE' }));
  probe('adapter: production ENFORCE + CYBER_OFFENSIVE ⇒ deny', deny.kind === 'deny' && String(deny.reason).includes('capability_class_unsanctioned'), JSON.stringify(deny));
  const audit = host.events.filter((e) => e.event === 'capability_class_unsanctioned').at(-1);
  probe('adapter: capability_class_unsanctioned audited with class label', audit !== undefined && String(audit.fields.detail).includes('CYBER_OFFENSIVE'), JSON.stringify(audit));
  const unlabeled = await host.firePreExecute(host.execOf('sess-e', 'search', { q: 'x' }));
  probe('adapter: unlabeled request passes untouched', unlabeled.kind === 'allow', JSON.stringify(unlabeled));
  const argsSignal = host.service.extractSignal({ capabilityClass: 'routine' });
  probe('adapter: extractSignal normalizes exact field name', argsSignal.capabilityClass === 'ROUTINE', JSON.stringify(argsSignal));
  host.dispose();
}
{
  const host = await mkHost({
    executionClass: 'LAB',
    capabilityClassGate: 'ENFORCE',
    labCapabilityClassAllowlist: ['CYBER_OFFENSIVE'],
  });
  const pass = await host.firePreExecute(host.execOf('sess-f', 'delegate', { target: 'eval-target', capabilityClass: 'CYBER_OFFENSIVE' }));
  probe('adapter: LAB + labCapabilityClassAllowlist ⇒ pass', pass.kind === 'allow', JSON.stringify(pass));
  const stillDenied = await host.firePreExecute(host.execOf('sess-f', 'delegate', { target: 'eval-target', capabilityClass: 'DESTRUCTIVE_OPS' }));
  probe('adapter: LAB non-allowlisted class still denied', stillDenied.kind === 'deny', JSON.stringify(stillDenied));
  host.dispose();
}
{
  const host = await mkHost({ executionClass: 'STANDARD', capabilityClassGate: 'AUDIT' });
  const audited = await host.firePreExecute(host.execOf('sess-g', 'delegate', { target: 'x', capabilityClass: 'DESTRUCTIVE_OPS' }));
  probe('adapter: AUDIT mode does NOT deny', audited.kind === 'allow', JSON.stringify(audited));
  const audit = host.events.filter((e) => e.event === 'capability_class_unsanctioned').at(-1);
  probe('adapter: AUDIT mode emits capability_class_unsanctioned', audit !== undefined && String(audit.fields.detail).includes('mode:AUDIT'), JSON.stringify(audit));
  host.dispose();
}

// ---------------------------------------------------------------------------
// Probe F — config ARRIVES at the service through the REAL zod Config path
// (v3-review lesson: zod must not strip → break; keys must reach the service).
// ---------------------------------------------------------------------------
console.log('[F] v1.3 config keys ARRIVE at the service (real zod resolution)');
{
  const host = await mkHost({
    executionClass: 'SUPREME',
    reasoningTracePolicy: 'AUDIT',
    cotVisibilityProfiles: { 'route-1': 'terse' },
    riskGatedCoT: true,
    denyCircumventionGuard: false,
    enableEncodingScan: true,
    capabilityClassGate: 'AUDIT',
    sanctionedCapabilityClasses: ['ROUTINE'],
    labCapabilityClassAllowlist: [],
  });
  const cfg = host.service.config;
  probe('arrival: cotVisibilityProfiles', JSON.stringify(cfg.cotVisibilityProfiles) === JSON.stringify({ 'route-1': 'terse' }), JSON.stringify(cfg.cotVisibilityProfiles));
  probe('arrival: riskGatedCoT', cfg.riskGatedCoT === true);
  probe('arrival: denyCircumventionGuard', cfg.denyCircumventionGuard === false);
  probe('arrival: enableEncodingScan', cfg.enableEncodingScan === true);
  probe('arrival: capabilityClassGate', cfg.capabilityClassGate === 'AUDIT');
  probe('arrival: sanctionedCapabilityClasses', JSON.stringify(cfg.sanctionedCapabilityClasses) === JSON.stringify(['ROUTINE']));
  probe('arrival: labCapabilityClassAllowlist default []', JSON.stringify(cfg.labCapabilityClassAllowlist) === JSON.stringify([]));
  probe('arrival: v1.2 keys still intact', cfg.taintPolicy === 'LOG_ONLY' && cfg.allowUnknownCost === false);
  // Defaults applied when the caller omits every v1.3 key.
  const hostMinimal = await mkHost({ executionClass: 'CORE' });
  const d = hostMinimal.service.config;
  probe('arrival: omitted v1.3 keys get behavior-preserving defaults', d.riskGatedCoT === false && d.enableEncodingScan === false && d.capabilityClassGate === 'OFF' && d.denyCircumventionGuard === true && Object.keys(d.cotVisibilityProfiles).length === 0);
  hostMinimal.dispose();
  host.dispose();
}

// ---------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('----------------------------------------------------------------');
if (failed.length > 0) {
  console.error(`V13 POLICY E2E FAILED: ${failed.length}/${checks.length} probes failed:`);
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log(`all ${checks.length} probes passed (real engine + real pinned-cordis adapter)`);
console.log('V13_POLICY_E2E_COMPLETE');
process.exit(0);
