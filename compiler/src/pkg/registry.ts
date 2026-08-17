/**
 * The Sunra package registry and dependency resolver.
 *
 * A production registry is a network service. What matters at this stage is the
 * *shape* of the contract: how packages are named, how versions are requested,
 * how a lockfile pins them, and where sources are vendored. Those decisions are
 * expensive to change later, so they are made here and exercised end to end
 * against a local registry that ships with the toolchain.
 *
 * The bundled registry contains the first-party gaming libraries described in
 * the whitepaper. Third-party packages resolve from a `path` dependency, which
 * is also how a studio would vendor its private libraries today.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { Dependency, Manifest } from "./manifest.js";

export interface RegistryPackage {
  name: string;
  versions: string[];
  description: string;
  /** Effects the package's public surface may perform. */
  effects: string[];
  /** Sunra modules the package exports. */
  modules: string[];
  license: string;
  firstParty: boolean;
}

export interface ResolvedPackage {
  name: string;
  version: string;
  source: "registry" | "path" | "git";
  location: string;
  effects: string[];
  modules: string[];
  dev: boolean;
}

export interface Lockfile {
  version: 1;
  generated: string;
  packages: Array<{
    name: string;
    version: string;
    source: string;
    location: string;
    integrity: string;
  }>;
}

/**
 * The first-party registry. These are the libraries a gaming studio needs on day
 * one, and each declares the effects it performs so that a dependency cannot
 * quietly introduce randomness or network access into a pure module.
 */
export const BUILTIN_REGISTRY: RegistryPackage[] = [
  {
    name: "sunra-std",
    versions: ["0.1.0", "0.2.0"],
    description: "The Sunra standard library: math, string, array, json, crypto, timer, http, file.",
    effects: ["io", "net", "fs"],
    modules: ["math", "string", "array", "json", "crypto", "timer", "http", "file"],
    license: "MIT",
    firstParty: true,
  },
  {
    name: "sunra-gaming",
    versions: ["0.1.0", "0.2.0"],
    description: "Reels, cards, decks, dice, money and RTP verification primitives.",
    effects: ["rand", "money"],
    modules: ["reel", "card", "deck", "dice", "money", "rtp"],
    license: "MIT",
    firstParty: true,
  },
  {
    name: "sunra-fair",
    versions: ["0.1.0", "0.2.0"],
    description: "Provably fair commit/reveal ceremonies over HMAC-SHA256.",
    effects: ["rand", "audit"],
    modules: ["fair", "commitment", "verify"],
    license: "MIT",
    firstParty: true,
  },
  {
    name: "sunra-slots",
    versions: ["0.1.0"],
    description: "Slot mechanics: paylines, ways, cascading reels, free spin state machines.",
    effects: ["rand"],
    modules: ["payline", "cascade", "freespin", "paytable"],
    license: "MIT",
    firstParty: true,
  },
  {
    name: "sunra-tables",
    versions: ["0.1.0"],
    description: "Table games: baccarat, blackjack, roulette, sic bo and poker evaluation.",
    effects: ["rand"],
    modules: ["baccarat", "blackjack", "roulette", "sicbo", "poker"],
    license: "MIT",
    firstParty: true,
  },
  {
    name: "sunra-chain",
    versions: ["0.1.0"],
    description: "Hash-linked settlement ledgers and on-chain fairness attestation.",
    effects: ["chain", "audit"],
    modules: ["ledger", "block", "attest"],
    license: "MIT",
    firstParty: true,
  },
  {
    name: "sunra-ai",
    versions: ["0.1.0"],
    description: "Model invocation, prompt templates and intent verification helpers.",
    effects: ["ai", "net"],
    modules: ["model", "prompt", "intent"],
    license: "MIT",
    firstParty: true,
  },
  {
    name: "sunra-regulation",
    versions: ["0.1.0"],
    description: "Jurisdiction rule packs: RTP floors, bet limits and mandatory disclosures.",
    effects: ["audit"],
    modules: ["mga", "ukgc", "curacao", "limits"],
    license: "MIT",
    firstParty: true,
  },
];

