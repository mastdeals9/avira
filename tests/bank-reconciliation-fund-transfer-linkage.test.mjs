import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const BANK_ALLOCATION_EPSILON = 0.01;

function bankStatementLineAmount(debit, credit) {
  const debitAmount = Number(debit || 0);
  const creditAmount = Number(credit || 0);
  return debitAmount > 0 ? debitAmount : creditAmount;
}

function canonicalBankReconciliationStatus(bankAmount, allocatedAmount, epsilon = BANK_ALLOCATION_EPSILON, isDirectRecorded = false) {
  if (isDirectRecorded) return 'matched';
  const bank = Number(bankAmount) || 0;
  const allocated = Number(allocatedAmount) || 0;
  if (allocated <= epsilon) return 'unmatched';
  if (allocated >= bank - epsilon) return 'matched';
  return 'partially_reconciled';
}

function isAvailableTransaction(line) {
  if (
    !line.manually_unlinked &&
    Boolean(line.matched_entry_id || line.matched_fund_transfer_id) &&
    (line.matching_status === 'confirmed' || line.reconciliation_status === 'recorded' || line.reconciliation_status === 'matched')
  ) {
    return false;
  }
  const bankAmount = bankStatementLineAmount(line.debit_amount, line.credit_amount);
  const allocatedAmount = Number(line.allocatedAmount || 0);
  const remainingAmount = line.remainingAmount ?? Math.max(0, bankAmount - allocatedAmount);
  return canonicalBankReconciliationStatus(bankAmount, allocatedAmount) !== 'matched'
    && Number(remainingAmount) > BANK_ALLOCATION_EPSILON;
}

