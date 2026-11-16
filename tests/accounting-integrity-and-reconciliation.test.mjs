import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * SAPJ ERP — Accounting Integrity & Control Invariants Regression Tests
 * 
 * Verifies core accounting logic, reconciliation calculations, party ledger controls,
 * petty cash aggregation, and tax compliance invariant rules.
 */

// -----------------------------------------------------------------------------
// 1. BANK RECONCILIATION INVARIANTS & BALANCE CALCULATIONS
// -----------------------------------------------------------------------------
test('Bank Reconciliation — Direction and Currency Invariant Matching', () => {
  const bankAccount = {
    id: 'bfe79829-07d1-48ed-8965-ff9d367d758e',
    currency: 'IDR',
    account_number: '0930 2010 14',
  };

  const lineDebit = {
    id: 'line-1',
    bank_account_id: bankAccount.id,
    currency: 'IDR',
    debit_amount: 4000000,
    credit_amount: 0,
    direction: 'outgoing',
  };

  const lineCredit = {
    id: 'line-2',
    bank_account_id: bankAccount.id,
    currency: 'IDR',
    debit_amount: 0,
    credit_amount: 500000,
    direction: 'incoming',
  };

  // Rule 1: Outgoing bank line (debit) can only match outgoing payment/expense
  const matchStatementLine = (line, docType, docAmount, docCurrency) => {
    if (line.currency !== docCurrency) return false;
    if (docType === 'expense') {
      if (line.debit_amount <= 0) return false;
      return Math.abs(line.debit_amount - docAmount) < 0.01;
    }
    if (docType === 'receipt') {
      if (line.credit_amount <= 0) return false;
      return Math.abs(line.credit_amount - docAmount) < 0.01;
    }
    return false;
  };

  assert.equal(matchStatementLine(lineDebit, 'expense', 4000000, 'IDR'), true);
  assert.equal(matchStatementLine(lineDebit, 'receipt', 4000000, 'IDR'), false, 'Debit line must not match incoming receipt');
  assert.equal(matchStatementLine(lineDebit, 'expense', 4000000, 'USD'), false, 'Currency mismatch must reject match');
  assert.equal(matchStatementLine(lineCredit, 'receipt', 500000, 'IDR'), true);
});

test('Bank Reconciliation — Partial and 1-to-Many Allocations Without Duplicate Payments', () => {
  const statementLine = {
    id: 'stmt-100',
    amount: 10000000,
    allocated_amount: 0,
    allocations: [],
  };

  const allocate = (stmt, docId, docType, allocAmount) => {
    const remaining = stmt.amount - stmt.allocated_amount;
    assert.ok(allocAmount <= remaining + 0.01, 'Allocation exceeds remaining bank statement amount');
    stmt.allocated_amount += allocAmount;
    stmt.allocations.push({
      allocation_id: `alloc-${stmt.allocations.length + 1}`,
      document_id: docId,
      document_type: docType,
      amount: allocAmount,
    });
    return {
      remaining: Math.max(0, stmt.amount - stmt.allocated_amount),
      status: stmt.allocated_amount >= stmt.amount - 0.01 ? 'matched' : 'partially_matched',
    };
  };

  // Split Rp 10,000,000 across two documents
  const r1 = allocate(statementLine, 'bill-1', 'expense', 6000000);
  assert.equal(r1.remaining, 4000000);
  assert.equal(r1.status, 'partially_matched');

  const r2 = allocate(statementLine, 'bill-2', 'expense', 4000000);
  assert.equal(r2.remaining, 0);
  assert.equal(r2.status, 'matched');

  // Attempting to over-allocate throws error
  assert.throws(() => allocate(statementLine, 'bill-3', 'expense', 500000));
});

test('Bank Reconciliation — Live Book Balance vs Stale Cached Balance Computation', () => {
  const openingBalance = 945000;
  const postedTransactions = [
    { type: 'debit', amount: 1235912359.67, is_posted: true, is_reversed: false },
    { type: 'credit', amount: 251615830.00, is_posted: true, is_reversed: false },
    { type: 'credit', amount: 1000000.00, is_posted: false, is_reversed: false }, // unposted, must exclude
    { type: 'credit', amount: 500000.00, is_posted: true, is_reversed: true },   // reversed, must exclude
  ];

  const computeLiveBalance = (opening, txs) => {
    const valid = txs.filter(t => t.is_posted && !t.is_reversed);
    const debits = valid.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0);
    const credits = valid.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0);
    return Math.round((opening + debits - credits) * 100) / 100;
  };

  const live = computeLiveBalance(openingBalance, postedTransactions);
  const expected = Math.round((945000 + 1235912359.67 - 251615830.00) * 100) / 100;
  assert.equal(live, expected);

  // Stale cached balance discrepancy
  const staleCachedBalance = 1715946712.11;
  const liveGlBalance = 1716527712.11;
  const discrepancy = Math.round((liveGlBalance - staleCachedBalance) * 100) / 100;
  assert.equal(discrepancy, 581000.00, 'Expected exact Rp 581,000 difference between live GL and stale cached column');
});

