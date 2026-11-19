-- Migration: 20261118220000_correct_sandi_pv028_petty_cash_funding.sql
-- Description:
-- 1. Strictly asserts preconditions for Sandi's PV/26-26/028 (Rp 100,000), PV/26-26/023 (Rp 1,000,000),
--    PV/26-26/032 (Rp 1,100,000), and EXP/26/365 (Rp 2,500,000).
-- 2. Removes the erroneous salary advance application 4553f6bd-8e64-470a-adae-8eb21567e0a3 (Rp 100,000).
-- 3. Corrects PV/26-26/032 settlement: reverses overstated journal JE2611-0363 (Rp 1,100,000)
--    and issues balanced replacement settlement journal for Rp 1,000,000 (settling only genuine advance PV/023).
-- 4. Reclassifies PV/26-26/028 to void/cancelled salary advance metadata, superseded by canonical fund transfer.
-- 5. Creates canonical Bank -> Petty Cash Fund Transfer for Rp 100,000 dated 2026-10-22
--    with balanced journal (Dr 1102 Petty Cash Rp 100,000, Cr 111101 BCA Bank Rp 100,000)
--    and Transfer In petty cash transaction. Bank reconciliation remains pending (source statement line missing).
-- 6. Recalculates EXP/26/365: paid Rp 2,400,000 (Rp 1,400,000 bank + Rp 1,000,000 advance), outstanding Rp 100,000.
-- 7. Aligns payment_vouchers payment_method constraint and post_payment_voucher to support Petty Cash vs Cash in Hand routing.

DO $$
DECLARE
  c_sandi_staff_id CONSTANT uuid := '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc'::uuid;
  c_pv028_id CONSTANT uuid := '8a045a25-e2b4-4f7b-8a27-4312d86a547e'::uuid;
  c_pv023_id CONSTANT uuid := 'd024d570-3348-4c41-96ac-e83b2a91cae9'::uuid;
  c_pv032_id CONSTANT uuid := '75271c77-fc47-4ba7-b1fa-42cb4abd74ca'::uuid;
  c_exp365_id CONSTANT uuid := 'b266063e-9f1d-48e7-8728-a7828b704204'::uuid;
  c_app_erroneous_id CONSTANT uuid := '4553f6bd-8e64-470a-adae-8eb21567e0a3'::uuid;
  c_bca_bank_id CONSTANT uuid := 'bfe79829-07d1-48ed-8965-ff9d367d758e'::uuid;
  c_travel_book_id CONSTANT uuid := 'f974b5c5-b399-44e6-bfe9-2d8e78d2b7d8'::uuid;
  c_idempotency CONSTANT text := 'sandi-pv028-petty-cash-funding-correction-20261118-v1';

  v_existing RECORD;
  v_command_id uuid;
  v_pv028 RECORD;
  v_pv023 RECORD;
  v_pv032 RECORD;
  v_exp365 RECORD;
  v_app RECORD;
  v_je0363 RECORD;
  v_travel_book RECORD;
  v_rev_je_id uuid;
  v_repl_je_id uuid;
  v_ft_id uuid;
  v_ft_number text;
  v_ft_je_id uuid;
  v_actor uuid;
  v_bca_coa_id uuid;
  v_bca_active boolean;
  v_petty_cash_coa_id uuid;
  v_staff_adv_coa_id uuid;
  v_ap_coa_id uuid;
  v_before jsonb;
  v_after jsonb;
