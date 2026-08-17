import type { Span } from "../diagnostics.js";

export enum TokenKind {
  // literals
  Int = "Int",
  Float = "Float",
  Str = "Str",
  Bool = "Bool",

  // identifiers & keywords
  Ident = "Ident",
  Keyword = "Keyword",

  // punctuation / operators
  LParen = "(",
  RParen = ")",
  LBrace = "{",
  RBrace = "}",
  LBracket = "[",
  RBracket = "]",
  Comma = ",",
  Dot = ".",
  Colon = ":",
  Semicolon = ";",
  Arrow = "->",
  FatArrow = "=>",
  Pipeline = "|>",
  Bang = "!",
  Question = "?",
  Assign = "=",
  PlusAssign = "+=",
  MinusAssign = "-=",
  StarAssign = "*=",
  SlashAssign = "/=",
  Plus = "+",
  Minus = "-",
  Star = "*",
  Slash = "/",
  Percent = "%",
  Eq = "==",
  Ne = "!=",
  Lt = "<",
  Le = "<=",
  Gt = ">",
  Ge = ">=",
  Amp = "&",
  Pipe = "|",
  DotDot = "..",
  DotDotEq = "..=",
  At = "@",
  Hash = "#",

  // structural
  Newline = "Newline",
  Indent = "Indent",
  Dedent = "Dedent",
  Eof = "Eof",
}

export const KEYWORDS = new Set([
  "fn",
  "let",
  "var",
  "const",
  "type",
  "struct",
  "enum",
  "trait",
  "impl",
  "game",
  "reel",
  "actor",
  "module",
  "use",
  "pub",
  "return",
  "if",
  "else",
  "elif",
  "match",
  "while",
  "for",
  "in",
  "break",
  "continue",
  "and",
  "or",
  "not",
  "true",
  "false",
  "uses",
  "where",
  "as",
  "intent",
  "test",
  "assert",
]);

export interface Token {
  kind: TokenKind;
  value: string;
  span: Span;
  /** parsed numeric/string/bool payload for literal tokens */
  literal?: number | string | boolean;
}

export function tokenDescription(tok: Token): string {
  switch (tok.kind) {
    case TokenKind.Eof:
      return "end of file";
    case TokenKind.Newline:
      return "end of line";
    case TokenKind.Indent:
      return "indent";
    case TokenKind.Dedent:
      return "dedent";
    case TokenKind.Ident:
      return `identifier \`${tok.value}\``;
    case TokenKind.Keyword:
      return `keyword \`${tok.value}\``;
    default:
      return `\`${tok.value}\``;
  }
}
