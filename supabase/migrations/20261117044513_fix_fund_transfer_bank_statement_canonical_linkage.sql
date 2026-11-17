-- Keep Contra/Fund Transfer bank-statement links synchronized with canonical allocations.
-- Existing UI updates to posted fund_transfers previously wrote only the legacy
-- matched_fund_transfer_id field. This trigger now creates/refreshes the
-- bank_statement_allocations row using the existing validated reconciliation RPC.

BEGIN;

CREATE OR REPLACE FUNCTION public.update_fund_transfer_bank_links()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ft public.fund_transfers%rowtype;
BEGIN
  -- Re-read the row because the AFTER INSERT auto-post trigger may have
  -- generated and attached the canonical journal entry earlier in this event.
  SELECT *
    INTO v_ft
    FROM public.fund_transfers
   WHERE id = NEW.id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fund Transfer % not found while synchronizing bank links', NEW.id;
  END IF;

  IF v_ft.status <> 'posted' OR v_ft.journal_entry_id IS NULL THEN
    -- A bank statement line must not be treated as reconciled against a
    -- pending/unposted contra. Refuse the link rather than create a false match.
    IF v_ft.from_bank_statement_line_id IS NOT NULL
       OR v_ft.to_bank_statement_line_id IS NOT NULL THEN
      RAISE EXCEPTION 'Fund Transfer % must be posted with an active journal before bank statement linkage', v_ft.transfer_number;
    END IF;
    RETURN NEW;
  END IF;

  -- Outgoing bank side (statement debit).
  IF v_ft.from_bank_statement_line_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
        FROM public.bank_statement_allocations a
       WHERE a.bank_statement_line_id = v_ft.from_bank_statement_line_id
         AND a.document_type = 'fund_transfer'
         AND a.document_id = v_ft.id
    ) THEN
      -- Preserve historical payment_kind values; do not create a duplicate
      -- allocation simply because an older row used 'supplier'.
      PERFORM public.sync_bank_line_allocation_owner(v_ft.from_bank_statement_line_id);
      PERFORM public.refresh_bank_statement_allocation_status(v_ft.from_bank_statement_line_id);
    ELSE
      PERFORM public.link_bank_statement_line(
        v_ft.from_bank_statement_line_id,
        'fund_transfer',
        v_ft.id,
        'fund_transfer',
        v_ft.from_amount
      );
    END IF;
  END IF;

  -- Incoming bank side (statement credit).
  IF v_ft.to_bank_statement_line_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
        FROM public.bank_statement_allocations a
       WHERE a.bank_statement_line_id = v_ft.to_bank_statement_line_id
         AND a.document_type = 'fund_transfer'
         AND a.document_id = v_ft.id
    ) THEN
      PERFORM public.sync_bank_line_allocation_owner(v_ft.to_bank_statement_line_id);
      PERFORM public.refresh_bank_statement_allocation_status(v_ft.to_bank_statement_line_id);
    ELSE
      PERFORM public.link_bank_statement_line(
        v_ft.to_bank_statement_line_id,
        'fund_transfer',
        v_ft.id,
        'fund_transfer',
        v_ft.to_amount
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;

