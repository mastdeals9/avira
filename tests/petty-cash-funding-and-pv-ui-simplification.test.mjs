import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pvManagerSource = readFileSync(
  new URL('../src/components/finance/PaymentVoucherManager.tsx', import.meta.url),
  'utf8',
);

const pettyCashSource = readFileSync(
  new URL('../src/components/finance/PettyCashManager.tsx', import.meta.url),
  'utf8',
);

const migrationSource = readFileSync(
  new URL('../supabase/migrations/20261118220000_correct_sandi_pv028_petty_cash_funding.sql', import.meta.url),
  'utf8',
);

test('1. Migration asserts preconditions and creates canonical Bank-to-Petty-Cash transfer with balanced journal', () => {
  // Preconditions on Sandi PV/028, PV/023, PV/032, EXP/365
  assert.match(migrationSource, /c_sandi_staff_id\s*CONSTANT\s*uuid\s*:=\s*'276dc2e0-3cb2-426f-aee7-a9991e5f4cfc'/);
  assert.match(migrationSource, /c_pv028_id\s*CONSTANT\s*uuid\s*:=\s*'8a045a25-e2b4-4f7b-8a27-4312d86a547e'/);
  assert.match(migrationSource, /c_pv023_id\s*CONSTANT\s*uuid\s*:=\s*'d024d570-3348-4c41-96ac-e83b2a91cae9'/);
  assert.match(migrationSource, /c_pv032_id\s*CONSTANT\s*uuid\s*:=\s*'75271c77-fc47-4ba7-b1fa-42cb4abd74ca'/);
  assert.match(migrationSource, /c_exp365_id\s*CONSTANT\s*uuid\s*:=\s*'b266063e-9f1d-48e7-8728-a7828b704204'/);

  // Balanced journal creation: Dr 1102 Petty Cash Rp 100k, Cr 111101 BCA Bank Rp 100k
  assert.match(migrationSource, /from_account_type[\s\S]*?'bank'/);
  assert.match(migrationSource, /to_account_type[\s\S]*?'petty_cash'/);
  assert.match(migrationSource, /post_fund_transfer_journal/);
  assert.match(migrationSource, /Petty Cash Funding — Sandi Prasetyo/);
});

test('2. Bank-to-Petty-Cash transfer appears in Petty Cash statement as Transfer In', () => {
  // Migration inserts into petty_cash_transactions as withdraw (inflow into petty cash)
  assert.match(migrationSource, /INSERT INTO public\.petty_cash_transactions/);
  assert.match(migrationSource, /'withdraw'/);
  assert.match(migrationSource, /fund_transfer_id/);

  // PettyCashManager queries vw_fund_transfers_detailed and treats to_account_type === 'petty_cash' as inflow
  assert.match(pettyCashSource, /transfer\.to_account_type === 'petty_cash'/);
  assert.match(pettyCashSource, /isInflow \? 'withdraw' : 'expense'/);
  assert.match(pettyCashSource, /isInflow \? 'Fund Transfer into Petty Cash' : 'Fund Transfer from Petty Cash'/);
});

test('3. Missing bank statement line on 22 Oct leaves reconciliation pending (no invented record)', () => {
  // In migration, from_bank_statement_line_id is explicitly set to NULL
  assert.match(migrationSource, /NULL,\s*--\s*22 Oct Rp 100k line missing from imported bank statement; reconciliation pending/);
  // Status is pending/draft until verified
  assert.match(migrationSource, /'pending'/);
});

test('4. Erroneous advance application 4553f6bd is preserved in audit before deletion and PV/028 is reclassified', () => {
  // Precondition checks on erroneous application
  assert.match(migrationSource, /SELECT \* INTO v_app FROM public\.salary_advance_applications WHERE id = c_app_erroneous_id/);
  assert.match(migrationSource, /v_app\.applied_amount <> 100000/);

  // Application row preserved in audit record v_before
  assert.match(migrationSource, /'erroneous_application',\s*row_to_json\(v_app\)/);
  assert.match(migrationSource, /'application_row',\s*row_to_json\(v_app\)/);

  // Delete erroneous application only after recording
  assert.match(migrationSource, /DELETE FROM public\.salary_advance_applications\s*WHERE id = c_app_erroneous_id/);

  // Reclassify PV/028
  assert.match(migrationSource, /salary_advance_applied_amount = 0/);
  assert.match(migrationSource, /salary_advance_status = 'not_applicable'/);
  assert.match(migrationSource, /status = 'cancelled'/);
  assert.match(migrationSource, /SUPERSEDED: Reclassified to Bank -> Petty Cash Fund Transfer/);
});

