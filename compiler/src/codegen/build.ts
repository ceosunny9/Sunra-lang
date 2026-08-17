/**
 * The `sunra build` driver.
 *
 * A build is a three-step pipeline: check, emit, and write. The check step is
 * not optional — refusing to emit code that failed verification is the whole
 * point of a language whose selling point is provable fairness. `--force` exists
 * for experimentation, and says so loudly in the artifact header.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { Checker } from "../checker/checker.js";
import { emitProgram } from "./emitter.js";
import { FULL_RUNTIME } from "./runtime_source.js";
import { emitWasm, emitWasmLoader, type SkippedFunction } from "./wasm.js";
import type { SunraError } from "../diagnostics.js";
import type { Program } from "../parser/ast.js";

export interface BuildOptions {
  /** Absolute or relative path of the source file. */
  sourcePath: string;
  /** Raw source text. */
  source: string;
  /** Destination file for the generated module. */
  outPath?: string;
  /** Emit `main()` at module end. */
  entryPoint?: boolean;
  /** Bake a deterministic seed into the artifact. */
  seed?: string;
  /** Emit code even when the checker reports errors. */
  force?: boolean;
  /** Skip writing `sunra_runtime.js` (useful when it already exists). */
  skipRuntime?: boolean;
  /** Emit a single self-contained file with the runtime inlined. */
  bundle?: boolean;
}

export interface BuildArtifact {
  outPath: string;
  runtimePath: string | null;
  bytes: number;
  runtimeBytes: number;
  errors: SunraError[];
  games: string[];
  tests: string[];
  hasMain: boolean;
  imports: string[];
}

export interface WasmBuildArtifact {
  /** Path of the emitted `.wasm` binary, or "" when the build was refused. */
  outPath: string;
  /** Path of the JavaScript loader that instantiates the module. */
  loaderPath: string | null;
  bytes: number;
  loaderBytes: number;
  errors: SunraError[];
  /** Functions that compiled to WebAssembly. */
  compiled: string[];
  /** Functions outside the numeric subset, with the reason each was skipped. */
  skipped: SkippedFunction[];
  hostImports: string[];
}

export interface FrontendResult {
  program: Program;
  errors: SunraError[];
  warnings: SunraError[];
}

/** Run the shared front end: lex, parse, then type-check. */
export function analyze(source: string, fileName: string): FrontendResult {
  const tokens = new Lexer(source, fileName).tokenize();
  const program = new Parser(tokens).parseProgram();
  const result = new Checker().check(program);
  return { program, errors: result.errors, warnings: result.warnings };
}

export function build(options: BuildOptions): BuildArtifact {
  const fileName = basename(options.sourcePath);
  const { program, errors } = analyze(options.source, fileName);

  // The checker's `errors` list is already the blocking set; warnings are
  // returned separately and never prevent an artifact from being emitted.
  const blocking = errors;
  if (blocking.length > 0 && options.force !== true) {
    return {
      outPath: "",
      runtimePath: null,
      bytes: 0,
      runtimeBytes: 0,
      errors: errors,
      games: [],
      tests: [],
      hasMain: false,
      imports: [],
    };
  }

  const outPath = resolve(
    options.outPath ?? options.sourcePath.replace(/\.sun$/, "") + ".js",
  );
  const outDir = dirname(outPath);
  mkdirSync(outDir, { recursive: true });

  const emitted = emitProgram(program, {
    sourceName: fileName,
    emitEntryPoint: options.entryPoint,
    seed: options.seed,
    runtimeSpecifier: options.bundle ? undefined : "./sunra_runtime.js",
  });

  let code = emitted.code;

  if (options.seed !== undefined) {
    // A seeded artifact configures its generator before any user code runs.
    code = code.replace(
      /^(import \{[\s\S]*?\} from "[^"]+";\n)/m,
      `$1\n$rt.setSeed(${JSON.stringify(options.seed)});\n`,
    );
  }

  let runtimePath: string | null = null;
  let runtimeBytes = 0;

  if (options.bundle === true) {
    // Inline the runtime by rewriting the import into local destructuring of
    // the module's own exports. The result is one file that runs anywhere.
    code = bundleRuntime(code, emitted.imports);
  } else if (options.skipRuntime !== true) {
    runtimePath = join(outDir, "sunra_runtime.js");
    writeFileSync(runtimePath, FULL_RUNTIME, "utf8");
    runtimeBytes = Buffer.byteLength(FULL_RUNTIME, "utf8");
  }

  if (blocking.length > 0) {
    code =
      "// WARNING: this artifact was emitted with --force despite " +
      `${blocking.length} unresolved error(s).\n` +
      "// Its behaviour is undefined and it must not be used in production.\n\n" +
      code;
  }

  writeFileSync(outPath, code, "utf8");

  return {
    outPath,
    runtimePath,
    bytes: Buffer.byteLength(code, "utf8"),
    runtimeBytes,
    errors,
    games: emitted.games,
    tests: emitted.tests,
    hasMain: emitted.hasMain,
    imports: emitted.imports,
  };
}

/**
 * Build a WebAssembly artifact.
 *
 * The WASM backend compiles Sunra's numeric core; functions that use strings,
 * lists, reels, money or effects are reported rather than mistranslated. The
 * emitted loader documents exactly which functions made it into the binary, so a
 * caller always knows whether to reach for the JavaScript target as well.
 */
export function buildWasm(options: BuildOptions): WasmBuildArtifact {
  const fileName = basename(options.sourcePath);
  const { program, errors } = analyze(options.source, fileName);

  if (errors.length > 0 && options.force !== true) {
    return {
      outPath: "",
      loaderPath: null,
      bytes: 0,
      loaderBytes: 0,
      errors,
      compiled: [],
      skipped: [],
      hostImports: [],
    };
  }

  const outPath = resolve(
    options.outPath ?? options.sourcePath.replace(/\.sun$/, "") + ".wasm",
  );
  const outDir = dirname(outPath);
  mkdirSync(outDir, { recursive: true });

  const emitted = emitWasm(program);
  writeFileSync(outPath, emitted.bytes);

  const loaderPath = outPath.replace(/\.wasm$/, "") + ".wasm.mjs";
  const loader = emitWasmLoader({
    wasmFileName: basename(outPath),
    compiled: emitted.compiled,
    skipped: emitted.skipped,
    sourceName: fileName,
  });
  writeFileSync(loaderPath, loader, "utf8");

  return {
    outPath,
    loaderPath,
    bytes: emitted.bytes.byteLength,
    loaderBytes: Buffer.byteLength(loader, "utf8"),
    errors,
    compiled: emitted.compiled,
    skipped: emitted.skipped,
    hostImports: emitted.hostImports,
  };
}

/**
 * Produce a single-file artifact. The runtime's own `export` keywords are
 * stripped so that its declarations become module-level bindings, which the
 * generated program can then reference directly.
 */
function bundleRuntime(code: string, imports: string[]): string {
  const withoutImport = code.replace(/^import \{[\s\S]*?\} from "[^"]+";\n/m, "");
  const inlined = FULL_RUNTIME.replace(/^export (const|function|class) /gm, "$1 ")
    .replace(/^export default \$rt;$/gm, "")
    .replace(/^export \{[^}]*\};$/gm, "");

  return [
    "// Sunra single-file artifact: program and runtime in one module.",
    `// Runtime symbols used: ${imports.join(", ") || "none"}`,
    "",
    inlined,
    "",
    "// ===========================================================",
    "// Program",
    "// ===========================================================",
    "",
    withoutImport,
  ].join("\n");
}
