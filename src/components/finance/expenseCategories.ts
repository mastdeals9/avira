import {
  FileText, Building2, Package, Truck, DollarSign,
} from 'lucide-react';

export interface ExpenseCategoryDef {
  value: string;
  label: string;
  type: 'import' | 'sales' | 'staff' | 'operations' | 'admin';
  icon: typeof FileText;
  description: string;
  requiresContainer: boolean;
  group: string;
}

export const moduleExpenseCategories: ExpenseCategoryDef[] = [
  { value: 'pib_import', label: 'PIB Import (BM + PPN + PPh)', type: 'import', icon: FileText, description: 'ONE bank payment from the official PIB document covering Import Duty (BM), PPN Import, and PPh 22 Import. Requires breakdown.', requiresContainer: true, group: 'Import Costs' },
  { value: 'duty_customs', label: 'Duty & Customs (BM)', type: 'import', icon: Building2, description: 'Import duties and customs charges - CAPITALIZED to inventory', requiresContainer: true, group: 'Import Costs' },
  { value: 'ppn_import', label: 'PPN Import', type: 'import', icon: Building2, description: 'Import VAT - posted to PPN Masukan (Input VAT). NOT an expense. NOT in landed cost.', requiresContainer: true, group: 'Import Costs' },
  { value: 'pph_import', label: 'PPh Import', type: 'import', icon: Building2, description: 'Import withholding tax (PPh 22) - posted to Advance Income Tax. NOT an expense. NOT in landed cost.', requiresContainer: true, group: 'Import Costs' },
  { value: 'freight_import', label: 'Freight (Import)', type: 'import', icon: Package, description: 'International freight charges - CAPITALIZED to inventory', requiresContainer: true, group: 'Import Costs' },
  { value: 'clearing_forwarding', label: 'Clearing & Forwarding', type: 'import', icon: Building2, description: 'Customs clearance - CAPITALIZED to inventory', requiresContainer: true, group: 'Import Costs' },
  { value: 'port_charges', label: 'Port Charges', type: 'import', icon: Building2, description: 'Port handling charges - CAPITALIZED to inventory', requiresContainer: true, group: 'Import Costs' },
  { value: 'container_handling', label: 'Container Handling', type: 'import', icon: Package, description: 'Container unloading - CAPITALIZED to inventory', requiresContainer: true, group: 'Import Costs' },
  { value: 'transport_import', label: 'Transportation (Import)', type: 'import', icon: Truck, description: 'Port to godown transport - CAPITALIZED to inventory', requiresContainer: true, group: 'Import Costs' },
  { value: 'loading_import', label: 'Loading / Unloading (Import)', type: 'import', icon: Truck, description: 'Import container loading/unloading - CAPITALIZED to inventory', requiresContainer: true, group: 'Import Costs' },
  { value: 'bpom_ski_fees', label: 'BPOM / SKI Fees', type: 'import', icon: FileText, description: 'BPOM/SKI regulatory fees - CAPITALIZED to inventory', requiresContainer: true, group: 'Import Costs' },
  { value: 'other_import', label: 'Other (Import)', type: 'import', icon: DollarSign, description: 'Other import-related expenses - CAPITALIZED to inventory', requiresContainer: true, group: 'Import Costs' },
  { value: 'delivery_sales', label: 'Delivery / Dispatch (Sales)', type: 'sales', icon: Truck, description: 'Customer delivery - EXPENSED to P&L', requiresContainer: false, group: 'Sales & Distribution' },
  { value: 'loading_sales', label: 'Loading / Unloading (Sales)', type: 'sales', icon: Truck, description: 'Sales loading charges - EXPENSED to P&L', requiresContainer: false, group: 'Sales & Distribution' },
  { value: 'other_sales', label: 'Other (Sales)', type: 'sales', icon: DollarSign, description: 'Other sales-related expenses - EXPENSED to P&L', requiresContainer: false, group: 'Sales & Distribution' },
  { value: 'salary', label: 'Salary', type: 'staff', icon: DollarSign, description: 'Staff salaries - EXPENSED to P&L', requiresContainer: false, group: 'Staff Costs' },
  { value: 'staff_overtime', label: 'Staff Overtime', type: 'staff', icon: DollarSign, description: 'Overtime payments - EXPENSED to P&L', requiresContainer: false, group: 'Staff Costs' },
  { value: 'staff_welfare', label: 'Staff Welfare / Allowances', type: 'staff', icon: DollarSign, description: 'Driver food, snacks, overtime meals, welfare - EXPENSED to P&L', requiresContainer: false, group: 'Staff Costs' },
  { value: 'non_permanent_employee_fee', label: 'Non-Permanent Employee Fee (PPh 21)', type: 'staff', icon: DollarSign, description: 'Freelancer, casual worker, honorarium, and other non-permanent individual income subject to PPh 21 - EXPENSED to P&L', requiresContainer: false, group: 'Staff Costs' },
  { value: 'travel_conveyance', label: 'Travel & Conveyance', type: 'staff', icon: Truck, description: 'Local travel, taxi, fuel reimbursements, tolls - EXPENSED to P&L', requiresContainer: false, group: 'Staff Costs' },
  { value: 'staff_advance', label: 'Staff Advance', type: 'staff', icon: DollarSign, description: 'Advance paid to staff - booked to Staff Advances (ASSET), recovered against salary', requiresContainer: false, group: 'Staff Costs' },
  { value: 'warehouse_rent', label: 'Warehouse Rent', type: 'operations', icon: Building2, description: 'Rent expense - EXPENSED to P&L', requiresContainer: false, group: 'Operations' },
  { value: 'utilities', label: 'Utilities', type: 'operations', icon: Building2, description: 'Electricity, water, etc - EXPENSED to P&L', requiresContainer: false, group: 'Operations' },
  { value: 'electricity', label: 'Electricity', type: 'operations', icon: Building2, description: 'Electricity bills (PLN) - EXPENSED to P&L', requiresContainer: false, group: 'Operations' },
  { value: 'water', label: 'Water', type: 'operations', icon: Building2, description: 'Water bills (PAM) - EXPENSED to P&L', requiresContainer: false, group: 'Operations' },
  { value: 'internet_phone', label: 'Telephone & Internet', type: 'operations', icon: Building2, description: 'Phone and internet charges (Telkom) - EXPENSED to P&L', requiresContainer: false, group: 'Operations' },
  { value: 'facility_maintenance', label: 'Cleaning & Maintenance', type: 'operations', icon: Building2, description: 'Office and warehouse cleaning and maintenance - EXPENSED to P&L', requiresContainer: false, group: 'Operations' },
  { value: 'bank_charges', label: 'Bank Charges', type: 'operations', icon: DollarSign, description: 'Bank fees, charges, and transaction costs - EXPENSED to P&L', requiresContainer: false, group: 'Operations' },
  { value: 'office_admin', label: 'Office & Admin', type: 'admin', icon: Building2, description: 'General admin expenses - EXPENSED to P&L', requiresContainer: false, group: 'Administrative' },
  { value: 'office_shifting_renovation', label: 'Office Shifting & Renovation', type: 'admin', icon: Building2, description: 'Office shifting, partition work, electrical, cabling, interior renovation - EXPENSED to P&L', requiresContainer: false, group: 'Administrative' },
  { value: 'other', label: 'Other', type: 'admin', icon: DollarSign, description: 'Miscellaneous expenses - EXPENSED to P&L', requiresContainer: false, group: 'Administrative' },
  { value: 'fixed_asset', label: 'Fixed Asset', type: 'admin', icon: Building2, description: 'Purchase of fixed asset (equipment, vehicle, etc.) - CAPITALIZED to asset account', requiresContainer: false, group: 'Administrative' },
  { value: 'import_broker', label: 'Customs Broker Invoice', type: 'admin', icon: FileText, description: 'Invoice from customs broker for clearing, forwarding, DO charges, port fees — EXPENSED to P&L (COA 5300)', requiresContainer: false, group: 'Supplier Invoices' },
  { value: 'professional_services', label: 'Professional Services', type: 'admin', icon: DollarSign, description: 'Legal, accounting, consulting, or other professional fees — EXPENSED to P&L (COA 6700)', requiresContainer: false, group: 'Supplier Invoices' },
];

export const EXPENSE_CATEGORY_GROUP_ORDER: Record<string, number> = {
  'Import Costs': 1,
  'Sales & Distribution': 2,
  'Staff Costs': 3,
  'Operations': 4,
  'Administrative': 5,
  'Supplier Invoices': 6,
};

export function getExpenseCategoryDef(value: string): ExpenseCategoryDef | undefined {
  return moduleExpenseCategories.find(c => c.value === value);
}

export function sortExpenseCategories<T extends ExpenseCategoryDef>(cats: T[]): T[] {
  return [...cats].sort((a, b) => {
    const aOrder = EXPENSE_CATEGORY_GROUP_ORDER[a.group] ?? 999;
    const bOrder = EXPENSE_CATEGORY_GROUP_ORDER[b.group] ?? 999;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.label.localeCompare(b.label);
  });
}
