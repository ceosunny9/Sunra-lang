#!/usr/bin/env node
/**
 * Language server tests.
 *
 * These speak real LSP over stdio to `sunra lsp` — framed JSON-RPC, the same
 * transport an editor uses. Nothing is stubbed, so a passing run means an editor
 * would see the same diagnostics, completions and hovers.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/sunra.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn()
    .then(() => {
      passed += 1;
      console.log(`ok  ${name}`);
    })
    .catch((error) => {
      failed += 1;
      console.error(`FAIL  ${name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    });
}

/** A minimal LSP client: frames requests, collects responses and notifications. */
class Client {
  constructor() {
    this.child = spawn(process.execPath, [CLI, "lsp"], { stdio: ["pipe", "pipe", "pipe"] });
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];

    this.child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) console.error(`server stderr: ${text}`);
    });
  }

  drain() {
    for (;;) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator === -1) return;
      const header = this.buffer.subarray(0, separator).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(separator + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = separator + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);

      const message = JSON.parse(body);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve: settle } = this.pending.get(message.id);
        this.pending.delete(message.id);
        settle(message);
      } else if (message.method) {
        this.notifications.push(message);
        for (const waiter of this.waiters.splice(0)) waiter(message);
      }
    }
  }

  send(message) {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((settle, reject) => {
      this.pending.set(id, { resolve: settle, reject });
      this.send({ id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 15_000);
    });
  }

  notify(method, params) {
    this.send({ method, params });
  }

  /** Wait for the next diagnostics notification for a URI. */
  waitForDiagnostics(uri, minVersion) {
    const matches = (params) =>
      params.uri === uri && (minVersion === undefined || (params.version ?? 0) >= minVersion);

    const existing = this.notifications.find(
      (message) =>
        message.method === "textDocument/publishDiagnostics" && matches(message.params),
    );
    if (existing) {
      this.notifications = this.notifications.filter((message) => message !== existing);
      return Promise.resolve(existing.params);
    }
    return new Promise((settle, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for diagnostics")), 15_000);
      this.waiters.push((message) => {
        if (
          message.method === "textDocument/publishDiagnostics" &&
          matches(message.params)
        ) {
          clearTimeout(timer);
          settle(message.params);
        }
      });
    });
  }

  async open(uri, text) {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "sunra", version: 1, text },
    });
    return this.waitForDiagnostics(uri, 1);
  }

  async change(uri, text, version) {
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    return this.waitForDiagnostics(uri, version);
  }

  async close() {
    await this.request("shutdown", null);
    this.notify("exit", null);
    this.child.kill();
  }
}

const GOOD = `fn houseEdge(rtp: Float) -> Float {
    1.0 - rtp
}

fn rollDie() -> Int uses rand {
    Dice.roll(6)
}

game SolarFortune {
    rtp = 0.965
    tolerance = 0.005
    reel strip = ["CHERRY", "BELL", "SEVEN"]

    fn payout(row) -> Float {
        if Reel.isMatch(row) { 40.0 } else { 0.0 }
    }

    fn spin() -> Float uses rand {
        payout(Reel.spin(Reel.of(strip), 3))
    }
}

fn main() uses io, rand {
    print("{rollDie()}")
}
`;

const BAD = `fn spin() -> Float {
    rng.int(0, 9)
}

fn main() uses io {
    print("{spin()}")
}
`;

