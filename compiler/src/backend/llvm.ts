/**
 * LLVM backend.
 *
 * Emits textual LLVM IR (`.ll`) from SunMIR. Text rather than bitcode is a
 * deliberate choice: `.ll` is what `llc`/`clang` accept directly, it is
 * diff-able in tests, and it avoids shipping a bitcode writer for a format that
 * changes between LLVM versions.
 *
 * The mapping is direct because SunMIR is already SSA with explicit blocks:
 *
 *   SunMIR            LLVM
 *   ------            ----
 *   %n                %vn      (named, not numbered — see emitFunction)
 *   bb0               bb0:
 *   phi               phi
 *   branch            br i1
 *   Int               i64
 *   Float             double
 *   Bool              i1
 *   Str / List        ptr  (opaque, runtime-managed)
 *   drop              call void @sunra_release
 *
 * Aggregates stay opaque pointers handled by the runtime library, which is what
 * keeps this backend small while still producing IR that links.
 */
import type { Ty } from "../checker/checker.js";
import {
  type MirBlock,
  type MirConst,
  type MirFunction,
  type MirInstr,
  type MirModule,
} from "../mir/mir.js";
import {
  isRuntimeNamespaceCall,
  runtimeAbi,
  runtimeAbiTable,
  type AbiKind,
} from "./runtime_abi.js";

export type LlvmTarget = "x86_64" | "aarch64";

export interface LlvmOptions {
  target?: LlvmTarget;
  /** Emitted as the module's source_filename. */
  file?: string;
}

export interface LlvmOutput {
  ir: string;
  target: LlvmTarget;
  triple: string;
  dataLayout: string;
  /** Functions that were emitted, for the build report. */
  functions: string[];
  /** Functions that could not be lowered, with the reason. */
  skipped: Array<{ symbol: string; reason: string }>;
}

type LlvmFunctionTypes = Map<string, { params: Ty[]; ret: Ty }>;
type LlvmGameConstants = ReadonlyMap<string, MirConst>;

const TRIPLES: Record<LlvmTarget, string> = {
  x86_64: "x86_64-unknown-linux-gnu",
  aarch64: "aarch64-unknown-linux-gnu",
};

/**
 * Data layouts copied from what clang emits for each triple. They matter: LLVM
 * uses them for alignment and struct layout decisions, and a wrong layout
 * produces code that works on one machine and crashes on another.
 */
const LAYOUTS: Record<LlvmTarget, string> = {
  x86_64: "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128",
  aarch64: "e-m:e-i8:8:32-i16:16:32-i64:64-i128:128-n32:64-S128",
};

/** Runtime functions the generated IR calls into. */
const RUNTIME_DECLS = [
  "declare ptr @sunra_list_new(i64)",
  "declare void @sunra_list_set(ptr, i64, i64)",
  "declare i64 @sunra_list_get(ptr, i64)",
  "declare i64 @sunra_list_get_checked(ptr, i64)",
  "declare void @sunra_list_set_ptr(ptr, i64, ptr)",
  "declare ptr @sunra_list_get_ptr(ptr, i64)",
  "declare ptr @sunra_list_get_checked_ptr(ptr, i64)",
  "declare i64 @sunra_list_len(ptr)",
  "declare i64 @__sunra_list_first_i64(ptr)",
  "declare i64 @__sunra_list_last_i64(ptr)",
  "declare i64 @__sunra_list_sum_i64(ptr)",
  "declare i64 @__sunra_list_min_i64(ptr)",
  "declare i64 @__sunra_list_max_i64(ptr)",
  "declare double @__sunra_list_first_f64(ptr)",
  "declare double @__sunra_list_last_f64(ptr)",
  "declare double @__sunra_list_sum_f64(ptr)",
  "declare double @__sunra_list_min_f64(ptr)",
  "declare double @__sunra_list_max_f64(ptr)",
  "declare i64 @__sunra_len(ptr)",
  "declare ptr @sunra_str_new(ptr, i64)",
  "declare ptr @sunra_str_concat(ptr, ptr)",
  // Builtin method ABI: one runtime helper per lowered method. Aggregates and
  // strings share the opaque `ptr` representation, so a single helper serves
  // both receiver kinds and dispatches on the runtime tag.
  "declare ptr @__sunra_push(ptr, ptr)",
  "declare ptr @__sunra_pop(ptr)",
  "declare i1 @__sunra_contains(ptr, ptr)",
  "declare i64 @__sunra_index_of(ptr, ptr)",
  "declare ptr @__sunra_slice(ptr, i64, i64)",
  "declare ptr @__sunra_concat(ptr, ptr)",
  "declare ptr @__sunra_reverse(ptr)",
  "declare ptr @__sunra_first(ptr)",
  "declare ptr @__sunra_last(ptr)",
  "declare i64 @__sunra_count(ptr, ptr)",
  "declare ptr @__sunra_join(ptr, ptr)",
  "declare ptr @__sunra_take(ptr, i64)",
  "declare i64 @__sunra_sum_int(ptr)",
  "declare double @__sunra_sum_float(ptr)",
  "declare ptr @__sunra_upper(ptr)",
  "declare ptr @__sunra_lower(ptr)",
  "declare ptr @__sunra_trim(ptr)",
  "declare ptr @__sunra_split(ptr, ptr)",
  "declare ptr @__sunra_chars(ptr)",
  "declare i64 @__sunra_abs_i64(i64)",
  "declare double @__sunra_abs_f64(double)",
  "declare i64 @__sunra_floor(double)",
  "declare i64 @__sunra_round(double)",
  "declare double @__sunra_sqrt(double)",
  "declare i64 @__sunra_min_i64(i64, i64)",
  "declare i64 @__sunra_max_i64(i64, i64)",
  "declare double @__sunra_min_f64(double, double)",
  "declare double @__sunra_max_f64(double, double)",
  "declare void @__sunra_assert(i1, ptr)",
  "declare void @sunra_release(ptr)",
  "declare ptr @sunra_arena_alloc(i64)",
  "declare double @sunra_field_bet(ptr)",
  "declare double @sunra_field_rtp(ptr)",
  "declare double @sunra_field_tolerance(ptr)",
  "declare void @sunra_print_i64(i64)",
  "declare void @sunra_print_double(double)",
  "declare void @sunra_print_str(ptr)",
  "declare void @sunra_print_ptr(ptr)",
  "declare ptr @sunra_str_from_i64(i64)",
  "declare ptr @sunra_str_from_double(double)",
  "declare ptr @sunra_str_from_bool(i1)",
  "declare ptr @sunra_str_from_ptr(ptr)",
  "declare double @sunra_float_from_i64(i64)",
  "declare double @sunra_float_from_ptr(ptr)",
  "declare i64 @sunra_int_from_double(double)",
  "declare i64 @sunra_int_from_ptr(ptr)",
  "declare i64 @sunra_rng_next(i64)",
  "declare ptr @range(i64, i64)",
  "declare ptr @row.join(ptr)",
  "declare void @sunra_panic(ptr)",
];

/**
 * Declarations for the runtime namespaces, generated from the single ABI table
 * so a `declare` line can never drift from the `call` the backend emits.
 *
 * Variadic runtime helpers (`Reel.spin(reel)` / `Reel.spin(reel, rows)`) are
 * declared with a C-style `...` tail, which is what lets one declaration serve
 * every arity the interpreter accepts.
 */
function runtimeNamespaceDecls(): string[] {
  return runtimeAbiTable().map((entry) => {
    const params = entry.params.map((kind) => llvmType(abiTy(kind)));
    if (entry.variadic !== undefined) params.push("...");
    const ret = entry.ret === "Unit" ? "void" : llvmType(abiTy(entry.ret));
    return `declare ${ret} @${entry.symbol}(${params.join(", ")})`;
  });
}

/** Map an ABI shape onto the compiler surface type the backend already lowers. */
function abiTy(kind: AbiKind): Ty {
  switch (kind) {
    case "Int":
      return { k: "Int" };
    case "Float":
      return { k: "Float" };
    case "Bool":
      return { k: "Bool" };
    case "Str":
      return { k: "Str" };
    case "Unit":
      return { k: "Unit" };
    case "Ref":
      return { k: "Unknown" };
  }
}

