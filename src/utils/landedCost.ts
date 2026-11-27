/**
 * SAPJ ERP — Single Source of Truth for Landed-Cost Calculations
 *
 * This module defines the authoritative business rules for calculating container
 * landed-cost pools, mirroring the PostgreSQL functions:
 *   - public.is_capitalizable_landed_cost_category(category)
 *   - public.calculate_container_landed_cost_pool(container_id)
 *
 * Tax and Capitalization Rules:
 *   1. Capitalizable categories (exact parity with PostgreSQL public.is_capitalizable_landed_cost_category):
 *      - Duty & customs: 'duty_customs', 'duty', 'duty_import'
 *      - Freight & port: 'freight_import', 'freight', 'port_charges'
 *      - Handling & clearing: 'clearing_forwarding', 'container_handling', 'loading_import'
 *      - Transportation: 'transport_import'
 *      - Customs broker: 'import_broker' (net base: broker invoice minus PPN plus net line items plus stamp duty)
 *      - Other import: 'other_import'
 *      - PIB Import: 'pib_import' (contributes ONLY pib_bm_amount / Bea Masuk)
 *   2. Non-capitalizable / Excluded categories:
 *      - Non-whitelisted legacy transport: 'freight_charges', 'transportation', 'other_import_costs'
 *      - Import PPN (Account 1150 Input VAT) — recoverable tax asset, never capitalized to inventory.
 *      - Import PPh 22 (Account 1155 Prepaid Tax) — prepaid income tax, never capitalized to inventory.
 *      - BPOM / SKI Fees (Account 5410) — operational regulatory registration expense in P&L,
 *        excluded from inventory landed-cost capitalization to prevent double-expensing against COGS 5100.
 *      - General operational expenses: 'staff_welfare', 'office', 'utilities', etc.
 */

import { calculateCanonicalExpenseTotal } from './taxCalculations.ts';

export const BPOM_LANDED_COST_CUTOVER_DATE = '2026-11-27';

export const CAPITALIZABLE_LANDED_COST_CATEGORIES = new Set([
  'duty_customs',
  'duty',
  'duty_import',
  'freight_import',
  'freight',
  'clearing_forwarding',
  'container_handling',
  'loading_import',
  'port_charges',
  'transport_import',
  'import_broker',
  'other_import',
  'pib_import',
  'bpom_ski_fees',
  'bpom_ski',
  'bpom',
]);

export const CAPITALIZABLE_LANDED_COST_CATEGORIES_ARRAY = Array.from(CAPITALIZABLE_LANDED_COST_CATEGORIES);

/**
 * Import-related categories that are associated with import shipments but
 * are NOT capitalized to inventory (e.g. tax balance-sheet assets or non-capitalizable costs).
 */
export const NON_CAPITALIZABLE_IMPORT_CATEGORIES = new Set([
  'ppn_import',
  'pph_import',
  'freight_charges',
  'transportation',
  'other_import_costs',
]);

/**
 * All categories valid for linking or displaying against import shipments and containers.
 */
export const ALL_IMPORT_EXPENSE_CATEGORIES = new Set([
  ...CAPITALIZABLE_LANDED_COST_CATEGORIES,
  ...NON_CAPITALIZABLE_IMPORT_CATEGORIES,
]);

/**
 * Checks whether an expense category belongs to import shipment operations (both capitalizable and non-capitalizable).
 */
export function isImportExpenseCategory(category: string | null | undefined): boolean {
  if (!category) return false;
  const normalized = category.toLowerCase().trim().replace(/ /g, '_');
  return ALL_IMPORT_EXPENSE_CATEGORIES.has(normalized);
}

/**
 * Normalizes category names and checks against the authoritative landed-cost whitelist.
 * Mirrors PostgreSQL `public.is_capitalizable_landed_cost_category(category, effective_date)`.
 */
