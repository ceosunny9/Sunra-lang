#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tokenize } from '../dist/lexer/lexer.js';
import { parse } from '../dist/parser/parser.js';
import { checkProgram } from '../dist/checker/checker.js';
import { Interpreter } from '../dist/interpreter/interpreter.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL  ${name}`); console.error(error instanceof Error ? error.stack ?? error.message : String(error)); }
}

test('self-hosted lexer source parses and type-checks successfully', () => {
  const source = readFileSync('./selfhost/lexer.sun', 'utf8');
  const program = parse(tokenize(source, 'selfhost/lexer.sun'));
  const checked = checkProgram(program);
  assert.equal(checked.errors.length, 0, checked.errors.map((e) => e.message).join('\n'));
});

test('self-hosted lexer runs and tokenizes Sunra source code correctly', () => {
  const source = readFileSync('./selfhost/lexer.sun', 'utf8');
  const program = parse(tokenize(source, 'selfhost/lexer.sun'));
  const output = [];
  const interpreter = new Interpreter({ stdout: (line) => output.push(line) });
  const res = interpreter.run(program);
  assert.match(output[0], /Self-hosted lexer tokens: 2/);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
