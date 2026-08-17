import {
  bool,
  display,
  float,
  int,
  list,
  money,
  moneyFromUnits,
  moneyToNumber,
  namespace,
  native,
  numeric,
  record,
  str,
  UNIT,
  MONEY_SCALE,
  type Value,
} from "./values.js";
import { FairRng, randomSeedHex, sha256Hex, SimRng, type SunraRng } from "./rng.js";
import { runtimeError } from "../diagnostics.js";

/**
 * The `std.game` surface exposed to Sunra programs.
 *
 * Everything here corresponds to a module described in the whitepaper's standard
 * library section, reduced to what a prototype can meaningfully implement.
 */

function argErr(fn: string, message: string): never {
  throw runtimeError(`${fn}: ${message}`, null);
}

function asList(fn: string, v: Value): Value[] {
  if (v.t !== "list") argErr(fn, `expected a list but found ${v.t}`);
  return v.v;
}

function asNumber(fn: string, v: Value): number {
  if (v.t === "int" || v.t === "float") return v.v;
  if (v.t === "money") return moneyToNumber(v);
  argErr(fn, `expected a number but found ${v.t}`);
}

function asString(fn: string, v: Value): string {
  if (v.t === "str") return v.v;
  return display(v);
}

// ------------------------------------------------------------------ RNG facade

export interface RngHost {
  current(): SunraRng;
  setCurrent(rng: SunraRng): void;
}

function ceremonySeedHex(host: RngHost, bytes: number): string {
  const rng = host.current();
  // Interpreter --seed installs SimRng. Deriving ceremony material from that
  // stream makes Fair.begin replayable while preserving OS entropy in live mode.
  if (rng.kind !== "sim" && rng.kind !== "fair" && rng.kind !== "replay") {
    return randomSeedHex(bytes);
  }
  let hex = "";
  for (let i = 0; i < bytes; i++) {
    hex += rng.range(0, 256).toString(16).padStart(2, "0");
  }
  return hex;
}

export function makeRngNamespace(host: RngHost): Value {
  const pickOne = (items: Value[]): Value => {
    if (items.length === 0) argErr("rng.pick", "cannot pick from an empty list");
    return items[host.current().range(0, items.length)];
  };

  return namespace("rng", {
    // rng.pick(list)           -> one element
    // rng.pick(list, n)        -> n elements, with replacement (reel-style)
    pick: native("rng.pick", -1, (args) => {
      const items = asList("rng.pick", args[0]);
      if (args.length === 1) return pickOne(items);
      const n = asNumber("rng.pick", args[1]);
      const out: Value[] = [];
      for (let i = 0; i < n; i++) out.push(pickOne(items));
      return list(out);
    }),

    // weighted pick: rng.weighted(symbols, weights)
    weighted: native("rng.weighted", 2, (args) => {
      const items = asList("rng.weighted", args[0]);
      const weights = asList("rng.weighted", args[1]).map((w) => asNumber("rng.weighted", w));
      if (items.length !== weights.length) {
        argErr("rng.weighted", `symbols (${items.length}) and weights (${weights.length}) must be the same length`);
      }
      const total = weights.reduce((a, b) => a + b, 0);
      if (total <= 0) argErr("rng.weighted", "weights must sum to a positive number");
      let roll = host.current().nextFloat() * total;
      for (let i = 0; i < items.length; i++) {
        if (roll < weights[i]) return items[i];
        roll -= weights[i];
      }
      return items[items.length - 1];
    }),

    int: native("rng.int", 2, (args) =>
      int(host.current().range(asNumber("rng.int", args[0]), asNumber("rng.int", args[1]) + 1)),
    ),
    float: native("rng.float", 0, () => float(host.current().nextFloat())),
    bool: native("rng.bool", 0, () => bool(host.current().nextFloat() < 0.5)),
    chance: native("rng.chance", 1, (args) => bool(host.current().nextFloat() < asNumber("rng.chance", args[0]))),

    shuffle: native("rng.shuffle", 1, (args) => {
      const items = [...asList("rng.shuffle", args[0])];
      // Fisher-Yates over an unbiased bounded generator
      for (let i = items.length - 1; i > 0; i--) {
        const j = host.current().range(0, i + 1);
        [items[i], items[j]] = [items[j], items[i]];
      }
      return list(items);
    }),

    seed: native("rng.seed", 1, (args) => {
      host.setCurrent(new SimRng(asString("rng.seed", args[0])));
      return UNIT;
    }),

    kind: native("rng.kind", 0, () => str(host.current().kind)),
    draws: native("rng.draws", 0, () => int(host.current().draws)),
  });
}

