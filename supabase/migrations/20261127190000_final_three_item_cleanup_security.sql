-- Final Three-Item Cleanup: Security Hardening
-- 1. Set inventory_gl_valuation_reconciliation to security_invoker = true
-- 2. Revoke PUBLIC, anon, and authenticated EXECUTE on internal/trigger functions:
--      derive_journal_header_totals_from_lines()
--      sync_petty_cash_book_balances()
--      trg_fn_sync_petty_cash_book_balances()
-- 3. Preserve all triggers and preserve lookup_login_email(text) anonymous access.

ALTER VIEW public.inventory_gl_valuation_reconciliation SET (security_invoker = true);
GRANT SELECT ON public.inventory_gl_valuation_reconciliation TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.derive_journal_header_totals_from_lines() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.derive_journal_header_totals_from_lines() TO service_role;

REVOKE ALL ON FUNCTION public.sync_petty_cash_book_balances() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_petty_cash_book_balances() TO service_role;

REVOKE ALL ON FUNCTION public.trg_fn_sync_petty_cash_book_balances() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_fn_sync_petty_cash_book_balances() TO service_role;
