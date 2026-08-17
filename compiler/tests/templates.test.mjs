#!/usr/bin/env node
/**
 * Game template tests.
 *
 * A template that does not type-check is worse than no template, so every
 * bundled program is checked, its tests are run, and its declared RTP is
 * simulated. The simulation uses a fixed seed and a modest round count: enough to
 * catch a paytable that is wrong by a mile, quick enough to run in CI.
 */
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { listTemplates, findTemplate, templateIds } = await import(
  join(ROOT, "dist", "stdlib", "templates.js")
);
const { analyze, test: runTests, verifyRtp } = await import(join(ROOT, "dist", "browser", "index.js"));

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

const templates = listTemplates();

check("the catalogue covers card, dice, lottery and pattern templates", () => {
  const ids = templateIds();
  for (const wanted of ["blackjack", "poker", "craps", "sicbo", "lottery", "jackpot", "multiplier"]) {
    assert.ok(ids.includes(wanted), `${wanted} should be bundled`);
  }
  const categories = new Set(templates.map((template) => template.category));
  assert.deepEqual([...categories].sort(), ["card", "dice", "lottery", "pattern"]);
});

check("lookup is forgiving about case and separators", () => {
  assert.equal(findTemplate("BlackJack")?.id, "blackjack");
  assert.equal(findTemplate(" sic-bo ")?.id, "sicbo");
  assert.equal(findTemplate("sic bo")?.id, "sicbo");
  assert.equal(findTemplate("roulette"), null);
});

for (const template of templates) {
  check(`${template.id} type-checks`, () => {
    const result = analyze(template.source);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(errors, [], errors.map((e) => `${e.code}: ${e.message}`).join("; "));
    assert.equal(result.ok, true);
  });

  check(`${template.id} declares the game and a resolvable spin`, () => {
    assert.ok(template.source.includes(`game ${template.name}`), "the game block should be named");
    assert.ok(/\n\s+fn spin\(/.test(template.source), "a spin is what `sunra rtp` resolves");
    assert.ok(template.source.includes("fn main()"), "a template should be runnable");
    assert.ok(/\ntest "/.test(template.source), "a template should state its rules as tests");
  });

  check(`${template.id} passes its own tests`, () => {
    const result = runTests(template.source, { seed: "7" });
    assert.equal(result.failed, 0, `${result.failed} test(s) failed`);
    assert.ok(result.passed > 0, "a template should carry at least one test");
  });

  check(`${template.id} declares an RTP the metadata agrees with`, () => {
    const declared = new RegExp(`rtp\\s*=\\s*([0-9.]+)`).exec(template.source);
    assert.ok(declared, "the game block should declare an rtp");
    assert.equal(Number(declared[1]), template.rtp);
  });
}

// The dice and pattern games resolve quickly and have exact, published maths, so
// their measured return is asserted against the declared one. The card games and
// the lottery are either slow (shuffling a shoe per round) or dominated by a rare
// jackpot, and are covered by `sunra rtp` in the delivery checks instead.
for (const id of ["craps", "sicbo", "multiplier", "jackpot"]) {
  check(`${id} simulates within its declared tolerance`, () => {
    const template = findTemplate(id);
    const result = verifyRtp(template.source, { rounds: 20000, seed: "13" });
    assert.equal(result.ok, true, "the simulation should run");
    assert.ok(result.reports.length > 0, "a report should be produced");
    for (const report of result.reports) {
      assert.notEqual(report.verdict, "FAIL", `${id} measured ${report.actual}`);
    }
  });
}

if (failures > 0) {
  console.error(`templates: ${failures} failed`);
  process.exit(1);
}
console.log("templates: all checks passed");
