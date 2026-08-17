/**
 * Ownership and region inference.
 *
 * Sunra takes Rust's guarantees but not its ceremony: there are no lifetime
 * annotations in the source language, so everything here is *inferred*.
 *
 * The model has three moving parts:
 *
 *   1. **Ownership** — aggregates (lists, strings, money, named types) are
 *      affine: they may be used any number of times by reference, but moving
 *      one out ends the binding's life. Scalars are `Copy` and never move.
 *
 *   2. **Borrows** — a use that does not consume the value takes a borrow. A
 *      unique (mutable) borrow excludes all others; shared borrows coexist.
 *      Conflicts are reported with both spans so the diagnostic can point at the
 *      two uses that disagree.
 *
 *   3. **Regions** — every binding is assigned to the region of the block that
 *      introduced it. A value may not outlive its region: returning a borrow of
 *      a local, or storing it into a longer-lived binding, is an escape.
 *
 * The result feeds two later stages: SunMIR inserts a drop at the end of each
 * owner's region, and the panic-freedom prover uses "no escapes, no
 * use-after-move" as part of its argument.
 */
import type { Span } from "../diagnostics.js";
import type { Ty } from "../checker/checker.js";
import type {
  HirBlock,
  HirExpr,
  HirFn,
  HirModule,
  HirStmt,
} from "../hir/hir.js";

export type OwnershipErrorKind =
  | "use-after-move"
  | "double-move"
  | "borrow-conflict"
  | "region-escape"
  | "move-out-of-borrow"
  | "assign-to-immutable";

export interface OwnershipError {
  kind: OwnershipErrorKind;
  fn: string;
  variable: string;
  span: Span;
  /** The earlier event that made this one illegal. */
  relatedSpan: Span | null;
  message: string;
  help: string;
}

/** How a binding's value is classified for ownership purposes. */
export type ValueClass = "copy" | "affine";

export interface BindingInfo {
  name: string;
  fn: string;
  cls: ValueClass;
  mutable: boolean;
  /** Region id the binding lives in. */
  region: number;
  /** Set when the value was moved out; the span of the move. */
  movedAt: Span | null;
  /** Region the value must not outlive (its own, or a caller's for params). */
  declaredAt: Span;
}

export interface RegionInfo {
  id: number;
  /** Enclosing region, or null for a function body. */
  parent: number | null;
  fn: string;
  /** Bindings introduced in this region, in declaration order. */
  bindings: string[];
  span: Span;
}

export interface BorrowRecord {
  variable: string;
  fn: string;
  kind: "shared" | "unique";
  span: Span;
  /** Region the borrow is valid for. */
  region: number;
}

export interface OwnershipResult {
  errors: OwnershipError[];
  /** All regions discovered, keyed by id. */
  regions: Map<number, RegionInfo>;
  /** Per-function binding tables: `fn:name` -> info. */
  bindings: Map<string, BindingInfo>;
  borrows: BorrowRecord[];
  /**
   * Drop schedule: region id -> variables to drop when it ends, in reverse
   * declaration order. SunMIR turns this straight into drop instructions.
   */
  drops: Map<number, string[]>;
}

/** Aggregates are affine; scalars are freely copyable. */
export function classify(ty: Ty): ValueClass {
  switch (ty.k) {
    case "Int":
    case "Float":
    case "Bool":
    case "Unit":
      return "copy";
    case "Str":
    case "List":
    case "Money":
    case "Named":
    case "Fn":
      return "affine";
    case "Unknown":
      // Unknown types are treated as copyable so the analysis never invents
      // move errors for code it cannot see through.
      return "copy";
  }
}

/** Builtins that consume (take ownership of) their first argument. */
const CONSUMING_CALLS = new Set(["push", "extend", "drain", "into"]);

/** Builtins that only read their arguments. */
const BORROWING_CALLS = new Set([
  "len",
  "print",
  "println",
  "str",
  "sum",
  "min",
  "max",
  "abs",
  "assert",
  "int",
  "float",
  "floor",
  "round",
  "sqrt",
]);

