-- Migration: 20261125180000_accounting_integrity_and_recurrence_prevention.sql
-- Description:
--   1. Enforce is_cancelled exclusion in get_trial_balance and get_petty_cash_balance.
--   2. Support journal-linked salary advance applications in salary_advance_applications
--      and recalculate_expense_payment_state; backfill PV/26-26/028 -> EXP/26/365 -> JE2611-0493.
--   3. Fix get_authoritative_sales_line_cogs line-level vs invoice-level comparison (eliminate false flags).
--   4. Maintain petty_cash_books.current_balance transactionally from GL 1102 / vw_petty_cash_balance.
--   5. Resolve security advisor findings (security_invoker views, revoke anon trigger fn, drop 8 duplicate index groups)
--      and record applied migrations in supabase_migrations.schema_migrations.

BEGIN;

-- ============================================================================
-- 1. TRIAL BALANCE & PETTY CASH BALANCE: EXCLUDE CANCELLED JOURNALS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_trial_balance(p_start_date date, p_end_date date, p_usd_rate numeric)
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
BEGIN
  RETURN QUERY
  WITH active_lines AS (
    SELECT jel.account_id, jel.debit, jel.credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND NOT COALESCE(je.is_cancelled, false)
      AND je.entry_date BETWEEN p_start_date AND p_end_date
  )
  SELECT coa.code, coa.name, coa.name_id, coa.account_type, coa.account_group,
    COALESCE(coa.normal_balance,
      CASE WHEN coa.account_type IN ('asset', 'expense') THEN 'debit' ELSE 'credit' END),
    COALESCE(SUM(al.debit), 0)::numeric,
    COALESCE(SUM(al.credit), 0)::numeric,
    (COALESCE(SUM(al.debit), 0) - COALESCE(SUM(al.credit), 0))::numeric
  FROM public.chart_of_accounts coa
  LEFT JOIN active_lines al ON al.account_id = coa.id
  WHERE coa.is_header = false AND coa.is_active = true
  GROUP BY coa.id, coa.code, coa.name, coa.name_id, coa.account_type,
    coa.account_group, coa.normal_balance
  HAVING COALESCE(SUM(al.debit), 0) <> 0 OR COALESCE(SUM(al.credit), 0) <> 0
  ORDER BY coa.code;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_petty_cash_balance()
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je
    ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa
    ON coa.id = jel.account_id
  WHERE coa.code = '1102'
    AND je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND NOT COALESCE(je.is_cancelled, false);
$function$;

-- ============================================================================
-- 2. JOURNAL-LINKED SALARY ADVANCE APPLICATIONS & EXP/26/365 BACKFILL
-- ============================================================================

ALTER TABLE public.salary_advance_applications
  ALTER COLUMN settlement_payment_voucher_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS settlement_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_salary_advance_app_settlement_source'
      AND conrelid = 'public.salary_advance_applications'::regclass
  ) THEN
    ALTER TABLE public.salary_advance_applications
      ADD CONSTRAINT chk_salary_advance_app_settlement_source
      CHECK (settlement_payment_voucher_id IS NOT NULL OR settlement_journal_entry_id IS NOT NULL);
  END IF;
END;
$$;

-- Unique constraint already exists on (advance_payment_voucher_id, salary_expense_id)

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

  -- 4. Include posted salary advance applications (via settlement PV OR settlement Journal Entry)
  SELECT v_supplier_paid + COALESCE(sum(sa.applied_amount),0) INTO v_supplier_paid
    FROM public.salary_advance_applications sa
    LEFT JOIN public.payment_vouchers settlement ON settlement.id = sa.settlement_payment_voucher_id
    LEFT JOIN public.journal_entries je ON je.id = sa.settlement_journal_entry_id
   WHERE sa.salary_expense_id = p_expense_id
     AND (
       (sa.settlement_payment_voucher_id IS NOT NULL AND settlement.is_posted = true)
       OR (
         sa.settlement_journal_entry_id IS NOT NULL
         AND je.is_posted = true
         AND NOT COALESCE(je.is_reversed, false)
         AND NOT COALESCE(je.is_cancelled, false)
       )
     );

  -- 5. Legacy cash expense recognition
  SELECT v_supplier_paid + COALESCE(sum(jel.credit), 0) INTO v_supplier_paid
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
   WHERE (je.reference_id = p_expense_id OR je.reference_number = 'EXP-' || p_expense_id::text)
     AND je.source_module IN ('expense', 'expenses')
     AND je.is_posted = true
     AND NOT COALESCE(je.is_reversed, false)
     AND NOT COALESCE(je.is_cancelled, false)
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

