/**
 * Sunra to JavaScript code generator.
 *
 * The emitter lowers a checked Sunra AST into standalone, readable ES modules.
 * Two decisions shape the whole design:
 *
 *  1. Sunra values are emitted as *plain JavaScript values* — numbers, strings,
 *     booleans and arrays — rather than the tagged unions the interpreter uses.
 *     Generated code therefore runs at native speed and interoperates directly
 *     with any JavaScript host. The one exception is `Money`, which must stay
 *     exact and is emitted as a small BigInt-backed class from the runtime.
 *
 *  2. Everything the program needs at runtime is imported from a single
 *     `sunra_runtime.js` file that the compiler emits alongside the output.
 *     A build has no dependency on the interpreter, on `dist/`, or on npm.
 *
 * Effects are erased at this stage: they have already been proven by the
 * checker, exactly as type annotations are erased by a typed-to-untyped
 * compiler. The emitted JavaScript is what remains once the proof is done.
 */

import type {
  BlockStmt,
  Expr,
  FnDecl,
  GameDecl,
  Program,
  Stmt,
} from "../parser/ast.js";
import { runtimeError } from "../diagnostics.js";

export interface EmitOptions {
  /** Base name used in the emitted header comment. */
  sourceName?: string;
  /** Module specifier used to import the runtime. */
  runtimeSpecifier?: string;
  /** Emit a `main()` invocation at the end of the module. */
  emitEntryPoint?: boolean;
  /** Deterministic seed baked into the artifact, if any. */
  seed?: string | number;
}

/** Names the runtime provides; referenced identifiers are imported by name. */
const RUNTIME_EXPORTS = [
  "$rt",
  "print",
  "println",
  "len",
  "str",
  "int",
  "float",
  "abs",
  "floor",
  "ceil",
  "round",
  "sqrt",
  "min",
  "max",
  "sum",
  "range",
  "push",
  "assert",
  "sort",
  "rng",
  "Reel",
  "Deck",
  "Card",
  "Baccarat",
  "Poker",
  "Dice",
  "Money",
  "Fair",
  "Rtp",
  "Math_",
  "audit",
  "SunraMath",
  "SunraString",
  "SunraArray",
  "Json",
  "Crypto",
  "Timer",
  "Http",
  "File",
] as const;

/** JavaScript reserved words that Sunra identifiers may legally collide with. */
const RESERVED = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "package", "private", "protected", "public",
  "return", "static", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield", "arguments", "eval",
]);

/** Sunra's `Math` module is emitted as `Math_` to avoid shadowing global Math. */
const RENAMED_GLOBALS: Record<string, string> = {
  Math: "Math_",
};

export interface EmitResult {
  /** The generated ES module. */
  code: string;
  /** Runtime identifiers the module imports. */
  imports: string[];
  /** Games discovered in the program, in declaration order. */
  games: string[];
  /** Tests discovered in the program. */
  tests: string[];
  /** Whether the program declares a `main` function. */
  hasMain: boolean;
}

export class Emitter {
  private readonly out: string[] = [];
  private indentLevel = 0;
  private readonly used = new Set<string>();
  private readonly games: string[] = [];
  private readonly tests: string[] = [];
  private hasMain = false;
  private tmpCounter = 0;

  /** Identifiers bound in the current lexical scope chain. */
  private scopes: Array<Set<string>> = [new Set()];

  /**
   * Methods of the game currently being emitted. Inside a game body, a bare
   * call to a sibling method must resolve through `self`, because the methods
   * live on an object literal rather than in the enclosing lexical scope.
   */
  private gameMethods: Set<string> | null = null;

  constructor(private readonly options: EmitOptions = {}) {}

