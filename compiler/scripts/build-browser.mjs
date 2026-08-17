/**
 * Bundle the Sunra frontend for the browser.
 *
 * The only platform dependency in the analysis path is `node:crypto`, used by
 * the fairness module and the secure generator. It is aliased to a Web Crypto
 * shim, so the bundle is the real compiler rather than a reduced version of it.
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const outFile = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : join(root, "dist-browser", "sunra.browser.js");

const shim = join(root, "src", "browser", "crypto_shim.ts");

const result = await build({
  entryPoints: [join(root, "src", "browser", "index.ts")],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: process.argv.includes("--minify"),
  sourcemap: false,
  legalComments: "none",
  alias: {
    "node:crypto": shim,
    crypto: shim,
  },
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  logLevel: "info",
  metafile: true,
});

const bytes = statSync(outFile).size;
console.log(`\nbundled ${(bytes / 1024).toFixed(1)} KB -> ${outFile}`);

const inputs = Object.keys(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs);
console.log(`included ${inputs.length} modules`);
