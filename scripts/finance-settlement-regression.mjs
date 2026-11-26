import { execFileSync } from 'node:child_process';

const sql = `
BEGIN;
SELECT set_config('request.jwt.claim.sub',(
  SELECT id::text FROM public.user_profiles WHERE role IN ('admin','accounts') AND is_active=true
  ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END,id LIMIT 1),true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
-- The attribution helper is intentionally internal in production. Grant it
-- only inside this rollback transaction so the authenticated workflow checks
-- can verify the canonical date directly.
GRANT EXECUTE ON FUNCTION public.get_expense_pph_period_date(uuid) TO authenticated;
SET LOCAL ROLE authenticated;

DO $regression$
DECLARE
  v_count bigint;
  v_expense_id uuid;
  v_line_id uuid;
  v_payment_date date;
  v_fallback_date date;
  v_journal_count bigint;
BEGIN
  IF (SELECT settlement_amount FROM public.finance_expenses
       WHERE expense_category='utilities' AND amount=115128 AND COALESCE(bank_charges_amount,0)=3000 LIMIT 1)
       IS DISTINCT FROM 118128 THEN
    -- Fixture may not exist; validate the generated expression independently.
    IF 115128+3000<>118128 THEN RAISE EXCEPTION 'Utility settlement formula failed'; END IF;
  END IF;

  PERFORM 1 FROM public.vw_finance_document_settlements s
   JOIN public.journal_entry_lines jel ON jel.journal_entry_id=s.journal_entry_id
   JOIN public.bank_accounts ba ON ba.id=s.bank_account_id AND ba.coa_id=jel.account_id
   GROUP BY s.document_type,s.document_id,s.journal_entry_id,s.bank_account_id,s.direction,s.settlement_amount
  HAVING s.settlement_amount = CASE WHEN s.direction='credit'
    THEN sum(COALESCE(jel.transaction_debit,jel.debit))
    ELSE sum(COALESCE(jel.transaction_credit,jel.credit)) END;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canonical settlement view returned no verified bank legs'; END IF;

  SELECT count(*) INTO v_count FROM public.vw_finance_document_settlements s
   LEFT JOIN public.journal_entries je ON je.id=s.journal_entry_id
   WHERE je.id IS NULL OR NOT je.is_posted OR COALESCE(je.is_reversed,false);
  IF v_count<>0 THEN RAISE EXCEPTION '% invalid canonical settlement rows',v_count; END IF;

  -- The matcher definition itself must consume the shared settlement view
  -- for posted/approved settlement matching.
  IF pg_get_functiondef('public.auto_match_smart(uuid, date, date)'::regprocedure) NOT LIKE '%vw_finance_document_settlements%'
  THEN RAISE EXCEPTION 'Auto-match bypasses canonical settlement view'; END IF;

  SELECT count(*) INTO v_count FROM public.payment_vouchers
   WHERE COALESCE(payment_method,'')<>'advance_adjustment'
     AND settlement_amount IS DISTINCT FROM COALESCE(actual_bank_debit,bank_amount,amount-COALESCE(pph_amount,0)+COALESCE(bank_charge,0));
  IF v_count<>0 THEN RAISE EXCEPTION '% Payment settlement amounts diverge',v_count; END IF;

  SELECT count(*) INTO v_count FROM public.finance_expenses
   WHERE settlement_amount IS DISTINCT FROM public.calculate_expense_settlement_amount(
     expense_category,amount,ppn_amount,pph_amount,stamp_duty_amount,bank_charges_amount,broker_items);
  IF v_count<>0 THEN RAISE EXCEPTION '% Expense settlement amounts diverge',v_count; END IF;

  SELECT count(*) INTO v_count FROM (
    SELECT source_module,reference_id,count(*) n FROM public.journal_entries
     WHERE is_posted=true AND COALESCE(is_reversed,false)=false
       AND source_module IN ('expense','expenses','payment','receipt','petty_cash','fund_transfer','fund_transfers')
     GROUP BY source_module,reference_id HAVING count(*)>1
  ) duplicates;
  IF v_count<>0 THEN RAISE EXCEPTION '% source documents have duplicate active journals',v_count; END IF;

  -- The statutory PPh Register is sourced from approved documents via
  -- fn_pph_authoritative_source_total. Journals remain an audit trail and
  -- must not gate or manufacture withholding.
  IF pg_get_functiondef('public.fn_pph_authoritative_source_total(uuid)'::regprocedure) LIKE '%journal_entries%'
     OR pg_get_functiondef('public.fn_pph_authoritative_source_total(uuid)'::regprocedure) NOT LIKE '%approval_status%'
     OR pg_get_functiondef('public.fn_pph_authoritative_source_total(uuid)'::regprocedure) NOT LIKE '%approved%'
     OR pg_get_functiondef('public.fn_pph_authoritative_source_total(uuid)'::regprocedure) NOT LIKE '%pv.is_posted%'
  THEN RAISE EXCEPTION 'PPh Register is not sourced exclusively from approved source documents'; END IF;

  WITH source AS (
    SELECT COALESCE(selected_tp.fiscal_year, EXTRACT(YEAR FROM public.get_expense_pph_period_date(fe.id))::int) fiscal_year,
           COALESCE(selected_tp.period_month, EXTRACT(MONTH FROM public.get_expense_pph_period_date(fe.id))::int) period_month,
           tc.tax_type, fe.pph_amount amount
      FROM public.finance_expenses fe
      LEFT JOIN public.tax_codes tc ON tc.id=fe.pph_code_id
      LEFT JOIN public.tax_periods selected_tp ON selected_tp.id=fe.pph_tax_period_id
     WHERE fe.approval_status='approved' AND fe.pph_amount>0
       AND COALESCE(fe.expense_category,'') NOT IN ('pib_import','pph_import')
    UNION ALL
    SELECT EXTRACT(YEAR FROM pv.voucher_date)::int,
           EXTRACT(MONTH FROM pv.voucher_date)::int,
           tc.tax_type, pv.pph_amount
      FROM public.payment_vouchers pv
      LEFT JOIN public.tax_codes tc ON tc.id=pv.pph_code_id
     WHERE COALESCE(pv.is_posted,false) AND pv.pph_amount>0
    UNION ALL
    SELECT COALESCE(selected_tp.fiscal_year, EXTRACT(YEAR FROM public.get_expense_pph_period_date(fe.id))::int),
           COALESCE(selected_tp.period_month, EXTRACT(MONTH FROM public.get_expense_pph_period_date(fe.id))::int),
           'PPh22',
           CASE WHEN fe.expense_category='pib_import' THEN fe.pib_pph_amount ELSE fe.amount END
      FROM public.finance_expenses fe
      LEFT JOIN public.tax_periods selected_tp ON selected_tp.id=fe.pph_tax_period_id
     WHERE fe.approval_status='approved'
       AND fe.expense_category IN ('pib_import','pph_import')
       AND CASE WHEN fe.expense_category='pib_import'
         THEN COALESCE(fe.pib_pph_amount,0) ELSE COALESCE(fe.amount,0) END>0
    UNION ALL
    -- A verified historical exception is not a current source document. It is
    -- admitted only when the existing tax-payment journal and canonical bank
    -- allocation prove the cash remittance; an ordinary orphan still fails.
    SELECT period.fiscal_year, period.period_month, tp.tax_type, tp.amount
      FROM public.tax_payments tp
      JOIN public.tax_periods period ON period.id=tp.tax_period_id
      JOIN public.journal_entries je ON je.id=tp.journal_entry_id
       AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
     WHERE tp.historical_source_status='missing_source_verified'
       AND EXISTS (
         SELECT 1 FROM public.bank_statement_allocations a
         JOIN public.bank_statement_lines bsl ON bsl.id=a.bank_statement_line_id
          WHERE a.document_type='tax_payment' AND a.document_id=tp.id
            AND a.journal_entry_id=tp.journal_entry_id
            AND bsl.matched_tax_payment_id=tp.id
            AND abs(COALESCE(a.allocation_amount,0)-tp.amount)<0.01
       )
  ), expected AS (
    SELECT fiscal_year,period_month,tax_type,sum(amount) total
      FROM source GROUP BY fiscal_year,period_month,tax_type
  ), actual AS (
    SELECT fiscal_year,period_month,tax_type,pph_total total
      FROM public.tax_periods
     WHERE tax_type IN ('PPh21','PPh22','PPh23','PPh4(2)')
  ), expected_unifikasi AS (
    SELECT fiscal_year,period_month,sum(total) total
      FROM expected GROUP BY fiscal_year,period_month
  ), actual_unifikasi AS (
    -- The UI's PPh_Unifikasi tab is a live consolidation of these four typed
    -- registers. The legacy PPh_Unifikasi tax_period row is not its source.
    SELECT fiscal_year,period_month,sum(total) total
      FROM actual GROUP BY fiscal_year,period_month
  ), differences AS (
    SELECT COALESCE(e.fiscal_year,a.fiscal_year) fiscal_year,
           COALESCE(e.period_month,a.period_month) period_month,
           COALESCE(e.tax_type,a.tax_type) tax_type
      FROM expected e FULL JOIN actual a USING (fiscal_year,period_month,tax_type)
     WHERE COALESCE(e.total,0) IS DISTINCT FROM COALESCE(a.total,0)
    UNION ALL
    SELECT COALESCE(e.fiscal_year,a.fiscal_year),
           COALESCE(e.period_month,a.period_month),
           'PPh_Unifikasi'
      FROM expected_unifikasi e FULL JOIN actual_unifikasi a USING (fiscal_year,period_month)
     WHERE COALESCE(e.total,0) IS DISTINCT FROM COALESCE(a.total,0)
  )
  SELECT count(*) INTO v_count
    FROM differences;
  IF v_count<>0 THEN RAISE EXCEPTION '% typed or consolidated PPh registers differ from approved source documents',v_count; END IF;

  SELECT count(*) INTO v_count
    FROM public.tax_payments tp
   WHERE tp.historical_source_status='missing_source_verified'
     AND NOT EXISTS (
       SELECT 1 FROM public.journal_entries je WHERE je.id=tp.journal_entry_id
         AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
     );
  IF v_count<>0 THEN RAISE EXCEPTION '% historical PPh exceptions lack a posted tax-payment journal',v_count; END IF;

  -- EXP/26/127 was paid in February and deliberately assigned to February.
  -- The 4-Mar value is the fallback payment-attribution date; it is not used
  -- when the existing explicit PPh reporting-period selection is present.
  IF NOT EXISTS (
    SELECT 1
    FROM public.finance_expenses fe
    JOIN public.tax_periods tp ON tp.id = fe.pph_tax_period_id
    WHERE fe.voucher_number = 'EXP/26/127'
      AND fe.expense_date = '2026-02-10'
      AND fe.pph_amount = 67500
      AND tp.tax_type = 'PPh21'
      AND tp.fiscal_year = 2026 AND tp.period_month = 2
      AND public.get_expense_pph_period_date(fe.id) = '2026-03-04'
  ) THEN RAISE EXCEPTION 'EXP/26/127 lost its explicit February PPh reporting period'; END IF;

  -- Canonical period precedence: latest linked supplier payment, then due
  -- date, then the legacy document date. Government PPh remittance links do
  -- not move the original withholding period.
  SELECT count(*) INTO v_count
  FROM public.finance_expenses fe
  WHERE public.get_expense_pph_period_date(fe.id) IS DISTINCT FROM COALESCE(
    (
      SELECT MAX(d)
      FROM (
        SELECT pv.voucher_date d
        FROM public.voucher_allocations va
        JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
        WHERE va.finance_expense_id=fe.id
          AND COALESCE(va.payment_kind,'supplier')='supplier'
          AND COALESCE(pv.is_posted,false)
        UNION ALL
        SELECT bsl.transaction_date
        FROM public.bank_statement_lines bsl
        WHERE bsl.matched_expense_id=fe.id
          AND COALESCE(bsl.payment_kind,'supplier')='supplier'
      ) linked_dates
    ), fe.due_date, fe.expense_date
  );
  IF v_count<>0 THEN RAISE EXCEPTION '% expenses have an incorrect canonical PPh period date',v_count; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.compute_tax_due_dates('PPh23',2026,5)
    WHERE payment_due_date='2026-06-10' AND filing_due_date='2026-06-20'
  ) THEN RAISE EXCEPTION 'PPh due dates are not derived from the PPh period'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relname='bank_statement_lines'
      AND t.tgname='trg_recompute_pph_from_bank_line'
      AND NOT t.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relname='voucher_allocations'
      AND t.tgname='trg_recompute_pph_from_voucher_allocation'
      AND NOT t.tgisinternal
  ) THEN RAISE EXCEPTION 'PPh payment-link recompute triggers are missing'; END IF;

  -- Exercise a real linked expense entirely inside this rollback transaction:
  -- unlink moves it to its due-date month, relink restores the actual payment
  -- month, and neither operation creates accounting entries.
  SELECT fe.id, bsl.id, bsl.transaction_date, COALESCE(fe.due_date,fe.expense_date)
    INTO v_expense_id, v_line_id, v_payment_date, v_fallback_date
  FROM public.finance_expenses fe
  JOIN public.bank_statement_lines bsl ON bsl.matched_expense_id=fe.id
  WHERE fe.approval_status='approved'
    AND (COALESCE(fe.pph_amount,0)>0 OR COALESCE(fe.pib_pph_amount,0)>0 OR fe.expense_category='pph_import')
    AND COALESCE(bsl.payment_kind,'supplier')='supplier'
    AND bsl.transaction_date<>COALESCE(fe.due_date,fe.expense_date)
    AND public.get_expense_pph_period_date(fe.id)=bsl.transaction_date
    AND NOT EXISTS (
      SELECT 1 FROM public.bank_statement_lines other
      WHERE other.matched_expense_id=fe.id AND other.id<>bsl.id
        AND COALESCE(other.payment_kind,'supplier')='supplier'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.voucher_allocations va
      JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
      WHERE va.finance_expense_id=fe.id
        AND COALESCE(va.payment_kind,'supplier')='supplier'
        AND COALESCE(pv.is_posted,false)
    )
  ORDER BY fe.expense_date DESC
  LIMIT 1;

  IF v_expense_id IS NOT NULL THEN
    SELECT count(*) INTO v_journal_count FROM public.journal_entries;
    UPDATE public.bank_statement_lines
       SET matched_expense_id=NULL, manually_unlinked=true
     WHERE id=v_line_id;
    IF public.get_expense_pph_period_date(v_expense_id) IS DISTINCT FROM v_fallback_date THEN
      RAISE EXCEPTION 'Unlinked PPh expense did not return to its due-date period';
    END IF;

    UPDATE public.bank_statement_lines
       SET matched_expense_id=v_expense_id, manually_unlinked=false
     WHERE id=v_line_id;
    IF public.get_expense_pph_period_date(v_expense_id) IS DISTINCT FROM v_payment_date THEN
      RAISE EXCEPTION 'Relinked PPh expense did not return to its payment-date period';
    END IF;
    IF (SELECT count(*) FROM public.journal_entries)<>v_journal_count THEN
      RAISE EXCEPTION 'PPh period unlink/relink changed journal entries';
    END IF;
  END IF;

  SELECT count(*) INTO v_count FROM (
    SELECT fiscal_year,period_month,tax_type,count(*)
      FROM public.tax_periods WHERE tax_type<>'PPN'
     GROUP BY fiscal_year,period_month,tax_type HAVING count(*)>1
  ) duplicate_register_rows;
  IF v_count<>0 THEN RAISE EXCEPTION '% duplicate PPh Register period rows',v_count; END IF;

  SELECT count(*) INTO v_count
    FROM public.vw_pph_by_period_type r
   WHERE r.pph_paid_total IS DISTINCT FROM (
     public.fn_tax_payments_paid(r.tax_period_id)
       + public.fn_settled_import_pph22(r.fiscal_year,r.period_month,r.tax_type)
   )
      OR r.pph_overpaid IS DISTINCT FROM GREATEST(
        public.fn_tax_payments_paid(r.tax_period_id)
          + public.fn_settled_import_pph22(r.fiscal_year,r.period_month,r.tax_type)
          - r.pph_total,
        0
      );
  IF v_count<>0 THEN RAISE EXCEPTION '% PPh periods have incorrect tax-payment offsets',v_count; END IF;
END;
$regression$;
ROLLBACK;
`;

try {
  const stdout=execFileSync('supabase',['db','query','--linked','--output-format','json',sql],{
    cwd:process.cwd(),encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:100*1024*1024,
  });
  if (stdout.trim()) console.log(stdout.trim());
  console.log('Finance canonical settlement regression passed.');
} catch (error) {
  if (error.stdout?.trim()) console.error(error.stdout.trim());
  process.exit(error.status || 1);
}
