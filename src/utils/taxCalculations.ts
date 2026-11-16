/**
 * taxCalculations.ts
 * Shared utilities for the Finance / Expense module.
 *
 * Key design constraints:
 *   - Document Type is a UI-only grouping concept (no DB column).
 *   - PPN Import and PPh Import ONLY appear inside the PIB workflow.
 *     They must NEVER be shown as standalone expense categories.
 *   - PIB (pib_import) is completely separate from the Import/Customs Broker invoice.
 *   - All amounts in IDR; no currency conversion here.
 */
import { normalizeExpenseBankLinks } from './expenseBankLinks.ts';

// ---------------------------------------------------------------------------
// Document Type definitions
// ---------------------------------------------------------------------------

/** All document types visible in the Expense form. */
export const DOCUMENT_TYPES = [
  'Operating Expense',
  'Utility',
  'Staff Expense',
  'Sales & Distribution',
  'Professional Services',
  'Import / Customs Broker Invoice',
  'Fixed Asset',
  'PIB',
] as const;

export type DocumentType = typeof DOCUMENT_TYPES[number];

// ---------------------------------------------------------------------------
// Document Type → expense_category mapping
// ---------------------------------------------------------------------------
// These are the expense_category values that appear under each Document Type.
// PPN Import (ppn_import) and PPh Import (pph_import) are intentionally
// omitted — they belong exclusively inside the PIB workflow.

export const DOCUMENT_TYPE_GROUPS: Record<DocumentType, string[]> = {
  'Operating Expense':                ['warehouse_rent', 'bank_charges', 'office_admin', 'office_shifting_renovation', 'facility_maintenance', 'other'],
  'Utility':                          ['electricity', 'water', 'internet_phone', 'utilities'],
  'Staff Expense':                    ['salary', 'staff_overtime', 'staff_welfare', 'travel_conveyance', 'non_permanent_employee_fee'],
  'Sales & Distribution':             ['marketing_advertising', 'delivery_sales', 'loading_sales', 'other_sales'],
  'Professional Services':            ['professional_services'],
  'Import / Customs Broker Invoice':  ['import_broker'],
  'Fixed Asset':                      ['fixed_asset'],
  'PIB':                              ['pib_import'],
};

/** Returns the Document Type that owns a given expense_category. */
export function getDocTypeForCategory(category: string): DocumentType | null {
  for (const [docType, cats] of Object.entries(DOCUMENT_TYPE_GROUPS) as [DocumentType, string[]][]) {
    if (cats.includes(category)) return docType;
  }
  return null;
}

/** Auto-selects category when a Document Type has exactly one. */
export function getSingleCategoryForDocType(docType: DocumentType): string | null {
  const cats = DOCUMENT_TYPE_GROUPS[docType];
  return cats.length === 1 ? cats[0] : null;
}

// ---------------------------------------------------------------------------
// Tax field visibility per Document Type
// ---------------------------------------------------------------------------

export interface TaxFieldConfig {
  /** Show PPN Input field */
  ppn: boolean;
  /** Show PPh 23 fields */
  pph23: boolean;
  /** Show PPh 21 fields */
  pph21: boolean;
  /** Show Bea Meterai (Stamp Duty) field */
  stamp: boolean;
  /** Show PIB breakdown fields (BM, PPN Import, PPh 22) */
  pib: boolean;
  /** Show broker item sub-cost breakdown */
  brokerItems: boolean;
}

export const DOCUMENT_TYPE_TAX_CONFIG: Record<DocumentType, TaxFieldConfig> = {
  'Operating Expense':               { ppn: true,  pph23: true,  pph21: false, stamp: true,  pib: false, brokerItems: false },
  'Utility':                         { ppn: true,  pph23: true,  pph21: false, stamp: false, pib: false, brokerItems: false },
  'Staff Expense':                   { ppn: false, pph23: false, pph21: true,  stamp: false, pib: false, brokerItems: false },
  'Sales & Distribution':            { ppn: false, pph23: false, pph21: true,  stamp: false, pib: false, brokerItems: false },
  'Professional Services':           { ppn: true,  pph23: true,  pph21: true,  stamp: true,  pib: false, brokerItems: false },
  'Import / Customs Broker Invoice': { ppn: true,  pph23: true,  pph21: false, stamp: true,  pib: false, brokerItems: true  },
  'Fixed Asset':                     { ppn: true,  pph23: false, pph21: false, stamp: false, pib: false, brokerItems: false },
  'PIB':                             { ppn: false, pph23: false, pph21: false, stamp: false, pib: true,  brokerItems: false },
};

// ---------------------------------------------------------------------------
// Broker item types (for Import / Customs Broker Invoice breakdown)
// ---------------------------------------------------------------------------

export const BROKER_ITEM_TYPES = [
  { value: 'do_charges',         label: 'D/O Charges' },
  { value: 'port_charges',       label: 'Port Charges' },
  { value: 'clearing_forwarding',label: 'Clearing & Forwarding' },
  { value: 'handling',           label: 'Handling' },
  { value: 'truck',              label: 'Trucking' },
  { value: 'freight',            label: 'Freight' },
  { value: 'administration',     label: 'Administration' },
  { value: 'other',              label: 'Other' },
] as const;

export type BrokerItemType = typeof BROKER_ITEM_TYPES[number]['value'];

export type BrokerPpnTreatment = 'none' | 'excluded' | 'included';

export interface BrokerItem {
  type: BrokerItemType;
  description: string;
  amount: number;
  // Present on every line created or edited by the corrected calculation
  // engine. Unmarked rows are historical and may use the legacy empty-amount
  // compatibility fallback.
  invoice_amount_authoritative?: boolean;
  // ── Optional multi-supplier / PPN fields (added 2026-07-03) ──
  // NOTE: this per-line supplier_id is used ONLY for tax-invoice display and the
  // PPN register (vw_input_ppn_report Branch 5). It NEVER replaces or overrides
  // finance_expenses.supplier_id (the main invoice supplier used by AP, Aging,
  // Supplier Ledger, Expense Listing, Trial Balance, etc).
  supplier_id?: string | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  // Faktur Pajak (Indonesian tax invoice) number — separate from commercial
  // invoice_number since a supplier's tax invoice # differs from their
  // commercial invoice #. Both are captured for the Input PPN report.
  tax_invoice_number?: string | null;
  ppn_treatment?: BrokerPpnTreatment;
  ppn_amount?: number;
  // ── Indonesian tax invoice fields (added 2026-07-07) ──
  // dpp_amount   = Dasar Pengenaan Pajak (taxable base). If NULL, treated as
  //                = line.amount for legacy rows.
  // ppn_rate     = tax rate as percentage (0, 11, 12, custom). NULL for legacy.
  // Line PPN Amount = round(dpp_amount * ppn_rate / 100) unless manually overridden.
  dpp_amount?: number;
  ppn_rate?: number;
  npwp?: string | null;
  container_reference?: string | null;
  attachment_path?: string | null;
}

