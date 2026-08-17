/**
 * The Sunra JavaScript runtime, emitted verbatim next to every build.
 *
 * This file is a *string* rather than a module because it must be written into
 * the user's output directory, run under plain Node.js or a browser, and remain
 * readable to anyone auditing a generated artifact. It has no dependencies.
 *
 * The semantics implemented here mirror the interpreter exactly: the same money
 * rules, the same absence of truthiness, the same unbiased randomness, and the
 * same provably fair derivation. A build and a run of the same program must not
 * disagree, or the compiler would be unfit for its purpose.
 */

export const RUNTIME_SOURCE = String.raw`// Sunra runtime 0.2.0 — generated support library.
//
// Emitted by the Sunra compiler. Safe to read, safe to audit, safe to vendor.
// Every function here is either a semantic primitive of the language or a
// standard-library module described in the Sunra whitepaper.

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

const IS_NODE =
  typeof process !== "undefined" && process.versions != null && process.versions.node != null;

let nodeCrypto = null;
if (IS_NODE) {
  try {
    nodeCrypto = await import("node:crypto");
  } catch {
    nodeCrypto = null;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SunraRuntimeError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = "SunraRuntimeError";
    this.hint = hint ?? null;
  }
}

function fail(message, hint) {
  throw new SunraRuntimeError(message, hint);
}

// ---------------------------------------------------------------------------
// Money: exact fixed point, four decimal places of minor units
// ---------------------------------------------------------------------------

const MONEY_SCALE = 10000n;

export class SunraMoney {
  constructor(minor, currency) {
    this.minor = BigInt(minor);
    this.currency = currency ?? "THB";
    Object.freeze(this);
  }

  static of(units, satang, currency) {
    const whole = BigInt(Math.trunc(Number(units ?? 0))) * MONEY_SCALE;
    const frac = BigInt(Math.trunc(Number(satang ?? 0))) * 100n;
    return new SunraMoney(whole + frac, currency ?? "THB");
  }

  static zero(currency) {
    return new SunraMoney(0n, currency ?? "THB");
  }

  add(other) {
    this.requireSameCurrency(other, "add");
    return new SunraMoney(this.minor + other.minor, this.currency);
  }

  sub(other) {
    this.requireSameCurrency(other, "subtract");
    return new SunraMoney(this.minor - other.minor, this.currency);
  }

  times(n) {
    if (!Number.isInteger(n)) {
      fail(
        "cannot multiply Money by a non-integer",
        "Money is fixed-point; use Money.scale(amount, numerator, denominator) for exact ratios",
      );
    }
    return new SunraMoney(this.minor * BigInt(n), this.currency);
  }

  dividedBy(n) {
    if (!Number.isInteger(n) || n === 0) fail("cannot divide Money by " + n);
    return new SunraMoney(this.minor / BigInt(n), this.currency);
  }

  negate() {
    return new SunraMoney(-this.minor, this.currency);
  }

  isZero() {
    return this.minor === 0n;
  }

  toFloat() {
    return Number(this.minor) / Number(MONEY_SCALE);
  }

  requireSameCurrency(other, verb) {
    if (!(other instanceof SunraMoney)) fail("cannot " + verb + " Money and a non-Money value");
    if (other.currency !== this.currency) {
      fail(
        "cannot " + verb + " " + this.currency + " and " + other.currency,
        "convert one side with an explicit exchange operation",
      );
    }
  }

  toString() {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const whole = abs / MONEY_SCALE;
    const cents = ((abs % MONEY_SCALE) / 100n).toString().padStart(2, "0");
    const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (negative ? "-" : "") + grouped + "." + cents + " " + this.currency;
  }
}

// ---------------------------------------------------------------------------
// Records: ordered string-keyed maps with a type name, as produced by
// Deck.deal, Fair.begin, Money.divide and friends.
// ---------------------------------------------------------------------------

export class SunraRecord {
  constructor(typeName, entries) {
    this.$type = typeName;
    for (const [key, value] of entries) this[key] = value;
  }

  toString() {
    const inner = Object.keys(this)
      .filter((k) => k !== "$type")
      .map((k) => k + ": " + display(this[k]))
      .join(", ");
    return this.$type + " { " + inner + " }";
  }
}

function rec(typeName, obj) {
  return new SunraRecord(typeName, Object.entries(obj));
}

// ---------------------------------------------------------------------------
// Display and formatting
// ---------------------------------------------------------------------------

export function display(v) {
  if (v === null || v === undefined) return "()";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "string") return v;
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return "[" + v.map(display).join(", ") + "]";
  if (v instanceof SunraMoney) return v.toString();
  if (v instanceof SunraRecord) return v.toString();
  if (typeof v === "function") return "<fn " + (v.name || "anonymous") + ">";
  if (v && v.$module) return "<module " + v.$module + ">";
  if (v && v.$game) return "<game " + v.$game + ">";
  if (v instanceof Map) return "{" + [...v].map(([k, x]) => k + ": " + display(x)).join(", ") + "}";
  if (typeof v === "object") {
    return "{" + Object.entries(v).map(([k, x]) => k + ": " + display(x)).join(", ") + "}";
  }
  return String(v);
}

function formatNumber(n) {
  if (Number.isInteger(n)) return String(n);
  const rounded = Number(n.toFixed(10));
  return String(rounded);
}

export function format(value, spec) {
  if (!spec) return display(value);
  const decimals = /^\.(\d+)$/.exec(spec);
  if (decimals) return numeric(value).toFixed(Number(decimals[1]));
  if (spec === "%") return (numeric(value) * 100).toFixed(2) + "%";
  return display(value);
}

// ---------------------------------------------------------------------------
// Core semantics
// ---------------------------------------------------------------------------

function typeName(v) {
  if (v === null || v === undefined) return "Unit";
  if (typeof v === "boolean") return "Bool";
  if (typeof v === "number") return Number.isInteger(v) ? "Int" : "Float";
  if (typeof v === "string") return "Str";
  if (Array.isArray(v)) return "List";
  if (v instanceof SunraMoney) return "Money";
  if (v instanceof SunraRecord) return v.$type;
  if (typeof v === "function") return "Fn";
  return "Value";
}

function numeric(v) {
  if (typeof v === "number") return v;
  if (v instanceof SunraMoney) return v.toFloat();
  if (typeof v === "bigint") return Number(v);
  fail("expected a number but found " + typeName(v));
}

export function truthy(v) {
  if (typeof v === "boolean") return v;
  fail(
    "expected a Bool condition but found " + typeName(v),
    "Sunra has no truthiness; compare explicitly, e.g. 'x != 0'",
  );
}

export function eq(a, b) {
  if (a instanceof SunraMoney && b instanceof SunraMoney) {
    return a.minor === b.minor && a.currency === b.currency;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  }
  if (a instanceof SunraRecord && b instanceof SunraRecord) {
    if (a.$type !== b.$type) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => eq(a[k], b[k]));
  }
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

export function cmp(op, a, b) {
  if (typeof a === "string" && typeof b === "string") {
    const c = a.localeCompare(b);
    return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
  }
  const x = numeric(a);
  const y = numeric(b);
  return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
}

export function neg(v) {
  if (v instanceof SunraMoney) return v.negate();
  return -numeric(v);
}

export function arith(op, a, b) {
  // String concatenation
  if (op === "+" && (typeof a === "string" || typeof b === "string")) {
    return display(a) + display(b);
  }

  // List concatenation
  if (op === "+" && Array.isArray(a) && Array.isArray(b)) return a.concat(b);

  // Money arithmetic is exact and dimensionally checked
  if (a instanceof SunraMoney || b instanceof SunraMoney) return moneyArith(op, a, b);

  const x = numeric(a);
  const y = numeric(b);

  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      if (y === 0) fail("division by zero");
      return x / y;
    case "%":
      if (y === 0) fail("modulo by zero");
      return x % y;
    default:
      fail("unsupported operator " + op);
  }
}

export function intDiv(a, b) {
  const x = numeric(a);
  const y = numeric(b);
  if (y === 0) fail("division by zero");
  return Math.floor(x / y);
}

function moneyArith(op, a, b) {
  if (a instanceof SunraMoney && b instanceof SunraMoney) {
    if (op === "+") return a.add(b);
    if (op === "-") return a.sub(b);
    fail(
      op + " is not defined for Money and Money",
      "multiplying two amounts of money is a dimensional error",
    );
  }

  const money = a instanceof SunraMoney ? a : b;
  const other = a instanceof SunraMoney ? b : a;

  if (typeof other !== "number") fail("cannot apply " + op + " to Money and " + typeName(other));
  if (!Number.isInteger(other)) {
    fail(
      "cannot " + (op === "*" ? "multiply" : "combine") + " Money with Float",
      "Money is fixed-point; use Money.scale(amount, numerator, denominator)",
    );
  }

  if (op === "*") return money.times(other);
  if (op === "/") return money.dividedBy(other);
  fail(op + " is not defined for Money and Int");
}

export function index(object, key) {
  if (Array.isArray(object)) {
    let i = Math.trunc(numeric(key));
    if (i < 0) i += object.length;
    if (i < 0 || i >= object.length) {
      fail("index " + i + " is out of bounds for a list of length " + object.length);
    }
    return object[i];
  }
  if (typeof object === "string") {
    const chars = [...object];
    const i = Math.trunc(numeric(key));
    if (i < 0 || i >= chars.length) {
      fail("index " + i + " is out of bounds for a string of length " + chars.length);
    }
    return chars[i];
  }
  if (object instanceof SunraRecord || (object && typeof object === "object")) {
    const k = typeof key === "string" ? key : display(key);
    return object[k];
  }
  fail("cannot index " + typeName(object));
}

export function setIndex(object, key, value, op) {
  if (!Array.isArray(object)) fail("cannot index-assign into " + typeName(object));
  let i = Math.trunc(numeric(key));
  if (i < 0) i += object.length;
  const next = op === null ? value : arith(op, object[i], value);
  object[i] = next;
  return next;
}

export function member(object, property) {
  if (object === null || object === undefined) {
    fail("cannot read '" + property + "' of a unit value");
  }

  // Data members win over built-in methods, matching the interpreter.
  if (typeof object === "object" && property in object) {
    const value = object[property];
    if (typeof value === "function") return value.bind(object);
    return value;
  }

  const method = builtinMethod(object, property);
  if (method) return method;

  if (object instanceof SunraMoney) {
    if (property === "amount") return object.toFloat();
    if (property === "currency") return object.currency;
  }

  fail(
    typeName(object) + " has no member '" + property + "'",
    "check the standard library reference in the Sunra documentation",
  );
}

export function setMember(object, property, value, op) {
  if (!object || typeof object !== "object") {
    fail("cannot assign to a member of " + typeName(object));
  }
  const next = op === null ? value : arith(op, object[property], value);
  object[property] = next;
  return next;
}

export function call(fn, args) {
  if (typeof fn !== "function") fail(typeName(fn) + " is not callable");
  return fn(...args);
}

export function invoke(object, property, args) {
  const target = member(object, property);
  if (typeof target !== "function") fail(typeName(object) + "." + property + " is not callable");
  return target(...args);
}

export function iterate(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (typeof v === "number") {
    const out = [];
    for (let i = 0; i < v; i++) out.push(i);
    return out;
  }
  if (v && typeof v[Symbol.iterator] === "function") return v;
  fail("cannot iterate over " + typeName(v), "iterate a list, a string, or a range");
}

export function rangeOf(from, to, inclusive) {
  const lo = Math.trunc(numeric(from));
  const hi = Math.trunc(numeric(to));
  const end = inclusive ? hi + 1 : hi;
  const out = [];
  for (let i = lo; i < end; i++) out.push(i);
  return out;
}

export function matchFailed(subject) {
  fail(
    "no match arm applies to " + display(subject),
    "add a '_ -> ...' arm, or cover the remaining cases",
  );
}

export function reel(symbols, weights) {
  return rec("Reel", {
    symbols: symbols,
    weights: weights ?? symbols.map(() => 1),
    length: symbols.length,
  });
}
`;

