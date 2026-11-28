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
} from './fixtures/representativeErpFixtures';

const QA_VIEWPORTS = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '390x844', width: 390, height: 844 },
];

const MODULE_ROUTES = [
  { key: 'dashboard', path: '/dashboard', shot: true },
  { key: 'crm', path: '/crm', shot: true },
  { key: 'command-center', path: '/command-center', shot: true },
  { key: 'customers', path: '/customers', shot: false },
  { key: 'document-bank', path: '/document-bank', shot: false },
  { key: 'sales-orders', path: '/sales-orders', shot: true },
  { key: 'delivery-challan', path: '/delivery-challan', shot: true },
  { key: 'sales', path: '/sales', shot: false },
  { key: 'purchase-orders', path: '/purchase-orders', shot: true },
  { key: 'stock', path: '/stock', shot: true },
  { key: 'batches', path: '/batches', shot: false },
  { key: 'expenses', path: '/finance/expenses', shot: true },
  { key: 'reconciliation', path: '/finance/reconciliation', shot: true },
  { key: 'reports', path: '/reports', shot: false },
  { key: 'settings', path: '/settings', shot: false },
];

const SHOT_DIR = path.resolve('audit-reports/final-polish-qa');

async function installRepresentativeFixtures(page: Page) {
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
}

test.describe('SAPJ ERP — Final Polish & Representative Data QA (6 Viewports)', () => {
  for (const vp of QA_VIEWPORTS) {
    test(`All 15 modules render cleanly with representative data at ${vp.name}`, async ({ page }) => {
      test.setTimeout(180000);
      fs.mkdirSync(SHOT_DIR, { recursive: true });

      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(`${page.url()} :: ${err.message}`));

      await setupAuditAuth(page);
      await installRepresentativeFixtures(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      for (const route of MODULE_ROUTES) {
        await page.goto(route.path, { waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        await page.waitForTimeout(300);

        const ok = await assertNoHorizontalOverflow(page);
        expect(ok, `Horizontal overflow at ${vp.name} on ${route.path}`).toBe(true);

        // Ensure no raw dot-notation translation keys leak into visible text
        const bodyText = await page.locator('body').innerText();
        expect(bodyText).not.toContain('common.import');
        expect(bodyText).not.toContain('common.columns');
        expect(bodyText).not.toContain('common.settings');

        if (route.key === 'crm') {
          const inqTab = page.getByRole('button', { name: /Inquiries/i }).first();
          if (await inqTab.isVisible().catch(() => false)) {
            await inqTab.click();
            await page.waitForTimeout(300);
          }

          // Exactly one primary New Inquiry button on the page
          await expect(page.getByRole('button', { name: /New Inquiry/i })).toHaveCount(1);

          if (vp.width >= 1024) {
            // 1024px+ uses compact spreadsheet view + unified Actions menu
            await expect(page.locator('table').first()).toBeVisible();
            await expect(page.getByRole('button', { name: /Actions/i }).first()).toBeVisible();
          } else {
            // 768px tablet & 390px mobile use card view + compact Filters trigger
            await expect(page.getByRole('button', { name: /Filters/i }).first()).toBeVisible();
            await expect(page.getByText('ACRP-2611-001').first()).toBeVisible();
          }
        }

        if (route.shot) {
          await page.screenshot({
            path: path.join(SHOT_DIR, `${vp.name}__${route.key}.png`),
            fullPage: false,
          });
        }
      }

      expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    });
  }
});
