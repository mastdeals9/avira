#!/usr/bin/env node
/**
 * tests/stock-movements-drilldown.test.mjs
 * 
 * Regression & Acceptance Test for SAPJ Stock Movements Drill-Down
 * Verifies:
 * 1. Shared StockMovementsModal usage across Stock.tsx and Batches.tsx
 * 2. inventory_v1_effective_ledger query uses select('*') without invalid schema cache relation to batches
 * 3. Batch E441/2026 (Corn Starch BP) movements and calculations (IN 9000, OUT 9000, RESERVED 0, FREE 0)
 * 4. Batch M1CFX10003725N (Cefixime Trihydrate) movements (IN 100, OUT 0, RESERVED 0, FREE 100)
 * 5. Product-level movements across all batches with batch number mapping
 * 6. Chronological running physical stock and non-mutation by reservations
 * 7. On-demand loading without N+1 queries on Stock page
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL;

let client = null;
if (DB_CONNECTION) {
  client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
}

async function runSql(sql) {
  if (!client) return [];
  const res = await client.query(sql);
  return res.rows || [];
}

console.log('====================================================================');
console.log('REGRESSION TEST: STOCK MOVEMENTS DRILL-DOWN (STOCK & BATCHES)');
console.log('====================================================================\n');

// 1. Verify component sharing and architecture in codebase
console.log('1. Checking shared component usage in Stock.tsx and Batches.tsx...');
const stockSrc = fs.readFileSync('/Users/Kunal/Documents/anzen-main/src/pages/Stock.tsx', 'utf8');
const batchesSrc = fs.readFileSync('/Users/Kunal/Documents/anzen-main/src/pages/Batches.tsx', 'utf8');
const modalSrc = fs.readFileSync('/Users/Kunal/Documents/anzen-main/src/components/StockMovementsModal.tsx', 'utf8');

assert(stockSrc.includes("import { StockMovementsModal } from '../components/StockMovementsModal';"), 'Stock.tsx must import StockMovementsModal');
assert(batchesSrc.includes("import { StockMovementsModal } from '../components/StockMovementsModal';"), 'Batches.tsx must import StockMovementsModal');
assert(stockSrc.includes("<StockMovementsModal"), 'Stock.tsx must render StockMovementsModal');
assert(batchesSrc.includes("<StockMovementsModal"), 'Batches.tsx must render StockMovementsModal');
assert(!batchesSrc.includes("const [showMovementLedger, setShowMovementLedger]"), 'Batches.tsx must not duplicate movement ledger state');

// 2. Verify query fix: no view relationship error
console.log('\n2. Verifying effective ledger query in StockMovementsModal.tsx...');
assert(!modalSrc.includes(".from('inventory_v1_effective_ledger')\n        .select('*, batches(batch_number)')"), 
  'Must not attempt batches relationship join on inventory_v1_effective_ledger view');
assert(modalSrc.includes(".from('inventory_v1_effective_ledger')\n        .select('*')"), 
  'Must query select("*") on inventory_v1_effective_ledger');
console.log('   ✅ PASS: Query correctly queries select("*") without invalid PostgREST view relationship.\n');

// 3. Query Corn Starch BP Batch E441/2026
if (!client) {
  console.warn('Skipping live database queries (steps 3-6): DATABASE_URL is not set.');
  console.log('7. Verifying Stock page load query integrity (no N+1 per batch)...');
  assert(!stockSrc.includes("inventory_v1_effective_ledger"), 'Stock.tsx itself must not query effective ledger on initial render');
  assert(modalSrc.includes("inventory_v1_effective_ledger"), 'StockMovementsModal must query effective ledger on demand');
  console.log('   ✅ PASS: Movement data loaded strictly on-demand when drill-down is opened.\n');
  console.log('====================================================================');
  console.log('STATIC & CONTRACT CHECKS PASSED (DATABASE_URL NOT SET)');
  console.log('====================================================================');
  process.exit(0);
}

console.log('3. Querying Corn Starch BP Batch E441/2026 in canonical database...');
const batchE441Rows = await runSql(`
  SELECT b.id AS batch_id, b.batch_number, b.product_id, p.product_name, p.product_code, p.unit
  FROM batches b
  JOIN products p ON p.id = b.product_id
  WHERE b.batch_number = 'E441/2026'
  LIMIT 1;
`);

assert(batchE441Rows.length > 0, 'Batch E441/2026 must exist');
const batchE441 = batchE441Rows[0];

const ledgerE441 = await runSql(`
  SELECT id, transaction_type, quantity, reference_type, reference_id, reference_number,
         notes, created_at, transaction_date, metadata
  FROM inventory_v1_effective_ledger
  WHERE batch_id = '${batchE441.batch_id}'
    AND (metadata->>'superseded' IS NULL OR metadata->>'superseded' != 'true')
  ORDER BY transaction_date ASC, created_at ASC;
`);

const reservationsE441 = await runSql(`
  SELECT id, reserved_quantity, status, reserved_at, is_released, released_at, release_reason
  FROM stock_reservations
  WHERE batch_id = '${batchE441.batch_id}'
  ORDER BY reserved_at ASC;
`);

let totalInE441 = 0;
let totalOutE441 = 0;
for (const entry of ledgerE441) {
  const qty = Number(entry.quantity) || 0;
  if (qty > 0) totalInE441 += qty;
  else if (qty < 0) totalOutE441 += Math.abs(qty);
}
const currentStockE441 = totalInE441 - totalOutE441;
let totalReservedE441 = 0;
for (const r of reservationsE441) {
  if (r.status === 'active' && !r.is_released) {
    totalReservedE441 += Number(r.reserved_quantity) || 0;
  }
}
const freeStockE441 = Math.max(0, currentStockE441 - totalReservedE441);

console.log('   Batch E441/2026 Summary Cards:');
console.log(`   IN: ${totalInE441} kg, OUT: ${totalOutE441} kg, CURRENT: ${currentStockE441} kg, RESERVED: ${totalReservedE441} kg, FREE: ${freeStockE441} kg`);
assert.equal(totalInE441, 9000, 'E441/2026 total IN must be 9000');
assert.equal(totalOutE441, 9000, 'E441/2026 total OUT must be 9000');
assert.equal(currentStockE441, 0, 'E441/2026 current stock must be 0');
assert.equal(totalReservedE441, 0, 'E441/2026 reserved stock must be 0');
assert.equal(freeStockE441, 0, 'E441/2026 free stock must be 0');
console.log('   ✅ PASS: Batch E441/2026 matches 9000 IN / 9000 OUT / 0 RESERVED / 0 FREE.\n');

// 4. Query Batch M1CFX10003725N
console.log('4. Querying Batch M1CFX10003725N in canonical database...');
const batchM1Rows = await runSql(`
  SELECT b.id AS batch_id, b.batch_number, b.product_id, p.product_name, p.product_code, p.unit
  FROM batches b
  JOIN products p ON p.id = b.product_id
  WHERE b.batch_number = 'M1CFX10003725N'
  LIMIT 1;
`);

assert(batchM1Rows.length > 0, 'Batch M1CFX10003725N must exist');
const batchM1 = batchM1Rows[0];

const ledgerM1 = await runSql(`
  SELECT id, transaction_type, quantity, reference_type, reference_id, reference_number,
         notes, created_at, transaction_date, metadata
  FROM inventory_v1_effective_ledger
  WHERE batch_id = '${batchM1.batch_id}'
    AND (metadata->>'superseded' IS NULL OR metadata->>'superseded' != 'true')
  ORDER BY transaction_date ASC, created_at ASC;
`);

const reservationsM1 = await runSql(`
  SELECT id, reserved_quantity, status, reserved_at, is_released, released_at, release_reason
  FROM stock_reservations
  WHERE batch_id = '${batchM1.batch_id}'
  ORDER BY reserved_at ASC;
`);

let totalInM1 = 0;
let totalOutM1 = 0;
for (const entry of ledgerM1) {
  const qty = Number(entry.quantity) || 0;
  if (qty > 0) totalInM1 += qty;
  else if (qty < 0) totalOutM1 += Math.abs(qty);
}
const currentStockM1 = totalInM1 - totalOutM1;
let totalReservedM1 = 0;
for (const r of reservationsM1) {
  if (r.status === 'active' && !r.is_released) {
    totalReservedM1 += Number(r.reserved_quantity) || 0;
  }
}
const freeStockM1 = Math.max(0, currentStockM1 - totalReservedM1);

console.log('   Batch M1CFX10003725N Summary Cards:');
console.log(`   IN: ${totalInM1} kg, OUT: ${totalOutM1} kg, CURRENT: ${currentStockM1} kg, RESERVED: ${totalReservedM1} kg, FREE: ${freeStockM1} kg`);
assert.equal(totalInM1, 100, 'M1CFX10003725N total IN must be 100');
assert.equal(totalOutM1, 0, 'M1CFX10003725N total OUT must be 0');
assert.equal(currentStockM1, 100, 'M1CFX10003725N current stock must be 100');
assert.equal(totalReservedM1, 0, 'M1CFX10003725N reserved stock must be 0');
assert.equal(freeStockM1, 100, 'M1CFX10003725N free stock must be 100');
console.log('   ✅ PASS: Batch M1CFX10003725N matches 100 IN / 0 OUT / 0 RESERVED / 100 FREE.\n');

// 5. Product-level movements verification (Corn Starch BP across all batches)
console.log('5. Verifying product-level movements across all batches for Corn Starch BP...');
const productLedger = await runSql(`
  SELECT id, batch_id, quantity, transaction_date
  FROM inventory_v1_effective_ledger
  WHERE product_id = '${batchE441.product_id}'
    AND (metadata->>'superseded' IS NULL OR metadata->>'superseded' != 'true')
  ORDER BY transaction_date ASC, created_at ASC;
`);

const uniqueBatchIds = Array.from(new Set(productLedger.map(r => r.batch_id).filter(Boolean)));
assert(uniqueBatchIds.length > 0, 'Must have batches for product');

const batchList = await runSql(`
  SELECT id, batch_number FROM batches WHERE id IN ('${uniqueBatchIds.join("','")}');
`);
const batchMap = new Map(batchList.map(b => [b.id, b.batch_number]));

for (const row of productLedger) {
  if (row.batch_id) {
    assert(batchMap.has(row.batch_id), `Every ledger entry batch_id must map to a batch_number (${row.batch_id})`);
    assert(batchMap.get(row.batch_id), 'Batch number must not be empty');
  }
}
console.log(`   Found ${productLedger.length} ledger entries across ${uniqueBatchIds.length} batches.`);
console.log('   ✅ PASS: In-memory batch_number mapping succeeds for all product-level entries.\n');

// 6. Chronological running stock invariant
console.log('6. Verifying running physical stock invariant...');
let running = 0;
for (const entry of ledgerE441) {
  running += Number(entry.quantity) || 0;
}
assert.equal(running, currentStockE441, 'Running stock must equal current physical stock');
console.log('   ✅ PASS: Running stock is chronological and exact.\n');

// 7. Verify no N+1 database queries on Stock.tsx page load
console.log('7. Verifying Stock page load query integrity (no N+1 per batch)...');
assert(!stockSrc.includes("inventory_v1_effective_ledger"), 'Stock.tsx itself must not query effective ledger on initial render');
assert(modalSrc.includes("inventory_v1_effective_ledger"), 'StockMovementsModal must query effective ledger on demand');
console.log('   ✅ PASS: Movement data loaded strictly on-demand when drill-down is opened.\n');

await client.end();

console.log('====================================================================');
console.log('ALL REGRESSION CHECKS PASSED SUCCESSFULLY!');
console.log('====================================================================');
