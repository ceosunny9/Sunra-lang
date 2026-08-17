/**
 * SunHIR -> SunMIR lowering.
 *
 * Construction is direct rather than via a naive "assign to memory then run
 * mem2reg" detour: variables are tracked per block in a symbol table, and a phi
 * is inserted at every merge point where the incoming definitions differ. That
 * keeps the IR small enough to read in tests while still being genuine SSA.
 *
 * Monomorphization: Sunra's prototype has no explicit generics, but functions
 * are used at several concrete types (a `total(xs)` called with `[Int]` and
 * `[Float]`). Each distinct argument-type tuple produces its own symbol, and the
 * instantiation is logged so the build report can show what was specialised.
 *
 * Drops come from the ownership pass: at the end of a region, every affine
 * binding it introduced is dropped in reverse declaration order.
 */
import type { Span } from "../diagnostics.js";
import { T, tyName, type Ty } from "../checker/checker.js";
import type {
  HirBlock,
  HirExpr,
  HirFn,
  HirModule,
  HirStmt,
} from "../hir/hir.js";
import { classify, type OwnershipResult } from "../own/ownership.js";
import type {
  BlockId,
  MirBlock,
  MirConst,
  MirFunction,
  MirInstr,
  MirModule,
  MirTerminator,
  ValueId,
} from "./mir.js";

interface LoopContext {
  breakTarget: BlockId;
  continueTarget: BlockId;
}

class FunctionBuilder {
  private readonly blocks = new Map<BlockId, MirBlock>();
  private readonly types = new Map<ValueId, Ty>();
  /** Per-block variable state, so merges can build phis. */
  private readonly blockVars = new Map<BlockId, Map<string, ValueId>>();
  private current: BlockId;
  private nextValue = 0;
  private nextBlock = 0;
  private readonly loops: LoopContext[] = [];
  /** Bindings declared in each open region, for drop insertion. */
  private readonly regionBindings: Array<Array<{ name: string; value: ValueId; ty: Ty }>> = [];

  constructor(
    private readonly fn: HirFn,
    private readonly symbolFor: (name: string, argTypes: Ty[]) => string,
    /** Field names visible to this function through its enclosing `game` block. */
    private readonly gameFields: ReadonlySet<string> = new Set(),
  ) {
    this.current = this.newBlock();
  }

  build(): MirFunction {
    const params = this.fn.params.map((p) => {
      const value = this.freshValue(p.ty);
      this.setVar(p.name, value);
      return { name: p.name, value, ty: p.ty };
    });

    const entry = this.current;
    this.pushRegion();
    // Sunra functions return their last expression, exactly as the interpreter
    // evaluates them. Lowering the body without honouring that made every
    // implicit-return function yield unit in MIR — and therefore in the SunVM,
    // LLVM and contract backends — while the interpreter returned the real value.
    const tail = this.tailValue(this.fn.body);
    const finalDrops = this.popRegion();

    // A function that falls off the end returns unit; emit the drops first so
    // every path releases what it owns.
    if (!this.isTerminated(this.current)) {
      for (const drop of finalDrops) this.emitDrop(drop);
      if (tail !== null && this.fn.ret.k !== "Unit") {
        this.terminate({ op: "return", value: tail, span: this.fn.span });
      } else {
        const unit = this.emitConst({ k: "unit" }, T.unit, this.fn.span);
        this.terminate({
          op: "return",
          value: this.fn.ret.k === "Unit" ? null : unit,
          span: this.fn.span,
        });
      }
    }

    // Drop any block that is unreachable and empty, then order by id.
    const blocks = [...this.blocks.values()].sort((a, b) => a.id - b.id);

    return {
      symbol: this.symbolFor(this.fn.name, params.map((p) => p.ty)),
      name: this.fn.name,
      params,
      ret: this.fn.ret,
      effects: [...this.fn.effects],
      attributes: this.fn.attributes.map((a) => ({ name: a.name, args: a.args })),
      blocks,
      entry,
      types: this.types,
      span: this.fn.span,
    };
  }

  // ------------------------------------------------------------- blocks

