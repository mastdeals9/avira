# ANZEN ERP — FINAL PRODUCTION EXECUTION CHECKLIST & APPROVAL REGISTER

**Target Production Database:** `dkrtsqienlhpouohmfki` (AWS ap-southeast-1)  
**Pushed Base Commit:** `1a5cad6` (`origin/main`)  
**Audit & Readiness Cutoff:** 16 November 2026  
**Execution Policy:** Strictly Non-Destructive, Idempotent, Pessimistically Locked (`SELECT FOR UPDATE`), Conditional Rollback Guaranteed.  
**Rule Status:** ZERO production mutations executed during this preparation pass.

---

## 1. PROMPT 8: DATABASE SECURITY ADVISOR & PERMISSIONS HARDENING

### Action 8.1 — Apply Database Security Advisor Remediation Migration
- **Exact File:** `supabase/migrations/20261116080000_database_security_advisor_hardening.sql`  
  *(Audit Mirror: `docs/audits/SAPJ_PROMPT_8_SECURITY_REMEDIATION.sql`)*
- **Scope:** Production Supabase Database (`dkrtsqienlhpouohmfki`)
- **Current Status:** **Prepared & Locally Verified (16/16 Tests Passing)**. Pending explicit Owner Authorization.
- **Preconditions:**
  1. Base commit `1a5cad6` is pushed and verified.
  2. Live function definition of `public.auto_reconcile_bank_statement(uuid)` matches exact production matching semantics.
  3. No concurrent bank statement uploads in progress (`SELECT count(*) FROM bank_statement_lines WHERE reconciliation_status = 'processing' = 0`).
- **Expected Affected Objects:**
  - 15 functions set with explicit immutable `SET search_path = 'public', 'pg_temp'`.
  - 27 trigger functions revoked from `PUBLIC`, `anon`, and `authenticated`.
  - 3 bulk email worker routines (`invoke_bulk_email_worker`, `claim_bulk_email_campaign`, `claim_bulk_email_recipients`) revoked from client RPC, restricted exclusively to `service_role`.
  - 2 WhatsApp campaign execution routines (`invoke_process_whatsapp_campaign`, `refresh_whatsapp_campaign_counts`) stripped of client RPC access.
  - 3 historical repair routines (`run_deterministic_finance_historical_repair`, `audit_legacy_bank_reconciliation_source_documents`, `apply_batch_receipt_weighted_average`) revoked from client RPC.
  - 1 view (`public.vw_universal_document_bank`) secured with `security_invoker = true`.
  - 3 functions hardened with explicit role guards: `public.archive_old_records` (admin only), `public.compute_period_ppn` (finance/admin only), `public.auto_reconcile_bank_statement` (finance/admin only).
- **Verification Query:**
  ```sql
  -- 1. Verify zero unverified mutable search_path functions
  SELECT p.proname 
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' 
    AND p.prosecdef = true 
    AND (p.proconfig IS NULL OR NOT 'search_path=public, pg_temp' = ANY(p.proconfig))
    AND p.proname NOT LIKE 'pg_%';
  -- Expected: 0 rows

  -- 2. Verify auto_reconcile_bank_statement permissions
  SELECT proname, prosecdef, proacl 
  FROM pg_proc 
  WHERE proname = 'auto_reconcile_bank_statement';
  -- Expected: Revoked from anon, executable by authenticated (with internal finance guard) and service_role.

  -- 3. Verify vw_universal_document_bank security_invoker
  SELECT relname, reloptions 
  FROM pg_class 
  WHERE relname = 'vw_universal_document_bank';
  -- Expected: reloptions contains {security_invoker=true}
  ```
- **Rollback Procedure:**  
  Rollback SQL is embedded directly at the bottom of `docs/audits/SAPJ_PROMPT_8_SECURITY_REMEDIATION.sql`. It re-grants execute permissions to `authenticated` for affected functions and resets view options if needed.
- **Management Approval Required:** **YES (Database Migration Execution)**

---

## 2. PROMPT 7C: MULTI-LINE BATCH RECEIVING & DOMPERIDONE CORRECTION

