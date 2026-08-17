import { KEYWORDS, TokenKind, type Token } from "./token.js";
import { lexError, type Span } from "../diagnostics.js";

/**
 * The Sunra lexer.
 *
 * Per the language design, the lexer is layout-aware: it tracks indentation and
 * emits explicit Indent / Dedent / Newline tokens so that every downstream stage
 * operates on a token stream with unambiguous block structure. Brace-delimited
 * blocks are also accepted (they are the canonical form for generated code and
 * one-liners), and inside brace blocks layout tokens are suppressed.
 */
export class Lexer {
  private readonly src: string;
  private readonly file: string;
  private pos = 0;
  private line = 1;
  private col = 1;

  private tokens: Token[] = [];
  private indentStack: number[] = [0];
  /** depth of (), [] and {} nesting — layout is suppressed while > 0 */
  private brackets: string[] = [];
  private atLineStart = true;

  constructor(src: string, file = "<anonymous>") {
    // normalise line endings and expand tabs to 4 spaces for stable columns
    this.src = src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    this.file = file;
  }

  tokenize(): Token[] {
    while (!this.eof()) {
      if (this.atLineStart && this.brackets.length === 0) {
        this.handleLineStart();
        continue;
      }
      this.scanToken();
    }

    // close any open layout blocks at EOF
    this.pushLayout(TokenKind.Newline, "\\n");
    while (this.indentStack.length > 1) {
      this.indentStack.pop();
      this.pushLayout(TokenKind.Dedent, "");
    }
    this.push(TokenKind.Eof, "", this.span(0));
    return this.tokens;
  }

  // ---------------------------------------------------------------- layout

  private handleLineStart(): void {
    const start = this.pos;
    let width = 0;
    while (!this.eof() && (this.peek() === " " || this.peek() === "\t")) {
      width += 1;
      this.advance();
    }

    // blank line or comment-only line: no layout significance
    if (this.eof() || this.peek() === "\n") {
      if (!this.eof()) {
        this.advance(); // consume newline
        this.line += 1;
        this.col = 1;
      }
      return;
    }
    if (
      (this.peek() === "#" && this.peekAt(1) !== "[") ||
      (this.peek() === "/" && this.peekAt(1) === "/")
    ) {
      while (!this.eof() && this.peek() !== "\n") this.advance();
      if (!this.eof()) {
        this.advance(); // consume the trailing newline
        this.line += 1;
        this.col = 1;
      }
      return;
    }

    this.atLineStart = false;
    this.col = width + 1;
    const current = this.indentStack[this.indentStack.length - 1];

    if (width > current) {
      this.indentStack.push(width);
      this.pushLayout(TokenKind.Indent, " ".repeat(width));
    } else if (width < current) {
      while (this.indentStack.length > 1 && width < this.indentStack[this.indentStack.length - 1]) {
        this.indentStack.pop();
        this.pushLayout(TokenKind.Dedent, "");
      }
      if (width !== this.indentStack[this.indentStack.length - 1]) {
        throw lexError(
          "inconsistent indentation: this line does not match any enclosing block",
          { file: this.file, line: this.line, col: 1, length: Math.max(1, width) },
          "run `sunra fmt` to normalise indentation, or align this line with an enclosing block",
        );
      }
    }
    void start;
  }

  /** Emit a layout token, collapsing duplicate newlines. */
  private pushLayout(kind: TokenKind, value: string): void {
    if (kind === TokenKind.Newline) {
      const last = this.tokens[this.tokens.length - 1];
      if (!last || last.kind === TokenKind.Newline || last.kind === TokenKind.Indent) return;
    }
    this.push(kind, value, this.span(0));
  }

  // ---------------------------------------------------------------- scanning

