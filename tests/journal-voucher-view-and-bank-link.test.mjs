import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const financeUIFile = fs.readFileSync(path.resolve('src/components/finance/FinanceUI.tsx'), 'utf8');
const generalJournalFile = fs.readFileSync(path.resolve('src/components/finance/GeneralJournalEntry.tsx'), 'utf8');
const viewerFile = fs.readFileSync(path.resolve('src/components/finance/JournalEntryViewerEnhanced.tsx'), 'utf8');

const DB_CONNECTION =
  process.env.READONLY_AUDIT_DB_URL ||
  (process.env.READONLY_AUDIT_DB_URL || '');

// -----------------------------------------------------------------------------
// SECTION 1: ARCHITECTURAL & UI CONTRACTS
// -----------------------------------------------------------------------------
test('1. Architectural Contracts: FinanceUI defines standardized bankLink action and disabled styling', () => {
  assert.match(
    financeUIFile,
    /bankLink:\s*ICON_BTN_INFO/,
    'FinanceUI must register bankLink in ACTION_CLASS using standardized styling'
  );
  assert.match(
    financeUIFile,
    /bankLink:\s*Link2/,
    'FinanceUI must map bankLink to Link2 in FINANCE_ACTION_ICONS'
  );
  assert.match(
    financeUIFile,
    /disabled:opacity-30 disabled:cursor-not-allowed/,
    'FinanceActionButton must have standardized disabled styling'
  );
});

test('2. UI & Safeguard Contracts: GeneralJournalEntry restores Edit and Delete icons as visible but disabled for posted journals', () => {
  // A. View action present
  assert.match(
    generalJournalFile,
    /<FinanceActionButton[\s\S]*?action="view"/,
    'GeneralJournalEntry must use FinanceActionButton for view action'
  );

  // B. Edit and Delete actions are restored and disabled for posted journals
  assert.match(
    generalJournalFile,
    /<FinanceActionButton[\s\S]*?action="edit"[\s\S]*?disabled=\{e\.is_posted\}/,
    'GeneralJournalEntry must restore edit icon with disabled={e.is_posted}'
  );
  assert.match(
    generalJournalFile,
    /<FinanceActionButton[\s\S]*?action="delete"[\s\S]*?disabled=\{e\.is_posted\}/,
    'GeneralJournalEntry must restore delete icon with disabled={e.is_posted}'
  );

  // C. Link Bank Statement action present for eligible posted entries
  assert.match(
    generalJournalFile,
    /canManage\s*&&\s*e\.is_posted\s*&&\s*!e\.is_reversed\s*&&\s*hasBankGlMap\.get\(e\.id\)[\s\S]*?<FinanceActionButton[\s\S]*?action="bankLink"/,
    'GeneralJournalEntry must show Link Bank Statement action for posted unreversed entries with bank GL'
  );

  // D. Bank Reconciliation section in View modal
  assert.match(
    generalJournalFile,
    /Bank Reconciliation/,
    'GeneralJournalEntry view modal must contain Bank Reconciliation section'
  );
  assert.match(
    generalJournalFile,
    /Not Linked/,
    'GeneralJournalEntry view modal must show Not Linked badge when no allocations exist'
  );
  assert.match(
    generalJournalFile,
    /Statement Narration & Reference/,
    'GeneralJournalEntry view modal must show narration and reference'
  );
  assert.match(
    generalJournalFile,
    /Remaining Unallocated/,
    'GeneralJournalEntry view modal must show remaining unallocated amount'
  );
});

test('3. UI & Safeguard Contracts: JournalEntryViewerEnhanced restores Edit and Delete icons as visible but disabled for posted vouchers', () => {
  // A. Table row actions: view always present, edit/delete restored but disabled for posted
  assert.match(
    viewerFile,
    /<FinanceActionButton\s+action="view"\s+label="View detailed breakdown"/,
    'JournalEntryViewerEnhanced must use FinanceActionButton for view'
  );

  assert.match(
    viewerFile,
    /<FinanceActionButton[\s\S]*?action="edit"[\s\S]*?disabled=\{voucher\.is_posted\}/,
    'JournalEntryViewerEnhanced must restore edit icon with disabled={voucher.is_posted}'
  );
  assert.match(
    viewerFile,
    /<FinanceActionButton[\s\S]*?action="delete"[\s\S]*?disabled=\{voucher\.is_posted\}/,
    'JournalEntryViewerEnhanced must restore delete icon with disabled={voucher.is_posted}'
  );

  // B. Bank link action displayed for eligible posted manual journals
  assert.match(
    viewerFile,
    /canManage\s*&&\s*voucher\.is_posted\s*&&\s*!voucher\.is_reversed\s*&&\s*voucher\.has_bank_gl[\s\S]*?<FinanceActionButton\s+action="bankLink"\s+label="Link Bank Statement"/,
    'JournalEntryViewerEnhanced must display Link Bank Statement action for posted unreversed vouchers with bank GL'
  );

  // C. View modal Bank Reconciliation section
  assert.match(
    viewerFile,
    /Not Linked/,
    'View modal must clearly show Not Linked badge when no allocations exist'
  );
  assert.match(
    viewerFile,
    /Linked to Bank Statement/,
    'View modal must show Linked to Bank Statement badge when allocations exist'
  );
  assert.match(
    viewerFile,
    /Statement Narration & Reference/,
    'View modal must show statement narration and reference'
  );
  assert.match(
    viewerFile,
    /Remaining Unallocated/,
    'View modal must show remaining unallocated balance'
  );
  assert.match(
    viewerFile,
    /Reconciliation Status/,
    'View modal must display reconciliation status'
  );
  assert.match(
    viewerFile,
    /Transaction Line ID:/,
    'View modal must provide direct reference to bank statement transaction line'
  );

  // D. Candidate selection modal
  assert.match(
    viewerFile,
    /candidateSearchTerm/,
    'Candidate modal must support real-time search term'
  );
  assert.match(
    viewerFile,
    /filteredCandidateBankLines/,
    'Candidate modal must filter candidates dynamically'
  );
  assert.match(
    viewerFile,
    /Exact Match/,
    'Candidate modal must badge exact amount matches'
  );
  assert.match(
    viewerFile,
    /rankCandidateLines/,
    'Candidate ranking algorithm must prioritize exact balance matches followed by date'
  );
});

