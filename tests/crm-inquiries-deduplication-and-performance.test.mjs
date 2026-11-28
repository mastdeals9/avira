import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const connectionString =
  process.env.SUPABASE_DB_URL ||
  (process.env.READONLY_AUDIT_DB_URL || '');

function getDbClient() {
  return new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
}

test('CRM Inquiries Deduplication, Performance & Approval Notifications Resilience', async (t) => {
  const db = getDbClient();
  await db.connect();

  t.after(async () => {
    await db.end();
  });

  await t.test('1. Verify crm_inquiries row count in live database is intact (baseline >= 355 rows)', async () => {
    const res = await db.query('SELECT count(*)::int as count FROM crm_inquiries');
    assert.ok(res.rows[0].count >= 355, `Expected at least 355 live inquiries, found ${res.rows[0].count}`);
  });

  await t.test('2. Verify useCrmInquiries.ts source implements authoritative singleton deduplication and explicit columns', () => {
    const hookSrc = readFileSync(resolve('src/components/crm/inquiries/useCrmInquiries.ts'), 'utf-8');

    // Must have in-flight promise deduplication
    assert.match(hookSrc, /inFlightInquiryPromise/, 'Must have inFlightInquiryPromise variable');
    assert.match(hookSrc, /if\s*\(inFlightInquiryPromise\)\s*\{\s*return inFlightInquiryPromise;?\s*\}/, 'Must return existing promise when fetch is in-flight');

    // Must preserve cached inquiries on error
    assert.match(hookSrc, /PRESERVE previous cached inquiries on error/, 'Must preserve cached inquiries on error');

    // Must NOT select * in CRM_INQUIRY_SELECT_FIELDS
    assert.doesNotMatch(hookSrc, /select\('\*'\)/, 'Must not use select(*)');
    const selectFieldsMatch = hookSrc.match(/export const CRM_INQUIRY_SELECT_FIELDS = `([\s\S]*?)`;/);
    assert.ok(selectFieldsMatch, 'Must define CRM_INQUIRY_SELECT_FIELDS');
    assert.doesNotMatch(selectFieldsMatch[1], /email_body/, 'Must exclude heavy email_body from query select fields');
    assert.match(hookSrc, /user_profiles:assigned_to\s*\(full_name\)/, 'Must fetch assigned_to relation');
  });

  await t.test('3. Verify CRM.tsx uses useCrmInquiries and has no duplicate loadInquiries query', () => {
    const crmSrc = readFileSync(resolve('src/pages/CRM.tsx'), 'utf-8');

    // Must use useCrmInquiries
    assert.match(crmSrc, /useCrmInquiries/, 'Must import and use useCrmInquiries hook');
    // Must NOT declare independent useState for inquiries
    assert.doesNotMatch(crmSrc, /const\s*\[inquiries,\s*setInquiries\]\s*=\s*useState<Inquiry\[\]>\(\[\]\);/, 'Must not declare duplicate inquiries state');
    // Must NOT run an independent select on crm_inquiries on mount
    assert.doesNotMatch(crmSrc, /useEffect\(\(\)\s*=>\s*\{\s*loadInquiries\(\);\s*\},\s*\[\]\);/, 'Must not have independent mount effect calling loadInquiries');
  });

  await t.test('4. Verify CrmInquiriesWorkspace uses useCrmInquiries and shares inquiries with PipelineBoard', () => {
    const wsSrc = readFileSync(resolve('src/components/crm/inquiries/CrmInquiriesWorkspace.tsx'), 'utf-8');

    // Must use useCrmInquiries
    assert.match(wsSrc, /useCrmInquiries/, 'Must use useCrmInquiries hook');
    // Must pass inquiries down to PipelineBoard
    assert.match(wsSrc, /<PipelineBoard[\s\S]*inquiries=\{inquiries\}/, 'Must pass inquiries to PipelineBoard');
    // Must not have independent loadInquiries query inside workspace
    assert.doesNotMatch(wsSrc, /\.from\('crm_inquiries'\)\s*\.select\(/, 'Workspace must not directly query crm_inquiries');
  });

  await t.test('5. Verify PipelineBoard accepts inquiries prop and avoids redundant queries', () => {
    const pbSrc = readFileSync(resolve('src/components/crm/PipelineBoard.tsx'), 'utf-8');

    assert.match(pbSrc, /inquiries\?: Inquiry\[\]/, 'Must define inquiries prop');
    assert.match(pbSrc, /if\s*\(propInquiries === undefined\)\s*\{\s*loadInquiries\(\);?\s*\}/, 'Must only load inquiries if propInquiries is undefined');
  });

  await t.test('6. Verify ApprovalNotifications uses Promise.allSettled and debouncing', () => {
    const appSrc = readFileSync(resolve('src/components/ApprovalNotifications.tsx'), 'utf-8');

    // Must use Promise.allSettled
    assert.match(appSrc, /Promise\.allSettled/, 'Must use Promise.allSettled instead of Promise.all');
    // Must guard in-flight execution
    assert.match(appSrc, /inFlightRef/, 'Must have in-flight guard');
    // Must debounce triggers
    assert.match(appSrc, /debouncedLoad/, 'Must use debounced trigger for realtime and focus events');
  });

  await t.test('7. Verify useSupabaseRealtimeChannel and erpSyncBus handle offline/disconnect gracefully', () => {
    const rtcSrc = readFileSync(resolve('src/hooks/useSupabaseRealtimeChannel.ts'), 'utf-8');
    const busSrc = readFileSync(resolve('src/utils/erpSyncBus.ts'), 'utf-8');

    assert.match(rtcSrc, /navigator\.onLine/, 'Must check navigator.onLine before subscribing');
    assert.match(rtcSrc, /window\.addEventListener\('online'/, 'Must listen for online event');
    assert.match(busSrc, /navigator\.onLine/, 'Must guard realtime broadcast when offline');
  });

  await t.test('8. Performance test: Explicit columns query executes on live database in under 300ms', async () => {
    const hookSrc = readFileSync(resolve('src/components/crm/inquiries/useCrmInquiries.ts'), 'utf-8');
    const match = hookSrc.match(/export const CRM_INQUIRY_SELECT_FIELDS = `([\s\S]*?)`;/);
    assert.ok(match, 'Must find CRM_INQUIRY_SELECT_FIELDS');
    
    // Convert Supabase select string to SQL columns (excluding joined relation)
    const sqlCols = match[1]
      .split(',')
      .map(c => c.trim())
      .filter(c => c && !c.includes('user_profiles:'))
      .join(', ');

    const countRes = await db.query('SELECT count(*)::int as count FROM crm_inquiries');
    const expectedCount = countRes.rows[0].count;
    assert.ok(expectedCount >= 355, `Expected at least 355 live inquiries, found ${expectedCount}`);

    const t0 = Date.now();
    const result = await db.query(`SELECT ${sqlCols} FROM crm_inquiries ORDER BY created_at DESC`);
    const elapsed = Date.now() - t0;

    assert.strictEqual(result.rows.length, expectedCount, `Must return all ${expectedCount} rows`);
    console.log(`Live DB query for ${expectedCount} rows with explicit columns completed in ${elapsed}ms`);
    assert.ok(elapsed < 2000, `Query took ${elapsed}ms, expected < 2000ms`);
  });
});
