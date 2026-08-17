#!/usr/bin/env node
/**
 * Regulatory rule pack and signed build report tests.
 *
 * The report's whole purpose is to be trustworthy, which means two properties
 * have to hold no matter what: identical inputs must produce an identical digest
 * (otherwise a signature proves nothing), and any edit to the body must break
 * verification (otherwise it is not tamper-evident). Both are tested directly,
 * along with the rule packs' ability to fail a build for real reasons.
 */
import assert from 'node:assert/strict';
import { tokenize } from '../dist/lexer/lexer.js';
import { parse } from '../dist/parser/parser.js';
import { lowerToHir } from '../dist/hir/lower.js';
import { inferOwnership } from '../dist/own/ownership.js';
import { refineModule } from '../dist/refine/refine.js';
import { buildMir } from '../dist/mir/build.js';
import { provePanicFreedom } from '../dist/verify/panic_free.js';
import { checkDeterminism } from '../dist/verify/determinism.js';
import { evaluateCompliance, formatCompliance, RULES } from '../dist/compliance/rulepacks.js';
import {
  buildReport,
  signReport,
  verifyReport,
  canonicalJson,
  volatilityFrom,
  formatReport,
} from '../dist/compliance/build_report.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL  ${name}`); console.error(error instanceof Error ? error.stack ?? error.message : String(error)); }
}

const CLEAN_SOURCE = `
game Lucky {
  reel symbols = ["A", "B", "C"]
  rtp = 96.5

  #[no_panic]
  fn payout(bet: Int, mult: Int) -> Int {
    return bet * mult
  }
}

#[no_panic]
fn spin(bet: Int) -> Int {
  return bet * 2
}

fn main() uses io {
  print(spin(10))
}
`;

function analyse(source, { declaredRtp = [{ game: 'Lucky', rtp: 96.5 }] } = {}) {
  const program = parse(tokenize(source, 'game.sun'));
  const hir = lowerToHir(program, 'game.sun');
  const refine = refineModule(hir);
  const ownership = inferOwnership(hir);
  const module = buildMir(hir, ownership);
  const panic = provePanicFreedom(module, refine);
  const determinism = checkDeterminism(module);
  return { module, refine, ownership, panic, determinism, declaredRtp, source };
}

function complianceOf(source, extra = {}) {
  const a = analyse(source, extra);
  return evaluateCompliance(
    {
      module: a.module,
      panic: a.panic,
      determinism: a.determinism,
      refine: a.refine,
      declaredRtp: extra.declaredRtp ?? a.declaredRtp,
      measuredRtp: extra.measuredRtp,
      declarations: extra.declarations,
    },
    extra.jurisdictions,
  );
}

function reportFor(source, extra = {}) {
  const a = analyse(source, extra);
  const compliance = evaluateCompliance({
    module: a.module,
    panic: a.panic,
    determinism: a.determinism,
    refine: a.refine,
    declaredRtp: extra.declaredRtp ?? a.declaredRtp,
    measuredRtp: extra.measuredRtp,
    declarations: extra.declarations,
  });
  return buildReport({
    sources: [{ path: 'game.sun', contents: source }],
    module: a.module,
    panic: a.panic,
    determinism: a.determinism,
    refine: a.refine,
    ownership: a.ownership,
    compliance,
    rtp: (extra.declaredRtp ?? a.declaredRtp).map((g) => ({ game: g.game, declared: g.rtp })),
    volatility: extra.volatility,
    compilerVersion: 'sunra 0.9.0',
    target: 'wasm',
    timestamp: '2026-01-01T00:00:00.000Z',
    artifactDigest: extra.artifactDigest,
  });
}

// ------------------------------------------------------------ rule packs

test('rulepacks: all three jurisdictions are represented', () => {
  const jurisdictions = new Set(RULES.map((r) => r.jurisdiction));
  assert.ok(jurisdictions.has('MGA'));
  assert.ok(jurisdictions.has('UKGC'));
  assert.ok(jurisdictions.has('GLI-19'));
  // Every rule must cite a source and classify its own checkability, or the
  // report would imply more certainty than the compiler has.
  for (const rule of RULES) {
    assert.ok(rule.reference.length > 0, `${rule.id} has no reference`);
    assert.ok(['automatic', 'assisted', 'declared'].includes(rule.checkable), rule.id);
  }
});

