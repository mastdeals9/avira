# SAPJ ERP — Prompt 6C: CRM Contact Integrity & Document Bank Closure Report

**Audit Cut-Off Date:** 16 November 2026  
**Target Environment:** Local Project `/Users/Kunal/Documents/anzen-main`  
**Production Database:** Supabase `dkrtsqienlhpouohmfki` (AWS ap-southeast-1)  
**Safety Status:** Production Supabase accessed strictly in **READ-ONLY** mode (`SET default_transaction_read_only = on`).  
**Production Mutation Status:** **ZERO** unapproved mutations executed. All verification performed via read-only queries and simulated rollback transactions.

---

## 1. Executive Summary & Workstream Status

The Prompt 6C CRM database integrity audit encompasses:
1. **Preservation of 12 Companies (13 Prior Demotions):** Live production database verified that all 12 companies previously corrected under Prompt 6B/6C currently possess **exactly one primary phone record**.
2. **Resolution of the Six Commercial Cases:** The 6 remaining companies with multiple primaries have been thoroughly investigated. A full decision matrix has been compiled with exact phone IDs, contact persons, locations, and rationale (`docs/audits/SAPJ_PROMPT_6C_SIX_CASE_DECISION_MATRIX.md`).
3. **Execution Script Prepared & Verified:** `docs/audits/SAPJ_PROMPT_6C_COMMERCIAL_CASES_EXECUTION.sql` was authored with pessimistic row-level locking, explicit row-count assertions (`v_rows_updated = 7`), post-condition checks, and conditional rollback procedures. It executes cleanly in transaction simulation.
4. **Document Bank SHA-256 Schedule Generated:** The 502 unhashed document records were traced against live `storage.objects`:
   - **497 records:** Verified available in Supabase storage buckets (`batch-documents`: 323, `product-documents`: 91, `crm-documents`: 44, `product-source-documents`: 40).
   - **1 record:** Verified available in storage with URL-encoded space path (`WhatsApp%20Image`).
   - **4 records:** Formally classified as legacy development zero-byte test artifacts (`temp_test_coa.pdf`, `test-coa.pdf`, `perm_test_coa.pdf`, `E2E_Source_Doc_1794298470775.pdf`).
   - The authoritative schedule is persisted at `docs/audits/SAPJ_DOCUMENT_BANK_SHA256_AUDIT_SCHEDULE.csv`.
5. **Partial Unique Index Migration Ready:** `supabase/migrations/20261116090000_enforce_single_primary_phone_per_contact.sql` enforces `uq_crm_contact_single_primary_phone` on `(contact_id) WHERE (is_primary = true)` with preflight safety checks.

---

## 2. Status of the 12 Previously Demoted Companies

A live query against `public.crm_contact_phones` confirms that all 12 companies have maintained single-primary integrity:

| Company Name | Contact ID | Total Phones | Primary Phones | Integrity Status |
| :--- | :--- | :--- | :--- | :--- |
| DJAMU DJAGO | `28afdb31-babd-4975-a100-26f81dd0fa16` | 3 | **1** | **VERIFIED** |
| PT BAHTERA SENTRA NIAGATAMA | `3004a29f-2fbe-48ea-bdc7-b6d0a8119c82` | 2 | **1** | **VERIFIED** |
| PT COMBIPHAR | `cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b` | 2 | **1** | **VERIFIED** |
| PT Lloyd Pharma Indonesia | `d6830ce1-7904-4c01-afdd-392205293f40` | 3 | **1** | **VERIFIED** |
| PT Perusahaan Dagang dan Industri Kaliroto | `177e9c47-7c57-438a-911b-5ffca8652ab8` | 2 | **1** | **VERIFIED** |
| PT Prima Cita Prasada | `78958f07-0fdf-4c87-a93d-9a8454f9eb1c` | 2 | **1** | **VERIFIED** |
| PT Roi Surya Prima Farma | `ef17e387-502c-4506-8ad7-3dc59e4b2f49` | 2 | **1** | **VERIFIED** |
| PT Shubham Anzen Pharma Jaya | `b768af4b-dd06-4a0e-841f-5a6aa4dd188e` | 3 | **1** | **VERIFIED** |
| PT Synergi Mitra Abadi | `2a53b06c-67d1-45da-9c38-edde3be7dc93` | 3 | **1** | **VERIFIED** |
| PT. SANBE FARMA | `c5d7c938-5878-4bfa-bf44-36e81dddc1a4` | 3 | **1** | **VERIFIED** |
| PT.Medion Farma Jaya | `986ea4c3-2f2a-4ad2-97d8-f4e758705c5a` | 3 | **1** | **VERIFIED** |
| PT.Rama Emerald Multi Sukses | `3b61c088-4b91-4217-835b-3577da389fc0` | 2 | **1** | **VERIFIED** |

