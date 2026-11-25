-- Migration: 20261125200000_final_closure_controls_and_reconciliation.sql
-- Description:
--   1. Align historical reversal pairs (JE2609-0021, JE2610-0053, JE2610-0056) with their originals
--      and remove the HR-REV prefix hack from vw_bank_ledger_effective for one canonical lifecycle rule.
--   2. Normalize stale bank_statement_lines flags and add a state-integrity guard trigger.
--   3. Add UOM conversion traceability columns to purchase_invoice_items and backfill Mometasone E0000274/2526.
--   4. Add explicit tax compliance evidence flags (bank_verified, ntpn_verified, document_attached, filing_verified)
--      without fabricating NTPNs or filing statuses.

BEGIN;

-- ============================================================================
-- 1. CANONICAL JOURNAL REVERSAL LIFECYCLE (UNIFY GL & BANK LEDGER)
-- ============================================================================

-- Pair JE2609-0021 (reversal of JE2608-0168), JE2610-0053 (reversal of JE2607-0083),
-- and JE2610-0056 (reversal of JE2610-0023) so both sides of each reversal pair carry
-- is_reversed = true, preserving the full audit trail and offsetting to 0.00 in all ledgers.
UPDATE public.journal_entries
SET is_reversed = true
WHERE entry_number IN ('JE2609-0021', 'JE2610-0053', 'JE2610-0056')
  AND is_posted = true
  AND NOT COALESCE(is_reversed, false)
  AND NOT COALESCE(is_cancelled, false);

-- Rebuild vw_bank_ledger_effective using the canonical lifecycle rule (no HR-REV prefix hack)
CREATE OR REPLACE VIEW public.vw_bank_ledger_effective
WITH (security_invoker = true) AS
SELECT ba.id AS bank_account_id,
  ba.account_number,
  ba.account_name,
  upper(ba.currency) AS bank_currency,
  je.id AS journal_entry_id,
  je.entry_number,
  je.entry_date,
  COALESCE(
    (SELECT min(bsl.transaction_date)
     FROM public.bank_statement_lines bsl
     WHERE bsl.bank_account_id = ba.id AND bsl.matched_entry_id = je.id),
    (SELECT min(bsl2.transaction_date)
     FROM public.bank_statement_allocations a
     JOIN public.bank_statement_lines bsl2 ON bsl2.id = a.bank_statement_line_id
     WHERE a.journal_entry_id = je.id AND bsl2.bank_account_id = ba.id),
    je.entry_date
  ) AS effective_bank_date,
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
  'effective_posted'::text AS ledger_treatment
FROM public.bank_accounts ba
JOIN public.journal_entry_lines jel ON jel.account_id = ba.coa_id
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE je.is_posted = true
  AND NOT COALESCE(je.is_reversed, false)
  AND NOT COALESCE(je.is_cancelled, false)
  AND (
    upper(ba.currency) <> 'USD'::text
    OR jel.transaction_currency = 'USD'::text
    OR (jel.debit = 0::numeric AND jel.credit = 0::numeric)
    OR COALESCE(jel.transaction_debit, 0::numeric) > 0::numeric
    OR COALESCE(jel.transaction_credit, 0::numeric) > 0::numeric
  );

-- ============================================================================
-- 2. BANK RECONCILIATION STATE CLEANUP & INTEGRITY GUARD
-- ============================================================================

-- Normalize rows that already have active canonical bank_statement_allocations
UPDATE public.bank_statement_lines bsl
SET
  manually_unlinked = false,
  matching_status = CASE
    WHEN bsl.matched_expense_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.bank_statement_lines other
        WHERE other.id <> bsl.id
          AND other.matched_expense_id = bsl.matched_expense_id
          AND (other.matching_status = 'confirmed' OR other.id < bsl.id)
      )
    THEN bsl.matching_status
    ELSE 'confirmed'
  END
WHERE EXISTS (
  SELECT 1 FROM public.bank_statement_allocations bsa
  WHERE bsa.bank_statement_line_id = bsl.id
)
  AND (
    bsl.matching_status IS DISTINCT FROM 'confirmed'
    OR COALESCE(bsl.manually_unlinked, false) = true
  );

CREATE OR REPLACE FUNCTION public.guard_bank_statement_line_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- A manually unlinked row must not retain an active canonical match
  IF COALESCE(NEW.manually_unlinked, false) = true THEN
    NEW.matched_entry_id := NULL;
    NEW.reconciliation_status := 'unmatched';
    NEW.matching_status := 'unmatched';
  END IF;

  -- A suggested match must never be marked as confirmed/matched/recorded
  IF NEW.matching_status = 'suggested' AND NEW.reconciliation_status IN ('matched', 'recorded') THEN
    NEW.reconciliation_status := 'suggested';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_bank_statement_line_state() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_guard_bank_statement_line_state ON public.bank_statement_lines;
CREATE TRIGGER trg_guard_bank_statement_line_state
  BEFORE INSERT OR UPDATE ON public.bank_statement_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_bank_statement_line_state();

-- ============================================================================
-- 3. UOM CONVERSION TRACEABILITY ON PURCHASE INVOICE ITEMS
-- ============================================================================

ALTER TABLE public.purchase_invoice_items
  ADD COLUMN IF NOT EXISTS uom_conversion_factor numeric,
  ADD COLUMN IF NOT EXISTS normalized_quantity numeric,
  ADD COLUMN IF NOT EXISTS normalized_unit text;

-- Preserve original supplier UOM (0.250 KG) on E0000274/2526 Mometasone Furoate
-- while recording the verified normalized stock UOM (250.000 g, factor 1000).
UPDATE public.purchase_invoice_items pii
SET
  uom_conversion_factor = 1000,
  normalized_quantity = pii.quantity * 1000,
  normalized_unit = 'g'
FROM public.purchase_invoices pi, public.products p
WHERE pii.purchase_invoice_id = pi.id
  AND pii.product_id = p.id
  AND pi.invoice_number = 'E0000274/2526'
  AND p.product_name ILIKE '%Mometasone%'
  AND upper(COALESCE(pii.unit, '')) = 'KG'
  AND lower(COALESCE(p.unit, '')) = 'g'
  AND pii.normalized_quantity IS NULL;

-- ============================================================================
-- 4. TAX COMPLIANCE EVIDENCE STATES (NO FABRICATED NTPNs OR FILING STATUSES)
-- ============================================================================

ALTER TABLE public.tax_payments
  ADD COLUMN IF NOT EXISTS bank_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ntpn_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS document_attached boolean NOT NULL DEFAULT false;

ALTER TABLE public.tax_periods
  ADD COLUMN IF NOT EXISTS filing_verified boolean NOT NULL DEFAULT false;

UPDATE public.tax_payments tp
SET
  bank_verified = EXISTS (
    SELECT 1 FROM public.bank_statement_allocations bsa
    WHERE bsa.document_type = 'tax_payment' AND bsa.document_id = tp.id
  ),
  -- Valid DJP NTPN is 16 alphanumeric chars and must not be the company NPWP (0268760261042000)
  ntpn_verified = (
    tp.ntpn IS NOT NULL
    AND trim(tp.ntpn) ~ '^[A-Za-z0-9]{16}$'
    AND trim(tp.ntpn) <> '0268760261042000'
  ),
  document_attached = EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'documents'
      AND o.name LIKE ('tax_payments/' || tp.id::text || '/%')
  );

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261125200000', 'final_closure_controls_and_reconciliation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
