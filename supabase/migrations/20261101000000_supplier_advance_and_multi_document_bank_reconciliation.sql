-- ==============================================================================
-- Migration: 20261101000000_supplier_advance_and_multi_document_bank_reconciliation.sql
-- Description:
--   1. Create/ensure GL Leaf Account 1170 (Supplier Advances & Deposits).
--   2. Update post_payment_voucher to support supplier advances posting to GL 1170.
--   3. Update post_receipt_voucher to credit GL 1170 for supplier advance refunds
--      and dynamically assign COA 6910 for settlement differences.
--   4. Update save_receipt_voucher_with_allocations to persist adjustment_account_id.
--   5. Universal idempotency and multi-document linking in link_bank_statement_line.
--   6. Safe procedure repair_trans_exis_jaya_supplier_advance for dry-run/execution.
-- ==============================================================================

-- 1. Ensure Leaf Account 1170 (Supplier Advances & Deposits)
ALTER TABLE public.chart_of_accounts ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.chart_of_accounts(id);
ALTER TABLE public.chart_of_accounts ADD COLUMN IF NOT EXISTS is_header boolean DEFAULT false;
ALTER TABLE public.chart_of_accounts ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.chart_of_accounts ADD COLUMN IF NOT EXISTS account_group text;
ALTER TABLE public.chart_of_accounts ADD COLUMN IF NOT EXISTS name_id text;
ALTER TABLE public.bank_statement_lines ADD COLUMN IF NOT EXISTS matching_status text DEFAULT 'none';
ALTER TABLE public.bank_statement_lines ADD COLUMN IF NOT EXISTS manually_unlinked boolean DEFAULT false;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS reversed_by_id uuid;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS period_id uuid;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS posted_at timestamptz DEFAULT now();
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS amounts_are_functional boolean DEFAULT true;
ALTER TABLE public.journal_entry_lines ADD COLUMN IF NOT EXISTS transaction_currency text DEFAULT 'IDR';
ALTER TABLE public.journal_entry_lines ADD COLUMN IF NOT EXISTS transaction_debit numeric DEFAULT 0;
ALTER TABLE public.journal_entry_lines ADD COLUMN IF NOT EXISTS transaction_credit numeric DEFAULT 0;
ALTER TABLE public.journal_entry_lines ADD COLUMN IF NOT EXISTS functional_currency text DEFAULT 'IDR';
ALTER TABLE public.journal_entry_lines ADD COLUMN IF NOT EXISTS exchange_rate numeric DEFAULT 1;
ALTER TABLE public.finance_expenses ADD COLUMN IF NOT EXISTS transaction_currency text DEFAULT 'IDR';
ALTER TABLE public.finance_expenses ADD COLUMN IF NOT EXISTS currency_code text DEFAULT 'IDR';
ALTER TABLE public.finance_expenses ADD COLUMN IF NOT EXISTS functional_currency text DEFAULT 'IDR';
ALTER TABLE public.finance_expenses ADD COLUMN IF NOT EXISTS exchange_rate numeric DEFAULT 1;

CREATE OR REPLACE FUNCTION public.calculate_finance_expense_payable(p_expense_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(fe.amount, 0)
       + COALESCE(fe.ppn_amount, 0)
       - COALESCE(fe.pph_amount, 0)
  FROM public.finance_expenses fe WHERE fe.id = p_expense_id;
$$;
GRANT EXECUTE ON FUNCTION public.calculate_finance_expense_payable(uuid) TO authenticated, service_role, anon;

DO $$
DECLARE
  v_parent_id uuid;
BEGIN
  SELECT id INTO v_parent_id FROM public.chart_of_accounts WHERE code = '1100' LIMIT 1;
  IF NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE code = '1170') THEN
    INSERT INTO public.chart_of_accounts (
      code,
      name,
      name_id,
      account_type,
      account_group,
      parent_id,
      is_header,
      is_active,
      normal_balance,
      description
    ) VALUES (
      '1170',
      'Supplier Advances & Deposits',
      'Uang Muka & Deposit Pemasok',
      'asset',
      'Current Assets',
      v_parent_id,
      false,
      true,
      'debit',
      'Advances and deposits paid to suppliers for procurement'
    );
  ELSE
    UPDATE public.chart_of_accounts
    SET name = 'Supplier Advances & Deposits',
        account_type = 'asset',
        account_group = 'Current Assets',
        parent_id = COALESCE(parent_id, v_parent_id),
        is_header = false,
        is_active = true,
        normal_balance = 'debit'
    WHERE code = '1170';
  END IF;
END $$;

