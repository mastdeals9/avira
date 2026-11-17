-- Add explicit caller authorization to two SECURITY DEFINER RPCs
-- invoked directly by authenticated application users. Keep authenticated
-- EXECUTE because the UI uses these RPCs; enforce module roles in-function.

BEGIN;

DO $migration$
DECLARE
  v_definition text;
  v_begin_pos integer;
  v_guard text;
BEGIN
  v_definition := pg_get_functiondef(
    'public.propagate_bank_line_amount_edit(uuid,numeric)'::regprocedure
  );

  IF position('SECURITY GUARD: finance role required' IN v_definition) = 0 THEN
    v_begin_pos := strpos(v_definition, 'BEGIN');
    IF v_begin_pos = 0 THEN
      RAISE EXCEPTION 'Could not locate function body for propagate_bank_line_amount_edit';
    END IF;

    v_guard := E'\n  -- SECURITY GUARD: finance role required\n'
      || E'  IF auth.role() = ''anon'' THEN\n'
      || E'    RAISE EXCEPTION ''Not authenticated'' USING ERRCODE = ''42501'';\n'
      || E'  ELSIF auth.role() = ''authenticated'' THEN\n'
      || E'    PERFORM public._sec_check_finance_role();\n'
      || E'  END IF;\n';

    v_definition := overlay(
      v_definition PLACING v_guard
      FROM v_begin_pos + length('BEGIN') FOR 0
    );
    EXECUTE v_definition;
  END IF;

  v_definition := pg_get_functiondef(
    'public.reallocate_container_costs(uuid)'::regprocedure
  );

  IF position('SECURITY GUARD: inventory role required' IN v_definition) = 0 THEN
    v_begin_pos := strpos(v_definition, 'BEGIN');
    IF v_begin_pos = 0 THEN
      RAISE EXCEPTION 'Could not locate function body for reallocate_container_costs';
    END IF;

    v_guard := E'\n  -- SECURITY GUARD: inventory role required\n'
      || E'  IF auth.role() = ''anon'' THEN\n'
      || E'    RAISE EXCEPTION ''Not authenticated'' USING ERRCODE = ''42501'';\n'
      || E'  ELSIF auth.role() = ''authenticated''\n'
      || E'    AND NOT public.inventory_v1_actor_allowed(ARRAY[''admin'', ''accounts'', ''warehouse'']::text[]) THEN\n'
      || E'    RAISE EXCEPTION ''Permission denied: role cannot reallocate container costs'' USING ERRCODE = ''42501'';\n'
      || E'  END IF;\n';

    v_definition := overlay(
      v_definition PLACING v_guard
      FROM v_begin_pos + length('BEGIN') FOR 0
    );
    EXECUTE v_definition;
  END IF;
END;
$migration$;

COMMIT;

