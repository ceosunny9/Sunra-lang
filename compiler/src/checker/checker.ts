import { SunraError, typeError, type Span } from "../diagnostics.js";
import type {
  Attribute,
  BlockStmt,
  Expr,
  FnDecl,
  GameDecl,
  Program,
  Stmt,
  TypeNode,
} from "../parser/ast.js";

/**
 * Sunra type checker (prototype).
 *
 * This is a pragmatic subset of the type system described in the whitepaper. It
 * performs:
 *   - scope and binding resolution (use of undefined names is an error)
 *   - immutability enforcement (`let` cannot be reassigned)
 *   - structural type inference for literals, operators and known builtins
 *   - money/float separation: Money may not be mixed with Float
 *   - effect checking: a function may only perform effects it declares
 *   - RTP obligation checking on `game` blocks
 *   - arity checking for user-defined functions
 *
 * Unknown types are represented as `Unknown` and unify with everything, which
 * keeps annotations genuinely optional while still catching real mistakes.
 */

export type Ty =
  | { k: "Int" }
  | { k: "Float" }
  | { k: "Str" }
  | { k: "Bool" }
  | { k: "Unit" }
  | { k: "Unknown" }
  | { k: "List"; of: Ty }
  | { k: "Money" }
  | { k: "Fn"; params: Ty[]; ret: Ty; effects: string[]; arity: number; name: string }
  | { k: "Named"; name: string };

export const T = {
  int: { k: "Int" } as Ty,
  float: { k: "Float" } as Ty,
  str: { k: "Str" } as Ty,
  bool: { k: "Bool" } as Ty,
  unit: { k: "Unit" } as Ty,
  unknown: { k: "Unknown" } as Ty,
  money: { k: "Money" } as Ty,
  list: (of: Ty): Ty => ({ k: "List", of }),
  named: (name: string): Ty => ({ k: "Named", name }),
};

export function tyName(t: Ty): string {
  switch (t.k) {
    case "List":
      return `[${tyName(t.of)}]`;
    case "Fn":
      return `fn(${t.params.map(tyName).join(", ")}) -> ${tyName(t.ret)}`;
    case "Named":
      return t.name;
    default:
      return t.k;
  }
}

/** All effects recognised by the prototype, mapped to what they permit. */
export const KNOWN_EFFECTS = new Set([
  "rand",
  "io",
  "net",
  "db",
  "money",
  "ai",
  "chain",
  "audit",
  "unsafe",
]);

interface Binding {
  ty: Ty;
  mutable: boolean;
  span: Span;
}

class Scope {
  private readonly vars = new Map<string, Binding>();
  constructor(readonly parent: Scope | null = null) {}

  declare(name: string, binding: Binding): void {
    this.vars.set(name, binding);
  }

  lookup(name: string): Binding | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }

  has(name: string): boolean {
    return this.vars.has(name);
  }
}

export interface CheckResult {
  errors: SunraError[];
  warnings: SunraError[];
  /** effect sets discovered per function, for the CLI's `--effects` output */
  effectTable: Map<string, string[]>;
}

