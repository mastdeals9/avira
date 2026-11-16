# ANZEN ERP — PROMPT 7C FINAL VALIDATION & FORENSIC EXCEPTION REPORT
**Date:** 16 November 2026  
**Repository:** `/Users/Kunal/Documents/anzen-main`  
**Production Supabase Project:** `dkrtsqienlhpouohmfki` (AWS ap-southeast-1)  
**Status:** Verification Complete — Strictly Read-Only Audit & Non-Production Rollback Simulation  

---

## EXECUTIVE SUMMARY

This forensic report resolves the final 5 validation points required before formal accounting sign-off on Prompt 7C (Historical Inventory Valuation, Landed Costs, and COGS Reconciliations).

All investigations were conducted under strictly read-only access to the live production database (`dkrtsqienlhpouohmfki`). Operational and accounting flows were validated using isolated database transactions that rolled back cleanly, producing **zero mutations** to production data.

### Key Audit Conclusions

1. **Rp 1,243,816.77 Difference Reconciled**: The apparent difference between the Landed Cost Capitalization Gap (Rp 51,347,274.77) and the Net GL 5300 Freight In balance (Rp 50,103,458.00) is **proven to be an apples-to-oranges metric comparison**, not an unposted journal or missing freight transaction. A flat entry `Dr 1130 / Cr 5300 Rp 51,347,274.77` **must NOT be posted**, as it would leave GL 5300 with an unnatural credit balance of -Rp 1,243,816.77 and duplicate existing capitalized costs.
2. **Domperidone Receipt Confirmed as Single Batch**: Line Item 12 (24.890 kg / Rp 18,940,183.65) and Line Item 13 (225.000 kg / Rp 171,214,458.75) of Purchase Invoice `E0000244/2627` represent a single batch (`BDM/2609056`). Both lines were **already debited to GL 1130** in `JE-2610-0005`. Updating `batches.import_quantity` to 249.890 kg corrects the inventory register without requiring any journal entry.
3. **DO Invoicing Safety Simulation Successful**: A non-production simulation of sales invoices linked to `DO-26-0079` and `DO-26-0080` confirmed:
   - **Zero duplicate stock deduction** (`batches.current_stock` remained 0 kg and 250 kg).
   - **Exactly one COGS journal** per invoice (`JE2611-0379` and `JE2611-0380`).
   - **Exactly one Dr 5100 and Cr 1130 line** per invoice.
   - **FIFO COGS**: DO-26-0079 = Rp 19,057,500.00 (FIFO layer `FJ1-2611001` @ Rp 190,575/kg); DO-26-0080 = Rp 21,504,000.00 (FIFO layer `80103232` @ Rp 86,016/kg). Combined FIFO COGS = **Rp 40,561,500.00**.
   - **Retry Idempotency**: Subsequent invoice updates triggered zero duplicate journals.
4. **Rp 95.03 Rounding Variance Confirmed**: The Rp 95.03 variance across 110 sales invoice lines is confirmed to be fractional-cent line-item rounding (primarily Rp 92.49 on batch `EX/PG/26-27/M014`). No manual journal entry is required.

---

## 1. RECONCILIATION OF THE RP 1,243,816.77 DIFFERENCE

### 1.1 Forensic Anatomy of the Two Metrics

The prior audit report noted two figures:
- **Metric A: Batch Capitalization Gap**: Rp 51,347,274.77  
  `Total Batch Cost in Master (Rp 11,410,570,478.90) − Total GL 1130 Inbound Capitalization (Rp 11,359,223,204.13)`
- **Metric B: Net GL 5300 (Freight In) Balance**: Rp 50,103,458.00  
  `Gross Debits (Rp 78,111,960.00) − Historical Reversals (Rp 28,008,502.00)`

Subtracting Metric B from Metric A yields **Rp 1,243,816.77**.

### 1.2 Proof: Why Metric A and Metric B Are Unrelated

The assumption that Metric A represents uncapitalized GL 5300 freight is mathematically and architecturally incorrect:

1. **Driver of Metric A**: Over 99.6% of the Rp 51,347,274.77 gap originates from **PI `E0000220/2526` / Container `1st 20MT FCL NOV 25`** (Rp 51,159,308.27). In `batches`, the unit costs for this container include import overheads. However, the actual import expenses for this container were:
   - Capitalized directly to GL 1130 via expense vouchers `EXP/25/234` and `EXP/25/288`: **Rp 45,673,261.00**
   - Expensed to BPOM & SKI Fees (GL 6710): **Rp 750,000.00**
   - Expensed to Miscellaneous Expense (GL 6900): **Rp 300,000.00**
   - **GL 5300 has ZERO entries for this container.**
2. **Driver of Metric B**: GL 5300 contains container freight and clearing expenses for entirely different shipments (such as `2nd FCL 20MT`, `3rd FCL corn starch`, and air shipments). Additionally, GL 5300 contains **Rp 990,000.00** of local warehouse handling and unloading fees from petty cash (`PC-202602-022`, `PC-202607-043`, `PC-202608-010`) that were general warehouse operating costs, not batch-allocable ocean freight.
3. **Other Landed Cost Accounts**: In `finance_expenses`, items marked `include_in_landed_cost = true` were charged across multiple distinct expense and asset accounts:
   - **GL 1130 (Inventory - Direct Capitalization)**: Rp 133,661,434.00 (36 lines)
   - **GL 5300 (Freight In)**: Rp 49,113,458.00 (42 lines)
   - **GL 5410 (BPOM / SKI Registration Fees)**: Rp 650,000.00 (12 lines)
   - **GL 6710 (BPOM & SKI Fees)**: Rp 1,500,000.00 (30 lines)
   - **GL 6900 (Miscellaneous Expense - Forwarder Port Fees)**: Rp 3,350,000.00 (5 lines)
   - **GL 6950 (Bea Meterai Expense)**: Rp 10,000.00 (1 line)

### 1.3 Complete Schedule of All 45 GL 5300 Lines (18 Entries)

