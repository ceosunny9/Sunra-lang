#!/usr/bin/env node
/**
 * Panic-freedom prover and determinism checker tests.
 *
 * The prover's value is entirely in its two-sided accuracy: it must discharge
 * code that really is safe (otherwise `#[no_panic]` is unusable) and must refuse
 * code that really can panic (otherwise the attribute is a lie). Both directions
 * are tested, including transitive propagation through the call graph.
 */
import assert from 'node:assert/strict';
import { tokenize } from '../dist/lexer/lexer.js';
import { parse } from '../dist/parser/parser.js';
import { checkProgram } from '../dist/checker/checker.js';
import { lowerToHir } from '../dist/hir/lower.js';
import { inferOwnership } from '../dist/own/ownership.js';
import { refineModule } from '../dist/refine/refine.js';
import { buildMir } from '../dist/mir/build.js';
import { optimize } from '../dist/opt/optimize.js';
import { provePanicFreedom } from '../dist/verify/panic_free.js';
import { checkDeterminism } from '../dist/verify/determinism.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL  ${name}`); console.error(error instanceof Error ? error.stack ?? error.message : String(error)); }
}

function pipeline(source, { opt = false } = {}) {
  const program = parse(tokenize(source, 'verify.sun'));
  const checked = checkProgram(program);
  const hir = lowerToHir(program, 'verify.sun');
  const refine = refineModule(hir);
  let module = buildMir(hir, inferOwnership(hir));
  if (opt) module = optimize(module, { refine }).module;
  return { module, refine, checked };
}

function prove(source, options) {
  const { module, refine } = pipeline(source, options);
  return provePanicFreedom(module, refine);
}

function proofFor(result, symbol) {
  const proof = result.functions.find((f) => f.symbol === symbol);
  assert.ok(proof, `no proof recorded for ${symbol}; have ${result.functions.map((f) => f.symbol).join(', ')}`);
  return proof;
}

// ------------------------------------------------- panic freedom: positives

test('panic: pure arithmetic is proven panic-free', () => {
  const result = prove(`
#[no_panic]
fn payout(bet: Int, mult: Int) -> Int {
  return bet * mult
}

fn main() uses io {
  print(payout(10, 3))
}
`);
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 1));
  assert.ok(result.panicFree.includes('payout'));
  assert.equal(proofFor(result, 'payout').proven, true);
});

test('panic: a guarded divisor discharges the division obligation', () => {
  const result = prove(`
#[no_panic]
fn ratio(a: Int, b: Int) -> Int {
  if b != 0 {
    return a / b
  }
  return 0
}

fn main() uses io {
  print(ratio(10, 2))
}
`);
  const proof = proofFor(result, 'ratio');
  const division = proof.sites.find((s) => s.kind === 'divide-by-zero');
  assert.ok(division, 'expected a division site to be recorded');
  assert.equal(division.discharged, true, `division not discharged: ${JSON.stringify(division)}`);
  assert.deepEqual(result.violations, []);
});

