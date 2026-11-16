# SAPJ ERP — Prompt 7A Owner Approval Matrix: Accounting Repairs & Database Rectification

**Target Environment:** Local Project `/Users/Kunal/Documents/anzen-main`  
**Production Supabase:** `dkrtsqienlhpouohmfki` (AWS ap-southeast-1)  
**Safety Protocol:** Strict Read-Only (`SET default_transaction_read_only = on`)  
**Production Modification Status:** **ZERO PRODUCTION REPAIRS EXECUTED**  
**Approval Gate:** No SQL or RPC in this matrix may be executed without explicit sign-off from the business owner and finance lead.

---

## 1. Master Repair Approval Summary Table

| Repair ID | Component / Table | Primary Record / Identifier | Affected Amount | Description / Core Defect | Risk Level | Status |
| :---: | :--- | :--- | :---: | :--- | :---: | :---: |
| **REP-001** | `bank_statement_lines` / `finance_expenses` | `16a51755-cc15-4315-b1ac-79d54d0b8a96` (`EXP/26/369`) | Rp 4,000,000.00 | Bizpark labour payment line unmatched; expense payment journal unposted | Low | **READY FOR APPROVAL** |
| **REP-002** | `payment_vouchers` | `8a045a25-e2b4-4f7b-8a27-4312d86a547e` (`PV/26-26/028`) | Rp 100,000.00 | Uncleared salary advance voucher for Sandi Prasetyo flagged with `party_type = 'supplier'` | Low | **READY FOR APPROVAL** |
| **REP-003** | `bank_accounts` | `bfe79829-07d1-48ed-8965-ff9d367d758e` (BCA IDR) | Rp 581,000.00 | Cached `current_balance` column out of sync with live GL Account 111101 balance | Low | **READY FOR APPROVAL** |
| **REP-004** | `bank_statement_lines` | `4b945b86-ffda-4e32-b6f3-e0972eb214e7` (2026-11-04) | Rp 1,012,989,126.00 | Unmatched cash withdrawal (`TARIKAN TUNAI`) without internal treasury record | High | **NEEDS DOCUMENTATION** |
| **REP-005** | `bank_statement_lines` / `finance_expenses` | `172c1d65-bbc7-4c5a-929a-0480f5885a49` (`EXP/26/260`) | Rp 500,000.00 | Incoming bank credit: refund of scaffolding rental security deposit from FATMAWATI | Low | **READY FOR APPROVAL** |
| **REP-006** | `journal_entry_lines` / `chart_of_accounts` | 326 lines on Account `2110` with `supplier_id IS NULL` | Rp 26,917,200.00 | Operating expenses, staff payroll, and customs posted to Trade AP instead of 2120/2140 | Medium | **ACCOUNTANT DECISION** |
| **REP-007** | `finance_expenses` / `payment_vouchers` | `EXP/26/365` (Sandi) & `EXP/26/367` (Imron) | Rp 1,600,000.00 | Multi-part salary settlements (bank transfer + advance deduction); 100% settled | None | **DO NOT CHANGE** |
| **REP-008** | `payment_vouchers` / Database RPC | `PV/26-26/017` & `PV/26-26/018` | Rp 500,000.00 | Cash payment vouchers omitted from date-bounded operational petty cash CTE query | Low | **READY FOR APPROVAL** |
| **REP-009** | `chart_of_accounts` / DB Constraints | `35e08064-a173-4069-9b47-dd985bb98d15` (COA 1101) | N/A | Inactive parent account `1101` lacks DB constraint blocking future journal postings | Low | **READY FOR APPROVAL** |
| **REP-010** | `sales_invoices` | `9878345f-b286-4a0e-83fe-de487c95e94f` (`SAPJ-26-072`) | Rp 3,225,235.20 | Cancelled sales invoice retains `tax_period_id`, leaking into naive PPN period queries | Low | **READY FOR APPROVAL** |
| **REP-011** | `tax_periods` / `journal_entry_lines` | September 2026 PPh 21 Payable | Rp 1.00 | Rp 1 rounding difference between DJP billing slip payment and calculated withholding | Very Low | **ACCOUNTANT DECISION** |
| **REP-012** | `bpjs_monthly_registers` | `46a472ab-c5ec-4d25-a102-86286736cfb2` (Oct-2026) | Rp 767,520.00 | Draft monthly register: employee withholding (246k) posted; employer expense (521k) pending | Medium | **ACCOUNTANT DECISION** |
| **REP-013** | Database View | `public.finance_master_verification_report` | N/A | View CTE picks settlement journals instead of recognition journals, causing 162 false fails | Low | **READY FOR APPROVAL** |