export function emitLlvm(module: MirModule, options: LlvmOptions = {}): LlvmOutput {
  const target = options.target ?? "x86_64";
  const triple = TRIPLES[target];
  const dataLayout = LAYOUTS[target];
  const emitted: string[] = [];
  const skipped: Array<{ symbol: string; reason: string }> = [];
  const functionTypes = inferFunctionTypes(module);
  const gameConstants = new Map<string, LlvmGameConstants>();
  for (const game of module.games) {
    const constants = new Map<string, MirConst>();
    for (const field of game.fields) {
      if (field.value !== null) constants.set(field.name, field.value);
    }
    gameConstants.set(game.name, constants);
  }

  const lines: string[] = [];
  lines.push(`; Generated by the Sunra compiler`);
  lines.push(`source_filename = "${options.file ?? module.file}"`);
  lines.push(`target datalayout = "${dataLayout}"`);
  lines.push(`target triple = "${triple}"`);
  lines.push("");

  // String constants become private globals, as LLVM has no inline string type.
  const strings = new Map<string, string>();
  const stringGlobal = (value: string): string => {
    const existing = strings.get(value);
    if (existing) return existing;
    const name = `@.str.${strings.size}`;
    strings.set(value, name);
    return name;
  };

  const bodies: string[] = [];
  // Game field accessors are discovered while emitting bodies, then declared.
  // `bet`, `rtp` and `tolerance` already have fixed declarations in
  // RUNTIME_DECLS, so they are excluded to avoid a duplicate.
  const fieldAccessors = new Map<string, string>();
  for (const fn of module.functions) {
    const owner = fn.symbol.includes(".") ? fn.symbol.slice(0, fn.symbol.indexOf(".")) : null;
    const result = emitFunction(fn, stringGlobal, functionTypes, fieldAccessors, owner ? gameConstants.get(owner) : undefined);
    if (result.skipped) {
      skipped.push({ symbol: fn.symbol, reason: result.skipped });
      continue;
    }
    emitted.push(fn.symbol);
    bodies.push(result.text);
  }

  // Emit globals after collecting them, before the function bodies.
  for (const [value, name] of strings) {
    const bytes = encodeLlvmString(value);
    lines.push(
      `${name} = private unnamed_addr constant [${bytes.length} x i8] c"${bytes.text}", align 1`,
    );
  }
  if (strings.size > 0) lines.push("");

  const predeclaredFields = new Set(["sunra_field_bet", "sunra_field_rtp", "sunra_field_tolerance"]);
  const fieldDecls = [...fieldAccessors.entries()]
    .filter(([name]) => !predeclaredFields.has(name))
    .map(([name, ret]) => `declare ${ret} @${name}(ptr)`);
  lines.push(...RUNTIME_DECLS, ...runtimeNamespaceDecls(), ...fieldDecls, "");
  lines.push(...bodies);

  return { ir: lines.join("\n"), target, triple, dataLayout, functions: emitted, skipped };
}

function emitFunction(
  fn: MirFunction,
  stringGlobal: (value: string) => string,
  functionTypes: LlvmFunctionTypes,
  fieldAccessors: Map<string, string>,
  gameConstants?: LlvmGameConstants,
): { text: string; skipped?: string } {
  const out: string[] = [];
  // Values are emitted as *named* temporaries (`%v7`), not LLVM's unnamed ones
  // (`%7`). LLVM requires unnamed temporaries to be numbered consecutively from
  // the parameter count in every function, and rejects the module otherwise.
  // SunMIR value ids are per-function counters that the optimizer leaves sparse
  // after dead-code elimination — `main` could start at `%2` with `%0` and `%1`
  // never defined, which `llvm-as` refuses. Named values carry no ordering rule,
  // so the IR stays assemblable however the MIR is renumbered, and the ids still
  // line up with `sunra dump-mir` for debugging.
  const signature = functionTypes.get(fn.symbol);
  const params = fn.params.map((p, index) => `${llvmType(signature?.params[index] ?? llvmValueType(fn, p.value, functionTypes))} %v${p.value}`).join(", ");
  const attrs = fn.attributes.some((a) => a.name === "no_panic") ? " nounwind" : "";
  out.push(`define ${llvmType(signature?.ret ?? inferredFunctionReturnTy(fn, functionTypes))} @${mangle(fn.symbol)}(${params})${attrs} {`);
  // Coercion temporaries are numbered per function, so a use site can always
  // materialise one without colliding with a MIR value id.
  const scratch = { next: 0 };

  // Phi incomings that need a cast must have it materialised in the predecessor
  // block, so bodies are rendered per block first and stitched afterwards.
  const pendingPhiCasts: Array<{ block: number; line: string }> = [];
  const rendered: Array<{ id: number; body: string[]; terminator: string }> = [];
  for (const block of fn.blocks) {
    const body: string[] = [];
    for (const instr of block.instrs) {
      const text = emitInstr(
        instr,
        fn,
        stringGlobal,
        functionTypes,
        scratch,
        fieldAccessors,
        pendingPhiCasts,
        gameConstants,
      );
      if (text === null) return { text: "", skipped: `unsupported instruction: ${instr.op}` };
      if (text.length > 0) body.push(`  ${text}`);
    }
    rendered.push({ id: block.id, body, terminator: `  ${emitTerminator(block, fn, functionTypes, scratch)}` });
  }
  for (const block of rendered) {
    out.push(`bb${block.id}:`);
    out.push(...block.body);
    for (const cast of pendingPhiCasts) {
      if (cast.block === block.id) out.push(`  ${cast.line}`);
    }
    out.push(block.terminator);
  }

  out.push("}");
  out.push("");
  return { text: out.join("\n") };
}

