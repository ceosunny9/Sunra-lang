#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const file = join(HERE, "fixtures", "inline_ptr_return.sun");
const source = readFileSync(file, "utf8");

const { runPipeline } = await import(join(ROOT, "dist", "pipeline", "pipeline.js"));
const { emitLlvm } = await import(join(ROOT, "dist", "backend", "llvm.js"));
const { compileToSunVm } = await import(join(ROOT, "dist", "backend", "sunvm.js"));
const { SunVmRuntime, DEFAULT_LIMITS } = await import(join(ROOT, "dist", "backend", "sunvm_run.js"));

const llvmAs = ["llvm-as-18", "llvm-as-17", "llvm-as", "llvm-as-16"]
  .map((candidate) => ({ candidate, probe: spawnSync(candidate, ["--version"], { encoding: "utf8" }) }))
  .find(({ probe }) => probe.status === 0)?.candidate;
if (!llvmAs) throw new Error("llvm-as is required for the inline-ptr regression");

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

// Inlining runs at level 2 and above, so assert on the optimised module.
const result = runPipeline(source, file, { native: false, sunvm: true, optLevel: 3 });
assert.deepEqual(result.diagnostics.errors, [], JSON.stringify(result.diagnostics.errors));
const llvm = emitLlvm(result.optimized, { file });
writeFileSync("/tmp/sunra-inline-ptr.ll", llvm.ir);

check("no arithmetic is emitted on a reference type", () => {
  const offenders = llvm.ir.split("\n").filter((line) => /\b(add|sub|mul|sdiv) ptr\b/.test(line));
  assert.deepEqual(offenders, []);
});

check("the module assembles with llvm-as", () => {
  const assembled = spawnSync(llvmAs, ["/tmp/sunra-inline-ptr.ll", "-o", "/tmp/sunra-inline-ptr.bc"], { encoding: "utf8" });
  assert.equal(assembled.status, 0, assembled.stderr);
});

check("every function is emitted", () => {
  assert.deepEqual(llvm.skipped, []);
});

check("SunVM compiles the module with nothing rejected", () => {
  const vm = compileToSunVm(result.optimized, { profile: "rgs" });
  assert.deepEqual(vm.rejected, []);
});

check("SunVM runs the program instead of trapping", () => {
  const vm = compileToSunVm(result.optimized, { profile: "rgs" });
  const runtime = new SunVmRuntime({ ...DEFAULT_LIMITS, steps: 200_000 });
  runtime.load(vm.bytes);
  assert.deepEqual(runtime.run("main").output, ["12", "3", "solar"]);
});

check("the interpreter runs the same program to the same values", () => {
  const cli = spawnSync(process.execPath, [join(ROOT, "dist", "cli", "main.js"), "run", file], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const lines = cli.stdout.trim().split("\n");
  assert.equal(Number(lines[0]), 12);
  assert.deepEqual(lines.slice(1), ["3", "solar"]);
});

if (failures > 0) {
  console.error(`inline ptr: ${failures} failed`);
  process.exit(1);
}
console.log("inline ptr: all checks passed");
