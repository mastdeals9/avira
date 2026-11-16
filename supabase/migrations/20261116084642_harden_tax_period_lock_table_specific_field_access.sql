CREATE OR REPLACE FUNCTION public.enforce_tax_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
  v_filing_status text;
BEGIN
  IF current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    IF OLD.tax_period_id IS NOT NULL THEN
      SELECT status INTO v_status
        FROM public.tax_periods
       WHERE id = OLD.tax_period_id;

      IF v_status = 'closed' THEN
        RAISE EXCEPTION 'Tax period is closed; cannot modify % on %',
          TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    -- Access the PPh-specific field only inside this table-specific branch.
    IF TG_TABLE_NAME = 'finance_expenses' THEN
      IF OLD.pph_tax_period_id IS NOT NULL THEN
        SELECT filing_status INTO v_filing_status
          FROM public.tax_periods
         WHERE id = OLD.pph_tax_period_id;

        IF v_filing_status IN ('filed', 'amended') THEN
          RAISE EXCEPTION 'PPh tax period is filed; cannot modify % on %',
            TG_OP, TG_TABLE_NAME
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.tax_period_id IS NOT NULL THEN
      SELECT status INTO v_status
        FROM public.tax_periods
       WHERE id = NEW.tax_period_id;

      IF v_status = 'closed' THEN
        RAISE EXCEPTION 'Tax period is closed; cannot assign new rows to it'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    -- Access the PPh-specific field only inside this table-specific branch.
    IF TG_TABLE_NAME = 'finance_expenses' THEN
      IF NEW.pph_tax_period_id IS NOT NULL THEN
        SELECT filing_status INTO v_filing_status
          FROM public.tax_periods
         WHERE id = NEW.pph_tax_period_id;

        IF v_filing_status IN ('filed', 'amended') THEN
          RAISE EXCEPTION 'PPh tax period is filed; cannot assign new rows to it'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;
