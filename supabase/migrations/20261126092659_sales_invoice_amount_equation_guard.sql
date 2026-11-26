-- Reconstructed from production migration 20261126092659 (already applied in production)

BEGIN;

CREATE OR REPLACE FUNCTION public.validate_sales_invoice_amount_equation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_expected numeric(18,2);
  v_financial_fields_changed boolean := true;
BEGIN
  IF TG_OP='UPDATE' THEN
    v_financial_fields_changed :=
      NEW.subtotal IS DISTINCT FROM OLD.subtotal
      OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
      OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
      OR NEW.stamp_duty_amount IS DISTINCT FROM OLD.stamp_duty_amount
      OR NEW.total_amount IS DISTINCT FROM OLD.total_amount;
  END IF;

  IF NOT v_financial_fields_changed OR COALESCE(NEW.is_draft,false) THEN
    RETURN NEW;
  END IF;

  v_expected := ROUND(
    COALESCE(NEW.subtotal,0)
    + COALESCE(NEW.tax_amount,0)
    - COALESCE(NEW.discount_amount,0)
    + COALESCE(NEW.stamp_duty_amount,0),
    2
  );

  IF ABS(COALESCE(NEW.total_amount,0)-v_expected)>0.01 THEN
    RAISE EXCEPTION
      'Sales invoice % total mismatch: supplied %, expected subtotal + VAT - discount + stamp duty = %',
      NEW.invoice_number,NEW.total_amount,v_expected
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_validate_sales_invoice_amount_equation ON public.sales_invoices;
CREATE TRIGGER trg_validate_sales_invoice_amount_equation
  BEFORE INSERT OR UPDATE ON public.sales_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_sales_invoice_amount_equation();

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261126092659', 'sales_invoice_amount_equation_guard')
ON CONFLICT (version) DO NOTHING;

COMMIT;
