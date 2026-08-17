/**
 * SunVM: a sandboxed register machine for Remote Game Servers.
 *
 * Why a bespoke VM rather than reusing the tree-walking interpreter: an RGS runs
 * untrusted game logic supplied by studios, so the execution unit needs hard
 * limits (steps, memory, call depth), a stable serialised form that can be
 * shipped and hot-reloaded without restarting the server, and no access to the
 * host beyond an explicit import table.
 *
 * Registers rather than a stack: SunMIR is already in SSA form with numbered
 * values, so a register machine is a direct mapping — no stack scheduling pass,
 * and each instruction reads exactly the registers the IR named.
 *
 * Bytecode layout (all little-endian):
 *
 *   magic    "SUNVM\0"        6 bytes
 *   version  u16              format version
 *   flags    u16              1 = deterministic profile
 *   consts   u32 count, then tagged values
 *   imports  u32 count, then length-prefixed names
 *   funcs    u32 count, then function records
 *
 * A function record is: name, arity, register count, instruction count, then
 * fixed-width instructions (opcode u8, a/b/c u32).
 */
import type { MirFunction, MirModule, MirInstr } from "../mir/mir.js";

export const SUNVM_MAGIC = "SUNVM\0";
/**
 * Format version.
 *
 * 2 adds the game-data section (fields and reel strips) plus the builtin,
 * field-access and game-data opcodes. Older artifacts are refused rather than
 * silently mis-decoded.
 */
export const SUNVM_VERSION = 2;

/** Opcodes. Kept small and fixed-width so decoding is a jump table. */
export enum Op {
  Nop = 0,
  LoadConst = 1, // r[a] = consts[b]
  Move = 2, // r[a] = r[b]
  Add = 3,
  Sub = 4,
  Mul = 5,
  Div = 6, // traps on zero divisor
  Rem = 7, // traps on zero divisor
  Neg = 8,
  Not = 9,
  Eq = 10,
  Ne = 11,
  Lt = 12,
  Le = 13,
  Gt = 14,
  Ge = 15,
  And = 16,
  Or = 17,
  Concat = 18,
  NewList = 19, // r[a] = list of length b, filled from r[c..c+b]
  ListGet = 20, // r[a] = r[b][r[c]] (checked)
  ListGetUnchecked = 21,
  ListSet = 22,
  ListLen = 23,
  Call = 24, // r[a] = call func[b] with c args starting at the operand window
  CallHost = 25, // r[a] = host import b
  Jump = 26,
  JumpIf = 27,
  Return = 28,
  ReturnUnit = 29,
  Drop = 30, // release r[a]
  Trap = 31,
  IntDiv = 32, // floor division for Int / Int
  /**
   * Builtin call: r[a] = builtin[b](r[extra…]).
   *
   * One opcode with a builtin id keeps the instruction set small while covering
   * the whole builtin-method surface (`push`, `slice`, `upper`, …). Adding a
   * method is then a table entry in both the compiler and the runtime rather
   * than a new opcode plus a new decoder branch.
   */
  Builtin = 33,
  /** r[a] = r[b].field[c] where c indexes the constant pool for the name. */
  GetField = 34,
  /** r[a].field[b] = r[c]. */
  SetField = 35,
  /**
   * r[a] = game data named consts[b].
   *
   * Covers a game field (`bet`, `rtp`), a reel strip and a handle to a game
   * declared in the same module. The data travels with the module, so resolving
   * it needs no host import.
   */
  LoadGameData = 36,
  /**
   * r[a] = a handle to function index b, named consts[c].
   *
   * Lets a function be passed as a value (`Rtp.estimate(coinFlip, …)`) without
   * granting the module a host import for its own name.
   */
  FuncRef = 37,
}

/**
 * Builtin ids used by `Op.Builtin`. The numbers are part of the bytecode format,
 * so entries are only ever appended — never renumbered.
 */