---

## 2. Detailed Technical Repair Specifications

### REP-001: Bizpark Labour Payment Settlement & Bank Matching
- **Repair ID:** `REP-001`
- **Target Table(s):** `public.bank_statement_lines`, `public.bank_statement_allocations`, `public.journal_entries`, `public.journal_entry_lines`
- **Target Record UUID(s):**
  - Statement Line: `16a51755-cc15-4315-b1ac-79d54d0b8a96`
  - Expense: `7970635d-d48e-4a9f-82e0-ba4aefde0532` (`EXP/26/369`)
- **Current Verified Values:**
  - Statement Line: `debit_amount = 4000000.00`, `credit_amount = 0.00`, `reconciliation_status = 'unmatched'`, `matched_expense_id = '7970635d-d48e-4a9f-82e0-ba4aefde0532'`.
  - Expense: `amount = 4000000.00`, `paid_amount = 4000000.00`, `approval_status = 'approved'`, `originating_bank_statement_line_id = '16a51755-cc15-4315-b1ac-79d54d0b8a96'`.
  - Journal Entry: No payment settlement journal exists (`source_module = 'expense_payment'`). GL Account 111101 was never credited.
- **Proposed Correction:**
  1. Post expense payment journal entry:
     - Dr Accounts Payable / Accrued Expense (`2110`/`2120`) Rp 4,000,000.00
     - Cr Bank BCA IDR (`111101`) Rp 4,000,000.00
  2. Create allocation record in `bank_statement_allocations` linking statement line `16a51755` to expense `7970635d`.
  3. Update statement line `16a51755` to `reconciliation_status = 'matched'`.
- **Amount Affected:** Rp 4,000,000.00 (IDR)
- **Reason & Supporting Evidence:** Bank statement line explicitly reads `TRSF E-BANKING DB 3010/FTSCY/WS95051 4000000.00 Bizpark Labour payment MARTUA ALOYSIUS GI`. Expense `EXP/26/369` was approved by management for this exact work. The payment was executed at the bank but the ERP payment journal was not created.
- **Dependencies & Approvals Required:** Finance Director / Owner approval.
- **Expected Financial Impact:** BCA IDR live GL book balance decreases by Rp 4,000,000.00, eliminating the October movement discrepancy. Bank statement line becomes reconciled.
- **Before Verification Query:**
  ```sql
  SELECT reconciliation_status, matched_expense_id FROM public.bank_statement_lines WHERE id = '16a51755-cc15-4315-b1ac-79d54d0b8a96';
  -- Returns: 'unmatched'
  ```
- **After Verification Query:**
  ```sql
  SELECT reconciliation_status, matched_expense_id FROM public.bank_statement_lines WHERE id = '16a51755-cc15-4315-b1ac-79d54d0b8a96';
  -- Returns: 'matched'
  ```
- **Rollback Procedure:** Delete generated payment journal entry and allocation; update statement line status back to `unmatched`.
- **Risk Level:** Low.
- **Status:** **READY FOR APPROVAL**

---

### REP-002: Sandi Salary Advance Uncleared Voucher Categorization
- **Repair ID:** `REP-002`
- **Target Table(s):** `public.payment_vouchers`
- **Target Record UUID(s):** `8a045a25-e2b4-4f7b-8a27-4312d86a547e` (`PV/26-26/028`)
- **Current Verified Values:**
  - `voucher_number = 'PV/26-26/028'`, `voucher_date = '2026-10-22'`, `amount = 100000.00`.
  - `party_type = 'supplier'`, `supplier_id = NULL`, `staff_id = '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc'` (Sandi Prasetyo).
  - `is_posted = true`, `journal_entry_id = '17b4637a-1bf1-4b2c-b3e6-b63ef9ab862f'`.
