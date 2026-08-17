/**
 * `sunra.toml` — the Sunra package manifest.
 *
 * The manifest is deliberately a small, explicit subset of TOML: tables, string,
 * number, boolean and array values, and comments. A gaming toolchain is audited,
 * and an auditor should be able to read a manifest without consulting a spec.
 *
 * Parsing is implemented here rather than pulled from npm for the same reason
 * the runtime is dependency-free: a compiler that regulators must trust should
 * not have a supply chain wider than its own source tree.
 */

export interface Dependency {
  name: string;
  /** Version requirement, e.g. `^1.2.0`, `1.0.3`, or `*`. */
  version: string;
  /** Optional local path dependency, relative to the manifest. */
  path?: string;
  /** Optional git source. */
  git?: string;
  /** Whether the dependency is only needed for development. */
  dev: boolean;
}

export interface Manifest {
  package: {
    name: string;
    version: string;
    description: string;
    authors: string[];
    license: string;
    edition: string;
    entry: string;
  };
  /** Regulatory and gaming metadata: unique to Sunra, and mandatory in spirit. */
  gaming: {
    rtpTarget: number | null;
    rtpTolerance: number | null;
    provablyFair: boolean;
    jurisdictions: string[];
  };
  build: {
    target: string;
    bundle: boolean;
    outDir: string;
    seed: string | null;
  };
  dependencies: Dependency[];
  raw: TomlTable;
}

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class ManifestError extends Error {
  constructor(message: string, readonly line: number | null = null) {
    super(message);
    this.name = "ManifestError";
  }
}

// ---------------------------------------------------------------------- TOML

/** Parse the documented subset of TOML into a nested table. */
export function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;

  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (line === "") continue;

    // Table header: [package] or [dependencies.slots]
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      current = ensurePath(root, table[1].split(".").map((s) => s.trim()), i + 1);
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) {
      throw new ManifestError(`expected \`key = value\` but found \`${line}\``, i + 1);
    }

    const key = line.slice(0, eq).trim().replace(/^"|"$/g, "");
    let valueText = line.slice(eq + 1).trim();

    // A multi-line array continues until its closing bracket.
    if (valueText.startsWith("[") && !valueText.includes("]")) {
      const parts = [valueText];
      while (i + 1 < lines.length && !parts.join(" ").includes("]")) {
        i += 1;
        parts.push(stripComment(lines[i]).trim());
      }
      valueText = parts.join(" ");
    }

    current[key] = parseValue(valueText, i + 1);
  }

  return root;
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") inString = !inString;
    if (ch === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function ensurePath(root: TomlTable, path: string[], line: number): TomlTable {
  let node = root;
  for (const key of path) {
    if (key === "") throw new ManifestError("empty table name", line);
    if (!(key in node)) node[key] = {};
    const next = node[key];
    if (typeof next !== "object" || Array.isArray(next)) {
      throw new ManifestError(`\`${key}\` is already a value, not a table`, line);
    }
    node = next as TomlTable;
  }
  return node;
}

function parseValue(text: string, line: number): TomlValue {
  if (text === "") throw new ManifestError("missing value", line);

  if (text.startsWith("[")) {
    const inner = text.slice(1, text.lastIndexOf("]")).trim();
    if (inner === "") return [];
    return splitTopLevel(inner).map((part) => parseValue(part.trim(), line));
  }

  if (text.startsWith("{")) {
    const inner = text.slice(1, text.lastIndexOf("}")).trim();
    const table: TomlTable = {};
    if (inner === "") return table;
    for (const part of splitTopLevel(inner)) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new ManifestError(`expected \`key = value\` in inline table`, line);
      const key = part.slice(0, eq).trim().replace(/^"|"$/g, "");
      table[key] = parseValue(part.slice(eq + 1).trim(), line);
    }
    return table;
  }

  if (text.startsWith('"')) {
    const end = text.lastIndexOf('"');
    if (end <= 0) throw new ManifestError("unterminated string", line);
    return unescape(text.slice(1, end));
  }

  if (text === "true") return true;
  if (text === "false") return false;

  const number = Number(text);
  if (!Number.isNaN(number) && text.match(/^[-+]?[0-9._eE+-]+$/)) return number;

  // Bare values are accepted as strings so that `edition = 2026` and
  // `version = 1.0` both behave the way an author would expect.
  return text;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail !== "") parts.push(tail);
  return parts.filter((p) => p.trim() !== "");
}

