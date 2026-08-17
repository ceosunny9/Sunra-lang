import { runtimeError, SunraError, type Span } from "../diagnostics.js";
import type {
  BlockStmt,
  Expr,
  FnDecl,
  GameDecl,
  Program,
  Stmt,
} from "../parser/ast.js";
import {
  bool,
  display,
  Env,
  float,
  int,
  list,
  money,
  moneyToNumber,
  namespace,
  native,
  numeric,
  record,
  str,
  truthy,
  typeNameOf,
  UNIT,
  valueEquals,
  type Value,
} from "../runtime/values.js";
import { SecureRng, SimRng, type SunraRng } from "../runtime/rng.js";
import {
  makeBaccaratNamespace,
  makeCardNamespace,
  makeDeckNamespace,
  makeDiceNamespace,
  makeFairNamespace,
  makeMathNamespace,
  makeMoneyNamespace,
  makePokerNamespace,
  makeReelNamespace,
  makeRngNamespace,
  makeRtpNamespace,
} from "../runtime/gaming.js";
import { installExtendedStdlib } from "../runtime/stdlib.js";

class ReturnSignal {
  constructor(readonly value: Value) {}
}
class BreakSignal {}
class ContinueSignal {}

export interface InterpreterOptions {
  /** Seed for the deterministic generator; when absent a secure source is used. */
  seed?: string | number;
  /** Where `print` writes. */
  stdout?: (line: string) => void;
  /** Maximum statement steps, guarding against runaway loops. */
  stepLimit?: number;
  /** Maximum nested user-function calls before a controlled runtime error. */
  maxCallDepth?: number;
  /** Maximum lines retained in the result output buffer. */
  maxOutputLines?: number;
  /** Maximum UTF-8 bytes retained in the result output buffer. */
  maxOutputBytes?: number;
  /**
   * Instrumentation for the debugger. Called immediately before each statement
   * executes, with the statement, its environment, and the live call stack.
   *
   * The interpreter stays in charge of evaluation: the hook may inspect state
   * and block (synchronously), but it cannot change control flow. That keeps a
   * debugged run identical to an undebugged one, which is the property that
   * makes stepping through a paytable trustworthy.
   */
  onStatement?: (event: DebugEvent) => void;
}

/** A frame on the interpreter's call stack, as the debugger sees it. */
export interface DebugFrame {
  /** Function name, or `<top level>` for the implicit outermost frame. */
  name: string;
  /** Where the call was made from, when known. */
  callSite: Span | null;
  /** The frame's local environment. */
  env: Env;
  /** Effects the function declares, for display alongside the frame. */
  effects: string[];
}

/** What the debugger is told before every statement. */
export interface DebugEvent {
  stmt: Stmt;
  env: Env;
  /** Innermost frame last. */
  stack: DebugFrame[];
  steps: number;
}

export interface RunResult {
  value: Value;
  output: string[];
  steps: number;
}

export class Interpreter {
  private readonly globals = new Env();
  private rng: SunraRng;
  private readonly output: string[] = [];
  private readonly write: (line: string) => void;
  private outputBytes = 0;
  private outputTruncated = false;
  private steps = 0;
  private readonly stepLimit: number;
  private readonly maxCallDepth: number;
  private readonly maxOutputLines: number;
  private readonly maxOutputBytes: number;
  private readonly tests: Array<{ name: string; body: BlockStmt }> = [];
  private readonly games = new Map<string, Value>();
  /** Live call stack, maintained only so the debugger can report it. */
  private readonly frames: DebugFrame[] = [];
  private readonly onStatement: ((event: DebugEvent) => void) | null;

  constructor(private readonly options: InterpreterOptions = {}) {
    this.rng = options.seed === undefined ? new SecureRng() : new SimRng(options.seed);
    this.stepLimit = normalizeLimit(options.stepLimit, 200_000_000);
    this.maxCallDepth = normalizeLimit(options.maxCallDepth, 1_024);
    this.maxOutputLines = normalizeLimit(options.maxOutputLines, 100_000);
    this.maxOutputBytes = normalizeLimit(options.maxOutputBytes, 10_000_000);
    this.onStatement = options.onStatement ?? null;
    this.write =
      options.stdout ??
      ((line: string) => {
        console.log(line);
      });
    this.installBuiltins();
  }

  /** The live call stack. Exposed for the debugger; empty when not running. */
  get callStack(): DebugFrame[] {
    return this.frames;
  }

  /** The global environment, so a debugger can evaluate against it. */
  get globalEnv(): Env {
    return this.globals;
  }

  get currentRng(): SunraRng {
    return this.rng;
  }

  get collectedTests(): Array<{ name: string; body: BlockStmt }> {
    return this.tests;
  }

  get gameRegistry(): Map<string, Value> {
    return this.games;
  }

  // ------------------------------------------------------------- builtins

