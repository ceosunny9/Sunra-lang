/**
 * Pipeline driver.
 *
 * One function that walks a program through every stage in the architecture
 * diagram and returns the artefacts of each. The CLI, the tests and the
 * documentation site all consume this rather than re-wiring the stages
 * themselves, so there is exactly one definition of what "the Sunra pipeline"
 * means and the stage order cannot drift between callers.
 *
 * Stage order is not arbitrary; each stage consumes something the previous one
 * produced:
 *
 *   source -> tokens -> AST -> (checker) -> SunHIR -> SAIL
 *                                            |
 *                                            +-> refinement -> ownership
 *                                                     |            |
 *                                                     +-> SunMIR <-+
 *                                                          |
 *                                                     optimizer
 *                                                          |
 *          +-----------+-----------+---------+-------------+
 *          |           |           |         |
 *        LLVM      Cranelift     SunVM   WASM-contract
 *                                                          |
 *                                      panic prover + determinism checker
 *                                                          |
 *                                              rule packs -> signed report
 *
 * The refinement result reaches the optimizer (bounds elision) and the panic
 * prover (discharging obligations); the ownership result reaches SunMIR (drop
 * placement). Reordering these would silently weaken the analyses rather than
 * fail loudly, which is why the order lives here and not in each caller.
 */
import { tokenize } from "../lexer/lexer.js";
import { parseRecovering } from "../parser/parser.js";
import { checkProgram } from "../checker/checker.js";
import { lowerToHir } from "../hir/lower.js";
import { emitSail } from "../sail/sail.js";
import { refineModule } from "../refine/refine.js";
import { inferOwnership } from "../own/ownership.js";
import { buildMir } from "../mir/build.js";
import { verifyModule } from "../mir/verify.js";
import { optimize } from "../opt/optimize.js";
import { emitLlvm } from "../backend/llvm.js";
import { emitCranelift } from "../backend/cranelift.js";
import { compileToSunVm } from "../backend/sunvm.js";
import { emitContract } from "../backend/wasm_contract.js";
import { provePanicFreedom } from "../verify/panic_free.js";
import { checkOverflow } from "../verify/overflow.js";
import { checkDeterminism } from "../verify/determinism.js";
import { evaluateCompliance, type Jurisdiction } from "../compliance/rulepacks.js";
import { buildReport, signReport, volatilityFrom } from "../compliance/build_report.js";
import type { BuildReport, VolatilityProfile } from "../compliance/build_report.js";
import type { Program } from "../parser/ast.js";
import type { HirModule } from "../hir/hir.js";
import type { MirModule } from "../mir/mir.js";
import type { SunraError } from "../diagnostics.js";

export interface PipelineOptions {
  /** Emit native IR (LLVM + Cranelift). Off by default because it is verbose. */
  native?: boolean;
  /** Emit SunVM bytecode. */
  sunvm?: boolean;
  /** Emit a WASM contract module. */
  contract?: boolean;
  /**
   * Compile `Float` as fixed-point `i64` in the contract backend instead of
   * rejecting the function. Deterministic, and what makes a real paytable
   * compile to a chain contract.
   */
  contractFixedPointFloats?: boolean;
  /** Run the optimizer. On by default. */
  optimize?: boolean;
  /** Jurisdictions to evaluate. */
  jurisdictions?: Jurisdiction[];
  /** Measured RTP, when a simulation was run beforehand. */
  measuredRtp?: Array<{ game: string; rtp: number; spins: number }>;
  /** Volatility profiles, when a simulation was run beforehand. */
  volatility?: VolatilityProfile[];
  /** Studio declarations for rules the compiler cannot check. */
  declarations?: Parameters<typeof evaluateCompliance>[0]["declarations"];
  /** Signing key and identifier. Unsigned when omitted. */
  signingKey?: string;
  keyId?: string;
  /** Build timestamp; supplied so a report can be reproduced exactly. */
  timestamp?: string;
  compilerVersion?: string;
  /** Target recorded in the report. */
  target?: string;
}

export interface StageTiming {
  stage: string;
  ms: number;
}

