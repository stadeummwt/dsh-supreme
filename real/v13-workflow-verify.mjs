#!/usr/bin/env bun
/**
 * dsh-supreme/real/v13-workflow-verify.mjs — END-TO-END proof of the two v1.3
 * "ASTRA-hardening" workflow-policy features (ASTRA-1 backlog, research/
 * gpt6-astra-2026-09.md §7):
 *
 *   P2  Agent-to-agent (A2A) contact policy (a2a_contact / a2a_contact_denied)
 *   P3  Overreach audit (overreach_suspected)
 *
 * Exercises the REAL code, not a simulation:
 *   - the REAL engine (src/plugins/supreme-workflow-policy/engine.ts) imported
 *     directly by bun — no upstream build needed;
 *   - the REAL Cordis adapter (src/plugins/supreme-workflow-policy/index.ts)
 *     mounted on the REAL pinned cordis (@deepseek-ai/cordis, an existing
 *     node_modules dependency) — the zod Config schema resolves the config
 *     BEFORE apply (the v3-review lesson: keys must ARRIVE at the service),
 *     and the REAL pinned seams are driven end-to-end:
 *       tools/pre-execute   (waterfall — the pre-fact DENY seam),
 *       subagent/start      (pinned emit event, SubagentRunInfo shape),
 *       workflow/agent-start(pinned emit event, WorkflowRunInfo+Agent shape),
 *     with a stub supremeObservability capturing every emitted audit event
 *     (the other injected service slots are unused stubs — the adapter never
 *     calls them).
 *
 * NO upstream file is modified. No new npm dependencies. Exit 0 only if ALL
 * probes pass; the final line is the exact marker V13_WORKFLOW_E2E_COMPLETE.
 */
const ROOT = new URL('..', import.meta.url);
const engineHref = new URL('src/plugins/supreme-workflow-policy/engine.ts', ROOT).href;
const adapterHref = new URL('src/plugins/supreme-workflow-policy/index.ts', ROOT).href;
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
const jsonOf = (value) => JSON.stringify(value);

// Content canaries: must NEVER appear in any emitted audit event.
const MESSAGE_CANARY = 'A2A_SECRET_PAYLOAD_canary_42';
const PROMPT_CANARY = 'SPAWN_PROMPT_canary_42';
const SECRET_PATH = 'config/secrets/key.pem';

// ---------------------------------------------------------------------------
// Harness: mount the REAL adapter on the REAL pinned cordis with stub service
// slots (the adapter only ever CALLS supremeObservability.record) and a stub
// supremeObservability that captures every emitted audit event.
// ---------------------------------------------------------------------------
const mkHost = async (config) => {
  const events = [];
  const root = new Context();
  root.provide('supremePolicy', {});
  root.provide('supremeVerifier', {});
  root.provide('subagents', {});
  root.provide('workflowEngine', {});
  root.provide('supremeObservability', {
    record(event, fields) { events.push({ event, fields }); },
  });
  const mod = await import(adapterHref);
  if (mod.name !== 'supreme-workflow-policy' || mod.inject.length !== 5) {
    throw new Error('adapter module shape unexpected');
  }
  await root.plugin(mod, config); // cordis resolves the REAL zod Config BEFORE apply
  const service = root.get('supremeWorkflowPolicy');
  if (!service || typeof service.evaluateContact !== 'function') {
    throw new Error('supremeWorkflowPolicy service missing after mount');
  }
  // REAL pinned ToolExecution shape (packages/core/tools/src/index.ts:307/372):
  // { callId, name, arguments, agent?, signal } — agent.session.id is the
  // durable agent id used by the pinned send_message seam.
  const execOf = (agentId, name, args, extra = {}) => ({
    callId: `call-${Math.random().toString(36).slice(2, 8)}`,
    name,
    arguments: args,
    agent: agentId === null ? undefined : { session: { id: agentId } },
    signal: new AbortController().signal,
    ...extra,
  });
  const firePreExecute = (exec) =>
    root.events.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }));
  // REAL pinned emit events (subagent SubagentRunInfo / workflow RunInfo+AgentInfo).
  const emitSubagentStart = (info) => root.emit('subagent/start', info);
  const emitWorkflowAgentStart = (info, agent) => root.emit('workflow/agent-start', info, agent);
  const eventsNamed = (name) => events.filter((e) => e.event === name);
  const dispose = () => root.fiber.dispose();
  return { root, service, events, eventsNamed, execOf, firePreExecute, emitSubagentStart, emitWorkflowAgentStart, dispose };
};

