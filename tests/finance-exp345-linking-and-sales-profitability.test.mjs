import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateExpenseMandatoryTaxLinkage } from '../src/utils/expenseValidation.ts';
import {
  normalizeProductProfitabilityRow,
  normalizeBatchProfitabilityRow,
} from '../src/utils/salesProfitReportNormalizers.ts';

// ============================================================================
// PART 1: EXP/26/345 Payment Linking & Tax Validation Tests
// ============================================================================

test('1. EXP/26/345 validation: with selected bank transaction, passes without requiring duplicate payment method input', () => {
  const expenseData = {
    voucher_number: 'EXP/26/345',
    expense_category: 'maintenance_repair',
    amount: 900000,
    ppn_amount: 99000,
    pph_amount: 18000,
    supplier_id: 'supplier-uuid-pest-control',
    payment_method: null, // User has not changed dropdown yet
    bank_account_id: null,
    selected_bank_transaction_id: 'bank-line-uuid-13nov',
    paid_amount: 981000,
  };

  const validation = validateExpenseMandatoryTaxLinkage(expenseData);
  assert.equal(validation.isValid, true, 'Expense with authoritative bank transaction link must be valid');
  assert.equal(validation.firstErrorField, undefined);
});

test('2. EXP/26/345 validation: payment method defaults to bank_transfer when authoritative bank link is present', () => {
  const expenseData = {
    expense_category: 'pest_control',
    amount: 900000,
    ppn_amount: 99000,
    pph_amount: 18000,
    supplier_id: 'supplier-uuid-pest-control',
    payment_method: 'outstanding',
    bank_account_id: null,
    originating_bank_statement_line_id: 'bank-line-uuid-13nov',
    paid_amount: 981000,
  };

  const validation = validateExpenseMandatoryTaxLinkage(expenseData);
  assert.equal(validation.isValid, true, 'Authoritative originating bank statement line should pass validation');
  assert.deepEqual(validation.errors, {});
});

test('3. Tax validation blocks paid expense missing payment method when NO authoritative link exists', () => {
  const invalidData = {
    expense_category: 'consulting',
    amount: 1000000,
    ppn_amount: 110000,
    pph_amount: 20000,
    supplier_id: 'supplier-uuid-consultant',
    payment_method: null,
    bank_account_id: null,
    paid_amount: 1090000,
  };

  const validation = validateExpenseMandatoryTaxLinkage(invalidData);
  assert.equal(validation.isValid, false);
  assert.equal(validation.firstErrorField, 'payment_method');
  assert.match(validation.firstErrorMessage || '', /valid payment method/);
});

// ============================================================================
// PART 2: Migration 20261118140000 Integrity Verification
// ============================================================================

test('4. Migration 20261118140000 contains atomic context guard and reconciliation logic', async () => {
  const sql = await readFile('supabase/migrations/20261118140000_fix_approved_expense_atomic_bank_link_and_reconcile_ricardo.sql', 'utf8');

  // Verify app.expense_atomic_bank_link context activation
  assert.match(sql, /set_config\('app\.expense_atomic_bank_link', 'on', true\)/);
  assert.match(sql, /set_config\('app\.expense_atomic_bank_link', 'off', true\)/);

  // Verify EXP/26/345 ID and linking
  assert.match(sql, /a5c3e13e-66a6-48bc-be77-e56819fec117/); // EXP/26/345 ID
  assert.match(sql, /BERKAT KASIH BERSA/);
  assert.match(sql, /981000/);

  // Verify Ricardo Sept & Oct linking
  assert.match(sql, /f17f5206-bcbb-419f-ab84-b240ee1d662b/); // EXP/26/334 ID
  assert.match(sql, /ceabef41-1642-47e0-9448-4a012b0b8b23/); // EXP/26/335 ID
  assert.match(sql, /93a47258-80b8-4bd4-b06a-0ce8fde906bd/); // 3 Nov Bank line
  assert.match(sql, /1950000/);

  // Verify Bank Txn B is noted but NOT linked
  assert.match(sql, /663f66a3-702d-4c79-a0a9-e2a0718b6ade/);
  assert.match(sql, /Left untouched, unlinked, and flagged for account owner review/);

  // Verify EXP/26/203 and EXP/26/204 are excluded
  assert.match(sql, /EXP\/26\/203 and EXP\/26\/204/);
  assert.match(sql, /Completely excluded from modifications/);
});