// ------------------------------------------------------------------ Reel

export function makeReelNamespace(host: RngHost): Value {
  return namespace("Reel", {
    /** Reel.of(symbols) -> a reel strip record */
    of: native("Reel.of", -1, (args) => {
      const symbols = asList("Reel.of", args[0]);
      const weights =
        args.length > 1 && args[1].t === "list"
          ? asList("Reel.of", args[1]).map((w) => asNumber("Reel.of", w))
          : symbols.map(() => 1);
      const m = new Map<string, Value>();
      m.set("symbols", list(symbols));
      m.set("weights", list(weights.map((w) => float(w))));
      m.set("length", int(symbols.length));
      return record(m, "Reel");
    }),

    /** Reel.spin(strip, count) -> list of symbols using weights when present */
    spin: native("Reel.spin", -1, (args) => {
      const target = args[0];
      let symbols: Value[];
      let weights: number[];

      if (target.t === "record" && target.typeName === "Reel") {
        symbols = asList("Reel.spin", target.v.get("symbols")!);
        weights = asList("Reel.spin", target.v.get("weights")!).map((w) => asNumber("Reel.spin", w));
      } else {
        symbols = asList("Reel.spin", target);
        weights = symbols.map(() => 1);
      }

      const count = args.length > 1 ? asNumber("Reel.spin", args[1]) : 3;
      const total = weights.reduce((a, b) => a + b, 0);
      const out: Value[] = [];
      for (let i = 0; i < count; i++) {
        let roll = host.current().nextFloat() * total;
        let picked = symbols[symbols.length - 1];
        for (let j = 0; j < symbols.length; j++) {
          if (roll < weights[j]) {
            picked = symbols[j];
            break;
          }
          roll -= weights[j];
        }
        out.push(picked);
      }
      return list(out);
    }),

    /** Reel.grid(strip, columns, rows) -> list of columns */
    grid: native("Reel.grid", 3, (args) => {
      const symbols = args[0].t === "record" ? asList("Reel.grid", args[0].v.get("symbols")!) : asList("Reel.grid", args[0]);
      const cols = asNumber("Reel.grid", args[1]);
      const rows = asNumber("Reel.grid", args[2]);
      const grid: Value[] = [];
      for (let c = 0; c < cols; c++) {
        const column: Value[] = [];
        for (let r = 0; r < rows; r++) {
          column.push(symbols[host.current().range(0, symbols.length)]);
        }
        grid.push(list(column));
      }
      return list(grid);
    }),

    /** Reel.count(result, symbol) -> how many times a symbol appears */
    count: native("Reel.count", 2, (args) => {
      const items = flatten(asList("Reel.count", args[0]));
      const needle = display(args[1]);
      return int(items.filter((s) => display(s) === needle).length);
    }),

    /** Reel.isMatch(result) -> true when every symbol is identical */
    isMatch: native("Reel.isMatch", 1, (args) => {
      const items = flatten(asList("Reel.isMatch", args[0]));
      if (items.length === 0) return bool(false);
      const first = display(items[0]);
      return bool(items.every((s) => display(s) === first));
    }),

    /** Reel.longestRun(result) -> length of the leading run of identical symbols */
    longestRun: native("Reel.longestRun", 1, (args) => {
      const items = flatten(asList("Reel.longestRun", args[0]));
      if (items.length === 0) return int(0);
      const first = display(items[0]);
      let run = 0;
      for (const s of items) {
        if (display(s) === first) run += 1;
        else break;
      }
      return int(run);
    }),
  });
}

