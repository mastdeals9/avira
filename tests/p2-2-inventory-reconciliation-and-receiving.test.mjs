import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  throw new Error('SUPABASE_DB_URL environment variable is required');
}

function getDbClient() {
  return new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
}

test('Priority 2.2 — Inventory Valuation Bridge (HM000004/2627 Separated) & Receiving Container Inference', async (t) => {
  const db = getDbClient();
  await db.connect();

  t.after(async () => {
    await db.end();
  });

  const migrationSql = readFileSync(
    new URL('../supabase/migrations/20261127221000_p2_2_inventory_reconciliation_and_receiving.sql', import.meta.url),
    'utf8'
  );

  await t.test('1. Inventory valuation reconciliation isolates HM000004/2627 Rp69,443,000 new arrival and leaves Rp0.00 unexplained historical variance', async () => {
    await db.query('BEGIN');
    await db.query(migrationSql);

    const { rows } = await db.query('SELECT * FROM public.inventory_gl_valuation_reconciliation');
    await db.query('ROLLBACK');

    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(Number(r.new_arrival_pending_erp_update), 69443000);
    assert.equal(Number(r.total_supported_valuation), Number(r.inventory_gl));
    assert.equal(Number(r.remaining_historical_variance), 0);
  });

  await t.test('2. Receiving infers unique container, rejects ambiguous multi-container, flags unresolved container, and preserves 4-decimal precision', async () => {
    await db.query('BEGIN');
    await db.query(migrationSql);

    const { rows: adminUsers } = await db.query(
      `SELECT id FROM public.user_profiles WHERE role = 'admin' AND COALESCE(is_active, true) = true LIMIT 1`
    );
    const adminId = adminUsers[0].id;
    const { rows: prodMakeRows } = await db.query(
      `SELECT product_id, make_id FROM public.batches WHERE product_id IS NOT NULL AND make_id IS NOT NULL LIMIT 1`
    );
    const productId = prodMakeRows[0].product_id;
    const makeId = prodMakeRows[0].make_id;
    const { rows: supRows } = await db.query(`SELECT id FROM public.suppliers LIMIT 1`);
    const supplierId = supRows[0].id;

    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [adminId]);
    await db.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");

    // A. Uniquely linked container inferred
    const pi1Id = randomUUID();
    const pii1Id = randomUUID();
    const cont1Id = randomUUID();
    await db.query(
      `INSERT INTO public.purchase_invoices (id, invoice_number, supplier_id, invoice_date, currency, exchange_rate, subtotal, total_amount, status, created_by)
       VALUES ($1, 'PI-TST-UNIQ', $2, '2099-01-15', 'USD', 18000, 1000, 1000, 'unpaid', $3)`,
      [pi1Id, supplierId, adminId]
    );
    await db.query(
      `INSERT INTO public.purchase_invoice_items (id, purchase_invoice_id, product_id, item_type, quantity, unit_price, line_total)
       VALUES ($1, $2, $3, 'inventory', 100, 10, 1000)`,
      [pii1Id, pi1Id, productId]
    );
    await db.query(
      `INSERT INTO public.import_containers (id, container_ref, status, purchase_invoice_ids, import_date)
       VALUES ($1, 'CONT-TST-UNIQ', 'draft', ARRAY[$2::uuid], '2026-11-27')`,
      [cont1Id, pi1Id]
    );

    const { rows: rec1 } = await db.query(
      `SELECT public.receive_purchase_invoice_item($1::uuid, $2::jsonb, 100, $3::uuid) AS res`,
      [pii1Id, JSON.stringify({ product_id: productId, make_id: makeId, import_date: '2026-11-27', batch_number: 'TST-BATCH-UNIQ-1' }), randomUUID()]
    );
    assert.equal(rec1[0].res.import_container_id, cont1Id);
    assert.equal(rec1[0].res.container_resolution_status, 'inferred');
    assert.equal(rec1[0].res.receiving_complete, true);

    // B. Multiple matching containers -> raises explicit selection error
    const pi2Id = randomUUID();
    const pii2Id = randomUUID();
    await db.query(
      `INSERT INTO public.purchase_invoices (id, invoice_number, supplier_id, invoice_date, currency, exchange_rate, subtotal, total_amount, status, created_by)
       VALUES ($1, 'PI-TST-MULTI', $2, '2099-02-15', 'USD', 18000, 1000, 1000, 'unpaid', $3)`,
      [pi2Id, supplierId, adminId]
    );
    await db.query(
      `INSERT INTO public.purchase_invoice_items (id, purchase_invoice_id, product_id, item_type, quantity, unit_price, line_total)
       VALUES ($1, $2, $3, 'inventory', 100, 10, 1000)`,
      [pii2Id, pi2Id, productId]
    );
    await db.query(
      `INSERT INTO public.import_containers (id, container_ref, status, purchase_invoice_ids, import_date)
       VALUES ($1, 'CONT-TST-M1', 'draft', ARRAY[$3::uuid], '2026-11-27'),
              ($2, 'CONT-TST-M2', 'draft', ARRAY[$3::uuid], '2026-11-27')`,
      [randomUUID(), randomUUID(), pi2Id]
    );
    await db.query('SAVEPOINT sp_multi_cont');
    await assert.rejects(
      () => db.query(
        `SELECT public.receive_purchase_invoice_item($1::uuid, $2::jsonb, 100, $3::uuid)`,
        [pii2Id, JSON.stringify({ product_id: productId, make_id: makeId, import_date: '2026-11-27', batch_number: 'TST-BATCH-M' }), randomUUID()]
      ),
      /Multiple import containers match/i
    );
    await db.query('ROLLBACK TO SAVEPOINT sp_multi_cont');

    // C. No matching container -> leaves unresolved & flags container_resolution_status='unresolved'
    const pi3Id = randomUUID();
    const pii3Id = randomUUID();
    await db.query(
      `INSERT INTO public.purchase_invoices (id, invoice_number, supplier_id, invoice_date, currency, exchange_rate, subtotal, total_amount, status, created_by)
       VALUES ($1, 'PI-TST-NONE', $2, '2099-03-15', 'USD', 18000, 1000, 1000, 'unpaid', $3)`,
      [pi3Id, supplierId, adminId]
    );
    await db.query(
      `INSERT INTO public.purchase_invoice_items (id, purchase_invoice_id, product_id, item_type, quantity, unit_price, line_total)
       VALUES ($1, $2, $3, 'inventory', 100, 10, 1000)`,
      [pii3Id, pi3Id, productId]
    );
    const { rows: rec3 } = await db.query(
      `SELECT public.receive_purchase_invoice_item($1::uuid, $2::jsonb, 100, $3::uuid) AS res`,
      [pii3Id, JSON.stringify({ product_id: productId, make_id: makeId, import_date: '2026-11-27', batch_number: 'TST-BATCH-NONE-1' }), randomUUID()]
    );
    assert.equal(rec3[0].res.import_container_id, null);
    assert.equal(rec3[0].res.container_resolution_status, 'unresolved');

    // D. Existing-batch receiving (current_stock > 0) uses weighted average and preserves 4 decimals
    const existingBatchId = rec1[0].res.batch_id;
    const pi4Id = randomUUID();
    const pii4Id = randomUUID();
    await db.query(
      `INSERT INTO public.purchase_invoices (id, invoice_number, supplier_id, invoice_date, currency, exchange_rate, subtotal, total_amount, status, created_by)
       VALUES ($1, 'PI-TST-EXIST', $2, '2099-04-15', 'USD', 18000, 2000, 2000, 'unpaid', $3)`,
      [pi4Id, supplierId, adminId]
    );
    await db.query(
      `INSERT INTO public.purchase_invoice_items (id, purchase_invoice_id, product_id, item_type, quantity, unit_price, line_total)
       VALUES ($1, $2, $3, 'inventory', 100, 20, 2000)`,
      [pii4Id, pi4Id, productId]
    );
    // Partial receive 50 units into existing batch (100 @ 180,000 + 50 @ 360,000 => weighted avg 240,000)
    const { rows: rec4Part } = await db.query(
      `SELECT public.receive_purchase_invoice_item($1::uuid, $2::jsonb, 50, $3::uuid) AS res`,
      [pii4Id, JSON.stringify({ batch_id: existingBatchId, product_id: productId, make_id: makeId }), randomUUID()]
    );
    assert.equal(rec4Part[0].res.receiving_complete, false);
    const { rows: batchWeighted } = await db.query(
      `SELECT current_stock, cost_per_unit FROM public.batches WHERE id = $1`,
      [existingBatchId]
    );
    assert.equal(Number(batchWeighted[0].current_stock), 150);
    assert.equal(Number(batchWeighted[0].cost_per_unit), 240000);

    // Complete remaining 50 units -> receiving_complete becomes true
    const { rows: rec4Done } = await db.query(
      `SELECT public.receive_purchase_invoice_item($1::uuid, $2::jsonb, 50, $3::uuid) AS res`,
      [pii4Id, JSON.stringify({ batch_id: existingBatchId, product_id: productId, make_id: makeId }), randomUUID()]
    );
    assert.equal(rec4Done[0].res.receiving_complete, true);

    // E. Default duty allocation when no batch has explicit duty flags + idempotency on repeated reallocation
    const pi5Id = randomUUID();
    const pii5aId = randomUUID();
    const pii5bId = randomUUID();
    const cont5Id = randomUUID();
    const exp5Id = randomUUID();
    await db.query(
      `INSERT INTO public.purchase_invoices (id, invoice_number, supplier_id, invoice_date, currency, exchange_rate, subtotal, total_amount, status, created_by)
       VALUES ($1, 'PI-TST-DUTY', $2, '2099-05-15', 'USD', 18000, 3000, 3000, 'unpaid', $3)`,
      [pi5Id, supplierId, adminId]
    );
    await db.query(
      `INSERT INTO public.purchase_invoice_items (id, purchase_invoice_id, product_id, item_type, quantity, unit_price, line_total)
       VALUES ($1, $3, $4, 'inventory', 100, 10, 1000),
              ($2, $3, $4, 'inventory', 100, 20, 2000)`,
      [pii5aId, pii5bId, pi5Id, productId]
    );
    await db.query(
      `INSERT INTO public.import_containers (id, container_ref, status, purchase_invoice_ids, import_date)
       VALUES ($1, 'CONT-TST-DUTY', 'draft', ARRAY[$2::uuid], '2026-11-27')`,
      [cont5Id, pi5Id]
    );
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, pib_bm_amount, pib_ppn_amount, pib_pph_amount, include_in_landed_cost, import_container_id, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'pib_import', 3000000, 3000000, 0, 0, true, $2, '2026-11-27', 'Test PIB Duty', 'approved', 'EXP/TST/DUTY', $3)`,
      [exp5Id, cont5Id, adminId]
    );
    const { rows: d1 } = await db.query(
      `SELECT public.receive_purchase_invoice_item($1::uuid, $2::jsonb, 100, $3::uuid) AS res`,
      [pii5aId, JSON.stringify({ product_id: productId, make_id: makeId, import_date: '2026-11-27', batch_number: 'TST-DUTY-A' }), randomUUID()]
    );
    const { rows: d2 } = await db.query(
      `SELECT public.receive_purchase_invoice_item($1::uuid, $2::jsonb, 100, $3::uuid) AS res`,
      [pii5bId, JSON.stringify({ product_id: productId, make_id: makeId, import_date: '2026-11-27', batch_number: 'TST-DUTY-B' }), randomUUID()]
    );
    assert.equal(d2[0].res.receiving_complete, true);
    const { rows: dutyLayers1 } = await db.query(
      `SELECT batch_id, landed_cost_amount, final_functional_unit_cost FROM public.purchase_batch_cost_layers WHERE import_container_id = $1 ORDER BY created_at, id`,
      [cont5Id]
    );
    const totalDuty1 = dutyLayers1.reduce((s, r) => s + Number(r.landed_cost_amount), 0);
    assert.equal(totalDuty1, 3000000, 'Default duty allocation must allocate full PIB BM pool when no explicit duty flags exist');

    // Re-run reallocate_container_costs -> must be idempotent (no double capitalization)
    await db.query(`SELECT public.reallocate_container_costs($1::uuid)`, [cont5Id]);
    const { rows: dutyLayers2 } = await db.query(
      `SELECT batch_id, landed_cost_amount, final_functional_unit_cost FROM public.purchase_batch_cost_layers WHERE import_container_id = $1 ORDER BY created_at, id`,
      [cont5Id]
    );
    assert.deepEqual(dutyLayers2, dutyLayers1, 'Repeated reallocate_container_costs must not double-capitalize');

    // F. Historical batch protection (< 2026-11-27) using isolated synthetic historical batch
    const histContId = randomUUID();
    await db.query(
      `INSERT INTO public.import_containers (id, container_ref, status, import_date)
       VALUES ($1, 'CONT-TST-HIST', 'draft', '2026-10-01')`,
      [histContId]
    );
    const { rows: histSave } = await db.query(
      `SELECT (public.save_batch_inventory_v1(NULL, $1::jsonb, $2::uuid)->>'batch_id')::uuid AS batch_id`,
      [
        JSON.stringify({
          batch_number: 'TST-HIST-PROT',
          product_id: productId,
          make_id: makeId,
          import_container_id: histContId,
          import_date: '2026-10-01',
          import_quantity: 100,
          import_price: 50000,
        }),
        randomUUID(),
      ]
    );
    const histBatchId = histSave[0].batch_id;
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, pib_bm_amount, pib_ppn_amount, pib_pph_amount, include_in_landed_cost, import_container_id, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'pib_import', 500000, 500000, 0, 0, true, $2, '2026-10-01', 'Historical PIB', 'approved', 'EXP/TST/HIST', $3)`,
      [randomUUID(), histContId, adminId]
    );
    await db.query(`SELECT public.reallocate_container_costs($1::uuid)`, [histContId]);
    const { rows: hbAfter } = await db.query(
      `SELECT cost_per_unit, landed_cost_per_unit FROM public.batches WHERE id = $1`,
      [histBatchId]
    );
    assert.equal(Number(hbAfter[0].cost_per_unit), 50000, 'Historical batch cost_per_unit must remain untouched');
    assert.equal(Number(hbAfter[0].landed_cost_per_unit), 0, 'Historical batch landed_cost_per_unit must remain untouched');

    // G. 4-decimal precision on both cost_per_unit and landed_cost_per_unit prevents valuation residuals
    const pi6Id = randomUUID();
    const pii6Id = randomUUID();
    const cont6Id = randomUUID();
    const exp6Id = randomUUID();
    await db.query(
      `INSERT INTO public.purchase_invoices (id, invoice_number, supplier_id, invoice_date, currency, exchange_rate, subtotal, total_amount, status, created_by)
       VALUES ($1, 'PI-TST-PREC', $2, '2099-06-15', 'IDR', 1, 10000000, 10000000, 'unpaid', $3)`,
      [pi6Id, supplierId, adminId]
    );
    // 3,000 units * 3,333.3333... + 1,000,000 PIB duty = 11,000,000 total -> 3,666.6667 per unit
    // With 2 decimals (3,666.67), 3,000 * 3,666.67 = 11,000,010 (Rp 10 residual).
    // With 4 decimals (3,666.6667), 3,000 * 3,666.6667 = 11,000,000.10 (Rp 0.10 residual, < Rp 1).
    await db.query(
      `INSERT INTO public.purchase_invoice_items (id, purchase_invoice_id, product_id, item_type, quantity, unit_price, line_total)
       VALUES ($1, $2, $3, 'inventory', 3000, 3333.3333, 10000000)`,
      [pii6Id, pi6Id, productId]
    );
    await db.query(
      `INSERT INTO public.import_containers (id, container_ref, status, purchase_invoice_ids, import_date)
       VALUES ($1, 'CONT-TST-PREC', 'draft', ARRAY[$2::uuid], '2026-11-27')`,
      [cont6Id, pi6Id]
    );
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, pib_bm_amount, pib_ppn_amount, pib_pph_amount, include_in_landed_cost, import_container_id, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'pib_import', 1000000, 1000000, 0, 0, true, $2, '2026-11-27', 'Precision Test PIB', 'approved', 'EXP/TST/PREC', $3)`,
      [exp6Id, cont6Id, adminId]
    );
    const { rows: recPrec } = await db.query(
      `SELECT public.receive_purchase_invoice_item($1::uuid, $2::jsonb, 3000, $3::uuid) AS res`,
      [pii6Id, JSON.stringify({ product_id: productId, make_id: makeId, import_date: '2026-11-27', batch_number: 'TST-PREC-4DP' }), randomUUID()]
    );
    const precBatchId = recPrec[0].res.batch_id;
    const { rows: precRow } = await db.query(
      `SELECT current_stock, cost_per_unit, landed_cost_per_unit,
              (current_stock * COALESCE(landed_cost_per_unit, cost_per_unit, import_price, 0)) AS view_valuation
       FROM public.batches WHERE id = $1`,
      [precBatchId]
    );
    assert.equal(Number(precRow[0].cost_per_unit), 3666.66333333);
    assert.equal(Number(precRow[0].landed_cost_per_unit), 3666.66333333);
    const residual = Math.abs(Number(precRow[0].view_valuation) - 10999990.00);
    assert.ok(residual < 0.005, `Expected extended valuation residual < Rp 0.005, got ${residual}`);

    // H. Multi-batch non-round duty, partial remaining stock, repeated weighted-avg, repeated reallocation
    const pi7Id = randomUUID();
    const pii7aId = randomUUID();
    const pii7bId = randomUUID();
    const cont7Id = randomUUID();
    const exp7Id = randomUUID();
    await db.query(
      `INSERT INTO public.purchase_invoices (id, invoice_number, supplier_id, invoice_date, currency, exchange_rate, subtotal, total_amount, status, created_by)
       VALUES ($1, 'PI-TST-PREC2', $2, '2099-07-15', 'IDR', 1, 7000000, 7000000, 'unpaid', $3)`,
      [pi7Id, supplierId, adminId]
    );
    await db.query(
      `INSERT INTO public.purchase_invoice_items (id, purchase_invoice_id, product_id, item_type, quantity, unit_price, line_total)
       VALUES ($1, $3, $4, 'inventory', 700, 5000, 3500000),
              ($2, $3, $4, 'inventory', 300, 11666.67, 3500001)`,
      [pii7aId, pii7bId, pi7Id, productId]
    );
    await db.query(
      `INSERT INTO public.import_containers (id, container_ref, status, purchase_invoice_ids, import_date)
       VALUES ($1, 'CONT-TST-PREC2', 'draft', ARRAY[$2::uuid], '2026-11-27')`,
      [cont7Id, pi7Id]
    );
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, pib_bm_amount, pib_ppn_amount, pib_pph_amount, include_in_landed_cost, import_container_id, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'pib_import', 1000000, 1000000, 0, 0, true, $2, '2026-11-27', 'Multi-batch Precision PIB', 'approved', 'EXP/TST/PREC2', $3)`,
      [exp7Id, cont7Id, adminId]
    );
    const { rows: r7a } = await db.query(
      `SELECT public.receive_purchase_invoice_item($1::uuid, $2::jsonb, 700, $3::uuid) AS res`,
      [pii7aId, JSON.stringify({ product_id: productId, make_id: makeId, import_date: '2026-11-27', batch_number: 'TST-MB-700' }), randomUUID()]
    );
    const { rows: r7b } = await db.query(
      `SELECT public.receive_purchase_invoice_item($1::uuid, $2::jsonb, 300, $3::uuid) AS res`,
      [pii7bId, JSON.stringify({ product_id: productId, make_id: makeId, import_date: '2026-11-27', batch_number: 'TST-MB-300' }), randomUUID()]
    );
    await db.query(`SELECT public.reallocate_container_costs($1::uuid)`, [cont7Id]);
    await db.query(`SELECT public.reallocate_container_costs($1::uuid)`, [cont7Id]);

    const { rows: mbRows } = await db.query(
      `SELECT SUM(current_stock * COALESCE(landed_cost_per_unit, cost_per_unit, import_price, 0)) AS total_ext,
              SUM(COALESCE(actual_duty_charges, 0)) AS total_duty
       FROM public.batches WHERE id IN ($1, $2)`,
      [r7a[0].res.batch_id, r7b[0].res.batch_id]
    );
    assert.equal(Number(mbRows[0].total_duty), 1000000, 'Zero loss of source duty allocation');
    const expectedTotal = 700 * 5000 + 300 * 11666.67 + 1000000;
    assert.ok(Math.abs(Number(mbRows[0].total_ext) - expectedTotal) < 0.005, 'Multi-batch extended valuation residual must be < Rp 0.005');

    // Partial remaining stock on TST-MB-700 (consume 200, leaving 500)
    await db.query(
      `SELECT public.post_inventory_movement($1::uuid, $2::uuid, $3::uuid, 'adjustment', -200, '2026-11-27', 'TST-PARTIAL', 'manual', $3::uuid, 'Partial stock test', $4::uuid, 700, 500)`,
      [randomUUID(), productId, r7a[0].res.batch_id, adminId]
    );
    const { rows: partRow } = await db.query(
      `SELECT current_stock, landed_cost_per_unit, actual_duty_charges, import_quantity,
              (current_stock * landed_cost_per_unit) AS partial_ext
       FROM public.batches WHERE id = $1`,
      [r7a[0].res.batch_id]
    );
    const expectedPartialExt = (500 / 700) * (700 * 5000 + Number(partRow[0].actual_duty_charges));
    assert.ok(Math.abs(Number(partRow[0].partial_ext) - expectedPartialExt) < 0.005, 'Partial remaining stock extended valuation residual must be < Rp 0.005');

    await db.query('ROLLBACK');
  });

  await t.test('3. Outstanding pending PIB duty handles non-draft containers, partial allocations, and reversed journals without double counting', async () => {
    await db.query('BEGIN');
    await db.query(migrationSql);

    const { rows: adminUsers } = await db.query(
      `SELECT id FROM public.user_profiles WHERE role = 'admin' AND COALESCE(is_active, true) = true LIMIT 1`
    );
    const adminId = adminUsers[0].id;
    const { rows: prodMakeRows } = await db.query(
      `SELECT product_id, make_id FROM public.batches WHERE product_id IS NOT NULL AND make_id IS NOT NULL LIMIT 1`
    );
    const productId = prodMakeRows[0].product_id;
    const makeId = prodMakeRows[0].make_id;
    const { rows: coa1130 } = await db.query(`SELECT id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1`);
    const { rows: coa2110 } = await db.query(`SELECT id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1`);

    const { rows: baseView } = await db.query(`SELECT new_arrival_pending_erp_update FROM public.inventory_gl_valuation_reconciliation`);
    const basePending = Number(baseView[0].new_arrival_pending_erp_update);
    assert.equal(basePending, 69443000, 'HM000004/2627 baseline must remain Rp 69,443,000');

    // Non-draft container with 10,000,000 PIB duty posted to 1130, 4,000,000 capitalized -> 6,000,000 must remain pending
    const contPendId = randomUUID();
    const expPendId = randomUUID();
    const jePendId = randomUUID();
    await db.query(
      `INSERT INTO public.import_containers (id, container_ref, status, import_date)
       VALUES ($1, 'CONT-TST-PEND', 'allocated', '2026-11-27')`,
      [contPendId]
    );
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, pib_bm_amount, pib_ppn_amount, pib_pph_amount, include_in_landed_cost, import_container_id, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'pib_import', 10000000, 10000000, 0, 0, true, $2, '2026-11-27', 'Pending Partial PIB', 'approved', 'EXP/TST/PEND', $3)`,
      [expPendId, contPendId, adminId]
    );
    // Replace auto-posted JE or insert explicit 10,000,000 1130 debit + 1 reversed 10,000,000 JE
    await db.query(
      `INSERT INTO public.journal_entries (id, entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted, is_reversed, is_cancelled, posted_by, created_by)
       VALUES ($1, 'JE-TST-PEND-REV', '2026-11-27', 'expenses', $2, 'EXP/TST/PEND', 'Reversed duplicate PIB', 10000000, 10000000, true, true, false, $3, $3)`,
      [jePendId, expPendId, adminId]
    );
    await db.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
       VALUES ($1, 1, $2, 10000000, 0), ($1, 2, $3, 0, 10000000)`,
      [jePendId, coa1130[0].id, coa2110[0].id]
    );
    // Capitalize 4,000,000 onto a batch in this non-draft container
    const { rows: bSave } = await db.query(
      `SELECT (public.save_batch_inventory_v1(NULL, $1::jsonb, $2::uuid)->>'batch_id')::uuid AS batch_id`,
      [
        JSON.stringify({
          batch_number: 'TST-PEND-PART',
          product_id: productId,
          make_id: makeId,
          import_container_id: contPendId,
          import_date: '2026-11-27',
          import_quantity: 100,
          import_price: 50000,
          actual_duty_charges: 4000000,
        }),
        randomUUID(),
      ]
    );
    await db.query(`UPDATE public.batches SET actual_duty_charges = 4000000 WHERE id = $1`, [bSave[0].batch_id]);

    const { rows: afterPartial } = await db.query(`SELECT new_arrival_pending_erp_update FROM public.inventory_gl_valuation_reconciliation`);
    assert.equal(Number(afterPartial[0].new_arrival_pending_erp_update), basePending + 6000000, 'Non-draft container with partial allocation must show exact Rp 6,000,000 outstanding');

    // A/B/C/D/E: Layer-only partial duty, batch+layer no double deduction, and post-cutover include_in_landed_cost=false still represented
    // Case B: Layer-only partial allocation (batch actual_duty_charges = 0, cost layer has 2,500,000 duty)
    const { rows: layerPi } = await db.query(
      `INSERT INTO public.purchase_invoices (id, invoice_number, supplier_id, invoice_date, currency, exchange_rate, subtotal, total_amount, status, created_by)
       VALUES ($1, 'PI-TST-LAY', (SELECT id FROM public.suppliers LIMIT 1), '2099-08-15', 'IDR', 1, 5000000, 5000000, 'unpaid', $2) RETURNING id`,
      [randomUUID(), adminId]
    );
    const layerPiiId = randomUUID();
    await db.query(
      `INSERT INTO public.purchase_invoice_items (id, purchase_invoice_id, product_id, item_type, quantity, unit_price, line_total)
       VALUES ($1, $2, $3, 'inventory', 100, 50000, 5000000)`,
      [layerPiiId, layerPi[0].id, productId]
    );
    const { rows: allocLayer } = await db.query(
      `INSERT INTO public.purchase_invoice_receiving_allocations (purchase_invoice_id, purchase_invoice_item_id, batch_id, received_quantity, operation_id, received_by, currency, exchange_rate, functional_unit_cost, functional_total_cost, import_container_id)
       VALUES ($1, $2, $3, 100, $4, $5, 'IDR', 1, 50000, 5000000, $6) RETURNING id`,
      [layerPi[0].id, layerPiiId, bSave[0].batch_id, randomUUID(), adminId, contPendId]
    );
    // Batch has 4,000,000 AND layer also has 4,000,000 -> Case C: must NOT double-deduct (still 6,000,000 pending, not 2,000,000)
    await db.query(
      `INSERT INTO public.purchase_batch_cost_layers (receiving_allocation_id, purchase_invoice_id, purchase_invoice_item_id, batch_id, import_container_id, quantity, currency, exchange_rate, transaction_unit_cost, functional_unit_cost, functional_total_cost, landed_cost_amount, final_functional_unit_cost)
       VALUES ($1, $2, $3, $4, $5, 100, 'IDR', 1, 50000, 50000, 5000000, 4000000, 90000)`,
      [allocLayer[0].id, layerPi[0].id, layerPiiId, bSave[0].batch_id, contPendId]
    );
    const { rows: afterCaseC } = await db.query(`SELECT new_arrival_pending_erp_update FROM public.inventory_gl_valuation_reconciliation`);
    assert.equal(Number(afterCaseC[0].new_arrival_pending_erp_update), basePending + 6000000, 'Case C: Batch + layer with same duty must NOT double-deduct');

    // Case B: Clear batch actual_duty_charges = 0 so only layer holds 4,000,000 -> still 6,000,000 pending
    await db.query(`UPDATE public.batches SET actual_duty_charges = 0, duty_charges = 0 WHERE id = $1`, [bSave[0].batch_id]);
    const { rows: afterCaseB } = await db.query(`SELECT new_arrival_pending_erp_update FROM public.inventory_gl_valuation_reconciliation`);
    assert.equal(Number(afterCaseB[0].new_arrival_pending_erp_update), basePending + 6000000, 'Case B: Layer-only duty must still reduce pending duty');

    // Point 2: Post-cutover (> 2026-11-27) PIB with include_in_landed_cost = false and active posted 1130 debit must NOT disappear
    const contPostId = randomUUID();
    const expPostId = randomUUID();
    await db.query(
      `INSERT INTO public.import_containers (id, container_ref, status, import_date)
       VALUES ($1, 'CONT-TST-POST', 'draft', '2026-12-05')`,
      [contPostId]
    );
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, pib_bm_amount, pib_ppn_amount, pib_pph_amount, include_in_landed_cost, import_container_id, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'pib_import', 2500000, 2500000, 0, 0, false, $2, '2026-12-05', 'Post-cutover PIB Flag False', 'approved', 'EXP/TST/POST', $3)`,
      [expPostId, contPostId, adminId]
    );
    const { rows: afterPost } = await db.query(`SELECT new_arrival_pending_erp_update, remaining_historical_variance FROM public.inventory_gl_valuation_reconciliation`);
    assert.equal(Number(afterPost[0].new_arrival_pending_erp_update), basePending + 6000000 + 2500000, 'Post-cutover 1130 debit with include_in_landed_cost=false must remain visible in reconciliation');

    await db.query('ROLLBACK');
  });
});
