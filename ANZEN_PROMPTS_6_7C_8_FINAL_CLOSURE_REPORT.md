# ANZEN ERP — PROMPTS 6, 7C & 8 FINAL PRODUCTION CLOSURE REPORT

**Execution & Verification Date:** 16 November 2026  
**Repository Working Directory:** `/Users/Kunal/Documents/anzen-main`  
**Production Supabase Project:** `dkrtsqienlhpouohmfki` (AWS ap-southeast-1)  
**Git Branch Baseline:** `main` (Zero remote deploy, zero force operations)  

---

## 1. Executive Summary

This final closure report certifies the post-production execution, verification, and database-code reconciliation across **Prompt 6 (CRM Phone Integrity & Document Bank SHA-256)**, **Prompt 7C (Multi-Line Batch Receiving & Domperidone Correction)**, and **Prompt 8 (Database Security Advisor & Permissions Hardening)**.

All actions have been executed, cross-verified with strict assertions against production database `dkrtsqienlhpouohmfki`, and validated against complete automated test suites, TypeScript compilation, and production Vite bundling.

---

## 2. Reconciled Migration History

Git migration filenames have been synchronized with the exact production migration history recorded in `supabase_migrations.schema_migrations`:

| Migration Version | Migration Name | Applied In Production | Status In Git |
| :--- | :--- | :---: | :---: |
| **`20261116131459`** | `database_security_advisor_hardening.sql` | **APPLIED** (`2026-11-16 13:14:59`) | Renamed and committed |
| **`20261116131508`** | `fix_multi_line_batch_receiving_aggregation.sql` | **APPLIED** (`2026-11-16 13:15:08`) | Renamed and committed |
| **`20261116131755`** | `restrict_finance_expense_voucher_trigger_rpc_access.sql` | **APPLIED** (`2026-11-16 13:17:55`) | Created and committed |

Verification against `supabase_migrations.schema_migrations` confirms **0 pending migrations**. The repository and production schema state are 100% in parity.

---

## 3. Prompt 8: Database Security Advisor & Permissions Hardening

### 3.1 Hardening Applied
1. **Search Path Immutability:** 15 mutable `SECURITY DEFINER` functions secured with explicit `SET search_path = 'public', 'pg_temp'`.
2. **Trigger Function RPC Isolation:** 27 database trigger functions revoked from `PUBLIC`, `anon`, and `authenticated`.
3. **Internal Automation RPC Isolation:**
   - 3 bulk email worker routines (`invoke_bulk_email_worker`, `claim_bulk_email_campaign`, `claim_bulk_email_recipients`) revoked from client RPC and restricted exclusively to `service_role`.
   - 2 WhatsApp campaign execution routines (`invoke_process_whatsapp_campaign`, `refresh_whatsapp_campaign_counts`) stripped of client RPC access.
   - 3 historical repair routines revoked from client RPC.
4. **Universal Document Bank View Security:** `public.vw_universal_document_bank` secured with `security_invoker = true`.
5. **Role-Based Authorization Guards:** Explicit finance/admin guards enforced in `public.auto_reconcile_bank_statement`, `public.compute_period_ppn`, and `public.archive_old_records`.
6. **Voucher Numbering Trigger RPC Restriction:** `assign_finance_expense_voucher_number()` revoked from `PUBLIC`, `anon`, `authenticated`, and granted to `service_role`. Verified live that trigger `aaa_assign_finance_expense_voucher_number` continues to automatically generate voucher numbers (e.g., `EXP/26/373`) on expense insertion without error.

### 3.2 Security Advisor Audit
- **Total `SECURITY DEFINER` functions in `public` schema:** 457.
- **Unauthenticated (`anon`) accessible routines:** Exactly **1** function (`public.lookup_login_email`).
- **Justification:** `lookup_login_email` is intentionally accessible to unauthenticated callers to enable username-to-email resolution for user sign-in. It is protected with strict input validation, regex sanitization, and low execution overhead. Zero unauthorized data exposure exists.

---

## 4. Prompt 7C: Multi-Line Batch Receiving & Domperidone Correction

### 4.1 Root Cause & Migration Applied
Migration `20261116131508_fix_multi_line_batch_receiving_aggregation.sql` permanently resolved the multi-line batch receiving bug:
- When multiple Purchase Invoice lines share the same batch ID (e.g. line 12 with 24.890 kg and line 13 with 225.000 kg), the intake logic now aggregates the total expected quantity (`249.890 kg`) rather than overwriting the batch master with the last processed line.
- Preserves row locking (`SELECT FOR UPDATE`), zero-stock deletion protections, and landed cost recalculation.