function flatten(items: Value[]): Value[] {
  const out: Value[] = [];
  for (const item of items) {
    if (item.t === "list") out.push(...flatten(item.v));
    else out.push(item);
  }
  return out;
}

// ------------------------------------------------------------------ Cards

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["♠", "♥", "♦", "♣"];
const RANK_VALUE: Record<string, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  "10": 10, J: 11, Q: 12, K: 13, A: 14,
};

function makeCard(rank: string, suit: string): Value {
  const m = new Map<string, Value>();
  m.set("rank", str(rank));
  m.set("suit", str(suit));
  m.set("value", int(RANK_VALUE[rank] ?? 0));
  m.set("label", str(`${rank}${suit}`));
  return record(m, "Card");
}

function cardRank(v: Value): string {
  if (v.t === "record" && v.typeName === "Card") {
    const r = v.v.get("rank");
    if (r && r.t === "str") return r.v;
  }
  return display(v);
}

export function makeDeckNamespace(host: RngHost): Value {
  const buildDeck = (decks: number): Value[] => {
    const cards: Value[] = [];
    for (let d = 0; d < decks; d++) {
      for (const suit of SUITS) for (const rank of RANKS) cards.push(makeCard(rank, suit));
    }
    return cards;
  };

  return namespace("Deck", {
    standard: native("Deck.standard", -1, (args) => {
      const decks = args.length > 0 ? asNumber("Deck.standard", args[0]) : 1;
      return list(buildDeck(decks));
    }),

    shuffled: native("Deck.shuffled", -1, (args) => {
      const decks = args.length > 0 ? asNumber("Deck.shuffled", args[0]) : 1;
      const cards = buildDeck(decks);
      for (let i = cards.length - 1; i > 0; i--) {
        const j = host.current().range(0, i + 1);
        [cards[i], cards[j]] = [cards[j], cards[i]];
      }
      return list(cards);
    }),

    /** Deck.deal(deck, n) -> record { hand, rest } */
    deal: native("Deck.deal", 2, (args) => {
      const cards = asList("Deck.deal", args[0]);
      const n = asNumber("Deck.deal", args[1]);
      const m = new Map<string, Value>();
      m.set("hand", list(cards.slice(0, n)));
      m.set("rest", list(cards.slice(n)));
      return record(m, "Deal");
    }),

    size: native("Deck.size", 1, (args) => int(asList("Deck.size", args[0]).length)),
  });
}

const SUIT_ALIASES: Record<string, string> = {
  S: "♠", s: "♠", spades: "♠",
  H: "♥", h: "♥", hearts: "♥",
  D: "♦", d: "♦", diamonds: "♦",
  C: "♣", c: "♣", clubs: "♣",
};

function normalizeSuit(input: string): string {
  return SUIT_ALIASES[input] ?? input;
}

export function makeCardNamespace(): Value {
  return namespace("Card", {
    of: native("Card.of", 2, (args) =>
      makeCard(asString("Card.of", args[0]).toUpperCase(), normalizeSuit(asString("Card.of", args[1]))),
    ),
    rank: native("Card.rank", 1, (args) => str(cardRank(args[0]))),
    label: native("Card.label", 1, (args) => {
      const v = args[0];
      if (v.t === "record" && v.typeName === "Card") return v.v.get("label") ?? str(display(v));
      return str(display(v));
    }),
    /** Baccarat/blackjack pip value: 10/J/Q/K -> 10 (baccarat: 0), A -> 1 */
    pip: native("Card.pip", 1, (args) => {
      const rank = cardRank(args[0]);
      if (rank === "A") return int(1);
      if (["10", "J", "Q", "K"].includes(rank)) return int(10);
      return int(Number(rank));
    }),
  });
}

