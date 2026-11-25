-- Migration: 20261122120000_accounting_cancellation_lifecycle_and_cleanup.sql
-- Description: Implement auditable journal cancellation lifecycle, update effective accounting views,
-- reconcile COGS with credit note reversals, and apply Sandi advance and Petty Cash corrections.

BEGIN;

-- ============================================================================
-- 1. CANCELLATION SCHEMA FOR JOURNAL ENTRIES
-- ============================================================================

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS is_cancelled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cancellation_group_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS replacement_journal_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_source_reference text;

CREATE INDEX IF NOT EXISTS idx_journal_entries_cancellation 
  ON public.journal_entries(is_cancelled) WHERE is_cancelled = true;

CREATE INDEX IF NOT EXISTS idx_journal_entries_cancellation_group 
  ON public.journal_entries(cancellation_group_id) WHERE cancellation_group_id IS NOT NULL;

-- Update unique document journal index to exclude cancelled entries
DROP INDEX IF EXISTS public.uq_active_bank_document_journal;
CREATE UNIQUE INDEX uq_active_bank_document_journal 
ON public.journal_entries USING btree (source_module, reference_id) 
WHERE (
  reference_id IS NOT NULL 
  AND is_posted = true 
  AND COALESCE(is_reversed, false) = false 
  AND COALESCE(is_cancelled, false) = false
  AND (reference_number::text IS DISTINCT FROM entry_number::text) 
  AND (source_module::text = ANY (ARRAY['expenses'::character varying, 'payment'::character varying, 'receipt'::character varying, 'petty_cash'::character varying, 'fund_transfers'::character varying, 'tax_payment'::character varying]::text[]))
);

