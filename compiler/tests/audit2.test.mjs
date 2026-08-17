/**
 * Audit round 2 — the five defects, each pinned by a test that fails without the
 * fix.
 *
 * Every case drives the real CLI or the real backend, never a mock: the point of
 * the audit was that stages parsed without enforcing, so a test that inspects an
 * intermediate object could pass while the tool a studio runs still misbehaves.
 *
 * The LLVM cases assemble the emitted IR with `llvm-as` when it is installed. If
 * it is not, they fall back to the structural invariant that broke (every `%v`
 * operand is defined) rather than silently passing.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "bin", "sunra.js");
const DIST = join(ROOT, "dist");
const WORK = join(ROOT, ".audit2-work");

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message.split("\n").join("\n      ")}`);
  }
}

function sunra(argv) {
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    cwd: WORK,
    encoding: "utf8",
    timeout: 600_000,
  });
  return { out: result.stdout ?? "", err: result.stderr ?? "", status: result.status ?? 0 };
}

const both = (r) => `${r.out}${r.err}`;

function program(name, text) {
  const path = join(WORK, name);
  writeFileSync(path, text);
  return path;
}

/** `llvm-as` under any of the names Ubuntu installs it as, or null. */
function findLlvmAs() {
  for (const candidate of ["llvm-as", "llvm-as-18", "llvm-as-17", "llvm-as-16"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/** Every `%vN` an instruction reads must be defined somewhere in that function. */
function assertOperandsDefined(ir) {
  for (const body of ir.split(/^define /m).slice(1)) {
    const defined = new Set([...body.matchAll(/%v(\d+) =/g)].map((m) => m[1]));
    for (const m of body.matchAll(/\((?<params>[^)]*)\)/g)) {
      for (const p of m.groups.params.matchAll(/%v(\d+)/g)) defined.add(p[1]);
      break; // the signature is the first parenthesised group
    }
    const header = body.slice(0, body.indexOf("{"));
    for (const p of header.matchAll(/%v(\d+)/g)) defined.add(p[1]);
    for (const use of body.matchAll(/%v(\d+)/g)) {
      assert.ok(
        defined.has(use[1]),
        `%v${use[1]} is used but never defined in:\n${body.slice(0, 400)}`,
      );
    }
  }
}

// --------------------------------------------------------------- 1. jurisdiction

const JURISDICTION_GAME = (name) => `game Table {
    rtp = 96.0
    jurisdiction = ["${name}"]

    fn spin(bet: Int) -> Int {
        bet
    }
}

fn main() uses io {
    print(Table.spin(1))
}
`;

await test("jurisdiction: an invented regulator in a game *field* is warned about", async () => {
  const path = program("jur_field_bad.sun", JURISDICTION_GAME("NARNIA"));
  const result = sunra(["check", path]);
  assert.match(both(result), /W0702/, both(result));
  assert.match(both(result), /NARNIA/);
});

await test("jurisdiction: a real regulator in a game field is silent", async () => {
  const path = program("jur_field_ok.sun", JURISDICTION_GAME("MGA"));
  const result = sunra(["check", path]);
  assert.doesNotMatch(both(result), /W0702/, both(result));
  assert.equal(result.status, 0, both(result));
});

await test("jurisdiction: the declared regulator selects the rule packs", async () => {
  // The defect: compliance evaluated the same default packs regardless of what
  // the program declared, so MGA and UKGC produced identical output.
  const mga = sunra(["pipeline", program("jur_mga.sun", JURISDICTION_GAME("MGA"))]);
  const ukgc = sunra(["pipeline", program("jur_ukgc.sun", JURISDICTION_GAME("UKGC"))]);
  const line = (r) => (r.out.match(/^Compliance:.*$/m) ?? [""])[0];
  assert.ok(line(mga).length > 0, mga.out);
  assert.notEqual(line(mga), line(ukgc), `both jurisdictions evaluated the same packs: ${line(mga)}`);
});

// ---------------------------------------------------------------------- 2. LLVM

const LLVM_PROGRAM = `fn addup(a: Int, b: Int) -> Int {
    a + b + 4
}

fn ratio(a: Float, b: Float) -> Float {
    if b > 0.0 {
        a / b
    } else {
        0.0
    }
}

fn label(n: Int) -> Str {
    if n > 1 {
        "many"
    } else {
        "one"
    }
}

fn main() uses io {
    print(addup(3, 4))
    print(ratio(3.0, 4.0))
    print(label(5))
}
`;

async function emitIr(source, file) {
  const { runPipeline } = await import(join(DIST, "pipeline", "pipeline.js"));
  const { emitLlvm } = await import(join(DIST, "backend", "llvm.js"));
  const { emitCranelift } = await import(join(DIST, "backend", "cranelift.js"));
  const result = runPipeline(source, file);
  return { llvm: emitLlvm(result.optimized), clif: emitCranelift(result.optimized), pipeline: result };
}

await test("llvm: the emitted IR assembles", async () => {
  const { llvm } = await emitIr(LLVM_PROGRAM, "llvm.sun");
  const irPath = join(WORK, "out.ll");
  writeFileSync(irPath, llvm.ir);

  const llvmAs = findLlvmAs();
  if (llvmAs) {
    const assembled = spawnSync(llvmAs, [irPath, "-o", join(WORK, "out.bc")], { encoding: "utf8" });
    assert.equal(assembled.status, 0, `${llvmAs} rejected the IR:\n${assembled.stderr}`);
  } else {
    assertOperandsDefined(llvm.ir);
  }
});

await test("llvm: a function without parameters defines every value it reads", async () => {
  // The defect: MIR ids are sparse after DCE, so `main` began at `%2` while `%0`
  // and `%1` were never defined — invalid for LLVM's *numbered* temporaries.
  const { llvm } = await emitIr(LLVM_PROGRAM, "llvm.sun");
  const main = llvm.ir.slice(llvm.ir.indexOf("define i64 @main()"));
  assert.ok(main.length > 0, llvm.ir);
  assertOperandsDefined(`define ${main.split("define ")[1]}`);
});

await test("llvm: a returning `if` returns the branch value, not unit", async () => {
  const { llvm } = await emitIr(LLVM_PROGRAM, "llvm.sun");
  const ratio = llvm.ir.slice(llvm.ir.indexOf("define double @ratio"));
  const body = ratio.slice(0, ratio.indexOf("\n}"));
  assert.match(body, /phi double/, body);
  assert.doesNotMatch(body, /ret double %v\d+\s*$/m.test(body) ? /$^/ : /ret double/, body);
});

// ----------------------------------------------------------------- 3. Cranelift

await test("cranelift: value types match the MIR types", async () => {
  const { clif } = await emitIr(LLVM_PROGRAM, "clif.sun");
  const ratio = clif.clif.slice(clif.clif.indexOf("function %ratio"));
  const body = ratio.slice(0, ratio.indexOf("\n}"));
  // Float parameters and results must be f64, and the merge must carry f64 too.
  assert.match(body, /function %ratio\(v0: f64, v1: f64\) -> f64/, body);
  assert.match(body, /block\d+\(v\d+: f64\)/, body);
  assert.doesNotMatch(body, /iconst\.i64/, `an integer constant leaked into a float function:\n${body}`);
});

await test("cranelift: a string-returning function uses a reference type", async () => {
  const { clif } = await emitIr(LLVM_PROGRAM, "clif.sun");
  const label = clif.clif.slice(clif.clif.indexOf("function %label"));
  const body = label.slice(0, label.indexOf("\n}"));
  assert.match(body, /-> r64/, body);
  assert.match(body, /block\d+\(v\d+: r64\)/, body);
});

// --------------------------------------------------------------------- 4. SunVM

await test("sunvm: a function returns its real value", async () => {
  const path = program("vm_value.sun", LLVM_PROGRAM);
  assert.equal(sunra(["build", path, "--target", "vm", "--out", "vm_value.sunbc"]).status, 0);
  const result = sunra(["vm", "run", join(WORK, "vm_value.sunbc"), "--entry", "addup", "--arg", "3", "--arg", "4"]);
  assert.equal(result.out.trim(), "11", both(result));
});

await test("sunvm: results agree with the interpreter", async () => {
  const path = program("vm_agree.sun", LLVM_PROGRAM);
  const interpreted = sunra(["run", path]);
  assert.equal(sunra(["build", path, "--target", "vm", "--out", "vm_agree.sunbc"]).status, 0);
  const vm = sunra(["vm", "run", join(WORK, "vm_agree.sunbc")]);
  assert.equal(vm.out.trim(), interpreted.out.trim(), `${vm.out}\n---\n${interpreted.out}`);
});

await test("sunvm: calling an entry with the wrong arity is refused", async () => {
  // Previously this ran against uninitialised registers and printed a wrong
  // answer that looked plausible.
  const path = program("vm_arity.sun", LLVM_PROGRAM);
  assert.equal(sunra(["build", path, "--target", "vm", "--out", "vm_arity.sunbc"]).status, 0);
  const result = sunra(["vm", "run", join(WORK, "vm_arity.sunbc"), "--entry", "ratio"]);
  assert.equal(result.status, 1, both(result));
  assert.match(both(result), /takes 2 arguments but 0 were supplied/);
});

// ------------------------------------------------------------------ 5. exit code

await test("rtp: a game that misses its declared RTP exits 1", async () => {
  const path = program("rtp_fail.sun", `game LowPay {
    rtp = 96.5
    bet = 10

    fn spin(bet: Int) -> Int {
        5
    }
}

fn main() uses io {
    print(LowPay.spin(10))
}
`);
  const result = sunra(["rtp", path, "--rounds", "5000", "--seed", "audit"]);
  assert.match(result.out, /Verdict\s+FAIL/, both(result));
  assert.equal(result.status, 1, both(result));
});

await test("rtp: `spin(bet)` is simulated instead of crashing", async () => {
  // The harness called `spin` with no arguments, so a game whose spin takes the
  // stake died with an unhandled arity error and a stack trace.
  const path = program("rtp_arity.sun", `game Paying {
    rtp = 100.0
    bet = 10

    fn spin(bet: Int) -> Int {
        bet
    }
}

fn main() uses io {
    print(Paying.spin(10))
}
`);
  const result = sunra(["rtp", path, "--rounds", "2000", "--seed", "audit"]);
  assert.doesNotMatch(both(result), /SunraError|at verifyRtp/, both(result));
  assert.match(result.out, /Verdict\s+PASS/, both(result));
  assert.equal(result.status, 0, both(result));
});

await test("rtp: a game that cannot be simulated reports a diagnostic, not a crash", async () => {
  const path = program("rtp_broken.sun", `game Broken {
    rtp = 96.0

    fn spin(bet: Int) -> Int {
        let xs = [1, 2, 3]
        xs[bet]
    }
}

fn main() uses io {
    print(Broken.spin(1))
}
`);
  const result = sunra(["rtp", path, "--rounds", "10", "--seed", "audit"]);
  // Either it simulates cleanly or it reports; what it must not do is emit a
  // JavaScript stack trace.
  assert.doesNotMatch(both(result), /at verifyRtp|node:internal/, both(result));
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
