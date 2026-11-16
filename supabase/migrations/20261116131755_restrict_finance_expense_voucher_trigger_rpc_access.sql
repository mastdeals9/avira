BEGIN;
REVOKE ALL ON FUNCTION public.assign_finance_expense_voucher_number() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_finance_expense_voucher_number() TO service_role;
COMMIT;

