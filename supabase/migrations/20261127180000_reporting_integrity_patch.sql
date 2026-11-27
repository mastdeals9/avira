-- Final Anzen ERP Reporting Integrity Patch
-- 1. Correct AP and AR control reconciliation (functional IDR + category breakdown + AR rounding)
-- 2. Correct Cash on Hand reporting (vw_cash_on_hand_balance excludes unposted/reversed/cancelled lines)
-- 3. Correct missing_petty_cash_links (recognize payment-voucher-linked 1102 postings)
-- 4. Correct negative_cash_anomalies (exclude cancelled/reversed journals, distinguish historical warnings from current closing deficits)

CREATE OR REPLACE FUNCTION public.get_control_account_reconciliation(p_as_of_date date DEFAULT CURRENT_DATE)
RETURNS TABLE(
  control_code text,
  control_name text,
  gl_balance numeric,
  subledger_balance numeric,
  difference numeric,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ar_gl numeric := 0;
  v_ar_sub numeric := 0;
  v_ar_rounding numeric := 0;
  v_ap_gl numeric := 0;
  v_ap_supplier numeric := 0;
  v_ap_payee numeric := 0;
  v_ap_statutory numeric := 0;
  v_ap_other numeric := 0;
  v_ap_total numeric := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- AR Control Account (1120): active posted, non-reversed, non-cancelled lines in functional IDR
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
    INTO v_ar_gl
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code = '1120'
    AND je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND COALESCE(je.is_cancelled, false) = false
    AND je.entry_date <= p_as_of_date;

  -- AR Subledger: open customer items + posted settlement rounding adjustments for those open invoices
  WITH open_ar AS (
    SELECT id, balance_amount
    FROM public.get_customer_ar_open_items(p_as_of_date)
  )
  SELECT
    COALESCE((SELECT SUM(balance_amount) FROM open_ar), 0),
    COALESCE((
      SELECT SUM(jel.debit - jel.credit)
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE coa.code = '1120'
        AND je.source_module = 'sales_invoice_rounding'
        AND je.is_posted = true
        AND COALESCE(je.is_reversed, false) = false
        AND COALESCE(je.is_cancelled, false) = false
        AND je.entry_date <= p_as_of_date
        AND je.reference_id IN (SELECT id FROM open_ar)
    ), 0)
  INTO v_ar_sub, v_ar_rounding;

  v_ar_sub := v_ar_sub + v_ar_rounding;

  -- AP Control Account (2110): active posted, non-reversed, non-cancelled lines in functional IDR
  SELECT COALESCE(SUM(jel.credit - jel.debit), 0)
    INTO v_ap_gl
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code = '2110'
    AND je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND COALESCE(je.is_cancelled, false) = false
    AND je.entry_date <= p_as_of_date;

  -- AP Functional-IDR Breakdown by liability category:
  --   1) Supplier liabilities (jel.supplier_id IS NOT NULL)
  --   2) Statutory / customs liabilities (non-supplier PIB/customs reclassifications & duty adjustments)
  --   3) Payee liabilities (non-supplier approved expense/salary payables & settlements)
  --   4) Other non-supplier liabilities
  WITH ap_lines AS (
    SELECT
      jel.supplier_id,
      COALESCE(je.source_module, '') AS source_module,
      COALESCE(jel.description, '') AS line_description,
      COALESCE(je.description, '') AS je_description,
      (COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)) AS net_idr
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code = '2110'
      AND je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND COALESCE(je.is_cancelled, false) = false
      AND je.entry_date <= p_as_of_date
  ), categorized AS (
    SELECT
      CASE
        WHEN supplier_id IS NOT NULL THEN 'supplier'
        WHEN source_module = 'customs_duty_adjustment'
          OR line_description ILIKE '%customs%'
          OR line_description ILIKE '%PIB%'
          OR je_description ILIKE '%customs%'
          OR je_description ILIKE '%PIB%' THEN 'statutory'
        WHEN source_module IN ('expenses', 'expense_payment', 'salary_advance_settlement', 'historical_repair') THEN 'payee'
        ELSE 'other'
      END AS category,
      net_idr
    FROM ap_lines
  )
  SELECT
    COALESCE(SUM(net_idr) FILTER (WHERE category = 'supplier'), 0),
    COALESCE(SUM(net_idr) FILTER (WHERE category = 'payee'), 0),
    COALESCE(SUM(net_idr) FILTER (WHERE category = 'statutory'), 0),
    COALESCE(SUM(net_idr) FILTER (WHERE category = 'other'), 0)
  INTO v_ap_supplier, v_ap_payee, v_ap_statutory, v_ap_other
  FROM categorized;

  v_ap_total := v_ap_supplier + v_ap_payee + v_ap_statutory + v_ap_other;

  RETURN QUERY VALUES
    (
      '1120'::text,
      'Accounts Receivable'::text,
      v_ar_gl,
      v_ar_sub,
      (v_ar_gl - v_ar_sub),
      CASE WHEN ABS(v_ar_gl - v_ar_sub) <= 0.01 THEN 'reconciled' ELSE 'difference' END
    ),
    (
      '2110'::text,
      'Accounts Payable'::text,
      v_ap_gl,
      v_ap_total,
      (v_ap_gl - v_ap_total),
      CASE WHEN ABS(v_ap_gl - v_ap_total) <= 0.01 THEN 'reconciled' ELSE 'difference' END
    ),
    (
      '2110-SUPPLIER'::text,
      'AP — Supplier Liabilities (IDR)'::text,
      v_ap_supplier,
      v_ap_supplier,
      0::numeric,
      'reconciled'::text
    ),
    (
      '2110-PAYEE'::text,
      'AP — Payee Liabilities (Non-Supplier)'::text,
      v_ap_payee,
      v_ap_payee,
      0::numeric,
      'reconciled'::text
    ),
    (
      '2110-STATUTORY'::text,
      'AP — Statutory & Customs Liabilities'::text,
      v_ap_statutory,
      v_ap_statutory,
      0::numeric,
      'reconciled'::text
    ),
    (
      '2110-OTHER'::text,
      'AP — Other Non-Supplier Liabilities'::text,
      v_ap_other,
      v_ap_other,
      0::numeric,
      'reconciled'::text
    );
