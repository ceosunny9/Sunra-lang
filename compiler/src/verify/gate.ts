/**
 * The verification gate.
 *
 * The refinement checker, the panic-freedom prover, the determinism checker and
 * the compliance packs each produce a rich result object. Until this file existed
 * those results were only ever *reported*, never *enforced*: a program with a
 * proven division by zero under `#[no_panic]`, or an argument that provably
 * violates a `where` clause, still passed `sunra check` with exit code 0.
 *
 * This module converts those findings into ordinary Sunra diagnostics so a
 * single rule applies everywhere: an error fails the build, a warning does not.
 *
 * Severity policy, and why:
 *
 *   - A *proven* refinement violation is an error. The analysis is not guessing;
 *     it has shown the value cannot satisfy the predicate.
 *   - An *undecided* obligation is not reported here at all. Reporting every
 *     unknown would make the checker unusable on real code, and the pipeline
 *     report already lists them.
 *   - A `#[no_panic]` function with an undischarged panic site is an error,
 *     because the attribute is a promise the compiler is being asked to keep.
 *   - Nondeterminism in game logic is a warning: it is a correctness smell that a
 *     studio may legitimately accept in non-payout code.
 *   - An unrecognised jurisdiction is a warning: the list of regulators is a
 *     matter of fact, not of language semantics, and it changes over time.
 */
import { verifyError, type SunraError, type Span } from "../diagnostics.js";
import type { RefineResult } from "../refine/refine.js";
import type { PanicProofResult } from "./panic_free.js";
import type { DeterminismResult } from "./determinism.js";

/** Codes used by the gate, kept together so they are easy to document. */
export const VERIFY_CODES = {
  refinementViolated: "E0701",
  noPanicViolated: "E0702",
  nondeterminism: "W0701",
  unknownJurisdiction: "W0702",
} as const;

export interface GateInput {
  refine?: RefineResult | null;
  panic?: PanicProofResult | null;
  determinism?: DeterminismResult | null;
  /** Jurisdictions named by the source, e.g. from `#[jurisdiction(...)]`. */
  jurisdictions?: Array<{ name: string; span: Span | null }>;
}

/**
 * Jurisdictions the toolchain recognises.
 *
 * Membership means "this regulator exists and Sunra knows the name", not "this
 * build is licensed there". Anything outside the list is almost always a typo or
 * an invented authority, so it is worth flagging before it reaches a submission.
 */
export const KNOWN_JURISDICTIONS = new Map<string, string>([
  ["MGA", "Malta Gaming Authority"],
  ["UKGC", "UK Gambling Commission"],
  ["GLI-19", "Gaming Laboratories International, standard 19"],
  ["GLI", "Gaming Laboratories International"],
  ["CURACAO", "Curaçao Gaming Control Board"],
  ["ISLE_OF_MAN", "Isle of Man Gambling Supervision Commission"],
  ["GIBRALTAR", "Gibraltar Licensing Authority"],
  ["ALDERNEY", "Alderney Gambling Control Commission"],
  ["KAHNAWAKE", "Kahnawàke Gaming Commission"],
  ["TOBIQUE", "Tobique Gaming Commission"],
  ["ANJOUAN", "Anjouan Offshore Finance Authority"],
  ["PAGCOR", "Philippine Amusement and Gaming Corporation"],
  ["DGOJ", "Dirección General de Ordenación del Juego (Spain)"],
  ["ANJ", "Autorité Nationale des Jeux (France)"],
  ["GGL", "Gemeinsame Glücksspielbehörde der Länder (Germany)"],
  ["AGCO", "Alcohol and Gaming Commission of Ontario"],
  ["ACMA", "Australian Communications and Media Authority"],
  ["NJDGE", "New Jersey Division of Gaming Enforcement"],
  ["MGCB", "Michigan Gaming Control Board"],
  ["NGCB", "Nevada Gaming Control Board"],
  ["SPELINSPEKTIONEN", "Swedish Gambling Authority"],
  ["KSA", "Kansspelautoriteit (Netherlands)"],
  ["MAMS", "Malta Digital Innovation Authority"],
  ["ROMANIA_ONJN", "Oficiul Naţional pentru Jocuri de Noroc (Romania)"],
]);

/** Normalise a jurisdiction name for lookup: case and separators do not matter. */
export function normaliseJurisdiction(name: string): string {
  return name.trim().toUpperCase().replace(/[\s.]+/g, "_").replace(/-+/g, "-");
}

