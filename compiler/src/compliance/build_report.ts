/**
 * Signed build report.
 *
 * This is the artefact an operator hands to a lab, and the artefact a lab later
 * uses to prove the binary it tested is the binary that shipped. It therefore has
 * to satisfy two awkward requirements at once:
 *
 *   1. **Reproducible.** Two builds of identical sources must produce identical
 *      reports, byte for byte, or the signature proves nothing. That rules out
 *      timestamps, absolute paths, map iteration order and floating-point
 *      formatting drift. Every collection is sorted; every number is formatted
 *      with a fixed precision; the caller supplies the timestamp explicitly.
 *   2. **Tamper-evident.** Changing any input — a paytable constant, an RTP
 *      declaration, a compiler version — must change the digest, and the
 *      signature must fail to verify if the report body is edited afterwards.
 *
 * Signing: HMAC-SHA256 over the canonical JSON body. Symmetric signing is the
 * right primitive for a build pipeline where the signer and verifier are the same
 * organisation (the operator's own CI and their own auditor). It is *not* a
 * substitute for a lab's own signature, and the report says so in
 * `signature.scope`.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MirModule } from "../mir/mir.js";
import type { PanicProofResult } from "../verify/panic_free.js";
import type { DeterminismResult } from "../verify/determinism.js";
import type { RefineResult } from "../refine/refine.js";
import type { ComplianceReport } from "./rulepacks.js";
import type { OwnershipResult } from "../own/ownership.js";

export const REPORT_VERSION = 1;

export interface VolatilityProfile {
  game: string;
  /** Standard deviation of the payout per unit staked. */
  standardDeviation: number;
  /** Common industry banding derived from the deviation. */
  band: "low" | "medium" | "medium-high" | "high" | "very-high";
  /** Hit frequency as a fraction of spins that return anything. */
  hitFrequency: number;
  /** Largest payout the paytable can produce, per unit staked. */
  maxWinMultiplier: number;
}

export interface RtpEntry {
  game: string;
  declared: number;
  measured?: number;
  spins?: number;
}

export interface VerifierArtifact {
  name: string;
  /** What the verifier concluded. */
  status: "pass" | "fail" | "partial";
  /** Digest of the verifier's own output, so it can be re-derived. */
  digest: string;
  summary: string;
}

export interface BuildReportInput {
  /** Source files, in a stable order, with their contents. */
  sources: Array<{ path: string; contents: string }>;
  module: MirModule;
  panic: PanicProofResult;
  determinism: DeterminismResult;
  refine: RefineResult;
  ownership?: OwnershipResult;
  compliance: ComplianceReport;
  rtp: RtpEntry[];
  volatility?: VolatilityProfile[];
  /** Compiler version string, recorded so a rebuild can be reproduced. */
  compilerVersion: string;
  /** Target the artefact was built for. */
  target: string;
  /**
   * Build timestamp. Supplied by the caller rather than read from the clock, so
   * a reproducibility check can pass the original value and get the same digest.
   */
  timestamp: string;
  /** Digest of the emitted artefact (wasm/js/bytecode), when one was produced. */
  artifactDigest?: string;
}

export interface BuildReport {
  reportVersion: number;
  compiler: string;
  target: string;
  timestamp: string;
  source: {
    /** Digest over every source file, path-sorted. */
    hash: string;
    files: Array<{ path: string; hash: string; bytes: number }>;
  };
  artifact: { digest: string | null };
  rtp: RtpEntry[];
  volatility: VolatilityProfile[];
  effects: {
    /** Effects declared per function, sorted. */
    declared: Array<{ fn: string; effects: string[] }>;
    /** The union of all effects the program admits. */
    union: string[];
  };
  verification: {
    panicFree: { proven: string[]; violations: Array<{ symbol: string; reasons: string[] }> };
    determinism: { deterministic: boolean; findings: Array<{ kind: string; symbol: string; detail: string }> };
    refinement: { proved: number; violated: number; unknown: number };
    ownership?: { errors: number; regions: number };
  };
  compliance: {
    jurisdictions: string[];
    summary: Record<string, number>;
    failures: Array<{ id: string; title: string; evidence: string }>;
    outstanding: string[];
  };
  verifiers: VerifierArtifact[];
  /** Digest over the canonical body above. */
  digest: string;
  signature: {
    algorithm: "HMAC-SHA256";
    /** Identifier of the key used, never the key itself. */
    keyId: string;
    value: string;
    /** What the signature does and does not attest. */
    scope: string;
  } | null;
}

