# SAPJ ERP — Prompt 6 Owner Confirmation Register: Commercial Decisions & Phone Demotions

**Target Environment:** Local Project `/Users/Kunal/Documents/anzen-main`  
**Production Database:** Supabase `dkrtsqienlhpouohmfki` (AWS ap-southeast-1)  
**Safety Status:** Production Supabase was accessed strictly in **READ-ONLY** mode (`SET default_transaction_read_only = on`).  
**Production Modification Status:** **ZERO** production modifications performed. No DDL, no DML, no phone demotions executed, no partial unique index created, no documents re-hashed or updated in production.

---

## 1. Executive Summary & Purpose

During the Prompt 6 and Prompt 6A CRM and database integrity audit, an inspection of `public.crm_contact_phones` identified **18 companies** that each have more than one phone record flagged as `is_primary = true`.

To prevent communication misdirection, double broadcasts, and data corruption:
1. **12 Companies (13 Phone Records)** have clear structural discrepancies (e.g. mobile contact vs general landline switchboard, or duplicate identical entries) where an engineering proposal can demote the secondary line to `is_primary = false`. These 13 demotions have been staged and verified locally, but **intentionally held back from production execution** pending owner sign-off.
2. **6 Companies** involve nuanced commercial, organizational, or ownership decisions that cannot be resolved algorithmically without business context.

This register compiles the 6 commercial confirmation cases and the 13 proposed phone demotions with exact live production UUIDs, timestamps, phone numbers, contact persons, and specific questions for the business owner.

---

## 2. Six Commercial Confirmation Cases

### Case 1: PT Afifarma
- **Company Name:** PT Afifarma
- **Contact ID:** `80ee11cf-7eb3-4054-bd65-b1bafcf2686b`
- **Customer Tier / Type:** Pharmaceutical Manufacturer (Kediri, East Java)
- **Live Phone Records:**
  1. Phone ID: `a33be333-4bca-46b0-b855-633dc8bf605e`
     - **Raw Phone:** `0354 683675`
     - **Phone Type:** `landline`
     - **Contact Person:** `null`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 15:14:39.117267+00`
  2. Phone ID: `f333647e-3e3f-48a5-8238-54fcfda270f7`
     - **Raw Phone:** `0354 683675`
     - **Phone Type:** `landline`
     - **Contact Person:** `null`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 17:40:21.037599+00`
- **Context & Diagnostic:** Both records represent the exact same landline switchboard number in Kediri (`0354 683675`). They were created or touched during data migration and both left flagged as primary. Neither record carries a specific purchasing officer or mobile number.
- **Proposed Technical Resolution:** Demote older record `a33be333-4bca-46b0-b855-633dc8bf605e` to `is_primary = false`, keeping newer record `f333647e-3e3f-48a5-8238-54fcfda270f7` as primary.
- **Specific Owner Question:**
  > *"PT Afifarma currently only has duplicate Kediri landline records (`0354 683675`) and no mobile number. Does sales ops have a direct purchasing or procurement officer contact (e.g. mobile WhatsApp) to add as the primary commercial recipient?"*

---

