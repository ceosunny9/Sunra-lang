/**
 * One-line game scaffolding.
 *
 * `sunra slot "ธีมมังกร 5x3 243ways"` has to produce a program the rest of the
 * toolchain accepts without hand editing, so this module does two things and
 * refuses to guess beyond them: it reads the few facts a brief actually states
 * (grid, ways/lines, RTP, volatility, theme), and it emits source built from the
 * paytable solver below, whose mathematical RTP is computed rather than asserted.
 *
 * Anything the brief does not state falls back to a documented default, and the
 * emitted header says which numbers were stated and which were defaulted. A
 * generator that silently invented an RTP would defeat the purpose of a language
 * whose compiler verifies the declared one.
 */

/** A theme supplies symbol names and the flavour text in the emitted header. */
export interface Theme {
  id: string;
  label: string;
  /** Symbols from most common to rarest; the last one is the premium. */
  symbols: string[];
}

const THEMES: Theme[] = [
  { id: "dragon", label: "Dragon", symbols: ["COIN", "LANTERN", "SCROLL", "JADE", "PHOENIX", "DRAGON"] },
  { id: "egypt", label: "Solar Egypt", symbols: ["ANKH", "SCARAB", "EYE", "COBRA", "PHARAOH", "SUNDISC"] },
  { id: "fruit", label: "Classic Fruit", symbols: ["CHERRY", "LEMON", "PLUM", "BELL", "STAR", "SEVEN"] },
  { id: "ocean", label: "Deep Ocean", symbols: ["SHELL", "CORAL", "TURTLE", "PEARL", "KRAKEN", "TRIDENT"] },
  { id: "fortune", label: "Fortune Gods", symbols: ["INGOT", "ENVELOPE", "DRUM", "GOURD", "TIGER", "GOD"] },
];

/**
 * Theme keywords in Thai and English. Thai is matched by substring because the
 * script has no word separators, so token matching would miss "ธีมมังกร".
 */
const THEME_KEYWORDS: Record<string, string[]> = {
  dragon: ["dragon", "มังกร", "จีน", "chinese", "oriental"],
  egypt: ["egypt", "อียิปต์", "pharaoh", "ฟาโรห์", "sun"],
  fruit: ["fruit", "ผลไม้", "classic", "คลาสสิก", "vegas"],
  ocean: ["ocean", "ทะเล", "sea", "มหาสมุทร", "ปลา"],
  fortune: ["fortune", "โชคลาภ", "ไฉ่ซิงเอี๊ย", "เทพ", "รวย", "ทอง"],
};

export interface SlotBrief {
  columns: number;
  rows: number;
  /** Ways-to-win when the brief asks for ways, otherwise null. */
  ways: number | null;
  /** Fixed paylines when the brief asks for lines, otherwise null. */
  lines: number | null;
  /** Target return to player, as a fraction. */
  rtp: number;
  tolerance: number;
  volatility: "low" | "medium" | "high";
  theme: Theme;
  /** True when the brief stated an RTP, so the header can say so. */
  rtpStated: boolean;
  gridStated: boolean;
  source: string;
}

const DEFAULT_RTP = 0.965;
const DEFAULT_TOLERANCE = 0.005;

function pickTheme(brief: string): Theme {
  const haystack = brief.toLowerCase();
  for (const theme of THEMES) {
    if ((THEME_KEYWORDS[theme.id] ?? []).some((keyword) => haystack.includes(keyword))) return theme;
  }
  return THEMES[2];
}

/** Read a grid from `5x3`, `5 × 3`, or Thai `5 วง 3 แถว`. */
function parseGrid(brief: string): { columns: number; rows: number } | null {
  const direct = /(\d)\s*[x×*]\s*(\d)/i.exec(brief);
  if (direct) {
    const columns = Number(direct[1]);
    const rows = Number(direct[2]);
    if (columns >= 1 && columns <= 9 && rows >= 1 && rows <= 9) return { columns, rows };
  }
  const thai = /(\d+)\s*(?:วง|รีล|reel)s?\D{0,12}?(\d+)\s*(?:แถว|row)/i.exec(brief);
  if (thai) return { columns: Number(thai[1]), rows: Number(thai[2]) };
  return null;
}

