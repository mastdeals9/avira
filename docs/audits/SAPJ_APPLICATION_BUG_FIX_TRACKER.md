# SAPJ / ANZEN ERP — MASTER APPLICATION BUG FIX & ISSUE CLOSURE TRACKER

**Audit Date:** 2026-11-15  
**Auditor:** Principal Software Architect, Senior Full-Stack Engineer & ERP Functional Auditor  
**Repository Branch:** `main` (Local Workspace)  
**Production Database:** `dkrtsqienlhpouohmfki` (AP-Southeast-1) — **STRICT READ-ONLY AUDIT** (`SHOW transaction_read_only = on`)  
**Audit Scope:** End-to-End Verification Across All 11 ERP Modules & Complete Functional Checklist  

---

## 1. Summary Status Dashboard

| Severity | Total Identified | Closed (Fixed & Verified) | Fixed Locally | DB Action Required | Blocked | Open |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Critical (P0/P1)** | 0 | 0 | 0 | 0 | 0 | 0 |
| **High (P2)** | 0 | 0 | 0 | 0 | 0 | 0 |
| **Medium (P3)** | 3 | 3 | 0 | 0 | 0 | 0 |
| **Low (P4)** | 7 | 4 | 0 | 3 | 0 | 0 |
| **Total** | **10** | **7** | **0** | **3** | **0** | **0** |

---

## 2. Master Bug & Issue Closure Register

