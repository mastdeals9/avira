-- Migration: 20261117173000_fix_bank_reconciliation_auto_match_and_canonical_allocation.sql
-- Fix bank reconciliation auto-match canonical allocation creation,
-- normalize operational payment kinds, prevent premature match counting,
-- and restore atomic expense bank linking.

BEGIN;

-- ============================================================================
-- 1. Restore link_bank_statement_line call in edit_approved_finance_expense_atomic
-- ============================================================================
CREATE OR REPLACE FUNCTION public.edit_approved_finance_expense_atomic(
  p_expense_id uuid,
  p_payload jsonb,
  p_bank_statement_line_id uuid DEFAULT NULL::uuid,
  p_allocation_amount numeric DEFAULT NULL::numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_exp public.finance_expenses%rowtype;
  v_journal_id uuid;
  v_journal_count integer;
  v_date date;
  v_bank_id uuid;
  v_bank_currency text;
  v_currency text;
  v_rate numeric;
  v_docs text[];
  v_period_status text;
  v_effective_allocation numeric;
  v_bpjs_ded numeric;
  v_bpjs_item_id uuid;
  v_p_month integer;
  v_p_year integer;
  v_same_selected_count integer;
  v_selected_amount numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_exp FROM public.finance_expenses WHERE id=p_expense_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_exp.approval_status<>'approved' THEN RAISE EXCEPTION 'Approved expense edit requires an approved expense'; END IF;

  SELECT count(*),(array_agg(id ORDER BY created_at DESC,id DESC))[1]
    INTO v_journal_count,v_journal_id
    FROM public.journal_entries
   WHERE source_module IN('expense','expenses')
     AND (reference_id=p_expense_id OR reference_number='EXP-'||p_expense_id::text)
     AND is_posted=true AND NOT COALESCE(is_reversed,false);
  IF v_journal_count<>1 THEN RAISE EXCEPTION 'Approved expense must have exactly one active effective journal'; END IF;
  PERFORM 1 FROM public.journal_entries WHERE id=v_journal_id FOR UPDATE;

  SELECT ap.status INTO v_period_status
    FROM public.journal_entries je
    LEFT JOIN public.accounting_periods ap
      ON ap.start_date<=je.entry_date AND ap.end_date>=je.entry_date
   WHERE je.id=v_journal_id
   ORDER BY ap.start_date DESC LIMIT 1;
  IF v_period_status IS NOT NULL AND v_period_status<>'open' THEN
    RAISE EXCEPTION 'Cannot edit approved expense in a closed accounting period';
  END IF;

  IF COALESCE((p_payload->>'amount')::numeric,0)<=0 THEN RAISE EXCEPTION 'Expense amount must be greater than zero'; END IF;
  IF NULLIF(p_payload->>'expense_category','') IS NULL THEN RAISE EXCEPTION 'Expense category is required'; END IF;
  v_date:=COALESCE((p_payload->>'expense_date')::date,current_date);
  v_bank_id:=NULLIF(p_payload->>'bank_account_id','')::uuid;

  IF v_bank_id IS NOT NULL THEN
    SELECT currency INTO v_bank_currency FROM public.bank_accounts WHERE id=v_bank_id;
    IF v_bank_currency IS NULL THEN RAISE EXCEPTION 'Selected bank account does not exist'; END IF;
  END IF;

  v_currency:=COALESCE(NULLIF(p_payload->>'transaction_currency',''),v_bank_currency,v_exp.transaction_currency,'IDR');
  IF v_currency='USD' THEN
    v_rate:=COALESCE((p_payload->>'exchange_rate')::numeric,v_exp.exchange_rate,1);
    IF v_rate<=1 THEN RAISE EXCEPTION 'A valid USD rate greater than 1 is required'; END IF;
  ELSE
    v_currency:='IDR';
    v_rate:=1;
  END IF;

  IF p_payload ? 'document_urls' THEN
    SELECT COALESCE(array_agg(elem::text),ARRAY[]::text[])
      INTO v_docs
      FROM jsonb_array_elements_text(p_payload->'document_urls') AS elem;
  ELSE
    v_docs:=v_exp.document_urls;
  END IF;

  v_bpjs_ded := COALESCE(NULLIF(p_payload->>'bpjs_employee_deduction','')::numeric, v_exp.bpjs_employee_deduction, 0);
  v_bpjs_item_id := COALESCE(NULLIF(p_payload->>'bpjs_register_item_id','')::uuid, v_exp.bpjs_register_item_id);
  v_p_month := COALESCE(NULLIF(p_payload->>'payroll_period_month','')::integer, v_exp.payroll_period_month);
  v_p_year := COALESCE(NULLIF(p_payload->>'payroll_period_year','')::integer, v_exp.payroll_period_year);

  UPDATE public.finance_expenses SET
    expense_category=p_payload->>'expense_category',
    expense_type=COALESCE(NULLIF(p_payload->>'expense_type',''),v_exp.expense_type,'general'),
    amount=(p_payload->>'amount')::numeric,
    expense_date=v_date,
    description=NULLIF(p_payload->>'description',''),
    batch_id=NULLIF(p_payload->>'batch_id','')::uuid,
    import_container_id=NULLIF(p_payload->>'import_container_id','')::uuid,
    delivery_challan_id=NULLIF(p_payload->>'delivery_challan_id','')::uuid,
    payment_method=NULLIF(p_payload->>'payment_method',''),
    bank_account_id=v_bank_id,
    payment_reference=NULLIF(p_payload->>'payment_reference',''),
    paid_by=CASE WHEN NULLIF(p_payload->>'payment_method','') IN('cash','petty_cash') THEN 'cash' WHEN v_bank_id IS NOT NULL THEN 'bank' ELSE NULL END,
    document_urls=v_docs,
    supplier_id=NULLIF(p_payload->>'supplier_id','')::uuid,
    staff_id=NULLIF(p_payload->>'staff_id','')::uuid,
    payee_id=NULLIF(p_payload->>'payee_id','')::uuid,
    invoice_number=NULLIF(p_payload->>'invoice_number',''),
    due_date=NULLIF(p_payload->>'due_date','')::date,
    broker_items=NULLIF(p_payload->'broker_items','null'::jsonb),
    pib_bm_amount=NULLIF(p_payload->>'pib_bm_amount','')::numeric,
    pib_ppn_amount=NULLIF(p_payload->>'pib_ppn_amount','')::numeric,
    pib_pph_amount=NULLIF(p_payload->>'pib_pph_amount','')::numeric,
    ppn_amount=COALESCE(NULLIF(p_payload->>'ppn_amount','')::numeric,0),
    ppn_manual_override=COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
    ppn_calc_mode=COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'),
    dpp_amount=NULLIF(p_payload->>'dpp_amount','')::numeric,
    ppn_rate=COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11),
    pph_amount=COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
    pph_code_id=NULLIF(p_payload->>'pph_code_id','')::uuid,
    pph_treatment=COALESCE(NULLIF(p_payload->>'pph_treatment',''),'deduct'),
    stamp_duty_amount=COALESCE(NULLIF(p_payload->>'stamp_duty_amount','')::numeric,0),
    fixed_asset_account_id=NULLIF(p_payload->>'fixed_asset_account_id','')::uuid,
    bank_charges_amount=COALESCE(NULLIF(p_payload->>'bank_charges_amount','')::numeric,0),
    currency_code=v_currency,
    transaction_currency=v_currency,
    functional_currency='IDR',
    exchange_rate=v_rate,
    bank_account_currency=COALESCE(v_bank_currency,v_currency),
    payment_currency=v_currency,
    sales_order_allocations=COALESCE(p_payload->'sales_order_allocations','[]'::jsonb),
    bpjs_employee_deduction=v_bpjs_ded,
    bpjs_register_item_id=v_bpjs_item_id,
    payroll_period_month=v_p_month,
    payroll_period_year=v_p_year
  WHERE id=p_expense_id;

  v_effective_allocation := CASE WHEN COALESCE(p_allocation_amount, 0) > 0.01 THEN p_allocation_amount ELSE NULL END;

  SELECT count(*), max(allocation_amount)
    INTO v_same_selected_count, v_selected_amount
    FROM public.bank_statement_allocations
   WHERE document_type = 'expense' AND document_id = p_expense_id AND payment_kind = 'supplier'
     AND bank_statement_line_id = p_bank_statement_line_id;

  IF p_bank_statement_line_id IS NOT NULL AND v_same_selected_count = 0 THEN
    PERFORM public.link_bank_statement_line(
      p_bank_statement_line_id, 'expense', p_expense_id, 'supplier', v_effective_allocation);
  ELSIF p_bank_statement_line_id IS NOT NULL
     AND v_effective_allocation IS NOT NULL
     AND abs(COALESCE(v_selected_amount, 0) - v_effective_allocation) > 0.01 THEN
    RAISE EXCEPTION 'Change an existing bank allocation through unlink/relink so other payments remain intact';
  END IF;

  RETURN p_expense_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.edit_approved_finance_expense_atomic(uuid, jsonb, uuid, numeric) TO authenticated, service_role;


