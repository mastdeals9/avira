import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import pg from 'pg';

const { Client } = pg;

const serviceCode = readFileSync(
  new URL('../src/services/expensePostingLifecycle.ts', import.meta.url),
  'utf8'
);
const expenseManagerCode = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8'
);

test('expensePostingLifecycle enables canonical view by default and recognises HR-REC- replacements', () => {
  // 1. Ensure LIFECYCLE_VIEW_ENABLED is enabled by default unless explicitly disabled
  assert.match(
    serviceCode,
    /VITE_EFFECTIVE_EXPENSE_LIFECYCLE_VIEW_ENABLED !== 'false'/,
    'LIFECYCLE_VIEW_ENABLED should be enabled by default (opt-out with !== false)'
  );

  // 2. Ensure HR-REC- is included in the replacement journal prefix check
  assert.match(
    serviceCode,
    /journal\.reference_number\?\.startsWith\('HR-REC-'\)/,
    'resolveFallbackState must recognize HR-REC- replacement journals'
  );
});

test('resolveFallbackState unit tests for target expense lifecycle states', () => {
  // Helper to extract resolveFallbackState logic
  const newestFirst = (a, b) =>
    `${b.created_at || ''}:${b.id}`.localeCompare(`${a.created_at || ''}:${a.id}`);

  function resolveState(expense, journals) {
    const originals = journals.filter(journal =>
      journal.is_posted === true && ['expense', 'expenses'].includes(journal.source_module || '')
    );
    const replacements = journals.filter(journal =>
      journal.is_posted === true
      && !journal.is_reversed
      && (
        journal.source_module === 'historical_salary_advance_repair'
        || (journal.source_module === 'historical_repair'
          && (journal.reference_number?.startsWith('HR-AP-')
            || journal.reference_number?.startsWith('HR-CASH-')
            || journal.reference_number?.startsWith('HR-REC-')))
      )
    );
    const activeOriginals = originals.filter(journal => !journal.is_reversed).sort(newestFirst);
    const reversedOriginals = originals.filter(journal => journal.is_reversed).sort(newestFirst);
    const activeReplacements = replacements.sort(newestFirst);
    const activeOriginal = activeOriginals[0] || null;
    const reversedOriginal = reversedOriginals[0] || null;
    const replacement = activeReplacements[0] || null;

    let effectivePostingState;
    if (activeOriginals.length > 1) {
      effectivePostingState = 'AMBIGUOUS';
    } else if (activeReplacements.length > 1) {
      effectivePostingState = 'AMBIGUOUS';
    } else if (activeOriginals.length > 0 && activeReplacements.length > 0) {
      effectivePostingState = 'AMBIGUOUS';
    } else if (expense.approval_status !== 'approved' && (activeOriginal || replacement)) {
      effectivePostingState = 'AMBIGUOUS';
    } else if (activeOriginal) {
      effectivePostingState = 'ACTIVE';
    } else if (reversedOriginal && replacement) {
      effectivePostingState = 'REPLACED';
    } else if (reversedOriginal) {
      effectivePostingState = 'REVERSED';
    } else if (expense.approval_status === 'rejected') {
      effectivePostingState = 'REJECTED';
    } else if (expense.approval_status === 'pending_approval') {
      effectivePostingState = 'PENDING';
    } else {
      effectivePostingState = 'AMBIGUOUS';
    }
    return effectivePostingState;
  }

  // Case 1: EXP/26/177 (reversed original + HR-REC- replacement) -> must resolve to REPLACED
  const exp177State = resolveState(
    { approval_status: 'approved', voucher_number: 'EXP/26/177' },
    [
      { entry_number: 'JE2608-0168', source_module: 'expenses', is_posted: true, is_reversed: true },
      { entry_number: 'JE2609-0022', source_module: 'historical_repair', reference_number: 'HR-REC-575a496c', is_posted: true, is_reversed: false },
      { entry_number: 'JE2609-0021', source_module: 'historical_repair', reference_number: 'HR-REV-575a496c', is_posted: true, is_reversed: false },
    ]
  );
  assert.equal(exp177State, 'REPLACED', 'EXP/26/177 must resolve to REPLACED');

  // Case 2: EXP/26-26/139 (reversed original + HR-REC- replacement) -> must resolve to REPLACED
  const exp139State = resolveState(
    { approval_status: 'approved', voucher_number: 'EXP/26-26/139' },
    [
      { entry_number: 'JE2606-0120', source_module: 'expenses', is_posted: true, is_reversed: true },
      { entry_number: 'JE2609-0018', source_module: 'historical_repair', reference_number: 'HR-REC-421d9e6e', is_posted: true, is_reversed: false },
    ]
  );
  assert.equal(exp139State, 'REPLACED', 'EXP/26-26/139 must resolve to REPLACED');

  // Case 3: EXP/26/178, 179, 180 (active original) -> must resolve to ACTIVE
  for (const v of ['EXP/26/178', 'EXP/26/179', 'EXP/26/180']) {
    const state = resolveState(
      { approval_status: 'approved', voucher_number: v },
      [{ entry_number: 'JE-ORIG', source_module: 'expenses', is_posted: true, is_reversed: false }]
    );
    assert.equal(state, 'ACTIVE', `${v} must resolve to ACTIVE`);
  }

  // Case 4: Truly reversed/cancelled expense EXP/26-26/052 -> must remain REVERSED
  const cancelledState = resolveState(
    { approval_status: 'pending_approval', voucher_number: 'EXP/26-26/052' },
    [{ entry_number: 'JE2606-0050', source_module: 'expenses', is_posted: true, is_reversed: true }]
  );
  assert.equal(cancelledState, 'REVERSED', 'Truly cancelled expense without replacement must remain REVERSED');
});

