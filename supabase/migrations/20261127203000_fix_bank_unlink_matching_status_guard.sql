-- Fix Bank Reconciliation Unlink Constraint Failure:
--   guard_bank_statement_line_state() previously set NEW.matching_status := 'unmatched'
--   and NEW.reconciliation_status := 'suggested', both of which violate the table's
--   CHECK constraints (bank_statement_lines_matching_status_check allows only
--   'none', 'suggested', 'confirmed'; bank_statement_lines_reconciliation_status_check
--   allows only 'unmatched', 'partially_reconciled', 'matched', 'needs_review', 'recorded').
--
--   Also ensures a partial unlink (where other bank_statement_allocations still exist
--   on the bank statement line) does not wipe out matched_entry_id or force the line
--   back to 'unmatched'.

CREATE OR REPLACE FUNCTION public.guard_bank_statement_line_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- A manually unlinked row with no remaining allocations must not retain an active canonical match
  IF COALESCE(NEW.manually_unlinked, false) = true
     AND NOT EXISTS (
       SELECT 1
       FROM public.bank_statement_allocations AS bsa
       WHERE bsa.bank_statement_line_id = NEW.id
     ) THEN
    NEW.matched_entry_id := NULL;
    NEW.reconciliation_status := 'unmatched';
    NEW.matching_status := 'none';
  END IF;

  -- A suggested match must never be marked as confirmed/matched/recorded
  IF NEW.matching_status = 'suggested' AND NEW.reconciliation_status IN ('matched', 'recorded') THEN
    NEW.reconciliation_status := 'needs_review';
  END IF;

  RETURN NEW;
END;
$function$;
