// tests/payment-voucher-salary-advance-party-mapping.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolvePaymentPartyType,
  isSettledSalaryAdvance,
  getSettledSalaryAdvanceSummary,
} from '../src/utils/paymentVoucherPartyResolver.ts';

const managerSource = readFileSync(
  new URL('../src/components/finance/PaymentVoucherManager.tsx', import.meta.url),
  'utf8',
);

const migrationSource = readFileSync(
  new URL('../supabase/migrations/20261117140111_correct_pv26_028_party_type_and_guard_settled_advances.sql', import.meta.url),
  'utf8',
);

test('Payment Voucher Salary Advance Party Mapping & Edit Safety Suite', async (t) => {

  await t.test('1. Salary advance with party_type incorrectly stored as supplier but staff_id populated resolves to employee', () => {
    const voucher = {
      id: '8a045a25-e2b4-4f7b-8a27-4312d86a547e',
      voucher_number: 'PV/26-26/028',
      party_type: 'supplier',
      staff_id: '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc', // Sandi Prasetyo
      supplier_id: null,
      payment_purpose: 'salary_advance',
      payment_method: 'bank_transfer',
      amount: 100000,
    };
    const resolved = resolvePaymentPartyType(voucher);
    assert.equal(resolved, 'employee', 'Conflicting legacy supplier party_type must resolve to employee for staff salary advance');
  });

  await t.test('2. Salary advance with correct employee party_type resolves to employee', () => {
    const voucher = {
      id: 'b1',
      voucher_number: 'PV/26-26/029',
      party_type: 'employee',
      staff_id: '276dc2e0-3cb2-426f-aee7-a9991e5f4cfc',
      supplier_id: null,
      payment_purpose: 'salary_advance',
      payment_method: 'bank_transfer',
      amount: 500000,
    };
    const resolved = resolvePaymentPartyType(voucher);
    assert.equal(resolved, 'employee');
  });

  await t.test('3. Supplier invoice payment with supplier_id populated resolves to supplier', () => {
    const voucher = {
      id: 'b2',
      voucher_number: 'PV/26-26/010',
      party_type: 'supplier',
      supplier_id: 'sup-uuid-1',
      staff_id: null,
      customer_id: null,
      payment_purpose: 'supplier_invoice_payment',
    };
    const resolved = resolvePaymentPartyType(voucher);
    assert.equal(resolved, 'supplier');
  });

  await t.test('4. Customer refund with customer_id resolves to customer', () => {
    const voucher = {
      id: 'b3',
      voucher_number: 'PV/26-26/011',
      party_type: 'customer',
      customer_id: 'cust-uuid-1',
      supplier_id: null,
      staff_id: null,
      payment_purpose: 'customer_refund',
    };
    const resolved = resolvePaymentPartyType(voucher);
    assert.equal(resolved, 'customer');
  });

  await t.test('5. Director payment resolves to director', () => {
    const voucher = {
      id: 'b4',
      voucher_number: 'PV/26-26/012',
      party_type: 'director',
      description: 'Director: Vijay Lunkad withdrawal',
      payment_purpose: 'director_withdrawal',
    };
    const resolved = resolvePaymentPartyType(voucher);
    assert.equal(resolved, 'director');
  });

  await t.test('6. Other payment resolves to other', () => {
    const voucher = {
      id: 'b5',
      voucher_number: 'PV/26-26/013',
      party_type: 'other',
      description: 'Miscellaneous court fee',
      payment_purpose: 'other_payment',
    };
    const resolved = resolvePaymentPartyType(voucher);
    assert.equal(resolved, 'other');
  });

  await t.test('7. Salary advance purpose always appears in the Employee purpose dropdown & no silent replacement', () => {
    // Assert manager source maps employee purposes with salary_advance
    assert.match(managerSource, /value:\s*'salary_advance',\s*label:\s*'Salary Advance'/);
    // Assert dropdown renders current purpose if not in standard list
    assert.match(managerSource, /formData\.payment_purpose && !\(PAYMENT_PURPOSES\[formData\.party_type\] \|\| PAYMENT_PURPOSES\.supplier\)\.some/);
  });

  await t.test('8. Payment method is preserved accurately during editing', () => {
    // Assert handlePartySelect only defaults payment method for new vouchers, never clobbering existing voucher
    assert.match(managerSource, /if \(!editingVoucher && staff\?\.default_payment_method\)/);
    // Assert payment method dropdown renders preserved value even if not in standard list
    assert.match(managerSource, /formData\.payment_method && !\[.*\]\.includes\(formData\.payment_method\)/);
  });

  await t.test('9. Settled advance with linked application cannot be edited through the ordinary voucher editor', () => {
    const settledVoucher = {
      id: '8a045a25-e2b4-4f7b-8a27-4312d86a547e',
      voucher_number: 'PV/26-26/028',
      payment_purpose: 'salary_advance',
      salary_advance_status: 'settled',
      salary_advance_applied_amount: 100000,
      salary_advance_applications: [
        {
          salary_expense_id: 'exp-uuid-1',
          salary_voucher_number: 'EXP/26/365',
          applied_amount: 100000,
        },
      ],
    };

    assert.equal(isSettledSalaryAdvance(settledVoucher), true, 'Must identify settled salary advance');
    const summary = getSettledSalaryAdvanceSummary(settledVoucher);
    assert.match(summary, /EXP\/26\/365/);
    assert.match(summary, /100\.000/);

    // Assert UI locks accounting fields when editing settled advance
    assert.match(managerSource, /const isSettledAdvance = isSettledSalaryAdvance\(editingVoucher\)/);
    assert.match(managerSource, /const isAccountingLocked = !!\(editingVoucher\?\.is_posted \|\| isSettledAdvance\)/);
    // Assert submit handler guards accounting changes
    assert.match(managerSource, /if \(editingVoucher && isSettledSalaryAdvance\(editingVoucher\)\)/);
    assert.match(managerSource, /reverse or unapply the payroll settlement before/i);
  });

  await t.test('10. Existing settlement links, posted journals and assertions remain strictly preserved in migration', () => {
    // Assert invariant assertions for PV/26-26/028, EXP/26/365 and PV/26-26/032
    assert.match(migrationSource, /8a045a25-e2b4-4f7b-8a27-4312d86a547e/);
    assert.match(migrationSource, /PV\/26-26\/028/);
    assert.match(migrationSource, /276dc2e0-3cb2-426f-aee7-a9991e5f4cfc/);
    assert.match(migrationSource, /EXP\/26\/365/);
    assert.match(migrationSource, /PV\/26-26\/032/);
    assert.match(migrationSource, /is_posted IS NOT TRUE/);
    // Assert update only touches party_type
    assert.match(migrationSource, /SET party_type = 'employee'/);
    // Assert safety trigger prevents accounting mutations on applied advances
    assert.match(migrationSource, /CREATE TRIGGER trg_guard_settled_salary_advance_edit/);
  });
});