export interface PipelineResult {
  file: string;
  source: string;
  /** Diagnostics from the parser and checker, merged. */
  diagnostics: { errors: SunraError[]; warnings: SunraError[] };
  ast: Program;
  hir: HirModule;
  sail: ReturnType<typeof emitSail>;
  refine: ReturnType<typeof refineModule>;
  ownership: ReturnType<typeof inferOwnership>;
  mir: MirModule;
  /** MIR after optimisation, when enabled. */
  optimized: MirModule;
  /** Per-pass counters and events from the optimizer, when it ran. */
  optimizerCounts: Record<string, number> | null;
  optimizerEvents: ReturnType<typeof optimize>["events"] | null;
  mirValid: { ok: boolean; errors: ReturnType<typeof verifyModule> };
  backends: {
    llvm?: ReturnType<typeof emitLlvm>;
    cranelift?: ReturnType<typeof emitCranelift>;
    sunvm?: ReturnType<typeof compileToSunVm>;
    contract?: ReturnType<typeof emitContract>;
  };
  panic: ReturnType<typeof provePanicFreedom>;
  /** Int64 overflow warnings from the arithmetic range analysis. */
  overflow: ReturnType<typeof checkOverflow>;
  determinism: ReturnType<typeof checkDeterminism>;
  compliance: ReturnType<typeof evaluateCompliance>;
  report: BuildReport;
  timings: StageTiming[];
  /** True when nothing blocking was found anywhere in the pipeline. */
  ok: boolean;
}

export function runPipeline(
  source: string,
  file: string,
  options: PipelineOptions = {},
): PipelineResult {
  const timings: StageTiming[] = [];
  const time = <T>(stage: string, fn: () => T): T => {
    const started = performance.now();
    const value = fn();
    timings.push({ stage, ms: Math.round((performance.now() - started) * 1000) / 1000 });
    return value;
  };

  // --- front end ---------------------------------------------------------
  const tokens = time("lex", () => tokenize(source, file));
  const parsed = time("parse", () => parseRecovering(tokens));
  const checked = time("check", () => checkProgram(parsed.program));
  const errors = [...parsed.errors, ...checked.errors];

  // --- SunHIR + SAIL -----------------------------------------------------
  const hir = time("hir", () => lowerToHir(parsed.program, file));
  const sail = time("sail", () => emitSail(hir));

  // --- analyses ----------------------------------------------------------
  const refine = time("refine", () => refineModule(hir));
  const ownership = time("ownership", () => inferOwnership(hir));

  // --- SunMIR ------------------------------------------------------------
  const mir = time("mir", () => buildMir(hir, ownership));
  const optimizeEnabled = options.optimize ?? true;
  const optimizationRun = optimizeEnabled
    ? time("optimize", () => optimize(mir, { refine }))
    : null;
  const optimized = optimizationRun ? optimizationRun.module : mir;
  const verifyErrors = time("mir-verify", () => verifyModule(optimized));
  const mirValid = { ok: verifyErrors.length === 0, errors: verifyErrors };

  // --- backends ----------------------------------------------------------
  const backends: PipelineResult["backends"] = {};
  if (options.native) {
    backends.llvm = time("llvm", () => emitLlvm(optimized));
    backends.cranelift = time("cranelift", () => emitCranelift(optimized));
  }
  if (options.sunvm) {
    backends.sunvm = time("sunvm", () => compileToSunVm(optimized));
  }
  if (options.contract) {
    backends.contract = time("wasm-contract", () =>
      emitContract(optimized, { fixedPointFloats: options.contractFixedPointFloats === true }),
    );
  }

  // --- verification ------------------------------------------------------
  // The prover reads the *optimised* module so that an elided bounds check
  // counts as a discharged obligation, and reads the refinement result so it does
  // not re-derive arithmetic facts.
  const panic = time("panic-prover", () => provePanicFreedom(optimized, refine));
  const overflow = time("overflow", () => checkOverflow(optimized));
  const determinism = time("determinism", () => checkDeterminism(optimized));

  // --- compliance + report ----------------------------------------------
  const declaredRtp = collectDeclaredRtp(hir);
  // Which rule packs apply is a property of the program, not of the caller: a
  // studio writes `jurisdiction = ["MGA"]` in the game block. Reading it here
  // means the declaration selects the packs; previously every build evaluated
  // the same default set, so a real regulator and an invented one produced
  // identical results.
  const jurisdictions = options.jurisdictions ?? sourceJurisdictions(parsed.program);
  const compliance = time("compliance", () =>
    evaluateCompliance(
      {
        module: optimized,
        panic,
        determinism,
        refine,
        declaredRtp,
        measuredRtp: options.measuredRtp,
        declarations: options.declarations,
      },
      jurisdictions,
    ),
  );

  let report = time("report", () =>
    buildReport({
      sources: [{ path: file, contents: source }],
      module: optimized,
      panic,
      determinism,
      refine,
      ownership,
      compliance,
      rtp: declaredRtp.map((g) => {
        const measured = options.measuredRtp?.find((m) => m.game === g.game);
        return {
          game: g.game,
          declared: g.rtp,
          ...(measured ? { measured: measured.rtp, spins: measured.spins } : {}),
        };
      }),
      volatility: options.volatility,
      compilerVersion: options.compilerVersion ?? "sunra",
      target: options.target ?? "analysis",
      timestamp: options.timestamp ?? "1970-01-01T00:00:00.000Z",
      // The SunVM program carries a digest of its own bytes; a contract module
      // does not, so its bytes are hashed by the report instead.
      artifactDigest: backends.sunvm?.program.digest,
    }),
  );
  if (options.signingKey) {
    report = signReport(report, options.signingKey, options.keyId ?? "unnamed-key");
  }

  const ok =
    errors.length === 0 &&
    mirValid.ok &&
    ownership.errors.length === 0 &&
    panic.violations.length === 0 &&
    compliance.summary.fail === 0;

  return {
    file,
    source,
    diagnostics: { errors, warnings: checked.warnings },
    ast: parsed.program,
    hir,
    sail,
    refine,
    ownership,
    mir,
    optimized,
    optimizerCounts: optimizationRun ? optimizationRun.counts : null,
    optimizerEvents: optimizationRun ? optimizationRun.events : null,
    mirValid,
    backends,
    panic,
    overflow,
    determinism,
    compliance,
    report,
    timings,
    ok,
  };
}