  private installBuiltins(): void {
    const host = {
      current: () => this.rng,
      setCurrent: (r: SunraRng) => {
        this.rng = r;
      },
      callFunction: (fn: Value, args: Value[]) => this.callValue(fn, args, null),
    };

    const g = this.globals;

    g.declare(
      "print",
      native("print", -1, (args) => {
        const line = args.map(display).join(" ");
        this.emitOutput(line);
        return UNIT;
      }),
    );
    g.declare("println", g.get("print")!);

    g.declare(
      "len",
      native("len", 1, (args) => {
        const v = args[0];
        if (v.t === "list") return int(v.v.length);
        if (v.t === "str") return int([...v.v].length);
        if (v.t === "record") return int(v.v.size);
        throw runtimeError(`len() does not apply to ${typeNameOf(v)}`, null);
      }),
    );

    g.declare("str", native("str", 1, (args) => str(display(args[0]))));
    g.declare("int", native("int", 1, (args) => int(Math.trunc(numeric(args[0])))));
    g.declare("float", native("float", 1, (args) => float(numeric(args[0]))));
    g.declare("abs", native("abs", 1, (args) => float(Math.abs(numeric(args[0])))));
    g.declare("floor", native("floor", 1, (args) => int(Math.floor(numeric(args[0])))));
    g.declare("ceil", native("ceil", 1, (args) => int(Math.ceil(numeric(args[0])))));
    g.declare("round", native("round", 1, (args) => int(Math.round(numeric(args[0])))));
    g.declare("sqrt", native("sqrt", 1, (args) => float(Math.sqrt(numeric(args[0])))));
    g.declare("min", native("min", -1, (args) => float(Math.min(...args.map(numeric)))));
    g.declare("max", native("max", -1, (args) => float(Math.max(...args.map(numeric)))));

    g.declare(
      "sum",
      native("sum", 1, (args) => {
        const v = args[0];
        if (v.t !== "list") throw runtimeError("sum() expects a list", null);
        if (v.v.length > 0 && v.v[0].t === "money") {
          let acc = 0n;
          let currency = "THB";
          for (const item of v.v) {
            if (item.t !== "money") throw runtimeError("sum() list mixes Money with other types", null);
            acc += item.v;
            currency = item.currency;
          }
          return money(acc, currency);
        }
        const total = v.v.reduce((a, item) => a + numeric(item), 0);
        return Number.isInteger(total) ? int(total) : float(total);
      }),
    );

    g.declare(
      "range",
      native("range", -1, (args) => {
        const lo = args.length > 1 ? numeric(args[0]) : 0;
        const hi = args.length > 1 ? numeric(args[1]) : numeric(args[0]);
        const step = args.length > 2 ? numeric(args[2]) : 1;
        const out: Value[] = [];
        if (step > 0) for (let i = lo; i < hi; i += step) out.push(int(i));
        else for (let i = lo; i > hi; i += step) out.push(int(i));
        return list(out);
      }),
    );

    g.declare(
      "push",
      native("push", 2, (args) => {
        const target = args[0];
        if (target.t !== "list") throw runtimeError("push() expects a list", null);
        target.v.push(args[1]);
        return target;
      }),
    );

    g.declare(
      "assert",
      native("assert", -1, (args) => {
        const ok = args[0];
        if (ok.t !== "bool") throw runtimeError("assert() expects a Bool", null);
        if (!ok.v) {
          const msg = args.length > 1 ? display(args[1]) : "assertion failed";
          throw runtimeError(`assertion failed: ${msg}`, null);
        }
        return UNIT;
      }),
    );

    g.declare(
      "sort",
      native("sort", 1, (args) => {
        const v = args[0];
        if (v.t !== "list") throw runtimeError("sort() expects a list", null);
        const copy = [...v.v];
        copy.sort((a, b) => numeric(a) - numeric(b));
        return list(copy);
      }),
    );

    // gaming namespaces
    g.declare("rng", makeRngNamespace(host));
    g.declare("Reel", makeReelNamespace(host));
    g.declare("Deck", makeDeckNamespace(host));
    g.declare("Card", makeCardNamespace());
    g.declare("Baccarat", makeBaccaratNamespace());
    g.declare("Poker", makePokerNamespace());
    g.declare("Dice", makeDiceNamespace(host));
    g.declare("Money", makeMoneyNamespace());
    g.declare("Fair", makeFairNamespace(host));
    g.declare("Rtp", makeRtpNamespace(host));
    g.declare("Math", makeMathNamespace());

    // Extended standard library. The host object is intentionally tiny: Random
    // shares the same deterministic/fair source as gaming primitives, while the
    // other modules keep their state behind opaque handles.
    installExtendedStdlib(g, host);

    // audit is a thin logger in the prototype but keeps the effect meaningful
    g.declare(
      "audit",
      namespace("audit", {
        record: native("audit.record", -1, (args) => {
          const line = `[audit] ${args.map(display).join(" ")}`;
          this.emitOutput(line);
          return UNIT;
        }),
      }),
    );
  }

  // ------------------------------------------------------------- program

