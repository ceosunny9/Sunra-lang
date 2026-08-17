import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Sunra randomness sources.
 *
 * The whitepaper separates generator *kinds* at the type level. The prototype
 * keeps that separation as distinct classes behind one interface, with
 * `SimRng` reproducible from a seed and `FairRng` reproducible by the player
 * from published commit/reveal material.
 */
export interface SunraRng {
  readonly kind: "secure" | "sim" | "fair" | "replay";
  /** Uniform 53-bit float in [0, 1). */
  nextFloat(): number;
  /** Unbiased integer in [lo, hi) using rejection sampling. */
  range(lo: number, hi: number): number;
  /** Number of draws consumed so far — useful for audit records. */
  readonly draws: number;
}

/** xoshiro256** — fast, well-distributed, reproducible from a seed. */
export class SimRng implements SunraRng {
  readonly kind = "sim" as const;
  private s: [bigint, bigint, bigint, bigint];
  private _draws = 0;

  constructor(seed: string | number | bigint = "sunra-default-seed") {
    const h = createHash("sha256").update(String(seed)).digest();
    this.s = [
      h.readBigUInt64BE(0) | 1n,
      h.readBigUInt64BE(8) | 1n,
      h.readBigUInt64BE(16) | 1n,
      h.readBigUInt64BE(24) | 1n,
    ];
  }

  get draws(): number {
    return this._draws;
  }

  private nextU64(): bigint {
    const MASK = (1n << 64n) - 1n;
    const rotl = (x: bigint, k: bigint) => ((x << k) | (x >> (64n - k))) & MASK;

    const result = (rotl((this.s[1] * 5n) & MASK, 7n) * 9n) & MASK;
    const t = (this.s[1] << 17n) & MASK;

    this.s[2] ^= this.s[0];
    this.s[3] ^= this.s[1];
    this.s[1] ^= this.s[2];
    this.s[0] ^= this.s[3];
    this.s[2] ^= t;
    this.s[3] = rotl(this.s[3], 45n);

    this._draws += 1;
    return result;
  }

  nextFloat(): number {
    // top 53 bits -> [0,1)
    return Number(this.nextU64() >> 11n) / 2 ** 53;
  }

  range(lo: number, hi: number): number {
    return unbiasedRange(() => this.nextU64(), lo, hi);
  }

  /** Deterministic substream derivation, as described in the whitepaper. */
  static split(seed: string | number, index: number): SimRng {
    return new SimRng(`${seed}:${index}`);
  }
}

/** OS entropy. Not reproducible; the only source sanctioned for live play. */
export class SecureRng implements SunraRng {
  readonly kind = "secure" as const;
  private _draws = 0;

  get draws(): number {
    return this._draws;
  }

  private nextU64(): bigint {
    this._draws += 1;
    return randomBytes(8).readBigUInt64BE(0);
  }

  nextFloat(): number {
    return Number(this.nextU64() >> 11n) / 2 ** 53;
  }

  range(lo: number, hi: number): number {
    return unbiasedRange(() => this.nextU64(), lo, hi);
  }
}

/**
 * Provably fair generator: outcomes are HMAC-SHA256(serverSeed, clientSeed:nonce:cursor).
 * The server publishes SHA-256(serverSeed) before play and reveals serverSeed at
 * rotation, so a player can recompute every draw.
 */
export class FairRng implements SunraRng {
  readonly kind = "fair" as const;
  private cursor = 0;
  private _draws = 0;

  constructor(
    readonly serverSeed: string,
    readonly clientSeed: string,
    readonly nonce: number,
  ) {}

  get draws(): number {
    return this._draws;
  }

  get commitment(): string {
    return createHash("sha256").update(this.serverSeed).digest("hex");
  }

  private bytesAt(cursor: number): Buffer {
    return createHmac("sha256", this.serverSeed)
      .update(`${this.clientSeed}:${this.nonce}:${cursor}`)
      .digest();
  }

  nextFloat(): number {
    const buf = this.bytesAt(this.cursor);
    this.cursor += 1;
    this._draws += 1;
    // use the first 7 bytes as a 56-bit integer, scaled into [0,1)
    let acc = 0;
    for (let i = 0; i < 7; i++) acc = acc * 256 + buf[i];
    return acc / 2 ** 56;
  }

  range(lo: number, hi: number): number {
    const span = hi - lo;
    if (span <= 0) return lo;
    // rejection sampling over 32-bit words to remain unbiased
    const limit = Math.floor(0x1_0000_0000 / span) * span;
    for (;;) {
      const buf = this.bytesAt(this.cursor);
      this.cursor += 1;
      this._draws += 1;
      const word = buf.readUInt32BE(0);
      if (word < limit) return lo + (word % span);
    }
  }

  /** Verification data an operator publishes for a round. */
  proof(): Record<string, string | number> {
    return {
      commitment: this.commitment,
      clientSeed: this.clientSeed,
      nonce: this.nonce,
      algorithm: "HMAC-SHA256(serverSeed, clientSeed:nonce:cursor)",
    };
  }
}

/** Replays a recorded sequence of floats — used for dispute investigation. */
export class ReplayRng implements SunraRng {
  readonly kind = "replay" as const;
  private index = 0;
  private _draws = 0;

  constructor(private readonly log: number[]) {}

  get draws(): number {
    return this._draws;
  }

  nextFloat(): number {
    const v = this.log[this.index % this.log.length];
    this.index += 1;
    this._draws += 1;
    return v;
  }

  range(lo: number, hi: number): number {
    return lo + Math.floor(this.nextFloat() * (hi - lo));
  }
}

function unbiasedRange(nextU64: () => bigint, lo: number, hi: number): number {
  const span = BigInt(Math.trunc(hi) - Math.trunc(lo));
  if (span <= 0n) return Math.trunc(lo);
  const limit = ((1n << 64n) / span) * span;
  for (;;) {
    const x = nextU64();
    if (x < limit) return Math.trunc(lo) + Number(x % span);
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomSeedHex(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}
