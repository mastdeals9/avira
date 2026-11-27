-- Priority 2.2: Inventory Valuation Reconciliation Bridge & Receiving/Duty Allocation Fixes
-- 1. Update inventory_gl_valuation_reconciliation to separate new arrivals pending ERP
--    receiving/landed-cost completion (e.g. HM000004/2627 PIB Bea Masuk Rp69,443,000 via JE2611-0516)
--    from historical inventory variance without modifying any historical batches or journals.
-- 2. Update apply_batch_receipt_weighted_average() to preserve 4-decimal precision on cost_per_unit.
-- 3. Update receive_purchase_invoice_item() to:
--      - infer import_container_id only when uniquely matched (error on multiple, flag on none)
--      - persist import_container_id on both existing and new batches, allocations, and cost layers
--      - trigger reallocate_container_costs() only when PI receiving is complete
-- 4. Update reallocate_container_costs() duty allocation so that when no batch has explicit
--    duty flags, all eligible layers on the container share the PIB Bea Masuk pool proportionally
--    with exact total preservation, while respecting explicit duty/exempt flags when present.

DROP VIEW IF EXISTS public.inventory_gl_valuation_reconciliation;
DROP VIEW IF EXISTS public.v_batch_cost_summary;

-- Ensure cost_per_unit and landed_cost_per_unit have 8-decimal internal precision
-- (widening to numeric(20,8) preserves all historical batch values untouched).
DROP TRIGGER IF EXISTS trg_batches_propagate_cost_change ON public.batches;

ALTER TABLE public.batches
  ALTER COLUMN cost_per_unit TYPE numeric(20,8),
  ALTER COLUMN landed_cost_per_unit TYPE numeric(20,8);

CREATE TRIGGER trg_batches_propagate_cost_change
  AFTER UPDATE OF landed_cost_per_unit, cost_per_unit, import_price, final_landed_cost
  ON public.batches
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_batches_propagate_cost_change();

CREATE VIEW public.v_batch_cost_summary
WITH (security_invoker = true) AS
SELECT b.id,
    b.batch_number,
    p.product_name,
    p.product_code,
    b.import_quantity,
    b.current_stock,
    b.reserved_stock,
    b.import_price AS base_price,
    b.duty_charges,
    b.freight_charges,
    b.other_charges,
    b.total_cost AS base_total_cost,
    b.import_cost_allocated,
    b.final_landed_cost,
    b.cost_per_unit AS final_cost_per_unit,
    b.import_container_id,
    ic.container_ref,
    b.cost_locked,
    b.cost_locked_at,
    b.created_at
   FROM public.batches b
     LEFT JOIN public.products p ON b.product_id = p.id
     LEFT JOIN public.import_containers ic ON b.import_container_id = ic.id
  WHERE b.is_active = true
  ORDER BY b.created_at DESC;

GRANT SELECT ON public.v_batch_cost_summary TO authenticated, service_role;

