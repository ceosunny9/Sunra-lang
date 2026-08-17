import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { analyze, lex, run, test, verifyRtp, VERSION } from "../browser/index.js";
import { build, buildWasm } from "../codegen/build.js";
import { runPipeline } from "../pipeline/pipeline.js";
import { runPkgCommand } from "../pkg/commands.js";
import { certify, renderCertificate } from "../certify/certificate.js";
import {
  generateBaccarat,
  generateSlot,
  parseBaccaratBrief,
  parseSlotBrief,
} from "../scaffold/generate.js";
import { renderDiagnostic, SunraError } from "../diagnostics.js";
import { findTemplate, listTemplates, templateIds } from "../stdlib/templates.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { lowerToHir } from "../hir/lower.js";
import { emitSail } from "../sail/sail.js";
import { buildMir } from "../mir/build.js";
import { formatModule as formatMir } from "../mir/mir.js";
import { optimize } from "../opt/optimize.js";
import { refineModule } from "../refine/refine.js";
import { inferOwnership } from "../own/ownership.js";
import { compileToSunVm, decodeProgram } from "../backend/sunvm.js";
import { SunVmRuntime } from "../backend/sunvm_run.js";
import { runDebugger } from "../debugger/debugger.js";
import { startLanguageServer } from "../lsp/server.js";
import { HotReloadSession } from "../hotreload/watch.js";
import { extractStringTable, stringTableJson } from "../i18n/i18n.js";
import { profileSunVm, reportJson, reportMarkdown } from "../profiler/profiler.js";

const args = process.argv.slice(2);
const command = args[0];

function printHelp(): void {
  console.log(`Sunra ${VERSION} — high-assurance gaming language toolchain

Usage:
  sunra slot "<brief>"                       Generate a slot game from a brief
  sunra baccarat "<brief>"                   Generate a baccarat table
  sunra new <template> [--out <path>]        Generate a game from a bundled template
  sunra new --list                           List the bundled game templates
  sunra certify <file.sun>                   Issue an RTP + provably-fair certificate
  sunra run <file.sun> [--seed <seed>]       Run a checked program
  sunra check <file.sun> [--json]            Type-check with repairable diagnostics
  sunra tokens <file.sun> [--json]           Inspect the lexer token stream
  sunra ast <file.sun>                       Emit the parsed AST as JSON
  sunra effects <file.sun>                   Show inferred effects per function
  sunra rtp <file.sun> [options]             Simulate and verify declared RTP
  sunra test <file.sun> [--seed <seed>]      Run test blocks
  sunra build <file.sun> [options]           Emit JavaScript or WebAssembly
  sunra vm run <file.sunbc> [--entry <fn>]   Execute SunVM bytecode
  sunra dump-hir <file.sun> [--json]         Show the desugared, typed HIR
  sunra dump-mir <file.sun> [--opt]          Show SSA SunMIR, optionally optimised
  sunra dump-sail <file.sun>                 Emit SAIL JSON for AI tooling
  sunra opt <file.sun>                       Compare MIR before and after optimisation
  sunra debug <file.sun> [--break <lines>]   Step through a program
  sunra watch <file.sun> [--entry <fn>]      Recompile and reload SunVM on save
  sunra i18n extract <file.sun> [--out <p>]  Extract a locale string table
  sunra profile <file.sun> [--out <p>]       Profile SunVM timing/allocations
  sunra lsp                                  Start the language server on stdio
  sunra pipeline <file.sun> [--json]         Run all 14 assurance stages
  sunra report <file.sun> [--out <path>]     Emit a signed build report
  sunra examples                            List bundled examples
  sunra version                              Print the compiler version
  sunra pkg <subcommand>                     Manage Sunra packages

Generator examples:
  sunra slot "ธีมมังกร 5x3 243ways"
  sunra slot "egypt 5x3 20 lines rtp 96.5 high volatility"
  sunra baccarat "SA Gaming style"
  sunra baccarat "8 สำรับ ไม่เก็บค่าน้ำ"

Generator options:
  --out <path>       Where to write the .sun file (default: <name>.sun)
  --print            Print to stdout instead of writing a file
  --run              Run the generated game once it is written

Build options:
  --out <path>       Output path (.js or .wasm)
  --target wasm      Emit WebAssembly plus a loader
  --target vm        Emit SunVM bytecode (.sunbc) for the sandboxed RGS
  --seed <seed>      Bake a deterministic seed into the artifact
  --bundle           Inline the JavaScript runtime
  --force            Emit despite front-end errors (unsafe)

RTP options:
  --rounds <n>       Number of simulation rounds (default 100000)
  --seed <seed>      Deterministic simulation seed
  --json             Write machine-readable rtp-report.json

Pipeline options:
  --fixed-point      Compile Float as fixed-point i64 in the WASM-contract
                     backend, so paytable arithmetic reaches a chain runtime
                     without IEEE-754 (deterministic, scale 10^6)
  --json             Emit the full pipeline result as JSON
`);
}

