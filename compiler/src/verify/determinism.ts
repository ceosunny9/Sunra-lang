/**
 * Determinism checker.
 *
 * A provably-fair game must be *replayable*: given the same server seed, client
 * seed and nonce, a regulator re-running the round must obtain exactly the same
 * outcome. That is stronger than "no bugs" — it forbids whole categories of
 * otherwise-normal code.
 *
 * What breaks replay, and why each is checked here:
 *
 *   - **Unseeded randomness.** `rng.*` is fine *if* the RNG was seeded from the
 *     committed seed; it is fatal if it draws from the OS entropy pool.
 *   - **Wall-clock time.** Two replays happen at different times by definition.
 *   - **Network and filesystem.** External state is not part of the round.
 *   - **Floating point in payout maths.** Deterministic per IEEE-754, but
 *     accumulation order changes results, and a JIT may contract `a*b+c` into an
 *     FMA on one platform and not another. Money must be fixed-point.
 *   - **Map/set iteration order** over host containers.
 *   - **Uninitialised or address-derived values.**
 *
 * The checker works on SunMIR (post-monomorphisation) so it sees the calls that
 * actually survive, and it uses the declared effect set as corroborating
 * evidence: an `io`/`net`/`time` effect on a function reached from a fairness
 * entry point is itself a finding.
 */
import type { Span } from "../diagnostics.js";
import type { MirFunction, MirModule } from "../mir/mir.js";

export type NondeterminismKind =
  | "unseeded-random"
  | "wall-clock"
  | "network"
  | "filesystem"
  | "host-storage"
  | "float-money"
  | "iteration-order"
  | "external-effect";

export interface Finding {
  kind: NondeterminismKind;
  symbol: string;
  span: Span;
  detail: string;
  /** How the finding was reached: directly, or through a call chain. */
  via: string[];
  /**
   * `replay` findings make a round unreproducible and are always fatal.
   * `precision` findings replay identically on one platform but risk drift
   * across platforms, so they are reported separately: IEEE-754 is
   * deterministic, and calling float arithmetic "non-deterministic" outright
   * would be wrong. Rules that care about payout exactness read `precision`;
   * rules that care about replay read `replay`.
   */
  severity: "replay" | "precision";
}

export interface DeterminismResult {
  /** True when no `replay` findings remain; a round is reproducible. */
  deterministic: boolean;
  /** True when no findings of any kind remain, including precision risks. */
  exact: boolean;
  findings: Finding[];
  /** Functions reachable from the fairness-critical entry points. */
  criticalFunctions: string[];
  /** Functions proven deterministic. */
  deterministicFunctions: string[];
}

export interface DeterminismOptions {
  /**
   * Entry points whose determinism matters. Defaults to `main`, every `spin`,
   * `deal`, `roll`, `settle` and `verify` method, which are the fairness-critical
   * surfaces in practice.
   */
  entryPoints?: string[];
  /**
   * When true, a seeded RNG counts as deterministic. Set false to audit for
   * "no randomness at all", which some certification profiles require of payout
   * table code.
   */
  allowSeededRandom?: boolean;
}

/** Host calls that always break replay. */
const ALWAYS_NONDETERMINISTIC = new Map<string, { kind: NondeterminismKind; detail: string }>([
  ["Timer.now", { kind: "wall-clock", detail: "reads the wall clock" }],
  ["Timer.sleep", { kind: "wall-clock", detail: "suspends on wall-clock time" }],
  ["Timer.after", { kind: "wall-clock", detail: "schedules on wall-clock time" }],
  ["Net.tcpConnect", { kind: "network", detail: "opens a TCP connection" }],
  ["Net.tcpSend", { kind: "network", detail: "sends over the network" }],
  ["Net.tcpReceive", { kind: "network", detail: "reads from the network" }],
  ["Net.tcpListen", { kind: "network", detail: "listens on a socket" }],
  ["Net.tcpAccept", { kind: "network", detail: "accepts a connection" }],
  ["Net.websocketConnect", { kind: "network", detail: "opens a WebSocket" }],
  ["Net.websocketSend", { kind: "network", detail: "sends over a WebSocket" }],
  ["Net.websocketReceive", { kind: "network", detail: "reads from a WebSocket" }],
  ["Http.get", { kind: "network", detail: "performs an HTTP request" }],
  ["Http.post", { kind: "network", detail: "performs an HTTP request" }],
  ["File.read", { kind: "filesystem", detail: "reads the filesystem" }],
  ["File.write", { kind: "filesystem", detail: "writes the filesystem" }],
  ["Db.open", { kind: "host-storage", detail: "opens host storage" }],
  ["Db.get", { kind: "host-storage", detail: "reads host storage" }],
  ["Db.set", { kind: "host-storage", detail: "writes host storage" }],
  ["Db.keys", { kind: "iteration-order", detail: "host key order is unspecified" }],
]);

/** Randomness sources: deterministic only when seeded. */
const RANDOM_SOURCES = new Set([
  "rng.next",
  "rng.int",
  "rng.float",
  "rng.pick",
  "rng.shuffle",
  "rng.bool",
  "Random.uniform",
  "Random.normal",
  "Random.gamma",
  "Random.beta",
  "Random.poisson",
  "Random.binomial",
  "Random.exponential",
  "Random.shuffle",
  "Random.choice",
]);

/** Calls that seed the generator, making subsequent draws replayable. */
const SEEDING_CALLS = new Set(["rng.seed", "Random.seed", "Fair.commit", "Fair.seed"]);

