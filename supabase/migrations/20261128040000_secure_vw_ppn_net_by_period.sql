-- ============================================================================
-- Migration: Enforce security_invoker and least-privilege on vw_ppn_net_by_period
-- ============================================================================

ALTER VIEW public.vw_ppn_net_by_period SET (security_invoker = true);

REVOKE ALL ON public.vw_ppn_net_by_period FROM PUBLIC, anon;
GRANT SELECT ON public.vw_ppn_net_by_period TO authenticated, service_role;