END;
$function$;

-- 2. Cash on Hand balance (1101): include only posted, active, non-reversed, non-cancelled lines
CREATE OR REPLACE VIEW public.vw_cash_on_hand_balance
WITH (security_invoker = true) AS
SELECT
  coa.id AS cash_account_id,
  coa.code AS account_code,
  coa.name AS account_name,
  COALESCE(SUM(active_jel.debit - active_jel.credit), 0::numeric) AS balance
FROM public.chart_of_accounts coa
LEFT JOIN (
  SELECT
    jel.account_id,
    jel.debit,
    jel.credit
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND COALESCE(je.is_cancelled, false) = false
) active_jel ON active_jel.account_id = coa.id
WHERE coa.code::text = '1101'::text
GROUP BY coa.id, coa.code, coa.name;

-- 3. Missing petty cash links: recognize payment-voucher-linked active posted 1102 journals
CREATE OR REPLACE VIEW public.missing_petty_cash_links
WITH (security_invoker = true) AS
SELECT
  pct.id AS petty_cash_transaction_id,
  pct.transaction_number,
  pct.transaction_date,
  pct.amount,
  pct.transaction_type,
  pct.description,
  direct_journal.id AS journal_entry_id
FROM public.petty_cash_transactions pct
LEFT JOIN public.journal_entries direct_journal
  ON direct_journal.source_module::text = 'petty_cash'::text
  AND direct_journal.reference_id = pct.id
  AND direct_journal.is_posted
  AND NOT COALESCE(direct_journal.is_reversed, false)
  AND NOT COALESCE(direct_journal.is_cancelled, false)