export enum Builtin {
  Push = 0,
  Pop = 1,
  Contains = 2,
  IndexOf = 3,
  Slice = 4,
  Concat = 5,
  Reverse = 6,
  First = 7,
  Last = 8,
  Count = 9,
  Join = 10,
  Take = 11,
  Sum = 12,
  Upper = 13,
  Lower = 14,
  Trim = 15,
  Split = 16,
  Chars = 17,
  Abs = 18,
  Floor = 19,
  Round = 20,
  Sqrt = 21,
  Min = 22,
  Max = 23,
  Str = 24,
  Int = 25,
  Float = 26,
  Range = 27,
  Assert = 28,
}

/** MIR builtin symbol to VM builtin id. */
const VM_BUILTINS: ReadonlyMap<string, Builtin> = new Map([
  ["push", Builtin.Push],
  ["pop", Builtin.Pop],
  ["contains", Builtin.Contains],
  ["indexOf", Builtin.IndexOf],
  ["slice", Builtin.Slice],
  ["concat", Builtin.Concat],
  ["reverse", Builtin.Reverse],
  ["first", Builtin.First],
  ["last", Builtin.Last],
  ["count", Builtin.Count],
  ["join", Builtin.Join],
  ["take", Builtin.Take],
  ["sum", Builtin.Sum],
  ["upper", Builtin.Upper],
  ["lower", Builtin.Lower],
  ["trim", Builtin.Trim],
  ["split", Builtin.Split],
  ["chars", Builtin.Chars],
  ["abs", Builtin.Abs],
  ["floor", Builtin.Floor],
  ["round", Builtin.Round],
  ["sqrt", Builtin.Sqrt],
  ["min", Builtin.Min],
  ["max", Builtin.Max],
  ["str", Builtin.Str],
  ["int", Builtin.Int],
  ["float", Builtin.Float],
  ["range", Builtin.Range],
  ["assert", Builtin.Assert],
]);

/** Builtin id for a MIR callee, including `receiver.method` spellings. */
export function vmBuiltinFor(callee: string): Builtin | undefined {
  const direct = VM_BUILTINS.get(callee);
  if (direct !== undefined) return direct;
  const dot = callee.lastIndexOf(".");
  if (dot < 0) return undefined;
  const method = callee.slice(dot + 1);
  // `Math.abs`, `row.join`: a namespace- or receiver-qualified builtin behaves
  // exactly like the bare builtin once the receiver is an explicit argument.
  return VM_BUILTINS.get(method);
}

export interface SunVmInstr {
  op: Op;
  a: number;
  b: number;
  c: number;
  /** Extra operands (call arguments, list elements). */
  extra?: number[];
}

export interface SunVmFunction {
  name: string;
  arity: number;
  registers: number;
  code: SunVmInstr[];
  /** Source line per instruction, for stack traces. */
  lines: number[];
}

export type SunVmConst =
  | { k: "int"; value: number }
  | { k: "float"; value: number }
  | { k: "bool"; value: boolean }
  | { k: "str"; value: string }
  | { k: "unit" };

export interface SunVmProgram {
  version: number;
  deterministic: boolean;
  consts: SunVmConst[];
  imports: string[];
  functions: SunVmFunction[];
  /** Entry function index, or -1 when the module has no `main`. */
  entry: number;
  /**
   * Game metadata carried inside the module: fields and reel strips per game.
   * `Op.LoadGameData` reads from here, which is what makes a `game` block usable
   * in the sandbox without granting any host import.
   */
  gameData: SunVmGameData;
  /** Digest of the encoded bytes, used as the hot-reload identity. */
  digest: string;
}

export type SunVmGameData = Record<
  string,
  Record<string, SunVmConst | { k: "list"; values: SunVmConst[] }>
>;

export interface SunVmCompileOptions {
  /** Reject host imports outside the RGS whitelist. */
  profile?: "rgs" | "open";
}

/** Host functions an RGS module may call. Anything else is a compile error. */
const RGS_IMPORTS = new Set([
  "print",
  "println",
  "len",
  "rng.next",
  "rng.pick",
  "rng.shuffle",
  "money.of",
  "fair.commit",
  "fair.verify",
]);