-- 2. Update post_payment_voucher to debit GL 1170 on supplier advances
CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pv RECORD;
  v_entry text;
  v_je uuid;
  v_bank_coa uuid;
  v_debit_coa uuid;
  v_charge_coa uuid;
  v_diff_coa uuid;
  v_pph_coa uuid;
  v_total_debit numeric;
  v_total_credit numeric;
  v_line int := 1;
  v_actual_poster uuid;
  v_party_type text;
  v_gross numeric;
  v_actual numeric;
  v_settle_diff numeric;
  v_debit_amount numeric;
  v_rate numeric := 1;
  v_charge_amt numeric := 0;
  v_pph_bank numeric := 0;
  v_bank_active boolean;
  v_bank_is_header boolean;
  v_bank_currency text;
  v_invoice_currency text;
  v_avail_advances numeric := 0;
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

  v_party_type := lower(COALESCE(v_pv.party_type, 'supplier'));
  v_gross := COALESCE(v_pv.amount, 0);
  v_actual := COALESCE(v_pv.actual_bank_debit, v_pv.bank_amount, v_gross);
  v_settle_diff := COALESCE(v_pv.settlement_discount, 0);
  v_charge_amt := COALESCE(v_pv.bank_charge, 0);
  v_pph_bank := COALESCE(v_pv.pph_amount, 0);
  v_rate := COALESCE(NULLIF(v_pv.exchange_rate, 0), 1);
  v_bank_currency := COALESCE(v_pv.payment_currency, 'IDR');
  v_invoice_currency := COALESCE(v_pv.payment_currency, 'IDR');

  -- Concurrency & Balance Validation for Customer Refund
  IF v_party_type = 'customer' AND v_pv.customer_id IS NOT NULL THEN
    PERFORM id FROM public.customers WHERE id = v_pv.customer_id FOR UPDATE;

    SELECT COALESCE(SUM(
      (rv.amount * COALESCE(rv.exchange_rate, 1)) - COALESCE(va.allocated, 0)
    ), 0)
    INTO v_avail_advances
    FROM public.receipt_vouchers rv
    LEFT JOIN (
      SELECT receipt_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY receipt_voucher_id
    ) va ON va.receipt_voucher_id = rv.id
    WHERE rv.customer_id = v_pv.customer_id
      AND rv.is_posted = true;

    v_avail_advances := v_avail_advances - COALESCE((
      SELECT SUM(
        (pv2.amount * COALESCE(pv2.exchange_rate, 1)) + COALESCE(pv2.settlement_discount, 0)
      )
      FROM public.payment_vouchers pv2
      WHERE pv2.customer_id = v_pv.customer_id
        AND pv2.party_type = 'customer'
        AND pv2.is_posted = true
        AND pv2.id <> p_pv_id
    ), 0);

    IF (v_actual + v_settle_diff) > (v_avail_advances + 0.01) THEN
      RAISE EXCEPTION 'Customer refund total settlement (%) exceeds available refundable advance/credit balance (%)',
        (v_actual + v_settle_diff), v_avail_advances;
    END IF;
  END IF;

  -- Resolve Bank / Cash Credit Account
  IF v_pv.payment_method IN ('bank_transfer', 'check', 'giro') THEN
    IF v_pv.bank_account_id IS NULL THEN
      RAISE EXCEPTION 'Bank account is required for % payments (voucher %)', v_pv.payment_method, v_pv.voucher_number;
    END IF;

    SELECT ba.coa_id, coa.is_active, coa.is_header, upper(ba.currency)
    INTO v_bank_coa, v_bank_active, v_bank_is_header, v_bank_currency
    FROM public.bank_accounts ba
    LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
    WHERE ba.id = v_pv.bank_account_id;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'Selected bank account % has no General Ledger account linked', v_pv.bank_account_id;
    END IF;
    IF NOT COALESCE(v_bank_active, false) THEN
      RAISE EXCEPTION 'Linked bank GL account % is inactive', v_bank_coa;
    END IF;
    IF COALESCE(v_bank_is_header, false) THEN
      RAISE EXCEPTION 'Linked bank GL account % is a header account — leaf required', v_bank_coa;
    END IF;

    IF upper(COALESCE(v_pv.payment_currency, 'IDR')) <> v_bank_currency THEN
      RAISE EXCEPTION 'Payment currency (%) must match bank account currency (%)', v_pv.payment_currency, v_bank_currency;
    END IF;

  ELSIF v_pv.payment_method = 'cash' THEN
    SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
    FROM public.chart_of_accounts
    WHERE code = '1101' AND is_active = true AND is_header = false LIMIT 1;

    IF v_bank_coa IS NULL THEN
      SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
      FROM public.chart_of_accounts
      WHERE code = '1102' AND is_active = true AND is_header = false LIMIT 1;
    END IF;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'No active postable Cash/Petty Cash GL account found (GL 1101/1102)';
    END IF;

  ELSE
    RAISE EXCEPTION 'Unsupported payment method: % for payment voucher %', v_pv.payment_method, v_pv.voucher_number;
  END IF;

  -- Resolve Debit Control Account
  IF v_party_type = 'supplier' THEN
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSIF v_pv.payment_purpose = 'supplier_advance' OR v_pv.settlement_against = 'advance' THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1170' AND is_active = true AND is_header = false LIMIT 1;
    END IF;

    IF v_debit_coa IS NULL THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2100' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;
    v_debit_amount := (v_gross + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'customer' THEN
    SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2101' AND is_active = true AND is_header = false LIMIT 1;
    IF v_debit_coa IS NULL THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2100' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    IF v_debit_coa IS NULL THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_debit_amount := (v_gross + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'employee' THEN
    IF v_pv.payment_purpose = 'salary_advance' THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '5101' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_debit_amount := (v_gross + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'director' THEN
    DECLARE
      v_dir_loan_acc uuid;
    BEGIN
      SELECT loan_account_id INTO v_dir_loan_acc FROM public.directors WHERE id = v_pv.staff_id;
      IF v_dir_loan_acc IS NOT NULL THEN
        v_debit_coa := v_dir_loan_acc;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2105' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END;
    v_debit_amount := v_gross * v_rate;

  ELSE
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_debit_amount := (v_gross + v_settle_diff) * v_rate;
  END IF;

  IF v_debit_coa IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts WHERE id = v_debit_coa AND is_active = true AND is_header = false
  ) THEN
    RAISE EXCEPTION 'Debit control account could not be resolved or is inactive/header for payment voucher %', v_pv.voucher_number;
  END IF;

  -- Resolve bank charge account if any
  IF v_charge_amt > 0 THEN
    SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '8101' AND is_active = true AND is_header = false LIMIT 1;
    IF v_charge_coa IS NULL THEN
      SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
  END IF;

  -- Resolve settlement difference account if any
  IF v_settle_diff > 0 THEN
    IF v_pv.adjustment_account_id IS NOT NULL THEN
      SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE id = v_pv.adjustment_account_id AND is_active = true AND is_header = false;
    END IF;
    IF v_diff_coa IS NULL THEN
      SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '6910' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    IF v_diff_coa IS NULL THEN
      SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
  END IF;

  v_total_debit := v_debit_amount + (v_charge_amt * v_rate);
  v_total_credit := (v_actual * v_rate) + (v_settle_diff * v_rate);

  IF abs(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Payment voucher journal does not balance: Debit (%) != Credit (%)', v_total_debit, v_total_credit;
  END IF;

  v_entry := public.next_journal_entry_number();

  INSERT INTO public.journal_entries(
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by,
    created_by, transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_entry, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number,
    'Payment Voucher (' || v_party_type || '): ' || v_pv.voucher_number,
    v_total_debit, v_total_credit, true, v_actual_poster,
    v_actual_poster, v_bank_currency, 'IDR', v_rate
  ) RETURNING id INTO v_je;

  -- Line 1: Debit Control Account (Supplier AP or Advance, Customer Refund, Staff Advance, etc.)
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, payee_id
  ) VALUES (
    v_je, v_line, v_debit_coa,
    CASE 
      WHEN v_party_type = 'supplier' AND (v_pv.payment_purpose = 'supplier_advance' OR v_pv.settlement_against = 'advance') THEN 'Supplier Advance - '
      WHEN v_party_type = 'supplier' THEN 'Supplier Payment - '
      WHEN v_party_type = 'customer' THEN 'Customer Refund - '
      WHEN v_party_type = 'employee' THEN 'Staff Payment - '
      WHEN v_party_type = 'director' THEN 'Director Loan Repayment - '
      ELSE 'Payment - '
    END || v_pv.voucher_number,
    v_debit_amount, 0,
    v_invoice_currency, (v_gross + v_settle_diff), 0, v_rate,
    v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
  );
  v_line := v_line + 1;

  -- Line 2: Bank Charge
  IF v_charge_amt > 0 AND v_charge_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_charge_coa, 'Bank Charge - ' || v_pv.voucher_number, v_charge_amt * v_rate, 0,
      v_bank_currency, v_charge_amt, 0, 1,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3: Credit Settlement Discount / Difference
  IF v_settle_diff > 0 AND v_diff_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_diff_coa, 'Settlement Discount / Difference - ' || v_pv.voucher_number, 0, v_settle_diff * v_rate,
      v_bank_currency, 0, v_settle_diff, 1,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 4: Credit Bank / Cash with actual cash paid
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, payee_id
  ) VALUES (
    v_je, v_line, v_bank_coa, 'Bank Payment - ' || v_pv.voucher_number, 0, v_actual * v_rate,
    v_bank_currency, 0, v_actual, 1,
    v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
  );

  UPDATE public.payment_vouchers SET is_posted = true, journal_entry_id = v_je WHERE id = p_pv_id;

  -- Synchronize bank account current_balance with authoritative GL
  IF v_pv.bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_pv.bank_account_id);
  END IF;

  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES('payment_vouchers', p_pv_id, 'update', jsonb_build_object('is_posted', false), jsonb_build_object('is_posted', true, 'journal_entry_id', v_je), v_actual_poster);
END;
$function$;

