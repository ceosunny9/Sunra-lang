#!/usr/bin/env node
/**
 * SunVM and WASM-contract backend tests.
 *
 * The SunVM tests do the strongest check available: run the same program through
 * the tree-walking interpreter and through the bytecode VM, and require identical
 * output. Anything else (encode/decode round-trip, sandbox limits, hot reload)
 * is checked directly.
 *
 * The contract tests validate the emitted WebAssembly with the host's own
 * `WebAssembly.validate`, which is a real validator, not an approximation.
 */
import assert from 'node:assert/strict';
import { tokenize } from '../dist/lexer/lexer.js';
import { parse } from '../dist/parser/parser.js';
import { checkProgram } from '../dist/checker/checker.js';
import { lowerToHir } from '../dist/hir/lower.js';
import { inferOwnership } from '../dist/own/ownership.js';
import { buildMir } from '../dist/mir/build.js';
import { verifyModule } from '../dist/mir/verify.js';
import { optimize } from '../dist/opt/optimize.js';
import { compileToSunVm, decodeProgram, encodeProgram, Op } from '../dist/backend/sunvm.js';
import { SunVmRuntime, SunVmTrap, DEFAULT_LIMITS } from '../dist/backend/sunvm_run.js';
import { emitContract, CHAIN_ABI_IMPORTS } from '../dist/backend/wasm_contract.js';
import { Interpreter } from '../dist/interpreter/interpreter.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL  ${name}`); console.error(error instanceof Error ? error.stack ?? error.message : String(error)); }
}

function mirOf(source, { opt = false } = {}) {
  const program = parse(tokenize(source, 'vm.sun'));
  const checked = checkProgram(program);
  assert.equal(checked.errors.length, 0, checked.errors.map((e) => e.message).join('\n'));
  const hir = lowerToHir(program, 'vm.sun');
  let module = buildMir(hir, inferOwnership(hir));
  assert.deepEqual(verifyModule(module), []);
  if (opt) module = optimize(module, {}).module;
  return module;
}

/** Run through the interpreter, collecting printed output. */
function interpret(source) {
  const program = parse(tokenize(source, 'vm.sun'));
  checkProgram(program);
  const output = [];
  const interp = new Interpreter({ stdout: (line) => output.push(line) });
  interp.run(program);
  return output;
}

/** Run through SunVM, collecting printed output. */
function runVm(source, { limits } = {}) {
  const { program, bytes, rejected } = compileToSunVm(mirOf(source));
  assert.deepEqual(rejected, [], JSON.stringify(rejected));
  const runtime = new SunVmRuntime(limits ?? DEFAULT_LIMITS);
  runtime.load(bytes);
  return runtime.run('main');
}

// -------------------------------------------------------------- SunVM

test('SunVM: bytecode round-trips through encode/decode', () => {
  const { program, bytes } = compileToSunVm(mirOf(`
fn add(a: Int, b: Int) -> Int {
  return a + b
}

fn main() uses io {
  print(add(2, 3))
}
`));
  const decoded = decodeProgram(bytes);
  assert.equal(decoded.version, program.version);
  assert.equal(decoded.functions.length, program.functions.length);
  assert.equal(decoded.digest, program.digest);
  // Re-encoding the decoded program must produce identical bytes.
  const reencoded = encodeProgram({ ...decoded, digest: '' });
  assert.deepEqual(Array.from(reencoded), Array.from(bytes));
});

