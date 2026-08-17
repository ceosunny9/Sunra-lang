#!/usr/bin/env node
/**
 * Optimiser tests.
 *
 * Two obligations for every pass: it must actually fire on the pattern it
 * targets (otherwise it is decoration), and the module must still verify
 * afterwards (otherwise it is a miscompilation waiting to happen).
 */
import assert from 'node:assert/strict';
import { tokenize } from '../dist/lexer/lexer.js';
import { parse } from '../dist/parser/parser.js';
import { checkProgram } from '../dist/checker/checker.js';
import { lowerToHir } from '../dist/hir/lower.js';
import { inferOwnership } from '../dist/own/ownership.js';
import { refineModule } from '../dist/refine/refine.js';
import { buildMir } from '../dist/mir/build.js';
import { verifyModule } from '../dist/mir/verify.js';
import { optimize } from '../dist/opt/optimize.js';
import { formatModule } from '../dist/mir/mir.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL  ${name}`); console.error(error instanceof Error ? error.stack ?? error.message : String(error)); }
}

function pipeline(source, options = {}) {
  const program = parse(tokenize(source, 'opt.sun'));
  const checked = checkProgram(program);
  assert.equal(checked.errors.length, 0, checked.errors.map((e) => e.message).join('\n'));
  const hir = lowerToHir(program, 'opt.sun');
  const own = inferOwnership(hir);
  const refine = refineModule(hir);
  const before = buildMir(hir, own);
  assert.deepEqual(verifyModule(before), [], 'unoptimised IR must verify');
  const result = optimize(before, { refine, ...options });
  const errors = verifyModule(result.module);
  assert.deepEqual(errors, [], `optimised IR must verify:\n${JSON.stringify(errors, null, 1)}\n${formatModule(result.module)}`);
  return { before, ...result };
}

function instrs(module, name) {
  const fn = module.functions.find((f) => f.name === name);
  assert.ok(fn, `function ${name} not found`);
  return fn.blocks.flatMap((b) => b.instrs);
}

function eventsFor(result, pass) {
  return result.events.filter((e) => e.pass === pass);
}

test('constant folding collapses arithmetic', () => {
  const result = pipeline(`
fn main() {
  let x = 2 + 3 * 4
}
`);
  assert.ok(eventsFor(result, 'const-fold').length >= 2, JSON.stringify(result.counts));
  const binaries = instrs(result.module, 'main').filter((i) => i.op === 'binary');
  assert.equal(binaries.length, 0, `all arithmetic should fold:\n${formatModule(result.module)}`);
});

test('constant folding evaluates comparisons and string concat', () => {
  // The folded values are printed, because DCE legitimately deletes a constant
  // nobody reads — the point here is the *value* produced, not its survival.
  const result = pipeline(`
fn main() uses io {
  let a = 5 > 3
  let b = "foo" + "bar"
  print(a)
  print(b)
}
`);
  const consts = instrs(result.module, 'main').filter((i) => i.op === 'const');
  assert.ok(consts.some((c) => c.value.k === 'bool' && c.value.value === true));
  assert.ok(consts.some((c) => c.value.k === 'str' && c.value.value === 'foobar'));
});

test('division by zero is NOT folded away', () => {
  // Folding it would erase the diagnostic the refinement layer produces.
  const result = pipeline(`
fn main() uses io {
  let x = 1 / 0
  print(x)
}
`);
  const binaries = instrs(result.module, 'main').filter((i) => i.op === 'binary' && i.kind === 'div');
  assert.equal(binaries.length, 1, 'div-by-zero must survive folding');
});

test('small pure functions are inlined', () => {
  const result = pipeline(`
fn double(n: Int) -> Int {
  return n * 2
}

fn main() uses io {
  print(double(21))
}
`);
  assert.ok(eventsFor(result, 'inline').length >= 1, JSON.stringify(result.events, null, 1));
});

test('effectful functions are not inlined', () => {
  const result = pipeline(`
fn shout(n: Int) -> Int uses io {
  print(n)
  return n
}

fn main() uses io {
  let x = shout(1)
}
`);
  const inlined = eventsFor(result, 'inline').filter((e) => e.detail.includes('shout'));
  assert.equal(inlined.length, 0, 'a function with effects must keep its call');
});

test('recursive functions are not inlined', () => {
  const result = pipeline(`
fn fact(n: Int) -> Int {
  if n <= 1 {
    return 1
  }
  return n * fact(n - 1)
}

fn main() uses io {
  print(fact(5))
}
`);
  const inlined = eventsFor(result, 'inline').filter((e) => e.detail.includes('fact'));
  assert.equal(inlined.length, 0);
});