export function makeBaccaratNamespace(): Value {
  const pip = (v: Value): number => {
    const rank = cardRank(v);
    if (rank === "A") return 1;
    if (["10", "J", "Q", "K"].includes(rank)) return 0;
    return Number(rank);
  };

  return namespace("Baccarat", {
    /** Baccarat total: sum of pips modulo 10 */
    total: native("Baccarat.total", 1, (args) => {
      const cards = asList("Baccarat.total", args[0]);
      return int(cards.reduce((acc, c) => acc + pip(c), 0) % 10);
    }),

    /** Does the player draw a third card? Player draws on 0-5. */
    playerDraws: native("Baccarat.playerDraws", 1, (args) =>
      bool(asNumber("Baccarat.playerDraws", args[0]) <= 5),
    ),

    /**
     * Standard punto banco banker drawing rule.
     * Baccarat.bankerDraws(bankerTotal, playerThirdPip) — pass -1 when the
     * player stood.
     */
    bankerDraws: native("Baccarat.bankerDraws", 2, (args) => {
      const banker = asNumber("Baccarat.bankerDraws", args[0]);
      const third = asNumber("Baccarat.bankerDraws", args[1]);
      if (banker <= 2) return bool(true);
      if (banker >= 7) return bool(false);
      if (third < 0) return bool(banker <= 5);
      switch (banker) {
        case 3:
          return bool(third !== 8);
        case 4:
          return bool(third >= 2 && third <= 7);
        case 5:
          return bool(third >= 4 && third <= 7);
        case 6:
          return bool(third === 6 || third === 7);
        default:
          return bool(false);
      }
    }),

    /** Baccarat.winner(playerTotal, bankerTotal) -> "Player" | "Banker" | "Tie" */
    winner: native("Baccarat.winner", 2, (args) => {
      const p = asNumber("Baccarat.winner", args[0]);
      const b = asNumber("Baccarat.winner", args[1]);
      if (p > b) return str("Player");
      if (b > p) return str("Banker");
      return str("Tie");
    }),

    /** Payout multiplier for a bet on a given outcome (banker commission 5%). */
    payout: native("Baccarat.payout", 2, (args) => {
      const bet = asString("Baccarat.payout", args[0]);
      const outcome = asString("Baccarat.payout", args[1]);
      if (bet === outcome) {
        if (bet === "Banker") return float(1.95);
        if (bet === "Tie") return float(9.0);
        return float(2.0);
      }
      if (outcome === "Tie" && bet !== "Tie") return float(1.0); // push
      return float(0.0);
    }),

    isNatural: native("Baccarat.isNatural", 1, (args) => {
      const t = asNumber("Baccarat.isNatural", args[0]);
      return bool(t === 8 || t === 9);
    }),
  });
}

export function makePokerNamespace(): Value {
  return namespace("Poker", {
    /** Poker.rank(cards) -> record { name, score } for a 5-card hand */
    rank: native("Poker.rank", 1, (args) => {
      const cards = asList("Poker.rank", args[0]);
      const values = cards
        .map((c) => (c.t === "record" ? Number((c.v.get("value") as { v: number } | undefined)?.v ?? 0) : 0))
        .sort((a, b) => b - a);
      const suits = cards.map((c) =>
        c.t === "record" ? String((c.v.get("suit") as { v: string } | undefined)?.v ?? "") : "",
      );

      const counts = new Map<number, number>();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      const groups = [...counts.values()].sort((a, b) => b - a);
      const flush = suits.every((s) => s === suits[0]);
      const unique = [...new Set(values)].sort((a, b) => b - a);
      const straight =
        unique.length === 5 && (unique[0] - unique[4] === 4 || (unique[0] === 14 && unique[1] === 5));

      let name = "High Card";
      let score = 1;
      if (straight && flush) {
        name = values[0] === 14 && values[1] === 13 ? "Royal Flush" : "Straight Flush";
        score = name === "Royal Flush" ? 10 : 9;
      } else if (groups[0] === 4) {
        name = "Four of a Kind";
        score = 8;
      } else if (groups[0] === 3 && groups[1] === 2) {
        name = "Full House";
        score = 7;
      } else if (flush) {
        name = "Flush";
        score = 6;
      } else if (straight) {
        name = "Straight";
        score = 5;
      } else if (groups[0] === 3) {
        name = "Three of a Kind";
        score = 4;
      } else if (groups[0] === 2 && groups[1] === 2) {
        name = "Two Pair";
        score = 3;
      } else if (groups[0] === 2) {
        name = "One Pair";
        score = 2;
      }

      const m = new Map<string, Value>();
      m.set("name", str(name));
      m.set("score", int(score));
      m.set("high", int(values[0] ?? 0));
      return record(m, "HandRank");
    }),
  });
}

