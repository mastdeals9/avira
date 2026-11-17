-- Preserve receiving approval during the explicit inward RPC, and stop
-- duplicate PO-line mapping from exceeding the selected PO line quantity.
-- Repair the specific PO-line relation and restore its still-valid approval.
-- No stock, accounting or journal quantities are changed.

BEGIN;

-- 1) Receiving approval should be reset for user edits to invoice lines,
--    not for the technical batch_id/batch_number write performed by the
--    explicit receive_purchase_invoice_item RPC.
CREATE OR REPLACE FUNCTION public.reset_receiving_approval_on_item_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_invoice_id uuid := COALESCE(NEW.purchase_invoice_id, OLD.purchase_invoice_id);
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('app.internal_purchase_invoice_receive', true) = 'on' THEN
    RETURN NEW;
  END IF;

  UPDATE public.purchase_invoices
     SET receiving_approval_status = 'pending_approval',
         receiving_rejection_reason = NULL,
         updated_at = now()
   WHERE id = v_invoice_id
     AND receiving_approval_status = 'approved';

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- 2) Scope the bypass tightly to the final item metadata update inside
--    receive_purchase_invoice_item. Restore the prior GUC immediately after.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  v_definition := pg_get_functiondef(
    'public.receive_purchase_invoice_item(uuid,jsonb,numeric,uuid)'::regprocedure
  );

  IF position('v_previous_pi_receive_context text' IN v_definition) = 0 THEN
    v_old := '  v_is_unreceived_batch boolean := false;';
    v_new := v_old || E'\n  v_previous_pi_receive_context text;';
    IF position(v_old IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Could not find receiving RPC declaration anchor';
    END IF;
    v_definition := replace(v_definition, v_old, v_new);
  END IF;

  v_old := E'  UPDATE public.purchase_invoice_items\n'
        || E'     SET batch_id = v_batch_id,\n'
        || E'         receiving_batch_number = COALESCE(receiving_batch_number, (SELECT batch_number FROM public.batches WHERE id = v_batch_id))\n'
        || E'   WHERE id = v_item.id;';

  v_new := E'  v_previous_pi_receive_context := current_setting(''app.internal_purchase_invoice_receive'', true);\n'
        || E'  PERFORM set_config(''app.internal_purchase_invoice_receive'', ''on'', true);\n'
        || v_old || E'\n'
        || E'  PERFORM set_config(''app.internal_purchase_invoice_receive'', COALESCE(v_previous_pi_receive_context, ''''), true);';

  IF position('PERFORM set_config(''app.internal_purchase_invoice_receive'', ''on'', true)' IN v_definition) = 0 THEN
    IF position(v_old IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Could not find receiving RPC item update anchor';
    END IF;
    v_definition := replace(v_definition, v_old, v_new);
  END IF;

  EXECUTE v_definition;
END;
$migration$;

-- 3) Protect PO -> PI mapping. If multiple PI lines point to the same PO line,
--    their combined quantity must not exceed that PO line's ordered quantity.
--    Legitimate split-by-batch lines are allowed when their sum fits the PO line.
DO $migration$
DECLARE
  v_definition text;
  v_old text := '  v_result := public.save_purchase_invoice(NULL, p_invoice_data, p_items);';
  v_new text;
BEGIN
  v_definition := pg_get_functiondef(
    'public.create_purchase_invoice_from_po(uuid,jsonb,jsonb)'::regprocedure
  );

  v_new := E'  IF EXISTS (\n'
        || E'    SELECT 1\n'
        || E'    FROM (\n'
        || E'      SELECT\n'
        || E'        (item->>''purchase_order_item_id'')::uuid AS po_item_id,\n'
        || E'        SUM(COALESCE(NULLIF(item->>''quantity'', '''')::numeric, 0)) AS invoice_quantity\n'
        || E'      FROM jsonb_array_elements(COALESCE(p_items, ''[]''::jsonb)) AS item\n'
        || E'      GROUP BY (item->>''purchase_order_item_id'')::uuid\n'
        || E'    ) mapped\n'
        || E'    JOIN public.purchase_order_items poi ON poi.id = mapped.po_item_id\n'
        || E'    WHERE mapped.invoice_quantity > COALESCE(poi.quantity, 0) + 0.01\n'
        || E'  ) THEN\n'
        || E'    RAISE EXCEPTION ''Combined Purchase Invoice quantity mapped to a Purchase Order line exceeds its ordered quantity. Check duplicate-product line mapping before saving.'';\n'
        || E'  END IF;\n\n'
        || v_old;

  IF position('Combined Purchase Invoice quantity mapped to a Purchase Order line exceeds its ordered quantity' IN v_definition) = 0 THEN
    IF position(v_old IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Could not find PO-to-PI save anchor';
    END IF;
    v_definition := replace(v_definition, v_old, v_new);
    EXECUTE v_definition;
  END IF;
END;
$migration$;

-- 4) Repair only the proven PO-item reference on invoice 4254414.
--    Batch MA2604120 is 300 kg and must link to the 300 kg PO line.
--    MA2604122 stays linked to the 25 kg PO line.
DO $repair$
DECLARE
  v_pi public.purchase_invoices%rowtype;
  v_300_item public.purchase_invoice_items%rowtype;
  v_25_item public.purchase_invoice_items%rowtype;
  v_po_300 public.purchase_order_items%rowtype;
  v_po_25 public.purchase_order_items%rowtype;
  v_allocation_count integer;
  v_received_at timestamptz;
  v_update_count integer;
BEGIN
  SELECT * INTO v_pi
    FROM public.purchase_invoices
   WHERE invoice_number = '4254414'
   FOR UPDATE;
  IF NOT FOUND
     OR v_pi.purchase_order_id <> '60af1017-5144-4abf-ae46-db8b17b3205a'
     OR v_pi.supplier_id <> '45b7cbe2-7dec-488e-96af-e162535752ff'
     OR v_pi.status <> 'unpaid'
     OR v_pi.receiving_approval_status <> 'pending_approval'
     OR v_pi.receiving_approved_at IS NULL
     OR v_pi.receiving_approved_by IS NULL
     OR v_pi.receiving_rejection_reason IS NOT NULL THEN
    RAISE EXCEPTION 'Purchase Invoice 4254414 no longer matches reviewed state; no repair made';
  END IF;

  SELECT * INTO v_300_item
    FROM public.purchase_invoice_items
   WHERE id = 'f0e85b10-2008-44cd-ad46-8305871083bc'
     AND purchase_invoice_id = v_pi.id
   FOR UPDATE;
  IF NOT FOUND
     OR v_300_item.quantity <> 300
     OR v_300_item.receiving_batch_number <> 'MA2604120'
     OR v_300_item.batch_id <> 'e97908c7-af36-4c53-a8a8-2a65a2a07826'
     OR v_300_item.purchase_order_item_id <> '98d99a8f-0115-4f45-aa23-3b03b606ace7' THEN
    RAISE EXCEPTION 'MA2604120 invoice line no longer matches reviewed state; no repair made';
  END IF;

  SELECT * INTO v_25_item
    FROM public.purchase_invoice_items
   WHERE id = '339dfc0f-36e9-4519-9d52-1396bb18d2d9'
     AND purchase_invoice_id = v_pi.id
   FOR UPDATE;
  IF NOT FOUND
     OR v_25_item.quantity <> 25
     OR v_25_item.receiving_batch_number <> 'MA2604122'
     OR v_25_item.batch_id <> 'bbabbce9-48cc-4333-8404-2bb90f29f7ec'
     OR v_25_item.purchase_order_item_id <> '98d99a8f-0115-4f45-aa23-3b03b606ace7' THEN
    RAISE EXCEPTION 'MA2604122 invoice line no longer matches reviewed state; no repair made';
  END IF;

  SELECT * INTO v_po_300
    FROM public.purchase_order_items
   WHERE id = '162dbeba-bea9-4230-8b68-83c1edec4bde'
     AND po_id = v_pi.purchase_order_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_po_300.quantity <> 300
     OR v_po_300.product_id <> v_300_item.product_id
     OR v_po_300.unit <> v_300_item.unit
     OR v_po_300.unit_price <> v_300_item.unit_price
     OR v_po_300.make_id <> v_300_item.receiving_make_id THEN
    RAISE EXCEPTION 'Correct 300 kg PO line does not match MA2604120; no repair made';
  END IF;

  SELECT * INTO v_po_25
    FROM public.purchase_order_items
   WHERE id = '98d99a8f-0115-4f45-aa23-3b03b606ace7'
     AND po_id = v_pi.purchase_order_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_po_25.quantity <> 25
     OR v_po_25.product_id <> v_25_item.product_id
     OR v_po_25.unit <> v_25_item.unit
     OR v_po_25.unit_price <> v_25_item.unit_price
     OR v_po_25.make_id <> v_25_item.receiving_make_id THEN
    RAISE EXCEPTION 'Correct 25 kg PO line does not match MA2604122; no repair made';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.purchase_invoice_items
     WHERE purchase_order_item_id = v_po_300.id
       AND id <> v_300_item.id
  ) THEN
    RAISE EXCEPTION '300 kg PO line is already linked to another invoice item; no repair made';
  END IF;

  SELECT count(*), max(received_at)
    INTO v_allocation_count, v_received_at
    FROM public.purchase_invoice_receiving_allocations
   WHERE purchase_invoice_id = v_pi.id
     AND purchase_invoice_item_id = v_300_item.id
     AND batch_id = v_300_item.batch_id
     AND status = 'received'
     AND received_quantity = 300;

  IF v_allocation_count <> 1 OR v_received_at IS NULL
     OR v_pi.updated_at IS DISTINCT FROM v_received_at THEN
    RAISE EXCEPTION 'The single 300 kg receipt does not align with the approval-reset timestamp; no approval restoration made';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.purchase_invoice_receiving_allocations
    WHERE purchase_invoice_id = v_pi.id
      AND purchase_invoice_item_id = v_25_item.id
  ) OR EXISTS (
    SELECT 1 FROM public.inventory_transactions
    WHERE reference_type = 'purchase_invoice_receiving'
      AND reference_id = v_pi.id
      AND batch_id = v_25_item.batch_id
  ) THEN
    RAISE EXCEPTION 'MA2604122 already has receipt history; no repair made';
  END IF;

  UPDATE public.purchase_invoice_items
     SET purchase_order_item_id = v_po_300.id
   WHERE id = v_300_item.id
     AND purchase_order_item_id = v_po_25.id;

  GET DIAGNOSTICS v_update_count = ROW_COUNT;
  IF v_update_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one PO-item reference correction; transaction aborted';
  END IF;

  -- The existing approval metadata remains valid. The only update since approval
  -- was the 300 kg receiving RPC (its updated_at exactly equals received_at).
  UPDATE public.purchase_invoices
     SET receiving_approval_status = 'approved',
         receiving_rejection_reason = NULL,
         updated_at = now()
   WHERE id = v_pi.id
     AND receiving_approval_status = 'pending_approval'
     AND receiving_approved_at IS NOT NULL
     AND receiving_approved_by IS NOT NULL;

  GET DIAGNOSTICS v_update_count = ROW_COUNT;
  IF v_update_count <> 1 THEN
    RAISE EXCEPTION 'Could not restore the previously approved receiving state; transaction aborted';
  END IF;
END;
$repair$;

COMMIT;
