/**
 * AST -> SunHIR lowering.
 *
 * This runs *after* `checkProgram` succeeded, so it can assume the program is
 * well typed and concentrate on removing syntactic variety. Types are recovered
 * with a small local inference pass over the same `Ty` lattice the checker
 * uses; where a type genuinely cannot be recovered locally (an opaque runtime
 * namespace, for instance) the node is annotated `Unknown`, which every later
 * stage already treats as "no static claim".
 */
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
import type { Span } from "../diagnostics.js";
import { T, type Ty } from "../checker/checker.js";
import type {
  HirAttribute,
  HirBinOp,
  HirBlock,
  HirExpr,
  HirFn,
  HirGame,
  HirModule,
  HirParam,
  HirStmt,
  HirVar,
  HirField,
  HirIndex,
} from "./hir.js";

const BIN_OPS: Record<string, HirBinOp> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "rem",
  "**": "pow",
  "==": "eq",
  "!=": "ne",
  "<": "lt",
  "<=": "le",
  ">": "gt",
  ">=": "ge",
  and: "and",
  or: "or",
  "&&": "and",
  "||": "or",
};

const COMPARISONS = new Set<HirBinOp>(["eq", "ne", "lt", "le", "gt", "ge", "and", "or"]);

/** Types of the builtins whose results later stages reason about numerically. */
const BUILTIN_RETURNS: Record<string, Ty> = {
  len: T.int,
  int: T.int,
  floor: T.int,
  ceil: T.int,
  round: T.int,
  float: T.float,
  abs: T.float,
  sqrt: T.float,
  min: T.float,
  max: T.float,
  sum: T.float,
  str: T.str,
  print: T.unit,
  println: T.unit,
  assert: T.unit,
  push: T.unit,
  range: T.list(T.int),
};

/** Effects of the runtime namespaces, mirrored from the checker's rules. */
const NAMESPACE_EFFECTS: Record<string, string[]> = {
  rng: ["rand"],
  Random: ["rand"],
  Fair: ["rand"],
  Net: ["net"],
  Db: ["db"],
  Http: ["net"],
  audit: ["audit"],
  Chain: ["chain"],
  AI: ["ai"],
  Money: ["money"],
};

class Lowerer {
  /** Local variable types, innermost scope last. */
  private scopes: Array<Map<string, Ty>> = [new Map()];
  private readonly fnSignatures = new Map<string, { params: Ty[]; ret: Ty; effects: string[] }>();
  private gameCounter = 0;

  lower(program: Program, file: string): HirModule {
    // Pre-register signatures so call sites can be typed regardless of order.
    for (const stmt of program.body) {
      if (stmt.kind === "FnDecl") this.registerFn(stmt, null);
      if (stmt.kind === "GameDecl") {
        for (const method of stmt.functions) this.registerFn(method, stmt.name);
      }
    }

    const functions: HirFn[] = [];
    const games: HirGame[] = [];
    const tests: HirModule["tests"] = [];
    const types: HirModule["types"] = [];
    const imports: string[] = [];
    const main: HirStmt[] = [];

    for (const stmt of program.body) {
      switch (stmt.kind) {
        case "FnDecl":
          functions.push(this.lowerFn(stmt, null));
          break;
        case "GameDecl": {
          const { game, methods } = this.lowerGame(stmt);
          games.push(game);
          functions.push(...methods);
          break;
        }
        case "TestDecl":
          tests.push({
            kind: "Test",
            name: stmt.name,
            body: this.lowerBlock(stmt.body),
            span: stmt.span,
          });
          break;
        case "TypeDecl":
          types.push({ name: stmt.name, variants: stmt.variants, span: stmt.span });
          // Variants are values of the declared type.
          for (const v of stmt.variants) this.declare(v, T.named(stmt.name));
          break;
        case "UseStmt":
        case "ModuleStmt":
          imports.push(stmt.path);
          break;
        default:
          main.push(...this.lowerStmt(stmt));
          break;
      }
    }

    return {
      kind: "Module",
      file,
      main,
      functions,
      games,
      tests,
      types,
      imports,
      span: program.span,
    };
  }

