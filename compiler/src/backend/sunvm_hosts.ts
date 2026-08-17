/**
 * Real host bindings for SunVM.
 *
 * SunVM lowers a call to a runtime namespace member (`Deck.shuffled`,
 * `Card.pip`, `Rtp.estimate`, ...) into `Op.CallHost` against a named import.
 * Until now the CLI satisfied those imports with `() => null`, so a program
 * kept running with `unit` flowing through its arithmetic and produced a
 * *silently wrong* answer — worse than a crash, because nothing signalled it.
 *
 * This module binds the same implementations the interpreter uses, so the VM and
 * the interpreter compute the same thing by construction rather than by
 * duplicated effort. The only work here is translating between the two value
 * models:
 *
 *   interpreter `Value`   tagged union: {t:"int"|"float"|"str"|"list"|"record"|…}
 *   `SunVmValue`          plain JS: number | boolean | string | array | object | null
 *
 * `Int` and `Float` collapse to one JS `number` in the VM, which is exactly what
 * the VM's own arithmetic already assumes.
 */

import {
  makeBaccaratNamespace,
  makeCardNamespace,
  makeDeckNamespace,
  makeDiceNamespace,
  makeFairNamespace,
  makeMathNamespace,
  makeMoneyNamespace,
  makePokerNamespace,
  makeReelNamespace,
  makeRngNamespace,
  makeRtpNamespace,
  type RtpHost,
} from "../runtime/gaming.js";
import { SecureRng, SimRng, type SunraRng } from "../runtime/rng.js";
import { bool, float, int, list, money, record, str, UNIT, type Value } from "../runtime/values.js";
import { functionHandleIndex, type SunVmRuntime, type SunVmValue } from "./sunvm_run.js";

/** Convert a VM value into the interpreter's representation. */
export function toRuntimeValue(value: SunVmValue): Value {
  if (value === null) return UNIT;
  if (typeof value === "boolean") return bool(value);
  if (typeof value === "string") return str(value);
  if (typeof value === "number") {
    // The VM has a single numeric type. An integral number is presented as Int so
    // that natives which index, count or compare integers behave as they do in
    // the interpreter; anything fractional is a Float.
    return Number.isInteger(value) ? int(value) : float(value);
  }
  if (Array.isArray(value)) return list(value.map(toRuntimeValue));
  // A function handle is not data: it must reach `Rtp.estimate` intact so the
  // host can call back into the VM.
  if (functionHandleIndex(value) !== null) return handleAsValue(value);
  // Money is an exact tagged runtime value. Preserve the tag and minor-unit
  // integer instead of treating it as an ordinary JS number; otherwise a value
  // returned by `Money.of` reaches `Money.divide` as Int/Float and is rejected.
  const taggedMoney = value as { __sunra_money?: unknown; __sunra_currency?: unknown };
  if (typeof taggedMoney.__sunra_money === "string") {
    try {
      const currency = typeof taggedMoney.__sunra_currency === "string"
        ? taggedMoney.__sunra_currency
        : "THB";
      return money(BigInt(taggedMoney.__sunra_money), currency);
    } catch {
      throw new Error("SunVM: invalid Money value crossing host boundary");
    }
  }
  const entries = new Map<string, Value>();
  for (const [key, member] of Object.entries(value)) entries.set(key, toRuntimeValue(member));
  // Runtime natives dispatch on `typeName` — `Fair.use` requires a `Ceremony`,
  // `Reel.spin` recognises a `Reel`, `Card.pip` a `Card`. The tag is therefore
  // carried in the VM value under a reserved key so a record survives the round
  // trip as the *same* kind of record, not a generic one.
  const tag = typeof (value as { __sunra_type?: unknown }).__sunra_type === "string"
    ? (value as { __sunra_type: string }).__sunra_type
    : "Record";
  entries.delete("__sunra_type");
  return record(entries, tag);
}

/** Convert an interpreter value back into the VM's representation. */
export function toVmValue(value: Value): SunVmValue {
  switch (value.t) {
    case "int":
    case "float":
      return value.v;
    case "str":
      return value.v;
    case "bool":
      return value.v;
    case "unit":
      return null;
    case "list":
      return value.v.map(toVmValue);
    case "money":
      // Keep Money exact across the plain-JS VM boundary. The decimal display
      // number is deliberately not used here because it loses the runtime tag
      // required by Money.add/sub/divide/scale.
      return {
        __sunra_money: value.v.toString(),
        __sunra_currency: value.currency,
      };
    case "record": {
      const out: { [key: string]: SunVmValue } = {};
      for (const [key, member] of value.v.entries()) out[key] = toVmValue(member);
      // A wrapped VM function handle unwraps back to the handle itself.
      if (value.typeName === "__SunVmFunction") {
        const index = value.v.get("__sunvm_fn");
        if (index && (index.t === "int" || index.t === "float")) return { __sunvm_fn: index.v };
      }
      // Preserve the runtime type tag so a record can be handed back to a native
      // that dispatches on it (see `toRuntimeValue`).
      if (value.typeName && value.typeName !== "Record") out.__sunra_type = value.typeName;
      return out;
    }
    case "variant":
      return value.name;
    case "namespace":
      return null;
    case "game":
      return null;
    case "fn":
    case "lambda":
    case "native":
      // A function cannot cross back into the VM as a callable; callers that need
      // higher-order behaviour go through `Rtp.estimate`, which receives the VM's
      // own function handle and calls back into the VM.
      return null;
  }
}