const hasFlag = (name: string): boolean => args.includes(name);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function targetPath(): string | null {
  const candidate = args[1];
  return !candidate || candidate.startsWith("-") ? null : resolve(process.cwd(), candidate);
}
function readSource(): { path: string; source: string } | null {
  const path = targetPath();
  if (!path) { console.error("error: missing target file"); printHelp(); return null; }
  try { return { path, source: readFileSync(path, "utf8") }; }
  catch { console.error(`error: cannot read ${path}`); return null; }
}
function printDiagnostics(diagnostics: Array<{ rendered?: string; code?: string; message?: string }>): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.rendered) console.error(diagnostic.rendered);
    else console.error(`error[${diagnostic.code ?? "E0000"}]: ${diagnostic.message ?? "unknown error"}`);
  }
}
const seed = (): string | undefined => option("--seed");

/**
 * The brief is everything after the subcommand that is not a flag or a flag
 * value, joined back together. Quoting is therefore optional, which matters
 * because `sunra slot ธีมมังกร 5x3` is what people actually type.
 */
function collectBrief(): string {
  const flagValues = new Set([option("--out"), option("--seed"), option("--rounds")].filter(Boolean) as string[]);
  const words: string[] = [];
  for (const arg of args.slice(1)) {
    if (arg.startsWith("--")) continue;
    if (flagValues.has(arg)) continue;
    words.push(arg);
  }
  return words.join(" ").trim();
}

/** Write a generated program, then check it so the user never gets broken source. */
function emitGenerated(name: string, source: string): number {
  if (hasFlag("--print")) {
    console.log(source);
    return 0;
  }

  const outPath = resolve(process.cwd(), option("--out") ?? `${name.toLowerCase()}.sun`);
  writeFileSync(outPath, source, "utf8");

  const verdict = analyze(source);
  console.log(`wrote ${outPath}`);
  if (!verdict.ok) {
    console.error("the generated program did not type-check, which is a generator bug:");
    printDiagnostics(verdict.diagnostics.filter((d) => d.severity === "error"));
    return 1;
  }
  console.log(`${basename(outPath)} type-checks.`);
  console.log("");
  console.log("Next:");
  console.log(`  sunra run     ${basename(outPath)} --seed 42`);
  console.log(`  sunra rtp     ${basename(outPath)} --rounds 1000000`);
  console.log(`  sunra certify ${basename(outPath)}`);

  if (hasFlag("--run")) {
    console.log("");
    return runCommand(source);
  }
  return 0;
}

function slotCommand(): number {
  const brief = parseSlotBrief(collectBrief());
  const generated = generateSlot(brief);
  return emitGenerated(generated.name, generated.source);
}

function baccaratCommand(): number {
  const brief = parseBaccaratBrief(collectBrief());
  const generated = generateBaccarat(brief);
  return emitGenerated(generated.name, generated.source);
}

/**
 * `sunra new <template>` — write one of the bundled game templates.
 *
 * The templates are complete programs, so this is the shortest path from "I want
 * a blackjack table" to a file that type-checks, runs, tests and certifies.
 */