  /**
   * Lower a function body, returning the value of its trailing expression.
   *
   * The final statement is lowered as an expression when it is one, so
   * `fn add(a, b) { a + b }` produces `return %sum` rather than `return ()`.
   * Returns `null` when the body has no trailing expression to yield.
   */
  private tailValue(body: HirBlock): ValueId | null {
    const statements = body.body;
    if (statements.length === 0) {
      return null;
    }

    const last = statements[statements.length - 1];
    for (const stmt of statements.slice(0, -1)) this.stmt(stmt);

    if (last.kind === "ExprStmt") {
      // Guard against a body whose earlier statements already returned.
      if (this.isTerminated(this.current)) return null;
      return this.expr(last.expr);
    }

    // `fn f() { if c { a } else { b } }` is a value-producing tail: the checker
    // types it as the function's return type. Lowering it as a plain statement
    // discarded both branch values and returned unit, so every backend emitted a
    // `ret` of the wrong type — LLVM IR that `llvm-as` rejects, and a SunVM
    // function that answered 0.
    if (last.kind === "IfStmt" && last.otherwise !== null && !this.isTerminated(this.current)) {
      const tail = this.tailIf(last);
      if (tail !== null) return tail;
    }

    this.stmt(last);
    return null;
  }

  /**
   * Lower a trailing `if`/`else` into a join block carrying a phi of both branch
   * values. Returns `null` when either branch does not produce a value (it
   * returned or broke), in which case there is nothing to merge and the caller
   * lowers it as an ordinary statement.
   */
  private tailIf(stmt: HirStmt & { kind: "IfStmt" }): ValueId | null {
    const otherwise = stmt.otherwise;
    if (!otherwise) return null;

    const cond = this.expr(stmt.cond);
    const thenBlock = this.newBlock();
    const elseBlock = this.newBlock();
    const joinBlock = this.newBlock();
    this.terminate({ op: "branch", cond, then: thenBlock, otherwise: elseBlock, span: stmt.span });

    this.switchTo(thenBlock);
    const thenValue = this.tailValue(stmt.then);
    const thenEnd = this.current;
    const thenOpen = !this.isTerminated(thenEnd);
    if (thenOpen) this.terminate({ op: "jump", target: joinBlock, span: stmt.span });

    this.switchTo(elseBlock);
    const elseValue = this.tailValue(otherwise);
    const elseEnd = this.current;
    const elseOpen = !this.isTerminated(elseEnd);
    if (elseOpen) this.terminate({ op: "jump", target: joinBlock, span: stmt.span });

    this.switchTo(joinBlock);

    // Collect only the arms that reach the join *and* produced a value; a phi
    // whose sources do not match the predecessors would break SSA.
    const sources: Array<{ block: BlockId; value: ValueId }> = [];
    if (thenOpen && thenValue !== null) sources.push({ block: thenEnd, value: thenValue });
    if (elseOpen && elseValue !== null) sources.push({ block: elseEnd, value: elseValue });

    if (sources.length === 0) return null;
    if (sources.length === 1) return sources[0].value;

    const ty = this.types.get(sources[0].value) ?? this.fn.ret;
    const dst = this.freshValue(ty);
    this.emit({ op: "phi", dst, sources, ty, span: stmt.span });
    return dst;
  }

  private newBlock(): BlockId {
    const id = this.nextBlock++;
    this.blocks.set(id, {
      id,
      instrs: [],
      terminator: { op: "unreachable", span: this.fn.span },
      preds: [],
    });
    this.blockVars.set(id, new Map());
    return id;
  }

  private switchTo(block: BlockId): void {
    this.current = block;
  }

  private emit(instr: MirInstr): void {
    const block = this.blocks.get(this.current)!;
    if (this.isTerminated(this.current)) return; // dead code after a return
    block.instrs.push(instr);
  }

  private terminate(term: MirTerminator): void {
    const block = this.blocks.get(this.current)!;
    if (block.terminator.op !== "unreachable") return;
    block.terminator = term;
    // Record predecessors for the CFG.
    const successors =
      term.op === "jump" ? [term.target] : term.op === "branch" ? [term.then, term.otherwise] : [];
    for (const succ of successors) {
      const target = this.blocks.get(succ);
      if (target && !target.preds.includes(this.current)) target.preds.push(this.current);
    }
  }

  private isTerminated(block: BlockId): boolean {
    return this.blocks.get(block)!.terminator.op !== "unreachable";
  }

  // ------------------------------------------------------------- values

  private freshValue(ty: Ty): ValueId {
    const id = this.nextValue++;
    this.types.set(id, ty);
    return id;
  }

  private setVar(name: string, value: ValueId): void {
    this.blockVars.get(this.current)!.set(name, value);
  }

