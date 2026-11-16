# ANZEN ERP — PROMPT 7C FINAL SQL SAFETY REVIEW, UNIT-COST RESOLUTION & PRE-PRODUCTION REPORT

**Date:** 16 November 2026  
**Repository:** `/Users/Kunal/Documents/anzen-main`  
**Production Database:** `dkrtsqienlhpouohmfki` (AWS ap-southeast-1)  
**Target Batch:** `BDM/2609056` (`34d352ef-26a9-482f-81a4-b83f11ad6a7d`)  
**Target Purchase Invoice:** `E0000244/2627` (`88af074d-4ec2-44f0-b938-0c7c8b4dd8ca`)  
**Status:** Pre-Production Safety Review Complete — Zero Production Data Modified (Awaiting Management Authorization)  

---

## 1. EXACT ROOT CAUSE SUMMARY

When saving purchase invoice `E0000244/2627` with two lines for Domperidone Maleate BP (Line 13 = 225.000 kg and Line 12 = 24.890 kg):
1. **Line 13 (225.000 kg)** was processed first. The function `public.save_purchase_invoice` inserted a new row into `public.batches` with `import_quantity = 225.000 kg`, `current_stock = 0.000 kg` (in-transit skeleton batch), and `cost_per_unit = Rp 760,953.15` ($42.03 \times 18,105).
2. **Line 12 (24.890 kg)** was processed second. It resolved the batch ID created moments earlier (`v_resolved_batch_id IS NOT NULL`), bypassed Step 3 batch insertion, and linked `batch_id` on the item record.
3. **The Defect**: `save_purchase_invoice` contained **zero logic to accumulate or aggregate `import_quantity` or `final_landed_cost`** for subsequent lines sharing a batch.
4. **The Result**: Both items correctly linked to batch `34d352ef`, and `JE-2610-0005` correctly debited GL 1130 for both lines (total Rp 190,154,642.40). However, `batches.import_quantity` remained permanently truncated at 225.000 kg, and `inventory_operational_physical_ledger` (which is a view over `batches`) inherited the 225.000 kg figure.

---

## 2. EXPLANATION OF THE UNIT-COST DISCREPANCY & 24.890 KG LINE TOTAL

### A. Why Line 12 (24.890 kg) Has a Line Total of USD 1,046.13
- **Mathematical Product**:
  $$\text{Quantity} \times \text{Unit Price} = 24.890\text{ kg} \times \$42.03/\text{kg} = \$1,046.1267$$
- **Commercial Invoicing Standard**:
  In standard international commercial invoicing (and SAPJ ERP line calculations), invoice line totals in currency must be rounded to two decimal places (cents) using standard half-up rounding:
  $$\$1,046.1267 \xrightarrow{\text{round to 2 decimals}} \$1,046.13$$
  This creates an exact commercial cent-rounding upward of **$+\$0.0033$** (+0.33 cents).
- **Document Verification**: Both Purchase Order `45d57ed5` Item 13 and Purchase Invoice `E0000244/2627` Item 12 record and bill the line total as **USD 1,046.13**.

### B. Why There Is a Rp 0.24 Variance (Rp 760,953.15 vs Rp 760,953.39)
- **Contract Unit Price in IDR**:
  $$\text{USD } 42.03 \times \text{FX } 18,105 = \text{Rp } 760,953.1500/\text{kg}$$
- **Capitalized Commercial Invoice IDR Value** (GL 1130 in `JE-2610-0005`):
  - Line 12 (24.890 kg): $\$1,046.13 \times 18,105 = \text{Rp } 18,940,183.65$
  - Line 13 (225.000 kg): $\$9,456.75 \times 18,105 = \text{Rp } 171,214,458.75$
  - **Total Capitalized in GL 1130**: $\text{Rp } 190,154,642.40$
- **Dividing Total Capitalized IDR by Total Kilograms**:
  $$\frac{\text{Rp } 190,154,642.40}{249.890\text{ kg}} = \text{Rp } 760,953.389091\dots \approx \text{Rp } 760,953.39/\text{kg}$$
- **Source of the Rp 0.2391/kg (Rp 0.24) Difference**:
  The line-level cent-rounding of $+\$0.0033$ on Line 12 converts to IDR as:
  $$+\$0.0033 \times 18,105 = \text{Rp } 59.7465 \approx \text{Rp } 59.75$$
  Spreading this Rp 59.75 across the entire 249.890 kg batch yields:
  $$\frac{\text{Rp } 59.7465}{249.890\text{ kg}} = \text{Rp } 0.23909\dots \approx \text{Rp } 0.24/\text{kg}$$

---

## 3. CONFIRMATION OF THE SOURCE OF TRUTH FOR COST FIELDS

