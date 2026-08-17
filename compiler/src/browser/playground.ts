/**
 * The playground model.
 *
 * The browser facade in `./index.ts` already exposes `analyze`, `run`, `test` and
 * `verifyRtp`. What a playground needs on top of that is everything around the
 * editor: a catalogue of examples to open, a way to put a program in a URL so it
 * can be shared, and one call that produces exactly what the output panel should
 * display — diagnostics, printed lines, test results and timings together, rather
 * than four separate calls the UI has to stitch back together.
 *
 * This module is deliberately free of DOM and Node APIs so it runs in the browser
 * bundle, in a worker, and in tests.
 */

import { analyze, run, test, verifyRtp, VERSION, type BrowserDiagnostic } from "./index.js";
import { listTemplates } from "../stdlib/templates.js";

// ------------------------------------------------------------------ examples

export interface PlaygroundExample {
  /** Stable slug, safe in a URL. */
  id: string;
  title: string;
  /** One line explaining what the example demonstrates. */
  blurb: string;
  group: "basics" | "gaming" | "assurance" | "templates";
  source: string;
}

const HELLO = `# The smallest complete Sunra program.
#
# \`uses io\` is not decoration: printing is an effect, and a function that does
# not declare it provably cannot print. That is what makes a payout function
# auditable.

fn main() uses io {
    let greeting = "Hello, Sunra!"
    print(greeting)
}
`;

const VALUES = `# Values, collections and string interpolation.

fn main() uses io {
    let symbols = ["cherry", "lemon", "star", "seven"]
    print("reel has {symbols.len()} symbols")
    print("first {symbols.first()}, last {symbols.last()}")
    print("sorted {symbols.sort()}")

    var total = 0
    for i in 1..6 {
        total = total + i * i
    }
    print("sum of squares 1..5 = {total}")

    let label = "  Solar Fortune  "
    print("trimmed '{label.trim()}' upper '{label.trim().upper()}'")
}
`;

const EFFECTS = `# Effects are inferred and checked.
#
# \`payout\` is pure: it cannot read the clock, the network or the random source.
# \`spinOnce\` needs randomness, so it must say so. Remove \`uses rand\` and the
# program stops compiling — which is the point.

fn payout(symbol: Str, count: Int) -> Float {
    if count < 3 {
        return 0.0
    }
    if symbol == "seven" {
        return 50.0
    }
    5.0
}

fn spinOnce() -> Float uses rand {
    let reel = Reel.of(["cherry", "lemon", "star", "seven"], [40, 30, 20, 10])
    let row = Reel.spin(reel, 3)
    if Reel.isMatch(row) {
        return payout(row[0], 3)
    }
    0.0
}

fn main() uses io, rand {
    for i in 0..5 {
        print("spin {i + 1}: {spinOnce():.2}")
    }
}
`;

const REFINEMENT = `# Refinement types: a contract the compiler enforces at the call site.
#
# Change \`safeDivide(10, 2)\` to \`safeDivide(10, 0)\` and the program is rejected
# before it runs, with error E0701 — not with a runtime crash.

fn safeDivide(a: Int, b: Int where b != 0) -> Int {
    a / b
}

fn main() uses io {
    print("10 / 2 = {safeDivide(10, 2)}")
}
`;

const MONEY = `# Money is exact.
#
# A balance is a fixed-point value, never a float. Multiplying money by a float
# is a type error, because a fraction of a cent is not a quantity a ledger can
# hold. Conversions to Float are explicit and lossy, and only for reporting.

fn main() uses io {
    var balance = Money.of(100, 0)
    let stake = Money.of(2, 50)

    balance = Money.sub(balance, stake)
    balance = Money.add(balance, Money.scale(stake, 3))

    print("balance {Money.format(balance)}")
    let split = Money.divide(balance, 3)
    print("split three ways: {Money.format(split.each)} remainder {Money.format(split.remainder)}")
}
`;