export interface GamingHostOptions {
  /** Deterministic seed. When present, every namespace draws from `SimRng`. */
  seed?: string | null;
  /** Sink for `print`/`println` and `audit.record`. */
  onOutput?: (line: string) => void;
}

/**
 * Older compact VM game-data encodings may carry numeric list fields as decimal
 * strings. Reel weights are numeric by contract, so normalize only this host
 * argument instead of weakening the VM's general string/number model.
 */
function normalizeReelOfArgs(args: SunVmValue[]): SunVmValue[] {
  if (args.length < 2 || !Array.isArray(args[1])) return args;
  const weights = args[1].map((weight, index) => {
    if (typeof weight === "number" && Number.isFinite(weight)) return weight;
    if (typeof weight === "string" && weight.trim() !== "") {
      const parsed = Number(weight);
      if (Number.isFinite(parsed)) return parsed;
    }
    throw new Error(`Reel.of: weight ${index} must be a finite number`);
  });
  return [args[0], weights, ...args.slice(2)];
}

/**
 * Build the flat `name -> HostFn` table for every runtime namespace member.
 *
 * The names are exactly the import names SunVM emits (`"Deck.shuffled"`), so
 * binding is a lookup rather than a translation table that can drift.
 */
export function gamingHostBindings(
  runtime: SunVmRuntime,
  options: GamingHostOptions = {},
): Map<string, (args: SunVmValue[]) => SunVmValue> {
  let rng: SunraRng = options.seed ? new SimRng(options.seed) : new SecureRng();

  // `Rtp.estimate` receives the round to simulate as a value. Inside the VM that
  // is a function handle, so the host calls back into the VM to run it — the
  // simulated rounds execute in the sandbox, not on the host.
  const host: RtpHost = {
    current: () => rng,
    setCurrent: (next: SunraRng) => {
      rng = next;
    },
    callFunction: (fn: Value, args: Value[]): Value => {
      // `fn` arrives as the wrapper produced by `toRuntimeValue`; `toVmValue`
      // turns it back into the raw handle the VM understands.
      const handle = toVmValue(fn);
      const index = functionHandleIndex(handle);
      if (index === null) {
        throw new Error("Rtp.estimate expects a Sunra function; the VM passed a non-callable value");
      }
      return toRuntimeValue(runtime.callFunctionValue(handle, args.map(toVmValue)));
    },
  };

  // `callFunction` above converts the handle through `toVmValue`, which cannot
  // represent a callable. The VM instead hands the handle to the host *as* a
  // value, so it arrives already in VM form and is re-wrapped below.
  const namespaces: Value[] = [
    makeRngNamespace(host),
    makeReelNamespace(host),
    makeDeckNamespace(host),
    makeCardNamespace(),
    makeBaccaratNamespace(),
    makePokerNamespace(),
    makeDiceNamespace(host),
    makeMoneyNamespace(),
    makeFairNamespace(host),
    makeRtpNamespace(host),
    makeMathNamespace(),
  ];

  const table = new Map<string, (args: SunVmValue[]) => SunVmValue>();
  for (const ns of namespaces) {
    if (ns.t !== "namespace") continue;
    for (const [member, value] of ns.members.entries()) {
      if (value.t !== "native") continue;
      const qualified = `${ns.name}.${member}`;
      table.set(qualified, (args) => {
        const normalizedArgs = qualified === "Reel.of" ? normalizeReelOfArgs(args) : args;
        return toVmValue(value.call(normalizedArgs.map(toRuntimeValue)));
      });
    }
  }

  const emit = options.onOutput;
  if (emit) {
    table.set("audit.record", (args) => {
      emit(`[audit] ${args.map((arg) => formatHostValue(arg)).join(" ")}`);
      return null;
    });
  }
  return table;
}

/**
 * Wrap a VM function handle so it can travel through interpreter code untouched.
 *
 * `Rtp.estimate` only forwards the value to `host.callFunction`, so a record
 * carrying the handle is enough; `toVmValue` turns it back into the handle.
 */
function handleAsValue(handle: SunVmValue): Value {
  const entries = new Map<string, Value>();
  const index = functionHandleIndex(handle);
  entries.set("__sunvm_fn", int(index ?? -1));
  return record(entries, "__SunVmFunction");
}

function formatHostValue(value: SunVmValue): string {
  if (value === null) return "unit";
  if (Array.isArray(value)) return `[${value.map(formatHostValue).join(", ")}]`;
  if (typeof value === "object") {
    return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${formatHostValue(v)}`).join(", ")} }`;
  }
  return String(value);
}

/**
 * Bind every gaming namespace the loaded module imports.
 *
 * Returns the names that remain unbound: a caller should surface them as an
 * error rather than substituting a stub, which is what made SunVM silently
 * return wrong values before.
 */
export function bindGamingHosts(runtime: SunVmRuntime, options: GamingHostOptions = {}): string[] {
  const table = gamingHostBindings(runtime, options);
  for (const [name, fn] of table.entries()) runtime.bind(name, fn);
  return runtime.missingImports();
}
