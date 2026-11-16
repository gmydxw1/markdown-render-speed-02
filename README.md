# markdown-render-speed-02

A fast drop-in replacement for marked 18.1.3: `parse(markdown)` returns,
for every input string, byte-for-byte the same HTML that `marked.parse`
returns with marked's default options (GFM on, breaks off, pedantic off,
async off), but faster.

## Layout

- `parse.js` — dependency-free ES module exporting `parse(markdown)`.
  A fresh single-pass scanner: a line-cursor block parser plus an inline
  scanner, built only on `charCodeAt` / `indexOf` / `slice`, with no
  regular expressions on hot paths, no token tree or AST, and output
  pushed straight into an array and joined once. A fast path skips any
  inline run with no special characters. Link reference definitions are
  collected once per case into a `Map`. Structures the scanner is unsure
  about bail out to the vendored marked 18.1.3 (`vendor/marked/`), so the
  output stays identical even on inputs the fast path cannot handle.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  renders each case with `parse`, writes `/output/html.json`.
- `package.json` — `{"type": "module"}`.
- `vendor/marked/` — marked 18.1.3 (MIT, vendored byte for byte, with its
  LICENSE and NOTICE), used only as the bailout fallback.

## Rules the parser follows

- Deterministic: no clock, environment, or file reads; no cross-case
  caching (the competition forbids it).
- Total repository size under 1 MiB.

## Local checks

Practice set (720 cases: 680 CommonMark 0.31.2 + GFM 0.29 examples and
40 generated READMEs) is scored with the dev scripts in `../dev`
(`test.mjs`, `bench.mjs`) against the kit's practice input and reference.