/** Builtins visible to the checker; the interpreter provides the implementations. */
const BUILTIN_TYPES: Record<string, Ty> = {
  print: { k: "Fn", params: [], ret: T.unit, effects: ["io"], arity: -1, name: "print" },
  println: { k: "Fn", params: [], ret: T.unit, effects: ["io"], arity: -1, name: "println" },
  len: { k: "Fn", params: [T.unknown], ret: T.int, effects: [], arity: 1, name: "len" },
  abs: { k: "Fn", params: [T.float], ret: T.float, effects: [], arity: 1, name: "abs" },
  min: { k: "Fn", params: [T.float, T.float], ret: T.float, effects: [], arity: 2, name: "min" },
  max: { k: "Fn", params: [T.float, T.float], ret: T.float, effects: [], arity: 2, name: "max" },
  floor: { k: "Fn", params: [T.float], ret: T.int, effects: [], arity: 1, name: "floor" },
  round: { k: "Fn", params: [T.float], ret: T.int, effects: [], arity: 1, name: "round" },
  sqrt: { k: "Fn", params: [T.float], ret: T.float, effects: [], arity: 1, name: "sqrt" },
  str: { k: "Fn", params: [T.unknown], ret: T.str, effects: [], arity: 1, name: "str" },
  int: { k: "Fn", params: [T.unknown], ret: T.int, effects: [], arity: 1, name: "int" },
  float: { k: "Fn", params: [T.unknown], ret: T.float, effects: [], arity: 1, name: "float" },
  range: { k: "Fn", params: [T.int, T.int], ret: T.list(T.int), effects: [], arity: -1, name: "range" },
  assert: { k: "Fn", params: [T.bool], ret: T.unit, effects: [], arity: -1, name: "assert" },
  sum: { k: "Fn", params: [T.list(T.float)], ret: T.float, effects: [], arity: 1, name: "sum" },
  push: { k: "Fn", params: [], ret: T.unit, effects: [], arity: -1, name: "push" },
  // namespaced runtime objects
  rng: T.named("Rng"),
  Money: T.named("MoneyModule"),
  Deck: T.named("DeckModule"),
  Reel: T.named("ReelModule"),
  Fair: T.named("FairModule"),
  Rtp: T.named("RtpModule"),
  Card: T.named("CardModule"),
  Dice: T.named("DiceModule"),
  Math: T.named("MathModule"),
  Baccarat: T.named("BaccaratModule"),
  Poker: T.named("PokerModule"),
  Random: T.named("RandomModule"),
  Net: T.named("NetModule"),
  Db: T.named("DbModule"),
  Graphics: T.named("GraphicsModule"),
  Audio: T.named("AudioModule"),
};

export class Checker {
  private readonly errors: SunraError[] = [];
  private readonly warnings: SunraError[] = [];
  private readonly effectTable = new Map<string, string[]>();
  private readonly functions = new Map<string, FnDecl>();
  private readonly games = new Map<string, GameDecl>();
  private scope = new Scope();
  /** effects declared by the function currently being checked, or null at top level */
  private declaredEffects: Set<string> | null = null;
  private currentFn: string = "<top level>";
  /** name of the game whose methods are being checked, or null at top level */
  private currentGameName: string | null = null;

  check(program: Program): CheckResult {
    for (const [name, ty] of Object.entries(BUILTIN_TYPES)) {
      this.scope.declare(name, { ty, mutable: false, span: synthSpan() });
    }

    // hoist declarations so order of definition does not matter
    this.hoist(program.body);

    for (const stmt of program.body) this.checkStmt(stmt);

    // verify a `main` exists when the file declares any function at all
    if (this.functions.size > 0 && !this.functions.has("main")) {
      this.warnings.push(
        typeError(
          "W0001",
          "entry.missing",
          "no `main` function found; `sunra run` will execute top-level statements only",
          null,
          "add `fn main() { ... }` as the program entry point",
        ),
      );
    }

    return { errors: this.errors, warnings: this.warnings, effectTable: this.effectTable };
  }

  private hoist(body: Stmt[]): void {
    for (const stmt of body) {
      if (stmt.kind === "FnDecl") {
        this.functions.set(stmt.name, stmt);
        this.scope.declare(stmt.name, {
          ty: this.fnType(stmt),
          mutable: false,
          span: stmt.span,
        });
      } else if (stmt.kind === "GameDecl") {
        this.games.set(stmt.name, stmt);
        this.scope.declare(stmt.name, { ty: T.named(stmt.name), mutable: false, span: stmt.span });
      } else if (stmt.kind === "TypeDecl") {
        this.scope.declare(stmt.name, { ty: T.named(stmt.name), mutable: false, span: stmt.span });
        for (const v of stmt.variants) {
          this.scope.declare(v, { ty: T.named(stmt.name), mutable: false, span: stmt.span });
        }
      }
    }
  }

  private fnType(fn: FnDecl): Ty {
    return {
      k: "Fn",
      params: fn.params.map((p) => this.resolveType(p.annotation)),
      ret: this.resolveType(fn.returnType),
      effects: fn.effects,
      arity: fn.params.length,
      name: fn.name,
    };
  }

  private resolveType(node: TypeNode | null): Ty {
    if (!node) return T.unknown;
    switch (node.name) {
      case "Int":
      case "i8":
      case "i16":
      case "i32":
      case "i64":
      case "u8":
      case "u16":
      case "u32":
      case "u64":
      case "usize":
        return T.int;
      case "Float":
      case "f32":
      case "f64":
        return T.float;
      case "Str":
      case "str":
      case "String":
        return T.str;
      case "Bool":
      case "bool":
        return T.bool;
      case "Unit":
        return T.unit;
      case "Money":
        return T.money;
      case "List":
        return T.list(this.resolveType(node.args[0] ?? null));
      default:
        return T.named(node.name);
    }
  }