/** For an amount that ALREADY includes 11% PPN, return {dpp, ppn}. */
export function extractPpnFromInclusive(amountInclusive: number): { dpp: number; ppn: number } {
  const dpp = Math.round(amountInclusive / 1.11);
  return { dpp, ppn: amountInclusive - dpp };
}

/** Compute per-line PPN based on treatment (excluded/included/none). */
export function computeBrokerLinePpn(
  amount: number,
  treatment: BrokerPpnTreatment | undefined,
): number {
  if (!amount || amount <= 0) return 0;
  if (treatment === 'excluded') return Math.round(amount * 0.11);
  if (treatment === 'included') return extractPpnFromInclusive(amount).ppn;
  return 0;
}

/** Returns the sum of all broker item amounts. */
export function sumBrokerItems(items: BrokerItem[]): number {
  return items.reduce((sum, item) => sum + (item.amount || 0), 0);
}

/**
 * The broker invoice calculation is intentionally separate from the generic
 * finance_expenses total. Broker invoices contain an independent header
 * invoice plus pass-through reimbursement lines.
 */
export interface BrokerExpenseTotalsInput {
  amount?: number | null;
  dpp_amount?: number | null;
  ppn_amount?: number | null;
  pph_amount?: number | null;
  stamp_duty_amount?: number | null;
  broker_items?: BrokerItem[] | null;
}

export interface BrokerExpenseTotals {
  brokerInvoiceAmount: number;
  brokerInvoiceDpp: number;
  reimbursementTotal: number;
  reimbursementDpp: number;
  reimbursementPpn: number;
  totalPpn: number;
  recoverableInputPpn: number;
  pphWithheld: number;
  pph23Withheld: number;
  stampDuty: number;
  accountingExpenseTotal: number;
  expenseTotal: number;
  finalCashPayable: number;
  totalPayable: number;
}

/**
 * Actual reimbursement payable used by every broker presentation/AP view.
 *
 * Invoice Amount is authoritative. DPP and PPN are independent tax-reporting
 * values and must never be added to a populated Invoice Amount. The fallback
 * preserves historical rows created before Invoice Amount became mandatory.
 */
export function brokerLineTotal(item: BrokerItem): number {
  const amount = Number(item.amount) || 0;
  const dpp = Number(item.dpp_amount) || 0;
  const ppn = Number(item.ppn_amount) || 0;
  if (item.invoice_amount_authoritative === true) return amount;
  return amount !== 0 ? amount : dpp + ppn;
}

/** Expense base for a reimbursement line; recoverable PPN is never expensed. */
export function brokerLineExpenseBase(item: BrokerItem): number {
  return brokerLineTotal(item) - (Number(item.ppn_amount) || 0);
}

export function calculateBrokerReimbursementTotal(items: BrokerItem[] | null | undefined): number {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => sum + brokerLineTotal(item), 0);
}

export function calculateBrokerExpenseTotals(exp: BrokerExpenseTotalsInput): BrokerExpenseTotals {
  const items = Array.isArray(exp.broker_items) ? exp.broker_items : [];
  const brokerInvoiceAmount = Number(exp.amount) || 0;
  const brokerInvoiceDpp = Number(exp.dpp_amount) || 0;
  const reimbursementTotal = calculateBrokerReimbursementTotal(items);
  const reimbursementDpp = items.reduce((sum, item) => sum + (Number(item.dpp_amount) || 0), 0);
  const reimbursementPpn = items.reduce((sum, item) => sum + (Number(item.ppn_amount) || 0), 0);
  const headerPpn = Number(exp.ppn_amount) || 0;
  const totalPpn = headerPpn + reimbursementPpn;
  const pphWithheld = Number(exp.pph_amount) || 0;
  const stampDuty = Number(exp.stamp_duty_amount) || 0;
  const accountingExpenseTotal = brokerInvoiceAmount - headerPpn
    + items.reduce((sum, item) => sum + brokerLineExpenseBase(item), 0)
    + stampDuty;
  const expenseTotal = brokerInvoiceAmount + reimbursementTotal + stampDuty;
  // Invoice Amount already represents the supplier payable. DPP and PPN are
  // reporting values only and never increase the cash target.
  const finalCashPayable = expenseTotal - pphWithheld;

  return {
    brokerInvoiceAmount,
    brokerInvoiceDpp,
    reimbursementTotal,
    reimbursementDpp,
    reimbursementPpn,
    totalPpn,
    recoverableInputPpn: totalPpn,
    pphWithheld,
    pph23Withheld: pphWithheld,
    stampDuty,
    accountingExpenseTotal,
    expenseTotal,
    finalCashPayable,
    totalPayable: finalCashPayable,
  };
}

// ---------------------------------------------------------------------------
// Tax calculations
// ---------------------------------------------------------------------------

/** Indonesian PPN (VAT) — 11% on DPP (taxable base). Returns 0 if not PKP. */
export function calculatePPN(
  dppAmount: number,
  isSupplierPKP: boolean,
  rate = 11,
): number {
  if (!isSupplierPKP || dppAmount <= 0) return 0;
  // Round to nearest rupiah
  return Math.round(dppAmount * rate / 100);
}

/**
 * PPh amount calculation.
 * rate is the withholding rate as a percentage (e.g. 2 for PPh 23 at 2%).
 * DPP for PPh 23 = gross expense (before PPN) = `amount`.
 */
export function calculatePPh(
  dppAmount: number,
  ratePercent: number,
): number {
  if (dppAmount <= 0 || ratePercent <= 0) return 0;
  return Math.round(dppAmount * ratePercent / 100);
}

// ---------------------------------------------------------------------------
// PPh Calculation Regimes & Multi-Bracket Engine
// ---------------------------------------------------------------------------

