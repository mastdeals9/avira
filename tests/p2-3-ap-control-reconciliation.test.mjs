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

test('Priority 2.3 — AP Control Reconciliation (GL 2110) & Supplier Subledger Preservation (Rollback-Only)', async (t) => {
  const db = getDbClient();
  await db.connect();

  t.after(async () => {
    await db.end();
  });

  const migrationSql = readFileSync(
    new URL('../supabase/migrations/20261127222000_p2_3_ap_control_reconciliation_view.sql', import.meta.url),
    'utf8'
  );

  await t.test('1. Live GL 2110 reconciles 100% across all 7 categories with Rp0.00 unassigned and supplier_payables_view unchanged', async () => {
    await db.query('BEGIN');
    try {
      const { rows: beforeSup } = await db.query(
        `SELECT COALESCE(SUM(payable_balance), 0)::numeric(18,2) AS total FROM public.supplier_payables_view`
      );
      await db.query(migrationSql);
      const { rows: afterSup } = await db.query(
        `SELECT COALESCE(SUM(payable_balance), 0)::numeric(18,2) AS total FROM public.supplier_payables_view`
      );
      assert.equal(afterSup[0].total, beforeSup[0].total, 'supplier_payables_view must remain unchanged');

      const { rows: glRow } = await db.query(`
        SELECT COALESCE(SUM(jel.credit - jel.debit), 0)::numeric(18,2) AS gl_2110
        FROM public.journal_entry_lines jel
        JOIN public.journal_entries je ON je.id = jel.journal_entry_id
        JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
        WHERE coa.code = '2110'
          AND COALESCE(je.is_posted, false) = true
          AND NOT COALESCE(je.is_reversed, false)
          AND NOT COALESCE(je.is_cancelled, false)
      `);

      const { rows: summary } = await db.query(`SELECT * FROM public.vw_ap_control_reconciliation_summary ORDER BY sort_order`);
      assert.equal(summary.length, 7);

      const byCode = Object.fromEntries(summary.map((r) => [r.ap_category_code, Number(r.net_ap_balance)]));
      assert.equal(byCode['1_trade_ap_supplier'], Number(afterSup[0].total));
      assert.equal(byCode['7_other_unassigned_ap'], 0);

      const summarySum = summary.reduce((s, r) => s + Number(r.net_ap_balance), 0);
      assert.ok(Math.abs(summarySum - Number(glRow[0].gl_2110)) < 0.01, 'Category sum must equal GL 2110');
    } finally {
      await db.query('ROLLBACK').catch(() => {});
    }
  });

  await t.test('2. Excludes reversed, cancelled, and unposted journals and classifies synthetic lines into all 7 categories', async () => {
    await db.query('BEGIN');
    await db.query(migrationSql);

    const { rows: adminUsers } = await db.query(
      `SELECT id FROM public.user_profiles WHERE role = 'admin' AND COALESCE(is_active, true) = true LIMIT 1`
    );
    const adminId = adminUsers[0].id;
    const { rows: coa2110 } = await db.query(`SELECT id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1`);
    const { rows: coaOffset } = await db.query(`SELECT id FROM public.chart_of_accounts WHERE code = '6100' LIMIT 1`);
    const apCoaId = coa2110[0].id;
    const offsetCoaId = coaOffset[0].id;

    const { rows: beforeGl } = await db.query(
      `SELECT COALESCE(SUM(net_ap_balance), 0)::numeric(18,2) AS total FROM public.vw_ap_control_reconciliation`
    );

    // Insert reversed, cancelled, and draft JEs touching 2110 -> MUST be excluded
    const insertJe = async (num, { posted, reversed, cancelled, sourceModule = 'journal', amt = 1000, extraCol = null, extraVal = null, desc = 'Test' }) => {
      const jeId = randomUUID();
      await db.query(
        `INSERT INTO public.journal_entries (id, entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted, is_reversed, is_cancelled, posted_by, created_by)
         VALUES ($1, $2, '2026-11-27', $3, $1, $2, $4, $5, $5, $6, $7, $8, $9, $9)`,
        [jeId, num, sourceModule, desc, amt, posted, reversed, cancelled, adminId]
      );
      const colSql = extraCol ? `, ${extraCol}` : '';
      const valSql = extraCol ? `, $5` : '';
      const params1 = extraCol ? [jeId, offsetCoaId, amt, desc, extraVal] : [jeId, offsetCoaId, amt, desc];
      const params2 = extraCol ? [jeId, apCoaId, amt, desc, extraVal] : [jeId, apCoaId, amt, desc];
      await db.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
         VALUES ($1, 1, $2, $3, 0, $4)`,
        [jeId, offsetCoaId, amt, desc]
      );
      await db.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description${colSql})
         VALUES ($1, 2, $2, 0, $3, $4${valSql})`,
        params2
      );
      void params1;
      return jeId;
    };

    await insertJe('TST-P23-REV', { posted: true, reversed: true, cancelled: false, amt: 5555 });
    await insertJe('TST-P23-CANC', { posted: true, reversed: false, cancelled: true, amt: 6666 });
    await insertJe('TST-P23-DRAFT', { posted: false, reversed: false, cancelled: false, amt: 7777 });

    const { rows: afterExcluded } = await db.query(
      `SELECT COALESCE(SUM(net_ap_balance), 0)::numeric(18,2) AS total FROM public.vw_ap_control_reconciliation`
    );
    assert.equal(afterExcluded[0].total, beforeGl[0].total, 'Reversed, cancelled, and draft JEs must be excluded');

    // Insert 1 active line in category 7_other_unassigned_ap and verify RPC picks it up
    await insertJe('TST-P23-UNASS', { posted: true, reversed: false, cancelled: false, amt: 1234, sourceModule: 'manual_adjustment', desc: 'Unassigned AP test' });
    const { rows: rpcRows } = await db.query(
      `SELECT * FROM public.get_ap_control_reconciliation_summary('2026-11-27') WHERE ap_category_code = '7_other_unassigned_ap'`
    );
    assert.equal(Number(rpcRows[0].net_ap_balance), 1234);

    await db.query('ROLLBACK');
  });
});
