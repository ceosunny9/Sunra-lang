/**
 * A programmatic debug session.
 *
 * `sunra debug` is an interactive terminal debugger: it blocks on file
 * descriptor 0 and prints coloured output. That is the right shape for a human
 * and the wrong shape for everything else — an editor's debug adapter, the
 * playground, or a test that wants to assert "after two steps, `w` is 4".
 *
 * `DebugSession` exposes the same capabilities as data. It drives the real
 * interpreter through the same `onStatement` hook the terminal debugger uses, so
 * evaluation is identical; the difference is only that stopping produces a
 * `StopEvent` object instead of a prompt.
 *
 * The interpreter is synchronous, so stepping cannot be modelled as "return from
 * run() and resume later" without generators. Instead the session runs the
 * program once and records every stop: `stops` is the ordered trace of the
 * points where control would have been handed to the user, each with its line,
 * call stack and visible variables. Breakpoint and stepping policy decide which
 * statements become stops, exactly as in the interactive debugger.
 */

import { Interpreter, type DebugEvent } from "../interpreter/interpreter.js";
import { tokenize } from "../lexer/lexer.js";
import { parse } from "../parser/parser.js";
import { checkProgram } from "../checker/checker.js";
import { SunraError } from "../diagnostics.js";
import { display, type Env, type Value } from "../runtime/values.js";

/** How execution advances after a stop. */
export type StepMode =
  /** Stop at the next statement, descending into calls. */
  | "into"
  /** Stop at the next statement at this depth or shallower (step over calls). */
  | "over"
  /** Run until the current function returns. */
  | "out"
  /** Run to the next breakpoint. */
  | "continue";

export interface StackFrame {
  /** Function name, or `main` for the top level. */
  name: string;
  line: number;
  /** Declared effects of the frame, so an audit can see where `rand` is used. */
  effects: string[];
}

export interface StopEvent {
  /** Why the session stopped here. */
  reason: "entry" | "breakpoint" | "step";
  line: number;
  /** Source text of the line, trimmed. */
  text: string;
  /** Innermost frame first. */
  stack: StackFrame[];
  /**
   * Bindings introduced by the program that are visible here, innermost scope
   * winning. Builtins and runtime namespaces are excluded, because "what is `w`
   * right now" is the question a debugger is asked — not "what is `print`".
   */
  variables: Record<string, string>;
  /** Every visible binding, including builtins and runtime namespaces. */
  scope: Record<string, string>;
  /** Stack depth, 1 at the top level. */
  depth: number;
}

export interface DebugSessionOptions {
  /** Lines to break on. */
  breakpoints?: number[];
  /** Stop at the first statement even without a breakpoint. Defaults to true. */
  stopOnEntry?: boolean;
  /**
   * Stepping policy applied at each stop, consumed in order. When it runs out
   * the session continues to the next breakpoint. `["into", "into"]` therefore
   * means "stop at entry, then single-step twice, then run".
   */
  steps?: StepMode[];
  /** Maximum number of stops to record, as a runaway guard. Defaults to 500. */
  maxStops?: number;
  seed?: string | number;
  stepLimit?: number;
}

export interface DebugSessionResult {
  /** False when the program did not type-check; `diagnostics` explains why. */
  ok: boolean;
  diagnostics: SunraError[];
  /** Ordered trace of the points where the session stopped. */
  stops: StopEvent[];
  /** Program output, so a debugged run can be compared with a plain one. */
  output: string[];
  /** Interpreter steps executed. */
  steps: number;
}

type Mode =
  | { k: "run" }
  | { k: "step" }
  | { k: "next"; depth: number }
  | { k: "finish"; depth: number };

export class DebugSession {
  private readonly lines: string[];
  private readonly breakpoints: Set<number>;
  private readonly plan: StepMode[];
  private readonly maxStops: number;
  private mode: Mode;
  private readonly stops: StopEvent[] = [];

  constructor(
    private readonly source: string,
    private readonly file: string,
    private readonly options: DebugSessionOptions = {},
  ) {
    this.lines = source.split("\n");
    this.breakpoints = new Set(options.breakpoints ?? []);
    this.plan = [...(options.steps ?? [])];
    this.maxStops = options.maxStops ?? 500;
    const stopOnEntry = options.stopOnEntry !== false;
    this.mode = stopOnEntry || this.breakpoints.size === 0 ? { k: "step" } : { k: "run" };
  }

  /** Add a breakpoint. Returns false when one was already set on that line. */
  setBreakpoint(line: number): boolean {
    if (this.breakpoints.has(line)) return false;
    this.breakpoints.add(line);
    return true;
  }

