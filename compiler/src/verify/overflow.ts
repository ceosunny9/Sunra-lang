/**
 * Int64 overflow analysis.
 *
 * Sunra's `Int` is a 64-bit signed integer, so arithmetic wraps (or traps, under
 * checked arithmetic) outside [-2^63, 2^63-1]. In a gaming context the two ways
 * that actually happens are both worth a warning:
 *
 *   1. **Multiplying a stake by a multiplier in a loop.** A progressive jackpot
 *      or a "double or nothing" ladder multiplies a balance repeatedly; 60
 *      doublings of a 1-unit stake is already past the range.
 *   2. **Exponentiation.** `pow` grows fast enough that a literal exponent above
 *      62 overflows for any base above 1.
 *
 * The analysis is interval-based and deliberately conservative in the direction
 * that matters: it reports a *possible* overflow only when it can bound the
 * operands and the bound leaves the range, or when an unbounded value feeds a
 * multiplication inside a loop. That keeps it quiet on ordinary code — a warning
 * that fires on every `+` would be ignored, which is worse than no warning.
 *
 * Severity is `warning`, not `error`: wrapping is defined behaviour in Sunra, and
 * a studio may rely on it for hashing. Under `#[no_panic]` with checked
 * arithmetic, the panic-freedom prover is what turns an overflow site into a
 * proof obligation.
 */
import type { MirFunction, MirInstr, MirModule, ValueId } from "../mir/mir.js";
import type { Span } from "../diagnostics.js";

/** Signed 64-bit bounds, as exact integers where JavaScript can hold them. */
export const INT64_MAX = 9223372036854775807n;
export const INT64_MIN = -9223372036854775808n;

export type OverflowKind =
  | "multiplication-in-loop"
  | "constant-overflow"
  | "exponentiation"
  | "accumulator-growth";

export interface OverflowSite {
  kind: OverflowKind;
  symbol: string;
  span: Span;
  /** What the analysis found, in terms a studio can act on. */
  detail: string;
  /** Suggested change, when there is an obvious one. */
  hint?: string;
  /** True when the operands are bounded and provably stay in range. */
  safe: boolean;
}

export interface OverflowResult {
  sites: OverflowSite[];
  /** Sites that are not provably safe: what a report should show. */
  warnings: OverflowSite[];
}

/** Interval over the integers, with `null` meaning unbounded on that side. */
interface Range {
  lo: bigint | null;
  hi: bigint | null;
}

const UNBOUNDED: Range = { lo: null, hi: null };

export function checkOverflow(module: MirModule): OverflowResult {
  const sites: OverflowSite[] = [];
  for (const fn of module.functions) {
    sites.push(...analyzeFunction(fn));
  }
  return { sites, warnings: sites.filter((site) => !site.safe) };
}

function analyzeFunction(fn: MirFunction): OverflowSite[] {
  const sites: OverflowSite[] = [];
  const ranges = new Map<ValueId, Range>();
  const loopBlocks = blocksInLoops(fn);
  const floatish = floatValues(fn);

  // Constants first: they are the only values with an exact range, and every
  // other bound is derived from them.
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.op === "const" && instr.value.k === "int") {
        const value = BigInt(Math.trunc(instr.value.value));
        ranges.set(instr.dst, { lo: value, hi: value });
        // The optimiser constant-folds arithmetic, so an expression that
        // overflowed may reach this analysis as a single out-of-range literal.
        // Reporting the folded constant is what keeps the warning from
        // disappearing at -O1, which is the configuration a studio ships.
        if (value > INT64_MAX || value < INT64_MIN) {
          sites.push({
            kind: "constant-overflow",
            symbol: fn.symbol,
            span: instr.span,
            detail: `the constant ${value} is outside the Int64 range`,
            hint: "use Money for currency, or widen the calculation to Float",
            safe: false,
          });
        }
      }
    }
  }

  // One forward pass is enough for straight-line evidence; values defined by a
  // phi (i.e. carried around a loop) stay unbounded, which is what makes the
  // loop-multiplication rule fire.
  for (const block of fn.blocks) {
    const inLoop = loopBlocks.has(block.id);
    for (const instr of block.instrs) {
      if (instr.op !== "binary") continue;
      if (!isIntOperation(instr, fn, floatish)) continue;

      const lhs = ranges.get(instr.lhs) ?? UNBOUNDED;
      const rhs = ranges.get(instr.rhs) ?? UNBOUNDED;
      const result = applyBinary(instr.kind, lhs, rhs);
      if (result !== null) ranges.set(instr.dst, result);

      const site = classify(instr, fn, lhs, rhs, result, inLoop, accumulators(fn));
      if (site !== null) sites.push(site);
    }
  }

  return sites;
}

