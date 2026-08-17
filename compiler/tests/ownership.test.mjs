#!/usr/bin/env node
/**
 * Ownership and region inference tests.
 *
 * Two failure modes matter equally: rejecting safe code (which would make the
 * language unusable) and accepting a use-after-move (which would make the
 * guarantee hollow). Every test below pins one or the other.
 */
import assert from 'node:assert/strict';
import { tokenize } from '../dist/lexer/lexer.js';
import { parse } from '../dist/parser/parser.js';
import { checkProgram } from '../dist/checker/checker.js';
import { lowerToHir } from '../dist/hir/lower.js';
import { inferOwnership, classify } from '../dist/own/ownership.js';
import { T } from '../dist/checker/checker.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL  ${name}`); console.error(error instanceof Error ? error.stack ?? error.message : String(error)); }
}

function own(source) {
  const program = parse(tokenize(source, 'own.sun'));
  checkProgram(program);
  return inferOwnership(lowerToHir(program, 'own.sun'));
}

function kinds(result) {
  return result.errors.map((e) => e.kind);
}

test('scalars are Copy, aggregates are affine', () => {
  assert.equal(classify(T.int), 'copy');
  assert.equal(classify(T.float), 'copy');
  assert.equal(classify(T.bool), 'copy');
  assert.equal(classify(T.str), 'affine');
  assert.equal(classify(T.money), 'affine');
  assert.equal(classify(T.list(T.int)), 'affine');
  assert.equal(classify(T.named('Deck')), 'affine');
  // Unknown must not manufacture move errors.
  assert.equal(classify(T.unknown), 'copy');
});

test('reading a scalar many times is fine', () => {
  const result = own(`
fn main() uses io {
  let n = 5
  print(n)
  print(n)
  print(n + n)
}
`);
  assert.deepEqual(result.errors, []);
});

test('borrowing a list repeatedly is fine', () => {
  const result = own(`
fn main() uses io {
  let xs = [1, 2, 3]
  print(len(xs))
  print(len(xs))
  print(xs[0])
}
`);
  assert.deepEqual(kinds(result), [], JSON.stringify(result.errors, null, 1));
});

test('moving an aggregate twice is a double move', () => {
  const result = own(`
fn consume(xs) -> Int {
  return 1
}

fn main() {
  let xs = [1, 2, 3]
  let a = consume(xs)
  let b = consume(xs)
}
`);
  assert.ok(kinds(result).includes('double-move'), JSON.stringify(result.errors, null, 1));
  const error = result.errors.find((e) => e.kind === 'double-move');
  assert.equal(error.variable, 'xs');
  assert.ok(error.relatedSpan, 'the earlier move should be cited');
  assert.ok(error.relatedSpan.line < error.span.line, 'related span should precede the error');
});

test('using an aggregate after moving it is reported', () => {
  const result = own(`
fn consume(xs) -> Int {
  return 1
}

fn main() uses io {
  let xs = [1, 2, 3]
  let a = consume(xs)
  print(len(xs))
}
`);
  assert.ok(kinds(result).includes('use-after-move'), JSON.stringify(result.errors, null, 1));
});

test('scalars may be passed to functions repeatedly', () => {
  const result = own(`
fn twice(n: Int) -> Int {
  return n * 2
}

fn main() {
  let n = 4
  let a = twice(n)
  let b = twice(n)
}
`);
  assert.deepEqual(kinds(result), []);
});

test('a move in only one branch does not poison the join', () => {
  const result = own(`
fn consume(xs) -> Int {
  return 1
}

fn main(flag: Bool) uses io {
  let xs = [1, 2]
  if flag {
    let a = consume(xs)
  }
  print(len(xs))
}
`);
  // Conditional moves are joined conservatively as "not moved", so the later
  // read is accepted rather than producing a false alarm.
  assert.deepEqual(kinds(result), [], JSON.stringify(result.errors, null, 1));
});

test('moving inside a loop body is a double move', () => {
  const result = own(`
fn consume(xs) -> Int {
  return 1
}

fn main() {
  let xs = [1, 2]
  var i = 0
  while i < 3 {
    let a = consume(xs)
    i = i + 1
  }
}
`);
  assert.ok(kinds(result).includes('double-move'), JSON.stringify(result.errors, null, 1));
});

test('reassignment revives a moved binding', () => {
  const result = own(`
fn consume(xs) -> Int {
  return 1
}

fn main() uses io {
  var xs = [1, 2]
  let a = consume(xs)
  xs = [3, 4]
  print(len(xs))
}
`);
  assert.deepEqual(kinds(result), [], JSON.stringify(result.errors, null, 1));
});

test('assigning to an immutable binding is rejected', () => {
  const result = own(`
fn main() {
  let xs = [1, 2]
  xs = [3]
}
`);
  assert.ok(kinds(result).includes('assign-to-immutable'), JSON.stringify(result.errors, null, 1));
});

test('regions nest and record their bindings', () => {
  const result = own(`
fn main() uses io {
  let outer = [1, 2]
  if true {
    let inner = [3, 4]
    print(len(inner))
  }
  print(len(outer))
}
`);
  const regions = [...result.regions.values()].filter((r) => r.fn === 'main');
  assert.ok(regions.length >= 2, 'the if-block should open its own region');
  const nested = regions.find((r) => r.bindings.includes('inner'));
  const parent = regions.find((r) => r.bindings.includes('outer'));
  assert.ok(nested && parent);
  assert.equal(nested.parent, parent.id, 'inner region should be a child of the function region');
});

test('drop schedule lists affine bindings in reverse declaration order', () => {
  const result = own(`
fn main() {
  let a = [1]
  let b = [2]
  let n = 7
}
`);
  const region = [...result.regions.values()].find(
    (r) => r.fn === 'main' && r.bindings.includes('a'),
  );
  const drops = result.drops.get(region.id);
  assert.deepEqual(drops, ['b', 'a'], 'scalars are not dropped; aggregates drop in reverse');
});

test('returning an inner-region binding is a region escape', () => {
  const result = own(`
fn leak(flag: Bool) -> Str {
  if flag {
    let inner = "temporary"
    return inner
  }
  return "fallback"
}

fn main() {
  let s = leak(true)
}
`);
  assert.ok(kinds(result).includes('region-escape'), JSON.stringify(result.errors, null, 1));
  const escape = result.errors.find((e) => e.kind === 'region-escape');
  assert.equal(escape.variable, 'inner');
  assert.match(escape.message, /does not live long enough/);
});

test('returning a function-level binding is allowed', () => {
  const result = own(`
fn build() -> Str {
  let s = "value"
  return s
}

fn main() {
  let x = build()
}
`);
  assert.equal(kinds(result).includes('region-escape'), false, JSON.stringify(result.errors, null, 1));
});

test('borrow records capture kind and region', () => {
  const result = own(`
fn main() uses io {
  var xs = [1, 2]
  print(len(xs))
  xs = [3]
}
`);
  const shared = result.borrows.filter((b) => b.variable === 'xs' && b.kind === 'shared');
  const unique = result.borrows.filter((b) => b.variable === 'xs' && b.kind === 'unique');
  assert.ok(shared.length >= 1, 'reading through len() is a shared borrow');
  assert.ok(unique.length >= 1, 'assignment takes a unique borrow');
  assert.ok(result.borrows.every((b) => typeof b.region === 'number'));
});

test('a real example program passes ownership checking', () => {
  const result = own(`
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
  let values = [3, 5, 7]
  print(total(values))
}
`);
  assert.deepEqual(kinds(result), [], JSON.stringify(result.errors, null, 1));
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
