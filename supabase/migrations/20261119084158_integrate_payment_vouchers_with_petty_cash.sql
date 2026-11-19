-- Migration: 20261119084158_integrate_payment_vouchers_with_petty_cash.sql
-- Description: Deep integration of Payment Vouchers with Petty Cash:
-- 1. Adds petty_cash_book_id to payment_vouchers
-- 2. Adds payment_voucher_id and petty_cash_book_id to petty_cash_transactions with unique partial index
-- 3. Upgrades validate_expense_category_assignment to bypass mandatory category for payment voucher disbursements (e.g. salary advance)
-- 4. Upgrades post_petty_cash_to_journal_fixed to prevent duplicate journals for payment vouchers
-- 5. Upgrades save_payment_voucher_command to store and validate active petty_cash_book_id
-- 6. Upgrades post_payment_voucher to create linked petty cash transaction and deduct from book balance
-- 7. Upgrades cancel_payment_voucher_posting to restore book balance and clean up linked petty cash transaction
BEGIN;
-- 1. Schema Extensions
ALTER TABLE public.payment_vouchers
ADD COLUMN IF NOT EXISTS petty_cash_book_id uuid REFERENCES public.petty_cash_books(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_payment_vouchers_petty_cash_book
ON public.payment_vouchers(petty_cash_book_id)
WHERE petty_cash_book_id IS NOT NULL;
ALTER TABLE public.petty_cash_transactions
ADD COLUMN IF NOT EXISTS payment_voucher_id uuid REFERENCES public.payment_vouchers(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS petty_cash_book_id uuid REFERENCES public.petty_cash_books(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pct_payment_voucher_id
ON public.petty_cash_transactions(payment_voucher_id)
WHERE payment_voucher_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pct_petty_cash_book_id
ON public.petty_cash_transactions(petty_cash_book_id)
WHERE petty_cash_book_id IS NOT NULL;
-- 2. Upgrade validate_expense_category_assignment
CREATE OR REPLACE FUNCTION public.validate_expense_category_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_category public.expense_categories%ROWTYPE;
BEGIN
-- A petty cash withdrawal is a cash replenishment/transfer, not an expense.
-- Disbursements linked to payment vouchers (e.g. salary advances, AP payments) have their own GL routing and are not expense categories.
IF TG_TABLE_NAME = 'petty_cash_transactions' AND (
NEW.payment_voucher_id IS NOT NULL
OR (to_jsonb(NEW) ->> 'transaction_type') = 'withdraw'
OR (NEW.expense_category IS NULL AND NEW.description ILIKE '%advance%')
) THEN
RETURN NEW;
END IF;
IF TG_OP = 'UPDATE'
AND OLD.expense_category = 'utilities'
AND NEW.expense_category = 'utilities' THEN
RETURN NEW;
END IF;
IF NULLIF(btrim(NEW.expense_category), '') IS NULL THEN
RAISE EXCEPTION 'Expense category is required.' USING ERRCODE = '23514';
END IF;
SELECT * INTO v_category
FROM public.expense_categories
WHERE category_key = NEW.expense_category;
IF NOT FOUND THEN
RAISE EXCEPTION 'Expense category "%" does not exist in Expense Category Master.',
NEW.expense_category USING ERRCODE = '23514';
END IF;
RETURN NEW;
END;
$function$;
-- 3. Upgrade post_petty_cash_to_journal_fixed to avoid duplicate journals
CREATE OR REPLACE FUNCTION public.post_petty_cash_to_journal_fixed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
v_journal_id         uuid;
v_petty_cash_account uuid;
v_counter_account    uuid;
v_expense_account    uuid;
v_je_number          text;
BEGIN
-- If linked to fund transfer or payment voucher, the originating module manages the balanced journal entry.
IF NEW.fund_transfer_id IS NOT NULL OR NEW.payment_voucher_id IS NOT NULL THEN
RETURN NEW;
END IF;
SELECT id
INTO v_journal_id
FROM public.journal_entries
WHERE source_module = 'petty_cash'
AND reference_id = NEW.id
LIMIT 1;
IF v_journal_id IS NOT NULL THEN
RETURN NEW;
END IF;
SELECT id
INTO v_petty_cash_account
FROM public.chart_of_accounts
WHERE code = '1102'
AND is_header = false
AND is_active = true
LIMIT 1;
IF v_petty_cash_account IS NULL THEN
RAISE EXCEPTION 'Cannot post petty cash %: active Petty Cash posting account is missing', NEW.id;
END IF;
PERFORM pg_advisory_xact_lock(
hashtext('pc_je_number_' || to_char(NEW.transaction_date, 'YYYYMMDD'))
);
SELECT 'JE-' || to_char(NEW.transaction_date, 'YYYYMMDD') || '-' ||
lpad((COALESCE(MAX((substring(entry_number FROM '[0-9]+$'))::integer), 0) + 1)::text, 4, '0')
INTO v_je_number
FROM public.journal_entries
WHERE entry_date = NEW.transaction_date
AND entry_number LIKE 'JE-' || to_char(NEW.transaction_date, 'YYYYMMDD') || '-%';
INSERT INTO public.journal_entries (
entry_number, entry_date, source_module, reference_id, reference_number,
description, total_debit, total_credit, is_posted, created_by, posted_at
) VALUES (
v_je_number, NEW.transaction_date, 'petty_cash', NEW.id, NEW.transaction_number,
'Petty cash ' || NEW.transaction_type || ': ' || NEW.description,
NEW.amount, NEW.amount, true, NEW.created_by, now()
) RETURNING id INTO v_journal_id;
IF NEW.transaction_type = 'withdraw' THEN
IF NEW.bank_account_id IS NOT NULL THEN
SELECT coa_id
INTO v_counter_account
FROM public.bank_accounts
WHERE id = NEW.bank_account_id;
ELSE
v_counter_account := NEW.source_account_id;
END IF;
IF v_counter_account IS NULL THEN
RAISE EXCEPTION 'Cannot post petty cash inflow %: select a bank or offset GL account', NEW.id;
END IF;
IF v_counter_account = v_petty_cash_account THEN
RAISE EXCEPTION 'Cannot post petty cash inflow %: offset account cannot be the Petty Cash posting account', NEW.id;
END IF;
INSERT INTO public.journal_entry_lines (
journal_entry_id, line_number, account_id, debit, credit, description
) VALUES
(v_journal_id, 1, v_petty_cash_account, NEW.amount, 0, 'Cash received into petty cash'),
(v_journal_id, 2, v_counter_account, 0, NEW.amount, COALESCE(NULLIF(NEW.source, ''), 'Petty cash inflow source'));
ELSIF NEW.transaction_type = 'expense' THEN
v_expense_account := public.get_expense_account_id(NEW.expense_category);
IF v_expense_account IS NULL THEN
RAISE EXCEPTION 'Cannot post petty cash expense %: no configured account for category %', NEW.id, NEW.expense_category;
END IF;
INSERT INTO public.journal_entry_lines (
journal_entry_id, line_number, account_id, debit, credit, description
) VALUES
(v_journal_id, 1, v_expense_account, NEW.amount, 0, COALESCE(NEW.expense_category, 'General expense')),
(v_journal_id, 2, v_petty_cash_account, 0, NEW.amount, 'Cash expense');
ELSE
RAISE EXCEPTION 'Unsupported petty cash transaction type: %', NEW.transaction_type;
END IF;
IF NEW.bank_statement_line_id IS NOT NULL THEN
UPDATE public.bank_statement_lines
SET matched_petty_cash_id = NEW.id,
matched_entry_id = v_journal_id,
reconciliation_status = 'matched',
matched_at = now(),
matched_by = COALESCE(NEW.approved_by, NEW.created_by),
manually_unlinked = false,
notes = 'Linked to Petty Cash ' || NEW.transaction_number
WHERE id = NEW.bank_statement_line_id
AND bank_account_id = NEW.bank_account_id;
END IF;
RETURN NEW;
END;
$function$;
-- 4. Upgrade save_payment_voucher_command to store and validate active petty_cash_book_id
CREATE OR REPLACE FUNCTION public.save_payment_voucher_command(
p_voucher_id uuid DEFAULT NULL::uuid,
p_payload jsonb DEFAULT '{}'::jsonb,
p_allocations jsonb DEFAULT '[]'::jsonb,
p_payment_purpose text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_number text;
v_id uuid;
v_date date := (p_payload->>'voucher_date')::date;
v_payment_currency text := upper(COALESCE(NULLIF(p_payload->>'payment_currency',''),'IDR'));
v_invoice_currency text := upper(COALESCE(
NULLIF(p_payload->>'invoice_currency',''),
NULLIF((SELECT COALESCE(a->>'currency',a->>'allocated_currency')
FROM jsonb_array_elements(COALESCE(p_allocations,'[]'::jsonb)) a
WHERE COALESCE(a->>'currency',a->>'allocated_currency') IS NOT NULL LIMIT 1),''),
v_payment_currency));
v_bank_currency text;
v_rate numeric := COALESCE(NULLIF(p_payload->>'exchange_rate','')::numeric,1);
v_invoice_amount numeric := COALESCE(NULLIF(p_payload->>'invoice_amount','')::numeric,
NULLIF(p_payload->>'amount','')::numeric,0);
v_payment_amount numeric := COALESCE(NULLIF(p_payload->>'payment_amount','')::numeric,
v_invoice_amount-COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0));
v_converted numeric;
v_actual numeric;
v_bank_charge numeric := COALESCE(NULLIF(p_payload->>'bank_charge','')::numeric,0);
v_docs text[];
v_purpose text := COALESCE(p_payment_purpose, NULLIF(p_payload->>'payment_purpose',''), 'general');
v_staff_id uuid := NULLIF(p_payload->>'staff_id','')::uuid;
v_customer_id uuid := NULLIF(p_payload->>'customer_id','')::uuid;
v_supplier_id uuid := NULLIF(p_payload->>'supplier_id','')::uuid;
v_party_type text := lower(COALESCE(
NULLIF(p_payload->>'party_type',''),
CASE
WHEN v_staff_id IS NOT NULL OR v_purpose LIKE 'salary_%' OR v_purpose LIKE '%employee%' THEN 'employee'
WHEN v_customer_id IS NOT NULL OR v_purpose LIKE 'customer_%' THEN 'customer'
ELSE 'supplier'
END
));
v_settle_against text := COALESCE(NULLIF(p_payload->>'settlement_against',''), 'outstanding_balance');
v_settle_disc numeric := COALESCE(NULLIF(p_payload->>'settlement_discount','')::numeric, 0);
v_adj_reason text := NULLIF(p_payload->>'adjustment_reason','');
v_adj_account_id uuid := NULLIF(p_payload->>'adjustment_account_id','')::uuid;
v_adj_notes text := NULLIF(p_payload->>'adjustment_notes','');
v_petty_cash_book_id uuid := NULLIF(p_payload->>'petty_cash_book_id','')::uuid;
v_method text := COALESCE(NULLIF(p_payload->>'payment_method',''), 'bank_transfer');
v_cash_source text := NULLIF(p_payload->>'cash_source','');
BEGIN
PERFORM public._sec_check_finance_role();
SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts
WHERE id=NULLIF(p_payload->>'bank_account_id','')::uuid;
v_bank_currency:=COALESCE(v_bank_currency,v_payment_currency);
IF v_payment_currency NOT IN('IDR','USD') OR v_invoice_currency NOT IN('IDR','USD')
OR v_bank_currency NOT IN('IDR','USD') OR v_rate<=0 THEN
RAISE EXCEPTION 'Payment currencies or exchange rate are invalid';
END IF;
v_converted:=COALESCE(NULLIF(p_payload->>'converted_amount','')::numeric,
v_payment_amount*CASE WHEN v_invoice_currency=v_bank_currency THEN 1 ELSE v_rate END);
v_actual:=COALESCE(NULLIF(p_payload->>'actual_bank_debit','')::numeric,
NULLIF(p_payload->>'bank_amount','')::numeric,v_converted+v_bank_charge);
IF v_actual<=0 AND v_invoice_amount>0 THEN RAISE EXCEPTION 'Actual bank debit must be positive'; END IF;
SELECT COALESCE(array_agg(value),ARRAY[]::text[]) INTO v_docs
FROM jsonb_array_elements_text(COALESCE(p_payload->'document_urls','[]'::jsonb));
-- Validate Petty Cash Book when source is petty cash
IF v_method IN ('cash', 'petty_cash') AND (v_method = 'petty_cash' OR v_cash_source = 'petty_cash' OR v_petty_cash_book_id IS NOT NULL) THEN
IF v_petty_cash_book_id IS NULL THEN
SELECT id INTO v_petty_cash_book_id
FROM public.petty_cash_books
WHERE is_active = true
ORDER BY created_at ASC
LIMIT 1;
IF v_petty_cash_book_id IS NULL THEN
RAISE EXCEPTION 'Please select an active petty cash book/fund.';
END IF;
END IF;
IF NOT EXISTS (SELECT 1 FROM public.petty_cash_books WHERE id = v_petty_cash_book_id AND is_active = true) THEN
RAISE EXCEPTION 'Selected petty cash book is inactive or not found';
END IF;
ELSE
v_petty_cash_book_id := NULL;
END IF;
SELECT voucher_number INTO v_number FROM public.payment_vouchers WHERE id=p_voucher_id;
v_number:=COALESCE(v_number,public.next_payment_voucher_number(v_date));
v_id:=public.save_payment_voucher_with_allocations(
p_voucher_id=>p_voucher_id,
p_voucher_number=>v_number,
p_voucher_date=>v_date,
p_supplier_id=>v_supplier_id,
p_payment_method=>v_method,
p_bank_account_id=>NULLIF(p_payload->>'bank_account_id','')::uuid,
p_reference_number=>NULLIF(p_payload->>'reference_number',''),
p_amount=>v_invoice_amount,
p_pph_amount=>COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
p_pph_code_id=>NULLIF(p_payload->>'pph_code_id','')::uuid,
p_description=>NULLIF(p_payload->>'description',''),
p_payment_currency=>v_payment_currency,
p_exchange_rate=>v_rate,
p_bank_amount=>v_actual,
p_bank_charge=>v_bank_charge,
p_created_by=>COALESCE(NULLIF(p_payload->>'created_by','')::uuid,auth.uid()),
p_allocations=>p_allocations,
p_staff_id=>v_staff_id,
p_payment_purpose=>v_purpose,
p_party_type=>v_party_type,
p_customer_id=>v_customer_id,
p_settlement_against=>v_settle_against,
p_settlement_discount=>v_settle_disc,
p_adjustment_reason=>v_adj_reason,
p_adjustment_account_id=>v_adj_account_id,
p_adjustment_notes=>v_adj_notes
);
UPDATE public.payment_vouchers SET
invoice_currency=v_invoice_currency,
invoice_amount=v_invoice_amount,
payment_amount=v_payment_amount,
payment_currency=v_payment_currency,
transaction_currency=v_invoice_currency,
functional_currency='IDR',
exchange_rate=v_rate,
bank_currency=v_bank_currency,
bank_account_currency=v_bank_currency,
converted_amount=v_converted,
actual_bank_debit=v_actual,
bank_amount=v_actual,
document_urls=NULLIF(v_docs,ARRAY[]::text[]),
petty_cash_book_id=v_petty_cash_book_id
WHERE id=v_id;
RETURN jsonb_build_object('id',v_id,'voucher_number',v_number);
END;
$function$;
-- 5. Comprehensive post_payment_voucher upgrade with Petty Cash integration
CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_pv                      RECORD;
v_je_id                   UUID;
v_je_number               TEXT;
v_actual_poster           UUID;
v_bank_coa                UUID;
v_bank_active             BOOLEAN;
v_bank_is_header          BOOLEAN;
v_debit_coa               UUID;
v_fx_loss_coa             UUID;
v_fx_gain_coa             UUID;
v_rate                    NUMERIC := 1;
v_actual                  NUMERIC;
v_gross                   NUMERIC;
v_charge_amt              NUMERIC := 0;
v_settle_diff             NUMERIC := 0;
v_bank_currency           TEXT := 'IDR';
v_party_type              TEXT;
v_usd_bank_carrying_rate  NUMERIC := 1;
v_ap_carrying_functional  NUMERIC := 0;
v_ap_relief_functional    NUMERIC := 0;
v_realized_fx             NUMERIC := 0;
v_line                    INTEGER := 1;
v_total_debit             NUMERIC := 0;
v_total_credit            NUMERIC := 0;
v_book_id                 UUID;
v_pct                     RECORD;
v_payee_name              TEXT;
BEGIN
PERFORM public._sec_check_finance_role();
v_actual_poster := COALESCE(p_posted_by, auth.uid());
IF v_actual_poster IS NULL THEN
IF current_user = 'service_role' OR session_user = 'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
v_actual_poster := 'a0000000-0000-0000-0000-000000000001'::uuid;
ELSE
RAISE EXCEPTION 'Not authenticated';
END IF;
END IF;
SELECT * INTO v_pv FROM public.payment_vouchers WHERE id = p_pv_id FOR UPDATE;
IF NOT FOUND THEN
RAISE EXCEPTION 'Payment voucher % not found', p_pv_id;
END IF;
IF v_pv.is_posted THEN
RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number;
END IF;
v_party_type := lower(COALESCE(
v_pv.party_type,
CASE
WHEN v_pv.staff_id IS NOT NULL OR v_pv.payment_purpose LIKE 'salary_%' OR v_pv.payment_purpose LIKE '%employee%' THEN 'employee'
WHEN v_pv.customer_id IS NOT NULL OR v_pv.payment_purpose LIKE 'customer_%' THEN 'customer'
ELSE 'supplier'
END
));
IF v_pv.payment_purpose = 'salary_advance' THEN
v_party_type := 'employee';
END IF;
v_gross := COALESCE(v_pv.amount, 0);
v_charge_amt := COALESCE(v_pv.bank_charge, 0);
v_settle_diff := COALESCE(v_pv.settlement_discount, 0);
v_actual := COALESCE(v_pv.actual_bank_debit, v_pv.bank_amount, v_gross + v_charge_amt);
v_rate := COALESCE(NULLIF(v_pv.exchange_rate, 0), 1);
v_bank_currency := COALESCE(v_pv.currency_code, v_pv.transaction_currency, 'IDR');
-- Resolve Bank / Credit Account
IF v_pv.payment_method IN ('bank_transfer', 'check', 'giro') THEN
IF v_pv.bank_account_id IS NULL THEN
RAISE EXCEPTION 'Bank account selection is mandatory for % payments (voucher %)', v_pv.payment_method, v_pv.voucher_number;
END IF;
SELECT ba.coa_id, ba.is_active, coa.is_header, upper(ba.currency)
INTO v_bank_coa, v_bank_active, v_bank_is_header, v_bank_currency
FROM public.bank_accounts ba
LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
WHERE ba.id = v_pv.bank_account_id;
IF v_bank_coa IS NULL THEN
RAISE EXCEPTION 'Bank account % has no linked Chart of Accounts', v_pv.bank_account_id;
END IF;
IF NOT COALESCE(v_bank_active, false) THEN
RAISE EXCEPTION 'Linked bank GL account % is inactive', v_bank_coa;
END IF;
IF COALESCE(v_bank_is_header, false) THEN
RAISE EXCEPTION 'Linked bank GL account % is a header account — leaf required', v_bank_coa;
END IF;
IF v_bank_currency = 'USD' THEN
SELECT
CASE
WHEN NULLIF(SUM(jel.transaction_debit - jel.transaction_credit), 0) IS NOT NULL AND SUM(jel.transaction_debit - jel.transaction_credit) > 0 THEN
round(SUM(jel.debit - jel.credit) / SUM(jel.transaction_debit - jel.transaction_credit), 4)
ELSE
COALESCE(
(SELECT frl.revalued_rate
FROM public.fx_revaluation_lines frl
JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
WHERE frl.bank_account_id = v_pv.bank_account_id
AND fr.status = 'posted'
AND fr.revaluation_date <= v_pv.voucher_date
ORDER BY fr.revaluation_date DESC, fr.created_at DESC
LIMIT 1),
v_rate
)
END
INTO v_usd_bank_carrying_rate
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE jel.account_id = v_bank_coa
AND je.is_posted = true
AND NOT COALESCE(je.is_reversed, false)
AND je.entry_date <= v_pv.voucher_date;
v_usd_bank_carrying_rate := COALESCE(v_usd_bank_carrying_rate, v_rate);
END IF;
ELSIF v_pv.payment_method = 'advance_adjustment' THEN
SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
FROM public.chart_of_accounts
WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;
IF v_bank_coa IS NULL THEN
RAISE EXCEPTION 'Staff Advances account (1160) missing or inactive';
END IF;
ELSIF v_pv.payment_method IN ('cash', 'petty_cash') THEN
-- Route Petty Cash (1102) vs Cash on Hand (1101)
IF v_pv.payment_method = 'petty_cash'
OR v_pv.petty_cash_book_id IS NOT NULL
OR (v_pv.coa_account_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE id = v_pv.coa_account_id AND code = '1102'))
OR v_pv.description ILIKE '%petty cash%' THEN
IF NOT EXISTS (SELECT 1 FROM public.petty_cash_books WHERE is_active = true) THEN
RAISE EXCEPTION 'Cannot post petty cash payment: no active petty cash book found';
END IF;
-- Resolve and validate petty_cash_book_id
IF v_pv.petty_cash_book_id IS NOT NULL THEN
SELECT id INTO v_book_id
FROM public.petty_cash_books
WHERE id = v_pv.petty_cash_book_id AND is_active = true;
IF v_book_id IS NULL THEN
RAISE EXCEPTION 'Selected petty cash book is inactive or not found';
END IF;
ELSE
SELECT id INTO v_book_id
FROM public.petty_cash_books
WHERE is_active = true
ORDER BY created_at ASC
LIMIT 1;
UPDATE public.payment_vouchers
SET petty_cash_book_id = v_book_id
WHERE id = p_pv_id;
END IF;
SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
FROM public.chart_of_accounts
WHERE code = '1102' AND is_header = false AND is_active = true LIMIT 1;
ELSE
SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
FROM public.chart_of_accounts
WHERE code = '1101' AND is_active = true AND is_header = false LIMIT 1;
END IF;
IF v_bank_coa IS NULL THEN
IF v_pv.payment_method = 'cash' THEN
RAISE EXCEPTION 'Cash on Hand (GL 1101) is currently inactive in Chart of Accounts. Use active Petty Cash (GL 1102) instead.';
ELSE
RAISE EXCEPTION 'No active postable Cash/Petty Cash GL account found (GL 1101/1102)';
END IF;
END IF;
ELSE
RAISE EXCEPTION 'Unsupported payment method: % for payment voucher %', v_pv.payment_method, v_pv.voucher_number;
END IF;
-- Resolve Standard Chart of Accounts
SELECT id INTO v_fx_loss_coa FROM public.chart_of_accounts WHERE code = '7300' AND is_active = true LIMIT 1;
SELECT id INTO v_fx_gain_coa FROM public.chart_of_accounts WHERE code = '4930' AND is_active = true LIMIT 1;
-- Resolve Debit Control Account
-- coa_account_id cannot be used simultaneously as the cash credit account and supplier liability debit account
IF v_party_type = 'supplier' THEN
IF v_pv.payment_purpose = 'supplier_advance' OR v_pv.settlement_against = 'advance' THEN
IF v_pv.coa_account_id IS NOT NULL
AND v_pv.coa_account_id IS DISTINCT FROM v_bank_coa
AND NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE id = v_pv.coa_account_id AND code IN ('1101', '1102', '111101')) THEN
v_debit_coa := v_pv.coa_account_id;
ELSE
SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1170' AND is_active = true AND is_header = false LIMIT 1;
END IF;
ELSE
IF v_pv.coa_account_id IS NOT NULL
AND v_pv.coa_account_id IS DISTINCT FROM v_bank_coa
AND NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE id = v_pv.coa_account_id AND code IN ('1101', '1102', '111101')) THEN
v_debit_coa := v_pv.coa_account_id;
ELSE
SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
END IF;
END IF;
-- Compute Carrying Value vs Settlement Value
SELECT
COALESCE(SUM(va.allocated_amount), 0),
COALESCE(SUM(va.allocated_amount * COALESCE(
(SELECT frl.revalued_rate
FROM public.fx_revaluation_lines frl
JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
WHERE frl.purchase_invoice_id = va.purchase_invoice_id
AND fr.status = 'posted'
AND fr.revaluation_date <= v_pv.voucher_date
ORDER BY fr.revaluation_date DESC, fr.created_at DESC
LIMIT 1),
pi.exchange_rate,
1
)), 0)
INTO v_ap_relief_functional, v_ap_carrying_functional
FROM public.voucher_allocations va
JOIN public.purchase_invoices pi ON pi.id = va.purchase_invoice_id
WHERE va.payment_voucher_id = v_pv.id;
IF v_ap_carrying_functional = 0 THEN
v_ap_carrying_functional := v_gross * v_rate;
END IF;
-- Compute Realized FX
IF v_bank_currency = 'USD' THEN
v_realized_fx := round(v_ap_carrying_functional - (v_actual * v_usd_bank_carrying_rate), 2);
ELSE
v_realized_fx := round(v_ap_carrying_functional - (v_gross * v_rate), 2);
END IF;
ELSIF v_party_type = 'customer' THEN
SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1130' AND is_active = true AND is_header = false LIMIT 1;
v_ap_carrying_functional := v_gross * v_rate;
v_realized_fx := 0;
ELSIF v_party_type = 'employee' THEN
IF v_pv.payment_purpose = 'salary_advance' THEN
SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;
ELSE
SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
END IF;
v_ap_carrying_functional := v_gross * v_rate;
v_realized_fx := 0;
ELSE
SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
v_ap_carrying_functional := v_gross * v_rate;
v_realized_fx := 0;
END IF;
IF v_debit_coa IS NULL THEN
RAISE EXCEPTION 'Could not determine debit control account for party %', v_party_type;
END IF;
IF v_debit_coa = v_bank_coa THEN
RAISE EXCEPTION 'Accounting conflict: Debit control account (%) and credit payment account (%) cannot be identical for payment voucher %',
v_debit_coa, v_bank_coa, v_pv.voucher_number;
END IF;
-- Create Journal Entry
v_je_number := public.next_journal_entry_number();
IF v_bank_currency = 'USD' THEN
v_total_credit := round(v_actual * v_usd_bank_carrying_rate, 2);
ELSE
v_total_credit := round(v_actual * v_rate, 2);
END IF;
v_total_debit := v_ap_carrying_functional;
IF v_settle_diff > 0 THEN
v_total_debit := v_total_debit - round(v_settle_diff * v_rate, 2);
END IF;
IF v_realized_fx > 0 THEN
v_total_credit := v_total_credit + v_realized_fx;
ELSIF v_realized_fx < 0 THEN
v_total_debit := v_total_debit + abs(v_realized_fx);
END IF;
INSERT INTO public.journal_entries (
entry_number, entry_date, source_module, reference_id, reference_number,
description, total_debit, total_credit, is_posted, posted_by,
transaction_currency, functional_currency, exchange_rate
) VALUES (
v_je_number, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number,
'Payment Voucher ' || v_pv.voucher_number || COALESCE(' - ' || v_pv.description, ''),
GREATEST(v_total_debit, v_total_credit), GREATEST(v_total_debit, v_total_credit),
true, v_actual_poster,
v_bank_currency, 'IDR', CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE v_rate END
) RETURNING id INTO v_je_id;
-- Line 1: Debit Control Account
INSERT INTO public.journal_entry_lines (
journal_entry_id, line_number, account_id, description, debit, credit,
supplier_id, customer_id, staff_id,
transaction_currency, transaction_debit, transaction_credit, exchange_rate
) VALUES (
v_je_id, v_line, v_debit_coa,
CASE
WHEN v_pv.payment_purpose = 'salary_advance' THEN 'Salary Advance - '
WHEN v_pv.payment_method = 'advance_adjustment' THEN 'Staff Payment (Advance Settlement) - '
ELSE 'Payment Settlement - '
END || v_pv.voucher_number,
v_ap_carrying_functional, 0,
v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id,
v_bank_currency, v_gross, 0, v_rate
);
v_line := v_line + 1;
-- Line 2: Realized FX Loss
IF v_realized_fx < 0 AND v_fx_loss_coa IS NOT NULL THEN
INSERT INTO public.journal_entry_lines (
journal_entry_id, line_number, account_id, description, debit, credit,
supplier_id, customer_id, staff_id,
transaction_currency, transaction_debit, transaction_credit, exchange_rate
) VALUES (
v_je_id, v_line, v_fx_loss_coa,
'Realized FX Loss - ' || v_pv.voucher_number,
abs(v_realized_fx), 0,
v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id,
'IDR', abs(v_realized_fx), 0, 1
);
v_line := v_line + 1;
END IF;
-- Line 3: Credit Bank / Cash / Advance Account
INSERT INTO public.journal_entry_lines (
journal_entry_id, line_number, account_id, description, debit, credit,
supplier_id, customer_id, staff_id,
transaction_currency, transaction_debit, transaction_credit, exchange_rate
) VALUES (
v_je_id, v_line, v_bank_coa,
CASE
WHEN v_pv.payment_method = 'advance_adjustment' THEN 'Advance Adjustment - '
WHEN v_pv.payment_method = 'petty_cash' OR v_bank_coa = (SELECT id FROM public.chart_of_accounts WHERE code = '1102' LIMIT 1) THEN 'Petty Cash Payment - '
WHEN v_pv.payment_method = 'cash' THEN 'Cash in Hand Payment - '
ELSE 'Bank Payment - '
END || v_pv.voucher_number,
0,
CASE WHEN v_bank_currency = 'USD' THEN round(v_actual * v_usd_bank_carrying_rate, 2) ELSE round(v_actual * v_rate, 2) END,
v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id,
v_bank_currency, 0, v_actual, CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE v_rate END
);
v_line := v_line + 1;
-- Line 4: Realized FX Gain
IF v_realized_fx > 0 AND v_fx_gain_coa IS NOT NULL THEN
INSERT INTO public.journal_entry_lines (
journal_entry_id, line_number, account_id, description, debit, credit,
supplier_id, customer_id, staff_id,
transaction_currency, transaction_debit, transaction_credit, exchange_rate
) VALUES (
v_je_id, v_line, v_fx_gain_coa,
'Realized FX Gain - ' || v_pv.voucher_number,
0, v_realized_fx,
v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id,
'IDR', 0, v_realized_fx, 1
);
v_line := v_line + 1;
END IF;
-- Resolve Payee display name
IF v_pv.supplier_id IS NOT NULL THEN
SELECT company_name INTO v_payee_name FROM public.suppliers WHERE id = v_pv.supplier_id;
ELSIF v_pv.staff_id IS NOT NULL THEN
SELECT full_name INTO v_payee_name FROM public.finance_staff_master WHERE id = v_pv.staff_id;
ELSIF v_pv.customer_id IS NOT NULL THEN
SELECT company_name INTO v_payee_name FROM public.customers WHERE id = v_pv.customer_id;
END IF;
v_payee_name := COALESCE(v_payee_name, v_pv.description, 'Payee');
-- Petty Cash Synchronization: Create/Sync exactly one outgoing transaction and deduct from book balance
IF v_bank_coa = (SELECT id FROM public.chart_of_accounts WHERE code = '1102' LIMIT 1) THEN
SELECT * INTO v_pct FROM public.petty_cash_transactions WHERE payment_voucher_id = p_pv_id FOR UPDATE;
IF NOT FOUND THEN
-- Deduct from petty cash book balance
UPDATE public.petty_cash_books
SET current_balance = current_balance - v_gross,
updated_at = now()
WHERE id = v_book_id;
INSERT INTO public.petty_cash_transactions (
transaction_date,
transaction_type,
amount,
description,
expense_category,
paid_to,
paid_by_staff_id,
paid_by,
voucher_number,
source,
payment_voucher_id,
petty_cash_book_id,
approval_status,
approved_by,
approved_at,
created_by
) VALUES (
v_pv.voucher_date,
'expense',
v_gross,
COALESCE(v_pv.description, 'Payment Voucher ' || v_pv.voucher_number),
CASE WHEN v_pv.payment_purpose = 'salary_advance' THEN NULL ELSE 'Operating Expense' END,
v_payee_name,
v_pv.staff_id,
'cash',
v_pv.voucher_number,
'Payment Voucher ' || v_pv.voucher_number,
v_pv.id,
v_book_id,
'approved',
v_actual_poster,
now(),
v_actual_poster
);
ELSE
-- Idempotent update on retry or repost
IF v_pct.amount <> v_gross OR v_pct.petty_cash_book_id IS DISTINCT FROM v_book_id THEN
IF v_pct.petty_cash_book_id IS NOT NULL THEN
UPDATE public.petty_cash_books
SET current_balance = current_balance + v_pct.amount,
updated_at = now()
WHERE id = v_pct.petty_cash_book_id;
END IF;
UPDATE public.petty_cash_books
SET current_balance = current_balance - v_gross,
updated_at = now()
WHERE id = v_book_id;
END IF;
UPDATE public.petty_cash_transactions
SET amount = v_gross,
transaction_date = v_pv.voucher_date,
description = COALESCE(v_pv.description, 'Payment Voucher ' || v_pv.voucher_number),
expense_category = CASE WHEN v_pv.payment_purpose = 'salary_advance' THEN NULL ELSE COALESCE(v_pct.expense_category, 'Operating Expense') END,
paid_to = v_payee_name,
paid_by_staff_id = v_pv.staff_id,
petty_cash_book_id = v_book_id,
approval_status = 'approved',
approved_by = v_actual_poster,
approved_at = now(),
updated_at = now()
WHERE id = v_pct.id;
END IF;
END IF;
-- Update Payment Voucher
UPDATE public.payment_vouchers
SET journal_entry_id = v_je_id,
is_posted = true,
status = 'approved',
petty_cash_book_id = COALESCE(v_book_id, petty_cash_book_id),
updated_at = now()
WHERE id = p_pv_id;
-- Recalculate Purchase Invoice balances and states
IF v_party_type = 'supplier' THEN
PERFORM public.recalculate_purchase_invoice_payment_state(va.purchase_invoice_id)
FROM public.voucher_allocations va
WHERE va.payment_voucher_id = p_pv_id AND va.purchase_invoice_id IS NOT NULL;
END IF;
-- Recalculate Expense balances and states if allocated
PERFORM public.recalculate_expense_payment_state(va.finance_expense_id)
FROM public.voucher_allocations va
WHERE va.payment_voucher_id = p_pv_id AND va.finance_expense_id IS NOT NULL;
-- Synchronize bank account current_balance with authoritative GL
IF v_pv.bank_account_id IS NOT NULL THEN
PERFORM public.sync_bank_account_balance(v_pv.bank_account_id);
END IF;
RETURN;
END;
$function$;
-- 6. Comprehensive cancel_payment_voucher_posting upgrade
CREATE OR REPLACE FUNCTION public.cancel_payment_voucher_posting(
p_pv_id uuid,
p_cancelled_by uuid,
p_reason text DEFAULT 'Posting cancelled by administrator'::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
v_pv RECORD;
v_je RECORD;
v_pct RECORD;
v_book_id UUID;
BEGIN
IF auth.uid() IS NULL THEN
RAISE EXCEPTION 'Not authenticated';
END IF;
PERFORM public._sec_check_finance_role();
IF p_cancelled_by IS DISTINCT FROM auth.uid() THEN
RAISE EXCEPTION 'Cancelled-by identity must match the authenticated user';
END IF;
SELECT * INTO v_pv FROM payment_vouchers WHERE id = p_pv_id FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
IF NOT v_pv.is_posted THEN
RAISE EXCEPTION 'Payment voucher % is not posted', COALESCE(v_pv.voucher_number, p_pv_id::TEXT);
END IF;
SELECT * INTO v_je FROM journal_entries WHERE id = v_pv.journal_entry_id;
IF NOT FOUND THEN
RAISE EXCEPTION 'No journal entry found for payment voucher %', v_pv.voucher_number;
END IF;
-- Restore Petty Cash Book balance and delete linked petty cash transaction
FOR v_pct IN SELECT * FROM public.petty_cash_transactions WHERE payment_voucher_id = p_pv_id LOOP
v_book_id := COALESCE(v_pct.petty_cash_book_id, v_pv.petty_cash_book_id);
IF v_book_id IS NOT NULL THEN
UPDATE public.petty_cash_books
SET current_balance = current_balance + v_pct.amount,
updated_at = now()
WHERE id = v_book_id;
END IF;
DELETE FROM public.petty_cash_transactions WHERE id = v_pct.id;
END LOOP;
-- Clear any settlement adjustments linked to this payment voucher
PERFORM public.clear_payment_allocation_rounding_adjustment(NULL, p_pv_id);
-- Clear the FK reference FIRST so cancel_gl_posting can delete the JE row
UPDATE payment_vouchers
SET is_posted = FALSE, journal_entry_id = NULL
WHERE id = p_pv_id;
PERFORM cancel_gl_posting(
v_je.id, p_pv_id, 'payment_vouchers', p_cancelled_by, p_reason,
jsonb_build_object(
'voucher_number', v_pv.voucher_number,
'amount',         v_pv.amount,
'is_posted',      TRUE
)
);
-- Recalculate Purchase Invoice balances and states
PERFORM public.recalculate_purchase_invoice_payment_state(va.purchase_invoice_id)
FROM public.voucher_allocations va
WHERE va.payment_voucher_id = p_pv_id AND va.purchase_invoice_id IS NOT NULL;
-- Recalculate Expense balances and states if allocated
PERFORM public.recalculate_expense_payment_state(va.finance_expense_id)
FROM public.voucher_allocations va
WHERE va.payment_voucher_id = p_pv_id AND va.finance_expense_id IS NOT NULL;
-- Synchronize bank account current_balance with authoritative GL
IF v_pv.bank_account_id IS NOT NULL THEN
PERFORM public.sync_bank_account_balance(v_pv.bank_account_id);
END IF;
END;
$function$;
-- 8. Make the deferred Petty Cash integrity check aware of Payment Voucher journals.
-- Payment Voucher disbursements use source_module='payment'; they intentionally do not
-- create a second source_module='petty_cash' journal.
CREATE OR REPLACE FUNCTION public.validate_petty_cash_chain_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ft public.fund_transfers%ROWTYPE;
  v_je public.journal_entries%ROWTYPE;
  v_pv public.payment_vouchers%ROWTYPE;
  v_pc_account uuid;
  v_pc_debit numeric := 0;
  v_pc_credit numeric := 0;
  v_pc_transaction_credit numeric := 0;
  v_expense_account uuid;
BEGIN
  -- Payment Voucher-linked Petty Cash outflows are posted by post_payment_voucher.
  -- Validate that canonical journal instead of looking for a petty_cash journal.
  IF NEW.payment_voucher_id IS NOT NULL THEN
    SELECT * INTO v_pv
    FROM public.payment_vouchers
    WHERE id = NEW.payment_voucher_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Petty Cash % references missing Payment Voucher %',
        NEW.id, NEW.payment_voucher_id;
    END IF;

    IF NEW.transaction_type <> 'expense'
       OR NEW.approval_status <> 'approved'
       OR v_pv.is_posted IS DISTINCT FROM true
       OR v_pv.status <> 'approved'
       OR v_pv.petty_cash_book_id IS DISTINCT FROM NEW.petty_cash_book_id
       OR abs(COALESCE(v_pv.amount, 0) - NEW.amount) > 0.01 THEN
      RAISE EXCEPTION 'Petty Cash transaction % does not match its approved/posted Payment Voucher %',
        NEW.id, v_pv.voucher_number USING ERRCODE = 'check_violation';
    END IF;

    IF v_pv.payment_method NOT IN ('cash', 'petty_cash') THEN
      RAISE EXCEPTION 'Payment Voucher % is not a cash/Petty Cash disbursement',
        v_pv.voucher_number USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO v_je
    FROM public.journal_entries
    WHERE id = v_pv.journal_entry_id
      AND source_module = 'payment'
      AND reference_id = v_pv.id
      AND is_posted = true
      AND NOT COALESCE(is_reversed, false);

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Payment Voucher % has no active canonical payment journal',
        v_pv.voucher_number;
    END IF;

    SELECT id INTO v_pc_account
    FROM public.chart_of_accounts
    WHERE code = '1102' AND is_header = false AND is_active = true
    LIMIT 1;

    IF v_pc_account IS NULL THEN
      RAISE EXCEPTION 'Active Petty Cash GL account 1102 is missing';
    END IF;

    SELECT
      COALESCE(sum(l.debit), 0),
      COALESCE(sum(l.credit), 0),
      COALESCE(sum(l.transaction_credit), 0)
    INTO v_pc_debit, v_pc_credit, v_pc_transaction_credit
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = v_je.id
      AND l.account_id = v_pc_account;

    IF v_pc_debit > 0.01
       OR abs(v_pc_credit - round(NEW.amount * COALESCE(NULLIF(v_pv.exchange_rate, 0), 1), 2)) > 0.01
       OR abs(v_pc_transaction_credit - NEW.amount) > 0.01 THEN
      RAISE EXCEPTION 'Payment Voucher % journal does not credit Petty Cash GL 1102 for the transaction amount',
        v_pv.voucher_number USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.fund_transfer_id IS NOT NULL THEN
    SELECT * INTO v_ft FROM public.fund_transfers WHERE id = NEW.fund_transfer_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Petty Cash % references missing fund transfer', NEW.id; END IF;
    IF NEW.transaction_type <> 'withdraw' OR v_ft.to_account_type <> 'petty_cash'
       OR abs(NEW.amount - COALESCE(v_ft.to_amount, v_ft.amount)) > 0.01 THEN
      RAISE EXCEPTION 'Petty Cash % amount/direction does not match Fund Transfer %',
        NEW.id, v_ft.transfer_number USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT id INTO v_pc_account
  FROM public.chart_of_accounts
  WHERE code = '1102' AND is_header = false AND is_active = true
  LIMIT 1;

  IF NEW.approval_status = 'approved'
     AND COALESCE(NEW.source, '') NOT LIKE 'historical_expense:%'
     AND NEW.transaction_type = 'expense' THEN
    SELECT je.* INTO v_je
    FROM public.journal_entries je
    WHERE je.source_module = 'petty_cash'
      AND je.reference_id = NEW.id
      AND je.is_posted
      AND NOT COALESCE(je.is_reversed, false);

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Approved Petty Cash expense % has no active canonical journal', NEW.transaction_number;
    END IF;

    SELECT COALESCE(sum(l.debit), 0), COALESCE(sum(l.credit), 0)
    INTO v_pc_debit, v_pc_credit
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = v_je.id AND l.account_id = v_pc_account;

    IF abs(v_pc_credit - NEW.amount) > 0.01 OR v_pc_debit > 0.01 THEN
      RAISE EXCEPTION 'Petty Cash expense % journal amount/direction mismatch',
        NEW.transaction_number USING ERRCODE = 'check_violation';
    END IF;

    v_expense_account := public.get_expense_account_id(NEW.expense_category);
    IF NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = v_je.id
        AND l.account_id = v_expense_account
        AND abs(l.debit - NEW.amount) <= 0.01
        AND l.credit = 0
    ) THEN
      RAISE EXCEPTION 'Petty Cash expense % journal account/category mismatch', NEW.transaction_number;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
