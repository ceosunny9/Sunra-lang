/**
 * Regulatory rule packs: MGA, UKGC and GLI-19.
 *
 * These encode requirements that a *compiler* can actually check. The honest
 * boundary matters here, so each rule carries its own `checkable` classification:
 *
 *   - `automatic`  — the compiler decides it outright from the IR and analyses.
 *   - `assisted`   — the compiler gathers the evidence, a human signs it off.
 *   - `declared`   — the compiler can only record what the studio asserted.
 *
 * A pack that pretended to certify a game would be worse than useless: a lab
 * still has to test the build. What this produces is the *evidence bundle* the
 * lab starts from, with the automatic findings already resolved.
 *
 * Sources paraphrased (requirement intent, not verbatim text):
 *   - MGA: Malta Gaming Authority, Directive 4 of 2018 / Gaming Devices
 *     Requirements — RNG certification, RTP disclosure, player-protection limits.
 *   - UKGC: Remote Gambling and Software Technical Standards (RTS), notably
 *     RTS 2 (RNG), RTS 3 (RTP display), RTS 7/8 (session limits, reality check),
 *     RTS 12 (game fairness), RTS 14 (recovery after interruption).
 *   - GLI-19: Gaming Laboratories International Standard 19, Interactive Gaming
 *     Systems — RNG cycling, critical memory, error handling, game recall.
 */
import type { MirModule } from "../mir/mir.js";
import type { PanicProofResult } from "../verify/panic_free.js";
import type { DeterminismResult } from "../verify/determinism.js";
import type { RefineResult } from "../refine/refine.js";

export type Jurisdiction = "MGA" | "UKGC" | "GLI-19";

export type Checkability = "automatic" | "assisted" | "declared";

export type RuleStatus = "pass" | "fail" | "warn" | "manual" | "not-applicable";

export interface Rule {
  id: string;
  jurisdiction: Jurisdiction;
  /** The clause or standard section this derives from. */
  reference: string;
  title: string;
  /** What the requirement actually demands. */
  requirement: string;
  checkable: Checkability;
}

export interface RuleFinding {
  rule: Rule;
  status: RuleStatus;
  /** What the compiler observed. */
  evidence: string;
  /** What a human must still do, when anything. */
  action?: string;
}

export interface ComplianceInput {
  module: MirModule;
  panic: PanicProofResult;
  determinism: DeterminismResult;
  refine: RefineResult;
  /** Declared RTP per game, as written in the source. */
  declaredRtp: Array<{ game: string; rtp: number }>;
  /** Simulated RTP, when a simulation was run. */
  measuredRtp?: Array<{ game: string; rtp: number; spins: number }>;
  /** Studio declarations that the compiler cannot verify. */
  declarations?: {
    rngCertificate?: string;
    sessionLimits?: boolean;
    realityCheck?: boolean;
    gameRecall?: boolean;
    criticalMemoryBackup?: boolean;
    playerProtectionUi?: boolean;
  };
}

export interface ComplianceReport {
  jurisdictions: Jurisdiction[];
  findings: RuleFinding[];
  summary: Record<RuleStatus, number>;
  /** True when nothing is failing; manual items may still be outstanding. */
  clear: boolean;
  /** Rules a lab must still sign off. */
  outstanding: string[];
}

// ---------------------------------------------------------------- rule sets

