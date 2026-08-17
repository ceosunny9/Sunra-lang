#!/usr/bin/env node
/**
 * Registry tests.
 *
 * These run a real HTTP server on a loopback port and drive it with the real
 * client, including the `sunra pkg publish` CLI path. Mocking the transport here
 * would defeat the purpose: the properties worth testing — that publishing is
 * immutable, that an altered archive is rejected, that anonymous writes are
 * refused — only exist end to end.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/sunra.js");

const { startRegistry, RegistryStore } = await import(resolve(ROOT, "dist/registry/server.js"));
const { RegistryClient, createArchive, extractArchive, packProject } = await import(
  resolve(ROOT, "dist/pkg/client.js")
);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

const TOKEN = "sunra_test_token_0123456789";

/** Start a registry in a fresh directory, and always shut it down. */
async function withRegistry(fn) {
  const root = mkdtempSync(join(tmpdir(), "sunra-registry-"));
  const registry = await startRegistry({ root, port: 0, tokens: [TOKEN], quiet: true });
  try {
    return await fn(registry, root);
  } finally {
    await registry.close();
  }
}

/** A minimal publishable project on disk. */
function makeProject(name, version, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sunra-project-"));
  writeFileSync(
    join(dir, "sunra.toml"),
    [
      "[package]",
      `name = ${JSON.stringify(name)}`,
      `version = ${JSON.stringify(version)}`,
      `description = ${JSON.stringify(extra.description ?? "A test package.")}`,
      `license = ${JSON.stringify(extra.license ?? "MIT")}`,
      'authors = ["Test Author"]',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "main.sun"),
    ['fn main() uses io {', '    print("hello from ' + name + '")', "}", ""].join("\n"),
  );
  writeFileSync(join(dir, "paytable.sun"), ["module paytable", "", "fn rtp() -> Float {", "    0.965", "}", ""].join("\n"));
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  // Excluded from the archive, so its absence proves the filter works.
  mkdirSync(join(dir, "sunra_modules", "junk"), { recursive: true });
  writeFileSync(join(dir, "sunra_modules", "junk", "junk.sun"), "module junk\n");
  return dir;
}

function sunra(args, options = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function plain(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------- archives

await test("an archive round-trips through tar and gzip", () => {
  const entries = [
    { path: "sunra.toml", content: Buffer.from("[package]\nname = \"x\"\n") },
    { path: "main.sun", content: Buffer.from("fn main() {}\n") },
  ];
  const restored = extractArchive(createArchive(entries));
  assert.equal(restored.length, 2);
  const byPath = new Map(restored.map((entry) => [entry.path, entry.content.toString()]));
  assert.equal(byPath.get("main.sun"), "fn main() {}\n");
  assert.equal(byPath.get("sunra.toml"), '[package]\nname = "x"\n');
});

await test("archives are byte-identical across runs", () => {
  // Reproducibility is what makes the integrity digest meaningful.
  const entries = [{ path: "main.sun", content: Buffer.from("fn main() {}\n") }];
  const first = createArchive(entries);
  const second = createArchive(entries);
  assert.ok(first.equals(second), "two archives of the same input differed");
});

await test("packing excludes vendored dependencies and build output", () => {
  const dir = makeProject("pack-test", "0.1.0");
  const archive = packProject(dir);
  assert.ok(archive.files.includes("sunra.toml"));
  assert.ok(archive.files.includes("main.sun"));
  assert.ok(archive.files.includes("paytable.sun"));
  assert.ok(archive.files.includes("README.md"));
  assert.ok(
    !archive.files.some((file) => file.startsWith("sunra_modules/")),
    `sunra_modules leaked into the archive: ${archive.files.join(", ")}`,
  );
  assert.match(archive.integrity, /^sha256-[0-9a-f]{64}$/);
});

await test("packing a directory without a manifest is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "sunra-empty-"));
  assert.throws(() => packProject(dir), /no sunra\.toml/);
});

// ------------------------------------------------------------------ service

await test("the server reports its own description and health", async () => {
  await withRegistry(async (registry) => {
    const api = new RegistryClient(registry.url, TOKEN);
    const ping = await api.ping();
    assert.equal(ping.ok, true);
    assert.equal(ping.body.packages, 0);
  });
});

await test("publishing then reading back returns identical metadata", async () => {
  await withRegistry(async (registry) => {
    const dir = makeProject("solar-fortune", "0.1.0", { description: "A slot paytable." });
    const api = new RegistryClient(registry.url, TOKEN);
    const { readManifest } = await import(resolve(ROOT, "dist/pkg/manifest.js"));
    const manifest = readManifest(readFileSync(join(dir, "sunra.toml"), "utf8"));
    const archive = packProject(dir);

    const published = await api.publish(manifest, archive, "Test Author");
    assert.equal(published.ok, true, JSON.stringify(published.body));
    assert.equal(published.body.published.name, "solar-fortune");
    assert.equal(published.body.published.integrity, archive.integrity);

    const fetched = await api.versionInfo("solar-fortune", "0.1.0");
    assert.equal(fetched.ok, true);
    assert.equal(fetched.body.description, "A slot paytable.");
    assert.equal(fetched.body.license, "MIT");
    assert.equal(fetched.body.yanked, false);
  });
});

await test("publishing the same version twice is refused", async () => {
  await withRegistry(async (registry) => {
    const dir = makeProject("immutable-pkg", "0.1.0");
    const api = new RegistryClient(registry.url, TOKEN);
    const { readManifest } = await import(resolve(ROOT, "dist/pkg/manifest.js"));
    const manifest = readManifest(readFileSync(join(dir, "sunra.toml"), "utf8"));
    const archive = packProject(dir);

    assert.equal((await api.publish(manifest, archive, "a")).ok, true);
    const second = await api.publish(manifest, archive, "a");
    assert.equal(second.ok, false);
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already published/);
  });
});

