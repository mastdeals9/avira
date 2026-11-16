-- ==============================================================================
-- MIGRATION: 20261115000000_security_hardening_storage_rls_and_privilege_escalation.sql
-- PURPOSE: Remediate critical security vulnerabilities identified in system audit:
--   1. Fix 11 SECURITY DEFINER functions missing SET search_path = public, pg_temp
--   2. Secure public.vw_universal_document_bank with security_invoker = true & revoke anon
--   3. Secure storage.objects against anonymous updates and unauthorized user deletes across all buckets
--   4. Prevent user_profiles privilege escalation via delete-recreate attack and reject NULL roles
--   5. Restrict invoke_process_whatsapp_campaign execution to internal service_role
-- NOTE: PREPARED LOCAL MIGRATION FOR REVIEW — DO NOT APPLY TO PRODUCTION UNTIL APPROVED BY OWNER.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. FIX 11 SECURITY DEFINER FUNCTIONS MISSING SEARCH_PATH
-- ------------------------------------------------------------------------------

ALTER FUNCTION public.current_user_has_pricing_role(text[])
  SET search_path = public, pg_temp;

ALTER FUNCTION public.edit_approved_finance_expense_atomic(uuid, jsonb, uuid, numeric)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_sync_batch_doc_to_universal()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_sync_crm_doc_to_universal()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_sync_product_doc_to_universal()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_sync_product_source_doc_to_universal()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.refresh_whatsapp_campaign_counts(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.save_finance_expense(uuid, jsonb)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.trg_fn_revert_bank_alloc_pph()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.trg_fn_sync_bank_alloc_pph()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.trg_sync_credit_note_invoice_payment()
  SET search_path = public, pg_temp;


-- ------------------------------------------------------------------------------
-- 2. SECURE UNIVERSAL DOCUMENT BANK VIEW
-- ------------------------------------------------------------------------------

-- Enable security_invoker so underlying table RLS is respected
ALTER VIEW public.vw_universal_document_bank SET (security_invoker = true);

-- Revoke all permissions from anon and public
REVOKE ALL ON public.vw_universal_document_bank FROM anon, public;

-- Grant SELECT only to authenticated users and service_role
GRANT SELECT ON public.vw_universal_document_bank TO authenticated, service_role;


-- ------------------------------------------------------------------------------
-- 3. SECURE SUPABASE STORAGE PERMISSIONS (storage.objects)
-- ------------------------------------------------------------------------------

-- Revoke dangerous direct DML grants from anon role on storage.objects
REVOKE INSERT, UPDATE, DELETE ON storage.objects FROM anon;

-- Drop the 7 overly permissive UPDATE policies that inadvertently granted access to public (including anon)
DROP POLICY IF EXISTS "Allow authenticated users to update batch documents" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to update crm documents" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to update documents" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to update expense documents" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to update petty cash receipts" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to update product documents" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to update source documents" ON storage.objects;

-- Recreate properly scoped UPDATE policies for authenticated users only, checking ownership or authorized staff role
DROP POLICY IF EXISTS "sec_update_batch_documents" ON storage.objects;
CREATE POLICY "sec_update_batch_documents" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'batch-documents' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts', 'manager']) AND is_active = true
      )
    )
  )
  WITH CHECK (
    bucket_id = 'batch-documents' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts', 'manager']) AND is_active = true
      )
    )
  );

DROP POLICY IF EXISTS "sec_update_crm_documents" ON storage.objects;
CREATE POLICY "sec_update_crm_documents" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'crm-documents' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts', 'sales', 'manager']) AND is_active = true
      )
    )
  )
  WITH CHECK (
    bucket_id = 'crm-documents' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts', 'sales', 'manager']) AND is_active = true
      )
    )
  );

DROP POLICY IF EXISTS "sec_update_documents" ON storage.objects;
CREATE POLICY "sec_update_documents" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'documents' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts']) AND is_active = true
      )
    )
  )
  WITH CHECK (
    bucket_id = 'documents' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts']) AND is_active = true
      )
    )
  );

