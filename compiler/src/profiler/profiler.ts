/**
 * Sunra performance profiler.
 *
 * The profiler is intentionally a small deterministic data model. The VM can
 * stream function enter/exit and allocation events into it, while tools can also
 * use `measure` for compiler/interpreter phases. Reports are plain JSON or
 * Markdown, making them suitable for CI artifacts as well as the CLI.
 */

import type { SunVmRuntime, SunVmValue, RunResult } from "../backend/sunvm_run.js";

export interface ProfileSample {
  functionName: string;
  calls: number;
  totalMs: number;
  selfMs: number;
  allocations: number;
  bytes: number;
}

export interface AllocationSample {
  functionName: string;
  count: number;
  bytes: number;
}

export interface ProfileReport {
  startedAt: string;
  elapsedMs: number;
  steps: number;
  allocations: number;
  outputLines: number;
  functions: ProfileSample[];
  allocationsByFunction: AllocationSample[];
  hotspots: Array<ProfileSample & { share: number }>;
}

interface ActiveFrame {
  functionName: string;
  started: number;
  childMs: number;
}

export interface ProfileEventSink {
  enter(functionName: string): void;
  exit(functionName: string): void;
  allocation(functionName: string, bytes: number): void;
}

const clock = (): number => typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

/** Collects samples from nested VM calls and allocation events. */
export class Profiler implements ProfileEventSink {
  private readonly samples = new Map<string, ProfileSample>();
  private readonly allocationSamples = new Map<string, AllocationSample>();
  private readonly stack: ActiveFrame[] = [];
  private runStarted = 0;
  private startedAt = "";
  private totalAllocations = 0;
  private totalBytes = 0;
  private totalSteps = 0;
  private outputLines = 0;

  start(): void {
    this.runStarted = clock();
    this.startedAt = new Date().toISOString();
    this.samples.clear();
    this.allocationSamples.clear();
    this.stack.length = 0;
    this.totalAllocations = 0;
    this.totalBytes = 0;
    this.totalSteps = 0;
    this.outputLines = 0;
  }

  enter(functionName: string): void {
    this.stack.push({ functionName, started: clock(), childMs: 0 });
    const sample = this.samples.get(functionName) ?? { functionName, calls: 0, totalMs: 0, selfMs: 0, allocations: 0, bytes: 0 };
    sample.calls += 1;
    this.samples.set(functionName, sample);
  }

  exit(functionName: string): void {
    const frame = this.stack.pop();
    if (!frame) return;
    const elapsed = Math.max(0, clock() - frame.started);
    const sample = this.samples.get(frame.functionName) ?? { functionName: frame.functionName, calls: 0, totalMs: 0, selfMs: 0, allocations: 0, bytes: 0 };
    sample.totalMs += elapsed;
    sample.selfMs += Math.max(0, elapsed - frame.childMs);
    this.samples.set(frame.functionName, sample);
    const parent = this.stack[this.stack.length - 1];
    if (parent) parent.childMs += elapsed;
    void functionName;
  }

  allocation(functionName: string, bytes = 0): void {
    const safeBytes = Math.max(0, Math.floor(bytes));
    const sample = this.allocationSamples.get(functionName) ?? { functionName, count: 0, bytes: 0 };
    sample.count += 1;
    sample.bytes += safeBytes;
    this.allocationSamples.set(functionName, sample);
    const functionSample = this.samples.get(functionName);
    if (functionSample) {
      functionSample.allocations += 1;
      functionSample.bytes += safeBytes;
    }
    this.totalAllocations += 1;
    this.totalBytes += safeBytes;
  }

  finish(result?: Pick<RunResult, "steps" | "allocations" | "output">): ProfileReport {
    const elapsedMs = Math.max(0, clock() - this.runStarted);
    this.totalSteps = result?.steps ?? this.totalSteps;
    this.outputLines = result?.output.length ?? this.outputLines;
    const functions = [...this.samples.values()].sort((a, b) => b.totalMs - a.totalMs || a.functionName.localeCompare(b.functionName));
    const total = functions.reduce((sum, item) => sum + item.totalMs, 0) || 1;
    const hotspots = functions.map((item) => ({ ...item, share: item.totalMs / total }));
    const allocationsByFunction = [...this.allocationSamples.values()].sort((a, b) => b.bytes - a.bytes || b.count - a.count);
    return { startedAt: this.startedAt || new Date().toISOString(), elapsedMs, steps: this.totalSteps, allocations: result?.allocations ?? this.totalAllocations, outputLines: this.outputLines, functions, allocationsByFunction, hotspots };
  }

  /** Measure any named compiler/interpreter operation. */
  measure<T>(functionName: string, action: () => T): T {
    this.enter(functionName);
    try { return action(); } finally { this.exit(functionName); }
  }
}

/** Run a loaded SunVM module while collecting the VM's trace events. */
export function profileSunVm(runtime: SunVmRuntime, entry = "main", args: SunVmValue[] = []): { result: RunResult; report: ProfileReport } {
  const profiler = new Profiler();
  profiler.start();
  runtime.setProfiler(profiler);
  try {
    const result = runtime.run(entry, args);
    return { result, report: profiler.finish(result) };
  } finally {
    runtime.setProfiler(null);
  }
}

export function reportJson(report: ProfileReport): string { return JSON.stringify(report, null, 2) + "\n"; }

export function reportMarkdown(report: ProfileReport): string {
  const lines = [
    "# Sunra Performance Profile",
    "",
    `- Started: ${report.startedAt}`,
    `- Wall time: ${report.elapsedMs.toFixed(3)} ms`,
    `- VM steps: ${report.steps.toLocaleString()}`,
    `- Allocations: ${report.allocations.toLocaleString()} (${report.allocationsByFunction.reduce((n, a) => n + a.bytes, 0).toLocaleString()} bytes tracked)`,
    "",
    "## Hotspots",
    "",
    "| Function | Calls | Total ms | Self ms | Share | Allocations | Bytes |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.hotspots.map((item) => `| ${item.functionName} | ${item.calls} | ${item.totalMs.toFixed(3)} | ${item.selfMs.toFixed(3)} | ${(item.share * 100).toFixed(2)}% | ${item.allocations} | ${item.bytes} |`),
    "",
    "## Allocation sites",
    "",
    "| Function | Count | Bytes |",
    "|---|---:|---:|",
    ...report.allocationsByFunction.map((item) => `| ${item.functionName} | ${item.count} | ${item.bytes} |`),
    "",
  ];
  return lines.join("\n");
}

export const profiler = { Profiler, profileSunVm, reportJson, reportMarkdown };
