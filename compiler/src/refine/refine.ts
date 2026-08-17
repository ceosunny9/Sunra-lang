/**
 * The refinement checker.
 *
 * It walks SunHIR carrying two abstract states in parallel:
 *
 *   - an interval environment, which answers "what range can this variable
 *     hold?" and is what proves a divisor is non-zero or an RTP is in [0,100];
 *   - a linear constraint store, which answers relational questions intervals
 *     cannot ("is `i` below `len(xs)` *here*?") and is what proves an index is
 *     in bounds.
 *
 * Every potentially-trapping operation becomes an *obligation*. An obligation is
 * either discharged (proved safe) or reported. Nothing is assumed safe by
 * default: when the analysis cannot decide, the obligation is reported as
 * `unknown`, which the panic-freedom prover later treats as a residual.
 */
import type { Span } from "../diagnostics.js";
import type { Ty } from "../checker/checker.js";
import type {
  HirBlock,
  HirExpr,
  HirFn,
  HirModule,
  HirParam,
  HirStmt,
} from "../hir/hir.js";
import * as I from "./interval.js";
import {
  LinearStore,
  lit,
  minus,
  plus,
  scale,
  variable,
  type LinearExpr,
  type LinearConstraint,
} from "./linear.js";

export type ObligationKind =
  | "division-by-zero"
  | "index-out-of-bounds"
  | "negative-index"
  | "rtp-range"
  | "money-negative"
  | "modulo-by-zero"
  /** A `where` clause on a parameter, imposed at every call site. */
  | "refinement-precondition";

export type ObligationStatus = "proved" | "violated" | "unknown";

export interface Obligation {
  kind: ObligationKind;
  status: ObligationStatus;
  /** Function the obligation arose in, or `<top level>`. */
  fn: string;
  span: Span;
  /** Human-readable statement of what had to hold. */
  claim: string;
  /** Why the checker reached its verdict. */
  reason: string;
}

export interface RefineResult {
  obligations: Obligation[];
  /** Inferred interval per function parameter and local, for reporting. */
  ranges: Map<string, string>;
  get proved(): number;
  get violated(): number;
  get unknown(): number;
}

/** Abstract state threaded through the walk. */
interface State {
  intervals: Map<string, I.Interval>;
  /** Symbolic length facts: variable -> linear expression for its length. */
  lengths: Map<string, LinearExpr>;
  linear: LinearStore;
  /**
   * Disequalities the guards established: variable -> values it cannot hold.
   *
   * `x != 0` is not a linear constraint, and the interval domain can only use it
   * when zero sits at an endpoint. Tracking it explicitly is what lets the very
   * common `if b != 0 { a / b }` idiom discharge its obligation.
   */
  disequal: Map<string, Set<number>>;
  /** False once a contradictory guard proves the path unreachable. */
  reachable: boolean;
}

function cloneState(s: State): State {
  return {
    intervals: new Map(s.intervals),
    lengths: new Map(s.lengths),
    linear: s.linear,
    disequal: new Map([...s.disequal].map(([name, values]) => [name, new Set(values)])),
    reachable: s.reachable,
  };
}

function joinStates(a: State, b: State): State {
  if (!a.reachable) return b;
  if (!b.reachable) return a;
  const intervals = new Map<string, I.Interval>();
  for (const [name, interval] of a.intervals) {
    const other = b.intervals.get(name);
    intervals.set(name, other ? I.join(interval, other) : I.TOP);
  }
  for (const name of b.intervals.keys()) {
    if (!intervals.has(name)) intervals.set(name, I.TOP);
  }
  const lengths = new Map<string, LinearExpr>();
  for (const [name, len] of a.lengths) {
    const other = b.lengths.get(name);
    // Keep only lengths both branches agree on symbolically.
    if (other && sameLinear(len, other)) lengths.set(name, len);
  }
  return {
    intervals,
    lengths,
    // Only facts common to both paths survive a merge; taking the intersection
    // conservatively means dropping to the shared prefix.
    linear: commonPrefix(a.linear, b.linear),
    // A disequality survives a merge only if both paths established it.
    disequal: intersectDisequal(a.disequal, b.disequal),
    reachable: true,
  };
}

function intersectDisequal(
  a: Map<string, Set<number>>,
  b: Map<string, Set<number>>,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [name, values] of a) {
    const other = b.get(name);
    if (!other) continue;
    const shared = new Set([...values].filter((v) => other.has(v)));
    if (shared.size > 0) out.set(name, shared);
  }
  return out;
}

