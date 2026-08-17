/**
 * The Sunra debugger.
 *
 * `sunra debug file.sun` runs a program under the real interpreter and stops on
 * demand, one statement at a time. Nothing about evaluation changes: the
 * debugger receives a callback before each statement, inspects the live
 * environment and call stack, and blocks until the user says continue. A
 * debugged run therefore produces exactly the output an undebugged one does —
 * which is the whole point when the program being inspected is a paytable.
 *
 * Blocking is the interesting constraint. The interpreter is synchronous, so the
 * prompt cannot be async: `readline` would require the interpreter to yield.
 * Instead the debugger reads from the terminal with a blocking `readSync` on file
 * descriptor 0, the same technique a native debugger uses.
 *
 * Commands (abbreviations in brackets):
 *   [s]tep            execute one statement, descending into calls
 *   [n]ext            execute one statement, stepping over calls
 *   [f]inish / out    run until the current function returns
 *   [c]ontinue        run until the next breakpoint
 *   [b]reak <line>    set a breakpoint
 *   delete <line>     remove a breakpoint
 *   [i]nfo breaks     list breakpoints
 *   [l]ist            show source around the current line
 *   [p]rint <name>    print a variable
 *   [v]ars            print every visible binding
 *   [w]here / bt      print the call stack
 *   effects           print the effects of the current frame
 *   [q]uit            stop the program
 */

import { readFileSync, readSync } from "node:fs";
import { basename } from "node:path";
import { Interpreter, type DebugEvent, type DebugFrame } from "../interpreter/interpreter.js";
import { tokenize } from "../lexer/lexer.js";
import { parse } from "../parser/parser.js";
import { checkProgram } from "../checker/checker.js";
import { SunraError, renderDiagnostic } from "../diagnostics.js";
import { display, type Env, type Value } from "../runtime/values.js";
import type { Stmt } from "../parser/ast.js";

/** Thrown to abort a debugged program when the user quits. */
class QuitSignal extends Error {
  constructor() {
    super("debugger: quit");
  }
}

type Mode =
  | { k: "run" } // continue to the next breakpoint
  | { k: "step" } // stop at the next statement, any depth
  | { k: "next"; depth: number } // stop at the next statement at this depth or shallower
  | { k: "finish"; depth: number }; // stop when the stack is shallower than this

const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  amber: "\x1b[38;5;214m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  grey: "\x1b[90m",
};

export interface DebugOptions {
  seed?: string | number;
  stepLimit?: number;
  /** Lines to break on before the program starts. */
  breakpoints?: number[];
  /** Stop at the first statement rather than running to a breakpoint. */
  stopOnEntry?: boolean;
  /** Scripted commands, used by the tests instead of a terminal. */
  script?: string[];
}

export class Debugger {
  private readonly lines: string[];
  private readonly breakpoints = new Set<number>();
  private mode: Mode;
  private lastListedLine = 0;
  /** Queued commands, either from `--script` or from a terminal read. */
  private readonly queue: string[] = [];
  private readonly scripted: boolean;

  constructor(
    private readonly source: string,
    private readonly file: string,
    private readonly options: DebugOptions = {},
  ) {
    this.lines = source.split("\n");
    for (const line of options.breakpoints ?? []) this.breakpoints.add(line);
    this.scripted = Array.isArray(options.script);
    if (options.script) this.queue.push(...options.script);

    // With no breakpoints there is nothing to run *to*, so entry is the only
    // sensible place to stop.
    const stopOnEntry = options.stopOnEntry === true || this.breakpoints.size === 0;
    this.mode = stopOnEntry ? { k: "step" } : { k: "run" };
  }

