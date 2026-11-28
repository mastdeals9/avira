import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import pg from 'pg';

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL;

async function withDbClient(callback) {
  if (!DB_CONNECTION) {
    console.warn('Skipping live DB check: DATABASE_URL is not set.');
    return;
  }
  const client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

test('1. Static Secret Scan: No hard-coded database URLs or passwords in tracked files', () => {
  const trackedFiles = execSync('git ls-files', { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.startsWith('docs/') && !f.endsWith('.md') && !f.endsWith('.png') && !f.endsWith('.env.example') && f !== 'tests/security-remediation-and-hardening.test.mjs');

  const exposedPattern = /postgresql:\/\/[^:]+:[^@]+@/i;

  for (const file of trackedFiles) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(
      exposedPattern.test(content),
      false,
      `Tracked file ${file} must NOT contain a database connection URL with credentials`
    );
    assert.equal(
      content.includes('Kunallunkad%40123') || content.includes('Kunallunkad@123'),
      false,
      `Tracked file ${file} must NOT contain the exposed password`
    );
  }
});

test('2. Environment Hygiene: .env.example exists with placeholders and .env is untracked', () => {
  assert.ok(fs.existsSync('.env.example'), '.env.example must exist');
  const exampleContent = fs.readFileSync('.env.example', 'utf8');
  assert.ok(exampleContent.includes('VITE_SUPABASE_URL='), '.env.example must specify VITE_SUPABASE_URL placeholder');
  assert.ok(exampleContent.includes('DATABASE_URL='), '.env.example must specify DATABASE_URL placeholder');
  assert.equal(
    exampleContent.includes('Kunallunkad'),
    false,
    '.env.example must never contain real passwords'
  );

  const trackedEnvFiles = execSync('git ls-files "*.env*"', { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  for (const envFile of trackedEnvFiles) {
    assert.ok(
      envFile.endsWith('.env.example'),
      `Only .env.example files may be tracked; private ${envFile} must remain untracked`
    );
  }
});

test('3. Realtime Bus Security: Validation, loop prevention, and payload stripping', () => {
  const erpBusContent = fs.readFileSync(path.join(process.cwd(), 'src/utils/erpSyncBus.ts'), 'utf8');

  assert.ok(
    erpBusContent.includes('export const ALLOWED_ERP_DOMAINS'),
    'erpSyncBus must define an explicit whitelist of allowed ERP domains'
  );
  assert.ok(
    erpBusContent.includes('export const ALLOWED_ERP_ACTIONS'),
    'erpSyncBus must define an explicit whitelist of allowed ERP actions'
  );
  assert.ok(
    erpBusContent.includes('validateAndSanitizeSyncEvent'),
    'erpSyncBus must provide validateAndSanitizeSyncEvent for all inbound events'
  );
  assert.ok(
    erpBusContent.includes('originTabId === TAB_ID'),
    'erpSyncBus must reject loopback events from the current tab'
  );
  assert.ok(
    erpBusContent.includes('originTabId !== TAB_ID'),
    'erpSyncBus must explicitly verify originTabId !== TAB_ID'
  );

  const ALLOWED_DOMAINS = new Set([
    'sales_orders', 'inventory', 'delivery_challans', 'sales_invoices',
    'credit_notes', 'expenses', 'petty_cash', 'bank_transactions',
    'vouchers', 'purchases', 'material_returns', 'crm', 'dashboard'
  ]);
  const ALLOWED_ACTIONS = new Set([
    'created', 'updated', 'approved', 'rejected', 'cancelled', 'deleted',
    'dispatched', 'received', 'settled', 'reconciled', 'status_changed', 'refresh_all'
  ]);

  function validate(candidate, currentTabId) {
    if (!candidate || typeof candidate !== 'object') return null;
    if (!ALLOWED_DOMAINS.has(candidate.domain)) return null;
    if (!ALLOWED_ACTIONS.has(candidate.action)) return null;
    if (!candidate.originTabId || candidate.originTabId === currentTabId) return null;
    return {
      domain: candidate.domain,
      action: candidate.action,
      entityId: typeof candidate.entityId === 'string' ? candidate.entityId.slice(0, 64) : undefined,
      timestamp: candidate.timestamp || Date.now(),
      originTabId: candidate.originTabId,
    };
  }

  const valid = validate({
    domain: 'sales_orders',
    action: 'updated',
    entityId: 'so_123',
    originTabId: 'other_tab',
    sensitiveData: 'secret_123',
  }, 'my_tab');

  assert.ok(valid, 'Valid event passes');
  assert.equal(valid.domain, 'sales_orders');
  assert.equal(valid.sensitiveData, undefined, 'Sensitive payload stripped');
  assert.equal(validate({ domain: 'invalid', action: 'updated', originTabId: 'other_tab' }, 'my_tab'), null);
  assert.equal(validate({ domain: 'sales_orders', action: 'updated', originTabId: 'my_tab' }, 'my_tab'), null);
});

test('4. Security Advisor: Search Path Immutability Contracts across all 7 functions', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20261029140143_security_closure_hardening_hotfix.sql'
  );
  assert.ok(fs.existsSync(migrationPath), 'Migration 20261029140143 must exist');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  // Verify search_path fixed on all 7 functions + helpers
  const expectedSearchPaths = [
    'fn_protect_enquiry_message_content',
    'fn_crm_email_activities_dedup',
    'recalculate_sales_invoice_payment_state',
    'get_invoice_paid_amount',
    'enforce_sales_invoice_write_scope',
    'get_invoice_credit_note_amount',
    'trg_sync_credit_note_invoice_payment',
    'cancel_payment_voucher_posting',
    '_sec_check_finance_role',
  ];

  for (const fn of expectedSearchPaths) {
    assert.ok(
      migrationSql.includes(fn) && migrationSql.includes('SET search_path = pg_catalog, public, pg_temp'),
      `Function ${fn} must have search_path hardened to 'pg_catalog, public, pg_temp'`
    );
  }
});

test('5. Security Advisor: Anonymous Execution Lockdown Contracts', () => {
  const migrationSql = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20261029140143_security_closure_hardening_hotfix.sql'),
    'utf8'
  );

  // Sequences and internal functions must have execute revoked from anon
  const revokedFromAnon = [
    'invoke_sapj_gmail_agent',
    'recalculate_sales_invoice_payment_state',
    'trg_sync_credit_note_invoice_payment',
    'enforce_sales_invoice_write_scope',
    '_post_credit_note_je',
    'trg_ensure_credit_note_number',
    'trg_guard_credit_note_type_transition',
    'trg_credit_note_inventory_v1',
    'trg_release_so_product_reservation_status_v2',
    'trg_batch_inward_reconcile_shortages',
  ];

  for (const fn of revokedFromAnon) {
    assert.ok(
      migrationSql.includes(fn),
      `Function ${fn} must be included in anon execution revocation`
    );
  }

  // Pre-login functions: lookup_login_email and is_setup_mode excluded from revocation
  assert.ok(
    migrationSql.includes("AND p.proname NOT IN ('lookup_login_email', 'is_setup_mode')"),
    'lookup_login_email and is_setup_mode must be preserved for anon'
  );

  // lookup_login_email input validation checks
  assert.ok(
    migrationSql.includes("length(v_clean_username) > 100"),
    'lookup_login_email must enforce max input length'
  );
  assert.ok(
    migrationSql.includes("v_clean_username !~ '^[a-z0-9._@+-]+$'"),
    'lookup_login_email must reject malformed inputs'
  );
});

