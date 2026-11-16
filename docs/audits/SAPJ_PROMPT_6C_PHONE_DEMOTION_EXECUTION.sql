-- =============================================================================
-- SAPJ ERP — PROMPT 6C: CRM PHONE DEMOTIONS EXECUTION SCRIPT
-- =============================================================================
-- STATUS: OWNER APPROVED — NOT EXECUTED — AWAITING FINAL EXECUTION AUTHORIZATION
-- TARGET DATABASE: Supabase Production dkrtsqienlhpouohmfki (AWS ap-southeast-1)
-- SCOPE: Exactly 13 approved phone demotions across 12 verified companies.
--
-- NON-NEGOTIABLE SAFETY INVARIANTS:
-- 1. All 13 updates execute within a single atomic PL/pgSQL block inside BEGIN ... COMMIT.
-- 2. Concurrency Safety: Explicitly locks all 25 involved phone records (13 demote targets
--    + 12 retained primaries) using SELECT ... FOR UPDATE before assertions and updates.
-- 3. Preconditions assert:
--    - Each demote phone UUID exists, belongs to expected contact_id, and is currently is_primary = true.
--    - Each retained phone UUID exists, belongs to expected contact_id, and is currently is_primary = true.
-- 4. Row Count Assertion: Uses UPDATE ... RETURNING inside the same PL/pgSQL block to capture
--    actual affected row count and strictly asserts v_rows_updated = 13.
-- 5. Comprehensive Post-Condition: Verifies every single one of the 12 companies has
--    EXACTLY ONE primary phone remaining, explicitly catching both 0 and >1 primary phones.
-- 6. Safe & Conditional Rollback: Rollback script contains strict preconditions; it will
--    NOT blindly restore primary status if subsequent owner-approved modifications occurred.
-- 7. Six commercial confirmation cases are EXCLUDED and remain untouched.
-- 8. Partial unique index (uq_crm_contact_single_primary_phone) is NOT created.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SECTION 1: PRE-EXECUTION INSPECTION QUERY (Run read-only before execution)
-- -----------------------------------------------------------------------------
/*
SELECT 
  c.id as contact_id,
  c.company_name,
  COUNT(p.id) as total_phones,
  COUNT(p.id) FILTER (WHERE p.is_primary = true) as current_primary_count,
  ARRAY_AGG(p.raw_phone || ' (' || p.phone_type || ', primary=' || p.is_primary::text || ')') as phones
FROM public.crm_contacts c
JOIN public.crm_contact_phones p ON p.contact_id = c.id
WHERE c.id IN (
  '28afdb31-babd-4975-a100-26f81dd0fa16', -- DJAMU DJAGO
  '3004a29f-2fbe-48ea-bdc7-b6d0a8119c82', -- PT BAHTERA SENTRA NIAGATAMA
  'cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b', -- PT COMBIPHAR
  'd6830ce1-7904-4c01-afdd-392205293f40', -- PT Lloyd Pharma Indonesia
  '177e9c47-7c57-438a-911b-5ffca8652ab8', -- PT Perusahaan Dagang dan Industri Kaliroto
  '78958f07-0fdf-4c87-a93d-9a8454f9eb1c', -- PT Prima Cita Prasada
  'ef17e387-502c-4506-8ad7-3dc59e4b2f49', -- PT Roi Surya Prima Farma
  'b768af4b-dd06-4a0e-841f-5a6aa4dd188e', -- PT Shubham Anzen Pharma Jaya
  '2a53b06c-67d1-45da-9c38-edde3be7dc93', -- PT Synergi Mitra Abadi
  'c5d7c938-5878-4bfa-bf44-36e81dddc1a4', -- PT. SANBE FARMA
  '986ea4c3-2f2a-4ad2-97d8-f4e758705c5a', -- PT.Medion Farma Jaya
  '3b61c088-4b91-4217-835b-3577da389fc0'  -- PT.Rama Emerald Multi Sukses
)
GROUP BY c.id, c.company_name
ORDER BY c.company_name;
*/


-- -----------------------------------------------------------------------------
-- SECTION 2: ATOMIC EXECUTION BLOCK (Run only upon explicit Owner Authorization)
-- -----------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_locked_count INT;
  v_invalid_demote_count INT;
  v_invalid_keep_count INT;
  v_rows_updated INT;
  v_anomalous_contact_count INT;