function addDisequal(state: State, name: string, value: number): void {
  const existing = state.disequal.get(name);
  if (existing) existing.add(value);
  else state.disequal.set(name, new Set([value]));
}

function sameLinear(a: LinearExpr, b: LinearExpr): boolean {
  if (a.k !== b.k || a.terms.size !== b.terms.size) return false;
  for (const [name, coefficient] of a.terms) {
    if (b.terms.get(name) !== coefficient) return false;
  }
  return true;
}

function commonPrefix(a: LinearStore, b: LinearStore): LinearStore {
  const af = a.facts;
  const bf = b.facts;
  const shared: LinearConstraint[] = [];
  for (let i = 0; i < Math.min(af.length, bf.length); i++) {
    if (af[i] === bf[i]) shared.push(af[i]);
    else break;
  }
  return new LinearStore(shared);
}

class Refiner {
  private readonly obligations: Obligation[] = [];
  private readonly ranges = new Map<string, string>();
  private fn = "<top level>";
  /** Counter for fresh symbolic names (list lengths, opaque calls). */
  private fresh = 0;
  /**
   * Refined parameters per function, indexed before any body is walked so a call
   * is checked regardless of declaration order.
   */
  private readonly refinedParams = new Map<string, HirParam[]>();
  /** Parameter order per function, for positional argument matching. */
  private readonly paramOrder = new Map<string, string[]>();

  run(module: HirModule): RefineResult {
    // A refinement type that is parsed and never checked is decorative, so index
    // every `where` clause up front and impose it at each call site below.
    for (const fn of module.functions) {
      this.paramOrder.set(
        fn.name,
        fn.params.map((p) => p.name),
      );
      const refined = fn.params.filter((p) => p.refinement);
      if (refined.length > 0) this.refinedParams.set(fn.name, refined);
    }

    const top: State = {
      intervals: new Map(),
      lengths: new Map(),
      linear: new LinearStore(),
      disequal: new Map(),
      reachable: true,
    };
    this.fn = "<top level>";
    this.block({ kind: "Block", body: module.main, span: module.span }, top);

    for (const fn of module.functions) this.function(fn);

    for (const game of module.games) this.game(game);

    const obligations = this.obligations;
    const ranges = this.ranges;
    return {
      obligations,
      ranges,
      get proved() {
        return obligations.filter((o) => o.status === "proved").length;
      },
      get violated() {
        return obligations.filter((o) => o.status === "violated").length;
      },
      get unknown() {
        return obligations.filter((o) => o.status === "unknown").length;
      },
    };
  }

  // ------------------------------------------------------------- declarations

  private function(fn: HirFn): void {
    this.fn = fn.name;
    const state: State = {
      intervals: new Map(),
      lengths: new Map(),
      linear: new LinearStore(),
      disequal: new Map(),
      reachable: true,
    };

    // Parameters start at the widest range their type permits. Money is
    // non-negative by construction in Sunra, which is a fact worth carrying.
    for (const param of fn.params) {
      const interval = this.intervalOfType(param.ty);
      state.intervals.set(param.name, interval);
      if (param.ty.k === "Money") {
        state.linear = state.linear.assume(variable(param.name));
      }
      if (Number.isFinite(interval.lo)) {
        state.linear = state.linear.assume(minus(variable(param.name), lit(interval.lo)));
      }
      this.ranges.set(`${fn.name}:${param.name}`, I.format(interval));
    }

    this.block(fn.body, state);
  }

  private game(game: HirModule["games"][number]): void {
    this.fn = game.name;
    const state: State = {
      intervals: new Map(),
      lengths: new Map(),
      linear: new LinearStore(),
      disequal: new Map(),
      reachable: true,
    };

    for (const field of game.fields) {
      const value = this.expr(field.value, state);
      state.intervals.set(field.name, value);

      // RTP is a percentage: prove it lands inside [0, 100].
      if (field.name === "rtp") {
        const inRange = !I.isBottom(value) && value.lo >= 0 && value.hi <= 100;
        const impossible = !I.isBottom(value) && (value.hi < 0 || value.lo > 100);
        this.obligations.push({
          kind: "rtp-range",
          status: inRange ? "proved" : impossible ? "violated" : "unknown",
          fn: game.name,
          span: field.span,
          claim: `rtp ∈ [0, 100]`,
          reason: `rtp is inferred as ${I.format(value)}`,
        });
      }
    }

    for (const reel of game.reels) {
      const symbols = this.expr(reel.symbols, state);
      state.intervals.set(reel.name, symbols);
      if (reel.symbols.kind === "List") {
        state.lengths.set(reel.name, lit(reel.symbols.items.length));
      }
    }
  }