async function main() {
  const client = new Client();
  const initialize = await client.request("initialize", {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
  });

  await test("initialize advertises the documented capabilities", async () => {
    const caps = initialize.result.capabilities;
    assert.ok(caps.completionProvider, "no completion provider");
    assert.ok(caps.hoverProvider, "no hover provider");
    assert.ok(caps.definitionProvider, "no definition provider");
    assert.ok(caps.documentSymbolProvider, "no document symbol provider");
    assert.ok(caps.signatureHelpProvider, "no signature help provider");
    assert.ok(caps.documentFormattingProvider, "no formatting provider");
    assert.equal(initialize.result.serverInfo.name, "sunra-language-server");
  });

  client.notify("initialized", {});

  const goodUri = "file:///workspace/good.sun";
  const goodDiagnostics = await client.open(goodUri, GOOD);

  await test("a correct program produces no error diagnostics", async () => {
    const errors = goodDiagnostics.diagnostics.filter((d) => d.severity === 1);
    assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors, null, 2)}`);
  });

  await test("an undeclared effect is reported at the call site", async () => {
    const badUri = "file:///workspace/bad.sun";
    const diagnostics = await client.open(badUri, BAD);
    const errors = diagnostics.diagnostics.filter((d) => d.severity === 1);
    assert.ok(errors.length > 0, "expected an effect error");
    assert.ok(
      errors.some((d) => String(d.code).startsWith("E06")),
      `expected an effect diagnostic, got ${errors.map((d) => d.code).join(", ")}`,
    );
    assert.ok(errors[0].range.start.line >= 0);
    assert.equal(errors[0].source, "sunra");
  });

  await test("diagnostics clear once the source is repaired", async () => {
    const uri = "file:///workspace/repair.sun";
    const first = await client.open(uri, BAD);
    assert.ok(first.diagnostics.filter((d) => d.severity === 1).length > 0);
    // Repair both halves: `spin` must declare `rand`, and `main` must declare
    // it too, because effects propagate through the call graph.
    const repaired = await client.change(
      uri,
      BAD.replace("fn spin() -> Float {", "fn spin() -> Float uses rand {").replace(
        "fn main() uses io {",
        "fn main() uses io, rand {",
      ),
      2,
    );
    const errors = repaired.diagnostics.filter((d) => d.severity === 1);
    assert.equal(errors.length, 0, `expected a clean file, got ${JSON.stringify(errors)}`);
  });

  await test("member completion offers only real runtime members", async () => {
    const uri = "file:///workspace/completion.sun";
    const source = "fn f() uses rand {\n    Reel.\n}\n";
    // A trailing `Reel.` cannot parse, so diagnostics are expected here; the
    // point of the test is that completion still works on a partial document.
    await client.open(uri, source).catch(() => {});
    const response = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 1, character: 9 },
    });
    const labels = response.result.items.map((item) => item.label);
    for (const expected of ["of", "spin", "grid", "count", "isMatch", "longestRun"]) {
      assert.ok(labels.includes(expected), `Reel.${expected} missing from completion`);
    }
    assert.ok(!labels.includes("shuffled"), "Reel should not offer Deck members");
  });

  await test("completion after `uses` offers effects", async () => {
    const uri = "file:///workspace/effects.sun";
    await client.open(uri, "fn f() uses \n").catch(() => {});
    const response = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 0, character: 12 },
    });
    const labels = response.result.items.map((item) => item.label);
    for (const effect of ["rand", "io", "money", "audit"]) {
      assert.ok(labels.includes(effect), `effect ${effect} missing`);
    }
  });

  await test("completion includes user functions and locals in scope", async () => {
    const response = await client.request("textDocument/completion", {
      textDocument: { uri: goodUri },
      position: { line: 23, character: 4 },
    });
    const labels = response.result.items.map((item) => item.label);
    assert.ok(labels.includes("houseEdge"), "user function missing from completion");
    assert.ok(labels.includes("rollDie"), "user function missing from completion");
    assert.ok(labels.includes("SolarFortune"), "game missing from completion");
    assert.ok(labels.includes("Money"), "namespace missing from completion");
  });

  await test("hover explains an effectful runtime member", async () => {
    const response = await client.request("textDocument/hover", {
      textDocument: { uri: goodUri },
      position: { line: 5, character: 10 },
    });
    const value = response.result.contents.value;
    assert.match(value, /Dice\.roll/);
  });

  await test("hover explains a user function including its effects", async () => {
    const response = await client.request("textDocument/hover", {
      textDocument: { uri: goodUri },
      position: { line: 4, character: 5 },
    });
    const value = response.result.contents.value;
    assert.match(value, /fn rollDie\(\) -> Int uses rand/);
    assert.match(value, /Effects/);
  });

  await test("hover on a pure function says so", async () => {
    const response = await client.request("textDocument/hover", {
      textDocument: { uri: goodUri },
      position: { line: 0, character: 5 },
    });
    assert.match(response.result.contents.value, /Pure/);
  });

  await test("go-to-definition resolves a function to its declaration", async () => {
    const response = await client.request("textDocument/definition", {
      textDocument: { uri: goodUri },
      position: { line: 23, character: 13 },
    });
    assert.ok(response.result, "no definition returned");
    assert.equal(response.result.uri, goodUri);
    assert.equal(response.result.range.start.line, 4);
  });

  await test("document symbols describe functions, games and members", async () => {
    const response = await client.request("textDocument/documentSymbol", {
      textDocument: { uri: goodUri },
    });
    const names = response.result.map((symbol) => symbol.name);
    assert.ok(names.includes("houseEdge"));
    assert.ok(names.includes("SolarFortune"));
    const game = response.result.find((symbol) => symbol.name === "SolarFortune");
    const children = game.children.map((child) => child.name);
    assert.ok(children.includes("rtp"), "game field missing");
    assert.ok(children.includes("strip"), "reel missing");
    assert.ok(children.includes("spin"), "method missing");
  });

  await test("signature help reports the active parameter", async () => {
    const uri = "file:///workspace/signature.sun";
    await client.open(uri, "fn f() {\n    Money.of(10, 5)\n}\n");
    const response = await client.request("textDocument/signatureHelp", {
      textDocument: { uri },
      position: { line: 1, character: 17 },
    });
    assert.ok(response.result, "no signature help");
    assert.match(response.result.signatures[0].label, /Money\.of/);
    assert.equal(response.result.activeParameter, 1);
  });

  await test("document highlight finds every occurrence of an identifier", async () => {
    const response = await client.request("textDocument/documentHighlight", {
      textDocument: { uri: goodUri },
      position: { line: 0, character: 5 },
    });
    assert.ok(Array.isArray(response.result));
    assert.ok(response.result.length >= 1);
  });

  await test("formatting normalises indentation without changing tokens", async () => {
    const uri = "file:///workspace/format.sun";
    const messy = "fn f() {\nlet a = 1\n     if a > 0 {\nprint(\"{a}\")\n}\n}\n";
    await client.open(uri, messy);
    const response = await client.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 4, insertSpaces: true },
    });
    assert.ok(response.result.length === 1, "expected one edit");
    const formatted = response.result[0].newText;
    assert.match(formatted, /^fn f\(\) \{\n    let a = 1\n    if a > 0 \{\n        print/);
  });

  await test("an unparseable file still reports a diagnostic instead of crashing", async () => {
    const uri = "file:///workspace/broken.sun";
    const diagnostics = await client.open(uri, "fn ( { let = = }\n");
    assert.ok(diagnostics.diagnostics.length > 0, "expected at least one diagnostic");
    assert.equal(diagnostics.diagnostics[0].source, "sunra");
  });

  await test("closing a document clears its diagnostics", async () => {
    const uri = "file:///workspace/closing.sun";
    await client.open(uri, BAD);
    client.notify("textDocument/didClose", { textDocument: { uri } });
    // The close notification publishes an empty list with no version field.
    const cleared = await new Promise((settle, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for cleared diagnostics")), 15_000);
      client.waiters.push((message) => {
        if (
          message.method === "textDocument/publishDiagnostics" &&
          message.params.uri === uri &&
          message.params.diagnostics.length === 0
        ) {
          clearTimeout(timer);
          settle(message.params);
        }
      });
    });
    assert.equal(cleared.diagnostics.length, 0);
  });

  await client.close();

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