/**
 * Host *namespaces* an RGS module may call into.
 *
 * A remote game server legitimately needs the gaming primitives (reels, decks,
 * dice, poker ranking, provable fairness, RTP checks and seeded RNG) — those are
 * exactly the operations a certified game is built from, and the runtime supplies
 * them deterministically from the committed seed. What stays outside the profile
 * is host I/O: clocks, sockets, files, databases and graphics.
 *
 * Whitelisting by namespace rather than by individual symbol means adding a new
 * primitive to the standard library does not silently break bytecode builds,
 * while a genuinely non-deterministic namespace is still rejected.
 */
const RGS_NAMESPACES = new Set([
  "rng",
  "money",
  "fair",
  "Fair",
  "Reel",
  "Deck",
  "Card",
  "Dice",
  "Poker",
  "Baccarat",
  "Blackjack",
  "Roulette",
  "Paytable",
  "Rtp",
  "Money",
  "Math",
  "Str",
  "Arr",
  "Json",
  "Crypto",
  "Hash",
  "Random",
]);

/** Namespaces an RGS module may never touch, whatever the member. */
const RGS_FORBIDDEN_NAMESPACES = new Set([
  "Timer",
  "Net",
  "Http",
  "File",
  "Db",
  "Graphics",
  "Audio",
  "Process",
  "Env",
]);

/** Whether the RGS sandbox profile permits a host import. */
export function rgsAllowsImport(name: string): boolean {
  if (RGS_IMPORTS.has(name)) return true;
  const dot = name.indexOf(".");
  if (dot < 0) return false;
  const namespace = name.slice(0, dot);
  if (RGS_FORBIDDEN_NAMESPACES.has(namespace)) return false;
  return RGS_NAMESPACES.has(namespace);
}

export interface SunVmCompileResult {
  program: SunVmProgram;
  bytes: Uint8Array;
  rejected: Array<{ symbol: string; reason: string }>;
}

export function compileToSunVm(
  module: MirModule,
  options: SunVmCompileOptions = {},
): SunVmCompileResult {
  const profile = options.profile ?? "rgs";
  const consts: SunVmConst[] = [];
  const constIndex = new Map<string, number>();
  const imports: string[] = [];
  const importIndex = new Map<string, number>();
  const rejected: Array<{ symbol: string; reason: string }> = [];

  const internConst = (value: SunVmConst): number => {
    const key = `${value.k}:${"value" in value ? String(value.value) : ""}`;
    const existing = constIndex.get(key);
    if (existing !== undefined) return existing;
    const index = consts.length;
    consts.push(value);
    constIndex.set(key, index);
    return index;
  };

  const internImport = (name: string): number => {
    const existing = importIndex.get(name);
    if (existing !== undefined) return existing;
    const index = imports.length;
    imports.push(name);
    importIndex.set(name, index);
    return index;
  };

  const symbolIndex = new Map<string, number>();
  module.functions.forEach((fn, index) => symbolIndex.set(fn.symbol, index));
  const gameNames = new Set(module.games.map((game) => game.name));

  // Game data travels with the bytecode: fields keep their constant values and
  // reels keep their strips, so `Op.LoadGameData` needs no host support.
  const gameData: SunVmGameData = {};
  for (const game of module.games) {
    const record: Record<string, SunVmConst | { k: "list"; values: SunVmConst[] }> = {};
    for (const field of game.fields) {
      if (field.value !== null) record[field.name] = field.value as SunVmConst;
    }
    for (const reel of game.reels) {
      record[reel.name] = { k: "list", values: reel.symbols.map((s) => ({ k: "str", value: s })) };
    }
    gameData[game.name] = record;
  }

  const functions: SunVmFunction[] = [];
  for (const fn of module.functions) {
    const compiled = compileFunction(fn, {
      internConst,
      internImport,
      symbolIndex,
      profile,
      gameNames,
      reject: (reason) => rejected.push({ symbol: fn.symbol, reason }),
    });
    functions.push(compiled);
  }

  const entry = symbolIndex.get("main") ?? -1;
  const program: SunVmProgram = {
    version: SUNVM_VERSION,
    deterministic: profile === "rgs",
    consts,
    imports,
    functions,
    entry,
    gameData,
    digest: "",
  };
  const bytes = encodeProgram(program);
  program.digest = digestOf(bytes);

  return { program, bytes, rejected };
}

