import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { setupAuditAuth, waitForAppReady, assertNoHorizontalOverflow } from './helpers/mobileAuditHelpers';
import { REPRESENTATIVE_PURCHASE_ORDERS } from './fixtures/representativeErpFixtures';

const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
  { name: '402x874', width: 402, height: 874 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

const SHOT_DIR = path.resolve('audit-reports/doc-preview-qa');

const MOCK_COMPANY = {
  id: '00000000-0000-0000-0000-000000000010',
  company_name: 'PT. SHUBHAM ANZEN PHARMA JAYA',
  company_address: 'Jl. Industri Raya No. 45, Kawasan Industri Jababeka, Cikarang, Bekasi 17530',
  company_phone: '+62 21 8983 4455',
  company_email: 'sales@anzenpharma.co.id',
  company_npwp: '01.234.567.8-413.000',
  company_logo_url: '',
  bank_name: 'BCA',
  bank_account_number: '1234567890',
  bank_account_name: 'PT. SHUBHAM ANZEN PHARMA JAYA',
};

const MOCK_INVOICE = {
  id: 'inv-qa-1',
  invoice_number: 'SAPJ-26-040',
  invoice_date: '2026-11-20',
  due_date: '2026-12-20',
  customer_id: 'cust-qa-1',
  status: 'unpaid',
  payment_status: 'pending',
  subtotal: 125000000,
  tax_amount: 13750000,
  discount_amount: 0,
  total_amount: 138750000,
  currency: 'IDR',
  po_number: 'PO-CUST-8891',
  notes: 'Please remit payment before due date.',
  company_snapshot: MOCK_COMPANY,
  created_at: '2026-11-20T08:00:00Z',
  customers: {
    id: 'cust-qa-1',
    company_name: 'PT Kalbe Farma Tbk',
    address: 'Jl. Letjen Suprapto Kav. 4, Jakarta Pusat 10510',
    phone: '021-42873888',
    npwp: '01.001.222.3-092.000',
    gst_vat_type: 'PKP',
    payment_terms: 'Net 30',
  },
};

const MOCK_INVOICE_ITEMS = [
  {
    id: 'inv-item-1',
    invoice_id: 'inv-qa-1',
    product_id: 'prod-qa-1',
    batch_id: 'batch-qa-1',
    quantity: 500,
    unit_price: 250000,
    tax_rate: 11,
    products: { id: 'prod-qa-1', product_name: 'Paracetamol BP/USP Micronized', product_code: 'PARA-01', unit: 'kg' },
    batches: { id: 'batch-qa-1', batch_number: 'B-2610-01', expiry_date: '2028-10-31', product_sources: { supplier_name: 'Anhui BBCA' } },
  },
];

const MOCK_SALES_ORDER = {
  id: 'so-qa-1',
  so_number: 'SO-26-019',
  so_date: '2026-11-18',
  expected_delivery_date: '2026-11-25',
  customer_id: 'cust-qa-1',
  customer_po_number: 'PO-CUST-8891',
  status: 'approved',
  subtotal: 125000000,
  tax_amount: 13750000,
  total_amount: 138750000,
  currency: 'IDR',
  notes: 'Proforma for advance confirmation.',
  company_snapshot: MOCK_COMPANY,
  created_at: '2026-11-18T08:00:00Z',
  customers: MOCK_INVOICE.customers,
  sales_order_items: [
    {
      id: 'soi-1',
      sales_order_id: 'so-qa-1',
      product_id: 'prod-qa-1',
      quantity: 500,
      unit_price: 250000,
      line_total: 125000000,
      products: { id: 'prod-qa-1', product_name: 'Paracetamol BP/USP Micronized', product_code: 'PARA-01', unit: 'kg' },
    },
  ],
};

const MOCK_CHALLAN = {
  id: 'dc-qa-1',
  challan_number: 'DC-26-031',
  challan_date: '2026-11-19',
  customer_id: 'cust-qa-1',
  sales_order_id: 'so-qa-1',
  delivery_address: 'Gudang Cikarang Blok C-12, Bekasi',
  driver_name: 'Budi Santoso',
  vehicle_number: 'B 9123 TXZ',
  approval_status: 'approved',
  status: 'dispatched',
  notes: 'Handle with care — Keep dry',
  company_snapshot: MOCK_COMPANY,
  created_at: '2026-11-19T08:00:00Z',
  customers: MOCK_INVOICE.customers,
};

const MOCK_CHALLAN_ITEMS = [
  {
    id: 'dci-1',
    challan_id: 'dc-qa-1',
    product_id: 'prod-qa-1',
    batch_id: 'batch-qa-1',
    quantity: 500,
    pack_size: 25,
    number_of_packs: 20,
    products: { id: 'prod-qa-1', product_name: 'Paracetamol BP/USP Micronized', product_code: 'PARA-01', unit: 'kg' },
    batches: { id: 'batch-qa-1', batch_number: 'B-2610-01', expiry_date: '2028-10-31', packaging_details: '25kg Fibre Drum' },
  },
];

function fulfillRest(route: import('@playwright/test').Route, rows: unknown[]) {
  const accept = route.request().headers()['accept'] || '';
  const isSingle = accept.includes('application/vnd.pgrst.object+json');
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(isSingle ? (rows[0] ?? null) : rows),
  });
}