  private getVar(name: string): ValueId | null {
    // Search the current block, then walk predecessors (single-pred chains only;
    // real merges are handled by explicit phis at join points).
    const seen = new Set<BlockId>();
    const walk = (block: BlockId): ValueId | null => {
      if (seen.has(block)) return null;
      seen.add(block);
      const found = this.blockVars.get(block)?.get(name);
      if (found !== undefined) return found;
      const preds = this.blocks.get(block)?.preds ?? [];
      for (const pred of preds) {
        const value = walk(pred);
        if (value !== null) return value;
      }
      return null;
    };
    return walk(this.current);
  }

  private emitConst(value: MirConst, ty: Ty, span: Span): ValueId {
    const dst = this.freshValue(ty);
    this.emit({ op: "const", dst, value, ty, span });
    return dst;
  }

  // ------------------------------------------------------------- regions

  private pushRegion(): void {
    this.regionBindings.push([]);
  }

  private popRegion(): Array<{ name: string; value: ValueId; ty: Ty }> {
    const bindings = this.regionBindings.pop() ?? [];
    // Reverse declaration order, matching the ownership drop schedule.
    return [...bindings].reverse();
  }

  private emitDrop(binding: { name: string; value: ValueId; ty: Ty }): void {
    this.emit({ op: "drop", value: binding.value, variable: binding.name, span: this.fn.span });
  }

  private declareBinding(name: string, value: ValueId, ty: Ty): void {
    this.setVar(name, value);
    if (classify(ty) === "affine" && this.regionBindings.length > 0) {
      this.regionBindings[this.regionBindings.length - 1].push({ name, value, ty });
    }
  }

  // ------------------------------------------------------------- statements

  private block(block: HirBlock): void {
    for (const stmt of block.body) {
      if (this.isTerminated(this.current)) break;
      this.stmt(stmt);
    }
  }

  private stmt(stmt: HirStmt): void {
    switch (stmt.kind) {
      case "Let": {
        const value = this.expr(stmt.value);
        this.declareBinding(stmt.name, value, stmt.ty);
        break;
      }

      case "ExprStmt":
        this.expr(stmt.expr);
        break;

      case "Return": {
        const value = stmt.value ? this.expr(stmt.value) : null;
        // Drops for all open regions run before the return.
        for (let i = this.regionBindings.length - 1; i >= 0; i--) {
          for (const binding of [...this.regionBindings[i]].reverse()) this.emitDrop(binding);
        }
        this.terminate({ op: "return", value, span: stmt.span });
        break;
      }

      case "IfStmt": {
        const cond = this.expr(stmt.cond);
        const thenBlock = this.newBlock();
        const elseBlock = this.newBlock();
        const joinBlock = this.newBlock();
        this.terminate({ op: "branch", cond, then: thenBlock, otherwise: elseBlock, span: stmt.span });

        // Snapshot the variable state so the merge can see both versions.
        const beforeVars = this.captureVars();

        this.switchTo(thenBlock);
        this.pushRegion();
        this.block(stmt.then);
        for (const drop of this.popRegion()) this.emitDrop(drop);
        const thenVars = this.captureVars();
        const thenEnd = this.current;
        if (!this.isTerminated(this.current)) {
          this.terminate({ op: "jump", target: joinBlock, span: stmt.span });
        }

        this.switchTo(elseBlock);
        this.restoreVars(beforeVars);
        this.pushRegion();
        if (stmt.otherwise) this.block(stmt.otherwise);
        for (const drop of this.popRegion()) this.emitDrop(drop);
        const elseVars = this.captureVars();
        const elseEnd = this.current;
        if (!this.isTerminated(this.current)) {
          this.terminate({ op: "jump", target: joinBlock, span: stmt.span });
        }

        this.switchTo(joinBlock);
        this.mergeVars(
          [
            { block: thenEnd, vars: thenVars, live: this.blocks.get(joinBlock)!.preds.includes(thenEnd) },
            { block: elseEnd, vars: elseVars, live: this.blocks.get(joinBlock)!.preds.includes(elseEnd) },
          ],
          stmt.span,
        );
        break;
      }

      case "While": {
        const headerBlock = this.newBlock();
        const bodyBlock = this.newBlock();
        const exitBlock = this.newBlock();

        this.terminate({ op: "jump", target: headerBlock, span: stmt.span });
        const beforeVars = this.captureVars();

        // Header: evaluate the condition and branch.
        this.switchTo(headerBlock);
        this.restoreVars(beforeVars);
        // Loop-carried variables need phis; a mutable variable assigned in the
        // body must read the *latest* version on each iteration.
        const carried = this.loopCarriedVars(stmt.body, beforeVars);
        const phiPlaceholders = new Map<string, ValueId>();
        for (const [name, incoming] of carried) {
          const ty = this.types.get(incoming) ?? T.unknown;
          const dst = this.freshValue(ty);
          this.emit({
            op: "phi",
            dst,
            sources: [{ block: this.previousBlockOf(headerBlock), value: incoming }],
            ty,
            span: stmt.span,
          });
          phiPlaceholders.set(name, dst);
          this.setVar(name, dst);
        }

        const cond = this.expr(stmt.cond);
        this.terminate({ op: "branch", cond, then: bodyBlock, otherwise: exitBlock, span: stmt.span });
        const headerEnd = this.current;

        // Body.
        this.switchTo(bodyBlock);
        this.loops.push({ breakTarget: exitBlock, continueTarget: headerBlock });
        this.pushRegion();
        this.block(stmt.body);
        for (const drop of this.popRegion()) this.emitDrop(drop);
        this.loops.pop();
        const bodyEnd = this.current;
        if (!this.isTerminated(this.current)) {
          this.terminate({ op: "jump", target: headerBlock, span: stmt.span });
          // Complete the phis with the value flowing back from the body.
          for (const [name, phiValue] of phiPlaceholders) {
            const latest = this.blockVars.get(bodyEnd)?.get(name) ?? this.getVarIn(bodyEnd, name);
            if (latest !== null && latest !== phiValue) {
              const phi = this.findPhi(headerBlock, phiValue);
              if (phi) phi.sources.push({ block: bodyEnd, value: latest });
            }
          }
        }

        this.switchTo(exitBlock);
        // After the loop, variables hold their phi values.
        this.restoreVars(this.blockVars.get(headerEnd) ?? new Map());
        break;
      }

      case "Block":
        this.pushRegion();
        this.block(stmt);
        for (const drop of this.popRegion()) this.emitDrop(drop);
        break;

      case "Break": {
        const loop = this.loops[this.loops.length - 1];
        if (loop) this.terminate({ op: "jump", target: loop.breakTarget, span: stmt.span });
        break;
      }

      case "Continue": {
        const loop = this.loops[this.loops.length - 1];
        if (loop) this.terminate({ op: "jump", target: loop.continueTarget, span: stmt.span });
        break;
      }
    }
  }

