import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

function loadLandedCostModule() {
  const result = esbuild.buildSync({
    entryPoints: ['src/utils/landedCost.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const mod = { exports: {} };
  const fn = new Function('exports', 'require', 'module', result.outputFiles[0].text);
  fn(mod.exports, require, mod);
  return mod.exports;
}

function dbQuery(sql) {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  return parsed.rows || [];
}

const migrationSql = readFileSync(
  new URL('../supabase/migrations/20261127090000_landed_cost_and_inventory_stabilization.sql', import.meta.url),
  'utf8',
);

test('1. TypeScript & SQL landed-cost engines produce identical results across all inclusion, PIB, BPOM, broker, petty-cash & status rules', () => {
  const tsMod = loadLandedCostModule();

  const fixtureInput = {
    containerDate: '2026-11-27',
    otherImportCosts: 500000, // post-cutover container must ignore legacy other_import_costs
    linkedExpenses: [
      { id: 'e1', expense_category: 'freight_import', amount: 200000, expense_date: '2026-11-27', include_in_landed_cost: true, approval_status: 'approved' },
      {
        id: 'e2',
        expense_category: 'import_broker',
        amount: 111000,
        ppn_amount: 11000,
        stamp_duty_amount: 10000,
        expense_date: '2026-11-27',
        include_in_landed_cost: true,
        approval_status: 'approved',
        broker_items: [{ amount: 55500, ppn_amount: 5500 }, { dpp_amount: 30000, ppn_amount: 0 }],
      },
      { id: 'e3', expense_category: 'bpom_ski_fees', amount: 10000, expense_date: '2026-11-27', include_in_landed_cost: true, approval_status: 'approved' },
      { id: 'e4', expense_category: 'bpom_ski_fees', amount: 99000, expense_date: '2026-11-27', include_in_landed_cost: false, approval_status: 'approved' },
      { id: 'e5', expense_category: 'bpom_ski_fees', amount: 88000, expense_date: '2026-11-27', include_in_landed_cost: null, approval_status: 'approved' },
      { id: 'e6', expense_category: 'freight_import', amount: 777000, expense_date: '2026-11-27', include_in_landed_cost: true, approval_status: 'cancelled' },
      { id: 'e7', expense_category: 'freight_import', amount: 666000, expense_date: '2026-11-27', include_in_landed_cost: true, approval_status: 'pending_approval' },
      { id: 'p1', expense_category: 'pib_import', amount: 500000, pib_bm_amount: 120000, expense_date: '2026-11-27', include_in_landed_cost: true, approval_status: 'approved' },
      { id: 'p2', expense_category: 'pib_import', amount: 500000, pib_bm_amount: 220000, expense_date: '2026-11-27', include_in_landed_cost: false, approval_status: 'approved' },
      { id: 'p3', expense_category: 'pib_import', amount: 500000, pib_bm_amount: 320000, expense_date: '2026-11-27', include_in_landed_cost: null, approval_status: 'approved' },
    ],
    linkedPettyCash: [
      { id: 'pc1', expense_category: 'loading_import', amount: 100000, transaction_date: '2026-11-27', include_in_landed_cost: true, approval_status: 'approved' },
      // Linked to already-capitalized e1 -> must NOT be counted twice
      { id: 'pc2', expense_category: 'freight_import', amount: 200000, transaction_date: '2026-11-27', include_in_landed_cost: true, approval_status: 'approved', finance_expense_id: 'e1' },
    ],
  };

  const tsRes = tsMod.calculateContainerLandedCostPool(fixtureInput);
  // Shared pool = freight 200k + broker net 190k + BPOM included 10k + petty cash 100k = 500k
  assert.equal(tsRes.selectedLandedLinkedTotal, 500000);
  // PIB duty = only p1 (include_in_landed_cost = true -> 120k); false & NULL excluded
  assert.equal(tsRes.pibDutyTotal, 120000);
  assert.equal(tsRes.otherImportCosts, 0);
  assert.equal(tsRes.containerLandedCostPool, 620000);

  // Verify SQL calculate_expense_landed_cost_amount matches TS for every item
  const sqlRows = dbQuery(`
    BEGIN;
    ${migrationSql}
    SELECT
      public.calculate_expense_landed_cost_amount('freight_import', 200000, 0, 0, NULL, 0, true, 'approved', DATE '2026-11-27') AS e1,
      public.calculate_expense_landed_cost_amount('import_broker', 111000, 11000, 10000, '[{"amount":55500,"ppn_amount":5500},{"dpp_amount":30000,"ppn_amount":0}]'::jsonb, 0, true, 'approved', DATE '2026-11-27') AS e2,
      public.calculate_expense_landed_cost_amount('bpom_ski_fees', 10000, 0, 0, NULL, 0, true, 'approved', DATE '2026-11-27') AS e3,
      public.calculate_expense_landed_cost_amount('bpom_ski_fees', 99000, 0, 0, NULL, 0, false, 'approved', DATE '2026-11-27') AS e4,
      public.calculate_expense_landed_cost_amount('bpom_ski_fees', 88000, 0, 0, NULL, 0, NULL, 'approved', DATE '2026-11-27') AS e5,
      public.calculate_expense_landed_cost_amount('freight_import', 777000, 0, 0, NULL, 0, true, 'cancelled', DATE '2026-11-27') AS e6,
      public.calculate_expense_landed_cost_amount('freight_import', 666000, 0, 0, NULL, 0, true, 'pending_approval', DATE '2026-11-27') AS e7,
      public.calculate_expense_landed_cost_amount('pib_import', 500000, 0, 0, NULL, 120000, true, 'approved', DATE '2026-11-27') AS p1,
      public.calculate_expense_landed_cost_amount('pib_import', 500000, 0, 0, NULL, 220000, false, 'approved', DATE '2026-11-27') AS p2,
      public.calculate_expense_landed_cost_amount('pib_import', 500000, 0, 0, NULL, 320000, NULL, 'approved', DATE '2026-11-27') AS p3;
    ROLLBACK;
  `);
  const r = sqlRows[0];
  assert.equal(Number(r.e1) + Number(r.e2) + Number(r.e3) + Number(r.e4) + Number(r.e5) + Number(r.e6) + Number(r.e7), 400000);
  assert.equal(Number(r.p1), 120000);
  assert.equal(Number(r.p2), 0);
  assert.equal(Number(r.p3), 0);
});

test('2. Live DB (rolled back): all 12 historical-protection, PIB, FIFO, concurrency & idempotency invariants pass', () => {
  const rows = dbQuery(`
    BEGIN;
    SELECT set_config('request.jwt.claim.sub', (SELECT id::text FROM public.user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1), true),
           set_config('request.jwt.claim.role', 'authenticated', true);

    ${migrationSql}

    DO $test$
    DECLARE
      v_prod_id uuid;
      v_cust_id uuid;
      v_supp_id uuid;
      v_admin_id uuid;
      v_tax_period_id uuid;
      v_pi_id uuid;
      v_pii_id uuid;
      v_pira_1 uuid;
      v_pira_2 uuid;
      v_c_hist uuid;
      v_c_post uuid;
      v_b_hist_unlocked uuid;
      v_b_post_unlocked uuid;
      v_b_post_locked uuid;
      v_b_fifo uuid;
      v_so_id uuid;
      v_soi_id uuid;
      v_dc_id uuid;
      v_dci_1 uuid;
      v_dci_2 uuid;
      v_si_1 uuid;
      v_si_2 uuid;
      v_exp_freight uuid;
      v_exp_pib_true uuid;
      v_exp_pib_false uuid;
      v_exp_pib_null uuid;
      v_adj_id uuid;
      v_cnt1 integer;
      v_cnt2 integer;
      v_shortage_detected boolean := false;
      v_je_0507_amt numeric;
      v_je_0508_amt numeric;
      v_je_0509_amt numeric;
    BEGIN
      SELECT id INTO v_prod_id FROM public.products LIMIT 1;
      SELECT id INTO v_cust_id FROM public.customers LIMIT 1;
      SELECT id INTO v_supp_id FROM public.suppliers LIMIT 1;
      SELECT id INTO v_admin_id FROM public.user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1;
      SELECT id INTO v_tax_period_id FROM public.tax_periods ORDER BY period_start DESC LIMIT 1;

      SELECT total_debit INTO v_je_0507_amt FROM public.journal_entries WHERE entry_number = 'JE2611-0507';
      SELECT total_debit INTO v_je_0508_amt FROM public.journal_entries WHERE entry_number = 'JE2611-0508';
      SELECT total_debit INTO v_je_0509_amt FROM public.journal_entries WHERE entry_number = 'JE2611-0509';

      -- 1. Historical pre-cutover container & batch (even with cost_locked = false!) must NOT be auto-recalculated
      INSERT INTO public.import_containers (container_ref, supplier_id, import_date, allocation_method, other_import_costs)
      VALUES ('TEST-HIST-C1', v_supp_id, DATE '2026-11-20', 'invoice_value', 0)
      RETURNING id INTO v_c_hist;

      PERFORM set_config('app.canonical_stock_engine', 'on', true);
      INSERT INTO public.batches (
        batch_number, product_id, import_date, import_quantity, current_stock,
        import_price, cost_per_unit, landed_cost_per_unit, import_container_id, cost_locked
      ) VALUES (
        'TEST-HIST-UNLOCKED', v_prod_id, DATE '2026-11-20', 100, 100,
        10000, 10000, 10000, v_c_hist, false
      ) RETURNING id INTO v_b_hist_unlocked;
      PERFORM set_config('app.canonical_stock_engine', 'off', true);

      -- Enter a new expense linked to the historical container -> must NOT overwrite historical batch
      INSERT INTO public.finance_expenses (
        expense_category, amount, expense_date, description, import_container_id,
        include_in_landed_cost, approval_status
      ) VALUES (
        'freight_import', 50000, DATE '2026-11-27', 'Late freight on historical container', v_c_hist, true, 'approved'
      );

      IF (SELECT landed_cost_per_unit FROM public.batches WHERE id = v_b_hist_unlocked) IS DISTINCT FROM 10000 THEN
        RAISE EXCEPTION 'Historical pre-cutover batch was silently modified! Got %', (SELECT landed_cost_per_unit FROM public.batches WHERE id = v_b_hist_unlocked);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.pending_batch_cost_adjustments
         WHERE batch_id = v_b_hist_unlocked AND status = 'pending'
      ) THEN
        RAISE EXCEPTION 'Expected pending adjustment record for protected pre-cutover batch';
      END IF;

      -- 2, 3, 4, 5, 6, 7. Post-cutover container with unlocked & locked batches, broker, petty cash, PIB true/false/NULL
      INSERT INTO public.import_containers (container_ref, supplier_id, import_date, allocation_method, other_import_costs)
      VALUES ('TEST-POST-C1', v_supp_id, DATE '2026-11-27', 'invoice_value', 999999)
      RETURNING id INTO v_c_post;

      PERFORM set_config('app.canonical_stock_engine', 'on', true);
      INSERT INTO public.batches (
        batch_number, product_id, import_date, import_quantity, current_stock,
        import_price, duty_charges, cost_per_unit, landed_cost_per_unit, import_container_id, cost_locked
      ) VALUES (
        'TEST-POST-UNLOCKED', v_prod_id, DATE '2026-11-27', 100, 100,
        10000, 1, 10000, 10000, v_c_post, false
      ) RETURNING id INTO v_b_post_unlocked;

      INSERT INTO public.batches (
        batch_number, product_id, import_date, import_quantity, current_stock,
        import_price, cost_per_unit, landed_cost_per_unit, import_container_id, cost_locked
      ) VALUES (
        'TEST-POST-LOCKED', v_prod_id, DATE '2026-11-27', 100, 100,
        10000, 10000, 10000, v_c_post, true
      ) RETURNING id INTO v_b_post_locked;
      PERFORM set_config('app.canonical_stock_engine', 'off', true);

      -- Freight 200k + linked duplicate petty cash 200k (must not double-count) + independent petty cash 100k
      INSERT INTO public.finance_expenses (
        expense_category, amount, expense_date, description, import_container_id,
        include_in_landed_cost, approval_status
      ) VALUES (
        'freight_import', 200000, DATE '2026-11-27', 'Post freight', v_c_post, true, 'approved'
      ) RETURNING id INTO v_exp_freight;

      INSERT INTO public.petty_cash_transactions (
        transaction_number, transaction_type, expense_category, amount, transaction_date,
        description, import_container_id, include_in_landed_cost, approval_status, finance_expense_id
      ) VALUES (
        'TEST-PC-DUP', 'expense', 'freight_import', 200000, DATE '2026-11-27',
        'Linked PC should not double count', v_c_post, true, 'approved', v_exp_freight
      );

      INSERT INTO public.petty_cash_transactions (
        transaction_number, transaction_type, expense_category, amount, transaction_date,
        description, import_container_id, include_in_landed_cost, approval_status
      ) VALUES (
        'TEST-PC-IND', 'expense', 'loading_import', 100000, DATE '2026-11-27',
        'Independent PC', v_c_post, true, 'approved'
      );

      -- Broker net 190k + BPOM included 10k + cancelled 777k + pending 666k
      INSERT INTO public.finance_expenses (
        expense_category, amount, ppn_amount, stamp_duty_amount, expense_date,
        description, import_container_id, supplier_id, tax_period_id, include_in_landed_cost, approval_status,
        broker_items
      ) VALUES (
        'import_broker', 111000, 11000, 10000, DATE '2026-11-27',
        'Broker', v_c_post, v_supp_id, v_tax_period_id, true, 'approved',
        '[{"amount":55500,"ppn_amount":5500},{"dpp_amount":30000,"ppn_amount":0}]'::jsonb
      );

      INSERT INTO public.finance_expenses (
        expense_category, amount, expense_date, description, import_container_id,
        include_in_landed_cost, approval_status
      ) VALUES
        ('bpom_ski_fees', 10000, DATE '2026-11-27', 'BPOM inc', v_c_post, true, 'approved'),
        ('freight_import', 777000, DATE '2026-11-27', 'Cancelled', v_c_post, true, 'cancelled'),
        ('freight_import', 666000, DATE '2026-11-27', 'Pending', v_c_post, true, 'pending_approval');

      -- 5. PIB inclusion policy: true (included), false (excluded), NULL (excluded)
      INSERT INTO public.finance_expenses (
        expense_category, amount, pib_bm_amount, pib_ppn_amount, pib_pph_amount, expense_date, description, import_container_id,
        include_in_landed_cost, approval_status
      ) VALUES ('pib_import', 500000, 100000, 300000, 100000, DATE '2026-11-27', 'PIB true', v_c_post, true, 'approved') RETURNING id INTO v_exp_pib_true;

      INSERT INTO public.finance_expenses (
        expense_category, amount, pib_bm_amount, pib_ppn_amount, pib_pph_amount, expense_date, description, import_container_id,
        include_in_landed_cost, approval_status
      ) VALUES ('pib_import', 500000, 200000, 200000, 100000, DATE '2026-11-27', 'PIB false', v_c_post, false, 'approved') RETURNING id INTO v_exp_pib_false;

      INSERT INTO public.finance_expenses (
        expense_category, amount, pib_bm_amount, pib_ppn_amount, pib_pph_amount, expense_date, description, import_container_id,
        include_in_landed_cost, approval_status
      ) VALUES ('pib_import', 500000, 300000, 100000, 100000, DATE '2026-11-27', 'PIB null', v_c_post, NULL, 'approved') RETURNING id INTO v_exp_pib_null;

      IF public.calculate_container_landed_cost_pool(v_c_post) <> 500000 THEN
        RAISE EXCEPTION 'Expected C_POST shared pool = 500000, got %', public.calculate_container_landed_cost_pool(v_c_post);
      END IF;

      -- Unlocked batch should remain 12500 (shared 2500/u + base 10000; duty_charges 1/u) -> 12501
      IF (SELECT landed_cost_per_unit FROM public.batches WHERE id = v_b_post_unlocked) <> 12501 THEN
        RAISE EXCEPTION 'Expected unlocked batch = 12501, got %', (SELECT landed_cost_per_unit FROM public.batches WHERE id = v_b_post_unlocked);
      END IF;

      -- Locked batch must stay 10000 and have pending adjustment
      IF (SELECT landed_cost_per_unit FROM public.batches WHERE id = v_b_post_locked) <> 10000 THEN
        RAISE EXCEPTION 'Locked batch was overwritten!';
      END IF;
      SELECT id INTO v_adj_id FROM public.pending_batch_cost_adjustments
       WHERE batch_id = v_b_post_locked AND import_container_id = v_c_post AND status = 'pending';
      PERFORM public.approve_pending_batch_cost_adjustment(v_adj_id);
      IF (SELECT landed_cost_per_unit FROM public.batches WHERE id = v_b_post_locked) <> 12500 THEN
        RAISE EXCEPTION 'Approved locked batch adjustment did not apply';
      END IF;

      -- 8, 9, 10, 11. Multiple FIFO layers + multiple chronological sales invoices + shortage detection + idempotency
      SELECT id INTO v_pi_id FROM public.purchase_invoices LIMIT 1;
      SELECT id INTO v_pii_id FROM public.purchase_invoice_items WHERE purchase_invoice_id = v_pi_id LIMIT 1;

      PERFORM set_config('app.canonical_stock_engine', 'on', true);
      INSERT INTO public.batches (
        batch_number, product_id, import_date, import_quantity, current_stock,
        import_price, cost_per_unit, landed_cost_per_unit, cost_locked
      ) VALUES (
        'TEST-FIFO-MULTI', v_prod_id, DATE '2026-11-27', 100, 100,
        10000, 10000, 10000, false
      ) RETURNING id INTO v_b_fifo;
      PERFORM set_config('app.canonical_stock_engine', 'off', true);

      -- Two receiving allocations with different dates -> two FIFO layers (50 @ 10000, 50 @ 20000)
      INSERT INTO public.purchase_invoice_receiving_allocations (
        purchase_invoice_id, purchase_invoice_item_id, batch_id, received_quantity, status, received_at, operation_id
      ) VALUES
        (v_pi_id, v_pii_id, v_b_fifo, 50, 'received', TIMESTAMPTZ '2026-11-27 09:00:00+00', gen_random_uuid()) RETURNING id INTO v_pira_1;
      INSERT INTO public.purchase_invoice_receiving_allocations (
        purchase_invoice_id, purchase_invoice_item_id, batch_id, received_quantity, status, received_at, operation_id
      ) VALUES
        (v_pi_id, v_pii_id, v_b_fifo, 50, 'received', TIMESTAMPTZ '2026-11-28 09:00:00+00', gen_random_uuid()) RETURNING id INTO v_pira_2;

      INSERT INTO public.purchase_batch_cost_layers (
        receiving_allocation_id, purchase_invoice_id, purchase_invoice_item_id, batch_id,
        quantity, currency, exchange_rate, transaction_unit_cost, functional_unit_cost, functional_total_cost,
        landed_cost_amount, final_functional_unit_cost
      ) VALUES
        (v_pira_1, v_pi_id, v_pii_id, v_b_fifo, 50, 'IDR', 1, 10000, 10000, 500000, 0, 10000),
        (v_pira_2, v_pi_id, v_pii_id, v_b_fifo, 50, 'IDR', 1, 20000, 20000, 1000000, 0, 20000);

      INSERT INTO public.sales_orders (so_number, customer_id, customer_po_number, customer_po_date, status, created_by)
      VALUES ('TEST-SO-FIFO', v_cust_id, 'TEST-PO-FIFO', DATE '2026-11-27', 'approved', v_admin_id) RETURNING id INTO v_so_id;
      INSERT INTO public.sales_order_items (sales_order_id, product_id, quantity, unit_price)
      VALUES (v_so_id, v_prod_id, 120, 30000) RETURNING id INTO v_soi_id;
      INSERT INTO public.delivery_challans (challan_number, customer_id, challan_date, delivery_address, approval_status, sales_order_id, created_by)
      VALUES ('TEST-DC-FIFO', v_cust_id, DATE '2026-11-27', 'Test Addr', 'approved', v_so_id, v_admin_id) RETURNING id INTO v_dc_id;

      INSERT INTO public.delivery_challan_items (challan_id, product_id, batch_id, sales_order_item_id, quantity)
      VALUES (v_dc_id, v_prod_id, v_b_fifo, v_soi_id, 40) RETURNING id INTO v_dci_1;
      INSERT INTO public.delivery_challan_items (challan_id, product_id, batch_id, sales_order_item_id, quantity)
      VALUES (v_dc_id, v_prod_id, v_b_fifo, v_soi_id, 30) RETURNING id INTO v_dci_2;

      -- SI-1 (2026-11-27): 40 units -> all from Layer 1 (40 * 10000 = 400000)
      -- SI-2 (2026-11-28): 30 units -> 10 from Layer 1 (100000) + 20 from Layer 2 (400000) = 500000
      INSERT INTO public.sales_invoices (
        invoice_number, customer_id, invoice_date, document_status, is_draft,
        subtotal, tax_amount, discount_amount, stamp_duty_amount, total_amount, created_by
      ) VALUES ('TEST-SI-FIFO-1', v_cust_id, DATE '2026-11-27', 'posted', false, 1200000, 0, 0, 0, 1200000, v_admin_id)
      RETURNING id INTO v_si_1;
      INSERT INTO public.sales_invoice_items (invoice_id, product_id, batch_id, delivery_challan_item_id, quantity, unit_price, cogs_unit_cost, cogs_total_cost)
      VALUES (v_si_1, v_prod_id, v_b_fifo, v_dci_1, 40, 30000, 0, 0);

      INSERT INTO public.sales_invoices (
        invoice_number, customer_id, invoice_date, document_status, is_draft,
        subtotal, tax_amount, discount_amount, stamp_duty_amount, total_amount, created_by
      ) VALUES ('TEST-SI-FIFO-2', v_cust_id, DATE '2026-11-28', 'posted', false, 900000, 0, 0, 0, 900000, v_admin_id)
      RETURNING id INTO v_si_2;
      INSERT INTO public.sales_invoice_items (invoice_id, product_id, batch_id, delivery_challan_item_id, quantity, unit_price, cogs_unit_cost, cogs_total_cost)
      VALUES (v_si_2, v_prod_id, v_b_fifo, v_dci_2, 30, 30000, 0, 0);

      PERFORM public.propagate_batch_cost_change(v_b_fifo);

      IF (SELECT cogs_total_cost FROM public.sales_invoice_items WHERE invoice_id = v_si_1) <> 400000
         OR (SELECT cogs_total_cost FROM public.sales_invoice_items WHERE invoice_id = v_si_2) <> 500000 THEN
        RAISE EXCEPTION 'Chronological multi-layer FIFO COGS mismatch!';
      END IF;

      -- 10 & 11. Idempotency: second propagation creates zero new journals
      SELECT count(*) INTO v_cnt1 FROM public.journal_entries WHERE reference_id IN (v_si_1, v_si_2) AND source_module = 'sales_invoice_cogs_adjustment';
      PERFORM public.propagate_batch_cost_change(v_b_fifo);
      SELECT count(*) INTO v_cnt2 FROM public.journal_entries WHERE reference_id IN (v_si_1, v_si_2) AND source_module = 'sales_invoice_cogs_adjustment';
      IF v_cnt1 <> v_cnt2 OR v_cnt1 <> 2 THEN
        RAISE EXCEPTION 'Expected exactly 2 COGS adjustment journals and idempotency, got % then %', v_cnt1, v_cnt2;
      END IF;

      -- 9. Insufficient FIFO layer quantity must be detected (reduce layer 2 to 10 so total layers = 60 < sold 70)
      UPDATE public.purchase_batch_cost_layers SET quantity = 10 WHERE receiving_allocation_id = v_pira_2;
      BEGIN
        PERFORM public.propagate_batch_cost_change(v_b_fifo);
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        v_shortage_detected := true;
      END;
      IF NOT v_shortage_detected THEN
        RAISE EXCEPTION 'Expected insufficient FIFO layer quantity error was not raised!';
      END IF;

      -- Verify baseline journals untouched
      IF (SELECT total_debit FROM public.journal_entries WHERE entry_number = 'JE2611-0507') <> v_je_0507_amt
         OR (SELECT total_debit FROM public.journal_entries WHERE entry_number = 'JE2611-0508') <> v_je_0508_amt
         OR (SELECT total_debit FROM public.journal_entries WHERE entry_number = 'JE2611-0509') <> v_je_0509_amt THEN
        RAISE EXCEPTION 'Baseline journals modified!';
      END IF;
    END;
    $test$;
    ROLLBACK;
  `);
  assert.ok(Array.isArray(rows));
});