function emitInstr(
  instr: MirInstr,
  fn: MirFunction,
  stringGlobal: (value: string) => string,
  functionTypes: LlvmFunctionTypes,
  scratch: { next: number },
  fieldAccessors: Map<string, string>,
  pendingPhiCasts: Array<{ block: number; line: string }>,
  gameConstants?: LlvmGameConstants,
): string | null {
  switch (instr.op) {
    case "const":
      return emitConst(instr, stringGlobal);

    case "phi": {
      // The phi's type comes from the same authority every other use site
      // consults, so a consumer typed from `llvmValueType` cannot disagree with
      // the phi it reads.
      const phiTy = llvmValueType(fn, instr.dst, functionTypes);
      const ty = llvmType(phiTy);
      // Unit is represented as `void` in LLVM, and void cannot be the type of
      // a phi/value. Unit-producing branches are control-flow only; the
      // function terminator emits `ret void` and the synthetic value is unused.
      if (ty === "void") return "";
      // Incomings must already have the phi's type: a conversion cannot be
      // emitted here, because a phi operand has to be available at the end of the
      // predecessor block, not in the phi's own block. Any conversion is instead
      // registered as a *pending* one, which `emitFunction` appends to the
      // predecessor block before its terminator.
      const sources = instr.sources
        .map((s) => {
          const actual = llvmType(llvmValueType(fn, s.value, functionTypes));
          if (actual === ty) return `[ %v${s.value}, %bb${s.block} ]`;
          const dst = `%vc${scratch.next++}`;
          const conversion = llvmCoercion(actual, ty, `%v${s.value}`, dst);
          if (conversion === null) return `[ %v${s.value}, %bb${s.block} ]`;
          pendingPhiCasts.push({ block: s.block, line: conversion });
          return `[ ${dst}, %bb${s.block} ]`;
        })
        .join(", ");
      return `%v${instr.dst} = phi ${ty} ${sources}`;
    }

    case "binary":
      return emitBinary(instr, fn, functionTypes, scratch);

    case "unary": {
      const ty = llvmType(instr.ty);
      if (instr.kind === "neg") {
        return instr.ty.k === "Float"
          ? `%v${instr.dst} = fneg double %v${instr.operand}`
          : `%v${instr.dst} = sub ${ty} 0, %v${instr.operand}`;
      }
      return `%v${instr.dst} = xor i1 %v${instr.operand}, true`;
    }

    case "call":
      return emitCall(instr, fn, stringGlobal, functionTypes, gameConstants);

    case "list": {
      // `arena` and `precomputed` annotations from the optimiser change which
      // allocator is used, which is the whole point of those passes.
      const arena = (instr as MirInstr & { op: "list"; arena?: boolean }).arena === true;
      const allocator = arena ? "@sunra_arena_alloc" : "@sunra_list_new";
      const elementTy = instr.ty.k === "List" ? instr.ty.of : ({ k: "Unknown" } as Ty);
      const elementLlvmTy = llvmType(elementTy);
      const setter = elementLlvmTy === "ptr" ? "@sunra_list_set_ptr" : "@sunra_list_set";
      const lines = [`%v${instr.dst} = call ptr ${allocator}(i64 ${instr.items.length})`];
      instr.items.forEach((item, index) => {
        // Elements are written in the list's element type; a literal whose own
        // type differs (mixed inference across call sites) is converted first.
        const coerced = coerceOperand(item, elementLlvmTy, fn, functionTypes, scratch);
        for (const line of coerced.prelude) lines.push(`  ${line}`);
        lines.push(`  call void ${setter}(ptr %v${instr.dst}, i64 ${index}, ${elementLlvmTy} ${coerced.operand})`);
      });
      return lines.join("\n");
    }

    case "index": {
      // An elided bounds check calls the unchecked accessor.
      const checked = (instr as MirInstr & { op: "index"; checked?: boolean }).checked !== false;
      const elementTy = instr.ty;
      const elementLlvmTy = llvmType(elementTy);
      const callee = elementLlvmTy === "ptr"
        ? (checked ? "@sunra_list_get_checked_ptr" : "@sunra_list_get_ptr")
        : (checked ? "@sunra_list_get_checked" : "@sunra_list_get");
      // The container is always a `ptr` and the index an `i64`; a value that was
      // inferred otherwise (a scalar-typed handle coming from a helper) is
      // converted rather than passed in the wrong slot.
      const object = coerceOperand(instr.object, "ptr", fn, functionTypes, scratch);
      const index = coerceOperand(instr.index, "i64", fn, functionTypes, scratch);
      const prelude = [...object.prelude, ...index.prelude];
      const call = `%v${instr.dst} = call ${elementLlvmTy} ${callee}(ptr ${object.operand}, i64 ${index.operand})`;
      return prelude.length > 0 ? `${prelude.join("\n  ")}\n  ${call}` : call;
    }

    case "field": {
      // Fields on runtime objects go through a named accessor. Dynamic game
      // fields are Unknown in the checker, but the canonical numeric fields
      // still have a concrete native ABI.
      const fieldTy = llvmFieldType(instr.name, instr.ty);
      const accessor = `sunra_field_${sanitize(instr.name)}`;
      const retTy = llvmType(fieldTy);
      // Accessors are declared on demand: a game may expose any field name, so a
      // fixed declaration list would always be incomplete (the cause of
      // `use of undefined value '@sunra_field_cap'`). The first use fixes the
      // signature and later uses reuse it.
      const existing = fieldAccessors.get(accessor);
      if (existing === undefined) fieldAccessors.set(accessor, retTy);
      const declaredTy = existing ?? retTy;
      if (declaredTy === "void") return materializeZero(instr.dst, { k: "Int" });
      if (declaredTy === retTy) {
        return `%v${instr.dst} = call ${retTy} @${accessor}(ptr %v${instr.object})`;
      }
      // The same field was already declared with another shape; call it in the
      // declared shape and convert, rather than emitting a second, conflicting
      // declaration.
      const temp = `%vc${scratch.next++}`;
      const conversion = llvmCoercion(declaredTy, retTy, temp, `%v${instr.dst}`);
      const call = `${temp} = call ${declaredTy} @${accessor}(ptr %v${instr.object})`;
      return conversion === null
        ? `${call}\n  %v${instr.dst} = ${declaredTy === "double" ? "fadd double" : declaredTy === "ptr" ? "getelementptr i8, ptr" : "add i64"} ${temp}, ${declaredTy === "double" ? "0.000000e+00" : "0"}`
        : `${call}\n  ${conversion}`;
    }

    case "store":
      if (instr.index !== null) {
        const valueTy = fn.types.get(instr.value) ?? ({ k: "Unknown" } as Ty);
        const valueLlvmTy = llvmType(valueTy);
        const setter = valueLlvmTy === "ptr" ? "@sunra_list_set_ptr" : "@sunra_list_set";
        return `call void ${setter}(ptr %v${instr.object}, i64 %v${instr.index}, ${valueLlvmTy} %v${instr.value})`;
      }
      return `call void @sunra_field_set_${sanitize(instr.field ?? "value")}(ptr %v${instr.object}, i64 %v${instr.value})`;

    case "drop":
      // Explicit release: this is where SunMIR's drop schedule becomes real.
      return `call void @sunra_release(ptr %v${instr.value})`;

    case "arena":
      return `%v${instr.dst} = call ptr @sunra_arena_alloc(i64 8)`;
  }
}

function emitConst(
  instr: MirInstr & { op: "const" },
  stringGlobal: (value: string) => string,
): string {
  const value = instr.value;
  switch (value.k) {
    case "int":
      // LLVM has no "assign a literal" instruction; `add 0` is the idiomatic way
      // to materialise a constant into a named SSA value.
      return `%v${instr.dst} = add i64 0, ${Math.trunc(value.value)}`;
    case "float":
      return `%v${instr.dst} = fadd double 0.0, ${formatDouble(value.value)}`;
    case "bool":
      return `%v${instr.dst} = or i1 false, ${value.value ? "true" : "false"}`;
    case "str": {
      const global = stringGlobal(value.value);
      const bytes = encodeLlvmString(value.value);
      return `%v${instr.dst} = call ptr @sunra_str_new(ptr getelementptr inbounds ([${bytes.length} x i8], ptr ${global}, i64 0, i64 0), i64 ${bytes.length - 1})`;
    }
    case "unit":
      return `%v${instr.dst} = add i64 0, 0`;
  }
}

function emitBinary(
  instr: MirInstr & { op: "binary" },
  fn: MirFunction,
  functionTypes: LlvmFunctionTypes,
  scratch: { next: number },
): string {
  const lhsTy = llvmValueType(fn, instr.lhs, functionTypes);
  const rhsTy = llvmValueType(fn, instr.rhs, functionTypes);
  const operandTy = concreteType(lhsTy) ? lhsTy : concreteType(rhsTy) ? rhsTy : instr.ty;
  const isFloat = lhsTy.k === "Float" || rhsTy.k === "Float" || instr.ty.k === "Float";
  const ty = isFloat ? "double" : llvmType(operandTy);

  // Both operands are brought to the instruction's operand type. Without this an
  // operand whose own type is `ptr` (an unannotated parameter, a list element read
  // through the pointer accessor) would be spliced into `mul i64` or `icmp ne i64`,
  // which `llvm-as` rejects. `emit` prefixes whatever conversions were needed.
  const prelude: string[] = [];
  const operand = (value: number, wanted: string): string => {
    const coerced = coerceOperand(value, wanted, fn, functionTypes, scratch);
    prelude.push(...coerced.prelude);
    return coerced.operand;
  };
  const emit = (text: string): string => (prelude.length > 0 ? `${prelude.join("\n  ")}\n  ${text}` : text);

  // String `+` is represented as an add-like binary node by SunMIR. LLVM has
  // no pointer arithmetic for opaque `ptr`, so lower it through the runtime
  // concatenation ABI instead of emitting the invalid `add ptr` instruction.
  //
  // The same is true of `xs = xs + [x]` on lists: `add ptr` is not a legal LLVM
  // instruction for any reference operand, whatever the surface type was. Any
  // add whose operand type is `ptr` therefore goes to a runtime helper —
  // `__sunra_concat` when either side is a list, `sunra_str_concat` otherwise.
  if (instr.kind === "add" && ty === "ptr") {
    const isList = lhsTy.k === "List" || rhsTy.k === "List";
    const helper = isList ? "@__sunra_concat" : "@sunra_str_concat";
    // A scalar operand reaching a concat helper is converted to its string form
    // rather than passed as a raw `double`/`i64` in a `ptr` position.
    const lhs = operand(instr.lhs, "ptr");
    const rhs = operand(instr.rhs, "ptr");
    return emit(`%v${instr.dst} = call ptr ${helper}(${`ptr ${lhs}, ptr ${rhs}`})`);
  }

  const arith: Record<string, [string, string]> = {
    // [integer opcode, float opcode]
    add: ["add", "fadd"],
    sub: ["sub", "fsub"],
    mul: ["mul", "fmul"],
    div: ["sdiv", "fdiv"],
    rem: ["srem", "frem"],
  };
  if (instr.kind in arith) {
    const [intOp, floatOp] = arith[instr.kind];
    const lhs = operand(instr.lhs, ty);
    const rhs = operand(instr.rhs, ty);
    return emit(`%v${instr.dst} = ${isFloat ? floatOp : intOp} ${ty} ${lhs}, ${rhs}`);
  }

  const cmp: Record<string, [string, string]> = {
    eq: ["eq", "oeq"],
    ne: ["ne", "one"],
    lt: ["slt", "olt"],
    le: ["sle", "ole"],
    gt: ["sgt", "ogt"],
    ge: ["sge", "oge"],
  };
  if (instr.kind in cmp) {
    const [intPred, floatPred] = cmp[instr.kind];
    // The result type of a comparison is Bool, but it must never be used as
    // the operand type. When both operands remain Unknown (common for an
    // unannotated `fn countInGrid(grid, sym)`), Unknown represents a runtime
    // aggregate/reference and therefore lowers to LLVM `ptr`.
    const comparisonTy = concreteType(lhsTy)
      ? lhsTy
      : concreteType(rhsTy)
        ? rhsTy
        : ({ k: "Unknown" } as Ty);
    const comparisonLlvmTy = llvmType(comparisonTy);
    const wanted = isFloat ? "double" : comparisonLlvmTy;
    const lhs = operand(instr.lhs, wanted);
    const rhs = operand(instr.rhs, wanted);
    return emit(
      isFloat
        ? `%v${instr.dst} = fcmp ${floatPred} double ${lhs}, ${rhs}`
        : `%v${instr.dst} = icmp ${intPred} ${comparisonLlvmTy} ${lhs}, ${rhs}`,
    );
  }

  if (instr.kind === "and" || instr.kind === "or") {
    const lhs = operand(instr.lhs, "i1");
    const rhs = operand(instr.rhs, "i1");
    return emit(`%v${instr.dst} = ${instr.kind} i1 ${lhs}, ${rhs}`);
  }
  if (instr.kind === "concat") {
    const lhs = operand(instr.lhs, "ptr");
    const rhs = operand(instr.rhs, "ptr");
    return emit(`%v${instr.dst} = call ptr @sunra_str_concat(ptr ${lhs}, ptr ${rhs})`);
  }
  if (instr.kind === "pow") {
    const lhs = operand(instr.lhs, "double");
    const rhs = operand(instr.rhs, "double");
    return emit(`%v${instr.dst} = call double @llvm.pow.f64(double ${lhs}, double ${rhs})`);
  }
  return `; unsupported binary ${instr.kind}`;
}