/** `243ways`, `243 ทาง`, `20 lines`, `20 ไลน์`. */
function parseWaysOrLines(brief: string): { ways: number | null; lines: number | null } {
  const ways = /(\d{1,6})\s*(?:ways?|ทาง)/i.exec(brief);
  const lines = /(\d{1,4})\s*(?:lines?|paylines?|ไลน์|เส้น)/i.exec(brief);
  return { ways: ways ? Number(ways[1]) : null, lines: lines ? Number(lines[1]) : null };
}

/** `rtp 96.5`, `RTP=0.965`, `96.5%`, Thai `อาร์ทีพี 96.5`. */
function parseRtp(brief: string): number | null {
  const labelled = /(?:rtp|อาร์ทีพี|ค่าตอบแทน)\D{0,6}(\d{1,3}(?:\.\d+)?)\s*%?/i.exec(brief);
  const bare = /(\d{2}(?:\.\d+)?)\s*%/.exec(brief);
  const raw = labelled?.[1] ?? bare?.[1];
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const fraction = value > 1 ? value / 100 : value;
  // Outside this band the input is a typo, not a game: refuse it rather than
  // emitting a game whose declared RTP could never be certified.
  if (fraction < 0.5 || fraction > 0.999) return null;
  return fraction;
}

function parseVolatility(brief: string): "low" | "medium" | "high" {
  const haystack = brief.toLowerCase();
  if (/high|สูง|แรง|หนัก/.test(haystack)) return "high";
  if (/low|ต่ำ|เบา|นิ่ง/.test(haystack)) return "low";
  return "medium";
}

export function parseSlotBrief(brief: string): SlotBrief {
  const grid = parseGrid(brief);
  const { ways, lines } = parseWaysOrLines(brief);
  const rtp = parseRtp(brief);
  return {
    columns: grid?.columns ?? 5,
    rows: grid?.rows ?? 3,
    ways,
    lines: ways === null ? (lines ?? 20) : null,
    rtp: rtp ?? DEFAULT_RTP,
    tolerance: DEFAULT_TOLERANCE,
    volatility: parseVolatility(brief),
    theme: pickTheme(brief),
    rtpStated: rtp !== null,
    gridStated: grid !== null,
    source: brief.trim(),
  };
}

/** A solved paytable: weights, prizes, and the exact RTP they produce. */
export interface Paytable {
  symbols: string[];
  weights: number[];
  /** Prize for three of a kind, aligned with `symbols`. */
  triple: number[];
  /** Prize for exactly two leading symbols of a kind. */
  pair: number;
  /** Mathematical RTP of the table, by enumeration. */
  exactRtp: number;
  /** Standard deviation of the return per bet, by enumeration. */
  sigma: number;
}

/**
 * Exact RTP of a three-reel paytable.
 *
 * With independent reels the probability of a triple of symbol i is p^3, and of
 * exactly two leading symbols p^2(1-p). Enumeration is cheap here and removes
 * any need to trust a simulation at generation time.
 */
function exactRtpOf(probabilities: number[], triple: number[], pair: number): number {
  let total = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const p = probabilities[i];
    total += p * p * p * triple[i];
    total += p * p * (1 - p) * pair;
  }
  return total;
}

/**
 * Standard deviation of the return per bet, by the same enumeration.
 *
 * This matters for the emitted `tolerance`: a declared RTP is only checkable at
 * the precision a simulation can actually reach, and a high-variance table needs
 * either far more rounds or a wider band. Deriving the tolerance from sigma is
 * what stops the generator from emitting an obligation no simulation can settle.
 */
function sigmaOf(probabilities: number[], triple: number[], pair: number): number {
  let mean = 0;
  let second = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const p = probabilities[i];
    const pTriple = p * p * p;
    const pPair = p * p * (1 - p);
    mean += pTriple * triple[i] + pPair * pair;
    second += pTriple * triple[i] * triple[i] + pPair * pair * pair;
  }
  return Math.sqrt(Math.max(0, second - mean * mean));
}