-- ============================================================================
-- 2. Link bank statement line: normalize payment_kind & clear manually_unlinked
-- ============================================================================
CREATE OR REPLACE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,
  p_document_type text,
  p_document_id uuid,
  p_payment_kind text DEFAULT 'supplier'::text,
  p_allocation_amount numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_line public.bank_statement_lines%rowtype;
  v_expense public.finance_expenses%rowtype;
  v_je uuid;
  v_bank_coa uuid;
  v_bank_currency text;
  v_expense_currency text;
  v_bank_total numeric;
  v_bank_allocated numeric;
  v_bank_remaining numeric;
  v_doc_total numeric;
  v_doc_allocated numeric;
  v_doc_remaining numeric;
  v_allocate numeric;
  v_allocation_id uuid := gen_random_uuid();
  v_settlement_coa uuid;
  v_rate numeric;
  v_functional_amount numeric;
  v_entry text;
  v_period_id uuid;
  v_kind text;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Normalize payment_kind: preserve pph23 for genuine withholding, normalize empty/null/unclassified to supplier
  v_kind := CASE
    WHEN p_payment_kind = 'pph23' THEN 'pph23'
    ELSE 'supplier'
  END;

  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id = p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;

  IF p_document_type = 'expense' THEN
    SELECT * INTO v_expense FROM public.finance_expenses WHERE id = p_document_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
    SELECT (array_agg(id ORDER BY created_at DESC, id DESC))[1] INTO v_je
      FROM public.journal_entries
     WHERE source_module IN ('expense', 'expenses')
       AND (reference_id = p_document_id OR reference_number = 'EXP-' || p_document_id::text)
       AND is_posted = true AND NOT COALESCE(is_reversed, false);
  ELSIF p_document_type = 'receipt' THEN
    SELECT journal_entry_id INTO v_je FROM public.receipt_vouchers WHERE id = p_document_id;
  ELSIF p_document_type = 'payment' THEN
    SELECT journal_entry_id INTO v_je FROM public.payment_vouchers WHERE id = p_document_id;
  ELSIF p_document_type = 'fund_transfer' THEN
    SELECT journal_entry_id INTO v_je FROM public.fund_transfers WHERE id = p_document_id;
  ELSIF p_document_type = 'petty_cash' THEN
    SELECT journal_entry_id INTO v_je FROM public.petty_cash_transactions WHERE id = p_document_id;
  ELSIF p_document_type = 'tax_payment' THEN
    SELECT journal_entry_id INTO v_je FROM public.tax_payments WHERE id = p_document_id;
  ELSIF p_document_type = 'journal' THEN
    SELECT id INTO v_je FROM public.journal_entries WHERE id = p_document_id AND is_posted AND NOT COALESCE(is_reversed, false);
  ELSE
    RAISE EXCEPTION 'Unsupported reconciliation document type %', p_document_type;
  END IF;

  IF v_je IS NULL THEN
    RAISE EXCEPTION 'Document must have an active posted journal before reconciliation';
  END IF;

  SELECT coa_id, upper(currency) INTO v_bank_coa, v_bank_currency
    FROM public.bank_accounts WHERE id = v_line.bank_account_id;
  IF v_bank_coa IS NULL THEN
    RAISE EXCEPTION 'Selected bank account has no General Ledger account';
  END IF;

  IF p_document_type <> 'expense' THEN
    SELECT COALESCE(sum(CASE WHEN COALESCE(v_line.credit_amount, 0) > 0 THEN COALESCE(jel.transaction_debit, jel.debit)
                             ELSE COALESCE(jel.transaction_credit, jel.credit) END), 0)
      INTO v_doc_total FROM public.journal_entry_lines jel
     WHERE jel.journal_entry_id = v_je AND jel.account_id = v_bank_coa;
    IF v_doc_total <= 0.01 THEN
      RAISE EXCEPTION 'Document journal does not contain the selected bank account on the matching side';
    END IF;
  END IF;

  v_bank_total := COALESCE(NULLIF(v_line.debit_amount, 0), v_line.credit_amount, 0);
  SELECT COALESCE(sum(allocation_amount), 0) INTO v_bank_allocated
    FROM public.bank_statement_allocations WHERE bank_statement_line_id = p_bank_line_id;

  IF p_document_type = 'expense' THEN
    IF COALESCE(v_line.debit_amount, 0) <= 0 THEN
      RAISE EXCEPTION 'Expense payment requires an outgoing bank transaction';
    END IF;
    v_expense_currency := upper(COALESCE(v_expense.transaction_currency, v_expense.currency_code, 'IDR'));
    IF COALESCE(v_bank_currency, 'IDR') <> v_expense_currency THEN
      RAISE EXCEPTION 'Direct expense allocation requires matching expense and bank currencies';
    END IF;
    IF v_kind = 'supplier' THEN
      v_doc_total := COALESCE(public.calculate_finance_expense_payable(p_document_id), 0);
      SELECT id INTO v_settlement_coa FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    ELSIF v_kind = 'pph23' THEN
      v_doc_total := COALESCE(v_expense.pph_amount, 0);
      SELECT id INTO v_settlement_coa FROM public.chart_of_accounts WHERE code = '2132' LIMIT 1;
    ELSE
      RAISE EXCEPTION 'Unsupported expense payment kind %', v_kind;
    END IF;
    IF v_settlement_coa IS NULL THEN
      RAISE EXCEPTION 'Expense settlement account is not configured';
    END IF;

    SELECT
      COALESCE((SELECT sum(a.allocation_amount) FROM public.bank_statement_allocations a
                 WHERE a.document_type = 'expense' AND a.document_id = p_document_id
                   AND a.payment_kind = v_kind), 0)
      + COALESCE((SELECT sum(va.allocated_amount) FROM public.voucher_allocations va
                    JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
                   WHERE va.finance_expense_id = p_document_id
                     AND COALESCE(va.payment_kind, 'supplier') = v_kind
                     AND pv.is_posted = true), 0)
      INTO v_doc_allocated;
  ELSE
    SELECT COALESCE(sum(allocation_amount), 0) INTO v_doc_allocated
      FROM public.bank_statement_allocations
     WHERE document_type = p_document_type AND document_id = p_document_id
       AND payment_kind = v_kind;
  END IF;

  v_bank_remaining := v_bank_total - v_bank_allocated;
  v_doc_remaining := v_doc_total - v_doc_allocated;

  -- Universal Idempotency: Return existing allocation safely if already recorded
  IF EXISTS (
    SELECT 1 FROM public.bank_statement_allocations a
     WHERE a.bank_statement_line_id = p_bank_line_id
       AND a.document_type = p_document_type
       AND a.document_id = p_document_id
       AND a.payment_kind = v_kind
  ) THEN
    SELECT a.allocation_amount, a.journal_entry_id INTO v_allocate, v_je
      FROM public.bank_statement_allocations a
     WHERE a.bank_statement_line_id = p_bank_line_id
       AND a.document_type = p_document_type
       AND a.document_id = p_document_id
       AND a.payment_kind = v_kind
     LIMIT 1;

    PERFORM public.sync_bank_line_allocation_owner(p_bank_line_id);
    UPDATE public.bank_statement_lines
       SET matched_at = COALESCE(matched_at, now()),
           matched_by = COALESCE(matched_by, auth.uid()),
           manually_unlinked = false
     WHERE id = p_bank_line_id;
    PERFORM public.refresh_bank_statement_allocation_status(p_bank_line_id);
    IF p_document_type = 'expense' THEN PERFORM public.recalculate_expense_payment_state(p_document_id); END IF;
    RETURN jsonb_build_object(
      'allocation_amount', v_allocate,
      'bank_total', v_bank_total,
      'bank_allocated', v_bank_allocated,
      'bank_remaining', v_bank_remaining,
      'document_total', v_doc_total,
      'document_allocated', v_doc_allocated,
      'document_remaining', v_doc_remaining,
      'journal_entry_id', v_je,
      'status', 'already_linked'
    );
  END IF;

  v_allocate := round(COALESCE(NULLIF(p_allocation_amount, 0), LEAST(v_bank_remaining, v_doc_remaining)), 2);
  IF v_allocate <= 0.01 THEN RAISE EXCEPTION 'No remaining amount is available to allocate'; END IF;
  IF v_allocate > v_bank_remaining + 0.01 THEN RAISE EXCEPTION 'Allocation exceeds remaining bank amount'; END IF;
  IF v_allocate > v_doc_remaining + 0.01 THEN RAISE EXCEPTION 'Allocation exceeds document outstanding amount'; END IF;

  IF p_document_type = 'expense' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.journal_entries
       WHERE source_module = 'expense_payment'
         AND reference_number = 'EXP-PAY-' || v_allocation_id::text
         AND is_posted = true AND NOT COALESCE(is_reversed, false)
    ) THEN
      v_rate := COALESCE(NULLIF(v_expense.exchange_rate, 0), 1);
      v_functional_amount := round(v_allocate * v_rate, 2);
      SELECT id INTO v_period_id FROM public.accounting_periods
       WHERE v_line.transaction_date BETWEEN start_date AND end_date
       ORDER BY start_date DESC LIMIT 1;
      v_entry := public.next_journal_entry_number();
      INSERT INTO public.journal_entries (
        entry_number, entry_date, period_id, source_module, reference_id,
        reference_number, description, total_debit, total_credit, is_posted,
        is_reversed, posted_by, posted_at, created_by, transaction_currency,
        functional_currency, exchange_rate, amounts_are_functional
      ) VALUES (
        v_entry, v_line.transaction_date, v_period_id, 'expense_payment', p_document_id,
        'EXP-PAY-' || v_allocation_id::text,
        'Bank reconciliation payment for ' || COALESCE(v_expense.voucher_number, 'expense') || ' (Statement ' || COALESCE(v_line.reference, v_line.id::text) || ')',
        v_functional_amount, v_functional_amount, true, false, auth.uid(), now(), auth.uid(),
        v_expense_currency, 'IDR', v_rate, true
      ) RETURNING id INTO v_je;

      INSERT INTO public.journal_entry_lines (
        journal_entry_id, line_number, account_id, description, debit, credit,
        transaction_currency, transaction_debit, transaction_credit, functional_currency,
        exchange_rate, supplier_id
      ) VALUES
        (v_je, 1, v_settlement_coa, 'Expense settlement - ' || COALESCE(v_expense.voucher_number, ''), v_functional_amount, 0,
         v_expense_currency, v_allocate, 0, 'IDR', v_rate, v_expense.supplier_id),
        (v_je, 2, v_bank_coa, 'Bank payment - ' || COALESCE(v_expense.voucher_number, ''), 0, v_functional_amount,
         v_bank_currency, 0, v_allocate, 'IDR', v_rate, v_expense.supplier_id);
    END IF;
  END IF;

  INSERT INTO public.bank_statement_allocations(
    id, bank_statement_line_id, document_type, document_id, journal_entry_id,
    allocation_amount, payment_kind, created_by
  ) VALUES (
    v_allocation_id, p_bank_line_id, p_document_type, p_document_id, v_je,
    v_allocate, v_kind, auth.uid()
  );

  PERFORM public.sync_bank_line_allocation_owner(p_bank_line_id);
  UPDATE public.bank_statement_lines
     SET matched_at = now(),
         matched_by = auth.uid(),
         manually_unlinked = false
   WHERE id = p_bank_line_id;

  PERFORM public.refresh_bank_statement_allocation_status(p_bank_line_id);
  IF p_document_type = 'expense' THEN PERFORM public.recalculate_expense_payment_state(p_document_id); END IF;

  RETURN jsonb_build_object(
    'allocation_amount', v_allocate,
    'bank_total', v_bank_total,
    'bank_allocated', v_bank_allocated + v_allocate,
    'bank_remaining', v_bank_remaining - v_allocate,
    'document_total', v_doc_total,
    'document_allocated', v_doc_allocated + v_allocate,
    'document_remaining', v_doc_remaining - v_allocate,
    'journal_entry_id', v_je
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.link_bank_statement_line(uuid, text, uuid, text, numeric) TO authenticated, service_role;


-- ============================================================================
-- 3. Refresh bank statement allocation status: confirmed on active allocations
-- ============================================================================
CREATE OR REPLACE FUNCTION public.refresh_bank_statement_allocation_status(p_bank_line_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_total numeric;
  v_allocated numeric;
  v_existing_status text;
  v_existing_matching_status text;
  v_new_matching_status text;
  v_new_recon_status text;
BEGIN
  SELECT COALESCE(NULLIF(debit_amount, 0), credit_amount, 0),
         reconciliation_status, matching_status
    INTO v_total, v_existing_status, v_existing_matching_status
    FROM public.bank_statement_lines
   WHERE id = p_bank_line_id
   FOR UPDATE;

  SELECT COALESCE(sum(allocation_amount), 0)
    INTO v_allocated
    FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = p_bank_line_id;

  IF v_allocated <= 0.01 THEN
    IF v_existing_matching_status = 'suggested' OR v_existing_status = 'needs_review' THEN
      v_new_recon_status := 'needs_review';
      v_new_matching_status := 'suggested';
    ELSE
      v_new_recon_status := 'unmatched';
      v_new_matching_status := 'none';
    END IF;
  ELSIF v_allocated < v_total - 0.01 THEN
    v_new_recon_status := 'partially_reconciled';
    v_new_matching_status := 'confirmed';
  ELSE
    v_new_recon_status := 'matched';
    v_new_matching_status := 'confirmed';
  END IF;

  UPDATE public.bank_statement_lines
     SET reconciliation_status = v_new_recon_status,
         matching_status = v_new_matching_status,
         matched_at = CASE WHEN v_allocated <= 0.01 AND v_new_matching_status = 'none' THEN NULL ELSE COALESCE(matched_at, now()) END,
         matched_by = CASE WHEN v_allocated <= 0.01 AND v_new_matching_status = 'none' THEN NULL ELSE COALESCE(matched_by, auth.uid()) END
   WHERE id = p_bank_line_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_bank_statement_allocation_status(uuid) TO authenticated, service_role;


-- ============================================================================
-- 4. Recalculate expense payment state: robust payment_kind normalization
-- ============================================================================
CREATE OR REPLACE FUNCTION public.recalculate_expense_payment_state(p_expense_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_supplier_paid numeric := 0;
  v_pph_paid numeric := 0;
  v_payable numeric := 0;
  v_target_paid numeric;
  v_target_pph_paid numeric;
BEGIN
  IF public.historical_repair_context_active() THEN RETURN; END IF;

  -- 1. Confirmed, posted Payment Vouchers allocated to this expense (supplier kind)
  SELECT COALESCE(sum(va.allocated_amount),0) INTO v_supplier_paid
    FROM public.voucher_allocations va
    JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
   WHERE va.finance_expense_id=p_expense_id
     AND COALESCE(NULLIF(va.payment_kind, 'unclassified'), 'supplier') = 'supplier'
     AND pv.is_posted = true
     AND COALESCE(pv.payment_purpose,'general') NOT IN ('salary_advance','salary_advance_settlement');

  -- 2. Direct Bank Statement Allocations that do NOT duplicate a posted Payment Voucher
  SELECT v_supplier_paid + COALESCE(sum(bsa.allocation_amount),0) INTO v_supplier_paid
    FROM public.bank_statement_allocations bsa
   WHERE bsa.document_type='expense'
     AND bsa.document_id=p_expense_id
     AND COALESCE(NULLIF(bsa.payment_kind, 'unclassified'), 'supplier') = 'supplier'
     AND NOT EXISTS (
       SELECT 1
         FROM public.voucher_allocations va
         JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
        WHERE va.finance_expense_id = p_expense_id
          AND pv.is_posted = true
          AND pv.journal_entry_id = bsa.journal_entry_id
     );

  -- 3. Legacy confirmed bank lines without allocations
  SELECT v_supplier_paid + COALESCE(sum(COALESCE(NULLIF(b.debit_amount,0),b.credit_amount,0)),0) INTO v_supplier_paid
    FROM public.bank_statement_lines b
   WHERE b.matched_expense_id=p_expense_id
     AND COALESCE(NULLIF(b.payment_kind, 'unclassified'), 'supplier') = 'supplier'
     AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=b.id)
     AND NOT EXISTS (
       SELECT 1
         FROM public.voucher_allocations va
         JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
        WHERE va.finance_expense_id = p_expense_id
          AND pv.is_posted = true
          AND (pv.journal_entry_id = b.matched_entry_id OR pv.id = b.matched_payment_id)
     );

  -- 4. Include posted salary advance applications (advance recovery)
  SELECT v_supplier_paid + COALESCE(sum(sa.applied_amount),0) INTO v_supplier_paid
    FROM public.salary_advance_applications sa
    JOIN public.payment_vouchers settlement ON settlement.id = sa.settlement_payment_voucher_id
   WHERE sa.salary_expense_id = p_expense_id AND settlement.is_posted = true;

  -- 5. Legacy cash expense recognition
  SELECT v_supplier_paid + COALESCE(sum(jel.credit), 0) INTO v_supplier_paid
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
   WHERE (je.reference_id = p_expense_id OR je.reference_number = 'EXP-' || p_expense_id::text)
     AND je.source_module IN ('expense', 'expenses')
     AND je.is_posted = true
     AND NOT COALESCE(je.is_reversed, false)
     AND jel.account_id IN (SELECT id FROM public.chart_of_accounts WHERE code IN ('1101', '1102'));

  -- 6. PPh 23 payment state (with deduplication)
  SELECT COALESCE(sum(allocated_amount),0) INTO v_pph_paid
    FROM public.voucher_allocations va
    JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
   WHERE va.finance_expense_id=p_expense_id AND va.payment_kind='pph23'
     AND pv.is_posted = true;

  SELECT v_pph_paid + COALESCE(sum(allocation_amount),0) INTO v_pph_paid
    FROM public.bank_statement_allocations bsa
   WHERE bsa.document_type='expense' AND bsa.document_id=p_expense_id AND bsa.payment_kind='pph23'
     AND NOT EXISTS (
       SELECT 1
         FROM public.voucher_allocations va
         JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
        WHERE va.finance_expense_id = p_expense_id
          AND va.payment_kind = 'pph23'
          AND pv.is_posted = true
          AND pv.journal_entry_id = bsa.journal_entry_id
     );

  v_payable := COALESCE(public.calculate_finance_expense_payable(p_expense_id),0);
  v_target_paid := LEAST(GREATEST(v_supplier_paid,0),GREATEST(v_payable,0));
  v_target_pph_paid := GREATEST(v_pph_paid,0);

  UPDATE public.finance_expenses
     SET paid_amount=v_target_paid,
         pph_paid_amount=v_target_pph_paid
   WHERE id=p_expense_id
     AND (paid_amount IS DISTINCT FROM v_target_paid OR pph_paid_amount IS DISTINCT FROM v_target_pph_paid);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.recalculate_expense_payment_state(uuid) TO authenticated, service_role;


-- ============================================================================
-- 5. Auto match smart: strict single-candidate auto-matching & allocation verification
-- ============================================================================
CREATE OR REPLACE FUNCTION public.auto_match_smart()
RETURNS TABLE(matched_count integer, suggested_count integer, skipped_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line public.bank_statement_lines%ROWTYPE;
  v_bank_amount numeric;
  v_direction text;
  v_bank_text text;
  v_candidates jsonb;
  v_candidate jsonb;
  v_candidate_count integer;
  v_expense public.finance_expenses%ROWTYPE;
  v_payload jsonb;
  v_matched integer := 0;
  v_suggested integer := 0;
  v_skipped integer := 0;
  v_is_matched boolean;
BEGIN
  PERFORM public._sec_check_finance_role();

  FOR v_line IN
    SELECT b.*
    FROM public.bank_statement_lines b
    WHERE (b.matching_status IS NULL OR b.matching_status IN ('none', 'suggested'))
      AND b.reconciliation_status IN ('unmatched', 'needs_review')
      AND NOT COALESCE(b.manually_unlinked, false)
      AND NOT EXISTS (
        SELECT 1 FROM public.bank_statement_allocations a
        WHERE a.bank_statement_line_id = b.id
      )
    ORDER BY b.transaction_date, b.id
    FOR UPDATE SKIP LOCKED
  LOOP
    v_is_matched := false;
    v_bank_amount := CASE
      WHEN COALESCE(v_line.credit_amount, 0) > 0 THEN v_line.credit_amount
      ELSE v_line.debit_amount
    END;
    v_direction := CASE
      WHEN COALESCE(v_line.credit_amount, 0) > 0 THEN 'credit'
      ELSE 'debit'
    END;
    v_bank_text := concat_ws(' ', v_line.reference, v_line.description);

    IF COALESCE(v_bank_amount, 0) <= 0.01 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- =========================================================================
    -- 1. CANONICAL SETTLEMENTS (Posted documents with existing bank legs)
    -- =========================================================================
    WITH source_candidates AS MATERIALIZED (
      SELECT s.*,
             GREATEST(
               s.settlement_amount - COALESCE((
                 SELECT sum(a.allocation_amount)
                 FROM public.bank_statement_allocations a
                 WHERE a.document_type = s.document_type
                   AND a.document_id = s.document_id
                   AND a.journal_entry_id = s.journal_entry_id
               ), 0),
               0
             ) AS remaining_amount,
             concat_ws(
               ' ', s.document_number, je.reference_number, je.description,
               (SELECT string_agg(l.description, ' ' ORDER BY l.line_number)
                FROM public.journal_entry_lines l
                WHERE l.journal_entry_id = s.journal_entry_id),
               CASE s.document_type
                 WHEN 'payment' THEN (
                   SELECT concat_ws(' ',
                     pv.reference_number, pv.description, pv.payment_purpose,
                     sp.company_name, staff.full_name,
                     (SELECT string_agg(concat_ws(' ', pi.invoice_number, pi.notes, pis.company_name), ' ')
                        FROM public.voucher_allocations va
                        LEFT JOIN public.purchase_invoices pi ON pi.id = va.purchase_invoice_id
                        LEFT JOIN public.suppliers pis ON pis.id = pi.supplier_id
                       WHERE va.payment_voucher_id = pv.id),
                     (SELECT string_agg(concat_ws(' ', fe.voucher_number, fe.invoice_number, fe.payment_reference, fe.description, fes.company_name, fs.full_name), ' ')
                        FROM public.voucher_allocations va
                        LEFT JOIN public.finance_expenses fe ON fe.id = va.finance_expense_id
                        LEFT JOIN public.suppliers fes ON fes.id = fe.supplier_id
                        LEFT JOIN public.finance_staff_master fs ON fs.id = fe.staff_id
                       WHERE va.payment_voucher_id = pv.id)
                   )
                   FROM public.payment_vouchers pv
                   LEFT JOIN public.suppliers sp ON sp.id = pv.supplier_id
                   LEFT JOIN public.finance_staff_master staff ON staff.id = pv.staff_id
                   WHERE pv.id = s.document_id
                 )
                 WHEN 'receipt' THEN (
                   SELECT concat_ws(' ',
                     rv.reference_number, rv.description, c.company_name,
                     (SELECT string_agg(concat_ws(' ', si.invoice_number, si.po_number, ci.company_name), ' ')
                        FROM public.voucher_allocations va
                        LEFT JOIN public.sales_invoices si ON si.id = va.sales_invoice_id
                        LEFT JOIN public.customers ci ON ci.id = si.customer_id
                       WHERE va.receipt_voucher_id = rv.id)
                   )
                   FROM public.receipt_vouchers rv
                   LEFT JOIN public.customers c ON c.id = rv.customer_id
                   WHERE rv.id = s.document_id
                 )
                 WHEN 'expense' THEN (
                   SELECT concat_ws(' ', fe.voucher_number, fe.invoice_number, fe.payment_reference,
                                    fe.description, sp.company_name, staff.full_name)
                     FROM public.finance_expenses fe
                     LEFT JOIN public.suppliers sp ON sp.id = fe.supplier_id
                     LEFT JOIN public.finance_staff_master staff ON staff.id = fe.staff_id
                    WHERE fe.id = s.document_id
                 )
                 WHEN 'fund_transfer' THEN (
                   SELECT ft.description
                     FROM public.fund_transfers ft
                    WHERE ft.id = s.document_id
                 )
                 WHEN 'petty_cash' THEN (
                   SELECT pc.description
                     FROM public.petty_cash_transactions pc
                    WHERE pc.id = s.document_id
                 )
                 ELSE NULL
               END
             ) AS document_text
      FROM public.vw_finance_document_settlements s
      JOIN public.journal_entries je ON je.id = s.journal_entry_id
      WHERE s.bank_account_id = v_line.bank_account_id
        AND s.direction = v_direction
        AND abs(v_line.transaction_date - s.settlement_date) <= 7
    ), scored AS MATERIALIZED (
      SELECT c.*,
             public.finance_bank_match_text_score(v_bank_text, c.document_text) AS text_score,
             CASE
               WHEN length(regexp_replace(lower(COALESCE(c.document_number, '')), '[^a-z0-9]+', '', 'g')) >= 5
                AND position(
                  regexp_replace(lower(c.document_number), '[^a-z0-9]+', '', 'g')
                  IN regexp_replace(lower(v_bank_text), '[^a-z0-9]+', '', 'g')
                ) > 0 THEN 1
               WHEN public.finance_bank_match_text_score(v_bank_text, c.document_text) >= 2 THEN 2
               WHEN public.finance_bank_match_text_score(v_bank_text, c.document_text) >= 1
                AND v_line.transaction_date = c.settlement_date THEN 3
               ELSE NULL
             END AS match_tier
      FROM source_candidates c
      WHERE abs(c.remaining_amount - v_bank_amount) <= 1
    ), best AS (
      SELECT s.*
      FROM scored s
      WHERE s.match_tier IS NOT NULL
        AND s.match_tier = (SELECT min(match_tier) FROM scored WHERE match_tier IS NOT NULL)
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(best) ORDER BY match_tier, settlement_date, document_type, document_id), '[]'::jsonb)
    INTO v_candidates
    FROM best;

    v_candidate_count := jsonb_array_length(v_candidates);
    IF v_candidate_count = 1 THEN
      v_candidate := v_candidates->0;
      BEGIN
        PERFORM public.link_bank_statement_line(
          v_line.id,
          v_candidate->>'document_type',
          (v_candidate->>'document_id')::uuid,
          'supplier',
          v_bank_amount
        );

        -- Strict Verification: Verify canonical allocation actually exists before counting as matched
        IF NOT EXISTS (
          SELECT 1 FROM public.bank_statement_allocations
          WHERE bank_statement_line_id = v_line.id
            AND document_type = v_candidate->>'document_type'
            AND document_id = (v_candidate->>'document_id')::uuid
        ) THEN
          v_skipped := v_skipped + 1;
          CONTINUE;
        END IF;

        UPDATE public.bank_statement_lines
        SET notes = 'Canonical auto-match: existing bank journal; tier '
                    || (v_candidate->>'match_tier')
                    || ', text score ' || (v_candidate->>'text_score'),
            manually_unlinked = false
        WHERE id = v_line.id;
        v_matched := v_matched + 1;
        v_is_matched := true;
        CONTINUE;
      EXCEPTION WHEN OTHERS THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END;
    ELSIF v_candidate_count > 1 THEN
      -- Ambiguous candidate: do NOT auto-match; leave for interactive user review queue
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- =========================================================================
    -- 2. APPROVED EXPENSES (Posted AP reclassification to bank)
    -- =========================================================================
    IF v_direction = 'debit' THEN
      WITH expense_candidates AS MATERIALIZED (
        SELECT fe.id AS document_id,
               fe.voucher_number AS document_number,
               fe.expense_date AS settlement_date,
               je.id AS journal_entry_id,
               public.calculate_finance_expense_payable(fe.id)
                 - COALESCE(fe.paid_amount, 0) AS remaining_amount,
               concat_ws(
                 ' ', fe.voucher_number, fe.invoice_number, fe.payment_reference,
                 fe.description, ic.container_ref, supplier.company_name,
                 staff.full_name, je.reference_number,
                 je.description,
                 (SELECT string_agg(l.description, ' ' ORDER BY l.line_number)
                  FROM public.journal_entry_lines l
                  WHERE l.journal_entry_id = je.id)
               ) AS document_text
        FROM public.finance_expenses fe
        LEFT JOIN public.import_containers ic ON ic.id = fe.import_container_id
        LEFT JOIN public.suppliers supplier ON supplier.id = fe.supplier_id
        LEFT JOIN public.finance_staff_master staff ON staff.id = fe.staff_id
        JOIN LATERAL (
          SELECT j.*
          FROM public.journal_entries j
          WHERE j.source_module IN ('expense', 'expenses')
            AND (j.reference_id = fe.id OR j.reference_number = 'EXP-' || fe.id::text)
            AND j.is_posted
            AND NOT COALESCE(j.is_reversed, false)
          ORDER BY j.created_at DESC, j.id DESC
          LIMIT 1
        ) je ON true
        WHERE fe.approval_status = 'approved'
          AND (fe.bank_account_id IS NULL OR fe.bank_account_id = v_line.bank_account_id)
          AND COALESCE(fe.paid_amount, 0) <= 0.01
          AND COALESCE(fe.pph_paid_amount, 0) <= 0.01
          AND abs(v_line.transaction_date - fe.expense_date) <= 7
          AND NOT EXISTS (
            SELECT 1 FROM public.voucher_allocations va
            WHERE va.finance_expense_id = fe.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.bank_statement_allocations a
            WHERE a.document_type = 'expense' AND a.document_id = fe.id
          )
      ), scored AS MATERIALIZED (
        SELECT c.*,
               public.finance_bank_match_text_score(v_bank_text, c.document_text) AS text_score,
               CASE
                 WHEN length(regexp_replace(lower(COALESCE(c.document_number, '')), '[^a-z0-9]+', '', 'g')) >= 5
                  AND position(
                    regexp_replace(lower(c.document_number), '[^a-z0-9]+', '', 'g')
                    IN regexp_replace(lower(v_bank_text), '[^a-z0-9]+', '', 'g')
                  ) > 0 THEN 1
                 WHEN public.finance_bank_match_text_score(v_bank_text, c.document_text) >= 2 THEN 2
                 WHEN public.finance_bank_match_text_score(v_bank_text, c.document_text) >= 1
                  AND v_line.transaction_date = c.settlement_date THEN 3
                 ELSE NULL
               END AS match_tier
        FROM expense_candidates c
        WHERE abs(c.remaining_amount - v_bank_amount) <= 1
      ), best AS (
        SELECT s.*
        FROM scored s
        WHERE s.match_tier IS NOT NULL
          AND s.match_tier = (SELECT min(match_tier) FROM scored WHERE match_tier IS NOT NULL)
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(best) ORDER BY match_tier, settlement_date, document_id), '[]'::jsonb)
      INTO v_candidates
      FROM best;

      v_candidate_count := jsonb_array_length(v_candidates);
      IF v_candidate_count = 1 THEN
        v_candidate := v_candidates->0;
        SELECT * INTO v_expense
        FROM public.finance_expenses
        WHERE id = (v_candidate->>'document_id')::uuid
        FOR UPDATE;

        v_payload := to_jsonb(v_expense) || jsonb_build_object(
          'payment_method', 'bank_transfer',
          'bank_account_id', v_line.bank_account_id,
          'paid_by', 'bank',
          'payment_reference', COALESCE(NULLIF(v_line.reference, ''), v_expense.payment_reference),
          'transaction_currency', upper(COALESCE(v_line.currency, v_expense.transaction_currency, 'IDR')),
          'currency_code', upper(COALESCE(v_line.currency, v_expense.currency_code, 'IDR')),
          'functional_currency', 'IDR',
          'exchange_rate', CASE
            WHEN upper(COALESCE(v_line.currency, v_expense.transaction_currency, 'IDR')) = 'IDR' THEN 1
            ELSE v_expense.exchange_rate
          END
        );

        BEGIN
          PERFORM public.edit_approved_finance_expense_atomic(
            v_expense.id,
            v_payload,
            v_line.id,
            v_bank_amount
          );

          -- Strict Verification: Verify canonical allocation actually exists before counting as matched
          IF NOT EXISTS (
            SELECT 1 FROM public.bank_statement_allocations
            WHERE bank_statement_line_id = v_line.id
              AND document_type = 'expense'
              AND document_id = v_expense.id
          ) THEN
            v_skipped := v_skipped + 1;
            CONTINUE;
          END IF;

          UPDATE public.bank_statement_lines
          SET notes = 'Canonical auto-match: unique existing Expense; tier '
                      || (v_candidate->>'match_tier')
                      || ', text score ' || (v_candidate->>'text_score'),
              manually_unlinked = false
          WHERE id = v_line.id;
          v_matched := v_matched + 1;
          v_is_matched := true;
          CONTINUE;
        EXCEPTION WHEN OTHERS THEN
          v_skipped := v_skipped + 1;
          CONTINUE;
        END;
      ELSIF v_candidate_count > 1 THEN
        -- Ambiguous candidate: do NOT auto-match; leave for interactive user review queue
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      -- =======================================================================
      -- 3. PENDING-APPROVAL EXPENSES: SUGGESTED / REVIEW MATCH ONLY
      -- Never auto-approves pending expenses. Creates suggested link only.
      -- Does NOT alter GL, post journals, or create allocations without approval.
      -- =======================================================================
      WITH pending_candidates AS MATERIALIZED (
        SELECT fe.id AS document_id,
               fe.voucher_number AS document_number,
               fe.expense_date AS settlement_date,
               fe.amount AS remaining_amount,
               concat_ws(
                 ' ', fe.voucher_number, fe.invoice_number, fe.payment_reference,
                 fe.description, ic.container_ref, supplier.company_name,
                 staff.full_name, array_to_string(fe.document_urls, ' ')
               ) AS document_text
        FROM public.finance_expenses fe
        LEFT JOIN public.import_containers ic ON ic.id = fe.import_container_id
        LEFT JOIN public.suppliers supplier ON supplier.id = fe.supplier_id
        LEFT JOIN public.finance_staff_master staff ON staff.id = fe.staff_id
        WHERE fe.approval_status = 'pending_approval'
          AND (fe.bank_account_id IS NULL OR fe.bank_account_id = v_line.bank_account_id)
          AND COALESCE(fe.paid_amount, 0) <= 0.01
          AND abs(v_line.transaction_date - fe.expense_date) <= 7
          AND abs(fe.amount - v_bank_amount) <= 1
          AND NOT EXISTS (
            SELECT 1 FROM public.bank_statement_allocations a
            WHERE a.document_type = 'expense' AND a.document_id = fe.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.bank_statement_lines b2
            WHERE b2.matched_expense_id = fe.id AND b2.id <> v_line.id
              AND b2.matching_status = 'confirmed'
          )
      ), scored AS MATERIALIZED (
        SELECT c.*,
               public.finance_bank_match_text_score(v_bank_text, c.document_text) AS text_score,
               CASE
                 WHEN length(regexp_replace(lower(COALESCE(c.document_number, '')), '[^a-z0-9]+', '', 'g')) >= 5
                  AND position(
                    regexp_replace(lower(c.document_number), '[^a-z0-9]+', '', 'g')
                    IN regexp_replace(lower(v_bank_text), '[^a-z0-9]+', '', 'g')
                  ) > 0 THEN 1
                 WHEN c.document_text ~* '[0-9]{10,}'
                  AND position(
                    substring(v_bank_text from '[0-9]{10,}')
                    IN c.document_text
                  ) > 0 THEN 1
                 WHEN public.finance_bank_match_text_score(v_bank_text, c.document_text) >= 2 THEN 2
                 WHEN public.finance_bank_match_text_score(v_bank_text, c.document_text) >= 1
                  AND v_line.transaction_date = c.settlement_date THEN 3
                 WHEN v_line.transaction_date = c.settlement_date
                  AND abs(c.remaining_amount - v_bank_amount) <= 0.01 THEN 4
                 ELSE NULL
               END AS match_tier
        FROM pending_candidates c
      ), best AS (
        SELECT s.*
        FROM scored s
        WHERE s.match_tier IS NOT NULL
          AND s.match_tier = (SELECT min(match_tier) FROM scored WHERE match_tier IS NOT NULL)
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(best) ORDER BY match_tier, settlement_date, document_id), '[]'::jsonb)
      INTO v_candidates
      FROM best;

      v_candidate_count := jsonb_array_length(v_candidates);
      IF v_candidate_count = 1 THEN
        v_candidate := v_candidates->0;
        UPDATE public.bank_statement_lines
        SET matched_expense_id = (v_candidate->>'document_id')::uuid,
            reconciliation_status = 'needs_review',
            matching_status = 'suggested',
            notes = 'Suggested match: Pending approval expense '
                    || COALESCE(v_candidate->>'document_number', '')
                    || ' (Tier ' || (v_candidate->>'match_tier')
                    || ', text score ' || (v_candidate->>'text_score') || ')',
            manually_unlinked = false
        WHERE id = v_line.id;
        v_suggested := v_suggested + 1;
        v_is_matched := true;
        CONTINUE;
      ELSIF v_candidate_count > 1 THEN
        -- Ambiguous candidate: do NOT auto-match; leave for interactive user review queue
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
    END IF;

    IF NOT v_is_matched THEN
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_matched, v_suggested, v_skipped;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auto_match_smart() TO authenticated, service_role;

COMMIT;
