import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  adaptProfitabilitySummaryResponse,
  adaptProductBatchesResponse,
  adaptBatchOrdersResponse,
  summarizeQuantitiesByUnit,
} from '../src/utils/salesProfitReportNormalizers.ts';

test('1. adaptProfitabilitySummaryResponse maps live RPC fields (total_qty_sold, total_revenue, total_cogs, total_sales_expenses)', () => {
  const rpcPayload = {
    company: {
      gross_sales: 7613489048.75,
      sales_returns: 1572375.0,
      net_sales: 7611916673.75,
      product_cost: 7087322013.71,
      return_cogs: 1227102.5,
      net_product_cost: 7086094911.21,
      sales_expenses: 65974521.0,
      unallocated_sales_expenses: 1200000.0,
      gross_profit: 525821762.54,
      profit_after_sales_expenses: 459847241.54,
      profit_margin_pct: 6.04,
      total_qty_sold: 80535.25,
      order_count: 89,
      product_count: 26,
    },
    products: [
      {
        product_id: 'p-1',
        product_name: 'Paracetamol Micronized',
        product_code: 'PAR-01',
        product_unit: 'kg',
        total_qty_sold: 80535,
        total_revenue: 7500000000,
        total_cogs: 7000000000,
        total_sales_expenses: 60000000,
        gross_profit: 500000000,
        profit_after_sales_expenses: 440000000,
        costed_lines: 114,
        total_lines: 114,
      },
      {
        product_id: 'p-2',
        product_name: 'Mometasone Furoate',
        product_code: 'MOM-01',
        product_unit: 'g',
        total_qty_sold: 250,
        total_revenue: 113489048.75,
        total_cogs: 87322013.71,
        total_sales_expenses: 4774521,
        gross_profit: 26167035.04,
        profit_after_sales_expenses: 21392514.04,
        costed_lines: 1,
        total_lines: 1,
      },
    ],
    monthly: [],
  };

  const adapted = adaptProfitabilitySummaryResponse(rpcPayload);
  assert.equal(adapted.company.order_count, 89);
  assert.equal(adapted.products.length, 2);
  assert.equal(adapted.products[0].sold_qty, 80535);
  assert.equal(adapted.products[0].gross_sales, 7500000000);
  assert.equal(adapted.products[0].product_cost, 7000000000);
  assert.equal(adapted.products[0].sales_expense, 60000000);
  assert.equal(adapted.products[0].profit_after_sales_expense, 440000000);

  const unitTotals = summarizeQuantitiesByUnit(
    adapted.products.map((p) => ({ unit: p.product_unit, quantity: p.sold_qty }))
  );
  assert.deepEqual(unitTotals, [
    { unit: 'kg', quantity: 80535 },
    { unit: 'g', quantity: 250 },
  ]);
});

test('2. adaptProfitabilitySummaryResponse throws on missing required fields instead of silently substituting zero', () => {
  assert.throws(
    () => adaptProfitabilitySummaryResponse({ company: { gross_sales: 100 }, products: [] }),
    /missing required numeric field/
  );
  assert.throws(
    () => adaptProfitabilitySummaryResponse({ company: { gross_sales: 0, product_cost: 0, sales_expenses: 0, gross_profit: 0, profit_after_sales_expenses: 0, order_count: 1 }, products: [{ product_id: 'x', product_name: 'Missing Qty' }] }),
    /missing sold_qty/
  );
});

test('3. adaptProductBatchesResponse & adaptBatchOrdersResponse accept direct JSON arrays without discarding rows', () => {
  const batchesArray = [
    {
      batch_id: 'b-1',
      batch_number: 'BTC-001',
      sold_qty: 500,
      gross_sales: 50000000,
      product_cost: 40000000,
      sales_expense: 1000000,
    },
  ];
  const adaptedBatches = adaptProductBatchesResponse(batchesArray, 'PAR-01');
  assert.equal(adaptedBatches.length, 1);
  assert.equal(adaptedBatches[0].batch_id, 'b-1');
  assert.equal(adaptedBatches[0].sold_qty, 500);
  assert.equal(adaptedBatches[0].gross_profit, 10000000);
  assert.equal(adaptedBatches[0].profit_after_sales_expense, 9000000);

  const ordersArray = [
    {
      line_id: 'l-1',
      invoice_id: 'inv-1',
      invoice_number: 'INV-2026-001',
      invoice_date: '2026-06-15',
      customer_id: 'c-1',
      customer_name: 'PT Kalbe Farma',
      quantity: 500,
      selling_price: 100000,
      gross_sales: 50000000,
      line_cost: 40000000,
      line_sales_expense: 1000000,
      expenses: [],
    },
  ];
  const adaptedOrders = adaptBatchOrdersResponse(ordersArray, 'BTC-001');
  assert.equal(adaptedOrders.length, 1);
  assert.equal(adaptedOrders[0].invoice_number, 'INV-2026-001');

  assert.throws(() => adaptProductBatchesResponse({ unexpected: true }, 'PAR-01'), /expected JSON array/);
  assert.throws(() => adaptBatchOrdersResponse(null, 'BTC-001'), /expected JSON array/);
});

test('4. Source integrity: salesProfitabilityEngine and salesProfitabilityExcelExport enforce max 3 sheets & adapter usage', () => {
  const engineSrc = fs.readFileSync(path.resolve('src/services/salesProfitabilityEngine.ts'), 'utf8');
  assert.ok(engineSrc.includes('adaptProfitabilitySummaryResponse'), 'Engine must use adaptProfitabilitySummaryResponse');
  assert.ok(engineSrc.includes('adaptProductBatchesResponse'), 'Engine must use adaptProductBatchesResponse');
  assert.ok(engineSrc.includes('adaptBatchOrdersResponse'), 'Engine must use adaptBatchOrdersResponse');
  assert.ok(!engineSrc.includes('bData?.batches || []'), 'Must not discard direct-array batches');
  assert.ok(!engineSrc.includes('oData?.orders || []'), 'Must not discard direct-array orders');

  const exportSrc = fs.readFileSync(path.resolve('src/utils/salesProfitabilityExcelExport.ts'), 'utf8');
  assert.ok(exportSrc.includes("addWorksheet('SUMMARY'"), 'Must define SUMMARY sheet');
  assert.ok(exportSrc.includes("addWorksheet('PRODUCT PROFITABILITY'"), 'Must define PRODUCT PROFITABILITY sheet');
  assert.ok(exportSrc.includes("addWorksheet('SALES DETAIL'"), 'Must define SALES DETAIL sheet');
  assert.ok(exportSrc.includes('Export stopped:'), 'Must stop export with clear error when details are missing');
});
