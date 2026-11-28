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

test('Delivery Challan Edit, Recovery & Quantity Validation Regression Suite', async (t) => {
  let adminId;

  await withDbClient(async (client) => {
    const adminRes = await client.query(`SELECT id FROM user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1`);
    assert.ok(adminRes.rows.length > 0, 'Must have at least one active admin user');
    adminId = adminRes.rows[0].id;
  });

  const DC_ID = 'abda70d6-cede-4a14-bc47-1adea0729f6f'; // DO-26-0073
  const SO_ID = '655fd213-ffb4-4b4c-95cb-acb10e5dbe0d'; // SO-2026-0087
  const SO_ITEM_ID = '2a1def7d-a77f-4873-b2c9-aeefc26d6689'; // ordered 30
  const PRODUCT_ID = 'f9ca763f-47c0-4bfa-b2a0-1905152458c6';
  const BATCH_ID = 'f767785c-1d74-4b03-b7be-1e6cd6b8282f';
  const ITEM_ID = 'baadf206-f75f-4109-89e3-2a20f836351f';
  const CUSTOMER_ID = 'b8f9dc5e-2cdf-4527-8960-186bb2a30913';

  // Helper to isolate pending draft state inside rollbacked test transactions
  const setupPendingScenario = async (client) => {
    // Isolate active live invoice SAPJ-26-073 within this transaction so tests can simulate pre-invoiced DC lifecycle
    await client.query(`
      UPDATE sales_invoices
      SET notes = '[CANCELLED on 2026-10-28 for test isolation]'
      WHERE invoice_number = 'SAPJ-26-073'
    `);
    await client.query("UPDATE delivery_challans SET approval_status = 'pending_approval' WHERE id = $1", [DC_ID]);
    await client.query("UPDATE sales_order_items SET delivered_quantity = 0 WHERE id = $1", [SO_ITEM_ID]);
  };

  await t.test('1. Reproduction of 20 + 30 = 50 quantity double counting when trigger does not skip or exclude current DC', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('RESET ROLE');
        await setupPendingScenario(client);
        // Ensure DO-26-0073 item has 20 kg for mathematical reproduction
        await client.query('UPDATE delivery_challan_items SET quantity = 20 WHERE id = $1', [ITEM_ID]);

        // Define the buggy trigger function that omitted skip check and current DC exclusion
        await client.query(`
          CREATE OR REPLACE FUNCTION public.test_buggy_validate_dc_item()
          RETURNS trigger LANGUAGE plpgsql AS $$
          DECLARE
            v_dc record;
            v_so_item public.sales_order_items%ROWTYPE;
            v_pending numeric;
            v_remaining numeric;
          BEGIN
            SELECT dc.sales_order_id, dc.approval_status INTO v_dc
            FROM public.delivery_challans dc WHERE dc.id = NEW.challan_id;

            SELECT * INTO v_so_item FROM public.sales_order_items soi WHERE soi.id = NEW.sales_order_item_id;

            -- BUG: dci.id IS DISTINCT FROM NEW.id but fails to exclude NEW.challan_id
            SELECT COALESCE(sum(dci.quantity), 0) INTO v_pending
            FROM public.delivery_challan_items dci
            JOIN public.delivery_challans dc ON dc.id = dci.challan_id
            WHERE dci.sales_order_item_id = NEW.sales_order_item_id
              AND dc.approval_status = 'pending_approval'
              AND dci.id IS DISTINCT FROM NEW.id;

            v_remaining := v_so_item.quantity - COALESCE(v_so_item.delivered_quantity, 0);
            IF (v_pending + NEW.quantity) > (v_remaining + 0.0001) THEN
              RAISE EXCEPTION 'Delivery quantity (%) exceeds remaining Sales Order quantity (%)', (v_pending + NEW.quantity), v_remaining;
            END IF;
            RETURN NEW;
          END;
          $$;
        `);

        let errorCaught = false;
        try {
          const dummyNewId = '00000000-0000-0000-0000-000000000001';
          const query = `
            DO $$
            DECLARE
              v_pending numeric;
              v_remaining numeric;
            BEGIN
              SELECT COALESCE(sum(dci.quantity), 0) INTO v_pending
              FROM public.delivery_challan_items dci
              JOIN public.delivery_challans dc ON dc.id = dci.challan_id
              WHERE dci.sales_order_item_id = '${SO_ITEM_ID}'
                AND dc.approval_status = 'pending_approval'
                AND dci.id IS DISTINCT FROM '${dummyNewId}';

              v_remaining := 30.000;
              IF (v_pending + 30.0) > (v_remaining + 0.0001) THEN
                RAISE EXCEPTION 'Delivery quantity (%) exceeds remaining Sales Order quantity (%)', (v_pending + 30.0), v_remaining;
              END IF;
            END;
            $$;
          `;
          await client.query(query);
        } catch (err) {
          errorCaught = true;
          assert.match(err.message, /Delivery quantity \(50(\.0+)?\) exceeds remaining Sales Order quantity \(30(\.0+)?\)/);
        }
        assert.ok(errorCaught, 'Must reproduce the 20 + 30 = 50 defect mathematically');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('2. Successful Save with approval_status = pending_approval for DO-26-0073', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await setAuthenticatedUser(client, adminId);

        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          DC_ID,
          JSON.stringify([{
            id: ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            sales_order_item_id: SO_ITEM_ID,
            quantity: 20
          }]),
          JSON.stringify({
            customer_id: CUSTOMER_ID,
            approval_status: 'pending_approval',
            delivery_address: 'Verified Test Address'
          })
        ]);

        const result = res.rows[0].result;
        assert.equal(result.success, true);

        const check = await client.query('SELECT approval_status, delivery_address FROM delivery_challans WHERE id = $1', [DC_ID]);
        assert.equal(check.rows[0].approval_status, 'pending_approval');
        assert.equal(check.rows[0].delivery_address, 'Verified Test Address');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('3. Edit quantity from 20 kg to 30 kg without item id (in-place match succeeds, does NOT report 50 kg)', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await setAuthenticatedUser(client, adminId);

        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          DC_ID,
          JSON.stringify([{
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            sales_order_item_id: SO_ITEM_ID,
            quantity: 30
          }]),
          JSON.stringify({
            approval_status: 'pending_approval'
          })
        ]);

        const result = res.rows[0].result;
        assert.equal(result.success, true);

        const itemsRes = await client.query('SELECT id, quantity FROM delivery_challan_items WHERE challan_id = $1', [DC_ID]);
        assert.equal(itemsRes.rows.length, 1);
        assert.equal(Number(itemsRes.rows[0].quantity), 30);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('4. Edit quantity from 20 kg to 30 kg with item id (in-place update succeeds)', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await setAuthenticatedUser(client, adminId);

        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          DC_ID,
          JSON.stringify([{
            id: ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            sales_order_item_id: SO_ITEM_ID,
            quantity: 30
          }]),
          JSON.stringify({
            approval_status: 'pending_approval'
          })
        ]);

        const result = res.rows[0].result;
        assert.equal(result.success, true);

        const itemsRes = await client.query('SELECT id, quantity FROM delivery_challan_items WHERE challan_id = $1', [DC_ID]);
        assert.equal(itemsRes.rows.length, 1);
        assert.equal(itemsRes.rows[0].id, ITEM_ID);
        assert.equal(Number(itemsRes.rows[0].quantity), 30);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('5. Idempotent save: Saving the same quantity twice succeeds identically', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await setAuthenticatedUser(client, adminId);

        for (let i = 0; i < 2; i++) {
          const res = await client.query(`
            SELECT edit_delivery_challan(
              $1::uuid,
              $2::jsonb,
              $3::jsonb
            ) as result
          `, [
            DC_ID,
            JSON.stringify([{
              id: ITEM_ID,
              product_id: PRODUCT_ID,
              batch_id: BATCH_ID,
              sales_order_item_id: SO_ITEM_ID,
              quantity: 25
            }]),
            JSON.stringify({ approval_status: 'pending_approval' })
          ]);
          assert.equal(res.rows[0].result.success, true);
        }

        const itemsRes = await client.query('SELECT count(*), max(quantity) as qty FROM delivery_challan_items WHERE challan_id = $1', [DC_ID]);
        assert.equal(Number(itemsRes.rows[0].count), 1);
        assert.equal(Number(itemsRes.rows[0].qty), 25);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('6. Increase quantity by 5 kg (20 kg -> 25 kg)', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await setAuthenticatedUser(client, adminId);

        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          DC_ID,
          JSON.stringify([{
            id: ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            sales_order_item_id: SO_ITEM_ID,
            quantity: 25
          }]),
          JSON.stringify({ notes: 'Increased by 5kg' })
        ]);
        assert.equal(res.rows[0].result.success, true);

        const check = await client.query('SELECT quantity FROM delivery_challan_items WHERE id = $1', [ITEM_ID]);
        assert.equal(Number(check.rows[0].quantity), 25);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('7. Decrease quantity by 10 kg (20 kg -> 10 kg)', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await setAuthenticatedUser(client, adminId);

        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          DC_ID,
          JSON.stringify([{
            id: ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            sales_order_item_id: SO_ITEM_ID,
            quantity: 10
          }]),
          JSON.stringify({ notes: 'Decreased by 10kg' })
        ]);
        assert.equal(res.rows[0].result.success, true);

        const check = await client.query('SELECT quantity FROM delivery_challan_items WHERE id = $1', [ITEM_ID]);
        assert.equal(Number(check.rows[0].quantity), 10);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('8. Split / Multi-batch items on same DC: 10 kg + 20 kg = 30 kg <= 30 kg succeeds', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await setAuthenticatedUser(client, adminId);

        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          DC_ID,
          JSON.stringify([
            {
              id: ITEM_ID,
              product_id: PRODUCT_ID,
              batch_id: BATCH_ID,
              sales_order_item_id: SO_ITEM_ID,
              quantity: 10
            },
            {
              product_id: PRODUCT_ID,
              batch_id: BATCH_ID,
              sales_order_item_id: SO_ITEM_ID,
              quantity: 20
            }
          ]),
          JSON.stringify({ approval_status: 'pending_approval' })
        ]);
        assert.equal(res.rows[0].result.success, true);

        const itemsRes = await client.query('SELECT count(*), sum(quantity) as total_qty FROM delivery_challan_items WHERE challan_id = $1', [DC_ID]);
        assert.equal(Number(itemsRes.rows[0].count), 2);
        assert.equal(Number(itemsRes.rows[0].total_qty), 30);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('9. Split items exceeding total SO remaining quantity (20 kg + 15 kg = 35 kg > 30 kg) is rejected', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await setAuthenticatedUser(client, adminId);

        let errorCaught = false;
        try {
          await client.query(`
            SELECT edit_delivery_challan(
              $1::uuid,
              $2::jsonb,
              $3::jsonb
            ) as result
          `, [
            DC_ID,
            JSON.stringify([
              {
                id: ITEM_ID,
                product_id: PRODUCT_ID,
                batch_id: BATCH_ID,
                sales_order_item_id: SO_ITEM_ID,
                quantity: 20
              },
              {
                product_id: PRODUCT_ID,
                batch_id: BATCH_ID,
                sales_order_item_id: SO_ITEM_ID,
                quantity: 15
              }
            ]),
            JSON.stringify({ approval_status: 'pending_approval' })
          ]);
        } catch (err) {
          errorCaught = true;
          assert.match(err.message, /Delivery quantity \(35(\.0+)?\) exceeds remaining Sales Order quantity \(30(\.0+)?\)/);
        }
        assert.ok(errorCaught, 'Must reject total split quantity when it exceeds remaining SO quantity');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('10. Reject single item quantity exceeding remaining Sales Order quantity (50 kg > 30 kg)', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await setAuthenticatedUser(client, adminId);

        let errorCaught = false;
        try {
          await client.query(`
            SELECT edit_delivery_challan(
              $1::uuid,
              $2::jsonb,
              $3::jsonb
            ) as result
          `, [
            DC_ID,
            JSON.stringify([{
              id: ITEM_ID,
              product_id: PRODUCT_ID,
              batch_id: BATCH_ID,
              sales_order_item_id: SO_ITEM_ID,
              quantity: 50
            }]),
            JSON.stringify({ approval_status: 'pending_approval' })
          ]);
        } catch (err) {
          errorCaught = true;
          assert.match(err.message, /Delivery quantity \(50(\.0+)?\) exceeds remaining Sales Order quantity \(30(\.0+)?\)/);
        }
        assert.ok(errorCaught, 'Must reject when quantity exceeds approved SO remaining quantity');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('11. Account for OTHER pending Delivery Challans when calculating remaining SO quantity', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await client.query('UPDATE delivery_challan_items SET quantity = 20 WHERE id = $1', [ITEM_ID]);
        await setAuthenticatedUser(client, adminId);

        // Create a temporary second pending DC for the same SO item with 10 kg
        const otherDcRes = await client.query(`
          INSERT INTO delivery_challans (
            customer_id, sales_order_id, challan_number, challan_date,
            delivery_address, approval_status, created_by
          ) VALUES (
            $1, $2, 'DO-TEST-OTHER', CURRENT_DATE,
            'Other Address', 'pending_approval', $3
          ) RETURNING id;
        `, [CUSTOMER_ID, SO_ID, adminId]);
        const otherDcId = otherDcRes.rows[0].id;

        await client.query(`
          INSERT INTO delivery_challan_items (
            challan_id, product_id, batch_id, sales_order_item_id, quantity
          ) VALUES (
            $1, $2, $3, $4, 10
          );
        `, [otherDcId, PRODUCT_ID, BATCH_ID, SO_ITEM_ID]);

        // SO has 30 kg total. Other pending DC takes 10 kg. Deliverable remaining for DO-26-0073 is 20 kg.
        // Editing DO-26-0073 to 20 kg should SUCCEED (10 + 20 = 30 <= 30)
        const resOk = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          ) as result
        `, [
          DC_ID,
          JSON.stringify([{
            id: ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            sales_order_item_id: SO_ITEM_ID,
            quantity: 20
          }]),
          JSON.stringify({ approval_status: 'pending_approval' })
        ]);
        assert.equal(resOk.rows[0].result.success, true);

        // Editing DO-26-0073 to 25 kg should FAIL (10 + 25 = 35 > 30)
        let errorCaught = false;
        try {
          await client.query(`
            SELECT edit_delivery_challan(
              $1::uuid,
              $2::jsonb,
              $3::jsonb
            ) as result
          `, [
            DC_ID,
            JSON.stringify([{
              id: ITEM_ID,
              product_id: PRODUCT_ID,
              batch_id: BATCH_ID,
              sales_order_item_id: SO_ITEM_ID,
              quantity: 25
            }]),
            JSON.stringify({ approval_status: 'pending_approval' })
          ]);
        } catch (err) {
          errorCaught = true;
          assert.match(err.message, /Delivery quantity \(25(\.0+)?\) exceeds remaining Sales Order quantity \(20(\.0+)?\)/);
        }
        assert.ok(errorCaught, 'Must constrain delivery quantity by other pending challans');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('12. Failed validation rolls back all header and item changes cleanly', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await setAuthenticatedUser(client, adminId);

        const initialHeader = await client.query('SELECT delivery_address, notes FROM delivery_challans WHERE id = $1', [DC_ID]);
        const initialItem = await client.query('SELECT quantity FROM delivery_challan_items WHERE id = $1', [ITEM_ID]);

        await client.query('SAVEPOINT sp_failed_edit');
        try {
          await client.query(`
            SELECT edit_delivery_challan(
              $1::uuid,
              $2::jsonb,
              $3::jsonb
            )
          `, [
            DC_ID,
            JSON.stringify([{
              id: ITEM_ID,
              product_id: PRODUCT_ID,
              batch_id: BATCH_ID,
              sales_order_item_id: SO_ITEM_ID,
              quantity: 999 // Intentionally excessive quantity
            }]),
            JSON.stringify({
              delivery_address: 'SHOULD NOT BE SAVED',
              notes: 'CORRUPT EDIT ATTEMPT'
            })
          ]);
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT sp_failed_edit');
        }

        const currentHeader = await client.query('SELECT delivery_address, notes FROM delivery_challans WHERE id = $1', [DC_ID]);
        const currentItem = await client.query('SELECT quantity FROM delivery_challan_items WHERE id = $1', [ITEM_ID]);

        assert.equal(currentHeader.rows[0].delivery_address, initialHeader.rows[0].delivery_address);
        assert.equal(currentHeader.rows[0].notes, initialHeader.rows[0].notes);
        assert.equal(Number(currentItem.rows[0].quantity), Number(initialItem.rows[0].quantity));
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('13. Two-argument signature works seamlessly without ambiguity', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await setAuthenticatedUser(client, adminId);

        const res = await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb
          ) as result
        `, [
          DC_ID,
          JSON.stringify([{
            id: ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            sales_order_item_id: SO_ITEM_ID,
            quantity: 20
          }])
        ]);

        assert.equal(res.rows[0].result.success, true);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('14. Inventory and GL isolation: Save operation does NOT create inventory movements or journal entries', async () => {
    await withDbClient(async (client) => {
      await client.query('BEGIN');
      try {
        await setupPendingScenario(client);
        await setAuthenticatedUser(client, adminId);

        const txCountBefore = await client.query(`SELECT count(*) FROM inventory_transactions WHERE reference_id = $1`, [DC_ID]);
        const jeCountBefore = await client.query(`SELECT count(*) FROM journal_entries WHERE description LIKE '%DO-26-0073%'`);

        await client.query(`
          SELECT edit_delivery_challan(
            $1::uuid,
            $2::jsonb,
            $3::jsonb
          )
        `, [
          DC_ID,
          JSON.stringify([{
            id: ITEM_ID,
            product_id: PRODUCT_ID,
            batch_id: BATCH_ID,
            sales_order_item_id: SO_ITEM_ID,
            quantity: 30
          }]),
          JSON.stringify({
            approval_status: 'pending_approval'
          })
        ]);

        const txCountAfter = await client.query(`SELECT count(*) FROM inventory_transactions WHERE reference_id = $1`, [DC_ID]);
        const jeCountAfter = await client.query(`SELECT count(*) FROM journal_entries WHERE description LIKE '%DO-26-0073%'`);

        assert.equal(Number(txCountAfter.rows[0].count), Number(txCountBefore.rows[0].count), 'Inventory movements must remain unchanged on save');
        assert.equal(Number(jeCountAfter.rows[0].count), Number(jeCountBefore.rows[0].count), 'Journal entries must remain unchanged on save');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });
});