  emit(program: Program): EmitResult {
    // Discover declarations first so mutual references resolve regardless of order.
    for (const stmt of program.body) {
      if (stmt.kind === "FnDecl") {
        this.declare(stmt.name);
        if (stmt.name === "main") this.hasMain = true;
      }
      if (stmt.kind === "GameDecl") {
        this.declare(stmt.name);
        this.games.push(stmt.name);
      }
      if (stmt.kind === "TypeDecl") {
        for (const variant of stmt.variants) this.declare(variant);
      }
      if (stmt.kind === "TestDecl") this.tests.push(stmt.name);
    }

    const body: string[] = [];
    const swap = this.captureInto(body);

    for (const stmt of program.body) {
      this.emitStmt(stmt);
    }

    if (this.tests.length > 0) this.emitTestRegistry(program);
    if (this.hasMain && this.options.emitEntryPoint !== false) {
      this.line("");
      this.line("// Entry point");
      if (this.tests.length > 0) {
        // Under `--test` the artifact runs its assertions instead of its program,
        // mirroring `sunra test` on the source.
        this.line(`if (!${this.rt()}.isTestRun()) {`);
        this.indent();
        this.line("main();");
        this.dedent();
        this.line("}");
      } else {
        this.line("main();");
      }
    }

    swap();

    const header = this.buildHeader();
    const imports = [...this.used].sort();
    const importBlock =
      imports.length > 0
        ? `import {\n${imports.map((name) => `  ${name},`).join("\n")}\n} from "${this.runtimeSpecifier()}";\n`
        : "";

    return {
      code: `${header}${importBlock}\n${body.join("\n")}\n`,
      imports,
      games: this.games,
      tests: this.tests,
      hasMain: this.hasMain,
    };
  }

  // --------------------------------------------------------------- plumbing

  private runtimeSpecifier(): string {
    return this.options.runtimeSpecifier ?? "./sunra_runtime.js";
  }

  private buildHeader(): string {
    const source = this.options.sourceName ?? "program.sun";
    const seed =
      this.options.seed === undefined
        ? "secure OS entropy"
        : `deterministic seed ${JSON.stringify(String(this.options.seed))}`;
    return [
      "// Generated by the Sunra compiler 0.2.0 — do not edit by hand.",
      `// Source: ${source}`,
      `// Randomness: ${seed}`,
      "//",
      "// Effects were verified at compile time and are erased here, the way a",
      "// typed compiler erases types once its proofs are complete.",
      "",
      "",
    ].join("\n");
  }

  /** Redirect emitted lines into `sink` until the returned function is called. */
  private captureInto(sink: string[]): () => void {
    const original = this.out.splice(0, this.out.length);
    const restore = () => {
      sink.push(...this.out.splice(0, this.out.length));
      this.out.push(...original);
    };
    return restore;
  }

  private line(text = ""): void {
    if (text === "") {
      this.out.push("");
      return;
    }
    this.out.push("  ".repeat(this.indentLevel) + text);
  }

  private indent(): void {
    this.indentLevel += 1;
  }

  private dedent(): void {
    this.indentLevel = Math.max(0, this.indentLevel - 1);
  }

  private tmp(prefix = "t"): string {
    this.tmpCounter += 1;
    return `$${prefix}${this.tmpCounter}`;
  }

  private pushScope(): void {
    this.scopes.push(new Set());
  }

  private popScope(): void {
    this.scopes.pop();
  }

  private declare(name: string): void {
    this.scopes[this.scopes.length - 1].add(name);
  }

  private isLocal(name: string): boolean {
    return this.scopes.some((scope) => scope.has(name));
  }

  /** Mangle Sunra identifiers that collide with JavaScript reserved words. */
  private id(name: string): string {
    return RESERVED.has(name) ? `${name}$` : name;
  }

  /** Resolve a name to either a local binding or an imported runtime symbol. */
  private ref(name: string): string {
    // Sibling methods of the enclosing game are reached through `self`, unless a
    // narrower local binding (a parameter, say) shadows the name.
    if (this.gameMethods?.has(name) && !this.isLocal(name)) {
      return `self.${this.id(name)}`;
    }
    if (this.isLocal(name)) return this.id(name);

    const renamed = RENAMED_GLOBALS[name];
    if (renamed) {
      this.use(renamed);
      return renamed;
    }
    if ((RUNTIME_EXPORTS as readonly string[]).includes(name)) {
      this.use(name);
      return name;
    }
    // Unknown at emit time: the checker has already reported it, so emit the
    // name verbatim and let the runtime raise a precise error if reached.
    return this.id(name);
  }

  private use(name: string): void {
    this.used.add(name);
  }

  private rt(): string {
    this.use("$rt");
    return "$rt";
  }

  // -------------------------------------------------------------- statements

  private emitStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case "ModuleStmt":
      case "UseStmt":
        // Module and import declarations are resolved by the package layer.
        return;

