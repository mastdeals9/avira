import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from 'pg';
import {
  calculateCanonicalCashPayable,
  calculateExpenseReconciliation,
} from '../src/utils/taxCalculations.ts';

const expenseManagerSrc = fs.readFileSync('src/components/finance/ExpenseManager.tsx', 'utf8');

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL;

test('1. Salary fully settled by advance + remaining bank payment reconciles completely', () => {
  // EXP/26/285 verified case
  const expense = {
    voucher_number: 'EXP/26/285',
    expense_category: 'salary',
    amount: 2500000,
    paid_amount: 2500000,
    pph_amount: 0,
    salary_advance_applications: [
      { applied_amount: 500000 },
    ],
    bank_statement_lines: [
      {
        id: 'bsl-1',
        allocation_amount: 2000000,
        debit_amount: 2000000,
        credit_amount: 0,
      },
    ],
  };

  const grossPayable = calculateCanonicalCashPayable(expense);
  assert.equal(grossPayable, 2500000);

  const recon = calculateExpenseReconciliation(expense);
  assert.equal(recon.grossCashPayable, 2500000);
  assert.equal(recon.salaryAdvanceApplied, 500000);
  assert.equal(recon.netCashPayable, 2000000);
  assert.equal(recon.reconciledAmount, 2000000);
  assert.equal(recon.isFullyReconciled, true);
  assert.equal(recon.isPartiallyReconciled, false);
  assert.equal(recon.statusLabel, 'Paid / Reconciled');
});

test('2. List Recon indicator and detail panel share the authoritative reconciliation calculation', () => {
  // Verify ExpenseManager source binds both the list row and detail view to calculateExpenseReconciliation
  assert.match(expenseManagerSrc, /const recon = calculateExpenseReconciliation\(expense\);/);
  assert.match(expenseManagerSrc, /calculateExpenseReconciliation\(viewingExpense,\s*salaryAdvanceApplications\)/);
  assert.match(expenseManagerSrc, /const recon = calculateExpenseReconciliation\(exp\);/);

  // Both calculate using the same model
  const expense = {
    voucher_number: 'EXP/26/285',
    expense_category: 'salary',
    amount: 2500000,
    paid_amount: 2500000,
    bank_statement_lines: [{ allocation_amount: 2000000 }],
  };
  const listRecon = calculateExpenseReconciliation({
    ...expense,
    salary_advance_applications: [{ applied_amount: 500000 }],
  });
  const detailRecon = calculateExpenseReconciliation(expense, [{ applied_amount: 500000 }]);

  assert.equal(listRecon.isFullyReconciled, true);
  assert.equal(detailRecon.isFullyReconciled, true);
  assert.equal(listRecon.statusLabel, detailRecon.statusLabel);
  assert.equal(listRecon.netCashPayable, detailRecon.netCashPayable);
});

test('3. Genuine partial salary payment still displays partial/pending', () => {
  const partialExpense = {
    expense_category: 'salary',
    amount: 2500000,
    paid_amount: 1500000, // 500k advance + 1M partial bank payment
    salary_advance_applications: [{ applied_amount: 500000 }],
    bank_statement_lines: [{ allocation_amount: 1000000 }],
  };

  const recon = calculateExpenseReconciliation(partialExpense);
  assert.equal(recon.grossCashPayable, 2500000);
  assert.equal(recon.salaryAdvanceApplied, 500000);
  assert.equal(recon.netCashPayable, 2000000);
  assert.equal(recon.reconciledAmount, 1000000);
  assert.equal(recon.isFullyReconciled, false);
  assert.equal(recon.isPartiallyReconciled, true);
  assert.equal(recon.statusLabel, 'Partially Paid / Reconciled'); // Partially paid, partially reconciled

  // If marked paid in voucher but bank line is still partial
  const partialBankOnly = {
    expense_category: 'salary',
    amount: 2500000,
    paid_amount: 2500000,
    salary_advance_applications: [{ applied_amount: 500000 }],
    bank_statement_lines: [{ allocation_amount: 1000000 }],
  };
  const reconBankOnly = calculateExpenseReconciliation(partialBankOnly);
  assert.equal(reconBankOnly.isFullyReconciled, false);
  assert.equal(reconBankOnly.isPartiallyReconciled, true);
  assert.equal(reconBankOnly.statusLabel, 'Paid / Reconciliation Pending');
});