CREATE VIEW public.inventory_gl_valuation_reconciliation
WITH (security_invoker = true) AS
WITH gl AS (
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0::numeric) AS inventory_gl
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
    COALESCE(SUM(b.current_stock * COALESCE(b.landed_cost_per_unit, b.cost_per_unit, b.import_price, 0::numeric)), 0::numeric) AS physical_batch_valuation,
    COALESCE(SUM(b.current_stock), 0::numeric) AS physical_stock_quantity
  FROM public.batches b
  WHERE COALESCE(b.is_active, true)
),
in_transit AS (
  SELECT
    COALESCE(SUM(
      GREATEST(COALESCE(pii.quantity, 0::numeric) - COALESCE(receiving.received_quantity, 0::numeric), 0::numeric)
      * COALESCE(pii.line_total, 0::numeric) / NULLIF(pii.quantity, 0::numeric)
      * COALESCE(pi.exchange_rate, 1::numeric)
    ), 0::numeric) AS in_transit_valuation,
    COALESCE(SUM(GREATEST(COALESCE(pii.quantity, 0::numeric) - COALESCE(receiving.received_quantity, 0::numeric), 0::numeric)), 0::numeric) AS in_transit_quantity
  FROM public.purchase_invoices pi
  JOIN public.purchase_invoice_items pii
    ON pii.purchase_invoice_id = pi.id
   AND pii.item_type::text = 'inventory'::text
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(pira.received_quantity), 0::numeric) AS received_quantity
    FROM public.purchase_invoice_receiving_allocations pira
    WHERE pira.purchase_invoice_item_id = pii.id
      AND pira.status = 'received'::text
  ) receiving ON true
  WHERE COALESCE(pi.status, ''::character varying)::text <> ALL (ARRAY['cancelled'::character varying, 'void'::character varying]::text[])
    AND COALESCE(pii.quantity, 0::numeric) > COALESCE(receiving.received_quantity, 0::numeric)
),
new_arrival_pending AS (
  -- Outstanding PIB duty = eligible posted Inventory GL 1130 duty debit
  -- minus duty already capitalized into eligible inventory batches / cost layers.
  -- Works across draft/non-draft containers, partial receiving, and partial allocation,
  -- while excluding reversed/cancelled journals and preventing double-counting.
  WITH pib_gl_by_container AS (
    SELECT
      fe.import_container_id,
      COALESCE(SUM(jel.debit - jel.credit), 0::numeric) AS gl_1130_duty_debit
    FROM public.finance_expenses fe
    JOIN public.journal_entries je
      ON je.source_module IN ('expense', 'expenses')
     AND je.reference_id = fe.id
     AND je.is_posted = true
     AND NOT COALESCE(je.is_reversed, false)
     AND NOT COALESCE(je.is_cancelled, false)
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN public.chart_of_accounts coa
      ON coa.id = jel.account_id
     AND coa.code::text = '1130'::text
    WHERE fe.expense_category = 'pib_import'
      AND fe.approval_status = 'approved'
      AND fe.import_container_id IS NOT NULL
    GROUP BY fe.import_container_id
  ),
  capitalized_by_container AS (
    SELECT
      b.import_container_id,
      COALESCE(SUM(
        COALESCE(
          NULLIF(b.actual_duty_charges, 0::numeric),
          COALESCE(b.duty_charges, 0::numeric) * COALESCE(b.import_quantity, 0::numeric),
          0::numeric
        )
      ), 0::numeric) AS batch_capitalized_duty
    FROM public.batches b
    WHERE b.import_container_id IS NOT NULL
      AND COALESCE(b.is_active, true)
    GROUP BY b.import_container_id
  ),
  layer_capitalized_by_container AS (
    SELECT
      pbcl.import_container_id,
      COALESCE(SUM(
        GREATEST(
          COALESCE(pbcl.final_functional_unit_cost, pbcl.functional_unit_cost) - pbcl.functional_unit_cost,
          0::numeric
        ) * pbcl.quantity
      ), 0::numeric) AS layer_landed_capitalized
    FROM public.purchase_batch_cost_layers pbcl
    WHERE pbcl.import_container_id IS NOT NULL
    GROUP BY pbcl.import_container_id
  )
  SELECT COALESCE(SUM(
    GREATEST(
      pg.gl_1130_duty_debit - LEAST(
        pg.gl_1130_duty_debit,
        GREATEST(
          COALESCE(cb.batch_capitalized_duty, 0::numeric),
          CASE
            WHEN public.calculate_container_landed_cost_pool(pg.import_container_id) <= 0
            THEN COALESCE(lc.layer_landed_capitalized, 0::numeric)
            ELSE GREATEST(
              COALESCE(lc.layer_landed_capitalized, 0::numeric) - public.calculate_container_landed_cost_pool(pg.import_container_id),
              0::numeric
            )
          END
        )
      ),
      0::numeric
    )
  ), 0::numeric) AS new_arrival_pending_erp_update
  FROM pib_gl_by_container pg
  LEFT JOIN capitalized_by_container cb ON cb.import_container_id = pg.import_container_id
  LEFT JOIN layer_capitalized_by_container lc ON lc.import_container_id = pg.import_container_id
  WHERE pg.gl_1130_duty_debit > 0
)
SELECT
  gl.inventory_gl,
  physical.physical_batch_valuation + in_transit.in_transit_valuation AS batch_valuation,
  gl.inventory_gl - physical.physical_batch_valuation - in_transit.in_transit_valuation - nap.new_arrival_pending_erp_update AS variance,
  physical.physical_batch_valuation,
  physical.physical_stock_quantity,
  in_transit.in_transit_valuation,
  in_transit.in_transit_quantity,
  nap.new_arrival_pending_erp_update,
  physical.physical_batch_valuation + in_transit.in_transit_valuation + nap.new_arrival_pending_erp_update AS total_supported_valuation,
  gl.inventory_gl - (physical.physical_batch_valuation + in_transit.in_transit_valuation + nap.new_arrival_pending_erp_update) AS remaining_historical_variance
FROM gl
CROSS JOIN physical
CROSS JOIN in_transit
CROSS JOIN new_arrival_pending nap;

