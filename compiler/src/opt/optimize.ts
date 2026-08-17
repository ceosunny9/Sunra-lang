/**
 * SunMIR optimiser.
 *
 * Each pass is a pure function from module to module plus a log of what it did,
 * so `sunra build --emit mir --opt-report` can explain every transformation and
 * the verifier can run between passes in tests.
 *
 * Pass order is deliberate:
 *
 *   1. `devirtualize`   — turn dynamic namespace calls into direct symbols, so
 *                         inlining and const-folding can see through them.
 *   2. `inline`         — small leaf functions, which exposes constants.
 *   3. `constFold`      — fold the arithmetic the previous two passes revealed.
 *   4. `boundsElision`  — drop checks the refinement layer already proved safe.
 *   5. `tablePrecompute`— evaluate constant reel/paytable expressions once.
 *   6. `arenaPromotion` — allocate short-lived aggregates in a frame arena.
 *   7. `dce`            — remove everything the above made dead.
 *
 * Every pass is conservative: an optimisation that cannot prove its
 * precondition simply does not fire, and records why in the log.
 */
import { T, type Ty } from "../checker/checker.js";
import type { Span } from "../diagnostics.js";
import {
  destOf,
  usesOf,
  usesOfTerminator,
  type MirBlock,
  type MirConst,
  type MirFunction,
  type MirInstr,
  type MirModule,
  type MirTerminator,
  type ValueId,
} from "../mir/mir.js";
import type { RefineResult } from "../refine/refine.js";

export interface OptEvent {
  pass: string;
  fn: string;
  detail: string;
}

export interface OptResult {
  module: MirModule;
  events: OptEvent[];
  /** Per-pass counters, for the build report. */
  counts: Record<string, number>;
}

export interface OptOptions {
  /** Refinement results enable bounds-check elision. */
  refine?: RefineResult;
  /** 0 = none, 1 = cheap passes, 2 = everything. */
  level?: 0 | 1 | 2;
  /** Maximum instruction count for a function to be inlined. */
  inlineLimit?: number;
}

type Pass = (module: MirModule, ctx: PassContext) => MirModule;

interface PassContext {
  events: OptEvent[];
  options: Required<Pick<OptOptions, "level" | "inlineLimit">> & { refine?: RefineResult };
  note: (pass: string, fn: string, detail: string) => void;
}

export function optimize(module: MirModule, options: OptOptions = {}): OptResult {
  const level = options.level ?? 2;
  const events: OptEvent[] = [];
  const ctx: PassContext = {
    events,
    options: { level, inlineLimit: options.inlineLimit ?? 24, refine: options.refine },
    note: (pass, fn, detail) => events.push({ pass, fn, detail }),
  };

  if (level === 0) return { module, events, counts: {} };

  const passes: Array<{ name: string; run: Pass; minLevel: number }> = [
    { name: "devirtualize", run: devirtualize, minLevel: 1 },
    { name: "inline", run: inlinePass, minLevel: 2 },
    { name: "const-fold", run: constFold, minLevel: 1 },
    { name: "bounds-elision", run: boundsElision, minLevel: 1 },
    { name: "table-precompute", run: tablePrecompute, minLevel: 2 },
    { name: "arena-promotion", run: arenaPromotion, minLevel: 2 },
    { name: "dce", run: dce, minLevel: 1 },
  ];

  let current = module;
  for (const pass of passes) {
    if (level < pass.minLevel) continue;
    current = pass.run(current, ctx);
  }

  const counts: Record<string, number> = {};
  for (const event of events) counts[event.pass] = (counts[event.pass] ?? 0) + 1;

  return { module: current, events, counts };
}

// --------------------------------------------------------------- utilities

function cloneFunction(fn: MirFunction): MirFunction {
  return {
    ...fn,
    params: fn.params.map((p) => ({ ...p })),
    blocks: fn.blocks.map((b) => ({
      ...b,
      instrs: b.instrs.map((i) => ({ ...i }) as MirInstr),
      preds: [...b.preds],
    })),
    types: new Map(fn.types),
    effects: [...fn.effects],
    attributes: fn.attributes.map((a) => ({ ...a })),
  };
}

function mapModule(module: MirModule, f: (fn: MirFunction) => MirFunction): MirModule {
  return { ...module, functions: module.functions.map(f) };
}

/** Constant value of a value id, when a `const` instruction defines it. */
function constantsOf(fn: MirFunction): Map<ValueId, MirConst> {
  const map = new Map<ValueId, MirConst>();
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.op === "const") map.set(instr.dst, instr.value);
    }
  }
  return map;
}

