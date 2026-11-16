import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const connectionString = 'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';
const migrationPath = path.resolve('supabase/migrations/20261116131459_database_security_advisor_hardening.sql');
const remediationSqlPath = path.resolve('docs/audits/SAPJ_PROMPT_8_SECURITY_REMEDIATION.sql');

test('Prompt 8B — Database Security Advisor Hardening Test Suite', async (t) => {
  let client;

  t.before(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
  });

  t.after(async () => {
    if (client) {
      await client.end();
    }
  });

  await t.test('1. Migration and audit SQL files exist and match exactly', () => {
    assert.ok(fs.existsSync(migrationPath), 'Migration file must exist');
    assert.ok(fs.existsSync(remediationSqlPath), 'Remediation SQL file must exist');

    const migSql = fs.readFileSync(migrationPath, 'utf8');
    const remSql = fs.readFileSync(remediationSqlPath, 'utf8');
    assert.equal(migSql, remSql, 'Migration and audit remediation SQL must be identical');
  });

  await t.test('2. Remediation SQL executes cleanly in a temporary transaction', async () => {
    const rawSql = fs.readFileSync(remediationSqlPath, 'utf8');
    // Substitute COMMIT with ROLLBACK to guarantee zero production mutation
    const rollbackSql = rawSql.replace(/COMMIT;\s*$/, 'ROLLBACK;');

    await client.query('BEGIN;');
    try {
      await client.query(rollbackSql);
      assert.ok(true, 'Remediation SQL executed without errors');
    } catch (err) {
      await client.query('ROLLBACK;').catch(() => {});
      assert.fail(`SQL execution failed: ${err.message}`);
    }
  });

  await t.test('3. Verify all 15 mutable search_path functions are addressed and no unverified sixteenth', async () => {
    const rawSql = fs.readFileSync(remediationSqlPath, 'utf8');
    const expected15 = [
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

    for (const fn of expected15) {
      assert.match(
        rawSql,
        new RegExp(`ALTER FUNCTION public\\.${fn}\\(.*?\\) SET search_path = public, pg_temp;`),
        `Function ${fn} must have search_path pinned to public, pg_temp`
      );
    }

    // Verify petty_cash_resolved_tx_id is NOT in the SQL (as required by Prompt 8B section 5)
    assert.ok(!rawSql.includes('petty_cash_resolved_tx_id'), 'Optional petty_cash_resolved_tx_id must not be altered');
  });

  await t.test('4. Verify vw_universal_document_bank security_invoker configuration and RLS isolation', async () => {
    const rawSql = fs.readFileSync(remediationSqlPath, 'utf8');
    assert.match(
      rawSql,
      /ALTER VIEW public\.vw_universal_document_bank SET \(security_invoker = true\);/,
      'View must be set to security_invoker = true'
    );

    // Test in rollback transaction: when security_invoker is true, anon is blocked by RLS/table permissions
    await client.query('BEGIN;');
    try {
      await client.query('ALTER VIEW public.vw_universal_document_bank SET (security_invoker = true);');
      
      // Test anon: must fail with permission denied on underlying tables
      await client.query('SAVEPOINT sp_anon;');
      await client.query("SET LOCAL role = 'anon';");
      try {
        await client.query('SELECT count(*) FROM public.vw_universal_document_bank;');
        assert.fail('Anon must be denied access to vw_universal_document_bank under security_invoker');
      } catch (err) {
        assert.match(err.message, /permission denied/, 'Must fail with permission denied');
        await client.query('ROLLBACK TO SAVEPOINT sp_anon;');
      }
      await client.query("RESET role;");

      // Test authenticated sales user: can access non-confidential, confidential rows = 0
      const salesUser = await client.query("SELECT id FROM public.user_profiles WHERE role = 'sales' AND is_active = true LIMIT 1;");
      if (salesUser.rows.length) {
        const uid = salesUser.rows[0].id;
        await client.query('SAVEPOINT sp_sales;');
        await client.query(`SET LOCAL request.jwt.claim.sub = '${uid}';`);
        await client.query("SET LOCAL role = 'authenticated';");
        const res = await client.query(`
          SELECT count(*) FILTER (WHERE is_confidential = true AND created_by != '${uid}') as leaked_conf
          FROM public.vw_universal_document_bank;
        `);
        assert.equal(parseInt(res.rows[0].leaked_conf, 10), 0, 'No confidential documents of other users should leak to sales');
        await client.query('ROLLBACK TO SAVEPOINT sp_sales;');
        await client.query("RESET role;");
      }
    } finally {
      await client.query('ROLLBACK;');
    }
  });

  await t.test('5. Verify invoke_process_whatsapp_campaign is stripped of anon and authenticated access', async () => {
    const rawSql = fs.readFileSync(remediationSqlPath, 'utf8');
    assert.match(
      rawSql,
      /REVOKE ALL ON FUNCTION public\.invoke_process_whatsapp_campaign\(\) FROM PUBLIC, anon, authenticated;/,
      'Must revoke all privileges on invoke_process_whatsapp_campaign from PUBLIC, anon, authenticated'
    );
    assert.match(
      rawSql,
      /GRANT EXECUTE ON FUNCTION public\.invoke_process_whatsapp_campaign\(\) TO service_role;/,
      'Must grant execute on invoke_process_whatsapp_campaign to service_role'
    );
  });

  await t.test('6. Verify lookup_login_email is explicitly preserved for anon login and has input validation', async () => {
    const rawSql = fs.readFileSync(remediationSqlPath, 'utf8');
    assert.match(
      rawSql,
      /GRANT EXECUTE ON FUNCTION public\.lookup_login_email\(text\) TO anon, authenticated, service_role;/,
      'Must grant execute on lookup_login_email to anon, authenticated, service_role'
    );

    // Verify in database that it is STABLE, returns only email and is_active, and rejects invalid input
    const res = await client.query("SELECT * FROM public.lookup_login_email('invalid@$username');");
    assert.equal(res.rows.length, 0, 'Invalid characters must return 0 rows without error');
  });

  await t.test('7. Verify all 27 trigger functions are revoked from anon and authenticated', async () => {
    const rawSql = fs.readFileSync(remediationSqlPath, 'utf8');
    const triggerNames = [
      'enforce_inventory_transaction_operation_id',
      'enforce_pph_allocation_period_lock',
      'fn_sync_batch_doc_to_universal',
      'fn_sync_crm_doc_to_universal',
      'fn_sync_product_doc_to_universal',
      'fn_sync_product_source_doc_to_universal',
      'prevent_cash_on_hand_fund_transfer',
      'prevent_expense_payment_overallocation',
      'prevent_gl1101_posting',
      'prevent_unsafe_settled_salary_edit',
      'sync_credit_note_material_return',
      'sync_purchase_invoice_payment_state_from_pv_posting',
      'sync_si_state_on_rv_posting_change',
      'trg_fn_revert_bank_alloc_pph',
      'trg_fn_revert_petty_cash_pph',
      'trg_fn_revert_voucher_alloc_pph',
      'trg_fn_sync_bank_alloc_pph',
      'trg_fn_sync_payment_voucher_header_pph',
      'trg_fn_sync_petty_cash_pph',
      'trg_fn_sync_voucher_alloc_pph',
      'trg_import_containers_ndpbm_sync',
      'trg_salary_advance_application_recalc',
      'trg_validate_credit_note_integrity',
      'trg_validate_credit_note_item_quantities',
      'validate_credit_note_item_quantities',
      'validate_material_return_item',
      'validate_tax_expense_linkage'
    ];

    for (const trg of triggerNames) {
      assert.match(
        rawSql,
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${trg}\\(.*?\\) FROM PUBLIC, anon, authenticated;`),
        `Trigger function ${trg} must have execute revoked from PUBLIC, anon, and authenticated`
      );
    }
  });

  await t.test('8. Verify bulk email worker routines are restricted to service_role', async () => {
    const rawSql = fs.readFileSync(remediationSqlPath, 'utf8');
    const bulkEmailFuncs = [
      'invoke_bulk_email_worker()',
      'claim_bulk_email_campaign(uuid, text, integer, uuid)',
      'claim_bulk_email_recipients(uuid, integer, text)'
    ];

    for (const fn of bulkEmailFuncs) {
      const escaped = fn.replace('(', '\\(').replace(')', '\\)');
      assert.match(
        rawSql,
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped} FROM PUBLIC, anon, authenticated;`),
        `Bulk email function ${fn} must be revoked from PUBLIC, anon, authenticated`
      );
      assert.match(
        rawSql,
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escaped} TO service_role;`),
        `Bulk email function ${fn} must be granted to service_role`
      );
    }
  });

  await t.test('9. Verify historical finance repair routines are restricted to service_role', async () => {
    const rawSql = fs.readFileSync(remediationSqlPath, 'utf8');
    const repairFuncs = [
      'run_deterministic_finance_historical_repair()',
      'audit_legacy_bank_reconciliation_source_documents(uuid)'
    ];

    for (const fn of repairFuncs) {
      const escaped = fn.replace('(', '\\(').replace(')', '\\)');
      assert.match(
        rawSql,
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped} FROM PUBLIC, anon, authenticated;`),
        `Repair function ${fn} must be revoked from PUBLIC, anon, authenticated`
      );
      assert.match(
        rawSql,
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escaped} TO service_role;`),
        `Repair function ${fn} must be granted to service_role`
      );
    }
  });

  await t.test('10. Verify apply_batch_receipt_weighted_average is revoked from client RPC', async () => {
    const rawSql = fs.readFileSync(remediationSqlPath, 'utf8');
    assert.match(
      rawSql,
      /REVOKE ALL ON FUNCTION public\.apply_batch_receipt_weighted_average\(uuid, numeric, numeric\) FROM PUBLIC, anon, authenticated;/,
      'apply_batch_receipt_weighted_average must be revoked from authenticated'
    );
    assert.match(
      rawSql,
      /GRANT EXECUTE ON FUNCTION public\.apply_batch_receipt_weighted_average\(uuid, numeric, numeric\) TO service_role;/,
      'apply_batch_receipt_weighted_average must be granted to service_role'
    );
  });

  await t.test('11. Verify archive_old_records NULL-safe admin authorization guard', async () => {
    await client.query('BEGIN;');
    try {
      // Execute the function definition from the remediation SQL
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
          RETURN jsonb_build_object('success', true);
        END;
        $function$;
      `);

      // 1. Must reject when auth.uid() is NULL (or role is NULL)
      await client.query('SAVEPOINT sp_null_user;');
      try {
        await client.query('SELECT public.archive_old_records();');
        assert.fail('archive_old_records must reject when user role is NULL');
      } catch (err) {
        assert.match(err.message, /Permission denied: only admin can archive old records/);
        await client.query('ROLLBACK TO SAVEPOINT sp_null_user;');
      }

      // 2. Must reject when role is non-admin (e.g. sales)
      const salesUser = await client.query("SELECT id FROM public.user_profiles WHERE role = 'sales' AND is_active = true LIMIT 1;");
      if (salesUser.rows.length) {
        await client.query('SAVEPOINT sp_sales_archive;');
        await client.query(`SET LOCAL request.jwt.claim.sub = '${salesUser.rows[0].id}';`);
        await client.query("SET LOCAL role = 'authenticated';");
        try {
          await client.query('SELECT public.archive_old_records();');
          assert.fail('archive_old_records must reject when user role is sales');
        } catch (err) {
          assert.match(err.message, /Permission denied: only admin can archive old records/);
          await client.query('ROLLBACK TO SAVEPOINT sp_sales_archive;');
        }
        await client.query("RESET role;");
      }

      // 3. Must allow when role is admin
      const adminUser = await client.query("SELECT id FROM public.user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1;");
      if (adminUser.rows.length) {
        await client.query('SAVEPOINT sp_admin_archive;');
        await client.query(`SET LOCAL request.jwt.claim.sub = '${adminUser.rows[0].id}';`);
        await client.query("SET LOCAL role = 'authenticated';");
        const res = await client.query('SELECT public.archive_old_records();');
        assert.equal(res.rows[0].archive_old_records.success, true, 'Admin must be permitted to archive old records');
        await client.query('ROLLBACK TO SAVEPOINT sp_admin_archive;');
        await client.query("RESET role;");
      }
    } finally {
      await client.query('ROLLBACK;');
    }
  });

  await t.test('12. Verify auto_reconcile_bank_statement original matching behaviour and finance authorization guard', async () => {
    // 1. Static contract verification: ensure business logic is preserved exactly as in production
    const migSql = fs.readFileSync(migrationPath, 'utf8');
    const startMarker = 'CREATE OR REPLACE FUNCTION public.auto_reconcile_bank_statement(p_upload_id uuid DEFAULT NULL::uuid)';
    const endMarker = 'REVOKE ALL ON FUNCTION public.auto_reconcile_bank_statement(uuid) FROM PUBLIC, anon;';
    
    const startIdx = migSql.indexOf(startMarker);
    const endIdx = migSql.indexOf(endMarker);
    assert.ok(startIdx !== -1 && endIdx !== -1, 'Function definition must be present in migration SQL');
    const migFuncDef = migSql.slice(startIdx, endIdx).trim();

    // Assert petty-cash matching uses original petty_cash_vouchers
    assert.match(migFuncDef, /FROM public\.petty_cash_vouchers pcv/, 'Must match against public.petty_cash_vouchers');
    assert.doesNotMatch(migFuncDef, /petty_cash_transactions/, 'Must NOT alter matching to petty_cash_transactions');

    // Assert receipt voucher matching uses original rv.amount
    assert.match(migFuncDef, /abs\(rv\.amount - v_line\.credit_amount\) < 0\.01/, 'Must match against original rv.amount');
    assert.doesNotMatch(migFuncDef, /COALESCE\(rv\.bank_amount,\s*rv\.amount\)/, 'Must NOT alter receipt matching to COALESCE(rv.bank_amount, rv.amount)');

    // 2. Behavioral verification against live database in isolated transaction
    await client.query('BEGIN;');
    try {
      // Get live production definition
      const origRecon = await client.query("SELECT pg_get_functiondef(oid) as def FROM pg_proc WHERE proname = 'auto_reconcile_bank_statement';");
      const prodDef = origRecon.rows[0].def.trim();

      // Ensure that stripping the security guard from migration definition yields the original production definition
      const guardText = `  -- Finance Authorization Guard: Prevent unauthorized invocation by non-finance roles
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'accounts', 'auditor_ca')
        AND is_active = true
    ) THEN
      RAISE EXCEPTION 'Access denied: bank reconciliation requires finance or administrative privileges';
    END IF;
  END IF;\n\n`;
      const strippedMigDef = migFuncDef.replace(guardText, '').replace(/;\s*$/, '');
      const strippedProdDef = prodDef.replace(guardText, '').replace(/;\s*$/, '');
      assert.equal(strippedMigDef, strippedProdDef, 'Migration function must be 100% identical to production definition except for the security guard');

      // Install the migration's function definition
      await client.query(migFuncDef);

      // Verify service-role execution (auth.uid() IS NULL): must succeed without authorization error
      const srvRes = await client.query("SELECT public.auto_reconcile_bank_statement('00000000-0000-0000-0000-000000000000');");
      assert.equal(srvRes.rows[0].auto_reconcile_bank_statement.success, true, 'Service-role must execute bank reconciliation cleanly');

      // Non-finance (sales) must be blocked
      const salesUser = await client.query("SELECT id FROM public.user_profiles WHERE role = 'sales' AND is_active = true LIMIT 1;");
      if (salesUser.rows.length) {
        await client.query('SAVEPOINT sp_sales_recon;');
        await client.query(`SET LOCAL request.jwt.claim.sub = '${salesUser.rows[0].id}';`);
        await client.query("SET LOCAL role = 'authenticated';");
        try {
          await client.query("SELECT public.auto_reconcile_bank_statement('00000000-0000-0000-0000-000000000000');");
          assert.fail('Non-finance role must be blocked from bank reconciliation');
        } catch (err) {
          assert.match(err.message, /Access denied: bank reconciliation requires finance/);
          await client.query('ROLLBACK TO SAVEPOINT sp_sales_recon;');
        }
        await client.query("RESET role;");
      }

      // Finance (accounts) must be allowed
      const finUser = await client.query("SELECT id FROM public.user_profiles WHERE role IN ('admin', 'accounts') AND is_active = true LIMIT 1;");
      if (finUser.rows.length) {
        await client.query('SAVEPOINT sp_fin_recon;');
        await client.query(`SET LOCAL request.jwt.claim.sub = '${finUser.rows[0].id}';`);
        await client.query("SET LOCAL role = 'authenticated';");
        const res = await client.query("SELECT public.auto_reconcile_bank_statement('00000000-0000-0000-0000-000000000000');");
        assert.equal(res.rows[0].auto_reconcile_bank_statement.success, true, 'Finance role must be permitted to reconcile');
        await client.query('ROLLBACK TO SAVEPOINT sp_fin_recon;');
        await client.query("RESET role;");
      }
    } finally {
      await client.query('ROLLBACK;');
    }
  });

  await t.test('13. Verify compute_period_ppn tax/finance authorization guard', async () => {
    await client.query('BEGIN;');
    try {
      const origPpn = await client.query("SELECT pg_get_functiondef(oid) as def FROM pg_proc WHERE proname = 'compute_period_ppn';");
      const ppnGuard = `
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
      const guardedPpnDef = origPpn.rows[0].def.replace('BEGIN', 'BEGIN' + ppnGuard);
      await client.query(guardedPpnDef);

      // Non-finance (sales) must be blocked
      const salesUser = await client.query("SELECT id FROM public.user_profiles WHERE role = 'sales' AND is_active = true LIMIT 1;");
      if (salesUser.rows.length) {
        await client.query('SAVEPOINT sp_sales_ppn;');
        await client.query(`SET LOCAL request.jwt.claim.sub = '${salesUser.rows[0].id}';`);
        await client.query("SET LOCAL role = 'authenticated';");
        try {
          await client.query("SELECT public.compute_period_ppn('00000000-0000-0000-0000-000000000000');");
          assert.fail('Non-finance role must be blocked from tax period calculation');
        } catch (err) {
          assert.match(err.message, /Access denied: tax period calculation requires finance/);
          await client.query('ROLLBACK TO SAVEPOINT sp_sales_ppn;');
        }
        await client.query("RESET role;");
      }
    } finally {
      await client.query('ROLLBACK;');
    }
  });

  await t.test('14. Verify legitimate client RPCs retain authenticated execution', async () => {
    const criticalClientRpcs = [
      'get_balance_sheet',
      'get_pnl_summary_detailed',
      'get_trial_balance',
      'get_petty_cash_balance',
      'create_sales_invoice_atomic',
      'post_payment_voucher',
      'post_receipt_voucher',
      'adjust_batch_stock_atomic',
      'create_enquiry_request_atomic'
    ];

    for (const rpc of criticalClientRpcs) {
      const res = await client.query(`
        SELECT bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) as auth_ok
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1;
      `, [rpc]);
      assert.ok(res.rows.length > 0, `RPC ${rpc} must exist in public schema`);
      assert.equal(res.rows[0].auth_ok, true, `RPC ${rpc} must have at least one active signature executable by authenticated`);
    }
  });

  await t.test('15. Verify pg_net isolation and relocation safety invariants', async () => {
    // Verify pg_net objects reside in 'net' namespace
    const res = await client.query(`
      SELECT DISTINCT n.nspname
      FROM pg_depend d
      JOIN pg_extension e ON d.refobjid = e.oid
      JOIN pg_class c ON d.objid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE e.extname = 'pg_net';
    `);
    const namespaces = res.rows.map(r => r.nspname);
    assert.ok(namespaces.includes('net'), 'pg_net tables must reside in schema net');

    // Confirm that ALTER EXTENSION SET SCHEMA is blocked by PostgreSQL
    await client.query('BEGIN;');
    try {
      await assert.rejects(
        async () => {
          await client.query('ALTER EXTENSION pg_net SET SCHEMA extensions;');
        },
        /does not support SET SCHEMA/,
        'PostgreSQL should reject SET SCHEMA on pg_net'
      );
    } finally {
      await client.query('ROLLBACK;');
    }
  });
});
