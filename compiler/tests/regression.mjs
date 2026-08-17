#!/usr/bin/env node
/**
 * Sunra prototype regression suite.
 *
 * This suite deliberately tests the public CLI boundary rather than reaching
 * into implementation details. It verifies that source files are lexed,
 * parsed, type-checked and interpreted as a user would experience them.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/sunra.js");
const EXAMPLES = resolve(ROOT, "examples");

let passed = 0;
let failed = 0;

function invoke(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    timeout: options.timeout ?? 240_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(error instanceof Error ? error.stack : String(error));
  }
}

function expectSuccess(result, message) {
  assert.equal(result.status, 0, `${message}\n${result.output}`);
}

function expectFailure(result, message) {
  assert.notEqual(result.status, 0, `${message}\n${result.output}`);
}

function plain(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function expectIncludes(result, text, message = `expected output to include ${JSON.stringify(text)}`) {
  assert.ok(plain(result.output).includes(text), `${message}\n${plain(result.output)}`);
}

const validExamples = [
  "hello.sun",
  "slot_machine.sun",
  "baccarat.sun",
  "provably_fair.sun",
  "gaming_primitives.sun",
  "blockchain.sun",
];

// ---------------------------------------------------------------------------
// Frontend and CLI contracts
// ---------------------------------------------------------------------------

test("CLI reports a stable version", () => {
  const result = invoke(["version"]);
  expectSuccess(result, "version command failed");
  expectIncludes(result, "sunra 0.2.0");
});

test("CLI help documents the public commands", () => {
  const result = invoke(["help"]);
  expectSuccess(result, "help command failed");
  for (const command of [
    "run",
    "check",
    "tokens",
    "ast",
    "effects",
    "rtp",
    "test",
    "examples",
    "build",
    "pkg",
  ]) {
    expectIncludes(result, command, `help omitted ${command}`);
  }
});

test("all valid examples type-check", () => {
  for (const file of validExamples) {
    const result = invoke(["check", `examples/${file}`]);
    expectSuccess(result, `check failed for ${file}`);
    expectIncludes(result, "type-checks", `check did not report success for ${file}`);
  }
});

test("lexer emits tokens for hello.sun", () => {
  const result = invoke(["tokens", "examples/hello.sun", "--json"]);
  expectSuccess(result, "tokens command failed");
  const tokens = JSON.parse(result.stdout);
  assert.ok(Array.isArray(tokens));
  assert.ok(tokens.length > 20, `expected a useful token stream, got ${tokens.length}`);
  assert.equal(tokens[0].value, "fn");
  assert.equal(tokens[1].value, "main");
  assert.ok(tokens.some((token) => token.kind === "Eof"));
});

test("parser emits an AST for the slot game", () => {
  const result = invoke(["ast", "examples/slot_machine.sun"]);
  expectSuccess(result, "ast command failed");
  const ast = JSON.parse(result.stdout);
  assert.equal(ast.kind, "Program");
  assert.ok(ast.body.some((node) => node.kind === "GameDecl" && node.name === "SlotMachine"));
  assert.ok(ast.body.some((node) => node.kind === "FnDecl" && node.name === "main"));
});

test("effect inventory distinguishes pure and random functions", () => {
  const result = invoke(["effects", "examples/slot_machine.sun"]);
  expectSuccess(result, "effects command failed");
  expectIncludes(result, "SlotMachine.payout");
  expectIncludes(result, "pure");
  expectIncludes(result, "SlotMachine.spin");
  expectIncludes(result, "rand");
});

// ---------------------------------------------------------------------------
// Type safety and diagnostics
// ---------------------------------------------------------------------------

test("errors_demo produces repairable diagnostics", () => {
  const result = invoke(["check", "examples/errors_demo.sun"]);
  expectFailure(result, "errors_demo unexpectedly type-checked");
  for (const code of ["E0615", "E0731", "E0384", "E0425", "E0308", "E0061"]) {
    expectIncludes(result, `error[${code}]`, `${code} was not emitted`);
  }
  expectIncludes(result, "help:", "diagnostic did not include a repair hint");
  expectIncludes(result, "docs:", "diagnostic did not include a documentation URL");
});

test("JSON diagnostics are machine-readable", () => {
  const result = invoke(["check", "examples/errors_demo.sun", "--json"]);
  expectFailure(result, "JSON check unexpectedly succeeded");
  const json = JSON.parse(result.stdout);
  assert.ok(Array.isArray(json.errors));
  assert.ok(json.errors.some((error) => error.code === "E0615"));
  assert.ok(json.errors.every((error) => typeof error.message === "string"));
  assert.ok(json.errors.every((error) => error.docs.includes("sunra.dev/errors/")));
});

// ---------------------------------------------------------------------------
// Interpreter examples
// ---------------------------------------------------------------------------

test("hello world executes", () => {
  const result = invoke(["run", "examples/hello.sun"]);
  expectSuccess(result, "hello example failed");
  expectIncludes(result, "Hello, Sunra!");
  expectIncludes(result, "compiled, provably fair language");
});

test("slot machine executes deterministically from a seed", () => {
  const first = invoke(["run", "examples/slot_machine.sun", "--seed", "42"]);
  const second = invoke(["run", "examples/slot_machine.sun", "--seed", "42"]);
  expectSuccess(first, "slot example failed");
  expectSuccess(second, "second slot run failed");
  assert.equal(first.stdout, second.stdout, "same simulation seed produced different output");
  expectIncludes(first, "verdict      PASS");
});

test("baccarat executes and its pure rule tests pass", () => {
  const run = invoke(["run", "examples/baccarat.sun", "--seed", "7"]);
  expectSuccess(run, "baccarat example failed");
  expectIncludes(run, "Banker bet RTP");

  const tests = invoke(["test", "examples/baccarat.sun"]);
  expectSuccess(tests, "baccarat tests failed");
  expectIncludes(tests, "6 passed, 0 failed");
});

test("provably fair example verifies commit/reveal and tests", () => {
  const run = invoke(["run", "examples/provably_fair.sun"]);
  expectSuccess(run, "provably fair example failed");
  expectIncludes(run, "VERIFIED");
  expectIncludes(run, "identical to the roll");

  const tests = invoke(["test", "examples/provably_fair.sun"]);
  expectSuccess(tests, "provably fair tests failed");
  expectIncludes(tests, "5 passed, 0 failed");
});

test("gaming primitives example exercises the standard library", () => {
  const result = invoke(["run", "examples/gaming_primitives.sun", "--seed", "2026"]);
  expectSuccess(result, "gaming primitives example failed");
  for (const section of ["Reels", "Cards", "Poker", "Dice", "Money", "Provably fair", "RTP tooling"]) {
    expectIncludes(result, section, `missing gaming section ${section}`);
  }
  expectIncludes(result, "All primitives exercised.");
});

test("blockchain example detects tampering and validates the epoch", () => {
  const result = invoke(["run", "examples/blockchain.sun", "--seed", "99"]);
  expectSuccess(result, "blockchain example failed");
  expectIncludes(result, "chain verifies      true");
  expectIncludes(result, "after tampering     false");
  expectIncludes(result, "commitment holds    true");

  const tests = invoke(["test", "examples/blockchain.sun"]);
  expectSuccess(tests, "blockchain tests failed");
  expectIncludes(tests, "4 passed, 0 failed");
});

// ---------------------------------------------------------------------------
// RTP and artifact behavior
// ---------------------------------------------------------------------------

test("RTP command produces a passing report", () => {
  const report = resolve(ROOT, "rtp-report.json");
  if (existsSync(report)) rmSync(report);

  // The exact mathematical RTP of this game is 0.965008, but its volatility is
  // about 4.5 bet units with a 180x top prize, so a short run does not converge
  // inside the declared 0.005 tolerance. One million rounds does. The number of
  // rounds is a property of the game's variance, not a knob to make a test pass.
  const result = invoke([
    "rtp",
    "examples/slot_machine.sun",
    "--rounds",
    "1000000",
    "--seed",
    "42",
    "--json",
  ]);
  expectSuccess(result, "rtp command failed");
  expectIncludes(result, "Verdict");
  assert.ok(existsSync(report), "RTP JSON report was not written");
  const json = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(json.length, 1);
  assert.equal(json[0].game, "SlotMachine");
  assert.equal(json[0].verdict, "PASS");
  assert.ok(
    Math.abs(json[0].rtp - 0.965) <= 0.005,
    `measured RTP ${json[0].rtp} is outside the declared tolerance`,
  );
  rmSync(report);
});

test("the confidence interval narrows as rounds increase", () => {
  // A capped sample buffer once made the interval stop shrinking past 100k
  // rounds, which is the figure an auditor reads to judge whether a simulation
  // was long enough. Assert the statistic actually responds to sample size.
  const widths = [];
  for (const rounds of ["50000", "500000"]) {
    const result = invoke([
      "rtp",
      "examples/slot_machine.sun",
      "--rounds",
      rounds,
      "--seed",
      "42",
    ]);
    // A short run legitimately reports FAIL for this high-variance game, and
    // the command exits non-zero when it does. The statistic is what matters
    // here, so read it regardless of the verdict.
    const match = /95% CI\s+\[([\d.]+)%,\s*([\d.]+)%\]/.exec(plain(result.output));
    assert.ok(match, `could not read the confidence interval at ${rounds} rounds`);
    widths.push(Number(match[2]) - Number(match[1]));
  }
  // Ten times the rounds should roughly cut the interval by sqrt(10) ~ 3.16.
  assert.ok(
    widths[1] < widths[0] / 2,
    `interval did not narrow with more rounds: ${widths[0].toFixed(4)}% then ${widths[1].toFixed(4)}%`,
  );
});

test("examples command discovers bundled programs", () => {
  const result = invoke(["examples"]);
  expectSuccess(result, "examples command failed");
  for (const file of ["hello.sun", "slot_machine.sun", "baccarat.sun", "blockchain.sun"]) {
    expectIncludes(result, file);
  }
});

// ---------------------------------------------------------------------------
// Transpiler: the compiled artifact must agree with the interpreter
// ---------------------------------------------------------------------------

test("compiled JavaScript reproduces the interpreter exactly", () => {
  const dir = mkdtempSync(join(tmpdir(), "sunra-build-"));
  try {
    const out = join(dir, "slot.js");
    const build = invoke([
      "build",
      "examples/slot_machine.sun",
      "--out",
      out,
      "--seed",
      "42",
      "--bundle",
    ]);
    expectSuccess(build, "build command failed");
    assert.ok(existsSync(out), "no artifact was written");

    const compiled = spawnSync(process.execPath, [out], {
      encoding: "utf8",
      timeout: 240_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(compiled.status, 0, `compiled artifact failed\n${compiled.stderr}`);

    const interpreted = invoke(["run", "examples/slot_machine.sun", "--seed", "42"]);
    expectSuccess(interpreted, "interpreter run failed");

    assert.equal(
      plain(compiled.stdout),
      plain(interpreted.stdout),
      "the compiled artifact and the interpreter disagreed on the same seed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the compiler refuses to emit code that does not type-check", () => {
  const dir = mkdtempSync(join(tmpdir(), "sunra-build-bad-"));
  try {
    const out = join(dir, "bad.js");
    const build = invoke(["build", "examples/errors_demo.sun", "--out", out]);
    expectFailure(build, "build emitted an artifact for a program with type errors");
    assert.ok(!existsSync(out), "a broken program still produced an artifact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compiled tests run from the artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "sunra-build-tests-"));
  try {
    const out = join(dir, "baccarat.js");
    expectSuccess(
      invoke(["build", "examples/baccarat.sun", "--out", out, "--bundle"]),
      "build failed for baccarat",
    );
    const compiled = spawnSync(process.execPath, [out, "--test"], {
      encoding: "utf8",
      timeout: 240_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(compiled.status, 0, `compiled tests failed\n${compiled.stderr}`);
    assert.ok(
      plain(compiled.stdout).includes("6 passed"),
      `expected six passing tests, got:\n${plain(compiled.stdout)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Package manager
// ---------------------------------------------------------------------------

test("pkg manages a project lifecycle end to end", () => {
  const dir = mkdtempSync(join(tmpdir(), "sunra-pkg-"));
  try {
    expectSuccess(invoke(["pkg", "init", "demo-slot"], { cwd: dir }), "pkg init failed");
    const manifest = join(dir, "sunra.toml");
    assert.ok(existsSync(manifest), "pkg init did not write sunra.toml");
    expectIncludes({ output: readFileSync(manifest, "utf8") }, 'name = "demo-slot"');

    expectSuccess(invoke(["pkg", "add", "sunra-fair"], { cwd: dir }), "pkg add failed");
    expectIncludes({ output: readFileSync(manifest, "utf8") }, "sunra-fair");

    const list = invoke(["pkg", "list"], { cwd: dir });
    expectSuccess(list, "pkg list failed");
    expectIncludes(list, "sunra-fair");

    const install = invoke(["pkg", "install"], { cwd: dir });
    expectSuccess(install, "pkg install failed");
    assert.ok(existsSync(join(dir, "sunra.lock")), "install did not write a lockfile");

    const check = invoke(["pkg", "check"], { cwd: dir });
    expectSuccess(check, "pkg check failed");

    // Effects must be visible per dependency: a package that can move money or
    // reach the network should never be able to hide that in a manifest.
    const tree = invoke(["pkg", "tree"], { cwd: dir });
    expectSuccess(tree, "pkg tree failed");
    expectIncludes(tree, "sunra-fair");

    expectSuccess(invoke(["pkg", "remove", "sunra-fair"], { cwd: dir }), "pkg remove failed");
    assert.ok(
      !readFileSync(manifest, "utf8").includes("sunra-fair"),
      "pkg remove left the dependency in the manifest",
    );

    expectFailure(invoke(["pkg", "add", "definitely-not-a-package"], { cwd: dir }), "pkg add accepted an unknown package");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Browser build: the playground must run the real compiler
// ---------------------------------------------------------------------------

test("the browser bundle exposes the toolchain and agrees with the CLI", () => {
  const bundle = resolve(ROOT, "dist-browser/sunra.browser.js");
  assert.ok(existsSync(bundle), "browser bundle missing; run `pnpm build:browser`");

  const probe = mkdtempSync(join(tmpdir(), "sunra-browser-"));
  try {
    const script = join(probe, "probe.mjs");
    writeFileSync(
      script,
      `
import { readFileSync } from "node:fs";
const sunra = await import(${JSON.stringify(bundle)});
const source = readFileSync(${JSON.stringify(resolve(EXAMPLES, "slot_machine.sun"))}, "utf8");

const analysis = sunra.analyze(source);
if (!analysis.ok) throw new Error("analyze reported errors on a valid program");
if (!analysis.games.includes("SlotMachine")) throw new Error("game block not discovered");

const bad = readFileSync(${JSON.stringify(resolve(EXAMPLES, "errors_demo.sun"))}, "utf8");
const broken = sunra.analyze(bad);
if (broken.ok) throw new Error("analyze accepted a program with type errors");
const codes = broken.diagnostics.map((d) => d.code);
for (const code of ["E0615", "E0731", "E0384"]) {
  if (!codes.includes(code)) throw new Error("missing diagnostic " + code);
}

const run = sunra.run(source, { seed: "42" });
if (!run.ok) throw new Error("run failed: " + JSON.stringify(run.diagnostics));

const tests = sunra.test(readFileSync(${JSON.stringify(resolve(EXAMPLES, "baccarat.sun"))}, "utf8"));
if (tests.passed !== 6 || tests.failed !== 0) throw new Error("browser tests: " + tests.passed + "/" + tests.failed);

const compiled = sunra.compileToJs(source, { seed: "42" });
if (!compiled.ok || !compiled.code.includes("SlotMachine")) throw new Error("compileToJs failed");

process.stdout.write(JSON.stringify({ output: run.output, version: sunra.VERSION }));
`,
    );

    const probed = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: 240_000,
    });
    assert.equal(probed.status, 0, `browser bundle probe failed\n${probed.stderr}`);

    const payload = JSON.parse(probed.stdout);
    assert.equal(payload.version, "0.2.0");

    // The browser must produce the same program output as the CLI at one seed.
    const cli = invoke(["run", "examples/slot_machine.sun", "--seed", "42"]);
    expectSuccess(cli, "CLI run failed");
    assert.equal(
      payload.output.join("\n").trim(),
      plain(cli.stdout).trim(),
      "the browser build and the CLI disagreed on the same seed",
    );
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

test("the browser crypto shim matches node:crypto", () => {
  const result = spawnSync(process.execPath, [resolve(ROOT, "tests/browser_shim.test.mjs")], {
    encoding: "utf8",
    timeout: 240_000,
  });
  assert.equal(result.status, 0, `crypto shim differs from node:crypto\n${result.stdout}`);
  assert.ok(plain(result.stdout).includes("0 failed"), plain(result.stdout));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed !== 0) process.exit(1);
console.log("Sunra regression suite: PASS");

// Keep fixture discovery explicit: a missing example is a regression failure.
for (const file of validExamples) {
  assert.ok(existsSync(resolve(EXAMPLES, file)), `missing fixture ${basename(file)}`);
}
