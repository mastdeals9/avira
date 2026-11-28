-- ============================================================================
-- ANZEN ERP — SALES PROFITABILITY REPORT CLOSURE
-- Replacement for the not-yet-applied 20261128120000 migration.
--
-- Scope: reporting functions only. No journal, invoice, credit-note, batch,
-- inventory, landed-cost, or historical snapshot data is inserted/updated.
--
-- Cutoff behavior is caller-controlled through p_start_date / p_end_date.
-- Historical posted invoice COGS uses saved line snapshots first. Current batch
-- cost is permitted only as a candidate allocation basis when the complete
-- invoice candidate total reconciles to active posted COGS within Rp1.00.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Historical sales-line COGS resolver
--    Keep the production signature and active journal source filters, but do
--    not prefer today's batch cost over saved posting-time invoice snapshots.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_authoritative_sales_line_cogs(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
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
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
WITH active_cogs AS (
  SELECT je.reference_id AS invoice_id,
         je.id AS journal_id,
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
  FROM active_cogs
  GROUP BY invoice_id
), posted_item_cogs AS (
  SELECT jel.sales_invoice_item_id AS line_id,
         SUM(jel.debit - jel.credit) AS posted_item_cogs
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND NOT COALESCE(je.is_cancelled, false)
    AND coa.code = '5100'
    AND jel.sales_invoice_item_id IS NOT NULL
    AND (
      je.source_module IN ('sales_invoice_cogs', 'sales_invoice_cogs_adjustment')
      OR je.source_module IN ('historical_cogs_correction', 'historical_cogs_final_correction')
      OR je.source_module LIKE 'historical_cogs%'
      OR je.source_module LIKE '%cogs%'
    )
  GROUP BY jel.sales_invoice_item_id
), line_basis AS (
  SELECT sii.id AS line_id,
         sii.invoice_id,
         sii.product_id,
         sii.batch_id,
         sii.quantity,
         CASE
           WHEN sii.cogs_total_cost IS NOT NULL THEN sii.cogs_total_cost
           WHEN sii.cogs_unit_cost IS NOT NULL THEN ROUND(sii.quantity * sii.cogs_unit_cost, 2)
           ELSE NULL
         END AS snapshot_cogs,
         pic.posted_item_cogs,
         CASE
           WHEN sii.cogs_total_cost IS NULL
             AND sii.cogs_unit_cost IS NULL
             AND pic.posted_item_cogs IS NULL
             AND b.id IS NOT NULL
             THEN ROUND(sii.quantity * public.calculate_batch_authoritative_cost(b), 2)
           ELSE NULL
         END AS base_line_cost,
         pc.posted_invoice_cogs
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.batches b ON b.id = sii.batch_id
  LEFT JOIN posted_cogs pc ON pc.invoice_id = sii.invoice_id
  LEFT JOIN posted_item_cogs pic ON pic.line_id = sii.id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
), line_candidates AS (
  SELECT lb.*,
         CASE
           WHEN lb.snapshot_cogs IS NOT NULL THEN lb.snapshot_cogs
           WHEN lb.posted_item_cogs IS NOT NULL THEN lb.posted_item_cogs
           WHEN lb.base_line_cost IS NOT NULL THEN lb.base_line_cost
           ELSE NULL
         END AS candidate_line_cogs
  FROM line_basis lb
), invoice_evidence AS (
  SELECT invoice_id,
         COUNT(*) AS invoice_line_count,
         COUNT(DISTINCT product_id) AS invoice_product_count,
         MAX(posted_invoice_cogs) AS posted_invoice_cogs,
         SUM(candidate_line_cogs) AS candidate_invoice_cogs,
         COUNT(*) FILTER (WHERE candidate_line_cogs IS NULL) AS candidate_missing_lines
  FROM line_candidates
  GROUP BY invoice_id
), candidates AS (
  SELECT lb.*,
         ie.invoice_line_count,
         ie.invoice_product_count,
         ie.candidate_invoice_cogs,
         ie.candidate_missing_lines,
         ie.posted_invoice_cogs AS invoice_posted_cogs,
         CASE
           WHEN lb.snapshot_cogs IS NOT NULL THEN lb.snapshot_cogs
           WHEN lb.posted_item_cogs IS NOT NULL THEN lb.posted_item_cogs
           WHEN ie.invoice_line_count = 1 AND ie.posted_invoice_cogs IS NOT NULL
             THEN ie.posted_invoice_cogs
           ELSE lb.base_line_cost
         END AS candidate_line_cogs
  FROM line_candidates lb
  JOIN invoice_evidence ie ON ie.invoice_id = lb.invoice_id
), resolved AS (
  SELECT c.*,
         CASE
           -- Immutable posting-time invoice-line snapshot always wins.
           WHEN c.snapshot_cogs IS NOT NULL THEN c.snapshot_cogs
           -- Then an exact posted journal allocation to this invoice line.
           WHEN c.posted_item_cogs IS NOT NULL THEN c.posted_item_cogs
           -- A single-line invoice can safely inherit its posted invoice COGS.
           WHEN c.invoice_line_count = 1 AND c.invoice_posted_cogs IS NOT NULL
             THEN c.invoice_posted_cogs
           -- Batch cost is only an allocation basis, never a direct replacement.
           WHEN c.base_line_cost IS NOT NULL
             AND c.invoice_posted_cogs IS NOT NULL
             AND c.candidate_missing_lines = 0
             AND ABS(c.candidate_invoice_cogs - c.invoice_posted_cogs) <= 1.00
             THEN c.base_line_cost
           ELSE NULL
         END AS authoritative_cogs
  FROM candidates c
), resolved_rollup AS (
  SELECT r.*,
         SUM(r.authoritative_cogs) OVER (PARTITION BY r.invoice_id) AS invoice_authoritative_total,
         COUNT(*) FILTER (WHERE r.authoritative_cogs IS NULL)
           OVER (PARTITION BY r.invoice_id) AS invoice_unresolved_lines,
         SUM(r.posted_item_cogs) OVER (PARTITION BY r.invoice_id) AS invoice_item_cogs_sum,
         COUNT(*) FILTER (WHERE r.posted_item_cogs IS NULL)
           OVER (PARTITION BY r.invoice_id) AS invoice_missing_item_cogs_lines
  FROM resolved r
)
SELECT r.line_id,
       r.invoice_id,
       r.product_id,
       r.batch_id,
       r.quantity,
       r.authoritative_cogs,
       CASE WHEN r.quantity = 0 THEN NULL
            WHEN r.authoritative_cogs IS NOT NULL THEN r.authoritative_cogs / r.quantity
            ELSE NULL END AS authoritative_unit_cogs,
       CASE
         WHEN r.snapshot_cogs IS NOT NULL THEN 'snapshot'
         WHEN r.posted_item_cogs IS NOT NULL THEN 'posted_item_cogs'
         WHEN r.invoice_line_count = 1 AND r.invoice_posted_cogs IS NOT NULL
           THEN 'single_line_posted_cogs'
         WHEN r.authoritative_cogs IS NOT NULL AND r.base_line_cost IS NOT NULL
           THEN 'proven_batch_allocation'
         ELSE 'unresolved'
       END AS resolution_tier,
       r.invoice_line_count,
       r.invoice_product_count,
       r.invoice_posted_cogs,
       r.base_line_cost,
       CASE
         WHEN r.invoice_posted_cogs IS NULL OR r.invoice_unresolved_lines > 0 THEN NULL
         WHEN r.invoice_missing_item_cogs_lines = 0
              AND ABS(r.invoice_item_cogs_sum - r.invoice_posted_cogs) <= 0.05
           THEN ABS(r.authoritative_cogs - r.posted_item_cogs)
         ELSE ABS(r.invoice_authoritative_total - r.invoice_posted_cogs)
       END AS reconciliation_difference
