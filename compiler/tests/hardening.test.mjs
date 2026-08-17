#!/usr/bin/env node
import assert from 'node:assert/strict';
import { tokenize } from '../dist/lexer/lexer.js';
import { parse, parseRecovering } from '../dist/parser/parser.js';
import { checkProgram } from '../dist/checker/checker.js';
import { Interpreter } from '../dist/interpreter/interpreter.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL  ${name}`); console.error(error instanceof Error ? error.stack ?? error.message : String(error)); }
}
function compile(source, file = '<hardening>') {
  const tokens = tokenize(source, file);
  const program = parse(tokens);
  const checked = checkProgram(program);
  assert.equal(checked.errors.length, 0, checked.errors.map((e) => e.message).join('\n'));
  return program;
}

test('parser recovery reports independent syntax errors in one pass', () => {
  const source = `
let broken =
let alsoBroken =
fn ok() {
  return 7
}
`;
  const recovered = parseRecovering(tokenize(source, 'recovery.sun'));
  assert.equal(recovered.errors.length, 2);
  assert.equal(recovered.errors.every((error) => error.code === 'E0201'), true);
  assert.equal(recovered.program.body.some((stmt) => stmt.kind === 'FnDecl'), true);
});

test('empty input and unicode remain valid and do not throw', () => {
  const empty = compile('');
  assert.equal(empty.body.length, 0);
  const output = [];
  new Interpreter({ stdout: (line) => output.push(line) }).run(compile(`
fn main() uses io {
  print("Sunra ☀️ ภาษาไทย")
}
`));
  assert.match(output[0], /Sunra/);
  assert.match(output[0], /ภาษาไทย/);
});

test('max call depth fails with a controlled runtime diagnostic', () => {
  const program = compile(`
fn recurse(x) {
  return recurse(x + 1)
}
fn main() {
  recurse(0)
}
`);
  assert.throws(() => new Interpreter({ maxCallDepth: 8, stepLimit: 10_000 }).run(program), /call depth limit of 8 exceeded/);
});

test('output buffer is bounded and emits a single truncation marker', () => {
  const program = compile(`
fn main() uses io {
  print("0123456789")
  print("abcdefghij")
  print("klmnopqrst")
}
`);
  const output = [];
  const result = new Interpreter({ maxOutputLines: 10, maxOutputBytes: 22, stdout: (line) => output.push(line) }).run(program);
  assert.equal(result.output.length, 2);
  assert.equal(result.output.filter((line) => line.startsWith('[output truncated')).length, 1);
  assert.equal(output.at(-1), '[output truncated]');
  assert.equal(output.length, 3);
});

test('step limit remains a deterministic guard for runaway loops', () => {
  const program = compile(`
fn main() {
  while true {
  }
}
`);
  assert.throws(() => new Interpreter({ stepLimit: 32 }).run(program), /step limit of 32 exceeded/);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
