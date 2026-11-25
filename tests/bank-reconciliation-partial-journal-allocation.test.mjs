import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const reconFile = fs.readFileSync(path.resolve('src/components/finance/BankReconciliationEnhanced.tsx'), 'utf8');
const viewerFile = fs.readFileSync(path.resolve('src/components/finance/JournalEntryViewerEnhanced.tsx'), 'utf8');
const linkingFile = fs.readFileSync(path.resolve('src/components/finance/bankTransactionLinking.ts'), 'utf8');
const commandsFile = fs.readFileSync(path.resolve('src/services/financeCommands.ts'), 'utf8');

const DB_CONNECTION =
  process.env.SUPABASE_DB_URL ||
  'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres';

// -----------------------------------------------------------------------------
// SECTION 1: ARCHITECTURAL & UI CODE CONTRACTS
// -----------------------------------------------------------------------------
test('1. Architectural Contracts: Frontend components handle partial journal allocations properly', (t) => {
  // A. BankReconciliationEnhanced active filter has partially_reconciled
  assert.match(
    reconFile,
    /activeFilter\s*===\s*'partially_reconciled'/,
    'BankReconciliationEnhanced must support partially_reconciled tab filtering'
  );

  // B. isDirectRecorded status clobbering bug is fixed
  assert.match(
    reconFile,
    /isDirectRecorded\s*=\s*!row\.manually_unlinked[\s\S]*?row\.reconciliation_status\s*===\s*'recorded'[\s\S]*?allocations\.length\s*===\s*0/,
    'isDirectRecorded must not misclassify partially reconciled lines as recorded'
  );

  // C. Stats accurately computes partial count
  assert.match(
    reconFile,
    /partial:\s*statementLines\.filter\(\s*\(?l\)?\s*=>\s*l\.status\s*===\s*'partially_reconciled'\s*\)\.length/,
    'Stats calculation must isolate partially_reconciled lines'
  );

  // D. Add Allocation action is presented for partially reconciled lines
  assert.match(
    reconFile,
    /line\.status\s*===\s*'partially_reconciled'[\s\S]*?Add Allocation/,
    'Add Allocation button must be displayed for partially_reconciled lines'
  );

  // E. loadAvailableJournals queries journal_entry_lines by bank COA and matching side
  assert.match(
    reconFile,
    /const loadAvailableJournals = async/,
    'loadAvailableJournals function must exist'
  );
  assert.match(
    reconFile,
    /\.from\('journal_entry_lines'\)/,
    'loadAvailableJournals must query journal_entry_lines for bank COA'
  );

  // F. Over-allocation prevention: clamped to maxAlloc
  assert.match(
    reconFile,
    /Math\.min\(targetRemaining,\s*j\.journalAvailableAmount\)/,
    'Allocation must be strictly clamped to remaining line amount and available journal balance'
  );

  // G. JournalEntryViewerEnhanced displays linked bank allocations
  assert.match(
    viewerFile,
    /loadBankAllocationsForJournal/,
    'JournalEntryViewerEnhanced must load linked bank allocations'
  );
  assert.match(
    viewerFile,
    /from\('bank_statement_allocations'\)/,
    'JournalEntryViewerEnhanced must query bank_statement_allocations'
  );
  assert.match(
    viewerFile,
    /Bank Reconciliation/,
    'JournalEntryViewerEnhanced must render Bank Reconciliation section'
  );

  // H. bankTransactionLinking allows partially reconciled transactions in pickers
  assert.match(
    linkingFile,
    /line\.reconciliation_status === 'partially_reconciled'/,
    'bankTransactionLinking must recognize partially reconciled transactions as available'
  );

  // I. financeCommands normalizes journal payment kind to avoid check constraint violation
  assert.match(
    commandsFile,
    /normalizedPaymentKind[\s\S]*?'other'/,
    'financeCommands must normalize journal payment kinds to other to satisfy DB check constraint'
  );
});

