import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const migrationSql = readFileSync(
  resolve(root, 'supabase/migrations/20261128120000_sales_profitability_report_closure.sql'),
  'utf8'
);
const engineCode = readFileSync(resolve(root, 'src/services/salesProfitabilityEngine.ts'), 'utf8');
const normalizerCode = readFileSync(resolve(root, 'src/utils/salesProfitReportNormalizers.ts'), 'utf8');
const reportUiCode = readFileSync(resolve(root, 'src/pages/reports/CanonicalSalesProfitReport.tsx'), 'utf8');
const excelCode = readFileSync(resolve(root, 'src/utils/salesProfitabilityExcelExport.ts'), 'utf8');

test('1-2. Replacement SQL migration is non-destructive, uses sales_invoice_item_id, and preserves historical snapshots', () => {
  assert.doesNotMatch(migrationSql, /\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)\b/i);
  assert.doesNotMatch(migrationSql, /original_invoice_item_id/i);
  assert.match(migrationSql, /sales_invoice_item_id/i);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.get_authoritative_sales_line_cogs/i);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.get_credit_note_item_fifo_cogs/i);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_summary/i);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_product_batches/i);
  assert.match(migrationSql, /return_details/i);
  assert.match(migrationSql, /profitability_certified/i);
});

test('3. No production query in src/ references non-existent credit_note_items.original_invoice_item_id', () => {
  assert.doesNotMatch(engineCode, /original_invoice_item_id/);
  assert.doesNotMatch(reportUiCode, /original_invoice_item_id/);
  assert.doesNotMatch(excelCode, /original_invoice_item_id/);
});

test('4-6. COGS resolver uses saved snapshots first, never falls back to current batch cost, and fails closed to null', () => {
  const cogsFnStart = engineCode.indexOf('export function resolveAuthoritativeInvoiceItemCOGS');
  const cogsFnEnd = engineCode.indexOf('// ─── Canonical Sales Profitability Loader', cogsFnStart);
  const cogsFnBody = engineCode.slice(cogsFnStart, cogsFnEnd).replace(/\/\/.*$/gm, '');

  const totalIdx = cogsFnBody.indexOf('sii?.cogs_total_cost');
  const unitIdx = cogsFnBody.indexOf('sii?.cogs_unit_cost');
  const ordIdx = cogsFnBody.indexOf('ord.line_cost');
  assert.ok(totalIdx !== -1 && unitIdx !== -1 && ordIdx !== -1);
  assert.ok(totalIdx < ordIdx && unitIdx < ordIdx, 'Saved snapshot must take priority over ord.line_cost');
  assert.doesNotMatch(cogsFnBody, /batchCostPerUnit\s*\*|cost_per_unit|landed_cost_per_unit/);
  assert.match(cogsFnBody, /unitCost:\s*null,\s*lineCost:\s*null,\s*unresolved:\s*true/);
});

test('7-9. Engine uses canonical RPCs without frontend re-accounting, validates product-batch rollup, and skips null batch_id', () => {
  assert.doesNotMatch(engineCode, /\.from\('credit_notes'\)/, 'Must not run duplicate frontend credit-note deduction');
  assert.doesNotMatch(engineCode, /\.from\('finance_expenses'\)/, 'Must not run duplicate frontend unallocated-expense query');
  assert.match(engineCode, /adaptProductBatchEnvelope/);
  assert.match(engineCode, /qtyDiff > 0\.001 \|\| revDiff > 0\.05 \|\| expDiff > 0\.05 \|\| costDiff > 0\.05/);
  assert.match(engineCode, /if \(b\.batch_id\)/);
});

test('10-12. Monthly gross_sales, sales_returns, net_sales stay distinct and UI fails visibly on errors & renders return_details', () => {
  assert.match(normalizerCode, /sales_returns:\s*salesRet/);
  assert.match(normalizerCode, /net_sales:\s*netSalesVal/);
  assert.match(reportUiCode, /setError\(err\?\.message/);
  assert.match(reportUiCode, /throw err/);
  assert.match(reportUiCode, /b\.return_details/);
  assert.match(excelCode, /'Gross Sales \(IDR\)'/);
  assert.match(excelCode, /'Sales Returns \(IDR\)'/);
  assert.match(excelCode, /'Net Sales \(IDR\)'/);
  assert.match(excelCode, /'MONTHLY TOTAL'/);
});