FROM resolved_rollup r;
$function$;

COMMENT ON FUNCTION public.get_authoritative_sales_line_cogs(date, date) IS
  'Historical COGS waterfall: saved invoice-line snapshot, exact posted item COGS, single-line posted invoice COGS, then batch-evidence allocation only when the full invoice candidate total reconciles to active posted GL 5100 within Rp1.00. Current batch cost never overrides a saved snapshot.';

-- ---------------------------------------------------------------------------
-- 2. Credit-note return COGS resolver
--    Use the actual production FK sales_invoice_item_id. If absent, permit a
--    batch match only when all matching original invoice lines have the same
--    saved unit COGS. Never substitute today's batch landed cost.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_credit_note_item_fifo_cogs(p_cni_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cni record;
  v_cn record;
  v_original_invoice_id uuid;
  v_unit_cogs numeric;
  v_min_unit_cogs numeric;
  v_max_unit_cogs numeric;
  v_distinct_unit_cogs bigint;
BEGIN
  SELECT * INTO v_cni
  FROM public.credit_note_items
  WHERE id = p_cni_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_cn
  FROM public.credit_notes
  WHERE id = v_cni.credit_note_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF COALESCE(v_cn.credit_note_type, 'physical_return') = 'commercial_credit' THEN
    RETURN 0;
  END IF;

  -- Exact original invoice-line link, when present.
  IF v_cni.sales_invoice_item_id IS NOT NULL THEN
    SELECT CASE
             WHEN sii.cogs_unit_cost IS NOT NULL AND sii.cogs_unit_cost > 0 THEN sii.cogs_unit_cost
             WHEN sii.cogs_total_cost IS NOT NULL AND sii.quantity <> 0
               THEN sii.cogs_total_cost / sii.quantity
             ELSE NULL
           END
      INTO v_unit_cogs
    FROM public.sales_invoice_items sii
    WHERE sii.id = v_cni.sales_invoice_item_id
      AND sii.product_id = v_cni.product_id
      AND (v_cni.batch_id IS NULL OR sii.batch_id = v_cni.batch_id);

    IF v_unit_cogs IS NULL THEN
      SELECT SUM(jel.debit - jel.credit) / NULLIF(sii.quantity, 0)
        INTO v_unit_cogs
      FROM public.sales_invoice_items sii
      JOIN public.journal_entry_lines jel ON jel.sales_invoice_item_id = sii.id
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE sii.id = v_cni.sales_invoice_item_id
        AND coa.code = '5100'
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false)
        AND NOT COALESCE(je.is_cancelled, false)
        AND je.source_module LIKE '%cogs%';
    END IF;

    IF v_unit_cogs IS NOT NULL THEN
      RETURN ROUND(v_cni.quantity * v_unit_cogs, 2);
    END IF;
  END IF;

  -- Resolve original invoice from the credit note or its material return.
  v_original_invoice_id := v_cn.original_invoice_id;
  IF v_original_invoice_id IS NULL AND v_cn.material_return_id IS NOT NULL THEN
    SELECT mr.original_invoice_id
      INTO v_original_invoice_id
    FROM public.material_returns mr
    WHERE mr.id = v_cn.material_return_id;
  END IF;

  -- Legacy notes may have no item FK. A batch match is accepted only if all
  -- matching original invoice lines carry one identical saved unit COGS.
  IF v_original_invoice_id IS NOT NULL THEN
    SELECT COUNT(DISTINCT ROUND(unit_cost, 4)),
           MIN(ROUND(unit_cost, 4)),
           MAX(ROUND(unit_cost, 4))
      INTO v_distinct_unit_cogs, v_min_unit_cogs, v_max_unit_cogs
    FROM (
      SELECT CASE
               WHEN sii.cogs_unit_cost IS NOT NULL AND sii.cogs_unit_cost > 0 THEN sii.cogs_unit_cost
               WHEN sii.cogs_total_cost IS NOT NULL AND sii.quantity <> 0
                 THEN sii.cogs_total_cost / sii.quantity
               ELSE NULL
             END AS unit_cost
      FROM public.sales_invoice_items sii
      WHERE sii.invoice_id = v_original_invoice_id
        AND sii.product_id = v_cni.product_id
        AND (
          (v_cni.batch_id IS NOT NULL AND sii.batch_id = v_cni.batch_id)
          OR (v_cni.batch_id IS NULL)
        )
    ) candidates
    WHERE unit_cost IS NOT NULL;

    IF v_distinct_unit_cogs = 1 THEN
      RETURN ROUND(v_cni.quantity * v_min_unit_cogs, 2);
    END IF;
  END IF;

  -- Last historical evidence source: original material-return issue cost.
  -- Multiple differing issue costs are ambiguous and therefore unresolved.
  IF v_cn.material_return_id IS NOT NULL THEN
    SELECT COUNT(DISTINCT ROUND(it.unit_cost, 4)),
           MIN(ROUND(it.unit_cost, 4)),
           MAX(ROUND(it.unit_cost, 4))
      INTO v_distinct_unit_cogs, v_min_unit_cogs, v_max_unit_cogs
    FROM public.material_returns mr
    JOIN public.inventory_transactions it ON it.source_id = mr.original_dc_id
    WHERE mr.id = v_cn.material_return_id
      AND it.unit_cost IS NOT NULL
      AND it.product_id = v_cni.product_id
      AND (v_cni.batch_id IS NULL OR it.batch_id = v_cni.batch_id);

    IF v_distinct_unit_cogs = 1 THEN
      RETURN ROUND(v_cni.quantity * v_min_unit_cogs, 2);
    END IF;
  END IF;

  -- NULL is intentional: unresolved historical COGS must not become zero or
  -- today's batch cost. The report will block certification until resolved.
  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.get_credit_note_item_fifo_cogs(uuid) IS
  'Resolves physical-return COGS from exact original invoice-line snapshots or unambiguous original transaction evidence. Never falls back to current batch landed cost; NULL means unresolved.';

