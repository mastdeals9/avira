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

test('Bank Reconciliation Unlink & Re-link Workflow (Rollback-Only DB Verification)', async (t) => {
  const db = getDbClient();
  await db.connect();

  t.after(async () => {
    await db.end();
  });

  const migrationSql = readFileSync(
    new URL('../supabase/migrations/20261127203000_fix_bank_unlink_matching_status_guard.sql', import.meta.url),
    'utf8'
  );

  await t.test('1. Full unlink, partial unlink, repeated unlink, re-link, and posted journal preservation all satisfy matching_status_check', async () => {
    await db.query('BEGIN');
    await db.query(migrationSql);

    const { rows: adminUsers } = await db.query(
      `SELECT id FROM public.user_profiles WHERE role = 'admin' AND COALESCE(is_active, true) = true LIMIT 1`
    );
    assert.ok(adminUsers.length > 0, 'Active admin user required');
    const adminId = adminUsers[0].id;

    const { rows: baRows } = await db.query(
      `SELECT bsl.bank_account_id AS id, bsl.upload_id, ba.currency, ba.coa_id
       FROM public.bank_statement_lines bsl
       JOIN public.bank_accounts ba ON ba.id = bsl.bank_account_id
       WHERE ba.is_active = true AND ba.coa_id IS NOT NULL AND ba.currency = 'IDR'
       LIMIT 1`
    );
    const ba = baRows[0];

    const { rows: offsetAccts } = await db.query(
      `SELECT id FROM public.chart_of_accounts WHERE code = '6100' OR (id <> $1 AND is_active = true AND COALESCE(is_header, false) = false) ORDER BY (code = '6100') DESC LIMIT 1`,
      [ba.coa_id]
    );
    const offsetAcctId = offsetAccts[0].id;

    // Create two synthetic posted journals of 400 and 600 on the bank COA (credit side = debit on bank statement)
    const makePostedJournal = async (entryNum, amt) => {
      const jeId = randomUUID();
      await db.query(
        `INSERT INTO public.journal_entries (id, entry_number, entry_date, source_module, reference_id, reference_number, description, total_debit, total_credit, is_posted, is_reversed, is_cancelled, posted_by, created_by)
         VALUES ($1, $2, '2026-11-27', 'journal', $1, $2, $3, $4, $4, true, false, false, $5, $5)`,
        [jeId, entryNum, `Test ${entryNum}`, amt, adminId]
      );
      await db.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
         VALUES ($1, 1, $2, $4, 0), ($1, 2, $3, 0, $4)`,
        [jeId, offsetAcctId, ba.coa_id, amt]
      );
      return jeId;
    };

    const je1Id = await makePostedJournal('TST-UNL-J1', 400);
    const je2Id = await makePostedJournal('TST-UNL-J2', 600);

    // Create a synthetic bank statement line of 1000
    const bslId = randomUUID();
    await db.query(
      `INSERT INTO public.bank_statement_lines (id, upload_id, bank_account_id, currency, transaction_date, description, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4, '2026-11-27', 'Test Unlink Line 1000', 1000, 0)`,
      [bslId, ba.upload_id, ba.id, ba.currency]
    );

    // Act as authenticated admin
    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [adminId]);
    await db.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");

    // Link both journals (400 + 600 = 1000 -> fully matched & confirmed)
    await db.query(`SELECT public.link_bank_statement_line($1::uuid, 'journal', $2::uuid, 'other', 400)`, [bslId, je1Id]);
    await db.query(`SELECT public.link_bank_statement_line($1::uuid, 'journal', $2::uuid, 'other', 600)`, [bslId, je2Id]);

    const { rows: fullState } = await db.query(
      `SELECT reconciliation_status, matching_status FROM public.bank_statement_lines WHERE id = $1`,
      [bslId]
    );
    assert.equal(fullState[0].reconciliation_status, 'matched');
    assert.equal(fullState[0].matching_status, 'confirmed');

    // 1A. Partial unlink: unlink only the 400 allocation -> 600 remains -> partially_reconciled + confirmed
    const { rows: allocs } = await db.query(
      `SELECT id, allocation_amount FROM public.bank_statement_allocations WHERE bank_statement_line_id = $1 AND journal_entry_id = $2`,
      [bslId, je1Id]
    );
    assert.equal(allocs.length, 1);
    await db.query(`SELECT public.unmatch_bank_statement_allocation($1::uuid)`, [allocs[0].id]);

    const { rows: partialState } = await db.query(
      `SELECT reconciliation_status, matching_status,
              (SELECT COALESCE(SUM(allocation_amount), 0) FROM public.bank_statement_allocations WHERE bank_statement_line_id = $1) AS allocated
       FROM public.bank_statement_lines WHERE id = $1`,
      [bslId]
    );
    assert.equal(partialState[0].reconciliation_status, 'partially_reconciled');
    assert.equal(partialState[0].matching_status, 'confirmed');
    assert.equal(Number(partialState[0].allocated), 600);
    assert.equal(1000 - Number(partialState[0].allocated), 400);

    // 1B. Full unlink via unmatch_bank_line -> unmatched + none, allocated = 0, remaining = 1000
    await db.query(`SELECT public.unmatch_bank_line($1::uuid)`, [bslId]);
    const { rows: unlinkedState } = await db.query(
      `SELECT reconciliation_status, matching_status, manually_unlinked,
              (SELECT COALESCE(SUM(allocation_amount), 0) FROM public.bank_statement_allocations WHERE bank_statement_line_id = $1) AS allocated
       FROM public.bank_statement_lines WHERE id = $1`,
      [bslId]
    );
    assert.equal(unlinkedState[0].reconciliation_status, 'unmatched');
    assert.equal(unlinkedState[0].matching_status, 'none');
    assert.equal(unlinkedState[0].manually_unlinked, true);
    assert.equal(Number(unlinkedState[0].allocated), 0);

    // 1C. Repeated unlink -> idempotent, no constraint violation
    await db.query(`SELECT public.unmatch_bank_line($1::uuid)`, [bslId]);

    // 1D. Re-link after unlink -> manually_unlinked=false, confirmed, matched
    await db.query(`SELECT public.link_bank_statement_line($1::uuid, 'journal', $2::uuid, 'other', 400)`, [bslId, je1Id]);
    const { rows: relinkedState } = await db.query(
      `SELECT reconciliation_status, matching_status, manually_unlinked FROM public.bank_statement_lines WHERE id = $1`,
      [bslId]
    );
    assert.equal(relinkedState[0].reconciliation_status, 'partially_reconciled');
    assert.equal(relinkedState[0].matching_status, 'confirmed');
    assert.equal(relinkedState[0].manually_unlinked, false);

    // 1E. Posted journals je1Id & je2Id were preserved (not deleted or unposted)
    const { rows: jes } = await db.query(
      `SELECT id, is_posted, COALESCE(is_reversed, false) AS is_reversed FROM public.journal_entries WHERE id = ANY($1::uuid[])`,
      [[je1Id, je2Id]]
    );
    assert.equal(jes.length, 2);
    for (const j of jes) {
      assert.equal(j.is_posted, true);
      assert.equal(j.is_reversed, false);
    }

    await db.query('ROLLBACK');
  });
});
