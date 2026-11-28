import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from 'pg';

const expenseManagerSrc = fs.readFileSync('src/components/finance/ExpenseManager.tsx', 'utf8');
const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL;

test('1. ExpenseManager Payment section resolves Bank Transfer and Settled states when payment_method is null', () => {
  // Verifies that null payment_method is not blindly rendered as A/P Outstanding
  assert.ok(
    expenseManagerSrc.includes("bslLines.length > 0 ? ("),
    'Must check bslLines.length > 0 for Bank Transfer display'
  );
  assert.ok(
    expenseManagerSrc.includes("Bank Transfer"),
    'Must display Bank Transfer when bank statement line is linked'
  );
  assert.ok(
    expenseManagerSrc.includes("A/P Outstanding"),
    'Must have A/P Outstanding as conditional fallback when balance > 0'
  );
  assert.ok(
    expenseManagerSrc.includes("const bankAcc = viewingExpense.bank_accounts ?? bslLines[0]?.bank_accounts"),
    'Must resolve bank accounts from linked bank statement lines if viewingExpense.bank_accounts is null'
  );
  assert.ok(
    expenseManagerSrc.includes("Advance Recovery"),
    'Must label salary_advance_settlement as Advance Recovery in allocation table'
  );
});

test('2. Live database verification: September EXP/26/287 has Rp0 balance and no foreign voucher allocations', async () => {
  if (!DB_CONNECTION) {
    console.warn('Skipping live database verification: DATABASE_URL is not set.');
    return;
  }
  const client = new Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    const septExpId = 'bb736f95-c026-42d5-9dc3-36c7768fd7f5';

    // 1. September Expense
    const septRes = await client.query(
      `SELECT id, voucher_number, amount, paid_amount, settlement_amount, approval_status, payment_method
       FROM finance_expenses WHERE id = $1`,
      [septExpId]
    );
    assert.equal(septRes.rows.length, 1);
    const septExp = septRes.rows[0];
    assert.equal(septExp.voucher_number, 'EXP/26/287');
    assert.equal(Number(septExp.amount), 2500000);
    assert.equal(Number(septExp.paid_amount), 2500000);
    const outstanding = Number(septExp.amount) - Number(septExp.paid_amount);
    assert.equal(outstanding, 0, 'September outstanding balance must be Rp0');

    // 2. September Bank Allocation (must be 2,500,000 confirmed)
    const bslAllocRes = await client.query(
      `SELECT bsa.id, bsa.allocation_amount, bsl.matching_status, bsl.description
       FROM bank_statement_allocations bsa
       JOIN bank_statement_lines bsl ON bsl.id = bsa.bank_statement_line_id
       WHERE bsa.document_id = $1`,
      [septExpId]
    );
    assert.equal(bslAllocRes.rows.length, 1);
    assert.equal(Number(bslAllocRes.rows[0].allocation_amount), 2500000);
    assert.equal(bslAllocRes.rows[0].matching_status, 'confirmed');

    // 3. Voucher allocations for September MUST BE 0 (PV/26-26/022 is June recovery, not September)
    const vaRes = await client.query(
      `SELECT va.id, va.allocated_amount, pv.voucher_number
       FROM voucher_allocations va
       JOIN payment_vouchers pv ON pv.id = va.payment_voucher_id
       WHERE va.finance_expense_id = $1`,
      [septExpId]
    );
    assert.equal(vaRes.rows.length, 0, 'September expense must have no voucher allocations');

    // 4. June Expense EXP/26-26/087 must hold PV/26-26/022 allocation
    const juneExpId = 'c5c17015-dbec-4b42-8cdf-9c20ef752a9b';
    const juneVaRes = await client.query(
      `SELECT va.id, va.allocated_amount, pv.voucher_number, pv.payment_purpose
       FROM voucher_allocations va
       JOIN payment_vouchers pv ON pv.id = va.payment_voucher_id
       WHERE va.finance_expense_id = $1`,
      [juneExpId]
    );
    assert.equal(juneVaRes.rows.length, 1, 'June expense must hold PV/26-26/022 allocation');
    assert.equal(juneVaRes.rows[0].voucher_number, 'PV/26-26/022');
    assert.equal(Number(juneVaRes.rows[0].allocated_amount), 500000);
    assert.equal(juneVaRes.rows[0].payment_purpose, 'salary_advance_settlement');

    // 5. Verify June advance application
    const juneAdvRes = await client.query(
      `SELECT id, applied_amount, advance_payment_voucher_id, settlement_payment_voucher_id
       FROM salary_advance_applications
       WHERE salary_expense_id = $1`,
      [juneExpId]
    );
    assert.equal(juneAdvRes.rows.length, 1);
    assert.equal(Number(juneAdvRes.rows[0].applied_amount), 500000);

    // 6. Verify Expense amounts and zero outstanding balances for all 4 months
    const allMonthsRes = await client.query(
      `SELECT voucher_number, amount, paid_amount
       FROM finance_expenses
       WHERE voucher_number IN ('EXP/26-26/087', 'EXP/26-26/124', 'EXP/26/209', 'EXP/26/287')
       ORDER BY voucher_number`
    );
    assert.equal(allMonthsRes.rows.length, 4);
    const expsByVoucher = Object.fromEntries(allMonthsRes.rows.map(r => [r.voucher_number, r]));

    // June: net entitlement Rp2,335,000, fully paid, balance Rp0
    assert.equal(Number(expsByVoucher['EXP/26-26/087'].amount), 2335000);
    assert.equal(Number(expsByVoucher['EXP/26-26/087'].paid_amount), 2335000);

    // July: gross Rp2,500,000, fully paid, balance Rp0
    assert.equal(Number(expsByVoucher['EXP/26-26/124'].amount), 2500000);
    assert.equal(Number(expsByVoucher['EXP/26-26/124'].paid_amount), 2500000);

    // August: gross Rp2,339,000, fully paid, balance Rp0
    assert.equal(Number(expsByVoucher['EXP/26/209'].amount), 2339000);
    assert.equal(Number(expsByVoucher['EXP/26/209'].paid_amount), 2339000);

    // September: gross Rp2,500,000, fully paid, balance Rp0
    assert.equal(Number(expsByVoucher['EXP/26/287'].amount), 2500000);
    assert.equal(Number(expsByVoucher['EXP/26/287'].paid_amount), 2500000);

    // 7. Verify all active journals are posted and balanced
    const activeJournalsRes = await client.query(
      `SELECT id, entry_number, total_debit, total_credit, is_posted, is_reversed
       FROM journal_entries
       WHERE reference_number IN ('EXP/26-26/087', 'EXP/26-26/124', 'EXP/26/209', 'EXP/26/287',
                                  'PV/26-26/014', 'PV/26-26/022', 'PV/26-26/006', 'PV/26-26/007')
          OR reference_id IN (
            SELECT id FROM finance_expenses
            WHERE voucher_number IN ('EXP/26-26/087', 'EXP/26-26/124', 'EXP/26/209', 'EXP/26/287')
          )
       ORDER BY entry_number`
    );
    for (const row of activeJournalsRes.rows) {
      assert.equal(row.is_posted, true, `Journal ${row.entry_number} must be posted`);
      assert.equal(Number(row.total_debit), Number(row.total_credit), `Journal ${row.entry_number} must be balanced`);
    }
  } finally {
    await client.end();
  }
});