  // ------------------------------------------------------------- declarations

  private registerFn(fn: FnDecl, owner: string | null): void {
    const key = owner ? `${owner}.${fn.name}` : fn.name;
    this.fnSignatures.set(key, {
      params: fn.params.map((p) => this.resolveType(p.annotation)),
      ret: this.resolveType(fn.returnType),
      effects: fn.effects,
    });
  }

  private lowerFn(fn: FnDecl, owner: string | null): HirFn {
    const params: HirParam[] = fn.params.map((p) => ({
      name: p.name,
      ty: this.resolveType(p.annotation),
      span: p.span,
    }));

    this.pushScope();
    for (const p of params) this.declare(p.name, p.ty);

    // Refinements are lowered inside the parameter scope, because a predicate
    // such as `x > 0` refers to the parameter it constrains. `self` is the
    // positional spelling of the refined value.
    for (let i = 0; i < fn.params.length; i++) {
      const predicate = fn.params[i].annotation?.refinement;
      if (!predicate) continue;
      const binder = fn.params[i].annotation?.refinementBinder ?? "self";
      if (binder === "self") this.declare("self", params[i].ty);
      params[i].refinement = this.lowerExpr(predicate);
    }

    const body = this.lowerBlock(fn.body);
    this.popScope();

    return {
      kind: "Fn",
      name: owner ? `${owner}.${fn.name}` : fn.name,
      params,
      ret: this.resolveType(fn.returnType),
      effects: [...fn.effects],
      attributes: fn.attributes.map((a) => this.lowerAttribute(a)),
      body,
      owner,
      isPublic: fn.isPublic,
      span: fn.span,
    };
  }

  private lowerGame(decl: GameDecl): { game: HirGame; methods: HirFn[] } {
    const fields = decl.fields.map((f) => ({
      name: f.name,
      value: this.lowerExpr(f.value),
      span: f.span,
    }));
    const reels = decl.reels.map((r) => ({
      name: r.name,
      symbols: this.lowerExpr(r.symbols),
      weights: r.weights ? this.lowerExpr(r.weights) : null,
      span: r.span,
    }));

    // Game methods see the declarative members as locals.
    this.pushScope();
    for (const f of fields) this.declare(f.name, f.value.ty);
    for (const r of reels) this.declare(r.name, r.symbols.ty);
    const methods = decl.functions.map((m) => this.lowerFn(m, decl.name));
    this.popScope();

    this.gameCounter += 1;
    return {
      game: {
        kind: "Game",
        name: decl.name,
        fields,
        reels,
        methods: methods.map((m) => m.name),
        attributes: decl.attributes.map((a) => this.lowerAttribute(a)),
        span: decl.span,
      },
      methods,
    };
  }

