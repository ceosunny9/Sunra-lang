import { TokenKind, tokenDescription, type Token } from "../lexer/token.js";
import { tokenize } from "../lexer/lexer.js";
import { SunraError, parseError, type Span } from "../diagnostics.js";
import type {
  Attribute,
  BlockStmt,
  Expr,
  FnDecl,
  GameDecl,
  GameField,
  MatchArm,
  Param,
  Program,
  ReelDecl,
  Stmt,
  TypeNode,
} from "./ast.js";

/**
 * Recursive-descent parser with a Pratt expression parser.
 *
 * Blocks may be written either with braces `{ ... }` or with a colon followed by
 * an indented region, matching the whitepaper's "both forms accepted, layout is
 * canonical" rule.
 */
export interface ParseRecoveryResult {
  program: Program;
  errors: SunraError[];
}

export class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseProgram(): Program {
    const body: Stmt[] = [];
    const start = this.peek().span;
    this.skipNewlines();
    while (!this.check(TokenKind.Eof)) {
      body.push(this.parseStmt());
      this.skipNewlines();
    }
    return { kind: "Program", body, span: start };
  }

  /**
   * Parse as much as possible, collecting independent statement errors.
   *
   * Recovery is deliberately only exposed as a separate entry point: the
   * original `parse()` remains fail-fast for compiler phases that require a
   * complete AST. The editor and `sunra check` can use this method to report
   * several broken lines in one pass. Synchronization stops at a statement
   * boundary, a block boundary, or EOF; it never invents AST nodes.
   */
  parseProgramRecovering(): ParseRecoveryResult {
    const body: Stmt[] = [];
    const errors: SunraError[] = [];
    const start = this.peek().span;
    this.skipNewlines();

    while (!this.check(TokenKind.Eof)) {
      const before = this.pos;
      try {
        body.push(this.parseStmt());
      } catch (error) {
        if (!(error instanceof SunraError)) throw error;
        errors.push(error);
        this.synchronizeStatement();
      }
      // A malformed construct must always make progress, even if recovery was
      // already positioned on a boundary token.
      if (this.pos === before && !this.check(TokenKind.Eof)) this.advance();
      this.skipNewlines();
    }

    return { program: { kind: "Program", body, span: start }, errors };
  }

  private synchronizeStatement(): void {
    while (!this.check(TokenKind.Eof)) {
      if (this.check(TokenKind.Newline) || this.check(TokenKind.Dedent) || this.check(TokenKind.RBrace)) {
        this.advance();
        return;
      }
      this.advance();
    }
  }

  // ------------------------------------------------------------- statements

  private parseStmt(): Stmt {
    this.skipLayout();

    const attributes = [...this.parseAttributes(), ...this.parseAtAnnotations()];
    const intent = this.parseIntent();

    if (this.checkKeyword("module")) return this.parseModule();
    if (this.checkKeyword("use")) return this.parseUse();

    let isPublic = false;
    if (this.checkKeyword("pub")) {
      this.advance();
      isPublic = true;
    }

    if (this.checkKeyword("fn")) return this.parseFn(attributes, intent, isPublic);
    if (this.checkKeyword("game")) return this.parseGame(attributes);
    if (this.checkKeyword("type")) return this.parseTypeDecl();
    if (this.checkKeyword("test")) return this.parseTest();
    if (this.checkKeyword("let") || this.checkKeyword("var") || this.checkKeyword("const")) {
      return this.parseLet();
    }
    if (this.checkKeyword("return")) return this.parseReturn();
    if (this.checkKeyword("if")) return this.parseIfStmt();
    if (this.checkKeyword("while")) return this.parseWhile();
    if (this.checkKeyword("for")) return this.parseFor();
    if (this.checkKeyword("assert")) return this.parseAssert();
    if (this.checkKeyword("break")) {
      const span = this.advance().span;
      this.endStatement();
      return { kind: "BreakStmt", span };
    }
    if (this.checkKeyword("continue")) {
      const span = this.advance().span;
      this.endStatement();
      return { kind: "ContinueStmt", span };
    }
    if (this.check(TokenKind.LBrace)) return this.parseBlock();

    const span = this.peek().span;
    const expr = this.parseExpr();
    this.endStatement();
    return { kind: "ExprStmt", expr, span };
  }

  /** Parse the ergonomic annotation spelling: `@locale("th")`. */
  private parseAtAnnotations(): Attribute[] {
    const attrs: Attribute[] = [];
    while (this.match(TokenKind.At)) {
      const span = this.tokens[this.pos - 1].span;
      const name = this.expectIdentLike("annotation name").value;
      const args: Record<string, Expr> = {};
      if (this.match(TokenKind.LParen)) {
        let positional = 0;
        while (!this.check(TokenKind.RParen)) {
          if (!this.check(TokenKind.Ident) || !this.checkAt(1, TokenKind.Assign)) {
            args[String(positional)] = this.parseExpr();
            positional += 1;
          } else {
            const key = this.expectIdentLike("annotation argument name").value;
            this.expect(TokenKind.Assign, "`=` in annotation argument");
            args[key] = this.parseExpr();
          }
          if (!this.match(TokenKind.Comma)) break;
        }
        this.expect(TokenKind.RParen, "`)` closing annotation arguments");
      }
      this.skipNewlines();
      attrs.push({ name, args, span });
    }
    return attrs;
  }

  private parseAttributes(): Attribute[] {
    const attrs: Attribute[] = [];
    while (this.check(TokenKind.Hash) && this.checkAt(1, TokenKind.LBracket)) {
      const span = this.advance().span; // #
      this.expect(TokenKind.LBracket, "`[` after `#` in attribute");
      const name = this.expectIdentLike("attribute name").value;
      const args: Record<string, Expr> = {};
      if (this.match(TokenKind.LParen)) {
        let positional = 0;
        while (!this.check(TokenKind.RParen)) {
          // Positional arguments: `#[jurisdiction("MGA", "UKGC")]`. Requiring
          // `name = value` for every argument made the natural spelling a parse
          // error, so a bare expression is recorded under its index.
          if (!this.check(TokenKind.Ident) || !this.checkAt(1, TokenKind.Assign)) {
            args[String(positional)] = this.parseExpr();
            positional += 1;
            if (!this.match(TokenKind.Comma)) break;
            continue;
          }
          const key = this.expectIdentLike("attribute argument name").value;
          if (this.match(TokenKind.Assign)) {
            args[key] = this.parseExpr();
          } else {
            args[key] = { kind: "BoolLit", value: true, span };
          }
          if (!this.match(TokenKind.Comma)) break;
        }
        this.expect(TokenKind.RParen, "`)` closing attribute arguments");
      }
      this.expect(TokenKind.RBracket, "`]` closing attribute");
      this.skipNewlines();
      attrs.push({ name, args, span });
    }
    return attrs;
  }

  private parseIntent(): string | null {
    if (!this.checkKeyword("intent")) return null;
    this.advance();
    const tok = this.expect(TokenKind.Str, "a string after `intent`");
    this.skipNewlines();
    return String(tok.literal ?? tok.value);
  }

  private parseModule(): Stmt {
    const span = this.advance().span;
    const path = this.parseDottedPath();
    this.endStatement();
    return { kind: "ModuleStmt", path, span };
  }

  private parseUse(): Stmt {
    const span = this.advance().span;
    const path = this.parseDottedPath();
    // optional `.{a, b}` group — recorded as part of the path string
    if (this.check(TokenKind.LBrace)) {
      this.advance();
      const names: string[] = [];
      while (!this.check(TokenKind.RBrace)) {
        names.push(this.expectIdentLike("imported name").value);
        if (!this.match(TokenKind.Comma)) break;
      }
      this.expect(TokenKind.RBrace, "`}` closing import group");
      this.endStatement();
      return { kind: "UseStmt", path: `${path}.{${names.join(",")}}`, span };
    }
    this.endStatement();
    return { kind: "UseStmt", path, span };
  }

  private parseDottedPath(): string {
    let path = this.expectIdentLike("a module path").value;
    while (this.check(TokenKind.Dot) && this.checkAt(1, TokenKind.Ident)) {
      this.advance();
      path += "." + this.advance().value;
    }
    return path;
  }

  private parseFn(attributes: Attribute[], intent: string | null, isPublic: boolean): FnDecl {
    const span = this.advance().span; // fn
    const name = this.expectIdentLike("a function name").value;
    this.expect(TokenKind.LParen, "`(` after function name");

    const params: Param[] = [];
    while (!this.check(TokenKind.RParen)) {
      const pspan = this.peek().span;
      // allow `&mut self` / `self` receiver forms
      this.match(TokenKind.Amp);
      const pname = this.expectIdentLike("a parameter name").value;
      let annotation: TypeNode | null = null;
      // The parameter name is passed down so `x: Int where x > 0` binds its
      // predicate to `x`. Without a binder the refinement could only be written
      // in terms of `self`.
      if (this.match(TokenKind.Colon)) annotation = this.parseType(pname);
      params.push({ name: pname, annotation, span: pspan });
      if (!this.match(TokenKind.Comma)) break;
    }
    this.expect(TokenKind.RParen, "`)` closing parameter list");

    let returnType: TypeNode | null = null;
    if (this.match(TokenKind.Arrow)) returnType = this.parseType();

    const effects: string[] = [];
    if (this.checkKeyword("uses")) {
      this.advance();
      do {
        effects.push(this.expectIdentLike("an effect name").value);
      } while (this.match(TokenKind.Comma));
    }

    const body = this.parseBlockOrIndented();
    return {
      kind: "FnDecl",
      name,
      params,
      returnType,
      effects,
      body,
      attributes,
      intent,
      isPublic,
      span,
    };
  }

  private parseGame(attributes: Attribute[]): GameDecl {
    const span = this.advance().span; // game
    const name = this.expectIdentLike("a game name").value;

    const braced = this.check(TokenKind.LBrace);
    if (braced) {
      this.advance();
    } else {
      this.expect(TokenKind.Colon, "`{` or `:` to open the game body");
      this.skipNewlines();
      this.expect(TokenKind.Indent, "an indented game body");
    }

    const fields: GameField[] = [];
    const reels: ReelDecl[] = [];
    const functions: FnDecl[] = [];

    const atEnd = () => (braced ? this.check(TokenKind.RBrace) : this.check(TokenKind.Dedent));
    const skipGap = () => (braced ? this.skipLayout() : this.skipNewlines());

    skipGap();
    while (!atEnd() && !this.check(TokenKind.Eof)) {
      const memberAttrs = this.parseAttributes();
      const memberIntent = this.parseIntent();

      if (this.checkKeyword("pub")) {
        this.advance();
        functions.push(this.parseFn(memberAttrs, memberIntent, true));
      } else if (this.checkKeyword("fn")) {
        functions.push(this.parseFn(memberAttrs, memberIntent, false));
      } else if (this.checkKeyword("reel") || this.checkIdent("reels")) {
        reels.push(this.parseReel());
      } else {
        // plain declarative field: `rtp = 96.5`  or  `rtp: 96.5`
        const fspan = this.peek().span;
        const fname = this.expectIdentLike("a game field name").value;
        if (!this.match(TokenKind.Assign)) {
          this.expect(TokenKind.Colon, "`=` or `:` after a game field name");
        }
        const value = this.parseExpr();
        fields.push({ name: fname, value, span: fspan });
        this.endStatement();
      }
      skipGap();
    }

    if (braced) this.expect(TokenKind.RBrace, "`}` closing the game body");
    else this.expect(TokenKind.Dedent, "the end of the indented game body");

    return { kind: "GameDecl", name, fields, reels, functions, attributes, span };
  }

  private parseReel(): ReelDecl {
    const span = this.advance().span; // reel / reels
    const name = this.expectIdentLike("a reel name").value;
    if (!this.match(TokenKind.Assign)) {
      this.expect(TokenKind.Colon, "`=` or `:` after a reel name");
    }
    const symbols = this.parseExpr();
    let weights: Expr | null = null;
    if (this.checkIdent("weights")) {
      this.advance();
      this.match(TokenKind.Assign);
      weights = this.parseExpr();
    }
    this.endStatement();
    return { name, symbols, weights, span };
  }

  private parseTypeDecl(): Stmt {
    const span = this.advance().span; // type
    const name = this.expectIdentLike("a type name").value;
    this.expect(TokenKind.Assign, "`=` in a type declaration");
    const variants: string[] = [];

    if (this.checkKeyword("enum")) {
      this.advance();
      if (this.match(TokenKind.Colon)) {
        this.skipNewlines();
        this.expect(TokenKind.Indent, "an indented list of variants");
        this.skipNewlines();
        while (!this.check(TokenKind.Dedent) && !this.check(TokenKind.Eof)) {
          variants.push(this.expectIdentLike("a variant name").value);
          // skip an optional payload declaration
          if (this.match(TokenKind.LParen)) {
            let depth = 1;
            while (depth > 0 && !this.check(TokenKind.Eof)) {
              if (this.check(TokenKind.LParen)) depth++;
              if (this.check(TokenKind.RParen)) depth--;
              this.advance();
            }
          }
          this.skipNewlines();
        }
        this.expect(TokenKind.Dedent, "the end of the variant list");
      } else if (this.match(TokenKind.LBracket)) {
        while (!this.check(TokenKind.RBracket)) {
          variants.push(this.expectIdentLike("a variant name").value);
          if (!this.match(TokenKind.Comma)) break;
        }
        this.expect(TokenKind.RBracket, "`]` closing the variant list");
      }
    } else {
      // alias: `type Rtp = Float` — consume the aliased type
      this.parseType();
      if (this.checkKeyword("where")) {
        this.advance();
        this.parseExpr();
      }
    }
    this.endStatement();
    return { kind: "TypeDecl", name, variants, span };
  }

  /**
   * `assert <expr>` and `assert <expr>, "message"` are statement forms so that
   * test bodies read like specifications rather than function calls.
   */
  private parseAssert(): Stmt {
    const span = this.advance().span;
    const cond = this.parseExpr();
    const args: Expr[] = [cond];
    if (this.match(TokenKind.Comma)) {
      args.push(this.parseExpr());
    }
    this.endStatement();
    const callee: Expr = { kind: "Ident", name: "assert", span };
    return { kind: "ExprStmt", expr: { kind: "Call", callee, args, span }, span };
  }

  private parseTest(): Stmt {
    const span = this.advance().span; // test
    const tok = this.check(TokenKind.Str)
      ? this.advance()
      : this.expectIdentLike("a test name");
    const name = String(tok.literal ?? tok.value);
    const body = this.parseBlockOrIndented();
    return { kind: "TestDecl", name, body, span };
  }

  private parseLet(): Stmt {
    const kw = this.advance();
    const mutable = kw.value === "var";
    const name = this.expectIdentLike("a variable name").value;
    let annotation: TypeNode | null = null;
    if (this.match(TokenKind.Colon)) annotation = this.parseType();
    this.expect(TokenKind.Assign, "`=` in a variable declaration");
    const value = this.parseExpr();
    this.endStatement();
    return { kind: "LetStmt", name, mutable, annotation, value, span: kw.span };
  }

  private parseReturn(): Stmt {
    const span = this.advance().span;
    let value: Expr | null = null;
    if (
      !this.check(TokenKind.Newline) &&
      !this.check(TokenKind.Semicolon) &&
      !this.check(TokenKind.RBrace) &&
      !this.check(TokenKind.Dedent) &&
      !this.check(TokenKind.Eof)
    ) {
      value = this.parseExpr();
    }
    this.endStatement();
    return { kind: "ReturnStmt", value, span };
  }

  private parseIfStmt(): Stmt {
    const span = this.advance().span; // if
    const cond = this.parseExpr();
    const then = this.parseBlockOrIndented();
    let otherwise: BlockStmt | Stmt | null = null;
    this.skipNewlinesBeforeElse();
    if (this.checkKeyword("elif")) {
      otherwise = this.parseIfStmt();
    } else if (this.checkKeyword("else")) {
      this.advance();
      if (this.checkKeyword("if")) {
        otherwise = this.parseIfStmt();
      } else {
        otherwise = this.parseBlockOrIndented();
      }
    }
    return { kind: "IfStmt", cond, then, otherwise: otherwise as BlockStmt | null, span };
  }

  private parseWhile(): Stmt {
    const span = this.advance().span;
    const cond = this.parseExpr();
    const body = this.parseBlockOrIndented();
    return { kind: "WhileStmt", cond, body, span };
  }

  private parseFor(): Stmt {
    const span = this.advance().span;
    const binding = this.expectIdentLike("a loop variable").value;
    if (!this.checkKeyword("in")) {
      throw parseError("expected `in` after the loop variable", this.peek().span);
    }
    this.advance();
    const iterable = this.parseExpr();
    const body = this.parseBlockOrIndented();
    return { kind: "ForStmt", binding, iterable, body, span };
  }

  /** Accepts either `{ ... }` or `: <newline> <indent> ... <dedent>`. */
  private parseBlockOrIndented(): BlockStmt {
    if (this.check(TokenKind.LBrace)) return this.parseBlock();

    this.expect(TokenKind.Colon, "`{` or `:` to open a block");
    const span = this.peek().span;

    // single-line body: `if x: return 1`
    if (!this.check(TokenKind.Newline)) {
      const stmt = this.parseStmt();
      return { kind: "BlockStmt", body: [stmt], span };
    }

    this.skipNewlines();
    this.expect(TokenKind.Indent, "an indented block");
    const body: Stmt[] = [];
    this.skipNewlines();
    while (!this.check(TokenKind.Dedent) && !this.check(TokenKind.Eof)) {
      body.push(this.parseStmt());
      this.skipNewlines();
    }
    this.expect(TokenKind.Dedent, "the end of the indented block");
    return { kind: "BlockStmt", body, span };
  }

  private parseBlock(): BlockStmt {
    const span = this.expect(TokenKind.LBrace, "`{` to open a block").span;
    const body: Stmt[] = [];
    // Inside a brace block, layout tokens carry no meaning: the braces already
    // delimit the region. Skip them so both styles can be freely mixed.
    this.skipLayout();
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      body.push(this.parseStmt());
      this.skipLayout();
    }
    this.expect(TokenKind.RBrace, "`}` closing the block");
    return { kind: "BlockStmt", body, span };
  }

  /** Skip newline, indent and dedent tokens (used inside brace-delimited blocks). */
  private skipLayout(): void {
    while (
      this.check(TokenKind.Newline) ||
      this.check(TokenKind.Indent) ||
      this.check(TokenKind.Dedent)
    ) {
      this.advance();
    }
  }

  // ------------------------------------------------------------- types

  /**
   * Parse a type, recording which name a `where` refinement binds.
   *
   * `binder` is the parameter name when the type annotates a parameter, so
   * `x: Int where x > 0` reads naturally; predicates written against `self`
   * continue to work in every position.
   */
  private parseType(binder: string | null = null): TypeNode {
    const tok = this.peek();

    if (this.check(TokenKind.LBracket)) {
      // list type: [Int]
      const span = this.advance().span;
      const inner = this.parseType();
      this.expect(TokenKind.RBracket, "`]` closing a list type");
      return { kind: "TypeRef", name: "List", args: [inner], span };
    }
    if (this.check(TokenKind.LParen)) {
      // unit type: ()
      const span = this.advance().span;
      this.expect(TokenKind.RParen, "`)` closing the unit type");
      return { kind: "TypeRef", name: "Unit", args: [], span };
    }

    const name = this.expectIdentLike("a type name").value;
    const args: TypeNode[] = [];
    if (this.check(TokenKind.LBracket)) {
      this.advance();
      while (!this.check(TokenKind.RBracket)) {
        args.push(this.parseType());
        if (!this.match(TokenKind.Comma)) break;
      }
      this.expect(TokenKind.RBracket, "`]` closing type arguments");
    }
    // qualified type names, e.g. `game.Result`
    let full = name;
    while (this.check(TokenKind.Dot) && this.checkAt(1, TokenKind.Ident)) {
      this.advance();
      full += "." + this.advance().value;
    }
    // refinement suffix: `Float where 0.0 <= self <= 1.0`
    if (this.checkKeyword("where")) {
      this.advance();
      // Keep the predicate. Discarding it is what made refinement types
      // decorative: the annotation parsed and nothing ever checked it.
      const refinement = this.parseExpr();
      return {
        kind: "TypeRef",
        name: full,
        args,
        refinement,
        refinementBinder: binder ?? "self",
        span: tok.span,
      };
    }
    return { kind: "TypeRef", name: full, args, span: tok.span };
  }

  // ------------------------------------------------------------- expressions

  parseExpr(): Expr {
    return this.parseAssignment();
  }

  private parseAssignment(): Expr {
    const left = this.parsePipeline();
    const assignOps: TokenKind[] = [
      TokenKind.Assign,
      TokenKind.PlusAssign,
      TokenKind.MinusAssign,
      TokenKind.StarAssign,
      TokenKind.SlashAssign,
    ];
    for (const op of assignOps) {
      if (this.check(op)) {
        const tok = this.advance();
        const value = this.parseAssignment();
        return { kind: "Assign", target: left, op: tok.value, value, span: tok.span };
      }
    }
    return left;
  }

  private parsePipeline(): Expr {
    let left = this.parseRange();
    while (this.check(TokenKind.Pipeline)) {
      const tok = this.advance();
      const stage = this.parseRange();
      left = { kind: "Pipeline", value: left, stage, span: tok.span };
    }
    return left;
  }

  private parseRange(): Expr {
    const left = this.parseOr();
    if (this.check(TokenKind.DotDot) || this.check(TokenKind.DotDotEq)) {
      const tok = this.advance();
      const right = this.parseOr();
      return {
        kind: "RangeExpr",
        from: left,
        to: right,
        inclusive: tok.kind === TokenKind.DotDotEq,
        span: tok.span,
      };
    }
    return left;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.checkKeyword("or")) {
      const tok = this.advance();
      const right = this.parseAnd();
      left = { kind: "Binary", op: "or", left, right, span: tok.span };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.checkKeyword("and")) {
      const tok = this.advance();
      const right = this.parseComparison();
      left = { kind: "Binary", op: "and", left, right, span: tok.span };
    }
    return left;
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    const ops: TokenKind[] = [
      TokenKind.Eq,
      TokenKind.Ne,
      TokenKind.Lt,
      TokenKind.Le,
      TokenKind.Gt,
      TokenKind.Ge,
    ];
    while (ops.some((o) => this.check(o))) {
      const tok = this.advance();
      const right = this.parseAdditive();
      left = { kind: "Binary", op: tok.value, left, right, span: tok.span };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.check(TokenKind.Plus) || this.check(TokenKind.Minus)) {
      const tok = this.advance();
      const right = this.parseMultiplicative();
      left = { kind: "Binary", op: tok.value, left, right, span: tok.span };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.check(TokenKind.Star) || this.check(TokenKind.Slash) || this.check(TokenKind.Percent)) {
      const tok = this.advance();
      const right = this.parseUnary();
      left = { kind: "Binary", op: tok.value, left, right, span: tok.span };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.check(TokenKind.Minus) || this.checkKeyword("not") || this.check(TokenKind.Bang)) {
      const tok = this.advance();
      const operand = this.parseUnary();
      const op = tok.kind === TokenKind.Bang ? "not" : tok.value;
      return { kind: "Unary", op, operand, span: tok.span };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();

    for (;;) {
      // member access; the property may be a keyword (`Fair.use`, `x.type`)
      if (
        this.check(TokenKind.Dot) &&
        (this.checkAt(1, TokenKind.Ident) || this.checkAt(1, TokenKind.Keyword))
      ) {
        this.advance();
        const prop = this.advance();
        expr = { kind: "Member", object: expr, property: prop.value, span: prop.span };
        continue;
      }
      if (this.check(TokenKind.LParen)) {
        const tok = this.advance();
        const args: Expr[] = [];
        while (!this.check(TokenKind.RParen)) {
          // allow (and discard) named-argument syntax `name = value`
          if (this.check(TokenKind.Ident) && this.checkAt(1, TokenKind.Assign)) {
            this.advance();
            this.advance();
          }
          args.push(this.parseExpr());
          if (!this.match(TokenKind.Comma)) break;
        }
        this.expect(TokenKind.RParen, "`)` closing the argument list");
        expr = { kind: "Call", callee: expr, args, span: tok.span };
        continue;
      }
      if (this.check(TokenKind.LBracket)) {
        const tok = this.advance();
        const index = this.parseExpr();
        this.expect(TokenKind.RBracket, "`]` closing an index expression");
        expr = { kind: "Index", object: expr, index, span: tok.span };
        continue;
      }
      // error-propagation operator `expr!` — in the prototype this is a no-op
      // marker that keeps whitepaper-style source parseable.
      if (this.check(TokenKind.Bang) && !this.checkAt(1, TokenKind.Assign)) {
        this.advance();
        continue;
      }
      break;
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const tok = this.peek();

    switch (tok.kind) {
      case TokenKind.Int:
        this.advance();
        return { kind: "IntLit", value: Number(tok.literal), span: tok.span };
      case TokenKind.Float:
        this.advance();
        return { kind: "FloatLit", value: Number(tok.literal), span: tok.span };
      case TokenKind.Str:
        this.advance();
        return this.makeStringExpr(String(tok.literal ?? tok.value), tok.span);
      case TokenKind.Bool:
        this.advance();
        return { kind: "BoolLit", value: Boolean(tok.literal), span: tok.span };
      case TokenKind.Ident:
        this.advance();
        return { kind: "Ident", name: tok.value, span: tok.span };
      case TokenKind.LParen: {
        this.advance();
        const inner = this.parseExpr();
        this.expect(TokenKind.RParen, "`)` closing a grouped expression");
        return inner;
      }
      case TokenKind.LBracket: {
        this.advance();
        const elements: Expr[] = [];
        this.skipNewlines();
        while (!this.check(TokenKind.RBracket)) {
          elements.push(this.parseExpr());
          this.skipNewlines();
          if (!this.match(TokenKind.Comma)) break;
          this.skipNewlines();
        }
        this.expect(TokenKind.RBracket, "`]` closing a list literal");
        return { kind: "ArrayLit", elements, span: tok.span };
      }
      case TokenKind.Pipe: {
        // closure: |a, b| expr
        this.advance();
        const params: Param[] = [];
        while (!this.check(TokenKind.Pipe)) {
          const pspan = this.peek().span;
          const name = this.expectIdentLike("a closure parameter").value;
          let annotation: TypeNode | null = null;
          if (this.match(TokenKind.Colon)) annotation = this.parseType();
          params.push({ name, annotation, span: pspan });
          if (!this.match(TokenKind.Comma)) break;
        }
        this.expect(TokenKind.Pipe, "`|` closing the closure parameters");
        const body = this.parseExpr();
        return { kind: "Lambda", params, body, span: tok.span };
      }
      case TokenKind.Keyword:
        if (tok.value === "if") return this.parseIfExpr();
        if (tok.value === "match") return this.parseMatchExpr();
        if (tok.value === "not") {
          this.advance();
          const operand = this.parseUnary();
          return { kind: "Unary", op: "not", operand, span: tok.span };
        }
        break;
      default:
        break;
    }

    throw parseError(
      `expected an expression but found ${tokenDescription(tok)}`,
      tok.span,
      "expressions include literals, identifiers, calls, `if`, `match`, lists and closures",
    );
  }

  private parseIfExpr(): Expr {
    const span = this.advance().span; // if
    const cond = this.parseExpr();
    this.expect(TokenKind.Colon, "`:` after an `if` expression condition");
    const then = this.parseExpr();
    let otherwise: Expr | null = null;
    if (this.checkKeyword("else")) {
      this.advance();
      this.match(TokenKind.Colon);
      otherwise = this.parseExpr();
    }
    return { kind: "IfExpr", cond, then, otherwise, span };
  }

  private parseMatchExpr(): Expr {
    const span = this.advance().span; // match
    const subject = this.parseExpr();

    // `match x { ... }` (brace form) or `match x:` with an indented region
    // (layout form). Both are accepted; layout is canonical.
    const braced = this.check(TokenKind.LBrace);
    let indented = false;
    if (braced) {
      this.advance();
      this.skipLayout();
    } else {
      this.expect(TokenKind.Colon, "`{` or `:` after the match subject");
      this.skipNewlines();
      indented = this.check(TokenKind.Indent);
      if (indented) this.advance();
      this.skipNewlines();
    }

    const arms: MatchArm[] = [];
    const atEnd = (): boolean => {
      if (this.check(TokenKind.Eof)) return true;
      if (braced) return this.check(TokenKind.RBrace);
      if (indented) return this.check(TokenKind.Dedent);
      return this.check(TokenKind.Newline);
    };

    for (;;) {
      if (atEnd()) break;

      const armSpan = this.peek().span;
      let pattern: Expr | null = null;
      if (this.check(TokenKind.Ident) && this.peek().value === "_") {
        this.advance();
      } else {
        pattern = this.parseOr();
      }
      let guard: Expr | null = null;
      if (this.checkKeyword("if")) {
        this.advance();
        guard = this.parseExpr();
      }
      this.expect(TokenKind.Arrow, "`->` between a match pattern and its body");
      const body = this.parseExpr();
      arms.push({ pattern, guard, body, span: armSpan });

      this.match(TokenKind.Comma);
      this.match(TokenKind.Semicolon);
      if (braced) this.skipLayout();
      else this.skipNewlines();
      if (!braced && !indented) break;
    }

    if (braced) this.expect(TokenKind.RBrace, "`}` closing the match arms");
    else if (indented) this.expect(TokenKind.Dedent, "the end of the match arms");

    if (arms.length === 0) {
      throw parseError("a `match` expression must have at least one arm", span);
    }

    return { kind: "MatchExpr", subject, arms, span };
  }

  /** Parse `{expr}` interpolation holes inside a string literal. */
  private makeStringExpr(raw: string, span: Span): Expr {
    if (!raw.includes("{")) {
      return { kind: "StrLit", value: raw.replace(/\\\{/g, "{"), span };
    }
    const parts: Array<{ text: string } | { expr: Expr; format: string | null }> = [];
    let buf = "";
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === "\\" && raw[i + 1] === "{") {
        buf += "{";
        i += 2;
        continue;
      }
      if (c === "{") {
        const end = raw.indexOf("}", i);
        if (end === -1) {
          buf += c;
          i += 1;
          continue;
        }
        if (buf) {
          parts.push({ text: buf });
          buf = "";
        }
        const inner = raw.slice(i + 1, end);
        const [exprSrc, format] = this.splitFormat(inner);
        parts.push({ expr: parseExpressionFragment(exprSrc, span), format });
        i = end + 1;
        continue;
      }
      buf += c;
      i += 1;
    }
    if (buf) parts.push({ text: buf });
    return { kind: "Interp", parts, span };
  }

  private splitFormat(inner: string): [string, string | null] {
    const idx = inner.lastIndexOf(":");
    if (idx > 0 && /^[.\d<>^+#a-zA-Z]*$/.test(inner.slice(idx + 1))) {
      return [inner.slice(0, idx), inner.slice(idx + 1)];
    }
    return [inner, null];
  }

  // ------------------------------------------------------------- helpers

  private endStatement(): void {
    if (this.match(TokenKind.Semicolon)) {
      this.skipNewlines();
      return;
    }
    if (this.check(TokenKind.Newline)) {
      this.advance();
      return;
    }
    if (
      this.check(TokenKind.Dedent) ||
      this.check(TokenKind.Indent) ||
      this.check(TokenKind.RBrace) ||
      this.check(TokenKind.Eof)
    ) {
      return;
    }
    throw parseError(
      `expected the end of a statement but found ${tokenDescription(this.peek())}`,
      this.peek().span,
      "statements end at a newline; Sunra does not require semicolons",
    );
  }

  private skipNewlines(): void {
    while (this.check(TokenKind.Newline)) this.advance();
  }

  /** Look past newlines/dedents for `else`/`elif` so layout-style if/else works. */
  private skipNewlinesBeforeElse(): void {
    let i = this.pos;
    while (
      i < this.tokens.length &&
      (this.tokens[i].kind === TokenKind.Newline || this.tokens[i].kind === TokenKind.Dedent)
    ) {
      i += 1;
    }
    const tok = this.tokens[i];
    if (tok && tok.kind === TokenKind.Keyword && (tok.value === "else" || tok.value === "elif")) {
      this.pos = i;
    }
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    const tok = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return tok;
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private checkAt(offset: number, kind: TokenKind): boolean {
    return (this.tokens[this.pos + offset]?.kind ?? TokenKind.Eof) === kind;
  }

  private checkKeyword(word: string): boolean {
    const tok = this.peek();
    return tok.kind === TokenKind.Keyword && tok.value === word;
  }

  private checkIdent(word: string): boolean {
    const tok = this.peek();
    return tok.kind === TokenKind.Ident && tok.value === word;
  }

  private match(kind: TokenKind): boolean {
    if (this.check(kind)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(kind: TokenKind, what: string): Token {
    if (this.check(kind)) return this.advance();
    throw parseError(
      `expected ${what} but found ${tokenDescription(this.peek())}`,
      this.peek().span,
    );
  }

  /** Accept an identifier, or a keyword used in an identifier position. */
  private expectIdentLike(what: string): Token {
    const tok = this.peek();
    if (tok.kind === TokenKind.Ident || tok.kind === TokenKind.Keyword) return this.advance();
    throw parseError(`expected ${what} but found ${tokenDescription(tok)}`, tok.span);
  }
}

/** Parse a standalone expression (used for string interpolation holes). */
export function parseExpressionFragment(src: string, span: Span): Expr {
  const tokens = tokenize(src, span.file);
  const parser = new Parser(tokens);
  return parser.parseExpr();
}

export function parse(tokens: Token[]): Program {
  return new Parser(tokens).parseProgram();
}

export function parseRecovering(tokens: Token[]): ParseRecoveryResult {
  return new Parser(tokens).parseProgramRecovering();
}
