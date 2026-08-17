# Sunra

**Sunra** is an AI-first, safety-oriented programming language and reference compiler for verifiable game logic. It combines a concise language surface with deterministic execution, gaming primitives, provably fair workflows, and a multi-target compilation pipeline.

> **Status:** This repository is an actively developed reference implementation. It is suitable for research, prototyping, and controlled evaluation. It is not a substitute for independent security, regulatory, or mathematical certification before production deployment.

## Why Sunra

Sunra is designed for systems where **correctness, reproducibility, and auditability** matter. Its core model pairs readable syntax with domain-focused primitives for game rules, randomness, fixed-point money, RTP analysis, and deterministic execution.

| Area | Capability |
|---|---|
| Language core | Lexer, parser, type checker, diagnostics, effects, refinement checks, and ownership analysis |
| Runtime | Interpreter, sandboxed SunVM, deterministic seeds, bounded execution, and fixed-point Money values |
| Gaming primitives | Reels, cards, decks, baccarat, poker, dice, RTP, and provably fair ceremonies |
| Compilation | SunHIR, SAIL, SunMIR, optimization, LLVM, Cranelift, SunVM, and WASM-contract targets |
| Verification | Panic-freedom, determinism, compliance rule packs, and signed build reports |

## Architecture

```text
Sunra source (.sun)
        |
        v
  Lexer -> Parser -> Type & Effect Checker
        |                    |
        v                    v
      SunHIR ----------> Diagnostics
        |
        v
      SunMIR -> Optimizer -> Verification Gates
        |
        +--> LLVM / Cranelift      Native-oriented output
        +--> SunVM                 Sandboxed bytecode
        +--> WASM Contract         Deterministic contract artifact
        +--> SAIL                  Typed semantic JSON
```

## Getting started

**Requirements:** Node.js 20+ and a recent pnpm release.

```bash
git clone https://github.com/ceosunny9/Sunra-lang.git
cd Sunra-lang/compiler
pnpm install
pnpm build
pnpm test:all
```

Run an example:

```bash
pnpm sunra run examples/hello.sun
pnpm sunra run examples/slot_machine.sun --seed 42
pnpm sunra rtp examples/slot_machine.sun --rounds 500000 --seed 42
```

## Example

```sunra
game MiniSlot {
    rtp = 0.96
    tolerance = 0.01
    reel strip = ["CHERRY", "LEMON", "STAR"]

    fn spin() -> Float uses rand {
        let row = Reel.spin(Reel.of(strip), 3)
        if Reel.isMatch(row) { 5.0 } else { 0.0 }
    }
}
```

The `examples/` directory includes slot, baccarat, poker, dice, provably fair, blockchain, and runtime primitive programs. The `tests/` directory exercises the compiler, backends, safety checks, and public CLI behavior.

## Repository layout

| Path | Purpose |
|---|---|
| `compiler/src/` | Compiler, runtime, verification, and backend source |
| `compiler/examples/` | Executable Sunra examples |
| `compiler/tests/` | Regression and backend test suites |
| `compiler/bin/` | CLI entry point |
| `sunra_whitepaper.md` | Language vision and technical design |

## Development

```bash
cd compiler
pnpm build
pnpm test:all
```

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. Security-sensitive findings should follow [SECURITY.md](SECURITY.md).

## License

**Proprietary — See [LICENSE](LICENSE).**

Copyright 2026 SunCore Labs LLC. All rights reserved.