  run(program: Program): RunResult {
    // hoist functions, games and types so definition order does not matter
    this.hoist(program.body, this.globals);

    // The implicit outermost frame, so the debugger always has somewhere to
    // report top-level statements against.
    this.frames.push({ name: "<top level>", callSite: null, env: this.globals, effects: [] });

    for (const stmt of program.body) {
      if (stmt.kind === "FnDecl" || stmt.kind === "GameDecl" || stmt.kind === "TypeDecl") continue;
      if (stmt.kind === "TestDecl") continue;
      this.execStmt(stmt, this.globals);
    }

    let value: Value = UNIT;
    const main = this.globals.get("main");
    if (main && (main.t === "fn" || main.t === "native")) {
      value = this.callValue(main, [], null);
    }

    this.frames.pop();
    return { value, output: this.output, steps: this.steps };
  }

  /** Run only the `test` blocks in a program. */
  runTests(program: Program): { passed: number; failed: number; failures: string[] } {
    this.hoist(program.body, this.globals);
    for (const stmt of program.body) {
      if (stmt.kind === "FnDecl" || stmt.kind === "GameDecl" || stmt.kind === "TypeDecl") continue;
      if (stmt.kind === "TestDecl") continue;
      this.execStmt(stmt, this.globals);
    }

    let passed = 0;
    let failed = 0;
    const failures: string[] = [];
    for (const t of this.tests) {
      try {
        this.execBlock(t.body, new Env(this.globals));
        passed += 1;
        this.write(`  \x1b[32mok\x1b[0m    ${t.name}`);
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${t.name}: ${message}`);
        this.write(`  \x1b[31mFAIL\x1b[0m  ${t.name} — ${message}`);
      }
    }
    return { passed, failed, failures };
  }

  private hoist(body: Stmt[], env: Env): void {
    for (const stmt of body) {
      switch (stmt.kind) {
        case "FnDecl":
          env.declare(stmt.name, { t: "fn", decl: stmt, closure: env });
          break;
        case "GameDecl": {
          const gameValue = this.buildGame(stmt, env);
          env.declare(stmt.name, gameValue);
          this.games.set(stmt.name, gameValue);
          break;
        }
        case "TypeDecl":
          for (const variant of stmt.variants) {
            env.declare(variant, { t: "variant", name: variant, typeName: stmt.name });
          }
          break;
        case "TestDecl":
          this.tests.push({ name: stmt.name, body: stmt.body });
          break;
        default:
          break;
      }
    }
  }

  /**
   * A `game` block evaluates to a namespace-like value: declarative fields and
   * reel strips become members, and methods close over them.
   */
  private buildGame(decl: GameDecl, env: Env): Value {
    const gameEnv = new Env(env);
    const fields = new Map<string, Value>();
    const methods = new Map<string, Value>();

    for (const reel of decl.reels) {
      const symbols = this.evalExpr(reel.symbols, gameEnv);
      let value = symbols;
      if (reel.weights) {
        const weights = this.evalExpr(reel.weights, gameEnv);
        const m = new Map<string, Value>();
        m.set("symbols", symbols);
        m.set("weights", weights);
        m.set("length", int(symbols.t === "list" ? symbols.v.length : 0));
        value = record(m, "Reel");
      }
      gameEnv.declare(reel.name, value);
      fields.set(reel.name, value);
    }

    for (const field of decl.fields) {
      const value = this.evalExpr(field.value, gameEnv);
      gameEnv.declare(field.name, value);
      fields.set(field.name, value);
    }

    // attribute-declared RTP is exposed as a field so programs can assert on it
    const rtpAttr = decl.attributes.find((a) => a.name === "rtp");
    if (rtpAttr && rtpAttr.args["target"] && !fields.has("rtp")) {
      const target = this.evalExpr(rtpAttr.args["target"], gameEnv);
      fields.set("rtp", target);
      gameEnv.declare("rtp", target);
    }
    if (rtpAttr && rtpAttr.args["tolerance"] && !fields.has("tolerance")) {
      const tol = this.evalExpr(rtpAttr.args["tolerance"], gameEnv);
      fields.set("tolerance", tol);
      gameEnv.declare("tolerance", tol);
    }

    const gameValue: Value = {
      t: "game",
      name: decl.name,
      fields,
      methods,
      env: gameEnv,
    };

    // `self` inside methods refers to the game itself
    gameEnv.declare("self", gameValue);

    for (const fn of decl.functions) {
      const fnValue: Value = { t: "fn", decl: fn, closure: gameEnv };
      methods.set(fn.name, fnValue);
      gameEnv.declare(fn.name, fnValue);
    }

    return gameValue;
  }

  // ------------------------------------------------------------- statements

  private execBlock(block: BlockStmt, env: Env): Value {
    this.hoist(block.body, env);
    let last: Value = UNIT;
    for (const stmt of block.body) {
      if (stmt.kind === "FnDecl" || stmt.kind === "GameDecl" || stmt.kind === "TypeDecl") continue;
      last = this.execStmt(stmt, env);
    }
    return last;
  }

  private execStmt(stmt: Stmt, env: Env): Value {
    this.tick(stmt.span);

    // Instrumentation runs before the statement, so a breakpoint stops *at* the
    // line rather than after its side effects have already happened.
    if (this.onStatement && stmt.kind !== "FnDecl" && stmt.kind !== "GameDecl" && stmt.kind !== "TypeDecl") {
      this.onStatement({ stmt, env, stack: this.frames, steps: this.steps });
    }

    switch (stmt.kind) {
      case "ModuleStmt":
      case "UseStmt":
      case "TypeDecl":
      case "FnDecl":
      case "GameDecl":
      case "TestDecl":
        return UNIT;

      case "LetStmt": {
        const value = this.evalExpr(stmt.value, env);
        env.declare(stmt.name, value, stmt.mutable);
        return UNIT;
      }

      case "ExprStmt":
        return this.evalExpr(stmt.expr, env);

      case "ReturnStmt":
        throw new ReturnSignal(stmt.value ? this.evalExpr(stmt.value, env) : UNIT);

      case "IfStmt": {
        if (this.asBool(this.evalExpr(stmt.cond, env), stmt.cond.span)) {
          return this.execBlock(stmt.then, new Env(env));
        }
        if (stmt.otherwise) {
          if (stmt.otherwise.kind === "BlockStmt") return this.execBlock(stmt.otherwise, new Env(env));
          return this.execStmt(stmt.otherwise, env);
        }
        return UNIT;
      }

      case "WhileStmt": {
        while (this.asBool(this.evalExpr(stmt.cond, env), stmt.cond.span)) {
          try {
            this.execBlock(stmt.body, new Env(env));
          } catch (sig) {
            if (sig instanceof BreakSignal) break;
            if (sig instanceof ContinueSignal) continue;
            throw sig;
          }
        }
        return UNIT;
      }

      case "ForStmt": {
        const iterable = this.evalExpr(stmt.iterable, env);
        const items = this.iterate(iterable, stmt.iterable.span);
        for (const item of items) {
          const loopEnv = new Env(env);
          loopEnv.declare(stmt.binding, item);
          try {
            this.execBlock(stmt.body, loopEnv);
          } catch (sig) {
            if (sig instanceof BreakSignal) break;
            if (sig instanceof ContinueSignal) continue;
            throw sig;
          }
        }
        return UNIT;
      }

      case "BlockStmt":
        return this.execBlock(stmt, new Env(env));

      case "BreakStmt":
        throw new BreakSignal();

      case "ContinueStmt":
        throw new ContinueSignal();
    }
  }

  private iterate(v: Value, span: Span): Value[] {
    if (v.t === "list") return v.v;
    if (v.t === "str") return [...v.v].map((c) => str(c));
    if (v.t === "int") {
      const out: Value[] = [];
      for (let i = 0; i < v.v; i++) out.push(int(i));
      return out;
    }
    throw runtimeError(`cannot iterate over ${typeNameOf(v)}`, span, "iterate a list, a string, or a range");
  }

  // ------------------------------------------------------------- expressions

  private evalExpr(expr: Expr, env: Env): Value {
    this.tick(expr.span);

    switch (expr.kind) {
      case "IntLit":
        return int(expr.value);
      case "FloatLit":
        return float(expr.value);
      case "StrLit":
        return str(expr.value);
      case "BoolLit":
        return bool(expr.value);

      case "Interp": {
        let out = "";
        for (const part of expr.parts) {
          if ("text" in part) out += part.text;
          else out += this.formatValue(this.evalExpr(part.expr, env), part.format);
        }
        return str(out);
      }

      case "ArrayLit":
        return list(expr.elements.map((e) => this.evalExpr(e, env)));

      case "Ident": {
        const value = env.get(expr.name);
        if (value === undefined) {
          throw runtimeError(
            `\`${expr.name}\` is not defined`,
            expr.span,
            "declare it with `let` before use, or check the spelling",
          );
        }
        return value;
      }

      case "Unary": {
        const operand = this.evalExpr(expr.operand, env);
        if (expr.op === "not") return bool(!this.asBool(operand, expr.span));
        if (expr.op === "-") {
          if (operand.t === "money") return money(-operand.v, operand.currency);
          const n = numeric(operand);
          return operand.t === "int" ? int(-n) : float(-n);
        }
        return operand;
      }

      case "Binary":
        return this.evalBinary(expr, env);

      case "Assign": {
        const value = this.evalExpr(expr.value, env);

        if (expr.target.kind === "Ident") {
          const name = expr.target.name;
          const current = env.get(name);
          if (current === undefined) {
            throw runtimeError(`\`${name}\` is not defined`, expr.span);
          }
          const next =
            expr.op === "=" ? value : this.applyBinaryOp(expr.op.slice(0, 1), current, value, expr.span);
          if (!env.set(name, next)) {
            throw runtimeError(`cannot assign to \`${name}\``, expr.span);
          }
          return next;
        }

        if (expr.target.kind === "Index") {
          const target = this.evalExpr(expr.target.object, env);
          const idx = this.evalExpr(expr.target.index, env);
          if (target.t !== "list") {
            throw runtimeError(`cannot index-assign into ${typeNameOf(target)}`, expr.span);
          }
          const i = Math.trunc(numeric(idx));
          const next =
            expr.op === "="
              ? value
              : this.applyBinaryOp(expr.op.slice(0, 1), target.v[i] ?? int(0), value, expr.span);
          target.v[i] = next;
          return next;
        }

        if (expr.target.kind === "Member") {
          const obj = this.evalExpr(expr.target.object, env);
          if (obj.t === "record") {
            const next =
              expr.op === "="
                ? value
                : this.applyBinaryOp(
                    expr.op.slice(0, 1),
                    obj.v.get(expr.target.property) ?? int(0),
                    value,
                    expr.span,
                  );
            obj.v.set(expr.target.property, next);
            return next;
          }
          throw runtimeError(`cannot assign to a member of ${typeNameOf(obj)}`, expr.span);
        }

        throw runtimeError("invalid assignment target", expr.span);
      }

      case "Lambda":
        return { t: "lambda", params: expr.params, body: expr.body, closure: env };

      case "IfExpr": {
        if (this.asBool(this.evalExpr(expr.cond, env), expr.cond.span)) {
          return this.evalExpr(expr.then, env);
        }
        return expr.otherwise ? this.evalExpr(expr.otherwise, env) : UNIT;
      }

      case "MatchExpr": {
        const subject = this.evalExpr(expr.subject, env);
        for (const arm of expr.arms) {
          const matched =
            arm.pattern === null ? true : valueEquals(subject, this.evalExpr(arm.pattern, env));
          if (!matched) continue;
          if (arm.guard && !this.asBool(this.evalExpr(arm.guard, env), arm.guard.span)) continue;
          return this.evalExpr(arm.body, env);
        }
        throw runtimeError(
          `no match arm applies to ${display(subject)}`,
          expr.span,
          "add a `_ -> ...` arm, or cover the remaining cases",
        );
      }

      case "RangeExpr": {
        const from = Math.trunc(numeric(this.evalExpr(expr.from, env)));
        const to = Math.trunc(numeric(this.evalExpr(expr.to, env)));
        const out: Value[] = [];
        const end = expr.inclusive ? to + 1 : to;
        for (let i = from; i < end; i++) out.push(int(i));
        return list(out);
      }

      case "Index": {
        const obj = this.evalExpr(expr.object, env);
        const idxValue = this.evalExpr(expr.index, env);

        if (obj.t === "list") {
          let i = Math.trunc(numeric(idxValue));
          if (i < 0) i += obj.v.length;
          if (i < 0 || i >= obj.v.length) {
            throw runtimeError(
              `index ${i} is out of bounds for a list of length ${obj.v.length}`,
              expr.span,
            );
          }
          return obj.v[i];
        }
        if (obj.t === "str") {
          const chars = [...obj.v];
          const i = Math.trunc(numeric(idxValue));
          if (i < 0 || i >= chars.length) {
            throw runtimeError(`index ${i} is out of bounds for a string of length ${chars.length}`, expr.span);
          }
          return str(chars[i]);
        }
        if (obj.t === "record") {
          const key = idxValue.t === "str" ? idxValue.v : display(idxValue);
          return obj.v.get(key) ?? UNIT;
        }
        throw runtimeError(`cannot index ${typeNameOf(obj)}`, expr.span);
      }

      case "Member":
        return this.evalMember(expr, env);

      case "Pipeline": {
        const value = this.evalExpr(expr.value, env);
        // `x |> f` and `x |> f(a)` both prepend x as the first argument
        if (expr.stage.kind === "Call") {
          const callee = this.evalExpr(expr.stage.callee, env);
          const rest = expr.stage.args.map((a) => this.evalExpr(a, env));
          return this.callValue(callee, [value, ...rest], expr.span);
        }
        const fn = this.evalExpr(expr.stage, env);
        return this.callValue(fn, [value], expr.span);
      }

      case "Call": {
        const args = expr.args.map((a) => this.evalExpr(a, env));
        const callee = this.evalExpr(expr.callee, env);
        return this.callValue(callee, args, expr.span);
      }
    }
  }

