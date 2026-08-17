/**
 * The Sunra language server.
 *
 * This is a Language Server Protocol implementation written directly against the
 * compiler's own front end — the same lexer, parser and checker that `sunra
 * check` uses. There is no second analysis engine, so the editor can never
 * disagree with the command line.
 *
 * The transport is base LSP over stdio: `Content-Length` framed JSON-RPC. It is
 * implemented here rather than pulled from `vscode-languageserver` so the server
 * ships with the toolchain and has no runtime dependencies.
 *
 * Supported requests:
 *   initialize / initialized / shutdown / exit
 *   textDocument/didOpen, didChange, didSave, didClose
 *   textDocument/publishDiagnostics  (server to client)
 *   textDocument/completion
 *   textDocument/hover
 *   textDocument/definition
 *   textDocument/documentSymbol
 *   textDocument/signatureHelp
 *   textDocument/documentHighlight
 *   textDocument/formatting
 */

import { tokenize } from "../lexer/lexer.js";
import { TokenKind, KEYWORDS, type Token } from "../lexer/token.js";
import { parse } from "../parser/parser.js";
import { checkProgram } from "../checker/checker.js";
import { SunraError, type Span } from "../diagnostics.js";
import type { FnDecl, GameDecl, Program, Stmt } from "../parser/ast.js";
import { NAMESPACE_DOCS, KEYWORD_DOCS, EFFECT_DOCS, BUILTIN_DOCS } from "./vocabulary.js";

// ---------------------------------------------------------------------------
// JSON-RPC transport
// ---------------------------------------------------------------------------

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** LSP positions are zero-based; Sunra spans are one-based. */
interface Position {
  line: number;
  character: number;
}

interface Range {
  start: Position;
  end: Position;
}

const SEVERITY = { error: 1, warning: 2, note: 3 } as const;

/** Completion item kinds from the LSP specification. */
const KIND = {
  text: 1,
  method: 2,
  function: 3,
  class: 7,
  field: 5,
  variable: 6,
  module: 9,
  property: 10,
  keyword: 14,
  snippet: 15,
  constant: 21,
} as const;

/** Symbol kinds from the LSP specification. */
const SYMBOL = {
  namespace: 3,
  class: 5,
  method: 6,
  property: 7,
  function: 12,
  variable: 13,
  constant: 14,
} as const;

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

interface Analysis {
  uri: string;
  version: number;
  text: string;
  tokens: Token[];
  program: Program | null;
  errors: SunraError[];
  warnings: SunraError[];
  /** Top-level and game-scoped functions, keyed by name. */
  functions: Map<string, { decl: FnDecl; container: string | null }>;
  games: Map<string, GameDecl>;
  /** Locals per function, used for completion inside a body. */
  locals: Map<string, Array<{ name: string; span: Span; mutable: boolean }>>;
}

export class LanguageServer {
  private readonly documents = new Map<string, Analysis>();
  private buffer = Buffer.alloc(0);
  private shuttingDown = false;
  /**
   * Where responses and notifications go. Over stdio this frames onto stdout; an
   * in-process session (see `LspSession`) captures them instead, so the server
   * can be driven and asserted on without spawning a child process.
   */
  private sink: ((message: RpcMessage) => void) | null = null;

  /** Route outgoing messages to `sink` instead of stdout. */
  captureInto(sink: (message: RpcMessage) => void): void {
    this.sink = sink;
  }

  /** Handle one JSON-RPC message directly, bypassing the framing layer. */
  handle(message: RpcMessage): void {
    this.dispatch(message);
  }

  /** Start reading requests from stdin and writing responses to stdout. */
  listen(): void {
    process.stdin.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    process.stdin.on("end", () => process.exit(this.shuttingDown ? 0 : 1));
  }

  /** Parse as many complete framed messages as the buffer contains. */
  private drain(): void {
    for (;;) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator === -1) return;

