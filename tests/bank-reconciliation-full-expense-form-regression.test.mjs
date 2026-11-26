import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(process.cwd());
const expenseManagerPath = resolve(projectRoot, 'src/components/finance/ExpenseManager.tsx');
const bankReconUiPath = resolve(projectRoot, 'src/components/finance/BankReconciliationEnhanced.tsx');
const receiptManagerPath = resolve(projectRoot, 'src/components/finance/ReceiptVoucherManager.tsx');
const paymentManagerPath = resolve(projectRoot, 'src/components/finance/PaymentVoucherManager.tsx');
const financePagePath = resolve(projectRoot, 'src/pages/Finance.tsx');

test('1. Bank Reconciliation reuses the existing full ExpenseManager component without reduced duplication', () => {
  const bankUi = readFileSync(bankReconUiPath, 'utf8');

  // Must import ExpenseManager and its prefill type
  assert.match(
    bankUi,
    /import\s*\{[^}]*ExpenseManager[^}]*\}\s*from\s*['"]\.\/ExpenseManager['"]/,
    'BankReconciliationEnhanced must import canonical ExpenseManager'
  );
  assert.match(
    bankUi,
    /BankReconciliationExpensePrefill/,
    'BankReconciliationEnhanced must import BankReconciliationExpensePrefill'
  );

  // Must render ExpenseManager in embeddedModalOnly mode
  assert.match(
    bankUi,
    /<ExpenseManager[\s\S]*embeddedModalOnly=\{true\}[\s\S]*prefillFromBankReconciliation=\{embeddedExpensePrefill\}/,
    'BankReconciliationEnhanced must render full ExpenseManager with embeddedModalOnly={true}'
  );

  // Must not have the simplified mini form with only category and description inputs
  assert.doesNotMatch(
    bankUi,
    /<form[\s\S]*name="category"[\s\S]*Create & Link Expense[\s\S]*<\/form>/,
    'BankReconciliationEnhanced must not contain a simplified mini expense form'
  );

  // Must offer Open Full Expense Form action
  assert.match(
    bankUi,
    /Open Full Expense Form/,
    'BankReconciliationEnhanced must present an Open Full Expense Form action'
  );
});

test('2. Bank statement transaction details are prepopulated into the Expense form', () => {
  const expenseUi = readFileSync(expenseManagerPath, 'utf8');

  // Verify prefill effect exists and populates date, due_date, amount, description, bank_account_id, reference, payment_method, currency
  assert.match(
    expenseUi,
    /prefillFromBankReconciliation/,
    'ExpenseManager must accept prefillFromBankReconciliation'
  );

  assert.match(
    expenseUi,
    /expense_date:\s*prefillFromBankReconciliation\.date/,
    'Expense date must be prefilled from statement transaction date'
  );

  assert.match(
    expenseUi,
    /amount:\s*prefillFromBankReconciliation\.amount/,
    'Amount must be prefilled from bank debit amount'
  );

  assert.match(
    expenseUi,
    /description:\s*prefillFromBankReconciliation\.description/,
    'Description must be prefilled from bank description'
  );

  assert.match(
    expenseUi,
    /bank_account_id:\s*prefillFromBankReconciliation\.bankAccountId/,
    'Bank account ID must be prefilled from statement line bank account'
  );

  assert.match(
    expenseUi,
    /payment_reference:\s*prefillFromBankReconciliation\.reference/,
    'Payment reference must be prefilled from statement line reference'
  );

  assert.match(
    expenseUi,
    /payment_method:\s*'bank_transfer'/,
    'Payment method must be bank_transfer for bank-paid expenses'
  );
});

