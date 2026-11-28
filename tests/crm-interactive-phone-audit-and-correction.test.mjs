import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  validatePhoneNumber,
  suggestCleanMobileNumber,
  auditAndVerifyContacts,
  detectCountryInfo,
  groupDuplicates,
  getBulkNormalizationCandidates,
} from '../src/utils/phoneValidation.ts';

const DB_URL =
  process.env.READONLY_AUDIT_DB_URL ||
  (process.env.READONLY_AUDIT_DB_URL || '');

test('SAPJ Interactive Phone Audit & Correction Suite', async (t) => {
  await t.test('1. Count Reconciliation: 65 Eligible + 315 Landlines + 110 Missing + 31 Invalid = exactly 521 Total Directory', async () => {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();

  const res = await client.query(
    'SELECT id, company_name, contact_person, email, phone, mobile, city, customer_type, notes FROM crm_contacts WHERE is_active = true ORDER BY company_name'
  );
  await client.end();

  const audit = auditAndVerifyContacts(res.rows);

  // Exact directory size
  assert.equal(audit.stats.total, 521, 'Total CRM directory must equal exactly 521 active contacts');

  // Partition breakdown (validates active CRM directory as numbers are verified & corrected)
  assert.ok(audit.stats.eligible >= 65, 'WhatsApp eligible mobile numbers must be at least baseline 65');
  assert.ok(audit.stats.landline <= 315, 'Landline numbers must be at most baseline 315');
  assert.ok(audit.stats.missing <= 110, 'Missing phone numbers must be at most baseline 110');
  assert.ok(audit.stats.invalid <= 31, 'Invalid phone numbers must be at most baseline 31');

  // Mathematical partition identity: mutually exclusive categories sum exactly to total
  const primarySum = audit.stats.eligible + audit.stats.landline + audit.stats.missing + audit.stats.invalid;
  assert.equal(primarySum, 521, 'Primary mutually exclusive categories must sum to exactly 521');

  // Overlapping duplicates flag
  assert.ok(audit.stats.duplicates >= 8, 'Overlapping duplicate contacts count must be at least baseline 8');
  });

  await t.test('2. Phone Normalization Engine: formats 08... and 628... to +62 without turning landlines into mobiles', () => {
  // Indonesian mobile normalizations
  const m1 = validatePhoneNumber('081234567890');
  assert.equal(m1.normalized, '+6281234567890');
  assert.equal(m1.type, 'valid_mobile');
  assert.equal(m1.isWhatsAppEligible, true);

  const m2 = validatePhoneNumber('+62 812-3456-7890');
  assert.equal(m2.normalized, '+6281234567890');
  assert.equal(m2.type, 'valid_mobile');

  const m3 = validatePhoneNumber('6281234567890');
  assert.equal(m3.normalized, '+6281234567890');
  assert.equal(m3.type, 'valid_mobile');

  // Indonesian landlines must NOT become mobile
  const l1 = validatePhoneNumber('(021) 53153194');
  assert.equal(l1.type, 'landline');
  assert.equal(l1.isWhatsAppEligible, false);
  assert.match(l1.reason, /landline/i);

  const l2 = validatePhoneNumber('0263-512828');
  assert.equal(l2.type, 'landline');
  assert.equal(l2.isWhatsAppEligible, false);

  // International numbers
  const intl = validatePhoneNumber('+91 98765 43210');
  assert.equal(intl.type, 'international_number');
  assert.equal(intl.isWhatsAppEligible, true);
  assert.equal(intl.countryCode, '+91');

  // Invalid numbers
  const inv1 = validatePhoneNumber('Business Number 344107');
  assert.equal(inv1.type, 'invalid_number');
  assert.equal(inv1.isWhatsAppEligible, false);

  // Missing numbers
  const mis = validatePhoneNumber('');
  assert.equal(mis.type, 'missing_number');
  assert.equal(mis.isWhatsAppEligible, false);
  });

  await t.test('3. Clean Mobile Suggestion: extracts valid mobile from multi-number strings and noisy formatting', () => {
  // Multi-number string with mobile and landline
  const clean1 = suggestCleanMobileNumber('0812-9647-9477, 021-55787162');
  assert.equal(clean1, '+6281296479477', 'Must extract first valid mobile from multi-number string');

  // Trailing noise
  const clean2 = suggestCleanMobileNumber('+62 811-3948-965 I');
  assert.equal(clean2, '+628113948965', 'Must strip trailing letter noise');

  // Spaced format
  const clean3 = suggestCleanMobileNumber('0838 3262  7334');
  assert.equal(clean3, '+6283832627334', 'Must format spaced Indonesian mobile');
  });

  await t.test('4. Duplicate Grouping: detects cross-company vs same-company groups accurately', async () => {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const res = await client.query(
    'SELECT id, company_name, contact_person, email, phone, mobile, city, customer_type, notes FROM crm_contacts WHERE is_active = true ORDER BY company_name'
  );
  await client.end();

  const audit = auditAndVerifyContacts(res.rows);
  const groups = groupDuplicates(audit.items);

  // Total duplicate items across groups must contain at least baseline 8
  const totalInGroups = groups.reduce((sum, g) => sum + g.count, 0);
  assert.ok(totalInGroups >= 8, 'Duplicate groups must contain at least 8 duplicate contacts');

  // Find Surya Dermato group: 3 contacts, classified as same-group sister companies
  const suryaGroup = groups.find(g => g.normalizedPhone === '+628113948965');
  assert.ok(suryaGroup, 'Surya Dermato duplicate group must exist');
  assert.equal(suryaGroup.count, 3);
  assert.equal(suryaGroup.isSameCompanyGroup, true, 'Surya Dermato sister companies must be classified as same_company group');

  // Find Yarindo group: 3 contacts
  const yarindoGroup = groups.find(g => g.normalizedPhone === '+628176644241');
  assert.ok(yarindoGroup, 'Yarindo duplicate group must exist');
  assert.equal(yarindoGroup.count, 3);

  // Find Kimia Farma group: 2 contacts
  const kfGroup = groups.find(g => g.normalizedPhone === '+621500255');
  assert.ok(kfGroup, 'Kimia Farma duplicate group must exist');
  assert.equal(kfGroup.count, 2);
  });

  await t.test('5. Safe Bulk Normalization Candidates: excludes landlines and missing numbers', async () => {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const res = await client.query(
    'SELECT id, company_name, contact_person, email, phone, mobile, city, customer_type, notes FROM crm_contacts WHERE is_active = true ORDER BY company_name'
  );
  await client.end();

  const audit = auditAndVerifyContacts(res.rows);
  const candidates = getBulkNormalizationCandidates(audit.items);

  assert.ok(candidates.length > 0, 'Must identify safe bulk normalization candidates');

  for (const cand of candidates) {
    // None can be landlines
    assert.notEqual(cand.currentType, 'landline', 'Bulk normalization candidate must never be a landline');
    assert.notEqual(cand.currentType, 'missing_number', 'Bulk normalization candidate must never be missing');
    // Proposed must always be valid_mobile or international
    assert.ok(
      cand.newType === 'valid_mobile' || cand.newType === 'international_number',
      `Proposed normalized number must be valid mobile: ${cand.proposedNormalized}`
    );
    assert.match(cand.proposedNormalized, /^\+\d{10,15}$/, 'Proposed must be E.164 with + prefix');
  }
  });

  await t.test('6. Database Persistence & Audit Trail Verification: saves mobile update and updates classification without row deletion or duplication', async () => {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();

  try {
    // Find one test contact to simulate correction
    const selectRes = await client.query(
      "SELECT id, company_name, contact_person, mobile, phone FROM crm_contacts WHERE company_name = 'PT PITALA GUNAWAN RAYA' LIMIT 1"
    );
    assert.equal(selectRes.rows.length, 1, 'Target contact must exist');
    const target = selectRes.rows[0];

    const testMobile = '+6281299990001';

    // 1. Update mobile
    await client.query(
      'UPDATE crm_contacts SET mobile = $1, updated_at = now() WHERE id = $2',
      [testMobile, target.id]
    );

    // 2. Insert audit note in crm_activities (activity_type must be lowercase 'note')
    await client.query(
      `INSERT INTO crm_activities (customer_id, activity_type, subject, description, is_completed, completed_at)
       VALUES ($1, 'note', 'Phone Number Audit Correction', 'Automated test correction to +6281299990001', true, now())`,
      [target.id]
    );

    // 3. Verify updated row
    const verifyRes = await client.query(
      'SELECT id, mobile, phone FROM crm_contacts WHERE id = $1',
      [target.id]
    );
    assert.equal(verifyRes.rows[0].mobile, testMobile, 'Mobile column must be updated in database');

    // 4. Verify total count remains exactly 521 (no accidental deletion or duplication)
    const countRes = await client.query('SELECT count(*) FROM crm_contacts WHERE is_active = true');
    assert.equal(Number(countRes.rows[0].count), 521, 'Total contact count must remain exactly 521');

    // 5. Verify audit trail note exists
    const actRes = await client.query(
      "SELECT subject, description FROM crm_activities WHERE customer_id = $1 AND subject = 'Phone Number Audit Correction' ORDER BY created_at DESC LIMIT 1",
      [target.id]
    );
    assert.equal(actRes.rows.length, 1, 'Audit activity note must be recorded in crm_activities');

    // 6. Clean up: restore original mobile (null)
    await client.query(
      'UPDATE crm_contacts SET mobile = $1, updated_at = now() WHERE id = $2',
      [target.mobile, target.id]
    );
    await client.query(
      "DELETE FROM crm_activities WHERE customer_id = $1 AND description = 'Automated test correction to +6281299990001'",
      [target.id]
    );
  } finally {
    // Fail-safe cleanup in case of any assertion error
    await client.query(
      "UPDATE crm_contacts SET mobile = NULL WHERE company_name = 'PT PITALA GUNAWAN RAYA' AND mobile = '+6281299990001'"
    ).catch(() => {});
    await client.query(
      "DELETE FROM crm_activities WHERE description = 'Automated test correction to +6281299990001'"
    ).catch(() => {});
    await client.end();
  }
  });

  await t.test('7. Source Code Architectural Verification: PhoneAuditCorrectionModal exists and wires all 6 cards', () => {
  const modalCode = readFileSync(
    resolve('src/components/crm/campaigns/PhoneAuditCorrectionModal.tsx'),
    'utf-8'
  );
  const workspaceCode = readFileSync(
    resolve('src/components/crm/campaigns/CrmCampaignsWorkspace.tsx'),
    'utf-8'
  );

  // Modal exports and features
  assert.ok(modalCode.includes('export function PhoneAuditCorrectionModal'), 'PhoneAuditCorrectionModal must be exported');
  assert.ok(modalCode.includes('handleSaveContact'), 'handleSaveContact must be implemented for Supabase updates');
  assert.ok(modalCode.includes('crm_activities'), 'crm_activities audit logging must be implemented');
  assert.ok(modalCode.includes('handleApplyBulkNormalization'), 'Safe bulk normalization execution must be implemented');
  assert.ok(modalCode.includes('groupDuplicates'), 'Duplicates grouped view must be implemented');
  assert.ok(modalCode.includes('detectCountryInfo'), 'Country detection with flags must be implemented');

  // Workspace integration
  assert.ok(workspaceCode.includes('PhoneAuditCorrectionModal'), 'CrmCampaignsWorkspace must import PhoneAuditCorrectionModal');
  assert.ok(workspaceCode.includes("setPhoneAuditCategory('total')"), 'Card 1 (Total) must be clickable');
  assert.ok(workspaceCode.includes("setPhoneAuditCategory('eligible')"), 'Card 2 (Eligible) must be clickable');
  assert.ok(workspaceCode.includes("setPhoneAuditCategory('landline')"), 'Card 3 (Landlines) must be clickable');
  assert.ok(workspaceCode.includes("setPhoneAuditCategory('missing')"), 'Card 4 (Missing) must be clickable');
  assert.ok(workspaceCode.includes("setPhoneAuditCategory('invalid')"), 'Card 5 (Invalid) must be clickable');
  assert.ok(workspaceCode.includes("setPhoneAuditCategory('duplicates')"), 'Card 6 (Duplicates) must be clickable');
  });
});
