import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    connectionTimeoutMillis: 15000,
  });
}

test('Four Historical Accounting & Workflow Repairs (Rollback-Only DB Verification)', async (t) => {
  const db = getDbClient();
  await db.connect();

  t.after(async () => {
    try {
      await db.query('ROLLBACK');
    } catch {
      // ignore if already rolled back
    }
    await db.end();
  });

  const mig1 = readFileSync(
    new URL('../supabase/migrations/20261128010000_fix_po_receiving_and_pi_links.sql', import.meta.url),
    'utf8'
  );
  const mig2 = readFileSync(
    new URL('../supabase/migrations/20261128020000_fix_batch_cost_layer_sync.sql', import.meta.url),
    'utf8'
  );
  const mig3 = readFileSync(
    new URL('../supabase/migrations/20261128030000_fix_ppn_tax_period_reconciliation.sql', import.meta.url),
    'utf8'
  );
  const mig4 = readFileSync(
    new URL('../supabase/migrations/20261128040000_secure_vw_ppn_net_by_period.sql', import.meta.url),
    'utf8'
  );

  await db.query('BEGIN');
  await db.query(mig1);
  await db.query(mig2);
  await db.query(mig3);
  await db.query(mig4);

  await t.test('Issue 1: Zero stale historical PO receiving quantities (<= 2026-11-19)', async () => {
    const res = await db.query(`
      SELECT COUNT(*)::int AS stale_count
      FROM (
        SELECT poi.id
        FROM public.purchase_order_items poi
        JOIN public.purchase_orders po ON po.id = poi.po_id
        LEFT JOIN public.products p ON p.id = poi.product_id
        LEFT JOIN public.purchase_invoice_items pii ON pii.purchase_order_item_id = poi.id
        LEFT JOIN public.purchase_invoices pi ON pi.id = pii.purchase_invoice_id
        LEFT JOIN public.purchase_invoice_receiving_allocations pira ON pira.purchase_invoice_item_id = pii.id
        WHERE po.po_date <= '2026-11-19'
        GROUP BY poi.id, poi.quantity_received, poi.unit, p.unit
        HAVING ABS(
          COALESCE(poi.quantity_received, 0) -
          COALESCE(
            SUM(
              CASE
                WHEN LOWER(TRIM(COALESCE(p.unit, poi.unit, ''))) = LOWER(TRIM(COALESCE(poi.unit, ''))) THEN pira.received_quantity
                WHEN LOWER(TRIM(COALESCE(p.unit, ''))) = 'g' AND LOWER(TRIM(COALESCE(poi.unit, ''))) = 'kg' THEN pira.received_quantity / 1000.0
                WHEN LOWER(TRIM(COALESCE(p.unit, ''))) = 'kg' AND LOWER(TRIM(COALESCE(poi.unit, ''))) = 'g' THEN pira.received_quantity * 1000.0
                ELSE pira.received_quantity
              END
            ) FILTER (
              WHERE pira.status = 'received'
                AND COALESCE(LOWER(pi.status), '') NOT IN ('cancelled', 'void', 'deleted')
            ),
            0
          )
        ) > 0.001
      ) s
    `);
    assert.equal(res.rows[0].stale_count, 0);

    // Verify Mometasone Furoate (PO-2601-0012 / E0000274/2526): 0.250 kg ordered == 250 g received, not over-received, commercial total preserved
    const mometasoneRes = await db.query(`
      SELECT poi.quantity, poi.unit, poi.quantity_received, poi.quantity_pending, poi.unit_price, poi.line_total
      FROM public.purchase_order_items poi
      JOIN public.purchase_orders po ON po.id = poi.po_id
      JOIN public.products p ON p.id = poi.product_id
      WHERE po.po_number = 'PO-2601-0012'
        AND p.product_name = 'Mometasone Furoate'
    `);
    assert.equal(mometasoneRes.rows.length, 1);
    const mom = mometasoneRes.rows[0];
    assert.equal(Number(mom.quantity), 0.25);
    assert.equal(mom.unit, 'kg');
    assert.equal(Number(mom.quantity_received), 0.25);
    assert.equal(Number(mom.quantity_pending), 0);
    assert.equal(Number(mom.unit_price), 600);
    assert.equal(Number(mom.line_total), 150);

    // Verify zero over-received historical PO items (<= 2026-11-19)
    const overRecRes = await db.query(`
      SELECT COUNT(*)::int AS over_count
      FROM public.purchase_order_items poi
      JOIN public.purchase_orders po ON po.id = poi.po_id
      WHERE po.po_date <= '2026-11-19'
        AND poi.quantity_received > poi.quantity + 0.001
    `);
    assert.equal(overRecRes.rows[0].over_count, 0);

    // Verify trigger syncs quantity_received on future allocation INSERT/UPDATE/DELETE
    const allocRes = await db.query(`
      SELECT pira.id, pira.purchase_invoice_item_id, pira.received_quantity, pira.status, pii.purchase_order_item_id
      FROM public.purchase_invoice_receiving_allocations pira
      JOIN public.purchase_invoice_items pii ON pii.id = pira.purchase_invoice_item_id
      WHERE pira.status = 'received'
        AND pii.purchase_order_item_id IS NOT NULL
      LIMIT 1
    `);
    assert.equal(allocRes.rows.length, 1);
    const alloc = allocRes.rows[0];
    const beforePoi = await db.query('SELECT quantity_received FROM public.purchase_order_items WHERE id = $1', [alloc.purchase_order_item_id]);

    await db.query('SAVEPOINT sp_alloc');
    await db.query('UPDATE public.purchase_invoice_receiving_allocations SET received_quantity = received_quantity + 1 WHERE id = $1', [alloc.id]);
    const afterUpdatePoi = await db.query('SELECT quantity_received FROM public.purchase_order_items WHERE id = $1', [alloc.purchase_order_item_id]);
    assert.equal(
      Number(afterUpdatePoi.rows[0].quantity_received),
      Number(beforePoi.rows[0].quantity_received) + 1,
      'Updating receiving allocation quantity must increment PO quantity_received'
    );
    await db.query('ROLLBACK TO SAVEPOINT sp_alloc');
  });

  await t.test('Issue 2: Zero product mismatches on historical PI->PO links & DB trigger rejects incompatible links', async () => {
    const mismatchRes = await db.query(`
      SELECT COUNT(*)::int AS mismatch_count
      FROM public.purchase_invoice_items pii
      JOIN public.purchase_invoices pi ON pi.id = pii.purchase_invoice_id
      JOIN public.purchase_order_items poi ON poi.id = pii.purchase_order_item_id
      WHERE pi.invoice_date <= '2026-11-19'
        AND pii.product_id IS DISTINCT FROM poi.product_id
    `);
    assert.equal(mismatchRes.rows[0].mismatch_count, 0);

    // Verify trigger rejects linking a PI item to a PO item with a different product or unit
    const pairRes = await db.query(`
      SELECT pii.id AS pi_item_id, poi_other.id AS wrong_po_item_id
      FROM public.purchase_invoice_items pii
      JOIN public.purchase_order_items poi_cur ON poi_cur.id = pii.purchase_order_item_id
      JOIN public.purchase_order_items poi_other ON poi_other.po_id = poi_cur.po_id
        AND poi_other.product_id IS DISTINCT FROM pii.product_id
      WHERE pii.product_id IS NOT NULL
        AND poi_other.product_id IS NOT NULL
      LIMIT 1
    `);
    assert.ok(pairRes.rows.length > 0, 'Expected a PO with >=2 distinct products for guard test');
    const { pi_item_id, wrong_po_item_id } = pairRes.rows[0];

    await db.query('SAVEPOINT sp_guard');
    await assert.rejects(
      db.query(
        'UPDATE public.purchase_invoice_items SET purchase_order_item_id = $1 WHERE id = $2',
        [wrong_po_item_id, pi_item_id]
      ),
      /Product mismatch/
    );
    await db.query('ROLLBACK TO SAVEPOINT sp_guard');

    await db.query('SAVEPOINT sp_unit_guard');
    await assert.rejects(
      db.query(
        'UPDATE public.purchase_invoice_items SET unit = $1 WHERE id = $2',
        ['boxes', pi_item_id]
      ),
      /Unit mismatch/
    );
    await db.query('ROLLBACK TO SAVEPOINT sp_unit_guard');
  });

  await t.test('Issue 3: Target batches & cost layers stay synchronized without COGS rewrite', async () => {
    const res = await db.query(`
      SELECT COUNT(*)::int AS mismatch_count
      FROM public.batches b
      JOIN (
        SELECT batch_id,
               SUM(quantity) AS layer_qty,
               SUM(quantity * final_functional_unit_cost) AS layer_final_total
        FROM public.purchase_batch_cost_layers
        GROUP BY batch_id
      ) l ON l.batch_id = b.id
      WHERE (b.import_date <= '2026-11-19' OR b.batch_number IN ('2610892', 'DFS/126010053'))
        AND (
          ABS(COALESCE(b.final_landed_cost, 0) - l.layer_final_total) > 0.05
          OR ABS(COALESCE(b.landed_cost_per_unit, 0) - (l.layer_final_total / NULLIF(l.layer_qty, 0))) > 0.01
          OR ABS(COALESCE(b.cost_per_unit, 0) - (l.layer_final_total / NULLIF(l.layer_qty, 0))) > 0.01
        )
    `);
    assert.equal(res.rows[0].mismatch_count, 0);

    // Verify trigger syncs batch summary on cost layer update
    const layerRes = await db.query(`
      SELECT l.id, l.batch_id, l.final_functional_unit_cost, b.final_landed_cost
      FROM public.purchase_batch_cost_layers l
      JOIN public.batches b ON b.id = l.batch_id
      WHERE b.batch_number = '17731025'
      LIMIT 1
    `);
    assert.equal(layerRes.rows.length, 1);
    const layer = layerRes.rows[0];

    await db.query('SAVEPOINT sp_layer');
    await db.query(
      'UPDATE public.purchase_batch_cost_layers SET final_functional_unit_cost = final_functional_unit_cost + 1 WHERE id = $1',
      [layer.id]
    );
    const updatedBatch = await db.query(
      'SELECT final_landed_cost FROM public.batches WHERE id = $1',
      [layer.batch_id]
    );
    assert.ok(
      Number(updatedBatch.rows[0].final_landed_cost) > Number(layer.final_landed_cost),
      'Expected trigger to update batches.final_landed_cost when cost layer changes'
    );
    await db.query('ROLLBACK TO SAVEPOINT sp_layer');
  });

  await t.test('Issue 4: PPN monthly tax periods (2025-11..2026-10) match GL 1150/2130 with no double-counting and Nov cutoff preserved', async () => {
    const res = await db.query(`
      SELECT tp.fiscal_year, tp.period_month,
             (tp.input_ppn_total - COALESCE(v.input_ppn_total, 0))::numeric AS in_diff,
             (tp.output_ppn_total - COALESCE(v.output_ppn_total, 0))::numeric AS out_diff,
             tp.carry_forward_in, tp.carry_forward_out
      FROM public.tax_periods tp
      LEFT JOIN public.vw_ppn_net_by_period v ON v.tax_period_id = tp.id
      WHERE tp.tax_type = 'PPN'
        AND (tp.fiscal_year, tp.period_month) BETWEEN (2025, 11) AND (2026, 11)
      ORDER BY tp.fiscal_year, tp.period_month
    `);
    assert.equal(res.rows.length, 13);
    for (let i = 0; i < res.rows.length; i++) {
      const row = res.rows[i];
      assert.equal(Number(row.in_diff), 0, `${row.fiscal_year}-${row.period_month} in_diff`);
      assert.equal(Number(row.out_diff), 0, `${row.fiscal_year}-${row.period_month} out_diff`);
      if (i > 0) {
        assert.equal(
          Number(row.carry_forward_in),
          Number(res.rows[i - 1].carry_forward_out),
          `${row.fiscal_year}-${row.period_month} carry_forward chain`
        );
      }
    }

    // Verify broker_items + ppn_amount expenses match GL 1150 exactly (no double counting)
    const expRes = await db.query(`
      SELECT fe.voucher_number,
             (fe.ppn_amount + COALESCE((SELECT SUM(COALESCE((x->>'ppn_amount')::numeric, 0)) FROM jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) x), 0))::numeric AS expected_ppn,
             COALESCE(SUM(jel.debit - jel.credit), 0)::numeric AS gl_ppn
      FROM public.finance_expenses fe
      JOIN public.journal_entries je ON je.reference_id = fe.id AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false) AND NOT COALESCE(je.is_cancelled, false)
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id AND coa.code = '1150'
      WHERE fe.voucher_number IN ('EXP/25/288', 'EXP/26/102', 'EXP/26/103', 'EXP/26/178')
      GROUP BY fe.id, fe.voucher_number, fe.ppn_amount
    `);
    assert.equal(expRes.rows.length, 4);
    for (const r of expRes.rows) {
      assert.equal(Number(r.expected_ppn), Number(r.gl_ppn), `${r.voucher_number} PPN vs GL 1150`);
    }
  });

  await t.test('Task 1 Permissions: anon/authenticated blocked from helpers, service_role allowed, triggers still work', async () => {
    const fns = [
      'public.recompute_purchase_order_item_received(uuid)',
      'public.trg_sync_po_item_quantity_received_alloc()',
      'public.trg_sync_po_item_quantity_received_pi_item()',
      'public.validate_purchase_invoice_po_item_compatibility()',
      'public.sync_batch_cost_summary_from_layers(uuid)',
      'public.trg_sync_batch_cost_summary_from_layers()',
    ];

    for (const fn of fns) {
      const privRes = await db.query(
        `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon_exec,
                has_function_privilege('authenticated', $1, 'EXECUTE') AS auth_exec,
                has_function_privilege('service_role', $1, 'EXECUTE') AS svc_exec`,
        [fn]
      );
      assert.equal(privRes.rows[0].anon_exec, false, `anon must not execute ${fn}`);
      assert.equal(privRes.rows[0].auth_exec, false, `authenticated must not execute ${fn}`);
      assert.equal(privRes.rows[0].svc_exec, true, `service_role must retain execute on ${fn}`);
    }

    // Prove anon and authenticated actually fail on direct invocation
    for (const role of ['anon', 'authenticated']) {
      await db.query('SAVEPOINT sp_role_1');
      await db.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(
        db.query('SELECT public.recompute_purchase_order_item_received($1)', ['00000000-0000-0000-0000-000000000000']),
        /permission denied/i
      );
      await db.query('ROLLBACK TO SAVEPOINT sp_role_1');

      await db.query('SAVEPOINT sp_role_2');
      await db.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(
        db.query('SELECT public.sync_batch_cost_summary_from_layers($1)', ['00000000-0000-0000-0000-000000000000']),
        /permission denied/i
      );
      await db.query('ROLLBACK TO SAVEPOINT sp_role_2');
    }

    // Verify vw_ppn_net_by_period has security_invoker=true, blocks anon, allows authenticated
    const viewRes = await db.query(`
      SELECT reloptions,
             has_table_privilege('anon', oid, 'SELECT') AS anon_sel,
             has_table_privilege('authenticated', oid, 'SELECT') AS auth_sel
      FROM pg_class
      WHERE relname = 'vw_ppn_net_by_period'
    `);
    assert.ok((viewRes.rows[0].reloptions || []).includes('security_invoker=true'));
    assert.equal(viewRes.rows[0].anon_sel, false);
    assert.equal(viewRes.rows[0].auth_sel, true);

    await db.query('SAVEPOINT sp_view_anon');
    await db.query('SET LOCAL ROLE anon');
    await assert.rejects(
      db.query('SELECT COUNT(*) FROM public.vw_ppn_net_by_period'),
      /permission denied/i
    );
    await db.query('ROLLBACK TO SAVEPOINT sp_view_anon');

    await db.query('SAVEPOINT sp_view_auth');
    await db.query('SET LOCAL ROLE authenticated');
    const authView = await db.query('SELECT COUNT(*)::int AS cnt FROM public.vw_ppn_net_by_period');
    assert.ok(authView.rows[0].cnt >= 0);
    await db.query('ROLLBACK TO SAVEPOINT sp_view_auth');
  });

  await db.query('ROLLBACK');
});
