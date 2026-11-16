import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';

test('SAPJ Security Verification & Safe Remediation Suite', async (t) => {

  await t.test('1. Verify Gmail Edge Functions have no hardcoded secrets or unverified JWT fallback', () => {
    const attachmentViewSrc = readFileSync('supabase/functions/gmail-attachment-view/index.ts', 'utf8');
    const inboxMessageSrc = readFileSync('supabase/functions/gmail-inbox-message/index.ts', 'utf8');
    const gmailAgentSrc = readFileSync('supabase/functions/sapj-gmail-agent/index.ts', 'utf8');

    // Neither function should contain hardcoded sapj-internal-cron-trigger
    assert.doesNotMatch(attachmentViewSrc, /"sapj-internal-cron-trigger"/, 'gmail-attachment-view must not accept hardcoded cron trigger string');
    assert.doesNotMatch(inboxMessageSrc, /"sapj-internal-cron-trigger"/, 'gmail-inbox-message must not accept hardcoded cron trigger string');
    assert.doesNotMatch(gmailAgentSrc, /"sapj-internal-cron-trigger"/, 'sapj-gmail-agent must not accept hardcoded cron trigger string');

    // Must not accept anonKey as user authorization
    assert.doesNotMatch(attachmentViewSrc, /jwt === anonKey \|\| apiKey === anonKey/, 'gmail-attachment-view must not treat anonKey as authorization');
    assert.doesNotMatch(inboxMessageSrc, /jwt === anonKey \|\| apiKey === anonKey/, 'gmail-inbox-message must not treat anonKey as authorization');

    // Must not parse unverified JWT payload without signature verification
    assert.doesNotMatch(attachmentViewSrc, /JSON\.parse\(decodeBase64Url\(parts\[1\]\)\)/, 'gmail-attachment-view must not decode unverified JWT payload');
    assert.doesNotMatch(inboxMessageSrc, /JSON\.parse\(decodeBase64Url\(parts\[1\]\)\)/, 'gmail-inbox-message must not decode unverified JWT payload');
  });

  await t.test('2. Verify WhatsApp Campaign worker has no hardcoded secret fallback', () => {
    const waWorkerSrc = readFileSync('supabase/functions/process-whatsapp-campaign/index.ts', 'utf8');
    assert.doesNotMatch(waWorkerSrc, /"sapj_wa_worker_internal_2026"/, 'process-whatsapp-campaign must not use hardcoded secret fallback');
  });

  await t.test('3. Verify proposed migration file exists and contains essential DDL guards', () => {
    const migrationPath = 'supabase/migrations/20261115000000_security_hardening_storage_rls_and_privilege_escalation.sql';
    assert.ok(existsSync(migrationPath), 'Migration file must exist');

    const migrationSql = readFileSync(migrationPath, 'utf8');

    // Must alter search_path for the 11 functions
    assert.match(migrationSql, /ALTER FUNCTION public\.current_user_has_pricing_role/);
    assert.match(migrationSql, /ALTER FUNCTION public\.edit_approved_finance_expense_atomic/);
    assert.match(migrationSql, /ALTER FUNCTION public\.save_finance_expense/);

    // Must secure vw_universal_document_bank
    assert.match(migrationSql, /security_invoker = true/);
    assert.match(migrationSql, /REVOKE (ALL|SELECT) ON public\.vw_universal_document_bank FROM anon/);

    // Must secure storage.objects
    assert.match(migrationSql, /DROP POLICY IF EXISTS "Allow authenticated users to update batch documents"/);
    assert.match(migrationSql, /DROP POLICY IF EXISTS "Users can delete batch documents"/);
    assert.match(migrationSql, /DROP POLICY IF EXISTS "Users can delete expense documents"/);

    // Must secure user_profiles against privilege escalation
    assert.match(migrationSql, /DROP POLICY IF EXISTS "Users can delete own profile"/);
    assert.match(migrationSql, /trg_prevent_self_privilege_escalation/);
    assert.match(migrationSql, /BEFORE INSERT OR UPDATE/);

    // Must secure invoke_process_whatsapp_campaign
    assert.match(migrationSql, /REVOKE EXECUTE ON FUNCTION public\.invoke_process_whatsapp_campaign\(\) FROM PUBLIC/);

    // Must NOT directly insert into supabase_migrations metadata table
    assert.doesNotMatch(migrationSql, /INSERT INTO supabase_migrations\.schema_migrations/, 'Migration must not directly mutate supabase_migrations metadata table');

    // Must reject NULL role on user_profiles
    assert.match(migrationSql, /role IS NOT NULL/, 'User profile creation must require explicit non-NULL role');
  });
});