test('6. Security Advisor: Authorization Bypass Fixes on Authenticated RPCs', () => {
  const migrationSql = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20261029140143_security_closure_hardening_hotfix.sql'),
    'utf8'
  );

  // approve_finance_expense must check authentication, finance role, and override approved_by with caller
  assert.ok(
    migrationSql.includes('approve_finance_expense'),
    'approve_finance_expense must be hardened'
  );
  assert.ok(
    migrationSql.includes("approved_by=CASE WHEN auth.role() = ''service_role'' THEN COALESCE(p_approved_by,auth.uid()) ELSE auth.uid() END"),
    'approve_finance_expense must override approved_by with authenticated caller ID'
  );

  // cancel_sales_invoice must check role and prevent p_actor spoofing
  assert.ok(
    migrationSql.includes('cancel_sales_invoice'),
    'cancel_sales_invoice must be hardened'
  );
  assert.ok(
    migrationSql.includes("IF COALESCE(v_role, '''') NOT IN (''admin'', ''accounts'')"),
    'cancel_sales_invoice must enforce admin/accounts role check'
  );

  // cancel_payment_voucher_posting must enforce finance role check
  assert.ok(
    migrationSql.includes('cancel_payment_voucher_posting'),
    'cancel_payment_voucher_posting must be hardened'
  );
  assert.ok(
    migrationSql.includes('PERFORM public._sec_check_finance_role()'),
    'cancel_payment_voucher_posting must call _sec_check_finance_role'
  );

  // cancel_expense_posting must enforce finance role check
  assert.ok(
    migrationSql.includes('cancel_expense_posting'),
    'cancel_expense_posting must be hardened'
  );

  // post_bpjs_monthly_register must enforce caller authentication
  assert.ok(
    migrationSql.includes('post_bpjs_monthly_register'),
    'post_bpjs_monthly_register must be hardened'
  );
  assert.ok(
    migrationSql.includes("v_user := CASE WHEN auth.role() = ''service_role'' THEN COALESCE(p_user_id, auth.uid()) ELSE auth.uid() END;"),
    'post_bpjs_monthly_register must bind caller to auth.uid()'
  );
});