export type PphCalculationRegime =
  | 'pasal17_dpp50'          // Bukan Pegawai / Tenaga Ahli (DPP 50%, Article 17 marginal progressive brackets)
  | 'ter_harian_lepas'       // Pegawai Tidak Tetap / Harian Lepas (PP 58/2023 & PMK 168/2023)
  | 'pph_final_4_2'          // PPh Final Pasal 4 Ayat (2) - 10% on Gross Rent
  | 'standard_fixed'         // Standard fixed percentage on Gross (e.g. PPh 23 2%, PPh 22 2.5%)
  | 'manual';                // Manual accountant override

/**
 * Article 17 Indonesian Individual Income Tax Brackets (UU HPP / Harmonized Tax Law).
 * Applies to cumulative DPP (taxable base) within a calendar year.
 */
export interface Article17Bracket {
  ceiling: number;
  rate: number;
}

export const ARTICLE_17_BRACKETS: readonly Article17Bracket[] = [
  { ceiling: 60_000_000, rate: 0.05 },       // 0 - 60M: 5%
  { ceiling: 250_000_000, rate: 0.15 },      // 60M - 250M: 15%
  { ceiling: 500_000_000, rate: 0.25 },      // 250M - 500M: 25%
  { ceiling: 5_000_000_000, rate: 0.30 },    // 500M - 5B: 30%
  { ceiling: Infinity, rate: 0.35 },         // > 5B: 35%
] as const;

/**
 * Bukan Pegawai / Tenaga Ahli (Sales commission recipients, consultants, notaries):
 *   - DPP = 50% of Gross Amount (PP 58/2023 / PMK 168/2023 Pasal 12).
 *   - Tax calculated cumulatively across Article 17 brackets.
 *   - Correctly splits marginal amounts when a payment crosses bracket boundaries.
 */
export function calculatePPh21NonEmployeeCumulative(
  gross: number,
  priorCumulativeDpp = 0,
): {
  dppRatio: number;
  dppAmount: number;
  pphAmount: number;
  effectiveRateOnGross: number;
  effectiveRateOnDpp: number;
  newCumulativeDpp: number;
} {
  if (gross <= 0) {
    return {
      dppRatio: 0.5,
      dppAmount: 0,
      pphAmount: 0,
      effectiveRateOnGross: 0,
      effectiveRateOnDpp: 0,
      newCumulativeDpp: priorCumulativeDpp,
    };
  }

  const dppAmount = Math.round(gross * 0.5);
  const startDpp = Math.max(0, priorCumulativeDpp);
  const endDpp = startDpp + dppAmount;

  let totalTax = 0;
  let lowerBound = 0;

  for (const b of ARTICLE_17_BRACKETS) {
    const upperBound = b.ceiling;
    // Overlap between [startDpp, endDpp] and [lowerBound, upperBound]
    const taxableInBracket = Math.max(0, Math.min(endDpp, upperBound) - Math.max(startDpp, lowerBound));
    if (taxableInBracket > 0) {
      totalTax += taxableInBracket * b.rate;
    }
    lowerBound = upperBound;
    if (endDpp <= upperBound) break;
  }

  const pphAmount = Math.round(totalTax);
  const effectiveRateOnGross = gross > 0 ? Number(((pphAmount / gross) * 100).toFixed(2)) : 0;
  const effectiveRateOnDpp = dppAmount > 0 ? Number(((pphAmount / dppAmount) * 100).toFixed(2)) : 0;

  return {
    dppRatio: 0.5,
    dppAmount,
    pphAmount,
    effectiveRateOnGross,
    effectiveRateOnDpp,
    newCumulativeDpp: endDpp,
  };
}

/**
 * Pegawai Tidak Tetap / Harian Lepas (Warehouse casual labor, temporary crew):
 * Under PP 58/2023 & PMK 168/2023 Pasal 13:
 *   - Daily wage = gross / workingDays.
 *   - Daily wage <= Rp 450.000: 0% tax (Non-taxable / Bebas Pajak).
 *   - Daily wage > Rp 450.000 and <= Rp 2.500.000: 0.5% TER Harian on gross.
 *   - Daily wage > Rp 2.500.000: 5% rate.
 */
export function calculatePPh21CasualLabor(
  gross: number,
  workingDays = 1,
): {
  dppRatio: number;
  dppAmount: number;
  pphAmount: number;
  effectiveRateOnGross: number;
  dailyWage: number;
} {
  if (gross <= 0) {
    return { dppRatio: 1.0, dppAmount: 0, pphAmount: 0, effectiveRateOnGross: 0, dailyWage: 0 };
  }
  const days = Math.max(1, workingDays);
  const dailyWage = Math.round(gross / days);

  if (dailyWage <= 450_000) {
    return {
      dppRatio: 1.0,
      dppAmount: gross,
      pphAmount: 0,
      effectiveRateOnGross: 0,
      dailyWage,
    };
  } else if (dailyWage <= 2_500_000) {
    const pphAmount = Math.round(gross * 0.005); // 0.5% TER Harian
    return {
      dppRatio: 1.0,
      dppAmount: gross,
      pphAmount,
      effectiveRateOnGross: 0.5,
      dailyWage,
    };
  } else {
    const pphAmount = Math.round(gross * 0.05);
    return {
      dppRatio: 1.0,
      dppAmount: gross,
      pphAmount,
      effectiveRateOnGross: 5.0,
      dailyWage,
    };
  }
}

/**
 * PPh Final Pasal 4 Ayat (2) - Sewa Tanah / Bangunan:
 *   - DPP = 100% of gross rental amount.
 *   - Fixed statutory rate = 10%.
 */
export function calculatePPhFinal4_2(gross: number): {
  dppRatio: number;
  dppAmount: number;
  pphAmount: number;
  effectiveRateOnGross: number;
} {
  if (gross <= 0) {
    return { dppRatio: 1.0, dppAmount: 0, pphAmount: 0, effectiveRateOnGross: 0 };
  }
  const pphAmount = Math.round(gross * 0.10);
  return {
    dppRatio: 1.0,
    dppAmount: gross,
    pphAmount,
    effectiveRateOnGross: 10.0,
  };
}

export interface TaxCalculationResult {
  regime: PphCalculationRegime;
  dppRatio: number;
  dppAmount: number;
  pphRate: number;
  pphAmount: number;
}

/**
 * Canonical calculator for expense PPh withholding.
 * Authoritative: Uses selected tax code and payee classification to determine regime.
 */
