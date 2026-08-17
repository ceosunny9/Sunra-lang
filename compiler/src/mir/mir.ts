/**
 * SunMIR — the mid-level intermediate representation.
 *
 * SunMIR is where Sunra stops looking like a language and starts looking like a
 * machine. Three properties define it:
 *
 *   - **SSA.** Every value is assigned exactly once. Control-flow merges are
 *     explicit `phi` instructions at the top of a block, so a later pass never
 *     has to ask "which assignment reaches here?".
 *   - **Monomorphic.** Types are concrete. Nothing in SunMIR is generic, so the
 *     backends emit code without dispatch tables.
 *   - **Explicit drops.** The ownership pass computed when each affine value
 *     dies; SunMIR records that as a `drop` instruction. Memory management is
 *     visible in the IR rather than implied by scoping.
 */
import type { Span } from "../diagnostics.js";
import type { Ty } from "../checker/checker.js";

/** An SSA value: `%3`. Numbers are unique within a function. */
export type ValueId = number;

/** A basic block label: `bb2`. */
export type BlockId = number;

export type MirConst =
  | { k: "int"; value: number }
  | { k: "float"; value: number }
  | { k: "str"; value: string }
  | { k: "bool"; value: boolean }
  | { k: "unit" };

export type MirBinOp =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "rem"
  | "pow"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "and"
  | "or"
  | "concat";

export type MirInstr =
  /** `%dst = const 3` */
  | { op: "const"; dst: ValueId; value: MirConst; ty: Ty; span: Span }
  /** `%dst = phi [%a from bb1, %b from bb2]` */
  | { op: "phi"; dst: ValueId; sources: Array<{ block: BlockId; value: ValueId }>; ty: Ty; span: Span }
  /** `%dst = binary add %a %b` */
  | { op: "binary"; dst: ValueId; kind: MirBinOp; lhs: ValueId; rhs: ValueId; ty: Ty; span: Span }
  /** `%dst = unary neg %a` */
  | { op: "unary"; dst: ValueId; kind: "neg" | "not"; operand: ValueId; ty: Ty; span: Span }
  /** `%dst = call fn(%a, %b)` — `callee` is a monomorphic symbol name. */
  | {
      op: "call";
      dst: ValueId | null;
      callee: string;
      args: ValueId[];
      effects: string[];
      ty: Ty;
      span: Span;
      /**
       * For `intrinsic.load:<name>` calls: whether the loaded name is a runtime
       * namespace handle (`rng`, `Money`) or a field/method of the enclosing
       * `game` block. Backends use it to resolve game data from module metadata
       * instead of treating the read as an unknown host import.
       */
      intrinsicKind?: "namespace" | "gamefield" | "gamemethod";
    }
  /** `%dst = list [%a, %b]` */
  | { op: "list"; dst: ValueId; items: ValueId[]; ty: Ty; span: Span }
  /** `%dst = index %list %i` */
  | { op: "index"; dst: ValueId; object: ValueId; index: ValueId; ty: Ty; span: Span }
  /** `%dst = field %obj name` */
  | { op: "field"; dst: ValueId; object: ValueId; name: string; ty: Ty; span: Span }
  /** `store %list[%i] = %v` — the only mutating instruction. */
  | { op: "store"; object: ValueId; index: ValueId | null; field: string | null; value: ValueId; span: Span }
  /** `drop %v` — inserted from the ownership drop schedule. */
  | { op: "drop"; value: ValueId; variable: string; span: Span }
  /** `%dst = arena.alloc n` — set by the arena-promotion optimisation. */
  | { op: "arena"; dst: ValueId; source: ValueId; ty: Ty; span: Span };

export type MirTerminator =
  | { op: "jump"; target: BlockId; span: Span }
  | { op: "branch"; cond: ValueId; then: BlockId; otherwise: BlockId; span: Span }
  | { op: "return"; value: ValueId | null; span: Span }
  | { op: "unreachable"; span: Span };

export interface MirBlock {
  id: BlockId;
  /** Phi instructions come first, by construction. */
  instrs: MirInstr[];
  terminator: MirTerminator;
  /** Predecessor blocks, maintained as the CFG is built. */
  preds: BlockId[];
}

export interface MirParam {
  name: string;
  value: ValueId;
  ty: Ty;
}

export interface MirFunction {
  /** Monomorphic symbol name, e.g. `total$List_Int`. */
  symbol: string;
  /** Original source name. */
  name: string;
  params: MirParam[];
  ret: Ty;
  effects: string[];
  attributes: Array<{ name: string; args: Record<string, string | number | boolean | null> }>;
  blocks: MirBlock[];
  entry: BlockId;
  /** Type of every SSA value, for verification and codegen. */
  types: Map<ValueId, Ty>;
  span: Span;
}

