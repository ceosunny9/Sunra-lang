/**
 * The Sunra package registry server.
 *
 * A real HTTP service, started with `sunra registry serve`. It stores published
 * packages on disk, verifies their integrity, and serves the endpoints the
 * client half of `sunra pkg` talks to. It is written against `node:http` with no
 * framework, because the surface is small and a registry that studios will run
 * inside their own network should have as few moving parts as possible.
 *
 * Endpoints
 *   GET  /                             service description
 *   GET  /-/ping                       health check
 *   GET  /-/all                        every package, newest version first
 *   GET  /-/search?q=<query>           search by name, description or module
 *   GET  /<name>                       package metadata and version list
 *   GET  /<name>/<version>             one version's metadata
 *   GET  /<name>/<version>/tarball     the package archive
 *   PUT  /<name>/<version>             publish (requires a token)
 *   DELETE /<name>/<version>           yank a version (requires a token)
 *
 * Authentication is a bearer token. Publishing without one is refused, because a
 * registry that accepts anonymous writes is not a supply chain a regulator would
 * accept.
 *
 * Storage layout, under the registry root:
 *   packages/<name>/<version>/package.json    metadata
 *   packages/<name>/<version>/package.tgz     archive bytes
 *   tokens.json                               publish tokens
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import { compareSemVer, parseSemVer } from "../pkg/registry.js";

/** Metadata stored for one published version. */
export interface PublishedVersion {
  name: string;
  version: string;
  description: string;
  license: string;
  /** Effects the package's public surface may perform. */
  effects: string[];
  /** Sunra modules the package exports. */
  modules: string[];
  /** Declared dependencies, so the client can resolve transitively. */
  dependencies: Array<{ name: string; version: string }>;
  /** `sha256-<hex>` over the archive bytes. */
  integrity: string;
  /** Archive size in bytes. */
  size: number;
  publishedAt: string;
  publisher: string;
  yanked: boolean;
}

export interface RegistryOptions {
  /** Directory holding packages and tokens. */
  root: string;
  port?: number;
  host?: string;
  /**
   * Tokens permitted to publish. When omitted, tokens are read from
   * `<root>/tokens.json`, and a first token is generated if that file is absent.
   */
  tokens?: string[];
  /** Suppress logging, used by the tests. */
  quiet?: boolean;
}

/** Storage and policy, separated from transport so it can be tested directly. */
export class RegistryStore {
  private readonly packagesDir: string;
  private tokens: Set<string>;

  constructor(private readonly root: string, tokens?: string[]) {
    this.packagesDir = join(root, "packages");
    mkdirSync(this.packagesDir, { recursive: true });
    this.tokens = new Set(tokens ?? this.loadTokens());
  }

  // ------------------------------------------------------------------- tokens

  private get tokensPath(): string {
    return join(this.root, "tokens.json");
  }

