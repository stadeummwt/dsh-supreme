#!/usr/bin/env bun
/**
 * dsh-supreme/real/v131-a2a-falsepositive.mjs — FIX-D probe (v1.3.1 review P2).
 *
 * Issue under test (external review of v1.3.0):
 *   "In src/plugins/supreme-workflow-policy/index.ts, ORDINARY tools whose
 *    arguments happen to be named target/to/agent_id can be misclassified as
 *    inter-agent communication. Probe: a normal copy_file tool call with
 *    argument target=b.txt gets BLOCKED as A2A contact."
 *
 * Root cause: the v1.3.0 tools/pre-execute listener extracted an A2A
 * recipient from ANY tool call whose arguments carried agent_id/to/target —
 * tool identity was never established first, so `copy_file { target: 'b.txt' }`
 * was treated as inter-agent contact.
 *
 * Two modes:
 *   bun real/v131-a2a-falsepositive.mjs repro    — demonstrate the bug on the
 *       CURRENT tree: copy_file with target=b.txt gets an A2A deny/audit
 *       (false positive). Exit 0 + V131_A2A_BUG_REPRODUCED when observed.
 *   bun real/v131-a2a-falsepositive.mjs verify   — acceptance after the fix
 *       (must FAIL on the original code). Exit 0 + V131_A2A_FIX_VERIFIED only
 *       when every probe passes.
 *
 * Like real/v13-workflow-verify.mjs, this exercises the REAL code:
 *   - the REAL engine (src/plugins/supreme-workflow-policy/engine.ts);
 *   - the REAL Cordis adapter mounted on the REAL pinned cordis
 *     (@deepseek-ai/cordis) with the zod Config resolved BEFORE apply;
 *   - the REAL pinned seams: tools/pre-execute waterfall (the pre-fact DENY
 *     seam) and the emit-mode subagent/start + workflow/agent-start events,
 *     with a stub supremeObservability capturing every audit event.
 *
 * NO upstream file is modified. No new dependencies. Deterministic only.
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
const MESSAGE_CANARY = 'V131_A2A_SECRET_PAYLOAD_canary_42';
const PROMPT_CANARY = 'V131_SPAWN_PROMPT_canary_42';
const FILE_VALUE = 'b.txt';
const FILE_PATH_VALUE = 'build/out/x.txt';

// ---------------------------------------------------------------------------
// Harness: mount the REAL adapter on the REAL pinned cordis with stub service
// slots and a stub supremeObservability that captures every audit event.
// Identical mounting pattern to real/v13-workflow-verify.mjs.
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
  // The waterfall `next()` stub stands in for "the tool actually executes" —
  // a deny that skips next() happens BEFORE the action executes.
  let executedCount = 0;
  const firePreExecute = async (exec) => {
    const decision = await root.events.waterfall('tools/pre-execute', exec, () => {
      executedCount += 1;
      return Promise.resolve({ kind: 'allow' });
    });
    return { decision, executed: executedCount > 0 && decision.kind !== 'deny' };
  };
  const resetExecuted = () => { executedCount = 0; };
  // REAL pinned emit events (subagent SubagentRunInfo / workflow RunInfo+AgentInfo).
  const emitSubagentStart = (info) => root.emit('subagent/start', info);
  const emitWorkflowAgentStart = (info, agent) => root.emit('workflow/agent-start', info, agent);
  const eventsNamed = (name) => events.filter((e) => e.event === name);
  const dispose = () => root.fiber.dispose();
  return { root, service, events, eventsNamed, execOf, firePreExecute, resetExecuted, emitSubagentStart, emitWorkflowAgentStart, dispose };
};

const engine = await import(engineHref);
const mode = process.argv[2] ?? 'verify';

// ---------------------------------------------------------------------------
// Mode: repro — demonstrate the v1.3.0 false positive on the CURRENT tree.
// ---------------------------------------------------------------------------
if (mode === 'repro') {
  console.log('== FIX-D repro — copy_file { target } misclassified as A2A contact ==');
  const host = await mkHost({
    agentContactPolicy: 'DENY',
    allowedContacts: [{ from: 'agent-a', to: 'agent-b' }],
  });
  host.resetExecuted();
  const { decision, executed } = await host.firePreExecute(
    host.execOf('agent-a', 'copy_file', { source: 'a.txt', target: FILE_VALUE }),
  );
  const a2aOnCopy = host.eventsNamed('a2a_contact').filter((e) => e.fields.tool === 'copy_file');
  console.log(`  copy_file decision : ${jsonOf(decision)}`);
  console.log(`  action executed    : ${executed}`);
  console.log(`  a2a_contact events : ${jsonOf(a2aOnCopy)}`);
  const misclassified = decision.kind === 'deny' || a2aOnCopy.length > 0;
  host.dispose();
  if (misclassified) {
    console.log('V131_A2A_BUG_REPRODUCED — ordinary copy_file tool call treated as A2A contact');
    process.exit(0);
  }
  console.log('V131_A2A_BUG_NOT_REPRODUCED — current tree no longer misclassifies copy_file');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Mode: verify — acceptance. Must FAIL on the original (v1.3.0) code.
// ---------------------------------------------------------------------------
console.log('== v1.3.1 A2A fix verify — REAL engine + REAL pinned-cordis adapter ==');

// Guard: the acceptance suite needs the v1.3.1 engine surface. On the ORIGINAL
// (v1.3.0) code these exports do not exist — fail cleanly instead of crashing.
const FIX_EXPORTS = ['DEFAULT_COMMS_TOOL_REGISTRY', 'buildCommsToolRegistry', 'isCommunicationTool', 'commsChannelOf', 'inferCommsChannel', 'unresolvableRecipientDecision', 'A2A_RECIPIENT_UNRESOLVABLE_REASON'];
const missingExports = FIX_EXPORTS.filter((k) => typeof engine[k] === 'undefined');
if (missingExports.length > 0) {
  console.error(`V131 A2A FIX VERIFY FAILED: engine is missing the v1.3.1 fix surface: ${missingExports.join(', ')}`);
  console.error('(this is the expected outcome on the ORIGINAL v1.3.0 code — the fix is not applied)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// [0] Engine level — trusted communication-tool registry (tool identity FIRST).
// ---------------------------------------------------------------------------
console.log('[0] engine: trusted comms-tool registry (identity first, config-extended)');
{
  probe('engine: DEFAULT_COMMS_TOOL_REGISTRY exported as a deterministic list', Array.isArray(engine.DEFAULT_COMMS_TOOL_REGISTRY) && engine.DEFAULT_COMMS_TOOL_REGISTRY.length > 0);
  const pairs = new Map(engine.DEFAULT_COMMS_TOOL_REGISTRY);
  probe('engine: pinned spawn tool subagent => spawn channel', pairs.get('subagent') === 'spawn');
  probe('engine: pinned steering tool send_message => message channel', pairs.get('send_message') === 'message');
  probe('engine: task-delegation style names present (task, delegate, task_delegation)', pairs.get('task') === 'spawn' && pairs.get('delegate') === 'spawn' && pairs.get('task_delegation') === 'spawn');
  probe('engine: ORDINARY tools are NOT in the registry (copy_file, write, read, bash)', !pairs.has('copy_file') && !pairs.has('write') && !pairs.has('read') && !pairs.has('bash') && !pairs.has('search'));

  const reg = engine.buildCommsToolRegistry();
  probe('engine: isCommunicationTool true for registry names (exact, case-insensitive)', engine.isCommunicationTool(reg, 'send_message') && engine.isCommunicationTool(reg, '  Subagent ') && engine.isCommunicationTool(reg, 'SEND_MESSAGE'));
  probe('engine: isCommunicationTool false for ordinary tools and empty names', !engine.isCommunicationTool(reg, 'copy_file') && !engine.isCommunicationTool(reg, '') && !engine.isCommunicationTool(reg, undefined) && !engine.isCommunicationTool(reg, 42));
  probe('engine: commsChannelOf resolves the fixed channel per registry entry', engine.commsChannelOf(reg, 'subagent') === 'spawn' && engine.commsChannelOf(reg, 'send_message') === 'message');

  const ext = engine.buildCommsToolRegistry(['desk_pager', ' Team_Spawn ']);
  probe('engine: config extension adds custom names deterministically', engine.isCommunicationTool(ext, 'desk_pager') && engine.isCommunicationTool(ext, 'team_spawn'));
  probe('engine: config extension infers channel by fixed token rule (spawn/delegate/subagent/workflow)', engine.commsChannelOf(ext, 'team_spawn') === 'spawn' && engine.commsChannelOf(ext, 'desk_pager') === 'message' && engine.inferCommsChannel('workflow_kick') === 'spawn' && engine.inferCommsChannel('subagent_pool') === 'spawn');
  probe('engine: extension does not shadow the default registry', engine.commsChannelOf(ext, 'subagent') === 'spawn' && engine.commsChannelOf(ext, 'send_message') === 'message');
  probe('engine: default registry unchanged by extension', !engine.isCommunicationTool(reg, 'desk_pager'));

  probe('engine: A2A_RECIPIENT_UNRESOLVABLE_REASON exported', engine.A2A_RECIPIENT_UNRESOLVABLE_REASON === 'a2a_recipient_unresolvable');
  const unresolvedDeny = engine.unresolvableRecipientDecision({ agentContactPolicy: 'DENY' }, 'message');
  const unresolvedLog = engine.unresolvableRecipientDecision({ agentContactPolicy: 'LOG_ONLY' }, 'message');
  probe('engine: unresolvableRecipientDecision flags always, blocks iff DENY', unresolvedDeny.flagged && unresolvedDeny.blocked && unresolvedLog.flagged && !unresolvedLog.blocked && unresolvedDeny.reasonCode === 'A2A_RECIPIENT_UNRESOLVABLE');

  // Original A2A graph semantics unchanged (v1.3.0 contract).
  const inert = engine.evaluateAgentContact({ agentContactPolicy: 'DENY', allowedContacts: [] }, { from: 'a', to: 'b', channel: 'message' });
  probe('engine: graph semantics preserved — empty graph inert', inert.flagged === false && inert.reasonCode === 'NO_CONTACT_GRAPH');
  const denied = engine.evaluateAgentContact({ agentContactPolicy: 'DENY', allowedContacts: [{ from: 'a', to: 'b' }] }, { from: 'a', to: 'c' });
  probe('engine: graph semantics preserved — out-of-graph blocked under DENY', denied.flagged && denied.blocked);
  const inGraph = engine.evaluateAgentContact({ agentContactPolicy: 'DENY', allowedContacts: [{ from: ' a ', to: 'b' }] }, { from: 'a', to: ' b ' });
  probe('engine: graph semantics preserved — trimmed directed edge matches', inGraph.flagged === false && inGraph.reasonCode === 'CONTACT_IN_GRAPH');

  // commsToolNames arrives through validateWorkflowLimits (engine-side key).
  const limits = engine.validateWorkflowLimits({ commsToolNames: ['desk_pager'] });
  probe('engine: commsToolNames validates and round-trips', Array.isArray(limits.commsToolNames) && limits.commsToolNames[0] === 'desk_pager');
  probe('engine: commsToolNames default empty (behavior-preserving)', engine.WORKFLOW_LIMIT_DEFAULTS.commsToolNames.length === 0);
  let rejected = false;
  try { engine.validateWorkflowLimits({ commsToolNames: [''] }); } catch (e) { rejected = e instanceof engine.WorkflowConfigError; }
  probe('engine: empty commsToolNames entry rejected', rejected);
}

// ---------------------------------------------------------------------------
// [A] Adapter, DENY policy — (a) ordinary file tools pass untouched;
// (b) allowed contact succeeds; (c) forbidden contact denied PRE-FACT.
// ---------------------------------------------------------------------------
console.log('[A] adapter DENY — ordinary tools untouched, real contacts still enforced pre-fact');
{
  const host = await mkHost({
    agentContactPolicy: 'DENY',
    allowedContacts: [
      { from: 'agent-a', to: 'agent-b' },
      { from: 'provider:spawn', to: 'child-ok' },
      { from: 'workflow:etl', to: 'wf-child-ok' },
    ],
  });

  // (a) Ordinary file tools: recipient-looking arg names must NOT trigger A2A.
  host.resetExecuted();
  const copyCall = await host.firePreExecute(host.execOf('agent-a', 'copy_file', { source: 'a.txt', target: FILE_VALUE }));
  probe('a: copy_file { target } passes untouched (the v1.3.0 false positive)', copyCall.decision.kind === 'allow' && copyCall.executed === true, jsonOf(copyCall.decision));
  probe('a: copy_file emits NO a2a_contact', host.eventsNamed('a2a_contact').length === 0, jsonOf(host.eventsNamed('a2a_contact')));
  probe('a: NO file value in any event', !jsonOf(host.events).includes(FILE_VALUE), 'file value leaked');
  const writeCall = await host.firePreExecute(host.execOf('agent-a', 'write', { path: FILE_PATH_VALUE, to: 'x' }));
  probe('a: write { path, to } passes untouched', writeCall.decision.kind === 'allow' && writeCall.executed === true);
  const sendishCall = await host.firePreExecute(host.execOf('agent-a', 'copy_file', { agent_id: FILE_VALUE }));
  probe('a: copy_file with an agent_id-named ARG passes untouched (arg names are not identity)', sendishCall.decision.kind === 'allow' && host.eventsNamed('a2a_contact').length === 0, jsonOf(host.eventsNamed('a2a_contact')));
  probe('a: NO file/path value in any event', !jsonOf(host.events).includes(FILE_PATH_VALUE));

  // (b) ALLOWED agent contact — in-graph message succeeds, no audit noise.
  const allowed = await host.firePreExecute(host.execOf('agent-a', 'send_message', { agent_id: 'agent-b', message: MESSAGE_CANARY }));
  probe('b: in-graph send_message succeeds', allowed.decision.kind === 'allow' && allowed.executed === true, jsonOf(allowed.decision));
  probe('b: in-graph contact emits NO a2a_contact', host.eventsNamed('a2a_contact').length === 0, jsonOf(host.eventsNamed('a2a_contact')));

  // (c) FORBIDDEN contact — denied BEFORE the action executes (pre-execute seam).
  host.resetExecuted();
  const forbidden = await host.firePreExecute(host.execOf('agent-a', 'send_message', { agent_id: 'agent-c', message: MESSAGE_CANARY }));
  probe('c: out-of-graph send_message DENIED pre-fact', forbidden.decision.kind === 'deny' && forbidden.executed === false, jsonOf(forbidden.decision));
  probe('c: deny reason carries a2a_contact_denied', forbidden.decision.kind === 'deny' && String(forbidden.decision.reason).includes('a2a_contact_denied'), forbidden.decision && String(forbidden.decision.reason));
  probe('c: deny reason carries NO ids or values', forbidden.decision.kind === 'deny' && !String(forbidden.decision.reason).includes('agent-c') && !String(forbidden.decision.reason).includes(MESSAGE_CANARY));
  const denyEvt = host.eventsNamed('a2a_contact').at(-1);
  probe('c: blocked contact audited with outcome DENIED on tools_pre_execute', denyEvt !== undefined && String(denyEvt.fields.detail).includes('outcome:DENIED') && String(denyEvt.fields.detail).includes('origin:tools_pre_execute'), denyEvt && String(denyEvt.fields.detail));

  // (c) spawn channel still enforced pre-fact for registry spawn tools.
  const spawnDenied = await host.firePreExecute(host.execOf('agent-a', 'subagent', { target: 'agent-c', prompt: PROMPT_CANARY }));
  probe('c: out-of-graph spawn (pinned subagent tool) DENIED pre-fact', spawnDenied.decision.kind === 'deny' && String(spawnDenied.decision.reason).includes('a2a_contact_denied'), jsonOf(spawnDenied.decision));
  const spawnEvt = host.eventsNamed('a2a_contact').filter((e) => String(e.fields.detail).includes('channel:spawn')).at(-1);
  probe('c: spawn-channel audit recorded with pinned tool name', spawnEvt !== undefined && spawnEvt.fields.tool === 'subagent', spawnEvt && jsonOf(spawnEvt.fields));

  // (d) post-fact spawn emits stay DETECT-only — no deny can originate there.
  host.emitSubagentStart({ runId: 'run-1', provider: 'spawn', id: 'child-x', local: true });
  const subEvt = host.eventsNamed('a2a_contact').filter((e) => e.fields.subagent === 'child-x').at(-1);
  probe('d: subagent/start out-of-graph child audited DETECT-only', subEvt !== undefined && String(subEvt.fields.detail).includes('outcome:DETECTED') && String(subEvt.fields.detail).includes('origin:subagent_start'), subEvt && String(subEvt.fields.detail));
  host.emitSubagentStart({ runId: 'run-2', provider: 'spawn', id: 'child-ok', local: true });
  probe('d: declared provider→child edge untouched', host.eventsNamed('a2a_contact').filter((e) => e.fields.subagent === 'child-ok').length === 0);
  host.emitWorkflowAgentStart({ id: 'wfr-1', meta: { name: 'etl' } }, { seq: 1, label: 'worker', childId: 'child-y' });
  const wfEvt = host.eventsNamed('a2a_contact').filter((e) => e.fields.workflow === 'etl').at(-1);
  probe('d: workflow/agent-start out-of-graph child audited DETECT-only', wfEvt !== undefined && String(wfEvt.fields.detail).includes('outcome:DETECTED') && String(wfEvt.fields.detail).includes('origin:workflow_agent_start'), wfEvt && String(wfEvt.fields.detail));
  const postFactDenied = host.eventsNamed('a2a_contact').filter((e) => {
    const d = String(e.fields.detail);
    return d.includes('outcome:DENIED') && (d.includes('origin:subagent_start') || d.includes('origin:workflow_agent_start'));
  });
  probe('d: NO deny ever originates from the emit seams (detect/audit only)', postFactDenied.length === 0, jsonOf(postFactDenied));
  probe('d: NO message/prompt values in ANY event', !jsonOf(host.events).includes(MESSAGE_CANARY) && !jsonOf(host.events).includes(PROMPT_CANARY));

  host.dispose();
}

// ---------------------------------------------------------------------------
// [B] Malformed communication calls — explicit a2a_recipient_unresolvable,
// no crash, no silent pass; ordinary tools never inspected for recipients.
// ---------------------------------------------------------------------------
console.log('[B] malformed comms calls — explicit reason, fail-closed under DENY');
{
  const host = await mkHost({
    agentContactPolicy: 'DENY',
    allowedContacts: [{ from: 'agent-a', to: 'agent-b' }],
  });
  host.resetExecuted();
  let crashed = false;
  let malformed;
  try {
    malformed = await host.firePreExecute(host.execOf('agent-a', 'send_message', { message: MESSAGE_CANARY }));
  } catch (err) { crashed = true; }
  probe('e: malformed send_message (no recipient) does not crash', crashed === false);
  probe('e: malformed send_message denied pre-fact under DENY (no silent pass)', malformed && malformed.decision.kind === 'deny' && malformed.executed === false, malformed && jsonOf(malformed.decision));
  probe('e: deny reason carries a2a_recipient_unresolvable', malformed && malformed.decision.kind === 'deny' && String(malformed.decision.reason).includes('a2a_recipient_unresolvable'), malformed && String(malformed.decision.reason));
  const uEvt = host.eventsNamed('a2a_contact').at(-1);
  probe('e: audit carries reason:A2A_RECIPIENT_UNRESOLVABLE + pinned tool name', uEvt !== undefined && String(uEvt.fields.detail).includes('reason:A2A_RECIPIENT_UNRESOLVABLE') && uEvt.fields.tool === 'send_message', uEvt && jsonOf(uEvt.fields));
  probe('e: NO message value in any event', !jsonOf(host.events).includes(MESSAGE_CANARY));
  // Empty-string and whitespace recipients are equally unresolvable.
  const blank = await host.firePreExecute(host.execOf('agent-a', 'send_message', { agent_id: '   ' }));
  probe('e: blank recipient treated the same (explicit reason, no crash)', blank.decision.kind === 'deny' && String(blank.decision.reason).includes('a2a_recipient_unresolvable'), jsonOf(blank.decision));
  // Spawn without a declared target is the NORMAL pinned shape (childId is
  // assigned post-fact) — not malformed; the DETECT-only emit audit covers it.
  host.resetExecuted();
  const bareSpawn = await host.firePreExecute(host.execOf('agent-a', 'subagent', { prompt: PROMPT_CANARY }));
  probe('e: bare spawn (no target) is NOT malformed — post-fact detect covers spawns', bareSpawn.decision.kind === 'allow' && bareSpawn.executed === true, jsonOf(bareSpawn.decision));
  host.dispose();

  // Same malformed call under LOG_ONLY: audited, allowed, never silent.
  const logHost = await mkHost({
    agentContactPolicy: 'LOG_ONLY',
    allowedContacts: [{ from: 'agent-a', to: 'agent-b' }],
  });
  const logged = await logHost.firePreExecute(logHost.execOf('agent-a', 'send_message', {}));
  probe('e: LOG_ONLY audits malformed call without blocking', logged.decision.kind === 'allow' && logHost.eventsNamed('a2a_contact').some((e) => String(e.fields.detail).includes('reason:A2A_RECIPIENT_UNRESOLVABLE') && String(e.fields.detail).includes('outcome:LOGGED')), jsonOf(logHost.eventsNamed('a2a_contact')));
  logHost.dispose();
}

// ---------------------------------------------------------------------------
// [C] Registry extension via config — custom comms names get inspected;
// unregistered tools never do.
// ---------------------------------------------------------------------------
console.log('[C] registry extension via config (commsToolNames)');
{
  // Default registry: a custom comms-style tool is NOT inspected.
  const plain = await mkHost({
    agentContactPolicy: 'DENY',
    allowedContacts: [{ from: 'agent-a', to: 'agent-b' }],
  });
  const uninspected = await plain.firePreExecute(plain.execOf('agent-a', 'desk_pager', { agent_id: 'agent-c', message: MESSAGE_CANARY }));
  probe('f: unregistered custom tool NOT inspected (default registry)', uninspected.decision.kind === 'allow' && plain.eventsNamed('a2a_contact').length === 0, jsonOf(plain.eventsNamed('a2a_contact')));
  plain.dispose();

  // Extended registry: the same tool is now a comms tool and is enforced.
  const extended = await mkHost({
    agentContactPolicy: 'DENY',
    allowedContacts: [{ from: 'agent-a', to: 'agent-b' }],
    commsToolNames: ['desk_pager'],
  });
  probe('f: commsToolNames arrives at the service via real zod resolution', jsonOf(extended.service.limits().commsToolNames) === jsonOf(['desk_pager']));
  const inspected = await extended.firePreExecute(extended.execOf('agent-a', 'desk_pager', { agent_id: 'agent-c', message: MESSAGE_CANARY }));
  probe('f: config-extended comms tool IS inspected and denied out-of-graph', inspected.decision.kind === 'deny' && String(inspected.decision.reason).includes('a2a_contact_denied'), jsonOf(inspected.decision));
  const evt = extended.eventsNamed('a2a_contact').at(-1);
  probe('f: audit carries the custom tool name + message channel', evt !== undefined && evt.fields.tool === 'desk_pager' && String(evt.fields.detail).includes('channel:message'), evt && jsonOf(evt.fields));
  const inGraphExt = await extended.firePreExecute(extended.execOf('agent-a', 'desk_pager', { agent_id: 'agent-b', message: 'hi' }));
  probe('f: extended comms tool in-graph passes untouched', inGraphExt.decision.kind === 'allow' && inGraphExt.executed === true);
  const stillUnregistered = await extended.firePreExecute(extended.execOf('agent-a', 'unlisted_pager', { agent_id: 'agent-c' }));
  probe('f: tool outside default+extended registry still NOT inspected', stillUnregistered.decision.kind === 'allow' && extended.eventsNamed('a2a_contact').filter((e) => e.fields.tool === 'unlisted_pager').length === 0);
  const malformedExt = await extended.firePreExecute(extended.execOf('agent-a', 'desk_pager', {}));
  probe('f: extended comms tool with missing recipient ⇒ explicit reason', malformedExt.decision.kind === 'deny' && String(malformedExt.decision.reason).includes('a2a_recipient_unresolvable'), jsonOf(malformedExt.decision));
  probe('f: NO message value in ANY event', !jsonOf(extended.events).includes(MESSAGE_CANARY));
  extended.dispose();
}

// ---------------------------------------------------------------------------
// [D] v1.2 path-scope semantics unchanged (blocked wins) + LOG_ONLY default.
// ---------------------------------------------------------------------------
console.log('[D] v1.2 path-scope semantics + LOG_ONLY default unchanged');
{
  const host = await mkHost({ allowedPaths: ['src/**'], blockedPaths: ['**/secrets/**'] });
  probe('g: in-allowlist path allowed', host.service.evaluatePathScope('src/app/x.ts').allowed === true);
  const blocked = host.service.evaluatePathScope('src/secrets/k.pem');
  probe('g: blockedPaths WIN over allowedPaths', blocked.allowed === false && blocked.reasonCode === 'PATH_BLOCKED');
  probe('g: outside allowlist refused', host.service.evaluatePathScope('docs/x.md').reasonCode === 'PATH_OUTSIDE_ALLOWED');
  const engineScope = engine.evaluatePathScope({ allowedPaths: ['src/**'], blockedPaths: ['**/secrets/**'] }, 'src/secrets/k.pem');
  probe('g: engine-level scope matches adapter-level', engineScope.allowed === false && engineScope.reasonCode === 'PATH_BLOCKED');
  host.dispose();

  const bare = await mkHost({});
  probe('g: empty rules ⇒ NO_PATH_RULES (never flags)', bare.service.evaluatePathScope('/x').reasonCode === 'NO_PATH_RULES');
  probe('defaults: agentContactPolicy still LOG_ONLY by default', bare.service.limits().agentContactPolicy === 'LOG_ONLY');
  bare.dispose();

  const logHost = await mkHost({ agentContactPolicy: 'LOG_ONLY', allowedContacts: [{ from: 'agent-a', to: 'agent-b' }] });
  const logOut = await logHost.firePreExecute(logHost.execOf('agent-a', 'send_message', { agent_id: 'agent-z', message: 'hi' }));
  probe('defaults: LOG_ONLY keeps out-of-graph call allowed (audit-only)', logOut.decision.kind === 'allow' && logHost.eventsNamed('a2a_contact').length === 1, jsonOf(logHost.eventsNamed('a2a_contact')));
  const logCopy = await logHost.firePreExecute(logHost.execOf('agent-a', 'copy_file', { source: 'a.txt', target: 'b.txt' }));
  probe('defaults: LOG_ONLY never audits ordinary copy_file', logCopy.decision.kind === 'allow' && logHost.eventsNamed('a2a_contact').length === 1, jsonOf(logHost.eventsNamed('a2a_contact')));
  logHost.dispose();
}

// ---------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('----------------------------------------------------------------');
if (failed.length > 0) {
  console.error(`V131 A2A FIX VERIFY FAILED: ${failed.length}/${checks.length} probes failed:`);
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log(`all ${checks.length} probes passed (real engine + real pinned-cordis adapter)`);
console.log('V131_A2A_FIX_VERIFIED');
process.exit(0);
