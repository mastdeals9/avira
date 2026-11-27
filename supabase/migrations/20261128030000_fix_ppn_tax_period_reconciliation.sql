-- ============================================================================
-- Migration: Reconcile PPN monthly tax periods with posted GL 1150 / 2130
-- Scope: Issue 4 (PPN Tax Period View, Computation & Historical Period Sync)
-- ============================================================================

-- 1. Ensure vw_ppn_net_by_period excludes cancelled JEs as well as reversed ones
CREATE OR REPLACE VIEW public.vw_ppn_net_by_period AS
SELECT tp.id AS tax_period_id,
       tp.fiscal_year,
       tp.period_month,
       tp.period_start,
       tp.period_end,
       tp.status,
       tp.filing_status,
       COALESCE(j.input_ppn, 0::numeric)::numeric(18,2) AS input_ppn_total,
       COALESCE(j.output_ppn, 0::numeric)::numeric(18,2) AS output_ppn_total,
       tp.carry_forward_in,
       GREATEST(COALESCE(j.output_ppn, 0::numeric) - COALESCE(j.input_ppn, 0::numeric) - tp.carry_forward_in, 0::numeric)::numeric(18,2) AS net_ppn_payable,
       GREATEST(COALESCE(j.input_ppn, 0::numeric) + tp.carry_forward_in - COALESCE(j.output_ppn, 0::numeric), 0::numeric)::numeric(18,2) AS carry_forward_out,
       tp.payment_due_date,
       tp.filing_due_date
  FROM public.tax_periods tp
  LEFT JOIN LATERAL (
    SELECT SUM(
             CASE
               WHEN coa.code = '1150'::text THEN jel.debit - jel.credit
               ELSE 0::numeric
             END
           ) AS input_ppn,
           SUM(
             CASE
               WHEN coa.code = '2130'::text THEN jel.credit - jel.debit
               ELSE 0::numeric
             END
           ) AS output_ppn
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
     WHERE je.is_posted = true
       AND COALESCE(je.is_reversed, false) = false
       AND COALESCE(je.is_cancelled, false) = false
       AND je.entry_date >= tp.period_start
       AND je.entry_date <= tp.period_end
       AND (coa.code = ANY (ARRAY['1150'::text, '2130'::text]))
  ) j ON true
 WHERE tp.tax_type = 'PPN'::text
 ORDER BY tp.fiscal_year DESC, tp.period_month DESC;

-- 2. Fix compute_period_ppn_pre_posted_register:
--    a) Skip filed/closed periods
--    b) Count both finance_expenses.ppn_amount (broker's own PPN) AND broker_items PPN
--    c) Exclude sales_invoices whose posted journal entries are reversed/cancelled
CREATE OR REPLACE FUNCTION public.compute_period_ppn_pre_posted_register(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_period       public.tax_periods%ROWTYPE;
  v_input        numeric(18,2);
  v_output_gross numeric(18,2);
  v_output_nr    numeric(18,2);
  v_output_cn    numeric(18,2);
  v_output       numeric(18,2);
  v_prior_cf     numeric(18,2);
BEGIN
  SELECT * INTO v_period FROM public.tax_periods WHERE id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;

  IF v_period.filing_status = 'filed' OR v_period.status = 'closed' THEN
    RETURN;
  END IF;

  IF v_period.tax_type = 'PPN' THEN
    -- Input PPN sum
    SELECT
      COALESCE((
        SELECT SUM(pi.tax_amount)
          FROM public.purchase_invoices pi
         WHERE pi.tax_period_id = p_period_id
           AND pi.tax_amount > 0
           AND COALESCE(LOWER(pi.status), '') NOT IN ('cancelled', 'void', 'deleted')
      ), 0)
      +
      COALESCE((
        SELECT SUM(fe.ppn_amount)
          FROM public.finance_expenses fe
         WHERE fe.tax_period_id = p_period_id
           AND fe.ppn_amount > 0
      ), 0)
      +
      COALESCE((
        SELECT SUM(COALESCE((item->>'ppn_amount')::numeric, 0))
          FROM public.finance_expenses fe
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
         WHERE fe.tax_period_id = p_period_id
           AND COALESCE((item->>'ppn_amount')::numeric, 0) > 0
      ), 0)
      +
      COALESCE((
        SELECT SUM(fe.pib_ppn_amount)
          FROM public.finance_expenses fe
         WHERE fe.tax_period_id = p_period_id
           AND fe.pib_ppn_amount > 0
      ), 0)
    INTO v_input;

    -- Gross Output PPN sum from active sales invoices
    SELECT COALESCE(SUM(si.tax_amount), 0) INTO v_output_gross
      FROM public.sales_invoices si
     WHERE si.tax_period_id = p_period_id
       AND si.tax_amount > 0
       AND NOT (
         EXISTS (
           SELECT 1
             FROM public.journal_entries je_rev
            WHERE je_rev.reference_number = si.invoice_number
              AND je_rev.source_module = 'sales_invoice'
              AND (COALESCE(je_rev.is_reversed, false) = true OR COALESCE(je_rev.is_cancelled, false) = true)
         )
         AND NOT EXISTS (
           SELECT 1
             FROM public.journal_entries je_act
            WHERE je_act.reference_number = si.invoice_number
              AND je_act.source_module = 'sales_invoice'
              AND je_act.is_posted = true
              AND COALESCE(je_act.is_reversed, false) = false
              AND COALESCE(je_act.is_cancelled, false) = false
         )
       );

    -- Approved Nota Retur assigned to this tax period
    SELECT COALESCE(SUM(nr.ppn_amount), 0) INTO v_output_nr
      FROM public.nota_retur nr
     WHERE nr.tax_period_id = p_period_id
       AND nr.status = 'approved'
       AND nr.ppn_amount > 0;

    -- Approved Credit Notes not already represented by an approved Nota Retur
    SELECT COALESCE(SUM(cn.tax_amount), 0) INTO v_output_cn
      FROM public.credit_notes cn
     WHERE cn.tax_period_id = p_period_id
       AND cn.status = 'approved'
       AND cn.tax_amount > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.nota_retur nr
          WHERE (nr.credit_note_id = cn.id OR nr.material_return_id = cn.material_return_id)
            AND nr.status = 'approved'
            AND nr.tax_period_id = p_period_id
       );

    v_output := GREATEST(v_output_gross - (v_output_nr + v_output_cn), 0);

    SELECT COALESCE(carry_forward_out, 0) INTO v_prior_cf
      FROM public.tax_periods
     WHERE tax_type = 'PPN'
       AND (fiscal_year, period_month) < (v_period.fiscal_year, v_period.period_month)
     ORDER BY fiscal_year DESC, period_month DESC
     LIMIT 1;
    v_prior_cf := COALESCE(v_prior_cf, 0);

    UPDATE public.tax_periods SET
      input_ppn_total   = v_input,
      output_ppn_total  = v_output,
      carry_forward_in  = v_prior_cf,
      net_ppn           = GREATEST(v_output - v_input - v_prior_cf, 0),
      carry_forward_out = GREATEST(v_input + v_prior_cf - v_output, 0),
      updated_at        = now()
    WHERE id = p_period_id;
  END IF;
