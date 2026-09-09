/**
 * dsh-supreme/suite/schema-contract — single source of truth for the published
 * JSON Schemas (schemas/*.json) and the runtime schema-sync checks.
 *
 * The suite check in runner.ts asserts BOTH directions:
 *  1. a generated SuiteReport carries every required field below;
 *  2. each schemas/*.json file exists, parses, and its `required` arrays match
 *     these constants — so the published schema and the code cannot drift.
 */

export const SUITE_REPORT_REQUIRED_TOP_LEVEL = [
  'generatedAt',
  'upstream',
  'realLoader',
  'minimalGate',
  'plugins',
  'compositions',
  'security',
  'performance',
  'configHygiene',
  'pinnedRefs',
  'sixSurfaceAudit',
  'schemas',
  'verdict',
  'blockingGates',
] as const;

export const SUITE_REPORT_REQUIRED_V12_BLOCKS: Record<string, string[]> = {
  configHygiene: ['ok', 'files'],
  pinnedRefs: ['ok', 'refs'],
  sixSurfaceAudit: [],
  schemas: ['ok', 'checked'],
};

export const SIX_SURFACE_NAMES = [
  'prompts',
  'hooks',
  'mcp',
  'permissions',
  'secrets',
  'agent_files',
] as const;

export type SixSurfaceName = (typeof SIX_SURFACE_NAMES)[number];

/** Benchmark JSONL record required fields per kind (schemas/benchmark-record.schema.json). */
export const BENCHMARK_RECORD_REQUIRED: Record<'task' | 'run' | 'score', string[]> = {
  task: ['schemaVersion', 'kind', 'taskId', 'category', 'createdAt'],
  run: ['schemaVersion', 'kind', 'runId', 'taskId', 'provider', 'model', 'profile', 'startedAt'],
  score: ['schemaVersion', 'kind', 'runId', 'qualityScore', 'scoredAt'],
};

/** Ledger note required fields (schemas/ledger-note.schema.json). */
export const LEDGER_NOTE_REQUIRED = [
  'id',
  'text',
  'tags',
  'priority',
  'confidence',
  'createdAt',
  'source',
] as const;

export const SCHEMA_FILES = [
  'suite-report.schema.json',
  'benchmark-record.schema.json',
  'ledger-note.schema.json',
] as const;