const FAIRNESS = `# Provable fairness: commit, play, reveal.
#
# The server seed is committed as a hash before play, the client seed is bound to
# the ceremony, and every draw is derived by HMAC. After the reveal, anyone can
# recompute the outcome and check it against the published commitment.

fn main() uses io, rand {
    let ceremony = Fair.begin("player-chosen-seed")
    print("commitment {Fair.commitment(ceremony)}")

    Fair.use(ceremony, 1)
    print("round 1 draw {Fair.draw(ceremony, 0)}")
    print("round 1 draw {Fair.draw(ceremony, 1)}")

    let seed = Fair.reveal(ceremony)
    print("revealed {seed}")
    print("verifies {Fair.verify(seed, Fair.commitment(ceremony))}")
}
`;

const RTP_EXAMPLE = `# A declared RTP is an obligation, not a comment.
#
# \`sunra rtp\` simulates the game and fails the build when the measured return
# leaves the declared tolerance. In the playground, the RTP panel runs the same
# check.

game CoinToss {
    rtp = 0.96
    tolerance = 0.01
    bet = 1.0

    fn spin() -> Float uses rand {
        if rng.int(1, 2) == 1 {
            return 1.92 * bet
        }
        0.0
    }
}

fn main() uses io, rand {
    let report = Rtp.estimate(CoinToss.spin, 20000)
    print("declared {CoinToss.rtp:.4}  measured {report.rtp:.4}")
}

test "the paytable matches the declared return" {
    assert CoinToss.rtp == 0.96
}
`;

const TESTS_EXAMPLE = `# Tests live in the language, next to the rules they protect.

fn total(hand) -> Int {
    var sum = 0
    for card in hand {
        sum = sum + card
    }
    sum % 10
}

fn main() uses io {
    print("baccarat total of [9, 5] is {total([9, 5])}")
}

test "totals wrap at ten" {
    assert total([9, 5]) == 4
    assert total([2, 3]) == 5
    assert total([10, 10]) == 0
}
`;

const BASE_EXAMPLES: PlaygroundExample[] = [
  { id: "hello", title: "Hello, Sunra", blurb: "The smallest complete program, and why printing is an effect.", group: "basics", source: HELLO },
  { id: "values", title: "Values and collections", blurb: "Lists, loops, method chains and string interpolation.", group: "basics", source: VALUES },
  { id: "tests", title: "Tests in the language", blurb: "`test` blocks run with `sunra test` and in the playground.", group: "basics", source: TESTS_EXAMPLE },
  { id: "effects", title: "Effects are checked", blurb: "A pure payout function cannot reach the random source.", group: "gaming", source: EFFECTS },
  { id: "money", title: "Exact money", blurb: "Fixed-point balances, explicit conversions, no lost cents.", group: "gaming", source: MONEY },
  { id: "fairness", title: "Provable fairness", blurb: "Commit, play, reveal, and verify a published commitment.", group: "gaming", source: FAIRNESS },
  { id: "refinement", title: "Refinement types", blurb: "`where b != 0` is enforced at the call site, not at runtime.", group: "assurance", source: REFINEMENT },
  { id: "rtp", title: "A declared RTP", blurb: "The simulation that turns a comment into an obligation.", group: "assurance", source: RTP_EXAMPLE },
];

/**
 * Every example the playground can open: the hand-written ones above plus each
 * bundled game template, so a visitor can load a complete blackjack table in the
 * editor without leaving the page.
 */
export function playgroundExamples(): PlaygroundExample[] {
  const fromTemplates = listTemplates().map<PlaygroundExample>((template) => ({
    id: `template-${template.id}`,
    title: template.name,
    blurb: template.summary,
    group: "templates",
    source: template.source,
  }));
  return [...BASE_EXAMPLES, ...fromTemplates];
}

/** Look up an example by id. Returns null when the id is unknown. */
export function findExample(id: string): PlaygroundExample | null {
  const wanted = id.trim().toLowerCase();
  return playgroundExamples().find((example) => example.id === wanted) ?? null;
}

