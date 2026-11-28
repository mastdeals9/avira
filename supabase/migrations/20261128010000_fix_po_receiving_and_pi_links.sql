-- ============================================================================
-- Migration: Fix PO receiving quantities sync and PI-to-PO item link validation
-- Scope: Issues 1 & 2 (Historical cutoff 2026-11-19 + permanent safeguards)
-- ============================================================================

-- 1. Canonical recompute helper for purchase_order_items.quantity_received
--    Converts received_quantity (stored in product base unit) to the PO item's unit when compatible.
CREATE OR REPLACE FUNCTION public.recompute_purchase_order_item_received(p_po_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_received numeric(18,3);
BEGIN
  IF p_po_item_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(
           CASE
             WHEN LOWER(TRIM(COALESCE(p.unit, poi.unit, ''))) = LOWER(TRIM(COALESCE(poi.unit, ''))) THEN pira.received_quantity
             WHEN LOWER(TRIM(COALESCE(p.unit, ''))) = 'g' AND LOWER(TRIM(COALESCE(poi.unit, ''))) = 'kg' THEN pira.received_quantity / 1000.0
             WHEN LOWER(TRIM(COALESCE(p.unit, ''))) = 'kg' AND LOWER(TRIM(COALESCE(poi.unit, ''))) = 'g' THEN pira.received_quantity * 1000.0
             WHEN LOWER(TRIM(COALESCE(p.unit, ''))) = 'mg' AND LOWER(TRIM(COALESCE(poi.unit, ''))) = 'g' THEN pira.received_quantity / 1000.0
             WHEN LOWER(TRIM(COALESCE(p.unit, ''))) = 'g' AND LOWER(TRIM(COALESCE(poi.unit, ''))) = 'mg' THEN pira.received_quantity * 1000.0
             WHEN LOWER(TRIM(COALESCE(p.unit, ''))) = 'ml' AND LOWER(TRIM(COALESCE(poi.unit, ''))) = 'l' THEN pira.received_quantity / 1000.0
             WHEN LOWER(TRIM(COALESCE(p.unit, ''))) = 'l' AND LOWER(TRIM(COALESCE(poi.unit, ''))) = 'ml' THEN pira.received_quantity * 1000.0
             ELSE pira.received_quantity
           END
         ), 0)::numeric(18,3)
    INTO v_received
    FROM public.purchase_order_items poi
    LEFT JOIN public.products p ON p.id = poi.product_id
    LEFT JOIN public.purchase_invoice_items pii ON pii.purchase_order_item_id = poi.id
    LEFT JOIN public.purchase_invoices pi ON pi.id = pii.purchase_invoice_id
    LEFT JOIN public.purchase_invoice_receiving_allocations pira ON pira.purchase_invoice_item_id = pii.id
      AND pira.status = 'received'
      AND COALESCE(LOWER(pi.status), '') NOT IN ('cancelled', 'void', 'deleted')
   WHERE poi.id = p_po_item_id;

  UPDATE public.purchase_order_items
     SET quantity_received = COALESCE(v_received, 0)
   WHERE id = p_po_item_id
     AND quantity_received IS DISTINCT FROM COALESCE(v_received, 0);
END;
$$;

-- 2. Trigger on purchase_invoice_receiving_allocations to keep PO quantity_received synced
CREATE OR REPLACE FUNCTION public.trg_sync_po_item_quantity_received_alloc()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_old_po_item_id uuid;
  v_new_po_item_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.purchase_invoice_item_id IS NOT NULL THEN
    SELECT purchase_order_item_id INTO v_old_po_item_id
      FROM public.purchase_invoice_items
     WHERE id = OLD.purchase_invoice_item_id;
    PERFORM public.recompute_purchase_order_item_received(v_old_po_item_id);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.purchase_invoice_item_id IS NOT NULL THEN
    SELECT purchase_order_item_id INTO v_new_po_item_id
      FROM public.purchase_invoice_items
     WHERE id = NEW.purchase_invoice_item_id;
    IF v_new_po_item_id IS DISTINCT FROM v_old_po_item_id OR TG_OP = 'INSERT' THEN
      PERFORM public.recompute_purchase_order_item_received(v_new_po_item_id);
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_po_item_quantity_received_alloc ON public.purchase_invoice_receiving_allocations;
CREATE TRIGGER trg_sync_po_item_quantity_received_alloc
AFTER INSERT OR UPDATE OF status, received_quantity, purchase_invoice_item_id OR DELETE
ON public.purchase_invoice_receiving_allocations
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_po_item_quantity_received_alloc();

