#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const file = join(HERE, "fixtures", "game_field_constants.sun");
const source = readFileSync(file, "utf8");
const { runPipeline } = await import(join(ROOT, "dist", "pipeline", "pipeline.js"));
const { emitLlvm } = await import(join(ROOT, "dist", "backend", "llvm.js"));
const { compileToSunVm } = await import(join(ROOT, "dist", "backend", "sunvm.js"));
const { SunVmRuntime, DEFAULT_LIMITS } = await import(join(ROOT, "dist", "backend", "sunvm_run.js"));

const llvmAs = ["llvm-as-18", "llvm-as-17", "llvm-as", "llvm-as-16"]
  .map((candidate) => ({ candidate, probe: spawnSync(candidate, ["--version"], { encoding: "utf8" }) }))
  .find(({ probe }) => probe.status === 0)?.candidate;
if (!llvmAs) throw new Error("llvm-as is required for the game-field constant regression");

const result = runPipeline(source, file, { native: false, sunvm: true, contract: true });
assert.deepEqual(result.diagnostics.errors, [], JSON.stringify(result.diagnostics.errors));

const llvm = emitLlvm(result.optimized, { file });
const irPath = "/tmp/sunra-game-field-constants.ll";
const bcPath = "/tmp/sunra-game-field-constants.bc";
writeFileSync(irPath, llvm.ir);

// The old bug emitted `getelementptr i8, ptr null, i64 0` for minCluster.
assert.match(llvm.ir, /%v\d+ = add i64 0, 10/);
assert.match(llvm.ir, /icmp slt i64 %v\d+, %v\d+/);
assert.doesNotMatch(llvm.ir, /getelementptr i8, ptr null, i64 0/);
assert.doesNotMatch(llvm.ir, /icmp slt i64 %v\d+, ptr/);
assert.equal(llvm.skipped.length, 0, JSON.stringify(llvm.skipped));

const assembled = spawnSync(llvmAs, [irPath, "-o", bcPath], { encoding: "utf8" });
assert.equal(assembled.status, 0, assembled.stderr);

const cli = spawnSync(process.execPath, [join(ROOT, "dist", "cli", "main.js"), "run", file], {
  encoding: "utf8",
});
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
assert.deepEqual(cli.stdout.trim().split("\n"), ["1.0", "0.0"]);

const compiled = compileToSunVm(result.optimized, { profile: "rgs" });
assert.deepEqual(compiled.rejected, []);
const runtime = new SunVmRuntime({ ...DEFAULT_LIMITS, steps: 100_000 });
runtime.load(compiled.bytes);
assert.deepEqual(runtime.run("main").output, ["1", "0"]);

console.log("game field constants passed: LLVM scalar + llvm-as + interpreter + SunVM");
