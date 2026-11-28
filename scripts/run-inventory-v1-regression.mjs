#!/usr/bin/env node

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const databaseUrl =
  process.env.READONLY_AUDIT_DB_URL ||
  process.env.READONLY_AUDIT_DB_URL ||
  process.env.READONLY_AUDIT_DB_URL;
const includeMigration = process.argv.includes('--with-migration');
const useLinked = process.argv.includes('--linked') || !databaseUrl;
const regressionPath = 'scripts/inventory-v1-regression.sql';
const migrationPaths = [
  'supabase/migrations/20260801120000_inventory_v1_canonical_stock_engine.sql',
  'supabase/migrations/20260801121000_fix_credit_note_reversal_trigger_timing.sql',
  'supabase/migrations/20260801122000_inventory_v1_provable_legacy_metadata_repairs.sql',
  'supabase/migrations/20260801123000_revoke_anon_inventory_security_definer.sql',
  'supabase/migrations/20260801124000_revoke_public_inventory_security_definer.sql',
  'supabase/migrations/20260801125000_exclude_expired_stock_from_available_summary.sql',
];

let sqlPath = regressionPath;
let temporaryDirectory;

if (includeMigration) {
  const migrations = migrationPaths.map((migrationPath) =>
    readFileSync(migrationPath, 'utf8')
      .replace(/^\s*BEGIN;\s*/i, '')
      .replace(/\s*COMMIT;\s*$/i, ''),
  );
  const regression = readFileSync(regressionPath, 'utf8')
    .replace(/^\s*BEGIN;\s*/i, '');

  temporaryDirectory = mkdtempSync(join(tmpdir(), 'sapj-inventory-v1-'));
  sqlPath = join(temporaryDirectory, 'migration-and-regression.sql');
  writeFileSync(
    sqlPath,
    [
      'BEGIN;',
      ...migrations,
      regression,
    ].join('\n\n'),
  );
}

const command = useLinked ? 'npx' : 'psql';
const args = useLinked
  ? [
      'supabase',
      'db',
      'query',
      '--linked',
      '--file',
      sqlPath,
      '--output-format',
      'text',
    ]
  : [
      databaseUrl,
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--file',
      sqlPath,
    ];

try {
  const result = spawnSync(command, args, { stdio: 'inherit' });

  if (result.error) {
    console.error(`Cannot run Inventory V1 regression: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
} finally {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
