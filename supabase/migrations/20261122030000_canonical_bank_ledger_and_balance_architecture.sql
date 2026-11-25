-- 20261122030000_canonical_bank_ledger_and_balance_architecture.sql
-- Canonical dynamic bank balance architecture, generalized reversal handling, and BPJS reconciliation consistency.

-- 1. Canonical effective bank ledger view with generalized reversal handling
CREATE OR REPLACE VIEW public.vw_bank_ledger_effective AS
SELECT
  ba.id AS bank_account_id,
  ba.account_number,
  ba.account_name,
  upper(ba.currency) AS bank_currency,
  je.id AS journal_entry_id,
  je.entry_number,
  je.entry_date,
  COALESCE(
    (
      SELECT min(bsl.transaction_date)
      FROM public.bank_statement_lines bsl
      WHERE bsl.bank_account_id = ba.id
        AND bsl.matched_entry_id = je.id
    ),
    (
      SELECT min(bsl2.transaction_date)
      FROM public.bank_statement_allocations a
      JOIN public.bank_statement_lines bsl2 ON bsl2.id = a.bank_statement_line_id
      WHERE a.journal_entry_id = je.id
        AND bsl2.bank_account_id = ba.id
    ),
    je.entry_date
  ) AS effective_bank_date,
  je.source_module,
  je.reference_id,
  je.reference_number,
  je.description,
  jel.id AS journal_line_id,
  jel.line_number,
  jel.account_id,
  CASE
    WHEN upper(ba.currency) = 'USD' THEN COALESCE(jel.transaction_debit, jel.debit)
    ELSE jel.debit
  END AS debit_amount,
  CASE
    WHEN upper(ba.currency) = 'USD' THEN COALESCE(jel.transaction_credit, jel.credit)
    ELSE jel.credit
  END AS credit_amount,
  CASE
    WHEN upper(ba.currency) = 'USD' THEN COALESCE(jel.transaction_debit, jel.debit) - COALESCE(jel.transaction_credit, jel.credit)
    ELSE jel.debit - jel.credit
  END AS net_amount,
  CASE
    WHEN je.source_module = 'historical_repair' AND (je.reference_number LIKE 'HR-REV%' OR je.entry_number LIKE 'HR-REV%') THEN 'excluded_historical_repair_reversal'
    WHEN EXISTS (
      SELECT 1 FROM public.journal_entries hrr
      WHERE hrr.id = je.reversed_by_id
        AND hrr.source_module = 'historical_repair'
        AND (hrr.reference_number LIKE 'HR-REV%' OR hrr.entry_number LIKE 'HR-REV%')
    ) THEN 'excluded_historical_repair_original'
    WHEN COALESCE(je.is_reversed, false) = false THEN 'effective_posted'
    WHEN COALESCE(je.is_reversed, false) = true AND (
      EXISTS (
        SELECT 1 FROM public.journal_entries rev
        WHERE rev.id = je.reversed_by_id
          AND rev.is_posted = true
          AND NOT (rev.source_module = 'historical_repair' AND (rev.reference_number LIKE 'HR-REV%' OR rev.entry_number LIKE 'HR-REV%'))
      )
      OR EXISTS (
        SELECT 1 FROM public.journal_entries orig
        WHERE orig.reversed_by_id = je.id
          AND orig.is_posted = true
          AND NOT (orig.source_module = 'historical_repair' AND (orig.reference_number LIKE 'HR-REV%' OR orig.entry_number LIKE 'HR-REV%'))
      )
    ) THEN 'effective_reversal_pair'
    ELSE 'excluded_voided'
  END AS ledger_treatment
FROM public.bank_accounts ba
JOIN public.journal_entry_lines jel ON jel.account_id = ba.coa_id
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE je.is_posted = true
  AND (
    upper(ba.currency) <> 'USD'
    OR (
      jel.transaction_currency = 'USD'
      OR (jel.debit = 0 AND jel.credit = 0)
      OR COALESCE(jel.transaction_debit, 0) > 0
      OR COALESCE(jel.transaction_credit, 0) > 0
    )
  )
  -- Preserve historical repair exclusions (reversals and their targets)
  AND NOT (
    je.source_module = 'historical_repair' AND (
      je.reference_number LIKE 'HR-REV%'
      OR je.entry_number LIKE 'HR-REV%'
    )
  )
  AND NOT (
    EXISTS (
      SELECT 1 FROM public.journal_entries hrr
      WHERE hrr.id = je.reversed_by_id
        AND hrr.source_module = 'historical_repair'
        AND (hrr.reference_number LIKE 'HR-REV%' OR hrr.entry_number LIKE 'HR-REV%')
    )
  )
  -- Generalized reversal treatment: Include unreversed journals AND balanced reversal pairs
  AND (
    COALESCE(je.is_reversed, false) = false
    OR (
      COALESCE(je.is_reversed, false) = true AND (
        EXISTS (
          SELECT 1 FROM public.journal_entries rev
          WHERE rev.id = je.reversed_by_id
            AND rev.is_posted = true
            AND NOT (rev.source_module = 'historical_repair' AND (rev.reference_number LIKE 'HR-REV%' OR rev.entry_number LIKE 'HR-REV%'))
        )
        OR EXISTS (
          SELECT 1 FROM public.journal_entries orig
          WHERE orig.reversed_by_id = je.id
            AND orig.is_posted = true
            AND NOT (orig.source_module = 'historical_repair' AND (orig.reference_number LIKE 'HR-REV%' OR orig.entry_number LIKE 'HR-REV%'))
        )
      )
    )
  );

