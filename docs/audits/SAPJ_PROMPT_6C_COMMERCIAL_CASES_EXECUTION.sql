-- =============================================================================
-- SAPJ ERP — PROMPT 6C: CRM COMMERCIAL CASES PHONE DEMOTION SCRIPT
-- =============================================================================
-- STATUS: PROPOSED & FULLY VERIFIED IN ROLLBACK TRANSACTION
-- AWAITING EXPLICIT MANAGEMENT AUTHORIZATION BEFORE LIVE EXECUTION
-- TARGET DATABASE: Supabase Production dkrtsqienlhpouohmfki (AWS ap-southeast-1)
--
-- SCOPE: Exactly 7 secondary phone demotions across the 6 commercial cases:
--   1. PT Afifarma: Demote duplicate landline (a33be333-4bca-46b0-b855-633dc8bf605e)
--   2. PT ANUGRAH VISI BERSAMA: Demote landline (7c994365-edc6-4435-8257-3e1ed585818d)
--                               and secondary mobile Ms Alya (7fcaf882-0db0-4350-8198-e2de5a57a9dc),
--                               keeping Hinsa Silitonga (+62 8111 618281) as primary.
--   3. PT Konimex: Demote general switchboard (bd62e743-23f3-4c6d-bb0d-544e7b11b9a3),
--                  keeping Silvia Margaretha (+62 271 740 888) as primary.
--   4. PT Medikon Prima Laboratories: Demote Jakarta HQ switchboard (c7e0b7a6-4d7f-4af1-8f9c-e7505100e68b),
--                                     keeping Ms Fiona at Cikupa plant (+62215963504) as primary.
--   5. PT. Mahakam Beta Farma: Demote SAPJ internal hotline collision (6c2f5cc1-a67e-4ef5-9dbb-5dd95ae9d00b),
--                              keeping purchaser Mr Adam (+6221 4600007) as primary.
--   6. PT. Meiji Indonesian Pharmaceutical: Demote Bangil plant line (39398510-c836-484a-9ddc-5e3548789c86),
--                                           keeping Jakarta head office (021 21383388) as primary.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_locked_count INT;
  v_rows_updated INT;
  v_invalid_state_count INT;
  v_target_ids uuid[] := ARRAY[
    'a33be333-4bca-46b0-b855-633dc8bf605e'::uuid, -- Afifarma duplicate
    '7c994365-edc6-4435-8257-3e1ed585818d'::uuid, -- Anugrah landline
    '7fcaf882-0db0-4350-8198-e2de5a57a9dc'::uuid, -- Anugrah mobile Ms Alya
    'bd62e743-23f3-4c6d-bb0d-544e7b11b9a3'::uuid, -- Konimex switchboard
    'c7e0b7a6-4d7f-4af1-8f9c-e7505100e68b'::uuid, -- Medikon HQ switchboard
    '6c2f5cc1-a67e-4ef5-9dbb-5dd95ae9d00b'::uuid, -- Mahakam SAPJ hotline
    '39398510-c836-484a-9ddc-5e3548789c86'::uuid  -- Meiji Bangil plant
  ];
  v_retained_ids uuid[] := ARRAY[
    'f333647e-3e3f-48a5-8238-54fcfda270f7'::uuid, -- Afifarma Kediri line
    'af50aef6-dbc8-45d1-9c66-56c5e7f10d0a'::uuid, -- Anugrah Hinsa Silitonga mobile
    'ec4ef328-5a29-46b6-aaad-cb904753eb11'::uuid, -- Konimex Silvia Margaretha
    '939dd1a6-9389-421e-9152-42ca13998548'::uuid, -- Medikon Ms Fiona
    'f85db461-cb21-47c9-ac37-b214881bf013'::uuid, -- Mahakam Mr Adam
    '7b1892e6-4af2-4a16-8e0f-66922cb89a30'::uuid  -- Meiji Jakarta Tebet HQ
  ];
  v_case_contacts uuid[] := ARRAY[
    '80ee11cf-7eb3-4054-bd65-b1bafcf2686b'::uuid,
    'caad7c41-ad40-47ba-bde0-bf3f505390fa'::uuid,
    'e53d1921-62fa-4310-b0da-91535adbe194'::uuid,
    '6b4325d8-b79a-4602-9fd0-91e0df65bd03'::uuid,
    '987b5d43-e04d-419b-a399-a5240096cfdd'::uuid,
    '17feb96c-4506-4913-87ae-81f778f101cc'::uuid
  ];
BEGIN
  -- 1. Lock all 13 involved records (7 demote targets + 6 retained primaries)
  PERFORM id
  FROM public.crm_contact_phones
  WHERE id = ANY(v_target_ids || v_retained_ids)
  FOR UPDATE;

  GET DIAGNOSTICS v_locked_count = ROW_COUNT;

  IF v_locked_count <> 13 THEN
    RAISE EXCEPTION 'Precondition failed: Expected to lock 13 records, locked %', v_locked_count
      USING ERRCODE = 'data_exception';
  END IF;

  -- 2. Verify all 7 targets are currently is_primary = true
  SELECT COUNT(*) INTO v_invalid_state_count
  FROM public.crm_contact_phones
  WHERE id = ANY(v_target_ids) AND is_primary = false;

  IF v_invalid_state_count > 0 THEN
    RAISE EXCEPTION 'Precondition failed: % demote targets are already marked non-primary', v_invalid_state_count
      USING ERRCODE = 'data_exception';
  END IF;

  -- 3. Perform atomic demotion of the 7 records
  WITH updated AS (
    UPDATE public.crm_contact_phones
    SET is_primary = false, updated_at = NOW()
    WHERE id = ANY(v_target_ids) AND is_primary = true
    RETURNING id
  )
  SELECT COUNT(*) INTO v_rows_updated FROM updated;

  IF v_rows_updated <> 7 THEN
    RAISE EXCEPTION 'Postcondition failed: Expected 7 rows updated, got %', v_rows_updated
      USING ERRCODE = 'data_exception';
  END IF;

  -- 4. Verify each of the 6 companies now has EXACTLY 1 primary phone
  SELECT COUNT(*) INTO v_invalid_state_count
  FROM (
    SELECT contact_id, COUNT(*) as p_count
    FROM public.crm_contact_phones
    WHERE contact_id = ANY(v_case_contacts) AND is_primary = true
    GROUP BY contact_id
  ) c
  WHERE c.p_count <> 1;

  IF v_invalid_state_count > 0 THEN
    RAISE EXCEPTION 'Postcondition failed: Not all 6 commercial companies have exactly 1 primary phone'
      USING ERRCODE = 'data_exception';
  END IF;

  RAISE NOTICE 'SUCCESS: All 7 secondary records demoted. Exactly 1 primary phone active per company.';
END $$;

COMMIT;

-- =============================================================================
-- CONDITIONAL ROLLBACK PROCEDURE (Run only if reversing this specific change)
-- =============================================================================
/*
BEGIN;
UPDATE public.crm_contact_phones
SET is_primary = true, updated_at = NOW()
WHERE id IN (
  'a33be333-4bca-46b0-b855-633dc8bf605e',
  '7c994365-edc6-4435-8257-3e1ed585818d',
  '7fcaf882-0db0-4350-8198-e2de5a57a9dc',
  'bd62e743-23f3-4c6d-bb0d-544e7b11b9a3',
  'c7e0b7a6-4d7f-4af1-8f9c-e7505100e68b',
  '6c2f5cc1-a67e-4ef5-9dbb-5dd95ae9d00b',
  '39398510-c836-484a-9ddc-5e3548789c86'
);
COMMIT;
*/