-- ---------------------------------------------------------------------------
-- 3. Canonical company/product/month summary
--    Returns are dated by credit_note_date. Return-only products are retained.
--    Commercial credits reduce revenue only. Physical returns reduce qty/COGS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sales_profitability_summary(
  p_start_date date,
  p_end_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.role() <> 'service_role'
     AND current_user <> 'service_role'
     AND session_user <> 'postgres'
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.user_profiles
      WHERE id = auth.uid()
        AND is_active = true
        AND role IN ('admin', 'accounts', 'auditor_ca', 'manager')
    ) THEN
      RAISE EXCEPTION 'Permission denied: unauthorized to access sales profitability reports';
    END IF;
  END IF;

  WITH lines AS (
    SELECT ar.*,
           si.invoice_date,
           si.invoice_number,
           si.customer_id,
           COALESCE(c.company_name, 'Unknown Customer') AS customer_name,
           si.sales_order_id,
           so.so_number,
           sii.unit_price,
           ROUND(sii.quantity * sii.unit_price, 2) AS line_gross_sales,
           p.product_name,
           COALESCE(p.product_code, '') AS product_code,
           COALESCE(p.unit, 'kg') AS product_unit,
           b.batch_number,
           COALESCE(le.sales_expense, 0) AS line_sales_expense,
           dci.challan_id AS dc_id,
           dc.challan_number AS dc_number
    FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
    JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
    JOIN public.sales_invoices si ON si.id = ar.invoice_id
    JOIN public.products p ON p.id = ar.product_id
    LEFT JOIN public.customers c ON c.id = si.customer_id
    LEFT JOIN public.sales_orders so ON so.id = si.sales_order_id
    LEFT JOIN public.batches b ON b.id = ar.batch_id
    LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
    LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
    LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date, p_end_date) le
      ON le.line_id = ar.line_id
    WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  ),
  cn_headers AS (
    SELECT cn.id,
           cn.credit_note_date,
           cn.credit_note_number,
           COALESCE(cn.credit_note_type, 'physical_return') AS credit_note_type,
           COALESCE(cn.subtotal, 0) AS subtotal,
           cn.original_invoice_id,
           cn.customer_id
    FROM public.credit_notes cn
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
  ),
  cn_items AS (
    SELECT ch.id AS credit_note_id,
           ch.credit_note_date,
           ch.credit_note_number,
           ch.credit_note_type,
           cni.id AS credit_note_item_id,
           cni.product_id,
           cni.batch_id,
           COALESCE(cni.quantity, 0) AS quantity,
           COALESCE(cni.total_price, 0) AS return_revenue,
           CASE WHEN ch.credit_note_type = 'commercial_credit' THEN 0::numeric
                ELSE COALESCE(cni.quantity, 0) END AS return_qty,
           CASE WHEN ch.credit_note_type = 'commercial_credit' THEN 0::numeric
                ELSE public.get_credit_note_item_fifo_cogs(cni.id) END AS return_cogs
    FROM cn_headers ch
    JOIN public.credit_note_items cni ON cni.credit_note_id = ch.id
  ),
  cn_item_totals AS (
    SELECT credit_note_id,
           SUM(return_revenue) AS item_return_revenue,
           SUM(return_qty) AS return_qty,
           SUM(COALESCE(return_cogs, 0)) AS resolved_return_cogs,
           COUNT(*) FILTER (
             WHERE credit_note_type <> 'commercial_credit' AND return_cogs IS NULL
           ) AS unresolved_return_cogs_count
    FROM cn_items
    GROUP BY credit_note_id
  ),
  cn_gl AS (
    SELECT ch.id AS credit_note_id,
           COALESCE((
             SELECT SUM(jel.credit - jel.debit)
             FROM public.journal_entries je
             JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
             JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
             WHERE je.reference_id = ch.id
               AND je.source_module = 'credit_note_cogs'
               AND je.is_posted = true
               AND NOT COALESCE(je.is_reversed, false)
               AND NOT COALESCE(je.is_cancelled, false)
               AND coa.code = '5100'
           ), 0) AS posted_return_cogs
    FROM cn_headers ch
    WHERE ch.credit_note_type <> 'commercial_credit'
  ),
  cn_quality AS (
    SELECT ch.id,
           ch.credit_note_date,
           ch.credit_note_type,
           ch.subtotal,
           COALESCE(it.item_return_revenue, 0) AS item_return_revenue,
           COALESCE(it.return_qty, 0) AS return_qty,
           COALESCE(it.resolved_return_cogs, 0) AS resolved_return_cogs,
           COALESCE(it.unresolved_return_cogs_count, 0) AS unresolved_return_cogs_count,
           COALESCE(gl.posted_return_cogs, 0) AS posted_return_cogs,
           (it.credit_note_id IS NULL OR ABS(ch.subtotal - COALESCE(it.item_return_revenue, 0)) > 0.01)
             AS item_subtotal_mismatch
    FROM cn_headers ch
    LEFT JOIN cn_item_totals it ON it.credit_note_id = ch.id
    LEFT JOIN cn_gl gl ON gl.credit_note_id = ch.id
  ),
  returns AS (
    SELECT COALESCE(SUM(subtotal), 0) AS total_return_revenue,
           COALESCE(SUM(return_qty), 0) AS total_return_qty,
           COALESCE(SUM(posted_return_cogs), 0) AS total_return_cogs,
           COALESCE(SUM(resolved_return_cogs), 0) AS resolved_item_return_cogs,
           COALESCE(SUM(unresolved_return_cogs_count), 0)::int AS unresolved_return_cogs_count,
           COUNT(*) FILTER (WHERE item_subtotal_mismatch)::int AS item_subtotal_mismatch_count,
           COUNT(*) FILTER (
             WHERE credit_note_type <> 'commercial_credit'
               AND ABS(posted_return_cogs - resolved_return_cogs) > 0.05
           )::int AS return_cogs_allocation_mismatch_count
    FROM cn_quality
  ),
  prod_returns AS (
    SELECT product_id,
           COALESCE(SUM(return_revenue), 0) AS return_revenue,
           COALESCE(SUM(return_qty), 0) AS return_qty,
           COALESCE(SUM(CASE WHEN return_cogs IS NULL THEN 0 ELSE return_cogs END), 0) AS return_cogs,
           COUNT(*) FILTER (
             WHERE credit_note_type <> 'commercial_credit' AND return_cogs IS NULL
           ) AS unresolved_return_cogs_count
    FROM cn_items
    GROUP BY product_id
  ),
  product_keys AS (
    SELECT product_id FROM lines
    UNION
    SELECT product_id FROM cn_items
  ),
  product_sales AS (
    SELECT l.product_id,
           MAX(l.product_name) AS product_name,
           MAX(l.product_code) AS product_code,
           MAX(l.product_unit) AS product_unit,
           SUM(l.quantity) AS sold_qty,
           SUM(l.line_gross_sales) AS gross_sales,
           SUM(l.authoritative_cogs) AS product_cost,
           SUM(l.line_gross_sales) FILTER (WHERE l.authoritative_cogs IS NOT NULL) AS costed_revenue,
           SUM(l.line_sales_expense) AS sales_expenses,
           COUNT(l.authoritative_cogs) AS costed_lines,
           COUNT(*) AS total_lines,
           COUNT(*) FILTER (WHERE l.authoritative_cogs IS NULL) AS unresolved_sales_cogs_count,
           COUNT(DISTINCT l.invoice_id) AS order_count
    FROM lines l
    GROUP BY l.product_id
  ),
  products_report AS (
    SELECT pk.product_id,
           COALESCE(ps.product_name, p.product_name, 'Unknown Product') AS product_name,
           COALESCE(ps.product_code, p.product_code, '') AS product_code,
           COALESCE(ps.product_unit, p.unit, 'kg') AS product_unit,
           COALESCE(ps.sold_qty, 0) - COALESCE(pr.return_qty, 0) AS total_qty_sold,
           COALESCE(ps.gross_sales, 0) - COALESCE(pr.return_revenue, 0) AS total_revenue,
           COALESCE(ps.costed_revenue, 0) - COALESCE(pr.return_revenue, 0) AS costed_revenue,
           CASE
             WHEN COALESCE(ps.unresolved_sales_cogs_count, 0) > 0
               OR COALESCE(pr.unresolved_return_cogs_count, 0) > 0 THEN NULL
             ELSE COALESCE(ps.product_cost, 0) - COALESCE(pr.return_cogs, 0)
           END AS total_cogs,
           CASE
             WHEN COALESCE(ps.unresolved_sales_cogs_count, 0) > 0
               OR COALESCE(pr.unresolved_return_cogs_count, 0) > 0 THEN NULL
             ELSE (COALESCE(ps.gross_sales, 0) - COALESCE(pr.return_revenue, 0))
                  - (COALESCE(ps.product_cost, 0) - COALESCE(pr.return_cogs, 0))
           END AS gross_profit,
           COALESCE(ps.sales_expenses, 0) AS total_sales_expenses,
           CASE
             WHEN COALESCE(ps.unresolved_sales_cogs_count, 0) > 0
               OR COALESCE(pr.unresolved_return_cogs_count, 0) > 0 THEN NULL
             ELSE (COALESCE(ps.gross_sales, 0) - COALESCE(pr.return_revenue, 0))
                  - (COALESCE(ps.product_cost, 0) - COALESCE(pr.return_cogs, 0))
                  - COALESCE(ps.sales_expenses, 0)
           END AS profit_after_sales_expenses,
           COALESCE(ps.costed_lines, 0) AS costed_lines,
           COALESCE(ps.total_lines, 0) AS total_lines,
           COALESCE(ps.order_count, 0) AS order_count,
           COALESCE(pr.return_revenue, 0) AS return_revenue,
           COALESCE(pr.return_qty, 0) AS return_qty,
           COALESCE(pr.return_cogs, 0) AS resolved_return_cogs,
           COALESCE(pr.unresolved_return_cogs_count, 0) AS unresolved_return_cogs_count,
           (COALESCE(ps.unresolved_sales_cogs_count, 0) > 0
             OR COALESCE(pr.unresolved_return_cogs_count, 0) > 0) AS has_unreported_cost,
           CASE
             WHEN COALESCE(ps.unresolved_sales_cogs_count, 0) > 0
               OR COALESCE(pr.unresolved_return_cogs_count, 0) > 0 THEN NULL
             ELSE ROUND(
               (COALESCE(ps.product_cost, 0) - COALESCE(pr.return_cogs, 0))
               / NULLIF(COALESCE(ps.sold_qty, 0) - COALESCE(pr.return_qty, 0), 0), 2
             )
           END AS avg_landed_cost,
           ROUND(
             (COALESCE(ps.gross_sales, 0) - COALESCE(pr.return_revenue, 0))
             / NULLIF(COALESCE(ps.sold_qty, 0) - COALESCE(pr.return_qty, 0), 0), 2
           ) AS avg_selling_price,
           ROUND(
             COALESCE(ps.sales_expenses, 0)
             / NULLIF(COALESCE(ps.sold_qty, 0) - COALESCE(pr.return_qty, 0), 0), 2
           ) AS sales_expense_per_unit,
           ROUND(
             ((COALESCE(ps.gross_sales, 0) - COALESCE(pr.return_revenue, 0)) - COALESCE(ps.sales_expenses, 0))
             / NULLIF(COALESCE(ps.sold_qty, 0) - COALESCE(pr.return_qty, 0), 0), 2
           ) AS net_selling_price_per_unit,
           CASE
             WHEN COALESCE(ps.unresolved_sales_cogs_count, 0) > 0
               OR COALESCE(pr.unresolved_return_cogs_count, 0) > 0 THEN NULL
             ELSE ROUND(
               ((COALESCE(ps.gross_sales, 0) - COALESCE(pr.return_revenue, 0))
                - (COALESCE(ps.product_cost, 0) - COALESCE(pr.return_cogs, 0))
                - COALESCE(ps.sales_expenses, 0))
               / NULLIF(COALESCE(ps.sold_qty, 0) - COALESCE(pr.return_qty, 0), 0), 2
             )
           END AS profit_per_unit,
           CASE
             WHEN COALESCE(ps.unresolved_sales_cogs_count, 0) > 0
               OR COALESCE(pr.unresolved_return_cogs_count, 0) > 0 THEN NULL
             WHEN (COALESCE(ps.gross_sales, 0) - COALESCE(pr.return_revenue, 0)) = 0 THEN NULL
             ELSE ROUND(
               (
                 (COALESCE(ps.gross_sales, 0) - COALESCE(pr.return_revenue, 0))
                 - (COALESCE(ps.product_cost, 0) - COALESCE(pr.return_cogs, 0))
                 - COALESCE(ps.sales_expenses, 0)
               )
               / (COALESCE(ps.gross_sales, 0) - COALESCE(pr.return_revenue, 0)) * 100, 2
             )
           END AS profit_margin_pct
    FROM product_keys pk
    JOIN public.products p ON p.id = pk.product_id
    LEFT JOIN product_sales ps ON ps.product_id = pk.product_id
    LEFT JOIN prod_returns pr ON pr.product_id = pk.product_id
  ),
  cancelled_headers AS (
    SELECT id,
           COALESCE(total_amount, 0) AS total_amount,
           COALESCE(subtotal, 0) AS subtotal
    FROM public.sales_invoices
    WHERE invoice_date BETWEEN p_start_date AND p_end_date
      AND NOT public.is_reportable_sales_invoice(document_status, is_draft, notes)
      AND (
        document_status = 'cancelled'
        OR COALESCE(notes, '') LIKE '[CANCELLED%'
        OR LOWER(COALESCE(notes, '')) LIKE 'cancelled%'
      )
  ),
  cancelled_invoices_data AS (
    SELECT COUNT(ch.id)::int AS cancelled_count,
           COALESCE(SUM(ch.total_amount), 0)::numeric AS cancelled_total_amount,
           COALESCE(SUM(ch.subtotal), 0)::numeric AS cancelled_subtotal,
           COALESCE((
             SELECT SUM(sii.quantity)
             FROM public.sales_invoice_items sii
             WHERE sii.invoice_id IN (SELECT id FROM cancelled_headers)
           ), 0)::numeric AS cancelled_total_qty
    FROM cancelled_headers ch
  ),
  inv AS (
    SELECT invoice_id,
           MAX(invoice_date) AS invoice_date,
           MAX(posted_invoice_cogs) AS posted_invoice_cogs,
           SUM(authoritative_cogs) AS line_cogs,
           COUNT(*) FILTER (WHERE authoritative_cogs IS NULL) AS unresolved_cogs_lines,
           SUM(line_gross_sales) AS gross_sales,
           SUM(quantity) AS total_qty_sold,
           SUM(line_sales_expense) AS sales_expenses,
           COUNT(*) AS line_count
    FROM lines
    GROUP BY invoice_id
  ),
  invoice_totals AS (
    SELECT i.*,
           CASE
             WHEN i.posted_invoice_cogs IS NOT NULL THEN i.posted_invoice_cogs
             WHEN i.unresolved_cogs_lines = 0 THEN i.line_cogs
             ELSE 0::numeric
           END AS report_product_cost
    FROM inv i
  ),
  unallocated_rows AS (
    SELECT DATE_TRUNC('month', fe.expense_date)::date AS month_start,
           COALESCE(fe.amount, 0) AS amount
    FROM public.finance_expenses fe
    WHERE fe.expense_date BETWEEN p_start_date AND p_end_date
      AND (
        fe.expense_category IN (
          'delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales',
          'sales_distribution', 'freight_outward', 'delivery_expense',
          'sales_commission', 'travel_sales'
        )
        OR EXISTS (
          SELECT 1
          FROM public.expense_categories ec
          WHERE ec.category_key = fe.expense_category
            AND ec.category_type = 'sales'
        )
      )
      AND fe.approval_status = 'approved'
      AND fe.batch_id IS NULL
      AND fe.import_container_id IS NULL
      AND fe.delivery_challan_id IS NULL
      AND fe.sales_order_id IS NULL
      AND fe.linked_sales_invoice_id IS NULL
      AND CASE
            WHEN fe.sales_order_allocations IS NULL THEN true
            WHEN jsonb_typeof(fe.sales_order_allocations) = 'array'
              THEN jsonb_array_length(fe.sales_order_allocations) = 0
            ELSE false
          END
  ),
  unallocated AS (
    SELECT COALESCE(SUM(amount), 0) AS amount FROM unallocated_rows
  ),
  monthly_unallocated AS (
    SELECT month_start, SUM(amount) AS amount
    FROM unallocated_rows
    GROUP BY month_start
  ),
  monthly_sales AS (
    SELECT DATE_TRUNC('month', invoice_date)::date AS month_start,
           SUM(gross_sales) AS gross_sales,
           SUM(report_product_cost) AS product_cost,
           SUM(sales_expenses) AS sales_expenses,
           SUM(total_qty_sold) AS total_qty_sold,
           COUNT(*) AS order_count,
           BOOL_OR(unresolved_cogs_lines > 0) AS has_unreported_cost
    FROM invoice_totals
    GROUP BY 1
  ),
  monthly_returns AS (
    SELECT DATE_TRUNC('month', credit_note_date)::date AS month_start,
           SUM(subtotal) AS return_revenue,
           SUM(return_qty) AS return_qty,
           SUM(posted_return_cogs) AS return_cogs,
           SUM(unresolved_return_cogs_count) AS unresolved_return_cogs_count
    FROM cn_quality
    GROUP BY 1
  ),
  months AS (
    SELECT COALESCE(ms.month_start, mr.month_start, mu.month_start) AS month_start,
           TO_CHAR(COALESCE(ms.month_start, mr.month_start, mu.month_start), 'Mon YYYY') AS month_label,
           COALESCE(ms.gross_sales, 0) AS gross_sales_before_returns,
           COALESCE(mr.return_revenue, 0) AS sales_returns,
           COALESCE(ms.gross_sales, 0) - COALESCE(mr.return_revenue, 0) AS net_sales,
           COALESCE(ms.product_cost, 0) - COALESCE(mr.return_cogs, 0) AS net_product_cost,
           COALESCE(ms.sales_expenses, 0) + COALESCE(mu.amount, 0) AS sales_expenses,
           COALESCE(ms.total_qty_sold, 0) - COALESCE(mr.return_qty, 0) AS total_qty_sold,
           COALESCE(ms.order_count, 0) AS order_count,
           COALESCE(ms.has_unreported_cost, false) AS has_unreported_cost,
           COALESCE(mr.unresolved_return_cogs_count, 0) AS unresolved_return_cogs_count
    FROM monthly_sales ms
    FULL OUTER JOIN monthly_returns mr ON mr.month_start = ms.month_start
    FULL OUTER JOIN monthly_unallocated mu
      ON mu.month_start = COALESCE(ms.month_start, mr.month_start)
  ),
  company AS (
    SELECT COALESCE(SUM(gross_sales), 0) AS gross_sales,
           COALESCE(SUM(report_product_cost), 0) AS product_cost,
           COALESCE(SUM(sales_expenses), 0) + (SELECT amount FROM unallocated) AS sales_expenses,
           (SELECT amount FROM unallocated) AS unallocated_sales_expenses,
           COALESCE((SELECT SUM(total_qty_sold) FROM products_report), 0) AS total_qty_sold,
           COUNT(*) AS order_count,
           (SELECT COUNT(*) FROM products_report) AS product_count,
           COALESCE((SELECT total_return_revenue FROM returns), 0) AS sales_returns,
           COALESCE((SELECT total_return_cogs FROM returns), 0) AS return_cogs,
           COALESCE(BOOL_OR(unresolved_cogs_lines > 0), false) AS has_unreported_cost
    FROM invoice_totals
  )
  SELECT jsonb_build_object(
    'company', jsonb_build_object(
      'gross_sales', c.gross_sales,
      'sales_returns', c.sales_returns,
      'net_sales', c.gross_sales - c.sales_returns,
      'product_cost', c.product_cost,
      'return_cogs', c.return_cogs,
      'net_product_cost', c.product_cost - c.return_cogs,
      'sales_expenses', c.sales_expenses,
      'unallocated_sales_expenses', c.unallocated_sales_expenses,
      'gross_profit', (c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs),
      'profit_after_sales_expenses', (c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs) - c.sales_expenses,
      'profit_margin_pct', CASE
        WHEN (c.gross_sales - c.sales_returns) = 0 THEN NULL
        ELSE ROUND(
          ((c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs) - c.sales_expenses)
          / (c.gross_sales - c.sales_returns) * 100, 2
        )
      END,
      'total_qty_sold', c.total_qty_sold,
      'order_count', c.order_count,
      'product_count', c.product_count,
      'has_unreported_cost', c.has_unreported_cost,
      'unresolved_return_cogs_count', (SELECT unresolved_return_cogs_count FROM returns),
      'return_cogs_allocation_mismatch_count', (SELECT return_cogs_allocation_mismatch_count FROM returns),
      'credit_note_item_subtotal_mismatch_count', (SELECT item_subtotal_mismatch_count FROM returns),
      'has_unresolved_return_cogs', (
        (SELECT unresolved_return_cogs_count FROM returns) > 0
        OR (SELECT return_cogs_allocation_mismatch_count FROM returns) > 0
      ),
      'has_credit_note_item_subtotal_mismatch', (SELECT item_subtotal_mismatch_count FROM returns) > 0,
      'has_unallocated_return_revenue', (SELECT item_subtotal_mismatch_count FROM returns) > 0,
      'profitability_certified', NOT (
        c.has_unreported_cost
        OR (SELECT unresolved_return_cogs_count FROM returns) > 0
        OR (SELECT return_cogs_allocation_mismatch_count FROM returns) > 0
        OR (SELECT item_subtotal_mismatch_count FROM returns) > 0
      ),
      'certification_status', CASE WHEN NOT (
        c.has_unreported_cost
        OR (SELECT unresolved_return_cogs_count FROM returns) > 0
        OR (SELECT return_cogs_allocation_mismatch_count FROM returns) > 0
        OR (SELECT item_subtotal_mismatch_count FROM returns) > 0
      ) THEN 'RECONCILED' ELSE 'UNRESOLVED' END,
      'cancelled_invoices', jsonb_build_object(
        'count', cid.cancelled_count,
        'total_amount', cid.cancelled_total_amount,
        'subtotal', cid.cancelled_subtotal,
        'total_qty', cid.cancelled_total_qty
      )
    ),
    'cancelled_invoices', jsonb_build_object(
      'count', cid.cancelled_count,
      'total_amount', cid.cancelled_total_amount,
      'subtotal', cid.cancelled_subtotal,
      'total_qty', cid.cancelled_total_qty
    ),
    'products', COALESCE((
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.product_name)
      FROM products_report p
    ), '[]'::jsonb),
    'monthly', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'month_label', m.month_label,
          'month_start', m.month_start,
          'gross_sales', m.gross_sales_before_returns,
          'gross_sales_before_returns', m.gross_sales_before_returns,
          'net_sales', m.net_sales,
          'sales_returns', m.sales_returns,
          'product_cost', m.net_product_cost,
          'sales_expenses', m.sales_expenses,
          'gross_profit', m.net_sales - m.net_product_cost,
          'profit_after_sales_expenses', m.net_sales - m.net_product_cost - m.sales_expenses,
          'profit_margin_pct', CASE
            WHEN m.net_sales = 0 THEN NULL
            ELSE ROUND((m.net_sales - m.net_product_cost - m.sales_expenses) / m.net_sales * 100, 2)
          END,
          'total_qty_sold', m.total_qty_sold,
          'order_count', m.order_count,
          'has_unreported_cost', m.has_unreported_cost,
          'unresolved_return_cogs_count', m.unresolved_return_cogs_count
        ) ORDER BY m.month_start
      ) FROM months m
    ), '[]'::jsonb)
  ) INTO v_result
  FROM company c
  CROSS JOIN cancelled_invoices_data cid;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Return-aware product/batch drilldown.