  private evalMember(expr: Expr & { kind: "Member" }, env: Env): Value {
    const obj = this.evalExpr(expr.object, env);
    const prop = expr.property;

    switch (obj.t) {
      case "namespace": {
        const member = obj.members.get(prop);
        if (!member) {
          throw runtimeError(
            `module \`${obj.name}\` has no member \`${prop}\``,
            expr.span,
            `available: ${[...obj.members.keys()].join(", ")}`,
          );
        }
        return member;
      }

      case "game": {
        const method = obj.methods.get(prop);
        if (method) return method;
        const field = obj.fields.get(prop);
        if (field) return field;
        throw runtimeError(
          `game \`${obj.name}\` has no member \`${prop}\``,
          expr.span,
          `available: ${[...obj.fields.keys(), ...obj.methods.keys()].join(", ")}`,
        );
      }

      case "record": {
        const field = obj.v.get(prop);
        if (field !== undefined) return field;
        return this.builtinMethod(obj, prop, expr.span);
      }

      case "money":
        if (prop === "amount") return float(moneyToNumber(obj));
        if (prop === "currency") return str(obj.currency);
        return this.builtinMethod(obj, prop, expr.span);

      default:
        return this.builtinMethod(obj, prop, expr.span);
    }
  }

  /** Methods available on primitive values (list.map, str.upper, and so on). */
  private builtinMethod(receiver: Value, prop: string, span: Span): Value {
    const self = receiver;

    if (self.t === "list") {
      switch (prop) {
        case "len":
          return native("len", 0, () => int(self.v.length));
        case "push":
          return native("push", 1, (args) => {
            self.v.push(args[0]);
            return self;
          });
        case "first":
          return native("first", 0, () => self.v[0] ?? UNIT);
        case "last":
          return native("last", 0, () => self.v[self.v.length - 1] ?? UNIT);
        case "map":
          return native("map", 1, (args) => list(self.v.map((item) => this.callValue(args[0], [item], span))));
        case "filter":
          return native("filter", 1, (args) =>
            list(self.v.filter((item) => truthy(this.callValue(args[0], [item], span)))),
          );
        case "count":
          return native("count", 1, (args) =>
            int(self.v.filter((item) => valueEquals(item, args[0])).length),
          );
        case "contains":
          return native("contains", 1, (args) => bool(self.v.some((item) => valueEquals(item, args[0]))));
        case "sum":
          return native("sum", 0, () => {
            const total = self.v.reduce((a, item) => a + numeric(item), 0);
            return Number.isInteger(total) ? int(total) : float(total);
          });
        case "reverse":
          return native("reverse", 0, () => list([...self.v].reverse()));
        case "join":
          return native("join", -1, (args) =>
            str(self.v.map(display).join(args.length > 0 ? display(args[0]) : "")),
          );
        case "take":
          return native("take", 1, (args) => list(self.v.slice(0, Math.trunc(numeric(args[0])))));
        case "pop":
          // Mutates in place and returns the receiver, matching `push`, so a
          // chain like `strip.pop().len()` reads naturally. The removed element
          // is available through `last()` before the call.
          return native("pop", 0, () => {
            self.v.pop();
            return self;
          });
        case "indexOf":
          return native("indexOf", 1, (args) =>
            int(self.v.findIndex((item) => valueEquals(item, args[0]))),
          );
        case "concat":
          return native("concat", 1, (args) => {
            const other = args[0];
            return list([...self.v, ...(other && other.t === "list" ? other.v : [other ?? UNIT])]);
          });
        case "slice":
          return native("slice", -1, (args) =>
            list(
              self.v.slice(
                Math.trunc(numeric(args[0])),
                args.length > 1 ? Math.trunc(numeric(args[1])) : undefined,
              ),
            ),
          );
        default:
          break;
      }
    }

    if (self.t === "str") {
      switch (prop) {
        case "len":
          return native("len", 0, () => int([...self.v].length));
        case "upper":
          return native("upper", 0, () => str(self.v.toUpperCase()));
        case "lower":
          return native("lower", 0, () => str(self.v.toLowerCase()));
        case "trim":
          return native("trim", 0, () => str(self.v.trim()));
        case "contains":
          return native("contains", 1, (args) => bool(self.v.includes(display(args[0]))));
        case "split":
          return native("split", 1, (args) => list(self.v.split(display(args[0])).map((s) => str(s))));
        case "chars":
          return native("chars", 0, () => list([...self.v].map((c) => str(c))));
        case "indexOf":
          return native("indexOf", 1, (args) => int(self.v.indexOf(display(args[0]))));
        case "slice":
          // Code-point aware, so a multi-byte symbol in a reel strip is not split
          // in half the way a UTF-16 slice would.
          return native("slice", -1, (args) => {
            const points = [...self.v];
            const start = Math.trunc(numeric(args[0]));
            const end = args.length > 1 ? Math.trunc(numeric(args[1])) : undefined;
            return str(points.slice(start, end).join(""));
          });
        case "concat":
          return native("concat", 1, (args) => str(self.v + display(args[0])));
        case "reverse":
          return native("reverse", 0, () => str([...self.v].reverse().join("")));
        default:
          break;
      }
    }

    if (self.t === "int" || self.t === "float") {
      switch (prop) {
        case "abs":
          // Preserve the receiver's kind: `(-7).abs()` is an Int, and returning a
          // Float there would leak into an Int-typed context.
          return native("abs", 0, () =>
            self.t === "int" ? int(Math.abs(self.v)) : float(Math.abs(self.v)),
          );
        case "round":
          return native("round", 0, () => int(Math.round(self.v)));
        case "floor":
          return native("floor", 0, () => int(Math.floor(self.v)));
        case "toFloat":
          return native("toFloat", 0, () => float(self.v));
        case "toInt":
          return native("toInt", 0, () => int(Math.trunc(self.v)));
        default:
          break;
      }
    }

    if (self.t === "money") {
      switch (prop) {
        case "isZero":
          return native("isZero", 0, () => bool(self.v === 0n));
        case "toFloat":
          return native("toFloat", 0, () => float(moneyToNumber(self)));
        case "scale":
          return native("scale", 1, (args) => {
            const factor = numeric(args[0]);
            return money((self.v * BigInt(Math.round(factor * 1_000_000))) / 1_000_000n, self.currency);
          });
        default:
          break;
      }
    }

    // `toString` is available on every value: it is the method form of the
    // `str(...)` builtin, which is what the MIR lowers it to.
    if (prop === "toString") {
      return native("toString", 0, () => str(display(self)));
    }

    throw runtimeError(
      `${typeNameOf(receiver)} has no member \`${prop}\``,
      span,
      "check the standard library reference in README.md",
    );
  }

