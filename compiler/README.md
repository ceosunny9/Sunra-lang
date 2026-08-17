# Sunra Compiler

This directory contains the Sunra reference compiler, runtime, command-line interface, and verification tooling.

## Commands

```bash
pnpm install
pnpm build
pnpm test:all
pnpm sunra run examples/hello.sun
```

| Command | Purpose |
|---|---|
| `pnpm sunra check <file.sun>` | Parse and type-check a Sunra program |
| `pnpm sunra run <file.sun>` | Execute through the reference runtime |
| `pnpm sunra build <file.sun> --target vm` | Emit sandboxed SunVM bytecode |
| `pnpm sunra build <file.sun> --target wasm` | Emit a deterministic WASM artifact |
| `pnpm sunra rtp <file.sun>` | Run deterministic RTP analysis |
| `pnpm sunra certify <file.sun>` | Produce a build certificate when verification passes |

## Source layout

| Path | Responsibility |
|---|---|
| `src/lexer/`, `src/parser/` | Source parsing and AST construction |
| `src/checker/`, `src/refine/`, `src/own/` | Static safety and semantic checks |
| `src/hir/`, `src/mir/`, `src/opt/` | Typed and optimized intermediate representations |
| `src/backend/` | LLVM, Cranelift, SunVM, and WASM output |
| `src/runtime/` | Interpreter values, randomness, and gaming primitives |
| `src/verify/`, `src/compliance/` | Verification, rule packs, and build reporting |
| `examples/`, `tests/` | Executable examples and regression coverage |

Generated output, dependencies, archives, and local configuration are intentionally excluded from version control. See the repository [README](../README.md), [CONTRIBUTING.md](../CONTRIBUTING.md), and [SECURITY.md](../SECURITY.md) for project-wide guidance.

## License

**Proprietary — See [LICENSE](../LICENSE).**

Copyright 2026 SunCore Labs LLC. All rights reserved.
