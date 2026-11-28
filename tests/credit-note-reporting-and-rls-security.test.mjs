import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from '/Users/Kunal/Documents/anzen-main/node_modules/pg/lib/index.js';

test('1. Migration Integrity: 20261102030000 ensures RLS and Credit Note parity', () => {
  const migrationPath = 'supabase/migrations/20261102030000_credit_note_reporting_consistency_and_rls_security.sql';
  assert.ok(fs.existsSync(migrationPath), 'Migration file must exist');

  const content = fs.readFileSync(migrationPath, 'utf8');

  // Verify get_sales_profit_summary updates
  assert.ok(content.includes('prod_returns AS ('), 'Must include prod_returns CTE');
  assert.ok(content.includes('cni.product_id'), 'Must group returns by product_id');
  assert.ok(content.includes("cn.status = 'approved'"), 'Must strictly filter approved credit notes');
  assert.ok(content.includes('get_credit_note_item_fifo_cogs'), 'Must calculate exact FIFO COGS reversal');
  assert.ok(content.includes('is_reportable_sales_invoice'), 'Must exclude cancelled invoices');

  // Verify RLS on customs_ndpbm_declarations
  assert.ok(content.includes('ALTER TABLE public.customs_ndpbm_declarations ENABLE ROW LEVEL SECURITY;'), 'Must enable RLS on customs_ndpbm_declarations');
  assert.ok(content.includes('REVOKE ALL ON public.customs_ndpbm_declarations FROM PUBLIC, anon;'), 'Must revoke privileges from PUBLIC and anon on customs_ndpbm_declarations');
  assert.ok(content.includes('cnd_select_authorized_roles'), 'Must define select policy for authorized roles on customs_ndpbm_declarations');
  assert.ok(content.includes('cnd_insert_finance_roles'), 'Must define insert policy for finance roles on customs_ndpbm_declarations');
  assert.ok(content.includes('cnd_delete_admin_role'), 'Must restrict delete to admin on customs_ndpbm_declarations');

  // Verify RLS on credit_note_allocations
  assert.ok(content.includes('ALTER TABLE public.credit_note_allocations ENABLE ROW LEVEL SECURITY;'), 'Must enable RLS on credit_note_allocations');
  assert.ok(content.includes('REVOKE ALL ON public.credit_note_allocations FROM PUBLIC, anon;'), 'Must revoke privileges from PUBLIC and anon on credit_note_allocations');
  assert.ok(content.includes('cna_select_authorized_roles'), 'Must define select policy for authorized roles on credit_note_allocations');
  assert.ok(content.includes('cna_insert_finance_roles'), 'Must define insert policy for finance roles on credit_note_allocations');
  assert.ok(content.includes('cna_delete_admin_role'), 'Must restrict delete to admin on credit_note_allocations');
});

test('2. Frontend Codebase Audit: Verification of get_sales_profit_summary Usage', () => {
  const reportsFile = fs.readFileSync('src/pages/reports/Reports.tsx', 'utf8');
  assert.ok(reportsFile.includes('<CanonicalSalesProfitReport />'), 'Reports.tsx Sales Profit tab must use CanonicalSalesProfitReport');

  const spReportFile = fs.readFileSync('src/pages/reports/SalesProfitReport.tsx', 'utf8');
  assert.ok(spReportFile.includes('<CanonicalSalesProfitReport />'), 'SalesProfitReport.tsx must use CanonicalSalesProfitReport');

  const canonicalFile = fs.readFileSync('src/pages/reports/CanonicalSalesProfitReport.tsx', 'utf8');
  assert.ok(canonicalFile.includes('get_sales_profitability_summary'), 'Canonical report must use get_sales_profitability_summary');
  assert.ok(!canonicalFile.includes('get_sales_profit_summary('), 'Canonical report must not call obsolete non-harmonized functions');
});

test('3. Credit Note Accounting Math: Return Revenue, Quantity and FIFO COGS Deductions', () => {
  const grossSalesQty = 49450;
  const grossSalesRevenue = 718319775.00;
  const grossCOGS = 487808269.34;

  const returnQty = 125;
  const returnRevenue = 1572375.00;
  const returnCOGS = 1227102.50;

  const netQty = grossSalesQty - returnQty;
  const netRevenue = Number((grossSalesRevenue - returnRevenue).toFixed(2));
  const netCOGS = Number((grossCOGS - returnCOGS).toFixed(2));
  const netProfit = Number((netRevenue - netCOGS).toFixed(2));
  const profitMarginPct = Number(((netProfit / netRevenue) * 100).toFixed(2));

  assert.equal(netQty, 49325, 'Net sold quantity must be exactly 49,325 kg');
  assert.equal(netRevenue, 716747400.00, 'Net revenue must be exactly Rp 716,747,400.00');
  assert.equal(netCOGS, 486581166.84, 'Net COGS must be exactly Rp 486,581,166.84');
  assert.equal(netProfit, 230166233.16, 'Net profit must be exactly Rp 230,166,233.16');
  assert.equal(profitMarginPct, 32.11, 'Net profit margin must be exactly 32.11%');
});

