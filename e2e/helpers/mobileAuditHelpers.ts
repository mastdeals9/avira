import { Page, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, name: 'desktop-1440x900' },
  tablet: { width: 768, height: 1024, name: 'tablet-768x1024' },
  mobileCompact360: { width: 360, height: 800, name: 'mobile-360x800' },
  mobileIphoneMini375: { width: 375, height: 812, name: 'mobile-375x812' },
  mobileStandard390: { width: 390, height: 844, name: 'mobile-390x844' },
  mobilePixel412: { width: 412, height: 915, name: 'mobile-412x915' },
  mobileLarge430: { width: 430, height: 932, name: 'mobile-430x932' },
  // Aliases for backwards compatibility
  mobileStandard: { width: 390, height: 844, name: 'mobile-390x844' },
  mobileCompact: { width: 360, height: 800, name: 'mobile-compact-360x800' },
};

const PROJECT_ARTIFACT_DIR = path.resolve('artifacts/mobile-audit');
const BRAIN_ARTIFACT_DIR = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/mobile-audit';

/**
 * 1. Wait for Application Shell and Auth session to stabilize
 */
export async function waitForAppReady(page: Page) {
  // Wait for login form to be hidden
  await expect(page.locator('#username')).toBeHidden({ timeout: 15000 });
  // Wait for React Suspense full-screen fallback to be hidden
  await expect(page.locator('.min-h-screen .animate-spin.h-16')).toBeHidden({ timeout: 15000 });
}

/**
 * 2. Assert no spinners or loading indicators on the screen
 */
export async function assertNoLoadingState(page: Page) {
  await expect(page.locator('.animate-spin')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('text=Loading...')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('text=Loading…')).toHaveCount(0, { timeout: 15000 });
}

/**
 * 3. Wait for specific page data element to appear in DOM
 */
export async function waitForRouteData(page: Page, selector: string, timeout = 20000) {
  await expect(page.locator(selector).first()).toBeVisible({ timeout });
}

/**
 * 4. Measure horizontal overflow: must be <= viewport width + 2px
 */
export async function assertNoHorizontalOverflow(page: Page): Promise<boolean> {
  const isWithinBounds = await page.evaluate(() => {
    return document.documentElement.scrollWidth <= window.innerWidth + 2;
  });
  expect(isWithinBounds).toBe(true);
  return isWithinBounds;
}

/**
 * 5. Capture verified screenshot across both project and brain artifact directories
 */