BEGIN
  -- ── 1. Idempotency Check ──────────────────────────────────────────────
  SELECT * INTO v_existing
  FROM public.finance_historical_repair_commands
  WHERE idempotency_key = c_idempotency;

  IF FOUND THEN
    RAISE NOTICE 'Sandi PV/028 petty cash funding repair has already been executed (idempotent). Command: %', v_existing.id;
    RETURN;
  END IF;

  -- ── 2. Precondition Assertions ─────────────────────────────────────────
  SELECT * INTO v_pv028 FROM public.payment_vouchers WHERE id = c_pv028_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Precondition failed: Payment voucher PV/26-26/028 (%) not found.', c_pv028_id;
  END IF;
  IF v_pv028.amount <> 100000 THEN
    RAISE EXCEPTION 'Precondition failed: PV/028 amount mismatch (expected 100,000, found %)', v_pv028.amount;
  END IF;
  IF v_pv028.staff_id <> c_sandi_staff_id THEN
    RAISE EXCEPTION 'Precondition failed: PV/028 staff_id mismatch (expected %, found %)', c_sandi_staff_id, v_pv028.staff_id;
  END IF;

  SELECT * INTO v_pv023 FROM public.payment_vouchers WHERE id = c_pv023_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Precondition failed: Genuine advance PV/26-26/023 not found.';
  END IF;
  IF v_pv023.amount <> 1000000 THEN
    RAISE EXCEPTION 'Precondition failed: PV/023 amount mismatch (expected 1,000,000, found %)', v_pv023.amount;
  END IF;
  IF v_pv023.staff_id <> c_sandi_staff_id THEN
    RAISE EXCEPTION 'Precondition failed: PV/023 staff_id mismatch (expected %, found %)', c_sandi_staff_id, v_pv023.staff_id;
  END IF;

  SELECT * INTO v_pv032 FROM public.payment_vouchers WHERE id = c_pv032_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Precondition failed: Settlement voucher PV/26-26/032 not found.';
  END IF;
  IF v_pv032.voucher_number <> 'PV/26-26/032' THEN
    RAISE EXCEPTION 'Precondition failed: PV/032 voucher_number mismatch (expected PV/26-26/032, found %)', v_pv032.voucher_number;
  END IF;
  IF v_pv032.staff_id <> c_sandi_staff_id THEN
    RAISE EXCEPTION 'Precondition failed: PV/032 staff_id mismatch (expected %, found %)', c_sandi_staff_id, v_pv032.staff_id;
  END IF;
  IF v_pv032.amount <> 1100000 THEN
    RAISE EXCEPTION 'Precondition failed: PV/032 amount mismatch (expected 1,100,000, found %)', v_pv032.amount;
  END IF;
  IF v_pv032.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: Settlement voucher PV/032 has no linked journal entry.';
  END IF;

  SELECT * INTO v_exp365 FROM public.finance_expenses WHERE id = c_exp365_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Precondition failed: Salary expense EXP/26/365 not found.';
  END IF;
  IF v_exp365.amount <> 2500000 THEN
    RAISE EXCEPTION 'Precondition failed: EXP/26/365 amount mismatch (expected 2,500,000, found %)', v_exp365.amount;
  END IF;

  SELECT id INTO v_petty_cash_coa_id FROM public.chart_of_accounts WHERE code = '1102' AND is_active = true LIMIT 1;
  IF v_petty_cash_coa_id IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: Petty Cash COA 1102 not found.';
  END IF;

  SELECT coa_id, is_active INTO v_bca_coa_id, v_bca_active FROM public.bank_accounts WHERE id = c_bca_bank_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Precondition failed: BCA IDR bank account (%) not found.', c_bca_bank_id;
  END IF;
  IF v_bca_coa_id IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: BCA IDR bank account has no linked Chart of Accounts.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE id = v_bca_coa_id AND code = '111101') THEN
    RAISE EXCEPTION 'Precondition failed: BCA IDR bank account COA (%) is not 111101.', v_bca_coa_id;
  END IF;

  SELECT * INTO v_travel_book FROM public.petty_cash_books WHERE id = c_travel_book_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Precondition failed: Petty Cash book Travel (%) not found.', c_travel_book_id;
  END IF;
  IF NOT COALESCE(v_travel_book.is_active, false) THEN
    RAISE EXCEPTION 'Precondition failed: Petty Cash book Travel is inactive.';
  END IF;
  IF v_travel_book.account_id IS DISTINCT FROM v_petty_cash_coa_id THEN
    RAISE EXCEPTION 'Precondition failed: Petty Cash book Travel account_id does not match Petty Cash COA 1102.';
  END IF;

  SELECT id INTO v_staff_adv_coa_id FROM public.chart_of_accounts WHERE code = '1160' AND is_active = true LIMIT 1;
  IF v_staff_adv_coa_id IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: Staff Advances & Loans COA 1160 not found.';
  END IF;

  SELECT id INTO v_ap_coa_id FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true LIMIT 1;
  IF v_ap_coa_id IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: Accounts Payable COA 2110 not found.';
  END IF;

  SELECT * INTO v_je0363 FROM public.journal_entries WHERE id = v_pv032.journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Precondition failed: Settlement journal entry % not found.', v_pv032.journal_entry_id;
  END IF;
  IF v_je0363.entry_number <> 'JE2611-0363' THEN
    RAISE EXCEPTION 'Precondition failed: Settlement journal entry number mismatch (expected JE2611-0363, found %)', v_je0363.entry_number;
  END IF;
  IF NOT COALESCE(v_je0363.is_posted, false) THEN
    RAISE EXCEPTION 'Precondition failed: Settlement journal JE2611-0363 must be posted.';
  END IF;
  IF COALESCE(v_je0363.is_reversed, false) THEN
    RAISE EXCEPTION 'Precondition failed: Settlement journal JE2611-0363 is already reversed.';
  END IF;
  IF v_je0363.total_debit <> 1100000 OR v_je0363.total_credit <> 1100000 THEN
    RAISE EXCEPTION 'Precondition failed: JE2611-0363 totals mismatch (expected 1,100,000, found Dr %, Cr %)', v_je0363.total_debit, v_je0363.total_credit;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.journal_entry_lines
    WHERE journal_entry_id = v_je0363.id
      AND account_id = v_ap_coa_id
      AND debit = 1100000
  ) OR NOT EXISTS (
    SELECT 1 FROM public.journal_entry_lines
    WHERE journal_entry_id = v_je0363.id
      AND account_id = v_staff_adv_coa_id
      AND credit = 1100000
  ) THEN
    RAISE EXCEPTION 'Precondition failed: JE2611-0363 lines do not match expected Dr AP 2110 / Cr Staff Advances 1160 for Rp 1,100,000.';
  END IF;

  SELECT * INTO v_app FROM public.salary_advance_applications WHERE id = c_app_erroneous_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Precondition failed: Erroneous salary advance application % not found.', c_app_erroneous_id;
  END IF;
  IF v_app.advance_payment_voucher_id <> c_pv028_id THEN
    RAISE EXCEPTION 'Precondition failed: Advance application advance_payment_voucher_id mismatch (expected %, found %)', c_pv028_id, v_app.advance_payment_voucher_id;
  END IF;
  IF v_app.settlement_payment_voucher_id <> c_pv032_id THEN
    RAISE EXCEPTION 'Precondition failed: Advance application settlement_payment_voucher_id mismatch (expected %, found %)', c_pv032_id, v_app.settlement_payment_voucher_id;
  END IF;
  IF v_app.salary_expense_id <> c_exp365_id THEN
    RAISE EXCEPTION 'Precondition failed: Advance application salary_expense_id mismatch (expected %, found %)', c_exp365_id, v_app.salary_expense_id;
  END IF;
  IF v_app.applied_amount <> 100000 THEN
    RAISE EXCEPTION 'Precondition failed: Advance application applied_amount mismatch (expected 100,000, found %)', v_app.applied_amount;
  END IF;

  v_actor := COALESCE(auth.uid(), v_pv028.created_by);

  -- Capture before state preserving the complete erroneous application row and original journal
  v_before := jsonb_build_object(
    'pv028', row_to_json(v_pv028),
    'pv032', row_to_json(v_pv032),
    'exp365_paid', v_exp365.paid_amount,
    'erroneous_application', row_to_json(v_app),
    'application_row', row_to_json(v_app),
    'original_settlement_journal', row_to_json(v_je0363)
  );

  -- ── 3. Establish Historical Repair Context ────────────────────────────
  INSERT INTO public.finance_historical_repair_commands(
    idempotency_key, document_type, document_id, payment_kind,
    operation, requested_by, before_state, after_state, status
  ) VALUES (
    c_idempotency, 'expense', c_exp365_id, 'supplier',
    'restate_salary_net_of_advance', v_actor, v_before, '{}'::jsonb, 'committed'
  ) RETURNING id INTO v_command_id;

  PERFORM set_config('app.finance_historical_repair_command', v_command_id::text, true);
  PERFORM set_config('app.finance_historical_repair', 'on', true);
  PERFORM set_config('app.finance_metadata_repair', 'on', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- ── 4. Remove Erroneous Advance Application (Rp 100,000) ──────────────
  DELETE FROM public.salary_advance_applications
  WHERE id = c_app_erroneous_id;
  RAISE NOTICE 'Removed erroneous salary advance application % (preserved in finance_historical_repair_commands: %)', c_app_erroneous_id, v_command_id;

  -- ── 5. Reclassify / Supersede PV/26-26/028 ─────────────────────────────
  UPDATE public.payment_vouchers
  SET salary_advance_applied_amount = 0,
      salary_advance_status = 'not_applicable',
      status = 'cancelled',
      description = 'SUPERSEDED: Reclassified to Bank -> Petty Cash Fund Transfer'
  WHERE id = c_pv028_id;
  RAISE NOTICE 'PV/26-26/028 reclassified to not_applicable/cancelled';

  -- ── 6. Reverse Overstated Settlement Journal JE2611-0363 & Reissue Rp 1m ─
  -- Create Reversal Journal Entry
  INSERT INTO public.journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_at, created_at
  ) VALUES (
    public.next_journal_entry_number(),
    COALESCE(v_je0363.entry_date, DATE '2026-10-30'),
    'historical_repair',
    c_pv032_id,
    'REV-' || v_je0363.entry_number,
    'Historical reversal of overstated salary advance settlement PV/26-26/032',
    1100000, 1100000, true, now(), now()
  ) RETURNING id INTO v_rev_je_id;

  INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, staff_id)
  VALUES
    (v_rev_je_id, 1, v_staff_adv_coa_id, 'Historical reversal: Clear Staff Advances - PV/26-26/032', 1100000, 0, c_sandi_staff_id),
    (v_rev_je_id, 2, v_ap_coa_id, 'Historical reversal: Clear Accounts Payable - PV/26-26/032', 0, 1100000, c_sandi_staff_id);

  UPDATE public.journal_entries
  SET is_reversed = true,
      reversed_by_id = v_rev_je_id
  WHERE id = v_je0363.id;
  RAISE NOTICE 'Reversed JE2611-0363 via reversal journal %', v_rev_je_id;

  -- Create Replacement Settlement Journal for Rp 1,000,000
  INSERT INTO public.journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_at, created_at
  ) VALUES (
    public.next_journal_entry_number(),
    DATE '2026-10-30',
    'payment',
    c_pv032_id,
    'PV/26-26/032',
    'Corrected salary advance settlement for Sandi Prasetyo (PV/26-26/023 Rp 1,000,000)',
    1000000, 1000000, true, now(), now()
  ) RETURNING id INTO v_repl_je_id;

  INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, staff_id)
  VALUES
    (v_repl_je_id, 1, v_ap_coa_id, 'Staff Payment - PV/26-26/032 (Salary Advance Settlement)', 1000000, 0, c_sandi_staff_id),
    (v_repl_je_id, 2, v_staff_adv_coa_id, 'Advance Adjustment - PV/26-26/032 (Clear PV/26-26/023)', 0, 1000000, c_sandi_staff_id);

  UPDATE public.payment_vouchers
  SET amount = 1000000,
      journal_entry_id = v_repl_je_id,
      is_posted = true,
      description = 'Corrected salary advance settlement for Sandi Prasetyo (PV/26-26/023 Rp 1,000,000)'
  WHERE id = c_pv032_id;
  RAISE NOTICE 'PV/26-26/032 updated to Rp 1,000,000 with replacement journal %', v_repl_je_id;

  -- ── 7. Refresh Genuine Advance PV/26-26/023 ────────────────────────────
  PERFORM public.refresh_salary_advance_status(c_pv023_id);

  -- ── 8. Create Canonical Bank -> Petty Cash Fund Transfer ───────────────
  v_ft_number := public.generate_fund_transfer_number();

  INSERT INTO public.fund_transfers (
    transfer_number,
    transfer_date,
    amount,
    from_amount,
    to_amount,
    exchange_rate,
    from_account_type,
    to_account_type,
    from_bank_account_id,
    to_bank_account_id,
    from_bank_statement_line_id,
    to_bank_statement_line_id,
    description,
    status,
    created_by
  ) VALUES (
    v_ft_number,
    DATE '2026-10-22',
    100000,
    100000,
    100000,
    1,
    'bank',
    'petty_cash',
    c_bca_bank_id,
    NULL,
    NULL,  -- 22 Oct Rp 100k line missing from imported bank statement; reconciliation pending
    NULL,
    'Petty Cash Funding — Sandi Prasetyo',
    'pending',
    v_actor
  ) RETURNING id INTO v_ft_id;

  -- Post Fund Transfer Journal: Dr 1102 Petty Cash Rp 100k, Cr 111101 BCA Bank Rp 100k
  v_ft_je_id := public.post_fund_transfer_journal(v_ft_id, v_actor);
  RAISE NOTICE 'Fund transfer % created and posted with journal %', v_ft_number, v_ft_je_id;

  -- Insert canonical Petty Cash Inflow Transaction
  INSERT INTO public.petty_cash_transactions (
    transaction_date,
    transaction_type,
    amount,
    description,
    bank_account_id,
    bank_statement_line_id,
    source,
    fund_transfer_id,
    approval_status,
    created_by
  ) VALUES (
    DATE '2026-10-22',
    'withdraw', -- Inflow into petty cash
    100000,
    'Fund Transfer from Bank BCA - IDR (0930201014) - Petty Cash Funding — Sandi Prasetyo',
    c_bca_bank_id,
    NULL,
    'Fund Transfer ' || v_ft_number,
    v_ft_id,
    'approved',
    v_actor
  )
  ON CONFLICT (fund_transfer_id) WHERE fund_transfer_id IS NOT NULL DO NOTHING;

  -- ── 9. Clear Historical Repair Context ─────────────────────────────────
  PERFORM set_config('app.finance_historical_repair', 'off', true);
  PERFORM set_config('app.finance_metadata_repair', 'off', true);

  -- ── 10. Recalculate Expense Payment State for EXP/26/365 ────────────────
  PERFORM public.recalculate_expense_payment_state(c_exp365_id);

  SELECT * INTO v_exp365 FROM public.finance_expenses WHERE id = c_exp365_id;
  RAISE NOTICE 'EXP/26/365 recalculated: amount %, paid_amount %, outstanding %',
    v_exp365.amount, v_exp365.paid_amount, (v_exp365.amount - v_exp365.paid_amount);

  IF v_exp365.paid_amount <> 2400000 THEN
    RAISE EXCEPTION 'Assertion failed: EXP/26/365 paid_amount must be 2,400,000 (found %)', v_exp365.paid_amount;
  END IF;

  -- Capture after state
  v_after := jsonb_build_object(
    'fund_transfer_id', v_ft_id,
    'fund_transfer_number', v_ft_number,
    'fund_transfer_journal_id', v_ft_je_id,
    'reversal_journal_id', v_rev_je_id,
    'replacement_journal_id', v_repl_je_id,
    'exp365_paid', v_exp365.paid_amount,
    'exp365_outstanding', (v_exp365.amount - v_exp365.paid_amount)
  );

  UPDATE public.finance_historical_repair_commands
  SET after_state = v_after
  WHERE id = v_command_id;

  RAISE NOTICE 'Sandi PV/028 petty cash funding repair completed successfully.';
