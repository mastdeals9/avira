# PT Shubham Anzen Pharma Jaya (SAPJ) — CRM Database Quality & Deduplication Investigation Report

**Date:** 2026-11-15  
**Auditor:** Principal Software Architect, PostgreSQL/Supabase DBA & ERP Data Governance Specialist  
**Database:** `dkrtsqienlhpouohmfki` (AP-Southeast-1) — **STRICT READ-ONLY AUDIT MODE** (`SHOW transaction_read_only = on`)  
**Audit Target:** CRM Contacts (`public.crm_contacts`), Contact Phones (`public.crm_contact_phones`), and Campaign Delivery Structures  

---

## 1. Executive Summary & Diagnostic Overview

A forensic analysis of the live production CRM data was performed to investigate reported discrepancies: duplicate companies, contact persons missing or misclassified, duplicate phones, multiple primary phones, and duplicate rendering in WhatsApp/Email campaigns.

### High-Level Metrics (Live Read-Only Database)

| Metric | Measured Value | Operational & Schema Significance |
| :--- | :---: | :--- |
| **Total `crm_contacts` Records** | **446** | Entire historical customer/lead database |
| **Active Contacts (`is_active = true`)** | **436** | Eligible for active sales and CRM interactions |
| **Archived / Merged Contacts (`is_active = false`)** | **10** | 9 merged records (`ARCHIVED - MERGED INTO ...`) + 1 inactive record |
| **Contacts Missing `contact_person` (`NULL`)** | **195** | Contacts lacking an individual contact officer name |
| **Contacts with Empty String `contact_person = ''`** | **0** | Clean data hygiene (no empty string pollution) |
| **Companies with Person Name = Company Name** | **1** | `PT Holi Pharma` has `contact_person: 'Holi Pharma'` |
| **Companies with Multiple Primary Phones** | **18** | Cause of Cartesian join duplication in campaign views |
| **Contacts with Multi-Email Strings (`comma/semicolon`)**| **144** | Comma-delimited strings stored in single text columns |
| **Shared Email Groups Across Entities** | **17** | Same email address shared across multiple company entities |
| **Shared Normalized Phone Groups** | **20** | Corporate switchboards shared across multiple company entities |

---

## 2. Root Cause Analysis of "Duplicate Campaign Recipients"

Inquiry into why users observed duplicate recipient entries during bulk WhatsApp and email campaigns revealed **two distinct mechanisms**:

### Mechanism A: Raw Database Duplication (Historical Merged Records)
- 9 historical records were merged in previous data cleanup passes and renamed with the prefix `ARCHIVED - MERGED INTO <Target Company>`, setting `is_active = false`.
- **Root Cause in Application Queries:** Any query or frontend filter that omitted `.eq('is_active', true)` selected both the active company and its archived/merged counterparts, producing apparent duplicate companies in campaign recipient pickers.
- **Local Application Fix:** Added `.eq('is_active', true)` to `StockUpdateEmailComposer.tsx`, `CrmOmnichannelInbox.tsx`, `CrmGlobalSearchModal.tsx`, and changed default filter in `CrmCustomersWorkspace.tsx` to `active`.

### Mechanism B: Relational Join Multiplicity (Multiple Primary Phones)
- In the schema, `crm_contact_phones` is a 1-to-N relation linked to `crm_contacts`.
- Standard data models assume each contact has at most **one** phone where `is_primary = true`.
- **Forensic Discovery:** Exactly **18 active companies** have multiple phones flagged with `is_primary = true` (2 companies have 3 primary phones; 16 companies have 2 primary phones).
- **Cartesian Expansion:** When queries perform an inner or left join between `crm_contacts` and `crm_contact_phones` where `p.is_primary = true`, each company with 2 or 3 primary phones produces 2 or 3 rows in the result set, creating duplicate cards/rows in the UI even when the contact table itself has only one record!
- **Local Application Fix:** In `CrmCustomersWorkspace.tsx`, companies are assembled directly from `crm_contacts`, grouping phone records via `phonesByContact` map to display primary numbers and a `Multi-Primary` badge without multiplying rows. In `WASenderBulkWorkspace.tsx` and `CrmCampaignsWorkspace.tsx`, `deduplicateCampaignPhoneRecipients` enforces single message dispatch per canonical phone.

---

## 3. Comprehensive Record-Level Review for the 18 Multi-Primary Companies

*Strict Safety Invariant: No automatic database updates were executed. All recommendations below are submitted for owner review and operational confirmation.*