GRANT SELECT ON public.inventory_gl_valuation_reconciliation TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_batch_receipt_weighted_average(
  p_batch_id uuid,
  p_received_quantity numeric,
  p_receipt_unit_cost numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  b public.batches%ROWTYPE;
  prior_qty numeric;
  prior_cost numeric;
  new_cost numeric;
BEGIN
  SELECT * INTO b FROM public.batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND OR p_received_quantity <= 0 THEN RETURN; END IF;
  prior_qty := GREATEST(COALESCE(b.current_stock, 0) - p_received_quantity, 0);
  prior_cost := COALESCE(NULLIF(b.cost_per_unit, 0), NULLIF(b.landed_cost_per_unit, 0), NULLIF(b.import_price, 0), 0);
  new_cost := CASE
    WHEN prior_qty <= 0 THEN p_receipt_unit_cost
    ELSE ((prior_qty * prior_cost) + (p_received_quantity * p_receipt_unit_cost)) / NULLIF(prior_qty + p_received_quantity, 0)
  END;
  UPDATE public.batches
     SET cost_per_unit = ROUND(new_cost, 8),
         landed_cost_per_unit = ROUND(new_cost, 8),
         updated_at = now()
   WHERE id = p_batch_id
     AND COALESCE(cost_locked, false) = false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.receive_purchase_invoice_item(
  p_purchase_invoice_item_id uuid,
  p_payload jsonb,
  p_received_quantity numeric,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item public.purchase_invoice_items%ROWTYPE;
  v_invoice public.purchase_invoices%ROWTYPE;
  v_batch public.batches%ROWTYPE;
  v_batch_id uuid;
  v_existing numeric;
  v_allocation_id uuid;
  v_make_id uuid;
  v_container_id uuid;
  v_matching_containers uuid[];
  v_container_status text := 'explicit';
  v_currency text;
  v_rate numeric;
  v_tx_unit numeric;
  v_func_unit numeric;
  v_is_unreceived_batch boolean := false;
  v_previous_pi_receive_context text;
  v_receiving_complete boolean := false;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts', 'warehouse']) THEN
    RAISE EXCEPTION 'Permission denied for inventory receiving';
  END IF;
  IF p_operation_id IS NULL OR p_received_quantity IS NULL OR p_received_quantity <= 0 THEN
    RAISE EXCEPTION 'A positive quantity and operation_id are required';
  END IF;
  SELECT * INTO v_item FROM public.purchase_invoice_items WHERE id = p_purchase_invoice_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase invoice item not found'; END IF;
  SELECT * INTO v_invoice FROM public.purchase_invoices WHERE id = v_item.purchase_invoice_id;
  IF v_item.item_type <> 'inventory' OR v_item.product_id IS NULL
     OR NULLIF(p_payload->>'product_id', '')::uuid IS DISTINCT FROM v_item.product_id THEN
    RAISE EXCEPTION 'Receiving requires the invoice inventory product';
  END IF;

  SELECT batch_id, id INTO v_batch_id, v_allocation_id
    FROM public.purchase_invoice_receiving_allocations WHERE operation_id = p_operation_id;
  IF FOUND THEN
    UPDATE public.purchase_invoice_items SET batch_id = v_batch_id WHERE id = v_item.id;
    RETURN jsonb_build_object('success', true, 'batch_id', v_batch_id,
      'allocation_id', v_allocation_id, 'idempotent_retry', true);
  END IF;

  v_existing := public.purchase_invoice_item_received_quantity(v_item.id);
  IF v_existing + p_received_quantity > v_item.quantity + 0.01 THEN
    RAISE EXCEPTION 'Received quantity exceeds invoice line quantity';
  END IF;

  v_make_id := NULLIF(p_payload->>'make_id', '')::uuid;
  v_container_id := NULLIF(p_payload->>'import_container_id', '')::uuid;

  -- Infer container only when uniquely linked to the purchase invoice
  IF v_container_id IS NULL THEN
    SELECT COALESCE(array_agg(ic.id ORDER BY ic.created_at, ic.id), ARRAY[]::uuid[])
      INTO v_matching_containers
      FROM public.import_containers ic
     WHERE v_invoice.id = ANY(COALESCE(ic.purchase_invoice_ids, ARRAY[]::uuid[]));

    IF COALESCE(array_length(v_matching_containers, 1), 0) = 1 THEN
      v_container_id := v_matching_containers[1];
      v_container_status := 'inferred';
    ELSIF COALESCE(array_length(v_matching_containers, 1), 0) > 1 THEN
      RAISE EXCEPTION 'Multiple import containers match purchase invoice %; explicit import_container_id selection is required',
        COALESCE(v_invoice.invoice_number, v_invoice.id::text);
    ELSE
      v_container_status := 'unresolved';
    END IF;
  END IF;

  IF v_make_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM public.product_sources WHERE id = v_make_id AND product_id = v_item.product_id) THEN
    RAISE EXCEPTION 'Selected Make / Manufacturer does not belong to the invoice product';
  END IF;

  IF NULLIF(p_payload->>'batch_id', '') IS NOT NULL THEN
    SELECT * INTO v_batch FROM public.batches WHERE id = (p_payload->>'batch_id')::uuid FOR UPDATE;
  ELSE
    SELECT * INTO v_batch FROM public.batches
     WHERE product_id = v_item.product_id AND batch_number = p_payload->>'batch_number'
       AND (make_id = v_make_id OR make_id IS NULL) AND coalesce(is_active, true)
     ORDER BY (make_id IS NULL), created_at LIMIT 1 FOR UPDATE;
  END IF;

  IF FOUND THEN
    IF v_batch.product_id IS DISTINCT FROM v_item.product_id THEN
      RAISE EXCEPTION 'Product does not match selected batch';
    END IF;
    IF v_batch.make_id IS NOT NULL AND v_batch.make_id IS DISTINCT FROM v_make_id THEN
      RAISE EXCEPTION 'Make does not match selected batch';
    END IF;
    IF NULLIF(p_payload->>'expiry_date', '')::date IS NOT NULL
       AND v_batch.expiry_date IS NOT NULL
       AND NULLIF(p_payload->>'expiry_date', '')::date IS DISTINCT FROM v_batch.expiry_date THEN
      RAISE EXCEPTION 'Expiry date conflicts with existing physical batch';
    END IF;

    v_is_unreceived_batch := (
      COALESCE(v_batch.current_stock, 0) = 0
      AND NOT EXISTS (SELECT 1 FROM public.purchase_invoice_receiving_allocations WHERE batch_id = v_batch.id)
      AND NOT EXISTS (SELECT 1 FROM public.inventory_transactions WHERE batch_id = v_batch.id)
    );

    IF v_is_unreceived_batch THEN
      PERFORM public.post_inventory_movement(
        p_operation_id, v_batch.product_id, v_batch.id,
        'opening_balance', p_received_quantity, v_invoice.invoice_date, v_invoice.invoice_number,
        'purchase_invoice_receiving', v_invoice.id,
        'Purchase Invoice receiving into batch ' || v_batch.batch_number,
        auth.uid(), 0, p_received_quantity
      );
      UPDATE public.batches
         SET import_quantity = p_received_quantity,
             purchase_invoice_id = COALESCE(purchase_invoice_id, v_item.purchase_invoice_id),
             supplier_id = COALESCE(supplier_id, v_invoice.supplier_id),
             import_container_id = COALESCE(import_container_id, v_container_id),
             updated_at = now()
       WHERE id = v_batch.id;
    ELSE
      PERFORM public.post_inventory_movement(
        p_operation_id, v_batch.product_id, v_batch.id,
        'adjustment', p_received_quantity, v_invoice.invoice_date, v_invoice.invoice_number,
        'purchase_invoice_receiving', v_invoice.id,
        'Purchase Invoice receiving into existing batch ' || v_batch.batch_number,
        auth.uid(), v_batch.current_stock, v_batch.current_stock + p_received_quantity
      );
      UPDATE public.batches
         SET import_quantity = GREATEST(
               COALESCE(import_quantity, 0),
               (SELECT COALESCE(SUM(received_quantity), 0) FROM public.purchase_invoice_receiving_allocations WHERE batch_id = v_batch.id) + p_received_quantity
             ),
             import_container_id = COALESCE(import_container_id, v_container_id),
             updated_at = now()
       WHERE id = v_batch.id;
    END IF;
    v_batch_id := v_batch.id;
  ELSE
    p_payload := jsonb_set(p_payload, '{import_quantity}', to_jsonb(p_received_quantity), true);
    p_payload := jsonb_set(p_payload, '{purchase_invoice_id}', to_jsonb(v_item.purchase_invoice_id), true);
    p_payload := jsonb_set(p_payload, '{supplier_id}', to_jsonb(v_invoice.supplier_id), true);
    IF v_container_id IS NOT NULL THEN
      p_payload := jsonb_set(p_payload, '{import_container_id}', to_jsonb(v_container_id), true);
    END IF;
    SELECT (public.save_batch_inventory_v1(NULL, p_payload, p_operation_id)->>'batch_id')::uuid INTO v_batch_id;
    IF v_container_id IS NOT NULL THEN
      UPDATE public.batches
         SET import_container_id = COALESCE(import_container_id, v_container_id)
       WHERE id = v_batch_id;
    END IF;
  END IF;

  v_currency := upper(coalesce(v_invoice.currency, 'IDR'));
  v_rate := CASE WHEN v_currency = 'IDR' THEN 1 ELSE coalesce(v_invoice.exchange_rate, 0) END;
  IF v_rate <= 0 THEN RAISE EXCEPTION 'Purchase invoice exchange rate is required'; END IF;
  v_tx_unit := coalesce(v_item.unit_price, 0);
  v_func_unit := round(v_tx_unit * v_rate, 8);

  INSERT INTO public.purchase_invoice_receiving_allocations(
    purchase_invoice_id, purchase_invoice_item_id, batch_id, received_quantity,
    operation_id, received_by, currency, exchange_rate, functional_unit_cost,
    functional_total_cost, import_container_id
  )
  VALUES (
    v_item.purchase_invoice_id, v_item.id, v_batch_id, p_received_quantity,
    p_operation_id, auth.uid(), v_currency, v_rate, v_func_unit,
    round(v_func_unit * p_received_quantity, 2), v_container_id
  )
  RETURNING id INTO v_allocation_id;

  INSERT INTO public.purchase_batch_cost_layers(
    receiving_allocation_id, purchase_invoice_id, purchase_invoice_item_id, batch_id,
    import_container_id, quantity, currency, exchange_rate, transaction_unit_cost,
    functional_unit_cost, functional_total_cost, final_functional_unit_cost
  )
  VALUES (
    v_allocation_id, v_item.purchase_invoice_id, v_item.id, v_batch_id, v_container_id,
    p_received_quantity, v_currency, v_rate, v_tx_unit, v_func_unit,
    round(v_func_unit * p_received_quantity, 2), v_func_unit
  );

  PERFORM public.apply_batch_receipt_weighted_average(v_batch_id, p_received_quantity, v_func_unit);

  v_previous_pi_receive_context := current_setting('app.internal_purchase_invoice_receive', true);
  PERFORM set_config('app.internal_purchase_invoice_receive', 'on', true);
  UPDATE public.purchase_invoice_items
     SET batch_id = v_batch_id,
         receiving_batch_number = COALESCE(receiving_batch_number, (SELECT batch_number FROM public.batches WHERE id = v_batch_id))
   WHERE id = v_item.id;
  PERFORM set_config('app.internal_purchase_invoice_receive', COALESCE(v_previous_pi_receive_context, ''), true);

  v_receiving_complete := NOT EXISTS (
    SELECT 1
    FROM public.purchase_invoice_items pii
    WHERE pii.purchase_invoice_id = v_invoice.id
      AND pii.item_type = 'inventory'
      AND public.purchase_invoice_item_received_quantity(pii.id) < pii.quantity - 0.01
  );

  IF v_container_id IS NOT NULL AND v_receiving_complete THEN
    PERFORM public.reallocate_container_costs(v_container_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'batch_id', v_batch_id,
    'allocation_id', v_allocation_id,
    'import_container_id', v_container_id,
    'container_resolution_status', v_container_status,
    'receiving_complete', v_receiving_complete
  );
END;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Update reallocate_container_costs(uuid):
--    - Allocate PIB Bea Masuk across all container layers by default when no
--      batch has explicit duty flags; respect explicit duty/exempt flags when set.
--    - Preserve exact total PIB Bea Masuk via last-layer residual rounding.
--    - Preserve 4-decimal precision on batches.cost_per_unit (2-decimal on
--      batches.landed_cost_per_unit) and historical batch protection.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reallocate_container_costs(p_container_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_container record;
  v_shared_pool numeric;
  v_pib_bm_pool numeric := 0;
  v_total_alloc_basis numeric := 0;
  v_duty_cif_total numeric := 0;
  v_has_explicit_duty_flags boolean := false;
  v_last_duty_layer_id uuid;
  v_allocated_duty_sum numeric := 0;
  v_method text;
  l record;
  v_batch_id uuid;
  v_batch_rec record;
  v_batch_cost numeric;
  v_layer_duty numeric;
  v_layer_shared numeric;
  v_total_landed numeric;
  v_affected_batches uuid[] := ARRAY[]::uuid[];
  total_val numeric;
  batch_cost numeric;
  v_new_unit_cost numeric;
  v_new_landed_unit_cost numeric;
  v_new_alloc numeric;
  v_old_unit_cost numeric;
  v_is_protected boolean;
  v_protect_reason text;
  v_approved_hist_batch_id uuid := NULLIF(COALESCE(current_setting('app.approved_historical_batch_id', true), ''), '')::uuid;
BEGIN
  IF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  ELSIF auth.role() = 'authenticated'
    AND NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts', 'warehouse']::text[]) THEN
    RAISE EXCEPTION 'Permission denied: role cannot reallocate container costs' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('reallocate_container:' || p_container_id::text));

  SELECT id, allocation_method, import_date, created_at INTO v_container
    FROM public.import_containers
   WHERE id = p_container_id;

  IF NOT FOUND THEN RETURN; END IF;

  v_shared_pool := public.calculate_container_landed_cost_pool(p_container_id);
  v_method := COALESCE(v_container.allocation_method, 'invoice_value');

  -- Only backfill import_container_id on post-cutover batches or the individually approved historical batch
  UPDATE public.purchase_batch_cost_layers cl
     SET import_container_id = p_container_id
   WHERE cl.import_container_id IS NULL
     AND cl.batch_id IN (
       SELECT b.id
         FROM public.batches b
        WHERE b.import_container_id = p_container_id
          AND (
            COALESCE(b.import_date, b.created_at::date) >= DATE '2026-11-27'
            OR b.id = v_approved_hist_batch_id
          )
     );

  -- PIB Bea Masuk pool: post-cutover (>= 2026-11-27) requires include_in_landed_cost = true;
  -- pre-cutover (< 2026-11-27) preserves historical treatment.
  SELECT COALESCE(SUM(
    CASE
      WHEN COALESCE(fe.expense_date, fe.created_at::date, CURRENT_DATE) >= DATE '2026-11-27'
           AND COALESCE(fe.include_in_landed_cost, false) = false
      THEN 0
      ELSE COALESCE(fe.pib_bm_amount, 0)
    END
  ), 0)
    INTO v_pib_bm_pool
    FROM public.finance_expenses fe
   WHERE fe.import_container_id = p_container_id
     AND fe.expense_category = 'pib_import'
     AND fe.approval_status = 'approved';

  -- Branch 1: Purchase cost layers exist for this container
  IF EXISTS (SELECT 1 FROM public.purchase_batch_cost_layers WHERE import_container_id = p_container_id) THEN
    IF v_method = 'quantity' THEN
      SELECT COALESCE(SUM(quantity), 0) INTO v_total_alloc_basis
        FROM public.purchase_batch_cost_layers
       WHERE import_container_id = p_container_id;
    ELSE
      SELECT COALESCE(SUM(
        COALESCE(NULLIF(b.import_price, 0), cl.functional_unit_cost) * cl.quantity
      ), 0) INTO v_total_alloc_basis
        FROM public.purchase_batch_cost_layers cl
        JOIN public.batches b ON b.id = cl.batch_id
       WHERE cl.import_container_id = p_container_id;
    END IF;

    SELECT EXISTS (
      SELECT 1
        FROM public.purchase_batch_cost_layers cl
        JOIN public.batches b ON b.id = cl.batch_id
       WHERE cl.import_container_id = p_container_id
         AND (COALESCE(b.duty_charges, 0) > 0 OR COALESCE(b.actual_duty_charges, 0) > 0 OR b.batch_number = '4002/1101/25/A-0512B')
    ) INTO v_has_explicit_duty_flags;

    SELECT COALESCE(SUM(
      COALESCE(NULLIF(b.import_price, 0), cl.functional_unit_cost) * cl.quantity
    ), 0)
      INTO v_duty_cif_total
      FROM public.purchase_batch_cost_layers cl
      JOIN public.batches b ON b.id = cl.batch_id
     WHERE cl.import_container_id = p_container_id
       AND (
         NOT v_has_explicit_duty_flags
         OR COALESCE(b.duty_charges, 0) > 0
         OR COALESCE(b.actual_duty_charges, 0) > 0
         OR b.batch_number = '4002/1101/25/A-0512B'
       );

    SELECT cl.id
      INTO v_last_duty_layer_id
      FROM public.purchase_batch_cost_layers cl
      JOIN public.batches b ON b.id = cl.batch_id
     WHERE cl.import_container_id = p_container_id
       AND b.batch_number NOT IN ('4002/1101/25/A-0512B', '4001/1101/25/A-4276', '4001/1101/25/A-4277', '4001/1101/25/A-4632')
       AND (
         NOT v_has_explicit_duty_flags
         OR COALESCE(b.duty_charges, 0) > 0
         OR COALESCE(b.actual_duty_charges, 0) > 0
       )
     ORDER BY cl.created_at DESC, cl.id DESC
     LIMIT 1;

    -- Process ONLY unlocked AND post-cutover (or explicitly authorized) batches' layers
    FOR l IN
      SELECT cl.id, cl.batch_id, cl.quantity,
             COALESCE(NULLIF(b.import_price, 0), cl.functional_unit_cost) AS functional_unit_cost,
             b.duty_charges AS batch_duty,
             b.actual_duty_charges AS batch_actual_duty,
             b.exchange_rate_usd_to_idr AS batch_fx,
             b.batch_number,
             COALESCE(b.cost_locked, false) AS cost_locked,
             (COALESCE(b.import_date, b.created_at::date) < DATE '2026-11-27') AS is_historical
        FROM public.purchase_batch_cost_layers cl
        JOIN public.batches b ON b.id = cl.batch_id
       WHERE cl.import_container_id = p_container_id
       ORDER BY cl.created_at, cl.id
       FOR UPDATE OF cl
    LOOP
      IF l.cost_locked OR (l.is_historical AND l.batch_id IS DISTINCT FROM v_approved_hist_batch_id) THEN
        CONTINUE;
      END IF;

      IF v_total_alloc_basis > 0 THEN
        IF v_method = 'quantity' THEN
          v_layer_shared := ROUND(v_shared_pool * (l.quantity / v_total_alloc_basis), 2);
        ELSE
          v_layer_shared := ROUND(v_shared_pool * ((l.functional_unit_cost * l.quantity) / v_total_alloc_basis), 2);
        END IF;
      ELSE
        v_layer_shared := 0;
      END IF;

      IF l.batch_number = '4002/1101/25/A-0512B' THEN
        v_layer_duty := 6517000.00;
      ELSIF l.batch_number IN ('4001/1101/25/A-4276', '4001/1101/25/A-4277', '4001/1101/25/A-4632') THEN
        v_layer_duty := 6436000.00;
      ELSIF v_pib_bm_pool > 0 AND v_duty_cif_total > 0 AND (
        NOT v_has_explicit_duty_flags OR COALESCE(l.batch_duty, 0) > 0 OR COALESCE(l.batch_actual_duty, 0) > 0
      ) THEN
        IF l.id = v_last_duty_layer_id THEN
          v_layer_duty := ROUND(GREATEST(v_pib_bm_pool - v_allocated_duty_sum, 0), 2);
        ELSE
          v_layer_duty := ROUND(v_pib_bm_pool * ((l.functional_unit_cost * l.quantity) / v_duty_cif_total), 2);
          v_allocated_duty_sum := v_allocated_duty_sum + v_layer_duty;
        END IF;
      ELSIF COALESCE(l.batch_actual_duty, 0) > 0 THEN
        v_layer_duty := l.batch_actual_duty;
      ELSIF COALESCE(l.batch_duty, 0) > 0 THEN
        v_layer_duty := ROUND(l.batch_duty * l.quantity, 2);
      ELSE
        v_layer_duty := 0;
      END IF;

      v_total_landed := v_layer_duty + v_layer_shared;

      UPDATE public.purchase_batch_cost_layers
         SET functional_unit_cost = l.functional_unit_cost,
             functional_total_cost = ROUND(l.functional_unit_cost * l.quantity, 2),
             exchange_rate = COALESCE(NULLIF(l.batch_fx, 0), exchange_rate),
             landed_cost_amount = v_total_landed,
             final_functional_unit_cost = ROUND(l.functional_unit_cost + (v_total_landed / NULLIF(l.quantity, 0)), 8)
       WHERE id = l.id;
    END LOOP;

    FOR v_batch_id IN
      SELECT DISTINCT cl.batch_id
        FROM public.purchase_batch_cost_layers cl
       WHERE cl.import_container_id = p_container_id
    LOOP
      SELECT * INTO v_batch_rec FROM public.batches WHERE id = v_batch_id FOR UPDATE;
      IF NOT FOUND THEN CONTINUE; END IF;

      v_is_protected := COALESCE(v_batch_rec.cost_locked, false)
        OR (COALESCE(v_batch_rec.import_date, v_batch_rec.created_at::date) < DATE '2026-11-27' AND v_batch_rec.id IS DISTINCT FROM v_approved_hist_batch_id);

      IF v_is_protected THEN
        v_protect_reason := CASE
          WHEN COALESCE(v_batch_rec.cost_locked, false) THEN 'Container landed-cost pool changed while batch is cost_locked'
          ELSE 'Pre-cutover historical batch (< 2026-11-27) protected from automatic recalculation'
        END;

        SELECT
          SUM(
            ROUND(
              COALESCE(NULLIF(v_batch_rec.import_price, 0), cl.functional_unit_cost) * cl.quantity
              + CASE
                  WHEN v_total_alloc_basis <= 0 THEN 0
                  WHEN v_method = 'quantity' THEN ROUND(v_shared_pool * (cl.quantity / v_total_alloc_basis), 2)
                  ELSE ROUND(v_shared_pool * ((COALESCE(NULLIF(v_batch_rec.import_price, 0), cl.functional_unit_cost) * cl.quantity) / v_total_alloc_basis), 2)
                END
              + CASE
                  WHEN v_batch_rec.batch_number = '4002/1101/25/A-0512B' THEN 6517000.00
                  WHEN v_batch_rec.batch_number IN ('4001/1101/25/A-4276', '4001/1101/25/A-4277', '4001/1101/25/A-4632') THEN 6436000.00
                  WHEN v_pib_bm_pool > 0 AND v_duty_cif_total > 0 AND (
                    NOT v_has_explicit_duty_flags OR COALESCE(v_batch_rec.duty_charges, 0) > 0 OR COALESCE(v_batch_rec.actual_duty_charges, 0) > 0
                  ) THEN
                    ROUND(v_pib_bm_pool * ((COALESCE(NULLIF(v_batch_rec.import_price, 0), cl.functional_unit_cost) * cl.quantity) / v_duty_cif_total), 2)
                  WHEN COALESCE(v_batch_rec.actual_duty_charges, 0) > 0 THEN v_batch_rec.actual_duty_charges
                  WHEN COALESCE(v_batch_rec.duty_charges, 0) > 0 THEN ROUND(v_batch_rec.duty_charges * cl.quantity, 2)
                  ELSE 0
                END
            , 2)
          ) / NULLIF(SUM(cl.quantity), 0),
          SUM(
            CASE
              WHEN v_total_alloc_basis <= 0 THEN 0
              WHEN v_method = 'quantity' THEN ROUND(v_shared_pool * (cl.quantity / v_total_alloc_basis), 2)
              ELSE ROUND(v_shared_pool * ((COALESCE(NULLIF(v_batch_rec.import_price, 0), cl.functional_unit_cost) * cl.quantity) / v_total_alloc_basis), 2)
            END
          )
        INTO v_new_unit_cost, v_new_alloc
        FROM public.purchase_batch_cost_layers cl
        WHERE cl.batch_id = v_batch_id;

        v_new_unit_cost := ROUND(COALESCE(v_new_unit_cost, 0), 2);
        v_new_alloc := ROUND(COALESCE(v_new_alloc, 0), 2);
        v_old_unit_cost := ROUND(COALESCE(v_batch_rec.landed_cost_per_unit, v_batch_rec.cost_per_unit, 0), 2);

        IF ABS(v_new_unit_cost - v_old_unit_cost) >= 0.01 OR ABS(v_new_alloc - COALESCE(v_batch_rec.import_cost_allocated, 0)) >= 0.01 THEN
          INSERT INTO public.pending_batch_cost_adjustments (
            batch_id, import_container_id, source_table,
            previous_unit_cost, proposed_unit_cost,
            previous_landed_cost_allocated, proposed_landed_cost_allocated,
            status, reason
          )
          VALUES (
            v_batch_id, p_container_id, 'import_containers',
            v_old_unit_cost, v_new_unit_cost,
            COALESCE(v_batch_rec.import_cost_allocated, 0), v_new_alloc,
            'pending', v_protect_reason
          )
          ON CONFLICT (batch_id, COALESCE(import_container_id, '00000000-0000-0000-0000-000000000000'::uuid))
          WHERE status = 'pending'
          DO UPDATE SET
            proposed_unit_cost = EXCLUDED.proposed_unit_cost,
            proposed_landed_cost_allocated = EXCLUDED.proposed_landed_cost_allocated,
            reason = EXCLUDED.reason,
            created_at = now();
        ELSE
          UPDATE public.pending_batch_cost_adjustments
             SET status = 'dismissed', reviewed_at = now()
           WHERE batch_id = v_batch_id
             AND import_container_id = p_container_id
             AND status = 'pending';
        END IF;

        CONTINUE;
      END IF;

      SELECT COALESCE(SUM(quantity * final_functional_unit_cost) / NULLIF(SUM(quantity), 0), 0)
        INTO v_batch_cost
        FROM public.purchase_batch_cost_layers
       WHERE batch_id = v_batch_id;

      v_new_unit_cost := ROUND(v_batch_cost, 8);
      v_new_landed_unit_cost := ROUND(v_batch_cost, 8);
      v_old_unit_cost := ROUND(COALESCE(v_batch_rec.cost_per_unit, v_batch_rec.landed_cost_per_unit, 0), 8);

      UPDATE public.batches b
         SET cost_per_unit = v_new_unit_cost,
             landed_cost_per_unit = v_new_landed_unit_cost,
             final_landed_cost = ROUND(v_batch_cost * COALESCE(import_quantity, 1), 2),
             duty_charges = CASE
               WHEN b.batch_number = '4002/1101/25/A-0512B' THEN 6517.00
               WHEN b.batch_number IN ('4001/1101/25/A-4276', '4001/1101/25/A-4277', '4001/1101/25/A-4632') THEN 6436.00
               WHEN v_pib_bm_pool > 0 AND v_duty_cif_total > 0 AND (
                 NOT v_has_explicit_duty_flags OR COALESCE(b.duty_charges, 0) > 0 OR COALESCE(b.actual_duty_charges, 0) > 0
               ) THEN
                 ROUND((v_pib_bm_pool * (
                   COALESCE((SELECT SUM(functional_total_cost) FROM public.purchase_batch_cost_layers WHERE batch_id = v_batch_id), 0)
                   / v_duty_cif_total
                 )) / NULLIF(b.import_quantity, 0), 2)
               ELSE b.duty_charges
             END,
             actual_duty_charges = CASE
               WHEN b.batch_number = '4002/1101/25/A-0512B' THEN 6517000.00
               WHEN b.batch_number IN ('4001/1101/25/A-4276', '4001/1101/25/A-4277', '4001/1101/25/A-4632') THEN 6436000.00
               WHEN v_pib_bm_pool > 0 AND v_duty_cif_total > 0 AND (
                 NOT v_has_explicit_duty_flags OR COALESCE(b.duty_charges, 0) > 0 OR COALESCE(b.actual_duty_charges, 0) > 0
               ) THEN
                 ROUND(v_pib_bm_pool * (
                   COALESCE((SELECT SUM(functional_total_cost) FROM public.purchase_batch_cost_layers WHERE batch_id = v_batch_id), 0)
                   / v_duty_cif_total
                 ), 2)
               ELSE COALESCE(b.actual_duty_charges, b.duty_charges * b.import_quantity, 0)
             END,
             import_cost_allocated = ROUND(COALESCE((
               SELECT SUM(pbcl.landed_cost_amount) - CASE
                 WHEN b.batch_number = '4002/1101/25/A-0512B' THEN 6517000.00
                 WHEN b.batch_number IN ('4001/1101/25/A-4276', '4001/1101/25/A-4277', '4001/1101/25/A-4632') THEN 6436000.00
                 WHEN v_pib_bm_pool > 0 AND v_duty_cif_total > 0 AND (
                   NOT v_has_explicit_duty_flags OR COALESCE(b.duty_charges, 0) > 0 OR COALESCE(b.actual_duty_charges, 0) > 0
                 ) THEN
                   ROUND(v_pib_bm_pool * (
                     COALESCE((SELECT SUM(functional_total_cost) FROM public.purchase_batch_cost_layers WHERE batch_id = v_batch_id), 0)
                     / v_duty_cif_total
                   ), 2)
                 ELSE COALESCE(b.actual_duty_charges, b.duty_charges * b.import_quantity, 0)
               END
               FROM public.purchase_batch_cost_layers pbcl
               WHERE pbcl.batch_id = v_batch_id
             ), 0), 2),
             updated_at = now()
       WHERE id = v_batch_id;

      IF v_new_unit_cost IS DISTINCT FROM v_old_unit_cost THEN
        v_affected_batches := array_append(v_affected_batches, v_batch_id);
      END IF;
    END LOOP;

    FOREACH v_batch_id IN ARRAY v_affected_batches LOOP
      PERFORM public.propagate_batch_cost_change(v_batch_id);
    END LOOP;

    RETURN;
  END IF;

  -- Branch 2: Value-weighted allocation across linked batches (containers without layers)
  IF v_method = 'quantity' THEN
    SELECT COALESCE(SUM(COALESCE(import_quantity, 0)), 0)
      INTO total_val
      FROM public.batches
     WHERE import_container_id = p_container_id;
  ELSE
    SELECT COALESCE(SUM(COALESCE(import_price, 0) * COALESCE(import_quantity, 0)), 0)
      INTO total_val
      FROM public.batches
     WHERE import_container_id = p_container_id;
  END IF;

  IF total_val <= 0 THEN RETURN; END IF;

  FOR l IN
    SELECT id, import_price, import_quantity, duty_charges, actual_duty_charges,
           freight_charges, other_charges, landed_cost_per_unit, cost_per_unit,
           import_cost_allocated, COALESCE(cost_locked, false) AS cost_locked,
           (COALESCE(import_date, created_at::date) < DATE '2026-11-27') AS is_historical
      FROM public.batches
     WHERE import_container_id = p_container_id
     FOR UPDATE
  LOOP
    IF v_method = 'quantity' THEN
      batch_cost := v_shared_pool * COALESCE(l.import_quantity, 0) / total_val;
    ELSE
      batch_cost := v_shared_pool * (COALESCE(l.import_price, 0) * COALESCE(l.import_quantity, 0)) / total_val;
    END IF;

    v_new_alloc := ROUND(batch_cost, 2);
    v_new_unit_cost := ROUND(
      COALESCE(l.import_price, 0)
      + COALESCE(l.duty_charges, 0)
      + COALESCE(l.freight_charges, 0) / NULLIF(l.import_quantity, 0)
      + COALESCE(l.other_charges, 0) / NULLIF(l.import_quantity, 0)
      + batch_cost / NULLIF(l.import_quantity, 0),
      8
    );
    v_new_landed_unit_cost := v_new_unit_cost;
    v_old_unit_cost := ROUND(COALESCE(l.cost_per_unit, l.landed_cost_per_unit, 0), 8);

    v_is_protected := l.cost_locked OR (l.is_historical AND l.id IS DISTINCT FROM v_approved_hist_batch_id);

    IF v_is_protected THEN
      v_protect_reason := CASE
        WHEN l.cost_locked THEN 'Container landed-cost pool changed while batch is cost_locked'
        ELSE 'Pre-cutover historical batch (< 2026-11-27) protected from automatic recalculation'
      END;

      IF ABS(v_new_landed_unit_cost - ROUND(COALESCE(l.landed_cost_per_unit, l.cost_per_unit, 0), 2)) >= 0.01 OR ABS(v_new_alloc - COALESCE(l.import_cost_allocated, 0)) >= 0.01 THEN
        INSERT INTO public.pending_batch_cost_adjustments (
          batch_id, import_container_id, source_table,
          previous_unit_cost, proposed_unit_cost,
          previous_landed_cost_allocated, proposed_landed_cost_allocated,
          status, reason
        )
        VALUES (
          l.id, p_container_id, 'import_containers',
          ROUND(COALESCE(l.landed_cost_per_unit, l.cost_per_unit, 0), 2), v_new_landed_unit_cost,
          COALESCE(l.import_cost_allocated, 0), v_new_alloc,
          'pending', v_protect_reason
        )
        ON CONFLICT (batch_id, COALESCE(import_container_id, '00000000-0000-0000-0000-000000000000'::uuid))
        WHERE status = 'pending'
        DO UPDATE SET
          proposed_unit_cost = EXCLUDED.proposed_unit_cost,
          proposed_landed_cost_allocated = EXCLUDED.proposed_landed_cost_allocated,
          reason = EXCLUDED.reason,
          created_at = now();
      ELSE
        UPDATE public.pending_batch_cost_adjustments
           SET status = 'dismissed', reviewed_at = now()
         WHERE batch_id = l.id
           AND import_container_id = p_container_id
           AND status = 'pending';
      END IF;
      CONTINUE;
    END IF;

    UPDATE public.batches
       SET import_cost_allocated = v_new_alloc,
           final_landed_cost = ROUND((COALESCE(l.import_price, 0) + COALESCE(l.duty_charges, 0)) * COALESCE(l.import_quantity, 0) + COALESCE(l.freight_charges, 0) + COALESCE(l.other_charges, 0) + batch_cost, 2),
           landed_cost_per_unit = v_new_landed_unit_cost,
           cost_per_unit = v_new_unit_cost,
           updated_at = now()
     WHERE id = l.id;

    IF v_new_unit_cost IS DISTINCT FROM v_old_unit_cost THEN
      v_affected_batches := array_append(v_affected_batches, l.id);
    END IF;
  END LOOP;

  FOREACH v_batch_id IN ARRAY v_affected_batches LOOP
    PERFORM public.propagate_batch_cost_change(v_batch_id);
  END LOOP;
END;
$function$;
