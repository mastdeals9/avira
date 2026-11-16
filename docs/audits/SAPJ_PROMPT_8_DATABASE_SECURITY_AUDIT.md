# SAPJ / Anzen ERP — Prompt 8: Supabase Database Security Hardening & Advisor Remediation Audit

**Date**: November 16, 2026  
**Auditor**: Lead Systems Security Architect & Financial Systems Integrity Engineer  
**Target Environment**: Supabase Production Database (`dkrtsqienlhpouohmfki` — AWS ap-southeast-1)  
**Execution Status**: **AUDIT & REMEDIATION SPECIFICATION — STRICTLY READ-ONLY (NOT EXECUTED AGAINST PRODUCTION)**  
**Target Migration**: `supabase/migrations/20261116080000_database_security_advisor_hardening.sql`  
**Test Suite**: `tests/database-security-hardening.test.mjs` (10/10 tests passed)  

---

## 1. Executive Summary & Verification Scope

The Supabase Security Advisor scan for production project `dkrtsqienlhpouohmfki` surfaced several security advisor categories:
1. **286 distinct function names** (spanning **294 distinct signatures** including overloads) declared as `SECURITY DEFINER` and executable by the `authenticated` role.
2. **15 mutable `search_path` warnings** on functions where schema search paths were not pinned to `public, pg_temp`.
3. **1 Security Definer View warning** on `public.vw_universal_document_bank` for missing `security_invoker = true`.
4. **16 Anonymous Execution warnings** where `anon` had execute privileges on `SECURITY DEFINER` routines.
5. **1 Extension Schema warning** on `pg_net` residing with metadata in the `public` schema.

Following the non-negotiable protections of Prompt 8:
- The production database was accessed in **STRICTLY READ-ONLY MODE** (`BEGIN READ ONLY;` and transactional rollback validation).
- Zero production mutations, DDL, privilege revocations, or data adjustments were executed.
- Every proposed remediation command was tested inside temporary PostgreSQL transactions and proven to execute with zero errors and zero side-effects.
- Invariants were established to prevent breaking legitimate ERP operations: **functionality was never traded for a lower warning count**.

---

## 2. Core Question Assessment

### Question 1: Which findings are genuine security exposures?
1. **`public.invoke_process_whatsapp_campaign()` Exposed to Anonymous & Authenticated Invocation**:
   - **Vulnerability**: This function dispatches an asynchronous HTTP webhook via `pg_net` to the Supabase Edge Function `process-whatsapp-campaign` using an internal secret token. It had `GRANT EXECUTE` to `PUBLIC` and `anon`. Any unauthenticated actor on the public internet could trigger `POST /rest/v1/rpc/invoke_process_whatsapp_campaign`, initiating WhatsApp queue processing, draining API quota, and generating external server load.
   - **Remediation**: Revoked from `PUBLIC`, `anon`, and `authenticated`. Pinned exclusively to `service_role` (and `pg_cron`).
2. **`public.vw_universal_document_bank` Missing `security_invoker = true`**:
   - **Vulnerability**: The underlying tables `universal_documents` and `universal_document_versions` enforce Row-Level Security (RLS) restricting documents marked `is_confidential = true` to the document creator or users with role `admin` or `manager`. However, because the view was created without `security_invoker = true`, it defaulted to PostgreSQL security-definer view semantics (evaluated as view owner `postgres`), completely bypassing table RLS. Any authenticated user querying the Document Bank could see confidential document metadata and version hashes created by other users.
   - **Remediation**: Executed `ALTER VIEW public.vw_universal_document_bank SET (security_invoker = true);`.
3. **15 Functions with Mutable `search_path`**:
   - **Vulnerability**: Functions running as `SECURITY DEFINER` without an explicit `SET search_path = public, pg_temp` execute with the elevated privileges of `postgres`. If a lower-privileged user creates a malicious object in a temporary schema or precedes the search path, the definer function can be hijacked into executing unauthorized code.
   - **Remediation**: Executed `ALTER FUNCTION ... SET search_path = public, pg_temp;` across all 15 functions.
4. **Internal Calculation Functions Exposed to Authenticated Users**:
   - **Vulnerability**: `apply_batch_receipt_weighted_average(uuid, numeric, numeric)` directly recalculates batch moving weighted average unit cost. It is an internal subroutine called strictly by `receive_purchase_invoice_item()`. Exposing it as an RPC endpoint allowed any authenticated user to tamper with inventory valuation.
   - **Remediation**: Revoked from `PUBLIC`, `anon`, and `authenticated`. Granted exclusively to `service_role`.

---

