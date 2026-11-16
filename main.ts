import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

// LumenMark driver: renders every case in the input directory on its
// own with parse() and writes the HTML strings, in order, to the output
// directory. Node strips the types natively, so no build step is needed.
const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8'));
const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(html));