await test("publishing without a token is refused", async () => {
  await withRegistry(async (registry) => {
    const dir = makeProject("anon-pkg", "0.1.0");
    const api = new RegistryClient(registry.url); // no token
    const { readManifest } = await import(resolve(ROOT, "dist/pkg/manifest.js"));
    const manifest = readManifest(readFileSync(join(dir, "sunra.toml"), "utf8"));

    const response = await api.publish(manifest, packProject(dir), "nobody");
    assert.equal(response.ok, false);
    assert.equal(response.status, 401);
  });
});

await test("publishing with the wrong token is refused", async () => {
  await withRegistry(async (registry) => {
    const dir = makeProject("wrong-token-pkg", "0.1.0");
    const api = new RegistryClient(registry.url, "sunra_not_the_right_token");
    const { readManifest } = await import(resolve(ROOT, "dist/pkg/manifest.js"));
    const manifest = readManifest(readFileSync(join(dir, "sunra.toml"), "utf8"));

    const response = await api.publish(manifest, packProject(dir), "nobody");
    assert.equal(response.status, 401);
  });
});

await test("a non-semantic version is refused", async () => {
  await withRegistry(async (registry, root) => {
    const store = new RegistryStore(root, [TOKEN]);
    const outcome = store.publish(
      {
        name: "bad-version",
        version: "one-point-oh",
        description: "",
        license: "MIT",
        effects: [],
        modules: [],
        dependencies: [],
        publisher: "test",
      },
      Buffer.from("x"),
    );
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /not a semantic version/);
  });
});

await test("an uppercase package name is refused", async () => {
  await withRegistry(async (registry, root) => {
    const store = new RegistryStore(root, [TOKEN]);
    const outcome = store.publish(
      {
        name: "Bad-Name",
        version: "1.0.0",
        description: "",
        license: "MIT",
        effects: [],
        modules: [],
        dependencies: [],
        publisher: "test",
      },
      Buffer.from("x"),
    );
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /lowercase/);
  });
});

await test("downloading verifies the digest and unpacks the sources", async () => {
  await withRegistry(async (registry) => {
    const dir = makeProject("verified-pkg", "0.2.0");
    const api = new RegistryClient(registry.url, TOKEN);
    const { readManifest } = await import(resolve(ROOT, "dist/pkg/manifest.js"));
    const manifest = readManifest(readFileSync(join(dir, "sunra.toml"), "utf8"));
    await api.publish(manifest, packProject(dir), "test");

    const consumer = makeProject("consumer", "0.1.0");
    const installed = await api.install("verified-pkg", "0.2.0", consumer);
    assert.equal(installed.ok, true, installed.error);
    assert.ok(installed.files.includes("main.sun"));

    const unpacked = readFileSync(
      join(consumer, "sunra_modules", "verified-pkg", "paytable.sun"),
      "utf8",
    );
    assert.match(unpacked, /module paytable/);
  });
});

