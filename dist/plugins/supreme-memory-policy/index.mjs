// dsh-supreme/src/plugins/supreme-memory-policy/index.ts
import { z } from "zod";

// dsh-supreme/src/plugins/supreme-memory-policy/engine.ts
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

// dsh-supreme/src/plugins/supreme-memory-policy/index.ts
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
  })).default([])
});
function apply(ctx, config) {
  const tokenMeter = ctx.get("tokenMeter");
  let longTerm = NOOP_LONG_TERM_PROVIDER;
  let latestSelection = null;
  const projectItems = () => config.projectKnowledge.map((entry) => ({
    id: entry.id,
    class: "PROJECT_CONTEXT",
    source: "config.projectKnowledge",
    text: entry.text,
    estimatedTokens: estimateTokens(entry.text),
    priority: entry.priority,
    tags: entry.tags
  }));
  const service = {
    select(input) {
      const budget = input.budgetTokens ?? config.defaultBudgetTokens;
      const items = [...projectItems(), ...longTerm.list({ taskText: input.taskText, limit: 50 })];
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
        latestSelection = empty;
        return empty;
      }
      const selection = selectMemory({
        taskText: input.taskText,
        budgetTokens: budget,
        items,
        providerState: longTerm.status
      });
      latestSelection = selection;
      return selection;
    },
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
    longTermProviderState: () => longTerm.status
  };
  ctx.provide("supremeMemoryPolicy", Object.freeze(service));
  if (config.registerPromptSection) {
    ctx.systemPrompt.section({
      name: "supreme-memory-context",
      order: 500,
      text: () => {
        if (!latestSelection || latestSelection.selected.length === 0)
          return "";
        return latestSelection.selected.map(({ item }) => `[memory:${item.class}] ${item.text}`).join(`
`).slice(0, config.defaultBudgetTokens * 4);
      }
    });
  }
  ctx.logger.info("supreme-memory-policy active (budget=%d, knowledge=%d, longTerm=%s/%s)", config.defaultBudgetTokens, config.projectKnowledge.length, longTerm.name, longTerm.status);
}
export {
  name,
  inject,
  apply,
  Config
};