export const RUNTIME_SOURCE_PART2 = String.raw`
// ---------------------------------------------------------------------------
// Built-in methods on primitive values
// ---------------------------------------------------------------------------

function builtinMethod(self, name) {
  if (Array.isArray(self)) {
    switch (name) {
      case "len": return () => self.length;
      case "push": return (x) => { self.push(x); return self; };
      case "first": return () => self[0];
      case "last": return () => self[self.length - 1];
      case "map": return (f) => self.map((x) => f(x));
      case "filter": return (f) => self.filter((x) => truthy(f(x)));
      case "count": return (x) => self.filter((y) => eq(x, y)).length;
      case "contains": return (x) => self.some((y) => eq(x, y));
      case "sum": return () => self.reduce((a, x) => a + numeric(x), 0);
      case "reverse": return () => [...self].reverse();
      case "join": return (sep) => self.map(display).join(sep === undefined ? "" : display(sep));
      case "take": return (n) => self.slice(0, Math.trunc(numeric(n)));
      case "slice": return (a, b) => self.slice(Math.trunc(numeric(a)), b === undefined ? undefined : Math.trunc(numeric(b)));
      default: break;
    }
  }

  if (typeof self === "string") {
    switch (name) {
      case "len": return () => [...self].length;
      case "upper": return () => self.toUpperCase();
      case "lower": return () => self.toLowerCase();
      case "trim": return () => self.trim();
      case "contains": return (x) => self.includes(display(x));
      case "split": return (sep) => self.split(display(sep));
      case "chars": return () => [...self];
      default: break;
    }
  }

  if (typeof self === "number") {
    switch (name) {
      case "abs": return () => Math.abs(self);
      case "round": return () => Math.round(self);
      case "toFloat": return () => self;
      case "toInt": return () => Math.trunc(self);
      default: break;
    }
  }

  if (self instanceof SunraMoney) {
    switch (name) {
      case "isZero": return () => self.isZero();
      case "toFloat": return () => self.toFloat();
      case "scale": return (f) => scaleMoney(self, f);
      default: break;
    }
  }

  return null;
}

function scaleMoney(money, factor) {
  const n = Number(factor);
  const scaled = (money.minor * BigInt(Math.round(n * 1000000))) / 1000000n;
  return new SunraMoney(scaled, money.currency);
}

// ---------------------------------------------------------------------------
// Hashing: HMAC-SHA256 and SHA-256, on Node.js or in a browser
// ---------------------------------------------------------------------------

function sha256Hex(input) {
  if (nodeCrypto) return nodeCrypto.createHash("sha256").update(input).digest("hex");
  return sha256HexPure(input);
}

function hmacSha256Bytes(key, message) {
  if (nodeCrypto) {
    return new Uint8Array(nodeCrypto.createHmac("sha256", key).update(message).digest());
  }
  return hmacSha256Pure(key, message);
}

// A compact, dependency-free SHA-256 used when node:crypto is unavailable
// (for example inside the browser playground). Correctness is verified by the
// compiler's regression suite against the Node implementation.
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function sha256Bytes(bytes) {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLen = bytes.length * 8;
  const withPad = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < withPad.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;

      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i], false);
  return out;
}

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function sha256HexPure(input) {
  return toHex(sha256Bytes(utf8Bytes(input)));
}

function hmacSha256Pure(key, message) {
  const blockSize = 64;
  let keyBytes = utf8Bytes(key);
  if (keyBytes.length > blockSize) keyBytes = sha256Bytes(keyBytes);

  const padded = new Uint8Array(blockSize);
  padded.set(keyBytes);

  const inner = new Uint8Array(blockSize);
  const outer = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = padded[i] ^ 0x36;
    outer[i] = padded[i] ^ 0x5c;
  }

  const msg = utf8Bytes(message);
  const innerInput = new Uint8Array(blockSize + msg.length);
  innerInput.set(inner);
  innerInput.set(msg, blockSize);
  const innerHash = sha256Bytes(innerInput);

  const outerInput = new Uint8Array(blockSize + 32);
  outerInput.set(outer);
  outerInput.set(innerHash, blockSize);
  return sha256Bytes(outerInput);
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  if (nodeCrypto) {
    bytes.set(nodeCrypto.randomBytes(byteLength));
  } else if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return toHex(bytes);
}

function ceremonySeedHex(byteLength) {
  if ($current.kind !== "sim" && $current.kind !== "fair" && $current.kind !== "replay") {
    return randomHex(byteLength);
  }
  let hex = "";
  for (let i = 0; i < byteLength; i++) {
    hex += Math.trunc($current.range(0, 256)).toString(16).padStart(2, "0");
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Randomness: the same four generators the interpreter provides
// ---------------------------------------------------------------------------

const U64_MASK = (1n << 64n) - 1n;

class SimRng {
  constructor(seed) {
    this.kind = "sim";
    this.draws = 0;
    const digest = sha256Bytes(utf8Bytes(String(seed)));
    const view = new DataView(digest.buffer);
    this.s = [
      view.getBigUint64(0, false) | 1n,
      view.getBigUint64(8, false) | 1n,
      view.getBigUint64(16, false) | 1n,
      view.getBigUint64(24, false) | 1n,
    ];
  }

  nextU64() {
    const rotl = (x, k) => ((x << k) | (x >> (64n - k))) & U64_MASK;
    const result = (rotl((this.s[1] * 5n) & U64_MASK, 7n) * 9n) & U64_MASK;
    const t = (this.s[1] << 17n) & U64_MASK;

    this.s[2] ^= this.s[0];
    this.s[3] ^= this.s[1];
    this.s[1] ^= this.s[2];
    this.s[0] ^= this.s[3];
    this.s[2] ^= t;
    this.s[3] = rotl(this.s[3], 45n);

    this.draws += 1;
    return result;
  }

  nextFloat() {
    return Number(this.nextU64() >> 11n) / 2 ** 53;
  }

  range(lo, hi) {
    return unbiasedRange(() => this.nextU64(), lo, hi);
  }
}

class SecureRng {
  constructor() {
    this.kind = "secure";
    this.draws = 0;
  }

  nextU64() {
    this.draws += 1;
    const bytes = new Uint8Array(8);
    if (nodeCrypto) bytes.set(nodeCrypto.randomBytes(8));
    else if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
    return new DataView(bytes.buffer).getBigUint64(0, false);
  }

  nextFloat() {
    return Number(this.nextU64() >> 11n) / 2 ** 53;
  }

  range(lo, hi) {
    return unbiasedRange(() => this.nextU64(), lo, hi);
  }
}

class FairRng {
  constructor(serverSeed, clientSeed, nonce) {
    this.kind = "fair";
    this.draws = 0;
    this.cursor = 0;
    this.serverSeed = serverSeed;
    this.clientSeed = clientSeed;
    this.nonce = nonce;
  }

  get commitment() {
    return sha256Hex(this.serverSeed);
  }

  bytesAt(cursor) {
    return hmacSha256Bytes(this.serverSeed, this.clientSeed + ":" + this.nonce + ":" + cursor);
  }

  nextFloat() {
    const buf = this.bytesAt(this.cursor);
    this.cursor += 1;
    this.draws += 1;
    let acc = 0;
    for (let i = 0; i < 7; i++) acc = acc * 256 + buf[i];
    return acc / 2 ** 56;
  }

  range(lo, hi) {
    const span = hi - lo;
    if (span <= 0) return lo;
    const limit = Math.floor(0x100000000 / span) * span;
    for (;;) {
      const buf = this.bytesAt(this.cursor);
      this.cursor += 1;
      this.draws += 1;
      const word = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
      if (word < limit) return lo + (word % span);
    }
  }
}

function unbiasedRange(nextU64, lo, hi) {
  const span = BigInt(Math.trunc(hi) - Math.trunc(lo));
  if (span <= 0n) return Math.trunc(lo);
  const limit = ((1n << 64n) / span) * span;
  for (;;) {
    const x = nextU64();
    if (x < limit) return Math.trunc(lo) + Number(x % span);
  }
}

// The active generator. A build may bake in a seed; a host may override it.
let $current = new SecureRng();

export function $setSeed(seed) {
  $current = seed === undefined || seed === null ? new SecureRng() : new SimRng(seed);
}

export function $setRng(generator) {
  $current = generator;
}

export function $rngKind() {
  return $current.kind;
}
`;