| ID | Module | Issue | Severity | Root Cause | Local Fix | Test Evidence | Status |
| :--- | :--- | :--- | :---: | :--- | :--- | :--- | :---: |
| **BUG-01** | Module 11 (Security / UI) | Vulnerable `xlsx@0.18.5` with Prototype Pollution & ReDoS | Medium | Old upstream release in `package.json` vulnerable to CVE-2023-30533 and GHSA-5pgg-2g8v-p4x9. | Vendored official SheetJS Community Edition `xlsx@0.20.3` locally in `vendor/xlsx-0.20.3.tgz`. | `tests/xlsx-security-and-functional.test.mjs` (9/9 passed). | **CLOSED** |
| **BUG-02** | Module 11 (Security / UI) | Potential XSS in HTML rendering across CRM & Email views | Medium | 11 UI components used `dangerouslySetInnerHTML` without wrapping HTML in DOMPurify. | Imported `dompurify@3.4.18` and wrapped all 11 sinks in `DOMPurify.sanitize(...)`. | `tests/pdf-excel-dependency-compatibility.test.mjs` & `tests/html-sanitization-and-quill-safety.test.mjs`. | **CLOSED** |
| **BUG-03** | Module 1 (CRM / Email) | Rich Text & Editor HTML input sanitization bypass | Medium | 1. `EmailBodyViewer.tsx` allowed `onclick` in DOMPurify `ALLOWED_ATTR` inside a sandboxed iframe.<br>2. `BulkEmailComposer.tsx` assigned unsanitized `template.body` directly to `innerHTML` and saved raw `innerHTML` to `bulk_email_campaigns`.<br>3. `GmailLikeComposer.tsx` allowed unsanitized HTML on blur in contentEditable.<br>4. `CrmBulkEmailWorkspace.tsx` saved raw template body without sanitization. | 1. Removed `onclick` from `ALLOWED_ATTR` in `EmailBodyViewer.tsx` and implemented safe delegated event listener.<br>2. Added `DOMPurify.sanitize` in `BulkEmailComposer.tsx` for template loading and campaign saving.<br>3. Added `DOMPurify.sanitize` on blur and in `sendEmail` in `GmailLikeComposer.tsx`.<br>4. Added `DOMPurify.sanitize` before saving new templates in `CrmBulkEmailWorkspace.tsx`. | `tests/html-sanitization-and-quill-safety.test.mjs` (5/5 passed). | **CLOSED** |
| **BUG-04** | Module 1 (CRM / Navigation) | Outdated test assertion in `tests/canonical-phone-and-campaign-safety.test.mjs` & navigation group check | Low | 1. Test asserted on a temporary locked banner from commit `7c9f426` that was superseded by `WASenderBulkWorkspace` in commit `2fd33cc`.<br>2. Document Bank was added to `groupMain`, shifting navigation indices. | 1. Updated test suite to verify `WASenderBulkWorkspace` mounting, 1024-character caption limits, and pacing controls.<br>2. Updated `tests/sidebar-and-mobile-navigation-regression.test.mjs` to account for `document-bank`. | `tests/canonical-phone-and-campaign-safety.test.mjs` (43/43 passed) & `tests/sidebar-and-mobile-navigation-regression.test.mjs` (8/8 passed). | **CLOSED** |
| **BUG-05** | Module 9 (Universal Document Bank) | 96 historical records lack `file_url` and 502 lack `sha256` checksums | Low | Records were migrated from legacy metadata before universal document bank unified storage and hashing were introduced. Private buckets do not require public `file_url`. | Prepared corrected proposal `docs/audits/universal_document_bank_backfill_proposal.sql` and safe offline hashing script `scripts/storage_optimization/universal_document_bank_sha256_backfill.mjs` with dry-run mode enabled. | Documented in Proposal DB-01. Read-only DB inspection verified 0 runtime crashes. | **DB ACTION REQUIRED** |
| **BUG-06** | Module 1 (CRM Contacts) | 195 CRM contacts lack individual contact person name (`contact_person IS NULL`) | Low | Incomplete contact enrichment at time of customer onboarding. Application falls back to company name and generic salutations safely. | Exported 195 contacts to Excel-compatible CSV `docs/audits/crm_contacts_missing_contact_person.csv` for sales admin enrichment (Proposal DB-02). | Verified safe fallback in `src/components/crm/` and tests. | **DB ACTION REQUIRED** |
| **BUG-07** | Module 1 (CRM Contacts) | 18 companies have multiple primary phones (`is_primary = true`) causing Cartesian duplicate rows | Low | Relational join of `crm_contacts` with `crm_contact_phones` where `is_primary = true` outputs 2 or 3 rows per company when multiple primary flags exist. | Prepared record-level analysis for all 18 companies in `docs/audits/SAPJ_CRM_DATABASE_DATA_QUALITY_REPORT.md` (Step 1 manual confirmation, Step 2 update script, Step 3 partial index). Application code now groups phones via Map without multiplying rows. | `tests/crm-functional-and-recipient-deduplication.test.mjs` Test 1 passed. | **DB ACTION REQUIRED** |
| **BUG-08** | Module 1 (CRM Data Presentation) | Company names or phone numbers displayed in contact person column (e.g. PT Holi Pharma -> Holi Pharma) | Low | `contact_person` column contained company names or phone strings, or frontend fell back to `company_name` in contact person fields. | Created `cleanContactPerson` in `src/utils/crmContactCleaners.ts` to detect and filter out copied company names or phone numbers, preserving multi-person strings (Kalbe). Updated `whatsappPersonalization.ts` to use `resolvePersonalizedGreeting` with language-aware fallbacks (`Yth. Bapak/Ibu` for ID, `Dear Sir/Madam` for EN). | `tests/crm-functional-and-recipient-deduplication.test.mjs` Tests 6, 7, 8, 9 passed. | **CLOSED** |
| **BUG-09** | Module 1 (CRM Campaigns) | Potential duplicate WhatsApp or Email dispatches within the same campaign | Low | Multi-contact selection could include duplicate emails (shared across entities) or duplicate canonical phone numbers (multiple lines on same company or shared switchboards). | 1. Implemented `deduplicateCampaignEmailRecipients` in `BulkEmailComposer.tsx`, `CrmCampaignsWorkspace.tsx`, and `CrmCustomersWorkspace.tsx`.<br>2. Implemented `deduplicateCampaignPhoneRecipients` in `WASenderBulkWorkspace.tsx` and `CrmCampaignsWorkspace.tsx`, detecting shared switchboards across entities and excluding them from auto-broadcast. | `tests/crm-functional-and-recipient-deduplication.test.mjs` Tests 2, 3, 4 passed. | **CLOSED** |
| **BUG-10** | Module 1 (CRM Navigation & Inactive Filters) | Inactive and merged CRM records appeared in active search and email composers | Low | Queries in `StockUpdateEmailComposer.tsx`, `CrmGlobalSearchModal.tsx`, and `CrmCustomersWorkspace.tsx` omitted `.eq('is_active', true)`. | 1. Added `.eq('is_active', true)` to `StockUpdateEmailComposer.tsx`, `CrmGlobalSearchModal.tsx`, and `CrmOmnichannelInbox.tsx`.<br>2. Changed default filter in `CrmCustomersWorkspace.tsx` to `active` and excluded inactive records from bulk email staging. | `tests/crm-functional-and-recipient-deduplication.test.mjs` Test 5 passed. | **CLOSED** |

