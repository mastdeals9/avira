import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  findExpenseCandidatesForBankLine,
  isCandidateAmbiguous,
  getExpenseOutstandingAmount,
  validateMatchPrerequisites,
  normalizePaymentKind,
} from '../src/components/finance/interactiveBankMatching.ts';

const projectRoot = resolve(process.cwd());
const migrationPath = resolve(
  projectRoot,
  'supabase/migrations/20261117173000_fix_bank_reconciliation_auto_match_and_canonical_allocation.sql'
);
const bankReconUiPath = resolve(
  projectRoot,
  'src/components/finance/BankReconciliationEnhanced.tsx'
);

test('0. Migration file exists and defines all required functions with search_path', () => {
  assert.ok(existsSync(migrationPath), 'Migration file must exist');
  const migration = readFileSync(migrationPath, 'utf8');

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.edit_approved_finance_expense_atomic/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.link_bank_statement_line/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.refresh_bank_statement_allocation_status/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.recalculate_expense_payment_state/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.auto_match_smart/);

  // Search path safety
  assert.match(migration, /SET search_path TO 'public', 'pg_temp'/);
  assert.match(migration, /SET search_path = public, pg_temp/);
});

test('1. One unique candidate auto-matches and creates a canonical allocation', () => {
  const bankLine = {
    id: 'bsl-1',
    date: '2026-11-13',
    debit: 900000,
    credit: 0,
    amount: 900000,
    description: 'BIAYA LISTRIK GUDANG FUAD',
    reference: 'EXP/26/375',
    currency: 'IDR',
    bank_account_id: 'bank-1',
  };

  const expenses = [
    {
      id: 'exp-375',
      voucher_number: 'EXP/26/375',
      expense_date: '2026-11-12',
      amount: 900000,
      paid_amount: 0,
      description: 'Electrical work in warehouse / Fuad',
      expense_category: 'repairs_maintenance',
      approval_status: 'approved',
      bank_account_id: 'bank-1',
      finance_staff_master: { full_name: 'Fuad' },
    },
    {
      id: 'exp-999',
      voucher_number: 'EXP/26/999',
      expense_date: '2026-11-01',
      amount: 5000000,
      paid_amount: 0,
      description: 'Rent',
      expense_category: 'rent',
      approval_status: 'approved',
      bank_account_id: 'bank-1',
    },
  ];

  const candidates = findExpenseCandidatesForBankLine(bankLine, expenses, 'bank-1');
  assert.equal(candidates.length, 1, 'Exactly one candidate must be identified');
  assert.equal(candidates[0].voucherNumber, 'EXP/26/375');
  assert.equal(isCandidateAmbiguous(candidates), false, 'Single candidate must not be marked ambiguous');

  // Verify migration enforces canonical allocation creation before incrementing matched_count
  const migration = readFileSync(migrationPath, 'utf8');
  assert.match(
    migration,
    /IF NOT EXISTS \(\s*SELECT 1 FROM public\.bank_statement_allocations[\s\S]*?WHERE bank_statement_line_id = v_line\.id/
  );
});

test('2. Two candidates trigger the interactive review queue/modal', () => {
  const bankLine = {
    id: 'bsl-2',
    date: '2026-11-13',
    debit: 2500,
    credit: 0,
    amount: 2500,
    description: 'BI-FAST DB BIAYA TXN KE 008 BERKAT KASIH BERSA KBB',
    reference: '',
    currency: 'IDR',
    bank_account_id: 'bank-1',
  };

  const expenses = [
    {
      id: 'exp-376',
      voucher_number: 'EXP/26/376',
      expense_date: '2026-11-13',
      amount: 2500,
      paid_amount: 0,
      description: 'BANK CHARGE PT DINAMIKA SEJAHTERA KBB',
      expense_category: 'bank_charges',
      approval_status: 'approved',
      bank_account_id: 'bank-1',
      suppliers: { company_name: 'PT DINAMIKA SEJAHTERA' },
    },
    {
      id: 'exp-381',
      voucher_number: 'EXP/26/381',
      expense_date: '2026-11-13',
      amount: 2500,
      paid_amount: 0,
      description: 'BI-FAST DB BIAYA TXN KE 008 BERKAT KASIH BERSA KBB',
      expense_category: 'bank_charges',
      approval_status: 'approved',
      bank_account_id: 'bank-1',
      suppliers: { company_name: 'BERKAT KASIH BERSAMA' },
    },
  ];

  const candidates = findExpenseCandidatesForBankLine(bankLine, expenses, 'bank-1');
  assert.equal(candidates.length, 2, 'Must identify both candidates for ambiguous Rp 2,500 bank charge');
  assert.equal(isCandidateAmbiguous(candidates), true, 'Two candidates must be flagged as ambiguous');

  // Candidate with payee in bank statement line has higher ranking (rank 2 vs rank 3)
  assert.equal(candidates[0].voucherNumber, 'EXP/26/381', 'Payee match should rank first');
  assert.equal(candidates[1].voucherNumber, 'EXP/26/376');
});

test('3. User selection links only the selected expense', () => {
  const bankLine = {
    id: 'bsl-2',
    date: '2026-11-13',
    debit: 2500,
    credit: 0,
    amount: 2500,
    remainingAmount: 2500,
  };

  const selectedExpense = {
    id: 'exp-381',
    voucher_number: 'EXP/26/381',
    amount: 2500,
    paid_amount: 0,
  };

  const validation = validateMatchPrerequisites(bankLine, selectedExpense, 2500);
  assert.equal(validation.valid, true);
  assert.equal(validation.allocAmount, 2500);

  // UI code must link only the chosen candidate ID and default selection must be empty
  const ui = readFileSync(bankReconUiPath, 'utf8');
  assert.match(ui, /setSelectedCandidateId\(''\)/, 'Selection must reset to empty');
  assert.match(ui, /<option value="">Choose an expense\.\.\.<\/option>/, 'Default option must be empty');
  assert.match(ui, /disabled=\{!selectedCandidateId/, 'Link button must be disabled without selection');
});

test('4. Skip leaves both candidate expenses and bank transaction untouched', () => {
  const ui = readFileSync(bankReconUiPath, 'utf8');

  // handleSkipCurrentCandidate adds line ID to skippedSessionLineIds and does not call linkBankStatementLine
  assert.match(
    ui,
    /const handleSkipCurrentCandidate = \(\) => \{[\s\S]*?setSkippedSessionLineIds\(\(?prev\)? => new Set\(prev\)\.add\(currentItem\.line\.id\)\);/
  );

  // handleSkipAllCandidates closes modal without mutating documents
  assert.match(
    ui,
    /const handleSkipAllCandidates = \(\) => \{[\s\S]*?setIsInteractiveModalOpen\(false\);/
  );
});

test('5. No-match case stays unmatched with explicit messaging and actions', () => {
  const bankLine = {
    id: 'bsl-nomatch',
    date: '2026-11-13',
    debit: 1234567,
    credit: 0,
    amount: 1234567,
    description: 'Unknown transaction with no matching expense',
    currency: 'IDR',
  };

  const expenses = [];
  const candidates = findExpenseCandidatesForBankLine(bankLine, expenses);
  assert.equal(candidates.length, 0, 'No candidate must be found');

  const ui = readFileSync(bankReconUiPath, 'utf8');
  assert.match(
    ui,
    /No matching expense found\. This transaction has been left unmatched\./,
    'Must display exact required no-match prompt'
  );
  assert.match(ui, /Search Expenses manually/);
  assert.match(ui, /Retry matching/);
});

test('6. Pending expense match does not auto-approve the expense', () => {
  const pendingExpense = {
    id: 'exp-pending',
    voucher_number: 'EXP/26/399',
    approval_status: 'pending_approval',
    amount: 1000000,
    paid_amount: 0,
    expense_date: '2026-11-12',
  };

  const line = {
    id: 'bsl-pending',
    date: '2026-11-12',
    debit: 1000000,
    amount: 1000000,
  };

  const candidates = findExpenseCandidatesForBankLine(line, [pendingExpense]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].approvalStatus, 'pending_approval');

  // Check UI implementation: updates originating_bank_statement_line_id and matched_expense_id
  // but DOES NOT change approval_status to 'approved'
  const ui = readFileSync(bankReconUiPath, 'utf8');
  assert.match(
    ui,
    /\.from\('finance_expenses'\)[\s\S]*?\.update\(\{\s*originating_bank_statement_line_id:\s*line\.id\s*\}\)/
  );
  assert.match(
    ui,
    /matching_status:\s*'suggested',\s*reconciliation_status:\s*'needs_review'/
  );
  assert.doesNotMatch(
    ui,
    /\.from\('finance_expenses'\)[\s\S]*?\.update\(\{[\s\S]*?approval_status:\s*'approved'/
  );
});

test('7. User-confirmed bank match does not require a second approval', () => {
  const ui = readFileSync(bankReconUiPath, 'utf8');
  assert.match(
    ui,
    /No second bank reconciliation approval is needed; ledger reconciliation will complete automatically when approved in Finance Expenses/
  );

  // Confirm match button in suggested modal is not disabled for pending approval
  assert.match(ui, /const cannotConfirm = isRejected;/);
});

test('8. Partial payment allocation works accurately', () => {
  const expense = {
    amount: 10000000,
    ppn_amount: 0,
    pph_amount: 0,
    paid_amount: 4000000, // 6,000,000 remaining
  };

  const outstanding = getExpenseOutstandingAmount(expense, 'supplier');
  assert.equal(outstanding, 6000000);

  const bankLine = {
    debit: 2000000, // Partial installment from bank
    remainingAmount: 2000000,
  };

  const validation = validateMatchPrerequisites(bankLine, expense, 2000000);
  assert.equal(validation.valid, true);
  assert.equal(validation.allocAmount, 2000000, 'Must allow allocating partial amount');

  // Excess allocation rejection
  const invalidBankLine = {
    debit: 10000000,
    remainingAmount: 10000000,
  };
  const invalidValidation = validateMatchPrerequisites(invalidBankLine, expense, 8000000);
  assert.equal(invalidValidation.valid, false, 'Must reject allocation exceeding document outstanding amount');
});

test('9. Duplicate candidate allocation is prevented (Universal Idempotency)', () => {
  const migration = readFileSync(migrationPath, 'utf8');
  assert.match(
    migration,
    /-- Universal Idempotency: Return existing allocation safely if already recorded[\s\S]*?IF EXISTS \(\s*SELECT 1 FROM public\.bank_statement_allocations a[\s\S]*?status', 'already_linked'/
  );
});

test('10. Manually unlinked records remain protected from auto-matching', () => {
  const migration = readFileSync(migrationPath, 'utf8');
  assert.match(
    migration,
    /AND NOT COALESCE\(b\.manually_unlinked, false\)/
  );

  const ui = readFileSync(bankReconUiPath, 'utf8');
  assert.match(
    ui,
    /if \(line\.manually_unlinked\) continue;/
  );
});

test('11. Actual allocation is verified before matched_count is incremented', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  // Section 1 verification
  assert.match(
    migration,
    /-- Strict Verification: Verify canonical allocation actually exists before counting as matched[\s\S]*?IF NOT EXISTS \(\s*SELECT 1 FROM public\.bank_statement_allocations[\s\S]*?v_skipped := v_skipped \+ 1;\s*CONTINUE;\s*END IF;\s*UPDATE public\.bank_statement_lines[\s\S]*?v_matched := v_matched \+ 1;/
  );

  // Section 2 verification
  assert.match(
    migration,
    /PERFORM public\.edit_approved_finance_expense_atomic\([\s\S]*?IF NOT EXISTS \(\s*SELECT 1 FROM public\.bank_statement_allocations[\s\S]*?document_type = 'expense'[\s\S]*?v_skipped := v_skipped \+ 1;\s*CONTINUE;\s*END IF;\s*UPDATE public\.bank_statement_lines[\s\S]*?v_matched := v_matched \+ 1;/
  );
});

// ============================================================================
// Payment Kind Safety & Document-Specific Preservation Regression Tests
// ============================================================================

test('12. Regression 1: Expense NULL / empty / unclassified becomes supplier', () => {
  assert.equal(normalizePaymentKind('expense', null), 'supplier');
  assert.equal(normalizePaymentKind('expense', ''), 'supplier');
  assert.equal(normalizePaymentKind('expense', '   '), 'supplier');
  assert.equal(normalizePaymentKind('expense', 'unclassified'), 'supplier');
  assert.equal(normalizePaymentKind('expense', 'supplier'), 'supplier');
  assert.equal(normalizePaymentKind('expense', 'operational'), 'supplier');
  assert.equal(normalizePaymentKind(null), 'supplier');
  assert.equal(normalizePaymentKind(''), 'supplier');
  assert.equal(normalizePaymentKind('unclassified'), 'supplier');

  const migration = readFileSync(migrationPath, 'utf8');
  assert.match(
    migration,
    /IF p_document_type = 'expense' THEN[\s\S]*?WHEN p_payment_kind = 'pph23' THEN 'pph23'[\s\S]*?WHEN p_payment_kind IS NULL OR btrim\(p_payment_kind\) = '' OR p_payment_kind = 'unclassified' THEN 'supplier'[\s\S]*?ELSE 'supplier'/
  );
});

test('13. Regression 2: Genuine PPh23 remains pph23', () => {
  assert.equal(normalizePaymentKind('expense', 'pph23'), 'pph23');
  assert.equal(normalizePaymentKind('pph23'), 'pph23');

  const expWithPph = {
    amount: 10000000,
    paid_amount: 0,
    pph_amount: 200000,
    pph_paid_amount: 50000,
  };

  const supplierOutstanding = getExpenseOutstandingAmount(expWithPph, 'supplier');
  const pphOutstanding = getExpenseOutstandingAmount(expWithPph, 'pph23');

  assert.equal(supplierOutstanding, 9800000, 'Supplier payable must be 10,000,000 - 200,000 (withheld PPh 23) = 9,800,000');
  assert.equal(pphOutstanding, 150000, 'PPh 23 payable must be 200,000 - 50,000 = 150,000');

  const migration = readFileSync(migrationPath, 'utf8');
  assert.match(
    migration,
    /ELSIF v_kind = 'pph23' THEN[\s\S]*?v_doc_total := COALESCE\(v_expense\.pph_amount, 0\);[\s\S]*?SELECT id INTO v_settlement_coa FROM public\.chart_of_accounts WHERE code = '2132' LIMIT 1;/
  );
  assert.match(
    migration,
    /bsa\.payment_kind='pph23'/
  );
});

test('14. Regression 3: Fund Transfer remains fund_transfer (never converted to supplier)', () => {
  assert.equal(normalizePaymentKind('fund_transfer', null), 'fund_transfer');
  assert.equal(normalizePaymentKind('fund_transfer', ''), 'fund_transfer');
  assert.equal(normalizePaymentKind('fund_transfer', 'fund_transfer'), 'fund_transfer');
  assert.equal(normalizePaymentKind('fund_transfer'), 'fund_transfer');

  const migration = readFileSync(migrationPath, 'utf8');

  // Verify link_bank_statement_line defaults fund_transfer to 'fund_transfer' and preserves custom kind
  assert.match(
    migration,
    /WHEN p_document_type = 'fund_transfer' THEN 'fund_transfer'/
  );

  // Negative assertion: Verify link_bank_statement_line does NOT indiscriminately convert non-PPh23 documents to supplier
  assert.doesNotMatch(
    migration,
    /v_kind := CASE\s*WHEN p_payment_kind = 'pph23' THEN 'pph23'\s*ELSE 'supplier'\s*END;/,
    'Must NOT contain unconditional non-pph23 to supplier conversion'
  );

  // Verify auto_match_smart Section 1 passes 'fund_transfer' for fund_transfer candidates
  assert.match(
    migration,
    /WHEN 'fund_transfer' THEN 'fund_transfer'/
  );
});

test('15. Regression 4: Receipt and Payment Voucher payment kinds remain unchanged', () => {
  // Receipt vouchers
  assert.equal(normalizePaymentKind('receipt', null), 'customer_receipt');
  assert.equal(normalizePaymentKind('receipt', ''), 'customer_receipt');
  assert.equal(normalizePaymentKind('receipt', 'customer_receipt'), 'customer_receipt');
  assert.equal(normalizePaymentKind('receipt'), 'customer_receipt');

  // Payment vouchers
  assert.equal(normalizePaymentKind('payment', null), 'supplier');
  assert.equal(normalizePaymentKind('payment', ''), 'supplier');
  assert.equal(normalizePaymentKind('payment', 'supplier'), 'supplier');
  assert.equal(normalizePaymentKind('payment', 'salary_advance'), 'salary_advance', 'Specialized payment kinds must be preserved');

  // Tax payments and petty cash
  assert.equal(normalizePaymentKind('tax_payment', null), 'tax');
  assert.equal(normalizePaymentKind('tax_payment', 'pph21'), 'pph21');
  assert.equal(normalizePaymentKind('petty_cash', null), 'petty_cash');
  assert.equal(normalizePaymentKind('journal', null), 'journal');

  const migration = readFileSync(migrationPath, 'utf8');
  assert.match(
    migration,
    /WHEN p_payment_kind IS NOT NULL AND btrim\(p_payment_kind\) <> '' THEN p_payment_kind[\s\S]*?WHEN p_document_type = 'receipt' THEN 'customer_receipt'[\s\S]*?WHEN p_document_type = 'payment' THEN 'supplier'[\s\S]*?WHEN p_document_type = 'tax_payment' THEN 'tax'[\s\S]*?WHEN p_document_type = 'petty_cash' THEN 'petty_cash'/
  );
});

test('16. Regression 5: Existing allocations are not duplicated (Universal Idempotency & Recalculation)', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  // Idempotency in link_bank_statement_line
  assert.match(
    migration,
    /IF EXISTS \(\s*SELECT 1 FROM public\.bank_statement_allocations a\s*WHERE a\.bank_statement_line_id = p_bank_line_id\s*AND a\.document_type = p_document_type\s*AND a\.document_id = p_document_id\s*AND a\.payment_kind = v_kind\s*\) THEN[\s\S]*?'status', 'already_linked'/
  );

  // Recalculation avoids double-counting allocations that already match posted voucher allocations
  assert.match(
    migration,
    /NOT EXISTS \(\s*SELECT 1\s*FROM public\.voucher_allocations va\s*JOIN public\.payment_vouchers pv ON pv\.id = va\.payment_voucher_id\s*WHERE va\.finance_expense_id = p_expense_id\s*AND pv\.is_posted = true\s*AND pv\.journal_entry_id = bsa\.journal_entry_id\s*\)/
  );
});

test('17. Regression 6: Contra linking continues working correctly', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  // link_bank_statement_line handles fund_transfer document type and extracts journal_entry_id
  assert.match(
    migration,
    /ELSIF p_document_type = 'fund_transfer' THEN\s*SELECT journal_entry_id INTO v_je FROM public\.fund_transfers WHERE id = p_document_id;/
  );

  // auto_match_smart Section 1 includes fund_transfer descriptions and documents
  assert.match(
    migration,
    /WHEN 'fund_transfer' THEN \(\s*SELECT ft\.description\s*FROM public\.fund_transfers ft\s*WHERE ft\.id = s\.document_id\s*\)/
  );
});
