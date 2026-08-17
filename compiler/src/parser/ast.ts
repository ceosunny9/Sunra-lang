import type { Span } from "../diagnostics.js";

/** Type annotations are optional in Sunra source; when present they look like `x: Int`. */
export interface TypeNode {
  kind: "TypeRef";
  name: string;
  args: TypeNode[];
  /**
   * A refinement predicate from a `where` clause, e.g. `Int where x > 0`.
   *
   * The parser used to discard this, which meant a refinement type was accepted
   * and then never enforced. Keeping the expression is what lets the refinement
   * checker turn it into an obligation at every call site.
   */
  refinement?: Expr | null;
  /**
   * The name the predicate refers to. `where self > 0` binds `self`; a predicate
   * written in terms of the parameter name binds that instead.
   */
  refinementBinder?: string | null;
  span: Span;
}

// ------------------------------------------------------------------ expressions

export type Expr =
  | IntLit
  | FloatLit
  | StrLit
  | BoolLit
  | ArrayLit
  | Ident
  | Unary
  | Binary
  | Call
  | Member
  | Index
  | Assign
  | Lambda
  | IfExpr
  | MatchExpr
  | RangeExpr
  | Interp
  | Pipeline;

export interface IntLit {
  kind: "IntLit";
  value: number;
  span: Span;
}
export interface FloatLit {
  kind: "FloatLit";
  value: number;
  span: Span;
}
export interface StrLit {
  kind: "StrLit";
  value: string;
  span: Span;
}
export interface BoolLit {
  kind: "BoolLit";
  value: boolean;
  span: Span;
}
export interface ArrayLit {
  kind: "ArrayLit";
  elements: Expr[];
  span: Span;
}
export interface Ident {
  kind: "Ident";
  name: string;
  span: Span;
}
export interface Unary {
  kind: "Unary";
  op: string;
  operand: Expr;
  span: Span;
}
export interface Binary {
  kind: "Binary";
  op: string;
  left: Expr;
  right: Expr;
  span: Span;
}
export interface Call {
  kind: "Call";
  callee: Expr;
  args: Expr[];
  span: Span;
}
export interface Member {
  kind: "Member";
  object: Expr;
  property: string;
  span: Span;
}
export interface Index {
  kind: "Index";
  object: Expr;
  index: Expr;
  span: Span;
}
export interface Assign {
  kind: "Assign";
  target: Expr;
  op: string;
  value: Expr;
  span: Span;
}
export interface Lambda {
  kind: "Lambda";
  params: Param[];
  body: Expr;
  span: Span;
}
export interface IfExpr {
  kind: "IfExpr";
  cond: Expr;
  then: Expr;
  otherwise: Expr | null;
  span: Span;
}
export interface MatchArm {
  pattern: Expr | null; // null = wildcard `_`
  guard: Expr | null;
  body: Expr;
  span: Span;
}
export interface MatchExpr {
  kind: "MatchExpr";
  subject: Expr;
  arms: MatchArm[];
  span: Span;
}
export interface RangeExpr {
  kind: "RangeExpr";
  from: Expr;
  to: Expr;
  inclusive: boolean;
  span: Span;
}
/** String interpolation: "a {x} b" desugars to Interp with parts. */
export interface Interp {
  kind: "Interp";
  parts: Array<{ text: string } | { expr: Expr; format: string | null }>;
  span: Span;
}
export interface Pipeline {
  kind: "Pipeline";
  value: Expr;
  stage: Expr;
  span: Span;
}

// ------------------------------------------------------------------ statements

export type Stmt =
  | LetStmt
  | ExprStmt
  | ReturnStmt
  | IfStmt
  | WhileStmt
  | ForStmt
  | BlockStmt
  | BreakStmt
  | ContinueStmt
  | FnDecl
  | GameDecl
  | TypeDecl
  | UseStmt
  | ModuleStmt
  | TestDecl;

export interface LetStmt {
  kind: "LetStmt";
  name: string;
  mutable: boolean;
  annotation: TypeNode | null;
  value: Expr;
  span: Span;
}
export interface ExprStmt {
  kind: "ExprStmt";
  expr: Expr;
  span: Span;
}
export interface ReturnStmt {
  kind: "ReturnStmt";
  value: Expr | null;
  span: Span;
}
export interface IfStmt {
  kind: "IfStmt";
  cond: Expr;
  then: BlockStmt;
  otherwise: BlockStmt | IfStmt | null;
  span: Span;
}
export interface WhileStmt {
  kind: "WhileStmt";
  cond: Expr;
  body: BlockStmt;
  span: Span;
}
export interface ForStmt {
  kind: "ForStmt";
  binding: string;
  iterable: Expr;
  body: BlockStmt;
  span: Span;
}
export interface BlockStmt {
  kind: "BlockStmt";
  body: Stmt[];
  span: Span;
}
export interface BreakStmt {
  kind: "BreakStmt";
  span: Span;
}
export interface ContinueStmt {
  kind: "ContinueStmt";
  span: Span;
}

export interface Param {
  name: string;
  annotation: TypeNode | null;
  span: Span;
}

export interface Attribute {
  name: string;
  args: Record<string, Expr>;
  span: Span;
}

export interface FnDecl {
  kind: "FnDecl";
  name: string;
  params: Param[];
  returnType: TypeNode | null;
  effects: string[];
  body: BlockStmt;
  attributes: Attribute[];
  intent: string | null;
  isPublic: boolean;
  span: Span;
}

/** A `game` block: declarative fields, reel/symbol tables, and methods. */
export interface GameDecl {
  kind: "GameDecl";
  name: string;
  fields: GameField[];
  reels: ReelDecl[];
  functions: FnDecl[];
  attributes: Attribute[];
  span: Span;
}
export interface GameField {
  name: string;
  value: Expr;
  span: Span;
}
export interface ReelDecl {
  /** `reel symbols = [...]` — name is the binding, symbols the strip */
  name: string;
  symbols: Expr;
  weights: Expr | null;
  span: Span;
}

export interface TypeDecl {
  kind: "TypeDecl";
  name: string;
  variants: string[];
  span: Span;
}
export interface UseStmt {
  kind: "UseStmt";
  path: string;
  span: Span;
}
export interface ModuleStmt {
  kind: "ModuleStmt";
  path: string;
  span: Span;
}
export interface TestDecl {
  kind: "TestDecl";
  name: string;
  body: BlockStmt;
  span: Span;
}

export interface Program {
  kind: "Program";
  body: Stmt[];
  span: Span;
}
