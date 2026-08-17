/**
 * Inspect one program's pipeline state.
 *
 * Used while chasing enforcement gaps: it prints the refinement obligations, the
 * MIR instruction kinds actually present after optimisation, and the panic sites
 * the prover found, so a claim like "the prover misses division by zero" can be
 * attributed to the right stage instead of guessed at.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runPipeline } from "../dist/pipeline/pipeline.js";

const file = resolve(process.cwd(), process.argv[2]);
const source = readFileSync(file, "utf8");
const result = runPipeline(source, file, { native: false, sunvm: false, contract: false });

console.log("=== diagnostics ===");
console.log("errors:", result.diagnostics.errors.length, "warnings:", result.diagnostics.warnings.length);
for (const error of result.diagnostics.errors) console.log("  ", error.code, error.message);
for (const warning of result.diagnostics.warnings) console.log("  ", warning.code, warning.message);

console.log("=== refinement obligations ===");
for (const obligation of result.refine.obligations) {
  console.log(`  ${obligation.kind.padEnd(22)} ${obligation.status.padEnd(10)} ${obligation.symbol} @${obligation.span?.line}:${obligation.span?.col} ${obligation.detail ?? ""}`);
}

const dumpMir = (label, module) => {
  console.log(`=== ${label} ===`);
  for (const fn of module.functions) {
    const ops = [];
    for (const block of fn.blocks) {
      for (const instr of block.instrs) ops.push(instr.op + (instr.kind ? `:${instr.kind}` : ""));
      ops.push(`term:${block.terminator.op}`);
    }
    console.log(`  ${fn.symbol}  ${ops.join(" ")}`);
  }
};
dumpMir("MIR (unoptimised)", result.mir);
dumpMir("MIR (optimised)", result.optimized);

console.log("=== optimizer counts ===");
console.log(" ", JSON.stringify(result.optimizerCounts));

console.log("=== panic sites ===");
for (const fn of result.panic.functions) {
  console.log(`  ${fn.symbol} requested=${fn.requested} proven=${fn.proven} sites=${fn.sites.length}`);
  for (const site of fn.sites) {
    console.log(`    ${site.kind} @${site.span?.line}:${site.span?.col} discharged=${site.discharged} ${site.detail}`);
  }
}

console.log("=== determinism ===");
console.log(" deterministic:", result.determinism.deterministic, "exact:", result.determinism.exact);
for (const finding of result.determinism.findings) {
  console.log(`  ${finding.kind} ${finding.severity} ${finding.symbol}: ${finding.detail}`);
}
