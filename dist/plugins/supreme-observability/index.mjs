// src/plugins/supreme-observability/index.ts
import { z } from "zod";
import { resolve } from "node:path";

// src/plugins/supreme-observability/engine.ts
var RECORD_FIELDS = [
  "seq",
  "ts",
  "event",
  "sessionId",
  "turn",
  "step",
  "provider",
  "model",
  "latencyMs",
  "ttftMs",
  "tool",
  "toolError",
  "subagent",
  "workflow",
  "compaction",
  "tokenPressure",
  "usageIn",
  "usageOut",
  "errorClass",
  "verificationId",
  "verificationStatus",
  "routeDecisionId",
  "benchmarkRunId",
  "workflowDecisionId",
  "detail"
];
function buildRecord(seq, ts, event, fields) {
  const record = { seq, ts, event };
  const bound = (v, max = 256) => {
    if (v === undefined || v === null)
      return;
    if (typeof v === "string") {
      const scrubbed = v.replace(/SECRET_SENTINEL[A-Z0-9_]*/g, "[REDACTED]");
      return scrubbed.length > max ? scrubbed.slice(0, max) : scrubbed;
    }
    if (typeof v === "number" && Number.isFinite(v))
      return v;
    if (typeof v === "boolean")
      return v;
    return;
  };
  for (const key of RECORD_FIELDS) {
    if (key === "seq" || key === "ts" || key === "event")
      continue;
    const value = bound(fields[key]);
    if (value !== undefined)
      record[key] = value;
  }
  return record;
}
function serializeRecord(record, maxLineChars) {
  let line = JSON.stringify(record);
  if (line.length > maxLineChars) {
    line = JSON.stringify({ ...record, detail: "<truncated>" }).slice(0, maxLineChars - 1);
  }
  return line;
}

class JsonlWriter {
  path;
  rotatePath;
  maxFileBytes;
  maxLineChars;
  fsImpl;
  queue = Promise.resolve();
  stats = { written: 0, dropped: 0, rotations: 0, lastWriteError: null };
  disposed = false;
  constructor(path, rotatePath, maxFileBytes, maxLineChars, fsImpl) {
    this.path = path;
    this.rotatePath = rotatePath;
    this.maxFileBytes = maxFileBytes;
    this.maxLineChars = maxLineChars;
    this.fsImpl = fsImpl;
  }
  get filePath() {
    return this.path;
  }
  getStats() {
    return { ...this.stats };
  }
  write(record) {
    if (this.disposed) {
      this.stats.dropped++;
      return;
    }
    const line = serializeRecord(record, this.maxLineChars) + `
`;
    this.queue = this.queue.then(async () => {
      await this.fsImpl.mkdir(this.dirOf());
      const stat = await this.fsImpl.stat(this.path).catch(() => null);
      if (stat && stat.size + line.length > this.maxFileBytes) {
        await this.fsImpl.rename(this.path, this.rotatePath).catch(() => {
          return;
        });
        this.stats.rotations++;
      }
      await this.fsImpl.appendFile(this.path, line);
      this.stats.written++;
    }).catch((err) => {
      this.stats.dropped++;
      this.stats.lastWriteError = err instanceof Error ? err.message : String(err);
    });
  }
  async flush() {
    await this.queue.catch(() => {
      return;
    });
    return this.getStats();
  }
  dispose() {
    this.disposed = true;
    return this.flush();
  }
  dirOf() {
    const idx = this.path.lastIndexOf("/");
    return idx > 0 ? this.path.slice(0, idx) : ".";
  }
}
async function readRecent(path, count, fsImpl) {
  const raw = await fsImpl.readFile(path).catch(() => null);
  if (!raw)
    return [];
  const lines = raw.split(`
`).filter((l) => l.length > 0);
  const out = [];
  for (const line of lines.slice(-count)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.event === "string")
        out.push(parsed);
    } catch {}
  }
  return out;
}

// src/plugins/supreme-observability/event-map.ts
function classifyError(input) {
  if (input && typeof input === "object") {
    const rec = input;
    const name = typeof rec.name === "string" ? rec.name : undefined;
    const code = typeof rec.code === "string" ? rec.code : undefined;
    if (code)
      return code.slice(0, 64);
    if (name)
      return name.slice(0, 64);
    const failure = rec.failure;
    if (failure && typeof failure === "object")
      return classifyError(failure);
  }
  return "UNKNOWN";
}

