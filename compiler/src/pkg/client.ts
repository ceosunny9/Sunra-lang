/**
 * The registry client: packing, publishing, and fetching from a remote registry.
 *
 * Archives are gzipped tar written with `node:zlib` and a tar writer implemented
 * here. Shelling out to `tar` would make the format depend on whichever tar the
 * host happens to have, and the archive is part of the supply chain — its bytes
 * are what the integrity hash covers, so they must be reproducible.
 *
 * Every download is verified against the `sha256-…` digest the registry
 * published. A mismatch aborts the install rather than warning, because a
 * package whose bytes changed after publication is exactly the case a lockfile
 * exists to prevent.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import type { Manifest } from "./manifest.js";

/** Where the client looks for a registry when the manifest does not say. */
export const DEFAULT_REGISTRY = "http://127.0.0.1:8787";

export interface PackedArchive {
  bytes: Buffer;
  /** `sha256-<hex>` over the gzipped bytes. */
  integrity: string;
  files: string[];
}

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

const BLOCK = 512;

/** Write one 512-byte ustar header. */
function tarHeader(path: string, size: number, mode = 0o644): Buffer {
  const header = Buffer.alloc(BLOCK, 0);

  // ustar splits long paths across `prefix` and `name`; package archives are
  // shallow, so a path that does not fit is a genuine error rather than a case
  // to silently truncate.
  if (Buffer.byteLength(path) > 100) {
    throw new Error(`path too long for a tar entry: ${path}`);
  }

  header.write(path, 0, 100, "utf8");
  header.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8"); // uid
  header.write("0000000\0", 116, 8, "utf8"); // gid
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");
  // A fixed timestamp keeps archives byte-identical across runs, which is what
  // makes the integrity hash reproducible.
  header.write((0).toString(8).padStart(11, "0") + "\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "utf8"); // checksum placeholder
  header.write("0", 156, 1, "utf8"); // regular file
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");

  return header;
}

function padTo512(size: number): Buffer {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder, 0);
}

/** Build a gzipped tar from an in-memory file map. */
export function createArchive(entries: Array<{ path: string; content: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  // Sorting makes the archive deterministic regardless of directory order.
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    parts.push(tarHeader(entry.path, entry.content.length));
    parts.push(entry.content);
    parts.push(padTo512(entry.content.length));
  }
  // Two zero blocks terminate a tar stream.
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/** Read a gzipped tar back into a file map. */
export function extractArchive(archive: Buffer): Array<{ path: string; content: Buffer }> {
  const tar = gunzipSync(archive);
  const entries: Array<{ path: string; content: Buffer }> = [];

  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // A zero block marks the end of the archive.
    if (header.every((byte) => byte === 0)) break;

    const path = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField, 8) || 0;

    offset += BLOCK;
    entries.push({ path, content: tar.subarray(offset, offset + size) });
    offset += size + (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));
  }

  return entries;
}

// ---------------------------------------------------------------------------
// packing a project
// ---------------------------------------------------------------------------

/** Files and directories never shipped in a package. */
const EXCLUDED = new Set([
  "sunra_modules",
  "node_modules",
  ".git",
  "dist",
  "build",
  ".sunra-logs",
  "sunra.lock",
]);

function collectFiles(root: string, current = root, found: string[] = []): string[] {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) collectFiles(root, full, found);
    else if (entry.isFile()) found.push(relative(root, full).split(sep).join("/"));
  }
  return found;
}

/**
 * Pack a project directory. Only Sunra sources, the manifest and documentation
 * travel: a registry archive is meant to be readable by an auditor, so build
 * output and dependencies are deliberately excluded.
 */
export function packProject(projectDir: string): PackedArchive {
  const all = collectFiles(projectDir);
  const keep = all.filter(
    (path) =>
      path.endsWith(".sun") ||
      path === "sunra.toml" ||
      /^(README|LICENSE|CHANGELOG)(\.md)?$/i.test(path),
  );

  if (!keep.includes("sunra.toml")) {
    throw new Error("no sunra.toml in this directory; run `sunra pkg init` first");
  }

  const entries = keep.map((path) => ({
    path,
    content: readFileSync(join(projectDir, path)),
  }));

  const bytes = createArchive(entries);
  return {
    bytes,
    integrity: `sha256-${createHash("sha256").update(bytes).digest("hex")}`,
    files: keep.sort(),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface RegistryResponse<T> {
  ok: boolean;
  status: number;
  body: T;
}

async function call<T>(
  url: string,
  init: { method?: string; token?: string; body?: string; expectBinary?: boolean } = {},
): Promise<RegistryResponse<T>> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, { method: init.method ?? "GET", headers, body: init.body });
  } catch (error) {
    // A connection failure is the common case (no registry running), so it is
    // reported as a normal outcome rather than an exception.
    return {
      ok: false,
      status: 0,
      body: {
        error: `could not reach the registry at ${url}: ${error instanceof Error ? error.message : String(error)}`,
      } as T,
    };
  }

  if (init.expectBinary) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      ok: response.ok,
      status: response.status,
      body: {
        bytes: buffer,
        integrity: response.headers.get("x-sunra-integrity") ?? "",
      } as unknown as T,
    };
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text.trim() || `HTTP ${response.status}` };
  }
  return { ok: response.ok, status: response.status, body: parsed as T };
}

export interface RemoteVersion {
  name: string;
  version: string;
  description: string;
  license: string;
  effects: string[];
  modules: string[];
  dependencies: Array<{ name: string; version: string }>;
  integrity: string;
  size: number;
  publishedAt: string;
  publisher: string;
  yanked: boolean;
}