class OwnershipChecker {
  private readonly errors: OwnershipError[] = [];
  private readonly regions = new Map<number, RegionInfo>();
  private readonly bindings = new Map<string, BindingInfo>();
  private readonly borrows: BorrowRecord[] = [];
  private readonly drops = new Map<number, string[]>();

  private nextRegion = 0;
  private regionStack: number[] = [];
  private fn = "<top level>";
  /** Region of the function currently being analysed, or null at top level. */
  private functionRegion: number | null = null;
  /** Bindings currently in scope: name -> key into `bindings`. */
  private scopes: Array<Map<string, string>> = [];
  /** Borrows active in the current statement, for conflict detection. */
  private statementBorrows: BorrowRecord[] = [];

  run(module: HirModule): OwnershipResult {
    this.fn = "<top level>";
    this.withRegion(module.span, () => {
      for (const stmt of module.main) this.stmt(stmt);
    });

    for (const fn of module.functions) this.function(fn);

    for (const test of module.tests) {
      this.fn = `test:${test.name}`;
      this.withRegion(test.span, () => {
        for (const stmt of test.body.body) this.stmt(stmt);
      });
    }

    return {
      errors: this.errors,
      regions: this.regions,
      bindings: this.bindings,
      borrows: this.borrows,
      drops: this.drops,
    };
  }

  private function(fn: HirFn): void {
    this.fn = fn.name;
    this.functionRegion = null;
    this.withRegion(fn.span, () => {
      // Remember the function's own region: a returned value may live here or
      // in a caller's region, but never in a block nested inside.
      this.functionRegion = this.regionStack[this.regionStack.length - 1];
      // Parameters live in the function's region. They arrive owned, which is
      // why moving one out is legal but using it afterwards is not.
      for (const param of fn.params) {
        this.declare(param.name, param.ty, false, param.span);
      }
      for (const stmt of fn.body.body) this.stmt(stmt);
    });
    this.functionRegion = null;
  }

  /**
   * A returned value must not reference a binding whose region is strictly
   * inside the function's own region.
   */
  private checkEscape(expr: HirExpr, fnRegion: number, span: Span): void {
    const names = new Set<string>();
    collectNames(expr, names);
    for (const name of names) {
      const key = this.resolve(name);
      if (!key) continue;
      const info = this.bindings.get(key)!;
      if (info.cls !== "affine") continue;
      if (info.region !== fnRegion && this.isInside(info.region, fnRegion)) {
        this.errors.push({
          kind: "region-escape",
          fn: this.fn,
          variable: name,
          span,
          relatedSpan: info.declaredAt,
          message: `\`${name}\` does not live long enough to be returned`,
          help: `\`${name}\` is introduced in an inner block; move the binding to the function body or return an owned copy`,
        });
      }
    }
  }

  private isInside(inner: number, outer: number): boolean {
    let current: number | null = inner;
    while (current !== null) {
      if (current === outer) return inner !== outer;
      current = this.regions.get(current)?.parent ?? null;
    }
    return false;
  }

  // ------------------------------------------------------------- statements