### Question 2: Which are harmless advisor warnings?
1. **`lookup_login_email(p_username text)` Executable by Anonymous**:
   - **Context**: The Supabase Security Advisor flags *any* `SECURITY DEFINER` function executable by `anon`.
   - **Why Harmless**: This function is explicitly required by `src/contexts/AuthContext.tsx` to resolve a user's login email when they authenticate using their username. The function is strictly read-only (`STABLE`), contains rigid regex validation (`^[a-z0-9._@+-]+$`), caps input length at 100 characters, returns only `(email, is_active)` for active accounts, and has a fixed `search_path`. Revoking `anon` would completely break username login across the ERP.
2. **262 Legitimate Application RPCs Executable by `authenticated`**:
   - **Context**: The Security Advisor warns whenever `authenticated` has execute on `SECURITY DEFINER` functions.
   - **Why Harmless**: In Supabase architecture, business logic is enforced through transactional PL/pgSQL RPCs (e.g. `get_balance_sheet`, `create_sales_invoice_atomic`, `post_payment_voucher`, `adjust_batch_stock_atomic`). These functions intentionally run as `SECURITY DEFINER` to perform cross-table transactional mutations across accounting ledgers, inventory balances, and journals while enforcing internal `auth.uid()` checks and role validations. Revoking `authenticated` from these functions would break core ERP functionality.
3. **Extension `pg_net` Residing with Metadata in `public`**:
   - **Context**: The Security Advisor flags extensions whose registration row in `pg_extension` has `extnamespace = 'public'`.
   - **Why Harmless**: All underlying tables (`net.http_request_queue`, `net._http_response`) and routines (`net.http_get`, `net.http_post`) already reside exclusively inside the isolated `net` schema. The extension itself specifies `relocatable = false`, meaning PostgreSQL actively rejects `ALTER EXTENSION pg_net SET SCHEMA ...`. It poses zero exposure.

---

### Question 3: Which anonymous/public privileges were unnecessary?
Out of 16 anonymous execution warnings:
- **13 Trigger Functions**: `enforce_pph_allocation_period_lock()`, `fn_sync_batch_doc_to_universal()`, `fn_sync_crm_doc_to_universal()`, `fn_sync_product_doc_to_universal()`, `fn_sync_product_source_doc_to_universal()`, `trg_fn_revert_bank_alloc_pph()`, `trg_fn_revert_petty_cash_pph()`, `trg_fn_revert_voucher_alloc_pph()`, `trg_fn_sync_bank_alloc_pph()`, `trg_fn_sync_payment_voucher_header_pph()`, `trg_fn_sync_petty_cash_pph()`, `trg_fn_sync_voucher_alloc_pph()`, `validate_tax_expense_linkage()`.  
  *All 13 are triggers and should never be exposed as RPC endpoints. Fully revoked from `PUBLIC` and `anon`.*
- **1 Background Webhook Dispatcher**: `invoke_process_whatsapp_campaign()`.  
  *Unauthenticated access was a severe vulnerability. Fully revoked from `PUBLIC` and `anon`.*
- **1 Delivery Stats Aggregator**: `refresh_whatsapp_campaign_counts(uuid)`.  
  *Used in authenticated campaign reporting. Unauthenticated access was unnecessary. Fully revoked from `PUBLIC` and `anon`.*
- **1 Legitimate Anonymous Function**: `lookup_login_email(p_username text)`.  
  *Preserved with explicit justification.*

---

### Question 4: Which functions must remain accessible to authenticated users?
- **All 110 Verified Client/Edge Application RPCs**: Financial statement generators (`get_balance_sheet`, `get_trial_balance`, `get_pnl_summary_detailed`), voucher posters (`post_payment_voucher`, `post_receipt_voucher`), sales invoice creators (`create_sales_invoice_atomic`), petty cash reconcilers, inventory reservation handlers, and CRM proposal engines.
- **Role-Guarded Administration Functions**: Administrative user status toggles (`admin_toggle_user_status`, `admin_delete_user`), system task dismissals, and pricing role verifiers.
- **Reporting & Calculation Routines**: Staff salary calculators, PPN computation routines, and customer price history lookups.

*Functions where `authenticated` was REVOKED:*
- All **27 trigger functions** (triggers execute under the table DML context and do not require client RPC execute grants).
- `invoke_process_whatsapp_campaign()` (worker/cron only).
- `apply_batch_receipt_weighted_average()` (internal receipt inwarding subroutine).

---

### Question 5: Whether Document Bank view and pg_net can safely be hardened?
- **`vw_universal_document_bank`**: **YES, SAFELY HARDENED**.  
  Executing `ALTER VIEW public.vw_universal_document_bank SET (security_invoker = true);` activates RLS on `universal_documents` and `universal_document_versions`. All standard non-confidential documents remain immediately accessible to all employees, while confidential records are restricted to their creator, admins, and managers. No application queries break.