test('panic: a loop bounded by len() discharges the index obligation', () => {
  const result = prove(`
#[no_panic]
fn total(xs: [Int]) -> Int {
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
  const proof = proofFor(result, 'total');
  const index = proof.sites.find((s) => s.kind === 'index-out-of-bounds');
  assert.ok(index, 'expected an index site');
  assert.equal(index.discharged, true, `index not discharged: ${JSON.stringify(index)}`);
  assert.deepEqual(result.violations, []);
});

test('panic: the optimiser eliding a bounds check counts as a structural proof', () => {
  const result = prove(`
#[no_panic]
fn first(xs: [Int]) -> Int {
  if len(xs) > 0 {
    return xs[0]
  }
  return 0
}

fn main() uses io {
  print(first([5]))
}
`, { opt: true });
  const proof = proofFor(result, 'first');
  const index = proof.sites.find((s) => s.kind === 'index-out-of-bounds');
  assert.ok(index.discharged, `expected discharge, got ${JSON.stringify(index)}`);
  assert.ok(['refinement', 'structural'].includes(index.by), `unexpected prover: ${index.by}`);
});

// ------------------------------------------------- panic freedom: negatives

test('panic: an unguarded divisor fails the proof', () => {
  const result = prove(`
#[no_panic]
fn ratio(a: Int, b: Int) -> Int {
  return a / b
}

fn main() uses io {
  print(ratio(1, 0))
}
`);
  assert.equal(result.violations.length, 1, JSON.stringify(result.violations));
  assert.equal(result.violations[0].symbol, 'ratio');
  assert.match(result.violations[0].reasons.join(' '), /divide-by-zero/);
});

test('panic: an unbounded index fails the proof', () => {
  const result = prove(`
#[no_panic]
fn at(xs: [Int], i: Int) -> Int {
  return xs[i]
}

fn main() uses io {
  print(at([1], 0))
}
`);
  assert.equal(result.violations.length, 1, JSON.stringify(result.violations));
  assert.match(result.violations[0].reasons.join(' '), /index-out-of-bounds/);
});

test('panic: an explicit panic() can never be discharged', () => {
  const result = prove(`
#[no_panic]
fn bail(n: Int) -> Int {
  if n < 0 {
    panic("negative")
  }
  return n
}

fn main() uses io {
  print(bail(1))
}
`);
  assert.equal(result.violations.length, 1, JSON.stringify(result.violations));
  assert.match(result.violations[0].reasons.join(' '), /explicit-panic/);
});

test('panic: risk propagates transitively to callers', () => {
  const result = prove(`
fn risky(a: Int, b: Int) -> Int {
  return a / b
}

#[no_panic]
fn wrapper(a: Int) -> Int {
  return risky(a, a)
}

fn main() uses io {
  print(wrapper(4))
}
`);
  const violation = result.violations.find((v) => v.symbol === 'wrapper');
  assert.ok(violation, `wrapper should fail: ${JSON.stringify(result.violations)}`);
  assert.match(violation.reasons.join(' '), /callee-may-panic|risky/);
  assert.deepEqual(proofFor(result, 'wrapper').panickyCallees, ['risky']);
});

test('panic: a safe callee does not taint its caller', () => {
  const result = prove(`
fn double(a: Int) -> Int {
  return a * 2
}

#[no_panic]
fn wrapper(a: Int) -> Int {
  return double(a)
}

fn main() uses io {
  print(wrapper(4))
}
`);
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations));
  assert.ok(result.panicFree.includes('wrapper'));
});

test('panic: recursion terminates the fixed-point computation', () => {
  const result = prove(`
#[no_panic]
fn even(n: Int) -> Bool {
  if n == 0 {
    return true
  }
  return odd(n - 1)
}

#[no_panic]
fn odd(n: Int) -> Bool {
  if n == 0 {
    return false
  }
  return even(n - 1)
}

fn main() uses io {
  print(even(4))
}
`);
  // Mutually recursive and arithmetic-only: both must be proven, and the
  // analysis must not loop forever getting there.
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations));
  assert.ok(result.panicFree.includes('even') && result.panicFree.includes('odd'));
});

test('panic: functions without the attribute are analysed but never reported', () => {
  const result = prove(`
fn risky(a: Int, b: Int) -> Int {
  return a / b
}

fn main() uses io {
  print(risky(1, 1))
}
`);
  assert.deepEqual(result.violations, [], 'no attribute means no violation');
  const proof = proofFor(result, 'risky');
  assert.equal(proof.requested, false);
  assert.equal(proof.proven, false, 'still analysed as risky');
});

// ----------------------------------------------------------- determinism

test('determinism: pure integer maths is deterministic', () => {
  const { module } = pipeline(`
fn spin(bet: Int) -> Int {
  return bet * 3
}

fn main() uses io {
  print(spin(10))
}
`);
  const result = checkDeterminism(module);
  assert.equal(result.deterministic, true, JSON.stringify(result.findings, null, 1));
  assert.ok(result.criticalFunctions.includes('spin'));
});

test('determinism: wall-clock access is a finding', () => {
  const { module } = pipeline(`
fn spin() -> Int uses time {
  return Timer.now()
}

fn main() uses io, time {
  print(spin())
}
`);
  const result = checkDeterminism(module);
  assert.equal(result.deterministic, false);
  assert.ok(
    result.findings.some((f) => f.kind === 'wall-clock' || f.kind === 'external-effect'),
    JSON.stringify(result.findings),
  );
});

test('determinism: network access is a finding', () => {
  const { module } = pipeline(`
fn spin() uses net {
  let socket = Net.websocketConnect("ws://example.com")
}

fn main() uses net {
  spin()
}
`);
  const result = checkDeterminism(module);
  assert.equal(result.deterministic, false);
  assert.ok(result.findings.some((f) => f.kind === 'network' || f.kind === 'external-effect'));
});

test('determinism: float arithmetic in payout maths is a finding', () => {
  const { module } = pipeline(`
fn spin(bet: Float) -> Float {
  return bet * 1.5
}

fn main() uses io {
  print(spin(2.0))
}
`);
  const result = checkDeterminism(module);
  assert.ok(
    result.findings.some((f) => f.kind === 'float-money'),
    JSON.stringify(result.findings),
  );
});

test('determinism: integer money maths is accepted where float is not', () => {
  const floatVersion = checkDeterminism(pipeline(`
fn spin(bet: Float) -> Float {
  return bet * 2.0
}
`).module, { entryPoints: ['spin'] });
  const intVersion = checkDeterminism(pipeline(`
fn spin(bet: Int) -> Int {
  return bet * 2
}
`).module, { entryPoints: ['spin'] });

  // Float arithmetic is a *precision* finding, not a replay finding. IEEE-754 is
  // deterministic on a given platform, so such a round still replays exactly;
  // what it risks is cross-platform payout drift, and that is what `exact`
  // reports. Asserting `deterministic === false` here would demand that the
  // checker call replayable code unreplayable.
  assert.equal(intVersion.exact, true, JSON.stringify(intVersion.findings));
  assert.equal(floatVersion.exact, false, JSON.stringify(floatVersion.findings));
  assert.equal(intVersion.deterministic, true, JSON.stringify(intVersion.findings));
  assert.equal(floatVersion.deterministic, true, JSON.stringify(floatVersion.findings));
});

test('determinism: findings record the call path that reached them', () => {
  const { module } = pipeline(`
fn leaf() -> Int uses time {
  return Timer.now()
}

fn middle() -> Int uses time {
  return leaf()
}

fn spin() -> Int uses time {
  return middle()
}

fn main() uses io, time {
  print(spin())
}
`);
  const result = checkDeterminism(module);
  const finding = result.findings.find((f) => f.symbol === 'leaf');
  assert.ok(finding, JSON.stringify(result.findings.map((f) => f.symbol)));
  assert.ok(finding.via.length >= 2, `expected a call path, got ${JSON.stringify(finding.via)}`);
  assert.equal(finding.via[finding.via.length - 1], 'leaf');
});

test('determinism: only functions reachable from entry points are audited', () => {
  const { module } = pipeline(`
fn unused() -> Int uses time {
  return Timer.now()
}

fn spin(bet: Int) -> Int {
  return bet
}
`);
  const result = checkDeterminism(module, { entryPoints: ['spin'] });
  assert.equal(result.deterministic, true, JSON.stringify(result.findings));
  assert.ok(!result.criticalFunctions.includes('unused'));
});

test('determinism: the strict profile forbids randomness entirely', () => {
  const { module } = pipeline(`
fn spin() -> Int uses rand {
  return rng.int(1, 10)
}

fn main() uses io, rand {
  print(spin())
}
`);
  const lenient = checkDeterminism(module, { allowSeededRandom: true });
  const strict = checkDeterminism(module, { allowSeededRandom: false });
  assert.ok(
    strict.findings.some((f) => f.kind === 'unseeded-random'),
    JSON.stringify(strict.findings),
  );
  assert.ok(
    strict.findings.length >= lenient.findings.length,
    'the strict profile must not report fewer findings',
  );
});

test('determinism: game methods are picked up as entry points', () => {
  const { module } = pipeline(`
game Lucky {
  rtp = 96.5

  fn spin() -> Int {
    return 1
  }
}

fn main() uses io {
  print(1)
}
`);
  const result = checkDeterminism(module);
  assert.ok(
    result.criticalFunctions.some((s) => s.endsWith('.spin')),
    JSON.stringify(result.criticalFunctions),
  );
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
