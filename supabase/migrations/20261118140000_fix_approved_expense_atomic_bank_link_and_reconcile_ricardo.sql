-- Migration: 20261118140000_fix_approved_expense_atomic_bank_link_and_reconcile_ricardo.sql
-- 1. Restore atomic context 'app.expense_atomic_bank_link' in edit_approved_finance_expense_atomic
--    to prevent trg_normalize_unlinked_expense_payment from clearing payment_method / bank_account_id / paid_by.
-- 2. Repair EXP/26/345 (ID: a5c3e13e-66a6-48bc-be77-e56819fec117) payment linking to 13 Nov 2026 bank transaction.
-- 3. Reconcile Ricardo September & October expenses (EXP/26/334 & EXP/26/335) against 3 Nov 2026 bank transaction
--    (ID: 93a47258-80b8-4bd4-b06a-0ce8fde906bd, Rp 3,900,000 debit: Rp 1,950,000 to each).
--    Preserve Bank Txn B (ID: 663f66a3-702d-4c79-a0a9-e2a0718b6ade, 17 Nov, Rp 4,000,000) for owner review.
--    Exclude EXP/26/203 and EXP/26/204 entirely per owner authorization.

BEGIN;

-- ============================================================================
-- 1. Update edit_approved_finance_expense_atomic with atomic bank link context
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
  v_payment_method text;
  v_paid_by text;
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

  -- Derive bank account from statement line if not supplied in payload
  IF v_bank_id IS NULL AND p_bank_statement_line_id IS NOT NULL THEN
    SELECT bank_account_id INTO v_bank_id FROM public.bank_statement_lines WHERE id = p_bank_statement_line_id;
  END IF;

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

  v_payment_method := COALESCE(NULLIF(p_payload->>'payment_method',''), CASE WHEN p_bank_statement_line_id IS NOT NULL THEN 'bank_transfer' ELSE NULL END);
  v_paid_by := CASE
    WHEN v_payment_method IN('cash','petty_cash') THEN 'cash'
    WHEN v_bank_id IS NOT NULL OR p_bank_statement_line_id IS NOT NULL THEN 'bank'
    ELSE NULL
  END;

  -- CRITICAL: Activate atomic bank link context to allow trg_normalize_unlinked_expense_payment to retain bank payment info
  PERFORM set_config('app.expense_atomic_bank_link', 'on', true);

  UPDATE public.finance_expenses SET
    expense_category=p_payload->>'expense_category',
    expense_type=COALESCE(NULLIF(p_payload->>'expense_type',''),v_exp.expense_type,'general'),
    amount=(p_payload->>'amount')::numeric,
    expense_date=v_date,
    description=NULLIF(p_payload->>'description',''),
    batch_id=NULLIF(p_payload->>'batch_id','')::uuid,
    import_container_id=NULLIF(p_payload->>'import_container_id','')::uuid,
    delivery_challan_id=NULLIF(p_payload->>'delivery_challan_id','')::uuid,
    payment_method=v_payment_method,
    bank_account_id=v_bank_id,
    payment_reference=NULLIF(p_payload->>'payment_reference',''),
    paid_by=v_paid_by,
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

  PERFORM public.recalculate_expense_payment_state(p_expense_id);
  PERFORM set_config('app.expense_atomic_bank_link', 'off', true);

  RETURN p_expense_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.edit_approved_finance_expense_atomic(uuid, jsonb, uuid, numeric) TO authenticated, service_role;


-- ============================================================================
-- 2. PART 1: Production repair for EXP/26/345 payment linking
-- ============================================================================
DO $$
DECLARE
  v_exp_id uuid := 'a5c3e13e-66a6-48bc-be77-e56819fec117'::uuid;
  v_line_id uuid;
  v_line_bank uuid;
  v_net_payable numeric;