interface CompileCtx {
  internConst: (value: SunVmConst) => number;
  internImport: (name: string) => number;
  symbolIndex: Map<string, number>;
  profile: "rgs" | "open";
  reject: (reason: string) => void;
  /** Games declared in this module, so their handles resolve locally. */
  gameNames: Set<string>;
}

function compileFunction(fn: MirFunction, ctx: CompileCtx): SunVmFunction {
  // SSA value ids become register numbers directly. Registers are not reused,
  // which trades a little memory for a trivially correct mapping.
  const code: SunVmInstr[] = [];
  const lines: number[] = [];
  const emit = (instr: SunVmInstr, line: number): void => {
    code.push(instr);
    lines.push(line);
  };

  // Block start offsets are patched after all code is emitted, because a forward
  // jump does not know its target offset yet.
  const blockOffset = new Map<number, number>();
  const patches: Array<{ index: number; field: "a" | "b"; block: number }> = [];

  // Phis: the predecessor moves its value into the phi's register before jumping.
  const phiMoves = new Map<number, Array<{ dst: number; src: number }>>();
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.op !== "phi") continue;
      for (const source of instr.sources) {
        const list = phiMoves.get(source.block) ?? [];
        list.push({ dst: instr.dst, src: source.value });
        phiMoves.set(source.block, list);
      }
    }
  }

  let maxRegister = 0;
  const touch = (register: number): number => {
    if (register > maxRegister) maxRegister = register;
    return register;
  };
  for (const param of fn.params) touch(param.value);
  // Phi moves are parallel assignments. Reserve a disjoint register range so
  // staging cannot overwrite a live SSA value while resolving a cycle such as
  //   y_next <- remainder; x_next <- y_current
  // If those moves were emitted directly, writing y_next first would make the
  // second move read the new y instead of the RHS captured by `let t = y`.
  let nextPhiTemp = Math.max(-1, ...fn.types.keys(), ...fn.params.map((param) => param.value)) + 1;

  for (const block of fn.blocks) {
    blockOffset.set(block.id, code.length);

    for (const instr of block.instrs) {
      if (instr.op === "phi") {
        touch(instr.dst);
        continue; // materialised by predecessor moves
      }
      compileInstr(instr, { emit, touch, ctx, fn });
    }

    // Phi moves are parallel copies. Stage every source first, then write all
    // destinations; this preserves the old RHS even when a destination is also
    // another move's source (the common mutable-loop/let pattern).
    const moves = phiMoves.get(block.id) ?? [];
    const staged = moves.map((move) => ({
      move,
      temp: touch(nextPhiTemp++),
    }));
    for (const { move, temp } of staged) {
      emit({ op: Op.Move, a: temp, b: touch(move.src), c: 0 }, fn.span.line);
    }
    for (const { move, temp } of staged) {
      emit({ op: Op.Move, a: touch(move.dst), b: temp, c: 0 }, fn.span.line);
    }

    const term = block.terminator;
    switch (term.op) {
      case "jump":
        patches.push({ index: code.length, field: "a", block: term.target });
        emit({ op: Op.Jump, a: 0, b: 0, c: 0 }, fn.span.line);
        break;
      case "branch":
        patches.push({ index: code.length, field: "b", block: term.then });
        emit({ op: Op.JumpIf, a: touch(term.cond), b: 0, c: 0 }, fn.span.line);
        patches.push({ index: code.length, field: "a", block: term.otherwise });
        emit({ op: Op.Jump, a: 0, b: 0, c: 0 }, fn.span.line);
        break;
      case "return":
        if (term.value === null) emit({ op: Op.ReturnUnit, a: 0, b: 0, c: 0 }, fn.span.line);
        else emit({ op: Op.Return, a: touch(term.value), b: 0, c: 0 }, fn.span.line);
        break;
      case "unreachable":
        emit({ op: Op.Trap, a: 0, b: 0, c: 0 }, fn.span.line);
        break;
    }
  }

  for (const patch of patches) {
    const target = blockOffset.get(patch.block);
    if (target === undefined) {
      ctx.reject(`jump to unknown block bb${patch.block}`);
      continue;
    }
    code[patch.index][patch.field] = target;
  }

  return {
    name: fn.symbol,
    arity: fn.params.length,
    registers: maxRegister + 1,
    code,
    lines,
  };
}

