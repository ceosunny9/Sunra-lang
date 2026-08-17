#!/usr/bin/env node
/**
 * In-process language-server tests.
 *
 * `tests/lsp.test.mjs` drives the server over real stdio framing. This suite
 * exercises the same handlers through `LspSession`, the embedding API used by
 * the playground and by tooling that cannot spawn a subprocess.
 */
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { LspSession } = await import(join(ROOT, "dist", "lsp", "server.js"));

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

const uri = "file:///workspace/session.sun";
const source = [
  "fn payout(n: Int) -> Int {",
  "    return n * 2",
  "}",
  "",
  "fn main() uses io {",
  "    let v = payout(3)",
  "    print(v)",
  "}",
  "",
].join("\n");

const session = new LspSession();

check("initialize advertises completion, hover and definition", () => {
  const caps = session.request("initialize").capabilities;
  assert.ok(caps.completionProvider);
  assert.equal(caps.hoverProvider, true);
  assert.equal(caps.definitionProvider, true);
});

session.open(uri, source);

check("a clean document publishes no diagnostics", () => {
  assert.deepEqual(session.diagnostics(uri), []);
});

check("completion offers the document's own functions", () => {
  const items = session.completion(uri, 5, 12).items;
  const labels = items.map((item) => item.label);
  assert.ok(labels.includes("payout"), "payout missing");
});

check("hover reports the signature and purity", () => {
  const text = session.hover(uri, 5, 13).contents.value;
  assert.match(text, /fn payout\(n: Int\) -> Int/);
  assert.match(text, /Pure/);
});

check("definition jumps to the declaration line", () => {
  const result = session.definition(uri, 5, 13);
  const target = Array.isArray(result) ? result[0] : result;
  assert.equal(target.uri, uri);
  assert.equal(target.range.start.line, 0);
});

check("diagnostics follow an edit that introduces a type error", () => {
  session.change(uri, 'fn main() {\n    let x: Int = "str"\n}\n', 2);
  const diagnostics = session.diagnostics(uri);
  assert.ok(diagnostics.length >= 1);
  assert.equal(diagnostics[0].code, "E0308");
  assert.equal(diagnostics[0].severity, 1);
});

check("an unsupported list method reaches the editor as E0900", () => {
  session.change(uri, "fn main() uses io {\n    print([1, 2].max())\n}\n", 3);
  const codes = session.diagnostics(uri).map((diagnostic) => diagnostic.code);
  assert.ok(codes.includes("E0900"), `expected E0900, got ${codes.join(", ")}`);
});

check("diagnostics clear when the file is repaired", () => {
  session.change(uri, source, 4);
  assert.deepEqual(session.diagnostics(uri), []);
});

if (failures > 0) {
  console.error(`lsp session: ${failures} failed`);
  process.exit(1);
}
console.log("lsp session: all checks passed");