export function makeDiceNamespace(host: RngHost): Value {
  // A die is derived from a single uniform draw so that a player recomputing
  // `Fair.draw(...)` by hand arrives at exactly the same face.
  const rollFace = (faces: number): number => Math.floor(host.current().nextFloat() * faces) + 1;

  return namespace("Dice", {
    roll: native("Dice.roll", -1, (args) => {
      const faces = args.length > 0 ? asNumber("Dice.roll", args[0]) : 6;
      return int(rollFace(faces));
    }),
    rollMany: native("Dice.rollMany", 2, (args) => {
      const count = asNumber("Dice.rollMany", args[0]);
      const faces = asNumber("Dice.rollMany", args[1]);
      const out: Value[] = [];
      for (let i = 0; i < count; i++) out.push(int(rollFace(faces)));
      return list(out);
    }),
    total: native("Dice.total", 1, (args) =>
      int(asList("Dice.total", args[0]).reduce((a, d) => a + asNumber("Dice.total", d), 0)),
    ),
  });
}

// ------------------------------------------------------------------ Money

export function makeMoneyNamespace(): Value {
  return namespace("Money", {
    of: native("Money.of", -1, (args) => {
      const units = asNumber("Money.of", args[0]);
      const satang = args.length > 1 ? asNumber("Money.of", args[1]) : 0;
      const currency = args.length > 2 ? asString("Money.of", args[2]) : "THB";
      return moneyFromUnits(units, satang, currency);
    }),
    zero: native("Money.zero", -1, (args) =>
      money(0n, args.length > 0 ? asString("Money.zero", args[0]) : "THB"),
    ),
    /** Multiply money by an integer or a ratio expressed as numerator/denominator. */
    scale: native("Money.scale", -1, (args) => {
      const m = args[0];
      if (m.t !== "money") argErr("Money.scale", "first argument must be Money");
      if (args.length === 2) {
        const factor = asNumber("Money.scale", args[1]);
        // exact scaling through integers: multiply by numerator, divide by 10^k
        const scaled = (m.v * BigInt(Math.round(factor * 1_000_000))) / 1_000_000n;
        return money(scaled, m.currency);
      }
      const num = BigInt(Math.trunc(asNumber("Money.scale", args[1])));
      const den = BigInt(Math.trunc(asNumber("Money.scale", args[2])));
      if (den === 0n) argErr("Money.scale", "denominator must not be zero");
      return money((m.v * num) / den, m.currency);
    }),
    add: native("Money.add", 2, (args) => {
      const a = args[0];
      const b = args[1];
      if (a.t !== "money" || b.t !== "money") argErr("Money.add", "both arguments must be Money");
      if (a.currency !== b.currency) {
        argErr("Money.add", `cannot add ${a.currency} to ${b.currency}`);
      }
      return money(a.v + b.v, a.currency);
    }),
    sub: native("Money.sub", 2, (args) => {
      const a = args[0];
      const b = args[1];
      if (a.t !== "money" || b.t !== "money") argErr("Money.sub", "both arguments must be Money");
      return money(a.v - b.v, a.currency);
    }),
    isZero: native("Money.isZero", 1, (args) => {
      const m = args[0];
      return bool(m.t === "money" ? m.v === 0n : false);
    }),
    toFloat: native("Money.toFloat", 1, (args) => float(moneyToNumber(args[0]))),
    /** Divide with an explicit remainder, so no fraction is silently lost. */
    divide: native("Money.divide", 2, (args) => {
      const m = args[0];
      if (m.t !== "money") argErr("Money.divide", "first argument must be Money");
      const n = BigInt(Math.trunc(asNumber("Money.divide", args[1])));
      if (n === 0n) argErr("Money.divide", "cannot divide by zero");
      const r = new Map<string, Value>();
      r.set("quotient", money(m.v / n, m.currency));
      r.set("remainder", money(m.v % n, m.currency));
      return record(r, "Division");
    }),
    format: native("Money.format", 1, (args) => str(display(args[0]))),
  });
}

