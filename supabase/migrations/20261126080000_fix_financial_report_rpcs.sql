-- ============================================================================
-- Migration: 20261126080000_fix_financial_report_rpcs.sql
-- Purpose:
--   1. Create canonical public.get_pnl_classification() so P&L summary,
--      P&L detailed, Trial Balance, and UI/PDF/Excel agree on every account
--      (including New Warehouse - Bizpark and NULL account_group accounts).
--   2. Fix get_balance_sheet() to:
--      a) Exclude cancelled journals (NOT COALESCE(je.is_cancelled, false))
--         matching get_trial_balance().
--      b) Include contra-revenue accounts (e.g. 4300 Sales Returns) in P&L
--         earnings calculation without needing a frontend plug.
--      c) Separate prior-year unclosed earnings (< Jan 1 of p_as_of_date year)
--         into 3200 Retained Earnings and YTD earnings into 3300 Current Year
--         Earnings.
--   3. Fix get_pnl_summary_detailed() and get_pnl_summary() to exclude
--      cancelled journals and use public.get_pnl_classification().
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_pnl_classification(
  p_code text,
  p_name text,
  p_account_type text,
  p_account_group text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
    WHEN p_account_type = 'revenue' AND p_code IN ('4100', '4110', '4120')
      THEN 'gross_sales'
    WHEN p_code = '4200'
      THEN 'sales_discounts'
    WHEN p_code = '4300'
      THEN 'sales_returns'
    WHEN p_account_type = 'contra' AND p_account_group = 'Revenue'
      THEN 'sales_returns'
    WHEN p_code = '4930' OR lower(COALESCE(p_name, '')) LIKE '%foreign exchange gain%'
      THEN 'fx_gain'
    WHEN p_account_type = 'revenue'
      THEN 'other_income'
    WHEN p_account_type = 'expense' AND (
      p_account_group = 'COGS'
      OR p_code IN ('5100', '5105', '5190', '5200', '5300', '5400', '5410')
    )
      THEN 'cogs'
    WHEN p_code = '7100'
      THEN 'bank_charges'
    WHEN p_code = '7300' OR lower(COALESCE(p_name, '')) LIKE '%foreign exchange loss%'
      THEN 'fx_loss'
    WHEN p_account_type = 'expense' AND p_account_group = 'Other Expenses'
      THEN 'other_expenses'
    WHEN p_account_type = 'expense'
      THEN 'operating_expenses'
    ELSE 'other'
  END;
$$;

CREATE OR REPLACE FUNCTION public.get_balance_sheet(p_as_of_date date, p_usd_rate numeric DEFAULT 1)
RETURNS TABLE(
  code character varying,
  name character varying,
  name_id character varying,
  account_type character varying,
  account_group character varying,
  normal_balance character varying,
  total_debit numeric,
  total_credit numeric,
  balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_year_start date := date_trunc('year', p_as_of_date)::date;
  v_prior_net_income numeric := 0;
  v_ytd_net_income numeric := 0;
  v_has_3300 boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Prior-year unclosed earnings (< Jan 1 of p_as_of_date's year)
  SELECT COALESCE(SUM(
    CASE
      WHEN coa.account_type = 'revenue' THEN jel.credit - jel.debit
      WHEN coa.account_type = 'contra' AND coa.account_group = 'Revenue' THEN jel.credit - jel.debit
      WHEN coa.account_type = 'expense' THEN jel.credit - jel.debit
      ELSE 0
    END
  ), 0)
  INTO v_prior_net_income
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND NOT COALESCE(je.is_cancelled, false)
    AND je.entry_date < v_year_start
    AND coa.is_header = false;

  -- Current-year YTD earnings (Jan 1 .. p_as_of_date)
  SELECT COALESCE(SUM(
    CASE
      WHEN coa.account_type = 'revenue' THEN jel.credit - jel.debit
      WHEN coa.account_type = 'contra' AND coa.account_group = 'Revenue' THEN jel.credit - jel.debit
      WHEN coa.account_type = 'expense' THEN jel.credit - jel.debit
      ELSE 0
    END
  ), 0)
  INTO v_ytd_net_income
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND NOT COALESCE(je.is_cancelled, false)
    AND je.entry_date >= v_year_start
    AND je.entry_date <= p_as_of_date
    AND coa.is_header = false;

  SELECT EXISTS (
    SELECT 1
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code = '3300'
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND NOT COALESCE(je.is_cancelled, false)
      AND je.entry_date <= p_as_of_date
  )
  INTO v_has_3300;

  RETURN QUERY
  WITH active_lines AS (
    SELECT jel.account_id, jel.debit, jel.credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND NOT COALESCE(je.is_cancelled, false)
      AND je.entry_date <= p_as_of_date
  ),
  base_rows AS (
    SELECT
      coa.code,
      coa.name,
      coa.name_id,
      coa.account_type,
      coa.account_group,
      COALESCE(
        coa.normal_balance,
        CASE WHEN coa.account_type IN ('asset', 'expense') THEN 'debit' ELSE 'credit' END
      )::varchar AS normal_balance,
      (COALESCE(SUM(al.debit), 0) + CASE WHEN coa.code = '3200' AND NOT v_has_3300 AND v_prior_net_income < 0 THEN ABS(v_prior_net_income) ELSE 0 END)::numeric AS total_debit,
      (COALESCE(SUM(al.credit), 0) + CASE WHEN coa.code = '3200' AND NOT v_has_3300 AND v_prior_net_income > 0 THEN v_prior_net_income ELSE 0 END)::numeric AS total_credit,
      (
        COALESCE(SUM(al.debit), 0) - COALESCE(SUM(al.credit), 0)
        + CASE WHEN coa.code = '3200' AND NOT v_has_3300 THEN -v_prior_net_income ELSE 0 END
      )::numeric AS balance
    FROM public.chart_of_accounts coa
    LEFT JOIN active_lines al ON al.account_id = coa.id
    WHERE coa.is_header = false
      AND coa.is_active = true
      AND (
        coa.account_type IN ('asset', 'liability', 'equity')
        OR (coa.account_type = 'contra' AND COALESCE(coa.account_group, '') <> 'Revenue')
      )
    GROUP BY coa.id, coa.code, coa.name, coa.name_id, coa.account_type,
      coa.account_group, coa.normal_balance
  )
  SELECT b.*
  FROM base_rows b
  WHERE ABS(b.total_debit) > 0.0001
     OR ABS(b.total_credit) > 0.0001
     OR ABS(b.balance) > 0.0001

  UNION ALL

  SELECT
    '3300'::varchar,
    'Current Year Earnings'::varchar,
    'Laba/Rugi Tahun Berjalan'::varchar,
    'equity'::varchar,
    'Equity'::varchar,
    'credit'::varchar,
    CASE WHEN v_ytd_net_income < 0 THEN ABS(v_ytd_net_income) ELSE 0 END,
    CASE WHEN v_ytd_net_income > 0 THEN v_ytd_net_income ELSE 0 END,
    (-v_ytd_net_income)::numeric
  WHERE NOT v_has_3300
    AND ABS(v_ytd_net_income) > 0.005
  ORDER BY 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_pnl_summary_detailed(
  p_start_date date,
  p_end_date date,
  p_usd_rate numeric DEFAULT 1
)
RETURNS TABLE(
  gross_commercial_sales numeric,
  sales_discounts numeric,
  sales_returns numeric,
  net_commercial_sales numeric,
  other_income numeric,
  fx_gain numeric,
  cogs numeric,
  operating_expenses numeric,
  other_expenses numeric,
  bank_charges numeric,
  fx_loss numeric,
  total_expenses numeric,
  total_income numeric,
  net_income numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ledger AS (
    SELECT
      public.get_pnl_classification(coa.code, coa.name, coa.account_type, coa.account_group) AS pnl_class,
      coa.account_type,
      (jel.credit - jel.debit)
        * public.get_journal_reporting_multiplier(je.id, p_usd_rate) AS revenue_amount,
      (jel.debit - jel.credit)
        * public.get_journal_reporting_multiplier(je.id, p_usd_rate) AS expense_amount
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND NOT COALESCE(je.is_cancelled, false)
      AND je.entry_date BETWEEN p_start_date AND p_end_date
      AND COALESCE(coa.is_header, false) = false
  ),
  totals AS (
    SELECT
      COALESCE(SUM(revenue_amount) FILTER (WHERE pnl_class = 'gross_sales'), 0)::numeric AS gross_commercial_sales,
      COALESCE(SUM(expense_amount) FILTER (WHERE pnl_class = 'sales_discounts'), 0)::numeric AS sales_discounts,
      COALESCE(SUM(expense_amount) FILTER (WHERE pnl_class = 'sales_returns'), 0)::numeric AS sales_returns,
      COALESCE(SUM(revenue_amount) FILTER (WHERE pnl_class = 'other_income'), 0)::numeric AS other_income,
      COALESCE(SUM(revenue_amount) FILTER (WHERE pnl_class = 'fx_gain'), 0)::numeric AS fx_gain,
      COALESCE(SUM(expense_amount) FILTER (WHERE pnl_class = 'cogs'), 0)::numeric AS cogs,
      COALESCE(SUM(expense_amount) FILTER (WHERE pnl_class = 'operating_expenses'), 0)::numeric AS operating_expenses,
      COALESCE(SUM(expense_amount) FILTER (WHERE pnl_class = 'other_expenses'), 0)::numeric AS other_expenses,
      COALESCE(SUM(expense_amount) FILTER (WHERE pnl_class = 'bank_charges'), 0)::numeric AS bank_charges,
      COALESCE(SUM(expense_amount) FILTER (WHERE pnl_class = 'fx_loss'), 0)::numeric AS fx_loss,
      COALESCE(SUM(expense_amount) FILTER (WHERE account_type = 'expense'), 0)::numeric AS total_expenses
    FROM ledger
  )
  SELECT
    gross_commercial_sales,
    sales_discounts,
    sales_returns,
    (gross_commercial_sales - sales_discounts - sales_returns)::numeric AS net_commercial_sales,
    other_income,
    fx_gain,
    cogs,
    operating_expenses,
    other_expenses,
    bank_charges,
    fx_loss,
    total_expenses,
    (gross_commercial_sales - sales_discounts - sales_returns + other_income + fx_gain)::numeric AS total_income,
    (gross_commercial_sales - sales_discounts - sales_returns + other_income + fx_gain - total_expenses)::numeric AS net_income
  FROM totals;
$function$;

CREATE OR REPLACE FUNCTION public.get_pnl_summary(
  p_start_date date,
  p_end_date date,
  p_usd_rate numeric DEFAULT 1
)
RETURNS TABLE(total_revenue numeric, total_expenses numeric, net_income numeric)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    total_income AS total_revenue,
    total_expenses,
    net_income
  FROM public.get_pnl_summary_detailed(p_start_date, p_end_date, p_usd_rate);
$function$;

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261126080000', 'fix_financial_report_rpcs')
ON CONFLICT (version) DO NOTHING;

COMMIT;