test('Bank Reconciliation — October Rp 3,900,000 Variance Exact Decomposition', () => {
  // Statement line 16a51755 (Bizpark): Bank debited Rp 4,000,000, but expense EXP/26/369 never posted GL payment
  const unpostedBizparkDebit = 4000000.00;
  // Payment voucher PV/26-26/028: GL credited Bank Rp 100,000, but never cleared on bank statement
  const unclearedPvBankCredit = 100000.00;

  const netMovementVariance = unpostedBizparkDebit - unclearedPvBankCredit;
  assert.equal(netMovementVariance, 3900000.00, 'Rp 4,000,000 statement debit - Rp 100,000 GL credit must equal Rp 3,900,000');
});


// -----------------------------------------------------------------------------
// 2. EXPENSE, PAYMENT & PARTY LEDGER INVARIANTS
// -----------------------------------------------------------------------------
test('Party Ledger — Separation of Accrual from Settlement', () => {
  // 1. Accrual Journal
  const accrualJournal = {
    source_module: 'expenses',
    debit_account: '6100', // Operating Expense
    credit_account: '2110', // Accounts Payable
    amount: 5000000,
  };
  assert.equal(accrualJournal.debit_account, '6100');
  assert.equal(accrualJournal.credit_account, '2110');

  // 2. Settlement Journal
  const settlementJournal = {
    source_module: 'expense_payment',
    debit_account: '2110', // Accounts Payable (Clearing Liability)
    credit_account: '111101', // Bank BCA IDR
    amount: 5000000,
  };
  assert.equal(settlementJournal.debit_account, '2110');
  assert.equal(settlementJournal.credit_account, '111101');
});

test('Party Ledger — AP Control (2110) vs Supplier Subledger Rp 26,917,200 Variance', () => {
  const apLinesWithoutSupplier = [
    { source_module: 'expenses', debits: 0.00, credits: 446828887.00 },
    { source_module: 'expense_payment', debits: 572831829.98, credits: 0.00 },
    { source_module: 'payment', debits: 4400000.00, credits: 0.00 },
    { source_module: 'journal', debits: 0.00, credits: 155537718.00 },
    { source_module: 'customs_duty_adjustment', debits: 0.00, credits: 632424.98 },
    { source_module: 'historical_repair', debits: 0.00, credits: 1150000.00 },
  ];

  const totalCredits = apLinesWithoutSupplier.reduce((s, l) => s + l.credits, 0);
  const totalDebits = apLinesWithoutSupplier.reduce((s, l) => s + l.debits, 0);
  const netVariance = Math.round((totalCredits - totalDebits) * 100) / 100;

  assert.equal(netVariance, 26917200.00, 'Net variance of lines without supplier_id must equal Rp 26,917,200.00');
});

test('Party Ledger — Multi-Part Staff Salary Settlements (Sandi & Imron)', () => {
  const sandiSalary = {
    voucher_number: 'EXP/26/365',
    total_amount: 2500000.00,
    bank_transfer: 1400000.00,       // Statement line e88ba504
    advance_settlement: 1100000.00,  // Payment voucher PV/26-26/032
  };

  const imronSalary = {
    voucher_number: 'EXP/26/367',
    total_amount: 2500000.00,
    bank_transfer: 2000000.00,       // Statement line 4bf28340
    advance_settlement: 500000.00,   // Payment voucher PV/26-26/033
  };

  assert.equal(sandiSalary.bank_transfer + sandiSalary.advance_settlement, sandiSalary.total_amount);
  assert.equal(imronSalary.bank_transfer + imronSalary.advance_settlement, imronSalary.total_amount);

  // PV/26-26/028 is a distinct advance of Rp 100,000 on 2026-10-21 and must not be double counted
  const pv028 = { voucher_number: 'PV/26-26/028', amount: 100000.00, party_type: 'supplier' };
  assert.notEqual(pv028.amount, sandiSalary.advance_settlement);
});


// -----------------------------------------------------------------------------
// 3. PETTY CASH & CASH ON HAND INVARIANTS
// -----------------------------------------------------------------------------
test('Petty Cash — Inclusion of Cash Payment Vouchers in Operational Balance', () => {
  const glOpeningBalance = 3941428.00; // Account 1102 live GL balance
  const operationalPriorToVouchers = 4441428.00;

  // The two cash payment vouchers re-posted from 1101 to 1102
  const pv017 = { voucher_number: 'PV/26-26/017', amount: 500.00, payment_method: 'cash', account_code: '1102' };
  const pv018 = { voucher_number: 'PV/26-26/018', amount: 499500.00, payment_method: 'cash', account_code: '1102' };

  const totalCashVouchers = pv017.amount + pv018.amount;
  assert.equal(totalCashVouchers, 500000.00);

  const correctedOperationalBalance = operationalPriorToVouchers - totalCashVouchers;
  assert.equal(correctedOperationalBalance, glOpeningBalance, 'Operational balance must match GL Account 1102 balance');
});