const engine = await import(engineHref);
console.log('== v1.3 workflow-policy E2E — REAL engine + REAL pinned-cordis adapter ==');

// ---------------------------------------------------------------------------
// Probe 0 — surface, behavior-preserving defaults, deterministic validation.
// ---------------------------------------------------------------------------
console.log('[0] engine surface + behavior-preserving defaults');
probe('AGENT_CONTACT_POLICIES exported', jsonOf(engine.AGENT_CONTACT_POLICIES) === jsonOf(['LOG_ONLY', 'DENY']), jsonOf(engine.AGENT_CONTACT_POLICIES));
probe('RISK_LEVELS exported', jsonOf(engine.RISK_LEVELS) === jsonOf(['LOW', 'MEDIUM', 'HIGH']), jsonOf(engine.RISK_LEVELS));
probe('A2A_CONTACT_EVENT exported', engine.A2A_CONTACT_EVENT === 'a2a_contact', String(engine.A2A_CONTACT_EVENT));
probe('A2A_CONTACT_DENIED_REASON exported', engine.A2A_CONTACT_DENIED_REASON === 'a2a_contact_denied', String(engine.A2A_CONTACT_DENIED_REASON));
probe('OVERREACH_EVENT exported', engine.OVERREACH_EVENT === 'overreach_suspected', String(engine.OVERREACH_EVENT));
probe('defaults: agentContactPolicy=LOG_ONLY', engine.WORKFLOW_LIMIT_DEFAULTS.agentContactPolicy === 'LOG_ONLY');
probe('defaults: allowedContacts empty', Array.isArray(engine.WORKFLOW_LIMIT_DEFAULTS.allowedContacts) && engine.WORKFLOW_LIMIT_DEFAULTS.allowedContacts.length === 0);
probe('defaults: maxRiskLevel=HIGH (unchanged)', engine.WORKFLOW_LIMIT_DEFAULTS.maxRiskLevel === 'HIGH');
probe('defaults: approvalRequiredFor empty', Array.isArray(engine.WORKFLOW_LIMIT_DEFAULTS.approvalRequiredFor) && engine.WORKFLOW_LIMIT_DEFAULTS.approvalRequiredFor.length === 0);

// v1.2-only config keeps working and gains the v1.3 defaults.
const v12Only = engine.validateWorkflowLimits({});
probe('v1.2-only config keeps working (defaults applied)', v12Only.maxConcurrentAgents === 3 && v12Only.requireVerifierPassOnClose === false);
probe('v1.2-only config gains v1.3 defaults', v12Only.agentContactPolicy === 'LOG_ONLY' && v12Only.maxRiskLevel === 'HIGH' && v12Only.allowedContacts.length === 0 && v12Only.approvalRequiredFor.length === 0);

// Deterministic config validation rejects bad v1.3 values.
const throwsConfigError = (raw) => {
  try { engine.validateWorkflowLimits(raw); return false; } catch (e) { return e instanceof engine.WorkflowConfigError; }
};
probe('bad agentContactPolicy rejected', throwsConfigError({ agentContactPolicy: 'BLOCK' }));
probe('bad allowedContacts (missing to) rejected', throwsConfigError({ allowedContacts: [{ from: 'x' }] }));
probe('bad maxRiskLevel rejected', throwsConfigError({ maxRiskLevel: 'CRITICAL' }));
probe('bad approvalRequiredFor (non-string) rejected', throwsConfigError({ approvalRequiredFor: [42] }));

