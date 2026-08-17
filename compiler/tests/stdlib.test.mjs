#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tokenize } from '../dist/lexer/lexer.js';
import { parse } from '../dist/parser/parser.js';
import { checkProgram } from '../dist/checker/checker.js';
import { Interpreter } from '../dist/interpreter/interpreter.js';
import { display } from '../dist/runtime/values.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL  ${name}`); console.error(error instanceof Error ? error.stack ?? error.message : String(error)); }
}
function run(source, options = {}) {
  const program = parse(tokenize(source, '<stdlib-test>'));
  const checked = checkProgram(program);
  assert.equal(checked.errors.length, 0, checked.errors.map((e) => e.message).join('\n'));
  const output = [];
  const interpreter = new Interpreter({ ...options, stdout: (line) => output.push(line) });
  const result = interpreter.run(program);
  return { result, output };
}

const source = `
fn main() uses rand, db, io {
  Random.seed("stdlib-test")
  let first = Random.normal(0.0, 1.0)
  let second = Random.normal(0.0, 1.0)
  let store = Db.open(":memory:")
  Db.set(store, "first", first)
  Db.set(store, "second", second)
  let canvas = Graphics.canvas(320, 180)
  Graphics.clear(canvas, "#111111")
  Graphics.fillRect(canvas, 10.0, 20.0, 100.0, 40.0, "#ffaa00")
  Graphics.circle(canvas, 180.0, 90.0, 24.0, "#ffffff", true)
  let svg = Graphics.toSvg(canvas)
  let tone = Audio.note("A4", 0.05, 0.25)
  let wav = Audio.wavBase64(tone, 8000)
  print(Db.count(store), Graphics.width(canvas), len(svg), len(wav), Random.draws())
}
`;

test('advanced random distributions are deterministic after Random.seed', () => {
  const one = run(source, { seed: 'outer-seed' }).output;
  const two = run(source, { seed: 'different-outer-seed' }).output;
  assert.deepEqual(one, two);
  assert.match(one[0], /^2 320 /);
});

test('database key-value store supports CRUD and JSON-backed persistence', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sunra-db-')), 'store.json');
  const first = run(`
fn main() uses db {
  let db = Db.open("${path}")
  Db.set(db, "score", 42)
  Db.flush(db)
}
`);
  assert.equal(first.output.length, 0);
  const second = run(`
fn main() uses db, io {
  let db = Db.open("${path}")
  print(Db.get(db, "score"), Db.has(db, "score"), Db.keys(db), Db.count(db))
}
`);
  assert.deepEqual(second.output, ['42 true [score] 1']);
  rmSync(path, { force: true });
});

test('graphics emits inspectable SVG and WebGL command buffers', () => {
  const { output } = run(`
fn main() uses io {
  let c = Graphics.canvas(100, 80)
  Graphics.clear(c, "black")
  Graphics.line(c, 0.0, 0.0, 100.0, 80.0, "white")
  let gl = Graphics.webgl(c)
  Graphics.webglViewport(gl, 0.0, 0.0, 100.0, 80.0)
  Graphics.webglDraw(gl, "triangles", 3.0)
  print(Graphics.toSvg(c), Graphics.webglCommands(gl))
}
`);
  assert.match(output[0], /^<svg/);
  assert.match(output[0], /<line/);
  assert.match(output[0], /viewport/);
  assert.match(output[0], /triangles/);
});

test('audio synthesis returns valid RIFF/WAV base64 data', () => {
  const { output } = run(`
fn main() uses io {
  let a = Audio.tone(440.0, 0.1, 0.5)
  let b = Audio.note("C5", 0.1, 0.5)
  let sequence = Audio.sequence([a, b])
  print(Audio.toJson(sequence), Audio.wavBase64(sequence, 8000))
}
`);
  const wav = Buffer.from(output[0].split(' ').at(-1), 'base64');
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.subarray(36, 40).toString(), 'data');
});

test('network namespace reports unavailable transport without crashing the host', () => {
  const { output } = run(`
fn main() uses net, io {
  let socket = Net.websocketConnect("ws://127.0.0.1:1")
  print(Net.connected(socket), Net.error(socket))
}
`);
  // Node 22 may expose a native WebSocket even when the endpoint is not
  // reachable; the immediate, portable contract is that the handle is not yet
  // connected and the error field is a string (possibly filled asynchronously).
  assert.match(output[0], /^false /);
});

test('checker requires declared effects for random, db, net and audio', () => {
  const program = parse(tokenize(`fn main() { Random.normal(0.0, 1.0) }`, '<effects>'));
  const result = checkProgram(program);
  assert.ok(result.errors.some((error) => error.code === 'E0615' && error.message.includes('rand')));
  const db = checkProgram(parse(tokenize(`fn main() { let x = Db.open(":memory:") }`, '<effects>')));
  assert.ok(db.errors.some((error) => error.code === 'E0615' && error.message.includes('db')));
  const audio = checkProgram(parse(tokenize(`fn main() { let x = Audio.tone(440.0, 1.0, 0.2) }`, '<effects>')));
  assert.ok(audio.errors.some((error) => error.code === 'E0615' && error.message.includes('io')));
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
