/**
 * `sunra pkg` subcommands that talk to a registry over HTTP.
 *
 * These are separated from `commands.ts` because they are asynchronous and
 * because they need credentials. The local subcommands stay synchronous and
 * offline; anything that reaches the network lives here, which makes it obvious
 * from the file layout alone which commands can phone home.
 *
 * Where the registry lives, in order of precedence:
 *   1. `--registry <url>`
 *   2. `SUNRA_REGISTRY`
 *   3. `registry = "…"` in the `[package]` table of sunra.toml
 *   4. http://127.0.0.1:8787
 *
 * The publish token comes from `--token`, `SUNRA_TOKEN`, or `~/.sunra/credentials.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { readManifest, type Manifest } from "./manifest.js";
import {
  DEFAULT_REGISTRY,
  RegistryClient,
  discoverModules,
  packProject,
  type RemoteVersion,
} from "./client.js";
import { MANIFEST_NAME, findManifestDir, type PkgContext, type PkgOutcome } from "./commands.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

export interface RemoteContext extends PkgContext {
  /** `--registry <url>`. */
  registry?: string;
  /** `--token <value>`. */
  token?: string;
  /** `--yes`, to skip the publish confirmation. */
  yes?: boolean;
}

// --------------------------------------------------------------- credentials

function credentialsPath(): string {
  return join(homedir(), ".sunra", "credentials.json");
}

/** Read the saved token for a registry URL. */
export function readToken(registry: string): string | undefined {
  const path = credentialsPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, { token?: string }>;
    return parsed[normalizeUrl(registry)]?.token;
  } catch {
    return undefined;
  }
}

/** Save a token for a registry URL, keeping the file private to the user. */
export function writeToken(registry: string, token: string): string {
  const path = credentialsPath();
  mkdirSync(join(path, ".."), { recursive: true });

  let existing: Record<string, { token?: string }> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, { token?: string }>;
    } catch {
      existing = {};
    }
  }
  existing[normalizeUrl(registry)] = { token };
  // 0o600: a publish token is a credential, not configuration.
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return path;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

// -------------------------------------------------------------------- helpers

