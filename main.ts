// Driver for markdown-render-speed-02.
// Reads every case from $MAKEFUN_INPUT_DIR/cases.json (default /input),
// renders each markdown string with parse() from ./parse.js, and writes
// the HTML strings, one per case and in the cases' order, to
// $MAKEFUN_OUTPUT_DIR/html.json (default /output). Runs as `node /bot/main.ts`
// on Node 22, which strips TypeScript types natively.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
) as Array<{ id: string; markdown: string }>;

const out: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