export interface MirModule {
  file: string;
  functions: MirFunction[];
  /** Games survive as metadata: the RTP/paytable data the report needs. */
  games: Array<{
    name: string;
    fields: Array<{ name: string; value: MirConst | null }>;
    reels: Array<{ name: string; symbols: string[]; weights: number[] | null }>;
    methods: string[];
  }>;
  /** Monomorphization log: symbol -> the generic it came from. */
  instantiations: Array<{ symbol: string; from: string; types: string[] }>;
}

/** Render a function as text, for tests, `--emit mir` and debugging. */
export function formatFunction(fn: MirFunction): string {
  const lines: string[] = [];
  const params = fn.params.map((p) => `%${p.value}: ${tyText(p.ty)}`).join(", ");
  const effects = fn.effects.length > 0 ? ` uses ${fn.effects.join(", ")}` : "";
  lines.push(`fn ${fn.symbol}(${params}) -> ${tyText(fn.ret)}${effects} {`);
  for (const block of fn.blocks) {
    const preds = block.preds.length > 0 ? `  ; preds: ${block.preds.map((p) => `bb${p}`).join(", ")}` : "";
    lines.push(`bb${block.id}:${preds}`);
    for (const instr of block.instrs) lines.push(`  ${formatInstr(instr)}`);
    lines.push(`  ${formatTerminator(block.terminator)}`);
  }
  lines.push("}");
  return lines.join("\n");
}

export function formatModule(module: MirModule): string {
  return module.functions.map(formatFunction).join("\n\n");
}

function formatInstr(instr: MirInstr): string {
  switch (instr.op) {
    case "const":
      return `%${instr.dst} = const ${constText(instr.value)}`;
    case "phi":
      return `%${instr.dst} = phi ${instr.sources.map((s) => `[%${s.value}, bb${s.block}]`).join(" ")}`;
    case "binary":
      return `%${instr.dst} = ${instr.kind} %${instr.lhs}, %${instr.rhs}`;
    case "unary":
      return `%${instr.dst} = ${instr.kind} %${instr.operand}`;
    case "call":
      return `${instr.dst === null ? "" : `%${instr.dst} = `}call ${instr.callee}(${instr.args.map((a) => `%${a}`).join(", ")})`;
    case "list":
      return `%${instr.dst} = list [${instr.items.map((i) => `%${i}`).join(", ")}]`;
    case "index":
      return `%${instr.dst} = index %${instr.object}[%${instr.index}]`;
    case "field":
      return `%${instr.dst} = field %${instr.object}.${instr.name}`;
    case "store":
      if (instr.index !== null) return `store %${instr.object}[%${instr.index}] = %${instr.value}`;
      if (instr.field !== null) return `store %${instr.object}.${instr.field} = %${instr.value}`;
      return `store %${instr.object} = %${instr.value}`;
    case "drop":
      return `drop %${instr.value} ; ${instr.variable}`;
    case "arena":
      return `%${instr.dst} = arena.alloc %${instr.source}`;
  }
}

function formatTerminator(term: MirTerminator): string {
  switch (term.op) {
    case "jump":
      return `jump bb${term.target}`;
    case "branch":
      return `branch %${term.cond} ? bb${term.then} : bb${term.otherwise}`;
    case "return":
      return term.value === null ? "return" : `return %${term.value}`;
    case "unreachable":
      return "unreachable";
  }
}

function constText(c: MirConst): string {
  switch (c.k) {
    case "str":
      return JSON.stringify(c.value);
    case "unit":
      return "()";
    default:
      return String(c.value);
  }
}

export function tyText(ty: Ty): string {
  switch (ty.k) {
    case "List":
      return `List<${tyText(ty.of)}>`;
    case "Fn":
      return "Fn";
    case "Named":
      return ty.name;
    default:
      return ty.k;
  }
}

/** Destination value of an instruction, when it defines one. */
export function destOf(instr: MirInstr): ValueId | null {
  switch (instr.op) {
    case "const":
    case "phi":
    case "binary":
    case "unary":
    case "list":
    case "index":
    case "field":
    case "arena":
      return instr.dst;
    case "call":
      return instr.dst;
    case "store":
    case "drop":
      return null;
  }
}

/** Values read by an instruction. */
export function usesOf(instr: MirInstr): ValueId[] {
  switch (instr.op) {
    case "const":
      return [];
    case "phi":
      return instr.sources.map((s) => s.value);
    case "binary":
      return [instr.lhs, instr.rhs];
    case "unary":
      return [instr.operand];
    case "call":
      return [...instr.args];
    case "list":
      return [...instr.items];
    case "index":
      return [instr.object, instr.index];
    case "field":
      return [instr.object];
    case "store":
      return instr.index !== null
        ? [instr.object, instr.index, instr.value]
        : [instr.object, instr.value];
    case "drop":
      return [instr.value];
    case "arena":
      return [instr.source];
  }
}

export function usesOfTerminator(term: MirTerminator): ValueId[] {
  switch (term.op) {
    case "branch":
      return [term.cond];
    case "return":
      return term.value === null ? [] : [term.value];
    default:
      return [];
  }
}
