-- ============================================================================
-- Migration: Keep batch cost summaries synced with purchase_batch_cost_layers
-- Scope: Issue 3 (Batch Cost, Inventory Valuation & Import Container Sync)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_batch_cost_summary_from_layers(p_batch_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_layer_qty numeric;
  v_layer_landed_add numeric;
  v_layer_final_total numeric;
  v_unit_cost numeric(18,8);
  v_prev_repair text;
BEGIN
  IF p_batch_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(quantity), 0),
         COALESCE(SUM(landed_cost_amount), 0),
         COALESCE(SUM(quantity * final_functional_unit_cost), 0)
    INTO v_layer_qty, v_layer_landed_add, v_layer_final_total
    FROM public.purchase_batch_cost_layers
   WHERE batch_id = p_batch_id;

  IF COALESCE(v_layer_qty, 0) <= 0 OR COALESCE(v_layer_final_total, 0) <= 0 THEN
    RETURN;
  END IF;

  v_unit_cost := ROUND(v_layer_final_total / v_layer_qty, 8);
  v_prev_repair := current_setting('app.finance_metadata_repair', true);

  PERFORM set_config('app.finance_metadata_repair', 'on', true);
  BEGIN
    UPDATE public.batches
       SET import_cost_allocated = ROUND(v_layer_landed_add, 2),
           final_landed_cost     = ROUND(v_layer_final_total, 2),
           landed_cost_per_unit  = v_unit_cost,
           cost_per_unit         = v_unit_cost,
           updated_at            = now()
     WHERE id = p_batch_id
       AND (
         import_cost_allocated IS DISTINCT FROM ROUND(v_layer_landed_add, 2)
         OR final_landed_cost IS DISTINCT FROM ROUND(v_layer_final_total, 2)
         OR ABS(COALESCE(landed_cost_per_unit, 0) - v_unit_cost) > 0.0001
         OR ABS(COALESCE(cost_per_unit, 0) - v_unit_cost) > 0.0001
       );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.finance_metadata_repair', COALESCE(v_prev_repair, ''), true);
    RAISE;
  END;

  PERFORM set_config('app.finance_metadata_repair', COALESCE(v_prev_repair, ''), true);
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_sync_batch_cost_summary_from_layers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.batch_id IS NOT NULL THEN
    PERFORM public.sync_batch_cost_summary_from_layers(OLD.batch_id);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.batch_id IS NOT NULL THEN
    PERFORM public.sync_batch_cost_summary_from_layers(NEW.batch_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_batch_cost_summary_from_layers ON public.purchase_batch_cost_layers;
CREATE TRIGGER trg_sync_batch_cost_summary_from_layers
AFTER INSERT OR UPDATE OR DELETE
ON public.purchase_batch_cost_layers
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_batch_cost_summary_from_layers();

-- Backfill historical batches whose summary fields lag behind purchase_batch_cost_layers
-- without modifying historical COGS or double-capitalizing import costs.
DO $$
DECLARE
  v_batch_id uuid;
BEGIN
  FOR v_batch_id IN
    SELECT DISTINCT b.id
      FROM public.batches b
      JOIN public.purchase_batch_cost_layers l ON l.batch_id = b.id
     WHERE b.import_date <= '2026-11-19'
        OR b.batch_number IN (
          'MLAH0260425','PRAH0640725','K007.2/25/07/335','25CTH027','17731025',
          'M1CFX10003725N','TMP02260001','17721025','BDOM/2509043','4001/1101/25/A-3146',
          'BCYPH/2510070','DFK/125090136','26CTH018','LHAH0741025','1699/2025',
          '2610892','DFS/126010053'
        )
  LOOP
    PERFORM public.sync_batch_cost_summary_from_layers(v_batch_id);
  END LOOP;
END;
$$;

-- Restrict helper and trigger function execution privileges
REVOKE ALL ON FUNCTION public.sync_batch_cost_summary_from_layers(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_batch_cost_summary_from_layers(uuid) TO postgres, service_role;

REVOKE ALL ON FUNCTION public.trg_sync_batch_cost_summary_from_layers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_sync_batch_cost_summary_from_layers() TO postgres, service_role;
