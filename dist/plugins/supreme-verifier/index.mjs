// dsh-supreme/src/plugins/supreme-verifier/index.ts
import { z } from "zod";
import { resolve as resolvePath } from "node:path";

// dsh-supreme/src/plugins/supreme-verifier/engine.ts
var VALIDATOR_TYPES = [
  "exact-text",
  "regex",
  "json-parse",
  "json-schema",
  "file-exists",
  "file-hash",
  "command-exit",
  "test-suite"
];
var MAX_EVIDENCE_CHARS = 512;
function sanitizeEvidence(evidence, max = MAX_EVIDENCE_CHARS) {
  const scrubbed = evidence.replace(/SECRET_SENTINEL[A-Z0-9_]*/g, "[REDACTED]");
  return scrubbed.length > max ? scrubbed.slice(0, max) : scrubbed;
}
function pathIsAllowed(path, allowedRoots, pathMod) {
  if (allowedRoots.length === 0)
    return false;
  const resolved = pathMod.resolve(path);
  return allowedRoots.some((root) => {
    const r = pathMod.resolve(root);
    return resolved === r || resolved.startsWith(r.endsWith("/") ? r : r + "/");
  });
}
function validateJsonSchemaSubset(value, schema) {
  const issues = [];
  const type = schema.type;
  if (typeof type === "string") {
    const ok = type === "object" && typeof value === "object" && value !== null && !Array.isArray(value) || type === "array" && Array.isArray(value) || type === "string" && typeof value === "string" || type === "number" && typeof value === "number" && Number.isFinite(value) || type === "integer" && typeof value === "number" && Number.isInteger(value) || type === "boolean" && typeof value === "boolean" || type === "null" && value === null;
    if (!ok)
      issues.push(`type expected ${type}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push(`value not in enum`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      issues.push("minLength");
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      issues.push("maxLength");
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))
      issues.push("pattern");
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      issues.push("minimum");
    if (typeof schema.maximum === "number" && value > schema.maximum)
      issues.push("maximum");
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    value.forEach((item, i) => {
      for (const sub of validateJsonSchemaSubset(item, schema.items)) {
        issues.push(`items[${i}]: ${sub}`);
      }
    });
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value;
    const properties = schema.properties ?? {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in obj))
          issues.push(`missing required: ${key}`);
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (key in obj) {
        for (const subIssue of validateJsonSchemaSubset(obj[key], sub)) {
          issues.push(`${key}: ${subIssue}`);
        }
      }
    }
  }
  return issues;
}
async function runValidator(input) {
  const started = Date.now();
  const { spec, config, runtime, pathMod } = input;
  const base = { validatorId: spec.validatorId, type: spec.type };
  const finish = (status, reasonCode, evidence) => ({
    ...base,
    status,
    reasonCode,
    evidence: sanitizeEvidence(evidence),
    durationMs: Date.now() - started
  });
  try {
    switch (spec.type) {
      case "exact-text": {
        const expected = String(spec.config.expected ?? "");
        const actual = input.subject ?? "";
        return actual === expected ? finish("PASS", "OK", "exact match") : finish("FAIL", "EXACT_MISMATCH", `expected ${JSON.stringify(expected.slice(0, 64))}`);
      }
      case "regex": {
        const pattern = String(spec.config.pattern ?? "");
        if (!pattern)
          return finish("ERROR", "SPEC_INVALID", "missing pattern");
        const re = new RegExp(pattern);
        const actual = input.subject ?? "";
        return re.test(actual) ? finish("PASS", "OK", `matched /${pattern.slice(0, 64)}/`) : finish("FAIL", "REGEX_MISMATCH", `no match for /${pattern.slice(0, 64)}/`);
      }
      case "json-parse": {
        const actual = input.subject ?? "";
        try {
          const parsed = JSON.parse(actual);
          return finish("PASS", "OK", `json ok (${Array.isArray(parsed) ? "array" : typeof parsed})`);
        } catch (err) {
          return finish("FAIL", "JSON_PARSE_FAILED", err instanceof Error ? err.message.slice(0, 64) : "parse error");
        }
      }
      case "json-schema": {
        const schema = spec.config.schema;
        if (!schema || typeof schema !== "object")
          return finish("ERROR", "SPEC_INVALID", "missing schema");
        try {
          const parsed = JSON.parse(input.subject ?? "");
          const issues = validateJsonSchemaSubset(parsed, schema);
          return issues.length === 0 ? finish("PASS", "OK", "schema subset ok") : finish("FAIL", "SCHEMA_VIOLATION", issues.slice(0, 3).join("; "));
        } catch (err) {
          return finish("FAIL", "JSON_PARSE_FAILED", err instanceof Error ? err.message.slice(0, 64) : "parse error");
        }
      }
      case "file-exists": {
        const p = String(spec.config.path ?? "");
        if (!p)
          return finish("ERROR", "SPEC_INVALID", "missing path");
        if (!pathIsAllowed(p, config.allowedRoots, pathMod)) {
          return finish("UNAVAILABLE", "PATH_OUTSIDE_ALLOWED_ROOTS", p.slice(0, 64));
        }
        const exists = await runtime.fsExists(p);
        return exists ? finish("PASS", "OK", p.slice(0, 64)) : finish("FAIL", "FILE_MISSING", p.slice(0, 64));
      }
      case "file-hash": {
        const p = String(spec.config.path ?? "");
        const expected = String(spec.config.sha256 ?? "");
        if (!p || !/^[0-9a-f]{64}$/i.test(expected))
          return finish("ERROR", "SPEC_INVALID", "path/sha256 invalid");
        if (!pathIsAllowed(p, config.allowedRoots, pathMod)) {
          return finish("UNAVAILABLE", "PATH_OUTSIDE_ALLOWED_ROOTS", p.slice(0, 64));
        }
        const hash = await runtime.sha256(p);
        if (hash === null)
          return finish("FAIL", "FILE_MISSING", p.slice(0, 64));
        return hash.toLowerCase() === expected.toLowerCase() ? finish("PASS", "OK", `sha256 ${hash.slice(0, 12)}…`) : finish("FAIL", "HASH_MISMATCH", `sha256 ${hash.slice(0, 12)}…`);
      }
      case "command-exit":
      case "test-suite": {
        if (!config.allowCommands || !input.labPolicyConfirmed) {
          return finish("UNAVAILABLE", "COMMAND_EXECUTION_DISABLED", "requires allowCommands + LAB policy");
        }
        const command = String(spec.config.command ?? "");
        const args = Array.isArray(spec.config.args) ? spec.config.args.map(String) : [];
        const cwd = String(spec.config.cwd ?? ".");
        if (!command)
          return finish("ERROR", "SPEC_INVALID", "missing command");
        const res = await runtime.exec(command, args, cwd, config.commandTimeoutMs);
        const expectedCode = spec.config.expectedExit;
        const pass = typeof expectedCode === "number" ? res.code === expectedCode : res.code === 0;
        return pass ? finish("PASS", "OK", `exit=${res.code}`) : finish("FAIL", "EXIT_MISMATCH", `exit=${res.code} stderr=${res.stderr.slice(0, 64)}`);
      }
      default:
        return finish("UNAVAILABLE", "VALIDATOR_TYPE_UNSUPPORTED", String(spec.type));
    }
  } catch (err) {
    return finish("ERROR", "VALIDATOR_EXCEPTION", err instanceof Error ? err.message.slice(0, 64) : String(err));
  }
}

// dsh-supreme/src/plugins/supreme-verifier/index.ts
var VALIDATOR_TYPE_SET = new Set(VALIDATOR_TYPES);
var name = "supreme-verifier";
var inject = ["supremePolicy"];
var Config = z.object({
  allowCommands: z.boolean().default(false),
  allowNetwork: z.boolean().default(false),
  allowedRoots: z.array(z.string()).default([]),
  commandTimeoutMs: z.number().int().min(100).default(30000)
});
function apply(ctx, config) {
  const policy = ctx.supremePolicy;
  const verifierConfig = {
    allowCommands: config.allowCommands,
    allowNetwork: config.allowNetwork,
    allowedRoots: config.allowedRoots.map((r) => resolvePath(r)),
    commandTimeoutMs: config.commandTimeoutMs
  };
  const registry = new Map;
  const runtime = {
    fsExists: async (p) => process.getBuiltinModule("node:fs").existsSync(p),
    fsRead: async (p) => {
      try {
        return await process.getBuiltinModule("node:fs").promises.readFile(p, "utf8");
      } catch {
        return null;
      }
    },
    sha256: async (p) => {
      try {
        const nodeCrypto = process.getBuiltinModule("node:crypto");
        return nodeCrypto.createHash("sha256").update(await process.getBuiltinModule("node:fs").promises.readFile(p)).digest("hex");
      } catch {
        return null;
      }
    },
    exec: (command, args, cwd, timeoutMs) => new Promise((resolveSpawn, rejectSpawn) => {
      const childProcess = process.getBuiltinModule("node:child_process");
      const child = childProcess.spawn(command, args, { cwd, timeout: timeoutMs });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", rejectSpawn);
      child.on("close", (code) => resolveSpawn({ code: code ?? -1, stdout: stdout.slice(0, 2048), stderr: stderr.slice(0, 2048) }));
    })
  };
  const labPolicyConfirmed = () => {
    try {
      return policy.config.executionClass === "LAB";
    } catch {
      return false;
    }
  };
  const runOne = (spec, subject) => runValidator({
    spec,
    config: verifierConfig,
    runtime,
    pathMod: { resolve: resolvePath },
    labPolicyConfirmed: labPolicyConfirmed(),
    subject
  });
  const service = {
    register(spec) {
      if (registry.has(spec.validatorId)) {
        throw new Error(`validator "${spec.validatorId}" already registered`);
      }
      if (!VALIDATOR_TYPE_SET.has(spec.type)) {
        throw new Error(`unsupported validator type "${String(spec.type)}"`);
      }
      registry.set(spec.validatorId, spec);
      return () => registry.delete(spec.validatorId);
    },
    list: () => [...registry.keys()],
    run: async (validatorId, subject) => {
      const spec = registry.get(validatorId);
      if (!spec) {
        return {
          validatorId,
          type: "exact-text",
          status: "UNAVAILABLE",
          evidence: "validator not registered",
          durationMs: 0,
          reasonCode: "VALIDATOR_NOT_FOUND"
        };
      }
      const result = await runOne(spec, subject);
      ctx.get("supremeObservability")?.record("verification", {
        verificationId: spec.validatorId,
        verificationStatus: result.status,
        detail: result.reasonCode
      });
      return result;
    },
    runAll: async (subject) => {
      const results = [];
      for (const spec of registry.values()) {
        results.push(await runOne(spec, subject));
      }
      return results;
    },
    config: () => verifierConfig
  };
  ctx.provide("supremeVerifier", Object.freeze(service));
  ctx.logger.info("supreme-verifier active (commands=%s, roots=%d)", String(verifierConfig.allowCommands), verifierConfig.allowedRoots.length);
}
export {
  name,
  inject,
  apply,
  Config
};
