import pg from 'pg';

const client = new pg.Client({ connectionString: 'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres' });

async function run() {
  await client.connect();
  await client.query('BEGIN;');
  
  try {
    // 1. search_path updates
    await client.query(`
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
    `);
    console.log('1. search_path: SUCCESS');

    // 2. view security
    await client.query('ALTER VIEW public.vw_universal_document_bank SET (security_invoker = true);');
    console.log('2. view security: SUCCESS');

    // 3. Worker and repair revokes
    await client.query(`
      REVOKE ALL ON FUNCTION public.invoke_process_whatsapp_campaign() FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.invoke_process_whatsapp_campaign() TO service_role;

      REVOKE ALL ON FUNCTION public.refresh_whatsapp_campaign_counts(uuid) FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.refresh_whatsapp_campaign_counts(uuid) TO authenticated, service_role;

      REVOKE ALL ON FUNCTION public.invoke_bulk_email_worker() FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.invoke_bulk_email_worker() TO service_role;

      REVOKE ALL ON FUNCTION public.claim_bulk_email_campaign(uuid, text, integer, uuid) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.claim_bulk_email_campaign(uuid, text, integer, uuid) TO service_role;

      REVOKE ALL ON FUNCTION public.claim_bulk_email_recipients(uuid, integer, text) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.claim_bulk_email_recipients(uuid, integer, text) TO service_role;

      REVOKE ALL ON FUNCTION public.run_deterministic_finance_historical_repair() FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.run_deterministic_finance_historical_repair() TO service_role;

      REVOKE ALL ON FUNCTION public.audit_legacy_bank_reconciliation_source_documents(uuid) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.audit_legacy_bank_reconciliation_source_documents(uuid) TO service_role;

      REVOKE ALL ON FUNCTION public.apply_batch_receipt_weighted_average(uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.apply_batch_receipt_weighted_average(uuid, numeric, numeric) TO service_role;
    `);
    console.log('3. Worker & repair permissions: SUCCESS');

    // 4. Triggers
    const triggers = [
      'enforce_inventory_transaction_operation_id()',
      'enforce_pph_allocation_period_lock()',
      'fn_sync_batch_doc_to_universal()',
      'fn_sync_crm_doc_to_universal()',
      'fn_sync_product_doc_to_universal()',
      'fn_sync_product_source_doc_to_universal()',
      'prevent_cash_on_hand_fund_transfer()',
      'prevent_expense_payment_overallocation()',
      'prevent_gl1101_posting()',
      'prevent_unsafe_settled_salary_edit()',
      'sync_credit_note_material_return()',
      'sync_purchase_invoice_payment_state_from_pv_posting()',
      'sync_si_state_on_rv_posting_change()',
      'trg_fn_revert_bank_alloc_pph()',
      'trg_fn_revert_petty_cash_pph()',
      'trg_fn_revert_voucher_alloc_pph()',
      'trg_fn_sync_bank_alloc_pph()',
      'trg_fn_sync_payment_voucher_header_pph()',
      'trg_fn_sync_petty_cash_pph()',
      'trg_fn_sync_voucher_alloc_pph()',
      'trg_import_containers_ndpbm_sync()',
      'trg_salary_advance_application_recalc()',
      'trg_validate_credit_note_integrity()',
      'trg_validate_credit_note_item_quantities()',
      'validate_credit_note_item_quantities()',
      'validate_material_return_item()',
      'validate_tax_expense_linkage()'
    ];
    for (const trg of triggers) {
      await client.query(`
        REVOKE ALL ON FUNCTION public.${trg} FROM PUBLIC, anon, authenticated;
        GRANT EXECUTE ON FUNCTION public.${trg} TO service_role;
      `);
    }
    console.log('4. 27 Triggers: SUCCESS');

    // 5. Preserved login email
    await client.query('GRANT EXECUTE ON FUNCTION public.lookup_login_email(text) TO anon, authenticated, service_role;');
    console.log('5. Preserved login: SUCCESS');

    // 6. archive_old_records NULL-safe
    await client.query(`
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
    `);
    console.log('6. archive_old_records: SUCCESS');

    // 7. auto_reconcile_bank_statement with role check
    const origRecon = await client.query(`SELECT pg_get_functiondef(oid) as def FROM pg_proc WHERE proname = 'auto_reconcile_bank_statement';`);
    let reconDef = origRecon.rows[0].def;
    const guard = `
  -- Authorization Guard: Only finance roles or internal backend can execute
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
`;
    const guardedReconDef = reconDef.replace('BEGIN', 'BEGIN' + guard);
    await client.query(guardedReconDef);
    await client.query(`
      REVOKE ALL ON FUNCTION public.auto_reconcile_bank_statement(uuid) FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.auto_reconcile_bank_statement(uuid) TO authenticated, service_role;
    `);
    console.log('7. auto_reconcile_bank_statement: SUCCESS');

    // 8. compute_period_ppn with role check
    const origPpn = await client.query(`SELECT pg_get_functiondef(oid) as def FROM pg_proc WHERE proname = 'compute_period_ppn';`);
    let ppnDef = origPpn.rows[0].def;
    const ppnGuard = `
  -- Authorization Guard: Only finance/tax roles or internal system can execute
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
`;
    const guardedPpnDef = ppnDef.replace('BEGIN', 'BEGIN' + ppnGuard);
    await client.query(guardedPpnDef);
    await client.query(`
      REVOKE ALL ON FUNCTION public.compute_period_ppn(uuid) FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.compute_period_ppn(uuid) TO authenticated, service_role;
    `);
    console.log('8. compute_period_ppn: SUCCESS');

    console.log('\nALL 8 REMEDIATION STEPS COMPILED AND EXECUTED WITH ZERO ERRORS!');

  } catch (err) {
    console.error('ERROR in testing SQL:', err);
  } finally {
    await client.query('ROLLBACK;');
    console.log('Transaction safely rolled back (0 changes to production).');
    await client.end();
  }
}
run().catch(console.error);

