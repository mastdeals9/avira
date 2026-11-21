-- Migration: 20261121231500_sandi_prasetyo_petty_cash_salary_advance_correction.sql
-- Description:
-- 1. Hardens post_payment_voucher() to handle paid_by_staff_id safely when staff_id references finance_staff_master without a profile record.
-- 2. Asserts preconditions for Sandi Prasetyo's PV/26-26/028 (Rp 100,000), FT2611-0002 (Rp 100,000), PC-202610-030 (Rp 100,000), and Petty Cash Book.
-- 3. Renames the sole active Petty Cash Book ('Travel') to 'General Petty Cash' preserving its ID, float, balance and GL account (1102).
-- 4. Reverses the erroneous bank-to-petty-cash transfer FT2611-0002 via reverse_fund_transfer() creating balanced reversal journal REV-FT2611-0002 (Dr 111101 BCA Rp 100,000, Cr 1102 Petty Cash Rp 100,000).
-- 5. Rejects and explains erroneous Petty Cash inflow PC-202610-030 without deletion.
-- 6. Restores original Payment Voucher PV/26-26/028 to approved, unposted employee salary advance from Petty Cash.
-- 7. Posts PV/26-26/028 through post_payment_voucher():
--    - Creates single authoritative journal: Dr 1160 Staff Advances & Loans Rp 100,000 / Cr 1102 Petty Cash Rp 100,000.
--    - Deducts Rp 100,000 from General Petty Cash book balance (100,000 -> 0).
--    - Creates exactly one linked Petty Cash outflow transaction for Sandi Prasetyo (expense, approved, expense_category NULL).
--    - Sets salary advance status to outstanding (Rp 100,000) available for future payroll settlement.
-- 8. Asserts complete before and after states and records audit entry in finance_historical_repair_commands.

-- Step 1: Harden post_payment_voucher for safe paid_by_staff_id resolution
CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pv                      RECORD;
  v_je_id                   UUID;
  v_je_number               TEXT;
  v_actual_poster           UUID;
  v_bank_coa                UUID;
  v_bank_active             BOOLEAN;
  v_bank_is_header          BOOLEAN;
  v_debit_coa               UUID;
  v_fx_loss_coa             UUID;
  v_fx_gain_coa             UUID;
  v_rate                    NUMERIC := 1;
  v_actual                  NUMERIC;
  v_gross                   NUMERIC;
  v_charge_amt              NUMERIC := 0;
  v_settle_diff             NUMERIC := 0;
  v_bank_currency           TEXT := 'IDR';
  v_party_type              TEXT;
  v_usd_bank_carrying_rate  NUMERIC := 1;
  v_ap_carrying_functional  NUMERIC := 0;
  v_ap_relief_functional    NUMERIC := 0;
  v_realized_fx             NUMERIC := 0;
  v_line                    INTEGER := 1;
  v_total_debit             NUMERIC := 0;
  v_total_credit            NUMERIC := 0;
  v_book_id                 UUID;
  v_pct                     RECORD;
  v_payee_name              TEXT;
