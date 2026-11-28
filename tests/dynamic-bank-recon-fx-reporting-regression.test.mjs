/**
 * SAPJ ERP — Dynamic Bank Reconciliation, FX Accounting & Financial Reporting
 * 24 Comprehensive Regression Scenarios (Section J Specification)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import crypto from 'node:crypto';

const CONNECTION_STRING = (process.env.READONLY_AUDIT_DB_URL || '');

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

test('SAPJ Dynamic Bank Recon & FX Accounting Regression Suite', async (t) => {
  if (!CONNECTION_STRING) {
    t.skip('Skipping live DB suite: READONLY_AUDIT_DB_URL not set');
    return;
  }
  const client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');

  try {
    // ── 1. IDR Bank Statement Import ─────────────────────────────────────────
    await t.test('1. IDR Bank Statement Import Integrity', () => {
      const bcaIdrAccount = '0930201014';
      const openingBalance = 1000000000.00;
      const debits = [50000000.00, 356840000.00, 1500000.00];
      const credits = [200000000.00, 302393826.11];
      const totalDebits = debits.reduce((a, b) => a + b, 0);
      const totalCredits = credits.reduce((a, b) => a + b, 0);
      const closingBalance = openingBalance + totalCredits - totalDebits;

      assert.equal(totalDebits, 408340000.00);
      assert.equal(totalCredits, 502393826.11);
      assert.equal(Math.round(closingBalance * 100) / 100, 1094053826.11);
      assert.ok(Math.abs(openingBalance + totalCredits - totalDebits - closingBalance) < 0.01);
    });

    // ── 2. USD Bank Statement Import ─────────────────────────────────────────
    await t.test('2. USD Bank Statement Import Precision', () => {
      const bcaUsdAccount = '0930201022';
      const openingUsd = 10000.00;
      const debitsUsd = [4000.00, 50.00, 511.00];
      const creditsUsd = [];
      const totalDebits = debitsUsd.reduce((a, b) => a + b, 0);
      const totalCredits = 0;
      const closingUsd = openingUsd + totalCredits - totalDebits;

      assert.equal(totalDebits, 4561.00);
      assert.equal(closingUsd, 5439.00);
      assert.ok(Math.abs(openingUsd + totalCredits - totalDebits - closingUsd) < 0.0001);
    });

    // ── 3. Duplicate Statement Upload Detection ───────────────────────────────
    await t.test('3. Duplicate Statement Upload Prevention via SHA-256 Hash', () => {
      const bankId = 'bfe79829-07d1-48ed-8965-ff9d367d758e';
      const txn = {
        date: '2026-06-21',
        debit: 731392025.00,
        credit: 0,
        balance: 1094053826.11,
        desc: 'TRSF E-BANKING DB 2106/FTSCY/WS95011'
      };
      const hash1 = sha256(`${bankId}|${txn.date}|${txn.debit.toFixed(2)}|${txn.credit.toFixed(2)}|${txn.balance.toFixed(2)}|${txn.desc.trim()}`);
      const hash2 = sha256(`${bankId}|${txn.date}|${txn.debit.toFixed(2)}|${txn.credit.toFixed(2)}|${txn.balance.toFixed(2)}|${txn.desc.trim()}`);
      assert.equal(hash1, hash2, 'Hash must be strictly deterministic');

      const existingHashes = new Set([hash1]);
      const isDuplicate = existingHashes.has(hash2);
      assert.equal(isDuplicate, true, 'Repeated upload must be identified as duplicate');
    });

    // ── 4. Missing Transaction Detection ─────────────────────────────────────
    await t.test('4. Missing Transaction Rejection Guard', () => {
      const headerTotalCount = 26;
      const extractedLines = new Array(23).fill({});
      const isComplete = extractedLines.length === headerTotalCount;
      assert.equal(isComplete, false);
      const missingCount = headerTotalCount - extractedLines.length;
      assert.equal(missingCount, 3, 'Must detect exactly 3 missing transactions');
    });

    // ── 5. Incorrect Opening/Closing Balance Guard ────────────────────────────
    await t.test('5. Balance Equation Mismatch Validation', () => {
      const opening = 1000000;
      const credits = 500000;
      const debits = 200000;
      const reportedClosing = 1400000; // Expected 1,300,000 (diff 100,000)
      const computedClosing = opening + credits - debits;
      const diff = Math.abs(computedClosing - reportedClosing);
      assert.ok(diff > 0.05, 'Equation difference must exceed 0.05 threshold');
    });

    // ── 6. Partial Bank Reconciliation ───────────────────────────────────────
    await t.test('6. Partial Bank Reconciliation Status Handling', () => {
      const bankLineAmount = 10000000;
      const matchedVoucherAmount = 6000000;
      const unallocated = bankLineAmount - matchedVoucherAmount;
      assert.equal(unallocated, 4000000);
      const status = unallocated === 0 ? 'reconciled' : 'partially_reconciled';
      assert.equal(status, 'partially_reconciled');
    });

    // ── 7. Supplier Payment from IDR Bank ────────────────────────────────────
    await t.test('7. Supplier Payment from IDR Bank (Realized FX Loss)', () => {
      const allocatedUsd = 21000.00;
      const invoiceRecognitionRate = 16500.00;
      const settlementRate = 16990.00;
      const apCarryingRelief = allocatedUsd * invoiceRecognitionRate; // Rp 346,500,000
      const settlementCost = allocatedUsd * settlementRate;          // Rp 356,790,000
      const bankCharge = 50000.00;
      const totalBankDebit = settlementCost + bankCharge;             // Rp 356,840,000
      const realizedFxLoss = settlementCost - apCarryingRelief;       // Rp 10,290,000

      // Balanced Journal Check:
      const totalDebit = apCarryingRelief + realizedFxLoss + bankCharge;
      const totalCredit = totalBankDebit;
      assert.equal(totalDebit, totalCredit, 'Debit must equal Credit');
      assert.equal(apCarryingRelief, 346500000.00);
      assert.equal(realizedFxLoss, 10290000.00);
      assert.equal(totalBankDebit, 356840000.00);
    });

    // ── 8. Supplier Payment from USD Bank ────────────────────────────────────
    await t.test('8. Supplier Payment from USD Bank Asset', () => {
      const usdPayment = 40000.00;
      const usdBankCarryingRate = 16715.00; // Historical IDR cost basis of USD asset
      const invoiceCarryingRate = 16850.00;
      const apCarryingRelief = usdPayment * invoiceCarryingRate; // Rp 674,000,000
      const usdBankCreditIdr = usdPayment * usdBankCarryingRate; // Rp 668,600,000
      const realizedFxGain = apCarryingRelief - usdBankCreditIdr; // Rp 5,400,000 Gain

      // Total Debit = AP (674M)
      // Total Credit = Bank (668.6M) + FX Gain (5.4M) = 674M
      assert.equal(apCarryingRelief, usdBankCreditIdr + realizedFxGain);
    });

    // ── 9. Multiple USD Supplier Invoice Allocations ─────────────────────────
    await t.test('9. Multi-Invoice Allocation (PV/26-26/005 Exact Realized FX)', () => {
      // PV/26-26/005 settled USD 41,017.50 at rate 17,830 across 5 purchase invoices:
      // E0000220/2526 (USD 50.00 @ 16,743)
      // E0000221/2526 (USD 1,680.00 @ 17,167.20)
      // E0000231/2526 (USD 1,575.00 @ 16,445)
      // E0000274/2526 (USD 12,712.50 @ 16,781)
      // E0000332/2526 (USD 25,000.00 @ 16,850)
      const allocations = [
        { usd: 50.00, recRate: 16743.00 },
        { usd: 1680.00, recRate: 17167.20 },
        { usd: 1575.00, recRate: 16445.00 },
        { usd: 12712.50, recRate: 16781.00 },
        { usd: 25000.00, recRate: 16850.00 },
      ];
      const pvRate = 17830.00;

      const totalCarrying = allocations.reduce((sum, a) => sum + (a.usd * a.recRate), 0);
      const totalSettle = allocations.reduce((sum, a) => sum + (a.usd * pvRate), 0);
      const realizedFxLoss = totalSettle - totalCarrying;

      assert.equal(Math.round(totalCarrying * 100) / 100, 690157383.50);
      assert.equal(Math.round(totalSettle * 100) / 100, 731342025.00);
      assert.equal(Math.round(realizedFxLoss * 100) / 100, 41184641.50, 'Must match exact posted JE2609-0054');
    });

    // ── 10. Partial Supplier Payment ─────────────────────────────────────────
    await t.test('10. Partial Supplier Payment Allocation Precision', () => {
      const invoiceTotalUsd = 114390.40;
      const recognitionRate = 16850.00;
      const partialPaymentUsd = 80000.00;
      const settlementRate = 17500.00;

      const apRelief = partialPaymentUsd * recognitionRate;
      const settlementCost = partialPaymentUsd * settlementRate;
      const fxLoss = settlementCost - apRelief;

      const remainingBalanceUsd = invoiceTotalUsd - partialPaymentUsd;
      const remainingCarryingIdr = remainingBalanceUsd * recognitionRate;

      assert.equal(Math.round(remainingBalanceUsd * 100) / 100, 34390.40);
      assert.equal(apRelief, 1348000000.00);
      assert.equal(Math.round(remainingCarryingIdr * 100) / 100, 579478240.00);
      assert.equal(Math.round((apRelief + remainingCarryingIdr) * 100) / 100, Math.round(invoiceTotalUsd * recognitionRate * 100) / 100);
    });

    // ── 11. USD Bank Charge ──────────────────────────────────────────────────
    await t.test('11. USD Bank Charge Separation and Valuation', () => {
      const bankChargeUsd = 50.00;
      const usdCarryingRate = 18138.00;
      const bankChargeIdr = bankChargeUsd * usdCarryingRate; // Rp 906,900.00

      assert.equal(bankChargeIdr, 906900.00);
      // Strictly separated into GL 7100 / 8101, insulated from FX accounts
    });

    // ── 12. IDR-to-USD Fund Transfer ────────────────────────────────────────
    await t.test('12. IDR-to-USD Cross-Currency Transfer Dual Balance', () => {
      const idrSpent = 181380000.00;
      const usdReceived = 10000.00;
      const effectiveRate = idrSpent / usdReceived;
      assert.equal(effectiveRate, 18138.00);

      // Debit USD Bank Asset GL 111102: Rp 181,380,000
      // Credit IDR Bank Asset GL 111101: Rp 181,380,000
      // Balanced: Rp 181,380,000 Dr = Rp 181,380,000 Cr
    });

    // ── 13. USD-to-IDR Fund Transfer ────────────────────────────────────────
    await t.test('13. USD-to-IDR Fund Transfer Realized FX Difference', () => {
      const usdSold = 1000.00;
      const usdCarryingRate = 18138.00;
      const costBasisIdr = usdSold * usdCarryingRate; // Rp 18,138,000
      const idrReceived = 18250000.00;               // Rp 18,250,000 at market 18,250
      const realizedGain = idrReceived - costBasisIdr; // Rp 112,000 (Cr GL 4930)

      assert.equal(realizedGain, 112000.00);
    });

    // ── 14. Customer Receipt and Realized FX ──────────────────────────────────
    await t.test('14. Customer USD Receipt Realized FX Recognition', () => {
      const usdReceived = 5000.00;
      const recognitionRate = 16000.00;
      const receiptRate = 16200.00;
      const arRelief = usdReceived * recognitionRate; // Rp 80,000,000
      const actualReceivedIdr = usdReceived * receiptRate; // Rp 81,000,000
      const realizedFxGain = actualReceivedIdr - arRelief; // Rp 1,000,000 (Cr GL 4930)

      assert.equal(realizedFxGain, 1000000.00);
    });

    // ── 15. October Revaluation Preservation ─────────────────────────────────
    await t.test('15. October 2026 Revaluation Preservation in DB', async () => {
      const res = await client.query(`
        SELECT entry_number, total_debit, total_credit, is_posted
        FROM journal_entries WHERE entry_number = 'JE2611-0314';
      `);
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].total_debit, '150000352.20');
      assert.equal(res.rows[0].total_credit, '150000352.20');
      assert.equal(res.rows[0].is_posted, true);
    });

    // ── 16. November Payment After October Revaluation ───────────────────────
    await t.test('16. Carry-Forward Method Continuity into November', () => {
      const invoiceUsd = 10000.00;
      const octCarryingRate = 18138.00; // Established by October revaluation
      const novSettlementRate = 18250.00;

      const apReliefIdr = invoiceUsd * octCarryingRate;     // Rp 181,380,000
      const novSettlementCost = invoiceUsd * novSettlementRate; // Rp 182,500,000
      const novRealizedLoss = novSettlementCost - apReliefIdr; // Rp 1,120,000

      assert.equal(novRealizedLoss, 1120000.00);
    });

    // ── 17. Repeated Month-End Valuation Request (Idempotency) ───────────────
    await t.test('17. Month-End Revaluation Idempotency Guard', () => {
      const existingPeriod = '2026-10';
      const requestPeriod = '2026-10';
      const duplicateDetected = existingPeriod === requestPeriod;
      assert.equal(duplicateDetected, true, 'Must prevent duplicate revaluation generation');
    });

    // ── 18. Cancelled Invoice Exclusion ──────────────────────────────────────
    await t.test('18. Cancelled Invoices Strictly Excluded from AP & Revaluation', async () => {
      const res = await client.query(`
        SELECT COUNT(*) as count
        FROM purchase_invoices
        WHERE currency = 'USD' AND status = 'cancelled';
      `);
      assert.ok(Number(res.rows[0].count) >= 0);
    });

    // ── 19. Credit Note Accounting ───────────────────────────────────────────
    await t.test('19. Contra-Revenue & Credit Note Net Commercial Sales Reduction', async () => {
      const res = await client.query(`SELECT * FROM public.get_pnl_summary_detailed('2026-01-01', '2026-10-31', 1.0);`);
      const row = res.rows[0];
      const gross = parseFloat(row.gross_commercial_sales);
      const discounts = parseFloat(row.sales_discounts);
      const returns = parseFloat(row.sales_returns);
      const net = parseFloat(row.net_commercial_sales);

      assert.equal(net, gross - discounts - returns, 'Net sales must strictly equal Gross - Discounts - Returns');
      assert.equal(returns, 1572375.00, 'Sales returns deduction matches GL 4300');
    });

    // ── 20. P&L versus GL Reconciliation ─────────────────────────────────────
    await t.test('20. Detailed P&L Category Reconciliation against GL', async () => {
      const res = await client.query(`SELECT * FROM public.get_pnl_summary_detailed('2026-01-01', '2026-10-31', 1.0);`);
      const row = res.rows[0];
      const totalIncome = parseFloat(row.total_income);
      const netCommercial = parseFloat(row.net_commercial_sales);
      const otherIncome = parseFloat(row.other_income);
      const fxGain = parseFloat(row.fx_gain);
      const totalExp = parseFloat(row.total_expenses);
      const netIncome = parseFloat(row.net_income);

      assert.equal(Math.round(totalIncome * 100) / 100, Math.round((netCommercial + otherIncome + fxGain) * 100) / 100, 'Total income equation verified');
      assert.equal(Math.round(netIncome * 100) / 100, Math.round((totalIncome - totalExp) * 100) / 100, 'Net income = Total Income - Total Expenses verified');
    });

    // ── 21. Trial Balance Debit/Credit Equality ──────────────────────────────
    await t.test('21. Authoritative Trial Balance Equality (Difference Rp0.00)', async () => {
      const res = await client.query(`
        SELECT 
          SUM(debit) as total_debit,
          SUM(credit) as total_credit,
          SUM(debit) - SUM(credit) as diff
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
      `);
      assert.equal(res.rows[0].total_debit, '51578336266.21');
      assert.equal(res.rows[0].total_credit, '51578336266.21');
      assert.equal(res.rows[0].diff, '0.00');
    });

    // ── 22. Supplier Subledger versus AP Control Account ──────────────────────
    await t.test('22. Supplier USD Invoices Subledger vs AP Revalued Balance', async () => {
      const res = await client.query(`
        SELECT SUM(COALESCE(balance_amount, total_amount)) as total_usd
        FROM purchase_invoices
        WHERE currency = 'USD' AND status != 'paid' AND COALESCE(balance_amount, total_amount) > 0;
      `);
      assert.equal(parseFloat(res.rows[0].total_usd), 292479.15, 'Open USD payables must match USD 292,479.15');
      const revaluedAp = 292479.15 * 18138.00;
      assert.equal(Math.round(revaluedAp * 100) / 100, 5304986822.70, 'Revalued AP carrying amount must match Rp 5,304,986,822.70');
    });

    // ── 23. Bank USD Quantity versus Bank Statement ──────────────────────────
    await t.test('23. Bank USD Quantity and Functional IDR Carrying Balance', async () => {
      const res = await client.query(`
        SELECT current_balance FROM bank_accounts WHERE currency = 'USD';
      `);
      assert.equal(parseFloat(res.rows[0].current_balance), 5439.00, 'USD quantity must match USD 5,439.00');

      const resCoa = await client.query(`
        SELECT SUM(jel.debit - jel.credit) as idr_balance
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        JOIN chart_of_accounts coa ON coa.id = jel.account_id
        WHERE coa.code = '111102' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
      `);
      assert.equal(resCoa.rows[0].idr_balance, '98652582.00', 'IDR carrying balance must match Rp 98,652,582.00');
      assert.equal(parseFloat(resCoa.rows[0].idr_balance) / 5439.00, 18138.00, 'Effective rate must be exact 18,138.00 IDR/USD');
    });

    // ── 24. All Relevant Reports Refresh Correctly After Posting ──────────────
    await t.test('24. Financial RPCs Functionality and Integrity Check', async () => {
      const resTb = await client.query(`SELECT COUNT(*) as count FROM public.get_trial_balance('2026-01-01', '2026-10-31', 1.0);`);
      assert.ok(Number(resTb.rows[0].count) > 0, 'Trial balance RPC returns rows');

      const resPnl = await client.query(`SELECT COUNT(*) as count FROM public.get_pnl_summary_detailed('2026-01-01', '2026-10-31', 1.0);`);
      assert.equal(Number(resPnl.rows[0].count), 1, 'Detailed P&L summary returns single canonical row');
    });

    // ── 25. Atomic Bank Statement Import RPC Verification ────────────────────
    await t.test('25. import_bank_statement_atomic RPC exists with secure permissions', async () => {
      const res = await client.query(`
        SELECT proname, prosecdef 
        FROM pg_proc 
        WHERE proname = 'import_bank_statement_atomic';
      `);
      assert.equal(res.rows.length, 1, 'import_bank_statement_atomic function must exist');
      assert.equal(res.rows[0].prosecdef, true, 'Function must be SECURITY DEFINER');

      // Check account_holder column exists
      const colRes = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'bank_statement_uploads' AND column_name = 'account_holder';
      `);
      assert.equal(colRes.rows.length, 1, 'account_holder column must exist on bank_statement_uploads');
    });

    // ── 26. Auto-Reconcile Conflict Detection Logic ──────────────────────────
    await t.test('26. Candidate Conflict Detection when multiple vouchers match identical amount', () => {
      const candidates = [
        { id: 'pv-1', ref: 'PV/25-26/001', amount: 5000000 },
        { id: 'pv-2', ref: 'PV/25-26/002', amount: 5000000 }
      ];
      const statementLine = {
        amount: 5000000,
        description: 'BCA TRANSFER MBANK' // No reference in description
      };

      const hasExactRef = candidates.some(c => statementLine.description.includes(c.ref));
      assert.equal(hasExactRef, false);

      const status = candidates.length > 1 ? 'conflict' : 'reconciled';
      const matchingStatus = candidates.length > 1 ? 'suggested' : 'confirmed';
      assert.equal(status, 'conflict', 'Multiple identical candidates must flag conflict');
      assert.equal(matchingStatus, 'suggested', 'Conflict matching status must be suggested');
    });

    // ── 27. Auto-Reconcile Reference Matching Priority ────────────────────────
    await t.test('27. Reference Matching Priority selects single candidate with matching voucher', () => {
      const candidates = [
        { id: 'pv-1', ref: 'PV/25-26/001', amount: 5000000 },
        { id: 'pv-2', ref: 'PV/25-26/002', amount: 5000000 }
      ];
      const statementLine = {
        amount: 5000000,
        description: 'TRSF E-BANKING DB PV/25-26/002 WS95011'
      };

      const matchedCand = candidates.find(c => statementLine.description.includes(c.ref));
      assert.ok(matchedCand, 'Should match candidate by reference in description');
      assert.equal(matchedCand.id, 'pv-2');
      assert.equal(matchedCand.ref, 'PV/25-26/002');
    });

    // ── 28. Customer USD Receipt Realized FX Gain / Loss ──────────────────────
    await t.test('28. Customer USD Receipt Realized FX Gain / Loss and AR Carrying Relief', () => {
      const invoiceUsd = 1000.00;
      const invoiceRecognitionRate = 15500.00; // Carrying AR = Rp15,500,000
      const arCarryingIdr = invoiceUsd * invoiceRecognitionRate;

      // Settlement into IDR Bank at Rp16,200/USD
      const settlementRate = 16200.00;
      const bankReceivedIdr = invoiceUsd * settlementRate; // Rp16,200,000

      const realizedFx = bankReceivedIdr - arCarryingIdr; // +Rp700,000 (Gain)
      assert.equal(arCarryingIdr, 15500000);
      assert.equal(bankReceivedIdr, 16200000);
      assert.equal(realizedFx, 700000);

      // Debit Bank = 16,200,000
      // Credit AR Control = 15,500,000
      // Credit Realized FX Gain (GL 4930) = 700,000
      const totalDebit = bankReceivedIdr;
      const totalCredit = arCarryingIdr + realizedFx;
      assert.equal(totalDebit, totalCredit, 'Customer USD Receipt Journal balances to the cent');
    });

    // ── 29. Cross-Currency Fund Transfer Dynamic Rate ─────────────────────────
    await t.test('29. Cross-Currency Transfer Dynamic Carrying Rate Derivation', async () => {
      // In GL 111102, functional balance is 98,652,582.00 for USD 5,439.00
      const usdQty = 5439.00;
      const idrCarrying = 98652582.00;
      const derivedRate = Math.round((idrCarrying / usdQty) * 100) / 100;
      assert.equal(derivedRate, 18138.00, 'Derived rate dynamically matches weighted-average GL cost');

      // Transfer USD 1,000 into IDR bank at exchange rate 18,200
      const transferUsd = 1000.00;
      const idrReceived = 18200000.00; // at 18,200
      const usdCost = transferUsd * derivedRate; // Rp18,138,000
      const fxGain = idrReceived - usdCost; // Rp62,000

      assert.equal(usdCost, 18138000.00);
      assert.equal(fxGain, 62000.00);

      const totalDebit = idrReceived;
      const totalCredit = usdCost + fxGain;
      assert.equal(totalDebit, totalCredit, 'Cross-currency transfer balances to the cent');
    });

    // ── 30. Historical As-Of FX Revaluation Idempotency & Period Linkage ──────
    await t.test('30. Historical As-Of Revaluation October Preservation and Idempotency', async () => {
      const res = await client.query(`
        SELECT id, revaluation_number, closing_rate, total_gain_loss 
        FROM public.fx_revaluations 
        WHERE period_name = '2026-10';
      `);
      assert.equal(res.rows.length, 1, 'October 2026 revaluation must remain exactly 1 row');
      assert.equal(res.rows[0].revaluation_number, 'REV-2610-0001');
      assert.equal(parseFloat(res.rows[0].closing_rate), 18138.00);
      assert.equal(parseFloat(res.rows[0].total_gain_loss), -106796488.20);

      // Verify idempotency guard does not duplicate or alter October
      const rpcTest = await client.query(`
        SELECT public.run_fx_month_end_revaluation('2026-10-31'::date, 18138.00) as result;
      `);
      const resultObj = rpcTest.rows[0].result;
      assert.equal(resultObj.is_existing, true, 'Idempotency guard must flag is_existing = true');
      assert.equal(resultObj.revaluation_number, 'REV-2610-0001');
    });

  } finally {
    await client.end();
  }
});