  private evalBinary(expr: Expr & { kind: "Binary" }, env: Env): Value {
    // short-circuit logical operators
    if (expr.op === "and") {
      const left = this.evalExpr(expr.left, env);
      if (!this.asBool(left, expr.left.span)) return bool(false);
      return bool(this.asBool(this.evalExpr(expr.right, env), expr.right.span));
    }
    if (expr.op === "or") {
      const left = this.evalExpr(expr.left, env);
      if (this.asBool(left, expr.left.span)) return bool(true);
      return bool(this.asBool(this.evalExpr(expr.right, env), expr.right.span));
    }

    const left = this.evalExpr(expr.left, env);
    const right = this.evalExpr(expr.right, env);
    return this.applyBinaryOp(expr.op, left, right, expr.span);
  }

  private applyBinaryOp(op: string, left: Value, right: Value, span: Span): Value {
    switch (op) {
      case "==":
        return bool(valueEquals(left, right));
      case "!=":
        return bool(!valueEquals(left, right));
      case "<":
      case "<=":
      case ">":
      case ">=": {
        if (left.t === "str" && right.t === "str") {
          const cmp = left.v.localeCompare(right.v);
          return bool(op === "<" ? cmp < 0 : op === "<=" ? cmp <= 0 : op === ">" ? cmp > 0 : cmp >= 0);
        }
        const a = numeric(left);
        const b = numeric(right);
        return bool(op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b);
      }
      default:
        break;
    }

    // string concatenation
    if (op === "+" && (left.t === "str" || right.t === "str")) {
      return str(display(left) + display(right));
    }

    // list concatenation
    if (op === "+" && left.t === "list" && right.t === "list") {
      return list([...left.v, ...right.v]);
    }

    // money arithmetic: exact, and never mixed with floats
    if (left.t === "money" || right.t === "money") {
      return this.applyMoneyOp(op, left, right, span);
    }

    const a = numeric(left);
    const b = numeric(right);
    const bothInt = left.t === "int" && right.t === "int";

    switch (op) {
      case "+":
        return bothInt ? int(a + b) : float(a + b);
      case "-":
        return bothInt ? int(a - b) : float(a - b);
      case "*":
        return bothInt ? int(a * b) : float(a * b);
      case "/":
        if (b === 0) throw runtimeError("division by zero", span);
        return bothInt ? int(Math.floor(a / b)) : float(a / b);
      case "%":
        if (b === 0) throw runtimeError("modulo by zero", span);
        return bothInt ? int(a % b) : float(a % b);
      default:
        throw runtimeError(`unsupported operator \`${op}\``, span);
    }
  }