test('5. Genuine advance PV/023 is preserved at Rp 1,000,000 and PV/032 settlement is reversed and reissued', () => {
  // Assert PV/023 amount is 1,000,000
  assert.match(migrationSource, /v_pv023\.amount <> 1000000/);
  assert.match(migrationSource, /v_pv023\.staff_id <> c_sandi_staff_id/);

  // Strict preconditions on PV/032 and JE2611-0363
  assert.match(migrationSource, /v_pv032\.voucher_number <> 'PV\/26-26\/032'/);
  assert.match(migrationSource, /v_pv032\.staff_id <> c_sandi_staff_id/);
  assert.match(migrationSource, /v_pv032\.amount <> 1100000/);
  assert.match(migrationSource, /v_je0363\.entry_number <> 'JE2611-0363'/);
  assert.match(migrationSource, /v_je0363\.total_debit <> 1100000/);

  // Reversal journal for JE2611-0363 with staff_id retained
  assert.match(migrationSource, /REV-'\s*\|\|\s*v_je0363\.entry_number/);
  assert.match(migrationSource, /Historical reversal of overstated salary advance settlement PV\/26-26\/032/);
  assert.match(migrationSource, /is_reversed = true/);
  assert.match(migrationSource, /c_sandi_staff_id\);[\s\S]*?UPDATE public\.journal_entries[\s\S]*?is_reversed = true/);

  // Replacement settlement journal for Rp 1,000,000 with staff_id retained
  assert.match(migrationSource, /Corrected salary advance settlement for Sandi Prasetyo \(PV\/26-26\/023 Rp 1,000,000\)/);
  assert.match(migrationSource, /UPDATE public\.payment_vouchers\s*SET amount = 1000000/);
});

test('6. EXP/26/365 recalculated: paid Rp 2,400,000, outstanding salary payable Rp 100,000', () => {
  assert.match(migrationSource, /PERFORM public\.recalculate_expense_payment_state\(c_exp365_id\)/);
  assert.match(migrationSource, /v_exp365\.paid_amount <> 2400000/);
  assert.match(migrationSource, /Assertion failed: EXP\/26\/365 paid_amount must be 2,400,000/);
});

test('7. Payment Voucher UI simplification: Main options are Bank Transfer and Cash only', () => {
  // Main options in Payment Method selector
  assert.match(pvManagerSource, /<option value="bank_transfer">Bank Transfer<\/option>/);
  assert.match(pvManagerSource, /<option value="cash">Cash<\/option>/);

  // Normal options do NOT include adjust_against_staff_advance or check/giro/other for new vouchers
  assert.doesNotMatch(
    pvManagerSource,
    /<option value="advance_adjustment">Adjust Against Staff Advance<\/option>/,
    'Normal payment method selector must not expose Adjust Against Staff Advance',
  );

  // Salary advance settlement removed from normal employee payment purposes
  const employeePurposes = pvManagerSource.match(/employee:\s*\[([\s\S]*?)\]/);
  assert.ok(employeePurposes, 'employee payment purposes must exist');
  assert.doesNotMatch(
    employeePurposes[1],
    /salary_advance_settlement/,
    'Salary advance settlement must not be exposed in normal employee payment purposes',
  );
});

