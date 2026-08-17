#!/usr/bin/env node
/**
 * Enforcement tests.
 *
 * Every assertion here drives the real `sunra` CLI as a user would and checks
 * the observable contract: the message, and the exit code. A stage that runs but
 * whose verdict cannot change an exit code is not enforcement, so exit codes are
 * asserted as strictly as the text.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/sunra.js");
const WORK = mkdtempSync(join(tmpdir(), "sunra-enforce-"));

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

/**
 * Run the CLI once, capturing stdout, stderr and the exit status.
 *
 * `spawnSync` is used rather than `execFileSync` because warnings go to stderr
 * on a *successful* run, and `execFileSync` surfaces stderr only when the
 * command fails.
 */
function sunra(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: options.cwd ?? WORK,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    out: plain(String(result.stdout ?? "")),
    err: plain(String(result.stderr ?? "")),
  };
}

const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const both = (result) => `${result.out}\n${result.err}`;

function program(name, source) {
  const path = join(WORK, name);
  writeFileSync(path, source, "utf8");
  return path;
}

// ------------------------------------------------------- 1. refinement types

await test("refinement: a literal outside the `where` clause is an error", async () => {
  const path = program(
    "refine_bad.sun",
    `fn safe(x: Int where x > 0) -> Int {
    x * 2
}

fn main() uses io {
    print(safe(0 - 5))
}
`,
  );
  const result = sunra(["check", path]);
  assert.equal(result.status, 1, `expected failure, got exit ${result.status}: ${both(result)}`);
  assert.match(both(result), /E0701/);
  assert.match(both(result), /requires x > 0/);
});

await test("refinement: a value inside the `where` clause checks clean", async () => {
  const path = program(
    "refine_good.sun",
    `fn safe(x: Int where x > 0) -> Int {
    x * 2
}

fn main() uses io {
    print(safe(5))
}
`,
  );
  const result = sunra(["check", path]);
  assert.equal(result.status, 0, both(result));
  assert.doesNotMatch(both(result), /E0701/);
});

await test("refinement: the checked program computes the right answer", async () => {
  const path = program(
    "refine_run.sun",
    `fn safe(x: Int where x > 0) -> Int {
    x * 2
}

fn main() uses io {
    print(safe(21))
}
`,
  );
  const result = sunra(["run", path]);
  assert.equal(result.status, 0, both(result));
  assert.match(result.out, /42/);
});

// --------------------------------------------------------- 2 & 9. no_panic

await test("no_panic: dividing by a literal zero is an error", async () => {
  const path = program(
    "panic_div.sun",
    `#[no_panic]
fn div(a: Int) -> Int {
    a / 0
}

fn main() uses io {
    print(div(10))
}
`,
  );
  const result = sunra(["check", path]);
  assert.equal(result.status, 1, `expected failure: ${both(result)}`);
  assert.match(both(result), /E0702/);
  assert.match(both(result), /divide-by-zero/);
});

await test("no_panic: an unguarded index is an error", async () => {
  const path = program(
    "panic_index.sun",
    `#[no_panic]
fn at(xs: [Int], i: Int) -> Int {
    xs[i]
}

fn main() uses io {
    print(at([1, 2, 3], 1))
}
`,
  );
  const result = sunra(["check", path]);
  assert.equal(result.status, 1, `expected failure: ${both(result)}`);
  assert.match(both(result), /index-out-of-bounds/);
});

await test("no_panic: a guarded divisor is accepted", async () => {
  const path = program(
    "panic_guarded.sun",
    `#[no_panic]
fn ratio(a: Int, b: Int) -> Int {
    if b != 0 {
        return a / b
    }
    0
}

fn main() uses io {
    print(ratio(10, 2))
}
`,
  );
  const result = sunra(["check", path]);
  assert.equal(result.status, 0, both(result));
  assert.doesNotMatch(both(result), /E0702/);
});

await test("no_panic: risk reaches a caller through the call graph", async () => {
  const path = program(
    "panic_transitive.sun",
    `fn risky(a: Int, b: Int) -> Int {
    a / b
}

#[no_panic]
fn wrapper(a: Int) -> Int {
    risky(a, 0)
}

fn main() uses io {
    print(wrapper(4))
}
`,
  );
  const result = sunra(["check", path]);
  assert.equal(result.status, 1, `expected failure: ${both(result)}`);
  assert.match(both(result), /E0702/);
});