  private applyMoneyOp(op: string, left: Value, right: Value, span: Span): Value {
    // Money OP Money
    if (left.t === "money" && right.t === "money") {
      if (left.currency !== right.currency) {
        throw runtimeError(
          `cannot combine ${left.currency} with ${right.currency}`,
          span,
          "convert one side with an explicit exchange operation",
        );
      }
      switch (op) {
        case "+":
          return money(left.v + right.v, left.currency);
        case "-":
          return money(left.v - right.v, left.currency);
        default:
          throw runtimeError(
            `\`${op}\` is not defined for Money and Money`,
            span,
            "multiplying two amounts of money is a dimensional error",
          );
      }
    }

    const m = left.t === "money" ? left : (right as Value & { t: "money" });
    const other = left.t === "money" ? right : left;

    // Money * Int is exact; Money * Float is rejected per the money rule
    if (other.t === "float") {
      throw runtimeError(
        `cannot ${op === "*" ? "multiply" : "combine"} Money with Float`,
        span,
        "Money is fixed-point; use Money.scale(amount, numerator, denominator) for exact scaling",
      );
    }
    if (other.t !== "int") {
      throw runtimeError(`cannot apply \`${op}\` to Money and ${typeNameOf(other)}`, span);
    }

    const n = BigInt(other.v);
    switch (op) {
      case "*":
        return money(m.v * n, m.currency);
      case "/":
        if (n === 0n) throw runtimeError("division by zero", span);
        return money(m.v / n, m.currency);
      default:
        throw runtimeError(`\`${op}\` is not defined for Money and Int`, span);
    }
  }

