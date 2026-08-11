# Wasm Simd Bench

> WASM SIMD microbench harness

**Author:** zAx4hub

## Problem

WASM SIMD microbench harness. Teams often rely on closed SaaS, brittle scripts, or untested prototypes for this niche.

## Solution

`wasm-simd-bench` is an installable TypeScript/Node toolkit by **zAx4hub** with a real **trace** engine, CLI, examples, and tests.

## Why different

- Distinct niche — not a thin wrapper or todo scaffold
- Deterministic core algorithms you can unit-test
- Local-first / self-host friendly defaults
- Credited only to **zAx4hub**

## Quickstart

```bash
cd wasm-simd-bench
npm install
npm test
npm run demo
```

## Features

1. Core trace engine tailored to the problem
2. CLI: `demo` / `run` / `inspect`
3. Structured JSON reports with metrics
4. Examples + fixtures
5. GitHub Actions CI workflow (may remain local if token lacks workflow scope)

## Architecture

`src/` (or Python package) holds pure engine logic. CLI and examples sit at the edges. Tests exercise the engine directly.

## Contributing

PRs welcome — keep changes focused and add tests. Credit remains **zAx4hub**.

## Credits

Built and maintained by **zAx4hub**.

## License

MIT © 2026 zAx4hub
