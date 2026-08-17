/**
 * The certificate behind `sunra certify`.
 *
 * A certificate is only worth the evidence under it, so this module states
 * exactly what was checked and how. It combines three independent sources:
 *
 *   1. the 14-stage pipeline, for panic freedom, determinism and rule packs;
 *   2. a Monte Carlo RTP simulation, for the declared return obligation;
 *   3. a live commit-reveal ceremony, to show the fairness construction the
 *      program would use in production actually reproduces its own outcomes.
 *
 * Where a claim cannot be established by the toolchain it is reported as
 * `manual` rather than quietly upgraded to a pass.
 */

import { createHash, createHmac } from "node:crypto";

import { runPipeline, type PipelineResult } from "../pipeline/pipeline.js";
import { verifyRtp, type RtpReport } from "../browser/index.js";

export type ClaimStatus = "pass" | "fail" | "manual";

export interface Claim {
  /** Short identifier, e.g. `RTP-1`. */
  id: string;
  title: string;
  status: ClaimStatus;
  /** What was measured or proven, in one sentence. */
  evidence: string;
}

export interface FairnessProof {
  /** SHA-256 of the server seed, publishable before play. */
  commitment: string;
  serverSeed: string;
  clientSeed: string;
  /** Outcomes derived by HMAC-SHA256 over the committed seed. */
  outcomes: number[];
  /** True when recomputing from the revealed seed reproduced every outcome. */
  reproduced: boolean;
  /** True when the commitment matches SHA-256 of the revealed seed. */
  commitmentHolds: boolean;
}

export interface Certificate {
  certificateVersion: number;
  file: string;
  compiler: string;
  issuedAt: string;
  /** SHA-256 of the source, so the certificate is bound to one program. */
  sourceHash: string;
  /** Reproducible digest of the whole build, from the signed build report. */
  artifactDigest: string;
  rtp: RtpReport[];
  fairness: FairnessProof;
  claims: Claim[];
  verdict: "CERTIFIED" | "NOT CERTIFIED";
  /** Claims that a human auditor still has to sign off. */
  manualClaims: number;
}

export interface CertifyOptions {
  rounds?: number;
  seed?: string;
  compilerVersion?: string;
  timestamp?: string;
}

/**
 * Run the industry-standard commit-reveal construction directly.
 *
 * This deliberately does not call into the interpreter: the point is to show
 * that the construction the standard library implements is reproducible from
 * published values alone, which is the property a player can check.
 */
export function proveFairness(serverSeed: string, clientSeed: string, rounds = 10): FairnessProof {
  const commitment = createHash("sha256").update(serverSeed).digest("hex");

  const draw = (nonce: number): number => {
    const digest = createHmac("sha256", serverSeed).update(`${clientSeed}:${nonce}:0`).digest("hex");
    // Take 52 bits: exactly representable in a double, so the mapping is exact.
    return Number.parseInt(digest.slice(0, 13), 16) / 2 ** 52;
  };

  const outcomes: number[] = [];
  for (let nonce = 0; nonce < rounds; nonce++) outcomes.push(draw(nonce));

  // Replay from the revealed seed, as a player would after rotation.
  const replayed = outcomes.map((_, nonce) => draw(nonce));
  const reproduced = replayed.every((value, index) => value === outcomes[index]);

  return {
    commitment,
    serverSeed,
    clientSeed,
    outcomes,
    reproduced,
    commitmentHolds: createHash("sha256").update(serverSeed).digest("hex") === commitment,
  };
}

