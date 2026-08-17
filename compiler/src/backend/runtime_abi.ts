/**
 * The one authoritative ABI table for the runtime namespaces (`Reel`, `Deck`,
 * `Card`, `Dice`, `Poker`, `Baccarat`, `Fair`, `Money`, `Rtp`, `Math`, `rng`).
 *
 * Every native backend must agree with the interpreter about what these
 * functions return. When the checker leaves a namespace call `Unknown`, the LLVM
 * backend used to fall back to the aggregate representation (`ptr`), which then
 * collided with consumers that expected `i64`, `i1` or `double`
 * (`icmp eq i64 %pip`, `ret i64`, `br i1`). Recording the shape here once keeps
 * the `declare` line, the `call` instruction and the SunVM host bridge in sync.
 *
 * The types are the compiler's surface types, so `llvmType` maps them onto
 * `i64` / `double` / `i1` / `ptr` exactly as it does for user functions:
 *   Int -> i64, Float -> double, Bool -> i1, Str/List/Record -> ptr, Unit -> void
 */

export type AbiKind = "Int" | "Float" | "Bool" | "Str" | "Ref" | "Unit";

export interface RuntimeAbi {
  /** Fully qualified runtime symbol, e.g. `Card.pip`. */
  readonly symbol: string;
  /** Parameter shapes; a variadic tail is expressed by `variadic`. */
  readonly params: readonly AbiKind[];
  /** Extra arguments beyond `params` are allowed and passed as this shape. */
  readonly variadic?: AbiKind;
  readonly ret: AbiKind;
}

/**
 * Return shapes mirror `src/runtime/gaming.ts` exactly:
 *   `int(...)`   -> Int      `float(...)`  -> Float
 *   `bool(...)`  -> Bool     `str(...)`    -> Str
 *   `list(...)` / `record(...)` / `money(...)` -> Ref
 *   `UNIT`       -> Unit
 */
