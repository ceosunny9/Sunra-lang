/**
 * `sunra pkg` — the package manager command surface.
 *
 * Subcommands are intentionally boring and predictable: init, add, remove, list,
 * install, search, info, tree, check, and validate. Anyone who has used cargo or
 * npm should need no documentation to get started, and the output is designed to
 * be read in a terminal during an audit rather than parsed by a script.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  defaultManifest,
  readManifest,
  validateManifest,
  writeManifest,
  type Dependency,
  type Manifest,
} from "./manifest.js";
import {
  BUILTIN_REGISTRY,
  bestVersion,
  buildLockfile,
  findPackage,
  readLockfile,
  resolveDependencies,
  searchPackages,
  vendorPackages,
  writeLockfile,
} from "./registry.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

export const MANIFEST_NAME = "sunra.toml";
export const LOCKFILE_NAME = "sunra.lock";

export interface PkgContext {
  /** Directory the command was invoked from. */
  cwd: string;
  /** Remaining positional arguments after `pkg <subcommand>`. */
  args: string[];
  /** Whether `--json` was passed. */
  json: boolean;
  /** Whether `--dev` was passed. */
  dev: boolean;
}

export interface PkgOutcome {
  ok: boolean;
  message?: string;
}

/** Walk upwards looking for a manifest, the way cargo and npm do. */
export function findManifestDir(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, MANIFEST_NAME))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadManifest(dir: string): Manifest {
  return readManifest(readFileSync(join(dir, MANIFEST_NAME), "utf8"));
}

function saveManifest(dir: string, manifest: Manifest): void {
  writeFileSync(join(dir, MANIFEST_NAME), writeManifest(manifest), "utf8");
}

function requireProject(ctx: PkgContext): { dir: string; manifest: Manifest } | null {
  const dir = findManifestDir(ctx.cwd);
  if (dir === null) {
    console.error(`${RED}error${RESET}: no ${MANIFEST_NAME} found in this directory or any parent`);
    console.error(`${DIM}hint: create one with \`sunra pkg init\`${RESET}`);
    return null;
  }
  return { dir, manifest: loadManifest(dir) };
}

// ------------------------------------------------------------------- init