// -----------------------------------------------------------------------------
// SECTION 2: LIVE SUPABASE DATABASE VERIFICATION (READ-ONLY)
// -----------------------------------------------------------------------------
test('4. Target Record 1: JE2611-0490 has valid bank GL movement and qualifies for Link Bank Statement action', async () => {
  const client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    const { rows: jeRows } = await client.query(
      `SELECT id, entry_number, entry_date, is_posted, is_reversed, source_module, total_debit, total_credit, description
       FROM journal_entries
       WHERE entry_number = 'JE2611-0490'`
    );

    assert.equal(jeRows.length, 1, 'Journal entry JE2611-0490 must exist');
    const je = jeRows[0];
    assert.equal(je.is_posted, true, 'JE2611-0490 must be posted');
    assert.equal(je.is_reversed, false, 'JE2611-0490 must not be reversed');
    assert.equal(je.source_module, 'manual', 'JE2611-0490 must be a manual journal');
    assert.equal(Number(je.total_credit), 4000000, 'JE2611-0490 total must be Rp 4,000,000');

    // Verify it touches BCA IDR GL (111101)
    const { rows: lines } = await client.query(
      `SELECT jel.id, jel.debit, jel.credit, coa.code, coa.name
       FROM journal_entry_lines jel
       JOIN chart_of_accounts coa ON coa.id = jel.account_id
       WHERE jel.journal_entry_id = $1 AND coa.code = '111101'`,
      [je.id]
    );

    assert.equal(lines.length, 1, 'JE2611-0490 must touch BCA IDR account 111101');
    assert.equal(Number(lines[0].credit), 4000000, 'JE2611-0490 bank movement must be credit Rp 4,000,000');

    // Verify bank statement line matching
    const { rows: allocs } = await client.query(
      `SELECT bsa.id, bsa.allocation_amount, bsl.description, bsl.reference, bsl.debit_amount
       FROM bank_statement_allocations bsa
       JOIN bank_statement_lines bsl ON bsl.id = bsa.bank_statement_line_id
       WHERE bsa.journal_entry_id = $1`,
      [je.id]
    );

    if (allocs.length > 0) {
      assert.equal(Number(allocs[0].allocation_amount), 4000000, 'Allocated amount must be Rp 4,000,000');
      assert.match(allocs[0].description, /RICARDO/, 'Matched line must reference Ricardo');
    }
  } finally {
    await client.end();
  }
});

test('5. Target Record 2: JE2611-0489 shows its linked Rp 500,000 FATMAWATI bank transaction as Matched', async () => {
  const client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    const { rows: jeRows } = await client.query(
      `SELECT id, entry_number, entry_date, is_posted, is_reversed, source_module, total_debit, total_credit, description
       FROM journal_entries
       WHERE entry_number = 'JE2611-0489'`
    );

    assert.equal(jeRows.length, 1, 'Journal entry JE2611-0489 must exist');
    const je = jeRows[0];
    assert.equal(je.is_posted, true, 'JE2611-0489 must be posted');
    assert.equal(je.is_reversed, false, 'JE2611-0489 must not be reversed');
    assert.equal(Number(je.total_debit), 500000, 'JE2611-0489 total must be Rp 500,000');

    // Query its allocation in bank_statement_allocations
    const { rows: allocRows } = await client.query(
      `SELECT bsa.id, bsa.allocation_amount, bsa.payment_kind,
              bsl.id as line_id, bsl.transaction_date, bsl.description as statement_description,
              bsl.reference, bsl.credit_amount, bsl.reconciliation_status,
              ba.bank_name, ba.account_number
       FROM bank_statement_allocations bsa
       JOIN bank_statement_lines bsl ON bsl.id = bsa.bank_statement_line_id
       LEFT JOIN bank_accounts ba ON ba.id = bsl.bank_account_id
       WHERE bsa.journal_entry_id = $1`,
      [je.id]
    );

    assert.equal(allocRows.length, 1, 'JE2611-0489 must have exactly 1 bank allocation');
    const alloc = allocRows[0];
    assert.equal(Number(alloc.allocation_amount), 500000, 'Allocated amount must be Rp 500,000');
    assert.equal(Number(alloc.credit_amount), 500000, 'Statement line amount must be Rp 500,000');
    assert.equal(alloc.reconciliation_status, 'matched', 'Reconciliation status must be matched');
    assert.match(alloc.statement_description, /FATMAWATI/, 'Statement description must mention FATMAWATI');
    assert.equal(alloc.reference, '0911/FTSCY/WS95271', 'Reference must be 0911/FTSCY/WS95271');
    assert.equal(alloc.bank_name, 'BCA Bank', 'Bank name must be BCA Bank');
  } finally {
    await client.end();
  }
});