function newCommand(): number {
  const wanted = args[1];
  if (hasFlag("--list") || !wanted || wanted.startsWith("--")) {
    console.log("Bundled game templates:");
    let category = "";
    for (const template of listTemplates()) {
      if (template.category !== category) {
        category = template.category;
        const heading =
          category === "card"
            ? "Card games"
            : category === "dice"
              ? "Dice games"
              : category === "lottery"
                ? "Lottery"
                : "Common patterns";
        console.log("");
        console.log(`  ${heading}`);
      }
      console.log(
        `    ${template.id.padEnd(11)} RTP ${template.rtp.toFixed(4)}  ${template.summary}`,
      );
    }
    console.log("");
    console.log("Usage:  sunra new <template> [--out <path>] [--print] [--run]");
    return 0;
  }

  const template = findTemplate(wanted);
  if (!template) {
    console.error(`error: unknown template ${wanted}`);
    console.error(`known templates: ${templateIds().join(", ")}`);
    return 1;
  }
  return emitGenerated(template.name, template.source);
}

function checkCommand(source: string, file: string): number {
  const result = analyze(source);
  if (hasFlag("--json")) {
    console.log(JSON.stringify({
      errors: result.diagnostics.filter((d) => d.severity === "error").map((d) => ({
        code: d.code, severity: d.severity, category: "compiler", message: d.message,
        span: { file, line: d.line, col: d.col, length: d.length }, hint: d.hint,
        docs: `https://sunra.dev/errors/${d.code}`,
      })),
      warnings: result.diagnostics.filter((d) => d.severity !== "error"),
    }, null, 2));
  } else {
    printDiagnostics(result.diagnostics);
    if (result.ok) console.log(`${file} type-checks successfully.`);
  }
  return result.ok ? 0 : 1;
}
function runCommand(source: string): number {
  const result = run(source, { seed: seed() });
  for (const line of result.output) console.log(line);
  printDiagnostics(result.diagnostics.filter((d) => d.severity === "error"));
  return result.ok ? 0 : 1;
}
function testCommand(source: string): number {
  const result = test(source, { seed: seed() });
  for (const line of result.output) console.log(line);
  // The tally line is what CI and the regression suite read, so it is printed
  // even when every test passed and the per-test lines already say so.
  console.log("");
  console.log(`${result.passed} passed, ${result.failed} failed`);
  printDiagnostics(result.diagnostics.filter((d) => d.severity === "error"));
  return result.ok ? 0 : 1;
}
function rtpCommand(source: string): number {
  const rounds = Number(option("--rounds") ?? "100000");
  if (!Number.isFinite(rounds) || rounds < 1) { console.error("error: --rounds must be a positive integer"); return 1; }
  const result = verifyRtp(source, { rounds: Math.floor(rounds), seed: seed() });
  printDiagnostics(result.diagnostics.filter((d) => d.severity === "error"));
  if (!result.ok) return 1;
  const reports = result.reports.map((report) => ({ ...report, rtp: report.actual }));
  for (const report of reports) {
    const low = (report.actual - report.confidence95) * 100;
    const high = (report.actual + report.confidence95) * 100;
    console.log(`Game         ${report.game}`);
    console.log(`Rounds       ${report.rounds.toLocaleString()}`);
    console.log(`RTP          ${(report.actual * 100).toFixed(4)}%`);
    console.log(`95% CI       [${low.toFixed(4)}%, ${high.toFixed(4)}%]`);
    console.log(`Hit rate     ${(report.hitRate * 100).toFixed(4)}%`);
    console.log(`Volatility   ${report.volatility.toFixed(4)}x`);
    console.log(`Verdict      ${report.verdict}`);
  }
  if (hasFlag("--json")) writeFileSync(resolve(process.cwd(), "rtp-report.json"), JSON.stringify(reports, null, 2));
  return reports.every((report) => report.verdict !== "FAIL") ? 0 : 1;
}
function i18nCommand(): number {
  if (args[1] !== "extract") {
    console.error("error: usage is `sunra i18n extract <file.sun> [--out <path>]`");
    return 1;
  }
  const candidate = args[2];
  if (!candidate) { console.error("error: missing source file"); return 1; }
  const path = resolve(process.cwd(), candidate);
  let source: string;
  try { source = readFileSync(path, "utf8"); } catch { console.error(`error: cannot read ${path}`); return 1; }
  const table = extractStringTable(source, option("--locale") ?? "en");
  const output = stringTableJson(source, option("--locale") ?? "en");
  const outPath = option("--out");
  if (outPath) {
    const target = resolve(process.cwd(), outPath);
    writeFileSync(target, output, "utf8");
    console.log(`wrote ${target} (${table.messages.length} messages, ${table.locales.join(", ")})`);
  } else {
    process.stdout.write(output);
  }
  return 0;
}

