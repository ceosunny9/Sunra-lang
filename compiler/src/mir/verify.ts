/**
 * SunMIR verifier.
 *
 * An IR is only useful if malformed IR is caught early, so every pass runs the
 * verifier in tests. It checks the invariants the backends and the optimiser
 * rely on:
 *
 *   - single assignment: no value is defined twice;
 *   - definitions dominate uses along the CFG (approximated by reachability
 *     through predecessors, which is exact for the shapes the builder emits);
 *   - phis appear only at the top of a block and name real predecessors;
 *   - every block is terminated, and every jump target exists;
 *   - every value has a recorded type.
 */
import { destOf, usesOf, usesOfTerminator, type MirFunction, type MirModule } from "./mir.js";

export interface VerifyError {
  fn: string;
  block: number | null;
  message: string;
}

export function verifyFunction(fn: MirFunction): VerifyError[] {
  const errors: VerifyError[] = [];
  const err = (block: number | null, message: string): void => {
    errors.push({ fn: fn.symbol, block, message });
  };

  const blocks = new Map(fn.blocks.map((b) => [b.id, b]));
  if (!blocks.has(fn.entry)) err(null, `entry block bb${fn.entry} does not exist`);

  // --- single assignment -------------------------------------------------
  const definedIn = new Map<number, number>(); // value -> block
  for (const param of fn.params) {
    if (definedIn.has(param.value)) err(null, `parameter %${param.value} defined twice`);
    definedIn.set(param.value, fn.entry);
  }
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      const dst = destOf(instr);
      if (dst === null) continue;
      if (definedIn.has(dst)) {
        err(block.id, `%${dst} is assigned more than once (SSA violation)`);
      }
      definedIn.set(dst, block.id);
    }
  }

  // --- types -------------------------------------------------------------
  for (const value of definedIn.keys()) {
    if (!fn.types.has(value)) err(null, `%${value} has no recorded type`);
  }

  // --- structure ---------------------------------------------------------
  for (const block of fn.blocks) {
    // Phis first.
    let seenNonPhi = false;
    for (const instr of block.instrs) {
      if (instr.op === "phi") {
        if (seenNonPhi) err(block.id, `phi %${instr.dst} appears after a non-phi instruction`);
        for (const source of instr.sources) {
          if (!blocks.has(source.block)) {
            err(block.id, `phi %${instr.dst} names unknown block bb${source.block}`);
          } else if (!block.preds.includes(source.block)) {
            err(block.id, `phi %${instr.dst} names bb${source.block}, which is not a predecessor`);
          }
        }
      } else {
        seenNonPhi = true;
      }
    }

    // Terminator targets.
    const term = block.terminator;
    const targets = term.op === "jump" ? [term.target] : term.op === "branch" ? [term.then, term.otherwise] : [];
    for (const target of targets) {
      if (!blocks.has(target)) err(block.id, `terminator jumps to unknown block bb${target}`);
    }
  }

  // --- definitions reach uses -------------------------------------------
  const reaches = (from: number, target: number, seen = new Set<number>()): boolean => {
    if (from === target) return true;
    if (seen.has(target)) return false;
    seen.add(target);
    for (const pred of blocks.get(target)?.preds ?? []) {
      if (reaches(from, pred, seen)) return true;
    }
    return false;
  };

  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      // Phi operands are checked per-predecessor, not at the phi's own block.
      if (instr.op === "phi") {
        for (const source of instr.sources) {
          const defBlock = definedIn.get(source.value);
          if (defBlock === undefined) {
            err(block.id, `phi %${instr.dst} uses undefined %${source.value}`);
          } else if (!reaches(defBlock, source.block)) {
            err(block.id, `phi %${instr.dst} operand %${source.value} is not available in bb${source.block}`);
          }
        }
        continue;
      }
      for (const use of usesOf(instr)) {
        const defBlock = definedIn.get(use);
        if (defBlock === undefined) {
          err(block.id, `use of undefined value %${use}`);
        } else if (!reaches(defBlock, block.id)) {
          err(block.id, `%${use} defined in bb${defBlock} does not dominate its use`);
        }
      }
    }
    for (const use of usesOfTerminator(block.terminator)) {
      const defBlock = definedIn.get(use);
      if (defBlock === undefined) err(block.id, `terminator uses undefined value %${use}`);
      else if (!reaches(defBlock, block.id)) {
        err(block.id, `%${use} defined in bb${defBlock} does not dominate the terminator`);
      }
    }
  }

  return errors;
}

export function verifyModule(module: MirModule): VerifyError[] {
  return module.functions.flatMap(verifyFunction);
}