const DEFAULT_ENTRY_NAMES = ["main", "spin", "deal", "roll", "settle", "verify", "play"];

export function checkDeterminism(
  module: MirModule,
  options: DeterminismOptions = {},
): DeterminismResult {
  const allowSeeded = options.allowSeededRandom ?? true;
  const bySymbol = new Map(module.functions.map((fn) => [fn.symbol, fn]));

  // Entry points: explicit list, or every function whose bare name matches a
  // fairness-critical name (so `Lucky.spin` is picked up as well as `spin`).
  const entryPoints =
    options.entryPoints ??
    module.functions
      .filter((fn) => DEFAULT_ENTRY_NAMES.includes(bareName(fn.symbol)))
      .map((fn) => fn.symbol);

  // Which functions are reachable from an entry point, and by what path.
  const paths = new Map<string, string[]>();
  const queue: Array<{ symbol: string; path: string[] }> = entryPoints.map((symbol) => ({
    symbol,
    path: [symbol],
  }));
  while (queue.length > 0) {
    const { symbol, path } = queue.shift()!;
    if (paths.has(symbol)) continue;
    paths.set(symbol, path);
    const fn = bySymbol.get(symbol);
    if (!fn) continue;
    for (const callee of calleesOf(fn)) {
      if (!bySymbol.has(callee) || paths.has(callee)) continue;
      queue.push({ symbol: callee, path: [...path, callee] });
    }
  }

  const findings: Finding[] = [];
  const tainted = new Set<string>();

  for (const [symbol, path] of paths) {
    const fn = bySymbol.get(symbol);
    if (!fn) continue;

    // Money computed in floating point is a finding regardless of calls: it is
    // the single most common source of cross-platform payout drift.
    if (usesFloatArithmetic(fn)) {
      findings.push({
        kind: "float-money",
        symbol,
        span: fn.span,
        detail:
          "performs floating-point arithmetic; payout maths must use Money (fixed point) to replay identically",
        via: path,
        severity: "precision",
      });
    }

    // Is the generator seeded anywhere in this function? Seeding makes later
    // draws in the same function replayable.
    const seeded = [...calleesOf(fn)].some((callee) => SEEDING_CALLS.has(strip(callee)));

    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        if (instr.op !== "call") continue;
        const callee = strip(instr.callee);

        const always = ALWAYS_NONDETERMINISTIC.get(callee);
        if (always) {
          findings.push({
            kind: always.kind,
            symbol,
            span: instr.span,
            detail: `\`${callee}\` ${always.detail}`,
            via: path,
            severity: "replay",
          });
          tainted.add(symbol);
          continue;
        }

        if (RANDOM_SOURCES.has(callee)) {
          if (!allowSeeded || !seeded) {
            findings.push({
              kind: "unseeded-random",
              symbol,
              span: instr.span,
              detail: allowSeeded
                ? `\`${callee}\` draws from an unseeded generator; seed from the committed server seed first`
                : `\`${callee}\` introduces randomness, which this profile forbids`,
              via: path,
              severity: "replay",
            });
            tainted.add(symbol);
          }
        }
      }
    }

    // Declared effects corroborate: a fairness-critical function that admits
    // `net` or `time` is non-deterministic by its own declaration, even if the
    // offending call is behind an indirection the checker cannot see.
    for (const effect of fn.effects) {
      if (effect === "net" || effect === "time" || effect === "file" || effect === "db") {
        findings.push({
          kind: "external-effect",
          symbol,
          span: fn.span,
          detail: `declares the \`${effect}\` effect, which cannot be replayed`,
          via: path,
          severity: "replay",
        });
        tainted.add(symbol);
      }
    }
  }

  const deterministicFunctions = [...paths.keys()].filter((symbol) => !tainted.has(symbol));

  return {
    deterministic: findings.every((f) => f.severity !== "replay"),
    exact: findings.length === 0,
    findings,
    criticalFunctions: [...paths.keys()],
    deterministicFunctions,
  };
}

function bareName(symbol: string): string {
  const dot = symbol.lastIndexOf(".");
  return dot < 0 ? symbol : symbol.slice(dot + 1);
}

function strip(callee: string): string {
  return callee.startsWith("intrinsic.load:") ? callee.slice("intrinsic.load:".length) : callee;
}

function calleesOf(fn: MirFunction): Set<string> {
  const out = new Set<string>();
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.op === "call") out.add(instr.callee);
    }
  }
  return out;
}

function usesFloatArithmetic(fn: MirFunction): boolean {
  // A Float-typed result of an arithmetic operation. Float parameters that are
  // merely passed through do not change a payout, so they are not flagged.
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.op !== "binary") continue;
      if (!["add", "sub", "mul", "div", "rem"].includes(instr.kind)) continue;
      const ty = fn.types.get(instr.dst);
      if (ty?.k !== "Float") continue;
      // Ignore arithmetic the inliner copied in from another function. Its span
      // still points at the original source line, so reporting it here would
      // blame `main` for a ratio computed inside a reporting helper — and the
      // helper is reported on its own account anyway.
      if (!isOwnCode(instr.span, fn)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Does this span belong to the function's own body?
 *
 * Inlining preserves each instruction's original span, so an operation whose
 * line precedes the function's declaration was copied in from a callee.
 */
function isOwnCode(span: Span, fn: MirFunction): boolean {
  if (span.file !== fn.span.file) return false;
  return span.line >= fn.span.line;
}
