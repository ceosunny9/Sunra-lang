/**
 * A drop-in replacement for the three `node:crypto` functions the runtime uses,
 * implemented against Web Crypto and a self-contained SHA-256.
 *
 * The hash has to be synchronous because the interpreter's `Fair` module calls
 * it inside expression evaluation, while `crypto.subtle` is promise-based. So
 * SHA-256 and HMAC are implemented directly here. The implementation is the same
 * one already verified byte-for-byte against `node:crypto` in the compiled
 * runtime, which is what lets a fairness ceremony started in the browser be
 * re-verified later on a server.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 over bytes, returning the 32-byte digest. */
export function sha256Bytes(input: Uint8Array): Uint8Array {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLength = input.length * 8;
  // A message needs its 0x80 marker plus 8 length bytes, rounded up to a
  // 64-byte block. `(len + 9 + 63) & ~63` is that round-up; the naive
  // `((len + 9) >> 6) + 1` over-allocates a block when len + 9 is an exact
  // multiple of 64 (len = 55), which silently changes the digest.
  const withPadding = new Uint8Array((input.length + 9 + 63) & ~63);
  withPadding.set(input);
  withPadding[input.length] = 0x80;

  const view = new DataView(withPadding.buffer);
  // Length is 64-bit big endian; inputs here never approach 2^32 bits.
  view.setUint32(withPadding.length - 4, bitLength >>> 0, false);
  view.setUint32(withPadding.length - 8, Math.floor(bitLength / 0x100000000), false);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i], false);
  return out;
}

function hmacSha256Bytes(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64;
  let normalizedKey = key;
  if (normalizedKey.length > blockSize) normalizedKey = sha256Bytes(normalizedKey);

  const padded = new Uint8Array(blockSize);
  padded.set(normalizedKey);

  const inner = new Uint8Array(blockSize + message.length);
  const outer = new Uint8Array(blockSize + 32);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = padded[i] ^ 0x36;
    outer[i] = padded[i] ^ 0x5c;
  }
  inner.set(message, blockSize);
  outer.set(sha256Bytes(inner), blockSize);
  return sha256Bytes(outer);
}

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? new TextEncoder().encode(input) : input;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The digest object the runtime expects. Only the subset the Sunra runtime
 * actually calls is implemented: `update`, then `digest` as hex, as a byte
 * buffer, or read as a big-endian 64-bit integer.
 */
class Digest {
  private chunks: Uint8Array[] = [];

  constructor(private readonly hmacKey: Uint8Array | null) {}

  update(data: string | Uint8Array): this {
    this.chunks.push(toBytes(data));
    return this;
  }

  private compute(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return this.hmacKey ? hmacSha256Bytes(this.hmacKey, joined) : sha256Bytes(joined);
  }

  digest(encoding?: "hex"): string | BufferLike {
    const bytes = this.compute();
    return encoding === "hex" ? toHex(bytes) : wrap(bytes);
  }
}

export interface BufferLike extends Uint8Array {
  readBigUInt64BE(offset?: number): bigint;
  toString(encoding?: string): string;
}

/** Give a byte array the two Buffer methods the runtime relies on. */
function wrap(bytes: Uint8Array): BufferLike {
  const buffer = bytes as BufferLike;
  buffer.readBigUInt64BE = (offset = 0) => {
    let value = 0n;
    for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(bytes[offset + i] ?? 0);
    return value;
  };
  buffer.toString = ((encoding?: string) =>
    encoding === "hex" ? toHex(bytes) : new TextDecoder().decode(bytes)) as BufferLike["toString"];
  return buffer;
}

export function createHash(algorithm: string): Digest {
  if (algorithm !== "sha256") {
    throw new Error(`the browser build of Sunra only implements sha256, not ${algorithm}`);
  }
  return new Digest(null);
}

export function createHmac(algorithm: string, key: string | Uint8Array): Digest {
  if (algorithm !== "sha256") {
    throw new Error(`the browser build of Sunra only implements sha256, not ${algorithm}`);
  }
  return new Digest(toBytes(key));
}

/** Cryptographically secure bytes from the platform generator. */
export function randomBytes(size: number): BufferLike {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return wrap(bytes);
}

export default { createHash, createHmac, randomBytes };
