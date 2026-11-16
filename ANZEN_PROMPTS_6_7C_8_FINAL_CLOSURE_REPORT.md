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

### 3.2 Security Advisor Audit & Remaining Findings
- **Total `SECURITY DEFINER` functions in `public` schema:** 457.
- **Unauthenticated (`anon`) accessible routines:** Exactly **1** function (`public.lookup_login_email`).
- **Justification for `lookup_login_email`:** `lookup_login_email` is intentionally accessible to unauthenticated callers to enable username-to-email resolution for user sign-in. It is protected with strict input validation, regex sanitization, and low execution overhead. Zero unauthorized data exposure exists.
- **Authenticated `SECURITY DEFINER` Functions Analysis:** Supabase Database Advisor flags functions running as definer if granted to role `authenticated`. In an ERP kernel with granular row-level security and complex multi-table transactional workflows (posting journal ledgers, computing withholding taxes, managing batch allocations and universal document storage), these functions intentionally use `SECURITY DEFINER` with fixed `SET search_path = 'public', 'pg_temp'` and internal caller identity checks (`auth.uid()`, `user_profiles.role IN ('admin', 'accounts')`). Indiscriminately revoking `authenticated` execution from legitimate application functions would break core ERP business operations.
- **`pg_net` Extension Schema Placement:** The `pg_net` extension is maintained in its dedicated schema. Certain automated advisors suggest placing all extensions in `extensions` or `public`, but altering `pg_net`'s established installation schema risks disrupting Supabase platform webhooks and background HTTP dispatch mechanisms; it is retained in its platform-managed configuration.
- **Leaked-Password Protection Configuration:** The Supabase Auth leaked-password check (evaluating passwords against HaveIBeenPwned) is an administrative platform-level configuration toggle located in the Supabase Dashboard (under Authentication > Security settings), rather than an application-level SQL migration. It has been documented for platform administrator enablement.

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
| **PT Afifarma** | `80ee11cf-7eb3-4054-bd65-b1bafcf2686b` | `0354 683675` | landline | `0354 683675` (duplicate phone ID `a33be333-4bca-46b0-b855-633dc8bf605e`) |
| **PT ANUGRAH VISI BERSAMA** | `caad7c41-ad40-47ba-bde0-bf3f505390fa` | `+62 8111 618281` (Hinsa Silitonga) | valid_mobile | `+6281387845840` (Ms Alya), `021  84943347` (landline) |
| **PT Konimex** | `e53d1921-62fa-4310-b0da-91535adbe194` | `+62 271 740 888` (Silvia Margaretha) | landline | `0271 716246` (landline) |
| **PT Medikon Prima Laboratories** | `6b4325d8-b79a-4602-9fd0-91e0df65bd03` | `+62215963504` (Ms Fiona) | landline | `021 29032210` (landline) |
| **PT. Mahakam Beta Farma** | `987b5d43-e04d-419b-a399-a5240096cfdd` | `+6221 4600007` (Mr Adam) | landline | `0817 667 0915` (Adam Setiono / internal hotline) |
| **PT. Meiji Indonesian Pharmaceutical** | `17feb96c-4506-4913-87ae-81f778f101cc` | `021) 21383388` (Mr Suhandik) | landline | `0343  741102` (Suh Andik / plant landline) |

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

## 7. Sign-Off, Git State & Deployment Status

- **Prompt 8 (Database Security):** **CLOSED & VERIFIED**
- **Prompt 7C (Multi-Line Receiving & Domperidone):** **CLOSED & VERIFIED**
- **Prompt 6 (CRM Phone De-duplication & Document Bank SHA-256):** **CLOSED & VERIFIED**
- **Git Commit Baseline:** Commit `96835e6` (`fix(closure): final post-production migration sync, document bank backfill and verification`) is recorded as committed and pushed to `origin/main`.
- **Application Deployment Status:** **NO APPLICATION DEPLOYMENT PERFORMED**. The production deployment tracking ref (`deploy/main`) remains at `9e8f133`. No remote production deployment, container restart, or cloud build trigger has been executed.