// ---------------------------------------------------------------------------
// Probe A — P2 engine core: deterministic graph matching (no heuristics).
// ---------------------------------------------------------------------------
console.log('[A] P2 A2A engine: deterministic contact-graph matching');
const inert = engine.evaluateAgentContact({ agentContactPolicy: 'DENY', allowedContacts: [] }, { from: 'a', to: 'b', channel: 'message' });
probe('engine: empty graph ⇒ policy inert (never flagged)', inert.flagged === false && inert.blocked === false && inert.reasonCode === 'NO_CONTACT_GRAPH', jsonOf(inert));
const noPair = engine.evaluateAgentContact({ agentContactPolicy: 'DENY', allowedContacts: [{ from: 'a', to: 'b' }] }, { from: 'a', to: '', channel: 'message' });
probe('engine: missing endpoint ⇒ not an inter-agent contact', noPair.flagged === false && noPair.reasonCode === 'NOT_INTER_AGENT', jsonOf(noPair));
const inGraph = engine.evaluateAgentContact({ agentContactPolicy: 'DENY', allowedContacts: [{ from: ' a ', to: 'b' }] }, { from: 'a', to: ' b ' });
probe('engine: trimmed directed edge matches (in-graph untouched)', inGraph.flagged === false && inGraph.reasonCode === 'CONTACT_IN_GRAPH', jsonOf(inGraph));
const reversed = engine.evaluateAgentContact({ agentContactPolicy: 'LOG_ONLY', allowedContacts: [{ from: 'a', to: 'b' }] }, { from: 'b', to: 'a' });
probe('engine: graph is DIRECTED — reversed pair is out-of-graph', reversed.flagged === true && reversed.blocked === false && reversed.reasonCode === 'CONTACT_OUTSIDE_GRAPH', jsonOf(reversed));
const denied = engine.evaluateAgentContact({ agentContactPolicy: 'DENY', allowedContacts: [{ from: 'a', to: 'b' }] }, { from: 'a', to: 'c' });
probe('engine: DENY blocks out-of-graph contact', denied.flagged === true && denied.blocked === true, jsonOf(denied));
const logged = engine.evaluateAgentContact({ agentContactPolicy: 'LOG_ONLY', allowedContacts: [{ from: 'a', to: 'b' }] }, { from: 'a', to: 'c' });
probe('engine: LOG_ONLY flags without blocking', logged.flagged === true && logged.blocked === false, jsonOf(logged));

// P3 engine core: deterministic 3-level classifier + overreach reasons.
probe('classifier: bash ⇒ HIGH', engine.classifyDelegationToolRisk('bash') === 'HIGH');
probe('classifier: net.fetch ⇒ HIGH', engine.classifyDelegationToolRisk('net.fetch') === 'HIGH');
probe('classifier: write_file ⇒ HIGH', engine.classifyDelegationToolRisk('write_file') === 'HIGH');
probe('classifier: read_file ⇒ LOW', engine.classifyDelegationToolRisk('read_file') === 'LOW');
probe('classifier: notebook ⇒ LOW (token match, no substring hits)', engine.classifyDelegationToolRisk('notebook') === 'LOW');
probe('classifier: subagent ⇒ MEDIUM (delegation surface)', engine.classifyDelegationToolRisk('subagent') === 'MEDIUM');
probe('classifier: send_message ⇒ MEDIUM (steering surface)', engine.classifyDelegationToolRisk('send_message') === 'MEDIUM');
probe('riskRank: LOW<MEDIUM<HIGH', engine.riskRank('LOW') < engine.riskRank('MEDIUM') && engine.riskRank('MEDIUM') < engine.riskRank('HIGH'));

