import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from '/Users/Kunal/Documents/anzen-main/node_modules/pg/lib/index.js';

const MIGRATION_PATH = 'supabase/migrations/20261103010000_harmonize_all_sales_profitability_reports.sql';
const DB_URL = process.env.READONLY_AUDIT_DB_URL || (process.env.READONLY_AUDIT_DB_URL || '');

test('1. Migration File Structure: Harmonization of All Sales Reports', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), 'Migration file must exist');
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.get_monthly_sales_report'), 'Must update get_monthly_sales_report');
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.get_product_performance_report'), 'Must update get_product_performance_report');
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.get_customer_sales_report'), 'Must update get_customer_sales_report');
  assert.ok(sql.includes('public.get_authoritative_sales_line_cogs'), 'All reports must query get_authoritative_sales_line_cogs');
  assert.ok(sql.includes('public.is_reportable_sales_invoice'), 'All reports must filter with is_reportable_sales_invoice');
});

test('2. Live Harmonization Simulation (Transaction Rollback): Complete Parity Across Reports', async () => {
  const client = new pg.Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  try {
    await client.query('BEGIN;');

    const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    await client.query(migrationSql);

    const startDate = '2024-01-01';
    const endDate = '2026-12-31';

    // 1. Canonical Summary
    const canonRes = await client.query('SELECT public.get_sales_profitability_summary($1, $2) as res;', [startDate, endDate]);
    const canonCompany = canonRes.rows[0].res.company;
    const expectedNetSales = Number(canonCompany.net_sales); // 7119809323.75
    const expectedNetCogs = Number(canonCompany.net_product_cost); // 6619295983.92

    assert.equal(expectedNetSales, 7119809323.75, 'Canonical Net Sales must equal 7,119,809,323.75');
    assert.equal(expectedNetCogs, 6619295983.92, 'Canonical Net COGS must equal 6,619,295,983.92');

    // 2. Monthly Sales Report
    const monthlyRes = await client.query('SELECT * FROM public.get_monthly_sales_report($1, $2);', [startDate, endDate]);
    let monthlySalesTotal = 0, monthlyCogsTotal = 0;
    monthlyRes.rows.forEach(r => {
      monthlySalesTotal += Number(r.total_sales || 0);
      monthlyCogsTotal += Number(r.total_cogs || 0);
    });

    assert.ok(
      Math.abs(monthlySalesTotal - expectedNetSales) < 0.05,
      `Monthly sales (${monthlySalesTotal}) must match Canonical net sales (${expectedNetSales})`
    );
    assert.ok(
      Math.abs(monthlyCogsTotal - expectedNetCogs) < 0.10,
      `Monthly COGS (${monthlyCogsTotal}) must match Canonical COGS (${expectedNetCogs})`
    );

    // 3. Product Performance Report
    const prodRes = await client.query('SELECT * FROM public.get_product_performance_report($1, $2);', [startDate, endDate]);
    let prodSalesTotal = 0, prodCogsTotal = 0;
    prodRes.rows.forEach(r => {
      prodSalesTotal += Number(r.total_sales || 0);
      prodCogsTotal += Number(r.total_cost || 0);
    });

    assert.ok(
      Math.abs(prodSalesTotal - expectedNetSales) < 0.05,
      `Product performance sales (${prodSalesTotal}) must match Canonical net sales (${expectedNetSales})`
    );
    assert.ok(
      Math.abs(prodCogsTotal - expectedNetCogs) < 0.05,
      `Product performance COGS (${prodCogsTotal}) must match Canonical COGS (${expectedNetCogs})`
    );

    // 4. Customer Sales Report
    const custRes = await client.query('SELECT * FROM public.get_customer_sales_report($1, $2);', [startDate, endDate]);
    let custSalesTotal = 0, custCogsTotal = 0;
    custRes.rows.forEach(r => {
      custSalesTotal += Number(r.total_sales || 0);
      custCogsTotal += Number(r.total_cogs || 0);
    });

    assert.ok(
      Math.abs(custSalesTotal - expectedNetSales) < 0.05,
      `Customer report sales (${custSalesTotal}) must match Canonical net sales (${expectedNetSales})`
    );
    assert.ok(
      Math.abs(custCogsTotal - expectedNetCogs) < 0.05,
      `Customer report COGS (${custCogsTotal}) must match Canonical COGS (${expectedNetCogs})`
    );

    // 5. Verify Uninvoiced Status of DO-26-0074
    const do74 = await client.query(`
      SELECT si.id 
      FROM delivery_challans dc
      JOIN sales_invoices si ON (si.linked_challan_ids::text ILIKE '%' || dc.id || '%' OR si.delivery_challan_number = dc.challan_number)
      WHERE dc.challan_number = 'DO-26-0074';
    `);
    assert.equal(do74.rows.length, 0, 'DO-26-0074 must remain unbilled and not linked to any sales invoice');

  } finally {
    await client.query('ROLLBACK;');
    await client.end();
  }
});

