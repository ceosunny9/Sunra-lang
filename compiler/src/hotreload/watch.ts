/**
 * Hot reload for SunVM development and operator tooling.
 *
 * `HotReloadSession` compiles a source file through the same checked HIR → MIR →
 * optimiser → SunVM path as `sunra build --target vm`. `watch` is a thin,
 * cancellable fs watcher around that session. Host imports and the session state
 * map survive a code swap; a bad edit leaves the last good module loaded.
 */

import { readFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, resolve } from "node:path";
import { analyze } from "../browser/index.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { lowerToHir } from "../hir/lower.js";
import { inferOwnership } from "../own/ownership.js";
import { buildMir } from "../mir/build.js";
import { optimize } from "../opt/optimize.js";
import { refineModule } from "../refine/refine.js";
import { compileToSunVm, type SunVmCompileResult } from "../backend/sunvm.js";
import { SunVmRuntime, type RunResult, type SunVmValue } from "../backend/sunvm_run.js";

export interface HotReloadDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  line?: number;
}

export interface ReloadEvent {
  type: "loaded" | "unchanged" | "rejected" | "error";
  path: string;
  generation: number;
  digest: string | null;
  diagnostics: HotReloadDiagnostic[];
  timestamp: string;
}

export interface HotReloadOptions {
  profile?: "rgs" | "open";
  debounceMs?: number;
  onReload?: (event: ReloadEvent) => void;
}

export interface WatchHandle {
  close(): void;
  readonly closed: boolean;
}

export type HotReloadValue = SunVmValue | Uint8Array | string;

function diagnosticList(source: string, path: string): HotReloadDiagnostic[] {
  return analyze(source).diagnostics.map((item) => ({ severity: item.severity === "error" ? "error" : "warning", code: item.code, message: item.message, line: item.line }));
}

function compileSource(source: string, path: string, profile: "rgs" | "open"): SunVmCompileResult {
  const program = new Parser(new Lexer(source, path).tokenize()).parseProgram();
  const hir = lowerToHir(program, basename(path));
  const ownership = inferOwnership(hir);
  const mir = buildMir(hir, ownership);
  const optimized = optimize(mir, { refine: refineModule(hir) }).module;
  return compileToSunVm(optimized, { profile });
}

export class HotReloadSession {
  readonly runtime: SunVmRuntime;
  readonly state = new Map<string, HotReloadValue>();
  private readonly profile: "rgs" | "open";
  private sourcePath: string | null = null;
  private lastSource = "";
  private lastEvent: ReloadEvent | null = null;

  constructor(options: HotReloadOptions = {}, runtime = new SunVmRuntime()) {
    this.runtime = runtime;
    this.profile = options.profile ?? "rgs";
  }

  get path(): string | null { return this.sourcePath; }
  get event(): ReloadEvent | null { return this.lastEvent; }
  get generation(): number { return this.runtime.reloads; }
  get digest(): string | null { return this.runtime.digest; }

  /** Bind an import once; bindings are retained across every reload. */
  bind(name: string, fn: (args: SunVmValue[]) => SunVmValue): void { this.runtime.bind(name, fn); }

  load(source: string, path = this.sourcePath ?? "main.sun"): ReloadEvent {
    this.sourcePath = resolve(path);
    const timestamp = new Date().toISOString();
    const diagnostics = diagnosticList(source, this.sourcePath);
    const errors = diagnostics.filter((item) => item.severity === "error");
    if (errors.length > 0) {
      return this.commit({ type: "rejected", path: this.sourcePath, generation: this.runtime.reloads, digest: this.runtime.digest, diagnostics, timestamp });
    }
    try {
      const artifact = compileSource(source, this.sourcePath, this.profile);
      if (artifact.rejected.length > 0 && this.profile === "rgs") {
        const compileDiagnostics = artifact.rejected.map((error) => ({ severity: "error" as const, code: "EVM00", message: `${error.symbol}: ${error.reason}` }));
        return this.commit({ type: "rejected", path: this.sourcePath, generation: this.runtime.reloads, digest: this.runtime.digest, diagnostics: [...diagnostics, ...compileDiagnostics], timestamp });
      }
      const loaded = this.runtime.load(artifact.bytes);
      this.lastSource = source;
      return this.commit({ type: loaded.changed ? "loaded" : "unchanged", path: this.sourcePath, generation: loaded.generation, digest: loaded.digest, diagnostics, timestamp });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.commit({ type: "error", path: this.sourcePath, generation: this.runtime.reloads, digest: this.runtime.digest, diagnostics: [...diagnostics, { severity: "error", code: "EHR01", message }], timestamp });
    }
  }

  loadFile(path: string): ReloadEvent {
    const absolute = resolve(path);
    return this.load(readFileSync(absolute, "utf8"), absolute);
  }

  run(entry = "main", args: SunVmValue[] = []): RunResult {
    return this.runtime.run(entry, args);
  }

  /** Explicit state APIs make preservation visible and testable to host servers. */
  setState(key: string, value: HotReloadValue): void { this.state.set(key, value); }
  getState(key: string): HotReloadValue | undefined { return this.state.get(key); }
  snapshotState(): Record<string, HotReloadValue> { return Object.fromEntries(this.state.entries()); }
  restoreState(snapshot: Record<string, HotReloadValue>): void { for (const [key, value] of Object.entries(snapshot)) this.state.set(key, value); }

  watch(path: string, options: HotReloadOptions = {}): WatchHandle {
    const absolute = resolve(path);
    this.loadFile(absolute);
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watcher: FSWatcher | null = null;
    const debounceMs = options.debounceMs ?? 80;
    const emit = options.onReload;
    watcher = fsWatch(absolute, () => {
      if (closed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (closed) return;
        const event = this.loadFile(absolute);
        emit?.(event);
      }, debounceMs);
    });
    return {
      close: () => {
        closed = true;
        if (timer) clearTimeout(timer);
        watcher?.close();
        watcher = null;
      },
      get closed() { return closed; },
    };
  }

  private commit(event: ReloadEvent): ReloadEvent {
    this.lastEvent = event;
    return event;
  }
}

export async function watchFile(path: string, options: HotReloadOptions = {}): Promise<never> {
  const session = new HotReloadSession(options);
  const initial = session.loadFile(path);
  options.onReload?.(initial);
  const handle = session.watch(path, options);
  await new Promise<void>((resolveStop) => {
    const stop = () => { handle.close(); resolveStop(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  throw new Error("watch stopped");
}

export const hotReload = { HotReloadSession, watchFile };