export function pkgInit(ctx: PkgContext): PkgOutcome {
  const dir = resolve(ctx.cwd);
  const target = join(dir, MANIFEST_NAME);

  if (existsSync(target)) {
    return { ok: false, message: `${MANIFEST_NAME} already exists in ${dir}` };
  }

  const name = (ctx.args[0] ?? basename(dir))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const manifest = defaultManifest(name || "sunra-package");
  manifest.package.description = `The ${manifest.package.name} Sunra package.`;
  manifest.dependencies.push({ name: "sunra-std", version: "^0.2.0", dev: false });

  saveManifest(dir, manifest);

  // A new project gets a source directory and a runnable entry point, because a
  // package manager that leaves you with nothing to run is not much use.
  const srcDir = join(dir, "src");
  mkdirSync(srcDir, { recursive: true });

  const entry = join(dir, manifest.package.entry);
  if (!existsSync(entry)) {
    mkdirSync(resolve(entry, ".."), { recursive: true });
    writeFileSync(
      entry,
      [
        `# ${manifest.package.name} — entry point`,
        "",
        "fn main() uses io {",
        `    print("${manifest.package.name} is running on Sunra.")`,
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  if (ctx.json) {
    console.log(JSON.stringify({ created: MANIFEST_NAME, name: manifest.package.name }, null, 2));
    return { ok: true };
  }

  console.log(`${GREEN}created${RESET} ${MANIFEST_NAME}`);
  console.log(`${GREEN}created${RESET} ${manifest.package.entry}`);
  console.log();
  console.log(`  package    ${BOLD}${manifest.package.name}${RESET} ${manifest.package.version}`);
  console.log(`  edition    ${manifest.package.edition}`);
  console.log(`  target     ${manifest.build.target}`);
  console.log();
  console.log(`${DIM}next: sunra run ${manifest.package.entry}${RESET}`);
  return { ok: true };
}

// -------------------------------------------------------------------- add

export function pkgAdd(ctx: PkgContext): PkgOutcome {
  const project = requireProject(ctx);
  if (!project) return { ok: false };

  const spec = ctx.args[0];
  if (!spec) return { ok: false, message: "usage: sunra pkg add <name>[@version] [--dev]" };

  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const requested = at > 0 ? spec.slice(at + 1) : null;

  const known = findPackage(name);
  if (!known) {
    const alternatives = searchPackages(name.replace(/^sunra-/, ""));
    let message = `\`${name}\` is not in the registry`;
    if (alternatives.length > 0) {
      message += `\n${DIM}available: ${alternatives.map((p) => p.name).join(", ")}${RESET}`;
    }
    return { ok: false, message };
  }

  const requirement = requested ?? `^${known.versions[known.versions.length - 1]}`;
  const version = bestVersion(known, requirement);
  if (!version) {
    return {
      ok: false,
      message: `no version of ${name} satisfies "${requirement}" (available: ${known.versions.join(", ")})`,
    };
  }

  const { dir, manifest } = project;
  const existing = manifest.dependencies.find((d) => d.name === name);

  if (existing) {
    existing.version = requirement;
    existing.dev = ctx.dev;
  } else {
    manifest.dependencies.push({ name, version: requirement, dev: ctx.dev });
  }

  saveManifest(dir, manifest);

  const { resolved } = resolveDependencies(manifest, dir);
  writeLockfile(join(dir, LOCKFILE_NAME), buildLockfile(resolved));

  if (ctx.json) {
    console.log(JSON.stringify({ added: name, requirement, resolved: version }, null, 2));
    return { ok: true };
  }

  console.log(
    `${GREEN}${existing ? "updated" : "added"}${RESET} ${BOLD}${name}${RESET} ${requirement} ${DIM}-> ${version}${RESET}${ctx.dev ? ` ${DIM}(dev)${RESET}` : ""}`,
  );
  console.log(`  ${DIM}${known.description}${RESET}`);
  if (known.effects.length > 0) {
    console.log(`  ${YELLOW}effects${RESET}  ${known.effects.join(", ")}`);
  }
  console.log(`  ${DIM}modules  ${known.modules.join(", ")}${RESET}`);
  console.log();
  console.log(`${DIM}lockfile updated: ${LOCKFILE_NAME}${RESET}`);
  return { ok: true };
}

// ----------------------------------------------------------------- remove

export function pkgRemove(ctx: PkgContext): PkgOutcome {
  const project = requireProject(ctx);
  if (!project) return { ok: false };

  const name = ctx.args[0];
  if (!name) return { ok: false, message: "usage: sunra pkg remove <name>" };

  const { dir, manifest } = project;
  const before = manifest.dependencies.length;
  manifest.dependencies = manifest.dependencies.filter((d) => d.name !== name);

  if (manifest.dependencies.length === before) {
    return { ok: false, message: `\`${name}\` is not a dependency of this package` };
  }

  saveManifest(dir, manifest);
  const { resolved } = resolveDependencies(manifest, dir);
  writeLockfile(join(dir, LOCKFILE_NAME), buildLockfile(resolved));

  if (ctx.json) {
    console.log(JSON.stringify({ removed: name }, null, 2));
    return { ok: true };
  }

  console.log(`${GREEN}removed${RESET} ${BOLD}${name}${RESET}`);
  return { ok: true };
}

// ------------------------------------------------------------------- list

export function pkgList(ctx: PkgContext): PkgOutcome {
  const project = requireProject(ctx);
  if (!project) return { ok: false };

  const { dir, manifest } = project;
  const { resolved, problems } = resolveDependencies(manifest, dir);
  const lock = readLockfile(join(dir, LOCKFILE_NAME));

  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          package: manifest.package,
          gaming: manifest.gaming,
          build: manifest.build,
          dependencies: resolved,
          problems,
          locked: lock !== null,
        },
        null,
        2,
      ),
    );
    return { ok: problems.length === 0 };
  }

  console.log();
  console.log(
    `${BOLD}${manifest.package.name}${RESET} ${manifest.package.version} ${DIM}(${manifest.package.edition} edition)${RESET}`,
  );
  if (manifest.package.description) console.log(`${DIM}${manifest.package.description}${RESET}`);
  console.log();

  if (manifest.gaming.rtpTarget !== null) {
    const target = (manifest.gaming.rtpTarget * 100).toFixed(2);
    const tolerance =
      manifest.gaming.rtpTolerance === null
        ? "unset"
        : `${(manifest.gaming.rtpTolerance * 100).toFixed(2)}%`;
    console.log(`  ${CYAN}declared RTP${RESET}   ${target}% ${DIM}(tolerance ${tolerance})${RESET}`);
  }
  if (manifest.gaming.provablyFair) {
    console.log(`  ${CYAN}fairness${RESET}       provably fair (commit/reveal)`);
  }
  if (manifest.gaming.jurisdictions.length > 0) {
    console.log(`  ${CYAN}jurisdictions${RESET}  ${manifest.gaming.jurisdictions.join(", ")}`);
  }
  console.log(`  ${CYAN}build target${RESET}   ${manifest.build.target}`);
  console.log();

  const runtime = resolved.filter((p) => !p.dev);
  const dev = resolved.filter((p) => p.dev);

  printDependencyGroup("dependencies", runtime);
  if (dev.length > 0) printDependencyGroup("dev-dependencies", dev);

  if (manifest.dependencies.length === 0) {
    console.log(`  ${DIM}no dependencies${RESET}`);
    console.log();
  }

  if (problems.length > 0) {
    console.log(`${RED}${problems.length} problem(s)${RESET}`);
    for (const problem of problems) console.log(`  ${RED}!${RESET} ${problem}`);
    console.log();
    return { ok: false };
  }

  console.log(
    lock === null
      ? `${DIM}no lockfile; run \`sunra pkg install\` to pin these versions${RESET}`
      : `${DIM}locked by ${LOCKFILE_NAME} (${lock.packages.length} package(s))${RESET}`,
  );
  return { ok: true };
}