// ---------------------------------------------------------------------------
// Probe B — P2 adapter, LOG_ONLY default: in-graph untouched, out-of-graph
// audited (a2a_contact), nothing blocked, NO message/argument values anywhere.
// ---------------------------------------------------------------------------
console.log('[B] P2 adapter LOG_ONLY — real tools/pre-execute waterfall');
{
  const host = await mkHost({
    allowedContacts: [{ from: 'agent-a', to: 'agent-b' }],
    // agentContactPolicy omitted ⇒ zod default LOG_ONLY (behavior-preserving).
  });
  const inGraphCall = await host.firePreExecute(host.execOf('agent-a', 'send_message', { agent_id: 'agent-b', message: 'status update' }));
  probe('adapter: in-graph send_message passes untouched', inGraphCall.kind === 'allow', jsonOf(inGraphCall));
  probe('adapter: in-graph contact emits NO a2a_contact', host.eventsNamed('a2a_contact').length === 0, jsonOf(host.eventsNamed('a2a_contact')));

  const outCall = await host.firePreExecute(host.execOf('agent-a', 'send_message', { agent_id: 'agent-c', message: MESSAGE_CANARY }));
  probe('adapter: LOG_ONLY keeps the out-of-graph call allowed', outCall.kind === 'allow', jsonOf(outCall));
  const evt = host.eventsNamed('a2a_contact').at(-1);
  probe('adapter: a2a_contact audit emitted', evt !== undefined, jsonOf(host.events));
  probe('adapter: detail carries channel/from/to/reason', evt !== undefined && String(evt.fields.detail).includes('channel:message') && String(evt.fields.detail).includes('from:agent-a') && String(evt.fields.detail).includes('to:agent-c') && String(evt.fields.detail).includes('reason:CONTACT_OUTSIDE_GRAPH'), evt && String(evt.fields.detail));
  probe('adapter: detail carries outcome LOGGED + mode LOG_ONLY', evt !== undefined && String(evt.fields.detail).includes('outcome:LOGGED') && String(evt.fields.detail).includes('mode:LOG_ONLY'), evt && String(evt.fields.detail));
  probe('adapter: event carries pinned tool name send_message', evt !== undefined && evt.fields.tool === 'send_message', evt && jsonOf(evt.fields));

  const ordinary = await host.firePreExecute(host.execOf('agent-a', 'search', { q: 'docs' }));
  probe('adapter: ordinary call (no target arg) untouched', ordinary.kind === 'allow' && host.eventsNamed('a2a_contact').length === 1, jsonOf(host.eventsNamed('a2a_contact')));
  const hostCall = await host.firePreExecute(host.execOf(null, 'send_message', { agent_id: 'agent-c', message: 'x' }));
  probe('adapter: call without a sender agent ⇒ no A2A evaluation', hostCall.kind === 'allow' && host.eventsNamed('a2a_contact').length === 1, jsonOf(host.eventsNamed('a2a_contact')));

  const allJson = jsonOf(host.events);
  probe('adapter: NO message/argument values in ANY event', !allJson.includes(MESSAGE_CANARY) && !allJson.includes('status update'), 'value leaked into events');
  probe('service: evaluateContact in-graph/out-of-graph', host.service.evaluateContact({ from: 'agent-a', to: 'agent-b' }).flagged === false && host.service.evaluateContact({ from: 'agent-a', to: 'agent-c' }).flagged === true && host.service.evaluateContact({ from: 'agent-a', to: 'agent-c' }).blocked === false);
  host.dispose();
}