/**
 * Build the report. Deterministic: same inputs -> same bytes.
 */
export function buildReport(input: BuildReportInput): BuildReport {
  const files = [...input.sources]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({
      path: file.path,
      hash: sha256(file.contents),
      bytes: Buffer.byteLength(file.contents, "utf8"),
    }));

  // Source hash covers paths as well as contents, so renaming a file changes it.
  const sourceHash = sha256(files.map((f) => `${f.path}:${f.hash}`).join("\n"));

  const declaredEffects = input.module.functions
    .map((fn) => ({ fn: fn.symbol, effects: [...fn.effects].sort() }))
    .sort((a, b) => (a.fn < b.fn ? -1 : a.fn > b.fn ? 1 : 0));
  const effectUnion = [...new Set(declaredEffects.flatMap((e) => e.effects))].sort();

  const refinementCounts = { proved: 0, violated: 0, unknown: 0 };
  for (const obligation of input.refine.obligations) {
    refinementCounts[obligation.status] += 1;
  }

  const body: Omit<BuildReport, "digest" | "signature"> = {
    reportVersion: REPORT_VERSION,
    compiler: input.compilerVersion,
    target: input.target,
    timestamp: input.timestamp,
    source: { hash: sourceHash, files },
    artifact: { digest: input.artifactDigest ?? null },
    rtp: [...input.rtp]
      .sort((a, b) => (a.game < b.game ? -1 : a.game > b.game ? 1 : 0))
      .map((entry) => ({
        game: entry.game,
        declared: round(entry.declared, 4),
        ...(entry.measured === undefined ? {} : { measured: round(entry.measured, 4) }),
        ...(entry.spins === undefined ? {} : { spins: entry.spins }),
      })),
    volatility: [...(input.volatility ?? [])]
      .sort((a, b) => (a.game < b.game ? -1 : a.game > b.game ? 1 : 0))
      .map((v) => ({
        game: v.game,
        standardDeviation: round(v.standardDeviation, 4),
        band: v.band,
        hitFrequency: round(v.hitFrequency, 6),
        maxWinMultiplier: round(v.maxWinMultiplier, 4),
      })),
    effects: { declared: declaredEffects, union: effectUnion },
    verification: {
      panicFree: {
        proven: [...input.panic.panicFree].sort(),
        violations: input.panic.violations
          .map((v) => ({ symbol: v.symbol, reasons: [...v.reasons].sort() }))
          .sort((a, b) => (a.symbol < b.symbol ? -1 : 1)),
      },
      determinism: {
        deterministic: input.determinism.deterministic,
        findings: input.determinism.findings
          .map((f) => ({ kind: f.kind, symbol: f.symbol, detail: f.detail }))
          .sort((a, b) =>
            `${a.symbol}${a.kind}` < `${b.symbol}${b.kind}` ? -1 : 1,
          ),
      },
      refinement: refinementCounts,
      ...(input.ownership
        ? {
            ownership: {
              errors: input.ownership.errors.length,
              regions: input.ownership.regions?.size ?? 0,
            },
          }
        : {}),
    },
    compliance: {
      jurisdictions: [...input.compliance.jurisdictions].sort(),
      summary: Object.fromEntries(
        Object.entries(input.compliance.summary).sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
      failures: input.compliance.findings
        .filter((f) => f.status === "fail")
        .map((f) => ({ id: f.rule.id, title: f.rule.title, evidence: f.evidence }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      outstanding: [...input.compliance.outstanding].sort(),
    },
    verifiers: buildVerifierArtifacts(input),
  };

  const digest = sha256(canonicalJson(body));
  return { ...body, digest, signature: null };
}

/**
 * Sign a report. The signature covers the canonical body *and* the digest, so
 * neither can be swapped independently.
 */
export function signReport(report: BuildReport, key: string, keyId: string): BuildReport {
  const { digest: _digest, signature: _signature, ...body } = report;
  const payload = canonicalJson(body);
  const digest = sha256(payload);
  const value = createHmac("sha256", key).update(`${digest}`).digest("hex");
  return {
    ...report,
    digest,
    signature: {
      algorithm: "HMAC-SHA256",
      keyId,
      value,
      scope:
        "attests that this report was produced by the named build pipeline from the recorded sources; it is not an independent laboratory certification",
    },
  };
}

export interface VerifyOutcome {
  valid: boolean;
  /** Why verification failed, when it did. */
  reason?: string;
}

/** Verify a signed report against the key that signed it. */
export function verifyReport(report: BuildReport, key: string): VerifyOutcome {
  if (!report.signature) return { valid: false, reason: "the report is not signed" };

  const { digest, signature, ...body } = report;
  const recomputed = sha256(canonicalJson(body));
  if (recomputed !== digest) {
    return { valid: false, reason: "the report body does not match its digest" };
  }

  const expected = createHmac("sha256", key).update(digest).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature.value, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "the signature does not match" };
  }
  return { valid: true };
}

