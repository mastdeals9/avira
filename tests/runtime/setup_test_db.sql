-- ==============================================================================
-- SETUP SCRIPT FOR LOCAL DISPOSABLE DATABASE RUNTIME SECURITY TESTING
-- Port: 54333 (Local Disposable Container ONLY — Zero connection to production)
-- ==============================================================================

-- 1. SCHEMAS
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE SCHEMA IF NOT EXISTS extensions;

-- Grant usage
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA vault TO service_role;

-- 2. USER PROFILES TABLE (Pre-migration baseline)
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text,
  email text,
  full_name text,
  role text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_profiles TO anon, authenticated, service_role;

-- Pre-migration policy 1: Allow profile creation (unconstrained role check)
CREATE POLICY "Allow profile creation" ON public.user_profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = (SELECT auth.uid()));

-- Pre-migration policy 2: Users can delete own profile (vulnerable self-delete vector)
CREATE POLICY "Users can delete own profile" ON public.user_profiles
  FOR DELETE TO authenticated
  USING (id = (SELECT auth.uid()));

-- Pre-migration policy 3: Users can view profiles
CREATE POLICY "Users can view user profiles" ON public.user_profiles
  FOR SELECT TO authenticated
  USING (true);

-- Pre-migration policy 4: Users can update own profile
CREATE POLICY "Users can update own user profile" ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- Pre-migration trigger function (UPDATE only)
CREATE OR REPLACE FUNCTION public.prevent_self_privilege_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_is_admin boolean := false;
BEGIN
  IF current_setting('request.jwt.claim.role', true) = 'service_role' OR session_user = 'postgres' THEN
    RETURN NEW;
  END IF;

  SELECT (role = 'admin' AND is_active = true) INTO v_is_admin
  FROM public.user_profiles
  WHERE id = auth.uid();

  IF TG_OP = 'UPDATE' THEN
    IF OLD.role IS DISTINCT FROM NEW.role AND NOT COALESCE(v_is_admin, false) THEN
      RAISE EXCEPTION 'Privilege Violation: Users cannot change their own user role';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_prevent_self_privilege_escalation
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_self_privilege_escalation();


-- 3. STORAGE SCHEMA & ALL 14 BUCKETS
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  public boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  metadata jsonb
);

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT ALL ON storage.buckets TO authenticated, service_role;
GRANT ALL ON storage.objects TO authenticated, service_role;
-- Pre-migration: anon had direct DML grants and public had UPDATE policies
GRANT INSERT, UPDATE, DELETE, SELECT ON storage.objects TO anon;

-- Populate all 14 buckets
INSERT INTO storage.buckets (id, name, public) VALUES
  ('batch-documents', 'batch-documents', false),
  ('crm-documents', 'crm-documents', false),
  ('documents', 'documents', false),
  ('expense-documents', 'expense-documents', false),
  ('petty-cash-receipts', 'petty-cash-receipts', false),
  ('product-documents', 'product-documents', false),
  ('product-source-documents', 'product-source-documents', false),
  ('purchase-invoices', 'purchase-invoices', false),
  ('sales-order-documents', 'sales-order-documents', false),
  ('bank-statements', 'bank-statements', false),
  ('company-assets', 'company-assets', false),
  ('inventory_photos', 'inventory_photos', false),
  ('rejection_photos', 'rejection_photos', false),
  ('task-attachments', 'task-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- Standard baseline storage SELECT policies for authenticated users
CREATE POLICY "Authenticated users can read storage objects" ON storage.objects
  FOR SELECT TO authenticated
  USING (true);

-- Baseline INSERT policy: authenticated users can upload
CREATE POLICY "Authenticated users can insert storage objects" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (owner = (SELECT auth.uid()));

-- Pre-migration vulnerable 7 UPDATE policies granted to public (including anon)
CREATE POLICY "Allow authenticated users to update batch documents" ON storage.objects
  FOR UPDATE TO public USING (bucket_id = 'batch-documents');
CREATE POLICY "Allow authenticated users to update crm documents" ON storage.objects
  FOR UPDATE TO public USING (bucket_id = 'crm-documents');
CREATE POLICY "Allow authenticated users to update documents" ON storage.objects
  FOR UPDATE TO public USING (bucket_id = 'documents');
CREATE POLICY "Allow authenticated users to update expense documents" ON storage.objects
  FOR UPDATE TO public USING (bucket_id = 'expense-documents');
CREATE POLICY "Allow authenticated users to update petty cash receipts" ON storage.objects
  FOR UPDATE TO public USING (bucket_id = 'petty-cash-receipts');
CREATE POLICY "Allow authenticated users to update product documents" ON storage.objects
  FOR UPDATE TO public USING (bucket_id = 'product-documents');
CREATE POLICY "Allow authenticated users to update source documents" ON storage.objects
  FOR UPDATE TO public USING (bucket_id = 'product-source-documents');

-- Pre-migration legacy permissive DELETE policies
CREATE POLICY "Users can delete batch documents" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'batch-documents');
CREATE POLICY "Users can delete expense documents" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'expense-documents');
CREATE POLICY "Users can delete product documents" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'product-documents');
CREATE POLICY "Allow authenticated users to delete sales order documents" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'sales-order-documents');
CREATE POLICY "Authenticated users can delete PO documents" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'purchase-invoices');
CREATE POLICY "Authenticated users can delete purchase invoices" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'purchase-invoices');
CREATE POLICY "company_assets_admin_write" ON storage.objects
  FOR ALL TO public USING (bucket_id = 'company-assets');


