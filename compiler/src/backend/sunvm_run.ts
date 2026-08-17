/**
 * SunVM runtime.
 *
 * The sandbox is the point of this file. An RGS runs third-party game logic, so
 * the VM enforces:
 *
 *   - a step budget (no infinite loops taking down the server);
 *   - a call-depth limit (no stack exhaustion);
 *   - an allocation budget (no memory exhaustion);
 *   - host access only through the module's declared import table.
 *
 * Hot reload: `SunVmRuntime.load` swaps the module in place, keyed by digest.
 * Because module state lives in the runtime rather than in the module, a reload
 * keeps host bindings and the RNG seed intact — which is what lets an operator
 * patch a paytable without dropping player sessions.
 */
import { Builtin, Op, decodeProgram, type SunVmFunction, type SunVmProgram } from "./sunvm.js";

export interface SunVmLimits {
  maxSteps: number;
  maxCallDepth: number;
  maxAllocations: number;
  maxListLength: number;
}

export const DEFAULT_LIMITS: SunVmLimits = {
  // The bundled blockchain example performs a long deterministic RTP sample.
  // Keep a finite guard, but leave enough budget for legitimate game workloads
  // instead of trapping at the old 5M default.
  maxSteps: 50_000_000,
  maxCallDepth: 256,
  maxAllocations: 100_000,
  maxListLength: 1_000_000,
};

export type HostFn = (args: SunVmValue[]) => SunVmValue;

/** Structural hook used by the profiler; kept here to avoid a runtime import cycle. */
export interface SunVmProfilerHook {
  enter(functionName: string): void;
  exit(functionName: string): void;
  allocation(functionName: string, bytes: number): void;
}

export type SunVmValue =
  | number
  | boolean
  | string
  | SunVmValue[]
  | { [key: string]: SunVmValue }
  | null;

export class SunVmTrap extends Error {
  constructor(
    message: string,
    readonly fn: string,
    readonly pc: number,
  ) {
    super(message);
    this.name = "SunVmTrap";
  }
}

export interface RunResult {
  value: SunVmValue;
  steps: number;
  allocations: number;
  output: string[];
}

export class SunVmRuntime {
  private program: SunVmProgram | null = null;
  private readonly hosts = new Map<string, HostFn>();
  private output: string[] = [];
  /** Reload generation, so callers can tell whether a swap happened. */
  private generation = 0;
  private profiler: SunVmProfilerHook | null = null;

  constructor(private readonly limits: SunVmLimits = DEFAULT_LIMITS) {
    // Default host functions. `print` collects into a buffer instead of writing
    // to stdout: an RGS wants the output, not the console.
    this.hosts.set("print", (args) => {
      this.output.push(formatValue(args[0] ?? null));
      return null;
    });
    this.hosts.set("println", (args) => {
      this.output.push(formatValue(args[0] ?? null));
      return null;
    });
    this.hosts.set("len", (args) => {
      const value = args[0];
      if (Array.isArray(value)) return value.length;
      if (typeof value === "string") return [...value].length;
      return 0;
    });
  }

  /** Register a host import. Modules may only call names bound here. */
  bind(name: string, fn: HostFn): void {
    this.hosts.set(name, fn);
  }

  /** Attach or detach a profiling sink for subsequent calls. */
  setProfiler(profiler: SunVmProfilerHook | null): void {
    this.profiler = profiler;
  }

  /**
   * Load or hot-reload a module. Returns whether the code actually changed,
   * which lets a server skip re-warming caches on a no-op deploy.
   */
  load(bytes: Uint8Array): { changed: boolean; digest: string; generation: number } {
    const next = decodeProgram(bytes);
    const previousDigest = this.program?.digest ?? null;
    const changed = previousDigest !== next.digest;
    if (changed) {
      this.program = next;
      this.generation += 1;
    }
    return { changed, digest: next.digest, generation: this.generation };
  }

  get digest(): string | null {
    return this.program?.digest ?? null;
  }

  get reloads(): number {
    return this.generation;
  }

  /** Names the loaded module imports but the host has not bound. */
  missingImports(): string[] {
    if (!this.program) return [];
    return this.program.imports.filter((name) => !this.hosts.has(name));
  }

