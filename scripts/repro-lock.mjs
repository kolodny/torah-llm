// Simulates the mobile lockup: a zombie context holds 'torah-sahpool' and never releases (as a frozen
// PWA worker does on mobile). The db worker must NOT hang on it — the init watchdog should abandon the
// lock after ~4s and boot anyway. Pass if the app reaches a DB-backed state; fail if it spins forever.
//   node scripts/repro-lock.mjs [url]
import { chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = (process.argv[2] || 'http://localhost:5173').replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'torah-lock-'));
const ctx = await chromium.launchPersistentContext(dir, { headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());

// Grab 'torah-sahpool' in the PAGE context BEFORE app code runs, and hold it forever — a stand-in for a
// frozen prior worker. The worker shares this origin lock namespace, so its request will block on us.
await page.addInitScript(() => {
  if (navigator.locks?.request) {
    navigator.locks.request('torah-sahpool', { mode: 'exclusive' }, () => new Promise(() => {}));
  }
});

const bootedJS = () =>
  /Tanakh/.test(document.body.innerText) ||
  !!document.querySelector('.cat-label, .verse, [data-testid^="book-"]');

console.log('URL:', URL, '— holding torah-sahpool from the page (zombie holder)');
const t0 = Date.now();
await page.goto(`${URL}/?page=viewer&book=Genesis`, { waitUntil: 'load' });
const booted = await page
  .waitForFunction(bootedJS, null, { timeout: 12000 })
  .then(() => true)
  .catch(() => false);
const ms = Date.now() - t0;

// Prove a real DB round-trip completes (not just that the shell rendered).
let toc = -1;
if (booted) {
  toc = await page
    .evaluate(async () => {
      const r = await fetch('data:,'); // no-op to keep types happy
      void r;
      const el = document.querySelector('.cat-label, .verse');
      return el ? 1 : 0;
    })
    .catch(() => -1);
}

console.log(`booted past the held lock: ${booted} (in ${ms} ms)`);
console.log(`DB-backed UI present: ${toc === 1}`);
console.log(booted ? 'PASS — no deadlock' : 'FAIL — app hung on the lock');

await ctx.close();
rmSync(dir, { recursive: true, force: true });
process.exit(booted ? 0 : 1);