| # | Entry Number | Date | Source Module | Voucher / Reference | Lines | Gross Debit (Rp) | Gross Credit (Rp) | Net Balance (Rp) | Transaction Details |
|---|---|---|---|---|:---:|---:|---:|---:|---|
| 1 | `JE2512-0108` | 2025-12-23 | `expenses` | `EXP/25/300` | 1 | 100,000.00 | 0.00 | 100,000.00 | Unload airfreight shipment goods |
| 2 | `JE-20260211-0005` | 2026-02-11 | `petty_cash` | `PC-202602-022` | 1 | 765,000.00 | 0.00 | 765,000.00 | Warehouse loading/handling fee |
| 3 | `JE2602-0200` | 2026-02-20 | `expenses` | `EXP/26/0200` | 2 | 20,390,915.00 | 0.00 | 20,390,915.00 | Broker service & forwarder reimbursement |
| 4 | `JE2602-0201` | 2026-02-20 | `expenses` | `EXP/26/0201` | 3 | 5,210,637.00 | 0.00 | 5,210,637.00 | Broker service & forwarder reimbursement |
| 5 | `JE2604-0094` | 2026-04-18 | `expenses` | `EXP/26/0094` | 8 | 10,450,721.00 | 0.00 | 10,450,721.00 | Forwarder clearing, port fees & seal |
| 6 | `JE2606-0120` | 2026-06-25 | `expenses` | `EXP/26/0120` | 3 | 6,142,500.00 | 0.00 | 6,142,500.00 | Broker service & reimbursement |
| 7 | `JE2608-0069` | 2026-06-25 | `historical_repair` | `HR-REV-0217` | 3 | 0.00 | 6,142,500.00 | -6,142,500.00 | Reversal of duplicate EXP/26/0120 posting |
| 8 | `JE2609-0017` | 2026-06-25 | `historical_repair` | `HR-REV-421d` | 3 | 0.00 | 6,142,500.00 | -6,142,500.00 | Reversal of second duplicate posting |
| 9 | `JE2609-0018` | 2026-06-25 | `expenses` | `EXP/26/0120` | 3 | 6,142,500.00 | 0.00 | 6,142,500.00 | Final clean single-instance posting |
| 10 | `JE-20260724-0011` | 2026-07-24 | `petty_cash` | `PC-202607-043` | 1 | 125,000.00 | 0.00 | 125,000.00 | Warehouse loading fee |
| 11 | `JE2608-0187` | 2026-08-10 | `expenses` | `EXP/26/0187` | 1 | 900,000.00 | 0.00 | 900,000.00 | Coolie charges 1x20 FCL unloading |
| 12 | `JE2608-0189` | 2026-08-10 | `expenses` | `EXP/26/0189` | 1 | 200,000.00 | 0.00 | 200,000.00 | Port security and parking charge |
| 13 | `JE-20260811-0005` | 2026-08-11 | `petty_cash` | `PC-202608-010` | 1 | 100,000.00 | 0.00 | 100,000.00 | Warehouse handling fee |
| 14 | `JE2608-0168` | 2026-08-13 | `expenses` | `EXP/26/0168` | 5 | 15,723,502.00 | 0.00 | 15,723,502.00 | Forwarder clearing & port fees |
| 15 | `JE2608-0169` | 2026-08-13 | `expenses` | `EXP/26/0169` | 2 | 10,461,185.00 | 0.00 | 10,461,185.00 | Forwarder clearing & lift-on/off |
| 16 | `JE2609-0021` | 2026-08-13 | `historical_repair` | `HR-REV-575a` | 5 | 0.00 | 15,723,502.00 | -15,723,502.00 | Reversal of duplicate EXP/26/0168 posting |
| 17 | `JE2608-0173` | 2026-08-26 | `expenses` | `EXP/26/0173` | 1 | 200,000.00 | 0.00 | 200,000.00 | Security charges - Corn Starch unloading |
| 18 | `JE2608-0172` | 2026-08-27 | `expenses` | `EXP/26/0172` | 1 | 1,200,000.00 | 0.00 | 1,200,000.00 | Collie charges for unloading Corn Starch |
| **TOTAL** | | | | | **45** | **78,111,960.00** | **28,008,502.00** | **50,103,458.00** | **Net GL 5300 Balance** |

*Note: The 42 expense lines referenced in the prompt comprise entries 1 and 3 through 18 (excluding the 3 petty cash entries 2, 10, and 13). Net expense lines = Rp 49,113,458.00 + Petty Cash Rp 990,000.00 = Rp 50,103,458.00.*

### 1.4 Accounting Recommendation

> [!CAUTION]
> **DO NOT POST `Dr 1130 / Cr 5300 Rp 51,347,274.77`.**  
> Crediting GL 5300 by Rp 51,347,274.77 against an account that only contains Rp 50,103,458.00 would leave GL 5300 with an unnatural credit balance of -Rp 1,243,816.77. The Rp 51.347M batch cost difference is not sitting in GL 5300; it was already recognized through direct PIB capitalization (GL 1130) and other expense accounts (6710, 6900). Any manual journal attempting to "force" this equality would corrupt both GL 1130 and GL 5300.

---

## 2. DOMPERIDONE BATCH CORRECTION FOR PI E0000244/2627

### 2.1 Documentary and Database Evidence

Purchase invoice `E0000244/2627` (Supplier: *Bansal Fine Chem*, Invoice Date: 15 October 2026) contains two consecutive line items for Domperidone Maleate BP:
- **Line Item 12** (`e1e69557-0803-49d7-8329-3733d3c8a417`): 24.890 kg @ USD 42.03 @ 18,105 = USD 1,046.13 = **Rp 18,940,183.65**
- **Line Item 13** (`e4c27a29-2321-4f81-9fe3-6a9c8f000305`): 225.000 kg @ USD 42.03 @ 18,105 = USD 9,456.75 = **Rp 171,214,458.75**
- **Total Combined**: **249.890 kg / Rp 190,154,642.40**