END $$;


-- ── 11. Schema & RPC Alignment: Payment Vouchers Cash vs Petty Cash ────────
BEGIN;

-- Ensure payment_vouchers CHECK constraint permits 'petty_cash'
ALTER TABLE public.payment_vouchers
  DROP CONSTRAINT IF EXISTS payment_vouchers_payment_method_check;

ALTER TABLE public.payment_vouchers
  ADD CONSTRAINT payment_vouchers_payment_method_check
  CHECK (
    payment_method = ANY (
      ARRAY[
        'cash',
        'petty_cash',
        'bank_transfer',
        'check',
        'giro',
        'other',
        'advance_adjustment'
      ]::text[]
    )
  );

-- Upgrade post_payment_voucher to route Petty Cash (1102) vs Cash on Hand (1101)
CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_pv                      public.payment_vouchers%ROWTYPE;
  v_bank_coa                UUID;
  v_bank_active             BOOLEAN;
  v_bank_is_header          BOOLEAN;
  v_debit_coa               UUID;
  v_fx_loss_coa             UUID;
  v_fx_gain_coa             UUID;
  v_je_id                   UUID;
  v_je_number               TEXT;
  v_actual_poster           UUID;
  v_party_type              TEXT;
  v_gross                   NUMERIC;
  v_charge_amt              NUMERIC;
  v_actual                  NUMERIC;
  v_rate                    NUMERIC;
  v_settle_diff             NUMERIC;
  v_bank_currency           TEXT;
  v_ap_relief_functional    NUMERIC;
  v_ap_carrying_functional  NUMERIC;
  v_realized_fx             NUMERIC;
  v_total_debit             NUMERIC;
  v_total_credit            NUMERIC;
  v_line                    INTEGER := 1;
  v_usd_bank_carrying_rate  NUMERIC := 1;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  v_actual_poster := COALESCE(auth.uid(), p_posted_by);

  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment voucher % not found', p_pv_id;
  END IF;

  IF v_pv.is_posted THEN
    RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number;
  END IF;

  v_party_type := lower(COALESCE(
    v_pv.party_type,
    CASE 
      WHEN v_pv.staff_id IS NOT NULL OR v_pv.payment_purpose LIKE 'salary_%' OR v_pv.payment_purpose LIKE '%employee%' THEN 'employee'
      WHEN v_pv.customer_id IS NOT NULL OR v_pv.payment_purpose LIKE 'customer_%' THEN 'customer'
      ELSE 'supplier'
    END
  ));
  IF v_pv.payment_purpose = 'salary_advance' THEN
    v_party_type := 'employee';
  END IF;

  v_gross := COALESCE(v_pv.amount, 0);
  v_charge_amt := COALESCE(v_pv.bank_charge, 0);
  v_settle_diff := COALESCE(v_pv.settlement_discount, 0);
  v_actual := COALESCE(v_pv.actual_bank_debit, v_pv.bank_amount, v_gross + v_charge_amt);
  v_rate := COALESCE(NULLIF(v_pv.exchange_rate, 0), 1);
  v_bank_currency := COALESCE(v_pv.currency_code, v_pv.transaction_currency, 'IDR');

  -- Resolve Bank / Credit Account
  IF v_pv.payment_method IN ('bank_transfer', 'check', 'giro') THEN
    IF v_pv.bank_account_id IS NULL THEN
      RAISE EXCEPTION 'Bank account selection is mandatory for % payments (voucher %)', v_pv.payment_method, v_pv.voucher_number;
    END IF;

    SELECT ba.coa_id, ba.is_active, coa.is_header, upper(ba.currency)
    INTO v_bank_coa, v_bank_active, v_bank_is_header, v_bank_currency
    FROM public.bank_accounts ba
    LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
    WHERE ba.id = v_pv.bank_account_id;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'Bank account % has no linked Chart of Accounts', v_pv.bank_account_id;
    END IF;
    IF NOT COALESCE(v_bank_active, false) THEN
      RAISE EXCEPTION 'Linked bank GL account % is inactive', v_bank_coa;
    END IF;
    IF COALESCE(v_bank_is_header, false) THEN
      RAISE EXCEPTION 'Linked bank GL account % is a header account — leaf required', v_bank_coa;
    END IF;

    IF v_bank_currency = 'USD' THEN
      SELECT 
        CASE 
          WHEN NULLIF(SUM(jel.transaction_debit - jel.transaction_credit), 0) IS NOT NULL AND SUM(jel.transaction_debit - jel.transaction_credit) > 0 THEN 
            round(SUM(jel.debit - jel.credit) / SUM(jel.transaction_debit - jel.transaction_credit), 4)
          ELSE 
            COALESCE(
              (SELECT frl.revalued_rate
               FROM public.fx_revaluation_lines frl
               JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
               WHERE frl.bank_account_id = v_pv.bank_account_id
                 AND fr.status = 'posted'
                 AND fr.revaluation_date <= v_pv.voucher_date
               ORDER BY fr.revaluation_date DESC, fr.created_at DESC
               LIMIT 1),
              v_rate
            )
        END
      INTO v_usd_bank_carrying_rate
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = v_bank_coa 
        AND je.is_posted = true 
        AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date <= v_pv.voucher_date;

      v_usd_bank_carrying_rate := COALESCE(v_usd_bank_carrying_rate, v_rate);
    END IF;

  ELSIF v_pv.payment_method = 'advance_adjustment' THEN
    SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
    FROM public.chart_of_accounts
    WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'Staff Advances account (1160) missing or inactive';
    END IF;

  ELSIF v_pv.payment_method IN ('cash', 'petty_cash') THEN
    -- Route Petty Cash (1102) vs Cash on Hand (1101)
    IF v_pv.payment_method = 'petty_cash'
       OR (v_pv.coa_account_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE id = v_pv.coa_account_id AND code = '1102'))
       OR v_pv.description ILIKE '%petty cash%' THEN
      IF NOT EXISTS (SELECT 1 FROM public.petty_cash_books WHERE is_active = true) THEN
        RAISE EXCEPTION 'Cannot post petty cash payment: no active petty cash book found';
      END IF;
      SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
      FROM public.chart_of_accounts
      WHERE code = '1102' AND is_active = true AND is_header = false LIMIT 1;
    ELSE
      SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
      FROM public.chart_of_accounts
      WHERE code = '1101' AND is_active = true AND is_header = false LIMIT 1;
    END IF;

    IF v_bank_coa IS NULL THEN
      IF v_pv.payment_method = 'cash' THEN
        RAISE EXCEPTION 'Cash on Hand (GL 1101) is currently inactive in Chart of Accounts. Use active Petty Cash (GL 1102) instead.';
      ELSE
        RAISE EXCEPTION 'No active postable Cash/Petty Cash GL account found (GL 1101/1102)';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported payment method: % for payment voucher %', v_pv.payment_method, v_pv.voucher_number;
  END IF;

  -- Resolve Standard Chart of Accounts
  SELECT id INTO v_fx_loss_coa FROM public.chart_of_accounts WHERE code = '7300' AND is_active = true LIMIT 1;
  SELECT id INTO v_fx_gain_coa FROM public.chart_of_accounts WHERE code = '4930' AND is_active = true LIMIT 1;

  -- Resolve Debit Control Account
  -- coa_account_id cannot be used simultaneously as the cash credit account and supplier liability debit account
  IF v_party_type = 'supplier' THEN
    IF v_pv.payment_purpose = 'supplier_advance' OR v_pv.settlement_against = 'advance' THEN
      IF v_pv.coa_account_id IS NOT NULL
         AND v_pv.coa_account_id IS DISTINCT FROM v_bank_coa
         AND NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE id = v_pv.coa_account_id AND code IN ('1101', '1102', '111101')) THEN
        v_debit_coa := v_pv.coa_account_id;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1170' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    ELSE
      IF v_pv.coa_account_id IS NOT NULL
         AND v_pv.coa_account_id IS DISTINCT FROM v_bank_coa
         AND NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE id = v_pv.coa_account_id AND code IN ('1101', '1102', '111101')) THEN
        v_debit_coa := v_pv.coa_account_id;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;

    -- Compute Carrying Value vs Settlement Value
    SELECT 
      COALESCE(SUM(va.allocated_amount), 0),
      COALESCE(SUM(va.allocated_amount * COALESCE(
        (SELECT frl.revalued_rate
         FROM public.fx_revaluation_lines frl
         JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
         WHERE frl.purchase_invoice_id = va.purchase_invoice_id
           AND fr.status = 'posted'
           AND fr.revaluation_date <= v_pv.voucher_date
         ORDER BY fr.revaluation_date DESC, fr.created_at DESC
         LIMIT 1),
        pi.exchange_rate,
        1
      )), 0)
    INTO v_ap_relief_functional, v_ap_carrying_functional
    FROM public.voucher_allocations va
    JOIN public.purchase_invoices pi ON pi.id = va.purchase_invoice_id
    WHERE va.payment_voucher_id = v_pv.id;

    IF v_ap_carrying_functional = 0 THEN
      v_ap_carrying_functional := v_gross * v_rate;
    END IF;

    -- Compute Realized FX
    IF v_bank_currency = 'USD' THEN
      v_realized_fx := round(v_ap_carrying_functional - (v_actual * v_usd_bank_carrying_rate), 2);
    ELSE
      v_realized_fx := round(v_ap_carrying_functional - (v_gross * v_rate), 2);
    END IF;

  ELSIF v_party_type = 'customer' THEN
    SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1130' AND is_active = true AND is_header = false LIMIT 1;
    v_ap_carrying_functional := v_gross * v_rate;
    v_realized_fx := 0;

  ELSIF v_party_type = 'employee' THEN
    IF v_pv.payment_purpose = 'salary_advance' THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_ap_carrying_functional := v_gross * v_rate;
    v_realized_fx := 0;

  ELSE
    SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
    v_ap_carrying_functional := v_gross * v_rate;
    v_realized_fx := 0;
  END IF;

  IF v_debit_coa IS NULL THEN
    RAISE EXCEPTION 'Could not determine debit control account for party %', v_party_type;
  END IF;

  IF v_debit_coa = v_bank_coa THEN
    RAISE EXCEPTION 'Accounting conflict: Debit control account (%) and credit payment account (%) cannot be identical for payment voucher %',
      v_debit_coa, v_bank_coa, v_pv.voucher_number;
  END IF;

  -- Create Journal Entry
  v_je_number := public.next_journal_entry_number();
  
  IF v_bank_currency = 'USD' THEN
    v_total_credit := round(v_actual * v_usd_bank_carrying_rate, 2);
  ELSE
    v_total_credit := round(v_actual * v_rate, 2);
  END IF;

  v_total_debit := v_ap_carrying_functional;
  IF v_settle_diff > 0 THEN
    v_total_debit := v_total_debit - round(v_settle_diff * v_rate, 2);
  END IF;

  IF v_realized_fx > 0 THEN
    v_total_credit := v_total_credit + v_realized_fx;
  ELSIF v_realized_fx < 0 THEN
    v_total_debit := v_total_debit + abs(v_realized_fx);
  END IF;

  INSERT INTO public.journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by,
    transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_je_number, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number,
    'Payment Voucher ' || v_pv.voucher_number || COALESCE(' - ' || v_pv.description, ''),
    GREATEST(v_total_debit, v_total_credit), GREATEST(v_total_debit, v_total_credit),
    true, v_actual_poster,
    v_bank_currency, 'IDR', CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE v_rate END
  ) RETURNING id INTO v_je_id;

  -- Line 1: Debit Control Account
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit,
    supplier_id, customer_id, staff_id,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate
  ) VALUES (
    v_je_id, v_line, v_debit_coa,
    CASE 
      WHEN v_pv.payment_purpose = 'salary_advance' THEN 'Salary Advance - '
      WHEN v_pv.payment_method = 'advance_adjustment' THEN 'Staff Payment (Advance Settlement) - '
      ELSE 'Payment Settlement - ' 
    END || v_pv.voucher_number,
    v_ap_carrying_functional, 0,
    v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id,
    v_bank_currency, v_gross, 0, v_rate
  );
  v_line := v_line + 1;

  -- Line 2: Realized FX Loss
  IF v_realized_fx < 0 AND v_fx_loss_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      supplier_id, customer_id, staff_id,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate
    ) VALUES (
      v_je_id, v_line, v_fx_loss_coa,
      'Realized FX Loss - ' || v_pv.voucher_number,
      abs(v_realized_fx), 0,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id,
      'IDR', abs(v_realized_fx), 0, 1
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3: Credit Bank / Cash / Advance Account
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit,
    supplier_id, customer_id, staff_id,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate
  ) VALUES (
    v_je_id, v_line, v_bank_coa,
    CASE 
      WHEN v_pv.payment_method = 'advance_adjustment' THEN 'Advance Adjustment - '
      WHEN v_pv.payment_method = 'petty_cash' OR v_bank_coa = (SELECT id FROM public.chart_of_accounts WHERE code = '1102' LIMIT 1) THEN 'Petty Cash Payment - '
      WHEN v_pv.payment_method = 'cash' THEN 'Cash in Hand Payment - '
      ELSE 'Bank Payment - ' 
    END || v_pv.voucher_number,
    0, 
    CASE WHEN v_bank_currency = 'USD' THEN round(v_actual * v_usd_bank_carrying_rate, 2) ELSE round(v_actual * v_rate, 2) END,
    v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id,
    v_bank_currency, 0, v_actual, CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE v_rate END
  );
  v_line := v_line + 1;

  -- Line 4: Realized FX Gain
  IF v_realized_fx > 0 AND v_fx_gain_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      supplier_id, customer_id, staff_id,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate
    ) VALUES (
      v_je_id, v_line, v_fx_gain_coa,
      'Realized FX Gain - ' || v_pv.voucher_number,
      0, v_realized_fx,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id,
      'IDR', 0, v_realized_fx, 1
    );
    v_line := v_line + 1;
  END IF;

  -- Update Payment Voucher
  UPDATE public.payment_vouchers
  SET journal_entry_id = v_je_id,
      is_posted = true,
      status = 'approved',
      updated_at = now()
  WHERE id = p_pv_id;

  RETURN;