DROP POLICY IF EXISTS "sec_update_expense_documents" ON storage.objects;
CREATE POLICY "sec_update_expense_documents" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'expense-documents' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts']) AND is_active = true
      )
    )
  )
  WITH CHECK (
    bucket_id = 'expense-documents' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts']) AND is_active = true
      )
    )
  );

DROP POLICY IF EXISTS "sec_update_petty_cash_receipts" ON storage.objects;
CREATE POLICY "sec_update_petty_cash_receipts" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'petty-cash-receipts' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts']) AND is_active = true
      )
    )
  )
  WITH CHECK (
    bucket_id = 'petty-cash-receipts' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts']) AND is_active = true
      )
    )
  );

DROP POLICY IF EXISTS "sec_update_product_documents" ON storage.objects;
CREATE POLICY "sec_update_product_documents" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'product-documents' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts', 'manager']) AND is_active = true
      )
    )
  )
  WITH CHECK (
    bucket_id = 'product-documents' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts', 'manager']) AND is_active = true
      )
    )
  );

DROP POLICY IF EXISTS "sec_update_product_source_documents" ON storage.objects;
CREATE POLICY "sec_update_product_source_documents" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'product-source-documents' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts', 'manager']) AND is_active = true
      )
    )
  )
  WITH CHECK (
    bucket_id = 'product-source-documents' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts', 'manager']) AND is_active = true
      )
    )
  );

-- Drop legacy unrestricted DELETE policies that override sec_delete_* policies
DROP POLICY IF EXISTS "Users can delete batch documents" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete expense documents" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete product documents" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to delete sales order documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete PO documents" ON storage.objects;

-- Replace unrestricted purchase invoice delete policy with ownership/admin-restricted policy
DROP POLICY IF EXISTS "Authenticated users can delete purchase invoices" ON storage.objects;
DROP POLICY IF EXISTS "sec_delete_purchase_invoices" ON storage.objects;
CREATE POLICY "sec_delete_purchase_invoices" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'purchase-invoices' AND (
      owner = (SELECT auth.uid()) OR
      EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts']) AND is_active = true
      )
    )
  );

-- Secure company-assets write policy to authenticated role only (RESTRICTIVE to prevent any permissive bypass)
DROP POLICY IF EXISTS "company_assets_admin_write" ON storage.objects;
DROP POLICY IF EXISTS "company_assets_restrictive_write" ON storage.objects;
CREATE POLICY "company_assets_restrictive_write" ON storage.objects
  AS RESTRICTIVE
  FOR ALL TO authenticated
  USING (
    bucket_id != 'company-assets' OR
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts']) AND is_active = true
    )
  )
  WITH CHECK (
    bucket_id != 'company-assets' OR
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = (SELECT auth.uid()) AND role = ANY(ARRAY['admin', 'accounts']) AND is_active = true
    )
  );


-- ------------------------------------------------------------------------------
-- 4. PREVENT USER PROFILE PRIVILEGE ESCALATION
-- ------------------------------------------------------------------------------

-- Drop policy allowing users to delete their own profile (self-deletion vector)
DROP POLICY IF EXISTS "Users can delete own profile" ON public.user_profiles;

-- Restrict profile creation: role CANNOT be NULL, non-admins restricted to ('sales', 'viewer') for own id
DROP POLICY IF EXISTS "Allow profile creation" ON public.user_profiles;
CREATE POLICY "Allow profile creation" ON public.user_profiles
  FOR INSERT TO authenticated
  WITH CHECK (
    role IS NOT NULL
    AND (
      -- Self-registration: user can only create their own profile with non-privileged roles
      (
        id = (SELECT auth.uid())
        AND role IN ('sales', 'viewer')
      )
      -- Administrator creation: active admins can create profiles for any user ID
      OR EXISTS (
        SELECT 1 FROM public.user_profiles admin_p
        WHERE admin_p.id = (SELECT auth.uid())
          AND admin_p.role = 'admin'
          AND admin_p.is_active = true
      )
    )
  );