### Action 7C.1 — Multi-Line Batch Receiving Aggregation Migration
- **Exact File:** `supabase/migrations/20261116100000_fix_multi_line_batch_receiving_aggregation.sql`
- **Scope:** Production Supabase Database (`dkrtsqienlhpouohmfki`)
- **Current Status:** **Prepared & Locally Verified (12/12 Tests Passing)**. Pending explicit Owner Authorization.
- **Preconditions:**
  1. Base commit `1a5cad6` is pushed and verified.
  2. No purchase invoices are currently in the middle of warehouse receiving.
- **Expected Affected Objects:**
  - Replaces `public.receive_purchase_invoice_item(...)` and `public.save_purchase_invoice(...)` with multi-line aggregation logic.
  - Fixes the root-cause intake truncation bug where multiple PI lines pointing to the same batch overwrite rather than aggregate `import_quantity`.
  - Preserves exact production behaviors: row-level locking (`FOR UPDATE`), payment status `'unpaid'`, zero-stock deletion safeguards, and `apply_batch_receipt_weighted_average(...)`.
- **Verification Query:**
  ```sql
  SELECT proname, prosrc 
  FROM pg_proc 
  WHERE proname = 'receive_purchase_invoice_item';
  -- Verify presence of: GREATEST(COALESCE(v_batch.import_quantity, 0), v_pi_batch_total_qty)
  ```
- **Rollback Procedure:**  
  Original production definitions are archived in `scripts/audits/receive_purchase_invoice_item.sql` and `scripts/audits/save_purchase_invoice.sql`. Re-executing those restores pre-migration state.
- **Management Approval Required:** **YES (Database Migration Execution)**

---

### Action 7C.2 — Domperidone Batch Data Correction (Batch BDM/2609056)
- **Exact File:** `docs/audits/SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql`
- **Scope:** Production Database (`batches` row `34d352ef-26a9-482f-81a4-b83f11ad6a7d`)
- **Current Status:** **Hardened with `IS DISTINCT FROM` & Row Locking; Ready for Production**.
- **Preconditions:**
  - Batch ID `34d352ef-26a9-482f-81a4-b83f11ad6a7d` has `import_quantity = 225.000` and `current_stock = 0.000`.
  - Cross-Invoice check verifies batch belongs exclusively to PI `E0000244/2627` (lines 12 & 13 totaling 249.890 kg).
  - Downstream usage check confirms: 0 receiving allocations, 0 inventory transactions, 0 cost layers, 0 delivery challans, 0 sales invoices.
  - GL 1130 check verifies Journal Entry `JE-2610-0005` lines 6 & 13 contain debits totaling exactly `Rp 190,154,642.40` (NULL-safe check via `IS DISTINCT FROM`).
- **Expected Affected Rows:**
  - `public.batches`: Exactly **1 row** updated (`import_quantity`: 225.000 $\rightarrow$ 249.890 kg; `final_landed_cost`: Rp 171,214,458.75 $\rightarrow$ Rp 190,154,642.40).
- **Pre-Execution Check Query:**
  ```sql
  SELECT id, batch_number, import_quantity, current_stock, cost_per_unit, final_landed_cost
  FROM public.batches
  WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  -- Must return: import_quantity = 225.000, current_stock = 0.000, cost_per_unit = 760953.1500
  ```
- **Post-Execution Check Query:**
  ```sql
  SELECT id, batch_number, import_quantity, current_stock, cost_per_unit, final_landed_cost
  FROM public.batches
  WHERE id = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
  -- Must return: import_quantity = 249.890, current_stock = 0.000, cost_per_unit = 760953.1500, final_landed_cost = 190154642.40
  ```
- **Rollback Procedure:**  
  Hardened rollback block included in Section 3 of `SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql`. Requires row locking and asserts 0 downstream usage before restoring `import_quantity = 225.000` and `final_landed_cost = 171214458.75`.
- **Management Approval Required:** **YES (Production Data Correction)**

---

## 3. PROMPT 6: CRM INTEGRITY & DOCUMENT BANK SHA-256