  private stmt(stmt: HirStmt): void {
    this.statementBorrows = [];

    switch (stmt.kind) {
      case "Let": {
        // The initialiser is evaluated before the binding exists, so a
        // self-referential `let x = x` correctly refers to the outer `x`.
        this.value(stmt.value, stmt.span);
        this.declare(stmt.name, stmt.ty, stmt.mutable, stmt.span);
        break;
      }

      case "ExprStmt":
        this.value(stmt.expr, stmt.span);
        break;

      case "Return":
        if (stmt.value) {
          // Check escapes *before* consuming, while the inner scopes that
          // introduced the bindings are still open and resolvable.
          if (this.functionRegion !== null) {
            this.checkEscape(stmt.value, this.functionRegion, stmt.span);
          }
          this.value(stmt.value, stmt.span);
        }
        break;

      case "IfStmt": {
        this.borrow(stmt.cond, "shared", stmt.span);
        // Each arm gets its own region; moves in one arm do not affect the other.
        const snapshot = this.snapshotMoves();
        this.withRegion(stmt.then.span, () => {
          for (const s of stmt.then.body) this.stmt(s);
        });
        const afterThen = this.snapshotMoves();
        this.restoreMoves(snapshot);
        if (stmt.otherwise) {
          this.withRegion(stmt.otherwise.span, () => {
            for (const s of stmt.otherwise!.body) this.stmt(s);
          });
        }
        // A binding is considered moved after the `if` only if every path moved
        // it; otherwise it is still usable.
        this.intersectMoves(afterThen);
        break;
      }

      case "While": {
        this.borrow(stmt.cond, "shared", stmt.span);
        // A move inside a loop body would run twice, so the body is analysed
        // with moves *retained* across iterations: that is what makes a move in
        // a loop a double-move error.
        this.withRegion(stmt.body.span, () => {
          for (const s of stmt.body.body) this.stmt(s);
          // Second pass detects values consumed on the previous iteration.
          for (const s of stmt.body.body) this.stmt(s);
        });
        break;
      }

      case "Block":
        this.withRegion(stmt.span, () => {
          for (const s of stmt.body) this.stmt(s);
        });
        break;

      case "Break":
      case "Continue":
        break;
    }
  }

  // ------------------------------------------------------------- expressions

  /**
   * Evaluate an expression in "value position": affine operands referenced
   * directly are moved, everything else is borrowed.
   */
  private value(expr: HirExpr, span: Span): void {
    switch (expr.kind) {
      case "Const":
        break;

      case "Var":
        this.useVar(expr.name, expr.span, /* consuming */ true);
        break;

      case "List":
        for (const item of expr.items) this.value(item, span);
        break;

      case "Unary":
        this.borrow(expr.operand, "shared", span);
        break;

      case "Binary":
        // Arithmetic and comparison read their operands.
        this.borrow(expr.left, "shared", span);
        this.borrow(expr.right, "shared", span);
        break;

      case "Call":
        this.call(expr, span);
        break;

      case "Field":
        this.borrow(expr.object, "shared", span);
        break;

      case "Index":
        this.borrow(expr.object, "shared", span);
        this.borrow(expr.index, "shared", span);
        break;

      case "Assign": {
        // The right-hand side is evaluated (and possibly moved) first.
        this.value(expr.value, span);
        if (expr.place.kind === "Var") {
          const key = this.resolve(expr.place.name);
          if (key) {
            const info = this.bindings.get(key)!;
            if (!info.mutable) {
              this.errors.push({
                kind: "assign-to-immutable",
                fn: this.fn,
                variable: expr.place.name,
                span: expr.span,
                relatedSpan: info.declaredAt,
                message: `cannot assign to immutable binding \`${expr.place.name}\``,
                help: `declare it with \`var ${expr.place.name}\` if it needs to change`,
              });
            }
            // Reassignment revives a moved binding: it owns a new value.
            info.movedAt = null;
          }
          this.recordBorrow(expr.place.name, "unique", expr.span);
        } else {
          this.borrow(expr.place, "unique", span);
        }
        break;
      }

      case "Closure":
        // A closure captures by reference in this model; captured affine values
        // must therefore still be live, but are not moved.
        this.borrow(expr.body, "shared", span);
        break;

      case "If":
        this.borrow(expr.cond, "shared", span);
        this.value(expr.then, span);
        this.value(expr.otherwise, span);
        break;

      case "BlockExpr":
        this.withRegion(expr.span, () => {
          for (const s of expr.body) this.stmt(s);
        });
        break;
    }
  }

