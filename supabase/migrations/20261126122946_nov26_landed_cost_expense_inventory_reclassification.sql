-- Reconstructed from already-applied production migration 20261126122946
-- (recorded in supabase_migrations.schema_migrations; DO NOT rerun).
-- Creates current-period journal entry JE2611-0507 capitalizing Rp 59,605,958.00
-- of source-supported import landed-cost expenses (5300, 6900, 6950) to 1130 Inventory.

DO $$
DECLARE
  v_je_id uuid;
  v_1130 uuid;
  v_5300 uuid;
  v_6900 uuid;
  v_6950 uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE entry_number = 'JE2611-0507') THEN
    RETURN;
  END IF;

  SELECT id INTO v_1130 FROM public.chart_of_accounts WHERE code = '1130';
  SELECT id INTO v_5300 FROM public.chart_of_accounts WHERE code = '5300';
  SELECT id INTO v_6900 FROM public.chart_of_accounts WHERE code = '6900';
  SELECT id INTO v_6950 FROM public.chart_of_accounts WHERE code = '6950';

  INSERT INTO public.journal_entries (
    entry_number, entry_date, source_module, reference_number,
    description, total_debit, total_credit, is_posted
  )
  VALUES (
    'JE2611-0507',
    '2026-11-26',
    'landed_cost_inventory_reclass',
    'NOV26-LANDED-COST-RECLASS',
    'Current-period capitalization of source-supported import landed costs previously charged to Freight In / Miscellaneous Expense / Bea Meterai; source vouchers are identified in journal lines and original vouchers remain unchanged',
    59605958.00,
    59605958.00,
    true
  )
  RETURNING id INTO v_je_id;

  INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, line_number, description)
  VALUES
    (v_je_id, v_1130,   300000.00, 0,  1, 'Inventory capitalization - EXP/25/246 - Cash unloading - 1st 20MT FCL'),
    (v_je_id, v_6900, 0,   300000.00,  2, 'Reclass from original expense - EXP/25/246 / JE2511-0062'),
    (v_je_id, v_1130,   100000.00, 0,  3, 'Inventory capitalization - EXP/25/292 - Air shipment unloading - Chintia'),
    (v_je_id, v_5300, 0,   100000.00,  4, 'Reclass from original expense - EXP/25/292 / JE2512-0108'),
    (v_je_id, v_1130,   600000.00, 0,  5, 'Inventory capitalization - EXP/26-26/039 - 3rd FCL corn starch unloading'),
    (v_je_id, v_6900, 0,   600000.00,  6, 'Reclass from original expense - EXP/26-26/039 / JE2604-0060'),
    (v_je_id, v_1130, 10450721.00, 0,  7, 'Inventory capitalization - EXP/26-26/115 - 3rd FCL corn starch broker / clearance'),
    (v_je_id, v_5300, 0, 10450721.00,  8, 'Reclass from original expense - EXP/26-26/115 / JE2604-0094'),
    (v_je_id, v_1130,  6142500.00, 0,  9, 'Inventory capitalization - EXP/26-26/139 - Cefixime LCL broker / clearance'),
    (v_je_id, v_5300, 0,  6142500.00, 10, 'Reclass from original expense - EXP/26-26/139 / JE2609-0018'),
    (v_je_id, v_1130,   600000.00, 0, 11, 'Inventory capitalization - EXP/26/082 - 2nd FCL unloading - Nia Delisma'),
    (v_je_id, v_6900, 0,   600000.00, 12, 'Reclass from original expense - EXP/26/082 / JE2602-0139'),
    (v_je_id, v_1130,   250000.00, 0, 13, 'Inventory capitalization - EXP/26/083 - 2nd FCL port / security charge'),
    (v_je_id, v_6900, 0,   250000.00, 14, 'Reclass from original expense - EXP/26/083 / JE2602-0134'),
    (v_je_id, v_1130,  1600000.00, 0, 15, 'Inventory capitalization - EXP/26/084 - 2nd FCL unloading / coolie'),
    (v_je_id, v_6900, 0,  1600000.00, 16, 'Reclass from original expense - EXP/26/084 / JE2602-0130'),
    (v_je_id, v_1130, 20390915.00, 0, 17, 'Inventory capitalization - EXP/26/102 - 1st air broker freight / clearance, excluding VAT and stamp duty'),
    (v_je_id, v_5300, 0, 20390915.00, 18, 'Reclass from original expense - EXP/26/102 / JE2602-0200'),
    (v_je_id, v_1130,    10000.00, 0, 19, 'Inventory capitalization - EXP/26/102 - 1st air broker stamp duty'),
    (v_je_id, v_6950, 0,    10000.00, 20, 'Reclass from original expense - EXP/26/102 / JE2602-0200'),
    (v_je_id, v_1130,  5210637.00, 0, 21, 'Inventory capitalization - EXP/26/103 - 2nd air broker / clearance'),
    (v_je_id, v_5300, 0,  5210637.00, 22, 'Reclass from original expense - EXP/26/103 / JE2602-0201'),
    (v_je_id, v_1130, 10461185.00, 0, 23, 'Inventory capitalization - EXP/26/178 - Pregabalin air broker / clearance'),
    (v_je_id, v_5300, 0, 10461185.00, 24, 'Reclass from original expense - EXP/26/178 / JE2608-0169'),
    (v_je_id, v_1130,   200000.00, 0, 25, 'Inventory capitalization - EXP/26/183 - Mixed container security / parking'),
    (v_je_id, v_5300, 0,   200000.00, 26, 'Reclass from original expense - EXP/26/183 / JE2608-0189'),
    (v_je_id, v_1130,   900000.00, 0, 27, 'Inventory capitalization - EXP/26/185 - Mixed container unloading'),
    (v_je_id, v_5300, 0,   900000.00, 28, 'Reclass from original expense - EXP/26/185 / JE2608-0187'),
    (v_je_id, v_1130,   200000.00, 0, 29, 'Inventory capitalization - EXP/26/196 - Everest corn starch security charge'),
    (v_je_id, v_5300, 0,   200000.00, 30, 'Reclass from original expense - EXP/26/196 / JE2608-0173'),
    (v_je_id, v_1130,  1200000.00, 0, 31, 'Inventory capitalization - EXP/26/197 - Everest corn starch unloading'),
    (v_je_id, v_5300, 0,  1200000.00, 32, 'Reclass from original expense - EXP/26/197 / JE2608-0172'),
    (v_je_id, v_1130,   765000.00, 0, 33, 'Inventory capitalization - PC-202602-022 - 2nd FCL BL fee - PT Transliner Maritime Indonesia'),
    (v_je_id, v_5300, 0,   765000.00, 34, 'Reclass from original expense - PC-202602-022 / JE-20260211-0005'),
    (v_je_id, v_1130,   125000.00, 0, 35, 'Inventory capitalization - PC-202607-043 - Diclofenac loading / unloading PT Rania'),
    (v_je_id, v_5300, 0,   125000.00, 36, 'Reclass from original expense - PC-202607-043 / JE-20260724-0011'),
    (v_je_id, v_1130,   100000.00, 0, 37, 'Inventory capitalization - PC-202608-010 - Mixed container loading / unloading'),
    (v_je_id, v_5300, 0,   100000.00, 38, 'Reclass from original expense - PC-202608-010 / JE-20260811-0005');
END $$;