export function computeExpensePPh(params: {
  grossAmount: number;
  taxCode?: { code: string; tax_type: string; rate: number } | null;
  payeeClassification?: string | null;
  regimeOverride?: PphCalculationRegime | null;
  workingDays?: number;
  priorCumulativeDpp?: number;
}): TaxCalculationResult {
  const { grossAmount, taxCode, payeeClassification, regimeOverride, workingDays = 1, priorCumulativeDpp = 0 } = params;

  if (!taxCode || grossAmount <= 0) {
    return {
      regime: 'standard_fixed',
      dppRatio: 1.0,
      dppAmount: grossAmount,
      pphRate: 0,
      pphAmount: 0,
    };
  }

  let regime: PphCalculationRegime = regimeOverride || 'standard_fixed';
  if (!regimeOverride) {
    if (taxCode.code === 'PPH21-NE' || payeeClassification === 'bukan_pegawai_komisi' || payeeClassification === 'tenaga_ahli' || payeeClassification === 'bukan_pegawai_imbalan') {
      regime = 'pasal17_dpp50';
    } else if (taxCode.code === 'PPH21-TT' || payeeClassification === 'pegawai_tidak_tetap') {
      regime = 'ter_harian_lepas';
    } else if (taxCode.code === 'PPH4(2)' || payeeClassification === 'pemilik_sewa_op') {
      regime = 'pph_final_4_2';
    } else if (taxCode.tax_type === 'PPh21') {
      regime = 'pasal17_dpp50';
    } else {
      regime = 'standard_fixed';
    }
  }

  if (regime === 'pasal17_dpp50') {
    const res = calculatePPh21NonEmployeeCumulative(grossAmount, priorCumulativeDpp);
    return {
      regime: 'pasal17_dpp50',
      dppRatio: res.dppRatio,
      dppAmount: res.dppAmount,
      pphRate: res.effectiveRateOnGross,
      pphAmount: res.pphAmount,
    };
  }

  if (regime === 'ter_harian_lepas') {
    const res = calculatePPh21CasualLabor(grossAmount, workingDays);
    return {
      regime: 'ter_harian_lepas',
      dppRatio: res.dppRatio,
      dppAmount: res.dppAmount,
      pphRate: res.effectiveRateOnGross,
      pphAmount: res.pphAmount,
    };
  }

  if (regime === 'pph_final_4_2') {
    const res = calculatePPhFinal4_2(grossAmount);
    return {
      regime: 'pph_final_4_2',
      dppRatio: res.dppRatio,
      dppAmount: res.dppAmount,
      pphRate: res.effectiveRateOnGross,
      pphAmount: res.pphAmount,
    };
  }

  // Standard fixed rate (PPh 23 2%, PPh 23 15%, PPh 22 2.5%, etc.)
  const rate = Number(taxCode.rate) || 0;
  const pphAmount = Math.round((grossAmount * rate) / 100);
  return {
    regime: 'standard_fixed',
    dppRatio: 1.0,
    dppAmount: grossAmount,
    pphRate: rate,
    pphAmount,
  };
}

// ---------------------------------------------------------------------------
// Expense totals — single source of truth
// ---------------------------------------------------------------------------
// This is the ONLY place the "net payable" formula for a finance_expenses row
// is defined on the client. Every screen (Expense form, Payment Voucher, Bank
// Reconciliation, Payables, Party Ledger) must call this so the numbers stay
// consistent across the ERP.
//
// The formula mirrors the DB trigger auto_post_expense_accounting
// (supabase/migrations/20260721123642_...sql line 222-226) which is the
// authoritative posting engine. Do not diverge from that formula.
//
//   net_payable = amount + ppn − pph + stamp_duty + bank_charges
//
// bank_charges_amount is an additional cash component whenever it is present
// on a paid expense. The journal/payment workflow is authoritative for whether
// a charge was actually posted; the display must not omit it based on a stale
// or legacy category label.

/** Input shape — accepts any object with finance_expenses-style fields. */
export interface ExpenseTotalsInput {
  amount?: number | null;
  ppn_amount?: number | null;
  pph_amount?: number | null;
  pph_treatment?: 'deduct' | 'add' | string | null;
  stamp_duty_amount?: number | null;
  bank_charges_amount?: number | null;
  bpjs_employee_deduction?: number | null;
  expense_category?: string | null;
}

export interface ExpenseTotals {
  amount: number;
  ppnAmount: number;
  pphAmount: number;
  pphTreatment: 'deduct' | 'add';
  stampDutyAmount: number;
  bpjsEmployeeDeduction: number;
  /** Additional bank charges included in the actual cash payment. */
  bankChargesAmount: number;
  /** Supplier/employee payable before bank-owned charges. */
  netPayable: number;
  /** Actual bank movement: net payable plus bank-owned charges. */
  settlementAmount: number;
  /** Total cash outflow required (recipient payable + tax authority remittance). */
  totalCashOutflow: number;
}

/**
 * Returns the canonical financial totals for a finance_expenses row.
 * Every displayed "total payable" in the ERP should come from here.
 */
export function calculateExpenseTotals(exp: ExpenseTotalsInput): ExpenseTotals {
  const amount = Number(exp.amount) || 0;
  const ppn = Number(exp.ppn_amount) || 0;
  const pph = Number(exp.pph_amount) || 0;
  const treatment: 'deduct' | 'add' = exp.pph_treatment === 'add' ? 'add' : 'deduct';
  const stamp = Number(exp.stamp_duty_amount) || 0;
  const rawBank = Number(exp.bank_charges_amount) || 0;
  const bank = rawBank;
  const bpjs = Number(exp.bpjs_employee_deduction) || 0;

  const netPayable = treatment === 'add'
    ? amount + ppn + stamp + bank - bpjs
    : amount + ppn - pph + stamp + bank - bpjs;
  const settlementAmount = netPayable;
  const totalCashOutflow = treatment === 'add'
    ? amount + ppn + pph + stamp + bank
    : amount + ppn + stamp + bank;

  return {
    amount,
    ppnAmount: ppn,
    pphAmount: pph,
    pphTreatment: treatment,
    stampDutyAmount: stamp,
    bpjsEmployeeDeduction: bpjs,
    bankChargesAmount: bank,
    netPayable,
    settlementAmount,
    totalCashOutflow,
  };
}

/**
 * Canonical expense value for expense-facing screens.
 * Customs broker rows use the derived expense total; all other rows retain
 * their normal expense amount. Broker invoice amount is a breakdown value,
 * never the main expense-list amount.
 */
export function calculateCanonicalExpenseTotal(
  exp: ExpenseTotalsInput & BrokerExpenseTotalsInput,
): number {
  if (exp.expense_category === 'import_broker') {
    return calculateBrokerExpenseTotals(exp).accountingExpenseTotal;
  }
  return Number(exp.amount) || 0;
}

