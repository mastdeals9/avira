# SAPJ / ANZEN ERP — PROMPT 6B: APPROVED CRM PHONE DEMOTIONS PREFLIGHT REPORT

**Date:** November 16, 2026  
**Target Environment:** Local Project (`/Users/Kunal/Documents/anzen-main`)  
**Production Supabase Database:** `dkrtsqienlhpouohmfki` (AWS ap-southeast-1)  
**Database Access Mode:** Strictly **READ-ONLY** (`SET default_transaction_read_only = on;` / `BEGIN READ ONLY;`)  
**Status:** **OWNER APPROVED — PREFLIGHT PASSED (allValid = true) — PENDING FINAL EXECUTION AUTHORIZATION**  
**Execution Companion File:** [`SAPJ_PROMPT_6B_PHONE_DEMOTION_EXECUTION.sql`](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_6B_PHONE_DEMOTION_EXECUTION.sql)

---

## 1. Executive Summary

In response to Prompt 6B, an exhaustive, live, read-only preflight verification was executed across the production Supabase database for the **13 owner-approved CRM phone demotions** across **12 companies** documented in [`SAPJ_PROMPT_6_OWNER_CONFIRMATION_REGISTER.md`](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_6_OWNER_CONFIRMATION_REGISTER.md).

### Preflight Verification Outcome:
- **13 Demote Records Verified:** 100% of target UUIDs exist in production, are currently associated with the correct contact, and have `is_primary = true`.
- **12 Kept Primary Records Verified:** 100% of retained UUIDs exist in production, are currently associated with the correct contact, and have `is_primary = true`.
- **Post-Demotion Projection:** Exactly **1 primary phone** will remain for every single one of the 12 companies (11 companies transition from 2 primaries to 1; PT. SANBE FARMA transitions from 3 primaries to 1 via 2 demotions).
- **Commercial Confirmation Cases:** All 6 unresolved commercial cases remain strictly untouched and multi-primary, excluded from the execution script.
- **Partial Unique Index Status:** The partial unique index `uq_crm_contact_single_primary_phone` remains **BLOCKED** and has not been created, preventing constraint violations against the 6 commercial cases.
- **Production Safety:** Zero UPDATE, DELETE, INSERT, or DDL queries were run against production.

---

## 2. Preflight Audit Verification Table (All 13 Demotions)

Each record was verified against live PostgreSQL via `scripts/audits/preflight_crm_phone_demotions.mjs`:

| # | Company Name | Contact UUID | Demote Phone UUID | Demoted Phone & Type | Keep Primary Phone UUID | Kept Phone & Type | Live Verification Status | Post-Demotion Primary Count |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- | :---: | :---: |
| **1** | DJAMU DJAGO | `28afdb31-babd-4975-a100-26f81dd0fa16` | `1f503482-4f9c-47f1-a572-51df76a59361` | `(024) 3555 805` (landline) | `e1a9a8f1-3e29-48a6-afd2-7882927114d1` | `+62 857-8012-2800` (valid_mobile) | **VERIFIED OK** | **1** (2 - 1) |
| **2** | PT BAHTERA SENTRA NIAGATAMA | `3004a29f-2fbe-48ea-bdc7-b6d0a8119c82` | `f6a9cd15-7e04-4a61-88b8-d4654652e18e` | `+62 21 29616463` (landline) | `957fd44a-1d7a-4bd0-a360-1aaf630505ae` | `+62 812 8705 9088` (valid_mobile) | **VERIFIED OK** | **1** (2 - 1) |
| **3** | PT COMBIPHAR | `cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b` | `b1d0edf0-01a3-475f-9d59-5656d2c0141f` | `021 2933 3031` (landline) | `ee79eea6-d631-4c94-86fa-f0fb75b86fec` | `+62 812-9373-9515` (valid_mobile) | **VERIFIED OK** | **1** (2 - 1) |
| **4** | PT Lloyd Pharma Indonesia | `d6830ce1-7904-4c01-afdd-392205293f40` | `ce170f91-fe35-4729-945c-a73fa22e5e0b` | `021 5902515` (landline) | `633c42a3-d976-43af-897b-638f4cfb8089` | `+6281218163377` (valid_mobile) | **VERIFIED OK** | **1** (2 - 1) |
| **5** | PT Perusahaan Dagang dan Industri Kaliroto | `177e9c47-7c57-438a-911b-5ffca8652ab8` | `086bdf95-f282-4c80-80a6-c0c7f84885a8` | `031  3711717` (landline) | `279e459b-0b22-4ec0-b253-6587308afbb8` | `0813 8600 8316` (valid_mobile) | **VERIFIED OK** | **1** (2 - 1) |
| **6** | PT Prima Cita Prasada | `78958f07-0fdf-4c87-a93d-9a8454f9eb1c` | `0ea5aa2a-7285-4545-a5b9-74ca80a1ee76` | `+62 21 3529 4362` (landline) | `f1f13dad-d70d-40b1-beb6-170b1126c458` | `+62 85876144740` (valid_mobile) | **VERIFIED OK** | **1** (2 - 1) |
| **7** | PT Roi Surya Prima Farma | `ef17e387-502c-4506-8ad7-3dc59e4b2f49` | `20272510-d496-4aa8-8d33-c22d3e5c778c` | `0343  631897` (landline) | `e3db634a-8ecf-4dd1-bb19-563d408d9020` | `0343  631897` (landline) | **VERIFIED OK** | **1** (2 - 1) |
| **8** | PT Shubham Anzen Pharma Jaya | `b768af4b-dd06-4a0e-841f-5a6aa4dd188e` | `c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1` | `+62 21 6583 2426` (landline) | `a4b63186-6fab-4c81-8de1-da9df64bd1b1` | `0817 667 0915` (valid_mobile) | **VERIFIED OK** | **1** (2 - 1) |
| **9** | PT Synergi Mitra Abadi | `2a53b06c-67d1-45da-9c38-edde3be7dc93` | `df629243-0d0d-44ca-af04-a1edb39f3d9a` | `+62 21 3885 6027` (landline) | `f5ff2c11-8056-4574-9531-236808e86e92` | `081270696909` (valid_mobile) | **VERIFIED OK** | **1** (2 - 1) |
| **10** | PT. SANBE FARMA (Demote 1) | `c5d7c938-5878-4bfa-bf44-36e81dddc1a4` | `17da83bf-c7ba-4d0e-9723-e30e49f080c5` | `0224207725` (landline) | `121900ba-053f-4511-874a-30ad153dfef4` | `081296035128` (valid_mobile) | **VERIFIED OK** | **1** (3 - 2) |
| **11** | PT. SANBE FARMA (Demote 2) | `c5d7c938-5878-4bfa-bf44-36e81dddc1a4` | `aab97f7e-2f24-4a1f-977f-0b0e44625171` | `+62 22 603 0036` (landline) | `121900ba-053f-4511-874a-30ad153dfef4` | `081296035128` (valid_mobile) | **VERIFIED OK** | **1** (3 - 2) |
| **12** | PT.Medion Farma Jaya | `986ea4c3-2f2a-4ad2-97d8-f4e758705c5a` | `db76ee70-1c78-4e95-9b31-8b9c79e85394` | `022) 6866090` (landline) | `1a3e642d-6f9a-4974-9abe-861442cba7ff` | `082318183386` (valid_mobile) | **VERIFIED OK** | **1** (2 - 1) |
| **13** | PT.Rama Emerald Multi Sukses | `3b61c088-4b91-4217-835b-3577da389fc0` | `ec57e9b5-b66d-4840-a406-6f2a443a28ee` | `0317507406` (landline) | `26dbb22b-c2ce-401c-a3c0-53951287fac1` | `+62 895-1067-6801` (valid_mobile) | **VERIFIED OK** | **1** (2 - 1) |

---

## 3. Discrepancy Resolution: Kaliroto & Prima Cita Prasada UUIDs

During initial preflight testing, an important discrepancy between the earlier draft register table and live production data was detected and cleanly resolved:

1. **PT Perusahaan Dagang dan Industri Kaliroto (`177e9c47-7c57-438a-911b-5ffca8652ab8`):**
   - *Previous Draft Register:* Listed placeholder UUIDs (`demote: 4944ec58...`, `keep: c7221087...`).
   - *Production Discovery:* These placeholder UUIDs did not exist in the live database. Live inspection of `crm_contact_phones` for contact ID `177e9c47-7c57-438a-911b-5ffca8652ab8` revealed two exact rows:
     - Row 1: `id = 086bdf95-f282-4c80-80a6-c0c7f84885a8`, `raw_phone = '031  3711717'`, `phone_type = 'landline'`, `is_primary = true`.
     - Row 2: `id = 279e459b-0b22-4ec0-b253-6587308afbb8`, `raw_phone = '0813 8600 8316'`, `phone_type = 'valid_mobile'`, `is_primary = true`.
   - *Resolution:* Target UUIDs corrected in the execution SQL and reference register to demote landline `086bdf95-f282-4c80-80a6-c0c7f84885a8` and retain mobile `279e459b-0b22-4ec0-b253-6587308afbb8`. Preflight verified: **PASS**.

2. **PT Prima Cita Prasada (`78958f07-0fdf-4c87-a93d-9a8454f9eb1c`):**
   - *Previous Draft Register:* Listed placeholder UUIDs (`demote: 11ec91ce...`, `keep: 2d11ec01...`).
   - *Production Discovery:* These placeholder UUIDs did not exist in the live database. Live inspection of `crm_contact_phones` for contact ID `78958f07-0fdf-4c87-a93d-9a8454f9eb1c` revealed two exact rows:
     - Row 1: `id = 0ea5aa2a-7285-4545-a5b9-74ca80a1ee76`, `raw_phone = '+62 21 3529 4362'`, `phone_type = 'landline'`, `is_primary = true`.
     - Row 2: `id = f1f13dad-d70d-40b1-beb6-170b1126c458`, `raw_phone = '+62 85876144740'`, `phone_type = 'valid_mobile'`, `is_primary = true`.
   - *Resolution:* Target UUIDs corrected in the execution SQL and reference register to demote landline `0ea5aa2a-7285-4545-a5b9-74ca80a1ee76` and retain mobile `f1f13dad-d70d-40b1-beb6-170b1126c458`. Preflight verified: **PASS**.