-- 3. Trigger on purchase_invoice_items when purchase_order_item_id is relinked/unlinked/deleted
CREATE OR REPLACE FUNCTION public.trg_sync_po_item_quantity_received_pi_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.purchase_order_item_id IS NOT NULL THEN
    PERFORM public.recompute_purchase_order_item_received(OLD.purchase_order_item_id);
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.purchase_order_item_id IS NOT NULL
     AND NEW.purchase_order_item_id IS DISTINCT FROM OLD.purchase_order_item_id THEN
    PERFORM public.recompute_purchase_order_item_received(NEW.purchase_order_item_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_po_item_quantity_received_pi_item ON public.purchase_invoice_items;
CREATE TRIGGER trg_sync_po_item_quantity_received_pi_item
AFTER UPDATE OF purchase_order_item_id OR DELETE
ON public.purchase_invoice_items
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_po_item_quantity_received_pi_item();

-- 4. Guard preventing incompatible product or unit links between PI items and PO items
CREATE OR REPLACE FUNCTION public.validate_purchase_invoice_po_item_compatibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_po_item public.purchase_order_items%ROWTYPE;
BEGIN
  IF NEW.purchase_order_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Preserve untouched legacy rows on unrelated column updates
  IF TG_OP = 'UPDATE'
     AND NEW.purchase_order_item_id IS NOT DISTINCT FROM OLD.purchase_order_item_id
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND LOWER(TRIM(COALESCE(NEW.unit, ''))) = LOWER(TRIM(COALESCE(OLD.unit, ''))) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_po_item
    FROM public.purchase_order_items
   WHERE id = NEW.purchase_order_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order item % not found', NEW.purchase_order_item_id;
  END IF;

  IF NEW.product_id IS NOT NULL AND v_po_item.product_id IS NOT NULL
     AND NEW.product_id IS DISTINCT FROM v_po_item.product_id THEN
    RAISE EXCEPTION 'Product mismatch: purchase invoice item product % does not match purchase order item product %',
      NEW.product_id, v_po_item.product_id;
  END IF;

  IF NULLIF(TRIM(COALESCE(NEW.unit, '')), '') IS NOT NULL
     AND NULLIF(TRIM(COALESCE(v_po_item.unit, '')), '') IS NOT NULL
     AND LOWER(TRIM(NEW.unit)) <> LOWER(TRIM(v_po_item.unit)) THEN
    RAISE EXCEPTION 'Unit mismatch: purchase invoice item unit (%) does not match purchase order item unit (%)',
      NEW.unit, v_po_item.unit;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_pi_po_item_compatibility ON public.purchase_invoice_items;
CREATE TRIGGER trg_validate_pi_po_item_compatibility
BEFORE INSERT OR UPDATE OF purchase_order_item_id, product_id, unit
ON public.purchase_invoice_items
FOR EACH ROW
EXECUTE FUNCTION public.validate_purchase_invoice_po_item_compatibility();

-- 5. Fix unambiguous crossed historical purchase_order_item_id links
-- 5a. PO-2611-0002 / E0000244/2627 (1-to-1 pairing by product_id + quantity + unit_price + row_number)
WITH pi_lines AS (
  SELECT pii.id AS pi_item_id,
         pii.product_id,
         pii.quantity,
         pii.unit_price,
         ROW_NUMBER() OVER (PARTITION BY pii.product_id, pii.quantity, pii.unit_price ORDER BY pii.id) AS rn
    FROM public.purchase_invoice_items pii
    JOIN public.purchase_invoices pi ON pi.id = pii.purchase_invoice_id
    JOIN public.purchase_orders po ON po.id = pi.purchase_order_id
   WHERE pi.invoice_number = 'E0000244/2627'
     AND po.po_number = 'PO-2611-0002'
),
po_lines AS (
  SELECT poi.id AS po_item_id,
         poi.product_id,
         poi.quantity,
         poi.unit_price,
         ROW_NUMBER() OVER (PARTITION BY poi.product_id, poi.quantity, poi.unit_price ORDER BY poi.id) AS rn
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.po_id
   WHERE po.po_number = 'PO-2611-0002'
)
UPDATE public.purchase_invoice_items pii
   SET purchase_order_item_id = po_lines.po_item_id
  FROM pi_lines
  JOIN po_lines ON po_lines.product_id = pi_lines.product_id
               AND ABS(COALESCE(po_lines.quantity, 0) - COALESCE(pi_lines.quantity, 0)) < 0.001
               AND ABS(COALESCE(po_lines.unit_price, 0) - COALESCE(pi_lines.unit_price, 0)) < 0.01
               AND po_lines.rn = pi_lines.rn
 WHERE pii.id = pi_lines.pi_item_id
   AND pii.purchase_order_item_id IS DISTINCT FROM po_lines.po_item_id;

-- 5b. PO-2605-0001 / E0000387/2526 (2 Corn Starch BP lines: 9000 kg and 10000 kg)
UPDATE public.purchase_invoice_items pii
   SET purchase_order_item_id = poi.id
  FROM public.purchase_invoices pi
  JOIN public.purchase_orders po ON po.id = pi.purchase_order_id
  JOIN public.purchase_order_items poi ON poi.po_id = po.id
 WHERE pii.purchase_invoice_id = pi.id
   AND pi.invoice_number = 'E0000387/2526'
   AND po.po_number = 'PO-2605-0001'
   AND pii.product_id = poi.product_id
   AND ABS(COALESCE(pii.quantity, 0) - COALESCE(poi.quantity, 0)) < 0.001
   AND pii.purchase_order_item_id IS DISTINCT FROM poi.id;

-- 5c. PO-2610-0002 / HM000004/2627 (two 4000 kg lines wrongly pointing to 6000 kg & 3000 kg PO lines)
WITH pi_4000 AS (
  SELECT pii.id AS pi_item_id,
         ROW_NUMBER() OVER (ORDER BY pii.id) AS rn
    FROM public.purchase_invoice_items pii
    JOIN public.purchase_invoices pi ON pi.id = pii.purchase_invoice_id
    JOIN public.purchase_orders po ON po.id = pi.purchase_order_id
   WHERE pi.invoice_number = 'HM000004/2627'
     AND po.po_number = 'PO-2610-0002'
     AND ABS(COALESCE(pii.quantity, 0) - 4000) < 0.001
),
po_4000 AS (
  SELECT poi.id AS po_item_id,
         ROW_NUMBER() OVER (ORDER BY poi.id) AS rn
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.po_id
   WHERE po.po_number = 'PO-2610-0002'
     AND ABS(COALESCE(poi.quantity, 0) - 4000) < 0.001
)
UPDATE public.purchase_invoice_items pii
   SET purchase_order_item_id = po_4000.po_item_id
  FROM pi_4000
  JOIN po_4000 ON po_4000.rn = pi_4000.rn
 WHERE pii.id = pi_4000.pi_item_id
   AND pii.purchase_order_item_id IS DISTINCT FROM po_4000.po_item_id;

-- 5d. PO-2601-0012 / E0000274/2526 (Mometasone Furoate): align PO unit 'g' -> 'kg' matching PI 'KG'
--     and 250 g received batch without altering quantity (0.250), unit_price (600.00), or line_total (150.00).
UPDATE public.purchase_order_items poi
   SET unit = 'kg'
  FROM public.purchase_orders po
  JOIN public.products p ON true
 WHERE poi.po_id = po.id
   AND poi.product_id = p.id
   AND po.po_number = 'PO-2601-0012'
   AND p.product_name = 'Mometasone Furoate'
   AND ABS(COALESCE(poi.quantity, 0) - 0.250) < 0.0001
   AND LOWER(TRIM(COALESCE(poi.unit, ''))) = 'g';

-- 6. Backfill stale purchase_order_items.quantity_received for historical POs (<= 2026-11-19)
DO $$
DECLARE
  v_po_item_id uuid;
BEGIN
  FOR v_po_item_id IN
    SELECT poi.id
      FROM public.purchase_order_items poi
      JOIN public.purchase_orders po ON po.id = poi.po_id
     WHERE po.po_date <= '2026-11-19'
  LOOP
    PERFORM public.recompute_purchase_order_item_received(v_po_item_id);
  END LOOP;
END;
$$;

-- 7. Restrict helper and trigger function execution privileges
REVOKE ALL ON FUNCTION public.recompute_purchase_order_item_received(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_purchase_order_item_received(uuid) TO postgres, service_role;

REVOKE ALL ON FUNCTION public.trg_sync_po_item_quantity_received_alloc() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_sync_po_item_quantity_received_alloc() TO postgres, service_role;

REVOKE ALL ON FUNCTION public.trg_sync_po_item_quantity_received_pi_item() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_sync_po_item_quantity_received_pi_item() TO postgres, service_role;

REVOKE ALL ON FUNCTION public.validate_purchase_invoice_po_item_compatibility() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_purchase_invoice_po_item_compatibility() TO postgres, service_role;
