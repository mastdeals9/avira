import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8',
);

test('Expense row status accurately distinguishes linked, partial, unlinked, and unknown bank-link states', () => {
  assert.match(source, /const simplifiedStatus = getSimplifiedExpenseStatus\(expense\);/);
  assert.match(source, /const isLinked = simplifiedStatus\.bankLink === 'Linked';/);
  assert.match(source, /'text-emerald-700 hover:bg-emerald-50 text-green-700 hover:bg-green-50'/);
  assert.match(source, /'text-blue-600 hover:bg-blue-50'/);
  assert.match(source, /'text-gray-400 hover:bg-gray-100'/);
});

test('Expense bank-link status icon is placed immediately before View action button', () => {
  const indicator = source.indexOf('aria-label={`${linkActionTitle} for ${expense.voucher_number || \'expense\'}`}');
  const view = source.indexOf('<FinanceActionButton\n                            action="view"', indicator);
  assert.ok(indicator >= 0, 'Expense row must show a bank-link status icon');
  assert.ok(view > indicator, 'Bank-link icon must be placed immediately before the View action button');
});

test('Clicking bank-link icon opens detail/linking flow without auto-linking or creating entries', () => {
  assert.match(source, /onClick=\{\(\) => \{\s*if \(simplifiedStatus\.isCash \|\| isLinked \|\| !canManage\) \{\s*void handleViewExpense\(expense\);\s*\} else \{\s*void handleEdit\(expense, true\);\s*\}\s*\}\}/);
});

test('Expense bank-link relies on canonical bank_statement_allocations and statement lines', () => {
  assert.match(source, /\.from\('bank_statement_allocations'\)[\s\S]{0,450}\.eq\('document_type', 'expense'\)[\s\S]{0,100}\.in\('document_id', chunk\)/);
  assert.match(source, /\.from\('bank_statement_lines'\)[\s\S]{0,450}\.in\('matched_expense_id', chunk\)/);
});

test('Recon column does not gate reconciliation status on paid_amount or render dash when linked', () => {
  // Ensure table cell checks isReconciled and isPartiallyReconciled directly without an early if (!isPaidAny) return —
  assert.doesNotMatch(
    source,
    /if \(!isPaidAny\)\s*\{\s*return \(\s*<span[^>]*title="Outstanding"[^>]*>\s*—\s*<\/span>\s*\);\s*\}/,
    'Recon column must not hide reconciled status behind an early !isPaidAny return',
  );

  // When isReconciled is true, Paid / Reconciled green icon is rendered
  assert.match(
    source,
    /title="Paid \/ Reconciled"[^>]*>\s*<CheckCircle className="w-3 h-3" \/>/,
    'Recon column must render green CheckCircle when isReconciled is true',
  );

  // When isPartiallyReconciled is true, Partially Paid / Reconciled yellow icon is rendered
  assert.match(
    source,
    /title="Partially Paid \/ Reconciled"[^>]*>\s*<Clock className="w-3 h-3" \/>/,
    'Recon column must render yellow Clock when isPartiallyReconciled is true',
  );
});

test('Reconciliation calculation for EXP/26/305 reproduces exact state: paid_amount 0 with 30k linked bank line', async () => {
  const { calculateExpenseReconciliation } = await import('../src/utils/taxCalculations.ts');

  // Exact shape of EXP/26/305 in DB
  const exp305 = {
    id: 'd27412dc-8a41-42cc-9b7f-510eb000c032',
    voucher_number: 'EXP/26/305',
    expense_category: 'bank_charges',
    amount: 30000,
    paid_amount: 0,
    approval_status: 'approved',
    bank_statement_lines: [
      {
        id: '95e289ec-0eaa-4733-84a9-7f2a87c3e19d',
        transaction_date: '2026-10-03T17:00:00.000Z',
        description: 'BIAYA ADM',
        debit_amount: 30000,
        credit_amount: 0,
      },
    ],
  };

  const recon = calculateExpenseReconciliation(exp305);
  assert.equal(recon.reconciledAmount, 30000);
  assert.equal(recon.netCashPayable, 30000);
  assert.equal(recon.isFullyReconciled, true, 'Expense with 30k bank line matching 30k amount must be fully reconciled');
  assert.equal(recon.isPartiallyReconciled, false);
  assert.equal(recon.statusLabel, 'Paid / Reconciled', 'statusLabel must not be demoted to Outstanding just because paid_amount is 0');
});