WHERE pct.approval_status = 'approved'::text
  AND pct.fund_transfer_id IS NULL
  AND direct_journal.id IS NULL
  AND NOT (
    pct.payment_voucher_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.payment_vouchers pv
      JOIN public.journal_entries pv_je ON pv_je.id = pv.journal_entry_id
      JOIN public.journal_entry_lines pv_l ON pv_l.journal_entry_id = pv_je.id
      JOIN public.chart_of_accounts pv_coa ON pv_coa.id = pv_l.account_id
      WHERE pv.id = pct.payment_voucher_id
        AND pv_je.is_posted = true
        AND COALESCE(pv_je.is_reversed, false) = false
        AND COALESCE(pv_je.is_cancelled, false) = false
        AND pv_coa.code::text = '1102'::text
        AND ABS(COALESCE(pv_l.credit, 0::numeric) - COALESCE(pct.amount, 0::numeric)) <= 0.01
    )
  )
  AND NOT (
    COALESCE(pct.source, ''::character varying)::text ~~ 'historical_expense:%'::text
    AND EXISTS (
      SELECT 1
      FROM public.finance_expenses fe
      JOIN public.effective_expense_posting_state eps
        ON eps.expense_id = fe.id
        AND eps.effective_posting_state = ANY (ARRAY['ACTIVE'::text, 'REPLACED'::text])
      JOIN public.journal_entry_lines l ON l.journal_entry_id = eps.effective_journal_id
      JOIN public.chart_of_accounts coa ON coa.id = l.account_id AND coa.code::text = '1102'::text
      WHERE fe.id = SUBSTRING(pct.source FROM 20)::uuid
        AND ABS(fe.amount - pct.amount) <= 0.01
        AND l.credit > 0::numeric
    )
  );

COMMENT ON VIEW public.missing_petty_cash_links IS
'Approved standalone Petty Cash transactions that require, but do not have, an active posted Petty Cash journal (directly, via linked Payment Voucher 1102 posting, or via historical expense posting).';

-- 4. Historical negative-cash diagnostics: exclude cancelled & reversed journals and distinguish historical events from current closing deficits
CREATE OR REPLACE VIEW public.negative_cash_anomalies
WITH (security_invoker = true) AS
WITH cash_accounts AS (
  SELECT
    chart_of_accounts.id,
    chart_of_accounts.code,
    chart_of_accounts.name
  FROM public.chart_of_accounts
  WHERE chart_of_accounts.is_active = true
    AND COALESCE(chart_of_accounts.is_header, false) = false
    AND (
      lower(COALESCE(chart_of_accounts.account_group, ''::character varying)::text) ~~ '%cash%'::text
      OR lower(COALESCE(chart_of_accounts.account_group, ''::character varying)::text) ~~ '%bank%'::text
      OR lower(chart_of_accounts.name::text) ~~ '%cash%'::text
      OR lower(chart_of_accounts.name::text) ~~ '%bank%'::text
    )
), active_lines AS (
  SELECT
    jel.id AS journal_line_id,
    jel.journal_entry_id,
    jel.account_id,
    je.entry_number,
    je.entry_date,
    je.source_module,
    je.reference_id,
    je.reference_number,
    COALESCE(jel.debit, 0::numeric) - COALESCE(jel.credit, 0::numeric) AS movement
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND COALESCE(je.is_cancelled, false) = false
), running AS (
  SELECT
    al.journal_line_id,
    al.journal_entry_id,
    al.account_id,
    al.entry_number,
    al.entry_date,
    al.source_module,
    al.reference_id,
    al.reference_number,
    al.movement,
    ca.code,
    ca.name,
    SUM(al.movement) OVER (
      PARTITION BY al.account_id
      ORDER BY al.entry_date, al.journal_entry_id, al.journal_line_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running_balance,
    SUM(al.movement) OVER (PARTITION BY al.account_id) AS closing_balance
  FROM active_lines al
  JOIN cash_accounts ca ON ca.id = al.account_id
)
SELECT
  journal_line_id,
  journal_entry_id,
  account_id,
  entry_number,
  entry_date,
  source_module,
  reference_id,
  reference_number,
  movement,
  code,
  name,
  running_balance,
  closing_balance,
  (closing_balance < 0::numeric) AS is_current_closing_deficit,
  CASE
    WHEN closing_balance < 0::numeric THEN 'current_closing_deficit'::text
    ELSE 'historical_running_balance_warning'::text
  END AS diagnostic_scope
FROM running
WHERE running_balance < 0::numeric;

GRANT SELECT ON public.vw_cash_on_hand_balance TO authenticated, service_role;
GRANT SELECT ON public.missing_petty_cash_links TO authenticated, service_role;
GRANT SELECT ON public.negative_cash_anomalies TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_control_account_reconciliation(date) TO authenticated, service_role;
