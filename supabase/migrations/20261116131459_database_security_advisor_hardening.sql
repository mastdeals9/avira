-- ==============================================================================
-- SAPJ / Anzen ERP — Prompt 8B: Database Security Advisor Hardening
-- Environment: Supabase PostgreSQL (dkrtsqienlhpouohmfki - AWS ap-southeast-1)
-- Mode: REVIEW ONLY — READY FOR OWNER DEPLOYMENT (NOT EXECUTED AGAINST PROD)
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. RESOLVE 15 MUTABLE SEARCH_PATH WARNINGS
-- Prevents search_path hijacking by pinning execution context to public, pg_temp
-- ==============================================================================

ALTER FUNCTION public.current_user_has_pricing_role(allowed_roles text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.edit_approved_finance_expense_atomic(p_expense_id uuid, p_payload jsonb, p_bank_statement_line_id uuid, p_allocation_amount numeric) SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_sync_batch_doc_to_universal() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_sync_crm_doc_to_universal() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_sync_product_doc_to_universal() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_sync_product_source_doc_to_universal() SET search_path = public, pg_temp;
ALTER FUNCTION public.refresh_whatsapp_campaign_counts(p_campaign_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.save_finance_expense(p_expense_id uuid, p_payload jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_fn_revert_bank_alloc_pph() SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_fn_sync_bank_alloc_pph() SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_sync_credit_note_invoice_payment() SET search_path = public, pg_temp;
ALTER FUNCTION public.calculate_finance_expense_payable(p_expense_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_invoice_credit_note_amount(p_invoice_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.is_reportable_sales_invoice(p_document_status text, p_is_draft boolean, p_notes text) SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_sync_sales_invoice_document_status() SET search_path = public, pg_temp;

-- ==============================================================================
-- 2. HARDEN VIEW SECURITY: vw_universal_document_bank
-- Sets security_invoker = true so Row-Level Security (RLS) on underlying tables
-- (universal_documents, universal_document_versions) is strictly enforced,
-- preventing unauthorized disclosure of confidential document metadata.
-- ==============================================================================

ALTER VIEW public.vw_universal_document_bank SET (security_invoker = true);

-- ==============================================================================
-- 3. HARDEN 16 ANON EXECUTION WARNINGS & TRIGGER EXPOSURES
-- Revoke unauthenticated execution from internal triggers, background workers,
-- and non-public procedures while preserving legitimate login resolution.
-- ==============================================================================

-- 3.1 WhatsApp Background Dispatcher (CRITICAL SECURITY EXPOSURE)
-- Must NOT be callable anonymously or by regular users; only pg_cron/service_role
REVOKE ALL ON FUNCTION public.invoke_process_whatsapp_campaign() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_process_whatsapp_campaign() TO service_role;

-- 3.2 WhatsApp Campaign Delivery Counts Aggregator
-- Used by delivery report component; should NOT be callable anonymously
REVOKE ALL ON FUNCTION public.refresh_whatsapp_campaign_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_whatsapp_campaign_counts(uuid) TO authenticated, service_role;

-- 3.3 Trigger Functions Exposed to Anon / Public
-- Trigger functions have return type 'trigger' and must never be exposed as RPCs
REVOKE ALL ON FUNCTION public.enforce_inventory_transaction_operation_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_inventory_transaction_operation_id() TO service_role;
REVOKE ALL ON FUNCTION public.enforce_pph_allocation_period_lock() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_pph_allocation_period_lock() TO service_role;
REVOKE ALL ON FUNCTION public.fn_sync_batch_doc_to_universal() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_batch_doc_to_universal() TO service_role;
REVOKE ALL ON FUNCTION public.fn_sync_crm_doc_to_universal() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_crm_doc_to_universal() TO service_role;
REVOKE ALL ON FUNCTION public.fn_sync_product_doc_to_universal() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_product_doc_to_universal() TO service_role;
REVOKE ALL ON FUNCTION public.fn_sync_product_source_doc_to_universal() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_product_source_doc_to_universal() TO service_role;
REVOKE ALL ON FUNCTION public.prevent_cash_on_hand_fund_transfer() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_cash_on_hand_fund_transfer() TO service_role;
REVOKE ALL ON FUNCTION public.prevent_expense_payment_overallocation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_expense_payment_overallocation() TO service_role;
REVOKE ALL ON FUNCTION public.prevent_gl1101_posting() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_gl1101_posting() TO service_role;
REVOKE ALL ON FUNCTION public.prevent_unsafe_settled_salary_edit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_unsafe_settled_salary_edit() TO service_role;
REVOKE ALL ON FUNCTION public.sync_credit_note_material_return() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_credit_note_material_return() TO service_role;
REVOKE ALL ON FUNCTION public.sync_purchase_invoice_payment_state_from_pv_posting() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_purchase_invoice_payment_state_from_pv_posting() TO service_role;
REVOKE ALL ON FUNCTION public.sync_si_state_on_rv_posting_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_si_state_on_rv_posting_change() TO service_role;
REVOKE ALL ON FUNCTION public.trg_fn_revert_bank_alloc_pph() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_fn_revert_bank_alloc_pph() TO service_role;
REVOKE ALL ON FUNCTION public.trg_fn_revert_petty_cash_pph() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_fn_revert_petty_cash_pph() TO service_role;
REVOKE ALL ON FUNCTION public.trg_fn_revert_voucher_alloc_pph() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_fn_revert_voucher_alloc_pph() TO service_role;
REVOKE ALL ON FUNCTION public.trg_fn_sync_bank_alloc_pph() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_fn_sync_bank_alloc_pph() TO service_role;
REVOKE ALL ON FUNCTION public.trg_fn_sync_payment_voucher_header_pph() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_fn_sync_payment_voucher_header_pph() TO service_role;
REVOKE ALL ON FUNCTION public.trg_fn_sync_petty_cash_pph() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_fn_sync_petty_cash_pph() TO service_role;
REVOKE ALL ON FUNCTION public.trg_fn_sync_voucher_alloc_pph() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_fn_sync_voucher_alloc_pph() TO service_role;
REVOKE ALL ON FUNCTION public.trg_import_containers_ndpbm_sync() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_import_containers_ndpbm_sync() TO service_role;
REVOKE ALL ON FUNCTION public.trg_salary_advance_application_recalc() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_salary_advance_application_recalc() TO service_role;
REVOKE ALL ON FUNCTION public.trg_validate_credit_note_integrity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_validate_credit_note_integrity() TO service_role;
REVOKE ALL ON FUNCTION public.trg_validate_credit_note_item_quantities() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_validate_credit_note_item_quantities() TO service_role;
REVOKE ALL ON FUNCTION public.validate_credit_note_item_quantities() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_credit_note_item_quantities() TO service_role;
REVOKE ALL ON FUNCTION public.validate_material_return_item() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_material_return_item() TO service_role;
REVOKE ALL ON FUNCTION public.validate_tax_expense_linkage() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_tax_expense_linkage() TO service_role;

-- 3.4 Explicitly Preserve Legitimate Anonymous Login Resolution
-- lookup_login_email is required by AuthContext for username-based logins
GRANT EXECUTE ON FUNCTION public.lookup_login_email(text) TO anon, authenticated, service_role;

-- ==============================================================================
-- 4. HARDEN BACKGROUND WORKERS, HISTORICAL REPAIRS & MOVING COST CALCULATIONS
-- Revoke execute from anon and authenticated on internal processing routines
-- and backend-only workers, granting strictly to service_role / postgres.
-- ==============================================================================

-- 4.1 Bulk Email Background Worker & Claiming Routines
-- Called strictly by pg_cron or Edge Function (process-bulk-email-campaign) using service_role
REVOKE ALL ON FUNCTION public.invoke_bulk_email_worker() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_bulk_email_worker() TO service_role;

REVOKE ALL ON FUNCTION public.claim_bulk_email_campaign(uuid, text, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_bulk_email_campaign(uuid, text, integer, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.claim_bulk_email_recipients(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_bulk_email_recipients(uuid, integer, text) TO service_role;

-- 4.2 Historical Finance Repair Routines
-- Administrative/backend routines that modify historical document linkages
REVOKE ALL ON FUNCTION public.run_deterministic_finance_historical_repair() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_deterministic_finance_historical_repair() TO service_role;

REVOKE ALL ON FUNCTION public.audit_legacy_bank_reconciliation_source_documents(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_legacy_bank_reconciliation_source_documents(uuid) TO service_role;

-- 4.3 Batch Receipt Weighted Average Moving Cost
-- Internal calculation invoked strictly by receive_purchase_invoice_item()
REVOKE ALL ON FUNCTION public.apply_batch_receipt_weighted_average(uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_batch_receipt_weighted_average(uuid, numeric, numeric) TO service_role;

-- ==============================================================================
-- 5. REINFORCE AUTHORIZATION GUARDS ON PRIVILEGED CLIENT FUNCTIONS
-- ==============================================================================

-- 5.1 archive_old_records: Enforce NULL-safe admin role check
CREATE OR REPLACE FUNCTION public.archive_old_records()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_notifications_deleted integer := 0;
  v_gmail_deleted integer := 0;
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Permission denied: only admin can archive old records';
  END IF;

  DELETE FROM notifications
  WHERE is_read = true
    AND created_at < now() - interval '90 days';
  GET DIAGNOSTICS v_notifications_deleted = ROW_COUNT;

  DELETE FROM notifications
  WHERE is_read = false
    AND created_at < now() - interval '180 days';

  DELETE FROM gmail_processed_messages
  WHERE created_at < now() - interval '60 days';
  GET DIAGNOSTICS v_gmail_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'notifications_deleted', v_notifications_deleted,
    'gmail_processed_deleted', v_gmail_deleted,
    'archived_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.archive_old_records() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_old_records() TO authenticated, service_role;

-- 5.2 auto_reconcile_bank_statement: Enforce finance authorization guard
CREATE OR REPLACE FUNCTION public.auto_reconcile_bank_statement(p_upload_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_line RECORD;
  v_matched_count INTEGER := 0;
  v_conflict_count INTEGER := 0;
  v_unmatched_count INTEGER := 0;
  v_total_processed INTEGER := 0;

  -- Candidates table variables
  v_exact_match_id UUID;
  v_exact_match_type TEXT;
  v_total_candidates INTEGER;
  v_cand_types TEXT[];
  v_cand_refs TEXT[];
  v_cand_ids UUID[];
BEGIN
  -- Finance Authorization Guard: Prevent unauthorized invocation by non-finance roles
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'accounts', 'auditor_ca')
        AND is_active = true
    ) THEN
      RAISE EXCEPTION 'Access denied: bank reconciliation requires finance or administrative privileges';
    END IF;
  END IF;

  FOR v_line IN
    SELECT bsl.*
    FROM public.bank_statement_lines bsl
    WHERE (p_upload_id IS NULL OR bsl.upload_id = p_upload_id)
      AND bsl.reconciliation_status IN ('unmatched', 'suggested', 'conflict')
      AND NOT COALESCE(bsl.manually_unlinked, false)
    ORDER BY bsl.transaction_date ASC
  LOOP
    v_total_processed := v_total_processed + 1;
    v_exact_match_id := NULL;
    v_exact_match_type := NULL;
    v_cand_types := ARRAY[]::TEXT[];
    v_cand_refs := ARRAY[]::TEXT[];
    v_cand_ids := ARRAY[]::UUID[];

    -- ─────────────────────────────────────────────────────────────────────────
    -- 1. OUTGOING DEBIT TRANSACTIONS (Money Out)
    -- ─────────────────────────────────────────────────────────────────────────
    IF v_line.debit_amount > 0 THEN
      -- A. Payment Vouchers
      SELECT 
        COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        COALESCE(array_agg('payment'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT pv.id, pv.voucher_number as ref
        FROM public.payment_vouchers pv
        WHERE pv.bank_account_id = v_line.bank_account_id
          AND pv.is_posted = true
          AND abs(COALESCE(pv.actual_bank_debit, pv.bank_amount, pv.amount + COALESCE(pv.bank_charge, 0)) - v_line.debit_amount) < 0.01
          AND abs(pv.voucher_date - v_line.transaction_date) <= 5
          AND pv.id NOT IN (
            SELECT matched_payment_id FROM public.bank_statement_lines
            WHERE matched_payment_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;

      -- B. Finance Expenses
      SELECT 
        v_cand_ids || COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        v_cand_refs || COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        v_cand_types || COALESCE(array_agg('expense'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT fe.id, fe.voucher_number as ref
        FROM public.finance_expenses fe
        WHERE fe.bank_account_id = v_line.bank_account_id
          AND fe.approval_status = 'approved'
          AND abs(fe.amount - v_line.debit_amount) < 0.01
          AND abs(fe.expense_date - v_line.transaction_date) <= 5
          AND fe.id NOT IN (
            SELECT matched_expense_id FROM public.bank_statement_lines
            WHERE matched_expense_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;

      -- C. Fund Transfers Out
      SELECT 
        v_cand_ids || COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        v_cand_refs || COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        v_cand_types || COALESCE(array_agg('fund_transfer'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT ft.id, ft.transfer_number as ref
        FROM public.fund_transfers ft
        WHERE ft.from_bank_account_id = v_line.bank_account_id
          AND ft.status = 'posted'
          AND abs(COALESCE(ft.from_amount, ft.amount) - v_line.debit_amount) < 0.01
          AND abs(ft.transfer_date - v_line.transaction_date) <= 5
          AND ft.id NOT IN (
            SELECT matched_fund_transfer_id FROM public.bank_statement_lines
            WHERE matched_fund_transfer_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;

      -- D. Tax Payments
      SELECT 
        v_cand_ids || COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        v_cand_refs || COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        v_cand_types || COALESCE(array_agg('tax_payment'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT tp.id, COALESCE(tp.ntpn, tp.billing_code, 'TAX') as ref
        FROM public.tax_payments tp
        WHERE tp.bank_account_id = v_line.bank_account_id
          AND abs(tp.amount - v_line.debit_amount) < 0.01
          AND abs(tp.payment_date - v_line.transaction_date) <= 5
          AND tp.id NOT IN (
            SELECT matched_tax_payment_id FROM public.bank_statement_lines
            WHERE matched_tax_payment_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;

      -- E. Petty Cash Vouchers
      SELECT 
        v_cand_ids || COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        v_cand_refs || COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        v_cand_types || COALESCE(array_agg('petty_cash'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT pcv.id, pcv.voucher_number as ref
        FROM public.petty_cash_vouchers pcv
        WHERE abs(pcv.amount - v_line.debit_amount) < 0.01
          AND abs(pcv.voucher_date - v_line.transaction_date) <= 5
          AND pcv.id NOT IN (
            SELECT matched_petty_cash_id FROM public.bank_statement_lines
            WHERE matched_petty_cash_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 2. INCOMING CREDIT TRANSACTIONS (Money In)
    -- ─────────────────────────────────────────────────────────────────────────
    ELSIF v_line.credit_amount > 0 THEN
      -- A. Receipt Vouchers
      SELECT 
        COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        COALESCE(array_agg('receipt'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT rv.id, rv.voucher_number as ref
        FROM public.receipt_vouchers rv
        WHERE rv.bank_account_id = v_line.bank_account_id
          AND rv.is_posted = true
          AND abs(rv.amount - v_line.credit_amount) < 0.01
          AND abs(rv.voucher_date - v_line.transaction_date) <= 5
          AND rv.id NOT IN (
            SELECT matched_receipt_id FROM public.bank_statement_lines
            WHERE matched_receipt_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;

      -- B. Fund Transfers In
      SELECT 
        v_cand_ids || COALESCE(array_agg(cand.id), ARRAY[]::UUID[]),
        v_cand_refs || COALESCE(array_agg(cand.ref), ARRAY[]::TEXT[]),
        v_cand_types || COALESCE(array_agg('fund_transfer'::text), ARRAY[]::TEXT[])
      INTO v_cand_ids, v_cand_refs, v_cand_types
      FROM (
        SELECT ft.id, ft.transfer_number as ref
        FROM public.fund_transfers ft
        WHERE ft.to_bank_account_id = v_line.bank_account_id
          AND ft.status = 'posted'
          AND abs(COALESCE(ft.to_amount, ft.amount) - v_line.credit_amount) < 0.01
          AND abs(ft.transfer_date - v_line.transaction_date) <= 5
          AND ft.id NOT IN (
            SELECT matched_fund_transfer_id FROM public.bank_statement_lines
            WHERE matched_fund_transfer_id IS NOT NULL AND id <> v_line.id
          )
      ) cand;
    END IF;

    v_total_candidates := COALESCE(array_length(v_cand_ids, 1), 0);

    -- ─────────────────────────────────────────────────────────────────────────
    -- 3. RESOLUTION LOGIC: REFERENCE MATCH -> EXACT SINGLE CANDIDATE -> CONFLICT
    -- ─────────────────────────────────────────────────────────────────────────
    IF v_total_candidates > 0 THEN
      -- Check if any candidate has its reference number mentioned in statement description
      DECLARE
        v_ref_idx INTEGER := 0;
        v_ref_matches INTEGER := 0;
        v_chosen_idx INTEGER := 0;
      BEGIN
        FOR v_ref_idx IN 1..v_total_candidates LOOP
          IF v_cand_refs[v_ref_idx] IS NOT NULL AND v_cand_refs[v_ref_idx] <> '' THEN
            IF v_line.description ILIKE ('%' || v_cand_refs[v_ref_idx] || '%') THEN
              v_ref_matches := v_ref_matches + 1;
              v_chosen_idx := v_ref_idx;
            END IF;
          END IF;
        END LOOP;

        IF v_ref_matches = 1 THEN
          -- Decisive single reference match found in statement description
          v_exact_match_id := v_cand_ids[v_chosen_idx];
          v_exact_match_type := v_cand_types[v_chosen_idx];
        ELSIF v_total_candidates = 1 THEN
          -- Exactly 1 candidate found within date & amount criteria
          v_exact_match_id := v_cand_ids[1];
          v_exact_match_type := v_cand_types[1];
        END IF;
      END;
    END IF;

    -- Apply status update
    IF v_exact_match_id IS NOT NULL THEN
      UPDATE public.bank_statement_lines
      SET reconciliation_status = 'reconciled',
          matching_status = 'confirmed',
          matched_at = now(),
          matched_payment_id = CASE WHEN v_exact_match_type = 'payment' THEN v_exact_match_id ELSE matched_payment_id END,
          matched_receipt_id = CASE WHEN v_exact_match_type = 'receipt' THEN v_exact_match_id ELSE matched_receipt_id END,
          matched_expense_id = CASE WHEN v_exact_match_type = 'expense' THEN v_exact_match_id ELSE matched_expense_id END,
          matched_fund_transfer_id = CASE WHEN v_exact_match_type = 'fund_transfer' THEN v_exact_match_id ELSE matched_fund_transfer_id END,
          matched_tax_payment_id = CASE WHEN v_exact_match_type = 'tax_payment' THEN v_exact_match_id ELSE matched_tax_payment_id END,
          matched_petty_cash_id = CASE WHEN v_exact_match_type = 'petty_cash' THEN v_exact_match_id ELSE matched_petty_cash_id END,
          notes = 'Auto-reconciled with ' || v_exact_match_type || ' (' || v_cand_refs[1] || ')'
      WHERE id = v_line.id;

      v_matched_count := v_matched_count + 1;

    ELSIF v_total_candidates > 1 THEN
      -- Multiple ambiguous candidates found without decisive description match: Flag Conflict
      UPDATE public.bank_statement_lines
      SET reconciliation_status = 'conflict',
          matching_status = 'suggested',
          notes = 'Conflict: ' || v_total_candidates || ' candidate records found with identical amount: ' || array_to_string(v_cand_refs, ', ')
      WHERE id = v_line.id;

      v_conflict_count := v_conflict_count + 1;

    ELSE
      -- Zero candidates: Keep unmatched
      UPDATE public.bank_statement_lines
      SET reconciliation_status = 'unmatched',
          matching_status = 'none'
      WHERE id = v_line.id;

      v_unmatched_count := v_unmatched_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'total_processed', v_total_processed,
    'auto_matched_count', v_matched_count,
    'conflict_count', v_conflict_count,
    'unmatched_count', v_unmatched_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_reconcile_bank_statement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_reconcile_bank_statement(uuid) TO authenticated, service_role;

-- 5.3 compute_period_ppn: Enforce finance/tax authorization guard
CREATE OR REPLACE FUNCTION public.compute_period_ppn(p_period_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period public.tax_periods%rowtype;
  v_pph_total numeric(18,2);
BEGIN
  -- Finance/Tax Authorization Guard: Prevent unauthorized tax recalculation by non-finance roles
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'accounts', 'auditor_ca')
        AND is_active = true
    ) THEN
      RAISE EXCEPTION 'Access denied: tax period calculation requires finance or tax administrative privileges';
    END IF;
  END IF;

  SELECT * INTO v_period
    FROM public.tax_periods
   WHERE id = p_period_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;

  -- PPN calculation remains unchanged.
  IF v_period.tax_type = 'PPN' THEN
    PERFORM public.compute_period_ppn_pre_posted_register(p_period_id);
    RETURN;
  END IF;

  -- Filed periods are immutable snapshots. Never overwrite a submitted
  -- government return from live source rows during later expense edits.
  IF v_period.filing_status = 'filed' OR v_period.status = 'closed' THEN
    RETURN;
  END IF;

  PERFORM public.compute_period_ppn_pre_posted_register(p_period_id);

  SELECT COALESCE(public.fn_pph_authoritative_source_total(p_period_id), 0)
       + COALESCE((
           SELECT SUM(tp.amount)
             FROM public.tax_payments tp
            WHERE tp.tax_period_id = p_period_id
              AND tp.tax_type = v_period.tax_type
              AND tp.historical_source_status = 'missing_source_verified'
         ), 0)
    INTO v_pph_total;

  UPDATE public.tax_periods
     SET pph_total = v_pph_total,
         updated_at = now()
   WHERE id = p_period_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.compute_period_ppn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_period_ppn(uuid) TO authenticated, service_role;

-- ==============================================================================
-- 6. EXTENSION POSTURE: pg_net IN SCHEMA public
-- Audit verification confirms pg_net underlying objects reside in schema 'net'.
-- PostgreSQL pg_net extension control file specifies relocatable = false;
-- ALTER EXTENSION pg_net SET SCHEMA extensions is unsupported by the extension.
-- No DDL action required; isolated inside schema 'net'.
-- ==============================================================================

COMMIT;
