#!/usr/bin/env node
/**
 * Diagnostic harness for the fixes-11 pass: emit LLVM IR, assemble it with the
 * real `llvm-as`, and run the same module on the SunVM, for every bundled
 * template and example. Prints the exact failure text, not a pass/fail bit.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = "/tmp/fixes11";
mkdirSync(OUT, { recursive: true });

const { runPipeline } = await import(join(ROOT, "dist", "pipeline", "pipeline.js"));
const { emitLlvm } = await import(join(ROOT, "dist", "backend", "llvm.js"));
const { compileToSunVm } = await import(join(ROOT, "dist", "backend", "sunvm.js"));
const { SunVmRuntime } = await import(join(ROOT, "dist", "backend", "sunvm_run.js"));
const { listTemplates } = await import(join(ROOT, "dist", "stdlib", "templates.js"));
const { bindGamingHosts } = await import(join(ROOT, "dist", "backend", "sunvm_hosts.js"));

const llvmAs = ["llvm-as-18", "llvm-as-17", "llvm-as", "llvm-as-16"]
  .find((candidate) => spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0);
if (!llvmAs) throw new Error("llvm-as is required");

const subjects = [];
for (const template of listTemplates()) {
  subjects.push({ name: `template:${template.id}`, file: `${template.id}.sun`, source: template.source });
}
for (const file of ["hello.sun", "slot_machine.sun", "baccarat.sun", "provably_fair.sun", "gaming_primitives.sun", "blockchain.sun", "wasm_math.sun"]) {
  subjects.push({ name: `example:${file}`, file, source: readFileSync(join(ROOT, "examples", file), "utf8") });
}

const rows = [];
for (const subject of subjects) {
  const row = { name: subject.name, llvm: "?", vm: "?", detail: "" };
  try {
    const result = runPipeline(subject.source, subject.file, { native: false, sunvm: true, optLevel: 3 });
    if (result.diagnostics.errors.length > 0) {
      row.llvm = "front-end";
      row.vm = "front-end";
      row.detail = JSON.stringify(result.diagnostics.errors[0]).slice(0, 200);
      rows.push(row);
      continue;
    }
    const llvm = emitLlvm(result.optimized, { file: subject.file });
    const path = join(OUT, `${subject.name.replace(/[:.]/g, "_")}.ll`);
    writeFileSync(path, llvm.ir);
    const assembled = spawnSync(llvmAs, [path, "-o", `${path}.bc`], { encoding: "utf8" });
    row.llvm = assembled.status === 0 ? "ok" : "FAIL";
    if (assembled.status !== 0) row.detail = (assembled.stderr || "").split("\n").slice(0, 2).join(" | ");
    const badPtr = llvm.ir.split("\n").filter((line) => /\b(add|sub|mul|sdiv) ptr\b/.test(line));
    if (badPtr.length > 0) row.detail += ` ptr-arith:${badPtr.length}`;

    try {
      const vm = compileToSunVm(result.optimized, { profile: "open" });
      const runtime = new SunVmRuntime();
      runtime.load(vm.bytes);
      const unbound = bindGamingHosts(runtime, { seed: "diagnose" });
      if (unbound.length > 0) {
        row.vm = `unbound:${unbound.slice(0, 5).join(",")}`;
      } else {
        const out = runtime.run("main");
        row.vm = `ok(${out.output.length} lines)`;
      }
    } catch (error) {
      row.vm = `FAIL ${String(error.message).slice(0, 90)}`;
    }
  } catch (error) {
    row.llvm = "THROW";
    row.detail = String(error.message).slice(0, 200);
  }
  rows.push(row);
}

console.log("name".padEnd(26) + "llvm".padEnd(10) + "sunvm");
for (const row of rows) {
  console.log(row.name.padEnd(26) + String(row.llvm).padEnd(10) + row.vm);
  if (row.detail) console.log("    " + row.detail);
}
const llvmFail = rows.filter((r) => r.llvm !== "ok").length;
const vmFail = rows.filter((r) => !String(r.vm).startsWith("ok")).length;
console.log(`\nsummary: llvm ${rows.length - llvmFail}/${rows.length} ok, sunvm ${rows.length - vmFail}/${rows.length} ok`);