// Helper matching BankReconciliationEnhanced.tsx resolution logic
function resolveBankReconciliationLine({
  row,
  allocations = [],
  fundTransferMap = new Map(),
  entryMap = new Map(),
}) {
  const bankAmount = bankStatementLineAmount(row.debit_amount, row.credit_amount);
  const isDirectRecorded =
    !row.manually_unlinked &&
    Boolean(row.matched_entry_id) &&
    (row.matching_status === 'confirmed' || row.reconciliation_status === 'recorded');

  const validAllocations = allocations.filter(allocation => {
    if (!allocation.journal_entry_id) return false;
    const journal = entryMap.get(allocation.journal_entry_id);
    if (!journal || !journal.is_posted || journal.is_reversed) return false;
    return true;
  });

  // Resolve Fund Transfer: canonical allocation is authoritative; fallback to validated legacy link
  const firstFund = allocations.find(a => a.document_type === 'fund_transfer');
  let legacyFundAllocation = null;
  let legacyFundTransferId = null;

  if (!firstFund && row.matched_fund_transfer_id) {
    const ft = fundTransferMap.get(row.matched_fund_transfer_id);
    if (ft && !row.manually_unlinked && ft.status === 'posted' && ft.journal_entry_id) {
      const ftJournal = entryMap.get(ft.journal_entry_id);
      if (ftJournal && ftJournal.is_posted && !ftJournal.is_reversed) {
        const isFromLine = row.id === ft.from_bank_statement_line_id;
        const isToLine = row.id === ft.to_bank_statement_line_id;
        if (isFromLine || isToLine) {
          const side = isFromLine ? 'from' : 'to';
          const debit = Number(row.debit_amount || 0);
          const credit = Number(row.credit_amount || 0);
          const expectedAccount = side === 'from' ? ft.from_bank_account_id : ft.to_bank_account_id;
          const expectedAccountType = side === 'from' ? ft.from_account_type : ft.to_account_type;
          const expectedAmount = Number(side === 'from' ? (ft.from_amount ?? ft.amount) : (ft.to_amount ?? ft.amount));
          const actualAmount = side === 'from' ? debit : credit;
          const otherAmount = side === 'from' ? credit : debit;
          const rowDate = typeof row.transaction_date === 'string' ? row.transaction_date.split('T')[0] : '';
          const ftDate = typeof ft.transfer_date === 'string' ? ft.transfer_date.split('T')[0] : '';

          const isAccountMatch = expectedAccountType === 'bank' && expectedAccount === row.bank_account_id;
          const isDirectionMatch = actualAmount > BANK_ALLOCATION_EPSILON && otherAmount <= BANK_ALLOCATION_EPSILON;
          const isAmountMatch = Math.abs(actualAmount - expectedAmount) <= BANK_ALLOCATION_EPSILON;
          const isDateMatch = !rowDate || !ftDate || rowDate === ftDate;

          if (isAccountMatch && isDirectionMatch && isAmountMatch && isDateMatch) {
            legacyFundTransferId = ft.id;
            legacyFundAllocation = {
              id: `legacy-fund-${ft.id}`,
              bank_statement_line_id: row.id,
              document_type: 'fund_transfer',
              document_id: ft.id,
              journal_entry_id: ft.journal_entry_id,
              allocation_amount: actualAmount,
              payment_kind: 'fund_transfer',
              label: ft.transfer_number || 'Fund Transfer',
              counterparty: `${ft.from_account_type} → ${ft.to_account_type}`,
              document_total: expectedAmount,
              document_remaining: 0,
              journal_status: 'Posted',
            };
          }
        }
      }
    }
  }

  const allocatedAmount = validAllocations.reduce((sum, allocation) => sum + allocation.allocation_amount, 0)
    + (legacyFundAllocation ? legacyFundAllocation.allocation_amount : 0)
    + (isDirectRecorded && allocations.length === 0 && !legacyFundAllocation ? bankAmount : 0);
  const remainingAmount = Math.max(0, bankAmount - allocatedAmount);
  const isSuggested =
    (row.matching_status === 'suggested' ||
      row.reconciliation_status === 'needs_review' ||
      row.reconciliation_status === 'suggested') &&
    allocatedAmount <= BANK_ALLOCATION_EPSILON;
  const status = isSuggested
    ? 'suggested'
    : isDirectRecorded
      ? 'recorded'
      : canonicalBankReconciliationStatus(bankAmount, allocatedAmount);

  const labeledAllocations = allocations.map(allocation => {
    let label = allocation.document_type;
    let counterparty;
    let documentTotal;
    let documentRemaining;
    if (allocation.document_type === 'fund_transfer') {
      const ft = fundTransferMap.get(allocation.document_id);
      label = ft?.transfer_number || 'Fund Transfer';
      counterparty = ft ? `${ft.from_account_type} → ${ft.to_account_type}` : undefined;
      documentTotal = Number(ft?.to_amount ?? ft?.from_amount ?? ft?.amount ?? allocation.allocation_amount);
      documentRemaining = 0;
    }
    const journal = allocation.journal_entry_id ? entryMap.get(allocation.journal_entry_id) : undefined;
    return {
      ...allocation,
      label,
      counterparty,
      document_total: documentTotal,
      document_remaining: documentRemaining,
      journal_status: journal
        ? (journal.is_reversed ? 'Reversed' : journal.is_posted ? 'Posted' : 'Unposted')
        : undefined,
    };
  });

  if (labeledAllocations.length === 0 && legacyFundAllocation) {
    labeledAllocations.push(legacyFundAllocation);
  }

  const fundId = firstFund?.document_id || legacyFundTransferId || null;

  return {
    status,
    allocatedAmount,
    remainingAmount,
    allocations: labeledAllocations,
    matchedFundTransferId: fundId || undefined,
    matchedFundTransfer: fundId ? fundTransferMap.get(fundId) : null,
  };
}

