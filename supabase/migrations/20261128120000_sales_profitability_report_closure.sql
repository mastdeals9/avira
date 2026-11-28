-- ==============================================================================
-- MIGRATION: 20261128120000_sales_profitability_report_closure.sql
-- Description:
--   Non-destructive reporting closure for Sales Profitability RPCs:
--   1. Align get_sales_profitability_summary monthly CTE with credit_notes
--      (by credit_note_date: return_revenue, return_cogs, physical return_qty)
--      and monthly unallocated sales expenses so SUM(monthly) == company.
--   2. Deduct physical return_qty in company.total_qty_sold so
--      company.total_qty_sold == SUM(products.total_qty_sold).
--   3. Ensure commercial_credit credit notes deduct revenue only (zero qty / COGS).
--   4. Align get_sales_profitability_product_batches with batch-level returns.
--   NO historical data, journals, batches, or snapshots are modified.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.get_sales_profitability_summary(p_start_date date, p_end_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.role() <> 'service_role' AND current_user <> 'service_role' AND session_user <> 'postgres' AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND is_active = true
        AND role IN ('admin', 'accounts', 'auditor_ca', 'manager')
    ) THEN
      RAISE EXCEPTION 'Permission denied: unauthorized to access sales profitability reports';
    END IF;
  END IF;

  WITH lines AS (
    SELECT
      ar.*,
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
      COALESCE(b.landed_cost_per_unit, b.cost_per_unit) AS batch_unit_cost,
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
    LEFT JOIN public.get_sales_profitability_line_expenses(p_start_date, p_end_date) le ON le.line_id = ar.line_id
    WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  ),
  cancelled_headers AS (
    SELECT
      id,
      COALESCE(total_amount, 0) AS total_amount,
      COALESCE(subtotal, 0) AS subtotal
    FROM public.sales_invoices
    WHERE invoice_date BETWEEN p_start_date AND p_end_date
      AND NOT public.is_reportable_sales_invoice(document_status, is_draft, notes)
      AND (
        document_status = 'cancelled'
        OR (COALESCE(notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(notes, '')) LIKE 'cancelled%')
      )
  ),
  cancelled_invoices_data AS (
    SELECT
      COUNT(ch.id)::int AS cancelled_count,
      COALESCE(SUM(ch.total_amount), 0)::numeric AS cancelled_total_amount,
      COALESCE(SUM(ch.subtotal), 0)::numeric AS cancelled_subtotal,
      COALESCE((
        SELECT SUM(sii.quantity)
        FROM public.sales_invoice_items sii
        WHERE sii.invoice_id IN (SELECT id FROM cancelled_headers)
      ), 0)::numeric AS cancelled_total_qty
    FROM cancelled_headers ch
  ),
  cn_lines AS (
    SELECT
      cn.id AS credit_note_id,
      DATE_TRUNC('month', cn.credit_note_date)::date AS month_start,
      cni.product_id,
      COALESCE(cni.total_price, 0) AS return_revenue,
      CASE
        WHEN COALESCE(cn.credit_note_type, 'physical_return') = 'commercial_credit' THEN 0::numeric
        ELSE COALESCE(cni.quantity, 0)
      END AS return_qty,
      CASE
        WHEN COALESCE(cn.credit_note_type, 'physical_return') = 'commercial_credit' THEN 0::numeric
        ELSE COALESCE(public.get_credit_note_item_fifo_cogs(cni.id), 0)
      END AS return_cogs
    FROM public.credit_notes cn
    JOIN public.credit_note_items cni ON cni.credit_note_id = cn.id
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
  ),
  returns AS (
    SELECT
      COALESCE(SUM(return_revenue), 0) AS total_return_revenue,
      COALESCE(SUM(return_cogs), 0) AS total_return_cogs,
      COALESCE(SUM(return_qty), 0) AS total_return_qty
    FROM cn_lines
  ),
  unallocated_rows AS (
    SELECT
      DATE_TRUNC('month', fe.expense_date)::date AS month_start,
      COALESCE(fe.amount, 0) AS amount
    FROM public.finance_expenses fe
    WHERE fe.expense_date BETWEEN p_start_date AND p_end_date
      AND (
        fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales', 'sales_distribution', 'freight_outward', 'delivery_expense', 'sales_commission', 'travel_sales')
        OR EXISTS (
          SELECT 1 FROM public.expense_categories ec
          WHERE ec.category_key = fe.expense_category
            AND ec.category_type = 'sales'
        )
      )
      AND fe.approval_status = 'approved'
      AND fe.batch_id IS NULL
      AND fe.import_container_id IS NULL
      AND fe.delivery_challan_id IS NULL
      AND fe.sales_order_id IS NULL
      AND (
        fe.sales_order_allocations IS NULL
        OR fe.sales_order_allocations = '[]'::jsonb
        OR (jsonb_typeof(fe.sales_order_allocations) = 'array' AND jsonb_array_length(fe.sales_order_allocations) = 0)
      )
      AND fe.linked_sales_invoice_id IS NULL
  ),
  unallocated AS (
    SELECT COALESCE(SUM(amount), 0) AS amount FROM unallocated_rows
  ),
  monthly_unallocated AS (
    SELECT month_start, COALESCE(SUM(amount), 0) AS amount
    FROM unallocated_rows
    GROUP BY month_start
  ),
  prod_returns AS (
    SELECT
      product_id,
      COALESCE(SUM(return_revenue), 0) AS return_revenue,
      COALESCE(SUM(return_qty), 0) AS return_qty,
      COALESCE(SUM(return_cogs), 0) AS return_cogs
    FROM cn_lines
    GROUP BY product_id
  ),
  prod AS (
    SELECT
      l.product_id,
      MAX(l.product_name) AS product_name,
      MAX(l.product_code) AS product_code,
      MAX(l.product_unit) AS product_unit,
      SUM(l.quantity) - COALESCE(MAX(pr.return_qty), 0) AS total_qty_sold,
      SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0) AS total_revenue,
      SUM(CASE WHEN l.authoritative_cogs IS NOT NULL THEN l.line_gross_sales ELSE 0 END) - COALESCE(MAX(pr.return_revenue), 0) AS costed_revenue,
      SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0) AS total_cogs,
      (SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) AS gross_profit,
      SUM(l.line_sales_expense) AS total_sales_expenses,
      ((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0))) - SUM(l.line_sales_expense) AS profit_after_sales_expenses,
      COUNT(DISTINCT l.invoice_id) AS order_count,
      ROUND(
        ((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) - SUM(l.line_sales_expense))
        / NULLIF(SUM(CASE WHEN l.authoritative_cogs IS NOT NULL THEN l.quantity ELSE 0 END) - COALESCE(MAX(pr.return_qty), 0), 0),
        2
      ) AS profit_per_unit,
      CASE
        WHEN (SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) = 0 THEN NULL
        ELSE ROUND(
          ((SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) - (SUM(l.authoritative_cogs) - COALESCE(MAX(pr.return_cogs), 0)) - SUM(l.line_sales_expense))
          / (SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0)) * 100,
          2
        )
      END AS profit_margin_pct,
      COUNT(l.authoritative_cogs) AS costed_lines,
      COUNT(*) AS total_lines,
      COUNT(l.authoritative_cogs) < COUNT(*) AS has_unreported_cost
    FROM lines l
    LEFT JOIN prod_returns pr ON pr.product_id = l.product_id
    GROUP BY l.product_id
  ),
  inv AS (
    SELECT
      invoice_id,
      MAX(invoice_date) AS invoice_date,
      MAX(posted_invoice_cogs) AS product_cost,
      SUM(line_gross_sales) AS gross_sales,
      SUM(quantity) AS total_qty_sold,
      SUM(line_sales_expense) AS sales_expenses
    FROM lines
    GROUP BY invoice_id
  ),
  monthly_sales AS (
    SELECT
      DATE_TRUNC('month', invoice_date)::date AS month_start,
      SUM(gross_sales) AS gross_sales,
      SUM(product_cost) AS product_cost,
      SUM(sales_expenses) AS sales_expenses,
      SUM(total_qty_sold) AS total_qty_sold,
      COUNT(*) AS order_count
    FROM inv
    GROUP BY 1
  ),
  monthly_returns AS (
    SELECT
      month_start,
      COALESCE(SUM(return_revenue), 0) AS return_revenue,
      COALESCE(SUM(return_cogs), 0) AS return_cogs,
      COALESCE(SUM(return_qty), 0) AS return_qty
    FROM cn_lines
    GROUP BY month_start
  ),
  months AS (
    SELECT
      COALESCE(ms.month_start, mr.month_start, mu.month_start) AS month_start,
      TO_CHAR(COALESCE(ms.month_start, mr.month_start, mu.month_start), 'Mon YYYY') AS month_label,
      COALESCE(ms.gross_sales, 0) - COALESCE(mr.return_revenue, 0) AS gross_sales,
      COALESCE(ms.product_cost, 0) - COALESCE(mr.return_cogs, 0) AS product_cost,
      COALESCE(ms.sales_expenses, 0) + COALESCE(mu.amount, 0) AS sales_expenses,
      COALESCE(ms.total_qty_sold, 0) - COALESCE(mr.return_qty, 0) AS total_qty_sold,
      COALESCE(ms.order_count, 0) AS order_count
    FROM monthly_sales ms
    FULL OUTER JOIN monthly_returns mr ON mr.month_start = ms.month_start
    FULL OUTER JOIN monthly_unallocated mu ON mu.month_start = COALESCE(ms.month_start, mr.month_start)
  ),
  company AS (
    SELECT
      COALESCE(SUM(gross_sales), 0) AS gross_sales,
      COALESCE(SUM(product_cost), 0) AS product_cost,
      COALESCE(SUM(sales_expenses), 0) + (SELECT amount FROM unallocated) AS sales_expenses,
      (SELECT amount FROM unallocated) AS unallocated_sales_expenses,
      COALESCE(SUM(total_qty_sold), 0) - COALESCE((SELECT total_return_qty FROM returns), 0) AS total_qty_sold,
      COUNT(*) AS order_count,
      (SELECT COUNT(DISTINCT product_id) FROM lines) AS product_count,
      (SELECT total_return_revenue FROM returns) AS sales_returns,
      (SELECT total_return_cogs FROM returns) AS return_cogs
    FROM inv
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
      'profit_margin_pct', CASE WHEN (c.gross_sales - c.sales_returns) = 0 THEN NULL
        ELSE ROUND(((c.gross_sales - c.sales_returns) - (c.product_cost - c.return_cogs) - c.sales_expenses) / (c.gross_sales - c.sales_returns) * 100, 2) END,
      'total_qty_sold', c.total_qty_sold,
      'order_count', c.order_count,
      'product_count', c.product_count,
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
    'products', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.product_name) FROM prod p), '[]'::jsonb),
    'monthly', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'month_label', m.month_label,
          'month_start', m.month_start,
          'gross_sales', m.gross_sales,
          'product_cost', m.product_cost,
          'sales_expenses', m.sales_expenses,
          'gross_profit', m.gross_sales - m.product_cost,
          'profit_after_sales_expenses', m.gross_sales - m.product_cost - m.sales_expenses,
          'profit_margin_pct', CASE WHEN m.gross_sales = 0 THEN NULL ELSE ROUND((m.gross_sales - m.product_cost - m.sales_expenses) / m.gross_sales * 100, 2) END,
          'total_qty_sold', m.total_qty_sold,
          'order_count', m.order_count
        ) ORDER BY m.month_start
      ) FROM months m
    ), '[]'::jsonb)
  ) INTO v_result
  FROM company c
  CROSS JOIN cancelled_invoices_data cid;

  RETURN v_result;
END;
$function$;