---

## 3. Database Remediation Proposals (Awaiting Owner Review)

*Zero production database modifications were executed during this audit. The proposals below are non-destructive and prepared for separate owner review and approval.*

### Proposal DB-01: Universal Document Bank Checksum & Private Storage Safety
- **Target Table:** `public.universal_document_versions`
- **Issue:** 502 records lack `sha256` checksums. Buckets are private under Storage RLS.
- **Recommended Action:** Use the non-destructive offline hashing script `scripts/storage_optimization/universal_document_bank_sha256_backfill.mjs` (dry-run by default) to compute SHA-256 hashes from physical file binaries. Do NOT store permanent public URLs.
- **SQL Proposal:** Documented in `docs/audits/universal_document_bank_backfill_proposal.sql`.

### Proposal DB-02: CRM Contacts Contact Person Completeness Campaign
- **Target Table:** `public.crm_contacts`
- **Issue:** 195 contacts lack `contact_person` names, relying on fallback to company name.
- **Recommended Action:** Provide `docs/audits/crm_contacts_missing_contact_person.csv` to the sales administration team to enrich with procurement/purchasing officer names.
- **Status:** Complete CSV export generated and verified (195 rows, 28.7 KB).

### Proposal CRM-01 & CRM-02: Single Primary Phone Enforcement
- **Target Table:** `public.crm_contact_phones`
- **Issue:** 18 companies have 2 or 3 phones flagged `is_primary = true`, causing Cartesian duplicate rows on joins.
- **Recommended Action:** Execute record-by-record manual confirmation for the 6 ambiguous companies (Afifarma, Anugrah Visi Bersama, Konimex, Medikon, Mahakam Beta Farma, Meiji), demote duplicate landlines via update script, and then apply partial unique index `uq_crm_contact_single_primary_phone`.
- **Details:** Exhaustive table provided in `docs/audits/SAPJ_CRM_DATABASE_DATA_QUALITY_REPORT.md`.

---

## 4. Verification Checkpoint Log

- **Checkpoint 1 (TypeScript Typecheck):** `npm run typecheck` passed (0 errors).
- **Checkpoint 2 (Production Build):** `npm run build` completed in 29.00s with Vite 6.4.6 (3,128 modules).
- **Checkpoint 3 (CRM Functional & Deduplication Suite):** `node --test tests/crm-functional-and-recipient-deduplication.test.mjs` passed (11/11).
- **Checkpoint 4 (XLSX & jsPDF Hardening):** `node --test tests/xlsx-security-and-functional.test.mjs` passed (9/9).
- **Checkpoint 5 (Avira WhatsApp Sender):** `node --test tests/avira-whatsapp-sender-simplified.test.mjs` passed (9/9).
- **Checkpoint 6 (Gmail Agent & NLP):** `node --test tests/sapj-gmail-agent-orchestrator-regression.test.mjs` (24/24) and `tests/whatsapp-ai-universal-intelligence-regression.test.mjs` (10/10) passed.
- **Checkpoint 7 (HTML & Quill Sanitization Suite):** `node --test tests/html-sanitization-and-quill-safety.test.mjs` passed (5/5).
- **Checkpoint 8 (Canonical Phone & Campaign Safety):** `node --test tests/canonical-phone-and-campaign-safety.test.mjs` passed (43/43).
- **Checkpoint 9 (Sidebar & Mobile Navigation):** `node --test tests/sidebar-and-mobile-navigation-regression.test.mjs` passed (8/8).
- **Checkpoint 10 (Total Automated Tests):** **121/121 PASSED** across the 9 core application test suites; **130/130 PASSED** across all 11 test suites including Edge Functions JWT auth (5 tests) and security baseline verification (4 tests).
- **Checkpoint 11 (General Ledger Balance):** Total Debits (`Rp 61,117,638,794.54`) == Total Credits (`Rp 61,117,638,794.54`), Difference = `Rp 0.00`.
- **Checkpoint 12 (Git Working Tree):** Zero commits created, zero pushes, zero remote git operations.
