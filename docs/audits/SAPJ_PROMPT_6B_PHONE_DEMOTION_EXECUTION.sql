-- =============================================================================
-- SAPJ ERP — PROMPT 6B: CRM PHONE DEMOTIONS EXECUTION SCRIPT
-- =============================================================================
-- STATUS: OWNER APPROVED — NOT EXECUTED — FINAL EXECUTION AUTHORIZATION REQUIRED
-- TARGET DATABASE: Supabase Production dkrtsqienlhpouohmfki (AWS ap-southeast-1)
-- SCOPE: Exactly 13 approved phone demotions across 12 verified companies.
--
-- NON-NEGOTIABLE SAFETY INVARIANTS:
-- 1. All 13 updates execute within an atomic transaction (BEGIN ... COMMIT).
-- 2. Strict preconditions assert:
--    - Each demote phone UUID exists, belongs to expected contact_id, and is currently is_primary = true.
--    - Each retained phone UUID exists, belongs to expected contact_id, and is currently is_primary = true.
-- 3. Row count validation asserts exactly 13 rows updated; aborts transaction otherwise.
-- 4. Post-condition asserts each of the 12 companies has exactly 1 primary phone.
-- 5. Six commercial confirmation cases are EXCLUDED and remain untouched.
-- 6. Partial unique index (uq_crm_contact_single_primary_phone) is NOT created.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- BEFORE-VERIFICATION QUERY (Run this before executing to verify current state)
-- -----------------------------------------------------------------------------
/*
SELECT 
  c.id as contact_id,
  c.company_name,
  COUNT(p.id) as total_phones,
  COUNT(p.id) FILTER (WHERE p.is_primary = true) as current_primary_count
FROM public.crm_contacts c
JOIN public.crm_contact_phones p ON p.contact_id = c.id
WHERE c.id IN (
  '28afdb31-babd-4975-a100-26f81dd0fa16', -- DJAMU DJAGO (current: 2)
  '3004a29f-2fbe-48ea-bdc7-b6d0a8119c82', -- PT BAHTERA SENTRA NIAGATAMA (current: 2)
  'cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b', -- PT COMBIPHAR (current: 2)
  'd6830ce1-7904-4c01-afdd-392205293f40', -- PT Lloyd Pharma Indonesia (current: 2)
  '177e9c47-7c57-438a-911b-5ffca8652ab8', -- PT Perusahaan Dagang dan Industri Kaliroto (current: 2)
  '78958f07-0fdf-4c87-a93d-9a8454f9eb1c', -- PT Prima Cita Prasada (current: 2)
  'ef17e387-502c-4506-8ad7-3dc59e4b2f49', -- PT Roi Surya Prima Farma (current: 2)
  'b768af4b-dd06-4a0e-841f-5a6aa4dd188e', -- PT Shubham Anzen Pharma Jaya (current: 2)
  '2a53b06c-67d1-45da-9c38-edde3be7dc93', -- PT Synergi Mitra Abadi (current: 2)
  'c5d7c938-5878-4bfa-bf44-36e81dddc1a4', -- PT. SANBE FARMA (current: 3)
  '986ea4c3-2f2a-4ad2-97d8-f4e758705c5a', -- PT.Medion Farma Jaya (current: 2)
  '3b61c088-4b91-4217-835b-3577da389fc0'  -- PT.Rama Emerald Multi Sukses (current: 2)
)
GROUP BY c.id, c.company_name
ORDER BY c.company_name;
*/

BEGIN;

-- =============================================================================
-- STEP 1: PRECONDITION ASSERTIONS
-- =============================================================================
DO $$
DECLARE
  v_invalid_count INT;
  v_kept_missing INT;