  /**
   * Call a function handle produced by `Op.FuncRef`.
   *
   * A host import that receives a Sunra function as an argument (`Rtp.estimate`
   * takes the round to simulate) uses this to invoke it, so higher-order code
   * runs inside the same sandbox rather than escaping to the host.
   */
  callFunctionValue(handle: SunVmValue, args: SunVmValue[] = []): SunVmValue {
    if (!this.program) throw new Error("no module loaded");
    const index = functionHandleIndex(handle);
    if (index === null) throw new Error("not a Sunra function handle");
    return this.call(this.program, index, args, { steps: 0, allocations: 0, depth: 0 });
  }

  run(entry = "main", args: SunVmValue[] = []): RunResult {
    if (!this.program) throw new Error("no module loaded");
    const program = this.program;
    const index = program.functions.findIndex((f) => f.name === entry);
    if (index < 0) throw new Error(`function ${entry} not found`);

    const missing = this.missingImports();
    if (missing.length > 0) {
      throw new Error(`unbound host imports: ${missing.join(", ")}`);
    }

    this.output = [];
    const state = { steps: 0, allocations: 0, depth: 0 };
    const value = this.call(program, index, args, state);
    return { value, steps: state.steps, allocations: state.allocations, output: [...this.output] };
  }

  private call(
    program: SunVmProgram,
    index: number,
    args: SunVmValue[],
    state: { steps: number; allocations: number; depth: number },
  ): SunVmValue {
    const fn = program.functions[index];
    if (!fn) throw new Error(`function index ${index} out of range`);
    this.profiler?.enter(fn.name);

    state.depth += 1;
    if (state.depth > this.limits.maxCallDepth) {
      throw new SunVmTrap(
        `call depth limit exceeded (${this.limits.maxCallDepth})`,
        fn.name,
        0,
      );
    }

    const registers: SunVmValue[] = new Array(fn.registers).fill(null);
    // Parameters occupy the first `arity` registers by construction: the compiler
    // assigns param SSA ids first.
    for (let i = 0; i < fn.arity && i < args.length; i++) registers[i] = args[i] ?? null;

    let pc = 0;
    try {
      while (pc < fn.code.length) {
        state.steps += 1;
        if (state.steps > this.limits.maxSteps) {
          throw new SunVmTrap(`step limit exceeded (${this.limits.maxSteps})`, fn.name, pc);
        }

        const instr = fn.code[pc];
        const r = registers;

        switch (instr.op) {
          case Op.Nop:
            pc += 1;
            break;

          case Op.LoadConst: {
            const konst = program.consts[instr.b];
            r[instr.a] = konst.k === "unit" ? null : konst.value;
            pc += 1;
            break;
          }

          case Op.Move:
            r[instr.a] = r[instr.b];
            pc += 1;
            break;

          case Op.Add: {
            // `+` is overloaded on strings, as it is in the interpreter and in
            // the LLVM backend (which lowers it to `sunra_str_concat`). Without
            // this, `first() + "|" + last()` traps on a string operand.
            const lhs = r[instr.b];
            const rhs = r[instr.c];
            const lhsMoney = moneyInfo(lhs);
            const rhsMoney = moneyInfo(rhs);
            if (lhsMoney || rhsMoney) {
              if (!lhsMoney || !rhsMoney) {
                throw new SunVmTrap("Money.add requires two Money values", fn.name, pc);
              }
              if (lhsMoney.currency !== rhsMoney.currency) {
                throw new SunVmTrap(
                  `cannot combine ${lhsMoney.currency} with ${rhsMoney.currency}`,
                  fn.name,
                  pc,
                );
              }
              r[instr.a] = makeMoney(lhsMoney.minor + rhsMoney.minor, lhsMoney.currency);
              pc += 1;
              break;
            }
            // It is overloaded on lists too: `xs = xs + [x]` is the idiomatic
            // append in Sunra, and the LLVM backend lowers it to a runtime
            // concat. Without this the VM traps with "expected a number".
            if (Array.isArray(lhs) || Array.isArray(rhs)) {
              r[instr.a] = [
                ...(Array.isArray(lhs) ? lhs : [lhs]),
                ...(Array.isArray(rhs) ? rhs : [rhs]),
              ];
              pc += 1;
              break;
            }
            r[instr.a] =
              typeof lhs === "string" || typeof rhs === "string"
                ? formatValue(lhs) + formatValue(rhs)
                : num(lhs, fn, pc) + num(rhs, fn, pc);
            pc += 1;
            break;
          }
          case Op.Sub: {
            const lhsMoney = moneyInfo(r[instr.b]);
            const rhsMoney = moneyInfo(r[instr.c]);
            if (lhsMoney || rhsMoney) {
              if (!lhsMoney || !rhsMoney) {
                throw new SunVmTrap("Money.sub requires two Money values", fn.name, pc);
              }
              if (lhsMoney.currency !== rhsMoney.currency) {
                throw new SunVmTrap(
                  `cannot combine ${lhsMoney.currency} with ${rhsMoney.currency}`,
                  fn.name,
                  pc,
                );
              }
              r[instr.a] = makeMoney(lhsMoney.minor - rhsMoney.minor, lhsMoney.currency);
              pc += 1;
              break;
            }
            r[instr.a] = num(r[instr.b], fn, pc) - num(r[instr.c], fn, pc);
            pc += 1;
            break;
          }
          case Op.Mul: {
            const lhsMoney = moneyInfo(r[instr.b]);
            const rhsMoney = moneyInfo(r[instr.c]);
            if (lhsMoney || rhsMoney) {
              if (lhsMoney && rhsMoney) {
                throw new SunVmTrap("`*` is not defined for Money and Money", fn.name, pc);
              }
              const scalar = lhsMoney ? r[instr.c] : r[instr.b];
              if (typeof scalar !== "number" || !Number.isInteger(scalar)) {
                throw new SunVmTrap(
                  "cannot multiply Money with Float; use Money.scale",
                  fn.name,
                  pc,
                );
              }
              const amount = lhsMoney ?? rhsMoney!;
              r[instr.a] = makeMoney(amount.minor * BigInt(scalar), amount.currency);
              pc += 1;
              break;
            }
            r[instr.a] = num(r[instr.b], fn, pc) * num(r[instr.c], fn, pc);
            pc += 1;
            break;
          }
          case Op.Div: {
            const lhsMoney = moneyInfo(r[instr.b]);
            const rhsMoney = moneyInfo(r[instr.c]);
            if (lhsMoney || rhsMoney) {
              if (lhsMoney && rhsMoney) {
                throw new SunVmTrap("`/` is not defined for Money and Money", fn.name, pc);
              }
              const scalar = lhsMoney ? r[instr.c] : r[instr.b];
              if (typeof scalar !== "number" || !Number.isInteger(scalar)) {
                throw new SunVmTrap(
                  "cannot divide Money with Float; use Money.divide",
                  fn.name,
                  pc,
                );
              }
              if (scalar === 0) throw new SunVmTrap("division by zero", fn.name, pc);
              if (!lhsMoney) {
                throw new SunVmTrap("Money must be the left operand of division", fn.name, pc);
              }
              r[instr.a] = makeMoney(lhsMoney.minor / BigInt(scalar), lhsMoney.currency);
              pc += 1;
              break;
            }
            const divisor = num(r[instr.c], fn, pc);
            if (divisor === 0) throw new SunVmTrap("division by zero", fn.name, pc);
            r[instr.a] = num(r[instr.b], fn, pc) / divisor;
            pc += 1;
            break;
          }
          case Op.IntDiv: {
            const divisor = num(r[instr.c], fn, pc);
            if (divisor === 0) throw new SunVmTrap("division by zero", fn.name, pc);
            r[instr.a] = Math.floor(num(r[instr.b], fn, pc) / divisor);
            pc += 1;
            break;
          }
          case Op.Rem: {
            const divisor = num(r[instr.c], fn, pc);
            if (divisor === 0) throw new SunVmTrap("modulo by zero", fn.name, pc);
            r[instr.a] = num(r[instr.b], fn, pc) % divisor;
            pc += 1;
            break;
          }
          case Op.Neg:
            r[instr.a] = -num(r[instr.b], fn, pc);
            pc += 1;
            break;
          case Op.Not:
            r[instr.a] = !truthy(r[instr.b]);
            pc += 1;
            break;

          case Op.Eq:
            r[instr.a] = valuesEqual(r[instr.b], r[instr.c]);
            pc += 1;
            break;
          case Op.Ne:
            r[instr.a] = !valuesEqual(r[instr.b], r[instr.c]);
            pc += 1;
            break;
          case Op.Lt:
            r[instr.a] = num(r[instr.b], fn, pc) < num(r[instr.c], fn, pc);
            pc += 1;
            break;
          case Op.Le:
            r[instr.a] = num(r[instr.b], fn, pc) <= num(r[instr.c], fn, pc);
            pc += 1;
            break;
          case Op.Gt:
            r[instr.a] = num(r[instr.b], fn, pc) > num(r[instr.c], fn, pc);
            pc += 1;
            break;
          case Op.Ge:
            r[instr.a] = num(r[instr.b], fn, pc) >= num(r[instr.c], fn, pc);
            pc += 1;
            break;

          case Op.And:
            r[instr.a] = truthy(r[instr.b]) && truthy(r[instr.c]);
            pc += 1;
            break;
          case Op.Or:
            r[instr.a] = truthy(r[instr.b]) || truthy(r[instr.c]);
            pc += 1;
            break;
          case Op.Concat:
            r[instr.a] = formatValue(r[instr.b]) + formatValue(r[instr.c]);
            pc += 1;
            break;

          case Op.NewList: {
            if (instr.b > this.limits.maxListLength) {
              throw new SunVmTrap(`list length limit exceeded`, fn.name, pc);
            }
            state.allocations += 1;
            if (state.allocations > this.limits.maxAllocations) {
              throw new SunVmTrap(
                `allocation limit exceeded (${this.limits.maxAllocations})`,
                fn.name,
                pc,
              );
            }
            r[instr.a] = (instr.extra ?? []).map((reg) => r[reg]);
            this.profiler?.allocation(fn.name, Math.max(0, instr.b) * 8);
            pc += 1;
            break;
          }

          case Op.ListGet:
          case Op.ListGetUnchecked: {
            const list = r[instr.b];
            const at = num(r[instr.c], fn, pc);
            if (!Array.isArray(list)) throw new SunVmTrap("not a list", fn.name, pc);
            if (instr.op === Op.ListGet && (at < 0 || at >= list.length)) {
              throw new SunVmTrap(
                `index ${at} out of bounds for length ${list.length}`,
                fn.name,
                pc,
              );
            }
            r[instr.a] = list[at] ?? null;
            pc += 1;
            break;
          }

          case Op.ListSet: {
            const list = r[instr.a];
            if (!Array.isArray(list)) throw new SunVmTrap("not a list", fn.name, pc);
            const at = num(r[instr.b], fn, pc);
            if (at < 0 || at >= list.length) {
              throw new SunVmTrap(`index ${at} out of bounds`, fn.name, pc);
            }
            list[at] = r[instr.c];
            pc += 1;
            break;
          }

          case Op.ListLen: {
            const value = r[instr.b];
            r[instr.a] = Array.isArray(value)
              ? value.length
              : typeof value === "string"
                ? [...value].length
                : 0;
            pc += 1;
            break;
          }

          case Op.Call: {
            const callArgs = (instr.extra ?? []).map((reg) => r[reg]);
            r[instr.a] = this.call(program, instr.b, callArgs, state);
            pc += 1;
            break;
          }

          case Op.CallHost: {
            const name = program.imports[instr.b];
            const host = this.hosts.get(name);
            if (!host) throw new SunVmTrap(`unbound host import "${name}"`, fn.name, pc);
            const callArgs = (instr.extra ?? []).map((reg) => r[reg]);
            r[instr.a] = host(callArgs);
            pc += 1;
            break;
          }

          case Op.Builtin: {
            const callArgs = (instr.extra ?? []).map((reg) => r[reg]);
            // A list-producing builtin allocates, so it is charged against the
            // sandbox allocation budget just like `NewList`.
            if (allocatingBuiltin(instr.b as Builtin)) {
              state.allocations += 1;
              if (state.allocations > this.limits.maxAllocations) {
                throw new SunVmTrap(
                  `allocation limit exceeded (${this.limits.maxAllocations})`,
                  fn.name,
                  pc,
                );
              }
              this.profiler?.allocation(fn.name, 64);
            }
            r[instr.a] = evalBuiltin(instr.b as Builtin, callArgs, fn, pc);
            pc += 1;
            break;
          }

          case Op.GetField: {
            const target = r[instr.b];
            const konst = program.consts[instr.c];
            const field = konst && konst.k === "str" ? konst.value : "";
            r[instr.a] = readField(target, field, fn, pc);
            pc += 1;
            break;
          }

          case Op.SetField: {
            const target = r[instr.a];
            const konst = program.consts[instr.b];
            const field = konst && konst.k === "str" ? konst.value : "";
            if (target === null || typeof target !== "object" || Array.isArray(target)) {
              throw new SunVmTrap(
                `cannot set field "${field}" on ${typeName(target)}`,
                fn.name,
                pc,
              );
            }
            (target as { [key: string]: SunVmValue })[field] = r[instr.c];
            pc += 1;
            break;
          }

          case Op.LoadGameData: {
            const konst = program.consts[instr.b];
            const name = konst && konst.k === "str" ? konst.value : "";
            r[instr.a] = loadGameData(program, name);
            pc += 1;
            break;
          }

          case Op.FuncRef: {
            const konst = program.consts[instr.c];
            r[instr.a] = {
              __sunvm_fn: instr.b,
              name: konst && konst.k === "str" ? konst.value : `fn#${instr.b}`,
            } as unknown as SunVmValue;
            pc += 1;
            break;
          }

          case Op.Jump:
            pc = instr.a;
            break;

          case Op.JumpIf:
            pc = truthy(r[instr.a]) ? instr.b : pc + 1;
            break;

          case Op.Return:
            return r[instr.a];

          case Op.ReturnUnit:
            return null;

          case Op.Drop:
            // Reference release: setting the register to null is what makes the
            // drop observable, and lets the host GC reclaim the value.
            r[instr.a] = null;
            pc += 1;
            break;

          case Op.Trap:
            throw new SunVmTrap("reached unreachable code", fn.name, pc);

          default:
            throw new SunVmTrap(`unknown opcode ${instr.op}`, fn.name, pc);
        }
      }
      return null;
    } finally {
      state.depth -= 1;
      this.profiler?.exit(fn.name);
    }
  }
}