test('rulepacks: a clean deterministic game has no failures', () => {
  const report = complianceOf(CLEAN_SOURCE);
  assert.equal(report.summary.fail, 0, JSON.stringify(report.findings.filter((f) => f.status === 'fail'), null, 1));
  assert.equal(report.clear, true);
  // Declared-only rules must remain outstanding rather than silently passing.
  assert.ok(report.outstanding.length > 0, 'declared rules should stay outstanding');
});

test('rulepacks: a missing RTP declaration fails', () => {
  const report = complianceOf(CLEAN_SOURCE, { declaredRtp: [] });
  const rtpRule = report.findings.find((f) => f.rule.id === 'MGA-RTP-1');
  assert.equal(rtpRule.status, 'fail');
  assert.equal(report.clear, false);
});

test('rulepacks: an implausible RTP fails', () => {
  const report = complianceOf(CLEAN_SOURCE, { declaredRtp: [{ game: 'Lucky', rtp: 250 }] });
  assert.equal(report.findings.find((f) => f.rule.id === 'MGA-RTP-1').status, 'fail');
});

test('rulepacks: a low RTP warns without failing', () => {
  const report = complianceOf(CLEAN_SOURCE, { declaredRtp: [{ game: 'Lucky', rtp: 60 }] });
  const finding = report.findings.find((f) => f.rule.id === 'MGA-RTP-1');
  assert.equal(finding.status, 'warn');
  assert.equal(report.clear, true, 'a warning must not fail the build');
});

test('rulepacks: measured RTP far from declared fails', () => {
  const report = complianceOf(CLEAN_SOURCE, {
    measuredRtp: [{ game: 'Lucky', rtp: 91.0, spins: 2_000_000 }],
  });
  const finding = report.findings.find((f) => f.rule.id === 'MGA-RTP-2');
  assert.equal(finding.status, 'fail');
  assert.match(finding.evidence, /declared 96.5%/);
});

test('rulepacks: measured RTP within tolerance passes', () => {
  const report = complianceOf(CLEAN_SOURCE, {
    measuredRtp: [{ game: 'Lucky', rtp: 96.42, spins: 2_000_000 }],
  });
  assert.equal(report.findings.find((f) => f.rule.id === 'MGA-RTP-2').status, 'pass');
});

test('rulepacks: sampling tolerance is looser for small samples', () => {
  const small = complianceOf(CLEAN_SOURCE, {
    measuredRtp: [{ game: 'Lucky', rtp: 95.2, spins: 1000 }],
  });
  const large = complianceOf(CLEAN_SOURCE, {
    measuredRtp: [{ game: 'Lucky', rtp: 95.2, spins: 5_000_000 }],
  });
  assert.equal(small.findings.find((f) => f.rule.id === 'MGA-RTP-2').status, 'pass');
  assert.equal(large.findings.find((f) => f.rule.id === 'MGA-RTP-2').status, 'fail');
});

test('rulepacks: non-determinism fails the fairness and recovery rules', () => {
  const report = complianceOf(`
game Lucky {
  rtp = 96.5
}

fn spin() -> Int uses time {
  return Timer.now()
}

fn main() uses io, time {
  print(spin())
}
`);
  assert.equal(report.findings.find((f) => f.rule.id === 'MGA-DET-1').status, 'fail');
  assert.equal(report.findings.find((f) => f.rule.id === 'UKGC-RTS-12A').status, 'fail');
  assert.equal(report.findings.find((f) => f.rule.id === 'UKGC-RTS-14A').status, 'fail');
  assert.equal(report.clear, false);
});

test('rulepacks: an unproven #[no_panic] fails the error-handling rules', () => {
  const report = complianceOf(`
game Lucky {
  rtp = 96.5
}

#[no_panic]
fn spin(bet: Int, div: Int) -> Int {
  return bet / div
}

fn main() uses io {
  print(spin(10, 2))
}
`);
  assert.equal(report.findings.find((f) => f.rule.id === 'MGA-ERR-1').status, 'fail');
  assert.equal(report.findings.find((f) => f.rule.id === 'GLI19-4.4').status, 'fail');
});

