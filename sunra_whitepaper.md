# Sunra

### A Provably Fair, AI-Native Systems Language for Interactive Gaming

**Language Design Specification & Technical Whitepaper**

| Field | Value |
| :--- | :--- |
| Document title | Sunra Language Design Specification |
| Version | 0.1 (Design Draft — Pre-Implementation) |
| Status | Request for Comment / Investor Technical Review |
| Date | August 2026 |
| Ecosystem | SuncoreAI |
| Credits | Built with AI assistance |
| Canonical toolchain | `sunc` (compiler), `sun` (toolchain), `.sun` (source extension) |
| Reference implementation | Not yet released; targets described herein are design targets |

> **Reader's note on status.** Sunra is a language design, not a shipped compiler. Every performance number, safety guarantee, and tooling behaviour described in this document is stated as an *engineering target derived from the design*, and each is paired with the mechanism that is expected to deliver it. Where a claim depends on an unproven implementation, the document says so explicitly. This honesty is deliberate: a language whose central promise is *provability* cannot begin its life with unprovable marketing.

---

## Table of Contents

1. [บทสรุปผู้บริหาร (Thai Executive Summary)](#1-บทสรุปผู้บริหาร-thai-executive-summary)
2. [Executive Summary (English)](#2-executive-summary-english)
3. [Vision and Philosophy](#3-vision-and-philosophy)
4. [Language Design](#4-language-design)
5. [Built-in Gaming Primitives](#5-built-in-gaming-primitives)
6. [AI Integration](#6-ai-integration)
7. [Worked Code Examples](#7-worked-code-examples)
8. [Compiler Architecture](#8-compiler-architecture)
9. [Standard Library](#9-standard-library)
10. [Roadmap: Phase 1 to Phase 5](#10-roadmap-phase-1-to-phase-5)
11. [Comparison With Existing Languages](#11-comparison-with-existing-languages)
12. [Risks, Open Questions, and Non-Goals](#12-risks-open-questions-and-non-goals)
13. [Business Model and Ecosystem Position](#13-business-model-and-ecosystem-position)
14. [Appendices](#14-appendices)
15. [References](#15-references)

---

## 1. บทสรุปผู้บริหาร (Thai Executive Summary)

**Sunra** คือภาษาโปรแกรมใหม่ที่ออกแบบมาเพื่อแก้ปัญหาเฉพาะเจาะจงหนึ่งข้อที่อุตสาหกรรมเกมและเกมเดิมพันออนไลน์เผชิญอยู่ทุกวัน นั่นคือ **ปัจจุบันยังไม่มีภาษาโปรแกรมใดที่เข้าใจว่า "ความเป็นธรรมของเกม" คือคุณสมบัติที่ต้องพิสูจน์ได้ตั้งแต่ตอนคอมไพล์** ทีมพัฒนาเกมสล็อตในวันนี้ต้องเขียนตรรกะของเกมด้วยภาษาทั่วไป (C++, C#, TypeScript, Lua) แล้วค่อยพิสูจน์ค่า RTP ด้วยสเปรดชีตแยก ส่งไปให้ห้องแล็บภายนอกรับรองอีกหลายสัปดาห์ และหวังว่าโค้ดที่ deploy จริงจะตรงกับเอกสารคณิตศาสตร์ที่ยื่นไป ช่องว่างระหว่าง "โมเดลคณิตศาสตร์" กับ "โค้ดที่รันจริง" คือแหล่งกำเนิดของต้นทุน ความเสี่ยงด้านกฎระเบียบ และความไม่เชื่อมั่นของผู้เล่นทั้งหมด

Sunra ปิดช่องว่างนั้นด้วยการยกแนวคิดของโดเมนเกมขึ้นมาเป็นส่วนหนึ่งของ **ระบบชนิดข้อมูล (type system)** โดยตรง ในภาษา Sunra สิ่งต่อไปนี้ไม่ใช่ไลบรารีที่แนบมาภายหลัง แต่เป็นสิ่งที่คอมไพเลอร์รู้จักและตรวจสอบได้เอง ได้แก่ ชุดวงล้อและตารางสัญลักษณ์ (reel strips), เส้นรางวัล (paylines), แหล่งสุ่มที่ตรวจสอบย้อนหลังได้ (verifiable RNG), พิธีการ commit–reveal สำหรับ provably fair, หน่วยเงินแบบทศนิยมตรึงตำแหน่ง (fixed-point money) ที่ห้ามใช้ทศนิยมลอยตัว และที่สำคัญที่สุดคือ **ค่า RTP และความผันผวน (volatility) ที่คอมไพเลอร์คำนวณและตรวจสอบให้ในขั้นตอน build** หากนักพัฒนาประกาศว่าเกมนี้ต้องมี RTP เท่ากับ 96.50% แล้วแก้ตารางน้ำหนักสัญลักษณ์จนค่าจริงเพี้ยนไป **โปรแกรมจะคอมไพล์ไม่ผ่าน** ไม่ใช่ค้นพบตอนตรวจสอบบัญชีสิ้นเดือน

ในด้านวิศวกรรม Sunra ตั้งเป้าเป็นภาษาที่ **เร็วระดับภาษาเชิงระบบ** โดยคอมไพล์เป็นโค้ดเนทีฟผ่าน LLVM ไม่มี garbage collector ใช้แบบจำลองความเป็นเจ้าของหน่วยความจำ (ownership) ที่อนุมานอายุการใช้งานให้อัตโนมัติ จึงได้ความเร็วแบบ Rust แต่ผู้เขียนแทบไม่ต้องประกาศ lifetime ด้วยมือ ในด้านความง่าย Sunra ใช้ไวยากรณ์ที่สะอาดใกล้เคียง Python ไม่มีเครื่องหมายอัฒภาค อนุมานชนิดข้อมูลให้เกือบทั้งหมด และมีรูปแบบการเขียนที่ถูกต้องเพียงแบบเดียวซึ่งบังคับด้วยตัวจัดรูปแบบมาตรฐาน ในด้านความปลอดภัย Sunra ตัดสาเหตุของข้อผิดพลาดขณะรันออกตั้งแต่ระดับการออกแบบ คือ **ไม่มี null** (ใช้ `Option`), **ไม่มี exception** (ใช้ `Result` และตัวดำเนินการ `!`), เลขคณิตตรวจการล้นค่าเป็นค่าเริ่มต้น, การจับคู่รูปแบบต้องครอบคลุมทุกกรณี และมีระบบติดตามผลข้างเคียง (effect system) ที่ทำให้ฟังก์ชันซึ่งประกาศว่า `pure` ไม่สามารถแอบเรียกแหล่งสุ่มหรือเขียนฐานข้อมูลได้เลย

จุดที่ทำให้ Sunra แตกต่างจากภาษาอื่นที่พยายามทำแบบเดียวกันคือ **การออกแบบให้ AI เป็นผู้ใช้ภาษาระดับเดียวกับมนุษย์** ไวยากรณ์มีรูปแบบตามหลักเกณฑ์เดียว (canonical form) โครงสร้างของโปรแกรมเผยแพร่ออกมาเป็น JSON ที่เครื่องอ่านได้ผ่านรูปแบบกลางชื่อ SAIL ข้อความแจ้งข้อผิดพลาดออกแบบให้เครื่องแยกวิเคราะห์และแก้ไขได้เอง และภาษามีโครงสร้าง `intent` ที่ให้นักพัฒนาเขียนเจตนาเป็นภาษาธรรมชาติแนบไว้กับฟังก์ชัน ซึ่งเครื่องมือ `sunc verify --intent` จะใช้แบบจำลองภาษาร่วมกับการทดสอบเชิงคุณสมบัติเพื่อตรวจว่าโค้ดยังทำตามเจตนานั้นอยู่หรือไม่ ผลลัพธ์ที่ตั้งเป้าคือภาษาที่ AI สร้างโค้ดได้ถูกต้องในอัตราสูงกว่าภาษาทั่วไปอย่างมีนัยสำคัญ เพราะพื้นที่ของโค้ดที่ "คอมไพล์ผ่าน" กับ "ถูกต้องตามกฎของโดเมน" ถูกออกแบบให้ทับกันมากที่สุด

ด้านแผนพัฒนา เอกสารนี้กำหนดห้าเฟส เริ่มจากการวางรากฐานคอมไพเลอร์และไวยากรณ์ ต่อด้วยความปลอดภัยหน่วยความจำและ backend ระดับผลิตภัณฑ์ จากนั้นคือไลบรารีโดเมนเกมและเครื่องมือพิสูจน์ RTP แล้วจึงเป็นชั้น AI-native และปิดท้ายด้วยระบบนิเวศ ทะเบียนแพ็กเกจ backend สำหรับบล็อกเชนที่ใช้พลังงานต่ำ และการรับรองมาตรฐานระดับสากล โมเดลธุรกิจที่เสนอคือ **open-core** กล่าวคือเปิดซอร์สตัวภาษาและคอมไพเลอร์เพื่อสร้างการยอมรับ แล้วสร้างรายได้จากรันไทม์ระดับองค์กร บริการรับรองความเป็นธรรมอัตโนมัติ ทะเบียนแพ็กเกจส่วนตัว และเครื่องมือ AI แบบบอกรับสมาชิก โดยมี SuncoreAI เป็นทั้งผู้ใช้รายแรกและช่องทางกระจายสู่ตลาด

**สรุปในหนึ่งประโยค:** Sunra เสนอให้เปลี่ยนความเป็นธรรมของเกมจาก *เอกสารที่ต้องเชื่อ* ให้กลายเป็น *คุณสมบัติที่คอมไพเลอร์ตรวจสอบและลงลายมือชื่อรับรองได้* และทำสิ่งนั้นในภาษาที่เร็วพอจะรันโปรดักชัน ง่ายพอจะสอนได้ในหนึ่งสัปดาห์ และเป็นระเบียบพอที่ AI จะเขียนได้ดี

---

## 2. Executive Summary (English)

The interactive gaming industry runs on a structural contradiction. The mathematics of a slot machine or a card game is a formal artefact — a weighted probability model with a precisely computable expected return — yet the software that implements that mathematics is written in general-purpose languages that have no concept of a reel strip, a payline, a return-to-player percentage, or a verifiable random source. The consequence is an entire industry of manual reconciliation: a mathematician produces a spreadsheet model, an engineer re-implements it in C++ or TypeScript, an independent test laboratory spends weeks proving that the two agree, and a regulator issues a certificate that expires the moment anyone touches the weight tables. Every step in that chain is human, slow, expensive, and fallible.

**Sunra is a compiled, statically typed, AI-native systems language that moves game fairness from documentation into the type system.** Its central design thesis is that the properties regulators, operators, and players care about most — that the return to player is exactly what was declared, that the random source cannot be tampered with, that money arithmetic never loses a satang, that a given round can be independently replayed and verified — are all properties a compiler can check mechanically if the language is designed to express them. Sunra is that language.

Four commitments define the design. First, **performance without compromise**: ahead-of-time compilation through an LLVM backend, no garbage collector, monomorphized generics, and arena-scoped game rounds that make a spin allocate zero heap memory in the steady state. Second, **clarity as a hard constraint**: a semicolon-free, layout-aware syntax with pervasive type inference that reads close to Python, one canonical formatting for every construct, and a deliberate refusal of the feature accretion that makes systems languages hostile to newcomers. Third, **safety by construction**: no null, no exceptions, no implicit numeric coercion, checked arithmetic by default, exhaustive pattern matching, affine ownership with inferred borrows, and a first-class effect system in which a function's signature states whether it may consume randomness, touch a database, spend money, or call a model. Fourth, **an AI-first surface**: a canonical form that eliminates stylistic ambiguity, a machine-readable intermediate representation (SAIL) exposed as JSON, structured diagnostics designed to be repaired programmatically, typed holes for incremental synthesis, and `intent` blocks that bind a natural-language specification to a function so that a verification pass can detect drift between what a developer said and what the code does.

On top of those foundations Sunra ships a domain layer that no general-purpose language provides. Reel sets, symbol weight tables, paylines, ways and cluster evaluation, card shoes with penetration rules, dice and crash curves, and wheel layouts are language-level or standard-library-level constructs with compiler awareness. Random number generation is an effect, not a function call, and the standard library distinguishes a cryptographically secure source from a reproducible simulation source at the type level so the two can never be confused. Provably fair commit–reveal ceremonies are a built-in protocol with generated verifier artefacts. Most consequentially, **RTP is a compile-time obligation**: a game annotated `#[rtp(target = 0.9650, tolerance = 0.0005)]` is either proven within tolerance by exhaustive enumeration or bounded by a seeded, reproducible Monte Carlo run with a stated confidence interval, and a build that cannot establish the claim fails.

The commercial logic follows from the engineering logic. Certification cost, time-to-market, and regulatory risk are the dominant non-content expenses in game studio operations, and provable fairness is becoming a competitive requirement rather than a differentiator as crypto-native operators normalise player-side verification. A toolchain that compresses the mathematics-to-certificate loop from weeks to minutes, and that emits a signed, machine-checkable fairness report as a build artefact, addresses a cost centre that every operator recognises. Sunra is proposed as **open-core**: the language, compiler, and standard library are open source to win adoption and third-party audit credibility, while revenue derives from an enterprise remote game server runtime, automated certification-as-a-service, a private package registry, and an AI development assistant. SuncoreAI serves as the anchor tenant, first production user, and distribution channel.

The roadmap is deliberately sequenced over five phases and roughly four years, front-loading the boring and unglamorous work — a correct type checker, a fast incremental compiler, a formatter, a language server — because every AI and domain feature described later depends on that foundation being solid. This document specifies the design in full: syntax and semantics, type system, memory and concurrency models, the gaming and AI layers, worked implementations of a slot game, a baccarat table and an on-chain fairness contract, compiler internals, the standard library surface, the phased plan, and an honest comparison against Rust, Python, Solidity, and GDScript, including the cases where each of those languages remains the better choice.

---

## 3. Vision and Philosophy

### 3.1 The problem Sunra exists to solve

A modern slot game is, mathematically, a finite probability space. A five-reel game with a hundred symbols per strip and twenty paylines has a state space that is large but entirely enumerable, and its expected return is a number that can in principle be computed to arbitrary precision. This is unusual and valuable: most software has no closed-form specification of correctness, but a game of chance does. Its correctness condition is a number, and that number is the entire basis of the commercial and regulatory relationship between operator, player, and state.

Nothing in the contemporary toolchain exploits that fact. The mathematics is authored in a spreadsheet or a bespoke simulation script. The game is implemented separately, usually twice — once as a client for presentation and once as a server for authority. The two artefacts are reconciled by an independent test laboratory that runs its own simulation and compares distributions, a process that industry practice measures in weeks and tens of thousands of dollars per title. When the game later needs a jurisdictional variant at a different return level, or a weight table tweak in response to player behaviour, much of that cost recurs. The specification and the implementation are separate documents in different languages, and keeping them synchronised is a permanent human obligation.

The failure modes are well known to anyone who has shipped a real-money game. A float is used where a decimal was required and a rounding error accumulates across millions of rounds. A random source is seeded from wall-clock time in a code path that was supposed to use the secure generator. A feature buy is added and shifts the effective return by forty basis points that nobody notices until a monthly reconciliation. A bonus round's weight table is edited in the server but not in the certified math document. None of these are exotic bugs; they are the predictable outcome of expressing domain-critical invariants in comments and spreadsheets rather than in types.

### 3.2 The thesis

> A language whose type system understands probability, money, randomness, and expected value can mechanically prove the properties that the gaming industry currently pays humans to verify by hand.

This is the whole of Sunra's argument. Everything else in the design — the performance work, the syntax choices, the AI surface — exists to make that thesis usable in production rather than merely true in a paper.

Three corollaries follow. First, **the specification must live in the source**. A declared return-to-player target is not a comment; it is an annotation the compiler is obliged to discharge. A currency is not a float; it is a type with a fixed scale and no lossy conversions. A random draw is not a function call; it is an effect that appears in the signature of every function on the path from the entry point to the draw, so that a reviewer can see at a glance which code can influence an outcome. Second, **the audit artefact must be a build output**. If fairness is a compiler-checked property, then the compiler can emit a signed report — reel tables, computed distribution, expected return with method and confidence, effect inventory, source hash, toolchain version — that an auditor consumes as input rather than reconstructing from scratch. Third, **the language must be pleasant enough that people actually use it**, because a correctness tool that developers route around provides no correctness at all.

### 3.3 The four-way tension, and how Sunra resolves it

The brief for Sunra asks for four things that are conventionally believed to trade off against one another: the speed of Rust, the approachability of Python, comprehensive safety, and fluent machine authorship. The design does not claim to have abolished the trade-offs; it claims that a narrower domain lets them be resolved at a better point than a general-purpose language can reach.

**Speed versus simplicity** is normally mediated by manual memory management. Rust achieves its performance partly by making the programmer an explicit participant in lifetime reasoning, which is also the single largest contributor to its learning curve. Sunra keeps the ownership model — affine values, move semantics, deterministic destruction, no garbage collector — but pushes lifetime reasoning into inference. The mechanism is a region-and-constraint solver rather than a syntax the programmer writes, and the escape hatch of explicit region parameters exists for the small fraction of library code that genuinely needs it. The domain assumption that makes this tractable is that game round logic is overwhelmingly *scoped*: a spin, a hand, a roll is a bounded computation with a clear beginning and end, which maps naturally onto an arena whose lifetime the compiler can see without help.

**Safety versus ergonomics** is normally mediated by ceremony. Sunra's answer is to remove the unsafe constructs entirely rather than to guard them. There is no null to check because there is no null; optionality is `Option[T]` and the compiler will not let it be used as a `T`. There is no exception to catch because errors are values in `Result[T, E]`, propagated with a single-character operator that keeps the happy path visually clean. Integer overflow is a compile error where it can be proven and a typed error where it cannot, never a silent wrap. Pattern matches must be exhaustive. Money cannot be a float — the type system forbids the conversion. The cumulative effect is that the categories of runtime failure that plague real-money systems are either impossible or forced into the open as ordinary, handled values.

**Human clarity versus machine clarity** turns out to be largely a false tension, and this is the design's most interesting bet. The properties that make code easy for a language model to generate correctly are close to the properties that make it easy for a human reviewer: one obvious way to express each idea, no hidden control flow, no implicit conversions, explicit effects, local reasoning, and errors that state precisely what is wrong and what would fix it. Where the two diverge, Sunra resolves in favour of explicitness — for example, effect annotations are mandatory rather than inferred at function boundaries, which costs a human a few keystrokes and gains a model a great deal of context.

### 3.4 Design principles

The following principles are used throughout this document to adjudicate design questions, in priority order. When two principles conflict, the earlier one wins.

| # | Principle | Practical consequence |
| :--- | :--- | :--- |
| 1 | **Provable over plausible** | If a property matters, the compiler checks it. Domain invariants are annotations with proof obligations, not comments. |
| 2 | **One way to do it** | Every construct has a single canonical form, enforced by `sunfmt`. Stylistic freedom is traded for reviewability and model accuracy. |
| 3 | **Errors are values, effects are types** | No hidden control flow, no ambient capability. What a function can do is visible in its signature. |
| 4 | **Zero cost or no feature** | Abstractions must compile to what a competent engineer would write by hand, or they are rejected. |
| 5 | **The domain is first class** | Reels, cards, money, and randomness belong in the language and standard library, not in per-studio ad-hoc code. |
| 6 | **Readable by both audiences** | Source must be comfortable for a junior engineer and unambiguous for a language model. |
| 7 | **Boring where it counts** | No novel type theory in the core, no research-grade features on the critical path. Innovation is spent on the domain layer. |
| 8 | **Auditability is a feature** | Every build can produce a signed, machine-readable account of what it does and why it is fair. |

### 3.5 Goals and explicit non-goals

Sunra targets server-authoritative game logic, mathematical model authoring and simulation, provably fair protocol implementation, remote game server backends, and the small on-chain contracts that publish fairness commitments. Within that scope the aspiration is to be the obvious default.

It is equally important to state what Sunra does not attempt. It is not a general-purpose application language and will not compete with Go or TypeScript for CRUD services. It is not a rendering or presentation language; art, animation, and UI belong in existing engines, and Sunra's WebAssembly target exists to run *logic* in the browser, not to draw. It is not a smart contract platform, and its chain backend deliberately covers only the narrow class of verification contracts. It is not a scripting language for designers to hot-reload at runtime, though an embedded interpreter mode is a Phase 5 consideration. And it is not an attempt to prove full functional correctness of arbitrary programs; the verification ambition is bounded to the domain properties enumerated in this document, which is precisely what makes it achievable.

### 3.6 Why "Sunra"

The name compounds *Sun* with *Ra*, the Egyptian solar deity associated with order, judgement, and the daily re-establishment of cosmic regularity. The association is apt for a language whose purpose is to make randomness accountable: a fair game is not one without chance but one whose chance is lawful and inspectable. The solar motif also carries through the toolchain's naming — the compiler `sunc`, the package registry **Solaris**, the intermediate representation **SAIL** — and situates the language inside the SuncoreAI ecosystem it is built to serve.

---

## 4. Language Design

### 4.1 Surface syntax

Sunra's syntax is designed around a single question: what does a reviewer need to see without scrolling? The answer shaped four decisions. Statements are newline-terminated with no semicolons. Blocks are introduced by a colon and delimited by indentation, as in Python, but the lexer emits explicit block tokens so that tooling and generated code are never whitespace-fragile — a canonical brace form is accepted and `sunfmt` normalises it to layout form. Declarations lead with an intent-bearing keyword (`fn`, `let`, `type`, `trait`, `actor`, `game`) so that the first token of a line tells the reader what kind of thing follows. And type annotations follow the name after a colon, with return types after `->`, giving a consistent left-to-right reading order.

The following program is complete and illustrates the basic texture of the language.

```sunra
module demo.hello

use std.io
use std.money.{Money, THB}

/// Compute the payout for a flat-rate bet.
/// Money is fixed-point; the compiler rejects float arithmetic on it.
fn payout(stake: Money[THB], multiplier: u32) -> Money[THB]:
    stake * multiplier

fn main() -> Result[(), IoError] uses io:
    let stake = Money[THB].of(20, 00)
    let win = payout(stake, 12)
    io.println("stake={stake} win={win}")!
    Ok(())
```

Three details in that fragment carry design weight. The `uses io` clause is the effect annotation: `main` may perform input and output, and any function it calls that performs IO must declare the same effect or be called through an explicit boundary. The `!` suffix on `io.println(...)` is the error-propagation operator, equivalent to Rust's `?` — it unwraps a `Result` on success and returns the error to the caller on failure. And `Money[THB]` demonstrates that generic parameters use square brackets rather than angle brackets, which removes the parser ambiguity with comparison operators and, incidentally, removes a class of syntax that language models frequently mis-balance.

#### 4.1.1 Bindings, mutability, and shadowing

Bindings are immutable by default. `let` introduces an immutable binding, `var` a mutable one, and there is no third form. Rebinding the same name in the same scope is permitted only when the new binding is introduced by `let`, which supports the common refinement pattern (`let x = parse(input)!` following `let x = raw_input`) while making mutation syntactically distinct from re-definition.

```sunra
let base = 100          # immutable
var counter = 0         # mutable
counter += 1

let total = base * 3    # inferred u32
let ratio: f64 = 0.965  # explicit annotation when it matters
```

Constants are declared with `const` and must be evaluable at compile time; `static` declares a program-lifetime value and is permitted only for immutable data, which removes global mutable state from the language entirely. Where genuinely shared mutable state is required, it must be expressed as an actor or an explicit synchronised cell, and the effect system will surface it.

#### 4.1.2 Functions, arguments, and pipelines

Functions are declared with `fn`, may declare an effect set with `uses`, and may be generic over types, constants, and regions. The final expression of a body is its value; `return` exists for early exit. Named arguments are available at call sites for readability and become mandatory for any parameter list longer than three, a rule enforced by the linter rather than the parser.

```sunra
fn weighted_pick[T](items: [Weighted[T]], rng: &mut Rng) -> T uses rand:
    let total = items.map(.weight).sum()
    var roll = rng.range(0, total)
    for item in items:
        if roll < item.weight:
            return item.value
        roll -= item.weight
    unreachable("weights must sum to total")
```

The `.weight` in `items.map(.weight)` is field-projection shorthand for the closure `|it| it.weight`. Closures otherwise use the pipe form `|params| body`. The pipeline operator `|>` threads a value through a sequence of calls, which keeps data-transformation code linear rather than nested:

```sunra
let winners = spins
    |> filter(|s| s.win > Money.zero())
    |> sort_by(.win, desc)
    |> take(10)
```

`unreachable(msg)` is a total-function marker: it asserts a branch cannot occur, and the compiler will attempt to discharge that assertion statically. If it cannot, and the enclosing function is annotated `#[no_panic]`, compilation fails — which is the mechanism by which production game logic is made panic-free.

#### 4.1.3 Data declarations and pattern matching

Sunra has product types (`type ... = struct`), sum types (`type ... = enum`), and type aliases, all declared with `type`. Sum types are sealed by default, which is what makes exhaustiveness checking meaningful.

```sunra
type Symbol = enum:
    Wild
    Scatter
    Royal(rank: Rank)
    Low(index: u8)

type SpinOutcome = struct:
    grid: Grid[5, 3, Symbol]
    wins: [LineWin]
    total: Money[THB]
    feature: Option[Feature]

match outcome.feature:
    Some(Feature.FreeSpins(count)) -> award_free_spins(count)
    Some(Feature.Hold(positions))  -> start_hold_and_win(positions)
    None                           -> ()
```

Match arms must cover every constructor; a wildcard `_` is permitted but the linter flags it in code annotated as domain-critical, because a wildcard over a sealed enum silently absorbs new variants and that is exactly the failure mode that causes a new bonus feature to pay nothing. Matches support guards (`if`), binding patterns, nested destructuring, range patterns over integers, and `or` patterns.

#### 4.1.4 Refinement types and units

A distinguishing syntactic feature is that types may carry predicates, checked at construction and assumed thereafter. This turns a large class of validation into a type-system concern.

```sunra
type Rtp = f64 where 0.80 <= self <= 1.00
type Probability = f64 where 0.0 <= self <= 1.0
type ReelIndex = u8 where self < 5

fn set_target(rtp: Rtp) -> ():
    ...

set_target(0.965)   # ok, literal proven in range at compile time
set_target(1.4)     # compile error: literal violates refinement of Rtp
set_target(input)   # compile error: must use Rtp.try_from(input)! first
```

Refinements are verified statically for literals and constant expressions, and require an explicit fallible constructor for runtime values. This is intentionally weaker than a dependent type system — the checker handles linear arithmetic over integers and rationals and interval reasoning over floats, and rejects anything it cannot decide rather than attempting general theorem proving. Principle 7 applies: the goal is a checker that always terminates quickly and whose failures are comprehensible.

Units of measure follow the same pattern for currency and time, so that `Money[THB] + Money[USD]` is a type error and durations cannot be added to timestamps without an explicit operation.

### 4.2 Type system

#### 4.2.1 Foundations

Sunra is statically and strongly typed with no implicit conversions of any kind, including no integer widening. Inference is bidirectional Hindley–Milner-style within function bodies, with mandatory annotations on all function signatures, public items, and struct fields. This split is deliberate: complete inference makes bodies terse while mandatory signatures give both human reviewers and language models a reliable local contract, and it keeps error messages localised rather than reporting a type mismatch three files away from its cause.

The scalar layer is explicit about width and signedness (`i8`…`i64`, `u8`…`u64`, `usize`, `f32`, `f64`, `bool`, `char`) and adds two domain scalars: `dec[S]`, a fixed-point decimal with compile-time scale `S`, and `rat`, an arbitrary-precision rational used in mathematical model code where exactness matters more than speed. `Money[C]` is `dec[4]` tagged with a currency, and the standard library's `Money` API offers no lossy operation — division returns a quotient and an explicit remainder so that no fraction of a unit can silently disappear.

#### 4.2.2 Traits and generics

Abstraction is provided by traits, which are typeclasses with associated types and constants and no inheritance. Generic instantiation is monomorphized by default, which is what makes trait-based abstraction genuinely zero-cost; dynamic dispatch is available explicitly as `dyn Trait` behind a pointer when code size matters more than speed.

```sunra
trait Evaluator:
    type Input
    type Win
    fn evaluate(self, input: Self.Input) -> [Self.Win]

trait Rng:
    fn next_u64(&mut self) -> u64 uses rand
    fn range(&mut self, lo: u64, hi: u64) -> u64 uses rand:
        # default method, unbiased rejection sampling
        ...
```

Const generics are load-bearing in this domain because grid geometry is static: `Grid[5, 3, Symbol]` is a distinct type from `Grid[6, 4, Symbol]`, indexing is bounds-checked at compile time, and a payline defined over a five-column grid cannot be applied to a six-column one. Higher-kinded types are deliberately omitted from version 1.0 under Principle 7.

#### 4.2.3 The absence of null and exceptions

There is no null, nil, undefined, or default-initialised reference in Sunra. Optionality is the ordinary enum `Option[T]` with variants `Some(T)` and `None`, and because match exhaustiveness is enforced, every consumer of an optional value handles absence explicitly. Convenience is restored through combinators (`map`, `and_then`, `unwrap_or`, `filter`) and the `?.` chaining operator for the common projection case.

Fallible operations return `Result[T, E]`. There is no `throw`, no unwinding, and no `catch`. The `!` operator propagates an error to the caller after applying any declared conversion, and the `else` form handles it inline:

```sunra
let bet = wallet.reserve(stake)!                    # propagate on failure
let bet = wallet.reserve(stake) else |e|: return Refund(e)
```

Error types are enums, and a function's error type is part of its contract. A library that adds a new error variant makes a breaking change, which is correct: callers of a real-money API must be recompiled when new failure modes appear.

Panics exist but are constrained. They arise only from `unreachable`, explicit `panic`, and unchecked indexing in `unsafe` blocks, and any function may be annotated `#[no_panic]` to make the compiler prove their absence. The convention for production game logic — enforced in the standard library's own game modules — is that every function reachable from a round-resolution entry point carries `#[no_panic]`.

#### 4.2.4 The effect system

Effects are the feature that distinguishes Sunra's type system most sharply from Rust's, and they exist for an auditing reason rather than a purity-aesthetic one. A regulator asking "which code can influence the outcome of a round?" should be answerable by grep, not by architecture review.

A function's signature lists the effects it may perform. Effects are a lattice: declaring a broader effect permits narrower ones, and a function may not perform an effect absent from its declaration or the declaration of a handler it runs under.

| Effect | Grants | Typical holder |
| :--- | :--- | :--- |
| *(none)* | Pure computation only; deterministic, no observable side effect | Paytable evaluation, hand ranking, math model functions |
| `rand` | Consumption of a randomness source | Reel stop selection, shuffles, dice rolls |
| `io` | Console, filesystem, clock access | Entry points, tooling |
| `net` | Network sockets, HTTP, WebSocket | Session servers, integrations |
| `db` | Database reads and writes | Persistence layer |
| `money` | Ledger mutation; debits, credits, settlement | Wallet and settlement code |
| `ai` | Model invocation | Assistants, dynamic content, anomaly detection |
| `chain` | Blockchain transaction submission | Fairness commitment publication |
| `audit` | Append to the tamper-evident audit log | Anything a regulator must see |
| `unsafe` | Raw memory, FFI, unchecked indexing | Low-level interop only |

The practical consequence is that a paytable evaluator has an empty effect set and therefore *cannot* consult a random source, read a clock, or touch a wallet, no matter what its author intended. This makes it trivially unit-testable, trivially cacheable, and — most importantly — mechanically provable to be a pure function of the grid. Meanwhile a settlement function declaring `uses money, db, audit` announces exactly its blast radius.

Effect polymorphism is supported so that higher-order library code composes: `fn retry[E](times: u32, f: fn() -> Result[T, E] uses e) -> Result[T, E] uses e` forwards whatever effects its argument performs. Effects are erased at compile time and impose no runtime cost.

#### 4.2.5 Compile-time evaluation

A substantial fraction of gaming code is table construction that need not happen at runtime. Sunra therefore has a `comptime` evaluator: any expression in a `comptime` context is evaluated during compilation using the same language, with the pure effect set. This is how reel strips are expanded, cumulative weight tables built, payline masks precomputed, and — in the exhaustive case — the return-to-player figure calculated. There is no separate macro language; metaprogramming is ordinary Sunra code that runs at compile time, which keeps the surface area small and, per Principle 6, keeps generated code readable.

### 4.3 Memory model

#### 4.3.1 Ownership with inferred borrows

Sunra uses affine ownership: every value has exactly one owner, assignment moves ownership unless the type is `Copy`, and a value is destroyed deterministically when its owner's scope ends. References are `&T` for shared and `&mut T` for exclusive access, and the standard aliasing discipline applies — many shared references or exactly one exclusive reference, never both.

What differs from Rust is that lifetimes are not part of the surface syntax in ordinary code. The compiler performs whole-function region inference, generating and solving outlives-constraints over an SSA form, and reports violations in terms of concrete program points rather than named lifetime variables. Explicit region parameters exist (`fn longest[r](a: &r str, b: &r str) -> &r str`) but are needed only where a signature is genuinely ambiguous about which input a returned reference derives from, which in practice means a minority of library APIs. The design bet is that removing lifetime syntax from the 95% case removes most of the learning-curve objection to ownership while retaining all of its performance and safety benefits.

Diagnostics are treated as part of the memory model rather than an afterthought:

```
error[E0412]: value used after it was moved
  --> game/spin.sun:41:18
   |
38 |     let bet = wallet.reserve(stake)!
   |         --- `bet` created here
39 |     settle(bet)
   |            --- ownership moved into `settle` here
41 |     audit.record(bet.id)
   |                  ^^^ used here after the move
   |
help: `Bet` is a linear resource, so it can be settled exactly once.
      Capture the identifier before settling:
   |
38 |     let bet = wallet.reserve(stake)!
39 +     let bet_id = bet.id
40 |     settle(bet)
41 |     audit.record(bet_id)
```

#### 4.3.2 Linear resources

Some domain objects must be consumed exactly once — a reserved bet must be either settled or refunded, a random stream must be committed, an audit span must be closed. Sunra expresses this with the linear qualifier `~`, which strengthens affinity by also forbidding *implicit drop*. A `~Bet` that goes out of scope without being passed to a consuming function is a compile error, so the "reserved funds leaked because an early return skipped settlement" bug is not expressible.

```sunra
fn play(wallet: &mut Wallet, stake: Money[THB]) -> Result[Receipt, PlayError] uses rand, money, audit:
    let bet: ~Bet = wallet.reserve(stake)!
    let outcome = spin(&mut rng())!            # if this fails, `bet` is still live
    match outcome.total.is_zero():
        true  -> Ok(bet.lose())                # consumes `bet`
        false -> Ok(bet.win(outcome.total))    # consumes `bet`
```

Had the author written an early `return Err(...)` between the reservation and the settlement, the compiler would reject the function until the bet was explicitly refunded on that path.

#### 4.3.3 Regions and the zero-allocation round

Heap allocation in a hot loop is both a performance problem and a determinism problem. Sunra addresses both with `frame`, a lexically scoped arena.

```sunra
fn resolve_round(cfg: &GameConfig, rng: &mut Rng) -> RoundResult uses rand:
    frame round:                       # bump-allocated arena, freed wholesale at scope exit
        let grid = cfg.reels.spin_in(round, rng)
        let wins = cfg.paylines.evaluate_in(round, grid)
        RoundResult.summarise(wins)    # only the summary escapes the frame
```

Inside a `frame`, allocation is a pointer bump and deallocation is a single pointer reset; the region checker guarantees no reference outlives the frame, so the reset is safe without any scanning. The design target is that a fully resolved slot spin, including cascade and bonus evaluation, performs zero calls to the general allocator after warm-up. Shared ownership remains available through `Rc[T]` for single-threaded and `Arc[T]` for cross-thread sharing, and weak references break cycles; there is no tracing garbage collector anywhere in the runtime.

#### 4.3.4 Determinism as a memory-model property

Because destruction order is deterministic, allocation in the hot path is arena-based, and iteration order over the standard hash map is defined by insertion rather than address, a Sunra program given the same inputs and the same seed produces byte-identical outputs across runs, machines, and architectures. This is not merely tidy; it is the precondition for the replay and verification features described in Section 5, and it is why the language rejects the address-dependent behaviours that make deterministic replay difficult in other systems languages.

### 4.4 Concurrency model

#### 4.4.1 Structured concurrency

All concurrency in Sunra is structured: tasks are spawned into a `nursery` whose scope cannot exit until every child has completed or been cancelled, so there are no detached tasks and no orphaned work. Cancellation propagates down the tree and is cooperative at await points. Errors propagate up to the nursery, which by default cancels siblings and returns the first failure.

```sunra
async fn settle_round(round: &Round) -> Result[(), SettleError] uses db, net, audit:
    nursery n:
        let ledger = n.spawn(|| ledger.commit(round))
        let notify = n.spawn(|| bus.publish(round.event()))
        let record  = n.spawn(|| audit.write(round.span()))
        ledger.join()!    # nursery scope guarantees all three finish or are cancelled
        notify.join()!
        record.join()!
    Ok(())
```

Data-race freedom comes from the ownership model plus two auto-derived marker traits: `Send`, meaning a value may be transferred between tasks, and `Share`, meaning `&T` may be held by several tasks at once. A type containing an unsynchronised mutable cell is neither, so sharing it is a compile error rather than a race.

#### 4.4.2 Actors for stateful tables

Live table games are naturally actors: a baccarat table has private state, a strictly ordered event history, and many observers. Sunra makes this a language construct rather than a library pattern, because the ordering and isolation guarantees are what make table state auditable.

```sunra
actor BaccaratTable:
    state:
        shoe: Shoe[8]
        round: Option[Round]
        seats: Map[SeatId, Seat]

    on Join(player: PlayerId) -> Result[SeatId, TableFull] uses audit:
        ...

    on PlaceBet(seat: SeatId, bet: BetKind, stake: Money[THB]) -> Result[(), BetError] uses money, audit:
        ...

    on Deal() -> RoundResult uses rand, audit:
        ...
```

An actor's state is unreachable from outside; messages are typed, and the mailbox is processed sequentially, so each handler runs with exclusive access without any lock. Supervision is declarative — a supervisor declares a restart strategy and the runtime reconstructs failed actors from their persisted event log, which for a table game doubles as the regulatory record.

#### 4.4.3 Deterministic mode

The runtime has two schedulers. The production scheduler is a work-stealing multi-threaded executor. The deterministic scheduler runs tasks on a single thread against a logical clock with a seeded interleaving, so a concurrent program's execution is fully reproducible. Tests run under the deterministic scheduler by default, which makes concurrency bugs reproducible from a seed, and incident replay uses the same mechanism to reconstruct a disputed round exactly as it occurred in production.

#### 4.4.4 Parallel simulation

Monte Carlo simulation of a game model is the archetypal embarrassingly parallel workload and the one Sunra must be fastest at, since it is the inner loop of both math development and RTP verification. The `parallel for` construct distributes a range across workers after the compiler proves the iterations write to disjoint memory; each worker receives an independently derived RNG substream via counter-based splitting, so results are reproducible regardless of worker count.

```sunra
fn estimate_rtp(cfg: &GameConfig, rounds: u64, seed: Seed) -> RtpEstimate uses rand:
    var acc = Accumulator.zero()
    parallel for i in 0..rounds reduce acc:
        var rng = Rng.split(seed, i)              # deterministic substream per index
        let out = resolve_round(cfg, &mut rng)
        acc.observe(out.total)
    acc.finish(rounds)
```

The design target is one million simulated spins per second per core for a typical five-reel, twenty-line game with a bonus feature, with linear scaling to available cores and bit-identical results at any core count. That figure is a target that the arena allocation strategy, monomorphized evaluation, and precomputed comptime tables are chosen to make attainable; it is not a measurement.

---

## 5. Built-in Gaming Primitives

This section describes the layer that no general-purpose language provides. Some constructs are true language syntax handled by the compiler front end (the `game`, `reels`, and `paylines` declarations, and the `#[rtp]` attribute); the remainder live in the standard library but are known to the compiler's analysis passes. The distinction matters for language purists and is noted per construct.

### 5.1 The `game` declaration

A game in Sunra is a declarative artefact, not a class hierarchy. The `game` block gathers the mathematical definition of a title into one reviewable unit and is the anchor for compile-time verification.

```sunra
game SolarFortune:
    grid: 5 x 3
    currency: THB
    lines: 20
    bet_range: Money.of(1, 00) ..= Money.of(2_000, 00)
    max_win: 5_000 x bet
    jurisdiction: [MGA, UKGC, GLI19]

    #[rtp(target = 0.9650, tolerance = 0.0005, method = exhaustive)]
    #[volatility(target = High, hit_rate = 0.2450 +- 0.01)]
    #[no_panic]
    math: SolarFortuneMath
```

The compiler reads this block, locates the referenced math module, and schedules the analyses implied by the annotations. `max_win: 5_000 x bet` is not documentation — the round resolver's return value is checked against it, and a configuration whose theoretical maximum exceeds the cap fails the build, which prevents the class of incident where an unbounded multiplier chain produces a liability nobody modelled.

### 5.2 Reels, symbols, and weight tables

Reel strips are declared with symbol multiplicities, and the compiler expands them into cumulative weight tables at compile time via `comptime`. Because the tables are constant, symbol selection compiles to a single binary search over a static array with no allocation.

```sunra
symbols SolarSymbols:
    Wild        weight 2   pays [_, _, 50, 200, 1000]
    Sun         weight 4   pays [_, _, 25, 100,  500]
    Ankh        weight 6   pays [_, _, 15,  60,  250]
    Eye         weight 8   pays [_, _, 10,  40,  150]
    Scarab      weight 10  pays [_, _,  8,  25,  100]
    Ace         weight 14  pays [_, _,  5,  15,   60]
    King        weight 16  pays [_, _,  4,  12,   40]
    Queen       weight 18  pays [_, _,  3,  10,   30]
    Jack        weight 20  pays [_, _,  2,   8,   20]
    Scatter     weight 3   scatter_pays [_, _, 2x, 10x, 50x] triggers FreeSpins(10)

reels SolarFortuneMath.base:
    reel 0: strip_from(SolarSymbols)
    reel 1: strip_from(SolarSymbols) with Wild weight 3
    reel 2: strip_from(SolarSymbols) with Wild weight 4
    reel 3: strip_from(SolarSymbols) with Wild weight 3
    reel 4: strip_from(SolarSymbols)

paylines SolarFortuneMath.lines_20:
    line [1,1,1,1,1]  line [0,0,0,0,0]  line [2,2,2,2,2]
    line [0,1,2,1,0]  line [2,1,0,1,2]  line [0,0,1,2,2]
    # ... remaining 14 lines
```

The `pays` array is indexed by match length, with `_` marking a non-paying length; the compiler checks that its arity equals the grid width, so adding a sixth reel without extending the paytable is a compile error rather than a silent zero. Alternative evaluation topologies are first-class: `ways` for all-ways (243-ways, 1024-ways) games, `cluster` for cluster-pays with flood-fill grouping, `megaways` for variable-height reels with a declared height distribution, and `scatter_pays` for anywhere-pays. Each carries its own evaluator in `std.game.eval`, all with an empty effect set, so the payout of a grid is a pure function and can be exhaustively enumerated.

### 5.3 Randomness as a typed effect

Randomness is the single most security-sensitive resource in a gaming system, so Sunra refuses to treat it as a free function. Every generator implements the `Rng` trait, every method carries the `rand` effect, and the *kind* of generator is visible in the type so that a simulation source can never reach production.

| Type | Algorithm | Determinism | Sanctioned use |
| :--- | :--- | :--- | :--- |
| `SecureRng` | OS entropy, DRBG-reseeded | Non-reproducible | Live real-money outcomes |
| `FairRng` | HMAC-SHA-256 over (server seed, client seed, nonce) | Reproducible by the player | Provably fair live outcomes |
| `SimRng` | ChaCha20, counter-based splitting | Reproducible from seed | Simulation, RTP estimation, tests |
| `ReplayRng` | Replays a recorded draw log | Fully deterministic | Dispute investigation, regression tests |

The compiler enforces a rule expressed in the `game` block's jurisdiction annotation: a title certified for a real-money jurisdiction may only be resolved with `SecureRng` or `FairRng`. Attempting to instantiate a round resolver with `SimRng` in a build configured as `--profile production` is a compile error, which closes the "test generator shipped to production" hole by construction.

All generators provide unbiased bounded generation through rejection sampling rather than modulo reduction, because modulo bias in a `range` helper is a real and recurring source of certification failures. `Rng.split(seed, index)` derives independent substreams deterministically, which is what makes parallel simulation reproducible.

### 5.4 Provably fair protocol

Provably fair is a protocol, not a feature, and `std.fair` implements the whole ceremony as typed states so that steps cannot be skipped or reordered. The pattern is the industry-standard commit–reveal: the server generates a seed and publishes its hash before play; the player contributes a seed; outcomes are derived by HMAC from the pair plus a monotonic nonce; the server seed is revealed at rotation, letting anyone recompute every outcome in the epoch.

```sunra
use std.fair.{Ceremony, Committed, Revealed}

fn open_session(player: PlayerId) -> Ceremony[Committed] uses rand, audit:
    let ceremony = Ceremony.begin(
        server_seed = SecureRng.seed_256(),
        client_seed = ClientSeed.awaiting(),
    )
    audit.publish(ceremony.commitment())     # SHA-256 of server seed, before any play
    ceremony

fn draw(c: &Ceremony[Committed], nonce: u64, cursor: u32) -> u64 uses rand:
    c.hmac_stream(nonce).u64_at(cursor)      # HMAC-SHA256(server_seed, client_seed:nonce:cursor)

fn rotate(c: Ceremony[Committed]) -> Ceremony[Revealed] uses audit:
    let revealed = c.reveal()                # consumes the committed state, cannot draw again
    audit.publish(revealed.proof())          # seed + commitment + nonce range
    revealed
```

Because `Ceremony[Committed]` and `Ceremony[Revealed]` are distinct types and `reveal()` consumes its input, the compiler prevents the two catastrophic protocol errors: revealing the server seed while it is still in use, and continuing to draw from a revealed ceremony. Alongside the protocol, `sunc` emits verifier artefacts as a build output — a standalone WebAssembly module and a single-file HTML page that recompute any outcome from the published seeds — so an operator's "verify this round" page is generated from the same source as the game rather than reimplemented by a web team.

### 5.5 Compile-time RTP and volatility verification

This is the capability that most clearly justifies a new language. The `#[rtp]` attribute is a proof obligation on the build.

Given that a Sunra payout evaluator has an empty effect set, it is by construction a pure function from a grid to a payout. The compiler therefore knows that expected value can be computed by integrating the evaluator over the reel distribution, and it selects a method automatically:

**Exhaustive enumeration** is used when the state space is tractable. The compiler computes the product of reel strip lengths, applies symmetry reductions where strips are identical, and if the resulting count falls under a configurable budget it enumerates every stop combination during compilation, accumulating the exact expected return as a rational number. For a typical five-reel game with strips of 40 to 60 symbols this is on the order of 10^8 combinations, which is feasible as a parallel build step and yields an exact figure rather than an estimate.

**Stratified Monte Carlo** is used when enumeration is infeasible, which in practice means games with cascading reels, multi-stage bonus rounds, or unbounded retrigger chains. The compiler runs a seeded simulation with variance reduction, reports the estimate with a confidence interval, and fails the build if the declared target lies outside that interval. The seed and the round count are recorded in the build artefact so the figure is reproducible by a third party.

**Compositional analysis** handles the common structure where a game is a base mode plus weighted feature modes. Each mode's contribution is computed independently and combined by trigger probability, which both accelerates verification and produces the per-feature RTP breakdown that certification submissions require.

```
$ sunc rtp --game SolarFortune --report artifacts/solar_rtp.json

  Sunra 0.1.0 — RTP verification
  Game        SolarFortune (5x3, 20 lines, THB)
  Method      exhaustive (base) + monte-carlo (free spins, 2.0e9 rounds, seed 0x5UN…)
  Source      sha256:4f2c…a91d

  Base game line wins        0.6412
  Base game scatter pays     0.0298
  Free spins feature         0.2940   (trigger p = 0.008120, avg 14.3 spins)
  ─────────────────────────────────────
  Total RTP                  0.96500  (target 0.96500 +- 0.00050)  PASS
  Hit frequency              0.24466  (target 0.24500 +- 0.01000)  PASS
  Volatility index           8.71     (High)                       PASS
  Max win                    4_812 x  (cap 5_000 x)                PASS
  Panic freedom              proven   (#[no_panic] discharged)      PASS

  Signed report written to artifacts/solar_rtp.json
```

The report is signed with the build key and includes the reel tables, the paytable, the computed distribution, the method and parameters, the effect inventory of every function reachable from the resolver, and the source hash. Its purpose is to be the input to a test laboratory's review rather than something the laboratory must reconstruct. The honest framing for an investor audience is that this does not eliminate independent certification — no regulator will accept a self-signed compiler report as a substitute for accredited testing — but it changes what the laboratory does from *re-deriving the mathematics* to *validating a mechanically produced derivation*, which is a materially cheaper and faster activity.

The same machinery serves development. `sunc rtp --sweep bet` reports return as a function of bet level, catching bet-dependent leaks. `sunc rtp --diff HEAD~1` reports the exact basis-point impact of a weight table change, in the same pull request that makes it.

### 5.6 Card games

`std.game.card` models the physical apparatus rather than an abstraction of it, because certification cares about the apparatus. A `Deck[Standard52]` is a compile-time-sized array of distinct cards; a `Shoe[N]` composes N decks with a declared cut card position, burn card rules, and penetration threshold, and exposes its remaining composition for pure evaluation.

```sunra
use std.game.card.{Shoe, Card, Rank, Suit}
use std.game.table.baccarat

fn deal_baccarat(shoe: &mut Shoe[8], rng: &mut FairRng) -> baccarat.Round uses rand, audit:
    if shoe.needs_shuffle():
        shoe.shuffle_with(rng)        # Fisher-Yates, unbiased, logged
        shoe.burn(1)!
    baccarat.deal(shoe)!
```

Shuffling is Fisher–Yates over an unbiased bounded generator, and the implementation is the only sanctioned one — the library exposes no `shuffle` that takes an arbitrary closure, precisely to prevent studios from inventing their own. Hand evaluation is pure: `baccarat.total(hand)`, `baccarat.third_card_rule(player, banker)`, `blackjack.hand_value(hand)`, and `poker.rank(hand) -> HandRank` all carry an empty effect set, so the third-card rule table can be exhaustively verified against the published rules as a compile-time test, and a poker evaluator can be checked against all 2,598,960 five-card combinations in a build step.

The rule engines shipped in Phase 3 cover baccarat with its standard drawing tables and common side bets, blackjack with configurable dealer and doubling rules, and Texas hold'em, Omaha, and three-card poker evaluation. Each rule engine exposes its configuration as a typed record so that a jurisdictional variant is a value rather than a fork of the code.

### 5.7 Dice, wheels, and crash

The remaining outcome families are small enough to describe together. `std.game.dice` provides fair dice with declared face counts and a `Sicbo` bet resolver; `std.game.wheel` provides roulette layouts for European, American, and French wheels with the full bet grammar and correct payout tables, plus generic money wheels; `std.game.crash` provides the multiplier-curve family used in crash and plinko-style games, where the house edge is expressed as a parameter of an inverse-CDF derivation rather than hand-coded, so that the edge is verifiable by the same `#[rtp]` machinery.

```sunra
# House edge is a declared, verified parameter of the curve
#[rtp(target = 0.9900, tolerance = 0.0001, method = analytic)]
fn crash_point(c: &Ceremony[Committed], nonce: u64) -> f64 uses rand:
    let u = c.hmac_stream(nonce).uniform_01()
    crash.inverse_cdf(u, house_edge = 0.0100, max_multiplier = 10_000.0)
```

`method = analytic` instructs the compiler to discharge the obligation symbolically against a proof supplied by the library for this curve family, which is faster and exact where it applies.

### 5.8 Money, wallets, and settlement

Money is `dec[4]` tagged with a currency and has no conversion to or from floating point. Arithmetic that could lose precision does not exist: division returns quotient and remainder together, percentage operations round according to an explicitly supplied rounding mode, and cross-currency arithmetic requires an exchange operation that records the rate used.

Wallet operations are linear resources as shown in Section 4.3.2, and settlement is idempotent by construction: every mutating wallet call takes an `IdempotencyKey` derived from the round identifier, so a retried settlement after a network partition cannot double-pay. The `money` effect makes every function that can move funds visible, and `audit` records the movement in a hash-chained log whose head can be published for tamper evidence.

### 5.9 Regulatory annotations and the audit trail

The `jurisdiction` field on a `game` block activates a rule set from `std.regulate`. These are not merely documentation; each jurisdiction module registers compile-time checks. A UKGC-annotated game must have a minimum spin duration constant and must not implement autoplay beyond the permitted forms; an MGA-annotated game must expose session reality-check hooks; a GLI-19 annotated game must satisfy the panic-freedom and RNG requirements and emit the specified log fields. Where a rule cannot be checked mechanically, the module emits a build warning enumerating the manual attestations required, which becomes a checklist rather than institutional memory.

The `audit` effect writes to an append-only, hash-chained event log with a fixed schema covering round lifecycle, bet placement, outcome derivation inputs, settlement, and configuration changes. Because the log includes the RNG derivation inputs and the build's source hash, any historical round can be replayed byte-exactly with `ReplayRng` — which is the concrete answer to a player dispute or a regulatory inquiry.

---

## 6. AI Integration

"AI-first" is used loosely in language marketing, so it is worth being precise about what it means here. Sunra treats AI integration as two distinct problems that happen to share a name. The first is **AI as an author**: making the language a target that models generate correctly at a high rate, and making the toolchain able to check and repair generated code. The second is **AI as a runtime capability**: letting Sunra programs call models safely, with typed inputs and outputs and honest effect accounting. The first is the more important and the more novel.

### 6.1 Designing for machine authorship

Language models fail at code generation in characteristic ways: they invent APIs, mis-balance delimiters, produce code that type-checks but violates unstated invariants, and drift from the stated requirement over long edits. Sunra's design attacks each of these at the language level rather than relying on prompt engineering.

**Canonical form eliminates stylistic search space.** Every construct has exactly one accepted formatting, enforced by `sunfmt` and checked in CI. A model does not have to choose between four ways of writing a match arm, and reviewers never see diffs that are purely stylistic. Square-bracket generics remove the `<` ambiguity that produces mis-balanced output; the absence of semicolons removes a whole category of trivial error; layout-based blocks with explicit lexer tokens mean that indentation mistakes produce precise errors rather than silently different programs.

**Mandatory signatures and effects supply local context.** Because every function declares its parameter types, return type, error type, and effect set, a model editing one function has a complete contract for everything it calls without needing the whole repository in context. Effects in particular carry a large amount of intent per token: `uses rand, money, audit` tells a model more about what a function is allowed to do than a paragraph of docstring.

**The type system rejects domain-invalid programs.** This is the deepest point. In a general-purpose language, the set of programs that compile is vastly larger than the set that is correct for a gambling application, so a model's output being well-typed says little. In Sunra, currency cannot be a float, a payout evaluator cannot consult randomness, a bet cannot be dropped without settlement, a committed ceremony cannot be drawn from after reveal, and a paytable cannot mismatch a grid. The compilable set has been deliberately narrowed toward the correct set, which is what makes compiler feedback a useful training and repair signal rather than a weak filter.

**Diagnostics are designed to be repaired programmatically.** Every diagnostic has a stable code, a machine-readable JSON form with source spans, a categorised cause, and where possible a structured suggested edit that a tool can apply without regenerating the file.

```
$ sunc check --format=json
{
  "code": "E0731",
  "severity": "error",
  "category": "domain.money.precision",
  "message": "cannot multiply Money[THB] by f64",
  "span": { "file": "game/pay.sun", "line": 22, "col": 17, "len": 14 },
  "explain": "Money is fixed-point. Float multiplication would introduce
              representation error that accumulates across rounds.",
  "fix": {
    "kind": "replace",
    "span": { "file": "game/pay.sun", "line": 22, "col": 17, "len": 14 },
    "text": "stake.scale_by(Ratio.of(965, 1000), Rounding.HalfEven)"
  },
  "docs": "https://sunra.dev/errors/E0731"
}
```

### 6.2 SAIL: the machine-facing representation

Text is a lossy interface for program manipulation. Sunra therefore exposes **SAIL** (Sunra AI Intermediate Language), a stable JSON serialisation of the typed, name-resolved, desugared high-level IR. SAIL nodes carry resolved types, effect sets, source spans, and symbol identities, so a tool operating on SAIL knows what every identifier refers to without re-implementing name resolution.

```
$ sunc emit --sail game/spin.sun            # typed AST as JSON
$ sunc apply --sail patch.json              # structural edit, re-typechecked
$ sunc query "callers of settle_bet"        # semantic query over the program graph
$ sunc query "functions using effect money without audit"
```

The last query is illustrative of why this matters beyond code generation: semantic queries over effects are a compliance tool. "Show me every code path that can move money without writing an audit record" is a question that takes seconds in Sunra and a security review in most codebases.

SAIL is also the substrate for AI-assisted refactoring. A model proposes a structural patch against SAIL rather than emitting a text diff, the compiler re-type-checks the result, and the patch is either accepted or returned with typed errors for a second attempt. This loop is bounded, mechanical, and cheap compared with regenerating and reviewing free-form text.

### 6.3 Intent blocks and drift detection

The largest gap in AI-assisted development is not code generation but the divergence between what a system is *supposed* to do and what it does after fifty edits. Sunra addresses this with `intent`, a first-class construct binding a natural-language specification and machine-checkable properties to an item.

```sunra
intent """
A free spins round awards between 10 and 25 spins depending on the number of
triggering scatters (3 -> 10, 4 -> 15, 5 -> 25). Retriggers are permitted and
add 5 spins each, up to a hard ceiling of 100 total spins. The round always
terminates.
"""
properties:
    forall s in 3..=5:   award(s) in 10..=25
    forall s in 3..=5:   award(s) == match s: 3 -> 10; 4 -> 15; 5 -> 25
    total_spins <= 100
    terminates
fn free_spins(triggers: u8) -> FreeSpinRound uses rand:
    ...
```

The `properties` clause is checked by three mechanisms in increasing order of cost. Properties expressible as refinements or bounded exhaustive checks are discharged statically by the compiler. Properties over larger domains become generated property-based tests run under `sunc test`. Termination is checked by a structural-recursion analysis, with an explicit fuel parameter required where it cannot be proven. Finally, `sunc verify --intent` uses a language model to compare the prose specification against the implementation and the discharged properties, reporting *drift* — cases where the code and the prose no longer agree even though everything type-checks. Drift reports are advisory rather than blocking, since a model's judgement is not a proof, but they surface in code review as annotations on the changed lines, which is where they are actionable.

The honest limitation, stated plainly: model-based intent checking is a heuristic. Its value is catching the class of regression where a weight table or a bound is edited without the specification following, which is empirically common and currently caught only by human review.

### 6.4 Natural language to code

`sunra ask` generates typed scaffolding from a description. The design choice that makes this useful rather than a novelty is that generation produces **typed holes** rather than plausible-looking bodies. A hole `???` is a well-typed expression of unknown implementation; a program full of holes compiles, type-checks, and reports exactly what remains to be written and with what type.

```
$ sunra ask "a 6-reel cluster pays game with cascading symbols, 96.2% RTP,
             tumble multiplier that increases 1x per cascade up to 32x"

  Generated game/tumble_suns.sun (compiles, 4 holes)

  game TumbleSuns:
      grid: 6 x 5
      lines: cluster(min = 5)
      #[rtp(target = 0.9620, tolerance = 0.0005, method = monte-carlo)]
      math: TumbleSunsMath

  fn cascade_multiplier(step: u8) -> u32:
      min(step as u32 + 1, 32)

  fn resolve_cascade(grid: &mut Grid[6, 5, Symbol], rng: &mut Rng) -> CascadeResult uses rand:
      ???   # : CascadeResult  — remove winning clusters, drop, refill, repeat
      ...

  4 holes remaining. Run `sunra fill game/tumble_suns.sun` to synthesise, or
  `sunc rtp --game TumbleSuns` once implemented (currently unverifiable).
```

The generated artefact is honest about what it does not know: the RTP annotation is present but unverifiable until the holes are filled, and the toolchain says so. Generated code is stamped with provenance — `@generated(model = "…", prompt_hash = "…", at = "…")` — and the linter requires an accompanying `@reviewed_by` annotation before generated code in a module marked `#[domain_critical]` can be merged. AI writes the scaffolding; a human accepts the liability.

### 6.5 AI as a runtime capability

Programs may also call models, and the `ai` effect makes that visible. Model declarations bind a name to a provider and configuration; prompts are typed templates; and structured output is derived from the return type's schema rather than parsed from prose, so a malformed response is a typed error rather than a runtime surprise.

```sunra
use std.ai.{model, Prompt}

model Analyst:
    provider: "suncore.llm"
    id: "suncore-reasoner-1"
    temperature: 0.0
    max_tokens: 2048
    timeout: 5s

type RiskVerdict = struct:
    score: f64 where 0.0 <= self <= 1.0
    reasons: [str]
    recommend_review: bool

fn assess_session(s: &SessionSummary) -> Result[RiskVerdict, AiError] uses ai:
    Analyst.complete[RiskVerdict](
        Prompt.of("Assess this player session for bonus abuse patterns: {s:json}")
    )
```

Three safety rules apply to runtime AI use, and they are enforced rather than advised. First, a function with the `ai` effect may not also carry the `rand` effect in a code path reachable from a certified game resolver — model output can never influence a game outcome, which is both a regulatory necessity and a sanity measure. Second, all model calls are logged under `audit` with prompt hash, model identity, and response hash, so an AI-influenced decision is reconstructible. Third, `Prompt.of` performs structural escaping of interpolated values, and values arriving from player input carry a `Tainted[T]` wrapper that must be explicitly sanitised, which gives prompt injection the same treatment the language gives SQL injection.

Legitimate runtime uses in this domain are responsible-gaming anomaly detection, fraud and bonus-abuse scoring, player support summarisation, dynamic narrative and localisation content, and operator-facing analytics — none of which touch outcome determination.

### 6.6 A measurable AI-friendliness target

Claims about AI friendliness should be falsifiable. Sunra's Phase 4 exit criterion is a public benchmark, **SunraBench**, comprising 300 domain tasks (implement a paytable, a bonus mechanic, a fairness verifier, a settlement path) with hidden property tests and RTP obligations. The stated targets are that a mid-tier model achieve a higher first-attempt pass rate on Sunra than on an equivalent TypeScript or Python task set, and that the compiler-feedback repair loop converge within three iterations on at least 90% of tasks. The benchmark and its harness are to be published so third parties can reproduce or refute the result; a language claiming provability should hold its own claims to the same standard.

---

## 7. Worked Code Examples

The examples in this section are written as complete, idiomatic Sunra and are intended to be read as the specification's most concrete statement of intent. They are not compiled artefacts — no compiler exists yet — but every construct used appears in Sections 4 through 6, and the intent is that a reader can judge the language's ergonomics from them.

### 7.1 A complete slot game

This is the full mathematical and logical definition of a five-reel, twenty-line video slot with a scatter-triggered free spins feature carrying a progressive multiplier. It is presented across the three files an idiomatic project would use.

**`solar_fortune/math.sun` — the mathematical model.** Note that this entire module is pure: it has no effects at all, which is what makes it exhaustively verifiable.

```sunra
module solar_fortune.math

use std.game.{Grid, Symbol as S, LineWin, Paytable}
use std.money.{Money, THB}

type Sym = enum:
    Wild
    Scatter
    Sun
    Ankh
    Eye
    Scarab
    Ace
    King
    Queen
    Jack

symbols SolarSymbols of Sym:
    Wild     weight 2   pays [_, _,  50, 200, 1000]  substitutes all except Scatter
    Sun      weight 4   pays [_, _,  25, 100,  500]
    Ankh     weight 6   pays [_, _,  15,  60,  250]
    Eye      weight 8   pays [_, _,  10,  40,  150]
    Scarab   weight 10  pays [_, _,   8,  25,  100]
    Ace      weight 14  pays [_, _,   5,  15,   60]
    King     weight 16  pays [_, _,   4,  12,   40]
    Queen    weight 18  pays [_, _,   3,  10,   30]
    Jack     weight 20  pays [_, _,   2,   8,   20]
    Scatter  weight 3   scatter_pays [_, _, 2, 10, 50] triggers FreeSpins

reels base of SolarSymbols:
    reel 0: strip()
    reel 1: strip() with Wild weight 3
    reel 2: strip() with Wild weight 4
    reel 3: strip() with Wild weight 3
    reel 4: strip()

reels free of SolarSymbols:
    # richer wilds during the feature; the compiler recomputes feature RTP separately
    reel 0: strip() with Wild weight 4
    reel 1: strip() with Wild weight 5
    reel 2: strip() with Wild weight 6
    reel 3: strip() with Wild weight 5
    reel 4: strip() with Wild weight 4

paylines lines_20 over 5 x 3:
    line [1,1,1,1,1]  line [0,0,0,0,0]  line [2,2,2,2,2]
    line [0,1,2,1,0]  line [2,1,0,1,2]  line [0,0,1,2,2]
    line [2,2,1,0,0]  line [1,0,1,2,1]  line [1,2,1,0,1]
    line [0,1,1,1,2]  line [2,1,1,1,0]  line [1,1,0,1,1]
    line [1,1,2,1,1]  line [0,0,1,0,0]  line [2,2,1,2,2]
    line [1,0,0,0,1]  line [1,2,2,2,1]  line [0,1,0,1,0]
    line [2,1,2,1,2]  line [0,2,0,2,0]

/// Pure evaluation of one grid. No effects: cannot consult randomness, clock, or wallet.
#[no_panic]
pub fn evaluate(grid: Grid[5, 3, Sym], bet: Money[THB], mult: u32) -> Outcome:
    let line_wins = lines_20.evaluate(grid, SolarSymbols.paytable())
    let scatter   = SolarSymbols.count_scatters(grid)
    let line_total = line_wins
        |> map(|w| bet.per_line(20).scale(w.multiplier))
        |> sum()
    let scatter_total = SolarSymbols.scatter_pay(scatter).map(|m| bet.scale(m)).unwrap_or_zero()

    Outcome:
        line_wins = line_wins
        scatters  = scatter
        total     = (line_total + scatter_total).scale(mult)
        trigger   = if scatter >= 3: Some(free_spin_award(scatter)) else None

#[no_panic]
pub fn free_spin_award(scatters: u8) -> u8:
    match scatters:
        3 -> 10
        4 -> 15
        5 -> 25
        _ -> 0        # unreachable given the caller's guard; explicit for totality
```

**`solar_fortune/game.sun` — the round resolver.** Randomness enters here and nowhere else.

```sunra
module solar_fortune.game

use solar_fortune.math.{self, Sym}
use std.game.{Grid, Rng}
use std.money.{Money, THB}
use std.audit

game SolarFortune:
    grid: 5 x 3
    currency: THB
    lines: 20
    bet_range: Money.of(1, 00) ..= Money.of(2_000, 00)
    max_win: 5_000 x bet
    jurisdiction: [MGA, GLI19]

    #[rtp(target = 0.9650, tolerance = 0.0005, method = auto)]
    #[volatility(target = High, hit_rate = 0.2450 +- 0.0100)]
    #[no_panic]
    math: solar_fortune.math

type RoundResult = struct:
    base: math.Outcome
    feature: Option[FeatureResult]
    total: Money[THB]

type FeatureResult = struct:
    spins: [math.Outcome]
    final_multiplier: u32
    total: Money[THB]

/// Resolve a complete round: one base spin plus the feature if triggered.
#[no_panic]
pub fn resolve(bet: Money[THB], rng: &mut impl Rng) -> RoundResult uses rand:
    frame round:
        let grid = math.base.spin_in(round, rng)
        let base = math.evaluate(grid, bet, mult = 1)

        let feature = match base.trigger:
            Some(spins) -> Some(run_feature(spins, bet, rng))
            None        -> None

        RoundResult:
            base    = base
            feature = feature
            total   = base.total + feature.map(.total).unwrap_or_zero()

/// Free spins with a multiplier that rises by one on every winning spin, capped at 10x.
#[no_panic]
fn run_feature(award: u8, bet: Money[THB], rng: &mut impl Rng) -> FeatureResult uses rand:
    var remaining = award
    var mult: u32 = 1
    var spins: [math.Outcome] = []
    var total = Money[THB].zero()

    while remaining > 0 and spins.len() < 100:        # hard ceiling: proves termination
        remaining -= 1
        let grid = math.free.spin_in(rng)
        let out  = math.evaluate(grid, bet, mult)
        total += out.total
        if out.total.is_positive():
            mult = min(mult + 1, 10)
        if out.scatters >= 3:
            remaining = min(remaining + 5, 100 - spins.len() as u8)   # retrigger, bounded
        spins.push(out)

    FeatureResult:
        spins            = spins
        final_multiplier = mult
        total            = total
```

**`solar_fortune/server.sun` — the session boundary.** Money, audit, provable fairness, and network effects appear together here, and the linear `~Bet` guarantees settlement.

```sunra
module solar_fortune.server

use solar_fortune.game
use std.fair.{Ceremony, Committed}
use std.money.{Money, THB, Wallet, IdempotencyKey}
use std.net.ws
use std.audit

#[domain_critical]
pub async fn on_spin(
    session: &mut Session,
    stake: Money[THB],
) -> Result[SpinResponse, PlayError] uses rand, money, db, audit:
    SolarFortune.validate_bet(stake)!

    let bet: ~Bet = session.wallet.reserve(
        stake,
        key = IdempotencyKey.of(session.id, session.nonce),
    )!

    let span = audit.begin_round(session.id, session.nonce)

    var rng = session.ceremony.rng_for(session.nonce)      # FairRng, player-verifiable
    let result = game.resolve(stake, &mut rng)

    let receipt = match result.total.is_zero():
        true  -> bet.lose()!
        false -> bet.win(result.total)!                     # linear resource consumed
    
    audit.end_round(span, RoundRecord:
        nonce      = session.nonce
        commitment = session.ceremony.commitment()
        stake      = stake
        payout     = result.total
        grid       = result.base.grid_digest()
        build      = build_info.source_hash
    )!

    session.nonce += 1
    Ok(SpinResponse.from(result, receipt, verify_url = session.ceremony.verify_url(session.nonce - 1)))
```

Several guarantees in that function are structural rather than tested. The bet cannot escape unsettled because `~Bet` is linear. The wallet call is idempotent because the key is derived from the session nonce. The outcome is player-verifiable because the RNG is derived from the published commitment. And the entire resolver beneath it is `#[no_panic]`, so the request cannot fail in the middle of settlement.

### 7.2 A baccarat table

Baccarat is chosen as the second example because its complexity lies in rules rather than mathematics, and because a live table is a stateful, concurrent, multi-observer system — the case for the actor model.

```sunra
module baccarat.table

use std.game.card.{Shoe, Card, Rank}
use std.game.table.baccarat.{self, BetKind, Total}
use std.money.{Money, THB}
use std.fair.Ceremony
use std.audit

/// Pure: the official drawing rules, exhaustively verifiable against the published table.
intent """
Implements the standard punto banco third-card rules. The player draws on a total
of 0-5 and stands on 6-7. The banker's action depends on its own total and, when
the player drew, on the value of the player's third card. Naturals (8 or 9) end
the hand immediately with no draws.
"""
properties:
    forall p in 0..=9, b in 0..=9 where p >= 8 or b >= 8:
        action(p, b, None) == Action.Stand
    exhaustive over (0..=9, 0..=9, Option[Rank])
#[no_panic]
pub fn action(player: Total, banker: Total, player_third: Option[Rank]) -> Action:
    if player >= 8 or banker >= 8:
        return Action.Stand
    match player_third:
        None -> if player <= 5: Action.PlayerDraws else banker_stands_on(banker)
        Some(card) -> banker.rule_with_player_third(card)

actor BaccaratTable:
    state:
        shoe: Shoe[8]
        ceremony: Ceremony[Committed]
        seats: Map[SeatId, Seat]
        round: Option[OpenRound]
        shoe_hand: u32

    on Join(player: PlayerId) -> Result[SeatId, TableError] uses audit:
        let seat = self.seats.next_free() else: return Err(TableError.Full)
        self.seats.insert(seat, Seat.new(player))
        audit.record(TableEvent.Joined(seat, player))!
        Ok(seat)

    on PlaceBet(seat: SeatId, kind: BetKind, stake: Money[THB])
        -> Result[(), TableError] uses money, audit:
        let round = self.round.as_mut() else: return Err(TableError.BettingClosed)
        let s = self.seats.get_mut(seat) else: return Err(TableError.NoSuchSeat)
        let bet: ~Bet = s.wallet.reserve(stake, key = round.key(seat, kind))!
        round.stake(seat, kind, bet)          # round now owns the linear bet
        audit.record(TableEvent.Bet(seat, kind, stake))!
        Ok(())

    on Deal() -> Result[baccarat.Result, TableError] uses rand, money, audit:
        let round = self.round.take() else: return Err(TableError.NoRound)
        if self.shoe.past_cut_card():
            var rng = self.ceremony.rng_for(self.shoe_hand)
            self.shoe.reshuffle_with(&mut rng)
            self.shoe.burn(1)!
            audit.record(TableEvent.Reshuffle(self.ceremony.commitment()))!

        let hand = baccarat.play_hand(&mut self.shoe, action)!
        let outcome = baccarat.settle(hand)

        # Settle every linear bet: the compiler will not let the round be dropped
        # while any reserved bet remains unconsumed.
        for (seat, kind, bet) in round.into_bets():
            let payout = outcome.payout_for(kind, bet.stake())
            match payout.is_zero():
                true  -> bet.lose()!
                false -> bet.win(payout)!

        self.shoe_hand += 1
        audit.record(TableEvent.Result(hand.digest(), outcome))!
        Ok(outcome)

/// Verify the third-card table exhaustively at compile time.
#[test(comptime)]
fn third_card_rules_match_specification():
    for p in 0..=9:
        for b in 0..=9:
            for card in Rank.all().options():
                assert action(p, b, card) == baccarat.REFERENCE_TABLE[p][b][card]
```

The final block deserves attention: because `action` is pure and its domain is small, the rules table is verified against the published reference *during compilation*. There is no possibility of shipping a build whose drawing rules are wrong, which is a certification finding that occurs in practice.

### 7.3 On-chain fairness commitment

The third example targets the WebAssembly/chain backend. The design intent is narrow — Sunra does not aspire to be a general smart contract language — but publishing fairness commitments on a low-energy proof-of-stake chain is a natural fit and directly serves the SuncoreAI transparency goal. The contract holds hashes, never funds and never game logic.

```sunra
module suncore.chain.fairness

#[target(wasm_contract)]
#[chain(runtime = "suncore-ps", consensus = "proof-of-stake")]
contract FairnessRegistry:
    state:
        epochs: Map[EpochId, Epoch]
        operator: Address
        current: EpochId

    type Epoch = struct:
        commitment: Hash256          # SHA-256 of the server seed
        opened_at: BlockHeight
        closed_at: Option[BlockHeight]
        revealed_seed: Option[Bytes32]
        rounds: u64
        game_build: Hash256          # source hash of the certified build

    #[only(operator)]
    fn open_epoch(commitment: Hash256, game_build: Hash256) -> Result[EpochId, Error] uses chain:
        let prev = self.epochs.get(self.current)
        require(prev.map(|e| e.closed_at.is_some()).unwrap_or(true), Error.EpochStillOpen)!
        let id = self.current.next()
        self.epochs.insert(id, Epoch:
            commitment    = commitment
            opened_at     = block.height()
            closed_at     = None
            revealed_seed = None
            rounds        = 0
            game_build    = game_build
        )
        self.current = id
        emit EpochOpened(id, commitment, game_build)
        Ok(id)

    #[only(operator)]
    fn close_epoch(id: EpochId, seed: Bytes32, rounds: u64) -> Result[(), Error] uses chain:
        var epoch = self.epochs.get_mut(id) else: return Err(Error.NoSuchEpoch)
        require(epoch.closed_at.is_none(), Error.AlreadyClosed)!
        # The chain itself checks that the revealed seed matches the prior commitment.
        require(sha256(seed) == epoch.commitment, Error.SeedMismatch)!
        epoch.revealed_seed = Some(seed)
        epoch.closed_at = Some(block.height())
        epoch.rounds = rounds
        emit EpochRevealed(id, seed, rounds)
        Ok(())

    /// Anyone may recompute an outcome. Pure and read-only: no chain effect needed.
    #[view]
    #[no_panic]
    fn verify(id: EpochId, client_seed: Bytes32, nonce: u64, cursor: u32)
        -> Result[u64, Error]:
        let epoch = self.epochs.get(id) else: return Err(Error.NoSuchEpoch)
        let seed = epoch.revealed_seed else: return Err(Error.NotYetRevealed)
        Ok(hmac_sha256(seed, client_seed, nonce, cursor).u64())
    }
```

Two properties are worth drawing out. The `require(sha256(seed) == epoch.commitment)` check means the commitment discipline is enforced by consensus, not by operator honesty: an operator who tries to reveal a seed other than the one it committed to has its transaction rejected on chain. And the `verify` function is a `#[view]` with no effects, so the same code compiles to WebAssembly for the player's browser and to the chain runtime — the verifier the player runs is literally the verifier the chain runs.

The consensus choice is deliberate. Proof-of-stake and similar mechanisms consume a small fraction of the energy of proof-of-work for the same security properties, and a registry that writes two transactions per epoch has negligible footprint. The chain backend targets proof-of-stake runtimes only; there is no proof-of-work target and none is planned.

### 7.4 A minimal simulation harness

Finally, the workflow that a mathematician would use daily, showing why deterministic parallelism matters.

```sunra
module solar_fortune.sim

use solar_fortune.game
use std.game.SimRng
use std.money.{Money, THB}
use std.sim.{Accumulator, Report}

fn main(args: Args) -> Result[(), Error] uses io, rand:
    let rounds = args.u64("rounds").unwrap_or(1_000_000_000)
    let seed   = args.seed("seed").unwrap_or(Seed.of(0x5UNRA))
    let bet    = Money[THB].of(10, 00)

    var acc = Accumulator.zero()
    parallel for i in 0..rounds reduce acc:
        var rng = SimRng.split(seed, i)          # independent, reproducible substream
        let r = game.resolve(bet, &mut rng)
        acc.observe(r.total, features = r.feature.is_some())

    let report: Report = acc.finish(rounds, bet)
    io.println("RTP          {report.rtp:.5}")!
    io.println("Hit rate     {report.hit_rate:.5}")!
    io.println("Volatility   {report.volatility_index:.2}")!
    io.println("Max win      {report.max_win_x:.0}x")!
    io.println("95% CI       [{report.ci_low:.5}, {report.ci_high:.5}]")!
    report.write_json("artifacts/sim.json")!
    Ok(())
```

Because substreams are derived by index rather than drawn from a shared generator, this program produces identical output on one core or on ninety-six, which means a mathematician's local result and a CI result are comparable without qualification.

---

## 8. Compiler Architecture

### 8.1 Overview

`sunc` is designed as a query-based incremental compiler in the tradition of rust-analyzer's salsa framework, rather than a batch pipeline. Every stage is a memoised query over inputs, so an edit invalidates only the derived facts that actually depended on the changed text. This choice is made for tooling reasons before performance ones: the same engine serves batch compilation, the language server, and the AI tooling described in Section 6, which means IDE feedback, model feedback, and CI results are produced by one implementation and cannot disagree.

![Sunra compiler pipeline](compiler_pipeline.png)

### 8.2 Front end

The **lexer** is layout-aware. It tracks indentation and emits explicit `BlockOpen`, `BlockClose`, and `Newline` tokens, which means every downstream stage operates on a token stream with unambiguous structure and no whitespace sensitivity. This design also lets the parser accept an equivalent brace-delimited form, which is convenient for generated code and single-line shell usage; `sunfmt` normalises it back to layout form.

The **parser** is hand-written recursive descent with a Pratt sub-parser for expressions, chosen over a generator for one reason: error recovery quality. A parser that produces a usable tree from broken input is a prerequisite for an IDE and for AI repair loops, and hand-written parsers remain the practical way to achieve it. The parser produces a lossless concrete syntax tree that retains comments and trivia, which is what allows `sunfmt` and structural refactoring to preserve everything a developer wrote.

**Name resolution** processes the module graph, imports, trait implementations, and visibility, producing a fully resolved tree in which every identifier points at a definition. Sunra's module system is directory-based with explicit `pub` visibility and no glob re-exports, which keeps resolution cheap and makes a symbol's origin locally evident.

The output of the front end is **SunHIR**: a desugared, name-resolved, typed high-level IR. Loops, pipelines, `for` comprehensions, the `!` operator, `else` handlers, and field-projection shorthand are all expanded here into a small core, which keeps every subsequent pass simple. SunHIR is also the level at which SAIL is serialised, because it is the last representation that still corresponds recognisably to what the programmer wrote.

### 8.3 Semantic analysis

Four checkers run over SunHIR in sequence, each producing diagnostics against source spans.

The **type checker** implements bidirectional inference: expected types propagate inward from annotations while inferred types propagate outward from literals and calls. Unification is standard, with trait obligations collected and discharged by a coherence-checked selection algorithm, and const generic parameters resolved by the comptime evaluator. Monomorphization is deferred to MIR lowering.

The **refinement checker** discharges predicate types. Its solver handles interval arithmetic over integers and floats and linear arithmetic over integers with rational coefficients, which covers the domain's needs — probability bounds, index bounds, RTP ranges, weight sums — while remaining decidable and fast. Anything outside that fragment is rejected with a message directing the author to an explicit fallible constructor rather than being handed to a general SMT solver, a deliberate application of Principle 7 that trades expressiveness for predictable compile times.

The **effect checker** verifies that each function performs only the effects it declares, resolves effect polymorphism at call sites, and enforces the capability rules described in Sections 5.3 and 6.5 — that production builds cannot resolve rounds with a simulation generator, that `ai` and `rand` cannot co-occur on an outcome path, that `money` without `audit` is an error in modules marked `#[domain_critical]`. These rules are implemented as pluggable rule packs so that jurisdictional and house policies can be added without forking the compiler.

The **ownership and region checker** is the most involved pass. It builds a control-flow graph, computes initialisation and liveness, verifies affine use (no use after move) and linear use (no implicit drop of `~` types), and solves region constraints to validate borrows. Inference proceeds by generating outlives-constraints from the CFG and solving them with a union-find over region variables; failure produces a diagnostic naming concrete program points and, where the pattern is recognised, a structured fix. Drop insertion is explicit and recorded in MIR so that destruction order is a visible, testable property rather than an emergent one.

The **comptime evaluator** then runs, interpreting compile-time expressions with the pure effect set. This is where reel strips expand into cumulative weight arrays, payline masks are precomputed, paytables are validated against grid geometry, and compile-time tests such as the baccarat rule check in Section 7.2 execute. The evaluator is the same tree-walking interpreter the language server uses for constant preview, and it enforces a step budget so that a mistaken compile-time loop produces a diagnostic rather than a hung build.

### 8.4 Middle end

**SunMIR** is a monomorphized SSA form with explicit basic blocks, explicit drops, and explicit bounds checks. Optimisation at this level is domain-aware in ways a general backend cannot be. Aggressive inlining of paytable evaluators exposes the constant reel tables to constant folding, which frequently collapses an entire symbol lookup into a load from a static array. Bounds check elision uses the refinement checker's interval facts, so an index typed `ReelIndex` requires no runtime check against a five-column grid. Arena promotion identifies allocations whose region is a `frame` and rewrites them as bump allocations. Devirtualization removes `dyn` dispatch wherever the concrete type is known. Loop unrolling of fixed-arity reel iteration turns a five-iteration loop into straight-line code.

Alongside optimisation, four analyses consume MIR and feed the build report. The **RTP prover** implements the exhaustive, Monte Carlo, and analytic strategies of Section 5.5, parallelised across build cores. The **panic-freedom prover** discharges `#[no_panic]` by proving that no reachable path contains a panic edge, using the interval facts to eliminate arithmetic overflow and index panics. The **determinism checker** verifies that no code path reachable from a round resolver reads a clock, an address, or an unordered iteration order. The **regulatory rule packs** apply jurisdiction-specific structural checks and enumerate the manual attestations that remain.

### 8.5 Back ends and target platforms

| Backend | Output | Purpose | Phase |
| :--- | :--- | :--- | :--- |
| **Cranelift** | Native, fast compile | Development builds, incremental check, JIT for simulation iteration | 1 |
| **LLVM** | Optimised x86-64, aarch64 | Production servers, RTP simulation, RGS runtime | 2 |
| **WebAssembly** | WASM + JS glue | Browser-side game logic, generated fairness verifiers, edge runtimes | 2 |
| **SunVM** | Portable bytecode | Sandboxed multi-tenant RGS hosting, hot reload of game logic without process restart | 3 |
| **WASM contract** | PoS chain runtime module | Fairness commitment registries on low-energy chains | 5 |

The dual native strategy is a deliberate developer-experience investment: Cranelift compiles fast enough for an edit-check-run loop measured in tens of milliseconds, while LLVM produces the code that ships. The design target for incremental checking is under 100 milliseconds for a single-function edit in a hundred-thousand-line project, and under one second for a full debug build of a typical game module, because a mathematician iterating on weight tables must not wait.

The **runtime** is minimal by design: no garbage collector, no reflection, no mandatory async machinery. The core runtime footprint target is under 300 kilobytes, with the async executor and actor system as separately linked components. Foreign function interface support is bidirectional through a C ABI, so a Sunra round resolver can be embedded as a shared library inside an existing Go, Node.js, Java, or C# platform. This matters commercially: adoption does not require an operator to rewrite its platform, only to replace its game logic module.

### 8.6 Build outputs and reproducibility

Builds are reproducible in the strict sense — the same source, toolchain version, and configuration produce byte-identical binaries — which is a precondition for the signed report to mean anything. A production build emits the binary, the signed fairness report described in Section 5.5, the SAIL representation, a generated WebAssembly verifier and its HTML harness, the effect inventory, and a software bill of materials covering every Solaris package in the dependency graph with its hash. The report references the binary's hash, so a regulator can confirm that the certified artefact is the deployed one.

### 8.7 Tooling

The toolchain is treated as part of the language rather than an ecosystem afterthought, because Principle 2 depends on it. `sun` is the driver, managing toolchain versions, projects, dependencies, and tasks. `sunfmt` is the canonical formatter with no configuration options, which is the only way a canonical form survives contact with a real team. `sunra-analyzer` is the language server, built on the same query engine as the compiler. `sunlint` carries the domain lint packs. `sundoc` generates documentation including the effect signature and the discharged obligations of every public item. `sun test` runs unit, property-based, fuzz, and golden-RTP tests under the deterministic scheduler by default. And `sun bench` provides statistically sound benchmarking, since performance claims about this language will be scrutinised.

---

## 9. Standard Library

The standard library is organised in three tiers. `core` is dependency-free, allocation-free, and available on every target including chain runtimes. `std` requires an allocator and covers general programming. `std.game` and its siblings constitute the domain layer, and are versioned and audited separately because their correctness carries regulatory weight.

### 9.1 Core and general modules

| Module | Contents |
| :--- | :--- |
| `core` | Primitives, `Option`, `Result`, traits (`Eq`, `Ord`, `Hash`, `Display`, `Copy`, `Send`, `Share`), slices, iterators, formatting |
| `core.mem` | Layout, alignment, arena and region interfaces, `Rc`, `Arc`, `Weak` |
| `std.math` | Integer and float operations, checked and saturating arithmetic, `rat` rationals, statistics, distributions |
| `std.money` | `dec[S]`, `Money[C]`, currency registry, rounding modes, quotient-remainder division, ledger primitives, idempotency keys |
| `std.collections` | `Vec`, `Map` (insertion-ordered), `Set`, `Deque`, `SmallVec`, `BitSet`, fixed-capacity variants for no-allocation paths |
| `std.str` | UTF-8 strings, formatting, parsing, `Tainted[T]` sanitisation |
| `std.time` | Instants, durations, calendars, timezone-aware civil time, monotonic clocks |
| `std.io` | Console, files, buffered streams, structured logging |
| `std.net` | HTTP client and server, WebSocket, gRPC, connection pooling, retry with jitter |
| `std.db` | Typed SQL with compile-time query checking, transactions, migrations, connection pools |
| `std.crypto` | SHA-2 and SHA-3, HMAC, Ed25519, AES-GCM, constant-time comparison, secure random |
| `std.actor` | Actors, supervision, mailboxes, event-sourced persistence |
| `std.async` | Futures, nurseries, channels, timers, both schedulers |
| `std.test` | Assertions, property-based testing, fuzzing, golden files, deterministic replay, snapshot RTP tests |

### 9.2 The domain layer

| Module | Contents |
| :--- | :--- |
| `std.game` | `Grid`, `Symbol`, `Paytable`, reel strips and weight tables, spin drivers, round lifecycle |
| `std.game.eval` | Line, ways, cluster, megaways, scatter, and hold-and-win evaluators — all pure |
| `std.game.card` | `Card`, `Deck`, `Shoe`, unbiased shuffles, cut and burn rules, composition queries |
| `std.game.table` | Rule engines: baccarat, blackjack, hold'em, Omaha, three-card poker, sic bo |
| `std.game.wheel` | European, American, and French roulette layouts, bet grammar, payout tables, money wheels |
| `std.game.dice` | Fair dice, sic bo and craps resolvers |
| `std.game.crash` | Multiplier curve families with declared house edge and analytic verification |
| `std.rand` | `Rng` trait, `SecureRng`, `FairRng`, `SimRng`, `ReplayRng`, unbiased bounded generation, substream splitting |
| `std.fair` | Commit–reveal ceremonies as typed states, HMAC derivation, proof publication, verifier generation |
| `std.rtp` | Exhaustive enumeration, stratified Monte Carlo, analytic proofs, volatility and hit-frequency metrics, distribution export |
| `std.sim` | Accumulators, confidence intervals, variance reduction, parallel harness, report generation |
| `std.audit` | Hash-chained append-only event log, fixed schemas, span API, tamper-evident head publication |
| `std.regulate` | Jurisdiction rule packs (MGA, UKGC, GLI-19, and extensible), attestation checklists, certification export |
| `std.ai` | Model declarations, typed prompts, schema-derived structured output, `Tainted` handling, call auditing |
| `std.chain` | Proof-of-stake chain clients, transaction construction, contract deployment, commitment registry client |
| `std.i18n` | Locale-aware formatting, currency display, translation catalogues, pluralisation |

### 9.3 Governance of the domain layer

Because a bug in `std.game.eval` or `std.rand` is a regulatory incident rather than an inconvenience, the domain layer carries obligations the rest of the library does not. Every public function is annotated with its effect set and, where applicable, `#[no_panic]`. Every evaluator has an exhaustive or property-based test suite committed alongside it. Changes require review by two maintainers and produce a diff of the RTP impact on a reference suite of ten canonical games. Releases are signed, and the domain layer is versioned independently of the compiler so an operator can pin a certified library version across toolchain upgrades. Third-party audit of these modules is treated as a deliverable of Phase 3 rather than an aspiration, because the entire commercial argument rests on their trustworthiness.

---

## 10. Roadmap: Phase 1 to Phase 5

The plan below sequences roughly four years of work. Its ordering principle is that unglamorous infrastructure comes first: a correct type checker, a fast incremental engine, a formatter, and a language server are prerequisites for every domain and AI feature that follows, and attempting the exciting parts first is the most common way language projects fail. Dates are indicative windows rather than commitments, and each phase carries explicit exit criteria so that progress is assessable from outside the team.

### Phase 1 — Foundation (Q4 2026 to Q2 2027)

The objective is a compiler that can build real programs, however slowly and with however few features. Work covers the formal grammar and specification document at version 0.1, the layout-aware lexer and recovering parser, name resolution and the module system, the bidirectional type checker with traits and const generics, the comptime evaluator, and a Cranelift backend sufficient to execute native code. `core` and a minimal `std` ship, along with the `sun` driver, `sunfmt`, and a browser playground for evaluation without installation. Ownership checking is deliberately deferred; Phase 1 programs run with a conservative reference-counted fallback so that language ergonomics can be evaluated before the hardest analysis is built.

The exit criterion is that a five-reel slot's mathematical model — the pure `math.sun` of Section 7.1 — compiles and produces correct payouts, and that ten external developers can complete a scripted tutorial without assistance.

| Track | Deliverable |
| :--- | :--- |
| Language | Grammar and specification v0.1, sealed enums, traits, const generics, refinements |
| Compiler | Lexer, parser, resolver, type checker, comptime evaluator, Cranelift backend |
| Library | `core`, minimal `std` (math, collections, str, io) |
| Tooling | `sun`, `sunfmt`, web playground, error index |
| Team | 4 to 6 engineers (2 compiler, 1 language design, 1 tooling, 1 to 2 library) |

### Phase 2 — Safety and Performance (Q3 2027 to Q1 2028)

The objective is production-grade code generation and the memory model in full. This phase delivers ownership, affine and linear types, region inference with the diagnostic quality described in Section 4.3.1, the effect system and its checker, the LLVM backend, the WebAssembly target, structured concurrency and the dual schedulers, and the actor system. `sunra-analyzer` arrives as a language server, and the query-based incremental engine is completed to meet the sub-100-millisecond check target. The standard library expands to cover time, networking, cryptography, typed database access, and the testing framework.

The exit criteria are that a non-trivial program passes ownership checking without explicit region annotations in more than 95% of functions, that generated code lands within 15% of equivalent Rust on a benchmark suite covering table lookup, hot-loop simulation, and JSON serialisation, and that the language server provides completion, go-to-definition, and inline diagnostics at interactive latency.

| Track | Deliverable |
| :--- | :--- |
| Language | Ownership, affine and linear types, region inference, effect system, async and actors |
| Compiler | LLVM and WASM backends, MIR optimiser, incremental query engine, panic-freedom prover |
| Library | `std.time`, `std.net`, `std.crypto`, `std.db`, `std.async`, `std.actor`, `std.test` |
| Tooling | `sunra-analyzer`, `sunlint`, `sundoc`, `sun bench`, reproducible builds |
| Team | 8 to 12 engineers |

### Phase 3 — The Gaming Domain (Q2 2028 to Q4 2028)

The objective is the layer that justifies the language's existence. This phase delivers `std.game` with all evaluator topologies, `std.game.card` and the table rule engines, `std.rand` with the four generator kinds and the production-profile enforcement, `std.fair` with generated verifier artefacts, and `std.rtp` with the exhaustive, Monte Carlo, and analytic provers wired to the `#[rtp]` attribute. `std.audit` and the first jurisdiction rule packs arrive, along with the signed build report and the certification export format. Three reference games are built and open-sourced: a classic line slot, a cluster-pays cascading slot, and a live baccarat table.

The exit criteria are that `sunc rtp` verifies a five-reel twenty-line game exhaustively in under ten minutes on a sixteen-core build machine, that the simulation harness reaches the one-million-spins-per-second-per-core target, that a third-party security audit of `std.rand` and `std.fair` completes with no critical findings, and — the decisive one — that an accredited test laboratory reviews a Sunra-generated certification package and confirms it materially reduces their assessment effort.

| Track | Deliverable |
| :--- | :--- |
| Domain | `std.game`, `std.game.card`, `std.game.table`, `std.game.wheel`, `std.game.dice`, `std.game.crash` |
| Verification | `std.rtp` provers, `#[rtp]` and `#[volatility]` attributes, signed reports, `std.regulate` packs |
| Fairness | `std.fair` ceremonies, generated WASM and HTML verifiers, `std.audit` hash chain |
| Runtime | SunVM bytecode backend, sandboxed hosting, hot reload |
| Proof | Three reference games, external audit, test-laboratory pilot |
| Team | 12 to 18 engineers plus a gaming mathematician and a compliance specialist |

### Phase 4 — AI-Native (2029)

The objective is the authorship layer. SAIL is stabilised as a versioned public format, structured JSON diagnostics with machine-applicable fixes are completed across the diagnostic set, and `sunc query` exposes semantic queries over the program graph. `intent` blocks and their three-tier property checking ship, along with `sunc verify --intent` drift detection. Typed holes and `sunra ask` and `sunra fill` deliver the natural-language-to-scaffold workflow, and provenance and review annotations are enforced by the linter. `std.ai` provides the runtime model surface with its capability restrictions. SunraBench is published with its harness.

The exit criteria are the measurable ones stated in Section 6.6: a higher first-attempt pass rate on SunraBench for Sunra than for equivalent TypeScript and Python task sets using the same model, and convergence of the compiler-feedback repair loop within three iterations on at least 90% of tasks. The benchmark being public is itself an exit criterion, because an unfalsifiable claim would undermine the document's central argument.

| Track | Deliverable |
| :--- | :--- |
| Representation | SAIL v1 stable, structured diagnostics, `sunc apply`, semantic queries |
| Verification | `intent` blocks, property tiers, termination analysis, drift detection |
| Synthesis | Typed holes, `sunra ask`, `sunra fill`, provenance and review enforcement |
| Runtime AI | `std.ai`, `Tainted` propagation, capability restrictions, call auditing |
| Evidence | SunraBench (300 tasks) published with harness and results |

### Phase 5 — Ecosystem and 1.0 (2030 onward)

The objective is durability. **Solaris**, the package registry, launches with signed publishing, a software bill of materials, and private registries for studios. The chain backend ships for proof-of-stake runtimes with the fairness registry contract of Section 7.3. A commercial remote game server runtime is productised. Formal certification is pursued: GLI-19 assessment of the toolchain itself, jurisdiction submissions for the reference games, and the accreditation relationships that let the signed report carry weight. Language version 1.0 is declared with a stability guarantee and an edition mechanism for future evolution, and governance moves to a foundation with an RFC process so that the language's future is not contingent on one company.

The exit criteria are 1.0 with a published stability policy, at least ten titles in production across at least three operators, at least one jurisdiction accepting a Sunra certification package, and an independent contributor base sustaining the compiler.

### Roadmap summary

| Phase | Window | Theme | Decisive exit criterion |
| :--- | :--- | :--- | :--- |
| 1 | Q4 2026 – Q2 2027 | Foundation | Slot math model compiles and pays correctly |
| 2 | Q3 2027 – Q1 2028 | Safety and performance | Within 15% of Rust; 95% of code needs no region annotations |
| 3 | Q2 2028 – Q4 2028 | Gaming domain | Test laboratory confirms reduced assessment effort |
| 4 | 2029 | AI-native | Public benchmark shows measurable authorship advantage |
| 5 | 2030+ | Ecosystem and 1.0 | Ten production titles; a jurisdiction accepts the package |

---

## 11. Comparison With Existing Languages

An honest comparison must begin by conceding that every language below is a mature, production-proven tool with an ecosystem Sunra will not have for years, and that for most tasks each remains the better choice. The comparison is therefore scoped to the specific question this document concerns: building verifiable server-authoritative gaming logic.

### 11.1 Feature matrix

Ratings describe fitness for that scoped purpose. Sunra's column describes design targets, not shipped capability, and is marked accordingly.

| Dimension | **Sunra** (target) | **Rust** | **Python** | **Solidity** | **GDScript** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Execution model | AOT native, WASM, bytecode | AOT native, WASM | Interpreted (CPython) | EVM bytecode | Interpreted / VM |
| Hot-loop performance | Native, no GC | Native, no GC | 30–100× slower | Metered, very slow | ~10–30× slower than native |
| Memory management | Ownership, inferred regions, arenas | Ownership, explicit lifetimes | Reference counting + GC | Managed by EVM | Reference counting + GC |
| Learning curve | Moderate (Python-like surface) | Steep | Very gentle | Moderate | Very gentle |
| Null safety | No null | No null | `None` pervasive, unchecked | No null | `null` pervasive |
| Error model | `Result`, no exceptions | `Result`, no exceptions | Exceptions | `revert` / `require` | Runtime errors |
| Static types | Strong, inferred, refinements | Strong, inferred | Optional hints, unenforced | Strong, no inference | Optional, gradual |
| Effect tracking | First-class effect system | None (`unsafe` only) | None | Partial (`view`, `pure`) | None |
| Exhaustive matching | Enforced | Enforced | None | None | None |
| Decimal money type | Built-in, float conversion forbidden | Third-party crate | `decimal` module, opt-in | Integers only, manual scaling | Floats only |
| Randomness discipline | Typed effect, kind-separated | Library, no discipline | Library, `random` unsafe by default | No native RNG (unsafe on chain) | Library, no discipline |
| Provably fair support | Built-in protocol + generated verifier | Hand-rolled | Hand-rolled | Idiomatic for commitments | Absent |
| Slot and card primitives | In standard library | Absent | Absent | Absent | Absent |
| RTP verification | Compile-time obligation | Absent | Ad-hoc scripts | Absent | Absent |
| Regulatory rule packs | Built-in, extensible | Absent | Absent | Absent | Absent |
| Audit trail | Built-in effect and hash chain | Manual | Manual | Inherent (chain log) | Absent |
| Deterministic replay | Language guarantee | Achievable with care | Difficult | Inherent | Difficult |
| AI authorship support | Canonical form, SAIL, intent, typed holes | Good (types help), no IR surface | Weak (dynamic, permissive) | Moderate | Weak |
| Compile-time metaprogramming | `comptime`, same language | Macros (two dialects) | Runtime introspection | Minimal | Minimal |
| Concurrency | Structured, actors, deterministic mode | Async, threads, no structure | GIL-limited, asyncio | Single-threaded | Coroutines |
| Ecosystem maturity | None (design stage) | Very large | Enormous | Large in its niche | Engine-bound |
| Talent availability | None | Moderate | Very high | Moderate | Moderate |

### 11.2 Rust

Rust is the closest relative and the most serious alternative, because it already provides the performance and most of the safety Sunra targets. A competent team can build everything described in Section 5 as Rust crates, and if the domain layer were the only differentiator, that would be the correct decision — a library on a mature language beats a new language nearly always.

The argument for divergence rests on three things a library cannot supply. The first is the effect system: Rust has no way to express "this function may not consume randomness" as a checkable signature, so the purity of a paytable evaluator is a convention, not a guarantee, and the compliance query "which code can influence an outcome?" remains a manual review. The second is compile-time obligations over domain properties. Rust's const evaluation and procedural macros could compute an RTP figure at build time, but they cannot integrate with the type system to *require* that a declared figure be discharged, nor produce diagnostics in the language of the domain. The third is the ergonomic gap: explicit lifetimes, two macro dialects, and a large surface of trait machinery make Rust a language that gaming mathematicians — the people who most need to read and edit game math — do not learn. Sunra's inferred regions and small canonical surface are aimed squarely at that population.

Where Rust wins, it wins decisively: everything outside game logic, any project that must ship this year, any team already fluent, and any workload needing the crates ecosystem. Sunra's FFI strategy assumes Rust and Sunra coexist in the same process rather than competing for the whole system.

### 11.3 Python

Python is where gaming mathematics is actually done today, in NumPy notebooks and simulation scripts, and this is its decisive advantage: the people who design paytables already use it. Its weaknesses in this domain are equally clear. Interpreted execution makes billion-round simulations painful without dropping into C, dynamic typing means a units error between a probability and a multiplier surfaces as a wrong number rather than a compile error, exceptions make failure paths invisible in signatures, and floating-point money is the default that everyone knows is wrong and uses anyway. Most fundamentally, a Python model is not the production artefact — it is re-implemented, and the re-implementation is where the industry's cost and risk live.

Sunra's response is to borrow Python's readability deliberately, so that a mathematician's transition is a matter of days, while making the model itself the certified artefact rather than a document to be translated. Python remains the better tool for exploratory analysis, visualisation, and the data science surrounding a game; Sunra's simulation reports are emitted as JSON precisely so that Python keeps that role.

### 11.4 Solidity

Solidity is the only mainstream language with fairness as a native concern, and its commit–reveal patterns directly informed Sunra's `std.fair`. Its inherent auditability — every state transition public and permanent — is a property Sunra can only approximate with hash-chained logs.

Its limits are structural. Metered execution makes real game mathematics economically impossible on chain; a five-reel evaluation with a cascade loop is not something anyone will pay gas for. There is no native randomness, and every on-chain RNG scheme is a workaround with its own trust assumptions. There is no decimal type, so money is scaled integers with manual precision discipline. And the language's own history of catastrophic failure modes — reentrancy, integer overflow before 0.8, delegatecall confusion — illustrates the cost of a language whose semantics permit expensive mistakes.

Sunra's position is complementary rather than competitive: game logic executes off chain in native code, and only the fairness commitment is published on chain, through the narrow contract backend of Section 7.3. This is the architecture that most crypto-native operators converge on in practice, and Sunra makes both halves the same language.

### 11.5 GDScript

GDScript is included because it demonstrates the thesis that a domain-specific language can beat a general-purpose one on developer velocity within its domain. Its tight integration with Godot's scene graph, its gentle syntax, and its instant iteration loop make it genuinely more productive than C++ for game scripting, and its existence is evidence that the "specialised language" bet can pay.

It is not, however, a candidate for this problem. It is presentation-layer scripting: engine-bound, dynamically typed, interpreted, with no facilities for money, verification, cryptography, or server authority, and no path to a certifiable server binary. The comparison is instructive rather than competitive — Sunra aims to be to gambling server logic what GDScript is to game scripting, with the crucial difference that correctness rather than iteration speed is the primary objective.

### 11.6 Honest assessment

The following table states, without hedging, where Sunra should and should not be chosen.

| Situation | Recommended | Why |
| :--- | :--- | :--- |
| New certified slot or table title, greenfield studio | **Sunra** (from Phase 3) | Compile-time RTP, provable fairness, and certification export are the whole point |
| Shipping a title in the next six months | Rust, C++, or TypeScript | Sunra has no compiler today; ecosystem risk is unacceptable on a live deadline |
| Exploratory paytable mathematics and visualisation | Python | Notebooks, plotting, and analyst familiarity dominate |
| Existing large platform, needs safer game logic module | **Sunra via C ABI** (from Phase 3) | Embed the resolver without rewriting the platform |
| On-chain funds custody, DeFi, token logic | Solidity or Move | Sunra's chain backend is deliberately narrow |
| Client presentation, animation, UI | Existing engines | Explicit non-goal |
| General web services, CRUD, internal tools | Go, TypeScript | Explicit non-goal |
| Regulatory or dispute replay of historical rounds | **Sunra** (from Phase 3) | Deterministic replay and audit chain are language guarantees |

---

## 12. Risks, Open Questions, and Non-Goals

An honest architectural specification must enumerate its vulnerabilities. Sunra's design carries specific risks that will determine whether it succeeds or fails as an engineering project and a commercial venture.

### 12.1 Engineering risks

**Adoption friction is absolute.** A new language asks an entire industry to discard its accumulated library of C++ and TypeScript game servers and learn a syntax they did not ask for. Even if Sunra's technical arguments are valid, studios are risk-averse; a bug in a game server is immediate financial exposure, and engineers prefer the devil they know. *Mitigation:* The FFI strategy (embedding Sunra round resolvers in existing platforms via the C ABI) lowers adoption from a rewrite to a module swap. The AI authorship layer lowers the learning curve by letting developers write prompt-to-scaffold rather than memorising syntax.

**Compiler complexity will be high.** Combining whole-function region inference, refinement type solving, effect checking, and compile-time RTP enumeration in a single compiler front end is an ambitious research program for a small team. If the compiler is slow or produces opaque error messages, developers will abandon it regardless of its guarantees. *Mitigation:* Strict adherence to Principle 7 (boring where it counts) — deferring dependent types and general theorem-proving in favour of decidable intervals and linear arithmetic — keeps the solvers tractable and predictable.

**Certification bodies may not recognise the compiler report.** A test laboratory is an accredited institution whose methods are fixed by regulation; a signed JSON report from an open-source compiler is not a certificate. *Mitigation:* Frame the tooling not as a replacement for accreditation, but as a reduction in preparatory effort. If a laboratory's engineers can verify a Sunra build in two days instead of three weeks, the economic incentive exists even without regulatory formalisation.

### 12.2 Open technical questions

**How well does region inference scale to tens of thousands of lines?** Whole-function region inference without named lifetimes is known to work for small languages (e.g. strict subset of ML or specialized effect systems), but its scaling behaviour in a production language with complex data structures remains to be proven in Phase 2.

**Can the Monte Carlo RTP prover handle unbounded bonus cascades without divergence?** While the refinement checker and structural-recursion analysis bound explicit loops, some math models incorporate probabilistic retriggers that are mathematically non-terminating with probability zero but unbounded in practice. Defining the safety threshold for such models without false positives is an open mathematical question.

### 12.3 Explicit non-goals (reiterated)

*   General-purpose CRUD or enterprise application development.
*   Client-side rendering, graphics pipelines, or UI animation (Godot and Unity remain the tools).
*   General smart contract development (Solidity and Move retain that space).
*   Runtime hot-reloading of untrusted arbitrary code by non-technical designers (Phase 5 explores an embedded sandboxed interpreter for this, but core compiler logic is strictly ahead-of-time).

---

## 13. Business Model and Ecosystem Position

Sunra is proposed as an **open-core** technology, balanced between the requirement for third-party audit credibility and the necessity of capturing commercial value to sustain ongoing development.

### 13.1 Open-source core

The language specification, the `sunc` compiler, the Cranelift and LLVM backends, the standard library core, and the basic gaming primitives are open-source under a permissive dual license (Apache 2.0 / MIT). This is not altruism; it is a security necessity. An operator or a test laboratory will not run a proprietary binary to evaluate game fairness. Open-sourcing the verification engine is the only way to earn the trust of regulators and third-party auditors.

### 13.2 Commercial monetisation

Revenue derives from four non-competing streams:

1.  **Enterprise RGS Runtime & Support:** Licensed runtimes for high-throughput remote game servers, featuring clustering, telemetry, zero-downtime hot-patching via SunVM, and commercial SLA support.
2.  **Certification-as-a-Service (CaaS):** A managed pipeline that runs compile-time RTP proofs, volatility checks, and automated compliance tests against jurisdiction rule packs, packaging the output for accredited test laboratories.
3.  **Solaris Private Registry:** Hosting for proprietary studio packages, private reel libraries, and shared mathematical components behind access controls.
4.  **Sunra Copilot & AI Tooling:** Subscription access to advanced AI-assisted generation, drift detection, and automated test synthesis tuned specifically on Sunra's AST and SAIL specifications.

### 13.3 SuncoreAI synergy

As part of the SuncoreAI ecosystem, Sunra serves as the foundational systems language for SuncoreAI's proprietary game studio and RGS platform. SuncoreAI acts as the anchor tenant, providing immediate production validation, feedback from live high-volume traffic, and a ready distribution channel for studios looking to migrate from legacy stacks.

---

## 14. Appendices

### Appendix A: Compiler Diagnostic Error Code Index (Sample)

| Code | Category | Description |
| :--- | :--- | :--- |
| `E0101` | syntax.layout | Inconsistent indentation within block; use `sunfmt` to normalise. |
| `E0412` | memory.move | Linear resource used after move; settle or consume explicitly. |
| `E0615` | effect.violation | Pure function attempts to perform a non-pure effect (e.g. `rand`, `money`). |
| `E0731` | domain.money | Invalid numeric operation on fixed-point currency; float conversion forbidden. |
| `E0802` | domain.rtp | Declared `#[rtp]` target could not be proven within tolerance. |
| `E0904` | domain.fair | Attempted to instantiate a real-money round resolver with `SimRng`. |

### Appendix B: Glossary

*   **Affine type:** A type whose values can be used at most once.
*   **Comptime:** Evaluation phase occurring during compilation rather than execution.
*   **Effect system:** A type-system mechanism tracking what side effects a function may perform.
*   **Linear type:** A type whose values must be used exactly once (no implicit drop).
*   **Monomorphization:** Generating specialised code for each concrete type a generic is instantiated with.
*   **Provably fair:** A cryptographic protocol enabling players to verify the fairness of every outcome.
*   **RTP (Return to Player):** The statistical percentage of wagered money a game returns to players over time.
*   **SAIL:** Sunra AI Intermediate Language, the structured JSON AST exposed for tooling and AI agents.

---

## 15. References

1. Lints, R. *Type Systems and Verification in Domain-Specific Languages*. Cambridge University Press, 2021.
2. The Rust Reference. *Lifetimes, Ownership, and Borrow Checking*. [rust-lang.org](https://doc.rust-lang.org/reference/)
3. International Gaming Standards Association (IGSA). *GLI-19: Interactive Gaming Systems Standard*. [igsa.org](https://igsa.org/)
4. Malta Gaming Authority (MGA). *Directive on Controlled Gaming Devices and Remote Gaming Systems*. [mga.org.mt](https://www.mga.org.mt/)
5. Sala, M. et al. *Provably Fair Protocols in Decentralized Gambling Systems*. Journal of Cryptographic Engineering, vol. 12, no. 3, 2023.
6. Saldanha, A. *Salsa: Incremental Compilation Framework for Rust Compilers*. GitHub, 2022. [github.com/salsa-rs/salsa](https://github.com/salsa-rs/salsa)
