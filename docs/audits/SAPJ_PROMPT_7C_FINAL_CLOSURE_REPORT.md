# ANZEN ERP — PROMPT 7C FINAL CLOSURE & PRODUCTION READINESS REPORT

**Date:** 16 November 2026  
**Repository:** `/Users/Kunal/Documents/anzen-main`  
**Production Database:** `dkrtsqienlhpouohmfki` (AWS ap-southeast-1)  
**Target Batch:** `BDM/2609056` (`34d352ef-26a9-482f-81a4-b83f11ad6a7d`)  
**Target Purchase Invoice:** `E0000244/2627` (`88af074d-4ec2-44f0-b938-0c7c8b4dd8ca`)  
**Status:** **READY FOR PRODUCTION APPROVAL** (Zero Production Mutations Executed; Awaiting Management Sign-Off)

---

## 1. EXECUTIVE SUMMARY & READINESS STATEMENT

Prompt 7C investigation, mathematical reconciliation, SQL hardening, and migration safety reviews are **fully complete and verified**.

- **Production Database Status**: Strictly **read-only**. Zero rows modified, zero migrations deployed, zero journals posted, zero production inventory altered.
- **Production Completion Status**: In strict adherence to governance guidelines, **production completion is NOT claimed** until management authorizes and independently verifies the execution of the two separate production actions.
- **Production Readiness Verdict**: **APPROVED FOR PRODUCTION SIGN-OFF**. All four safety checks have passed without exception.

---

## 2. THE FOUR FINAL SAFETY CHECKS

### Check 1: Cross-Invoice Batch Aggregation
A comprehensive scan of the entire database was executed across all purchase orders, purchase invoices, delivery challans, sales invoices, and inventory transactions:

1. **System-Wide Reference Verification**:
   - Batch `34d352ef-26a9-482f-81a4-b83f11ad6a7d` (`BDM/2609056`) is referenced by **only one** purchase invoice in the entire database: `88af074d-4ec2-44f0-b938-0c7c8b4dd8ca` (`E0000244/2627`).
   - On that invoice, exactly two lines reference this batch:
     - Item `413be542-afc3-4fdf-badf-971b9df0a687`: 225.000 kg @ \$42.03 (\$9,456.75)
     - Item `c3bfa9da-f0b1-4ea8-b53e-dd862da252a3`: 24.890 kg @ \$42.03 (\$1,046.13)
   - Purchase Order `45d57ed5` (`PO-2611-0002`) contracts the same two lines (`ea468f92` and `de437b64`).
2. **System-Wide Expected Quantity and Value**:
   - Total Expected Quantity across ALL purchase invoices: **249.890 kg**.
   - Total Expected Value in USD across ALL purchase invoices: **USD 10,502.88**.
   - Total Capitalized IDR Value across ALL purchase invoices (GL 1130): **Rp 190,154,642.40**.
3. **Cross-Invoice Overwrite Guard in SQL**:
   The data correction SQL includes an explicit cross-invoice assertion:
   ```sql
   SELECT COUNT(DISTINCT purchase_invoice_id), COUNT(*), SUM(quantity)
     INTO v_distinct_pi_count, v_item_count, v_item_total_qty
     FROM public.purchase_invoice_items
    WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d'
       OR receiving_batch_number = 'BDM/2609056';

   IF v_distinct_pi_count <> 1 OR v_item_total_qty <> 249.890 THEN
     RAISE EXCEPTION 'CROSS-INVOICE SAFETY FAILED';
   END IF;
   ```
   If any other purchase invoice is concurrently linked, the script will immediately abort.

---

### Check 2: Concurrent Receiving Protection
1. **Row-Level Exclusive Locking**:
   At the beginning of the correction transaction, the script executes:
   ```sql
   SELECT * INTO v_batch FROM public.batches
    WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d'
      FOR UPDATE;

   PERFORM 1 FROM public.purchase_invoice_items 
    WHERE batch_id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d' 
      FOR UPDATE;
   ```
2. **Compatible Locking with Warehouse Receiving**:
   In `public.receive_purchase_invoice_item`, the function executes:
   ```sql
   SELECT * INTO v_batch FROM public.batches WHERE id = (p_payload->>'batch_id')::uuid FOR UPDATE;
   ```
   Because both paths use PostgreSQL row-level `FOR UPDATE` locks on the exact same row:
   - Any concurrent warehouse check-in attempting to call `receive_purchase_invoice_item` will block at the row lock until our transaction finishes.
   - It is impossible for a receipt to be processed between the precondition assertions and the update.

---

