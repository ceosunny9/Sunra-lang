#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const file = join(HERE, "fixtures", "solar_fortune_float_lists.sun");
const source = readFileSync(file, "utf8");
const { runPipeline } = await import(join(ROOT, "dist", "pipeline", "pipeline.js"));
const { emitLlvm, llvmRuntimeBuiltin } = await import(join(ROOT, "dist", "backend", "llvm.js"));
const { compileToSunVm } = await import(join(ROOT, "dist", "backend", "sunvm.js"));
const { SunVmRuntime, DEFAULT_LIMITS } = await import(join(ROOT, "dist", "backend", "sunvm_run.js"));

const llvmAs = ["llvm-as-18", "llvm-as-17", "llvm-as", "llvm-as-16"]
  .map((candidate) => ({ candidate, probe: spawnSync(candidate, ["--version"], { encoding: "utf8" }) }))
  .find(({ probe }) => probe.status === 0)?.candidate;
if (!llvmAs) throw new Error("llvm-as is required for the Float-list LLVM regression");

const result = runPipeline(source, file, { native: false, sunvm: true, contract: true });
assert.deepEqual(result.diagnostics.errors, [], JSON.stringify(result.diagnostics.errors));
const llvm = emitLlvm(result.optimized, { file });
assert.deepEqual(llvm.skipped, []);
writeFileSync("/tmp/sunra-solar-fortune-float-lists.ll", llvm.ir);

const assembled = spawnSync(llvmAs, ["/tmp/sunra-solar-fortune-float-lists.ll", "-o", "/tmp/sunra-solar-fortune-float-lists.bc"], { encoding: "utf8" });
assert.equal(assembled.status, 0, assembled.stderr);
assert.match(llvm.ir, /call double @__sunra_list_first_f64\(ptr /);
assert.match(llvm.ir, /call double @__sunra_list_last_f64\(ptr /);
assert.match(llvm.ir, /call double @__sunra_list_sum_f64\(ptr /);
assert.doesNotMatch(llvm.ir, /call ptr @__sunra_(first|last|sum)/);

// Exercise all five explicitly named Float helper ABI entries in a tiny MIR
// module as well. This keeps the declaration/return-type regression independent
// of source-level method inference and proves every emitted call assembles.
const span = { file: "synthetic-float-list.sun", line: 1, col: 1, length: 1 };
const floatList = { k: "List", of: { k: "Float" } };
const helperNames = ["first_float", "last_float", "sum_float", "min_float", "max_float"];
const helperInstrs = helperNames.map((callee, index) => ({
  op: "call",
  dst: index + 1,
  callee,
  args: [0],
  effects: [],
  ty: { k: "Float" },
  span,
}));
const helperTypes = new Map([[0, floatList], ...helperInstrs.map((instr) => [instr.dst, { k: "Float" }])]);
const synthetic = {
  file: "synthetic-float-list.sun",
  functions: [{
    symbol: "float_helpers",
    name: "float_helpers",
    params: [{ name: "values", value: 0, ty: floatList }],
    ret: { k: "Float" },
    effects: [],
    attributes: [],
    blocks: [{ id: 0, instrs: helperInstrs, terminator: { op: "return", value: 5, span }, preds: [] }],
    entry: 0,
    types: helperTypes,
    span,
  }],
  games: [],
  instantiations: [],
};
const helperLlvm = emitLlvm(synthetic, { file: synthetic.file });
writeFileSync("/tmp/sunra-float-helper-abi.ll", helperLlvm.ir);
const helperAssembled = spawnSync(llvmAs, ["/tmp/sunra-float-helper-abi.ll", "-o", "/tmp/sunra-float-helper-abi.bc"], { encoding: "utf8" });
assert.equal(helperAssembled.status, 0, helperAssembled.stderr);
for (const name of ["first", "last", "sum", "min", "max"]) {
  assert.match(helperLlvm.ir, new RegExp(`call double @__sunra_list_${name}_f64\\(ptr`));
}

for (const name of ["first_float", "last_float", "sum_float", "max_float", "min_float"]) {
  const abi = llvmRuntimeBuiltin(name, [{ k: "List", of: { k: "Float" } }]);
  assert.ok(abi, `${name} has no LLVM ABI`);
  assert.equal(abi.ret.k, "Float", `${name} must return Float`);
  assert.equal(abi.symbol, `__sunra_list_${name.replace("_float", "")}_f64`);
}

const compiled = compileToSunVm(result.optimized, { profile: "rgs" });
assert.deepEqual(compiled.rejected, []);
const runtime = new SunVmRuntime({ ...DEFAULT_LIMITS, steps: 100_000 });
runtime.load(compiled.bytes);
assert.deepEqual(runtime.run("main").output, ["1.25", "3.75", "7.5", "12.5"]);

console.log("Float-list LLVM passed: Solar Fortune llvm-as + typed double ABI + SunVM parity");
