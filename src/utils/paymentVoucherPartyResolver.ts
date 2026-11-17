// src/utils/paymentVoucherPartyResolver.ts
export type PartyType = 'supplier' | 'customer' | 'employee' | 'director' | 'other';

export interface PaymentPartyVoucherLike {
  id?: string | null;
  voucher_number?: string | null;
  customer_id?: string | null;
  staff_id?: string | null;
  supplier_id?: string | null;
  party_type?: PartyType | string | null;
  payment_purpose?: string | null;
  description?: string | null;
  payee_type?: string | null;
  salary_advance_status?: 'not_applicable' | 'outstanding' | 'partially_settled' | 'settled' | string | null;
  salary_advance_applied_amount?: number | null;
  salary_advance_applications?: Array<{
    salary_expense_id: string;
    salary_voucher_number: string | null;
    applied_amount: number;
  }> | null;
}

const SALARY_PURPOSES = new Set([
  'salary_advance',
  'salary_advance_settlement',
  'salary_payroll',
]);

const EMPLOYEE_PURPOSES = new Set([
  'salary_advance',
  'salary_advance_settlement',
  'salary_payroll',
  'employee_reimbursement',
  'employee_advance',
  'other_employee_payment',
]);

/**
 * Centrally resolves the semantic PartyType for a Payment Voucher.
 *
 * Rules:
 * 1. If customer_id exists, resolve as customer.
 * 2. If staff_id exists and supplier_id is null, resolve as employee.
 * 3. Salary purposes (salary_advance, salary_advance_settlement, salary_payroll)
 *    must resolve as employee unless the record is structurally invalid (e.g. has customer_id).
 * 4. Explicit director and other party types remain supported.
 * 5. Supplier is only selected when a valid supplier_id exists or the record is genuinely a supplier payment.
 * 6. If metadata conflicts (e.g. legacy party_type='supplier' on a staff salary advance),
 *    log a diagnostic warning and return the correct business party type without silent reclassification.
 */
export function resolvePaymentPartyType(voucher: PaymentPartyVoucherLike | null | undefined): PartyType {
  if (!voucher) return 'supplier';

  // Rule 1: Customer refund / credit
  if (voucher.customer_id) {
    if (voucher.party_type && voucher.party_type !== 'customer') {
      console.warn(
        `[PaymentPartyResolver] Voucher ${voucher.voucher_number || voucher.id || 'unassigned'} has customer_id '${voucher.customer_id}' but party_type '${voucher.party_type}'. Resolving as 'customer'.`
      );
    }
    return 'customer';
  }

  const purpose = voucher.payment_purpose || '';
  const isSalaryPurpose = SALARY_PURPOSES.has(purpose);
  const isEmployeePurpose = EMPLOYEE_PURPOSES.has(purpose);
  const hasStaffId = Boolean(voucher.staff_id);
  const hasSupplierId = Boolean(voucher.supplier_id);

  // Rule 3 & 2: Salary purposes or staff_id with no supplier_id resolve as employee
  if (isSalaryPurpose || (hasStaffId && !hasSupplierId)) {
    if (voucher.party_type && voucher.party_type !== 'employee') {
      console.warn(
        `[PaymentPartyResolver] Voucher ${voucher.voucher_number || voucher.id || 'unassigned'} has staff_id '${voucher.staff_id}' or purpose '${purpose}' but conflicting party_type '${voucher.party_type}'. Resolving as 'employee'.`
      );
    }
    return 'employee';
  }

  // Rule 4: Explicit director / loan
  if (voucher.party_type === 'director' || (voucher.description && /^Director:\s*/i.test(voucher.description))) {
    return 'director';
  }

  // Rule 4: Explicit other / general
  if (voucher.party_type === 'other') {
    return 'other';
  }

  // Rule 5: Genuine supplier payment with supplier_id
  if (hasSupplierId && !hasStaffId) {
    return 'supplier';
  }

  // Conflict case: both staff_id and supplier_id populated
  if (hasStaffId && hasSupplierId) {
    if (isEmployeePurpose) {
      console.warn(
        `[PaymentPartyResolver] Voucher ${voucher.voucher_number || voucher.id || 'unassigned'} has both staff_id and supplier_id with employee purpose '${purpose}'. Resolving as 'employee'.`
      );
      return 'employee';
    }
    console.warn(
      `[PaymentPartyResolver] Voucher ${voucher.voucher_number || voucher.id || 'unassigned'} has both staff_id and supplier_id. Resolving as 'supplier'.`
    );
    return 'supplier';
  }

  // Declared party_type fallbacks when IDs are absent
  if (voucher.party_type === 'employee') return 'employee';
  if (voucher.party_type === 'customer') return 'customer';
  if (voucher.party_type === 'supplier') return 'supplier';

  // Last-resort ID fallbacks
  if (hasStaffId) return 'employee';
  if (hasSupplierId) return 'supplier';

  return 'supplier';
}

/**
 * Checks if a payment voucher represents a salary advance that has been applied or settled.
 */
export function isSettledSalaryAdvance(voucher: PaymentPartyVoucherLike | null | undefined): boolean {
  if (!voucher) return false;
  if (voucher.payment_purpose !== 'salary_advance') return false;

  const hasApplications = Array.isArray(voucher.salary_advance_applications) && voucher.salary_advance_applications.length > 0;
  const hasAppliedAmount = Number(voucher.salary_advance_applied_amount || 0) > 0;
  const isSettledStatus = voucher.salary_advance_status === 'settled' || voucher.salary_advance_status === 'partially_settled';

  return hasApplications || hasAppliedAmount || isSettledStatus;
}

/**
 * Formats a human-readable summary of the payroll application for a settled advance.
 */
export function getSettledSalaryAdvanceSummary(voucher: PaymentPartyVoucherLike | null | undefined): string {
  if (!voucher) return '';
  const parts: string[] = [];

  if (voucher.salary_advance_applications && voucher.salary_advance_applications.length > 0) {
    const vouchers = voucher.salary_advance_applications
      .map(a => a.salary_voucher_number || a.salary_expense_id)
      .filter(Boolean)
      .join(', ');
    if (vouchers) parts.push(`payroll voucher(s): ${vouchers}`);
  }

  const appliedAmount = Number(voucher.salary_advance_applied_amount || 0);
  if (appliedAmount > 0) {
    parts.push(`applied: Rp ${appliedAmount.toLocaleString('id-ID')}`);
  }

  if (voucher.salary_advance_status && voucher.salary_advance_status !== 'not_applicable') {
    parts.push(`status: ${voucher.salary_advance_status.replace(/_/g, ' ')}`);
  }

  return parts.length > 0 ? parts.join(', ') : 'applied to payroll';
}
