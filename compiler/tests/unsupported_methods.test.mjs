#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const source = "fn main() uses io {\n    let x = [1, 2, 3].max()\n    print(x)\n}\n";
const file = "/tmp/sunra-unsupported-list-method.sun";
writeFileSync(file, source);

const cli = spawnSync(process.execPath, [join(ROOT, "dist", "cli", "main.js"), "check", file], {
  encoding: "utf8",
});
assert.notEqual(cli.status, 0, cli.stdout);
assert.match(`${cli.stdout}\n${cli.stderr}`, /E0900/);
assert.match(`${cli.stdout}\n${cli.stderr}`, /has no member `max`/);

const { runPipeline } = await import(join(ROOT, "dist", "pipeline", "pipeline.js"));
const pipeline = runPipeline(source, file, { native: false, sunvm: true });
assert.ok(pipeline.diagnostics.errors.some((error) => error.code === "E0900"));

// Backends must remain defensive when called with hand-built MIR that bypasses
// the checker: no unsupported list method may become a zero-valued builtin.
const { compileToSunVm } = await import(join(ROOT, "dist", "backend", "sunvm.js"));
const { buildMir } = await import(join(ROOT, "dist", "mir", "build.js"));
const { lowerToHir } = await import(join(ROOT, "dist", "hir", "lower.js"));
const { tokenize } = await import(join(ROOT, "dist", "lexer", "lexer.js"));
const { parse } = await import(join(ROOT, "dist", "parser", "parser.js"));
const { checkProgram } = await import(join(ROOT, "dist", "checker", "checker.js"));
const ast = parse(tokenize(source, file), file);
const checked = checkProgram(ast);
const mir = buildMir(lowerToHir(ast, file));
const vm = compileToSunVm(mir, { profile: "rgs" });
assert.ok(vm.rejected.length > 0, "SunVM silently accepted unsupported List.max()");
assert.match(vm.rejected.map((item) => item.reason).join("\n"), /E0900|unsupported|List/);

console.log("unsupported methods passed: checker E0900 + defensive SunVM rejection");