-- 2. Correct calculate_bank_account_book_balance to query canonical view
CREATE OR REPLACE FUNCTION public.calculate_bank_account_book_balance(
  p_bank_account_id uuid,
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_opening numeric := 0;
  v_opening_date date;
  v_effective_movements numeric := 0;
BEGIN
  SELECT COALESCE(opening_balance, 0),
         COALESCE(opening_balance_date, DATE '1900-01-01')
    INTO v_opening, v_opening_date
    FROM public.bank_accounts
   WHERE id = p_bank_account_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_as_of_date < v_opening_date THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(SUM(v.net_amount), 0)
    INTO v_effective_movements
    FROM public.vw_bank_ledger_effective v
   WHERE v.bank_account_id = p_bank_account_id
     AND v.effective_bank_date >= v_opening_date
     AND v.effective_bank_date <= p_as_of_date;

  RETURN ROUND(v_opening + v_effective_movements, 2);
END;
$$;

-- 3. Correct get_bank_account_balances to derive from canonical view
CREATE OR REPLACE FUNCTION public.get_bank_account_balances(p_as_of_date date DEFAULT CURRENT_DATE)
RETURNS TABLE(
  bank_account_id uuid,
  account_name text,
  bank_name text,
  account_number text,
  currency text,
  coa_id uuid,
  coa_code text,
  opening_balance numeric,
  opening_balance_date date,
  total_debits numeric,
  total_credits numeric,
  book_balance numeric,
  statement_balance numeric,
  as_of_date date
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  WITH stmt_aggregates AS (
    SELECT bsl.bank_account_id,
           COALESCE(SUM(bsl.debit_amount), 0) AS stmt_debits,
           COALESCE(SUM(bsl.credit_amount), 0) AS stmt_credits
      FROM public.bank_statement_lines bsl
      JOIN public.bank_accounts ba ON ba.id = bsl.bank_account_id
     WHERE bsl.transaction_date <= p_as_of_date
       AND bsl.transaction_date >= COALESCE(ba.opening_balance_date, DATE '1900-01-01')
     GROUP BY bsl.bank_account_id
  ),
  latest_stmt AS (
    SELECT DISTINCT ON (bsl.bank_account_id)
           bsl.bank_account_id,
           COALESCE(NULLIF(bsl.statement_balance, 0), NULLIF(bsl.running_balance, 0)) AS last_stmt_bal
      FROM public.bank_statement_lines bsl
      JOIN public.bank_accounts ba ON ba.id = bsl.bank_account_id
     WHERE bsl.transaction_date <= p_as_of_date
       AND bsl.transaction_date >= COALESCE(ba.opening_balance_date, DATE '1900-01-01')
       AND (COALESCE(bsl.statement_balance, 0) <> 0 OR COALESCE(bsl.running_balance, 0) <> 0)
     ORDER BY bsl.bank_account_id, bsl.transaction_date DESC, bsl.id DESC
  ),
  effective_ledger AS (
    SELECT v.bank_account_id,
           COALESCE(SUM(v.debit_amount), 0) AS total_dr,
           COALESCE(SUM(v.credit_amount), 0) AS total_cr,
           COALESCE(SUM(v.net_amount), 0) AS total_net
      FROM public.vw_bank_ledger_effective v
      JOIN public.bank_accounts ba ON ba.id = v.bank_account_id
     WHERE v.effective_bank_date <= p_as_of_date
       AND v.effective_bank_date >= COALESCE(ba.opening_balance_date, DATE '1900-01-01')
     GROUP BY v.bank_account_id
  )
  SELECT ba.id AS bank_account_id,
         ba.account_name::text,
         ba.bank_name::text,
         ba.account_number::text,
         ba.currency::text,
         ba.coa_id,
         coa.code::text AS coa_code,
         COALESCE(ba.opening_balance, 0) AS opening_balance,
         ba.opening_balance_date,
         COALESCE(el.total_dr, 0) AS total_debits,
         COALESCE(el.total_cr, 0) AS total_credits,
         ROUND(COALESCE(ba.opening_balance, 0) + COALESCE(el.total_net, 0), 2) AS book_balance,
         COALESCE(
           ls.last_stmt_bal,
           ROUND(COALESCE(ba.opening_balance, 0) + COALESCE(sa.stmt_credits, 0) - COALESCE(sa.stmt_debits, 0), 2)
         ) AS statement_balance,
         p_as_of_date AS as_of_date
    FROM public.bank_accounts ba
    LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
    LEFT JOIN stmt_aggregates sa ON sa.bank_account_id = ba.id
    LEFT JOIN latest_stmt ls ON ls.bank_account_id = ba.id
    LEFT JOIN effective_ledger el ON el.bank_account_id = ba.id
   WHERE ba.is_active = true;
END;
$$;

-- 4. Correct sync_bank_account_balance to use canonical calculate_bank_account_book_balance
CREATE OR REPLACE FUNCTION public.sync_bank_account_balance(p_bank_account_id uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  UPDATE public.bank_accounts ba
  SET current_balance = public.calculate_bank_account_book_balance(ba.id, CURRENT_DATE)
  WHERE (p_bank_account_id IS NULL OR ba.id = p_bank_account_id);
END;
$$;

-- 5. Update link_bank_statement_line to gracefully handle 'journal' payment_kind
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
AS $$
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

  IF p_document_type = 'expense' THEN
    v_kind := CASE
      WHEN p_payment_kind = 'pph23' THEN 'pph23'
      WHEN p_payment_kind IS NULL OR btrim(p_payment_kind) = '' OR p_payment_kind = 'unclassified' THEN 'supplier'
      ELSE 'supplier'
    END;
  ELSE
    v_kind := CASE
      WHEN p_document_type = 'journal' THEN 'other'
      WHEN p_payment_kind = 'journal' THEN 'other'
      WHEN p_payment_kind IS NOT NULL AND btrim(p_payment_kind) <> '' THEN p_payment_kind
      WHEN p_document_type = 'fund_transfer' THEN 'fund_transfer'
      WHEN p_document_type = 'receipt' THEN 'customer_receipt'
      WHEN p_document_type = 'payment' THEN 'supplier'
      WHEN p_document_type = 'tax_payment' THEN 'tax'
      WHEN p_document_type = 'petty_cash' THEN 'petty_cash'
      ELSE 'supplier'
    END;
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

  v_bank_total := COALESCE(NULLIF(v_line.debit_amount, 0), NULLIF(v_line.credit_amount, 0), 0);
  v_bank_allocated := COALESCE((
    SELECT sum(allocation_amount) FROM public.bank_statement_allocations
     WHERE bank_statement_line_id = p_bank_line_id
  ), 0);
  v_bank_remaining := round(v_bank_total - v_bank_allocated, 2);

  IF p_document_type = 'expense' THEN
    v_expense_currency := upper(COALESCE(v_expense.currency_code, 'IDR'));
    v_doc_total := round(COALESCE(NULLIF(v_expense.settlement_amount, 0), v_expense.amount, 0), 2);
    v_doc_allocated := COALESCE((
      SELECT sum(allocation_amount) FROM public.bank_statement_allocations
       WHERE document_type = 'expense' AND document_id = p_document_id
    ), 0);
    SELECT id INTO v_settlement_coa FROM public.chart_of_accounts WHERE code = '2110';
    IF v_settlement_coa IS NULL THEN RAISE EXCEPTION 'Accounts Payable (2110) account not found'; END IF;
  ELSE
    v_doc_allocated := COALESCE((
      SELECT sum(allocation_amount) FROM public.bank_statement_allocations
       WHERE document_type = p_document_type AND document_id = p_document_id
    ), 0);
  END IF;

  v_doc_remaining := round(v_doc_total - v_doc_allocated, 2);

  IF EXISTS (
    SELECT 1 FROM public.bank_statement_allocations a
     WHERE a.bank_statement_line_id = p_bank_line_id
       AND a.document_type = p_document_type
       AND a.document_id = p_document_id
       AND a.payment_kind = v_kind
  ) THEN
    SELECT a.allocation_amount INTO v_allocate
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
$$;

-- 6. Insert canonical allocation for BPJS line c702cd7f-3c45-4fff-80cc-d288297e3c94 and JE2611-0480 if missing
INSERT INTO public.bank_statement_allocations(
  id, bank_statement_line_id, document_type, document_id, journal_entry_id,
  allocation_amount, payment_kind, created_by
)
SELECT
  'c702cd7f-3c45-4fff-80cc-d288297e3c94'::uuid,
  'c702cd7f-3c45-4fff-80cc-d288297e3c94'::uuid,
  'journal',
  '0d904a76-4b95-436e-a2f4-555ac5c1d446'::uuid,
  '0d904a76-4b95-436e-a2f4-555ac5c1d446'::uuid,
  767520.00,
  'other',
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.bank_statement_allocations
  WHERE bank_statement_line_id = 'c702cd7f-3c45-4fff-80cc-d288297e3c94'::uuid
);

-- Sync current_balance on bank accounts
SELECT public.sync_bank_account_balance();