  /** Remove a breakpoint. Returns false when there was nothing to remove. */
  clearBreakpoint(line: number): boolean {
    return this.breakpoints.delete(line);
  }

  /** The breakpoints currently set, ascending. */
  get breakpointLines(): number[] {
    return [...this.breakpoints].sort((a, b) => a - b);
  }

  /** Run the program, recording a stop wherever the policy says to stop. */
  run(): DebugSessionResult {
    const output: string[] = [];

    let program;
    try {
      program = parse(tokenize(this.source, this.file));
    } catch (error) {
      if (error instanceof SunraError) {
        return { ok: false, diagnostics: [error], stops: [], output, steps: 0 };
      }
      throw error;
    }

    const check = checkProgram(program);
    if (check.errors.length > 0) {
      return { ok: false, diagnostics: check.errors, stops: [], output, steps: 0 };
    }

    const interpreter = new Interpreter({
      seed: this.options.seed,
      stepLimit: this.options.stepLimit,
      stdout: (line: string) => output.push(line),
      onStatement: (event: DebugEvent) => this.onStatement(event),
    });

    try {
      const result = interpreter.run(program);
      return {
        ok: true,
        diagnostics: [],
        stops: this.stops,
        output: output.length > 0 ? output : result.output,
        steps: result.steps,
      };
    } catch (error) {
      if (error instanceof SunraError) {
        return { ok: false, diagnostics: [error], stops: this.stops, output, steps: 0 };
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- internals

  private onStatement(event: DebugEvent): void {
    const line = event.stmt.span.line;
    const depth = Math.max(1, event.stack.length);

    const hitBreakpoint = this.breakpoints.has(line);
    let stop = hitBreakpoint;
    if (!stop) {
      if (this.mode.k === "step") stop = true;
      else if (this.mode.k === "next") stop = depth <= this.mode.depth;
      else if (this.mode.k === "finish") stop = depth < this.mode.depth;
    }
    if (!stop) return;
    if (this.stops.length >= this.maxStops) {
      this.mode = { k: "run" };
      return;
    }

    const reason: StopEvent["reason"] =
      this.stops.length === 0 && !hitBreakpoint ? "entry" : hitBreakpoint ? "breakpoint" : "step";

    const scope = this.variablesOf(event);
    this.stops.push({
      reason,
      line,
      text: (this.lines[line - 1] ?? "").trim(),
      stack: this.framesOf(event),
      variables: userBindings(scope),
      scope,
      depth,
    });

    // Apply the next scripted action. With nothing left, run to the next
    // breakpoint so the program terminates instead of stopping forever.
    const next = this.plan.shift() ?? "continue";
    switch (next) {
      case "into":
        this.mode = { k: "step" };
        return;
      case "over":
        this.mode = { k: "next", depth };
        return;
      case "out":
        this.mode = { k: "finish", depth };
        return;
      case "continue":
        this.mode = { k: "run" };
        return;
    }
  }

  private framesOf(event: DebugEvent): StackFrame[] {
    // `event.stack` is innermost last; a debug adapter expects innermost first.
    const frames = [...event.stack].reverse().map((frame) => ({
      name: frame.name,
      line: frame.callSite?.line ?? event.stmt.span.line,
      effects: [...frame.effects],
    }));
    if (frames.length === 0) {
      frames.push({ name: "main", line: event.stmt.span.line, effects: [] });
    }
    return frames;
  }

  private variablesOf(event: DebugEvent): Record<string, string> {
    const visible: Record<string, string> = {};
    // Walk outermost scope first so an inner binding shadows an outer one.
    const chain: Env[] = [];
    for (let env: Env | null = event.env; env; env = env.parent) chain.push(env);
    for (const env of chain.reverse()) {
      for (const name of env.names()) {
        const value = env.get(name);
        if (value === undefined) continue;
        visible[name] = display(value as Value);
      }
    }
    return visible;
  }
}

/** Convenience wrapper: run `source` under a session and return the result. */
export function debugSource(
  source: string,
  file: string,
  options: DebugSessionOptions = {},
): DebugSessionResult {
  return new DebugSession(source, file, options).run();
}

/**
 * Drop bindings that came with the language rather than with the program.
 * Builtins and runtime namespaces display as `<native …>`, `<module …>` and
 * `<fn …>`, which is exactly the noise a variables pane should not show first.
 */
function userBindings(scope: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(scope)) {
    if (/^<(native|module|fn|game) /.test(value)) continue;
    out[name] = value;
  }
  return out;
}
