CREATE OR REPLACE FUNCTION public.receive_purchase_invoice_item(p_purchase_invoice_item_id uuid, p_payload jsonb, p_received_quantity numeric, p_operation_id uuid)
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
  v_currency text;
  v_rate numeric;
  v_tx_unit numeric;
  v_func_unit numeric;
  v_is_unreceived_batch boolean := false;
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
    -- Ensure purchase_invoice_items.batch_id is set
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

    -- Check if this is a pre-created skeleton batch (current_stock = 0 and no transactions or allocations)
    v_is_unreceived_batch := (
      COALESCE(v_batch.current_stock, 0) = 0
      AND NOT EXISTS (SELECT 1 FROM public.purchase_invoice_receiving_allocations WHERE batch_id = v_batch.id)
      AND NOT EXISTS (SELECT 1 FROM public.inventory_transactions WHERE batch_id = v_batch.id)
    );

    IF v_is_unreceived_batch THEN
      -- Initial physical receipt into a pre-created batch:
      -- Post a 'purchase' movement from stock 0 -> p_received_quantity
      PERFORM public.post_inventory_movement(
        p_operation_id, v_batch.product_id, v_batch.id,
        'purchase', p_received_quantity, v_invoice.invoice_date, v_invoice.invoice_number,
        'purchase_invoice_receiving', v_invoice.id,
        'Purchase Invoice initial receiving into batch ' || v_batch.batch_number,
        auth.uid(), v_batch.current_stock, v_batch.current_stock + p_received_quantity
      );
      -- Update batch: set import_quantity = p_received_quantity (do not double add), plus any enriched fields
      UPDATE public.batches
         SET import_quantity = p_received_quantity,
             make_id = COALESCE(v_make_id, make_id),
             import_container_id = COALESCE(v_container_id, import_container_id),
             expiry_date = COALESCE(NULLIF(p_payload->>'expiry_date', '')::date, expiry_date),
             packaging_details = COALESCE(NULLIF(p_payload->>'packaging_details', ''), packaging_details),
             import_date = COALESCE(NULLIF(p_payload->>'import_date', '')::date, import_date, v_invoice.invoice_date),
             updated_at = now()
       WHERE id = v_batch.id;
    ELSE
      -- Existing batch receiving additional stock:
      PERFORM public.post_inventory_movement(
        p_operation_id, v_batch.product_id, v_batch.id,
        'adjustment', p_received_quantity, v_invoice.invoice_date, v_invoice.invoice_number,
        'purchase_invoice_receiving', v_invoice.id,
        'Purchase Invoice receiving into existing batch ' || v_batch.batch_number,
        auth.uid(), v_batch.current_stock, v_batch.current_stock + p_received_quantity
      );
      UPDATE public.batches
         SET import_quantity = import_quantity + p_received_quantity,
             updated_at = now()
       WHERE id = v_batch.id;
    END IF;
    v_batch_id := v_batch.id;
  ELSE
    p_payload := jsonb_set(p_payload, '{import_quantity}', to_jsonb(p_received_quantity), true);
    p_payload := jsonb_set(p_payload, '{purchase_invoice_id}', to_jsonb(v_item.purchase_invoice_id), true);
    p_payload := jsonb_set(p_payload, '{supplier_id}', to_jsonb(v_invoice.supplier_id), true);
    SELECT (public.save_batch_inventory_v1(NULL, p_payload, p_operation_id)->>'batch_id')::uuid INTO v_batch_id;
  END IF;

  v_currency := upper(coalesce(v_invoice.currency, 'IDR'));
  v_rate := CASE WHEN v_currency = 'IDR' THEN 1 ELSE coalesce(v_invoice.exchange_rate, 0) END;
  IF v_rate <= 0 THEN RAISE EXCEPTION 'Purchase invoice exchange rate is required'; END IF;
  v_tx_unit := coalesce(v_item.unit_price, 0);
  v_func_unit := round(v_tx_unit * v_rate, 2);
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

  -- Apply weighted average to ensure batches record has correct unit cost
  PERFORM public.apply_batch_receipt_weighted_average(v_batch_id, p_received_quantity, v_func_unit);

  -- Persist batch_id and receiving_batch_number back onto purchase_invoice_items
  UPDATE public.purchase_invoice_items
     SET batch_id = v_batch_id,
         receiving_batch_number = COALESCE(receiving_batch_number, (SELECT batch_number FROM public.batches WHERE id = v_batch_id))
   WHERE id = v_item.id;

  RETURN jsonb_build_object('success', true, 'batch_id', v_batch_id, 'allocation_id', v_allocation_id);
END;
$function$
