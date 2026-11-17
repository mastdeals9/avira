-- Permit purchase-invoice-triggered tax-period refreshes for warehouse users
-- without granting them direct tax recalculation privileges.
-- The bypass is limited to the trusted SECURITY DEFINER PI trigger context.

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
  -- Direct tax recalculation remains restricted to Finance/Tax administrators.
  -- A purchase-invoice AFTER trigger may refresh derived tax totals as an
  -- internal side effect of a PI operation that warehouse users are allowed
  -- to perform. Require both the private transaction marker and trigger depth.
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

  SELECT COALESCE(public.fn_pph_authoritative_source_total(p_period_id), 0)
       + COALESCE((
           SELECT SUM(tp.amount)
             FROM public.tax_payments tp
            WHERE tp.tax_period_id = p_period_id
              AND tp.tax_type = v_period.tax_type
              AND tp.historical_source_status = 'missing_source_verified'
         ), 0)
    INTO v_pph_total;

  UPDATE public.tax_periods
     SET pph_total = v_pph_total,
         updated_at = now()
   WHERE id = p_period_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_recompute_from_purchase_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_previous_context text;
BEGIN
  v_previous_context := current_setting('app.internal_tax_period_recompute', true);
  PERFORM set_config('app.internal_tax_period_recompute', 'purchase_invoice', true);

  IF TG_OP = 'DELETE' THEN
    PERFORM public.recompute_periods_for_date(OLD.invoice_date);
  ELSE
    PERFORM public.recompute_periods_for_date(NEW.invoice_date);
    IF TG_OP = 'UPDATE'
       AND NEW.invoice_date IS DISTINCT FROM OLD.invoice_date THEN
      PERFORM public.recompute_periods_for_date(OLD.invoice_date);
    END IF;
  END IF;

  PERFORM set_config(
    'app.internal_tax_period_recompute',
    COALESCE(v_previous_context, ''),
    true
  );

  RETURN NULL;
END;
$function$;

COMMIT;