  private scanToken(): void {
    const ch = this.peek();

    // whitespace (not at line start)
    if (ch === " ") {
      this.advance();
      return;
    }

    // newline
    if (ch === "\n") {
      this.advance();
      this.line += 1;
      this.col = 1;
      if (this.brackets.length === 0) {
        this.pushLayout(TokenKind.Newline, "\\n");
        this.atLineStart = true;
      }
      return;
    }

    // line comments: `#` (unless attribute `#[`) and `//`
    if (ch === "#" && this.peekAt(1) !== "[") {
      while (!this.eof() && this.peek() !== "\n") this.advance();
      return;
    }
    if (ch === "/" && this.peekAt(1) === "/") {
      while (!this.eof() && this.peek() !== "\n") this.advance();
      return;
    }
    // block comment
    if (ch === "/" && this.peekAt(1) === "*") {
      this.advance();
      this.advance();
      let depth = 1;
      while (!this.eof() && depth > 0) {
        if (this.peek() === "/" && this.peekAt(1) === "*") {
          depth += 1;
          this.advance();
          this.advance();
        } else if (this.peek() === "*" && this.peekAt(1) === "/") {
          depth -= 1;
          this.advance();
          this.advance();
        } else {
          if (this.peek() === "\n") {
            this.line += 1;
            this.col = 0;
          }
          this.advance();
        }
      }
      return;
    }

    if (this.isDigit(ch)) return this.scanNumber();
    if (ch === '"') return this.scanString();
    if (this.isIdentStart(ch)) return this.scanIdent();

    this.scanOperator();
  }

  private scanNumber(): void {
    const startLine = this.line;
    const startCol = this.col;
    let text = "";
    let isFloat = false;

    while (!this.eof() && (this.isDigit(this.peek()) || this.peek() === "_")) {
      const c = this.advance();
      if (c !== "_") text += c;
    }
    // fractional part — but not a `..` range operator
    if (this.peek() === "." && this.isDigit(this.peekAt(1))) {
      isFloat = true;
      text += this.advance();
      while (!this.eof() && (this.isDigit(this.peek()) || this.peek() === "_")) {
        const c = this.advance();
        if (c !== "_") text += c;
      }
    }

    const span: Span = { file: this.file, line: startLine, col: startCol, length: text.length };
    const value = Number(text);
    this.tokens.push({
      kind: isFloat ? TokenKind.Float : TokenKind.Int,
      value: text,
      span,
      literal: value,
    });
  }

  private scanString(): void {
    const startLine = this.line;
    const startCol = this.col;
    this.advance(); // opening quote

    // triple-quoted string (used by `intent` blocks)
    if (this.peek() === '"' && this.peekAt(1) === '"') {
      this.advance();
      this.advance();
      let text = "";
      while (!this.eof() && !(this.peek() === '"' && this.peekAt(1) === '"' && this.peekAt(2) === '"')) {
        if (this.peek() === "\n") {
          this.line += 1;
          this.col = 0;
        }
        text += this.advance();
      }
      if (this.eof()) {
        throw lexError("unterminated triple-quoted string", {
          file: this.file,
          line: startLine,
          col: startCol,
          length: 3,
        });
      }
      this.advance();
      this.advance();
      this.advance();
      this.tokens.push({
        kind: TokenKind.Str,
        value: text,
        span: { file: this.file, line: startLine, col: startCol, length: text.length + 6 },
        literal: text.trim(),
      });
      return;
    }

    let raw = "";
    let cooked = "";
    while (!this.eof() && this.peek() !== '"') {
      if (this.peek() === "\n") {
        throw lexError(
          "unterminated string literal",
          { file: this.file, line: startLine, col: startCol, length: raw.length + 1 },
          'string literals may not span lines; use """ for multi-line text',
        );
      }
      if (this.peek() === "\\") {
        raw += this.advance();
        const esc = this.advance();
        raw += esc;
        switch (esc) {
          case "n":
            cooked += "\n";
            break;
          case "t":
            cooked += "\t";
            break;
          case "r":
            cooked += "\r";
            break;
          case '"':
            cooked += '"';
            break;
          case "\\":
            cooked += "\\";
            break;
          case "{":
            cooked += "\\{";
            break;
          default:
            cooked += esc;
        }
        continue;
      }
      const c = this.advance();
      raw += c;
      cooked += c;
    }
    if (this.eof()) {
      throw lexError("unterminated string literal", {
        file: this.file,
        line: startLine,
        col: startCol,
        length: raw.length + 1,
      });
    }
    this.advance(); // closing quote

    this.tokens.push({
      kind: TokenKind.Str,
      value: raw,
      span: { file: this.file, line: startLine, col: startCol, length: raw.length + 2 },
      literal: cooked,
    });
  }