  /** Variables assigned inside a loop body that already exist outside it. */
  private loopCarriedVars(body: HirBlock, outer: Map<string, ValueId>): Map<string, ValueId> {
    const assigned = new Set<string>();
    const visitExpr = (expr: HirExpr): void => {
      if (expr.kind === "Assign" && expr.place.kind === "Var") assigned.add(expr.place.name);
      switch (expr.kind) {
        case "List":
          expr.items.forEach(visitExpr);
          break;
        case "Unary":
          visitExpr(expr.operand);
          break;
        case "Binary":
          visitExpr(expr.left);
          visitExpr(expr.right);
          break;
        case "Call":
          visitExpr(expr.callee);
          expr.args.forEach(visitExpr);
          break;
        case "Field":
          visitExpr(expr.object);
          break;
        case "Index":
          visitExpr(expr.object);
          visitExpr(expr.index);
          break;
        case "Assign":
          visitExpr(expr.value);
          break;
        case "If":
          visitExpr(expr.cond);
          visitExpr(expr.then);
          visitExpr(expr.otherwise);
          break;
        default:
          break;
      }
    };
    const visitStmt = (stmt: HirStmt): void => {
      switch (stmt.kind) {
        case "Let":
          visitExpr(stmt.value);
          break;
        case "ExprStmt":
          visitExpr(stmt.expr);
          break;
        case "Return":
          if (stmt.value) visitExpr(stmt.value);
          break;
        case "IfStmt":
          visitExpr(stmt.cond);
          stmt.then.body.forEach(visitStmt);
          stmt.otherwise?.body.forEach(visitStmt);
          break;
        case "While":
          visitExpr(stmt.cond);
          stmt.body.body.forEach(visitStmt);
          break;
        case "Block":
          stmt.body.forEach(visitStmt);
          break;
        default:
          break;
      }
    };
    body.body.forEach(visitStmt);

    const carried = new Map<string, ValueId>();
    for (const name of assigned) {
      const outerValue = outer.get(name);
      if (outerValue !== undefined) carried.set(name, outerValue);
    }
    return carried;
  }

  private previousBlockOf(block: BlockId): BlockId {
    const preds = this.blocks.get(block)?.preds ?? [];
    return preds.length > 0 ? preds[0] : this.blocks.get(block)!.id;
  }

