#!/usr/bin/env node
// Regenerate the README diagrams from their archify JSON sources.
//
//   node docs/diagrams/export-svg.mjs
//
// Needs the archify skill (https://github.com/tt-a1i/archify) and Chrome.
// Override locations with ARCHIFY_BIN and CHROME_BIN.
//
// archify only exports its dual-theme SVG from the in-page menu, so this
// renders the HTML, calls the page's own serializeSvg() in headless Chrome,
// and reads the result back out of the dumped DOM.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const archify = process.env.ARCHIFY_BIN ?? path.join(os.homedir(), '.claude/skills/archify/bin/archify.mjs');
const chrome = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOOK = "if (new URLSearchParams(window.location.search).get('openExport') === '1') {";
const INJECT =
  "Promise.resolve(serializeSvg(1,{autoTheme:true})).then(function(d){var t=document.createElement('textarea');" +
  "t.id='svgout';t.textContent=btoa(unescape(encodeURIComponent(d.svgString)));document.body.appendChild(t);});\n";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-'));
for (const file of fs.readdirSync(here)) {
  const m = file.match(/^(.+)\.(architecture|workflow|sequence|dataflow|lifecycle)\.json$/);
  if (!m) continue;
  const [, name, type] = m;
  const html = path.join(tmp, `${name}.html`);
  execFileSync('node', [archify, 'render', type, path.join(here, file), html], { stdio: 'ignore' });
  const page = fs.readFileSync(html, 'utf8');
  if (!page.includes(HOOK)) throw new Error(`archify template changed: export hook not found in ${name}.html`);
  fs.writeFileSync(html, page.replace(HOOK, INJECT + HOOK));
  const dom = execFileSync(
    chrome,
    ['--headless=new', '--disable-gpu', '--virtual-time-budget=8000', '--dump-dom', `file://${html}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const out = dom.match(/<textarea id="svgout">([^<]+)<\/textarea>/);
  if (!out) throw new Error(`no SVG produced for ${name}`);
  fs.writeFileSync(path.join(here, `${name}.svg`), Buffer.from(out[1], 'base64').toString('utf8'));
  console.log(`${name}.svg`);
}
fs.rmSync(tmp, { recursive: true, force: true });