-- ============================================================================
-- 2. ATOMIC CANCELLATION RPC (IDEMPOTENT)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cancel_journal_entry_group(
  p_journal_ids uuid[],
  p_reason text,
  p_cancelled_by uuid DEFAULT NULL,
  p_source_ref text DEFAULT NULL,
  p_replacement_id uuid DEFAULT NULL,
  p_group_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_group_id uuid;
  v_existing_group_id uuid;
  v_existing_group_count int;
  v_already_cancelled int;
  v_found_count int;
  v_distinct_count int;
  v_updated_count int;
  v_claim_role text;
  v_rep_active boolean;
BEGIN
  -- Authorize only trusted service_role JWT claim or direct privileged database administrator session.
  -- Do not use current_user inside SECURITY DEFINER (which reflects function owner, not caller).
  v_claim_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  );

  IF COALESCE(v_claim_role, '') = 'service_role' THEN
    NULL;
  ELSIF COALESCE(v_claim_role, '') = ''
    AND session_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Unauthorized: cancel_journal_entry_group requires service_role JWT or privileged database administrator session (session_user: %, jwt_role: %).',
      session_user, COALESCE(v_claim_role, 'none');
  END IF;

  IF p_journal_ids IS NULL OR array_length(p_journal_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one journal entry ID must be provided.';
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(p_journal_ids) AS x(id) WHERE x.id IS NULL) THEN
    RAISE EXCEPTION 'Journal entry ID array must not contain NULL values.';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Cancellation reason is required.';
  END IF;

  SELECT count(DISTINCT x.id) INTO v_distinct_count
  FROM unnest(p_journal_ids) AS x(id);

  SELECT count(*) INTO v_found_count
  FROM public.journal_entries
  WHERE id = ANY(p_journal_ids);

  IF v_found_count <> v_distinct_count THEN
    RAISE EXCEPTION 'One or more target journal_entries IDs do not exist (expected %, found %).', v_distinct_count, v_found_count;
  END IF;

  IF p_replacement_id IS NOT NULL THEN
    IF p_replacement_id = ANY(p_journal_ids) THEN
      RAISE EXCEPTION 'Replacement journal % cannot be in the cancelled target set.', p_replacement_id;
    END IF;

    SELECT (is_posted = true AND NOT COALESCE(is_reversed, false) AND NOT COALESCE(is_cancelled, false))
    INTO v_rep_active
    FROM public.journal_entries
    WHERE id = p_replacement_id;

    IF NOT COALESCE(v_rep_active, false) THEN
      RAISE EXCEPTION 'Replacement journal % does not exist or is not an active posted journal.', p_replacement_id;
    END IF;
  END IF;

  SELECT
    count(*) FILTER (WHERE COALESCE(is_cancelled, false) = true),
    count(DISTINCT cancellation_group_id) FILTER (WHERE COALESCE(is_cancelled, false) = true),
    min(cancellation_group_id::text) FILTER (WHERE COALESCE(is_cancelled, false) = true)::uuid
  INTO v_already_cancelled, v_existing_group_count, v_existing_group_id
  FROM public.journal_entries
  WHERE id = ANY(p_journal_ids);

  IF v_already_cancelled = v_distinct_count THEN
    IF v_existing_group_count <> 1 OR v_existing_group_id IS NULL THEN
      RAISE EXCEPTION 'All % target journals are already cancelled, but do not share a single cancellation_group_id (distinct groups: %).',
        v_distinct_count, v_existing_group_count;
    END IF;
    RETURN v_existing_group_id;
  END IF;

  IF v_already_cancelled > 0 THEN
    RAISE EXCEPTION 'Partial cancellation conflict: % of % target journals are already cancelled.',
      v_already_cancelled, v_distinct_count;
  END IF;

  v_group_id := COALESCE(p_group_id, gen_random_uuid());

  UPDATE public.journal_entries
  SET
    is_cancelled = true,
    cancellation_group_id = v_group_id,
    cancelled_at = now(),
    cancelled_by = p_cancelled_by,
    cancellation_reason = p_reason,
    replacement_journal_id = p_replacement_id,
    cancellation_source_reference = p_source_ref
  WHERE id = ANY(p_journal_ids)
    AND NOT COALESCE(is_cancelled, false);

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> v_distinct_count THEN
    RAISE EXCEPTION 'Cancellation row-count mismatch: expected to update % journals, but updated %.',
      v_distinct_count, v_updated_count;
  END IF;

  RETURN v_group_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_journal_entry_group(uuid[], text, uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_journal_entry_group(uuid[], text, uuid, text, uuid, uuid) TO service_role;

-- ============================================================================
-- 3. UPDATE CANONICAL VIEWS TO EXCLUDE CANCELLED JOURNALS
-- ============================================================================

-- Bank Ledger Effective View
CREATE OR REPLACE VIEW public.vw_bank_ledger_effective AS
SELECT ba.id AS bank_account_id,
  ba.account_number,
  ba.account_name,
  upper(ba.currency) AS bank_currency,
  je.id AS journal_entry_id,
  je.entry_number,
  je.entry_date,
  COALESCE(( SELECT min(bsl.transaction_date) AS min
         FROM bank_statement_lines bsl
        WHERE bsl.bank_account_id = ba.id AND bsl.matched_entry_id = je.id), ( SELECT min(bsl2.transaction_date) AS min
         FROM bank_statement_allocations a
           JOIN bank_statement_lines bsl2 ON bsl2.id = a.bank_statement_line_id
        WHERE a.journal_entry_id = je.id AND bsl2.bank_account_id = ba.id), je.entry_date) AS effective_bank_date,
  je.source_module,
  je.reference_id,
  je.reference_number,
  je.description,
  jel.id AS journal_line_id,
  jel.line_number,
  jel.account_id,
      CASE
          WHEN upper(ba.currency) = 'USD'::text THEN COALESCE(jel.transaction_debit, jel.debit)
          ELSE jel.debit
      END AS debit_amount,
      CASE
          WHEN upper(ba.currency) = 'USD'::text THEN COALESCE(jel.transaction_credit, jel.credit)
          ELSE jel.credit
      END AS credit_amount,
      CASE
          WHEN upper(ba.currency) = 'USD'::text THEN COALESCE(jel.transaction_debit, jel.debit) - COALESCE(jel.transaction_credit, jel.credit)
          ELSE jel.debit - jel.credit
      END AS net_amount,
      CASE
          WHEN je.source_module::text = 'historical_repair'::text AND (je.reference_number::text ~~ 'HR-REV%'::text OR je.entry_number::text ~~ 'HR-REV%'::text) THEN 'excluded_historical_repair_reversal'::text
          WHEN (EXISTS ( SELECT 1
             FROM journal_entries hrr
            WHERE hrr.id = je.reversed_by_id AND hrr.source_module::text = 'historical_repair'::text AND (hrr.reference_number::text ~~ 'HR-REV%'::text OR hrr.entry_number::text ~~ 'HR-REV%'::text))) THEN 'excluded_historical_repair_original'::text
          WHEN COALESCE(je.is_cancelled, false) = true THEN 'excluded_cancelled'::text
          WHEN COALESCE(je.is_reversed, false) = false THEN 'effective_posted'::text
          WHEN COALESCE(je.is_reversed, false) = true AND ((EXISTS ( SELECT 1
             FROM journal_entries rev
            WHERE rev.id = je.reversed_by_id AND rev.is_posted = true AND NOT (rev.source_module::text = 'historical_repair'::text AND (rev.reference_number::text ~~ 'HR-REV%'::text OR rev.entry_number::text ~~ 'HR-REV%'::text)))) OR (EXISTS ( SELECT 1
             FROM journal_entries orig
            WHERE orig.reversed_by_id = je.id AND orig.is_posted = true AND NOT (orig.source_module::text = 'historical_repair'::text AND (orig.reference_number::text ~~ 'HR-REV%'::text OR orig.entry_number::text ~~ 'HR-REV%'::text))))) THEN 'effective_reversal_pair'::text
          ELSE 'excluded_voided'::text
      END AS ledger_treatment
 FROM bank_accounts ba
   JOIN journal_entry_lines jel ON jel.account_id = ba.coa_id
   JOIN journal_entries je ON je.id = jel.journal_entry_id
WHERE je.is_posted = true 
  AND NOT COALESCE(je.is_cancelled, false)
  AND (upper(ba.currency) <> 'USD'::text OR jel.transaction_currency = 'USD'::text OR jel.debit = 0::numeric AND jel.credit = 0::numeric OR COALESCE(jel.transaction_debit, 0::numeric) > 0::numeric OR COALESCE(jel.transaction_credit, 0::numeric) > 0::numeric) 
  AND NOT (je.source_module::text = 'historical_repair'::text AND (je.reference_number::text ~~ 'HR-REV%'::text OR je.entry_number::text ~~ 'HR-REV%'::text)) 
  AND NOT (EXISTS ( SELECT 1
         FROM journal_entries hrr
        WHERE hrr.id = je.reversed_by_id AND hrr.source_module::text = 'historical_repair'::text AND (hrr.reference_number::text ~~ 'HR-REV%'::text OR hrr.entry_number::text ~~ 'HR-REV%'::text))) 
  AND (COALESCE(je.is_reversed, false) = false OR COALESCE(je.is_reversed, false) = true AND ((EXISTS ( SELECT 1
         FROM journal_entries rev
        WHERE rev.id = je.reversed_by_id AND rev.is_posted = true AND NOT (rev.source_module::text = 'historical_repair'::text AND (rev.reference_number::text ~~ 'HR-REV%'::text OR rev.entry_number::text ~~ 'HR-REV%'::text)))) OR (EXISTS ( SELECT 1
         FROM journal_entries orig
        WHERE orig.reversed_by_id = je.id AND orig.is_posted = true AND NOT (orig.source_module::text = 'historical_repair'::text AND (orig.reference_number::text ~~ 'HR-REV%'::text OR orig.entry_number::text ~~ 'HR-REV%'::text))))));

-- Customer Receivables View
CREATE OR REPLACE VIEW public.customer_receivables_view AS
SELECT c.id AS customer_id,
  c.company_name,
  COALESCE(sum(
      CASE
          WHEN coa.code::text = '1120'::text THEN jel.debit - jel.credit
          ELSE 0::numeric
      END), 0::numeric) AS receivable_balance
 FROM customers c
   LEFT JOIN journal_entry_lines jel ON jel.customer_id = c.id
   LEFT JOIN chart_of_accounts coa ON coa.id = jel.account_id
   LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
WHERE COALESCE(je.is_posted, false) 
  AND NOT COALESCE(je.is_reversed, false)
  AND NOT COALESCE(je.is_cancelled, false)
GROUP BY c.id, c.company_name
HAVING COALESCE(sum(
      CASE
          WHEN coa.code::text = '1120'::text THEN jel.debit - jel.credit
          ELSE 0::numeric
      END), 0::numeric) <> 0::numeric;

-- Supplier Payables View
CREATE OR REPLACE VIEW public.supplier_payables_view AS
SELECT s.id AS supplier_id,
  s.company_name,
  COALESCE(sum(
      CASE
          WHEN coa.code::text = '2110'::text THEN jel.credit - jel.debit
          ELSE 0::numeric
      END), 0::numeric) AS payable_balance
 FROM suppliers s
   LEFT JOIN journal_entry_lines jel ON jel.supplier_id = s.id
   LEFT JOIN chart_of_accounts coa ON coa.id = jel.account_id
   LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
WHERE COALESCE(je.is_posted, false) 
  AND NOT COALESCE(je.is_reversed, false)
  AND NOT COALESCE(je.is_cancelled, false)
GROUP BY s.id, s.company_name
HAVING COALESCE(sum(
      CASE
          WHEN coa.code::text = '2110'::text THEN jel.credit - jel.debit
          ELSE 0::numeric
      END), 0::numeric) <> 0::numeric;

-- Inventory GL Valuation Reconciliation View
CREATE OR REPLACE VIEW public.inventory_gl_valuation_reconciliation AS
WITH gl AS (
  SELECT COALESCE(sum(jel.debit - jel.credit), 0::numeric) AS inventory_gl
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  JOIN chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code::text = '1130'::text 
    AND je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND NOT COALESCE(je.is_cancelled, false)
), valuation AS (
  SELECT COALESCE(sum(b.current_stock * COALESCE(b.landed_cost_per_unit, b.cost_per_unit, b.import_price, 0::numeric)), 0::numeric) AS batch_valuation
  FROM batches b
  WHERE COALESCE(b.is_active, true)
)
SELECT gl.inventory_gl,
  valuation.batch_valuation,
  gl.inventory_gl - valuation.batch_valuation AS variance
FROM gl, valuation;

-- ============================================================================
-- 4. COGS CALCULATION REPAIRS (CREDIT-NOTE REVERSALS & RESOLUTION)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_cogs_for_period(p_start date, p_end date)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT 
    COALESCE(
      (SELECT SUM(authoritative_cogs) FROM public.get_authoritative_sales_line_cogs(p_start, p_end)),
      0
    ) - COALESCE(
      (
        SELECT SUM(jel.credit - jel.debit)
        FROM public.journal_entries je
        JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
        WHERE je.is_posted = true
          AND NOT COALESCE(je.is_reversed, false)
          AND NOT COALESCE(je.is_cancelled, false)
          AND coa.code = '5100'
          AND (je.source_module = 'credit_note_cogs' OR je.source_module LIKE 'credit_note%')
          AND je.entry_date BETWEEN p_start AND p_end
      ),
      0
    );
$$;

-- Repair get_authoritative_sales_line_cogs reconciliation_difference calculation
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
  COALESCE(ABS(r.effective_authoritative_cogs - COALESCE(r.posted_item_cogs, r.invoice_posted_cogs / NULLIF(r.invoice_line_count, 0))), 0::numeric) AS reconciliation_difference
FROM resolved r;
$function$;

-- ============================================================================
-- 4B. MIGRATION PRECONDITIONS (STRICT ASSERTIONS BEFORE DATA MUTATION)
-- ============================================================================

DO $$
DECLARE
  v_rec RECORD;
  v_count int;
  v_line_dr numeric;
  v_line_cr numeric;
BEGIN
  -- Verify all 10 target journals exist exactly once with expected module, reference, status, and line totals
  FOR v_rec IN
    SELECT * FROM (VALUES
      ('JE2611-0459',        'fund_transfers',                     'FT2611-0002',                              true, true,  100000.00::numeric),
      ('REV-FT2611-0002',    'fund_transfers',                     'REV-FT2611-0002',                          true, false, 100000.00::numeric),
      ('JE2611-0363',        'payment',                            'PV/26-26/032',                             true, true,  1100000.00::numeric),
      ('JE2611-0457',        'historical_repair',                  'REV-JE2611-0363',                          true, false, 1100000.00::numeric),
      ('JE2607-0069',        'expense_history',                    'EXP-881cb8f9-0eca-4675-9951-3ec988c0bbf4', true, true,  500000.00::numeric),
      ('HFR-260826-SAR-093', 'historical_salary_advance_reversal', 'EXP/26-26/093',                            true, true,  500000.00::numeric),
      ('JE2607-0092',        'expense_history',                    'EXP-cfa5c43e-24e1-4091-9584-8f5c883b7b3f', true, true,  150000.00::numeric),
      ('HFR-260826-SAR-102', 'historical_salary_advance_reversal', 'EXP/26-26/102',                            true, true,  150000.00::numeric),
      ('JE2609-0003',        'payment',                            'PV/26-26/012',                             true, false, 500000.00::numeric),
      ('JE2609-0004',        'payment',                            'PV/26-26/013',                             true, false, 150000.00::numeric)
    ) AS t(entry_num, exp_module, exp_ref, exp_posted, exp_reversed, exp_amt)
  LOOP
    SELECT count(*) INTO v_count
    FROM public.journal_entries
    WHERE entry_number = v_rec.entry_num;

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Precondition failed: journal % expected exactly 1 row, found %.', v_rec.entry_num, v_count;
    END IF;

    PERFORM 1
    FROM public.journal_entries je
    WHERE je.entry_number = v_rec.entry_num
      AND je.source_module = v_rec.exp_module
      AND je.reference_number = v_rec.exp_ref
      AND je.is_posted = v_rec.exp_posted
      AND COALESCE(je.is_reversed, false) = v_rec.exp_reversed
      AND COALESCE(je.is_cancelled, false) = false
      AND je.total_debit = v_rec.exp_amt
      AND je.total_credit = v_rec.exp_amt;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Precondition failed: journal % is already cancelled or header attributes do not match expected values (module %, ref %, posted %, reversed %, amt %).',
        v_rec.entry_num, v_rec.exp_module, v_rec.exp_ref, v_rec.exp_posted, v_rec.exp_reversed, v_rec.exp_amt;
    END IF;

    SELECT COALESCE(SUM(jel.debit), 0), COALESCE(SUM(jel.credit), 0)
    INTO v_line_dr, v_line_cr
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.entry_number = v_rec.entry_num;

    IF v_line_dr <> v_rec.exp_amt OR v_line_cr <> v_rec.exp_amt THEN
      RAISE EXCEPTION 'Precondition failed: journal % line totals (Dr %, Cr %) do not match expected %.',
        v_rec.entry_num, v_line_dr, v_line_cr, v_rec.exp_amt;
    END IF;
  END LOOP;

  -- Verify exact account-level debit/credit lines for all 10 cancellation targets
  FOR v_rec IN
    SELECT * FROM (VALUES
      ('JE2611-0459',        '1102',   100000.00::numeric,  0.00::numeric),
      ('JE2611-0459',        '111101', 0.00::numeric,       100000.00::numeric),
      ('REV-FT2611-0002',    '1102',   0.00::numeric,       100000.00::numeric),
      ('REV-FT2611-0002',    '111101', 100000.00::numeric,  0.00::numeric),
      ('JE2611-0363',        '2110',   1100000.00::numeric, 0.00::numeric),
      ('JE2611-0363',        '1160',   0.00::numeric,       1100000.00::numeric),
      ('JE2611-0457',        '1160',   1100000.00::numeric, 0.00::numeric),
      ('JE2611-0457',        '2110',   0.00::numeric,       1100000.00::numeric),
      ('JE2607-0069',        '6100',   500000.00::numeric,  0.00::numeric),
      ('JE2607-0069',        '111101', 0.00::numeric,       500000.00::numeric),
      ('HFR-260826-SAR-093', '6100',   0.00::numeric,       500000.00::numeric),
      ('HFR-260826-SAR-093', '111101', 500000.00::numeric,  0.00::numeric),
      ('JE2607-0092',        '6100',   150000.00::numeric,  0.00::numeric),
      ('JE2607-0092',        '111101', 0.00::numeric,       150000.00::numeric),
      ('HFR-260826-SAR-102', '6100',   0.00::numeric,       150000.00::numeric),
      ('HFR-260826-SAR-102', '111101', 150000.00::numeric,  0.00::numeric),
      ('JE2609-0003',        '2110',   500000.00::numeric,  0.00::numeric),
      ('JE2609-0003',        '1160',   0.00::numeric,       500000.00::numeric),
      ('JE2609-0004',        '2110',   150000.00::numeric,  0.00::numeric),
      ('JE2609-0004',        '1160',   0.00::numeric,       150000.00::numeric)
    ) AS l(entry_num, acct_code, exp_dr, exp_cr)
  LOOP
    SELECT count(*) INTO v_count
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE je.entry_number = v_rec.entry_num
      AND coa.code = v_rec.acct_code
      AND jel.debit = v_rec.exp_dr
      AND jel.credit = v_rec.exp_cr;

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Precondition failed: journal % expected 1 line on account % (Dr %, Cr %), found %.',
        v_rec.entry_num, v_rec.acct_code, v_rec.exp_dr, v_rec.exp_cr, v_count;
    END IF;
  END LOOP;

  -- Verify all 3 replacement journals exist exactly once and are active posted journals
  FOR v_rec IN
    SELECT * FROM (VALUES
      ('JE2611-0458',        'payment',  'PV/26-26/032',                             1000000.00::numeric),
      ('HFR-260826-SAA-093', 'expenses', 'EXP-881cb8f9-0eca-4675-9951-3ec988c0bbf4', 500000.00::numeric),
      ('HFR-260826-SAA-102', 'expenses', 'EXP-cfa5c43e-24e1-4091-9584-8f5c883b7b3f', 150000.00::numeric)
    ) AS r(entry_num, exp_module, exp_ref, exp_amt)
  LOOP
    SELECT count(*) INTO v_count
    FROM public.journal_entries
    WHERE entry_number = v_rec.entry_num;

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Precondition failed: replacement journal % expected exactly 1 row, found %.', v_rec.entry_num, v_count;
    END IF;

    PERFORM 1
    FROM public.journal_entries je
    WHERE je.entry_number = v_rec.entry_num
      AND je.source_module = v_rec.exp_module
      AND je.reference_number = v_rec.exp_ref
      AND je.is_posted = true
      AND COALESCE(je.is_reversed, false) = false
      AND COALESCE(je.is_cancelled, false) = false
      AND je.total_debit = v_rec.exp_amt
      AND je.total_credit = v_rec.exp_amt;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Precondition failed: replacement journal % is missing, inactive, or materially different.', v_rec.entry_num;
    END IF;
  END LOOP;
END;
$$;

-- ============================================================================
-- 5. APPLY SANDI GROUP A CANCELLATION (ERRONEOUS BANK-PETTY CASH TRANSFER)
-- ============================================================================

SELECT public.cancel_journal_entry_group(
  (SELECT array_agg(id) FROM public.journal_entries WHERE entry_number IN ('JE2611-0459', 'REV-FT2611-0002')),
  'Erroneous BCA-to-Petty-Cash transfer. The source transfer has no linked BCA statement transaction and the associated withdrawal was rejected. A separate approved Sandi salary advance was already paid through Petty Cash voucher PV/26-26/028.',
  NULL,
  'FT2611-0002 / PC-202610-030',
  NULL
);

-- ============================================================================
-- 6. APPLY SANDI GROUP B CANCELLATION & VOUCHER METADATA REPAIR
-- ============================================================================

SELECT public.cancel_journal_entry_group(
  (SELECT array_agg(id) FROM public.journal_entries WHERE entry_number IN ('JE2611-0363', 'JE2611-0457')),
  'Overstated 1,100,000 salary advance settlement attempt. Superseded by corrected 1,000,000 settlement JE2611-0458.',
  NULL,
  'PV/26-26/032',
  (SELECT id FROM public.journal_entries WHERE entry_number = 'JE2611-0458')
);

-- Correct PV/26-26/032 metadata to reflect 1,000,000 non-cash advance settlement
DO $$
DECLARE
  v_pv_updated int;
BEGIN
  UPDATE public.payment_vouchers
  SET
    amount = 1000000.00,
    payment_amount = 1000000.00,
    invoice_amount = 1000000.00,
    converted_amount = 1000000.00,
    bank_amount = 0.00,
    actual_bank_debit = 0.00,
    salary_advance_applied_amount = 1000000.00,
    salary_advance_status = 'settled',
    updated_at = now()
  WHERE id = '75271c77-fc47-4ba7-b1fa-42cb4abd74ca'
    AND voucher_number = 'PV/26-26/032';

  GET DIAGNOSTICS v_pv_updated = ROW_COUNT;
  IF v_pv_updated <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 PV/26-26/032 row updated, updated %.', v_pv_updated;
  END IF;
END;
$$;

-- ============================================================================
-- 7. APPLY SANDI GROUP C NON-CASH ADVANCE DEDUCTION (PV/028 AGAINST EXP/365)
-- ============================================================================

DO $$
DECLARE
  v_new_je_id uuid;
  v_period_id uuid;
  v_period_count int;
  v_acc_2110 uuid;
  v_acc_1160 uuid;
BEGIN
  SELECT count(*), min(id::text)::uuid
  INTO v_period_count, v_period_id
  FROM public.accounting_periods
  WHERE start_date <= '2026-10-31'::date
    AND end_date >= '2026-10-31'::date;

  IF v_period_count <> 1 OR v_period_id IS NULL THEN
    RAISE EXCEPTION 'Cannot uniquely identify October 2026 accounting period for 2026-10-31 (found %).', v_period_count;
  END IF;

  SELECT id INTO v_acc_2110 FROM public.chart_of_accounts WHERE code = '2110';
  SELECT id INTO v_acc_1160 FROM public.chart_of_accounts WHERE code = '1160';

  -- Only insert if not already present (postconditions below validate exact state even if pre-existing)
  IF NOT EXISTS (
    SELECT 1 FROM public.journal_entries WHERE entry_number = 'JE2611-0493'
  ) THEN
    -- System migration attribution: created_by and posted_by remain NULL
    -- (never attributed to an arbitrary user via auth.users LIMIT 1).
    INSERT INTO public.journal_entries (
      entry_number,
      entry_date,
      period_id,
      source_module,
      reference_id,
      reference_number,
      description,
      is_posted,
      is_reversed,
      is_cancelled,
      total_debit,
      total_credit,
      created_by,
      posted_by,
      posted_at
    ) VALUES (
      'JE2611-0493',
      '2026-10-31'::date,
      v_period_id,
      'salary_advance_settlement',
      '8a045a25-e2b4-4f7b-8a27-4312d86a547e'::uuid,
      'EXP/26/365-ADV-028',
      'Non-cash salary advance deduction - Sandi Prasetyo (PV/26-26/028 applied against October salary EXP/26/365)',
      true,
      false,
      false,
      100000.00,
      100000.00,
      NULL,
      NULL,
      now()
    ) RETURNING id INTO v_new_je_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      account_id,
      debit,
      credit,
      line_number,
      description
    ) VALUES 
    (v_new_je_id, v_acc_2110, 100000.00, 0.00, 1, 'Clear October Salary Payable - EXP/26/365 (PV/26-26/028 deduction)'),
    (v_new_je_id, v_acc_1160, 0.00, 100000.00, 2, 'Clear Staff Advance - Sandi Prasetyo (PV/26-26/028)');
  END IF;

  -- Update PV/26-26/028 metadata to settled
  UPDATE public.payment_vouchers
  SET
    salary_advance_applied_amount = 100000.00,
    salary_advance_status = 'settled',
    updated_at = now()
  WHERE id = '8a045a25-e2b4-4f7b-8a27-4312d86a547e'
    AND voucher_number = 'PV/26-26/028';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected PV/26-26/028 (8a045a25-e2b4-4f7b-8a27-4312d86a547e) to be updated.';
  END IF;
