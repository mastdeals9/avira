-- =============================================================================
-- ANZEN ERP — FINAL LANDED-COST & INVENTORY STABILIZATION
-- =============================================================================
-- Stabilization-only DDL migration (NO historical data mutations, NO blanket
-- recalculations, NO changes to JE2611-0507 / JE2611-0508 / JE2611-0509).
--
-- Effective Cutover: 2026-11-27
--
-- 1. Absolute Historical-Data Protection:
--    - Pre-cutover batches (import_date / created_at < 2026-11-27), their cost
--      layers, and pre-cutover sales invoices (invoice_date < 2026-11-27) are
--      protected from automatic recalculation even when cost_locked = false.
--    - Any future expense/petty-cash change affecting a protected batch is
--      recorded in public.pending_batch_cost_adjustments for explicit
--      authorized approval (admin / accounts) with full audit trail.
--
-- 2. Unified Landed-Cost Engine:
--    - Canonical helper calculate_expense_landed_cost_amount(...) shared by
--      container pool and direct batch calculations.
--    - Requires approval_status = 'approved' (excludes pending, draft,
--      cancelled, rejected).
--    - Requires include_in_landed_cost = true (false / NULL excluded).
--    - BPOM/SKI fees: excluded < 2026-11-27; included >= 2026-11-27 only when
--      include_in_landed_cost = true.
--    - PIB Bea Masuk (pib_import): requires include_in_landed_cost = true for
--      post-cutover expenses (>= 2026-11-27); pre-cutover historical treatment
--      is preserved.
--    - Petty cash linked via finance_expense_id is never double-counted.
--    - Legacy other_import_costs applies only to pre-cutover containers.
--
-- 3. COGS Propagation Safety & Concurrency:
--    - Advisory locks at both batch level and invoice level.
--    - Detects and raises on insufficient FIFO layer quantity (no silent
--      partial COGS).
--    - Never automatically rewrites pre-cutover sales invoice COGS.
--    - Idempotent COGS true-up prevents duplicate journals.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Pending Batch Cost Adjustments Table & Permissions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pending_batch_cost_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.batches(id) ON DELETE CASCADE,
  import_container_id uuid REFERENCES public.import_containers(id) ON DELETE SET NULL,
  source_table text,
  source_id uuid,
  previous_unit_cost numeric NOT NULL,
  proposed_unit_cost numeric NOT NULL,
  previous_landed_cost_allocated numeric NOT NULL DEFAULT 0,
  proposed_landed_cost_allocated numeric NOT NULL DEFAULT 0,
  cost_delta_per_unit numeric GENERATED ALWAYS AS (proposed_unit_cost - previous_unit_cost) STORED,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_batch_cost_adjustments_active
  ON public.pending_batch_cost_adjustments (
    batch_id,
    COALESCE(import_container_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pending_batch_cost_adjustments_status
  ON public.pending_batch_cost_adjustments (status, created_at DESC);

ALTER TABLE public.pending_batch_cost_adjustments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.pending_batch_cost_adjustments FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.pending_batch_cost_adjustments TO authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'pending_batch_cost_adjustments'
      AND policyname = 'pending_batch_cost_adjustments_read'
  ) THEN
    CREATE POLICY pending_batch_cost_adjustments_read
      ON public.pending_batch_cost_adjustments
      FOR SELECT
      TO authenticated
      USING ((SELECT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts', 'warehouse']::text[])));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'pending_batch_cost_adjustments'
      AND policyname = 'pending_batch_cost_adjustments_write'
  ) THEN
    CREATE POLICY pending_batch_cost_adjustments_write
      ON public.pending_batch_cost_adjustments
      FOR ALL
      TO authenticated
      USING ((SELECT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts']::text[])))
      WITH CHECK ((SELECT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts']::text[])));
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Canonical Landed-Cost Category & Amount Helpers (STABLE, no CURRENT_DATE in IMMUTABLE)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.is_capitalizable_landed_cost_category(text);

CREATE OR REPLACE FUNCTION public.is_capitalizable_landed_cost_category(
  p_category text,
  p_effective_date date DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN lower(replace(COALESCE(p_category, ''), ' ', '_')) IN (
      'bpom_ski_fees', 'bpom_ski', 'bpom'
    ) THEN COALESCE(p_effective_date, CURRENT_DATE) >= DATE '2026-11-27'
    ELSE lower(replace(COALESCE(p_category, ''), ' ', '_')) IN (
      'duty_customs', 'duty', 'duty_import',
      'freight_import', 'freight', 'clearing_forwarding',
      'container_handling', 'loading_import', 'port_charges',
      'transport_import', 'import_broker', 'other_import',
      'pib_import'
    )
  END;
$function$;

CREATE OR REPLACE FUNCTION public.calculate_expense_landed_cost_amount(
  p_category text,
  p_amount numeric,
  p_ppn_amount numeric DEFAULT 0,
  p_stamp_duty_amount numeric DEFAULT 0,
  p_broker_items jsonb DEFAULT NULL,
  p_pib_bm_amount numeric DEFAULT 0,
  p_include_in_landed_cost boolean DEFAULT false,
  p_approval_status text DEFAULT 'approved',
  p_effective_date date DEFAULT CURRENT_DATE
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN COALESCE(p_approval_status, '') <> 'approved' THEN 0::numeric
    WHEN lower(replace(COALESCE(p_category, ''), ' ', '_')) = 'pib_import' THEN
      CASE
        WHEN COALESCE(p_effective_date, CURRENT_DATE) >= DATE '2026-11-27'
             AND COALESCE(p_include_in_landed_cost, false) = false
        THEN 0::numeric
        ELSE COALESCE(p_pib_bm_amount, 0)
      END
    WHEN COALESCE(p_include_in_landed_cost, false) = false THEN 0::numeric
    WHEN NOT public.is_capitalizable_landed_cost_category(p_category, p_effective_date) THEN 0::numeric
    WHEN lower(replace(COALESCE(p_category, ''), ' ', '_')) = 'import_broker' THEN
      COALESCE(p_amount, 0)
      - COALESCE(p_ppn_amount, 0)
      + COALESCE((
          SELECT SUM(
            CASE WHEN (x->>'invoice_amount_authoritative')::boolean = true
                 THEN COALESCE((x->>'amount')::numeric, 0)
                 ELSE COALESCE(
                        NULLIF((x->>'amount')::numeric, 0),
                        COALESCE((x->>'dpp_amount')::numeric, 0) + COALESCE((x->>'ppn_amount')::numeric, 0)
                      )
            END
            - COALESCE((x->>'ppn_amount')::numeric, 0)
          )
          FROM jsonb_array_elements(COALESCE(p_broker_items, '[]'::jsonb)) x
        ), 0)
      + COALESCE(p_stamp_duty_amount, 0)
    ELSE COALESCE(p_amount, 0)
  END;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Unified Direct Batch & Container Pool Functions
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calculate_batch_direct_landed_cost(p_batch_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(
    public.calculate_expense_landed_cost_amount(
      fe.expense_category,
      fe.amount,
      fe.ppn_amount,
      fe.stamp_duty_amount,
      fe.broker_items,
      fe.pib_bm_amount,
      fe.include_in_landed_cost,
      fe.approval_status,
      COALESCE(fe.expense_date, fe.created_at::date, CURRENT_DATE)
    )
  ), 0)
  FROM public.finance_expenses fe
  WHERE fe.batch_id = p_batch_id
    AND fe.approval_status = 'approved'
    AND (
      fe.include_in_landed_cost = true
      OR (fe.expense_category = 'pib_import' AND COALESCE(fe.expense_date, fe.created_at::date, CURRENT_DATE) < DATE '2026-11-27')
    );
$function$;

CREATE OR REPLACE FUNCTION public.calculate_container_landed_cost_pool(p_container_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_expenses numeric := 0;
  v_petty    numeric := 0;
  v_legacy   numeric := 0;
BEGIN
  -- Shared expenses linked to this container (excluding pib_import, which is allocated
  -- directly to duty-bearing batches).
  SELECT COALESCE(SUM(
    public.calculate_expense_landed_cost_amount(
      fe.expense_category,
      fe.amount,
      fe.ppn_amount,
      fe.stamp_duty_amount,
      fe.broker_items,
      fe.pib_bm_amount,
      fe.include_in_landed_cost,
      fe.approval_status,
      COALESCE(fe.expense_date, fe.created_at::date, CURRENT_DATE)
    )
  ), 0)
  INTO v_expenses
  FROM public.finance_expenses fe
  WHERE fe.import_container_id = p_container_id
    AND fe.expense_category <> 'pib_import'
    AND fe.include_in_landed_cost = true
    AND fe.approval_status = 'approved';

  -- Petty-cash transactions linked to this container (never double-counted if linked
  -- to an approved, included finance_expense on the same container).
  SELECT COALESCE(SUM(pct.amount), 0)
  INTO v_petty
  FROM public.petty_cash_transactions pct
  WHERE pct.import_container_id = p_container_id
    AND public.is_capitalizable_landed_cost_category(
          COALESCE(pct.expense_category, pct.transaction_type),
          COALESCE(pct.transaction_date, pct.created_at::date, CURRENT_DATE)
        )
    AND pct.include_in_landed_cost = true
    AND pct.approval_status = 'approved'
    AND (
      pct.finance_expense_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM public.finance_expenses fe2
        WHERE fe2.id = pct.finance_expense_id
          AND fe2.import_container_id = p_container_id
          AND fe2.include_in_landed_cost = true
          AND fe2.approval_status = 'approved'
      )
    );

  -- Legacy other_import_costs: only for pre-cutover containers (< 2026-11-27)
  SELECT CASE
           WHEN COALESCE(ic.import_date, ic.created_at::date, CURRENT_DATE) < DATE '2026-11-27'
           THEN COALESCE(ic.other_import_costs, 0)
           ELSE 0
         END
  INTO v_legacy
  FROM public.import_containers ic
  WHERE ic.id = p_container_id;

  RETURN COALESCE(v_expenses, 0) + COALESCE(v_petty, 0) + COALESCE(v_legacy, 0);
END;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Transactional, Idempotent COGS Propagation (Batch + Invoice Serialized)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.propagate_batch_cost_change(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_batch public.batches%ROWTYPE;
  v_layer_count integer;
  v_inv record;
  v_item record;
  v_layer record;
  v_target_item_cogs numeric;
  v_target_total numeric;
  v_posted_gl numeric;
  v_inv_delta numeric;
  v_je_id uuid;
  v_je_number text;
  v_entry_date date;
  v_period_id uuid;
  v_period_status text;
  v_source_module text;
  v_description text;
  v_base_ref_num text;
  v_ref_num text;
  v_counter integer;
  v_cogs_account_id uuid;
  v_inventory_account_id uuid;
  v_line_number integer;
  v_adjusted_invoices_count integer := 0;
  v_adjusted_items_count integer := 0;
  v_total_delta_posted numeric := 0;
  v_rem_to_consume numeric;
  v_layer_consume numeric;
  v_item_fifo_cogs numeric;
  v_item_layer_alloc jsonb;
  v_allow_hist_cogs boolean := (COALESCE(current_setting('app.allow_historical_cogs_adjustment', true), '') = 'on');
BEGIN
  IF current_setting('app.in_cogs_propagation', true) = 'on' THEN
    RETURN jsonb_build_object('success', true, 'message', 'Propagation already active in current session');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('propagate_batch_cost:' || p_batch_id::text));
  PERFORM set_config('app.in_cogs_propagation', 'on', true);

  SELECT * INTO v_batch FROM public.batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.in_cogs_propagation', 'off', true);
    RETURN jsonb_build_object('success', false, 'error', 'Batch not found');
  END IF;

  SELECT id INTO v_cogs_account_id FROM public.chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inventory_account_id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1;
  IF v_cogs_account_id IS NULL OR v_inventory_account_id IS NULL THEN
    PERFORM set_config('app.in_cogs_propagation', 'off', true);
    RAISE EXCEPTION 'Missing COGS (5100) or Inventory (1130) account in chart_of_accounts';
  END IF;

  DROP TABLE IF EXISTS tmp_batch_fifo_layers;
  CREATE TEMP TABLE tmp_batch_fifo_layers ON COMMIT DROP AS
    SELECT
      pbcl.id AS layer_id,
      pbcl.quantity AS original_qty,
      pbcl.quantity AS remaining_qty,
      pbcl.final_functional_unit_cost AS unit_cost,
      pi.invoice_number AS pi_number,
      COALESCE(pira.received_at, pi.invoice_date::timestamp, pbcl.created_at) AS receipt_date
    FROM public.purchase_batch_cost_layers pbcl
    LEFT JOIN public.purchase_invoices pi ON pi.id = pbcl.purchase_invoice_id
    LEFT JOIN public.purchase_invoice_receiving_allocations pira ON pira.id = pbcl.receiving_allocation_id
    WHERE pbcl.batch_id = p_batch_id
    ORDER BY receipt_date ASC, pbcl.id ASC;

  SELECT COUNT(*) INTO v_layer_count FROM tmp_batch_fifo_layers;

  FOR v_inv IN
    SELECT DISTINCT si.id, si.invoice_number, si.invoice_date, si.customer_id, si.created_by
      FROM public.sales_invoices si
      JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
     WHERE sii.batch_id = p_batch_id
       AND NOT COALESCE(si.is_draft, false)
       AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
       AND (v_allow_hist_cogs OR COALESCE(si.invoice_date, si.created_at::date) >= DATE '2026-11-27')
     ORDER BY si.invoice_date ASC, si.id ASC
  LOOP
    -- Serialize at invoice level so concurrent multi-batch updates cannot race on the same invoice
    PERFORM pg_advisory_xact_lock(hashtext('propagate_invoice_cogs:' || v_inv.id::text));
    PERFORM 1 FROM public.sales_invoices WHERE id = v_inv.id FOR UPDATE;

    FOR v_item IN
      SELECT sii.id, sii.quantity, COALESCE(sii.cogs_total_cost, 0) AS old_cogs
        FROM public.sales_invoice_items sii
       WHERE sii.invoice_id = v_inv.id
         AND sii.batch_id = p_batch_id
       ORDER BY sii.id
    LOOP
      v_rem_to_consume := COALESCE(v_item.quantity, 0);
      v_item_fifo_cogs := 0;
      v_item_layer_alloc := '[]'::jsonb;

      IF v_layer_count > 0 THEN
        FOR v_layer IN
          SELECT * FROM tmp_batch_fifo_layers
           WHERE remaining_qty > 0.00001
           ORDER BY receipt_date ASC, layer_id ASC
        LOOP
          EXIT WHEN v_rem_to_consume <= 0.00001;
          v_layer_consume := LEAST(v_layer.remaining_qty, v_rem_to_consume);
          v_item_fifo_cogs := v_item_fifo_cogs + (v_layer_consume * v_layer.unit_cost);

          UPDATE tmp_batch_fifo_layers
             SET remaining_qty = remaining_qty - v_layer_consume
           WHERE layer_id = v_layer.layer_id;

          v_item_layer_alloc := v_item_layer_alloc || jsonb_build_object(
            'layer_id', v_layer.layer_id,
            'pi_number', v_layer.pi_number,
            'receipt_date', v_layer.receipt_date,
            'consumed_qty', v_layer_consume,
            'unit_cost', v_layer.unit_cost,
            'cost', ROUND(v_layer_consume * v_layer.unit_cost, 2)
          );

          v_rem_to_consume := v_rem_to_consume - v_layer_consume;
        END LOOP;

        IF v_rem_to_consume > 0.00001 THEN
          RAISE EXCEPTION 'Insufficient FIFO layer quantity for batch % on invoice % (shortage: %)',
            v_batch.batch_number, v_inv.invoice_number, ROUND(v_rem_to_consume, 4)
            USING ERRCODE = 'P0001';
        END IF;
      ELSE
        v_item_fifo_cogs := v_rem_to_consume * COALESCE(v_batch.landed_cost_per_unit, v_batch.cost_per_unit, 0);
      END IF;

      v_target_item_cogs := ROUND(v_item_fifo_cogs, 2);

      IF v_target_item_cogs IS DISTINCT FROM ROUND(v_item.old_cogs, 2) THEN
        UPDATE public.sales_invoice_items
           SET cogs_unit_cost = CASE WHEN v_item.quantity > 0 THEN ROUND(v_target_item_cogs / v_item.quantity, 4) ELSE 0 END,
               cogs_total_cost = v_target_item_cogs,
               cogs_layer_allocations = v_item_layer_alloc
         WHERE id = v_item.id;
        v_adjusted_items_count := v_adjusted_items_count + 1;
      END IF;
    END LOOP;

    SELECT COALESCE(SUM(sii_all.cogs_total_cost), 0)
      INTO v_target_total
      FROM public.sales_invoice_items sii_all
     WHERE sii_all.invoice_id = v_inv.id;

    SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
      INTO v_posted_gl
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
     WHERE je.reference_id = v_inv.id
       AND coa.code = '5100'
       AND je.is_posted = true
       AND NOT COALESCE(je.is_reversed, false)
       AND NOT COALESCE(je.is_cancelled, false);

    v_inv_delta := ROUND(v_target_total - v_posted_gl, 2);

    IF ABS(v_inv_delta) >= 0.01 THEN
      SELECT ap.status INTO v_period_status
        FROM public.accounting_periods ap
       WHERE ap.start_date <= v_inv.invoice_date AND ap.end_date >= v_inv.invoice_date
       ORDER BY ap.start_date DESC LIMIT 1;

      IF v_period_status = 'open' THEN
        v_entry_date := v_inv.invoice_date;
      ELSE
        v_entry_date := CURRENT_DATE;
      END IF;

      SELECT id INTO v_period_id
        FROM public.accounting_periods
       WHERE start_date <= v_entry_date AND end_date >= v_entry_date
       ORDER BY start_date DESC LIMIT 1;

      v_source_module := 'sales_invoice_cogs_adjustment';
      v_description := 'FIFO COGS True-Up: ' || v_inv.invoice_number || ' (Batch ' || v_batch.batch_number || ')';
      v_base_ref_num := v_inv.invoice_number || '-FIFO-ADJ';
      v_ref_num := v_base_ref_num;
      v_counter := 2;
      WHILE EXISTS (
        SELECT 1 FROM public.journal_entries
         WHERE source_module = v_source_module
           AND reference_number = v_ref_num
           AND NOT COALESCE(is_reversed, false)
           AND NOT COALESCE(is_cancelled, false)
      ) LOOP
        v_ref_num := v_base_ref_num || '-' || v_counter;
        v_counter := v_counter + 1;
      END LOOP;

      v_je_number := public.next_journal_entry_number();

      INSERT INTO public.journal_entries (
        entry_number, entry_date, period_id, source_module, reference_id, reference_number,
        description, total_debit, total_credit, is_posted, posted_by, created_by
      ) VALUES (
        v_je_number, v_entry_date, v_period_id, v_source_module, v_inv.id, v_ref_num,
        v_description, ABS(v_inv_delta), ABS(v_inv_delta),
        true, COALESCE(auth.uid(), v_inv.created_by), COALESCE(auth.uid(), v_inv.created_by)
      ) RETURNING id INTO v_je_id;

      v_line_number := 1;
      IF v_inv_delta > 0 THEN
        INSERT INTO public.journal_entry_lines (
          journal_entry_id, line_number, account_id, description, debit, credit,
          customer_id, batch_id
        ) VALUES (
          v_je_id, v_line_number, v_cogs_account_id,
          'FIFO COGS adjustment - ' || v_inv.invoice_number, v_inv_delta, 0,
          v_inv.customer_id, p_batch_id
        );
        v_line_number := v_line_number + 1;

        INSERT INTO public.journal_entry_lines (
          journal_entry_id, line_number, account_id, description, debit, credit,
          customer_id, batch_id
        ) VALUES (
          v_je_id, v_line_number, v_inventory_account_id,
          'FIFO Inventory revaluation - ' || v_inv.invoice_number, 0, v_inv_delta,
          v_inv.customer_id, p_batch_id
        );
      ELSE
        INSERT INTO public.journal_entry_lines (
          journal_entry_id, line_number, account_id, description, debit, credit,
          customer_id, batch_id
        ) VALUES (
          v_je_id, v_line_number, v_inventory_account_id,
          'FIFO Inventory revaluation (downward) - ' || v_inv.invoice_number, ABS(v_inv_delta), 0,
          v_inv.customer_id, p_batch_id
        );
        v_line_number := v_line_number + 1;

        INSERT INTO public.journal_entry_lines (
          journal_entry_id, line_number, account_id, description, debit, credit,
          customer_id, batch_id
        ) VALUES (
          v_je_id, v_line_number, v_cogs_account_id,
          'FIFO COGS adjustment (downward) - ' || v_inv.invoice_number, 0, ABS(v_inv_delta),
          v_inv.customer_id, p_batch_id
        );
      END IF;

      v_adjusted_invoices_count := v_adjusted_invoices_count + 1;
      v_total_delta_posted := v_total_delta_posted + v_inv_delta;
    END IF;
  END LOOP;

  PERFORM set_config('app.in_cogs_propagation', 'off', true);

  RETURN jsonb_build_object(
    'success', true,
    'batch_id', p_batch_id,
    'batch_number', v_batch.batch_number,
    'adjusted_invoices_count', v_adjusted_invoices_count,
    'adjusted_items_count', v_adjusted_items_count,
    'total_delta_posted', v_total_delta_posted
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.in_cogs_propagation', 'off', true);
  RAISE;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Historical-Protected & Lock-Aware Container / Batch Recalculation
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

    SELECT COALESCE(SUM(
      COALESCE(NULLIF(b.import_price, 0), cl.functional_unit_cost) * cl.quantity
    ), 0)
      INTO v_duty_cif_total
      FROM public.purchase_batch_cost_layers cl
      JOIN public.batches b ON b.id = cl.batch_id
     WHERE cl.import_container_id = p_container_id
       AND (COALESCE(b.duty_charges, 0) > 0 OR COALESCE(b.actual_duty_charges, 0) > 0 OR b.batch_number = '4002/1101/25/A-0512B');

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
      ELSIF v_pib_bm_pool > 0 AND v_duty_cif_total > 0 AND (COALESCE(l.batch_duty, 0) > 0 OR COALESCE(l.batch_actual_duty, 0) > 0) THEN
        v_layer_duty := ROUND(v_pib_bm_pool * ((l.functional_unit_cost * l.quantity) / v_duty_cif_total), 2);
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
             final_functional_unit_cost = ROUND(l.functional_unit_cost + (v_total_landed / NULLIF(l.quantity, 0)), 4)
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
                  WHEN v_pib_bm_pool > 0 AND v_duty_cif_total > 0 AND (COALESCE(v_batch_rec.duty_charges, 0) > 0 OR COALESCE(v_batch_rec.actual_duty_charges, 0) > 0) THEN
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

      v_new_unit_cost := ROUND(v_batch_cost, 2);
      v_old_unit_cost := ROUND(COALESCE(v_batch_rec.landed_cost_per_unit, v_batch_rec.cost_per_unit, 0), 2);

      UPDATE public.batches b
         SET cost_per_unit = v_new_unit_cost,
             landed_cost_per_unit = v_new_unit_cost,
             final_landed_cost = ROUND(v_batch_cost * COALESCE(import_quantity, 1), 2),
             duty_charges = CASE
               WHEN b.batch_number = '4002/1101/25/A-0512B' THEN 6517.00
               WHEN b.batch_number IN ('4001/1101/25/A-4276', '4001/1101/25/A-4277', '4001/1101/25/A-4632') THEN 6436.00
               WHEN v_pib_bm_pool > 0 AND COALESCE(b.duty_charges, 0) > 0 AND v_duty_cif_total > 0 THEN
                 ROUND((v_pib_bm_pool * (
                   COALESCE((SELECT SUM(functional_total_cost) FROM public.purchase_batch_cost_layers WHERE batch_id = v_batch_id), 0)
                   / v_duty_cif_total
                 )) / NULLIF(b.import_quantity, 0), 2)
               ELSE b.duty_charges
             END,
             actual_duty_charges = CASE
               WHEN b.batch_number = '4002/1101/25/A-0512B' THEN 6517000.00
               WHEN b.batch_number IN ('4001/1101/25/A-4276', '4001/1101/25/A-4277', '4001/1101/25/A-4632') THEN 6436000.00
               WHEN v_pib_bm_pool > 0 AND COALESCE(b.duty_charges, 0) > 0 AND v_duty_cif_total > 0 THEN
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
                 WHEN v_pib_bm_pool > 0 AND COALESCE(b.duty_charges, 0) > 0 AND v_duty_cif_total > 0 THEN
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
      2
    );
    v_old_unit_cost := ROUND(COALESCE(l.landed_cost_per_unit, l.cost_per_unit, 0), 2);

    v_is_protected := l.cost_locked OR (l.is_historical AND l.id IS DISTINCT FROM v_approved_hist_batch_id);

    IF v_is_protected THEN
      v_protect_reason := CASE
        WHEN l.cost_locked THEN 'Container landed-cost pool changed while batch is cost_locked'
        ELSE 'Pre-cutover historical batch (< 2026-11-27) protected from automatic recalculation'
      END;

      IF ABS(v_new_unit_cost - v_old_unit_cost) >= 0.01 OR ABS(v_new_alloc - COALESCE(l.import_cost_allocated, 0)) >= 0.01 THEN
        INSERT INTO public.pending_batch_cost_adjustments (
          batch_id, import_container_id, source_table,
          previous_unit_cost, proposed_unit_cost,
          previous_landed_cost_allocated, proposed_landed_cost_allocated,
          status, reason
        )
        VALUES (
          l.id, p_container_id, 'import_containers',
          v_old_unit_cost, v_new_unit_cost,
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
           landed_cost_per_unit = v_new_unit_cost,
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

CREATE OR REPLACE FUNCTION public.recalculate_batch_landed_cost(p_batch_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_direct_cost numeric;
  v_b record;
  v_new_unit_cost numeric;
  v_old_unit_cost numeric;
  v_is_protected boolean;
  v_protect_reason text;
  v_approved_hist_batch_id uuid := NULLIF(COALESCE(current_setting('app.approved_historical_batch_id', true), ''), '')::uuid;
BEGIN
  SELECT * INTO v_b FROM public.batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_b.import_container_id IS NOT NULL THEN
    PERFORM public.reallocate_container_costs(v_b.import_container_id);
    RETURN;
  END IF;

  v_direct_cost := ROUND(public.calculate_batch_direct_landed_cost(p_batch_id), 2);
  v_new_unit_cost := ROUND(
    COALESCE(v_b.import_price, 0)
    + COALESCE(v_b.duty_charges, 0)
    + COALESCE(v_b.freight_charges, 0) / NULLIF(v_b.import_quantity, 0)
    + COALESCE(v_b.other_charges, 0) / NULLIF(v_b.import_quantity, 0)
    + v_direct_cost / NULLIF(v_b.import_quantity, 0),
    2
  );
  v_old_unit_cost := ROUND(COALESCE(v_b.landed_cost_per_unit, v_b.cost_per_unit, 0), 2);

  v_is_protected := COALESCE(v_b.cost_locked, false)
    OR (COALESCE(v_b.import_date, v_b.created_at::date) < DATE '2026-11-27' AND v_b.id IS DISTINCT FROM v_approved_hist_batch_id);

  IF v_is_protected THEN
    v_protect_reason := CASE
      WHEN COALESCE(v_b.cost_locked, false) THEN 'Direct batch landed-cost changed while batch is cost_locked'
      ELSE 'Pre-cutover historical batch (< 2026-11-27) protected from automatic recalculation'
    END;

    IF ABS(v_new_unit_cost - v_old_unit_cost) >= 0.01 OR ABS(v_direct_cost - COALESCE(v_b.import_cost_allocated, 0)) >= 0.01 THEN
      INSERT INTO public.pending_batch_cost_adjustments (
        batch_id, import_container_id, source_table,
        previous_unit_cost, proposed_unit_cost,
        previous_landed_cost_allocated, proposed_landed_cost_allocated,
        status, reason
      )
      VALUES (
        p_batch_id, NULL, 'finance_expenses',
        v_old_unit_cost, v_new_unit_cost,
        COALESCE(v_b.import_cost_allocated, 0), v_direct_cost,
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
       WHERE batch_id = p_batch_id
         AND import_container_id IS NULL
         AND status = 'pending';
    END IF;
    RETURN;
  END IF;

  UPDATE public.batches
     SET import_cost_allocated = v_direct_cost,
         final_landed_cost = ROUND((COALESCE(v_b.import_price, 0) + COALESCE(v_b.duty_charges, 0)) * COALESCE(v_b.import_quantity, 0) + COALESCE(v_b.freight_charges, 0) + COALESCE(v_b.other_charges, 0) + v_direct_cost, 2),
         landed_cost_per_unit = v_new_unit_cost,
         cost_per_unit = v_new_unit_cost,
         updated_at = now()
   WHERE id = p_batch_id;

  IF v_new_unit_cost IS DISTINCT FROM v_old_unit_cost THEN
    PERFORM public.propagate_batch_cost_change(p_batch_id);
  END IF;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 6. Controlled Approval Workflow for Locked / Historical Batch Adjustments
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_pending_batch_cost_adjustment(p_adjustment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_adj public.pending_batch_cost_adjustments%ROWTYPE;
  v_b public.batches%ROWTYPE;
  v_was_locked boolean;
BEGIN
  IF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  ELSIF auth.role() = 'authenticated'
    AND NOT public.inventory_v1_actor_allowed(ARRAY['admin', 'accounts']::text[]) THEN
    RAISE EXCEPTION 'Permission denied: only admin or accounts can approve pending batch cost adjustments' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_adj
    FROM public.pending_batch_cost_adjustments
   WHERE id = p_adjustment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pending adjustment not found');
  END IF;

  IF v_adj.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment is already ' || v_adj.status);
  END IF;

  SELECT * INTO v_b FROM public.batches WHERE id = v_adj.batch_id FOR UPDATE;
  v_was_locked := COALESCE(v_b.cost_locked, false);

  PERFORM set_config('app.approved_historical_batch_id', v_adj.batch_id::text, true);
  PERFORM set_config('app.allow_historical_cogs_adjustment', 'on', true);

  IF v_was_locked THEN
    UPDATE public.batches SET cost_locked = false WHERE id = v_adj.batch_id;
  END IF;

  IF v_adj.import_container_id IS NOT NULL THEN
    PERFORM public.reallocate_container_costs(v_adj.import_container_id);
  ELSE
    PERFORM public.recalculate_batch_landed_cost(v_adj.batch_id);
  END IF;

  IF v_was_locked THEN
    UPDATE public.batches SET cost_locked = true, cost_locked_at = now() WHERE id = v_adj.batch_id;
  END IF;

  PERFORM set_config('app.approved_historical_batch_id', '', true);
  PERFORM set_config('app.allow_historical_cogs_adjustment', 'off', true);

  UPDATE public.pending_batch_cost_adjustments
     SET status = 'approved',
         reviewed_at = now(),
         reviewed_by = auth.uid()
   WHERE id = p_adjustment_id;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', p_adjustment_id,
    'batch_id', v_adj.batch_id,
    'previous_unit_cost', v_adj.previous_unit_cost,
    'proposed_unit_cost', v_adj.proposed_unit_cost
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.approved_historical_batch_id', '', true);
  PERFORM set_config('app.allow_historical_cogs_adjustment', 'off', true);
  RAISE;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 7. Change-Filtered Triggers on finance_expenses & petty_cash_transactions
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_recalc_batches_on_expense_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_relevant_change boolean := false;
BEGIN
  IF current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.approval_status <> 'approved' THEN
      RETURN NEW;
    END IF;
    v_relevant_change := (NEW.import_container_id IS NOT NULL OR NEW.batch_id IS NOT NULL);
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.approval_status <> 'approved' THEN
      RETURN OLD;
    END IF;
    v_relevant_change := (OLD.import_container_id IS NOT NULL OR OLD.batch_id IS NOT NULL);
  ELSE
    v_relevant_change := (
      NEW.import_container_id IS DISTINCT FROM OLD.import_container_id
      OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
      OR NEW.expense_category IS DISTINCT FROM OLD.expense_category
      OR NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW.ppn_amount IS DISTINCT FROM OLD.ppn_amount
      OR NEW.stamp_duty_amount IS DISTINCT FROM OLD.stamp_duty_amount
      OR NEW.broker_items IS DISTINCT FROM OLD.broker_items
      OR NEW.pib_bm_amount IS DISTINCT FROM OLD.pib_bm_amount
      OR NEW.include_in_landed_cost IS DISTINCT FROM OLD.include_in_landed_cost
      OR NEW.approval_status IS DISTINCT FROM OLD.approval_status
      OR NEW.expense_date IS DISTINCT FROM OLD.expense_date
    );
  END IF;

  IF NOT v_relevant_change THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.import_container_id IS NOT NULL THEN
    PERFORM public.reallocate_container_costs(NEW.import_container_id);
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.import_container_id IS NOT NULL
     AND (TG_OP = 'DELETE' OR OLD.import_container_id IS DISTINCT FROM NEW.import_container_id) THEN
    PERFORM public.reallocate_container_costs(OLD.import_container_id);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.batch_id IS NOT NULL THEN
    PERFORM public.recalculate_batch_landed_cost(NEW.batch_id);
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.batch_id IS NOT NULL
     AND (TG_OP = 'DELETE' OR OLD.batch_id IS DISTINCT FROM NEW.batch_id) THEN
    PERFORM public.recalculate_batch_landed_cost(OLD.batch_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_recalc_batches_on_petty_cash_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_relevant_change boolean := false;
BEGIN
  IF current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.approval_status <> 'approved' THEN
      RETURN NEW;
    END IF;
    v_relevant_change := (NEW.import_container_id IS NOT NULL);
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.approval_status <> 'approved' THEN
      RETURN OLD;
    END IF;
    v_relevant_change := (OLD.import_container_id IS NOT NULL);
  ELSE
    v_relevant_change := (
      NEW.import_container_id IS DISTINCT FROM OLD.import_container_id
      OR NEW.expense_category IS DISTINCT FROM OLD.expense_category
      OR NEW.transaction_type IS DISTINCT FROM OLD.transaction_type
      OR NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW.include_in_landed_cost IS DISTINCT FROM OLD.include_in_landed_cost
      OR NEW.approval_status IS DISTINCT FROM OLD.approval_status
      OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
      OR NEW.finance_expense_id IS DISTINCT FROM OLD.finance_expense_id
    );
  END IF;

  IF NOT v_relevant_change THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.import_container_id IS NOT NULL THEN
    PERFORM public.reallocate_container_costs(NEW.import_container_id);
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.import_container_id IS NOT NULL
     AND (TG_OP = 'DELETE' OR OLD.import_container_id IS DISTINCT FROM NEW.import_container_id) THEN
    PERFORM public.reallocate_container_costs(OLD.import_container_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- -----------------------------------------------------------------------------
-- 8. Explicit Function Execution Grants
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.approve_pending_batch_cost_adjustment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_pending_batch_cost_adjustment(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.reallocate_container_costs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reallocate_container_costs(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.recalculate_batch_landed_cost(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_batch_landed_cost(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.propagate_batch_cost_change(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propagate_batch_cost_change(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.calculate_container_landed_cost_pool(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_container_landed_cost_pool(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.calculate_batch_direct_landed_cost(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_batch_direct_landed_cost(uuid) TO authenticated, service_role;
