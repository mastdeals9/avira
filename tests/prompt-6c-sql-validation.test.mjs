import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const sqlPath = path.resolve('/Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_6C_PHONE_DEMOTION_EXECUTION.sql');
const sqlContent = fs.readFileSync(sqlPath, 'utf8');

const approvedDemotions = [
  { company: 'DJAMU DJAGO', contact_id: '28afdb31-babd-4975-a100-26f81dd0fa16', demote_id: '1f503482-4f9c-47f1-a572-51df76a59361', keep_id: 'e1a9a8f1-3e29-48a6-afd2-7882927114d1' },
  { company: 'PT BAHTERA SENTRA NIAGATAMA', contact_id: '3004a29f-2fbe-48ea-bdc7-b6d0a8119c82', demote_id: 'f6a9cd15-7e04-4a61-88b8-d4654652e18e', keep_id: '957fd44a-1d7a-4bd0-a360-1aaf630505ae' },
  { company: 'PT COMBIPHAR', contact_id: 'cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b', demote_id: 'b1d0edf0-01a3-475f-9d59-5656d2c0141f', keep_id: 'ee79eea6-d631-4c94-86fa-f0fb75b86fec' },
  { company: 'PT Lloyd Pharma Indonesia', contact_id: 'd6830ce1-7904-4c01-afdd-392205293f40', demote_id: 'ce170f91-fe35-4729-945c-a73fa22e5e0b', keep_id: '633c42a3-d976-43af-897b-638f4cfb8089' },
  { company: 'PT Perusahaan Dagang dan Industri Kaliroto', contact_id: '177e9c47-7c57-438a-911b-5ffca8652ab8', demote_id: '086bdf95-f282-4c80-80a6-c0c7f84885a8', keep_id: '279e459b-0b22-4ec0-b253-6587308afbb8' },
  { company: 'PT Prima Cita Prasada', contact_id: '78958f07-0fdf-4c87-a93d-9a8454f9eb1c', demote_id: '0ea5aa2a-7285-4545-a5b9-74ca80a1ee76', keep_id: 'f1f13dad-d70d-40b1-beb6-170b1126c458' },
  { company: 'PT Roi Surya Prima Farma', contact_id: 'ef17e387-502c-4506-8ad7-3dc59e4b2f49', demote_id: '20272510-d496-4aa8-8d33-c22d3e5c778c', keep_id: 'e3db634a-8ecf-4dd1-bb19-563d408d9020' },
  { company: 'PT Shubham Anzen Pharma Jaya', contact_id: 'b768af4b-dd06-4a0e-841f-5a6aa4dd188e', demote_id: 'c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1', keep_id: 'a4b63186-6fab-4c81-8de1-da9df64bd1b1' },
  { company: 'PT Synergi Mitra Abadi', contact_id: '2a53b06c-67d1-45da-9c38-edde3be7dc93', demote_id: 'df629243-0d0d-44ca-af04-a1edb39f3d9a', keep_id: 'f5ff2c11-8056-4574-9531-236808e86e92' },
  { company: 'PT. SANBE FARMA (Demote 1)', contact_id: 'c5d7c938-5878-4bfa-bf44-36e81dddc1a4', demote_id: '17da83bf-c7ba-4d0e-9723-e30e49f080c5', keep_id: '121900ba-053f-4511-874a-30ad153dfef4' },
  { company: 'PT. SANBE FARMA (Demote 2)', contact_id: 'c5d7c938-5878-4bfa-bf44-36e81dddc1a4', demote_id: 'aab97f7e-2f24-4a1f-977f-0b0e44625171', keep_id: '121900ba-053f-4511-874a-30ad153dfef4' },
  { company: 'PT.Medion Farma Jaya', contact_id: '986ea4c3-2f2a-4ad2-97d8-f4e758705c5a', demote_id: 'db76ee70-1c78-4e95-9b31-8b9c79e85394', keep_id: '1a3e642d-6f9a-4974-9abe-861442cba7ff' },
  { company: 'PT.Rama Emerald Multi Sukses', contact_id: '3b61c088-4b91-4217-835b-3577da389fc0', demote_id: 'ec57e9b5-b66d-4840-a406-6f2a443a28ee', keep_id: '26dbb22b-c2ce-401c-a3c0-53951287fac1' }
];

const commercialExcludedCompanies = [
  'PT Afifarma',
  'PT ANUGRAH VISI BERSAMA',
  'PT Konimex',
  'PT Medikon Prima Laboratories',
  'PT. Mahakam Beta Farma',
  'PT. Meiji'
];

test('Prompt 6C: All 13 approved demote UUIDs and 12 retain UUIDs match register', () => {
  for (const item of approvedDemotions) {
    assert.ok(sqlContent.includes(item.demote_id), `SQL must contain demote UUID ${item.demote_id} (${item.company})`);
    assert.ok(sqlContent.includes(item.keep_id), `SQL must contain keep UUID ${item.keep_id} (${item.company})`);
    assert.ok(sqlContent.includes(item.contact_id), `SQL must contain contact UUID ${item.contact_id} (${item.company})`);
  }
});

test('Prompt 6C: Lock 25 rows (FOR UPDATE) in execution block', () => {
  assert.ok(sqlContent.includes('FOR UPDATE;'), 'SQL must execute FOR UPDATE row-locking');
  assert.ok(sqlContent.includes('v_locked_count <> 25'), 'SQL must assert exactly 25 locked records');
});

test('Prompt 6C: UPDATE ... RETURNING captures affected rows and asserts exactly 13', () => {
  assert.ok(sqlContent.includes('RETURNING id'), 'SQL must use UPDATE ... RETURNING id');
  assert.ok(sqlContent.includes('v_rows_updated <> 13'), 'SQL must assert v_rows_updated <> 13');
  assert.ok(!sqlContent.includes('GET DIAGNOSTICS v_rows_updated = ROW_COUNT'), 'Old disconnected GET DIAGNOSTICS must be replaced');
});

test('Prompt 6C: Postcondition verifies each of 12 contacts has exactly 1 primary phone (catching 0 and >1)', () => {
  assert.ok(sqlContent.includes('HAVING COUNT(p.id) FILTER (WHERE p.is_primary = true) <> 1'), 'Postcondition must detect both 0 and >1 primary phones');
  assert.ok(sqlContent.includes('v_anomalous_contact_count > 0'), 'Postcondition must abort if any anomalous contact count detected');
});

test('Prompt 6C: Safe, conditional rollback checks preconditions before restoring', () => {
  assert.ok(sqlContent.includes('SECTION 4: SAFE CONDITIONAL ROLLBACK SCRIPT'), 'Rollback section must exist');
  assert.ok(sqlContent.includes('v_invalid_demoted'), 'Rollback must verify demoted phones state before restoring');
  assert.ok(sqlContent.includes('v_invalid_retained'), 'Rollback must verify retained phones state before restoring');
  assert.ok(sqlContent.includes('v_restored_rows <> 13'), 'Rollback must assert exactly 13 restored rows');
});

test('Prompt 6C: No partial unique index is created', () => {
  assert.ok(!sqlContent.includes('CREATE UNIQUE INDEX'), 'Must NOT create partial unique index');
  assert.ok(!sqlContent.includes('CREATE INDEX'), 'Must NOT create index');
});

test('Prompt 6C: All 6 commercial confirmation cases remain excluded', () => {
  for (const c of commercialExcludedCompanies) {
    assert.ok(!sqlContent.includes(c), `SQL execution script must not include commercial case ${c}`);
  }
});