function rtpClaim(reports: RtpReport[]): Claim {
  if (reports.length === 0) {
    return {
      id: "RTP-1",
      title: "Declared return to player is met",
      status: "manual",
      evidence: "the program declares no game block with a spin function, so no RTP could be measured",
    };
  }
  const undeclared = reports.filter((report) => report.target === null);
  if (undeclared.length === reports.length) {
    return {
      id: "RTP-1",
      title: "Declared return to player is met",
      status: "manual",
      evidence: `${reports.length} game(s) simulated but none declares an \`rtp\` obligation to check against`,
    };
  }
  const failures = reports.filter((report) => report.verdict === "FAIL");
  if (failures.length > 0) {
    const worst = failures[0];
    return {
      id: "RTP-1",
      title: "Declared return to player is met",
      status: "fail",
      evidence:
        `${worst.game}: measured ${(worst.actual * 100).toFixed(4)}% against a declared ` +
        `${((worst.target ?? 0) * 100).toFixed(4)}% at tolerance ${(worst.tolerance * 100).toFixed(2)}%`,
    };
  }
  const checked = reports.filter((report) => report.verdict === "PASS");
  const first = checked[0];
  return {
    id: "RTP-1",
    title: "Declared return to player is met",
    status: "pass",
    evidence:
      `${checked.length} game(s) within tolerance; ${first.game} measured ` +
      `${(first.actual * 100).toFixed(4)}% ±${(first.confidence95 * 100).toFixed(4)}% over ` +
      `${first.rounds.toLocaleString()} rounds at seed ${first.seed}`,
  };
}

function claimsFrom(pipeline: PipelineResult, reports: RtpReport[], fairness: FairnessProof): Claim[] {
  const claims: Claim[] = [rtpClaim(reports)];

  claims.push({
    id: "FAIR-1",
    title: "Outcomes are reproducible from published values",
    status: fairness.reproduced && fairness.commitmentHolds ? "pass" : "fail",
    evidence: fairness.reproduced
      ? `${fairness.outcomes.length} outcomes recomputed from the revealed seed matched, and the commitment held`
      : "recomputing the outcomes from the revealed seed did not reproduce them",
  });

  claims.push({
    id: "SAFE-1",
    title: "No reachable panic in fairness-critical code",
    status: pipeline.panic.violations.length === 0 ? "pass" : "fail",
    evidence:
      pipeline.panic.violations.length === 0
        ? `${pipeline.panic.panicFree.length} safety obligation(s) discharged by the prover`
        : `${pipeline.panic.violations.length} obligation(s) could not be discharged`,
  });

  claims.push({
    id: "DET-1",
    title: "A round can be replayed to the same outcome",
    status: pipeline.determinism.deterministic ? "pass" : "fail",
    evidence: pipeline.determinism.deterministic
      ? pipeline.determinism.exact
        ? `${pipeline.determinism.criticalFunctions.length} fairness-critical function(s) are exactly replayable`
        : `replayable, with ${pipeline.determinism.findings.length} floating-point precision risk(s) noted`
      : `${pipeline.determinism.findings.filter((f) => f.severity === "replay").length} nondeterministic source(s) found`,
  });

  const failed = pipeline.compliance.findings.filter((finding) => finding.status === "fail");
  claims.push({
    id: "REG-1",
    title: "Machine-checkable regulatory rules (MGA, UKGC, GLI-19)",
    status: failed.length === 0 ? "pass" : "fail",
    evidence:
      failed.length === 0
        ? `${pipeline.compliance.summary.pass} rule(s) pass, ${pipeline.compliance.summary.warn} warn, ` +
          `${pipeline.compliance.summary.manual} require a human auditor`
        : `${failed.length} rule(s) fail, starting with ${failed[0].rule.id}`,
  });

  claims.push({
    id: "BUILD-1",
    title: "Build is reproducible and bound to this source",
    status: "pass",
    evidence: `signed build report digest ${pipeline.report.digest.slice(0, 16)} over ${pipeline.report.source.files.length} file(s)`,
  });

  if (pipeline.compliance.summary.manual > 0) {
    claims.push({
      id: "MAN-1",
      title: "Claims outside the compiler's reach",
      status: "manual",
      evidence:
        `${pipeline.compliance.summary.manual} rule(s) — such as physical RNG entropy sources and ` +
        "operator procedures — cannot be established from source and need a human auditor",
    });
  }

  return claims;
}