test('4. Fully matched bank line with zero remaining amount shows completed reconciliation', () => {
  const bankAmount = 2000000;
  const linkedAmount = 2000000;
  const remainingBankAmount = Math.max(0, bankAmount - linkedAmount);
  assert.equal(remainingBankAmount, 0);

  const expense = {
    expense_category: 'salary',
    amount: 2500000,
    paid_amount: 2500000,
    salary_advance_applications: [{ applied_amount: 500000 }],
    bank_statement_lines: [{ allocation_amount: linkedAmount, debit_amount: bankAmount }],
  };
  const recon = calculateExpenseReconciliation(expense);
  assert.equal(recon.isFullyReconciled, true);
  assert.equal(recon.statusLabel, 'Paid / Reconciled');
});

test('5. Split bank payments and multiple allocations are aggregated correctly', () => {
  const splitExpense = {
    expense_category: 'salary',
    amount: 2500000,
    paid_amount: 2500000,
    salary_advance_applications: [{ applied_amount: 500000 }],
    bank_statement_lines: [
      { id: 'b1', allocation_amount: 1200000 },
      { id: 'b2', allocation_amount: 800000 },
    ],
  };

  const recon = calculateExpenseReconciliation(splitExpense);
  assert.equal(recon.reconciledAmount, 2000000);
  assert.equal(recon.netCashPayable, 2000000);
  assert.equal(recon.isFullyReconciled, true);

  // Under-allocated split payment
  const underAllocated = {
    ...splitExpense,
    bank_statement_lines: [
      { id: 'b1', allocation_amount: 1200000 },
      { id: 'b2', allocation_amount: 700000 },
    ],
  };
  const underRecon = calculateExpenseReconciliation(underAllocated);
  assert.equal(underRecon.reconciledAmount, 1900000);
  assert.equal(underRecon.isFullyReconciled, false);
  assert.equal(underRecon.isPartiallyReconciled, true);
  assert.equal(underRecon.statusLabel, 'Paid / Reconciliation Pending');
});

