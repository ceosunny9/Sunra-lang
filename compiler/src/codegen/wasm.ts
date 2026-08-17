/**
 * Sunra to WebAssembly code generator.
 *
 * Design decisions, stated plainly because a WASM backend invites overclaiming:
 *
 *  1. This emitter writes a real WebAssembly binary by hand — no external
 *     toolchain, no Binaryen, no wat2wasm. Every byte in the output is produced
 *     by `encodeModule` below, so the artifact is inspectable and reproducible.
 *
 *  2. It compiles the *numeric core* of Sunra: functions whose parameters and
 *     results are numbers or booleans, containing arithmetic, comparisons,
 *     `if`/`else`, `while`, `let`/`var`, assignment, `return`, and calls to other
 *     compilable functions. That covers paytable mathematics, RTP kernels and
 *     hot loops — the code where native speed actually matters.
 *
 *  3. Anything outside that subset (strings, lists, reels, decks, money, effects,
 *     interpolation, match, closures) is *not* silently mistranslated. Such
 *     functions are reported as skipped, and the JavaScript loader keeps a JS
 *     implementation available for them. A hybrid module is honest; a broken
 *     WASM module that pretends to handle strings is not.
 *
 * All numbers are f64, which matches Sunra's `Float` exactly and represents
 * `Int` faithfully up to 2^53. Integer-only operations (`%`, `//`, bitwise-free
 * arithmetic) are emitted with f64 semantics plus explicit truncation so that
 * results agree with the interpreter.
 */

import type {
  BlockStmt,
  Expr,
  FnDecl,
  GameDecl,
  Program,
  Stmt,
} from "../parser/ast.js";

// ---------------------------------------------------------------------------
// WebAssembly binary encoding primitives
// ---------------------------------------------------------------------------

/** Section identifiers from the WebAssembly core specification. */
const SECTION = {
  type: 1,
  import: 2,
  function: 3,
  memory: 5,
  export: 7,
  code: 10,
} as const;

/** Value type: every Sunra numeric value is an IEEE-754 double. */
const F64 = 0x7c;

/** Opcodes used by this backend, grouped by role. */
const OP = {
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  brIf: 0x0d,
  return: 0x0f,
  call: 0x10,
  drop: 0x1a,
  localGet: 0x20,
  localSet: 0x21,
  localTee: 0x22,
  f64Const: 0x44,
  i32Eqz: 0x45,
  f64Eq: 0x61,
  f64Ne: 0x62,
  f64Lt: 0x63,
  f64Gt: 0x64,
  f64Le: 0x65,
  f64Ge: 0x66,
  f64Add: 0xa0,
  f64Sub: 0xa1,
  f64Mul: 0xa2,
  f64Div: 0xa3,
  f64Min: 0xa4,
  f64Max: 0xa5,
  f64Abs: 0x99,
  f64Neg: 0x9a,
  f64Ceil: 0x9b,
  f64Floor: 0x9c,
  f64Trunc: 0x9d,
  f64Nearest: 0x9e,
  f64Sqrt: 0x9f,
  f64ConvertI32S: 0xb7,
  i32TruncF64S: 0xaa,
} as const;

/** LEB128 unsigned encoding, the pervasive integer format in a WASM binary. */
function uleb(value: number): number[] {
  const bytes: number[] = [];
  let n = value >>> 0;
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return bytes;
}

/** LEB128 signed encoding, used for constants and block types. */
function sleb(value: number): number[] {
  const bytes: number[] = [];
  let more = true;
  let n = value | 0;
  while (more) {
    let byte = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    bytes.push(byte);
  }
  return bytes;
}

/** IEEE-754 little-endian encoding of a double, as WASM `f64.const` requires. */
function f64Bytes(value: number): number[] {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, true);
  return Array.from(new Uint8Array(buffer));
}

function encodeName(name: string): number[] {
  const bytes = Array.from(Buffer.from(name, "utf8"));
  return [...uleb(bytes.length), ...bytes];
}