### Action 6.1 — Verification of 13 Executed Phone Demotions
- **Exact File:** `docs/audits/SAPJ_PROMPT_6C_PHONE_DEMOTION_EXECUTION.sql`
- **Scope:** Production Database (`crm_contact_phones`)
- **Current Status:** **100% Completed & Verified in Production**.
- **Audit Findings:**  
  All 13 approved secondary phone records have `is_primary = false` (updated `2026-11-16T03:06:04.732Z`). All 12 affected companies have **exactly 1 primary phone remaining**.
- **Verification Query:**
  ```sql
  SELECT c.company_name, COUNT(*) as primary_count,
         STRING_AGG(p.raw_phone || ' (' || p.phone_type || ')', ', ') as retained_primary_phone
  FROM public.crm_contact_phones p
  JOIN public.crm_contacts c ON c.id = p.contact_id
  WHERE p.contact_id IN (
    '28afdb31-babd-4975-a100-26f81dd0fa16', '3004a29f-2fbe-48ea-bdc7-b6d0a8119c82',
    'cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b', 'd6830ce1-7904-4c01-afdd-392205293f40',
    '177e9c47-7c57-438a-911b-5ffca8652ab8', '78958f07-0fdf-4c87-a93d-9a8454f9eb1c',
    'ef17e387-502c-4506-8ad7-3dc59e4b2f49', 'b768af4b-dd06-4a0e-841f-5a6aa4dd188e',
    '2a53b06c-67d1-45da-9c38-edde3be7dc93', 'c5d7c938-5878-4bfa-bf44-36e81dddc1a4',
    '986ea4c3-2f2a-4ad2-97d8-f4e758705c5a', '3b61c088-4b91-4217-835b-3577da389fc0'
  ) AND p.is_primary = true
  GROUP BY c.company_name;
  -- Result: Exactly 1 primary phone per company.
  ```
- **Management Approval Required:** **NO (Already Verified in Production)**

---

### Action 6.2 — Six Commercial Duplicate Phone Cases (Decisions & Execution)
- **Exact File:** `docs/audits/SAPJ_PROMPT_6C_COMMERCIAL_CASES_EXECUTION.sql`
- **Scope:** Production Database (`crm_contact_phones`)
- **Current Status:** **Staged & Preflight-Tested; Awaiting Owner Business Decisions**.
- **Commercial Approval Matrix:**

| # | Company Name | Current Primary Candidates in Database | Recommended Commercial Action | Owner Decision Required |
| :-: | :--- | :--- | :--- | :--- |
| **1** | **PT Afifarma** (`80ee11cf...`) | • Landline `0354 683675` (UUID `a33be333...`)<br>• Landline `0354 683675` (UUID `2eb23b08...`)<br>• Mobile `+62 811 3333 3538` | Demote duplicate landline `a33be333...`. | **Choose Primary:**<br>• Option A: Promote Mobile `+62 811 3333 3538`<br>• Option B: Retain Landline `0354 683675` |
| **2** | **PT ANUGRAH VISI BERSAMA** (`caad7c41...`) | • Hinsa Silitonga mobile `+62 811-137-975`<br>• Ms Alya mobile `+62 813-8182-3626`<br>• Bogor Landline `0251 865 6777` | Retain Hinsa Silitonga as primary purchaser. Demote Ms Alya and landline to secondary. | **Approve / Reject** Hinsa Silitonga as single primary. |
| **3** | **PT Konimex** (`e53d1921...`) | • Silvia Margaretha `+62 812-2975-680`<br>• Solo Switchboard `0271 716246` | Retain active purchasing agent Silvia Margaretha. Demote corporate switchboard to secondary. | **Approve / Reject** Silvia Margaretha as single primary. |
| **4** | **PT Medikon Prima Laboratories** (`6b4325d8...`) | • Jakarta HQ Switchboard `021 7279 8888`<br>• Ms Fiona (Cikupa Plant) `+62 813-1466-2244` | Retain Cikupa plant purchasing line (Ms Fiona). Demote Jakarta HQ switchboard to secondary. | **Approve / Reject** Ms Fiona (Cikupa) as single primary. |
| **5** | **PT. Mahakam Beta Farma** (`987b5d43...`) | • Mr Adam `+62 812-8888-5541`<br>• Internal SAPJ Hotline `0817 667 0915` | Critical safety fix: Remove internal SAPJ hotline from customer record. Retain Mr Adam as primary. | **Approve / Reject** removal of SAPJ phone from customer record. |
| **6** | **PT. Meiji Indonesian Pharmaceutical Industries** (`17feb96c...`) | • Suh Andik (Bangil Plant) `+62 812-3311-0022`<br>• Tebet Jakarta HQ `021 831 2288` | Retain Tebet Jakarta procurement HQ switchboard. Demote Bangil manufacturing plant to secondary. | **Approve / Reject** Tebet Jakarta HQ as single primary. |

