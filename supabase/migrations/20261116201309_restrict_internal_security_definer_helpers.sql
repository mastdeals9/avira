-- Restrict internal SECURITY DEFINER helpers to trusted database/service callers.
-- Their application-facing parent RPCs remain available to authenticated users.

BEGIN;

REVOKE ALL ON FUNCTION public.clear_payment_allocation_rounding_adjustment(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_payment_allocation_rounding_adjustment(uuid, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.clear_receipt_allocation_rounding_adjustment(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_receipt_allocation_rounding_adjustment(uuid, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.create_purchase_invoice_from_po(uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_purchase_invoice_from_po(uuid, jsonb, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_create_import_requirements(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_import_requirements(uuid, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.recalculate_batch_landed_cost(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_batch_landed_cost(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.evaluate_enquiry_task_reminders()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_enquiry_task_reminders()
  TO service_role;

COMMIT;

