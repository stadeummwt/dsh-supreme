// src/plugins/supreme-verifier/index.ts
import { z } from "zod";
import { resolve as resolvePath, relative as relativePath, isAbsolute as isAbsolutePath } from "node:path";

// src/plugins/supreme-verifier/engine.ts
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
var VERIFIER_STATUSES = ["PASS", "FAIL", "ERROR", "UNAVAILABLE"];
var MAX_EVIDENCE_CHARS = 512;
var DEFAULT_MAX_FILE_READ_BYTES = 8 * 1024 * 1024;
var SCHEMA_LIMITS = {
  MAX_SCHEMA_BYTES: 65536,
  MAX_SCHEMA_NODES: 512,
  MAX_INSTANCE_DEPTH: 64,
  MAX_INSTANCE_SCANS: 1e4,
  MAX_REF_HOPS: 256
};
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
    if (resolved === r)
      return true;
    if (typeof pathMod.relative === "function" && typeof pathMod.isAbsolute === "function") {
      const isAbs = pathMod.isAbsolute.bind(pathMod);
      return !relativeEscapesRoot(pathMod.relative(r, resolved), isAbs);
    }
    return resolved.startsWith(r.endsWith("/") || r.endsWith("\\") ? r : `${r}/`) || resolved.startsWith(`${r}\\`);
  });
}
function relativeEscapesRoot(rel, isAbsolute) {
  if (rel.length === 0)
    return false;
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\"))
    return true;
  return isAbsolute(rel);
}
async function resolveRealConfinement(target, allowedRoots, pathMod, realpath) {
  let realTarget;
  try {
    realTarget = await realpath(target);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { kind: "missing", detail: `${target.slice(0, 48)} does not exist (realpath ${code})` };
    }
    return { kind: "unresolvable", detail: `realpath failed for ${target.slice(0, 48)} (${code ?? "error"})` };
  }
  const realRoots = [];
  for (const root of allowedRoots) {
    try {
      realRoots.push(await realpath(root));
    } catch {}
  }
  if (realRoots.length === 0) {
    return { kind: "outside", detail: "no allowedRoot could be resolved (missing or unreadable)" };
  }
  if (typeof pathMod.relative !== "function" || typeof pathMod.isAbsolute !== "function") {
    return { kind: "unresolvable", detail: "pathMod.relative/isAbsolute unavailable; real containment not computable" };
  }
  const isAbs = pathMod.isAbsolute.bind(pathMod);
  const contained = realRoots.some((rr) => {
    if (realTarget === rr)
      return true;
    return !relativeEscapesRoot(pathMod.relative(rr, realTarget), isAbs);
  });
  if (!contained) {
    return { kind: "outside", detail: "real path escapes every allowed root (symlink/junction boundary)" };
  }
  return { kind: "ok", realTarget, realRoots };
}
var TYPE_NAMES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
var ALLOWED_DIALECTS = new Set([
  "http://json-schema.org/draft-06/schema#",
  "http://json-schema.org/draft-06/schema",
  "http://json-schema.org/draft-07/schema#",
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2019-09/schema#",
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2020-12/schema#"
]);
var IGNORED_ANNOTATIONS = new Set(["title", "description", "default", "examples", "$comment"]);
var SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$ref",
  "$defs",
  "definitions",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "items",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  ...IGNORED_ANNOTATIONS
]);
var badSchema = (reason) => ({ ok: false, status: "schema-invalid", reason });
var unsupportedSchema = (reason) => ({ ok: false, status: "unsupported", reason });
var isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function jsonDeepEqual(a, b) {
  if (a === b)
    return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr)
    return false;
  if (aArr) {
    if (a.length !== b.length)
      return false;
    for (let i = 0;i < a.length; i++)
      if (!jsonDeepEqual(a[i], b[i]))
        return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length)
    return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k))
      return false;
    if (!jsonDeepEqual(a[k], b[k]))
      return false;
  }
  return true;
}
function typeMatches(t, v) {
  switch (t) {
    case "object":
      return isPlainObject(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v) && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      return false;
  }
}
function resolveLocalRef(root, ref) {
  if (ref === "#" || ref === "#/")
    return { ok: true, value: root };
  if (!ref.startsWith("#/"))
    return { ok: false, reason: `unresolvable local $ref: ${ref}` };
  const segments = ref.slice(2).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = root;
  for (const seg of segments) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) {
      return { ok: false, reason: `unresolvable local $ref: ${ref}` };
    }
    cur = cur[seg];
  }
  return { ok: true, value: cur };
}
function compileSchemaNode(schema, ctx, ptr) {
  if (ctx.stack.has(ptr))
    return { ok: true };
  ctx.stack.add(ptr);
  try {
    ctx.nodes++;
    if (ctx.nodes > SCHEMA_LIMITS.MAX_SCHEMA_NODES) {
      return badSchema(`SCHEMA_TOO_LARGE: schema exceeds ${SCHEMA_LIMITS.MAX_SCHEMA_NODES} nodes`);
    }
    if (schema === true || schema === false)
      return { ok: true };
    if (!isPlainObject(schema))
      return badSchema("schema must be an object or boolean");
    for (const key of Object.keys(schema)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        return unsupportedSchema(`SCHEMA_UNSUPPORTED_KEYWORD: "${key}" (validator implements a fixed deterministic subset; refusing silent downgrade)`);
      }
    }
    const compileEntry = (value, childPtr) => compileSchemaNode(value, ctx, childPtr);
    if (schema.$schema !== undefined) {
      if (typeof schema.$schema !== "string")
        return badSchema("$schema must be a string URI");
      if (!ALLOWED_DIALECTS.has(schema.$schema)) {
        return unsupportedSchema(`SCHEMA_DIALECT_UNSUPPORTED: ${schema.$schema}`);
      }
    }
    if (schema.$ref !== undefined) {
      const ref = schema.$ref;
      if (typeof ref !== "string")
        return badSchema("$ref must be a string");
      if (!ref.startsWith("#")) {
        return unsupportedSchema(`SCHEMA_REF_UNSUPPORTED: ${ref} (only local "#/…" refs are supported; remote/network refs are never accessed)`);
      }
      const resolved = resolveLocalRef(ctx.root, ref);
      if (!resolved.ok)
        return badSchema(resolved.reason);
      const sub = compileSchemaNode(resolved.value, ctx, ref);
      if (!sub.ok)
        return sub;
    }
    for (const defsKey of ["$defs", "definitions"]) {
      const defs = schema[defsKey];
      if (defs === undefined)
        continue;
      if (!isPlainObject(defs))
        return badSchema(`${defsKey} must be an object`);
      for (const [name, entry] of Object.entries(defs)) {
        const sub = compileEntry(entry, `${ptr}/${defsKey}/${name}`);
        if (!sub.ok)
          return sub;
      }
    }
    if (schema.type !== undefined) {
      const t = schema.type;
      const names = Array.isArray(t) ? t : [t];
      if (names.length === 0 || !names.every((n) => typeof n === "string" && TYPE_NAMES.has(n))) {
        return badSchema(`invalid type keyword: ${JSON.stringify(t)}`);
      }
    }
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
      return badSchema("enum must be a non-empty array");
    }
    if (schema.properties !== undefined) {
      if (!isPlainObject(schema.properties))
        return badSchema("properties must be an object");
      for (const [key, sub] of Object.entries(schema.properties)) {
        const r = compileEntry(sub, `${ptr}/properties/${key}`);
        if (!r.ok)
          return r;
      }
    }
    if (schema.patternProperties !== undefined) {
      if (!isPlainObject(schema.patternProperties))
        return badSchema("patternProperties must be an object");
      for (const [pat, sub] of Object.entries(schema.patternProperties)) {
        try {
          new RegExp(pat);
        } catch {
          return badSchema(`invalid patternProperties regex: ${pat}`);
        }
        const r = compileEntry(sub, `${ptr}/patternProperties/${pat}`);
        if (!r.ok)
          return r;
      }
    }
    if (schema.propertyNames !== undefined) {
      const r = compileEntry(schema.propertyNames, `${ptr}/propertyNames`);
      if (!r.ok)
        return r;
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
      const r = compileEntry(schema.additionalProperties, `${ptr}/additionalProperties`);
      if (!r.ok)
        return r;
    }
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        for (let i = 0;i < schema.items.length; i++) {
          const r = compileEntry(schema.items[i], `${ptr}/items/${i}`);
          if (!r.ok)
            return r;
        }
      } else {
        const r = compileEntry(schema.items, `${ptr}/items`);
        if (!r.ok)
          return r;
      }
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || !schema.required.every((k) => typeof k === "string")) {
        return badSchema("required must be an array of strings");
      }
    }
    for (const bound of ["minimum", "maximum"]) {
      if (schema[bound] !== undefined && (typeof schema[bound] !== "number" || !Number.isFinite(schema[bound]))) {
        return badSchema(`${bound} must be a finite number`);
      }
    }
    for (const bound of ["exclusiveMinimum", "exclusiveMaximum"]) {
      const v = schema[bound];
      if (v === undefined)
        continue;
      if (typeof v === "boolean") {
        return unsupportedSchema(`SCHEMA_UNSUPPORTED: draft-04 boolean ${bound} (numeric form supported)`);
      }
      if (typeof v !== "number" || !Number.isFinite(v))
        return badSchema(`${bound} must be a finite number`);
    }
    for (const bound of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]) {
      const v = schema[bound];
      if (v === undefined)
        continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
        return badSchema(`${bound} must be a non-negative integer`);
    }
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string")
        return badSchema("pattern must be a string");
      try {
        new RegExp(schema.pattern);
      } catch {
        return badSchema(`invalid pattern regex: ${schema.pattern}`);
      }
    }
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
      return badSchema("uniqueItems must be a boolean");
    }
    for (const comp of ["allOf", "anyOf", "oneOf"]) {
      const v = schema[comp];
      if (v === undefined)
        continue;
      if (!Array.isArray(v))
        return badSchema(`${comp} must be an array`);
      for (let i = 0;i < v.length; i++) {
        const r = compileEntry(v[i], `${ptr}/${comp}/${i}`);
        if (!r.ok)
          return r;
      }
    }
    if (schema.not !== undefined) {
      const r = compileEntry(schema.not, `${ptr}/not`);
      if (!r.ok)
        return r;
    }
    return { ok: true };
  } finally {
    ctx.stack.delete(ptr);
  }
}
function compileJsonSchema(schema) {
  let serialized;
  try {
    serialized = JSON.stringify(schema) ?? "";
  } catch {
    return badSchema("SCHEMA_UNSERIALIZABLE: circular or non-JSON structure");
  }
  if (serialized.length > SCHEMA_LIMITS.MAX_SCHEMA_BYTES) {
    return badSchema(`SCHEMA_TOO_LARGE: ${serialized.length} > ${SCHEMA_LIMITS.MAX_SCHEMA_BYTES} bytes`);
  }
  return compileSchemaNode(schema, { root: schema, nodes: 0, stack: new Set }, "#");
}
var at = (path, msg) => path ? `${path}: ${msg}` : msg;
var childPath = (path, key) => path ? `${path}.${key}` : key;
var itemPath = (path, i) => path ? `${path}[${i}]` : `[${i}]`;
function validateNode(schema, instance, issues, path, depth, st) {
  if (st.exhausted)
    return;
  if (depth > SCHEMA_LIMITS.MAX_INSTANCE_DEPTH) {
    st.exhausted = true;
    issues.push(at(path, `INSTANCE_DEPTH_EXCEEDED (max ${SCHEMA_LIMITS.MAX_INSTANCE_DEPTH})`));
    return;
  }
  if (st.scans > SCHEMA_LIMITS.MAX_INSTANCE_SCANS) {
    st.exhausted = true;
    issues.push(at(path, `INSTANCE_SCAN_LIMIT_EXCEEDED (max ${SCHEMA_LIMITS.MAX_INSTANCE_SCANS})`));
    return;
  }
  if (schema === true)
    return;
  if (schema === false) {
    issues.push(at(path, "schema false"));
    return;
  }
  if (!isPlainObject(schema))
    return;
  if (typeof schema.$ref === "string") {
    st.refHops++;
    if (st.refHops > SCHEMA_LIMITS.MAX_REF_HOPS) {
      st.exhausted = true;
      issues.push(at(path, `REF_LIMIT_EXCEEDED (max ${SCHEMA_LIMITS.MAX_REF_HOPS})`));
      return;
    }
    const resolved = resolveLocalRef(st.root, schema.$ref);
    if (!resolved.ok) {
      st.exhausted = true;
      issues.push(at(path, resolved.reason));
      return;
    }
    validateNode(resolved.value, instance, issues, path, depth, st);
    if (st.exhausted)
      return;
  }
  const t = schema.type;
  if (typeof t === "string") {
    if (!typeMatches(t, instance))
      issues.push(at(path, `type expected ${t}`));
  } else if (Array.isArray(t)) {
    if (!t.some((n) => typeof n === "string" && typeMatches(n, instance))) {
      issues.push(at(path, `type expected one of ${t.join("|")}`));
    }
  }
  if (Array.isArray(schema.enum)) {
    st.scans += schema.enum.length;
    if (!schema.enum.some((v) => jsonDeepEqual(v, instance)))
      issues.push(at(path, "value not in enum"));
  }
  if (schema.const !== undefined && !jsonDeepEqual(schema.const, instance)) {
    issues.push(at(path, "value not equal to const"));
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      validateNode(sub, instance, issues, path, depth, st);
      if (st.exhausted)
        return;
    }
  }
  if (Array.isArray(schema.anyOf)) {
    st.scans += schema.anyOf.length;
    const matched = schema.anyOf.some((sub) => {
      const tmp = [];
      validateNode(sub, instance, tmp, path, depth, st);
      return tmp.length === 0;
    });
    if (!matched)
      issues.push(at(path, "anyOf: no branch matched"));
  }
  if (Array.isArray(schema.oneOf)) {
    st.scans += schema.oneOf.length;
    let matched = 0;
    for (const sub of schema.oneOf) {
      const tmp = [];
      validateNode(sub, instance, tmp, path, depth, st);
      if (tmp.length === 0)
        matched++;
    }
    if (matched !== 1)
      issues.push(at(path, `oneOf matched ${matched} branches (need exactly 1)`));
  }
  if (schema.not !== undefined) {
    const tmp = [];
    validateNode(schema.not, instance, tmp, path, depth, st);
    if (tmp.length === 0)
      issues.push(at(path, "not: inner schema must not match"));
  }
  if (st.exhausted)
    return;
  if (typeof instance === "string") {
    if (typeof schema.minLength === "number" && instance.length < schema.minLength) {
      issues.push(at(path, `minLength ${schema.minLength}`));
    }
    if (typeof schema.maxLength === "number" && instance.length > schema.maxLength) {
      issues.push(at(path, `maxLength ${schema.maxLength}`));
    }
    if (typeof schema.pattern === "string") {
      st.scans++;
      try {
        if (!new RegExp(schema.pattern).test(instance))
          issues.push(at(path, "pattern mismatch"));
      } catch {
        issues.push(at(path, "pattern mismatch (invalid regex)"));
      }
    }
  }
  if (typeof instance === "number" && Number.isFinite(instance)) {
    if (typeof schema.minimum === "number" && instance < schema.minimum)
      issues.push(at(path, `minimum ${schema.minimum}`));
    if (typeof schema.maximum === "number" && instance > schema.maximum)
      issues.push(at(path, `maximum ${schema.maximum}`));
    if (typeof schema.exclusiveMinimum === "number" && instance <= schema.exclusiveMinimum) {
      issues.push(at(path, `exclusiveMinimum ${schema.exclusiveMinimum}`));
    }
    if (typeof schema.exclusiveMaximum === "number" && instance >= schema.exclusiveMaximum) {
      issues.push(at(path, `exclusiveMaximum ${schema.exclusiveMaximum}`));
    }
  }
  if (Array.isArray(instance)) {
    if (typeof schema.minItems === "number" && instance.length < schema.minItems) {
      issues.push(at(path, `minItems ${schema.minItems}`));
    }
    if (typeof schema.maxItems === "number" && instance.length > schema.maxItems) {
      issues.push(at(path, `maxItems ${schema.maxItems}`));
    }
    const items = schema.items;
    if (Array.isArray(items)) {
      const n = Math.min(items.length, instance.length);
      for (let i = 0;i < n; i++) {
        st.scans++;
        validateNode(items[i], instance[i], issues, itemPath(path, i), depth + 1, st);
        if (st.exhausted)
          return;
      }
    } else if (items !== undefined) {
      for (let i = 0;i < instance.length; i++) {
        st.scans++;
        validateNode(items, instance[i], issues, itemPath(path, i), depth + 1, st);
        if (st.exhausted)
          return;
      }
    }
    if (schema.uniqueItems === true) {
      for (let i = 0;i < instance.length; i++) {
        for (let j = i + 1;j < instance.length; j++) {
          st.scans++;
          if (st.scans > SCHEMA_LIMITS.MAX_INSTANCE_SCANS) {
            st.exhausted = true;
            issues.push(at(path, `INSTANCE_SCAN_LIMIT_EXCEEDED (max ${SCHEMA_LIMITS.MAX_INSTANCE_SCANS})`));
            return;
          }
          if (jsonDeepEqual(instance[i], instance[j])) {
            issues.push(at(itemPath(path, j), "duplicate item (uniqueItems)"));
          }
        }
      }
    }
  }
  if (isPlainObject(instance)) {
    const keys = Object.keys(instance);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
      issues.push(at(path, `minProperties ${schema.minProperties}`));
    }
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
      issues.push(at(path, `maxProperties ${schema.maxProperties}`));
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in instance))
          issues.push(at(path, `missing required: ${key}`));
      }
    }
    if (schema.propertyNames !== undefined) {
      for (const key of keys) {
        st.scans++;
        validateNode(schema.propertyNames, key, issues, childPath(path, `<key:${key}>`), depth + 1, st);
        if (st.exhausted)
          return;
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const patternProps = [];
    if (isPlainObject(schema.patternProperties)) {
      for (const [pat, sub] of Object.entries(schema.patternProperties)) {
        try {
          patternProps.push({ re: new RegExp(pat), schema: sub });
        } catch {}
      }
    }
    const handled = new Set;
    for (const [key, sub] of Object.entries(properties)) {
      if (key in instance) {
        handled.add(key);
        st.scans++;
        validateNode(sub, instance[key], issues, childPath(path, key), depth + 1, st);
        if (st.exhausted)
          return;
      }
    }
    for (const { re, schema: sub } of patternProps) {
      for (const key of keys) {
        if (re.test(key)) {
          handled.add(key);
          st.scans++;
          validateNode(sub, instance[key], issues, childPath(path, key), depth + 1, st);
          if (st.exhausted)
            return;
        }
      }
    }
    const ap = schema.additionalProperties;
    if (ap === false) {
      for (const key of keys) {
        if (!handled.has(key))
          issues.push(at(path, `additional property not allowed: ${key}`));
      }
    } else if (ap !== undefined && ap !== true) {
      for (const key of keys) {
        if (handled.has(key))
          continue;
        st.scans++;
        validateNode(ap, instance[key], issues, childPath(path, key), depth + 1, st);
        if (st.exhausted)
          return;
      }
    }
  }
}
function validateJsonSchema(value, schema) {
  const compiled = compileJsonSchema(schema);
  if (!compiled.ok) {
    return compiled.status === "unsupported" ? { outcome: "unsupported", reason: compiled.reason } : { outcome: "schema-invalid", reason: compiled.reason };
  }
  const issues = [];
  const st = { root: schema, scans: 0, refHops: 0, exhausted: false };
  validateNode(schema, value, issues, "", 0, st);
  if (issues.length === 0)
    return { outcome: "valid" };
  return { outcome: "invalid", issues };
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
        const rawSchema = spec.config.schema;
        if (rawSchema === undefined || rawSchema === null)
          return finish("ERROR", "SPEC_INVALID", "missing schema");
        const compiled = compileJsonSchema(rawSchema);
        if (!compiled.ok) {
          return compiled.status === "unsupported" ? finish("UNAVAILABLE", "SCHEMA_UNSUPPORTED", compiled.reason) : finish("ERROR", "SCHEMA_INVALID", compiled.reason);
        }
        let parsed;
        try {
          parsed = JSON.parse(input.subject ?? "");
        } catch (err) {
          return finish("FAIL", "JSON_PARSE_FAILED", err instanceof Error ? err.message.slice(0, 64) : "parse error");
        }
        const result = validateJsonSchema(parsed, rawSchema);
        if (result.outcome === "valid")
          return finish("PASS", "OK", "schema ok (bounded deterministic subset)");
        if (result.outcome === "schema-invalid")
          return finish("ERROR", "SCHEMA_INVALID", result.reason);
        if (result.outcome === "unsupported")
          return finish("UNAVAILABLE", "SCHEMA_UNSUPPORTED", result.reason);
        return finish("FAIL", "SCHEMA_VIOLATION", result.issues.slice(0, 3).join("; "));
      }
      case "file-exists": {
        const p = String(spec.config.path ?? "");
        if (!p)
          return finish("ERROR", "SPEC_INVALID", "missing path");
        if (!pathIsAllowed(p, config.allowedRoots, pathMod)) {
          return finish("UNAVAILABLE", "PATH_OUTSIDE_ALLOWED_ROOTS", p.slice(0, 64));
        }
        if (typeof runtime.realpath === "function" && typeof pathMod.relative === "function" && typeof pathMod.isAbsolute === "function") {
          const conf = await resolveRealConfinement(p, config.allowedRoots, pathMod, runtime.realpath);
          if (conf.kind === "missing")
            return finish("FAIL", "FILE_MISSING", conf.detail);
          if (conf.kind === "unresolvable")
            return finish("ERROR", "PATH_UNRESOLVABLE", conf.detail);
          if (conf.kind === "outside")
            return finish("UNAVAILABLE", "PATH_OUTSIDE_ALLOWED_ROOTS", conf.detail);
          return finish("PASS", "OK", `${p.slice(0, 48)} exists (realpath-verified)`);
        }
        const exists = await runtime.fsExists(p);
        return exists ? finish("PASS", "OK", `${p.slice(0, 48)} exists (lexical confinement; runtime lacks realpath)`) : finish("FAIL", "FILE_MISSING", p.slice(0, 64));
      }
      case "file-hash": {
        const p = String(spec.config.path ?? "");
        const expected = String(spec.config.sha256 ?? "");
        if (!p || !/^[0-9a-f]{64}$/i.test(expected))
          return finish("ERROR", "SPEC_INVALID", "path/sha256 invalid");
        if (!pathIsAllowed(p, config.allowedRoots, pathMod)) {
          return finish("UNAVAILABLE", "PATH_OUTSIDE_ALLOWED_ROOTS", p.slice(0, 64));
        }
        if (typeof runtime.realpath !== "function" || typeof runtime.stat !== "function" || typeof runtime.readBytesWithFstat !== "function" || typeof runtime.hashBytes !== "function" || typeof pathMod.relative !== "function" || typeof pathMod.isAbsolute !== "function") {
          return finish("ERROR", "CONFINEMENT_UNVERIFIABLE", "runtime lacks realpath/stat/open-fstat capability; content read refused");
        }
        const conf = await resolveRealConfinement(p, config.allowedRoots, pathMod, runtime.realpath);
        if (conf.kind === "missing")
          return finish("FAIL", "FILE_MISSING", conf.detail);
        if (conf.kind === "unresolvable")
          return finish("ERROR", "PATH_UNRESOLVABLE", conf.detail);
        if (conf.kind === "outside")
          return finish("UNAVAILABLE", "PATH_OUTSIDE_ALLOWED_ROOTS", conf.detail);
        const maxBytes = config.maxFileReadBytes ?? DEFAULT_MAX_FILE_READ_BYTES;
        const statBefore = await runtime.stat(conf.realTarget);
        if (statBefore === null)
          return finish("FAIL", "FILE_MISSING", `${p.slice(0, 48)} vanished before read (stat ENOENT)`);
        if (!Number.isFinite(statBefore.size) || statBefore.size > maxBytes) {
          return finish("FAIL", "FILE_TOO_LARGE", `size exceeds maxFileReadBytes (${maxBytes}); hash comparison refused`);
        }
        const read = await runtime.readBytesWithFstat(conf.realTarget);
        if (read === null)
          return finish("FAIL", "FILE_MISSING", `${p.slice(0, 48)} unreadable at open time`);
        if (read.dev !== statBefore.dev || read.ino !== statBefore.ino) {
          return finish("ERROR", "PATH_SWAPPED_DURING_READ", "file identity (dev/ino) changed between stat and open; refusing hash");
        }
        const hash = await runtime.hashBytes(read.bytes);
        if (hash === null)
          return finish("ERROR", "HASH_UNAVAILABLE", "hashBytes failed");
        return hash.toLowerCase() === expected.toLowerCase() ? finish("PASS", "OK", `sha256 ${hash.slice(0, 12)}… (real-path confined)`) : finish("FAIL", "HASH_MISMATCH", `sha256 ${hash.slice(0, 12)}… (real-path confined)`);
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
var EVIDENCE_SCHEMA_VERSION = "dsh-supreme/evidence@1";
var MAX_EVIDENCE_ID_CHARS = 256;
var MAX_EVIDENCE_ATTEMPT = 1e6;
var MAX_EVIDENCE_PATH_CHARS = 512;
var FORBIDDEN_EVIDENCE_FIELDS = Object.freeze([
  "confidence",
  "confidenceScore",
  "selfReported",
  "selfConfidence",
  "modelConfidence",
  "reasoningTrace",
  "reasoning",
  "trace",
  "cot",
  "chainOfThought",
  "hiddenReasoning"
]);
var SHA256_HEX_RE = /^[0-9a-f]{64}$/;

class EvidenceError extends Error {
  issues;
  constructor(issues) {
    super(`invalid evidence record input: ${issues.join("; ")}`);
    this.issues = issues;
    this.name = "EvidenceError";
  }
}
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function rejectForbiddenFields(obj, label, issues) {
  if (!isRecord(obj))
    return;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_EVIDENCE_FIELDS.includes(key)) {
      issues.push(`${label} carries forbidden self-report field "${key}" — confidence/reasoning traces can never influence verification evidence`);
    }
  }
}
function normalizeSha256(value, issues) {
  if (typeof value !== "string" || !SHA256_HEX_RE.test(value)) {
    issues.push("artifact.sha256 must be a 64-char hex sha-256 of the artifact bytes");
    return;
  }
  return value.toLowerCase();
}
async function recordEvidence(input) {
  const issues = [];
  if (!isRecord(input)) {
    throw new EvidenceError(["recordEvidence requires an input object"]);
  }
  rejectForbiddenFields(input, "input", issues);
  if (!isRecord(input.result)) {
    throw new EvidenceError(["result must be a VerifierResult produced by runValidator"]);
  }
  rejectForbiddenFields(input.result, "result", issues);
  const result = input.result;
  const validatorId = typeof result.validatorId === "string" && result.validatorId.length > 0 ? result.validatorId : undefined;
  const validatorType = VALIDATOR_TYPES.includes(result.type) ? result.type : undefined;
  const status = VERIFIER_STATUSES.includes(result.status) ? result.status : undefined;
  if (validatorId === undefined)
    issues.push("result.validatorId must be a non-empty string (run a registered validator first)");
  if (validatorType === undefined)
    issues.push("result.type must be a known validator type");
  if (status === undefined)
    issues.push("result.status must be one of PASS|FAIL|ERROR|UNAVAILABLE (from runValidator)");
  if (typeof result.reasonCode !== "string" || result.reasonCode.length === 0)
    issues.push("result.reasonCode must be a non-empty string");
  if (typeof result.durationMs !== "number" || !Number.isFinite(result.durationMs) || result.durationMs < 0)
    issues.push("result.durationMs must be a non-negative number");
  const taskId = typeof input.taskId === "string" ? input.taskId : "";
  if (taskId.length === 0 || taskId.length > MAX_EVIDENCE_ID_CHARS) {
    issues.push(`taskId must be a non-empty string of at most ${MAX_EVIDENCE_ID_CHARS} chars`);
  }
  const attempt = input.attempt;
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1 || attempt > MAX_EVIDENCE_ATTEMPT) {
    issues.push(`attempt must be an integer in [1, ${MAX_EVIDENCE_ATTEMPT}]`);
  }
  if (!isRecord(input.artifact)) {
    issues.push("artifact must be an object ({ sha256 } or { bytes } + hashBytes)");
  }
  let sha256;
  let path;
  let revision;
  if (isRecord(input.artifact)) {
    rejectForbiddenFields(input.artifact, "artifact", issues);
    if (input.artifact.sha256 !== undefined) {
      sha256 = normalizeSha256(input.artifact.sha256, issues);
    } else if (input.artifact.bytes instanceof Uint8Array) {
      if (typeof input.hashBytes !== "function") {
        issues.push("artifact.bytes requires a hashBytes runtime member (deterministic sha-256 over bytes)");
      } else {
        const computed = await input.hashBytes(input.artifact.bytes);
        if (computed === null || !SHA256_HEX_RE.test(computed)) {
          issues.push("hashBytes failed to produce a 64-char hex sha-256 for artifact.bytes");
        } else {
          sha256 = computed.toLowerCase();
        }
      }
    } else {
      if (status === "PASS") {
        issues.push("a PASS record requires artifact.sha256 (or bytes + hashBytes) — a PASS without the verified artifact hash is not recordable");
      }
    }
    if (input.artifact.path !== undefined) {
      if (typeof input.artifact.path !== "string" || input.artifact.path.length === 0 || input.artifact.path.length > MAX_EVIDENCE_PATH_CHARS) {
        issues.push(`artifact.path must be a non-empty string of at most ${MAX_EVIDENCE_PATH_CHARS} chars`);
      } else {
        path = input.artifact.path;
      }
    }
    if (input.artifact.revision !== undefined) {
      if (typeof input.artifact.revision !== "string" || input.artifact.revision.length === 0 || input.artifact.revision.length > MAX_EVIDENCE_ID_CHARS) {
        issues.push(`artifact.revision must be a non-empty string of at most ${MAX_EVIDENCE_ID_CHARS} chars`);
      } else {
        revision = input.artifact.revision;
      }
    }
  }
  if (issues.length > 0)
    throw new EvidenceError(issues);
  const recordedAt = input.recordedAt ?? Date.now();
  if (typeof recordedAt !== "number" || !Number.isFinite(recordedAt) || recordedAt < 0) {
    throw new EvidenceError(["recordedAt must be a non-negative finite number"]);
  }
  const evidence = Object.freeze({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    taskId,
    attempt,
    artifact: Object.freeze({ ...path !== undefined ? { path } : {}, sha256, ...revision !== undefined ? { revision } : {} }),
    validatorId,
    validatorType,
    status,
    reasonCode: result.reasonCode,
    recordedAt
  });
  return evidence;
}