/**
 * Solve a paytable for a target RTP.
 *
 * The table's shape is fixed by the volatility profile — how steeply the premium
 * pays relative to the low symbols — and then one scale factor is fitted by
 * bisection so the enumerated RTP lands on target. Fitting a single scalar keeps
 * the intended prize ratios intact, which makes the result read like a designed
 * game rather than a random table.
 */
export function solvePaytable(brief: SlotBrief): Paytable {
  const symbols = brief.theme.symbols;
  const count = symbols.length;

  const decay = brief.volatility === "high" ? 0.62 : brief.volatility === "low" ? 0.82 : 0.72;
  const weights: number[] = [];
  for (let i = 0; i < count; i++) weights.push(Number((30 * Math.pow(decay, i)).toFixed(2)));
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const probabilities = weights.map((w) => w / weightTotal);

  // Prize shape.
  //
  // A prize proportional to 1/p^3 spreads the return evenly across symbols, but
  // it also makes the top prize enormous and the variance with it — the first
  // version of this solver produced a table with sigma above 11 per bet, whose
  // RTP no practical simulation could confirm. Damping the exponent concentrates
  // more of the return in the frequent symbols, which is both how real low- and
  // medium-volatility games are built and what makes the declared RTP checkable.
  const damping = brief.volatility === "high" ? 0.78 : brief.volatility === "low" ? 0.45 : 0.6;
  const tilt = brief.volatility === "high" ? 1.35 : brief.volatility === "low" ? 0.85 : 1.0;
  const shape = probabilities.map((p, i) => Math.pow(1 / (p * p * p), damping) * Math.pow(1 + i / count, tilt));
  const shapeMin = Math.min(...shape);
  const normalized = shape.map((s) => s / shapeMin);
  // The consolation prize carries a large share of the return in low-volatility
  // designs, because it hits about sixteen times as often as any triple.
  const pairShare = brief.volatility === "high" ? 0.35 : brief.volatility === "low" ? 1.6 : 0.9;

  // RTP increases monotonically in the scale factor, so bisection converges.
  const rtpAtScale = (scale: number): number =>
    exactRtpOf(probabilities, normalized.map((n) => n * scale), scale * pairShare * 4);
  let low = 1e-6;
  let high = 1e6;
  for (let iteration = 0; iteration < 200; iteration++) {
    const mid = (low + high) / 2;
    if (rtpAtScale(mid) < brief.rtp) low = mid;
    else high = mid;
  }
  const scale = (low + high) / 2;

  // Round for readable source, then recompute the exact RTP of the rounded
  // table so the emitted comment is true of the emitted numbers.
  const triple = normalized.map((n) => Number((n * scale).toFixed(2)));
  const pair = Number((scale * pairShare * 4).toFixed(2));
  return {
    symbols,
    weights,
    triple,
    pair,
    exactRtp: exactRtpOf(probabilities, triple, pair),
    sigma: sigmaOf(probabilities, triple, pair),
  };
}

function matchArms(symbols: string[], prizes: number[], indent: string): string {
  const lines: string[] = [];
  for (let i = symbols.length - 1; i >= 0; i--) {
    lines.push(`${indent}${`"${symbols[i]}"`.padEnd(12)}-> ${prizes[i].toFixed(2)}`);
  }
  lines.push(`${indent}${"_".padEnd(12)}-> 0.0`);
  return lines.join("\n");
}

