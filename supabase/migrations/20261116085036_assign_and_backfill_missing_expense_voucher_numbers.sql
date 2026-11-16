BEGIN;

CREATE OR REPLACE FUNCTION public.assign_finance_expense_voucher_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.voucher_number IS NULL OR btrim(NEW.voucher_number) = '' THEN
    NEW.voucher_number := public.next_expense_voucher_number(NEW.expense_date);
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS aaa_assign_finance_expense_voucher_number
  ON public.finance_expenses;

CREATE TRIGGER aaa_assign_finance_expense_voucher_number
BEFORE INSERT ON public.finance_expenses
FOR EACH ROW
EXECUTE FUNCTION public.assign_finance_expense_voucher_number();

-- Backfill only existing rows whose voucher reference is actually missing.
-- Oldest record receives the next available number first.
DO $backfill$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id, expense_date
      FROM public.finance_expenses
     WHERE voucher_number IS NULL OR btrim(voucher_number) = ''
     ORDER BY created_at, id
     FOR UPDATE
  LOOP
    UPDATE public.finance_expenses
       SET voucher_number = public.next_expense_voucher_number(r.expense_date)
     WHERE id = r.id
       AND (voucher_number IS NULL OR btrim(voucher_number) = '');
  END LOOP;
END;
$backfill$;

COMMIT;