---

## 4. Exclusion & Protection of 6 Commercial Confirmation Cases

Per the Prompt 6B instruction, all 6 commercial confirmation cases have been **strictly excluded** from this execution package. They remain in their verified multi-primary state pending business owner review:

| # | Company Name | Contact UUID | Total Phones | Primary Phones | Commercial Decision Required | Status in This Package |
| :---: | :--- | :--- | :---: | :---: | :--- | :---: |
| **1** | PT Afifarma | `80ee11cf-7eb3-4054-bd65-b1bafcf2686b` | 3 | 2 | Plant line vs General office line | **EXCLUDED / UNTOUCHED** |
| **2** | PT ANUGRAH VISI BERSAMA | `caad7c41-ad40-47ba-bde0-bf3f505390fa` | 3 | 3 | 3 distinct mobile sales reps | **EXCLUDED / UNTOUCHED** |
| **3** | PT Konimex | `e53d1921-62fa-4310-b0da-91535adbe194` | 4 | 2 | General switchboard vs Silvia Margaretha extension | **EXCLUDED / UNTOUCHED** |
| **4** | PT Medikon Prima Laboratories | `6b4325d8-b79a-4602-9fd0-91e0df65bd03` | 2 | 2 | Jakarta Head Office vs Ms Fiona Tangerang plant line | **EXCLUDED / UNTOUCHED** |
| **5** | PT. Mahakam Beta Farma | `987b5d43-e04d-419b-a399-a5240096cfdd` | 3 | 2 | Cross-entity collision with SAPJ hotline (`0817 667 0915`) | **EXCLUDED / UNTOUCHED** |
| **6** | PT. Meiji Indonesian Pharm. Ind. | `17feb96c-4506-4913-87ae-81f778f101cc` | 2 | 2 | Jakarta HO vs Mr Suhandik Bangil plant line | **EXCLUDED / UNTOUCHED** |

### Database Constraint Protection:
Because these 6 commercial cases remain with multiple primary phones, the partial unique index:
```sql
CREATE UNIQUE INDEX uq_crm_contact_single_primary_phone 
ON public.crm_contact_phones (contact_id) 
WHERE is_primary = true;
```
remains **BLOCKED** and has not been created in production. Attempting to create it would fail immediately with a PostgreSQL duplicate key error (`23505`).

---

## 5. Execution Package Specifications

The transaction-safe execution script has been written to:
[`docs/audits/SAPJ_PROMPT_6B_PHONE_DEMOTION_EXECUTION.sql`](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_6B_PHONE_DEMOTION_EXECUTION.sql)

### Safety Architecture of the Execution Script:
1. **Fully Atomic:** Wrapped in `BEGIN ... COMMIT` with automatic rollback on any precondition or postcondition assertion failure.
2. **Step 1 — Precondition Verification Block:**
   - Validates that all 13 demote targets exist and are currently `is_primary = true`.
   - Validates that all 12 keep targets exist and are currently `is_primary = true`.
   - If any count $\neq 13$ or $\neq 12$, raises `EXCEPTION` and rolls back immediately.
3. **Step 2 — Targeted Update:**
   - Executes single targeted update:
     ```sql
     UPDATE public.crm_contact_phones
     SET is_primary = false, updated_at = NOW()
     WHERE id IN (...) AND is_primary = true;
     ```
4. **Step 3 — Postcondition Assertions:**
   - Asserts `GET DIAGNOSTICS v_rows_updated = ROW_COUNT;` equals exactly **13**.
   - Asserts that all 12 contacts have `COUNT(*) FILTER (WHERE is_primary = true) = 1`.
   - If any assertion fails, raises `EXCEPTION` and aborts transaction.
5. **Rollback SQL Script Included:**
   - Provides idempotent reversal SQL restoring all 13 records back to `is_primary = true` if ever requested by the owner.

---

## 6. Recommended Execution Procedure for Owner

When the owner decides to execute this approved demotion in production:

1. Open Supabase Dashboard -> **SQL Editor** on project `dkrtsqienlhpouohmfki`.
2. Paste and run the entire contents of [`SAPJ_PROMPT_6B_PHONE_DEMOTION_EXECUTION.sql`](file:///Users/Kunal/Documents/anzen-main/docs/audits/SAPJ_PROMPT_6B_PHONE_DEMOTION_EXECUTION.sql).
3. Confirm output displays:
   - `NOTICE: PRECONDITION CHECK PASSED: All 13 demote targets and 12 keep targets are present and primary.`
   - `NOTICE: POSTCONDITION CHECK PASSED: Exactly 13 rows updated. All 12 contacts have exactly 1 primary phone remaining.`
   - `DEMOTION SUCCESSFUL: 13 records demoted across 12 companies.`
4. To verify in the UI, navigate to CRM -> Customers. The 12 companies will now display a single primary phone badge without multi-primary warnings.