### Check 3: Rollback Safety & Downstream Usage Guard
1. **Downstream Activity Preconditions**:
   Before updating or rolling back, the script explicitly verifies:
   - Zero receiving allocations in `purchase_invoice_receiving_allocations`.
   - Zero inventory movements in `inventory_transactions`.
   - Zero cost layers in `purchase_batch_cost_layers`.
   - Zero delivery challan dispatches in `delivery_challan_items`.
   - Zero customer sales invoices in `sales_invoice_items`.
2. **Strict Guard Against Subsequent Usage**:
   In the rollback block, if the batch undergoes physical warehouse receiving, customer delivery, or sales invoicing after the correction, the rollback script detects the activity and **strictly aborts**:
   ```sql
   IF v_alloc_count > 0 OR v_tx_count > 0 OR v_layer_count > 0 OR v_dc_count > 0 OR v_si_count > 0 THEN
     RAISE EXCEPTION 'ROLLBACK BLOCKED: Batch has subsequent inventory activity (allocations: %, tx: %, layers: %, DC: %, SI: %)',
       v_alloc_count, v_tx_count, v_layer_count, v_dc_count, v_si_count;
   END IF;
   ```
   This guarantees that historical accounting entries and cost layers can never be orphaned or corrupted by an uncoordinated rollback.

---

### Check 4: Full Migration Source Review (`20261116100000_fix_multi_line_batch_receiving_aggregation.sql`)
A complete line-by-line diff between the live production definitions (`pg_get_functiondef`) and the migration file was performed.

#### Function 1: `public.save_purchase_invoice`
- **Original Source Preservation**: 100% preserved (all parameters, `SECURITY DEFINER`, `search_path`, JE number locks, A/P account 2110, Faktur Pajak handling, and status `'unpaid'`).
- **Exact Surgical Addition**: Added post-loop batch aggregation right before the PPN input debit line:
  ```sql
  UPDATE public.batches b
     SET import_quantity = agg.total_quantity,
         final_landed_cost = CASE 
           WHEN b.import_container_id IS NULL THEN agg.total_cost_idr 
           ELSE b.final_landed_cost 
         END,
         updated_at = NOW()
    FROM (
      SELECT 
        pii.batch_id,
        SUM(pii.quantity) as total_quantity,
        SUM(COALESCE(pii.line_total, pii.quantity * pii.unit_price) * CASE WHEN pi.currency = 'IDR' THEN 1 ELSE COALESCE(pi.exchange_rate, 1) END) as total_cost_idr
      FROM public.purchase_invoice_items pii
      JOIN public.purchase_invoices pi ON pi.id = pii.purchase_invoice_id
      WHERE pii.batch_id IN (
        SELECT DISTINCT item_sub.batch_id 
        FROM public.purchase_invoice_items item_sub 
        WHERE item_sub.purchase_invoice_id = v_invoice_id AND item_sub.batch_id IS NOT NULL
      )
      GROUP BY pii.batch_id
    ) agg
   WHERE b.id = agg.batch_id
     AND COALESCE(b.current_stock, 0) = 0
     AND NOT EXISTS (
       SELECT 1 FROM public.purchase_invoice_receiving_allocations pira WHERE pira.batch_id = b.id
     );
  ```
- **Safety Characteristics**:
  - Groups across all purchase invoices linking to the batch (`JOIN purchase_invoices pi`), preserving multi-invoice batch totals.
  - Leaves `cost_per_unit`, `landed_cost_per_unit`, and `import_price_per_unit` untouched at the contract unit price (Rp 760,953.15).
  - Skips batches that have already undergone physical warehouse receiving.

#### Function 2: `public.receive_purchase_invoice_item`
- **Original Source Preservation**: 100% preserved, including role authorization guards (`admin`, `accounts`, `warehouse`), Make validation, expiry conflict checks, idempotent retry logic, cost layer creation, and `apply_batch_receipt_weighted_average`.
- **Exact Surgical Modifications**:
  1. On initial receipt into unreceived skeleton batch:
     - Changed: `import_quantity = p_received_quantity`
     - To: `import_quantity = GREATEST(COALESCE(import_quantity, 0), p_received_quantity)`
  2. On subsequent receipt into existing batch:
     - Changed: `import_quantity = import_quantity + p_received_quantity`
     - To: `import_quantity = GREATEST(COALESCE(import_quantity, 0), (SELECT COALESCE(SUM(received_quantity), 0) FROM purchase_invoice_receiving_allocations WHERE batch_id = v_batch.id) + p_received_quantity)`