  private findPhi(block: BlockId, dst: ValueId): (MirInstr & { op: "phi" }) | null {
    for (const instr of this.blocks.get(block)?.instrs ?? []) {
      if (instr.op === "phi" && instr.dst === dst) return instr;
    }
    return null;
  }

  private captureVars(): Map<string, ValueId> {
    // Flatten the visible variable state of the current block chain.
    const flat = new Map<string, ValueId>();
    const collect = (block: BlockId, seen: Set<BlockId>): void => {
      if (seen.has(block)) return;
      seen.add(block);
      for (const pred of this.blocks.get(block)?.preds ?? []) collect(pred, seen);
      for (const [name, value] of this.blockVars.get(block) ?? []) flat.set(name, value);
    };
    collect(this.current, new Set());
    return flat;
  }

  private restoreVars(vars: Map<string, ValueId>): void {
    const target = this.blockVars.get(this.current)!;
    for (const [name, value] of vars) target.set(name, value);
  }

  private getVarIn(block: BlockId, name: string): ValueId | null {
    const seen = new Set<BlockId>();
    const walk = (b: BlockId): ValueId | null => {
      if (seen.has(b)) return null;
      seen.add(b);
      const found = this.blockVars.get(b)?.get(name);
      if (found !== undefined) return found;
      for (const pred of this.blocks.get(b)?.preds ?? []) {
        const value = walk(pred);
        if (value !== null) return value;
      }
      return null;
    };
    return walk(block);
  }

  /** Insert phis for variables whose definition differs across incoming paths. */
  private mergeVars(
    incoming: Array<{ block: BlockId; vars: Map<string, ValueId>; live: boolean }>,
    span: Span,
  ): void {
    const live = incoming.filter((i) => i.live);
    if (live.length === 0) return;
    if (live.length === 1) {
      this.restoreVars(live[0].vars);
      return;
    }

    const names = new Set<string>();
    for (const path of live) for (const name of path.vars.keys()) names.add(name);

    for (const name of names) {
      const values = live.map((path) => ({ block: path.block, value: path.vars.get(name) }));
      if (values.some((v) => v.value === undefined)) continue;
      const distinct = new Set(values.map((v) => v.value));
      if (distinct.size === 1) {
        this.setVar(name, values[0].value!);
        continue;
      }
      const ty = this.types.get(values[0].value!) ?? T.unknown;
      const dst = this.freshValue(ty);
      this.emit({
        op: "phi",
        dst,
        sources: values.map((v) => ({ block: v.block, value: v.value! })),
        ty,
        span,
      });
      this.setVar(name, dst);
    }
  }

  // ------------------------------------------------------------- expressions