function printDependencyGroup(title: string, packages: ReturnType<typeof resolveDependencies>["resolved"]): void {
  if (packages.length === 0) return;
  console.log(`  ${BOLD}${title}${RESET}`);
  for (const pkg of packages) {
    const source = pkg.source === "registry" ? "" : ` ${DIM}(${pkg.source})${RESET}`;
    console.log(`    ${GREEN}${pkg.name.padEnd(20)}${RESET} ${pkg.version}${source}`);
    if (pkg.effects.length > 0) {
      console.log(`      ${DIM}effects: ${pkg.effects.join(", ")}${RESET}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------- install

export function pkgInstall(ctx: PkgContext): PkgOutcome {
  const project = requireProject(ctx);
  if (!project) return { ok: false };

  const { dir, manifest } = project;
  const { resolved, problems } = resolveDependencies(manifest, dir);

  if (problems.length > 0) {
    if (ctx.json) {
      console.log(JSON.stringify({ installed: 0, problems }, null, 2));
    } else {
      for (const problem of problems) console.error(`${RED}error${RESET}: ${problem}`);
    }
    return { ok: false };
  }

  const written = vendorPackages(dir, resolved);
  const lock = buildLockfile(resolved);
  writeLockfile(join(dir, LOCKFILE_NAME), lock);

  if (ctx.json) {
    console.log(JSON.stringify({ installed: resolved.length, files: written.length, lock }, null, 2));
    return { ok: true };
  }

  console.log();
  console.log(`${BOLD}Installing ${resolved.length} package(s)${RESET}`);
  for (const pkg of resolved) {
    console.log(`  ${GREEN}+${RESET} ${pkg.name.padEnd(20)} ${pkg.version} ${DIM}${pkg.source}${RESET}`);
  }
  console.log();
  console.log(`  vendored ${written.length} file(s) into sunra_modules/`);
  console.log(`  wrote ${LOCKFILE_NAME} with ${lock.packages.length} pinned package(s)`);
  console.log();
  console.log(`${DIM}every dependency's effects are recorded in the lockfile for audit${RESET}`);
  return { ok: true };
}

// ----------------------------------------------------------------- search

export function pkgSearch(ctx: PkgContext): PkgOutcome {
  const query = ctx.args[0] ?? "";
  const results = query === "" ? BUILTIN_REGISTRY : searchPackages(query);

  if (ctx.json) {
    console.log(JSON.stringify(results, null, 2));
    return { ok: true };
  }

  console.log();
  console.log(
    query === ""
      ? `${BOLD}Sunra registry${RESET} ${DIM}(${results.length} package(s))${RESET}`
      : `${BOLD}Search: ${query}${RESET} ${DIM}(${results.length} match(es))${RESET}`,
  );
  console.log();

  if (results.length === 0) {
    console.log(`  ${DIM}nothing matched${RESET}`);
    return { ok: true };
  }

  for (const pkg of results) {
    const latest = pkg.versions[pkg.versions.length - 1];
    console.log(`  ${GREEN}${pkg.name.padEnd(20)}${RESET} ${latest.padEnd(8)} ${DIM}${pkg.license}${RESET}`);
    console.log(`    ${pkg.description}`);
    console.log(`    ${DIM}modules: ${pkg.modules.join(", ")}${RESET}`);
    if (pkg.effects.length > 0) {
      console.log(`    ${YELLOW}effects: ${pkg.effects.join(", ")}${RESET}`);
    }
    console.log();
  }

  console.log(`${DIM}add one with: sunra pkg add <name>${RESET}`);
  return { ok: true };
}

// ------------------------------------------------------------------- info

export function pkgInfo(ctx: PkgContext): PkgOutcome {
  const name = ctx.args[0];
  if (!name) return { ok: false, message: "usage: sunra pkg info <name>" };

  const pkg = findPackage(name);
  if (!pkg) return { ok: false, message: `\`${name}\` is not in the registry` };

  if (ctx.json) {
    console.log(JSON.stringify(pkg, null, 2));
    return { ok: true };
  }

  console.log();
  console.log(`${BOLD}${pkg.name}${RESET}`);
  console.log(`${pkg.description}`);
  console.log();
  console.log(`  versions   ${pkg.versions.join(", ")}`);
  console.log(`  license    ${pkg.license}`);
  console.log(`  origin     ${pkg.firstParty ? "first-party (SuncoreAI)" : "community"}`);
  console.log(`  modules    ${pkg.modules.join(", ")}`);
  console.log(`  effects    ${pkg.effects.length > 0 ? pkg.effects.join(", ") : "none (pure)"}`);
  console.log();
  console.log(`${DIM}sunra pkg add ${pkg.name}${RESET}`);
  return { ok: true };
}

// ------------------------------------------------------------------- tree

export function pkgTree(ctx: PkgContext): PkgOutcome {
  const project = requireProject(ctx);
  if (!project) return { ok: false };

  const { dir, manifest } = project;
  const { resolved } = resolveDependencies(manifest, dir);

  if (ctx.json) {
    console.log(JSON.stringify({ root: manifest.package.name, dependencies: resolved }, null, 2));
    return { ok: true };
  }

  console.log();
  console.log(`${BOLD}${manifest.package.name}${RESET} ${manifest.package.version}`);

  resolved.forEach((pkg, index) => {
    const last = index === resolved.length - 1;
    const branch = last ? "└──" : "├──";
    const dev = pkg.dev ? ` ${DIM}(dev)${RESET}` : "";
    console.log(`${branch} ${GREEN}${pkg.name}${RESET} ${pkg.version}${dev}`);

    const indent = last ? "    " : "│   ";
    if (pkg.modules.length > 0) {
      console.log(`${indent}${DIM}modules: ${pkg.modules.join(", ")}${RESET}`);
    }
    if (pkg.effects.length > 0) {
      console.log(`${indent}${YELLOW}effects: ${pkg.effects.join(", ")}${RESET}`);
    }
  });

  if (resolved.length === 0) console.log(`${DIM}(no dependencies)${RESET}`);
  console.log();
  return { ok: true };
}

// ------------------------------------------------------------- check/validate

export function pkgCheck(ctx: PkgContext): PkgOutcome {
  const project = requireProject(ctx);
  if (!project) return { ok: false };

  const { dir, manifest } = project;
  const manifestProblems = validateManifest(manifest);
  const { resolved, problems: resolutionProblems } = resolveDependencies(manifest, dir);
  const lock = readLockfile(join(dir, LOCKFILE_NAME));

  const lockProblems: string[] = [];
  if (lock !== null) {
    for (const pkg of resolved) {
      const pinned = lock.packages.find((p) => p.name === pkg.name);
      if (!pinned) {
        lockProblems.push(`${pkg.name} is not pinned in ${LOCKFILE_NAME}; run \`sunra pkg install\``);
      } else if (pinned.version !== pkg.version) {
        lockProblems.push(
          `${pkg.name} resolves to ${pkg.version} but ${LOCKFILE_NAME} pins ${pinned.version}`,
        );
      }
    }
  }

  const all = [...manifestProblems, ...resolutionProblems, ...lockProblems];

  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          ok: all.length === 0,
          manifest: manifestProblems,
          resolution: resolutionProblems,
          lockfile: lockProblems,
        },
        null,
        2,
      ),
    );
    return { ok: all.length === 0 };
  }

  console.log();
  if (all.length === 0) {
    console.log(`${GREEN}${manifest.package.name} is healthy${RESET}`);
    console.log(`  manifest    valid`);
    console.log(`  resolution  ${resolved.length} package(s) resolve cleanly`);
    console.log(`  lockfile    ${lock === null ? "absent (run install to pin)" : "consistent"}`);
    console.log();
    return { ok: true };
  }

  console.log(`${RED}${all.length} problem(s) found${RESET}`);
  for (const problem of all) console.log(`  ${RED}!${RESET} ${problem}`);
  console.log();
  return { ok: false };
}

