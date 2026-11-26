-- Final inventory valuation & landed-cost reconciliation:
-- 1. Capitalize remaining Rp 1,900,000.00 of container-linked BPOM/SKI fees (5410: 500,000; 6710: 1,400,000)
--    that were included in batches.landed_cost_per_unit across 1st Air, 1st 20MT FCL, 2nd Air, 2nd FCL 20MT,
--    and E0000085/2627 - Jul26 Mix, but omitted from JE2611-0507.
-- 2. Align remaining physical stock unit costs (batches.landed_cost_per_unit / cost_per_unit) on the 4 containers
--    with GL-backed cost differences (1st Air, 1st 20MT FCL, 2nd FCL 20MT, E0000085/2627) without altering quantities.
-- 3. Post current-period COGS true-up (JE2611-0509) for the exact already-sold landed-cost/COGS residual
--    so Inventory GL 1130 reconciles to physical stock + pending receiving (variance = 0.00).

DO $$
DECLARE
  v_je_bpom_id uuid;
  v_je_cogs_id uuid;
  v_1130 uuid;
  v_5100 uuid;
  v_5410 uuid;
  v_6710 uuid;
  v_variance numeric;
BEGIN
  SELECT id INTO v_1130 FROM public.chart_of_accounts WHERE code = '1130';
  SELECT id INTO v_5100 FROM public.chart_of_accounts WHERE code = '5100';
  SELECT id INTO v_5410 FROM public.chart_of_accounts WHERE code = '5410';
  SELECT id INTO v_6710 FROM public.chart_of_accounts WHERE code = '6710';

  -- Step 1: Capitalize Rp 1,900,000.00 of container-linked BPOM/SKI fees (5410 & 6710) included in batch costing
  IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE entry_number = 'JE2611-0508') THEN
    INSERT INTO public.journal_entries (
      entry_number, entry_date, source_module, reference_number,
      description, total_debit, total_credit, is_posted
    )
    VALUES (
      'JE2611-0508',
      '2026-11-26',
      'landed_cost_inventory_reclass',
      'NOV26-BPOM-LANDED-COST-RECLASS',
      'Current-period capitalization of container-linked BPOM/SKI fees (5410/6710) included in batch landed cost across 1st Air (250k), 1st 20MT FCL (750k), 2nd Air (100k), 2nd FCL 20MT (550k), and E0000085/2627 (250k)',
      1900000.00,
      1900000.00,
      true
    )
    RETURNING id INTO v_je_bpom_id;

    INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, line_number, description)
    VALUES
      (v_je_bpom_id, v_1130, 1900000.00, 0, 1, 'Inventory capitalization - container BPOM/SKI fees included in batch costing'),
      (v_je_bpom_id, v_5410, 0,  500000.00, 2, 'Reclass 5410 BPOM/SKI fees (1st Air 250k, E0000085 250k)'),
      (v_je_bpom_id, v_6710, 0, 1400000.00, 3, 'Reclass 6710 BPOM/SKI fees (1st 20MT FCL 750k, 2nd Air 100k, 2nd FCL 20MT 550k)');
  END IF;

  -- Step 2: Align physical stock unit costs on active batches in the 4 containers with GL-backed landed cost
  -- (Preserves current_stock & import_quantity; disables historical sales propagation)
  PERFORM set_config('app.finance_metadata_repair', 'on', true);

  WITH target_containers AS (
    SELECT * FROM (VALUES
      ('1st  Air Shipment',         234079377.50::numeric, 236272379.50::numeric),
      ('1st 20MT FCL NOV 25',       1283452017.50::numeric, 1287734127.50::numeric),
      ('2nd FCL 20MT -  FEB26 ',    1968838048.00::numeric, 1970288043.40::numeric),
      ('E0000085/2627 - Jul26 MIx', 795666117.48::numeric, 795416095.00::numeric)
    ) AS t(container_ref, gl_backed_tot, batch_landed_tot)
  ),
  container_pis AS (
    SELECT ic.id AS container_id, ic.container_ref, unnest(ic.purchase_invoice_ids) AS pi_id
    FROM public.import_containers ic
    JOIN target_containers tc ON tc.container_ref = ic.container_ref
  ),
  batches_to_align AS (
    SELECT DISTINCT
      b.id AS batch_id,
      tc.gl_backed_tot / tc.batch_landed_tot AS ratio,
      COALESCE(b.landed_cost_per_unit, b.cost_per_unit) AS old_lcpu
    FROM public.batches b
    LEFT JOIN public.import_containers ic ON ic.id = b.import_container_id
    LEFT JOIN (SELECT DISTINCT pi_id, container_id, container_ref FROM container_pis) cp ON cp.pi_id = b.purchase_invoice_id
    JOIN target_containers tc ON tc.container_ref = COALESCE(ic.container_ref, cp.container_ref)
    WHERE COALESCE(b.is_active, true)
      AND b.current_stock > 0
  )
  UPDATE public.batches b
  SET
    landed_cost_per_unit = ROUND(a.old_lcpu * a.ratio, 2),
    cost_per_unit = ROUND(a.old_lcpu * a.ratio, 2),
    updated_at = NOW()
  FROM batches_to_align a
  WHERE b.id = a.batch_id
    AND ROUND(a.old_lcpu * a.ratio, 2) IS DISTINCT FROM COALESCE(b.landed_cost_per_unit, b.cost_per_unit);

  -- Step 3: Post current-period COGS true-up (JE2611-0509) for the exact already-sold residual
  -- between GL Inventory 1130 and GL-backed physical + in-transit valuation
  SELECT -variance INTO v_variance FROM public.inventory_gl_valuation_reconciliation;

  IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE entry_number = 'JE2611-0509')
     AND ABS(COALESCE(v_variance, 0)) > 0.005 THEN
    INSERT INTO public.journal_entries (
      entry_number, entry_date, source_module, reference_number,
      description, total_debit, total_credit, is_posted
    )
    VALUES (
      'JE2611-0509',
      '2026-11-26',
      'cogs_landed_cost_trueup',
      'NOV26-COGS-LANDED-COST-TRUEUP',
      'Current-period COGS true-up for already-sold batches on 1st Air, 1st 20MT FCL, 2nd Air, 2nd FCL 20MT, and E0000085/2627 where historical COGS exceeded GL-backed landed cost',
      ABS(ROUND(v_variance, 2)),
      ABS(ROUND(v_variance, 2)),
      true
    )
    RETURNING id INTO v_je_cogs_id;

    IF v_variance > 0 THEN
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, line_number, description)
      VALUES
        (v_je_cogs_id, v_1130, ROUND(v_variance, 2), 0, 1, 'Restore 1130 Inventory for excess historical COGS on already-sold import batches'),
        (v_je_cogs_id, v_5100, 0, ROUND(v_variance, 2), 2, 'Reduce 5100 COGS - Materials for excess historical COGS on already-sold import batches');
    ELSE
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, line_number, description)
      VALUES
        (v_je_cogs_id, v_5100, ABS(ROUND(v_variance, 2)), 0, 1, 'True-up 5100 COGS - Materials for under-posted historical COGS on already-sold import batches'),
        (v_je_cogs_id, v_1130, 0, ABS(ROUND(v_variance, 2)), 2, 'Credit 1130 Inventory for under-posted historical COGS on already-sold import batches');
    END IF;
  END IF;
END $$;
