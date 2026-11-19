import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pvManagerSource = readFileSync(
  new URL('../src/components/finance/PaymentVoucherManager.tsx', import.meta.url),
  'utf8',
);

const pettyCashSource = readFileSync(
  new URL('../src/components/finance/PettyCashManager.tsx', import.meta.url),
  'utf8',
);

const financeCommandsSource = readFileSync(
  new URL('../src/services/financeCommands.ts', import.meta.url),
  'utf8',
);

const migrationSource = readFileSync(
  new URL('../supabase/migrations/20261119084158_integrate_payment_vouchers_with_petty_cash.sql', import.meta.url),
  'utf8',
);

test('1. Require selection of an active Petty Cash Book in UI and DB', () => {
  // Frontend UI requirement: checks petty_cash_book_id when cash_source is petty_cash
  assert.match(
    pvManagerSource,
    /if\s*\(formData\.cash_source === 'petty_cash' && !formData\.petty_cash_book_id\)\s*\{[\s\S]*?Please select an active petty cash book\/fund\./,
    'UI must require an active petty cash book when cash_source is petty_cash',
  );

  // Frontend payload carries petty_cash_book_id
  assert.match(
    pvManagerSource,
    /petty_cash_book_id:\s*\(finalPaymentMethod === 'petty_cash' \|\| \(formData\.payment_method === 'cash' && formData\.cash_source === 'petty_cash'\)\)\s*\?\s*\(formData\.petty_cash_book_id \|\| null\)\s*:\s*null/,
    'Form submit payload must pass petty_cash_book_id',
  );

  // financeCommands service defines petty_cash_book_id
  assert.match(
    financeCommandsSource,
    /petty_cash_book_id\?:\s*string \| null/,
    'PaymentPayload interface must include petty_cash_book_id',
  );

  // DB requirement in save_payment_voucher_command
  assert.match(
    migrationSource,
    /IF v_method IN \('cash', 'petty_cash'\) AND \(v_method = 'petty_cash' OR v_cash_source = 'petty_cash' OR v_petty_cash_book_id IS NOT NULL\) THEN/,
    'DB command must inspect cash/petty_cash methods for book selection',
  );
  assert.match(
    migrationSource,
    /IF NOT EXISTS \(SELECT 1 FROM public\.petty_cash_books WHERE id = v_petty_cash_book_id AND is_active = true\) THEN[\s\S]*?RAISE EXCEPTION 'Selected petty cash book is inactive or not found'/,
    'DB command must validate that selected book is active',
  );
});

test('2. On successful Payment Voucher posting, create exactly one corresponding outgoing Petty Cash transaction linked to the Payment Voucher', () => {
  // Schema definition: payment_voucher_id and petty_cash_book_id on petty_cash_transactions
  assert.match(
    migrationSource,
    /ADD COLUMN IF NOT EXISTS payment_voucher_id uuid REFERENCES public\.payment_vouchers\(id\) ON DELETE CASCADE/,
    'petty_cash_transactions must have payment_voucher_id foreign key',
  );
  assert.match(
    migrationSource,
    /ADD COLUMN IF NOT EXISTS petty_cash_book_id uuid REFERENCES public\.petty_cash_books\(id\) ON DELETE RESTRICT/,
    'petty_cash_transactions must have petty_cash_book_id foreign key',
  );

  // Unique index enforces exactly one linked transaction
  assert.match(
    migrationSource,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_pct_payment_voucher_id\s+ON public\.petty_cash_transactions\(payment_voucher_id\)\s+WHERE payment_voucher_id IS NOT NULL;/,
    'Partial unique index ensures at most one petty cash transaction per payment voucher',
  );

  // Insertion in post_payment_voucher
  assert.match(
    migrationSource,
    /INSERT INTO public\.petty_cash_transactions \([\s\S]*?transaction_type,[\s\S]*?amount,[\s\S]*?payment_voucher_id,[\s\S]*?petty_cash_book_id[\s\S]*?\) VALUES \([\s\S]*?'expense',[\s\S]*?v_gross,[\s\S]*?v_pv\.id,[\s\S]*?v_book_id/,
    'post_payment_voucher must create an outgoing transaction linked to the payment voucher and book',
  );
});

test('3. Deduct the amount from that specific Petty Cash Book available balance', () => {
  // Deduct on new post
  assert.match(
    migrationSource,
    /UPDATE public\.petty_cash_books[\s\S]*?SET current_balance = current_balance - v_gross,[\s\S]*?updated_at = now\(\)[\s\S]*?WHERE id = v_book_id;/,
    'post_payment_voucher must deduct voucher amount from petty_cash_books.current_balance',
  );

  // Deduct adjustment when amount or book changed on repost
  assert.match(
    migrationSource,
    /UPDATE public\.petty_cash_books[\s\S]*?SET current_balance = current_balance \+ v_pct\.amount[\s\S]*?WHERE id = v_pct\.petty_cash_book_id;[\s\S]*?UPDATE public\.petty_cash_books[\s\S]*?SET current_balance = current_balance - v_gross[\s\S]*?WHERE id = v_book_id;/,
    'Repost with amount or book change must adjust balance accurately',
  );
});

test('4. Display transaction in Petty Cash Book history, Payment Voucher history, and GL ledger', () => {
  // PettyCashManager fetches petty_cash_books and links them
  assert.match(
    pettyCashSource,
    /const \[pettyCashBooks, setPettyCashBooks\] = useState<[^>]*>\(\[\]\);/,
    'PettyCashManager must hold petty cash books state',
  );
  assert.match(
    pettyCashSource,
    /from\('petty_cash_books'\)\s*\.select\('id, name, float_amount, current_balance'\)/,
    'PettyCashManager must load petty cash books',
  );
  assert.match(
    pettyCashSource,
    /tx\.payment_voucher_id/,
    'PettyCashManager handles transaction linked to payment voucher',
  );

  // PettyCashManager displays book name in KPI cards and transaction table
  assert.match(
    pettyCashSource,
    /Book:\s*\{pettyCashBooks\[0\]\.name\}/,
    'PettyCashManager must display active petty cash book in KPI summary',
  );
  assert.match(
    pettyCashSource,
    /tx\.petty_cash_books\?\.name/,
    'PettyCashManager displays Petty Cash Book name for transactions',
  );

  // PaymentVoucherManager loads and displays petty cash book
  assert.match(
    pvManagerSource,
    /petty_cash_books:petty_cash_book_id\(id, name\)/,
    'PaymentVoucherManager must fetch petty_cash_books relation',
  );
  assert.match(
    pvManagerSource,
    /viewingVoucher\.petty_cash_books\?\.name/,
    'PaymentVoucherManager must render petty cash book name in voucher details modal',
  );
});

test('5. Journal entry uses correct debit account based on Payment Purpose and credits GL 1102', () => {
  // Credit is GL 1102 for petty cash
  assert.match(
    migrationSource,
    /SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header[\s\S]*?FROM public\.chart_of_accounts[\s\S]*?WHERE code = '1102'/,
    'Credit account must resolve to GL 1102 (Petty Cash)',
  );

  // Debit for salary advance: GL 1160
  assert.match(
    migrationSource,
    /IF v_pv\.payment_purpose = 'salary_advance' THEN[\s\S]*?SELECT id INTO v_debit_coa FROM public\.chart_of_accounts WHERE code = '1160'/,
    'Debit account for salary advance must resolve to GL 1160 (Staff Advances)',
  );

  // Debit for supplier advance: GL 1170
  assert.match(
    migrationSource,
    /IF v_pv\.payment_purpose = 'supplier_advance' OR v_pv\.settlement_against = 'advance' THEN[\s\S]*?WHERE code = '1170'/,
    'Debit account for supplier advance must resolve to GL 1170 (Supplier Advances)',
  );

  // Debit for supplier invoice / AP: GL 2110
  assert.match(
    migrationSource,
    /SELECT id INTO v_debit_coa FROM public\.chart_of_accounts WHERE code = '2110'/,
    'Debit account for supplier payable must resolve to GL 2110 (Accounts Payable)',
  );

  // Journal entry generation credits v_bank_coa (1102) and debits v_debit_coa
  assert.match(
    migrationSource,
    /INSERT INTO public\.journal_entry_lines \([\s\S]*?account_id, description, debit, credit[\s\S]*?\) VALUES \([\s\S]*?v_debit_coa,[\s\S]*?v_ap_carrying_functional, 0/,
    'Line 1 debits v_debit_coa',
  );
  assert.match(
    migrationSource,
    /INSERT INTO public\.journal_entry_lines \([\s\S]*?account_id, description, debit, credit[\s\S]*?\) VALUES \([\s\S]*?v_bank_coa,[\s\S]*?0,[\s\S]*?round\(v_actual/,
    'Line 3 credits v_bank_coa (GL 1102)',
  );
});

test('6. For Salary Advance: Debit Staff Advances (1160), Credit Petty Cash (1102), and do not classify as an expense', () => {
  // Not classified as expense: expense_category set to NULL in both insert and update
  assert.match(
    migrationSource,
    /CASE WHEN v_pv\.payment_purpose = 'salary_advance' THEN NULL ELSE 'Operating Expense' END/,
    'Salary advance petty cash transaction must have expense_category = NULL on insert',
  );
  assert.match(
    migrationSource,
    /expense_category = CASE WHEN v_pv\.payment_purpose = 'salary_advance' THEN NULL ELSE/,
    'Salary advance petty cash transaction must maintain expense_category = NULL on update',
  );

  // validate_expense_category_assignment trigger exemption for payment vouchers
  assert.match(
    migrationSource,
    /IF TG_TABLE_NAME = 'petty_cash_transactions' AND \([\s\S]*?NEW\.payment_voucher_id IS NOT NULL/,
    'validate_expense_category_assignment must bypass required category constraint for payment vouchers',
  );

  // PettyCashManager UI reflects Staff Advance badge and Balance Sheet (Advance)
  assert.match(
    pettyCashSource,
    /\{tx\.expense_category === null \? 'Staff Advance' : 'Voucher Outflow'\}/,
    'PettyCashManager UI must display Staff Advance badge instead of generic expense category',
  );
  assert.match(
    pettyCashSource,
    /'Balance Sheet \(Advance\)'/,
    'PettyCashManager UI must display Balance Sheet (Advance) for salary advance vouchers',
  );
});

test('7. For normal expenses, retain their appropriate expense GL classification', () => {
  // In post_payment_voucher, coa_account_id is respected if provided and valid
  assert.match(
    migrationSource,
    /IF v_pv\.coa_account_id IS NOT NULL[\s\S]*?AND v_pv\.coa_account_id IS DISTINCT FROM v_bank_coa[\s\S]*?AND NOT EXISTS \(SELECT 1 FROM public\.chart_of_accounts WHERE id = v_pv\.coa_account_id AND code IN \('1101', '1102', '111101'\)\) THEN[\s\S]*?v_debit_coa := v_pv\.coa_account_id;/,
    'Direct expense voucher preserves designated expense account',
  );
});

test('8. Prevent duplicate petty cash transactions when voucher is edited, reposted, or retried', () => {
  // Partial unique index enforces database invariant
  assert.match(
    migrationSource,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_pct_payment_voucher_id\s+ON public\.petty_cash_transactions\(payment_voucher_id\)\s+WHERE payment_voucher_id IS NOT NULL;/,
    'Unique index prevents duplicate petty cash transactions for the same payment voucher',
  );

  // post_payment_voucher handles repost/retry idempotently
  assert.match(
    migrationSource,
    /SELECT \* INTO v_pct FROM public\.petty_cash_transactions WHERE payment_voucher_id = p_pv_id FOR UPDATE;[\s\S]*?IF NOT FOUND THEN[\s\S]*?ELSE[\s\S]*?UPDATE public\.petty_cash_transactions[\s\S]*?WHERE id = v_pct\.id;/,
    'post_payment_voucher must update existing petty cash transaction rather than inserting a duplicate',
  );
});

test('9. Ensure reversal and cancellation correctly restore the petty cash balance and remove transaction', () => {
  // cancel_payment_voucher_posting restores book balance and removes linked transaction
  assert.match(
    migrationSource,
    /FOR v_pct IN SELECT \* FROM public\.petty_cash_transactions WHERE payment_voucher_id = p_pv_id LOOP[\s\S]*?SET current_balance = current_balance \+ v_pct\.amount,[\s\S]*?WHERE id = v_book_id;[\s\S]*?DELETE FROM public\.petty_cash_transactions WHERE id = v_pct\.id;[\s\S]*?END LOOP;/,
    'cancel_payment_voucher_posting must restore petty_cash_books.current_balance and delete linked petty cash transaction',
  );

  // Journal entry cancelled cleanly
  assert.match(
    migrationSource,
    /PERFORM\s+cancel_gl_posting\s*\(\s*v_je\.id,\s*p_pv_id,\s*'payment_vouchers',\s*p_cancelled_by,\s*p_reason/,
    'cancel_payment_voucher_posting calls cancel_gl_posting to reverse the GL entry',
  );
});

test('10. Do not create duplicate journal entries or duplicate cash movements', () => {
  // post_petty_cash_to_journal_fixed trigger ignores rows linked to payment vouchers
  assert.match(
    migrationSource,
    /IF NEW\.fund_transfer_id IS NOT NULL OR NEW\.payment_voucher_id IS NOT NULL THEN[\s\S]*?RETURN NEW;[\s\S]*?END IF;/,
    'post_petty_cash_to_journal_fixed must not generate duplicate journal entries for payment vouchers',
  );

  // PettyCashManager deduplicates cash activity
  assert.match(
    pettyCashSource,
    /const linkedPvIds = new Set\(\s*pettyCashTransactions\s*\.map\(\(t\) => t\.payment_voucher_id\)\s*\.filter\(Boolean\)\s*\);[\s\S]*?if \(linkedPvIds\.has\(pv\.id\)\)/,
    'PettyCashManager deduplicates unlinked payment vouchers so transactions are not shown twice',
  );
});

test('11. Chain integrity validation: validates against canonical Payment Voucher journal (source_module = payment)', () => {
  assert.match(
    migrationSource,
    /CREATE OR REPLACE FUNCTION public\.validate_petty_cash_chain_integrity\(\)/,
    'validate_petty_cash_chain_integrity must be defined',
  );

  // Checks payment voucher reference
  assert.match(
    migrationSource,
    /IF NEW\.payment_voucher_id IS NOT NULL THEN[\s\S]*?SELECT \* INTO v_pv\s*FROM public\.payment_vouchers\s*WHERE id = NEW\.payment_voucher_id/,
    'Chain integrity must verify linked payment voucher',
  );

  // Checks that canonical journal is source_module = payment, not petty_cash
  assert.match(
    migrationSource,
    /SELECT \* INTO v_je\s*FROM public\.journal_entries\s*WHERE id = v_pv\.journal_entry_id\s*AND source_module = 'payment'\s*AND reference_id = v_pv\.id\s*AND is_posted = true\s*AND NOT COALESCE\(is_reversed, false\);/,
    'Chain integrity must validate against active canonical payment journal entry',
  );

  // Checks that journal credits Petty Cash GL 1102
  assert.match(
    migrationSource,
    /abs\(v_pc_credit - round\(NEW\.amount \* COALESCE\(NULLIF\(v_pv\.exchange_rate, 0\), 1\), 2\)\) > 0\.01[\s\S]*?RAISE EXCEPTION 'Payment Voucher % journal does not credit Petty Cash GL 1102 for the transaction amount'/,
    'Chain integrity must verify credit to GL 1102 matches transaction amount',
  );

  // Preserves fund transfer and direct expense integrity checks
  assert.match(
    migrationSource,
    /IF NEW\.fund_transfer_id IS NOT NULL THEN/,
    'Fund transfer integrity check must remain intact',
  );
  assert.match(
    migrationSource,
    /WHERE je\.source_module = 'petty_cash'\s*AND je\.reference_id = NEW\.id/,
    'Direct petty cash expense integrity check must remain intact',
  );
});