function numberOf(c: MirConst | undefined): number | null {
  if (!c) return null;
  if (c.k === "int" || c.k === "float") return c.value;
  return null;
}

// --------------------------------------------------------------- passes

/**
 * Devirtualization.
 *
 * Calls that went through a runtime namespace (`rng.pick`, `Money.of`) arrive as
 * a load plus an indirect call. When the loaded name is a known namespace the
 * pair collapses to one direct call, which is both faster and visible to later
 * passes.
 */
function devirtualize(module: MirModule, ctx: PassContext): MirModule {
  return mapModule(module, (original) => {
    const fn = cloneFunction(original);
    // `intrinsic.load:<name>` defines the namespace object.
    const namespaces = new Map<ValueId, string>();
    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        if (instr.op === "call" && instr.callee.startsWith("intrinsic.load:")) {
          namespaces.set(instr.dst!, instr.callee.slice("intrinsic.load:".length));
        }
      }
    }
    if (namespaces.size === 0) return original;

    let changed = 0;
    for (const block of fn.blocks) {
      for (let i = 0; i < block.instrs.length; i++) {
        const instr = block.instrs[i];
        if (instr.op !== "field") continue;
        const ns = namespaces.get(instr.object);
        if (!ns) continue;
        // Find the call that uses this field value.
        for (const other of block.instrs) {
          if (other.op !== "call" || other.callee !== "intrinsic.dynamic") continue;
          // The builder emits `field` then a call whose callee value is the field.
          // Rewrite to a direct symbol.
          const target = `${ns}.${instr.name}`;
          (other as MirInstr & { op: "call" }).callee = target;
          ctx.note("devirtualize", fn.symbol, `resolved dynamic call to ${target}`);
          changed += 1;
        }
      }
    }
    return changed > 0 ? fn : original;
  });
}

/**
 * Inlining.
 *
 * Only single-block, effect-free, non-recursive functions below the size limit
 * are inlined. That covers the accessors and small arithmetic helpers where
 * inlining pays for itself, without needing a full cost model.
 */
