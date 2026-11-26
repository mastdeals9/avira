-- Reconstructed from production migration 20261126091808 (already applied in production)
-- Guarded idempotently against duplicate posting if re-evaluated.

BEGIN;

DO $$
DECLARE
  v_rec record;
  v_je_id uuid;
  v_ar_acc uuid;
  v_meterai_acc uuid;
BEGIN
  SELECT id INTO v_ar_acc FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true LIMIT 1;
  SELECT id INTO v_meterai_acc FROM public.chart_of_accounts WHERE code = '6950' AND is_active = true LIMIT 1;

  FOR v_rec IN
    SELECT si.id, si.invoice_number, si.customer_id, si.created_by
    FROM public.sales_invoices si
    WHERE si.invoice_number IN (
      'SAPJ-26-031', 'SAPJ-26-037', 'SAPJ-26-038', 'SAPJ-26-039',
      'SAPJ-26-041', 'SAPJ-26-042', 'SAPJ-26-043', 'SAPJ-26-044',
      'SAPJ-26-045', 'SAPJ-26-051', 'SAPJ-26-053'
    )
    ORDER BY si.invoice_number
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.journal_entries
      WHERE source_module = 'sales_invoice_ar_meterai_correction'
        AND reference_number = 'AR-METERAI-CORR-' || v_rec.invoice_number
        AND is_posted = true
        AND NOT COALESCE(is_reversed, false)
        AND NOT COALESCE(is_cancelled, false)
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by
    ) VALUES (
      public.next_journal_entry_number(), '2026-11-26', 'sales_invoice_ar_meterai_correction',
      v_rec.id, 'AR-METERAI-CORR-' || v_rec.invoice_number,
      'Correct unbilled and uncollected Rp10,000 Bea Meterai on ' || v_rec.invoice_number,
      10000.00, 10000.00, true, v_rec.created_by, v_rec.created_by
    ) RETURNING id INTO v_je_id;

    INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES
      (v_je_id, 1, v_meterai_acc, 'Bea Meterai expense recovery reversal - ' || v_rec.invoice_number, 10000.00, 0, v_rec.customer_id),
      (v_je_id, 2, v_ar_acc, 'A/R Bea Meterai correction - ' || v_rec.invoice_number, 0, 10000.00, v_rec.customer_id);
  END LOOP;
END;
$$;

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261126091808', 'final_unbilled_meterai_ar_correction')
ON CONFLICT (version) DO NOTHING;

COMMIT;
