/**
 * categoryFieldRules — single source of truth for which fields the Expense
 * form shows for a given expense_category.
 *
 * Rules (per user brief 2026-07-08):
 *   • Salary / staff_overtime / staff_welfare / travel_conveyance
 *       → HIDE Supplier. SHOW Staff picker + Salary Month.
 *   • Utilities
 *       → HIDE Supplier. SHOW Utility picker + Billing Month.
 *   • Travel (travel_conveyance is a Staff category above; general travel
 *       is not a separate category yet — treated as Staff Expense.)
 *   • Import Broker (import_broker)
 *       → SHOW Supplier + Container + Broker/Reimbursement lines.
 *   • All other expense-supplier categories (rent, professional services,
 *       office, purchases, admin, etc.)
 *       → SHOW Supplier as before.
 *
 * The rules are read by ExpenseManager to decide field visibility.
 * They do NOT affect what gets saved to finance_expenses — that stays
 * exactly as it was. When a Staff or Utility row is picked, the frontend
 * resolves the underlying supplier_id (utility_master.supplier_id) or
 * leaves it null (staff) and writes the master row's id into the
 * description prefix so it's traceable in the ledger.
 */

export type FieldFlag = 'show' | 'hide' | 'optional';

export interface CategoryFieldRules {
  supplier: FieldFlag;        // top-line Supplier picker
  payee: FieldFlag;           // Payee Master picker
  staff: FieldFlag;           // Staff Master picker (Salary / Staff Welfare / etc.)
  utility: FieldFlag;         // Utility Master picker
  container: FieldFlag;       // Import container picker
  brokerLines: FieldFlag;     // Reimbursement line editor
  salaryMonth: FieldFlag;     // Salary month (period label)
  billingMonth: FieldFlag;    // Utility billing month
  reference: FieldFlag;       // Payment reference input
  bankCharges: FieldFlag;     // Utility bank charges
  salesInvoice: FieldFlag;    // Sales Invoice picker (for sales commissions)
  workingDays: FieldFlag;     // Working days input (for casual workers)
  providerTypeToggle: boolean;// Corporate (Badan) vs Individual (Orang Pribadi) toggle
  payeeRoleFilter?: string;   // Filter payees by business role
  payeeLabel?: string;        // User-facing label for the payee field
}

/**
 * Default = show Supplier, hide all specialised pickers, show reference.
 * Every category overrides only what it needs.
 */
const DEFAULT: CategoryFieldRules = {
  supplier:           'show',
  payee:              'hide',
  staff:              'hide',
  utility:            'hide',
  container:          'hide',
  brokerLines:        'hide',
  salaryMonth:        'hide',
  billingMonth:       'hide',
  reference:          'show',
  bankCharges:        'show',
  salesInvoice:       'hide',
  workingDays:        'hide',
  providerTypeToggle: false,
};

const STAFF_RULES: CategoryFieldRules = {
  ...DEFAULT,
  supplier:    'hide',
  staff:       'show',
  salaryMonth: 'show',
};

const UTILITY_RULES: CategoryFieldRules = {
  ...DEFAULT,
  supplier:     'hide',
  utility:      'show',
  billingMonth: 'show',
};

const IMPORT_BROKER_RULES: CategoryFieldRules = {
  ...DEFAULT,
  container:   'show',
  brokerLines: 'show',
};

const PIB_RULES: CategoryFieldRules = {
  ...DEFAULT,
  supplier:   'hide', // Statutory customs duty & taxes are payable to Kas Negara, not a trade supplier
  container:  'show', // Requires import container reference
  payeeLabel: 'Kas Negara (Bea Cukai)',
};

const MARKETING_COMMISSION_RULES: CategoryFieldRules = {
  ...DEFAULT,
  supplier:         'hide',
  payee:            'show',
  salesInvoice:     'show',
  payeeRoleFilter:  'sales_commission_recipient',
  payeeLabel:       'Sales Commission Payee',
};

const CASUAL_LABOR_RULES: CategoryFieldRules = {
  ...DEFAULT,
  supplier:         'hide',
  payee:            'show',
  workingDays:      'show',
  payeeRoleFilter:  'warehouse_labor',
  payeeLabel:       'Casual Worker / Payee',
};

const PROFESSIONAL_SERVICES_RULES: CategoryFieldRules = {
  ...DEFAULT,
  providerTypeToggle: true,
  payeeLabel:         'Individual Consultant / Payee',
};

const RENT_RULES: CategoryFieldRules = {
  ...DEFAULT,
  providerTypeToggle: true,
  payeeRoleFilter:    'property_owner',
  payeeLabel:         'Property Owner / Landlord',
};

/**
 * Categories that map to Staff Master.
 * salary / staff_overtime / staff_welfare / travel_conveyance are all
 * "employee-payable" — they hide the Supplier picker and show the Staff picker.
 */
const STAFF_CATEGORIES = new Set([
  'salary',
  'staff_overtime',
  'staff_welfare',
  'travel_conveyance',
  'staff_advance',
]);

/**
 * Categories that map to Utility Master.
 */
const UTILITY_CATEGORIES = new Set([
  'electricity',
  'water',
  'internet_phone',
  'utilities',
]);

/**
 * Categories that use the broker / reimbursement flow.
 */
const IMPORT_BROKER_CATEGORIES = new Set([
  'import_broker',
]);

const RENT_CATEGORIES = new Set([
  'warehouse_rent',
  'office_rent',
]);

/**
 * Resolve the field-visibility rules for a given expense category.
 * Empty / unknown category returns DEFAULT so the form still renders.
 */
export function getCategoryFieldRules(category: string | null | undefined): CategoryFieldRules {
  const c = (category ?? '').trim();
  if (!c) return DEFAULT;
  if (c === 'marketing_advertising') return MARKETING_COMMISSION_RULES;
  if (c === 'non_permanent_employee_fee') return CASUAL_LABOR_RULES;
  if (c === 'professional_services') return PROFESSIONAL_SERVICES_RULES;
  if (RENT_CATEGORIES.has(c)) return RENT_RULES;
  if (STAFF_CATEGORIES.has(c)) return STAFF_RULES;
  if (UTILITY_CATEGORIES.has(c)) return UTILITY_RULES;
  if (IMPORT_BROKER_CATEGORIES.has(c)) return IMPORT_BROKER_RULES;
  if (c === 'pib_import') return PIB_RULES;
  return DEFAULT;
}

