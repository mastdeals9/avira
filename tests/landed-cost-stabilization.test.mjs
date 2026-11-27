import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
const landedCostTs = readFileSync(new URL('../src/utils/landedCost.ts', import.meta.url), 'utf8');

test('1. TypeScript landedCost.ts enforces 2026-11-27 BPOM/SKI cutover and canonical parity', () => {
  assert.match(landedCostTs, /BPOM_LANDED_COST_CUTOVER_DATE = '2026-11-27'/);
  assert.match(landedCostTs, /normalized === 'bpom_ski_fees'/);
  assert.match(landedCostTs, /calculateCanonicalExpenseTotal/);
});

test('2. Live DB (rolled back): all 12 landed-cost stabilization invariants pass on isolated fixtures', () => {
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
      v_c1 uuid;
      v_c2 uuid;
      v_b_unlocked uuid;
      v_b_locked uuid;
      v_so_id uuid;
      v_soi_id uuid;
      v_dc_id uuid;
      v_dci_id uuid;
      v_si_id uuid;
      v_exp_freight uuid;
      v_exp_broker uuid;
      v_exp_bpom_inc uuid;
      v_exp_bpom_exc uuid;
      v_exp_cancelled uuid;
      v_exp_rejected uuid;
      v_pc_id uuid;
      v_pool_1 numeric;
      v_pool_2 numeric;
      v_locked_cpu_before numeric;
      v_locked_cpu_after numeric;
      v_unlocked_cpu_before numeric;
      v_unlocked_cpu_after numeric;
      v_adj_id uuid;
      v_cogs_je_cnt_1 integer;
      v_cogs_je_cnt_2 integer;
      v_sii_cogs numeric;
      v_je_0507_amt numeric;
      v_je_0508_amt numeric;
      v_je_0509_amt numeric;
      v_inv_var numeric;
    BEGIN
      SELECT id INTO v_prod_id FROM public.products LIMIT 1;
      SELECT id INTO v_cust_id FROM public.customers LIMIT 1;
      SELECT id INTO v_supp_id FROM public.suppliers LIMIT 1;
      SELECT id INTO v_admin_id FROM public.user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1;

      -- 12. Snapshot historical baseline (JE2611-0507/0508/0509 & inventory_gl_valuation_reconciliation)
      SELECT total_debit INTO v_je_0507_amt FROM public.journal_entries WHERE entry_number = 'JE2611-0507';
      SELECT total_debit INTO v_je_0508_amt FROM public.journal_entries WHERE entry_number = 'JE2611-0508';
      SELECT total_debit INTO v_je_0509_amt FROM public.journal_entries WHERE entry_number = 'JE2611-0509';
      IF v_je_0507_amt IS NULL OR v_je_0508_amt IS NULL OR v_je_0509_amt IS NULL THEN
        RAISE EXCEPTION 'Missing baseline journals JE2611-0507/0508/0509';
      END IF;

      -- 11. Inventory GL vs supported valuation check
      SELECT variance INTO v_inv_var FROM public.inventory_gl_valuation_reconciliation;
      IF ABS(v_inv_var) > 0.01 THEN
        RAISE EXCEPTION 'Expected live inventory_gl_valuation_reconciliation variance = 0, got %', v_inv_var;
      END IF;

      -- Create 2 isolated post-cutover containers
      INSERT INTO public.import_containers (container_ref, supplier_id, import_date, allocation_method, other_import_costs)
      VALUES ('TEST-STAB-C1', v_supp_id, DATE '2026-11-27', 'invoice_value', 500000)
      RETURNING id INTO v_c1;

      INSERT INTO public.import_containers (container_ref, supplier_id, import_date, allocation_method, other_import_costs)
      VALUES ('TEST-STAB-C2', v_supp_id, DATE '2026-11-27', 'invoice_value', 0)
      RETURNING id INTO v_c2;

      -- Note: post-cutover container must ignore legacy other_import_costs (500000)
      v_pool_1 := public.calculate_container_landed_cost_pool(v_c1);
      IF v_pool_1 <> 0 THEN
        RAISE EXCEPTION 'Post-cutover container should exclude other_import_costs, got %', v_pool_1;
      END IF;

      -- Create unlocked batch (qty 100, import_price 10000) & locked batch (qty 100, import_price 10000)
      PERFORM set_config('app.canonical_stock_engine', 'on', true);
      INSERT INTO public.batches (
        batch_number, product_id, import_date, import_quantity, current_stock,
        import_price, cost_per_unit, landed_cost_per_unit, import_container_id, cost_locked
      ) VALUES (
        'TEST-UNLOCKED-01', v_prod_id, DATE '2026-11-27', 100, 100,
        10000, 10000, 10000, v_c1, false
      ) RETURNING id INTO v_b_unlocked;

      INSERT INTO public.batches (
        batch_number, product_id, import_date, import_quantity, current_stock,
        import_price, cost_per_unit, landed_cost_per_unit, import_container_id, cost_locked
      ) VALUES (
        'TEST-LOCKED-01', v_prod_id, DATE '2026-11-27', 100, 100,
        10000, 10000, 10000, v_c1, true
      ) RETURNING id INTO v_b_locked;
      PERFORM set_config('app.canonical_stock_engine', 'off', true);

      -- Create an approved Sales Order, Delivery Challan & item + posted Sales Invoice consuming 10 units from unlocked batch (case 9)
      INSERT INTO public.sales_orders (
        so_number, customer_id, customer_po_number, customer_po_date, status, created_by
      ) VALUES (
        'TEST-SO-STAB-01', v_cust_id, 'TEST-PO-01', DATE '2026-11-27', 'approved', v_admin_id
      ) RETURNING id INTO v_so_id;

      INSERT INTO public.sales_order_items (
        sales_order_id, product_id, quantity, unit_price
      ) VALUES (
        v_so_id, v_prod_id, 10, 20000
      ) RETURNING id INTO v_soi_id;

      INSERT INTO public.delivery_challans (
        challan_number, customer_id, challan_date, delivery_address, approval_status, sales_order_id, created_by
      ) VALUES (
        'TEST-DC-STAB-01', v_cust_id, DATE '2026-11-27', 'Test Address', 'approved', v_so_id, v_admin_id
      ) RETURNING id INTO v_dc_id;

      INSERT INTO public.delivery_challan_items (
        challan_id, product_id, batch_id, sales_order_item_id, quantity
      ) VALUES (
        v_dc_id, v_prod_id, v_b_unlocked, v_soi_id, 10
      ) RETURNING id INTO v_dci_id;

      INSERT INTO public.sales_invoices (
        invoice_number, customer_id, invoice_date, document_status, is_draft,
        subtotal, tax_amount, discount_amount, stamp_duty_amount, total_amount, created_by
      ) VALUES (
        'TEST-SI-STAB-01', v_cust_id, DATE '2026-11-27', 'posted', false,
        200000, 0, 0, 0, 200000, v_admin_id
      ) RETURNING id INTO v_si_id;

      INSERT INTO public.sales_invoice_items (
        invoice_id, product_id, batch_id, delivery_challan_item_id, quantity, unit_price, cogs_unit_cost, cogs_total_cost
      ) VALUES (
        v_si_id, v_prod_id, v_b_unlocked, v_dci_id, 10, 20000, 10000, 100000
      );

      -- 1. New approved import freight expense (200,000)
      INSERT INTO public.finance_expenses (
        expense_category, amount, expense_date, description, import_container_id,
        include_in_landed_cost, approval_status
      ) VALUES (
        'freight_import', 200000, DATE '2026-11-27', 'Test freight', v_c1, true, 'approved'
      ) RETURNING id INTO v_exp_freight;

      -- 2. New approved petty-cash import expense (100,000)
      INSERT INTO public.petty_cash_transactions (
        transaction_number, transaction_type, expense_category, amount, transaction_date,
        description, import_container_id, include_in_landed_cost, approval_status
      ) VALUES (
        'TEST-PC-01', 'expense', 'loading_import', 100000, DATE '2026-11-27',
        'Test petty cash loading', v_c1, true, 'approved'
      ) RETURNING id INTO v_pc_id;

      -- 3. Broker expense with recoverable PPN and multiple broker items
      -- Header: amount=111000, ppn=11000 -> net 100000; items: (55500-5500=50000) + (30000-0=30000) = 80000; stamp=10000 -> total 190000
      INSERT INTO public.finance_expenses (
        expense_category, amount, ppn_amount, stamp_duty_amount, expense_date,
        description, import_container_id, supplier_id, tax_period_id, include_in_landed_cost, approval_status,
        broker_items
      ) VALUES (
        'import_broker', 111000, 11000, 10000, DATE '2026-11-27',
        'Test broker', v_c1, v_supp_id, (SELECT id FROM public.tax_periods ORDER BY period_start DESC LIMIT 1), true, 'approved',
        '[{"amount":55500,"ppn_amount":5500},{"dpp_amount":30000,"ppn_amount":0}]'::jsonb
      ) RETURNING id INTO v_exp_broker;

      -- 4. BPOM/SKI flagged included (10,000) vs excluded (99,000)
      INSERT INTO public.finance_expenses (
        expense_category, amount, expense_date, description, import_container_id,
        include_in_landed_cost, approval_status
      ) VALUES (
        'bpom_ski_fees', 10000, DATE '2026-11-27', 'Test BPOM included', v_c1, true, 'approved'
      ) RETURNING id INTO v_exp_bpom_inc;

      INSERT INTO public.finance_expenses (
        expense_category, amount, expense_date, description, import_container_id,
        include_in_landed_cost, approval_status
      ) VALUES (
        'bpom_ski_fees', 99000, DATE '2026-11-27', 'Test BPOM excluded', v_c1, false, 'approved'
      ) RETURNING id INTO v_exp_bpom_exc;

      -- 5. Cancelled and rejected expenses (must be excluded)
      INSERT INTO public.finance_expenses (
        expense_category, amount, expense_date, description, import_container_id,
        include_in_landed_cost, approval_status
      ) VALUES (
        'freight_import', 777000, DATE '2026-11-27', 'Test cancelled', v_c1, true, 'cancelled'
      ) RETURNING id INTO v_exp_cancelled;

      INSERT INTO public.finance_expenses (
        expense_category, amount, expense_date, description, import_container_id,
        include_in_landed_cost, approval_status
      ) VALUES (
        'freight_import', 888000, DATE '2026-11-27', 'Test rejected', v_c1, true, 'rejected'
      ) RETURNING id INTO v_exp_rejected;

      -- Verify pool = 200000 + 100000 + 190000 + 10000 = 500000 (split 50/50 -> 250000 per batch -> +2500/unit)
      v_pool_1 := public.calculate_container_landed_cost_pool(v_c1);
      IF v_pool_1 <> 500000 THEN
        RAISE EXCEPTION 'Expected C1 pool = 500000, got %', v_pool_1;
      END IF;

      -- 6. Locked batch protection: cost_per_unit must remain 10000 and pending adjustment recorded
      SELECT landed_cost_per_unit INTO v_locked_cpu_before FROM public.batches WHERE id = v_b_locked;
      IF v_locked_cpu_before <> 10000 THEN
        RAISE EXCEPTION 'Locked batch was overwritten! Expected 10000, got %', v_locked_cpu_before;
      END IF;

      SELECT id INTO v_adj_id FROM public.pending_batch_cost_adjustments
       WHERE batch_id = v_b_locked AND import_container_id = v_c1 AND status = 'pending';
      IF v_adj_id IS NULL THEN
        RAISE EXCEPTION 'Expected pending_batch_cost_adjustments row for locked batch';
      END IF;

      -- 7. Unlocked batch recalculation: cost_per_unit must be 12500 (10000 + 2500)
      SELECT landed_cost_per_unit INTO v_unlocked_cpu_before FROM public.batches WHERE id = v_b_unlocked;
      IF v_unlocked_cpu_before <> 12500 THEN
        RAISE EXCEPTION 'Expected unlocked batch unit cost = 12500, got %', v_unlocked_cpu_before;
      END IF;

      -- 9. Already-sold stock COGS propagation: sales_invoice_items.cogs_total_cost = 125000 (10 * 12500)
      SELECT cogs_total_cost INTO v_sii_cogs FROM public.sales_invoice_items WHERE invoice_id = v_si_id;
      IF v_sii_cogs <> 125000 THEN
        RAISE EXCEPTION 'Expected propagated sales_invoice_items COGS = 125000, got %', v_sii_cogs;
      END IF;

      -- 10. Duplicate trigger prevention: re-running reallocate_container_costs & propagate_batch_cost_change creates no extra JE
      SELECT count(*) INTO v_cogs_je_cnt_1 FROM public.journal_entries WHERE reference_id = v_si_id AND source_module = 'sales_invoice_cogs_adjustment';
      PERFORM public.reallocate_container_costs(v_c1);
      PERFORM public.propagate_batch_cost_change(v_b_unlocked);
      SELECT count(*) INTO v_cogs_je_cnt_2 FROM public.journal_entries WHERE reference_id = v_si_id AND source_module = 'sales_invoice_cogs_adjustment';
      IF v_cogs_je_cnt_1 <> v_cogs_je_cnt_2 THEN
        RAISE EXCEPTION 'Duplicate COGS adjustment journal created (% vs %)', v_cogs_je_cnt_1, v_cogs_je_cnt_2;
      END IF;

      -- Approve locked batch adjustment explicitly -> should update locked batch to 12500 and keep cost_locked = true
      PERFORM public.approve_pending_batch_cost_adjustment(v_adj_id);
      SELECT landed_cost_per_unit INTO v_locked_cpu_after FROM public.batches WHERE id = v_b_locked;
      IF v_locked_cpu_after <> 12500 THEN
        RAISE EXCEPTION 'Expected approved locked batch unit cost = 12500, got %', v_locked_cpu_after;
      END IF;

      -- 8. Expense moved to another container (move v_exp_freight 200000 from C1 to C2)
      UPDATE public.finance_expenses SET import_container_id = v_c2 WHERE id = v_exp_freight;
      v_pool_1 := public.calculate_container_landed_cost_pool(v_c1);
      v_pool_2 := public.calculate_container_landed_cost_pool(v_c2);
      IF v_pool_1 <> 300000 OR v_pool_2 <> 200000 THEN
        RAISE EXCEPTION 'Expected C1=300000 and C2=200000 after move, got C1=%, C2=%', v_pool_1, v_pool_2;
      END IF;
      SELECT landed_cost_per_unit INTO v_unlocked_cpu_after FROM public.batches WHERE id = v_b_unlocked;
      IF v_unlocked_cpu_after <> 11500 THEN
        RAISE EXCEPTION 'Expected unlocked batch unit cost = 11500 after expense move, got %', v_unlocked_cpu_after;
      END IF;

      -- 12. Verify historical baseline journals were untouched
      IF (SELECT total_debit FROM public.journal_entries WHERE entry_number = 'JE2611-0507') <> v_je_0507_amt
         OR (SELECT total_debit FROM public.journal_entries WHERE entry_number = 'JE2611-0508') <> v_je_0508_amt
         OR (SELECT total_debit FROM public.journal_entries WHERE entry_number = 'JE2611-0509') <> v_je_0509_amt THEN
        RAISE EXCEPTION 'Baseline journals JE2611-0507/0508/0509 were unexpectedly modified';
      END IF;
    END;
    $test$;
    ROLLBACK;
  `);
  assert.ok(Array.isArray(rows));
});