| # | Company Name | Contact ID | Phone Record ID | Current Phone & Type | WhatsApp Eligible | Current Primary | Last Updated | Recommended Primary & Rationale | Manual Confirm Needed? |
| :-: | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :--- | :---: |
| 1 | **DJAMU DJAGO** | `28afdb31-babd-4975-a100-26f81dd0fa16` | `e1a9a8f1-3e29-48a6-afd2-7882927114d1`<br>`1f503482-4f9c-47f1-a572-51df76a59361` | `+62 857-8012-2800` (mobile)<br>`(024) 3555 805` (landline) | YES<br>NO | **TRUE**<br>**TRUE** | 2026-11-03<br>2026-11-07 | **Keep `+62 857-8012-2800` (MS TRISNA)**: Mobile and WA eligible. Demote landline `(024) 3555 805` (`1f503482`) to secondary. | **No** (Clear mobile priority) |
| 2 | **PT Afifarma** | `80ee11cf-7eb3-4054-bd65-b1bafcf2686b` | `f333647e-3e3f-48a5-8238-54fcfda270f7`<br>`a33be333-4bca-46b0-b855-633dc8bf605e` | `0354 683675` (landline)<br>`0354 683675` (landline duplicate) | NO<br>NO | **TRUE**<br>**TRUE** | 2026-11-07<br>2026-11-07 | **Duplicate landline `0354 683675`**: Keep one; also verify whether non-primary mobile `+62 811 3333 3538` should be promoted. | **YES** (Sales to confirm primary officer/mobile) |
| 3 | **PT ANUGRAH VISI BERSAMA** | `caad7c41-ad40-47ba-bde0-bf3f505390fa` | `7fcaf882-0db0-4350-8198-e2de5a57a9dc`<br>`af50aef6-dbc8-45d1-9c66-56c5e7f10d0a`<br>`7c994365-edc6-4435-8257-3e1ed585818d` | `+6281387845840` (mobile, Ms Alya)<br>`+62 8111 618281` (mobile, Hinsa Silitonga)<br>`021  84943347` (landline) | YES<br>YES<br>NO | **TRUE**<br>**TRUE**<br>**TRUE** | 2026-11-06<br>2026-11-06<br>2026-11-07 | **Demote landline `021 84943347` (`7c994365`).** Between Ms Alya and Hinsa Silitonga, both are valid mobile WA contacts. Sales admin must select primary officer. | **YES** (Sales to confirm primary officer) |
| 4 | **PT BAHTERA SENTRA NIAGATAMA** | `3004a29f-2fbe-48ea-bdc7-b6d0a8119c82` | `957fd44a-1d7a-4bd0-a360-1aaf630505ae`<br>`f6a9cd15-7e04-4a61-88b8-d4654652e18e` | `+62 812 8705 9088` (mobile)<br>`+62 21 29616463` (landline) | YES<br>NO | **TRUE**<br>**TRUE** | 2026-11-07<br>2026-11-12 | **Keep `+62 812 8705 9088`**: Mobile and WA eligible. Demote landline (`f6a9cd15`) to secondary. | **No** (Standard mobile precedence) |
| 5 | **PT COMBIPHAR** | `cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b` | `ee79eea6-d631-4c94-86fa-f0fb75b86fec`<br>`b1d0edf0-01a3-475f-9d59-5656d2c0141f` | `+62 812-9373-9515` (mobile, MS TUTI)<br>`021 2933 3031` (landline, MS TUTI) | YES<br>NO | **TRUE**<br>**TRUE** | 2026-11-03<br>2026-11-07 | **Keep `+62 812-9373-9515`**: Mobile for MS TUTI. Demote office landline (`b1d0edf0`) to secondary. | **No** (Same person, mobile preferred) |
| 6 | **PT Konimex** | `e53d1921-62fa-4310-b0da-91535adbe194` | `ec4ef328-5a29-46b6-aaad-cb904753eb11`<br>`bd62e743-23f3-4c6d-bb0d-544e7b11b9a3` | `+62 271 740 888` (landline, Silvia Margaretha)<br>`0271 716246` (landline) | NO<br>NO | **TRUE**<br>**TRUE** | 2026-11-03<br>2026-11-07 | **Both are landlines in Surakarta (0271)**. Recommended: keep `+62 271 740 888` (switchboard) as primary; demote extension `0271 716246` (`bd62e743`). | **YES** (Sales to confirm switchboard) |
| 7 | **PT Lloyd Pharma Indonesia** | `d6830ce1-7904-4c01-afdd-392205293f40` | `633c42a3-d976-43af-897b-638f4cfb8089`<br>`ce170f91-fe35-4729-945c-a73fa22e5e0b` | `+6281218163377` (mobile, Mr Albanus)<br>`021 5902515` (landline, Mr Albanus) | YES<br>NO | **TRUE**<br>**TRUE** | 2026-11-03<br>2026-11-07 | **Keep `+6281218163377`**: Mobile for Mr Albanus. Demote landline (`ce170f91`) to secondary. | **No** (Standard mobile precedence) |
| 8 | **PT Medikon Prima Laboratories** | `6b4325d8-b79a-4602-9fd0-91e0df65bd03` | `939dd1a6-9389-421e-9152-42ca13998548`<br>`c7e0b7a6-4d7f-4af1-8f9c-e7505100e68b` | `+62215963504` (landline, Ms Fiona - Cikupa)<br>`021 29032210` (landline, HO Puri Indah) | NO<br>NO | **TRUE**<br>**TRUE** | 2026-11-06<br>2026-11-07 | **Both are landlines**. Factory vs Head Office. Confirm whether HO `021 29032210` or Factory Cikupa should be primary. | **YES** (Confirm HO vs Plant) |
| 9 | **PT Perusahaan Dagang dan Industri Kaliroto** | `177e9c47-7c57-438a-911b-5ffca8652ab8` | `279e459b-0b22-4ec0-b253-6587308afbb8`<br>`086bdf95-f282-4c80-80a6-c0c7f84885a8` | `0813 8600 8316` (mobile, Ms.Jessica)<br>`031  3711717` (landline, Ms Jessica) | YES<br>NO | **TRUE**<br>**TRUE** | 2026-11-03<br>2026-11-07 | **Keep `0813 8600 8316`**: Direct mobile for Ms Jessica. Demote landline (`086bdf95`) to secondary. | **No** (Direct mobile precedence) |
| 10 | **PT Prima Cita Prasada** | `78958f07-0fdf-4c87-a93d-9a8454f9eb1c` | `f1f13dad-d70d-40b1-beb6-170b1126c458`<br>`0ea5aa2a-7285-4545-a5b9-74ca80a1ee76` | `+62 85876144740` (mobile, Mr Julianto)<br>`+62 21 3529 4362` (landline, Julianto) | YES<br>NO | **TRUE**<br>**TRUE** | 2026-11-03<br>2026-11-12 | **Keep `+62 85876144740`**: Mobile and WA eligible for Mr Julianto. Demote landline (`0ea5aa2a`) to secondary. | **No** (Mobile precedence) |
| 11 | **PT Roi Surya Prima Farma** | `ef17e387-502c-4506-8ad7-3dc59e4b2f49` | `e3db634a-8ecf-4dd1-bb19-563d408d9020`<br>`20272510-d496-4aa8-8d33-c22d3e5c778c` | `0343  631897` (landline)<br>`0343  631897` (identical landline duplicate) | NO<br>NO | **TRUE**<br>**TRUE** | 2026-11-07<br>2026-11-07 | **Identical duplicate landlines (NOT mobile precedence case)**. Both records are identical landline `0343 631897`. Keep row `e3db634a` primary; demote duplicate row `20272510` (`is_primary = false`). | **No** (Deduplication of exact number) |
| 12 | **PT Shubham Anzen Pharma Jaya** | `b768af4b-dd06-4a0e-841f-5a6aa4dd188e` | `a4b63186-6fab-4c81-8de1-da9df64bd1b1`<br>`c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1` | `0817 667 0915` (mobile, Farid / Sales Hotline)<br>`+62 21 6583 2426` (landline, Farid / Office) | YES<br>NO | **TRUE**<br>**TRUE** | 2026-11-03<br>2026-11-07 | **Own Company Master**. Keep `0817 667 0915` as primary customer-facing mobile; demote office landline (`c458e82e`) to secondary. | **No** (Internal company record) |
| 13 | **PT Synergi Mitra Abadi** | `2a53b06c-67d1-45da-9c38-edde3be7dc93` | `f5ff2c11-8056-4574-9531-236808e86e92`<br>`df629243-0d0d-44ca-af04-a1edb39f3d9a` | `081270696909` (mobile, Apt Risyad Fadli)<br>`+62 21 3885 6027` (landline) | YES<br>NO | **TRUE**<br>**TRUE** | 2026-11-03<br>2026-11-12 | **Keep `081270696909`**: Mobile and WA eligible for Apt Risyad Fadli. Demote landline (`df629243`) to secondary. | **No** (Mobile precedence) |
| 14 | **PT. Mahakam Beta Farma** | `987b5d43-e04d-419b-a399-a5240096cfdd` | `6c2f5cc1-a67e-4ef5-9dbb-5dd95ae9d00b`<br>`f85db461-cb21-47c9-ac37-b214881bf013` | `0817 667 0915` (mobile, Adam Setiono)<br>`+6221 4600007` (landline, Mr Adam / Plant) | YES<br>NO | **TRUE**<br>**TRUE** | 2026-11-03<br>2026-11-07 | **CRITICAL ANOMALY:** Mobile `0817 667 0915` is identical to SAPJ sales hotline! Accidental copy during customer onboarding. Requires separate manual correction; keep plant landline `+6221 4600007` meanwhile. | **YES** (Crucial: suspected incorrect mobile, needs separate correction) |
| 15 | **PT. Meiji Indonesian Pharmaceutical Industries** | `17feb96c-4506-4913-87ae-81f778f101cc` | `7b1892e6-4af2-4a16-8e0f-66922cb89a30`<br>`39398510-c836-484a-9ddc-5e3548789c86` | `021) 21383388` (landline, Jakarta Office)<br>`0343  741102` (landline, Bangil Pasuruan Plant) | NO<br>NO | **TRUE**<br>**TRUE** | 2026-11-07<br>2026-11-06 | **Both landlines**: Jakarta Head Office vs Bangil Pasuruan Factory. Recommended: keep Jakarta office `021) 21383388` as commercial primary. | **YES** (Confirm PO dispatch address) |
| 16 | **PT. SANBE FARMA** | `c5d7c938-5878-4bfa-bf44-36e81dddc1a4` | `121900ba-053f-4511-874a-30ad153dfef4`<br>`aab97f7e-2f24-4a1f-977f-0b0e44625171`<br>`17da83bf-c7ba-4d0e-9723-e30e49f080c5` | `081296035128` (mobile, Catherine)<br>`+62 22 603 0036` (landline, Dyta Silvia)<br>`0224207725` (landline, Catherine / Iman) | YES<br>NO<br>NO | **TRUE**<br>**TRUE** | 2026-11-03<br>2026-11-12<br>2026-11-07 | **Keep `081296035128` (Catherine)**: Mobile and WA eligible. Has TWO separate proposed landline demotions: `aab97f7e` and `17da83bf`. | **No** (Two separate landline demotions) |
| 17 | **PT.Medion Farma Jaya** | `986ea4c3-2f2a-4ad2-97d8-f4e758705c5a` | `1a3e642d-6f9a-4974-9abe-861442cba7ff`<br>`db76ee70-1c78-4e95-9b31-8b9c79e85394` | `082318183386` (mobile, Rena)<br>`022) 6866090` (landline, Rena) | YES<br>NO | **TRUE**<br>**TRUE** | 2026-11-03<br>2026-11-12 | **Keep `082318183386`**: Mobile and WA eligible for Rena. Demote landline (`db76ee70`) to secondary. | **No** (Direct mobile precedence) |
| 18 | **PT.Rama Emerald Multi Sukses** | `3b61c088-4b91-4217-835b-3577da389fc0` | `26dbb22b-c2ce-401c-a3c0-53951287fac1`<br>`ec57e9b5-b66d-4840-a406-6f2a443a28ee` | `+62 895-1067-6801` (mobile, Mr Imam)<br>`0317507406` (landline, Mr Imam / Ms Suci) | YES<br>NO | **TRUE**<br>**TRUE** | 2026-11-07<br>2026-11-07 | **Keep `+62 895-1067-6801`**: Mobile for Mr Imam. Demote landline (`ec57e9b5`) to secondary. | **No** (Mobile precedence) |

