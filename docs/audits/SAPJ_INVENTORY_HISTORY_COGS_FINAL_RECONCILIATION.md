# SAPJ / ANZEN ERP — INVENTORY HISTORY & HISTORICAL COGS FINAL FORENSIC RECONCILIATION REPORT (CORRECTED EVIDENCE CLOSURE)

**Project:** SAPJ / Anzen ERP  
**Database:** Supabase Production Project `dkrtsqienlhpouohmfki` (AWS `ap-southeast-1`)  
**Audit Cut-Off Date:** 16 November 2026  
**Final Status:** **PROVISIONALLY RECONCILED WITH EXPLICIT OPEN ITEMS REGISTER** (Unconditional closure withheld pending commercial resolution of documented open items)  
**Lead Forensic Systems Architect:** Antigravity / Google DeepMind Agentic Audit Team

---

## 1. Executive Summary & Audit Posture

This forensic report concludes the forensic examination of historical Inventory, Landed Cost, and Cost of Goods Sold (COGS) for SAPJ / Anzen ERP.

In strict adherence to forensic integrity standards, this report **does not force balances**, **does not suppress genuine accounting variances**, and **does not issue an unconditional closure sign-off** while known commercial discrepancies remain open between physical batch records, purchase invoices, and the General Ledger.

All figures presented herein are derived from strictly read-only queries against live production database records, journal entries, and the authoritative batch schedule:
`docs/audits/SAPJ_INVENTORY_HISTORY_COGS_BATCH_SCHEDULE.csv`

### 1.1 Summary Table of Reconciled Figures

| Metric / Dimension                    | Live Database Reality                                                                                | Status & Classification                                                  |
| :------------------------------------ | :--------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------- |
| **Total Master Batches**              | **84 Batches** in `public.batches`                                                                   | 100.00% Accounted in Schedule                                            |
| **Total Inbound Received Quantity**   | **127,780.000 kg** across all 84 batches                                                             | 100.00% Accounted in Schedule                                            |
| **Physical Warehouse Stock**          | **3,445.000 kg** across 18 batches with positive `current_stock`                                     | Valued at **Rp 1,180,489,520.95**                                        |
| **Delivered Stock Awaiting Invoice**  | **350.000 kg** across 2 approved delivery challans (`DO-26-0079` & `DO-26-0080`)                     | Valued at **Rp 39,179,000.00**                                           |
| **Combined Active Position**          | **3,795.000 kg** (3,445 kg warehouse + 350 kg delivered)                                             | Valued at **Rp 1,219,668,520.95**                                        |
| **Invoiced / Depleted Quantity**      | **79,885.000 kg** across 42 fully depleted + 2 partially invoiced batches                            | Relieved via Sales Invoices                                              |
| **In-Transit Import Shipments**       | **23 Batches** (44,100.000 kg in `batches`, 44,124.890 kg in approved PIs)                           | Valued at **Rp 3,214,145,715.00** (batch) / **Rp 3,233,085,898.65** (GL) |
| **PI-to-Batch In-Transit Mismatch**   | **24.890 kg** ($1,046.13 / Rp 18,940,183.65) on PI `E0000244/2627` Item 17                           | **Documented Open Item 1**                                               |
| **Invoiced COGS Snapshot (Net)**      | **Rp 6,976,756,147.92** (Gross: Rp 6,977,983,250.42 less CN-26-0001: Rp 1,227,102.50)                | Exact cent match to GL 5100 net                                          |
| **GL 5100 COGS Net Balance**          | **Rp 6,976,756,147.92** (Gross Debits: Rp 7,478,146,382.65, Gross Credits: Rp 501,390,234.73)        | Cent-for-cent equilibrium                                                |
| **GL 1130 Net COGS Relief Credits**   | **Rp 6,976,756,147.92** (Net credits from sales invoice COGS & adjustments)                          | Cent-for-cent equilibrium                                                |
| **Batch COGS Line Rounding Residual** | **Rp 95.03** difference between 2-decimal unit cost multiplication and full-precision cost layers    | Traced across 94 lines                                                   |
| **GL 1130 Ending Net Balance**        | **Rp 4,382,467,056.21** (Debits: Rp 15,971,416,535.71, Credits: Rp 11,588,949,479.50)                | Reconciled via zero-plug bridge                                          |
| **GL 1130 Historical Residual**       | **Rp 1,149,381,157.56** (GL 1130 Net Rp 4,382,467,056.21 less In-Transit Debits Rp 3,233,085,898.65) | Reconciled to ledger debits                                              |
| **Active Stock Valuation Difference** | **Rp 70,287,363.39** (Active Subledger Rp 1,219,668,520.95 vs GL 1130 Residual Rp 1,149,381,157.56)  | **Documented Open Item 2**                                               |