-- 3. Update post_receipt_voucher to credit GL 1170 for supplier advance refunds and dynamically assign COA 6910
CREATE OR REPLACE FUNCTION public.post_receipt_voucher(p_rv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rv                 RECORD;
  v_je_id              UUID;
  v_je_number          TEXT;
  v_bank_account_id    UUID;
  v_credit_account_id  UUID;
  v_diff_account_id    UUID;
  v_actual_poster      UUID;
  v_rate               NUMERIC := 1;
  v_actual_received    NUMERIC;
  v_settle_diff        NUMERIC := 0;
  v_carrying_amount    NUMERIC := 0;
  v_total_debit        NUMERIC;
  v_total_credit       NUMERIC;
  v_line               INTEGER := 1;
  v_currency           TEXT;
  v_party_type         TEXT;
  v_avail_advances     NUMERIC := 0;
  v_bank_curr          TEXT;
  v_bank_active        BOOLEAN;
  v_bank_coa_id        UUID;
  v_coa_code           TEXT;
  v_coa_name           TEXT;
  v_coa_is_header      BOOLEAN;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  v_actual_poster := COALESCE(auth.uid(), p_posted_by);

  SELECT * INTO v_rv FROM public.receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id;
  END IF;

  IF v_rv.is_posted THEN
    RAISE EXCEPTION 'Receipt voucher % is already posted', v_rv.voucher_number;
  END IF;

  v_party_type := lower(COALESCE(v_rv.party_type, 'customer'));
  v_actual_received := COALESCE(v_rv.amount, 0);
  v_settle_diff := COALESCE(v_rv.settlement_discount, 0);
  v_carrying_amount := v_actual_received + v_settle_diff;
  v_rate := COALESCE(NULLIF(v_rv.exchange_rate, 0), 1);
  v_currency := COALESCE(v_rv.currency_code, v_rv.transaction_currency, 'IDR');

  -- Strict Validation: Bank Account and Leaf COA
  IF v_rv.payment_method IN ('bank_transfer', 'check', 'giro') THEN
    IF v_rv.bank_account_id IS NULL THEN
      RAISE EXCEPTION 'Bank account selection is mandatory for % receipts (voucher %)', v_rv.payment_method, v_rv.voucher_number;
    END IF;

    SELECT ba.coa_id, ba.is_active, upper(ba.currency), coa.code, coa.name, coa.is_header
    INTO v_bank_coa_id, v_bank_active, v_bank_curr, v_coa_code, v_coa_name, v_coa_is_header
    FROM public.bank_accounts ba
    LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
    WHERE ba.id = v_rv.bank_account_id;

    IF v_bank_coa_id IS NULL THEN
      RAISE EXCEPTION 'Bank account % does not have a linked General Ledger account', v_rv.bank_account_id;
    END IF;

    IF NOT COALESCE(v_bank_active, false) THEN
      RAISE EXCEPTION 'Selected bank account % is inactive', v_rv.bank_account_id;
    END IF;

    IF COALESCE(v_coa_is_header, false) THEN
      RAISE EXCEPTION 'Journal lines cannot be posted to header account % — use a leaf account instead (P0001)', v_coa_code;
    END IF;

    IF upper(v_currency) <> v_bank_curr THEN
      RAISE EXCEPTION 'Receipt voucher currency (%) does not match selected bank account currency (%)', v_currency, v_bank_curr;
    END IF;

    v_bank_account_id := v_bank_coa_id;

  ELSIF v_rv.payment_method = 'cash' THEN
    SELECT id INTO v_bank_account_id FROM public.chart_of_accounts WHERE code = '1101' AND is_active = true AND is_header = false LIMIT 1;
    IF v_bank_account_id IS NULL THEN
      SELECT id INTO v_bank_account_id FROM public.chart_of_accounts WHERE code = '1102' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    IF v_bank_account_id IS NULL THEN
      RAISE EXCEPTION 'No active postable Cash/Petty Cash GL account found (GL 1101/1102)';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported payment method: % for receipt voucher %', v_rv.payment_method, v_rv.voucher_number;
  END IF;

  -- Concurrency & Balance Validation for Supplier Refund
  IF v_party_type = 'supplier' AND v_rv.supplier_id IS NOT NULL THEN
    PERFORM id FROM public.suppliers WHERE id = v_rv.supplier_id FOR UPDATE;

    -- 1. Unallocated supplier advances from payment vouchers
    SELECT COALESCE(SUM((pv.amount * COALESCE(pv.exchange_rate, 1)) - COALESCE(va.allocated, 0)), 0)
    INTO v_avail_advances
    FROM public.payment_vouchers pv
    LEFT JOIN (
      SELECT payment_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY payment_voucher_id
    ) va ON va.payment_voucher_id = pv.id
    WHERE pv.supplier_id = v_rv.supplier_id
      AND pv.is_posted = true;

    -- 2. Include unallocated outgoing bank statement lines for this supplier
    v_avail_advances := v_avail_advances + COALESCE((
      SELECT SUM(bsl.debit_amount - COALESCE(bsa.allocated, 0))
      FROM public.bank_statement_lines bsl
      JOIN public.suppliers s ON s.id = v_rv.supplier_id
      LEFT JOIN (
        SELECT bank_statement_line_id, SUM(allocation_amount) as allocated
        FROM public.bank_statement_allocations
        GROUP BY bank_statement_line_id
      ) bsa ON bsa.bank_statement_line_id = bsl.id
      WHERE bsl.debit_amount > 0
        AND (bsl.debit_amount - COALESCE(bsa.allocated, 0)) > 0.01
        AND (
          bsl.description ILIKE ('%' || s.company_name || '%')
          OR bsl.description ILIKE ('%' || trim(regexp_replace(s.company_name, '^(PT[.]?|CV[.]?)[[:space:]]*|[[:space:]]*(PT[.]?|CV[.]?)$', '', 'gi')) || '%')
        )
    ), 0);

    -- 3. Subtract previously posted supplier refund receipt vouchers
    v_avail_advances := v_avail_advances - COALESCE((
      SELECT SUM(
        (rv.amount * COALESCE(rv.exchange_rate, 1)) + COALESCE(rv.settlement_discount, 0)
      )
      FROM public.receipt_vouchers rv
      WHERE rv.supplier_id = v_rv.supplier_id
        AND rv.party_type = 'supplier'
        AND rv.is_posted = true
        AND rv.id <> p_rv_id
    ), 0);

    IF (v_actual_received + v_settle_diff) > (v_avail_advances + 0.01) THEN
      RAISE EXCEPTION 'Supplier refund total settlement (%) exceeds available refundable advance balance (%)',
        (v_actual_received + v_settle_diff), v_avail_advances;
    END IF;
  END IF;

  -- Resolve Credit Control Account
  IF v_party_type = 'customer' THEN
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSE
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
      IF v_credit_account_id IS NULL THEN
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1100' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;

  ELSIF v_party_type = 'supplier' THEN
    -- Supplier Refund clears Supplier Advances & Deposits (GL 1170)
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSE
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1170' AND is_active = true AND is_header = false LIMIT 1;
      IF v_credit_account_id IS NULL THEN
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
      IF v_credit_account_id IS NULL THEN
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2100' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;

  ELSIF v_party_type = 'employee' THEN
    SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;
    IF v_credit_account_id IS NULL THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
    END IF;

  ELSIF v_party_type = 'director' THEN
    SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2105' AND is_active = true AND is_header = false LIMIT 1;
    IF v_credit_account_id IS NULL THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
    END IF;

  ELSE
    RAISE EXCEPTION 'Unsupported party type: %', v_party_type;
  END IF;

  IF v_credit_account_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts WHERE id = v_credit_account_id AND is_active = true AND is_header = false
  ) THEN
    RAISE EXCEPTION 'Credit control account could not be resolved or is inactive/header for voucher %', v_rv.voucher_number;
  END IF;

  -- Resolve Settlement Difference Account (COA 6910 default)
  IF v_settle_diff > 0 THEN
    IF v_rv.adjustment_account_id IS NOT NULL THEN
      SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE id = v_rv.adjustment_account_id AND is_active = true AND is_header = false;
    END IF;
    IF v_diff_account_id IS NULL THEN
      SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6910' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    IF v_diff_account_id IS NULL THEN
      SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    IF v_diff_account_id IS NULL THEN
      SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '8102' AND is_active = true AND is_header = false LIMIT 1;
    END IF;

    IF v_diff_account_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.chart_of_accounts WHERE id = v_diff_account_id AND is_active = true AND is_header = false
    ) THEN
      RAISE EXCEPTION 'Settlement adjustment account could not be resolved or is inactive/header for voucher %', v_rv.voucher_number;
    END IF;
  END IF;

  v_total_debit := v_actual_received + CASE WHEN v_settle_diff > 0 THEN v_settle_diff ELSE 0 END;
  v_total_credit := v_carrying_amount;

  IF abs(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry debit total (%) does not balance with credit total (%)', v_total_debit, v_total_credit;
  END IF;

  v_je_number := public.next_journal_entry_number();

  INSERT INTO public.journal_entries (
    entry_number,
    entry_date,
    source_module,
    reference_id,
    reference_number,
    description,
    total_debit,
    total_credit,
    is_posted,
    posted_by,
    created_by,
    transaction_currency,
    functional_currency,
    exchange_rate
  ) VALUES (
    v_je_number,
    v_rv.voucher_date,
    'receipt',
    v_rv.id,
    v_rv.voucher_number,
    'Receipt Voucher (' || v_party_type || '): ' || v_rv.voucher_number,
    v_total_debit,
    v_total_credit,
    TRUE,
    v_actual_poster,
    v_actual_poster,
    v_currency,
    'IDR',
    v_rate
  ) RETURNING id INTO v_je_id;

  -- Line 1 (Dr): Bank or Cash
  INSERT INTO public.journal_entry_lines (
    journal_entry_id,
    line_number,
    account_id,
    description,
    debit,
    credit,
    customer_id,
    supplier_id,
    transaction_currency,
    transaction_debit,
    transaction_credit,
    exchange_rate
  ) VALUES (
    v_je_id,
    v_line,
    v_bank_account_id,
    'Receipt: ' || v_rv.voucher_number,
    v_actual_received,
    0,
    v_rv.customer_id,
    v_rv.supplier_id,
    v_currency,
    v_actual_received,
    0,
    v_rate
  );
  v_line := v_line + 1;

  -- Line 2 (Dr): Settlement Discount / Rounding Difference (if > 0)
  IF v_settle_diff > 0 AND v_diff_account_id IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      line_number,
      account_id,
      description,
      debit,
      credit,
      customer_id,
      supplier_id,
      transaction_currency,
      transaction_debit,
      transaction_credit,
      exchange_rate
    ) VALUES (
      v_je_id,
      v_line,
      v_diff_account_id,
      'Settlement Difference: ' || v_rv.voucher_number,
      v_settle_diff,
      0,
      v_rv.customer_id,
      v_rv.supplier_id,
      v_currency,
      v_settle_diff,
      0,
      v_rate
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3 (Cr): Control Account (1170 for supplier refund, 1120 for customer receipt, etc.)
  INSERT INTO public.journal_entry_lines (
    journal_entry_id,
    line_number,
    account_id,
    description,
    debit,
    credit,
    customer_id,
    supplier_id,
    transaction_currency,
    transaction_debit,
    transaction_credit,
    exchange_rate
  ) VALUES (
    v_je_id,
    v_line,
    v_credit_account_id,
    CASE 
      WHEN v_party_type = 'supplier' THEN 'Supplier Advance Refund - '
      WHEN v_party_type = 'customer' THEN 'Customer Receipt - '
      ELSE 'Receipt - '
    END || v_rv.voucher_number,
    0,
    v_carrying_amount,
    v_rv.customer_id,
    v_rv.supplier_id,
    v_currency,
    0,
    v_carrying_amount,
    v_rate
  );
  v_line := v_line + 1;

  -- Recalculate Sales Invoice states if allocations were linked
  IF v_party_type = 'customer' THEN
    PERFORM public.recalculate_sales_invoice_payment_state(va.sales_invoice_id)
    FROM public.voucher_allocations va
    WHERE va.receipt_voucher_id = p_rv_id AND va.sales_invoice_id IS NOT NULL;
  END IF;

  UPDATE public.receipt_vouchers
  SET is_posted = TRUE,
      journal_entry_id = v_je_id,
      adjustment_account_id = COALESCE(adjustment_account_id, v_diff_account_id)
  WHERE id = p_rv_id;

  -- Synchronize bank account current_balance with authoritative GL
  IF v_rv.bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_rv.bank_account_id);
  END IF;

  INSERT INTO public.audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    'receipt_vouchers',
    p_rv_id,
    'update',
    jsonb_build_object('is_posted', false),
    jsonb_build_object('is_posted', true, 'journal_entry_id', v_je_id),
    v_actual_poster
  );