BEGIN
  PERFORM public._sec_check_finance_role();

  v_actual_poster := COALESCE(p_posted_by, auth.uid());
  IF v_actual_poster IS NULL THEN
    IF current_user = 'service_role' OR session_user = 'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      v_actual_poster := 'a0000000-0000-0000-0000-000000000001'::uuid;
    ELSE
      RAISE EXCEPTION 'Not authenticated';
    END IF;
  END IF;

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
       OR v_pv.petty_cash_book_id IS NOT NULL
       OR (v_pv.coa_account_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE id = v_pv.coa_account_id AND code = '1102'))
       OR v_pv.description ILIKE '%petty cash%' THEN

      IF NOT EXISTS (SELECT 1 FROM public.petty_cash_books WHERE is_active = true) THEN
        RAISE EXCEPTION 'Cannot post petty cash payment: no active petty cash book found';
      END IF;

      -- Resolve and validate petty_cash_book_id
      IF v_pv.petty_cash_book_id IS NOT NULL THEN
        SELECT id INTO v_book_id
        FROM public.petty_cash_books
        WHERE id = v_pv.petty_cash_book_id AND is_active = true;

        IF v_book_id IS NULL THEN
          RAISE EXCEPTION 'Selected petty cash book is inactive or not found';
        END IF;
      ELSE
        SELECT id INTO v_book_id
        FROM public.petty_cash_books
        WHERE is_active = true
        ORDER BY created_at ASC
        LIMIT 1;

        UPDATE public.payment_vouchers
        SET petty_cash_book_id = v_book_id
        WHERE id = p_pv_id;
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

  -- Resolve Payee display name
  IF v_pv.supplier_id IS NOT NULL THEN
    SELECT company_name INTO v_payee_name FROM public.suppliers WHERE id = v_pv.supplier_id;
  ELSIF v_pv.staff_id IS NOT NULL THEN
    SELECT full_name INTO v_payee_name FROM public.finance_staff_master WHERE id = v_pv.staff_id;
  ELSIF v_pv.customer_id IS NOT NULL THEN
    SELECT company_name INTO v_payee_name FROM public.customers WHERE id = v_pv.customer_id;
  END IF;
  v_payee_name := COALESCE(v_payee_name, v_pv.description, 'Payee');

  -- Petty Cash Synchronization: Create/Sync exactly one outgoing transaction and deduct from book balance
  IF v_bank_coa = (SELECT id FROM public.chart_of_accounts WHERE code = '1102' LIMIT 1) THEN
    SELECT * INTO v_pct FROM public.petty_cash_transactions WHERE payment_voucher_id = p_pv_id FOR UPDATE;
    IF NOT FOUND THEN
      -- Deduct from petty cash book balance
      UPDATE public.petty_cash_books
      SET current_balance = current_balance - v_gross,
          updated_at = now()
      WHERE id = v_book_id;

      INSERT INTO public.petty_cash_transactions (
        transaction_date,
        transaction_type,
        amount,
        description,
        expense_category,
        paid_to,
        paid_by_staff_id,
        paid_by,
        voucher_number,
        source,
        payment_voucher_id,
        petty_cash_book_id,
        approval_status,
        approved_by,
        approved_at,
        created_by
      ) VALUES (
        v_pv.voucher_date,
        'expense',
        v_gross,
        COALESCE(v_pv.description, 'Payment Voucher ' || v_pv.voucher_number),
        CASE WHEN v_pv.payment_purpose = 'salary_advance' THEN NULL ELSE 'Operating Expense' END,
        v_payee_name,
        CASE WHEN EXISTS (SELECT 1 FROM public.profiles WHERE id = v_pv.staff_id) THEN v_pv.staff_id ELSE NULL END,
        'cash',
        v_pv.voucher_number,
        'Payment Voucher ' || v_pv.voucher_number,
        v_pv.id,
        v_book_id,
        'approved',
        v_actual_poster,
        now(),
        v_actual_poster
      );
    ELSE
      -- Idempotent update on retry or repost
      IF v_pct.amount <> v_gross OR v_pct.petty_cash_book_id IS DISTINCT FROM v_book_id THEN
        IF v_pct.petty_cash_book_id IS NOT NULL THEN
          UPDATE public.petty_cash_books
          SET current_balance = current_balance + v_pct.amount,
              updated_at = now()
          WHERE id = v_pct.petty_cash_book_id;
        END IF;
        UPDATE public.petty_cash_books
        SET current_balance = current_balance - v_gross,
            updated_at = now()
        WHERE id = v_book_id;
      END IF;

      UPDATE public.petty_cash_transactions
      SET amount = v_gross,
          transaction_date = v_pv.voucher_date,
          description = COALESCE(v_pv.description, 'Payment Voucher ' || v_pv.voucher_number),
          expense_category = CASE WHEN v_pv.payment_purpose = 'salary_advance' THEN NULL ELSE COALESCE(v_pct.expense_category, 'Operating Expense') END,
          paid_to = v_payee_name,
          paid_by_staff_id = CASE WHEN EXISTS (SELECT 1 FROM public.profiles WHERE id = v_pv.staff_id) THEN v_pv.staff_id ELSE NULL END,
          approval_status = 'approved',
          approved_by = v_actual_poster,
          approved_at = now(),
          updated_at = now()
      WHERE id = v_pct.id;
    END IF;
  END IF;

  -- Update Payment Voucher
  UPDATE public.payment_vouchers
  SET journal_entry_id = v_je_id,
      is_posted = true,
      status = 'approved',
      petty_cash_book_id = COALESCE(v_book_id, petty_cash_book_id),
      updated_at = now()
  WHERE id = p_pv_id;

  -- Recalculate Purchase Invoice balances and states
  IF v_party_type = 'supplier' THEN
    PERFORM public.recalculate_purchase_invoice_payment_state(va.purchase_invoice_id)
    FROM public.voucher_allocations va
    WHERE va.payment_voucher_id = p_pv_id AND va.purchase_invoice_id IS NOT NULL;
  END IF;

  -- Recalculate Expense balances and states if allocated
  PERFORM public.recalculate_expense_payment_state(va.finance_expense_id)
  FROM public.voucher_allocations va
  WHERE va.payment_voucher_id = p_pv_id AND va.finance_expense_id IS NOT NULL;

  -- Synchronize bank account current_balance with authoritative GL
  IF v_pv.bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_pv.bank_account_id);
  END IF;

  RETURN;