- **Safety Characteristics**:
  - Preserves pre-created multi-line intake sums during partial check-ins.
  - Dynamically expands if received goods exceed expected quantity.
  - Zero side effects on cost layers or inventory journals.

---

## 3. CONFIRMATION OF COMPLETED ACCOUNTING FINDINGS

All core accounting invariants established in Prompt 7C remain closed, reconciled, and verified:

| Accounting Domain | Confirmed Value / Balance | Reconciliation Status |
|---|---:|:---:|
| **Historical Batch Population** | 84 Batches / 127,780 kg | **Closed & Verified** |
| **Three-Way COGS Equilibrium** | Rp 6,976,808,614.93 | **Closed & Verified** ($\Delta = \text{Rp } 0.00$) |
| **Net GL 5100 Balance** | Rp 6,976,808,614.93 | **Closed & Verified** |
| **Net GL 5300 Balance** | Rp 50,103,458.00 (42 lines) | **Closed & Verified** |
| **GL 1130 Inbound Capitalization** | Rp 51,347,274.77 | **Closed & Verified** |
| **Capitalization vs GL 5300 Difference** | Rp 1,243,816.77 (VOUCHER-2610-0003) | **Closed & Verified** |
| **Purported "Missing COGS"** | Rp 3,214,145,715.00 | **Closed (Proven In-Transit Imports)** |
| **Delivered Stock Awaiting Invoicing** | 350 kg / Rp 39,179,000.00 | **Closed & Verified** (DO-26-0080 & DO-26-0081) |
| **Active Physical Inventory** | 3,445 kg / Rp 1,180,489,520.95 | **Closed & Verified** |
| **Combined Active Position** | 3,795 kg / Rp 1,219,668,520.95 | **Closed & Verified** |

---

## 4. THE TWO SEPARATE PRODUCTION ACTIONS

Production execution is split into two cleanly separated, independent actions requiring management authorization:

### Action 1: Hardened Domperidone Data Correction
- **Target File**: [SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql)
- **Target Database**: `dkrtsqienlhpouohmfki`
- **Scope**: Updates batch `BDM/2609056` (`34d352ef-26a9-482f-81a4-b83f11ad6a7d`):
  - `import_quantity`: 225.000 kg $\rightarrow$ **249.890 kg**
  - `final_landed_cost`: Rp 171,214,458.75 $\rightarrow$ **Rp 190,154,642.40**
  - `current_stock`: preserved at **0.000 kg**
  - `cost_per_unit`: preserved at **Rp 760,953.1500**
- **Financial Impact**: **Rp 0.00** (GL 1130 debits in `JE-2610-0005` lines 6 & 13 already equal Rp 190,154,642.40; zero journal adjustments required).
- **Rollback File**: Embedded inside [SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql) with downstream usage locks.

### Action 2: Permanent Migration Deployment
- **Target File**: [20261116100000_fix_multi_line_batch_receiving_aggregation.sql](file:///Users/Kunal/Documents/anzen-main/supabase/migrations/20261116100000_fix_multi_line_batch_receiving_aggregation.sql)
- **Target Database**: `dkrtsqienlhpouohmfki`
- **Scope**: Updates RPC functions `public.save_purchase_invoice` and `public.receive_purchase_invoice_item` to permanently handle multi-line batch aggregation, shared-batch aggregation across invoices, and partial receiving preservation.
- **Rollback File**: Production definitions preserved in scratch logs and can be redeployed via standard migration rollback if necessary.

---

## 5. FULL REGRESSION TEST SIGN-OFF

All test suites were executed against the live database in isolated rollback transactions:

| Test Suite | Path | Tests Run | Result | Execution Time |
|---|---|:---:|:---:|---:|
| **Multi-Line Batch Receiving** | `tests/purchase-invoice-multi-line-batch-receiving.test.mjs` | 12 | **12 Passed / 0 Failed** | 4.97s |
| **Forensic Inventory & COGS** | `tests/forensic-inventory-cogs-reconciliation.test.mjs` | 14 | **14 Passed / 0 Failed** | 2.13s |
| **Database Security Hardening** | `tests/database-security-hardening.test.mjs` | 16 | **16 Passed / 0 Failed** | 7.90s |
| **TypeScript Typecheck** | `tsc --noEmit -p tsconfig.app.json` | — | **0 Errors** | 4.10s |

---

## 6. FINAL SIGN-OFF CONCLUSION

All four safety checks, accounting reconciliations, unit-cost explanations, row-level locking protections, and migration source reviews are complete. 

**Prompt 7C is ready for management authorization to execute Action 1 (Data Correction) and Action 2 (Migration).**
No production changes have been applied.