/** Resolve an SSA value's backend type when the checker left it as Unknown. */
function llvmValueType(fn: MirFunction, value: number, functionTypes: LlvmFunctionTypes): Ty {
  // A runtime namespace result has exactly one true shape, taken from the shared
  // ABI table. It wins even over a declared MIR type, because the checker records
  // `Unknown` (or a guess) for these dynamic namespace members while the runtime
  // is unambiguous about what comes back.
  const abiTypeOfValue = runtimeAbiResultType(fn, value);
  if (abiTypeOfValue !== null) return abiTypeOfValue;

  const declared = fn.types.get(value);
  if (declared && concreteType(declared)) return declared;

  const param = fn.params.find((p) => p.value === value);
  if (param) {
    const index = fn.params.indexOf(param);
    const signature = functionTypes.get(fn.symbol);
    return signature?.params[index] ?? param.ty;
  }

  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      const dst = "dst" in instr ? instr.dst : null;
      if (dst !== value) continue;
      if (instr.op === "call") {
        if (instr.callee.startsWith("intrinsic.load:")) return llvmIntrinsicType(instr.callee, instr.ty);
        if (instr.callee === "len" || instr.callee.endsWith(".len")) return { k: "Int" };
        const namespaceAbi = runtimeAbi(instr.callee);
        if (namespaceAbi !== null) return abiTy(namespaceAbi.ret);
        const runtime = llvmRuntimeBuiltin(
          instr.callee,
          instr.args.map((arg) => (fn.types.get(arg) ?? ({ k: "Unknown" } as Ty))),
        );
        if (runtime !== null) return runtime.ret;
        return llvmBuiltinSignature(instr.callee)?.ret ?? lookupFunctionType(functionTypes, instr.callee)?.ret ?? instr.ty;
      }
      if (instr.op === "list") return instr.ty;
      if (instr.op === "index") return instr.ty;
      if (instr.op === "field") return llvmFieldType(instr.name, instr.ty);
      if (instr.op === "arena") return instr.ty;
      if (instr.op === "const") return instr.ty;
      if (instr.op === "phi") {
        // Match what the phi will actually be emitted as: the join of its
        // incomings, since `instr.ty` is frequently Unknown after optimisation.
        if (concreteType(instr.ty)) return instr.ty;
        const incoming = instr.sources
          .map((source) => directValueTy(fn, source.value, functionTypes))
          .filter((ty) => concreteType(ty));
        return incoming.length > 0 ? chooseUnifiedType(incoming) : instr.ty;
      }
      if (instr.op === "binary") return binaryResultTy(instr, fn, functionTypes);
      if (instr.op === "unary") return instr.ty;
    }
  }
  return declared ?? ({ k: "Unknown" } as Ty);
}

/**
 * The type a binary instruction will actually produce, derived the same way
 * `emitBinary` derives it.
 *
 * Keeping these two in one place is what stops a consumer from being typed
 * `ptr` while the definition emits `fadd double` (the cause of a spurious
 * `sunra_float_from_ptr` conversion on an already-`double` value).
 */
function binaryResultTy(
  instr: MirInstr & { op: "binary" },
  fn: MirFunction,
  functionTypes: LlvmFunctionTypes,
): Ty {
  const comparisons = new Set(["eq", "ne", "lt", "le", "gt", "ge", "and", "or"]);
  if (comparisons.has(instr.kind)) return { k: "Bool" };
  if (instr.kind === "concat") return { k: "Str" };
  if (instr.kind === "pow") return { k: "Float" };
  const lhsTy = directValueTy(fn, instr.lhs, functionTypes);
  const rhsTy = directValueTy(fn, instr.rhs, functionTypes);
  if (lhsTy.k === "Float" || rhsTy.k === "Float" || instr.ty.k === "Float") return { k: "Float" };
  if (concreteType(instr.ty)) return instr.ty;
  if (concreteType(lhsTy)) return lhsTy;
  if (concreteType(rhsTy)) return rhsTy;
  return instr.ty;
}

/**
 * If `value` is defined by a call into a runtime namespace, the ABI table's
 * return shape; otherwise null. Kept separate so it can run *before* the
 * declared-type shortcut in `llvmValueType`.
 */
function runtimeAbiResultType(fn: MirFunction, value: number): Ty | null {
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.op !== "call") continue;
      if (instr.dst !== value) continue;
      const abi = runtimeAbi(instr.callee);
      return abi === null ? null : abiTy(abi.ret);
    }
  }
  return null;
}

/**
 * Build a stable signature table before emitting any function. The old code
 * returned from the first matching use site, so a later call could disagree
 * with the parameter ABI. We now collect body and cross-function call evidence
 * for every parameter and iterate until the table stops changing.
 */
function inferFunctionTypes(module: MirModule): LlvmFunctionTypes {
  const table: LlvmFunctionTypes = new Map(
    module.functions.map((fn) => [fn.symbol, { params: fn.params.map((param) => param.ty), ret: fn.ret }]),
  );

  for (let pass = 0; pass < module.functions.length + 2; pass += 1) {
    let changed = false;
    for (const fn of module.functions) {
      const signature = table.get(fn.symbol);
      if (!signature) continue;
      const nextParams = fn.params.map((param, index) => {
        const next = unifiedParameterTy(fn, param.value, index, module, table);
        if (!sameTy(next, signature.params[index] ?? ({ k: "Unknown" } as Ty))) changed = true;
        return next;
      });
      const nextRet = inferredFunctionReturnTy(fn, table);
      if (!sameTy(nextRet, signature.ret)) changed = true;
      signature.params = nextParams;
      signature.ret = nextRet;
    }
    if (!changed) break;
  }
  return table;
}

function unifiedParameterTy(
  fn: MirFunction,
  value: number,
  index: number,
  module: MirModule,
  functionTypes: LlvmFunctionTypes,
): Ty {
  const declared = fn.params[index]?.ty;
  if (declared && concreteType(declared)) return declared;

  const evidence = collectBodyEvidence(fn, value, functionTypes);
  for (const caller of module.functions) {
    for (const block of caller.blocks) {
      for (const instr of block.instrs) {
        if (instr.op !== "call" || !matchesFunction(fn, instr.callee)) continue;
        const arg = instr.args[index];
        if (arg === undefined) continue;
        const argTy = directValueTy(caller, arg, functionTypes);
        if (argTy.k !== "Unknown") evidence.push(argTy);
      }
    }
  }
  return chooseUnifiedType(evidence);
}

