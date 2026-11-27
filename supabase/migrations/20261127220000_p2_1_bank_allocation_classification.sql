-- Priority 2.1: Bank Allocation Classification Separation & Document-Type Mapping
-- 1. Preserve bank_statement_lines.payment_kind as Bank Transaction Classification.
--    Add settlement_payment_kind compatibility column for allocation-level settlement category.
-- 2. Update sync_bank_line_allocation_owner() so it never overwrites bank_statement_lines.payment_kind.
-- 3. Update link_bank_statement_line() and _link_native_bank_document() to use canonical
--    document-type defaults while honoring explicit valid allocation categories.

ALTER TABLE public.bank_statement_lines
  ADD COLUMN IF NOT EXISTS settlement_payment_kind text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bank_statement_lines'::regclass
      AND conname = 'bank_statement_lines_settlement_payment_kind_check'
  ) THEN
    ALTER TABLE public.bank_statement_lines
      ADD CONSTRAINT bank_statement_lines_settlement_payment_kind_check
      CHECK (
        settlement_payment_kind IS NULL OR settlement_payment_kind = ANY (
          ARRAY['supplier'::text, 'pph23'::text, 'salary'::text, 'tax'::text, 'petty_cash'::text,
                'capital'::text, 'admin_expense'::text, 'customer_receipt'::text,
                'fund_transfer'::text, 'other'::text, 'unclassified'::text]
        )
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.sync_bank_line_allocation_owner(p_bank_line_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer;
  v_only public.bank_statement_allocations%ROWTYPE;
  v_target_expense_id uuid;
  v_target_receipt_id uuid;
  v_target_payment_id uuid;
  v_target_ft_id uuid;
  v_target_pc_id uuid;
  v_target_tax_id uuid;
  v_target_entry_id uuid;
  v_target_kind text;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = p_bank_line_id;

  IF v_count = 1 THEN
    SELECT * INTO v_only
      FROM public.bank_statement_allocations
     WHERE bank_statement_line_id = p_bank_line_id;

    v_target_expense_id := CASE WHEN v_only.document_type = 'expense' THEN v_only.document_id END;
    v_target_receipt_id := CASE WHEN v_only.document_type = 'receipt' THEN v_only.document_id END;
    v_target_payment_id := CASE WHEN v_only.document_type = 'payment' THEN v_only.document_id END;
    v_target_ft_id := CASE WHEN v_only.document_type = 'fund_transfer' THEN v_only.document_id END;
    v_target_pc_id := CASE WHEN v_only.document_type = 'petty_cash' THEN v_only.document_id END;
    v_target_tax_id := CASE WHEN v_only.document_type = 'tax_payment' THEN v_only.document_id END;
    v_target_entry_id := v_only.journal_entry_id;
    v_target_kind := COALESCE(v_only.payment_kind,
      CASE v_only.document_type
        WHEN 'expense' THEN 'supplier'
        WHEN 'payment' THEN 'supplier'
        WHEN 'receipt' THEN 'customer_receipt'
        WHEN 'tax_payment' THEN 'tax'
        WHEN 'petty_cash' THEN 'petty_cash'
        WHEN 'fund_transfer' THEN 'fund_transfer'
        ELSE 'other'
      END
    );

    -- IMPORTANT: Never overwrite bank_statement_lines.payment_kind (Bank Transaction Classification).
    -- Store the allocation settlement category in settlement_payment_kind only.
    UPDATE public.bank_statement_lines SET
      matched_expense_id = v_target_expense_id,
      matched_receipt_id = v_target_receipt_id,
      matched_payment_id = v_target_payment_id,
      matched_fund_transfer_id = v_target_ft_id,
      matched_petty_cash_id = v_target_pc_id,
      matched_tax_payment_id = v_target_tax_id,
      matched_entry_id = v_target_entry_id,
      settlement_payment_kind = v_target_kind
    WHERE id = p_bank_line_id
      AND (
        matched_expense_id IS DISTINCT FROM v_target_expense_id OR
        matched_receipt_id IS DISTINCT FROM v_target_receipt_id OR
        matched_payment_id IS DISTINCT FROM v_target_payment_id OR
        matched_fund_transfer_id IS DISTINCT FROM v_target_ft_id OR
        matched_petty_cash_id IS DISTINCT FROM v_target_pc_id OR
        matched_tax_payment_id IS DISTINCT FROM v_target_tax_id OR
        matched_entry_id IS DISTINCT FROM v_target_entry_id OR
        settlement_payment_kind IS DISTINCT FROM v_target_kind
      );
  ELSE
    UPDATE public.bank_statement_lines SET
      matched_expense_id = NULL,
      matched_receipt_id = NULL,
      matched_payment_id = NULL,
      matched_fund_transfer_id = NULL,
      matched_petty_cash_id = NULL,
      matched_tax_payment_id = NULL,
      matched_entry_id = NULL,
      settlement_payment_kind = NULL
    WHERE id = p_bank_line_id
      AND (
        matched_expense_id IS NOT NULL OR
        matched_receipt_id IS NOT NULL OR
        matched_payment_id IS NOT NULL OR
        matched_fund_transfer_id IS NOT NULL OR
        matched_petty_cash_id IS NOT NULL OR
        matched_tax_payment_id IS NOT NULL OR
        matched_entry_id IS NOT NULL OR
        settlement_payment_kind IS NOT NULL
      );
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public._link_native_bank_document(p_line_id uuid, p_journal_id uuid, p_label text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_amount numeric;
  v_created_by uuid;
BEGIN
  UPDATE public.bank_statement_lines
  SET matched_entry_id = p_journal_id,
      reconciliation_status = 'recorded',
      matching_status = 'confirmed',
      matched_at = now(),
      matched_by = COALESCE(auth.uid(), matched_by),
      manually_unlinked = false,
      notes = p_label
  WHERE id = p_line_id
  RETURNING COALESCE(NULLIF(debit_amount, 0), credit_amount, 0), created_by INTO v_amount, v_created_by;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement line not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.bank_statement_allocations
    WHERE bank_statement_line_id = p_line_id AND journal_entry_id = p_journal_id
  ) THEN
    INSERT INTO public.bank_statement_allocations (
      bank_statement_line_id,
      document_type,
      document_id,
      journal_entry_id,
      allocation_amount,
      payment_kind,
      created_by
    ) VALUES (
      p_line_id,
      'journal',
      p_journal_id,
      p_journal_id,
      v_amount,
      'other',
      COALESCE(auth.uid(), v_created_by)
    );
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,
  p_document_type text,
  p_document_id uuid,
  p_payment_kind text DEFAULT NULL::text,
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
  v_explicit_kind text := NULLIF(btrim(COALESCE(p_payment_kind, '')), '');
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF p_document_type = 'expense' THEN
    v_kind := CASE
      WHEN v_explicit_kind = 'pph23' THEN 'pph23'
      ELSE 'supplier'
    END;
  ELSIF p_document_type = 'payment' THEN
    v_kind := COALESCE(NULLIF(v_explicit_kind, 'unclassified'), 'supplier');
  ELSIF p_document_type = 'receipt' THEN
    v_kind := CASE
      WHEN v_explicit_kind IS NOT NULL AND v_explicit_kind NOT IN ('supplier', 'unclassified') THEN v_explicit_kind
      ELSE 'customer_receipt'
    END;
  ELSIF p_document_type = 'fund_transfer' THEN
    v_kind := CASE
      WHEN v_explicit_kind IS NOT NULL AND v_explicit_kind NOT IN ('supplier', 'unclassified') THEN v_explicit_kind
      ELSE 'fund_transfer'
    END;
  ELSIF p_document_type = 'tax_payment' THEN
    v_kind := CASE
      WHEN v_explicit_kind IS NOT NULL AND v_explicit_kind NOT IN ('supplier', 'unclassified') THEN v_explicit_kind
      ELSE 'tax'
    END;
  ELSIF p_document_type = 'petty_cash' THEN
    v_kind := CASE
      WHEN v_explicit_kind IS NOT NULL AND v_explicit_kind NOT IN ('supplier', 'unclassified') THEN v_explicit_kind
      ELSE 'petty_cash'
    END;
  ELSIF p_document_type = 'journal' THEN
    v_kind := CASE
      WHEN v_explicit_kind IS NOT NULL AND v_explicit_kind NOT IN ('supplier', 'journal', 'unclassified') THEN v_explicit_kind
      ELSE 'other'
    END;
  ELSE
    RAISE EXCEPTION 'Unsupported reconciliation document type %', p_document_type;
  END IF;

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

  v_bank_total := COALESCE(NULLIF(v_line.debit_amount, 0), NULLIF(v_line.credit_amount, 0), 0);
  v_bank_allocated := COALESCE((
    SELECT sum(allocation_amount) FROM public.bank_statement_allocations
     WHERE bank_statement_line_id = p_bank_line_id
  ), 0);
  v_bank_remaining := GREATEST(v_bank_total - v_bank_allocated, 0);

  IF p_document_type = 'expense' THEN
    v_expense_currency := upper(coalesce(NULLIF(v_expense.transaction_currency, ''), NULLIF(v_expense.currency_code, ''), v_bank_currency, 'IDR'));
    IF v_expense_currency <> v_bank_currency THEN
      RAISE EXCEPTION 'Bank account currency (%) does not match expense currency (%)', v_bank_currency, v_expense_currency;
    END IF;
    v_doc_total := CASE WHEN v_kind = 'pph23' THEN COALESCE(v_expense.pph_amount, 0)
                        ELSE round(COALESCE(NULLIF(v_expense.settlement_amount, 0), GREATEST(COALESCE(v_expense.amount, 0) - COALESCE(v_expense.pph_amount, 0), 0), 0), 2) END;
    IF v_kind = 'pph23' THEN
      SELECT id INTO v_settlement_coa FROM public.chart_of_accounts WHERE code = '2131' LIMIT 1;
      IF v_settlement_coa IS NULL THEN RAISE EXCEPTION 'Account 2131 (PPh 23 Payable) not found'; END IF;
    ELSE
      SELECT id INTO v_settlement_coa FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
      IF v_settlement_coa IS NULL THEN RAISE EXCEPTION 'Account 2110 (Accounts Payable) not found'; END IF;
    END IF;
  END IF;

  v_doc_allocated := COALESCE((
    SELECT sum(allocation_amount) FROM public.bank_statement_allocations
     WHERE document_type = p_document_type AND document_id = p_document_id
       AND (p_document_type <> 'expense' OR payment_kind = v_kind)
  ), 0);
  v_doc_remaining := GREATEST(v_doc_total - v_doc_allocated, 0);

  IF EXISTS (
    SELECT 1 FROM public.bank_statement_allocations a
     WHERE a.bank_statement_line_id = p_bank_line_id
       AND a.document_type = p_document_type
       AND a.document_id = p_document_id
       AND a.payment_kind = v_kind
  ) THEN
    SELECT a.allocation_amount INTO v_allocate FROM public.bank_statement_allocations a
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
      'payment_kind', v_kind,
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
    'journal_entry_id', v_je,
    'payment_kind', v_kind
  );
END;
$function$;

-- -----------------------------------------------------------------------------
-- 5b. Preserve bank_statement_lines.payment_kind and clear
--     settlement_payment_kind in unmatch_bank_line(uuid)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unmatch_bank_line(p_bank_line_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_allocation_id uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  PERFORM 1 FROM public.bank_statement_lines WHERE id = p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement line not found';
  END IF;

  FOR v_allocation_id IN
    SELECT id
    FROM public.bank_statement_allocations
    WHERE bank_statement_line_id = p_bank_line_id
    ORDER BY id
    FOR UPDATE
  LOOP
    PERFORM public.unmatch_bank_statement_allocation(v_allocation_id);
  END LOOP;

  UPDATE public.bank_statement_lines
     SET matched_expense_id = NULL,
         matched_receipt_id = NULL,
         matched_payment_id = NULL,
         matched_fund_transfer_id = NULL,
         matched_petty_cash_id = NULL,
         matched_tax_payment_id = NULL,
         matched_entry_id = NULL,
         settlement_payment_kind = NULL,
         matching_status = 'unmatched',
         reconciliation_status = 'unmatched',
         matched_at = NULL,
         matched_by = NULL,
         notes = NULL,
         manually_unlinked = true
   WHERE id = p_bank_line_id;

  RETURN jsonb_build_object('success', true, 'bank_line_id', p_bank_line_id);
END;
$function$;

-- -----------------------------------------------------------------------------
-- 6. Deterministic normalization of legacy non-expense / non-payment
--    bank_statement_allocations carrying 'supplier':
--      - fund_transfer -> fund_transfer
--      - receipt       -> customer_receipt
--      - tax_payment   -> tax
--      - petty_cash    -> petty_cash
--      - journal       -> other
--    Guarded by NOT EXISTS against the unique index
--    (bank_statement_line_id, document_type, document_id, payment_kind)
--    so it never collides with an existing normalized allocation row.
--    Note: 'payment' (26 rows) and 'expense' (778 rows) are intentionally left
--    as 'supplier' because they represent legitimate supplier settlements.
-- -----------------------------------------------------------------------------
UPDATE public.bank_statement_allocations bsa
   SET payment_kind = CASE bsa.document_type
         WHEN 'fund_transfer' THEN 'fund_transfer'
         WHEN 'receipt'       THEN 'customer_receipt'
         WHEN 'tax_payment'   THEN 'tax'
         WHEN 'petty_cash'    THEN 'petty_cash'
         WHEN 'journal'       THEN 'other'
         ELSE bsa.payment_kind
       END
 WHERE bsa.payment_kind = 'supplier'
   AND bsa.document_type IN ('fund_transfer', 'receipt', 'tax_payment', 'petty_cash', 'journal')
   AND NOT EXISTS (
     SELECT 1
       FROM public.bank_statement_allocations dup
      WHERE dup.bank_statement_line_id = bsa.bank_statement_line_id
        AND dup.document_type = bsa.document_type
        AND dup.document_id = bsa.document_id
        AND dup.payment_kind = CASE bsa.document_type
              WHEN 'fund_transfer' THEN 'fund_transfer'
              WHEN 'receipt'       THEN 'customer_receipt'
              WHEN 'tax_payment'   THEN 'tax'
              WHEN 'petty_cash'    THEN 'petty_cash'
              WHEN 'journal'       THEN 'other'
            END
   );