| Field Name | Authoritative Source of Truth | Current DB Value | Proposed Action | Rationale |
|---|---|---:|:---:|---|
| `cost_per_unit` | Contract Unit Price ($\text{USD } 42.03 \times 18,105$) | `Rp 760,953.1500` | **DO NOT OVERWRITE** (Preserve `760,953.1500`) | Preserves contract unit price; prevents false COGS propagation trigger. |
| `landed_cost_per_unit` | Prior to container finalization, equals `cost_per_unit` | `Rp 760,953.15` | **DO NOT OVERWRITE** (Preserve `760,953.15`) | Aligns with `cost_per_unit`; updated when container landed costs are allocated. |
| `import_price_per_unit` | Functional baseline unit purchase price | `Rp 760,953.15` | **DO NOT OVERWRITE** (Preserve `760,953.15`) | Baseline benchmark price for landed cost calculations. |
| `final_landed_cost` | Total capitalized inventory value debited to GL 1130 | `Rp 171,214,458.75` | **UPDATE** to `Rp 190,154,642.40` | Reconciles batch valuation directly to the sum of GL 1130 debits. |
| `import_quantity` | Sum of all PI line items linked to this batch | `225.000` kg | **UPDATE** to `249.890` kg | Reconciles intake quantity across both invoice lines. |
| `current_stock` | Warehouse physical received inventory | `0.000` kg | **PRESERVE** `0.000` kg | Goods are in-transit; inward receiving has not occurred. |

> [!IMPORTANT]
> **Strict Semantic Invariant**: We do NOT overwrite `cost_per_unit`, `landed_cost_per_unit`, or `import_price_per_unit` with `Rp 760,953.39`. The database currently already has `760,953.1500`, which is the exact contract unit cost. Overwriting it with `760,953.39` would corrupt the unit pricing and conflict with warehouse cost layers upon inward receiving.

---

## 4. MIGRATION SAFETY REVIEW (`20261116100000_fix_multi_line_batch_receiving_aggregation.sql`)

A comprehensive review of the 9 required safety dimensions was performed:

### 1. Multiple Purchase Invoices Sharing One Batch
- **Finding**: 5 existing production batches (`2610892`, `DFS/126010052`, `DFS/126010053`, `DFS/126030158`, `XMEP250178`) are shared across multiple purchase invoices, where `batches.import_quantity` equals the sum of line items across ALL referencing invoices.
- **Safety Fix Applied**: Post-loop aggregation in `save_purchase_invoice` was updated to group `pii` across all invoices linking to the batch (`JOIN purchase_invoices pi`). It will never overwrite or drop quantities from other invoices sharing the batch.

### 2. Existing Batch Aggregation Across Invoices
- Batches already aggregated across multiple invoices are protected. Furthermore, the aggregation query strictly checks:
  `AND COALESCE(b.current_stock, 0) = 0 AND NOT EXISTS (SELECT 1 FROM purchase_invoice_receiving_allocations pira WHERE pira.batch_id = b.id)`
  This guarantees that batches with physical receiving history are never altered.

### 3. Invoice Edit and Update Behaviour
- If an invoice is updated, line items added/modified/removed recalculate the batch aggregate dynamically.
- Existing safeguard: Line deletion is explicitly blocked if receiving allocations or inventory history exist (`Cannot remove invoice line with receiving or inventory history`).

### 4. Partial and Subsequent Warehouse Receipts
- In `receive_purchase_invoice_item`, skeleton batches use:
  - Initial receipt: `import_quantity = GREATEST(COALESCE(import_quantity, 0), p_received_quantity)`. A pre-created 249.890 kg batch receiving 225 kg preserves 249.890 kg (`GREATEST(249.890, 225) = 249.890`).
  - Subsequent receipt: `import_quantity = GREATEST(COALESCE(import_quantity, 0), existing_allocations + p_received_quantity)`. Receiving the remaining 24.890 kg keeps the batch at 249.890 kg.

### 5. Duplicate Receipt Prevention
- `receive_purchase_invoice_item` checks for existing `operation_id` in `purchase_invoice_receiving_allocations` and returns idempotently.
- `public.purchase_invoice_item_received_quantity` checks enforce that total received quantity cannot exceed the invoice line quantity.

### 6. Cost-Layer Integrity
- Each physical receipt creates an exact entry in `purchase_invoice_receiving_allocations` and `purchase_batch_cost_layers`.
- Unit cost recorded in cost layers is `round(unit_price * exchange_rate, 2)` = Rp 760,953.15, maintaining 100% cost-layer integrity.

### 7. Stock Movement Idempotency
- Unique `operation_id` prevents duplicate inventory movement postings in `inventory_transactions`.

### 8. Existing Function Permissions and Security Behaviour
- `save_purchase_invoice`: `SECURITY DEFINER SET search_path TO 'public', 'pg_temp'`.
- `receive_purchase_invoice_item`: `SECURITY DEFINER SET search_path TO 'public', 'pg_temp'` and strictly enforces `public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts', 'warehouse'])`.

### 9. Preservation of All Original Function Business Logic
- All journal entry postings (JE-YYYYMM-XXXX), GL 1130 debits, PPN 1150, stamp duty 6950, AP 2110, Faktur Pajak numbers, document URLs, and Make FK validations are 100% preserved.

---

## 5. HARDENED DOMPERIDONE DATA CORRECTION SQL

The file [SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql) has been updated with explicit preconditions and row-count assertions:

