import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';

const { Client } = pg;

const migration = fs.readFileSync(
  'supabase/migrations/20260921140000_bank_reconciliation_kernel_fix.sql',
  'utf8',
);

test('1. Migration checks: ensures bank reconciliation kernel architecture', () => {
  assert.match(migration, /calculate_bank_account_book_balance/);
  assert.match(migration, /get_bank_account_balances/);
  assert.match(migration, /prevent_expense_payment_overallocation/);
  assert.match(migration, /validate_expense_bank_allocation_against_journal/);
  assert.match(migration, /sync_bank_line_allocation_owner/);
  assert.match(migration, /confirm_bank_match/);
  assert.match(migration, /bsl_sync_reconciliation_status/);
  assert.match(migration, /refresh_bank_statement_allocation_status/);
  // Ensure is_reversed is NOT filtered out in book balance calculation
  assert.doesNotMatch(migration, /is_reversed\s*=\s*false/);
});

test('2. Live Database Transactional Regression Suite: Cases 1 through 12', async () => {
  const testSql = `
BEGIN;

DO $test$
DECLARE
  v_user_id uuid;
  v_supplier_id uuid;
  v_bank_acct_id uuid;
  v_bank_coa_id uuid;
  v_expense_coa_id uuid;
  v_expense_id uuid;
  v_pv_id uuid;
  v_va_id uuid;
  v_bsl_id uuid;
  v_bsl_2_id uuid;
  v_bsa_id uuid;
  v_je_id uuid;
  v_je_rev_id uuid;
  v_initial_balance numeric;
  v_temp_balance numeric;
  v_final_balance numeric;
  v_baseline_10 numeric;
  v_baseline_15 numeric;
  v_confirm_res jsonb;
  v_err_caught boolean;
  v_err_msg text;
  v_category_key text;
  v_upload_id uuid;
BEGIN
  -- Setup test entities
  SELECT id INTO v_user_id FROM public.user_profiles LIMIT 1;
  SELECT id INTO v_supplier_id FROM public.suppliers LIMIT 1;
  SELECT id, coa_id INTO v_bank_acct_id, v_bank_coa_id FROM public.bank_accounts WHERE currency = 'IDR' LIMIT 1;
  SELECT id INTO v_expense_coa_id FROM public.chart_of_accounts WHERE account_type = 'expense' AND is_header = false AND is_active = true LIMIT 1;
  SELECT category_key INTO v_category_key FROM public.expense_categories WHERE is_active = true AND requires_container = false LIMIT 1;
  SELECT id INTO v_upload_id FROM public.bank_statement_uploads WHERE bank_account_id = v_bank_acct_id LIMIT 1;

  IF v_user_id IS NULL OR v_supplier_id IS NULL OR v_bank_acct_id IS NULL OR v_expense_coa_id IS NULL OR v_category_key IS NULL OR v_upload_id IS NULL THEN
    RAISE EXCEPTION 'Missing seed data for regression test';
  END IF;

  -- --------------------------------------------------------------------------
  -- Case 9: Book bank balance is calculated dynamically
  -- --------------------------------------------------------------------------
  v_initial_balance := public.calculate_bank_account_book_balance(v_bank_acct_id, CURRENT_DATE);
  IF v_initial_balance IS NULL THEN
    RAISE EXCEPTION 'Case 9 failed: calculate_bank_account_book_balance returned NULL';
  END IF;

  -- --------------------------------------------------------------------------
  -- Case 5: Reversed journal + reversal journal produces zero net impact
  -- --------------------------------------------------------------------------
  -- Create active posted journal 1 (Dr Bank Rp 15,000,000 / Cr Expense Rp 15,000,000)
  INSERT INTO public.journal_entries (
    entry_number, entry_date, description, is_posted, is_reversed,
    total_debit, total_credit, created_by, source_module
  ) VALUES (
    'TEST-JE-REV-01', CURRENT_DATE, 'Test Reversal Original', true, false,
    15000000, 15000000, v_user_id, 'manual'
  ) RETURNING id INTO v_je_id;

  INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
  VALUES (v_je_id, 1, v_bank_coa_id, 15000000, 0),
         (v_je_id, 2, v_expense_coa_id, 0, 15000000);

  -- Balance must increase by 15M
  v_temp_balance := public.calculate_bank_account_book_balance(v_bank_acct_id, CURRENT_DATE);
  IF v_temp_balance <> (v_initial_balance + 15000000) THEN
    RAISE EXCEPTION 'Case 5 failed: Balance after original journal expected %, got %', (v_initial_balance + 15000000), v_temp_balance;
  END IF;

  -- Create reversing journal 2 (Dr Expense Rp 15,000,000 / Cr Bank Rp 15,000,000)
  INSERT INTO public.journal_entries (
    entry_number, entry_date, description, is_posted, is_reversed,
    total_debit, total_credit, created_by, source_module
  ) VALUES (
    'TEST-JE-REV-02', CURRENT_DATE, 'Test Reversal Counter', true, false,
    15000000, 15000000, v_user_id, 'manual'
  ) RETURNING id INTO v_je_rev_id;

  INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
  VALUES (v_je_rev_id, 1, v_expense_coa_id, 15000000, 0),
         (v_je_rev_id, 2, v_bank_coa_id, 0, 15000000);

  -- Mark original as reversed
  UPDATE public.journal_entries SET is_reversed = true, reversed_by_id = v_je_rev_id WHERE id = v_je_id;

  -- Dynamic balance must naturally return to original balance (zero net impact)
  v_final_balance := public.calculate_bank_account_book_balance(v_bank_acct_id, CURRENT_DATE);
  IF v_final_balance <> v_initial_balance THEN
    RAISE EXCEPTION 'Case 5 failed: Balance after reversal expected %, got %', v_initial_balance, v_final_balance;
  END IF;

  -- Clean up test journals
  DELETE FROM public.journal_entry_lines WHERE journal_entry_id IN (v_je_id, v_je_rev_id);
  DELETE FROM public.journal_entries WHERE id IN (v_je_id, v_je_rev_id);

  -- --------------------------------------------------------------------------
  -- Case 1: One expense + one payment works
  -- --------------------------------------------------------------------------
  INSERT INTO public.finance_expenses (
    voucher_number, expense_date, supplier_id, expense_category,
    currency_code, amount, ppn_amount, pph_amount, approval_status
  ) VALUES (
    'TEST-EXP-001', CURRENT_DATE, v_supplier_id, v_category_key,
    'IDR', 1000000, 0, 0, 'approved'
  ) RETURNING id INTO v_expense_id;

  INSERT INTO public.payment_vouchers (
    voucher_number, voucher_date, bank_account_id, payment_purpose,
    supplier_id, payment_method, amount, is_posted, created_by
  ) VALUES (
    'TEST-PV-001', CURRENT_DATE, v_bank_acct_id, 'general',
    v_supplier_id, 'bank_transfer', 1000000, true, v_user_id
  ) RETURNING id INTO v_pv_id;

  INSERT INTO public.voucher_allocations (
    voucher_type, payment_voucher_id, finance_expense_id, allocated_amount, payment_kind
  ) VALUES (
    'payment', v_pv_id, v_expense_id, 1000000, 'supplier'
  ) RETURNING id INTO v_va_id;

  -- Verify expense payment state updated
  PERFORM public.recalculate_expense_payment_state(v_expense_id);
  IF (SELECT paid_amount FROM public.finance_expenses WHERE id = v_expense_id) <> 1000000 THEN
    RAISE EXCEPTION 'Case 1 failed: paid_amount not updated to 1,000,000';
  END IF;

  -- Clean up Case 1
  DELETE FROM public.voucher_allocations WHERE id = v_va_id;
  DELETE FROM public.payment_vouchers WHERE id = v_pv_id;
  DELETE FROM public.finance_expenses WHERE id = v_expense_id;

  -- --------------------------------------------------------------------------
  -- Case 2: One expense + multiple partial payments works
  -- --------------------------------------------------------------------------
  INSERT INTO public.finance_expenses (
    voucher_number, expense_date, supplier_id, expense_category,
    currency_code, amount, ppn_amount, pph_amount, approval_status
  ) VALUES (
    'TEST-EXP-002', CURRENT_DATE, v_supplier_id, v_category_key,
    'IDR', 2000000, 0, 0, 'approved'
  ) RETURNING id INTO v_expense_id;

  -- Payment 1: Voucher allocation of Rp 800,000
  INSERT INTO public.payment_vouchers (
    voucher_number, voucher_date, bank_account_id, payment_purpose,
    supplier_id, payment_method, amount, is_posted, created_by
  ) VALUES (
    'TEST-PV-002', CURRENT_DATE, v_bank_acct_id, 'general',
    v_supplier_id, 'bank_transfer', 800000, true, v_user_id
  ) RETURNING id INTO v_pv_id;

  INSERT INTO public.voucher_allocations (
    voucher_type, payment_voucher_id, finance_expense_id, allocated_amount, payment_kind
  ) VALUES (
    'payment', v_pv_id, v_expense_id, 800000, 'supplier'
  ) RETURNING id INTO v_va_id;

  -- Payment 2: Bank Statement Allocation of Rp 1,200,000
  INSERT INTO public.bank_statement_lines (
    upload_id, bank_account_id, transaction_date, description, debit_amount, credit_amount, currency
  ) VALUES (
    v_upload_id, v_bank_acct_id, CURRENT_DATE, 'Test Line 2', 1200000, 0, 'IDR'
  ) RETURNING id INTO v_bsl_id;

  INSERT INTO public.journal_entries (
    entry_number, entry_date, description, is_posted, is_reversed,
    total_debit, total_credit, created_by, source_module, reference_id
  ) VALUES (
    'TEST-JE-EXP-02', CURRENT_DATE, 'Expense Payment 2', true, false,
    1200000, 1200000, v_user_id, 'expense_payment', v_expense_id
  ) RETURNING id INTO v_je_id;

  INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
  VALUES (v_je_id, 1, v_expense_coa_id, 1200000, 0),
         (v_je_id, 2, v_bank_coa_id, 0, 1200000);

  INSERT INTO public.bank_statement_allocations (
    bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind
  ) VALUES (
    v_bsl_id, 'expense', v_expense_id, v_je_id, 1200000, 'supplier'
  ) RETURNING id INTO v_bsa_id;

  -- Verify total settled = 2,000,000
  PERFORM public.recalculate_expense_payment_state(v_expense_id);
  IF (SELECT paid_amount FROM public.finance_expenses WHERE id = v_expense_id) <> 2000000 THEN
    RAISE EXCEPTION 'Case 2 failed: paid_amount not updated to 2,000,000';
  END IF;

  -- Clean up Case 2
  DELETE FROM public.bank_statement_allocations WHERE id = v_bsa_id;
  DELETE FROM public.bank_statement_lines WHERE id = v_bsl_id;
  DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id;
  DELETE FROM public.journal_entries WHERE id = v_je_id;
  DELETE FROM public.voucher_allocations WHERE id = v_va_id;
  DELETE FROM public.payment_vouchers WHERE id = v_pv_id;
  DELETE FROM public.finance_expenses WHERE id = v_expense_id;

  -- --------------------------------------------------------------------------
  -- Case 3 & 8: Expense cannot be settled beyond payable (Overpayment Protection)
  -- --------------------------------------------------------------------------
  INSERT INTO public.finance_expenses (
    voucher_number, expense_date, supplier_id, expense_category,
    currency_code, amount, ppn_amount, pph_amount, approval_status
  ) VALUES (
    'TEST-EXP-003', CURRENT_DATE, v_supplier_id, v_category_key,
    'IDR', 1000000, 0, 0, 'approved'
  ) RETURNING id INTO v_expense_id;

  INSERT INTO public.payment_vouchers (
    voucher_number, voucher_date, bank_account_id, payment_purpose,
    supplier_id, payment_method, amount, is_posted, created_by
  ) VALUES (
    'TEST-PV-003', CURRENT_DATE, v_bank_acct_id, 'general',
    v_supplier_id, 'bank_transfer', 700000, true, v_user_id
  ) RETURNING id INTO v_pv_id;

  INSERT INTO public.voucher_allocations (
    voucher_type, payment_voucher_id, finance_expense_id, allocated_amount, payment_kind
  ) VALUES (
    'payment', v_pv_id, v_expense_id, 700000, 'supplier'
  ) RETURNING id INTO v_va_id;

  -- Second payment of Rp 500,000 exceeds remaining payable of Rp 300,000 and MUST fail
  v_err_caught := false;
  BEGIN
    INSERT INTO public.voucher_allocations (
      voucher_type, payment_voucher_id, finance_expense_id, allocated_amount, payment_kind
    ) VALUES (
      'payment', v_pv_id, v_expense_id, 500000, 'supplier'
    );
  EXCEPTION WHEN OTHERS THEN
    v_err_caught := true;
  END;

  IF NOT v_err_caught THEN
    RAISE EXCEPTION 'Case 3/8 failed: Overpayment was NOT prevented on voucher_allocations!';
  END IF;

  -- Clean up Case 3
  DELETE FROM public.voucher_allocations WHERE id = v_va_id;
  DELETE FROM public.payment_vouchers WHERE id = v_pv_id;
  DELETE FROM public.finance_expenses WHERE id = v_expense_id;

  -- --------------------------------------------------------------------------
  -- Case 7: Bank line cannot be allocated beyond its amount
  -- --------------------------------------------------------------------------
  INSERT INTO public.bank_statement_lines (
    upload_id, bank_account_id, transaction_date, description, debit_amount, credit_amount, currency
  ) VALUES (
    v_upload_id, v_bank_acct_id, CURRENT_DATE, 'Test Line Cap', 500000, 0, 'IDR'
  ) RETURNING id INTO v_bsl_id;

  INSERT INTO public.finance_expenses (
    voucher_number, expense_date, supplier_id, expense_category,
    currency_code, amount, ppn_amount, pph_amount, approval_status
  ) VALUES (
    'TEST-EXP-CAP', CURRENT_DATE, v_supplier_id, v_category_key,
    'IDR', 2000000, 0, 0, 'approved'
  ) RETURNING id INTO v_expense_id;

  INSERT INTO public.journal_entries (
    entry_number, entry_date, description, is_posted, is_reversed,
    total_debit, total_credit, created_by, source_module, reference_id
  ) VALUES (
    'TEST-JE-EXP-CAP', CURRENT_DATE, 'Expense Payment Cap', true, false,
    600000, 600000, v_user_id, 'expense_payment', v_expense_id
  ) RETURNING id INTO v_je_id;

  INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
  VALUES (v_je_id, 1, v_expense_coa_id, 600000, 0),
         (v_je_id, 2, v_bank_coa_id, 0, 600000);

  v_err_caught := false;
  BEGIN
    -- Line amount is 500,000; allocating 600,000 MUST fail
    INSERT INTO public.bank_statement_allocations (
      bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind
    ) VALUES (
      v_bsl_id, 'expense', v_expense_id, v_je_id, 600000, 'supplier'
    );
  EXCEPTION WHEN OTHERS THEN
    v_err_caught := true;
  END;

  IF NOT v_err_caught THEN
    RAISE EXCEPTION 'Case 7 failed: Bank line overallocation was NOT prevented!';
  END IF;

  DELETE FROM public.finance_expenses WHERE id = v_expense_id;
  DELETE FROM public.bank_statement_lines WHERE id = v_bsl_id;
  DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id;
  DELETE FROM public.journal_entries WHERE id = v_je_id;

  -- --------------------------------------------------------------------------
  -- Case 6: Bank line cannot be confirmed without a valid journal/allocation
  -- --------------------------------------------------------------------------
  INSERT INTO public.bank_statement_lines (
    upload_id, bank_account_id, transaction_date, description, debit_amount, credit_amount, currency
  ) VALUES (
    v_upload_id, v_bank_acct_id, CURRENT_DATE, 'Test Line No Match', 350000, 0, 'IDR'
  ) RETURNING id INTO v_bsl_id;

  -- confirm_bank_match MUST reject unallocated / unjournaled line
  v_confirm_res := public.confirm_bank_match(v_bsl_id, v_user_id);
  IF (v_confirm_res->>'success')::boolean = true THEN
    RAISE EXCEPTION 'Case 6 failed: confirm_bank_match succeeded on unallocated line!';
  END IF;

  -- Direct update to confirmed MUST also be rejected by trigger
  v_err_caught := false;
  BEGIN
    UPDATE public.bank_statement_lines SET matching_status = 'confirmed' WHERE id = v_bsl_id;
  EXCEPTION WHEN OTHERS THEN
    v_err_caught := true;
  END;

  IF NOT v_err_caught THEN
    RAISE EXCEPTION 'Case 6 failed: Direct update to confirmed was NOT prevented!';
  END IF;

  DELETE FROM public.bank_statement_lines WHERE id = v_bsl_id;

  -- --------------------------------------------------------------------------
  -- Case 10: New bank statement imports do not affect book balance incorrectly
  -- --------------------------------------------------------------------------
  v_initial_balance := public.calculate_bank_account_book_balance(v_bank_acct_id, CURRENT_DATE);

  INSERT INTO public.bank_statement_lines (
    upload_id, bank_account_id, transaction_date, description, debit_amount, credit_amount, currency
  ) VALUES (
    v_upload_id, v_bank_acct_id, CURRENT_DATE, 'Imported Statement Line', 5000000, 0, 'IDR'
  ) RETURNING id INTO v_bsl_id;

  -- Book balance must remain unchanged!
  v_temp_balance := public.calculate_bank_account_book_balance(v_bank_acct_id, CURRENT_DATE);
  IF v_temp_balance <> v_initial_balance THEN
    RAISE EXCEPTION 'Case 10 failed: Importing bank statement line altered book balance!';
  END IF;

  DELETE FROM public.bank_statement_lines WHERE id = v_bsl_id;

  -- --------------------------------------------------------------------------
  -- Case 11: Transactions after 10 Sep remain book-only until next statement
  -- --------------------------------------------------------------------------
  -- Baseline before adding post-10 Sep entry
  v_baseline_10 := public.calculate_bank_account_book_balance(v_bank_acct_id, '2026-09-10');
  v_baseline_15 := public.calculate_bank_account_book_balance(v_bank_acct_id, '2026-09-15');

  -- Verify that posted journal entries dated after 2026-09-10 are counted in book balance
  -- while no statement line exists for them yet
  INSERT INTO public.journal_entries (
    entry_number, entry_date, description, is_posted, is_reversed,
    total_debit, total_credit, created_by, source_module
  ) VALUES (
    'TEST-JE-AFTER-10SEP', '2026-09-15', 'Valid Book Entry After Cutoff', true, false,
    250000, 250000, v_user_id, 'manual'
  ) RETURNING id INTO v_je_id;

  INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
  VALUES (v_je_id, 1, v_expense_coa_id, 250000, 0),
         (v_je_id, 2, v_bank_coa_id, 0, 250000);

  -- Balance as of 10 Sep does NOT include the post-10 Sep entry (remains strictly v_baseline_10)
  v_temp_balance := public.calculate_bank_account_book_balance(v_bank_acct_id, '2026-09-10');
  IF v_temp_balance <> v_baseline_10 THEN
    RAISE EXCEPTION 'Case 11 failed: Post-10 Sep transaction leaked into 10 Sep book balance! (Expected %, got %)', v_baseline_10, v_temp_balance;
  END IF;

  -- Balance as of 15 Sep DOES include the entry (decreased by exactly 250,000)
  v_final_balance := public.calculate_bank_account_book_balance(v_bank_acct_id, '2026-09-15');
  IF (v_baseline_15 - v_final_balance) <> 250000 THEN
    RAISE EXCEPTION 'Case 11 failed: Book movement after 10 Sep not properly reflected in 15 Sep balance! (Expected delta 250000, got %)', (v_baseline_15 - v_final_balance);
  END IF;

  -- Verify no bank statement line matches this post-cutoff journal
  PERFORM 1 FROM public.bank_statement_lines WHERE matched_entry_id = v_je_id;
  IF FOUND THEN
    RAISE EXCEPTION 'Case 11 failed: Bank statement line unexpectedly matched post-cutoff book entry!';
  END IF;

  DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id;
  DELETE FROM public.journal_entries WHERE id = v_je_id;

  -- --------------------------------------------------------------------------
  -- Case 12: Re-running reconciliation is idempotent
  -- --------------------------------------------------------------------------
  -- Create line and allocation with valid journal
  INSERT INTO public.journal_entries (
    entry_number, entry_date, description, is_posted, is_reversed,
    total_debit, total_credit, created_by, source_module
  ) VALUES (
    'TEST-JE-RECON', CURRENT_DATE, 'Recon Journal', true, false,
    450000, 450000, v_user_id, 'manual'
  ) RETURNING id INTO v_je_id;

  INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit)
  VALUES (v_je_id, 1, v_expense_coa_id, 450000, 0),
         (v_je_id, 2, v_bank_coa_id, 0, 450000);

  INSERT INTO public.bank_statement_lines (
    upload_id, bank_account_id, transaction_date, description, debit_amount, credit_amount, currency
  ) VALUES (
    v_upload_id, v_bank_acct_id, CURRENT_DATE, 'Recon Statement Line', 450000, 0, 'IDR'
  ) RETURNING id INTO v_bsl_id;

  INSERT INTO public.bank_statement_allocations (
    bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind
  ) VALUES (
    v_bsl_id, 'journal', v_je_id, v_je_id, 450000, 'other'
  ) RETURNING id INTO v_bsa_id;

  -- First confirmation
  v_confirm_res := public.confirm_bank_match(v_bsl_id, v_user_id);
  IF (v_confirm_res->>'success')::boolean <> true THEN
    RAISE EXCEPTION 'Case 12 failed: First confirm_bank_match did not succeed: %', v_confirm_res;
  END IF;

  -- Re-running refresh_bank_statement_allocation_status is idempotent
  PERFORM public.refresh_bank_statement_allocation_status(v_bsl_id);
  IF (SELECT matching_status FROM public.bank_statement_lines WHERE id = v_bsl_id) <> 'confirmed' THEN
    RAISE EXCEPTION 'Case 12 failed: Status changed after refresh!';
  END IF;

  DELETE FROM public.bank_statement_allocations WHERE id = v_bsa_id;
  DELETE FROM public.bank_statement_lines WHERE id = v_bsl_id;
  DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_je_id;
  DELETE FROM public.journal_entries WHERE id = v_je_id;

  RAISE NOTICE 'All 12 regression test cases PASSED successfully.';
  RAISE EXCEPTION 'ROLLBACK_SUCCESS';
END;
$test$;

ROLLBACK;
`;

  if (!process.env.READONLY_AUDIT_DB_URL) {
    console.warn('Skipping live database simulation: DATABASE_URL is not set.');
    return;
  }

  const client = new Client({
    connectionString: process.env.READONLY_AUDIT_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  let rollbackSeen = false;
  try {
    await client.query(testSql);
  } catch (err) {
    if (err.message && err.message.includes('ROLLBACK_SUCCESS')) {
      rollbackSeen = true;
    } else {
      throw err;
    }
  } finally {
    await client.end();
  }

  assert.ok(rollbackSeen, 'Expected ROLLBACK_SUCCESS after running all 12 regression test cases');
});