test('rulepacks: float payout maths fails GLI-19 payout accuracy', () => {
  const report = complianceOf(`
game Lucky {
  rtp = 96.5
}

fn spin(bet: Float) -> Float {
  return bet * 1.5
}

fn main() uses io {
  print(spin(2.0))
}
`);
  assert.equal(report.findings.find((f) => f.rule.id === 'GLI19-6.2').status, 'fail');
});

test('rulepacks: an explicit false declaration fails rather than staying manual', () => {
  const manual = complianceOf(CLEAN_SOURCE);
  const denied = complianceOf(CLEAN_SOURCE, { declarations: { sessionLimits: false } });
  const granted = complianceOf(CLEAN_SOURCE, { declarations: { sessionLimits: true } });
  assert.equal(manual.findings.find((f) => f.rule.id === 'UKGC-RTS-7A').status, 'manual');
  assert.equal(denied.findings.find((f) => f.rule.id === 'UKGC-RTS-7A').status, 'fail');
  assert.equal(granted.findings.find((f) => f.rule.id === 'UKGC-RTS-7A').status, 'pass');
});

test('rulepacks: jurisdictions can be selected individually', () => {
  const ukOnly = complianceOf(CLEAN_SOURCE, { jurisdictions: ['UKGC'] });
  assert.ok(ukOnly.findings.every((f) => f.rule.jurisdiction === 'UKGC'));
  assert.ok(ukOnly.findings.length > 0);
});

test('rulepacks: the formatted output lists failures first', () => {
  const report = complianceOf(CLEAN_SOURCE, { declaredRtp: [] });
  const text = formatCompliance(report);
  assert.match(text, /Compliance: /);
  const firstFail = text.indexOf('[FAIL]');
  const firstOk = text.indexOf('[ OK ]');
  assert.ok(firstFail >= 0 && (firstOk < 0 || firstFail < firstOk), 'failures must come first');
});

// --------------------------------------------------------- build report

test('report: contains RTP, effects, source hash and verifier artifacts', () => {
  const report = reportFor(CLEAN_SOURCE);
  assert.equal(report.reportVersion, 1);
  assert.equal(report.source.files.length, 1);
  assert.match(report.source.hash, /^[0-9a-f]{64}$/);
  assert.equal(report.rtp[0].game, 'Lucky');
  assert.ok(report.effects.union.includes('io'));
  const names = report.verifiers.map((v) => v.name);
  assert.deepEqual(names, [
    'determinism-checker',
    'panic-freedom-prover',
    'refinement-checker',
    'regulatory-rule-packs',
  ]);
  assert.match(report.digest, /^[0-9a-f]{64}$/);
  assert.equal(report.signature, null);
});