  // ------------------------------------------------------------- statements

  private checkStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case "ModuleStmt":
      case "UseStmt":
      case "TypeDecl":
        return;

      case "FnDecl":
        this.checkFn(stmt);
        return;

      case "GameDecl":
        this.checkGame(stmt);
        return;

      case "TestDecl": {
        const saved = this.scope;
        this.scope = new Scope(saved);
        this.checkBlock(stmt.body);
        this.scope = saved;
        return;
      }

      case "LetStmt": {
        const valueTy = this.inferExpr(stmt.value);
        const declared = this.resolveType(stmt.annotation);
        if (stmt.annotation && !this.compatible(declared, valueTy)) {
          this.errors.push(
            typeError(
              "E0308",
              "type.mismatch",
              `expected \`${tyName(declared)}\` but the initialiser has type \`${tyName(valueTy)}\``,
              stmt.span,
              `either change the annotation to \`${tyName(valueTy)}\` or convert the value`,
            ),
          );
        }
        this.scope.declare(stmt.name, {
          ty: stmt.annotation ? declared : valueTy,
          mutable: stmt.mutable,
          span: stmt.span,
        });
        return;
      }

      case "ExprStmt":
        this.inferExpr(stmt.expr);
        return;

      case "ReturnStmt":
        if (stmt.value) this.inferExpr(stmt.value);
        return;

      case "IfStmt": {
        const condTy = this.inferExpr(stmt.cond);
        this.expectBool(condTy, stmt.cond);
        this.checkBlockScoped(stmt.then);
        if (stmt.otherwise) {
          if (stmt.otherwise.kind === "BlockStmt") this.checkBlockScoped(stmt.otherwise);
          else this.checkStmt(stmt.otherwise);
        }
        return;
      }

      case "WhileStmt": {
        this.expectBool(this.inferExpr(stmt.cond), stmt.cond);
        this.checkBlockScoped(stmt.body);
        return;
      }

      case "ForStmt": {
        const iterTy = this.inferExpr(stmt.iterable);
        const elemTy = iterTy.k === "List" ? iterTy.of : T.unknown;
        const saved = this.scope;
        this.scope = new Scope(saved);
        this.scope.declare(stmt.binding, { ty: elemTy, mutable: false, span: stmt.span });
        this.checkBlock(stmt.body);
        this.scope = saved;
        return;
      }

      case "BlockStmt":
        this.checkBlockScoped(stmt);
        return;