export function findPackage(name: string): RegistryPackage | undefined {
  return BUILTIN_REGISTRY.find((pkg) => pkg.name === name);
}

export function searchPackages(query: string): RegistryPackage[] {
  const needle = query.toLowerCase();
  return BUILTIN_REGISTRY.filter(
    (pkg) =>
      pkg.name.includes(needle) ||
      pkg.description.toLowerCase().includes(needle) ||
      pkg.modules.some((m) => m.includes(needle)),
  );
}

// ------------------------------------------------------------- version logic

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemVer(text: string): SemVer | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Test a version against a requirement. Caret and tilde carry their usual
 * meanings; a bare version means "at least this, within the same major".
 */
export function satisfies(version: string, requirement: string): boolean {
  if (requirement.trim() === "*") return true;

  const actual = parseSemVer(version);
  if (!actual) return false;

  const text = requirement.trim();
  const operator = /^[\^~]|^>=|^<=|^>|^</.exec(text)?.[0] ?? "";
  const wanted = parseSemVer(text.slice(operator.length).trim());
  if (!wanted) return false;

  const cmp = compareSemVer(actual, wanted);

  switch (operator) {
    case "^":
      // Compatible within the same major, except below 1.0 where the minor
      // version carries the compatibility guarantee.
      if (wanted.major === 0) return actual.major === 0 && actual.minor === wanted.minor && cmp >= 0;
      return actual.major === wanted.major && cmp >= 0;
    case "~":
      return actual.major === wanted.major && actual.minor === wanted.minor && cmp >= 0;
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    default:
      return actual.major === wanted.major && cmp >= 0;
  }
}

/** Pick the highest version of `pkg` that satisfies `requirement`. */
export function bestVersion(pkg: RegistryPackage, requirement: string): string | null {
  const candidates = pkg.versions
    .filter((v) => satisfies(v, requirement))
    .map((v) => ({ text: v, parsed: parseSemVer(v) }))
    .filter((v): v is { text: string; parsed: SemVer } => v.parsed !== null)
    .sort((a, b) => compareSemVer(b.parsed, a.parsed));

  return candidates.length > 0 ? candidates[0].text : null;
}

// ---------------------------------------------------------------- resolution

export interface ResolutionResult {
  resolved: ResolvedPackage[];
  problems: string[];
}

export function resolveDependencies(manifest: Manifest, projectDir: string): ResolutionResult {
  const resolved: ResolvedPackage[] = [];
  const problems: string[] = [];

  for (const dep of manifest.dependencies) {
    const outcome = resolveOne(dep, projectDir);
    if (typeof outcome === "string") problems.push(outcome);
    else resolved.push(outcome);
  }

  // A dependency that performs an effect the package does not declare is a
  // supply-chain risk, so it is surfaced as a problem rather than a note.
  const declared = new Set(effectsOfManifest(manifest));
  for (const pkg of resolved) {
    for (const effect of pkg.effects) {
      if (!declared.has(effect) && declared.size > 0) {
        problems.push(
          `${pkg.name} performs the \`${effect}\` effect, which this package does not declare`,
        );
      }
    }
  }

  return { resolved, problems };
}

function effectsOfManifest(manifest: Manifest): string[] {
  const raw = manifest.raw["effects"];
  if (Array.isArray(raw)) return raw.map((v) => String(v));
  return [];
}

function resolveOne(dep: Dependency, projectDir: string): ResolvedPackage | string {
  if (dep.path !== undefined) {
    const location = isAbsolute(dep.path) ? dep.path : resolve(projectDir, dep.path);
    if (!existsSync(location)) {
      return `${dep.name}: path dependency does not exist: ${dep.path}`;
    }
    return {
      name: dep.name,
      version: dep.version,
      source: "path",
      location,
      effects: [],
      modules: [],
      dev: dep.dev,
    };
  }

  if (dep.git !== undefined) {
    return {
      name: dep.name,
      version: dep.version,
      source: "git",
      location: dep.git,
      effects: [],
      modules: [],
      dev: dep.dev,
    };
  }

  const pkg = findPackage(dep.name);
  if (!pkg) {
    const suggestion = suggestName(dep.name);
    return (
      `${dep.name}: not found in the registry` +
      (suggestion ? ` (did you mean \`${suggestion}\`?)` : "")
    );
  }

  const version = bestVersion(pkg, dep.version);
  if (!version) {
    return `${dep.name}: no published version satisfies "${dep.version}" (available: ${pkg.versions.join(", ")})`;
  }

  return {
    name: pkg.name,
    version,
    source: "registry",
    location: `https://registry.sunra.dev/${pkg.name}/${version}`,
    effects: pkg.effects,
    modules: pkg.modules,
    dev: dep.dev,
  };
}

