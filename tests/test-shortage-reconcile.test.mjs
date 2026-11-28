import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL;

async function withDb(fn) {
  if (!DB_CONNECTION) {
    console.warn('Skipping live database test: DATABASE_URL environment variable is not set.');
    return;
  }
  const client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

test('1. Production schema: reconcile_product_shortages and triggers exist', async () => {
  await withDb(async (client) => {
    // 1. Function exists
    const fnCheck = await client.query(
      "SELECT proname, prosecdef FROM pg_proc WHERE proname = 'reconcile_product_shortages'"
    );
    assert.equal(fnCheck.rowCount, 1, 'reconcile_product_shortages must exist in PostgreSQL');
    assert.equal(fnCheck.rows[0].prosecdef, true, 'reconcile_product_shortages must be SECURITY DEFINER');

    // 2. SO trigger function updated
    const trgFnCheck = await client.query(
      "SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'trg_release_so_product_reservation_status_v2'"
    );
    assert.ok(
      trgFnCheck.rows[0].pg_get_functiondef.includes('reconcile_product_shortages'),
      'trg_release_so_product_reservation_status_v2 must call reconcile_product_shortages'
    );

    // 3. Batch inward trigger exists on batches
    const batchTrg = await client.query(
      "SELECT tgname FROM pg_trigger WHERE tgname = 'trg_batches_shortage_reconcile'"
    );
    assert.equal(batchTrg.rowCount, 1, 'trg_batches_shortage_reconcile must exist on batches');

    // 4. supabase_realtime publication contains core tables
    const pubCheck = await client.query(
      "SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime'"
    );
    const tables = pubCheck.rows.map((r) => r.tablename);
    assert.ok(tables.includes('sales_orders'), 'sales_orders must be published to supabase_realtime');
    assert.ok(tables.includes('batches'), 'batches must be published to supabase_realtime');
    assert.ok(tables.includes('delivery_challans'), 'delivery_challans must be published to supabase_realtime');
    assert.ok(tables.includes('sales_invoices'), 'sales_invoices must be published to supabase_realtime');
    assert.ok(tables.includes('credit_notes'), 'credit_notes must be published to supabase_realtime');
    assert.ok(tables.includes('so_product_reservations'), 'so_product_reservations must be published to supabase_realtime');
  });
});

test('2. Live database simulation: Cyproheptadine ATP and SO-2026-0088 reconciliation in isolated transaction', async () => {
  await withDb(async (client) => {
    await client.query('BEGIN');
    try {
      const prodId = 'c98d9f83-9bc2-4a44-9478-5d2ff3cff67f'; // Cyproheptadine

      // Ensure simulated shortage condition inside isolated rollback transaction
      await client.query("UPDATE sales_orders SET status = 'shortage' WHERE so_number = 'SO-2026-0088'");
      await client.query("UPDATE so_product_reservations SET reserved_quantity = 25 WHERE sales_order_id = (SELECT id FROM sales_orders WHERE so_number = 'SO-2026-0088')");

      // Verify unallocated ATP exists before running reconcile
      const atpRes = await client.query(
        "SELECT available_quantity FROM inventory_v1_stock_summary WHERE product_id = $1",
        [prodId]
      );
      assert.ok(Number(atpRes.rows[0].available_quantity) >= 5, 'At least 5 kg ATP must be available');

      // Call reconcile_product_shortages
      const res = await client.query(
        'SELECT public.reconcile_product_shortages($1) as resolved_count',
        [prodId]
      );
      assert.equal(Number(res.rows[0].resolved_count), 1, 'Exactly 1 shortage order must be resolved');

      // SO-2026-0088 must transition from shortage to stock_reserved
      const checkSo = await client.query(
        "SELECT id, so_number, status FROM sales_orders WHERE so_number = 'SO-2026-0088'"
      );
      assert.equal(checkSo.rows[0].status, 'stock_reserved', 'SO-2026-0088 must transition to stock_reserved');

      // Reservation must increase from 25 to 30
      const checkRes = await client.query(
        'SELECT id, reserved_quantity, status FROM so_product_reservations WHERE sales_order_id = $1',
        [checkSo.rows[0].id]
      );
      assert.equal(Number(checkRes.rows[0].reserved_quantity), 30, 'Reserved quantity must be 30 kg');
      assert.equal(checkRes.rows[0].status, 'active');

      // Pending import requirement must be auto-cancelled
      const checkReq = await client.query(
        'SELECT id, status, shortage_quantity FROM import_requirements WHERE sales_order_id = $1',
        [checkSo.rows[0].id]
      );
      assert.equal(checkReq.rows[0].status, 'cancelled', 'Import requirement must be auto-cancelled');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

test('3. Idempotency & Over-reservation Safety: Repeated triggers do not double-reserve or exceed ATP', async () => {
  await withDb(async (client) => {
    await client.query('BEGIN');
    try {
      const prodId = 'c98d9f83-9bc2-4a44-9478-5d2ff3cff67f';

      // Ensure simulated shortage condition inside isolated rollback transaction
      await client.query("UPDATE sales_orders SET status = 'shortage' WHERE so_number = 'SO-2026-0088'");
      await client.query("UPDATE so_product_reservations SET reserved_quantity = 25 WHERE sales_order_id = (SELECT id FROM sales_orders WHERE so_number = 'SO-2026-0088')");

      // First run: resolves 1 order
      const first = await client.query(
        'SELECT public.reconcile_product_shortages($1) as count',
        [prodId]
      );
      assert.equal(Number(first.rows[0].count), 1, 'First run resolves 1 order');

      // Second run: no more shortage orders exist, returns 0 cleanly without changing stock
      const second = await client.query(
        'SELECT public.reconcile_product_shortages($1) as count',
        [prodId]
      );
      assert.equal(Number(second.rows[0].count), 0, 'Second run must resolve 0 (idempotent)');

      // Verify reservation stayed at exactly 30 kg and didn't double-reserve
      const checkSo = await client.query(
        "SELECT id FROM sales_orders WHERE so_number = 'SO-2026-0088'"
      );
      const checkRes = await client.query(
        'SELECT reserved_quantity FROM so_product_reservations WHERE sales_order_id = $1',
        [checkSo.rows[0].id]
      );
      assert.equal(Number(checkRes.rows[0].reserved_quantity), 30, 'Reserved quantity must stay exactly 30 kg');
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

test('4. ERP Sync Bus: architecture, BroadcastChannel, visibility queueing, and loop prevention contracts', async () => {
  const syncBusPath = path.join(process.cwd(), 'src/utils/erpSyncBus.ts');
  assert.ok(fs.existsSync(syncBusPath), 'erpSyncBus.ts must exist');

  const content = fs.readFileSync(syncBusPath, 'utf8');

  // Verify BroadcastChannel implementation
  assert.ok(
    content.includes("BroadcastChannel('sapj_erp_sync_bus')") || content.includes('BROADCAST_CHANNEL_NAME = \'sapj_erp_sync_bus\''),
    'erpSyncBus must instantiate BroadcastChannel sapj_erp_sync_bus for 0ms cross-tab latency'
  );

  // Verify originTabId loop guard
  assert.ok(
    content.includes('originTabId !== TAB_ID'),
    'erpSyncBus must check originTabId !== TAB_ID to prevent infinite broadcast reflection loops'
  );

  // Verify tab visibility awareness
  assert.ok(
    content.includes('document.hidden') && content.includes('pendingDirtyRef.current = true'),
    'erpSyncBus must check document.hidden and queue dirty flag to minimize background I/O'
  );

  // Verify debouncing
  assert.ok(
    content.includes('debounceMs') && content.includes('setTimeout'),
    'erpSyncBus must debounce incoming refresh calls (default 150ms)'
  );

  // Verify supported ERP domains
  const expectedDomains = [
    'sales_orders',
    'inventory',
    'delivery_challans',
    'sales_invoices',
    'credit_notes',
    'expenses',
    'petty_cash',
    'bank_transactions',
    'vouchers',
    'purchases',
    'material_returns',
    'crm',
    'dashboard'
  ];
  expectedDomains.forEach((d) => {
    assert.ok(content.includes(`'${d}'`), `erpSyncBus must support domain '${d}'`);
  });
});

test('5. Cross-Module UI Wiring: Verify core components import and use erpSyncBus', async () => {
  const checkList = [
    { file: 'src/pages/SalesOrders.tsx', expected: ['useErpSyncListener', 'emitErpSync', 'handleRecheckShortage'] },
    { file: 'src/pages/Batches.tsx', expected: ['useErpSyncListener', 'emitErpSync'] },
    { file: 'src/pages/Stock.tsx', expected: ['useErpSyncListener'] },
    { file: 'src/pages/Inventory.tsx', expected: ['useErpSyncListener', 'emitErpSync'] },
    { file: 'src/components/StockMovementsModal.tsx', expected: ['useErpSyncListener'] },
    { file: 'src/pages/DeliveryChallan.tsx', expected: ['useErpSyncListener', 'emitErpSync'] },
    { file: 'src/pages/Sales.tsx', expected: ['useErpSyncListener', 'emitErpSync'] },
    { file: 'src/pages/CreditNotes.tsx', expected: ['useErpSyncListener', 'emitErpSync'] },
    { file: 'src/components/finance/ReceivablesManager.tsx', expected: ['useErpSyncListener', 'emitErpSync'] },
    { file: 'src/components/finance/ReceiptVoucherManager.tsx', expected: ['useErpSyncListener', 'emitErpSync'] },
    { file: 'src/components/finance/PaymentVoucherManager.tsx', expected: ['useErpSyncListener', 'emitErpSync'] },
    { file: 'src/components/finance/ExpenseManager.tsx', expected: ['useErpSyncListener', 'emitErpSync'] },
    { file: 'src/components/finance/PettyCashManager.tsx', expected: ['useErpSyncListener'] },
    { file: 'src/components/finance/BankReconciliationEnhanced.tsx', expected: ['useErpSyncListener'] },
    { file: 'src/components/finance/FundTransferManager.tsx', expected: ['useErpSyncListener'] },
    { file: 'src/pages/MaterialReturns.tsx', expected: ['useErpSyncListener', 'emitErpSync'] },
    { file: 'src/pages/PurchaseOrders.tsx', expected: ['useErpSyncListener', 'emitErpSync'] },
    { file: 'src/pages/Dashboard.tsx', expected: ['useErpSyncListener'] },
  ];

  checkList.forEach(({ file, expected }) => {
    const fullPath = path.join(process.cwd(), file);
    assert.ok(fs.existsSync(fullPath), `${file} must exist`);
    const code = fs.readFileSync(fullPath, 'utf8');
    expected.forEach((term) => {
      assert.ok(code.includes(term), `${file} must include ${term}`);
    });
  });
});
