/**
 * SAIL — Sunra AI Language interchange.
 *
 * SAIL is the typed program as *data*: a stable, versioned JSON document that
 * AI tooling can read, diff and query without linking the compiler. It is
 * emitted from SunHIR, so what a model sees is the desugared program the later
 * stages actually compile — not the surface syntax.
 *
 * Two design commitments keep it useful:
 *
 *   1. Stability. Node shapes are declared here and versioned with
 *      `SAIL_VERSION`. Fields are added, never repurposed.
 *   2. Addressability. Every node gets a deterministic path id (`fn:spin/…`)
 *      so a query result can be cited, and a later edit can be aimed at one
 *      exact node.
 */
import { tyName, type Ty } from "../checker/checker.js";
import type {
  HirBlock,
  HirExpr,
  HirFn,
  HirModule,
  HirStmt,
} from "../hir/hir.js";

export const SAIL_VERSION = "1.0.0";

export interface SailNode {
  /** Deterministic address, e.g. `fn:spin/body/0/value`. */
  id: string;
  /** HIR node kind (`Const`, `Call`, `While`, …). */
  kind: string;
  /** Static type name where the node is an expression. */
  ty: string | null;
  /** Source location, always present. */
  loc: { file: string; line: number; col: number };
  /** Semantic labels: `call`, `effectful`, `loop`, `assignment`, … */
  tags: string[];
  /** Node-specific payload: operator, callee name, literal value, … */
  attrs: Record<string, string | number | boolean | null>;
  children: SailNode[];
}

export interface SailFunction {
  id: string;
  name: string;
  owner: string | null;
  params: Array<{ name: string; ty: string }>;
  ret: string;
  effects: string[];
  attributes: Array<{ name: string; args: Record<string, string | number | boolean | null> }>;
  isPublic: boolean;
  loc: { file: string; line: number; col: number };
  body: SailNode;
}

export interface SailGame {
  id: string;
  name: string;
  fields: Array<{ name: string; value: SailNode }>;
  reels: Array<{ name: string; symbols: SailNode; weights: SailNode | null }>;
  methods: string[];
}

export interface SailDocument {
  sail: string;
  file: string;
  /** Content hash of the document body, for cache keys and provenance. */
  digest: string;
  functions: SailFunction[];
  games: SailGame[];
  tests: Array<{ id: string; name: string; body: SailNode }>;
  types: Array<{ name: string; variants: string[] }>;
  main: SailNode;
  /** Flat index: id -> node, so queries do not need to re-walk the tree. */
  index: Record<string, { kind: string; ty: string | null; tags: string[] }>;
}

// ------------------------------------------------------------------ emission

class Emitter {
  private readonly index: SailDocument["index"] = {};

  emit(module: HirModule): SailDocument {
    const functions = module.functions.map((fn) => this.emitFn(fn));
    const games = module.games.map((game) => this.emitGame(game));
    const tests = module.tests.map((t) => ({
      id: `test:${t.name}`,
      name: t.name,
      body: this.emitBlock(t.body, `test:${t.name}/body`),
    }));
    const main = this.node({
      id: "main",
      kind: "Main",
      ty: null,
      loc: loc(module.span),
      tags: ["toplevel"],
      attrs: {},
      children: module.main.map((s, i) => this.emitStmt(s, `main/${i}`)),
    });

    const body = {
      sail: SAIL_VERSION,
      file: module.file,
      functions,
      games,
      tests,
      types: module.types.map((t) => ({ name: t.name, variants: t.variants })),
      main,
      index: this.index,
    };
    return { ...body, digest: digestOf(body) };
  }

  private emitFn(fn: HirFn): SailFunction {
    const id = `fn:${fn.name}`;
    return {
      id,
      name: fn.name,
      owner: fn.owner,
      params: fn.params.map((p) => ({ name: p.name, ty: tyName(p.ty) })),
      ret: tyName(fn.ret),
      effects: [...fn.effects],
      attributes: fn.attributes.map((a) => ({ name: a.name, args: a.args })),
      isPublic: fn.isPublic,
      loc: loc(fn.span),
      body: this.emitBlock(fn.body, `${id}/body`),
    };
  }

  private emitGame(game: HirModule["games"][number]): SailGame {
    const id = `game:${game.name}`;
    return {
      id,
      name: game.name,
      fields: game.fields.map((f) => ({
        name: f.name,
        value: this.emitExpr(f.value, `${id}/field/${f.name}`),
      })),
      reels: game.reels.map((r) => ({
        name: r.name,
        symbols: this.emitExpr(r.symbols, `${id}/reel/${r.name}/symbols`),
        weights: r.weights ? this.emitExpr(r.weights, `${id}/reel/${r.name}/weights`) : null,
      })),
      methods: [...game.methods],
    };
  }