/** Cash target used by payment status and settlement displays. */
export function calculateCanonicalCashPayable(
  exp: ExpenseTotalsInput & BrokerExpenseTotalsInput,
): number {
  if (exp.expense_category === 'import_broker') {
    return calculateBrokerExpenseTotals(exp).finalCashPayable;
  }
  return calculateExpenseTotals(exp).settlementAmount;
}

/**
 * Read-only warning for reconciliation screens. Dates are business dates
 * (YYYY-MM-DD), so parsing them as UTC avoids timezone shifts at midnight.
 */
export function paymentDateGapWarning(
  bankDate?: string | null,
  voucherDate?: string | null,
  thresholdDays = 3,
): string | null {
  if (!bankDate || !voucherDate) return null;
  const toDay = (value: string) => {
    const match = value.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
  };
  const bankDay = toDay(bankDate);
  const voucherDay = toDay(voucherDate);
  if (!Number.isFinite(bankDay) || !Number.isFinite(voucherDay)) return null;
  const days = Math.abs(bankDay - voucherDay) / 86_400_000;
  return days > thresholdDays
    ? 'Payment date differs from voucher date by more than 3 days. Please verify the transaction date.'
    : null;
}

/** Input for outstanding calculation — same as totals plus paid_amount. */
export interface OutstandingInput extends ExpenseTotalsInput {
  paid_amount?: number | null;
}

export interface Outstanding {
  netPayable: number;
  paidAmount: number;
  /** max(0, netPayable − paidAmount). */
  outstandingAmount: number;
  isFullyPaid: boolean;
}

/**
 * Returns the outstanding balance for an expense.
 * Kept separate from calculateExpenseTotals() because outstanding depends on
 * payment state (paid_amount) while totals depend only on the expense itself.
 */
export function calculateOutstanding(exp: OutstandingInput): Outstanding {
  const { settlementAmount: netPayable } = calculateExpenseTotals(exp);
  const paid = Number(exp.paid_amount) || 0;
  const outstanding = Math.max(0, netPayable - paid);
  return {
    netPayable,
    paidAmount: paid,
    outstandingAmount: outstanding,
    isFullyPaid: outstanding === 0 && netPayable > 0,
  };
}

export interface RecognizedPPhResult {
  recognizedPph: number;
  unrecognizedPph: number;
  cashPayable: number;
  paidAmount: number;
  isPaid: boolean;
  paymentRatio: number;
  status: 'unpaid' | 'partial' | 'fully_paid';
  actualPaymentDate?: string | null;
}

/**
 * Calculates statutory recognized PPh withholding based on actual payment.
 * Under Indonesian tax law (PPh 21 / PPh 23 / PPh 4(2)), withholding tax
 * (pemotongan pajak) is legally effected upon payment / cash disbursement.
 * An unpaid bill or expense does not have completed withholding until cash is paid.
 * For partial payments, withholding is recognized proportionately.
 *
 * CASH STRICTNESS:
 * Selecting 'cash' does NOT prove payment occurred. A genuine cash payment record,
 * actual payment date, or paid_amount > 0 must exist. If payment is unconfirmed,
 * the expense remains unpaid and PPh remains unallocated (Rp 0 recognized).
 */
export function calculateRecognizedPPh(
  exp: ExpenseTotalsInput & BrokerExpenseTotalsInput & {
    paid_amount?: number | null;
    payment_method?: string | null;
    actual_payment_date?: string | null;
    cash_payment_date?: string | null;
    has_verified_cash_payment?: boolean | null;
  },
): RecognizedPPhResult {
  const pphTotal = Number(exp.pph_amount) || 0;
  const cashPayable = calculateCanonicalCashPayable(exp);
  const paidAmount = Math.max(0, Number(exp.paid_amount) || 0);

  // Selecting 'cash' does NOT prove payment occurred.
  // Only treat as paid if paid_amount > 0.01 OR verified cash payment flag is explicitly true.
  const isCashVerified = exp.payment_method === 'cash' && (exp.has_verified_cash_payment === true || paidAmount > 0.01);
  const effectivePaidAmount = isCashVerified
    ? (paidAmount > 0.01 ? paidAmount : cashPayable)
    : paidAmount;

  // Resolve actual payment date: do NOT guess from expense_date
  let actualPaymentDate: string | null = null;
  if (effectivePaidAmount > 0.01) {
    actualPaymentDate = exp.actual_payment_date || exp.cash_payment_date || null;
  }

  if (pphTotal <= 0) {
    return {
      recognizedPph: 0,
      unrecognizedPph: 0,
      cashPayable,
      paidAmount: effectivePaidAmount,
      isPaid: effectivePaidAmount > 0.01,
      paymentRatio: cashPayable > 0 ? Math.min(1, effectivePaidAmount / cashPayable) : 1,
      status: effectivePaidAmount <= 0.01 ? 'unpaid' : (effectivePaidAmount >= cashPayable - 0.01 ? 'fully_paid' : 'partial'),
      actualPaymentDate,
    };
  }

  if (cashPayable <= 0.01) {
    return {
      recognizedPph: pphTotal,
      unrecognizedPph: 0,
      cashPayable,
      paidAmount: effectivePaidAmount,
      isPaid: true,
      paymentRatio: 1,
      status: 'fully_paid',
      actualPaymentDate,
    };
  }

  if (effectivePaidAmount <= 0.01) {
    return {
      recognizedPph: 0,
      unrecognizedPph: pphTotal,
      cashPayable,
      paidAmount: effectivePaidAmount,
      isPaid: false,
      paymentRatio: 0,
      status: 'unpaid',
      actualPaymentDate: null,
    };
  }

  if (effectivePaidAmount >= cashPayable - 0.01) {
    return {
      recognizedPph: pphTotal,
      unrecognizedPph: 0,
      cashPayable,
      paidAmount: effectivePaidAmount,
      isPaid: true,
      paymentRatio: 1,
      status: 'fully_paid',
      actualPaymentDate,
    };
  }

  const paymentRatio = Math.min(1, effectivePaidAmount / cashPayable);
  const recognizedPph = Math.min(pphTotal, Math.round(pphTotal * paymentRatio));
  const unrecognizedPph = Math.max(0, pphTotal - recognizedPph);

  return {
    recognizedPph,
    unrecognizedPph,
    cashPayable,
    paidAmount: effectivePaidAmount,
    isPaid: true,
    paymentRatio,
    status: 'partial',
    actualPaymentDate,
  };
}

