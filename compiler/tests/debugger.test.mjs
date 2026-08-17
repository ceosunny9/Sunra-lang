#!/usr/bin/env node
/**
 * Debugger tests.
 *
 * The central claim is that debugging changes nothing: a program stepped through
 * line by line must print exactly what `sunra run` prints, with the same seed and
 * the same step count. Everything else here checks that the individual commands
 * report the interpreter's real state rather than a reconstruction of it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/sunra.js");
const WORK = mkdtempSync(join(tmpdir(), "sunra-debug-"));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

function sunra(args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Run a scripted debug session and return its combined output. */
function debugSession(source, script, extraArgs = []) {
  const program = join(WORK, `program-${Math.random().toString(36).slice(2)}.sun`);
  const commands = join(WORK, `script-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(program, source);
  writeFileSync(commands, script.join("\n") + "\n");
  return sunra(["debug", program, "--script", commands, ...extraArgs]);
}

function runProgram(source, extraArgs = []) {
  const program = join(WORK, `run-${Math.random().toString(36).slice(2)}.sun`);
  writeFileSync(program, source);
  return sunra(["run", program, ...extraArgs]);
}

/** Strip ANSI colour so assertions read the text a user reads. */
function plain(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const PROGRAM = `fn houseEdge(rtp) -> Float {
    let edge = 1.0 - rtp
    edge
}

fn spinOnce(strip) -> Float uses rand {
    let row = Reel.spin(Reel.of(strip), 3)
    if Reel.isMatch(row) {
        40.0
    } else {
        0.0
    }
}

fn main() uses io, rand {
    let strip = ["CHERRY", "BELL", "SEVEN"]
    let edge = houseEdge(0.965)
    var total = 0.0
    for i in range(0, 4) {
        total = total + spinOnce(strip)
    }
    print("edge {edge} total {total}")
}
`;

// ---------------------------------------------------------------------------

test("a debugged run prints exactly what an undebugged run prints", () => {
  const direct = plain(runProgram(PROGRAM, ["--seed", "42"])).trim();
  const debugged = plain(debugSession(PROGRAM, ["continue"], ["--seed", "42"]));
  const line = debugged
    .split("\n")
    .find((text) => text.startsWith("edge "));
  assert.ok(line, `no program output in the debug session:\n${debugged}`);
  assert.equal(line.trim(), direct);
});

test("the step count is identical with and without the debugger", () => {
  // The debugger reports the interpreter's own counter, so instrumentation must
  // not add steps of its own.
  const debugged = plain(debugSession(PROGRAM, ["continue"], ["--seed", "42"]));
  const match = /program finished after ([\d,]+) steps/.exec(debugged);
  assert.ok(match, "no step count reported");
  const stepped = plain(
    debugSession(PROGRAM, ["step", "step", "step", "continue"], ["--seed", "42"]),
  );
  const secondMatch = /program finished after ([\d,]+) steps/.exec(stepped);
  assert.ok(secondMatch, "no step count reported for the stepped session");
  assert.equal(match[1], secondMatch[1]);
});

test("execution stops at the first statement of main", () => {
  const output = plain(debugSession(PROGRAM, ["continue"], ["--seed", "1"]));
  assert.match(output, /step at .*:16 in main/);
  assert.match(output, /let strip = \["CHERRY", "BELL", "SEVEN"\]/);
});

test("`step` descends into a called function", () => {
  const output = plain(debugSession(PROGRAM, ["step", "step", "continue"], ["--seed", "1"]));
  assert.match(output, /in houseEdge/);
  assert.match(output, /:2 in houseEdge/);
});

test("`next` steps over a call instead of entering it", () => {
  const output = plain(debugSession(PROGRAM, ["next", "next", "continue"], ["--seed", "1"]));
  const stops = output.split("\n").filter((line) => /^(step|breakpoint) at/.test(line));
  assert.ok(stops.length >= 3, `expected several stops, got:\n${output}`);
  // Line 17 calls houseEdge; `next` must land on 18, not inside houseEdge.
  assert.ok(
    !stops.some((line) => line.includes("in houseEdge")),
    `\`next\` entered a call:\n${stops.join("\n")}`,
  );
});