  // ------------------------------------------------------------- statements

  private block(block: HirBlock, state: State): State {
    let current = state;
    for (const stmt of block.body) {
      if (!current.reachable) break;
      current = this.stmt(stmt, current);
    }
    return current;
  }

  private stmt(stmt: HirStmt, state: State): State {
    switch (stmt.kind) {
      case "Let": {
        const value = this.expr(stmt.value, state);
        const next = cloneState(state);
        next.intervals.set(stmt.name, value);
        // Remember symbolic lengths so index checks can use them.
        const len = this.lengthOf(stmt.value, state);
        if (len) next.lengths.set(stmt.name, len);
        // Constants become linear facts (both directions).
        if (!I.isBottom(value) && value.lo === value.hi && Number.isFinite(value.lo)) {
          next.linear = next.linear
            .assume(minus(variable(stmt.name), lit(value.lo)))
            .assume(minus(lit(value.lo), variable(stmt.name)));
        } else if (Number.isFinite(value.lo)) {
          next.linear = next.linear.assume(minus(variable(stmt.name), lit(value.lo)));
        }
        this.ranges.set(`${this.fn}:${stmt.name}`, I.format(value));
        return next;
      }

      case "ExprStmt":
        this.expr(stmt.expr, state);
        return state;

      case "Return":
        if (stmt.value) this.expr(stmt.value, state);
        return { ...cloneState(state), reachable: false };

      case "IfStmt": {
        this.expr(stmt.cond, state);
        const thenState = this.assume(stmt.cond, state, true);
        const elseState = this.assume(stmt.cond, state, false);
        const afterThen = thenState.reachable ? this.block(stmt.then, thenState) : thenState;
        const afterElse = stmt.otherwise
          ? elseState.reachable
            ? this.block(stmt.otherwise, elseState)
            : elseState
          : elseState;
        return joinStates(afterThen, afterElse);
      }

      case "While": {
        // Fixed-point with widening: analyse the body until the entry state is
        // stable, widening after a couple of rounds so it terminates.
        let entry = cloneState(state);
        for (let iteration = 0; iteration < 8; iteration++) {
          this.expr(stmt.cond, entry);
          const inside = this.assume(stmt.cond, entry, true);
          if (!inside.reachable) break;
          const after = this.block(stmt.body, inside);
          const merged = joinStates(entry, after);
          const widened = iteration >= 2 ? this.widenState(entry, merged) : merged;
          if (this.sameIntervals(entry, widened)) break;
          entry = widened;
        }
        // After the loop the guard is false.
        return this.assume(stmt.cond, entry, false);
      }

      case "Block":
        return this.block(stmt, state);

      case "Break":
      case "Continue":
        return { ...cloneState(state), reachable: false };
    }
  }

  private widenState(previous: State, next: State): State {
    const intervals = new Map<string, I.Interval>();
    for (const [name, interval] of next.intervals) {
      const before = previous.intervals.get(name);
      intervals.set(name, before ? I.widen(before, interval) : interval);
    }
    return { ...next, intervals };
  }

  private sameIntervals(a: State, b: State): boolean {
    if (a.intervals.size !== b.intervals.size) return false;
    for (const [name, interval] of a.intervals) {
      const other = b.intervals.get(name);
      if (!other || !I.equals(interval, other)) return false;
    }
    return true;
  }

  // ------------------------------------------------------------- expressions