-- Backfill PV/26-26/028 -> EXP/26/365 -> JE2611-0493 (Rp 100,000) and recalculate paid_amount
DO $$
DECLARE
  v_je_0493_id uuid;
  v_pv_028_id uuid := '8a045a25-e2b4-4f7b-8a27-4312d86a547e'::uuid;
  v_exp_365_id uuid := 'b266063e-9f1d-48e7-8728-a7828b704204'::uuid;
BEGIN
  SELECT id INTO v_je_0493_id
  FROM public.journal_entries
  WHERE entry_number = 'JE2611-0493'
    AND is_posted = true
    AND NOT COALESCE(is_reversed, false)
    AND NOT COALESCE(is_cancelled, false);

  IF v_je_0493_id IS NULL THEN
    RAISE EXCEPTION 'Cannot backfill salary_advance_applications: JE2611-0493 not found or inactive.';
  END IF;

  INSERT INTO public.salary_advance_applications (
    advance_payment_voucher_id,
    salary_expense_id,
    settlement_payment_voucher_id,
    settlement_journal_entry_id,
    applied_amount,
    applied_at
  ) VALUES (
    v_pv_028_id,
    v_exp_365_id,
    NULL,
    v_je_0493_id,
    100000.00,
    '2026-10-31 00:00:00+07'::timestamptz
  )
  ON CONFLICT (advance_payment_voucher_id, salary_expense_id) DO UPDATE
  SET settlement_journal_entry_id = COALESCE(public.salary_advance_applications.settlement_journal_entry_id, EXCLUDED.settlement_journal_entry_id);

  PERFORM public.recalculate_expense_payment_state(v_exp_365_id);
END;
$$;