function encodeVector(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function encodeSection(id: number, payload: number[]): number[] {
  if (payload.length === 0) return [];
  return [id, ...uleb(payload.length), ...payload];
}

// ---------------------------------------------------------------------------
// Compilation model
// ---------------------------------------------------------------------------

/** A function signature: n f64 parameters, one f64 result. */
interface FuncType {
  params: number;
  results: number;
}

interface CompiledFunction {
  name: string;
  /** Exported name in the WASM module. */
  exportName: string;
  arity: number;
  typeIndex: number;
  /** Total locals beyond parameters. */
  extraLocals: number;
  body: number[];
}

export interface SkippedFunction {
  name: string;
  reason: string;
}

export interface WasmEmitResult {
  /** The complete WebAssembly binary. */
  bytes: Uint8Array;
  /** Functions compiled to WASM, in module order. */
  compiled: string[];
  /** Functions that fall outside the numeric subset, with the reason. */
  skipped: SkippedFunction[];
  /** Imported host functions the module expects, as `env.<name>`. */
  hostImports: string[];
}

/** Raised internally when a construct is outside the compilable subset. */
class Unsupported extends Error {}

/**
 * Host functions the module imports from `env`. These exist so that maths the
 * WASM instruction set lacks (pow, log, trig) and deliberate host callbacks
 * (random draws) remain available without leaving the numeric subset.
 */
const HOST_FUNCTIONS: Record<string, number> = {
  pow: 2,
  log: 1,
  exp: 1,
  sin: 1,
  cos: 1,
  tan: 1,
  atan2: 2,
  random: 0,
};

/** Built-ins mapped to a single WASM instruction. */
const INTRINSIC_UNARY: Record<string, number> = {
  abs: OP.f64Abs,
  floor: OP.f64Floor,
  ceil: OP.f64Ceil,
  sqrt: OP.f64Sqrt,
  round: OP.f64Nearest,
  trunc: OP.f64Trunc,
};

const INTRINSIC_BINARY: Record<string, number> = {
  min: OP.f64Min,
  max: OP.f64Max,
};

export class WasmEmitter {
  private readonly types: FuncType[] = [];
  private readonly compiled: CompiledFunction[] = [];
  private readonly skipped: SkippedFunction[] = [];

  /** Host import order is fixed so function indices stay stable. */
  private readonly hostOrder: string[] = [];
  private readonly hostIndex = new Map<string, number>();

  /** Sunra function name to WASM function index (after imports). */
  private readonly funcIndex = new Map<string, number>();
  private readonly arity = new Map<string, number>();

  /** Locals of the function currently being compiled. */
  private locals: Map<string, number> = new Map();
  private localCount = 0;
  private paramCount = 0;

  /**
   * Depth of enclosing WASM control blocks, used to compute break targets for
   * `break`/`continue` inside `while`.
   */
  private loopStack: Array<{ blockDepth: number }> = [];
  private blockDepth = 0;

  emit(program: Program): WasmEmitResult {
    const candidates = this.collectCandidates(program);

    this.reserveHostImports();

    // Two passes. The first discovers which functions are compilable at all,
    // with provisional indices. The second assigns dense final indices to the
    // survivors and regenerates their bodies against those indices, so no call
    // can ever refer to a function that was dropped.
    //
    // Dropping a function can invalidate a caller, so the discovery pass repeats
    // until the survivor set stops shrinking. The set only ever gets smaller,
    // which makes termination obvious.
    let survivors = candidates.map((candidate) => candidate.exportName);
    const reasons = new Map<string, string>();

    for (;;) {
      this.assignIndices(candidates, survivors);
      const failed: string[] = [];

      for (const name of survivors) {
        const decl = this.declarations.get(name);
        if (!decl) continue;
        this.compiled.length = 0;
        try {
          this.compileFunction(name, decl);
        } catch (error) {
          if (error instanceof Unsupported) {
            failed.push(name);
            if (!reasons.has(name)) reasons.set(name, error.message);
            continue;
          }
          throw error;
        }
      }

      if (failed.length === 0) break;
      const dropped = new Set(failed);
      survivors = survivors.filter((name) => !dropped.has(name));
    }

    // Final pass: emit the surviving bodies in index order.
    this.assignIndices(candidates, survivors);
    this.compiled.length = 0;
    for (const name of survivors) {
      const decl = this.declarations.get(name);
      if (!decl) continue;
      this.compileFunction(name, decl);
    }

    for (const candidate of candidates) {
      if (!survivors.includes(candidate.exportName)) {
        this.skipped.push({
          name: candidate.exportName,
          reason: reasons.get(candidate.exportName) ?? "depends on a function outside the numeric subset",
        });
      }
    }

    return {
      bytes: this.encodeModule(),
      compiled: this.compiled.map((fn) => fn.exportName),
      skipped: this.skipped,
      hostImports: this.hostOrder.map((name) => `env.${name}`),
    };
  }

  /** Give every survivor a dense index after the host imports. */
  private assignIndices(
    candidates: Array<{ exportName: string; decl: FnDecl }>,
    survivors: string[],
  ): void {
    this.funcIndex.clear();
    this.arity.clear();
    let next = this.hostOrder.length;
    for (const name of survivors) {
      this.funcIndex.set(name, next++);
      const candidate = candidates.find((item) => item.exportName === name);
      if (candidate) this.arity.set(name, candidate.decl.params.length);
    }
  }

  // ----------------------------------------------------------------- discovery

  private collectCandidates(program: Program): Array<{ exportName: string; decl: FnDecl }> {
    const out: Array<{ exportName: string; decl: FnDecl }> = [];

    for (const stmt of program.body) {
      if (stmt.kind === "FnDecl") {
        out.push({ exportName: stmt.name, decl: stmt });
      } else if (stmt.kind === "GameDecl") {
        const game = stmt as GameDecl;
        for (const fn of game.functions) {
          // Game methods reach fields and reels through `self`, which the numeric
          // subset cannot represent. Only parameterised pure helpers qualify.
          out.push({ exportName: `${game.name}_${fn.name}`, decl: fn });
        }
      }
    }
    return out;
  }

  private reserveHostImports(): void {
    for (const name of Object.keys(HOST_FUNCTIONS)) {
      this.hostIndex.set(name, this.hostOrder.length);
      this.hostOrder.push(name);
      // Intern the signature now. The type section is encoded before the import
      // section reads these indices back, so a signature discovered late would
      // be referenced before it exists in the emitted binary.
      this.internType(HOST_FUNCTIONS[name], 1);
    }
  }

  private internType(params: number, results: number): number {
    const existing = this.types.findIndex((t) => t.params === params && t.results === results);
    if (existing !== -1) return existing;
    this.types.push({ params, results });
    return this.types.length - 1;
  }

  // --------------------------------------------------------------- compilation

  private compileFunction(exportName: string, decl: FnDecl): void {
    // Effectful functions are excluded: `rand` and `io` require host state that
    // the numeric subset deliberately does not model.
    const disallowed = decl.effects.filter((effect) => effect !== "money");
    if (disallowed.length > 0) {
      throw new Unsupported(`declares effects (${disallowed.join(", ")})`);
    }

    this.locals = new Map();
    this.localCount = 0;
    this.paramCount = decl.params.length;
    this.loopStack = [];
    this.blockDepth = 0;

    for (const param of decl.params) {
      this.locals.set(param.name, this.localCount++);
    }

    const body: number[] = [];
    const returned = this.compileBlock(decl.body, body, true);

    // A function whose body ends without a value still has to leave an f64 on
    // the stack, because every compiled signature returns one.
    if (!returned) {
      body.push(OP.f64Const, ...f64Bytes(0));
    }
    body.push(OP.end);

    const extraLocals = this.localCount - this.paramCount;
    const localDecl: number[] =
      extraLocals > 0 ? [...uleb(1), ...uleb(extraLocals), F64] : [...uleb(0)];

    this.compiled.push({
      name: decl.name,
      exportName,
      arity: decl.params.length,
      typeIndex: this.internType(decl.params.length, 1),
      extraLocals,
      body: [...localDecl, ...body],
    });
  }

  /**
   * Compile a block. Returns true when the block is guaranteed to have produced
   * a value on the stack (via `return` or a trailing expression).
   */
  private compileBlock(block: BlockStmt, out: number[], isFunctionBody: boolean): boolean {
    const statements = block.body;

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const isLast = i === statements.length - 1;

      // The final expression statement of a function body is its value.
      if (isFunctionBody && isLast && stmt.kind === "ExprStmt") {
        this.compileExpr(stmt.expr, out);
        return true;
      }

      // A trailing `if`/`else` is the function's value too, so it must be
      // compiled as an f64-typed block rather than a void statement whose
      // branch values are dropped. Without this, `if a > b { a - b } else
      // { b - a }` silently evaluated to the fallback zero.
      if (
        isFunctionBody &&
        isLast &&
        stmt.kind === "IfStmt" &&
        stmt.otherwise !== null &&
        this.isValueIf(stmt)
      ) {
        this.compileValueIf(stmt, out);
        return true;
      }

      if (this.compileStmt(stmt, out)) return true;
    }
    return false;
  }

  /**
   * Can this `if` statement be read as an expression? Both branches must end in
   * a single expression (or a nested value-`if`), which is exactly the shape
   * Sunra programmers use for a paytable.
   */
  private isValueIf(stmt: Extract<Stmt, { kind: "IfStmt" }>): boolean {
    const branchIsValue = (branch: BlockStmt | Extract<Stmt, { kind: "IfStmt" }> | null): boolean => {
      if (branch === null) return false;
      if (branch.kind === "IfStmt") return branch.otherwise !== null && this.isValueIf(branch);
      const body = branch.body;
      if (body.length === 0) return false;
      const last = body[body.length - 1];
      if (last.kind === "ExprStmt") return true;
      if (last.kind === "IfStmt") return last.otherwise !== null && this.isValueIf(last);
      return false;
    };
    return branchIsValue(stmt.then) && branchIsValue(stmt.otherwise);
  }

  /** Compile a value-producing `if`, leaving exactly one f64 on the stack. */
  private compileValueIf(stmt: Extract<Stmt, { kind: "IfStmt" }>, out: number[]): void {
    this.compileCondition(stmt.cond, out);
    out.push(OP.if, F64);
    this.blockDepth++;
    this.compileValueBranch(stmt.then, out);
    out.push(OP.else);
    if (stmt.otherwise === null) throw new Unsupported("value `if` without `else`");
    this.compileValueBranch(stmt.otherwise, out);
    this.blockDepth--;
    out.push(OP.end);
  }

  /** Compile one branch of a value-`if`: statements, then a trailing value. */
  private compileValueBranch(
    branch: BlockStmt | Extract<Stmt, { kind: "IfStmt" }>,
    out: number[],
  ): void {
    if (branch.kind === "IfStmt") {
      this.compileValueIf(branch, out);
      return;
    }

    const body = branch.body;
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i];
      const isLast = i === body.length - 1;
      if (!isLast) {
        if (this.compileStmt(stmt, out)) {
          // An early `return` already left the function; the branch still needs
          // a value on the stack to satisfy the block's f64 type.
          out.push(OP.f64Const, ...f64Bytes(0));
          return;
        }
        continue;
      }
      if (stmt.kind === "ExprStmt") {
        this.compileExpr(stmt.expr, out);
        return;
      }
      if (stmt.kind === "IfStmt" && stmt.otherwise !== null) {
        this.compileValueIf(stmt, out);
        return;
      }
      throw new Unsupported("branch does not end in a value");
    }
    throw new Unsupported("empty branch in a value `if`");
  }

  /** Returns true when the statement definitely returns from the function. */
  private compileStmt(stmt: Stmt, out: number[]): boolean {
    switch (stmt.kind) {
      case "LetStmt": {
        this.compileExpr(stmt.value, out);
        const index = this.declareLocal(stmt.name);
        out.push(OP.localSet, ...uleb(index));
        return false;
      }

      case "ExprStmt": {
        // Assignment already stores its value; other expressions are dropped.
        if (stmt.expr.kind === "Assign") {
          this.compileAssign(stmt.expr, out);
          return false;
        }
        this.compileExpr(stmt.expr, out);
        out.push(OP.drop);
        return false;
      }

      case "ReturnStmt": {
        if (stmt.value) this.compileExpr(stmt.value, out);
        else out.push(OP.f64Const, ...f64Bytes(0));
        out.push(OP.return);
        return true;
      }

      case "IfStmt": {
        this.compileCondition(stmt.cond, out);
        out.push(OP.if, 0x40); // void block: branches are statements
        this.blockDepth++;
        const thenReturns = this.compileBlock(stmt.then, out, false);
        let elseReturns = false;
        if (stmt.otherwise) {
          out.push(OP.else);
          if (stmt.otherwise.kind === "BlockStmt") {
            elseReturns = this.compileBlock(stmt.otherwise, out, false);
          } else {
            elseReturns = this.compileStmt(stmt.otherwise, out);
          }
        }
        this.blockDepth--;
        out.push(OP.end);
        return thenReturns && elseReturns;
      }

      case "WhileStmt": {
        // block { loop { br_if 1 (!cond); body; br 0 } }
        out.push(OP.block, 0x40);
        this.blockDepth++;
        out.push(OP.loop, 0x40);
        this.blockDepth++;
        this.loopStack.push({ blockDepth: this.blockDepth });

        this.compileCondition(stmt.cond, out);
        out.push(OP.i32Eqz);
        out.push(OP.brIf, ...uleb(1));

        this.compileBlock(stmt.body, out, false);
        out.push(OP.br, ...uleb(0));

        this.loopStack.pop();
        this.blockDepth--;
        out.push(OP.end);
        this.blockDepth--;
        out.push(OP.end);
        return false;
      }

      case "BlockStmt":
        return this.compileBlock(stmt, out, false);

      case "BreakStmt": {
        const loop = this.loopStack[this.loopStack.length - 1];
        if (!loop) throw new Unsupported("`break` outside a loop");
        // Break exits the enclosing `block`, which sits one level above `loop`.
        out.push(OP.br, ...uleb(1));
        return false;
      }

      case "ContinueStmt": {
        const loop = this.loopStack[this.loopStack.length - 1];
        if (!loop) throw new Unsupported("`continue` outside a loop");
        out.push(OP.br, ...uleb(0));
        return false;
      }

      case "ForStmt":
        throw new Unsupported("`for` requires iterables, which are not numeric");

      case "FnDecl":
        throw new Unsupported("nested function declarations");

      default:
        throw new Unsupported(`statement \`${stmt.kind}\``);
    }
  }

  private compileAssign(expr: Extract<Expr, { kind: "Assign" }>, out: number[]): void {
    if (expr.target.kind !== "Ident") {
      throw new Unsupported("assignment to a non-variable target");
    }
    const index = this.lookupLocal(expr.target.name);

    if (expr.op === "=") {
      this.compileExpr(expr.value, out);
      out.push(OP.localSet, ...uleb(index));
      return;
    }

    // Compound assignment: load, combine, store.
    out.push(OP.localGet, ...uleb(index));
    this.compileExpr(expr.value, out);
    switch (expr.op) {
      case "+=":
        out.push(OP.f64Add);
        break;
      case "-=":
        out.push(OP.f64Sub);
        break;
      case "*=":
        out.push(OP.f64Mul);
        break;
      case "/=":
        out.push(OP.f64Div);
        break;
      default:
        throw new Unsupported(`compound assignment \`${expr.op}\``);
    }
    out.push(OP.localSet, ...uleb(index));
  }

  /** Compile an expression that must leave one f64 on the stack. */
  private compileExpr(expr: Expr, out: number[]): void {
    switch (expr.kind) {
      case "IntLit":
      case "FloatLit":
        out.push(OP.f64Const, ...f64Bytes(expr.value));
        return;

      case "BoolLit":
        out.push(OP.f64Const, ...f64Bytes(expr.value ? 1 : 0));
        return;

      case "Ident": {
        const index = this.lookupLocal(expr.name);
        out.push(OP.localGet, ...uleb(index));
        return;
      }

      case "Unary": {
        if (expr.op === "-") {
          this.compileExpr(expr.operand, out);
          out.push(OP.f64Neg);
          return;
        }
        if (expr.op === "not" || expr.op === "!") {
          // Boolean negation on the f64 representation: x == 0 ? 1 : 0
          this.compileExpr(expr.operand, out);
          out.push(OP.f64Const, ...f64Bytes(0));
          out.push(OP.f64Eq);
          out.push(OP.f64ConvertI32S);
          return;
        }
        if (expr.op === "+") {
          this.compileExpr(expr.operand, out);
          return;
        }
        throw new Unsupported(`unary operator \`${expr.op}\``);
      }

      case "Binary":
        this.compileBinary(expr, out);
        return;

      case "IfExpr": {
        this.compileCondition(expr.cond, out);
        out.push(OP.if, F64);
        this.blockDepth++;
        this.compileExpr(expr.then, out);
        out.push(OP.else);
        if (!expr.otherwise) throw new Unsupported("`if` expression without `else`");
        this.compileExpr(expr.otherwise, out);
        this.blockDepth--;
        out.push(OP.end);
        return;
      }

      case "Call":
        this.compileCall(expr, out);
        return;

      case "Assign": {
        // Assignment as an expression: store, then reload for the value.
        this.compileAssign(expr, out);
        if (expr.target.kind !== "Ident") throw new Unsupported("assignment target");
        out.push(OP.localGet, ...uleb(this.lookupLocal(expr.target.name)));
        return;
      }

      case "StrLit":
      case "Interp":
        throw new Unsupported("string values");

      case "ArrayLit":
      case "Index":
        throw new Unsupported("list values");

      case "Member":
        throw new Unsupported("member access on non-numeric values");

      case "MatchExpr":
        throw new Unsupported("`match` expressions");

      case "Lambda":
        throw new Unsupported("closures");

      case "RangeExpr":
        throw new Unsupported("ranges");

      case "Pipeline":
        throw new Unsupported("pipeline operator");

      default:
        throw new Unsupported(`expression \`${(expr as Expr).kind}\``);
    }
  }

  private compileBinary(expr: Extract<Expr, { kind: "Binary" }>, out: number[]): void {
    const { op } = expr;

    // Short-circuit logic on the numeric representation.
    if (op === "and" || op === "&&" || op === "or" || op === "||") {
      const isAnd = op === "and" || op === "&&";
      this.compileCondition(expr.left, out);
      out.push(OP.if, F64);
      this.blockDepth++;
      if (isAnd) {
        this.compileCondition(expr.right, out);
        out.push(OP.f64ConvertI32S);
        out.push(OP.else);
        out.push(OP.f64Const, ...f64Bytes(0));
      } else {
        out.push(OP.f64Const, ...f64Bytes(1));
        out.push(OP.else);
        this.compileCondition(expr.right, out);
        out.push(OP.f64ConvertI32S);
      }
      this.blockDepth--;
      out.push(OP.end);
      return;
    }

    if (op === "%") {
      // f64 remainder: a - trunc(a / b) * b, matching the interpreter.
      this.compileExpr(expr.left, out);
      this.compileExpr(expr.left, out);
      this.compileExpr(expr.right, out);
      out.push(OP.f64Div);
      out.push(OP.f64Trunc);
      this.compileExpr(expr.right, out);
      out.push(OP.f64Mul);
      out.push(OP.f64Sub);
      return;
    }

    if (op === "//") {
      this.compileExpr(expr.left, out);
      this.compileExpr(expr.right, out);
      out.push(OP.f64Div);
      out.push(OP.f64Floor);
      return;
    }

    if (op === "**") {
      const index = this.hostIndex.get("pow");
      if (index === undefined) throw new Unsupported("`**` requires the pow host import");
      this.compileExpr(expr.left, out);
      this.compileExpr(expr.right, out);
      out.push(OP.call, ...uleb(index));
      return;
    }

    this.compileExpr(expr.left, out);
    this.compileExpr(expr.right, out);

    switch (op) {
      case "+":
        out.push(OP.f64Add);
        return;
      case "-":
        out.push(OP.f64Sub);
        return;
      case "*":
        out.push(OP.f64Mul);
        return;
      case "/":
        out.push(OP.f64Div);
        return;
      // Comparisons produce i32 in WASM; convert so every expression is f64.
      case "==":
        out.push(OP.f64Eq, OP.f64ConvertI32S);
        return;
      case "!=":
        out.push(OP.f64Ne, OP.f64ConvertI32S);
        return;
      case "<":
        out.push(OP.f64Lt, OP.f64ConvertI32S);
        return;
      case ">":
        out.push(OP.f64Gt, OP.f64ConvertI32S);
        return;
      case "<=":
        out.push(OP.f64Le, OP.f64ConvertI32S);
        return;
      case ">=":
        out.push(OP.f64Ge, OP.f64ConvertI32S);
        return;
      default:
        throw new Unsupported(`binary operator \`${op}\``);
    }
  }

  /** Compile an expression used as a condition, leaving an i32 on the stack. */
  private compileCondition(expr: Expr, out: number[]): void {
    if (expr.kind === "Binary") {
      const comparisons = new Set(["==", "!=", "<", ">", "<=", ">="]);
      if (comparisons.has(expr.op)) {
        this.compileExpr(expr.left, out);
        this.compileExpr(expr.right, out);
        switch (expr.op) {
          case "==":
            out.push(OP.f64Eq);
            return;
          case "!=":
            out.push(OP.f64Ne);
            return;
          case "<":
            out.push(OP.f64Lt);
            return;
          case ">":
            out.push(OP.f64Gt);
            return;
          case "<=":
            out.push(OP.f64Le);
            return;
          default:
            out.push(OP.f64Ge);
            return;
        }
      }
    }

    // Any other expression: truthiness is "not equal to zero".
    this.compileExpr(expr, out);
    out.push(OP.f64Const, ...f64Bytes(0));
    out.push(OP.f64Ne);
  }

  private compileCall(expr: Extract<Expr, { kind: "Call" }>, out: number[]): void {
    if (expr.callee.kind === "Member") {
      // Allow Math.* and SunraMath.* to lower to instructions or host calls.
      const object = expr.callee.object;
      if (object.kind === "Ident" && (object.name === "Math" || object.name === "SunraMath")) {
        this.compileMathCall(expr.callee.property, expr.args, out);
        return;
      }
      throw new Unsupported("method calls on non-numeric values");
    }

    if (expr.callee.kind !== "Ident") throw new Unsupported("computed call target");
    const name = expr.callee.name;

    // Intrinsics available as bare functions in Sunra.
    if (name in INTRINSIC_UNARY && expr.args.length === 1) {
      this.compileExpr(expr.args[0], out);
      out.push(INTRINSIC_UNARY[name]);
      return;
    }
    if (name in INTRINSIC_BINARY && expr.args.length === 2) {
      this.compileExpr(expr.args[0], out);
      this.compileExpr(expr.args[1], out);
      out.push(INTRINSIC_BINARY[name]);
      return;
    }
    if (name in HOST_FUNCTIONS && expr.args.length === HOST_FUNCTIONS[name]) {
      const index = this.hostIndex.get(name)!;
      for (const arg of expr.args) this.compileExpr(arg, out);
      out.push(OP.call, ...uleb(index));
      return;
    }

    const target = this.funcIndex.get(name);
    if (target === undefined) throw new Unsupported(`call to \`${name}\``);
    const expected = this.arity.get(name);
    if (expected !== undefined && expected !== expr.args.length) {
      throw new Unsupported(`call to \`${name}\` with mismatched arity`);
    }
    for (const arg of expr.args) this.compileExpr(arg, out);
    out.push(OP.call, ...uleb(target));
  }

  private compileMathCall(property: string, args: Expr[], out: number[]): void {
    if (property in INTRINSIC_UNARY && args.length === 1) {
      this.compileExpr(args[0], out);
      out.push(INTRINSIC_UNARY[property]);
      return;
    }
    if (property in INTRINSIC_BINARY && args.length === 2) {
      this.compileExpr(args[0], out);
      this.compileExpr(args[1], out);
      out.push(INTRINSIC_BINARY[property]);
      return;
    }
    if (property in HOST_FUNCTIONS && args.length === HOST_FUNCTIONS[property]) {
      const index = this.hostIndex.get(property)!;
      for (const arg of args) this.compileExpr(arg, out);
      out.push(OP.call, ...uleb(index));
      return;
    }
    throw new Unsupported(`Math.${property}`);
  }

  // -------------------------------------------------------------------- locals

  private declareLocal(name: string): number {
    const existing = this.locals.get(name);
    if (existing !== undefined) return existing;
    const index = this.localCount++;
    this.locals.set(name, index);
    return index;
  }

  private lookupLocal(name: string): number {
    const index = this.locals.get(name);
    if (index === undefined) {
      throw new Unsupported(`\`${name}\` is not a numeric local`);
    }
    return index;
  }

  /** Declarations kept for the reindexing pass. */
  private readonly declarations = new Map<string, FnDecl>();

  /** Register declarations before compilation so reindexing can recompile. */
  registerDeclarations(program: Program): void {
    for (const stmt of program.body) {
      if (stmt.kind === "FnDecl") this.declarations.set(stmt.name, stmt);
      else if (stmt.kind === "GameDecl") {
        for (const fn of stmt.functions) this.declarations.set(`${stmt.name}_${fn.name}`, fn);
      }
    }
  }

  // ------------------------------------------------------------------ encoding

  private encodeModule(): Uint8Array {
    const typeSection = encodeSection(
      SECTION.type,
      encodeVector(
        this.types.map((type) => [
          0x60,
          ...uleb(type.params),
          ...Array.from({ length: type.params }, () => F64),
          ...uleb(type.results),
          ...Array.from({ length: type.results }, () => F64),
        ]),
      ),
    );

    const importSection = encodeSection(
      SECTION.import,
      encodeVector(
        this.hostOrder.map((name) => [
          ...encodeName("env"),
          ...encodeName(name),
          0x00, // function import
          ...uleb(this.internType(HOST_FUNCTIONS[name], 1)),
        ]),
      ),
    );

    const functionSection = encodeSection(
      SECTION.function,
      encodeVector(this.compiled.map((fn) => uleb(fn.typeIndex))),
    );

    const memorySection = encodeSection(
      SECTION.memory,
      encodeVector([[0x00, ...uleb(1)]]), // one page, no maximum
    );

    const exportSection = encodeSection(
      SECTION.export,
      encodeVector([
        ...this.compiled.map((fn, i) => [
          ...encodeName(fn.exportName),
          0x00,
          ...uleb(this.hostOrder.length + i),
        ]),
        [...encodeName("memory"), 0x02, ...uleb(0)],
      ]),
    );

    const codeSection = encodeSection(
      SECTION.code,
      encodeVector(this.compiled.map((fn) => [...uleb(fn.body.length), ...fn.body])),
    );

    return new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, // magic "\0asm"
      0x01, 0x00, 0x00, 0x00, // version 1
      ...typeSection,
      ...importSection,
      ...functionSection,
      ...memorySection,
      ...exportSection,
      ...codeSection,
    ]);
  }
}

