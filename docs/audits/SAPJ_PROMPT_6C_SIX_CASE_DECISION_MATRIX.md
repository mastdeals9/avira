# SAPJ ERP — Prompt 6C: Six Commercial Cases Decision Matrix

**Target Environment:** Local Project `/Users/Kunal/Documents/anzen-main`  
**Production Database:** Supabase `dkrtsqienlhpouohmfki` (AWS ap-southeast-1)  
**Audit Cut-Off:** 16 November 2026  
**Safety Status:** Production Supabase accessed strictly in **READ-ONLY** mode (`SET default_transaction_read_only = on`).

---

## 1. Overview

During the Prompt 6 CRM audit, 18 companies were identified with more than one phone record flagged as `is_primary = true`.
- **12 Companies (13 Phone Records):** Addressed and verified in production with exactly 1 primary phone contact remaining.
- **6 Companies (7 Secondary Records):** Commercial cases with organizational, branch, or cross-entity context.

This document establishes the verified evidence, contact identities, phone types, and exact proposed resolutions for all six cases.

---

## 2. Six-Case Decision Matrix

| Case | Company Name | Contact UUID | Conflicting Phone Numbers & Persons | Diagnostic & Root Cause | Proposed Primary Phone | Proposed Demoted Secondary Phone(s) | Status / Approval Required |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **PT Afifarma** | `80ee11cf-7eb3-4054-bd65-b1bafcf2686b` | 1. `0354 683675` (ID: `a33be333...`, created 2026-11-03)<br>2. `0354 683675` (ID: `f333647e...`, created 2026-11-07)<br>3. `+62 811 3333 3538` (Mobile, non-primary) | Identical duplicate landline records for the Kediri main office. Created during migration re-imports. | `f333647e-3e3f-48a5-8238-54fcfda270f7`<br>(`0354 683675`, Kediri Main Line) | `a33be333-4bca-46b0-b855-633dc8bf605e`<br>(Demote older duplicate to `is_primary = false`) | **Technical resolution ready.** Owner confirmation on whether published mobile `+62 811 3333 3538` should be promoted to primary. |
| **2** | **PT ANUGRAH VISI BERSAMA** | `caad7c41-ad40-47ba-bde0-bf3f505390fa` | 1. `+62 8111 618281` (Hinsa Silitonga, Mobile)<br>2. `+62 813 8784 5840` (Ms Alya, Mobile)<br>3. `021 84943347` (Landline) | Multiple active commercial representatives plus a general Bogor office landline. Both mobile contacts are legitimate purchasing officers. | `af50aef6-dbc8-45d1-9c66-56c5e7f10d0a`<br>(`+62 8111 618281`, Hinsa Silitonga) | 1. `7c994365-edc6-4435-8257-3e1ed585818d` (`021 84943347`, Landline)<br>2. `7fcaf882-0db0-4350-8198-e2de5a57a9dc` (`+62 813 8784 5840`, Ms Alya — retained as secondary active mobile) | **Commercial decision.** Designated Hinsa Silitonga as primary quotation recipient, Ms Alya as active secondary commercial contact. |
| **3** | **PT Konimex** | `e53d1921-62fa-4310-b0da-91535adbe194` | 1. `+62 271 740 888` (Silvia Margaretha, Purchasing)<br>2. `0271 716246` (Head Office Switchboard) | Direct purchasing contact line vs general corporate switchboard in Solo/Sukoharjo. | `ec4ef328-5a29-46b6-aaad-cb904753eb11`<br>(`+62 271 740 888`, Silvia Margaretha) | `bd62e743-23f3-4c6d-bb0d-544e7b11b9a3`<br>(`0271 716246`, General Head Office switchboard demoted to secondary) | **Technical resolution ready.** Purchasing officer Silvia Margaretha prioritized over general switchboard. |
| **4** | **PT Medikon Prima Laboratories** | `6b4325d8-b79a-4602-9fd0-91e0df65bd03` | 1. `021 29032210` (Jakarta Head Office)<br>2. `+62215963504` (Ms Fiona, Cikupa Manufacturing Plant) | Multi-location manufacturer: Corporate Jakarta HQ vs Cikupa manufacturing plant where raw materials are received and purchasing operates. | `939dd1a6-9389-421e-9152-42ca13998548`<br>(`+62215963504`, Ms Fiona, Cikupa Plant) | `c7e0b7a6-4d7f-4af1-8f9c-e7505100e68b`<br>(`021 29032210`, Jakarta HQ switchboard demoted to secondary) | **Operational alignment.** Company address is Cikupa Tangerang plant; Ms Fiona is purchasing contact. |
| **5** | **PT. Mahakam Beta Farma** | `987b5d43-e04d-419b-a399-a5240096cfdd` | 1. `+6221 4600007` (Mr Adam, Purchaser)<br>2. `0817 667 0915` (Adam Setiono, Purchasing Supervisor) | **Cross-Entity Collision:** `0817 667 0915` is identical to SAPJ's own registered corporate sales contact under `PT Shubham Anzen Pharma Jaya` (`contact_id: b768af4b...`). Copied during early CRM test data setup. | `f85db461-cb21-47c9-ac37-b214881bf013`<br>(`+6221 4600007`, Mr Adam, Purchaser) | `6c2f5cc1-a67e-4ef5-9dbb-5dd95ae9d00b`<br>(`0817 667 0915`, demote from Mahakam to prevent sending outbound broadcasts to SAPJ hotline) | **Critical safety correction.** Demote SAPJ internal number from customer record. |
| **6** | **PT. Meiji Indonesian Pharmaceutical** | `17feb96c-4506-4913-87ae-81f778f101cc` | 1. `021 21383388` (Mr Suhandik, Tebet Jakarta HQ)<br>2. `0343 741102` (Suh Andik, Bangil Pasuruan Plant) | Same purchaser (`Suh Andik`) registered across both Jakarta Corporate Office and East Java manufacturing facility. | `7b1892e6-4af2-4a16-8e0f-66922cb89a30`<br>(`021 21383388`, Tebet Jakarta HQ) | `39398510-c836-484a-9ddc-5e3548789c86`<br>(`0343 741102`, Bangil Plant demoted to secondary active contact) | **Operational alignment.** Retains corporate Tebet Jakarta HQ as primary commercial channel while preserving Bangil plant contact. |

---

## 3. Pre-Execution Summary

- **Total Companies with >1 Primary Phone in Production Today:** Exactly 6.
- **Total Records to Demote:** Exactly 7.
- **Total Records Retained as Primary:** Exactly 6 (one per company).
- **Resulting Global Primary Phone Count:** 100% of companies in `public.crm_contacts` will have $\le 1$ primary phone.
- **Migration Readiness:** `supabase/migrations/20261116090000_enforce_single_primary_phone_per_contact.sql` executes and creates `uq_crm_contact_single_primary_phone` with zero conflicts once these 7 demotions are committed.

