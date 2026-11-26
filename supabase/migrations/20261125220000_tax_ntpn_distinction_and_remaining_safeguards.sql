-- ============================================================================
-- Migration: 20261125220000_tax_ntpn_distinction_and_remaining_safeguards.sql
-- Purpose:
--   1. Separate tax_payments.ntpn_format_valid (16-char alphanumeric format,
--      excluding company NPWP 0268760261042000) from tax_payments.ntpn_verified
--      (official DJP BPN/receipt verification with timestamp & verifier).
--   2. Clear the mistaken company NPWP (0268760261042000) from ntpn on
--      tax_payments row c7940eda-2fbc-4ae0-8aa7-036daf314ede while preserving
--      it in notes for auditability.
--   3. Enforce via trigger that 16-char format alone never sets ntpn_verified=true
--      and invalid NTPNs cannot be marked verified.
-- ============================================================================

BEGIN;

ALTER TABLE public.tax_payments
  ADD COLUMN IF NOT EXISTS ntpn_format_valid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ntpn_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS ntpn_verified_by uuid;

-- Preserve mistaken NPWP in notes and clear it from ntpn
UPDATE public.tax_payments
SET
  notes = CASE
    WHEN COALESCE(notes, '') LIKE '%cleared mistaken company NPWP 0268760261042000%' THEN notes
    ELSE trim(BOTH ' ' FROM COALESCE(notes, '') || ' [Audit cleanup 2026-11-25: cleared mistaken company NPWP 0268760261042000 from ntpn field]')
  END,
  ntpn = NULL,
  ntpn_format_valid = false,
  ntpn_verified = false,
  ntpn_verified_at = NULL,
  ntpn_verified_by = NULL
WHERE id = 'c7940eda-2fbc-4ae0-8aa7-036daf314ede'
  AND trim(COALESCE(ntpn, '')) = '0268760261042000';

CREATE OR REPLACE FUNCTION public.sync_tax_payment_ntpn_flags()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trimmed text := NULLIF(trim(COALESCE(NEW.ntpn, '')), '');
BEGIN
  NEW.ntpn_format_valid := (
    v_trimmed IS NOT NULL
    AND v_trimmed ~ '^[A-Za-z0-9]{16}$'
    AND v_trimmed <> '0268760261042000'
  );

  IF TG_OP = 'INSERT' THEN
    -- A 16-char format alone never proves DJP verification.
    IF NEW.ntpn_verified IS TRUE AND NEW.ntpn_verified_at IS NULL THEN
      NEW.ntpn_verified := false;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF v_trimmed IS DISTINCT FROM NULLIF(trim(COALESCE(OLD.ntpn, '')), '') THEN
      IF NEW.ntpn_verified IS NOT TRUE OR NEW.ntpn_verified_at IS NOT DISTINCT FROM OLD.ntpn_verified_at THEN
        NEW.ntpn_verified := false;
        NEW.ntpn_verified_at := NULL;
        NEW.ntpn_verified_by := NULL;
      END IF;
    END IF;
  END IF;

  IF NEW.ntpn_verified IS TRUE AND NOT NEW.ntpn_format_valid THEN
    RAISE EXCEPTION 'Cannot mark NTPN as DJP-verified without a valid 16-character alphanumeric NTPN';
  END IF;

  IF NEW.ntpn_verified IS NOT TRUE THEN
    NEW.ntpn_verified_at := NULL;
    NEW.ntpn_verified_by := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_tax_payment_ntpn_flags ON public.tax_payments;
CREATE TRIGGER trg_sync_tax_payment_ntpn_flags
  BEFORE INSERT OR UPDATE ON public.tax_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_tax_payment_ntpn_flags();

-- Recompute ntpn_format_valid and reset regex-only ntpn_verified flags
UPDATE public.tax_payments tp
SET
  ntpn_format_valid = (
    tp.ntpn IS NOT NULL
    AND trim(tp.ntpn) ~ '^[A-Za-z0-9]{16}$'
    AND trim(tp.ntpn) <> '0268760261042000'
  ),
  ntpn_verified = CASE
    WHEN tp.ntpn_verified_at IS NOT NULL THEN tp.ntpn_verified
    ELSE false
  END,
  ntpn_verified_at = CASE
    WHEN tp.ntpn_verified_at IS NOT NULL THEN tp.ntpn_verified_at
    ELSE NULL
  END,
  ntpn_verified_by = CASE
    WHEN tp.ntpn_verified_at IS NOT NULL THEN tp.ntpn_verified_by
    ELSE NULL
  END;

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261125220000', 'tax_ntpn_distinction_and_remaining_safeguards')
ON CONFLICT (version) DO NOTHING;

COMMIT;