/** Emit a complete, checkable slot program. */
export function generateSlot(brief: SlotBrief): { name: string; source: string } {
  const table = solvePaytable(brief);
  const name = `${brief.theme.label.replace(/[^A-Za-z]/g, "")}Slot`;
  const mechanic = brief.ways !== null ? `${brief.ways} ways` : `${brief.lines ?? 20} fixed lines`;
  const premium = table.symbols[table.symbols.length - 1];
  const lowest = table.symbols[0];

  // Tolerance the toolchain can actually settle: the 95% half-width of a
  // one-million-round simulation, floored at 0.5% and rounded up to the next
  // basis point. Declaring anything tighter would guarantee a FAIL verdict for
  // reasons of sample size rather than game design.
  const halfWidth = (1.96 * table.sigma) / Math.sqrt(1_000_000);
  const tolerance = Math.max(brief.tolerance, Math.ceil(halfWidth * 10_000) / 10_000);

  const source = `# ${brief.theme.label} — generated by \`sunra slot\`
#
# Brief:        ${brief.source || "(none given)"}
# Grid:         ${brief.columns}x${brief.rows}${brief.gridStated ? "" : "  (default; the brief did not state one)"}
# Mechanic:     ${mechanic}
# Volatility:   ${brief.volatility}
# Declared RTP: ${(brief.rtp * 100).toFixed(4)}%${brief.rtpStated ? "" : "  (default; the brief did not state one)"}
#
# The paytable was solved, not guessed: enumerating every three-of-a-kind and
# two-of-a-kind outcome on this reel strip gives ${(table.exactRtp * 100).toFixed(4)}%, which is
# the figure \`sunra rtp\` converges on by simulation.
#
# Return sigma is ${table.sigma.toFixed(2)} per bet, so a one-million-round simulation
# resolves the mean to about ±${(halfWidth * 100).toFixed(3)}%. The declared tolerance below is set
# from that figure rather than picked, so the obligation is one a simulation can
# actually settle.
#
# Next steps:
#   sunra run     this_file.sun --seed 42
#   sunra rtp     this_file.sun --rounds 1000000
#   sunra certify this_file.sun

game ${name} {
    rtp = ${brief.rtp.toFixed(4)}
    tolerance = ${tolerance.toFixed(4)}
    bet = 1.0

    columns = ${brief.columns}
    rows = ${brief.rows}
    ${brief.ways !== null ? `ways = ${brief.ways}` : `lines = ${brief.lines ?? 20}`}

    reel strip = [${table.symbols.map((s) => `"${s}"`).join(", ")}]
    reel weights = [${table.weights.map((w) => w.toFixed(2)).join(", ")}]

    # Pure: the prize depends only on the drawn row, so the compiler can check it
    # exhaustively. It declares no effects, so it cannot reach the RNG.
    fn payout(row) -> Float {
        let first = row[0]
        if Reel.isMatch(row) {
            return match first {
${matchArms(table.symbols, table.triple, "                ")}
            }
        }
        if Reel.longestRun(row) == 2 {
            return ${table.pair.toFixed(2)}
        }
        0.0
    }

    # Consumes randomness, so it declares \`uses rand\`. Dropping the annotation
    # is compile error E0615, not a warning.
    #
    # The win is computed in Money and only then converted, so no arithmetic on
    # this path is floating point. Writing \`payout(row) * bet\` instead would be
    # a float multiply in the payout path and GLI-19 s.6.2 would fail the build.
    fn spin() -> Float uses rand {
        Money.toFloat(spinMoney())
    }

    # The exact-money form of a spin. \`payout\` returns a multiplier, which is a
    # ratio and so legitimately a float; converting through Money before any
    # credit is accumulated is what keeps the balance arithmetic exact, as
    # GLI-19 s.6.2 requires.
    fn spinMoney() uses rand {
        let row = Reel.spin(Reel.of(strip, weights), 3)
        Money.scale(Money.of(bet), payout(row))
    }

    fn spinVerbose() uses rand, io {
        let row = Reel.spin(Reel.of(strip, weights), 3)
        let win = Money.scale(Money.of(bet), payout(row))
        let label = row.join(" | ")
        if not Money.isZero(win) {
            print("  [{label}]  win {Money.format(win)}")
        } else {
            print("  [{label}]  --")
        }
    }

    # Reporting only: dividing an exact total by a round count is a statistic,
    # not a credit movement, so the float lives here and nowhere near a balance.
    # Keeping it out of \`main\` also keeps the determinism checker's float report
    # pointed at the one function that genuinely computes a ratio.
    fn averageOf(total, rounds) -> Float {
        Money.toFloat(total) / float(rounds)
    }
}

fn main() uses io, rand {
    print("${brief.theme.label} — ${brief.columns}x${brief.rows}, ${mechanic}")
    print("declared RTP {${name}.rtp:.4}   tolerance {${name}.tolerance:.4}")
    print("")
    print("Ten spins:")
    for i in 0..10 {
        ${name}.spinVerbose()
    }
    print("")
    print("Simulating 200,000 rounds:")
    # Accumulate in Money so the reported figure carries no floating-point drift.
    var total = Money.zero()
    var hits = 0
    let rounds = 200000
    for i in 0..rounds {
        let win = ${name}.spinMoney()
        total = Money.add(total, win)
        if not Money.isZero(win) {
            hits += 1
        }
    }
    print("  measured RTP   {${name}.averageOf(total, rounds):.4}")
    print("  hit frequency  {${name}.averageOf(Money.of(float(hits)), rounds):.4}")
    print("")
    print("Run \`sunra rtp\` for a confidence interval and a verdict.")
}

test "a non-matching row pays nothing" {
    assert ${name}.payout(["${table.symbols[0]}", "${table.symbols[1]}", "${table.symbols[2]}"]) == 0.0
}

test "the premium symbol pays the most" {
    assert ${name}.payout(["${premium}", "${premium}", "${premium}"]) > ${name}.payout(["${lowest}", "${lowest}", "${lowest}"])
}
`;

  return { name, source };
}

