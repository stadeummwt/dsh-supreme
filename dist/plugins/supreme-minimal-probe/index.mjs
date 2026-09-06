// dsh-supreme/src/plugins/supreme-minimal-probe/index.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
var name = "supreme-minimal-probe";
var inject = [];
var Config = z.object({
  markerPath: z.string().default("dsh-supreme/data/real/minimal-probe.markers.jsonl"),
  label: z.string().default("minimal")
});
function apply(ctx, config) {
  const markerPath = resolve(config.markerPath);
  const write = (event) => {
    mkdirSync(dirname(markerPath), { recursive: true });
    appendFileSync(markerPath, JSON.stringify({ event, label: config.label, ts: Date.now() }) + `
`);
  };
  ctx.effect(() => {
    write("MINIMAL_PLUGIN_LOAD");
    write("MINIMAL_PLUGIN_OBSERVABLE_EFFECT");
    return () => {
      write("MINIMAL_PLUGIN_DISPOSE");
    };
  }, "supreme-minimal-probe.markers");
  ctx.logger.info("supreme-minimal-probe active (label=%s)", config.label);
}
export {
  name,
  inject,
  apply,
  Config
};
