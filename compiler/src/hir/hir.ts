/**
 * SunHIR — the desugared, fully typed high-level intermediate representation.
 *
 * The AST mirrors source syntax (two block forms, pipelines, compound
 * assignment, `game` blocks, string interpolation). SunHIR removes all of that
 * surface variety so every later stage — refinement, ownership, SunMIR, the
 * backends, the provers — reads exactly one shape per concept:
 *
 *   - pipelines            -> calls
 *   - compound assignment  -> plain assignment of a binary
 *   - `if` expressions     -> HIR `If` expression (single form, no statement/expr split)
 *   - `for` loops          -> while over an explicit index against a materialised list
 *   - `game` blocks        -> a record-shaped constructor function plus free functions
 *   - interpolation        -> string concatenation with explicit formatting calls
 *   - ranges               -> `range(from, to)` calls
 *
 * Every HIR expression carries a `ty` field. Types come from the same `Ty`
 * lattice the checker uses, so HIR is a refinement of checked source rather
 * than a parallel type universe.
 */
import type { Span } from "../diagnostics.js";
import type { Ty } from "../checker/checker.js";

export type HirExpr =
  | HirConst
  | HirVar
  | HirList
  | HirUnary
  | HirBinary
  | HirCall
  | HirField
  | HirIndex
  | HirAssign
  | HirClosure
  | HirIf
  | HirBlockExpr;

export interface HirBase {
  ty: Ty;
  span: Span;
}

/** Int, Float, Str, Bool and Unit constants. */
export interface HirConst extends HirBase {
  kind: "Const";
  value: number | string | boolean | null;
}

export interface HirVar extends HirBase {
  kind: "Var";
  name: string;
}

export interface HirList extends HirBase {
  kind: "List";
  items: HirExpr[];
}

export interface HirUnary extends HirBase {
  kind: "Unary";
  op: "neg" | "not";
  operand: HirExpr;
}

/**
 * Binary operators are normalised to explicit names so no later stage has to
 * re-parse operator spellings (`and` vs `&&`, `!=` vs `not ==`).
 */
export type HirBinOp =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "rem"
  | "pow"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "and"
  | "or"
  | "concat";

export interface HirBinary extends HirBase {
  kind: "Binary";
  op: HirBinOp;
  left: HirExpr;
  right: HirExpr;
}

export interface HirCall extends HirBase {
  kind: "Call";
  /** Callee is itself an expression: `Var`, `Field` (method) or a closure. */
  callee: HirExpr;
  args: HirExpr[];
  /** Effects the callee is known to perform, when resolvable. */
  effects: string[];
}

export interface HirField extends HirBase {
  kind: "Field";
  object: HirExpr;
  name: string;
}

export interface HirIndex extends HirBase {
  kind: "Index";
  object: HirExpr;
  index: HirExpr;
}

export interface HirAssign extends HirBase {
  kind: "Assign";
  /** Only these three places can be assigned after desugaring. */
  place: HirVar | HirField | HirIndex;
  value: HirExpr;
}

export interface HirClosure extends HirBase {
  kind: "Closure";
  params: HirParam[];
  body: HirExpr;
}

export interface HirIf extends HirBase {
  kind: "If";
  cond: HirExpr;
  then: HirExpr;
  /** Always present after lowering; a missing `else` becomes a Unit const. */
  otherwise: HirExpr;
}

/** A block used in expression position; its value is the last expression. */
export interface HirBlockExpr extends HirBase {
  kind: "BlockExpr";
  body: HirStmt[];
}

export type HirStmt =
  | HirLet
  | HirExprStmt
  | HirReturn
  | HirIfStmt
  | HirWhile
  | HirBlock
  | HirBreak
  | HirContinue;

export interface HirLet {
  kind: "Let";
  name: string;
  mutable: boolean;
  ty: Ty;
  value: HirExpr;
  span: Span;
}

export interface HirExprStmt {
  kind: "ExprStmt";
  expr: HirExpr;
  span: Span;
}

export interface HirReturn {
  kind: "Return";
  value: HirExpr | null;
  span: Span;
}

export interface HirIfStmt {
  kind: "IfStmt";
  cond: HirExpr;
  then: HirBlock;
  otherwise: HirBlock | null;
  span: Span;
}

export interface HirWhile {
  kind: "While";
  cond: HirExpr;
  body: HirBlock;
  span: Span;
}

export interface HirBlock {
  kind: "Block";
  body: HirStmt[];
  span: Span;
}

export interface HirBreak {
  kind: "Break";
  span: Span;
}

export interface HirContinue {
  kind: "Continue";
  span: Span;
}