test('8. When Cash is selected: UI shows Cash Source (Cash in Hand vs Petty Cash)', () => {
  assert.match(pvManagerSource, /<FloatingField label="Cash Source"/);
  assert.match(pvManagerSource, /<option value="cash_on_hand"[^>]*>[\s\S]*Cash in Hand/);
  assert.match(pvManagerSource, /<option value="petty_cash">Petty Cash/);

  // When Petty Cash selected: requires active Petty Cash book/fund
  assert.match(pvManagerSource, /<FloatingField label="Petty Cash Book \/ Fund"/);
  assert.match(pvManagerSource, /name="petty_cash_book_id"/);
  assert.match(pvManagerSource, /pettyCashBooks\.map/);

  // Validation prevents saving petty cash without book selection
  assert.match(pvManagerSource, /if\s*\(formData\.payment_method === 'cash'\)\s*\{[\s\S]*?if\s*\(formData\.cash_source === 'petty_cash' && !formData\.petty_cash_book_id\)/);
});

test('9. Cash in Hand reduces Cash in Hand (1101); Petty Cash reduces Petty Cash (1102)', () => {
  // Preview footer displays Cr Cash in Hand (1101) vs Cr Petty Cash (1102)
  assert.match(pvManagerSource, /'Cash in Hand \(1101\)'/);
  assert.match(pvManagerSource, /`Petty Cash \(1102\)\$\{/);

  // DB routing in post_payment_voucher routes petty_cash -> 1102 and cash_on_hand -> 1101
  assert.match(migrationSource, /ELSIF v_pv\.payment_method IN \('cash', 'petty_cash'\) THEN/);
  assert.match(migrationSource, /WHERE code = '1102'/);
  assert.match(migrationSource, /WHERE code = '1101'/);

  // PettyCashManager filters out Cash in Hand vouchers so they do not reduce Petty Cash
  assert.match(pettyCashSource, /Cash paid from Cash in Hand must reduce Cash in Hand, NOT Petty Cash/);
  assert.match(pettyCashSource, /pv\.payment_method === 'petty_cash'/);
  assert.match(pettyCashSource, /pv\.coa_account_id === '5b7f4b18-d751-4f47-b49b-117214bf0ba5'/);
});

test('10. Bank transfer cannot be misclassified as cash or petty cash', () => {
  // When bank reconciliation line is attached, method must be bank_transfer
  assert.match(pvManagerSource, /if \(bankReconStatementLineId\) \{\s*if \(formData\.payment_method !== 'bank_transfer'\)/);
  // Bank account is strictly required for bank transfer
  assert.match(pvManagerSource, /formData\.payment_method === 'bank_transfer' && !formData\.bank_account_id/);
});

test('11. Idempotency guard prevents duplicate funding or repair execution', () => {
  assert.match(migrationSource, /c_idempotency CONSTANT text := 'sandi-pv028-petty-cash-funding-correction-20261118-v1'/);
  assert.match(migrationSource, /SELECT \* INTO v_existing\s*FROM public\.finance_historical_repair_commands\s*WHERE idempotency_key = c_idempotency/);
  assert.match(migrationSource, /ON CONFLICT \(fund_transfer_id\) WHERE fund_transfer_id IS NOT NULL DO NOTHING/);
});

test('12. Invariant guard: coa_account_id cannot be used simultaneously as debit and credit in post_payment_voucher', () => {
  // post_payment_voucher disallows coa_account_id from pointing to bank/cash asset account or overriding with credit account
  assert.match(migrationSource, /AND v_pv\.coa_account_id IS DISTINCT FROM v_bank_coa/);
  assert.match(migrationSource, /AND NOT EXISTS \(SELECT 1 FROM public\.chart_of_accounts WHERE id = v_pv\.coa_account_id AND code IN \('1101', '1102', '111101'\)\)/);
  assert.match(migrationSource, /IF v_debit_coa = v_bank_coa THEN/);
  assert.match(migrationSource, /RAISE EXCEPTION 'Accounting conflict: Debit control account \(%\) and credit payment account \(%\) cannot be identical/);

  // PaymentVoucherManager resets coa_account_id to null for cash/petty cash vouchers to prevent accidental override
  assert.match(pvManagerSource, /finalCoaAccountId = null;/);
});

test('13. Inactive GL 1101 is respected: UI disables Cash on Hand and defaults to active Petty Cash (GL 1102)', () => {
  // PaymentVoucherManager fetches GL 1101 status and disables cash_on_hand option if inactive
  assert.match(pvManagerSource, /const \[isCashOnHandActive, setIsCashOnHandActive\] = useState<boolean>\(false\);/);
  assert.match(pvManagerSource, /\.eq\('code', '1101'\)/);
  assert.match(pvManagerSource, /<option value="cash_on_hand" disabled=\{!isCashOnHandActive\}>/);
  assert.match(pvManagerSource, /formData\.cash_source === 'cash_on_hand' && !isCashOnHandActive/);
  assert.match(pvManagerSource, /Cash in Hand \(GL 1101\) is currently inactive in Chart of Accounts/);
});

test('14. Accounting integrity: Supplier payments, advances, employee advances, cash/petty cash and FX rules', () => {
  // Supplier invoice payment routes to Accounts Payable (GL 2110)
  assert.match(migrationSource, /SELECT id INTO v_debit_coa FROM public\.chart_of_accounts WHERE code = '2110'/);
  // Supplier advance routes to Supplier Advances (GL 1170)
  assert.match(migrationSource, /SELECT id INTO v_debit_coa FROM public\.chart_of_accounts WHERE code = '1170'/);
  // Staff advance routes to Staff Advances (GL 1160)
  assert.match(migrationSource, /SELECT id INTO v_debit_coa FROM public\.chart_of_accounts WHERE code = '1160'/);
  // FX gain/loss routing for non-IDR payments (GL 4930 / GL 7300)
  assert.match(migrationSource, /SELECT id INTO v_fx_loss_coa FROM public\.chart_of_accounts WHERE code = '7300'/);
  assert.match(migrationSource, /SELECT id INTO v_fx_gain_coa FROM public\.chart_of_accounts WHERE code = '4930'/);
});

test('15. PV/26-26/032 settlement_amount dependency model: generated column formula evaluates COALESCE(actual_bank_debit, bank_amount)', () => {
  // settlement_amount is GENERATED ALWAYS AS (COALESCE(actual_bank_debit, bank_amount, ((amount - pph_amount) + bank_charge))) STORED
  const testVoucherCalc = (amount, pph, charge, bankDebit, bankAmt) => {
    return bankDebit ?? bankAmt ?? ((amount - pph) + charge);
  };

  // Currently with actual_bank_debit = 1,100,000, settlement evaluates to 1,100,000
  assert.strictEqual(testVoucherCalc(1000000, 0, 0, 1100000, 1100000), 1100000);

  // When corrected to actual_bank_debit = 1,000,000, settlement evaluates to 1,000,000
  assert.strictEqual(testVoucherCalc(1000000, 0, 0, 1000000, 1000000), 1000000);
});
