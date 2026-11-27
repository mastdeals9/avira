-- Restore Simple Unpost -> Delete Workflow for Expenses
-- 1. cancel_expense_posting: unposts the journal and returns approval_status to 'pending_approval'
--    (not 'cancelled' or 'rejected').
-- 2. unlink_finance_expense_bank_atomic: accepts 'pending_approval' or 'cancelled' post-cancel state.
-- 3. delete_expense_safe: atomically deletes eligible unposted/draft/rejected/reversed expenses
--    along with their exclusively-owned unposted/reversed journals and lines, releases unposted
--    bank allocations without deleting bank statement lines, preserves audit logs, and blocks
--    deletion when active posted journals, payments, or shared/protected dependencies exist.

CREATE OR REPLACE FUNCTION public.cancel_expense_posting(
  p_exp_id uuid,
  p_cancelled_by uuid,
  p_reason text DEFAULT 'Posting cancelled by administrator'::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_exp public.finance_expenses%ROWTYPE;
  v_je public.journal_entries%ROWTYPE;
  v_reversal_id uuid;
  v_period_status text;
  v_reversal_number text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_cancelled_by IS NULL OR p_cancelled_by <> auth.uid() THEN
    RAISE EXCEPTION 'Cancelled-by identity must match the authenticated user';
  END IF;
  PERFORM public._sec_check_finance_role();
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'Cancellation reason is required';
  END IF;

  SELECT * INTO v_exp
  FROM public.finance_expenses
  WHERE id = p_exp_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found', p_exp_id;
  END IF;
  IF v_exp.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'Cannot unpost: expense % is not approved (current: %)',
      p_exp_id, v_exp.approval_status;
  END IF;

  SELECT * INTO v_je
  FROM public.journal_entries
  WHERE source_module IN ('expense', 'expenses')
    AND (reference_id = p_exp_id OR reference_number = 'EXP-' || p_exp_id::text)
    AND is_posted = true
    AND NOT COALESCE(is_reversed, false)
  ORDER BY created_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active journal entry found for expense %', p_exp_id;
  END IF;

  SELECT ap.status INTO v_period_status
  FROM public.accounting_periods ap
  WHERE ap.start_date <= v_je.entry_date AND ap.end_date >= v_je.entry_date
  ORDER BY ap.start_date DESC
  LIMIT 1;
  IF v_period_status IS NOT NULL AND v_period_status <> 'open' THEN
    RAISE EXCEPTION
      'Cannot unpost: the accounting period for % is closed. Contact your finance manager to reopen the period.',
      to_char(v_je.entry_date, 'FMMonth YYYY');
  END IF;

  IF COALESCE(v_exp.paid_amount, 0) > 0
     OR COALESCE(v_exp.pph_paid_amount, 0) > 0
     OR EXISTS (SELECT 1 FROM public.voucher_allocations va WHERE va.finance_expense_id = p_exp_id)
     OR EXISTS (SELECT 1 FROM public.bank_statement_allocations a
                WHERE (a.document_type = 'expense' AND a.document_id = p_exp_id)
                   OR a.journal_entry_id = v_je.id)
     OR EXISTS (SELECT 1 FROM public.bank_statement_lines b
                WHERE b.matched_expense_id = p_exp_id OR b.matched_entry_id = v_je.id)
     OR EXISTS (SELECT 1 FROM public.bank_reconciliation_items bri WHERE bri.journal_entry_id = v_je.id) THEN
    RAISE EXCEPTION
      'Cannot unpost paid/settled expense %. Reverse or unlink its payment/bank allocation first.',
      COALESCE(v_exp.voucher_number, p_exp_id::text)
      USING ERRCODE = 'check_violation';
  END IF;

  v_reversal_number := public.generate_journal_entry_number();
  INSERT INTO public.journal_entries(
    entry_number, entry_date, period_id, source_module, reference_id,
    reference_number, description, total_debit, total_credit,
    is_posted, is_reversed, posted_by, posted_at, created_by,
    transaction_category, transaction_currency, functional_currency,
    exchange_rate, amounts_are_functional
  ) VALUES (
    v_reversal_number, v_je.entry_date, v_je.period_id, 'expense_cancellation', p_exp_id,
    'CANCEL-' || COALESCE(v_exp.voucher_number, p_exp_id::text),
    'Unpost reversal of ' || v_je.entry_number || ': ' || p_reason,
    v_je.total_credit, v_je.total_debit,
    true, true, p_cancelled_by, now(), p_cancelled_by,
    v_je.transaction_category, v_je.transaction_currency, v_je.functional_currency,
    v_je.exchange_rate, v_je.amounts_are_functional
  ) RETURNING id INTO v_reversal_id;

  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description,
    debit, credit, tax_code_id, customer_id, supplier_id, batch_id,
    transaction_currency, transaction_debit, transaction_credit,
    functional_currency, exchange_rate
  )
  SELECT v_reversal_id, l.line_number, l.account_id,
         'UNPOST: ' || COALESCE(l.description, ''),
         l.credit, l.debit, l.tax_code_id, l.customer_id, l.supplier_id, l.batch_id,
         l.transaction_currency, l.transaction_credit, l.transaction_debit,
         l.functional_currency, l.exchange_rate
  FROM public.journal_entry_lines l
  WHERE l.journal_entry_id = v_je.id
  ORDER BY l.line_number;

  IF NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id = v_reversal_id) THEN
    RAISE EXCEPTION 'Cannot unpost empty journal entry %', v_je.id;
  END IF;

  UPDATE public.journal_entries
  SET is_reversed = true, reversed_by_id = v_reversal_id
  WHERE id = v_je.id AND NOT COALESCE(is_reversed, false);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense journal % was already reversed', v_je.id;
  END IF;

  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    'finance_expenses', p_exp_id, 'update',
    jsonb_build_object(
      '_action', 'UNPOST_EXPENSE',
      'journal_entry_id', v_je.id,
      'journal_entry_number', v_je.entry_number,
      'reversal_journal_id', v_reversal_id,
      'reversal_journal_number', v_reversal_number,
      'entry_date', v_je.entry_date,
      'amount', v_exp.amount,
      'expense_category', v_exp.expense_category,
      'approval_status', v_exp.approval_status,
      'reason', p_reason
    ),
    jsonb_build_object(
      'approval_status', 'pending_approval',
      'unposted_by', p_cancelled_by,
      'unposted_at', now()
    ),
    p_cancelled_by
  );

  -- Unpost only unposts the journal and returns the expense to pending_approval
  -- (not cancelled/rejected).
  UPDATE public.finance_expenses
  SET approval_status = 'pending_approval', approved_by = NULL, approved_at = NULL
  WHERE id = p_exp_id;

  IF EXISTS (
    SELECT 1 FROM public.journal_entries
    WHERE source_module IN ('expense', 'expenses')
      AND (reference_id = p_exp_id OR reference_number = 'EXP-' || p_exp_id::text)
      AND is_posted = true
      AND NOT COALESCE(is_reversed, false)
  ) THEN
    RAISE EXCEPTION 'Expense % still has an active journal after unposting', p_exp_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unlink_finance_expense_bank_atomic(
  p_expense_id uuid,
  p_reason text DEFAULT 'Bank statement link removed by user'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_expense public.finance_expenses%ROWTYPE;
  v_allocation record;
  v_released integer := 0;
BEGIN
  PERFORM public._sec_check_finance_role();
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'An unlink reason is required';
  END IF;

  SELECT * INTO v_expense
  FROM public.finance_expenses
  WHERE id = p_expense_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
  IF v_expense.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'Only an active posted expense can be unlinked through this workflow';
  END IF;

  FOR v_allocation IN
    SELECT id
    FROM public.bank_statement_allocations
    WHERE document_type = 'expense'
      AND document_id = p_expense_id
    ORDER BY id
    FOR UPDATE
  LOOP
    PERFORM public.unmatch_bank_statement_allocation(v_allocation.id);
    v_released := v_released + 1;
  END LOOP;
  IF v_released = 0 THEN
    RAISE EXCEPTION 'Expense has no canonical bank allocation to unlink';
  END IF;

  PERFORM public.recalculate_expense_payment_state(p_expense_id);
  PERFORM public.cancel_expense_posting(p_expense_id, auth.uid(), p_reason);

  IF EXISTS (
    SELECT 1 FROM public.bank_statement_allocations
    WHERE document_type = 'expense' AND document_id = p_expense_id
  ) THEN
    RAISE EXCEPTION 'Expense unlink left a bank allocation behind';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.journal_entries
    WHERE source_module IN ('expense', 'expenses')
      AND (reference_id = p_expense_id OR reference_number = 'EXP-' || p_expense_id::text)
      AND is_posted AND NOT COALESCE(is_reversed, false)
  ) THEN
    RAISE EXCEPTION 'Expense unlink left an active journal behind';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.finance_expenses
    WHERE id = p_expense_id AND approval_status IN ('pending_approval', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Expense unlink did not unpost the document';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'expense_id', p_expense_id,
    'released_allocations', v_released
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_expense_safe(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_expense public.finance_expenses%ROWTYPE;
  v_allocation_count integer := 0;
  v_legacy_count integer := 0;
  v_deleted_journals integer := 0;
  v_je_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot delete expenses', v_role;
  END IF;

  SELECT * INTO v_expense
    FROM public.finance_expenses
   WHERE id = p_expense_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  -- 0. Explicitly restrict deletion to pending_approval, rejected, or cancelled expenses
  IF v_expense.approval_status IS NULL
     OR v_expense.approval_status NOT IN ('pending_approval', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Cannot delete expense %: approval_status "%" is not eligible for deletion. Only pending_approval, rejected, or cancelled expenses may be deleted.',
      COALESCE(v_expense.voucher_number, p_expense_id::text),
      COALESCE(v_expense.approval_status, 'NULL');
  END IF;

  -- 1. Block deletion if any active posted journal exists for this expense
  IF EXISTS (
    SELECT 1
    FROM public.journal_entries je
    WHERE je.source_module IN ('expense', 'expenses', 'expense_payment', 'expense_replacement')
      AND (je.reference_id = p_expense_id OR je.reference_number = 'EXP-' || p_expense_id::text)
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND NOT COALESCE(je.is_cancelled, false)
  ) THEN
    RAISE EXCEPTION 'Cannot delete expense %: it has an active posted journal. Unpost the expense first.',
      COALESCE(v_expense.voucher_number, p_expense_id::text);
  END IF;

  -- 2. Block deletion if payments, voucher allocations, petty cash, salary advances, or PPh allocations exist
  IF COALESCE(v_expense.paid_amount, 0) > 0.01 OR COALESCE(v_expense.pph_paid_amount, 0) > 0.01 THEN
    RAISE EXCEPTION 'Cannot delete expense %: it has recorded payments (paid_amount=%). Unlink or reverse payments first.',
      COALESCE(v_expense.voucher_number, p_expense_id::text), v_expense.paid_amount;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.voucher_allocations va
    JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
    JOIN public.journal_entries je ON je.id = pv.journal_entry_id
    WHERE va.finance_expense_id = p_expense_id
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND NOT COALESCE(je.is_cancelled, false)
  ) THEN
    RAISE EXCEPTION 'Cannot delete expense %: linked to a posted payment voucher allocation. Reverse or unlink the payment voucher first.',
      COALESCE(v_expense.voucher_number, p_expense_id::text);
  END IF;

  IF EXISTS (SELECT 1 FROM public.petty_cash_transactions WHERE finance_expense_id = p_expense_id) THEN
    RAISE EXCEPTION 'Cannot delete expense %: linked to a petty cash transaction. Unlink or delete the petty cash transaction first.',
      COALESCE(v_expense.voucher_number, p_expense_id::text);
  END IF;

  IF EXISTS (SELECT 1 FROM public.salary_advance_applications WHERE salary_expense_id = p_expense_id) THEN
    RAISE EXCEPTION 'Cannot delete expense %: linked to a salary advance application. Reverse the salary advance settlement first.',
      COALESCE(v_expense.voucher_number, p_expense_id::text);
  END IF;

  IF EXISTS (SELECT 1 FROM public.finance_expense_pph_allocations WHERE expense_id = p_expense_id) THEN
    RAISE EXCEPTION 'Cannot delete expense %: linked to a PPh tax allocation. Remove the PPh allocation first.',
      COALESCE(v_expense.voucher_number, p_expense_id::text);
  END IF;

  -- 3. Preflight bank statement allocations and identify exclusively-associated
  --    unposted/reversed journals BEFORE mutating any records
  IF EXISTS (
    SELECT 1
    FROM public.bank_statement_allocations bsa
    JOIN public.journal_entries je ON je.id = bsa.journal_entry_id
    WHERE bsa.document_type = 'expense'
      AND bsa.document_id = p_expense_id
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND NOT COALESCE(je.is_cancelled, false)
  ) THEN
    RAISE EXCEPTION 'Cannot delete expense %: linked to a posted bank reconciliation payment. Unlink the bank reconciliation first.',
      COALESCE(v_expense.voucher_number, p_expense_id::text);
  END IF;

  SELECT COALESCE(array_agg(je.id), ARRAY[]::uuid[])
    INTO v_je_ids
    FROM public.journal_entries je
   WHERE je.source_module IN ('expense', 'expenses', 'expense_cancellation', 'expense_payment', 'expense_payment_reversal', 'expense_replacement')
     AND (
       je.reference_id = p_expense_id
       OR je.reference_number = 'EXP-' || p_expense_id::text
       OR (v_expense.voucher_number IS NOT NULL AND je.reference_number = 'CANCEL-' || v_expense.voucher_number)
     )
     AND NOT (je.is_posted = true AND NOT COALESCE(je.is_reversed, false) AND NOT COALESCE(je.is_cancelled, false));

  IF COALESCE(array_length(v_je_ids, 1), 0) > 0 THEN
    -- 4a. Block if any external journal outside v_je_ids points to v_je_ids via reversed_by_id or replacement_journal_id
    IF EXISTS (
      SELECT 1
      FROM public.journal_entries ext
      WHERE NOT (ext.id = ANY(v_je_ids))
        AND (ext.reversed_by_id = ANY(v_je_ids) OR ext.replacement_journal_id = ANY(v_je_ids))
    ) THEN
      RAISE EXCEPTION 'Cannot delete expense %: an external journal entry references one of its journals via reversed_by_id or replacement_journal_id.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;

    -- 4b. Preflight all production foreign-key references to journal_entries
    IF EXISTS (
      SELECT 1 FROM public.bank_statement_allocations bsa
      WHERE bsa.journal_entry_id = ANY(v_je_ids)
        AND (bsa.document_type <> 'expense' OR bsa.document_id <> p_expense_id)
    ) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by another bank statement allocation.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.bank_statement_lines bsl
      WHERE bsl.matched_entry_id = ANY(v_je_ids)
        AND bsl.matched_expense_id IS DISTINCT FROM p_expense_id
    ) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by a bank statement line.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;

    IF EXISTS (SELECT 1 FROM public.bank_reconciliation_items WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by bank_reconciliation_items.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.bpjs_monthly_registers WHERE journal_entry_id = ANY(v_je_ids) OR payment_journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by bpjs_monthly_registers.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.capital_contributions WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by capital_contributions.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.credit_notes WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by credit_notes.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.fund_transfers WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by fund_transfers.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.fx_revaluations WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by fx_revaluations.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.import_cost_headers WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by import_cost_headers.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.invoice_rounding_adjustments WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by invoice_rounding_adjustments.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.loan_transactions WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by loan_transactions.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.loans WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by loans.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.payment_vouchers WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by payment_vouchers.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.petty_cash_vouchers WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by petty_cash_vouchers.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.purchase_invoices WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by purchase_invoices.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.receipt_vouchers WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by receipt_vouchers.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.salary_advance_applications WHERE settlement_journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by salary_advance_applications.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.sales_invoices WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by sales_invoices.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
    IF EXISTS (SELECT 1 FROM public.tax_payments WHERE journal_entry_id = ANY(v_je_ids)) THEN
      RAISE EXCEPTION 'Cannot delete expense %: journal is referenced by tax_payments.',
        COALESCE(v_expense.voucher_number, p_expense_id::text);
    END IF;
  END IF;

  -- 5. Release unposted expense bank allocations and legacy bank line links (never delete bank statement lines)
  SELECT count(*) INTO v_allocation_count
    FROM public.bank_statement_allocations
   WHERE document_type = 'expense'
     AND document_id = p_expense_id;

  DELETE FROM public.bank_statement_allocations
   WHERE document_type = 'expense'
     AND document_id = p_expense_id;

  WITH released AS (
    UPDATE public.bank_statement_lines b SET
      matched_expense_id = NULL,
      matched_entry_id = NULL,
      reconciliation_status = 'unmatched',
      matching_status = 'none',
      matched_at = NULL,
      matched_by = NULL,
      manually_unlinked = true
    WHERE b.matched_expense_id = p_expense_id
      AND NOT EXISTS (
        SELECT 1 FROM public.bank_statement_allocations a
         WHERE a.bank_statement_line_id = b.id
      )
    RETURNING 1
  ) SELECT count(*) INTO v_legacy_count FROM released;

  -- 6. Clear self-referencing FK links ONLY on rows inside v_je_ids, then delete lines & headers
  IF COALESCE(array_length(v_je_ids, 1), 0) > 0 THEN
    UPDATE public.journal_entries
       SET reversed_by_id = NULL,
           replacement_journal_id = NULL
     WHERE id = ANY(v_je_ids);

    DELETE FROM public.journal_entry_lines WHERE journal_entry_id = ANY(v_je_ids);
    DELETE FROM public.journal_entries WHERE id = ANY(v_je_ids);
    GET DIAGNOSTICS v_deleted_journals = ROW_COUNT;
  END IF;

  -- 5. Preserve audit log of the permanent deletion
  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    'finance_expenses',
    p_expense_id,
    'delete',
    jsonb_build_object(
      '_action', 'DELETE_UNPOSTED_EXPENSE',
      'voucher_number', v_expense.voucher_number,
      'expense_category', v_expense.expense_category,
      'amount', v_expense.amount,
      'approval_status', v_expense.approval_status,
      'deleted_journal_ids', v_je_ids
    ),
    NULL,
    auth.uid()
  );

  -- 6. Permanently delete the expense
  DELETE FROM public.finance_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bank_statement_allocations
     WHERE document_type = 'expense' AND document_id = p_expense_id
  ) THEN
    RAISE EXCEPTION 'Expense delete left orphan bank allocations';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bank_statement_lines WHERE matched_expense_id = p_expense_id
  ) THEN
    RAISE EXCEPTION 'Expense delete left orphan bank references';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'released_allocations', v_allocation_count,
    'released_legacy_lines', v_legacy_count,
    'deleted_journals', v_deleted_journals
  );
END;
$function$;