--    Return-only batches/products are included; physical and commercial CN
--    treatment matches the summary RPC. Unresolved costs remain NULL/flagged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sales_profitability_product_batches(
  p_product_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.role() <> 'service_role'
     AND current_user <> 'service_role'
     AND session_user <> 'postgres'
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.user_profiles
      WHERE id = auth.uid()
        AND is_active = true
        AND role IN ('admin', 'accounts', 'auditor_ca', 'manager')
    ) THEN
      RAISE EXCEPTION 'Permission denied: unauthorized to access sales profitability reports';
    END IF;
  END IF;

  WITH lines AS (
    SELECT ar.*,
           ROUND(sii.quantity * sii.unit_price, 2) AS gross_sales,
           b.batch_number,
           b.current_stock,
           COALESCE(le.sales_expense, 0) AS sales_expense,
           b.import_container_id,
           b.import_price,
           b.import_price_usd,
           b.exchange_rate_usd_to_idr,
           b.duty_charges,
           b.freight_charges,
           b.other_charges,
           b.landed_cost_per_unit,
           b.cost_per_unit
    FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
    JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
    JOIN public.sales_invoices si ON si.id = ar.invoice_id
    LEFT JOIN public.batches b ON b.id = ar.batch_id
    LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date, p_end_date) le
      ON le.line_id = ar.line_id
    WHERE ar.product_id = p_product_id
      AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  ),
  cn_items AS (
    SELECT cni.id AS credit_note_item_id,
           cn.credit_note_number,
           cn.credit_note_date,
           COALESCE(cn.credit_note_type, 'physical_return') AS credit_note_type,
           cni.product_id,
           cni.batch_id,
           COALESCE(cni.quantity, 0) AS quantity,
           COALESCE(cni.total_price, 0) AS return_revenue,
           CASE WHEN COALESCE(cn.credit_note_type, 'physical_return') = 'commercial_credit'
                THEN 0::numeric ELSE COALESCE(cni.quantity, 0) END AS return_qty,
           CASE WHEN COALESCE(cn.credit_note_type, 'physical_return') = 'commercial_credit'
                THEN 0::numeric ELSE public.get_credit_note_item_fifo_cogs(cni.id) END AS return_cogs
    FROM public.credit_notes cn
    JOIN public.credit_note_items cni ON cni.credit_note_id = cn.id
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
      AND cni.product_id = p_product_id
  ),
  sales_by_batch AS (
    SELECT batch_id,
           MAX(batch_number) AS batch_number,
           MAX(current_stock) AS current_stock,
           SUM(quantity) AS sales_qty,
           SUM(gross_sales) AS sales_revenue,
           SUM(authoritative_cogs) AS sales_cogs,
           SUM(sales_expense) AS sales_expenses,
           COUNT(authoritative_cogs) AS costed_lines,
           COUNT(*) AS total_lines,
           COUNT(*) FILTER (WHERE authoritative_cogs IS NULL) AS unresolved_sales_cogs_count,
           BOOL_OR(import_container_id IS NOT NULL OR COALESCE(landed_cost_per_unit, 0) > 0) AS is_imported,
           MAX(import_price) AS import_price,
           MAX(import_price_usd) AS import_price_usd,
           MAX(exchange_rate_usd_to_idr) AS exchange_rate_usd_to_idr,
           MAX(duty_charges) AS duty_charges,
           MAX(freight_charges) AS freight_charges,
           MAX(other_charges) AS other_charges,
           MAX(landed_cost_per_unit) AS landed_cost_per_unit,
           MAX(cost_per_unit) AS local_cost_per_unit,
           COUNT(DISTINCT invoice_id) AS order_count
    FROM lines
    GROUP BY batch_id
  ),
  returns_by_batch AS (
    SELECT batch_id,
           SUM(return_revenue) AS return_revenue,
           SUM(return_qty) AS return_qty,
           SUM(COALESCE(return_cogs, 0)) AS resolved_return_cogs,
           COUNT(*) FILTER (
             WHERE credit_note_type <> 'commercial_credit' AND return_cogs IS NULL
           ) AS unresolved_return_cogs_count,
           COALESCE(jsonb_agg(
             jsonb_build_object(
               'credit_note_item_id', credit_note_item_id,
               'credit_note_number', credit_note_number,
               'credit_note_date', credit_note_date,
               'credit_note_type', credit_note_type,
               'quantity', quantity,
               'return_qty', return_qty,
               'return_revenue', return_revenue,
               'return_cogs', return_cogs,
               'has_unresolved_cogs', (credit_note_type <> 'commercial_credit' AND return_cogs IS NULL)
             ) ORDER BY credit_note_date, credit_note_number, credit_note_item_id
           ), '[]'::jsonb) AS return_details
    FROM cn_items
    GROUP BY batch_id
  ),
  batch_keys AS (
    SELECT batch_id FROM sales_by_batch
    UNION
    SELECT batch_id FROM returns_by_batch
  ),
  batch_rows AS (
    SELECT k.batch_id,
           COALESCE(sb.batch_number, b.batch_number, 'Unassigned Batch') AS batch_number,
           COALESCE(sb.current_stock, b.current_stock, 0) AS current_stock,
           COALESCE(sb.sales_qty, 0) - COALESCE(rb.return_qty, 0) AS sold_qty,
           COALESCE(sb.sales_revenue, 0) - COALESCE(rb.return_revenue, 0) AS gross_sales,
           CASE
             WHEN COALESCE(sb.unresolved_sales_cogs_count, 0) > 0
               OR COALESCE(rb.unresolved_return_cogs_count, 0) > 0 THEN NULL
             ELSE COALESCE(sb.sales_cogs, 0) - COALESCE(rb.resolved_return_cogs, 0)
           END AS product_cost,
           COALESCE(sb.sales_expenses, 0) AS sales_expense,
           COALESCE(sb.costed_lines, 0) AS costed_lines,
           COALESCE(sb.total_lines, 0) AS total_lines,
           COALESCE(sb.unresolved_sales_cogs_count, 0) AS unresolved_sales_cogs_count,
           COALESCE(rb.unresolved_return_cogs_count, 0) AS unresolved_return_cogs_count,
           COALESCE(rb.return_qty, 0) AS return_qty,
           COALESCE(rb.return_revenue, 0) AS return_revenue,
           COALESCE(rb.resolved_return_cogs, 0) AS resolved_return_cogs,
           COALESCE(rb.return_details, '[]'::jsonb) AS return_details,
           COALESCE(sb.is_imported, b.import_container_id IS NOT NULL OR COALESCE(b.landed_cost_per_unit, 0) > 0, false) AS is_imported,
           COALESCE(sb.import_price, b.import_price) AS import_price,
           COALESCE(sb.import_price_usd, b.import_price_usd) AS import_price_usd,
           COALESCE(sb.exchange_rate_usd_to_idr, b.exchange_rate_usd_to_idr) AS exchange_rate_usd_to_idr,
           COALESCE(sb.duty_charges, b.duty_charges) AS duty_charges,
           COALESCE(sb.freight_charges, b.freight_charges) AS freight_charges,
           COALESCE(sb.other_charges, b.other_charges) AS other_charges,
           COALESCE(sb.landed_cost_per_unit, b.landed_cost_per_unit) AS landed_cost_per_unit,
           COALESCE(sb.local_cost_per_unit, b.cost_per_unit) AS local_cost_per_unit,
           COALESCE(sb.order_count, 0) AS order_count
    FROM batch_keys k
    LEFT JOIN sales_by_batch sb ON sb.batch_id IS NOT DISTINCT FROM k.batch_id
    LEFT JOIN returns_by_batch rb ON rb.batch_id IS NOT DISTINCT FROM k.batch_id
    LEFT JOIN public.batches b ON b.id = k.batch_id
  ),
  calculated_batches AS (
    SELECT br.*,
           CASE WHEN br.product_cost IS NULL THEN NULL
                ELSE br.gross_sales - br.product_cost END AS gross_profit,
           CASE WHEN br.product_cost IS NULL THEN NULL
                ELSE br.gross_sales - br.product_cost - br.sales_expense END AS profit_after_sales_expense,
           CASE WHEN br.product_cost IS NULL OR br.sold_qty = 0 THEN NULL
                ELSE ROUND(br.product_cost / br.sold_qty, 4) END AS calculated_unit_cost,
           CASE WHEN br.sold_qty = 0 THEN NULL
                ELSE ROUND(br.gross_sales / br.sold_qty, 2) END AS avg_selling_price,
           CASE WHEN br.sold_qty = 0 THEN NULL
                ELSE ROUND(br.sales_expense / br.sold_qty, 2) END AS sales_expense_per_unit,
           CASE WHEN br.sold_qty = 0 THEN NULL
                ELSE ROUND((br.gross_sales - br.sales_expense) / br.sold_qty, 2) END AS net_selling_price_per_unit,
           CASE WHEN br.product_cost IS NULL OR br.sold_qty = 0 THEN NULL
                ELSE ROUND((br.gross_sales - br.product_cost - br.sales_expense) / br.sold_qty, 2) END AS profit_per_unit,
           CASE WHEN br.product_cost IS NULL OR br.gross_sales = 0 THEN NULL
                ELSE ROUND((br.gross_sales - br.product_cost - br.sales_expense) / br.gross_sales * 100, 2) END AS profit_margin_pct
    FROM batch_rows br
  )
  SELECT jsonb_build_object(
    'product', (
      SELECT jsonb_build_object(
        'product_id', p.id,
        'product_name', p.product_name,
        'product_code', COALESCE(p.product_code, ''),
        'product_unit', COALESCE(p.unit, 'kg'),
        'current_stock', COALESCE((
          SELECT SUM(b.current_stock) FROM public.batches b
          WHERE b.product_id = p.id AND b.is_active
        ), 0),
        'sold_qty', COALESCE(SUM(cb.sold_qty), 0),
        'gross_sales', COALESCE(SUM(cb.gross_sales), 0),
        'product_cost', CASE WHEN BOOL_OR(cb.product_cost IS NULL) THEN NULL ELSE COALESCE(SUM(cb.product_cost), 0) END,
        'sales_expense', COALESCE(SUM(cb.sales_expense), 0),
        'gross_profit', CASE WHEN BOOL_OR(cb.gross_profit IS NULL) THEN NULL ELSE COALESCE(SUM(cb.gross_profit), 0) END,
        'profit_after_sales_expense', CASE WHEN BOOL_OR(cb.profit_after_sales_expense IS NULL) THEN NULL ELSE COALESCE(SUM(cb.profit_after_sales_expense), 0) END,
        'costed_lines', COALESCE(SUM(cb.costed_lines), 0),
        'total_lines', COALESCE(SUM(cb.total_lines), 0),
        'has_unreported_cost', COALESCE(BOOL_OR(cb.product_cost IS NULL), false),
        'return_qty', COALESCE(SUM(cb.return_qty), 0),
        'return_revenue', COALESCE(SUM(cb.return_revenue), 0),
        'resolved_return_cogs', COALESCE(SUM(cb.resolved_return_cogs), 0),
        'unresolved_return_cogs_count', COALESCE(SUM(cb.unresolved_return_cogs_count), 0)
      )
      FROM public.products p
      LEFT JOIN calculated_batches cb ON true
      WHERE p.id = p_product_id
      GROUP BY p.id, p.product_name, p.product_code, p.unit
    ),
    'batches', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'batch_id', cb.batch_id,
          'batch_number', cb.batch_number,
          'current_stock', cb.current_stock,
          'sold_qty', cb.sold_qty,
          'quantity_sold', cb.sold_qty,
          'gross_sales', cb.gross_sales,
          'product_cost', cb.product_cost,
          'sales_expense', cb.sales_expense,
          'sales_expenses', cb.sales_expense,
          'gross_profit', cb.gross_profit,
          'profit_after_sales_expense', cb.profit_after_sales_expense,
          'cost_per_unit', cb.calculated_unit_cost,
          'authoritative_unit_cogs', cb.calculated_unit_cost,
          'landed_cost_per_unit', cb.landed_cost_per_unit,
          'avg_selling_price', cb.avg_selling_price,
          'sales_expense_per_unit', cb.sales_expense_per_unit,
          'net_selling_price_per_unit', cb.net_selling_price_per_unit,
          'profit_per_unit', cb.profit_per_unit,
          'profit_margin_pct', cb.profit_margin_pct,
          'is_imported', cb.is_imported,
          'import_price', cb.import_price,
          'import_price_usd', cb.import_price_usd,
          'exchange_rate_usd_to_idr', cb.exchange_rate_usd_to_idr,
          'duty_charges', cb.duty_charges,
          'freight_charges', cb.freight_charges,
          'other_charges', cb.other_charges,
          'cost_breakdown', jsonb_build_object(
            'is_imported', cb.is_imported,
            'import_price', cb.import_price,
            'import_price_usd', cb.import_price_usd,
            'exchange_rate', cb.exchange_rate_usd_to_idr,
            'duty_charges', cb.duty_charges,
            'freight_charges', cb.freight_charges,
            'other_charges', cb.other_charges,
            'landed_cost_per_unit', cb.landed_cost_per_unit,
            'local_cost_per_unit', cb.local_cost_per_unit
          ),
          'costed_lines', cb.costed_lines,
          'total_lines', cb.total_lines,
          'unresolved_sales_cogs_count', cb.unresolved_sales_cogs_count,
          'unresolved_return_cogs_count', cb.unresolved_return_cogs_count,
          'has_unreported_cost', (cb.product_cost IS NULL),
          'cost_coverage', CASE
            WHEN cb.unresolved_sales_cogs_count > 0 OR cb.unresolved_return_cogs_count > 0 THEN 'partial'
            ELSE 'complete'
          END,
          'return_qty', cb.return_qty,
          'return_revenue', cb.return_revenue,
          'return_cogs', cb.resolved_return_cogs,
          'return_details', cb.return_details,
          'order_count', cb.order_count
        ) ORDER BY cb.batch_number
      )
      FROM calculated_batches cb
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.get_sales_profitability_product_batches(uuid, date, date) IS
  'Return-aware batch profitability. Sales use historical authoritative invoice COGS; approved credit notes are dated by credit_note_date; commercial credits reduce revenue only; physical returns reduce quantity and COGS; return-only batches are included; unresolved return costs remain NULL and flagged.';

COMMIT;