function compileInstr(
  instr: MirInstr,
  env: {
    emit: (instr: SunVmInstr, line: number) => void;
    touch: (register: number) => number;
    ctx: CompileCtx;
    fn: MirFunction;
  },
): void {
  const { emit, touch, ctx, fn } = env;
  const line = instr.op === "store" || instr.op === "drop" ? instr.span.line : instr.span.line;

  switch (instr.op) {
    case "const": {
      const value = instr.value;
      const konst: SunVmConst =
        value.k === "unit"
          ? { k: "unit" }
          : value.k === "int"
            ? { k: "int", value: value.value }
            : value.k === "float"
              ? { k: "float", value: value.value }
              : value.k === "bool"
                ? { k: "bool", value: value.value }
                : { k: "str", value: value.value };
      emit({ op: Op.LoadConst, a: touch(instr.dst), b: ctx.internConst(konst), c: 0 }, line);
      return;
    }

    case "binary": {
      const map: Partial<Record<string, Op>> = {
        add: Op.Add,
        sub: Op.Sub,
        mul: Op.Mul,
        div: Op.Div,
        rem: Op.Rem,
        eq: Op.Eq,
        ne: Op.Ne,
        lt: Op.Lt,
        le: Op.Le,
        gt: Op.Gt,
        ge: Op.Ge,
        and: Op.And,
        or: Op.Or,
        concat: Op.Concat,
      };
      const op = instr.kind === "div" && fn.types.get(instr.lhs)?.k === "Int" && fn.types.get(instr.rhs)?.k === "Int"
        ? Op.IntDiv
        : map[instr.kind];
      if (op === undefined) {
        ctx.reject(`unsupported binary operator ${instr.kind}`);
        emit({ op: Op.Trap, a: 0, b: 0, c: 0 }, line);
        return;
      }
      emit({ op, a: touch(instr.dst), b: touch(instr.lhs), c: touch(instr.rhs) }, line);
      return;
    }

    case "unary":
      emit(
        {
          op: instr.kind === "neg" ? Op.Neg : Op.Not,
          a: touch(instr.dst),
          b: touch(instr.operand),
          c: 0,
        },
        line,
      );
      return;

    case "list":
      emit(
        {
          op: Op.NewList,
          a: touch(instr.dst),
          b: instr.items.length,
          c: 0,
          extra: instr.items.map(touch),
        },
        line,
      );
      return;

    case "index": {
      const checked = (instr as MirInstr & { op: "index"; checked?: boolean }).checked !== false;
      emit(
        {
          op: checked ? Op.ListGet : Op.ListGetUnchecked,
          a: touch(instr.dst),
          b: touch(instr.object),
          c: touch(instr.index),
        },
        line,
      );
      return;
    }

    case "store":
      if (instr.index !== null) {
        emit(
          { op: Op.ListSet, a: touch(instr.object), b: touch(instr.index), c: touch(instr.value) },
          line,
        );
        return;
      }
      // Field store: the field name is interned as a string constant, so the
      // runtime resolves it without a separate symbol table.
      emit(
        {
          op: Op.SetField,
          a: touch(instr.object),
          b: ctx.internConst({ k: "str", value: instr.field ?? "value" }),
          c: touch(instr.value),
        },
        line,
      );
      return;

    case "drop":
      emit({ op: Op.Drop, a: touch(instr.value), b: 0, c: 0 }, line);
      return;

    case "call": {
      const unsupported = unsupportedPrimitiveMethod(instr, fn);
      if (unsupported !== null) {
        ctx.reject(unsupported);
        emit({ op: Op.Trap, a: 0, b: 0, c: 0 }, line);
        return;
      }
      if (instr.callee === "len" || instr.callee.endsWith(".len")) {
        const receiver = instr.args[0];
        if (receiver === undefined) {
          ctx.reject("len method is missing its receiver");
          emit({ op: Op.Trap, a: 0, b: 0, c: 0 }, line);
          return;
        }
        emit({ op: Op.ListLen, a: touch(instr.dst ?? 0), b: touch(receiver), c: 0 }, line);
        return;
      }
      const local = resolveLocalSymbol(ctx.symbolIndex, instr.callee);
      if (local !== undefined) {
        emit(
          {
            op: Op.Call,
            a: instr.dst === null ? 0 : touch(instr.dst),
            b: local,
            c: instr.args.length,
            extra: instr.args.map(touch),
          },
          line,
        );
        return;
      }
      // Builtin methods and functions execute inside the VM. Doing this before
      // the host-import path is what keeps `xs.push(v)` or `s.upper()` from
      // being rejected by the RGS profile as an unknown host call.
      const builtin = vmBuiltinFor(instr.callee);
      if (builtin !== undefined) {
        emit(
          {
            op: Op.Builtin,
            a: instr.dst === null ? 0 : touch(instr.dst),
            b: builtin,
            c: instr.args.length,
            extra: instr.args.map(touch),
          },
          line,
        );
        return;
      }
      // Host import.
      const name = instr.callee.startsWith("intrinsic.load:")
        ? instr.callee.slice("intrinsic.load:".length)
        : instr.callee;
      // A `game`-scoped read (`bet`, `strip`, `weights`) or a handle to a game
      // declared in this module is module data, not a host call: the VM resolves
      // it from the game table, so it must not be charged against the import
      // whitelist.
      if (
        instr.callee.startsWith("intrinsic.load:") &&
        (instr.intrinsicKind === "gamefield" || ctx.gameNames.has(name))
      ) {
        emit(
          {
            op: Op.LoadGameData,
            a: instr.dst === null ? 0 : touch(instr.dst),
            b: ctx.internConst({ k: "str", value: name }),
            c: 0,
          },
          line,
        );
        return;
      }
      // A bare reference to a function declared in this module used as a *value*
      // (`Rtp.estimate(coinFlip, …)`) is a function handle, not a host import.
      // The handle is its symbol name; `Op.Call` resolves it, and a host that
      // receives it can call back through the runtime.
      if (instr.callee.startsWith("intrinsic.load:")) {
        const referenced = resolveLocalSymbol(ctx.symbolIndex, name);
        if (referenced !== undefined) {
          emit(
            {
              op: Op.FuncRef,
              a: instr.dst === null ? 0 : touch(instr.dst),
              b: referenced,
              c: ctx.internConst({ k: "str", value: name }),
            },
            line,
          );
          return;
        }
      }
      if (ctx.profile === "rgs" && !rgsAllowsImport(name)) {
        ctx.reject(`host import "${name}" is not permitted by the RGS profile`);
        emit({ op: Op.Trap, a: 0, b: 0, c: 0 }, line);
        return;
      }
      emit(
        {
          op: Op.CallHost,
          a: instr.dst === null ? 0 : touch(instr.dst),
          b: ctx.internImport(name),
          c: instr.args.length,
          extra: instr.args.map(touch),
        },
        line,
      );
      return;
    }

    case "field":
      // `Rtp.estimate(BlackjackTable.spin, …)` reads a *method* as a value. That
      // is a function reference, not game data: emitting `GetField` hands the host
      // a null, and the simulation then scores every round as zero — a silently
      // wrong RTP. When the name resolves to a function of a game declared in this
      // module, the handle is emitted instead so the host can call back in.
      {
        const methodSymbol = resolveGameMethod(ctx.symbolIndex, instr.object, instr.name, fn);
        if (methodSymbol !== undefined) {
          emit(
            {
              op: Op.FuncRef,
              a: touch(instr.dst),
              b: methodSymbol,
              c: ctx.internConst({ k: "str", value: instr.name }),
            },
            line,
          );
          return;
        }
      }
      emit(
        {
          op: Op.GetField,
          a: touch(instr.dst),
          b: touch(instr.object),
          c: ctx.internConst({ k: "str", value: instr.name }),
        },
        line,
      );
      return;

    case "arena":
      // The VM has a per-frame arena implicitly; nothing to emit.
      emit({ op: Op.Nop, a: 0, b: 0, c: 0 }, line);
      return;

    case "phi":
      return;
  }
}