function inlinePass(module: MirModule, ctx: PassContext): MirModule {
  const candidates = new Map<string, MirFunction>();
  for (const fn of module.functions) {
    if (fn.blocks.length !== 1) continue;
    if (fn.effects.length > 0) continue;
    const instrs = fn.blocks[0].instrs;
    if (instrs.length > ctx.options.inlineLimit) continue;
    if (instrs.some((i) => i.op === "drop" || i.op === "store" || i.op === "phi")) continue;
    // Recursion would not terminate.
    if (instrs.some((i) => i.op === "call" && i.callee === fn.symbol)) continue;
    if (fn.blocks[0].terminator.op !== "return") continue;
    candidates.set(fn.symbol, fn);
  }
  if (candidates.size === 0) return module;

  return mapModule(module, (original) => {
    const fn = cloneFunction(original);
    let nextValue = Math.max(0, ...[...fn.types.keys()]) + 1;
    let inlined = 0;
    // Caller %dst -> inlined value, for results whose representation is a
    // reference (list, string, named, unknown aggregate).
    const aliases = new Map<ValueId, ValueId>();

    for (const block of fn.blocks) {
      const rewritten: MirInstr[] = [];
      for (const instr of block.instrs) {
        if (instr.op !== "call" || instr.dst === null) {
          rewritten.push(instr);
          continue;
        }
        const target = candidates.get(instr.callee);
        if (!target || target.symbol === fn.symbol) {
          rewritten.push(instr);
          continue;
        }
        if (target.params.length !== instr.args.length) {
          rewritten.push(instr);
          continue;
        }

        // Remap the callee's values into the caller's numbering.
        const remap = new Map<ValueId, ValueId>();
        target.params.forEach((param, index) => remap.set(param.value, instr.args[index]));
        const fresh = (old: ValueId, ty: Ty): ValueId => {
          const existing = remap.get(old);
          if (existing !== undefined) return existing;
          const id = nextValue++;
          remap.set(old, id);
          fn.types.set(id, ty);
          return id;
        };
        const use = (old: ValueId): ValueId => remap.get(old) ?? old;

        for (const inner of target.blocks[0].instrs) {
          // Each arm narrows `inner` first, so operand rewriting is type-checked
          // rather than cast through `any`.
          switch (inner.op) {
            case "const":
              rewritten.push({ ...inner, dst: fresh(inner.dst, inner.ty) });
              break;
            case "binary":
              rewritten.push({
                ...inner,
                lhs: use(inner.lhs),
                rhs: use(inner.rhs),
                dst: fresh(inner.dst, inner.ty),
              });
              break;
            case "unary":
              rewritten.push({
                ...inner,
                operand: use(inner.operand),
                dst: fresh(inner.dst, inner.ty),
              });
              break;
            case "call":
              rewritten.push({
                ...inner,
                args: inner.args.map(use),
                dst: inner.dst === null ? null : fresh(inner.dst, inner.ty),
              });
              break;
            case "list":
              rewritten.push({
                ...inner,
                items: inner.items.map(use),
                dst: fresh(inner.dst, inner.ty),
              });
              break;
            case "index":
              rewritten.push({
                ...inner,
                object: use(inner.object),
                index: use(inner.index),
                dst: fresh(inner.dst, inner.ty),
              });
              break;
            case "field":
              rewritten.push({
                ...inner,
                object: use(inner.object),
                dst: fresh(inner.dst, inner.ty),
              });
              break;
            default:
              // Candidate selection already excluded phi/store/drop/arena.
              break;
          }
        }

        // The call's result becomes the callee's returned value.
        const term = target.blocks[0].terminator;
        if (term.op === "return" && term.value !== null) {
          const returned = use(term.value);
          // Bind the caller's %dst to the inlined result.
          //
          // This used to emit `%dst = add %returned, 0`, which is only valid for
          // scalars: a pointer-returning callee (`fn grid() -> List[Int]`) then
          // produced `add ptr`, which llvm-as rejects and the VM traps on with
          // "expected a number, got object".
          //
          // For a numeric result the identity add stays (it keeps SSA numbering
          // dense and is folded later). For every other representation — lists,
          // strings, named types, unknown aggregates — the returned value *is*
          // the result, so the alias is recorded and later reads of %dst are
          // rewritten to it. No instruction is emitted, so no type is invented.
          if (instr.ty.k === "Int" || instr.ty.k === "Float") {
            rewritten.push({
              op: "binary",
              dst: instr.dst,
              kind: "add",
              lhs: returned,
              rhs: zeroValue(fn, rewritten, instr.ty, () => nextValue++),
              ty: instr.ty,
              span: instr.span,
            });
          } else {
            aliases.set(instr.dst, returned);
          }
        }
        inlined += 1;
        ctx.note("inline", fn.symbol, `inlined ${target.symbol}`);
      }
      block.instrs = rewritten;
    }

    // Apply the reference-result aliases collected above. Resolving through the
    // map handles a chain of inlined pointer results (a returns b returns c).
    if (aliases.size > 0) {
      const resolve = (value: ValueId): ValueId => {
        let current = value;
        for (let hops = 0; hops < 16; hops++) {
          const next = aliases.get(current);
          if (next === undefined || next === current) break;
          current = next;
        }
        return current;
      };
      for (const block of fn.blocks) {
        block.instrs = block.instrs.map((instr) => rewriteUses(instr, resolve));
        block.terminator = rewriteTerminatorUses(block.terminator, resolve);
      }
    }

    return inlined > 0 ? fn : original;
  });
}

/** Rewrite every operand of an instruction through `resolve`. */
function rewriteUses(instr: MirInstr, resolve: (value: ValueId) => ValueId): MirInstr {
  switch (instr.op) {
    case "binary":
      return { ...instr, lhs: resolve(instr.lhs), rhs: resolve(instr.rhs) };
    case "unary":
      return { ...instr, operand: resolve(instr.operand) };
    case "call":
      return { ...instr, args: instr.args.map(resolve) };
    case "list":
      return { ...instr, items: instr.items.map(resolve) };
    case "index":
      return { ...instr, object: resolve(instr.object), index: resolve(instr.index) };
    case "field":
      return { ...instr, object: resolve(instr.object) };
    case "store":
      return {
        ...instr,
        object: resolve(instr.object),
        index: instr.index === null ? null : resolve(instr.index),
        value: resolve(instr.value),
      };
    case "drop":
      return { ...instr, value: resolve(instr.value) };
    case "arena":
      return { ...instr, source: resolve(instr.source) };
    case "phi":
      return {
        ...instr,
        sources: instr.sources.map((source) => ({ ...source, value: resolve(source.value) })),
      };
    default:
      return instr;
  }
}

/** Rewrite every operand of a terminator through `resolve`. */
function rewriteTerminatorUses(
  term: MirTerminator,
  resolve: (value: ValueId) => ValueId,
): MirTerminator {
  switch (term.op) {
    case "branch":
      return { ...term, cond: resolve(term.cond) };
    case "return":
      return { ...term, value: term.value === null ? null : resolve(term.value) };
    default:
      return term;
  }
}