      const header = this.buffer.subarray(0, separator).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unrecoverable framing error: drop the header and resynchronise.
        this.buffer = this.buffer.subarray(separator + 4);
        continue;
      }

      const length = Number(match[1]);
      const start = separator + 4;
      if (this.buffer.length < start + length) return;

      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);

      let message: RpcMessage;
      try {
        message = JSON.parse(body) as RpcMessage;
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private send(message: RpcMessage): void {
    if (this.sink) {
      this.sink(message);
      return;
    }
    const body = JSON.stringify(message);
    const bytes = Buffer.byteLength(body, "utf8");
    process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${body}`);
  }

  private respond(id: number | string | null | undefined, result: unknown): void {
    if (id === undefined || id === null) return;
    this.send({ jsonrpc: "2.0", id, result });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  // ------------------------------------------------------------------ dispatch

  private dispatch(message: RpcMessage): void {
    const { method, id, params } = message;
    if (!method) return;

    try {
      switch (method) {
        case "initialize":
          this.respond(id, this.initialize());
          return;
        case "initialized":
          return;
        case "shutdown":
          this.shuttingDown = true;
          this.respond(id, null);
          return;
        case "exit":
          process.exit(this.shuttingDown ? 0 : 1);
          return;

        case "textDocument/didOpen": {
          const p = params as { textDocument: { uri: string; version: number; text: string } };
          this.analyze(p.textDocument.uri, p.textDocument.version, p.textDocument.text);
          return;
        }
        case "textDocument/didChange": {
          const p = params as {
            textDocument: { uri: string; version: number };
            contentChanges: Array<{ text: string }>;
          };
          // The server advertises full sync, so the last change carries the file.
          const text = p.contentChanges[p.contentChanges.length - 1]?.text ?? "";
          this.analyze(p.textDocument.uri, p.textDocument.version, text);
          return;
        }
        case "textDocument/didSave": {
          const p = params as { textDocument: { uri: string }; text?: string };
          const existing = this.documents.get(p.textDocument.uri);
          this.analyze(p.textDocument.uri, existing?.version ?? 0, p.text ?? existing?.text ?? "");
          return;
        }
        case "textDocument/didClose": {
          const p = params as { textDocument: { uri: string } };
          this.documents.delete(p.textDocument.uri);
          this.notify("textDocument/publishDiagnostics", {
            uri: p.textDocument.uri,
            diagnostics: [],
          });
          return;
        }

        case "textDocument/completion":
          this.respond(id, this.completion(params as never));
          return;
        case "textDocument/hover":
          this.respond(id, this.hover(params as never));
          return;
        case "textDocument/definition":
          this.respond(id, this.definition(params as never));
          return;
        case "textDocument/documentSymbol":
          this.respond(id, this.documentSymbols(params as never));
          return;
        case "textDocument/signatureHelp":
          this.respond(id, this.signatureHelp(params as never));
          return;
        case "textDocument/documentHighlight":
          this.respond(id, this.documentHighlight(params as never));
          return;
        case "textDocument/formatting":
          this.respond(id, this.formatting(params as never));
          return;

        default:
          // Unknown requests must still be answered so the client is not blocked.
          if (id !== undefined && id !== null) this.respond(id, null);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (id !== undefined && id !== null) {
        this.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: `internal error: ${detail}` },
        });
      }
    }
  }

  private initialize(): unknown {
    return {
      capabilities: {
        // 1 = full document sync. Sunra files are small; incremental sync would
        // add a second source of truth for document state for no real gain.
        textDocumentSync: { openClose: true, change: 1, save: { includeText: true } },
        completionProvider: { triggerCharacters: [".", " "], resolveProvider: false },
        hoverProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
        signatureHelpProvider: { triggerCharacters: ["(", ","] },
        documentHighlightProvider: true,
        documentFormattingProvider: true,
      },
      serverInfo: { name: "sunra-language-server", version: "0.3.0" },
    };
  }

  // ------------------------------------------------------------------ analysis

  private analyze(uri: string, version: number, text: string): void {
    let tokens: Token[] = [];
    let program: Program | null = null;
    const errors: SunraError[] = [];
    const warnings: SunraError[] = [];

    try {
      tokens = tokenize(text, uri);
    } catch (error) {
      if (error instanceof SunraError) errors.push(error);
    }

    if (tokens.length > 0) {
      try {
        program = parse(tokens);
        const result = checkProgram(program);
        errors.push(...result.errors);
        warnings.push(...result.warnings);
      } catch (error) {
        if (error instanceof SunraError) errors.push(error);
        else throw error;
      }
    }

    const analysis: Analysis = {
      uri,
      version,
      text,
      tokens,
      program,
      errors,
      warnings,
      functions: new Map(),
      games: new Map(),
      locals: new Map(),
    };

    if (program) this.index(program, analysis);
    this.documents.set(uri, analysis);
    this.publish(analysis);
  }

  /** Walk the program once, recording every declaration the editor may need. */
  private index(program: Program, analysis: Analysis): void {
    const recordLocals = (fnKey: string, body: Stmt[]): void => {
      const locals: Array<{ name: string; span: Span; mutable: boolean }> = [];
      const visit = (statements: Stmt[]): void => {
        for (const stmt of statements) {
          switch (stmt.kind) {
            case "LetStmt":
              locals.push({ name: stmt.name, span: stmt.span, mutable: stmt.mutable });
              break;
            case "ForStmt":
              locals.push({ name: stmt.binding, span: stmt.span, mutable: false });
              visit(stmt.body.body);
              break;
            case "WhileStmt":
              visit(stmt.body.body);
              break;
            case "BlockStmt":
              visit(stmt.body);
              break;
            case "IfStmt": {
              visit(stmt.then.body);
              if (stmt.otherwise) {
                visit(stmt.otherwise.kind === "BlockStmt" ? stmt.otherwise.body : [stmt.otherwise]);
              }
              break;
            }
            default:
              break;
          }
        }
      };
      visit(body);
      analysis.locals.set(fnKey, locals);
    };

    for (const stmt of program.body) {
      if (stmt.kind === "FnDecl") {
        analysis.functions.set(stmt.name, { decl: stmt, container: null });
        recordLocals(stmt.name, stmt.body.body);
      } else if (stmt.kind === "GameDecl") {
        analysis.games.set(stmt.name, stmt);
        for (const fn of stmt.functions) {
          analysis.functions.set(`${stmt.name}.${fn.name}`, { decl: fn, container: stmt.name });
          recordLocals(`${stmt.name}.${fn.name}`, fn.body.body);
        }
      }
    }
  }

  private publish(analysis: Analysis): void {
    const toDiagnostic = (error: SunraError, severity: number) => {
      const span = error.span;
      const range = span
        ? this.spanToRange(span)
        : { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
      return {
        range,
        severity,
        code: error.code,
        source: "sunra",
        message: error.hint ? `${error.message}\n\nhelp: ${error.hint}` : error.message,
      };
    };

    this.notify("textDocument/publishDiagnostics", {
      uri: analysis.uri,
      version: analysis.version,
      diagnostics: [
        ...analysis.errors.map((error) => toDiagnostic(error, SEVERITY.error)),
        ...analysis.warnings.map((warning) =>
          toDiagnostic(warning, warning.severity === "note" ? SEVERITY.note : SEVERITY.warning),
        ),
      ],
    });
  }

  // ------------------------------------------------------------- position math

  private spanToRange(span: Span): Range {
    const line = Math.max(0, span.line - 1);
    const character = Math.max(0, span.col - 1);
    return {
      start: { line, character },
      end: { line, character: character + Math.max(1, span.length ?? 1) },
    };
  }

  private lineText(analysis: Analysis, line: number): string {
    return analysis.text.split("\n")[line] ?? "";
  }

  /** The identifier-like word surrounding a position, with its start column. */
  private wordAt(analysis: Analysis, position: Position): { word: string; start: number } {
    const text = this.lineText(analysis, position.line);
    let start = position.character;
    while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1] ?? "")) start--;
    let end = position.character;
    while (end < text.length && /[A-Za-z0-9_]/.test(text[end] ?? "")) end++;
    return { word: text.slice(start, end), start };
  }

  /** Which function contains this line? Used to scope local completions. */
  private enclosingFunction(analysis: Analysis, line: number): string | null {
    let best: { key: string; startLine: number } | null = null;
    for (const [key, entry] of analysis.functions) {
      const startLine = entry.decl.span.line - 1;
      const endLine = this.functionEndLine(analysis, entry.decl);
      if (line >= startLine && line <= endLine) {
        if (!best || startLine > best.startLine) best = { key, startLine };
      }
    }
    return best?.key ?? null;
  }

  /**
   * Approximate a function's last line by scanning for the matching brace. The
   * AST does not record an end position, and brace counting is exact for the
   * subset of syntax that can appear inside a body.
   */
  private functionEndLine(analysis: Analysis, decl: FnDecl): number {
    const lines = analysis.text.split("\n");
    let depth = 0;
    let seenOpen = false;
    for (let i = decl.span.line - 1; i < lines.length; i++) {
      for (const char of lines[i] ?? "") {
        if (char === "{") {
          depth++;
          seenOpen = true;
        } else if (char === "}") {
          depth--;
          if (seenOpen && depth === 0) return i;
        }
      }
    }
    return lines.length - 1;
  }

  // ---------------------------------------------------------------- completion

  private completion(params: {
    textDocument: { uri: string };
    position: Position;
  }): unknown {
    const analysis = this.documents.get(params.textDocument.uri);
    if (!analysis) return { isIncomplete: false, items: [] };

    const line = this.lineText(analysis, params.position.line);
    const prefix = line.slice(0, params.position.character);

    // Member completion: `Reel.` offers only that namespace's members.
    const memberMatch = /([A-Za-z_][A-Za-z0-9_]*)\.\s*([A-Za-z0-9_]*)$/.exec(prefix);
    if (memberMatch) {
      const namespace = memberMatch[1];
      const members = NAMESPACE_DOCS[namespace]?.members;
      if (members) {
        return {
          isIncomplete: false,
          items: Object.entries(members).map(([name, doc]) => ({
            label: name,
            kind: KIND.method,
            detail: doc.signature,
            documentation: { kind: "markdown", value: doc.description },
            insertText: doc.snippet ?? name,
            insertTextFormat: doc.snippet ? 2 : 1,
          })),
        };
      }
      // A game instance: offer its own methods and fields.
      const game = analysis.games.get(namespace);
      if (game) {
        return {
          isIncomplete: false,
          items: [
            ...game.functions.map((fn) => ({
              label: fn.name,
              kind: KIND.method,
              detail: this.signatureOf(fn),
              documentation: { kind: "markdown", value: this.documentFunction(fn, game.name) },
            })),
            ...game.fields.map((field) => ({
              label: field.name,
              kind: KIND.property,
              detail: `field of game ${game.name}`,
            })),
          ],
        };
      }
      return { isIncomplete: false, items: [] };
    }

    // After `uses`, only effects are meaningful.
    if (/\buses\s+[A-Za-z0-9_,\s]*$/.test(prefix)) {
      return {
        isIncomplete: false,
        items: Object.entries(EFFECT_DOCS).map(([name, description]) => ({
          label: name,
          kind: KIND.constant,
          detail: "effect",
          documentation: { kind: "markdown", value: description },
        })),
      };
    }

    const items: unknown[] = [];

    // Keywords.
    for (const keyword of KEYWORDS) {
      items.push({
        label: keyword,
        kind: KIND.keyword,
        detail: "keyword",
        documentation: KEYWORD_DOCS[keyword]
          ? { kind: "markdown", value: KEYWORD_DOCS[keyword] }
          : undefined,
      });
    }

    // Namespaces.
    for (const [name, doc] of Object.entries(NAMESPACE_DOCS)) {
      items.push({
        label: name,
        kind: KIND.module,
        detail: doc.summary,
        documentation: { kind: "markdown", value: doc.description },
      });
    }

    // Builtin functions.
    for (const [name, doc] of Object.entries(BUILTIN_DOCS)) {
      items.push({
        label: name,
        kind: KIND.function,
        detail: doc.signature,
        documentation: { kind: "markdown", value: doc.description },
      });
    }

    // User declarations from this file.
    for (const [key, entry] of analysis.functions) {
      const label = entry.container ? entry.decl.name : key;
      items.push({
        label,
        kind: KIND.function,
        detail: this.signatureOf(entry.decl),
        documentation: {
          kind: "markdown",
          value: this.documentFunction(entry.decl, entry.container),
        },
      });
    }
    for (const [name, game] of analysis.games) {
      items.push({
        label: name,
        kind: KIND.class,
        detail: `game with ${game.functions.length} method(s)`,
      });
    }

    // Locals of the enclosing function.
    const enclosing = this.enclosingFunction(analysis, params.position.line);
    if (enclosing) {
      for (const local of analysis.locals.get(enclosing) ?? []) {
        items.push({
          label: local.name,
          kind: KIND.variable,
          detail: local.mutable ? "var" : "let",
        });
      }
      const entry = analysis.functions.get(enclosing);
      for (const param of entry?.decl.params ?? []) {
        items.push({ label: param.name, kind: KIND.variable, detail: "parameter" });
      }
    }

    return { isIncomplete: false, items };
  }

  // --------------------------------------------------------------------- hover

  private hover(params: { textDocument: { uri: string }; position: Position }): unknown {
    const analysis = this.documents.get(params.textDocument.uri);
    if (!analysis) return null;

    const { word, start } = this.wordAt(analysis, params.position);
    if (!word) return null;

    const line = this.lineText(analysis, params.position.line);
    // Look at what precedes the *word*, not the caret: hovering anywhere inside
    // `roll` in `Dice.roll(6)` must still resolve `Dice.roll`.
    const before = line.slice(0, start);
    const memberOf = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(before)?.[1];

    // `Reel.spin` documents the member, not the namespace.
    if (memberOf) {
      const member = NAMESPACE_DOCS[memberOf]?.members[word];
      if (member) {
        return {
          contents: {
            kind: "markdown",
            value: `\`\`\`sunra\n${member.signature}\n\`\`\`\n\n${member.description}`,
          },
        };
      }
      const game = analysis.games.get(memberOf);
      const method = game?.functions.find((fn) => fn.name === word);
      if (method) {
        return {
          contents: { kind: "markdown", value: this.documentFunction(method, memberOf) },
        };
      }
    }

    const namespace = NAMESPACE_DOCS[word];
    if (namespace) {
      return {
        contents: {
          kind: "markdown",
          value: `**${word}** — ${namespace.summary}\n\n${namespace.description}`,
        },
      };
    }

    const builtin = BUILTIN_DOCS[word];
    if (builtin) {
      return {
        contents: {
          kind: "markdown",
          value: `\`\`\`sunra\n${builtin.signature}\n\`\`\`\n\n${builtin.description}`,
        },
      };
    }

    if (KEYWORD_DOCS[word]) {
      return { contents: { kind: "markdown", value: `**${word}**\n\n${KEYWORD_DOCS[word]}` } };
    }

    if (EFFECT_DOCS[word]) {
      return {
        contents: { kind: "markdown", value: `**effect \`${word}\`**\n\n${EFFECT_DOCS[word]}` },
      };
    }

    // A function declared in this file.
    const direct = analysis.functions.get(word);
    if (direct) {
      return {
        contents: { kind: "markdown", value: this.documentFunction(direct.decl, direct.container) },
      };
    }
    for (const [, entry] of analysis.functions) {
      if (entry.decl.name === word) {
        return {
          contents: { kind: "markdown", value: this.documentFunction(entry.decl, entry.container) },
        };
      }
    }

    const game = analysis.games.get(word);
    if (game) {
      const fields = game.fields.map((field) => field.name).join(", ") || "none";
      const reels = game.reels.map((reel) => reel.name).join(", ") || "none";
      return {
        contents: {
          kind: "markdown",
          value: [
            `\`\`\`sunra\ngame ${game.name}\n\`\`\``,
            `Fields: ${fields}`,
            `Reels: ${reels}`,
            `Methods: ${game.functions.map((fn) => fn.name).join(", ") || "none"}`,
          ].join("\n\n"),
        },
      };
    }

    // A local or parameter.
    const enclosing = this.enclosingFunction(analysis, params.position.line);
    if (enclosing) {
      const local = (analysis.locals.get(enclosing) ?? []).find((item) => item.name === word);
      if (local) {
        return {
          contents: {
            kind: "markdown",
            value: `\`\`\`sunra\n${local.mutable ? "var" : "let"} ${word}\n\`\`\`\n\nDeclared on line ${local.span.line}.`,
          },
        };
      }
      const entry = analysis.functions.get(enclosing);
      const param = entry?.decl.params.find((item) => item.name === word);
      if (param) {
        const type = param.annotation ? `: ${param.annotation.name}` : "";
        return {
          contents: {
            kind: "markdown",
            value: `\`\`\`sunra\nparameter ${word}${type}\n\`\`\``,
          },
        };
      }
    }

    return null;
  }

  // ---------------------------------------------------------------- definition

  private definition(params: { textDocument: { uri: string }; position: Position }): unknown {
    const analysis = this.documents.get(params.textDocument.uri);
    if (!analysis) return null;

    const { word } = this.wordAt(analysis, params.position);
    if (!word) return null;

    const locate = (span: Span) => ({
      uri: params.textDocument.uri,
      range: this.spanToRange(span),
    });

    const direct = analysis.functions.get(word);
    if (direct) return locate(direct.decl.span);

    for (const [, entry] of analysis.functions) {
      if (entry.decl.name === word) return locate(entry.decl.span);
    }

    const game = analysis.games.get(word);
    if (game) return locate(game.span);

    const enclosing = this.enclosingFunction(analysis, params.position.line);
    if (enclosing) {
      const local = (analysis.locals.get(enclosing) ?? []).find((item) => item.name === word);
      if (local) return locate(local.span);
      const entry = analysis.functions.get(enclosing);
      const param = entry?.decl.params.find((item) => item.name === word);
      if (param) return locate(param.span);
    }

    return null;
  }

  // ------------------------------------------------------------------- symbols

  private documentSymbols(params: { textDocument: { uri: string } }): unknown {
    const analysis = this.documents.get(params.textDocument.uri);
    if (!analysis?.program) return [];

    const symbols: unknown[] = [];

    for (const stmt of analysis.program.body) {
      if (stmt.kind === "FnDecl") {
        symbols.push({
          name: stmt.name,
          detail: this.signatureOf(stmt),
          kind: SYMBOL.function,
          range: this.spanToRange(stmt.span),
          selectionRange: this.spanToRange(stmt.span),
        });
      } else if (stmt.kind === "GameDecl") {
        symbols.push({
          name: stmt.name,
          detail: `game (${stmt.functions.length} method(s))`,
          kind: SYMBOL.class,
          range: this.spanToRange(stmt.span),
          selectionRange: this.spanToRange(stmt.span),
          children: [
            ...stmt.fields.map((field) => ({
              name: field.name,
              kind: SYMBOL.property,
              range: this.spanToRange(field.span),
              selectionRange: this.spanToRange(field.span),
            })),
            ...stmt.reels.map((reel) => ({
              name: reel.name,
              detail: "reel",
              kind: SYMBOL.property,
              range: this.spanToRange(reel.span),
              selectionRange: this.spanToRange(reel.span),
            })),
            ...stmt.functions.map((fn) => ({
              name: fn.name,
              detail: this.signatureOf(fn),
              kind: SYMBOL.method,
              range: this.spanToRange(fn.span),
              selectionRange: this.spanToRange(fn.span),
            })),
          ],
        });
      } else if (stmt.kind === "TestDecl") {
        symbols.push({
          name: `test "${stmt.name}"`,
          kind: SYMBOL.function,
          range: this.spanToRange(stmt.span),
          selectionRange: this.spanToRange(stmt.span),
        });
      } else if (stmt.kind === "TypeDecl") {
        symbols.push({
          name: stmt.name,
          detail: "type",
          kind: SYMBOL.class,
          range: this.spanToRange(stmt.span),
          selectionRange: this.spanToRange(stmt.span),
        });
      }
    }

    return symbols;
  }

  // -------------------------------------------------------------- signatures

  private signatureHelp(params: {
    textDocument: { uri: string };
    position: Position;
  }): unknown {
    const analysis = this.documents.get(params.textDocument.uri);
    if (!analysis) return null;

    const prefix = this.lineText(analysis, params.position.line).slice(0, params.position.character);

    // Find the innermost unclosed call and count the commas inside it.
    let depth = 0;
    let callStart = -1;
    let commas = 0;
    for (let i = prefix.length - 1; i >= 0; i--) {
      const char = prefix[i];
      if (char === ")") depth++;
      else if (char === "(") {
        if (depth === 0) {
          callStart = i;
          break;
        }
        depth--;
      } else if (char === "," && depth === 0) commas++;
    }
    if (callStart === -1) return null;

    const before = prefix.slice(0, callStart);
    const nameMatch = /([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?$/.exec(before);
    if (!nameMatch) return null;

    const [, first, second] = nameMatch;
    let signature: string | null = null;
    let documentation = "";

    if (second) {
      const member = NAMESPACE_DOCS[first]?.members[second];
      if (member) {
        signature = member.signature;
        documentation = member.description;
      } else {
        const game = analysis.games.get(first);
        const method = game?.functions.find((fn) => fn.name === second);
        if (method) {
          signature = this.signatureOf(method);
          documentation = `Method of game \`${first}\`.`;
        }
      }
    } else {
      const builtin = BUILTIN_DOCS[first];
      if (builtin) {
        signature = builtin.signature;
        documentation = builtin.description;
      } else {
        const entry =
          analysis.functions.get(first) ??
          [...analysis.functions.values()].find((item) => item.decl.name === first);
        if (entry) {
          signature = this.signatureOf(entry.decl);
          documentation = this.documentFunction(entry.decl, entry.container);
        }
      }
    }

    if (!signature) return null;

    // Parameter ranges are derived from the rendered signature text.
    const inside = /\(([^)]*)\)/.exec(signature)?.[1] ?? "";
    const parameters = inside
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((label) => ({ label }));

    return {
      signatures: [
        {
          label: signature,
          documentation: { kind: "markdown", value: documentation },
          parameters,
        },
      ],
      activeSignature: 0,
      activeParameter: Math.min(commas, Math.max(0, parameters.length - 1)),
    };
  }

  // ------------------------------------------------------------------ highlight

  private documentHighlight(params: {
    textDocument: { uri: string };
    position: Position;
  }): unknown {
    const analysis = this.documents.get(params.textDocument.uri);
    if (!analysis) return [];

    const { word } = this.wordAt(analysis, params.position);
    if (!word) return [];

    const highlights: unknown[] = [];
    for (const token of analysis.tokens) {
      if (token.kind === TokenKind.Ident && token.value === word) {
        highlights.push({ range: this.spanToRange(token.span), kind: 1 });
      }
    }
    return highlights;
  }

  // ----------------------------------------------------------------- formatting

  /**
   * Formatting is deliberately conservative: it normalises indentation to four
   * spaces per brace level, strips trailing whitespace, and collapses runs of
   * blank lines. It never reflows expressions, because a formatter that rewrites
   * code it does not fully model would be worse than none.
   */
  private formatting(params: { textDocument: { uri: string } }): unknown {
    const analysis = this.documents.get(params.textDocument.uri);
    if (!analysis) return [];

    const lines = analysis.text.split("\n");
    const out: string[] = [];
    let depth = 0;
    let blankRun = 0;

    for (const raw of lines) {
      const trimmed = raw.trim();

      if (trimmed === "") {
        blankRun++;
        if (blankRun <= 1) out.push("");
        continue;
      }
      blankRun = 0;

      // A closing brace belongs to the level it closes.
      const leadingClose = /^[})\]]/.test(trimmed);
      const indent = "    ".repeat(Math.max(0, leadingClose ? depth - 1 : depth));
      out.push(indent + trimmed);

      // Count net brace depth outside strings and comments.
      let inString = false;
      let stringChar = "";
      for (let i = 0; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (inString) {
          if (char === "\\") i++;
          else if (char === stringChar) inString = false;
          continue;
        }
        if (char === '"' || char === "'") {
          inString = true;
          stringChar = char;
          continue;
        }
        if (char === "#") break;
        if (char === "{" || char === "(" || char === "[") depth++;
        else if (char === "}" || char === ")" || char === "]") depth = Math.max(0, depth - 1);
      }
    }

    const formatted = out.join("\n").replace(/\n+$/, "") + "\n";
    if (formatted === analysis.text) return [];

    return [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: lines.length + 1, character: 0 },
        },
        newText: formatted,
      },
    ];
  }

  // -------------------------------------------------------------------- helpers

  private signatureOf(decl: FnDecl): string {
    const params = decl.params
      .map((param) => (param.annotation ? `${param.name}: ${param.annotation.name}` : param.name))
      .join(", ");
    const ret = decl.returnType ? ` -> ${decl.returnType.name}` : "";
    const effects = decl.effects.length > 0 ? ` uses ${decl.effects.join(", ")}` : "";
    return `fn ${decl.name}(${params})${ret}${effects}`;
  }

  private documentFunction(decl: FnDecl, container: string | null): string {
    const lines = [`\`\`\`sunra\n${this.signatureOf(decl)}\n\`\`\``];
    if (container) lines.push(`Method of game \`${container}\`.`);
    lines.push(
      decl.effects.length === 0
        ? "**Pure.** This function cannot read the random source, print, or touch the network, so its result is a function of its arguments alone."
        : `**Effects:** ${decl.effects.map((effect) => `\`${effect}\``).join(", ")}. Any caller must declare these too.`,
    );
    if (decl.intent) lines.push(`Intent: ${decl.intent}`);
    return lines.join("\n\n");
  }
}

/** Entry point used by `sunra lsp`. */
export function startLanguageServer(): void {
  new LanguageServer().listen();
}

/**
 * An in-process LSP session.
 *
 * Editors talk to the server over stdio, but tests, the playground and any other
 * embedder need the same answers without a subprocess. `LspSession` drives
 * `LanguageServer` directly and collects every response and notification it
 * produces, so a request is a plain method call.
 */
export class LspSession {
  private readonly server = new LanguageServer();
  private readonly responses = new Map<number, unknown>();
  private readonly notifications: Array<{ method: string; params: unknown }> = [];
  private nextId = 1;

  constructor() {
    this.server.captureInto((message) => {
      if (message.method) {
        this.notifications.push({ method: message.method, params: message.params });
        return;
      }
      if (typeof message.id === "number") {
        this.responses.set(message.id, message.error ?? message.result);
      }
    });
  }

  /** Send a request and return its result. */
  request<T = unknown>(method: string, params?: unknown): T {
    const id = this.nextId++;
    this.server.handle({ jsonrpc: "2.0", id, method, params });
    return this.responses.get(id) as T;
  }

  /** Send a notification (no reply expected). */
  notify(method: string, params?: unknown): void {
    this.server.handle({ jsonrpc: "2.0", method, params });
  }

  /** Open a document, which triggers analysis and publishes diagnostics. */
  open(uri: string, text: string, version = 1): void {
    this.notify("textDocument/didOpen", { textDocument: { uri, version, text } });
  }

  /** Replace a document's contents (the server advertises full sync). */
  change(uri: string, text: string, version = 2): void {
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /** Convenience wrappers for the four capabilities an editor uses most. */
  completion(uri: string, line: number, character: number): unknown {
    return this.request("textDocument/completion", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  hover(uri: string, line: number, character: number): unknown {
    return this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  definition(uri: string, line: number, character: number): unknown {
    return this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  /** The most recent diagnostics published for `uri`. */
  diagnostics(uri: string): Array<{ severity: number; message: string; code?: string }> {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      const entry = this.notifications[i];
      if (entry.method !== "textDocument/publishDiagnostics") continue;
      const params = entry.params as {
        uri: string;
        diagnostics: Array<{ severity: number; message: string; code?: string }>;
      };
      if (params.uri === uri) return params.diagnostics;
    }
    return [];
  }

  /** Every notification the server has emitted, oldest first. */
  get sentNotifications(): ReadonlyArray<{ method: string; params: unknown }> {
    return this.notifications;
  }
}
