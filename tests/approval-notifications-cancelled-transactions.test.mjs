import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import test from 'node:test';

const approvalNotifications = readFileSync(
  new URL('../src/components/ApprovalNotifications.tsx', import.meta.url),
  'utf8',
);
const dashboard = readFileSync(new URL('../src/pages/Dashboard.tsx', import.meta.url), 'utf8');
const expenseManager = readFileSync(new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../supabase/migrations/20260907150000_normalize_cancelled_expenses_approval_status.sql', import.meta.url),
  'utf8',
);

test('ApprovalNotifications excludes cancelled and reversed expenses from pending approvals', () => {
  assert.match(
    approvalNotifications,
    /import\s*\{\s*getEffectiveExpensePostingStates\s*\}\s*from\s*['"]\.\.\/services\/expensePostingLifecycle['"]/,
  );
  assert.match(approvalNotifications, /lifecycle\.effective_posting_state === 'REVERSED'/);
  assert.match(approvalNotifications, /lifecycle\.document_approval_status === 'cancelled'/);
});

test('Dashboard queries effective_expense_posting_state for PENDING lifecycle state', () => {
  assert.match(dashboard, /\.from\('effective_expense_posting_state'\)/);
  assert.match(dashboard, /\.eq\('effective_posting_state',\s*'PENDING'\)/);
});

test('ExpenseManager pending filter excludes reversed posting state', () => {
  assert.match(expenseManager, /exp\.approval_status !== 'pending_approval' \|\| exp\.effective_posting_state === 'REVERSED'/);
});

test('Migration normalizes cancelled expenses', () => {
  assert.match(migration, /UPDATE public\.finance_expenses/);
  assert.match(migration, /SET approval_status = 'cancelled'/);
  assert.match(migration, /EXP\/26-26\/052/);
});

test('Live DB verification: EXP/26-26/052 is cancelled and 0 pending expenses remain', () => {
  const query = `
    SELECT fe.voucher_number, fe.approval_status, eep.effective_posting_state
    FROM finance_expenses fe
    LEFT JOIN effective_expense_posting_state eep ON eep.expense_id = fe.id
    WHERE fe.voucher_number = 'EXP/26-26/052';
  `;
  const result = execSync(`supabase db query --linked "${query.trim().replace(/\n/g, ' ')}"`, {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.match(result, /"approval_status": "cancelled"/);
  assert.match(result, /"effective_posting_state": "REVERSED"/);

  const pendingCancelledQuery = `
    SELECT count(*) as count FROM finance_expenses fe
    JOIN effective_expense_posting_state eep ON eep.expense_id = fe.id
    WHERE fe.approval_status = 'pending_approval'
      AND eep.effective_posting_state IN ('CANCELLED', 'REVERSED');
  `;
  const pendingResult = execSync(`supabase db query --linked "${pendingCancelledQuery.trim().replace(/\n/g, ' ')}"`, {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.match(pendingResult, /"count": 0/);
});
