// Repro harness for the deployed app (the MCP is too slow / waits for load between navs, masking races).
//   node scripts/repro-deploy.mjs [url]
// Test A: rapid reloads to trigger the OPFS SyncAccessHandle race (NoModificationAllowedError).
// Test B: download books sequentially, timing each, to see if a growing cache slows downloads.
import { chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = (process.argv[2] || 'https://kolodny.github.io/torah-app/').replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'torah-repro-'));
const ctx = await chromium.launchPersistentContext(dir, { headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());

const errors = [];
const watch = (s) => /NoModification|Access Handle|malformed|SQLITE_CORRUPT|not a database|disk image/i.test(s);
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || watch(t)) errors.push(`[console.${m.type()}] ${t}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

const bootedJS = () => /Tanakh/.test(document.body.innerText) || !!document.querySelector('.cat-label, .verse, [data-testid^="book-"]');
const waitBoot = (ms = 30000) => page.waitForFunction(bootedJS, null, { timeout: ms }).catch(() => {});

console.log('URL:', URL);
console.log('—'.repeat(60));

// ---- Test A: rapid-reload SAH race ----
await page.goto(`${URL}/?page=viewer&book=Genesis`, { waitUntil: 'load' });
await waitBoot();
console.log('Test A — rapid reloads (tight timing):');
const aStart = errors.length;
for (let i = 0; i < 12; i++) {
  await page.goto(`${URL}/?page=viewer&book=Genesis`, { waitUntil: 'commit' }).catch((e) => errors.push(`[goto] ${e.message}`));
  await page.waitForTimeout(120 + (i % 3) * 90); // reload before the previous worker settles/releases handles
}
await page.goto(`${URL}/?page=viewer&book=Genesis`, { waitUntil: 'load' }).catch(() => {});
await page.waitForTimeout(4000);
const sah = errors.slice(aStart).filter((e) => /NoModification|Access Handle/i.test(e));
console.log(`  SAH/handle errors during rapid reload: ${sah.length}`);
sah.slice(0, 3).forEach((e) => console.log('   ', e.slice(0, 160)));
const bootedAfter = await page.evaluate(bootedJS).catch(() => false);
console.log(`  app booted after the reload storm: ${bootedAfter}`);

// ---- Test B: download timing as the cache grows ----
console.log('Test B — sequential downloads (does a bigger cache slow merges?):');
async function timeDownload(book) {
  await page.goto(`${URL}/?page=viewer&book=${encodeURIComponent(book)}`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => /Download this book/.test(b.textContent)) || !!document.querySelector('.verse'),
    null, { timeout: 30000 }
  ).catch(() => {});
  if (await page.locator('.verse').count()) return { book, ms: 0, note: 'already local' };
  const btn = page.getByRole('button', { name: /Download this book/ });
  const t0 = Date.now();
  await btn.click();
  await page.waitForSelector('.verse .col', { timeout: 180000 }).catch(() => {});
  return { book, ms: Date.now() - t0, verses: await page.locator('.verse').count() };
}
for (const b of ['Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy']) {
  console.log('  ', JSON.stringify(await timeDownload(b)));
}

console.log('—'.repeat(60));
console.log(`total watched errors: ${errors.length}`);
errors.slice(0, 8).forEach((e) => console.log('  ', e.slice(0, 180)));

await ctx.close();
rmSync(dir, { recursive: true, force: true });