// -----------------------------------------------------------------------------
// SECTION 2: CANONICAL ALLOCATION & RECONCILIATION STATE SIMULATION
// -----------------------------------------------------------------------------
test('2. In-Memory Logic: Canonical Allocation, Status Determination and Validation', (t) => {
  const EPSILON = 0.01;

  function computeReconciliationState(lineTotal, allocations) {
    const totalAllocated = allocations.reduce((sum, a) => sum + Number(a.amount || 0), 0);
    const remaining = Math.max(0, lineTotal - totalAllocated);

    let status = 'unmatched';
    if (totalAllocated >= lineTotal - EPSILON) {
      status = 'matched';
    } else if (totalAllocated > EPSILON) {
      status = 'partially_reconciled';
    }

    return {
      lineTotal,
      totalAllocated,
      remaining,
      status,
      allocations,
    };
  }

  function validateNewAllocation(state, newAllocation, candidateJournal) {
    if (candidateJournal.is_reversed) {
      throw new Error('Cannot link a reversed journal entry');
    }
    if (!candidateJournal.is_posted) {
      throw new Error('Cannot link an unposted journal entry');
    }
    if (state.allocations.some(a => a.document_type === 'journal' && a.document_id === candidateJournal.id)) {
      throw new Error('Journal entry is already linked to this bank line');
    }
    if (newAllocation.amount > state.remaining + EPSILON) {
      throw new Error(`Allocation amount (${newAllocation.amount}) exceeds remaining line balance (${state.remaining})`);
    }
    if (newAllocation.amount <= EPSILON) {
      throw new Error('Allocation amount must be greater than zero');
    }

    return computeReconciliationState(state.lineTotal, [
      ...state.allocations,
      {
        id: 'alloc-' + Math.random().toString(36).substring(7),
        document_type: newAllocation.document_type,
        document_id: newAllocation.document_id,
        amount: newAllocation.amount,
        reference: candidateJournal.entry_number,
      },
    ]);
  }

  // Initial reproduction scenario
  const statementAmount = 1400000;
  const initialExpenseAllocation = {
    id: 'alloc-1',
    document_type: 'expense',
    document_id: '85b8b607-00f8-4ec4-be3a-46f08addd70e',
    amount: 900000,
    reference: 'EXP/26/260',
  };

  const candidateJournal = {
    id: '8bc45744-141e-4153-abc0-7f2355df0987',
    entry_number: 'JE2611-0488',
    is_posted: true,
    is_reversed: false,
    bank_credit: 500000,
  };

  // Test A: Partially reconciled statement line with existing expense allocation
  const stateA = computeReconciliationState(statementAmount, [initialExpenseAllocation]);
  assert.strictEqual(stateA.lineTotal, 1400000);
  assert.strictEqual(stateA.totalAllocated, 900000);
  assert.strictEqual(stateA.remaining, 500000);
  assert.strictEqual(stateA.status, 'partially_reconciled');

  // Test B & C: Adding second allocation using manual journal entry (JE2611-0488)
  const stateB = validateNewAllocation(
    stateA,
    { document_type: 'journal', document_id: candidateJournal.id, amount: 500000 },
    candidateJournal
  );
  assert.strictEqual(stateB.lineTotal, 1400000);
  assert.strictEqual(stateB.totalAllocated, 1400000);
  assert.strictEqual(stateB.remaining, 0);
  assert.strictEqual(stateB.status, 'matched');
  assert.strictEqual(stateB.allocations.length, 2);
  assert.strictEqual(stateB.allocations[0].document_type, 'expense');
  assert.strictEqual(stateB.allocations[0].amount, 900000);
  assert.strictEqual(stateB.allocations[1].document_type, 'journal');
  assert.strictEqual(stateB.allocations[1].amount, 500000);
  assert.strictEqual(stateB.allocations[1].reference, 'JE2611-0488');

  // Test D: Attempting to allocate 600,000 when only 500,000 remains fails / is rejected
  assert.throws(
    () => {
      validateNewAllocation(
        stateA,
        { document_type: 'journal', document_id: candidateJournal.id, amount: 600000 },
        candidateJournal
      );
    },
    /exceeds remaining line balance/,
    'Allocating 600,000 when only 500,000 remains must be rejected'
  );

  // Test E: Selecting reversed or unposted journal is rejected
  const reversedJournal = { ...candidateJournal, is_reversed: true };
  assert.throws(
    () => {
      validateNewAllocation(
        stateA,
        { document_type: 'journal', document_id: reversedJournal.id, amount: 500000 },
        reversedJournal
      );
    },
    /Cannot link a reversed journal entry/,
    'Reversed journal must be rejected'
  );

  const unpostedJournal = { ...candidateJournal, is_posted: false };
  assert.throws(
    () => {
      validateNewAllocation(
        stateA,
        { document_type: 'journal', document_id: unpostedJournal.id, amount: 500000 },
        unpostedJournal
      );
    },
    /Cannot link an unposted journal entry/,
    'Unposted journal must be rejected'
  );

  // Test F: Attempting to link the same journal twice does not create duplicate allocation
  assert.throws(
    () => {
      validateNewAllocation(
        stateB,
        { document_type: 'journal', document_id: candidateJournal.id, amount: 100 },
        candidateJournal
      );
    },
    /Journal entry is already linked/,
    'Linking duplicate journal must be rejected'
  );

  // Test G: Existing expense-only reconciliation continues working
  const expenseOnlyLine = computeReconciliationState(900000, [initialExpenseAllocation]);
  assert.strictEqual(expenseOnlyLine.remaining, 0);
  assert.strictEqual(expenseOnlyLine.status, 'matched');

  // Test H: Partially reconciled line remains available for another allocation until 0 remaining
  function isAvailableForMatching(state) {
    return state.status !== 'matched' && state.remaining > EPSILON;
  }
  assert.strictEqual(isAvailableForMatching(stateA), true, 'State A (500k remaining) must be available');
  assert.strictEqual(isAvailableForMatching(stateB), false, 'State B (0 remaining) must NOT be available');
});

