#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeShare, encodeShare, findExample, playgroundExamples, runPlayground, shareLink, sourceFromLocation } from "../dist/browser/playground.js";
import { HotReloadSession } from "../dist/hotreload/watch.js";
import { extractLocaleAnnotations, extractStringTable, LocaleRuntime } from "../dist/i18n/i18n.js";
import { profileSunVm, reportJson, reportMarkdown } from "../dist/profiler/profiler.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}`); console.error(error?.stack ?? error); }
}

check("playground catalogue includes authored and bundled examples", () => {
  const examples = playgroundExamples();
  assert.ok(examples.length >= 15);
  assert.equal(findExample("hello")?.id, "hello");
  assert.ok(findExample("template-blackjack")?.source.includes("game Blackjack"));
});

check("share codec preserves unicode and full share links", () => {
  const source = 'fn main() uses io { print("สวัสดี Sunra 🎰") }\n';
  assert.equal(decodeShare(encodeShare(source)), source);
  const link = shareLink("https://sunra.dev/play", source);
  assert.equal(sourceFromLocation(link), source);
});

check("playground runner returns output, panels and stage timings", () => {
  const result = runPlayground('fn main() uses io { print("panel output") }\n');
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, ["panel output"]);
  assert.ok(result.panels.some((panel) => panel.kind === "output"));
  assert.ok(result.timings.some((timing) => timing.stage === "check"));
});

check("hot reload changes the module but preserves host state", () => {
  const session = new HotReloadSession({ profile: "open" });
  session.setState("player.balance", 1250);
  const first = session.load('fn main() uses io { print("v1") }\n', "hot.sun");
  assert.equal(first.type, "loaded");
  assert.deepEqual(session.run().output, ["v1"]);
  const digest = session.digest;
  const second = session.load('fn main() uses io { print("v2") }\n', "hot.sun");
  assert.equal(second.type, "loaded");
  assert.notEqual(session.digest, digest);
  assert.equal(session.getState("player.balance"), 1250);
  assert.deepEqual(session.run().output, ["v2"]);
  const bad = session.load('fn main() { let broken: Int = "x" }\n', "hot.sun");
  assert.equal(bad.type, "rejected");
  assert.equal(session.digest, second.digest);
  assert.deepEqual(session.run().output, ["v2"]);
});

check("i18n extracts locale annotations and switches with fallback", () => {
  const source = [
    '@locale("th")',
    'fn main() uses io { print("สวัสดี") }',
    '@locale("en")',
    'fn other() uses io { print("Hello") }',
    '',
  ].join("\n");
  const annotations = extractLocaleAnnotations(source);
  assert.deepEqual(annotations.map((annotation) => annotation.locale), ["th", "en"]);
  const table = extractStringTable(source);
  assert.ok(table.tables.th?.["สวัสดี"]);
  assert.ok(table.tables.en?.Hello);
  const runtime = new LocaleRuntime("en", table.tables);
  assert.equal(runtime.translate("Hello"), "Hello");
  runtime.add("th", { Hello: "สวัสดีครับ {name}" });
  assert.equal(runtime.setLocale("th-TH"), "th");
  assert.equal(runtime.format("Hello", { name: "Sunra" }), "สวัสดีครับ Sunra");
  assert.equal(runtime.setLocale("ja"), "ja");
  assert.equal(runtime.translate("Hello"), "Hello");
});

check("profiler records functions, allocations and renders reports", () => {
  const session = new HotReloadSession({ profile: "open" });
  const event = session.load('fn main() uses io {\n    let xs = [1, 2, 3]\n    print(xs.len())\n}\n', "profile.sun");
  assert.equal(event.type, "loaded");
  const profiled = profileSunVm(session.runtime);
  assert.ok(profiled.report.functions.some((item) => item.functionName === "main"));
  assert.ok(profiled.report.allocations >= 1);
  assert.ok(reportJson(profiled.report).includes('"hotspots"'));
  assert.ok(reportMarkdown(profiled.report).includes("## Hotspots"));
});

if (failed > 0) { console.error(`fixes10 features: ${failed} failed, ${passed} passed`); process.exit(1); }
console.log(`fixes10 features: ${passed} checks passed`);