export const RULES: Rule[] = [
  // --- MGA ---------------------------------------------------------------
  {
    id: "MGA-RNG-1",
    jurisdiction: "MGA",
    reference: "Gaming Devices Requirements, s.3 (RNG)",
    title: "Outcomes derive from a certified, seeded RNG",
    requirement:
      "Every game outcome must come from a random source that is certified and reproducible for audit.",
    checkable: "assisted",
  },
  {
    id: "MGA-RTP-1",
    jurisdiction: "MGA",
    reference: "Directive 4/2018, s.11 (Game information)",
    title: "Theoretical RTP is declared and within a plausible range",
    requirement:
      "The theoretical return to player must be declared per game and must be a plausible percentage.",
    checkable: "automatic",
  },
  {
    id: "MGA-RTP-2",
    jurisdiction: "MGA",
    reference: "Directive 4/2018, s.11 (Game information)",
    title: "Measured RTP corroborates the declared RTP",
    requirement:
      "Simulation must converge on the declared theoretical RTP within a documented tolerance.",
    checkable: "assisted",
  },
  {
    id: "MGA-DET-1",
    jurisdiction: "MGA",
    reference: "Gaming Devices Requirements, s.5 (Game integrity)",
    title: "Game logic is replayable for dispute resolution",
    requirement:
      "A completed round must be reproducible from stored inputs so that disputes can be resolved.",
    checkable: "automatic",
  },
  {
    id: "MGA-ERR-1",
    jurisdiction: "MGA",
    reference: "Gaming Devices Requirements, s.7 (Error handling)",
    title: "Game logic cannot abort mid-round",
    requirement:
      "The game must not terminate abnormally while a wager is in progress.",
    checkable: "automatic",
  },
  {
    id: "MGA-PP-1",
    jurisdiction: "MGA",
    reference: "Player Protection Directive, s.4",
    title: "Player-protection controls are present",
    requirement: "Deposit, loss and session controls must be available to the player.",
    checkable: "declared",
  },

  // --- UKGC --------------------------------------------------------------
  {
    id: "UKGC-RTS-2A",
    jurisdiction: "UKGC",
    reference: "RTS 2A (Random number generation)",
    title: "RNG output is unpredictable and uniformly distributed",
    requirement:
      "The RNG must be independently tested for unpredictability and uniformity.",
    checkable: "assisted",
  },
  {
    id: "UKGC-RTS-3A",
    jurisdiction: "UKGC",
    reference: "RTS 3A (Rules and RTP)",
    title: "Rules and RTP are available to the player",
    requirement: "Game rules and the theoretical RTP must be accessible before play.",
    checkable: "automatic",
  },
  {
    id: "UKGC-RTS-7A",
    jurisdiction: "UKGC",
    reference: "RTS 7A (Session limits)",
    title: "Session and spend limits are enforceable",
    requirement: "The player must be able to set limits that the game respects.",
    checkable: "declared",
  },
  {
    id: "UKGC-RTS-8A",
    jurisdiction: "UKGC",
    reference: "RTS 8A (Reality check)",
    title: "Elapsed-time reminders are supported",
    requirement: "The game must support periodic elapsed-time reminders.",
    checkable: "declared",
  },
  {
    id: "UKGC-RTS-12A",
    jurisdiction: "UKGC",
    reference: "RTS 12A (Game fairness)",
    title: "Outcome is determined before it is displayed and cannot be altered",
    requirement:
      "Once determined, an outcome must not change based on player action or elapsed time.",
    checkable: "automatic",
  },
  {
    id: "UKGC-RTS-14A",
    jurisdiction: "UKGC",
    reference: "RTS 14A (Recovery)",
    title: "An interrupted game recovers to the same state",
    requirement:
      "After an interruption the game must resume in the state it was in, or void and refund.",
    checkable: "automatic",
  },

  // --- GLI-19 ------------------------------------------------------------
  {
    id: "GLI19-3.2",
    jurisdiction: "GLI-19",
    reference: "GLI-19 s.3.2 (RNG requirements)",
    title: "RNG is seeded, cycled and scaled without bias",
    requirement:
      "Scaling an RNG value into a game range must not introduce bias; the generator must be seeded and cycled.",
    checkable: "assisted",
  },
  {
    id: "GLI19-3.4",
    jurisdiction: "GLI-19",
    reference: "GLI-19 s.3.4 (Game outcome determination)",
    title: "Outcome determination is independent of player skill display",
    requirement:
      "The outcome must be fixed at determination time and independent of presentation.",
    checkable: "automatic",
  },
  {
    id: "GLI19-4.1",
    jurisdiction: "GLI-19",
    reference: "GLI-19 s.4.1 (Critical memory)",
    title: "Critical memory is protected and recoverable",
    requirement:
      "Wager, credit and outcome state must survive a failure and be validated on restart.",
    checkable: "declared",
  },
  {
    id: "GLI19-4.4",
    jurisdiction: "GLI-19",
    reference: "GLI-19 s.4.4 (Error conditions)",
    title: "Error conditions are handled without indeterminate state",
    requirement:
      "The system must detect and handle errors without leaving a wager in an indeterminate state.",
    checkable: "automatic",
  },
  {
    id: "GLI19-5.1",
    jurisdiction: "GLI-19",
    reference: "GLI-19 s.5.1 (Game recall)",
    title: "The last rounds can be recalled in full",
    requirement:
      "The system must recall the most recent plays including wager, outcome and payout.",
    checkable: "declared",
  },
  {
    id: "GLI19-6.2",
    jurisdiction: "GLI-19",
    reference: "GLI-19 s.6.2 (Payout accuracy)",
    title: "Payout arithmetic is exact",
    requirement:
      "Payout calculation must not lose precision; monetary values must be exact.",
    checkable: "automatic",
  },
];

