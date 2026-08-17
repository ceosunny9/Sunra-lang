#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { runPipeline } = await import(join(ROOT, "dist", "pipeline", "pipeline.js"));
const { emitLlvm } = await import(join(ROOT, "dist", "backend", "llvm.js"));

const llvmAs = ["llvm-as-18", "llvm-as-17", "llvm-as", "llvm-as-16"]
  .map((candidate) => ({ candidate, probe: spawnSync(candidate, ["--version"], { encoding: "utf8" }) }))
  .find(({ probe }) => probe.status === 0)?.candidate;
if (!llvmAs) throw new Error("llvm-as is required for LLVM Unknown regression");

const cases = [
  { name: "unknown_grid", file: join(HERE, "fixtures", "unknown_grid.sun"), expectedFunctions: 2 },
  { name: "solar_fortune_18", file: join(HERE, "fixtures", "solar_fortune_18.sun"), expectedFunctions: 18 },
  { name: "pad_right_multi", file: join(HERE, "fixtures", "pad_right_multi.sun"), expectedFunctions: 2 },
];
for (const testCase of cases) {
  const source = readFileSync(testCase.file, "utf8");
  const result = runPipeline(source, testCase.file, { native: false });
  assert.equal(result.diagnostics.errors.length, 0, `${testCase.name}: ${JSON.stringify(result.diagnostics.errors)}`);
  const output = emitLlvm(result.optimized, { file: `${testCase.name}.sun` });
  const irPath = `/tmp/sunra-${testCase.name}.ll`;
  const bcPath = `/tmp/sunra-${testCase.name}.bc`;
  writeFileSync(irPath, output.ir);
  assert.equal(output.functions.length, testCase.expectedFunctions, `${testCase.name}: expected ${testCase.expectedFunctions} functions`);
  assert.doesNotMatch(output.ir, /icmp i1 ptr/);
  assert.doesNotMatch(output.ir, /icmp i1 %v\d+, %v\d+/);
  if (testCase.name === "unknown_grid") {
    assert.match(output.ir, /define i64 @countInGrid\(ptr %v\d+, ptr %v\d+\)/);
    assert.match(output.ir, /icmp eq ptr %v\d+, %v\d+/);
    assert.match(output.ir, /call i64 @countInGrid\(ptr %v\d+, ptr %v\d+\)/);
  }
  if (testCase.name === "pad_right_multi") {
    assert.match(output.ir, /define ptr @padRight\(ptr %v\d+, i64 %v\d+\)/);
    assert.match(output.ir, /call ptr @padRight\(ptr %v\d+, i64 %v\d+\)/);
    assert.doesNotMatch(output.ir, /define ptr @padRight\(ptr %v\d+, ptr %v\d+\)/);
  }
  const assembled = spawnSync(llvmAs, [irPath, "-o", bcPath], { encoding: "utf8" });
  assert.equal(assembled.status, 0, `${llvmAs} rejected ${testCase.name} IR:\n${assembled.stderr}\n${output.ir}`);
  console.log(`${testCase.name}: ${output.functions.length} functions, ${Buffer.byteLength(output.ir)} bytes`);
}