/**
 * Whether both operands of an arithmetic node are 64-bit integers.
 *
 * `floatish` carries values that are floating point even though MIR typed them
 * Unknown — a value produced by a function returning Float, or one that meets a
 * float anywhere in the function. Without it, unannotated float arithmetic (which
 * is most gaming maths) is misread as Int and every RTP loop warns.
 */
function isIntOperation(
  instr: MirInstr & { op: "binary" },
  fn: MirFunction,
  floatish: Set<ValueId>,
): boolean {
  if (!["add", "sub", "mul", "pow"].includes(instr.kind)) return false;
  const lhsTy = fn.types.get(instr.lhs);
  const rhsTy = fn.types.get(instr.rhs);
  const resultTy = instr.ty;
  // Float arithmetic does not overflow (it saturates to infinity), and a Money
  // value is fixed-point with its own range rules.
  for (const ty of [lhsTy, rhsTy, resultTy]) {
    if (ty && (ty.k === "Float" || ty.k === "Money")) return false;
  }
  if (floatish.has(instr.lhs) || floatish.has(instr.rhs) || floatish.has(instr.dst)) return false;
  // Unknown types are treated as Int, because that is how the backends map them
  // for arithmetic.
  return true;
}

function applyBinary(kind: string, lhs: Range, rhs: Range): Range | null {
  if (kind === "add") {
    return {
      lo: lhs.lo !== null && rhs.lo !== null ? lhs.lo + rhs.lo : null,
      hi: lhs.hi !== null && rhs.hi !== null ? lhs.hi + rhs.hi : null,
    };
  }
  if (kind === "sub") {
    return {
      lo: lhs.lo !== null && rhs.hi !== null ? lhs.lo - rhs.hi : null,
      hi: lhs.hi !== null && rhs.lo !== null ? lhs.hi - rhs.lo : null,
    };
  }
  if (kind === "mul") {
    if (lhs.lo === null || lhs.hi === null || rhs.lo === null || rhs.hi === null) return null;
    const products = [lhs.lo * rhs.lo, lhs.lo * rhs.hi, lhs.hi * rhs.lo, lhs.hi * rhs.hi];
    return {
      lo: products.reduce((a, b) => (a < b ? a : b)),
      hi: products.reduce((a, b) => (a > b ? a : b)),
    };
  }
  if (kind === "pow") {
    if (lhs.hi === null || rhs.hi === null || rhs.hi > 64n || rhs.hi < 0n) return null;
    const base = lhs.hi < 0n ? -lhs.hi : lhs.hi;
    let value = 1n;
    for (let i = 0n; i < rhs.hi; i += 1n) {
      value *= base;
      // Stop early rather than building an enormous bigint for `2 ** 1e6`.
      if (value > INT64_MAX * 2n) return { lo: null, hi: null };
    }
    return { lo: -value, hi: value };
  }
  return null;
}

function classify(
  instr: MirInstr & { op: "binary" },
  fn: MirFunction,
  lhs: Range,
  rhs: Range,
  result: Range | null,
  inLoop: boolean,
  loopCarried: Set<ValueId>,
): OverflowSite | null {
  const outOfRange =
    result !== null &&
    ((result.hi !== null && result.hi > INT64_MAX) || (result.lo !== null && result.lo < INT64_MIN));

  if (outOfRange) {
    return {
      kind: instr.kind === "pow" ? "exponentiation" : "constant-overflow",
      symbol: fn.symbol,
      span: instr.span,
      detail:
        instr.kind === "pow"
          ? `exponentiation exceeds the Int64 range (up to ${result?.hi ?? "?"})`
          : `\`${instr.kind}\` on known operands leaves the Int64 range (up to ${result?.hi ?? "?"})`,
      hint: "use Money for currency, or widen the calculation to Float",
      safe: false,
    };
  }

  // A multiplication inside a loop is only unbounded growth when it multiplies a
  // *loop-carried* value: `total = total * 2` compounds, whereas
  // `payout = symbolValue * bet` is recomputed each iteration and stays bounded
  // by its inputs. Requiring the loop-carried operand is what separates the two.
  if (
    instr.kind === "mul" &&
    inLoop &&
    (lhs.hi === null || rhs.hi === null) &&
    (loopCarried.has(instr.lhs) || loopCarried.has(instr.rhs))
  ) {
    return {
      kind: "multiplication-in-loop",
      symbol: fn.symbol,
      span: instr.span,
      detail: "multiplication inside a loop can grow without bound and overflow Int64",
      hint: "cap the multiplier, or accumulate in Money/Float",
      safe: false,
    };
  }

  // `pow` with an unbounded exponent is unbounded growth by construction.
  if (instr.kind === "pow" && rhs.hi === null) {
    return {
      kind: "exponentiation",
      symbol: fn.symbol,
      span: instr.span,
      detail: "exponent is not bounded, so the result may overflow Int64",
      hint: "bound the exponent with a `where` clause",
      safe: false,
    };
  }

  return null;
}