function unsupportedPrimitiveMethod(instr: MirInstr & { op: "call" }, fn: MirFunction): string | null {
  const dot = instr.callee.lastIndexOf(".");
  if (dot < 0) return null;
  const method = instr.callee.slice(dot + 1);
  const receiver = instr.args.length > 0 ? fn.types.get(instr.args[0]) : undefined;
  if (receiver?.k === "List" && (method === "min" || method === "max")) {
    return `E0900: List has no member \`${method}\`; use array.${method}(list) or an explicit reduction`;
  }
  if (instr.args.length === 0 && (method === "min" || method === "max")) {
    return `E0900: unsupported member method \`${method}\``;
  }
  return null;
}

/**
 * If `object.name` names a method of a game declared in this module, its function
 * index; otherwise undefined (a genuine data field).
 *
 * The receiver is produced by `intrinsic.load:<GameName>`, so the owning game is
 * recovered from that instruction and `<Game>.<method>` looked up. When the owner
 * is known but has no such method, the read is data — `bet`, `rtp`, a reel strip —
 * and must stay a `GetField`.
 */
function resolveGameMethod(
  symbolIndex: Map<string, number>,
  object: number,
  name: string,
  fn: MirFunction,
): number | undefined {
  let owner: string | null = null;
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.op !== "call" || instr.dst !== object) continue;
      if (instr.callee.startsWith("intrinsic.load:")) owner = instr.callee.slice("intrinsic.load:".length);
    }
  }
  if (owner === null) return undefined;
  const qualified = symbolIndex.get(`${owner}.${name}`);
  if (qualified !== undefined) return qualified;
  for (const [symbol, index] of symbolIndex) {
    if (symbol.split("$")[0] === `${owner}.${name}`) return index;
  }
  return undefined;
}