  private emitBlock(block: HirBlock, id: string): SailNode {
    return this.node({
      id,
      kind: "Block",
      ty: null,
      loc: loc(block.span),
      tags: ["block"],
      attrs: { statements: block.body.length },
      children: block.body.map((s, i) => this.emitStmt(s, `${id}/${i}`)),
    });
  }

  private emitStmt(stmt: HirStmt, id: string): SailNode {
    switch (stmt.kind) {
      case "Let":
        return this.node({
          id,
          kind: "Let",
          ty: tyName(stmt.ty),
          loc: loc(stmt.span),
          tags: ["binding", stmt.mutable ? "mutable" : "immutable"],
          attrs: { name: stmt.name, mutable: stmt.mutable },
          children: [this.emitExpr(stmt.value, `${id}/value`)],
        });

      case "ExprStmt":
        return this.node({
          id,
          kind: "ExprStmt",
          ty: null,
          loc: loc(stmt.span),
          tags: ["statement"],
          attrs: {},
          children: [this.emitExpr(stmt.expr, `${id}/expr`)],
        });

      case "Return":
        return this.node({
          id,
          kind: "Return",
          ty: null,
          loc: loc(stmt.span),
          tags: ["control", "return"],
          attrs: { hasValue: stmt.value !== null },
          children: stmt.value ? [this.emitExpr(stmt.value, `${id}/value`)] : [],
        });

      case "IfStmt": {
        const children = [
          this.emitExpr(stmt.cond, `${id}/cond`),
          this.emitBlock(stmt.then, `${id}/then`),
        ];
        if (stmt.otherwise) children.push(this.emitBlock(stmt.otherwise, `${id}/else`));
        return this.node({
          id,
          kind: "IfStmt",
          ty: null,
          loc: loc(stmt.span),
          tags: ["control", "branch"],
          attrs: { hasElse: stmt.otherwise !== null },
          children,
        });
      }

      case "While":
        return this.node({
          id,
          kind: "While",
          ty: null,
          loc: loc(stmt.span),
          tags: ["control", "loop"],
          attrs: {},
          children: [
            this.emitExpr(stmt.cond, `${id}/cond`),
            this.emitBlock(stmt.body, `${id}/body`),
          ],
        });

      case "Block":
        return this.emitBlock(stmt, id);

      case "Break":
      case "Continue":
        return this.node({
          id,
          kind: stmt.kind,
          ty: null,
          loc: loc(stmt.span),
          tags: ["control"],
          attrs: {},
          children: [],
        });
    }
  }

  private emitExpr(expr: HirExpr, id: string): SailNode {
    const base = { id, ty: tyName(expr.ty), loc: loc(expr.span) };

    switch (expr.kind) {
      case "Const":
        return this.node({
          ...base,
          kind: "Const",
          tags: ["literal", ...literalTag(expr.ty)],
          attrs: { value: expr.value },
          children: [],
        });

      case "Var":
        return this.node({
          ...base,
          kind: "Var",
          tags: ["reference"],
          attrs: { name: expr.name },
          children: [],
        });

      case "List":
        return this.node({
          ...base,
          kind: "List",
          tags: ["aggregate"],
          attrs: { length: expr.items.length },
          children: expr.items.map((it, i) => this.emitExpr(it, `${id}/${i}`)),
        });

      case "Unary":
        return this.node({
          ...base,
          kind: "Unary",
          tags: ["operator"],
          attrs: { op: expr.op },
          children: [this.emitExpr(expr.operand, `${id}/operand`)],
        });

      case "Binary":
        return this.node({
          ...base,
          kind: "Binary",
          tags: ["operator", arithmeticTag(expr.op)],
          attrs: { op: expr.op },
          children: [
            this.emitExpr(expr.left, `${id}/left`),
            this.emitExpr(expr.right, `${id}/right`),
          ],
        });

      case "Call": {
        const name = calleeName(expr.callee);
        const tags = ["call"];
        if (expr.effects.length > 0) tags.push("effectful");
        return this.node({
          ...base,
          kind: "Call",
          tags,
          attrs: { callee: name, arity: expr.args.length, effects: expr.effects.join(",") },
          children: [
            this.emitExpr(expr.callee, `${id}/callee`),
            ...expr.args.map((a, i) => this.emitExpr(a, `${id}/arg/${i}`)),
          ],
        });
      }

      case "Field":
        return this.node({
          ...base,
          kind: "Field",
          tags: ["projection"],
          attrs: { name: expr.name },
          children: [this.emitExpr(expr.object, `${id}/object`)],
        });

      case "Index":
        return this.node({
          ...base,
          kind: "Index",
          tags: ["projection", "indexing"],
          attrs: {},
          children: [
            this.emitExpr(expr.object, `${id}/object`),
            this.emitExpr(expr.index, `${id}/index`),
          ],
        });

      case "Assign":
        return this.node({
          ...base,
          kind: "Assign",
          tags: ["assignment", "mutation"],
          attrs: { place: expr.place.kind },
          children: [
            this.emitExpr(expr.place, `${id}/place`),
            this.emitExpr(expr.value, `${id}/value`),
          ],
        });

      case "Closure":
        return this.node({
          ...base,
          kind: "Closure",
          tags: ["function", "closure"],
          attrs: { arity: expr.params.length },
          children: [this.emitExpr(expr.body, `${id}/body`)],
        });

      case "If":
        return this.node({
          ...base,
          kind: "If",
          tags: ["branch", "expression"],
          attrs: {},
          children: [
            this.emitExpr(expr.cond, `${id}/cond`),
            this.emitExpr(expr.then, `${id}/then`),
            this.emitExpr(expr.otherwise, `${id}/else`),
          ],
        });

      case "BlockExpr":
        return this.node({
          ...base,
          kind: "BlockExpr",
          tags: ["block", "expression"],
          attrs: { statements: expr.body.length },
          children: expr.body.map((s, i) => this.emitStmt(s, `${id}/${i}`)),
        });
    }
  }