/**
 * Blocks that belong to a loop.
 *
 * A back edge is a jump to a block with a lower id, because the MIR builder
 * numbers blocks in the order it creates them and only a loop jumps backwards.
 * Every block from the target up to the source is inside that loop.
 */
function blocksInLoops(fn: MirFunction): Set<number> {
  const inLoop = new Set<number>();
  for (const block of fn.blocks) {
    const targets: number[] = [];
    if (block.terminator.op === "jump") targets.push(block.terminator.target);
    if (block.terminator.op === "branch") {
      targets.push(block.terminator.then, block.terminator.otherwise);
    }
    for (const target of targets) {
      if (target <= block.id) {
        for (const candidate of fn.blocks) {
          if (candidate.id >= target && candidate.id <= block.id) inLoop.add(candidate.id);
        }
      }
    }
  }
  return inLoop;
}

/**
 * Values that a phi feeds back into itself: the accumulators of a loop.
 *
 * A phi whose own result is (transitively) one of its sources is carried around
 * the loop, so arithmetic on it compounds across iterations.
 */
function accumulators(fn: MirFunction): Set<ValueId> {
  const carried = new Set<ValueId>();
  // Definitions, so a phi source can be followed back to the operation that
  // produced it.
  const defs = new Map<ValueId, MirInstr>();
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.op === "phi" || instr.op === "binary") defs.set(instr.dst, instr);
    }
  }

  const reaches = (from: ValueId, target: ValueId, seen: Set<ValueId>): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const def = defs.get(from);
    if (!def) return false;
    if (def.op === "phi") return def.sources.some((s) => reaches(s.value, target, seen));
    if (def.op === "binary") {
      return reaches(def.lhs, target, seen) || reaches(def.rhs, target, seen);
    }
    return false;
  };

  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.op !== "phi") continue;
      if (instr.sources.some((s) => reaches(s.value, instr.dst, new Set()))) {
        carried.add(instr.dst);
        // Everything derived from the accumulator inside the loop is also carried.
        for (const other of fn.blocks.flatMap((b) => b.instrs)) {
          if (other.op === "binary" && (other.lhs === instr.dst || other.rhs === instr.dst)) {
            carried.add(other.dst);
          }
        }
      }
    }
  }
  return carried;
}

/**
 * Values that are floating point in practice.
 *
 * Starts from declared Float types and propagates through arithmetic and phis, so
 * an unannotated function doing float maths is not analysed as Int.
 */
function floatValues(fn: MirFunction): Set<ValueId> {
  const floats = new Set<ValueId>();
  for (const [value, ty] of fn.types) {
    if (ty.k === "Float" || ty.k === "Money") floats.add(value);
  }
  // A returned value in a function declared `-> Float` is float, even when MIR
  // typed it Unknown because the parameters were unannotated. This is the common
  // case in gaming maths: `fn compound(base, rate, periods) -> Float`.
  if (fn.ret.k === "Float" || fn.ret.k === "Money") {
    for (const block of fn.blocks) {
      if (block.terminator.op === "return" && block.terminator.value !== null) {
        floats.add(block.terminator.value);
      }
    }
  }
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.op === "const" && instr.value.k === "float") floats.add(instr.dst);
      // A call to something returning Float taints its result, and `float(x)`
      // conversions are the usual source of that in gaming code.
      if (instr.op === "call" && instr.dst !== null) {
        if (instr.ty.k === "Float" || instr.callee === "float") floats.add(instr.dst);
      }
    }
  }

  // Propagate to a fixed point: arithmetic mixing a float is float, and a phi of
  // floats is float. Propagation also runs *backwards* through phis and
  // arithmetic, because knowing the result is float tells us the operands were:
  // an Int64 operation cannot produce a Float without an explicit conversion.
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        if (instr.op === "binary" && !floats.has(instr.dst)) {
          if (floats.has(instr.lhs) || floats.has(instr.rhs)) {
            floats.add(instr.dst);
            changed = true;
          }
        }
        if (instr.op === "binary" && floats.has(instr.dst) && instr.kind !== "concat") {
          // Comparisons produce Bool, so only arithmetic implies float operands.
          if (["add", "sub", "mul", "div", "rem", "pow"].includes(instr.kind)) {
            if (!floats.has(instr.lhs)) {
              floats.add(instr.lhs);
              changed = true;
            }
            if (!floats.has(instr.rhs)) {
              floats.add(instr.rhs);
              changed = true;
            }
          }
        }
        if (instr.op === "phi" && !floats.has(instr.dst)) {
          if (instr.sources.some((s) => floats.has(s.value))) {
            floats.add(instr.dst);
            changed = true;
          }
        }
        if (instr.op === "phi" && floats.has(instr.dst)) {
          for (const source of instr.sources) {
            if (!floats.has(source.value)) {
              floats.add(source.value);
              changed = true;
            }
          }
        }
      }
    }
  }
  return floats;
}
