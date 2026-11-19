BEGIN;
DO $$
DECLARE
  c_staff_id CONSTANT uuid := '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc';
  c_pv_id CONSTANT uuid := '75271c77-fc47-4ba7-b1fa-42cb4abd74ca';
  v_pv public.payment_vouchers%ROWTYPE;
  v_original public.journal_entries%ROWTYPE;
  v_reversal public.journal_entries%ROWTYPE;
  v_replacement public.journal_entries%ROWTYPE;
  v_count integer;
BEGIN
  IF (SELECT count(*) FROM public.finance_staff_master WHERE id=c_staff_id AND full_name='Sandi Prasetyo' AND status='active') <> 1 THEN
    RAISE EXCEPTION 'Precondition failed: Sandi active staff record not found uniquely';
  END IF;
  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id=c_pv_id FOR UPDATE;
  IF NOT FOUND OR v_pv.voucher_number <> 'PV/26-26/032' OR v_pv.amount <> 1000000
     OR v_pv.journal_entry_id IS DISTINCT FROM 'c79e3109-c72a-43af-91e0-86b6457f07cd'::uuid THEN
    RAISE EXCEPTION 'Precondition failed: PV/032 no longer matches verified production state';
  END IF;
  SELECT * INTO v_original FROM public.journal_entries WHERE entry_number='JE2611-0363' FOR UPDATE;
  SELECT * INTO v_reversal FROM public.journal_entries WHERE entry_number='JE2611-0457' FOR UPDATE;
  SELECT * INTO v_replacement FROM public.journal_entries WHERE entry_number='JE2611-0458' FOR UPDATE;
  IF v_original.id IS NULL OR v_original.reference_id IS DISTINCT FROM c_pv_id OR NOT v_original.is_reversed
     OR v_original.reversed_by_id IS DISTINCT FROM v_reversal.id OR v_original.total_debit<>1100000 OR v_original.total_credit<>1100000 THEN
    RAISE EXCEPTION 'Precondition failed: original JE2611-0363 state differs';
  END IF;
  IF v_reversal.id IS NULL OR v_reversal.reference_id IS DISTINCT FROM c_pv_id OR v_reversal.is_reversed
     OR v_reversal.total_debit<>1100000 OR v_reversal.total_credit<>1100000 THEN
    RAISE EXCEPTION 'Precondition failed: reversal JE2611-0457 state differs';
  END IF;
  IF v_replacement.id IS NULL OR v_replacement.id IS DISTINCT FROM v_pv.journal_entry_id OR v_replacement.reference_id IS DISTINCT FROM c_pv_id
     OR v_replacement.is_reversed OR v_replacement.total_debit<>1000000 OR v_replacement.total_credit<>1000000 THEN
    RAISE EXCEPTION 'Precondition failed: replacement JE2611-0458 state differs';
  END IF;
  IF (SELECT count(*) FROM public.journal_entry_lines WHERE journal_entry_id IN (v_original.id,v_reversal.id,v_replacement.id))<>6 THEN
    RAISE EXCEPTION 'Precondition failed: expected exactly six journal lines';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE id='23bb0e14-3bb9-4cdf-8205-0f654f7ec1c6' AND journal_entry_id=v_original.id AND credit=1100000 AND debit=0 AND staff_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE id='8b322154-a93c-4fb9-9a24-71b52ca94cc2' AND journal_entry_id=v_reversal.id AND debit=1100000 AND credit=0 AND staff_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE id='71a8365d-081d-4d9e-aee9-4a9fe51914bc' AND journal_entry_id=v_reversal.id AND credit=1100000 AND debit=0 AND staff_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE id='7ee6261a-d578-4690-851b-d16d5fca6192' AND journal_entry_id=v_replacement.id AND debit=1000000 AND credit=0 AND staff_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE id='768b5853-0475-4a91-b629-5b94a75c4642' AND journal_entry_id=v_replacement.id AND credit=1000000 AND debit=0 AND staff_id IS NULL) THEN
    RAISE EXCEPTION 'Precondition failed: target journal lines differ from inspected state';
  END IF;
  UPDATE public.journal_entry_lines SET staff_id=c_staff_id
  WHERE id IN ('23bb0e14-3bb9-4cdf-8205-0f654f7ec1c6','8b322154-a93c-4fb9-9a24-71b52ca94cc2','71a8365d-081d-4d9e-aee9-4a9fe51914bc','7ee6261a-d578-4690-851b-d16d5fca6192','768b5853-0475-4a91-b629-5b94a75c4642')
    AND staff_id IS NULL;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>5 THEN RAISE EXCEPTION 'Expected five staff_id updates; got %',v_count; END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id IN (v_original.id,v_reversal.id,v_replacement.id) AND staff_id IS DISTINCT FROM c_staff_id) THEN
    RAISE EXCEPTION 'Postcondition failed: Sandi journal line staff_id mismatch';
  END IF;
END $$;
COMMIT;