-- Extend trigger to protect both INSERT and UPDATE operations, rejecting NULL roles
CREATE OR REPLACE FUNCTION public.prevent_self_privilege_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_admin boolean := false;
BEGIN
  -- Service role or postgres internal operations are permitted (when not impersonating a specific user)
  IF current_setting('request.jwt.claim.role', true) = 'service_role' 
     OR (session_user = 'postgres' AND auth.uid() IS NULL) THEN
    RETURN NEW;
  END IF;

  -- Check if executing user has active admin profile
  SELECT (role = 'admin' AND is_active = true) INTO v_is_admin
  FROM public.user_profiles
  WHERE id = auth.uid();

  IF TG_OP = 'INSERT' THEN
    -- Enforce explicit non-NULL role
    IF NEW.role IS NULL THEN
      RAISE EXCEPTION 'Privilege Violation: User profile role cannot be NULL';
    END IF;

    -- Block non-admin from creating a profile with privileged roles
    IF NEW.role NOT IN ('sales', 'viewer') AND NOT COALESCE(v_is_admin, false) THEN
      RAISE EXCEPTION 'Privilege Violation: Only administrators can assign privileged role "%"', NEW.role;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Enforce explicit non-NULL role on update
    IF NEW.role IS NULL THEN
      RAISE EXCEPTION 'Privilege Violation: User profile role cannot be NULL';
    END IF;

    -- Block non-admin from modifying roles
    IF OLD.role IS DISTINCT FROM NEW.role AND NOT COALESCE(v_is_admin, false) THEN
      RAISE EXCEPTION 'Privilege Violation: Users cannot change their own user role from "%" to "%"', OLD.role, NEW.role;
    END IF;

    -- Block non-admin from self-activating or modifying active status
    IF OLD.is_active IS DISTINCT FROM NEW.is_active AND NOT COALESCE(v_is_admin, false) THEN
      RAISE EXCEPTION 'Privilege Violation: Only administrators can modify active status';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_self_privilege_escalation ON public.user_profiles;
CREATE TRIGGER trg_prevent_self_privilege_escalation
  BEFORE INSERT OR UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_self_privilege_escalation();


-- ------------------------------------------------------------------------------
-- 5. SECURE WHATSAPP CAMPAIGN WORKER EXECUTION
-- ------------------------------------------------------------------------------

-- Revoke PUBLIC execution of invoke_process_whatsapp_campaign
REVOKE EXECUTE ON FUNCTION public.invoke_process_whatsapp_campaign() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_process_whatsapp_campaign() TO postgres, service_role;

-- Update invoke_process_whatsapp_campaign to remove hard-coded fallback secret
CREATE OR REPLACE FUNCTION public.invoke_process_whatsapp_campaign()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_due_count integer;
  v_worker_url text;
  v_worker_secret text;
BEGIN
  -- 1. Check if there are any in_progress campaigns due for dispatch
  SELECT count(*) INTO v_due_count
  FROM public.whatsapp_campaigns
  WHERE status = 'in_progress'
    AND (next_run_at IS NULL OR next_run_at <= now())
    AND (worker_lock_until IS NULL OR worker_lock_until < now());

  IF v_due_count = 0 THEN
    RETURN;
  END IF;

  v_worker_url := 'https://dkrtsqienlhpouohmfki.supabase.co/functions/v1/process-whatsapp-campaign';

  -- Retrieve secret securely from Vault
  BEGIN
    SELECT decrypted_secret INTO v_worker_secret
    FROM vault.decrypted_secrets
    WHERE name = 'whatsapp_worker_secret'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_worker_secret := NULL;
  END;

  IF v_worker_secret IS NULL OR v_worker_secret = '' THEN
    RAISE WARNING '[invoke_process_whatsapp_campaign] whatsapp_worker_secret not configured in Vault. Skipping dispatch.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM net.http_post(
      url := v_worker_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-WhatsApp-Worker-Secret', v_worker_secret
      ),
      body := jsonb_build_object(
        'source', 'pg_cron',
        'scheduled', true
      ),
      timeout_milliseconds := 25000
    );
  END IF;
END;
$$;