  private expr(expr: HirExpr, state: State): I.Interval {
    switch (expr.kind) {
      case "Const":
        if (typeof expr.value === "number") {
          return I.constant(expr.value, expr.ty.k === "Int");
        }
        if (typeof expr.value === "boolean") return I.constant(expr.value ? 1 : 0, true);
        return I.TOP;

      case "Var":
        return state.intervals.get(expr.name) ?? this.intervalOfType(expr.ty);

      case "List":
        for (const item of expr.items) this.expr(item, state);
        return I.TOP;

      case "Unary": {
        const operand = this.expr(expr.operand, state);
        return expr.op === "neg" ? I.negate(operand) : I.range(0, 1, true);
      }

      case "Binary":
        return this.binary(expr, state);

      case "Call":
        return this.call(expr, state);

      case "Field":
        this.expr(expr.object, state);
        return this.intervalOfType(expr.ty);

      case "Index":
        return this.index(expr, state);

      case "Assign": {
        const value = this.expr(expr.value, state);
        if (expr.place.kind === "Var") {
          // Assignment invalidates prior facts about the variable, so the
          // interval is replaced rather than met.
          state.intervals.set(expr.place.name, value);
          // Any disequality established earlier no longer applies.
          state.disequal.delete(expr.place.name);
          // The same is true of its length. `var xs = []` followed by
          // `xs = xs + [row]` in a loop would otherwise keep the entry fact
          // "length 0" and report every later index as out of bounds.
          const length = this.lengthOf(expr.value, state);
          if (length) state.lengths.set(expr.place.name, length);
          else state.lengths.delete(expr.place.name);
        } else {
          this.expr(expr.place, state);
        }
        return value;
      }

      case "Closure":
        // The body is analysed in isolation: captured ranges are not assumed.
        this.expr(expr.body, { ...cloneState(state), linear: new LinearStore() });
        return I.TOP;

      case "If": {
        this.expr(expr.cond, state);
        const thenState = this.assume(expr.cond, state, true);
        const elseState = this.assume(expr.cond, state, false);
        const a = thenState.reachable ? this.expr(expr.then, thenState) : I.BOTTOM;
        const b = elseState.reachable ? this.expr(expr.otherwise, elseState) : I.BOTTOM;
        return I.join(a, b);
      }

      case "BlockExpr": {
        let current = state;
        for (const stmt of expr.body) current = this.stmt(stmt, current);
        return I.TOP;
      }
    }
  }

  private binary(expr: HirExpr & { kind: "Binary" }, state: State): I.Interval {
    const left = this.expr(expr.left, state);
    const right = this.expr(expr.right, state);

    switch (expr.op) {
      case "add":
        return I.add(left, right);
      case "sub":
        return I.sub(left, right);
      case "mul":
        return I.mul(left, right);

      case "div":
      case "rem": {
        const kind: ObligationKind = expr.op === "div" ? "division-by-zero" : "modulo-by-zero";
        const rhsLinear = this.linearOf(expr.right, state);
        // Two independent ways to discharge the obligation: the interval
        // excludes zero, or the linear store proves the divisor is non-zero.
        const intervalSafe = I.excludes(right, 0);
        const linearSafe =
          rhsLinear !== null &&
          (state.linear.proves(rhsLinear, true) || state.linear.proves(scale(rhsLinear, -1), true));
        // A third route: a guard recorded that the divisor cannot be zero.
        const disequalSafe =
          expr.right.kind === "Var" && (state.disequal.get(expr.right.name)?.has(0) ?? false);
        const certainlyZero = !I.isBottom(right) && right.lo === 0 && right.hi === 0;

        this.obligations.push({
          kind,
          status:
            intervalSafe || linearSafe || disequalSafe
              ? "proved"
              : certainlyZero
                ? "violated"
                : "unknown",
          fn: this.fn,
          span: expr.span,
          claim: "divisor ≠ 0",
          reason: certainlyZero
            ? "divisor is the constant 0"
            : intervalSafe
              ? `divisor range ${I.format(right)} excludes 0`
              : linearSafe
                ? "linear constraints prove the divisor is non-zero"
                : disequalSafe
                  ? "a guard established that the divisor is non-zero"
                  : `divisor range ${I.format(right)} may contain 0`,
        });

        if (expr.op === "rem") {
          // `a % b` lies in (-|b|, |b|); keep the sign of `a`.
          const bound = Math.max(Math.abs(right.lo), Math.abs(right.hi));
          if (Number.isFinite(bound)) {
            const lo = left.lo >= 0 ? 0 : -bound;
            const hi = left.hi <= 0 ? 0 : bound;
            return I.range(lo, hi, left.int && right.int);
          }
          return left.int && right.int ? I.TOP_INT : I.TOP;
        }
        return I.div(left, right).value;
      }

      case "pow":
        return I.TOP;

      case "concat":
        return I.TOP;

      case "eq":
      case "ne":
      case "lt":
      case "le":
      case "gt":
      case "ge":
      case "and":
      case "or":
        return I.range(0, 1, true);
    }
  }