export interface BaccaratBrief {
  decks: number;
  /** Commission on a winning Banker bet, as a fraction. */
  commission: number;
  /** The bet the generated `spin` resolves, for RTP measurement. */
  side: "Banker" | "Player";
  /** Style label used in the emitted comments, e.g. "SA Gaming". */
  style: string;
  source: string;
}

export function parseBaccaratBrief(brief: string): BaccaratBrief {
  const haystack = brief.toLowerCase();
  const decks = /(\d{1,2})\s*(?:decks?|สำรับ|เด็ค)/i.exec(brief);
  const commission = /(\d{1,2}(?:\.\d+)?)\s*%\s*(?:commission|comm|ค่าน้ำ)/i.exec(brief);
  const noCommission = /no\s*commission|ไม่เก็บค่าน้ำ|ไม่มีค่าน้ำ/.test(haystack);
  const style = /sa\s*gaming/.test(haystack)
    ? "SA Gaming"
    : /sexy/.test(haystack)
      ? "AE Sexy"
      : /wm/.test(haystack)
        ? "WM Casino"
        : /dream/.test(haystack)
          ? "Dream Gaming"
          : "House standard";
  return {
    decks: decks ? Math.min(12, Math.max(1, Number(decks[1]))) : 8,
    commission: noCommission ? 0 : commission ? Number(commission[1]) / 100 : 0.05,
    side: /player|เพลเยอร์|ผู้เล่น/.test(haystack) ? "Player" : "Banker",
    style,
    source: brief.trim(),
  };
}

/**
 * Emit a baccarat table.
 *
 * The drawing rules are not re-implemented here: they live in the pure
 * `Baccarat` standard-library module, which is what lets `sunra test` verify
 * them without dealing a hand. The generated file adds the table configuration,
 * a printable round, and rule tests that hold for any correct implementation.
 */