BEGIN
  -- 1A. Assert all 13 demote UUIDs exist, belong to expected contact, and are primary
  SELECT COUNT(*) INTO v_invalid_count
  FROM (
    VALUES
      ('1f503482-4f9c-47f1-a572-51df76a59361'::uuid, '28afdb31-babd-4975-a100-26f81dd0fa16'::uuid), -- DJAMU DJAGO
      ('f6a9cd15-7e04-4a61-88b8-d4654652e18e'::uuid, '3004a29f-2fbe-48ea-bdc7-b6d0a8119c82'::uuid), -- PT BAHTERA SENTRA NIAGATAMA
      ('b1d0edf0-01a3-475f-9d59-5656d2c0141f'::uuid, 'cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b'::uuid), -- PT COMBIPHAR
      ('ce170f91-fe35-4729-945c-a73fa22e5e0b'::uuid, 'd6830ce1-7904-4c01-afdd-392205293f40'::uuid), -- PT Lloyd Pharma Indonesia
      ('086bdf95-f282-4c80-80a6-c0c7f84885a8'::uuid, '177e9c47-7c57-438a-911b-5ffca8652ab8'::uuid), -- PT Perusahaan Dagang dan Industri Kaliroto
      ('0ea5aa2a-7285-4545-a5b9-74ca80a1ee76'::uuid, '78958f07-0fdf-4c87-a93d-9a8454f9eb1c'::uuid), -- PT Prima Cita Prasada
      ('20272510-d496-4aa8-8d33-c22d3e5c778c'::uuid, 'ef17e387-502c-4506-8ad7-3dc59e4b2f49'::uuid), -- PT Roi Surya Prima Farma
      ('c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1'::uuid, 'b768af4b-dd06-4a0e-841f-5a6aa4dd188e'::uuid), -- PT Shubham Anzen Pharma Jaya
      ('df629243-0d0d-44ca-af04-a1edb39f3d9a'::uuid, '2a53b06c-67d1-45da-9c38-edde3be7dc93'::uuid), -- PT Synergi Mitra Abadi
      ('17da83bf-c7ba-4d0e-9723-e30e49f080c5'::uuid, 'c5d7c938-5878-4bfa-bf44-36e81dddc1a4'::uuid), -- PT. SANBE FARMA (Demote 1)
      ('aab97f7e-2f24-4a1f-977f-0b0e44625171'::uuid, 'c5d7c938-5878-4bfa-bf44-36e81dddc1a4'::uuid), -- PT. SANBE FARMA (Demote 2)
      ('db76ee70-1c78-4e95-9b31-8b9c79e85394'::uuid, '986ea4c3-2f2a-4ad2-97d8-f4e758705c5a'::uuid), -- PT.Medion Farma Jaya
      ('ec57e9b5-b66d-4840-a406-6f2a443a28ee'::uuid, '3b61c088-4b91-4217-835b-3577da389fc0'::uuid)  -- PT.Rama Emerald Multi Sukses
  ) AS expected(demote_id, contact_id)
  LEFT JOIN public.crm_contact_phones p 
    ON p.id = expected.demote_id 
   AND p.contact_id = expected.contact_id 
   AND p.is_primary = true
  WHERE p.id IS NULL;

  IF v_invalid_count > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % of the 13 demote records are missing, misassigned, or not currently primary. Aborting transaction.', v_invalid_count;
  END IF;

  -- 1B. Assert each of the 12 retained phones is present, belongs to expected contact, and is primary
  SELECT COUNT(*) INTO v_kept_missing
  FROM (
    VALUES
      ('e1a9a8f1-3e29-48a6-afd2-7882927114d1'::uuid, '28afdb31-babd-4975-a100-26f81dd0fa16'::uuid), -- DJAMU DJAGO
      ('957fd44a-1d7a-4bd0-a360-1aaf630505ae'::uuid, '3004a29f-2fbe-48ea-bdc7-b6d0a8119c82'::uuid), -- PT BAHTERA SENTRA NIAGATAMA
      ('ee79eea6-d631-4c94-86fa-f0fb75b86fec'::uuid, 'cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b'::uuid), -- PT COMBIPHAR
      ('633c42a3-d976-43af-897b-638f4cfb8089'::uuid, 'd6830ce1-7904-4c01-afdd-392205293f40'::uuid), -- PT Lloyd Pharma Indonesia
      ('279e459b-0b22-4ec0-b253-6587308afbb8'::uuid, '177e9c47-7c57-438a-911b-5ffca8652ab8'::uuid), -- PT Perusahaan Dagang dan Industri Kaliroto
      ('f1f13dad-d70d-40b1-beb6-170b1126c458'::uuid, '78958f07-0fdf-4c87-a93d-9a8454f9eb1c'::uuid), -- PT Prima Cita Prasada
      ('e3db634a-8ecf-4dd1-bb19-563d408d9020'::uuid, 'ef17e387-502c-4506-8ad7-3dc59e4b2f49'::uuid), -- PT Roi Surya Prima Farma
      ('a4b63186-6fab-4c81-8de1-da9df64bd1b1'::uuid, 'b768af4b-dd06-4a0e-841f-5a6aa4dd188e'::uuid), -- PT Shubham Anzen Pharma Jaya
      ('f5ff2c11-8056-4574-9531-236808e86e92'::uuid, '2a53b06c-67d1-45da-9c38-edde3be7dc93'::uuid), -- PT Synergi Mitra Abadi
      ('121900ba-053f-4511-874a-30ad153dfef4'::uuid, 'c5d7c938-5878-4bfa-bf44-36e81dddc1a4'::uuid), -- PT. SANBE FARMA
      ('1a3e642d-6f9a-4974-9abe-861442cba7ff'::uuid, '986ea4c3-2f2a-4ad2-97d8-f4e758705c5a'::uuid), -- PT.Medion Farma Jaya
      ('26dbb22b-c2ce-401c-a3c0-53951287fac1'::uuid, '3b61c088-4b91-4217-835b-3577da389fc0'::uuid)  -- PT.Rama Emerald Multi Sukses
  ) AS expected(keep_id, contact_id)
  LEFT JOIN public.crm_contact_phones p 
    ON p.id = expected.keep_id 
   AND p.contact_id = expected.contact_id 
   AND p.is_primary = true
  WHERE p.id IS NULL;

  IF v_kept_missing > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % of the 12 retained primary phones are missing or not primary. Aborting transaction.', v_kept_missing;
  END IF;

  RAISE NOTICE 'PRECONDITION CHECK PASSED: All 13 demote targets and 12 retained phones verified.';
