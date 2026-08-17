#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const sourcePath = join(ROOT, "examples", "slot_machine.sun");
const source = readFileSync(sourcePath, "utf8");

const { llvmType, emitLlvm } = await import(join(ROOT, "dist", "backend", "llvm.js"));
const { runPipeline } = await import(join(ROOT, "dist", "pipeline", "pipeline.js"));

// The backend contract is intentionally explicit: all runtime-managed
// aggregates/references use LLVM's opaque pointer type, while scalar values
// retain their exact ABI types.
assert.equal(llvmType({ k: "Int" }), "i64");
assert.equal(llvmType({ k: "Float" }), "double");
assert.equal(llvmType({ k: "Bool" }), "i1");
assert.equal(llvmType({ k: "List", elem: { k: "Int" } }), "ptr");
assert.equal(llvmType({ k: "Str" }), "ptr");
assert.equal(llvmType({ k: "Unknown" }), "ptr");

const pipeline = runPipeline(source, sourcePath, {
  native: true,
  compilerVersion: "sunra audit llvm ptr",
});
const output = emitLlvm(pipeline.optimized, { file: "solar-fortune.sun" });
const irPath = join(ROOT, ".solar-fortune.ll");
const bcPath = join(ROOT, ".solar-fortune.bc");
writeFileSync(irPath, output.ir);

// The source fixture is the SolarFortune prototype shipped with Sunra. Its
// exact number of functions depends on optimizer policy; the assertion keeps
// the important invariant that all functions the backend accepts are emitted.
assert.ok(output.functions.length >= 3, `expected Solar Fortune functions:\n${output.ir}`);
assert.deepEqual(output.skipped, [], JSON.stringify(output.skipped));
assert.match(output.ir, /declare ptr @sunra_list_new/);
assert.match(output.ir, /declare ptr @sunra_str_new/);
assert.doesNotMatch(output.ir, /declare i8\* @sunra_(list|str|arena)/);

const llvmAs = ["llvm-as-18", "llvm-as-17", "llvm-as", "llvm-as-16"]
  .map((candidate) => ({ candidate, probe: spawnSync(candidate, ["--version"], { encoding: "utf8" }) }))
  .find(({ probe }) => probe.status === 0)?.candidate;

if (!llvmAs) throw new Error("llvm-as is required for this backend test");
const assembled = spawnSync(llvmAs, [irPath, "-o", bcPath], { encoding: "utf8" });
assert.equal(assembled.status, 0, `${llvmAs} rejected Solar Fortune IR:\n${assembled.stderr}\n${output.ir.slice(0, 4000)}`);

console.log(`Solar Fortune LLVM ptr mapping passed: ${output.functions.length} functions, ${Buffer.byteLength(output.ir)} bytes`);