END;
$function$;


-- Step 2: Historical Correction & Posting
DO $$
DECLARE
  c_sandi_staff_id CONSTANT uuid := '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc'::uuid;
  c_pv028_id       CONSTANT uuid := '8a045a25-e2b4-4f7b-8a27-4312d86a547e'::uuid;
  c_ft_id          CONSTANT uuid := '865b9a2d-9224-4937-b56c-cd587189399a'::uuid;
  c_pc30_id        CONSTANT uuid := '9115476c-f7c6-409e-986c-12877ce47fbc'::uuid;
  c_book_id        CONSTANT uuid := 'f974b5c5-b399-44e6-bfe9-2d8e78d2b7d8'::uuid;
  c_actor          CONSTANT uuid := '1075a773-bb55-4296-bc71-af2eab9a0780'::uuid;
  c_idempotency    CONSTANT text := 'sandi-pv028-petty-cash-salary-advance-final-20261121-v1';

  v_existing RECORD;
  v_pv       RECORD;
  v_ft       RECORD;
  v_pc       RECORD;
  v_book     RECORD;
  v_gl1102_bal numeric;
  v_rev_je_id  uuid;
  v_pv_after   RECORD;
  v_ft_after   RECORD;
  v_pc_after   RECORD;
  v_book_after RECORD;
  v_new_pct_count integer;
  v_new_pct    RECORD;
  v_pv_je      RECORD;
  v_je_line_count integer;
  v_line1      RECORD;
  v_line2      RECORD;
  v_before     jsonb;
  v_after      jsonb;
