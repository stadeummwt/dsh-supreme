// src/plugins/supreme-memory-policy/index.ts
import { z } from "zod";
import { resolve } from "node:path";

// src/plugins/supreme-memory-policy/engine.ts
var NOOP_LONG_TERM_PROVIDER = Object.freeze({
  name: "noop",
  status: "UNAVAILABLE",
  list: () => []
});
var SECRET_PATTERNS = [
  /SECRET_SENTINEL[A-Z0-9_]*/,
  /sk-[a-zA-Z0-9]{8,}/,
  /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/,
  /Authorization:\s*Bearer/i,
  /api[-_]?key\s*[:=]/i,
  /password\s*[:=]/i
];
function isSecretBearing(item) {
  const haystack = `${item.source}
${item.tags?.join(" ") ?? ""}
${item.text}`;
  return SECRET_PATTERNS.some((re) => re.test(haystack));
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function selectMemory(input) {
  const { budgetTokens, providerState } = input;
  const selected = [];
  const excluded = [];
  const candidates = [...input.items];
  for (const item of candidates) {
    if (isSecretBearing(item))
      excluded.push({ id: item.id, reason: "SECRET_CATEGORY" });
    else if (item.estimatedTokens > budgetTokens && selected.length === 0 && item.priority < 50) {
      excluded.push({ id: item.id, reason: "ITEM_EXCEEDS_BUDGET" });
    }
  }
  const eligible = candidates.filter((item) => !excluded.some((e) => e.id === item.id));
  eligible.sort((a, b) => b.priority - a.priority || a.estimatedTokens - b.estimatedTokens);
  let used = 0;
  for (const item of eligible) {
    if (used + item.estimatedTokens <= budgetTokens) {
      selected.push({
        item,
        reason: item.class === "TASK_RELEVANT" ? "TASK_RELEVANT" : item.class
      });
      used += item.estimatedTokens;
    } else {
      excluded.push({ id: item.id, reason: "BUDGET_EXCEEDED" });
    }
  }
  return {
    selected,
    excluded,
    totalEstimatedTokens: used,
    budgetTokens,
    withinBudget: true,
    providerState
  };
}
function needsMemory(input) {
  const pressure = input.tokenPressure ?? 0;
  if (pressure > 0.85)
    return { required: false, reason: "TOKEN_PRESSURE_HIGH" };
  if (input.taskText.length === 0)
    return { required: false, reason: "NO_TASK" };
  return { required: true, reason: "DEFAULT_ON" };
}

class LedgerValidationError extends Error {
  issues;
  constructor(issues) {
    super(`invalid ledger note: ${issues.join("; ")}`);
    this.issues = issues;
    this.name = "LedgerValidationError";
  }
}
function validateLedgerNote(raw) {
  const issues = [];
  if (!raw || typeof raw !== "object")
    throw new LedgerValidationError(["note must be an object"]);
  const rec = raw;
  if (typeof rec.id !== "string" || rec.id.length === 0 || rec.id.length > 128)
    issues.push("id required (≤128 chars)");
  if (typeof rec.text !== "string" || rec.text.length === 0 || rec.text.length > 2000)
    issues.push("text required (≤2000 chars)");
  if (!Array.isArray(rec.tags) || rec.tags.length > 16 || rec.tags.some((t) => typeof t !== "string" || t.length > 64)) {
    issues.push("tags must be ≤16 strings (≤64 chars)");
  }
  if (typeof rec.priority !== "number" || rec.priority < 0 || rec.priority > 100)
    issues.push("priority must be within [0,100]");
  if (typeof rec.confidence !== "number" || rec.confidence < 0 || rec.confidence > 1)
    issues.push("confidence must be within [0,1]");
  if (typeof rec.createdAt !== "number" || !Number.isFinite(rec.createdAt))
    issues.push("createdAt required");
  if (typeof rec.source !== "string" || rec.source.length === 0 || rec.source.length > 128)
    issues.push("source required (≤128 chars)");
  if (issues.length > 0)
    throw new LedgerValidationError(issues);
  const note = raw;
  if (isSecretBearing({ id: note.id, class: "LONG_TERM", source: note.source, text: note.text, estimatedTokens: 0, priority: note.priority, tags: note.tags })) {
    throw new LedgerValidationError(["note is credential-bearing and is rejected at admission"]);
  }
  return note;
}

class NoteLedger {
  filePath;
  fsImpl;
  maxEntries;
  notes = [];
  loadedCorrupt = 0;
  appended = 0;
  rejected = 0;
  loaded = false;
  constructor(filePath, fsImpl, maxEntries) {
    this.filePath = filePath;
    this.fsImpl = fsImpl;
    this.maxEntries = maxEntries;
  }
  async init() {
    if (this.loaded)
      return this.stats();
    this.loaded = true;
    const raw = await this.fsImpl.readFile(this.filePath).catch(() => null);
    if (raw) {
      for (const line of raw.split(`
`)) {
        if (line.length === 0)
          continue;
        try {
          this.notes.push(validateLedgerNote(JSON.parse(line)));
        } catch {
          this.loadedCorrupt++;
        }
      }
      this.trim();
    }
    return this.stats();
  }
  trim() {
    if (this.notes.length > this.maxEntries) {
      this.notes = this.notes.slice(this.notes.length - this.maxEntries);
    }
  }
  async append(note) {
    try {
      validateLedgerNote(note);
    } catch {
      this.rejected++;
      return false;
    }
    this.notes.push(note);
    this.trim();
    this.appended++;
    const line = JSON.stringify(note) + `
`;
    this.queue = this.queue.then(async () => {
      await this.fsImpl.mkdir(this.dirOf());
      await this.fsImpl.appendFile(this.filePath, line);
    }).catch(() => {
      return;
    });
    await this.queue;
    return true;
  }
  queue = Promise.resolve();
  list() {
    return [...this.notes];
  }
  stats() {
    return { entries: this.notes.length, loadedCorrupt: this.loadedCorrupt, appended: this.appended, rejected: this.rejected };
  }
  async flush() {
    await this.queue.catch(() => {
      return;
    });
  }
  dirOf() {
    const idx = this.filePath.lastIndexOf("/");
    return idx > 0 ? this.filePath.slice(0, idx) : ".";
  }
}
function tokenSet(text) {
  const out = new Set;
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])
    out.add(word);
  return out;
}
function ledgerRelevanceScore(note, taskTokens) {
  const noteTokens = tokenSet(`${note.text} ${note.tags.join(" ")}`);
  let overlap = 0;
  for (const t of noteTokens)
    if (taskTokens.has(t))
      overlap++;
  return overlap;
}
var DEFAULT_INSTINCT_PARAMS = Object.freeze({
  minConfidence: 0.7,
  maxInjected: 6,
  relevanceRanking: true
});
function selectLedgerNotes(notes, taskText, params) {
  const taskTokens = tokenSet(taskText);
  const eligible = notes.filter((n) => n.confidence >= params.minConfidence);
  const scored = eligible.map((n) => ({ note: n, relevance: ledgerRelevanceScore(n, taskTokens) }));
  scored.sort((a, b) => params.relevanceRanking ? b.relevance - a.relevance || b.note.priority - a.note.priority || b.note.createdAt - a.note.createdAt || a.note.id.localeCompare(b.note.id) : b.note.priority - a.note.priority || b.note.createdAt - a.note.createdAt || a.note.id.localeCompare(b.note.id));
  return scored.slice(0, params.maxInjected).map((s) => s.note);
}
function ledgerNotesToItems(notes) {
  return notes.map((n) => ({
    id: `ledger:${n.id}`,
    class: "TASK_RELEVANT",
    source: `ledger:${n.source}`,
    text: n.text,
    estimatedTokens: estimateTokens(n.text),
    priority: n.priority,
    tags: n.tags
  }));
}
var SHARED_KNOWLEDGE_SCOPE = "project";
var DEFAULT_SELECTION_STORE_CAP = 128;
var MIN_SELECTION_STORE_CAP = 8;
function normalizeIdentityText(value) {
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function identityOf(input) {
  const sessionId = normalizeIdentityText(input.sessionId);
  const taskId = normalizeIdentityText(input.taskId);
  return sessionId !== null && taskId !== null ? { sessionId, taskId } : null;
}
function identityKey(identity) {
  return `${identity.sessionId}\x00${identity.taskId}`;
}
function clampSelectionStoreCap(cap) {
  if (typeof cap !== "number" || !Number.isFinite(cap))
    return DEFAULT_SELECTION_STORE_CAP;
  return Math.max(MIN_SELECTION_STORE_CAP, Math.floor(cap));
}

class SelectionStore {
  capacity;
  entries = new Map;
  activeTask = new Map;
  evictions = 0;
  constructor(capacity = DEFAULT_SELECTION_STORE_CAP) {
    this.capacity = typeof capacity === "number" && Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : DEFAULT_SELECTION_STORE_CAP;
  }
  record(identity, selection) {
    const key = identityKey(identity);
    this.entries.delete(key);
    this.entries.set(key, { identity, selection });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done)
        break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
    this.activeTask.delete(identity.sessionId);
    this.activeTask.set(identity.sessionId, identity.taskId);
    while (this.activeTask.size > this.capacity) {
      const oldest = this.activeTask.keys().next();
      if (oldest.done)
        break;
      this.activeTask.delete(oldest.value);
      this.evictions += 1;
    }
  }
  get(identity) {
    const key = identityKey(identity);
    const entry = this.entries.get(key);
    if (!entry)
      return;
    if (entry.identity.sessionId !== identity.sessionId || entry.identity.taskId !== identity.taskId) {
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.selection;
  }
  activeTaskOf(sessionId) {
    const taskId = this.activeTask.get(sessionId);
    if (taskId === undefined)
      return;
    this.activeTask.delete(sessionId);
    this.activeTask.set(sessionId, taskId);
    return taskId;
  }
  releaseTask(identity) {
    const removed = this.entries.delete(identityKey(identity));
    const active = this.activeTask.get(identity.sessionId);
    if (active === identity.taskId)
      this.activeTask.delete(identity.sessionId);
    return removed;
  }
  releaseSession(sessionId) {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.identity.sessionId === sessionId) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    this.activeTask.delete(sessionId);
    return removed;
  }
  clear() {
    const removed = this.entries.size;
    this.entries.clear();
    this.activeTask.clear();
    return removed;
  }
  stats() {
    return { capacity: this.capacity, entries: this.entries.size, activeTasks: this.activeTask.size, evictions: this.evictions };
  }
}