  private call(expr: HirExpr & { kind: "Call" }, state: State): I.Interval {
    for (const arg of expr.args) this.expr(arg, state);

    const name = expr.callee.kind === "Var" ? expr.callee.name : null;

    // Impose the callee's `where` clauses on this call's arguments.
    this.checkPreconditions(expr, state);

    // `len` is non-negative, and that single fact is what most bounds proofs
    // ultimately rest on.
    if (name === "len") return I.range(0, Number.POSITIVE_INFINITY, true);
    if (name === "abs" || name === "sqrt") return I.range(0, Number.POSITIVE_INFINITY, false);
    if (name === "floor" || name === "round" || name === "int") {
      const arg = expr.args.length > 0 ? this.expr(expr.args[0], state) : I.TOP;
      return I.range(Math.floor(arg.lo), Math.ceil(arg.hi), true);
    }
    if (name === "min" && expr.args.length === 2) {
      const a = this.expr(expr.args[0], state);
      const b = this.expr(expr.args[1], state);
      return I.range(Math.min(a.lo, b.lo), Math.min(a.hi, b.hi), a.int && b.int);
    }
    if (name === "max" && expr.args.length === 2) {
      const a = this.expr(expr.args[0], state);
      const b = this.expr(expr.args[1], state);
      return I.range(Math.max(a.lo, b.lo), Math.max(a.hi, b.hi), a.int && b.int);
    }

    // Namespaced calls with known numeric ranges.
    if (expr.callee.kind === "Field" && expr.callee.object.kind === "Var") {
      const ns = expr.callee.object.name;
      const method = expr.callee.name;
      if ((ns === "rng" || ns === "Random") && (method === "float" || method === "next")) {
        return I.range(0, 1, false);
      }
      if ((ns === "rng" || ns === "Random") && method === "int" && expr.args.length === 2) {
        const lo = this.expr(expr.args[0], state);
        const hi = this.expr(expr.args[1], state);
        return I.range(lo.lo, hi.hi, true);
      }
    }

    return this.intervalOfType(expr.ty);
  }

  /**
   * Check a call against the callee's parameter refinements.
   *
   * The predicate is decided against the argument's inferred interval, which is
   * what lets `safe(0 - 5)` be rejected outright while `safe(n)` for an
   * unconstrained `n` is reported undecided rather than waved through.
   */
  private checkPreconditions(expr: HirExpr & { kind: "Call" }, state: State): void {
    const callee = this.calleeName(expr);
    if (callee === null) return;
    const refined = this.refinedParams.get(callee);
    if (!refined) return;

    const order = this.paramOrder.get(callee) ?? [];
    for (const param of refined) {
      const index = order.indexOf(param.name);
      if (index < 0 || index >= expr.args.length) continue;

      const argument = this.expr(expr.args[index], state);
      const verdict = this.decidePredicate(param.refinement!, param.name, argument, state);
      this.obligations.push({
        kind: "refinement-precondition",
        status: verdict.status,
        fn: this.fn,
        span: expr.args[index].span,
        claim: `\`${callee}\` requires ${verdict.claim}`,
        reason: verdict.reason,
      });
    }
  }

  /** The callee's HIR name: a plain function, or `Game.method`. */
  private calleeName(expr: HirExpr & { kind: "Call" }): string | null {
    if (expr.callee.kind === "Var") return expr.callee.name;
    if (expr.callee.kind === "Field" && expr.callee.object.kind === "Var") {
      return `${expr.callee.object.name}.${expr.callee.name}`;
    }
    return null;
  }