Database record verification:
- Both lines share the exact same `receiving_batch_number`: `'BDM/2609056'`.
- Both lines share the exact same `receiving_expiry_date`: `'2031-08-30'`.
- Both lines share the exact same manufacturer (`receiving_make_id`: `2f000213-4df6-4e4d-8a70-88223da71a7e`).
- Both lines point to the same batch entity (`batch_id`: `34d352ef-26a9-482f-81a4-b83f11ad6a7d`).

The supplier invoice split 249.890 kg into a standard drum lot (225 kg) and an odd weight drum / sample (24.890 kg). In `batches`, the row was initially created with `import_quantity = 225.000 kg`, leaving the 24.890 kg unreflected in the batch master scalar.

### 2.2 GL 1130 Verification

In posted journal entry `JE-2610-0005`:
- **Line 4**: `Dr 1130 Inventory` = **Rp 171,214,458.75** (Line Item 13)
- **Line 19**: `Dr 1130 Inventory` = **Rp 18,940,183.65** (Line Item 12)
- **Credit**: Accounts Payable (`2110`) was credited for the full invoice total.

GL 1130 **already received debits for both lines** on 15 October 2026.

### 2.3 Proposed Correction

- **Batch Master Update**: Update `batches` where `id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d'` to set `import_quantity = 249.890`.
- **Accounting Impact**: **Rp 0.00**. No journal entry is required. This update will not create any duplicate capitalization in GL 1130.

---

## 3. DO-26-0079 & DO-26-0080 INVOICE SAFETY SIMULATION

A non-production simulation (`scripts/audits/simulate_do_invoicing_safety.mjs`) was executed within a single transaction and rolled back completely.

### 3.1 Verification Checklist

| Test Item | Verification Criterion | Simulation Result | Pass / Fail |
|---|---|---|:---:|
| **Delivery Challan Linkage** | Invoices link to `dci.id` | Linked to `DO-26-0079` and `DO-26-0080` items | **PASS** |
| **Stock Deduction Safety** | `batches.current_stock` does not decrement | `DFS/126010053`: 0 kg $\rightarrow$ 0 kg; `2610712`: 250 kg $\rightarrow$ 250 kg | **PASS** |
| **COGS Journal Creation** | Exactly 1 journal per invoice | Created `JE2611-0379` and `JE2611-0380` | **PASS** |
| **GL Line Distribution** | Exactly 1 Dr 5100 and 1 Cr 1130 | Both entries have exactly 1 Dr 5100 and 1 Cr 1130 | **PASS** |
| **Retry Idempotency** | Updating invoice does not duplicate journals | `je_count` remained exactly 1 upon invoice update | **PASS** |

### 3.2 COGS Valuation: FIFO Layer vs Prompt Estimate

- **DO-26-0080 (Batch `2610712`)**:
  - Quantity: 250 kg
  - FIFO Cost Layer (`80103232`): Rp 86,016.00/kg
  - COGS: **Rp 21,504,000.00** (matches prompt expectation)
- **DO-26-0079 (Batch `DFS/126010053`)**:
  - Quantity: 100 kg
  - First intake layer (`017/KTT/IX/2026`, 175 kg @ Rp 176,750.00) was **already fully consumed** by `SAPJ-26-060` on 2026-09-07.
  - Active FIFO Cost Layer (`FJ1-2611001`, received 2026-11-09): 100 kg @ **Rp 190,575.00/kg**.
  - System FIFO COGS: **Rp 19,057,500.00**.
  - *Reconciliation note*: The prompt's expected figure of Rp 17,675,000.00 was calculated from the historical scalar in `batches.cost_per_unit` (Rp 176,750). The system's automated trigger correctly used the live FIFO cost layer from `FJ1-2611001`, posting Rp 19,057,500.00.
- **Combined Invoiced COGS**: **Rp 40,561,500.00** (or Rp 39,179,000.00 if evaluated under historical scalar).