// -------------------------------------------------------------------- help

export function pkgHelp(): PkgOutcome {
  console.log(`
${BOLD}sunra pkg${RESET} — the Sunra package manager

${BOLD}SUBCOMMANDS${RESET}
  init [name]           Create ${MANIFEST_NAME} and a starter entry point
  add <name>[@version]  Add a dependency and update the lockfile
  remove <name>         Remove a dependency
  list                  Show this package, its metadata and its dependencies
  install               Resolve, vendor and pin every dependency
  search [query]        Search the registry
  info <name>           Show a registry package in detail
  tree                  Print the dependency tree
  check                 Validate the manifest, resolution and lockfile

${BOLD}REGISTRY${RESET}
  publish               Pack this package and upload it to a registry
  pack [out.tgz]        Build the archive without publishing it
  fetch <name>[@ver]    Download, verify and unpack one package
  login --token <t>     Store a publish token for a registry
  yank <name>@<ver>     Mark a published version unresolvable
  ping                  Check that a registry is reachable

${BOLD}OPTIONS${RESET}
  --dev                 Apply to dev-dependencies (with \`add\`)
  --registry <url>      Registry to talk to (default http://127.0.0.1:8787)
  --token <value>       Publish token; also read from SUNRA_TOKEN
  --remote              Make \`search\`/\`info\` query the live registry
  --json                Emit machine-readable JSON

${BOLD}EXAMPLES${RESET}
  sunra pkg init solar-fortune
  sunra pkg add sunra-slots
  sunra pkg add sunra-tables@^0.1.0 --dev
  sunra pkg install
  sunra pkg tree
  sunra pkg publish --registry http://127.0.0.1:8787
  sunra pkg fetch solar-fortune@0.1.0
`);
  return { ok: true };
}