function profileCommand(source: string, sourcePath: string): number {
  const hir = lowerChecked(source, sourcePath);
  if (!hir) return 1;
  const mir = optimize(buildMir(hir, inferOwnership(hir)), { refine: refineModule(hir) }).module;
  const compiled = compileToSunVm(mir, { profile: "open" });
  if (compiled.rejected.length > 0) {
    for (const item of compiled.rejected) console.error(`warning: skipped ${item.symbol}: ${item.reason}`);
  }
  const runtime = new SunVmRuntime();
  for (const name of compiled.program.imports) if (runtime.missingImports().includes(name)) runtime.bind(name, () => null);
  try {
    runtime.load(compiled.bytes);
    const entry = option("--entry") ?? "main";
    const result = profileSunVm(runtime, entry, collectVmArgs());
    const format = option("--format") ?? "json";
    const rendered = format === "md" || format === "markdown" ? reportMarkdown(result.report) : reportJson(result.report);
    const outPath = option("--out");
    if (outPath) { const target = resolve(process.cwd(), outPath); writeFileSync(target, rendered, "utf8"); console.log(`wrote ${target}`); }
    else process.stdout.write(rendered);
    if (result.result.output.length > 0) for (const line of result.result.output) console.error(`[output] ${line}`);
    return 0;
  } catch (error) {
    console.error(`profile error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function watchCommand(sourcePath: string): Promise<number> {
  const session = new HotReloadSession({ profile: "open" });
  const printEvent = (event: ReturnType<HotReloadSession["load"]>) => {
    const mark = event.type === "loaded" ? "reloaded" : event.type;
    console.error(`[sunra watch] ${mark} ${basename(event.path)} generation=${event.generation}${event.digest ? ` digest=${event.digest}` : ""}`);
    for (const diagnostic of event.diagnostics) console.error(`  ${diagnostic.severity}[${diagnostic.code}] ${diagnostic.message}`);
  };
  const initial = session.loadFile(sourcePath);
  printEvent(initial);
  if (initial.type === "rejected" || initial.type === "error") return 1;
  const entry = option("--entry") ?? "main";
  if (hasFlag("--once")) {
    try { for (const line of session.run(entry, collectVmArgs()).output) console.log(line); return 0; }
    catch (error) { console.error(`watch run error: ${error instanceof Error ? error.message : String(error)}`); return 1; }
  }
  const handle = session.watch(sourcePath, { debounceMs: Number(option("--debounce") ?? "80"), onReload: printEvent });
  console.error(`[sunra watch] watching ${resolve(process.cwd(), sourcePath)} — press Ctrl-C to stop`);
  await new Promise<void>((resolveStop) => {
    const stop = () => { handle.close(); resolveStop(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function buildCommand(source: string, sourcePath: string): number {
  const options = { sourcePath, source, outPath: option("--out"), seed: seed(), bundle: hasFlag("--bundle"), force: hasFlag("--force"), entryPoint: true };
  if (option("--target") === "vm" || option("--target") === "sunvm") {
    return buildVmCommand(source, sourcePath);
  }
  if (option("--target") === "wasm") {
    const artifact = buildWasm(options);
    if (artifact.errors.length > 0 && !hasFlag("--force")) { printDiagnostics(artifact.errors.map((e) => ({ rendered: renderDiagnostic(e, source) }))); return 1; }
    console.log(`built ${artifact.outPath} (${artifact.bytes} bytes)`);
    if (artifact.loaderPath) console.log(`loader ${artifact.loaderPath}`);
    return 0;
  }
  const artifact = build(options);
  if (artifact.errors.length > 0 && !hasFlag("--force")) { printDiagnostics(artifact.errors.map((e) => ({ rendered: renderDiagnostic(e, source) }))); return 1; }
  console.log(`built ${artifact.outPath} (${artifact.bytes} bytes)`);
  if (artifact.runtimePath) console.log(`runtime ${artifact.runtimePath}`);
  return 0;
}
function pipelineCommand(source: string, file: string): number {
  const result = runPipeline(source, file, { native: true, sunvm: true, contract: true, contractFixedPointFloats: hasFlag("--fixed-point"), compilerVersion: `sunra ${VERSION}`, target: option("--target") ?? "analysis" });
  if (hasFlag("--json")) console.log(JSON.stringify({ ok: result.ok, stages: result.timings, report: result.report, compliance: result.compliance.summary, panic: result.panic, overflow: result.overflow, determinism: result.determinism }, null, 2));
  else {
    console.log(`Sunra 14-stage assurance pipeline — ${file}`);
    for (const timing of result.timings) console.log(`  ✓ ${timing.stage} (${timing.ms.toFixed(2)}ms)`);
    // Backend coverage: how many functions each backend actually lowered, so a
    // gap shows up in the output instead of being implied by a silent artifact.
    const { llvm, cranelift, sunvm, contract } = result.backends;
    if (llvm) console.log(`  llvm       ${llvm.functions.length} functions, ${llvm.skipped.length} skipped`);
    if (cranelift) console.log(`  cranelift  ${cranelift.functions.length} functions, ${cranelift.skipped.length} skipped`);
    if (sunvm) console.log(`  sunvm      ${sunvm.program.functions.length} functions, ${sunvm.rejected.length} rejected`);
    if (contract) console.log(`  wasm       ${contract.compiled.length} functions, ${contract.rejected.length} rejected${contract.manifest.fixedPoint.enabled ? " (fixed-point)" : ""}`);
    // Int64 range analysis: report the arithmetic that can leave the range, with
    // the source line, so it is actionable rather than a bare count.
    for (const warning of result.overflow.warnings) {
      console.log(`  warning: ${warning.symbol} line ${warning.span.line}: ${warning.detail}`);
      if (warning.hint) console.log(`           hint: ${warning.hint}`);
    }
    console.log(`Report digest: ${result.report.digest}`);
    console.log(`Compliance: ${result.compliance.summary.pass} pass, ${result.compliance.summary.fail} fail, ${result.compliance.summary.warn} warn, ${result.compliance.summary.manual} manual`);
  }
  return result.diagnostics.errors.length === 0 ? 0 : 1;
}
function certifyCommand(source: string, file: string): number {
  const rounds = Number(option("--rounds") ?? "200000");
  const certificate = certify(source, basename(file), {
    rounds: Number.isFinite(rounds) && rounds > 0 ? Math.floor(rounds) : 200_000,
    seed: seed(),
    compilerVersion: `sunra ${VERSION}`,
  });

  if (hasFlag("--json")) console.log(JSON.stringify(certificate, null, 2));
  else console.log(renderCertificate(certificate));

  const out = option("--out");
  if (out) {
    writeFileSync(resolve(process.cwd(), out), JSON.stringify(certificate, null, 2) + "\n", "utf8");
    console.log("");
    console.log(`certificate written to ${resolve(process.cwd(), out)}`);
  }
  return certificate.verdict === "CERTIFIED" ? 0 : 1;
}
function reportCommand(source: string, file: string): number {
  const result = runPipeline(source, file, { native: true, sunvm: true, contract: true, contractFixedPointFloats: hasFlag("--fixed-point"), compilerVersion: `sunra ${VERSION}`, target: option("--target") ?? "analysis" });
  const output = JSON.stringify(result.report, null, 2);
  const out = option("--out");
  if (out) writeFileSync(resolve(process.cwd(), out), output + "\n");
  console.log(output);
  return result.diagnostics.errors.length === 0 ? 0 : 1;
}
function tokensCommand(source: string): number {
  const result = lex(source);
  if (!result.ok) { printDiagnostics(result.diagnostics); return 1; }
  console.log(JSON.stringify(result.tokens, null, 2)); return 0;
}
function astCommand(source: string, file: string): number {
  try { console.log(JSON.stringify(new Parser(new Lexer(source, file).tokenize()).parseProgram(), null, 2)); return 0; }
  catch (error) { if (error instanceof SunraError) console.error(renderDiagnostic(error, source)); else console.error(String(error)); return 1; }
}
function effectsCommand(source: string): number {
  const result = analyze(source); printDiagnostics(result.diagnostics);
  for (const entry of result.effects) {
    console.log(`${entry.name}: ${entry.effects.length ? entry.effects.join(", ") : "pure"}`);
  }
  return result.ok ? 0 : 1;
}

/**
 * Lower to HIR, which every dump command needs.
 *
 * Returns `null` after printing diagnostics when the program does not check,
 * because the later stages assume a well-typed module.
 */
function lowerChecked(source: string, file: string) {
  const verdict = analyze(source);
  if (!verdict.ok) {
    printDiagnostics(verdict.diagnostics.filter((d) => d.severity === "error"));
    return null;
  }
  const program = new Parser(new Lexer(source, file).tokenize()).parseProgram();
  return lowerToHir(program, basename(file));
}

/** Emit SunVM bytecode: a real, decodable artifact rather than JavaScript. */
function buildVmCommand(source: string, sourcePath: string): number {
  const hir = lowerChecked(source, sourcePath);
  if (!hir) return 1;

  const refine = refineModule(hir);
  const mir = optimize(buildMir(hir, inferOwnership(hir)), { refine }).module;
  const compiled = compileToSunVm(mir, { profile: hasFlag("--open") ? "open" : "rgs" });

  const outPath = resolve(process.cwd(), option("--out") ?? sourcePath.replace(/\.sun$/, "") + ".sunbc");
  writeFileSync(outPath, compiled.bytes);

  console.log(`built ${outPath} (${compiled.bytes.length} bytes)`);
  console.log(`digest ${compiled.program.digest}`);
  console.log(`functions ${compiled.program.functions.length}, constants ${compiled.program.consts.length}`);
  if (compiled.program.imports.length > 0) {
    console.log(`host imports ${compiled.program.imports.join(", ")}`);
  }
  for (const rejected of compiled.rejected) {
    // Rejections are expected: the RGS profile deliberately refuses functions
    // that reach outside the sandbox.
    console.log(`skipped ${rejected.symbol}: ${rejected.reason}`);
  }
  console.log("");
  console.log(`Next: sunra vm run ${basename(outPath)}`);
  return 0;
}

/** Execute a `.sunbc` artifact on the SunVM. */
function vmCommand(): number {
  const subcommand = args[1];
  if (subcommand !== "run" && subcommand !== "info") {
    console.error("error: usage is `sunra vm run <file.sunbc>` or `sunra vm info <file.sunbc>`");
    return 1;
  }

  const candidate = args[2];
  if (!candidate) {
    console.error("error: missing bytecode file");
    return 1;
  }
  const path = resolve(process.cwd(), candidate);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch {
    console.error(`error: cannot read ${path}`);
    return 1;
  }

  if (subcommand === "info") {
    try {
      const program = decodeProgram(bytes);
      console.log(`digest    ${program.digest}`);
      console.log(`functions ${program.functions.map((f) => f.name).join(", ")}`);
      console.log(`constants ${program.consts.length}`);
      console.log(`imports   ${program.imports.length ? program.imports.join(", ") : "none"}`);
      return 0;
    } catch (error) {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const runtime = new SunVmRuntime();
  try {
    const loaded = runtime.load(bytes);
    const missing = runtime.missingImports();
    if (missing.length > 0) {
      // Binding a stub keeps a sandboxed module runnable from the CLI without
      // silently granting it real capabilities.
      for (const name of missing) runtime.bind(name, () => null);
      console.error(`note: stubbed unbound host imports: ${missing.join(", ")}`);
    }

    const entry = option("--entry") ?? "main";
    // `--arg` may be repeated: `sunra vm run g.sunbc --entry ratio --arg 3 --arg 4`.
    // Without this, calling any entry that takes parameters ran it against
    // uninitialised registers and printed a plausible-looking wrong answer.
    const entryArgs = collectVmArgs();
    const arity = decodeProgram(bytes).functions.find((f) => f.name === entry)?.arity;
    if (arity !== undefined && arity !== entryArgs.length) {
      console.error(
        `error: \`${entry}\` takes ${arity} argument${arity === 1 ? "" : "s"} but ${entryArgs.length} ${entryArgs.length === 1 ? "was" : "were"} supplied`,
      );
      console.error(`note: pass them with --arg, e.g. \`--entry ${entry}${" --arg <value>".repeat(arity)}\``);
      return 1;
    }
    const result = runtime.run(entry, entryArgs);
    for (const line of result.output) console.log(line);
    if (result.value !== null && result.value !== undefined) console.log(String(result.value));
    console.error(`[sunvm] digest ${loaded.digest} · ${result.steps} steps · ${result.allocations} allocations`);
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Values passed to a SunVM entry point via repeated `--arg` flags. */
function collectVmArgs(): Array<number | boolean | string> {
  const values: Array<number | boolean | string> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--arg") continue;
    const raw = args[i + 1];
    if (raw === undefined) break;
    if (raw === "true" || raw === "false") values.push(raw === "true");
    else if (raw !== "" && Number.isFinite(Number(raw))) values.push(Number(raw));
    else values.push(raw);
  }
  return values;
}