---

## 2. Correct DO-26-0080 & DO-26-0079 Stock Classification

A forensic inspection of the physical and operational registers for Batch `2610712` and Batch `DFS/126010053` resolves previous classification errors:

### 2.1 Batch `2610712` (Paracetamol USP, Supplier: Menjangan Sakti, PI: 80103232)

- **Import Intake Quantity:** 500.000 kg @ landed cost Rp 86,016.00/kg = Total Landed Cost Rp 43,008,000.00.
- **Approved Delivery Challan:** `DO-26-0080` approved on 2026-11-06 for 250.000 kg to _PT Ciubros Farma_.
- **Invoicing Status:** Uninvoiced. Zero sales invoices exist in `public.sales_invoices` for this batch.
- **`batches.current_stock`:** Exactly **250.000 kg**.
- **Physical Ledger Status:** The operational warehouse ledger confirms receipt of 500.000 kg and dispatch of 250.000 kg, leaving exactly 250.000 kg in the warehouse.
- **Correct Classification:**
  - **Physical Warehouse Remaining:** **250.000 kg** valued at **Rp 21,504,000.00**.
  - **Delivered Awaiting Invoice:** **250.000 kg** valued at **Rp 21,504,000.00**.
  - **Total Batch Value:** **Rp 43,008,000.00** (neither quantity is double-counted).

### 2.2 Batch `DFS/126010053` (Diclofenac Sodium BP, Supplier: PT. Kairos Tritunggal, PI: 017/KTT/IX/2026)

- **Import Intake Quantity:** 275.000 kg @ landed cost Rp 176,750.00/kg = Total Landed Cost Rp 48,606,250.00.
- **Invoiced Sales:** 175.000 kg invoiced under `SAPJ-26-060` (COGS Rp 30,931,250.00).
- **Approved Delivery Challan:** `DO-26-0079` approved on 2026-11-05 for 100.000 kg to _PT Ciubros Farma_.
- **`batches.current_stock`:** **0.000 kg** (warehouse inventory register was fully relieved).
- **Correct Classification:**
  - **Physical Warehouse Remaining:** **0.000 kg**.
  - **Delivered Awaiting Invoice:** **100.000 kg** valued at **Rp 17,675,000.00**.
  - **Invoiced & Recognized COGS:** **175.000 kg** valued at **Rp 30,931,250.00**.

---

## 3. Recalculated Active Inventory Position

The active inventory position is reconciled into two separate, non-overlapping schedules:

### 3.1 Schedule of 18 Positive Current-Stock Warehouse Batches (3,445.000 kg / Rp 1,180,489,520.95)