await test("no_panic: an unannotated function with the same body is allowed", async () => {
  const path = program(
    "panic_unannotated.sun",
    `fn div(a: Int, b: Int) -> Int {
    a / b
}

fn main() uses io {
    print(div(10, 2))
}
`,
  );
  const result = sunra(["check", path]);
  assert.equal(result.status, 0, both(result));
});

// ------------------------------------------------------ 3. jurisdictions

await test("jurisdiction: an invented regulator is warned about", async () => {
  const path = program(
    "jur_bad.sun",
    `#[jurisdiction("ATLANTIS_GAMING_BOARD")]
game Lucky {
    rtp = 96.5

    fn spin() -> Int {
        1
    }
}

fn main() uses io {
    print(Lucky.spin())
}
`,
  );
  const result = sunra(["check", path]);
  assert.match(both(result), /W0702/);
  assert.match(both(result), /ATLANTIS_GAMING_BOARD/);
  // A warning informs without blocking a build.
  assert.equal(result.status, 0, both(result));
});

await test("jurisdiction: a recognised regulator is silent", async () => {
  const path = program(
    "jur_good.sun",
    `#[jurisdiction("MGA")]
game Lucky {
    rtp = 96.5

    fn spin() -> Int {
        1
    }
}

fn main() uses io {
    print(Lucky.spin())
}
`,
  );
  const result = sunra(["check", path]);
  assert.equal(result.status, 0, both(result));
  assert.doesNotMatch(both(result), /W0702/);
});

// --------------------------------------------------------- 4. RTP exit code

const RTP_FAIL = `game Bad {
    rtp = 96.0
    tolerance = 0.001
    bet = 1.0
    reel strip = ["A", "B", "C"]

    fn spin() -> Float uses rand {
        let row = Reel.spin(strip, 3)
        if Reel.isMatch(row) {
            return 2.0
        }
        0.0
    }
}

fn main() uses io, rand {
    print(Bad.spin())
}
`;

await test("rtp: a failing verdict exits non-zero so CI can gate on it", async () => {
  const path = program("rtp_fail.sun", RTP_FAIL);
  const result = sunra(["rtp", path, "--rounds", "20000", "--seed", "gate"]);
  assert.match(result.out, /Verdict\s+FAIL/);
  assert.equal(result.status, 1, `FAIL must exit 1, got ${result.status}`);
});

await test("rtp: a generated game passes and exits zero", async () => {
  const generated = sunra(["slot", "dragon 5x3 243ways rtp 96.5", "--out", "rtp_pass.sun"]);
  assert.equal(generated.status, 0, both(generated));
  // What must hold is that the *declared* RTP lies inside the measured 95%
  // confidence interval: that is the statistical claim the generator makes.
  // Asserting a particular verdict string would instead test the tolerance
  // constant, and a 243-ways slot at 2.2x volatility needs millions of rounds
  // before the sample mean sits inside a 0.5% band.
  const result = sunra(["rtp", join(WORK, "rtp_pass.sun"), "--rounds", "2000000", "--seed", "gate"]);
  const ci = result.out.match(/95% CI\s+\[([\d.]+)%, ([\d.]+)%\]/);
  assert.ok(ci, result.out);
  const [low, high] = [Number(ci[1]), Number(ci[2])];
  assert.ok(
    low <= 96.5 && 96.5 <= high,
    `declared 96.5% is outside the measured interval [${low}, ${high}]`,
  );
  // At two million rounds the estimate is tight enough that the verdict itself
  // must come out clean, which is what a release gate would rely on.
  assert.doesNotMatch(result.out, /Verdict\s+FAIL/, result.out);
  assert.equal(result.status, 0, both(result));
});

// ------------------------------------------------------- 5. SunVM bytecode

const VM_PROGRAM = `fn compute(a: Int, b: Int) -> Int {
    (a + b) * 2
}

fn main() uses io {
    print("sunvm says")
    print(compute(3, 4))
}
`;

await test("sunvm: `build --target vm` writes a decodable .sunbc artifact", async () => {
  const path = program("vm_prog.sun", VM_PROGRAM);
  const build = sunra(["build", path, "--target", "vm"]);
  assert.equal(build.status, 0, both(build));
  assert.match(build.out, /\.sunbc/);

  const bytes = readFileSync(join(WORK, "vm_prog.sunbc"));
  // The magic string is the format's own guarantee that this is bytecode and
  // not, say, JavaScript with a different extension.
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "SUNVM");
  assert.ok(bytes.length > 32, `artifact suspiciously small: ${bytes.length} bytes`);

  const info = sunra(["vm", "info", join(WORK, "vm_prog.sunbc")]);
  assert.equal(info.status, 0, both(info));
  assert.match(info.out, /digest\s+[0-9a-f]{8}/);
  assert.match(info.out, /compute/);
});

