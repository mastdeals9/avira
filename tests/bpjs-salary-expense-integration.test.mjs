import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { calculateExpenseTotals } from '../src/utils/taxCalculations.ts';

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL || (process.env.READONLY_AUDIT_DB_URL || '');

async function withDbClient(callback) {
  const client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

test('BPJS and Salary Expense Integration Suite', async (t) => {
  await t.test('1. Static Code & UI Integration Verification', () => {
    const expenseManagerSrc = readFileSync(
      new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
      'utf8'
    );
    assert.match(expenseManagerSrc, /bpjs_employee_deduction/, 'ExpenseManager must include bpjs_employee_deduction');
    assert.match(expenseManagerSrc, /bpjs_register_item_id/, 'ExpenseManager must include bpjs_register_item_id');
    assert.match(expenseManagerSrc, /payroll_period_month/, 'ExpenseManager must include payroll_period_month');
    assert.match(expenseManagerSrc, /payroll_period_year/, 'ExpenseManager must include payroll_period_year');
    assert.match(expenseManagerSrc, /Employee BPJS Deduction/, 'ExpenseManager detail modal must show Employee BPJS Deduction');
    assert.match(expenseManagerSrc, /Employer Contribution \(Company Cost\)/, 'ExpenseManager detail modal must show Employer Contribution separately');

    const taxCalcSrc = readFileSync(
      new URL('../src/utils/taxCalculations.ts', import.meta.url),
      'utf8'
    );
    assert.match(taxCalcSrc, /bpjs_employee_deduction/, 'taxCalculations must include bpjs_employee_deduction');
    assert.match(taxCalcSrc, /bpjsEmployeeDeduction/, 'taxCalculations must include bpjsEmployeeDeduction in ExpenseTotals');

    const bpjsRegisterSrc = readFileSync(
      new URL('../src/components/finance/BpjsRegisterManager.tsx', import.meta.url),
      'utf8'
    );
    assert.match(bpjsRegisterSrc, /Calculated Contribution/, 'BpjsRegisterManager must support Calculated Contribution label');
    assert.match(bpjsRegisterSrc, /has_official_bill/, 'BpjsRegisterManager must track has_official_bill');
  });

  await t.test('2. Pure Function Calculations (Chintia & Nia Formulas)', () => {
    // Chintia: Gross Rp 3,800,000, BPJS Rp 76,000
    const chintiaTotals = calculateExpenseTotals({
      expense_category: 'salary',
      amount: 3800000,
      ppn_amount: 0,
      pph_amount: 0,
      bpjs_employee_deduction: 76000,
      pph_treatment: 'deduct',
    });
    assert.equal(chintiaTotals.amount, 3800000);
    assert.equal(chintiaTotals.bpjsEmployeeDeduction, 76000);
    assert.equal(chintiaTotals.netPayable, 3724000, 'Chintia net payable must be Rp 3,724,000 (3,800,000 - 76,000)');
    assert.equal(chintiaTotals.settlementAmount, 3724000);
    assert.equal(chintiaTotals.totalCashOutflow, 3800000);

    // Nia: Gross Rp 8,500,000, PPh21 Rp 170,000, BPJS Rp 170,000
    const niaTotals = calculateExpenseTotals({
      expense_category: 'salary',
      amount: 8500000,
      ppn_amount: 0,
      pph_amount: 170000,
      bpjs_employee_deduction: 170000,
      pph_treatment: 'deduct',
    });
    assert.equal(niaTotals.amount, 8500000);
    assert.equal(niaTotals.pphAmount, 170000);
    assert.equal(niaTotals.bpjsEmployeeDeduction, 170000);
    assert.equal(niaTotals.netPayable, 8160000, 'Nia net payable must be Rp 8,160,000 (8,500,000 - 170,000 - 170,000)');
    assert.equal(niaTotals.settlementAmount, 8160000);
    assert.equal(niaTotals.totalCashOutflow, 8500000);
  });

  await t.test('3. October 2026 BPJS Monthly Register Preservation', async () => {
    await withDbClient(async (client) => {
      const regRes = await client.query(`
        SELECT *
        FROM public.bpjs_monthly_registers
        WHERE period_year = 2026 AND period_month = 10
      `);
      assert.equal(regRes.rows.length, 1, 'October 2026 register must exist');
      const reg = regRes.rows[0];

      assert.equal(Number(reg.total_reported_wages), 12300000, 'Total reported wages must be exactly Rp 12,300,000');
      assert.equal(Number(reg.total_employee_jht), 246000, 'Total employee JHT must be exactly Rp 246,000');
      assert.equal(Number(reg.total_employee_deductions), 246000, 'Total employee deductions must be exactly Rp 246,000');
      assert.equal(Number(reg.total_employer_jht), 455100, 'Total employer JHT must be exactly Rp 455,100');
      assert.equal(Number(reg.total_employer_jkk), 29520, 'Total employer JKK must be exactly Rp 29,520');
      assert.equal(Number(reg.total_employer_jkm), 36900, 'Total employer JKM must be exactly Rp 36,900');
      assert.equal(Number(reg.total_employer_expenses), 521520, 'Total employer expenses must be exactly Rp 521,520');
      assert.equal(Number(reg.total_contribution_payable), 767520, 'Total contribution payable must be exactly Rp 767,520');
    });
  });

  await t.test('4. September 2026 BPJS Register Invariance', async () => {
    await withDbClient(async (client) => {
      const regRes = await client.query(`
        SELECT *
        FROM public.bpjs_monthly_registers
        WHERE period_year = 2026 AND period_month = 9
      `);
      assert.equal(regRes.rows.length, 1, 'September 2026 register must exist');
      const reg = regRes.rows[0];
      assert.equal(reg.status, 'reconciled', 'September register must remain reconciled');
      assert.equal(reg.payment_status, 'paid', 'September register must remain paid');
      assert.equal(Number(reg.actual_paid_amount), 767520, 'September payment amount must be Rp 767,520');
    });
  });

  await t.test('5. Chintia (EXP/26/366) and Nia (EXP/26/363) Expense Record Reconciliation', async () => {
    await withDbClient(async (client) => {
      const expRes = await client.query(`
        SELECT voucher_number, amount, paid_amount, pph_amount, bpjs_employee_deduction, bpjs_register_item_id, payroll_period_month, payroll_period_year
        FROM public.finance_expenses
        WHERE voucher_number IN ('EXP/26/366', 'EXP/26/363')
        ORDER BY voucher_number DESC
      `);
      assert.equal(expRes.rows.length, 2, 'Both vouchers must exist');
      const [chintia, nia] = expRes.rows;

      // Chintia EXP/26/366:
      assert.equal(chintia.voucher_number, 'EXP/26/366');
      assert.equal(Number(chintia.amount), 3800000);
      assert.equal(Number(chintia.bpjs_employee_deduction), 76000, 'Chintia employee BPJS deduction must be Rp 76,000');
      assert.equal(chintia.payroll_period_month, 10, 'Chintia payroll month must be 10 (October)');
      assert.equal(chintia.payroll_period_year, 2026, 'Chintia payroll year must be 2026');
      assert.ok(chintia.bpjs_register_item_id, 'Chintia must be linked to Oct-26 register item');

      // Nia EXP/26/363:
      assert.equal(nia.voucher_number, 'EXP/26/363');
      assert.equal(Number(nia.amount), 8500000);
      assert.equal(Number(nia.pph_amount), 170000);
      assert.equal(Number(nia.bpjs_employee_deduction), 170000, 'Nia employee BPJS deduction must be Rp 170,000');
      assert.equal(nia.payroll_period_month, 10, 'Nia payroll month must be 10 (October)');
      assert.equal(nia.payroll_period_year, 2026, 'Nia payroll year must be 2026');
      assert.equal(nia.bpjs_register_item_id, '81be19b2-0339-4607-b90a-da4e9f23dc97', 'Nia must be linked to October register item');
      assert.equal(Number(nia.paid_amount), 8330000, 'Nia historical payment of Rp 8,330,000 must be preserved');

      // Telekom EXP/26/314:
      const telekomRes = await client.query(`
        SELECT fe.voucher_number, fe.amount, fe.bank_charges_amount, fe.paid_amount,
               COALESCE(SUM(bsa.allocation_amount), 0) AS total_bank_allocation
        FROM public.finance_expenses fe
        LEFT JOIN public.bank_statement_allocations bsa ON bsa.document_id = fe.id
        WHERE fe.voucher_number = 'EXP/26/314'
        GROUP BY fe.voucher_number, fe.amount, fe.bank_charges_amount, fe.paid_amount
      `);
      assert.equal(telekomRes.rows.length, 1, 'Telekom expense must exist');
      const telekom = telekomRes.rows[0];
      assert.equal(Number(telekom.amount), 102938);
      assert.equal(Number(telekom.bank_charges_amount), 3000);
      assert.equal(Number(telekom.paid_amount), 105938, 'Telekom paid_amount must be Rp 105,938');
      assert.equal(Number(telekom.total_bank_allocation), 105938, 'Telekom bank allocation must be Rp 105,938');
      const telekomOutstanding = (Number(telekom.amount) + Number(telekom.bank_charges_amount)) - Number(telekom.paid_amount);
      assert.equal(telekomOutstanding, 0, 'Telekom outstanding balance must be Rp 0');
    });
  });
});

