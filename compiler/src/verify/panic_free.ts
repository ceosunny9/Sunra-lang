/**
 * Panic-freedom prover.
 *
 * A slot engine that panics mid-spin is a regulatory incident: the player's
 * stake is already debited, the outcome is undetermined, and the operator has to
 * reconcile by hand. `#[no_panic]` is the promise that a function cannot do
 * that, and this file is what makes the promise checkable rather than aspirational.
 *
 * Design: the prover does not invent its own arithmetic reasoning. It enumerates
 * every operation in SunMIR that *can* panic, then asks the refinement checker
 * whether that specific operation was already discharged. An obligation that the
 * refiner proved safe is discharged; anything left over is a proof failure
 * reported against the `#[no_panic]` attribute.
 *
 * This separation matters: the refiner owns arithmetic (intervals + linear
 * arithmetic), and the prover owns policy (which functions must be panic-free,
 * and how failures are reported). Neither duplicates the other.
 *
 * Panic sources in Sunra:
 *   1. division / modulo by zero
 *   2. list index out of bounds (including negative indices)
 *   3. explicit `panic(...)` / `assert(...)` calls
 *   4. calling a function that itself may panic (transitively)
 *   5. integer overflow, when checked arithmetic is enabled
 *   6. unreachable code being reached
 */
import type { MirFunction, MirModule } from "../mir/mir.js";
import type { RefineResult, Obligation } from "../refine/refine.js";
import type { Span } from "../diagnostics.js";

export type PanicKind =
  | "divide-by-zero"
  | "modulo-by-zero"
  | "index-out-of-bounds"
  | "negative-index"
  | "explicit-panic"
  | "callee-may-panic"
  | "unreachable"
  | "overflow";

export interface PanicSite {
  kind: PanicKind;
  symbol: string;
  span: Span;
  /** Human-readable explanation of the risk. */
  detail: string;
  /** True when a proof discharged this site. */
  discharged: boolean;
  /** Which analysis discharged it, when discharged. */
  by?: "refinement" | "attribute" | "structural";
}

export interface FunctionProof {
  symbol: string;
  /** Did the source request `#[no_panic]`? */
  requested: boolean;
  /** Is the function provably panic-free? */
  proven: boolean;
  sites: PanicSite[];
  /** Functions this one calls that may panic. */
  panickyCallees: string[];
}

export interface PanicProofResult {
  functions: FunctionProof[];
  /** Functions that declared `#[no_panic]` but could not be proven. */
  violations: Array<{ symbol: string; span: Span; reasons: string[] }>;
  /** Every function proven panic-free, whether or not it asked to be. */
  panicFree: string[];
}