- **Proposed Correction:**
  - Update `party_type = 'staff'` on `payment_vouchers` for record `8a045a25-e2b4-4f7b-8a27-4312d86a547e`.
  - Retain voucher as an outstanding uncleared bank payment in bank reconciliation.
- **Amount Affected:** Rp 100,000.00 (IDR)
- **Reason & Supporting Evidence:** Description reads: `Sandi Prasetyo (Oct-26) Sandi salary advance Oct 2026`. `staff_id` points to Sandi Prasetyo. The voucher is an employee salary advance, not a trade supplier payment. It was posted to the GL on Oct 22 but did not clear BCA bank statements in October.
- **Dependencies & Approvals Required:** Finance Manager sign-off.
- **Expected Financial Impact:** Resolves subledger party mismatch; preserves the Rp 100,000 uncleared check in bank reconciliation.
- **Before Verification Query:**
  ```sql
  SELECT party_type, staff_id, supplier_id FROM public.payment_vouchers WHERE id = '8a045a25-e2b4-4f7b-8a27-4312d86a547e';
  -- Returns: party_type = 'supplier'
  ```
- **After Verification Query:**
  ```sql
  SELECT party_type, staff_id, supplier_id FROM public.payment_vouchers WHERE id = '8a045a25-e2b4-4f7b-8a27-4312d86a547e';
  -- Returns: party_type = 'staff'
  ```
- **Rollback Procedure:** `UPDATE payment_vouchers SET party_type = 'supplier' WHERE id = '8a045a25-e2b4-4f7b-8a27-4312d86a547e';`
- **Risk Level:** Low.
- **Status:** **READY FOR APPROVAL**

---

### REP-003: BCA IDR Cached Table Balance Refresh
- **Repair ID:** `REP-003`
- **Target Table(s):** `public.bank_accounts`
- **Target Record UUID(s):** `bfe79829-07d1-48ed-8965-ff9d367d758e` (BCA IDR)
- **Current Verified Values:**
  - `current_balance = 328198727.00`
  - Live GL Account 111101 balance = `328779727.00` (Variance: Rp 581,000.00)
- **Proposed Correction:**
  - Update `current_balance` on `bank_accounts` to match live GL book balance: `328779727.00`.
- **Amount Affected:** Rp 581,000.00 (IDR)
- **Reason & Supporting Evidence:** The table column `current_balance` is a denormalized cache that did not update upon posting of recent journal lines. Frontend UI already calculates dynamic book balance via `get_bank_account_balances()`, but the database row cache should be refreshed for external API / dashboard consistency.
- **Dependencies & Approvals Required:** Finance lead approval.
- **Expected Financial Impact:** Aligns bank account record with General Ledger Account 111101.
- **Before Verification Query:**
  ```sql
  SELECT current_balance FROM public.bank_accounts WHERE id = 'bfe79829-07d1-48ed-8965-ff9d367d758e';
  -- Returns: 328198727.00
  ```
- **After Verification Query:**
  ```sql
  SELECT current_balance FROM public.bank_accounts WHERE id = 'bfe79829-07d1-48ed-8965-ff9d367d758e';
  -- Returns: 328779727.00
  ```
- **Rollback Procedure:** Reset `current_balance` to 328198727.00 if needed.
- **Risk Level:** Low.
- **Status:** **READY FOR APPROVAL**

---

### REP-004: Large Cash Withdrawal Documentation
- **Repair ID:** `REP-004`
- **Target Table(s):** `public.bank_statement_lines`
- **Target Record UUID(s):** `4b945b86-ffda-4e32-b6f3-e0972eb214e7` (2026-11-04)
- **Current Verified Values:**
  - `transaction_date = '2026-11-04'` (UTC: 2026-11-03T18:30:00Z)
  - `description = 'TARIKAN TUNAI 0516992-0'`
  - `debit_amount = 1012989126.00`
  - `reconciliation_status = 'unmatched'`
  - Zero internal ERP transactions (vouchers, transfers, expenses) match this amount.