```
+----+--------------------------------------+---------------------+---------------------------------------+-----------+---------------+----------------------+------------------+
| #  | Batch UUID                           | Batch Number        | Product Description                   | Stock(kg) | Landed Cost/kg| Total Valuation (IDR)| Source PI Number |
+----+--------------------------------------+---------------------+---------------------------------------+-----------+---------------+----------------------+------------------+
| 1  | ce7c978e-b603-4678-8994-d8e3c49c0112 | K007.2/25/07/335    | Minoxidil EP                          |    50.000 | Rp  1,286,784 | Rp     64,339,189.00 | E0000220/2526    |
| 2  | c1983658-809f-4448-ad77-4e24b8835f87 | PRAH0640725         | Piroxicam USP                         |   100.000 | Rp    717,841 | Rp     71,784,103.00 | E0000220/2526    |
| 3  | aaf5b1aa-e6d9-4431-a577-c75724e4b333 | 25CTH027            | Cetirizine Hydrochloride EP           |    75.000 | Rp    591,467 | Rp     44,359,996.50 | E0000220/2526    |
| 4  | 3f33b652-59ec-4fbb-91a5-0cc01f2a0266 | 1699/2025           | Corn Starch BP                        |    25.000 | Rp      9,872 | Rp        246,811.75 | E0000221/2526    |
| 5  | c20fe01a-fbe3-43ba-93cc-0a2175fee19a | 4001/1101/25/A-3146 | Ibuprofen BP                          |    50.000 | Rp    163,451 | Rp      8,172,562.00 | E0000220/2526    |
| 6  | f0e303fd-2227-416f-a323-7903275dd962 | MLAH0260425         | Meloxicam USP                         |    50.000 | Rp  1,240,604 | Rp     62,030,211.50 | E0000274/2526    |
| 7  | fb21c9df-d884-4704-881d-b6554fc980bd | BCYPH/2510070       | Cyproheptadine Hydrochloride USP       |    20.000 | Rp  1,205,192 | Rp     24,103,846.20 | E0000332/2526    |
| 8  | 6e0aa6a6-9f02-4fcd-a65e-b9eedcfd3d92 | DFK/125090136       | Diclofenac Potassium                  |   125.000 | Rp    141,427 | Rp     17,678,420.00 | E0000332/2526    |
| 9  | b31b8023-a57c-4b2d-96e7-ca271de72140 | BDOM/2509043        | Domperidone BP                        |   200.000 | Rp    618,745 | Rp    123,748,942.00 | E0000332/2526    |
| 10 | b9a3e457-4faa-4a89-882c-018071e2460b | 17721025            | Sulfamethoxazole USP                  |   750.000 | Rp    197,352 | Rp    148,014,277.50 | E0000332/2526    |
| 11 | 2ee69e79-6213-4f79-abe1-a65f888de3d6 | 17731025            | Sulfamethoxazole USP                  | 1,000.000 | Rp    197,352 | Rp    197,352,370.00 | E0000332/2526    |
| 12 | c2d12c8e-ff67-485d-969d-3139a0a8433f | TMP02260001         | Trimethoprim USP                      |   400.000 | Rp    372,437 | Rp    148,974,688.00 | E0000332/2526    |
| 13 | c6006905-45c4-40bf-bc49-05c86e6e1ad0 | M1CFX10003725N      | Cefixime Trihydrate Powder Micronized |   100.000 | Rp  1,936,127 | Rp    193,612,699.00 | E0000332/2526    |
| 14 | 30293586-9382-4eeb-8c4d-67a84a70325f | B109/2026           | Corn Starch BP                        |    25.000 | Rp      9,817 | Rp        245,420.50 | E0000387/2526    |
| 15 | fbe27e70-5828-4a2d-a1d7-a8b5394328eb | B108/2026           | Corn Starch BP                        |   100.000 | Rp      9,817 | Rp        981,682.00 | E0000387/2526    |
| 16 | 7ce1c54b-3ca2-4538-a270-fbe95b807ba6 | 26CTH018            | Cetirizine Hydrochloride EP           |    50.000 | Rp    592,250 | Rp     29,612,513.00 | E0000085/2627    |
| 17 | 4b8e1118-e3ba-455a-a769-1e3454fe62d9 | LHAH0741025         | Lidocaine HCL USP                     |    75.000 | Rp    316,371 | Rp     23,727,789.00 | E0000085/2627    |
| 18 | d12fe2ad-bff6-4730-826c-c226bef78765 | 2610712             | Paracetamol USP (Warehouse Portion)   |   250.000 | Rp     86,016 | Rp     21,504,000.00 | 80103232         |
+----+--------------------------------------+---------------------+---------------------------------------+-----------+---------------+----------------------+------------------+
|    | TOTAL PHYSICAL WAREHOUSE STOCK (18)  |                     |                                       | 3,445.000 |               | Rp 1,180,489,520.95  |                  |
+----+--------------------------------------+---------------------+---------------------------------------+-----------+---------------+----------------------+------------------+
```

