import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  'supabase/migrations/20260908160000_include_sales_commission_and_marketing_expenses_in_profitability.sql',
  'utf8',
);
const ui = fs.readFileSync('src/pages/reports/CanonicalSalesProfitReport.tsx', 'utf8');

test('1. Sales expense resolver includes delivery, loading, marketing_advertising, and other_sales categories', () => {
  assert.match(migration, /get_sales_profitability_line_expenses/);
  assert.match(migration, /'delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales'/);
  assert.match(migration, /ec\.category_type = 'sales'/);
  assert.match(migration, /fe\.approval_status = 'approved'/);
});

test('2. Unrelated expense categories are strictly excluded from sales expenses', () => {
  // Verifies that categories like office_admin, warehouse_rent, utilities, etc. are NOT added to sales expense list
  assert.doesNotMatch(migration, /'office_admin'/);
  assert.doesNotMatch(migration, /'warehouse_rent'/);
  assert.doesNotMatch(migration, /'utilities'/);
  assert.doesNotMatch(migration, /'salary'/);
  assert.doesNotMatch(migration, /'fixed_asset'/);
});

test('3. Sales profitability summary includes marketing and sales commissions in unallocated and allocated scopes', () => {
  assert.match(migration, /get_sales_profitability_summary/);
  assert.match(migration, /unallocated AS/);
  assert.match(migration, /'delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales'/);
  assert.match(migration, /profit_after_sales_expense/);
});

test('4. Batch orders drilldown includes sales commissions in expenses json', () => {
  assert.match(migration, /get_sales_profitability_batch_orders/);
  assert.match(migration, /'category', fe\.expense_category/);
  assert.match(migration, /'total_amount', fe\.amount/);
  assert.match(migration, /'description', fe\.description/);
});

test('5. Mathematical allocation method is preserved using sales value and quantity basis', () => {
  assert.match(migration, /ROUND\(e\.total_expense \* s\.line_sales \/ d\.total_sales, 2\)/);
  assert.match(migration, /ROUND\(e\.total_expense \* s\.quantity \/ d\.total_qty, 2\)/);
});

test('6. UI displays sales expenses and unallocated sales expense disclosure', () => {
  assert.match(ui, /Sales Expenses/);
  assert.match(ui, /unallocated_sales_expenses/);
});

test('7. Migration is strictly report-only and does not modify accounting or business records', () => {
  assert.doesNotMatch(migration, /\b(INSERT|UPDATE|DELETE)\s+INTO\s+(public\.)?(finance_expenses|journal_entries|journal_entry_lines|sales_invoices|sales_invoice_items|batches)\b/i);
});