function num(value: SunVmValue, fn: SunVmFunction, pc: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null) return 0;
  throw new SunVmTrap(`expected a number, got ${typeof value}`, fn.name, pc);
}

interface VmMoneyInfo {
  minor: bigint;
  currency: string;
}

function moneyInfo(value: SunVmValue): VmMoneyInfo | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const tagged = value as { __sunra_money?: unknown; __sunra_currency?: unknown };
  if (typeof tagged.__sunra_money !== "string") return null;
  try {
    return {
      minor: BigInt(tagged.__sunra_money),
      currency: typeof tagged.__sunra_currency === "string" ? tagged.__sunra_currency : "THB",
    };
  } catch {
    return null;
  }
}

function makeMoney(minor: bigint, currency: string): SunVmValue {
  return { __sunra_money: minor.toString(), __sunra_currency: currency };
}

/**
 * Field read.
 *
 * Records are plain objects. A few field names are also defined on primitives so
 * host-produced values behave the same as in the interpreter: `.len` on a list
 * or string, and `.amount` on a fixed-point money integer.
 */
function readField(target: SunVmValue, field: string, fn: SunVmFunction, pc: number): SunVmValue {
  const taggedMoney = moneyInfo(target);
  if (taggedMoney) {
    if (field === "amount") return Number(taggedMoney.minor) / 10_000;
    if (field === "currency") return taggedMoney.currency;
    return null;
  }
  if (target !== null && typeof target === "object" && !Array.isArray(target)) {
    const record = target as { [key: string]: SunVmValue };
    return field in record ? record[field] : null;
  }
  if (Array.isArray(target)) {
    if (field === "len" || field === "length" || field === "size") return target.length;
    if (field === "first") return target.length === 0 ? null : target[0];
    if (field === "last") return target.length === 0 ? null : target[target.length - 1];
    return null;
  }
  if (typeof target === "string") {
    if (field === "len" || field === "length") return [...target].length;
    return null;
  }
  if (typeof target === "number") {
    if (field === "amount") return target;
    return null;
  }
  if (target === null) {
    throw new SunVmTrap(`cannot read field "${field}" of unit`, fn.name, pc);
  }
  return null;
}

