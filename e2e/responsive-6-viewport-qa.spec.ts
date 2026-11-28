import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  setupAuditAuth,
  waitForAppReady,
  assertNoHorizontalOverflow,
} from './helpers/mobileAuditHelpers';

const QA_VIEWPORTS = [
  { name: 'large-desktop-1920x1080', width: 1920, height: 1080 },
  { name: 'desktop-1536x864', width: 1536, height: 864 },
  { name: 'standard-laptop-1440x900', width: 1440, height: 900 },
  { name: 'laptop-13in-1280x800', width: 1280, height: 800 },
  { name: 'laptop-11in-1024x768', width: 1024, height: 768 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'mobile-390x844', width: 390, height: 844 },
  { name: 'small-mobile-360x800', width: 360, height: 800 },
];

const ROUTES = [
  { key: 'dashboard', path: '/dashboard' },
  { key: 'crm', path: '/crm' },
  { key: 'command-center', path: '/command-center' },
  { key: 'expenses', path: '/finance/expenses' },
  { key: 'stock', path: '/stock' },
  { key: 'batches', path: '/batches' },
  { key: 'delivery-challan', path: '/delivery-challan' },
  { key: 'sales', path: '/sales' },
  { key: 'purchase-orders', path: '/purchase-orders' },
];

const SHOT_DIR = path.resolve('audit-reports/responsive-qa');

test.describe('SAPJ ERP — 8-Viewport Responsive Browser QA', () => {
  for (const vp of QA_VIEWPORTS) {
    test(`All key modules pass horizontal overflow & interactive checks at ${vp.name}`, async ({ page }) => {
      test.setTimeout(120000);
      fs.mkdirSync(SHOT_DIR, { recursive: true });

      const pageErrors: string[] = [];
      page.on('pageerror', (err) => {
        const msg = `${page.url()} :: ${err.message}`;
        console.log('PAGE_ERR:', msg);
        pageErrors.push(msg);
      });

      await setupAuditAuth(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      for (const route of ROUTES) {
        await page.goto(route.path, { waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        await page.waitForTimeout(300);

        const ok = await assertNoHorizontalOverflow(page);
        expect(ok, `Horizontal overflow detected at ${vp.name} on ${route.path}`).toBe(true);

        if (vp.width < 1024 && route.key === 'dashboard') {
          await expect(page.locator('nav[aria-label="Mobile Navigation"]')).toBeVisible();
        }

        if (route.key === 'crm') {
          const inqTab = page.getByRole('button', { name: /Inquiries/i }).first();
          if (await inqTab.isVisible().catch(() => false)) {
            await inqTab.click();
            await page.waitForTimeout(250);
          }
          if (vp.width < 768) {
            await expect(page.getByRole('button', { name: /Filters/i }).first()).toBeVisible();
          } else {
            await expect(page.locator('table').first()).toBeVisible();
          }
        }

        if (route.key === 'expenses' && vp.width < 768) {
          const filterBtn = page.getByRole('button', { name: /Filters/i }).first();
          await expect(filterBtn).toBeVisible();
          await filterBtn.click();
          await expect(page.getByText('Expense Filters')).toBeVisible();
          await page.getByRole('button', { name: 'Apply Filters' }).click();
        }

        if (['dashboard', 'crm', 'expenses', 'delivery-challan'].includes(route.key)) {
          await page.screenshot({
            path: path.join(SHOT_DIR, `${vp.name}__${route.key}.png`),
            fullPage: false,
          });
        }
      }

      if (pageErrors.length > 0) {
        console.log('PAGE_ERRORS:', JSON.stringify(pageErrors, null, 2));
      }
      expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    });
  }

  test('Mobile drawer opens, navigates to Stock, and closes cleanly at 390x844', async ({ page }) => {
    test.setTimeout(60000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(`${page.url()} :: ${err.message}`));

    await setupAuditAuth(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    const drawer = page.locator('aside[aria-label="Mobile Navigation Drawer"]');
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: /Stock/i }).first().click();
    await expect(page).toHaveURL(/\/stock/, { timeout: 10000 });
    await waitForAppReady(page);
    await expect(drawer).toHaveClass(/-translate-x-full/);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10000 });

    expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  });
});
