#!/usr/bin/env node
/**
 * Refinement checker tests.
 *
 * The interesting assertions are the ones that distinguish *proved* from
 * *unknown*: an analysis that reported everything as unknown would pass a naive
 * "no false alarms" test while being useless, so each safe program below is
 * required to actually discharge its obligation.
 */
import assert from 'node:assert/strict';
import { tokenize } from '../dist/lexer/lexer.js';
import { parse } from '../dist/parser/parser.js';
import { checkProgram } from '../dist/checker/checker.js';
import { lowerToHir } from '../dist/hir/lower.js';
import { refineModule } from '../dist/refine/refine.js';
import { LinearStore, variable, lit, minus, plus, scale, satisfiable } from '../dist/refine/linear.js';
import * as I from '../dist/refine/interval.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL  ${name}`); console.error(error instanceof Error ? error.stack ?? error.message : String(error)); }
}

function refine(source) {
  const program = parse(tokenize(source, 'refine.sun'));
  const checked = checkProgram(program);
  assert.equal(checked.errors.length, 0, checked.errors.map((e) => e.message).join('\n'));
  return refineModule(lowerToHir(program, 'refine.sun'));
}

/**
 * Refine without requiring the checker to accept the program.
 *
 * Some refinement obligations exist precisely for programs the front-end
 * already rejects (an out-of-range RTP, for instance). The refinement layer must
 * still classify them correctly, because the panic prover and the certification
 * packs consume its verdicts independently of front-end errors.
 */
function refineUnchecked(source) {
  const program = parse(tokenize(source, 'refine.sun'));
  checkProgram(program);
  return refineModule(lowerToHir(program, 'refine.sun'));
}

function obligations(result, kind) {
  return result.obligations.filter((o) => o.kind === kind);
}

// ------------------------------------------------------------------ intervals

test('interval lattice: arithmetic, meet, join and bottom', () => {
  const a = I.range(1, 5, true);
  const b = I.range(3, 8, true);
  assert.deepEqual(I.add(a, b), { lo: 4, hi: 13, int: true });
  assert.deepEqual(I.sub(a, b), { lo: -7, hi: 2, int: true });
  assert.deepEqual(I.mul(a, b), { lo: 3, hi: 40, int: true });
  assert.deepEqual(I.meet(a, b), { lo: 3, hi: 5, int: true });
  assert.deepEqual(I.join(a, b), { lo: 1, hi: 8, int: true });
  assert.equal(I.isBottom(I.meet(I.range(1, 2), I.range(5, 6))), true);
});

test('interval division flags a divisor range containing zero', () => {
  assert.equal(I.div(I.range(1, 4), I.range(2, 4)).mayDivideByZero, false);
  assert.equal(I.div(I.range(1, 4), I.range(-1, 3)).mayDivideByZero, true);
  assert.equal(I.div(I.range(1, 4), I.range(0, 0)).mayDivideByZero, true);
});

test('widening terminates unstable endpoints', () => {
  const widened = I.widen(I.range(0, 1, true), I.range(0, 2, true));
  assert.equal(widened.hi, Number.POSITIVE_INFINITY);
  assert.equal(widened.lo, 0, 'stable endpoint must be preserved');
});

// ------------------------------------------------------- linear arithmetic

test('Fourier-Motzkin decides satisfiability including strictness', () => {
  // x > 0 and -x >= 0 is unsatisfiable.
  assert.equal(satisfiable([
    { expr: variable('x'), strict: true },
    { expr: scale(variable('x'), -1), strict: false },
  ]), false);
  // x >= 0 and -x >= 0 is satisfiable (x = 0).
  assert.equal(satisfiable([
    { expr: variable('x'), strict: false },
    { expr: scale(variable('x'), -1), strict: false },
  ]), true);
});

test('linear store proves transitive relational facts', () => {
  // i >= 0, n - i > 0  entails  n > 0
  const store = new LinearStore()
    .assume(variable('i'))
    .assume(minus(variable('n'), variable('i')), true);
  assert.equal(store.proves(variable('n'), true), true, 'n > 0 should follow');
  // It must NOT prove something false.
  assert.equal(store.proves(minus(variable('i'), variable('n')), true), false);
});

test('linear store detects contradictory guards', () => {
  const store = new LinearStore()
    .assume(minus(variable('x'), lit(5)))       // x >= 5
    .assume(minus(lit(2), variable('x')));      // x <= 2
  assert.equal(store.isContradictory(), true);
});

// ------------------------------------------------------------- obligations

test('division by a non-zero constant is proved safe', () => {
  const result = refine(`
fn half(n: Int) -> Float {
  return n / 2
}

fn main() {
  let x = half(8)
}
`);
  const divs = obligations(result, 'division-by-zero');
  assert.equal(divs.length, 1);
  assert.equal(divs[0].status, 'proved', divs[0].reason);
});