// ---------------------------------------------------------------------------
// Probe C — P2 adapter, DENY: out-of-graph spawn/message BLOCKED pre-fact with
// a2a_contact_denied; in-graph passes; pinned emit seams audit post-fact.
// ---------------------------------------------------------------------------
console.log('[C] P2 adapter DENY — real waterfall deny + real emit-seam detection');
{
  const host = await mkHost({
    agentContactPolicy: 'DENY',
    allowedContacts: [
      { from: 'agent-a', to: 'agent-b' },
      { from: 'provider:spawn', to: 'child-2' },
      { from: 'workflow:etl-nightly', to: 'child-ok' },
    ],
  });
  const blocked = await host.firePreExecute(host.execOf('agent-a', 'send_message', { agent_id: 'agent-c', message: MESSAGE_CANARY }));
  probe('adapter: DENY blocks out-of-graph message', blocked.kind === 'deny', jsonOf(blocked));
  probe('adapter: deny reason carries a2a_contact_denied', blocked.kind === 'deny' && String(blocked.reason).includes('a2a_contact_denied'), blocked && String(blocked.reason));
  probe('adapter: deny reason carries NO agent ids or values', blocked.kind === 'deny' && !String(blocked.reason).includes('agent-c') && !String(blocked.reason).includes(MESSAGE_CANARY), blocked && String(blocked.reason));
  const denyEvt = host.eventsNamed('a2a_contact').at(-1);
  probe('adapter: blocked contact audited with outcome DENIED', denyEvt !== undefined && String(denyEvt.fields.detail).includes('outcome:DENIED'), denyEvt && String(denyEvt.fields.detail));

  const inGraphCall = await host.firePreExecute(host.execOf('agent-a', 'send_message', { agent_id: 'agent-b', message: 'ok' }));
  probe('adapter: in-graph message NOT blocked under DENY', inGraphCall.kind === 'allow', jsonOf(inGraphCall));

  const spawnBlocked = await host.firePreExecute(host.execOf('agent-a', 'subagent', { target: 'agent-c', prompt: PROMPT_CANARY }));
  probe('adapter: DENY blocks out-of-graph spawn channel (pinned subagent tool)', spawnBlocked.kind === 'deny' && String(spawnBlocked.reason).includes('a2a_contact_denied'), jsonOf(spawnBlocked));
  const spawnEvt = host.eventsNamed('a2a_contact').filter((e) => String(e.fields.detail).includes('channel:spawn')).at(-1);
  probe('adapter: spawn-channel audit recorded', spawnEvt !== undefined && String(spawnEvt.fields.detail).includes('channel:spawn'), spawnEvt && String(spawnEvt.fields.detail));

  // Post-fact detection on the REAL pinned emit events (cannot block — DETECTED).
  host.emitSubagentStart({ runId: 'run-1', provider: 'spawn', id: 'child-1', local: true });
  const subEvt = host.eventsNamed('a2a_contact').filter((e) => e.fields.subagent === 'child-1').at(-1);
  probe('adapter: subagent/start out-of-graph role edge ⇒ a2a_contact DETECTED', subEvt !== undefined && String(subEvt.fields.detail).includes('from:provider:spawn') && String(subEvt.fields.detail).includes('to:child-1') && String(subEvt.fields.detail).includes('outcome:DETECTED') && String(subEvt.fields.detail).includes('origin:subagent_start'), subEvt && String(subEvt.fields.detail));
  host.emitSubagentStart({ runId: 'run-2', provider: 'spawn', id: 'child-2', local: true });
  probe('adapter: declared provider→child edge on subagent/start untouched', host.eventsNamed('a2a_contact').filter((e) => e.fields.subagent === 'child-2').length === 0, jsonOf(host.eventsNamed('a2a_contact')));

  host.emitWorkflowAgentStart({ id: 'wfr-1', meta: { name: 'etl-nightly', description: 'nightly job' } }, { seq: 1, label: 'worker', childId: 'child-9' });
  const wfEvt = host.eventsNamed('a2a_contact').filter((e) => e.fields.workflow === 'etl-nightly').at(-1);
  probe('adapter: workflow/agent-start out-of-graph edge ⇒ a2a_contact DETECTED', wfEvt !== undefined && String(wfEvt.fields.detail).includes('from:workflow:etl-nightly') && String(wfEvt.fields.detail).includes('to:child-9') && String(wfEvt.fields.detail).includes('origin:workflow_agent_start'), wfEvt && String(wfEvt.fields.detail));
  host.emitWorkflowAgentStart({ id: 'wfr-1', meta: { name: 'etl-nightly', description: 'nightly job' } }, { seq: 2, label: 'fine', childId: 'child-ok' });
  probe('adapter: declared workflow→agent edge untouched', host.eventsNamed('a2a_contact').filter((e) => String(e.fields.detail).includes('to:child-ok')).length === 0, jsonOf(host.eventsNamed('a2a_contact')));

  const allJson = jsonOf(host.events);
  probe('adapter: NO message/prompt values in ANY event', !allJson.includes(MESSAGE_CANARY) && !allJson.includes(PROMPT_CANARY), 'value leaked into events');
  host.dispose();
}