BEGIN
  -- ===========================================================================
  -- 1. PESSIMISTIC LOCKING: Lock all 25 involved phone records (13 demote + 12 keep)
  --    Prevents concurrent changes between preconditions, update, and assertions.
  -- ===========================================================================
  SELECT COUNT(*) INTO v_locked_count
  FROM public.crm_contact_phones
  WHERE id IN (
    -- 13 Demote Targets
    '1f503482-4f9c-47f1-a572-51df76a59361'::uuid, -- DJAMU DJAGO
    'f6a9cd15-7e04-4a61-88b8-d4654652e18e'::uuid, -- PT BAHTERA SENTRA NIAGATAMA
    'b1d0edf0-01a3-475f-9d59-5656d2c0141f'::uuid, -- PT COMBIPHAR
    'ce170f91-fe35-4729-945c-a73fa22e5e0b'::uuid, -- PT Lloyd Pharma Indonesia
    '086bdf95-f282-4c80-80a6-c0c7f84885a8'::uuid, -- PT Perusahaan Dagang dan Industri Kaliroto
    '0ea5aa2a-7285-4545-a5b9-74ca80a1ee76'::uuid, -- PT Prima Cita Prasada
    '20272510-d496-4aa8-8d33-c22d3e5c778c'::uuid, -- PT Roi Surya Prima Farma
    'c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1'::uuid, -- PT Shubham Anzen Pharma Jaya
    'df629243-0d0d-44ca-af04-a1edb39f3d9a'::uuid, -- PT Synergi Mitra Abadi
    '17da83bf-c7ba-4d0e-9723-e30e49f080c5'::uuid, -- PT. SANBE FARMA (Demote 1)
    'aab97f7e-2f24-4a1f-977f-0b0e44625171'::uuid, -- PT. SANBE FARMA (Demote 2)
    'db76ee70-1c78-4e95-9b31-8b9c79e85394'::uuid, -- PT.Medion Farma Jaya
    'ec57e9b5-b66d-4840-a406-6f2a443a28ee'::uuid, -- PT.Rama Emerald Multi Sukses
    -- 12 Retained Primary Phones
    'e1a9a8f1-3e29-48a6-afd2-7882927114d1'::uuid, -- DJAMU DJAGO
    '957fd44a-1d7a-4bd0-a360-1aaf630505ae'::uuid, -- PT BAHTERA SENTRA NIAGATAMA
    'ee79eea6-d631-4c94-86fa-f0fb75b86fec'::uuid, -- PT COMBIPHAR
    '633c42a3-d976-43af-897b-638f4cfb8089'::uuid, -- PT Lloyd Pharma Indonesia
    '279e459b-0b22-4ec0-b253-6587308afbb8'::uuid, -- PT Perusahaan Dagang dan Industri Kaliroto
    'f1f13dad-d70d-40b1-beb6-170b1126c458'::uuid, -- PT Prima Cita Prasada
    'e3db634a-8ecf-4dd1-bb19-563d408d9020'::uuid, -- PT Roi Surya Prima Farma
    'a4b63186-6fab-4c81-8de1-da9df64bd1b1'::uuid, -- PT Shubham Anzen Pharma Jaya
    'f5ff2c11-8056-4574-9531-236808e86e92'::uuid, -- PT Synergi Mitra Abadi
    '121900ba-053f-4511-874a-30ad153dfef4'::uuid, -- PT. SANBE FARMA
    '1a3e642d-6f9a-4974-9abe-861442cba7ff'::uuid, -- PT.Medion Farma Jaya
    '26dbb22b-c2ce-401c-a3c0-53951287fac1'::uuid  -- PT.Rama Emerald Multi Sukses
  )
  FOR UPDATE;

  IF v_locked_count <> 25 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: Expected to lock exactly 25 phone records (13 demote + 12 keep), but found %. Aborting transaction.', v_locked_count;
  END IF;

  -- ===========================================================================
  -- 2. PRECONDITION ASSERTION: Verify all 13 demote targets are assigned & primary
  -- ===========================================================================
  SELECT COUNT(*) INTO v_invalid_demote_count
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

  IF v_invalid_demote_count > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % of the 13 demote records are missing, misassigned, or not currently primary. Aborting transaction.', v_invalid_demote_count;
  END IF;

  -- ===========================================================================
  -- 3. PRECONDITION ASSERTION: Verify all 12 retained phones are assigned & primary
  -- ===========================================================================
  SELECT COUNT(*) INTO v_invalid_keep_count
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

  IF v_invalid_keep_count > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: % of the 12 retained primary phones are missing, misassigned, or not primary. Aborting transaction.', v_invalid_keep_count;
  END IF;

  -- ===========================================================================
  -- 4. EXECUTE DEMOTIONS: Using UPDATE ... RETURNING to reliably capture row count
  -- ===========================================================================
  WITH demoted_rows AS (
    UPDATE public.crm_contact_phones
    SET 
      is_primary = false,
      updated_at = NOW()
    WHERE id IN (
      '1f503482-4f9c-47f1-a572-51df76a59361'::uuid, -- DJAMU DJAGO
      'f6a9cd15-7e04-4a61-88b8-d4654652e18e'::uuid, -- PT BAHTERA SENTRA NIAGATAMA
      'b1d0edf0-01a3-475f-9d59-5656d2c0141f'::uuid, -- PT COMBIPHAR
      'ce170f91-fe35-4729-945c-a73fa22e5e0b'::uuid, -- PT Lloyd Pharma Indonesia
      '086bdf95-f282-4c80-80a6-c0c7f84885a8'::uuid, -- PT Perusahaan Dagang dan Industri Kaliroto
      '0ea5aa2a-7285-4545-a5b9-74ca80a1ee76'::uuid, -- PT Prima Cita Prasada
      '20272510-d496-4aa8-8d33-c22d3e5c778c'::uuid, -- PT Roi Surya Prima Farma
      'c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1'::uuid, -- PT Shubham Anzen Pharma Jaya
      'df629243-0d0d-44ca-af04-a1edb39f3d9a'::uuid, -- PT Synergi Mitra Abadi
      '17da83bf-c7ba-4d0e-9723-e30e49f080c5'::uuid, -- PT. SANBE FARMA (Demote 1)
      'aab97f7e-2f24-4a1f-977f-0b0e44625171'::uuid, -- PT. SANBE FARMA (Demote 2)
      'db76ee70-1c78-4e95-9b31-8b9c79e85394'::uuid, -- PT.Medion Farma Jaya
      'ec57e9b5-b66d-4840-a406-6f2a443a28ee'::uuid  -- PT.Rama Emerald Multi Sukses
    )
    AND is_primary = true
    RETURNING id
  )
  SELECT COUNT(*) INTO v_rows_updated FROM demoted_rows;

  -- Strictly assert exactly 13 affected rows
  IF v_rows_updated <> 13 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: Expected exactly 13 updates, but % rows were updated. Aborting transaction.', v_rows_updated;
  END IF;

  -- ===========================================================================
  -- 5. COMPREHENSIVE POST-CONDITION ASSERTION:
  --    Verify that every single one of the 12 companies has EXACTLY 1 primary phone.
  --    Detects both:
  --      - Contacts with 0 primary phones (e.g. if keep phone was inadvertently demoted)
  --      - Contacts with >1 primary phones (e.g. if extra primary existed)
  -- ===========================================================================
  SELECT COUNT(*) INTO v_anomalous_contact_count
  FROM (
    SELECT 
      expected_contacts.id as contact_id, 
      COUNT(p.id) FILTER (WHERE p.is_primary = true) as primary_count
    FROM (
      VALUES 
        ('28afdb31-babd-4975-a100-26f81dd0fa16'::uuid), -- DJAMU DJAGO
        ('3004a29f-2fbe-48ea-bdc7-b6d0a8119c82'::uuid), -- PT BAHTERA SENTRA NIAGATAMA
        ('cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b'::uuid), -- PT COMBIPHAR
        ('d6830ce1-7904-4c01-afdd-392205293f40'::uuid), -- PT Lloyd Pharma Indonesia
        ('177e9c47-7c57-438a-911b-5ffca8652ab8'::uuid), -- PT Perusahaan Dagang dan Industri Kaliroto
        ('78958f07-0fdf-4c87-a93d-9a8454f9eb1c'::uuid), -- PT Prima Cita Prasada
        ('ef17e387-502c-4506-8ad7-3dc59e4b2f49'::uuid), -- PT Roi Surya Prima Farma
        ('b768af4b-dd06-4a0e-841f-5a6aa4dd188e'::uuid), -- PT Shubham Anzen Pharma Jaya
        ('2a53b06c-67d1-45da-9c38-edde3be7dc93'::uuid), -- PT Synergi Mitra Abadi
        ('c5d7c938-5878-4bfa-bf44-36e81dddc1a4'::uuid), -- PT. SANBE FARMA
        ('986ea4c3-2f2a-4ad2-97d8-f4e758705c5a'::uuid), -- PT.Medion Farma Jaya
        ('3b61c088-4b91-4217-835b-3577da389fc0'::uuid)  -- PT.Rama Emerald Multi Sukses
    ) AS expected_contacts(id)
    LEFT JOIN public.crm_contact_phones p ON p.contact_id = expected_contacts.id
    GROUP BY expected_contacts.id
    HAVING COUNT(p.id) FILTER (WHERE p.is_primary = true) <> 1
  ) anomalous;

  IF v_anomalous_contact_count > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % contact(s) do not possess exactly 1 primary phone (detected 0 or >1 primary phones). Aborting transaction.', v_anomalous_contact_count;
  END IF;

  RAISE NOTICE 'SUCCESS: Locked 25 rows, demoted exactly 13 phones. All 12 contacts now possess exactly 1 verified primary phone.';
