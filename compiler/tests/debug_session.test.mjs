#!/usr/bin/env node
/**
 * Programmatic debugger tests.
 *
 * `tests/debugger.test.mjs` covers the interactive terminal debugger. This suite
 * covers `DebugSession`, the data-shaped API a debug adapter or the playground
 * would embed: breakpoints, step into/over/out, variable inspection and the call
 * stack, plus the guarantee that debugging does not change program output.
 */
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { DebugSession, debugSource } = await import(join(ROOT, "dist", "debugger", "session.js"));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

const SOURCE = [
  "fn double(n: Int) -> Int {", // 1
  "    return n * 2", //           2
  "}", //                          3
  "", //                           4
  "fn main() uses io {", //        5
  "    let a = 1", //              6
  "    let b = double(a)", //      7
  "    print(b)", //               8
  "}", //                          9
  "", //
].join("\n");

check("stepping into a call descends into the callee", () => {
  const result = debugSource(SOURCE, "step.sun", { steps: ["into", "into", "into", "into"] });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.stops.map((stop) => stop.line),
    [6, 7, 2, 8],
  );
});

check("stepping over a call stays in the caller", () => {
  const result = debugSource(SOURCE, "over.sun", { steps: ["over", "over", "over"] });
  assert.deepEqual(
    result.stops.map((stop) => stop.line),
    [6, 7, 8],
  );
});

check("stepping out returns to the caller's next statement", () => {
  const result = debugSource(SOURCE, "out.sun", { steps: ["into", "into", "into", "out"] });
  const lines = result.stops.map((stop) => stop.line);
  assert.deepEqual(lines, [6, 7, 2, 8]);
  // The stop after leaving `double` is back at caller depth.
  assert.equal(result.stops.at(-1).depth, result.stops[1].depth);
});

check("the first stop is reported as entry", () => {
  const result = debugSource(SOURCE, "entry.sun", { steps: ["into"] });
  assert.equal(result.stops[0].reason, "entry");
  assert.equal(result.stops[0].text, "let a = 1");
});

check("a breakpoint stops exactly on its line", () => {
  const result = debugSource(SOURCE, "bp.sun", { breakpoints: [8], stopOnEntry: false });
  assert.equal(result.stops.length, 1);
  assert.equal(result.stops[0].reason, "breakpoint");
  assert.equal(result.stops[0].line, 8);
});

check("variable inspection shows program bindings and hides builtins", () => {
  const result = debugSource(SOURCE, "vars.sun", { breakpoints: [8], stopOnEntry: false });
  const stop = result.stops[0];
  assert.deepEqual(stop.variables, { a: "1", b: "2" });
  assert.ok(stop.scope.print, "the full scope should still expose builtins");
});

check("the call stack is innermost first and names the callee", () => {
  const result = debugSource(SOURCE, "stack.sun", { breakpoints: [2], stopOnEntry: false });
  const stop = result.stops[0];
  assert.equal(stop.stack[0].name, "double");
  assert.ok(stop.depth >= 2);
});

check("declared effects travel with the frame", () => {
  const result = debugSource(SOURCE, "effects.sun", { breakpoints: [7], stopOnEntry: false });
  const frames = result.stops[0].stack.map((frame) => frame.name);
  assert.ok(frames.includes("main"));
  const main = result.stops[0].stack.find((frame) => frame.name === "main");
  assert.deepEqual(main.effects, ["io"]);
});

check("breakpoints can be added and removed before the run", () => {
  const session = new DebugSession(SOURCE, "manage.sun", { stopOnEntry: false });
  assert.equal(session.setBreakpoint(7), true);
  assert.equal(session.setBreakpoint(7), false);
  assert.deepEqual(session.breakpointLines, [7]);
  assert.equal(session.clearBreakpoint(7), true);
  assert.equal(session.clearBreakpoint(7), false);
  assert.deepEqual(session.breakpointLines, []);
});

check("a debugged run produces the same output as a plain run", () => {
  const debugged = debugSource(SOURCE, "output.sun", { steps: ["into", "into"] });
  assert.deepEqual(debugged.output, ["2"]);
  assert.ok(debugged.steps > 0);
});

check("a program that does not type-check is refused before it runs", () => {
  const result = debugSource('fn main() {\n    let x: Int = "s"\n}\n', "bad.sun");
  assert.equal(result.ok, false);
  assert.equal(result.stops.length, 0);
  assert.equal(result.diagnostics[0].code, "E0308");
});

check("a loop stops once per iteration and tracks the accumulator", () => {
  const source = [
    "fn main() uses io {",
    "    var total = 0",
    "    for i in range(3) {",
    "        total += i",
    "    }",
    "    print(total)",
    "}",
    "",
  ].join("\n");
  const result = debugSource(source, "loop.sun", { breakpoints: [4], stopOnEntry: false });
  assert.equal(result.stops.length, 3);
  assert.deepEqual(
    result.stops.map((stop) => stop.variables.total),
    ["0", "0", "1"],
  );
  assert.deepEqual(result.output, ["3"]);
});

check("maxStops keeps a runaway session bounded", () => {
  const source = [
    "fn main() uses io {",
    "    var total = 0",
    "    for i in range(500) {",
    "        total += i",
    "    }",
    "    print(total)",
    "}",
    "",
  ].join("\n");
  const result = debugSource(source, "bounded.sun", { breakpoints: [4], stopOnEntry: false, maxStops: 10 });
  assert.equal(result.stops.length, 10);
  assert.deepEqual(result.output, ["124750"]);
});

if (failures > 0) {
  console.error(`debug session: ${failures} failed`);
  process.exit(1);
}
console.log("debug session: all checks passed");