test('report: identical inputs produce an identical digest', () => {
  const a = reportFor(CLEAN_SOURCE);
  const b = reportFor(CLEAN_SOURCE);
  assert.equal(a.digest, b.digest);
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test('report: changing a single source character changes the digest', () => {
  const a = reportFor(CLEAN_SOURCE);
  const b = reportFor(CLEAN_SOURCE.replace('bet * 2', 'bet * 3'));
  assert.notEqual(a.source.hash, b.source.hash);
  assert.notEqual(a.digest, b.digest);
});

test('report: changing only the declared RTP changes the digest', () => {
  const a = reportFor(CLEAN_SOURCE);
  const b = reportFor(CLEAN_SOURCE, { declaredRtp: [{ game: 'Lucky', rtp: 94.0 }] });
  assert.notEqual(a.digest, b.digest);
});

test('report: a signature verifies with the right key and fails with the wrong one', () => {
  const signed = signReport(reportFor(CLEAN_SOURCE), 'build-key-secret', 'ci-2026-01');
  assert.equal(signed.signature.algorithm, 'HMAC-SHA256');
  assert.equal(signed.signature.keyId, 'ci-2026-01');
  assert.equal(verifyReport(signed, 'build-key-secret').valid, true);
  const wrong = verifyReport(signed, 'other-key');
  assert.equal(wrong.valid, false);
  assert.match(wrong.reason, /signature does not match/);
});

test('report: editing the body after signing breaks verification', () => {
  const signed = signReport(reportFor(CLEAN_SOURCE), 'k', 'key-1');
  const tampered = { ...signed, rtp: [{ game: 'Lucky', declared: 99.9 }] };
  const outcome = verifyReport(tampered, 'k');
  assert.equal(outcome.valid, false);
  assert.match(outcome.reason, /does not match its digest/);
});

test('report: an unsigned report is reported as unsigned, not invalid-signature', () => {
  const outcome = verifyReport(reportFor(CLEAN_SOURCE), 'k');
  assert.equal(outcome.valid, false);
  assert.match(outcome.reason, /not signed/);
});

test('report: signing is stable across runs for the same report', () => {
  const a = signReport(reportFor(CLEAN_SOURCE), 'k', 'key-1');
  const b = signReport(reportFor(CLEAN_SOURCE), 'k', 'key-1');
  assert.equal(a.signature.value, b.signature.value);
});

test('report: the signature scope disclaims lab certification', () => {
  const signed = signReport(reportFor(CLEAN_SOURCE), 'k', 'key-1');
  assert.match(signed.signature.scope, /not an independent laboratory certification/);
});

test('report: canonical JSON sorts keys at every level', () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":3,"d":2},"b":1}');
});

test('report: verification results carry through from the analyses', () => {
  const report = reportFor(CLEAN_SOURCE);
  assert.ok(report.verification.panicFree.proven.includes('spin'));
  assert.deepEqual(report.verification.panicFree.violations, []);
  assert.equal(report.verification.determinism.deterministic, true);
  assert.equal(typeof report.verification.refinement.proved, 'number');
  assert.ok(report.verification.ownership);
});

test('report: compliance failures are surfaced in the report body', () => {
  const report = reportFor(CLEAN_SOURCE, { declaredRtp: [] });
  assert.ok(report.compliance.failures.length > 0);
  assert.ok(report.compliance.failures.some((f) => f.id === 'MGA-RTP-1'));
});

test('report: volatility is derived from a payout sample', () => {
  // 1 in 10 spins pays 20x, the rest pay nothing: mean 2.0, high variance.
  const payouts = [20, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const profile = volatilityFrom('Lucky', payouts);
  assert.equal(profile.game, 'Lucky');
  assert.equal(profile.hitFrequency, 0.1);
  assert.equal(profile.maxWinMultiplier, 20);
  assert.ok(profile.standardDeviation > 5, `sd was ${profile.standardDeviation}`);
  assert.ok(['medium-high', 'high', 'very-high'].includes(profile.band), profile.band);
});

test('report: a flat paytable is banded as low volatility', () => {
  const profile = volatilityFrom('Flat', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(profile.band, 'low');
  assert.equal(profile.standardDeviation, 0);
  assert.equal(profile.hitFrequency, 1);
});

test('report: volatility values survive into the report deterministically', () => {
  const volatility = [volatilityFrom('Lucky', [20, 0, 0, 0, 0, 0, 0, 0, 0, 0])];
  const a = reportFor(CLEAN_SOURCE, { volatility });
  const b = reportFor(CLEAN_SOURCE, { volatility });
  assert.equal(a.digest, b.digest);
  assert.equal(a.volatility[0].band, volatility[0].band);
});

test('report: the artifact digest is recorded when supplied', () => {
  const withArtifact = reportFor(CLEAN_SOURCE, { artifactDigest: 'a'.repeat(64) });
  const without = reportFor(CLEAN_SOURCE);
  assert.equal(withArtifact.artifact.digest, 'a'.repeat(64));
  assert.equal(without.artifact.digest, null);
  assert.notEqual(withArtifact.digest, without.digest);
});

test('report: the human-readable rendering includes the key sections', () => {
  const text = formatReport(signReport(reportFor(CLEAN_SOURCE), 'k', 'key-1'));
  assert.match(text, /Sunra signed build report v1/);
  assert.match(text, /RTP/);
  assert.match(text, /Verifiers/);
  assert.match(text, /Compliance/);
  assert.match(text, /Digest: [0-9a-f]{64}/);
  assert.match(text, /Signature \(HMAC-SHA256, key key-1\)/);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