  private expr(expr: HirExpr): ValueId {
    switch (expr.kind) {
      case "Const": {
        const value: MirConst =
          typeof expr.value === "number"
            ? expr.ty.k === "Int"
              ? { k: "int", value: expr.value }
              : { k: "float", value: expr.value }
            : typeof expr.value === "string"
              ? { k: "str", value: expr.value }
              : typeof expr.value === "boolean"
                ? { k: "bool", value: expr.value }
                : { k: "unit" };
        return this.emitConst(value, expr.ty, expr.span);
      }

      case "Var": {
        const found = this.getVar(expr.name);
        if (found !== null) return found;
        // An unbound name is either a runtime namespace (`rng`, `Money`, …) or a
        // field of the enclosing `game` block (`bet`, `strip`, `weights`), which
        // reads as an implicit `self.field`. Distinguishing them here lets a
        // backend resolve a game field from module data instead of treating it as
        // an unknown host import.
        const kind = this.gameFields.has(expr.name) ? "gamefield" : "namespace";
        const dst = this.freshValue(expr.ty);
        this.emit({
          op: "call",
          dst,
          callee: `intrinsic.load:${expr.name}`,
          args: [],
          effects: [],
          ty: expr.ty,
          span: expr.span,
          intrinsicKind: kind,
        } as MirInstr & { op: "call" });
        this.setVar(expr.name, dst);
        return dst;
      }

      case "List": {
        const items = expr.items.map((item) => this.expr(item));
        const dst = this.freshValue(expr.ty);
        this.emit({ op: "list", dst, items, ty: expr.ty, span: expr.span });
        return dst;
      }

      case "Unary": {
        const operand = this.expr(expr.operand);
        const dst = this.freshValue(expr.ty);
        this.emit({ op: "unary", dst, kind: expr.op, operand, ty: expr.ty, span: expr.span });
        return dst;
      }

      case "Binary": {
        // `and`/`or` short-circuit, so they become control flow rather than a
        // single instruction; otherwise the right operand would always evaluate.
        if (expr.op === "and" || expr.op === "or") return this.shortCircuit(expr);
        const lhs = this.expr(expr.left);
        const rhs = this.expr(expr.right);
        const dst = this.freshValue(expr.ty);
        this.emit({ op: "binary", dst, kind: expr.op, lhs, rhs, ty: expr.ty, span: expr.span });
        return dst;
      }

      case "Call": {
        // Normalize builtin method calls (`x.len()`, `s.upper()`, `xs.push(v)`, …)
        // into the same MIR builtin call shape as the free function `len(x)`.
        // The receiver is implicit in source syntax but backends need it as an
        // explicit operand to emit a real runtime instruction.
        const methodField = methodBuiltinField(expr);
        const receiver = methodField ? this.expr(methodField.object) : null;
        const args = receiver === null
          ? expr.args.map((arg) => this.expr(arg))
          : [receiver, ...expr.args.map((arg) => this.expr(arg))];
        const argTypes = receiver === null
          ? expr.args.map((arg) => arg.ty)
          : [methodField!.object.ty, ...expr.args.map((arg) => arg.ty)];
        const callee =
          methodField !== null
            ? builtinMethodSymbol(methodField.name)
            : this.calleeSymbol(expr, argTypes);
        const dst = this.freshValue(expr.ty);
        this.emit({ op: "call", dst, callee, args, effects: [...expr.effects], ty: expr.ty, span: expr.span });
        return dst;
      }

      case "Field": {
        const object = this.expr(expr.object);
        const dst = this.freshValue(expr.ty);
        this.emit({ op: "field", dst, object, name: expr.name, ty: expr.ty, span: expr.span });
        return dst;
      }

      case "Index": {
        const object = this.expr(expr.object);
        const index = this.expr(expr.index);
        const dst = this.freshValue(expr.ty);
        this.emit({ op: "index", dst, object, index, ty: expr.ty, span: expr.span });
        return dst;
      }

      case "Assign": {
        const value = this.expr(expr.value);
        if (expr.place.kind === "Var") {
          // SSA: assignment rebinds the name to a new value, no store needed.
          this.setVar(expr.place.name, value);
          return value;
        }
        if (expr.place.kind === "Index") {
          const object = this.expr(expr.place.object);
          const index = this.expr(expr.place.index);
          this.emit({ op: "store", object, index, field: null, value, span: expr.span });
          return value;
        }
        const object = this.expr(expr.place.object);
        this.emit({ op: "store", object, index: null, field: expr.place.name, value, span: expr.span });
        return value;
      }

      case "Closure": {
        // Closures are lifted by name; the body was already lowered as its own
        // function when the module was built.
        const dst = this.freshValue(expr.ty);
        this.emit({ op: "call", dst, callee: "intrinsic.closure", args: [], effects: [], ty: expr.ty, span: expr.span });
        return dst;
      }

      case "If": {
        const cond = this.expr(expr.cond);
        const thenBlock = this.newBlock();
        const elseBlock = this.newBlock();
        const joinBlock = this.newBlock();
        this.terminate({ op: "branch", cond, then: thenBlock, otherwise: elseBlock, span: expr.span });

        this.switchTo(thenBlock);
        const thenValue = this.expr(expr.then);
        const thenEnd = this.current;
        this.terminate({ op: "jump", target: joinBlock, span: expr.span });

        this.switchTo(elseBlock);
        const elseValue = this.expr(expr.otherwise);
        const elseEnd = this.current;
        this.terminate({ op: "jump", target: joinBlock, span: expr.span });

        this.switchTo(joinBlock);
        const dst = this.freshValue(expr.ty);
        this.emit({
          op: "phi",
          dst,
          sources: [
            { block: thenEnd, value: thenValue },
            { block: elseEnd, value: elseValue },
          ],
          ty: expr.ty,
          span: expr.span,
        });
        return dst;
      }

      case "BlockExpr": {
        this.pushRegion();
        for (const stmt of expr.body) this.stmt(stmt);
        for (const drop of this.popRegion()) this.emitDrop(drop);
        return this.emitConst({ k: "unit" }, T.unit, expr.span);
      }
    }
  }