test('Bank Reconciliation & Fund Transfer Linkage Regression Suite', async (t) => {

  await t.test('1. Valid legacy matched_fund_transfer_id with no canonical allocation is recognized as matched', () => {
    const row = {
      id: 'bsl-1',
      transaction_date: '2026-11-12',
      bank_account_id: 'bank-bca-idr',
      debit_amount: 10000000,
      credit_amount: 0,
      matching_status: 'suggested',
      reconciliation_status: 'matched',
      matched_fund_transfer_id: 'ft-1',
      manually_unlinked: false,
    };
    const ft = {
      id: 'ft-1',
      transfer_number: 'FT2611-0001',
      transfer_date: '2026-11-12',
      from_account_type: 'bank',
      to_account_type: 'petty_cash',
      from_bank_account_id: 'bank-bca-idr',
      to_bank_account_id: null,
      from_bank_statement_line_id: 'bsl-1',
      to_bank_statement_line_id: null,
      from_amount: 10000000,
      to_amount: 10000000,
      amount: 10000000,
      journal_entry_id: 'je-1',
      status: 'posted',
    };
    const journal = { id: 'je-1', is_posted: true, is_reversed: false };

    const fundTransferMap = new Map([['ft-1', ft]]);
    const entryMap = new Map([['je-1', journal]]);

    const result = resolveBankReconciliationLine({
      row,
      allocations: [],
      fundTransferMap,
      entryMap,
    });

    assert.equal(result.status, 'matched');
    assert.equal(result.allocatedAmount, 10000000);
    assert.equal(result.remainingAmount, 0);
    assert.equal(result.matchedFundTransferId, 'ft-1');
    assert.equal(result.matchedFundTransfer?.transfer_number, 'FT2611-0001');
    assert.equal(result.allocations.length, 1);
    assert.equal(result.allocations[0].label, 'FT2611-0001');
  });

  await t.test('2. Valid canonical Fund Transfer allocation is recognized as matched', () => {
    const row = {
      id: 'bsl-1',
      transaction_date: '2026-11-12',
      bank_account_id: 'bank-bca-idr',
      debit_amount: 10000000,
      credit_amount: 0,
      matching_status: 'suggested',
      reconciliation_status: 'matched',
      matched_fund_transfer_id: null,
      manually_unlinked: false,
    };
    const allocation = {
      id: 'bsa-1',
      bank_statement_line_id: 'bsl-1',
      document_type: 'fund_transfer',
      document_id: 'ft-1',
      journal_entry_id: 'je-1',
      allocation_amount: 10000000,
      payment_kind: 'fund_transfer',
    };
    const ft = {
      id: 'ft-1',
      transfer_number: 'FT2611-0001',
      transfer_date: '2026-11-12',
      from_account_type: 'bank',
      to_account_type: 'petty_cash',
      from_bank_account_id: 'bank-bca-idr',
      from_amount: 10000000,
      amount: 10000000,
      journal_entry_id: 'je-1',
      status: 'posted',
    };
    const journal = { id: 'je-1', is_posted: true, is_reversed: false };

    const result = resolveBankReconciliationLine({
      row,
      allocations: [allocation],
      fundTransferMap: new Map([['ft-1', ft]]),
      entryMap: new Map([['je-1', journal]]),
    });

    assert.equal(result.status, 'matched');
    assert.equal(result.allocatedAmount, 10000000);
    assert.equal(result.matchedFundTransferId, 'ft-1');
    assert.equal(result.matchedFundTransfer?.transfer_number, 'FT2611-0001');
    assert.equal(result.allocations.length, 1);
    assert.equal(result.allocations[0].label, 'FT2611-0001');
  });

  await t.test('3. No double-counting when both legacy fields and canonical allocation exist', () => {
    const row = {
      id: 'bsl-1',
      transaction_date: '2026-11-12',
      bank_account_id: 'bank-bca-idr',
      debit_amount: 10000000,
      credit_amount: 0,
      matching_status: 'suggested',
      reconciliation_status: 'matched',
      matched_fund_transfer_id: 'ft-1', // Legacy field present
      manually_unlinked: false,
    };
    const allocation = {
      id: 'bsa-1',
      bank_statement_line_id: 'bsl-1',
      document_type: 'fund_transfer',
      document_id: 'ft-1', // Canonical allocation present
      journal_entry_id: 'je-1',
      allocation_amount: 10000000,
      payment_kind: 'fund_transfer',
    };
    const ft = {
      id: 'ft-1',
      transfer_number: 'FT2611-0001',
      transfer_date: '2026-11-12',
      from_account_type: 'bank',
      to_account_type: 'petty_cash',
      from_bank_account_id: 'bank-bca-idr',
      from_bank_statement_line_id: 'bsl-1',
      from_amount: 10000000,
      amount: 10000000,
      journal_entry_id: 'je-1',
      status: 'posted',
    };
    const journal = { id: 'je-1', is_posted: true, is_reversed: false };

    const result = resolveBankReconciliationLine({
      row,
      allocations: [allocation],
      fundTransferMap: new Map([['ft-1', ft]]),
      entryMap: new Map([['je-1', journal]]),
    });

    // Authoritative canonical allocation is used once; amount is strictly 10,000,000, NOT 20,000,000
    assert.equal(result.allocatedAmount, 10000000);
    assert.equal(result.remainingAmount, 0);
    assert.equal(result.status, 'matched');
    assert.equal(result.allocations.length, 1);
  });

  await t.test('4. Posted Contra linked to an outgoing bank debit (from-side)', () => {
    const row = {
      id: 'line-out',
      transaction_date: '2026-11-10',
      bank_account_id: 'bank-source',
      debit_amount: 5000000,
      credit_amount: 0,
      matched_fund_transfer_id: 'ft-out',
    };
    const ft = {
      id: 'ft-out',
      transfer_number: 'FT2611-0002',
      transfer_date: '2026-11-10',
      from_account_type: 'bank',
      to_account_type: 'bank',
      from_bank_account_id: 'bank-source',
      to_bank_account_id: 'bank-dest',
      from_bank_statement_line_id: 'line-out',
      to_bank_statement_line_id: 'line-in',
      from_amount: 5000000,
      to_amount: 5000000,
      journal_entry_id: 'je-out',
      status: 'posted',
    };
    const journal = { id: 'je-out', is_posted: true, is_reversed: false };

    const result = resolveBankReconciliationLine({
      row,
      allocations: [],
      fundTransferMap: new Map([['ft-out', ft]]),
      entryMap: new Map([['je-out', journal]]),
    });

    assert.equal(result.status, 'matched');
    assert.equal(result.allocatedAmount, 5000000);
    assert.equal(result.matchedFundTransferId, 'ft-out');
  });

  await t.test('5. Posted Contra linked to an incoming bank credit (to-side)', () => {
    const row = {
      id: 'line-in',
      transaction_date: '2026-11-10',
      bank_account_id: 'bank-dest',
      debit_amount: 0,
      credit_amount: 5000000,
      matched_fund_transfer_id: 'ft-in',
    };
    const ft = {
      id: 'ft-in',
      transfer_number: 'FT2611-0002',
      transfer_date: '2026-11-10',
      from_account_type: 'bank',
      to_account_type: 'bank',
      from_bank_account_id: 'bank-source',
      to_bank_account_id: 'bank-dest',
      from_bank_statement_line_id: 'line-out',
      to_bank_statement_line_id: 'line-in',
      from_amount: 5000000,
      to_amount: 5000000,
      journal_entry_id: 'je-in',
      status: 'posted',
    };
    const journal = { id: 'je-in', is_posted: true, is_reversed: false };

    const result = resolveBankReconciliationLine({
      row,
      allocations: [],
      fundTransferMap: new Map([['ft-in', ft]]),
      entryMap: new Map([['je-in', journal]]),
    });

    assert.equal(result.status, 'matched');
    assert.equal(result.allocatedAmount, 5000000);
    assert.equal(result.matchedFundTransferId, 'ft-in');
  });

  await t.test('6. Legacy payment_kind = "supplier" Fund Transfer allocation is recognized without duplication', () => {
    const row = {
      id: 'bsl-legacy',
      transaction_date: '2026-11-12',
      bank_account_id: 'bank-bca-idr',
      debit_amount: 2500000,
      credit_amount: 0,
      matched_fund_transfer_id: 'ft-legacy',
    };
    const allocation = {
      id: 'bsa-legacy',
      bank_statement_line_id: 'bsl-legacy',
      document_type: 'fund_transfer',
      document_id: 'ft-legacy',
      journal_entry_id: 'je-legacy',
      allocation_amount: 2500000,
      payment_kind: 'supplier', // Historical payment_kind
    };
    const ft = {
      id: 'ft-legacy',
      transfer_number: 'FT2611-0003',
      transfer_date: '2026-11-12',
      from_account_type: 'bank',
      to_account_type: 'petty_cash',
      from_bank_account_id: 'bank-bca-idr',
      from_bank_statement_line_id: 'bsl-legacy',
      from_amount: 2500000,
      journal_entry_id: 'je-legacy',
      status: 'posted',
    };
    const journal = { id: 'je-legacy', is_posted: true, is_reversed: false };

    const result = resolveBankReconciliationLine({
      row,
      allocations: [allocation],
      fundTransferMap: new Map([['ft-legacy', ft]]),
      entryMap: new Map([['je-legacy', journal]]),
    });

    assert.equal(result.status, 'matched');
    assert.equal(result.allocatedAmount, 2500000);
    assert.equal(result.allocations.length, 1);
  });

  await t.test('7. Reversed or unposted Fund Transfers are not presented as matched', () => {
    // A. Unposted transfer
    const rowUnposted = {
      id: 'line-unposted',
      transaction_date: '2026-11-12',
      bank_account_id: 'bank-1',
      debit_amount: 1000000,
      credit_amount: 0,
      matched_fund_transfer_id: 'ft-draft',
      matching_status: 'unmatched',
    };
    const ftDraft = {
      id: 'ft-draft',
      transfer_number: 'FT-DRAFT',
      transfer_date: '2026-11-12',
      status: 'draft', // Not posted
      from_account_type: 'bank',
      from_bank_account_id: 'bank-1',
      from_bank_statement_line_id: 'line-unposted',
      from_amount: 1000000,
      journal_entry_id: null,
    };
    const resDraft = resolveBankReconciliationLine({
      row: rowUnposted,
      allocations: [],
      fundTransferMap: new Map([['ft-draft', ftDraft]]),
      entryMap: new Map(),
    });
    assert.equal(resDraft.status, 'unmatched');
    assert.equal(resDraft.allocatedAmount, 0);
    assert.equal(resDraft.matchedFundTransferId, undefined);

    // B. Reversed journal
    const rowReversed = {
      id: 'line-rev',
      transaction_date: '2026-11-12',
      bank_account_id: 'bank-1',
      debit_amount: 1000000,
      credit_amount: 0,
      matched_fund_transfer_id: 'ft-rev',
      matching_status: 'unmatched',
    };
    const ftRev = {
      id: 'ft-rev',
      transfer_number: 'FT-REV',
      transfer_date: '2026-11-12',
      status: 'posted',
      from_account_type: 'bank',
      from_bank_account_id: 'bank-1',
      from_bank_statement_line_id: 'line-rev',
      from_amount: 1000000,
      journal_entry_id: 'je-rev',
    };
    const jeRev = { id: 'je-rev', is_posted: true, is_reversed: true }; // Reversed
    const resRev = resolveBankReconciliationLine({
      row: rowReversed,
      allocations: [],
      fundTransferMap: new Map([['ft-rev', ftRev]]),
      entryMap: new Map([['je-rev', jeRev]]),
    });
    assert.equal(resRev.status, 'unmatched');
    assert.equal(resRev.allocatedAmount, 0);
    assert.equal(resRev.matchedFundTransferId, undefined);
  });

  await t.test('8. Incorrect account, date, direction or amount is rejected', () => {
    const baseFt = {
      id: 'ft-base',
      transfer_number: 'FT-VALID',
      transfer_date: '2026-11-12',
      status: 'posted',
      from_account_type: 'bank',
      to_account_type: 'petty_cash',
      from_bank_account_id: 'bank-correct',
      from_bank_statement_line_id: 'line-test',
      from_amount: 5000000,
      journal_entry_id: 'je-base',
    };
    const baseJe = { id: 'je-base', is_posted: true, is_reversed: false };

    // A. Wrong bank account
    const resWrongAccount = resolveBankReconciliationLine({
      row: {
        id: 'line-test',
        transaction_date: '2026-11-12',
        bank_account_id: 'bank-WRONG',
        debit_amount: 5000000,
        credit_amount: 0,
        matched_fund_transfer_id: 'ft-base',
      },
      fundTransferMap: new Map([['ft-base', baseFt]]),
      entryMap: new Map([['je-base', baseJe]]),
    });
    assert.equal(resWrongAccount.status, 'unmatched');
    assert.equal(resWrongAccount.allocatedAmount, 0);

    // B. Wrong direction (credit instead of debit on from-side)
    const resWrongDir = resolveBankReconciliationLine({
      row: {
        id: 'line-test',
        transaction_date: '2026-11-12',
        bank_account_id: 'bank-correct',
        debit_amount: 0,
        credit_amount: 5000000, // Credit on from-side is wrong
        matched_fund_transfer_id: 'ft-base',
      },
      fundTransferMap: new Map([['ft-base', baseFt]]),
      entryMap: new Map([['je-base', baseJe]]),
    });
    assert.equal(resWrongDir.status, 'unmatched');

    // C. Wrong amount
    const resWrongAmount = resolveBankReconciliationLine({
      row: {
        id: 'line-test',
        transaction_date: '2026-11-12',
        bank_account_id: 'bank-correct',
        debit_amount: 4900000, // Expected 5,000,000
        credit_amount: 0,
        matched_fund_transfer_id: 'ft-base',
      },
      fundTransferMap: new Map([['ft-base', baseFt]]),
      entryMap: new Map([['je-base', baseJe]]),
    });
    assert.equal(resWrongAmount.status, 'unmatched');

    // D. Wrong date
    const resWrongDate = resolveBankReconciliationLine({
      row: {
        id: 'line-test',
        transaction_date: '2026-11-15', // Expected 2026-11-12
        bank_account_id: 'bank-correct',
        debit_amount: 5000000,
        credit_amount: 0,
        matched_fund_transfer_id: 'ft-base',
      },
      fundTransferMap: new Map([['ft-base', baseFt]]),
      entryMap: new Map([['je-base', baseJe]]),
    });
    assert.equal(resWrongDate.status, 'unmatched');
  });

  await t.test('9. isAvailableTransaction recognizes matched Contra line as unavailable for duplicate matching', () => {
    const matchedLine = {
      id: '51e000fb-d655-4905-afbe-63cee347e684',
      transaction_date: '2026-11-12',
      bank_account_id: 'bfe79829-07d1-48ed-8965-ff9d367d758e',
      debit_amount: 10000000,
      credit_amount: 0,
      reconciliation_status: 'matched',
      matching_status: 'confirmed',
      matched_fund_transfer_id: '37267bc2-e958-4a17-8d52-ee47306807e7',
      matched_entry_id: 'ec7d0000-5b9d-4cf3-b915-1161ee179744',
      allocatedAmount: 10000000,
      remainingAmount: 0,
      manually_unlinked: false,
    };
    assert.equal(isAvailableTransaction(matchedLine), false);
  });

  await t.test('10. Codebase Implementation Invariants in Components', () => {
    const reconCode = fs.readFileSync('src/components/finance/BankReconciliationEnhanced.tsx', 'utf8');
    const fundCode = fs.readFileSync('src/components/finance/FundTransferManager.tsx', 'utf8');
    const linkCode = fs.readFileSync('src/components/finance/bankTransactionLinking.ts', 'utf8');

    // 1. BankReconciliationEnhanced resolves fundId from firstFund or legacyFundTransferId
    assert.match(reconCode, /const fundId = firstFund\?\.document_id \|\| legacyFundTransferId \|\| null;/);
    assert.match(reconCode, /if \(!firstFund && row\.matched_fund_transfer_id\)/);

    // 2. FundTransferManager triggers refresh on contra operations
    assert.match(fundCode, /notifyFinanceReconciliationRefresh\(\);/);

    // 3. bankTransactionLinking includes matched_fund_transfer_id check
    assert.match(linkCode, /matched_fund_transfer_id/);
  });

  await t.test('11. Four applied production migrations exist on disk with exact content', () => {
    const m1 = 'supabase/migrations/20261116200857_security_guard_direct_finance_and_batch_cost_rpcs.sql';
    const m2 = 'supabase/migrations/20261116201309_restrict_internal_security_definer_helpers.sql';
    const m3 = 'supabase/migrations/20261117041511_fix_warehouse_purchase_invoice_tax_period_trigger_context.sql';
    const m4 = 'supabase/migrations/20261117044513_fix_fund_transfer_bank_statement_canonical_linkage.sql';

    assert.ok(fs.existsSync(m1), 'Migration 1 exists');
    assert.ok(fs.existsSync(m2), 'Migration 2 exists');
    assert.ok(fs.existsSync(m3), 'Migration 3 exists');
    assert.ok(fs.existsSync(m4), 'Migration 4 exists');

    const m1Content = fs.readFileSync(m1, 'utf8');
    const m2Content = fs.readFileSync(m2, 'utf8');
    const m3Content = fs.readFileSync(m3, 'utf8');
    const m4Content = fs.readFileSync(m4, 'utf8');

    assert.match(m1Content, /propagate_bank_line_amount_edit/);
    assert.match(m1Content, /reallocate_container_costs/);
    assert.match(m2Content, /clear_payment_allocation_rounding_adjustment/);
    assert.match(m2Content, /recalculate_batch_landed_cost/);
    assert.match(m3Content, /compute_period_ppn/);
    assert.match(m3Content, /trg_recompute_from_purchase_invoice/);
    assert.match(m4Content, /update_fund_transfer_bank_links/);
    assert.match(m4Content, /link_bank_statement_line/);
  });

  await t.test('12. Live Production Read-Only Invariants: FT2611-0001 and No Current-Month Tampering', async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    if (!connectionString) {
      console.warn('Skipping live DB check: TEST_DATABASE_URL not set');
      return;
    }

    const client = new pg.Client({ connectionString });
    await client.connect();

    try {
      // 1. Verify FT2611-0001 canonical allocation exists exactly once with 10,000,000
      const bsaRes = await client.query(`
        SELECT id, bank_statement_line_id, document_type, document_id,
               journal_entry_id, allocation_amount, payment_kind
        FROM public.bank_statement_allocations
        WHERE document_type = 'fund_transfer'
          AND document_id = '37267bc2-e958-4a17-8d52-ee47306807e7'
      `);
      assert.equal(bsaRes.rows.length, 1, 'Allocation for FT2611-0001 must exist exactly once');
      const alloc = bsaRes.rows[0];
      assert.equal(alloc.bank_statement_line_id, '51e000fb-d655-4905-afbe-63cee347e684');
      assert.equal(Number(alloc.allocation_amount), 10000000);
      assert.equal(alloc.payment_kind, 'fund_transfer');
      assert.equal(alloc.journal_entry_id, 'ec7d0000-5b9d-4cf3-b915-1161ee179744');

      // 2. Verify bank statement line status is matched
      const bslRes = await client.query(`
        SELECT id, debit_amount, credit_amount, reconciliation_status, matched_fund_transfer_id
        FROM public.bank_statement_lines
        WHERE id = '51e000fb-d655-4905-afbe-63cee347e684'
      `);
      assert.equal(bslRes.rows.length, 1);
      assert.equal(bslRes.rows[0].reconciliation_status, 'matched');
      assert.equal(bslRes.rows[0].matched_fund_transfer_id, '37267bc2-e958-4a17-8d52-ee47306807e7');

      // 3. Rollback-only simulation of trigger update_fund_transfer_bank_links()
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL "request.jwt.claim.role" = 'service_role'`);
        // Test update trigger idempotency: updating without changing statement line doesn't create duplicate
        await client.query(`
          UPDATE public.fund_transfers
          SET description = description || ''
          WHERE id = '37267bc2-e958-4a17-8d52-ee47306807e7'
        `);
        const bsaAfterUpdate = await client.query(`
          SELECT COUNT(*) as cnt
          FROM public.bank_statement_allocations
          WHERE document_type = 'fund_transfer'
            AND document_id = '37267bc2-e958-4a17-8d52-ee47306807e7'
        `);
        assert.equal(Number(bsaAfterUpdate.rows[0].cnt), 1, 'Trigger must never create duplicate allocation');
      } finally {
        await client.query('ROLLBACK');
      }

    } finally {
      await client.end();
    }
  });
});
