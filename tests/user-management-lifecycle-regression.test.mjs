import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import pg from 'pg';

const { Client } = pg;

const userManagementTsx = readFileSync(
  new URL('../src/components/settings/UserManagement.tsx', import.meta.url),
  'utf8'
);

const adminDeleteUserEdgeTs = readFileSync(
  new URL('../supabase/functions/admin-delete-user/index.ts', import.meta.url),
  'utf8'
);

const migrationSql = readFileSync(
  new URL('../supabase/migrations/20261013140000_fix_user_management_deactivate_and_delete.sql', import.meta.url),
  'utf8'
);

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL;

async function withDbClient(callback) {
  if (!DB_CONNECTION) {
    console.warn('Skipping live database test: DATABASE_URL environment variable is not set.');
    return;
  }
  const client = new Client({
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

async function setAuthenticatedUser(client, userId) {
  await client.query('SET ROLE authenticated');
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
}

// ============================================================================
// 1. Static Architecture and Contract Assertions
// ============================================================================

test('1. Migration contains RLS update policy, atomic toggle RPC, and delete safety RPCs', () => {
  assert.match(migrationSql, /CREATE POLICY "Admins can update user profiles"/);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.admin_toggle_user_status/);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.check_user_can_delete/);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.admin_delete_user/);
});