  private call(expr: HirExpr & { kind: "Call" }, span: Span): void {
    const name = expr.callee.kind === "Var" ? expr.callee.name : null;

    if (name && BORROWING_CALLS.has(name)) {
      for (const arg of expr.args) this.borrow(arg, "shared", span);
      return;
    }

    if (name && CONSUMING_CALLS.has(name)) {
      // First argument is mutated in place; the rest are moved in.
      if (expr.args.length > 0) this.borrow(expr.args[0], "unique", span);
      for (const arg of expr.args.slice(1)) this.value(arg, span);
      return;
    }

    if (expr.callee.kind === "Field") {
      // Method calls borrow the receiver.
      this.borrow(expr.callee.object, "shared", span);
    } else {
      this.borrow(expr.callee, "shared", span);
    }

    // User functions take their arguments by value: affine arguments move.
    for (const arg of expr.args) this.value(arg, span);
  }

  /** Read an expression without consuming it. */
  private borrow(expr: HirExpr, kind: "shared" | "unique", span: Span): void {
    switch (expr.kind) {
      case "Var":
        this.useVar(expr.name, expr.span, /* consuming */ false);
        this.recordBorrow(expr.name, kind, expr.span);
        break;

      case "Const":
        break;

      case "List":
        for (const item of expr.items) this.borrow(item, kind, span);
        break;

      case "Unary":
        this.borrow(expr.operand, kind, span);
        break;

      case "Binary":
        this.borrow(expr.left, "shared", span);
        this.borrow(expr.right, "shared", span);
        break;

      case "Call":
        this.call(expr, span);
        break;

      case "Field":
        this.borrow(expr.object, kind, span);
        break;

      case "Index":
        this.borrow(expr.object, kind, span);
        this.borrow(expr.index, "shared", span);
        break;

      case "Assign":
        this.value(expr, span);
        break;

      case "Closure":
        this.borrow(expr.body, "shared", span);
        break;

      case "If":
        this.borrow(expr.cond, "shared", span);
        this.borrow(expr.then, kind, span);
        this.borrow(expr.otherwise, kind, span);
        break;

      case "BlockExpr":
        this.withRegion(expr.span, () => {
          for (const s of expr.body) this.stmt(s);
        });
        break;
    }
  }

  /**
   * Record a use of a variable.
   *
   * `consuming` distinguishes a move (value position) from a read (borrow). Both
   * are illegal after a move; only the move ends the binding's life.
   */
  private useVar(name: string, span: Span, consuming: boolean): void {
    const key = this.resolve(name);
    if (!key) return;
    const info = this.bindings.get(key)!;

    if (info.cls === "copy") return;

    if (info.movedAt) {
      this.errors.push({
        kind: consuming ? "double-move" : "use-after-move",
        fn: this.fn,
        variable: name,
        span,
        relatedSpan: info.movedAt,
        message: consuming
          ? `\`${name}\` was already moved and cannot be moved again`
          : `\`${name}\` was moved and cannot be used here`,
        help: `bind a copy before the move, or restructure so \`${name}\` is used once`,
      });
      return;
    }

    if (consuming) {
      // A value that is currently uniquely borrowed cannot be moved out.
      const conflicting = this.statementBorrows.find(
        (b) => b.variable === name && b.kind === "unique",
      );
      if (conflicting) {
        this.errors.push({
          kind: "move-out-of-borrow",
          fn: this.fn,
          variable: name,
          span,
          relatedSpan: conflicting.span,
          message: `cannot move \`${name}\` while it is mutably borrowed`,
          help: `finish the mutation before moving \`${name}\``,
        });
        return;
      }
      info.movedAt = span;
    }
  }