await test("a tampered archive fails the integrity check", async () => {
  await withRegistry(async (registry, root) => {
    const dir = makeProject("tampered-pkg", "0.1.0");
    const api = new RegistryClient(registry.url, TOKEN);
    const { readManifest } = await import(resolve(ROOT, "dist/pkg/manifest.js"));
    const manifest = readManifest(readFileSync(join(dir, "sunra.toml"), "utf8"));
    await api.publish(manifest, packProject(dir), "test");

    // Rewrite the stored archive behind the registry's back, exactly what a
    // compromised mirror would do.
    const stored = join(root, "packages", "tampered-pkg", "0.1.0", "package.tgz");
    const original = readFileSync(stored);
    const altered = Buffer.from(original);
    altered[altered.length - 1] ^= 0xff;
    writeFileSync(stored, altered);

    const download = await api.download("tampered-pkg", "0.1.0");
    assert.equal(download.ok, false);
    assert.match(download.error, /integrity check failed/);
  });
});

await test("yanking hides a version from `latest` but keeps it downloadable", async () => {
  await withRegistry(async (registry) => {
    const api = new RegistryClient(registry.url, TOKEN);
    const { readManifest } = await import(resolve(ROOT, "dist/pkg/manifest.js"));

    for (const version of ["0.1.0", "0.2.0"]) {
      const dir = makeProject("yank-pkg", version);
      const manifest = readManifest(readFileSync(join(dir, "sunra.toml"), "utf8"));
      await api.publish(manifest, packProject(dir), "test");
    }

    const yanked = await api.yank("yank-pkg", "0.2.0");
    assert.equal(yanked.ok, true);

    const info = await api.info("yank-pkg");
    assert.equal(info.body.latest, "0.1.0");
    assert.deepEqual(info.body.yanked, ["0.2.0"]);

    // The bytes must remain available so existing lockfiles keep working.
    const download = await api.download("yank-pkg", "0.2.0");
    assert.equal(download.ok, true);
  });
});

await test("search matches names, descriptions and module names", async () => {
  await withRegistry(async (registry) => {
    const api = new RegistryClient(registry.url, TOKEN);
    const { readManifest } = await import(resolve(ROOT, "dist/pkg/manifest.js"));

    const first = makeProject("baccarat-rules", "0.1.0", { description: "Table game logic." });
    await api.publish(
      readManifest(readFileSync(join(first, "sunra.toml"), "utf8")),
      packProject(first),
      "test",
    );
    const second = makeProject("reel-math", "0.1.0", { description: "Slot volatility helpers." });
    await api.publish(
      readManifest(readFileSync(join(second, "sunra.toml"), "utf8")),
      packProject(second),
      "test",
    );

    const byName = await api.search("baccarat");
    assert.equal(byName.body.results.length, 1);
    assert.equal(byName.body.results[0].name, "baccarat-rules");

    const byDescription = await api.search("volatility");
    assert.equal(byDescription.body.results.length, 1);
    assert.equal(byDescription.body.results[0].name, "reel-math");

    const all = await api.all();
    assert.equal(all.body.packages.length, 2);
  });
});

await test("versions are listed newest first, not alphabetically", async () => {
  await withRegistry(async (registry) => {
    const api = new RegistryClient(registry.url, TOKEN);
    const { readManifest } = await import(resolve(ROOT, "dist/pkg/manifest.js"));
    // 0.10.0 sorts before 0.9.0 as a string; semver ordering must win.
    for (const version of ["0.9.0", "0.10.0"]) {
      const dir = makeProject("order-pkg", version);
      await api.publish(
        readManifest(readFileSync(join(dir, "sunra.toml"), "utf8")),
        packProject(dir),
        "test",
      );
    }
    const info = await api.info("order-pkg");
    assert.equal(info.body.latest, "0.10.0");
    assert.deepEqual(info.body.versions, ["0.10.0", "0.9.0"]);
  });
});

await test("a path-traversing archive is refused at install time", async () => {
  await withRegistry(async (registry, root) => {
    const store = new RegistryStore(root, [TOKEN]);
    const malicious = createArchive([
      { path: "../escaped.sun", content: Buffer.from("module escaped\n") },
    ]);
    store.publish(
      {
        name: "evil-pkg",
        version: "1.0.0",
        description: "",
        license: "MIT",
        effects: [],
        modules: [],
        dependencies: [],
        publisher: "attacker",
      },
      malicious,
    );

    const api = new RegistryClient(registry.url, TOKEN);
    const consumer = makeProject("consumer2", "0.1.0");
    const installed = await api.install("evil-pkg", "1.0.0", consumer);
    assert.equal(installed.ok, false);
    assert.match(installed.error, /suspicious path/);
  });
});