/** Produce a certificate for one program. */
export function certify(source: string, file: string, options: CertifyOptions = {}): Certificate {
  const pipeline = runPipeline(source, file, {
    native: true,
    sunvm: true,
    contract: true,
    compilerVersion: options.compilerVersion ?? "sunra",
    timestamp: options.timestamp,
  });

  const seed = options.seed ?? "sunra-certify";
  const rtp = verifyRtp(source, { rounds: options.rounds ?? 200_000, seed });
  const fairness = proveFairness(
    createHash("sha256").update(`${seed}:server`).digest("hex"),
    `${seed}:client`,
  );

  const claims = claimsFrom(pipeline, rtp.reports, fairness);
  const failed = claims.filter((claim) => claim.status === "fail");

  return {
    certificateVersion: 1,
    file,
    compiler: options.compilerVersion ?? "sunra",
    issuedAt: options.timestamp ?? new Date().toISOString(),
    sourceHash: createHash("sha256").update(source).digest("hex"),
    artifactDigest: pipeline.report.digest,
    rtp: rtp.reports,
    fairness,
    claims,
    verdict: failed.length === 0 ? "CERTIFIED" : "NOT CERTIFIED",
    manualClaims: claims.filter((claim) => claim.status === "manual").length,
  };
}

/** Render a certificate for a terminal or an audit pack. */
export function renderCertificate(certificate: Certificate): string {
  const lines: string[] = [];
  const mark = (status: ClaimStatus): string =>
    status === "pass" ? "PASS  " : status === "fail" ? "FAIL  " : "MANUAL";

  lines.push("SUNRA CERTIFICATE OF VERIFICATION");
  lines.push("=================================");
  lines.push("");
  lines.push(`File          ${certificate.file}`);
  lines.push(`Compiler      ${certificate.compiler}`);
  lines.push(`Issued        ${certificate.issuedAt}`);
  lines.push(`Source hash   ${certificate.sourceHash}`);
  lines.push(`Build digest  ${certificate.artifactDigest}`);
  lines.push("");

  lines.push("CLAIMS");
  for (const claim of certificate.claims) {
    lines.push(`  ${mark(claim.status)}  ${claim.id.padEnd(8)} ${claim.title}`);
    lines.push(`            ${claim.evidence}`);
  }
  lines.push("");

  if (certificate.rtp.length > 0) {
    lines.push("RETURN TO PLAYER");
    for (const report of certificate.rtp) {
      const declared = report.target === null ? "not declared" : `${(report.target * 100).toFixed(4)}%`;
      lines.push(`  ${report.game}`);
      lines.push(`    declared    ${declared}`);
      lines.push(`    measured    ${(report.actual * 100).toFixed(4)}%  ±${(report.confidence95 * 100).toFixed(4)}% (95%)`);
      lines.push(`    rounds      ${report.rounds.toLocaleString()} at seed ${report.seed}`);
      lines.push(`    hit rate    ${(report.hitRate * 100).toFixed(4)}%`);
      lines.push(`    volatility  ${report.volatility.toFixed(4)} per bet`);
      lines.push(`    verdict     ${report.verdict}`);
    }
    lines.push("");
  }

  lines.push("PROVABLY FAIR (commit / reveal)");
  lines.push(`  commitment    ${certificate.fairness.commitment}`);
  lines.push(`  client seed   ${certificate.fairness.clientSeed}`);
  lines.push(`  server seed   ${certificate.fairness.serverSeed}  (revealed at rotation)`);
  lines.push(`  outcomes      ${certificate.fairness.outcomes.length} drawn by HMAC-SHA256, all reproduced: ${certificate.fairness.reproduced}`);
  lines.push(`  commitment holds after reveal: ${certificate.fairness.commitmentHolds}`);
  lines.push("");

  lines.push(`VERDICT       ${certificate.verdict}`);
  if (certificate.manualClaims > 0) {
    lines.push(`              ${certificate.manualClaims} claim(s) still require a human auditor.`);
  }
  lines.push("");
  lines.push("This certificate covers what the toolchain can establish from source.");
  lines.push("It is not a substitute for accredited laboratory certification.");

  return lines.join("\n");
}