test('division by a literal zero is reported as violated', () => {
  const result = refine(`
fn bad(n: Int) -> Float {
  return n / 0
}

fn main() {
  let x = bad(1)
}
`);
  const divs = obligations(result, 'division-by-zero');
  assert.equal(divs.length, 1);
  assert.equal(divs[0].status, 'violated', divs[0].reason);
  assert.equal(result.violated >= 1, true);
});

test('a guard discharges an otherwise-unknown division', () => {
  const guarded = refine(`
fn ratio(a: Int, b: Int) -> Float {
  if b != 0 {
    return a / b
  }
  return 0.0
}

fn main() {
  let r = ratio(1, 2)
}
`);
  const guardedDivs = obligations(guarded, 'division-by-zero');
  assert.equal(guardedDivs.length, 1);
  assert.equal(guardedDivs[0].status, 'proved', guardedDivs[0].reason);

  // Without the guard the same division must NOT be claimed safe.
  const unguarded = refine(`
fn ratio(a: Int, b: Int) -> Float {
  return a / b
}

fn main() {
  let r = ratio(1, 2)
}
`);
  assert.equal(obligations(unguarded, 'division-by-zero')[0].status, 'unknown');
});

test('positivity guards prove a division safe', () => {
  const result = refine(`
fn share(total: Int, parts: Int) -> Float {
  if parts > 0 {
    return total / parts
  }
  return 0.0
}

fn main() {
  let s = share(10, 2)
}
`);
  assert.equal(obligations(result, 'division-by-zero')[0].status, 'proved');
});

test('constant index into a literal list is proved in bounds', () => {
  const result = refine(`
fn main() uses io {
  let xs = [10, 20, 30]
  print(xs[1])
}
`);
  const bounds = obligations(result, 'index-out-of-bounds');
  assert.equal(bounds.length, 1);
  assert.equal(bounds[0].status, 'proved', bounds[0].reason);
  assert.equal(obligations(result, 'negative-index')[0].status, 'proved');
});

test('constant index past the end is reported as violated', () => {
  const result = refine(`
fn main() uses io {
  let xs = [10, 20, 30]
  print(xs[7])
}
`);
  const bounds = obligations(result, 'index-out-of-bounds');
  assert.equal(bounds.length, 1);
  assert.equal(bounds[0].status, 'violated', bounds[0].reason);
});

test('loop index bounded by len() is proved in bounds', () => {
  const result = refine(`
fn total(xs) -> Int {
  var sum = 0
  var i = 0
  while i < len(xs) {
    sum = sum + xs[i]
    i = i + 1
  }
  return sum
}

fn main() uses io {
  print(total([1, 2, 3]))
}
`);
  const bounds = obligations(result, 'index-out-of-bounds').filter((o) => o.fn === 'total');
  assert.equal(bounds.length >= 1, true);
  assert.equal(bounds[0].status, 'proved', bounds[0].reason);
  const negatives = obligations(result, 'negative-index').filter((o) => o.fn === 'total');
  assert.equal(negatives[0].status, 'proved', negatives[0].reason);
});

test('RTP inside [0,100] is proved, outside is violated', () => {
  const good = refine(`
game Fine {
  reel symbols = ["A", "B"]
  rtp = 96.5

  fn spin() -> Int uses rand {
    return 1
  }
}

fn main() {
}
`);
  const goodRtp = obligations(good, 'rtp-range');
  assert.equal(goodRtp.length, 1);
  assert.equal(goodRtp[0].status, 'proved', goodRtp[0].reason);

  const bad = refineUnchecked(`
game Broken {
  reel symbols = ["A", "B"]
  rtp = 250.0

  fn spin() -> Int uses rand {
    return 1
  }
}

fn main() {
}
`);
  const badRtp = obligations(bad, 'rtp-range');
  assert.equal(badRtp[0].status, 'violated', badRtp[0].reason);
});

test('modulo by zero is caught separately from division', () => {
  const result = refine(`
fn wrap(n: Int) -> Int {
  return n % 0
}

fn main() {
  let x = wrap(3)
}
`);
  const mods = obligations(result, 'modulo-by-zero');
  assert.equal(mods.length, 1);
  assert.equal(mods[0].status, 'violated');
});

test('unreachable branches do not generate obligations', () => {
  // The division sits in a branch the guards make impossible.
  const result = refine(`
fn dead(n: Int) -> Float {
  if n > 10 {
    if n < 5 {
      return n / 0
    }
  }
  return 1.0
}

fn main() {
  let x = dead(20)
}
`);
  const divs = obligations(result, 'division-by-zero');
  assert.equal(divs.length, 0, 'contradictory path should be pruned');
});

test('inferred ranges are reported for locals', () => {
  const result = refine(`
fn main() {
  let a = 5
  let b = a * 3
}
`);
  assert.equal(result.ranges.get('main:a'), '[5, 5]');
  assert.equal(result.ranges.get('main:b'), '[15, 15]');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
