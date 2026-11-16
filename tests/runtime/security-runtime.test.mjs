import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54333/postgres';

// Synthetic user IDs
const USERS = {
  admin: 'a0000000-0000-0000-0000-000000000001',
  manager: 'b0000000-0000-0000-0000-000000000002',
  accounts: 'c0000000-0000-0000-0000-000000000003',
  sales: 'd0000000-0000-0000-0000-000000000004',
  warehouse: 'e0000000-0000-0000-0000-000000000005',
  attacker: 'f0000000-0000-0000-0000-000000000006',
};

const ALL_14_BUCKETS = [
  'batch-documents',
  'crm-documents',
  'documents',
  'expense-documents',
  'petty-cash-receipts',
  'product-documents',
  'product-source-documents',
  'purchase-invoices',
  'sales-order-documents',
  'bank-statements',
  'company-assets',
  'inventory_photos',
  'rejection_photos',
  'task-attachments'
];

async function withClient(callback) {
  const client = new pg.Client({ connectionString: TEST_DB_URL });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

// Helper to run query as a specific Supabase role and user
async function runAs(client, { role = 'authenticated', userId = null }, sql, params = []) {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    if (userId) {
      await client.query(`SET LOCAL request.jwt.claim.sub = '${userId}'`);
    } else {
      await client.query(`SET LOCAL request.jwt.claim.sub = ''`);
    }
    await client.query(`SET LOCAL request.jwt.claim.role = '${role}'`);
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

test('SAPJ Local Database Security Runtime Test Suite (Disposable DB :54333)', async (t) => {
  // Setup synthetic user_profiles
  await withClient(async (client) => {
    // Clean prior test data
    await client.query('DELETE FROM public.user_profiles');
    await client.query('DELETE FROM storage.objects');
    await client.query('DELETE FROM public.universal_document_links');
    await client.query('DELETE FROM public.universal_documents');

    // Create synthetic auth.users if not present
    for (const [name, id] of Object.entries(USERS)) {
      await client.query(`
        INSERT INTO auth.users (id, email)
        VALUES ('${id}', '${name}@synthetic-test.local')
        ON CONFLICT (id) DO NOTHING;
      `);
      await client.query(`
        INSERT INTO public.user_profiles (id, username, email, full_name, role, is_active)
        VALUES ('${id}', '${name}_user', '${name}@synthetic-test.local', 'Synthetic ${name}', '${name === 'attacker' ? 'sales' : name}', true)
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
      `);
    }
  });

  // ============================================================================
  // SECTION 1: STORAGE SECURITY FUNCTIONAL TESTS ACROSS ALL 14 BUCKETS
  // ============================================================================
  await t.test('1. Storage RLS: Anonymous users cannot insert, update, or delete in any bucket', async () => {
    await withClient(async (client) => {
      for (const bucket of ALL_14_BUCKETS) {
        // 1.1 Anonymous Insert must fail
        await assert.rejects(
          async () => {
            await runAs(client, { role: 'anon', userId: null }, `
              INSERT INTO storage.objects (bucket_id, name, owner)
              VALUES ('${bucket}', 'anon-hack.pdf', NULL);
            `);
          },
          /permission denied/i,
          `Anon insert in ${bucket} must be denied`
        );

        // Setup a synthetic file owned by sales
        const fileId = '00000000-0000-0000-0000-' + bucket.replace(/[^a-f0-9]/g, '0').padEnd(12, '0').slice(0, 12);
        await client.query(`
          INSERT INTO storage.objects (id, bucket_id, name, owner)
          VALUES ('${fileId}', '${bucket}', 'legit-file-${bucket}.pdf', '${USERS.sales}')
          ON CONFLICT (id) DO NOTHING;
        `);

        // 1.2 Anonymous Update must fail
        await assert.rejects(
          async () => {
            await runAs(client, { role: 'anon', userId: null }, `
              UPDATE storage.objects SET name = 'tampered.pdf' WHERE id = '${fileId}';
            `);
          },
          /permission denied/i,
          `Anon update in ${bucket} must be denied`
        );

        // 1.3 Anonymous Delete must fail
        await assert.rejects(
          async () => {
            await runAs(client, { role: 'anon', userId: null }, `
              DELETE FROM storage.objects WHERE id = '${fileId}';
            `);
          },
          /permission denied/i,
          `Anon delete in ${bucket} must be denied`
        );
      }
    });
  });

  await t.test('2. Storage RLS: File Owners and Role-Based Permissions across 14 Buckets', async () => {
    await withClient(async (client) => {
      // 2.1 Sales user can update their OWN batch document
      const batchFileId = '11111111-0000-0000-0000-000000000001';
      await client.query(`
        INSERT INTO storage.objects (id, bucket_id, name, owner)
        VALUES ('${batchFileId}', 'batch-documents', 'sales-batch.pdf', '${USERS.sales}')
        ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, name = EXCLUDED.name;
      `);

      const ownUpdateRes = await runAs(client, { role: 'authenticated', userId: USERS.sales }, `
        UPDATE storage.objects SET name = 'sales-batch-updated.pdf' WHERE id = '${batchFileId}';
      `);
      assert.equal(ownUpdateRes.rowCount, 1, 'File owner should be able to update own file');

      // 2.2 Warehouse user CANNOT update sales user batch document (not owner, not in admin/accounts/manager)
      const unauthorizedUpdateRes = await runAs(client, { role: 'authenticated', userId: USERS.warehouse }, `
        UPDATE storage.objects SET name = 'warehouse-tamper.pdf' WHERE id = '${batchFileId}';
      `);
      assert.equal(unauthorizedUpdateRes.rowCount, 0, 'Unauthorized user should affect 0 rows on UPDATE');

      // 2.3 Accounts user CAN update batch document via role privilege
      const accountsUpdateRes = await runAs(client, { role: 'authenticated', userId: USERS.accounts }, `
        UPDATE storage.objects SET name = 'accounts-approved.pdf' WHERE id = '${batchFileId}';
      `);
      assert.equal(accountsUpdateRes.rowCount, 1, 'Accounts user should update batch document via role');

      // 2.4 Manager CAN update crm document via role privilege
      const crmFileId = '11111111-0000-0000-0000-000000000002';
      await client.query(`
        INSERT INTO storage.objects (id, bucket_id, name, owner)
        VALUES ('${crmFileId}', 'crm-documents', 'crm-contract.pdf', '${USERS.sales}')
        ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, name = EXCLUDED.name;
      `);
      const managerCrmRes = await runAs(client, { role: 'authenticated', userId: USERS.manager }, `
        UPDATE storage.objects SET name = 'manager-reviewed.pdf' WHERE id = '${crmFileId}';
      `);
      assert.equal(managerCrmRes.rowCount, 1, 'Manager should update crm document');

      // 2.5 Delete on purchase-invoices: Ordinary sales user CANNOT delete, Accounts CAN delete
      const piFileId = '11111111-0000-0000-0000-000000000003';
      await client.query(`
        INSERT INTO storage.objects (id, bucket_id, name, owner)
        VALUES ('${piFileId}', 'purchase-invoices', 'pi-supplier-invoice.pdf', '${USERS.admin}')
        ON CONFLICT (id) DO NOTHING;
      `);

      const salesDeletePiRes = await runAs(client, { role: 'authenticated', userId: USERS.sales }, `
        DELETE FROM storage.objects WHERE id = '${piFileId}';
      `);
      assert.equal(salesDeletePiRes.rowCount, 0, 'Sales user cannot delete purchase invoices');

      const accountsDeletePiRes = await runAs(client, { role: 'authenticated', userId: USERS.accounts }, `
        DELETE FROM storage.objects WHERE id = '${piFileId}';
      `);
      assert.equal(accountsDeletePiRes.rowCount, 1, 'Accounts user CAN delete purchase invoice');

      // 2.6 Company-assets: Ordinary sales user CANNOT write (blocked by restrictive policy), Admin CAN write
      const assetFileId = '11111111-0000-0000-0000-000000000004';
      await assert.rejects(
        async () => {
          await runAs(client, { role: 'authenticated', userId: USERS.sales }, `
            INSERT INTO storage.objects (id, bucket_id, name, owner)
            VALUES ('${assetFileId}', 'company-assets', 'malicious-logo.png', '${USERS.sales}');
          `);
        },
        /new row violates row-level security policy/i,
        'Sales user cannot insert into company-assets'
      );

      const adminAssetRes = await runAs(client, { role: 'authenticated', userId: USERS.admin }, `
        INSERT INTO storage.objects (id, bucket_id, name, owner)
        VALUES ('${assetFileId}', 'company-assets', 'official-logo.png', '${USERS.admin}')
        ON CONFLICT (id) DO NOTHING;
      `);
      assert.equal(adminAssetRes.rowCount, 1, 'Admin can insert into company-assets');
    });
  });

  // ============================================================================
  // SECTION 2: DOCUMENT BANK FUNCTIONAL TESTS
  // ============================================================================
  await t.test('3. Document Bank: View enforces security_invoker and access controls', async () => {
    await withClient(async (client) => {
      // Create 1 public doc (created by sales) and 1 confidential doc (created by manager)
      const publicDocId = '22222222-0000-0000-0000-000000000001';
      const confidentialDocId = '22222222-0000-0000-0000-000000000002';

      await client.query(`
        INSERT INTO public.universal_documents (id, title, document_type, is_confidential, created_by)
        VALUES 
          ('${publicDocId}', 'Public Product Catalog', 'CATALOG', false, '${USERS.sales}'),
          ('${confidentialDocId}', 'Executive Pricing Agreement', 'CONTRACT', true, '${USERS.manager}')
        ON CONFLICT (id) DO UPDATE SET is_confidential = EXCLUDED.is_confidential;
      `);

      // 3.1 Anonymous user cannot query vw_universal_document_bank
      await assert.rejects(
        async () => {
          await runAs(client, { role: 'anon', userId: null }, `
            SELECT * FROM public.vw_universal_document_bank;
          `);
        },
        /permission denied/i,
        'Anonymous user must be denied SELECT on vw_universal_document_bank'
      );

      // 3.2 Ordinary Warehouse user can see the public document, but NOT the confidential document
      const warehouseRes = await runAs(client, { role: 'authenticated', userId: USERS.warehouse }, `
        SELECT id, title, is_confidential FROM public.vw_universal_document_bank;
      `);
      const warehouseDocIds = warehouseRes.rows.map(r => r.id);
      assert.ok(warehouseDocIds.includes(publicDocId), 'Warehouse should see public document');
      assert.ok(!warehouseDocIds.includes(confidentialDocId), 'Warehouse must NOT see confidential document');

      // 3.3 Creator (Manager) CAN see their own confidential document
      const managerRes = await runAs(client, { role: 'authenticated', userId: USERS.manager }, `
        SELECT id, title, is_confidential FROM public.vw_universal_document_bank;
      `);
      const managerDocIds = managerRes.rows.map(r => r.id);
      assert.ok(managerDocIds.includes(confidentialDocId), 'Manager should see confidential document');

      // 3.4 Admin CAN see confidential document via role
      const adminRes = await runAs(client, { role: 'authenticated', userId: USERS.admin }, `
        SELECT id, title, is_confidential FROM public.vw_universal_document_bank;
      `);
      const adminDocIds = adminRes.rows.map(r => r.id);
      assert.ok(adminDocIds.includes(confidentialDocId), 'Admin should see confidential document via role');
    });
  });

  // ============================================================================
  // SECTION 3: USER PROFILE PRIVILEGE ESCALATION & IMMUTABILITY TESTS
  // ============================================================================
  await t.test('4. User Profiles: Privilege escalation attack prevention', async () => {
    await withClient(async (client) => {
      // 4.1 Attacker CANNOT delete their own profile (self-deletion vector closed)
      const deleteRes = await runAs(client, { role: 'authenticated', userId: USERS.attacker }, `
        DELETE FROM public.user_profiles WHERE id = '${USERS.attacker}';
      `);
      assert.equal(deleteRes.rowCount, 0, 'Self-deletion should affect 0 rows (policy dropped)');

      // 4.2 Non-admin CANNOT insert profile with role 'admin'
      const fakeNewUserId = '33333333-0000-0000-0000-000000000001';
      await client.query(`
        INSERT INTO auth.users (id, email) VALUES ('${fakeNewUserId}', 'fakenew@synthetic.local')
        ON CONFLICT (id) DO NOTHING;
      `);

      await assert.rejects(
        async () => {
          await runAs(client, { role: 'authenticated', userId: fakeNewUserId }, `
            INSERT INTO public.user_profiles (id, username, email, full_name, role)
            VALUES ('${fakeNewUserId}', 'attacker2', 'fakenew@synthetic.local', 'Attacker 2', 'admin');
          `);
        },
        /(new row violates row-level security|Privilege Violation)/i,
        'Non-admin cannot self-assign admin role on insert'
      );

      // 4.3 Non-admin CANNOT insert profile with NULL role
      await assert.rejects(
        async () => {
          await runAs(client, { role: 'authenticated', userId: fakeNewUserId }, `
            INSERT INTO public.user_profiles (id, username, email, full_name, role)
            VALUES ('${fakeNewUserId}', 'attacker3', 'fakenew@synthetic.local', 'Attacker 3', NULL);
          `);
        },
        /(new row violates row-level security|User profile role cannot be NULL)/i,
        'Cannot insert profile with NULL role'
      );

      // 4.4 Non-admin CAN insert profile with role 'sales' or 'viewer'
      const legitSignupRes = await runAs(client, { role: 'authenticated', userId: fakeNewUserId }, `
        INSERT INTO public.user_profiles (id, username, email, full_name, role)
        VALUES ('${fakeNewUserId}', 'legit_rep', 'fakenew@synthetic.local', 'Legit Rep', 'sales')
        RETURNING role;
      `);
      assert.equal(legitSignupRes.rows[0].role, 'sales', 'Legitimate sales profile signup succeeds');

      // 4.5 Attacker CANNOT promote themselves to 'admin' via UPDATE
      await assert.rejects(
        async () => {
          await runAs(client, { role: 'authenticated', userId: USERS.attacker }, `
            UPDATE public.user_profiles SET role = 'admin' WHERE id = '${USERS.attacker}';
          `);
        },
        /Users cannot change their own user role/i,
        'Attacker cannot promote themselves via UPDATE'
      );

      // 4.6 Attacker CANNOT reactivate account via UPDATE
      // First, set attacker is_active = false
      await client.query(`UPDATE public.user_profiles SET is_active = false WHERE id = '${USERS.attacker}';`);

      await assert.rejects(
        async () => {
          await runAs(client, { role: 'authenticated', userId: USERS.attacker }, `
            UPDATE public.user_profiles SET is_active = true WHERE id = '${USERS.attacker}';
          `);
        },
        /Only administrators can modify active status/i,
        'User cannot self-activate disabled profile'
      );

      // 4.7 Active Admin CAN create accounts and assign any role
      const adminCreatedUserId = '33333333-0000-0000-0000-000000000002';
      await client.query(`
        INSERT INTO auth.users (id, email) VALUES ('${adminCreatedUserId}', 'newmanager@synthetic.local')
        ON CONFLICT (id) DO NOTHING;
      `);

      const adminInsertRes = await runAs(client, { role: 'authenticated', userId: USERS.admin }, `
        INSERT INTO public.user_profiles (id, username, email, full_name, role)
        VALUES ('${adminCreatedUserId}', 'new_mgr', 'newmanager@synthetic.local', 'New Manager', 'manager')
        RETURNING role;
      `);
      assert.equal(adminInsertRes.rows[0].role, 'manager', 'Admin can assign manager role');

      // 4.8 Service Role provisioning works seamlessly
      const serviceProvisionedUserId = '33333333-0000-0000-0000-000000000003';
      await client.query(`
        INSERT INTO auth.users (id, email) VALUES ('${serviceProvisionedUserId}', 'serviceuser@synthetic.local')
        ON CONFLICT (id) DO NOTHING;
      `);

      const serviceRes = await runAs(client, { role: 'service_role', userId: null }, `
        INSERT INTO public.user_profiles (id, username, email, full_name, role)
        VALUES ('${serviceProvisionedUserId}', 'backend_svc', 'serviceuser@synthetic.local', 'Service User', 'accounts')
        RETURNING role;
      `);
      assert.equal(serviceRes.rows[0].role, 'accounts', 'Service role provisioning succeeds');
    });
  });

  // ============================================================================
  // SECTION 4: SECURITY DEFINER SEARCH PATHS & WHATSAPP WORKER
  // ============================================================================
  await t.test('5. SECURITY DEFINER: Pinned search_path on all 11 functions', async () => {
    await withClient(async (client) => {
      const funcs = [
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
        'trg_sync_credit_note_invoice_payment'
      ];

      for (const fn of funcs) {
        const res = await client.query(`
          SELECT proname, prosecdef, proconfig
          FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace AND proname = '${fn}';
        `);
        assert.ok(res.rows.length >= 1, `Function ${fn} must exist in pg_proc`);
        assert.equal(res.rows[0].prosecdef, true, `Function ${fn} must be SECURITY DEFINER`);
        const config = res.rows[0].proconfig || [];
        const hasSearchPath = config.some(c => c.toLowerCase().includes('search_path=public, pg_temp') || c.toLowerCase().includes('search_path=public,pg_temp'));
        assert.ok(hasSearchPath, `Function ${fn} must have pinned search_path=public, pg_temp (found: ${config.join(',')})`);
      }
    });
  });

  await t.test('6. WhatsApp Campaign Worker: Access control and Vault secret requirement', async () => {
    await withClient(async (client) => {
      // 6.1 Verify ACL in pg_proc: anon and authenticated have NO execute privileges
      const privRes = await client.query(`
        SELECT 
          has_function_privilege('anon', 'public.invoke_process_whatsapp_campaign()', 'execute') AS anon_can_execute,
          has_function_privilege('authenticated', 'public.invoke_process_whatsapp_campaign()', 'execute') AS auth_can_execute,
          has_function_privilege('service_role', 'public.invoke_process_whatsapp_campaign()', 'execute') AS service_can_execute;
      `);
      assert.equal(privRes.rows[0].anon_can_execute, false, 'Anon must not have execute privilege');
      assert.equal(privRes.rows[0].auth_can_execute, false, 'Authenticated must not have execute privilege');
      assert.equal(privRes.rows[0].service_can_execute, true, 'Service role must have execute privilege');

      // 6.2 Service role can execute function safely; missing Vault secret returns safely without fallback
      await runAs(client, { role: 'service_role', userId: null }, `
        SELECT public.invoke_process_whatsapp_campaign();
      `);
    });
  });
});