  /**
   * Decide a refinement predicate against an argument interval.
   *
   * Only the shapes a refinement realistically uses are interpreted: a
   * comparison between the refined value and a constant bound, and conjunctions
   * or disjunctions of those. Anything else is `unknown`, which is honest rather
   * than optimistic.
   */
  private decidePredicate(
    predicate: HirExpr,
    subject: string,
    argument: I.Interval,
    state: State,
  ): { status: ObligationStatus; claim: string; reason: string } {
    if (predicate.kind === "Binary" && (predicate.op === "and" || predicate.op === "or")) {
      const left = this.decidePredicate(predicate.left, subject, argument, state);
      const right = this.decidePredicate(predicate.right, subject, argument, state);
      const claim = `${left.claim} ${predicate.op} ${right.claim}`;
      if (predicate.op === "and") {
        if (left.status === "violated" || right.status === "violated") {
          const failing = left.status === "violated" ? left : right;
          return { status: "violated", claim, reason: failing.reason };
        }
        if (left.status === "proved" && right.status === "proved") {
          return { status: "proved", claim, reason: left.reason };
        }
        return { status: "unknown", claim, reason: "one conjunct could not be decided" };
      }
      if (left.status === "proved" || right.status === "proved") {
        return {
          status: "proved",
          claim,
          reason: left.status === "proved" ? left.reason : right.reason,
        };
      }
      if (left.status === "violated" && right.status === "violated") {
        return { status: "violated", claim, reason: left.reason };
      }
      return { status: "unknown", claim, reason: "neither disjunct could be decided" };
    }

    const comparisons = new Set(["lt", "le", "gt", "ge", "eq", "ne"]);
    if (predicate.kind !== "Binary" || !comparisons.has(predicate.op)) {
      return {
        status: "unknown",
        claim: "its declared predicate",
        reason: "the predicate is not a comparison against a bound",
      };
    }

    // Orient the comparison so the refined value sits on the left.
    const leftIsSubject = isSubject(predicate.left, subject);
    const rightIsSubject = isSubject(predicate.right, subject);
    let op: string = predicate.op;
    let boundExpr: HirExpr;
    if (leftIsSubject && !rightIsSubject) {
      boundExpr = predicate.right;
    } else if (rightIsSubject && !leftIsSubject) {
      boundExpr = predicate.left;
      op = flipOp(op);
    } else {
      return {
        status: "unknown",
        claim: "its declared predicate",
        reason: "the predicate does not compare the parameter against a bound",
      };
    }

    const bound = this.expr(boundExpr, cloneState(state));
    if (I.isBottom(bound) || bound.lo !== bound.hi || !Number.isFinite(bound.lo)) {
      return {
        status: "unknown",
        claim: "its declared predicate",
        reason: "the bound is not a compile-time constant",
      };
    }

    const k = bound.lo;
    const spelling: Record<string, string> = {
      lt: "<",
      le: "<=",
      gt: ">",
      ge: ">=",
      eq: "==",
      ne: "!=",
    };
    const claim = `${subject} ${spelling[op] ?? op} ${k}`;

    if (I.isBottom(argument)) {
      return { status: "unknown", claim, reason: "the argument range is empty" };
    }

    const always = (() => {
      switch (op) {
        case "lt":
          return argument.hi < k;
        case "le":
          return argument.hi <= k;
        case "gt":
          return argument.lo > k;
        case "ge":
          return argument.lo >= k;
        case "eq":
          return argument.lo === k && argument.hi === k;
        case "ne":
          return argument.hi < k || argument.lo > k;
        default:
          return false;
      }
    })();

    const never = (() => {
      switch (op) {
        case "lt":
          return argument.lo >= k;
        case "le":
          return argument.lo > k;
        case "gt":
          return argument.hi <= k;
        case "ge":
          return argument.hi < k;
        case "eq":
          return argument.hi < k || argument.lo > k;
        case "ne":
          return argument.lo === k && argument.hi === k;
        default:
          return false;
      }
    })();

    if (always) {
      return { status: "proved", claim, reason: `the argument lies in ${I.format(argument)}` };
    }
    if (never) {
      return {
        status: "violated",
        claim,
        reason: `the argument lies in ${I.format(argument)}, which cannot satisfy it`,
      };
    }
    return {
      status: "unknown",
      claim,
      reason: `the argument range ${I.format(argument)} straddles the bound`,
    };
  }

  private index(expr: HirExpr & { kind: "Index" }, state: State): I.Interval {
    this.expr(expr.object, state);
    const idx = this.expr(expr.index, state);

    const idxLinear = this.linearOf(expr.index, state);
    const length = this.lengthOf(expr.object, state);

    // Lower bound: index >= 0.
    const nonNegativeByInterval = !I.isBottom(idx) && idx.lo >= 0;
    const nonNegativeByLinear = idxLinear !== null && state.linear.proves(idxLinear);
    const certainlyNegative = !I.isBottom(idx) && idx.hi < 0;
    this.obligations.push({
      kind: "negative-index",
      status:
        nonNegativeByInterval || nonNegativeByLinear
          ? "proved"
          : certainlyNegative
            ? "violated"
            : "unknown",
      fn: this.fn,
      span: expr.span,
      claim: "index ≥ 0",
      reason: nonNegativeByInterval
        ? `index range ${I.format(idx)} is non-negative`
        : nonNegativeByLinear
          ? "linear constraints prove index ≥ 0"
          : `index range ${I.format(idx)} may be negative`,
    });

    // Upper bound: index < len(object).
    if (length !== null && idxLinear !== null) {
      // Prove len - index > 0.
      const proved = state.linear.proves(minus(length, idxLinear), true);
      const violated =
        !proved &&
        length.terms.size === 0 &&
        !I.isBottom(idx) &&
        idx.lo >= length.k;
      this.obligations.push({
        kind: "index-out-of-bounds",
        status: proved ? "proved" : violated ? "violated" : "unknown",
        fn: this.fn,
        span: expr.span,
        claim: "index < len(collection)",
        reason: proved
          ? "linear constraints prove the index is inside the collection"
          : violated
            ? `index range ${I.format(idx)} starts at or past the length ${length.k}`
            : "no constraint relates the index to the collection length",
      });
    } else {
      this.obligations.push({
        kind: "index-out-of-bounds",
        status: "unknown",
        fn: this.fn,
        span: expr.span,
        claim: "index < len(collection)",
        reason:
          length === null
            ? "collection length is not statically known"
            : "index is not a linear expression over program variables",
      });
    }

    return this.intervalOfType(expr.ty);
  }