function dumpHirCommand(source: string, file: string): number {
  const hir = lowerChecked(source, file);
  if (!hir) return 1;

  if (hasFlag("--json")) {
    console.log(JSON.stringify(emitSail(hir), null, 2));
    return 0;
  }

  console.log(`SunHIR — ${basename(file)}`);
  const doc = emitSail(hir);
  for (const fn of doc.functions) {
    const params = fn.params.map((p) => `${p.name}: ${p.ty}`).join(", ");
    const effects = fn.effects.length ? ` uses ${fn.effects.join(", ")}` : "";
    console.log(`\nfn ${fn.name}(${params}) -> ${fn.ret}${effects}`);
    for (const line of describeSailNode(fn.body, 1)) console.log(line);
  }
  for (const game of doc.games) {
    console.log(`\ngame ${game.name}`);
    for (const field of game.fields) {
      console.log(`  ${field.name} = ${field.value.attrs.value ?? field.value.kind}`);
    }
    for (const reel of game.reels) {
      console.log(`  reel ${reel.name} (${reel.symbols.children.length} symbols)`);
    }
    console.log(`  methods ${game.methods.join(", ")}`);
  }
  return 0;
}

/** Render a SAIL node tree as indented text, which is what `dump-hir` prints. */
function describeSailNode(node: unknown, depth: number): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as {
    kind?: string;
    ty?: string | null;
    attrs?: Record<string, unknown>;
    children?: unknown[];
  };
  const indent = "  ".repeat(depth);
  const attrs = Object.entries(n.attrs ?? {})
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const detail = attrs ? ` ${attrs}` : "";
  const ty = n.ty ? `: ${n.ty}` : "";
  const lines = [`${indent}${n.kind ?? "node"}${detail}${ty}`];
  for (const child of n.children ?? []) lines.push(...describeSailNode(child, depth + 1));
  return lines;
}