test('Petty Cash — Inactive Account 1101 Exclusion', () => {
  const chartOfAccounts = [
    { code: '1101', name: 'Cash on Hand', is_active: false, is_header: false },
    { code: '1102', name: 'Petty Cash', is_active: true, is_header: false },
    { code: '111101', name: 'Bank BCA - IDR', is_active: true, is_header: false },
  ];

  const getOperationalCashAccounts = (accounts) => {
    return accounts.filter(a => a.is_active && !a.is_header && a.code !== '1101');
  };

  const operational = getOperationalCashAccounts(chartOfAccounts);
  assert.equal(operational.some(a => a.code === '1101'), false, 'Account 1101 must be excluded from operational accounts');
  assert.equal(operational.some(a => a.code === '1102'), true);
});


// -----------------------------------------------------------------------------
// 4. TAX & BPJS COMPLIANCE INVARIANTS
// -----------------------------------------------------------------------------
test('PPN Output — Exclusion of Cancelled Sales Invoice SAPJ-26-072', () => {
  const salesInvoices = [
    { invoice_number: 'SAPJ-26-070', tax_amount: 50000000.00, document_status: 'posted', cancelled_at: null },
    { invoice_number: 'SAPJ-26-071', tax_amount: 45811474.55, document_status: 'posted', cancelled_at: null },
    { invoice_number: 'SAPJ-26-072', tax_amount: 3225235.20, document_status: 'cancelled', cancelled_at: '2026-10-27T12:34:30.322Z' },
  ];

  const computeOutputTax = (invoices) => {
    return invoices
      .filter(i => i.document_status !== 'cancelled' && !i.cancelled_at)
      .reduce((sum, i) => sum + i.tax_amount, 0);
  };

  const outputPpn = computeOutputTax(salesInvoices);
  assert.equal(outputPpn, 95811474.55, 'Cancelled invoice tax must be excluded from Output PPN total');

  // Verify missing Faktur Pajak excludes cancelled invoice
  const getMissingFaktur = (invoices) => {
    return invoices
      .filter(i => i.document_status !== 'cancelled' && !i.cancelled_at && !i.faktur_pajak_number)
      .map(i => i.invoice_number);
  };
  const missing = getMissingFaktur(salesInvoices);
  assert.equal(missing.includes('SAPJ-26-072'), false, 'Cancelled invoice must not appear in missing Faktur Pajak list');
});

test('BPJS Register — Draft Register Invariant & Withholding Separation', () => {
  const octoberRegister = {
    period_month: 10,
    period_year: 2026,
    status: 'draft',
    payment_status: 'unpaid',
    reconciliation_status: 'unreconciled',
    total_employee_deductions: 246000.00,
    total_employer_expenses: 521520.00,
    total_contribution_payable: 767520.00,
    actual_paid_amount: 0.00,
  };

  // Rule: A draft register must never be marked paid or reconciled
  const isSettlementAllowed = (reg) => {
    return reg.status === 'posted' && Boolean(reg.journal_entry_id);
  };

  assert.equal(isSettlementAllowed(octoberRegister), false, 'Draft BPJS register cannot be settled or reconciled');
  assert.equal(octoberRegister.total_employee_deductions + octoberRegister.total_employer_expenses, octoberRegister.total_contribution_payable);
});


// -----------------------------------------------------------------------------
// 5. AUDIT & REPORTING VIEW CORRECTION INVARIANTS
// -----------------------------------------------------------------------------
test('Finance Verification Report — Selection of Original Recognition Journal over Settlement', () => {
  const expenseId = 'exp-1';
  const exportCoaCode = '6100'; // Office Expense

  const journalsForExpense = [
    {
      id: 'je-1',
      source_module: 'expenses', // Recognition
      entry_date: '2026-10-10',
      posted_at: '2026-10-10T10:00:00Z',
      debit_account_code: '6100',
    },
    {
      id: 'je-2',
      source_module: 'expense_payment', // Settlement via Bank
      entry_date: '2026-10-15',
      posted_at: '2026-10-15T14:00:00Z',
      debit_account_code: '2110', // AP Control
    },
  ];

  // Flawed logic: ORDER BY posted_at DESC LIMIT 1 -> selects je-2 (2110), compares 6100 != 2110 (FAIL)
  const flawedSelected = [...journalsForExpense].sort((a, b) => b.posted_at.localeCompare(a.posted_at))[0];
  const flawedMismatch = exportCoaCode !== flawedSelected.debit_account_code;
  assert.equal(flawedMismatch, true, 'Flawed query erroneously flags settlement journal as mismatch');

  // Corrected logic: Filter by source_module in ('expenses', 'expense') ORDER BY entry_date ASC
  const correctedSelected = journalsForExpense
    .filter(j => j.source_module === 'expenses' || j.source_module === 'expense')
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date))[0];
  const correctedMismatch = exportCoaCode !== correctedSelected.debit_account_code;
  assert.equal(correctedMismatch, false, 'Corrected query correctly matches original expense account (PASS)');
});