function truthy(value: SunVmValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value === null) return false;
  if (typeof value === "string") return value.length > 0;
  return true;
}

function valuesEqual(a: SunVmValue, b: SunVmValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => valuesEqual(item, b[index]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const left = a as { [key: string]: SunVmValue };
    const right = b as { [key: string]: SunVmValue };
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => valuesEqual(left[key], right[key]));
  }
  return a === b;
}

function formatValue(value: SunVmValue): string {
  if (value === null) return "()";
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === "object") {
    const taggedMoney = moneyInfo(value);
    if (taggedMoney) {
      const negative = taggedMoney.minor < 0n;
      const absolute = negative ? -taggedMoney.minor : taggedMoney.minor;
      const whole = absolute / 10_000n;
      const fraction = (absolute % 10_000n).toString().padStart(4, "0").slice(0, 2);
      return `${negative ? "-" : ""}${whole}.${fraction} ${taggedMoney.currency}`;
    }
    const record = value as { [key: string]: SunVmValue };
    return `{${Object.keys(record)
      .map((key) => `${key}: ${formatValue(record[key])}`)
      .join(", ")}}`;
  }
  return String(value);
}

/** Builtins that create a fresh list or string and therefore allocate. */
function allocatingBuiltin(id: Builtin): boolean {
  switch (id) {
    case Builtin.Push:
    case Builtin.Slice:
    case Builtin.Concat:
    case Builtin.Reverse:
    case Builtin.Take:
    case Builtin.Split:
    case Builtin.Chars:
    case Builtin.Range:
      return true;
    default:
      return false;
  }
}