export function isCapitalizableLandedCostCategory(
  category: string | null | undefined,
  effectiveDate?: string | null,
): boolean {
  if (!category) return false;
  const normalized = category.toLowerCase().trim().replace(/ /g, '_');
  if (normalized === 'bpom_ski_fees' || normalized === 'bpom_ski' || normalized === 'bpom') {
    const dateStr = (effectiveDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
    return dateStr >= BPOM_LANDED_COST_CUTOVER_DATE;
  }
  return CAPITALIZABLE_LANDED_COST_CATEGORIES.has(normalized);
}

export interface LandedCostExpenseInput {
  id: string;
  expense_category: string;
  amount: number;
  description?: string | null;
  voucher_number?: string | null;
  invoice_number?: string | null;
  expense_date?: string | null;
  approval_status?: string | null;
  ppn_amount?: number | null;
  pph_amount?: number | null;
  stamp_duty_amount?: number | null;
  bank_charges_amount?: number | null;
  broker_items?: any[] | null;
  include_in_landed_cost?: boolean | null;
  pib_bm_amount?: number | null;
  pib_ppn_amount?: number | null;
  pib_pph_amount?: number | null;
}

export interface LandedCostPettyCashInput {
  id: string;
  transaction_number?: string | null;
  transaction_type?: string | null;
  amount: number;
  description?: string | null;
  transaction_date?: string | null;
  approval_status?: string | null;
  expense_category?: string | null;
  include_in_landed_cost?: boolean | null;
  finance_expense_id?: string | null;
}

export interface ContainerLandedCostInput {
  linkedExpenses: LandedCostExpenseInput[];
  linkedPettyCash: LandedCostPettyCashInput[];
  inclusionMap?: Record<string, boolean>;
  otherImportCosts?: number | null;
  containerDate?: string | null;
}

export interface ContainerLandedCostBreakdown {
  /** Sum of user-selected capitalizable expenses (excluding PIB duty). */
  selectedLandedExpensesTotal: number;
  /** Sum of user-selected capitalizable petty cash transactions. */
  selectedLandedPettyCashTotal: number;
  /** Sum of all selected capitalizable linked costs (expenses + petty cash). */
  selectedLandedLinkedTotal: number;
  /** Customs Duty (Bea Masuk) from linked PIB expenses. */
  pibDutyTotal: number;
  /** Input PPN from linked PIB expenses (excluded from landed cost). */
  pibPpnTotal: number;
  /** Prepaid PPh 22 from linked PIB expenses (excluded from landed cost). */
  pibPphTotal: number;
  /** Total cash payment required for PIB (Duty + PPN + PPh22). */
  pibPaymentTotal: number;
  /** Historical cash other import costs stored on the container. */
  otherImportCosts: number;
  /** Linked operational expenses excluded from capitalization (e.g. BPOM/SKI fees). */
  excludedOperationalExpensesTotal: number;
  /**
   * The authoritative Landed-Cost Pool for this container.
   * Matches `public.calculate_container_landed_cost_pool(p_container_id)`.
   */
  containerLandedCostPool: number;
}

/**
 * Calculates the exact capitalizable landed-cost amount for an expense item.
 */
export function calculateExpenseLandedCostAmount(expense: LandedCostExpenseInput): {
  amount: number;
  isCapitalizable: boolean;
} {
  if (expense.approval_status != null && expense.approval_status !== 'approved') {
    return {
      amount: 0,
      isCapitalizable: false,
    };
  }

  const isCapitalizable = isCapitalizableLandedCostCategory(
    expense.expense_category,
    expense.expense_date,
  );
  if (!isCapitalizable) {
    return {
      amount: 0,
      isCapitalizable: false,
    };
  }

  if (expense.expense_category === 'pib_import') {
    return {
      amount: Number(expense.pib_bm_amount || 0),
      isCapitalizable: true,
    };
  }

  if (expense.expense_category === 'import_broker') {
    return {
      amount: calculateCanonicalExpenseTotal(expense as any),
      isCapitalizable: true,
    };
  }

  return {
    amount: Number(expense.amount || 0),
    isCapitalizable: true,
  };
}

/**
 * Authoritative single calculation function for the container landed-cost pool.
 */
export function calculateContainerLandedCostPool(
  input: ContainerLandedCostInput,
): ContainerLandedCostBreakdown {
  const {
    linkedExpenses = [],
    linkedPettyCash = [],
    inclusionMap = {},
    otherImportCosts = 0,
    containerDate = null,
  } = input;

  let selectedLandedExpensesTotal = 0;
  let excludedOperationalExpensesTotal = 0;
  const capitalizedExpenseIds = new Set<string>();

  for (const exp of linkedExpenses) {
    if (exp.approval_status != null && exp.approval_status !== 'approved') {
      continue;
    }

    if (exp.expense_category === 'pib_import') {
      continue; // Handled separately in PIB breakdown
    }

    const isSelected = inclusionMap[exp.id] ?? (exp.include_in_landed_cost === true);
    const { amount, isCapitalizable } = calculateExpenseLandedCostAmount(exp);

    if (isCapitalizable) {
      if (isSelected) {
        selectedLandedExpensesTotal += amount;
        capitalizedExpenseIds.add(exp.id);
      }
    } else {
      // Non-capitalizable (e.g. pre-cutover BPOM/SKI fees)
      if (isSelected) {
        excludedOperationalExpensesTotal += Number(exp.amount || 0);
      }
    }
  }

  let selectedLandedPettyCashTotal = 0;
  for (const pc of linkedPettyCash) {
    if (pc.approval_status != null && pc.approval_status !== 'approved') {
      continue;
    }
    if (pc.finance_expense_id && capitalizedExpenseIds.has(pc.finance_expense_id)) {
      continue; // Never double-count petty cash linked to an already-capitalized finance expense
    }

    const isSelected = inclusionMap[pc.id] ?? (pc.include_in_landed_cost === true);
    const isCapitalizable = isCapitalizableLandedCostCategory(
      pc.expense_category || pc.transaction_type,
      pc.transaction_date,
    );

    if (isCapitalizable) {
      if (isSelected) {
        selectedLandedPettyCashTotal += Number(pc.amount || 0);
      }
    } else {
      if (isSelected) {
        excludedOperationalExpensesTotal += Number(pc.amount || 0);
      }
    }
  }

  const pibExpenses = linkedExpenses.filter(
    (e) =>
      e.expense_category === 'pib_import' &&
      (e.approval_status == null || e.approval_status === 'approved'),
  );
  const pibDutyTotal = pibExpenses.reduce((sum, e) => {
    const expDate = (e.expense_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const isSelected =
      expDate < BPOM_LANDED_COST_CUTOVER_DATE
        ? (inclusionMap[e.id] ?? (e.include_in_landed_cost !== false))
        : (inclusionMap[e.id] ?? (e.include_in_landed_cost === true));
    return isSelected ? sum + Number(e.pib_bm_amount || 0) : sum;
  }, 0);
  const pibPpnTotal = pibExpenses.reduce((sum, e) => sum + Number(e.pib_ppn_amount || 0), 0);
  const pibPphTotal = pibExpenses.reduce((sum, e) => sum + Number(e.pib_pph_amount || 0), 0);
  const pibPaymentTotal = pibExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);

  const isLegacyContainer =
    containerDate != null && containerDate.slice(0, 10) < BPOM_LANDED_COST_CUTOVER_DATE;
  const normalizedOtherImportCosts = isLegacyContainer
    ? Math.round(Number(otherImportCosts || 0) * 100) / 100
    : 0;
  const selectedLandedLinkedTotal = Math.round((selectedLandedExpensesTotal + selectedLandedPettyCashTotal) * 100) / 100;

  const rawPool = selectedLandedLinkedTotal + pibDutyTotal + normalizedOtherImportCosts;
  const containerLandedCostPool = Math.round(rawPool * 100) / 100;

  return {
    selectedLandedExpensesTotal: Math.round(selectedLandedExpensesTotal * 100) / 100,
    selectedLandedPettyCashTotal: Math.round(selectedLandedPettyCashTotal * 100) / 100,
    selectedLandedLinkedTotal,
    pibDutyTotal: Math.round(pibDutyTotal * 100) / 100,
    pibPpnTotal: Math.round(pibPpnTotal * 100) / 100,
    pibPphTotal: Math.round(pibPphTotal * 100) / 100,
    pibPaymentTotal: Math.round(pibPaymentTotal * 100) / 100,
    otherImportCosts: normalizedOtherImportCosts,
    excludedOperationalExpensesTotal: Math.round(excludedOperationalExpensesTotal * 100) / 100,
    containerLandedCostPool,
  };
}
