#!/usr/bin/env node
/**
 * LLVM and Cranelift backend tests.
 *
 * We cannot run `llc` or `clif-util` in this sandbox, so the tests assert the
 * properties a real assembler would enforce: correct triples and data layouts,
 * every SSA value defined before use, phis translated the way each IR expects
 * (LLVM keeps `phi`, CLIF turns them into block parameters), and the optimiser's
 * annotations actually changing the emitted call.
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
import { emitLlvm } from '../dist/backend/llvm.js';
import { emitCranelift } from '../dist/backend/cranelift.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL  ${name}`); console.error(error instanceof Error ? error.stack ?? error.message : String(error)); }
}

function mirOf(source, { opt = true } = {}) {
  const program = parse(tokenize(source, 'native.sun'));
  const checked = checkProgram(program);
  assert.equal(checked.errors.length, 0, checked.errors.map((e) => e.message).join('\n'));
  const hir = lowerToHir(program, 'native.sun');
  const own = inferOwnership(hir);
  const refine = refineModule(hir);
  let module = buildMir(hir, own);
  assert.deepEqual(verifyModule(module), []);
  if (opt) module = optimize(module, { refine }).module;
  return module;
}

const SLOT = `
fn payout(bet: Int, multiplier: Int) -> Int {
  return bet * multiplier
}

fn total(n: Int) -> Int {
  var sum = 0
  var i = 0
  while i < n {
    sum = sum + i
    i = i + 1
  }
  return sum
}

fn main() uses io {
  let reels = [1, 2, 3]
  print(payout(10, 3))
  print(total(5))
  print(len(reels))
}
`;

// ------------------------------------------------------------------ LLVM

test('LLVM: module header carries triple and data layout', () => {
  const ir = emitLlvm(mirOf(SLOT), { target: 'x86_64' });
  assert.match(ir.ir, /target triple = "x86_64-unknown-linux-gnu"/);
  assert.match(ir.ir, /target datalayout = "e-m:e-/);
  assert.equal(ir.target, 'x86_64');
});

test('LLVM: aarch64 uses a different triple and layout', () => {
  const x86 = emitLlvm(mirOf(SLOT), { target: 'x86_64' });
  const arm = emitLlvm(mirOf(SLOT), { target: 'aarch64' });
  assert.match(arm.ir, /aarch64-unknown-linux-gnu/);
  assert.notEqual(arm.dataLayout, x86.dataLayout, 'layouts must differ per target');
});

test('LLVM: every function is defined and terminated', () => {
  const out = emitLlvm(mirOf(SLOT));
  const defines = out.ir.match(/^define /gm) ?? [];
  const closes = out.ir.match(/^\}$/gm) ?? [];
  assert.equal(defines.length, closes.length, 'unbalanced function bodies');
  assert.ok(defines.length >= 3, `expected payout/total/main:\n${out.ir}`);
  assert.deepEqual(out.skipped, [], JSON.stringify(out.skipped));
});

test('LLVM: types map as documented', () => {
  const out = emitLlvm(mirOf(`
fn f(a: Int, b: Float, c: Bool) -> Int {
  return a
}

fn main() {
  let x = f(1, 2.0, true)
}
`));
  // Values are emitted as *named* temporaries (`%v0`). LLVM requires its unnamed
  // temporaries (`%0`) to be numbered consecutively from the parameter count, and
  // MIR ids are sparse after dead-code elimination — `main` could legitimately
  // start at `%2`, which `llvm-as` rejects. Named values carry no such rule.
  assert.match(out.ir, /define i64 @f\(i64 %v\d+, double %v\d+, i1 %v\d+\)/);
});

test('LLVM: loops emit a phi with one entry per predecessor', () => {
  const out = emitLlvm(mirOf(`
fn count(n: Int) -> Int {
  var i = 0
  while i < n {
    i = i + 1
  }
  return i
}

fn main() uses io {
  print(count(3))
}
`, { opt: false }));
  const phis = out.ir.match(/= phi i64 .*/g) ?? [];
  assert.ok(phis.length >= 1, `expected a phi:\n${out.ir}`);
  // Every phi operand must reference a block label.
  for (const phi of phis) {
    const entries = phi.match(/\[ %[\w.]+, %bb\d+ \]/g) ?? [];
    assert.ok(entries.length >= 2, `phi needs >=2 incoming values: ${phi}`);
  }
});

test('LLVM: branches reference existing labels only', () => {
  const out = emitLlvm(mirOf(SLOT, { opt: false }));
  for (const body of out.ir.split(/^define /m).slice(1)) {
    const labels = new Set((body.match(/^bb(\d+):/gm) ?? []).map((l) => l.replace(':', '')));
    for (const target of body.match(/label %bb\d+/g) ?? []) {
      const name = target.replace('label %', '');
      assert.ok(labels.has(name), `branch to missing label ${name}`);
    }
  }
});

test('LLVM: every used SSA value is defined in the same function', () => {
  const out = emitLlvm(mirOf(SLOT, { opt: false }));
  for (const body of out.ir.split(/^define /m).slice(1)) {
    const defined = new Set();
    // Parameters.
    const header = body.slice(0, body.indexOf(')'));
    for (const p of header.match(/%v\d+/g) ?? []) defined.add(p);
    // Assignments.
    for (const d of body.match(/^\s*(%v\d+) =/gm) ?? []) {
      defined.add(d.trim().split(' ')[0]);
    }
    for (const use of body.match(/%v\d+/g) ?? []) {
      assert.ok(defined.has(use), `use of undefined ${use} in:\n${body.slice(0, 400)}`);
    }
  }
});