BEGIN
  -- Check if expense exists
  IF EXISTS (SELECT 1 FROM public.finance_expenses WHERE id = v_exp_id) THEN
    -- Calculate net payable (900,000 + 99,000 - 18,000 = 981,000)
    v_net_payable := COALESCE(public.calculate_finance_expense_payable(v_exp_id), 981000);

    -- Find matching bank statement line: 13 Nov 2026, BCA IDR, Debit Rp 981,000
    SELECT id, bank_account_id INTO v_line_id, v_line_bank
    FROM public.bank_statement_lines
    WHERE (debit_amount = 981000 OR (debit_amount = v_net_payable AND v_net_payable > 0))
      AND (description ILIKE '%BERKAT KASIH BERSA%' OR description ILIKE '%EXP/26/345%' OR description ILIKE '%PEST CONTROL%')
      AND transaction_date >= '2026-11-01'::date AND transaction_date <= '2026-11-20'::date
    ORDER BY transaction_date DESC
    LIMIT 1;

    IF v_line_id IS NOT NULL THEN
      -- Clear manual unlink protection if set
      UPDATE public.bank_statement_lines
      SET manually_unlinked = false,
          notes = 'Linked to EXP/26/345 (PEST CONTROL 3 NOV)'
      WHERE id = v_line_id;

      -- Set atomic context
      PERFORM set_config('app.expense_atomic_bank_link', 'on', true);

      -- Update expense payment header
      UPDATE public.finance_expenses
      SET payment_method = 'bank_transfer',
          bank_account_id = v_line_bank,
          paid_by = 'bank'
      WHERE id = v_exp_id;

      -- Link bank line to expense if not already linked
      IF NOT EXISTS (
        SELECT 1 FROM public.bank_statement_allocations
        WHERE bank_statement_line_id = v_line_id AND document_type = 'expense' AND document_id = v_exp_id
      ) THEN
        PERFORM public.link_bank_statement_line(v_line_id, 'expense', v_exp_id, 'supplier', v_net_payable);
      END IF;

      -- Recalculate payment state
      PERFORM public.recalculate_expense_payment_state(v_exp_id);
      PERFORM set_config('app.expense_atomic_bank_link', 'off', true);

      -- Update bank line status
      UPDATE public.bank_statement_lines
      SET reconciliation_status = 'matched',
          matching_status = 'confirmed',
          matched_expense_id = v_exp_id
      WHERE id = v_line_id;
    END IF;
  END IF;
END $$;


-- ============================================================================
-- 3. PART 2: Reconcile Ricardo September and October expenses (EXP/26/334 & EXP/26/335)
-- ============================================================================
DO $$
DECLARE
  v_exp334_id uuid := 'f17f5206-bcbb-419f-ab84-b240ee1d662b'::uuid; -- EXP/26/334 (Sept)
  v_exp335_id uuid := 'ceabef41-1642-47e0-9448-4a012b0b8b23'::uuid; -- EXP/26/335 (Oct)
  v_bank_txn_a uuid := '93a47258-80b8-4bd4-b06a-0ce8fde906bd'::uuid; -- 3 Nov, Rp 3,900,000 debit
  v_line_bank uuid;
  v_amount_per_exp numeric := 1950000.00;
BEGIN
  -- Verify both expenses and bank statement line exist
  IF EXISTS (SELECT 1 FROM public.finance_expenses WHERE id = v_exp334_id)
     AND EXISTS (SELECT 1 FROM public.finance_expenses WHERE id = v_exp335_id)
     AND EXISTS (SELECT 1 FROM public.bank_statement_lines WHERE id = v_bank_txn_a AND debit_amount = 3900000) THEN

    SELECT bank_account_id INTO v_line_bank FROM public.bank_statement_lines WHERE id = v_bank_txn_a;

    -- Clear manual unlink protection
    UPDATE public.bank_statement_lines
    SET manually_unlinked = false,
        notes = 'Reconciled: Ricardo Fees CA Sept (EXP/26/334: Rp 1,950,000) + Oct (EXP/26/335: Rp 1,950,000)'
    WHERE id = v_bank_txn_a;

    -- Set atomic context
    PERFORM set_config('app.expense_atomic_bank_link', 'on', true);

    -- Update expense headers
    UPDATE public.finance_expenses
    SET payment_method = 'bank_transfer',
        bank_account_id = v_line_bank,
        paid_by = 'bank'
    WHERE id IN (v_exp334_id, v_exp335_id);

    -- Link EXP/26/334
    IF NOT EXISTS (
      SELECT 1 FROM public.bank_statement_allocations
      WHERE bank_statement_line_id = v_bank_txn_a AND document_type = 'expense' AND document_id = v_exp334_id
    ) THEN
      PERFORM public.link_bank_statement_line(v_bank_txn_a, 'expense', v_exp334_id, 'supplier', v_amount_per_exp);
    END IF;

    -- Link EXP/26/335
    IF NOT EXISTS (
      SELECT 1 FROM public.bank_statement_allocations
      WHERE bank_statement_line_id = v_bank_txn_a AND document_type = 'expense' AND document_id = v_exp335_id
    ) THEN
      PERFORM public.link_bank_statement_line(v_bank_txn_a, 'expense', v_exp335_id, 'supplier', v_amount_per_exp);
    END IF;

    -- Recalculate payment states
    PERFORM public.recalculate_expense_payment_state(v_exp334_id);
    PERFORM public.recalculate_expense_payment_state(v_exp335_id);
    PERFORM set_config('app.expense_atomic_bank_link', 'off', true);

    -- Update bank statement line status
    UPDATE public.bank_statement_lines
    SET reconciliation_status = 'matched',
        matching_status = 'confirmed'
    WHERE id = v_bank_txn_a;
  END IF;
END $$;

-- Note on Bank Txn B (ID: 663f66a3-702d-4c79-a0a9-e2a0718b6ade, 17 Nov 2026, Rp 4,000,000):
-- Left untouched, unlinked, and flagged for account owner review.
-- Note on EXP/26/203 and EXP/26/204:
-- Completely excluded from modifications per owner instruction.

COMMIT;