  private node(n: SailNode): SailNode {
    this.index[n.id] = { kind: n.kind, ty: n.ty, tags: n.tags };
    return n;
  }
}

// ------------------------------------------------------------------ queries

export interface SailQuery {
  /** Match node kind exactly. */
  kind?: string;
  /** Match any of these tags. */
  tag?: string;
  /** Match a node attribute value (string compare on the rendered value). */
  attr?: { name: string; value: string };
  /** Match the rendered type name. */
  ty?: string;
  /** Restrict to a function name. */
  inFunction?: string;
}

export interface SailMatch {
  id: string;
  kind: string;
  ty: string | null;
  loc: { file: string; line: number; col: number };
  attrs: Record<string, string | number | boolean | null>;
}

/** Run a semantic query over a SAIL document. */
export function querySail(doc: SailDocument, query: SailQuery): SailMatch[] {
  const out: SailMatch[] = [];

  const visit = (node: SailNode): void => {
    if (matches(node, query)) {
      out.push({ id: node.id, kind: node.kind, ty: node.ty, loc: node.loc, attrs: node.attrs });
    }
    node.children.forEach(visit);
  };

  const roots: SailNode[] = [];
  if (query.inFunction) {
    const fn = doc.functions.find((f) => f.name === query.inFunction);
    if (fn) roots.push(fn.body);
  } else {
    roots.push(doc.main, ...doc.functions.map((f) => f.body), ...doc.tests.map((t) => t.body));
    for (const game of doc.games) {
      roots.push(...game.fields.map((f) => f.value));
      for (const reel of game.reels) {
        roots.push(reel.symbols);
        if (reel.weights) roots.push(reel.weights);
      }
    }
  }
  roots.forEach(visit);
  return out;
}

function matches(node: SailNode, q: SailQuery): boolean {
  if (q.kind && node.kind !== q.kind) return false;
  if (q.tag && !node.tags.includes(q.tag)) return false;
  if (q.ty && node.ty !== q.ty) return false;
  if (q.attr) {
    const value = node.attrs[q.attr.name];
    if (value === undefined || String(value) !== q.attr.value) return false;
  }
  return true;
}

/** Functions that perform a given effect, directly or via a declared `uses`. */
export function functionsWithEffect(doc: SailDocument, effect: string): string[] {
  return doc.functions.filter((fn) => fn.effects.includes(effect)).map((fn) => fn.name);
}

// ------------------------------------------------------------------ helpers

function loc(span: { file: string; line: number; col: number }): {
  file: string;
  line: number;
  col: number;
} {
  return { file: span.file, line: span.line, col: span.col };
}

function literalTag(ty: Ty): string[] {
  switch (ty.k) {
    case "Int":
    case "Float":
      return ["numeric"];
    case "Str":
      return ["text"];
    case "Bool":
      return ["boolean"];
    default:
      return [];
  }
}

function arithmeticTag(op: string): string {
  if (["add", "sub", "mul", "div", "rem", "pow"].includes(op)) return "arithmetic";
  if (["eq", "ne", "lt", "le", "gt", "ge"].includes(op)) return "comparison";
  if (op === "concat") return "text";
  return "logical";
}

function calleeName(callee: HirExpr): string {
  if (callee.kind === "Var") return callee.name;
  if (callee.kind === "Field") return `${calleeName(callee.object)}.${callee.name}`;
  return `<${callee.kind}>`;
}

/**
 * FNV-1a over the canonical JSON form. A non-cryptographic digest is the right
 * tool here: it identifies a document for caching, while the signed build
 * report carries the cryptographic guarantees.
 */
function digestOf(value: unknown): string {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

/** Emit SAIL for a lowered module. */
export function emitSail(module: HirModule): SailDocument {
  return new Emitter().emit(module);
}