- **Proposed Correction:**
  - **DO NOT MODIFY PRODUCTION DATABASE.**
  - Owner to obtain physical bank withdrawal voucher, bank counter slip, and board authorization explaining the disposition of these funds (e.g. cash placed in safe, cash purchase of assets, director withdrawal, or intercompany transfer).
  - Once documented, create the appropriate Treasury / Journal record and match the statement line.
- **Amount Affected:** Rp 1,012,989,126.00 (IDR)
- **Reason & Supporting Evidence:** Unmatched bank line of over Rp 1 Billion cannot be settled or reconciled with guesswork. Strict accounting governance prohibits fabricating a journal without physical documentation.
- **Dependencies & Approvals Required:** Board of Directors / Owner commercial documentation.
- **Risk Level:** High.
- **Status:** **NEEDS DOCUMENTATION**

---

### REP-005: FATMAWATI Scaffolding Security Deposit Refund
- **Repair ID:** `REP-005`
- **Target Table(s):** `public.bank_statement_lines`, `public.receipt_vouchers`, `public.journal_entries`
- **Target Record UUID(s):**
  - Statement Line: `172c1d65-bbc7-4c5a-929a-0480f5885a49` (2026-11-08)
  - Originating Expense: `85b8b607-00f8-4ec4-be3a-46f08addd70e` (`EXP/26/260`)
- **Current Verified Values:**
  - Statement Line: `credit_amount = 500000.00`, `description = 'TRSF E-BANKING CR FATMAWATI'`, `reconciliation_status = 'unmatched'`.
  - Originating Expense `EXP/26/260` paid Rp 1,400,000 for scaffolding rental, explicitly stating: `security deposit Rp 500.000 (Refund after done)`.
- **Proposed Correction:**
  1. Create Receipt Voucher / Cash Receipt for FATMAWATI security deposit refund (Rp 500,000).
  2. Post accounting journal:
     - Dr Bank BCA IDR (`111101`) Rp 500,000.00
     - Cr Warehouse Renovation / Scaffolding Expense (`6150`) or Deposit Refund (`1180`) Rp 500,000.00
  3. Match statement line `172c1d65-bbc7-4c5a-929a-0480f5885a49` to the new receipt voucher.
- **Amount Affected:** Rp 500,000.00 (IDR)
- **Reason & Supporting Evidence:** Complete forensic match between expense description and bank credit statement. Confirms the transaction is an operational deposit return, not customer revenue or unrecorded debt.
- **Dependencies & Approvals Required:** Finance lead approval.
- **Expected Financial Impact:** Increases live bank book balance by Rp 500,000.00; offsets prior scaffolding rental expense; matches statement line.
- **Risk Level:** Low.
- **Status:** **READY FOR APPROVAL**

---

### REP-006: AP Control Account 2110 Reclassification
- **Repair ID:** `REP-006`
- **Target Table(s):** `public.journal_entry_lines`, `public.chart_of_accounts`
- **Target Record UUID(s):** 326 rows across `journal_entry_lines` (see complete register in `SAPJ_PROMPT_7A_AP_APPROVAL_REGISTER.md`)
- **Current Verified Values:**
  - Account `2110` (Trade AP Control) holds a balance of Rp 7,300,627,946.35.
  - Supplier Subledger (lines with `supplier_id IS NOT NULL`) holds Rp 7,273,710,746.35.
  - Variance is exactly Rp 26,917,200.00 across 326 lines lacking `supplier_id`.
  - Breakdown: 275 non-supplier operating expense lines (-Rp 218.8M net), 48 staff salary/advance lines (+Rp 88.4M net), 2 customs liability lines (+Rp 156.2M net), 1 historical repair line (+Rp 1.15M net).