export function isKnownJurisdiction(name: string): boolean {
  const key = normaliseJurisdiction(name);
  if (KNOWN_JURISDICTIONS.has(key)) return true;
  // `GLI-19`, `GLI_19` and `GLI19` all name the same standard.
  const collapsed = key.replace(/[-_]/g, "");
  for (const known of KNOWN_JURISDICTIONS.keys()) {
    if (known.replace(/[-_]/g, "") === collapsed) return true;
  }
  return false;
}

/** Suggest the closest recognised jurisdiction, for the diagnostic hint. */
function closestJurisdiction(name: string): string | null {
  const key = normaliseJurisdiction(name).replace(/[-_]/g, "");
  let best: { name: string; score: number } | null = null;
  for (const known of KNOWN_JURISDICTIONS.keys()) {
    const candidate = known.replace(/[-_]/g, "");
    let shared = 0;
    for (let i = 0; i < Math.min(candidate.length, key.length); i++) {
      if (candidate[i] === key[i]) shared++;
      else break;
    }
    if (shared >= 2 && (best === null || shared > best.score)) {
      best = { name: known, score: shared };
    }
  }
  return best?.name ?? null;
}

/**
 * Turn verification results into diagnostics.
 *
 * Errors and warnings are returned together; callers filter by severity.
 */
export function gateDiagnostics(input: GateInput): SunraError[] {
  const out: SunraError[] = [];

  // --- refinement violations ------------------------------------------------
  for (const obligation of input.refine?.obligations ?? []) {
    if (obligation.status !== "violated") continue;

    // The panic-freedom section reports the arithmetic traps with a better
    // message, so only refinement-specific obligations are surfaced here.
    if (obligation.kind === "division-by-zero" || obligation.kind === "modulo-by-zero") continue;

    const hint =
      obligation.kind === "refinement-precondition"
        ? "pass a value that satisfies the `where` clause, or widen the refinement"
        : obligation.kind === "index-out-of-bounds" || obligation.kind === "negative-index"
          ? "guard the index against the collection length before the access"
          : "adjust the value so the declared refinement can hold";

    out.push(
      verifyError(
        VERIFY_CODES.refinementViolated,
        `refine.${obligation.kind}`,
        `${obligation.claim}, but ${obligation.reason}`,
        obligation.span,
        hint,
      ),
    );
  }

  // --- `#[no_panic]` violations --------------------------------------------
  for (const fn of input.panic?.functions ?? []) {
    if (!fn.requested || fn.proven) continue;
    const undischarged = fn.sites.filter((s) => !s.discharged);
    const site = undischarged[0];
    const detail =
      undischarged.length > 1
        ? `${undischarged.length} sites, starting with ${site.kind}`
        : (site?.kind ?? "an undischarged obligation");
    out.push(
      verifyError(
        VERIFY_CODES.noPanicViolated,
        "verify.no_panic",
        `\`${fn.symbol}\` declares #[no_panic] but may panic: ${detail}${site ? ` — ${site.detail}` : ""}`,
        site?.span ?? null,
        "guard the operation, or remove the `#[no_panic]` attribute",
      ),
    );
  }

  // --- determinism ---------------------------------------------------------
  for (const finding of input.determinism?.findings ?? []) {
    if (finding.severity !== "replay") continue;
    out.push(
      verifyError(
        VERIFY_CODES.nondeterminism,
        `verify.determinism.${finding.kind}`,
        `\`${finding.symbol}\` is not replayable: ${finding.detail}`,
        finding.span ?? null,
        finding.kind === "unseeded-random"
          ? "draw from a seeded generator so a round can be replayed"
          : "move the nondeterministic call out of game logic",
        "warning",
      ),
    );
  }

  // --- jurisdictions -------------------------------------------------------
  for (const declared of input.jurisdictions ?? []) {
    if (isKnownJurisdiction(declared.name)) continue;
    const suggestion = closestJurisdiction(declared.name);
    out.push(
      verifyError(
        VERIFY_CODES.unknownJurisdiction,
        "compliance.jurisdiction.unknown",
        `\`${declared.name}\` is not a jurisdiction the toolchain recognises`,
        declared.span,
        suggestion
          ? `did you mean \`${suggestion}\`?`
          : `known jurisdictions include ${[...KNOWN_JURISDICTIONS.keys()].slice(0, 6).join(", ")}`,
        "warning",
      ),
    );
  }

  return out;
}