async function installDocPreviewFixtures(page: Page) {
  await page.route('**/rest/v1/app_settings**', (route) => fulfillRest(route, [MOCK_COMPANY]));
  await page.route('**/rest/v1/company_settings**', (route) => fulfillRest(route, [MOCK_COMPANY]));
  await page.route('**/rest/v1/sales_invoices**', (route) => fulfillRest(route, [MOCK_INVOICE]));
  await page.route('**/rest/v1/sales_invoice_items**', (route) => fulfillRest(route, MOCK_INVOICE_ITEMS));
  await page.route('**/rest/v1/sales_orders**', (route) => fulfillRest(route, [MOCK_SALES_ORDER]));
  await page.route('**/rest/v1/sales_order_items**', (route) => fulfillRest(route, MOCK_SALES_ORDER.sales_order_items));
  await page.route('**/rest/v1/delivery_challans**', (route) => fulfillRest(route, [MOCK_CHALLAN]));
  await page.route('**/rest/v1/delivery_challan_items**', (route) => fulfillRest(route, MOCK_CHALLAN_ITEMS));
  await page.route('**/rest/v1/purchase_orders**', (route) =>
    fulfillRest(
      route,
      REPRESENTATIVE_PURCHASE_ORDERS.map((po) => ({
        ...po,
        company_snapshot: MOCK_COMPANY,
        suppliers: { company_name: po.supplier_name || 'Aarti Drugs Ltd', address: 'Mumbai, India', phone: '+91 22 2400 1100' },
        purchase_order_items: [
          {
            id: 'poi-1',
            purchase_order_id: po.id,
            product_id: 'prod-qa-1',
            product_name: 'Paracetamol BP/USP Micronized',
            specification: 'BP/USP Grade',
            coa_code: 'COA-2026-01',
            quantity: 1000,
            unit: 'kg',
            unit_price: 85000,
            discount_percent: 0,
            line_total: 85000000,
          },
        ],
      }))
    )
  );
  await page.route('**/rest/v1/purchase_order_items**', (route) =>
    fulfillRest(route, [
      {
        id: 'poi-1',
        purchase_order_id: REPRESENTATIVE_PURCHASE_ORDERS[0].id,
        product_id: 'prod-qa-1',
        product_name: 'Paracetamol BP/USP Micronized',
        specification: 'BP/USP Grade',
        coa_code: 'COA-2026-01',
        quantity: 1000,
        unit: 'kg',
        unit_price: 85000,
        discount_percent: 0,
        line_total: 85000000,
      },
    ])
  );
}