/**
 * Builtin semantics, kept deliberately identical to `Interpreter.builtinMethod`
 * so bytecode execution and tree-walking execution agree. Receiver-polymorphic
 * builtins (`contains`, `slice`, `concat`, `indexOf`, `reverse`) dispatch on the
 * runtime value: a list stays a list, a string stays a string.
 */
function evalBuiltin(id: Builtin, args: SunVmValue[], fn: SunVmFunction, pc: number): SunVmValue {
  const self = args[0] ?? null;
  const arg1 = args[1] ?? null;
  const asList = (): SunVmValue[] => {
    if (Array.isArray(self)) return self;
    throw new SunVmTrap(`expected a list receiver, got ${typeName(self)}`, fn.name, pc);
  };
  const asStr = (): string => {
    if (typeof self === "string") return self;
    throw new SunVmTrap(`expected a string receiver, got ${typeName(self)}`, fn.name, pc);
  };
  const index = (value: SunVmValue, fallback: number): number =>
    typeof value === "number" ? Math.trunc(value) : fallback;

  switch (id) {
    case Builtin.Push: {
      // `push` mutates the receiver and returns it, matching the interpreter.
      const list = asList();
      list.push(arg1);
      return list;
    }
    case Builtin.Pop: {
      // Mutates the receiver and returns it, mirroring `push` and the
      // interpreter, so `strip.pop().len()` chains. The removed element is
      // reachable through `last()` before the call.
      const list = asList();
      list.pop();
      return list;
    }
    case Builtin.Contains:
      if (typeof self === "string") return self.includes(formatValue(arg1));
      return asList().some((item) => valuesEqual(item, arg1));
    case Builtin.IndexOf: {
      if (typeof self === "string") return self.indexOf(formatValue(arg1));
      const list = asList();
      for (let i = 0; i < list.length; i += 1) if (valuesEqual(list[i], arg1)) return i;
      return -1;
    }
    case Builtin.Slice: {
      // -1 is the "to the end" sentinel shared with the native backends.
      const start = index(arg1, 0);
      const rawEnd = index(args[2] ?? null, -1);
      const end = rawEnd < 0 ? undefined : rawEnd;
      if (typeof self === "string") return self.slice(start, end);
      return asList().slice(start, end);
    }
    case Builtin.Concat: {
      if (typeof self === "string") return self + formatValue(arg1);
      const other = Array.isArray(arg1) ? arg1 : arg1 === null ? [] : [arg1];
      return [...asList(), ...other];
    }
    case Builtin.Reverse:
      if (typeof self === "string") return [...self].reverse().join("");
      return [...asList()].reverse();
    case Builtin.First: {
      const list = asList();
      return list.length === 0 ? null : list[0];
    }
    case Builtin.Last: {
      const list = asList();
      return list.length === 0 ? null : list[list.length - 1];
    }
    case Builtin.Count:
      return asList().filter((item) => valuesEqual(item, arg1)).length;
    case Builtin.Join: {
      const separator = arg1 === null ? "" : formatValue(arg1);
      return asList().map(formatValue).join(separator);
    }
    case Builtin.Take:
      return asList().slice(0, Math.max(0, index(arg1, 0)));
    case Builtin.Sum: {
      let total = 0;
      for (const item of asList()) total += num(item, fn, pc);
      return total;
    }
    case Builtin.Upper:
      return asStr().toUpperCase();
    case Builtin.Lower:
      return asStr().toLowerCase();
    case Builtin.Trim:
      return asStr().trim();
    case Builtin.Split: {
      const separator = arg1 === null ? "" : formatValue(arg1);
      return asStr().split(separator);
    }
    case Builtin.Chars:
      return [...asStr()];
    case Builtin.Abs:
      return Math.abs(num(self, fn, pc));
    case Builtin.Floor:
      return Math.floor(num(self, fn, pc));
    case Builtin.Round:
      return Math.round(num(self, fn, pc));
    case Builtin.Sqrt: {
      const value = num(self, fn, pc);
      if (value < 0) throw new SunVmTrap("sqrt of a negative number", fn.name, pc);
      return Math.sqrt(value);
    }
    case Builtin.Min:
      return Math.min(num(self, fn, pc), num(arg1, fn, pc));
    case Builtin.Max:
      return Math.max(num(self, fn, pc), num(arg1, fn, pc));
    case Builtin.Str:
      return formatValue(self);
    case Builtin.Int:
      return Math.trunc(num(self, fn, pc));
    case Builtin.Float:
      return num(self, fn, pc);
    case Builtin.Range: {
      const start = index(self, 0);
      const end = index(arg1, start);
      const values: SunVmValue[] = [];
      for (let i = start; i < end; i += 1) values.push(i);
      return values;
    }
    case Builtin.Assert:
      if (!truthy(self)) {
        throw new SunVmTrap(
          arg1 === null ? "assertion failed" : `assertion failed: ${formatValue(arg1)}`,
          fn.name,
          pc,
        );
      }
      return null;
    default:
      throw new SunVmTrap(`unknown builtin ${id}`, fn.name, pc);
  }
}

