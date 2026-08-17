import assert from 'node:assert/strict';
import { tokenize } from '../dist/lexer/lexer.js';
import { parse } from '../dist/parser/parser.js';
import { checkProgram } from '../dist/checker/checker.js';
import { lowerToHir } from '../dist/hir/lower.js';
import { inferOwnership } from '../dist/own/ownership.js';
import { buildMir } from '../dist/mir/build.js';
import { compileToSunVm } from '../dist/backend/sunvm.js';
import { SunVmRuntime, DEFAULT_LIMITS } from '../dist/backend/sunvm_run.js';
import { Interpreter } from '../dist/interpreter/interpreter.js';

function mirOf(source) {
  const program = parse(tokenize(source, 'deep-runtime.sun'));
  const checked = checkProgram(program);
  assert.equal(checked.errors.length, 0, checked.errors.map((e) => e.message).join('\n'));
  const hir = lowerToHir(program, 'deep-runtime.sun');
  return buildMir(hir, inferOwnership(hir));
}

function runVm(source, entry, args) {
  const { bytes, rejected } = compileToSunVm(mirOf(source));
  assert.deepEqual(rejected, []);
  const runtime = new SunVmRuntime(DEFAULT_LIMITS);
  runtime.load(bytes);
  return runtime.run(entry, args).value;
}

function runInterpreter(source, entry, args) {
  const program = parse(tokenize(source, 'deep-runtime.sun'));
  const checked = checkProgram(program);
  assert.equal(checked.errors.length, 0, checked.errors.map((e) => e.message).join('\n'));
  const interpreter = new Interpreter({ stdout: () => {} });
  interpreter.run(program);
  const fn = interpreter.globalEnv.get(entry);
  assert.ok(fn, `missing function ${entry}`);
  return interpreter.callValue(fn, args, null);
}

function fairBegin(seed) {
  const interpreter = new Interpreter({ seed, stdout: () => {} });
  const fair = interpreter.globalEnv.get('Fair');
  assert.equal(fair?.t, 'namespace');
  const begin = fair.members.get('begin');
  const ceremony = interpreter.callValue(begin, [], null);
  return {
    serverSeed: ceremony.v.get('serverSeed').v,
    clientSeed: ceremony.v.get('clientSeed').v,
    commitment: ceremony.v.get('commitment').v,
  };
}

const source = `
fn t1_swap(x: Int, y: Int) -> Int {
  var a = x
  var b = y
  let t = b
  b = a
  a = t
  return a
}

fn t4_gcd(a: Int, b: Int) -> Int {
  var x = a
  var y = b
  while y != 0 {
    let t = y
    y = x % y
    x = t
  }
  return x
}

fn quotient() -> Int {
  return 7 / 2
}
`;

assert.equal(runInterpreter(source, 't1_swap', [{ t: 'int', v: 5 }, { t: 'int', v: 9 }]).v, 9);
assert.equal(runVm(source, 't1_swap', [5, 9]), 9);
assert.equal(runInterpreter(source, 't4_gcd', [{ t: 'int', v: 1071 }, { t: 'int', v: 462 }]).v, 21);
assert.equal(runVm(source, 't4_gcd', [1071, 462]), 21);
assert.equal(runInterpreter(source, 'quotient', []).v, 3);
assert.equal(runVm(source, 'quotient', []), 3);
assert.deepEqual(fairBegin('deep-seed'), fairBegin('deep-seed'));
assert.notDeepEqual(fairBegin('deep-seed'), fairBegin('different-seed'));
console.log('deep runtime reproduction passed');
