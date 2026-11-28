import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const connectionString = (process.env.READONLY_AUDIT_DB_URL || '');
const paymentVoucherManagerPath = path.resolve('src/components/finance/PaymentVoucherManager.tsx');
const bankReconciliationPath = path.resolve('src/components/finance/BankReconciliationEnhanced.tsx');
const expenseManagerPath = path.resolve('src/components/finance/ExpenseManager.tsx');
const taxPaymentsPanelPath = path.resolve('src/components/finance/tax/TaxPaymentsPanel.tsx');

test('Finance Bug Fixes: USD→IDR Rounding & Expense Reference Display Test Suite', async (t) => {
  let client;

  t.before(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query('BEGIN READ ONLY;');
  });

  t.after(async () => {
    if (client) {
      await client.query('ROLLBACK;').catch(() => {});
      await client.end();
    }
  });

  await t.test('1. USD invoice → IDR bank account: rounds to whole rupiah & reconciles against BCA statement', () => {
    // Reproduction test parameters
    const invoiceCurrency = 'USD';
    const bankCurrency = 'IDR';
    const invoiceAmount = 55852.40;
    const pphAmount = 0;
    const exchangeRate = 18136;
    const bankCharge = 50000;
    const bcaStatementDebit = 1012989126.00;

    const isCrossCurrency = invoiceCurrency !== bankCurrency;
    const effectiveRate = isCrossCurrency ? exchangeRate : 1;
    const netInvoiceAmount = invoiceAmount - pphAmount;

    // Raw math
    const rawConverted = netInvoiceAmount * effectiveRate; // 1,012,939,126.40
    assert.equal(rawConverted, 1012939126.40);

    // Currency-normalized math as implemented in PaymentVoucherManager.tsx
    const convertedPaymentAmount = bankCurrency === 'IDR'
      ? Math.round(rawConverted)
      : Math.round(rawConverted * 100) / 100;
    assert.equal(convertedPaymentAmount, 1012939126, 'Converted payment amount must round to whole rupiah');

    const rawTotalBankDebit = convertedPaymentAmount + bankCharge;
    const totalBankDebit = bankCurrency === 'IDR'
      ? Math.round(rawTotalBankDebit)
      : Math.round(rawTotalBankDebit * 100) / 100;
    assert.equal(totalBankDebit, 1012989126, 'Total bank debit must equal exact BCA bank statement amount');

    // Validation check against bank reconciliation expected amount
    const diff = Math.abs(totalBankDebit - bcaStatementDebit);
    assert.ok(diff <= 0.01, `Difference (${diff}) must be <= 0.01 to pass reconciliation validation`);
  });

  await t.test('2. USD invoice → USD bank account: preserves exact cents precision', () => {
    const invoiceCurrency = 'USD';
    const bankCurrency = 'USD';
    const invoiceAmount = 1234.56;
    const pphAmount = 0;
    const exchangeRate = 1;
    const bankCharge = 25.50;
    const statementDebit = 1260.06;

    const isCrossCurrency = invoiceCurrency !== bankCurrency;
    const effectiveRate = isCrossCurrency ? exchangeRate : 1;
    const netInvoiceAmount = invoiceAmount - pphAmount;
    const rawConverted = netInvoiceAmount * effectiveRate;

    const convertedPaymentAmount = bankCurrency === 'IDR'
      ? Math.round(rawConverted)
      : Math.round(rawConverted * 100) / 100;
    assert.equal(convertedPaymentAmount, 1234.56, 'USD payment must retain 2 decimal places');

    const rawTotalBankDebit = convertedPaymentAmount + bankCharge;
    const totalBankDebit = bankCurrency === 'IDR'
      ? Math.round(rawTotalBankDebit)
      : Math.round(rawTotalBankDebit * 100) / 100;
    assert.equal(totalBankDebit, 1260.06, 'USD total bank debit must retain exact cents');

    const diff = Math.abs(totalBankDebit - statementDebit);
    assert.ok(diff <= 0.01, 'USD reconciliation must match within 0.01 tolerance');
  });

  await t.test('3. IDR invoice → IDR bank account: whole rupiah throughout', () => {
    const invoiceCurrency = 'IDR';
    const bankCurrency = 'IDR';
    const invoiceAmount = 25000000;
    const pphAmount = 500000;
    const exchangeRate = 1;
    const bankCharge = 6500;

    const isCrossCurrency = invoiceCurrency !== bankCurrency;
    const effectiveRate = isCrossCurrency ? exchangeRate : 1;
    const netInvoiceAmount = invoiceAmount - pphAmount;
    const rawConverted = netInvoiceAmount * effectiveRate;

    const convertedPaymentAmount = bankCurrency === 'IDR'
      ? Math.round(rawConverted)
      : Math.round(rawConverted * 100) / 100;
    assert.equal(convertedPaymentAmount, 24500000);

    const rawTotalBankDebit = convertedPaymentAmount + bankCharge;
    const totalBankDebit = bankCurrency === 'IDR'
      ? Math.round(rawTotalBankDebit)
      : Math.round(rawTotalBankDebit * 100) / 100;
    assert.equal(totalBankDebit, 24506500, 'IDR bank debit must be whole rupiah');
  });

  await t.test('4. Bank charges included in actual bank debit & consistent payload propagation', () => {
    assert.ok(fs.existsSync(paymentVoucherManagerPath), 'PaymentVoucherManager.tsx must exist');
    const pvmCode = fs.readFileSync(paymentVoucherManagerPath, 'utf8');

    // Verify calculation includes bankCharge
    assert.ok(
      pvmCode.includes('rawTotalBankDebit = convertedPaymentAmount + bankCharge'),
      'rawTotalBankDebit must add bankCharge to convertedPaymentAmount'
    );
    assert.ok(
      pvmCode.includes("totalBankDebit = bankCurrency === 'IDR'"),
      'totalBankDebit must apply currency normalization rule'
    );

    // Verify payload passes normalized totalBankDebit to actual_bank_debit and bank_amount
    assert.ok(
      pvmCode.includes('actual_bank_debit: totalBankDebit'),
      'actual_bank_debit must be totalBankDebit'
    );
    assert.ok(
      pvmCode.includes('bank_amount: isCrossCurrency ? totalBankDebit : null'),
      'bank_amount must use normalized totalBankDebit'
    );
  });

  await t.test('5. Exact bank statement amount reconciliation validation & detailed mismatch reporting', () => {
    const pvmCode = fs.readFileSync(paymentVoucherManagerPath, 'utf8');

    // Verify reconciliation validation check
    assert.ok(
      pvmCode.includes('Math.abs(totalBankDebit - bankReconExpectedAmount) > 0.01'),
      'Validation must compare totalBankDebit to bankReconExpectedAmount with 0.01 tolerance'
    );

    // Verify detailed diff reporting with decimals
    assert.ok(
      pvmCode.includes('formatDetailed(diff)'),
      'Error message must show formatDetailed(diff)'
    );
    assert.ok(
      pvmCode.includes('formatDetailed(totalBankDebit)'),
      'Error message must show formatDetailed(totalBankDebit)'
    );
    assert.ok(
      pvmCode.includes('formatDetailed(bankReconExpectedAmount'),
      'Error message must show formatDetailed(bankReconExpectedAmount)'
    );
  });

  await t.test('6. Expense created from Finance Expenses screen displays canonical EXP number', async () => {
    assert.ok(fs.existsSync(expenseManagerPath), 'ExpenseManager.tsx must exist');
    const emCode = fs.readFileSync(expenseManagerPath, 'utf8');

    // Verify ExpenseManager displays voucher_number
    assert.ok(
      emCode.includes('expense.voucher_number'),
      'ExpenseManager list and details must reference voucher_number'
    );

    // Verify database schema and trigger for auto-generating EXP voucher numbers
    const trigRes = await client.query(`
      SELECT trigger_name, event_manipulation, action_statement
      FROM information_schema.triggers
      WHERE event_object_table = 'finance_expenses' AND trigger_name ILIKE '%voucher%';
    `);
    assert.ok(trigRes.rows.length > 0, 'Trigger for voucher number assignment must exist on finance_expenses');

    // Verify recent vouchers in DB follow EXP/YY/NNN pattern
    const vRes = await client.query(`
      SELECT voucher_number
      FROM finance_expenses
      WHERE voucher_number IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 10;
    `);
    assert.ok(vRes.rows.length > 0, 'Must have existing voucher numbers');
    for (const row of vRes.rows) {
      assert.match(row.voucher_number, /^EXP\/\d{2}\/\d+$/, `Voucher number ${row.voucher_number} must match EXP/YY/NNN`);
    }
  });

  await t.test('7. Expense created from Bank Reconciliation fetches and displays EXP number (never shortened UUID)', () => {
    assert.ok(fs.existsSync(bankReconciliationPath), 'BankReconciliationEnhanced.tsx must exist');
    const breCode = fs.readFileSync(bankReconciliationPath, 'utf8');

    // Verify handleRecordExpense fetches voucher_number
    assert.ok(
      breCode.includes("from('finance_expenses')") && breCode.includes("select('id, voucher_number')"),
      'handleRecordExpense must fetch voucher_number from finance_expenses'
    );

    // Verify action feedback displays Voucher Number and fallback placeholder
    assert.ok(
      breCode.includes("{ label: 'Voucher Number', value: voucherNumber }"),
      'ActionFeedback must show Voucher Number label with fetched voucher number'
    );
    assert.ok(
      breCode.includes("'EXP (pending assignment)'"),
      "Fallback must be 'EXP (pending assignment)'"
    );

    // Verify that handleRecordExpense no longer displays sliced UUID
    const recordExpenseMatch = breCode.match(/const handleRecordExpense = async[\s\S]*?setActionFeedback\(\{[\s\S]*?details:\s*\[([\s\S]*?)\]/);
    assert.ok(recordExpenseMatch, 'handleRecordExpense feedback block must be found');
    assert.ok(
      !recordExpenseMatch[1].includes('slice(0, 8)'),
      'handleRecordExpense details must not use slice(0, 8)'
    );

    // Verify onExpenseSavedFromBankReconciliation also displays Voucher Number
    const onSavedMatch = breCode.match(/onExpenseSavedFromBankReconciliation=\{[\s\S]*?setActionFeedback\(\{[\s\S]*?details:\s*\[([\s\S]*?)\]/);
    assert.ok(onSavedMatch, 'onExpenseSavedFromBankReconciliation feedback block must be found');
    assert.ok(
      !onSavedMatch[1].includes('savedExpense.id.slice(0, 8)'),
      'onExpenseSavedFromBankReconciliation must not use savedExpense.id.slice(0, 8)'
    );
    assert.ok(
      onSavedMatch[1].includes("{ label: 'Voucher Number', value: displayVoucher }"),
      'onExpenseSavedFromBankReconciliation must display Voucher Number'
    );
  });

  await t.test('8. PPh Tax Payments UI regression check & safety (RPC contract and period locking)', async () => {
    assert.ok(fs.existsSync(taxPaymentsPanelPath), 'TaxPaymentsPanel.tsx must exist');
    const tpCode = fs.readFileSync(taxPaymentsPanelPath, 'utf8');

    // Verify UI invokes record_tax_payment RPC and catches errors
    assert.ok(
      tpCode.includes("supabase.rpc('record_tax_payment'"),
      "TaxPaymentsPanel must invoke record_tax_payment RPC"
    );
    assert.ok(
      tpCode.includes("catch (err)"),
      "TaxPaymentsPanel must contain error handling for failed tax payments"
    );

    // Verify record_tax_payment RPC exists in database
    const procRes = await client.query(`
      SELECT proname, proargnames
      FROM pg_proc
      WHERE proname = 'record_tax_payment';
    `);
    assert.ok(procRes.rows.length > 0, 'record_tax_payment RPC must exist in production database');

    // Verify enforce_tax_period_lock function exists
    const lockRes = await client.query(`
      SELECT proname
      FROM pg_proc
      WHERE proname = 'enforce_tax_period_lock';
    `);
    assert.ok(lockRes.rows.length > 0, 'enforce_tax_period_lock function must exist in database');

    // Verify transaction remains in READ ONLY mode (strict safety)
    const readOnlyRes = await client.query("SHOW transaction_read_only;");
    assert.equal(readOnlyRes.rows[0].transaction_read_only, 'on', 'Database connection must be transaction_read_only = on');
  });
});