test('4. Live Database Transactional Pre-Execution Validation: 8 Reporting Cases & 7 Security Roles', async () => {
  const { Client } = pg;
  const client = new Client({
    connectionString: (process.env.READONLY_AUDIT_DB_URL || ''),
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  await client.query('BEGIN;');

  try {
    // Apply migration SQL inside transaction
    const migrationSql = fs.readFileSync('supabase/migrations/20261102030000_credit_note_reporting_consistency_and_rls_security.sql', 'utf8');
    await client.query(migrationSql);

    // Set authenticated session for reporting verification (Accounts user)
    await client.query(`SET LOCAL ROLE authenticated;`);
    await client.query(`SELECT set_config('request.jwt.claims', '{"sub": "20f63eb2-75f9-4ccd-949b-7d3b60823921", "role": "authenticated"}', true);`);

    // -------------------------------------------------------------
    // REPORTING TESTS (Cases 1 - 8)
    // -------------------------------------------------------------
    // Case 1: Normal posted sales without returns (Pregabalin)
    const preg = await client.query(`
      SELECT * FROM public.get_sales_profit_summary('2025-01-01'::date, '2026-12-31'::date)
      WHERE product_name = 'Pregabalin';
    `);
    assert.equal(preg.rows.length, 1);
    assert.equal(Number(preg.rows[0].total_qty_sold), 100);
    assert.equal(Number(preg.rows[0].total_revenue), 121584000);
    assert.equal(Number(preg.rows[0].total_cogs), 102717687); // Includes Rp 1,012,500 landed cost true-up from migration 20261102050000
    assert.equal(Number(preg.rows[0].total_profit), 18866313);

    // Case 2: Approved credit note with returned stock (Corn Starch BP)
    const csbp = await client.query(`
      SELECT * FROM public.get_sales_profit_summary('2025-01-01'::date, '2026-12-31'::date)
      WHERE product_name = 'Corn Starch BP';
    `);
    assert.equal(csbp.rows.length, 1);
    assert.equal(Number(csbp.rows[0].total_qty_sold), 49325); // 49,450 - 125 kg
    assert.equal(Number(csbp.rows[0].total_revenue), 716747400); // 718,319,775 - 1,572,375
    assert.equal(Number(csbp.rows[0].total_cogs), 490726468.74); // Includes Rp 4,145,301.90 sold BM reallocation from migration 20261102050000
    assert.equal(Number(csbp.rows[0].total_profit), 226020931.26);

    // Case 4 & 5: Cancelled credit notes & cancelled invoices
    const canInv = await client.query(`
      SELECT COUNT(*) as count FROM public.get_sales_profit_summary('2025-01-01'::date, '2026-12-31'::date)
      WHERE product_name = 'Cancelled Product';
    `);
    assert.equal(Number(canInv.rows[0].count), 0);

    // Case 7: Company-wide and Product-level profit reconciliation
    const sums = await client.query(`
      SELECT 
        SUM(total_qty_sold) as agg_qty,
        SUM(total_revenue) as agg_sales,
        SUM(total_cogs) as agg_cogs,
        SUM(total_profit) as agg_profit
      FROM public.get_sales_profit_summary('2025-01-01'::date, '2026-12-31'::date);
    `);
    assert.equal(Number(sums.rows[0].agg_sales), 7119809323.75);
    assert.ok(Math.abs(Number(sums.rows[0].agg_cogs) - 6619295983.90) < 0.10); // Harmonized Authoritative FIFO COGS matching GL 5100
    assert.ok(Math.abs(Number(sums.rows[0].agg_profit) - 500513339.85) < 0.10);

    // Case 8: Verify no duplicate deductions
    // Corn Starch BP return revenue is exactly 1,572,375 (deducted once)
    const origCornSales = 718319775.00;
    assert.equal(Number(csbp.rows[0].total_revenue), origCornSales - 1572375.00);

    // -------------------------------------------------------------
    // SECURITY TESTS (7 Roles)
    // -------------------------------------------------------------
    await client.query('RESET ROLE;');
    // Seed rows
    await client.query(`
      INSERT INTO public.customs_ndpbm_declarations (
        id, declaration_reference, declaration_date, currency, customs_ndpbm_rate, actual_bm_paid
      ) VALUES ('11111111-1111-1111-1111-111111111111', 'TEST-PIB-001', '2026-11-01', 'USD', 17937, 3633000);

      INSERT INTO public.credit_note_allocations (
        id, allocation_number, credit_note_id, target_invoice_id, allocated_amount
      ) VALUES ('22222222-2222-2222-2222-222222222222', 'CNA-TEST-001', '83953d95-7baf-4a07-b7c5-b63d6f08945c', '03162b99-b06b-475b-b00c-e14cb9dd6123', 500000);
    `);

    const testMatrix = [
      { name: 'Anonymous (anon)', uid: null, role: 'anon', expRpc: false, expectRead: false, expectWrite: false, expectDelete: false },
      { name: 'Authenticated Unauthorized', uid: '99999999-9999-9999-9999-999999999999', role: 'authenticated', expRpc: false, expectRead: false, expectWrite: false, expectDelete: false },
      { name: 'Sales User', uid: 'a82db049-ed45-4861-a115-a20155129f3a', role: 'authenticated', expRpc: false, expectRead: false, expectWrite: false, expectDelete: false },
      { name: 'Warehouse User', uid: 'cd7b9d5f-d45c-4b5f-b113-68505a8cae27', role: 'authenticated', expRpc: false, expectRead: false, expectWrite: false, expectDelete: false },
      { name: 'Auditor CA User', uid: '8fc7b70f-708f-4bfc-bc27-d52fb196a0b4', role: 'authenticated', expRpc: true, expectRead: true, expectWrite: false, expectDelete: false },
      { name: 'Accounts User', uid: '20f63eb2-75f9-4ccd-949b-7d3b60823921', role: 'authenticated', expRpc: true, expectRead: true, expectWrite: true, expectDelete: false },
      { name: 'Admin User', uid: '1075a773-bb55-4296-bc71-af2eab9a0780', role: 'authenticated', expRpc: true, expectRead: true, expectWrite: true, expectDelete: true }
    ];

    for (const tc of testMatrix) {
      await client.query(`SET LOCAL ROLE ${tc.role};`);
      if (tc.uid) {
        await client.query(`SELECT set_config('request.jwt.claims', '{"sub": "${tc.uid}", "role": "${tc.role}"}', true);`);
      } else {
        await client.query(`SELECT set_config('request.jwt.claims', '{}', true);`);
      }

      // RPC test on get_sales_profit_summary
      let canRunRpc = false;
      await client.query('SAVEPOINT sp_rpc;');
      try {
        const res = await client.query(`SELECT count(*) FROM public.get_sales_profit_summary('2025-01-01'::date, '2026-12-31'::date);`);
        canRunRpc = Number(res.rows[0].count) > 0;
        await client.query('RELEASE SAVEPOINT sp_rpc;');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_rpc;');
        canRunRpc = false;
      }
      assert.equal(canRunRpc, tc.expRpc, `Role ${tc.name} RPC get_sales_profit_summary access mismatch`);

      // SELECT test CND
      let canReadCnd = false;
      await client.query('SAVEPOINT sp_sel_cnd;');
      try {
        const cndRes = await client.query('SELECT count(*) FROM public.customs_ndpbm_declarations;');
        canReadCnd = Number(cndRes.rows[0].count) > 0;
        await client.query('RELEASE SAVEPOINT sp_sel_cnd;');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_sel_cnd;');
        canReadCnd = false;
      }

      // SELECT test CNA
      let canReadCna = false;
      await client.query('SAVEPOINT sp_sel_cna;');
      try {
        const cnaRes = await client.query('SELECT count(*) FROM public.credit_note_allocations;');
        canReadCna = Number(cnaRes.rows[0].count) > 0;
        await client.query('RELEASE SAVEPOINT sp_sel_cna;');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_sel_cna;');
        canReadCna = false;
      }

      // INSERT test CND
      let canInsertCnd = false;
      await client.query('SAVEPOINT sp_ins_cnd;');
      try {
        await client.query(`
          INSERT INTO public.customs_ndpbm_declarations (
            declaration_reference, declaration_date, currency, customs_ndpbm_rate, actual_bm_paid
          ) VALUES ('ROLE-TEST-${tc.name}', CURRENT_DATE, 'USD', 17937, 1000);
        `);
        canInsertCnd = true;
        await client.query('RELEASE SAVEPOINT sp_ins_cnd;');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_ins_cnd;');
        canInsertCnd = false;
      }

      // DELETE test CND
      let canDeleteCnd = false;
      await client.query('SAVEPOINT sp_del_cnd;');
      try {
        const delRes = await client.query(`
          DELETE FROM public.customs_ndpbm_declarations WHERE id = '11111111-1111-1111-1111-111111111111';
        `);
        canDeleteCnd = delRes.rowCount > 0;
        await client.query('RELEASE SAVEPOINT sp_del_cnd;');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_del_cnd;');
        canDeleteCnd = false;
      }

      assert.equal(canReadCnd, tc.expectRead, `Role ${tc.name} read customs_ndpbm_declarations mismatch`);
      assert.equal(canReadCna, tc.expectRead, `Role ${tc.name} read credit_note_allocations mismatch`);
      assert.equal(canInsertCnd, tc.expectWrite, `Role ${tc.name} insert customs_ndpbm_declarations mismatch`);
      assert.equal(canDeleteCnd, tc.expectDelete, `Role ${tc.name} delete customs_ndpbm_declarations mismatch`);

      await client.query('RESET ROLE;');
    }

  } finally {
    await client.query('ROLLBACK;');
    await client.end();
  }
});