### 3.2 Schedule of Delivered Stock Awaiting Sales Invoicing (350.000 kg / Rp 39,179,000.00)

```
+----+--------------------------------------+---------------------+---------------------------------------+-----------+---------------+----------------------+------------------+
| #  | Batch UUID                           | Batch Number        | Delivery Challan Ref & Customer       | Qty (kg)  | Landed Cost/kg| Delivered Value (IDR)| Source PI Number |
+----+--------------------------------------+---------------------+---------------------------------------+-----------+---------------+----------------------+------------------+
| 1  | 2813a5b3-cf62-41a4-ab6c-57207bade236 | DFS/126010053       | DO-26-0079 (PT Ciubros Farma)         |   100.000 | Rp    176,750 | Rp     17,675,000.00 | 017/KTT/IX/2026  |
| 2  | d12fe2ad-bff6-4730-826c-c226bef78765 | 2610712             | DO-26-0080 (PT Ciubros Farma)         |   250.000 | Rp     86,016 | Rp     21,504,000.00 | 80103232         |
+----+--------------------------------------+---------------------+---------------------------------------+-----------+---------------+----------------------+------------------+
|    | TOTAL DELIVERED AWAITING INVOICE (2) |                     |                                       |   350.000 |               | Rp     39,179,000.00 |                  |
+----+--------------------------------------+---------------------+---------------------------------------+-----------+---------------+----------------------+------------------+
```

$$\mathbf{Combined\ Active\ Position} = 3,445.000\text{ kg} + 350.000\text{ kg} = \mathbf{3,795.000\text{ kg}}$$
$$\mathbf{Combined\ Active\ Valuation} = \text{Rp } 1,180,489,520.95 + \text{Rp } 39,179,000.00 = \mathbf{Rp\ 1,219,668,520.95}$$

---

## 4. Unresolved Batch Quantity Mismatch: PI `E0000244/2627` Item 17

A forensic cross-check of Purchase Invoice `E0000244/2627` confirms the exact technical mismatch between the invoice line items and the batch master:

1. **Purchase Invoice Data:**
   - Supplier: _Santosh Limited_ (Invoice `E0000244/2627`, Date: 2026-10-14).
   - Commercial Lines: **19 distinct items** totaling **17,124.890 kg** and **$97,229.13 USD**.
   - Currency & Exchange Rate: USD @ fixed customs rate **Rp 18,105.00**.
   - GL Capitalization: Debited to GL 1130 under Journal Entry `JE-2610-0005` for **Rp 1,760,333,398.65**.
2. **Item 17 Specifics:**
   - Product: Domperidone Maleate BP (ID: `c3bfa9da-f0b1-4ea8-b53e-dd862da252a3`).
   - Line Quantity: **24.890 kg** @ $42.03/kg = **$1,046.13 USD** = **Rp 18,940,183.65**.
   - Batch Reference: Points to Batch UUID `34d352ef-26a9-482f-81a4-b83f11ad6a7d` (`BDM/2609056`).
3. **Batch Master Discrepancy:**
   - In `public.batches`, batch `BDM/2609056` was registered with `import_quantity = 225.000` (initialized solely from Line Item 4).
   - The 24.890 kg from Line Item 17 was never added into `batches.import_quantity`.
   - Consequently, the batch table contains only 18 batches totaling **17,100.000 kg** valued at **Rp 1,741,393,215.00**.