/**
 * Dispatch a `pkg` subcommand. Returns the process exit code.
 *
 * Registry-facing subcommands live in `remote.ts` and are asynchronous, so this
 * returns a promise. The local subcommands still run synchronously inside it.
 */
export async function runPkgCommand(
  subcommand: string | undefined,
  ctx: PkgContext & { registry?: string; token?: string; remote?: boolean },
): Promise<number> {
  const handlers: Record<string, (ctx: PkgContext) => PkgOutcome> = {
    init: pkgInit,
    add: pkgAdd,
    remove: pkgRemove,
    rm: pkgRemove,
    list: pkgList,
    ls: pkgList,
    install: pkgInstall,
    i: pkgInstall,
    search: pkgSearch,
    info: pkgInfo,
    show: pkgInfo,
    tree: pkgTree,
    check: pkgCheck,
    validate: pkgCheck,
  };

  if (subcommand === undefined || subcommand === "help" || subcommand === "--help") {
    pkgHelp();
    return 0;
  }

  // Registry commands are loaded lazily so that a purely local `sunra pkg list`
  // never pulls in the HTTP client.
  const { REMOTE_SUBCOMMANDS, pkgSearchRemote, pkgInfoRemote } = await import("./remote.js");

  // `--remote` turns the offline catalogue commands into live queries.
  if (ctx.remote && (subcommand === "search" || subcommand === "info" || subcommand === "show")) {
    const outcome =
      subcommand === "search" ? await pkgSearchRemote(ctx) : await pkgInfoRemote(ctx);
    if (!outcome.ok && outcome.message) console.error(`${RED}error${RESET}: ${outcome.message}`);
    return outcome.ok ? 0 : 1;
  }

  const remoteHandler = REMOTE_SUBCOMMANDS[subcommand];
  if (remoteHandler) {
    const outcome = await remoteHandler(ctx);
    if (!outcome.ok && outcome.message) console.error(`${RED}error${RESET}: ${outcome.message}`);
    return outcome.ok ? 0 : 1;
  }

  const handler = handlers[subcommand];
  if (!handler) {
    console.error(`${RED}error${RESET}: unknown pkg subcommand \`${subcommand}\``);
    pkgHelp();
    return 2;
  }

  const outcome = handler(ctx);
  if (!outcome.ok && outcome.message) console.error(`${RED}error${RESET}: ${outcome.message}`);
  return outcome.ok ? 0 : 1;
}

export type { Dependency };