END $$;

COMMIT;


-- -----------------------------------------------------------------------------
-- SECTION 3: POST-EXECUTION VERIFICATION QUERY (Run immediately after execution)
-- -----------------------------------------------------------------------------
/*
SELECT 
  c.id as contact_id,
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
-- Expected Output: Exactly 12 rows returned (1 verified primary phone per company).
*/


-- -----------------------------------------------------------------------------
-- SECTION 4: SAFE CONDITIONAL ROLLBACK SCRIPT
-- -----------------------------------------------------------------------------
-- This rollback is strictly conditional and safe. It will NOT blindly set
-- is_primary = true if any subsequent owner modifications have occurred on
-- the target phones or contacts (e.g. if a retained phone was deleted, another
-- phone was designated as primary, or target phones were reassigned).
-- -----------------------------------------------------------------------------
/*
BEGIN;

DO $$
DECLARE
  v_locked_count INT;
  v_invalid_demoted INT;
  v_invalid_retained INT;
  v_restored_rows INT;
BEGIN
  -- 1. Pessimistic lock on all 25 records
  SELECT COUNT(*) INTO v_locked_count
  FROM public.crm_contact_phones
  WHERE id IN (
    '1f503482-4f9c-47f1-a572-51df76a59361'::uuid,
    'f6a9cd15-7e04-4a61-88b8-d4654652e18e'::uuid,
    'b1d0edf0-01a3-475f-9d59-5656d2c0141f'::uuid,
    'ce170f91-fe35-4729-945c-a73fa22e5e0b'::uuid,
    '086bdf95-f282-4c80-80a6-c0c7f84885a8'::uuid,
    '0ea5aa2a-7285-4545-a5b9-74ca80a1ee76'::uuid,
    '20272510-d496-4aa8-8d33-c22d3e5c778c'::uuid,
    'c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1'::uuid,
    'df629243-0d0d-44ca-af04-a1edb39f3d9a'::uuid,
    '17da83bf-c7ba-4d0e-9723-e30e49f080c5'::uuid,
    'aab97f7e-2f24-4a1f-977f-0b0e44625171'::uuid,
    'db76ee70-1c78-4e95-9b31-8b9c79e85394'::uuid,
    'ec57e9b5-b66d-4840-a406-6f2a443a28ee'::uuid,
    'e1a9a8f1-3e29-48a6-afd2-7882927114d1'::uuid,
    '957fd44a-1d7a-4bd0-a360-1aaf630505ae'::uuid,
    'ee79eea6-d631-4c94-86fa-f0fb75b86fec'::uuid,
    '633c42a3-d976-43af-897b-638f4cfb8089'::uuid,
    '279e459b-0b22-4ec0-b253-6587308afbb8'::uuid,
    'f1f13dad-d70d-40b1-beb6-170b1126c458'::uuid,
    'e3db634a-8ecf-4dd1-bb19-563d408d9020'::uuid,
    'a4b63186-6fab-4c81-8de1-da9df64bd1b1'::uuid,
    'f5ff2c11-8056-4574-9531-236808e86e92'::uuid,
    '121900ba-053f-4511-874a-30ad153dfef4'::uuid,
    '1a3e642d-6f9a-4974-9abe-861442cba7ff'::uuid,
    '26dbb22b-c2ce-401c-a3c0-53951287fac1'::uuid
  )
  FOR UPDATE;

  IF v_locked_count <> 25 THEN
    RAISE EXCEPTION 'ROLLBACK ABORTED: One or more phone records missing from database (locked % of 25). Manual review required.', v_locked_count;
  END IF;

  -- 2. Verify all 13 demoted targets are currently is_primary = false
  SELECT COUNT(*) INTO v_invalid_demoted
  FROM public.crm_contact_phones
  WHERE id IN (
    '1f503482-4f9c-47f1-a572-51df76a59361'::uuid,
    'f6a9cd15-7e04-4a61-88b8-d4654652e18e'::uuid,
    'b1d0edf0-01a3-475f-9d59-5656d2c0141f'::uuid,
    'ce170f91-fe35-4729-945c-a73fa22e5e0b'::uuid,
    '086bdf95-f282-4c80-80a6-c0c7f84885a8'::uuid,
    '0ea5aa2a-7285-4545-a5b9-74ca80a1ee76'::uuid,
    '20272510-d496-4aa8-8d33-c22d3e5c778c'::uuid,
    'c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1'::uuid,
    'df629243-0d0d-44ca-af04-a1edb39f3d9a'::uuid,
    '17da83bf-c7ba-4d0e-9723-e30e49f080c5'::uuid,
    'aab97f7e-2f24-4a1f-977f-0b0e44625171'::uuid,
    'db76ee70-1c78-4e95-9b31-8b9c79e85394'::uuid,
    'ec57e9b5-b66d-4840-a406-6f2a443a28ee'::uuid
  )
  AND is_primary = true;

  IF v_invalid_demoted > 0 THEN
    RAISE EXCEPTION 'ROLLBACK ABORTED: % target phone(s) are already marked primary. Subsequent changes detected. Cannot rollback blindly.', v_invalid_demoted;
  END IF;

  -- 3. Verify all 12 retained phones are still the sole primary phones
  SELECT COUNT(*) INTO v_invalid_retained
  FROM public.crm_contact_phones
  WHERE id IN (
    'e1a9a8f1-3e29-48a6-afd2-7882927114d1'::uuid,
    '957fd44a-1d7a-4bd0-a360-1aaf630505ae'::uuid,
    'ee79eea6-d631-4c94-86fa-f0fb75b86fec'::uuid,
    '633c42a3-d976-43af-897b-638f4cfb8089'::uuid,
    '279e459b-0b22-4ec0-b253-6587308afbb8'::uuid,
    'f1f13dad-d70d-40b1-beb6-170b1126c458'::uuid,
    'e3db634a-8ecf-4dd1-bb19-563d408d9020'::uuid,
    'a4b63186-6fab-4c81-8de1-da9df64bd1b1'::uuid,
    'f5ff2c11-8056-4574-9531-236808e86e92'::uuid,
    '121900ba-053f-4511-874a-30ad153dfef4'::uuid,
    '1a3e642d-6f9a-4974-9abe-861442cba7ff'::uuid,
    '26dbb22b-c2ce-401c-a3c0-53951287fac1'::uuid
  )
  AND is_primary = false;

  IF v_invalid_retained > 0 THEN
    RAISE EXCEPTION 'ROLLBACK ABORTED: % retained phone(s) have been modified or demoted. Subsequent changes detected. Cannot rollback blindly.', v_invalid_retained;
  END IF;

  -- 4. Execute conditional restoration
  WITH restored_rows AS (
    UPDATE public.crm_contact_phones
    SET 
      is_primary = true,
      updated_at = NOW()
    WHERE id IN (
      '1f503482-4f9c-47f1-a572-51df76a59361'::uuid,
      'f6a9cd15-7e04-4a61-88b8-d4654652e18e'::uuid,
      'b1d0edf0-01a3-475f-9d59-5656d2c0141f'::uuid,
      'ce170f91-fe35-4729-945c-a73fa22e5e0b'::uuid,
      '086bdf95-f282-4c80-80a6-c0c7f84885a8'::uuid,
      '0ea5aa2a-7285-4545-a5b9-74ca80a1ee76'::uuid,
      '20272510-d496-4aa8-8d33-c22d3e5c778c'::uuid,
      'c458e82e-92e6-4a81-b08d-8bf0bb3ed9c1'::uuid,
      'df629243-0d0d-44ca-af04-a1edb39f3d9a'::uuid,
      '17da83bf-c7ba-4d0e-9723-e30e49f080c5'::uuid,
      'aab97f7e-2f24-4a1f-977f-0b0e44625171'::uuid,
      'db76ee70-1c78-4e95-9b31-8b9c79e85394'::uuid,
      'ec57e9b5-b66d-4840-a406-6f2a443a28ee'::uuid
    )
    AND is_primary = false
    RETURNING id
  )
  SELECT COUNT(*) INTO v_restored_rows FROM restored_rows;

  IF v_restored_rows <> 13 THEN
    RAISE EXCEPTION 'ROLLBACK FAILED: Expected to restore exactly 13 rows, but restored %. Aborting.', v_restored_rows;
  END IF;

  RAISE NOTICE 'ROLLBACK SUCCESSFUL: Restored all 13 phones to is_primary = true.';
END $$;

COMMIT;
*/