END;
$$;

-- ============================================================================
-- 8. APPLY SANDI GROUP D CANCELLATIONS (JULY SALARY ADVANCE DOUBLE-POSTINGS)
-- ============================================================================

-- Pair 1: Salary misclassification for EXP/093
SELECT public.cancel_journal_entry_group(
  (SELECT array_agg(id) FROM public.journal_entries WHERE entry_number IN ('JE2607-0069', 'HFR-260826-SAR-093')),
  'Historical salary misclassification superseded by canonical staff-advance recognition journal HFR-260826-SAA-093.',
  NULL,
  'EXP/26-26/093',
  (SELECT id FROM public.journal_entries WHERE entry_number = 'HFR-260826-SAA-093')
);

-- Pair 2: Salary misclassification for EXP/102
SELECT public.cancel_journal_entry_group(
  (SELECT array_agg(id) FROM public.journal_entries WHERE entry_number IN ('JE2607-0092', 'HFR-260826-SAR-102')),
  'Historical salary misclassification superseded by canonical staff-advance recognition journal HFR-260826-SAA-102.',
  NULL,
  'EXP/26-26/102',
  (SELECT id FROM public.journal_entries WHERE entry_number = 'HFR-260826-SAA-102')
);

-- Duplicate PV journals
SELECT public.cancel_journal_entry_group(
  (SELECT array_agg(id) FROM public.journal_entries WHERE entry_number = 'JE2609-0003'),
  'Duplicate salary advance posting. The actual bank disbursement is already recorded and matched to canonical staff-advance journal HFR-260826-SAA-093. The separate voucher journal creates a second credit against Staff Advances.',
  NULL,
  'PV/26-26/012',
  (SELECT id FROM public.journal_entries WHERE entry_number = 'HFR-260826-SAA-093')
);

