-- ============================================================================
-- PROMPT 7C — HARDENED DOMPERIDONE BATCH DATA CORRECTION & ROLLBACK SCRIPT
-- Database: dkrtsqienlhpouohmfki (Production Supabase)
-- Batch Number: BDM/2609056
-- Batch ID: 34d352ef-26a9-482f-81a4-b83f11ad6a7d
-- Purchase Invoice: E0000244/2627 (88af074d-4ec2-44f0-b938-0c7c8b4dd8ca)
-- Author: Antigravity AI — SAPJ ERP
-- Date: 16 November 2026
--
-- STATUS: EXECUTED AND VERIFIED ON PRODUCTION (2026-11-16T13:16:31.936Z)
-- HISTORICAL RECORD OF EXECUTION — DO NOT EXECUTE AGAIN
-- ============================================================================

-- ============================================================================
-- 1. READ-ONLY AUDIT & VERIFICATION QUERIES
-- ============================================================================
-- Verify batch master starting state:
SELECT 
  id,
  batch_number,
  product_id,
  import_quantity,
  current_stock,
  import_price,
  import_price_usd,
  exchange_rate_usd_to_idr,
  cost_per_unit,
  landed_cost_per_unit,
  final_landed_cost,
  expiry_date,
  purchase_invoice_id
FROM public.batches
WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';

-- Verify cross-invoice references across the ENTIRE database:
SELECT 
  pi.invoice_number,
  pi.invoice_date,
  pii.id as item_id,
  pii.quantity,
  pii.unit_price,
  pii.line_total,
  pii.receiving_batch_number
FROM public.purchase_invoice_items pii
JOIN public.purchase_invoices pi ON pi.id = pii.purchase_invoice_id
WHERE pii.batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d'
   OR pii.receiving_batch_number = 'BDM/2609056';

-- Verify GL 1130 debits in JE-2610-0005 (lines 6 & 13):
SELECT 
  je.entry_number,
  je.entry_date,
  coa.code,
  coa.name,
  jel.debit,
  jel.credit,
  jel.description
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
WHERE je.reference_id = '88af074d-4ec2-44f0-b938-0c7c8b4dd8ca'
  AND coa.code = '1130'
  AND jel.description ILIKE '%domperidone%';


-- ============================================================================
-- 2. HARDENED TRANSACTION-SAFE CORRECTION (REQUIRING APPROVAL)
-- ============================================================================
BEGIN;

DO $$
DECLARE
  v_batch RECORD;
  v_distinct_pi_count INT;
  v_item_count INT;
  v_item_total_qty NUMERIC;
  v_item_total_idr NUMERIC;
  v_je_domperidone_debit NUMERIC;
  v_alloc_count INT;
  v_tx_count INT;
  v_layer_count INT;
  v_dc_count INT;
  v_si_count INT;
  v_rows_updated INT;
BEGIN
  -- ── 1. CONCURRENT LOCKING (ROW-LEVEL EXCLUSIVE LOCK) ──────────────────────
  -- Lock purchase invoice items first to prevent incoming receiving allocations
  PERFORM 1 FROM public.purchase_invoice_items 
   WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d' 
     FOR UPDATE;

  -- Then acquire exclusive row lock on the batch record
  SELECT id, batch_number, import_quantity, current_stock, cost_per_unit, 
         landed_cost_per_unit, import_price_per_unit, final_landed_cost, expiry_date
    INTO v_batch
    FROM public.batches
   WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d'
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Batch 34d352ef does not exist';
  END IF;

  -- ── 2. PRECONDITION ASSERTIONS (FAIL FAST) ────────────────────────────────
  -- Assertion A: Batch identity and unreceived starting state
  IF v_batch.batch_number <> 'BDM/2609056' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Expected batch_number BDM/2609056, found %', v_batch.batch_number;
  END IF;

  IF v_batch.import_quantity <> 225.000 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Expected import_quantity 225.000, found %', v_batch.import_quantity;
  END IF;

  IF v_batch.current_stock <> 0.000 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Expected current_stock 0.000 (unreceived in-transit), found %', v_batch.current_stock;
  END IF;

  IF v_batch.cost_per_unit <> 760953.1500 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Expected cost_per_unit 760953.1500, found %', v_batch.cost_per_unit;
  END IF;

  -- Assertion B: Cross-invoice verification (batch belongs exclusively to E0000244/2627)
  SELECT COUNT(DISTINCT purchase_invoice_id), COUNT(*), SUM(quantity), SUM(line_total * 18105)
    INTO v_distinct_pi_count, v_item_count, v_item_total_qty, v_item_total_idr
    FROM public.purchase_invoice_items
   WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d'
      OR receiving_batch_number = 'BDM/2609056';

  IF v_distinct_pi_count <> 1 THEN
    RAISE EXCEPTION 'CROSS-INVOICE SAFETY FAILED: Batch referenced by % purchase invoices, expected 1', v_distinct_pi_count;
  END IF;

  IF v_item_count <> 2 OR v_item_total_qty <> 249.890 THEN
    RAISE EXCEPTION 'CROSS-INVOICE SAFETY FAILED: Expected 2 items totaling 249.890 kg across all invoices, found % items and % kg', v_item_count, v_item_total_qty;
  END IF;

  -- Assertion C: Zero physical warehouse receiving, movements, or downstream dispatch
  SELECT COUNT(*) INTO v_alloc_count FROM public.purchase_invoice_receiving_allocations WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  SELECT COUNT(*) INTO v_tx_count FROM public.inventory_transactions WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  SELECT COUNT(*) INTO v_layer_count FROM public.purchase_batch_cost_layers WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  SELECT COUNT(*) INTO v_dc_count FROM public.delivery_challan_items WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  SELECT COUNT(*) INTO v_si_count FROM public.sales_invoice_items WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';

  IF v_alloc_count > 0 OR v_tx_count > 0 OR v_layer_count > 0 OR v_dc_count > 0 OR v_si_count > 0 THEN
    RAISE EXCEPTION 'CONCURRENCY/USAGE CONFLICT: Batch has active receiving allocations (%), tx (%), layers (%), DC (%), or SI (%)',
      v_alloc_count, v_tx_count, v_layer_count, v_dc_count, v_si_count;
  END IF;

  -- Assertion D: GL 1130 debits verify to exactly Rp 190,154,642.40
  SELECT SUM(jel.debit)
    INTO v_je_domperidone_debit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE je.reference_id = '88af074d-4ec2-44f0-b938-0c7c8b4dd8ca'
     AND coa.code = '1130'
     AND jel.description ILIKE '%domperidone%';

  IF v_je_domperidone_debit IS DISTINCT FROM 190154642.40 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: GL 1130 debits do not match Rp 190,154,642.40 (found %)', v_je_domperidone_debit;
  END IF;

  -- ── 3. EXECUTE DATA CORRECTION ────────────────────────────────────────────
  PERFORM set_config('app.finance_metadata_repair', 'on', true);

  UPDATE public.batches
     SET import_quantity   = 249.890,
         final_landed_cost = 190154642.40,
         updated_at        = NOW()
   WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d'
     AND import_quantity   = 225.000
     AND current_stock     = 0.000;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  IF v_rows_updated <> 1 THEN
    RAISE EXCEPTION 'EXECUTION FAILED: Expected exactly 1 row updated, got %', v_rows_updated;
  END IF;

  -- ── 4. POST-EXECUTION VERIFICATION ASSERTIONS ─────────────────────────────
  SELECT import_quantity, final_landed_cost, cost_per_unit
    INTO v_batch
    FROM public.batches
   WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';

  IF v_batch.import_quantity <> 249.890 OR v_batch.final_landed_cost <> 190154642.40 OR v_batch.cost_per_unit <> 760953.1500 THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: Unexpected post-update values in batches table';
  END IF;

  RAISE NOTICE 'SUCCESS: Batch 34d352ef successfully corrected to 249.890 kg / Rp 190,154,642.40';
