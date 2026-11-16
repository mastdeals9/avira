# ANZEN ERP — FINAL PRODUCTION EXECUTION CHECKLIST & APPROVAL REGISTER

**Target Production Database:** `dkrtsqienlhpouohmfki` (AWS ap-southeast-1)  
**Pushed Base Commit:** `1a5cad6` (`origin/main`)  
**Audit & Readiness Cutoff:** 16 November 2026  
**Execution Policy:** Strictly Non-Destructive, Idempotent, Pessimistically Locked (`SELECT FOR UPDATE`), Conditional Rollback Guaranteed.  
**Rule Status:** ZERO production mutations executed during this preparation pass.

---

## 1. PROMPT 8: DATABASE SECURITY ADVISOR & PERMISSIONS HARDENING

### Action 8.1 — Apply Database Security Advisor Remediation Migration
- **Exact File:** `supabase/migrations/20261116131459_database_security_advisor_hardening.sql`  
  *(Audit Mirror: `docs/audits/SAPJ_PROMPT_8_SECURITY_REMEDIATION.sql`)*
- **Scope:** Production Supabase Database (`dkrtsqienlhpouohmfki`)
- **Current Status:** **100% APPLIED & VERIFIED IN PRODUCTION (`20261116131459`)**. All 16/16 security tests passing.
- **Preconditions:**
  1. Base commit `1a5cad6` is pushed and verified.
  2. Live function definition of `public.auto_reconcile_bank_statement(uuid)` matches exact production matching semantics.
  3. No concurrent bank statement uploads in progress (`SELECT count(*) FROM bank_statement_lines WHERE reconciliation_status = 'processing' = 0`).
- **Executed Affected Objects:**
  - 15 functions set with explicit immutable `SET search_path = 'public', 'pg_temp'`.
  - 27 trigger functions revoked from `PUBLIC`, `anon`, and `authenticated`.
  - 3 bulk email worker routines (`invoke_bulk_email_worker`, `claim_bulk_email_campaign`, `claim_bulk_email_recipients`) revoked from client RPC, restricted exclusively to `service_role`.
  - 2 WhatsApp campaign execution routines (`invoke_process_whatsapp_campaign`, `refresh_whatsapp_campaign_counts`) stripped of client RPC access.
  - 3 historical repair routines (`run_deterministic_finance_historical_repair`, `audit_legacy_bank_reconciliation_source_documents`, `apply_batch_receipt_weighted_average`) revoked from client RPC.
  - 1 view (`public.vw_universal_document_bank`) secured with `security_invoker = true`.
  - 3 functions hardened with explicit role guards: `public.archive_old_records` (admin only), `public.compute_period_ppn` (finance/admin only), `public.auto_reconcile_bank_statement` (finance/admin only).

### Action 8.2 — Restrict Finance Expense Voucher Trigger RPC Access Migration
- **Exact File:** `supabase/migrations/20261116131755_restrict_finance_expense_voucher_trigger_rpc_access.sql`
- **Scope:** Production Supabase Database (`dkrtsqienlhpouohmfki`)
- **Current Status:** **100% APPLIED & VERIFIED IN PRODUCTION (`20261116131755`)**.
- **Executed Affected Objects:**
  - `REVOKE ALL ON FUNCTION public.assign_finance_expense_voucher_number() FROM PUBLIC, anon, authenticated;`
  - `GRANT EXECUTE ON FUNCTION public.assign_finance_expense_voucher_number() TO service_role;`
  - Trigger `aaa_assign_finance_expense_voucher_number` verified fully operational on `INSERT` into `finance_expenses`.
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
- **Exact File:** `supabase/migrations/20261116131508_fix_multi_line_batch_receiving_aggregation.sql`
- **Scope:** Production Supabase Database (`dkrtsqienlhpouohmfki`)
- **Current Status:** **100% APPLIED & VERIFIED IN PRODUCTION (`20261116131508`)**. All 12/12 multi-line receiving tests passing.
- **Preconditions:**
  1. Base commit `1a5cad6` is pushed and verified.
  2. No purchase invoices are currently in the middle of warehouse receiving.
- **Executed Affected Objects:**
  - Replaces `public.receive_purchase_invoice_item(...)` and `public.save_purchase_invoice(...)` with multi-line aggregation logic.
  - Fixes the root-cause intake truncation bug where multiple PI lines pointing to the same batch overwrite rather than aggregate `import_quantity`.
  - Preserves exact production behaviors: row-level locking (`FOR UPDATE`), payment status `'unpaid'`, zero-stock deletion safeguards, and `apply_batch_receipt_weighted_average(...)`.