// -------------------------------------------------------------------- CLI

await test("`sunra pkg pack` writes an archive and lists its contents", () => {
  const dir = makeProject("cli-pack", "0.1.0");
  const output = plain(sunra(["pkg", "pack"], { cwd: dir }));
  assert.match(output, /cli-pack/);
  assert.match(output, /integrity\s+sha256-[0-9a-f]{64}/);
  assert.match(output, /main\.sun/);
  const archive = readFileSync(join(dir, "cli-pack-0.1.0.tgz"));
  assert.ok(archive.length > 0);
});

await test("`sunra pkg publish` uploads to a live registry", async () => {
  await withRegistry(async (registry) => {
    const dir = makeProject("cli-publish", "0.3.0");
    const output = plain(
      sunra(["pkg", "publish", "--registry", registry.url, "--token", TOKEN], { cwd: dir }),
    );
    assert.match(output, /published cli-publish@0\.3\.0/);

    const api = new RegistryClient(registry.url, TOKEN);
    const info = await api.info("cli-publish");
    assert.equal(info.body.latest, "0.3.0");
    // Modules are discovered from the actual .sun files, not asserted by hand.
    const version = await api.versionInfo("cli-publish", "0.3.0");
    assert.ok(version.body.modules.includes("paytable"));
  });
});

await test("`sunra pkg publish` without a token reports how to get one", () => {
  const dir = makeProject("cli-no-token", "0.1.0");
  let combined = "";
  try {
    sunra(["pkg", "publish", "--registry", "http://127.0.0.1:59999"], {
      cwd: dir,
      env: { ...process.env, SUNRA_TOKEN: "", HOME: mkdtempSync(join(tmpdir(), "sunra-home-")) },
    });
    throw new Error("publish succeeded without a token");
  } catch (error) {
    combined = plain(String(error.stdout ?? "") + String(error.stderr ?? ""));
  }
  assert.match(combined, /no publish token/);
  assert.match(combined, /sunra pkg login/);
});

await test("`sunra pkg fetch` installs and verifies from the CLI", async () => {
  await withRegistry(async (registry) => {
    const publisher = makeProject("cli-fetch", "0.1.0");
    sunra(["pkg", "publish", "--registry", registry.url, "--token", TOKEN], { cwd: publisher });

    const consumer = makeProject("cli-consumer", "0.1.0");
    const output = plain(
      sunra(["pkg", "fetch", "cli-fetch", "--registry", registry.url], { cwd: consumer }),
    );
    assert.match(output, /fetched cli-fetch@0\.1\.0/);
    assert.match(output, /sha256-[0-9a-f]{64}/);
    const installed = readFileSync(
      join(consumer, "sunra_modules", "cli-fetch", "main.sun"),
      "utf8",
    );
    assert.match(installed, /hello from cli-fetch/);
  });
});

await test("`sunra pkg ping` reports an unreachable registry clearly", () => {
  const dir = makeProject("cli-ping", "0.1.0");
  let combined = "";
  try {
    sunra(["pkg", "ping", "--registry", "http://127.0.0.1:59998"], { cwd: dir });
    throw new Error("ping succeeded against a closed port");
  } catch (error) {
    combined = plain(String(error.stdout ?? "") + String(error.stderr ?? ""));
  }
  assert.match(combined, /could not reach the registry/);
});

await test("`sunra pkg search --remote` queries the live registry", async () => {
  await withRegistry(async (registry) => {
    const dir = makeProject("cli-search-target", "0.1.0", { description: "Cascading reels." });
    sunra(["pkg", "publish", "--registry", registry.url, "--token", TOKEN], { cwd: dir });

    const output = plain(
      sunra(["pkg", "search", "cascading", "--remote", "--registry", registry.url], { cwd: dir }),
    );
    assert.match(output, /cli-search-target/);
    assert.match(output, /Cascading reels/);
  });
});

await test("the offline catalogue still works without a registry", () => {
  const output = plain(sunra(["pkg", "search", "slots"]));
  assert.match(output, /sunra-slots/);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