// ------------------------------------------------------------------ Provably fair

export function makeFairNamespace(host: RngHost): Value {
  return namespace("Fair", {
    /** Fair.begin(clientSeed?) -> ceremony record with a published commitment */
    begin: native("Fair.begin", -1, (args) => {
      const serverSeed = ceremonySeedHex(host, 32);
      const clientSeed = args.length > 0 ? asString("Fair.begin", args[0]) : ceremonySeedHex(host, 8);
      const m = new Map<string, Value>();
      m.set("serverSeed", str(serverSeed));
      m.set("clientSeed", str(clientSeed));
      m.set("commitment", str(sha256Hex(serverSeed)));
      m.set("nonce", int(0));
      m.set("revealed", bool(false));
      return record(m, "Ceremony");
    }),

    /** Fair.use(ceremony, nonce) — install a FairRng derived from the ceremony */
    use: native("Fair.use", 2, (args) => {
      const c = args[0];
      if (c.t !== "record" || c.typeName !== "Ceremony") argErr("Fair.use", "expected a Ceremony");
      const revealed = c.v.get("revealed");
      if (revealed && revealed.t === "bool" && revealed.v) {
        argErr("Fair.use", "this ceremony has been revealed and can no longer produce draws");
      }
      const serverSeed = asString("Fair.use", c.v.get("serverSeed")!);
      const clientSeed = asString("Fair.use", c.v.get("clientSeed")!);
      const nonce = asNumber("Fair.use", args[1]);
      host.setCurrent(new FairRng(serverSeed, clientSeed, nonce));
      return UNIT;
    }),

    commitment: native("Fair.commitment", 1, (args) => {
      const c = args[0];
      if (c.t !== "record") argErr("Fair.commitment", "expected a Ceremony");
      return c.v.get("commitment") ?? str("");
    }),

    /** Fair.reveal(ceremony) -> a new record with the seed disclosed */
    reveal: native("Fair.reveal", 1, (args) => {
      const c = args[0];
      if (c.t !== "record" || c.typeName !== "Ceremony") argErr("Fair.reveal", "expected a Ceremony");
      const m = new Map(c.v);
      m.set("revealed", bool(true));
      // mark the original as consumed, mirroring the linear-resource rule
      c.v.set("revealed", bool(true));
      return record(m, "RevealedCeremony");
    }),

    /** Fair.verify(serverSeed, commitment) -> does the seed match the commitment? */
    verify: native("Fair.verify", 2, (args) =>
      bool(sha256Hex(asString("Fair.verify", args[0])) === asString("Fair.verify", args[1])),
    ),

    /** Fair.draw(serverSeed, clientSeed, nonce, cursor) -> deterministic float */
    draw: native("Fair.draw", 4, (args) => {
      const rng = new FairRng(
        asString("Fair.draw", args[0]),
        asString("Fair.draw", args[1]),
        asNumber("Fair.draw", args[2]),
      );
      const cursor = asNumber("Fair.draw", args[3]);
      let v = 0;
      for (let i = 0; i <= cursor; i++) v = rng.nextFloat();
      return float(v);
    }),

    hash: native("Fair.hash", 1, (args) => str(sha256Hex(asString("Fair.hash", args[0])))),
  });
}