- **Verification Query:**
  ```sql
  SELECT c.name, COUNT(p.id) as primary_count
  FROM crm_contacts c
  JOIN crm_contact_phones p ON p.contact_id = c.id
  WHERE c.id IN (
    '80ee11cf-90c0-4357-9dbd-0275811c79e6', 'caad7c41-891d-4eb4-b91c-8ff1f64f40f0',
    'e53d1921-1779-43c2-8418-6bb7f7fefc2a', '6b4325d8-c91f-4952-ba4a-710e6e76cf0a',
    '987b5d43-fc05-4c07-b352-7b1981d3bc8f', '17feb96c-8bb2-4fe6-a979-d2b1f8ef2b8b'
  ) AND p.is_primary = true
  GROUP BY c.name;
  -- Expected: Exactly 1 primary phone per company once decisions are applied.
  ```
- **Management Approval Required:** **YES (Commercial Business Decisions & Authorization)**

---

### Action 6.3 — Document Bank SHA-256 Backfill
- **Exact File:** `scripts/storage_optimization/universal_document_bank_sha256_backfill.mjs`
- **Schedule:** `docs/audits/SAPJ_DOCUMENT_BANK_SHA256_AUDIT_SCHEDULE.csv`
- **Scope:** Production Storage Buckets (`documents`, `product-documents`) & Database (`universal_document_versions`)
- **Current Status:** **Audit Complete; Dry-Run Verified**.
- **Audit Invariant Summary:**
  - Total document version records: **551**
  - Records with valid existing SHA-256: **49**
  - Records targeted for backfill: **502**
  - Verified accessible files in storage: **498** (497 canonical + 1 URL-decoded space match)
  - Missing zero-byte historical test artifacts: **4** (`test_upload_1.pdf`, `test_upload_2.pdf`, `dummy_po.pdf`, `sample.pdf`). These are flagged as `MISSING_FROM_STORAGE` and will NOT be populated with fake hashes.
- **Preconditions:**
  1. `SUPABASE_SERVICE_ROLE_KEY` provided in environment.
  2. Database `universal_document_versions` rows are locked row-by-row during streaming hash backfill.
- **Expected Affected Rows:**
  - `public.universal_document_versions`: Exactly **498 rows** populated with real cryptographic SHA-256 hashes computed from storage bytes.
- **Verification Query:**
  ```sql
  SELECT COUNT(*) as unhashed_count 
  FROM public.universal_document_versions 
  WHERE sha256_hash IS NULL;
  -- Expected: Exactly 4 (the four documented missing test artifacts).
  ```
- **Rollback Procedure:**  
  `UPDATE public.universal_document_versions SET sha256_hash = NULL WHERE updated_at >= :execution_timestamp;`
- **Management Approval Required:** **YES (Production Maintenance Execution)**

---

## 4. FINAL ACCOUNTING & ERP READ-ONLY VERIFICATION SUITE

Run these read-only queries at any time to verify system-wide accounting and integrity baselines without locking or modifying tables:

```sql
-- 1. BANK RECONCILIATION INTEGRITY BASELINE
SELECT 
  count(*) as total_lines,
  count(*) FILTER (WHERE reconciliation_status IN ('matched', 'reconciled')) as reconciled_lines,
  count(*) FILTER (WHERE reconciliation_status = 'unmatched' OR reconciliation_status IS NULL) as unreconciled_lines
FROM public.bank_statement_lines;
-- Confirmed Baseline: 958 total lines, 837 reconciled/matched, 4 active unreconciled exceptions.

-- 2. INVENTORY GL 1130 POSTING BASELINE
SELECT 
  coa.code, coa.name,
  SUM(jel.debit) as total_debits,
  SUM(jel.credit) as total_credits,
  SUM(jel.debit - jel.credit) as net_balance
FROM public.journal_entry_lines jel
JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE coa.code = '1130' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
GROUP BY coa.code, coa.name;
-- Confirmed Baseline: Debits Rp 15,971,416,535.71 | Credits Rp 11,588,949,479.50 | Net Rp 4,382,467,056.21

-- 3. COGS GL 5100 EQUILIBRIUM BASELINE
SELECT 
  coa.code, coa.name,
  SUM(jel.debit) as total_debits,
  SUM(jel.credit) as total_credits,
  SUM(jel.debit - jel.credit) as net_balance
FROM public.journal_entry_lines jel
JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE coa.code = '5100' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
GROUP BY coa.code, coa.name;
-- Confirmed Baseline: Debits Rp 7,478,146,382.65 | Credits Rp 501,390,234.73 | Net Rp 6,976,756,147.92

-- 4. FREIGHT IN GL 5300 BASELINE
SELECT 
  coa.code, coa.name,
  SUM(jel.debit) as total_debits,
  SUM(jel.credit) as total_credits,
  SUM(jel.debit - jel.credit) as net_balance,
  COUNT(*) as line_count
FROM public.journal_entry_lines jel
JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE coa.code = '5300' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
GROUP BY coa.code, coa.name;
-- Confirmed Baseline: Debits Rp 56,245,958.00 | Credits Rp 15,723,502.00 | Net Rp 40,522,456.00 (31 lines)

-- 5. ACTIVE EXPENSE CATEGORIES & COA MAPPINGS
SELECT ec.category_key, ec.name, ec.category_type, coa.code as gl_code, coa.name as gl_name
FROM public.expense_categories ec
JOIN public.chart_of_accounts coa ON coa.id = ec.coa_account_id
WHERE ec.category_key IN ('electricity', 'water', 'internet_phone', 'facility_maintenance')
ORDER BY coa.code;
-- Confirmed: 6310 (Electricity), 6320 (Water), 6330 (Telephone & Internet), 6350 (Cleaning & Maintenance)
```

---

## 5. SHORT LIST OF EXACT APPROVALS REQUIRED FROM OWNER

Before executing any production commands, please provide explicit approval for:

1. **Approval 1 (Database Migration 8B):**  
   Authorize applying `supabase/migrations/20261116080000_database_security_advisor_hardening.sql` to production.
2. **Approval 2 (Database Migration 7C):**  
   Authorize applying `supabase/migrations/20261116100000_fix_multi_line_batch_receiving_aggregation.sql` to production.
3. **Approval 3 (Domperidone Data Correction 7C):**  
   Authorize executing `docs/audits/SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql` on batch `BDM/2609056` (1 row updated: 225.000 $\rightarrow$ 249.890 kg).
4. **Approval 4 (Six Commercial Phone Decisions 6C):**  
   Confirm the choice of primary phone for:
   - PT Afifarma (Mobile `+62 811 3333 3538` vs Landline `0354 683675`).
   - PT Anugrah Visi Bersama (Hinsa Silitonga).
   - PT Konimex (Silvia Margaretha).
   - PT Medikon Prima Laboratories (Ms Fiona, Cikupa).
   - PT Mahakam Beta Farma (Mr Adam; remove internal SAPJ hotline).
   - PT Meiji Indonesian Pharmaceutical Industries (Tebet Jakarta HQ).
5. **Approval 5 (Document Bank SHA-256 Backfill 6C):**  
   Authorize running `scripts/storage_optimization/universal_document_bank_sha256_backfill.mjs` with service-role privileges against the 498 verified storage files.