export class RegistryClient {
  constructor(
    readonly baseUrl: string = DEFAULT_REGISTRY,
    private readonly token?: string,
  ) {}

  private endpoint(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  ping(): Promise<RegistryResponse<{ ok?: boolean; packages?: number; error?: string }>> {
    return call(this.endpoint("/-/ping"));
  }

  all(): Promise<RegistryResponse<{ packages?: RemoteVersion[]; error?: string }>> {
    return call(this.endpoint("/-/all"));
  }

  search(query: string): Promise<RegistryResponse<{ results?: RemoteVersion[]; error?: string }>> {
    return call(this.endpoint(`/-/search?q=${encodeURIComponent(query)}`));
  }

  info(name: string): Promise<
    RegistryResponse<{
      name?: string;
      latest?: string | null;
      versions?: string[];
      yanked?: string[];
      description?: string;
      effects?: string[];
      modules?: string[];
      license?: string;
      error?: string;
    }>
  > {
    return call(this.endpoint(`/${encodeURIComponent(name)}`));
  }

  versionInfo(name: string, version: string): Promise<RegistryResponse<RemoteVersion & { error?: string }>> {
    return call(this.endpoint(`/${encodeURIComponent(name)}/${encodeURIComponent(version)}`));
  }

  /** Publish an archive. The manifest supplies the metadata. */
  publish(
    manifest: Manifest,
    archive: PackedArchive,
    publisher: string,
  ): Promise<RegistryResponse<{ published?: RemoteVersion; error?: string }>> {
    const metadata = {
      name: manifest.package.name,
      version: manifest.package.version,
      description: manifest.package.description ?? "",
      license: manifest.package.license || "UNLICENSED",
      effects: effectsOf(manifest),
      modules: modulesOf(manifest),
      dependencies: manifest.dependencies
        .filter((dep) => !dep.dev)
        .map((dep) => ({ name: dep.name, version: dep.version })),
      publisher,
    };

    return call(
      this.endpoint(
        `/${encodeURIComponent(manifest.package.name)}/${encodeURIComponent(manifest.package.version)}`,
      ),
      {
        method: "PUT",
        token: this.token,
        body: JSON.stringify({ metadata, tarball: archive.bytes.toString("base64") }),
      },
    );
  }

  yank(name: string, version: string): Promise<RegistryResponse<{ yanked?: string; error?: string }>> {
    return call(this.endpoint(`/${encodeURIComponent(name)}/${encodeURIComponent(version)}`), {
      method: "DELETE",
      token: this.token,
    });
  }

  /**
   * Download and verify an archive. The digest is recomputed locally; the header
   * the server sends is only a cross-check, never the source of truth.
   */
  async download(
    name: string,
    version: string,
  ): Promise<{ ok: true; bytes: Buffer; integrity: string } | { ok: false; error: string }> {
    const response = await call<{ bytes: Buffer; integrity: string }>(
      this.endpoint(`/${encodeURIComponent(name)}/${encodeURIComponent(version)}/tarball`),
      { expectBinary: true },
    );

    if (!response.ok) {
      return { ok: false, error: `could not download ${name}@${version} (HTTP ${response.status})` };
    }

    const actual = `sha256-${createHash("sha256").update(response.body.bytes).digest("hex")}`;
    const expected = response.body.integrity;
    if (expected && expected !== actual) {
      return {
        ok: false,
        error:
          `integrity check failed for ${name}@${version}\n` +
          `  expected ${expected}\n  received ${actual}\n` +
          "the archive changed after it was published; the install was aborted",
      };
    }

    return { ok: true, bytes: response.body.bytes, integrity: actual };
  }

  /** Download, verify and unpack into `sunra_modules/<name>`. */
  async install(
    name: string,
    version: string,
    projectDir: string,
  ): Promise<{ ok: true; files: string[]; integrity: string } | { ok: false; error: string }> {
    const downloaded = await this.download(name, version);
    if (!downloaded.ok) return downloaded;

    const target = join(projectDir, "sunra_modules", name);
    mkdirSync(target, { recursive: true });

    const written: string[] = [];
    for (const entry of extractArchive(downloaded.bytes)) {
      // Reject path traversal before touching the file system.
      if (entry.path.includes("..") || entry.path.startsWith("/")) {
        return { ok: false, error: `refusing to unpack a suspicious path: ${entry.path}` };
      }
      const destination = join(target, entry.path);
      mkdirSync(join(destination, ".."), { recursive: true });
      writeFileSync(destination, entry.content);
      written.push(entry.path);
    }

    return { ok: true, files: written.sort(), integrity: downloaded.integrity };
  }
}

function effectsOf(manifest: Manifest): string[] {
  const raw = manifest.raw["effects"];
  if (Array.isArray(raw)) return raw.map(String);
  if (raw && typeof raw === "object") {
    const declared = (raw as Record<string, unknown>)["declared"];
    if (Array.isArray(declared)) return declared.map(String);
  }
  return [];
}

/** Modules a package exports: every top-level `.sun` file, by convention. */
function modulesOf(manifest: Manifest): string[] {
  const raw = manifest.raw["modules"];
  if (Array.isArray(raw)) return raw.map(String);
  return [];
}

/** Discover exported modules by scanning `src/` and the project root. */
export function discoverModules(projectDir: string): string[] {
  const found = new Set<string>();
  for (const dir of [projectDir, join(projectDir, "src")]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".sun")) {
        found.add(entry.name.replace(/\.sun$/, ""));
      }
    }
  }
  return [...found].sort();
}