// ---------------------------------------------------------------- evaluation

export function evaluateCompliance(
  input: ComplianceInput,
  jurisdictions: Jurisdiction[] = ["MGA", "UKGC", "GLI-19"],
): ComplianceReport {
  const findings: RuleFinding[] = [];
  const declarations = input.declarations ?? {};

  for (const rule of RULES) {
    if (!jurisdictions.includes(rule.jurisdiction)) continue;
    findings.push(evaluateRule(rule, input, declarations));
  }

  const summary: Record<RuleStatus, number> = {
    pass: 0,
    fail: 0,
    warn: 0,
    manual: 0,
    "not-applicable": 0,
  };
  for (const finding of findings) summary[finding.status] += 1;

  return {
    jurisdictions,
    findings,
    summary,
    clear: summary.fail === 0,
    outstanding: findings
      .filter((f) => f.status === "manual" || f.status === "warn")
      .map((f) => f.rule.id),
  };
}

function evaluateRule(
  rule: Rule,
  input: ComplianceInput,
  declarations: NonNullable<ComplianceInput["declarations"]>,
): RuleFinding {
  switch (rule.id) {
    // --- RTP declaration -------------------------------------------------
    case "MGA-RTP-1":
    case "UKGC-RTS-3A": {
      if (input.declaredRtp.length === 0) {
        return {
          rule,
          status: "fail",
          evidence: "no game declares an RTP",
          action: "declare `rtp = <percentage>` in every game block",
        };
      }
      const bad = input.declaredRtp.filter((g) => g.rtp <= 0 || g.rtp > 100);
      if (bad.length > 0) {
        return {
          rule,
          status: "fail",
          evidence: `implausible RTP: ${bad.map((g) => `${g.game}=${g.rtp}`).join(", ")}`,
          action: "correct the declared RTP to a percentage between 0 and 100",
        };
      }
      const low = input.declaredRtp.filter((g) => g.rtp < 80);
      return {
        rule,
        status: low.length > 0 ? "warn" : "pass",
        evidence: `declared: ${input.declaredRtp.map((g) => `${g.game}=${g.rtp}%`).join(", ")}`,
        action:
          low.length > 0
            ? `RTP below 80% will attract scrutiny: ${low.map((g) => g.game).join(", ")}`
            : undefined,
      };
    }

    // --- Measured vs declared RTP ----------------------------------------
    case "MGA-RTP-2": {
      if (!input.measuredRtp || input.measuredRtp.length === 0) {
        return {
          rule,
          status: "manual",
          evidence: "no simulation was run in this build",
          action: "run `sunra rtp <file> --spins 10000000` and attach the result",
        };
      }
      const mismatches: string[] = [];
      for (const measured of input.measuredRtp) {
        const declared = input.declaredRtp.find((g) => g.game === measured.game);
        if (!declared) continue;
        const delta = Math.abs(measured.rtp - declared.rtp);
        // Sampling error shrinks with sqrt(n); 0.5pp at 1e6 spins is a
        // reasonable working tolerance for a build-time gate.
        const tolerance = measured.spins >= 1_000_000 ? 0.5 : 2.0;
        if (delta > tolerance) {
          mismatches.push(
            `${measured.game}: declared ${declared.rtp}%, measured ${measured.rtp.toFixed(3)}% over ${measured.spins} spins`,
          );
        }
      }
      return mismatches.length > 0
        ? {
            rule,
            status: "fail",
            evidence: mismatches.join("; "),
            action: "reconcile the paytable with the declared RTP",
          }
        : {
            rule,
            status: "pass",
            evidence: input.measuredRtp
              .map((m) => `${m.game}: ${m.rtp.toFixed(3)}% over ${m.spins} spins`)
              .join("; "),
          };
    }

    // --- Determinism / replay --------------------------------------------
    case "MGA-DET-1":
    case "UKGC-RTS-12A":
    case "GLI19-3.4": {
      // These rules ask whether a round can be re-run to the same outcome, which
      // is exactly the `replay` class. A float precision risk is a payout-accuracy
      // matter (GLI19-6.2), not a replay failure, so it must not fail these.
      const replayFindings = input.determinism.findings.filter((f) => f.severity === "replay");
      if (replayFindings.length === 0) {
        return {
          rule,
          status: input.determinism.exact ? "pass" : "warn",
          evidence: input.determinism.exact
            ? `${input.determinism.criticalFunctions.length} fairness-critical functions are replayable`
            : `replayable, but ${input.determinism.findings.length} precision risk(s) remain`,
          action: input.determinism.exact
            ? undefined
            : "move payout arithmetic to Money (fixed point) to remove cross-platform drift",
        };
      }
      const worst = replayFindings.slice(0, 3);
      return {
        rule,
        status: "fail",
        evidence: worst.map((f) => `${f.symbol}: ${f.detail}`).join("; "),
        action: "remove the non-deterministic source or move it outside the round",
      };
    }

    // --- Recovery after interruption -------------------------------------
    case "UKGC-RTS-14A": {
      // Replayability is the compiler-checkable half of recovery: if a round can
      // be recomputed from stored inputs, the server can restore it.
      if (input.determinism.findings.some((f) => f.severity === "replay")) {
        return {
          rule,
          status: "fail",
          evidence: "the round is not replayable, so an interrupted game cannot be restored exactly",
          action: "make the round deterministic first",
        };
      }
      return {
        rule,
        status: declarations.criticalMemoryBackup === true ? "pass" : "manual",
        evidence: "round logic is replayable from stored inputs",
        action:
          declarations.criticalMemoryBackup === true
            ? undefined
            : "confirm the server persists round state before displaying the outcome",
      };
    }

    // --- Abnormal termination --------------------------------------------
    case "MGA-ERR-1":
    case "GLI19-4.4": {
      const requested = input.panic.functions.filter((f) => f.requested);
      if (input.panic.violations.length > 0) {
        return {
          rule,
          status: "fail",
          evidence: input.panic.violations
            .map((v) => `${v.symbol}: ${v.reasons[0] ?? "unproven"}`)
            .join("; "),
          action: "discharge the panic obligations or drop the `#[no_panic]` claim",
        };
      }
      if (requested.length === 0) {
        return {
          rule,
          status: "warn",
          evidence: "no function claims `#[no_panic]`, so abort-freedom is unproven",
          action: "mark round-critical functions `#[no_panic]`",
        };
      }
      return {
        rule,
        status: "pass",
        evidence: `${requested.length} function(s) proven panic-free: ${requested.map((f) => f.symbol).join(", ")}`,
      };
    }

    // --- Payout precision ------------------------------------------------
    case "GLI19-6.2": {
      const floatFindings = input.determinism.findings.filter((f) => f.kind === "float-money");
      if (floatFindings.length > 0) {
        return {
          rule,
          status: "fail",
          evidence: floatFindings.map((f) => f.symbol).join(", ") + " use floating point",
          action: "use Money (fixed point) for payout arithmetic",
        };
      }
      const moneyViolations = input.refine.obligations.filter(
        (o) => o.kind === "money-negative" && o.status === "violated",
      );
      if (moneyViolations.length > 0) {
        return {
          rule,
          status: "fail",
          evidence: `${moneyViolations.length} negative-money obligation(s) proven false`,
          action: "guard the payout so it cannot go negative",
        };
      }
      return { rule, status: "pass", evidence: "payout arithmetic is exact (no float, no proven negative)" };
    }

    // --- RNG certification (assisted) ------------------------------------
    case "MGA-RNG-1":
    case "UKGC-RTS-2A":
    case "GLI19-3.2": {
      const usesRandom = input.determinism.findings.some(
        (f) => f.kind === "unseeded-random" && f.severity === "replay",
      );
      if (usesRandom) {
        return {
          rule,
          status: "fail",
          evidence: "randomness is drawn without seeding from a committed seed",
          action: "seed the generator from the committed server seed",
        };
      }
      if (declarations.rngCertificate) {
        return {
          rule,
          status: "pass",
          evidence: `RNG certificate on file: ${declarations.rngCertificate}`,
        };
      }
      return {
        rule,
        status: "manual",
        evidence: "RNG usage is seeded and replayable in this build",
        action: "attach the independent RNG test certificate",
      };
    }

    // --- Declared-only controls ------------------------------------------
    case "MGA-PP-1":
      return declaredFinding(rule, declarations.playerProtectionUi, "player-protection controls");
    case "UKGC-RTS-7A":
      return declaredFinding(rule, declarations.sessionLimits, "session and spend limits");
    case "UKGC-RTS-8A":
      return declaredFinding(rule, declarations.realityCheck, "reality-check reminders");
    case "GLI19-4.1":
      return declaredFinding(rule, declarations.criticalMemoryBackup, "critical-memory protection");
    case "GLI19-5.1":
      return declaredFinding(rule, declarations.gameRecall, "game recall");

    default:
      return {
        rule,
        status: "manual",
        evidence: "no automatic check is defined for this rule",
        action: "assess manually",
      };
  }
}