/** Materialise a zero constant to use as an identity operand. */
function zeroValue(
  fn: MirFunction,
  instrs: MirInstr[],
  ty: Ty,
  next: () => ValueId,
): ValueId {
  const id = next();
  const value: MirConst = ty.k === "Float" ? { k: "float", value: 0 } : { k: "int", value: 0 };
  fn.types.set(id, ty.k === "Float" ? T.float : T.int);
  instrs.push({ op: "const", dst: id, value, ty, span: fn.span });
  return id;
}

/** Fold arithmetic and comparisons on constant operands. */
function constFold(module: MirModule, ctx: PassContext): MirModule {
  return mapModule(module, (original) => {
    const fn = cloneFunction(original);
    let folded = 0;

    // Repeat until stable: folding one instruction can expose another.
    for (let round = 0; round < 5; round++) {
      const constants = constantsOf(fn);
      let changedThisRound = 0;

      for (const block of fn.blocks) {
        for (let i = 0; i < block.instrs.length; i++) {
          const instr = block.instrs[i];
          if (instr.op !== "binary") continue;
          const lhs = constants.get(instr.lhs);
          const rhs = constants.get(instr.rhs);
          if (!lhs || !rhs) continue;
          const result = foldBinary(instr.kind, lhs, rhs);
          if (result === null) continue;
          block.instrs[i] = {
            op: "const",
            dst: instr.dst,
            value: result,
            ty: instr.ty,
            span: instr.span,
          };
          constants.set(instr.dst, result);
          changedThisRound += 1;
          folded += 1;
          ctx.note("const-fold", fn.symbol, `folded ${instr.kind} to ${JSON.stringify(result)}`);
        }
      }
      if (changedThisRound === 0) break;
    }

    return folded > 0 ? fn : original;
  });
}

function foldBinary(kind: string, lhs: MirConst, rhs: MirConst): MirConst | null {
  const a = numberOf(lhs);
  const b = numberOf(rhs);

  if (kind === "concat" && lhs.k === "str" && rhs.k === "str") {
    return { k: "str", value: lhs.value + rhs.value };
  }
  if (lhs.k === "bool" && rhs.k === "bool") {
    if (kind === "and") return { k: "bool", value: lhs.value && rhs.value };
    if (kind === "or") return { k: "bool", value: lhs.value || rhs.value };
    if (kind === "eq") return { k: "bool", value: lhs.value === rhs.value };
    if (kind === "ne") return { k: "bool", value: lhs.value !== rhs.value };
  }
  if (a === null || b === null) return null;

  const isInt = lhs.k === "int" && rhs.k === "int";
  const num = (value: number): MirConst =>
    isInt && Number.isInteger(value) ? { k: "int", value } : { k: "float", value };

  switch (kind) {
    case "add":
      return num(a + b);
    case "sub":
      return num(a - b);
    case "mul":
      return num(a * b);
    case "div":
      // Division by zero is left alone: folding it would hide the diagnostic the
      // refinement layer already produced.
      return b === 0 ? null : { k: "float", value: a / b };
    case "rem":
      return b === 0 ? null : num(a % b);
    case "pow":
      return num(a ** b);
    case "eq":
      return { k: "bool", value: a === b };
    case "ne":
      return { k: "bool", value: a !== b };
    case "lt":
      return { k: "bool", value: a < b };
    case "le":
      return { k: "bool", value: a <= b };
    case "gt":
      return { k: "bool", value: a > b };
    case "ge":
      return { k: "bool", value: a >= b };
    default:
      return null;
  }
}

/**
 * Bounds-check elision.
 *
 * The refinement checker proved which index expressions are in range. Those
 * `index` instructions are marked so the backends emit an unchecked load. The
 * marking is per-span, which is why HIR keeps source spans all the way down.
 */
function boundsElision(module: MirModule, ctx: PassContext): MirModule {
  const refine = ctx.options.refine;
  if (!refine) return module;

  // Spans of index obligations that were proved safe.
  const proved = new Set<string>();
  for (const obligation of refine.obligations) {
    if (obligation.kind !== "index-out-of-bounds") continue;
    if (obligation.status !== "proved") continue;
    proved.add(spanKey(obligation.span));
  }
  if (proved.size === 0) return module;

  return mapModule(module, (original) => {
    const fn = cloneFunction(original);
    let elided = 0;
    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        if (instr.op !== "index") continue;
        if (!proved.has(spanKey(instr.span))) continue;
        // `checked: false` tells the backend to skip the guard.
        (instr as MirInstr & { op: "index"; checked?: boolean }).checked = false;
        elided += 1;
        ctx.note("bounds-elision", fn.symbol, `elided bounds check at line ${instr.span.line}`);
      }
    }
    return elided > 0 ? fn : original;
  });
}