// --------------------------------------------------------------------- share

/**
 * Encode a program for a URL fragment.
 *
 * Base64url of UTF-8, with a one-character version prefix so a future change of
 * encoding can be detected rather than silently mis-decoded. A fragment is used
 * rather than a query string because a shared program should never be sent to a
 * server by accident.
 */
export function encodeShare(source: string): string {
  const bytes = utf8Encode(source);
  return `1${base64UrlEncode(bytes)}`;
}

/** Decode a share payload. Returns null when the payload is not readable. */
export function decodeShare(payload: string): string | null {
  const trimmed = payload.trim().replace(/^#/, "").replace(/^(?:code|share)=/, "");
  if (!trimmed.startsWith("1")) return null;
  try {
    const bytes = base64UrlDecode(trimmed.slice(1));
    return utf8Decode(bytes);
  } catch {
    return null;
  }
}

/** Build a shareable link for a base URL such as `https://sunra.dev/play`. */
export function shareLink(baseUrl: string, source: string): string {
  const base = baseUrl.split("#")[0];
  return `${base}#code=${encodeShare(source)}`;
}

/** Read a program out of a full URL or a bare fragment. */
export function sourceFromLocation(href: string): string | null {
  const hashAt = href.indexOf("#");
  const fragment = hashAt >= 0 ? href.slice(hashAt + 1) : href;
  if (!fragment) return null;
  for (const part of fragment.split("&")) {
    const decoded = decodeShare(part);
    if (decoded !== null) return decoded;
  }
  return null;
}

// -------------------------------------------------------------------- session

export type PanelKind = "diagnostics" | "output" | "tests" | "rtp";

export interface PlaygroundPanel {
  kind: PanelKind;
  title: string;
  /** Lines to display, already formatted. */
  lines: string[];
  /** Whether this panel reports a problem the user should act on. */
  problem: boolean;
}

export interface PlaygroundResult {
  ok: boolean;
  /** Compiler version, so a shared bug report says which build produced it. */
  version: string;
  diagnostics: BrowserDiagnostic[];
  output: string[];
  tests: { passed: number; failed: number; lines: string[] } | null;
  rtp: Array<{ game: string; declared: number | null; measured: number; verdict: string }> | null;
  /** Wall-clock milliseconds per stage that actually ran. */
  timings: Array<{ stage: string; ms: number }>;
  /** Ready-to-render panels, in display order. */
  panels: PlaygroundPanel[];
}

export interface PlaygroundOptions {
  seed?: string;
  /** Run `test` blocks as well as `main`. Default true. */
  runTests?: boolean;
  /** Verify declared RTP. Default false, because a simulation is slow. */
  verifyRtp?: boolean;
  /** Rounds for the RTP check. Default 20,000. */
  rounds?: number;
}

/**
 * Compile and run a program the way the playground wants it: never throwing,
 * always returning something the UI can display, and reporting how long each
 * stage took so a slow simulation is visibly a simulation.
 */
export function runPlayground(source: string, options: PlaygroundOptions = {}): PlaygroundResult {
  const timings: Array<{ stage: string; ms: number }> = [];
  const timed = <T>(stage: string, fn: () => T): T => {
    const started = now();
    const value = fn();
    timings.push({ stage, ms: now() - started });
    return value;
  };

  const checked = timed("check", () => analyze(source));
  const errors = checked.diagnostics.filter((d) => d.severity === "error");

  if (errors.length > 0) {
    return {
      ok: false,
      version: VERSION,
      diagnostics: checked.diagnostics,
      output: [],
      tests: null,
      rtp: null,
      timings,
      panels: [diagnosticsPanel(checked.diagnostics)],
    };
  }

  const executed = timed("run", () => run(source, { seed: options.seed }));
  const runErrors = executed.diagnostics.filter((d) => d.severity === "error");

  let tests: PlaygroundResult["tests"] = null;
  if (options.runTests !== false) {
    const result = timed("test", () => test(source, { seed: options.seed }));
    tests = { passed: result.passed, failed: result.failed, lines: result.output };
  }

  let rtp: PlaygroundResult["rtp"] = null;
  if (options.verifyRtp) {
    const result = timed("rtp", () =>
      verifyRtp(source, { rounds: options.rounds ?? 20_000, seed: options.seed }),
    );
    rtp = result.reports.map((report) => ({
      game: report.game,
      declared: report.target,
      measured: report.actual,
      verdict: report.verdict,
    }));
  }

  const diagnostics = [...checked.diagnostics.filter((d) => d.severity !== "error"), ...runErrors];
  const panels: PlaygroundPanel[] = [];
  if (diagnostics.length > 0) panels.push(diagnosticsPanel(diagnostics));
  panels.push({
    kind: "output",
    title: "Output",
    lines: executed.output.length > 0 ? executed.output : ["(the program printed nothing)"],
    problem: false,
  });
  if (tests) {
    panels.push({
      kind: "tests",
      title: `Tests — ${tests.passed} passed, ${tests.failed} failed`,
      lines: tests.lines.length > 0 ? tests.lines : ["(no test blocks)"],
      problem: tests.failed > 0,
    });
  }
  if (rtp) {
    panels.push({
      kind: "rtp",
      title: "Declared RTP",
      lines:
        rtp.length > 0
          ? rtp.map(
              (report) =>
                `${report.game}: ` +
                (report.declared === null
                  ? "no declared RTP, "
                  : `declared ${(report.declared * 100).toFixed(2)}%, `) +
                `measured ${(report.measured * 100).toFixed(2)}% — ${report.verdict}`,
            )
          : ["(no game declares an RTP)"],
      problem: rtp.some((report) => report.verdict === "FAIL"),
    });
  }

  return {
    ok: executed.ok && (tests?.failed ?? 0) === 0,
    version: VERSION,
    diagnostics,
    output: executed.output,
    tests,
    rtp,
    timings,
    panels,
  };
}

function diagnosticsPanel(diagnostics: BrowserDiagnostic[]): PlaygroundPanel {
  const errors = diagnostics.filter((d) => d.severity === "error");
  return {
    kind: "diagnostics",
    title:
      errors.length > 0
        ? `${errors.length} error${errors.length === 1 ? "" : "s"}`
        : `${diagnostics.length} warning${diagnostics.length === 1 ? "" : "s"}`,
    lines: diagnostics.map(
      (diagnostic) =>
        `${diagnostic.severity}[${diagnostic.code}] line ${diagnostic.line}: ${diagnostic.message}` +
        (diagnostic.hint ? `\n  help: ${diagnostic.hint}` : ""),
    ),
    problem: errors.length > 0,
  };
}

// ---------------------------------------------------------------- primitives

/**
 * Base64url without padding, implemented directly so the module has no
 * dependency on `Buffer` (absent in the browser) or `btoa` (absent in Node
 * before 16 and awkward with UTF-8).
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64UrlEncode(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += ALPHABET[b2 & 0x3f];
  }
  return out;
}

function base64UrlDecode(text: string): number[] {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of text) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) throw new Error(`invalid base64url character ${character}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

function utf8Encode(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    let code = character.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

function utf8Decode(bytes: number[]): string {
  let out = "";
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    let code: number;
    let length: number;
    if (byte < 0x80) {
      code = byte;
      length = 1;
    } else if ((byte & 0xe0) === 0xc0) {
      code = byte & 0x1f;
      length = 2;
    } else if ((byte & 0xf0) === 0xe0) {
      code = byte & 0x0f;
      length = 3;
    } else {
      code = byte & 0x07;
      length = 4;
    }
    for (let i = 1; i < length; i += 1) {
      const continuation = bytes[index + i];
      if (continuation === undefined) throw new Error("truncated UTF-8 sequence");
      code = (code << 6) | (continuation & 0x3f);
    }
    out += String.fromCodePoint(code);
    index += length;
  }
  return out;
}

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
