/**
 * Linear arithmetic over program variables.
 *
 * A `LinearExpr` is `c0 + Σ ci·xi` with rational coefficients. The checker uses
 * it for facts intervals cannot express — most importantly the relational ones:
 * `i < len(xs)` links two variables, and it is that link (not either variable's
 * range) that proves an index is in bounds.
 *
 * Entailment is decided by Fourier–Motzkin elimination over the collected
 * constraint set. That is complete for conjunctions of linear inequalities over
 * the rationals, which is exactly the fragment used here.
 */
export interface LinearExpr {
  /** Constant term. */
  k: number;
  /** Variable coefficients; absent means zero. */
  terms: Map<string, number>;
}

/** `expr >= 0` (non-strict) or `expr > 0` (strict). */
export interface LinearConstraint {
  expr: LinearExpr;
  strict: boolean;
}

export function lit(k: number): LinearExpr {
  return { k, terms: new Map() };
}

export function variable(name: string, coefficient = 1): LinearExpr {
  return { k: 0, terms: new Map([[name, coefficient]]) };
}

export function plus(a: LinearExpr, b: LinearExpr): LinearExpr {
  const terms = new Map(a.terms);
  for (const [name, coefficient] of b.terms) {
    const next = (terms.get(name) ?? 0) + coefficient;
    if (next === 0) terms.delete(name);
    else terms.set(name, next);
  }
  return { k: a.k + b.k, terms };
}

export function minus(a: LinearExpr, b: LinearExpr): LinearExpr {
  return plus(a, scale(b, -1));
}

export function scale(a: LinearExpr, factor: number): LinearExpr {
  if (factor === 0) return lit(0);
  const terms = new Map<string, number>();
  for (const [name, coefficient] of a.terms) terms.set(name, coefficient * factor);
  return { k: a.k * factor, terms };
}

export function isConstant(a: LinearExpr): boolean {
  return a.terms.size === 0;
}

export function formatLinear(a: LinearExpr): string {
  const parts: string[] = [];
  for (const [name, coefficient] of [...a.terms].sort(([x], [y]) => x.localeCompare(y))) {
    if (coefficient === 1) parts.push(name);
    else if (coefficient === -1) parts.push(`-${name}`);
    else parts.push(`${coefficient}·${name}`);
  }
  if (a.k !== 0 || parts.length === 0) parts.push(String(a.k));
  return parts.join(" + ").replace(/\+ -/g, "- ");
}

export function formatConstraint(c: LinearConstraint): string {
  return `${formatLinear(c.expr)} ${c.strict ? ">" : ">="} 0`;
}

/**
 * A conjunction of linear constraints, with entailment by elimination.
 *
 * The store is immutable: `assume` returns a new store, so the checker can hand
 * different stores to the two arms of a branch without copying by hand.
 */
export class LinearStore {
  constructor(private readonly constraints: LinearConstraint[] = []) {}

  /** Add `expr >= 0` (or `> 0` when strict). */
  assume(expr: LinearExpr, strict = false): LinearStore {
    return new LinearStore([...this.constraints, { expr, strict }]);
  }

  get facts(): readonly LinearConstraint[] {
    return this.constraints;
  }

  /** True when the constraint set has no solution. */
  isContradictory(): boolean {
    return !satisfiable(this.constraints);
  }

  /**
   * Does the store prove `expr >= 0` (or `> 0`)?
   *
   * Proof by refutation: if assuming the negation is unsatisfiable, the
   * original must hold everywhere the store holds.
   */
  proves(expr: LinearExpr, strict = false): boolean {
    // ¬(e >= 0)  ==  -e > 0        ¬(e > 0)  ==  -e >= 0
    const negation: LinearConstraint = { expr: scale(expr, -1), strict: !strict };
    return !satisfiable([...this.constraints, negation]);
  }

  /** Does the store prove `a >= b` (or `a > b`)? */
  provesGe(a: LinearExpr, b: LinearExpr, strict = false): boolean {
    return this.proves(minus(a, b), strict);
  }

  describe(): string[] {
    return this.constraints.map(formatConstraint);
  }
}

/**
 * Fourier–Motzkin satisfiability over the rationals.
 *
 * Strictness is tracked through elimination: combining two constraints yields a
 * strict result if either input was strict, which keeps `x > 0 ∧ -x >= 0`
 * correctly unsatisfiable.
 */
export function satisfiable(constraints: LinearConstraint[]): boolean {
  let current = constraints.map((c) => ({ k: c.expr.k, terms: new Map(c.expr.terms), strict: c.strict }));

  // Eliminate variables one at a time.
  const variables = new Set<string>();
  for (const c of current) for (const name of c.terms.keys()) variables.add(name);

  for (const name of variables) {
    const positive: typeof current = [];
    const negative: typeof current = [];
    const rest: typeof current = [];

    for (const c of current) {
      const coefficient = c.terms.get(name) ?? 0;
      if (coefficient > 0) positive.push(c);
      else if (coefficient < 0) negative.push(c);
      else rest.push(c);
    }

    if (positive.length === 0 || negative.length === 0) {
      // Unbounded in one direction: the variable places no restriction.
      current = rest;
      continue;
    }

    // Guard against combinatorial blow-up on pathological inputs. Bailing out
    // means "cannot prove", never "proved" — the analysis stays sound.
    if (positive.length * negative.length > 4096) return true;

    const combined: typeof current = [...rest];
    for (const p of positive) {
      for (const n of negative) {
        const pc = p.terms.get(name)!;
        const nc = -(n.terms.get(name) ?? 0);
        // p/pc + n/nc eliminates `name`.
        const terms = new Map<string, number>();
        for (const [v, c] of p.terms) if (v !== name) terms.set(v, (terms.get(v) ?? 0) + c / pc);
        for (const [v, c] of n.terms) if (v !== name) terms.set(v, (terms.get(v) ?? 0) + c / nc);
        for (const [v, c] of [...terms]) if (c === 0) terms.delete(v);
        combined.push({
          k: p.k / pc + n.k / nc,
          terms,
          strict: p.strict || n.strict,
        });
      }
    }
    current = combined;
  }

  // Only constants remain: check each for consistency.
  for (const c of current) {
    if (c.terms.size > 0) continue;
    if (c.strict ? c.k <= 0 : c.k < 0) return false;
  }
  return true;
}

