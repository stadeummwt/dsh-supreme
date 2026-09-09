// src/plugins/supreme-fake-llm/index.ts
import { z } from "zod";
var name = "supreme-fake-llm";
var inject = ["llm"];
var Config = z.object({
  provider: z.string().default("synthetic-free"),
  responseText: z.string().default("synthetic response from supreme-fake-llm")
});
function apply(ctx, config) {
  const llm = ctx.llm;
  const adapter = {
    providerRetryPolicy() {
      return;
    },
    imageRequestPricing() {
      return;
    },
    providerInfo(provider) {
      return { id: provider, name: "Synthetic Free (LAB fixture)" };
    },
    async listModels() {
      return [{ provider: config.provider, id: "synthetic-mini", name: "Synthetic Mini" }];
    },
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: 32768 }
      };
    },
    async prepareCall(provider, model) {
      return { provider, model };
    },
    async* stream() {
      yield { type: "text", text: config.responseText };
      yield { type: "usage", usage: { input: 10, output: 5 } };
    }
  };
  const handle = llm.registerAdapter([config.provider], adapter);
  ctx.effect(() => () => handle.dispose(), "supreme-fake-llm.unregister");
  ctx.logger.info("supreme-fake-llm registered synthetic provider %s (LAB fixture)", config.provider);
}
export {
  name,
  inject,
  apply,
  Config
};
