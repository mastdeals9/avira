// Read-only finance-audit verification.
// Run:  SUPABASE_DB_URL=(process.env.READONLY_AUDIT_DB_URL || '') node scripts/finance-audit-verify.mjs
// No writes. All queries are SELECT/information_schema/pg_catalog.

import { Client } from 'pg';

const dbUrl = process.env.READONLY_AUDIT_DB_URL || process.env.READONLY_AUDIT_DB_URL || process.env.READONLY_AUDIT_DB_URL;
if (!dbUrl) {
  console.error('Missing SUPABASE_DB_URL (or DATABASE_URL/POSTGRES_URL).');
  process.exit(1);
}

const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

const checks = [
  // §1.1 IntegrityMonitor reads non-existent views
  {
    id: '1.1',
    label: 'IntegrityMonitor: views the UI queries — do they exist?',
    sql: `
      SELECT v.expected, (c.relname IS NOT NULL) AS exists
      FROM (VALUES
        ('unbalanced_journal_entries'),
        ('duplicate_postings'),
        ('orphan_journal_lines'),
        ('missing_petty_cash_links'),
        ('negative_cash_anomalies')
      ) v(expected)
      LEFT JOIN pg_class c
        ON c.relname = v.expected AND c.relkind IN ('v','m')
      ORDER BY v.expected;
    `,
  },

  // §1.5 / §0.1 posting guard exists but is it called?
  {
    id: '1.5',
    label: 'assert_posting_allowed function exists?',
    sql: `
      SELECT n.nspname, p.proname, pg_get_function_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'assert_posting_allowed';
    `,
  },
  {
    id: '1.5b',
    label: 'Anything actually calls assert_posting_allowed?',
    sql: `
      SELECT n.nspname, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE pg_get_functiondef(p.oid) ILIKE '%assert_posting_allowed%'
        AND p.proname <> 'assert_posting_allowed';
    `,
  },

  // §0.1 orphan src/ migrations — did either of these RPCs make it into the DB?
  {
    id: '0.1a',
    label: 'add_manual_journal_recompute functions present?',
    sql: `
      SELECT p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname ILIKE '%recompute%journal%';
    `,
  },
  {
    id: '0.1b',
    label: 'centralize_approved_journal_posting function present?',
    sql: `
      SELECT p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND (p.proname ILIKE '%approved_journal%' OR p.proname ILIKE '%centralize%journal%');
    `,
  },

  // §1.2 unbalanced posted journals
  {
    id: '1.2',
    label: 'Unbalanced posted journals (|Σdr - Σcr| > 0.01)',
    sql: `
      SELECT je.entry_number, je.entry_date, je.source_module,
             COALESCE(je.total_debit,0)  AS dr,
             COALESCE(je.total_credit,0) AS cr,
             ABS(COALESCE(je.total_debit,0) - COALESCE(je.total_credit,0)) AS delta
      FROM journal_entries je
      WHERE COALESCE(je.is_posted, true)
        AND ABS(COALESCE(je.total_debit,0) - COALESCE(je.total_credit,0)) > 0.01
      ORDER BY delta DESC
      LIMIT 25;
    `,
    summarySql: `
      SELECT COUNT(*) AS unbalanced_count
      FROM journal_entries je
      WHERE COALESCE(je.is_posted, true)
        AND ABS(COALESCE(je.total_debit,0) - COALESCE(je.total_credit,0)) > 0.01;
    `,
  },

  // §1.4 sales-invoice edits that left journal_entry_id = NULL
  {
    id: '1.4',
    label: 'Sales invoices missing a journal_entry_id (non-draft)',
    sql: `
      SELECT id, invoice_number, status, total_amount, created_at
      FROM sales_invoices
      WHERE journal_entry_id IS NULL
        AND COALESCE(is_draft, false) = false
        AND COALESCE(status, '') NOT IN ('draft','cancelled','void')
      ORDER BY created_at DESC
      LIMIT 25;
    `,
    summarySql: `
      SELECT COUNT(*) AS missing_je
      FROM sales_invoices
      WHERE journal_entry_id IS NULL
        AND COALESCE(is_draft, false) = false
        AND COALESCE(status, '') NOT IN ('draft','cancelled','void');
    `,
  },

  // §1.6 duplicate manual journals (reference_id NULL)
  {
    id: '1.6',
    label: 'Duplicate journals per (source_module, reference_id)',
    sql: `
      SELECT source_module, reference_id, COUNT(*) AS n
      FROM journal_entries
      WHERE COALESCE(is_posted, true)
        AND reference_id IS NOT NULL
      GROUP BY 1,2
      HAVING COUNT(*) > 1
      ORDER BY n DESC
      LIMIT 25;
    `,
  },

  // §4.9 + §4.14 negative stock + NOT VALID constraint state
  {
    id: '4.9a',
    label: 'Negative current_stock batches',
    sql: `
      SELECT b.id, p.product_name, b.batch_number, b.current_stock
      FROM batches b JOIN products p ON p.id = b.product_id
      WHERE COALESCE(b.current_stock,0) < 0
      ORDER BY b.current_stock ASC
      LIMIT 25;
    `,
    summarySql: `SELECT COUNT(*) AS negative_stock_count FROM batches WHERE COALESCE(current_stock,0) < 0;`,
  },
  {
    id: '4.9b',
    label: 'NOT VALID constraints on batches / inventory tables',
    sql: `
      SELECT conrelid::regclass AS table_name, conname, contype,
             convalidated, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid::regclass::text IN ('batches','inventory_transactions','stock_reservations')
        AND contype IN ('c','f','u')
      ORDER BY table_name, conname;
    `,
  },

  // §4.5 inventory GL ↔ batch value parity
  {
    id: '4.5',
    label: 'Inventory GL balance vs Σ(current_stock × cost_per_unit)',
    sql: `
      WITH gl AS (
        SELECT COALESCE(SUM(jel.debit) - SUM(jel.credit), 0) AS gl_inventory
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        JOIN chart_of_accounts coa ON coa.id = jel.account_id
        WHERE coa.code = '1130'
          AND COALESCE(je.is_posted, true)
      ),
      bs AS (
        SELECT COALESCE(
                 SUM(b.current_stock * COALESCE(b.landed_cost_per_unit, b.cost_per_unit, b.import_price, 0)),
                 0
               ) AS batch_value
        FROM batches b
      )
      SELECT gl.gl_inventory, bs.batch_value,
             (gl.gl_inventory - bs.batch_value) AS variance
      FROM gl, bs;
    `,
  },

  // §4.11 stock-flow conservation: import_qty = current_stock + delivered + invoiced
  {
    id: '4.11',
    label: 'Stock-flow conservation errors per batch',
    sql: `
      WITH d AS (
        SELECT batch_id, COALESCE(SUM(quantity),0) AS qty
        FROM delivery_challan_items GROUP BY batch_id
      ),
      i AS (
        SELECT batch_id, COALESCE(SUM(quantity),0) AS qty
        FROM sales_invoice_items WHERE batch_id IS NOT NULL GROUP BY batch_id
      )
      SELECT p.product_name, b.batch_number,
             b.import_quantity, b.current_stock,
             COALESCE(d.qty,0) AS delivered,
             COALESCE(i.qty,0) AS invoiced,
             (b.current_stock + COALESCE(d.qty,0) + COALESCE(i.qty,0) - b.import_quantity) AS conservation_error
      FROM batches b
      JOIN products p ON p.id = b.product_id
      LEFT JOIN d ON d.batch_id = b.id
      LEFT JOIN i ON i.batch_id = b.id
      WHERE (b.current_stock + COALESCE(d.qty,0) + COALESCE(i.qty,0)) <> b.import_quantity
      ORDER BY ABS(b.current_stock + COALESCE(d.qty,0) + COALESCE(i.qty,0) - b.import_quantity) DESC
      LIMIT 25;
    `,
    summarySql: `
      WITH d AS (SELECT batch_id, COALESCE(SUM(quantity),0) AS qty FROM delivery_challan_items GROUP BY batch_id),
           i AS (SELECT batch_id, COALESCE(SUM(quantity),0) AS qty FROM sales_invoice_items WHERE batch_id IS NOT NULL GROUP BY batch_id)
      SELECT COUNT(*) AS batches_with_error
      FROM batches b
      LEFT JOIN d ON d.batch_id = b.id
      LEFT JOIN i ON i.batch_id = b.id
      WHERE (b.current_stock + COALESCE(d.qty,0) + COALESCE(i.qty,0)) <> b.import_quantity;
    `,
  },

  // §4.8 orphan inventory_transactions with NULL operation_id
  {
    id: '4.8',
    label: 'Inventory transactions with NULL operation_id',
    sql: `
      SELECT
        (SELECT COUNT(*) FROM inventory_transactions) AS total_rows,
        (SELECT COUNT(*) FROM inventory_transactions WHERE operation_id IS NULL) AS null_operation_id;
    `,
  },

  // §3.3 orphan JEs whose voucher row was deleted
  {
    id: '3.3',
    label: 'Orphan JEs whose voucher row vanished',
    sql: `
      SELECT je.source_module, COUNT(*) AS orphans
      FROM journal_entries je
      WHERE je.reference_id IS NOT NULL
        AND je.source_module IN ('payment_voucher','receipt_voucher','fund_transfer','expense','petty_cash')
        AND NOT EXISTS (
          SELECT 1 FROM payment_vouchers pv  WHERE pv.id  = je.reference_id AND je.source_module = 'payment_voucher'
          UNION ALL
          SELECT 1 FROM receipt_vouchers rv  WHERE rv.id  = je.reference_id AND je.source_module = 'receipt_voucher'
          UNION ALL
          SELECT 1 FROM fund_transfers ft    WHERE ft.id  = je.reference_id AND je.source_module = 'fund_transfer'
          UNION ALL
          SELECT 1 FROM finance_expenses fe  WHERE fe.id  = je.reference_id AND je.source_module = 'expense'
          UNION ALL
          SELECT 1 FROM petty_cash_transactions pc WHERE pc.id = je.reference_id AND je.source_module = 'petty_cash'
        )
      GROUP BY je.source_module
      ORDER BY orphans DESC;
    `,
  },

  // §3.2 over-allocated invoices (paid > total)
  {
    id: '3.2a',
    label: 'Sales invoices with paid_amount > total_amount',
    sql: `
      SELECT id, invoice_number, total_amount, paid_amount, (paid_amount - total_amount) AS over
      FROM sales_invoices
      WHERE COALESCE(paid_amount,0) > COALESCE(total_amount,0) + 0.01
      ORDER BY over DESC
      LIMIT 25;
    `,
    summarySql: `
      SELECT COUNT(*) AS over_paid_count
      FROM sales_invoices
      WHERE COALESCE(paid_amount,0) > COALESCE(total_amount,0) + 0.01;
    `,
  },
  {
    id: '3.2b',
    label: 'Purchase invoices with paid_amount > total_amount',
    sql: `
      SELECT id, invoice_number, total_amount, paid_amount, (paid_amount - total_amount) AS over
      FROM purchase_invoices
      WHERE COALESCE(paid_amount,0) > COALESCE(total_amount,0) + 0.01
      ORDER BY over DESC
      LIMIT 25;
    `,
    summarySql: `
      SELECT COUNT(*) AS over_paid_count
      FROM purchase_invoices
      WHERE COALESCE(paid_amount,0) > COALESCE(total_amount,0) + 0.01;
    `,
  },

  // §3.12 stale "partial" purchase invoices with balance near zero
  {
    id: '3.12',
    label: 'Stale partial purchase invoices (paid ≈ total but status=partial)',
    sql: `
      SELECT id, invoice_number, status, total_amount, paid_amount,
             (total_amount - paid_amount) AS bal
      FROM purchase_invoices
      WHERE status = 'partial'
        AND COALESCE(total_amount,0) - COALESCE(paid_amount,0) BETWEEN -0.01 AND 0.99
      ORDER BY bal ASC
      LIMIT 25;
    `,
    summarySql: `
      SELECT COUNT(*) AS stale_partial_pi
      FROM purchase_invoices
      WHERE status = 'partial'
        AND COALESCE(total_amount,0) - COALESCE(paid_amount,0) BETWEEN -0.01 AND 0.99;
    `,
  },

  // §5.1 Customer ledger ↔ get_invoices_with_balance parity
  {
    id: '5.1',
    label: 'Customers where direct sum ≠ get_invoices_with_balance (top 25 by delta)',
    sql: `
      SELECT
        c.id, c.customer_name,
        (SELECT COALESCE(SUM(si.total_amount - COALESCE(si.paid_amount,0)),0)
           FROM sales_invoices si
          WHERE si.customer_id = c.id
            AND COALESCE(si.is_draft,false) = false) AS direct_balance,
        (SELECT COALESCE(SUM((g.balance)::numeric),0)
           FROM get_invoices_with_balance(c.id, NULL) g) AS rpc_balance
      FROM customers c
      WHERE EXISTS (SELECT 1 FROM sales_invoices si WHERE si.customer_id = c.id)
      ORDER BY ABS(
        (SELECT COALESCE(SUM(si.total_amount - COALESCE(si.paid_amount,0)),0)
           FROM sales_invoices si
          WHERE si.customer_id = c.id
            AND COALESCE(si.is_draft,false) = false)
        - (SELECT COALESCE(SUM((g.balance)::numeric),0)
             FROM get_invoices_with_balance(c.id, NULL) g)
      ) DESC
      LIMIT 25;
    `,
  },

  // §4.6/§4.7 duplicate JE per purchase invoice (GRN + PI double-credit AP)
  {
    id: '4.7',
    label: 'Purchase invoices with >1 posted journal entry',
    sql: `
      SELECT pi.invoice_number, COUNT(je.id) AS je_count
      FROM purchase_invoices pi
      JOIN journal_entries je ON je.reference_id = pi.id AND je.source_module IN ('purchase_invoice','grn')
      WHERE COALESCE(je.is_posted, true)
      GROUP BY pi.invoice_number
      HAVING COUNT(je.id) > 1
      ORDER BY je_count DESC
      LIMIT 25;
    `,
  },

  // §1.11 multi-currency: any non-IDR JE?
  {
    id: '1.11',
    label: 'Does journal_entries have a currency column?',
    sql: `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='journal_entries' AND column_name ILIKE '%currenc%';
    `,
  },

  // §1.10 orphan journal_entry_lines pointing to nonexistent JE
  {
    id: '1.10',
    label: 'Orphan journal_entry_lines (no parent JE)',
    sql: `
      SELECT COUNT(*) AS orphans
      FROM journal_entry_lines jel
      LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.id IS NULL;
    `,
  },

  // §2.1 trial_balance_view date filter
  {
    id: '2.1',
    label: 'Definition of trial_balance_view (period-filtered or life-to-date?)',
    sql: `
      SELECT pg_get_viewdef('trial_balance_view'::regclass, true) AS definition;
    `,
  },

  // §4.8b duplicate operation_id slipped through?
  {
    id: '4.8b',
    label: 'Inventory transactions with duplicate operation_id (should be 0)',
    sql: `
      SELECT operation_id, COUNT(*) AS n
      FROM inventory_transactions
      WHERE operation_id IS NOT NULL
      GROUP BY operation_id
      HAVING COUNT(*) > 1
      LIMIT 25;
    `,
  },
];

async function safeRun(label, sql) {
  try {
    const r = await client.query(sql);
    return { ok: true, rows: r.rows, rowCount: r.rowCount };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function fmt(v) {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

for (const c of checks) {
  console.log(`\n=== §${c.id}  ${c.label} ===`);
  if (c.summarySql) {
    const s = await safeRun('summary', c.summarySql);
    if (!s.ok)        console.log(`  [summary error] ${s.error}`);
    else if (s.rows[0]) {
      const k = Object.keys(s.rows[0])[0];
      console.log(`  summary: ${k} = ${fmt(s.rows[0][k])}`);
    }
  }
  const r = await safeRun(c.label, c.sql);
  if (!r.ok) { console.log(`  [error] ${r.error}`); continue; }
  if (r.rowCount === 0) { console.log('  → 0 rows'); continue; }
  console.log(`  → ${r.rowCount} row(s)${r.rowCount === 25 ? ' (capped)' : ''}`);
  const sample = r.rows.slice(0, 10);
  for (const row of sample) {
    console.log('   ', Object.entries(row).map(([k, v]) => `${k}=${fmt(v)}`).join('  '));
  }
}

await client.end();
console.log('\nDone.');