// ------------------------------------------------------------------ RTP

export interface RtpHost extends RngHost {
  callFunction(fn: Value, args: Value[]): Value;
}

export function makeRtpNamespace(host: RtpHost): Value {
  return namespace("Rtp", {
    /**
     * Rtp.estimate(spinFn, rounds, bet) -> record { rtp, hitRate, maxWin, rounds }
     *
     * The prototype's stand-in for the compile-time RTP obligation: it runs the
     * supplied resolver against a reproducible generator and reports the return.
     */
    estimate: native("Rtp.estimate", -1, (args) => {
      const fn = args[0];
      const rounds = args.length > 1 ? asNumber("Rtp.estimate", args[1]) : 100_000;
      const betValue = args.length > 2 ? asNumber("Rtp.estimate", args[2]) : 1;

      let totalWin = 0;
      let hits = 0;
      let maxWin = 0;

      for (let i = 0; i < rounds; i++) {
        const result = host.callFunction(fn, []);
        const win = extractWin(result);
        totalWin += win;
        if (win > 0) hits += 1;
        if (win > maxWin) maxWin = win;
      }

      const staked = rounds * betValue;
      const m = new Map<string, Value>();
      m.set("rtp", float(staked > 0 ? totalWin / staked : 0));
      m.set("hitRate", float(rounds > 0 ? hits / rounds : 0));
      m.set("maxWin", float(maxWin));
      m.set("rounds", int(rounds));
      m.set("totalWin", float(totalWin));
      return record(m, "RtpReport");
    }),

    /** Rtp.check(actual, target, tolerance) -> bool, the prototype's obligation */
    check: native("Rtp.check", 3, (args) => {
      const actual = asNumber("Rtp.check", args[0]);
      const target = asNumber("Rtp.check", args[1]);
      const tol = asNumber("Rtp.check", args[2]);
      const t = target > 1 ? target / 100 : target;
      return bool(Math.abs(actual - t) <= tol);
    }),

    /** Volatility index from a sample of wins relative to the bet. */
    volatility: native("Rtp.volatility", -1, (args) => {
      const samples = asList("Rtp.volatility", args[0]).map((v) => asNumber("Rtp.volatility", v));
      if (samples.length < 2) return float(0);
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (samples.length - 1);
      return float(Math.sqrt(variance));
    }),
  });
}

function extractWin(result: Value): number {
  if (result.t === "int" || result.t === "float") return result.v;
  if (result.t === "money") return moneyToNumber(result);
  if (result.t === "record") {
    for (const key of ["win", "payout", "total", "amount"]) {
      const v = result.v.get(key);
      if (v && (v.t === "int" || v.t === "float")) return v.v;
      if (v && v.t === "money") return moneyToNumber(v);
    }
  }
  return 0;
}

// ------------------------------------------------------------------ Math

export function makeMathNamespace(): Value {
  return namespace("Math", {
    pi: float(Math.PI),
    e: float(Math.E),
    floor: native("Math.floor", 1, (args) => int(Math.floor(numeric(args[0])))),
    ceil: native("Math.ceil", 1, (args) => int(Math.ceil(numeric(args[0])))),
    round: native("Math.round", 1, (args) => int(Math.round(numeric(args[0])))),
    abs: native("Math.abs", 1, (args) => float(Math.abs(numeric(args[0])))),
    sqrt: native("Math.sqrt", 1, (args) => float(Math.sqrt(numeric(args[0])))),
    pow: native("Math.pow", 2, (args) => float(Math.pow(numeric(args[0]), numeric(args[1])))),
    min: native("Math.min", -1, (args) => float(Math.min(...args.map(numeric)))),
    max: native("Math.max", -1, (args) => float(Math.max(...args.map(numeric)))),
  });
}

export { MONEY_SCALE };
