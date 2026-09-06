/**
 * dsh-supreme — Context type augmentations.
 *
 * Two halves, following the OFFICIAL pinned pattern
 * (packages/core/session/src/index.ts:34-37 — `declare module '@deepseek-ai/cordis'`):
 *
 *  1. DSH native services: importing the real pinned packages (type-only,
 *     erased at runtime) loads their own Context augmentations — ctx.llm,
 *     ctx.sessions, ctx.systemPrompt, ctx.tokenMeter, ctx.subagents,
 *     ctx.workflowEngine, ctx.credentials become fully typed.
 *  2. Supreme services: this repo declares its own services exactly the same
 *     way (supremePolicy … supremeWorkflowPolicy).
 *
 * Import this file once from any adapter that touches typed context services.
 * Type-only imports are erased by the bundler — dist output has zero runtime
 * dependency on the upstream workspace.
 */
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import type { WorkflowEngine } from '@deepseek-ai/dsh-workflow';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
// Compaction merges its log-event vocabulary into SessionEventMap
// (packages/compaction/compaction/src — declare module '@deepseek-ai/dsh-session/types').
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction';

import type { PolicyService } from './supreme-policy/index';
import type { ObservabilityService } from './supreme-observability/index';
import type { BenchmarkService } from './supreme-benchmark/index';
import type { RouterService } from './supreme-router/index';
import type { VerifierService } from './supreme-verifier/index';
import type { MemoryPolicyService } from './supreme-memory-policy/index';
import type { WorkflowPolicyService } from './supreme-workflow-policy/index';

/** The pinned DSH services the Supreme layer consumes (documentation type). */
export type DshContextServices = {
  llm: LlmRuntime;
  sessions: SessionStore;
  systemPrompt: SystemPrompt;
  tokenMeter: TokenMeter;
  subagents: SubagentRuntime;
  workflowEngine: WorkflowEngine;
  credentials: CredentialProvider;
  compaction: CompactionEngine;
};

declare module '@deepseek-ai/cordis' {
  interface Context {
    supremePolicy: PolicyService;
    supremeObservability: ObservabilityService;
    supremeBenchmark: BenchmarkService;
    supremeRouter: RouterService;
    supremeVerifier: VerifierService;
    supremeMemoryPolicy: MemoryPolicyService;
    supremeWorkflowPolicy: WorkflowPolicyService;
  }
}