END;
$function$;

-- 4. Update save_receipt_voucher_with_allocations to persist adjustment_account_id
CREATE OR REPLACE FUNCTION public.save_receipt_voucher_with_allocations(
  p_receipt_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_alloc jsonb;
  v_bank_currency text;
  v_currency text;
  v_rate numeric;
  v_actor uuid;
  v_party_type text;
  v_customer_id uuid;
  v_supplier_id uuid;
  v_staff_id uuid;
  v_purpose text;
  v_settle_against text;
  v_settle_disc numeric;
  v_alloc_disc numeric;
  v_adj_reason text;
  v_adj_account_id uuid;
  v_adj_notes text;
  v_method text;
  v_bank_id uuid;
  v_ref text;
  v_amount numeric;
  v_desc text;
  v_date date;
  v_existing RECORD;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  v_actor := COALESCE(auth.uid(), NULLIF(p_payload->>'created_by','')::uuid);

  v_party_type := lower(COALESCE(p_payload->>'party_type', 'customer'));
  v_customer_id := NULLIF(p_payload->>'customer_id', '')::uuid;
  v_supplier_id := NULLIF(p_payload->>'supplier_id', '')::uuid;
  v_staff_id := NULLIF(p_payload->>'staff_id', '')::uuid;
  v_purpose := COALESCE(p_payload->>'payment_purpose', CASE WHEN v_party_type = 'supplier' THEN 'supplier_refund' ELSE 'invoice_payment' END);
  v_settle_against := COALESCE(p_payload->>'settlement_against', CASE WHEN v_party_type = 'customer' THEN 'specific_document' ELSE 'advance' END);
  v_settle_disc := COALESCE((p_payload->>'settlement_discount')::numeric, 0);
  v_adj_reason := NULLIF(p_payload->>'adjustment_reason', '');
  v_adj_account_id := NULLIF(p_payload->>'adjustment_account_id', '')::uuid;
  v_adj_notes := NULLIF(p_payload->>'adjustment_notes', '');
  v_method := COALESCE(p_payload->>'payment_method', 'bank_transfer');
  v_bank_id := NULLIF(p_payload->>'bank_account_id', '')::uuid;
  v_ref := NULLIF(p_payload->>'reference_number', '');
  v_amount := COALESCE((p_payload->>'amount')::numeric, 0);
  v_desc := NULLIF(p_payload->>'description', '');
  v_date := COALESCE(NULLIF(p_payload->>'voucher_date', '')::date, CURRENT_DATE);
  v_currency := upper(COALESCE(p_payload->>'transaction_currency', p_payload->>'currency_code', 'IDR'));
  v_rate := COALESCE(NULLIF((p_payload->>'exchange_rate')::numeric, 0), 1);

  -- Auto-assign default difference account 6910 if discount is positive and account not provided
  IF v_settle_disc > 0 AND v_adj_account_id IS NULL THEN
    SELECT id INTO v_adj_account_id FROM public.chart_of_accounts WHERE code = '6910' AND is_active = true AND is_header = false LIMIT 1;
  END IF;

  IF p_receipt_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.receipt_vouchers WHERE id = p_receipt_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receipt voucher % not found', p_receipt_id; END IF;
    IF v_existing.is_posted THEN RAISE EXCEPTION 'Cannot update posted receipt voucher %', v_existing.voucher_number; END IF;
    v_id := p_receipt_id;

    UPDATE public.receipt_vouchers
    SET voucher_date = v_date,
        party_type = v_party_type,
        customer_id = v_customer_id,
        supplier_id = v_supplier_id,
        staff_id = v_staff_id,
        payment_purpose = v_purpose,
        settlement_against = v_settle_against,
        settlement_discount = v_settle_disc,
        adjustment_reason = v_adj_reason,
        adjustment_account_id = v_adj_account_id,
        adjustment_notes = v_adj_notes,
        payment_method = v_method,
        bank_account_id = v_bank_id,
        reference_number = v_ref,
        amount = v_amount,
        settlement_amount = v_amount + v_settle_disc,
        description = v_desc,
        currency_code = v_currency,
        transaction_currency = v_currency,
        exchange_rate = v_rate
    WHERE id = v_id;

    DELETE FROM public.voucher_allocations WHERE receipt_voucher_id = v_id;
  ELSE
    INSERT INTO public.receipt_vouchers (
      voucher_number,
      voucher_date,
      party_type,
      customer_id,
      supplier_id,
      staff_id,
      payment_purpose,
      settlement_against,
      settlement_discount,
      adjustment_reason,
      adjustment_account_id,
      adjustment_notes,
      payment_method,
      bank_account_id,
      reference_number,
      amount,
      settlement_amount,
      description,
      currency_code,
      transaction_currency,
      exchange_rate,
      created_by
    ) VALUES (
      public.next_receipt_voucher_number(v_date),
      v_date,
      v_party_type,
      v_customer_id,
      v_supplier_id,
      v_staff_id,
      v_purpose,
      v_settle_against,
      v_settle_disc,
      v_adj_reason,
      v_adj_account_id,
      v_adj_notes,
      v_method,
      v_bank_id,
      v_ref,
      v_amount,
      v_amount + v_settle_disc,
      v_desc,
      v_currency,
      v_currency,
      v_rate,
      v_actor
    ) RETURNING id INTO v_id;
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_alloc_disc := COALESCE((v_alloc->>'discountAmount')::numeric, 0);
    INSERT INTO public.voucher_allocations (
      voucher_type,
      receipt_voucher_id,
      sales_invoice_id,
      sales_order_id,
      allocated_amount,
      settlement_discount,
      adjustment_reason,
      notes
    ) VALUES (
      'receipt',
      v_id,
      NULLIF(v_alloc->>'sales_invoice_id', '')::uuid,
      NULLIF(v_alloc->>'sales_order_id', '')::uuid,
      COALESCE((v_alloc->>'amount')::numeric, 0),
      v_alloc_disc,
      NULLIF(v_alloc->>'adjustment_reason', ''),
      NULLIF(v_alloc->>'notes', '')
    );
  END LOOP;

  RETURN v_id;
END;
$function$;

-- 5. Universal Idempotency & Safe Multi-Document Linking in link_bank_statement_line
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
    v_new_recon_status := 'unmatched';
    v_new_matching_status := 'none';
  ELSIF v_allocated < v_total - 0.01 THEN
    v_new_recon_status := 'partially_reconciled';
    v_new_matching_status := CASE WHEN v_existing_matching_status = 'confirmed' THEN 'confirmed' ELSE 'suggested' END;
  ELSE
    v_new_recon_status := 'matched';
    v_new_matching_status := CASE WHEN v_existing_matching_status = 'confirmed' THEN 'confirmed' ELSE 'suggested' END;
  END IF;

  UPDATE public.bank_statement_lines
     SET reconciliation_status = v_new_recon_status,
         matching_status = v_new_matching_status,
         matched_at = CASE WHEN v_allocated <= 0.01 THEN NULL ELSE COALESCE(matched_at, now()) END,
         matched_by = CASE WHEN v_allocated <= 0.01 THEN NULL ELSE COALESCE(matched_by, auth.uid()) END
   WHERE id = p_bank_line_id;
END;
$$;

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
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
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
    IF COALESCE(p_payment_kind, 'supplier') = 'supplier' THEN
      v_doc_total := COALESCE(public.calculate_finance_expense_payable(p_document_id), 0);
      SELECT id INTO v_settlement_coa FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    ELSIF p_payment_kind = 'pph23' THEN
      v_doc_total := COALESCE(v_expense.pph_amount, 0);
      SELECT id INTO v_settlement_coa FROM public.chart_of_accounts WHERE code = '2132' LIMIT 1;
    ELSE
      RAISE EXCEPTION 'Unsupported expense payment kind %', p_payment_kind;
    END IF;
    IF v_settlement_coa IS NULL THEN
      RAISE EXCEPTION 'Expense settlement account is not configured';
    END IF;

    SELECT
      COALESCE((SELECT sum(a.allocation_amount) FROM public.bank_statement_allocations a
                 WHERE a.document_type = 'expense' AND a.document_id = p_document_id
                   AND a.payment_kind = COALESCE(p_payment_kind, 'supplier')), 0)
      + COALESCE((SELECT sum(va.allocated_amount) FROM public.voucher_allocations va
                    JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
                   WHERE va.finance_expense_id = p_document_id
                     AND COALESCE(va.payment_kind, 'supplier') = COALESCE(p_payment_kind, 'supplier')
                     AND pv.is_posted = true), 0)
      INTO v_doc_allocated;
  ELSE
    SELECT COALESCE(sum(allocation_amount), 0) INTO v_doc_allocated
      FROM public.bank_statement_allocations
     WHERE document_type = p_document_type AND document_id = p_document_id
       AND payment_kind = COALESCE(p_payment_kind, 'supplier');
  END IF;

  v_bank_remaining := v_bank_total - v_bank_allocated;
  v_doc_remaining := v_doc_total - v_doc_allocated;

  -- Universal Idempotency: Return existing allocation safely if already recorded
  IF EXISTS (
    SELECT 1 FROM public.bank_statement_allocations a
     WHERE a.bank_statement_line_id = p_bank_line_id
       AND a.document_type = p_document_type
       AND a.document_id = p_document_id
       AND a.payment_kind = COALESCE(p_payment_kind, 'supplier')
  ) THEN
    SELECT a.allocation_amount, a.journal_entry_id INTO v_allocate, v_je
      FROM public.bank_statement_allocations a
     WHERE a.bank_statement_line_id = p_bank_line_id
       AND a.document_type = p_document_type
       AND a.document_id = p_document_id
       AND a.payment_kind = COALESCE(p_payment_kind, 'supplier')
     LIMIT 1;

    PERFORM public.sync_bank_line_allocation_owner(p_bank_line_id);
    UPDATE public.bank_statement_lines
       SET matched_at = COALESCE(matched_at, now()),
           matched_by = COALESCE(matched_by, auth.uid()),
           manually_unlinked = true
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
    v_allocate, COALESCE(p_payment_kind, 'supplier'), auth.uid()
  );

  PERFORM public.sync_bank_line_allocation_owner(p_bank_line_id);
  UPDATE public.bank_statement_lines
     SET matched_at = now(), matched_by = auth.uid(), manually_unlinked = true
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