function collectBodyEvidence(fn: MirFunction, value: number, functionTypes: LlvmFunctionTypes): Ty[] {
  const evidence: Ty[] = [];
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.op === "index") {
        if (instr.object === value) evidence.push({ k: "List", of: { k: "Unknown" } });
        if (instr.index === value) evidence.push({ k: "Int" });
      }
      if (instr.op === "binary" && (instr.lhs === value || instr.rhs === value)) {
        if (instr.kind === "concat") {
          evidence.push({ k: "Str" });
        } else if (instr.kind === "and" || instr.kind === "or") {
          evidence.push({ k: "Bool" });
        } else {
          const other = instr.lhs === value ? instr.rhs : instr.lhs;
          const otherTy = directValueTy(fn, other, functionTypes);
          if (otherTy.k !== "Unknown") evidence.push(otherTy);
        }
      }
      if (instr.op === "call") {
        const argIndex = instr.args.indexOf(value);
        if (argIndex >= 0) {
          const builtin = llvmBuiltinSignature(instr.callee);
          const user = lookupFunctionType(functionTypes, instr.callee);
          const expected = builtin?.params[argIndex] ?? user?.params[argIndex];
          if (expected && expected.k !== "Unknown") evidence.push(expected);
          if (instr.callee.includes("join") || instr.callee.includes("concat")) evidence.push({ k: "Str" });
          if (instr.callee === "range") evidence.push({ k: "Int" });
        }
      }
    }
    if (block.terminator.op === "branch" && block.terminator.cond === value) evidence.push({ k: "Bool" });
  }
  return evidence;
}

function chooseUnifiedType(evidence: Ty[]): Ty {
  const concrete = evidence.filter((ty) => ty.k !== "Unknown" && ty.k !== "Unit");
  if (concrete.length === 0) return { k: "Unknown" };
  // Scalar evidence wins over an aggregate/reference conflict, as required by
  // the ABI rule: one i64 call site is enough to make the parameter i64.
  const float = concrete.find((ty) => ty.k === "Float");
  if (float) return float;
  const integer = concrete.find((ty) => ty.k === "Int");
  if (integer) return integer;
  const bool = concrete.find((ty) => ty.k === "Bool");
  if (bool) return bool;
  const str = concrete.find((ty) => ty.k === "Str");
  if (str) return str;
  return concrete[0];
}

function directValueTy(fn: MirFunction, value: number, functionTypes: LlvmFunctionTypes): Ty {
  // Runtime namespace results are fixed by the ABI table, exactly as in
  // `llvmValueType`; the two must never disagree or a coercion will be inserted
  // against a value that already has the right type.
  const abiResult = runtimeAbiResultType(fn, value);
  if (abiResult !== null) return abiResult;
  const declared = fn.types.get(value);
  if (declared && concreteType(declared)) return declared;
  const param = fn.params.find((candidate) => candidate.value === value);
  if (param) {
    const signature = functionTypes.get(fn.symbol);
    return signature?.params[fn.params.indexOf(param)] ?? param.ty;
  }
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (!("dst" in instr) || instr.dst !== value) continue;
      if (instr.op === "call") {
        if (instr.callee === "len" || instr.callee.endsWith(".len")) return { k: "Int" };
        const runtime = llvmRuntimeBuiltin(
          instr.callee,
          instr.args.map((arg) => (fn.types.get(arg) ?? ({ k: "Unknown" } as Ty))),
        );
        if (runtime !== null) return runtime.ret;
        return llvmBuiltinSignature(instr.callee)?.ret ?? lookupFunctionType(functionTypes, instr.callee)?.ret ?? instr.ty;
      }
      // Arithmetic on floats yields a float even when the MIR node is Unknown,
      // which is what `emitBinary` emits; deriving it here keeps definitions and
      // uses consistent without recursing through phis.
      if (instr.op === "binary") {
        const comparisons = new Set(["eq", "ne", "lt", "le", "gt", "ge", "and", "or"]);
        if (comparisons.has(instr.kind)) return { k: "Bool" };
        if (instr.kind === "concat") return { k: "Str" };
        if (instr.kind === "pow") return { k: "Float" };
        if (concreteType(instr.ty)) return instr.ty;
        // Operand types are resolved the same way parameters are, so an operand
        // that is a parameter (or a phi that merges one) contributes its unified
        // signature type rather than the checker's raw `Unknown`.
        const lhs = shallowOperandTy(fn, instr.lhs, functionTypes);
        const rhs = shallowOperandTy(fn, instr.rhs, functionTypes);
        if (lhs?.k === "Float" || rhs?.k === "Float") return { k: "Float" };
        if (lhs && concreteType(lhs)) return lhs;
        if (rhs && concreteType(rhs)) return rhs;
        return instr.ty;
      }
      return instr.ty;
    }
  }
  return { k: "Unknown" };
}

/**
 * A cheap, non-recursive type for an operand: the declared type, the unified
 * parameter type, or — for a phi — the first concrete type among its incomings
 * resolved the same way. Deliberately shallow so it cannot loop on the
 * back-edge of a loop-carried phi.
 */
function shallowOperandTy(fn: MirFunction, value: number, functionTypes: LlvmFunctionTypes): Ty | undefined {
  const declared = fn.types.get(value);
  if (declared && concreteType(declared)) return declared;
  const param = fn.params.find((candidate) => candidate.value === value);
  if (param) {
    const signature = functionTypes.get(fn.symbol);
    const unified = signature?.params[fn.params.indexOf(param)];
    if (unified && concreteType(unified)) return unified;
    return concreteType(param.ty) ? param.ty : undefined;
  }
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (!("dst" in instr) || instr.dst !== value) continue;
      if (instr.op !== "phi") return concreteType(instr.ty) ? instr.ty : undefined;
      for (const source of instr.sources) {
        const sourceDeclared = fn.types.get(source.value);
        if (sourceDeclared && concreteType(sourceDeclared)) return sourceDeclared;
        const sourceParam = fn.params.find((candidate) => candidate.value === source.value);
        if (sourceParam) {
          const signature = functionTypes.get(fn.symbol);
          const unified = signature?.params[fn.params.indexOf(sourceParam)];
          if (unified && concreteType(unified)) return unified;
        }
      }
      return undefined;
    }
  }
  return undefined;
}

function matchesFunction(fn: MirFunction, callee: string): boolean {
  const base = callee.split("$")[0];
  return fn.symbol === callee || fn.symbol === base || fn.name === base || fn.symbol.endsWith(`.${base}`);
}

function sameTy(left: Ty, right: Ty): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function concreteType(ty: Ty): boolean {
  return ty.k !== "Unknown";
}

function inferredFunctionReturnTy(fn: MirFunction, functionTypes: LlvmFunctionTypes = new Map()): Ty {
  if (fn.ret.k !== "Unknown") return fn.ret;
  for (const block of fn.blocks) {
    if (block.terminator.op !== "return" || block.terminator.value === null) continue;
    const ty = llvmValueType(fn, block.terminator.value, functionTypes);
    if (ty.k !== "Unknown") return ty;
    return ty;
  }
  return { k: "Unit" };
}

