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

test('Simple Unpost -> Delete Expense Workflow (Rollback-Only DB Verification)', async (t) => {
  const db = getDbClient();
  await db.connect();

  t.after(async () => {
    await db.end();
  });

  const migrationSql = readFileSync(
    new URL('../supabase/migrations/20261127210000_restore_simple_expense_unpost_delete.sql', import.meta.url),
    'utf8'
  );

  await t.test('1. EXP/26/399 can be permanently deleted after unposting, removing expense & unposted/reversed journals with zero GL impact', async () => {
    await db.query('BEGIN');
    await db.query(migrationSql);

    const { rows: adminUsers } = await db.query(
      `SELECT id FROM public.user_profiles WHERE role = 'admin' AND COALESCE(is_active, true) = true LIMIT 1`
    );
    const adminId = adminUsers[0].id;

    const tbBefore = await db.query(`
      SELECT COALESCE(SUM(jel.debit), 0) AS d, COALESCE(SUM(jel.credit), 0) AS c
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.is_posted = true AND COALESCE(je.is_reversed, false) = false AND COALESCE(je.is_cancelled, false) = false
    `);

    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [adminId]);
    await db.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");

    const { rows: expBefore } = await db.query(
      `SELECT id FROM public.finance_expenses WHERE voucher_number = 'EXP/26/399'`
    );
    assert.equal(expBefore.length, 1, 'EXP/26/399 must exist');
    const expId = expBefore[0].id;

    const { rows: delRes } = await db.query(`SELECT public.delete_expense_safe($1::uuid) AS res`, [expId]);
    assert.equal(delRes[0].res.success, true);
    assert.equal(delRes[0].res.deleted_journals, 2, 'Both JE2611-0512 and JE2611-0520 must be deleted');

    const { rows: expAfter } = await db.query(`SELECT id FROM public.finance_expenses WHERE id = $1`, [expId]);
    const { rows: jeAfter } = await db.query(`SELECT id FROM public.journal_entries WHERE reference_id = $1`, [expId]);
    assert.equal(expAfter.length, 0);
    assert.equal(jeAfter.length, 0);

    const tbAfter = await db.query(`
      SELECT COALESCE(SUM(jel.debit), 0) AS d, COALESCE(SUM(jel.credit), 0) AS c
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.is_posted = true AND COALESCE(je.is_reversed, false) = false AND COALESCE(je.is_cancelled, false) = false
    `);
    assert.deepEqual(tbAfter.rows[0], tbBefore.rows[0]);

    await db.query('ROLLBACK');
  });

  await t.test('2. Full lifecycle: Draft -> Posted -> Blocked Delete -> Unpost (stays pending_approval) -> Delete -> Gone; Paid/Reconciled blocked until unlinked', async () => {
    await db.query('BEGIN');
    await db.query(migrationSql);

    const { rows: adminUsers } = await db.query(
      `SELECT id FROM public.user_profiles WHERE role = 'admin' AND COALESCE(is_active, true) = true LIMIT 1`
    );
    const adminId = adminUsers[0].id;

    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [adminId]);
    await db.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");

    // A. Create draft/unposted expense -> can be deleted directly
    const draftId = randomUUID();
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'bank_charges', 5000, '2026-11-27', 'Test Draft Delete', 'pending_approval', 'EXP/TST/DRAFT', $2)`,
      [draftId, adminId]
    );
    const { rows: draftDel } = await db.query(`SELECT public.delete_expense_safe($1::uuid) AS res`, [draftId]);
    assert.equal(draftDel[0].res.success, true);

    // B. Create & approve/post expense -> Delete blocked -> Unpost -> approval_status = pending_approval -> Delete succeeds
    const postedId = randomUUID();
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'bank_charges', 7500, '2026-11-27', 'Test Posted Unpost Delete', 'pending_approval', 'EXP/TST/POSTED', $2)`,
      [postedId, adminId]
    );
    await db.query(`SELECT public.approve_finance_expense($1::uuid, $2::uuid)`, [postedId, adminId]);

    await db.query('SAVEPOINT sp_posted_del');
    await assert.rejects(
      () => db.query(`SELECT public.delete_expense_safe($1::uuid)`, [postedId]),
      /approval_status "approved" is not eligible for deletion/i
    );
    await db.query('ROLLBACK TO SAVEPOINT sp_posted_del');

    // Approved expense with NO active journal must still be rejected by status guard
    const approvedNoJeId = randomUUID();
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'bank_charges', 2500, '2026-11-27', 'Approved No JE', 'approved', 'EXP/TST/APPNOJE', $2)`,
      [approvedNoJeId, adminId]
    );
    await db.query('SAVEPOINT sp_app_noje');
    await assert.rejects(
      () => db.query(`SELECT public.delete_expense_safe($1::uuid)`, [approvedNoJeId]),
      /approval_status "approved" is not eligible for deletion/i
    );
    await db.query('ROLLBACK TO SAVEPOINT sp_app_noje');

    await db.query(`SELECT public.cancel_expense_posting($1::uuid, $2::uuid, 'User test unpost')`, [postedId, adminId]);

    const { rows: afterUnpost } = await db.query(
      `SELECT approval_status FROM public.finance_expenses WHERE id = $1`,
      [postedId]
    );
    assert.equal(afterUnpost[0].approval_status, 'pending_approval', 'Unpost must not mark expense cancelled or rejected');

    const { rows: postedDel } = await db.query(`SELECT public.delete_expense_safe($1::uuid) AS res`, [postedId]);
    assert.equal(postedDel[0].res.success, true);
    assert.equal(postedDel[0].res.deleted_journals, 2);

    // C. Paid / partially reconciled expense -> Delete blocked until unlinked
    const paidId = randomUUID();
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, paid_amount, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'bank_charges', 10000, 4000, '2026-11-27', 'Test Paid Blocked', 'pending_approval', 'EXP/TST/PAID', $2)`,
      [paidId, adminId]
    );
    await db.query('SAVEPOINT sp_paid_del');
    await assert.rejects(
      () => db.query(`SELECT public.delete_expense_safe($1::uuid)`, [paidId]),
      /recorded payments/i
    );
    await db.query('ROLLBACK TO SAVEPOINT sp_paid_del');

    await db.query('ROLLBACK');
  });

  await t.test('3. Bank Payment -> Unlink -> Unpost -> Delete removes expense and all 4 unposted/reversed journals while preserving bank line & audit history', async () => {
    await db.query('BEGIN');
    await db.query(readFileSync(
      new URL('../supabase/migrations/20261127203000_fix_bank_unlink_matching_status_guard.sql', import.meta.url),
      'utf8'
    ));
    await db.query(migrationSql);

    const { rows: adminUsers } = await db.query(
      `SELECT id FROM public.user_profiles WHERE role = 'admin' AND COALESCE(is_active, true) = true LIMIT 1`
    );
    const adminId = adminUsers[0].id;

    const { rows: baRows } = await db.query(
      `SELECT bsl.bank_account_id AS id, bsl.upload_id, ba.currency
       FROM public.bank_statement_lines bsl
       JOIN public.bank_accounts ba ON ba.id = bsl.bank_account_id
       WHERE ba.is_active = true AND ba.coa_id IS NOT NULL AND ba.currency = 'IDR'
       LIMIT 1`
    );
    const ba = baRows[0];

    const bslId = randomUUID();
    await db.query(
      `INSERT INTO public.bank_statement_lines (id, upload_id, bank_account_id, currency, transaction_date, description, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4, '2026-11-27', 'Test Bank Payment Unlink Unpost Delete', 6000, 0)`,
      [bslId, ba.upload_id, ba.id, ba.currency]
    );

    // Unauthenticated user must be rejected by delete_expense_safe
    const expId = randomUUID();
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'bank_charges', 6000, '2026-11-27', 'Test Bank Unlink Unpost Delete', 'pending_approval', 'EXP/TST/BANKDEL', $2)`,
      [expId, adminId]
    );
    await db.query('SAVEPOINT sp_unauth');
    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', true)");
    await assert.rejects(
      () => db.query(`SELECT public.delete_expense_safe($1::uuid)`, [expId]),
      /Not authenticated/i
    );
    await db.query('ROLLBACK TO SAVEPOINT sp_unauth');

    // Authenticate as admin
    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [adminId]);
    await db.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");

    // 1) Approve/post expense
    await db.query(`SELECT public.approve_finance_expense($1::uuid, $2::uuid)`, [expId, adminId]);

    // 2) Bank payment link (creates expense_payment journal)
    await db.query(`SELECT public.link_bank_statement_line($1::uuid, 'expense', $2::uuid, 'supplier', 6000)`, [bslId, expId]);

    // 3) Unlink bank line (reverses expense_payment via expense_payment_reversal, releases bank line)
    await db.query(`SELECT public.unmatch_bank_line($1::uuid)`, [bslId]);

    // 4) Unpost expense (reverses expenses via expense_cancellation, returns approval_status to pending_approval)
    await db.query(`SELECT public.cancel_expense_posting($1::uuid, $2::uuid, 'Test unpost after bank unlink')`, [expId, adminId]);

    // 5) Delete expense -> removes expense + all 4 journals (expenses, expense_cancellation, expense_payment, expense_payment_reversal)
    const { rows: delRes } = await db.query(`SELECT public.delete_expense_safe($1::uuid) AS res`, [expId]);
    assert.equal(delRes[0].res.success, true);
    assert.equal(delRes[0].res.deleted_journals, 4, 'All 4 exclusive unposted/reversed journals must be deleted');

    const { rows: remainingJes } = await db.query(`SELECT id FROM public.journal_entries WHERE reference_id = $1`, [expId]);
    assert.equal(remainingJes.length, 0);

    const { rows: bslAfter } = await db.query(
      `SELECT id, reconciliation_status, matching_status FROM public.bank_statement_lines WHERE id = $1`,
      [bslId]
    );
    assert.equal(bslAfter.length, 1, 'Original bank statement line must be preserved');
    assert.equal(bslAfter[0].reconciliation_status, 'unmatched');
    assert.equal(bslAfter[0].matching_status, 'none');

    const { rows: auditAfter } = await db.query(
      `SELECT action_type FROM public.audit_logs WHERE table_name = 'finance_expenses' AND record_id = $1`,
      [expId]
    );
    assert.ok(auditAfter.length >= 1, 'Historical audit_logs records must be retained');

    await db.query('ROLLBACK');
  });

  await t.test('4. External journal relationships and protected FK references block deletion without mutating any records', async () => {
    await db.query('BEGIN');
    await db.query(migrationSql);

    const { rows: adminUsers } = await db.query(
      `SELECT id FROM public.user_profiles WHERE role = 'admin' AND COALESCE(is_active, true) = true LIMIT 1`
    );
    const adminId = adminUsers[0].id;
    const { rows: supRows } = await db.query(`SELECT id FROM public.suppliers LIMIT 1`);
    const supplierId = supRows[0].id;

    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [adminId]);
    await db.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");

    // A. External journal pointing to expense journal via replacement_journal_id must block deletion & leave records untouched
    const extExpId = randomUUID();
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'bank_charges', 4000, '2026-11-27', 'Test External JE Ref', 'pending_approval', 'EXP/TST/EXTREF', $2)`,
      [extExpId, adminId]
    );
    await db.query(`SELECT public.approve_finance_expense($1::uuid, $2::uuid)`, [extExpId, adminId]);
    await db.query(`SELECT public.cancel_expense_posting($1::uuid, $2::uuid, 'Unpost for ext test')`, [extExpId, adminId]);

    const { rows: expJes } = await db.query(
      `SELECT id FROM public.journal_entries WHERE reference_id = $1 ORDER BY created_at LIMIT 1`,
      [extExpId]
    );
    const targetJeId = expJes[0].id;

    const extJeId = randomUUID();
    await db.query(
      `INSERT INTO public.journal_entries (id, entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted, is_reversed, is_cancelled, replacement_journal_id, created_by)
       VALUES ($1, 'TST-EXT-REF-JE', '2026-11-27', 'journal', $1, 'TST-EXT-REF', 'External journal referencing expense JE', 0, 0, false, false, false, $2, $3)`,
      [extJeId, targetJeId, adminId]
    );

    await db.query('SAVEPOINT sp_ext_ref');
    await assert.rejects(
      () => db.query(`SELECT public.delete_expense_safe($1::uuid)`, [extExpId]),
      /external journal entry references/i
    );
    await db.query('ROLLBACK TO SAVEPOINT sp_ext_ref');

    // Verify neither the external journal nor the expense was modified
    const { rows: extCheck } = await db.query(
      `SELECT replacement_journal_id FROM public.journal_entries WHERE id = $1`,
      [extJeId]
    );
    assert.equal(extCheck[0].replacement_journal_id, targetJeId, 'External journal link must remain intact');

    // B. Protected FK reference (e.g., payment_vouchers.journal_entry_id) must block deletion & leave records untouched
    const fkExpId = randomUUID();
    await db.query(
      `INSERT INTO public.finance_expenses (id, expense_category, amount, expense_date, description, approval_status, voucher_number, created_by)
       VALUES ($1, 'bank_charges', 4500, '2026-11-27', 'Test Protected FK Ref', 'pending_approval', 'EXP/TST/FKREF', $2)`,
      [fkExpId, adminId]
    );
    await db.query(`SELECT public.approve_finance_expense($1::uuid, $2::uuid)`, [fkExpId, adminId]);
    await db.query(`SELECT public.cancel_expense_posting($1::uuid, $2::uuid, 'Unpost for FK test')`, [fkExpId, adminId]);

    const { rows: fkJes } = await db.query(
      `SELECT id FROM public.journal_entries WHERE reference_id = $1 ORDER BY created_at LIMIT 1`,
      [fkExpId]
    );
    const fkJeId = fkJes[0].id;
    const pvId = randomUUID();
    await db.query(
      `INSERT INTO public.payment_vouchers (id, voucher_number, supplier_id, voucher_date, payment_method, amount, journal_entry_id, created_by)
       VALUES ($1, 'PV-TST-FK', $2, '2026-11-27', 'cash', 4500, $3, $4)`,
      [pvId, supplierId, fkJeId, adminId]
    );

    await db.query('SAVEPOINT sp_fk_ref');
    await assert.rejects(
      () => db.query(`SELECT public.delete_expense_safe($1::uuid)`, [fkExpId]),
      /referenced by payment_vouchers/i
    );
    await db.query('ROLLBACK TO SAVEPOINT sp_fk_ref');

    const { rows: expStillExists } = await db.query(
      `SELECT id FROM public.finance_expenses WHERE id = $1`,
      [fkExpId]
    );
    assert.equal(expStillExists.length, 1, 'Expense must not be deleted when protected FK exists');

    await db.query('ROLLBACK');
  });
});