-- 6. Safe Controlled Procedure for PT TRANS EXIS JAYA Supplier Advance & Refund Repair
CREATE OR REPLACE FUNCTION public.repair_trans_exis_jaya_supplier_advance(
  p_dry_run boolean DEFAULT true,
  p_actor uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor               uuid;
  v_supplier_id         uuid := '701bbcb1-3fe8-421f-acec-9d216193346d'::uuid; -- PT TRANS EXIS JAYA
  v_bank_line_id        uuid := '26fb3731-977e-41d1-a21b-661a29bd7c82'::uuid; -- 15 Oct Outgoing
  v_refund_line_id      uuid := 'b0757040-9080-455f-9ff8-6aa00e0331f7'::uuid; -- 30 Oct Incoming
  v_rv_id               uuid := '80b23e4e-ad5b-4d6d-bb60-2e8d25575e76'::uuid; -- RV2610-0018
  v_old_rv_je_id        uuid := 'e998a539-9138-43f2-92e2-4311ae1c4b2d'::uuid; -- JE2610-0239
  v_expense_id          uuid := '25974efd-37fe-400c-b635-514387acbb45'::uuid; -- EXP/26/317
  v_exp_je_id           uuid := '1a2c4c29-f93a-464c-9a9e-04b101f5b12e'::uuid; -- JE2610-0196
  v_bank_account_id     uuid := 'bfe79829-07d1-48ed-8965-ff9d367d758e'::uuid; -- BCA IDR
  
  -- Accounts
  v_bank_coa            uuid;
  v_bank_coa_code       text;
  v_coa_1170            uuid;
  v_coa_2110            uuid;
  v_coa_6910            uuid;
  
  -- State variables
  v_bank_before         numeric;
  v_bank_after          numeric;
  
  -- Existing records check
  v_bsl_15              public.bank_statement_lines%ROWTYPE;
  v_bsl_30              public.bank_statement_lines%ROWTYPE;
  v_rv                  public.receipt_vouchers%ROWTYPE;
  v_old_je              public.journal_entries%ROWTYPE;
  v_exp                 public.finance_expenses%ROWTYPE;
  v_exp_je              public.journal_entries%ROWTYPE;
  v_period_15_open      boolean;
  v_period_31_open      boolean;
  
  -- Allocations check
  v_bsl_15_alloc_sum    numeric;
  v_bsl_15_alloc_count  int;
  v_exp_alloc           public.bank_statement_allocations%ROWTYPE;
  
  -- Idempotency check: existing payment voucher & replacement
  v_existing_pv         public.payment_vouchers%ROWTYPE;
  v_is_already_repaired boolean := false;
  v_existing_rep_je     public.journal_entries%ROWTYPE;
  v_existing_rev_je     public.journal_entries%ROWTYPE;
  
  -- Generated IDs
  v_pv_id               uuid;
  v_pv_number           text;
  v_pv_je_id            uuid;
  v_pv_je_number        text;
  v_rev_je_id           uuid;
  v_rev_je_number       text;
  v_rep_je_id           uuid;
  v_rep_je_number       text;
  v_pv_alloc_id         uuid;
  
  -- Dynamic validation errors
  v_errors              text[] := ARRAY[]::text[];
BEGIN
  -- 1. Security Authorization Check
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  v_actor := COALESCE(auth.uid(), p_actor, '1075a773-bb55-4296-bc71-af2eab9a0780'::uuid);

  -- 2. Validate Chart of Accounts (COA 1170, 111101, 2110, 6910)
  SELECT id INTO v_coa_1170 FROM public.chart_of_accounts WHERE code = '1170' AND is_active = true AND is_header = false LIMIT 1;
  IF v_coa_1170 IS NULL THEN v_errors := array_append(v_errors, 'COA 1170 (Supplier Advances & Deposits) does not exist, is inactive, or is marked as header'); END IF;

  SELECT id INTO v_coa_6910 FROM public.chart_of_accounts WHERE code = '6910' AND is_active = true AND is_header = false LIMIT 1;
  IF v_coa_6910 IS NULL THEN v_errors := array_append(v_errors, 'COA 6910 (Settlement Discount & Rounding Difference) does not exist, is inactive, or is marked as header'); END IF;

  SELECT id INTO v_coa_2110 FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
  IF v_coa_2110 IS NULL THEN v_errors := array_append(v_errors, 'COA 2110 (Accounts Payable) does not exist, is inactive, or is marked as header'); END IF;

  SELECT ba.coa_id, coa.code, ba.current_balance 
  INTO v_bank_coa, v_bank_coa_code, v_bank_before
  FROM public.bank_accounts ba
  JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
  WHERE ba.id = v_bank_account_id AND ba.is_active = true AND coa.is_active = true AND coa.is_header = false;
  
  IF v_bank_coa IS NULL THEN
    v_errors := array_append(v_errors, 'Bank account BCA IDR (' || v_bank_account_id::text || ') is inactive or has invalid COA mapping');
  ELSIF v_bank_coa_code <> '111101' THEN
    v_errors := array_append(v_errors, 'Bank account BCA IDR is mapped to COA ' || v_bank_coa_code || ', expected 111101');
  END IF;

  -- 3. Validate Bank Statement Line 15 Oct 2026 (26fb3731-977e-41d1-a21b-661a29bd7c82)
  SELECT * INTO v_bsl_15 FROM public.bank_statement_lines WHERE id = v_bank_line_id;
  IF v_bsl_15.id IS NULL THEN
    v_errors := array_append(v_errors, 'Bank statement line 15 Oct 2026 (' || v_bank_line_id::text || ') not found');
  ELSE
    IF v_bsl_15.debit_amount <> 17671854.00 THEN
      v_errors := array_append(v_errors, 'Bank statement line 15 Oct debit amount is ' || v_bsl_15.debit_amount::text || ', expected 17671854.00');
    END IF;
    IF upper(COALESCE(v_bsl_15.currency, 'IDR')) <> 'IDR' THEN
      v_errors := array_append(v_errors, 'Bank statement line 15 Oct currency is ' || v_bsl_15.currency || ', expected IDR');
    END IF;
    
    SELECT count(*), COALESCE(sum(allocation_amount), 0)
    INTO v_bsl_15_alloc_count, v_bsl_15_alloc_sum
    FROM public.bank_statement_allocations
    WHERE bank_statement_line_id = v_bank_line_id;

    SELECT * INTO v_exp_alloc
    FROM public.bank_statement_allocations
    WHERE bank_statement_line_id = v_bank_line_id AND document_type = 'expense' AND document_id = v_expense_id;

    IF v_exp_alloc.id IS NULL THEN
      v_errors := array_append(v_errors, 'Bank statement line 15 Oct lacks expected expense allocation for ' || v_expense_id::text);
    ELSIF v_exp_alloc.allocation_amount <> 16002854.00 THEN
      v_errors := array_append(v_errors, 'Expense allocation amount is ' || v_exp_alloc.allocation_amount::text || ', expected 16002854.00');
    END IF;
  END IF;

  -- 4. Validate Original Expense Journal JE2610-0196 (1a2c4c29-f93a-464c-9a9e-04b101f5b12e)
  SELECT * INTO v_exp_je FROM public.journal_entries WHERE id = v_exp_je_id;
  IF v_exp_je.id IS NULL THEN
    v_errors := array_append(v_errors, 'Expense journal JE2610-0196 (' || v_exp_je_id::text || ') not found');
  ELSE
    IF NOT v_exp_je.is_posted THEN v_errors := array_append(v_errors, 'Expense journal JE2610-0196 is not posted'); END IF;
    IF COALESCE(v_exp_je.is_reversed, false) THEN v_errors := array_append(v_errors, 'Expense journal JE2610-0196 is unexpectedly marked as reversed'); END IF;
    IF v_exp_je.total_debit <> 16002854.00 OR v_exp_je.total_credit <> 16002854.00 THEN
      v_errors := array_append(v_errors, 'Expense journal JE2610-0196 total is ' || v_exp_je.total_debit::text || ', expected 16002854.00');
    END IF;
  END IF;

  -- 5. Validate Bank Statement Line 30 Oct 2026 (b0757040-9080-455f-9ff8-6aa00e0331f7)
  SELECT * INTO v_bsl_30 FROM public.bank_statement_lines WHERE id = v_refund_line_id;
  IF v_bsl_30.id IS NULL THEN
    v_errors := array_append(v_errors, 'Refund bank statement line 30 Oct (' || v_refund_line_id::text || ') not found');
  ELSE
    IF v_bsl_30.credit_amount <> 1666000.00 THEN
      v_errors := array_append(v_errors, 'Refund bank statement credit amount is ' || v_bsl_30.credit_amount::text || ', expected 1666000.00');
    END IF;
    IF upper(COALESCE(v_bsl_30.currency, 'IDR')) <> 'IDR' THEN
      v_errors := array_append(v_errors, 'Refund bank statement line currency is ' || v_bsl_30.currency || ', expected IDR');
    END IF;
  END IF;

  -- 6. Validate Receipt Voucher RV2610-0018 (80b23e4e-ad5b-4d6d-bb60-2e8d25575e76)
  SELECT * INTO v_rv FROM public.receipt_vouchers WHERE id = v_rv_id;
  IF v_rv.id IS NULL THEN
    v_errors := array_append(v_errors, 'Receipt voucher RV2610-0018 (' || v_rv_id::text || ') not found');
  ELSE
    IF v_rv.supplier_id IS DISTINCT FROM v_supplier_id THEN
      v_errors := array_append(v_errors, 'Receipt voucher RV2610-0018 supplier_id is ' || COALESCE(v_rv.supplier_id::text, 'null') || ', expected ' || v_supplier_id::text);
    END IF;
    IF v_rv.amount <> 1666000.00 THEN
      v_errors := array_append(v_errors, 'Receipt voucher RV2610-0018 amount is ' || v_rv.amount::text || ', expected 1666000.00');
    END IF;
    IF v_rv.settlement_discount <> 3000.00 THEN
      v_errors := array_append(v_errors, 'Receipt voucher RV2610-0018 settlement_discount is ' || v_rv.settlement_discount::text || ', expected 3000.00');
    END IF;
    IF NOT v_rv.is_posted THEN
      v_errors := array_append(v_errors, 'Receipt voucher RV2610-0018 is not posted');
    END IF;
  END IF;

  -- 7. Validate Accounting Periods (open for 2026-10-15 and 2026-10-31)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounting_periods' AND column_name = 'status') THEN
    EXECUTE 'SELECT COALESCE(bool_or(status = ''open''), false) FROM public.accounting_periods WHERE ''2026-10-15''::date BETWEEN start_date AND end_date' INTO v_period_15_open;
    EXECUTE 'SELECT COALESCE(bool_or(status = ''open''), false) FROM public.accounting_periods WHERE ''2026-10-31''::date BETWEEN start_date AND end_date' INTO v_period_31_open;
  ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounting_periods' AND column_name = 'is_closed') THEN
    EXECUTE 'SELECT COALESCE(bool_or(is_closed = false), false) FROM public.accounting_periods WHERE ''2026-10-15''::date BETWEEN start_date AND end_date' INTO v_period_15_open;
    EXECUTE 'SELECT COALESCE(bool_or(is_closed = false), false) FROM public.accounting_periods WHERE ''2026-10-31''::date BETWEEN start_date AND end_date' INTO v_period_31_open;
  ELSE
    v_period_15_open := true;
    v_period_31_open := true;
  END IF;

  IF NOT v_period_15_open THEN
    v_errors := array_append(v_errors, 'Accounting period covering 2026-10-15 is closed or not found');
  END IF;
  IF NOT v_period_31_open THEN
    v_errors := array_append(v_errors, 'Accounting period covering 2026-10-31 is closed or not found');
  END IF;

  -- 8. Check Genuine Idempotency: Has the repair already been executed?
  -- Identify exact supplier advance PV using: supplier_id, amount, payment_purpose, settlement_against, and reference_number
  SELECT * INTO v_existing_pv
  FROM public.payment_vouchers
  WHERE supplier_id = v_supplier_id
    AND amount = 1669000.00
    AND payment_purpose = 'supplier_advance'
    AND settlement_against = 'advance'
    AND reference_number = '1510/FTSCY/WS95051'
    AND is_posted = true
  ORDER BY created_at DESC LIMIT 1;

  -- Check if receipt voucher is already relinked to replacement journal
  IF v_rv.id IS NOT NULL AND v_rv.journal_entry_id IS NOT NULL AND v_rv.journal_entry_id <> v_old_rv_je_id THEN
    SELECT * INTO v_existing_rep_je FROM public.journal_entries WHERE id = v_rv.journal_entry_id AND source_module = 'receipt' AND reference_id = v_rv_id;
  END IF;

  -- Check if original journal JE2610-0239 is already reversed
  SELECT * INTO v_old_je FROM public.journal_entries WHERE id = v_old_rv_je_id;
  IF v_old_je.id IS NOT NULL AND COALESCE(v_old_je.is_reversed, false) = true AND v_old_je.reversed_by_id IS NOT NULL THEN
    SELECT * INTO v_existing_rev_je FROM public.journal_entries WHERE id = v_old_je.reversed_by_id;
  END IF;

  IF v_existing_pv.id IS NOT NULL 
     AND v_existing_rep_je.id IS NOT NULL 
     AND v_existing_rev_je.id IS NOT NULL 
     AND v_old_je.is_reversed = true 
  THEN
    v_is_already_repaired := true;
  END IF;

  -- If not already repaired, original journal JE2610-0239 MUST be in active unreversed state
  IF NOT v_is_already_repaired THEN
    IF v_old_je.id IS NULL THEN
      v_errors := array_append(v_errors, 'Original receipt journal JE2610-0239 (' || v_old_rv_je_id::text || ') not found');
    ELSE
      IF NOT v_old_je.is_posted THEN v_errors := array_append(v_errors, 'Original receipt journal JE2610-0239 is not posted'); END IF;
      IF COALESCE(v_old_je.is_reversed, false) THEN v_errors := array_append(v_errors, 'Original receipt journal JE2610-0239 is already reversed but replacement is incomplete'); END IF;
      IF v_old_je.total_debit <> 1669000.00 OR v_old_je.total_credit <> 1669000.00 THEN
        v_errors := array_append(v_errors, 'Original receipt journal JE2610-0239 total is ' || v_old_je.total_debit::text || ', expected 1669000.00');
      END IF;
    END IF;
  END IF;

  -- 9. If any validation errors exist, halt and return failure
  IF array_length(v_errors, 1) > 0 THEN
    RETURN jsonb_build_object(
      'dry_run', p_dry_run,
      'status', 'VALIDATION_FAILED',
      'summary', 'Dynamic pre-condition validation failed for PT TRANS EXIS JAYA repair',
      'error_count', array_length(v_errors, 1),
      'validation_errors', to_jsonb(v_errors)
    );
  END IF;

  -- 10. Genuine Idempotency Short-Circuit: If already repaired, return current state without touching records
  IF v_is_already_repaired THEN
    RETURN jsonb_build_object(
      'dry_run', p_dry_run,
      'status', 'ALREADY_COMPLETED',
      'already_repaired', true,
      'summary', 'PT TRANS EXIS JAYA supplier advance and refund repair is already fully executed and balanced',
      'payment_voucher', jsonb_build_object('id', v_existing_pv.id, 'number', v_existing_pv.voucher_number, 'journal_id', v_existing_pv.journal_entry_id),
      'reversal_journal', jsonb_build_object('id', v_existing_rev_je.id, 'number', v_existing_rev_je.entry_number),
      'replacement_journal', jsonb_build_object('id', v_existing_rep_je.id, 'number', v_existing_rep_je.entry_number),
      'receipt_voucher', jsonb_build_object('id', v_rv.id, 'number', v_rv.voucher_number, 'adjustment_account_id', v_rv.adjustment_account_id),
      'bank_balance_current', v_bank_before
    );
  END IF;

  -- 11. Dry-Run Planning Output (Dynamic validation passed, returns execution plan)
  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'dry_run', true,
      'status', 'READY_FOR_AUTHORIZATION',
      'validation_passed', true,
      'summary', 'Dynamic pre-condition validation passed. Ready for authorized atomic execution.',
      'validated_records', jsonb_build_object(
        'supplier', jsonb_build_object('id', v_supplier_id, 'name', 'PT. TRANS EXIS JAYA'),
        'bank_statement_15oct', jsonb_build_object(
          'id', v_bank_line_id,
          'total_debit', v_bsl_15.debit_amount,
          'existing_expense_allocation', v_exp_alloc.allocation_amount,
          'unallocated_remainder', (v_bsl_15.debit_amount - v_exp_alloc.allocation_amount),
          'reconciliation_status', v_bsl_15.reconciliation_status
        ),
        'bank_statement_30oct', jsonb_build_object(
          'id', v_refund_line_id,
          'credit_amount', v_bsl_30.credit_amount,
          'reconciliation_status', v_bsl_30.reconciliation_status
        ),
        'expense_journal', jsonb_build_object('id', v_exp_je.id, 'entry_number', v_exp_je.entry_number, 'total', v_exp_je.total_debit),
        'erroneous_receipt_journal', jsonb_build_object(
          'id', v_old_je.id,
          'entry_number', v_old_je.entry_number,
          'total', v_old_je.total_debit,
          'erroneous_ap_credit', 1669000.00
        ),
        'receipt_voucher', jsonb_build_object(
          'id', v_rv.id,
          'voucher_number', v_rv.voucher_number,
          'refund_amount', v_rv.amount,
          'settlement_discount', v_rv.settlement_discount
        ),
        'coa_mapping', jsonb_build_object(
          '1170_supplier_advances', v_coa_1170,
          '111101_bank_bca_idr', v_bank_coa,
          '2110_accounts_payable', v_coa_2110,
          '6910_settlement_diff', v_coa_6910
        ),
        'accounting_periods', jsonb_build_object('period_15oct_open', v_period_15_open, 'period_31oct_open', v_period_31_open)
      ),
      'actions', jsonb_build_array(
        jsonb_build_object(
          'step', 1,
          'action', 'create_supplier_advance_payment_voucher',
          'supplier', 'PT. TRANS EXIS JAYA',
          'amount', 1669000.00,
          'voucher_date', '2026-10-15',
          'payment_purpose', 'supplier_advance',
          'settlement_against', 'advance',
          'reference_number', '1510/FTSCY/WS95051',
          'proposed_journal', jsonb_build_object(
            'Dr 1170 Supplier Advances & Deposits', 1669000.00,
            'Cr 111101 Bank BCA - IDR', 1669000.00
          )
        ),
        jsonb_build_object(
          'step', 2,
          'action', 'allocate_to_outgoing_bank_statement',
          'bank_statement_line_id', v_bank_line_id,
          'total_statement_debit', 17671854.00,
          'allocation_1_expense', 16002854.00,
          'allocation_2_advance', 1669000.00,
          'resulting_unallocated', 0.00,
          'resulting_reconciliation_status', 'matched'
        ),
        jsonb_build_object(
          'step', 3,
          'action', 'reverse_erroneous_receipt_journal',
          'original_journal_id', v_old_rv_je_id,
          'original_journal_entry', 'JE2610-0239',
          'reversal_lines', jsonb_build_object(
            'Dr 2110 Accounts Payable (reverses erroneous AP credit)', 1669000.00,
            'Cr 111101 Bank BCA - IDR', 1666000.00,
            'Cr 6910 Settlement Discount', 3000.00
          )
        ),
        jsonb_build_object(
          'step', 4,
          'action', 'create_replacement_receipt_journal',
          'receipt_voucher', 'RV2610-0018',
          'replacement_lines', jsonb_build_object(
            'Dr 111101 Bank BCA - IDR', 1666000.00,
            'Dr 6910 Settlement Discount & Rounding Difference', 3000.00,
            'Cr 1170 Supplier Advances & Deposits (clears advance asset)', 1669000.00
          )
        ),
        jsonb_build_object(
          'step', 5,
          'action', 'update_receipt_voucher_and_refund_allocation',
          'adjustment_account_id', v_coa_6910,
          'adjustment_notes', 'Approved settlement difference of 3,000 against advance refund 1,669,000',
          'relink_statement_line', v_refund_line_id
        )
      ),
      'net_balance_impact', jsonb_build_object(
        '1170_supplier_advances', 'Rp 1,669,000 Dr (PV) - Rp 1,669,000 Cr (RV) = Rp 0 Net Balance',
        '2110_accounts_payable', 'Erroneous Rp 1,669,000 credit reversed by Dr Rp 1,669,000 -> Net 0 AP change',
        '6910_settlement_difference', 'Rp 3,000 Dr preserved',
        '111101_bank_bca_idr', 'Credits full Rp 17,671,854 actual bank debit instead of Rp 16,002,854'
      )
    );
  END IF;

  -- ==============================================================================
  -- EXECUTION MODE (Only runs when p_dry_run = false and authorized)
  -- Uses strict row-level locking in hierarchical order to ensure transactional safety
  -- ==============================================================================

  -- Row-level locking
  PERFORM id FROM public.bank_accounts WHERE id = v_bank_account_id FOR UPDATE;
  PERFORM id FROM public.bank_statement_lines WHERE id = v_bank_line_id FOR UPDATE;
  PERFORM id FROM public.bank_statement_lines WHERE id = v_refund_line_id FOR UPDATE;
  PERFORM id FROM public.suppliers WHERE id = v_supplier_id FOR UPDATE;
  PERFORM id FROM public.receipt_vouchers WHERE id = v_rv_id FOR UPDATE;
  PERFORM id FROM public.journal_entries WHERE id = v_old_rv_je_id FOR UPDATE;

  -- Step 1: Create and Post Payment Voucher for Rp 1,669,000 (if not already existing)
  IF v_existing_pv.id IS NULL THEN
    v_pv_number := public.next_payment_voucher_number('2026-10-15'::date);
    INSERT INTO public.payment_vouchers (
      voucher_number,
      voucher_date,
      party_type,
      supplier_id,
      payment_method,
      bank_account_id,
      reference_number,
      amount,
      actual_bank_debit,
      payment_currency,
      exchange_rate,
      payment_purpose,
      settlement_against,
      description,
      created_by
    ) VALUES (
      v_pv_number,
      '2026-10-15',
      'supplier',
      v_supplier_id,
      'bank_transfer',
      v_bank_account_id,
      '1510/FTSCY/WS95051',
      1669000.00,
      1669000.00,
      'IDR',
      1,
      'supplier_advance',
      'advance',
      'Supplier advance from bank payment remainder: 1510/FTSCY/WS95051',
      v_actor
    ) RETURNING id INTO v_pv_id;

    PERFORM public.post_payment_voucher(v_pv_id, v_actor);
  ELSE
    v_pv_id := v_existing_pv.id;
    v_pv_number := v_existing_pv.voucher_number;
  END IF;

  SELECT journal_entry_id INTO v_pv_je_id FROM public.payment_vouchers WHERE id = v_pv_id;
  SELECT entry_number INTO v_pv_je_number FROM public.journal_entries WHERE id = v_pv_je_id;

  -- Step 2: Allocate 2nd document on bank statement line 26fb3731-977e-41d1-a21b-661a29bd7c82
  SELECT id INTO v_pv_alloc_id FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = v_bank_line_id AND document_type = 'payment' AND document_id = v_pv_id LIMIT 1;
  IF v_pv_alloc_id IS NULL THEN
    v_pv_alloc_id := gen_random_uuid();
    INSERT INTO public.bank_statement_allocations (
      id, bank_statement_line_id, document_type, document_id, journal_entry_id,
      allocation_amount, payment_kind, created_by
    ) VALUES (
      v_pv_alloc_id, v_bank_line_id, 'payment', v_pv_id, v_pv_je_id,
      1669000.00, 'supplier', v_actor
    );
  END IF;

  PERFORM public.sync_bank_line_allocation_owner(v_bank_line_id);
  PERFORM public.refresh_bank_statement_allocation_status(v_bank_line_id);

  -- Step 3: Reverse Erroneous Receipt Journal JE2610-0239
  v_rev_je_number := public.next_journal_entry_number();
  INSERT INTO public.journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, is_reversed,
    posted_by, created_by, transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_rev_je_number, '2026-10-31', 'receipt_reversal', v_rv_id, 'REV-JE2610-0239',
    'Reversal of JE2610-0239 (Receipt Voucher RV2610-0018 AP correction)',
    1669000.00, 1669000.00, true, true,
    v_actor, v_actor, 'IDR', 'IDR', 1
  ) RETURNING id INTO v_rev_je_id;

  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit,
    customer_id, supplier_id, transaction_currency, transaction_debit, transaction_credit, exchange_rate
  ) VALUES
    (v_rev_je_id, 1, v_bank_coa, 'REVERSAL: Bank BCA - IDR', 0, 1666000.00, null, v_supplier_id, 'IDR', 0, 1666000.00, 1),
    (v_rev_je_id, 2, v_coa_6910, 'REVERSAL: Settlement Difference', 0, 3000.00, null, v_supplier_id, 'IDR', 0, 3000.00, 1),
    (v_rev_je_id, 3, v_coa_2110, 'REVERSAL: Accounts Payable', 1669000.00, 0, null, v_supplier_id, 'IDR', 1669000.00, 0, 1);

  UPDATE public.journal_entries
     SET is_reversed = true, reversed_by_id = v_rev_je_id
   WHERE id = v_old_rv_je_id;

  -- Step 4: Create Replacement Receipt Journal Linked to GL 1170
  v_rep_je_number := public.next_journal_entry_number();
  INSERT INTO public.journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted,
    posted_by, created_by, transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_rep_je_number, '2026-10-31', 'receipt', v_rv_id, 'RV2610-0018',
    'Receipt Voucher (supplier): RV2610-0018 (Advance Refund)',
    1669000.00, 1669000.00, true,
    v_actor, v_actor, 'IDR', 'IDR', 1
  ) RETURNING id INTO v_rep_je_id;

  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit,
    customer_id, supplier_id, transaction_currency, transaction_debit, transaction_credit, exchange_rate
  ) VALUES
    (v_rep_je_id, 1, v_bank_coa, 'Receipt: RV2610-0018', 1666000.00, 0, null, v_supplier_id, 'IDR', 1666000.00, 0, 1),
    (v_rep_je_id, 2, v_coa_6910, 'Settlement Difference: RV2610-0018', 3000.00, 0, null, v_supplier_id, 'IDR', 3000.00, 0, 1),
    (v_rep_je_id, 3, v_coa_1170, 'Supplier Advance Refund - RV2610-0018', 0, 1669000.00, null, v_supplier_id, 'IDR', 0, 1669000.00, 1);

  -- Step 5: Update Receipt Voucher & Relink Bank Allocation
  UPDATE public.receipt_vouchers
     SET journal_entry_id = v_rep_je_id,
         adjustment_account_id = v_coa_6910,
         adjustment_notes = 'Approved settlement difference of 3,000 against advance refund 1,669,000'
   WHERE id = v_rv_id;

  UPDATE public.bank_statement_allocations
     SET journal_entry_id = v_rep_je_id
   WHERE document_type = 'receipt' AND document_id = v_rv_id;

  -- Re-sync bank account balance
  PERFORM public.sync_bank_account_balance(v_bank_account_id);
  SELECT current_balance INTO v_bank_after FROM public.bank_accounts WHERE id = v_bank_account_id;

  RETURN jsonb_build_object(
    'success', true,
    'dry_run', false,
    'payment_voucher', jsonb_build_object('id', v_pv_id, 'number', v_pv_number, 'journal', v_pv_je_number),
    'reversal_journal', jsonb_build_object('id', v_rev_je_id, 'number', v_rev_je_number),
    'replacement_journal', jsonb_build_object('id', v_rep_je_id, 'number', v_rep_je_number),
    'bank_balance_before', v_bank_before,
    'bank_balance_after', v_bank_after
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.repair_trans_exis_jaya_supplier_advance(boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repair_trans_exis_jaya_supplier_advance(boolean, uuid) TO authenticated, service_role;