function emitCall(
  instr: MirInstr & { op: "call" },
  fn: MirFunction,
  stringGlobal: (value: string) => string,
  functionTypes: LlvmFunctionTypes,
  gameConstants?: LlvmGameConstants,
): string {
  const builtin = llvmBuiltinSignature(instr.callee);

  // Builtins map onto the runtime library.
  if (instr.callee === "print" || instr.callee === "println") {
    const argTy = instr.args.length > 0 ? llvmValueType(fn, instr.args[0], functionTypes) : undefined;
    const callee =
      argTy?.k === "Float"
        ? "@sunra_print_double"
        : argTy?.k === "Str"
          ? "@sunra_print_str"
          : argTy?.k === "Unknown" || argTy?.k === "List" || argTy?.k === "Named" || argTy?.k === "Fn"
            ? "@sunra_print_ptr"
            : "@sunra_print_i64";
    const argType = argTy?.k === "Float"
      ? "double"
      : argTy?.k === "Str" || argTy?.k === "Unknown" || argTy?.k === "List" || argTy?.k === "Named" || argTy?.k === "Fn"
        ? "ptr"
        : "i64";
    const arg = instr.args.length > 0 ? `${argType} %v${instr.args[0]}` : "i64 0";
    const call = `call void ${callee}(${arg})`;
    // `print` returns unit; materialise a value so uses of %dst stay valid.
    return instr.dst === null ? call : `${call}\n  %v${instr.dst} = add i64 0, 0`;
  }
  if (instr.callee === "len" || instr.callee.endsWith(".len")) {
    const receiver = instr.args[0];
    if (receiver === undefined) return materializeZero(instr.dst, { k: "Int" });
    return `%v${instr.dst} = call i64 @__sunra_len(ptr %v${receiver})`;
  }

  // Runtime namespaces (`Card.pip`, `Dice.total`, `Rtp.check`, ...). Their shapes
  // come from the shared ABI table, never from the checker's `Unknown`, so the
  // emitted `call` always agrees with the `declare` line and with whatever
  // consumes the result (`icmp eq i64`, `br i1`, `ret double`).
  const namespaceAbi = runtimeAbi(instr.callee);
  if (namespaceAbi !== null) {
    return emitRuntimeNamespaceCall(instr, fn, functionTypes, namespaceAbi);
  }

  // Every other builtin method/function that has a runtime helper. The receiver
  // is already the first MIR argument (normalised in `mir/build.ts`), so the
  // lowering is a straight ABI match rather than a special case per method.
  const runtime = llvmRuntimeBuiltin(
    instr.callee,
    instr.args.map((arg) => llvmValueType(fn, arg, functionTypes)),
  );
  if (runtime !== null) {
    if (instr.args.length < runtime.params.length) {
      // Optional trailing arguments (`slice(start)`, `join()`) get a defined
      // default so the emitted call still matches the declared ABI.
      const provided = instr.args.map((arg, index) => `${llvmType(runtime.params[index])} %v${arg}`);
      const defaults = runtime.params
        .slice(instr.args.length)
        .map((ty) => `${llvmType(ty)} ${llvmDefaultOperand(ty)}`);
      const callArgs = [...provided, ...defaults].join(", ");
      return runtime.ret.k === "Unit"
        ? `call void @${runtime.symbol}(${callArgs})${instr.dst === null ? "" : `\n  %v${instr.dst} = add i64 0, 0`}`
        : `%v${instr.dst} = call ${llvmType(runtime.ret)} @${runtime.symbol}(${callArgs})`;
    }
    const callArgs = instr.args
      .map((arg, index) => `${llvmType(runtime.params[index] ?? { k: "Unknown" })} %v${arg}`)
      .join(", ");
    if (runtime.ret.k === "Unit") {
      const call = `call void @${runtime.symbol}(${callArgs})`;
      return instr.dst === null ? call : `${call}\n  %v${instr.dst} = add i64 0, 0`;
    }
    return `%v${instr.dst} = call ${llvmType(runtime.ret)} @${runtime.symbol}(${callArgs})`;
  }
  if (instr.callee.startsWith("intrinsic.load:")) {
    const fieldName = instr.callee.slice("intrinsic.load:".length);
    const constant = gameConstants?.get(fieldName);
    if (constant !== undefined && instr.dst !== null) {
      // Game declarations are compile-time metadata. A scalar field must become
      // a real LLVM scalar, not the opaque-pointer zero used for runtime handles.
      return emitGameConstant(instr.dst, constant, stringGlobal);
    }
    // Namespace handles and aggregate game fields are opaque pointers. Scalar
    // game fields retain their scalar ABI type even though the checker may have
    // left the dynamic load as Unknown.
    return materializeZero(instr.dst, llvmIntrinsicType(instr.callee, instr.ty));
  }

  const args = instr.args
    .map((arg, index) => {
      const dynamicArg = instr.callee === "str" || instr.callee === "int" || instr.callee === "float";
      const userFunction = lookupFunctionType(functionTypes, instr.callee);
      const argTy = dynamicArg
        ? llvmValueType(fn, arg, functionTypes)
        : builtin?.params[index] ?? userFunction?.params[index] ?? llvmValueType(fn, arg, functionTypes);
      return `${llvmType(argTy)} %v${arg}`;
    })
    .join(", ");
  const conversion = instr.args.length > 0
    ? llvmConversionSignature(instr.callee, llvmValueType(fn, instr.args[0], functionTypes))
    : null;
  const resolvedRet = conversion?.ret ?? builtin?.ret ?? lookupFunctionType(functionTypes, instr.callee)?.ret ?? instr.ty;
  const retTy = llvmType(resolvedRet);
  const targetName = conversion?.symbol ?? lookupFunctionSymbol(functionTypes, instr.callee) ?? instr.callee;
  const target = `@${mangle(targetName)}`;
  if (instr.dst === null || resolvedRet.k === "Unit") {
    const call = `call ${retTy === "void" ? "void" : retTy} ${target}(${args})`;
    return instr.dst === null ? call : `${call}\n  %v${instr.dst} = add i64 0, 0`;
  }
  return `%v${instr.dst} = call ${retTy} ${target}(${args})`;
}

/**
 * Lower a call into one of the runtime namespaces using the shared ABI table.
 *
 * Two things have to line up. The *arguments* must be passed in the shape the
 * declaration promises, so a value the checker inferred as `double` cannot be
 * handed to a `ptr` parameter without a conversion; and the *result* must be
 * produced in the declared shape, because the consumer was already typed from
 * the same table. Where the SSA value's own type disagrees with the parameter
 * shape, an explicit conversion instruction is emitted rather than a silent
 * mismatch — that is exactly the class of bug this table exists to remove.
 */
function emitRuntimeNamespaceCall(
  instr: MirInstr & { op: "call" },
  fn: MirFunction,
  functionTypes: LlvmFunctionTypes,
  abi: ReturnType<typeof runtimeAbi> & object,
): string {
  const prelude: string[] = [];
  let temp = 0;
  const nextTemp = (): string => `%vabi${instr.dst ?? "x"}_${temp++}`;

  const operands = instr.args.map((arg, index) => {
    const wanted = abiTy(abi.params[index] ?? abi.variadic ?? "Ref");
    const actual = llvmValueType(fn, arg, functionTypes);
    const wantedLlvm = llvmType(wanted);
    const actualLlvm = llvmType(actual);
    if (wantedLlvm === actualLlvm) return `${wantedLlvm} %v${arg}`;
    const converted = nextTemp();
    const conversion = llvmCoercion(actualLlvm, wantedLlvm, `%v${arg}`, converted);
    if (conversion === null) return `${wantedLlvm} %v${arg}`;
    prelude.push(conversion);
    return `${wantedLlvm} ${converted}`;
  });

  // Missing trailing arguments are filled with the declared default so the call
  // still matches a fixed-arity declaration.
  for (let index = instr.args.length; index < abi.params.length; index++) {
    const ty = abiTy(abi.params[index]);
    operands.push(`${llvmType(ty)} ${llvmDefaultOperand(ty)}`);
  }

  const callArgs = operands.join(", ");
  const emit = (text: string): string => (prelude.length > 0 ? `${prelude.join("\n  ")}\n  ${text}` : text);

  if (abi.ret === "Unit") {
    const call = `call void @${abi.symbol}(${callArgs})`;
    return emit(instr.dst === null ? call : `${call}\n  %v${instr.dst} = add i64 0, 0`);
  }
  if (instr.dst === null) return emit(`call ${llvmType(abiTy(abi.ret))} @${abi.symbol}(${callArgs})`);
  return emit(`%v${instr.dst} = call ${llvmType(abiTy(abi.ret))} @${abi.symbol}(${callArgs})`);
}

/**
 * A conversion instruction between two LLVM first-class types, or null when the
 * pair has no meaningful conversion (in which case the caller keeps the operand
 * as-is rather than inventing one).
 */
interface CoercedOperand {
  /** Instruction lines to emit immediately before the use. */
  prelude: string[];
  /** Operand text to place at the use site (`%v12` or a fresh temporary). */
  operand: string;
}

/**
 * Coerce an SSA value to the type a use site requires.
 *
 * The backend has one authority for "what type does this value have"
 * (`llvmValueType`) and many use sites that demand a specific type: list element
 * writes, phi incomings, arithmetic and string concatenation. When a function's
 * parameters or return were inferred from disagreeing call sites, those two can
 * differ, and emitting the operand regardless is what produced errors of the form
 * `defined with type 'ptr' but expected 'i64'`. Returning the conversion together
 * with the operand text means a use site never has to guess.
 */
