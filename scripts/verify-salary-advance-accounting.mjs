import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sql = `
BEGIN;
SELECT set_config('request.jwt.claim.sub',(
  SELECT id::text FROM public.user_profiles WHERE role IN ('admin','accounts') AND is_active=true
  ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END,id LIMIT 1),true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;

DO $audit$
DECLARE
  v_user uuid:=auth.uid(); v_staff uuid; v_bank uuid; v_bank_coa uuid;
  v_advance_saved jsonb; v_final_saved jsonb; v_apply jsonb;
  v_advance uuid; v_salary uuid; v_settlement uuid; v_final uuid;
  v_advance_je uuid; v_salary_je uuid; v_settlement_je uuid; v_final_je uuid;
  v_before_advance numeric; v_after_advance numeric; v_after_settlement numeric;
  v_before_ap numeric; v_after_salary_ap numeric; v_after_settlement_ap numeric; v_after_final_ap numeric;
  v_before_bank numeric; v_after_bank numeric; v_before_salary_expense numeric; v_after_salary_expense numeric;
  v_tb_dr numeric; v_tb_cr numeric; v_count bigint; v_paid numeric;
  v_bpjs_ded numeric := 0; v_net_ap numeric; v_rem_salary numeric;
BEGIN
  SELECT id INTO v_staff FROM public.finance_staff_master WHERE status='active' ORDER BY created_at,id LIMIT 1;
  SELECT id,coa_id INTO v_bank,v_bank_coa FROM public.bank_accounts
   WHERE is_active=true AND upper(currency)='IDR' AND coa_id IS NOT NULL ORDER BY created_at,id LIMIT 1;
  IF v_user IS NULL OR v_staff IS NULL OR v_bank IS NULL THEN RAISE EXCEPTION 'Required fixtures are missing'; END IF;

  SELECT COALESCE(sum(jel.debit-jel.credit),0) INTO v_before_advance
    FROM public.journal_entry_lines jel JOIN public.journal_entries je ON je.id=jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
   WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false) AND coa.code='1160';
  SELECT COALESCE(sum(jel.credit-jel.debit),0) INTO v_before_ap
    FROM public.journal_entry_lines jel JOIN public.journal_entries je ON je.id=jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
   WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false) AND coa.code='2110';
  SELECT COALESCE(sum(jel.credit-jel.debit),0) INTO v_before_bank
    FROM public.journal_entry_lines jel JOIN public.journal_entries je ON je.id=jel.journal_entry_id
   WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false) AND jel.account_id=v_bank_coa;
  SELECT COALESCE(sum(jel.debit-jel.credit),0) INTO v_before_salary_expense
    FROM public.journal_entry_lines jel JOIN public.journal_entries je ON je.id=jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
   WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false) AND coa.code='6100';

  v_advance_saved:=public.save_payment_voucher_with_purpose(NULL,jsonb_build_object(
    'voucher_date',current_date,'staff_id',v_staff,'payment_method','bank_transfer','bank_account_id',v_bank,
    'amount',500000,'invoice_amount',500000,'payment_amount',500000,'payment_currency','IDR',
    'invoice_currency','IDR','exchange_rate',1,'bank_amount',500000,'actual_bank_debit',500000,
    'description','Rollback Salary Advance accounting verification','created_by',v_user,'document_urls','[]'::jsonb),
    '[]'::jsonb,'salary_advance');
  v_advance:=(v_advance_saved->>'id')::uuid; PERFORM public.post_payment_voucher(v_advance,v_user);
  SELECT journal_entry_id INTO v_advance_je FROM public.payment_vouchers WHERE id=v_advance;
  PERFORM 1 FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
   WHERE jel.journal_entry_id=v_advance_je AND coa.code='1160' AND jel.debit=500000 AND jel.credit=0;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance issuance did not debit 1160'; END IF;
  PERFORM 1 FROM public.journal_entry_lines WHERE journal_entry_id=v_advance_je AND account_id=v_bank_coa AND credit=500000;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance issuance did not credit the selected bank'; END IF;
  SELECT COALESCE(sum(jel.debit-jel.credit),0) INTO v_after_advance FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id=jel.journal_entry_id JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
    WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false) AND coa.code='1160';
  IF v_after_advance-v_before_advance<>500000 THEN RAISE EXCEPTION 'Balance Sheet advance delta is %',v_after_advance-v_before_advance; END IF;

  v_salary:=public.save_finance_expense(NULL,jsonb_build_object('expense_date',current_date,
    'expense_category','salary','expense_type','admin','amount',2500000,'staff_id',v_staff,
    'description','Rollback Gross Salary accounting verification','approval_status','pending_approval',
    'transaction_currency','IDR','exchange_rate',1,'pph_amount',0,'created_by',v_user,'document_urls','[]'::jsonb));
  PERFORM public.approve_finance_expense(v_salary,v_user);
  SELECT COALESCE(bpjs_employee_deduction,0) INTO v_bpjs_ded FROM public.finance_expenses WHERE id=v_salary;
  v_net_ap := 2500000 - v_bpjs_ded;
  v_rem_salary := v_net_ap - 500000;
  SELECT id INTO v_salary_je FROM public.journal_entries WHERE reference_id=v_salary
    AND source_module IN('expense','expenses') AND is_posted AND NOT COALESCE(is_reversed,false)
    ORDER BY created_at DESC LIMIT 1;
  PERFORM 1 FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
   WHERE jel.journal_entry_id=v_salary_je AND coa.code='6100' AND jel.debit=2500000;
  IF NOT FOUND THEN RAISE EXCEPTION 'Gross salary was not debited to 6100'; END IF;
  PERFORM 1 FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
   WHERE jel.journal_entry_id=v_salary_je AND coa.code='2110' AND jel.credit=v_net_ap;
  IF NOT FOUND THEN RAISE EXCEPTION 'Net Salary Payable (%) was not credited to 2110', v_net_ap; END IF;
  IF v_bpjs_ded > 0 THEN
    PERFORM 1 FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
     WHERE jel.journal_entry_id=v_salary_je AND coa.code IN ('2134','2135') AND jel.credit=v_bpjs_ded;
    IF NOT FOUND THEN RAISE EXCEPTION 'BPJS deduction (%) was not credited to 2134/2135', v_bpjs_ded; END IF;
  END IF;
  SELECT COALESCE(sum(jel.credit-jel.debit),0) INTO v_after_salary_ap FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id=jel.journal_entry_id JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
    WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false) AND coa.code='2110';
  IF v_after_salary_ap-v_before_ap<>v_net_ap THEN RAISE EXCEPTION 'Salary Payable after payroll is %',v_after_salary_ap-v_before_ap; END IF;

  v_apply:=public.apply_salary_advances_to_expense(v_salary,true);
  IF (v_apply->>'total_applied')::numeric<>500000 OR (v_apply->>'remaining_salary')::numeric<>2000000 THEN
    RAISE EXCEPTION 'FIFO application is incorrect: %',v_apply; END IF;
  v_settlement:=(v_apply->>'settlement_payment_voucher_id')::uuid;
  SELECT journal_entry_id INTO v_settlement_je FROM public.payment_vouchers WHERE id=v_settlement;
  PERFORM 1 FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
   WHERE jel.journal_entry_id=v_settlement_je AND coa.code='2110' AND jel.debit=500000;
  IF NOT FOUND THEN RAISE EXCEPTION 'Settlement did not debit Salary Payable'; END IF;
  PERFORM 1 FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
   WHERE jel.journal_entry_id=v_settlement_je AND coa.code='1160' AND jel.credit=500000;
  IF NOT FOUND THEN RAISE EXCEPTION 'Settlement did not credit Salary Advance asset'; END IF;
  PERFORM 1 FROM public.journal_entry_lines jel JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
   WHERE jel.journal_entry_id=v_settlement_je AND coa.code LIKE '11%' AND coa.code<>'1160' AND jel.credit>0;
  IF FOUND THEN RAISE EXCEPTION 'Settlement incorrectly credited cash or bank'; END IF;
  SELECT COALESCE(sum(jel.debit-jel.credit),0) INTO v_after_settlement FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id=jel.journal_entry_id JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
    WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false) AND coa.code='1160';
  IF v_after_settlement<>v_before_advance THEN RAISE EXCEPTION 'Advance asset did not return to its opening balance'; END IF;
  SELECT COALESCE(sum(jel.credit-jel.debit),0) INTO v_after_settlement_ap FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id=jel.journal_entry_id JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
    WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false) AND coa.code='2110';
  IF v_after_settlement_ap-v_before_ap<>v_rem_salary THEN RAISE EXCEPTION 'Net Salary Payable is %',v_after_settlement_ap-v_before_ap; END IF;
  PERFORM 1 FROM public.journal_entries WHERE id=v_salary_je AND is_posted AND NOT COALESCE(is_reversed,false);
  IF NOT FOUND THEN RAISE EXCEPTION 'Gross Salary journal disappeared after settlement'; END IF;

  v_final_saved:=public.save_payment_voucher_with_purpose(NULL,jsonb_build_object(
    'voucher_date',current_date,'staff_id',v_staff,'payment_method','bank_transfer','bank_account_id',v_bank,
    'amount',v_rem_salary,'invoice_amount',v_rem_salary,'payment_amount',v_rem_salary,'payment_currency','IDR',
    'invoice_currency','IDR','exchange_rate',1,'bank_amount',v_rem_salary,'actual_bank_debit',v_rem_salary,
    'description','Rollback Net Salary Payment verification','created_by',v_user,'document_urls','[]'::jsonb),
    jsonb_build_array(jsonb_build_object('finance_expense_id',v_salary,'amount',v_rem_salary,'currency','IDR')),'general');
  v_final:=(v_final_saved->>'id')::uuid; PERFORM public.post_payment_voucher(v_final,v_user);
  SELECT journal_entry_id INTO v_final_je FROM public.payment_vouchers WHERE id=v_final;
  PERFORM 1 FROM public.journal_entry_lines WHERE journal_entry_id=v_final_je AND account_id=v_bank_coa AND credit=v_rem_salary;
  IF NOT FOUND THEN RAISE EXCEPTION 'Final bank payment is not %', v_rem_salary; END IF;
  SELECT COALESCE(sum(jel.credit-jel.debit),0) INTO v_after_final_ap FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id=jel.journal_entry_id JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
    WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false) AND coa.code='2110';
  IF v_after_final_ap<>v_before_ap THEN RAISE EXCEPTION 'Salary Payable did not return to opening balance'; END IF;
  SELECT paid_amount INTO v_paid FROM public.finance_expenses WHERE id=v_salary;
  IF v_paid<>v_net_ap THEN RAISE EXCEPTION 'Employee/AP paid amount is %',v_paid; END IF;
  PERFORM 1 FROM public.get_outstanding_expense_bills(current_date) WHERE id=v_salary;
  IF FOUND THEN RAISE EXCEPTION 'Fully settled salary remains in Accounts Payable'; END IF;
  SELECT COALESCE(sum(jel.credit-jel.debit),0) INTO v_after_bank FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id=jel.journal_entry_id WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false)
    AND jel.account_id=v_bank_coa;
  IF v_after_bank-v_before_bank<>v_net_ap THEN RAISE EXCEPTION 'Bank cash outflow is %',v_after_bank-v_before_bank; END IF;
  SELECT COALESCE(sum(jel.debit-jel.credit),0) INTO v_after_salary_expense FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id=jel.journal_entry_id JOIN public.chart_of_accounts coa ON coa.id=jel.account_id
    WHERE je.is_posted AND NOT COALESCE(je.is_reversed,false) AND coa.code='6100';
  IF v_after_salary_expense-v_before_salary_expense<>2500000 THEN RAISE EXCEPTION 'P&L salary expense delta is %',v_after_salary_expense-v_before_salary_expense; END IF;
  SELECT COALESCE(sum(total_debit),0),COALESCE(sum(total_credit),0) INTO v_tb_dr,v_tb_cr
    FROM public.get_trial_balance('2000-01-01',current_date,1);
  IF abs(v_tb_dr-v_tb_cr)>0.01 THEN RAISE EXCEPTION 'Trial Balance is out by %',v_tb_dr-v_tb_cr; END IF;
  SELECT count(*) INTO v_count FROM public.get_balance_sheet(current_date,1);
  IF v_count=0 THEN RAISE EXCEPTION 'Balance Sheet returned no rows'; END IF;
  PERFORM 1 FROM public.get_pnl_summary('2000-01-01',current_date,1);
  IF NOT FOUND THEN RAISE EXCEPTION 'P&L returned no row'; END IF;
END;
$audit$;
ROLLBACK;
`;

