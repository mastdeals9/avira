import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  calculateCanonicalCashPayable,
  calculateExpenseTotals,
  getSimplifiedExpenseStatus,
} from '../src/utils/taxCalculations.ts';
import { normalizeExpenseBankLinks } from '../src/utils/expenseBankLinks.ts';

const expenseManagerSrc = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8',
);

test('SAPJ ERP — Local Expense Stabilisation & Simplification Verification', async (t) => {
  await t.test('1. Issue 1: Expense with reversed journal remains accessible and is not cancelled', () => {
    // Static check in ExpenseManager: isCancelled must NOT be triggered by REVERSED
    assert.doesNotMatch(
      expenseManagerSrc,
      /const isCancelled = exp\.approval_status === 'cancelled' \|\| exp\.effective_posting_state === 'REVERSED';/,
      'Reversed journal must NOT mark the expense document as cancelled',
    );
    assert.match(
      expenseManagerSrc,
      /const isCancelled = exp\.approval_status === 'cancelled';/,
      'Only explicit approval_status === cancelled marks an expense as cancelled',
    );

    // Verify filter logic for EXP/26/348 scenario
    const exp348 = {
      id: 'exp-348-uuid',
      voucher_number: 'EXP/26/348',
      amount: 50000,
      paid_amount: 0,
      approval_status: 'approved',
      effective_posting_state: 'REVERSED', // original JE2611-0338 reversed by JE2611-0417
      payment_method: 'bank_transfer',
      bank_statement_lines: [],
    };

    // Filter function matching baseExpenses logic
    const isVisibleInOperational = (exp) => {
      const isCancelled = exp.approval_status === 'cancelled';
      const lifecycleFilter = 'operational';
      if (lifecycleFilter === 'cancelled' ? !isCancelled : isCancelled) return false;
      return true;
    };

    const isVisibleInApproved = (exp) => {
      if (!isVisibleInOperational(exp)) return false;
      return exp.approval_status === 'approved';
    };

    assert.equal(
      isVisibleInOperational(exp348),
      true,
      'EXP/26/348 must remain visible in Operational expenses after journal reversal',
    );
    assert.equal(
      isVisibleInApproved(exp348),
      true,
      'EXP/26/348 must remain visible in Approved filter after journal reversal',
    );

    // Standalone Cancel Posting action button is removed from normal table rows
    assert.doesNotMatch(
      expenseManagerSrc,
      /label="Cancel Posting"/,
      'Standalone Cancel Posting action button must be removed from normal expenses table rows',
    );
  });

  await t.test('2. Issue 2 & 4: Ricardo bank links (EXP/26/334, EXP/26/335) & Canonical Allocation Normalization', () => {
    // Single bank transaction of Rp 3,900,000 split across two expenses: EXP/26/334 and EXP/26/335
    const sharedStatementLine = {
      id: 'bsl-shared-line-id',
      raw_line_id: 'bsl-shared-line-id',
      transaction_date: '2026-11-04',
      description: 'BI-FAST DB BIAYA TXN KE 008 BERKAT KASIH BERSA KBB',
      reference: 'TXN-008-SHARED',
      debit_amount: 3900000,
      credit_amount: 0,
      bank_account_id: 'bca-idr-id',
      bank_accounts: { alias: 'BCA IDR', bank_name: 'Bank Central Asia', account_number: '1234567890', currency: 'IDR' },
    };

    // For EXP/26/334: canonical allocation of Rp 1,950,000
    const exp334CanonicalRow = {
      ...sharedStatementLine,
      allocation_id: 'alloc-334-id',
      allocation_amount: 1950000,
      payment_kind: 'supplier',
    };

    // Normalize allocations for EXP/26/334
    const normalized334 = normalizeExpenseBankLinks([exp334CanonicalRow]);
    assert.equal(normalized334.length, 1);
    assert.equal(normalized334[0].allocation_amount, 1950000, 'EXP/26/334 must show individual allocation amount Rp 1,950,000');
    assert.equal(normalized334[0].debit_amount, 3900000, 'Original statement line debit amount must be preserved');
    assert.equal(normalized334[0].bank_accounts.alias, 'BCA IDR', 'Bank account alias must be preserved');
    assert.equal(normalized334[0].transaction_date, '2026-11-04', 'Actual transaction date must be preserved');

    // Canonical allocation takes precedence over legacy line to prevent double counting
    const legacyRow = {
      ...sharedStatementLine,
      allocation_id: null,
      allocation_amount: 3900000,
    };
    const deduplicated = normalizeExpenseBankLinks([legacyRow, exp334CanonicalRow]);
    assert.equal(deduplicated.length, 1, 'Canonical allocation and legacy line for same statement line must not be double counted');
    assert.equal(deduplicated[0].allocation_amount, 1950000, 'Canonical allocation amount must win over full statement line amount');

    // Status check for EXP/26/334: must be 'Linked' and never 'Not linked'
    const exp334 = {
      id: 'exp-334-uuid',
      voucher_number: 'EXP/26/334',
      amount: 1950000,
      paid_amount: 1950000,
      approval_status: 'approved',
      payment_method: 'bank_transfer',
      bank_statement_lines: normalized334,
    };
    const status334 = getSimplifiedExpenseStatus(exp334);
    assert.equal(status334.bankLink, 'Linked', 'EXP/26/334 must be marked as Linked');
    assert.equal(status334.payment, 'Paid', 'EXP/26/334 must be marked as Paid');
    assert.equal(status334.approval, 'Approved', 'EXP/26/334 must be marked as Approved');
  });

  await t.test('3. Issue 3: Standardized 3-Axis Status Model', () => {
    // A. Unpaid expense
    const unpaid = {
      amount: 1000000,
      paid_amount: 0,
      approval_status: 'pending_approval',
      payment_method: 'bank_transfer',
      bank_statement_lines: [],
    };
    const sUnpaid = getSimplifiedExpenseStatus(unpaid);
    assert.equal(sUnpaid.approval, 'Pending');
    assert.equal(sUnpaid.payment, 'Unpaid');
    assert.equal(sUnpaid.bankLink, 'Unlinked');

    // B. Partially paid expense without bank link (e.g. advance applied)
    const partialNoBank = {
      amount: 1000000,
      paid_amount: 400000,
      approval_status: 'approved',
      payment_method: 'bank_transfer',
      bank_statement_lines: [],
    };
    const sPartial = getSimplifiedExpenseStatus(partialNoBank);
    assert.equal(sPartial.approval, 'Approved');
    assert.equal(sPartial.payment, 'Partially Paid');
    assert.equal(sPartial.bankLink, 'Unlinked', 'paid_amount alone must NOT be treated as proof of bank linkage');

    // C. Paid expense via bank transfer with canonical link
    const paidBank = {
      amount: 2500000,
      paid_amount: 2500000,
      approval_status: 'approved',
      payment_method: 'bank_transfer',
      bank_statement_lines: [
        { id: 'b1', allocation_id: 'a1', allocation_amount: 2500000, debit_amount: 2500000, credit_amount: 0 },
      ],
    };
    const sPaidBank = getSimplifiedExpenseStatus(paidBank);
    assert.equal(sPaidBank.approval, 'Approved');
    assert.equal(sPaidBank.payment, 'Paid');
    assert.equal(sPaidBank.bankLink, 'Linked');

    // D. Cash / Petty Cash expense: never shows bank recon warning
    const cashExp = {
      amount: 150000,
      paid_amount: 150000,
      approval_status: 'approved',
      payment_method: 'petty_cash',
      bank_statement_lines: [],
    };
    const sCash = getSimplifiedExpenseStatus(cashExp);
    assert.equal(sCash.isCash, true);
    assert.equal(sCash.bankLink, 'Cash');
    assert.equal(sCash.payment, 'Paid');
  });

  await t.test('4. Issue 4: Detail View and Refresh Safety', () => {
    // Verify fetchExpenseBankLinks is implemented and awaited in handleViewExpense
    assert.match(
      expenseManagerSrc,
      /const fetchExpenseBankLinks = async \(expenseId: string\)/,
      'fetchExpenseBankLinks function must be defined',
    );
    assert.match(
      expenseManagerSrc,
      /bankLines = await fetchExpenseBankLinks\(expense\.id\);/,
      'handleViewExpense must await fetchExpenseBankLinks before displaying modal',
    );
    assert.match(
      expenseManagerSrc,
      /bank_allocations_expmgr/,
      'Realtime channel must listen to bank_statement_allocations changes',
    );
    assert.match(
      expenseManagerSrc,
      /setBankLinkError/,
      'Detail view must capture and display bank link errors if fetch fails',
    );
  });
});
