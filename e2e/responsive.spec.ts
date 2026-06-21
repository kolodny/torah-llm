import { test, expect, type Page } from '@playwright/test';

const isMobile = () => test.info().project.name === 'mobile';

// The book <h2> renders once the catalog (boot DB) has loaded — a viewport-independent "app is alive"
// signal (the reader is always on-screen; the catalog is drawer-hosted on mobile).
async function openBook(page: Page, name = 'Genesis') {
  await page.goto(`/?page=viewer&book=${name}`);
  await expect(page.getByRole('heading', { name, exact: false })).toBeVisible({ timeout: 30_000 });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow, 'page should not scroll horizontally').toBeFalsy();
}

test('boots and shows the catalog', async ({ page }) => {
  await page.goto('/?page=viewer');
  // On mobile the catalog is a drawer — open it before asserting its content is present.
  if (isMobile()) await page.getByRole('button', { name: 'Toggle catalog' }).click();
  await expect(page.getByText('Tanakh', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await noHorizontalOverflow(page);
});

test('viewer layout adapts to the viewport', async ({ page }) => {
  await openBook(page);
  const burger = page.getByRole('button', { name: 'Toggle catalog' });

  if (isMobile()) {
    await expect(page.locator('.viewer-page.mobile')).toBeVisible();
    await expect(page.locator('.viewer-page > .catalog')).toHaveCount(0); // catalog is not an inline pane
    await expect(burger).toBeVisible();
    const reader = await page.locator('.viewer').first().boundingBox();
    const vw = page.viewportSize()!.width;
    expect(reader!.width).toBeGreaterThan(vw * 0.9); // reader fills the screen (not the old 56px)
  } else {
    await expect(page.locator('.viewer-page > .catalog')).toBeVisible(); // inline 3-pane
    await expect(burger).toBeHidden();
  }
  await noHorizontalOverflow(page);
});

test('mobile: catalog drawer opens, a book navigates + closes it', async ({ page }) => {
  test.skip(!isMobile(), 'mobile-only behavior');
  await openBook(page, 'Genesis'); // selecting a book auto-expands its catalog path (Tanakh → Torah)
  await page.getByRole('button', { name: 'Toggle catalog' }).click();
  const drawer = page.getByRole('dialog');
  // a sibling book is now visible in the drawer; tapping it navigates and auto-closes the drawer
  await expect(drawer.getByTestId('book-Exodus')).toBeVisible({ timeout: 30_000 });
  await drawer.getByTestId('book-Exodus').click();
  await expect(page).toHaveURL(/book=Exodus/);
  await expect(drawer).toBeHidden();
  await noHorizontalOverflow(page);
});

test('page navigation works across viewports', async ({ page }) => {
  await page.goto('/?page=storage');
  await expect(page.getByText(/books downloaded/i)).toBeVisible({ timeout: 30_000 });
  await noHorizontalOverflow(page);
  await page.goto('/?page=code-search');
  await expect(page.getByRole('button', { name: 'Run' })).toBeVisible({ timeout: 30_000 });
  await noHorizontalOverflow(page);
});
