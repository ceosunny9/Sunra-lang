#!/usr/bin/env node
/**
 * `sunra` toolchain entry point.
 *
 * Resolves the compiled CLI in dist/ and reports a helpful message if the
 * project has not been built yet.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "dist", "cli", "main.js");

if (!existsSync(entry)) {
  console.error("\x1b[31merror\x1b[0m: Sunra is not built yet.");
  console.error("\x1b[2mrun `pnpm install && pnpm build` in the compiler directory first\x1b[0m");
  process.exit(2);
}

await import(entry);
