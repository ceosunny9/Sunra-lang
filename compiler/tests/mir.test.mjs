#!/usr/bin/env node
/**
 * SunMIR construction tests.
 *
 * The verifier does most of the work: if lowering produced non-SSA code, a phi
 * in the wrong place, or a use that its definition does not dominate, these tests
 * fail. On top of that each test pins one structural property of the IR.
 */
import assert from 'node:assert/strict';
import { tokenize } from '../dist/lexer/lexer.js';
import { parse } from '../dist/parser/parser.js';
import { checkProgram } from '../dist/checker/checker.js';
import { lowerToHir } from '../dist/hir/lower.js';
import { inferOwnership } from '../dist/own/ownership.js';
import { buildMir } from '../dist/mir/build.js';
import { verifyModule, verifyFunction } from '../dist/mir/verify.js';
import { formatFunction, destOf } from '../dist/mir/mir.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL  ${name}`); console.error(error instanceof Error ? error.stack ?? error.message : String(error)); }
}

function mir(source) {
  const program = parse(tokenize(source, 'mir.sun'));
  const checked = checkProgram(program);
  assert.equal(checked.errors.length, 0, checked.errors.map((e) => e.message).join('\n'));
  const hir = lowerToHir(program, 'mir.sun');
  const own = inferOwnership(hir);
  const module = buildMir(hir, own);
  const errors = verifyModule(module);
  assert.deepEqual(errors, [], JSON.stringify(errors, null, 1));
  return module;
}

function fnNamed(module, name) {
  const fn = module.functions.find((f) => f.name === name);
  assert.ok(fn, `function ${name} not found`);
  return fn;
}

function allInstrs(fn) {
  return fn.blocks.flatMap((b) => b.instrs);
}

test('a straight-line function lowers to one block', () => {
  const module = mir(`
fn add(a: Int, b: Int) -> Int {
  return a + b
}

fn main() {
  let x = add(1, 2)
}
`);
  const add = fnNamed(module, 'add');
  assert.equal(add.blocks.length, 1);
  assert.equal(add.blocks[0].terminator.op, 'return');
  const binary = allInstrs(add).find((i) => i.op === 'binary');
  assert.equal(binary.kind, 'add');
});

test('SSA: every value is assigned exactly once', () => {
  const module = mir(`
fn accumulate(n: Int) -> Int {
  var total = 0
  var i = 0
  while i < n {
    total = total + i
    i = i + 1
  }
  return total
}

fn main() uses io {
  print(accumulate(5))
}
`);
  for (const fn of module.functions) {
    const seen = new Set();
    for (const param of fn.params) seen.add(param.value);
    for (const instr of allInstrs(fn)) {
      const dst = destOf(instr);
      if (dst === null) continue;
      assert.equal(seen.has(dst), false, `%${dst} assigned twice in ${fn.symbol}`);
      seen.add(dst);
    }
  }
});

test('an if statement produces a branch and a join', () => {
  const module = mir(`
fn pick(flag: Bool) -> Int {
  if flag {
    return 1
  }
  return 2
}

fn main() {
  let x = pick(true)
}
`);
  const pick = fnNamed(module, 'pick');
  const branches = pick.blocks.filter((b) => b.terminator.op === 'branch');
  assert.equal(branches.length, 1);
  assert.ok(pick.blocks.length >= 3, 'then/else/join blocks expected');
});

test('a loop places a phi in the header with two sources', () => {
  const module = mir(`
fn count(n: Int) -> Int {
  var i = 0
  while i < n {
    i = i + 1
  }
  return i
}

fn main() {
  let x = count(3)
}
`);
  const count = fnNamed(module, 'count');
  const phis = allInstrs(count).filter((i) => i.op === 'phi');
  assert.ok(phis.length >= 1, 'loop-carried variable needs a phi');
  const loopPhi = phis.find((p) => p.sources.length >= 2);
  assert.ok(loopPhi, `expected a phi with an entry and a back edge:\n${formatFunction(count)}`);
});

test('phis sit at the top of their block', () => {
  const module = mir(`
fn f(a: Bool, b: Int) -> Int {
  var x = b
  if a {
    x = b + 1
  }
  return x
}

fn main() {
  let y = f(true, 2)
}
`);
  for (const fn of module.functions) {
    for (const block of fn.blocks) {
      let seenOther = false;
      for (const instr of block.instrs) {
        if (instr.op === 'phi') assert.equal(seenOther, false, 'phi after non-phi');
        else seenOther = true;
      }
    }
  }
});

