/**
 * Sunra diagnostics.
 *
 * Every error produced by the toolchain carries a stable code, a category, a
 * source span and (where possible) a hint. This mirrors the whitepaper's
 * requirement that diagnostics be machine-readable and repairable.
 */

export interface Span {
  file: string;
  line: number;
  col: number;
  length: number;
}

export type Severity = "error" | "warning" | "note";

export class SunraError extends Error {
  readonly code: string;
  readonly category: string;
  readonly span: Span | null;
  readonly hint: string | null;
  readonly severity: Severity;

  constructor(opts: {
    code: string;
    category: string;
    message: string;
    span?: Span | null;
    hint?: string | null;
    severity?: Severity;
  }) {
    super(opts.message);
    this.name = "SunraError";
    this.code = opts.code;
    this.category = opts.category;
    this.span = opts.span ?? null;
    this.hint = opts.hint ?? null;
    this.severity = opts.severity ?? "error";
  }

  toJSON() {
    return {
      code: this.code,
      severity: this.severity,
      category: this.category,
      message: this.message,
      span: this.span,
      hint: this.hint,
      docs: `https://sunra.dev/errors/${this.code}`,
    };
  }
}

export function lexError(message: string, span: Span, hint?: string): SunraError {
  return new SunraError({ code: "E0101", category: "syntax.lex", message, span, hint });
}

export function parseError(message: string, span: Span, hint?: string): SunraError {
  return new SunraError({ code: "E0201", category: "syntax.parse", message, span, hint });
}

export function typeError(
  code: string,
  category: string,
  message: string,
  span: Span | null,
  hint?: string,
): SunraError {
  return new SunraError({ code, category, message, span, hint });
}

export function runtimeError(message: string, span: Span | null, hint?: string): SunraError {
  return new SunraError({ code: "E0900", category: "runtime", message, span, hint });
}

/**
 * A diagnostic from a verification stage (refinement, panic-freedom,
 * determinism, compliance).
 *
 * These stages used to report only into their own result objects, which meant a
 * proven violation never reached `sunra check` and the language's safety claims
 * were unenforced in practice. Routing them through the same diagnostic type is
 * what makes them fail a build.
 */
export function verifyError(
  code: string,
  category: string,
  message: string,
  span: Span | null,
  hint?: string,
  severity: Severity = "error",
): SunraError {
  return new SunraError({ code, category, message, span, hint, severity });
}

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * Render a diagnostic in the rustc-inspired style described in the whitepaper,
 * with a caret pointing at the offending span and an optional hint.
 */
export function renderDiagnostic(err: SunraError, source?: string): string {
  const colour = err.severity === "error" ? RED : err.severity === "warning" ? YELLOW : CYAN;
  const label = err.severity;
  const out: string[] = [];

  out.push(`${colour}${BOLD}${label}[${err.code}]${RESET}${BOLD}: ${err.message}${RESET}`);

  if (err.span) {
    const { file, line, col, length } = err.span;
    out.push(`  ${DIM}-->${RESET} ${file}:${line}:${col}`);
    if (source) {
      const lines = source.split("\n");
      const text = lines[line - 1] ?? "";
      const gutter = String(line);
      const pad = " ".repeat(gutter.length);
      out.push(`${DIM}${pad} |${RESET}`);
      out.push(`${DIM}${gutter} |${RESET} ${text}`);
      const caretPad = " ".repeat(Math.max(0, col - 1));
      const carets = "^".repeat(Math.max(1, length));
      out.push(`${DIM}${pad} |${RESET} ${caretPad}${colour}${carets}${RESET}`);
    }
  }

  if (err.hint) {
    out.push(`  ${CYAN}help${RESET}: ${err.hint}`);
  }
  out.push(`  ${DIM}docs: https://sunra.dev/errors/${err.code}${RESET}`);
  return out.join("\n");
}