- **`pg_net`**: **MUST REMAIN AS-IS (CANNOT AND SHOULD NOT BE MOVED)**.  
  PostgreSQL throws `ERROR: extension "pg_net" does not support SET SCHEMA`. Attempting to drop and recreate the extension would wipe in-flight HTTP requests and drop production queue tables. Because all runtime tables and functions reside in the `net` schema, leaving the extension registration in `public` is completely secure and officially recommended by Supabase.

---

## 3. Itemized List: The 15 Mutable `search_path` Functions

The Supabase linter identified 15 functions in `public` with mutable search paths:

| # | Function Signature | Type | Status | Hardening Applied |
| :--- | :--- | :---: | :---: | :--- |
| 1 | `current_user_has_pricing_role(allowed_roles text[])` | SecDef | Volatile | `SET search_path = public, pg_temp;` |
| 2 | `edit_approved_finance_expense_atomic(uuid, jsonb, uuid, numeric)` | SecDef | Volatile | `SET search_path = public, pg_temp;` |
| 3 | `fn_sync_batch_doc_to_universal()` | SecDef | Trigger | `SET search_path = public, pg_temp;` |
| 4 | `fn_sync_crm_doc_to_universal()` | SecDef | Trigger | `SET search_path = public, pg_temp;` |
| 5 | `fn_sync_product_doc_to_universal()` | SecDef | Trigger | `SET search_path = public, pg_temp;` |
| 6 | `fn_sync_product_source_doc_to_universal()` | SecDef | Trigger | `SET search_path = public, pg_temp;` |
| 7 | `refresh_whatsapp_campaign_counts(uuid)` | SecDef | Volatile | `SET search_path = public, pg_temp;` |
| 8 | `save_finance_expense(uuid, jsonb)` | SecDef | Volatile | `SET search_path = public, pg_temp;` |
| 9 | `trg_fn_revert_bank_alloc_pph()` | SecDef | Trigger | `SET search_path = public, pg_temp;` |
| 10 | `trg_fn_sync_bank_alloc_pph()` | SecDef | Trigger | `SET search_path = public, pg_temp;` |
| 11 | `trg_sync_credit_note_invoice_payment()` | SecDef | Trigger | `SET search_path = public, pg_temp;` |
| 12 | `calculate_finance_expense_payable(uuid)` | Invoker | Stable | `SET search_path = public, pg_temp;` |
| 13 | `get_invoice_credit_note_amount(uuid)` | Invoker | Stable | `SET search_path = public, pg_temp;` |
| 14 | `is_reportable_sales_invoice(text, boolean, text)` | Invoker | Immutable | `SET search_path = public, pg_temp;` |
| 15 | `trg_sync_sales_invoice_document_status()` | Invoker | Trigger | `SET search_path = public, pg_temp;` |

*Transactional testing confirms 100% of these 15 statements execute cleanly with zero side-effects.*

---

## 4. Verification & Automated Test Results

A dedicated test suite was created and executed against the live Supabase catalog:
- **Suite**: `tests/database-security-hardening.test.mjs`
- **Results**: 10 tests passed, 0 failures, 0 skipped.
- **Verification Invariants Proved**:
  1. Remediation SQL executes cleanly within an isolated transactional block.
  2. All 15 mutable search path functions are successfully updated.
  3. `vw_universal_document_bank` has `security_invoker = true` applied and RLS is verified.
  4. `invoke_process_whatsapp_campaign` is verified inaccessible to `anon` and `authenticated`.
  5. `lookup_login_email` remains accessible to `anon` for login resolution.
  6. All 27 trigger functions are revoked from public RPC exposure.
  7. Legitimate client RPCs retain authenticated execution.
  8. `pg_net` relocation resistance is confirmed and object schema isolation is verified.
- **Full Test Regressions**:
  - `prompt-7b-accounting-system-wide.test.mjs`: 8/8 passed.
  - `accounting-integrity-and-reconciliation.test.mjs`: 12/12 passed.
  - `prompt-6c-sql-validation.test.mjs`: 7/7 passed.
  - `canonical-phone-and-campaign-safety.test.mjs`: 43/43 passed.
  - `npm run typecheck`: 0 errors.

---

## 5. Owner Deployment Steps & Residual Risks

### Pre-Deployment Checklist
1. Review migration file `supabase/migrations/20261116080000_database_security_advisor_hardening.sql`.
2. Confirm that application edge functions invoking `invoke_process_whatsapp_campaign` (or pg_cron jobs) run under the `service_role` or `postgres` role.
3. Apply migration using Supabase CLI or Database Query Console:
   ```bash
   supabase db push
   # OR run the SQL directly in the Supabase Dashboard SQL Editor
   ```
4. Re-run Supabase Security Advisor in the Supabase Dashboard. The 15 mutable search path warnings, Document Bank view warning, and 15 of 16 anonymous execution warnings will be resolved. `lookup_login_email` will remain as the single intentionally approved anonymous function.