test('2. UserManagement frontend uses fresh session handling and verifies DB confirmation', () => {
  // Session refresh before calls
  assert.match(userManagementTsx, /const getFreshSession = async/);
  assert.match(userManagementTsx, /refreshSession\(\)/);

  // Toggle status calls RPC and validates return
  assert.match(userManagementTsx, /supabase\.rpc\('admin_toggle_user_status'/);
  assert.match(userManagementTsx, /typeof res\.is_active !== 'boolean'/);

  // Safe delete calls RPC and passes apikey to edge functions
  assert.match(userManagementTsx, /supabase\.rpc\('admin_delete_user'/);
  assert.match(userManagementTsx, /'apikey': import\.meta\.env\.VITE_SUPABASE_ANON_KEY/);
});

test('3. Edge Function admin-delete-user verifies business records before deletion', () => {
  assert.match(adminDeleteUserEdgeTs, /check_user_can_delete/);
  assert.match(adminDeleteUserEdgeTs, /USER_HAS_HISTORICAL_RECORDS/);
  assert.match(adminDeleteUserEdgeTs, /user_permissions/);
});

// ============================================================================
// 2. Live Database Integration Tests
// ============================================================================

test('4. Live DB: Admin can deactivate and reactivate user with DB confirmation', async () => {
  await withDbClient(async (client) => {
    const adminId = '1075a773-bb55-4296-bc71-af2eab9a0780'; // Kunal (admin)
    const targetId = '8fc7b70f-708f-4bfc-bc27-d52fb196a0b4'; // Ricardo

    await setAuthenticatedUser(client, adminId);

    // Deactivate Ricardo
    const deactRes = await client.query(
      `SELECT public.admin_toggle_user_status($1, false) as res`,
      [targetId]
    );
    assert.equal(deactRes.rows[0].res.success, true);
    assert.equal(deactRes.rows[0].res.is_active, false);

    // Verify DB row
    const deactDb = await client.query(
      `SELECT is_active FROM public.user_profiles WHERE id = $1`,
      [targetId]
    );
    assert.equal(deactDb.rows[0].is_active, false);

    // Reactivate Ricardo
    const reactRes = await client.query(
      `SELECT public.admin_toggle_user_status($1, true) as res`,
      [targetId]
    );
    assert.equal(reactRes.rows[0].res.success, true);
    assert.equal(reactRes.rows[0].res.is_active, true);

    // Verify DB row
    const reactDb = await client.query(
      `SELECT is_active FROM public.user_profiles WHERE id = $1`,
      [targetId]
    );
    assert.equal(reactDb.rows[0].is_active, true);
  });
});

test('5. Live DB: Admin self-deactivation is strictly forbidden', async () => {
  await withDbClient(async (client) => {
    const adminId = '1075a773-bb55-4296-bc71-af2eab9a0780'; // Kunal (admin)

    await setAuthenticatedUser(client, adminId);

    await assert.rejects(
      async () => {
        await client.query(
          `SELECT public.admin_toggle_user_status($1, false) as res`,
          [adminId]
        );
      },
      (err) => {
        assert.match(err.message, /cannot deactivate your own account/i);
        return true;
      }
    );
  });
});

test('6. Live DB: Non-admin status toggle is rejected', async () => {
  await withDbClient(async (client) => {
    const nonAdminId = '8fc7b70f-708f-4bfc-bc27-d52fb196a0b4'; // Ricardo (auditor_ca)
    const targetId = 'fff972ac-a5f3-42e6-beb8-61e185273b22'; // Aanvi

    await setAuthenticatedUser(client, nonAdminId);

    await assert.rejects(
      async () => {
        await client.query(
          `SELECT public.admin_toggle_user_status($1, false) as res`,
          [targetId]
        );
      },
      (err) => {
        assert.match(err.message, /Only active administrators can modify user status/i);
        return true;
      }
    );
  });
});

test('7. Live DB: check_user_can_delete protects users with historical business records', async () => {
  await withDbClient(async (client) => {
    const chintiaId = 'cd7b9d5f-d45c-4b5f-b113-68505a8cae27'; // Has expenses, batches, audit logs

    const res = await client.query(
      `SELECT can_delete, reason, reference_count FROM public.check_user_can_delete($1)`,
      [chintiaId]
    );

    assert.equal(res.rows[0].can_delete, false);
    assert.match(res.rows[0].reason, /Cannot delete user "chintia"/i);
    assert.match(res.rows[0].reason, /historical financial, business, or audit records/i);
    assert.ok(res.rows[0].reference_count > 0);
  });
});

test('8. Live DB: Deletion of user with business records is blocked via admin_delete_user', async () => {
  await withDbClient(async (client) => {
    const adminId = '1075a773-bb55-4296-bc71-af2eab9a0780';
    const chintiaId = 'cd7b9d5f-d45c-4b5f-b113-68505a8cae27';

    await setAuthenticatedUser(client, adminId);

    await assert.rejects(
      async () => {
        await client.query(`SELECT public.admin_delete_user($1)`, [chintiaId]);
      },
      (err) => {
        assert.match(err.message, /Cannot delete user/i);
        assert.match(err.message, /historical financial, business, or audit records/i);
        return true;
      }
    );
  });
});

test('9. Live DB: Safe deletion of an unreferenced test user succeeds completely', async () => {
  await withDbClient(async (client) => {
    const adminId = '1075a773-bb55-4296-bc71-af2eab9a0780';
    const testUserId = '77777777-7777-7777-7777-777777777777';

    // Create a temporary unreferenced user as superuser
    await client.query(`RESET ROLE`);
    await client.query(`
      INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'unref_test@example.com', 'test', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"Unref Test User","username":"unreftest"}'::jsonb, now(), now())
      ON CONFLICT (id) DO NOTHING;
    `, [testUserId]);

    await client.query(`
      INSERT INTO public.user_profiles (id, username, email, full_name, role, is_active)
      VALUES ($1, 'unreftest', 'unref_test@example.com', 'Unref Test User', 'sales', true)
      ON CONFLICT (id) DO UPDATE SET is_active = true;
    `, [testUserId]);

    await client.query(`
      INSERT INTO public.user_permissions (user_id, module, can_access)
      VALUES ($1, 'inventory', true)
      ON CONFLICT (user_id, module) DO NOTHING;
    `, [testUserId]);

    // Check can delete
    const checkRes = await client.query(
      `SELECT can_delete, reference_count FROM public.check_user_can_delete($1)`,
      [testUserId]
    );
    assert.equal(checkRes.rows[0].can_delete, true);
    assert.equal(checkRes.rows[0].reference_count, 0);

    // Delete as admin
    await setAuthenticatedUser(client, adminId);
    const delRes = await client.query(`SELECT public.admin_delete_user($1) as res`, [testUserId]);
    assert.equal(delRes.rows[0].res.success, true);

    // Verify completely deleted across all tables
    await client.query('RESET ROLE');
    const profileCheck = await client.query(`SELECT 1 FROM public.user_profiles WHERE id = $1`, [testUserId]);
    assert.equal(profileCheck.rowCount, 0);

    const authCheck = await client.query(`SELECT 1 FROM auth.users WHERE id = $1`, [testUserId]);
    assert.equal(authCheck.rowCount, 0);

    const permCheck = await client.query(`SELECT 1 FROM public.user_permissions WHERE user_id = $1`, [testUserId]);
    assert.equal(permCheck.rowCount, 0);
  });
});