SELECT public.cancel_journal_entry_group(
  (SELECT array_agg(id) FROM public.journal_entries WHERE entry_number = 'JE2609-0004'),
  'Duplicate salary advance posting. The actual bank disbursement is already recorded and matched to canonical staff-advance journal HFR-260826-SAA-102. The separate voucher journal creates a second credit against Staff Advances.',
  NULL,
  'PV/26-26/013',
  (SELECT id FROM public.journal_entries WHERE entry_number = 'HFR-260826-SAA-102')
);

-- ============================================================================
-- 9. PETTY CASH RECONCILIATION: LINK CASH PAYMENT VOUCHERS PV/017 & PV/018
-- ============================================================================

DO $$
DECLARE
  v_pc_count int;
  v_pv_count int;
BEGIN
  -- PV/26-26/017: verify if exists, otherwise insert
  SELECT count(*) INTO v_pc_count
  FROM public.petty_cash_transactions
  WHERE voucher_number = 'PV/26-26/017';

  IF v_pc_count > 1 THEN
    RAISE EXCEPTION 'Petty cash safeguard failed: multiple rows exist for PV/26-26/017 (%).', v_pc_count;
  ELSIF v_pc_count = 1 THEN
    PERFORM 1
    FROM public.petty_cash_transactions
    WHERE voucher_number = 'PV/26-26/017'
      AND payment_voucher_id = 'a387e532-3219-41ef-be03-93ab8dd01f53'::uuid
      AND amount = 500.00
      AND petty_cash_book_id = 'f974b5c5-b399-44e6-bfe9-2d8e78d2b7d8'::uuid
      AND approval_status = 'approved';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Petty cash safeguard failed: existing PV/26-26/017 record does not match expected voucher, amount, book, or approval_status.';
    END IF;
  ELSE
    INSERT INTO public.petty_cash_transactions (
      transaction_number,
      transaction_date,
      transaction_type,
      amount,
      description,
      paid_by,
      voucher_number,
      payment_voucher_id,
      petty_cash_book_id,
      approval_status,
      approved_at,
      created_at,
      updated_at
    ) VALUES (
      'PC-202609-060',
      '2026-09-14 00:00:00+07',
      'expense',
      500.00,
      'PT. TRANS EXIS JAYA 003/OR/SAPJ/V/2026 (PV/26-26/017)',
      'cash',
      'PV/26-26/017',
      'a387e532-3219-41ef-be03-93ab8dd01f53'::uuid,
      'f974b5c5-b399-44e6-bfe9-2d8e78d2b7d8'::uuid,
      'approved',
      '2026-09-14 08:31:14+00',
      '2026-09-14 08:29:02+00',
      now()
    );
  END IF;

  -- PV/26-26/018: verify if exists, otherwise insert
  SELECT count(*) INTO v_pc_count
  FROM public.petty_cash_transactions
  WHERE voucher_number = 'PV/26-26/018';

  IF v_pc_count > 1 THEN
    RAISE EXCEPTION 'Petty cash safeguard failed: multiple rows exist for PV/26-26/018 (%).', v_pc_count;
  ELSIF v_pc_count = 1 THEN
    PERFORM 1
    FROM public.petty_cash_transactions
    WHERE voucher_number = 'PV/26-26/018'
      AND payment_voucher_id = '4bb2e02d-6423-4ccb-bee3-a6e355e3c8bf'::uuid
      AND amount = 499500.00
      AND petty_cash_book_id = 'f974b5c5-b399-44e6-bfe9-2d8e78d2b7d8'::uuid
      AND approval_status = 'approved';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Petty cash safeguard failed: existing PV/26-26/018 record does not match expected voucher, amount, book, or approval_status.';
    END IF;
  ELSE
    INSERT INTO public.petty_cash_transactions (
      transaction_number,
      transaction_date,
      transaction_type,
      amount,
      description,
      paid_by,
      voucher_number,
      payment_voucher_id,
      petty_cash_book_id,
      approval_status,
      approved_at,
      created_at,
      updated_at
    ) VALUES (
      'PC-202609-061',
      '2026-09-14 00:00:00+07',
      'expense',
      499500.00,
      'PT. FREIGHT LINER INDONESIA JAKARTA Customs Broker Invoice FLJKT.31.001604-00 (PV/26-26/018)',
      'cash',
      'PV/26-26/018',
      '4bb2e02d-6423-4ccb-bee3-a6e355e3c8bf'::uuid,
      'f974b5c5-b399-44e6-bfe9-2d8e78d2b7d8'::uuid,
      'approved',
      '2026-09-14 08:33:20+00',
      '2026-09-14 08:33:20+00',
      now()
    );
  END IF;

  -- Ensure petty_cash_book_id is linked on PV/017 and PV/018 (exact 2 rows)
  UPDATE public.payment_vouchers
  SET petty_cash_book_id = 'f974b5c5-b399-44e6-bfe9-2d8e78d2b7d8'::uuid
  WHERE id IN ('a387e532-3219-41ef-be03-93ab8dd01f53', '4bb2e02d-6423-4ccb-bee3-a6e355e3c8bf')
    AND petty_cash_book_id IS NULL;

  SELECT count(*) INTO v_pv_count
  FROM public.payment_vouchers
  WHERE id IN ('a387e532-3219-41ef-be03-93ab8dd01f53', '4bb2e02d-6423-4ccb-bee3-a6e355e3c8bf')
    AND petty_cash_book_id = 'f974b5c5-b399-44e6-bfe9-2d8e78d2b7d8'::uuid;

  IF v_pv_count <> 2 THEN
    RAISE EXCEPTION 'Petty cash safeguard failed: expected 2 payment vouchers linked to petty_cash_book_id, found %.', v_pv_count;
  END IF;
