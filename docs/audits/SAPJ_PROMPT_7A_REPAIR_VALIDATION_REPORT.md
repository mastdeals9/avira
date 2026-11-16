# SAPJ ERP — Prompt 7A Accounting Repair Validation, Source Reconciliation & Owner Approval Pack

**Target Environment:** Local Project `/Users/Kunal/Documents/anzen-main`  
**Production Supabase Database:** `dkrtsqienlhpouohmfki` (AWS ap-southeast-1)  
**Safety Protocol:** Strict Read-Only (`SET default_transaction_read_only = on`)  
**Git Baseline:** Commit `76e7007e335d5c2f8f53605c21a322704a236b61` on branch `main`  
**Production Modification Status:** **ZERO PRODUCTION REPAIRS EXECUTED**  
**Purpose:** Comprehensive forensic validation of Prompt 7 accounting findings, source-level reconciliation of all financial variances, resolution of reporting conflicts, and delivery of an evidenced approval pack for owner authorization.

---

## 1. Executive Summary & Git Protection Invariants

In strict adherence to instructions:
- Production Supabase was accessed **exclusively in READ-ONLY mode**.
- **No INSERT, UPDATE, DELETE, DDL, or modifying RPCs were executed against production.**
- No financial vouchers, journal entries, or account mappings were altered to force balances.
- Git working tree state was preserved intact with zero staging, committing, or pushing:
  - Branch: `main`
  - HEAD: `76e7007e335d5c2f8f53605c21a322704a236b61`
  - Uncommitted local changes remain safely preserved in the working directory.

This audit validates all 5 accounting pillars, resolves two conflicting figures in previous audit notes, traces all 326 lines of the AP control variance, uncovers the exact commercial origin of the FATMAWATI incoming bank credit, validates the draft status of BPJS, and delivers a complete owner approval pack.

---

## 2. Prompt 7 Application Code Verification

A comprehensive review of the modified application components was conducted:

### A. `BankReconciliationEnhanced.tsx`
- **Dynamic Book Balance:** Replaced static today's date (`new Date()`) with the selected period date (`dateRange.end || financeDateRange.endDate`), ensuring that bank reconciliation balances correctly evaluate against historical periods rather than today's live movement.
- **Exclusion of Non-Bank Payment Vouchers:** Filtered out `payment_method = 'advance_adjustment'` AND `payment_method = 'cash'`, preventing cash disbursements and salary advance offsets from polluting the bank statement matching drawer.
- **Safety Invariant:** Read-only calculation; does not alter database bank statement lines or voucher records.

### B. `PettyCashManager.tsx`
- **Cash Payment Voucher Inclusion:** Queries `payment_vouchers` where `payment_method = 'cash'` and `is_posted = true` within the date range, mapping them as operational cash disbursements (`cashPvActivity`).
- **GL Balance Binding:** Evaluates posted GL balance via `get_petty_cash_balance` (GL Account 1102, Rp 3,941,428.00), strictly avoiding inactive Account `1101` (`Cash on Hand`).
- **Deduplication Verification:** Forensically queried `petty_cash_transactions` to confirm that `PV/26-26/017` and `PV/26-26/018` are NOT present in `petty_cash_transactions`. They are loaded exclusively from `payment_vouchers`, ensuring they are counted **exactly once**.

### C. `TaxPeriodsPanel.tsx` & `FakturPajakPanel.tsx`
- **Cancelled Invoice Exclusion:** Added `.neq('document_status', 'cancelled')` and `.is('cancelled_at', null)` to sales invoice queries.
- **Integrity Guarantee:** Valid active invoices remain 100% visible. Cancelled invoice `SAPJ-26-072` (tax Rp 3,225,235.20) is cleanly excluded, bringing the detail drawer sum to **Rp 95,811,474.55**, which agrees with `vw_ppn_net_by_period` and General Ledger Account 2130 to the exact Rupiah.

---

## 3. Resolution of Faktur Pajak Figure Conflicts

### Forensic Query Results
Querying production PostgreSQL directly using exact UUIDs produced the following verified source records:

| Invoice Number | Invoice UUID | Date | Customer | Document Status | Payment Status | Subtotal (Rp) | Tax / PPN (Rp) | Total (Rp) | Faktur Pajak # | Linked Journal Entry |
| :--- | :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **SAPJ-005** | `5d602dbd-0b0d-4c73-ad43-2fc979903032` | 2025-11-28 | PT. Anugrah Visi Bersama | `posted` | `paid` | 311,916,000.00 | **34,310,760.00** | 346,226,760.00 | `NULL` | `JE2601-0001` (Posted) |
| **SAPJ-26-075** | `9506c244-db21-4ac3-a4df-a5fab352127f` | 2026-11-02 | Triman | `posted` | `pending` | 240,625.00 | **26,468.75** | 267,093.75 | `NULL` | `JE2611-0316` (Posted) |
| **SAPJ-26-072** | `9878345f-b286-4a0e-83fe-de487c95e94f` | 2026-10-26 | PT. Rania Kalani Indonesia | `cancelled` | `pending` | 29,320,320.00 | **3,225,235.20** | 32,555,555.20 | `NULL` | `JE2610-0187` (Posted) |

### Explanation of Discrepancy Between Prior Audit Reports
In `SAPJ_ACCOUNTING_INTEGRITY_REMEDIATION_REPORT.md` (lines 159–160), the audit text stated:
> *1. SAPJ-26-075 (2026-11-03): Tax Amount Rp 34,310,760.00*  
> *2. SAPJ-005 (2025-07-13): Tax Amount Rp 35,463,733.00*

**Root Cause of the Prior Error:**
1. The figure **Rp 34,310,760.00** actually belongs to **SAPJ-005** (PT. Anugrah Visi Bersama, dated 2025-11-28), but was erroneously transcribed onto `SAPJ-26-075`.
2. `SAPJ-26-075` is a small invoice to customer Triman with tax of **Rp 26,468.75** (Total Rp 267,093.75).
3. The figure `Rp 35,463,733.00` and date `2025-07-13` do not exist anywhere in `public.sales_invoices`. They were an accidental transcription error in the earlier text summary.
4. Across the entire production database, there are **exactly three invoices** with `tax_amount > 0` and missing `faktur_pajak_number`: `SAPJ-005` (Rp 34.3M), `SAPJ-26-072` (Rp 3.2M, cancelled), and `SAPJ-26-075` (Rp 26.5k).

---

## 4. Complete Classification of the 326 AP Lines (Variance: Rp 26,917,200)

The 326 journal lines on AP Control Account `2110` without `supplier_id` were traced to their underlying source documents. 

### Key Forensic Insight
**Zero of the 326 lines are trade supplier transactions.** None of the source expenses carry a `supplier_id`. Instead, Trade AP (`2110`) was used as a generic credit sink for operating expenses, employee payroll, and government customs.

### Classification Summary

```
+-------------------------------------------------------------------------------------------------------------------------+
|                                    AP CONTROL ACCOUNT 2110 CLASSIFICATION (326 LINES)                                   |
+------------------------------------------+------------+--------------------+--------------------+-----------------------+
| Category                                 | Line Count | Total Debit (Rp)   | Total Credit (Rp)  | Net Balance (Rp)      |
+------------------------------------------+------------+--------------------+--------------------+-----------------------+
| 1. Confirmed supplier AP                 |          0 |               0.00 |               0.00 |                  0.00 |
| 2. Non-supplier operating expense        |        275 |     572,831,829.98 |     354,029,454.00 |       -218,802,375.98 |
| 3. Employee/staff liability              |         48 |       4,400,000.00 |      92,799,433.00 |        +88,399,433.00 |
| 4. Customs/import liability              |          2 |               0.00 |     156,170,142.98 |       +156,170,142.98 |
| 5. Historical repair or adjustment       |          1 |               0.00 |       1,150,000.00 |         +1,150,000.00 |
| 6. Unknown — decision required           |          0 |               0.00 |               0.00 |                  0.00 |
+------------------------------------------+------------+--------------------+--------------------+-----------------------+
| TOTAL                                    |        326 |     577,231,829.98 |     604,149,029.98 |     +Rp 26,917,200.00 |
+------------------------------------------+------------+--------------------+--------------------+-----------------------+
```

