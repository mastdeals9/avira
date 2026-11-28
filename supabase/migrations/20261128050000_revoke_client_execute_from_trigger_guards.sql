-- Remove client RPC EXECUTE access from trigger-only SECURITY DEFINER guards.
-- Their attached table triggers remain responsible for invoking them.
REVOKE EXECUTE ON FUNCTION public.guard_bank_statement_line_state() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_settled_salary_advance_edit() FROM authenticated;
