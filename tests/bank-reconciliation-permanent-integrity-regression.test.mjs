import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from 'pg';

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL;

const migrationFix = fs.readFileSync(
  'supabase/migrations/20261013190000_bank_reconciliation_permanent_integrity_fix.sql',
  'utf8',
);
const migrationRepair = fs.readFileSync(
  'supabase/migrations/20261013191000_repair_july_imron_and_august_tx_cargo.sql',
  'utf8',
);

const cleanSql = (sql) => sql.replace(/^\s*BEGIN\s*;/gim, '').replace(/^\s*COMMIT\s*;/gim, '');

test('1. Migration file contracts exist and contain expected procedures', () => {
  assert.match(migrationFix, /CREATE OR REPLACE FUNCTION public\.refresh_bank_statement_allocation_status/);
  assert.match(migrationFix, /CREATE OR REPLACE FUNCTION public\.bsl_sync_reconciliation_status/);
  assert.match(migrationFix, /CREATE OR REPLACE FUNCTION public\.link_bank_statement_line/);
  assert.match(migrationRepair, /JE2610-0078/);
  assert.match(migrationRepair, /JE2608-0111/);
  assert.match(migrationRepair, /EXP\/26\/202/);
  assert.match(migrationRepair, /7fffe13b-4418-49eb-a9ae-b62846159dc2/);
  // September must be explicitly excluded
  assert.doesNotMatch(migrationRepair, /2026-09/);
});