- **Proposed Correction:**
  - Perform reclassification journal entries to transfer non-supplier liabilities out of Trade AP Control (`2110`):
    - Transfer Operating Expense liabilities (-Rp 218,802,375.98) to Accrued Expenses (`2120`).
    - Transfer Employee/Staff liabilities (+Rp 88,399,433.00) to Salaries & Wages Payable (`2140`).
    - Transfer Customs statutory liabilities (+Rp 156,170,142.98) to Statutory Customs AP (`2137`/`2139`).
    - Transfer Historical repair (+Rp 1,150,000.00) to Staff Advance Adjustments (`2140`).
  - Result: Account `2110` balance decreases by Rp 26,917,200.00 to exactly match Supplier Subledger (Rp 7,273,710,746.35).
- **Amount Affected:** Rp 26,917,200.00 (Net Reclassification)
- **Reason & Supporting Evidence:** International financial reporting standards (IFRS / PSAK) require Trade Payables (`2110`) to reflect only trade goods purchases from identified commercial suppliers. Operating overhead, employee payroll, and government customs liabilities must reside in their dedicated sub-accounts.
- **Dependencies & Approvals Required:** External Auditor / Chief Accountant sign-off.
- **Expected Financial Impact:** Trade AP Control agrees 100% with Supplier Subledger. Total liabilities on Balance Sheet remain identical (zero net equity impact).
- **Risk Level:** Medium.
- **Status:** **ACCOUNTANT DECISION**

---

### REP-008: Petty Cash CTE Query Inclusion of Cash Payment Vouchers
- **Repair ID:** `REP-008`
- **Target Table(s):** Database RPC `public.get_petty_cash_balance_by_transaction_date`
- **Target Record UUID(s):** `PV/26-26/017` (`a387e532-3219-41ef-be03-93ab8dd01f53`, Rp 500) and `PV/26-26/018` (`4bb2e02d-6423-4ccb-bee3-a6e355e3c8bf`, Rp 499,500)
- **Current Verified Values:**
  - GL Account `1102` posted net debit balance: Rp 3,941,428.00.
  - `get_petty_cash_balance()` RPC returns: Rp 3,941,428.00.
  - Date-bounded RPC `get_petty_cash_balance_by_transaction_date` returned Rp 4,441,428.00 because its CTE filtered `source_module = 'petty_cash'`, omitting cash payment vouchers.
- **Proposed Correction:**
  - Frontend application fix is already active in `PettyCashManager.tsx` (binds balance to live GL Account 1102 balance and incorporates cash payment vouchers).
  - Update database function `get_petty_cash_balance_by_transaction_date` to include `payment_vouchers` where `payment_method = 'cash'` and `is_posted = true`.
- **Amount Affected:** Rp 500,000.00 (IDR)
- **Reason & Supporting Evidence:** Cash payment vouchers disburse physical cash from the petty cash box. If the RPC excludes them, operational reports diverge from the Trial Balance by the voucher amount.
- **Dependencies & Approvals Required:** Owner deployment approval.
- **Expected Financial Impact:** Operational cash disbursements agree with posted GL Account 1102 down to 0 tolerance.
- **Risk Level:** Low.
- **Status:** **READY FOR APPROVAL**

---

### REP-009: Database Constraint Guard Against Inactive Account 1101
- **Repair ID:** `REP-009`
- **Target Table(s):** `public.chart_of_accounts`, `public.journal_entry_lines`
- **Target Record UUID(s):** `35e08064-a173-4069-9b47-dd985bb98d15` (COA Code `1101`)
- **Current Verified Values:**
  - Account `1101` (`Cash on Hand`) is marked `is_active = false`.
  - Frontend dropdowns already enforce `.neq('code', '1101')`.
- **Proposed Correction:**
  - Create database trigger `trg_prevent_inactive_coa_journal_lines` on `journal_entry_lines` rejecting any insert or update referencing a chart of accounts record where `is_active = false`.
- **Amount Affected:** N/A (Data Hygiene Guard)
- **Reason & Supporting Evidence:** Enforces at the database kernel level that inactive accounts cannot receive postings via edge functions, bulk imports, or manual scripts.
- **Dependencies & Approvals Required:** Owner migration approval.
- **Risk Level:** Low.
- **Status:** **READY FOR APPROVAL**

---