### Case 2: PT ANUGRAH VISI BERSAMA
- **Company Name:** PT ANUGRAH VISI BERSAMA
- **Contact ID:** `caad7c41-ad40-47ba-bde0-bf3f505390fa`
- **Customer Tier / Type:** Commercial Customer / Distributor
- **Live Phone Records:**
  1. Phone ID: `af50aef6-dbc8-45d1-9c66-56c5e7f10d0a`
     - **Raw Phone:** `+62 8111 618281`
     - **Phone Type:** `valid_mobile`
     - **Contact Person:** `Hinsa Silitonga`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 15:14:39.117267+00`
  2. Phone ID: `7fcaf882-0db0-4350-8198-e2de5a57a9dc`
     - **Raw Phone:** `+6281387845840`
     - **Phone Type:** `valid_mobile`
     - **Contact Person:** `Ms Alya`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 15:14:39.117267+00`
  3. Phone ID: `7c994365-edc6-4435-8257-3e1ed585818d`
     - **Raw Phone:** `021 84943347`
     - **Phone Type:** `landline`
     - **Contact Person:** `Alya Augustiya / Hinsa Silitonga`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 15:14:39.117267+00`
- **Context & Diagnostic:** PT ANUGRAH VISI BERSAMA has 3 primary records: two distinct active mobile numbers for different commercial officers (Hinsa Silitonga vs Ms Alya) and one shared office landline. Automated broadcast campaigns must not message both officers simultaneously with identical promotional blasts unless intended.
- **Proposed Technical Resolution:** Demote landline `7c994365-edc6-4435-8257-3e1ed585818d` to secondary (`is_primary = false`).
- **Specific Owner Question:**
  > *"Between Hinsa Silitonga (`+62 8111 618281`) and Ms Alya (`+62 813 8784 5840`), which individual is the designated primary recipient for SAPJ official sales quotations and price announcements?"*

---

### Case 3: PT Konimex
- **Company Name:** PT Konimex
- **Contact ID:** `e53d1921-62fa-4310-b0da-91535adbe194`
- **Customer Tier / Type:** Major Pharmaceutical & Consumer Health Manufacturer (Solo / Sukoharjo)
- **Live Phone Records:**
  1. Phone ID: `ec4ef328-5a29-46b6-aaad-cb904753eb11`
     - **Raw Phone:** `+62 271 740 888`
     - **Phone Type:** `landline`
     - **Contact Person:** `Silvia Margaretha`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 15:14:39.117267+00`
  2. Phone ID: `bd62e743-23f3-4c6d-bb0d-544e7b11b9a3`
     - **Raw Phone:** `0271 716246`
     - **Phone Type:** `landline`
     - **Contact Person:** `null`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 15:14:39.117267+00`
- **Context & Diagnostic:** Both records are Solo (0271) fixed lines. Record 1 has an assigned contact person (Silvia Margaretha), while Record 2 is the general corporate switchboard. Both are landlines (ineligible for automated WhatsApp mobile broadcasts, but valid for formal sales tracking).
- **Proposed Technical Resolution:** Keep `ec4ef328-5a29-46b6-aaad-cb904753eb11` (`+62 271 740 888`, Silvia Margaretha) as primary; demote `bd62e743-23f3-4c6d-bb0d-544e7b11b9a3` (`0271 716246`) to secondary.
- **Specific Owner Question:**
  > *"Confirm whether Silvia Margaretha's direct office extension (`+62 271 740 888`) should remain the primary contact over the general Konimex switchboard (`0271 716246`), and whether an active mobile WhatsApp contact exists for Konimex purchasing."*

---

### Case 4: PT Medikon Prima Laboratories
- **Company Name:** PT Medikon Prima Laboratories
- **Contact ID:** `6b4325d8-b79a-4602-9fd0-91e0df65bd03`
- **Customer Tier / Type:** Pharmaceutical Manufacturer
- **Live Phone Records:**
  1. Phone ID: `c7e0b7a6-4d7f-4af1-8f9c-e7505100e68b`
     - **Raw Phone:** `021 29032210`
     - **Phone Type:** `landline`
     - **Contact Person:** `null`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 15:14:39.117267+00`
  2. Phone ID: `939dd1a6-9389-421e-9152-42ca13998548`
     - **Raw Phone:** `+62215963504`
     - **Phone Type:** `landline`
     - **Contact Person:** `Ms Fiona`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 15:14:39.117267+00`
- **Context & Diagnostic:** Record 1 (`021 29032210`) is the Jakarta Head Office general line. Record 2 (`+62 21 5963504`) is the Cikupa / Tangerang factory plant direct line to Ms Fiona.
- **Proposed Technical Resolution:** Keep Ms Fiona (`939dd1a6-9389-421e-9152-42ca13998548`) as primary commercial contact; demote Jakarta corporate switchboard (`c7e0b7a6-4d7f-4af1-8f9c-e7505100e68b`) to secondary.
- **Specific Owner Question:**
  > *"Should commercial correspondence target the Jakarta Head Office (`021 29032210`) or Ms Fiona at the Cikupa manufacturing facility (`021 5963504`)?"*

---

### Case 5: PT. Mahakam Beta Farma
- **Company Name:** PT. Mahakam Beta Farma
- **Contact ID:** `987b5d43-e04d-419b-a399-a5240096cfdd`
- **Customer Tier / Type:** Pharmaceutical Manufacturer (Pulogadung, East Jakarta)
- **Live Phone Records:**
  1. Phone ID: `f85db461-cb21-47c9-ac37-b214881bf013`
     - **Raw Phone:** `+6221 4600007`
     - **Phone Type:** `landline`
     - **Contact Person:** `Mr Adam`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 15:14:39.117267+00`
  2. Phone ID: `6c2f5cc1-a67e-4ef5-9dbb-5dd95ae9d00b`
     - **Raw Phone:** `0817 667 0915`
     - **Phone Type:** `valid_mobile`
     - **Contact Person:** `Adam Setiono`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 15:14:39.117267+00`
- **Critical Cross-Entity Collision Investigation:**
  - Phone `0817 667 0915` is **identical to SAPJ's own corporate sales contact number** registered under `PT Shubham Anzen Pharma Jaya` (`contact_id: b768af4b-dd06-4a0e-841f-5a6aa4dd188e`, phone ID `a4b63186-6fab-4c81-8de1-da9df64bd1b1`, contact person: `Adam Setiono`).
  - During early system setup or testing, SAPJ's internal company contact was linked or copied under PT. Mahakam Beta Farma.
  - Per Prompt 6/6A safety invariants, this phone was **NOT automatically deleted or modified** in production. It is suppressed from external broadcast deduplication via `deduplicateCampaignPhoneRecipients`.
- **Proposed Technical Resolution:** Demote or disassociate `6c2f5cc1-a67e-4ef5-9dbb-5dd95ae9d00b` from PT. Mahakam Beta Farma so SAPJ's own phone number does not receive outbound customer broadcasts. Keep `f85db461-cb21-47c9-ac37-b214881bf013` (`+6221 4600007`) as primary pending true customer mobile capture.
- **Specific Owner Question:**
  > *"Mobile number `0817 667 0915` (Adam Setiono) is currently registered both under SAPJ's own company profile and under customer PT. Mahakam Beta Farma. Please confirm that `0817 667 0915` should be removed/demoted from PT. Mahakam Beta Farma and replaced with Mahakam's genuine procurement officer contact."*

---

### Case 6: PT. Meiji Indonesian Pharmaceutical Industries
- **Company Name:** PT. Meiji Indonesian Pharmaceutical Industries
- **Contact ID:** `17feb96c-4506-4913-87ae-81f778f101cc`
- **Customer Tier / Type:** Major MNC Pharmaceutical Manufacturer (Head Office Jakarta, Plant Bangil/Pasuruan)
- **Live Phone Records:**
  1. Phone ID: `7b1892e6-4af2-4a16-8e0f-66922cb89a30`
     - **Raw Phone:** `021) 21383388`
     - **Phone Type:** `landline`
     - **Contact Person:** `Mr Suhandik / Suh Andik`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 15:14:39.117267+00`
  2. Phone ID: `39398510-c836-484a-9ddc-5e3548789c86`
     - **Raw Phone:** `0343 741102`
     - **Phone Type:** `landline`
     - **Contact Person:** `Suh Andik`
     - **Department:** `null`
     - **is_primary:** `true`
     - **Updated At:** `2026-11-07 15:14:39.117267+00`