function suggestName(name: string): string | null {
  let best: { name: string; distance: number } | null = null;
  for (const pkg of BUILTIN_REGISTRY) {
    const distance = editDistance(name, pkg.name);
    if (distance <= 4 && (best === null || distance < best.distance)) {
      best = { name: pkg.name, distance };
    }
  }
  return best?.name ?? null;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const grid: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      grid[i][j] = Math.min(grid[i - 1][j] + 1, grid[i][j - 1] + 1, grid[i - 1][j - 1] + cost);
    }
  }
  return grid[rows - 1][cols - 1];
}

// ------------------------------------------------------------------ lockfile

/**
 * A small, dependency-free content digest. A production lockfile would carry a
 * SHA-256 of the package tarball; the important property here is that the
 * lockfile format has a slot for integrity from the very first version.
 */
export function integrityOf(name: string, version: string, location: string): string {
  const input = `${name}@${version}:${location}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 = ((h1 ^ input.charCodeAt(i)) * 0x01000193) >>> 0;
    h2 = ((h2 + input.charCodeAt(i) * (i + 1)) * 0x85ebca6b) >>> 0;
  }
  return `sunra1-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export function buildLockfile(resolved: ResolvedPackage[]): Lockfile {
  return {
    version: 1,
    generated: new Date().toISOString(),
    packages: resolved
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        source: pkg.source,
        location: pkg.location,
        integrity: integrityOf(pkg.name, pkg.version, pkg.location),
      })),
  };
}

export function writeLockfile(path: string, lock: Lockfile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(lock, null, 2) + "\n", "utf8");
}

export function readLockfile(path: string): Lockfile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Lockfile;
  } catch {
    return null;
  }
}

/**
 * Vendor resolved registry packages into `sunra_modules/`. Each package is
 * written as a Sunra source stub that re-exports the built-in module surface,
 * which keeps `use` statements honest while the network registry is unbuilt.
 */
export function vendorPackages(projectDir: string, resolved: ResolvedPackage[]): string[] {
  const written: string[] = [];
  const root = join(projectDir, "sunra_modules");

  for (const pkg of resolved) {
    if (pkg.source !== "registry") continue;

    const dir = join(root, pkg.name);
    mkdirSync(dir, { recursive: true });

    const manifestPath = join(dir, "sunra.toml");
    writeFileSync(
      manifestPath,
      [
        "# Vendored by `sunra pkg install` — do not edit.",
        "[package]",
        `name = ${JSON.stringify(pkg.name)}`,
        `version = ${JSON.stringify(pkg.version)}`,
        `description = ${JSON.stringify(findPackage(pkg.name)?.description ?? "")}`,
        "",
        "[effects]",
        `declared = [${pkg.effects.map((e) => JSON.stringify(e)).join(", ")}]`,
        "",
      ].join("\n"),
      "utf8",
    );
    written.push(manifestPath);

    for (const moduleName of pkg.modules) {
      const modulePath = join(dir, `${moduleName}.sun`);
      writeFileSync(
        modulePath,
        [
          `# ${pkg.name}/${moduleName} ${pkg.version}`,
          "#",
          "# This module is provided by the Sunra runtime. The stub exists so that",
          "# `use` statements resolve and so that an auditor can see exactly which",
          "# modules a build depends on.",
          "",
          `module ${moduleName}`,
          "",
        ].join("\n"),
        "utf8",
      );
      written.push(modulePath);
    }
  }

  return written;
}
