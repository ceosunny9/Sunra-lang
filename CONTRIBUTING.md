# Contributing to Sunra

Sunra welcomes focused contributions that improve language correctness, runtime safety, diagnostics, tests, documentation, and developer experience. By contributing, you agree to follow the project's [Code of Conduct](CODE_OF_CONDUCT.md).

## Before opening a change

Discuss substantial language, runtime, security, or backend changes in an issue before investing in implementation. Keep each pull request narrowly scoped and explain the user-visible behavior it changes.

| Contribution type | Expected evidence |
|---|---|
| Parser, checker, or runtime change | A regression test demonstrating the intended behavior |
| Backend change | A target-specific test and an executable or assembly validation where applicable |
| Gaming primitive change | Deterministic test coverage and documented effect or RTP implications |
| Documentation change | Accurate commands, paths, and licensing language |

## Development workflow

```bash
cd compiler
pnpm install
pnpm build
pnpm test:all
```

Do not commit dependency directories, generated `dist/` output, archives, local secrets, or machine-specific paths. Use conventional commit messages where practical and keep generated artifacts out of pull requests unless an approved release process requires them.

## Pull request standard

Describe the problem, implementation approach, tests run, and any compatibility or security impact. Reviewers may request additional tests, documentation, or a narrower change before merge.

## Licensing

Contributions are governed by the repository's proprietary [LICENSE](LICENSE). Do not submit code, data, or assets that you do not have permission to provide.