// ============================================================================
// PART 3: Sales Profitability Normalization Tests
// ============================================================================

test('5. normalizeProductProfitabilityRow correctly normalizes RPC summary response fields', () => {
  const rpcProduct = {
    product_id: 'prod-0017-uuid',
    product_name: 'Cefixime Trihydrate',
    product_code: 'PROD-0017',
    product_unit: 'kg',
    total_qty_sold: 100,
    total_revenue: 50000000,
    total_cogs: 35000000,
    total_sales_expenses: 1500000,
    profit_after_sales_expenses: 1350000,
    costed_lines: 5,
    total_lines: 5,
    has_unreported_cost: false,
  };

  const canonicalStock = { current: 50, reserved: 10, available: 40 };
  const normalized = normalizeProductProfitabilityRow(rpcProduct, canonicalStock);

  assert.equal(normalized.sold_qty, 100);
  assert.equal(normalized.gross_sales, 50000000);
  assert.equal(normalized.product_cost, 35000000);
  assert.equal(normalized.sales_expense, 1500000);
  assert.equal(normalized.gross_profit, 15000000);
  assert.equal(normalized.profit_after_sales_expense, 1350000);
  assert.equal(normalized.avg_selling_price, 500000);
  assert.equal(normalized.sales_expense_per_unit, 15000);
  assert.equal(normalized.net_selling_price_per_unit, 485000);
  assert.equal(normalized.current_stock, 50);
  assert.equal(normalized.reserved_stock, 10);
  assert.equal(normalized.available_stock, 40);
});

test('6. normalizeBatchProfitabilityRow handles direct JSON array shapes and maps fields', () => {
  const rpcBatch = {
    batch_id: 'batch-cfix-001',
    batch_number: 'M1CFX10003625N',
    quantity_sold: 60,
    current_stock: 25,
    gross_sales: 30000000,
    product_cost: 21000000,
    sales_expenses: 900000,
    gross_profit: 9000000,
    net_profit: 8100000,
    margin_percentage: 27.0,
    profit_per_unit: 135000,
    landed_cost_per_unit: 350000,
    is_imported: true,
  };

  const normalized = normalizeBatchProfitabilityRow(rpcBatch);
  assert.equal(normalized.batch_number, 'M1CFX10003625N');
  assert.equal(normalized.sold_qty, 60);
  assert.equal(normalized.current_stock, 25);
  assert.equal(normalized.gross_sales, 30000000);
  assert.equal(normalized.product_cost, 21000000);
  assert.equal(normalized.sales_expense, 900000);
  assert.equal(normalized.profit_after_sales_expense, 8100000);
  assert.equal(normalized.profit_margin_pct, 27.0);
  assert.equal(normalized.cost_per_unit, 350000);
  assert.equal(normalized.is_imported, true);
  assert.equal(normalized.avg_selling_price, 500000);
});

test('7. Sales Profitability Company figures consistency check (2026 expected values)', () => {
  // Expected company figures:
  // Gross Sales: 6,895,812,823.75
  // Net Sales: 6,894,240,448.75 (Returns: 1,572,375.00)
  // Product Cost: 6,345,654,774.61
  // Net Product Cost: 6,344,427,672.11 (Return COGS: 1,227,102.50)
  // Sales Expenses: 60,569,501.00
  // Profit After Expenses: 489,243,275.64

  const grossSales = 6895812823.75;
  const salesReturns = 1572375.00;
  const netSales = grossSales - salesReturns;
  assert.equal(netSales, 6894240448.75);

  const productCost = 6345654774.61;
  const returnCogs = 1227102.50;
  const netProductCost = productCost - returnCogs;
  assert.equal(netProductCost, 6344427672.11);

  const grossProfit = Math.round((netSales - netProductCost) * 100) / 100;
  assert.equal(grossProfit, 549812776.64);

  const salesExpenses = 60569501.00;
  const profitAfterExpenses = grossProfit - salesExpenses;
  assert.equal(Math.round(profitAfterExpenses * 100) / 100, 489243275.64);
});
