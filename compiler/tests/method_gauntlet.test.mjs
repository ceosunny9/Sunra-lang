#!/usr/bin/env node
/**
 * Method gauntlet regression.
 *
 * The fixture calls every builtin method the backends lower, in a game-shaped
 * program (reel strips, a 3x3 grid, nested loops, method chains). The test pins
 * the *values*, not just "it compiled": the interpreter and SunVM must agree line
 * for line, the LLVM IR must assemble, and every backend must lower every
 * function. A missing lowering therefore fails as a wrong number or a rejected
 * function rather than passing silently.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { runPipeline } = await import(join(ROOT, "dist", "pipeline", "pipeline.js"));
const { emitLlvm } = await import(join(ROOT, "dist", "backend", "llvm.js"));
const { emitCranelift } = await import(join(ROOT, "dist", "backend", "cranelift.js"));
const { compileToSunVm } = await import(join(ROOT, "dist", "backend", "sunvm.js"));
const { SunVmRuntime, DEFAULT_LIMITS } = await import(join(ROOT, "dist", "backend", "sunvm_run.js"));

const llvmAs = ["llvm-as-18", "llvm-as-17", "llvm-as", "llvm-as-16"]
  .map((candidate) => ({ candidate, probe: spawnSync(candidate, ["--version"], { encoding: "utf8" }) }))
  .find(({ probe }) => probe.status === 0)?.candidate;
if (!llvmAs) throw new Error("llvm-as is required for the method gauntlet regression");

const file = join(HERE, "fixtures", "method_gauntlet.sun");
const source = readFileSync(file, "utf8");

/** Exact expected output, verified against the interpreter's semantics. */
const EXPECTED = [
  "len          5",
  "ends         A|A",
  "push         6",
  "pop          5",
  "count        2",
  "contains     true",
  "indexOf      3",
  "slice        K-Q",
  "concat       8",
  "reverse      A-J-Q-K-A",
  "take         A-K",
  "join         A-K-Q-J-A",
  "sum          60",
  "label        SOLAR FORTUNE",
  "lower        solar",
  "strlen       5",
  "split        3",
  "chars        3",
  "toString     42",
  "abs          7",
  "floor        3",
  "round        4",
  "grid         4",
  "chain        A,J,Q",
];

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

// --- 1. interpreter: the reference semantics --------------------------------
const cli = spawnSync(process.execPath, [join(ROOT, "dist", "cli", "main.js"), "run", file], {
  encoding: "utf8",
});
check("interpreter runs the gauntlet with no diagnostics", () => {
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
});
check("interpreter output matches the expected values", () => {
  const lines = cli.stdout.trim().split("\n");
  assert.deepEqual(lines, EXPECTED);
});

// --- 2. pipeline: every backend lowers every function ----------------------
const result = runPipeline(source, file, { native: true, sunvm: true, contract: true });
check("pipeline reports no errors", () => {
  assert.equal(result.diagnostics.errors.length, 0, JSON.stringify(result.diagnostics.errors));
});
check("LLVM lowers every function", () => {
  assert.equal(result.backends.llvm.skipped.length, 0, JSON.stringify(result.backends.llvm.skipped));
  assert.ok(result.backends.llvm.functions.length >= 27, `only ${result.backends.llvm.functions.length} functions`);
});
check("Cranelift lowers every function", () => {
  assert.equal(result.backends.cranelift.skipped.length, 0, JSON.stringify(result.backends.cranelift.skipped));
});
check("SunVM rejects nothing", () => {
  assert.equal(result.backends.sunvm.rejected.length, 0, JSON.stringify(result.backends.sunvm.rejected));
});

// --- 3. LLVM IR assembles and calls the builtin runtime ABI ----------------
const llvm = emitLlvm(result.optimized, { file: "method_gauntlet.sun" });
const irPath = "/tmp/sunra-method-gauntlet.ll";
writeFileSync(irPath, llvm.ir);
check("llvm-as accepts the gauntlet IR", () => {
  const assembled = spawnSync(llvmAs, [irPath, "-o", "/tmp/sunra-method-gauntlet.bc"], { encoding: "utf8" });
  assert.equal(assembled.status, 0, assembled.stderr);
});
for (const [method, pattern] of [
  ["len", /call i64 @__sunra_len\(ptr /],
  ["push", /call ptr @__sunra_push\(ptr /],
  ["pop", /call ptr @__sunra_pop\(ptr /],
  ["contains", /call i1 @__sunra_contains\(ptr /],
  ["indexOf", /call i64 @__sunra_index_of\(ptr /],
  ["slice", /call ptr @__sunra_slice\(ptr /],
  ["concat", /call ptr @__sunra_concat\(ptr /],
  ["reverse", /call ptr @__sunra_reverse\(ptr /],
  ["first", /call ptr @__sunra_first\(ptr /],
  ["last", /call ptr @__sunra_last\(ptr /],
  ["count", /call i64 @__sunra_count\(ptr /],
  ["join", /call ptr @__sunra_join\(ptr /],
  ["take", /call ptr @__sunra_take\(ptr /],
  ["sum", /call i64 @(?:__sunra_sum_int|__sunra_list_sum_i64)\(ptr /],
  ["upper", /call ptr @__sunra_upper\(ptr /],
  ["lower", /call ptr @__sunra_lower\(ptr /],
  ["trim", /call ptr @__sunra_trim\(ptr /],
  ["split", /call ptr @__sunra_split\(ptr /],
  ["chars", /call ptr @__sunra_chars\(ptr /],
  ["abs", /call i64 @__sunra_abs_i64\(i64 /],
  ["floor", /call i64 @__sunra_floor\(double /],
  ["round", /call i64 @__sunra_round\(double /],
]) {
  check(`LLVM lowers .${method}() to its runtime helper`, () => {
    assert.match(llvm.ir, pattern);
  });
}
check("LLVM emits no invalid pointer arithmetic", () => {
  assert.doesNotMatch(llvm.ir, /= add ptr/);
  assert.doesNotMatch(llvm.ir, /icmp i1 ptr/);
});

// --- 4. Cranelift declares a signature for every helper it calls ----------
const clif = emitCranelift(result.optimized);
check("Cranelift declares every builtin it calls", () => {
  const called = new Set([...clif.clif.matchAll(/call fn_(\w+)/g)].map((m) => m[1]));
  const declared = new Set([...clif.clif.matchAll(/fn_(\w+) = %\w+ sig_/g)].map((m) => m[1]));
  const missing = [...called].filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `undeclared: ${missing.join(", ")}`);
});
check("Cranelift types list receivers as references", () => {
  assert.match(clif.clif, /function %stripTotal\(v\d+: r64\) -> i64/);
});

// --- 5. SunVM executes the gauntlet to the same values --------------------
const program = compileToSunVm(result.optimized, { profile: "rgs" });
check("SunVM compiles with no rejected functions", () => {
  assert.equal(program.rejected.length, 0, JSON.stringify(program.rejected));
});
check("SunVM produces the same output as the interpreter", () => {
  // A generous step budget: the gauntlet runs nested loops over a 3x3 grid on top
  // of 24 method calls, which is well past the default RGS spin budget.
  const runtime = new SunVmRuntime({ ...DEFAULT_LIMITS, steps: 5_000_000 });
  runtime.load(program.bytes);
  const run = runtime.run("main");
  assert.deepEqual(run.output, EXPECTED);
});

console.log(failures === 0 ? `\nmethod gauntlet: all checks passed` : `\nmethod gauntlet: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
