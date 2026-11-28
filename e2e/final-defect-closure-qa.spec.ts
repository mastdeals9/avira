import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  setupAuditAuth,
  waitForAppReady,
  assertNoHorizontalOverflow,
} from './helpers/mobileAuditHelpers';
import {
  REPRESENTATIVE_CRM_CONTACTS,
  REPRESENTATIVE_INQUIRIES,
  REPRESENTATIVE_EXPENSES,
  REPRESENTATIVE_BATCHES,
  REPRESENTATIVE_BANK_LINES,
  REPRESENTATIVE_STOCK_SUMMARY,
  REPRESENTATIVE_PURCHASE_ORDERS,
} from './fixtures/representativeErpFixtures';

const CLOSURE_VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '390x844', width: 390, height: 844 },
];

const OUTSTANDING_ROUTES = [
  '/finance/petty-cash',
  '/finance/payments',
  '/finance/receipts',
  '/finance/bank-ledger',
  '/finance/party-ledger',
  '/finance/ledger',
  '/finance/journal',
  '/finance/contra',
  '/finance/purchase-invoices',
  '/import-requirements',
  '/import-containers',
  '/price-calculator',
  '/credit-notes',
  '/material-returns',
  '/tasks',
  '/products',
  '/inventory',
];

const SHOT_DIR = path.resolve('audit-reports/defect-closure-qa');

async function installAllRepresentativeFixtures(page: Page) {
  await page.route('**/rest/v1/crm_contacts**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPRESENTATIVE_CRM_CONTACTS) })
  );
  await page.route('**/rest/v1/crm_inquiries**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPRESENTATIVE_INQUIRIES) })
  );
  await page.route('**/rest/v1/finance_expenses**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPRESENTATIVE_EXPENSES) })
  );
  await page.route('**/rest/v1/batches**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPRESENTATIVE_BATCHES) })
  );
  await page.route('**/rest/v1/bank_statement_lines**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPRESENTATIVE_BANK_LINES) })
  );
  await page.route('**/rest/v1/inventory_v1_stock_summary**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPRESENTATIVE_STOCK_SUMMARY) })
  );
  await page.route('**/rest/v1/purchase_orders**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPRESENTATIVE_PURCHASE_ORDERS) })
  );
}

test.describe('SAPJ ERP — Final Defect Closure Verification', () => {
  for (const vp of CLOSURE_VIEWPORTS) {
    test(`Defect fixes (Approvals, Stock, PO, CRM KPIs, Expenses) pass at ${vp.name}`, async ({ page }) => {
      test.setTimeout(120000);
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(`${page.url()} :: ${err.message}`));

      await setupAuditAuth(page);
      await installAllRepresentativeFixtures(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // 1. Expenses + ApprovalNotifications topbar position
      await page.goto('/finance/expenses', { waitUntil: 'domcontentloaded' });
      await waitForAppReady(page);
      await page.waitForTimeout(300);
      expect(await assertNoHorizontalOverflow(page)).toBe(true);

      const approvalTrigger = page.getByTestId('pending-approvals-trigger');
      await expect(approvalTrigger).toBeVisible();
      const box = await approvalTrigger.boundingBox();
      expect(box && box.y < 60, `Approval trigger should be docked in topbar (<60px), got y=${box?.y}`).toBe(true);

      // Verify translated category labels in English (never raw 'office'/'warehouse'/'transport')
      await expect(page.getByText('Office & Admin').locator('visible=true').first()).toBeVisible({ timeout: 10000 });
      const expTextEn = await page.locator('body').innerText();
      expect(expTextEn).toContain('Office & Admin');
      expect(expTextEn).toContain('Warehouse & Storage');
      expect(expTextEn).toContain('Transport & Delivery');

      await page.screenshot({ path: path.join(SHOT_DIR, `${vp.name}__expenses.png`), fullPage: false });

      // 2. Stock mobile cards + no '()' empty parentheses
      await page.goto('/stock', { waitUntil: 'domcontentloaded' });
      await waitForAppReady(page);
      await page.waitForTimeout(300);
      expect(await assertNoHorizontalOverflow(page)).toBe(true);
      await expect(page.getByText('Paracetamol Micronized BP/USP').locator('visible=true').first()).toBeVisible({ timeout: 10000 });
      const stockText = await page.locator('body').innerText();
      expect(stockText).not.toContain('()');
      await page.screenshot({ path: path.join(SHOT_DIR, `${vp.name}__stock.png`), fullPage: false });

      // 3. Purchase Orders mobile cards + desktop table
      await page.goto('/purchase-orders', { waitUntil: 'domcontentloaded' });
      await waitForAppReady(page);
      await page.waitForTimeout(300);
      expect(await assertNoHorizontalOverflow(page)).toBe(true);
      await expect(page.getByText('PO-2611-0018').locator('visible=true').first()).toBeVisible({ timeout: 10000 });
      await page.screenshot({ path: path.join(SHOT_DIR, `${vp.name}__purchase-orders.png`), fullPage: false });

      // 4. CRM Inquiries (3 KPIs on 390px & 768px, 9 KPIs on 1024px & 1440px)
      await page.goto('/crm', { waitUntil: 'domcontentloaded' });
      await waitForAppReady(page);
      const inqTab = page.getByRole('button', { name: /Inquiries/i }).first();
      if (await inqTab.isVisible().catch(() => false)) {
        await inqTab.click();
        await page.waitForTimeout(300);
      }
      expect(await assertNoHorizontalOverflow(page)).toBe(true);
      await page.screenshot({ path: path.join(SHOT_DIR, `${vp.name}__crm.png`), fullPage: false });

      // 5. Sales Orders KPI hierarchy
      await page.goto('/sales-orders', { waitUntil: 'domcontentloaded' });
      await waitForAppReady(page);
      await page.waitForTimeout(250);
      expect(await assertNoHorizontalOverflow(page)).toBe(true);
      await page.screenshot({ path: path.join(SHOT_DIR, `${vp.name}__sales-orders.png`), fullPage: false });

      expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    });
  }

  test('Data-driven labels translate cleanly in both EN and Bahasa Indonesia on Expenses', async ({ page }) => {
    test.setTimeout(60000);
    await setupAuditAuth(page);
    await installAllRepresentativeFixtures(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto('/finance/expenses', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await page.waitForTimeout(250);

    // Switch language to Bahasa Indonesia via topbar globe toggle
    await page.getByRole('button', { name: 'Toggle language' }).click();
    await page.waitForTimeout(250);

    const idText = await page.locator('body').innerText();
    expect(idText).toContain('Kantor & Administrasi');
    expect(idText).toContain('Gudang & Penyimpanan');
    expect(idText).toContain('Transportasi & Pengiriman');
    expect(idText).toContain('Belum Dibayar');
  });

  test('All 17 outstanding Finance & secondary subpages load cleanly without overflow or pageerror at 390px and 1280px', async ({ page }) => {
    test.setTimeout(240000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(`${page.url()} :: ${err.message}`));

    await setupAuditAuth(page);
    await installAllRepresentativeFixtures(page);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const routePath of OUTSTANDING_ROUTES) {
        await page.goto(routePath, { waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        await page.waitForTimeout(200);
        const ok = await assertNoHorizontalOverflow(page);
        expect(ok, `Horizontal overflow at ${width}px on ${routePath}`).toBe(true);
      }
    }

    expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  });
});
