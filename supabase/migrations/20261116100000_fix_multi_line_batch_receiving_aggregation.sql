-- Migration: 20261116100000_fix_multi_line_batch_receiving_aggregation.sql
-- Description: Fix multi-line batch aggregation in save_purchase_invoice and harden receive_purchase_invoice_item
-- Author: Antigravity AI — SAPJ ERP
-- Date: 16 November 2026
--
-- STRICT PRESERVATION: Built directly from exact pg_get_functiondef production definitions.
-- Preserves all original function business logic, security definer settings, search_path,
-- triggers, journal entry postings, tax handling, and weighted-average calculations.

BEGIN;

-- 1. Hardened save_purchase_invoice with multi-line and cross-invoice batch aggregation
CREATE OR REPLACE FUNCTION public.save_purchase_invoice(p_invoice_id uuid, p_invoice_data jsonb, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  DECLARE
    v_invoice_id        UUID;
    v_je_id             UUID;
    v_je_number         TEXT;
    v_ap_account_id     UUID;
    v_ppn_account_id    UUID;
    v_bm_account_id     UUID;
    v_account_id        UUID;
    v_item              JSONB;
    v_line_number       INTEGER;
    v_invoice_date      DATE;
    v_invoice_number    TEXT;
    v_supplier_id       UUID;
    v_total_amount      NUMERIC(15,2);
    v_tax_amount        NUMERIC(15,2);
    v_stamp_duty_amount NUMERIC(15,2);
    v_created_by        UUID;
    v_item_type         TEXT;
    v_line_total        NUMERIC(15,2);
    v_item_id           UUID;
    v_po_id             UUID;
    v_currency          TEXT;
    v_rate              NUMERIC;

    -- Batch resolution variables
    v_product_id        UUID;
    v_make_id           UUID;
    v_batch_number      TEXT;
    v_container_id      UUID;
    v_expiry_date       DATE;
    v_quantity          NUMERIC;
    v_unit_price        NUMERIC;
    v_unit              TEXT;
    v_batch_id          UUID;
    v_resolved_batch_id UUID;
  BEGIN
    v_created_by        := auth.uid();
    v_invoice_date      := (p_invoice_data->>'invoice_date')::DATE;
    v_invoice_number    := p_invoice_data->>'invoice_number';
    v_total_amount      := (p_invoice_data->>'total_amount')::NUMERIC(15,2);
    v_tax_amount        := COALESCE((p_invoice_data->>'tax_amount')::NUMERIC(15,2), 0);
    v_stamp_duty_amount := COALESCE((p_invoice_data->>'stamp_duty_amount')::NUMERIC(15,2), 0);
    v_supplier_id       := (p_invoice_data->>'supplier_id')::UUID;
    v_po_id             := NULLIF(p_invoice_data->>'purchase_order_id', '')::UUID;
    v_currency := upper(coalesce(p_invoice_data->>'currency', 'IDR'));
    v_rate := CASE WHEN v_currency = 'IDR' THEN 1 ELSE NULLIF((p_invoice_data->>'exchange_rate')::NUMERIC, 0) END;
    IF v_currency <> 'IDR' AND (v_rate IS NULL OR v_rate <= 1) THEN
      RAISE EXCEPTION 'Purchase invoice % requires a valid exchange rate greater than 1', v_invoice_number;
    END IF;

    SELECT id INTO v_ap_account_id  FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
    SELECT id INTO v_ppn_account_id FROM chart_of_accounts WHERE code = '1150' LIMIT 1;
    SELECT id INTO v_bm_account_id  FROM chart_of_accounts WHERE code = '6950' LIMIT 1;

    IF v_ap_account_id IS NULL THEN
      RAISE EXCEPTION 'A/P account (code 2110) not found in chart of accounts';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('je_number_' || TO_CHAR(v_invoice_date, 'YYMM')));

    IF p_invoice_id IS NULL THEN
      -- ── CREATE path ──────────────────────────────────────────────────────────

      v_je_number := 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-' || LPAD((
        SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '(\d+)$') AS INTEGER)), 0) + 1
        FROM journal_entries
        WHERE entry_number LIKE 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-%'
      )::TEXT, 4, '0');

      INSERT INTO journal_entries (
        entry_number, entry_date, source_module, reference_id, reference_number,
        description, total_debit, total_credit, is_posted, posted_by, created_by
      ) VALUES (
        v_je_number, v_invoice_date, 'purchase_invoice', gen_random_uuid(), v_invoice_number,
        'Purchase Invoice: ' || v_invoice_number,
        0, v_total_amount * v_rate, TRUE, v_created_by, v_created_by
      ) RETURNING id INTO v_je_id;

      INSERT INTO purchase_invoices (
        invoice_number, supplier_id, invoice_date, due_date,
        currency, exchange_rate, subtotal, tax_amount, stamp_duty_amount, total_amount,
        paid_amount, status,
        faktur_pajak_number, notes, document_urls,
        requires_faktur_pajak, purchase_type,
        purchase_order_id,
        journal_entry_id, created_by
      ) VALUES (
        v_invoice_number,
        v_supplier_id,
        v_invoice_date,
        NULLIF(p_invoice_data->>'due_date', '')::DATE,
        COALESCE(p_invoice_data->>'currency', 'IDR'),
        COALESCE((p_invoice_data->>'exchange_rate')::NUMERIC, 1),
        COALESCE((p_invoice_data->>'subtotal')::NUMERIC, 0),
        v_tax_amount,
        v_stamp_duty_amount,
        v_total_amount,
        0,
        'unpaid',
        NULLIF(p_invoice_data->>'faktur_pajak_number', ''),
        NULLIF(p_invoice_data->>'notes', ''),
        CASE
          WHEN p_invoice_data -> 'document_urls' IS NOT NULL
            AND jsonb_array_length(p_invoice_data -> 'document_urls') > 0
          THEN ARRAY(SELECT jsonb_array_elements_text(p_invoice_data -> 'document_urls'))
          ELSE NULL
        END,
        COALESCE((p_invoice_data->>'requires_faktur_pajak')::BOOLEAN, FALSE),
        COALESCE(p_invoice_data->>'purchase_type', 'inventory'),
        v_po_id,
        v_je_id,
        v_created_by
      ) RETURNING id INTO v_invoice_id;

      UPDATE journal_entries SET reference_id = v_invoice_id WHERE id = v_je_id;

    ELSE
      -- ── EDIT path ──────────────────────────────────────────────────────────

      v_invoice_id := p_invoice_id;

      SELECT journal_entry_id INTO v_je_id
      FROM purchase_invoices WHERE id = v_invoice_id;

      UPDATE purchase_invoices SET
        invoice_number        = v_invoice_number,
        supplier_id           = v_supplier_id,
        invoice_date          = v_invoice_date,
        due_date              = NULLIF(p_invoice_data->>'due_date', '')::DATE,
        currency              = COALESCE(p_invoice_data->>'currency', 'IDR'),
        exchange_rate         = COALESCE((p_invoice_data->>'exchange_rate')::NUMERIC, 1),
        subtotal              = COALESCE((p_invoice_data->>'subtotal')::NUMERIC, 0),
        tax_amount            = v_tax_amount,
        stamp_duty_amount     = v_stamp_duty_amount,
        total_amount          = v_total_amount,
        faktur_pajak_number   = NULLIF(p_invoice_data->>'faktur_pajak_number', ''),
        notes                 = NULLIF(p_invoice_data->>'notes', ''),
        document_urls         = CASE
                                  WHEN p_invoice_data -> 'document_urls' IS NOT NULL
                                    AND jsonb_array_length(p_invoice_data -> 'document_urls') > 0
                                  THEN ARRAY(SELECT jsonb_array_elements_text(p_invoice_data -> 'document_urls'))
                                  ELSE NULL
                                END,
        requires_faktur_pajak = COALESCE((p_invoice_data->>'requires_faktur_pajak')::BOOLEAN, FALSE),
        purchase_type         = COALESCE(p_invoice_data->>'purchase_type', 'inventory'),
        purchase_order_id     = v_po_id,
        updated_at            = NOW()
      WHERE id = v_invoice_id;

      IF EXISTS (
        SELECT 1 FROM purchase_invoice_items i 
        WHERE i.purchase_invoice_id = v_invoice_id 
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) x 
            WHERE NULLIF(x->>'id','')::uuid = i.id
          ) 
          AND (
            EXISTS (SELECT 1 FROM purchase_invoice_receiving_allocations a WHERE a.purchase_invoice_item_id = i.id) 
            OR i.batch_id IS NOT NULL
          )
      ) THEN 
        RAISE EXCEPTION 'Cannot remove invoice line with receiving or inventory history'; 
      END IF;

      DELETE FROM purchase_invoice_items i 
      WHERE i.purchase_invoice_id = v_invoice_id 
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) x 
          WHERE NULLIF(x->>'id','')::uuid = i.id
        );

      IF v_je_id IS NOT NULL THEN
        DELETE FROM journal_entry_lines WHERE journal_entry_id = v_je_id;
        UPDATE journal_entries SET
          entry_date       = v_invoice_date,
          reference_number = v_invoice_number,
          description      = 'Purchase Invoice: ' || v_invoice_number,
          total_debit      = 0,
          total_credit     = v_total_amount * v_rate
        WHERE id = v_je_id;
      ELSE
        v_je_number := 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-' || LPAD((
          SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '(\d+)$') AS INTEGER)), 0) + 1
          FROM journal_entries
          WHERE entry_number LIKE 'JE-' || TO_CHAR(v_invoice_date, 'YYMM') || '-%'
        )::TEXT, 4, '0');

        INSERT INTO journal_entries (
          entry_number, entry_date, source_module, reference_id, reference_number,
          description, total_debit, total_credit, is_posted, posted_by, created_by
        ) VALUES (
          v_je_number, v_invoice_date, 'purchase_invoice', v_invoice_id, v_invoice_number,
          'Purchase Invoice: ' || v_invoice_number,
          0, v_total_amount * v_rate, TRUE, v_created_by, v_created_by
        ) RETURNING id INTO v_je_id;

        UPDATE purchase_invoices SET journal_entry_id = v_je_id WHERE id = v_invoice_id;
      END IF;
    END IF;

    -- ── Insert/Update items and build JE debit lines ───────────────────────────
    v_line_number := 1;

    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
    LOOP
      v_item_type    := v_item->>'item_type';
      v_line_total   := COALESCE((v_item->>'line_total')::NUMERIC(15,2), 0);
      v_item_id      := NULLIF(v_item->>'id', '')::UUID;
      v_product_id   := NULLIF(v_item->>'product_id', '')::UUID;
      v_make_id      := NULLIF(v_item->>'receiving_make_id', '')::UUID;
      v_batch_number := NULLIF(TRIM(v_item->>'receiving_batch_number'), '');
      v_container_id := NULLIF(v_item->>'receiving_import_container_id', '')::UUID;
      v_expiry_date  := NULLIF(v_item->>'receiving_expiry_date', '')::DATE;
      v_quantity     := COALESCE((v_item->>'quantity')::NUMERIC, 1);
      v_unit_price   := COALESCE((v_item->>'unit_price')::NUMERIC, 0);
      v_unit         := v_item->>'unit';
      v_batch_id     := NULLIF(v_item->>'batch_id', '')::UUID;
      v_resolved_batch_id := NULL;

      -- ── Resolve or create batch if item has a Batch Number ────────────────
      IF v_item_type = 'inventory' AND v_product_id IS NOT NULL AND v_batch_number IS NOT NULL THEN
        -- 1. Check if provided batch_id matches the product and batch_number
        IF v_batch_id IS NOT NULL THEN
          SELECT id INTO v_resolved_batch_id
            FROM public.batches
           WHERE id = v_batch_id
             AND product_id = v_product_id
             AND (v_batch_number IS NULL OR batch_number = v_batch_number)
             AND coalesce(is_active, true);
        END IF;

        -- 2. Resolve existing batch by product_id and batch_number (preferring matching make_id)
        IF v_resolved_batch_id IS NULL THEN
          SELECT id INTO v_resolved_batch_id
            FROM public.batches
           WHERE product_id = v_product_id
             AND batch_number = v_batch_number
             AND (make_id = v_make_id OR v_make_id IS NULL OR make_id IS NULL)
             AND coalesce(is_active, true)
           ORDER BY (make_id = v_make_id) DESC, created_at DESC
           LIMIT 1;
        END IF;

        IF v_resolved_batch_id IS NULL THEN
          SELECT id INTO v_resolved_batch_id
            FROM public.batches
           WHERE product_id = v_product_id
             AND batch_number = v_batch_number
             AND coalesce(is_active, true)
           ORDER BY created_at DESC
           LIMIT 1;
        END IF;

        -- 3. If batch does not exist, create it using the existing batch model
        IF v_resolved_batch_id IS NULL THEN
          PERFORM set_config('app.canonical_stock_engine', 'on', true);
          INSERT INTO public.batches (
            batch_number, product_id, make_id, import_container_id,
            import_date, import_quantity, current_stock,
            import_price, import_price_usd, exchange_rate_usd_to_idr,
            cost_per_unit, landed_cost_per_unit, final_landed_cost, import_price_per_unit,
            is_active, created_by, purchase_invoice_id, supplier_id, packaging_details, expiry_date
          ) VALUES (
            v_batch_number, v_product_id, v_make_id, v_container_id,
            v_invoice_date, v_quantity, 0,
            v_unit_price, CASE WHEN v_currency = 'USD' THEN v_unit_price ELSE NULL END,
            CASE WHEN v_currency = 'USD' THEN v_rate ELSE NULL END,
            v_unit_price * v_rate,
            CASE WHEN v_container_id IS NULL THEN v_unit_price * v_rate ELSE 0 END,
            CASE WHEN v_container_id IS NULL THEN v_unit_price * v_rate * v_quantity ELSE 0 END,
            v_unit_price * v_rate,
            true, v_created_by, v_invoice_id, v_supplier_id, v_unit, v_expiry_date
          ) RETURNING id INTO v_resolved_batch_id;
        END IF;
      END IF;

      IF v_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM purchase_invoice_items WHERE id = v_item_id AND purchase_invoice_id = v_invoice_id) THEN
        UPDATE purchase_invoice_items SET 
          item_type                     = v_item_type, 
          product_id                    = v_product_id, 
          batch_id                      = v_resolved_batch_id,
          description                   = v_item->>'description', 
          quantity                      = v_quantity, 
          unit                          = v_unit, 
          unit_price                    = v_unit_price, 
          discount_percent              = (v_item->>'discount_percent')::NUMERIC, 
          line_total                    = v_line_total, 
          tax_amount                    = (v_item->>'tax_amount')::NUMERIC, 
          expense_account_id            = NULLIF(v_item->>'expense_account_id','')::UUID, 
          asset_account_id              = NULLIF(v_item->>'asset_account_id','')::UUID, 
          purchase_order_item_id        = NULLIF(v_item->>'purchase_order_item_id','')::UUID, 
          receiving_make_id             = v_make_id, 
          receiving_batch_number        = v_batch_number, 
          receiving_expiry_date         = v_expiry_date, 
          receiving_import_container_id = v_container_id, 
          receiving_notes               = NULLIF(v_item->>'receiving_notes','') 
        WHERE id = v_item_id;
      ELSE
        INSERT INTO purchase_invoice_items (
          purchase_invoice_id, item_type, product_id, batch_id, description,
          quantity, unit, unit_price, discount_percent, line_total,
          tax_amount, expense_account_id, asset_account_id,
          purchase_order_item_id, receiving_make_id, receiving_batch_number,
          receiving_expiry_date, receiving_import_container_id, receiving_notes
        ) VALUES (
          v_invoice_id,
          v_item_type,
          v_product_id,
          v_resolved_batch_id,
          v_item->>'description',
          v_quantity,
          v_unit,
          v_unit_price,
          (v_item->>'discount_percent')::NUMERIC,
          v_line_total,
          (v_item->>'tax_amount')::NUMERIC,
          NULLIF(v_item->>'expense_account_id', '')::UUID,
          NULLIF(v_item->>'asset_account_id',   '')::UUID,
          NULLIF(v_item->>'purchase_order_item_id', '')::UUID,
          v_make_id,
          v_batch_number,
          v_expiry_date,
          v_container_id,
          NULLIF(v_item->>'receiving_notes', '')
        );
      END IF;

      IF v_item_type = 'inventory' THEN
        SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
      ELSIF v_item_type = 'fixed_asset' THEN
        v_account_id := NULLIF(v_item->>'asset_account_id', '')::UUID;
        IF v_account_id IS NULL THEN
          SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '1200' LIMIT 1;
        END IF;
      ELSE
        v_account_id := NULLIF(v_item->>'expense_account_id', '')::UUID;
        IF v_account_id IS NULL THEN
          SELECT id INTO v_account_id FROM chart_of_accounts WHERE code = '5100' LIMIT 1;
        END IF;
      END IF;

      IF v_account_id IS NOT NULL AND v_line_total <> 0 THEN
        INSERT INTO journal_entry_lines (
          journal_entry_id, line_number, account_id, description,
          debit, credit, supplier_id
        ) VALUES (
          v_je_id, v_line_number, v_account_id,
          COALESCE(LEFT(v_item->>'description', 100), 'Purchase Item'),
          v_line_total * v_rate, 0, v_supplier_id
        );
        v_line_number := v_line_number + 1;
      END IF;
    END LOOP;

    -- ── Synchronize batch aggregates for batches referenced by this invoice ──
    -- Aggregates multiple items sharing the same batch ID across invoice items.
    -- Safely handles multi-line batches within an invoice and shared batches across invoices.
    -- Does NOT overwrite cost_per_unit, landed_cost_per_unit, or import_price_per_unit
    -- to preserve authoritative contract pricing and avoid false COGS true-up triggers.
    -- Does NOT overwrite batches that have already undergone physical warehouse receiving.
    UPDATE public.batches b
       SET import_quantity = agg.total_quantity,
           final_landed_cost = CASE 
             WHEN b.import_container_id IS NULL THEN agg.total_cost_idr 
             ELSE b.final_landed_cost 
           END,
           updated_at = NOW()
      FROM (
        SELECT 
          pii.batch_id,
          SUM(pii.quantity) as total_quantity,
          SUM(COALESCE(pii.line_total, pii.quantity * pii.unit_price) * CASE WHEN pi.currency = 'IDR' THEN 1 ELSE COALESCE(pi.exchange_rate, 1) END) as total_cost_idr
        FROM public.purchase_invoice_items pii
        JOIN public.purchase_invoices pi ON pi.id = pii.purchase_invoice_id
        WHERE pii.batch_id IN (
          SELECT DISTINCT item_sub.batch_id 
          FROM public.purchase_invoice_items item_sub 
          WHERE item_sub.purchase_invoice_id = v_invoice_id AND item_sub.batch_id IS NOT NULL
        )
        GROUP BY pii.batch_id
      ) agg
     WHERE b.id = agg.batch_id
       AND COALESCE(b.current_stock, 0) = 0
       AND NOT EXISTS (
         SELECT 1 FROM public.purchase_invoice_receiving_allocations pira WHERE pira.batch_id = b.id
       );

    -- PPN Input debit line (DR 1150)
    IF v_tax_amount > 0 AND v_ppn_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (
        journal_entry_id, line_number, account_id, description,
        debit, credit, supplier_id
      ) VALUES (
        v_je_id, v_line_number, v_ppn_account_id,
        'PPN Masukan - ' || v_invoice_number,
        v_tax_amount * v_rate, 0, v_supplier_id
      );
      v_line_number := v_line_number + 1;
    END IF;

    -- Stamp duty debit line (DR 6950)
    IF v_stamp_duty_amount > 0 AND v_bm_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (
        journal_entry_id, line_number, account_id, description,
        debit, credit, supplier_id
      ) VALUES (
        v_je_id, v_line_number, v_bm_account_id,
        'Bea Meterai - ' || v_invoice_number,
        v_stamp_duty_amount, 0, v_supplier_id
      );
      v_line_number := v_line_number + 1;
    END IF;

    -- A/P credit line (CR 2110)
    INSERT INTO journal_entry_lines (
      journal_entry_id, line_number, account_id, description,
      debit, credit, supplier_id
    ) VALUES (
      v_je_id, v_line_number, v_ap_account_id,
      'A/P - ' || v_invoice_number,
      0, v_total_amount * v_rate, v_supplier_id
    );

    UPDATE journal_entries
    SET total_debit = (SELECT COALESCE(SUM(debit), 0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id)
    WHERE id = v_je_id;

    RETURN jsonb_build_object(
      'success',        TRUE,
      'invoice_id',     v_invoice_id,
      'invoice_number', v_invoice_number,
      'total_amount',   v_total_amount
    );
  END;
$function$
;

-- 2. Hardened receive_purchase_invoice_item preserving total import_quantity on skeleton and partial receipts
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
      -- Update batch: preserve existing total import_quantity if pre-created with multi-line sum
      UPDATE public.batches
         SET import_quantity = GREATEST(COALESCE(import_quantity, 0), p_received_quantity),
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
         SET import_quantity = GREATEST(
               COALESCE(import_quantity, 0),
               (SELECT COALESCE(SUM(received_quantity), 0) FROM public.purchase_invoice_receiving_allocations WHERE batch_id = v_batch.id) + p_received_quantity
             ),
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
;

COMMIT;