/** Compile a checked program to WebAssembly. */
export function emitWasm(program: Program): WasmEmitResult {
  const emitter = new WasmEmitter();
  emitter.registerDeclarations(program);
  return emitter.emit(program);
}

/**
 * Generate the JavaScript loader that instantiates the module and supplies the
 * host imports. The loader is a normal ES module so it works in Node and in a
 * browser bundler without configuration.
 */
export function emitWasmLoader(options: {
  wasmFileName: string;
  compiled: string[];
  skipped: SkippedFunction[];
  sourceName: string;
}): string {
  const { wasmFileName, compiled, skipped, sourceName } = options;

  const skippedComment =
    skipped.length === 0
      ? " *   (none — the whole program compiled to WebAssembly)"
      : skipped.map((fn) => ` *   ${fn.name}: ${fn.reason}`).join("\n");

  return `/**
 * Sunra WebAssembly loader for ${sourceName}.
 *
 * Exports every function that compiled to WASM. All values are f64, which is
 * Sunra's \`Float\` exactly and represents \`Int\` faithfully to 2^53.
 *
 * Compiled to WebAssembly:
${compiled.map((name) => ` *   ${name}`).join("\n") || " *   (none)"}
 *
 * Not compiled (outside the numeric subset — use the JavaScript target for these):
${skippedComment}
 */

const HOST = {
  pow: Math.pow,
  log: Math.log,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  atan2: Math.atan2,
  random: Math.random,
};

let instance = null;

/** Load the module. Pass \`{ random }\` to control the host random source. */
export async function load(overrides = {}) {
  if (instance) return instance;

  const env = { ...HOST, ...overrides };
  const bytes = await readModule();
  const module = await WebAssembly.instantiate(bytes, { env });
  instance = module.instance.exports;
  return instance;
}

async function readModule() {
  if (typeof process !== "undefined" && process.versions?.node) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    return readFile(join(here, ${JSON.stringify(wasmFileName)}));
  }
  const response = await fetch(new URL(${JSON.stringify(wasmFileName)}, import.meta.url));
  return response.arrayBuffer();
}

/** Synchronous access after \`load()\` has resolved. */
export function exports_() {
  if (!instance) throw new Error("call load() before exports_()");
  return instance;
}

${compiled
  .map(
    (name) => `export async function ${name}(...args) {
  const wasm = await load();
  return wasm.${name}(...args);
}`,
  )
  .join("\n\n")}
`;
}