  /** `a and b` / `a or b` with proper short-circuit semantics. */
  private shortCircuit(expr: HirExpr & { kind: "Binary" }): ValueId {
    const lhs = this.expr(expr.left);
    const rhsBlock = this.newBlock();
    const joinBlock = this.newBlock();

    if (expr.op === "and") {
      this.terminate({ op: "branch", cond: lhs, then: rhsBlock, otherwise: joinBlock, span: expr.span });
    } else {
      this.terminate({ op: "branch", cond: lhs, then: joinBlock, otherwise: rhsBlock, span: expr.span });
    }
    const shortBlock = this.current;

    this.switchTo(rhsBlock);
    const rhs = this.expr(expr.right);
    const rhsEnd = this.current;
    this.terminate({ op: "jump", target: joinBlock, span: expr.span });

    this.switchTo(joinBlock);
    const dst = this.freshValue(T.bool);
    this.emit({
      op: "phi",
      dst,
      sources: [
        { block: shortBlock, value: lhs },
        { block: rhsEnd, value: rhs },
      ],
      ty: T.bool,
      span: expr.span,
    });
    return dst;
  }

  private calleeSymbol(expr: HirExpr & { kind: "Call" }, argTypes: Ty[]): string {
    if (expr.callee.kind === "Var") {
      return this.symbolFor(expr.callee.name, argTypes);
    }
    if (expr.callee.kind === "Field") {
      const base =
        expr.callee.object.kind === "Var" ? expr.callee.object.name : `<${expr.callee.object.kind}>`;
      return `${base}.${expr.callee.name}`;
    }
    return "intrinsic.dynamic";
  }
}

/** Names that resolve to builtins or runtime intrinsics, never monomorphized. */
const BUILTINS = new Set([
  "print",
  "println",
  "len",
  "abs",
  "min",
  "max",
  "floor",
  "round",
  "sqrt",
  "str",
  "int",
  "float",
  "range",
  "assert",
  "sum",
  "push",
]);

/**
 * Builtin methods on primitive receivers.
 *
 * Key: the method name written in source (`xs.push(v)`).
 * Value: the MIR builtin symbol every backend lowers, and the receiver-inclusive
 * arity so the checker's shape survives into the IR.
 *
 * These mirror `Interpreter.builtinMethod`, so the tree-walking interpreter, the
 * bytecode VM and the native backends agree on semantics.
 */
export const BUILTIN_METHODS: ReadonlyMap<string, { symbol: string; arity: number }> = new Map([
  // list + string
  ["len", { symbol: "len", arity: 1 }],
  ["contains", { symbol: "contains", arity: 2 }],
  ["slice", { symbol: "slice", arity: 3 }],
  ["reverse", { symbol: "reverse", arity: 1 }],
  ["indexOf", { symbol: "indexOf", arity: 2 }],
  ["concat", { symbol: "concat", arity: 2 }],
  ["toString", { symbol: "str", arity: 1 }],
  // list only
  ["push", { symbol: "push", arity: 2 }],
  ["pop", { symbol: "pop", arity: 1 }],
  ["first", { symbol: "first", arity: 1 }],
  ["last", { symbol: "last", arity: 1 }],
  ["count", { symbol: "count", arity: 2 }],
  ["join", { symbol: "join", arity: 2 }],
  ["take", { symbol: "take", arity: 2 }],
  ["sum", { symbol: "sum", arity: 1 }],
  // string only
  ["upper", { symbol: "upper", arity: 1 }],
  ["lower", { symbol: "lower", arity: 1 }],
  ["toUpper", { symbol: "upper", arity: 1 }],
  ["toLower", { symbol: "lower", arity: 1 }],
  ["trim", { symbol: "trim", arity: 1 }],
  ["split", { symbol: "split", arity: 2 }],
  ["chars", { symbol: "chars", arity: 1 }],
  // numeric
  ["abs", { symbol: "abs", arity: 1 }],
  ["round", { symbol: "round", arity: 1 }],
  ["floor", { symbol: "floor", arity: 1 }],
  ["toInt", { symbol: "int", arity: 1 }],
  ["toFloat", { symbol: "float", arity: 1 }],
]);

/** MIR builtin symbol for a source-level method name. */
export function builtinMethodSymbol(method: string): string {
  return BUILTIN_METHODS.get(method)?.symbol ?? method;
}

/**
 * The `Field` callee of a call that is a builtin method on a primitive receiver.
 *
 * Returns null for ordinary member calls (`game.spin()`, `Fair.begin()`) and for
 * calls whose receiver is a namespace, so module-qualified calls keep their
 * existing `Base.method` symbol.
 */