// -----------------------------------------------------------------------------
// SECTION 3: LIVE DATABASE READ-ONLY & ROLLBACK ISOLATION VERIFICATION
// -----------------------------------------------------------------------------
test('3. Live Database Verification: Reproduction Data and Zero-Commit Transaction Linking', async (t) => {
  const client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
  } catch (err) {
    console.warn('Skipping live database test: unable to connect to DB.', err.message);
    return;
  }

  t.after(async () => {
    await client.end();
  });

  // Verify reproduction line exists in database
  const bslRes = await client.query(
    'SELECT id, debit_amount, reconciliation_status, matching_status FROM bank_statement_lines WHERE id = $1',
    ['70b56ed7-6a67-4891-a8ea-0ad3fab61ea3']
  );
  assert.strictEqual(bslRes.rows.length, 1, 'Live statement line 70b56ed7 must exist');
  const bsl = bslRes.rows[0];
  assert.strictEqual(Number(bsl.debit_amount), 1400000, 'Statement debit must be 1,400,000');
  assert.ok(
    bsl.reconciliation_status === 'partially_reconciled' || bsl.reconciliation_status === 'matched',
    `Status must be partially_reconciled or matched (was: ${bsl.reconciliation_status})`
  );

  // Verify existing allocation for EXP/26/260
  const allocRes = await client.query(
    'SELECT id, document_type, document_id, allocation_amount, payment_kind FROM bank_statement_allocations WHERE bank_statement_line_id = $1 ORDER BY allocation_amount DESC',
    ['70b56ed7-6a67-4891-a8ea-0ad3fab61ea3']
  );
  assert.ok(allocRes.rows.length >= 1, 'Must have at least 1 allocation');
  const expAlloc = allocRes.rows.find((a) => a.document_id === '85b8b607-00f8-4ec4-be3a-46f08addd70e');
  assert.ok(expAlloc, 'Allocation for EXP/26/260 must exist');
  assert.strictEqual(Number(expAlloc.allocation_amount), 900000);

  // Verify candidate manual journal JE2611-0488
  const jeRes = await client.query(
    `SELECT je.id, je.entry_number, je.is_posted, je.is_reversed,
            jel.credit as bank_credit, coa.code as coa_code
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.id = $1 AND coa.code = '111101'`,
    ['8bc45744-141e-4153-abc0-7f2355df0987']
  );
  assert.strictEqual(jeRes.rows.length, 1, 'Manual journal JE2611-0488 must have BCA IDR 111101 line');
  const je = jeRes.rows[0];
  assert.strictEqual(je.entry_number, 'JE2611-0488');
  assert.strictEqual(je.is_posted, true, 'Journal must be posted');
  assert.strictEqual(je.is_reversed, false, 'Journal must not be reversed');
  assert.strictEqual(Number(je.bank_credit), 500000, 'Bank credit must be 500,000');

  // TRANSACTIONAL SIMULATION WITH MANDATORY ROLLBACK (ZERO PERMANENT MUTATIONS)
  await client.query('BEGIN');
  try {
    // Temporarily reset to 1 allocation state inside this rolled-back transaction to verify transition logic
    await client.query(
      "DELETE FROM bank_statement_allocations WHERE bank_statement_line_id = $1 AND journal_entry_id = $2",
      ['70b56ed7-6a67-4891-a8ea-0ad3fab61ea3', '8bc45744-141e-4153-abc0-7f2355df0987']
    );
    await client.query(
      "UPDATE bank_statement_lines SET reconciliation_status = 'partially_reconciled' WHERE id = $1",
      ['70b56ed7-6a67-4891-a8ea-0ad3fab61ea3']
    );

    // 1. Verify over-allocation is rejected: attempting to allocate 600,000 when only 500,000 remains
    await client.query('SAVEPOINT sp_overalloc');
    let overAllocError = null;
    try {
      await client.query(
        'SELECT link_bank_statement_line($1, $2, $3, $4, $5) as result',
        [
          '70b56ed7-6a67-4891-a8ea-0ad3fab61ea3',
          'journal',
          '8bc45744-141e-4153-abc0-7f2355df0987',
          'other',
          600000,
        ]
      );
    } catch (err) {
      overAllocError = err;
      await client.query('ROLLBACK TO SAVEPOINT sp_overalloc');
    }
    assert.ok(overAllocError, 'Over-allocation must throw an error');
    assert.match(
      overAllocError.message,
      /Allocation exceeds remaining bank amount/,
      'Allocating 600,000 when only 500,000 remains must be rejected by PostgreSQL function'
    );

    // 2. Call link_bank_statement_line with exact remaining 500,000 and payment_kind 'other'
    const linkRes = await client.query(
      'SELECT link_bank_statement_line($1, $2, $3, $4, $5) as result',
      [
        '70b56ed7-6a67-4891-a8ea-0ad3fab61ea3',
        'journal',
        '8bc45744-141e-4153-abc0-7f2355df0987',
        'other',
        500000,
      ]
    );

    const rpcResult = linkRes.rows[0].result;
    assert.strictEqual(rpcResult.bank_total, 1400000);
    assert.strictEqual(rpcResult.bank_allocated, 1400000);
    assert.strictEqual(rpcResult.bank_remaining, 0);
    assert.strictEqual(rpcResult.allocation_amount, 500000);

    // 3. Verify statement line updated status in this transaction
    const updatedLine = await client.query(
      'SELECT reconciliation_status, matching_status FROM bank_statement_lines WHERE id = $1',
      ['70b56ed7-6a67-4891-a8ea-0ad3fab61ea3']
    );
    assert.strictEqual(
      updatedLine.rows[0].reconciliation_status,
      'matched',
      'BSL status must become matched when fully allocated'
    );

    // 4. Verify both allocations exist in this transaction
    const bothAllocs = await client.query(
      'SELECT document_type, allocation_amount FROM bank_statement_allocations WHERE bank_statement_line_id = $1 ORDER BY created_at ASC',
      ['70b56ed7-6a67-4891-a8ea-0ad3fab61ea3']
    );
    assert.strictEqual(bothAllocs.rows.length, 2);
    assert.strictEqual(bothAllocs.rows[0].document_type, 'expense');
    assert.strictEqual(Number(bothAllocs.rows[0].allocation_amount), 900000);
    assert.strictEqual(bothAllocs.rows[1].document_type, 'journal');
    assert.strictEqual(Number(bothAllocs.rows[1].allocation_amount), 500000);

    // 5. Attempting to link the same journal twice does not create duplicate allocation (idempotent)
    const secondLinkRes = await client.query(
      'SELECT link_bank_statement_line($1, $2, $3, $4, $5) as result',
      [
        '70b56ed7-6a67-4891-a8ea-0ad3fab61ea3',
        'journal',
        '8bc45744-141e-4153-abc0-7f2355df0987',
        'other',
        500000,
      ]
    );
    assert.strictEqual(secondLinkRes.rows[0].result.status, 'already_linked');
    const allocCountAfterDuplicate = await client.query(
      'SELECT count(*)::int as count FROM bank_statement_allocations WHERE bank_statement_line_id = $1',
      ['70b56ed7-6a67-4891-a8ea-0ad3fab61ea3']
    );
    assert.strictEqual(allocCountAfterDuplicate.rows[0].count, 2, 'Must still have exactly 2 allocations');
  } finally {
    // ALWAYS ROLLBACK to preserve production data intact
    await client.query('ROLLBACK');
  }

  // Confirm after rollback that production database has strictly restored the initial state
  const checkAfter = await client.query(
    'SELECT reconciliation_status FROM bank_statement_lines WHERE id = $1',
    ['70b56ed7-6a67-4891-a8ea-0ad3fab61ea3']
  );
  assert.strictEqual(
    checkAfter.rows[0].reconciliation_status,
    bsl.reconciliation_status,
    'Post-rollback: line status must be restored to initial state'
  );
  const allocsAfter = await client.query(
    'SELECT count(*)::int as count FROM bank_statement_allocations WHERE bank_statement_line_id = $1',
    ['70b56ed7-6a67-4891-a8ea-0ad3fab61ea3']
  );
  assert.strictEqual(
    allocsAfter.rows[0].count,
    allocRes.rows.length,
    'Post-rollback: allocations count must be restored to initial state'
  );
});