test('LLVM: elided bounds checks call the unchecked accessor', () => {
  const source = `
fn main() uses io {
  let xs = [10, 20, 30]
  print(xs[1])
}
`;
  const optimised = emitLlvm(mirOf(source, { opt: true }));
  const plain = emitLlvm(mirOf(source, { opt: false }));
  assert.match(plain.ir, /@sunra_list_get_checked/);
  assert.match(optimised.ir, /@sunra_list_get\(/);
});

test('LLVM: arena-promoted lists use the arena allocator', () => {
  const out = emitLlvm(mirOf(`
fn main() {
  let scratch = [1, 2, 3]
}
`, { opt: true }));
  assert.match(out.ir, /@sunra_arena_alloc/);
});

test('LLVM: drops become explicit release calls', () => {
  const out = emitLlvm(mirOf(`
fn main() uses io {
  let xs = [1, 2]
  print(len(xs))
}
`, { opt: false }));
  assert.match(out.ir, /call void @sunra_release/);
});

test('LLVM: string constants are NUL-terminated globals', () => {
  const out = emitLlvm(mirOf(`
fn main() uses io {
  print("hello")
}
`, { opt: false }));
  assert.match(out.ir, /@\.str\.0 = private unnamed_addr constant \[6 x i8\] c"hello\\00", align 1/);
});

test('LLVM: no_panic functions are marked nounwind', () => {
  const out = emitLlvm(mirOf(`
#[no_panic]
fn safe(a: Int) -> Int {
  return a + 1
}

fn main() uses io {
  print(safe(1))
}
`, { opt: false }));
  assert.match(out.ir, /define i64 @safe\([^)]*\) nounwind/);
});

// ------------------------------------------------------------- Cranelift

test('Cranelift: emits a target line and function definitions', () => {
  const out = emitCranelift(mirOf(SLOT));
  assert.match(out.clif, /^target x86_64$/m);
  assert.ok(out.functions.length >= 3, JSON.stringify(out.functions));
  assert.deepEqual(out.skipped, []);
});

test('Cranelift: phis become block parameters, not phi instructions', () => {
  const out = emitCranelift(mirOf(`
fn count(n: Int) -> Int {
  var i = 0
  while i < n {
    i = i + 1
  }
  return i
}

fn main() uses io {
  print(count(3))
}
`, { opt: false }));
  assert.ok(!/\bphi\b/.test(out.clif), 'CLIF has no phi instruction');
  assert.match(out.clif, /^block\d+\(v\d+: i64\):/m, `expected a parameterised block:\n${out.clif}`);
});

test('Cranelift: jumps to parameterised blocks pass arguments', () => {
  const out = emitCranelift(mirOf(`
fn pick(flag: Bool, a: Int, b: Int) -> Int {
  var r = a
  if flag {
    r = b
  }
  return r
}

fn main() uses io {
  print(pick(true, 1, 2))
}
`, { opt: false }));
  // Find blocks that take parameters, then confirm each jump to them has args.
  const paramBlocks = [...out.clif.matchAll(/^block(\d+)\(/gm)].map((m) => m[1]);
  assert.ok(paramBlocks.length >= 1, `expected parameterised blocks:\n${out.clif}`);
  for (const id of paramBlocks) {
    const jumps = [...out.clif.matchAll(new RegExp(`jump block${id}(\\(([^)]*)\\))?`, 'g'))];
    for (const jump of jumps) {
      assert.ok(jump[1], `jump to block${id} must pass block arguments: ${jump[0]}`);
    }
  }
});

test('Cranelift: JIT mode is recorded in the preamble', () => {
  const out = emitCranelift(mirOf(SLOT), { jit: true, optLevel: 'speed' });
  assert.equal(out.jit, true);
  assert.match(out.clif, /opt_level = speed, jit = true/);
});

test('Cranelift: runtime signatures are declared before use', () => {
  const out = emitCranelift(mirOf(`
fn main() uses io {
  let xs = [1, 2]
  print(len(xs))
}
`, { opt: false }));
  // Any fn_x referenced must have a matching declaration in the same function.
  for (const body of out.clif.split(/^function /m).slice(1)) {
    const declared = new Set((body.match(/fn_(\w+) = %/g) ?? []).map((d) => d.split(' ')[0]));
    for (const used of body.match(/call (fn_\w+)/g) ?? []) {
      const name = used.replace('call ', '');
      assert.ok(declared.has(name), `${name} used without declaration in:\n${body.slice(0, 400)}`);
    }
  }
});

test('Cranelift: types map to i64/f64/i8/r64', () => {
  const out = emitCranelift(mirOf(`
fn f(a: Int, b: Float, c: Bool) -> Int {
  return a
}

fn main() {
  let x = f(1, 2.0, true)
}
`, { opt: false }));
  assert.match(out.clif, /function %f\(v\d+: i64, v\d+: f64, v\d+: i8\) -> i64/);
});

test('Cranelift: unit-returning functions still return a slot value', () => {
  // Sunra's unit is a real i64 zero in CLIF (`clifType(Unit) = i64`), because a
  // caller that binds the result still needs a value to name. This pins that
  // decision rather than pretending CLIF drops the return.
  const out = emitCranelift(mirOf(`
fn nothing() {
}

fn main() {
  nothing()
}
`, { opt: false }));
  assert.match(out.clif, /function %nothing\(\) -> i64 \{/);
  assert.match(out.clif, /return v\d+/);
});

test('both backends agree on which functions they lower', () => {
  const module = mirOf(SLOT);
  const llvm = emitLlvm(module);
  const clif = emitCranelift(module);
  assert.deepEqual(llvm.functions.sort(), clif.functions.sort());
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
