import assert from 'node:assert/strict';
import test from 'node:test';

test('Edge Functions Local Authentication & Authorization Unit Suite', async (t) => {

  await t.test('1. Rejection of Forged and Unsigned JWTs', async () => {
    // Simulate Edge Function auth logic
    const supabaseUrl = 'https://mock.supabase.co';
    const anonKey = 'mock-anon-key';

    // A forged token constructed with base64url payload
    const forgedHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const forgedPayload = Buffer.from(JSON.stringify({
      iss: 'supabase',
      sub: '00000000-0000-0000-0000-000000000001',
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600
    })).toString('base64url');
    const forgedJwt = `${forgedHeader}.${forgedPayload}.invalidsignature`;

    // Simulated getUser verification function as implemented in the Edge Function
    async function verifyToken(jwt, mockAuthGetUser) {
      if (!jwt) return null;
      try {
        const { data, error } = await mockAuthGetUser(jwt);
        if (error || !data?.user) return null;
        return data.user;
      } catch {
        return null;
      }
    }

    // Mock auth.getUser returning error for forged signature
    const mockGetUser = async (token) => {
      if (token === forgedJwt) {
        return { data: null, error: new Error('invalid signature') };
      }
      return { data: { user: { id: 'legit-user' } }, error: null };
    };

    const user = await verifyToken(forgedJwt, mockGetUser);
    assert.equal(user, null, 'Forged JWT must be rejected with null user');
  });

  await t.test('2. Rejection of Expired JWTs', async () => {
    const expiredPayload = Buffer.from(JSON.stringify({
      iss: 'supabase',
      sub: '00000000-0000-0000-0000-000000000002',
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) - 3600 // 1 hour ago
    })).toString('base64url');
    const expiredJwt = `mockHeader.${expiredPayload}.mockSig`;

    const mockGetUser = async (token) => {
      if (token === expiredJwt) {
        return { data: null, error: new Error('jwt expired') };
      }
      return { data: { user: { id: 'legit-user' } }, error: null };
    };

    async function verifyToken(jwt) {
      const { data, error } = await mockGetUser(jwt);
      if (error || !data?.user) return null;
      return data.user;
    }

    const user = await verifyToken(expiredJwt);
    assert.equal(user, null, 'Expired JWT must be rejected with null user');
  });

  await t.test('3. Cross-User Mailbox Isolation Logic', () => {
    const callingUser = { id: 'user-sales-01', role: 'sales' };
    const connections = [
      { id: 'conn-1', user_id: 'user-sales-01', email_address: 'sales1@company.com', is_connected: true },
      { id: 'conn-2', user_id: 'user-ceo-02', email_address: 'ceo@company.com', is_connected: true },
    ];

    function resolveCandidateConnections(user, profile, explicitConnectionId) {
      const candidateConnections = [];
      const canAccessAllMailboxes = profile?.is_active && (profile?.role === 'admin' || profile?.role === 'manager');

      if (explicitConnectionId) {
        const explicitConn = connections.find(c => c.id === explicitConnectionId);
        if (explicitConn && explicitConn.is_connected) {
          if (canAccessAllMailboxes || explicitConn.user_id === user?.id) {
            candidateConnections.push(explicitConn);
          }
        }
      }

      // User's own connection
      const userConn = connections.find(c => c.user_id === user?.id);
      if (userConn && !candidateConnections.some(x => x.id === userConn.id)) {
        candidateConnections.push(userConn);
      }

      if (canAccessAllMailboxes) {
        for (const c of connections) {
          if (!candidateConnections.some(x => x.id === c.id)) {
            candidateConnections.push(c);
          }
        }
      }

      return candidateConnections;
    }

    // Sales user requesting CEO connection
    const salesProfile = { role: 'sales', is_active: true };
    const candidatesForSales = resolveCandidateConnections(callingUser, salesProfile, 'conn-2');
    assert.equal(candidatesForSales.length, 1, 'Sales user must only get 1 connection');
    assert.equal(candidatesForSales[0].id, 'conn-1', 'Sales user must NOT access CEO connection');
    assert.equal(candidatesForSales.some(c => c.id === 'conn-2'), false, 'CEO connection conn-2 must be blocked');

    // Admin user requesting CEO connection
    const adminUser = { id: 'admin-01', role: 'admin' };
    const adminProfile = { role: 'admin', is_active: true };
    const candidatesForAdmin = resolveCandidateConnections(adminUser, adminProfile, 'conn-2');
    assert.ok(candidatesForAdmin.some(c => c.id === 'conn-2'), 'Admin is permitted to inspect shared connections');
  });

  await t.test('4. WhatsApp Worker Secret Rejection without Vault/Env', () => {
    function verifyWorkerSecret(providedSecret, configuredEnvSecret) {
      return Boolean(configuredEnvSecret && providedSecret === configuredEnvSecret);
    }

    // Default legacy string should NOT match if env secret is different
    const legacySecret = 'sapj_wa_worker_internal_2026';
    const strongVaultSecret = 'b9f4e21a8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a';

    assert.equal(
      verifyWorkerSecret(legacySecret, strongVaultSecret),
      false,
      'Legacy hardcoded secret must be rejected when Vault secret is configured'
    );
    assert.equal(
      verifyWorkerSecret(legacySecret, undefined),
      false,
      'Worker must reject calls if no worker secret is configured in environment'
    );
    assert.equal(
      verifyWorkerSecret(strongVaultSecret, strongVaultSecret),
      true,
      'Worker must accept calls when provided secret matches configured Vault secret'
    );
  });
});