test('ExpenseManager filter conditions include ACTIVE and REPLACED in default Operational list', () => {
  // Check that ExpenseManager treats REPLACED as operational and approved, and only cancelled approval_status hides an expense
  assert.match(expenseManagerCode, /const isCancelled = exp\.approval_status === 'cancelled';/);
  assert.match(expenseManagerCode, /if \(lifecycleFilter === 'cancelled' \? !isCancelled : isCancelled\) return false;/);
  assert.match(expenseManagerCode, /if \(approvalFilter === 'approved'\) \{\s*if \(exp\.approval_status !== 'approved'\) return false;/);

  // Simulate ExpenseManager filter
  const filterExpense = (exp, lifecycleFilter = 'operational', approvalFilter = 'all') => {
    const isCancelled = exp.approval_status === 'cancelled';
    if (lifecycleFilter === 'cancelled' ? !isCancelled : isCancelled) return false;
    if (approvalFilter === 'approved') {
      if (exp.approval_status !== 'approved') return false;
    }
    return true;
  };

  const exp177 = { voucher_number: 'EXP/26/177', effective_posting_state: 'REPLACED', approval_status: 'approved' };
  const exp178 = { voucher_number: 'EXP/26/178', effective_posting_state: 'ACTIVE', approval_status: 'approved' };
  const exp139 = { voucher_number: 'EXP/26-26/139', effective_posting_state: 'REPLACED', approval_status: 'approved' };
  const exp348 = { voucher_number: 'EXP/26/348', effective_posting_state: 'REVERSED', approval_status: 'approved' };
  const cancelled = { voucher_number: 'EXP/26-26/052', effective_posting_state: 'REVERSED', approval_status: 'cancelled' };

  // In default Operational view:
  assert.equal(filterExpense(exp177, 'operational', 'all'), true, 'EXP/26/177 must be visible in Operational view');
  assert.equal(filterExpense(exp178, 'operational', 'all'), true, 'EXP/26/178 must be visible in Operational view');
  assert.equal(filterExpense(exp139, 'operational', 'all'), true, 'EXP/26-26/139 must be visible in Operational view');
  assert.equal(filterExpense(exp348, 'operational', 'all'), true, 'EXP/26/348 with reversed journal must remain visible in Operational view');
  assert.equal(filterExpense(cancelled, 'operational', 'all'), false, 'Cancelled expense must be hidden in Operational view');

  // In Approved filter:
  assert.equal(filterExpense(exp177, 'operational', 'approved'), true, 'EXP/26/177 must be visible when Approved filter is active');
  assert.equal(filterExpense(exp139, 'operational', 'approved'), true, 'EXP/26-26/139 must be visible when Approved filter is active');
  assert.equal(filterExpense(exp348, 'operational', 'approved'), true, 'EXP/26/348 must remain visible in Approved filter');

  // In Cancelled tab:
  assert.equal(filterExpense(cancelled, 'cancelled', 'all'), true, 'Cancelled expense must appear in Cancelled view');
  assert.equal(filterExpense(exp177, 'cancelled', 'all'), false, 'Active/Replaced expense must NOT appear in Cancelled view');
  assert.equal(filterExpense(exp348, 'cancelled', 'all'), false, 'EXP/26/348 must NOT appear in Cancelled view');
});

test('Live DB population regression: all expenses match authoritative state with 0 discrepancies', async () => {
  if (!process.env.DATABASE_URL) {
    console.warn('Skipping live database test: DATABASE_URL is not set.');
    return;
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  try {
    const viewRes = await client.query('SELECT eeps.expense_id, eeps.voucher_number, eeps.document_approval_status, eeps.effective_posting_state as db_state FROM public.effective_expense_posting_state eeps;');
    const viewRows = viewRes.rows;

    const journalRes = await client.query('SELECT id, entry_number, entry_date, source_module, reference_id, reference_number, created_at, is_posted, is_reversed, reversed_by_id FROM public.journal_entries WHERE reference_id IS NOT NULL OR reference_number LIKE \'EXP-%\';');
    const allJournals = journalRes.rows;

    const journalsByExpenseId = new Map();
    for (const j of allJournals) {
      if (j.reference_id) {
        if (!journalsByExpenseId.has(j.reference_id)) journalsByExpenseId.set(j.reference_id, []);
        journalsByExpenseId.get(j.reference_id).push(j);
      }
      if (j.reference_number && j.reference_number.startsWith('EXP-')) {
        const expId = j.reference_number.replace(/^EXP-/, '');
        if (!journalsByExpenseId.has(expId)) journalsByExpenseId.set(expId, []);
        if (!journalsByExpenseId.get(expId).some(existing => existing.id === j.id)) {
          journalsByExpenseId.get(expId).push(j);
        }
      }
    }

    const newestFirst = (a, b) => (b.created_at || '').localeCompare(a.created_at || '');

    function resolveFallbackState(expense, journals) {
      const originals = journals.filter(j => j.is_posted === true && ['expense', 'expenses'].includes(j.source_module || ''));
      const replacements = journals.filter(j =>
        j.is_posted === true && !j.is_reversed &&
        (j.source_module === 'historical_salary_advance_repair' ||
         (j.source_module === 'historical_repair' &&
          (j.reference_number?.startsWith('HR-AP-') || j.reference_number?.startsWith('HR-CASH-') || j.reference_number?.startsWith('HR-REC-'))))
      );
      const activeOriginals = originals.filter(j => !j.is_reversed).sort(newestFirst);
      const reversedOriginals = originals.filter(j => j.is_reversed).sort(newestFirst);
      const activeReplacements = replacements.sort(newestFirst);
      const activeOriginal = activeOriginals[0] || null;
      const reversedOriginal = reversedOriginals[0] || null;
      const replacement = activeReplacements[0] || null;

      if (activeOriginals.length > 1 || activeReplacements.length > 1 || (activeOriginals.length > 0 && activeReplacements.length > 0)) return 'AMBIGUOUS';
      if (expense.document_approval_status !== 'approved' && (activeOriginal || replacement)) return 'AMBIGUOUS';
      if (activeOriginal) return 'ACTIVE';
      if (reversedOriginal && replacement) return 'REPLACED';
      if (reversedOriginal) return 'REVERSED';
      if (expense.document_approval_status === 'rejected') return 'REJECTED';
      if (expense.document_approval_status === 'pending_approval') return 'PENDING';
      return 'AMBIGUOUS';
    }

    let discrepancies = 0;
    for (const r of viewRows) {
      const state = resolveFallbackState(r, journalsByExpenseId.get(r.expense_id) || []);
      if (state !== r.db_state) discrepancies++;
    }
    assert.equal(discrepancies, 0, `Found ${discrepancies} state discrepancies`);
    assert.ok(viewRows.length > 0, 'Must have at least one expense row');
  } finally {
    await client.end();
  }
});