const TABLE: readonly RuntimeAbi[] = [
  // ------------------------------------------------------------------ rng
  { symbol: "rng.pick", params: ["Ref"], variadic: "Int", ret: "Ref" },
  { symbol: "rng.weighted", params: ["Ref", "Ref"], ret: "Ref" },
  { symbol: "rng.int", params: ["Int", "Int"], ret: "Int" },
  { symbol: "rng.float", params: [], ret: "Float" },
  { symbol: "rng.bool", params: [], ret: "Bool" },
  { symbol: "rng.chance", params: ["Float"], ret: "Bool" },
  { symbol: "rng.shuffle", params: ["Ref"], ret: "Ref" },
  { symbol: "rng.seed", params: ["Str"], ret: "Unit" },
  { symbol: "rng.kind", params: [], ret: "Str" },
  { symbol: "rng.draws", params: [], ret: "Int" },

  // ------------------------------------------------------------------ Reel
  { symbol: "Reel.of", params: ["Ref"], variadic: "Ref", ret: "Ref" },
  { symbol: "Reel.spin", params: ["Ref"], variadic: "Int", ret: "Ref" },
  { symbol: "Reel.grid", params: ["Ref", "Int", "Int"], ret: "Ref" },
  { symbol: "Reel.count", params: ["Ref", "Ref"], ret: "Int" },
  { symbol: "Reel.isMatch", params: ["Ref"], ret: "Bool" },
  { symbol: "Reel.longestRun", params: ["Ref"], ret: "Int" },

  // ------------------------------------------------------------------ Deck
  { symbol: "Deck.standard", params: [], variadic: "Int", ret: "Ref" },
  { symbol: "Deck.shuffled", params: [], variadic: "Int", ret: "Ref" },
  { symbol: "Deck.deal", params: ["Ref", "Int"], ret: "Ref" },
  { symbol: "Deck.size", params: ["Ref"], ret: "Int" },

  // ------------------------------------------------------------------ Card
  { symbol: "Card.of", params: ["Str", "Str"], ret: "Ref" },
  { symbol: "Card.rank", params: ["Ref"], ret: "Str" },
  { symbol: "Card.label", params: ["Ref"], ret: "Str" },
  { symbol: "Card.pip", params: ["Ref"], ret: "Int" },

  // -------------------------------------------------------------- Baccarat
  { symbol: "Baccarat.total", params: ["Ref"], ret: "Int" },
  { symbol: "Baccarat.playerDraws", params: ["Int"], ret: "Bool" },
  { symbol: "Baccarat.bankerDraws", params: ["Int", "Int"], ret: "Bool" },
  { symbol: "Baccarat.winner", params: ["Int", "Int"], ret: "Str" },
  { symbol: "Baccarat.payout", params: ["Str", "Str"], ret: "Float" },
  { symbol: "Baccarat.isNatural", params: ["Int"], ret: "Bool" },

  // ----------------------------------------------------------------- Poker
  { symbol: "Poker.rank", params: ["Ref"], ret: "Ref" },

  // ------------------------------------------------------------------ Dice
  { symbol: "Dice.roll", params: [], variadic: "Int", ret: "Int" },
  { symbol: "Dice.rollMany", params: ["Int", "Int"], ret: "Ref" },
  { symbol: "Dice.total", params: ["Ref"], ret: "Int" },

  // ----------------------------------------------------------------- Money
  { symbol: "Money.of", params: ["Int"], variadic: "Int", ret: "Ref" },
  { symbol: "Money.zero", params: [], variadic: "Str", ret: "Ref" },
  { symbol: "Money.scale", params: ["Ref"], variadic: "Float", ret: "Ref" },
  { symbol: "Money.add", params: ["Ref", "Ref"], ret: "Ref" },
  { symbol: "Money.sub", params: ["Ref", "Ref"], ret: "Ref" },
  { symbol: "Money.isZero", params: ["Ref"], ret: "Bool" },
  { symbol: "Money.toFloat", params: ["Ref"], ret: "Float" },
  { symbol: "Money.divide", params: ["Ref", "Int"], ret: "Ref" },
  { symbol: "Money.format", params: ["Ref"], ret: "Str" },

  // ------------------------------------------------------------------ Fair
  { symbol: "Fair.begin", params: [], variadic: "Str", ret: "Ref" },
  { symbol: "Fair.use", params: ["Ref", "Int"], ret: "Unit" },
  { symbol: "Fair.commitment", params: ["Ref"], ret: "Str" },
  { symbol: "Fair.reveal", params: ["Ref"], ret: "Ref" },
  { symbol: "Fair.verify", params: ["Str", "Str"], ret: "Bool" },
  { symbol: "Fair.draw", params: ["Str", "Str", "Int", "Int"], ret: "Float" },
  { symbol: "Fair.hash", params: ["Str"], ret: "Str" },

  // ------------------------------------------------------------------- Rtp
  { symbol: "Rtp.estimate", params: ["Ref"], variadic: "Float", ret: "Ref" },
  { symbol: "Rtp.check", params: ["Float", "Float", "Float"], ret: "Bool" },
  { symbol: "Rtp.volatility", params: ["Ref"], variadic: "Float", ret: "Float" },

  // ------------------------------------------------------------------ Math
  { symbol: "Math.floor", params: ["Float"], ret: "Int" },
  { symbol: "Math.ceil", params: ["Float"], ret: "Int" },
  { symbol: "Math.round", params: ["Float"], ret: "Int" },
  { symbol: "Math.abs", params: ["Float"], ret: "Float" },
  { symbol: "Math.sqrt", params: ["Float"], ret: "Float" },
  { symbol: "Math.pow", params: ["Float", "Float"], ret: "Float" },
  { symbol: "Math.min", params: ["Float"], variadic: "Float", ret: "Float" },
  { symbol: "Math.max", params: ["Float"], variadic: "Float", ret: "Float" },
];

const BY_SYMBOL = new Map<string, RuntimeAbi>(TABLE.map((entry) => [entry.symbol, entry]));

/** Namespaces the table owns; a call on any of these must resolve here. */
export const RUNTIME_NAMESPACES: ReadonlySet<string> = new Set(
  TABLE.map((entry) => entry.symbol.slice(0, entry.symbol.indexOf("."))),
);

/** Look a runtime function up by its qualified name, e.g. `Card.pip`. */
export function runtimeAbi(symbol: string): RuntimeAbi | null {
  return BY_SYMBOL.get(symbol) ?? null;
}

/** True when `symbol` names a namespace the table owns (even if the member is unknown). */
export function isRuntimeNamespaceCall(symbol: string): boolean {
  const dot = symbol.indexOf(".");
  if (dot < 0) return false;
  return RUNTIME_NAMESPACES.has(symbol.slice(0, dot));
}

/** Every entry, for declaration emission and cross-backend tests. */
export function runtimeAbiTable(): readonly RuntimeAbi[] {
  return TABLE;
}
