/**
 * The browser entry point for the Sunra toolchain.
 *
 * This module exposes the same frontend the CLI uses — lexer, parser, checker,
 * interpreter and JavaScript emitter — behind an API that has no filesystem or
 * process dependencies. The playground imports it directly, which means the
 * code running in a visitor's browser is the compiler itself rather than a
 * simplified imitation of it.
 */

import { tokenize } from "../lexer/lexer.js";
import type { Token } from "../lexer/token.js";
import { Parser } from "../parser/parser.js";
import type { Expr, Program } from "../parser/ast.js";
import { checkProgram } from "../checker/checker.js";
import type { CheckResult } from "../checker/checker.js";
import { Interpreter } from "../interpreter/interpreter.js";
import { SunraError, renderDiagnostic } from "../diagnostics.js";
import { int, numeric } from "../runtime/values.js";
import type { Value } from "../runtime/values.js";
import { emitProgram } from "../codegen/emitter.js";
import { lowerToHir } from "../hir/lower.js";
import { refineModule } from "../refine/refine.js";
import { buildMir } from "../mir/build.js";
import { optimize } from "../opt/optimize.js";
import { provePanicFreedom } from "../verify/panic_free.js";
import { checkDeterminism } from "../verify/determinism.js";
import { gateDiagnostics } from "../verify/gate.js";
import type { Span } from "../diagnostics.js";

export interface BrowserDiagnostic {
  severity: "error" | "warning" | "note";
  code: string;
  message: string;
  hint: string | null;
  line: number;
  col: number;
  length: number;
  /** The rendered form, with the caret line, exactly as the CLI prints it. */
  rendered: string;
}

export interface AnalyzeResult {
  ok: boolean;
  tokens: number;
  diagnostics: BrowserDiagnostic[];
  /** Effect signature of every function, as the checker inferred it. */
  effects: Array<{ name: string; effects: string[] }>;
  /** Names of the game blocks the program declares. */
  games: string[];
  ast: Program | null;
}

export interface RunOutcome {
  ok: boolean;
  output: string[];
  diagnostics: BrowserDiagnostic[];
  steps: number;
  /** Wall-clock milliseconds spent inside the interpreter. */
  elapsedMs: number;
  /** Which generator served the program: secure, sim or fair. */
  rngKind: string | null;
}

export interface TestOutcome {
  ok: boolean;
  passed: number;
  failed: number;
  failures: string[];
  output: string[];
  diagnostics: BrowserDiagnostic[];
  elapsedMs: number;
}

export interface RtpReport {
  game: string;
  rounds: number;
  seed: string;
  /** Measured return to player, as a fraction. */
  actual: number;
  /** The value the game block declares, as a fraction, when it declares one. */
  target: number | null;
  tolerance: number;
  hitRate: number;
  volatility: number;
  maxWin: number;
  maxMultiple: number;
  /** Half-width of the 95% confidence interval on the RTP estimate. */
  confidence95: number;
  verdict: "PASS" | "FAIL" | "UNVERIFIED";
  elapsedMs: number;
}

export interface RtpOutcome {
  ok: boolean;
  reports: RtpReport[];
  diagnostics: BrowserDiagnostic[];
}

export interface CompileOutcome {
  ok: boolean;
  code: string | null;
  diagnostics: BrowserDiagnostic[];
}

