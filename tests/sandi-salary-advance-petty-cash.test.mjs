import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB_CONNECTION =
  process.env.SUPABASE_DB_URL ||
  'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres';

test('Sandi Prasetyo Salary Advance via Petty Cash Verification Suite', async (t) => {
  const client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const c_pv028_id = '8a045a25-e2b4-4f7b-8a27-4312d86a547e';
  const c_ft_id = '865b9a2d-9224-4937-b56c-cd587189399a';
  const c_pc30_id = '9115476c-f7c6-409e-986c-12877ce47fbc';
  const c_book_id = 'f974b5c5-b399-44e6-bfe9-2d8e78d2b7d8';
  const c_pv023_id = 'd024d570-3348-4c41-96ac-e83b2a91cae9';
  const c_pv032_id = '75271c77-fc47-4ba7-b1fa-42cb4abd74ca';

  try {
    // 1. Identity & Restoration of PV/26-26/028
    await t.test('1. PV/26-26/028 identity and employee association preserved', async () => {
      const { rows } = await client.query(
        `SELECT pv.*, fsm.full_name as staff_name
         FROM payment_vouchers pv
         JOIN finance_staff_master fsm ON fsm.id = pv.staff_id
         WHERE pv.id = $1`,
        [c_pv028_id]
      );
      assert.equal(rows.length, 1);
      const pv = rows[0];
      assert.equal(pv.voucher_number, 'PV/26-26/028');
      assert.equal(pv.staff_name, 'Sandi Prasetyo');
      assert.equal(Number(pv.amount), 100000);
      assert.equal(pv.payment_purpose, 'salary_advance');
      assert.equal(pv.payment_method, 'petty_cash');
      assert.equal(pv.party_type, 'employee');
      assert.equal(pv.is_posted, true);
      assert.ok(pv.journal_entry_id, 'PV must have linked journal entry');
    });

    // 2. Authoritative Journal: Dr 1160 / Cr 1102
    await t.test('2. Authoritative Journal creates Dr 1160 Staff Advances / Cr 1102 Petty Cash', async () => {
      const { rows: pvRows } = await client.query('SELECT journal_entry_id FROM payment_vouchers WHERE id = $1', [c_pv028_id]);
      const jeId = pvRows[0].journal_entry_id;

      const { rows: jeRows } = await client.query(
        'SELECT id, entry_number, is_posted, is_reversed, total_debit, total_credit FROM journal_entries WHERE id = $1',
        [jeId]
      );
      assert.equal(jeRows.length, 1);
      const je = jeRows[0];
      assert.equal(je.entry_number, 'JE2611-0492');
      assert.equal(je.is_posted, true);
      assert.equal(je.is_reversed, false);
      assert.equal(Number(je.total_debit), 100000);
      assert.equal(Number(je.total_credit), 100000);

      const { rows: lines } = await client.query(
        `SELECT jel.line_number, coa.code, coa.name, jel.debit, jel.credit
         FROM journal_entry_lines jel
         JOIN chart_of_accounts coa ON coa.id = jel.account_id
         WHERE jel.journal_entry_id = $1
         ORDER BY jel.line_number`,
        [jeId]
      );
      assert.equal(lines.length, 2, 'Must have exactly 2 lines');
      assert.equal(lines[0].code, '1160', 'Line 1 must be 1160 Staff Advances');
      assert.equal(Number(lines[0].debit), 100000);
      assert.equal(Number(lines[0].credit), 0);

      assert.equal(lines[1].code, '1102', 'Line 2 must be 1102 Petty Cash');
      assert.equal(Number(lines[1].debit), 0);
      assert.equal(Number(lines[1].credit), 100000);
    });

    // 3. Exactly one linked Petty Cash outflow
    await t.test('3. Exactly one linked Petty Cash outflow exists with category NULL', async () => {
      const { rows } = await client.query(
        `SELECT * FROM petty_cash_transactions WHERE payment_voucher_id = $1`,
        [c_pv028_id]
      );
      assert.equal(rows.length, 1, 'Must have exactly 1 linked Petty Cash transaction');
      const pc = rows[0];
      assert.equal(pc.transaction_type, 'expense');
      assert.equal(Number(pc.amount), 100000);
      assert.equal(pc.paid_to, 'Sandi Prasetyo');
      assert.equal(pc.expense_category, null, 'Expense category must be NULL (Balance Sheet advance)');
      assert.equal(pc.approval_status, 'approved');
      assert.equal(pc.petty_cash_book_id, c_book_id);
    });

    // 4. Petty Cash Book: Renamed and balance accurately deducted
    await t.test('4. General Petty Cash book renamed and balance correctly reflects deduction', async () => {
      const { rows } = await client.query(
        'SELECT id, name, float_amount, current_balance, is_active FROM petty_cash_books WHERE id = $1',
        [c_book_id]
      );
      assert.equal(rows.length, 1);
      const book = rows[0];
      assert.equal(book.name, 'General Petty Cash');
      assert.equal(Number(book.float_amount), 100000);
      assert.equal(Number(book.current_balance), 0);
      assert.equal(book.is_active, true);
    });

    // 5. Erroneous transfer FT2611-0002 reversed
    await t.test('5. Fund transfer FT2611-0002 reversed with balanced reversal journal', async () => {
      const { rows: ftRows } = await client.query('SELECT * FROM fund_transfers WHERE id = $1', [c_ft_id]);
      assert.equal(ftRows.length, 1);
      assert.equal(ftRows[0].status, 'reversed');

      const { rows: origJe } = await client.query('SELECT * FROM journal_entries WHERE id = $1', [ftRows[0].journal_entry_id]);
      assert.equal(origJe[0].is_reversed, true);
      assert.ok(origJe[0].reversed_by_id);

      const { rows: revJe } = await client.query('SELECT * FROM journal_entries WHERE id = $1', [origJe[0].reversed_by_id]);
      assert.equal(revJe.length, 1);
      assert.equal(revJe[0].entry_number, 'REV-FT2611-0002');
      assert.equal(revJe[0].is_posted, true);
      assert.equal(Number(revJe[0].total_debit), 100000);
      assert.equal(Number(revJe[0].total_credit), 100000);

      const { rows: revLines } = await client.query(
        `SELECT jel.*, coa.code
         FROM journal_entry_lines jel
         JOIN chart_of_accounts coa ON coa.id = jel.account_id
         WHERE jel.journal_entry_id = $1
         ORDER BY jel.line_number`,
        [revJe[0].id]
      );
      assert.equal(revLines.length, 2);
      assert.equal(revLines[0].code, '1102');
      assert.equal(Number(revLines[0].credit), 100000);
      assert.equal(revLines[1].code, '111101');
      assert.equal(Number(revLines[1].debit), 100000);
    });

    // 6. Erroneous PC transaction PC-202610-030 rejected
    await t.test('6. Erroneous PC-202610-030 is rejected and explained', async () => {
      const { rows } = await client.query('SELECT * FROM petty_cash_transactions WHERE id = $1', [c_pc30_id]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].approval_status, 'rejected');
      assert.match(rows[0].rejection_reason, /Reversed: Linked fund transfer FT2611-0002/);
    });

    // 7. Salary advance outstanding and payroll readiness
    await t.test('7. Sandi salary advance outstanding is Rp 100,000 and references PV/26-26/028', async () => {
      const { rows } = await client.query(
        `SELECT id, voucher_number, amount, salary_advance_applied_amount,
                (amount - COALESCE(salary_advance_applied_amount, 0)) as outstanding_amount,
                salary_advance_status
         FROM payment_vouchers
         WHERE id = $1`,
        [c_pv028_id]
      );
      assert.equal(rows.length, 1);
      const adv = rows[0];
      assert.equal(Number(adv.amount), 100000);
      assert.equal(Number(adv.salary_advance_applied_amount), 0);
      assert.equal(Number(adv.outstanding_amount), 100000);
      assert.equal(adv.salary_advance_status, 'outstanding');
    });

    // 8. Genuine PV/26-26/023 and PV/26-26/032 preserved untouched
    await t.test('8. Genuine advances PV/26-26/023 and PV/26-26/032 remain untouched', async () => {
      const { rows: pv23 } = await client.query('SELECT * FROM payment_vouchers WHERE id = $1', [c_pv023_id]);
      assert.equal(pv23.length, 1);
      assert.equal(pv23[0].voucher_number, 'PV/26-26/023');
      assert.equal(Number(pv23[0].amount), 1000000);
      assert.equal(pv23[0].is_posted, true);

      const { rows: pv32 } = await client.query('SELECT * FROM payment_vouchers WHERE id = $1', [c_pv032_id]);
      assert.equal(pv32.length, 1);
      assert.equal(pv32[0].voucher_number, 'PV/26-26/032');
      assert.equal(Number(pv32[0].amount), 1000000);
      assert.equal(pv32[0].is_posted, true);
    });

    // 9. Idempotency and Audit Command Entry
    await t.test('9. Migration audit entry committed in finance_historical_repair_commands', async () => {
      const { rows } = await client.query(
        `SELECT * FROM finance_historical_repair_commands
         WHERE idempotency_key = 'sandi-pv028-petty-cash-salary-advance-final-20261121-v1'`,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'committed');
      assert.equal(rows[0].document_id, c_pv028_id);
    });

    // 10. GL 1102 positive balance
    await t.test('10. GL 1102 net balance remains positive', async () => {
      const { rows } = await client.query(`
        SELECT COALESCE(SUM(jel.debit - jel.credit), 0) as net
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        JOIN chart_of_accounts coa ON coa.id = jel.account_id
        WHERE coa.code = '1102' AND je.is_posted = true AND je.is_reversed = false
      `);
      assert.ok(Number(rows[0].net) >= 0, 'GL 1102 balance must be >= 0');
    });
  } finally {
    await client.end();
  }
});
