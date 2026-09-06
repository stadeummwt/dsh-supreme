/**
 * supreme-fake-llm — LAB-ONLY test adapter (Spec §16 LAB: "test-only adapters").
 *
 * Registers a scripted LLM adapter under the provider name `synthetic-free`
 * through the OFFICIAL ctx.llm.registerAdapter() seam
 * (packages/llm/llm/src/index.ts:384 — registerAdapter(providers, adapter)).
 * No network, no credentials, deterministic streamed response.
 *
 * This plugin is a FIXTURE and must never be mounted outside LAB.
 */
import { z } from 'zod';

import '../context-types';
export const name = 'supreme-fake-llm';

export const inject: string[] = ['llm'];

export const Config = z.object({
  provider: z.string().default('synthetic-free'),
  responseText: z.string().default('synthetic response from supreme-fake-llm'),
});

export function apply(ctx: import('@deepseek-ai/cordis').Context, config: z.infer<typeof Config>): void {
  const llm = ctx.llm as unknown as {
    registerAdapter(providers: string[], adapter: unknown): { dispose(): void };
  };

  const adapter = {
    providerRetryPolicy() {
      return undefined; // LlmRuntime consults this during registration
    },
    imageRequestPricing() {
      return undefined;
    },
    providerInfo(provider: string) {
      // Verified against LlmRuntime.prepareRoutes: info.id must equal the
      // provider id and info.name must be non-empty (packages/llm/llm/src).
      return { id: provider, name: 'Synthetic Free (LAB fixture)' };
    },
    async listModels() {
      return [{ provider: config.provider, id: 'synthetic-mini', name: 'Synthetic Mini' }];
    },
    async resolveModel(provider: string, model: string) {
      // reasoning omitted: LlmRuntime rejects empty efforts arrays
      // (INVALID_MODEL_REASONING) — verified in packages/llm/llm/src.
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: 32768 },
      };
    },
    async prepareCall(provider: string, model: string) {
      return { provider, model };
    },
    async *stream() {
      yield { type: 'text', text: config.responseText } as unknown;
      yield { type: 'usage', usage: { input: 10, output: 5 } } as unknown;
    },
  };

  const handle = llm.registerAdapter([config.provider], adapter);
  ctx.effect(() => () => handle.dispose(), 'supreme-fake-llm.unregister');
  ctx.logger.info('supreme-fake-llm registered synthetic provider %s (LAB fixture)', config.provider);
}
