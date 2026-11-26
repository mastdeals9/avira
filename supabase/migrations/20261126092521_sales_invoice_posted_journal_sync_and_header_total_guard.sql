-- Reconstructed from production migration 20261126092521 (already applied in production)

BEGIN;

CREATE OR REPLACE FUNCTION public.post_sales_invoice_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_je_id uuid;
  v_je_count integer;
  v_je_posted boolean;
  v_je_reversed boolean;
  v_je_cancelled boolean;
  v_ar_account_id uuid;
  v_revenue_account_id uuid;
  v_tax_account_id uuid;
  v_meterai_account_id uuid;
  v_discount_account_id uuid;
  v_ar_line_id uuid;
  v_revenue_line_id uuid;
  v_line_id uuid;
  v_line_count integer;
  v_line_num integer;
  v_total_debit numeric(18,2);
  v_total_credit numeric(18,2);
  v_discount numeric(18,2);
  v_stamp_duty numeric(18,2);
BEGIN
  IF current_setting('app.sales_invoice_rebuild', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE'
     AND NEW.journal_entry_id IS NULL
     AND OLD.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.document_status='cancelled'
     OR COALESCE(NEW.notes,'') LIKE '[CANCELLED%'
     OR LOWER(COALESCE(NEW.notes,'')) LIKE 'cancelled%' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_draft,false)
     OR NEW.payment_status NOT IN ('pending','partial','paid') THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_ar_account_id FROM public.chart_of_accounts WHERE code='1120' AND is_active=true;
  SELECT id INTO v_revenue_account_id FROM public.chart_of_accounts WHERE code='4100' AND is_active=true;
  SELECT id INTO v_tax_account_id FROM public.chart_of_accounts WHERE code='2130' AND is_active=true;
  SELECT id INTO v_meterai_account_id FROM public.chart_of_accounts WHERE code='6950' AND is_active=true;
  SELECT id INTO v_discount_account_id FROM public.chart_of_accounts WHERE code='4200' AND is_active=true;

  IF v_ar_account_id IS NULL OR v_revenue_account_id IS NULL THEN
    RAISE EXCEPTION 'Required sales invoice accounts 1120 and 4100 are not configured';
  END IF;

  v_stamp_duty := COALESCE(NEW.stamp_duty_amount,0);
  v_discount := COALESCE(NEW.discount_amount,0);

  IF v_stamp_duty>0 AND v_meterai_account_id IS NULL THEN
    RAISE EXCEPTION 'Bea Meterai recovery account 6950 is not configured';
  END IF;
  IF v_discount>0 AND v_discount_account_id IS NULL THEN
    RAISE EXCEPTION 'Sales discount account 4200 is not configured';
  END IF;

  v_je_id := NEW.journal_entry_id;
  IF v_je_id IS NULL THEN
    SELECT id INTO v_je_id
    FROM public.journal_entries
    WHERE source_module='sales_invoice' AND reference_id=NEW.id
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF v_je_id IS NOT NULL THEN
    SELECT COUNT(*),
           BOOL_OR(is_posted),
           BOOL_OR(COALESCE(is_reversed,false)),
           BOOL_OR(COALESCE(is_cancelled,false))
    INTO v_je_count,v_je_posted,v_je_reversed,v_je_cancelled
    FROM public.journal_entries
    WHERE id=v_je_id AND source_module='sales_invoice' AND reference_id=NEW.id;

    IF v_je_count<>1 THEN
      RAISE EXCEPTION 'Invoice % has a linked journal that does not match its source reference',
        NEW.invoice_number;
    END IF;
    IF NOT COALESCE(v_je_posted,false)
       OR COALESCE(v_je_reversed,false)
       OR COALESCE(v_je_cancelled,false) THEN
      RAISE EXCEPTION 'Invoice % cannot be edited because its linked sales journal is not active',
        NEW.invoice_number;
    END IF;

    PERFORM 1 FROM public.journal_entries WHERE id=v_je_id FOR UPDATE;

    SELECT COUNT(*),(array_agg(jel.id ORDER BY jel.line_number))[1]
    INTO v_line_count,v_ar_line_id
    FROM public.journal_entry_lines jel
    WHERE jel.journal_entry_id=v_je_id AND jel.account_id=v_ar_account_id;
    IF v_line_count<>1 THEN
      RAISE EXCEPTION 'Invoice % must have exactly one A/R 1120 line; found %',
        NEW.invoice_number,v_line_count;
    END IF;

    SELECT COUNT(*),(array_agg(jel.id ORDER BY jel.line_number))[1]
    INTO v_line_count,v_revenue_line_id
    FROM public.journal_entry_lines jel
    JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
    WHERE jel.journal_entry_id=v_je_id AND coa.code IN ('4100','4110');
    IF v_line_count<>1 THEN
      RAISE EXCEPTION 'Invoice % must have exactly one Sales Revenue line; found %',
        NEW.invoice_number,v_line_count;
    END IF;

    UPDATE public.journal_entry_lines
    SET debit=NEW.total_amount,credit=0,customer_id=NEW.customer_id,
        description='A/R - '||NEW.invoice_number
    WHERE id=v_ar_line_id;

    UPDATE public.journal_entry_lines
    SET debit=0,credit=NEW.subtotal,customer_id=NEW.customer_id,
        description='Sales - '||NEW.invoice_number
    WHERE id=v_revenue_line_id;

    SELECT COUNT(*),(array_agg(id ORDER BY line_number))[1]
    INTO v_line_count,v_line_id
    FROM public.journal_entry_lines
    WHERE journal_entry_id=v_je_id AND account_id=v_tax_account_id;

    IF COALESCE(NEW.tax_amount,0)>0 THEN
      IF v_tax_account_id IS NULL THEN RAISE EXCEPTION 'Output VAT account 2130 is missing'; END IF;
      IF v_line_count>1 THEN RAISE EXCEPTION 'Invoice % has multiple 2130 lines',NEW.invoice_number; END IF;
      IF v_line_count=1 THEN
        UPDATE public.journal_entry_lines
        SET debit=0,credit=NEW.tax_amount,customer_id=NEW.customer_id,
            description='PPN - '||NEW.invoice_number
        WHERE id=v_line_id;
      ELSE
        SELECT COALESCE(MAX(line_number),0)+1 INTO v_line_num
        FROM public.journal_entry_lines WHERE journal_entry_id=v_je_id;
        INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,customer_id)
        VALUES(v_je_id,v_line_num,v_tax_account_id,'PPN - '||NEW.invoice_number,0,NEW.tax_amount,NEW.customer_id);
      END IF;
    ELSE
      DELETE FROM public.journal_entry_lines
      WHERE journal_entry_id=v_je_id AND account_id=v_tax_account_id;
    END IF;

    SELECT COUNT(*),(array_agg(id ORDER BY line_number))[1]
    INTO v_line_count,v_line_id
    FROM public.journal_entry_lines
    WHERE journal_entry_id=v_je_id AND account_id=v_meterai_account_id;

    IF v_stamp_duty>0 THEN
      IF v_line_count>1 THEN RAISE EXCEPTION 'Invoice % has multiple 6950 lines',NEW.invoice_number; END IF;
      IF v_line_count=1 THEN
        UPDATE public.journal_entry_lines
        SET debit=0,credit=v_stamp_duty,customer_id=NEW.customer_id,
            description='Bea Meterai (cost recovery) - '||NEW.invoice_number
        WHERE id=v_line_id;
      ELSE
        SELECT COALESCE(MAX(line_number),0)+1 INTO v_line_num
        FROM public.journal_entry_lines WHERE journal_entry_id=v_je_id;
        INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,customer_id)
        VALUES(v_je_id,v_line_num,v_meterai_account_id,'Bea Meterai (cost recovery) - '||NEW.invoice_number,0,v_stamp_duty,NEW.customer_id);
      END IF;
    ELSE
      DELETE FROM public.journal_entry_lines
      WHERE journal_entry_id=v_je_id AND account_id=v_meterai_account_id;
    END IF;

    SELECT COUNT(*),(array_agg(id ORDER BY line_number))[1]
    INTO v_line_count,v_line_id
    FROM public.journal_entry_lines
    WHERE journal_entry_id=v_je_id AND account_id=v_discount_account_id;

    IF v_discount>0 THEN
      IF v_line_count>1 THEN RAISE EXCEPTION 'Invoice % has multiple 4200 discount lines',NEW.invoice_number; END IF;
      IF v_line_count=1 THEN
        UPDATE public.journal_entry_lines
        SET debit=v_discount,credit=0,customer_id=NEW.customer_id,
            description='Sales Discount - '||NEW.invoice_number
        WHERE id=v_line_id;
      ELSE
        SELECT COALESCE(MAX(line_number),0)+1 INTO v_line_num
        FROM public.journal_entry_lines WHERE journal_entry_id=v_je_id;
        INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,customer_id)
        VALUES(v_je_id,v_line_num,v_discount_account_id,'Sales Discount - '||NEW.invoice_number,v_discount,0,NEW.customer_id);
      END IF;
    ELSE
      DELETE FROM public.journal_entry_lines
      WHERE journal_entry_id=v_je_id AND account_id=v_discount_account_id;
    END IF;

    NEW.journal_entry_id := v_je_id;
    RETURN NEW;
  END IF;

  v_total_debit := COALESCE(NEW.total_amount,0)+v_discount;
  v_total_credit := COALESCE(NEW.subtotal,0)+COALESCE(NEW.tax_amount,0)+v_stamp_duty;

  IF ABS(v_total_debit-v_total_credit)>0.01 THEN
    RAISE EXCEPTION 'Sales invoice journal not balanced: debit %, credit %',
      v_total_debit,v_total_credit;
  END IF;

  INSERT INTO public.journal_entries(
    entry_number,entry_date,source_module,reference_id,reference_number,
    description,total_debit,total_credit,is_posted,posted_by,created_by
  ) VALUES (
    public.next_journal_entry_number(),NEW.invoice_date,'sales_invoice',NEW.id,NEW.invoice_number,
    'Sales Invoice: '||NEW.invoice_number,v_total_debit,v_total_credit,true,NEW.created_by,NEW.created_by
  ) RETURNING id INTO v_je_id;

  v_line_num:=1;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,customer_id)
  VALUES(v_je_id,v_line_num,v_ar_account_id,'A/R - '||NEW.invoice_number,NEW.total_amount,0,NEW.customer_id);
  v_line_num:=v_line_num+1;

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,customer_id)
  VALUES(v_je_id,v_line_num,v_revenue_account_id,'Sales - '||NEW.invoice_number,0,NEW.subtotal,NEW.customer_id);
  v_line_num:=v_line_num+1;

  IF COALESCE(NEW.tax_amount,0)>0 THEN
    IF v_tax_account_id IS NULL THEN RAISE EXCEPTION 'Output VAT account 2130 is missing'; END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,customer_id)
    VALUES(v_je_id,v_line_num,v_tax_account_id,'PPN - '||NEW.invoice_number,0,NEW.tax_amount,NEW.customer_id);
    v_line_num:=v_line_num+1;
  END IF;

  IF v_stamp_duty>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,customer_id)
    VALUES(v_je_id,v_line_num,v_meterai_account_id,'Bea Meterai (cost recovery) - '||NEW.invoice_number,0,v_stamp_duty,NEW.customer_id);
    v_line_num:=v_line_num+1;
  END IF;

  IF v_discount>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,customer_id)
    VALUES(v_je_id,v_line_num,v_discount_account_id,'Sales Discount - '||NEW.invoice_number,v_discount,0,NEW.customer_id);
  END IF;

  NEW.journal_entry_id:=v_je_id;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'post_sales_invoice_journal failed for invoice %: %',NEW.id,SQLERRM;
  RAISE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.derive_journal_header_totals_from_lines()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  SELECT COALESCE(SUM(jel.debit),0),COALESCE(SUM(jel.credit),0)
  INTO NEW.total_debit,NEW.total_credit
  FROM public.journal_entry_lines jel
  WHERE jel.journal_entry_id=NEW.id;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_derive_journal_header_totals_from_lines ON public.journal_entries;
CREATE TRIGGER trg_derive_journal_header_totals_from_lines
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.derive_journal_header_totals_from_lines();

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261126092521', 'sales_invoice_posted_journal_sync_and_header_total_guard')
ON CONFLICT (version) DO NOTHING;

COMMIT;
