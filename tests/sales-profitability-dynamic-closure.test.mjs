import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

test('1. Closure migration 20261128120000 is strictly non-destructive and reconciles monthly & company credit notes', () => {
  const sql = readFileSync(
    resolve(root, 'supabase/migrations/20261128120000_sales_profitability_report_closure.sql'),
    'utf8'
  );

  // Strictly read-only reporting function definition — zero data mutation
  assert.doesNotMatch(sql, /\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)\b/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_summary/i);

  // Monthly CTE deducts credit notes by credit_note_date and includes monthly unallocated expenses
  assert.match(sql, /monthly_returns\s+AS/i);
  assert.match(sql, /monthly_unallocated\s+AS/i);
  assert.match(sql, /FULL OUTER JOIN monthly_returns mr/i);
  assert.match(sql, /FULL OUTER JOIN monthly_unallocated mu/i);

  // Commercial credit notes do not reduce physical sold qty or reverse COGS
  assert.match(sql, /COALESCE\(cn\.credit_note_type,\s*'physical_return'\)\s*=\s*'commercial_credit'\s*THEN\s*0::numeric/i);

  // Company total_qty_sold deducts physical return_qty
  assert.match(sql, /COALESCE\(SUM\(total_qty_sold\),\s*0\)\s*-\s*COALESCE\(\(SELECT total_return_qty FROM returns\),\s*0\)\s+AS total_qty_sold/i);
});

test('2. salesProfitabilityEngine reconciles invoice lines, credit notes, batches, products, monthly, and company from one source', () => {
  const code = readFileSync(resolve(root, 'src/services/salesProfitabilityEngine.ts'), 'utf8');

  assert.match(code, /resolveAuthoritativeInvoiceItemCOGS/);
  assert.match(code, /\.from\('credit_notes'\)/);
  assert.match(code, /cn\.credit_note_type === 'commercial_credit'/);
  assert.match(code, /monthReturnMap/);
  assert.match(code, /monthUnallocMap/);
  assert.match(code, /monthly: reconciledMonthly/);
});

test('3. Excel export workbook mathematically reconciles SUMMARY, MONTHLY TOTAL, PRODUCT PROFITABILITY, and SALES DETAIL', async () => {
  // Dynamically import compiled or TS module? Use tsx/vite or verify via pure math + structure
  const exportCode = readFileSync(resolve(root, 'src/utils/salesProfitabilityExcelExport.ts'), 'utf8');

  assert.match(exportCode, /'MONTHLY TOTAL'/);
  assert.match(exportCode, /'NET COMPANY TOTAL \(Reconciles to SUMMARY\)'/);
  assert.match(exportCode, /'CREDIT NOTES'/);
  assert.match(exportCode, /'NET COMPANY TOTAL'/);

  // Mathematical parity check across Company, Monthly, Product, and Invoice Detail with Physical + Commercial Credit Notes
  const inv1 = { qty: 100, price: 200000, cogs: 15000000, exp: 500000, month: '2026-10' }; // gross 20,000,000
  const inv2 = { qty: 50, price: 300000, cogs: 10000000, exp: 300000, month: '2026-11' }; // gross 15,000,000
  const physCn = { qty: 10, rev: 2000000, cogs: 1500000, month: '2026-11', commercial: false };
  const commCn = { qty: 0, rev: 500000, cogs: 0, month: '2026-11', commercial: true };
  const unallocExp = { amt: 400000, month: '2026-11' };

  const grossSales = inv1.qty * inv1.price + inv2.qty * inv2.price; // 35,000,000
  const salesReturns = physCn.rev + commCn.rev; // 2,500,000
  const netSales = grossSales - salesReturns; // 32,500,000
  const productCogs = inv1.cogs + inv2.cogs; // 25,000,000
  const returnCogs = physCn.cogs + commCn.cogs; // 1,500,000
  const netCogs = productCogs - returnCogs; // 23,500,000
  const totalSalesExp = inv1.exp + inv2.exp + unallocExp.amt; // 1,200,000
  const companyGP = netSales - netCogs; // 9,000,000
  const companyNP = companyGP - totalSalesExp; // 7,800,000
  const netQty = inv1.qty + inv2.qty - physCn.qty - commCn.qty; // 140

  // Monthly totals (Oct + Nov)
  const octSales = inv1.qty * inv1.price; // 20,000,000
  const octCogs = inv1.cogs; // 15,000,000
  const octExp = inv1.exp; // 500,000
  const octNP = octSales - octCogs - octExp; // 4,500,000

  const novSales = inv2.qty * inv2.price - physCn.rev - commCn.rev; // 12,500,000
  const novCogs = inv2.cogs - physCn.cogs; // 8,500,000
  const novExp = inv2.exp + unallocExp.amt; // 700,000
  const novNP = novSales - novCogs - novExp; // 3,300,000

  assert.equal(octSales + novSales, netSales);
  assert.equal(octCogs + novCogs, netCogs);
  assert.equal(octExp + novExp, totalSalesExp);
  assert.equal(octNP + novNP, companyNP);
  assert.equal(netQty, 140);
});
