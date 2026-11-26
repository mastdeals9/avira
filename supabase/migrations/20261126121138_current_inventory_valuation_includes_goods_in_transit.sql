-- Reconstructed from production migration 20261126121138 (already applied in production)

BEGIN;

CREATE OR REPLACE VIEW public.inventory_gl_valuation_reconciliation AS
WITH gl AS (
  SELECT COALESCE(sum(jel.debit - jel.credit), 0::numeric) AS inventory_gl
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code::text = '1130'::text
    AND je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND NOT COALESCE(je.is_cancelled, false)
),
physical AS (
  SELECT
    COALESCE(sum(b.current_stock * COALESCE(b.landed_cost_per_unit, b.cost_per_unit, b.import_price, 0::numeric)), 0::numeric) AS physical_batch_valuation,
    COALESCE(sum(b.current_stock), 0::numeric) AS physical_stock_quantity
  FROM public.batches b
  WHERE COALESCE(b.is_active, true)
),
in_transit AS (
  SELECT
    COALESCE(sum(GREATEST(COALESCE(pii.quantity, 0::numeric) - COALESCE(receiving.received_quantity, 0::numeric), 0::numeric) * COALESCE(pii.line_total, 0::numeric) / NULLIF(pii.quantity, 0::numeric) * COALESCE(pi.exchange_rate, 1::numeric)), 0::numeric) AS in_transit_valuation,
    COALESCE(sum(GREATEST(COALESCE(pii.quantity, 0::numeric) - COALESCE(receiving.received_quantity, 0::numeric), 0::numeric)), 0::numeric) AS in_transit_quantity
  FROM public.purchase_invoices pi
  JOIN public.purchase_invoice_items pii ON pii.purchase_invoice_id = pi.id AND pii.item_type::text = 'inventory'::text
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(pira.received_quantity), 0::numeric) AS received_quantity
    FROM public.purchase_invoice_receiving_allocations pira
    WHERE pira.purchase_invoice_item_id = pii.id AND pira.status = 'received'::text
  ) receiving ON true
  WHERE (COALESCE(pi.status, ''::character varying)::text <> ALL (ARRAY['cancelled'::character varying, 'void'::character varying]::text[]))
    AND COALESCE(pii.quantity, 0::numeric) > COALESCE(receiving.received_quantity, 0::numeric)
)
SELECT
  gl.inventory_gl,
  physical.physical_batch_valuation + in_transit.in_transit_valuation AS batch_valuation,
  gl.inventory_gl - physical.physical_batch_valuation - in_transit.in_transit_valuation AS variance,
  physical.physical_batch_valuation,
  physical.physical_stock_quantity,
  in_transit.in_transit_valuation,
  in_transit.in_transit_quantity,
  physical.physical_batch_valuation + in_transit.in_transit_valuation AS total_supported_valuation
FROM gl
CROSS JOIN physical
CROSS JOIN in_transit;

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261126121138', 'current_inventory_valuation_includes_goods_in_transit')
ON CONFLICT (version) DO NOTHING;

COMMIT;