export const RUNTIME_SOURCE_PART3 = String.raw`
// ---------------------------------------------------------------------------
// Core builtins
// ---------------------------------------------------------------------------

let $stdout = (line) => {
  if (typeof console !== "undefined") console.log(line);
};

export function $setStdout(sink) {
  $stdout = sink;
}

export function print(...args) {
  $stdout(args.map(display).join(" "));
}

export const println = print;

export function len(v) {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return [...v].length;
  if (v instanceof SunraRecord) return Object.keys(v).length - 1;
  if (v && typeof v === "object") return Object.keys(v).length;
  fail("len() does not apply to " + typeName(v));
}

export function str(v) {
  return display(v);
}

export function int(v) {
  return Math.trunc(numeric(v));
}

export function float(v) {
  return numeric(v);
}

export function abs(v) {
  return Math.abs(numeric(v));
}

export function floor(v) {
  return Math.floor(numeric(v));
}

export function ceil(v) {
  return Math.ceil(numeric(v));
}

export function round(v) {
  return Math.round(numeric(v));
}

export function sqrt(v) {
  return Math.sqrt(numeric(v));
}

export function min(...args) {
  return Math.min(...args.map(numeric));
}

export function max(...args) {
  return Math.max(...args.map(numeric));
}

export function sum(items) {
  if (!Array.isArray(items)) fail("sum() expects a list");
  if (items.length > 0 && items[0] instanceof SunraMoney) {
    let acc = SunraMoney.zero(items[0].currency);
    for (const item of items) acc = acc.add(item);
    return acc;
  }
  return items.reduce((a, x) => a + numeric(x), 0);
}

export function range(a, b, step) {
  const lo = b === undefined ? 0 : numeric(a);
  const hi = b === undefined ? numeric(a) : numeric(b);
  const inc = step === undefined ? 1 : numeric(step);
  const out = [];
  if (inc > 0) for (let i = lo; i < hi; i += inc) out.push(i);
  else for (let i = lo; i > hi; i += inc) out.push(i);
  return out;
}

export function push(list, item) {
  if (!Array.isArray(list)) fail("push() expects a list");
  list.push(item);
  return list;
}

export function assert(condition, message) {
  if (!truthy(condition)) {
    fail("assertion failed: " + (message === undefined ? "assertion failed" : display(message)));
  }
}

export function sort(items) {
  if (!Array.isArray(items)) fail("sort() expects a list");
  return [...items].sort((a, b) => numeric(a) - numeric(b));
}

// ---------------------------------------------------------------------------
// rng
// ---------------------------------------------------------------------------

export const rng = {
  $module: "rng",

  pick(items, count) {
    if (!Array.isArray(items)) fail("rng.pick expects a list");
    if (items.length === 0) fail("rng.pick cannot pick from an empty list");
    if (count === undefined) return items[$current.range(0, items.length)];
    const out = [];
    for (let i = 0; i < count; i++) out.push(items[$current.range(0, items.length)]);
    return out;
  },

  weighted(items, weights) {
    if (items.length !== weights.length) {
      fail("rng.weighted needs symbols and weights of equal length");
    }
    const total = weights.reduce((a, w) => a + numeric(w), 0);
    if (total <= 0) fail("rng.weighted weights must sum to a positive number");
    let roll = $current.nextFloat() * total;
    for (let i = 0; i < items.length; i++) {
      if (roll < weights[i]) return items[i];
      roll -= weights[i];
    }
    return items[items.length - 1];
  },

  int(lo, hi) {
    return $current.range(Math.trunc(numeric(lo)), Math.trunc(numeric(hi)) + 1);
  },

  float() {
    return $current.nextFloat();
  },

  bool() {
    return $current.nextFloat() < 0.5;
  },

  chance(p) {
    return $current.nextFloat() < numeric(p);
  },

  shuffle(items) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = $current.range(0, i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  },

  seed(value) {
    $setSeed(display(value));
  },

  kind() {
    return $current.kind;
  },

  draws() {
    return $current.draws;
  },
};

// ---------------------------------------------------------------------------
// Reel
// ---------------------------------------------------------------------------

function flattenSymbols(items) {
  const out = [];
  for (const item of items) {
    if (Array.isArray(item)) out.push(...flattenSymbols(item));
    else out.push(item);
  }
  return out;
}

function stripOf(target) {
  if (target instanceof SunraRecord && target.$type === "Reel") {
    return { symbols: target.symbols, weights: target.weights };
  }
  if (Array.isArray(target)) return { symbols: target, weights: target.map(() => 1) };
  fail("expected a reel strip or a list of symbols");
}

export const Reel = {
  $module: "Reel",

  of(symbols, weights) {
    return reel(symbols, weights);
  },

  spin(target, count) {
    const { symbols, weights } = stripOf(target);
    const n = count === undefined ? 3 : Math.trunc(numeric(count));
    const total = weights.reduce((a, w) => a + numeric(w), 0);
    const out = [];
    for (let i = 0; i < n; i++) {
      let roll = $current.nextFloat() * total;
      let picked = symbols[symbols.length - 1];
      for (let j = 0; j < symbols.length; j++) {
        if (roll < weights[j]) { picked = symbols[j]; break; }
        roll -= weights[j];
      }
      out.push(picked);
    }
    return out;
  },

  grid(target, cols, rows) {
    const { symbols } = stripOf(target);
    const out = [];
    for (let c = 0; c < cols; c++) {
      const column = [];
      for (let r = 0; r < rows; r++) column.push(symbols[$current.range(0, symbols.length)]);
      out.push(column);
    }
    return out;
  },

  count(result, symbol) {
    const items = flattenSymbols(result);
    return items.filter((s) => eq(s, symbol)).length;
  },

  isMatch(result) {
    const items = flattenSymbols(result);
    if (items.length === 0) return false;
    return items.every((s) => eq(s, items[0]));
  },

  longestRun(result) {
    const items = flattenSymbols(result);
    if (items.length === 0) return 0;
    let run = 0;
    for (const s of items) {
      if (eq(s, items[0])) run += 1;
      else break;
    }
    return run;
  },
};

// ---------------------------------------------------------------------------
// Cards, decks and table games
// ---------------------------------------------------------------------------

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["\u2660", "\u2665", "\u2666", "\u2663"];
const RANK_VALUE = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  "10": 10, J: 11, Q: 12, K: 13, A: 14,
};
const SUIT_ALIASES = {
  S: "\u2660", s: "\u2660", spades: "\u2660",
  H: "\u2665", h: "\u2665", hearts: "\u2665",
  D: "\u2666", d: "\u2666", diamonds: "\u2666",
  C: "\u2663", c: "\u2663", clubs: "\u2663",
};

function makeCard(rank, suit) {
  return rec("Card", {
    rank: rank,
    suit: suit,
    value: RANK_VALUE[rank] ?? 0,
    label: rank + suit,
  });
}

function cardRank(card) {
  if (card instanceof SunraRecord && card.$type === "Card") return card.rank;
  return display(card);
}

function buildDeck(decks) {
  const cards = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) for (const rank of RANKS) cards.push(makeCard(rank, suit));
  }
  return cards;
}

export const Card = {
  $module: "Card",

  of(rank, suit) {
    const r = display(rank).toUpperCase();
    const s = display(suit);
    return makeCard(r, SUIT_ALIASES[s] ?? s);
  },

  rank(card) {
    return cardRank(card);
  },

  label(card) {
    if (card instanceof SunraRecord && card.$type === "Card") return card.label;
    return display(card);
  },

  pip(card) {
    const rank = cardRank(card);
    if (rank === "A") return 1;
    if (["10", "J", "Q", "K"].includes(rank)) return 10;
    return Number(rank);
  },
};

export const Deck = {
  $module: "Deck",

  standard(decks) {
    return buildDeck(decks === undefined ? 1 : Math.trunc(numeric(decks)));
  },

  shuffled(decks) {
    const cards = buildDeck(decks === undefined ? 1 : Math.trunc(numeric(decks)));
    for (let i = cards.length - 1; i > 0; i--) {
      const j = $current.range(0, i + 1);
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  },

  deal(deck, n) {
    const count = Math.trunc(numeric(n));
    return rec("Deal", { hand: deck.slice(0, count), rest: deck.slice(count) });
  },

  size(deck) {
    return deck.length;
  },
};

export const Baccarat = {
  $module: "Baccarat",

  total(cards) {
    const pip = (c) => {
      const rank = cardRank(c);
      if (rank === "A") return 1;
      if (["10", "J", "Q", "K"].includes(rank)) return 0;
      return Number(rank);
    };
    return cards.reduce((a, c) => a + pip(c), 0) % 10;
  },

  playerDraws(total) {
    return numeric(total) <= 5;
  },

  bankerDraws(bankerTotal, playerThirdPip) {
    const banker = numeric(bankerTotal);
    const third = numeric(playerThirdPip);
    if (banker <= 2) return true;
    if (banker >= 7) return false;
    if (third < 0) return banker <= 5;
    switch (banker) {
      case 3: return third !== 8;
      case 4: return third >= 2 && third <= 7;
      case 5: return third >= 4 && third <= 7;
      case 6: return third === 6 || third === 7;
      default: return false;
    }
  },

  winner(playerTotal, bankerTotal) {
    const p = numeric(playerTotal);
    const b = numeric(bankerTotal);
    if (p > b) return "Player";
    if (b > p) return "Banker";
    return "Tie";
  },

  payout(bet, outcome) {
    const b = display(bet);
    const o = display(outcome);
    if (b === o) {
      if (b === "Banker") return 1.95;
      if (b === "Tie") return 9.0;
      return 2.0;
    }
    if (o === "Tie" && b !== "Tie") return 1.0;
    return 0.0;
  },

  isNatural(total) {
    const t = numeric(total);
    return t === 8 || t === 9;
  },
};

export const Poker = {
  $module: "Poker",

  rank(cards) {
    const values = cards
      .map((c) => (c instanceof SunraRecord ? Number(c.value) : 0))
      .sort((a, b) => b - a);
    const suits = cards.map((c) => (c instanceof SunraRecord ? String(c.suit) : ""));

    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const groups = [...counts.values()].sort((a, b) => b - a);
    const flush = suits.every((s) => s === suits[0]);
    const unique = [...new Set(values)].sort((a, b) => b - a);
    const straight =
      unique.length === 5 && (unique[0] - unique[4] === 4 || (unique[0] === 14 && unique[1] === 5));

    let name = "High Card";
    let score = 1;
    if (straight && flush) {
      name = values[0] === 14 && values[1] === 13 ? "Royal Flush" : "Straight Flush";
      score = name === "Royal Flush" ? 10 : 9;
    } else if (groups[0] === 4) { name = "Four of a Kind"; score = 8; }
    else if (groups[0] === 3 && groups[1] === 2) { name = "Full House"; score = 7; }
    else if (flush) { name = "Flush"; score = 6; }
    else if (straight) { name = "Straight"; score = 5; }
    else if (groups[0] === 3) { name = "Three of a Kind"; score = 4; }
    else if (groups[0] === 2 && groups[1] === 2) { name = "Two Pair"; score = 3; }
    else if (groups[0] === 2) { name = "One Pair"; score = 2; }

    return rec("HandRank", { name: name, score: score, high: values[0] ?? 0 });
  },
};

export const Dice = {
  $module: "Dice",

  roll(faces) {
    const n = faces === undefined ? 6 : Math.trunc(numeric(faces));
    return Math.floor($current.nextFloat() * n) + 1;
  },

  rollMany(count, faces) {
    const out = [];
    for (let i = 0; i < Math.trunc(numeric(count)); i++) {
      out.push(Math.floor($current.nextFloat() * Math.trunc(numeric(faces))) + 1);
    }
    return out;
  },

  total(dice) {
    return dice.reduce((a, d) => a + numeric(d), 0);
  },
};

// ---------------------------------------------------------------------------
// Money module
// ---------------------------------------------------------------------------

export const Money = {
  $module: "Money",

  of(units, satang, currency) {
    return SunraMoney.of(units, satang ?? 0, currency ?? "THB");
  },

  zero(currency) {
    return SunraMoney.zero(currency ?? "THB");
  },

  scale(amount, a, b) {
    if (!(amount instanceof SunraMoney)) fail("Money.scale expects Money");
    if (b === undefined) return scaleMoney(amount, numeric(a));
    const num = BigInt(Math.trunc(numeric(a)));
    const den = BigInt(Math.trunc(numeric(b)));
    if (den === 0n) fail("Money.scale denominator must not be zero");
    return new SunraMoney((amount.minor * num) / den, amount.currency);
  },

  add(a, b) {
    return a.add(b);
  },

  sub(a, b) {
    return a.sub(b);
  },

  isZero(a) {
    return a instanceof SunraMoney ? a.isZero() : false;
  },

  toFloat(a) {
    return numeric(a);
  },

  divide(amount, n) {
    if (!(amount instanceof SunraMoney)) fail("Money.divide expects Money");
    const d = BigInt(Math.trunc(numeric(n)));
    if (d === 0n) fail("Money.divide cannot divide by zero");
    return rec("Division", {
      quotient: new SunraMoney(amount.minor / d, amount.currency),
      remainder: new SunraMoney(amount.minor % d, amount.currency),
    });
  },

  format(amount) {
    return display(amount);
  },
};

// ---------------------------------------------------------------------------
// Provably fair
// ---------------------------------------------------------------------------

export const Fair = {
  $module: "Fair",

  begin(clientSeed) {
    const serverSeed = ceremonySeedHex(32);
    return rec("Ceremony", {
      serverSeed: serverSeed,
      clientSeed: clientSeed === undefined ? ceremonySeedHex(8) : display(clientSeed),
      commitment: sha256Hex(serverSeed),
      nonce: 0,
      revealed: false,
    });
  },

  use(ceremony, nonce) {
    if (ceremony.revealed === true) {
      fail("this ceremony has been revealed and can no longer produce draws");
    }
    $setRng(new FairRng(ceremony.serverSeed, ceremony.clientSeed, Math.trunc(numeric(nonce))));
  },

  commitment(ceremony) {
    return ceremony.commitment;
  },

  reveal(ceremony) {
    const revealed = rec("RevealedCeremony", {
      serverSeed: ceremony.serverSeed,
      clientSeed: ceremony.clientSeed,
      commitment: ceremony.commitment,
      nonce: ceremony.nonce,
      revealed: true,
    });
    ceremony.revealed = true;
    return revealed;
  },

  verify(serverSeed, commitment) {
    return sha256Hex(display(serverSeed)) === display(commitment);
  },

  draw(serverSeed, clientSeed, nonce, cursor) {
    const generator = new FairRng(display(serverSeed), display(clientSeed), Math.trunc(numeric(nonce)));
    let value = 0;
    for (let i = 0; i <= Math.trunc(numeric(cursor)); i++) value = generator.nextFloat();
    return value;
  },

  hash(input) {
    return sha256Hex(display(input));
  },
};

// ---------------------------------------------------------------------------
// RTP tooling
// ---------------------------------------------------------------------------

function extractWin(outcome) {
  if (typeof outcome === "number") return outcome;
  if (outcome instanceof SunraMoney) return outcome.toFloat();
  if (outcome instanceof SunraRecord) {
    for (const key of ["win", "payout", "total", "amount"]) {
      const v = outcome[key];
      if (typeof v === "number") return v;
      if (v instanceof SunraMoney) return v.toFloat();
    }
  }
  return 0;
}

export const Rtp = {
  $module: "Rtp",

  estimate(resolver, rounds, bet) {
    const n = rounds === undefined ? 100000 : Math.trunc(numeric(rounds));
    const stake = bet === undefined ? 1 : numeric(bet);

    let totalWin = 0;
    let hits = 0;
    let maxWin = 0;

    for (let i = 0; i < n; i++) {
      const win = extractWin(resolver());
      totalWin += win;
      if (win > 0) hits += 1;
      if (win > maxWin) maxWin = win;
    }

    const staked = n * stake;
    return rec("RtpReport", {
      rtp: staked > 0 ? totalWin / staked : 0,
      hitRate: n > 0 ? hits / n : 0,
      maxWin: maxWin,
      rounds: n,
      totalWin: totalWin,
    });
  },

  check(actual, target, tolerance) {
    const t = numeric(target) > 1 ? numeric(target) / 100 : numeric(target);
    return Math.abs(numeric(actual) - t) <= numeric(tolerance);
  },

  volatility(samples) {
    const values = samples.map(numeric);
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  },
};

export const Math_ = {
  $module: "Math",
  pi: Math.PI,
  e: Math.E,
  floor: (v) => Math.floor(numeric(v)),
  ceil: (v) => Math.ceil(numeric(v)),
  round: (v) => Math.round(numeric(v)),
  abs: (v) => Math.abs(numeric(v)),
  sqrt: (v) => Math.sqrt(numeric(v)),
  pow: (a, b) => Math.pow(numeric(a), numeric(b)),
  min: (...a) => Math.min(...a.map(numeric)),
  max: (...a) => Math.max(...a.map(numeric)),
};

export const audit = {
  $module: "audit",
  record(...args) {
    $stdout("[audit] " + args.map(display).join(" "));
  },
};
`;

