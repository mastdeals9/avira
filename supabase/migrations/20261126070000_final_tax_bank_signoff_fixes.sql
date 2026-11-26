-- ============================================================================
-- Migration: 20261126070000_final_tax_bank_signoff_fixes.sql
-- Purpose:
--   1. Fix compute_period_ppn(uuid) double-counting of missing_source_verified
--      tax_payments (already included by fn_pph_authoritative_source_total).
--   2. Recompute open/not-filed PPh4(2) periods (2025-02, 2025-10, 2025-11)
--      so tax_periods.pph_total ties to GL 2138 (Rp 32,603,604.00).
--   3. Normalize the 6 bank_statement_lines that are already matched,
--      allocated, and linked to approved expenses from matching_status='suggested'
--      to 'confirmed'.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.compute_period_ppn(p_period_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period public.tax_periods%rowtype;
  v_pph_total numeric(18,2);
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT (
       current_setting('app.internal_tax_period_recompute', true) = 'purchase_invoice'
       AND pg_trigger_depth() > 0
     ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'accounts', 'auditor_ca')
        AND is_active = true
    ) THEN
      RAISE EXCEPTION 'Access denied: tax period calculation requires finance or tax administrative privileges'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT * INTO v_period
    FROM public.tax_periods
   WHERE id = p_period_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;

  IF v_period.tax_type = 'PPN' THEN
    PERFORM public.compute_period_ppn_pre_posted_register(p_period_id);
    RETURN;
  END IF;

  IF v_period.filing_status = 'filed' OR v_period.status = 'closed' THEN
    RETURN;
  END IF;

  PERFORM public.compute_period_ppn_pre_posted_register(p_period_id);

  -- fn_pph_authoritative_source_total already includes verified historical
  -- missing_source_verified tax_payments; do not add them a second time.
  SELECT COALESCE(public.fn_pph_authoritative_source_total(p_period_id), 0)
    INTO v_pph_total;

  UPDATE public.tax_periods
     SET pph_total = v_pph_total,
         updated_at = now()
   WHERE id = p_period_id;
END;
$function$;

DO $$
DECLARE
  v_id uuid;
BEGIN
  FOR v_id IN
    SELECT id
    FROM public.tax_periods
    WHERE tax_type = 'PPh4(2)'
      AND COALESCE(filing_status, 'not_filed') <> 'filed'
      AND COALESCE(status, 'open') <> 'closed'
      AND COALESCE(pph_total, 0) <> COALESCE(public.fn_pph_authoritative_source_total(id), 0)
  LOOP
    PERFORM public.compute_period_ppn(v_id);
  END LOOP;
END;
$$;

-- Normalize 6 already-matched, allocated, approved bank statement lines
UPDATE public.bank_statement_lines bsl
SET matching_status = 'confirmed'
WHERE bsl.matching_status = 'suggested'
  AND bsl.reconciliation_status = 'matched'
  AND EXISTS (
    SELECT 1 FROM public.bank_statement_allocations bsa
    WHERE bsa.bank_statement_line_id = bsl.id
  )
  AND EXISTS (
    SELECT 1 FROM public.finance_expenses fe
    WHERE fe.id = bsl.matched_expense_id
      AND fe.approval_status = 'approved'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.bank_statement_lines b2
    WHERE b2.matched_expense_id = bsl.matched_expense_id
      AND b2.matching_status = 'confirmed'
      AND b2.id <> bsl.id
  );

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261126070000', 'final_tax_bank_signoff_fixes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
