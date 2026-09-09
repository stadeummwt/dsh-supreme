// src/plugins/supreme-boot-probe/index.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
var name = "supreme-boot-probe";
var inject = [];
var Config = z.object({
  markerPath: z.string().default("dsh-supreme/data/real/boot-probe.markers.jsonl")
});
var PROBED_SERVICES = [
  "llm",
  "sessions",
  "systemPrompt",
  "tokenMeter",
  "credentials",
  "subagents",
  "workflowEngine",
  "supremePolicy",
  "supremeObservability",
  "supremeBenchmark",
  "supremeRouter",
  "supremeVerifier",
  "supremeMemoryPolicy",
  "supremeWorkflowPolicy"
];
function apply(ctx, config) {
  const markerPath = resolve(config.markerPath);
  ctx.effect(() => {
    const timer = setTimeout(() => {
      const present = {};
      for (const service of PROBED_SERVICES) {
        present[service] = ctx.get(service) !== undefined;
      }
      mkdirSync(dirname(markerPath), { recursive: true });
      appendFileSync(markerPath, JSON.stringify({ event: "BOOT_PROBE", ts: Date.now(), present }) + `
`);
    }, 600);
    return () => {
      clearTimeout(timer);
    };
  }, "supreme-boot-probe.probe");
}
export {
  name,
  inject,
  apply,
  Config
};