END;
$$;

-- 3. Reassign SAPJ-26-046 and SAPJ-26-047 (2026-08-26) to the 2026-08 PPN period
--    without triggering journal/COGS re-posting on already-posted historical invoices.
ALTER TABLE public.sales_invoices DISABLE TRIGGER trg_post_sales_invoice;
ALTER TABLE public.sales_invoices DISABLE TRIGGER trg_post_sales_invoice_cogs;

UPDATE public.sales_invoices si
   SET tax_period_id = tp_aug.id
  FROM public.tax_periods tp_aug
 WHERE tp_aug.tax_type = 'PPN'
   AND tp_aug.fiscal_year = 2026
   AND tp_aug.period_month = 8
   AND si.invoice_number IN ('SAPJ-26-046', 'SAPJ-26-047')
   AND si.invoice_date = '2026-08-26'
   AND si.tax_period_id IS DISTINCT FROM tp_aug.id;

ALTER TABLE public.sales_invoices ENABLE TRIGGER trg_post_sales_invoice;
ALTER TABLE public.sales_invoices ENABLE TRIGGER trg_post_sales_invoice_cogs;

-- 4. Chronologically recompute open/unfiled PPN periods strictly before 2026-11
--    (2026-11 includes >= 2026-11-20 live transactions and is excluded from historical recalculation;
--     only carry_forward_in / carry_forward_out is chained forward from 2026-10).
DO $$
DECLARE
  v_period_id uuid;
  v_oct_cf_out numeric(18,2);
BEGIN
  FOR v_period_id IN
    SELECT id
      FROM public.tax_periods
     WHERE tax_type = 'PPN'
       AND status <> 'closed'
       AND filing_status <> 'filed'
       AND (fiscal_year, period_month) <= (2026, 10)
     ORDER BY fiscal_year ASC, period_month ASC
  LOOP
    PERFORM public.compute_period_ppn_pre_posted_register(v_period_id);
  END LOOP;

  SELECT carry_forward_out INTO v_oct_cf_out
    FROM public.tax_periods
   WHERE tax_type = 'PPN' AND fiscal_year = 2026 AND period_month = 10;

  IF v_oct_cf_out IS NOT NULL THEN
    UPDATE public.tax_periods
       SET carry_forward_in  = v_oct_cf_out,
           net_ppn           = GREATEST(output_ppn_total - input_ppn_total - v_oct_cf_out, 0),
           carry_forward_out = GREATEST(input_ppn_total + v_oct_cf_out - output_ppn_total, 0),
           updated_at        = now()
     WHERE tax_type = 'PPN'
       AND fiscal_year = 2026
       AND period_month = 11
       AND status <> 'closed'
       AND filing_status <> 'filed';
  END IF;
END;
$$;
