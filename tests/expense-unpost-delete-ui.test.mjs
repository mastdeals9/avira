import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('ExpenseManager exposes visible Unpost and Delete actions with safe RPC guards', () => {
  const src = readFileSync(new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url), 'utf8');

  // 1. Unpost button is wired beside Edit/View for approved expenses with active posted journal
  assert.match(
    src,
    /expense\.approval_status === 'approved' && postingState === 'ACTIVE'[\s\S]*?<FinanceActionButton[\s\S]*?action="reverse"[\s\S]*?label="Unpost"[\s\S]*?handleCancelPostingRequest\(expense\)/
  );

  // 2. Unpost uses cancel_expense_posting RPC, requires reason, preserves journals, and marks cancelled
  assert.match(src, /supabase\.rpc\('cancel_expense_posting'/);
  assert.match(src, /disabled=\{!cancelPostingReason\.trim\(\) \|\| cancelPostingLoading\}/);
  assert.match(src, /marks the expense cancelled/);

  // 3. Delete button is visible for pending/rejected unposted expenses and uses delete_expense_safe
  assert.match(
    src,
    /\(postingState === 'PENDING' \|\| postingState === 'REJECTED'\)[\s\S]*?<FinanceActionButton[\s\S]*?action="delete"[\s\S]*?handleDelete\(expense\.id\)/
  );
  assert.match(src, /supabase\.rpc\('delete_expense_safe'/);
});