---

## 4. Proposed Database Remediation Plan (Awaiting Owner Review)

*Zero production database modifications were executed during this audit. The proposals below are submitted for owner review and approval.*

### Step 1: Manual Review Confirmation
Review the 6 companies flagged with `Manual Confirm Needed: YES`:
1. `PT Afifarma` (confirm if mobile is genuine)
2. `PT ANUGRAH VISI BERSAMA` (confirm whether Ms Alya or Hinsa Silitonga is primary)
3. `PT Konimex` (confirm switchboard vs direct line)
4. `PT Medikon Prima Laboratories` (confirm HO vs Plant)
5. `PT. Mahakam Beta Farma` (confirm if mobile `0817 667 0915` was accidentally copied from SAPJ)
6. `PT. Meiji Indonesian Pharmaceutical Industries` (confirm Jakarta HO vs Bangil Plant)

### Step 2: Transaction-Safe Demotion Script (Owner Execution Once Approved)
```sql
-- Transaction-safe update: Demote 13 secondary/duplicate landlines across 12 companies
-- Enforces expected affected row count check (must equal exactly 13)
DO $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE public.crm_contact_phones
  SET is_primary = false, updated_at = NOW()
  WHERE id IN (
    '1f503482-4f9c-47f1-a572-51df76a59361', -- DJAMU DJAGO landline ((024) 3555 805)
    'f6a9cd15-7e04-4a61-88b8-d4654652e18e', -- BAHTERA landline (+62 21 29616463)
    'b1d0edf0-01a3-475f-9d59-5656d2c0141f', -- COMBIPHAR landline (021 2933 3031)
    'ce170f91-fe35-4729-945c-a73fa22e5e0b', -- Lloyd Pharma landline (021 5902515)
    '086bdf95-f282-4c80-80a6-c0c7f84885a8', -- Kaliroto landline (031  3711717)
    '0ea5aa2a-7285-4545-a5b9-74ca80a1ee76', -- Prima Cita landline (+62 21 3529 4362)
    '20272510-d496-4aa8-8d33-c22d3e5c778c', -- Roi Surya duplicate landline (0343  631897 - identical duplicate, not mobile precedence)
    'c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1', -- SAPJ office landline (+62 21 6583 2426 - internal master)
    'df629243-0d0d-44ca-af04-a1edb39f3d9a', -- Synergi Mitra landline (+62 21 3885 6027)
    'aab97f7e-2f24-4a1f-977f-0b0e44625171', -- Sanbe landline 1 (+62 22 603 0036 - first of two landline demotions)
    '17da83bf-c7ba-4d0e-9723-e30e49f080c5', -- Sanbe landline 2 (0224207725 - second of two landline demotions)
    'db76ee70-1c78-4e95-9b31-8b9c79e85394', -- Medion landline (022) 6866090)
    'ec57e9b5-b66d-4840-a406-6f2a443a28ee'  -- Rama Emerald landline (0317507406)
  )
  AND is_primary = true;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated != 13 THEN
    RAISE EXCEPTION 'Expected exactly 13 updates, but got %. Aborting and rolling back transaction.', v_updated;
  END IF;
  RAISE NOTICE 'Successfully demoted % secondary landlines to is_primary = false.', v_updated;
END $$;
```