  private recordBorrow(name: string, kind: "shared" | "unique", span: Span): void {
    const key = this.resolve(name);
    if (!key) return;
    const info = this.bindings.get(key)!;
    if (info.cls === "copy") return;

    // Conflict detection within one statement: a unique borrow excludes any
    // other borrow of the same variable.
    for (const existing of this.statementBorrows) {
      if (existing.variable !== name) continue;
      if (existing.kind === "unique" || kind === "unique") {
        this.errors.push({
          kind: "borrow-conflict",
          fn: this.fn,
          variable: name,
          span,
          relatedSpan: existing.span,
          message:
            kind === "unique"
              ? `cannot borrow \`${name}\` mutably while it is already borrowed`
              : `cannot borrow \`${name}\` while it is mutably borrowed`,
          help: `split the expression so the two uses of \`${name}\` happen in separate statements`,
        });
        return;
      }
    }

    const record: BorrowRecord = {
      variable: name,
      fn: this.fn,
      kind,
      span,
      region: this.regionStack[this.regionStack.length - 1] ?? 0,
    };
    this.statementBorrows.push(record);
    this.borrows.push(record);
  }

  // ------------------------------------------------------------- scaffolding

  private withRegion(span: Span, body: () => void): void {
    const id = this.nextRegion++;
    this.regions.set(id, {
      id,
      parent: this.regionStack[this.regionStack.length - 1] ?? null,
      fn: this.fn,
      bindings: [],
      span,
    });
    this.regionStack.push(id);
    this.scopes.push(new Map());
    body();
    // Drops run in reverse declaration order when the region ends.
    const region = this.regions.get(id)!;
    const affine = region.bindings.filter((name) => {
      const key = `${this.fn}::${id}::${name}`;
      return this.bindings.get(key)?.cls === "affine";
    });
    this.drops.set(id, [...affine].reverse());
    this.scopes.pop();
    this.regionStack.pop();
  }

  private declare(name: string, ty: Ty, mutable: boolean, span: Span): void {
    const region = this.regionStack[this.regionStack.length - 1] ?? 0;
    const key = `${this.fn}::${region}::${name}`;
    this.bindings.set(key, {
      name,
      fn: this.fn,
      cls: classify(ty),
      mutable,
      region,
      movedAt: null,
      declaredAt: span,
    });
    this.regions.get(region)?.bindings.push(name);
    this.scopes[this.scopes.length - 1].set(name, key);
  }

  private resolve(name: string): string | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const key = this.scopes[i].get(name);
      if (key) return key;
    }
    return null;
  }

  private snapshotMoves(): Map<string, Span | null> {
    const snapshot = new Map<string, Span | null>();
    for (const [key, info] of this.bindings) snapshot.set(key, info.movedAt);
    return snapshot;
  }

  private restoreMoves(snapshot: Map<string, Span | null>): void {
    for (const [key, moved] of snapshot) {
      const info = this.bindings.get(key);
      if (info) info.movedAt = moved;
    }
  }

  /** Keep a move only if it also happened on the other path. */
  private intersectMoves(other: Map<string, Span | null>): void {
    for (const [key, info] of this.bindings) {
      const otherMoved = other.get(key) ?? null;
      if (info.movedAt && !otherMoved) info.movedAt = null;
      else if (!info.movedAt && otherMoved) info.movedAt = null;
    }
  }
}

function collectNames(expr: HirExpr, out: Set<string>): void {
  switch (expr.kind) {
    case "Var":
      out.add(expr.name);
      break;
    case "List":
      expr.items.forEach((e) => collectNames(e, out));
      break;
    case "Unary":
      collectNames(expr.operand, out);
      break;
    case "Binary":
      collectNames(expr.left, out);
      collectNames(expr.right, out);
      break;
    case "Call":
      collectNames(expr.callee, out);
      expr.args.forEach((e) => collectNames(e, out));
      break;
    case "Field":
      collectNames(expr.object, out);
      break;
    case "Index":
      collectNames(expr.object, out);
      collectNames(expr.index, out);
      break;
    case "Assign":
      collectNames(expr.place, out);
      collectNames(expr.value, out);
      break;
    case "Closure":
      collectNames(expr.body, out);
      break;
    case "If":
      collectNames(expr.cond, out);
      collectNames(expr.then, out);
      collectNames(expr.otherwise, out);
      break;
    default:
      break;
  }
}

/** Run ownership and region inference over a lowered module. */
export function inferOwnership(module: HirModule): OwnershipResult {
  return new OwnershipChecker().run(module);
}
