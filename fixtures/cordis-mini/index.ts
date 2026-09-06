/**
 * cordis-mini — MINIMUM LOADER FIXTURE (documented in SOURCE-OF-TRUTH.md §3).
 *
 * This file is the ONLY fixture in the repository. It emulates the Cordis
 * plugin/composition surface that the DSH Supreme plugins are authored
 * against: definePlugin, Context with injectable services, an event bus,
 * lifecycle (apply/dispose), and a Loader that boots composition profiles
 * with topological dependency resolution, cycle detection, per-plugin
 * timings and reverse-order disposal.
 *
 * When a pinned DSH upstream becomes available, plugins switch their imports
 * from this file to the pinned Cordis API. No Supreme plugin contains any
 * logic that belongs here.
 */

/* ------------------------------------------------------------------ */
/* Core types                                                          */
/* ------------------------------------------------------------------ */

export type ServiceName = string;

export interface CordisLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type EventHandler = (payload: unknown) => void;

/** Tiny deterministic event bus. Handler errors never crash emitters. */
export interface EventBus {
  on(event: string, handler: EventHandler): () => void;
  emit(event: string, payload?: unknown): void;
  listenerCount(event?: string): number;
}

export interface Context {
  /** Name of the plugin that owns this context view. */
  readonly pluginName: string;
  /** Plugin-scoped config object coming from the composition profile. */
  readonly config: Record<string, unknown>;
  readonly logger: CordisLogger;
  readonly events: EventBus;
  /** Register a service owned by this plugin. Duplicate names throw. */
  provide<T>(name: ServiceName, service: T): void;
  /** Resolve an injected dependency. Throws ServiceNotFoundError. */
  resolve<T = unknown>(name: ServiceName): T;
  /** Resolve or return undefined (used by optional seams). */
  tryResolve<T = unknown>(name: ServiceName): T | undefined;
  /** Register an extra disposal callback executed at kernel shutdown. */
  onDispose(fn: () => void | Promise<void>): void;
}