4. **Audit Status:**
   - PI Quantity: **17,124.890 kg**
   - Batch Master Quantity: **17,100.000 kg**
   - **Quantity Difference:** **24.890 kg** (commercially rounded to 25 kg)
   - **Financial Value:** **Rp 18,940,183.65** (fully capitalized in GL 1130 via `JE-2610-0005`).
   - In accordance with read-only instructions, no data modification has been performed. This item is formally logged as **Open Item 1**.

---

## 5. GL 5100 Gross Activity Disclosure

The General Ledger Account 5100 (Cost of Goods Sold) reflects all posted, non-reversed accounting entries across the entire ledger history:

### 5.1 Reconstructed GL 5100 Ledger Activity by Source Module

```
+----+---------------------------------------+----------+---------------------+-------------------+---------------------+
| #  | Source Module                         | JE Count | Gross Debits (IDR)  | Gross Credits(IDR)| Net Balance (IDR)   |
+----+---------------------------------------+----------+---------------------+-------------------+---------------------+
| 1  | sales_invoice_cogs                    |    85    | Rp 6,726,508,942.92 | Rp           0.00 | Rp 6,726,508,942.92 |
| 2  | sales_invoice_cogs_adjustment         |   595    | Rp   410,322,250.75 | Rp 378,129,923.23 | Rp    32,192,327.52 |
| 3  | historical_cogs_correction            |     6    | Rp   171,551,283.33 | Rp           0.00 | Rp   171,551,283.33 |
| 4  | historical_cogs_final_correction      |    39    | Rp   169,763,905.65 | Rp           0.00 | Rp   169,763,905.65 |
| 5  | historical_cogs_final_correction_fix  |    17    | Rp             0.00 | Rp  55,523,893.00 | -Rp   55,523,893.00 |
| 6  | historical_cogs_correction_reversal   |     1    | Rp             0.00 | Rp  66,509,316.00 | -Rp   66,509,316.00 |
| 7  | credit_note_cogs                      |     1    | Rp             0.00 | Rp   1,227,102.50 | -Rp    1,227,102.50 |
+----+---------------------------------------+----------+---------------------+-------------------+---------------------+
|    | TOTAL POSTED NON-REVERSED GL 5100     |   744    | Rp 7,478,146,382.65 | Rp 501,390,234.73 | Rp 6,976,756,147.92 |
+----+---------------------------------------+----------+---------------------+-------------------+---------------------+
```

### 5.2 Subledger Snapshot vs. General Ledger Gross Distinction

- **Subledger Line Snapshots:** Sum of `sii.cogs_total_cost` across 85 issued sales invoices = **Rp 6,977,983,250.42**.
- **Credit Note COGS Relief:** Credit Note `CN-26-0001` restores stock valued at **Rp 1,227,102.50**.
- **Net Invoiced Subledger COGS:** $\text{Rp } 6,977,983,250.42 - \text{Rp } 1,227,102.50 = \mathbf{Rp\ 6,976,756,147.92}$.
- **GL 5100 Net Balance:** **Rp 6,976,756,147.92**.
- **Variance:** **Rp 0.00**.
- **Display Rounding Difference:** The sub-cent difference between 2-decimal rounded unit landed cost display and full-precision cost layer evaluation totals **Rp 95.03** across 94 invoice lines.

---

## 6. GL 1130 Closing Valuation Bridge & The Rp 70,287,363.39 Variance

### 6.1 General Ledger 1130 Balance Bridge

The live General Ledger Account 1130 has:

- **Total Posted Debits:** Rp 15,971,416,535.71
- **Total Posted Credits:** Rp 11,588,949,479.50
- **Net Ending Debit Balance:** **Rp 4,382,467,056.21**