-- ============================================================================
-- 3. COGS LINE-LEVEL VS INVOICE-LEVEL COMPARISON FIX
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_authoritative_sales_line_cogs(p_start_date date, p_end_date date)
RETURNS TABLE(
  line_id uuid,
  invoice_id uuid,
  product_id uuid,
  batch_id uuid,
  quantity numeric,
  authoritative_cogs numeric,
  authoritative_unit_cogs numeric,
  resolution_tier text,
  invoice_line_count bigint,
  invoice_product_count bigint,
  posted_invoice_cogs numeric,
  base_line_cost numeric,
  reconciliation_difference numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
WITH active_cogs AS (
  SELECT je.reference_id AS invoice_id, je.id AS journal_id,
         SUM(jel.debit - jel.credit) AS cogs_amount
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND NOT COALESCE(je.is_cancelled, false)
    AND coa.code = '5100'
    AND je.reference_id IS NOT NULL
    AND (
      je.source_module IN ('sales_invoice_cogs', 'sales_invoice_cogs_adjustment')
      OR je.source_module IN ('historical_cogs_correction', 'historical_cogs_final_correction')
      OR je.source_module LIKE 'historical_cogs%'
      OR je.source_module LIKE '%cogs%'
    )
  GROUP BY je.reference_id, je.id
), posted_cogs AS (
  SELECT invoice_id, SUM(cogs_amount) AS posted_invoice_cogs
  FROM active_cogs GROUP BY invoice_id
), posted_item_cogs AS (
  SELECT jel.sales_invoice_item_id AS line_id,
         SUM(jel.debit - jel.credit) AS posted_item_cogs
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true 
    AND NOT COALESCE(je.is_reversed, false)
    AND NOT COALESCE(je.is_cancelled, false)
    AND coa.code = '5100' AND jel.sales_invoice_item_id IS NOT NULL
    AND (
      je.source_module IN ('sales_invoice_cogs', 'sales_invoice_cogs_adjustment')
      OR je.source_module IN ('historical_cogs_correction', 'historical_cogs_final_correction')
      OR je.source_module LIKE 'historical_cogs%'
      OR je.source_module LIKE '%cogs%'
    )
  GROUP BY jel.sales_invoice_item_id
), line_basis AS (
  SELECT sii.id AS line_id, sii.invoice_id, sii.product_id, sii.batch_id,
         sii.quantity,
         pic.posted_item_cogs,
         sii.cogs_total_cost AS snapshot_cogs,
         sii.cogs_unit_cost AS snapshot_unit_cogs,
         CASE 
           WHEN b.id IS NOT NULL 
           THEN public.calculate_batch_authoritative_cost(b)
           ELSE NULL 
         END AS batch_authoritative_unit_cost,
         CASE 
           WHEN b.id IS NOT NULL 
           THEN ROUND(sii.quantity * public.calculate_batch_authoritative_cost(b), 2)
           WHEN COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0)) IS NOT NULL
           THEN ROUND(sii.quantity * COALESCE(NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.cost_per_unit, 0), NULLIF(b.import_price, 0)), 2)
           ELSE NULL 
         END AS base_line_cost,
         pc.posted_invoice_cogs
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.batches b ON b.id = sii.batch_id
  LEFT JOIN posted_cogs pc ON pc.invoice_id = sii.invoice_id
  LEFT JOIN posted_item_cogs pic ON pic.line_id = sii.id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND NOT COALESCE(si.is_draft, false)
    AND COALESCE(si.document_status, 'posted') = 'posted'
    AND NOT (COALESCE(si.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(si.notes, '')) LIKE 'cancelled%')
), invoice_evidence AS (
  SELECT invoice_id,
         COUNT(*) AS invoice_line_count,
         COUNT(DISTINCT product_id) AS invoice_product_count,
         COALESCE(SUM(COALESCE(base_line_cost, snapshot_cogs)), 0) AS resolved_cogs_total,
         MAX(posted_invoice_cogs) AS posted_invoice_cogs
  FROM line_basis GROUP BY invoice_id
), resolved AS (
  SELECT lb.*, ie.invoice_line_count, ie.invoice_product_count,
         ie.resolved_cogs_total,
         ie.posted_invoice_cogs AS invoice_posted_cogs,
         COALESCE(
           lb.base_line_cost,
           lb.snapshot_cogs,
           CASE WHEN ie.invoice_line_count = 1 THEN ie.posted_invoice_cogs ELSE NULL END
         ) AS effective_authoritative_cogs
  FROM line_basis lb JOIN invoice_evidence ie ON ie.invoice_id = lb.invoice_id
), invoice_rollup AS (
  SELECT r.*,
         SUM(r.effective_authoritative_cogs) OVER (PARTITION BY r.invoice_id) AS invoice_authoritative_total,
         SUM(COALESCE(r.posted_item_cogs, 0)) OVER (PARTITION BY r.invoice_id) AS invoice_item_cogs_sum,
         COUNT(*) FILTER (WHERE r.posted_item_cogs IS NULL) OVER (PARTITION BY r.invoice_id) AS invoice_missing_item_cogs_lines,
         COUNT(*) FILTER (WHERE r.effective_authoritative_cogs IS NULL) OVER (PARTITION BY r.invoice_id) AS invoice_unresolved_lines
  FROM resolved r
)
SELECT r.line_id, r.invoice_id, r.product_id, r.batch_id, r.quantity,
  CASE
    WHEN r.base_line_cost IS NOT NULL AND r.base_line_cost > 0 THEN r.base_line_cost
    WHEN r.snapshot_cogs IS NOT NULL AND r.snapshot_cogs > 0 THEN r.snapshot_cogs
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL AND r.invoice_posted_cogs > 0 THEN r.invoice_posted_cogs
    WHEN r.posted_item_cogs IS NOT NULL AND r.posted_item_cogs > 0 THEN r.posted_item_cogs
    WHEN r.base_line_cost IS NOT NULL THEN r.base_line_cost
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs
    ELSE NULL 
  END AS authoritative_cogs,
  CASE
    WHEN r.quantity = 0 THEN NULL
    WHEN r.base_line_cost IS NOT NULL AND r.base_line_cost > 0 THEN r.base_line_cost / r.quantity
    WHEN r.snapshot_cogs IS NOT NULL AND r.snapshot_cogs > 0 THEN r.snapshot_cogs / r.quantity
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL AND r.invoice_posted_cogs > 0 THEN r.invoice_posted_cogs / r.quantity
    WHEN r.posted_item_cogs IS NOT NULL AND r.posted_item_cogs > 0 THEN r.posted_item_cogs / r.quantity
    WHEN r.base_line_cost IS NOT NULL THEN r.base_line_cost / r.quantity
    WHEN r.snapshot_cogs IS NOT NULL THEN r.snapshot_cogs / r.quantity
    ELSE NULL 
  END AS authoritative_unit_cogs,
  CASE
    WHEN r.base_line_cost IS NOT NULL AND r.base_line_cost > 0 THEN 'canonical_batch_cost'
    WHEN r.snapshot_cogs IS NOT NULL AND r.snapshot_cogs > 0 THEN 'snapshot'
    WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL AND r.invoice_posted_cogs > 0 THEN 'single_line_posted_cogs'
    WHEN r.posted_item_cogs IS NOT NULL AND r.posted_item_cogs > 0 THEN 'posted_item_cogs'
    WHEN r.base_line_cost IS NOT NULL THEN 'canonical_batch_cost'
    WHEN r.snapshot_cogs IS NOT NULL THEN 'snapshot'
    ELSE 'unresolved' 
  END AS resolution_tier,
  r.invoice_line_count, r.invoice_product_count, r.invoice_posted_cogs,
  r.base_line_cost,
  -- Compare line-to-line ONLY when item-level posting covers the entire invoice posted COGS;
  -- otherwise compare aggregated invoice authoritative COGS to posted invoice COGS.
  CASE
    WHEN r.effective_authoritative_cogs IS NULL THEN 0::numeric
    WHEN r.invoice_missing_item_cogs_lines = 0
         AND r.invoice_posted_cogs IS NOT NULL
         AND ABS(r.invoice_item_cogs_sum - r.invoice_posted_cogs) <= 0.05
      THEN ABS(r.effective_authoritative_cogs - r.posted_item_cogs)
    WHEN r.invoice_unresolved_lines > 0 OR r.invoice_posted_cogs IS NULL THEN 0::numeric
    ELSE COALESCE(ABS(r.invoice_authoritative_total - r.invoice_posted_cogs), 0::numeric)
  END AS reconciliation_difference