export interface ExpensePaymentAllocation {
  id?: string;
  source: 'bank_statement_allocation' | 'voucher_allocation' | 'petty_cash' | 'cash' | 'direct_payment';
  sourceId?: string | null;
  paymentDate: string; // ISO date YYYY-MM-DD
  amount: number;
  isReversed?: boolean;
  taxPeriodId?: string | null;
  notes?: string | null;
}

export interface MultiPeriodPPhAllocation {
  source: ExpensePaymentAllocation['source'];
  sourceId?: string | null;
  paymentDate: string;
  taxPeriodYear: number;
  taxPeriodMonth: number;
  taxPeriodId?: string | null;
  paymentAmount: number;
  paymentRatio: number;
  recognizedPph: number;
  isReversed: boolean;
}

export interface MultiPeriodPPhResult {
  allocations: MultiPeriodPPhAllocation[];
  periodTotals: Record<string, { year: number; month: number; pphTotal: number; paymentTotal: number }>;
  totalRecognizedPph: number;
  unrecognizedPph: number;
  isFullySettled: boolean;
}

/**
 * Multi-Period PPh Allocation Engine
 *
 * Handles partial payments across multiple tax periods for a single expense:
 * - Proportional recognition per instalment: each payment recognizes withholding in its payment month.
 * - Idempotency: deduplicates repeated reconciliations by (source, sourceId).
 * - Reversals: excludes reversed payments without losing audit history.
 * - Final settlement: absorbs rounding residual so sum(allocations) === expense.pph_amount.
 */