const uiSources = [
  readFileSync(new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('../src/components/finance/PaymentVoucherManager.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('../src/components/finance/PartyLedger.tsx', import.meta.url), 'utf8'),
].join('\n');
for (const label of ['Gross Salary Amount', 'Salary Advance Applied', 'Net Payable', 'Paid Amount', 'Outstanding Balance', 'Final Bank Payment', 'Less Salary Advance']) {
  if (!uiSources.includes(label)) throw new Error(`Salary UI is missing ${label}`);
}

try {
  const stdout=execFileSync('supabase',['db','query','--linked','--output-format','json',sql],{
    cwd:process.cwd(),encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:100*1024*1024,
  });
  const response=JSON.parse(stdout.slice(stdout.indexOf('{')));
  if(response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
  console.log(JSON.stringify({status:'passed',transaction:'rolled_back',grossSalary:2500000,
    salaryAdvance:500000,netSalaryPayment:2000000,totalBankOutflow:2500000,
    checks:['salary_advance_asset','gross_salary_expense','salary_payable','non_cash_advance_settlement',
      'final_bank_payment','salary_journal_persistence','employee_ledger_terminology','accounts_payable',
      'general_ledger','trial_balance','balance_sheet','profit_and_loss','payment_voucher']},null,2));
} catch(error) {
  if(error && typeof error==='object' && 'stdout' in error && error.stdout) process.stderr.write(String(error.stdout));
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode=1;
}