### Exact Algebraic Proof:
$$\text{Net Variance} = (-218,802,375.98) + 88,399,433.00 + 156,170,142.98 + 1,150,000.00 = +\text{Rp } 26,917,200.00$$

- Full transaction-level register with entry numbers, dates, references, descriptions, and recommended accounting reclassifications is documented in [SAPJ_PROMPT_7A_AP_APPROVAL_REGISTER.md](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_7A_AP_APPROVAL_REGISTER.md).

---

## 5. Bank Reconciliation Exceptions Forensic Validation

### 1. REC-001: Bizpark Labour (`16a51755-cc15-4315-b1ac-79d54d0b8a96`, Rp 4,000,000.00)
- **Finding:** Statement line reads `TRSF E-BANKING DB 3010/FTSCY/WS95051 4000000.00 Bizpark Labour payment MARTUA ALOYSIUS GI`.
- **Linked Expense:** `EXP/26/369` (`7970635d-d48e-4a9f-82e0-ba4aefde0532`), approved, amount Rp 4,000,000.00.
- **Root Cause:** The expense was created from the bank line, but no payment settlement journal (`source_module = 'expense_payment'`) was ever posted. GL Account 111101 was never credited.
- **Canonical Settlement Required:** Post expense payment journal (Dr 2110 / Cr 111101 Rp 4,000,000), insert record into `bank_statement_allocations`, and update line status to `matched`.

### 2. REC-002: Sandi Salary Advance Voucher `PV/26-26/028` (Rp 100,000.00)
- **Finding:** Voucher `8a045a25-e2b4-4f7b-8a27-4312d86a547e` dated 2026-10-22 for Sandi Prasetyo (`staff_id: 276dc2e0-3cb2-426f-aee7-a9991e5f4cfc`).
- **Journal:** Posted via `JE2610-0112` (Dr 2110 Rp 100,000 / Cr 111101 Rp 100,000).
- **Status:** Genuinely uncleared. Credited GL bank on Oct 22, but did not clear BCA bank statements in October.
- **October Rp 3,900,000 Variance Decomposition:**
  $$\text{October Discrepancy} = \text{Unposted Bizpark Bank Debit (+Rp 4,000,000)} - \text{Uncleared Sandi Voucher (-Rp 100,000)} = +\text{Rp } 3,900,000.00$$

### 3. REC-004: Large Cash Withdrawal (`4b945b86-ffda-4e32-b6f3-e0972eb214e7`, Rp 1,012,989,126.00)
- **Finding:** Bank debit on 2026-11-04 with description `TARIKAN TUNAI 0516992-0`.
- **System Search:** Zero matching vouchers, fund transfers, expenses, or petty cash entries exist in the entire ERP.
- **Action:** Marked **NEEDS DOCUMENTATION**. Strict accounting governance prohibits fabricating a journal without physical bank counter withdrawal slips and board authorization.

### 4. REC-005: FATMAWATI Scaffolding Security Deposit Refund (`172c1d65-bbc7-4c5a-929a-0480f5885a49`, Rp 500,000.00)
- **Breakthrough Finding:** A system-wide search for "FATMAWATI" uncovered expense `EXP/26/260` (`85b8b607-00f8-4ec4-be3a-46f08addd70e`), which paid Rp 1,400,000 for scaffolding rental and explicitly stated:
  > *"security deposit Rp 500.000 (Refund after done)"*
- **Conclusion:** The incoming bank credit of Rp 500,000 on 2026-11-08 is the **scaffolding rental security deposit refund** returned by FATMAWATI upon demobilization.
- **Action:** Ready for Receipt Voucher posting crediting scaffolding expense `6150` / other income, and matching the statement line.

---

## 6. Accounting Pillars Integrity Validation