      case "BreakStmt":
      case "ContinueStmt":
        return;
    }
  }

  private checkFn(fn: FnDecl): void {
    for (const eff of fn.effects) {
      if (!KNOWN_EFFECTS.has(eff)) {
        this.errors.push(
          typeError(
            "E0610",
            "effect.unknown",
            `unknown effect \`${eff}\``,
            fn.span,
            `known effects: ${[...KNOWN_EFFECTS].join(", ")}`,
          ),
        );
      }
    }
    this.effectTable.set(fn.name, fn.effects);
    // Methods are also recorded as `Game.method`, so `sunra effects` can tell a
    // game's pure paytable apart from a free function of the same name.
    if (this.currentGameName !== null) {
      this.effectTable.set(`${this.currentGameName}.${fn.name}`, fn.effects);
    }

    const savedScope = this.scope;
    const savedEffects = this.declaredEffects;
    const savedFn = this.currentFn;

    this.scope = new Scope(savedScope);
    this.declaredEffects = new Set(fn.effects);
    this.currentFn = fn.name;

    for (const p of fn.params) {
      this.scope.declare(p.name, {
        ty: this.resolveType(p.annotation),
        mutable: false,
        span: p.span,
      });
    }
    this.checkBlock(fn.body);
    this.checkTailReturn(fn);

    this.scope = savedScope;
    this.declaredEffects = savedEffects;
    this.currentFn = savedFn;
  }

  /**
   * Compare a declared return type against the type of the function's tail
   * expression. Only the trailing expression is checked here, which is the
   * common case and keeps the prototype's inference honest: a mismatch is
   * reported, but an unknown type is never guessed at.
   */
  private checkTailReturn(fn: FnDecl): void {
    const declared = fn.returnType ? this.resolveType(fn.returnType) : null;
    if (declared === null || declared.k === "Unknown") return;

    const body = fn.body.body;
    if (body.length === 0) return;
    const tail = body[body.length - 1];
    if (tail.kind !== "ExprStmt") return;

    // The body has already been checked, so re-inferring the tail would report
    // any nested error a second time. Silence diagnostics for this pass and
    // keep only the type it yields.
    const before = this.errors.length;
    const actual = this.inferExpr(tail.expr);
    this.errors.length = before;

    if (actual.k === "Unknown") return;
    if (this.compatible(declared, actual)) return;

    this.errors.push(
      typeError(
        "E0308",
        "type.mismatch",
        `\`${fn.name}\` declares a return type of \`${tyName(declared)}\` but its final expression has type \`${tyName(actual)}\``,
        tail.span,
        `either change the annotation to \`${tyName(actual)}\` or return a \`${tyName(declared)}\``,
      ),
    );
  }

  private checkGame(game: GameDecl): void {
    const savedScope = this.scope;
    this.scope = new Scope(savedScope);
    const savedGameName = this.currentGameName;
    this.currentGameName = game.name;

    // reel strips and declarative fields become in-scope bindings for methods
    for (const reel of game.reels) {
      const ty = this.inferExpr(reel.symbols);
      this.scope.declare(reel.name, { ty, mutable: false, span: reel.span });
    }
    for (const field of game.fields) {
      const ty = this.inferExpr(field.value);
      this.scope.declare(field.name, { ty, mutable: false, span: field.span });
    }

    // Declare every method before checking any body, so game methods may call
    // one another regardless of declaration order.
    for (const fn of game.functions) {
      this.scope.declare(fn.name, { ty: this.fnType(fn), mutable: false, span: fn.span });
    }
    this.scope.declare("self", { ty: T.named(game.name), mutable: false, span: game.span });

    this.validateRtpObligation(game);

    for (const fn of game.functions) this.checkFn(fn);

    this.currentGameName = savedGameName;
    this.scope = savedScope;
  }

  /**
   * Enforce the whitepaper's RTP rule at the level a prototype can:
   * a declared target must be a plausible probability, an `#[rtp]` attribute must
   * carry a target, and a game declaring an RTP must expose a `spin` entry point
   * so the value is verifiable.
   */
  private validateRtpObligation(game: GameDecl): void {
    const rtpField = game.fields.find((f) => f.name === "rtp" || f.name === "target_rtp");
    const rtpAttr = game.attributes.find((a) => a.name === "rtp");

    const readNumber = (e: Expr | undefined): number | null => {
      if (!e) return null;
      if (e.kind === "IntLit" || e.kind === "FloatLit") return e.value;
      return null;
    };

    let target: number | null = readNumber(rtpField?.value);
    if (target === null && rtpAttr) target = readNumber(rtpAttr.args["target"]);

    if (rtpAttr && target === null) {
      this.errors.push(
        typeError(
          "E0802",
          "domain.rtp",
          `#[rtp] on game \`${game.name}\` does not declare a numeric target`,
          rtpAttr.span,
          "write `#[rtp(target = 0.965, tolerance = 0.0005)]`",
        ),
      );
    }

    if (target !== null) {
      const normalised = target > 1 ? target / 100 : target;
      if (normalised <= 0 || normalised > 1) {
        this.errors.push(
          typeError(
            "E0803",
            "domain.rtp",
            `declared RTP ${target} is outside the valid range`,
            (rtpField?.span ?? rtpAttr?.span) ?? game.span,
            "RTP is a probability: write it as 0.965 or as a percentage such as 96.5",
          ),
        );
      } else if (normalised < 0.5) {
        this.warnings.push(
          typeError(
            "W0802",
            "domain.rtp",
            `declared RTP ${target} is unusually low (${(normalised * 100).toFixed(2)}%)`,
            (rtpField?.span ?? game.span),
            "most jurisdictions require a return above 80%",
          ),
        );
      }

      const hasSpin = game.functions.some((f) => f.name === "spin" || f.name === "resolve");
      if (!hasSpin) {
        this.warnings.push(
          typeError(
            "W0804",
            "domain.rtp",
            `game \`${game.name}\` declares an RTP target but has no \`spin\` or \`resolve\` function to verify it against`,
            game.span,
            "add `fn spin() -> ... uses rand` so `sunra rtp` can estimate the actual return",
          ),
        );
      }
    }
  }

  private checkBlockScoped(block: BlockStmt): void {
    const saved = this.scope;
    this.scope = new Scope(saved);
    this.checkBlock(block);
    this.scope = saved;
  }

  private checkBlock(block: BlockStmt): void {
    this.hoist(block.body);
    for (const stmt of block.body) this.checkStmt(stmt);
  }

  // ------------------------------------------------------------- expressions

  private inferExpr(expr: Expr): Ty {
    switch (expr.kind) {
      case "IntLit":
        return T.int;
      case "FloatLit":
        return T.float;
      case "StrLit":
        return T.str;
      case "BoolLit":
        return T.bool;

      case "Interp":
        for (const part of expr.parts) {
          if ("expr" in part) this.inferExpr(part.expr);
        }
        return T.str;

      case "ArrayLit": {
        if (expr.elements.length === 0) return T.list(T.unknown);
        const types = expr.elements.map((e) => this.inferExpr(e));
        const first = types[0];
        const uniform = types.every((t) => this.compatible(first, t));
        return T.list(uniform ? first : T.unknown);
      }

      case "Ident": {
        const binding = this.scope.lookup(expr.name);
        if (!binding) {
          this.errors.push(
            typeError(
              "E0425",
              "name.unresolved",
              `cannot find \`${expr.name}\` in this scope`,
              expr.span,
              "check the spelling, or declare it with `let` before use",
            ),
          );
          return T.unknown;
        }
        return binding.ty;
      }

      case "Unary": {
        const ty = this.inferExpr(expr.operand);
        if (expr.op === "not") {
          this.expectBool(ty, expr.operand);
          return T.bool;
        }
        return ty;
      }

      case "Binary":
        return this.inferBinary(expr);

      case "Assign": {
        const valueTy = this.inferExpr(expr.value);
        if (expr.target.kind === "Ident") {
          const binding = this.scope.lookup(expr.target.name);
          if (!binding) {
            this.errors.push(
              typeError(
                "E0425",
                "name.unresolved",
                `cannot find \`${expr.target.name}\` in this scope`,
                expr.target.span,
              ),
            );
            return T.unknown;
          }
          if (!binding.mutable) {
            this.errors.push(
              typeError(
                "E0384",
                "memory.immutable",
                `cannot assign twice to immutable binding \`${expr.target.name}\``,
                expr.span,
                `declare it with \`var ${expr.target.name} = ...\` if it must change`,
              ),
            );
          }
          if (!this.compatible(binding.ty, valueTy)) {
            this.errors.push(
              typeError(
                "E0308",
                "type.mismatch",
                `cannot assign \`${tyName(valueTy)}\` to a binding of type \`${tyName(binding.ty)}\``,
                expr.span,
              ),
            );
          }
          return binding.ty;
        }
        this.inferExpr(expr.target);
        return valueTy;
      }

      case "Lambda": {
        const saved = this.scope;
        this.scope = new Scope(saved);
        for (const p of expr.params) {
          this.scope.declare(p.name, {
            ty: this.resolveType(p.annotation),
            mutable: false,
            span: p.span,
          });
        }
        const ret = this.inferExpr(expr.body);
        this.scope = saved;
        return { k: "Fn", params: [], ret, effects: [], arity: expr.params.length, name: "<closure>" };
      }

      case "IfExpr": {
        this.expectBool(this.inferExpr(expr.cond), expr.cond);
        const thenTy = this.inferExpr(expr.then);
        if (expr.otherwise) {
          const elseTy = this.inferExpr(expr.otherwise);
          return this.compatible(thenTy, elseTy) ? thenTy : T.unknown;
        }
        return thenTy;
      }

      case "MatchExpr": {
        this.inferExpr(expr.subject);
        let result: Ty | null = null;
        for (const arm of expr.arms) {
          if (arm.pattern) this.inferExpr(arm.pattern);
          if (arm.guard) this.expectBool(this.inferExpr(arm.guard), arm.guard);
          const armTy = this.inferExpr(arm.body);
          result = result === null ? armTy : this.compatible(result, armTy) ? result : T.unknown;
        }
        return result ?? T.unit;
      }

      case "RangeExpr":
        this.inferExpr(expr.from);
        this.inferExpr(expr.to);
        return T.list(T.int);

      case "Index": {
        const objTy = this.inferExpr(expr.object);
        this.inferExpr(expr.index);
        if (objTy.k === "List") return objTy.of;
        return T.unknown;
      }

      case "Member":
        this.inferExpr(expr.object);
        return T.unknown; // member types resolve dynamically in the prototype

      case "Pipeline": {
        this.inferExpr(expr.value);
        this.inferExpr(expr.stage);
        return T.unknown;
      }

      case "Call":
        return this.inferCall(expr);
    }
  }

  private inferCall(expr: Expr & { kind: "Call" }): Ty {
    for (const arg of expr.args) this.inferExpr(arg);

    // effect checking on method calls into runtime namespaces (rng.pick etc.)
    if (expr.callee.kind === "Member") {
      const obj = expr.callee.object;
      const receiverTy = this.inferExpr(obj);
      if (obj.kind === "Ident") {
        this.checkNamespaceEffect(obj.name, expr.callee.property, expr.span);
      }
      if (receiverTy.k === "List" || receiverTy.k === "Str" || receiverTy.k === "Int" || receiverTy.k === "Float" || receiverTy.k === "Money") {
        const allowed = primitiveMethods(receiverTy.k);
        if (!allowed.has(expr.callee.property)) {
          this.errors.push(
            typeError(
              "E0900",
              "method.unsupported",
              `${tyName(receiverTy)} has no member \`${expr.callee.property}\``,
              expr.span,
              `available: ${[...allowed].sort().join(", ")}`,
            ),
          );
        }
      }
      return T.unknown;
    }

    if (expr.callee.kind !== "Ident") {
      this.inferExpr(expr.callee);
      return T.unknown;
    }

    const name = expr.callee.name;
    const binding = this.scope.lookup(name);
    if (!binding) {
      this.errors.push(
        typeError(
          "E0425",
          "name.unresolved",
          `cannot find function \`${name}\` in this scope`,
          expr.span,
        ),
      );
      return T.unknown;
    }

    if (binding.ty.k !== "Fn") {
      if (binding.ty.k === "Unknown" || binding.ty.k === "Named") return T.unknown;
      this.errors.push(
        typeError(
          "E0618",
          "type.not-callable",
          `\`${name}\` has type \`${tyName(binding.ty)}\` and is not callable`,
          expr.span,
        ),
      );
      return T.unknown;
    }

    const fnTy = binding.ty;
    if (fnTy.arity >= 0 && expr.args.length !== fnTy.arity) {
      this.errors.push(
        typeError(
          "E0061",
          "call.arity",
          `\`${name}\` takes ${fnTy.arity} argument${fnTy.arity === 1 ? "" : "s"} but ${expr.args.length} ${expr.args.length === 1 ? "was" : "were"} supplied`,
          expr.span,
        ),
      );
    }

    // a caller must declare every effect its callee performs
    for (const eff of fnTy.effects) {
      this.requireEffect(eff, expr.span, `${name}()`);
    }

    if (name === "print" || name === "println") {
      this.requireEffect("io", expr.span, "print()");
    }

    return fnTy.ret;
  }

  /**
   * Runtime namespaces carry effects; e.g. any `rng.*` call performs `rand`.
   *
   * Effects are tracked per member rather than per module, because several
   * modules mix pure and effectful members. `Fair.hash` is a pure function of
   * its argument and `Fair.draw` is a pure function of published commit
   * material, so an auditor can call them without acquiring the `rand`
   * capability; only `Fair.begin`, `Fair.use` and `Fair.reveal` touch the
   * generator or mutate ceremony state.
   */
  private checkNamespaceEffect(namespace: string, method: string, span: Span): void {
    const pureMembers: Record<string, string[]> = {
      Fair: ["hash", "verify", "draw", "commitment"],
      Dice: ["total"],
      rng: ["kind", "draws"],
      Random: ["draws"],
      Graphics: ["canvas", "clear", "fillRect", "strokeRect", "line", "circle", "text", "toJson", "toSvg", "commands", "width", "height", "webgl", "webglClear", "webglViewport", "webglDraw", "webglCommands"],
    };

    const exempt = pureMembers[namespace];
    if (exempt && exempt.indexOf(method) >= 0) return;

    const map: Record<string, string> = {
      rng: "rand",
      Fair: "rand",
      Dice: "rand",
      audit: "audit",
      wallet: "money",
      ai: "ai",
      chain: "chain",
      Random: "rand",
      Net: "net",
      Db: "db",
      Audio: "io",
    };
    const eff = map[namespace];
    if (eff) this.requireEffect(eff, span, `${namespace}.${method}()`);
  }

  private requireEffect(eff: string, span: Span, what: string): void {
    if (this.declaredEffects === null) return; // top level is unrestricted
    if (this.declaredEffects.has(eff)) return;
    this.errors.push(
      typeError(
        "E0615",
        "effect.violation",
        `\`${this.currentFn}\` performs the \`${eff}\` effect via ${what} but does not declare it`,
        span,
        `add \`uses ${eff}\` to the signature of \`${this.currentFn}\``,
      ),
    );
    // record it so the same violation is not reported repeatedly
    this.declaredEffects.add(eff);
  }

  private inferBinary(expr: Expr & { kind: "Binary" }): Ty {
    const left = this.inferExpr(expr.left);
    const right = this.inferExpr(expr.right);
    const op = expr.op;

    if (op === "and" || op === "or") {
      this.expectBool(left, expr.left);
      this.expectBool(right, expr.right);
      return T.bool;
    }

    if (["==", "!=", "<", "<=", ">", ">="].includes(op)) {
      if (!this.compatible(left, right)) {
        this.errors.push(
          typeError(
            "E0309",
            "type.comparison",
            `cannot compare \`${tyName(left)}\` with \`${tyName(right)}\``,
            expr.span,
          ),
        );
      }
      return T.bool;
    }

    // string concatenation
    if (op === "+" && (left.k === "Str" || right.k === "Str")) {
      if (left.k !== right.k && left.k !== "Unknown" && right.k !== "Unknown") {
        this.errors.push(
          typeError(
            "E0310",
            "type.concat",
            `cannot add \`${tyName(left)}\` to \`${tyName(right)}\``,
            expr.span,
            "use string interpolation: \"value = {x}\"",
          ),
        );
      }
      return T.str;
    }

    // the whitepaper's money rule: Money never mixes with Float
    if ((left.k === "Money" && right.k === "Float") || (left.k === "Float" && right.k === "Money")) {
      this.errors.push(
        typeError(
          "E0731",
          "domain.money.precision",
          `cannot ${op === "*" ? "multiply" : "combine"} \`Money\` with \`Float\``,
          expr.span,
          "Money is fixed-point; scale it by an integer or use Money.scale(value, ratio)",
        ),
      );
      return T.money;
    }
    if (left.k === "Money" || right.k === "Money") return T.money;

    if (left.k === "Float" || right.k === "Float") return T.float;
    if (left.k === "Int" && right.k === "Int") return T.int;
    return T.unknown;
  }

  private expectBool(ty: Ty, node: Expr): void {
    if (ty.k === "Bool" || ty.k === "Unknown") return;
    this.errors.push(
      typeError(
        "E0308",
        "type.mismatch",
        `expected a \`Bool\` condition but found \`${tyName(ty)}\``,
        node.span,
        "Sunra has no truthiness: compare explicitly, e.g. `x != 0`",
      ),
    );
  }

  private compatible(a: Ty, b: Ty): boolean {
    if (a.k === "Unknown" || b.k === "Unknown") return true;
    if (a.k === "Named" || b.k === "Named") return true;
    if (a.k === "List" && b.k === "List") return this.compatible(a.of, b.of);
    // Int is accepted where Float is expected (widening is explicit elsewhere,
    // but numeric literals are the pragmatic exception in the prototype)
    if ((a.k === "Float" && b.k === "Int") || (a.k === "Int" && b.k === "Float")) return true;
    return a.k === b.k;
  }
}

function primitiveMethods(kind: Ty["k"]): ReadonlySet<string> {
  switch (kind) {
    case "List":
      return new Set(["len", "push", "first", "last", "map", "filter", "count", "contains", "sum", "reverse", "join", "take", "pop", "indexOf", "concat", "slice", "toString"]);
    case "Str":
      return new Set(["len", "upper", "lower", "trim", "contains", "split", "chars", "indexOf", "slice", "concat", "reverse", "toString"]);
    case "Int":
    case "Float":
      return new Set(["abs", "round", "floor", "toFloat", "toInt", "toString"]);
    case "Money":
      return new Set(["isZero", "toFloat", "scale", "toString"]);
    default:
      return new Set();
  }
}

function synthSpan(): Span {
  return { file: "<builtin>", line: 0, col: 0, length: 0 };
}

export function checkProgram(program: Program): CheckResult {
  return new Checker().check(program);
}

export type { Attribute };