function dumpMirCommand(source: string, file: string): number {
  const hir = lowerChecked(source, file);
  if (!hir) return 1;

  const mir = buildMir(hir, inferOwnership(hir));
  const module = hasFlag("--opt") ? optimize(mir, { refine: refineModule(hir) }).module : mir;
  console.log(formatMir(module));
  return 0;
}

function dumpSailCommand(source: string, file: string): number {
  const hir = lowerChecked(source, file);
  if (!hir) return 1;
  console.log(JSON.stringify(emitSail(hir), null, 2));
  return 0;
}

/**
 * Show what the optimiser did: instruction counts before and after, the pass
 * counters, and (with `--diff`) both listings.
 */
function optCommand(source: string, file: string): number {
  const hir = lowerChecked(source, file);
  if (!hir) return 1;

  const before = buildMir(hir, inferOwnership(hir));
  const run = optimize(before, { refine: refineModule(hir) });
  const after = run.module;

  const count = (module: typeof before): number =>
    module.functions.reduce(
      (total, fn) => total + fn.blocks.reduce((n, block) => n + block.instrs.length + 1, 0),
      0,
    );

  if (hasFlag("--json")) {
    console.log(JSON.stringify({ before: count(before), after: count(after), counts: run.counts, events: run.events }, null, 2));
    return 0;
  }

  console.log(`Optimiser — ${basename(file)}`);
  console.log(`  instructions before  ${count(before)}`);
  console.log(`  instructions after   ${count(after)}`);
  const passes = Object.entries(run.counts).filter(([, n]) => n > 0);
  console.log(`  passes applied       ${passes.length ? passes.map(([name, n]) => `${name}×${n}`).join(", ") : "none"}`);

  if (hasFlag("--diff")) {
    console.log("\n--- before ---");
    console.log(formatMir(before));
    console.log("\n--- after ---");
    console.log(formatMir(after));
  }
  return 0;
}

