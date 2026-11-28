import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL;

async function withDbClient(callback) {
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
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function setAuthenticatedUser(client, userId) {
  await client.query('SET ROLE authenticated');
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
}

test('Sales Invoice Creation & DC Quantity Validation Regression Suite', async (t) => {
  let adminId;

  await withDbClient(async (client) => {
    const adminRes = await client.query(`SELECT id FROM user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1`);
    assert.ok(adminRes.rows.length > 0, 'Must have at least one active admin user');
    adminId = adminRes.rows[0].id;
  });

  const DC_ID = 'abda70d6-cede-4a14-bc47-1adea0729f6f'; // DO-26-0073
  const DC_ITEM_ID = 'baadf206-f75f-4109-89e3-2a20f836351f'; // 30 kg approved
  const SO_ID = '655fd213-ffb4-4b4c-95cb-acb10e5dbe0d'; // SO-2026-0087
  const CUSTOMER_ID = 'b8f9dc5e-2cdf-4527-8960-186bb2a30913'; // PT. Rania Kalani Indonesia
  const PRODUCT_ID = 'f9ca763f-47c0-4bfa-b2a0-1905152458c6'; // Dextromethorphan Hydrobromide USP
  const BATCH_ID = 'f767785c-1d74-4b03-b7be-1e6cd6b8282f'; // DX/L/25/0048

  // Helper to isolate test transactions from live uncancelled invoice SAPJ-26-073
  const setupInvoiceTestScenario = async (client) => {
    await client.query(`
      UPDATE sales_invoices
      SET notes = '[CANCELLED on 2026-10-28 for test isolation]'
      WHERE invoice_number = 'SAPJ-26-073'
    `);
  };

  await t.test('1. Cancelled invoices (e.g. SAPJ-26-072) do NOT reduce available DC deliverable quantity', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupInvoiceTestScenario(client);
        await setAuthenticatedUser(client, adminId);

        // DO-26-0073 has 30 kg approved. Cancelled invoice SAPJ-26-072 previously took 20 kg.
        // With the fix, the full 30 kg must be available for invoicing.
        const testInvoiceNumber = 'TEST-INV-CANCELLED-CHECK-' + Date.now();
        const invoicePayload = {
          invoice_number: testInvoiceNumber,
          customer_id: CUSTOMER_ID,
          sales_order_id: SO_ID,
          invoice_date: new Date().toISOString().split('T')[0],
          due_date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
          payment_terms_days: 30,
          discount_amount: 0,
          stamp_duty_amount: 0,
          subtotal: 245263.80,
          tax_amount: 0,
          total_amount: 245263.80,
          notes: 'Test invoice to verify cancelled invoice exclusion'
        };

        const itemsPayload = [
          {
            delivery_challan_item_id: DC_ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            quantity: 30, // Requesting full 30 kg
            unit_price: 8175.46,
            tax_rate: 0
          }
        ];

        const res = await client.query(`
          SELECT public.create_sales_invoice_atomic($1::jsonb, $2::jsonb) as invoice_id
        `, [JSON.stringify(invoicePayload), JSON.stringify(itemsPayload)]);

        assert.ok(res.rows[0].invoice_id, 'Should create invoice successfully for full 30 kg despite cancelled invoice');

        // Confirm database insertion
        const invCheck = await client.query('SELECT invoice_number, total_amount, payment_status FROM sales_invoices WHERE id = $1', [res.rows[0].invoice_id]);
        assert.equal(invCheck.rows[0].invoice_number, testInvoiceNumber);
        assert.equal(invCheck.rows[0].payment_status, 'pending');

        const itemCheck = await client.query('SELECT quantity, unit_price FROM sales_invoice_items WHERE invoice_id = $1', [res.rows[0].invoice_id]);
        assert.equal(itemCheck.rows.length, 1);
        assert.equal(Number(itemCheck.rows[0].quantity), 30);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('2. Active (uncancelled) invoice DOES reduce available DC deliverable quantity and rejects excess', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupInvoiceTestScenario(client);
        await setAuthenticatedUser(client, adminId);

        // Step A: Create an active invoice for 10 kg
        const inv1Number = 'TEST-INV-ACTIVE-1-' + Date.now();
        const invoicePayload1 = {
          invoice_number: inv1Number,
          customer_id: CUSTOMER_ID,
          sales_order_id: SO_ID,
          invoice_date: new Date().toISOString().split('T')[0],
          due_date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
          payment_terms_days: 30,
          discount_amount: 0,
          stamp_duty_amount: 0,
          subtotal: 81754.60,
          tax_amount: 0,
          total_amount: 81754.60,
          notes: 'Active invoice reserving 10 kg'
        };
        const itemsPayload1 = [
          {
            delivery_challan_item_id: DC_ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            quantity: 10,
            unit_price: 8175.46,
            tax_rate: 0
          }
        ];
        const res1 = await client.query(`
          SELECT public.create_sales_invoice_atomic($1::jsonb, $2::jsonb) as invoice_id
        `, [JSON.stringify(invoicePayload1), JSON.stringify(itemsPayload1)]);
        assert.ok(res1.rows[0].invoice_id);

        // Step B: Now DO-26-0073 has 30 - 10 = 20 kg remaining.
        // Attempting to invoice 25 kg MUST FAIL
        const inv2Number = 'TEST-INV-ACTIVE-2-' + Date.now();
        const invoicePayload2 = {
          invoice_number: inv2Number,
          customer_id: CUSTOMER_ID,
          sales_order_id: SO_ID,
          invoice_date: new Date().toISOString().split('T')[0],
          due_date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
          payment_terms_days: 30,
          discount_amount: 0,
          stamp_duty_amount: 0,
          subtotal: 204386.50,
          tax_amount: 0,
          total_amount: 204386.50
        };
        const itemsPayload2 = [
          {
            delivery_challan_item_id: DC_ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            quantity: 25, // 25 > 20 remaining
            unit_price: 8175.46,
            tax_rate: 0
          }
        ];

        let excessCaught = false;
        await client.query('SAVEPOINT sp_excess_test');
        try {
          await client.query(`
            SELECT public.create_sales_invoice_atomic($1::jsonb, $2::jsonb)
          `, [JSON.stringify(invoicePayload2), JSON.stringify(itemsPayload2)]);
        } catch (err) {
          excessCaught = true;
          await client.query('ROLLBACK TO SAVEPOINT sp_excess_test');
          assert.match(err.message, /Invoice quantity exceeds remaining Delivery Challan quantity/);
        }
        assert.ok(excessCaught, 'Must reject invoice quantity when active invoice consumes part of DC');

        // Step C: Invoicing exactly the remaining 20 kg MUST SUCCEED
        const itemsPayload3 = [
          {
            delivery_challan_item_id: DC_ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            quantity: 20, // Exactly remaining 20 kg
            unit_price: 8175.46,
            tax_rate: 0
          }
        ];
        const invoicePayload3 = {
          ...invoicePayload2,
          subtotal: 163509.20,
          total_amount: 163509.20
        };

        const res3 = await client.query(`
          SELECT public.create_sales_invoice_atomic($1::jsonb, $2::jsonb) as invoice_id
        `, [JSON.stringify(invoicePayload3), JSON.stringify(itemsPayload3)]);
        assert.ok(res3.rows[0].invoice_id, 'Should create invoice for exact remaining 20 kg');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('3. Duplicate invoice number is strictly prevented', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setAuthenticatedUser(client, adminId);

        // Fetch an existing invoice number
        const existingRes = await client.query('SELECT invoice_number FROM sales_invoices LIMIT 1');
        assert.ok(existingRes.rows.length > 0);
        const duplicateNumber = existingRes.rows[0].invoice_number;

        const payload = {
          invoice_number: duplicateNumber,
          customer_id: CUSTOMER_ID,
          sales_order_id: SO_ID,
          invoice_date: new Date().toISOString().split('T')[0],
          due_date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
          subtotal: 81754.60,
          total_amount: 81754.60
        };
        const items = [
          {
            delivery_challan_item_id: DC_ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            quantity: 10,
            unit_price: 8175.46,
            tax_rate: 0
          }
        ];

        let errorCaught = false;
        try {
          await client.query(`
            SELECT public.create_sales_invoice_atomic($1::jsonb, $2::jsonb)
          `, [JSON.stringify(payload), JSON.stringify(items)]);
        } catch (err) {
          errorCaught = true;
          assert.match(err.message, /Invoice number already exists/);
        }
        assert.ok(errorCaught, 'Must reject duplicate invoice number');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('4. Atomic rollback: Failed validation does not leave orphaned invoice or item rows', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setAuthenticatedUser(client, adminId);

        const testNumber = 'TEST-CORRUPT-INV-' + Date.now();
        const payload = {
          invoice_number: testNumber,
          customer_id: CUSTOMER_ID,
          sales_order_id: SO_ID,
          invoice_date: new Date().toISOString().split('T')[0],
          due_date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
          subtotal: 999999,
          total_amount: 999999 // Mismatched total vs lines will trigger totals verification error
        };
        const items = [
          {
            delivery_challan_item_id: DC_ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            quantity: 10,
            unit_price: 100, // Line total = 1000 != 999999
            tax_rate: 0
          }
        ];

        await client.query('SAVEPOINT sp_atomic_test');
        try {
          await client.query(`
            SELECT public.create_sales_invoice_atomic($1::jsonb, $2::jsonb)
          `, [JSON.stringify(payload), JSON.stringify(items)]);
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT sp_atomic_test');
        }

        // Verify that no invoice with testNumber was persisted
        const checkInv = await client.query('SELECT count(*) FROM sales_invoices WHERE invoice_number = $1', [testNumber]);
        assert.equal(Number(checkInv.rows[0].count), 0, 'No orphaned invoice header should be persisted');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('5. Retries cannot duplicate stock movements or journal entries during invoice creation', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupInvoiceTestScenario(client);
        await setAuthenticatedUser(client, adminId);

        const txBefore = await client.query('SELECT count(*) FROM inventory_transactions');
        const jeBefore = await client.query('SELECT count(*) FROM journal_entries');

        // Invoice creation is a commercial billing document step:
        // Stock movement occurred upon DC approval (inventory deduction).
        // GL posting for sales invoice occurs upon explicit journal post or approval.
        const testInvoiceNumber = 'TEST-INV-IDEMPOTENCY-' + Date.now();
        const invoicePayload = {
          invoice_number: testInvoiceNumber,
          customer_id: CUSTOMER_ID,
          sales_order_id: SO_ID,
          invoice_date: new Date().toISOString().split('T')[0],
          due_date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
          payment_terms_days: 30,
          discount_amount: 0,
          stamp_duty_amount: 0,
          subtotal: 81754.60,
          tax_amount: 0,
          total_amount: 81754.60
        };
        const itemsPayload = [
          {
            delivery_challan_item_id: DC_ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            quantity: 10,
            unit_price: 8175.46,
            tax_rate: 0
          }
        ];

        const res = await client.query(`
          SELECT public.create_sales_invoice_atomic($1::jsonb, $2::jsonb) as invoice_id
        `, [JSON.stringify(invoicePayload), JSON.stringify(itemsPayload)]);
        assert.ok(res.rows[0].invoice_id);

        const txAfter = await client.query('SELECT count(*) FROM inventory_transactions');
        const jeCountForInv = await client.query('SELECT count(*) FROM journal_entries WHERE reference_number = $1 OR description LIKE $2', [testInvoiceNumber, '%' + testInvoiceNumber + '%']);

        // Stock was already deducted at DC approval, so invoice creation does not deduct stock again
        assert.equal(Number(txAfter.rows[0].count), Number(txBefore.rows[0].count), 'Invoice creation must not duplicate inventory transactions');
        assert.equal(Number(jeCountForInv.rows[0].count), 1, 'Exactly one sales journal entry is created for this invoice');

        // Retrying with the same invoice number must fail and not create a duplicate journal
        let retryCaught = false;
        await client.query('SAVEPOINT sp_retry_test');
        try {
          await client.query(`
            SELECT public.create_sales_invoice_atomic($1::jsonb, $2::jsonb)
          `, [JSON.stringify(invoicePayload), JSON.stringify(itemsPayload)]);
        } catch (err) {
          retryCaught = true;
          await client.query('ROLLBACK TO SAVEPOINT sp_retry_test');
          assert.match(err.message, /Invoice number already exists/);
        }
        assert.ok(retryCaught, 'Retry must be rejected to prevent duplicates');

        const jeCountAfterRetry = await client.query('SELECT count(*) FROM journal_entries WHERE reference_number = $1 OR description LIKE $2', [testInvoiceNumber, '%' + testInvoiceNumber + '%']);
        assert.equal(Number(jeCountAfterRetry.rows[0].count), 1, 'No duplicate journal entries created on retry');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('6. dc_invoicing_summary view and get_pending_dc_items_for_customer reflect accurate quantities', async () => {
    await withDbClient(async (client) => {
      // Step A: In the live database, active invoice SAPJ-26-073 already invoiced all 30 kg, so remaining quantity is 0
      const liveSummary = await client.query(`
        SELECT challan_number, approval_status, total_quantity, total_remaining_quantity
        FROM dc_invoicing_summary
        WHERE challan_id = $1
      `, [DC_ID]);

      assert.equal(liveSummary.rows.length, 1);
      assert.equal(liveSummary.rows[0].challan_number, 'DO-26-0073');
      assert.equal(liveSummary.rows[0].approval_status, 'approved');
      assert.equal(Number(liveSummary.rows[0].total_quantity), 30);
      assert.equal(Number(liveSummary.rows[0].total_remaining_quantity), 0);

      // Step B: Within a transaction where invoices are cancelled (e.g. SAPJ-26-072 and SAPJ-26-073),
      // the view and pending DC items RPC accurately reflect the full 30 kg remaining.
      await client.query('BEGIN');
      try {
        await setupInvoiceTestScenario(client);

        const summaryRes = await client.query(`
          SELECT challan_number, approval_status, total_quantity, total_remaining_quantity
          FROM dc_invoicing_summary
          WHERE challan_id = $1
        `, [DC_ID]);

        assert.equal(summaryRes.rows.length, 1);
        assert.equal(Number(summaryRes.rows[0].total_remaining_quantity), 30);

        const itemsRes = await client.query(`
          SELECT * FROM get_pending_dc_items_for_customer($1, NULL)
        `, [CUSTOMER_ID]);

        const do73 = itemsRes.rows.find(r => r.challan_id === DC_ID);
        assert.ok(do73, 'DO-26-0073 must be present in get_pending_dc_items_for_customer when invoice is cancelled');
        assert.equal(do73.items.length, 1);
        assert.equal(Number(do73.items[0].remaining_quantity), 30);
        assert.equal(Number(do73.items[0].original_quantity), 30);
        assert.equal(do73.items[0].product_name, 'Dextromethorphan Hydrobromide USP');
        assert.equal(do73.items[0].batch_number, 'DX/L/25/0048');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });
});