// src/plugins/supreme-memory-policy/index.ts
var name = "supreme-memory-policy";
var inject = ["sessions", "systemPrompt"];
var Config = z.object({
  defaultBudgetTokens: z.number().int().min(128).max(1e5).default(2048),
  registerPromptSection: z.boolean().default(true),
  projectKnowledge: z.array(z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    priority: z.number().min(0).max(100).default(50),
    tags: z.array(z.string()).default([])
  })).default([]),
  ledgerEnabled: z.boolean().default(false),
  ledgerDir: z.string().default("dsh-supreme/data/ledger"),
  ledgerFileName: z.string().default("ledger.jsonl"),
  ledgerMaxEntries: z.number().int().min(10).max(1e4).default(500),
  minConfidence: z.number().min(0).max(1).default(0.7),
  maxInjected: z.number().int().min(1).max(20).default(6),
  relevanceRanking: z.boolean().default(true),
  selectionStoreCap: z.number().int().min(8).max(4096).default(128)
});
async function apply(ctx, config) {
  const tokenMeter = ctx.get("tokenMeter");
  let longTerm = NOOP_LONG_TERM_PROVIDER;
  const store = new SelectionStore(clampSelectionStoreCap(config.selectionStoreCap));
  const audit = (event, fields) => {
    try {
      const observability = ctx.get("supremeObservability");
      if (!observability || typeof observability.record !== "function")
        return;
      observability.record(event, fields);
    } catch {}
  };
  let ledger = null;
  if (config.ledgerEnabled) {
    const fs = process.getBuiltinModule("node:fs").promises;
    const ledgerPath = resolve(config.ledgerDir, config.ledgerFileName);
    ledger = new NoteLedger(ledgerPath, {
      readFile: async (p) => {
        try {
          return await fs.readFile(p, "utf8");
        } catch {
          return null;
        }
      },
      appendFile: (p, line) => fs.appendFile(p, line, "utf8"),
      mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {
        return;
      })
    }, config.ledgerMaxEntries);
    await ledger.init();
    ctx.logger.info("supreme-memory-policy ledger at %s (%d entries)", ledgerPath, ledger.stats().entries);
  }
  const instinctParams = {
    minConfidence: config.minConfidence,
    maxInjected: config.maxInjected,
    relevanceRanking: config.relevanceRanking
  };
  const ledgerItemsForTask = (taskText) => {
    if (!ledger)
      return [];
    return ledgerNotesToItems(selectLedgerNotes(ledger.list(), taskText, instinctParams));
  };
  const projectItems = () => config.projectKnowledge.map((entry) => ({
    id: entry.id,
    class: "PROJECT_CONTEXT",
    source: `config.projectKnowledge:${SHARED_KNOWLEDGE_SCOPE}`,
    text: entry.text,
    estimatedTokens: estimateTokens(entry.text),
    priority: entry.priority,
    tags: entry.tags
  }));
  const storeScoped = (input, selection) => {
    const identity = identityOf(input);
    if (!identity)
      return;
    store.record(identity, selection);
    audit("memory_selection_scoped", {
      sessionId: identity.sessionId,
      detail: `task:${identity.taskId} selected:${selection.selected.length} tokens:${selection.totalEstimatedTokens} entries:${store.stats().entries}`
    });
  };
  const sessionIdFromAssembleContext = (assemblyContext) => {
    if (!assemblyContext || typeof assemblyContext !== "object")
      return null;
    const agent = assemblyContext.agent;
    if (!agent || typeof agent !== "object")
      return null;
    const session = agent.session;
    const sessionId = session && typeof session === "object" ? session.id : undefined;
    const agentId = agent.id;
    const raw = sessionId !== undefined ? sessionId : agentId;
    if (typeof raw !== "string" || raw.trim().length === 0)
      return null;
    return raw;
  };
  const service = {
    select(input) {
      const budget = input.budgetTokens ?? config.defaultBudgetTokens;
      const items = [...projectItems(), ...ledgerItemsForTask(input.taskText), ...longTerm.list({ taskText: input.taskText, limit: 50 })];
      const decision = needsMemory({ taskText: input.taskText });
      if (!decision.required) {
        const empty = {
          selected: [],
          excluded: items.map((item) => ({ id: item.id, reason: decision.reason })),
          totalEstimatedTokens: 0,
          budgetTokens: budget,
          withinBudget: true,
          providerState: longTerm.status
        };
        storeScoped(input, empty);
        return empty;
      }
      const selection = selectMemory({
        taskText: input.taskText,
        budgetTokens: budget,
        items,
        providerState: longTerm.status
      });
      storeScoped(input, selection);
      return selection;
    },
    lookup(identity) {
      const resolved = identityOf(identity);
      if (!resolved)
        return null;
      return store.get(resolved) ?? null;
    },
    releaseTask(identity) {
      const resolved = identityOf(identity);
      if (!resolved)
        return false;
      const removed = store.releaseTask(resolved);
      audit("memory_selection_released", {
        sessionId: resolved.sessionId,
        detail: `scope:task task:${resolved.taskId} released:${removed ? 1 : 0} entries:${store.stats().entries}`
      });
      return removed;
    },
    releaseSession(sessionId) {
      const resolved = sessionId && typeof sessionId === "string" ? sessionId.trim() : "";
      if (resolved.length === 0)
        return 0;
      const removed = store.releaseSession(resolved);
      audit("memory_selection_released", {
        sessionId: resolved,
        detail: `scope:session released:${removed} entries:${store.stats().entries}`
      });
      return removed;
    },
    releaseAll() {
      const removed = store.clear();
      audit("memory_selection_released", {
        detail: `scope:plugin released:${removed} entries:${store.stats().entries}`
      });
      return removed;
    },
    selectionStoreStats: () => store.stats(),
    sharedKnowledge: () => projectItems(),
    tokenPressure() {
      return null;
    },
    sessionHistoryOwner: () => "DSH_CTX_SESSIONS",
    registerLongTermProvider(provider) {
      longTerm = provider;
      return () => {
        longTerm = NOOP_LONG_TERM_PROVIDER;
      };
    },
    longTermProviderState: () => longTerm.status,
    async ledgerAppend(note) {
      if (!ledger)
        return { ok: false, reason: "LEDGER_DISABLED" };
      const accepted = await ledger.append({ ...note, createdAt: note.createdAt ?? Date.now() });
      return accepted ? { ok: true } : { ok: false, reason: "LEDGER_NOTE_REJECTED" };
    },
    ledgerSelect: (taskText) => ledgerItemsForTask(taskText),
    ledgerStats: () => ledger?.stats() ?? null
  };
  ctx.provide("supremeMemoryPolicy", Object.freeze(service));
  if (ledger) {
    ctx.effect(() => () => ledger?.flush(), "supreme-memory-policy.ledger-flush");
  }
  ctx.on("session/disposed", (session) => {
    const rawId = session?.id;
    const sessionId = typeof rawId === "string" ? rawId.trim() : "";
    if (sessionId.length === 0)
      return;
    const removed = store.releaseSession(sessionId);
    audit("memory_selection_released", {
      sessionId,
      detail: `scope:session_disposed released:${removed} entries:${store.stats().entries}`
    });
  });
  ctx.effect(() => () => {
    const removed = store.clear();
    audit("memory_selection_disposed", {
      detail: `scope:plugin released:${removed} entries:${store.stats().entries}`
    });
  }, "supreme-memory-policy.selection-store-dispose");
  if (config.registerPromptSection) {
    ctx.systemPrompt.section({
      name: "supreme-memory-context",
      order: 500,
      text: (assemblyContext) => {
        const sessionId = sessionIdFromAssembleContext(assemblyContext);
        if (sessionId === null)
          return "";
        const taskId = store.activeTaskOf(sessionId);
        if (taskId === undefined)
          return "";
        const selection = store.get({ sessionId, taskId });
        if (!selection || selection.selected.length === 0)
          return "";
        return selection.selected.map(({ item }) => `[memory:${item.class}] ${item.text}`).join(`
`).slice(0, config.defaultBudgetTokens * 4);
      }
    });
  }
  ctx.logger.info("supreme-memory-policy active (budget=%d, knowledge=%d, longTerm=%s/%s, ledger=%s, instinct[minConfidence=%s maxInjected=%d relevanceRanking=%s], selectionStore[cap=%d scope=identity shared=%s])", config.defaultBudgetTokens, config.projectKnowledge.length, longTerm.name, longTerm.status, config.ledgerEnabled ? "on" : "off", String(config.minConfidence), config.maxInjected, String(config.relevanceRanking), store.stats().capacity, SHARED_KNOWLEDGE_SCOPE);
}
export {
  name,
  inject,
  apply,
  Config
};