  // ------------------------------------------------------------- calls

  callValue(callee: Value, args: Value[], span: Span | null): Value {
    switch (callee.t) {
      case "native": {
        if (callee.arity >= 0 && args.length !== callee.arity) {
          throw runtimeError(
            `${callee.name} takes ${callee.arity} argument${callee.arity === 1 ? "" : "s"} but ${args.length} ${args.length === 1 ? "was" : "were"} supplied`,
            span,
          );
        }
        return callee.call(args);
      }

      case "fn": {
        const decl = callee.decl;
        if (args.length !== decl.params.length) {
          throw runtimeError(
            `\`${decl.name}\` takes ${decl.params.length} argument${decl.params.length === 1 ? "" : "s"} but ${args.length} ${args.length === 1 ? "was" : "were"} supplied`,
            span,
          );
        }
        if (this.frames.length >= this.maxCallDepth) {
          throw runtimeError(
            `call depth limit of ${this.maxCallDepth} exceeded while calling \`${decl.name}\``,
            span,
            "rewrite the recursion with an explicit loop, or raise maxCallDepth in the host API",
          );
        }
        const fnEnv = new Env(callee.closure);
        decl.params.forEach((p, i) => fnEnv.declare(p.name, args[i]));
        this.frames.push({
          name: decl.name,
          callSite: span,
          env: fnEnv,
          effects: decl.effects,
        });
        try {
          const last = this.execBlock(decl.body, fnEnv);
          return last;
        } catch (sig) {
          if (sig instanceof ReturnSignal) return sig.value;
          throw sig;
        } finally {
          // `finally` matters: a `return` propagates as an exception, and an
          // unbalanced stack would make every later frame report the wrong depth.
          this.frames.pop();
        }
      }

      case "lambda": {
        const lamEnv = new Env(callee.closure);
        callee.params.forEach((p, i) => lamEnv.declare(p.name, args[i] ?? UNIT));
        return this.evalExpr(callee.body, lamEnv);
      }

      case "game": {
        // calling a game value invokes its `spin` (or `resolve`) entry point
        const entry = callee.methods.get("spin") ?? callee.methods.get("resolve");
        if (!entry) throw runtimeError(`game \`${callee.name}\` has no \`spin\` function`, span);
        return this.callValue(entry, args, span);
      }

      default:
        throw runtimeError(`${typeNameOf(callee)} is not callable`, span);
    }
  }