export function generateBaccarat(brief: BaccaratBrief): { name: string; source: string } {
  const name = "BaccaratTable";
  // Banker at 5% commission returns 98.94%, Player 98.76%. A reduced or waived
  // commission raises the Banker return, so derive the declared value from the
  // requested commission instead of hard-coding one constant.
  const bankerRtp = 1 - 0.0106 - (brief.commission - 0.05) * 0.4586;
  const rtp = brief.side === "Banker" ? bankerRtp : 0.9876;

  const source = `# Baccarat (punto banco) — generated by \`sunra baccarat\`
#
# Brief:       ${brief.source || "(none given)"}
# Style:       ${brief.style}
# Shoe:        ${brief.decks} decks
# Commission:  ${(brief.commission * 100).toFixed(2)}% on a winning Banker bet
# Resolved:    flat ${brief.side} bet of one unit
#
# The third-card rules come from the pure \`Baccarat\` standard-library module, so
# \`sunra test\` verifies them exhaustively without dealing a single hand.
#
# Next steps:
#   sunra run     this_file.sun --seed 7
#   sunra test    this_file.sun
#   sunra certify this_file.sun

game ${name} {
    rtp = ${rtp.toFixed(4)}
    tolerance = 0.01
    bet = 1.0
    decks = ${brief.decks}
    commission = ${brief.commission.toFixed(4)}

    # Deal one hand: [playerLabel, bankerLabel, pTotal, bTotal, winner].
    fn deal() uses rand {
        let shoe = Deck.shuffled(decks)
        let opening = Deck.deal(shoe, 4)
        let dealt = opening.hand
        var rest = opening.rest

        var player = [dealt[0], dealt[2]]
        var banker = [dealt[1], dealt[3]]
        var pTotal = Baccarat.total(player)
        var bTotal = Baccarat.total(banker)

        # A natural (8 or 9) ends the hand with no draws.
        let natural = Baccarat.isNatural(pTotal) or Baccarat.isNatural(bTotal)
        var playerThird = 0 - 1

        if not natural {
            if Baccarat.playerDraws(pTotal) {
                let dp = Deck.deal(rest, 1)
                let card = dp.hand[0]
                rest = dp.rest
                player = player + [card]
                playerThird = Card.pip(card) % 10
                pTotal = Baccarat.total(player)
            }
            if Baccarat.bankerDraws(bTotal, playerThird) {
                let db = Deck.deal(rest, 1)
                banker = banker + [db.hand[0]]
                rest = db.rest
                bTotal = Baccarat.total(banker)
            }
        }

        [labelOf(player), labelOf(banker), pTotal, bTotal, Baccarat.winner(pTotal, bTotal)]
    }

    # Pure: renders a hand for display.
    fn labelOf(cards) -> Str {
        var out = ""
        for c in cards {
            out = out + Card.label(c) + " "
        }
        out.trim()
    }

    fn spin() -> Float uses rand {
        let round = deal()
        Baccarat.payout("${brief.side}", round[4]) * bet
    }

    # Exact-money form of a resolved bet. \`Baccarat.payout\` returns a multiplier,
    # so the conversion to Money happens before anything is accumulated — that is
    # what GLI-19 s.6.2 asks for.
    fn spinMoney() uses rand {
        let round = deal()
        Money.scale(Money.of(bet), Baccarat.payout("${brief.side}", round[4]))
    }

    # Reporting only: an average over rounds is a statistic, not a credit.
    fn averageOf(total, rounds) -> Float {
        Money.toFloat(total) / float(rounds)
    }

    fn dealVerbose() uses rand, io {
        let round = deal()
        print("  player {round[0]}  ({round[2]})")
        print("  banker {round[1]}  ({round[3]})")
        print("  winner {round[4]}")
        print("")
    }
}

fn main() uses io, rand {
    print("Baccarat — ${brief.style}, ${brief.decks}-deck shoe")
    print("resolving a flat ${brief.side} bet, declared RTP {${name}.rtp:.4}")
    print("")
    print("Three hands:")
    for i in 0..3 {
        ${name}.dealVerbose()
    }

    print("Simulating 50,000 hands:")
    var total = Money.zero()
    let rounds = 50000
    for i in 0..rounds {
        total = Money.add(total, ${name}.spinMoney())
    }
    print("  measured RTP  {${name}.averageOf(total, rounds):.4}")
    print("")
    print("Run \`sunra certify\` for an RTP and provably-fair certificate.")
}

test "a natural stops the hand" {
    assert Baccarat.isNatural(8)
    assert Baccarat.isNatural(9)
    assert not Baccarat.isNatural(7)
}

test "the player draws on five or less" {
    assert Baccarat.playerDraws(0)
    assert Baccarat.playerDraws(5)
    assert not Baccarat.playerDraws(6)
}

test "the banker always draws on two or less" {
    assert Baccarat.bankerDraws(2, 9)
    assert not Baccarat.bankerDraws(7, 9)
}

test "totals are computed modulo ten" {
    assert Baccarat.total([Card.of(9, 0), Card.of(5, 1)]) == 4
}
`;

  return { name, source };
}