function manifestRegistry(manifest: Manifest | null): string | undefined {
  if (!manifest) return undefined;
  const table = manifest.raw["package"];
  if (table && typeof table === "object" && !Array.isArray(table)) {
    const value = (table as Record<string, unknown>)["registry"];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function resolveRegistryUrl(ctx: RemoteContext, manifest: Manifest | null): string {
  return normalizeUrl(
    ctx.registry ??
      process.env.SUNRA_REGISTRY ??
      manifestRegistry(manifest) ??
      DEFAULT_REGISTRY,
  );
}

function loadProject(ctx: RemoteContext): { dir: string; manifest: Manifest } | null {
  const dir = findManifestDir(ctx.cwd);
  if (dir === null) {
    console.error(`${RED}error${RESET}: no ${MANIFEST_NAME} found in this directory or any parent`);
    console.error(`${DIM}hint: create one with \`sunra pkg init\`${RESET}`);
    return null;
  }
  return { dir, manifest: readManifest(readFileSync(join(dir, MANIFEST_NAME), "utf8")) };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function client(ctx: RemoteContext, manifest: Manifest | null): { url: string; api: RegistryClient } {
  const url = resolveRegistryUrl(ctx, manifest);
  const token = ctx.token ?? process.env.SUNRA_TOKEN ?? readToken(url);
  return { url, api: new RegistryClient(url, token) };
}

// --------------------------------------------------------------------- pack

/**
 * `sunra pkg pack` — build the archive without publishing it.
 *
 * Reviewing an archive before it becomes immutable is the cheapest possible
 * supply-chain control, so packing is its own command rather than a hidden step.
 */
export async function pkgPack(ctx: RemoteContext): Promise<PkgOutcome> {
  const project = loadProject(ctx);
  if (!project) return { ok: false };

  let archive;
  try {
    archive = packProject(project.dir);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const output = ctx.args[0]
    ? resolve(ctx.cwd, ctx.args[0])
    : join(project.dir, `${project.manifest.package.name}-${project.manifest.package.version}.tgz`);
  writeFileSync(output, archive.bytes);

  if (ctx.json) {
    console.log(
      JSON.stringify(
        {
          name: project.manifest.package.name,
          version: project.manifest.package.version,
          output,
          integrity: archive.integrity,
          size: archive.bytes.length,
          files: archive.files,
        },
        null,
        2,
      ),
    );
    return { ok: true };
  }

  console.log();
  console.log(`${BOLD}${project.manifest.package.name}${RESET} ${project.manifest.package.version}`);
  console.log(`  archive    ${output}`);
  console.log(`  size       ${formatBytes(archive.bytes.length)}`);
  console.log(`  integrity  ${DIM}${archive.integrity}${RESET}`);
  console.log(`  files      ${archive.files.length}`);
  for (const file of archive.files) console.log(`    ${DIM}${file}${RESET}`);
  console.log();
  return { ok: true };
}

// ------------------------------------------------------------------ publish

/** `sunra pkg publish` — pack the project and upload it to the registry. */
export async function pkgPublish(ctx: RemoteContext): Promise<PkgOutcome> {
  const project = loadProject(ctx);
  if (!project) return { ok: false };

  const { dir, manifest } = project;
  const { url, api } = client(ctx, manifest);

  const token = ctx.token ?? process.env.SUNRA_TOKEN ?? readToken(url);
  if (!token) {
    return {
      ok: false,
      message:
        `no publish token for ${url}\n` +
        `  ${DIM}save one with: sunra pkg login --registry ${url} --token <value>${RESET}\n` +
        `  ${DIM}or set SUNRA_TOKEN in the environment${RESET}`,
    };
  }

  // Refuse to publish something that cannot be described honestly.
  const problems: string[] = [];
  if (!manifest.package.description) problems.push("the manifest has no `description`");
  if (!manifest.package.license) problems.push("the manifest has no `license`");
  if (problems.length > 0) {
    console.log(`${YELLOW}warning${RESET}: ${problems.join("; ")}`);
  }

  let archive;
  try {
    archive = packProject(dir);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  // Modules default to the .sun files actually present, so the published
  // metadata cannot claim modules that do not exist.
  const enriched: Manifest = {
    ...manifest,
    raw: {
      ...manifest.raw,
      modules:
        (Array.isArray(manifest.raw["modules"]) ? manifest.raw["modules"] : undefined) ??
        discoverModules(dir),
    },
  };

  const publisher = process.env.SUNRA_PUBLISHER ?? manifest.package.authors[0] ?? "unknown";

  if (!ctx.json) {
    console.log();
    console.log(`${BOLD}publishing${RESET} ${manifest.package.name} ${manifest.package.version} ${DIM}to ${url}${RESET}`);
    console.log(`  files      ${archive.files.length} (${formatBytes(archive.bytes.length)})`);
    console.log(`  integrity  ${DIM}${archive.integrity}${RESET}`);
  }

  const response = await api.publish(enriched, archive, publisher);

  if (!response.ok) {
    const error = (response.body as { error?: string }).error ?? `HTTP ${response.status}`;
    return { ok: false, message: error };
  }

  const published = (response.body as { published?: RemoteVersion }).published;

  if (ctx.json) {
    console.log(JSON.stringify({ published }, null, 2));
    return { ok: true };
  }

  console.log();
  console.log(`${GREEN}published${RESET} ${manifest.package.name}@${manifest.package.version}`);
  console.log(`  ${DIM}install it with: sunra pkg add ${manifest.package.name} --registry ${url}${RESET}`);
  console.log();
  return { ok: true };
}

// -------------------------------------------------------------------- login

/** `sunra pkg login` — store a publish token for a registry. */
export async function pkgLogin(ctx: RemoteContext): Promise<PkgOutcome> {
  const project = findManifestDir(ctx.cwd);
  const manifest = project
    ? readManifest(readFileSync(join(project, MANIFEST_NAME), "utf8"))
    : null;
  const url = resolveRegistryUrl(ctx, manifest);
  const token = ctx.token ?? ctx.args[0] ?? process.env.SUNRA_TOKEN;

  if (!token) {
    return {
      ok: false,
      message: `usage: sunra pkg login --token <value> [--registry ${url}]`,
    };
  }

  // Verify before saving: a stored token that does not work is worse than none.
  const probe = await new RegistryClient(url, token).ping();
  if (!probe.ok) {
    return { ok: false, message: `could not reach ${url}: ${probe.body.error ?? probe.status}` };
  }

  const path = writeToken(url, token);
  console.log(`${GREEN}saved${RESET} a token for ${url}`);
  console.log(`  ${DIM}${path}${RESET}`);
  return { ok: true };
}

// -------------------------------------------------------------- remote search

/** `sunra pkg search --remote <query>` — search a live registry. */
export async function pkgSearchRemote(ctx: RemoteContext): Promise<PkgOutcome> {
  const project = findManifestDir(ctx.cwd);
  const manifest = project
    ? readManifest(readFileSync(join(project, MANIFEST_NAME), "utf8"))
    : null;
  const { url, api } = client(ctx, manifest);
  const query = ctx.args[0] ?? "";

  const response = await api.search(query);
  if (!response.ok) {
    return { ok: false, message: response.body.error ?? `HTTP ${response.status}` };
  }

  const results = response.body.results ?? [];

  if (ctx.json) {
    console.log(JSON.stringify({ registry: url, query, results }, null, 2));
    return { ok: true };
  }

  console.log();
  console.log(
    `${BOLD}${url}${RESET} ${DIM}${query === "" ? `${results.length} package(s)` : `${results.length} match(es) for "${query}"`}${RESET}`,
  );
  console.log();

  if (results.length === 0) {
    console.log(`  ${DIM}nothing matched${RESET}`);
    console.log();
    return { ok: true };
  }

  for (const pkg of results) {
    console.log(`  ${GREEN}${pkg.name.padEnd(20)}${RESET} ${pkg.version.padEnd(8)} ${DIM}${pkg.license}${RESET}`);
    if (pkg.description) console.log(`    ${pkg.description}`);
    if (pkg.modules.length > 0) console.log(`    ${DIM}modules: ${pkg.modules.join(", ")}${RESET}`);
    if (pkg.effects.length > 0) console.log(`    ${YELLOW}effects: ${pkg.effects.join(", ")}${RESET}`);
    console.log();
  }
  return { ok: true };
}

/** `sunra pkg info --remote <name>` — describe a package on a live registry. */
export async function pkgInfoRemote(ctx: RemoteContext): Promise<PkgOutcome> {
  const name = ctx.args[0];
  if (!name) return { ok: false, message: "usage: sunra pkg info --remote <name>" };

  const project = findManifestDir(ctx.cwd);
  const manifest = project
    ? readManifest(readFileSync(join(project, MANIFEST_NAME), "utf8"))
    : null;
  const { url, api } = client(ctx, manifest);

  const response = await api.info(name);
  if (!response.ok) {
    return { ok: false, message: response.body.error ?? `HTTP ${response.status}` };
  }

  if (ctx.json) {
    console.log(JSON.stringify({ registry: url, ...response.body }, null, 2));
    return { ok: true };
  }

  const info = response.body;
  console.log();
  console.log(`${BOLD}${info.name}${RESET} ${DIM}(${url})${RESET}`);
  if (info.description) console.log(info.description);
  console.log();
  console.log(`  latest     ${info.latest ?? "none"}`);
  console.log(`  versions   ${(info.versions ?? []).join(", ")}`);
  if ((info.yanked ?? []).length > 0) {
    console.log(`  ${YELLOW}yanked     ${(info.yanked ?? []).join(", ")}${RESET}`);
  }
  console.log(`  license    ${info.license ?? "unknown"}`);
  console.log(`  modules    ${(info.modules ?? []).join(", ") || "none"}`);
  console.log(
    `  effects    ${(info.effects ?? []).length > 0 ? (info.effects ?? []).join(", ") : "none (pure)"}`,
  );
  console.log();
  return { ok: true };
}

// ------------------------------------------------------------- remote install

/**
 * `sunra pkg fetch <name>[@version]` — download, verify and unpack one package
 * from a live registry into `sunra_modules/`.
 */
export async function pkgFetch(ctx: RemoteContext): Promise<PkgOutcome> {
  const spec = ctx.args[0];
  if (!spec) return { ok: false, message: "usage: sunra pkg fetch <name>[@version]" };

  const project = loadProject(ctx);
  if (!project) return { ok: false };

  const [name, requested] = spec.includes("@") ? spec.split("@") : [spec, undefined];
  const { url, api } = client(ctx, project.manifest);

  const info = await api.info(name);
  if (!info.ok) {
    return { ok: false, message: info.body.error ?? `HTTP ${info.status}` };
  }

  const version = requested ?? info.body.latest ?? undefined;
  if (!version) {
    return { ok: false, message: `${name} has no published, non-yanked version` };
  }

  const outcome = await api.install(name, version, project.dir);
  if (!outcome.ok) return { ok: false, message: outcome.error };

  if (ctx.json) {
    console.log(
      JSON.stringify(
        { registry: url, name, version, integrity: outcome.integrity, files: outcome.files },
        null,
        2,
      ),
    );
    return { ok: true };
  }

  console.log();
  console.log(`${GREEN}fetched${RESET} ${name}@${version} ${DIM}from ${url}${RESET}`);
  console.log(`  integrity  ${DIM}${outcome.integrity}${RESET}`);
  console.log(`  unpacked   sunra_modules/${name}`);
  for (const file of outcome.files) console.log(`    ${DIM}${file}${RESET}`);
  console.log();
  return { ok: true };
}

/** `sunra pkg yank <name>@<version>` — mark a published version unresolvable. */
export async function pkgYank(ctx: RemoteContext): Promise<PkgOutcome> {
  const spec = ctx.args[0];
  if (!spec || !spec.includes("@")) {
    return { ok: false, message: "usage: sunra pkg yank <name>@<version>" };
  }
  const [name, version] = spec.split("@");

  const project = findManifestDir(ctx.cwd);
  const manifest = project
    ? readManifest(readFileSync(join(project, MANIFEST_NAME), "utf8"))
    : null;
  const { url, api } = client(ctx, manifest);

  const response = await api.yank(name, version);
  if (!response.ok) {
    return { ok: false, message: response.body.error ?? `HTTP ${response.status}` };
  }

  console.log(`${YELLOW}yanked${RESET} ${name}@${version} ${DIM}on ${url}${RESET}`);
  console.log(
    `  ${DIM}existing lockfiles still resolve; new resolutions will skip this version${RESET}`,
  );
  return { ok: true };
}

/** `sunra pkg ping` — check that a registry is reachable. */
export async function pkgPing(ctx: RemoteContext): Promise<PkgOutcome> {
  const project = findManifestDir(ctx.cwd);
  const manifest = project
    ? readManifest(readFileSync(join(project, MANIFEST_NAME), "utf8"))
    : null;
  const { url, api } = client(ctx, manifest);

  const response = await api.ping();
  if (!response.ok) {
    return { ok: false, message: response.body.error ?? `HTTP ${response.status}` };
  }

  console.log(
    `${GREEN}ok${RESET} ${url} ${DIM}(${response.body.packages ?? 0} package(s) published)${RESET}`,
  );
  return { ok: true };
}

/** Subcommands handled here, so the dispatcher knows to await them. */
export const REMOTE_SUBCOMMANDS: Record<string, (ctx: RemoteContext) => Promise<PkgOutcome>> = {
  publish: pkgPublish,
  pack: pkgPack,
  login: pkgLogin,
  fetch: pkgFetch,
  yank: pkgYank,
  ping: pkgPing,
};

export { CYAN };