FROM invoice_rollup r;
$function$;

-- ============================================================================
-- 4. PETTY CASH BOOKS TRANSACTIONAL BALANCE SYNCHRONIZATION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_petty_cash_book_balances()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_canonical_balance numeric;
BEGIN
  SELECT COALESCE(current_balance, 0) INTO v_canonical_balance
  FROM public.vw_petty_cash_balance;

  UPDATE public.petty_cash_books
  SET current_balance = v_canonical_balance,
      updated_at = now()
  WHERE is_active = true
    AND current_balance IS DISTINCT FROM v_canonical_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_fn_sync_petty_cash_book_balances()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  PERFORM public.sync_petty_cash_book_balances();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_petty_cash_books_on_pct ON public.petty_cash_transactions;
CREATE TRIGGER trg_sync_petty_cash_books_on_pct
  AFTER INSERT OR UPDATE OR DELETE ON public.petty_cash_transactions
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.trg_fn_sync_petty_cash_book_balances();

DROP TRIGGER IF EXISTS trg_sync_petty_cash_books_on_ft ON public.fund_transfers;
CREATE TRIGGER trg_sync_petty_cash_books_on_ft
  AFTER INSERT OR UPDATE OR DELETE ON public.fund_transfers
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.trg_fn_sync_petty_cash_book_balances();

-- Execute initial synchronization so petty_cash_books.current_balance matches Rp 100,499.00
SELECT public.sync_petty_cash_book_balances();

-- ============================================================================
-- 5. SUPABASE SECURITY ADVISORS, DUPLICATE INDEXES & MIGRATION RECORDING
-- ============================================================================

ALTER VIEW public.customer_receivables_view SET (security_invoker = true);
ALTER VIEW public.inventory_gl_valuation_reconciliation SET (security_invoker = true);
ALTER VIEW public.supplier_payables_view SET (security_invoker = true);
ALTER VIEW public.vw_bank_ledger_effective SET (security_invoker = true);

REVOKE ALL ON FUNCTION public.guard_settled_salary_advance_edit() FROM PUBLIC, anon;

-- Drop redundant duplicate indexes (8 groups)
DROP INDEX IF EXISTS public.idx_je_date;
DROP INDEX IF EXISTS public.idx_petty_cash_single_source_journal;
DROP INDEX IF EXISTS public.idx_petty_cash_fund_transfer_unique;
DROP INDEX IF EXISTS public.idx_bank_statement_lines_status;
DROP INDEX IF EXISTS public.idx_pl_inquiry_id;
DROP INDEX IF EXISTS public.idx_pricing_ledger_inquiry;
DROP INDEX IF EXISTS public.idx_pl_customer_id;
DROP INDEX IF EXISTS public.idx_pl_product_name;
DROP INDEX IF EXISTS public.invoice_rounding_adjustments_one_per_invoice;

-- Reconcile supabase_migrations.schema_migrations history
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES
  ('20261122030000', 'canonical_bank_ledger_and_balance_architecture'),
  ('20261122120000', 'accounting_cancellation_lifecycle_and_cleanup'),
  ('20261125180000', 'accounting_integrity_and_recurrence_prevention')
ON CONFLICT (version) DO NOTHING;

COMMIT;