  private lowerAttribute(attr: Attribute): HirAttribute {
    const args: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(attr.args)) {
      args[key] = literalOf(value);
    }
    return { name: attr.name, args, span: attr.span };
  }

  // ------------------------------------------------------------- statements

  private lowerBlock(block: BlockStmt): HirBlock {
    this.pushScope();
    const body: HirStmt[] = [];
    for (const stmt of block.body) body.push(...this.lowerStmt(stmt));
    this.popScope();
    return { kind: "Block", body, span: block.span };
  }

  private lowerStmt(stmt: Stmt): HirStmt[] {
    switch (stmt.kind) {
      case "LetStmt": {
        const value = this.lowerExpr(stmt.value);
        const annotated = stmt.annotation ? this.resolveType(stmt.annotation) : null;
        const ty = annotated && annotated.k !== "Unknown" ? annotated : value.ty;
        this.declare(stmt.name, ty);
        return [
          {
            kind: "Let",
            name: stmt.name,
            mutable: stmt.mutable,
            ty,
            value,
            span: stmt.span,
          },
        ];
      }

      case "ExprStmt":
        return [{ kind: "ExprStmt", expr: this.lowerExpr(stmt.expr), span: stmt.span }];

      case "ReturnStmt":
        return [
          {
            kind: "Return",
            value: stmt.value ? this.lowerExpr(stmt.value) : null,
            span: stmt.span,
          },
        ];

      case "IfStmt": {
        const otherwise =
          stmt.otherwise === null
            ? null
            : stmt.otherwise.kind === "BlockStmt"
              ? this.lowerBlock(stmt.otherwise)
              : ({
                  kind: "Block",
                  body: this.lowerStmt(stmt.otherwise),
                  span: stmt.otherwise.span,
                } satisfies HirBlock);
        return [
          {
            kind: "IfStmt",
            cond: this.lowerExpr(stmt.cond),
            then: this.lowerBlock(stmt.then),
            otherwise,
            span: stmt.span,
          },
        ];
      }

      case "WhileStmt":
        return [
          {
            kind: "While",
            cond: this.lowerExpr(stmt.cond),
            body: this.lowerBlock(stmt.body),
            span: stmt.span,
          },
        ];

      case "ForStmt":
        return this.lowerFor(stmt);

      case "BlockStmt":
        return [this.lowerBlock(stmt)];

      case "BreakStmt":
        return [{ kind: "Break", span: stmt.span }];

      case "ContinueStmt":
        return [{ kind: "Continue", span: stmt.span }];

      case "FnDecl":
      case "GameDecl":
      case "TypeDecl":
      case "UseStmt":
      case "ModuleStmt":
      case "TestDecl":
        // Declarations are hoisted by `lower`, never emitted inline.
        return [];
    }
  }

  /**
   * `for x in xs { body }` becomes:
   *
   *   let __iter_n = xs
   *   var __idx_n  = 0
   *   while __idx_n < len(__iter_n) {
   *     let x = __iter_n[__idx_n]
   *     __idx_n = __idx_n + 1
   *     body
   *   }
   *
   * The index increment precedes the body so `continue` cannot skip it, which
   * keeps the lowering faithful to the interpreter's loop semantics.
   */
  private lowerFor(stmt: Stmt & { kind: "ForStmt" }): HirStmt[] {
    const span = stmt.span;
    const id = this.nextTemp();
    const iterName = `__iter${id}`;
    const idxName = `__idx${id}`;

    const iterable = this.lowerExpr(stmt.iterable);
    const elemTy = iterable.ty.k === "List" ? iterable.ty.of : T.unknown;
    this.declare(iterName, iterable.ty);
    this.declare(idxName, T.int);

    const iterVar: HirVar = { kind: "Var", name: iterName, ty: iterable.ty, span };
    const idxVar: HirVar = { kind: "Var", name: idxName, ty: T.int, span };

    const lenCall: HirExpr = {
      kind: "Call",
      callee: { kind: "Var", name: "len", ty: T.unknown, span },
      args: [iterVar],
      effects: [],
      ty: T.int,
      span,
    };

    this.pushScope();
    this.declare(stmt.binding, elemTy);
    const bodyBlock = this.lowerBlock(stmt.body);
    this.popScope();

    const loopBody: HirStmt[] = [
      {
        kind: "Let",
        name: stmt.binding,
        mutable: false,
        ty: elemTy,
        value: { kind: "Index", object: iterVar, index: idxVar, ty: elemTy, span },
        span,
      },
      {
        kind: "ExprStmt",
        expr: {
          kind: "Assign",
          place: idxVar,
          value: {
            kind: "Binary",
            op: "add",
            left: idxVar,
            right: { kind: "Const", value: 1, ty: T.int, span },
            ty: T.int,
            span,
          },
          ty: T.int,
          span,
        },
        span,
      },
      ...bodyBlock.body,
    ];

    return [
      { kind: "Let", name: iterName, mutable: false, ty: iterable.ty, value: iterable, span },
      {
        kind: "Let",
        name: idxName,
        mutable: true,
        ty: T.int,
        value: { kind: "Const", value: 0, ty: T.int, span },
        span,
      },
      {
        kind: "While",
        cond: { kind: "Binary", op: "lt", left: idxVar, right: lenCall, ty: T.bool, span },
        body: { kind: "Block", body: loopBody, span },
        span,
      },
    ];
  }

  // ------------------------------------------------------------- expressions

  private lowerExpr(expr: Expr): HirExpr {
    const span = expr.span;
    switch (expr.kind) {
      case "IntLit":
        return { kind: "Const", value: expr.value, ty: T.int, span };
      case "FloatLit":
        return { kind: "Const", value: expr.value, ty: T.float, span };
      case "StrLit":
        return { kind: "Const", value: expr.value, ty: T.str, span };
      case "BoolLit":
        return { kind: "Const", value: expr.value, ty: T.bool, span };

      case "ArrayLit": {
        const items = expr.elements.map((e) => this.lowerExpr(e));
        const of = items.length > 0 ? items[0].ty : T.unknown;
        return { kind: "List", items, ty: T.list(of), span };
      }

      case "Ident":
        return { kind: "Var", name: expr.name, ty: this.lookup(expr.name), span };

      case "Unary": {
        const operand = this.lowerExpr(expr.operand);
        if (expr.op === "not") {
          return { kind: "Unary", op: "not", operand, ty: T.bool, span };
        }
        if (expr.op === "-") {
          return { kind: "Unary", op: "neg", operand, ty: operand.ty, span };
        }
        return operand;
      }

      case "Binary": {
        const op = BIN_OPS[expr.op];
        const left = this.lowerExpr(expr.left);
        const right = this.lowerExpr(expr.right);
        if (!op) {
          // Unknown spelling: keep it as a call so nothing is silently dropped.
          return {
            kind: "Call",
            callee: { kind: "Var", name: `op${expr.op}`, ty: T.unknown, span },
            args: [left, right],
            effects: [],
            ty: T.unknown,
            span,
          };
        }
        // String `+` is concatenation, which the backends implement differently.
        const normalised: HirBinOp = op === "add" && left.ty.k === "Str" ? "concat" : op;
        return {
          kind: "Binary",
          op: normalised,
          left,
          right,
          ty: this.binaryTy(normalised, left.ty, right.ty),
          span,
        };
      }

      case "Call": {
        const callee = this.lowerExpr(expr.callee);
        const args = expr.args.map((a) => this.lowerExpr(a));
        return {
          kind: "Call",
          callee,
          args,
          effects: this.calleeEffects(expr),
          ty: this.callTy(expr, callee),
          span,
        };
      }

      case "Member": {
        const object = this.lowerExpr(expr.object);
        return { kind: "Field", object, name: expr.property, ty: T.unknown, span };
      }

      case "Index": {
        const object = this.lowerExpr(expr.object);
        const index = this.lowerExpr(expr.index);
        const ty = object.ty.k === "List" ? object.ty.of : object.ty.k === "Str" ? T.str : T.unknown;
        return { kind: "Index", object, index, ty, span };
      }

      case "Assign": {
        const place = this.lowerPlace(expr.target);
        const rhs = this.lowerExpr(expr.value);
        if (expr.op === "=") {
          return { kind: "Assign", place, value: rhs, ty: rhs.ty, span };
        }
        // Compound assignment: `x += e` -> `x = x + e`.
        const op = BIN_OPS[expr.op.slice(0, expr.op.length - 1)] ?? "add";
        const combined: HirExpr = {
          kind: "Binary",
          op: op === "add" && place.ty.k === "Str" ? "concat" : op,
          left: place,
          right: rhs,
          ty: this.binaryTy(op, place.ty, rhs.ty),
          span,
        };
        return { kind: "Assign", place, value: combined, ty: combined.ty, span };
      }

      case "Lambda": {
        const params: HirParam[] = expr.params.map((p) => ({
          name: p.name,
          ty: this.resolveType(p.annotation),
          span: p.span,
        }));
        this.pushScope();
        for (const p of params) this.declare(p.name, p.ty);
        const body = this.lowerExpr(expr.body);
        this.popScope();
        return {
          kind: "Closure",
          params,
          body,
          ty: { k: "Fn", params: params.map((p) => p.ty), ret: body.ty, effects: [], arity: params.length, name: "<closure>" },
          span,
        };
      }

      case "IfExpr": {
        const cond = this.lowerExpr(expr.cond);
        const then = this.lowerExpr(expr.then);
        const otherwise: HirExpr = expr.otherwise
          ? this.lowerExpr(expr.otherwise)
          : { kind: "Const", value: null, ty: T.unit, span };
        return {
          kind: "If",
          cond,
          then,
          otherwise,
          ty: then.ty.k === "Unknown" ? otherwise.ty : then.ty,
          span,
        };
      }

      case "MatchExpr":
        return this.lowerMatch(expr);

      case "RangeExpr": {
        // `a..b` -> range(a, b); inclusive ranges add one to the bound.
        const from = this.lowerExpr(expr.from);
        const to = this.lowerExpr(expr.to);
        const bound: HirExpr = expr.inclusive
          ? {
              kind: "Binary",
              op: "add",
              left: to,
              right: { kind: "Const", value: 1, ty: T.int, span },
              ty: T.int,
              span,
            }
          : to;
        return {
          kind: "Call",
          callee: { kind: "Var", name: "range", ty: T.unknown, span },
          args: [from, bound],
          effects: [],
          ty: T.list(T.int),
          span,
        };
      }

      case "Interp": {
        // Interpolation becomes explicit concatenation of stringified parts.
        let acc: HirExpr | null = null;
        for (const part of expr.parts) {
          const piece: HirExpr =
            "text" in part
              ? { kind: "Const", value: part.text, ty: T.str, span }
              : {
                  kind: "Call",
                  callee: { kind: "Var", name: "str", ty: T.unknown, span },
                  args: [this.lowerExpr(part.expr)],
                  effects: [],
                  ty: T.str,
                  span,
                };
          acc = acc === null ? piece : { kind: "Binary", op: "concat", left: acc, right: piece, ty: T.str, span };
        }
        return acc ?? { kind: "Const", value: "", ty: T.str, span };
      }

      case "Pipeline": {
        // `v |> f(a)` -> `f(v, a)`; `v |> f` -> `f(v)`.
        const value = this.lowerExpr(expr.value);
        if (expr.stage.kind === "Call") {
          const callee = this.lowerExpr(expr.stage.callee);
          const args = [value, ...expr.stage.args.map((a) => this.lowerExpr(a))];
          return {
            kind: "Call",
            callee,
            args,
            effects: this.calleeEffects(expr.stage),
            ty: this.callTy(expr.stage, callee),
            span,
          };
        }
        const callee = this.lowerExpr(expr.stage);
        return {
          kind: "Call",
          callee,
          args: [value],
          effects: [],
          ty: this.returnTyOf(callee),
          span,
        };
      }
    }
  }

  /**
   * `match subject { p1 => e1, _ => e2 }` becomes a chain of `If` expressions
   * comparing the subject against each pattern. Guards become `and` conditions.
   */
  private lowerMatch(expr: Expr & { kind: "MatchExpr" }): HirExpr {
    const span = expr.span;
    const subject = this.lowerExpr(expr.subject);

    let result: HirExpr = { kind: "Const", value: null, ty: T.unit, span };
    for (let i = expr.arms.length - 1; i >= 0; i--) {
      const arm = expr.arms[i];
      const body = this.lowerExpr(arm.body);
      if (arm.pattern === null && arm.guard === null) {
        result = body;
        continue;
      }
      let cond: HirExpr;
      if (arm.pattern === null) {
        cond = this.lowerExpr(arm.guard!);
      } else {
        const test: HirExpr = {
          kind: "Binary",
          op: "eq",
          left: subject,
          right: this.lowerExpr(arm.pattern),
          ty: T.bool,
          span: arm.span,
        };
        cond = arm.guard
          ? {
              kind: "Binary",
              op: "and",
              left: test,
              right: this.lowerExpr(arm.guard),
              ty: T.bool,
              span: arm.span,
            }
          : test;
      }
      result = { kind: "If", cond, then: body, otherwise: result, ty: body.ty, span: arm.span };
    }
    return result;
  }

  private lowerPlace(target: Expr): HirVar | HirField | HirIndex {
    const lowered = this.lowerExpr(target);
    if (lowered.kind === "Var" || lowered.kind === "Field" || lowered.kind === "Index") {
      return lowered;
    }
    // The checker rejects other assignment targets; keep a well-formed node.
    return { kind: "Var", name: "<invalid>", ty: T.unknown, span: target.span };
  }

  // ------------------------------------------------------------- types

  private binaryTy(op: HirBinOp, left: Ty, right: Ty): Ty {
    if (COMPARISONS.has(op)) return T.bool;
    if (op === "concat") return T.str;
    if (left.k === "Money" || right.k === "Money") return T.money;
    if (op === "pow") return T.float;
    if (left.k === "Float" || right.k === "Float") return T.float;
    if (left.k === "Int" && right.k === "Int") return T.int;
    if (left.k === "Str" || right.k === "Str") return T.str;
    return T.unknown;
  }

  private callTy(expr: Expr & { kind: "Call" }, callee: HirExpr): Ty {
    if (expr.callee.kind === "Ident") {
      const builtin = BUILTIN_RETURNS[expr.callee.name];
      if (builtin) return builtin;
      const sig = this.fnSignatures.get(expr.callee.name);
      if (sig) return sig.ret;
    }
    return this.returnTyOf(callee);
  }

  private returnTyOf(callee: HirExpr): Ty {
    return callee.ty.k === "Fn" ? callee.ty.ret : T.unknown;
  }

  private calleeEffects(expr: Expr & { kind: "Call" }): string[] {
    if (expr.callee.kind === "Ident") {
      const sig = this.fnSignatures.get(expr.callee.name);
      if (sig) return [...sig.effects];
      if (expr.callee.name === "print" || expr.callee.name === "println") return ["io"];
      return [];
    }
    if (expr.callee.kind === "Member" && expr.callee.object.kind === "Ident") {
      return NAMESPACE_EFFECTS[expr.callee.object.name] ?? [];
    }
    return [];
  }

  private resolveType(node: TypeNode | null): Ty {
    if (!node) return T.unknown;
    switch (node.name) {
      case "Int":
        return T.int;
      case "Float":
        return T.float;
      case "Str":
      case "String":
        return T.str;
      case "Bool":
        return T.bool;
      case "Unit":
        return T.unit;
      case "Money":
        return T.money;
      case "List":
        return T.list(node.args.length > 0 ? this.resolveType(node.args[0]) : T.unknown);
      default:
        return T.named(node.name);
    }
  }

  // ------------------------------------------------------------- scopes

  private pushScope(): void {
    this.scopes.push(new Map());
  }

  private popScope(): void {
    this.scopes.pop();
  }

  private declare(name: string, ty: Ty): void {
    this.scopes[this.scopes.length - 1].set(name, ty);
  }

  private lookup(name: string): Ty {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i].get(name);
      if (found) return found;
    }
    const sig = this.fnSignatures.get(name);
    if (sig) {
      return { k: "Fn", params: sig.params, ret: sig.ret, effects: sig.effects, arity: sig.params.length, name };
    }
    return T.unknown;
  }

  private nextTemp(): number {
    this.gameCounter += 1;
    return this.gameCounter;
  }
}

function literalOf(expr: Expr): string | number | boolean | null {
  switch (expr.kind) {
    case "IntLit":
    case "FloatLit":
      return expr.value;
    case "StrLit":
      return expr.value;
    case "BoolLit":
      return expr.value;
    default:
      return null;
  }
}

/** Lower a checked program into SunHIR. */
export function lowerToHir(program: Program, file: string): HirModule {
  return new Lowerer().lower(program, file);
}

export type { Span };