function declaredFinding(rule: Rule, declared: boolean | undefined, what: string): RuleFinding {
  if (declared === true) {
    return { rule, status: "pass", evidence: `the studio declares ${what} are implemented` };
  }
  if (declared === false) {
    return {
      rule,
      status: "fail",
      evidence: `the studio declares ${what} are NOT implemented`,
      action: `implement ${what} before submission`,
    };
  }
  return {
    rule,
    status: "manual",
    evidence: `${what} are outside the compiler's view`,
    action: `declare whether ${what} are implemented`,
  };
}

/** Pretty-print a report for a terminal. */
export function formatCompliance(report: ComplianceReport): string {
  const lines: string[] = [];
  lines.push(`Compliance: ${report.jurisdictions.join(", ")}`);
  lines.push(
    `  ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.warn} warn, ${report.summary.manual} manual`,
  );
  lines.push("");

  const order: RuleStatus[] = ["fail", "warn", "manual", "pass", "not-applicable"];
  const marks: Record<RuleStatus, string> = {
    fail: "FAIL",
    warn: "WARN",
    manual: "TODO",
    pass: " OK ",
    "not-applicable": " NA ",
  };

  for (const status of order) {
    for (const finding of report.findings.filter((f) => f.status === status)) {
      lines.push(`[${marks[status]}] ${finding.rule.id}  ${finding.rule.title}`);
      lines.push(`         ${finding.rule.reference}`);
      lines.push(`         ${finding.evidence}`);
      if (finding.action) lines.push(`         action: ${finding.action}`);
    }
  }

  return lines.join("\n");
}