function resolveLocalSymbol(symbolIndex: Map<string, number>, callee: string): number | undefined {
  const direct = symbolIndex.get(callee);
  if (direct !== undefined) return direct;
  const base = callee.split("$")[0];
  const baseDirect = symbolIndex.get(base);
  if (baseDirect !== undefined) return baseDirect;
  for (const [symbol, index] of symbolIndex) {
    if (symbol.split("$")[0] === base || symbol.endsWith(`.${base}`)) return index;
  }
  return undefined;
}

// --------------------------------------------------------------- encoding

class ByteWriter {
  private bytes: number[] = [];

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }
  u16(value: number): void {
    this.u8(value);
    this.u8(value >>> 8);
  }
  u32(value: number): void {
    this.u16(value & 0xffff);
    this.u16(value >>> 16);
  }
  i32(value: number): void {
    this.u32(value >>> 0);
  }
  f64(value: number): void {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value, true);
    for (const byte of new Uint8Array(buffer)) this.u8(byte);
  }
  str(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.u32(encoded.length);
    for (const byte of encoded) this.u8(byte);
  }
  finish(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

export function encodeProgram(program: SunVmProgram): Uint8Array {
  const w = new ByteWriter();
  for (const char of SUNVM_MAGIC) w.u8(char.charCodeAt(0));
  w.u16(program.version);
  w.u16(program.deterministic ? 1 : 0);

  w.u32(program.consts.length);
  for (const konst of program.consts) {
    writeConst(w, konst);
  }

  w.u32(program.imports.length);
  for (const name of program.imports) w.str(name);

  // Game-data section: per game, a name and its members. A member is either a
  // scalar constant (tag 0) or a list of constants (tag 1).
  const games = Object.keys(program.gameData);
  w.u32(games.length);
  for (const game of games) {
    w.str(game);
    const members = program.gameData[game];
    const keys = Object.keys(members);
    w.u32(keys.length);
    for (const key of keys) {
      w.str(key);
      const member = members[key];
      if ("values" in member) {
        w.u8(1);
        w.u32(member.values.length);
        for (const value of member.values) writeConst(w, value);
      } else {
        w.u8(0);
        writeConst(w, member);
      }
    }
  }

  w.u32(program.functions.length);
  for (const fn of program.functions) {
    w.str(fn.name);
    w.u32(fn.arity);
    w.u32(fn.registers);
    w.u32(fn.code.length);
    for (const instr of fn.code) {
      w.u8(instr.op);
      w.u32(instr.a);
      w.u32(instr.b);
      w.u32(instr.c);
      const extra = instr.extra ?? [];
      w.u32(extra.length);
      for (const value of extra) w.u32(value);
    }
  }

  w.i32(program.entry);
  return w.finish();
}

class ByteReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  u8(): number {
    return this.bytes[this.offset++];
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  i32(): number {
    return this.u32() | 0;
  }
  f64(): number {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8);
    this.offset += 8;
    return view.getFloat64(0, true);
  }
  str(): string {
    const length = this.u32();
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return new TextDecoder().decode(slice);
  }
}