function buildVerifierArtifacts(input: BuildReportInput): VerifierArtifact[] {
  const artifacts: VerifierArtifact[] = [];

  const panicPayload = canonicalJson({
    proven: [...input.panic.panicFree].sort(),
    violations: input.panic.violations.map((v) => v.symbol).sort(),
  });
  artifacts.push({
    name: "panic-freedom-prover",
    status: input.panic.violations.length === 0 ? "pass" : "fail",
    digest: sha256(panicPayload),
    summary: `${input.panic.panicFree.length} function(s) proven panic-free, ${input.panic.violations.length} violation(s)`,
  });

  const determinismPayload = canonicalJson({
    deterministic: input.determinism.deterministic,
    findings: input.determinism.findings.map((f) => `${f.symbol}:${f.kind}`).sort(),
  });
  artifacts.push({
    name: "determinism-checker",
    status: input.determinism.deterministic ? "pass" : "fail",
    digest: sha256(determinismPayload),
    summary: input.determinism.deterministic
      ? `${input.determinism.criticalFunctions.length} fairness-critical function(s) replayable`
      : `${input.determinism.findings.length} finding(s)`,
  });

  const counts = { proved: 0, violated: 0, unknown: 0 };
  for (const o of input.refine.obligations) counts[o.status] += 1;
  artifacts.push({
    name: "refinement-checker",
    status: counts.violated > 0 ? "fail" : counts.unknown > 0 ? "partial" : "pass",
    digest: sha256(canonicalJson(counts)),
    summary: `${counts.proved} proved, ${counts.violated} violated, ${counts.unknown} unknown`,
  });

  artifacts.push({
    name: "regulatory-rule-packs",
    status:
      input.compliance.summary.fail > 0
        ? "fail"
        : input.compliance.summary.manual > 0 || input.compliance.summary.warn > 0
          ? "partial"
          : "pass",
    digest: sha256(
      canonicalJson(
        input.compliance.findings.map((f) => `${f.rule.id}:${f.status}`).sort(),
      ),
    ),
    summary: `${input.compliance.jurisdictions.join("/")}: ${input.compliance.summary.pass} pass, ${input.compliance.summary.fail} fail, ${input.compliance.summary.manual} manual`,
  });

  return artifacts.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Canonical JSON: keys sorted at every level, no insignificant whitespace.
 * Required for a stable digest — `JSON.stringify` alone preserves insertion
 * order, which is not stable across code paths.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) out[key] = canonicalise(item);
    return out;
  }
  return value;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function round(value: number, places: number): number {
  // Fixed precision keeps the digest stable against float formatting drift.
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Derive a volatility profile from a payout sample.
 *
 * Volatility is the second moment of the payout distribution: two games with the
 * same RTP can feel completely different, and regulators as well as players ask
 * for it. Bands follow common industry usage.
 */
export function volatilityFrom(
  game: string,
  payouts: number[],
  stake = 1,
): VolatilityProfile {
  if (payouts.length === 0) {
    return {
      game,
      standardDeviation: 0,
      band: "low",
      hitFrequency: 0,
      maxWinMultiplier: 0,
    };
  }
  const normalised = payouts.map((p) => p / stake);
  const mean = normalised.reduce((a, b) => a + b, 0) / normalised.length;
  const variance =
    normalised.reduce((sum, p) => sum + (p - mean) ** 2, 0) / normalised.length;
  const sd = Math.sqrt(variance);
  const hits = normalised.filter((p) => p > 0).length;

  return {
    game,
    standardDeviation: sd,
    band: bandFor(sd),
    hitFrequency: hits / normalised.length,
    maxWinMultiplier: Math.max(...normalised),
  };
}

function bandFor(sd: number): VolatilityProfile["band"] {
  if (sd < 3) return "low";
  if (sd < 6) return "medium";
  if (sd < 10) return "medium-high";
  if (sd < 20) return "high";
  return "very-high";
}

/** Render a report for humans. */
export function formatReport(report: BuildReport): string {
  const lines: string[] = [];
  lines.push(`Sunra signed build report v${report.reportVersion}`);
  lines.push(`  compiler: ${report.compiler}`);
  lines.push(`  target:   ${report.target}`);
  lines.push(`  built:    ${report.timestamp}`);
  lines.push(`  sources:  ${report.source.files.length} file(s), hash ${report.source.hash.slice(0, 16)}…`);
  if (report.artifact.digest) {
    lines.push(`  artifact: ${report.artifact.digest.slice(0, 16)}…`);
  }
  lines.push("");

  if (report.rtp.length > 0) {
    lines.push("RTP");
    for (const entry of report.rtp) {
      const measured =
        entry.measured === undefined
          ? ""
          : ` measured ${entry.measured.toFixed(3)}%${entry.spins ? ` over ${entry.spins} spins` : ""}`;
      lines.push(`  ${entry.game}: declared ${entry.declared}%${measured}`);
    }
    lines.push("");
  }

  if (report.volatility.length > 0) {
    lines.push("Volatility");
    for (const v of report.volatility) {
      lines.push(
        `  ${v.game}: ${v.band} (sd ${v.standardDeviation.toFixed(2)}), hit ${(v.hitFrequency * 100).toFixed(2)}%, max ${v.maxWinMultiplier}x`,
      );
    }
    lines.push("");
  }

  lines.push(`Effects: ${report.effects.union.length > 0 ? report.effects.union.join(", ") : "none"}`);
  lines.push("");

  lines.push("Verifiers");
  for (const artifact of report.verifiers) {
    lines.push(`  [${artifact.status.toUpperCase().padEnd(7)}] ${artifact.name}: ${artifact.summary}`);
  }
  lines.push("");

  lines.push(
    `Compliance (${report.compliance.jurisdictions.join(", ")}): ${report.compliance.summary.pass ?? 0} pass, ${report.compliance.summary.fail ?? 0} fail, ${report.compliance.summary.manual ?? 0} manual`,
  );
  for (const failure of report.compliance.failures) {
    lines.push(`  FAIL ${failure.id}: ${failure.evidence}`);
  }
  if (report.compliance.outstanding.length > 0) {
    lines.push(`  outstanding: ${report.compliance.outstanding.join(", ")}`);
  }
  lines.push("");

  lines.push(`Digest: ${report.digest}`);
  if (report.signature) {
    lines.push(`Signature (${report.signature.algorithm}, key ${report.signature.keyId}):`);
    lines.push(`  ${report.signature.value}`);
    lines.push(`  scope: ${report.signature.scope}`);
  } else {
    lines.push("Signature: (unsigned)");
  }

  return lines.join("\n");
}
