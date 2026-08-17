#!/usr/bin/env node
/**
 * Int64 overflow analysis and WASM fixed-point coverage.
 *
 * Two properties matter for a warning to be worth having:
 *   1. it fires on the patterns that actually overflow (a compounding loop, an
 *      out-of-range constant, an unbounded exponent);
 *   2. it stays silent on the shipped examples, because a warning that cries wolf
 *      is one a studio filters out.
 *
 * The fixed-point checks belong here too: they are the other half of "no backend
 * silently drops a function".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { runPipeline } = await import(join(ROOT, "dist", "pipeline", "pipeline.js"));

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

const analyse = (source, options = {}) => runPipeline(source, "overflow.sun", { native: false, ...options });

// --- true positives ---------------------------------------------------------

test("a compounding multiplication in a loop warns", () => {
  const result = analyse(`
fn ladder(stake: Int, steps: Int) -> Int {
    var total = stake
    var i = 0
    while i < steps {
        total = total * 2
        i = i + 1
    }
    return total
}

fn main() uses io {
    print(ladder(1, 70))
}
`);
  const kinds = result.overflow.warnings.map((w) => w.kind);
  assert.ok(kinds.includes("multiplication-in-loop"), JSON.stringify(result.overflow.warnings));
  const warning = result.overflow.warnings.find((w) => w.kind === "multiplication-in-loop");
  assert.equal(warning.symbol, "ladder");
  assert.ok(warning.hint, "a warning without a hint is not actionable");
});

test("an out-of-range constant warns", () => {
  const result = analyse(`
fn bigProduct() -> Int {
    let a = 4000000000
    let b = 4000000000
    return a * b
}

fn main() uses io {
    print(bigProduct())
}
`);
  const constant = result.overflow.warnings.find((w) => w.kind === "constant-overflow");
  assert.ok(constant, JSON.stringify(result.overflow.warnings));
  assert.match(constant.detail, /outside the Int64 range/);
});

// --- true negatives ---------------------------------------------------------

test("ordinary integer arithmetic does not warn", () => {
  const result = analyse(`
fn payout(symbols: Int, bet: Int) -> Int {
    return symbols * bet + 10
}

fn main() uses io {
    print(payout(3, 5))
}
`);
  assert.deepEqual(result.overflow.warnings, []);
});

test("float compounding does not warn", () => {
  // The shape of a progressive jackpot contribution: a loop that multiplies, but
  // in floating point, where overflow saturates rather than wrapping.
  const result = analyse(`
fn compound(base, rate, periods) -> Float {
    var value = base
    var i = 0
    while i < periods {
        value = value + value * rate
        i += 1
    }
    value
}

fn main() uses io {
    print(compound(100.0, 0.05, 10))
}
`);
  assert.deepEqual(result.overflow.warnings, []);
});

test("the shipped examples produce no overflow warnings", () => {
  const files = [
    "examples/slot_machine.sun",
    "examples/baccarat.sun",
    "examples/provably_fair.sun",
    "examples/blockchain.sun",
    "examples/gaming_primitives.sun",
    "examples/wasm_math.sun",
    "tests/fixtures/method_gauntlet.sun",
    "tests/fixtures/solar_fortune_18.sun",
  ];
  for (const file of files) {
    const path = join(ROOT, file);
    const result = runPipeline(readFileSync(path, "utf8"), path, { native: false });
    assert.deepEqual(
      result.overflow.warnings.map((w) => `${w.symbol}: ${w.detail}`),
      [],
      `${file} warned unexpectedly`,
    );
  }
});

// --- WASM fixed-point coverage ---------------------------------------------

test("fixed-point mode compiles the float functions a contract otherwise refuses", () => {
  const path = join(ROOT, "examples", "slot_machine.sun");
  const source = readFileSync(path, "utf8");
  const plain = runPipeline(source, path, { contract: true });
  const fixed = runPipeline(source, path, { contract: true, contractFixedPointFloats: true });

  assert.ok(plain.backends.contract.rejected.length > 0, "expected float rejections without fixed point");
  assert.equal(
    fixed.backends.contract.rejected.length,
    0,
    JSON.stringify(fixed.backends.contract.rejected),
  );
  assert.equal(fixed.backends.contract.manifest.fixedPoint.enabled, true);
  assert.equal(fixed.backends.contract.manifest.fixedPoint.scale, 1_000_000);
});

test("a fixed-point module still validates as WebAssembly", () => {
  const path = join(ROOT, "examples", "slot_machine.sun");
  const fixed = runPipeline(readFileSync(path, "utf8"), path, {
    contract: true,
    contractFixedPointFloats: true,
  });
  const bytes = fixed.backends.contract.wasm;
  assert.ok(WebAssembly.validate(bytes), "fixed-point contract module failed WebAssembly.validate");
});

test("a contract refuses floats by default, which is the deterministic answer", () => {
  const path = join(ROOT, "examples", "wasm_math.sun");
  const plain = runPipeline(readFileSync(path, "utf8"), path, { contract: true });
  const reasons = plain.backends.contract.rejected.map((r) => r.reason);
  assert.ok(reasons.length > 0);
  for (const reason of reasons) assert.match(reason, /floating point|fixedPointFloats/);
});

console.log(failures === 0 ? "\noverflow + fixed point: all checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
