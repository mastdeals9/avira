import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migrationSql = readFileSync(
  new URL('../supabase/migrations/20261125220000_tax_ntpn_distinction_and_remaining_safeguards.sql', import.meta.url),
  'utf8',
);

const bankRecSource = readFileSync(
  new URL('../src/components/finance/BankReconciliationEnhanced.tsx', import.meta.url),
  'utf8',
);

test('1. Tax NTPN migration separates ntpn_format_valid from ntpn_verified', () => {
  assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS ntpn_format_valid boolean NOT NULL DEFAULT false/);
  assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS ntpn_verified_at timestamptz/);
  assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS ntpn_verified_by uuid/);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.sync_tax_payment_ntpn_flags\(\)/);
  assert.match(migrationSql, /IF NEW\.ntpn_verified IS TRUE AND NEW\.ntpn_verified_at IS NULL THEN\s*NEW\.ntpn_verified := false;/);
  assert.match(migrationSql, /IF NEW\.ntpn_verified IS TRUE AND NOT NEW\.ntpn_format_valid THEN\s*RAISE EXCEPTION/);
});

test('2. Tax NTPN migration clears mistaken company NPWP 0268760261042000 from ntpn', () => {
  assert.match(migrationSql, /v_trimmed <> '0268760261042000'/);
  assert.match(migrationSql, /WHERE id = 'c7940eda-2fbc-4ae0-8aa7-036daf314ede'\s+AND trim\(COALESCE\(ntpn, ''\)\) = '0268760261042000'/);
});

test('3. Bank reconciliation keeps suggested matches distinct from confirmed matches', () => {
  assert.match(bankRecSource, /matching_status/);
  assert.match(bankRecSource, /needs_review/);
  assert.match(bankRecSource, /manually_unlinked/);
});