BEGIN
  -- 1. Idempotency Check
  SELECT * INTO v_existing
  FROM public.finance_historical_repair_commands
  WHERE idempotency_key = c_idempotency;

  IF FOUND THEN
    RAISE NOTICE 'Sandi PV/028 petty cash advance correction has already been executed (idempotent). Command: %', v_existing.id;
    RETURN;
  END IF;

  -- 2. Lock Target Records
  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id = c_pv028_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Precondition failed: Payment Voucher PV/26-26/028 (%) not found', c_pv028_id;
  END IF;

  SELECT * INTO v_ft FROM public.fund_transfers WHERE id = c_ft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Precondition failed: Fund Transfer FT2611-0002 (%) not found', c_ft_id;
  END IF;

  SELECT * INTO v_pc FROM public.petty_cash_transactions WHERE id = c_pc30_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Precondition failed: Petty Cash transaction PC-202610-030 (%) not found', c_pc30_id;
  END IF;

  SELECT * INTO v_book FROM public.petty_cash_books WHERE id = c_book_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Precondition failed: Petty Cash Book (%) not found', c_book_id;
  END IF;

  -- 3. Assertions
  IF v_pv.voucher_number <> 'PV/26-26/028' THEN
    RAISE EXCEPTION 'Precondition failed: PV voucher_number mismatch: %', v_pv.voucher_number;
  END IF;
  IF v_pv.staff_id <> c_sandi_staff_id THEN
    RAISE EXCEPTION 'Precondition failed: PV staff_id mismatch: %', v_pv.staff_id;
  END IF;
  IF v_pv.amount <> 100000 THEN
    RAISE EXCEPTION 'Precondition failed: PV amount mismatch: %', v_pv.amount;
  END IF;
  IF v_pv.is_posted = true THEN
    RAISE EXCEPTION 'Precondition failed: PV is already posted';
  END IF;
  IF v_pv.status <> 'cancelled' THEN
    RAISE EXCEPTION 'Precondition failed: PV status is not cancelled (found %)', v_pv.status;
  END IF;

  IF EXISTS (SELECT 1 FROM public.salary_advance_applications WHERE advance_payment_voucher_id = c_pv028_id) THEN
    RAISE EXCEPTION 'Precondition failed: Unexpected active salary advance application found for PV/028';
  END IF;

  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE reference_id = c_pv028_id AND is_posted = true AND is_reversed = false) THEN
    RAISE EXCEPTION 'Precondition failed: Active journal entry already exists for PV/028';
  END IF;

  IF v_ft.transfer_number <> 'FT2611-0002' OR v_ft.amount <> 100000 OR v_ft.status <> 'posted' THEN
    RAISE EXCEPTION 'Precondition failed: FT2611-0002 state mismatch (amount=%, status=%)', v_ft.amount, v_ft.status;
  END IF;

  IF v_pc.transaction_number <> 'PC-202610-030' OR v_pc.amount <> 100000 OR v_pc.fund_transfer_id <> c_ft_id THEN
    RAISE EXCEPTION 'Precondition failed: PC-202610-030 state mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bank_statement_lines
    WHERE matched_entry_id = v_ft.journal_entry_id
  ) THEN
    RAISE EXCEPTION 'Precondition failed: Bank statement line matched to FT2611-0002 journal';
  END IF;

  -- 4. Verify Genuine Funds Availability
  IF v_book.current_balance < 100000 THEN
    RAISE EXCEPTION 'Critical Precondition failed: Petty Cash Book balance (%) is below required Rp 100,000', v_book.current_balance;
  END IF;

  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
  INTO v_gl1102_bal
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code = '1102' AND je.is_posted = true AND je.is_reversed = false;

  IF v_gl1102_bal < 100000 THEN
    RAISE EXCEPTION 'Critical Precondition failed: GL 1102 net balance (%) is insufficient', v_gl1102_bal;
  END IF;

  v_before := jsonb_build_object(
    'payment_voucher', to_jsonb(v_pv),
    'fund_transfer', to_jsonb(v_ft),
    'petty_cash_transaction', to_jsonb(v_pc),
    'petty_cash_book', to_jsonb(v_book),
    'gl1102_balance_before', v_gl1102_bal
  );

  -- 5. Rename Petty Cash Book to 'General Petty Cash'
  UPDATE public.petty_cash_books
  SET name = 'General Petty Cash',
      updated_at = now()
  WHERE id = c_book_id;

  -- 6. Reverse FT2611-0002
  v_rev_je_id := public.reverse_fund_transfer(c_ft_id);

  -- 7. Reject PC-202610-030 with audit justification
  UPDATE public.petty_cash_transactions
  SET approval_status = 'rejected',
      rejection_reason = 'Reversed: Linked fund transfer FT2611-0002 was reversed (Reclassified as Salary Advance PV/26-26/028 paid from Petty Cash, not Bank->Petty Cash transfer)',
      updated_at = now()
  WHERE id = c_pc30_id;

  -- 8. Restore Payment Voucher PV/26-26/028 to approved, unposted employee salary advance
  UPDATE public.payment_vouchers
  SET status = 'approved',
      is_posted = false,
      journal_entry_id = null,
      party_type = 'employee',
      payment_purpose = 'salary_advance',
      payment_method = 'petty_cash',
      petty_cash_book_id = c_book_id,
      bank_account_id = null,
      salary_advance_status = 'outstanding',
      salary_advance_applied_amount = 0,
      description = 'Salary Advance paid in cash to Sandi Prasetyo – Petty Cash',
      updated_at = now()
  WHERE id = c_pv028_id;

  -- 9. Post PV/26-26/028 through post_payment_voucher()
  PERFORM public.post_payment_voucher(c_pv028_id, c_actor);

  -- 10. Post-Execution Assertions
  SELECT * INTO v_pv_after FROM public.payment_vouchers WHERE id = c_pv028_id;
  IF NOT v_pv_after.is_posted OR v_pv_after.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Post-condition failed: PV/028 was not successfully posted';
  END IF;

  SELECT * INTO v_ft_after FROM public.fund_transfers WHERE id = c_ft_id;
  IF v_ft_after.status <> 'reversed' THEN
    RAISE EXCEPTION 'Post-condition failed: FT2611-0002 status is not reversed (found %)', v_ft_after.status;
  END IF;

  SELECT * INTO v_pc_after FROM public.petty_cash_transactions WHERE id = c_pc30_id;
  IF v_pc_after.approval_status <> 'rejected' THEN
    RAISE EXCEPTION 'Post-condition failed: PC-202610-030 status is not rejected (found %)', v_pc_after.approval_status;
  END IF;

  SELECT * INTO v_book_after FROM public.petty_cash_books WHERE id = c_book_id;
  IF v_book_after.current_balance <> 0 THEN
    RAISE EXCEPTION 'Post-condition failed: General Petty Cash book balance is not 0 (found %)', v_book_after.current_balance;
  END IF;

  SELECT COUNT(*) INTO v_new_pct_count
  FROM public.petty_cash_transactions
  WHERE payment_voucher_id = c_pv028_id;

  IF v_new_pct_count <> 1 THEN
    RAISE EXCEPTION 'Post-condition failed: Expected exactly 1 linked Petty Cash transaction for PV/028, found %', v_new_pct_count;
  END IF;

  SELECT * INTO v_new_pct
  FROM public.petty_cash_transactions
  WHERE payment_voucher_id = c_pv028_id;

  IF v_new_pct.transaction_type <> 'expense' OR v_new_pct.amount <> 100000 OR v_new_pct.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'Post-condition failed: Linked Petty Cash transaction properties mismatch';
  END IF;

  SELECT * INTO v_pv_je FROM public.journal_entries WHERE id = v_pv_after.journal_entry_id;
  IF NOT v_pv_je.is_posted OR v_pv_je.is_reversed THEN
    RAISE EXCEPTION 'Post-condition failed: PV journal is not active';
  END IF;

  SELECT COUNT(*) INTO v_je_line_count
  FROM public.journal_entry_lines
  WHERE journal_entry_id = v_pv_after.journal_entry_id;

  IF v_je_line_count <> 2 THEN
    RAISE EXCEPTION 'Post-condition failed: Expected exactly 2 journal lines for PV/028, found %', v_je_line_count;
  END IF;

  SELECT jel.*, coa.code as coa_code INTO v_line1
  FROM public.journal_entry_lines jel
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE jel.journal_entry_id = v_pv_after.journal_entry_id AND jel.line_number = 1;

  SELECT jel.*, coa.code as coa_code INTO v_line2
  FROM public.journal_entry_lines jel
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE jel.journal_entry_id = v_pv_after.journal_entry_id AND jel.line_number = 2;

  IF v_line1.coa_code <> '1160' OR v_line1.debit <> 100000 OR v_line1.credit <> 0 THEN
    RAISE EXCEPTION 'Post-condition failed: Line 1 must be Dr 1160 Staff Advances Rp 100,000 (found % Dr % / Cr %)', v_line1.coa_code, v_line1.debit, v_line1.credit;
  END IF;

  IF v_line2.coa_code <> '1102' OR v_line2.credit <> 100000 OR v_line2.debit <> 0 THEN
    RAISE EXCEPTION 'Post-condition failed: Line 2 must be Cr 1102 Petty Cash Rp 100,000 (found % Dr % / Cr %)', v_line2.coa_code, v_line2.debit, v_line2.credit;
  END IF;

  v_after := jsonb_build_object(
    'payment_voucher', to_jsonb(v_pv_after),
    'fund_transfer', to_jsonb(v_ft_after),
    'petty_cash_transaction_old', to_jsonb(v_pc_after),
    'petty_cash_book', to_jsonb(v_book_after),
    'petty_cash_transaction_new', to_jsonb(v_new_pct),
    'reversal_journal_id', v_rev_je_id,
    'pv_journal', to_jsonb(v_pv_je),
    'pv_journal_line1', to_jsonb(v_line1),
    'pv_journal_line2', to_jsonb(v_line2)
  );

  -- 11. Record Historical Audit Command
  INSERT INTO public.finance_historical_repair_commands (
    idempotency_key,
    document_type,
    document_id,
    operation,
    requested_by,
    requested_at,
    before_state,
    after_state,
    status
  ) VALUES (
    c_idempotency,
    'payment',
    c_pv028_id,
    'restate_salary_net_of_advance',
    c_actor,
    now(),
    v_before,
    v_after,
    'committed'
  );

  RAISE NOTICE 'Sandi PV/028 petty cash advance correction successfully applied and verified.';
END;
$$;