---

## 3. Resolution of the Six Commercial Cases

All 6 commercial cases have verified technical paths:

1. **PT Afifarma:** Older duplicate Kediri landline `a33be333-4bca-46b0-b855-633dc8bf605e` staged for demotion. Newer Kediri landline `f333647e-3e3f-48a5-8238-54fcfda270f7` retained as primary. Mobile `+62 811 3333 3538` retained as active secondary.
2. **PT ANUGRAH VISI BERSAMA:** Landline `7c994365-edc6-4435-8257-3e1ed585818d` demoted. Mobile contact `af50aef6-dbc8-45d1-9c66-56c5e7f10d0a` (Hinsa Silitonga) retained as primary quotation recipient. Mobile contact `7fcaf882-0db0-4350-8198-e2de5a57a9dc` (Ms Alya) demoted to active secondary.
3. **PT Konimex:** General switchboard `bd62e743-23f3-4c6d-bb0d-544e7b11b9a3` demoted. Purchasing officer Silvia Margaretha (`ec4ef328-5a29-46b6-aaad-cb904753eb11`, `+62 271 740 888`) retained as primary.
4. **PT Medikon Prima Laboratories:** Jakarta HQ switchboard `c7e0b7a6-4d7f-4af1-8f9c-e7505100e68b` demoted. Cikupa manufacturing plant purchaser Ms Fiona (`939dd1a6-9389-421e-9152-42ca13998548`, `+62215963504`) retained as primary.
5. **PT. Mahakam Beta Farma:** Disassociated internal SAPJ sales hotline `6c2f5cc1-a67e-4ef5-9dbb-5dd95ae9d00b` (`0817 667 0915`) by demoting to secondary to prevent looped outbound campaigns. Real purchaser Mr Adam (`f85db461-cb21-47c9-ac37-b214881bf013`, `+6221 4600007`) retained as primary.
6. **PT. Meiji Indonesian Pharmaceutical:** Bangil plant line `39398510-c836-484a-9ddc-5e3548789c86` demoted to secondary. Corporate Jakarta head office purchaser Suh Andik (`7b1892e6-4af2-4a16-8e0f-66922cb89a30`, `021 21383388`) retained as primary.

---

## 4. Document Bank SHA-256 Backfill Audit

- **Total Documents in Universal Document Bank:** 551 versions across 551 documents.
- **Already Possessing Valid SHA-256 Hashes:** 49 versions.
- **Lacking SHA-256 Hashes:** Exactly 502 versions.
- **Physical Availability In Storage:**
  - Available as exact path: 497 files.
  - Available as URL-decoded path: 1 file.
  - Missing physical object (zero-byte dev test artifacts): 4 files.
- **Audit Schedule:** Full 502-record breakdown generated in `docs/audits/SAPJ_DOCUMENT_BANK_SHA256_AUDIT_SCHEDULE.csv`.
- **Backend Procedure:** The non-destructive tool `scripts/storage_optimization/universal_document_bank_sha256_backfill.mjs` is prepared for execution once `SUPABASE_SERVICE_ROLE_KEY` is provided in an authorized maintenance window.

---

## 5. Unique Primary-Phone Constraint Migration

The migration `supabase/migrations/20261116090000_enforce_single_primary_phone_per_contact.sql` creates:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_contact_single_primary_phone 
ON public.crm_contact_phones (contact_id) 
WHERE (is_primary = true);
```
- Includes a PL/pgSQL preflight guard that raises an exception if any contact in the database currently possesses $>1$ primary phone.
- Verified in rollback simulation: upon executing the 7 demotions, this migration succeeds with 0 errors.

---

## 6. Prompt 6C Closure Recommendation

Prompt 6C is **PROVISIONALLY CLOSED** pending explicit management sign-off on the 6 commercial cases. All technical artifacts, preflight verifications, and migrations are complete and validated.