  // ------------------------------------------------------------- guards

  /**
   * Refine the state by assuming `cond` is true (or false).
   *
   * Both domains are updated: the interval environment narrows variable ranges,
   * and the linear store records the relational fact. Contradictions mark the
   * branch unreachable, which is what lets a guarded division be proved safe.
   */
  private assume(cond: HirExpr, state: State, truth: boolean): State {
    const next = cloneState(state);

    if (cond.kind === "Unary" && cond.op === "not") {
      return this.assume(cond.operand, state, !truth);
    }

    if (cond.kind === "Binary") {
      const op = truth ? cond.op : negateOp(cond.op);

      if (op === "and") {
        // `a and b` true means both hold.
        const first = this.assume(cond.left, next, true);
        return this.assume(cond.right, first, true);
      }
      if (op === "or") {
        // Nothing definite follows from a disjunction being true.
        return next;
      }

      const left = this.linearOf(cond.left, state);
      const right = this.linearOf(cond.right, state);
      const leftInterval = this.evaluateQuiet(cond.left, state);
      const rightInterval = this.evaluateQuiet(cond.right, state);

      // Record disequalities: `x != c` (and the false arm of `x == c`).
      if (op === "ne") {
        if (cond.left.kind === "Var" && !I.isBottom(rightInterval) && rightInterval.lo === rightInterval.hi) {
          addDisequal(next, cond.left.name, rightInterval.lo);
        }
        if (cond.right.kind === "Var" && !I.isBottom(leftInterval) && leftInterval.lo === leftInterval.hi) {
          addDisequal(next, cond.right.name, leftInterval.lo);
        }
      }

      // Interval narrowing for the common `var OP expr` shape.
      if (cond.left.kind === "Var") {
        const name = cond.left.name;
        const current = next.intervals.get(name) ?? this.intervalOfType(cond.left.ty);
        next.intervals.set(name, narrow(current, op, rightInterval));
      }
      if (cond.right.kind === "Var") {
        const name = cond.right.name;
        const current = next.intervals.get(name) ?? this.intervalOfType(cond.right.ty);
        next.intervals.set(name, narrow(current, flipOp(op), leftInterval));
      }

      // Linear facts.
      if (left !== null && right !== null) {
        switch (op) {
          case "lt":
            next.linear = next.linear.assume(minus(right, left), true);
            break;
          case "le":
            next.linear = next.linear.assume(minus(right, left));
            break;
          case "gt":
            next.linear = next.linear.assume(minus(left, right), true);
            break;
          case "ge":
            next.linear = next.linear.assume(minus(left, right));
            break;
          case "eq":
            next.linear = next.linear
              .assume(minus(left, right))
              .assume(minus(right, left));
            break;
          case "ne":
            // Disequality is not a linear constraint; the interval domain
            // handles the useful special case (`x != 0`).
            break;
          default:
            break;
        }
      }

      if (next.linear.isContradictory()) next.reachable = false;
      for (const interval of next.intervals.values()) {
        if (I.isBottom(interval)) next.reachable = false;
      }
    }

    return next;
  }

  /** Evaluate without recording obligations (used while refining guards). */
  private evaluateQuiet(expr: HirExpr, state: State): I.Interval {
    const saved = this.obligations.length;
    const value = this.expr(expr, state);
    this.obligations.length = saved;
    return value;
  }