// ---------------------------------------------------------------------------
// Probe D — P3 adapter: overreach_suspected for risk-above-max, approval-
// required classes, path-scope violations; audit-only; value-free details.
// ---------------------------------------------------------------------------
console.log('[D] P3 overreach audit — real waterfall, labels/levels/flags/counts only');
{
  const host = await mkHost({
    maxRiskLevel: 'LOW',
    approvalRequiredFor: ['CYBER_OFFENSIVE', 'DEPLOY'],
    allowedPaths: ['src/**'],
    blockedPaths: ['**/secrets/**'],
  });
  const riskCall = await host.firePreExecute(host.execOf('agent-a', 'delegate', { requestedTools: ['bash'], requestedPaths: ['src/app/main.ts'] }));
  probe('overreach: audit-only — call still allowed', riskCall.kind === 'allow', jsonOf(riskCall));
  const riskEvt = host.eventsNamed('overreach_suspected').at(-1);
  probe('overreach: HIGH request above max LOW ⇒ event', riskEvt !== undefined, jsonOf(host.eventsNamed('overreach_suspected')));
  probe('overreach: detail carries risk + max levels', riskEvt !== undefined && String(riskEvt.fields.detail).includes('risk:HIGH') && String(riskEvt.fields.detail).includes('max:LOW'), riskEvt && String(riskEvt.fields.detail));
  probe('overreach: detail carries reason RISK_ABOVE_MAX', riskEvt !== undefined && String(riskEvt.fields.detail).includes('RISK_ABOVE_MAX'), riskEvt && String(riskEvt.fields.detail));
  probe('overreach: in-allowlist path emits NO PATH_SCOPE_EXCEEDED', riskEvt !== undefined && !String(riskEvt.fields.detail).includes('PATH_SCOPE_EXCEEDED'), riskEvt && String(riskEvt.fields.detail));

  const classEvt = (await host.firePreExecute(host.execOf('agent-a', 'delegate', { capabilityClass: 'CYBER_OFFENSIVE', approvalGranted: false }))) && host.eventsNamed('overreach_suspected').at(-1);
  probe('overreach: class in approvalRequiredFor without flag ⇒ event', classEvt !== undefined && String(classEvt.fields.detail).includes('class:CYBER_OFFENSIVE'), classEvt && String(classEvt.fields.detail));
  probe('overreach: detail carries approval-required flag', classEvt !== undefined && String(classEvt.fields.detail).includes('approval:REQUIRED') && String(classEvt.fields.detail).includes('APPROVAL_REQUIRED'), classEvt && String(classEvt.fields.detail));

  await host.firePreExecute(host.execOf('agent-a', 'delegate', { capabilityClass: 'cyber_offensive', approvalGranted: true }));
  const satisfied = host.eventsNamed('overreach_suspected').filter((e) => String(e.fields.detail).includes('approval:REQUIRED'));
  probe('overreach: approvalGranted flag (case-insensitive class) satisfies the gate', satisfied.length === 1, jsonOf(host.eventsNamed('overreach_suspected')));

  const pathEvt = (await host.firePreExecute(host.execOf('agent-a', 'delegate', { requestedPaths: [SECRET_PATH] }))) && host.eventsNamed('overreach_suspected').at(-1);
  probe('overreach: blockedPaths win ⇒ PATH_SCOPE_EXCEEDED with config glob', pathEvt !== undefined && String(pathEvt.fields.detail).includes('PATH_SCOPE_EXCEEDED') && String(pathEvt.fields.detail).includes('**/secrets/**'), pathEvt && String(pathEvt.fields.detail));
  probe('overreach: NO path VALUE in any event (glob name only)', !jsonOf(host.events).includes(SECRET_PATH), 'path value leaked into events');

  await host.firePreExecute(host.execOf('agent-a', 'subagent', { prompt: PROMPT_CANARY }));
  const spawnOver = host.eventsNamed('overreach_suspected').filter((e) => e.fields.tool === 'subagent').at(-1);
  probe('overreach: pinned subagent tool ⇒ delegation-shaped, MEDIUM above LOW', spawnOver !== undefined && String(spawnOver.fields.detail).includes('risk:MEDIUM'), spawnOver && String(spawnOver.fields.detail));
  probe('overreach: NO spawn prompt value in any event', !jsonOf(host.events).includes(PROMPT_CANARY), 'prompt value leaked into events');

  const before = host.eventsNamed('overreach_suspected').length;
  await host.firePreExecute(host.execOf('agent-a', 'search', { q: 'docs' }));
  probe('overreach: ordinary non-delegation call emits nothing', host.eventsNamed('overreach_suspected').length === before, jsonOf(host.eventsNamed('overreach_suspected')));

  const svcVerdict = host.service.evaluateDelegation({ taskClass: 'DEPLOY', riskLevel: 'MEDIUM' });
  probe('overreach: service.evaluateDelegation flags risk+approval', svcVerdict.overreach === true && svcVerdict.reasonCodes.includes('RISK_ABOVE_MAX') && svcVerdict.reasonCodes.includes('APPROVAL_REQUIRED') && svcVerdict.approvalRequired === true, jsonOf(svcVerdict));
  const svcEvt = host.eventsNamed('overreach_suspected').at(-1);
  probe('overreach: service path audits with origin:service', svcEvt !== undefined && String(svcEvt.fields.detail).includes('origin:service') && String(svcEvt.fields.detail).includes('class:DEPLOY'), svcEvt && String(svcEvt.fields.detail));
  host.dispose();
}

