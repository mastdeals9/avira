import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Client } = pg;
const connectionString =
  process.env.SUPABASE_DB_URL ||
  'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres';

function getDbClient() {
  return new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
}

test('Final Three-Item Cleanup — Bank Statuses, Security Invoker & Function ACLs', async (t) => {
  const db = getDbClient();
  await db.connect();

  t.after(async () => {
    await db.end();
  });

  await t.test('1. Six matched+suggested bank lines are blocked by idx_bank_stmt_unique_confirmed_expense (each has a prior confirmed line on matched_expense_id)', async () => {
    const { rows } = await db.query(`
      SELECT bsl.id, bsl.matched_expense_id,
             (SELECT COUNT(*)::int FROM public.bank_statement_lines o
              WHERE o.matched_expense_id = bsl.matched_expense_id AND o.matching_status = 'confirmed') AS already_confirmed_count
      FROM public.bank_statement_lines bsl
      WHERE bsl.reconciliation_status = 'matched' AND bsl.matching_status = 'suggested'
    `);
    assert.equal(rows.length, 6);
    for (const r of rows) {
      assert.equal(r.already_confirmed_count, 1);
    }
  });

  await t.test('2. inventory_gl_valuation_reconciliation has security_invoker=true and works for admin, accounts, and auditor_ca', async () => {
    const { rows: viewMeta } = await db.query(`
      SELECT reloptions FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'inventory_gl_valuation_reconciliation'
    `);
    assert.ok(viewMeta[0]?.reloptions?.includes('security_invoker=true'), 'security_invoker=true must be set');

    for (const role of ['admin', 'accounts', 'auditor_ca']) {
      const { rows: users } = await db.query(
        `SELECT id FROM public.user_profiles WHERE role = $1 AND COALESCE(is_active, true) = true LIMIT 1`,
        [role]
      );
      if (users.length === 0) continue;
      await db.query('BEGIN');
      await db.query('SET LOCAL ROLE authenticated');
      await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [users[0].id]);
      await db.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");
      const { rows } = await db.query('SELECT inventory_gl, variance FROM public.inventory_gl_valuation_reconciliation');
      await db.query('ROLLBACK');
      assert.equal(rows.length, 1, `Role ${role} must be able to read inventory_gl_valuation_reconciliation`);
    }
  });

  await t.test('3. Internal trigger/balance functions revoke PUBLIC/anon/authenticated EXECUTE while lookup_login_email preserves anon access', async () => {
    const { rows } = await db.query(`
      SELECT proname,
             has_function_privilege('public', oid, 'EXECUTE') AS pub_exec,
             has_function_privilege('anon', oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', oid, 'EXECUTE') AS svc_exec
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN (
          'derive_journal_header_totals_from_lines',
          'sync_petty_cash_book_balances',
          'trg_fn_sync_petty_cash_book_balances',
          'lookup_login_email'
        )
    `);
    const byName = Object.fromEntries(rows.map((r) => [r.proname, r]));

    for (const fn of [
      'derive_journal_header_totals_from_lines',
      'sync_petty_cash_book_balances',
      'trg_fn_sync_petty_cash_book_balances',
    ]) {
      assert.equal(byName[fn].pub_exec, false, `${fn} must not grant PUBLIC EXECUTE`);
      assert.equal(byName[fn].anon_exec, false, `${fn} must not grant anon EXECUTE`);
      assert.equal(byName[fn].auth_exec, false, `${fn} must not grant authenticated EXECUTE`);
      assert.equal(byName[fn].svc_exec, true, `${fn} must grant service_role EXECUTE`);
    }

    assert.equal(byName.lookup_login_email.anon_exec, true, 'lookup_login_email must preserve anon EXECUTE');
    assert.equal(byName.lookup_login_email.auth_exec, true, 'lookup_login_email must preserve authenticated EXECUTE');
  });
});