test('6. Settled advance cannot be applied a second time to October salary in DB', async () => {
  if (!DB_CONNECTION) {
    console.warn('Skipping live database test: DATABASE_URL is not set.');
    return;
  }
  const client = new Client({ connectionString: DB_CONNECTION, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // Check PV/26-26/019 status and available balance
    const pvRes = await client.query(`
      SELECT pv.id, pv.voucher_number, pv.amount, pv.staff_id, pv.salary_advance_status,
             COALESCE(sum(sa.applied_amount), 0) AS applied_amount,
             greatest(pv.amount - COALESCE(sum(sa.applied_amount), 0), 0) AS available_amount
        FROM public.payment_vouchers pv
        LEFT JOIN public.salary_advance_applications sa ON sa.advance_payment_voucher_id = pv.id
       WHERE pv.voucher_number = 'PV/26-26/019'
       GROUP BY pv.id, pv.voucher_number, pv.amount, pv.staff_id, pv.salary_advance_status
    `);
    assert.equal(pvRes.rows.length, 1);
    const pv = pvRes.rows[0];
    assert.equal(Number(pv.amount), 500000);
    assert.equal(Number(pv.applied_amount), 500000);
    assert.equal(Number(pv.available_amount), 0);
    assert.equal(pv.salary_advance_status, 'settled');

    // Run get_outstanding_salary_advances for Sandi Prasetyo as of October 2026
    await client.query("SELECT set_config('request.jwt.claim.sub', '87d975a9-2a46-49a5-9014-f244d1140aba', false)");
    await client.query("SELECT set_config('request.jwt.claim.role', 'authenticated', false)");
    const outstandingRes = await client.query(`
      SELECT * FROM public.get_outstanding_salary_advances($1, '2026-10-31')
    `, [pv.staff_id]);

    // PV/26-26/019 MUST NOT be returned because it has 0 available amount
    const foundSettled = outstandingRes.rows.some(r => r.voucher_number === 'PV/26-26/019');
    assert.equal(foundSettled, false, 'PV/26-26/019 must not appear in outstanding advances for October');
  } finally {
    await client.end();
  }
});

test('7. New eligible advances remain explicitly selectable and are not auto-applied', () => {
  // UI contract: selectedSalaryAdvanceIds is empty on initial load of new expense
  assert.match(expenseManagerSrc, /setSelectedSalaryAdvanceIds\(current => current\.length \? \[\] : current\);/);
  // When saving new expense, only explicitly selected advances are passed
  assert.match(expenseManagerSrc, /if \(formData\.expense_category === 'salary' && selectedStaffId && selectedSalaryAdvanceIds\.length > 0\)/);
  assert.match(expenseManagerSrc, /p_advance_ids: selectedSalaryAdvanceIds/);
});

test('8. Historical live database accounting records are preserved without duplicates', async () => {
  if (!DB_CONNECTION) {
    console.warn('Skipping live database test: DATABASE_URL is not set.');
    return;
  }
  const client = new Client({ connectionString: DB_CONNECTION, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // EXP/26/285
    const expRes = await client.query(`
      SELECT id, voucher_number, amount, paid_amount, approval_status
        FROM public.finance_expenses
       WHERE voucher_number = 'EXP/26/285'
    `);
    assert.equal(expRes.rows.length, 1);
    const exp = expRes.rows[0];
    assert.equal(Number(exp.amount), 2500000);
    assert.equal(Number(exp.paid_amount), 2500000);
    assert.equal(exp.approval_status, 'approved');

    // Exactly 1 salary_advance_applications record
    const saRes = await client.query(`
      SELECT sa.id, sa.applied_amount, adv.voucher_number AS adv_vn, setl.voucher_number AS setl_vn
        FROM public.salary_advance_applications sa
        JOIN public.payment_vouchers adv ON adv.id = sa.advance_payment_voucher_id
        JOIN public.payment_vouchers setl ON setl.id = sa.settlement_payment_voucher_id
       WHERE sa.salary_expense_id = $1
    `, [exp.id]);
    assert.equal(saRes.rows.length, 1);
    assert.equal(Number(saRes.rows[0].applied_amount), 500000);
    assert.equal(saRes.rows[0].adv_vn, 'PV/26-26/019');
    assert.equal(saRes.rows[0].setl_vn, 'PV/26-26/021');

    // Exactly 1 bank statement allocation of 2,000,000
    const bslAllocRes = await client.query(`
      SELECT id, allocation_amount, payment_kind
        FROM public.bank_statement_allocations
       WHERE document_id = $1
    `, [exp.id]);
    assert.equal(bslAllocRes.rows.length, 1);
    assert.equal(Number(bslAllocRes.rows[0].allocation_amount), 2000000);

    // Bank statement line matched
    const bslRes = await client.query(`
      SELECT id, debit_amount, matching_status
        FROM public.bank_statement_lines
       WHERE matched_expense_id = $1
    `, [exp.id]);
    assert.equal(bslRes.rows.length, 1);
    assert.equal(Number(bslRes.rows[0].debit_amount), 2000000);
    assert.equal(bslRes.rows[0].matching_status, 'confirmed');

    // Journals: JE2609-0457, JE2610-0057, JE2610-0075
    const jRes = await client.query(`
      SELECT entry_number, is_posted, is_reversed,
             COALESCE(sum(jel.debit), 0) AS total_debit,
             COALESCE(sum(jel.credit), 0) AS total_credit
        FROM public.journal_entries je
        JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
       WHERE je.entry_number IN ('JE2609-0457', 'JE2610-0057', 'JE2610-0075')
       GROUP BY je.id, je.entry_number, je.is_posted, je.is_reversed
       ORDER BY je.entry_number
    `);
    assert.equal(jRes.rows.length, 3);
    jRes.rows.forEach(j => {
      assert.equal(j.is_posted, true, `${j.entry_number} must be posted`);
      assert.equal(j.is_reversed, false, `${j.entry_number} must not be reversed`);
      assert.equal(Number(j.total_debit), Number(j.total_credit), `${j.entry_number} must be balanced`);
    });
  } finally {
    await client.end();
  }
});