test('2. Live Database Transactional Regression Suite (Pure Rollback Isolation)', async (t) => {
  if (!DB_CONNECTION) {
    console.warn('Skipping live database regression suite: DATABASE_URL is not set.');
    return;
  }
  const client = new Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query('BEGIN');

    // Apply the permanent code fix within the transaction
    await client.query(cleanSql(migrationFix));

    const seed = await client.query(`
      SELECT ba.id as bank_id, ba.coa_id as bank_coa_id,
             u.id as user_id,
             (SELECT id FROM chart_of_accounts WHERE code = '2110') as ap_id,
             (SELECT id FROM chart_of_accounts WHERE code = '1130') as inv_id,
             (SELECT id FROM chart_of_accounts WHERE code = '6100') as exp_coa_id,
             (SELECT id FROM bank_statement_uploads LIMIT 1) as upload_id
      FROM bank_accounts ba
      CROSS JOIN (SELECT id FROM user_profiles LIMIT 1) u
      WHERE ba.id = 'bfe79829-07d1-48ed-8965-ff9d367d758e'
    `);
    const { bank_id, bank_coa_id, user_id, ap_id, inv_id, exp_coa_id, upload_id } = seed.rows[0];

    // ------------------------------------------------------------------------
    // Case A: Accrual Journal is Rejected (Zero Bank COA movement)
    // ------------------------------------------------------------------------
    await t.test('Case A: Accrual journal with no bank COA line is rejected by allocation integrity guard', async () => {
      // 1. Create accrual journal (Dr 1130 / Cr 2110)
      const jeRes = await client.query(`
        INSERT INTO journal_entries (
          entry_number, entry_date, description, is_posted, is_reversed,
          total_debit, total_credit, created_by, source_module
        ) VALUES (
          'TEST-JE-' || substr(md5(random()::text), 1, 8), CURRENT_DATE, 'Accrual only', true, false,
          5000000, 5000000, $1, 'expenses'
        ) RETURNING id
      `, [user_id]);
      const accrualJeId = jeRes.rows[0].id;

      await client.query(`
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
        VALUES ($1, 1, $2, 5000000, 0), ($1, 2, $3, 0, 5000000)
      `, [accrualJeId, inv_id, ap_id]);

      // 2. Create bank statement line (5,000,000 debit)
      const bslRes = await client.query(`
        INSERT INTO bank_statement_lines (
          upload_id, bank_account_id, transaction_date, description, debit_amount, credit_amount, currency
        ) VALUES (
          $1, $2, CURRENT_DATE, 'Test Line Accrual Reject ' || substr(md5(random()::text), 1, 8), 5000000, 0, 'IDR'
        ) RETURNING id
      `, [upload_id, bank_id]);
      const bslId = bslRes.rows[0].id;

      // 3. Creating allocation pointing to the accrual journal must be REJECTED by trigger
      let errCaught = false;
      await client.query('SAVEPOINT sp_case_a');
      try {
        await client.query(`
          INSERT INTO bank_statement_allocations (
            bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind
          ) VALUES (
            $1, 'expense', gen_random_uuid(), $2, 5000000, 'supplier'
          )
        `, [bslId, accrualJeId]);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT sp_case_a');
        errCaught = true;
        assert.match(err.message, /Allocated journal has no bank COA movement/);
      }
      assert.equal(errCaught, true, 'Expected allocation with accrual journal to be rejected');

      // Statement line must remain unmatched
      const statusRes = await client.query(`
        SELECT reconciliation_status, matching_status FROM bank_statement_lines WHERE id = $1
      `, [bslId]);
      assert.equal(statusRes.rows[0].reconciliation_status, 'unmatched');
      assert.equal(statusRes.rows[0].matching_status, 'none');
    });

    // ------------------------------------------------------------------------
    // Case B: Reversed Journal is Excluded
    // ------------------------------------------------------------------------
    await t.test('Case B: Reversed journal is excluded from line reconciliation status', async () => {
      // 1. Create valid payment journal
      const jeRes = await client.query(`
        INSERT INTO journal_entries (
          entry_number, entry_date, description, is_posted, is_reversed,
          total_debit, total_credit, created_by, source_module
        ) VALUES (
          'TEST-JE-' || substr(md5(random()::text), 1, 8), CURRENT_DATE, 'Payment to be reversed', true, false,
          3000000, 3000000, $1, 'expense_payment'
        ) RETURNING id
      `, [user_id]);
      const payJeId = jeRes.rows[0].id;

      await client.query(`
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
        VALUES ($1, 1, $2, 3000000, 0), ($1, 2, $3, 0, 3000000)
      `, [payJeId, ap_id, bank_coa_id]);

      // 2. Create bank line
      const bslRes = await client.query(`
        INSERT INTO bank_statement_lines (
          upload_id, bank_account_id, transaction_date, description, debit_amount, credit_amount, currency
        ) VALUES (
          $1, $2, CURRENT_DATE, 'Test Line Reversed Reject ' || substr(md5(random()::text), 1, 8), 3000000, 0, 'IDR'
        ) RETURNING id
      `, [upload_id, bank_id]);
      const bslId = bslRes.rows[0].id;

      await client.query(`
        INSERT INTO bank_statement_allocations (
          bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind
        ) VALUES (
          $1, 'expense', gen_random_uuid(), $2, 3000000, 'supplier'
        )
      `, [bslId, payJeId]);

      // 3. Status when active: MATCHED
      await client.query(`SELECT refresh_bank_statement_allocation_status($1)`, [bslId]);
      const activeRes = await client.query(`
        SELECT reconciliation_status FROM bank_statement_lines WHERE id = $1
      `, [bslId]);
      assert.equal(activeRes.rows[0].reconciliation_status, 'matched');

      // 4. Now mark journal as reversed
      await client.query(`UPDATE journal_entries SET is_reversed = true WHERE id = $1`, [payJeId]);

      // 5. Refresh: Must drop back to unmatched!
      await client.query(`SELECT refresh_bank_statement_allocation_status($1)`, [bslId]);
      const revRes = await client.query(`
        SELECT reconciliation_status, matching_status FROM bank_statement_lines WHERE id = $1
      `, [bslId]);
      assert.equal(revRes.rows[0].reconciliation_status, 'unmatched');
      assert.equal(revRes.rows[0].matching_status, 'none');
    });

    // ------------------------------------------------------------------------
    // Case C: Direction Mismatch is Rejected
    // ------------------------------------------------------------------------
    await t.test('Case C: Direction mismatch (statement debit vs GL debit) is rejected by allocation integrity guard', async () => {
      // Create journal where bank account is DEBITED instead of CREDITED
      const jeRes = await client.query(`
        INSERT INTO journal_entries (
          entry_number, entry_date, description, is_posted, is_reversed,
          total_debit, total_credit, created_by, source_module
        ) VALUES (
          'TEST-JE-' || substr(md5(random()::text), 1, 8), CURRENT_DATE, 'Wrong direction', true, false,
          1000000, 1000000, $1, 'manual'
        ) RETURNING id
      `, [user_id]);
      const wrongJeId = jeRes.rows[0].id;

      await client.query(`
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
        VALUES ($1, 1, $2, 1000000, 0), ($1, 2, $3, 0, 1000000)
      `, [wrongJeId, bank_coa_id, ap_id]);

      const bslRes = await client.query(`
        INSERT INTO bank_statement_lines (
          upload_id, bank_account_id, transaction_date, description, debit_amount, credit_amount, currency
        ) VALUES (
          $1, $2, CURRENT_DATE, 'Statement Debit 1M ' || substr(md5(random()::text), 1, 8), 1000000, 0, 'IDR'
        ) RETURNING id
      `, [upload_id, bank_id]);
      const bslId = bslRes.rows[0].id;

      let errCaught = false;
      await client.query('SAVEPOINT sp_case_c');
      try {
        await client.query(`
          INSERT INTO bank_statement_allocations (
            bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind
          ) VALUES (
            $1, 'expense', gen_random_uuid(), $2, 1000000, 'supplier'
          )
        `, [bslId, wrongJeId]);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT sp_case_c');
        errCaught = true;
        assert.match(err.message, /Statement debit requires a journal bank credit/);
      }
      assert.equal(errCaught, true, 'Expected direction mismatch to be rejected');
    });

    // ------------------------------------------------------------------------
    // Case D: Partial Payments and Split Allocations
    // ------------------------------------------------------------------------
    await t.test('Case D: Partial payments progress from partially_reconciled to matched', async () => {
      // Statement line: 10,000,000
      const bslRes = await client.query(`
        INSERT INTO bank_statement_lines (
          upload_id, bank_account_id, transaction_date, description, debit_amount, credit_amount, currency
        ) VALUES (
          $1, $2, CURRENT_DATE, 'Split Payment Statement Line 10M ' || substr(md5(random()::text), 1, 8), 10000000, 0, 'IDR'
        ) RETURNING id
      `, [upload_id, bank_id]);
      const bslId = bslRes.rows[0].id;

      // Journal 1: 4,000,000
      const je1 = await client.query(`
        INSERT INTO journal_entries (entry_number, entry_date, description, is_posted, is_reversed, total_debit, total_credit, created_by, source_module)
        VALUES ('TEST-JE-' || substr(md5(random()::text), 1, 8), CURRENT_DATE, 'Part 1', true, false, 4000000, 4000000, $1, 'expense_payment') RETURNING id
      `, [user_id]);
      await client.query(`
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
        VALUES ($1, 1, $2, 4000000, 0), ($1, 2, $3, 0, 4000000)
      `, [je1.rows[0].id, ap_id, bank_coa_id]);

      // Allocate 4M
      await client.query(`
        INSERT INTO bank_statement_allocations (bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind)
        VALUES ($1, 'expense', gen_random_uuid(), $2, 4000000, 'supplier')
      `, [bslId, je1.rows[0].id]);

      await client.query(`SELECT refresh_bank_statement_allocation_status($1)`, [bslId]);
      let statusRes = await client.query(`SELECT reconciliation_status FROM bank_statement_lines WHERE id = $1`, [bslId]);
      assert.equal(statusRes.rows[0].reconciliation_status, 'partially_reconciled');

      // Journal 2: 6,000,000
      const je2 = await client.query(`
        INSERT INTO journal_entries (entry_number, entry_date, description, is_posted, is_reversed, total_debit, total_credit, created_by, source_module)
        VALUES ('TEST-JE-' || substr(md5(random()::text), 1, 8), CURRENT_DATE, 'Part 2', true, false, 6000000, 6000000, $1, 'expense_payment') RETURNING id
      `, [user_id]);
      await client.query(`
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
        VALUES ($1, 1, $2, 6000000, 0), ($1, 2, $3, 0, 6000000)
      `, [je2.rows[0].id, ap_id, bank_coa_id]);

      // Allocate remaining 6M
      await client.query(`
        INSERT INTO bank_statement_allocations (bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind)
        VALUES ($1, 'expense', gen_random_uuid(), $2, 6000000, 'supplier')
      `, [bslId, je2.rows[0].id]);

      await client.query(`SELECT refresh_bank_statement_allocation_status($1)`, [bslId]);
      statusRes = await client.query(`SELECT reconciliation_status FROM bank_statement_lines WHERE id = $1`, [bslId]);
      assert.equal(statusRes.rows[0].reconciliation_status, 'matched');
    });

    // ------------------------------------------------------------------------
    // Case E: Safe Retries / Idempotency
    // ------------------------------------------------------------------------
    await t.test('Case E: Calling refresh repeatedly is idempotent', async () => {
      const bslRes = await client.query(`
        INSERT INTO bank_statement_lines (
          upload_id, bank_account_id, transaction_date, description, debit_amount, credit_amount, currency
        ) VALUES (
          $1, $2, CURRENT_DATE, 'Idempotent Test ' || substr(md5(random()::text), 1, 8), 2000000, 0, 'IDR'
        ) RETURNING id
      `, [upload_id, bank_id]);
      const bslId = bslRes.rows[0].id;

      const je = await client.query(`
        INSERT INTO journal_entries (entry_number, entry_date, description, is_posted, is_reversed, total_debit, total_credit, created_by, source_module)
        VALUES ('TEST-JE-' || substr(md5(random()::text), 1, 8), CURRENT_DATE, 'Idem', true, false, 2000000, 2000000, $1, 'expense_payment') RETURNING id
      `, [user_id]);
      await client.query(`
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
        VALUES ($1, 1, $2, 2000000, 0), ($1, 2, $3, 0, 2000000)
      `, [je.rows[0].id, ap_id, bank_coa_id]);

      await client.query(`
        INSERT INTO bank_statement_allocations (bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind)
        VALUES ($1, 'expense', gen_random_uuid(), $2, 2000000, 'supplier')
      `, [bslId, je.rows[0].id]);

      // Call twice
      await client.query(`SELECT refresh_bank_statement_allocation_status($1)`, [bslId]);
      await client.query(`SELECT refresh_bank_statement_allocation_status($1)`, [bslId]);

      const statusRes = await client.query(`SELECT reconciliation_status FROM bank_statement_lines WHERE id = $1`, [bslId]);
      assert.equal(statusRes.rows[0].reconciliation_status, 'matched');
    });

    // ------------------------------------------------------------------------
    // Case F: July and August Production Repair Simulation (Transaction Rollback)
    // ------------------------------------------------------------------------
    await t.test('Case F: Historical Repair Simulation produces exact Rp0 variance for July & August', async () => {
      // Apply the historical repair migration in the transaction
      await client.query(cleanSql(migrationRepair));

      // Check monthly reconciliation view for July and August
      const reconRes = await client.query(`
        SELECT to_char(month_start, 'YYYY-MM') as ym,
               statement_lines, statement_net,
               ledger_journal_entries, ledger_net,
               variance, reconciliation_status
        FROM vw_bank_ledger_monthly_reconciliation
        WHERE bank_account_id = $1
          AND month_start IN ('2026-07-01', '2026-08-01')
        ORDER BY month_start
      `, [bank_id]);

      console.table(reconRes.rows);

      // July 2026 assertions
      const july = reconRes.rows.find(r => r.ym === '2026-07');
      assert.equal(july.statement_lines, '51');
      assert.equal(july.ledger_journal_entries, '51');
      assert.equal(july.statement_net, '319925289.75');
      assert.equal(july.ledger_net, '319925289.75');
      assert.equal(july.variance, '0.00');
      assert.equal(july.reconciliation_status, 'MATCHED');

      // August 2026 assertions
      const august = reconRes.rows.find(r => r.ym === '2026-08');
      assert.equal(august.statement_lines, '65');
      assert.equal(august.statement_net, '147183206.00');
      assert.equal(august.ledger_net, '147183206.00');
      assert.equal(august.variance, '0.00');
      assert.equal(august.reconciliation_status, 'MATCHED');

      // AP Balance for EXP/26/202 assertion
      const apRes = await client.query(`
        SELECT COALESCE(SUM(jel.credit), 0) - COALESCE(SUM(jel.debit), 0) as ap_balance
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.reference_id = '82d239fe-1d49-486d-9126-a20a9107b412'
          AND jel.account_id = $1
          AND je.is_posted = true
          AND NOT COALESCE(je.is_reversed, false)
      `, [ap_id]);
      assert.equal(Number(apRes.rows[0].ap_balance), 0);
    });

  } finally {
    // ALWAYS ROLLBACK TO PRESERVE PRODUCTION STATE
    await client.query('ROLLBACK');
    await client.end();
  }
});