await test("sunvm: the VM executes the bytecode and prints real values", async () => {
  const result = sunra(["vm", "run", join(WORK, "vm_prog.sunbc")]);
  assert.equal(result.status, 0, both(result));
  assert.match(result.out, /sunvm says/);
  // (3 + 4) * 2 — the value must survive lowering, optimisation and encoding.
  assert.match(result.out, /\b14\b/);
});

await test("sunvm: bytecode is reproducible byte-for-byte", async () => {
  const path = program("vm_repro.sun", VM_PROGRAM);
  sunra(["build", path, "--target", "vm", "--out", join(WORK, "a.sunbc")]);
  sunra(["build", path, "--target", "vm", "--out", join(WORK, "b.sunbc")]);
  assert.deepEqual(readFileSync(join(WORK, "a.sunbc")), readFileSync(join(WORK, "b.sunbc")));
});

await test("sunvm: a corrupted artifact is refused rather than executed", async () => {
  const bytes = Buffer.from(readFileSync(join(WORK, "vm_prog.sunbc")));
  bytes[2] = 0x00;
  writeFileSync(join(WORK, "corrupt.sunbc"), bytes);
  const result = sunra(["vm", "run", join(WORK, "corrupt.sunbc")]);
  assert.equal(result.status, 1, both(result));
});

// ---------------------------------------------------------- 6. WASM target

await test("wasm: the artifact validates and computes correctly in Node", async () => {
  const path = program(
    "wasm_prog.sun",
    `fn add(a: Int, b: Int) -> Int {
    a + b
}

fn triple(n: Int) -> Int {
    n * 3
}

fn main() uses io {
    print(add(2, 3))
}
`,
  );
  const build = sunra(["build", path, "--target", "wasm"]);
  assert.equal(build.status, 0, both(build));

  const bytes = readFileSync(join(WORK, "wasm_prog.wasm"));
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "\0asm");
  assert.equal(WebAssembly.validate(bytes), true, "WebAssembly.validate rejected the module");

  const loader = await import(`file://${join(WORK, "wasm_prog.wasm.mjs")}`);
  await loader.load();
  assert.equal(await loader.add(2, 3), 5);
  assert.equal(await loader.triple(7), 21);
});

// ----------------------------------------------------------- 7. optimizer

await test("optimizer: constant folding and DCE shrink the module", async () => {
  const path = program(
    "opt_prog.sun",
    `fn folded() -> Int {
    1 + 2
}

fn unused(a: Int) -> Int {
    a * 999
}

fn main() uses io {
    print(folded())
}
`,
  );
  const result = sunra(["opt", path, "--json"]);
  assert.equal(result.status, 0, both(result));
  const report = JSON.parse(result.out);
  assert.ok(
    report.after < report.before,
    `optimiser did nothing: ${report.before} → ${report.after}`,
  );
  const applied = Object.entries(report.counts).filter(([, n]) => n > 0).map(([name]) => name);
  assert.ok(applied.length > 0, `no passes ran: ${JSON.stringify(report.counts)}`);
});

await test("optimizer: 1 + 2 is folded to the constant 3 in MIR", async () => {
  const path = program(
    "opt_fold.sun",
    `fn folded() -> Int {
    1 + 2
}

fn main() uses io {
    print(folded())
}
`,
  );
  const before = sunra(["dump-mir", path]);
  const after = sunra(["dump-mir", path, "--opt"]);
  assert.match(before.out, /add /, `expected an add before optimisation: ${before.out}`);

  const folded = after.out.split("fn ").find((chunk) => chunk.startsWith("folded"));
  assert.ok(folded, after.out);
  assert.match(folded, /const 3/, `1 + 2 was not folded: ${folded}`);
  assert.doesNotMatch(folded, /add /, `the add survived folding: ${folded}`);
});

// ------------------------------------------------------------ 8. HIR / MIR