function methodBuiltinField(
  expr: HirExpr & { kind: "Call" },
): (HirExpr & { kind: "Field" }) | null {
  if (expr.callee.kind !== "Field") return null;
  const spec = BUILTIN_METHODS.get(expr.callee.name);
  if (!spec) return null;
  // Receiver + explicit arguments must match the builtin's shape.
  if (expr.args.length + 1 !== spec.arity) {
    // `slice(start)` and `join()` are legal with one argument fewer.
    if (expr.args.length + 1 !== spec.arity - 1) return null;
  }
  const object = expr.callee.object;
  // A capitalised bare name is a namespace (`Math.abs`), not a value receiver.
  if (object.kind === "Var" && /^[A-Z]/.test(object.name)) return null;
  return expr.callee;
}

/**
 * Build a SunMIR module.
 *
 * `ownership` supplies the drop schedule. It is optional so MIR can still be
 * produced for a program whose ownership check failed, which is what lets the
 * CLI show MIR alongside errors.
 */
export function buildMir(module: HirModule, ownership?: OwnershipResult): MirModule {
  const instantiations: MirModule["instantiations"] = [];
  const declared = new Map(module.functions.map((fn) => [fn.name, fn]));
  const symbolCache = new Map<string, string>();

  /**
   * Monomorphic symbol for a call.
   *
   * A function used at one type keeps its plain name (the common case, and it
   * keeps the IR readable). A second, different argument-type tuple gets a
   * suffixed symbol and is logged as an instantiation.
   */
  const symbolFor = (name: string, argTypes: Ty[]): string => {
    if (BUILTINS.has(name)) return name;
    if (!declared.has(name)) return name;
    const signature = argTypes.map((t) => tyName(t)).join(",");
    const key = `${name}(${signature})`;
    const cached = symbolCache.get(key);
    if (cached) return cached;

    const existingForName = [...symbolCache.keys()].filter((k) => k.startsWith(`${name}(`));
    const symbol =
      existingForName.length === 0
        ? name
        : `${name}$${argTypes.map((t) => tyName(t).replace(/[^A-Za-z0-9]/g, "_")).join("_") || "unit"}`;
    symbolCache.set(key, symbol);
    if (symbol !== name) {
      instantiations.push({ symbol, from: name, types: argTypes.map((t) => tyName(t)) });
    }
    return symbol;
  };

  // Pre-seed each declared function's own symbol from its declared parameters so
  // its definition and its call sites agree.
  for (const fn of module.functions) {
    symbolFor(fn.name, fn.params.map((p) => p.ty));
  }

  // Field and reel names per game, so a method body can tell an implicit
  // `self.field` read apart from a runtime namespace handle.
  const gameMembers = new Map<string, Set<string>>();
  for (const game of module.games) {
    const names = new Set<string>();
    for (const field of game.fields) names.add(field.name);
    for (const reel of game.reels) names.add(reel.name);
    gameMembers.set(game.name, names);
  }

  const functions = module.functions.map((fn) =>
    new FunctionBuilder(
      fn,
      symbolFor,
      (fn.owner !== null ? gameMembers.get(fn.owner) : undefined) ?? new Set<string>(),
    ).build(),
  );

  // Top-level statements become a synthetic `@main` so the whole module is MIR.
  if (module.main.length > 0) {
    const topLevel: HirFn = {
      kind: "Fn",
      name: "@toplevel",
      params: [],
      ret: T.unit,
      effects: [],
      attributes: [],
      body: { kind: "Block", body: module.main, span: module.span },
      owner: null,
      isPublic: false,
      span: module.span,
    };
    functions.push(new FunctionBuilder(topLevel, symbolFor).build());
  }

  const games = module.games.map((game) => ({
    name: game.name,
    fields: game.fields.map((f) => ({ name: f.name, value: constOf(f.value) })),
    reels: game.reels.map((r) => ({
      name: r.name,
      symbols: r.symbols.kind === "List" ? r.symbols.items.map((i) => String(constValue(i) ?? "?")) : [],
      weights:
        r.weights && r.weights.kind === "List"
          ? r.weights.items.map((i) => Number(constValue(i) ?? 0))
          : null,
    })),
    methods: [...game.methods],
  }));

  return { file: module.file, functions, games, instantiations };
}

function constOf(expr: HirExpr): MirConst | null {
  if (expr.kind !== "Const") return null;
  if (typeof expr.value === "number") {
    return expr.ty.k === "Int" ? { k: "int", value: expr.value } : { k: "float", value: expr.value };
  }
  if (typeof expr.value === "string") return { k: "str", value: expr.value };
  if (typeof expr.value === "boolean") return { k: "bool", value: expr.value };
  return { k: "unit" };
}

function constValue(expr: HirExpr): string | number | boolean | null {
  return expr.kind === "Const" ? expr.value : null;
}