END;
$$;

-- Upgrade trigger guard to support finance repair context bypass
CREATE OR REPLACE FUNCTION public.guard_settled_salary_advance_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('app.finance_historical_repair', true) = 'on'
     OR current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- Only guard vouchers with salary_advance purpose that have active payroll applications or settled status
  IF OLD.payment_purpose = 'salary_advance' AND (
    OLD.salary_advance_status IN ('settled', 'partially_settled')
    OR COALESCE(OLD.salary_advance_applied_amount, 0) > 0
    OR EXISTS (
      SELECT 1 FROM public.salary_advance_applications saa
      WHERE saa.advance_payment_voucher_id = OLD.id
    )
  ) THEN
    -- Lock accounting fields from being changed via ordinary updates
    IF NEW.amount IS DISTINCT FROM OLD.amount OR
       NEW.staff_id IS DISTINCT FROM OLD.staff_id OR
       NEW.payment_method IS DISTINCT FROM OLD.payment_method OR
       NEW.payment_purpose IS DISTINCT FROM OLD.payment_purpose OR
       NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id OR
       NEW.voucher_date IS DISTINCT FROM OLD.voucher_date OR
       NEW.pph_amount IS DISTINCT FROM OLD.pph_amount OR
       NEW.pph_code_id IS DISTINCT FROM OLD.pph_code_id OR
       NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate OR
       NEW.payment_currency IS DISTINCT FROM OLD.payment_currency
    THEN
      RAISE EXCEPTION 'Cannot edit accounting fields on salary advance %: advance is already applied to payroll (status: %, applied: Rp %). Reverse or unapply the payroll settlement first.',
        OLD.voucher_number, OLD.salary_advance_status, OLD.salary_advance_applied_amount;
    END IF;

    -- Prevent accidental reset of salary_advance_status while applications exist
    IF (OLD.salary_advance_status IN ('settled', 'partially_settled') AND NEW.salary_advance_status = 'outstanding')
       AND EXISTS (SELECT 1 FROM public.salary_advance_applications saa WHERE saa.advance_payment_voucher_id = OLD.id)
    THEN
      RAISE EXCEPTION 'Cannot reset salary advance % status to outstanding while active payroll applications exist.', OLD.voucher_number;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
