import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from 'pg';

const linkFieldSrc = fs.readFileSync('src/components/finance/BankTransactionLinkField.tsx', 'utf8');
const expenseManagerSrc = fs.readFileSync('src/components/finance/ExpenseManager.tsx', 'utf8');
const financeCommandsSrc = fs.readFileSync('src/services/financeCommands.ts', 'utf8');

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL;

test('1. BankTransactionLinkField passes confirmedAllocation into onSelect', () => {
  assert.match(
    linkFieldSrc,
    /onSelect:\s*\(transaction:\s*BankTransactionLine,\s*allocationAmount\?:\s*number\)\s*=>/
  );
  assert.match(
    linkFieldSrc,
    /commitSelect\(selected,\s*confirmedAllocation\)/
  );
});

test('2. ExpenseManager accepts confirmedAmount and guards zero allocation fallback', () => {
  assert.match(
    expenseManagerSrc,
    /onSelect=\{async\s*\(transaction,\s*confirmedAmount\)\s*=>/
  );
  assert.match(
    expenseManagerSrc,
    /selectedBankAllocationAmount\s*&&\s*selectedBankAllocationAmount\s*>\s*0\.01/
  );
});

test('3. financeCommands guards allocationAmount <= 0.01 to null', () => {
  assert.match(
    financeCommandsSrc,
    /p_allocation_amount:\s*allocationAmount\s*&&\s*allocationAmount\s*>\s*0\.01\s*\?\s*allocationAmount\s*:\s*null/
  );
});

test('4. Live database verification for EXP/26/287 bank linking and accounting integrity', async () => {
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
    const expId = 'bb736f95-c026-42d5-9dc3-36c7768fd7f5';
    const bankLineId = '22055f06-5403-48ef-9054-74278cd2da17';

    // Verify expense
    const expRes = await client.query(
      `SELECT id, voucher_number, amount, paid_amount, settlement_amount, approval_status FROM finance_expenses WHERE id = $1`,
      [expId]
    );
    assert.equal(expRes.rows.length, 1);
    const exp = expRes.rows[0];
    assert.equal(exp.voucher_number, 'EXP/26/287');
    assert.equal(Number(exp.amount), 2500000);
    assert.equal(Number(exp.paid_amount), 2500000);
    assert.equal(Number(exp.settlement_amount), 2500000);
    assert.equal(exp.approval_status, 'approved');

    // Verify bank statement line
    const bankRes = await client.query(
      `SELECT id, debit_amount, matching_status, matched_expense_id, running_balance FROM bank_statement_lines WHERE id = $1`,
      [bankLineId]
    );
    assert.equal(bankRes.rows.length, 1);
    const bankLine = bankRes.rows[0];
    assert.equal(Number(bankLine.debit_amount), 2500000);
    assert.equal(bankLine.matching_status, 'confirmed');
    assert.equal(bankLine.matched_expense_id, expId);
    assert.equal(Number(bankLine.running_balance), 0);

    // Verify bank statement allocations
    const allocRes = await client.query(
      `SELECT id, bank_statement_line_id, document_id, allocation_amount, journal_entry_id FROM bank_statement_allocations WHERE document_id = $1`,
      [expId]
    );
    assert.equal(allocRes.rows.length, 1);
    assert.equal(Number(allocRes.rows[0].allocation_amount), 2500000);
    assert.equal(allocRes.rows[0].bank_statement_line_id, bankLineId);

    // Verify journals
    const jnlRes = await client.query(
      `SELECT id, entry_number, source_module, is_posted, is_reversed, total_debit, total_credit FROM journal_entries WHERE (reference_id = $1 OR reference_number = $2) AND is_reversed = false`,
      [expId, 'EXP/26/287']
    );
    // Should have expense accrual journal + 1 active payment journal
    assert.equal(jnlRes.rows.length, 2);
    for (const j of jnlRes.rows) {
      assert.equal(j.is_posted, true);
      assert.equal(j.is_reversed, false);
      assert.equal(Number(j.total_debit), 2500000);
      assert.equal(Number(j.total_credit), 2500000);
    }

    // Verify June advance settlement is untouched
    const juneRes = await client.query(
      `SELECT id, voucher_number, amount, paid_amount, settlement_amount FROM finance_expenses WHERE voucher_number = $1`,
      ['EXP/26-26/087']
    );
    assert.equal(juneRes.rows.length, 1);
    assert.equal(Number(juneRes.rows[0].amount), 2335000);
    assert.equal(Number(juneRes.rows[0].paid_amount), 2335000);

    const juneAdv = await client.query(
      `SELECT * FROM salary_advance_applications WHERE salary_expense_id = $1`,
      [juneRes.rows[0].id]
    );
    assert.equal(juneAdv.rows.length, 1);
    assert.equal(Number(juneAdv.rows[0].applied_amount), 500000);
  } finally {
    await client.end();
  }
});