  // ------------------------------------------------------------- helpers

  /** Translate an expression into a linear form, or null when non-linear. */
  private linearOf(expr: HirExpr, state: State): LinearExpr | null {
    switch (expr.kind) {
      case "Const":
        return typeof expr.value === "number" ? lit(expr.value) : null;

      case "Var":
        return variable(expr.name);

      case "Unary":
        if (expr.op === "neg") {
          const inner = this.linearOf(expr.operand, state);
          return inner ? scale(inner, -1) : null;
        }
        return null;

      case "Binary": {
        const left = this.linearOf(expr.left, state);
        const right = this.linearOf(expr.right, state);
        if (!left || !right) return null;
        if (expr.op === "add") return plus(left, right);
        if (expr.op === "sub") return minus(left, right);
        if (expr.op === "mul") {
          // Linear only when one side is constant.
          if (right.terms.size === 0) return scale(left, right.k);
          if (left.terms.size === 0) return scale(right, left.k);
          return null;
        }
        return null;
      }

      case "Call":
        // `len(xs)` is treated as an opaque non-negative symbol so relational
        // reasoning about it is possible.
        if (expr.callee.kind === "Var" && expr.callee.name === "len" && expr.args.length === 1) {
          const target = expr.args[0];
          if (target.kind === "Var") return variable(`len#${target.name}`);
        }
        return null;

      default:
        return null;
    }
  }

  /**
   * The symbolic length of a collection expression.
   *
   * Literal lists give an exact constant; a variable gives the length recorded
   * when it was bound, or the opaque `len#x` symbol that `linearOf` produces so
   * both sides of an index check speak the same language.
   */
  private lengthOf(expr: HirExpr, state: State): LinearExpr | null {
    if (expr.kind === "List") return lit(expr.items.length);
    if (expr.kind === "Var") {
      const known = state.lengths.get(expr.name);
      if (known) return known;
      return variable(`len#${expr.name}`);
    }
    if (expr.kind === "Call" && expr.callee.kind === "Var" && expr.callee.name === "range") {
      if (expr.args.length === 2) {
        const from = this.linearOf(expr.args[0], state);
        const to = this.linearOf(expr.args[1], state);
        if (from && to) return minus(to, from);
      }
    }
    return null;
  }

  private intervalOfType(ty: Ty): I.Interval {
    switch (ty.k) {
      case "Int":
        return I.TOP_INT;
      case "Float":
        return I.TOP;
      case "Bool":
        return I.range(0, 1, true);
      case "Money":
        return I.range(0, Number.POSITIVE_INFINITY, false);
      default:
        return I.TOP;
    }
  }
}

function narrow(current: I.Interval, op: string, bound: I.Interval): I.Interval {
  if (I.isBottom(bound)) return current;
  switch (op) {
    case "lt":
      return I.below(current, bound.hi, true);
    case "le":
      return I.below(current, bound.hi, false);
    case "gt":
      return I.above(current, bound.lo, true);
    case "ge":
      return I.above(current, bound.lo, false);
    case "eq":
      return I.meet(current, bound);
    case "ne":
      // Only actionable when the excluded value is a single point at an edge.
      if (bound.lo === bound.hi) {
        if (current.lo === bound.lo) return I.above(current, bound.lo, true);
        if (current.hi === bound.hi) return I.below(current, bound.hi, true);
      }
      return current;
    default:
      return current;
  }
}

function negateOp(op: string): string {
  switch (op) {
    case "lt":
      return "ge";
    case "le":
      return "gt";
    case "gt":
      return "le";
    case "ge":
      return "lt";
    case "eq":
      return "ne";
    case "ne":
      return "eq";
    case "and":
      return "or";
    case "or":
      return "and";
    default:
      return op;
  }
}

function flipOp(op: string): string {
  switch (op) {
    case "lt":
      return "gt";
    case "le":
      return "ge";
    case "gt":
      return "lt";
    case "ge":
      return "le";
    default:
      return op;
  }
}

/**
 * Does this expression denote the value a refinement constrains?
 *
 * Both spellings are accepted: the parameter's own name (`x: Int where x > 0`)
 * and the positional `self` (`Float where self <= 1.0`).
 */
function isSubject(expr: HirExpr, subject: string): boolean {
  return expr.kind === "Var" && (expr.name === subject || expr.name === "self");
}

/** Run the refinement checker over a lowered module. */
export function refineModule(module: HirModule): RefineResult {
  return new Refiner().run(module);
}