### REP-010: Cancelled Invoice SAPJ-26-072 Tax Period Decoupling
- **Repair ID:** `REP-010`
- **Target Table(s):** `public.sales_invoices`
- **Target Record UUID(s):** `9878345f-b286-4a0e-83fe-de487c95e94f` (`SAPJ-26-072`)
- **Current Verified Values:**
  - `document_status = 'cancelled'`, `cancelled_at = '2026-10-27T12:34:30.322Z'`.
  - `tax_period_id = 'a689bbbf-9912-4b3e-9a4e-bc0b93acff8c'` (October 2026).
  - `tax_amount = 3225235.20`.
- **Proposed Correction:**
  - `UPDATE public.sales_invoices SET tax_period_id = NULL WHERE id = '9878345f-b286-4a0e-83fe-de487c95e94f';`
- **Amount Affected:** Rp 3,225,235.20 (PPN Output)
- **Reason & Supporting Evidence:** Cancelled invoice `SAPJ-26-072` was replaced/cancelled prior to customer delivery. While frontend panels (`TaxPeriodsPanel.tsx`, `FakturPajakPanel.tsx`) have been hardened to exclude cancelled invoices, unlinking `tax_period_id` cleans the underlying database record.
- **Dependencies & Approvals Required:** Finance lead approval.
- **Expected Financial Impact:** Eliminates the Rp 3,225,235.20 discrepancy in raw database queries. Listed invoices sum to Rp 95,811,474.55, exactly matching `vw_ppn_net_by_period` and GL Account 2130.
- **Risk Level:** Low.
- **Status:** **READY FOR APPROVAL**

---

### REP-012: October 2026 BPJS Register Approval & Accrual Posting
- **Repair ID:** `REP-012`
- **Target Table(s):** `public.bpjs_monthly_registers`, `public.journal_entries`
- **Target Record UUID(s):** `46a472ab-c5ec-4d25-a102-86286736cfb2`
- **Current Verified Values:**
  - `status = 'draft'`, `payment_status = 'unpaid'`, `reconciliation_status = 'unreconciled'`.
  - `total_employee_deductions = 246000.00` (posted to GL Account 2134 via payroll).
  - `total_employer_expenses = 521520.00` (unposted).
  - `total_contribution_payable = 767520.00`.
- **Proposed Correction:**
  - **DO NOT MODIFY IN PRODUCTION UNTIL FORMALLY APPROVED.**
  - Once management approves October payroll close:
    1. Approve the register (`status = 'approved'`).
    2. Post employer contribution journal: Dr BPJS Employer Expense (`6130`) Rp 521,520 / Cr BPJS Payable (`2134`) Rp 521,520.
    3. Account 2134 credit balance reaches Rp 767,520.00.
    4. Settle against November BCA bank debit `BYR VIA E-BANKING BPJS`.
- **Amount Affected:** Rp 767,520.00 (IDR)
- **Dependencies & Approvals Required:** HR / Finance Manager sign-off.
- **Risk Level:** Medium.
- **Status:** **ACCOUNTANT DECISION**

---

### REP-013: Finance Master Verification Report View Correction
- **Repair ID:** `REP-013`
- **Target Table(s):** Database View `public.finance_master_verification_report`
- **Current Verified Values:**
  - Check `Journal ≠ Export COA` reports `finding_count = 162`, `status = 'FAIL'`.
  - Cause: Lateral join uses `ORDER BY je.posted_at DESC`, selecting bank settlement journals (Dr AP 2110) instead of expense recognition journals (Dr Expense 6xxx).
- **Proposed Correction:**
  - Deploy updated view definition where lateral subquery filters `je.source_module IN ('expenses', 'expense')` and orders by `je.entry_date ASC`.
- **Amount Affected:** N/A (Reporting Integrity)
- **Reason & Supporting Evidence:** Tested in read-only session: corrected subquery drops false failures from 162 to **0**, while preserving the ability to detect genuine account misallocations.
- **Dependencies & Approvals Required:** Owner deployment approval.
- **Risk Level:** Low.
- **Status:** **READY FOR APPROVAL**