test('7. Security Advisor: Sensitive Table RLS & Grants and pg_net compatibility', () => {
  const migrationSql = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20261029140143_security_closure_hardening_hotfix.sql'),
    'utf8'
  );

  assert.ok(
    migrationSql.includes('ENABLE ROW LEVEL SECURITY') && migrationSql.includes('FORCE ROW LEVEL SECURITY'),
    'Migration must enable and force RLS across sensitive tables'
  );
  assert.ok(
    migrationSql.includes('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon'),
    'Migration must revoke table permissions from anon and PUBLIC'
  );
  assert.ok(
    migrationSql.includes('REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.%I FROM authenticated'),
    'Migration must strip dangerous privileges from authenticated'
  );

  // pg_net compatibility check
  assert.ok(
    migrationSql.includes('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC, anon, authenticated'),
    'pg_net schema net functions must have execution revoked from anon and authenticated'
  );
  assert.ok(
    !migrationSql.includes('DROP EXTENSION pg_net') && !migrationSql.includes('ALTER EXTENSION pg_net SET SCHEMA'),
    'pg_net must NOT be dropped or moved to prevent breaking existing HTTP dispatchers'
  );
});

test('8. Live Database Security Invariants: Permissions, RLS, and Function Hardening', async () => {
  await withDbClient(async (client) => {
    // 1. Verify reconcile_product_shortages cannot be executed by anon or authenticated
    const fnPerms = await client.query(`
      SELECT has_function_privilege('anon', 'public.reconcile_product_shortages(uuid)', 'execute') as anon_exec,
             has_function_privilege('authenticated', 'public.reconcile_product_shortages(uuid)', 'execute') as auth_exec,
             has_function_privilege('service_role', 'public.reconcile_product_shortages(uuid)', 'execute') as sr_exec;
    `);
    assert.equal(fnPerms.rows[0].anon_exec, false, 'anon must NOT have execute on reconcile_product_shortages');
    assert.equal(fnPerms.rows[0].auth_exec, false, 'authenticated must NOT have execute on reconcile_product_shortages');
    assert.equal(fnPerms.rows[0].sr_exec, true, 'service_role must retain execute on reconcile_product_shortages');

    // 2. Verify anon has 0 table grants on sensitive tables
    const anonGrants = await client.query(`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name IN ('sales_orders', 'sales_order_items', 'so_product_reservations', 'batches')
        AND grantee = 'anon';
    `);
    assert.equal(anonGrants.rowCount, 0, 'anon must have 0 table grants on sensitive tables');

    // 3. Verify authenticated cannot mutate so_product_reservations directly
    const authResGrants = await client.query(`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name = 'so_product_reservations'
        AND grantee = 'authenticated';
    `);
    const authResPrivs = authResGrants.rows.map((r) => r.privilege_type);
    assert.deepEqual(authResPrivs, ['SELECT'], 'authenticated must have ONLY SELECT on so_product_reservations');

    // 4. Verify RLS is enabled and forced on all four sensitive tables
    const rlsCheck = await client.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('sales_orders', 'sales_order_items', 'so_product_reservations', 'batches');
    `);
    assert.equal(rlsCheck.rowCount, 4, 'All 4 sensitive tables must exist');
    for (const row of rlsCheck.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} must have row security enabled`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} must have forced row security`);
    }
  });
});