  // ------------------------------------------------------------- helpers

  private emitOutput(line: string): void {
    if (this.outputTruncated) return;
    const bytes = utf8Length(line);
    if (this.output.length >= this.maxOutputLines || this.outputBytes + bytes > this.maxOutputBytes) {
      this.outputTruncated = true;
      const notice = "[output truncated]";
      // Replace the last retained line instead of appending unbounded metadata.
      // This keeps both line and byte limits meaningful even for tiny host caps.
      if (this.output.length > 0) {
        const index = this.output.length - 1;
        this.outputBytes -= utf8Length(this.output[index]);
        this.output[index] = notice;
        this.outputBytes += utf8Length(notice);
      } else {
        this.output.push(notice);
        this.outputBytes = utf8Length(notice);
      }
      this.write(notice);
      return;
    }
    this.output.push(line);
    this.outputBytes += bytes;
    this.write(line);
  }

  private formatValue(v: Value, format: string | null): string {
    if (!format) return display(v);
    const m = /^\.(\d+)$/.exec(format);
    if (m) {
      const digits = Number(m[1]);
      return numeric(v).toFixed(digits);
    }
    if (format === "%") {
      return `${(numeric(v) * 100).toFixed(2)}%`;
    }
    return display(v);
  }

  private asBool(v: Value, span: Span): boolean {
    if (v.t === "bool") return v.v;
    throw runtimeError(
      `expected a Bool condition but found ${typeNameOf(v)}`,
      span,
      "Sunra has no truthiness; compare explicitly, e.g. `x != 0`",
    );
  }

  private tick(span: Span): void {
    this.steps += 1;
    if (this.steps > this.stepLimit) {
      throw runtimeError(
        `step limit of ${this.stepLimit} exceeded — the program may not terminate`,
        span,
        "bound your loops, or raise the limit with --steps",
      );
    }
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function utf8Length(value: string): number {
  const Encoder = (globalThis as { TextEncoder?: new () => { encode(value: string): Uint8Array } }).TextEncoder;
  return Encoder ? new Encoder().encode(value).length : value.length;
}

export { SunraError };