// src/plugins/supreme-verifier/index.ts
var VALIDATOR_TYPE_SET = new Set(VALIDATOR_TYPES);
var name = "supreme-verifier";
var inject = ["supremePolicy"];
var Config = z.object({
  allowCommands: z.boolean().default(false),
  allowNetwork: z.boolean().default(false),
  allowedRoots: z.array(z.string()).default([]),
  commandTimeoutMs: z.number().int().min(100).default(30000),
  maxFileReadBytes: z.number().int().min(1).default(DEFAULT_MAX_FILE_READ_BYTES)
});
function apply(ctx, config) {
  const policy = ctx.supremePolicy;
  const verifierConfig = {
    allowCommands: config.allowCommands,
    allowNetwork: config.allowNetwork,
    allowedRoots: config.allowedRoots.map((r) => resolvePath(r)),
    commandTimeoutMs: config.commandTimeoutMs,
    maxFileReadBytes: config.maxFileReadBytes
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
    }),
    realpath: async (p) => process.getBuiltinModule("node:fs").promises.realpath(p),
    stat: async (p) => {
      try {
        const st = await process.getBuiltinModule("node:fs").promises.stat(p);
        return { dev: st.dev, ino: st.ino, size: st.size };
      } catch {
        return null;
      }
    },
    readBytesWithFstat: async (p) => {
      const fsmod = process.getBuiltinModule("node:fs");
      let fh;
      try {
        fh = await fsmod.promises.open(p, "r");
        const st = await fh.stat();
        const bytes = await fh.readFile();
        return { bytes, dev: st.dev, ino: st.ino, size: st.size };
      } catch {
        return null;
      } finally {
        try {
          await fh?.close();
        } catch {}
      }
    },
    hashBytes: async (bytes) => process.getBuiltinModule("node:crypto").createHash("sha256").update(bytes).digest("hex")
  };
  const labPolicyConfirmed = () => {
    try {
      return policy.config.executionClass === "LAB";
    } catch {
      return false;
    }
  };
  const pathMod = { resolve: resolvePath, relative: relativePath, isAbsolute: isAbsolutePath };
  const runOne = (spec, subject) => runValidator({
    spec,
    config: verifierConfig,
    runtime,
    pathMod,
    labPolicyConfirmed: labPolicyConfirmed(),
    subject
  });
  const recordVerificationEvent = (spec, result) => {
    ctx.get("supremeObservability")?.record("verification", {
      verificationId: spec.validatorId,
      verificationStatus: result.status,
      detail: result.reasonCode
    });
  };
  const hashArtifact = async (p) => {
    if (typeof p !== "string" || p.length === 0)
      return { sha256: null };
    if (!pathIsAllowed(p, verifierConfig.allowedRoots, pathMod))
      return { sha256: null };
    if (typeof runtime.realpath === "function" && typeof runtime.stat === "function" && typeof runtime.readBytesWithFstat === "function" && typeof runtime.hashBytes === "function") {
      const conf = await resolveRealConfinement(p, verifierConfig.allowedRoots, pathMod, runtime.realpath);
      if (conf.kind !== "ok")
        return { sha256: null };
      const maxBytes = verifierConfig.maxFileReadBytes ?? DEFAULT_MAX_FILE_READ_BYTES;
      const st = await runtime.stat(conf.realTarget);
      if (st === null || !Number.isFinite(st.size) || st.size > maxBytes)
        return { sha256: null };
      const read = await runtime.readBytesWithFstat(conf.realTarget);
      if (read === null)
        return { sha256: null };
      return { sha256: await runtime.hashBytes(read.bytes) };
    }
    return { sha256: null };
  };
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
      recordVerificationEvent(spec, result);
      return result;
    },
    runAll: async (subject) => {
      const results = [];
      for (const spec of registry.values()) {
        results.push(await runOne(spec, subject));
      }
      return results;
    },
    config: () => verifierConfig,
    hashArtifact,
    runAndRecord: async (validatorId, identity, subject) => {
      const spec = registry.get(validatorId);
      const result = spec ? await runOne(spec, subject) : {
        validatorId,
        type: "exact-text",
        status: "UNAVAILABLE",
        evidence: "validator not registered",
        durationMs: 0,
        reasonCode: "VALIDATOR_NOT_FOUND"
      };
      recordVerificationEvent({ validatorId, type: result.type, config: {} }, result);
      let artifact = identity.artifact;
      if ((artifact.sha256 === undefined || artifact.sha256 === null) && typeof artifact.path === "string") {
        const computed = await hashArtifact(artifact.path);
        if (computed.sha256 !== null)
          artifact = { ...artifact, sha256: computed.sha256 };
      }
      return recordEvidence({
        result,
        taskId: identity.taskId,
        attempt: identity.attempt,
        artifact,
        hashBytes: runtime.hashBytes
      });
    }
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