/** Convert a compiler error into the shape the playground renders. */
function toDiagnostic(err: unknown, source: string): BrowserDiagnostic {
  if (err instanceof SunraError) {
    return {
      severity: err.severity,
      code: err.code,
      message: err.message,
      hint: err.hint ?? null,
      line: err.span?.line ?? 1,
      col: err.span?.col ?? 1,
      length: err.span?.length ?? 1,
      rendered: stripAnsi(renderDiagnostic(err, source)),
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    severity: "error",
    code: "E0000",
    message,
    hint: null,
    line: 1,
    col: 1,
    length: 1,
    rendered: message,
  };
}

/** The playground renders to HTML, so terminal colour codes have to go. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function parse(source: string): { tokens: Token[]; program: Program } {
  const tokens = tokenize(source, "playground.sun");
  const program = new Parser(tokens).parseProgram();
  return { tokens, program };
}

/**
 * Lex, parse and type-check without running anything. This is what the
 * playground calls while the visitor types.
 */
export function analyze(source: string): AnalyzeResult {
  let tokens: Token[] = [];
  let program: Program | null = null;

  try {
    const parsed = parse(source);
    tokens = parsed.tokens;
    program = parsed.program;
  } catch (err) {
    return {
      ok: false,
      tokens: tokens.length,
      diagnostics: [toDiagnostic(err, source)],
      effects: [],
      games: [],
      ast: null,
    };
  }

  let result: CheckResult;
  try {
    result = checkProgram(program);
  } catch (err) {
    return {
      ok: false,
      tokens: tokens.length,
      diagnostics: [toDiagnostic(err, source)],
      effects: [],
      games: [],
      ast: program,
    };
  }

  const diagnostics = [
    ...result.errors.map((e) => toDiagnostic(e, source)),
    ...result.warnings.map((w) => toDiagnostic(w, source)),
  ];

  // Fold the verification stages into the same diagnostic list.
  //
  // Until this ran here, the refinement checker and the panic-freedom prover
  // reported only into their own result objects: a program with a proven
  // division by zero under `#[no_panic]`, or an argument that provably breaks a
  // `where` clause, still type-checked and exited 0. Verification is skipped when
  // the type checker already failed, because the later stages assume a
  // well-typed program.
  if (result.errors.length === 0) {
    try {
      const hir = lowerToHir(program, "playground.sun");
      const refine = refineModule(hir);
      const optimized = optimize(buildMir(hir), { refine }).module;
      const panic = provePanicFreedom(optimized, refine);
      const determinism = checkDeterminism(optimized);
      for (const finding of gateDiagnostics({
        refine,
        panic,
        determinism,
        jurisdictions: declaredJurisdictions(program),
      })) {
        diagnostics.push(toDiagnostic(finding, source));
      }
    } catch {
      // A failure inside verification must not turn a well-typed program into a
      // syntax error; `sunra pipeline` reports such failures in detail.
    }
  }

  const effects = [...result.effectTable.entries()]
    .map(([name, set]) => ({ name, effects: [...set].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const games = program.body
    .filter((stmt) => stmt.kind === "GameDecl")
    .map((stmt) => (stmt as { name: string }).name);

  return {
    ok: !diagnostics.some((d) => d.severity === "error"),
    tokens: tokens.length,
    diagnostics,
    effects,
    games,
    ast: program,
  };
}

/**
 * Jurisdictions named by the source, in every spelling the language allows:
 *
 *   - the attribute, positional (`#[jurisdiction("MGA")]`) or keyed
 *     (`#[jurisdiction(name = "MGA")]`);
 *   - a `game` field, single (`jurisdiction = "MGA"`) or a list
 *     (`jurisdiction = ["MGA", "UKGC"]`).
 *
 * The field form is the one studios actually write, so scanning only attributes
 * silently accepted invented regulators.
 */
function declaredJurisdictions(program: Program): Array<{ name: string; span: Span | null }> {
  const found: Array<{ name: string; span: Span | null }> = [];

  const scan = (attributes: Array<{ name: string; args: Record<string, unknown>; span: Span }>) => {
    for (const attribute of attributes) {
      if (attribute.name !== "jurisdiction" && attribute.name !== "jurisdictions") continue;
      for (const value of Object.values(attribute.args)) {
        const literal = value as { kind?: string; value?: unknown };
        if (literal?.kind === "StrLit" && typeof literal.value === "string") {
          found.push({ name: literal.value, span: attribute.span });
        }
      }
    }
  };

  // A field value is either a string literal or an array of them. Anything else
  // (an identifier, a call) cannot be resolved statically and is left alone.
  const scanFieldValue = (value: Expr, span: Span) => {
    if (value.kind === "StrLit" && typeof value.value === "string") {
      found.push({ name: value.value, span });
      return;
    }
    if (value.kind === "ArrayLit") {
      for (const element of value.elements) {
        if (element.kind === "StrLit" && typeof element.value === "string") {
          found.push({ name: element.value, span: element.span ?? span });
        }
      }
    }
  };

  for (const stmt of program.body) {
    if (stmt.kind === "GameDecl") {
      scan(stmt.attributes);
      for (const method of stmt.functions) scan(method.attributes);
      for (const field of stmt.fields) {
        if (field.name !== "jurisdiction" && field.name !== "jurisdictions") continue;
        scanFieldValue(field.value, field.span);
      }
    } else if (stmt.kind === "FnDecl") {
      scan(stmt.attributes);
    }
  }
  return found;
}

export interface RunOptions {
  /** A seed makes the run reproducible; without one the secure generator is used. */
  seed?: string;
  /**
   * Statement budget. The playground sets this low enough that an accidental
   * infinite loop reports a runaway program instead of freezing the tab.
   */
  stepLimit?: number;
}

/** Run a program's `main` function and capture everything it prints. */
export function run(source: string, options: RunOptions = {}): RunOutcome {
  const analysis = analyze(source);
  if (!analysis.ok || analysis.ast === null) {
    return {
      ok: false,
      output: [],
      diagnostics: analysis.diagnostics,
      steps: 0,
      elapsedMs: 0,
      rngKind: null,
    };
  }

  const output: string[] = [];
  const interp = new Interpreter({
    seed: options.seed,
    stepLimit: options.stepLimit ?? 40_000_000,
    stdout: (line) => output.push(line),
  });

  const started = performance.now();
  try {
    const result = interp.run(analysis.ast);
    return {
      ok: true,
      output,
      diagnostics: analysis.diagnostics.filter((d) => d.severity !== "error"),
      steps: result.steps,
      elapsedMs: performance.now() - started,
      rngKind: interp.currentRng.kind,
    };
  } catch (err) {
    return {
      ok: false,
      output,
      diagnostics: [...analysis.diagnostics, toDiagnostic(err, source)],
      steps: 0,
      elapsedMs: performance.now() - started,
      rngKind: interp.currentRng.kind,
    };
  }
}

/** Run every `test` block and report the tally. */
export function test(source: string, options: RunOptions = {}): TestOutcome {
  const analysis = analyze(source);
  if (!analysis.ok || analysis.ast === null) {
    return {
      ok: false,
      passed: 0,
      failed: 0,
      failures: [],
      output: [],
      diagnostics: analysis.diagnostics,
      elapsedMs: 0,
    };
  }

  const output: string[] = [];
  const interp = new Interpreter({
    seed: options.seed ?? "sunra-test",
    stepLimit: options.stepLimit ?? 40_000_000,
    stdout: (line) => output.push(stripAnsi(line)),
  });

  const started = performance.now();
  try {
    const tally = interp.runTests(analysis.ast);
    return {
      ok: tally.failed === 0,
      passed: tally.passed,
      failed: tally.failed,
      failures: tally.failures,
      output,
      diagnostics: analysis.diagnostics.filter((d) => d.severity !== "error"),
      elapsedMs: performance.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      passed: 0,
      failed: 0,
      failures: [],
      output,
      diagnostics: [...analysis.diagnostics, toDiagnostic(err, source)],
      elapsedMs: performance.now() - started,
    };
  }
}

/** Pull a win amount out of whatever shape a spin function returned. */
function extractWin(result: Value): number {
  if (result.t === "int" || result.t === "float") return result.v;
  if (result.t === "money") return numeric(result);
  if (result.t === "record") {
    for (const key of ["win", "payout", "total", "amount"]) {
      const v = result.v.get(key);
      if (v && (v.t === "int" || v.t === "float" || v.t === "money")) return numeric(v);
    }
  }
  return 0;
}

/**
 * Simulate every game block and measure its return to player.
 *
 * This is the operation that distinguishes Sunra from a general-purpose
 * language, so the playground runs the real thing: the same Monte Carlo
 * estimate, the same confidence interval, and the same verdict the build
 * pipeline would reach.
 */
export function verifyRtp(
  source: string,
  options: { rounds?: number; seed?: string } = {},
): RtpOutcome {
  const analysis = analyze(source);
  if (!analysis.ok || analysis.ast === null) {
    return { ok: false, reports: [], diagnostics: analysis.diagnostics };
  }

  const rounds = options.rounds ?? 100_000;
  const seed = options.seed ?? "sunra-rtp";
  const interp = new Interpreter({
    seed,
    stepLimit: 2_000_000_000,
    stdout: () => {},
  });

  try {
    interp.run(analysis.ast);
  } catch (err) {
    return {
      ok: false,
      reports: [],
      diagnostics: [...analysis.diagnostics, toDiagnostic(err, source)],
    };
  }

  const reports: RtpReport[] = [];

  const runtimeDiagnostics: BrowserDiagnostic[] = [];

  for (const [name, gameValue] of interp.gameRegistry) {
    if (gameValue.t !== "game") continue;
    const spin = gameValue.methods.get("spin") ?? gameValue.methods.get("resolve");
    if (!spin) continue;

    const betField = gameValue.fields.get("bet") ?? gameValue.fields.get("bet_amount");
    const bet = betField ? numeric(betField) : 1;
    const declared = gameValue.fields.get("rtp");
    const tolField = gameValue.fields.get("tolerance");
    const tolerance = tolField ? numeric(tolField) : 0.005;

    // `spin` is commonly written as `spin(bet: Int)`. Calling it with no
    // arguments raised an arity error that escaped as an unhandled exception, so
    // `sunra rtp` printed a stack trace instead of a report. Supply the stake for
    // every parameter the method declares.
    const arity =
      spin.t === "fn" ? spin.decl.params.length : spin.t === "lambda" ? spin.params.length : 0;
    const stakeArgs = Array.from({ length: arity }, () => int(bet));

    let totalWin = 0;
    let hits = 0;
    let maxWin = 0;
    // Welford's method: numerically stable, and unlike a naive sum of squares it
    // does not lose precision when the mean is small relative to a 180x win.
    let mean = 0;
    let m2 = 0;
    let observed = 0;

    const started = performance.now();
    try {
      for (let i = 0; i < rounds; i++) {
        const win = extractWin(interp.callValue(spin, stakeArgs, null));
        totalWin += win;
        if (win > 0) hits += 1;
        if (win > maxWin) maxWin = win;
        const multiple = bet > 0 ? win / bet : 0;
        observed += 1;
        const delta = multiple - mean;
        mean += delta / observed;
        m2 += delta * (multiple - mean);
      }
    } catch (err) {
      // A game that cannot be simulated is a reportable condition, not a crash:
      // the caller needs a diagnostic and a non-zero exit, not a stack trace.
      runtimeDiagnostics.push(toDiagnostic(err, source));
      continue;
    }
    const elapsedMs = performance.now() - started;

    const staked = rounds * bet;
    const actual = staked > 0 ? totalWin / staked : 0;
    const variance = observed > 1 ? m2 / (observed - 1) : 0;
    const volatility = Math.sqrt(Math.max(0, variance));
    const confidence95 = 1.96 * (volatility / Math.sqrt(Math.max(1, observed)));

    let target: number | null = null;
    let verdict: RtpReport["verdict"] = "UNVERIFIED";
    if (declared) {
      const raw = numeric(declared);
      target = raw > 1 ? raw / 100 : raw;
      verdict = Math.abs(actual - target) <= tolerance ? "PASS" : "FAIL";
    }

    reports.push({
      game: name,
      rounds,
      seed,
      actual,
      target,
      tolerance,
      hitRate: rounds > 0 ? hits / rounds : 0,
      volatility,
      maxWin,
      maxMultiple: bet > 0 ? maxWin / bet : 0,
      confidence95,
      verdict,
      elapsedMs,
    });
  }

  return {
    // A game that failed to simulate leaves no report to judge, so the outcome is
    // not ok: the CLI turns that into a non-zero exit.
    ok: runtimeDiagnostics.length === 0,
    reports,
    diagnostics: [...analysis.diagnostics, ...runtimeDiagnostics],
  };
}

/** Transpile to JavaScript, so a visitor can read what the compiler emits. */
export function compileToJs(source: string, options: { seed?: string } = {}): CompileOutcome {
  const analysis = analyze(source);
  if (!analysis.ok || analysis.ast === null) {
    return { ok: false, code: null, diagnostics: analysis.diagnostics };
  }

  try {
    const emitted = emitProgram(analysis.ast, {
      sourceName: "playground.sun",
      runtimeSpecifier: "./sunra_runtime.js",
      seed: options.seed,
      emitEntryPoint: true,
    });
    return { ok: true, code: emitted.code, diagnostics: analysis.diagnostics };
  } catch (err) {
    return {
      ok: false,
      code: null,
      diagnostics: [...analysis.diagnostics, toDiagnostic(err, source)],
    };
  }
}

/** Token stream, for the playground's inspector tab. */
export function lex(source: string): { ok: boolean; tokens: Token[]; diagnostics: BrowserDiagnostic[] } {
  try {
    return { ok: true, tokens: tokenize(source, "playground.sun"), diagnostics: [] };
  } catch (err) {
    return { ok: false, tokens: [], diagnostics: [toDiagnostic(err, source)] };
  }
}

export const VERSION = "0.2.0";