test('bounds checks proved safe by refinement are elided', () => {
  const result = pipeline(`
fn main() uses io {
  let xs = [10, 20, 30]
  print(xs[1])
}
`);
  assert.ok(eventsFor(result, 'bounds-elision').length >= 1, JSON.stringify(result.counts));
  const indexes = instrs(result.module, 'main').filter((i) => i.op === 'index');
  assert.ok(indexes.some((i) => i.checked === false), 'index should be marked unchecked');
});

test('unproved bounds checks are kept', () => {
  const result = pipeline(`
fn get(xs, i: Int) -> Int {
  return xs[i]
}

fn main() uses io {
  print(get([1, 2], 0))
}
`);
  const indexes = instrs(result.module, 'get').filter((i) => i.op === 'index');
  assert.ok(indexes.length >= 1);
  assert.notEqual(indexes[0].checked, false, 'an unproved index must stay checked');
});

test('constant tables are precomputed', () => {
  const result = pipeline(`
fn main() uses io {
  let reels = ["cherry", "lemon", "star", "gem", "seven"]
  print(len(reels))
}
`);
  assert.ok(eventsFor(result, 'table-precompute').length >= 1, JSON.stringify(result.counts));
  const lists = instrs(result.module, 'main').filter((i) => i.op === 'list');
  assert.ok(lists.some((l) => typeof l.precomputed === 'string'));
});

test('non-constant lists are not precomputed', () => {
  const result = pipeline(`
fn build(a: Int, b: Int) {
  return [a, b]
}

fn main() uses io {
  print(len(build(1, 2)))
}
`);
  const lists = instrs(result.module, 'build').filter((i) => i.op === 'list');
  assert.ok(lists.length >= 1);
  assert.equal(lists[0].precomputed, undefined);
});

test('non-escaping aggregates are promoted to the arena', () => {
  const result = pipeline(`
fn main() {
  let scratch = [1, 2, 3]
}
`);
  assert.ok(eventsFor(result, 'arena-promotion').length >= 1, `${JSON.stringify(result.counts)}\n${formatModule(result.module)}`);
  const lists = instrs(result.module, 'main').filter((i) => i.op === 'list');
  assert.ok(lists.some((l) => l.arena === true));
});

test('escaping aggregates are not promoted', () => {
  const result = pipeline(`
fn keep(xs) {
  return xs
}

fn main() {
  let xs = [1, 2]
  let ys = keep(xs)
}
`);
  const lists = instrs(result.module, 'main').filter((i) => i.op === 'list');
  assert.ok(lists.length >= 1);
  assert.notEqual(lists[0].arena, true, 'a value passed to a call may escape');
});

test('dead code is eliminated but drops and calls survive', () => {
  const result = pipeline(`
fn main() uses io {
  let unused = 1 + 1
  let xs = [1, 2]
  print(len(xs))
}
`);
  assert.ok(eventsFor(result, 'dce').length >= 1, JSON.stringify(result.counts));
  const kept = instrs(result.module, 'main');
  assert.ok(kept.some((i) => i.op === 'drop'), 'drops must never be removed');
  assert.ok(kept.some((i) => i.op === 'call'), 'calls must never be removed');
});

test('optimisation level 0 changes nothing', () => {
  const result = pipeline(`
fn main() {
  let x = 2 + 3
}
`, { level: 0 });
  assert.deepEqual(result.events, []);
  assert.equal(
    formatModule(result.module),
    formatModule(result.before),
    'level 0 must be a no-op',
  );
});

test('the optimiser is idempotent', () => {
  const first = pipeline(`
fn helper(n: Int) -> Int {
  return n + 1
}

fn main() uses io {
  let xs = [1, 2, 3]
  print(helper(xs[0]) + 2 * 3)
}
`);
  // Convergence is what matters, not "zero events on run 2": table-precompute and
  // arena-promotion are annotating passes, so they re-report an already-annotated
  // instruction. The fixed point is reached when the IR text stops changing.
  const second = optimize(first.module, {});
  assert.deepEqual(verifyModule(second.module), []);
  const third = optimize(second.module, {});
  assert.deepEqual(verifyModule(third.module), []);
  assert.equal(
    formatModule(third.module),
    formatModule(second.module),
    'the optimiser must reach a fixed point',
  );
});

test('an optimised slot program still verifies', () => {
  const result = pipeline(`
game Slots {
  reel symbols = ["cherry", "lemon", "star"]
  rtp = 96.0

  fn spin() -> Int uses rand {
    return 1
  }
}

fn payout(bet: Int, multiplier: Int) -> Int {
  return bet * multiplier
}

fn main() uses io {
  let bet = 10
  print(payout(bet, 3))
}
`);
  assert.deepEqual(verifyModule(result.module), []);
  assert.ok(Object.keys(result.counts).length >= 2, JSON.stringify(result.counts));
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
