import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from '/Users/Kunal/Documents/anzen-main/node_modules/pg/lib/index.js';

test('P&L Summary Contra Revenue Harmonization Test', async () => {
  const { Client } = pg;
  const client = new Client({
    connectionString: (process.env.READONLY_AUDIT_DB_URL || ''),
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  await client.query('BEGIN;');

  try {
    // 1. Check live baseline before migration
    const beforeRes = await client.query(`
      SELECT * FROM public.get_pnl_summary('2025-01-02'::date, '2026-10-31'::date, 16800);
    `);
    const before = beforeRes.rows[0];
    assert.equal(Number(before.total_revenue).toFixed(2), '7121381700.25', 'Before: Revenue must omit contra revenue');
    assert.equal(Number(before.total_expenses).toFixed(2), '8544834453.94', 'Before: Expenses must equal 8,544,834,453.94');
    assert.equal(Number(before.net_income).toFixed(2), '-1423452753.69', 'Before: Net income must equal -1,423,452,753.69');

    // 2. Apply migration SQL inside transaction
    const migrationSql = fs.readFileSync('supabase/migrations/20261102040000_pnl_summary_include_contra_revenue.sql', 'utf8');
    await client.query(migrationSql);

    // 3. Check output after migration
    const afterRes = await client.query(`
      SELECT * FROM public.get_pnl_summary('2025-01-02'::date, '2026-10-31'::date, 16800);
    `);
    const after = afterRes.rows[0];

    // Assert exact reconciliation
    assert.equal(Number(after.total_revenue).toFixed(2), '7119809325.25', 'After: Revenue must deduct GL 4300 Sales Returns (1,572,375.00)');
    assert.equal(Number(after.total_expenses).toFixed(2), '8544834453.94', 'After: Expenses must remain 8,544,834,453.94');
    assert.equal(Number(after.net_income).toFixed(2), '-1425025128.69', 'After: Net income must equal exactly -1,425,025,128.69');

    // Verify exact difference
    const revDiff = Number(before.total_revenue) - Number(after.total_revenue);
    assert.equal(Number(revDiff.toFixed(2)), 1572375.00, 'Revenue difference must be exactly 1,572,375.00');

    const netDiff = Number(before.net_income) - Number(after.net_income);
    assert.equal(Number(netDiff.toFixed(2)), 1572375.00, 'Net income difference must be exactly 1,572,375.00');

  } finally {
    await client.query('ROLLBACK;');
    await client.end();
  }
});