export function calculateMultiPeriodPPhAllocations(
  expense: ExpenseTotalsInput & BrokerExpenseTotalsInput & { pph_amount?: number | null },
  payments: ExpensePaymentAllocation[],
): MultiPeriodPPhResult {
  const totalPph = Math.max(0, Number(expense.pph_amount) || 0);
  const cashPayable = calculateCanonicalCashPayable(expense);

  if (totalPph <= 0 || cashPayable <= 0.01) {
    return {
      allocations: [],
      periodTotals: {},
      totalRecognizedPph: 0,
      unrecognizedPph: 0,
      isFullySettled: true,
    };
  }

  // Deduplicate by source + sourceId if present (idempotency guard)
  const seenKeys = new Set<string>();
  const deduplicatedPayments: ExpensePaymentAllocation[] = [];
  for (const p of payments) {
    const key = p.sourceId ? `${p.source}:${p.sourceId}` : `${p.source}:${p.paymentDate}:${p.amount}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduplicatedPayments.push(p);
    }
  }

  // Filter out reversed payments or non-positive amounts
  const activePayments = deduplicatedPayments.filter(p => !p.isReversed && Number(p.amount) > 0.01);

  // Chronological sort by paymentDate
  const sortedPayments = [...activePayments].sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));

  let cumulativePaid = 0;
  let cumulativeRecognized = 0;
  const allocations: MultiPeriodPPhAllocation[] = [];
  const periodTotals: Record<string, { year: number; month: number; pphTotal: number; paymentTotal: number }> = {};

  for (let i = 0; i < sortedPayments.length; i++) {
    const p = sortedPayments[i];
    const pAmt = Number(p.amount);
    cumulativePaid += pAmt;

    let pphForThisPayment = 0;

    if (cumulativePaid >= cashPayable - 0.01) {
      // Final settlement: absorbs any rounding remainder
      pphForThisPayment = Math.max(0, totalPph - cumulativeRecognized);
    } else {
      // Proportional recognition
      const rawShare = Math.round(totalPph * (pAmt / cashPayable));
      pphForThisPayment = Math.min(Math.max(0, totalPph - cumulativeRecognized), rawShare);
    }

    cumulativeRecognized += pphForThisPayment;

    const d = new Date(p.paymentDate);
    const yr = !isNaN(d.getTime()) ? d.getFullYear() : 0;
    const mo = !isNaN(d.getTime()) ? d.getMonth() + 1 : 0;
    const periodKey = `${yr}-${String(mo).padStart(2, '0')}`;

    allocations.push({
      source: p.source,
      sourceId: p.sourceId,
      paymentDate: p.paymentDate,
      taxPeriodYear: yr,
      taxPeriodMonth: mo,
      taxPeriodId: p.taxPeriodId || null,
      paymentAmount: pAmt,
      paymentRatio: cashPayable > 0 ? pAmt / cashPayable : 1,
      recognizedPph: pphForThisPayment,
      isReversed: false,
    });

    if (!periodTotals[periodKey]) {
      periodTotals[periodKey] = { year: yr, month: mo, pphTotal: 0, paymentTotal: 0 };
    }
    periodTotals[periodKey].pphTotal += pphForThisPayment;
    periodTotals[periodKey].paymentTotal += pAmt;
  }

  const unrecognizedPph = Math.max(0, totalPph - cumulativeRecognized);
  const isFullySettled = cumulativePaid >= cashPayable - 0.01;

  return {
    allocations,
    periodTotals,
    totalRecognizedPph: cumulativeRecognized,
    unrecognizedPph,
    isFullySettled,
  };
}

export interface ExpenseReconciliationInput extends ExpenseTotalsInput, BrokerExpenseTotalsInput {
  paid_amount?: number | null;
  payment_method?: string | null;
  approval_status?: string | null;
  effective_posting_state?: string | null;
  bank_statement_lines?: Array<{
    id?: string | null;
    raw_line_id?: string | null;
    allocation_id?: string | null;
    allocation_amount?: number | null;
    debit_amount?: number | null;
    credit_amount?: number | null;
  }> | null;
  salary_advance_applications?: Array<{
    applied_amount?: number | null;
  }> | null;
  voucher_allocations?: Array<{
    allocated_amount?: number | null;
    payment_vouchers?: {
      payment_purpose?: string | null;
    } | null;
  }> | null;
}

export interface ExpenseReconciliationResult {
  reconciledAmount: number;
  grossCashPayable: number;
  salaryAdvanceApplied: number;
  netCashPayable: number;
  isFullyReconciled: boolean;
  isPartiallyReconciled: boolean;
  statusLabel: 'Paid / Reconciled' | 'Paid / Reconciliation Pending' | 'Partially Paid / Reconciled' | 'Partially Paid / Reconciliation Pending' | 'Outstanding' | 'Petty Cash' | 'Cancelled';
}

/**
 * Authoritative bank reconciliation calculation for an expense.
 *
 * For salary expenses, bank reconciliation completion is determined using the
 * net cash payable after valid salary advances (and applicable deductions), NOT
 * by comparing bank payments only against gross salary.
 */
export function calculateExpenseReconciliation(
  expense: ExpenseReconciliationInput,
  additionalAdvanceApplications?: Array<{ applied_amount?: number | null }> | null,
): ExpenseReconciliationResult {
  const inputLines = (expense.bank_statement_lines || []).map((line, index) => ({
    ...line,
    id: line.id || line.raw_line_id || `bsl-${index}`,
  }));
  const normalizedLines = normalizeExpenseBankLinks(inputLines);
  const reconciledAmount = normalizedLines.reduce(
    (sum, line) => sum + Number(line.allocation_amount ?? line.debit_amount ?? line.credit_amount ?? 0),
    0,
  );

  const grossCashPayable = calculateCanonicalCashPayable(expense);

  let salaryAdvanceApplied = 0;
  let nonSalaryVoucherAllocated = 0;
  if (expense.expense_category === 'salary') {
    if (additionalAdvanceApplications && additionalAdvanceApplications.length > 0) {
      salaryAdvanceApplied = additionalAdvanceApplications.reduce(
        (sum, app) => sum + Number(app.applied_amount || 0),
        0,
      );
    } else if (Array.isArray(expense.salary_advance_applications) && expense.salary_advance_applications.length > 0) {
      salaryAdvanceApplied = expense.salary_advance_applications.reduce(
        (sum, app) => sum + Number(app.applied_amount || 0),
        0,
      );
    } else if (Array.isArray(expense.voucher_allocations) && expense.voucher_allocations.length > 0) {
      const settlementAllocs = expense.voucher_allocations.filter(
        va => va.payment_vouchers?.payment_purpose === 'salary_advance_settlement'
      );
      if (settlementAllocs.length > 0) {
        salaryAdvanceApplied = settlementAllocs.reduce(
          (sum, va) => sum + Number(va.allocated_amount || 0),
          0,
        );
      }
    }
  } else if (Array.isArray(expense.voucher_allocations) && expense.voucher_allocations.length > 0) {
    nonSalaryVoucherAllocated = expense.voucher_allocations.reduce(
      (sum, va) => sum + Number(va.allocated_amount || 0),
      0,
    );
  }

  // Authoritative net cash payable to be matched against bank statement lines
  const netCashPayable = Math.max(0, grossCashPayable - salaryAdvanceApplied - nonSalaryVoucherAllocated);

  const isFullyReconciled = netCashPayable <= 0.01
    ? ((expense.paid_amount ?? 0) >= grossCashPayable - 0.01 || (reconciledAmount + nonSalaryVoucherAllocated) >= grossCashPayable - 0.01)
    : (reconciledAmount >= netCashPayable - 0.01);

  const isPartiallyReconciled = !isFullyReconciled && ((reconciledAmount + nonSalaryVoucherAllocated) > 0.01 && (reconciledAmount + nonSalaryVoucherAllocated) < grossCashPayable - 0.01);

  // Authoritative payment status
  const billBalance = grossCashPayable - (expense.paid_amount ?? 0);
  let paymentStatus = 'Paid';
  if (billBalance > 0.01 && (expense.paid_amount ?? 0) > 0.01) paymentStatus = 'Partially Paid';
  else if (billBalance > 0.01) paymentStatus = 'Outstanding';

  let statusLabel: ExpenseReconciliationResult['statusLabel'] = 'Paid / Reconciled';
  if (expense.approval_status === 'cancelled' || expense.effective_posting_state === 'REVERSED') {
    statusLabel = 'Cancelled';
  } else if (expense.payment_method === 'cash') {
    statusLabel = 'Petty Cash';
  } else if (isFullyReconciled) {
    statusLabel = 'Paid / Reconciled';
  } else if (paymentStatus === 'Outstanding') {
    statusLabel = isPartiallyReconciled ? 'Partially Paid / Reconciled' : 'Outstanding';
  } else if (paymentStatus === 'Partially Paid') {
    statusLabel = (isPartiallyReconciled || isFullyReconciled)
      ? 'Partially Paid / Reconciled'
      : 'Partially Paid / Reconciliation Pending';
  } else {
    statusLabel = 'Paid / Reconciliation Pending';
  }

  return {
    reconciledAmount,
    grossCashPayable,
    salaryAdvanceApplied,
    netCashPayable,
    isFullyReconciled,
    isPartiallyReconciled,
    statusLabel,
  };
}

export const BANK_ALLOCATION_EPSILON = 0.01;
export type CanonicalBankReconStatus = 'matched' | 'partially_reconciled' | 'unmatched';

/**
 * Linked / partial / unlinked from bank_statement_allocations or direct confirmed recorded entry.
 * Legacy matched_* FKs, reconciliation_status, and manually_unlinked are ignored.
 */
export function canonicalBankReconciliationStatus(
  bankAmount: number,
  allocatedAmount: number,
  epsilon: number = BANK_ALLOCATION_EPSILON,
  isDirectRecorded: boolean = false,
): CanonicalBankReconStatus {
  if (isDirectRecorded) return 'matched';
  const bank = Number(bankAmount) || 0;
  const allocated = Number(allocatedAmount) || 0;
  if (allocated <= epsilon) return 'unmatched';
  if (allocated >= bank - epsilon) return 'matched';
  return 'partially_reconciled';
}

export type ExpenseSettlementStatus = 'reconciled' | 'partial' | 'outstanding';

/**
 * Categorizes an expense into one of three authoritative settlement buckets:
 * - 'reconciled': Fully settled/reconciled expenses (balance <= 0.01)
 * - 'partial': Some payment received, but outstanding balance remains
 * - 'outstanding': No payment received yet
 */
export function getExpenseSettlementStatus(
  exp: ExpenseReconciliationInput & {
    amount?: number | string | null;
    paid_amount?: number | string | null;
  }
): ExpenseSettlementStatus {
  const recon = calculateExpenseReconciliation(exp);
  const payable = calculateCanonicalCashPayable(exp);

  if (payable <= 0.01 || recon.isFullyReconciled) {
    return 'reconciled';
  }

  // 1. Authoritative DB paid_amount (maintained by recalculate_expense_payment_state)
  const dbPaid = Number(exp.paid_amount || 0);

  // 2. Bank statement allocations / lines
  const inputLines = (exp.bank_statement_lines || []).map((line, index) => ({
    ...line,
    id: line.id || line.raw_line_id || `bsl-${index}`,
  }));
  const bankLines = normalizeExpenseBankLinks(inputLines);
  const bankPaid = bankLines.reduce(
    (sum, line) => sum + Number((line as any).payment_kind === 'pph23' ? 0 : line.allocation_amount ?? line.debit_amount ?? line.credit_amount ?? 0),
    0
  );

  // 3. Payment voucher allocations
  const voucherAllocs = exp.voucher_allocations || [];
  const voucherPaid = voucherAllocs.reduce(
    (sum, va) => sum + Number((va as any).payment_kind === 'pph23' ? 0 : va.allocated_amount || 0),
    0
  );

  // 4. Salary advance applications
  const advanceApps = exp.salary_advance_applications || [];
  const advancePaid = advanceApps.reduce(
    (sum, sa) => sum + Number(sa.applied_amount || 0),
    0
  );

  // Deduplication across valid sources:
  const accumulatedPaid = Math.min(
    payable,
    Math.max(dbPaid, bankPaid + advancePaid, voucherPaid + advancePaid, bankPaid, voucherPaid, advancePaid)
  );

  const balance = Math.max(0, payable - accumulatedPaid);

  if (balance <= 0.01 && accumulatedPaid > 0.01) {
    return 'reconciled';
  }

  if (recon.isPartiallyReconciled || (accumulatedPaid > 0.01 && balance > 0.01)) {
    return 'partial';
  }

  return 'outstanding';
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

/**
 * Computes a due date given an invoice/expense date and payment terms in days.
 * Returns ISO date string (YYYY-MM-DD) or '' if inputs are invalid.
 */
export function getDueDateFromTerms(
  invoiceDate: string,
  paymentTermsDays: number | null | undefined,
): string {
  if (!invoiceDate || !paymentTermsDays || paymentTermsDays <= 0) return '';
  const d = new Date(invoiceDate);
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + paymentTermsDays);
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Formats an IDR amount as a human-readable string, e.g. "Rp 1.500.000". */
export function formatIDR(amount: number | null | undefined): string {
  if (amount == null) return 'Rp 0';
  return 'Rp ' + Math.round(amount).toLocaleString('id-ID');
}

/** Returns a human-readable label for an expense_category slug. */
export function categoryLabel(category: string): string {
  return category
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Supplier Types — drives Quick Add defaults and Supplier Master categorisation
// ---------------------------------------------------------------------------

export interface SupplierTypeConfig {
  readonly value: string;
  readonly label: string;
  readonly taxPreference: 'none' | 'ppn_only' | 'ppn_pph' | 'pph_only';
  readonly defaultCategory: string;
  readonly defaultDocType: DocumentType;
  readonly paymentTerms: number;
}

export const SUPPLIER_TYPES: readonly SupplierTypeConfig[] = [
  { value: 'Import Broker',         label: 'Import / Customs Broker',    taxPreference: 'ppn_pph',   defaultCategory: 'import_broker',        defaultDocType: 'Import / Customs Broker Invoice', paymentTerms: 30 },
  { value: 'Utility',               label: 'Utility Provider',           taxPreference: 'ppn_only',  defaultCategory: 'utilities',            defaultDocType: 'Utility',                         paymentTerms: 15 },
  { value: 'Transport',             label: 'Transport / Freight',        taxPreference: 'none',      defaultCategory: 'transport_import',     defaultDocType: 'Import / Customs Broker Invoice', paymentTerms: 14 },
  { value: 'Employee',              label: 'Employee / Staff',           taxPreference: 'pph_only',  defaultCategory: 'salary',               defaultDocType: 'Staff Expense',                   paymentTerms: 0  },
  { value: 'Non-Permanent Individual', label: 'Freelancer / Casual Worker / Honorarium', taxPreference: 'pph_only', defaultCategory: 'non_permanent_employee_fee', defaultDocType: 'Staff Expense', paymentTerms: 0 },
  { value: 'Government',            label: 'Government Agency',          taxPreference: 'none',      defaultCategory: 'duty_customs',         defaultDocType: 'PIB',                             paymentTerms: 0  },
  { value: 'Professional Services', label: 'Professional Services',      taxPreference: 'ppn_pph',   defaultCategory: 'professional_services', defaultDocType: 'Professional Services',          paymentTerms: 14 },
  { value: 'General',              label: 'General Supplier',           taxPreference: 'none',      defaultCategory: 'other',                defaultDocType: 'Operating Expense',               paymentTerms: 30 },
] as const;
export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  duty_customs:               'Import Duty / Bea Masuk',
  ppn_import:                 'PPN Import (PIB only)',
  pph_import:                 'PPh 22 Import (PIB only)',
  freight_import:             'Freight Import',
  clearing_forwarding:        'Clearing & Forwarding',
  port_charges:               'Port Charges',
  container_handling:         'Container Handling',
  transport_import:           'Transport Import',
  loading_import:             'Loading Import',
  bpom_ski_fees:              'BPOM / SKI Fees',
  other_import:               'Other Import Cost',
  pib_import:                 'PIB (Import Declaration)',
  import_broker:              'Customs Broker Invoice',
  delivery_sales:             'Delivery / Sales Dist.',
  loading_sales:              'Loading (Sales)',
  other_sales:                'Other Sales Cost',
  marketing_advertising:      'Sales Commission / Marketing',
  salary:                     'Salary / Gaji',
  staff_overtime:             'Staff Overtime',
  staff_welfare:              'Staff Welfare / Kesejahteraan',
  non_permanent_employee_fee: 'Non-Permanent Employee Fee (PPh 21)',
  travel_conveyance:          'Travel & Conveyance',
  warehouse_rent:             'Warehouse Rent / Sewa Gudang',
  utilities:                  'Utilities (Listrik, Air, dll)',
  electricity:                'Electricity / Listrik',
  water:                      'Water / Air',
  internet_phone:             'Telephone & Internet / Telepon & Internet',
  facility_maintenance:       'Cleaning & Maintenance / Kebersihan & Pemeliharaan',
  bank_charges:               'Bank Charges',
  office_admin:               'Office Administration',
  office_shifting_renovation: 'Office Shifting / Renovation',
  duty:                       'Duty / Bea',
  freight:                    'Freight',
  office:                     'Office Expense',
  other:                      'Other / Lainnya',
  fixed_asset:                'Fixed Asset Purchase',
  professional_services:      'Professional Services / Jasa Profesi',
};