END $$;

-- Verify operational physical ledger view automatically reflects 249.890 kg
SELECT batch_id, quantity, source_type, reference_number
FROM public.inventory_operational_physical_ledger
WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';

COMMIT;


-- ============================================================================
-- 3. HARDENED ROLLBACK SCRIPT (STRICT GUARD AGAINST SUBSEQUENT USAGE)
-- ============================================================================
/*
BEGIN;

DO $$
DECLARE
  v_batch RECORD;
  v_alloc_count INT;
  v_tx_count INT;
  v_layer_count INT;
  v_dc_count INT;
  v_si_count INT;
  v_rows_updated INT;
BEGIN
  -- 1. Acquire exclusive lock on batch record
  SELECT id, batch_number, import_quantity, current_stock, cost_per_unit, final_landed_cost
    INTO v_batch
    FROM public.batches
   WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d'
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROLLBACK PRECONDITION FAILED: Batch 34d352ef does not exist';
  END IF;

  IF v_batch.import_quantity <> 249.890 THEN
    RAISE EXCEPTION 'ROLLBACK PRECONDITION FAILED: Expected import_quantity 249.890, found %', v_batch.import_quantity;
  END IF;

  IF v_batch.current_stock <> 0.000 THEN
    RAISE EXCEPTION 'ROLLBACK PRECONDITION FAILED: Expected current_stock 0.000, found %', v_batch.current_stock;
  END IF;

  -- 2. Strict Rollback Safety: Reject rollback if physical receiving or downstream usage occurred
  SELECT COUNT(*) INTO v_alloc_count FROM public.purchase_invoice_receiving_allocations WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  SELECT COUNT(*) INTO v_tx_count FROM public.inventory_transactions WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  SELECT COUNT(*) INTO v_layer_count FROM public.purchase_batch_cost_layers WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  SELECT COUNT(*) INTO v_dc_count FROM public.delivery_challan_items WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  SELECT COUNT(*) INTO v_si_count FROM public.sales_invoice_items WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';

  IF v_alloc_count > 0 OR v_tx_count > 0 OR v_layer_count > 0 OR v_dc_count > 0 OR v_si_count > 0 THEN
    RAISE EXCEPTION 'ROLLBACK BLOCKED: Batch has subsequent inventory activity (allocations: %, tx: %, layers: %, DC: %, SI: %)',
      v_alloc_count, v_tx_count, v_layer_count, v_dc_count, v_si_count;
  END IF;

  -- 3. Execute Rollback
  PERFORM set_config('app.finance_metadata_repair', 'on', true);

  UPDATE public.batches
     SET import_quantity   = 225.000,
         final_landed_cost = 171214458.75,
         updated_at        = NOW()
   WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d'
     AND import_quantity   = 249.890
     AND current_stock     = 0.000;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  IF v_rows_updated <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK EXECUTION FAILED: Expected exactly 1 row updated, got %', v_rows_updated;
  END IF;

  RAISE NOTICE 'SUCCESS: Batch 34d352ef rolled back to 225.000 kg / Rp 171,214,458.75';
END $$;

COMMIT;
*/