// ---------------------------------------------------------------------------
// Probe E — defaults are behavior-preserving: default maxRiskLevel=HIGH keeps
// every in-ceiling request unaudited; empty graph keeps A2A inert.
// ---------------------------------------------------------------------------
console.log('[E] P3/P2 defaults — unchanged behavior when v1.3 keys are omitted');
{
  const host = await mkHost({});
  await host.firePreExecute(host.execOf('agent-a', 'delegate', { requestedTools: ['bash'] }));
  probe('defaults: HIGH request under default ceiling ⇒ no overreach event', host.eventsNamed('overreach_suspected').length === 0, jsonOf(host.eventsNamed('overreach_suspected')));
  await host.firePreExecute(host.execOf('agent-a', 'subagent', { prompt: 'x' }));
  probe('defaults: subagent (MEDIUM) under default ceiling ⇒ no overreach event', host.eventsNamed('overreach_suspected').length === 0, jsonOf(host.eventsNamed('overreach_suspected')));
  await host.firePreExecute(host.execOf('agent-a', 'send_message', { agent_id: 'agent-z', message: 'hi' }));
  probe('defaults: empty contact graph ⇒ A2A policy inert (no a2a_contact)', host.eventsNamed('a2a_contact').length === 0, jsonOf(host.eventsNamed('a2a_contact')));
  probe('defaults: empty graph never blocks', (await host.firePreExecute(host.execOf('agent-a', 'send_message', { agent_id: 'agent-z', message: 'hi' }))).kind === 'allow');
  host.dispose();
}

