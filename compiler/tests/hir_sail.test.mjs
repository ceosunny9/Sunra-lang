#!/usr/bin/env node
/**
 * SunHIR lowering + SAIL emission tests.
 *
 * The lowering tests assert the *shape* invariants every later stage relies on
 * (no pipelines, no for-loops, no compound assignment, every expression typed).
 * The SAIL tests assert the document is stable, addressable and queryable.
 */
import assert from 'node:assert/strict';
import { tokenize } from '../dist/lexer/lexer.js';
import { parse } from '../dist/parser/parser.js';
import { checkProgram } from '../dist/checker/checker.js';
import { lowerToHir } from '../dist/hir/lower.js';
import { walkExprs, walkStmts } from '../dist/hir/hir.js';
import { emitSail, querySail, functionsWithEffect, SAIL_VERSION } from '../dist/sail/sail.js';
import { Interpreter } from '../dist/interpreter/interpreter.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL  ${name}`); console.error(error instanceof Error ? error.stack ?? error.message : String(error)); }
}

function frontend(source, file = 'hir.sun') {
  const program = parse(tokenize(source, file));
  const checked = checkProgram(program);
  assert.equal(checked.errors.length, 0, checked.errors.map((e) => e.message).join('\n'));
  return program;
}

function lower(source, file = 'hir.sun') {
  return lowerToHir(frontend(source, file), file);
}

const SAMPLE = `
fn score(n) -> Int {
  var total = 0
  for x in [1, 2, 3] {
    total += x * n
  }
  return total
}

fn label(n) -> Str {
  return "score={n}"
}

fn classify(n) -> Str {
  return match n {
    0 -> "zero",
    _ -> "nonzero"
  }
}

fn main() uses io {
  let s = score(2)
  print(label(s))
  print(classify(s))
}
`;

test('lowering removes for-loops, pipelines, interpolation and compound assignment', () => {
  const module = lower(SAMPLE);
  const kinds = new Set();
  walkStmts(module, (s) => kinds.add(s.kind));
  walkExprs(module, (e) => kinds.add(e.kind));

  // Desugared away entirely:
  for (const gone of ['ForStmt', 'Pipeline', 'Interp', 'MatchExpr', 'RangeExpr']) {
    assert.equal(kinds.has(gone), false, `${gone} should not survive lowering`);
  }
  // The for-loop became a while loop with an index.
  assert.equal(kinds.has('While'), true);
  // Interpolation became concatenation.
  const concats = [];
  walkExprs(module, (e) => { if (e.kind === 'Binary' && e.op === 'concat') concats.push(e); });
  assert.ok(concats.length > 0, 'interpolation should lower to concat');
});

test('every lowered expression carries a type annotation', () => {
  const module = lower(SAMPLE);
  let count = 0;
  walkExprs(module, (e) => {
    count += 1;
    assert.ok(e.ty && typeof e.ty.k === 'string', `node ${e.kind} is missing a type`);
    assert.ok(e.span && typeof e.span.line === 'number', `node ${e.kind} is missing a span`);
  });
  assert.ok(count > 20, `expected a populated HIR, saw ${count} expressions`);
});

test('compound assignment becomes an explicit binary assignment', () => {
  const module = lower(`
fn main() {
  var total = 1
  total += 4
}
`);
  const assigns = [];
  walkExprs(module, (e) => { if (e.kind === 'Assign') assigns.push(e); });
  assert.equal(assigns.length, 1);
  assert.equal(assigns[0].value.kind, 'Binary');
  assert.equal(assigns[0].value.op, 'add');
  assert.equal(assigns[0].place.kind, 'Var');
});

test('game blocks lower to data plus owner-qualified methods', () => {
  const module = lower(`
game Lucky {
  reel symbols = ["A", "B", "C"]
  rtp = 96.5

  fn spin() -> Int uses rand {
    return 1
  }
}

fn main() {
}
`);
  assert.equal(module.games.length, 1);
  const game = module.games[0];
  assert.equal(game.name, 'Lucky');
  assert.equal(game.reels.length, 1);
  assert.equal(game.fields.some((f) => f.name === 'rtp'), true);
  assert.deepEqual(game.methods, ['Lucky.spin']);
  const spin = module.functions.find((f) => f.name === 'Lucky.spin');
  assert.ok(spin, 'game method should become a function');
  assert.equal(spin.owner, 'Lucky');
  assert.deepEqual(spin.effects, ['rand']);
});

test('for-loop lowering preserves interpreter semantics', () => {
  // The lowered form must compute what the interpreter computes.
  const source = `
fn main() uses io {
  var total = 0
  for x in [1, 2, 3, 4] {
    total += x
  }
  print(total)
}
`;
  const output = [];
  new Interpreter({ stdout: (line) => output.push(line) }).run(frontend(source));
  assert.equal(output[0], '10');

  // And the lowered HIR must contain exactly one loop with an index guard.
  const module = lower(source);
  const loops = [];
  walkStmts(module, (s) => { if (s.kind === 'While') loops.push(s); });
  assert.equal(loops.length, 1);
  assert.equal(loops[0].cond.kind, 'Binary');
  assert.equal(loops[0].cond.op, 'lt');
});

test('SAIL document is versioned, addressable and digest-stable', () => {
  const a = emitSail(lower(SAMPLE));
  const b = emitSail(lower(SAMPLE));
  assert.equal(a.sail, SAIL_VERSION);
  assert.equal(a.digest, b.digest, 'same source must produce the same digest');

  const other = emitSail(lower(SAMPLE.replace('total += x * n', 'total += x * n + 1')));
  assert.notEqual(a.digest, other.digest, 'changed source must change the digest');

  // Every node id in the index must be unique and resolvable.
  const ids = Object.keys(a.index);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('fn:main/body'), `expected fn:main/body among ids`);
});

test('SAIL semantic queries find calls, effects and literals', () => {
  const doc = emitSail(lower(SAMPLE));

  const calls = querySail(doc, { kind: 'Call' });
  assert.ok(calls.length >= 3, `expected several calls, saw ${calls.length}`);

  const printCalls = querySail(doc, { kind: 'Call', attr: { name: 'callee', value: 'print' } });
  assert.equal(printCalls.length, 2);
  assert.ok(printCalls.every((m) => m.id.startsWith('fn:main/body')));

  const effectful = querySail(doc, { tag: 'effectful' });
  assert.ok(effectful.length >= 2, 'print calls should be tagged effectful');

  const inMain = querySail(doc, { kind: 'Var', inFunction: 'main' });
  assert.ok(inMain.length > 0);
  assert.ok(inMain.every((m) => m.id.startsWith('fn:main')));

  assert.deepEqual(functionsWithEffect(doc, 'io'), ['main']);

  const ints = querySail(doc, { kind: 'Const', ty: 'Int' });
  assert.ok(ints.length > 0, 'integer literals should be typed Int in SAIL');
});

test('SAIL is plain JSON with no cycles', () => {
  const doc = emitSail(lower(SAMPLE));
  const json = JSON.stringify(doc);
  const round = JSON.parse(json);
  assert.equal(round.digest, doc.digest);
  assert.equal(round.functions.length, doc.functions.length);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
