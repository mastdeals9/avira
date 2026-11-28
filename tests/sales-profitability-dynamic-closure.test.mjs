import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const root = process.cwd();
const migrationSql = readFileSync(
  resolve(root, 'supabase/migrations/20261128120000_sales_profitability_report_closure.sql'),
  'utf8'
);
const engineCode = readFileSync(resolve(root, 'src/services/salesProfitabilityEngine.ts'), 'utf8');
const normalizerCode = readFileSync(resolve(root, 'src/utils/salesProfitReportNormalizers.ts'), 'utf8');
const reportUiCode = readFileSync(resolve(root, 'src/pages/reports/CanonicalSalesProfitReport.tsx'), 'utf8');
const excelCode = readFileSync(resolve(root, 'src/utils/salesProfitabilityExcelExport.ts'), 'utf8');

test('1-2. Replacement SQL migration is non-destructive, uses sales_invoice_item_id, removes non-existent inventory_transactions columns, and validates all batch candidates', () => {
  assert.doesNotMatch(migrationSql, /\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)\b/i);
  assert.doesNotMatch(migrationSql, /original_invoice_item_id/i);
  assert.doesNotMatch(migrationSql, /inventory_transactions\.source_id|it\.source_id|it\.unit_cost/i);
  assert.match(migrationSql, /v_original_invoice_id IS NULL OR sii\.invoice_id = v_original_invoice_id/);
  assert.match(migrationSql, /v_total_candidates > 0 AND v_null_candidates = 0 AND v_distinct_unit_cogs = 1/);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.get_authoritative_sales_line_cogs/i);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.get_credit_note_item_fifo_cogs/i);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_summary/i);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_product_batches/i);
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

test('10-12. Certification banner, NULL cost protection, return_details key/field alignment, and Net Sales labels', () => {
  assert.match(normalizerCode, /credit_note_item_id:\s*string/);
  assert.match(normalizerCode, /has_unresolved_cogs:\s*boolean/);
  assert.match(normalizerCode, /sales_returns:\s*salesRet/);
  assert.match(normalizerCode, /net_sales:\s*netSalesVal/);

  assert.match(reportUiCode, /company\.certification_status/);
  assert.match(reportUiCode, /company\.profitability_certified/);
  assert.match(reportUiCode, /p\.product_cost == null/);
  assert.match(reportUiCode, /key=\{rd\.credit_note_item_id\}/);
  assert.match(reportUiCode, /rd\.has_unresolved_cogs/);
  assert.match(reportUiCode, />Net Sales</);

  assert.match(excelCode, /'Net sales \(after returns\)'/);
  assert.match(excelCode, /'Gross Sales \(IDR\)'/);
  assert.match(excelCode, /'Sales Returns \(IDR\)'/);
  assert.match(excelCode, /'Net Sales \(IDR\)'/);
  assert.match(excelCode, /'MONTHLY TOTAL'/);
});

test('13. Live-schema-compatible read-only validation (runs only when READONLY_AUDIT_DB_URL is set)', async (t) => {
  const dbUrl = process.env.READONLY_AUDIT_DB_URL || '';
  if (!dbUrl) {
    t.skip('Skipping live schema validation: READONLY_AUDIT_DB_URL not set');
    return;
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const colCheck = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'credit_note_items' AND column_name IN ('sales_invoice_item_id', 'batch_id', 'product_id', 'quantity', 'total_price'))
          OR (table_name = 'journal_entry_lines' AND column_name = 'sales_invoice_item_id')
          OR (table_name = 'sales_invoice_items' AND column_name IN ('cogs_unit_cost', 'cogs_total_cost'))
        )
    `);
    const found = new Set(colCheck.rows.map((r) => `${r.table_name}.${r.column_name}`));
    for (const req of [
      'credit_note_items.sales_invoice_item_id',
      'credit_note_items.batch_id',
      'journal_entry_lines.sales_invoice_item_id',
      'sales_invoice_items.cogs_unit_cost',
      'sales_invoice_items.cogs_total_cost',
    ]) {
      assert.ok(found.has(req), `Missing expected live column ${req}`);
    }
  } finally {
    await client.end();
  }
});