END;
$$;

-- ============================================================================
-- 10. MIGRATION POSTCONDITIONS (VERIFY CANCELLATIONS & REPLACEMENTS)
-- ============================================================================

DO $$
DECLARE
  v_cancelled_count int;
  v_group_count int;
  v_active_replacements int;
  v_je0493_count int;
  v_je0493_id uuid;
  v_oct_period_id uuid;
  v_je0493_line_count int;
  v_je0493_2110_dr numeric;
  v_je0493_1160_cr numeric;
BEGIN
  SELECT count(*), count(DISTINCT cancellation_group_id)
  INTO v_cancelled_count, v_group_count
  FROM public.journal_entries
  WHERE entry_number IN (
    'JE2611-0459', 'REV-FT2611-0002',
    'JE2611-0363', 'JE2611-0457',
    'JE2607-0069', 'HFR-260826-SAR-093',
    'JE2607-0092', 'HFR-260826-SAR-102',
    'JE2609-0003', 'JE2609-0004'
  )
    AND is_cancelled = true
    AND cancellation_group_id IS NOT NULL;

  IF v_cancelled_count <> 10 THEN
    RAISE EXCEPTION 'Postcondition failed: expected 10 cancelled journals, found %.', v_cancelled_count;
  END IF;

  IF v_group_count <> 6 THEN
    RAISE EXCEPTION 'Postcondition failed: expected 6 distinct cancellation_group_id values, found %.', v_group_count;
  END IF;

  SELECT count(*)
  INTO v_active_replacements
  FROM public.journal_entries
  WHERE entry_number IN ('JE2611-0458', 'HFR-260826-SAA-093', 'HFR-260826-SAA-102')
    AND is_posted = true
    AND NOT COALESCE(is_reversed, false)
    AND NOT COALESCE(is_cancelled, false);

  IF v_active_replacements <> 3 THEN
    RAISE EXCEPTION 'Postcondition failed: expected 3 active replacement journals, found %.', v_active_replacements;
  END IF;

  -- Verify JE2611-0493 exists exactly once with expected period, date, status, totals, and 2110/1160 lines
  SELECT id INTO v_oct_period_id
  FROM public.accounting_periods
  WHERE start_date <= '2026-10-31'::date
    AND end_date >= '2026-10-31'::date;

  SELECT count(*) INTO v_je0493_count
  FROM public.journal_entries
  WHERE entry_number = 'JE2611-0493';

  IF v_je0493_count <> 1 THEN
    RAISE EXCEPTION 'Postcondition failed: JE2611-0493 expected exactly 1 row, found %.', v_je0493_count;
  END IF;

  SELECT id INTO v_je0493_id
  FROM public.journal_entries
  WHERE entry_number = 'JE2611-0493'
    AND period_id = v_oct_period_id
    AND entry_date::date = '2026-10-31'::date
    AND source_module = 'salary_advance_settlement'
    AND reference_id = '8a045a25-e2b4-4f7b-8a27-4312d86a547e'::uuid
    AND is_posted = true
    AND COALESCE(is_reversed, false) = false
    AND COALESCE(is_cancelled, false) = false
    AND total_debit = 100000.00
    AND total_credit = 100000.00
    AND created_by IS NULL
    AND posted_by IS NULL;

  IF v_je0493_id IS NULL THEN
    RAISE EXCEPTION 'Postcondition failed: JE2611-0493 header attributes (period_id, date, status, totals, or attribution) do not match expected values.';
  END IF;

  SELECT
    count(*),
    COALESCE(SUM(CASE WHEN coa.code = '2110' AND jel.credit = 0 THEN jel.debit ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN coa.code = '1160' AND jel.debit = 0 THEN jel.credit ELSE 0 END), 0)
  INTO v_je0493_line_count, v_je0493_2110_dr, v_je0493_1160_cr
  FROM public.journal_entry_lines jel
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE jel.journal_entry_id = v_je0493_id;

  IF v_je0493_line_count <> 2 OR v_je0493_2110_dr <> 100000.00 OR v_je0493_1160_cr <> 100000.00 THEN
    RAISE EXCEPTION 'Postcondition failed: JE2611-0493 lines invalid (count %, 2110 Dr %, 1160 Cr %).',
      v_je0493_line_count, v_je0493_2110_dr, v_je0493_1160_cr;
  END IF;
END;
$$;

COMMIT;