### Step 3: Partial Unique Index DDL — STRICT PREREQUISITE RESTRICTION
**DO NOT EXECUTE THIS DDL YET.**

The partial unique index CANNOT be applied while the 6 remaining companies have multi-primary contacts. Attempting to create this unique index before resolving all 6 companies will trigger a fatal `duplicate key value violates unique constraint` exception.

**Prerequisites for owner execution:**
1. All 18 companies must have their primary phone confirmed.
2. Each contact must have at most one confirmed primary phone.
3. Read-only preflight query confirms **ZERO** multi-primary violations:
```sql
SELECT contact_id, count(*) as primary_count
FROM public.crm_contact_phones
WHERE is_primary = true
GROUP BY contact_id
HAVING count(*) > 1;
```
*(This query MUST return 0 rows before executing the DDL statement below).*
4. The owner explicitly approves data corrections and index creation in separate operational steps.

```sql
-- Enforce that each contact has at most one primary phone (ONLY AFTER PREFLIGHT RETURNS 0 ROWS)
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_contact_single_primary_phone
ON public.crm_contact_phones (contact_id)
WHERE is_primary = true;
```

---

## 5. Verification Checkpoints

- **Live Database Inspection:** Verified via read-only transaction on Supabase pooler `aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres` (`SHOW transaction_read_only = on`).
- **CSV Deliverable Created:** `docs/audits/crm_contacts_missing_contact_person.csv` (196 lines, 1 header + 195 records).
- **TypeScript Integrity:** All CRM UI components verified with `npm run typecheck` (0 errors).
- **Campaign Safety Gates:** 43/43 tests passing in `tests/canonical-phone-and-campaign-safety.test.mjs`.
- **CRM Regression Suite:** 11/11 tests passing in `tests/crm-functional-and-recipient-deduplication.test.mjs`.