function typeName(value: SunVmValue): string {
  if (value === null) return "unit";
  if (Array.isArray(value)) return "list";
  return typeof value;
}

/** Function index carried by a `FuncRef` handle, or null for other values. */
export function functionHandleIndex(value: SunVmValue): number | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const index = (value as { __sunvm_fn?: unknown }).__sunvm_fn;
  return typeof index === "number" ? index : null;
}

/**
 * Resolve a name against the module's game data.
 *
 * A game name yields a record of that game's members, so `SlotMachine.bet` works
 * as a field read on the returned record. A bare member name resolves against
 * every declared game, which is how an implicit `self.field` read inside a game
 * method finds its value.
 */
function loadGameData(program: SunVmProgram, name: string): SunVmValue {
  const games = program.gameData ?? {};
  const direct = games[name];
  if (direct !== undefined) {
    const record: { [key: string]: SunVmValue } = {};
    for (const [key, member] of Object.entries(direct)) record[key] = constToValue(member);
    return record;
  }
  for (const members of Object.values(games)) {
    const member = members[name];
    if (member !== undefined) return constToValue(member);
  }
  return null;
}

function constToValue(
  member: { k: string; value?: unknown; values?: Array<{ k: string; value?: unknown }> },
): SunVmValue {
  if (member.k === "list") {
    return (member.values ?? []).map((value) => constToValue(value as { k: string; value?: unknown }));
  }
  if (member.k === "unit") return null;
  return (member.value ?? null) as SunVmValue;
}
