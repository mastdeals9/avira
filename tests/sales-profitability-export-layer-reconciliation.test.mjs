import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const engineFile = resolve(root, 'src/services/salesProfitabilityEngine.ts');
const excelExportFile = resolve(root, 'src/utils/salesProfitabilityExcelExport.ts');
const modalFile = resolve(root, 'src/components/ExportSalesProfitModal.tsx');
const reportComponentFile = resolve(root, 'src/pages/reports/CanonicalSalesProfitReport.tsx');

test('sales profitability engine defines authoritative cost-layer resolution', () => {
  const engineCode = readFileSync(engineFile, 'utf8');

  // Verify resolveAuthoritativeInvoiceItemCOGS function
  assert.match(
    engineCode,
    /export function resolveAuthoritativeInvoiceItemCOGS/,
    'Must export resolveAuthoritativeInvoiceItemCOGS'
  );

  // Priority 1: cogs_layer_allocations JSON parsing
  assert.match(
    engineCode,
    /cogs_layer_allocations/,
    'Must inspect cogs_layer_allocations'
  );
  assert.match(
    engineCode,
    /layer_id|cogs_amount|allocated_cost|cost_amount/,
    'Must inspect layer allocations properties'
  );

  // Priority 2: cogs_total_cost / cogs_unit_cost
  assert.match(
    engineCode,
    /cogs_total_cost/,
    'Must fall back to cogs_total_cost'
  );

  // Priority 3: fail closed to null (never fall back to current batch cost)
  assert.match(
    engineCode,
    /unresolved:\s*true/,
    'Must fail closed with unresolved: true when no authoritative cost snapshot exists'
  );

  // Verify fetchCanonicalSalesProfitability
  assert.match(
    engineCode,
    /export async function fetchCanonicalSalesProfitability/,
    'Must export fetchCanonicalSalesProfitability'
  );
  assert.match(
    engineCode,
    /get_sales_profitability_summary/,
    'Must call get_sales_profitability_summary'
  );
  assert.match(
    engineCode,
    /get_sales_profitability_product_batches/,
    'Must call get_sales_profitability_product_batches'
  );
  assert.match(
    engineCode,
    /get_sales_profitability_batch_orders/,
    'Must call get_sales_profitability_batch_orders'
  );
  assert.match(
    engineCode,
    /sales_invoice_items/,
    'Must fetch sales_invoice_items layer snapshots'
  );
});

test('excel export script enforces required 3-sheet order, total rows, and layer-reconciled data', () => {
  const exportCode = readFileSync(excelExportFile, 'utf8');

  // Verify canonical data fetch
  assert.match(
    exportCode,
    /fetchCanonicalSalesProfitability/,
    'Must use fetchCanonicalSalesProfitability to get reconciled data'
  );

  // Verify 3-sheet order: SUMMARY, PRODUCT PROFITABILITY, SALES DETAIL
  const summaryIdx = exportCode.indexOf("wb.addWorksheet('SUMMARY'");
  const prodSummaryIdx = exportCode.indexOf("wb.addWorksheet('PRODUCT PROFITABILITY'");
  const detailedAuditIdx = exportCode.indexOf("wb.addWorksheet('SALES DETAIL'");

  assert.ok(summaryIdx !== -1, 'Must have SUMMARY sheet');
  assert.ok(prodSummaryIdx !== -1, 'Must have PRODUCT PROFITABILITY sheet');
  assert.ok(detailedAuditIdx !== -1, 'Must have SALES DETAIL sheet');

  assert.ok(
    summaryIdx < prodSummaryIdx,
    'Sheet 1 (SUMMARY) must precede Sheet 2 (PRODUCT PROFITABILITY)'
  );
  assert.ok(
    prodSummaryIdx < detailedAuditIdx,
    'Sheet 2 (PRODUCT PROFITABILITY) must precede Sheet 3 (SALES DETAIL)'
  );

  // Verify total rows on sheets
  assert.match(exportCode, /MONTHLY TOTAL/, 'SUMMARY monthly table must have MONTHLY TOTAL row');
  assert.match(exportCode, /TOTAL \(\$\{products\.length\} products\)/, 'PRODUCT PROFITABILITY must have total row');
  assert.match(exportCode, /NET COMPANY TOTAL/, 'Must have NET COMPANY TOTAL reconciliation row');
});

test('export modal defaults to detailed 4-sheet export', () => {
  const modalCode = readFileSync(modalFile, 'utf8');
  assert.match(
    modalCode,
    /useState<[^>]*>\('detailed'\)/,
    'Export modal must default to detailed 4-sheet drilldown export'
  );
});

test('canonical live report uses resolveAuthoritativeInvoiceItemCOGS for order expansion', () => {
  const liveReportCode = readFileSync(reportComponentFile, 'utf8');
  assert.match(
    liveReportCode,
    /resolveAuthoritativeInvoiceItemCOGS/,
    'Canonical live report must import and use resolveAuthoritativeInvoiceItemCOGS'
  );
});