function coerceOperand(
  value: number,
  wantedLlvm: string,
  fn: MirFunction,
  functionTypes: LlvmFunctionTypes,
  scratch: { next: number },
): CoercedOperand {
  const actualLlvm = llvmType(llvmValueType(fn, value, functionTypes));
  if (actualLlvm === wantedLlvm) return { prelude: [], operand: `%v${value}` };
  const dst = `%vc${scratch.next++}`;
  const conversion = llvmCoercion(actualLlvm, wantedLlvm, `%v${value}`, dst);
  if (conversion === null) return { prelude: [], operand: `%v${value}` };
  return { prelude: [conversion], operand: dst };
}

function llvmCoercion(from: string, to: string, operand: string, dst: string): string | null {
  if (from === to) return null;
  const key = `${from}->${to}`;
  switch (key) {
    case "i64->double":
      return `${dst} = sitofp i64 ${operand} to double`;
    case "double->i64":
      return `${dst} = fptosi double ${operand} to i64`;
    case "i1->i64":
      return `${dst} = zext i1 ${operand} to i64`;
    case "i64->i1":
      return `${dst} = icmp ne i64 ${operand}, 0`;
    case "i1->double":
      return `${dst} = uitofp i1 ${operand} to double`;
    case "double->i1":
      return `${dst} = fcmp one double ${operand}, 0.000000e+00`;
    case "i64->ptr":
      return `${dst} = inttoptr i64 ${operand} to ptr`;
    case "ptr->i64":
      return `${dst} = ptrtoint ptr ${operand} to i64`;
    case "ptr->double":
      return `${dst} = call double @sunra_float_from_ptr(ptr ${operand})`;
    case "double->ptr":
      return `${dst} = call ptr @sunra_str_from_double(double ${operand})`;
    case "ptr->i1":
      return `${dst} = icmp ne ptr ${operand}, null`;
    case "i1->ptr":
      return `${dst} = call ptr @sunra_str_from_bool(i1 ${operand})`;
    default:
      return null;
  }
}

function llvmConversionSignature(callee: string, argTy: Ty): { symbol: string; ret: Ty } | null {
  const argLlvmTy = llvmType(argTy);
  if (callee === "str") {
    const symbol = argLlvmTy === "double"
      ? "sunra_str_from_double"
      : argLlvmTy === "i1"
        ? "sunra_str_from_bool"
        : argLlvmTy === "ptr"
          ? "sunra_str_from_ptr"
          : "sunra_str_from_i64";
    return { symbol, ret: { k: "Str" } };
  }
  if (callee === "float") {
    return { symbol: argLlvmTy === "ptr" ? "sunra_float_from_ptr" : "sunra_float_from_i64", ret: { k: "Float" } };
  }
  if (callee === "int") {
    return { symbol: argLlvmTy === "ptr" ? "sunra_int_from_ptr" : "sunra_int_from_double", ret: { k: "Int" } };
  }
  return null;
}

/**
 * Runtime ABI for the builtin methods and functions the backend lowers directly.
 *
 * `argTypes` are the resolved backend types of the call's operands, which is how
 * overloaded builtins pick their monomorphic helper: `abs` on an Int becomes
 * `__sunra_abs_i64`, on a Float `__sunra_abs_f64`. Aggregates and strings are
 * both opaque `ptr`, so list and string variants share one helper.
 */
export function llvmRuntimeBuiltin(
  callee: string,
  argTypes: Ty[],
): { symbol: string; params: Ty[]; ret: Ty } | null {
  const ptr: Ty = { k: "Unknown" };
  const int: Ty = { k: "Int" };
  const float: Ty = { k: "Float" };
  const bool: Ty = { k: "Bool" };
  const str: Ty = { k: "Str" };
  const first = argTypes[0] ?? ({ k: "Unknown" } as Ty);
  const isFloatArg = first.k === "Float";

  switch (callee) {
    case "push":
      return { symbol: "__sunra_push", params: [ptr, ptr], ret: ptr };
    case "pop":
      return { symbol: "__sunra_pop", params: [ptr], ret: ptr };
    case "contains":
      return { symbol: "__sunra_contains", params: [ptr, ptr], ret: bool };
    case "indexOf":
      return { symbol: "__sunra_index_of", params: [ptr, ptr], ret: int };
    case "slice":
      return { symbol: "__sunra_slice", params: [ptr, int, int], ret: ptr };
    case "concat":
      return { symbol: "__sunra_concat", params: [ptr, ptr], ret: ptr };
    case "reverse":
      return { symbol: "__sunra_reverse", params: [ptr], ret: ptr };
    case "first":
      return listNumericBuiltin("first", first, ptr, int, float);
    case "last":
      return listNumericBuiltin("last", first, ptr, int, float);
    case "count":
      return { symbol: "__sunra_count", params: [ptr, ptr], ret: int };
    case "join":
      return { symbol: "__sunra_join", params: [ptr, str], ret: str };
    case "take":
      return { symbol: "__sunra_take", params: [ptr, int], ret: ptr };
    case "sum":
      return listNumericBuiltin("sum", first, ptr, int, float);
    case "upper":
      return { symbol: "__sunra_upper", params: [ptr], ret: str };
    case "lower":
      return { symbol: "__sunra_lower", params: [ptr], ret: str };
    case "trim":
      return { symbol: "__sunra_trim", params: [ptr], ret: str };
    case "split":
      return { symbol: "__sunra_split", params: [ptr, str], ret: { k: "List", of: str } };
    case "chars":
      return { symbol: "__sunra_chars", params: [ptr], ret: { k: "List", of: str } };
    case "abs":
      return isFloatArg
        ? { symbol: "__sunra_abs_f64", params: [float], ret: float }
        : { symbol: "__sunra_abs_i64", params: [int], ret: int };
    case "floor":
      return { symbol: "__sunra_floor", params: [float], ret: int };
    case "round":
      return { symbol: "__sunra_round", params: [float], ret: int };
    case "sqrt":
      return { symbol: "__sunra_sqrt", params: [float], ret: float };
    case "min":
      return first.k === "List"
        ? listNumericBuiltin("min", first, ptr, int, float)
        : isFloatArg
        ? { symbol: "__sunra_min_f64", params: [float, float], ret: float }
        : { symbol: "__sunra_min_i64", params: [int, int], ret: int };
    case "max":
      return first.k === "List"
        ? listNumericBuiltin("max", first, ptr, int, float)
        : isFloatArg
        ? { symbol: "__sunra_max_f64", params: [float, float], ret: float }
        : { symbol: "__sunra_max_i64", params: [int, int], ret: int };
    case "assert":
      return { symbol: "__sunra_assert", params: [bool, str], ret: { k: "Unit" } };
    default:
      if (callee === "first_float") return { symbol: "__sunra_list_first_f64", params: [ptr], ret: float };
      if (callee === "last_float") return { symbol: "__sunra_list_last_f64", params: [ptr], ret: float };
      if (callee === "sum_float") return { symbol: "__sunra_list_sum_f64", params: [ptr], ret: float };
      if (callee === "min_float") return { symbol: "__sunra_list_min_f64", params: [ptr], ret: float };
      if (callee === "max_float") return { symbol: "__sunra_list_max_f64", params: [ptr], ret: float };
      return null;
  }
}

function listNumericBuiltin(
  name: "first" | "last" | "sum" | "min" | "max",
  receiver: Ty,
  ptr: Ty,
  int: Ty,
  float: Ty,
): { symbol: string; params: Ty[]; ret: Ty } {
  const element = receiver.k === "List" ? receiver.of : null;
  if (element?.k === "Float") {
    return { symbol: `__sunra_list_${name}_f64`, params: [ptr], ret: float };
  }
  if (element?.k === "Int") {
    return { symbol: `__sunra_list_${name}_i64`, params: [ptr], ret: int };
  }
  if (name === "first") return { symbol: "__sunra_first", params: [ptr], ret: ptr };
  if (name === "last") return { symbol: "__sunra_last", params: [ptr], ret: ptr };
  return { symbol: "__sunra_sum_int", params: [ptr], ret: int };
}

/** A defined operand for an omitted optional builtin argument. */
function llvmDefaultOperand(ty: Ty): string {
  switch (llvmType(ty)) {
    case "ptr":
      return "null";
    case "double":
      return "0.0";
    case "i1":
      return "false";
    default:
      // `slice(start)` with no end means "to the end of the receiver"; -1 is the
      // runtime's sentinel for that.
      return "-1";
  }
}

/**
 * The checker deliberately leaves dynamically-dispatched namespace members as
 * `Unknown`. The native backend still knows the ABI of the runtime intrinsics,
 * so it must restore those concrete signatures before printing LLVM. Without
 * this table `Reel.isMatch` was emitted as `ptr` and then consumed by `br i1`,
 * which llvm-as correctly rejects.
 */
