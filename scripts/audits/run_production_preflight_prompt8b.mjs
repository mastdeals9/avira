import pg from 'pg';

const connectionString = (process.env.READONLY_AUDIT_DB_URL || '');

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  console.log('--- PRODUCTION PREFLIGHT INSPECTION ---');

  // 1. Check schema_migrations
  const migRes = await client.query(`
    SELECT * 
    FROM supabase_migrations.schema_migrations 
    ORDER BY version DESC 
    LIMIT 10;
  `);
  console.log('\n1. Latest 10 Migrations Applied:');
  console.table(migRes.rows);

  const isHardeningApplied = migRes.rows.some(r => r.version === '20261116080000');
  console.log('20261116080000_database_security_advisor_hardening applied?:', isHardeningApplied);

  // 2. auto_reconcile_bank_statement definition in production
  const autoReconDefRes = await client.query(`
    SELECT pg_get_functiondef(oid) as def
    FROM pg_proc
    WHERE proname = 'auto_reconcile_bank_statement';
  `);
  console.log('\n2. Current auto_reconcile_bank_statement definition in production:');
  const prodAutoReconDef = autoReconDefRes.rows[0]?.def || 'NOT FOUND';
  console.log('Length:', prodAutoReconDef.length);
  const hasFinanceGuard = prodAutoReconDef.includes('Access denied: bank reconciliation requires finance');
  const usesPettyCashVouchers = prodAutoReconDef.includes('FROM public.petty_cash_vouchers pcv');
  const usesRvAmount = prodAutoReconDef.includes('abs(rv.amount - v_line.credit_amount) < 0.01');
  console.log('Already has finance guard?:', hasFinanceGuard);
  console.log('Uses petty_cash_vouchers?:', usesPettyCashVouchers);
  console.log('Uses rv.amount?:', usesRvAmount);

  // 3. Mutable search_path functions
  const searchPathFuncs = [
    'current_user_has_pricing_role',
    'edit_approved_finance_expense_atomic',
    'fn_sync_batch_doc_to_universal',
    'fn_sync_crm_doc_to_universal',
    'fn_sync_product_doc_to_universal',
    'fn_sync_product_source_doc_to_universal',
    'refresh_whatsapp_campaign_counts',
    'save_finance_expense',
    'trg_fn_revert_bank_alloc_pph',
    'trg_fn_sync_bank_alloc_pph',
    'trg_sync_credit_note_invoice_payment',
    'calculate_finance_expense_payable',
    'get_invoice_credit_note_amount',
    'is_reportable_sales_invoice',
    'trg_sync_sales_invoice_document_status'
  ];
  const searchPathRes = await client.query(`
    SELECT proname, proconfig
    FROM pg_proc
    WHERE proname = ANY($1)
      AND pronamespace = 'public'::regnamespace;
  `, [searchPathFuncs]);
  console.log('\n3. Current search_path (proconfig) of the 15 functions:');
  console.table(searchPathRes.rows);

  // 4. View vw_universal_document_bank
  const viewRes = await client.query(`
    SELECT c.relname, c.reloptions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'vw_universal_document_bank';
  `);
  console.log('\n4. View vw_universal_document_bank options:');
  console.table(viewRes.rows);

  // 5. pg_net extension
  const extRes = await client.query(`
    SELECT extname, extversion, n.nspname as extnamespace
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE extname = 'pg_net';
  `);
  console.log('\n5. Extension pg_net:');
  console.table(extRes.rows);

  // 6. Current grants on key functions
  const grantsRes = await client.query(`
    SELECT 
      p.proname,
      pg_get_function_identity_arguments(p.oid) as args,
      p.proacl
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN (
        'invoke_process_whatsapp_campaign',
        'refresh_whatsapp_campaign_counts',
        'lookup_login_email',
        'apply_batch_receipt_weighted_average',
        'archive_old_records',
        'auto_reconcile_bank_statement',
        'compute_period_ppn'
      );
  `);
  console.log('\n6. Key Function Privileges (proacl):');
  console.table(grantsRes.rows);

  // 7. Check 27 trigger functions grants
  const triggerFuncs = [
    'assign_faktur_pajak_number_trigger',
    'auto_reconcile_on_expense_approval',
    'check_active_batches_before_inventory_adjustment',
    'check_batch_usage_before_delete',
    'enforce_single_primary_phone',
    'fn_auto_post_ppn_journal',
    'fn_prevent_po_vendor_change',
    'fn_recalculate_pi_total_payments',
    'fn_sync_batch_doc_to_universal',
    'fn_sync_crm_doc_to_universal',
    'fn_sync_product_doc_to_universal',
    'fn_sync_product_source_doc_to_universal',
    'fn_validate_faktur_pajak_date',
    'handle_email_attachment_upload',
    'handle_updated_at',
    'prevent_approved_expense_modification',
    'prevent_duplicate_po_number',
    'prevent_reconciled_line_modification',
    'sync_sales_order_amounts_trigger',
    'trg_fn_revert_bank_alloc_pph',
    'trg_fn_sync_bank_alloc_pph',
    'trg_sync_credit_note_invoice_payment',
    'trg_sync_sales_invoice_document_status',
    'update_bank_statement_lines_updated_at',
    'update_inventory_stock_trigger',
    'update_payment_voucher_tax_allocations_updated_at',
    'update_updated_at_column'
  ];

  const trgRes = await client.query(`
    SELECT 
      p.proname,
      p.proacl
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = ANY($1);
  `, [triggerFuncs]);
  console.log(`\n7. Found ${trgRes.rows.length} of 27 Trigger Functions in public schema:`);
  console.log('Sample trigger proacl:', trgRes.rows.slice(0, 5));

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
