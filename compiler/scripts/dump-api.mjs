/**
 * Print the real method surface of every runtime namespace.
 *
 * Documentation drifts from implementation unless it is derived from it, so the
 * API reference on the website is generated from this output rather than typed
 * out by hand.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const g = await import(resolve(root, "dist/runtime/gaming.js"));

const host = {
  current: () => ({
    kind: "sim",
    nextFloat: () => 0.5,
    nextInt: () => 0,
    nextBigInt: () => 0n,
  }),
  setCurrent: () => {},
  callFunction: () => ({ t: "unit" }),
};

const factories = {
  rng: g.makeRngNamespace,
  Reel: g.makeReelNamespace,
  Deck: g.makeDeckNamespace,
  Card: g.makeCardNamespace,
  Baccarat: g.makeBaccaratNamespace,
  Poker: g.makePokerNamespace,
  Dice: g.makeDiceNamespace,
  Money: g.makeMoneyNamespace,
  Fair: g.makeFairNamespace,
  Rtp: g.makeRtpNamespace,
  Math: g.makeMathNamespace,
};

const out = {};
for (const [name, make] of Object.entries(factories)) {
  const value = make.length > 0 ? make(host) : make();
  const members = value?.members ?? value?.v;
  out[name] = members instanceof Map ? [...members.keys()].sort() : Object.keys(members ?? {}).sort();
}

// The eight stdlib modules only exist in the emitted runtime, so read their
// shape from the generated source text.
const { RUNTIME_SOURCE } = await import(resolve(root, "dist/codegen/runtime_source.js"));
for (const ns of ["String", "Array", "Json", "Crypto", "Timer", "Http", "File", "Math"]) {
  const marker = `export const ${ns} = {`;
  const start = RUNTIME_SOURCE.indexOf(marker);
  if (start === -1) continue;
  // Walk braces to find the matching close.
  let depth = 0;
  let end = start + marker.length - 1;
  for (let i = start + marker.length - 1; i < RUNTIME_SOURCE.length; i++) {
    if (RUNTIME_SOURCE[i] === "{") depth++;
    else if (RUNTIME_SOURCE[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = RUNTIME_SOURCE.slice(start, end);
  const keys = [...body.matchAll(/^\s{2}(\w+)\s*[(:]/gm)].map((m) => m[1]);
  out[`stdlib:${ns}`] = [...new Set(keys)].sort();
}

console.log(JSON.stringify(out, null, 1));
