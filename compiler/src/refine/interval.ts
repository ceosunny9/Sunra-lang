/**
 * The interval lattice used by the refinement checker.
 *
 * Intervals are closed and may be unbounded on either side (`-Infinity`,
 * `Infinity`). `bottom` marks unreachable values — it is what a contradictory
 * branch condition produces, and it is how the checker knows a guarded
 * division can never actually divide by zero.
 *
 * Integer-ness is tracked alongside the bounds because `1/2` and `1.0/2.0` need
 * different answers, and because index reasoning must stay integral.
 */
export interface Interval {
  lo: number;
  hi: number;
  /** True when every value in the interval is known to be an integer. */
  int: boolean;
}

export const BOTTOM: Interval = { lo: Number.POSITIVE_INFINITY, hi: Number.NEGATIVE_INFINITY, int: true };
export const TOP: Interval = { lo: Number.NEGATIVE_INFINITY, hi: Number.POSITIVE_INFINITY, int: false };
export const TOP_INT: Interval = { lo: Number.NEGATIVE_INFINITY, hi: Number.POSITIVE_INFINITY, int: true };

export function isBottom(i: Interval): boolean {
  return i.lo > i.hi;
}

export function constant(value: number, int = Number.isInteger(value)): Interval {
  return { lo: value, hi: value, int };
}

export function range(lo: number, hi: number, int = false): Interval {
  return lo > hi ? BOTTOM : { lo, hi, int };
}

export function join(a: Interval, b: Interval): Interval {
  if (isBottom(a)) return b;
  if (isBottom(b)) return a;
  return { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi), int: a.int && b.int };
}

export function meet(a: Interval, b: Interval): Interval {
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  if (lo > hi) return BOTTOM;
  return { lo, hi, int: a.int || b.int };
}

export function equals(a: Interval, b: Interval): boolean {
  if (isBottom(a) && isBottom(b)) return true;
  return a.lo === b.lo && a.hi === b.hi && a.int === b.int;
}

export function add(a: Interval, b: Interval): Interval {
  if (isBottom(a) || isBottom(b)) return BOTTOM;
  return { lo: a.lo + b.lo, hi: a.hi + b.hi, int: a.int && b.int };
}

export function sub(a: Interval, b: Interval): Interval {
  if (isBottom(a) || isBottom(b)) return BOTTOM;
  return { lo: a.lo - b.hi, hi: a.hi - b.lo, int: a.int && b.int };
}

export function mul(a: Interval, b: Interval): Interval {
  if (isBottom(a) || isBottom(b)) return BOTTOM;
  const products = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi].filter((n) => !Number.isNaN(n));
  if (products.length === 0) return TOP;
  return { lo: Math.min(...products), hi: Math.max(...products), int: a.int && b.int };
}

/**
 * Division. When the divisor interval straddles zero the result is TOP *and*
 * the caller is told the operation may trap; the checker turns that into a
 * diagnostic rather than silently widening.
 */
export function div(a: Interval, b: Interval): { value: Interval; mayDivideByZero: boolean } {
  if (isBottom(a) || isBottom(b)) return { value: BOTTOM, mayDivideByZero: false };
  const straddlesZero = b.lo <= 0 && b.hi >= 0;
  if (straddlesZero) {
    // Exactly zero is a certain trap; a range containing zero is a possible one.
    return { value: TOP, mayDivideByZero: true };
  }
  const quotients = [a.lo / b.lo, a.lo / b.hi, a.hi / b.lo, a.hi / b.hi].filter((n) => Number.isFinite(n) || Math.abs(n) === Infinity);
  return {
    value: { lo: Math.min(...quotients), hi: Math.max(...quotients), int: false },
    mayDivideByZero: false,
  };
}

export function negate(a: Interval): Interval {
  if (isBottom(a)) return BOTTOM;
  return { lo: -a.hi, hi: -a.lo, int: a.int };
}

/** Constrain `a` to values strictly below `bound`. */
export function below(a: Interval, bound: number, strict: boolean): Interval {
  const hi = strict ? (a.int ? Math.min(a.hi, bound - 1) : Math.min(a.hi, prevFloat(bound))) : Math.min(a.hi, bound);
  return range(a.lo, hi, a.int);
}

/** Constrain `a` to values strictly above `bound`. */
export function above(a: Interval, bound: number, strict: boolean): Interval {
  const lo = strict ? (a.int ? Math.max(a.lo, bound + 1) : Math.max(a.lo, nextFloat(bound))) : Math.max(a.lo, bound);
  return range(lo, a.hi, a.int);
}

export function excludes(a: Interval, value: number): boolean {
  return isBottom(a) || value < a.lo || value > a.hi;
}

export function contains(a: Interval, value: number): boolean {
  return !isBottom(a) && value >= a.lo && value <= a.hi;
}

export function format(i: Interval): string {
  if (isBottom(i)) return "⊥";
  const lo = i.lo === Number.NEGATIVE_INFINITY ? "-∞" : String(i.lo);
  const hi = i.hi === Number.POSITIVE_INFINITY ? "+∞" : String(i.hi);
  return `[${lo}, ${hi}]${i.int ? "" : "f"}`;
}

/**
 * Widening for loops: after a bounded number of iterations, unstable endpoints
 * jump to infinity instead of creeping up one step at a time. This is what
 * makes the analysis terminate on `while i < n { i = i + 1 }`.
 */
export function widen(previous: Interval, next: Interval): Interval {
  if (isBottom(previous)) return next;
  if (isBottom(next)) return previous;
  return {
    lo: next.lo < previous.lo ? Number.NEGATIVE_INFINITY : previous.lo,
    hi: next.hi > previous.hi ? Number.POSITIVE_INFINITY : previous.hi,
    int: previous.int && next.int,
  };
}

function nextFloat(x: number): number {
  if (!Number.isFinite(x)) return x;
  return x + Math.max(Number.EPSILON * Math.abs(x), Number.MIN_VALUE);
}

function prevFloat(x: number): number {
  if (!Number.isFinite(x)) return x;
  return x - Math.max(Number.EPSILON * Math.abs(x), Number.MIN_VALUE);
}
