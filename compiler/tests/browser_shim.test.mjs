/**
 * The browser build replaces `node:crypto` with a hand-written shim. A fairness
 * ceremony committed in a browser must be verifiable on a server, so the two
 * implementations have to agree exactly. This compares them directly.
 */

import { createHash, createHmac } from "node:crypto";
import { createHash as shimHash, createHmac as shimHmac, randomBytes as shimRandom } from "../dist/browser/crypto_shim.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function compare(label, expected, actual) {
  if (expected === actual) {
    passed += 1;
    console.log(`  ${GREEN}ok${RESET}    ${label}`);
  } else {
    failed += 1;
    console.log(`  ${RED}FAIL${RESET}  ${label}`);
    console.log(`        node: ${expected}`);
    console.log(`        shim: ${actual}`);
  }
}

const vectors = [
  "",
  "a",
  "abc",
  "sunra",
  "The quick brown fox jumps over the lazy dog",
  // 55, 56, 57 and 64 bytes exercise every padding boundary in SHA-256.
  "x".repeat(55),
  "x".repeat(56),
  "x".repeat(57),
  "x".repeat(64),
  "x".repeat(1000),
  "ผู้เล่นตรวจสอบได้",
  JSON.stringify({ nonce: 42, clientSeed: "player-supplied" }),
];

console.log("\nBrowser crypto shim vs node:crypto\n");
console.log("SHA-256:");
for (const vector of vectors) {
  const label = vector.length > 24 ? `${vector.slice(0, 21)}… (${vector.length} chars)` : JSON.stringify(vector);
  compare(
    label,
    createHash("sha256").update(vector).digest("hex"),
    shimHash("sha256").update(vector).digest("hex"),
  );
}

console.log("\nHMAC-SHA256 (the construction that derives every round):");
for (const key of ["server-seed", "x".repeat(64), "x".repeat(100), "ก"]) {
  for (const message of ["0", "player-seed:0", "player-seed:999999"]) {
    compare(
      `key ${key.length} bytes, message ${JSON.stringify(message)}`,
      createHmac("sha256", key).update(message).digest("hex"),
      shimHmac("sha256", key).update(message).digest("hex"),
    );
  }
}

console.log("\nChained update() calls:");
compare(
  "three updates equal one concatenated update",
  createHash("sha256").update("a").update("b").update("c").digest("hex"),
  shimHash("sha256").update("a").update("b").update("c").digest("hex"),
);

// Padding is where a hand-written SHA-256 goes wrong, and it goes wrong at one
// specific length rather than everywhere, so sweep every boundary instead of
// sampling. This caught a real over-allocation at exactly 55 bytes.
console.log("\nEvery message length from 0 to 300 bytes:");
let sweepMismatches = 0;
for (let n = 0; n <= 300; n++) {
  const message = "a".repeat(n);
  if (
    createHash("sha256").update(message).digest("hex") !==
    shimHash("sha256").update(message).digest("hex")
  ) {
    sweepMismatches += 1;
    console.log(`  ${RED}FAIL${RESET}  length ${n}`);
  }
}
compare("301 consecutive lengths all match node:crypto", 0, sweepMismatches);

console.log("\nBuffer compatibility (the secure generator reads a 64-bit integer):");
const bytes = shimRandom(8);
const asInt = bytes.readBigUInt64BE(0);
compare(
  "readBigUInt64BE returns a 64-bit value",
  true,
  typeof asInt === "bigint" && asInt >= 0n && asInt < 2n ** 64n,
);
compare("randomBytes returns the requested length", 8, bytes.length);
compare("hex encoding is 2 chars per byte", 16, shimRandom(8).toString("hex").length);

const first = shimRandom(16).toString("hex");
const second = shimRandom(16).toString("hex");
compare("consecutive draws differ", true, first !== second);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
