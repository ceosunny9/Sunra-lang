# Sunra Language Specification (Version 0.2.0)

Prepared with AI assistance.
Scope: Formal grammar, type system, operational semantics, and effect system for the Sunra gaming programming language ecosystem [1].

---

## 1. Abstract Syntax & BNF Grammar

Sunra syntax supports both traditional brace-delimited blocks `{ ... }` and canonical indentation-based layout blocks.

```ebnf
Program         ::= ( Stmt )* Eof
Stmt            ::= ModuleStmt | UseStmt | FnDecl | GameDecl | TypeDecl | TestDecl | LetStmt | AssignStmt | IfStmt | WhileStmt | ForStmt | ReturnStmt | AssertStmt | ExprStmt
FnDecl          ::= [Attributes] [Intent] [pub] "fn" Ident "(" [ParamList] ")" [ "->" TypeNode ] [ "uses" EffectList ] BlockStmt
GameDecl        ::= [Attributes] "game" Ident "{" ( GameMember )* "}"
GameMember      ::= [Attributes] [Intent] ( FnDecl | ReelDecl | FieldAssign )
ReelDecl        ::= "reel" Ident "=" Expr [ "weights" "=" Expr ]
TypeDecl        ::= "type" Ident "=" ( TypeNode | "enum" ( IndentedVariants | BracketedVariants ) )
LetStmt         ::= ( "let" | "var" | "const" ) Ident [ ":" TypeNode ] "=" Expr
Expr            ::= Assignment | Pipeline | Range | Binary | Unary | Postfix | Primary
Primary         ::= IntLit | FloatLit | StrLit | BoolLit | Ident | ListLit | Lambda | IfExpr | MatchExpr
```

---

## 2. Type System & Judgements

Sunra features static typing with optional annotations. Primitives include `Int`, `Float`, `Str`, `Bool`, `Unit`, `Money`, and parameterized `List[T]`.

### Core Judgements
$$\Gamma \vdash e : \tau$$

$$\frac{\Gamma(x) = \tau}{\Gamma \vdash x : \tau} \quad (\text{T-Var})$$

$$\frac{\Gamma \vdash e_1 : \text{Money} \quad \Gamma \vdash e_2 : \text{Money}}{\Gamma \vdash e_1 + e_2 : \text{Money}} \quad (\text{T-MoneyAdd})$$

Mixing `Money` and `Float` directly without explicit conversion is rejected by the checker with code `E0731`.

---

## 3. Operational Semantics

Evaluation proceeds under environment $\sigma$ and store $\mu$. Statement execution maps $(\sigma, \mu, s) \longrightarrow (\sigma', \mu', \nu)$.

$$\frac{\Gamma \vdash e_1 \Downarrow v_1 \quad \Gamma \vdash e_2 \Downarrow v_2 \quad v = v_1 + v_2}{\Gamma \vdash e_1 + e_2 \Downarrow v} \quad (\text{E-Add})$$

$$\frac{\text{steps} > \text{stepLimit}}{\text{Interpreter} \vdash \text{loop} \Downarrow \text{Error}(\text{E0900})} \quad (\text{E-StepLimit})$$

---

## 4. Effect System

Every function explicitly declares the capabilities it exercises via the `uses` clause. Known effects include `rand`, `io`, `net`, `db`, `money`, `ai`, `chain`, `audit`, and `unsafe`.

$$\frac{\text{effects}(f) \subseteq \text{declared}(f)}{\Gamma \vdash \text{Call}(f) \text{ ok}} \quad (\text{T-Effect})$$

If a function invokes `rng.pick()` but omits `uses rand`, the checker emits error `E0615`, making undeclared randomness a compile-time blocker.

---

## References

[1] Sunra Language Ecosystem Documentation & Whitepaper, SunCore Labs LLC, 2026.