async function assertDocumentHeaderHealthy(page: Page, viewportWidth: number) {
  await expect(page.getByLabel('Close preview')).toBeVisible({ timeout: 10000 });
  const headerH1 = page.locator('[aria-label="Close preview"]').locator('xpath=ancestor::div[contains(@class,"bg-white")]//h1').first();
  await expect(headerH1).toBeVisible({ timeout: 10000 });

  const metrics = await page.evaluate(() => {
    const closeBtn = document.querySelector('[aria-label="Close preview"]');
    const modal = closeBtn?.closest('.bg-white');
    if (!modal) return null;
    const h1 = modal.querySelector('h1');
    const titleEl = Array.from(modal.querySelectorAll('h2')).find((el) =>
      /INVOICE|CHALLAN|PURCHASE ORDER|PROFORMA/i.test(el.textContent || '')
    );
    const h1Rect = h1?.getBoundingClientRect();
    const titleRect = titleEl?.getBoundingClientRect();
    return {
      modalWidth: modal.getBoundingClientRect().width,
      h1Text: h1?.textContent?.trim() || '',
      h1Height: h1Rect ? h1Rect.height : 0,
      h1Right: h1Rect ? h1Rect.right : 0,
      titleLeft: titleRect ? titleRect.left : 9999,
      titleHeight: titleRect ? titleRect.height : 0,
      docOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  });

  expect(metrics).not.toBeNull();
  expect(metrics!.docOverflow).toBe(false);
  expect(metrics!.modalWidth).toBeLessThanOrEqual(viewportWidth + 2);
  // Company name should NOT wrap 1 character per line (scaled or full A4 should be 1-2 lines, well under 60px)
  expect(metrics!.h1Height).toBeLessThan(60);
  // Company name and document title must NOT overlap horizontally
  if (metrics!.titleLeft < 9999) {
    expect(metrics!.h1Right).toBeLessThanOrEqual(metrics!.titleLeft + 2);
  }
}

test.describe('SAPJ ERP — Mobile Navigation Density & Document Preview QA', () => {
  test('Mobile navigation drawer density and EN/ID labels at 390x844 and 360x800', async ({ page }) => {
    test.setTimeout(90000);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await setupAuditAuth(page);
    await installDocPreviewFixtures(page);

    for (const vp of [
      { name: '390x844', width: 390, height: 844 },
      { name: '360x800', width: 360, height: 800 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await waitForAppReady(page);

      await page.getByLabel('Open navigation menu').click();
      const drawer = page.getByLabel('Mobile Navigation Drawer');
      await expect(drawer).toBeVisible();
      await page.waitForTimeout(350);

      const navMetrics = await drawer.evaluate((el) => {
        const buttons = Array.from(el.querySelectorAll('nav button'));
        const heights = buttons.map((b) => b.getBoundingClientRect().height);
        const fontSizes = buttons.map((b) => {
          const span = b.querySelector('span');
          return span ? parseFloat(getComputedStyle(span).fontSize) : 0;
        });
        const logoutBtn = Array.from(el.querySelectorAll('button')).find((b) =>
          /logout|keluar/i.test(b.textContent || '')
        );
        const logoutRect = logoutBtn?.getBoundingClientRect();
        return {
          count: buttons.length,
          maxHeight: Math.max(...heights),
          minHeight: Math.min(...heights),
          maxFontSize: Math.max(...fontSizes),
          logoutVisible: Boolean(logoutRect && logoutRect.bottom <= window.innerHeight + 1),
        };
      });

      expect(navMetrics.count).toBeGreaterThan(5);
      expect(navMetrics.minHeight).toBeGreaterThanOrEqual(33);
      expect(navMetrics.maxHeight).toBeLessThanOrEqual(38);
      expect(navMetrics.maxFontSize).toBeLessThanOrEqual(12.5);
      expect(navMetrics.logoutVisible).toBe(true);
      expect(await assertNoHorizontalOverflow(page)).toBe(true);

      await page.screenshot({ path: path.join(SHOT_DIR, `mobile-nav-en-${vp.name}.png`) });

      // Toggle to Bahasa Indonesia and verify longer translated labels
      await drawer.getByTitle('Change language').click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SHOT_DIR, `mobile-nav-id-${vp.name}.png`) });
      expect(await assertNoHorizontalOverflow(page)).toBe(true);

      // Reset to EN
      await drawer.getByTitle('Change language').click();
      await page.getByLabel('Close menu').click();
    }
  });

  for (const vp of VIEWPORTS) {
    test(`Document previews (Invoice, Proforma, Challan, PO) fit cleanly at ${vp.name}`, async ({ page }) => {
      test.setTimeout(120000);
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await setupAuditAuth(page);
      await installDocPreviewFixtures(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // 1. Sales Invoice Preview
      await page.goto('/sales', { waitUntil: 'domcontentloaded' });
      await waitForAppReady(page);
      const invViewBtn = page.locator('button[title="View"]:visible').first();
      await expect(invViewBtn).toBeVisible({ timeout: 15000 });
      await invViewBtn.click();
      await assertDocumentHeaderHealthy(page, vp.width);
      await page.screenshot({ path: path.join(SHOT_DIR, `doc-invoice-${vp.name}.png`) });
      if (vp.name === '390x844') {
        await page.getByRole('button', { name: '100%' }).click();
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(SHOT_DIR, `doc-invoice-zoom100-${vp.name}.png`) });
        await page.getByRole('button', { name: 'Fit' }).click();
        await page.waitForTimeout(150);
      }
      await page.getByLabel('Close preview').click();

      // 2. Delivery Challan Preview
      await page.goto('/delivery-challan', { waitUntil: 'domcontentloaded' });
      await waitForAppReady(page);
      const dcViewBtn = page.locator('button[title="View Challan"]:visible').first();
      await expect(dcViewBtn).toBeVisible({ timeout: 15000 });
      await dcViewBtn.click();
      await assertDocumentHeaderHealthy(page, vp.width);
      await page.screenshot({ path: path.join(SHOT_DIR, `doc-challan-${vp.name}.png`) });
      await page.getByLabel('Close preview').click();

      // 3. Proforma Invoice Preview (via Sales Orders)
      await page.goto('/sales-orders', { waitUntil: 'domcontentloaded' });
      await waitForAppReady(page);
      const proformaBtn = page.locator('button[title*="View"]:visible').first();
      await expect(proformaBtn).toBeVisible({ timeout: 15000 });
      await proformaBtn.click();
      await assertDocumentHeaderHealthy(page, vp.width);
      await page.screenshot({ path: path.join(SHOT_DIR, `doc-proforma-${vp.name}.png`) });
      await page.getByLabel('Close preview').click();

      // 4. Purchase Order Preview
      await page.goto('/purchase-orders', { waitUntil: 'domcontentloaded' });
      await waitForAppReady(page);
      const poViewBtn = page.locator('button[aria-label="View"]:visible, button[title="View"]:visible').first();
      await expect(poViewBtn).toBeVisible({ timeout: 15000 });
      await poViewBtn.click();
      await assertDocumentHeaderHealthy(page, vp.width);
      await page.screenshot({ path: path.join(SHOT_DIR, `doc-po-${vp.name}.png`) });
      await page.getByLabel('Close preview').click();
    });
  }
});