export async function captureVerifiedScreenshot(
  page: Page,
  moduleName: string,
  routeName: string,
  viewportName: string,
  extraSuffix = ''
): Promise<{ projectPath: string; brainPath: string; filename: string }> {
  const filename = `${moduleName}_${routeName}_${viewportName}${extraSuffix ? `_${extraSuffix}` : ''}.png`
    .replace(/\//g, '_')
    .replace(/_{2,}/g, '_');

  const projectDir = path.join(PROJECT_ARTIFACT_DIR, moduleName, routeName, viewportName);
  const brainDir = path.join(BRAIN_ARTIFACT_DIR, moduleName, routeName, viewportName);

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(brainDir, { recursive: true });

  const projectPath = path.join(projectDir, filename);
  const brainPath = path.join(brainDir, filename);

  await page.screenshot({ path: projectPath, fullPage: false });
  fs.copyFileSync(projectPath, brainPath);

  return { projectPath, brainPath, filename };
}

/**
 * Setup authenticated session and comprehensive mock router for all ERP routes
 */
export async function setupAuditAuth(page: Page) {
  const envFile = fs.readFileSync('.env', 'utf8');
  const anonKeyMatch = envFile.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
  const anonKey = anonKeyMatch ? anonKeyMatch[1].trim() : '';

  const mockUser = {
    id: '1075a773-bb55-4296-bc71-af2eab9a0780',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'kunal@sapharmajaya.co.id',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { full_name: 'Kunal Lunkad' },
    created_at: '2025-10-31T12:00:00.000Z',
    updated_at: '2025-10-31T12:00:00.000Z',
  };

  const mockSession = {
    access_token: anonKey,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 7200,
    refresh_token: 'dummy-refresh-token',
    user: mockUser,
  };

  await page.addInitScript(({ session, userId }) => {
    window.localStorage.setItem('sb-dkrtsqienlhpouohmfki-auth-token', JSON.stringify(session));
    window.localStorage.setItem(`approval_popup_dismissed_${userId}`, 'audit_mode_suppressed');
    window.localStorage.setItem('anzen.finance.sidebarCollapsed', '1');
  }, { session: mockSession, userId: mockUser.id });

  await page.route('**/auth/v1/token?grant_type=password*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockSession) });
  });

  await page.route('**/auth/v1/user*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockUser) });
  });

  // Comprehensive REST router for realistic data across all ERP modules
  await page.route('**/rest/v1/**', async (route) => {
    const url = route.request().url();
    const accept = route.request().headers()['accept'] || '';

    if (url.includes('/rest/v1/rpc/lookup_login_email')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ email: 'kunal@sapharmajaya.co.id', is_active: true }) });
    }

    if (url.includes('/rest/v1/rpc/get_sales_profitability_summary')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          company: {
            gross_sales: 230000000,
            product_cost: 140000000,
            sales_expenses: 5000000,
            unallocated_sales_expenses: 0,
            gross_profit: 85000000,
            profit_after_sales_expenses: 80000000,
            profit_margin_pct: 34.78,
            total_qty_sold: 1250,
            order_count: 5,
            product_count: 2,
          },
          products: [
            {
              product_id: 'prod-1',
              product_name: 'Paracetamol Micronized BP/USP',
              product_code: 'PCM-001',
              product_unit: 'kg',
              current_stock: 1250,
              reserved_stock: 450,
              available_stock: 800,
              sold_qty: 450,
              gross_sales: 85000000,
              product_cost: 50000000,
              gross_profit: 35000000,
              profit_margin_pct: 41.17,
            },
          ],
        }),
      });
    }

    if (url.includes('/rest/v1/user_profiles')) {
      const profile = { id: mockUser.id, role: 'admin', full_name: 'Kunal Lunkad', is_active: true };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(accept.includes('vnd.pgrst.object+json') ? profile : [profile]) });
    }

    if (url.includes('/rest/v1/user_permissions')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    }

    if (url.includes('/rest/v1/company_profiles')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ company_name: 'PT SAPHARMA JAYA' }]) });
    }

    if (url.includes('/rest/v1/app_settings')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ setup_mode: false }]) });
    }

    // Suppliers
    if (url.includes('/rest/v1/suppliers')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'sup-1', company_name: 'PT Kimia Farma Trading & Distribution', country: 'Indonesia', is_active: true },
          { id: 'sup-2', company_name: 'Jiangsu Huaxi Pharma Chem Ltd', country: 'China', is_active: true },
        ]),
      });
    }

    // Products
    if (url.includes('/rest/v1/products')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'prod-1', product_name: 'Paracetamol Micronized BP/USP', product_code: 'PARA-MIC-01', hsn_code: '29242990', category: 'API', unit: 'KG', packaging_type: 'Drum', default_supplier: 'Anhui BBCA Pharma', current_stock: 1250, is_active: true },
          { id: 'prod-2', product_name: 'Amoxicillin Trihydrate Compacted', product_code: 'AMOX-TRI-02', hsn_code: '29411019', category: 'Antibiotic API', unit: 'KG', packaging_type: 'Carton', default_supplier: 'Sinopharm Group', current_stock: 800, is_active: true },
        ]),
      });
    }

    // Inventory Stock Summary
    if (url.includes('/rest/v1/inventory_v1_stock_summary')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { product_id: 'prod-1', total_current_stock: 1250 },
          { product_id: 'prod-2', total_current_stock: 800 },
        ]),
      });
    }

    // Stock & Inventory
    if (url.includes('/rest/v1/inventory_v1_stock_summary')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { product_id: 'prod-1', total_current_stock: 1250, reserved_stock: 450, available_quantity: 800 },
        ]),
      });
    }

    // Batches
    if (url.includes('/rest/v1/batches')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'batch-1', batch_number: 'BTC-2026-091', product_id: 'prod-1', products: { product_name: 'Paracetamol Micronized BP/USP' }, current_stock: 1250, reserved_stock: 450, expiry_date: '2028-10-31', import_price: 65000, is_active: true },
        ]),
      });
    }

    // Customers
    if (url.includes('/rest/v1/customers')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'c-1', company_name: 'PT Kalbe Farma Tbk', npwp: '01.234.567.8-012.000', address: 'Jl. Letjen Suprapto Kav 4', city: 'Jakarta Pusat', country: 'Indonesia', contact_person: 'Dr. Hendra Gunawan', email: 'hendra.g@kalbefarma.com', phone: '081234567890', pbf_license: 'PBF-JKT-2024', gst_vat_type: 'taxable', payment_terms: 'net_30', is_active: true },
          { id: 'c-2', company_name: 'PT Dexa Medica', npwp: '01.987.654.3-098.000', address: 'Titan Center Lt. 3, Bintaro', city: 'Tangerang Selatan', country: 'Indonesia', contact_person: 'Ibu Ratna Dewi', email: 'ratna.dewi@dexagroup.com', phone: '081398765432', pbf_license: 'PBF-TNG-2023', gst_vat_type: 'taxable', payment_terms: 'net_60', is_active: true },
        ]),
      });
    }

    // Sales Orders
    if (url.includes('/rest/v1/sales_orders')) {
      if (url.includes('status=eq.pending_approval') || url.includes('approval_status=eq.pending_approval')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'so-1', so_number: 'SO-2026-0045', so_date: '2026-11-01', customer_id: 'c-1', status: 'approved', total_amount: 85000000, currency: 'IDR', customers: { company_name: 'PT Kalbe Farma Tbk' } },
          { id: 'so-2', so_number: 'SO-2026-0046', so_date: '2026-11-02', customer_id: 'c-2', status: 'approved', total_amount: 145000000, currency: 'IDR', customers: { company_name: 'PT Dexa Medica' } },
        ]),
      });
    }

    // Delivery Challans
    if (url.includes('/rest/v1/delivery_challans')) {
      if (url.includes('approval_status=eq.pending_approval')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'dc-1', challan_number: 'DC-2026-0312', challan_date: '2026-11-07', status: 'delivered', approval_status: 'approved', customer_id: 'c-1', customers: { id: 'c-1', company_name: 'PT Kalbe Farma Tbk' }, sales_orders: { so_number: 'SO-2026-0045' }, driver_name: 'Budi Santoso', vehicle_number: 'B 9482 KBA', total_quantity: 450 },
          { id: 'dc-2', challan_number: 'DC-2026-0313', challan_date: '2026-11-07', status: 'dispatched', approval_status: 'approved', customer_id: 'c-2', customers: { id: 'c-2', company_name: 'PT Dexa Medica' }, sales_orders: { so_number: 'SO-2026-0046' }, driver_name: 'Agus Setiawan', vehicle_number: 'B 1204 SS', total_quantity: 200 },
        ]),
      });
    }

    // DC Invoicing Summary
    if (url.includes('/rest/v1/dc_invoicing_summary')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { challan_id: 'dc-1', dc_status: 'delivered', total_items: 1, not_invoiced_items: 0, partially_invoiced_items: 0, fully_invoiced_items: 1, total_remaining_quantity: 0, linked_invoices: ['INV-2026-0101'] },
          { challan_id: 'dc-2', dc_status: 'dispatched', total_items: 1, not_invoiced_items: 1, partially_invoiced_items: 0, fully_invoiced_items: 0, total_remaining_quantity: 200, linked_invoices: [] },
        ]),
      });
    }

    // Delivery Challan Items
    if (url.includes('/rest/v1/delivery_challan_items')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'dci-1', challan_id: 'dc-1', product_id: 'prod-1', quantity: 450, products: { product_name: 'Paracetamol Micronized BP/USP' } },
          { id: 'dci-2', challan_id: 'dc-2', product_id: 'prod-2', quantity: 200, products: { product_name: 'Amoxicillin Trihydrate Compacted' } },
        ]),
      });
    }

    // Sales Invoice Items
    if (url.includes('/rest/v1/sales_invoice_items')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { invoice_id: 'inv-1', delivery_challan_item_id: 'dci-1' }
        ]),
      });
    }

    // Sales Invoices
    if (url.includes('/rest/v1/sales_invoices')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'inv-1', invoice_number: 'INV-2026-0101', invoice_date: '2026-11-07', sales_order_id: 'so-1', linked_challan_ids: ['dc-1'], status: 'unpaid', total_amount: 85000000, balance_amount: 85000000, customer_id: 'c-1', customers: { id: 'c-1', company_name: 'PT Kalbe Farma Tbk' } },
        ]),
      });
    }

    // Purchase Invoices
    if (url.includes('/rest/v1/purchase_invoices')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'pi-1', invoice_number: 'PI-2026-0089', invoice_date: '2026-11-05', due_date: '2026-12-05', currency: 'IDR', exchange_rate: 1, total_amount: 125000000, balance_amount: 45000000, status: 'partial', receiving_approval_status: 'approved', supplier_id: 'sup-1', suppliers: { id: 'sup-1', company_name: 'PT Kimia Farma Trading & Distribution' }, items: [] },
          { id: 'pi-2', invoice_number: 'PI-2026-0090', invoice_date: '2026-11-06', due_date: '2026-12-06', currency: 'USD', exchange_rate: 15850, total_amount: 12500, balance_amount: 12500, status: 'unpaid', receiving_approval_status: 'approved', supplier_id: 'sup-2', suppliers: { id: 'sup-2', company_name: 'Jiangsu Huaxi Pharma Chem Ltd' }, items: [] },
        ]),
      });
    }

    // Receipt Vouchers
    if (url.includes('/rest/v1/receipt_vouchers') || url.includes('/rest/v1/account_vouchers')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'rv-1', voucher_number: 'RV-2026-0034', voucher_date: '2026-11-07', party_type: 'customer', party_id: 'c-1', payment_method: 'bank_transfer', amount: 85000000, currency: 'IDR', is_posted: true, allocated_to: 'INV-2026-0101', bank_accounts: { alias: 'BCA IDR Operating', account_name: 'Bank Central Asia IDR' }, customers: { company_name: 'PT Kalbe Farma Tbk' } },
        ]),
      });
    }

    // Payment Vouchers
    if (url.includes('/rest/v1/payment_vouchers')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'pv-1', voucher_number: 'PV-2026-0056', voucher_date: '2026-11-06', party_type: 'supplier', party_id: 'sup-1', payment_method: 'bank_transfer', amount: 80000000, payment_currency: 'IDR', is_posted: true, bank_accounts: { alias: 'BCA IDR Operating', account_name: 'Bank Central Asia IDR', currency: 'IDR' }, suppliers: { company_name: 'PT Kimia Farma Trading & Distribution' } },
        ]),
      });
    }

    // Expenses
    if (url.includes('/rest/v1/finance_expenses')) {
      if (url.includes('approval_status=eq.pending_approval')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'exp-1', voucher_number: 'EXP-2026-0112', expense_date: '2026-11-05', expense_category: 'transport', amount: 4500000, currency_code: 'IDR', description: 'Container haulage from Tanjung Priok Port', approval_status: 'approved', effective_posting_state: 'ACTIVE', paid_amount: 4500000 },
        ]),
      });
    }

    // Petty Cash
    if (url.includes('/rest/v1/petty_cash_transactions')) {
      if (url.includes('approval_status=eq.pending_approval')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'pc-1', transaction_number: 'PC-2026-0044', transaction_date: '2026-11-07', transaction_type: 'withdraw', amount: 2500000, description: 'Weekly operational petty cash replenishment', approval_status: 'approved' },
        ]),
      });
    }

    // Bank Accounts
    if (url.includes('/rest/v1/bank_accounts')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'bank-1', bank_name: 'Bank Central Asia', account_name: 'PT Sapharma Jaya Ops', account_number: '0848123456', alias: 'BCA IDR Operating', currency: 'IDR', is_active: true },
          { id: 'bank-2', bank_name: 'Bank Central Asia', account_name: 'PT Sapharma Jaya USD', account_number: '0848987654', alias: 'BCA USD Treasury', currency: 'USD', is_active: true },
        ]),
      });
    }

    // Chart of Accounts
    if (url.includes('/rest/v1/chart_of_accounts')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'coa-1', code: '1110', name: 'BCA IDR Operating Account', account_type: 'asset', is_active: true },
          { id: 'coa-2', code: '1120', name: 'Petty Cash IDR', account_type: 'asset', is_active: true },
          { id: 'coa-3', code: '1130', name: 'Accounts Receivable (Trade)', account_type: 'asset', is_active: true },
          { id: 'coa-4', code: '2110', name: 'Accounts Payable (Trade)', account_type: 'liability', is_active: true },
        ]),
      });
    }

    // Staff Master
    if (url.includes('/rest/v1/staff_master')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'staff-1', full_name: 'Budi Santoso', staff_code: 'STF-001', department: 'Logistics', position: 'Senior Driver', is_active: true },
          { id: 'staff-2', full_name: 'Ratna Dewi', staff_code: 'STF-002', department: 'Sales', position: 'Commercial Executive', is_active: true },
        ]),
      });
    }

    // BPJS Register
    if (url.includes('/rest/v1/bpjs_register')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'bpjs-1', period_month: '2026-11', employee_count: 24, total_health_bpjs: 12500000, total_employment_bpjs: 18400000, status: 'posted' },
        ]),
      });
    }

    // Fund Transfers / Contra
    if (url.includes('/rest/v1/fund_transfers')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'ft-1', transfer_number: 'FT-2026-0012', transfer_date: '2026-11-06', amount: 50000000, source_bank_id: 'bank-1', destination_bank_id: 'bank-2', description: 'Treasury currency rebalancing', is_posted: true },
        ]),
      });
    }

    // GL Entries & Journal Entry Lines for General Ledger
    if (url.includes('/rest/v1/journal_entry_lines')) {
      if (url.includes('lt.2026') || url.includes('.lt.')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { debit: 500000000, credit: 0, journal_entries: { entry_date: '2025-12-31', is_posted: true, is_reversed: false } }
          ]),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'jel-1',
            line_number: 1,
            journal_entry_id: 'je-1',
            account_id: 'coa-1',
            debit: 85000000,
            credit: 0,
            description: 'Customer payment received for INV-2026-0101',
            journal_entries: {
              id: 'je-1',
              entry_number: 'JE-2026-0045',
              entry_date: '2026-11-07',
              source_module: 'receipt',
              reference_number: 'RV-2026-0034',
              is_posted: true,
              is_reversed: false,
            },
          },
          {
            id: 'jel-2',
            line_number: 2,
            journal_entry_id: 'je-2',
            account_id: 'coa-1',
            debit: 0,
            credit: 80000000,
            description: 'Supplier payment for PI-2026-0089',
            journal_entries: {
              id: 'je-2',
              entry_number: 'JE-2026-0046',
              entry_date: '2026-11-06',
              source_module: 'payment',
              reference_number: 'PV-2026-0056',
              is_posted: true,
              is_reversed: false,
            },
          },
          {
            id: 'jel-3',
            line_number: 1,
            journal_entry_id: 'je-3',
            account_id: 'coa-1',
            debit: 0,
            credit: 4500000,
            description: 'Container transport settlement EXP-2026-0112',
            journal_entries: {
              id: 'je-3',
              entry_number: 'JE-2026-0047',
              entry_date: '2026-11-05',
              source_module: 'expenses',
              reference_number: 'EXP-2026-0112',
              is_posted: true,
              is_reversed: false,
            },
          },
        ]),
      });
    }

    if (url.includes('/rest/v1/journal_entries')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'je-1', entry_number: 'JE-2026-0045', entry_date: '2026-11-07', source_module: 'receipt', reference_number: 'RV-2026-0034', is_posted: true, is_reversed: false },
          { id: 'je-2', entry_number: 'JE-2026-0046', entry_date: '2026-11-06', source_module: 'payment', reference_number: 'PV-2026-0056', is_posted: true, is_reversed: false },
        ]),
      });
    }

    if (url.includes('/rest/v1/voucher_allocations')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'va-1',
            payment_voucher_id: 'pv-1',
            receipt_voucher_id: null,
            allocated_amount: 80000000,
            allocated_currency: 'IDR',
            purchase_invoices: { invoice_number: 'PI-2026-0089', invoice_date: '2026-11-05' },
          },
        ]),
      });
    }

    // GL Entries
    if (url.includes('/rest/v1/gl_entries')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'gl-1', entry_date: '2026-11-07', voucher_number: 'INV-2026-0101', account_code: '1130', account_name: 'Accounts Receivable', debit: 85000000, credit: 0, description: 'Sales invoice posting' },
          { id: 'gl-2', entry_date: '2026-11-07', voucher_number: 'INV-2026-0101', account_code: '4110', account_name: 'Sales Revenue', debit: 0, credit: 85000000, description: 'Sales invoice revenue' },
        ]),
      });
    }

    // CRM Companies & Contacts
    if (url.includes('/rest/v1/crm_companies')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'crm-c-1', company_name: 'PT Kalbe Farma Tbk', status: 'lead', lead_score: 95, city: 'Jakarta Pusat', industry: 'Pharmaceuticals' },
          { id: 'crm-c-2', company_name: 'PT Dexa Medica', status: 'prospect', lead_score: 88, city: 'Tangerang', industry: 'Pharmaceuticals' },
        ]),
      });
    }

    // WhatsApp Conversations
    if (url.includes('/rest/v1/whatsapp_conversations')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'conv-1', phone_number: '+6281234567890', contact_name: 'Dr. Hendra Gunawan', company_name: 'PT Kalbe Farma Tbk', last_message: 'Thank you for sending the updated Paracetamol COA.', last_message_timestamp: '2026-11-07T14:30:00Z', unread_count: 0 },
        ]),
      });
    }

    // WhatsApp Campaigns
    if (url.includes('/rest/v1/whatsapp_campaigns')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'camp-1', campaign_name: 'Q4 API Catalog Announcement', status: 'completed', target_count: 96, sent_count: 96, delivered_count: 95, read_count: 91, created_at: '2026-11-05T10:00:00Z' },
        ]),
      });
    }

    // Default Fallback
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'content-range': '0-0/0' },
      body: JSON.stringify([]),
    });
  });
}