-- 4. UNIVERSAL DOCUMENT BANK (Pre-migration baseline)
CREATE TABLE IF NOT EXISTS public.universal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  document_type text NOT NULL,
  is_confidential boolean DEFAULT false,
  lifecycle_status text DEFAULT 'ACTIVE',
  created_by uuid,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.universal_document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES public.universal_documents(id) ON DELETE CASCADE,
  entity_type text,
  entity_id uuid,
  created_by uuid,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.universal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.universal_document_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "universal_documents_read_policy" ON public.universal_documents
  FOR SELECT TO authenticated
  USING (
    NOT is_confidential
    OR auth.uid() = created_by
    OR EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'manager')
    )
  );

CREATE POLICY "universal_documents_insert_policy" ON public.universal_documents
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "universal_document_links_read_policy" ON public.universal_document_links
  FOR SELECT TO authenticated USING (true);

-- Pre-migration view: SECURITY DEFINER mode (security_invoker = false / null) and granted to anon
CREATE OR REPLACE VIEW public.vw_universal_document_bank AS
SELECT 
  d.id,
  d.title,
  d.document_type,
  d.is_confidential,
  d.lifecycle_status,
  d.created_by,
  d.created_at
FROM public.universal_documents d;

GRANT SELECT ON public.vw_universal_document_bank TO anon, authenticated, service_role;


-- 5. THE 11 SECURITY DEFINER FUNCTIONS (Pre-migration state: no search_path)
CREATE OR REPLACE FUNCTION public.current_user_has_pricing_role(allowed_roles text[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid() AND role = ANY(allowed_roles) AND is_active = true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.edit_approved_finance_expense_atomic(p_expense_id uuid, p_payload jsonb, p_bank_statement_line_id uuid DEFAULT NULL, p_allocation_amount numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_sync_batch_doc_to_universal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION public.fn_sync_crm_doc_to_universal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION public.fn_sync_product_doc_to_universal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION public.fn_sync_product_source_doc_to_universal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION public.refresh_whatsapp_campaign_counts(p_campaign_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN NULL; END; $$;

CREATE OR REPLACE FUNCTION public.save_finance_expense(p_expense_id uuid, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN jsonb_build_object('id', p_expense_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_fn_revert_bank_alloc_pph()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN RETURN OLD; END; $$;

CREATE OR REPLACE FUNCTION public.trg_fn_sync_bank_alloc_pph()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION public.trg_sync_credit_note_invoice_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN RETURN NEW; END; $$;


-- 6. VAULT & WHATSAPP CAMPAIGN (Pre-migration state)
CREATE TABLE IF NOT EXISTS vault.decrypted_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE,
  decrypted_secret text
);

CREATE TABLE IF NOT EXISTS public.whatsapp_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text,
  next_run_at timestamptz,
  worker_lock_until timestamptz
);

-- Pre-migration invoke function: granted to PUBLIC, hard-coded fallback secret
CREATE OR REPLACE FUNCTION public.invoke_process_whatsapp_campaign()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_secret text := 'sapj_wa_worker_internal_2026';
BEGIN
  -- Dummy implementation representing old state
  NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.invoke_process_whatsapp_campaign() TO PUBLIC, anon, authenticated;