// src/plugins/supreme-observability/index.ts
var name = "supreme-observability";
var inject = [];
var Config = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default("dsh-supreme/data/observability"),
  fileName: z.string().default("observability.jsonl"),
  maxFileBytes: z.number().int().min(1e4).default(5000000),
  maxLineChars: z.number().int().min(256).default(2048)
});
function apply(ctx, config) {
  const observed = { ...config };
  let seq = 0;
  let writer = null;
  let fileWriter = true;
  if (observed.enabled) {
    const fs = process.getBuiltinModule("node:fs").promises;
    const filePath = resolve(observed.dataDir, observed.fileName);
    writer = new JsonlWriter(filePath, filePath + ".1", observed.maxFileBytes, observed.maxLineChars, {
      appendFile: (p, d) => fs.appendFile(p, d, "utf8"),
      stat: async (p) => {
        const s = await fs.stat(p);
        return { size: s.size };
      },
      rename: (f, t) => fs.rename(f, t),
      mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {
        return;
      })
    });
    ctx.logger.info("supreme-observability writing to %s", filePath);
  } else {
    fileWriter = false;
    ctx.logger.info("supreme-observability disabled — no-op mode");
  }
  const emit = (event, fields) => {
    if (!writer)
      return;
    seq += 1;
    writer.write(buildRecord(seq, Date.now(), event, fields));
  };
  const disposers = [];
  disposers.push(ctx.on("session/created", (session) => {
    emit("session_started", { sessionId: String(session.id) });
  }));
  disposers.push(ctx.on("session/disposed", (session) => {
    emit("session_ended", { sessionId: String(session.id) });
  }));
  disposers.push(ctx.on("session/event", (session, event) => {
    const sessionId = String(session.id);
    switch (event.type) {
      case "turn/start":
      case "turn/end":
      case "step/start":
      case "step/end": {
        const d = event.data;
        emit(event.type.replace("/", "_"), {
          sessionId,
          turn: "turn" in d ? d.turn : undefined,
          step: "step" in d ? d.step : undefined
        });
        break;
      }
      case "tool/call": {
        const d = event.data;
        emit("tool_call", {
          sessionId,
          turn: d.turn,
          step: d.step,
          tool: d.name
        });
        break;
      }
      case "tool/result": {
        const d = event.data;
        emit("tool_result", {
          sessionId,
          turn: d.turn,
          step: d.step,
          toolError: d.error !== undefined,
          errorClass: d.error ? classifyError(d.error) : undefined
        });
        break;
      }
      case "assistant/message": {
        const d = event.data;
        emit("assistant_message", {
          sessionId,
          turn: d.turn,
          step: d.step,
          usageIn: d.usage?.inputTokens,
          usageOut: d.usage?.outputTokens
        });
        break;
      }
      case "request/context": {
        emit("request_context", {
          sessionId,
          provider: event.data.provider,
          model: event.data.model
        });
        break;
      }
      case "compaction/start":
        emit("compaction_started", { sessionId, detail: "compaction" });
        break;
      case "compaction/end":
        emit("compaction_ended", {
          sessionId,
          errorClass: event.data.error ? classifyError(event.data.error) : undefined
        });
        break;
      default:
        break;
    }
  }));
  disposers.push(ctx.on("agent/request", async (payload, next) => {
    const started = Date.now();
    const call = await next();
    emit("llm_request", {
      sessionId: payload.agent?.session ? String(payload.agent.session.id) : undefined,
      turn: payload.turn,
      step: payload.step,
      provider: call.provider,
      model: call.model,
      latencyMs: Date.now() - started
    });
    return call;
  }));
  disposers.push(ctx.on("agent/request-error", (payload, next) => next().then((action) => {
    emit("llm_request_error", {
      provider: payload.provider,
      turn: payload.turn,
      step: payload.step,
      errorClass: classifyError(payload.failure)
    });
    return action;
  })));
  disposers.push(ctx.on("tools/execute", async (exec, next) => {
    const started = Date.now();
    const result = await next();
    emit("tool_executed", {
      tool: exec.name,
      latencyMs: Date.now() - started,
      toolError: result.isError === true
    });
    return result;
  }));
  disposers.push(ctx.on("subagent/start", (info) => {
    emit("subagent_started", {
      subagent: safeName(info),
      sessionId: sessionIdOf(info)
    });
  }));
  disposers.push(ctx.on("subagent/end", (info) => {
    emit("subagent_ended", { subagent: safeName(info), sessionId: sessionIdOf(info) });
  }));
  disposers.push(ctx.on("workflow/start", (info) => {
    emit("workflow_started", { workflow: safeName(info) });
  }));
  disposers.push(ctx.on("workflow/end", (info) => {
    emit("workflow_ended", { workflow: safeName(info) });
  }));
  const service = {
    isEnabled: () => fileWriter,
    record: (event, fields) => emit(event, fields),
    stats: () => ({
      written: writer?.getStats().written ?? 0,
      dropped: writer?.getStats().dropped ?? 0,
      rotations: writer?.getStats().rotations ?? 0,
      seq
    }),
    recent: async (count) => {
      if (!writer)
        return [];
      const fs = process.getBuiltinModule("node:fs").promises;
      return readRecent(writer.filePath, count, {
        readFile: async (p) => {
          try {
            return await fs.readFile(p, "utf8");
          } catch {
            return null;
          }
        }
      });
    }
  };
  ctx.provide("supremeObservability", Object.freeze(service));
  ctx.effect(() => {
    return () => {
      return writer?.dispose().then((stats) => {
        if (stats && stats.dropped > 0) {
          ctx.logger.warn("observability flushed with %d dropped records", stats.dropped);
        }
      });
    };
  }, "supreme-observability.flush");
}
function safeName(info) {
  if (info && typeof info === "object") {
    const rec = info;
    if (typeof rec.label === "string")
      return rec.label.slice(0, 128);
    if (typeof rec.name === "string")
      return rec.name.slice(0, 128);
    if (typeof rec.id === "string")
      return rec.id.slice(0, 128);
    if (typeof rec.meta === "object" && rec.meta !== null) {
      const meta = rec.meta;
      if (typeof meta.name === "string")
        return meta.name.slice(0, 128);
    }
  }
  return;
}
function sessionIdOf(info) {
  if (info && typeof info === "object") {
    const rec = info;
    if (typeof rec.sessionId === "string")
      return rec.sessionId.slice(0, 128);
    if (typeof rec.parentSessionId === "string")
      return rec.parentSessionId.slice(0, 128);
  }
  return;
}
export {
  name,
  inject,
  apply,
  Config
};
