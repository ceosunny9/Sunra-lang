#!/usr/bin/env node
/**
 * Backend coverage probe.
 *
 * Not a test: a diagnostic that reports, per source file, what each backend did
 * with it. It exists so backend gaps are measured rather than guessed at.
 *
 *   node tests/tools/backend_probe.mjs examples/slot_machine.sun ...
 */
import { readFileSync } from 'node:fs';
import { tokenize } from '../../dist/lexer/lexer.js';
import { parse } from '../../dist/parser/parser.js';
import { checkProgram } from '../../dist/checker/checker.js';
import { lowerToHir } from '../../dist/hir/lower.js';
import { inferOwnership } from '../../dist/own/ownership.js';
import { buildMir } from '../../dist/mir/build.js';
import { emitLlvm } from '../../dist/backend/llvm.js';
import { emitCranelift } from '../../dist/backend/cranelift.js';
import { compileToSunVm } from '../../dist/backend/sunvm.js';
import { emitContract } from '../../dist/backend/wasm_contract.js';

for (const file of process.argv.slice(2)) {
  const source = readFileSync(file, 'utf8');
  let mir;
  try {
    const program = parse(tokenize(source, file));
    const checked = checkProgram(program);
    if (checked.errors.length > 0) {
      console.log(`${file}: CHECK ERRORS ${checked.errors.length}: ${checked.errors[0].message}`);
      continue;
    }
    const hir = lowerToHir(program, file);
    mir = buildMir(hir, inferOwnership(hir));
  } catch (error) {
    console.log(`${file}: FRONTEND THREW ${error.message}`);
    continue;
  }

  const llvm = emitLlvm(mir);
  const clif = emitCranelift(mir);
  const vm = compileToSunVm(mir);
  const wasm = emitContract(mir);

  console.log(`${file}`);
  console.log(`  functions:  ${mir.functions.length}`);
  console.log(`  llvm:       ${llvm.functions.length} emitted, ${llvm.skipped.length} skipped`);
  for (const s of llvm.skipped) console.log(`              - ${s.symbol}: ${s.reason}`);
  console.log(`  cranelift:  ${clif.functions.length} emitted, ${clif.skipped.length} skipped`);
  for (const s of clif.skipped) console.log(`              - ${s.symbol}: ${s.reason}`);
  console.log(`  sunvm:      ${vm.program.functions.length} compiled, ${vm.rejected.length} rejected`);
  for (const r of vm.rejected) console.log(`              - ${r.symbol}: ${r.reason}`);
  console.log(`  wasm:       ${wasm.compiled.length} compiled, ${wasm.rejected.length} rejected`);
  for (const r of wasm.rejected) console.log(`              - ${r.symbol}: ${r.reason}`);
}
