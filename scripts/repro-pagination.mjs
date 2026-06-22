// Verifies section pagination: opening Genesis loads ONE chapter (~31 verses), not all ~1,500;
// scrolling grows the window; the URL ref tracks the section in view.
//   node scripts/repro-pagination.mjs [url]
import { chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.argv[2] || 'http://localhost:5173').replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'torah-page-'));
const ctx = await chromium.launchPersistentContext(dir, { headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

const verseCount = () => page.locator('.verse').count();
const countText = () =>
  page.locator('[data-testid="verse-count"]').first().textContent().catch(() => '');

console.log("URL:", BASE);
await page.goto(`${BASE}/?page=viewer&book=Genesis`, { waitUntil: 'load' });

// Download if needed.
const dl = page.getByRole('button', { name: /Download this book/ });
await page.waitForTimeout(1500);
if (await dl.count()) {
  console.log('downloading Genesis…');
  await dl.click();
}
await page.waitForSelector('.verse', { timeout: 180000 });
await page.waitForTimeout(800);

const initialVerses = await verseCount();
const initialCountText = (await countText())?.trim();
console.log(`initial: ${initialVerses} verses rendered — "${initialCountText}"`);
console.log(`  → only one chapter loaded? ${initialVerses > 0 && initialVerses < 80 ? 'YES' : 'NO (loaded too much!)'}`);

// Scroll to the bottom a few times; the window should grow (more chapters appended).
let prev = initialVerses;
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => {
    const v = document.querySelector('.viewer');
    if (v) v.scrollTop = v.scrollHeight;
  });
  await page.waitForTimeout(900);
  const now = await verseCount();
  console.log(`  after scroll ${i + 1}: ${now} verses (${now > prev ? '+' + (now - prev) : 'no change'})`);
  prev = now;
}

const grew = prev > initialVerses;
const urlRef = new URL(page.url()).searchParams.get('ref');
console.log(`window grew on scroll: ${grew}`);
console.log(`URL ref after scrolling: ${urlRef ?? '(none)'}`);
console.log(`console errors: ${errors.length}`);
errors.slice(0, 5).forEach((e) => console.log('   ', e.slice(0, 160)));

const pass = initialVerses > 0 && initialVerses < 80 && grew && errors.length === 0;
console.log(pass ? 'PASS' : 'FAIL');

await ctx.close();
rmSync(dir, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