export function decodeProgram(bytes: Uint8Array): SunVmProgram {
  const r = new ByteReader(bytes);
  for (const char of SUNVM_MAGIC) {
    if (r.u8() !== char.charCodeAt(0)) throw new Error("not a SunVM module");
  }
  const version = r.u16();
  if (version !== SUNVM_VERSION) {
    throw new Error(`unsupported SunVM version ${version}, expected ${SUNVM_VERSION}`);
  }
  const deterministic = r.u16() === 1;

  const consts: SunVmConst[] = [];
  const constCount = r.u32();
  for (let i = 0; i < constCount; i++) {
    consts.push(readConst(r));
  }

  const imports: string[] = [];
  const importCount = r.u32();
  for (let i = 0; i < importCount; i++) imports.push(r.str());

  const gameData: SunVmGameData = {};
  const gameCount = r.u32();
  for (let i = 0; i < gameCount; i++) {
    const game = r.str();
    const members: Record<string, SunVmConst | { k: "list"; values: SunVmConst[] }> = {};
    const memberCount = r.u32();
    for (let j = 0; j < memberCount; j++) {
      const key = r.str();
      const tag = r.u8();
      if (tag === 1) {
        const length = r.u32();
        const values: SunVmConst[] = [];
        for (let k = 0; k < length; k++) values.push(readConst(r));
        members[key] = { k: "list", values };
      } else {
        members[key] = readConst(r);
      }
    }
    gameData[game] = members;
  }

  const functions: SunVmFunction[] = [];
  const fnCount = r.u32();
  for (let i = 0; i < fnCount; i++) {
    const name = r.str();
    const arity = r.u32();
    const registers = r.u32();
    const codeLength = r.u32();
    const code: SunVmInstr[] = [];
    for (let j = 0; j < codeLength; j++) {
      const op = r.u8() as Op;
      const a = r.u32();
      const b = r.u32();
      const c = r.u32();
      const extraCount = r.u32();
      const extra: number[] = [];
      for (let k = 0; k < extraCount; k++) extra.push(r.u32());
      code.push(extra.length > 0 ? { op, a, b, c, extra } : { op, a, b, c });
    }
    functions.push({ name, arity, registers, code, lines: new Array(codeLength).fill(0) });
  }

  const entry = r.i32();
  return { version, deterministic, consts, imports, functions, entry, gameData, digest: digestOf(bytes) };
}

function writeConst(w: ByteWriter, konst: SunVmConst): void {
  switch (konst.k) {
    case "int":
      w.u8(0);
      w.f64(konst.value);
      break;
    case "float":
      w.u8(1);
      w.f64(konst.value);
      break;
    case "bool":
      w.u8(2);
      w.u8(konst.value ? 1 : 0);
      break;
    case "str":
      w.u8(3);
      w.str(konst.value);
      break;
    case "unit":
      w.u8(4);
      break;
  }
}

function readConst(r: ByteReader): SunVmConst {
  const tag = r.u8();
  if (tag === 0) return { k: "int", value: r.f64() };
  if (tag === 1) return { k: "float", value: r.f64() };
  if (tag === 2) return { k: "bool", value: r.u8() === 1 };
  if (tag === 3) return { k: "str", value: r.str() };
  return { k: "unit" };
}

/** FNV-1a over the encoded module. Used as the hot-reload identity. */
export function digestOf(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