test('SunVM: rejects a module with the wrong magic', () => {
  assert.throws(() => decodeProgram(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not a SunVM module/);
});

test('SunVM: arithmetic matches the interpreter', () => {
  const source = `
fn main() uses io {
  print(2 + 3 * 4)
  print(10 - 4)
  print(7 % 3)
}
`;
  assert.deepEqual(runVm(source).output, interpret(source));
});

test('SunVM: function calls match the interpreter', () => {
  const source = `
fn square(n: Int) -> Int {
  return n * n
}

fn main() uses io {
  print(square(7))
  print(square(square(2)))
}
`;
  assert.deepEqual(runVm(source).output, interpret(source));
});

test('SunVM: loops and phis match the interpreter', () => {
  const source = `
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
  print(total(10))
  print(total(0))
}
`;
  assert.deepEqual(runVm(source).output, interpret(source));
});

test('SunVM: branches match the interpreter', () => {
  const source = `
fn classify(n: Int) -> Int {
  if n > 10 {
    return 2
  }
  if n > 5 {
    return 1
  }
  return 0
}

fn main() uses io {
  print(classify(20))
  print(classify(7))
  print(classify(1))
}
`;
  assert.deepEqual(runVm(source).output, interpret(source));
});

test('SunVM: recursion matches the interpreter', () => {
  const source = `
fn fib(n: Int) -> Int {
  if n < 2 {
    return n
  }
  return fib(n - 1) + fib(n - 2)
}

fn main() uses io {
  print(fib(12))
}
`;
  assert.deepEqual(runVm(source).output, interpret(source));
});

test('SunVM: lists and indexing match the interpreter', () => {
  const source = `
fn main() uses io {
  let xs = [10, 20, 30]
  print(len(xs))
  print(xs[0])
  print(xs[2])
}
`;
  assert.deepEqual(runVm(source).output, interpret(source));
});

test('SunVM: strings and concatenation match the interpreter', () => {
  const source = `
fn main() uses io {
  let greeting = "Hello, " + "Sunra!"
  print(greeting)
}
`;
  assert.deepEqual(runVm(source).output, interpret(source));
});

test('SunVM: division by zero traps instead of returning Infinity', () => {
  const { bytes } = compileToSunVm(mirOf(`
fn divide(a: Int, b: Int) -> Int {
  return a / b
}

fn main() uses io {
  print(divide(1, 0))
}
`));
  const runtime = new SunVmRuntime();
  runtime.load(bytes);
  assert.throws(() => runtime.run('main'), (error) => {
    assert.ok(error instanceof SunVmTrap, `expected a trap, got ${error}`);
    assert.match(error.message, /division by zero/);
    return true;
  });
});

test('SunVM: out-of-bounds indexing traps', () => {
  // The index must not be a compile-time constant the refiner could fold, so it
  // arrives through a parameter.
  const { bytes } = compileToSunVm(mirOf(`
fn get(xs: [Int], i: Int) -> Int {
  return xs[i]
}

fn main() uses io {
  let data = [1, 2]
  print(get(data, 5))
}
`));
  const runtime = new SunVmRuntime();
  runtime.load(bytes);
  assert.throws(() => runtime.run('main'), /out of bounds/);
});

test('SunVM: the step limit stops an infinite loop', () => {
  const { bytes } = compileToSunVm(mirOf(`
fn spin() -> Int {
  var i = 0
  while true {
    i = i + 1
  }
  return i
}

fn main() uses io {
  print(spin())
}
`));
  const runtime = new SunVmRuntime({ ...DEFAULT_LIMITS, maxSteps: 5000 });
  runtime.load(bytes);
  assert.throws(() => runtime.run('main'), /step limit exceeded/);
});

test('SunVM: the call-depth limit stops runaway recursion', () => {
  const { bytes } = compileToSunVm(mirOf(`
fn down(n: Int) -> Int {
  return down(n + 1)
}

fn main() uses io {
  print(down(0))
}
`));
  const runtime = new SunVmRuntime({ ...DEFAULT_LIMITS, maxCallDepth: 32 });
  runtime.load(bytes);
  assert.throws(() => runtime.run('main'), /call depth limit exceeded/);
});

test('SunVM: the allocation limit stops list spam', () => {
  const { bytes } = compileToSunVm(mirOf(`
fn churn(n: Int) -> Int {
  var i = 0
  while i < n {
    let scratch = [1, 2, 3]
    i = i + 1
  }
  return i
}

fn main() uses io {
  print(churn(1000))
}
`));
  const runtime = new SunVmRuntime({ ...DEFAULT_LIMITS, maxAllocations: 10 });
  runtime.load(bytes);
  assert.throws(() => runtime.run('main'), /allocation limit exceeded/);
});

test('SunVM: the RGS profile rejects host imports outside the whitelist', () => {
  const result = compileToSunVm(mirOf(`
fn main() uses net {
  let handle = Net.websocketConnect("ws://example.com")
}
`), { profile: 'rgs' });
  assert.ok(result.rejected.length >= 1, JSON.stringify(result.rejected));
  assert.match(result.rejected[0].reason, /not permitted by the RGS profile/);
});

test('SunVM: the open profile allows any host import', () => {
  const result = compileToSunVm(mirOf(`
fn main() uses net {
  let handle = Net.websocketConnect("ws://example.com")
}
`), { profile: 'open' });
  assert.deepEqual(result.rejected, []);
});

test('SunVM: unbound host imports are reported before execution', () => {
  const { bytes } = compileToSunVm(mirOf(`
fn main() uses rand {
  let n = rng.next()
}
`), { profile: 'open' });
  const runtime = new SunVmRuntime();
  runtime.load(bytes);
  const missing = runtime.missingImports();
  assert.ok(missing.length >= 1, 'rng.next should be unbound by default');
  assert.throws(() => runtime.run('main'), /unbound host imports/);
});

test('SunVM: a bound host import is callable', () => {
  const { bytes } = compileToSunVm(mirOf(`
fn main() uses rand, io {
  print(rng.next())
}
`), { profile: 'open' });
  const runtime = new SunVmRuntime();
  runtime.load(bytes);
  for (const name of runtime.missingImports()) {
    runtime.bind(name, () => 42);
  }
  const result = runtime.run('main');
  assert.deepEqual(result.output, ['42']);
});

test('SunVM: hot reload swaps code and reports the change', () => {
  const first = compileToSunVm(mirOf(`
fn main() uses io {
  print(1)
}
`)).bytes;
  const second = compileToSunVm(mirOf(`
fn main() uses io {
  print(2)
}
`)).bytes;

  const runtime = new SunVmRuntime();
  const load1 = runtime.load(first);
  assert.equal(load1.changed, true);
  assert.deepEqual(runtime.run('main').output, ['1']);

  // Reloading identical bytes is a no-op, so a server can redeploy safely.
  const reload = runtime.load(first);
  assert.equal(reload.changed, false);
  assert.equal(runtime.reloads, 1);

  const load2 = runtime.load(second);
  assert.equal(load2.changed, true);
  assert.equal(runtime.reloads, 2);
  assert.deepEqual(runtime.run('main').output, ['2']);
});

test('SunVM: host bindings survive a hot reload', () => {
  const runtime = new SunVmRuntime();
  runtime.bind('rng.next', () => 7);

  const v1 = compileToSunVm(mirOf(`
fn main() uses rand, io {
  print(rng.next())
}
`), { profile: 'open' }).bytes;
  runtime.load(v1);
  assert.deepEqual(runtime.run('main').output, ['7']);

  const v2 = compileToSunVm(mirOf(`
fn main() uses rand, io {
  print(rng.next() + 1)
}
`), { profile: 'open' }).bytes;
  runtime.load(v2);
  // The binding was not re-registered, proving it survived the swap.
  assert.deepEqual(runtime.run('main').output, ['8']);
});

test('SunVM: drops release the register', () => {
  const { program } = compileToSunVm(mirOf(`
fn main() uses io {
  let xs = [1, 2]
  print(len(xs))
}
`));
  const main = program.functions.find((f) => f.name === 'main');
  assert.ok(main.code.some((i) => i.op === Op.Drop), 'expected a Drop opcode');
});

test('SunVM: optimised and unoptimised modules produce the same output', () => {
  const source = `
fn payout(bet: Int, mult: Int) -> Int {
  return bet * mult
}

fn main() uses io {
  let reels = [1, 2, 3]
  print(payout(10, 3))
  print(len(reels))
}
`;
  const plain = compileToSunVm(mirOf(source, { opt: false }));
  const optimised = compileToSunVm(mirOf(source, { opt: true }));

  const runPlain = new SunVmRuntime();
  runPlain.load(plain.bytes);
  const runOpt = new SunVmRuntime();
  runOpt.load(optimised.bytes);

  assert.deepEqual(runOpt.run('main').output, runPlain.run('main').output);
});

// ----------------------------------------------------- WASM contract

const CONTRACT = `
fn payout(bet: Int, multiplier: Int) -> Int {
  return bet * multiplier
}

fn settle(stake: Int) -> Int {
  return payout(stake, 2)
}

fn main() {
}
`;

test('contract: emits a module the host WebAssembly validator accepts', () => {
  const out = emitContract(mirOf(CONTRACT), { name: 'slots' });
  assert.deepEqual(out.rejected, [], JSON.stringify(out.rejected, null, 1));
  assert.equal(
    WebAssembly.validate(out.wasm),
    true,
    'emitted contract must pass WebAssembly validation',
  );
});

test('contract: the module can actually be instantiated with the chain ABI', async () => {
  const out = emitContract(mirOf(CONTRACT), { name: 'slots' });
  const chain = {};
  for (const imp of CHAIN_ABI_IMPORTS) {
    chain[imp.name] = () => 0n;
  }
  const instance = await WebAssembly.instantiate(out.wasm, { chain });
  assert.ok(instance.instance.exports.memory, 'memory must be exported');
  assert.equal(typeof instance.instance.exports.payout, 'function');
});

test('contract: header, magic and version are correct', () => {
  const out = emitContract(mirOf(CONTRACT));
  assert.deepEqual(Array.from(out.wasm.slice(0, 8)), [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
});

test('contract: floats are rejected as non-deterministic', () => {
  const out = emitContract(mirOf(`
fn rate(x: Float) -> Float {
  return x * 1.5
}

fn main() {
}
`));
  assert.ok(out.rejected.some((r) => /floating point/.test(r.reason)), JSON.stringify(out.rejected));
  assert.equal(out.manifest.deterministic, false);
});

test('contract: network access is rejected as non-deterministic', () => {
  const out = emitContract(mirOf(`
fn fetch() uses net {
  let socket = Net.websocketConnect("ws://example.com")
}

fn main() {
}
`));
  assert.ok(
    out.rejected.some((r) => /Net\.websocketConnect/.test(r.reason) && /deterministic/.test(r.reason)),
    JSON.stringify(out.rejected),
  );
  assert.equal(out.manifest.deterministic, false);
});

test('contract: host randomness is rejected in favour of committed seeds', () => {
  const out = emitContract(mirOf(`
fn roll() -> Int uses rand {
  return rng.next()
}

fn main() {
}
`));
  assert.ok(
    out.rejected.some((r) => /committed_seed/.test(r.reason)),
    JSON.stringify(out.rejected),
  );
});

test('contract: only chain ABI imports are declared', () => {
  const out = emitContract(mirOf(CONTRACT));
  for (const imp of out.manifest.imports) {
    assert.equal(imp.module, 'chain', `unexpected import module ${imp.module}`);
  }
  assert.equal(out.manifest.imports.length, CHAIN_ABI_IMPORTS.length);
});

test('contract: gas estimates scale with function size', () => {
  const out = emitContract(mirOf(`
fn small(a: Int) -> Int {
  return a + 1
}

fn big(a: Int) -> Int {
  var total = a
  total = total + 1
  total = total + 2
  total = total + 3
  total = total + 4
  total = total + 5
  return total
}

fn main() {
}
`));
  const small = out.manifest.gasEstimates['small'];
  const big = out.manifest.gasEstimates['big'];
  assert.ok(small > 0 && big > small, `expected big (${big}) > small (${small})`);
});

test('contract: a custom gas schedule changes the estimate', () => {
  const module = mirOf(CONTRACT);
  const cheap = emitContract(module, { gasSchedule: { arithmetic: 1 } });
  const pricey = emitContract(module, { gasSchedule: { arithmetic: 100 } });
  assert.ok(
    pricey.manifest.gasEstimates['payout'] > cheap.manifest.gasEstimates['payout'],
    'gas schedule must affect the estimate',
  );
});

test('contract: manifest lists every compiled function as an export', () => {
  const out = emitContract(mirOf(CONTRACT));
  const names = out.manifest.exports.map((e) => e.name).sort();
  assert.deepEqual(names, ['main', 'payout', 'settle']);
  assert.deepEqual(out.compiled.sort(), ['main', 'payout', 'settle']);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