  private scanIdent(): void {
    const startLine = this.line;
    const startCol = this.col;
    let text = "";
    while (!this.eof() && this.isIdentPart(this.peek())) text += this.advance();

    const span: Span = { file: this.file, line: startLine, col: startCol, length: text.length };

    if (text === "true" || text === "false") {
      this.tokens.push({ kind: TokenKind.Bool, value: text, span, literal: text === "true" });
      return;
    }
    if (KEYWORDS.has(text)) {
      this.tokens.push({ kind: TokenKind.Keyword, value: text, span });
      return;
    }
    this.tokens.push({ kind: TokenKind.Ident, value: text, span });
  }

  private scanOperator(): void {
    const startLine = this.line;
    const startCol = this.col;

    const three: Array<[string, TokenKind]> = [["..=", TokenKind.DotDotEq]];
    const two: Array<[string, TokenKind]> = [
      ["->", TokenKind.Arrow],
      ["=>", TokenKind.FatArrow],
      ["|>", TokenKind.Pipeline],
      ["==", TokenKind.Eq],
      ["!=", TokenKind.Ne],
      ["<=", TokenKind.Le],
      [">=", TokenKind.Ge],
      ["+=", TokenKind.PlusAssign],
      ["-=", TokenKind.MinusAssign],
      ["*=", TokenKind.StarAssign],
      ["/=", TokenKind.SlashAssign],
      ["..", TokenKind.DotDot],
    ];
    const one: Record<string, TokenKind> = {
      "(": TokenKind.LParen,
      ")": TokenKind.RParen,
      "{": TokenKind.LBrace,
      "}": TokenKind.RBrace,
      "[": TokenKind.LBracket,
      "]": TokenKind.RBracket,
      ",": TokenKind.Comma,
      ".": TokenKind.Dot,
      ":": TokenKind.Colon,
      ";": TokenKind.Semicolon,
      "!": TokenKind.Bang,
      "?": TokenKind.Question,
      "=": TokenKind.Assign,
      "+": TokenKind.Plus,
      "-": TokenKind.Minus,
      "*": TokenKind.Star,
      "/": TokenKind.Slash,
      "%": TokenKind.Percent,
      "<": TokenKind.Lt,
      ">": TokenKind.Gt,
      "&": TokenKind.Amp,
      "|": TokenKind.Pipe,
      "@": TokenKind.At,
      "#": TokenKind.Hash,
    };

    for (const [text, kind] of three) {
      if (this.matchText(text)) {
        this.push(kind, text, { file: this.file, line: startLine, col: startCol, length: 3 });
        return;
      }
    }
    for (const [text, kind] of two) {
      if (this.matchText(text)) {
        this.push(kind, text, { file: this.file, line: startLine, col: startCol, length: 2 });
        return;
      }
    }

    const ch = this.peek();
    const kind = one[ch];
    if (kind === undefined) {
      throw lexError(`unexpected character \`${ch}\``, {
        file: this.file,
        line: startLine,
        col: startCol,
        length: 1,
      });
    }
    this.advance();

    // Track grouping nesting so layout is suppressed inside `(...)` and `[...]`.
    // Braces are NOT grouping: `{ ... }` is a block, and statements inside it
    // still terminate at newlines, so layout tokens must keep flowing.
    if (ch === "(" || ch === "[") this.brackets.push(ch);
    if (ch === ")" || ch === "]") this.brackets.pop();

    this.push(kind, ch, { file: this.file, line: startLine, col: startCol, length: 1 });
  }

  // ---------------------------------------------------------------- helpers

  private matchText(text: string): boolean {
    if (this.src.startsWith(text, this.pos)) {
      for (let i = 0; i < text.length; i++) this.advance();
      return true;
    }
    return false;
  }

  private push(kind: TokenKind, value: string, span: Span): void {
    this.tokens.push({ kind, value, span });
  }

  private span(length: number): Span {
    return { file: this.file, line: this.line, col: this.col, length };
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private peek(): string {
    return this.src[this.pos] ?? "\0";
  }

  private peekAt(n: number): string {
    return this.src[this.pos + n] ?? "\0";
  }

  private advance(): string {
    const ch = this.src[this.pos] ?? "\0";
    this.pos += 1;
    this.col += 1;
    return ch;
  }

  private isDigit(c: string): boolean {
    return c >= "0" && c <= "9";
  }

  private isIdentStart(c: string): boolean {
    return /[A-Za-z_]/.test(c);
  }

  private isIdentPart(c: string): boolean {
    return /[A-Za-z0-9_]/.test(c);
  }
}

export function tokenize(src: string, file?: string): Token[] {
  return new Lexer(src, file).tokenize();
}
