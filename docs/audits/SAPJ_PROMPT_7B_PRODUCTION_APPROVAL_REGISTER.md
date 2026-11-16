# SAPJ / Anzen ERP — Prompt 7B: Production Approval & Decision Register

**Date**: November 16, 2026  
**Auditor**: Lead Financial Systems Auditor & Antigravity Autonomous Agent  
**Environment**: Production Database (`dkrtsqienlhpouohmfki` - AWS ap-southeast-1)  

---

## 1. Register Overview

This register provides the business owner, head of finance, and certified accountant with an itemized, decision-ready catalog of production items requiring formal review, authorization, or documentary follow-up before execution.

No production database mutations have been performed. All items remain in their original status until authorized.

---

## 2. Production Approval Items

### APP-01: Bizpark Electricity Expense (`EXP/26/369`) Payment True-Up
- **Record Identifier (UUID)**: `61b7da7f-4402-4fc8-9f2d-b0a3aa52994c`
- **Voucher Number**: `EXP/26/369`
- **Expense Date**: October 28, 2026
- **Vendor / Payee**: PT. Bizpark Warehouse Management
- **Gross Amount**: Rp 4,000,000.00
- **Current DB State**: `status = 'approved'`, `amount = 4000000.00`, `paid_amount = 0.00`, `bank_account_id = NULL`
- **Bank Match**: BCA Statement Line on Oct 28, 2026 for Rp 4,000,000.00
- **Risk Assessment**: Low. Real physical payment already cleared the bank.
- **Recommended Action**: Authorize execution of atomic update:
  ```sql
  UPDATE public.finance_expenses
  SET paid_amount = 4000000.00,
      payment_method = 'bank_transfer',
      bank_account_id = (SELECT id FROM public.bank_accounts WHERE account_number ILIKE '%BCA%' LIMIT 1)
  WHERE id = '61b7da7f-4402-4fc8-9f2d-b0a3aa52994c' AND paid_amount = 0.00;
  ```

---

### APP-02: Fatmawati Scaffolding Deposit Refund Allocation
- **Record Identifier (UUID)**: `8db054a3-7ce8-4903-b0fc-238495f5dc43`
- **Voucher Number**: `EXP/26/370` / Receipt Voucher
- **Refund Date**: October 30, 2026
- **Refund Amount**: Rp 1,500,000.00 (Cash received back into BCA)
- **Original Expense Reference**: `EXP/26/260` (Bizpark Setup & Scaffolding Rental, Rp 2,400,000 debited to Account `6231 Warehouse Renovation & Setup - Bizpark`)
- **Correction Applied**: Earlier proposal misallocated refund credit to Account 6150 (Staff Benefits). Correct allocation credits Account 6231, accurately truing up net setup expense to Rp 900,000.
- **Risk Assessment**: Low. Ensures P&L setup cost matches actual net outlay.
- **Recommended Action**: Authorize posting of credit to Account 6231 (`Warehouse Renovation & Setup - Bizpark`).

---

### APP-03: Historical Sales Invoice `SAPJ-005` Missing Faktur Pajak Document
- **Record Identifier (UUID)**: `583bce82-db2d-4560-b6c8-ad23267562ad`
- **Invoice Number**: `SAPJ-005`
- **Invoice Date**: November 28, 2025
- **Customer**: PT. Anugrah Visi Bersama
- **Subtotal**: Rp 311,916,000.00
- **PPN (11%)**: Rp 34,310,760.00
- **Total Amount**: Rp 346,226,760.00 (Fully Paid)
- **Current DB State**: `faktur_pajak_number = NULL`. Zero linked documents in `customer_documents` or `universal_documents`.
- **Tax Implication**: Historical 2025 opening transaction. PPN Output was posted to GL Account 2131. DJP 16-digit e-Faktur Pajak PDF must be archived for 10-year statutory tax compliance (UU KUP).
- **Recommended Action**: Tax accountant to retrieve 2025 DJP archive PDF, upload to Document Bank, and link the 16-digit number to invoice `SAPJ-005`.

---

### APP-04: Walk-In Retail Customer Sales Invoice `SAPJ-26-075`
- **Record Identifier (UUID)**: `5211ceae-31d7-4638-b7eb-d1cfd21fe1f9`
- **Invoice Number**: `SAPJ-26-075`
- **Invoice Date**: November 2, 2026
- **Customer**: Triman (`npwp = NULL`, retail customer)
- **Subtotal**: Rp 240,625.00
- **PPN (11%)**: Rp 26,468.75
- **Current DB State**: `faktur_pajak_number = NULL`
- **Tax Law Assessment**: Under PER-03/PJ/2022, sales to non-NPWP end-consumers can be reported collectively under Faktur Pajak Digunggung at month-end closing without individual 16-digit NSFP numbers.
- **Recommended Action**: No immediate database edit required. Include in November 2026 collective retail PPN return.

---

### APP-05: October 2026 Owner-Handled Bank Transactions (Rp 3,900,000.00)
- **Bank Account**: Bank Central Asia (GL 111101)
- **Transactions**:
  1. Oct 12, 2026 — Withdrawal: Rp 3,000,000.00 (Description: Direct owner transfer)
  2. Oct 24, 2026 — Withdrawal: Rp 900,000.00 (Description: Operational cash out)
- **Total Unmatched**: Rp 3,900,000.00
- **Accounting Standard**: Do NOT force balance adjustments or create dummy expenses.
- **Recommended Action**: Business owner to choose accounting classification:
  - **Option A (Owner Drawings / Prive)**: Debit Account `3200 Owner Drawings` / Credit Account `111101 BCA`.
  - **Option B (Business Expense Reimbursement)**: Provide physical receipts to accountant to post against appropriate operating expense accounts.
  - Until confirmed, keep clearly listed as outstanding reconciling items on the bank reconciliation statement.

---

### APP-06: November 2026 Unmatched Bank Transactions
- **Status**: Live bank feeds during active operating month.
- **Protocol**: Maintain in outstanding status. Reconcile organically as customer payments and vendor payment vouchers are authorized and matched.

---

### APP-07: October 2026 BPJS Health & Employment Accrual Review
- **Voucher Reference**: `JE2611-0294` / `BPJS/26/10`
- **Amount**: Rp 15,280,000.00
- **Status**: Accrued in Account 2133 (BPJS Payable).
- **Recommended Action**: Payroll administrator and accountant to cross-verify individual employee withholding deduction schedules before generating SSE billing codes for BPJS payment in mid-November.

---

## 3. Summary of Approvals Required

| Decision ID | Stakeholder | Decision Scope | Default Recommendation |
| :--- | :--- | :--- | :--- |
| **DEC-01** | Finance Manager | Approve `EXP/26/369` paid_amount true-up | **Approve** (Atomic script ready) |
| **DEC-02** | Finance Manager | Approve Fatmawati Scaffolding refund to Account 6231 | **Approve** (Corrects setup cost) |
| **DEC-03** | Tax Accountant | Archive 2025 Faktur Pajak PDF for `SAPJ-005` | **Approve** (Upload document) |
| **DEC-04** | Business Owner | Classify Oct Rp 3.9M bank transactions (Drawings vs Expense) | **Classify as Owner Drawings (Prive) or submit receipts** |