export function provePanicFreedom(
  module: MirModule,
  refine: RefineResult | null = null,
): PanicProofResult {
  // Index the refiner's verdicts by source position, because that is the only
  // stable identity shared between MIR instructions and refinement obligations.
  const discharged = new Set<string>();
  const violated = new Map<string, Obligation>();
  if (refine) {
    for (const obligation of refine.obligations) {
      const key = obligationKey(obligation);
      if (obligation.status === "proved") discharged.add(key);
      else if (obligation.status === "violated") violated.set(key, obligation);
    }
  }

  // Pass 1: collect local panic sites per function, ignoring calls.
  const local = new Map<string, PanicSite[]>();
  const declared = new Map<string, boolean>();
  const calls = new Map<string, Array<{ callee: string; span: Span }>>();

  for (const fn of module.functions) {
    declared.set(fn.symbol, hasNoPanic(fn));
    const sites: PanicSite[] = [];
    const callees: Array<{ callee: string; span: Span }> = [];

    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        switch (instr.op) {
          case "binary": {
            if (instr.kind === "div" || instr.kind === "rem") {
              const kind: PanicKind =
                instr.kind === "div" ? "divide-by-zero" : "modulo-by-zero";
              // Obligation kinds are `division-by-zero` / `modulo-by-zero`.
              const obligationKind =
                kind === "divide-by-zero" ? "division-by-zero" : "modulo-by-zero";
              const key = `${obligationKind}@${instr.span.line}:${instr.span.col}`;
              sites.push({
                kind,
                symbol: fn.symbol,
                span: instr.span,
                detail:
                  kind === "divide-by-zero"
                    ? "the divisor may be zero"
                    : "the modulus may be zero",
                discharged: discharged.has(key),
                by: discharged.has(key) ? "refinement" : undefined,
              });
            }
            break;
          }

          case "index": {
            // The optimiser marks `checked: false` only when the refiner proved
            // the access safe, so an unchecked access is already discharged.
            const checked = (instr as { checked?: boolean }).checked !== false;
            const key = `index-out-of-bounds@${instr.span.line}:${instr.span.col}`;
            const proved = !checked || discharged.has(key);
            sites.push({
              kind: "index-out-of-bounds",
              symbol: fn.symbol,
              span: instr.span,
              detail: "the index may be outside the list bounds",
              discharged: proved,
              by: proved ? (checked ? "refinement" : "structural") : undefined,
            });
            break;
          }

          case "call": {
            const callee = instr.callee;
            if (callee === "panic") {
              sites.push({
                kind: "explicit-panic",
                symbol: fn.symbol,
                span: instr.span,
                detail: "`panic` always aborts",
                discharged: false,
              });
              break;
            }
            if (callee === "assert") {
              sites.push({
                kind: "explicit-panic",
                symbol: fn.symbol,
                span: instr.span,
                detail: "`assert` aborts when its condition is false",
                discharged: false,
              });
              break;
            }
            callees.push({ callee, span: instr.span });
            break;
          }

          default:
            break;
        }
      }

      if (block.terminator.op === "unreachable") {
        // Reaching `unreachable` is a panic. It is discharged structurally when
        // the block has no predecessors that can actually flow into it, which the
        // MIR builder only emits for exhaustive matches.
        sites.push({
          kind: "unreachable",
          symbol: fn.symbol,
          span: fn.span,
          detail: "control flow may reach an unreachable terminator",
          discharged: isProvablyDead(fn, block.id),
          by: isProvablyDead(fn, block.id) ? "structural" : undefined,
        });
      }
    }

    local.set(fn.symbol, sites);
    calls.set(fn.symbol, callees);
  }

  // Pass 2: propagate "may panic" across the call graph until it settles.
  // A function may panic if it has an undischarged local site, or it calls
  // something that may panic. Fixed point because recursion makes the graph cyclic.
  const mayPanic = new Set<string>();
  for (const [symbol, sites] of local) {
    if (sites.some((s) => !s.discharged)) mayPanic.add(symbol);
  }

  const known = new Set(module.functions.map((f) => f.symbol));
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of module.functions) {
      if (mayPanic.has(fn.symbol)) continue;
      for (const { callee } of calls.get(fn.symbol) ?? []) {
        // A call into an unknown symbol is a host builtin. Builtins are
        // panic-free by construction except the ones handled above, so an unknown
        // callee does not taint the caller.
        if (!known.has(callee)) continue;
        if (mayPanic.has(callee)) {
          mayPanic.add(fn.symbol);
          changed = true;
          break;
        }
      }
    }
  }

  // Pass 3: build reports.
  const functions: FunctionProof[] = [];
  const violations: PanicProofResult["violations"] = [];
  const panicFree: string[] = [];

  for (const fn of module.functions) {
    const sites = local.get(fn.symbol) ?? [];
    const panickyCallees = (calls.get(fn.symbol) ?? [])
      .filter(({ callee }) => known.has(callee) && mayPanic.has(callee))
      .map(({ callee }) => callee);

    // Record inherited risk as its own site, so a report explains *why* a
    // function with clean arithmetic still cannot be proven.
    for (const { callee, span } of calls.get(fn.symbol) ?? []) {
      if (known.has(callee) && mayPanic.has(callee)) {
        sites.push({
          kind: "callee-may-panic",
          symbol: fn.symbol,
          span,
          detail: `calls \`${callee}\`, which may panic`,
          discharged: false,
        });
      }
    }

    const proven = !mayPanic.has(fn.symbol);
    const requested = declared.get(fn.symbol) ?? false;
    functions.push({ symbol: fn.symbol, requested, proven, sites, panickyCallees });
    if (proven) panicFree.push(fn.symbol);

    if (requested && !proven) {
      const reasons = sites
        .filter((s) => !s.discharged)
        .map((s) => `${s.kind} at line ${s.span.line}: ${s.detail}`);
      violations.push({ symbol: fn.symbol, span: fn.span, reasons });
    }
  }

  // Surface refinement violations as panic evidence too: a proven-false
  // obligation is a guaranteed panic, not merely a possible one.
  //
  // Matching by span alone is not enough. The optimiser constant-folds `a / 0`
  // to its trap value and drops the `div` instruction, so by the time the prover
  // runs there is no MIR site at that position and a guaranteed panic would
  // vanish from the report — exactly the hole an audit found in
  // `#[no_panic] fn div(a) { a / 0 }`. The obligation records the function it
  // arose in, so attribute by name first and fall back to the span.
  for (const [, obligation] of violated) {
    const owner =
      functions.find((f) => f.symbol === obligation.fn) ??
      functions.find((f) =>
        f.sites.some(
          (s) => s.span.line === obligation.span.line && s.span.col === obligation.span.col,
        ),
      );
    if (!owner) continue;

    // Record it as a site so reports name the position, not just a count.
    const alreadyRecorded = owner.sites.some(
      (s) =>
        !s.discharged &&
        s.span.line === obligation.span.line &&
        s.span.col === obligation.span.col,
    );
    if (!alreadyRecorded) {
      owner.sites.push({
        kind: panicKindOf(obligation.kind),
        symbol: owner.symbol,
        span: obligation.span,
        detail: `${obligation.claim} — ${obligation.reason}`,
        discharged: false,
      });
    }

    // A guaranteed panic means the function is not panic-free, whether or not it
    // asked to be, so withdraw any earlier clean verdict.
    if (owner.proven) {
      owner.proven = false;
      const index = panicFree.indexOf(owner.symbol);
      if (index >= 0) panicFree.splice(index, 1);
    }

    if (!owner.requested) continue;
    const reason = `refinement proved a violation: ${obligation.claim} (${obligation.reason})`;
    const existing = violations.find((v) => v.symbol === owner.symbol);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    } else {
      violations.push({ symbol: owner.symbol, span: obligation.span, reasons: [reason] });
    }
  }

  return { functions, violations, panicFree };
}

/** Map a refinement obligation kind onto the panic it would cause at runtime. */
function panicKindOf(kind: string): PanicKind {
  switch (kind) {
    case "division-by-zero":
      return "divide-by-zero";
    case "modulo-by-zero":
      return "modulo-by-zero";
    case "index-out-of-bounds":
      return "index-out-of-bounds";
    default:
      return "explicit-panic";
  }
}

function hasNoPanic(fn: MirFunction): boolean {
  return fn.attributes.some((a) => a.name === "no_panic");
}

/** A block with no predecessors cannot be entered, so its panic is unreachable. */
function isProvablyDead(fn: MirFunction, blockId: number): boolean {
  if (fn.blocks.length > 0 && fn.blocks[0].id === blockId) return false; // entry
  for (const block of fn.blocks) {
    const term = block.terminator;
    if (term.op === "jump" && term.target === blockId) return false;
    if (term.op === "branch" && (term.then === blockId || term.otherwise === blockId)) return false;
  }
  return true;
}

function obligationKey(obligation: Obligation): string {
  return `${obligation.kind}@${obligation.span.line}:${obligation.span.col}`;
}