  /** Run the program under debugger control. Returns the exit code. */
  run(): number {
    let program;
    try {
      program = parse(tokenize(this.source, this.file));
    } catch (error) {
      if (error instanceof SunraError) {
        process.stderr.write(renderDiagnostic(error, this.source) + "\n");
        return 1;
      }
      throw error;
    }

    const check = checkProgram(program);
    if (check.errors.length > 0) {
      for (const error of check.errors) {
        process.stderr.write(renderDiagnostic(error, this.source) + "\n");
      }
      this.say(`${check.errors.length} error(s); nothing was run.`, COLOR.red);
      return 1;
    }

    this.banner();

    const interpreter = new Interpreter({
      seed: this.options.seed,
      stepLimit: this.options.stepLimit,
      onStatement: (event) => this.onStatement(event),
    });

    try {
      const result = interpreter.run(program);
      this.say(`\nprogram finished after ${result.steps.toLocaleString()} steps.`, COLOR.green);
      return 0;
    } catch (error) {
      if (error instanceof QuitSignal) {
        this.say("\nstopped by the debugger.", COLOR.grey);
        return 0;
      }
      if (error instanceof SunraError) {
        process.stderr.write("\n" + renderDiagnostic(error, this.source) + "\n");
        return 1;
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ stepping

  private onStatement(event: DebugEvent): void {
    const line = event.stmt.span.line;
    const depth = event.stack.length;

    let stop = false;
    if (this.breakpoints.has(line)) stop = true;
    else if (this.mode.k === "step") stop = true;
    else if (this.mode.k === "next") stop = depth <= this.mode.depth;
    else if (this.mode.k === "finish") stop = depth < this.mode.depth;

    if (!stop) return;

    // Once a scripted session runs out of commands there is nobody left to ask,
    // so the program must run to completion rather than stop at every line.
    if (this.scripted && this.queue.length === 0) {
      this.mode = { k: "run" };
      return;
    }

    this.showStop(event);
    this.prompt(event);
  }

  /** Read commands until one of them resumes execution. */
  private prompt(event: DebugEvent): void {
    for (;;) {
      const input = this.readCommand();
      if (input === null) {
        // End of input: behave like `continue` so a piped session terminates.
        this.mode = { k: "run" };
        return;
      }

      const resumed = this.execute(input.trim(), event);
      if (resumed) return;
    }
  }

  /**
   * Execute one debugger command. Returns true when the program should resume.
   */
  private execute(input: string, event: DebugEvent): boolean {
    if (input === "") {
      // Bare Enter repeats the most useful action.
      this.mode = { k: "step" };
      return true;
    }

    const [command, ...rest] = input.split(/\s+/);
    const argument = rest.join(" ");
    const depth = event.stack.length;

    switch (command) {
      case "s":
      case "step":
        this.mode = { k: "step" };
        return true;

      case "n":
      case "next":
        this.mode = { k: "next", depth };
        return true;

      case "f":
      case "finish":
      case "out":
        if (depth <= 1) {
          this.say("already at the outermost frame; use `continue`.", COLOR.grey);
          return false;
        }
        this.mode = { k: "finish", depth };
        return true;

      case "c":
      case "cont":
      case "continue":
        this.mode = { k: "run" };
        return true;

      case "b":
      case "break": {
        const target = Number(argument);
        if (!Number.isInteger(target) || target < 1 || target > this.lines.length) {
          this.say(`no line ${argument} in ${basename(this.file)}.`, COLOR.red);
          return false;
        }
        this.breakpoints.add(target);
        this.say(`breakpoint set at line ${target}: ${this.lines[target - 1]?.trim() ?? ""}`);
        return false;
      }

      case "delete":
      case "clear": {
        const target = Number(argument);
        if (this.breakpoints.delete(target)) this.say(`breakpoint at line ${target} removed.`);
        else this.say(`no breakpoint at line ${target}.`, COLOR.grey);
        return false;
      }

      case "i":
      case "info":
        if (argument.startsWith("break")) this.listBreakpoints();
        else if (argument.startsWith("frame")) this.showFrame(event.stack[event.stack.length - 1]);
        else this.say("info breaks | info frame", COLOR.grey);
        return false;

      case "l":
      case "list":
        this.listSource(Number(argument) || event.stmt.span.line);
        return false;

      case "p":
      case "print":
        this.printBinding(argument, event.env);
        return false;

      case "v":
      case "vars":
        this.printVars(event.env);
        return false;

      case "w":
      case "where":
      case "bt":
      case "backtrace":
        this.printStack(event.stack);
        return false;

      case "effects":
        this.printEffects(event.stack);
        return false;

      case "h":
      case "help":
      case "?":
        this.help();
        return false;

      case "q":
      case "quit":
      case "exit":
        throw new QuitSignal();

      default:
        this.say(`unknown command \`${command}\`; type \`help\`.`, COLOR.red);
        return false;
    }
  }

  // ------------------------------------------------------------------ display

  private banner(): void {
    const name = basename(this.file);
    this.say(`${COLOR.amber}Sunra debugger${COLOR.reset} — ${name}`);
    this.say(
      `${this.breakpoints.size} breakpoint(s). Type \`help\` for commands, \`c\` to run.`,
      COLOR.grey,
    );
  }

  private showStop(event: DebugEvent): void {
    const line = event.stmt.span.line;
    const frame = event.stack[event.stack.length - 1];
    const where = frame ? frame.name : "<top level>";
    const reason = this.breakpoints.has(line) ? "breakpoint" : "step";

    this.say("");
    this.say(
      `${COLOR.amber}${reason}${COLOR.reset} at ${COLOR.bold}${basename(this.file)}:${line}${COLOR.reset} in ${COLOR.cyan}${where}${COLOR.reset}`,
    );
    this.showLine(line);
  }

  private showLine(line: number): void {
    const text = this.lines[line - 1] ?? "";
    this.say(`  ${String(line).padStart(4)} │ ${text}`);
  }

  private listSource(centre: number): void {
    const from = Math.max(1, centre - 5);
    const to = Math.min(this.lines.length, centre + 5);
    for (let i = from; i <= to; i++) {
      const marker = this.breakpoints.has(i) ? `${COLOR.red}●${COLOR.reset}` : " ";
      const cursor = i === centre ? `${COLOR.amber}▶${COLOR.reset}` : " ";
      this.say(`${marker}${cursor} ${String(i).padStart(4)} │ ${this.lines[i - 1] ?? ""}`);
    }
    this.lastListedLine = centre;
  }

  private listBreakpoints(): void {
    if (this.breakpoints.size === 0) {
      this.say("no breakpoints.", COLOR.grey);
      return;
    }
    for (const line of [...this.breakpoints].sort((a, b) => a - b)) {
      this.say(`  ${String(line).padStart(4)} │ ${this.lines[line - 1]?.trim() ?? ""}`);
    }
  }

  private printBinding(name: string, env: Env): void {
    if (!name) {
      this.say("usage: print <name>", COLOR.grey);
      return;
    }
    const value = env.get(name);
    if (value === undefined) {
      this.say(`\`${name}\` is not in scope here.`, COLOR.red);
      return;
    }
    this.say(`  ${COLOR.cyan}${name}${COLOR.reset} = ${this.render(value)}`);
  }

  /**
   * Print every binding visible from a scope. Walking the parent chain shows
   * shadowing honestly: an inner binding is listed, and the shadowed outer one
   * is marked rather than silently dropped.
   */
  private printVars(env: Env): void {
    const seen = new Set<string>();
    let scope: Env | null = env;
    let level = 0;

    while (scope) {
      const names = scope
        .names()
        .filter((name) => !this.isBuiltinName(name))
        .sort();

      if (names.length > 0) {
        this.say(level === 0 ? "  locals:" : `  enclosing (${level}):`, COLOR.grey);
        for (const name of names) {
          const value = scope.get(name);
          const shadowed = seen.has(name) ? ` ${COLOR.grey}(shadowed)${COLOR.reset}` : "";
          seen.add(name);
          this.say(`    ${COLOR.cyan}${name}${COLOR.reset} = ${this.render(value!)}${shadowed}`);
        }
      }
      scope = scope.parent;
      level += 1;
    }
  }

  private printStack(stack: DebugFrame[]): void {
    for (let i = stack.length - 1; i >= 0; i--) {
      const frame = stack[i];
      const marker = i === stack.length - 1 ? `${COLOR.amber}▶${COLOR.reset}` : " ";
      const site = frame.callSite ? ` called from line ${frame.callSite.line}` : "";
      const effects = frame.effects.length > 0 ? ` ${COLOR.grey}uses ${frame.effects.join(", ")}${COLOR.reset}` : "";
      this.say(`${marker} #${stack.length - 1 - i} ${COLOR.cyan}${frame.name}${COLOR.reset}${site}${effects}`);
    }
  }

  private printEffects(stack: DebugFrame[]): void {
    const frame = stack[stack.length - 1];
    if (!frame) return;
    if (frame.effects.length === 0) {
      this.say(
        `${frame.name} is pure: it cannot read the random source, print, or reach the network.`,
        COLOR.green,
      );
      return;
    }
    this.say(`${frame.name} declares ${frame.effects.map((e) => `\`${e}\``).join(", ")}.`);
  }

  private showFrame(frame: DebugFrame | undefined): void {
    if (!frame) return;
    this.say(`frame ${COLOR.cyan}${frame.name}${COLOR.reset}`);
    this.printVars(frame.env);
  }

  private help(): void {
    const rows: Array<[string, string]> = [
      ["s / step", "one statement, entering calls"],
      ["n / next", "one statement, stepping over calls"],
      ["f / finish", "run until the current function returns"],
      ["c / continue", "run to the next breakpoint"],
      ["b <line>", "set a breakpoint"],
      ["delete <line>", "remove a breakpoint"],
      ["info breaks", "list breakpoints"],
      ["l / list [line]", "show surrounding source"],
      ["p <name>", "print one binding"],
      ["v / vars", "print every visible binding"],
      ["w / bt", "print the call stack"],
      ["effects", "effects declared by the current frame"],
      ["q / quit", "stop the program"],
      ["<Enter>", "repeat `step`"],
    ];
    for (const [command, description] of rows) {
      this.say(`  ${command.padEnd(16)} ${COLOR.grey}${description}${COLOR.reset}`);
    }
  }

  private render(value: Value): string {
    const text = display(value);
    // A long list is more useful truncated than wrapped across the terminal.
    return text.length > 220 ? `${text.slice(0, 217)}...` : text;
  }

  /** Builtins would drown the variable list; they are documented elsewhere. */
  private isBuiltinName(name: string): boolean {
    return BUILTIN_NAMES.has(name);
  }

  private say(text: string, color?: string): void {
    process.stdout.write(color ? `${color}${text}${COLOR.reset}\n` : `${text}\n`);
  }

  // ------------------------------------------------------------------- input

  /**
   * Read one command, blocking the interpreter. `readSync` on fd 0 is what makes
   * this possible without turning the interpreter async.
   */
  private readCommand(): string | null {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.say(`${COLOR.dim}(sunra)${COLOR.reset} ${next}`);
      return next;
    }
    if (this.scripted) return null;

    process.stdout.write(`${COLOR.amber}(sunra)${COLOR.reset} `);

    const chunk = Buffer.alloc(1024);
    let text = "";
    for (;;) {
      let read = 0;
      try {
        read = readSync(0, chunk, 0, chunk.length, null);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "EAGAIN") continue; // the tty was not ready yet
        if (code === "EOF") return null;
        throw error;
      }
      if (read === 0) return text.length > 0 ? text : null;

      text += chunk.subarray(0, read).toString("utf8");
      const newline = text.indexOf("\n");
      if (newline !== -1) {
        const line = text.slice(0, newline);
        // Anything after the newline belongs to later commands.
        const remainder = text.slice(newline + 1);
        if (remainder.trim().length > 0) {
          for (const extra of remainder.split("\n")) {
            if (extra.trim().length > 0) this.queue.push(extra);
          }
        }
        return line;
      }
    }
  }
}

/**
 * Names installed by the interpreter itself. Listing them under `vars` would
 * bury the user's own bindings.
 */
const BUILTIN_NAMES = new Set([
  "print",
  "println",
  "len",
  "abs",
  "min",
  "max",
  "floor",
  "ceil",
  "round",
  "sqrt",
  "str",
  "int",
  "float",
  "range",
  "assert",
  "sum",
  "push",
  "sort",
  "rng",
  "Reel",
  "Deck",
  "Card",
  "Baccarat",
  "Poker",
  "Dice",
  "Money",
  "Fair",
  "Rtp",
  "Math",
  "String",
  "Array",
  "Json",
  "Crypto",
  "Timer",
  "Http",
  "File",
  "audit",
]);

/** Entry point for `sunra debug`. */
export function runDebugger(file: string, options: DebugOptions = {}): number {
  const source = readFileSync(file, "utf8");
  return new Debugger(source, file, options).run();
}

export type { Stmt };
