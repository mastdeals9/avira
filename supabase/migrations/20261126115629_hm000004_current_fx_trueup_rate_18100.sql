-- Reconstructed from production migration 20261126115629 (already applied in production)
-- Guarded idempotently against duplicate posting if re-evaluated.

BEGIN;

DO $$
DECLARE
  v_pi_id uuid;
  v_supplier_id uuid;
  v_created_by uuid;
  v_je_id uuid;
  v_inv_acc uuid;
  v_ap_acc uuid;
BEGIN
  SELECT id, supplier_id, created_by
    INTO v_pi_id, v_supplier_id, v_created_by
    FROM public.purchase_invoices
   WHERE invoice_number = 'HM000004/2627'
   LIMIT 1;

  IF v_pi_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.purchase_invoices
     SET exchange_rate = 18100.000000
   WHERE id = v_pi_id
     AND exchange_rate IS DISTINCT FROM 18100.000000;

  UPDATE public.batches b
     SET cost_per_unit = 81450.0000
    FROM public.purchase_invoice_items pii
   WHERE pii.purchase_invoice_id = v_pi_id
     AND pii.batch_id = b.id
     AND b.cost_per_unit IS DISTINCT FROM 81450.0000;

  IF EXISTS (
    SELECT 1 FROM public.journal_entries
    WHERE source_module = 'purchase_invoice_fx_correction'
      AND reference_number = 'HM000004/2627-FX-18100'
      AND is_posted = true
      AND NOT COALESCE(is_reversed, false)
      AND NOT COALESCE(is_cancelled, false)
  ) THEN
    RETURN;
  END IF;

  SELECT id INTO v_inv_acc FROM public.chart_of_accounts WHERE code = '1130' AND is_active = true LIMIT 1;
  SELECT id INTO v_ap_acc FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true LIMIT 1;

  INSERT INTO public.journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by, created_by
  ) VALUES (
    public.next_journal_entry_number(), '2026-11-26', 'purchase_invoice_fx_correction',
    v_pi_id, 'HM000004/2627-FX-18100',
    'Inventory FX true-up - HM000004/2627 (17,950 -> 18,100)',
    11475000.00, 11475000.00, true, v_created_by, v_created_by
  ) RETURNING id INTO v_je_id;

  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit, supplier_id
  ) VALUES
    (v_je_id, 1, v_inv_acc, 'Inventory FX true-up - HM000004/2627 (17,950 -> 18,100)', 11475000.00, 0, v_supplier_id),
    (v_je_id, 2, v_ap_acc, 'Supplier AP FX true-up - HM000004/2627 (17,950 -> 18,100)', 0, 11475000.00, v_supplier_id);
END;
$$;

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261126115629', 'hm000004_current_fx_trueup_rate_18100')
ON CONFLICT (version) DO NOTHING;

COMMIT;