      case "TypeDecl": {
        this.line("");
        this.line(`// type ${stmt.name}`);
        for (const variant of stmt.variants) {
          this.line(`const ${this.id(variant)} = ${JSON.stringify(variant)};`);
        }
        return;
      }

      case "FnDecl":
        this.emitFn(stmt);
        return;

      case "GameDecl":
        this.emitGame(stmt);
        return;

      case "TestDecl":
        // Tests are collected into a registry after the main body.
        return;

      case "LetStmt": {
        this.declare(stmt.name);
        const keyword = stmt.mutable ? "let" : "const";
        this.line(`${keyword} ${this.id(stmt.name)} = ${this.expr(stmt.value)};`);
        return;
      }

      case "ExprStmt":
        this.line(`${this.expr(stmt.expr)};`);
        return;

      case "ReturnStmt":
        this.line(stmt.value ? `return ${this.expr(stmt.value)};` : "return;");
        return;

      case "IfStmt": {
        this.line(`if (${this.cond(stmt.cond)}) {`);
        this.emitBlock(stmt.then);
        if (stmt.otherwise) {
          if (stmt.otherwise.kind === "IfStmt") {
            // `elif` chains flatten into `else if` for readable output.
            this.line("} else {");
            this.indent();
            this.emitStmt(stmt.otherwise);
            this.dedent();
            this.line("}");
          } else {
            this.line("} else {");
            this.emitBlock(stmt.otherwise);
            this.line("}");
          }
        } else {
          this.line("}");
        }
        return;
      }

      case "WhileStmt": {
        this.line(`while (${this.cond(stmt.cond)}) {`);
        this.emitBlock(stmt.body);
        this.line("}");
        return;
      }

      case "ForStmt": {
        this.pushScope();
        this.declare(stmt.binding);
        this.line(`for (const ${this.id(stmt.binding)} of ${this.rt()}.iterate(${this.expr(stmt.iterable)})) {`);
        this.emitBlock(stmt.body, false);
        this.line("}");
        this.popScope();
        return;
      }

      case "BlockStmt": {
        this.line("{");
        this.emitBlock(stmt);
        this.line("}");
        return;
      }

      case "BreakStmt":
        this.line("break;");
        return;