/** Pull the declared RTP out of every game block in the HIR. */
function collectDeclaredRtp(hir: HirModule): Array<{ game: string; rtp: number }> {
  const out: Array<{ game: string; rtp: number }> = [];
  for (const game of hir.games) {
    const rtp = game.fields.find((f) => f.name === "rtp");
    if (!rtp) continue;
    const value = constantNumber(rtp.value);
    if (value === null) continue;
    // Games may declare either 96.5 or 0.965; normalise to a percentage.
    out.push({ game: game.name, rtp: value <= 1 ? value * 100 : value });
  }
  return out.sort((a, b) => (a.game < b.game ? -1 : 1));
}

function constantNumber(expr: unknown): number | null {
  // HIR folds literals into `Const` nodes during lowering.
  const node = expr as { kind?: string; value?: unknown };
  if (node?.kind === "Const" && typeof node.value === "number") return node.value;
  return null;
}

/**
 * Jurisdictions the program itself names, from a `game` field
 * (`jurisdiction = ["MGA", "UKGC"]` or `jurisdiction = "MGA"`) or from a
 * `#[jurisdiction("MGA")]` attribute. Names that are not recognised rule packs
 * are dropped here — `sunra check` reports them as a warning (W0702), and the
 * compliance stage cannot evaluate a pack that does not exist.
 *
 * Returns `undefined` when the program names none, which leaves the rule-pack
 * default in place.
 */
function sourceJurisdictions(program: Program): Jurisdiction[] | undefined {
  const known = new Map<string, Jurisdiction>([
    ["mga", "MGA"],
    ["ukgc", "UKGC"],
    ["gli19", "GLI-19"],
    ["gli", "GLI-19"],
  ]);
  const normalise = (name: string): Jurisdiction | null =>
    known.get(name.toLowerCase().replace(/[^a-z0-9]/g, "")) ?? null;

  const found = new Set<Jurisdiction>();

  const fromExpr = (expr: unknown) => {
    const node = expr as { kind?: string; value?: unknown; elements?: unknown[] };
    if (node?.kind === "StrLit" && typeof node.value === "string") {
      const pack = normalise(node.value);
      if (pack) found.add(pack);
      return;
    }
    if (node?.kind === "ArrayLit" && Array.isArray(node.elements)) {
      for (const element of node.elements) fromExpr(element);
    }
  };

  const fromAttributes = (attributes: Array<{ name: string; args: Record<string, unknown> }>) => {
    for (const attribute of attributes) {
      if (attribute.name !== "jurisdiction" && attribute.name !== "jurisdictions") continue;
      for (const value of Object.values(attribute.args)) fromExpr(value);
    }
  };

  for (const stmt of program.body) {
    if (stmt.kind === "GameDecl") {
      fromAttributes(stmt.attributes);
      for (const method of stmt.functions) fromAttributes(method.attributes);
      for (const field of stmt.fields) {
        if (field.name === "jurisdiction" || field.name === "jurisdictions") fromExpr(field.value);
      }
    } else if (stmt.kind === "FnDecl") {
      fromAttributes(stmt.attributes);
    }
  }

  return found.size > 0 ? [...found] : undefined;
}

export { volatilityFrom };