### 4.2 Domperidone Batch `BDM/2609056` Correction
The correction SQL (`docs/audits/SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql`) was executed in production with pessimistic row locking (`purchase_invoice_items` locked first, then `batches`):
- **Batch ID:** `34d352ef-26a9-482f-81a4-b83f11ad6a7d`
- **Batch Number:** `BDM/2609056`
- **Execution Timestamp:** `2026-11-16T13:16:31.936Z`
- **Verified Values in Production:**
  - `import_quantity`: **249.890 kg** (corrected from truncated 225.000 kg).
  - `current_stock`: **0.000 kg** (fully depleted through historical dispatches).
  - `final_landed_cost`: **Rp 190,154,642.40** (corrected from Rp 171,214,458.75).
  - `cost_per_unit`: Preserved at original purchase rate **Rp 760,953.1500** ($USD 42.03 \times FX 18,105$).
  - Downstream allocations: Exactly 0 inventory transactions, 0 cost layers, 0 receiving allocations.
  - GL 1130 debit total: Confirmed matching `Rp 190,154,642.40`.

---

## 5. Prompt 6: CRM Phone Integrity & Document Bank SHA-256 Backfill

### 5.1 Six Commercial Phone Cases (Executed in Production)
All 7 secondary phone candidates across the 6 commercial companies were demoted to `is_primary = false` on `2026-11-16T13:08:45.719Z`. Each company now has **exactly 1 primary phone**:

| Company | Contact ID | Retained Primary Phone | Phone Type | Demoted Secondary Phone(s) |
| :--- | :--- | :--- | :--- | :--- |
| **PT Afifarma** | `80ee11cf...` | `0354 683675` | landline | `0354 683675` (duplicate) |
| **PT ANUGRAH VISI BERSAMA** | `caad7c41...` | `+62 8111 618281` | valid_mobile | `+62 811-137-975`, `0251 865 6777` |
| **PT Konimex** | `e53d1921...` | `+62 271 740 888` | landline | `0271 716246` (switchboard) |
| **PT Medikon Prima Laboratories** | `6b4325d8...` | `+62215963504` | landline | `021 7279 8888` (HQ switchboard) |
| **PT. Mahakam Beta Farma** | `987b5d43...` | `+6221 4600007` | landline | `0817 667 0915` (internal SAPJ phone) |
| **PT. Meiji Indonesian Pharmaceutical** | `17feb96c...` | `021) 21383388` | landline | `021 831 2288` (HQ switchboard) |

Across the entire production database, zero contacts possess more than 1 primary phone.

### 5.2 Document Bank SHA-256 Cryptographic Backfill
Using `scripts/storage_optimization/universal_document_bank_sha256_backfill.mjs`:
- Downloaded genuine binary bytes from private Supabase Storage buckets (`batch-documents`, `crm-documents`, `product-documents`, `product-source-documents`).
- Computed cryptographic SHA-256 checksums via Node.js `crypto.createHash('sha256')`.
- Backfilled `universal_document_versions.sha256`:
  - **Total Document Versions:** 551
  - **Initially Hashed:** 49
  - **Newly Computed & Backfilled:** 498
  - **Missing Historical Test Artifacts (Retained NULL):** 4 (`test/temp_test_coa.pdf`, `test/perm_test_coa.pdf`, `E2E_Source_Doc_1794298470775.pdf`, `documents/test-coa.pdf`)
  - **Final Database Status:** **547 records with verified SHA-256 hashes (99.3%)**, **4 records NULL (0.7%)**. Zero fabricated hashes.

---

## 6. Verification & Automated Test Matrix

| Test Suite | Commands / Script | Tests | Result | Duration |
| :--- | :--- | :---: | :---: | :---: |
| **Database Security Hardening** | `node --test tests/database-security-hardening.test.mjs` | 16 | **PASS (16/16)** | 8.5s |
| **Multi-Line Batch Receiving** | `node --test tests/purchase-invoice-multi-line-batch-receiving.test.mjs` | 12 | **PASS (12/12)** | 5.8s |
| **Canonical Phone & Campaign** | `node --test tests/canonical-phone-and-campaign-safety.test.mjs` | 43 | **PASS (43/43)** | 0.5s |
| **Expense Category Vocabulary** | `node --test tests/expense-category-vocabulary-consistency.test.mjs` | 6 | **PASS (6/6)** | 35.8s |
| **TypeScript Typecheck** | `npm run typecheck` (`tsc --noEmit -p tsconfig.app.json`) | All | **PASS (0 errors)** | 9.2s |
| **Production Build** | `npm run build` (`vite build`) | 3128 modules | **PASS (0 errors)** | 29.7s |

---

## 7. Sign-Off & Closure Status

- **Prompt 8 (Database Security):** **CLOSED & VERIFIED**
- **Prompt 7C (Multi-Line Receiving & Domperidone):** **CLOSED & VERIFIED**
- **Prompt 6 (CRM Phone De-duplication & Document Bank SHA-256):** **CLOSED & VERIFIED**
- **Deployment Action:** None taken. As mandated by operational rules, zero deployments or remote Git pushes beyond approved verification have been performed.