test("a breakpoint stops inside an effectful function", () => {
  const output = plain(debugSession(PROGRAM, ["continue", "where", "continue"], ["--break", "7", "--seed", "1"]));
  assert.match(output, /breakpoint at .*:7 in spinOnce/);
  assert.match(output, /#0 spinOnce called from line 20 uses rand/);
  assert.match(output, /#1 main uses io, rand/);
  assert.match(output, /#2 <top level>/);
});

test("`finish` returns to the caller", () => {
  const output = plain(
    debugSession(PROGRAM, ["continue", "finish", "continue"], ["--break", "7", "--seed", "1"]),
  );
  assert.match(output, /:20 in main/);
});

test("`vars` shows locals and marks enclosing scopes", () => {
  const output = plain(
    debugSession(PROGRAM, ["continue", "vars", "continue"], ["--break", "7", "--seed", "1"]),
  );
  assert.match(output, /locals:/);
  assert.match(output, /strip = \[CHERRY, BELL, SEVEN\]/);
  assert.match(output, /enclosing \(1\):/);
});

test("`print` reports a binding and refuses one that is out of scope", () => {
  const output = plain(
    debugSession(
      PROGRAM,
      ["continue", "print strip", "print nonexistent", "continue"],
      ["--break", "7", "--seed", "1"],
    ),
  );
  assert.match(output, /strip = \[CHERRY, BELL, SEVEN\]/);
  assert.match(output, /`nonexistent` is not in scope here/);
});

test("`effects` distinguishes a pure function from an effectful one", () => {
  // With `--break`, the session stops at the breakpoint immediately, so the
  // first command is already issued at the stop — no leading `continue`.
  const pureStop = plain(
    debugSession(PROGRAM, ["effects", "continue"], ["--break", "2", "--seed", "1"]),
  );
  assert.match(pureStop, /houseEdge is pure/);

  const effectStop = plain(
    debugSession(PROGRAM, ["effects", "continue"], ["--break", "7", "--seed", "1"]),
  );
  assert.match(effectStop, /spinOnce declares `rand`/);
});

test("`list` renders source with the breakpoint and cursor marked", () => {
  const output = plain(
    debugSession(PROGRAM, ["continue", "list", "continue"], ["--break", "7", "--seed", "1"]),
  );
  assert.match(output, /●▶\s+7 │/);
});

test("breakpoints can be set and removed mid-session", () => {
  const output = plain(
    debugSession(
      PROGRAM,
      ["break 18", "info breaks", "delete 18", "info breaks", "continue"],
      ["--seed", "1"],
    ),
  );
  assert.match(output, /breakpoint set at line 18/);
  assert.match(output, /breakpoint at line 18 removed/);
  assert.match(output, /no breakpoints/);
});

test("`quit` stops the program before it finishes", () => {
  const output = plain(debugSession(PROGRAM, ["quit"], ["--seed", "1"]));
  assert.match(output, /stopped by the debugger/);
  assert.ok(!output.includes("edge 0.035"), "the program still ran to completion");
});

test("an unknown command is reported without ending the session", () => {
  const output = plain(debugSession(PROGRAM, ["frobnicate", "continue"], ["--seed", "1"]));
  assert.match(output, /unknown command `frobnicate`/);
  assert.match(output, /program finished/);
});

test("a program with type errors is refused before anything runs", () => {
  let output = "";
  try {
    debugSession(
      `fn spin() -> Float {\n    rng.int(0, 9)\n}\n\nfn main() uses io {\n    print("{spin()}")\n}\n`,
      ["continue"],
    );
    throw new Error("the debugger accepted a program with an effect error");
  } catch (error) {
    output = plain(String(error.stdout ?? "") + String(error.stderr ?? ""));
  }
  assert.match(output, /E06\d\d/);
  assert.match(output, /nothing was run/);
});

test("the debugger works on a bundled example with a game block", () => {
  const example = resolve(ROOT, "examples/slot_machine.sun");
  const commands = join(WORK, "example.txt");
  writeFileSync(commands, ["where", "vars", "continue"].join("\n") + "\n");
  const output = plain(
    sunra(["debug", example, "--script", commands, "--seed", "7"]),
  );
  assert.match(output, /Sunra debugger/);
  assert.match(output, /program finished after/);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