// ---------------------------------------------------------------------------
// Probe F — v1.3 config keys ARRIVE at the service through the REAL zod Config
// path (v3-review lesson: zod must not strip → break; keys must reach it).
// ---------------------------------------------------------------------------
console.log('[F] v1.3 config keys ARRIVE at the service (real zod resolution)');
{
  const host = await mkHost({
    agentContactPolicy: 'DENY',
    allowedContacts: [{ from: 'agent-a', to: 'agent-b' }, { from: 'router', to: 'planner' }],
    maxRiskLevel: 'MEDIUM',
    approvalRequiredFor: ['DEPLOY'],
  });
  const cfg = host.service.limits();
  probe('arrival: agentContactPolicy', cfg.agentContactPolicy === 'DENY');
  probe('arrival: allowedContacts (deep)', jsonOf(cfg.allowedContacts) === jsonOf([{ from: 'agent-a', to: 'agent-b' }, { from: 'router', to: 'planner' }]), jsonOf(cfg.allowedContacts));
  probe('arrival: maxRiskLevel', cfg.maxRiskLevel === 'MEDIUM');
  probe('arrival: approvalRequiredFor', jsonOf(cfg.approvalRequiredFor) === jsonOf(['DEPLOY']), jsonOf(cfg.approvalRequiredFor));
  probe('arrival: v1.2 keys still intact', cfg.maxConcurrentAgents === 3 && cfg.maxTotalAgents === 12 && cfg.maxDepth === 2 && cfg.requireVerifierPassOnClose === false);
  const minimal = await mkHost({});
  const d = minimal.service.limits();
  probe('arrival: omitted v1.3 keys get behavior-preserving defaults', d.agentContactPolicy === 'LOG_ONLY' && d.maxRiskLevel === 'HIGH' && d.allowedContacts.length === 0 && d.approvalRequiredFor.length === 0);
  minimal.dispose();
  host.dispose();
}

// ---------------------------------------------------------------------------
// Probe G — v1.2 behavior preserved on the same REAL adapter (decide/close/
// path scope unchanged), and clean dispose.
// ---------------------------------------------------------------------------
console.log('[G] v1.2 regression on the mounted adapter + clean dispose');
{
  const host = await mkHost({ requireVerifierPassOnClose: true });
  const decided = host.service.decide({
    complexity: 'simple', parallelizable: false, risk: 'LOW',
    requiresCapabilities: [], availableCapabilities: [], availableProviders: ['spawn'],
    depth: 0, activeAgents: 0, totalAgentsUsed: 0,
  });
  probe('v1.2: decide() simple task still DIRECT', decided.decision === 'DIRECT', jsonOf(decided.decision));
  probe('v1.2: workflow_decision still recorded', host.eventsNamed('workflow_decision').length === 1, jsonOf(host.eventsNamed('workflow_decision')));
  probe('v1.2: canCloseTask HIGH+FAIL still blocks', host.service.canCloseTask({ risk: 'HIGH', verifierStatus: 'FAIL' }).closable === false);
  probe('v1.2: evaluatePathScope blocked-wins semantics intact', host.service.evaluatePathScope('/x').reasonCode === 'NO_PATH_RULES');
  const disposeResult = await host.dispose();
  probe('dispose: clean fiber unload', disposeResult === undefined, jsonOf(disposeResult));
}

// ---------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('----------------------------------------------------------------');
if (failed.length > 0) {
  console.error(`V13 WORKFLOW E2E FAILED: ${failed.length}/${checks.length} probes failed:`);
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log(`all ${checks.length} probes passed (real engine + real pinned-cordis adapter)`);
console.log('V13_WORKFLOW_E2E_COMPLETE');
process.exit(0);