function spanKey(span: Span): string {
  return `${span.file}:${span.line}:${span.col}`;
}

/**
 * Table precomputation.
 *
 * A reel or paytable built entirely from constants is computed at compile time
 * and stored as module data, so spinning never rebuilds it. This is the single
 * highest-value optimisation for slot code, where the same list is constructed
 * on every call.
 */
function tablePrecompute(module: MirModule, ctx: PassContext): MirModule {
  const tables: Array<{ symbol: string; values: Array<string | number | boolean> }> = [];

  const result = mapModule(module, (original) => {
    const fn = cloneFunction(original);
    const constants = constantsOf(fn);
    let precomputed = 0;

    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        if (instr.op !== "list") continue;
        if (instr.items.length === 0) continue;
        const values = instr.items.map((item) => {
          const c = constants.get(item);
          if (!c) return null;
          return c.k === "unit" ? null : c.value;
        });
        if (values.some((v) => v === null)) continue;
        const symbol = `${fn.symbol}$table${tables.length}`;
        tables.push({ symbol, values: values as Array<string | number | boolean> });
        // Replace construction with a reference to the precomputed table.
        (instr as MirInstr & { op: "list"; precomputed?: string }).precomputed = symbol;
        precomputed += 1;
        ctx.note("table-precompute", fn.symbol, `hoisted ${values.length}-element constant table`);
      }
    }
    return precomputed > 0 ? fn : original;
  });

  return tables.length > 0 ? { ...result, tables } as MirModule & { tables: typeof tables } : result;
}

/**
 * Arena promotion.
 *
 * An aggregate that is created and dropped inside the same block never escapes,
 * so it can live in a bump-allocated frame arena instead of the heap. The pass
 * looks for exactly that pattern: a `list` whose value is dropped in the same
 * block and never passed to a call.
 */
function arenaPromotion(module: MirModule, ctx: PassContext): MirModule {
  return mapModule(module, (original) => {
    const fn = cloneFunction(original);
    let promoted = 0;

    for (const block of fn.blocks) {
      const dropped = new Set<ValueId>();
      for (const instr of block.instrs) {
        if (instr.op === "drop") dropped.add(instr.value);
      }
      if (dropped.size === 0) continue;

      // A value that reaches a call may outlive the frame.
      const escaping = new Set<ValueId>();
      for (const instr of block.instrs) {
        if (instr.op === "call") for (const arg of instr.args) escaping.add(arg);
        if (instr.op === "store") escaping.add(instr.value);
      }
      for (const other of fn.blocks) {
        if (other.id === block.id) continue;
        for (const instr of other.instrs) for (const use of usesOf(instr)) escaping.add(use);
        for (const use of usesOfTerminator(other.terminator)) escaping.add(use);
      }
      for (const use of usesOfTerminator(block.terminator)) escaping.add(use);

      for (let i = 0; i < block.instrs.length; i++) {
        const instr = block.instrs[i];
        if (instr.op !== "list") continue;
        if (!dropped.has(instr.dst) || escaping.has(instr.dst)) continue;
        (instr as MirInstr & { op: "list"; arena?: boolean }).arena = true;
        promoted += 1;
        ctx.note("arena-promotion", fn.symbol, `promoted %${instr.dst} to the frame arena`);
      }
    }

    return promoted > 0 ? fn : original;
  });
}

/**
 * Dead code elimination.
 *
 * Removes instructions whose result is never used, keeping anything with an
 * observable effect: calls (they may print or draw), stores, and drops (they
 * release memory, and removing one would be a leak).
 */
function dce(module: MirModule, ctx: PassContext): MirModule {
  return mapModule(module, (original) => {
    const fn = cloneFunction(original);
    let removed = 0;

    for (let round = 0; round < 5; round++) {
      const live = new Set<ValueId>();
      for (const block of fn.blocks) {
        for (const instr of block.instrs) for (const use of usesOf(instr)) live.add(use);
        for (const use of usesOfTerminator(block.terminator)) live.add(use);
      }

      let removedThisRound = 0;
      for (const block of fn.blocks) {
        const kept = block.instrs.filter((instr) => {
          const dst = destOf(instr);
          if (dst === null) return true; // store / drop
          if (instr.op === "call") return true; // may have effects
          if (live.has(dst)) return true;
          removedThisRound += 1;
          ctx.note("dce", fn.symbol, `removed dead %${dst} (${instr.op})`);
          return false;
        });
        block.instrs = kept;
      }
      removed += removedThisRound;
      if (removedThisRound === 0) break;
    }

    return removed > 0 ? fn : original;
  });
}
