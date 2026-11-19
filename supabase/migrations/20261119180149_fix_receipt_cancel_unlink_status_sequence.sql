CREATE OR REPLACE FUNCTION public.cancel_receipt_voucher_posting(p_rv_id uuid, p_cancelled_by uuid DEFAULT NULL::uuid, p_reason text DEFAULT 'Posting cancelled by administrator'::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rv RECORD; v_je RECORD; v_actor uuid; v_alloc RECORD;
  v_line_ids uuid[] := ARRAY[]::uuid[]; v_line_id uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actor := COALESCE(auth.uid(), p_cancelled_by);
  SELECT * INTO v_rv FROM public.receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id; END IF;
  IF NOT v_rv.is_posted THEN RAISE EXCEPTION 'Receipt voucher % is not posted', COALESCE(v_rv.voucher_number, p_rv_id::TEXT); END IF;
  SELECT * INTO v_je FROM public.journal_entries WHERE id = v_rv.journal_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No journal entry found for receipt voucher %', v_rv.voucher_number; END IF;
  DELETE FROM public.invoice_rounding_adjustments WHERE receipt_voucher_id = p_rv_id;
  FOR v_alloc IN
    SELECT bsa.id, bsa.bank_statement_line_id FROM public.bank_statement_allocations bsa
    WHERE (bsa.document_type = 'receipt' AND bsa.document_id = p_rv_id)
       OR (v_rv.journal_entry_id IS NOT NULL AND bsa.journal_entry_id = v_rv.journal_entry_id)
    FOR UPDATE
  LOOP
    IF NOT (v_alloc.bank_statement_line_id = ANY(v_line_ids)) THEN v_line_ids := array_append(v_line_ids, v_alloc.bank_statement_line_id); END IF;
    IF to_regclass('public.finance_historical_repair_commands') IS NOT NULL THEN
      EXECUTE 'UPDATE public.finance_historical_repair_commands SET created_allocation_id = NULL WHERE created_allocation_id = $1' USING v_alloc.id;
    END IF;
    PERFORM public.unmatch_bank_statement_allocation(v_alloc.id);
  END LOOP;
  FOR v_line_id IN
    SELECT id FROM public.bank_statement_lines
    WHERE matched_receipt_id = p_rv_id
       OR (v_rv.journal_entry_id IS NOT NULL AND matched_entry_id = v_rv.journal_entry_id)
  LOOP
    IF NOT (v_line_id = ANY(v_line_ids)) THEN v_line_ids := array_append(v_line_ids, v_line_id); END IF;
  END LOOP;
  IF array_length(v_line_ids, 1) > 0 THEN
    UPDATE public.bank_statement_lines
       SET matched_receipt_id = NULL, matched_entry_id = NULL,
           matching_status = 'none', reconciliation_status = 'unmatched',
           manually_unlinked = TRUE, matched_at = NULL, matched_by = NULL
     WHERE id = ANY(v_line_ids);
    FOREACH v_line_id IN ARRAY v_line_ids LOOP
      IF EXISTS (SELECT 1 FROM public.bank_statement_allocations WHERE bank_statement_line_id = v_line_id) THEN
        PERFORM public.sync_bank_line_allocation_owner(v_line_id);
        PERFORM public.refresh_bank_statement_allocation_status(v_line_id);
      END IF;
    END LOOP;
  END IF;
  UPDATE public.receipt_vouchers SET is_posted = FALSE, journal_entry_id = NULL WHERE id = p_rv_id;
  PERFORM public.cancel_gl_posting(
    v_je.id, p_rv_id, 'receipt_vouchers', v_actor, p_reason,
    jsonb_build_object('voucher_number', v_rv.voucher_number, 'amount', v_rv.amount, 'is_posted', TRUE)
  );
  IF v_rv.bank_account_id IS NOT NULL THEN PERFORM public.sync_bank_account_balance(v_rv.bank_account_id); END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unmatch_bank_statement_allocation(p_allocation_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_a public.bank_statement_allocations%rowtype;
  v_payment_je public.journal_entries%rowtype;
  v_reversal_id uuid; v_reversal_number text; v_period_status text;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_a FROM public.bank_statement_allocations WHERE id = p_allocation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank allocation not found'; END IF;
  SELECT * INTO v_payment_je FROM public.journal_entries
   WHERE id = v_a.journal_entry_id AND source_module = 'expense_payment'
     AND reference_number = 'EXP-PAY-' || p_allocation_id::text
     AND is_posted AND NOT COALESCE(is_reversed, false) FOR UPDATE;
  IF FOUND THEN
    SELECT status INTO v_period_status FROM public.accounting_periods
     WHERE start_date <= v_payment_je.entry_date AND end_date >= v_payment_je.entry_date
     ORDER BY start_date DESC LIMIT 1;
    IF v_period_status IS NOT NULL AND v_period_status <> 'open' THEN
      RAISE EXCEPTION 'Cannot unlink expense payment in a closed accounting period';
    END IF;
    v_reversal_number := public.next_journal_entry_number();
    INSERT INTO public.journal_entries (
      entry_number, entry_date, period_id, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, is_reversed, posted_by, posted_at,
      created_by, transaction_currency, functional_currency, exchange_rate, amounts_are_functional
    ) VALUES (
      v_reversal_number, v_payment_je.entry_date, v_payment_je.period_id, 'expense_payment_reversal',
      v_a.document_id, 'REV-EXP-PAY-' || p_allocation_id::text, 'Reversal of ' || v_payment_je.entry_number,
      v_payment_je.total_credit, v_payment_je.total_debit, true, true, auth.uid(), now(), auth.uid(),
      v_payment_je.transaction_currency, v_payment_je.functional_currency,
      v_payment_je.exchange_rate, v_payment_je.amounts_are_functional
    ) RETURNING id INTO v_reversal_id;
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit, tax_code_id,
      customer_id, supplier_id, batch_id, transaction_currency, transaction_debit,
      transaction_credit, functional_currency, exchange_rate
    )
    SELECT v_reversal_id, line_number, account_id, 'REVERSAL: ' || COALESCE(description, ''),
      credit, debit, tax_code_id, customer_id, supplier_id, batch_id, transaction_currency,
      transaction_credit, transaction_debit, functional_currency, exchange_rate
    FROM public.journal_entry_lines WHERE journal_entry_id = v_payment_je.id ORDER BY line_number;
    UPDATE public.journal_entries SET is_reversed = true, reversed_by_id = v_reversal_id WHERE id = v_payment_je.id;
  END IF;
  UPDATE public.bank_statement_lines SET manually_unlinked = true
   WHERE id = v_a.bank_statement_line_id AND manually_unlinked IS DISTINCT FROM true;
  DELETE FROM public.bank_statement_allocations WHERE id = p_allocation_id;
  IF EXISTS (SELECT 1 FROM public.bank_statement_allocations WHERE bank_statement_line_id = v_a.bank_statement_line_id) THEN
    PERFORM public.sync_bank_line_allocation_owner(v_a.bank_statement_line_id);
    PERFORM public.refresh_bank_statement_allocation_status(v_a.bank_statement_line_id);
  ELSE
    UPDATE public.bank_statement_lines
       SET matched_expense_id = NULL, matched_receipt_id = NULL, matched_payment_id = NULL,
           matched_fund_transfer_id = NULL, matched_petty_cash_id = NULL, matched_tax_payment_id = NULL,
           matched_entry_id = NULL, matching_status = 'none', reconciliation_status = 'unmatched',
           manually_unlinked = TRUE, matched_at = NULL, matched_by = NULL
     WHERE id = v_a.bank_statement_line_id;
  END IF;
  IF v_a.document_type = 'expense' THEN PERFORM public.recalculate_expense_payment_state(v_a.document_id); END IF;
  RETURN jsonb_build_object('success', true, 'bank_line_id', v_a.bank_statement_line_id,
    'allocation_id', p_allocation_id, 'reversal_journal_id', v_reversal_id);
END;
$function$;