export interface PluginDefinition {
  name: string;
  inject?: ServiceName[];
  apply(ctx: Context): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class ServiceNotFoundError extends Error {
  constructor(
    public readonly service: ServiceName,
    public readonly requester: string,
  ) {
    super(`[cordis-mini] plugin "${requester}" requires missing service "${service}"`);
    this.name = "ServiceNotFoundError";
  }
}

export class DuplicateServiceError extends Error {
  constructor(
    public readonly service: ServiceName,
    public readonly owner: string,
  ) {
    super(`[cordis-mini] service "${service}" already provided by "${owner}"`);
    this.name = "DuplicateServiceError";
  }
}

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

export interface ProfilePluginSpec {
  /** Module key; resolved through the module registry supplied to the Loader. */
  entry: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface Profile {
  name: string;
  description?: string;
  plugins: ProfilePluginSpec[];
}

export type ModuleRegistry = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* Boot result                                                         */
/* ------------------------------------------------------------------ */

export type BootPhase = "resolve" | "apply" | "dispose";

export interface BootError {
  plugin: string;
  phase: BootPhase;
  message: string;
}

export interface BootResult {
  ok: boolean;
  profileName: string;
  booted: string[];
  services: ServiceName[];
  errors: BootError[];
  /** Per-plugin apply() duration in ms (Spec §27 startup overhead). */
  timings: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* Kernel                                                              */
/* ------------------------------------------------------------------ */

interface RegistryEntry {
  value: unknown;
  owner: string;
}

function extractPlugin(module: unknown, entry: string): PluginDefinition {
  if (module && typeof module === "object") {
    const mod = module as Record<string, unknown>;
    const candidate = mod.plugin ?? mod.default;
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as PluginDefinition).name === "string" &&
      typeof (candidate as PluginDefinition).apply === "function"
    ) {
      return candidate as PluginDefinition;
    }
  }
  throw new Error(`[cordis-mini] module "${entry}" does not export a PluginDefinition`);
}

function makeEventBus(): EventBus & { emitRaw(event: string, payload: unknown): void } {
  const listeners = new Map<string, Set<EventHandler>>();
  return {
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    emit(event, payload) {
      // emitRaw never throws: a failing listener is isolated (fail-open).
      this.emitRaw(event, payload ?? {});
    },
    emitRaw(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch {
          // Isolated on purpose: observers must not crash the emitter.
        }
      }
    },
    listenerCount(event) {
      if (event !== undefined) return listeners.get(event)?.size ?? 0;
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

function makeLogger(pluginName: string): CordisLogger {
  const line = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    // Deterministic structured line; the host decides where it goes.
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    if (level === "error" || level === "warn") {
      console.error(`[cordis-mini][${level}][${pluginName}] ${message}${suffix}`);
    } else {
      console.log(`[cordis-mini][${level}][${pluginName}] ${message}${suffix}`);
    }
  };
  return {
    debug: line("debug"),
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
  };
}

export class Kernel {
  private registry = new Map<ServiceName, RegistryEntry>();
  private bus = makeEventBus();
  private disposalCallbacks: Array<{ plugin: string; fn: () => void | Promise<void> }> = [];
  private bootedPlugins: PluginDefinition[] = [];
  private booted = false;
  private disposed = false;

  getService<T = unknown>(name: ServiceName): T | undefined {
    return this.registry.get(name)?.value as T | undefined;
  }

  get services(): ServiceName[] {
    return [...this.registry.keys()];
  }

  get eventBus(): EventBus {
    return this.bus;
  }

  /** Emit an event as the harness itself (used by the fixture core + checks). */
  emitHarnessEvent(event: string, payload?: unknown): void {
    this.bus.emitRaw(event, payload ?? {});
  }

  isBooted(): boolean {
    return this.booted;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  async boot(profile: Profile, modules: ModuleRegistry): Promise<BootResult> {
    if (this.booted) throw new Error("[cordis-mini] kernel already booted");
    const errors: BootError[] = [];
    const timings: Record<string, number> = {};
    const bootedNames: string[] = [];

    // Materialize specs -> definitions.
    interface Pending {
      def: PluginDefinition;
      spec: ProfilePluginSpec;
    }
    const pending: Pending[] = [];
    for (const spec of profile.plugins) {
      if (spec.enabled === false) continue;
      try {
        const module = modules[spec.entry];
        if (module === undefined) {
          throw new Error(`entry "${spec.entry}" not found in module registry`);
        }
        pending.push({ def: extractPlugin(module, spec.entry), spec });
      } catch (err) {
        errors.push({
          plugin: spec.entry,
          phase: "resolve",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Topological boot loop (Kahn-style): boot whatever is satisfiable.
    let progressed = true;
    while (pending.length > 0 && progressed) {
      progressed = false;
      for (let i = 0; i < pending.length; i++) {
        const { def, spec } = pending[i];
        const missing = (def.inject ?? []).filter((dep) => !this.registry.has(dep));
        if (missing.length > 0) continue;

        pending.splice(i, 1);
        progressed = true;
        const started = performance.now();
        try {
          await this.applyPlugin(def, spec.config ?? {});
          bootedNames.push(def.name);
          timings[def.name] = Math.round((performance.now() - started) * 1000) / 1000;
        } catch (err) {
          errors.push({
            plugin: def.name,
            phase: "apply",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break; // registry changed; restart scan
      }
    }

    // Anything left is a cycle or unsatisfiable dependency.
    for (const { def } of pending) {
      const missing = (def.inject ?? []).filter((dep) => !this.registry.has(dep));
      errors.push({
        plugin: def.name,
        phase: "resolve",
        message:
          missing.length > 0
            ? `unsatisfied inject dependencies: ${missing.join(", ")}`
            : "circular dependency detected",
      });
    }

    this.booted = true;
    return {
      ok: errors.length === 0,
      profileName: profile.name,
      booted: bootedNames,
      services: this.services,
      errors,
      timings,
    };
  }

  private async applyPlugin(def: PluginDefinition, config: Record<string, unknown>): Promise<void> {
    const ctx = this.makeContext(def, config);
    await def.apply(ctx);
    this.bootedPlugins.push(def);
    if (typeof def.dispose === "function") {
      this.disposalCallbacks.push({ plugin: def.name, fn: () => def.dispose?.() });
    }
  }

  private makeContext(def: PluginDefinition, config: Record<string, unknown>): Context {
    const kernel = this;
    const logger = makeLogger(def.name);
    return {
      pluginName: def.name,
      config,
      logger,
      events: this.bus,
      provide<T>(name: ServiceName, service: T): void {
        if (kernel.registry.has(name)) {
          throw new DuplicateServiceError(name, def.name);
        }
        kernel.registry.set(name, { value: service, owner: def.name });
      },
      resolve<T = unknown>(name: ServiceName): T {
        const entry = kernel.registry.get(name);
        if (!entry) throw new ServiceNotFoundError(name, def.name);
        return entry.value as T;
      },
      tryResolve<T = unknown>(name: ServiceName): T | undefined {
        const entry = kernel.registry.get(name);
        return entry ? (entry.value as T) : undefined;
      },
      onDispose(fn: () => void | Promise<void>): void {
        kernel.disposalCallbacks.push({ plugin: def.name, fn });
      },
    };
  }

  /** Reverse-order disposal. Errors are isolated; every plugin still disposed. */
  async dispose(): Promise<BootError[]> {
    const errors: BootError[] = [];
    this.disposed = true;
    const fns = [...this.disposalCallbacks].reverse();
    this.disposalCallbacks = [];
    for (const { plugin, fn } of fns) {
      try {
        await fn();
      } catch (err) {
        errors.push({
          plugin,
          phase: "dispose",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const def of [...this.bootedPlugins].reverse()) {
      if (typeof def.dispose === "function" && !fns.some((f) => f.plugin === def.name)) {
        try {
          await def.dispose?.();
        } catch (err) {
          errors.push({
            plugin: def.name,
            phase: "dispose",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    this.bootedPlugins = [];
    this.registry.clear();
    return errors;
  }
}

/** Convenience: boot a profile on a fresh kernel and return both. */
export async function bootProfile(
  profile: Profile,
  modules: ModuleRegistry,
): Promise<{ kernel: Kernel; result: BootResult }> {
  const kernel = new Kernel();
  const result = await kernel.boot(profile, modules);
  return { kernel, result };
}