```sql
BEGIN;

DO $$
DECLARE
  v_batch RECORD;
  v_item_count INT;
  v_item_total_qty NUMERIC;
  v_item_total_idr NUMERIC;
  v_je_domperidone_debit NUMERIC;
  v_alloc_count INT;
  v_tx_count INT;
  v_layer_count INT;
  v_rows_updated INT;
BEGIN
  -- ── 1. PRECONDITION ASSERTIONS (FAIL FAST) ────────────────────────────────
  SELECT id, batch_number, import_quantity, current_stock, cost_per_unit, 
         landed_cost_per_unit, import_price_per_unit, final_landed_cost, expiry_date
    INTO v_batch
    FROM public.batches
   WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Batch 34d352ef does not exist';
  END IF;

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

  -- Verify zero physical warehouse receiving history
  SELECT COUNT(*) INTO v_alloc_count
    FROM public.purchase_invoice_receiving_allocations
   WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  IF v_alloc_count > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Found % receiving allocations for this batch', v_alloc_count;
  END IF;

  SELECT COUNT(*) INTO v_tx_count
    FROM public.inventory_transactions
   WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  IF v_tx_count > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Found % inventory transactions for this batch', v_tx_count;
  END IF;

  SELECT COUNT(*) INTO v_layer_count
    FROM public.purchase_batch_cost_layers
   WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  IF v_layer_count > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Found % cost layers for this batch', v_layer_count;
  END IF;

  -- Verify invoice items: exactly 2 lines, 249.890 kg
  SELECT COUNT(*), SUM(quantity), SUM(line_total * 18105)
    INTO v_item_count, v_item_total_qty, v_item_total_idr
    FROM public.purchase_invoice_items
   WHERE purchase_invoice_id = '88af074d-4ec2-44f0-b938-0c7c8b4dd8ca'
     AND batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';

  IF v_item_count <> 2 OR v_item_total_qty <> 249.890 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Expected 2 items totaling 249.890 kg, found % items and % kg', v_item_count, v_item_total_qty;
  END IF;

  -- Verify GL 1130 debits: exactly Rp 190,154,642.40
  SELECT SUM(jel.debit)
    INTO v_je_domperidone_debit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE je.reference_id = '88af074d-4ec2-44f0-b938-0c7c8b4dd8ca'
     AND coa.code = '1130'
     AND jel.description ILIKE '%domperidone%';

  IF v_je_domperidone_debit <> 190154642.40 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Expected GL 1130 debits of Rp 190,154,642.40, found %', v_je_domperidone_debit;
  END IF;

  -- ── 2. EXECUTE DATA CORRECTION ────────────────────────────────────────────
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

  -- ── 3. POST-EXECUTION VERIFICATION ASSERTIONS ─────────────────────────────
  SELECT import_quantity, final_landed_cost, cost_per_unit
    INTO v_batch
    FROM public.batches
   WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';

  IF v_batch.import_quantity <> 249.890 OR v_batch.final_landed_cost <> 190154642.40 OR v_batch.cost_per_unit <> 760953.1500 THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: Unexpected post-update values';
  END IF;

  RAISE NOTICE 'SUCCESS: Batch 34d352ef (BDM/2609056) successfully corrected to 249.890 kg / Rp 190,154,642.40';
END $$;

-- Verify operational physical ledger view automatically reflects 249.890 kg
SELECT batch_id, quantity, source_type, reference_number
FROM public.inventory_operational_physical_ledger
WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';

COMMIT;
```

---

## 6. REGRESSION TEST RESULTS

All regression suites were re-executed against the live database in isolated rollback transactions:

| Suite | Command | Total Tests | Passed | Result |
|---|---|:---:|:---:|:---:|
| **Multi-Line Batch Receiving** | `npm run test:targeted -- multi-line` | 12 | 12 | **100% Pass** |
| **Forensic Inventory & COGS** | `npm run test:targeted -- forensic` | 14 | 14 | **100% Pass** |
| **Database Security Hardening** | `npm run test:targeted -- database-security` | 16 | 16 | **100% Pass** |
| **TypeScript Typecheck** | `npm run typecheck` | — | — | **0 Errors** |

---

## 7. REMAINING ACTIONS REQUIRING MANAGEMENT APPROVAL

The following two actions are prepared, verified, and ready for production execution upon management authorization:

1. **Production Data Correction**:
   - File: [SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql)
   - Scope: Updates batch `34d352ef-26a9-482f-81a4-b83f11ad6a7d` (`BDM/2609056`) import quantity from 225.000 kg to 249.890 kg and final landed cost to Rp 190,154,642.40.
   - Financial impact: **Rp 0.00** (GL 1130 debits already match Rp 190,154,642.40; zero journal entries required).
2. **Permanent Migration Deployment**:
   - File: [20261116100000_fix_multi_line_batch_receiving_aggregation.sql](file:///Users/Kunal/Documents/anzen-main/supabase/migrations/20261116100000_fix_multi_line_batch_receiving_aggregation.sql)
   - Scope: Deploys hardened `public.save_purchase_invoice` and `public.receive_purchase_invoice_item` to permanently protect against multi-line and multi-invoice batch aggregation issues.