function debugCommand(path: string): number {
  const breaks = (option("--break") ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  // `--script <file>` replays one command per line instead of reading a
  // terminal, which is how the debugger is driven non-interactively.
  const scriptPath = option("--script");
  let script: string[] | undefined;
  if (scriptPath) {
    try {
      script = readFileSync(resolve(process.cwd(), scriptPath), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      console.error(`error: cannot read script ${scriptPath}`);
      return 1;
    }
  }

  return runDebugger(path, {
    seed: seed(),
    breakpoints: breaks,
    script,
    stopOnEntry: hasFlag("--stop-on-entry") || breaks.length === 0,
  });
}

async function main(): Promise<number> {
  if (!command || command === "help" || command === "--help" || command === "-h") { printHelp(); return 0; }
  if (command === "version") { console.log(`sunra ${VERSION}`); return 0; }
  if (command === "examples") { console.log("hello.sun\nslot_machine.sun\nbaccarat.sun\nprovably_fair.sun\ngaming_primitives.sun\nblockchain.sun"); return 0; }
  if (command === "slot") return slotCommand();
  if (command === "baccarat") return baccaratCommand();
  if (command === "new") return newCommand();
  if (command === "vm") return vmCommand();
  if (command === "lsp") { startLanguageServer(); return 0; }
  if (command === "pkg") {
    const subcommand = args[1]; const registry = option("--registry"); const token = option("--token");
    const positional = args.slice(2).filter((arg) => !arg.startsWith("--") && arg !== registry && arg !== token);
    return runPkgCommand(subcommand, { cwd: process.cwd(), args: positional, json: hasFlag("--json"), dev: hasFlag("--dev"), registry, token, remote: hasFlag("--remote") });
  }
  if (command === "i18n") return i18nCommand();
  const file = readSource();
  if (!file) return 1;
  switch (command) {
    case "check": return checkCommand(file.source, file.path);
    case "tokens": return tokensCommand(file.source);
    case "ast": return astCommand(file.source, file.path);
    case "effects": return effectsCommand(file.source);
    case "run": return runCommand(file.source);
    case "test": return testCommand(file.source);
    case "rtp": return rtpCommand(file.source);
    case "build": return buildCommand(file.source, file.path);
    case "dump-hir": return dumpHirCommand(file.source, file.path);
    case "dump-mir": return dumpMirCommand(file.source, file.path);
    case "dump-sail": return dumpSailCommand(file.source, file.path);
    case "opt": return optCommand(file.source, file.path);
    case "debug": return debugCommand(file.path);
    case "watch": return watchCommand(file.path);
    case "profile": return profileCommand(file.source, file.path);
    case "pipeline": return pipelineCommand(file.source, file.path);
    case "certify": return certifyCommand(file.source, file.path);
    case "report": return reportCommand(file.source, file.path);
    default: console.error(`error: unknown command ${command}`); printHelp(); return 1;
  }
}
main().then((status) => { process.exitCode = status; }).catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