      case "ContinueStmt":
        this.line("continue;");
        return;
    }
  }

  private emitBlock(block: BlockStmt, ownScope = true): void {
    if (ownScope) this.pushScope();
    this.indent();

    // Hoist nested declarations so order of definition does not matter.
    for (const stmt of block.body) {
      if (stmt.kind === "FnDecl") this.declare(stmt.name);
      if (stmt.kind === "GameDecl") this.declare(stmt.name);
    }
    for (const stmt of block.body) this.emitStmt(stmt);

    this.dedent();
    if (ownScope) this.popScope();
  }

  /**
   * Emit a function. Sunra's trailing expression is the return value, so the
   * final `ExprStmt` of a body becomes an explicit `return`.
   */
  private emitFn(fn: FnDecl, asMethod = false): void {
    const params = fn.params.map((p) => this.id(p.name)).join(", ");
    const effects = fn.effects.length > 0 ? ` uses ${fn.effects.join(", ")}` : " (pure)";

    this.line("");
    if (fn.intent) this.line(`// intent: ${fn.intent}`);
    this.line(`// fn ${fn.name}(${fn.params.map((p) => p.name).join(", ")})${effects}`);

    if (asMethod) {
      this.line(`${this.id(fn.name)}(${params}) {`);
    } else {
      this.declare(fn.name);
      this.line(`function ${this.id(fn.name)}(${params}) {`);
    }

    this.pushScope();
    for (const p of fn.params) this.declare(p.name);
    this.indent();
    this.emitFnBody(fn.body);
    this.dedent();
    this.popScope();

    this.line("}");
  }

  private emitFnBody(block: BlockStmt): void {
    for (const stmt of block.body) {
      if (stmt.kind === "FnDecl") this.declare(stmt.name);
      if (stmt.kind === "GameDecl") this.declare(stmt.name);
    }

    const lastIndex = block.body.length - 1;
    block.body.forEach((stmt, index) => {
      const isTail = index === lastIndex;
      if (isTail) {
        this.emitTail(stmt);
        return;
      }
      this.emitStmt(stmt);
    });
  }

  /**
   * Emit a statement in tail position, where its value is the function's
   * result. Sunra treats a trailing `if` as an expression, so each of its
   * branches must itself end in a `return` rather than falling through.
   */
  private emitTail(stmt: Stmt): void {
    if (stmt.kind === "ExprStmt") {
      this.line(`return ${this.expr(stmt.expr)};`);
      return;
    }

    if (stmt.kind === "IfStmt") {
      this.line(`if (${this.cond(stmt.cond)}) {`);
      this.pushScope();
      this.indent();
      this.emitFnBody(stmt.then);
      this.dedent();
      this.popScope();

      if (stmt.otherwise) {
        this.line("} else {");
        this.indent();
        if (stmt.otherwise.kind === "IfStmt") {
          this.emitTail(stmt.otherwise);
        } else {
          this.pushScope();
          this.emitFnBody(stmt.otherwise);
          this.popScope();
        }
        this.dedent();
        this.line("}");
      } else {
        this.line("}");
      }
      return;
    }

    if (stmt.kind === "BlockStmt") {
      this.pushScope();
      this.emitFnBody(stmt);
      this.popScope();
      return;
    }

    this.emitStmt(stmt);
  }

  /**
   * A `game` block becomes a frozen object literal: declarative fields are data,
   * reels are data, and methods are functions that close over the object through
   * `self`. This preserves the interpreter's semantics — including access to
   * fields by bare name inside methods — with no runtime lookup machinery.
   */
  private emitGame(game: GameDecl): void {
    this.declare(game.name);

    const savedMethods = this.gameMethods;
    this.gameMethods = new Set(game.functions.map((fn) => fn.name));

    this.line("");
    this.line(`// ============================================================`);
    this.line(`// game ${game.name}`);
    this.line(`// ============================================================`);
    this.line(`const ${this.id(game.name)} = (() => {`);
    this.indent();

    this.pushScope();

    for (const reel of game.reels) {
      this.declare(reel.name);
      if (reel.weights) {
        const symbols = this.expr(reel.symbols);
        const weights = this.expr(reel.weights);
        this.line(`const ${this.id(reel.name)} = ${this.rt()}.reel(${symbols}, ${weights});`);
      } else {
        this.line(`const ${this.id(reel.name)} = ${this.expr(reel.symbols)};`);
      }
    }

    for (const field of game.fields) {
      this.declare(field.name);
      this.line(`const ${this.id(field.name)} = ${this.expr(field.value)};`);
    }

    // An `#[rtp(target = ..., tolerance = ...)]` attribute is surfaced as data
    // so that a generated artifact still carries its declared obligation.
    const rtpAttr = game.attributes.find((a) => a.name === "rtp");
    const declaredFields = new Set(game.fields.map((f) => f.name));
    if (rtpAttr?.args["target"] && !declaredFields.has("rtp")) {
      this.declare("rtp");
      this.line(`const rtp = ${this.expr(rtpAttr.args["target"])};`);
      declaredFields.add("rtp");
    }
    if (rtpAttr?.args["tolerance"] && !declaredFields.has("tolerance")) {
      this.declare("tolerance");
      this.line(`const tolerance = ${this.expr(rtpAttr.args["tolerance"])};`);
      declaredFields.add("tolerance");
    }

    // `self` lets methods call one another without knowing the binding name.
    this.declare("self");
    this.line("");
    this.line("const self = {");
    this.indent();

    for (const reel of game.reels) {
      this.line(`${JSON.stringify(reel.name)}: ${this.id(reel.name)},`);
    }
    for (const name of declaredFields) {
      this.line(`${JSON.stringify(name)}: ${this.id(name)},`);
    }

    for (const fn of game.functions) {
      this.emitGameMethod(fn);
    }

    this.dedent();
    this.line("};");
    this.line("");
    this.line("return self;");

    this.popScope();
    this.dedent();
    this.line("})();");

    this.gameMethods = savedMethods;
  }

  private emitGameMethod(fn: FnDecl): void {
    const params = fn.params.map((p) => this.id(p.name)).join(", ");
    const effects = fn.effects.length > 0 ? `uses ${fn.effects.join(", ")}` : "pure";

    this.line("");
    if (fn.intent) this.line(`// intent: ${fn.intent}`);
    this.line(`// ${effects}`);
    this.line(`${this.id(fn.name)}(${params}) {`);

    this.pushScope();
    for (const p of fn.params) this.declare(p.name);
    this.indent();
    this.emitFnBody(fn.body);
    this.dedent();
    this.popScope();

    this.line("},");
  }

  /**
   * Emit the test registry and a runner. Generated artifacts stay verifiable:
   * `node program.js --test` re-runs the same assertions the interpreter ran.
   */
  private emitTestRegistry(program: Program): void {
    this.line("");
    this.line("// ============================================================");
    this.line("// Tests");
    this.line("// ============================================================");
    this.line("export const $tests = [");
    this.indent();

    for (const stmt of program.body) {
      if (stmt.kind !== "TestDecl") continue;
      this.line(`{`);
      this.indent();
      this.line(`name: ${JSON.stringify(stmt.name)},`);
      this.line(`run() {`);
      this.pushScope();
      this.indent();
      this.emitBlock(stmt.body, false);
      this.dedent();
      this.popScope();
      this.line(`},`);
      this.dedent();
      this.line(`},`);
    }

    this.dedent();
    this.line("];");
    this.line("");
    this.line(`if (${this.rt()}.isTestRun()) {`);
    this.indent();
    this.line(`${this.rt()}.runTests($tests);`);
    this.dedent();
    this.line("}");
    this.line("");
  }

  // ------------------------------------------------------------- expressions

  /** Emit an expression that must be a Bool; the runtime enforces the rule. */
  private cond(expr: Expr): string {
    return `${this.rt()}.truthy(${this.expr(expr)})`;
  }

  private expr(expr: Expr): string {
    switch (expr.kind) {
      case "IntLit":
        return String(expr.value);

      case "FloatLit":
        return Number.isInteger(expr.value) ? `${expr.value}.0` : String(expr.value);

      case "StrLit":
        return JSON.stringify(expr.value);

      case "BoolLit":
        return expr.value ? "true" : "false";

      case "ArrayLit":
        return `[${expr.elements.map((e) => this.expr(e)).join(", ")}]`;

      case "Ident":
        return this.ref(expr.name);

      case "Interp": {
        // Emit a template literal when no part needs formatting, so the output
        // stays idiomatic; fall back to the runtime formatter otherwise.
        const simple = expr.parts.every((part) => "text" in part || part.format === null);
        if (simple) {
          const body = expr.parts
            .map((part) =>
              "text" in part
                ? part.text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
                : `\${${this.rt()}.display(${this.expr(part.expr)})}`,
            )
            .join("");
          return `\`${body}\``;
        }
        const pieces = expr.parts.map((part) =>
          "text" in part
            ? JSON.stringify(part.text)
            : `${this.rt()}.format(${this.expr(part.expr)}, ${JSON.stringify(part.format)})`,
        );
        return `(${pieces.join(" + ")})`;
      }

      case "Unary": {
        if (expr.op === "not") return `(!${this.cond(expr.operand)})`;
        if (expr.op === "-") return `${this.rt()}.neg(${this.expr(expr.operand)})`;
        return this.expr(expr.operand);
      }

      case "Binary":
        return this.binary(expr);

      case "Assign":
        return this.assign(expr);

      case "Lambda": {
        this.pushScope();
        for (const p of expr.params) this.declare(p.name);
        const params = expr.params.map((p) => this.id(p.name)).join(", ");
        const body = this.expr(expr.body);
        this.popScope();
        return `((${params}) => ${body})`;
      }

      case "IfExpr": {
        const otherwise = expr.otherwise ? this.expr(expr.otherwise) : "undefined";
        return `(${this.cond(expr.cond)} ? ${this.expr(expr.then)} : ${otherwise})`;
      }

      case "MatchExpr":
        return this.match(expr);

      case "RangeExpr":
        return `${this.rt()}.range(${this.expr(expr.from)}, ${this.expr(expr.to)}, ${expr.inclusive})`;

      case "Index":
        return `${this.rt()}.index(${this.expr(expr.object)}, ${this.expr(expr.index)})`;

      case "Member":
        return `${this.rt()}.member(${this.expr(expr.object)}, ${JSON.stringify(expr.property)})`;

      case "Pipeline": {
        if (expr.stage.kind === "Call") {
          const callee = this.expr(expr.stage.callee);
          const rest = expr.stage.args.map((a) => this.expr(a));
          return `${this.rt()}.call(${callee}, [${[this.expr(expr.value), ...rest].join(", ")}])`;
        }
        return `${this.rt()}.call(${this.expr(expr.stage)}, [${this.expr(expr.value)}])`;
      }

      case "Call":
        return this.call(expr);
    }
  }

  private call(expr: Expr & { kind: "Call" }): string {
    const args = expr.args.map((a) => this.expr(a)).join(", ");

    // A direct method call `obj.m(a)` is emitted through the runtime so that
    // built-in methods on primitives (list.map, str.upper, Money.scale) behave
    // exactly as they do under the interpreter.
    if (expr.callee.kind === "Member") {
      const object = this.expr(expr.callee.object);
      const property = JSON.stringify(expr.callee.property);
      return `${this.rt()}.invoke(${object}, ${property}, [${args}])`;
    }

    return `${this.expr(expr.callee)}(${args})`;
  }

  private binary(expr: Expr & { kind: "Binary" }): string {
    const { op } = expr;

    if (op === "and") return `(${this.cond(expr.left)} && ${this.cond(expr.right)})`;
    if (op === "or") return `(${this.cond(expr.left)} || ${this.cond(expr.right)})`;

    const left = this.expr(expr.left);
    const right = this.expr(expr.right);

    switch (op) {
      case "==":
        return `${this.rt()}.eq(${left}, ${right})`;
      case "!=":
        return `(!${this.rt()}.eq(${left}, ${right}))`;
      case "<":
      case "<=":
      case ">":
      case ">=":
        return `${this.rt()}.cmp(${JSON.stringify(op)}, ${left}, ${right})`;
      case "+":
      case "-":
      case "*":
      case "/":
      case "%":
        return `${this.rt()}.arith(${JSON.stringify(op)}, ${left}, ${right})`;
      default:
        throw runtimeError(`cannot lower operator \`${op}\` to JavaScript`, expr.span);
    }
  }

  private assign(expr: Expr & { kind: "Assign" }): string {
    const op = expr.op;
    const value = this.expr(expr.value);

    if (expr.target.kind === "Ident") {
      const name = this.ref(expr.target.name);
      if (op === "=") return `(${name} = ${value})`;
      const binop = JSON.stringify(op.slice(0, 1));
      return `(${name} = ${this.rt()}.arith(${binop}, ${name}, ${value}))`;
    }

    if (expr.target.kind === "Index") {
      const object = this.expr(expr.target.object);
      const index = this.expr(expr.target.index);
      const binop = op === "=" ? "null" : JSON.stringify(op.slice(0, 1));
      return `${this.rt()}.setIndex(${object}, ${index}, ${value}, ${binop})`;
    }

    if (expr.target.kind === "Member") {
      const object = this.expr(expr.target.object);
      const property = JSON.stringify(expr.target.property);
      const binop = op === "=" ? "null" : JSON.stringify(op.slice(0, 1));
      return `${this.rt()}.setMember(${object}, ${property}, ${value}, ${binop})`;
    }

    throw runtimeError("invalid assignment target", expr.span);
  }

  /**
   * `match` lowers to an immediately-invoked arrow function over a bound
   * subject, which keeps evaluation order identical to the interpreter and
   * preserves the expression's value semantics.
   */
  private match(expr: Expr & { kind: "MatchExpr" }): string {
    const subject = this.tmp("subject");
    const parts: string[] = [];

    for (const arm of expr.arms) {
      const test =
        arm.pattern === null ? "true" : `${this.rt()}.eq(${subject}, ${this.expr(arm.pattern)})`;
      const guard = arm.guard ? ` && ${this.rt()}.truthy(${this.expr(arm.guard)})` : "";
      parts.push(`(${test}${guard}) ? (${this.expr(arm.body)})`);
    }

    const fallback = `${this.rt()}.matchFailed(${subject})`;
    return `((${subject}) => ${parts.join(" : ")} : ${fallback})(${this.expr(expr.subject)})`;
  }
}

export function emitProgram(program: Program, options: EmitOptions = {}): EmitResult {
  return new Emitter(options).emit(program);
}