---

## 4. CONFIRMATION OF THE RP 95.03 ROUNDING PROOF

The three-way COGS reconciliation establishes:
$$\text{Net Invoiced COGS} = \text{Gross Snapshot COGS (85 SIs)} - \text{Credit Note COGS} = 6,977,983,250.42 - 1,227,102.50 = \text{Rp } 6,976,756,147.92$$
$$\text{GL 5100 Net Balance} = 7,478,143,598.57 - 501,387,450.65 = \text{Rp } 6,976,756,147.92$$
$$\text{Three-Way Variance} = \text{Rp } 0.00$$

When calculating the theoretical COGS by multiplying delivered quantities against batch unit costs across all 110 line items:
- Theoretical Implied COGS: **Rp 6,976,756,242.95**
- Actual Invoiced COGS: **Rp 6,976,756,147.92**
- Variance: **Rp 95.03**

### Cause of the Rp 95.03 Variance
- **Batch `EX/PG/26-27/M014`**: Delivered 18,500 kg @ Rp 10,129.30/kg. Line total snapshot in sales invoice was Rp 187,391,957.51 vs exact batch cost of Rp 187,392,050.00 $\rightarrow$ **+Rp 92.49 variance**.
- **Cent-level rounding across 20 other batches**: Accumulated fractional-cent differences netting to **+Rp 2.54**.
- **Conclusion**: The Rp 95.03 variance is standard fractional currency rounding across 110 lines and 85 invoices. **Zero manual journal adjustment is required.**

---

## 5. FINAL RECOMMENDED ACCOUNTING CORRECTIONS

| Proposal | Description | Audit Recommendation | Financial Impact |
|---|---|---|:---:|
| **1. Flat GL 5300 Capitalization** | `Dr 1130 / Cr 5300 Rp 51,347,274.77` | **REJECTED** (apples-to-oranges comparison; would over-credit GL 5300 and duplicate capitalization) | Rp 0.00 |
| **2. Domperidone Batch Correction** | Update batch `BDM/2609056` import quantity to 249.890 kg | **RECOMMENDED** (aligns batch register with physical/PI quantity; GL 1130 already debited) | Rp 0.00 |
| **3. DO-26-0079 & 0080 Invoicing** | Issue sales invoices for the 2 pending delivery challans | **RECOMMENDED** (verified safe; 0 duplicate stock reduction; Dr 5100 / Cr 1130 Rp 40,561,500.00) | Dr 5100 Rp 40.56M<br>Cr 1130 Rp 40.56M |
| **4. Rounding Adjustment Journal** | Manual journal for Rp 95.03 | **REJECTED** (natural fractional-cent line rounding; GL 5100 and Invoiced COGS already balance at Rp 0.00) | Rp 0.00 |

---

## 6. REMAINING MANAGEMENT DECISIONS FOR FINAL SIGN-OFF

The finance and inventory leadership should formally approve the following operational actions:

1. [ ] **Domperidone Batch Record Update**: Approve updating `batches.import_quantity = 249.890` for batch `BDM/2609056` (`34d352ef-26a9-482f-81a4-b83f11ad6a7d`).
2. [ ] **Sales Invoicing for DO-26-0079 and DO-26-0080**: Authorize the sales billing team to issue sales invoices linked to delivery challans `DO-26-0079` (100 kg) and `DO-26-0080` (250 kg).
3. [ ] **Formal Closure of Historical Inventory Valuation Rollforward**: Accept the confirmed figures:
   - Invoiced COGS and GL 5100 net balance match at **Rp 6,976,756,147.92** (Variance: Rp 0.00).
   - In-transit imports confirmed at **44,100 kg / Rp 3,214,145,715.00** across 23 skeleton batches.
   - Physical active inventory confirmed at **3,445 kg / Rp 1,180,489,520.95** across 18 batches.
   - Total active inventory position (Physical + Delivered DO awaiting invoicing) = **3,795 kg / Rp 1,219,668,520.95**.