END $$;


-- =============================================================================
-- STEP 2: EXECUTE EXACT 13 DEMOTIONS (SET is_primary = false)
-- =============================================================================
UPDATE public.crm_contact_phones
SET 
  is_primary = false,
  updated_at = NOW()
WHERE id IN (
  '1f503482-4f9c-47f1-a572-51df76a59361', -- DJAMU DJAGO: (024) 3555 805 (landline)
  'f6a9cd15-7e04-4a61-88b8-d4654652e18e', -- PT BAHTERA SENTRA NIAGATAMA: +62 21 29616463 (landline)
  'b1d0edf0-01a3-475f-9d59-5656d2c0141f', -- PT COMBIPHAR: 021 2933 3031 (landline)
  'ce170f91-fe35-4729-945c-a73fa22e5e0b', -- PT Lloyd Pharma Indonesia: 021 5902515 (landline)
  '086bdf95-f282-4c80-80a6-c0c7f84885a8', -- PT Perusahaan Dagang dan Industri Kaliroto: 031 3711717 (landline)
  '0ea5aa2a-7285-4545-a5b9-74ca80a1ee76', -- PT Prima Cita Prasada: +62 21 3529 4362 (landline)
  '20272510-d496-4aa8-8d33-c22d3e5c778c', -- PT Roi Surya Prima Farma: 0343 631897 (duplicate landline)
  'c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1', -- PT Shubham Anzen Pharma Jaya: +62 21 6583 2426 (landline)
  'df629243-0d0d-44ca-af04-a1edb39f3d9a', -- PT Synergi Mitra Abadi: +62 21 3885 6027 (landline)
  '17da83bf-c7ba-4d0e-9723-e30e49f080c5', -- PT. SANBE FARMA (Demote 1): 0224207725 (landline)
  'aab97f7e-2f24-4a1f-977f-0b0e44625171', -- PT. SANBE FARMA (Demote 2): +62 22 603 0036 (landline)
  'db76ee70-1c78-4e95-9b31-8b9c79e85394', -- PT.Medion Farma Jaya: 022) 6866090 (landline)
  'ec57e9b5-b66d-4840-a406-6f2a443a28ee'  -- PT.Rama Emerald Multi Sukses: 0317507406 (landline)
)
AND is_primary = true;


-- =============================================================================
-- STEP 3: POST-CONDITION ASSERTIONS (EXACT 13 ROWS UPDATED)
-- =============================================================================
DO $$
DECLARE
  v_rows_updated INT;
  v_multi_primary_count INT;