test('short-circuit and/or become control flow, not a binary op', () => {
  const module = mir(`
fn both(a: Bool, b: Bool) -> Bool {
  return a and b
}

fn main() {
  let x = both(true, false)
}
`);
  const both = fnNamed(module, 'both');
  const binaryAnd = allInstrs(both).find((i) => i.op === 'binary' && i.kind === 'and');
  assert.equal(binaryAnd, undefined, 'and must not be a single instruction');
  assert.ok(both.blocks.some((b) => b.terminator.op === 'branch'), 'and needs a branch');
  assert.ok(allInstrs(both).some((i) => i.op === 'phi'), 'and needs a phi for its result');
});

test('explicit drops are emitted for affine bindings', () => {
  const module = mir(`
fn main() uses io {
  let xs = [1, 2, 3]
  print(len(xs))
}
`);
  const top = module.functions.find((f) => f.name === 'main');
  const drops = allInstrs(top).filter((i) => i.op === 'drop');
  assert.ok(drops.length >= 1, `expected a drop for xs:\n${formatFunction(top)}`);
  assert.equal(drops[0].variable, 'xs');
});

test('scalars are not dropped', () => {
  const module = mir(`
fn main() {
  let n = 42
  let m = n + 1
}
`);
  const top = fnNamed(module, 'main');
  const drops = allInstrs(top).filter((i) => i.op === 'drop');
  assert.deepEqual(drops, [], 'Copy values need no drop');
});

test('drops run before an early return', () => {
  const module = mir(`
fn early(flag: Bool) -> Int {
  let xs = [1, 2]
  if flag {
    return 0
  }
  return len(xs)
}

fn main() {
  let x = early(true)
}
`);
  const early = fnNamed(module, 'early');
  const returnBlocks = early.blocks.filter((b) => b.terminator.op === 'return');
  // At least one return path must drop xs before returning.
  const withDrop = returnBlocks.filter((b) => b.instrs.some((i) => i.op === 'drop'));
  assert.ok(withDrop.length >= 1, `a return path should drop xs:\n${formatFunction(early)}`);
});

test('monomorphization logs a second instantiation', () => {
  const module = mir(`
fn double(x) {
  return x
}

fn main() uses io {
  print(double(1))
  print(double("text"))
}
`);
  // The two call sites have different argument types, so a specialised symbol
  // must exist for the second one.
  assert.ok(module.instantiations.length >= 1, JSON.stringify(module.instantiations));
  const inst = module.instantiations[0];
  assert.equal(inst.from, 'double');
  assert.notEqual(inst.symbol, 'double');
});

test('game metadata survives into MIR', () => {
  const module = mir(`
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
  assert.deepEqual(game.reels[0].symbols, ['A', 'B', 'C']);
  const rtp = game.fields.find((f) => f.name === 'rtp');
  assert.equal(rtp.value.value, 96.5);
  // Methods are owner-qualified in HIR, which is what keeps two games with the
  // same method name apart after lowering.
  assert.deepEqual(game.methods, ['Lucky.spin'], JSON.stringify(game.methods));
});

test('effects are carried on call instructions', () => {
  const module = mir(`
fn roll() -> Int uses rand {
  return 4
}

fn main() uses rand, io {
  print(roll())
}
`);
  const main = fnNamed(module, 'main');
  assert.deepEqual(main.effects.sort(), ['io', 'rand']);
  const roll = fnNamed(module, 'roll');
  assert.deepEqual(roll.effects, ['rand']);
});

test('the verifier rejects hand-broken IR', () => {
  const module = mir(`
fn f(a: Int) -> Int {
  return a + 1
}

fn main() {
  let x = f(1)
}
`);
  const fn = fnNamed(module, 'f');
  // Duplicate a definition to violate SSA.
  const clone = structuredClone(fn);
  clone.types = fn.types;
  const first = clone.blocks[0].instrs.find((i) => destOf(i) !== null);
  clone.blocks[0].instrs.push(structuredClone(first));
  const errors = verifyFunction(clone);
  assert.ok(errors.some((e) => /assigned more than once/.test(e.message)), JSON.stringify(errors));
});

test('every function is fully terminated', () => {
  const module = mir(`
fn maybe(flag: Bool) -> Int {
  if flag {
    return 1
  } else {
    return 2
  }
}

fn main() {
  let x = maybe(false)
}
`);
  for (const fn of module.functions) {
    for (const block of fn.blocks) {
      // An empty unreachable block is acceptable; a non-empty one is not.
      if (block.terminator.op === 'unreachable') {
        assert.equal(block.instrs.length, 0, `bb${block.id} in ${fn.symbol} has code but no terminator`);
      }
    }
  }
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