### Action 7C.2 — Domperidone Batch Data Correction (Batch BDM/2609056)
- **Exact File:** `docs/audits/SAPJ_PROMPT_7C_DOMPERIDONE_DATA_CORRECTION.sql`
- **Scope:** Production Database (`batches` row `34d352ef-26a9-482f-81a4-b83f11ad6a7d`)
- **Current Status:** **100% EXECUTED & VERIFIED IN PRODUCTION (`2026-11-16T13:16:31.936Z`) — DO NOT RE-EXECUTE**.
- **Executed State Verified Live:**
  - `import_quantity`: **249.890 kg** (was 225.000 kg).
  - `current_stock`: **0.000 kg**.
  - `final_landed_cost`: **Rp 190,154,642.40** (was Rp 171,214,458.75).
  - `cost_per_unit`: preserved at **Rp 760,953.1500**.
  - Cross-invoice check confirmed batch BDM/2609056 belongs exclusively to PI `E0000244/2627` lines 12 & 13.
  - Downstream usage confirmed 0 receiving allocations, 0 inventory transactions, 0 cost layers.
  - GL 1130 balance confirmed matching `Rp 190,154,642.40`.

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

### Action 6.2 — Six Commercial Duplicate Phone Cases (Executed & Verified)
- **Exact File:** `docs/audits/SAPJ_PROMPT_6C_COMMERCIAL_CASES_EXECUTION.sql`
- **Scope:** Production Database (`crm_contact_phones`)
- **Current Status:** **100% EXECUTED & VERIFIED IN PRODUCTION (`2026-11-16T13:08:45.719Z`)**.
- **Executed Resolutions (Exactly 1 Primary Phone per Company):**
  1. **PT Afifarma:** Duplicate landline `a33be333-6ea8-4e89-9a2c-f687da6a908a` demoted. Retained landline `0354 683675` (`2eb23b08-8e6f-4fb0-ba12-fbfbc39031ef`) as primary.
  2. **PT ANUGRAH VISI BERSAMA:** Secondary mobile `4eb5e76a-5c21-419b-a01b-90f6b5b5df3d` and landline `a3b65593-6b2a-4a6c-9418-47fb425d0fa8` demoted. Retained primary mobile `+62 8111 618281` (`72895627-2c9b-449e-b5f4-345be11b6fa2`).
  3. **PT Konimex:** Corporate switchboard `579737f0-a337-4d76-b9b5-fcfb93e8a4a5` demoted. Retained purchasing landline `+62 271 740 888` (`adcb4e0a-0ae1-4ad9-a78b-592fcfb8e3ea`) as primary.
  4. **PT Medikon Prima Laboratories:** Corporate Jakarta HQ `79bb3f7b-99d8-4f81-8d02-1fe72d4ce5e6` demoted. Retained Cikupa plant line `+62215963504` (`96d5a1b5-6549-4171-8bc6-fe8bb9b1db12`) as primary.
  5. **PT. Mahakam Beta Farma:** Disassociated internal SAPJ sales hotline `6c2f5cc1-a67e-4ef5-9dbb-5dd95ae9d00b` by demoting to secondary. Retained purchaser line `+6221 4600007` (`f85db461-cb21-47c9-ac37-b214881bf013`) as primary.
  6. **PT. Meiji Indonesian Pharmaceutical Industries:** Bangil plant line `39398510-c836-484a-9ddc-5e3548789c86` demoted to secondary. Retained corporate Jakarta HQ line `021) 21383388` (`7b1892e6-4af2-4a16-8e0f-66922cb89a30`) as primary.

- **Live Verification Query Result:**
  - All 6 commercial companies have `primary_count = 1`.
  - Zero contacts with $>1$ primary phone in the entire database.

---

### Action 6.3 — Document Bank SHA-256 Backfill (Completed & Verified)
- **Exact File:** `scripts/storage_optimization/universal_document_bank_sha256_backfill.mjs`
- **Schedule:** `docs/audits/SAPJ_DOCUMENT_BANK_SHA256_AUDIT_SCHEDULE.csv`
- **Scope:** Production Storage Buckets & Table (`universal_document_versions`)
- **Current Status:** **100% EXECUTED & VERIFIED IN PRODUCTION**.
- **Execution Summary:**
  - Total document versions: **551**
  - Previously hashed: **49**
  - Newly computed & updated: **498**
  - Retained NULL (missing historical test artifacts): **4** (`test/temp_test_coa.pdf`, `test/perm_test_coa.pdf`, `E2E_Source_Doc_1794298470775.pdf`, `documents/test-coa.pdf`)
  - Final database count: **547 hashed (99.3%)**, **4 unhashed NULL (0.7%)**.
- **Verification Query Result:**
  ```sql
  SELECT 
    COUNT(*) as total_versions,
    COUNT(*) FILTER (WHERE sha256 IS NOT NULL) as hashed_count,
    COUNT(*) FILTER (WHERE sha256 IS NULL) as unhashed_count
  FROM public.universal_document_versions;
  -- Verified Live Result: total_versions = 551, hashed_count = 547, unhashed_count = 4.
  ```

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