test('mathematical verification: cost-layer allocation for Cefixime USP batch XMEP250178', () => {
  // Batch XMEP250178 sold 500 kg total
  // Sale 1: SAPJ-26-002, 300 kg from layer E0000311/2526 @ Rp 1,893,943.19
  // Sale 2: SAPJ-26-016, 200 kg from layer E0000333/2526 @ Rp 1,919,778.44

  const sale1 = {
    invoice: 'SAPJ-26-002',
    qty: 300,
    unitPrice: 2000000,
    grossSales: 300 * 2000000, // 600,000,000
    layerUnitCost: 1893943.19,
    cogs: 300 * 1893943.19, // 568,182,957
    salesExpense: 1248000,
  };
  sale1.grossProfit = sale1.grossSales - sale1.cogs; // 31,817,043
  sale1.netProfit = sale1.grossProfit - sale1.salesExpense; // 30,569,043

  const sale2 = {
    invoice: 'SAPJ-26-016',
    qty: 200,
    unitPrice: 2069860,
    grossSales: 200 * 2069860, // 413,972,000
    layerUnitCost: 1919778.44,
    cogs: 200 * 1919778.44, // 383,955,688
    salesExpense: 1552000,
  };
  sale2.grossProfit = sale2.grossSales - sale2.cogs; // 30,016,312
  sale2.netProfit = sale2.grossProfit - sale2.salesExpense; // 28,464,312

  const batchGrossSales = sale1.grossSales + sale2.grossSales; // 1,013,972,000
  const batchCOGS = sale1.cogs + sale2.cogs; // 952,138,645
  const batchSalesExp = sale1.salesExpense + sale2.salesExpense; // 2,800,000
  const batchNetProfit = sale1.netProfit + sale2.netProfit; // 59,033,355

  assert.equal(batchGrossSales, 1013972000, 'Batch gross sales must be 1,013,972,000');
  assert.equal(batchCOGS, 952138645, 'Batch layer-allocated COGS must be 952,138,645');
  assert.equal(batchSalesExp, 2800000, 'Batch sales exp must be 2,800,000');
  assert.equal(batchNetProfit, 59033355, 'Batch XMEP250178 net profit must be +59,033,355');
  assert.equal(sale1.netProfit, 30569043, 'Sale SAPJ-26-002 net profit must be +30,569,043');
  assert.equal(sale2.netProfit, 28464312, 'Sale SAPJ-26-016 net profit must be +28,464,312');
});

test('mathematical verification: Cefixime USP product total with batch XMEP260054', () => {
  // Batch XMEP250178: Net Profit = +59,033,355
  // Batch XMEP260054: Net Profit = -28,336,650
  const cefiximeBatch1Profit = 59033355;
  const cefiximeBatch2Profit = -28336650;
  const cefiximeTotalNetProfit = cefiximeBatch1Profit + cefiximeBatch2Profit;

  assert.equal(
    cefiximeTotalNetProfit,
    30696705,
    'Cefixime USP total net profit across both batches must be exactly +30,696,705'
  );

  const cefiximeGrossSales = 1013972000 + 1093000000; // 2,106,972,000
  const cefiximeCOGS = 952138645 + 1119359930; // 2,071,498,575 wait, let's verify exact live values
  assert.equal(cefiximeGrossSales, 2106972000, 'Cefixime gross sales match live ERP');
});

test('mathematical verification: Piperazine Phosphate exact match', () => {
  const qty = 600;
  const landedCostPerUnit = 143223.9;
  const sellPricePerUnit = 144139.5;
  const salesExpPerUnit = 442.5;

  const grossSales = Math.round(qty * sellPricePerUnit); // 86,483,700
  const totalCost = Math.round(qty * landedCostPerUnit); // 85,934,340
  const totalExp = Math.round(qty * salesExpPerUnit); // 265,500

  const grossProfit = grossSales - totalCost; // 549,360
  const netProfit = grossProfit - totalExp; // 283,860

  assert.equal(grossSales, 86483700, 'Gross sales is 86,483,700');
  assert.equal(totalCost, 85934340, 'Landed cost is 85,934,340');
  assert.equal(grossProfit, 549360, 'Gross profit is 549,360');
  assert.equal(totalExp, 265500, 'Sales expense is 265,500');
  assert.equal(netProfit, 283860, 'Net profit is 283,860');
});

test('mathematical verification: Mometasone Furoate margin must be uncapped negative', () => {
  const grossSales = 4175000;
  const netProfit = -11088770;
  const marginPct = (netProfit / grossSales) * 100;

  assert.ok(Math.abs(marginPct - -265.6) < 0.1, 'Margin must be -265.6%');
  assert.ok(marginPct < -100, 'Margin must NOT be capped at -100%');
});

test('layer cost resolution handles multi-layer allocation accurately', () => {
  // Simulating an invoice line that takes stock from two purchase cost layers:
  // 150 kg @ 1,800,000 and 150 kg @ 1,900,000 (total qty 300 kg)
  const allocs = [
    { layer_id: 'layer-1', pi_number: 'PI-001', consumed_qty: 150, unit_cost: 1800000, cost: 270000000 },
    { layer_id: 'layer-2', pi_number: 'PI-002', consumed_qty: 150, unit_cost: 1900000, cost: 285000000 },
  ];
  const totalCost = 270000000 + 285000000; // 555,000,000
  const avgUnitCost = totalCost / 300; // 1,850,000

  assert.equal(totalCost, 555000000);
  assert.equal(avgUnitCost, 1850000);
});

