import type { BlockStmt, Expr, FnDecl, Param } from "../parser/ast.js";

/** Runtime value representation. */
export type Value =
  | { t: "int"; v: number }
  | { t: "float"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "unit" }
  | { t: "list"; v: Value[] }
  | { t: "money"; v: bigint; currency: string } // minor units x 10^4 (scale 4)
  | { t: "record"; v: Map<string, Value>; typeName: string }
  | { t: "variant"; name: string; typeName: string }
  | { t: "fn"; decl: FnDecl; closure: Env }
  | { t: "lambda"; params: Param[]; body: Expr; closure: Env }
  | { t: "native"; name: string; arity: number; call: (args: Value[]) => Value }
  | { t: "namespace"; name: string; members: Map<string, Value> }
  | { t: "game"; name: string; fields: Map<string, Value>; methods: Map<string, Value>; env: Env };

export const UNIT: Value = { t: "unit" };

export function int(v: number): Value {
  return { t: "int", v: Math.trunc(v) };
}
export function float(v: number): Value {
  return { t: "float", v };
}
export function str(v: string): Value {
  return { t: "str", v };
}
export function bool(v: boolean): Value {
  return { t: "bool", v };
}
export function list(v: Value[]): Value {
  return { t: "list", v };
}
export function record(v: Map<string, Value>, typeName = "Record"): Value {
  return { t: "record", v, typeName };
}
export function money(minor: bigint, currency = "THB"): Value {
  return { t: "money", v: minor, currency };
}
export function native(name: string, arity: number, call: (args: Value[]) => Value): Value {
  return { t: "native", name, arity, call };
}
export function namespace(name: string, members: Record<string, Value>): Value {
  return { t: "namespace", name, members: new Map(Object.entries(members)) };
}

export const MONEY_SCALE = 10_000n;

export function moneyFromUnits(units: number, satang = 0, currency = "THB"): Value {
  const minor = BigInt(Math.trunc(units)) * MONEY_SCALE + BigInt(Math.trunc(satang)) * 100n;
  return money(minor, currency);
}

export function moneyToNumber(v: Value): number {
  if (v.t !== "money") return 0;
  return Number(v.v) / Number(MONEY_SCALE);
}

export function formatMoney(v: Value & { t: "money" }): string {
  const negative = v.v < 0n;
  const abs = negative ? -v.v : v.v;
  const whole = abs / MONEY_SCALE;
  const frac = abs % MONEY_SCALE;
  const cents = (frac / 100n).toString().padStart(2, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${cents} ${v.currency}`;
}

/** Convert a value to its display form, used by `print` and interpolation. */
export function display(v: Value): string {
  switch (v.t) {
    case "int":
      return String(v.v);
    case "float":
      return formatFloat(v.v);
    case "str":
      return v.v;
    case "bool":
      return v.v ? "true" : "false";
    case "unit":
      return "()";
    case "list":
      return `[${v.v.map(display).join(", ")}]`;
    case "money":
      return formatMoney(v);
    case "record": {
      const inner = [...v.v.entries()].map(([k, val]) => `${k}: ${display(val)}`).join(", ");
      return `${v.typeName} { ${inner} }`;
    }
    case "variant":
      return v.name;
    case "fn":
      return `<fn ${v.decl.name}>`;
    case "lambda":
      return "<closure>";
    case "native":
      return `<native ${v.name}>`;
    case "namespace":
      return `<module ${v.name}>`;
    case "game":
      return `<game ${v.name}>`;
  }
}

function formatFloat(n: number): string {
  if (Number.isInteger(n)) return n.toFixed(1);
  return String(Number(n.toFixed(10)));
}

export function typeNameOf(v: Value): string {
  switch (v.t) {
    case "int":
      return "Int";
    case "float":
      return "Float";
    case "str":
      return "Str";
    case "bool":
      return "Bool";
    case "unit":
      return "Unit";
    case "list":
      return "List";
    case "money":
      return "Money";
    case "record":
      return v.typeName;
    case "variant":
      return v.typeName;
    case "fn":
    case "lambda":
    case "native":
      return "Fn";
    case "namespace":
      return "Module";
    case "game":
      return "Game";
  }
}

export function truthy(v: Value): boolean {
  if (v.t === "bool") return v.v;
  throw new Error(`expected Bool but found ${typeNameOf(v)}`);
}

export function numeric(v: Value): number {
  if (v.t === "int" || v.t === "float") return v.v;
  if (v.t === "money") return moneyToNumber(v);
  throw new Error(`expected a number but found ${typeNameOf(v)}`);
}

export function valueEquals(a: Value, b: Value): boolean {
  if (a.t === "money" && b.t === "money") return a.v === b.v && a.currency === b.currency;
  if (a.t === "list" && b.t === "list") {
    return a.v.length === b.v.length && a.v.every((x, i) => valueEquals(x, b.v[i]));
  }
  if (a.t === "variant" && b.t === "variant") return a.name === b.name;
  if (a.t === "unit" && b.t === "unit") return true;
  if ((a.t === "int" || a.t === "float") && (b.t === "int" || b.t === "float")) return a.v === b.v;
  if (a.t === "str" && b.t === "str") return a.v === b.v;
  if (a.t === "bool" && b.t === "bool") return a.v === b.v;
  return false;
}

/** Lexical environment used by the interpreter. */
export class Env {
  private readonly vars = new Map<string, { value: Value; mutable: boolean }>();

  constructor(readonly parent: Env | null = null) {}

  declare(name: string, value: Value, mutable = false): void {
    this.vars.set(name, { value, mutable });
  }

  get(name: string): Value | undefined {
    const slot = this.vars.get(name);
    if (slot) return slot.value;
    return this.parent?.get(name);
  }

  has(name: string): boolean {
    return this.vars.has(name) || (this.parent?.has(name) ?? false);
  }

  set(name: string, value: Value): boolean {
    const slot = this.vars.get(name);
    if (slot) {
      slot.value = value;
      return true;
    }
    return this.parent?.set(name, value) ?? false;
  }

  names(): string[] {
    return [...this.vars.keys()];
  }
}

export type { BlockStmt };
