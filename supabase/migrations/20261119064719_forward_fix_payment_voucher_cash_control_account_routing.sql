-- Migration: 20261119064719_forward_fix_payment_voucher_cash_control_account_routing.sql
-- Description: Forward fix for post_payment_voucher preventing coa_account_id debit/credit collision,
--              guarding inactive GL 1101, and routing Cash vs Petty Cash control accounts safely.

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