function llvmBuiltinSignature(callee: string): { params: Ty[]; ret: Ty } | null {
  switch (callee) {
    case "len":
      return { params: [{ k: "Unknown" }], ret: { k: "Int" } };
    case "contains":
      return { params: [{ k: "Unknown" }, { k: "Unknown" }], ret: { k: "Bool" } };
    case "indexOf":
      return { params: [{ k: "Unknown" }, { k: "Unknown" }], ret: { k: "Int" } };
    case "count":
      return { params: [{ k: "Unknown" }, { k: "Unknown" }], ret: { k: "Int" } };
    case "join":
      return { params: [{ k: "Unknown" }, { k: "Str" }], ret: { k: "Str" } };
    case "upper":
    case "lower":
    case "trim":
      return { params: [{ k: "Str" }], ret: { k: "Str" } };
    case "split":
    case "chars":
      return { params: [{ k: "Str" }], ret: { k: "List", of: { k: "Str" } } };
    case "slice":
    case "take":
    case "reverse":
    case "push":
    case "pop":
    case "first":
    case "last":
    case "concat":
      return null;
    case "Reel.isMatch":
      return { params: [{ k: "List", of: { k: "Unknown" } }], ret: { k: "Bool" } };
    case "Reel.longestRun":
      return { params: [{ k: "List", of: { k: "Unknown" } }], ret: { k: "Int" } };
    case "Reel.of":
      return { params: [{ k: "List", of: { k: "Unknown" } }, { k: "List", of: { k: "Unknown" } }], ret: { k: "Named", name: "Reel" } };
    case "Reel.spin":
      return { params: [{ k: "Named", name: "Reel" }, { k: "Int" }], ret: { k: "List", of: { k: "Unknown" } } };
    case "Rtp.check":
      return { params: [{ k: "Float" }, { k: "Float" }, { k: "Float" }], ret: { k: "Bool" } };
    case "range":
      return { params: [{ k: "Int" }, { k: "Int" }], ret: { k: "List", of: { k: "Int" } } };
    default:
      if (callee.endsWith(".join")) return { params: [{ k: "List", of: { k: "Unknown" } }], ret: { k: "Str" } };
      return null;
  }
}

function lookupFunctionType(functionTypes: LlvmFunctionTypes, callee: string): { params: Ty[]; ret: Ty } | undefined {
  const direct = functionTypes.get(callee);
  if (direct) return direct;
  // Monomorphization decorates call sites (`countInGrid$_Str__Str`) while the
  // emitted definition is still keyed by its source symbol (`countInGrid`).
  // Resolve that specialization back to the concrete definition signature.
  const base = callee.split("$")[0];
  const baseMatch = functionTypes.get(base);
  if (baseMatch) return baseMatch;
  // A call inside a game may carry `payout`, while the MIR function symbol is
  // `SlotMachine.payout`. Resolve the short name to its qualified definition.
  for (const [symbol, signature] of functionTypes) {
    if (symbol.endsWith(`.${callee}`) || symbol.endsWith(`.${base}`)) return signature;
  }
  return undefined;
}

function lookupFunctionSymbol(functionTypes: LlvmFunctionTypes, callee: string): string | undefined {
  if (functionTypes.has(callee)) return callee;
  const base = callee.split("$")[0];
  if (functionTypes.has(base)) return base;
  for (const symbol of functionTypes.keys()) {
    if (symbol.endsWith(`.${callee}`) || symbol.endsWith(`.${base}`)) return symbol;
  }
  return undefined;
}

function llvmIntrinsicType(callee: string, fallback: Ty): Ty {
  // If MIR already knows the field is scalar, do not reinterpret its name as a
  // runtime namespace/aggregate handle. This is important for game constants
  // such as `minCluster: Int`.
  if (concreteType(fallback)) return fallback;
  const name = callee.slice("intrinsic.load:".length);
  if (name === "bet") return { k: "Float" };
  if (name === "strip" || name === "weights" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return { k: "Named", name };
  }
  return fallback;
}

function emitGameConstant(
  dst: number,
  value: MirConst,
  stringGlobal: (value: string) => string,
): string {
  switch (value.k) {
    case "int":
      return `%v${dst} = add i64 0, ${Math.trunc(value.value)}`;
    case "float":
      return `%v${dst} = fadd double 0.0, ${formatDouble(value.value)}`;
    case "bool":
      return `%v${dst} = or i1 false, ${value.value ? "true" : "false"}`;
    case "str": {
      const global = stringGlobal(value.value);
      const bytes = encodeLlvmString(value.value);
      return `%v${dst} = call ptr @sunra_str_new(ptr getelementptr inbounds ([${bytes.length} x i8], ptr ${global}, i64 0, i64 0), i64 ${bytes.length - 1})`;
    }
    case "unit":
      return `%v${dst} = add i64 0, 0`;
  }
}

function llvmFieldType(name: string, fallback: Ty): Ty {
  if (name === "bet" || name === "rtp" || name === "tolerance") return { k: "Float" };
  return fallback;
}

function materializeZero(dst: number | null, ty: Ty): string {
  if (dst === null) return "";
  switch (llvmType(ty)) {
    case "ptr":
      return `%v${dst} = getelementptr i8, ptr null, i64 0`;
    case "double":
      return `%v${dst} = fadd double 0.0, 0.0`;
    case "i1":
      return `%v${dst} = or i1 false, false`;
    case "void":
      return "";
    default:
      return `%v${dst} = add i64 0, 0`;
  }
}

function emitTerminator(
  block: MirBlock,
  fn: MirFunction,
  functionTypes: LlvmFunctionTypes,
  scratch: { next: number },
): string {
  const term = block.terminator;
  const prelude: string[] = [];
  const operand = (value: number, wanted: string): string => {
    const coerced = coerceOperand(value, wanted, fn, functionTypes, scratch);
    prelude.push(...coerced.prelude);
    return coerced.operand;
  };
  const emit = (text: string): string => (prelude.length > 0 ? `${prelude.join("\n  ")}\n  ${text}` : text);
  switch (term.op) {
    case "jump":
      return `br label %bb${term.target}`;
    case "branch": {
      // A branch condition must be `i1`. A truthiness test on a reference (a list
      // element read through the pointer accessor, an unannotated parameter) is
      // converted rather than emitted as `br i1 %ptr`.
      const cond = operand(term.cond, "i1");
      return emit(`br i1 ${cond}, label %bb${term.then}, label %bb${term.otherwise}`);
    }
    case "return": {
      const retTy = functionTypes.get(fn.symbol)?.ret ?? inferredFunctionReturnTy(fn, functionTypes);
      if (term.value === null || retTy.k === "Unit") return "ret void";
      const wanted = llvmType(retTy);
      const value = operand(term.value, wanted);
      return emit(`ret ${wanted} ${value}`);
    }
    case "unreachable":
      return "unreachable";
  }
}

export function llvmType(ty: Ty): string {
  switch (ty.k) {
    case "Int":
      return "i64";
    case "Float":
      return "double";
    case "Bool":
      return "i1";
    case "Unit":
      return "void";
    case "Str":
    case "List":
    case "Named":
    case "Fn":
      return "ptr";
    case "Money":
      // Money is a fixed-point integer in the runtime: exact, never a double.
      return "i64";
    case "Unknown":
      // Unknown is used for unresolved aggregate/reference values at this
      // backend boundary. Treating it as i64 corrupts calls, phis, and returns;
      // the runtime representation for such values is an opaque pointer.
      return "ptr";
  }
}

function mangle(symbol: string): string {
  // LLVM identifiers allow a limited character set; `.` and `$` are fine but
  // spaces and `@` are not.
  return symbol.replace(/[^A-Za-z0-9_.$]/g, "_");
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function formatDouble(value: number): string {
  if (Number.isInteger(value)) return `${value}.0`;
  return String(value);
}

/** LLVM string constants are NUL-terminated with `\xx` escapes. */
function encodeLlvmString(value: string): { text: string; length: number } {
  const bytes = new TextEncoder().encode(value);
  let text = "";
  for (const byte of bytes) {
    if (byte === 0x22 || byte === 0x5c || byte < 0x20 || byte > 0x7e) {
      text += `\\${byte.toString(16).padStart(2, "0").toUpperCase()}`;
    } else {
      text += String.fromCharCode(byte);
    }
  }
  text += "\\00";
  return { text, length: bytes.length + 1 };
}
