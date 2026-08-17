#!/usr/bin/env node
/**
 * Backend coverage summary.
 *
 * Aggregates, across every file given, how many functions each backend lowered
 * and how many it refused. WASM is measured twice: with IEEE-754 floats (where a
 * refusal is the correct answer for a chain runtime) and with `fixedPointFloats`
 * (where Float compiles as scaled i64 and nothing needs refusing).
 *
 * Usage: node tests/tools/backend_summary.mjs examples/*.sun tests/fixtures/*.sun
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const { runPipeline } = await import(join(ROOT, "dist", "pipeline", "pipeline.js"));

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: backend_summary.mjs <file.sun> [more.sun ...]");
  process.exit(2);
}

const totals = {
  functions: 0,
  llvm: { ok: 0, bad: 0 },
  cranelift: { ok: 0, bad: 0 },
  sunvm: { ok: 0, bad: 0 },
  wasm: { ok: 0, bad: 0 },
  wasmFixed: { ok: 0, bad: 0 },
};
const rows = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const base = { native: true, sunvm: true, contract: true };
  const plain = runPipeline(source, file, base);
  const fixed = runPipeline(source, file, { ...base, contractFixedPointFloats: true });

  const row = {
    file,
    functions: plain.optimized.functions.length,
    llvm: { ok: plain.backends.llvm.functions.length, bad: plain.backends.llvm.skipped.length },
    cranelift: {
      ok: plain.backends.cranelift.functions.length,
      bad: plain.backends.cranelift.skipped.length,
    },
    sunvm: {
      ok: plain.backends.sunvm.program.functions.length,
      bad: plain.backends.sunvm.rejected.length,
    },
    wasm: { ok: plain.backends.contract.compiled.length, bad: plain.backends.contract.rejected.length },
    wasmFixed: {
      ok: fixed.backends.contract.compiled.length,
      bad: fixed.backends.contract.rejected.length,
    },
  };
  rows.push(row);
  totals.functions += row.functions;
  for (const key of ["llvm", "cranelift", "sunvm", "wasm", "wasmFixed"]) {
    totals[key].ok += row[key].ok;
    totals[key].bad += row[key].bad;
  }
}

const pad = (value, width) => String(value).padEnd(width);
console.log(
  `${pad("file", 42)}${pad("fns", 5)}${pad("llvm", 10)}${pad("clif", 10)}${pad("sunvm", 10)}${pad("wasm", 10)}${pad("wasm+fx", 10)}`,
);
for (const row of rows) {
  console.log(
    `${pad(row.file, 42)}${pad(row.functions, 5)}` +
      `${pad(`${row.llvm.ok}/${row.llvm.bad}`, 10)}` +
      `${pad(`${row.cranelift.ok}/${row.cranelift.bad}`, 10)}` +
      `${pad(`${row.sunvm.ok}/${row.sunvm.bad}`, 10)}` +
      `${pad(`${row.wasm.ok}/${row.wasm.bad}`, 10)}` +
      `${pad(`${row.wasmFixed.ok}/${row.wasmFixed.bad}`, 10)}`,
  );
}
console.log(
  `${pad("TOTAL", 42)}${pad(totals.functions, 5)}` +
    `${pad(`${totals.llvm.ok}/${totals.llvm.bad}`, 10)}` +
    `${pad(`${totals.cranelift.ok}/${totals.cranelift.bad}`, 10)}` +
    `${pad(`${totals.sunvm.ok}/${totals.sunvm.bad}`, 10)}` +
    `${pad(`${totals.wasm.ok}/${totals.wasm.bad}`, 10)}` +
    `${pad(`${totals.wasmFixed.ok}/${totals.wasmFixed.bad}`, 10)}`,
);
console.log("\ncolumns are lowered/refused; wasm+fx is with fixedPointFloats");