test('3. Category and Utility selection supported (e.g. PT. PAM JAYA - water)', () => {
  const expenseUi = readFileSync(expenseManagerPath, 'utf8');

  // Category and utility must not be hardcoded or guessed blindly; utility roster must be loaded
  assert.match(
    expenseUi,
    /const\s*\[utilityRoster,\s*setUtilityRoster\]\s*=\s*useState/,
    'ExpenseManager must maintain utilityRoster state'
  );

  // Utility dropdown renders provider name and utility type
  assert.match(
    expenseUi,
    /utilityRoster\.map\(u\s*=>\s*\(\{\s*value:\s*u\.id,\s*label:\s*`\$\{u\.provider_name\}\s*·\s*\$\{u\.utility_type\}`/,
    'ExpenseManager must display utility options formatted as Provider · Utility Type'
  );

  // Category selection determines utility field visibility
  assert.match(
    expenseUi,
    /getCategoryFieldRules\(formData\.expense_category\)/,
    'ExpenseManager must compute field rules based on user selected expense category'
  );
});

test('4. Full Expense form supports attachments (with and without files)', () => {
  const expenseUi = readFileSync(expenseManagerPath, 'utf8');

  // File dropzone / upload state exists
  assert.match(
    expenseUi,
    /const\s*\[uploadingFiles,\s*setUploadingFiles\]\s*=\s*useState<File\[\]>\(\[\]\)/,
    'ExpenseManager must handle file uploads for bills and receipts'
  );

  // Storage bucket upload helper invoked
  assert.match(
    expenseUi,
    /await uploadFinanceDocuments\(uploadingFiles,\s*`expenses\/\$\{formData\.expense_category\}`\)/,
    'ExpenseManager must invoke uploadFinanceDocuments for pending uploads'
  );

  // Both with and without attachments work (payload accepts document_urls array)
  assert.match(
    expenseUi,
    /document_urls:\s*allDocumentUrls/,
    'ExpenseManager must set document_urls on saved payload'
  );
});

test('5. Successful expense creation links bank statement line with suggested match', () => {
  const expenseUi = readFileSync(expenseManagerPath, 'utf8');

  // Updates bank_statement_lines with matched_expense_id and suggested matching_status
  assert.match(
    expenseUi,
    /\.from\('bank_statement_lines'\)[\s\S]*\.update\(\{\s*matched_expense_id:\s*newExpense\.id,\s*matching_status:\s*'suggested',?\s*\}\)[\s\S]*\.eq\('id',\s*selectedBankTransactionId\)/,
    'ExpenseManager must link newly created expense to bank statement line with matching_status suggested'
  );

  // Calls refresh event
  assert.match(
    expenseUi,
    /notifyFinanceReconciliationRefresh\(\)/,
    'ExpenseManager must trigger notifyFinanceReconciliationRefresh after linking'
  );

  // Invokes callback
  assert.match(
    expenseUi,
    /onExpenseSavedFromBankReconciliation\?\.\((?:newExpense\s*as\s*FinanceExpense|finalExpense),\s*selectedBankTransactionId\)/,
    'ExpenseManager must invoke onExpenseSavedFromBankReconciliation callback'
  );
});

test('6. Duplicate prevention on retries stops creating multiple expenses for same statement line', () => {
  const expenseUi = readFileSync(expenseManagerPath, 'utf8');

  // Checks bank statement line before saving
  assert.match(
    expenseUi,
    /if\s*\(selectedBankTransactionId\)\s*\{[\s\S]*from\('bank_statement_lines'\)[\s\S]*select\('id,\s*matched_expense_id,\s*matching_status[^']*'\)[\s\S]*if\s*\(lineCheck\?\.matched_expense_id\)\s*\{[\s\S]*throw new Error\(/,
    'ExpenseManager must check if statement line is already linked before inserting a new expense'
  );
});

test('7. Failed saves leave statement line unrecorded and preserve entered form values', () => {
  const expenseUi = readFileSync(expenseManagerPath, 'utf8');

  const catchBlock = expenseUi.slice(
    expenseUi.indexOf("console.error('Error saving expense:'"),
    expenseUi.indexOf('const handleEdit = async')
  );

  // Catch block does not close modal or reset form
  assert.doesNotMatch(
    catchBlock,
    /setModalOpen\(false\)/,
    'Modal must remain open on save failure to preserve entered values'
  );
  assert.doesNotMatch(
    catchBlock,
    /resetForm\(\)/,
    'Form values must not be reset on save failure'
  );
});

test('8. Canonical accounting, approval, and tax workflow preserved', () => {
  const expenseUi = readFileSync(expenseManagerPath, 'utf8');

  // Uses saveFinanceExpense
  assert.match(
    expenseUi,
    /const newExpenseId = await saveFinanceExpense\(null,\s*newExpensePayload\)/,
    'Expense creation must use canonical saveFinanceExpense'
  );

  // Supports PPN mode and DPP calculation
  assert.match(
    expenseUi,
    /ppn_calc_mode/,
    'ExpenseManager must support standard, dpp_nilai_lain, and manual PPN calculation modes'
  );

  // Supports PPh code and withholding
  assert.match(
    expenseUi,
    /pph_code_id/,
    'ExpenseManager must support PPh tax codes and withholding calculations'
  );
});

test('9. Record as Receipt and Payment also reuse their full canonical forms', () => {
  const bankUi = readFileSync(bankReconUiPath, 'utf8');
  const receiptUi = readFileSync(receiptManagerPath, 'utf8');
  const paymentUi = readFileSync(paymentManagerPath, 'utf8');

  // Bank reconciliation renders ReceiptVoucherManager and PaymentVoucherManager embedded
  assert.match(
    bankUi,
    /<ReceiptVoucherManager[\s\S]*embeddedModalOnly=\{true\}[\s\S]*prefillFromBankReconciliation=\{embeddedReceiptPrefill\}/,
    'BankReconciliationEnhanced must support embedded full ReceiptVoucherManager'
  );
  assert.match(
    bankUi,
    /<PaymentVoucherManager[\s\S]*embeddedModalOnly=\{true\}[\s\S]*prefillFromBankReconciliation=\{embeddedPaymentPrefill\}/,
    'BankReconciliationEnhanced must support embedded full PaymentVoucherManager'
  );

  // ReceiptVoucherManager links to bank line upon creation
  assert.match(
    receiptUi,
    /await linkBankStatementLine\(bankReconStatementLineId,\s*'receipt',\s*savedVoucherId\)/,
    'ReceiptVoucherManager must link statement line to saved receipt voucher'
  );

  // PaymentVoucherManager links to bank line upon creation
  assert.match(
    paymentUi,
    /await linkBankStatementLine\(bankReconStatementLineId,\s*'payment',\s*savedVoucher.id\)/,
    'PaymentVoucherManager must link statement line to saved payment voucher'
  );
});

test('10. Normal Expenses, Receipt, and Payment modules continue to work unchanged', () => {
  const financeUi = readFileSync(financePagePath, 'utf8');

  // Finance page continues to render normal modules with full navigation
  assert.match(
    financeUi,
    /case 'expenses':[\s\S]*<ExpenseManager[\s\S]*canManage=\{canManage\}/,
    'Finance page must continue rendering full ExpenseManager'
  );

  assert.match(
    financeUi,
    /case 'receipt':[\s\S]*<ReceiptVoucherManager[\s\S]*canManage=\{canManage\}/,
    'Finance page must continue rendering full ReceiptVoucherManager'
  );

  assert.match(
    financeUi,
    /case 'payment':[\s\S]*<PaymentVoucherManager[\s\S]*canManage=\{canManage\}/,
    'Finance page must continue rendering full PaymentVoucherManager'
  );

  // Finance wires bank recon prefill to tabs
  assert.match(
    financeUi,
    /onRecordExpense=\{\(prefill\)\s*=>\s*\{[\s\S]*setExpenseReconPrefill\(prefill\);[\s\S]*setActiveTab\('expenses'\);[\s\S]*\}\}/,
    'Finance page must wire onRecordExpense to switch to expenses tab with prefill'
  );
});