function unescape(text: string): string {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

// ------------------------------------------------------------------ manifest

function asString(value: TomlValue | undefined, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function asStringList(value: TomlValue | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => asString(v, ""));
  if (typeof value === "string") return [value];
  return [];
}

function asNumber(value: TomlValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function asTable(value: TomlValue | undefined): TomlTable {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as TomlTable;
  return {};
}

/** Interpret a parsed TOML tree as a Sunra manifest, applying defaults. */
export function readManifest(source: string): Manifest {
  const raw = parseToml(source);

  const pkg = asTable(raw["package"]);
  const gaming = asTable(raw["gaming"]);
  const buildTable = asTable(raw["build"]);

  const dependencies: Dependency[] = [
    ...collectDependencies(asTable(raw["dependencies"]), false),
    ...collectDependencies(asTable(raw["dev-dependencies"]), true),
  ];

  return {
    package: {
      name: asString(pkg["name"], "unnamed"),
      version: asString(pkg["version"], "0.1.0"),
      description: asString(pkg["description"], ""),
      authors: asStringList(pkg["authors"]),
      license: asString(pkg["license"], "MIT"),
      edition: asString(pkg["edition"], "2026"),
      entry: asString(pkg["entry"], "src/main.sun"),
    },
    gaming: {
      rtpTarget: asNumber(gaming["rtp_target"]),
      rtpTolerance: asNumber(gaming["rtp_tolerance"]),
      provablyFair: gaming["provably_fair"] === true,
      jurisdictions: asStringList(gaming["jurisdictions"]),
    },
    build: {
      target: asString(buildTable["target"], "javascript"),
      bundle: buildTable["bundle"] === true,
      outDir: asString(buildTable["out_dir"], "build"),
      seed: buildTable["seed"] === undefined ? null : asString(buildTable["seed"], ""),
    },
    dependencies,
    raw,
  };
}

function collectDependencies(table: TomlTable, dev: boolean): Dependency[] {
  const out: Dependency[] = [];
  for (const [name, value] of Object.entries(table)) {
    if (typeof value === "string" || typeof value === "number") {
      out.push({ name, version: String(value), dev });
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const spec = value as TomlTable;
      out.push({
        name,
        version: asString(spec["version"], "*"),
        path: spec["path"] === undefined ? undefined : asString(spec["path"], ""),
        git: spec["git"] === undefined ? undefined : asString(spec["git"], ""),
        dev,
      });
    }
  }
  return out;
}

/** Validate a manifest and return human-readable problems. */
export function validateManifest(manifest: Manifest): string[] {
  const problems: string[] = [];

  if (!/^[a-z][a-z0-9_-]*$/.test(manifest.package.name)) {
    problems.push(
      `package.name "${manifest.package.name}" must be lowercase and start with a letter`,
    );
  }
  if (!/^\d+\.\d+\.\d+/.test(manifest.package.version)) {
    problems.push(`package.version "${manifest.package.version}" is not semantic versioning`);
  }
  if (!["javascript", "wasm", "native"].includes(manifest.build.target)) {
    problems.push(
      `build.target "${manifest.build.target}" is not one of javascript, wasm, native`,
    );
  }

  const { rtpTarget, rtpTolerance } = manifest.gaming;
  if (rtpTarget !== null && (rtpTarget <= 0 || rtpTarget > 1)) {
    problems.push(`gaming.rtp_target ${rtpTarget} must be a fraction between 0 and 1`);
  }
  if (rtpTolerance !== null && (rtpTolerance <= 0 || rtpTolerance > 0.5)) {
    problems.push(`gaming.rtp_tolerance ${rtpTolerance} must be a small positive fraction`);
  }
  if (rtpTarget !== null && rtpTolerance === null) {
    problems.push("gaming.rtp_target is declared without gaming.rtp_tolerance");
  }

  for (const dep of manifest.dependencies) {
    if (!/^[a-z][a-z0-9_-]*$/.test(dep.name)) {
      problems.push(`dependency name "${dep.name}" must be lowercase`);
    }
    if (dep.path === undefined && dep.git === undefined && !isVersionRequirement(dep.version)) {
      problems.push(`dependency ${dep.name} has an unreadable version "${dep.version}"`);
    }
  }

  return problems;
}

export function isVersionRequirement(text: string): boolean {
  return text === "*" || /^[\^~>=<]*\s*\d+(\.\d+)*(\.\d+)?$/.test(text.trim());
}

/** Serialize a manifest back to TOML, preserving the documented ordering. */
export function writeManifest(manifest: Manifest): string {
  const lines: string[] = [];

  lines.push("# Sunra package manifest");
  lines.push("# Documentation: https://sunra.dev/docs/package-manager");
  lines.push("");
  lines.push("[package]");
  lines.push(`name = ${JSON.stringify(manifest.package.name)}`);
  lines.push(`version = ${JSON.stringify(manifest.package.version)}`);
  lines.push(`description = ${JSON.stringify(manifest.package.description)}`);
  lines.push(`authors = [${manifest.package.authors.map((a) => JSON.stringify(a)).join(", ")}]`);
  lines.push(`license = ${JSON.stringify(manifest.package.license)}`);
  lines.push(`edition = ${JSON.stringify(manifest.package.edition)}`);
  lines.push(`entry = ${JSON.stringify(manifest.package.entry)}`);
  lines.push("");

  lines.push("# Gaming metadata is first-class: the toolchain verifies these claims.");
  lines.push("[gaming]");
  if (manifest.gaming.rtpTarget !== null) {
    lines.push(`rtp_target = ${manifest.gaming.rtpTarget}`);
  }
  if (manifest.gaming.rtpTolerance !== null) {
    lines.push(`rtp_tolerance = ${manifest.gaming.rtpTolerance}`);
  }
  lines.push(`provably_fair = ${manifest.gaming.provablyFair}`);
  lines.push(
    `jurisdictions = [${manifest.gaming.jurisdictions.map((j) => JSON.stringify(j)).join(", ")}]`,
  );
  lines.push("");

  lines.push("[build]");
  lines.push(`target = ${JSON.stringify(manifest.build.target)}`);
  lines.push(`bundle = ${manifest.build.bundle}`);
  lines.push(`out_dir = ${JSON.stringify(manifest.build.outDir)}`);
  if (manifest.build.seed !== null) lines.push(`seed = ${JSON.stringify(manifest.build.seed)}`);
  lines.push("");

  lines.push("[dependencies]");
  for (const dep of manifest.dependencies.filter((d) => !d.dev)) {
    lines.push(formatDependency(dep));
  }
  lines.push("");

  const dev = manifest.dependencies.filter((d) => d.dev);
  lines.push("[dev-dependencies]");
  for (const dep of dev) lines.push(formatDependency(dep));
  lines.push("");

  return lines.join("\n");
}

function formatDependency(dep: Dependency): string {
  if (dep.path !== undefined) {
    return `${dep.name} = { version = ${JSON.stringify(dep.version)}, path = ${JSON.stringify(dep.path)} }`;
  }
  if (dep.git !== undefined) {
    return `${dep.name} = { version = ${JSON.stringify(dep.version)}, git = ${JSON.stringify(dep.git)} }`;
  }
  return `${dep.name} = ${JSON.stringify(dep.version)}`;
}

/** A newly initialised manifest for `sunra pkg init`. */
export function defaultManifest(name: string): Manifest {
  return {
    package: {
      name,
      version: "0.1.0",
      description: "A Sunra package.",
      authors: [],
      license: "MIT",
      edition: "2026",
      entry: "src/main.sun",
    },
    gaming: {
      rtpTarget: null,
      rtpTolerance: null,
      provablyFair: false,
      jurisdictions: [],
    },
    build: {
      target: "javascript",
      bundle: false,
      outDir: "build",
      seed: null,
    },
    dependencies: [],
    raw: {},
  };
}