- **Context & Diagnostic:** Both records represent Suh Andik across two facilities: `021 21383388` is the Jakarta Head Office, while `0343 741102` is the Bangil / Pasuruan manufacturing plant.
- **Proposed Technical Resolution:** Keep Jakarta Head Office (`7b1892e6-4af2-4a16-8e0f-66922cb89a30`) as primary commercial contact; demote Bangil plant line (`39398510-c836-484a-9ddc-5e3548789c86`) to secondary.
- **Specific Owner Question:**
  > *"For PT. Meiji, should the primary billing and purchasing contact be routed to Mr. Suhandik at the Jakarta Head Office (`021 21383388`) or the Bangil factory (`0343 741102`)?"*

---

## 3. Register of 12 Companies with 13 Proposed Demotions

All 13 records have been inspected in live Supabase (read-only) and verified. None have been modified in production.

| # | Company Name | Contact UUID | Demote Phone UUID | Demoted Phone & Type | Keep Primary Phone UUID | Kept Phone & Type | Rationale |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | DJAMU DJAGO | `28afdb31-babd-4975-a100-26f81dd0fa16` | `1f503482-4f9c-47f1-a572-51df76a59361` | `(024) 3555 805` (landline) | `e1a9a8f1-3e29-48a6-afd2-7882927114d1` | `+62 857-8012-2800` (valid_mobile) | Promote direct mobile over fixed switchboard |
| **2** | PT BAHTERA SENTRA NIAGATAMA | `3004a29f-2fbe-48ea-bdc7-b6d0a8119c82` | `f6a9cd15-7e04-4a61-88b8-d4654652e18e` | `+62 21 29616463` (landline) | `957fd44a-1d7a-4bd0-a360-1aaf630505ae` | `+62 812 8705 9088` (valid_mobile) | Promote direct mobile over fixed switchboard |
| **3** | PT COMBIPHAR | `cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b` | `b1d0edf0-01a3-475f-9d59-5656d2c0141f` | `021 2933 3031` (landline) | `ee79eea6-d631-4c94-86fa-f0fb75b86fec` | `+62 812-9373-9515` (valid_mobile) | Promote direct mobile over fixed switchboard |
| **4** | PT Lloyd Pharma Indonesia | `d6830ce1-7904-4c01-afdd-392205293f40` | `ce170f91-fe35-4729-945c-a73fa22e5e0b` | `021 5902515` (landline) | `633c42a3-d976-43af-897b-638f4cfb8089` | `+6281218163377` (valid_mobile) | Promote direct mobile over fixed switchboard |
| **5** | PT Perusahaan Dagang dan Industri Kaliroto | `177e9c47-7c57-438a-911b-5ffca8652ab8` | `086bdf95-f282-4c80-80a6-c0c7f84885a8` | `031  3711717` (landline) | `279e459b-0b22-4ec0-b253-6587308afbb8` | `0813 8600 8316` (valid_mobile) | Promote direct mobile over fixed switchboard |
| **6** | PT Prima Cita Prasada | `78958f07-0fdf-4c87-a93d-9a8454f9eb1c` | `0ea5aa2a-7285-4545-a5b9-74ca80a1ee76` | `+62 21 3529 4362` (landline) | `f1f13dad-d70d-40b1-beb6-170b1126c458` | `+62 85876144740` (valid_mobile) | Promote direct mobile over fixed switchboard |
| **7** | PT Roi Surya Prima Farma | `ef17e387-502c-4506-8ad7-3dc59e4b2f49` | `20272510-d496-4aa8-8d33-c22d3e5c778c` | `0343  631897` (landline) | `e3db634a-8ecf-4dd1-bb19-563d408d9020` | `0343  631897` (landline) | Duplicate number; demote older timestamp record |
| **8** | PT Shubham Anzen Pharma Jaya | `b768af4b-dd06-4a0e-841f-5a6aa4dd188e` | `c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1` | `+62 21 6583 2426` (landline) | `a4b63186-6fab-4c81-8de1-da9df64bd1b1` | `0817 667 0915` (valid_mobile) | Promote mobile hotline over office landline |
| **9** | PT Synergi Mitra Abadi | `2a53b06c-67d1-45da-9c38-edde3be7dc93` | `df629243-0d0d-44ca-af04-a1edb39f3d9a` | `+62 21 3885 6027` (landline) | `f5ff2c11-8056-4574-9531-236808e86e92` | `081270696909` (valid_mobile) | Promote direct mobile over fixed switchboard |
| **10** | PT. SANBE FARMA | `c5d7c938-5878-4bfa-bf44-36e81dddc1a4` | `17da83bf-c7ba-4d0e-9723-e30e49f080c5` AND `aab97f7e-2f24-4a1f-977f-0b0e44625171` | `0224207725` AND `+62 22 603 0036` (landlines) | `121900ba-053f-4511-874a-30ad153dfef4` | `081296035128` (valid_mobile) | Demote BOTH landlines; retain active mobile as single primary |
| **11** | PT.Medion Farma Jaya | `986ea4c3-2f2a-4ad2-97d8-f4e758705c5a` | `db76ee70-1c78-4e95-9b31-8b9c79e85394` | `022) 6866090` (landline) | `1a3e642d-6f9a-4974-9abe-861442cba7ff` | `082318183386` (valid_mobile) | Promote direct mobile over fixed switchboard |
| **12** | PT.Rama Emerald Multi Sukses | `3b61c088-4b91-4217-835b-3577da389fc0` | `ec57e9b5-b66d-4840-a406-6f2a443a28ee` | `0317507406` (landline) | `26dbb22b-c2ce-401c-a3c0-53951287fac1` | `+62 895-1067-6801` (valid_mobile) | Promote direct mobile over fixed switchboard |

**Total Proposed Demotions:** Exactly **13 UUIDs** across **12 Companies**.

---

## 4. Operational & Database Invariants Preserved

1. **Production Read-Only Status:**
   - Production PostgreSQL connection was strictly executed with `SET default_transaction_read_only = on;`.
   - Zero UPDATE queries were run against `public.crm_contact_phones`.
2. **Partial Unique Index Protection:**
   - The proposed partial unique index:
     ```sql
     CREATE UNIQUE INDEX uq_crm_contact_single_primary_phone 
     ON public.crm_contact_phones (contact_id) 
     WHERE is_primary = true;
     ```
     has **NOT** been applied in production. Applying it while these 18 companies have multiple primaries would fail with PostgreSQL constraint violations or break running CRM write paths.
3. **Application Layer Safety:**
   - The React frontend handles multi-primary records safely in `CrmCustomersWorkspace.tsx`, collapsing rows into single unique customer entries and badging them with amber `Multi-Primary (N)` indicators.
   - Campaign tools (`WASenderBulkWorkspace.tsx` and `crmContactCleaners.ts`) safely deduplicate and exclude shared switchboards, preventing duplicate broadcast dispatches regardless of production database status.