await test("dump-hir: the desugared, typed tree is shown", async () => {
  const path = program(
    "hir_prog.sun",
    `fn double(n: Int) -> Int {
    n * 2
}

fn main() uses io {
    print(double(4))
}
`,
  );
  const result = sunra(["dump-hir", path]);
  assert.equal(result.status, 0, both(result));
  assert.match(result.out, /fn double\(n: Int\) -> Int/);
  assert.match(result.out, /Binary op=mul/);
  assert.match(result.out, /: Int/, "types must appear on expression nodes");
});

await test("dump-mir: SSA form with numbered values and a terminator", async () => {
  const result = sunra(["dump-mir", join(WORK, "hir_prog.sun")]);
  assert.equal(result.status, 0, both(result));
  assert.match(result.out, /bb0:/);
  assert.match(result.out, /%\d+ = /, "expected SSA value definitions");
  assert.match(result.out, /return %\d+/, "expected a value-returning terminator");
});

await test("dump-sail: emits queryable JSON for AI tooling", async () => {
  const result = sunra(["dump-sail", join(WORK, "hir_prog.sun")]);
  assert.equal(result.status, 0, both(result));
  const doc = JSON.parse(result.out);
  assert.ok(doc.digest, "SAIL documents carry a digest");
  const fn = doc.functions.find((f) => f.name === "double");
  assert.ok(fn, JSON.stringify(doc.functions.map((f) => f.name)));
  assert.equal(fn.ret, "Int");
});

await test("dump: a program that does not check is refused before lowering", async () => {
  const path = program("hir_broken.sun", `fn main() uses io {\n    print(missing())\n}\n`);
  const result = sunra(["dump-mir", path]);
  assert.equal(result.status, 1, both(result));
});

// -------------------------------------------------------- 10. determinism

await test("determinism: an unseeded draw in game logic is warned about", async () => {
  const path = program(
    "det_random.sun",
    `game Loose {
    rtp = 96.0

    fn spin() -> Float uses rand {
        rng.float()
    }
}

fn main() uses io, rand {
    print(Loose.spin())
}
`,
  );
  const result = sunra(["check", path]);
  assert.match(both(result), /W0701/);
  assert.match(both(result), /replayable|unseeded/);
});

await test("determinism: host storage access in game logic is warned about", async () => {
  const path = program(
    "det_storage.sun",
    `game Stored {
    rtp = 96.0

    fn spin() -> Int uses db {
        let store = Db.open("rounds.db")
        Db.get(store, "last")
        1
    }
}

fn main() uses io, db {
    print(Stored.spin())
}
`,
  );
  const result = sunra(["check", path]);
  assert.match(both(result), /W0701/);
});

await test("determinism: pure integer game logic is silent", async () => {
  const path = program(
    "det_pure.sun",
    `game Fixed {
    rtp = 96.0

    fn spin() -> Int {
        7
    }
}

fn main() uses io {
    print(Fixed.spin())
}
`,
  );
  const result = sunra(["check", path]);
  assert.equal(result.status, 0, both(result));
  assert.doesNotMatch(both(result), /W0701/);
});

// ------------------------------------------------- end-to-end: certify

await test("certify: a generated slot earns a certificate and exits zero", async () => {
  const generated = sunra(["slot", "egypt 5x3 20 lines rtp 96.5", "--out", "cert_slot.sun"]);
  assert.equal(generated.status, 0, both(generated));
  const result = sunra([
    "certify",
    join(WORK, "cert_slot.sun"),
    "--rounds",
    "400000",
    "--seed",
    "cert",
  ]);
  // Everything the compiler can establish from source must pass: the measured
  // RTP, the commit/reveal fairness proof, panic freedom, replayability and the
  // machine-checkable regulatory rules.
  assert.match(result.out, /verdict\s+PASS/, both(result));
  assert.match(result.out, /PASS\s+FAIR-1/, both(result));
  assert.match(result.out, /PASS\s+SAFE-1/, both(result));
  assert.match(result.out, /PASS\s+DET-1/, both(result));
  assert.match(result.out, /PASS\s+REG-1/, both(result));
  assert.match(result.out, /all reproduced: true/, both(result));
  assert.match(result.out, /VERDICT\s+CERTIFIED/, both(result));
  assert.equal(result.status, 0, both(result));
});

await test("certify: a game that misses its declared RTP is refused", async () => {
  const path = program("cert_bad.sun", RTP_FAIL);
  const result = sunra(["certify", path, "--rounds", "20000", "--seed", "cert"]);
  assert.equal(result.status, 1, "a game that misses its RTP must not be certified");
  assert.doesNotMatch(result.out, /^CERTIFIED$/m);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