BEGIN
  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  IF v_rows_updated <> 13 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: Expected exactly 13 updates, but % rows were updated. Aborting transaction.', v_rows_updated;
  END IF;

  -- Assert that none of the 12 companies now have more than 1 primary phone
  SELECT COUNT(*) INTO v_multi_primary_count
  FROM (
    SELECT p.contact_id
    FROM public.crm_contact_phones p
    WHERE p.contact_id IN (
      '28afdb31-babd-4975-a100-26f81dd0fa16',
      '3004a29f-2fbe-48ea-bdc7-b6d0a8119c82',
      'cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b',
      'd6830ce1-7904-4c01-afdd-392205293f40',
      '177e9c47-7c57-438a-911b-5ffca8652ab8',
      '78958f07-0fdf-4c87-a93d-9a8454f9eb1c',
      'ef17e387-502c-4506-8ad7-3dc59e4b2f49',
      'b768af4b-dd06-4a0e-841f-5a6aa4dd188e',
      '2a53b06c-67d1-45da-9c38-edde3be7dc93',
      'c5d7c938-5878-4bfa-bf44-36e81dddc1a4',
      '986ea4c3-2f2a-4ad2-97d8-f4e758705c5a',
      '3b61c088-4b91-4217-835b-3577da389fc0'
    )
    AND p.is_primary = true
    GROUP BY p.contact_id
    HAVING COUNT(*) <> 1
  ) sub;

  IF v_multi_primary_count > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % companies still do not have exactly 1 primary phone. Aborting transaction.', v_multi_primary_count;
  END IF;

  RAISE NOTICE 'EXECUTION SUCCESS: Exactly 13 phone records demoted to secondary. All 12 companies now possess exactly 1 verified primary phone.';
END $$;

COMMIT;


-- =============================================================================
-- POST-EXECUTION VERIFICATION QUERY
-- =============================================================================
/*
SELECT 
  c.company_name,
  p.id as primary_phone_id,
  p.raw_phone,
  p.phone_type,
  p.is_primary,
  p.contact_person
FROM public.crm_contacts c
JOIN public.crm_contact_phones p ON p.contact_id = c.id
WHERE c.id IN (
  '28afdb31-babd-4975-a100-26f81dd0fa16',
  '3004a29f-2fbe-48ea-bdc7-b6d0a8119c82',
  'cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b',
  'd6830ce1-7904-4c01-afdd-392205293f40',
  '177e9c47-7c57-438a-911b-5ffca8652ab8',
  '78958f07-0fdf-4c87-a93d-9a8454f9eb1c',
  'ef17e387-502c-4506-8ad7-3dc59e4b2f49',
  'b768af4b-dd06-4a0e-841f-5a6aa4dd188e',
  '2a53b06c-67d1-45da-9c38-edde3be7dc93',
  'c5d7c938-5878-4bfa-bf44-36e81dddc1a4',
  '986ea4c3-2f2a-4ad2-97d8-f4e758705c5a',
  '3b61c088-4b91-4217-835b-3577da389fc0'
)
AND p.is_primary = true
ORDER BY c.company_name;
-- Expected Result: Exactly 12 rows returned (1 per company).
*/


-- =============================================================================
-- ROLLBACK SCRIPT (Restores all 13 demoted phones back to is_primary = true)
-- =============================================================================
/*
BEGIN;
UPDATE public.crm_contact_phones
SET 
  is_primary = true,
  updated_at = NOW()
WHERE id IN (
  '1f503482-4f9c-47f1-a572-51df76a59361',
  'f6a9cd15-7e04-4a61-88b8-d4654652e18e',
  'b1d0edf0-01a3-475f-9d59-5656d2c0141f',
  'ce170f91-fe35-4729-945c-a73fa22e5e0b',
  '086bdf95-f282-4c80-80a6-c0c7f84885a8',
  '0ea5aa2a-7285-4545-a5b9-74ca80a1ee76',
  '20272510-d496-4aa8-8d33-c22d3e5c778c',
  'c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1',
  'df629243-0d0d-44ca-af04-a1edb39f3d9a',
  '17da83bf-c7ba-4d0e-9723-e30e49f080c5',
  'aab97f7e-2f24-4a1f-977f-0b0e44625171',
  'db76ee70-1c78-4e95-9b31-8b9c79e85394',
  'ec57e9b5-b66d-4840-a406-6f2a443a28ee'
);
COMMIT;
*/