```
+---------------------------------------------------------------------------------------------------+
| GL 1130 MATHEMATICAL RECONCILIATION BRIDGE (AS OF 16 NOVEMBER 2026)                               |
+-------------------------------------------------------------+---------------------+---------------+
| Transaction Stream                                          | Amount (IDR)        | Reference     |
+-------------------------------------------------------------+---------------------+---------------+
| 1. Historical Inbound Capitalization debited to GL 1130:    |                     |               |
|    - Approved Purchase Invoices (Genesis to Oct 2026)       | Rp 7,210,088,667.50 | 25 PI Journals|
|    - Foreign Currency Adjustments (JE2609-0050 to 0053)     | Rp   696,516,504.00 | 4 USD PI fixes|
|    - Capitalized Import Freight, Broker & PIB Expenses      | Rp   218,899,709.00 | 11 Expense JEs|
|    - Customs & Duty Post-Clearance Adjustments              | Rp       632,424.98 | 1 Duty JE     |
|    -------------------------------------------------------- | ------------------- | ------------- |
|    SUB-TOTAL HISTORICAL INBOUND CAPITALIZATION              | Rp 8,126,137,305.48 | Ledger debits |
|                                                             |                     |               |
| 2. Less: Net Outbound COGS Relief credited from GL 1130:    |                     |               |
|    - Net COGS Relief (85 Sales Invoices & Credit Note)      | -Rp6,976,756,147.92 | Cent-perfect  |
|    -------------------------------------------------------- | ------------------- | ------------- |
|    SUB-TOTAL NET HISTORICAL INVENTORY IN GL 1130 (1 - 2)    | Rp 1,149,381,157.56 | GL Residual   |
|                                                             |                     |               |
| 3. Plus: November 2026 In-Transit Import Shipments:         |                     |               |
|    - HM000004/2627 (Paracetamol China, 17,000 kg)           | Rp 1,373,175,000.00 | JE-2609-0004  |
|    - E0000243/2627 (Corn Starch Nov26, 10,000 kg)           | Rp    99,577,500.00 | JE-2610-0004  |
|    - E0000244/2627 (Mix Container Nov26, 17,125 kg)         | Rp 1,760,333,398.65 | JE-2610-0005  |
|    -------------------------------------------------------- | ------------------- | ------------- |
|    SUB-TOTAL IN-TRANSIT CAPITALIZED DEBITS                  | Rp 3,233,085,898.65 | 3 Import PIs  |
+-------------------------------------------------------------+---------------------+---------------+
| CALCULATED CLOSING LEDGER BALANCE (Line 2 + Line 3)         | Rp 4,382,467,056.21 | ZERO PLUG     |
| ACTUAL GENERAL LEDGER 1130 NET BALANCE                      | Rp 4,382,467,056.21 | EXACT MATCH   |
+-------------------------------------------------------------+---------------------+---------------+
| VARIANCE TO POSTED GL 1130 LEDGER                           | Rp             0.00 | PERFECT MATCH |
+-------------------------------------------------------------+---------------------+---------------+
```

### 6.2 Forensic Analysis of the Rp 70,287,363.39 Active Inventory Valuation Gap

Comparing the **Active Subledger Inventory Valuation** against the **GL 1130 Historical Inventory Residual** reveals an open reconciliation difference:

$$\text{Active Subledger Inventory Valuation} = \mathbf{\text{Rp } 1,219,668,520.95}$$
$$\text{GL 1130 Historical Inventory Residual} = \mathbf{\text{Rp } 1,149,381,157.56}$$
$$\mathbf{Valuation\ Difference} = \text{Rp } 1,219,668,520.95 - \text{Rp } 1,149,381,157.56 = \mathbf{+Rp\ 70,287,363.39}$$

#### Forensic Decomposition:

1. **Mathematical Identity:**
   - Total Batch Landed Cost in Master (61 historical batches): **Rp 8,196,424,763.90**
   - Total Historical Inbound Capitalized to GL 1130: **Rp 8,126,137,305.48**
   - Initial Inbound Capitalization Variance: $\text{Rp } 8,196,424,763.90 - \text{Rp } 8,126,137,305.48 = \mathbf{Rp\ 70,287,458.42}$
   - Less: COGS Display Rounding Residual: $\mathbf{Rp\ 95.03}$
   - **Net Active Inventory Valuation Difference:** $\mathbf{Rp\ 70,287,363.39}$.

2. **Root Cause:**
   The `batches` table was populated using landed cost markups per kilogram (allocating ocean freight, clearing agents, import duty, and PIB taxes directly into unit costs). However, in the General Ledger:
   - Direct purchase invoice debits and capitalized expenses totaled Rp 8,126,137,305.48.
   - Certain freight and duty expenses were either posted to operating expense accounts (6xxx) rather than capitalized into GL 1130, or landed cost markups were estimated in batch records without matching GL journal postings.
   - As instructed, this difference is **not labeled as a resolved historical accrual**, but is formally classified as an **Open Valuation Reconciliation Difference** pending management decision.

---

## 7. Formal Open Items Register

| Item ID     | Description                                               | Quantities / Amount                                                                | Root Cause / Source Records                                                                                                                           | Recommended Accounting Action                                                                                                                       |
| :---------- | :-------------------------------------------------------- | :--------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OPEN-01** | PI `E0000244/2627` Item 17 Batch Quantity Mismatch        | **24.890 kg** / **Rp 18,940,183.65**                                               | PI item 17 Domperidone BP was omitted from `batches.import_quantity` during batch creation, while GL 1130 capitalized full amount via `JE-2610-0005`. | Upon vessel arrival / physical intake, update batch `BDM/2609056` initial quantity or issue supplementary batch record.                             |
| **OPEN-02** | Active Inventory Subledger vs. GL 1130 Valuation Variance | **Rp 70,287,363.39** (Subledger: Rp 1.219bn vs. GL: Rp 1.149bn)                    | Cumulative difference between batch-master estimated landed costs (Rp 8.196bn) and capitalized GL inbound debits (Rp 8.126bn).                        | Finance management review: Determine whether to post a landed cost accrual to GL 1130 or align batch landed costs with actual capitalized vouchers. |
| **OPEN-03** | Approved Delivery Challans Awaiting Sales Invoicing       | **350.000 kg** / **Rp 39,179,000.00** (`DO-26-0079`: 100 kg, `DO-26-0080`: 250 kg) | Goods physically delivered to _PT Ciubros Farma_ on 2026-11-05 and 2026-11-06 awaiting routine billing cycle.                                         | Generate sales invoices in Billing module for `DO-26-0079` and `DO-26-0080` to post revenue, relieve inventory, and recognize COGS.                 |

---

## 8. Audit Verdict & Sign-Off Attestation

> [!IMPORTANT]
> **AUDIT VERDICT: PROVISIONALLY RECONCILED WITH EXPLICIT OPEN ITEMS**
>
> 1. Three-way COGS equilibrium holds cent-perfect at **Rp 6,976,756,147.92** (Subledger Invoiced COGS == GL 5100 == GL 1130 Relief Credits).
> 2. The General Ledger 1130 closing net debit balance of **Rp 4,382,467,056.21** is bridged with zero plugs.
> 3. Active inventory quantities and valuations are segregated into Physical Warehouse Stock (3,445 kg / Rp 1,180,489,520.95) and Delivered Stock Awaiting Invoice (350 kg / Rp 39,179,000.00).
> 4. In accordance with professional auditing standards, unconditional sign-off is withheld until management formally decides on the treatment of **OPEN-01** (24.890 kg) and **OPEN-02** (Rp 70,287,363.39).
> 5. **Strict Protections Attestation:** Zero live production data was modified, inserted, updated, or deleted during this investigation.