1. **AP Control vs Subledger:** Confirmed exact Rp 26,917,200.00 difference across 326 lines (0 trade supplier lines, 275 operating expense lines, 48 payroll lines, 2 customs lines, 1 repair line).
2. **Petty Cash Box:** Confirmed Account 1102 GL balance is exactly **Rp 3,941,428.00**. Cash payment vouchers `PV/26-26/017` (Rp 500) and `018` (Rp 499,500) are counted exactly once in operational tracking. Inactive Account `1101` is strictly excluded.
3. **PPN Output:** October PPN net output in GL Account 2130 is **Rp 95,811,474.55**. Cancelled invoice `SAPJ-26-072` (tax Rp 3,225,235.20) is excluded from reporting.
4. **PPh Withholding:** PPh 21 Payable is Rp 702,499.00 (with Rp 1 rounding overpayment in September). PPh 23 Payable is Rp 15,000.00. Prepaid PPh 22 is Rp 194,669,147.00 (retained as asset pending annual tax return).
5. **BPJS Register:** October 2026 register (`46a472ab-c5ec-4d25-a102-86286736cfb2`) confirmed in `status = 'draft'`, `payment_status = 'unpaid'`, and `reconciliation_status = 'unreconciled'`. Employee deduction (Rp 246,000) is posted in GL Account 2134; employer expense (Rp 521,520) remains unposted until approved.

---

## 7. Finance Master Verification Report Validation

The view `public.finance_master_verification_report` check `Journal ≠ Export COA` reported 162 failures.

### Technical Analysis
- The check's lateral subquery ordered by `je.posted_at DESC LIMIT 1`.
- When an expense was settled via bank transfer, the settlement journal (Dr AP 2110 / Cr Bank 111101) was selected instead of the expense recognition journal (Dr Expense 6xxx / Cr AP 2110).
- Because `ex.coa_code` (Expense 6xxx) differed from `journal.code` (AP 2110), it falsely reported 162 mismatches.
- **Proof:** Correcting the lateral subquery to filter `je.source_module IN ('expenses', 'expense')` drops the failure count from 162 to **0 (PASS)**, while preserving genuine account mismatch detection.
- Proposed SQL view replacement is prepared in [SAPJ_PROMPT_7A_PROPOSED_SQL_REPAIRS.sql](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_7A_PROPOSED_SQL_REPAIRS.sql).

---

## 8. Final Independent Technical Verification

All test suites and verification commands were executed freshly in the local environment:

| Verification Command | Purpose | Result | Duration |
| :--- | :--- | :---: | :---: |
| `node --test tests/accounting-integrity-and-reconciliation.test.mjs` | Accounting integrity, PPN exclusions, petty cash GL binding | **12 / 12 Passed** | 120 ms |
| `node --test tests/crm-functional-and-recipient-deduplication.test.mjs` | CRM deduplication & switchboard safety | **17 / 17 Passed** | 177 ms |
| `node --test tests/canonical-phone-and-campaign-safety.test.mjs tests/sidebar-and-mobile-navigation-regression.test.mjs` | Phone parser & navigation | **51 / 51 Passed** | 363 ms |
| `node --test tests/edge-functions-auth.test.mjs tests/security-findings-verification.test.mjs` | Edge function JWT auth & security guards | **8 / 8 Passed** | 105 ms |
| `node --test tests/html-sanitization-and-quill-safety.test.mjs tests/pdf-excel-dependency-compatibility.test.mjs tests/xlsx-security-and-functional.test.mjs` | DOMPurify, SheetJS 0.20.3, jsPDF 4.2.1 | **21 / 21 Passed** | 705 ms |
| `npm run typecheck` (`tsc --noEmit`) | TypeScript type safety | **0 Errors** | 8 s |
| `npm run build` | Full production Vite build | **Built in 22.42s** | 22 s |

---

## 9. Deliverables Manifest

1. [SAPJ_PROMPT_7A_REPAIR_VALIDATION_REPORT.md](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_7A_REPAIR_VALIDATION_REPORT.md) — This authoritative validation report.
2. [SAPJ_PROMPT_7A_AP_APPROVAL_REGISTER.md](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_7A_AP_APPROVAL_REGISTER.md) — Individual classification of all 326 AP lines with source document mapping.
3. [SAPJ_PROMPT_7A_OWNER_APPROVAL_MATRIX.md](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_7A_OWNER_APPROVAL_MATRIX.md) — Comprehensive owner decision matrix with risk levels, preconditions, before/after queries, and rollback steps.
4. [SAPJ_PROMPT_7A_PROPOSED_SQL_REPAIRS.sql](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_7A_PROPOSED_SQL_REPAIRS.sql) — Transactional SQL repair scripts clearly marked **NOT EXECUTED — OWNER APPROVAL REQUIRED**.