export interface HirParam {
  name: string;
  ty: Ty;
  /**
   * The predicate from the parameter's `where` clause, lowered so the refinement
   * checker can impose it as a precondition at every call site. Absent when the
   * parameter carries no refinement.
   */
  refinement?: HirExpr | null;
  span: Span;
}

export interface HirFn {
  kind: "Fn";
  name: string;
  params: HirParam[];
  ret: Ty;
  /** Declared effects, exactly as written with `uses`. */
  effects: string[];
  /** Attributes such as `#no_panic`, preserved for the provers. */
  attributes: HirAttribute[];
  body: HirBlock;
  /** Set when the function came from a `game` block method. */
  owner: string | null;
  isPublic: boolean;
  span: Span;
}

export interface HirAttribute {
  name: string;
  args: Record<string, string | number | boolean | null>;
  span: Span;
}

/**
 * A lowered `game` block. The declarative parts survive as data (later stages
 * need the paytable and RTP obligations), while methods become normal
 * functions whose `owner` is this game.
 */
export interface HirGame {
  kind: "Game";
  name: string;
  fields: Array<{ name: string; value: HirExpr; span: Span }>;
  reels: Array<{ name: string; symbols: HirExpr; weights: HirExpr | null; span: Span }>;
  methods: string[];
  attributes: HirAttribute[];
  span: Span;
}

export interface HirTest {
  kind: "Test";
  name: string;
  body: HirBlock;
  span: Span;
}

export interface HirModule {
  kind: "Module";
  /** Source file this module was lowered from. */
  file: string;
  /** Top-level statements, in order, excluding declarations. */
  main: HirStmt[];
  functions: HirFn[];
  games: HirGame[];
  tests: HirTest[];
  /** Enum-like type declarations: name -> variants. */
  types: Array<{ name: string; variants: string[]; span: Span }>;
  imports: string[];
  span: Span;
}

/** Walk every expression in a module, innermost last. */
export function walkExprs(module: HirModule, visit: (expr: HirExpr) => void): void {
  const expr = (e: HirExpr): void => {
    switch (e.kind) {
      case "Const":
      case "Var":
        break;
      case "List":
        e.items.forEach(expr);
        break;
      case "Unary":
        expr(e.operand);
        break;
      case "Binary":
        expr(e.left);
        expr(e.right);
        break;
      case "Call":
        expr(e.callee);
        e.args.forEach(expr);
        break;
      case "Field":
        expr(e.object);
        break;
      case "Index":
        expr(e.object);
        expr(e.index);
        break;
      case "Assign":
        expr(e.place);
        expr(e.value);
        break;
      case "Closure":
        expr(e.body);
        break;
      case "If":
        expr(e.cond);
        expr(e.then);
        expr(e.otherwise);
        break;
      case "BlockExpr":
        e.body.forEach(stmt);
        break;
    }
    visit(e);
  };

  const stmt = (s: HirStmt): void => {
    switch (s.kind) {
      case "Let":
        expr(s.value);
        break;
      case "ExprStmt":
        expr(s.expr);
        break;
      case "Return":
        if (s.value) expr(s.value);
        break;
      case "IfStmt":
        expr(s.cond);
        s.then.body.forEach(stmt);
        s.otherwise?.body.forEach(stmt);
        break;
      case "While":
        expr(s.cond);
        s.body.body.forEach(stmt);
        break;
      case "Block":
        s.body.forEach(stmt);
        break;
      case "Break":
      case "Continue":
        break;
    }
  };

  module.main.forEach(stmt);
  for (const fn of module.functions) fn.body.body.forEach(stmt);
  for (const t of module.tests) t.body.body.forEach(stmt);
  for (const g of module.games) {
    g.fields.forEach((f) => expr(f.value));
    g.reels.forEach((r) => {
      expr(r.symbols);
      if (r.weights) expr(r.weights);
    });
  }
}

/** Walk every statement in a module. */
export function walkStmts(module: HirModule, visit: (stmt: HirStmt) => void): void {
  const stmt = (s: HirStmt): void => {
    visit(s);
    switch (s.kind) {
      case "IfStmt":
        s.then.body.forEach(stmt);
        s.otherwise?.body.forEach(stmt);
        break;
      case "While":
        s.body.body.forEach(stmt);
        break;
      case "Block":
        s.body.forEach(stmt);
        break;
      default:
        break;
    }
  };
  module.main.forEach(stmt);
  for (const fn of module.functions) fn.body.body.forEach(stmt);
  for (const t of module.tests) t.body.body.forEach(stmt);
}