export const RUNTIME_SOURCE_PART4 = String.raw`
// ---------------------------------------------------------------------------
// Standard library: math
// ---------------------------------------------------------------------------

export const SunraMath = {
  $module: "math",

  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  infinity: Infinity,

  floor: (v) => Math.floor(numeric(v)),
  ceil: (v) => Math.ceil(numeric(v)),
  round: (v) => Math.round(numeric(v)),
  trunc: (v) => Math.trunc(numeric(v)),
  abs: (v) => Math.abs(numeric(v)),
  sign: (v) => Math.sign(numeric(v)),
  sqrt: (v) => Math.sqrt(numeric(v)),
  cbrt: (v) => Math.cbrt(numeric(v)),
  pow: (a, b) => Math.pow(numeric(a), numeric(b)),
  exp: (v) => Math.exp(numeric(v)),
  log: (v) => Math.log(numeric(v)),
  log2: (v) => Math.log2(numeric(v)),
  log10: (v) => Math.log10(numeric(v)),
  sin: (v) => Math.sin(numeric(v)),
  cos: (v) => Math.cos(numeric(v)),
  tan: (v) => Math.tan(numeric(v)),
  atan2: (a, b) => Math.atan2(numeric(a), numeric(b)),
  hypot: (...a) => Math.hypot(...a.map(numeric)),
  min: (...a) => Math.min(...a.map(numeric)),
  max: (...a) => Math.max(...a.map(numeric)),

  clamp(v, lo, hi) {
    return Math.min(Math.max(numeric(v), numeric(lo)), numeric(hi));
  },

  lerp(a, b, t) {
    const x = numeric(a);
    return x + (numeric(b) - x) * numeric(t);
  },

  gcd(a, b) {
    let x = Math.abs(Math.trunc(numeric(a)));
    let y = Math.abs(Math.trunc(numeric(b)));
    while (y !== 0) [x, y] = [y, x % y];
    return x;
  },

  lcm(a, b) {
    const x = Math.abs(Math.trunc(numeric(a)));
    const y = Math.abs(Math.trunc(numeric(b)));
    if (x === 0 || y === 0) return 0;
    return (x / SunraMath.gcd(x, y)) * y;
  },

  factorial(n) {
    const k = Math.trunc(numeric(n));
    if (k < 0) fail("math.factorial requires a non-negative integer");
    let acc = 1;
    for (let i = 2; i <= k; i++) acc *= i;
    return acc;
  },

  // Combinatorics matter for paytable and hand-probability work, so they are
  // first-class rather than something each game re-derives.
  combinations(n, k) {
    const N = Math.trunc(numeric(n));
    const K = Math.trunc(numeric(k));
    if (K < 0 || K > N) return 0;
    let acc = 1;
    for (let i = 1; i <= K; i++) acc = (acc * (N - K + i)) / i;
    return Math.round(acc);
  },

  permutations(n, k) {
    const N = Math.trunc(numeric(n));
    const K = Math.trunc(numeric(k));
    if (K < 0 || K > N) return 0;
    let acc = 1;
    for (let i = 0; i < K; i++) acc *= N - i;
    return acc;
  },

  mean(items) {
    const values = items.map(numeric);
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  },

  median(items) {
    const values = items.map(numeric).sort((a, b) => a - b);
    if (values.length === 0) return 0;
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
  },

  variance(items) {
    const values = items.map(numeric);
    if (values.length < 2) return 0;
    const mean = SunraMath.mean(values);
    return values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  },

  stdev(items) {
    return Math.sqrt(SunraMath.variance(items));
  },

  isNaN: (v) => Number.isNaN(Number(v)),
  isFinite: (v) => Number.isFinite(Number(v)),
};

// ---------------------------------------------------------------------------
// Standard library: string
// ---------------------------------------------------------------------------

export const SunraString = {
  $module: "string",

  len: (s) => [...display(s)].length,
  upper: (s) => display(s).toUpperCase(),
  lower: (s) => display(s).toLowerCase(),
  trim: (s) => display(s).trim(),
  trimStart: (s) => display(s).trimStart(),
  trimEnd: (s) => display(s).trimEnd(),
  contains: (s, needle) => display(s).includes(display(needle)),
  startsWith: (s, needle) => display(s).startsWith(display(needle)),
  endsWith: (s, needle) => display(s).endsWith(display(needle)),
  indexOf: (s, needle) => display(s).indexOf(display(needle)),
  split: (s, sep) => display(s).split(display(sep)),
  join: (items, sep) => items.map(display).join(sep === undefined ? "" : display(sep)),
  chars: (s) => [...display(s)],
  reverse: (s) => [...display(s)].reverse().join(""),
  repeat: (s, n) => display(s).repeat(Math.max(0, Math.trunc(numeric(n)))),
  replace: (s, from, to) => display(s).split(display(from)).join(display(to)),

  slice(s, from, to) {
    const chars = [...display(s)];
    const a = Math.trunc(numeric(from));
    const b = to === undefined ? chars.length : Math.trunc(numeric(to));
    return chars.slice(a, b).join("");
  },

  padStart: (s, width, filler) =>
    display(s).padStart(Math.trunc(numeric(width)), filler === undefined ? " " : display(filler)),
  padEnd: (s, width, filler) =>
    display(s).padEnd(Math.trunc(numeric(width)), filler === undefined ? " " : display(filler)),

  lines: (s) => display(s).split(/\r?\n/),
  words: (s) => display(s).split(/\s+/).filter((w) => w.length > 0),
  isEmpty: (s) => display(s).length === 0,

  capitalize(s) {
    const text = display(s);
    return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
  },

  toInt(s) {
    const parsed = Number.parseInt(display(s), 10);
    if (Number.isNaN(parsed)) fail("string.toInt cannot parse " + JSON.stringify(display(s)));
    return parsed;
  },

  toFloat(s) {
    const parsed = Number.parseFloat(display(s));
    if (Number.isNaN(parsed)) fail("string.toFloat cannot parse " + JSON.stringify(display(s)));
    return parsed;
  },

  format(template, values) {
    // Positional formatting: "{0} beats {1}" with a list of values.
    return display(template).replace(/\{(\d+)\}/g, (_, i) => display(values[Number(i)]));
  },
};

// ---------------------------------------------------------------------------
// Standard library: array
// ---------------------------------------------------------------------------

function requireList(items, fn) {
  if (!Array.isArray(items)) fail("array." + fn + " expects a list but found " + typeName(items));
  return items;
}

export const SunraArray = {
  $module: "array",

  len: (items) => requireList(items, "len").length,
  isEmpty: (items) => requireList(items, "isEmpty").length === 0,
  first: (items) => requireList(items, "first")[0],
  last: (items) => {
    const list = requireList(items, "last");
    return list[list.length - 1];
  },

  map: (items, f) => requireList(items, "map").map((x) => f(x)),
  filter: (items, f) => requireList(items, "filter").filter((x) => truthy(f(x))),
  reduce: (items, f, initial) => requireList(items, "reduce").reduce((a, x) => f(a, x), initial),
  forEach: (items, f) => {
    requireList(items, "forEach").forEach((x) => f(x));
    return null;
  },

  find: (items, f) => requireList(items, "find").find((x) => truthy(f(x))),
  any: (items, f) => requireList(items, "any").some((x) => truthy(f(x))),
  all: (items, f) => requireList(items, "all").every((x) => truthy(f(x))),
  count: (items, value) => requireList(items, "count").filter((x) => eq(x, value)).length,
  contains: (items, value) => requireList(items, "contains").some((x) => eq(x, value)),
  indexOf: (items, value) => requireList(items, "indexOf").findIndex((x) => eq(x, value)),

  push: (items, value) => {
    requireList(items, "push").push(value);
    return items;
  },
  pop: (items) => requireList(items, "pop").pop(),
  concat: (a, b) => requireList(a, "concat").concat(requireList(b, "concat")),
  reverse: (items) => [...requireList(items, "reverse")].reverse(),
  slice: (items, from, to) =>
    requireList(items, "slice").slice(
      Math.trunc(numeric(from)),
      to === undefined ? undefined : Math.trunc(numeric(to)),
    ),
  take: (items, n) => requireList(items, "take").slice(0, Math.trunc(numeric(n))),
  drop: (items, n) => requireList(items, "drop").slice(Math.trunc(numeric(n))),

  sum: (items) => requireList(items, "sum").reduce((a, x) => a + numeric(x), 0),
  min: (items) => Math.min(...requireList(items, "min").map(numeric)),
  max: (items) => Math.max(...requireList(items, "max").map(numeric)),

  sort: (items) => [...requireList(items, "sort")].sort((a, b) => numeric(a) - numeric(b)),
  sortBy: (items, key) =>
    [...requireList(items, "sortBy")].sort((a, b) => numeric(key(a)) - numeric(key(b))),

  unique(items) {
    const out = [];
    for (const item of requireList(items, "unique")) {
      if (!out.some((x) => eq(x, item))) out.push(item);
    }
    return out;
  },

  flatten(items) {
    const out = [];
    for (const item of requireList(items, "flatten")) {
      if (Array.isArray(item)) out.push(...item);
      else out.push(item);
    }
    return out;
  },

  chunk(items, size) {
    const n = Math.max(1, Math.trunc(numeric(size)));
    const list = requireList(items, "chunk");
    const out = [];
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
  },

  zip(a, b) {
    const left = requireList(a, "zip");
    const right = requireList(b, "zip");
    const out = [];
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      out.push(rec("Pair", { left: left[i], right: right[i] }));
    }
    return out;
  },

  groupBy(items, key) {
    const groups = new Map();
    for (const item of requireList(items, "groupBy")) {
      const k = display(key(item));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(item);
    }
    return rec("Groups", Object.fromEntries(groups));
  },

  repeat(value, count) {
    const out = [];
    for (let i = 0; i < Math.trunc(numeric(count)); i++) out.push(value);
    return out;
  },

  range: (from, to, step) => range(from, to, step),
};

// ---------------------------------------------------------------------------
// Standard library: json
// ---------------------------------------------------------------------------

function toPlain(value) {
  if (value instanceof SunraMoney) return value.toString();
  if (value instanceof SunraRecord) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === "$type") continue;
      out[key] = toPlain(value[key]);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (value === undefined) return null;
  if (typeof value === "function") return "<fn>";
  if (value && typeof value === "object" && value.$module) return "<module " + value.$module + ">";
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "function") continue;
      out[k] = toPlain(v);
    }
    return out;
  }
  return value;
}

function fromPlain(value) {
  if (Array.isArray(value)) return value.map(fromPlain);
  if (value === null) return null;
  if (typeof value === "object") {
    const entries = Object.entries(value).map(([k, v]) => [k, fromPlain(v)]);
    return new SunraRecord("Json", entries);
  }
  return value;
}

export const Json = {
  $module: "json",

  encode(value, indent) {
    const spaces = indent === undefined ? 0 : Math.trunc(numeric(indent));
    return JSON.stringify(toPlain(value), null, spaces);
  },

  decode(text) {
    try {
      return fromPlain(JSON.parse(display(text)));
    } catch (error) {
      fail("json.decode failed: " + (error instanceof Error ? error.message : String(error)));
    }
  },

  isValid(text) {
    try {
      JSON.parse(display(text));
      return true;
    } catch {
      return false;
    }
  },

  pretty(value) {
    return JSON.stringify(toPlain(value), null, 2);
  },
};

// ---------------------------------------------------------------------------
// Standard library: crypto
// ---------------------------------------------------------------------------

export const Crypto = {
  $module: "crypto",

  sha256: (input) => sha256Hex(display(input)),

  hmacSha256: (key, message) => toHex(hmacSha256Bytes(display(key), display(message))),

  randomHex: (bytes) => randomHex(bytes === undefined ? 32 : Math.trunc(numeric(bytes))),

  randomSeed: () => randomHex(32),

  uuid() {
    const hex = randomHex(16).split("");
    // Set the RFC 4122 version and variant nibbles.
    hex[12] = "4";
    hex[16] = "89ab"[Math.floor(Math.random() * 4)];
    const s = hex.join("");
    return (
      s.slice(0, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16) + "-" +
      s.slice(16, 20) + "-" + s.slice(20, 32)
    );
  },

  toHex(input) {
    return toHex(utf8Bytes(display(input)));
  },

  base64Encode(input) {
    const bytes = utf8Bytes(display(input));
    if (typeof btoa === "function") {
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary);
    }
    return Buffer.from(bytes).toString("base64");
  },

  base64Decode(input) {
    if (typeof atob === "function") {
      const binary = atob(display(input));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return Buffer.from(display(input), "base64").toString("utf8");
  },

  // Constant-time comparison: fairness verification must not leak timing
  // information about how much of a commitment matched.
  constantTimeEquals(a, b) {
    const x = display(a);
    const y = display(b);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
  },

  hashChain(previousHash, payload) {
    return sha256Hex(display(previousHash) + "|" + display(payload));
  },
};

// ---------------------------------------------------------------------------
// Standard library: timer
// ---------------------------------------------------------------------------

export const Timer = {
  $module: "timer",

  now: () => Date.now(),
  monotonic: () =>
    typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(),

  iso: (millis) => new Date(millis === undefined ? Date.now() : numeric(millis)).toISOString(),

  sleep(millis) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, numeric(millis))));
  },

  measure(label, fn) {
    const started = Timer.monotonic();
    const value = fn();
    const elapsed = Timer.monotonic() - started;
    return rec("Measurement", { label: display(label), millis: elapsed, value: value });
  },

  every(millis, fn) {
    const handle = setInterval(() => fn(), Math.max(1, numeric(millis)));
    return rec("Interval", { cancel: () => clearInterval(handle) });
  },

  after(millis, fn) {
    const handle = setTimeout(() => fn(), Math.max(0, numeric(millis)));
    return rec("Timeout", { cancel: () => clearTimeout(handle) });
  },
};

// ---------------------------------------------------------------------------
// Standard library: http
// ---------------------------------------------------------------------------

async function httpRequest(method, url, body, headers) {
  if (typeof fetch !== "function") {
    fail("http requires a fetch implementation", "run on Node.js 18+ or in a browser");
  }
  const init = { method: method, headers: {} };
  if (headers instanceof SunraRecord || (headers && typeof headers === "object")) {
    for (const [k, v] of Object.entries(toPlain(headers))) init.headers[k] = String(v);
  }
  if (body !== undefined && body !== null) {
    if (typeof body === "string") {
      init.body = body;
    } else {
      init.body = JSON.stringify(toPlain(body));
      init.headers["content-type"] = init.headers["content-type"] ?? "application/json";
    }
  }

  const response = await fetch(display(url), init);
  const text = await response.text();
  return rec("Response", {
    status: response.status,
    ok: response.ok,
    body: text,
    url: display(url),
  });
}

export const Http = {
  $module: "http",

  get: (url, headers) => httpRequest("GET", url, null, headers),
  post: (url, body, headers) => httpRequest("POST", url, body, headers),
  put: (url, body, headers) => httpRequest("PUT", url, body, headers),
  patch: (url, body, headers) => httpRequest("PATCH", url, body, headers),
  delete: (url, headers) => httpRequest("DELETE", url, null, headers),
  request: (method, url, body, headers) => httpRequest(display(method), url, body, headers),

  async json(url, headers) {
    const response = await httpRequest("GET", url, null, headers);
    return Json.decode(response.body);
  },

  encodeQuery(params) {
    const plain = toPlain(params);
    return Object.entries(plain)
      .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v)))
      .join("&");
  },
};

// ---------------------------------------------------------------------------
// Standard library: file
// ---------------------------------------------------------------------------

let nodeFs = null;
if (IS_NODE) {
  try {
    nodeFs = await import("node:fs");
  } catch {
    nodeFs = null;
  }
}

function requireFs(operation) {
  if (!nodeFs) {
    fail(
      "file." + operation + " is unavailable in this environment",
      "file access requires the Node.js host; the browser playground runs sandboxed",
    );
  }
  return nodeFs;
}

export const File = {
  $module: "file",

  read: (path) => requireFs("read").readFileSync(display(path), "utf8"),

  write(path, contents) {
    requireFs("write").writeFileSync(display(path), display(contents), "utf8");
    return true;
  },

  append(path, contents) {
    requireFs("append").appendFileSync(display(path), display(contents), "utf8");
    return true;
  },

  exists: (path) => (nodeFs ? nodeFs.existsSync(display(path)) : false),

  remove(path) {
    requireFs("remove").rmSync(display(path), { force: true });
    return true;
  },

  lines: (path) => requireFs("lines").readFileSync(display(path), "utf8").split(/\r?\n/),

  readJson: (path) => Json.decode(requireFs("readJson").readFileSync(display(path), "utf8")),

  writeJson(path, value, indent) {
    const spaces = indent === undefined ? 2 : Math.trunc(numeric(indent));
    requireFs("writeJson").writeFileSync(
      display(path),
      JSON.stringify(toPlain(value), null, spaces) + "\n",
      "utf8",
    );
    return true;
  },

  list: (path) => requireFs("list").readdirSync(display(path)),

  makeDir(path) {
    requireFs("makeDir").mkdirSync(display(path), { recursive: true });
    return true;
  },

  size: (path) => requireFs("size").statSync(display(path)).size,
};

// ---------------------------------------------------------------------------
// Test harness for generated artifacts
// ---------------------------------------------------------------------------

export function isTestRun() {
  return IS_NODE && process.argv.includes("--test");
}

export function runTests(tests) {
  let passed = 0;
  let failed = 0;

  $stdout("Sunra 0.2.0 — running " + tests.length + " test(s)");
  for (const test of tests) {
    try {
      test.run();
      passed += 1;
      $stdout("  ok    " + test.name);
    } catch (error) {
      failed += 1;
      $stdout("  FAIL  " + test.name);
      $stdout("        " + (error instanceof Error ? error.message : String(error)));
    }
  }

  $stdout("");
  $stdout("  " + passed + " passed, " + failed + " failed");
  if (failed > 0 && IS_NODE) process.exitCode = 1;
  return rec("TestSummary", { passed: passed, failed: failed, total: tests.length });
}

// ---------------------------------------------------------------------------
// The $rt facade referenced by generated code
// ---------------------------------------------------------------------------

export const $rt = {
  truthy: truthy,
  eq: eq,
  cmp: cmp,
  neg: neg,
  arith: arith,
  intDiv: intDiv,
  index: index,
  setIndex: setIndex,
  member: member,
  setMember: setMember,
  call: call,
  invoke: invoke,
  iterate: iterate,
  range: rangeOf,
  display: display,
  format: format,
  matchFailed: matchFailed,
  reel: reel,
  isTestRun: isTestRun,
  runTests: runTests,

  // Host controls, used by the CLI, the playground and embedding applications.
  setSeed: $setSeed,
  setRng: $setRng,
  setStdout: $setStdout,
  rngKind: $rngKind,

  Money: SunraMoney,
  Record: SunraRecord,
  Error: SunraRuntimeError,
  version: "0.2.0",
};

export default $rt;
`;

/** The complete runtime, assembled in dependency order. */
export const FULL_RUNTIME =
  RUNTIME_SOURCE + RUNTIME_SOURCE_PART2 + RUNTIME_SOURCE_PART3 + RUNTIME_SOURCE_PART4;