  /**
   * Load publish tokens, minting one on first run. A registry with no token
   * could not be published to at all, and silently generating one is friendlier
   * than failing — the token is printed once, the way any service does it.
   */
  private loadTokens(): string[] {
    if (existsSync(this.tokensPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.tokensPath, "utf8")) as { tokens?: string[] };
        if (Array.isArray(parsed.tokens) && parsed.tokens.length > 0) return parsed.tokens;
      } catch {
        // A corrupt token file is replaced rather than silently ignored.
      }
    }
    const token = `sunra_${randomBytes(24).toString("hex")}`;
    writeFileSync(this.tokensPath, JSON.stringify({ tokens: [token] }, null, 2) + "\n", "utf8");
    return [token];
  }

  get publishTokens(): string[] {
    return [...this.tokens];
  }

  /** Constant-time token comparison; a timing side channel here leaks secrets. */
  authorize(header: string | undefined): boolean {
    if (!header) return false;
    const presented = header.replace(/^Bearer\s+/i, "").trim();
    if (presented.length === 0) return false;

    for (const token of this.tokens) {
      const a = Buffer.from(token);
      const b = Buffer.from(presented);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ reading

  names(): string[] {
    if (!existsSync(this.packagesDir)) return [];
    return readdirSync(this.packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  /** Every version of a package, newest first, yanked ones included. */
  versions(name: string): PublishedVersion[] {
    const dir = join(this.packagesDir, name);
    if (!existsSync(dir)) return [];

    const found: PublishedVersion[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(dir, entry.name, "package.json");
      if (!existsSync(metaPath)) continue;
      try {
        found.push(JSON.parse(readFileSync(metaPath, "utf8")) as PublishedVersion);
      } catch {
        // Skip an unreadable version rather than failing the whole listing.
      }
    }

    return found.sort((a, b) => {
      const left = parseSemVer(a.version);
      const right = parseSemVer(b.version);
      if (!left || !right) return b.version.localeCompare(a.version);
      return compareSemVer(right, left);
    });
  }

  version(name: string, version: string): PublishedVersion | null {
    const metaPath = join(this.packagesDir, name, version, "package.json");
    if (!existsSync(metaPath)) return null;
    try {
      return JSON.parse(readFileSync(metaPath, "utf8")) as PublishedVersion;
    } catch {
      return null;
    }
  }

  tarball(name: string, version: string): Buffer | null {
    const path = join(this.packagesDir, name, version, "package.tgz");
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  search(query: string): PublishedVersion[] {
    const needle = query.trim().toLowerCase();
    const results: PublishedVersion[] = [];

    for (const name of this.names()) {
      const latest = this.versions(name).find((entry) => !entry.yanked);
      if (!latest) continue;
      if (needle === "") {
        results.push(latest);
        continue;
      }
      const haystack = [
        latest.name,
        latest.description,
        ...latest.modules,
        ...latest.effects,
      ]
        .join(" ")
        .toLowerCase();
      if (haystack.includes(needle)) results.push(latest);
    }
    return results;
  }

  /** The newest non-yanked version of every package. */
  catalogue(): PublishedVersion[] {
    return this.names()
      .map((name) => this.versions(name).find((entry) => !entry.yanked))
      .filter((entry): entry is PublishedVersion => entry !== undefined);
  }

  // ------------------------------------------------------------------ writing

  /**
   * Store a published version. Republishing an existing version is refused:
   * immutability is what makes a lockfile meaningful.
   */
  publish(
    metadata: Omit<PublishedVersion, "integrity" | "size" | "publishedAt" | "yanked">,
    archive: Buffer,
    options: { publisher?: string } = {},
  ): { ok: true; record: PublishedVersion } | { ok: false; status: number; error: string } {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(metadata.name)) {
      return {
        ok: false,
        status: 400,
        error: "package names must be lowercase letters, digits and hyphens",
      };
    }
    if (!parseSemVer(metadata.version)) {
      return { ok: false, status: 400, error: `\`${metadata.version}\` is not a semantic version` };
    }
    if (this.version(metadata.name, metadata.version)) {
      return {
        ok: false,
        status: 409,
        error: `${metadata.name}@${metadata.version} is already published; publish a new version instead`,
      };
    }
    if (archive.length === 0) {
      return { ok: false, status: 400, error: "the archive is empty" };
    }

    const record: PublishedVersion = {
      ...metadata,
      integrity: `sha256-${createHash("sha256").update(archive).digest("hex")}`,
      size: archive.length,
      publishedAt: new Date().toISOString(),
      publisher: options.publisher ?? metadata.publisher ?? "unknown",
      yanked: false,
    };

    const dir = join(this.packagesDir, metadata.name, metadata.version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.tgz"), archive);
    writeFileSync(join(dir, "package.json"), JSON.stringify(record, null, 2) + "\n", "utf8");

    return { ok: true, record };
  }

  /**
   * Yank a version. The archive stays on disk so existing lockfiles keep
   * resolving; only new resolutions skip it. Deleting published bytes would break
   * every build that already depends on them.
   */
  yank(name: string, version: string): boolean {
    const record = this.version(name, version);
    if (!record) return false;
    record.yanked = true;
    writeFileSync(
      join(this.packagesDir, name, version, "package.json"),
      JSON.stringify(record, null, 2) + "\n",
      "utf8",
    );
    return true;
  }

  /** Remove a version entirely. Intended for tests and local scratch registries. */
  purge(name: string, version: string): boolean {
    const dir = join(this.packagesDir, name, version);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

export interface RunningRegistry {
  server: Server;
  store: RegistryStore;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/** Start the registry. Resolves once it is accepting connections. */
export function startRegistry(options: RegistryOptions): Promise<RunningRegistry> {
  const store = new RegistryStore(options.root, options.tokens);
  const host = options.host ?? "127.0.0.1";
  const log = (message: string) => {
    if (!options.quiet) process.stdout.write(message + "\n");
  };

  const server = createServer((request, response) => {
    handle(request, response, store, log).catch((error) => {
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  return new Promise((settle, reject) => {
    server.on("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (options.port ?? 0);
      const url = `http://${host}:${port}`;
      settle({
        server,
        store,
        port,
        url,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2) + "\n";
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendBinary(response: ServerResponse, status: number, body: Buffer, integrity: string): void {
  response.writeHead(status, {
    "content-type": "application/gzip",
    "content-length": body.length,
    // The client verifies this against the bytes it received.
    "x-sunra-integrity": integrity,
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_ARCHIVE_BYTES) {
      throw new Error(`request body exceeds ${MAX_ARCHIVE_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  store: RegistryStore,
  log: (message: string) => void,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://registry.local");
  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  const method = request.method ?? "GET";

  log(`${method} ${url.pathname}`);

  // ---- service endpoints
  if (segments.length === 0) {
    send(response, 200, {
      service: "sunra-registry",
      version: 1,
      packages: store.names().length,
      endpoints: [
        "GET /-/ping",
        "GET /-/all",
        "GET /-/search?q=",
        "GET /:name",
        "GET /:name/:version",
        "GET /:name/:version/tarball",
        "PUT /:name/:version",
        "DELETE /:name/:version",
      ],
    });
    return;
  }

  if (segments[0] === "-") {
    const endpoint = segments[1];
    if (endpoint === "ping") {
      send(response, 200, { ok: true, packages: store.names().length });
      return;
    }
    if (endpoint === "all") {
      send(response, 200, { packages: store.catalogue() });
      return;
    }
    if (endpoint === "search") {
      const query = url.searchParams.get("q") ?? "";
      send(response, 200, { query, results: store.search(query) });
      return;
    }
    send(response, 404, { error: `unknown endpoint /-/${endpoint ?? ""}` });
    return;
  }

  const name = decodeURIComponent(segments[0]);

  // ---- GET /:name
  if (segments.length === 1 && method === "GET") {
    const versions = store.versions(name);
    if (versions.length === 0) {
      send(response, 404, { error: `${name} is not published in this registry` });
      return;
    }
    send(response, 200, {
      name,
      latest: versions.find((entry) => !entry.yanked)?.version ?? null,
      versions: versions.map((entry) => entry.version),
      yanked: versions.filter((entry) => entry.yanked).map((entry) => entry.version),
      description: versions[0].description,
      effects: versions[0].effects,
      modules: versions[0].modules,
      license: versions[0].license,
    });
    return;
  }

  const version = segments.length >= 2 ? decodeURIComponent(segments[1]) : null;

  // ---- GET /:name/:version/tarball
  if (segments.length === 3 && segments[2] === "tarball" && method === "GET" && version) {
    const record = store.version(name, version);
    const archive = store.tarball(name, version);
    if (!record || !archive) {
      send(response, 404, { error: `${name}@${version} is not published in this registry` });
      return;
    }
    sendBinary(response, 200, archive, record.integrity);
    return;
  }

  if (segments.length === 2 && version) {
    // ---- GET /:name/:version
    if (method === "GET") {
      const record = store.version(name, version);
      if (!record) {
        send(response, 404, { error: `${name}@${version} is not published in this registry` });
        return;
      }
      send(response, 200, record);
      return;
    }

    // ---- PUT /:name/:version  (publish)
    if (method === "PUT") {
      if (!store.authorize(request.headers.authorization)) {
        send(response, 401, {
          error: "publishing requires a bearer token; see tokens.json in the registry root",
        });
        return;
      }

      // The archive and its metadata travel together as one JSON envelope, so a
      // publish is atomic: there is no window where bytes exist without metadata.
      let envelope: {
        metadata?: Partial<PublishedVersion>;
        tarball?: string;
      };
      try {
        envelope = JSON.parse((await readBody(request)).toString("utf8"));
      } catch (error) {
        send(response, 400, {
          error: `malformed publish envelope: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }

      const metadata = envelope.metadata ?? {};
      if (!envelope.tarball) {
        send(response, 400, { error: "the publish envelope has no `tarball` field" });
        return;
      }
      if (metadata.name !== name || metadata.version !== version) {
        send(response, 400, {
          error: `envelope describes ${metadata.name}@${metadata.version} but the URL says ${name}@${version}`,
        });
        return;
      }

      const archive = Buffer.from(envelope.tarball, "base64");
      const outcome = store.publish(
        {
          name,
          version,
          description: metadata.description ?? "",
          license: metadata.license ?? "UNLICENSED",
          effects: metadata.effects ?? [],
          modules: metadata.modules ?? [],
          dependencies: metadata.dependencies ?? [],
          publisher: metadata.publisher ?? "unknown",
        },
        archive,
      );

      if (!outcome.ok) {
        send(response, outcome.status, { error: outcome.error });
        return;
      }
      send(response, 201, { published: outcome.record });
      return;
    }

    // ---- DELETE /:name/:version  (yank)
    if (method === "DELETE") {
      if (!store.authorize(request.headers.authorization)) {
        send(response, 401, { error: "yanking requires a bearer token" });
        return;
      }
      if (!store.yank(name, version)) {
        send(response, 404, { error: `${name}@${version} is not published in this registry` });
        return;
      }
      send(response, 200, { yanked: `${name}@${version}` });
      return;
    }
  }

  send(response, 404, { error: `no route for ${method} ${url.pathname}` });
}
