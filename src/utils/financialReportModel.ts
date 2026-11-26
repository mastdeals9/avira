export interface TrialBalanceRow {
  code: string;
  name: string;
  name_id: string | null;
  account_type: string;
  account_group: string | null;
  normal_balance: string;
  total_debit: number;
  total_credit: number;
  balance: number;
}

export interface MergedTBRow extends TrialBalanceRow {
  openingDr: number;
  openingCr: number;
  periodDr: number;
  periodCr: number;
  closingDr: number;
  closingCr: number;
}

export interface DetailedPnLSummary {
  gross_commercial_sales: number;
  sales_discounts: number;
  sales_returns: number;
  net_commercial_sales: number;
  other_income: number;
  fx_gain: number;
  cogs: number;
  operating_expenses: number;
  other_expenses: number;
  bank_charges: number;
  fx_loss: number;
  total_expenses: number;
  total_income: number;
  net_income: number;
}

export type PnLClass =
  | 'gross_sales'
  | 'sales_discounts'
  | 'sales_returns'
  | 'other_income'
  | 'fx_gain'
  | 'cogs'
  | 'operating_expenses'
  | 'bank_charges'
  | 'fx_loss'
  | 'other_expenses'
  | 'other';

const COGS_CODES = new Set(['5100', '5105', '5190', '5200', '5300', '5400', '5410']);

export function classifyPnLAccount(row: Pick<TrialBalanceRow, 'code' | 'name' | 'account_type' | 'account_group'>): PnLClass {
  const code = String(row.code || '');
  const name = String(row.name || '').toLowerCase();
  const type = String(row.account_type || '');
  const group = String(row.account_group || '');

  if (type === 'revenue' && (code === '4100' || code === '4110' || code === '4120')) return 'gross_sales';
  if (code === '4200') return 'sales_discounts';
  if (code === '4300' || (type === 'contra' && group === 'Revenue')) return 'sales_returns';
  if (code === '4930' || name.includes('foreign exchange gain')) return 'fx_gain';
  if (type === 'revenue') return 'other_income';
  if (type === 'expense' && (group === 'COGS' || COGS_CODES.has(code))) return 'cogs';
  if (code === '7100') return 'bank_charges';
  if (code === '7300' || name.includes('foreign exchange loss')) return 'fx_loss';
  if (type === 'expense' && group === 'Other Expenses') return 'other_expenses';
  if (type === 'expense') return 'operating_expenses';
  return 'other';
}

export function fmtAccounting(n: number, options?: { currency?: boolean; decimals?: number }): string {
  const decimals = options?.decimals ?? 0;
  const prefix = options?.currency ? 'Rp ' : '';
  if (Math.abs(n) < 0.005) return '—';
  const absFormatted = Math.abs(n).toLocaleString('id-ID', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return n < 0 ? `(${prefix}${absFormatted})` : `${prefix}${absFormatted}`;
}

export interface TBSectionGroup {
  id: string;
  label: string;
  labelId: string;
  rows: MergedTBRow[];
  openingDr: number;
  openingCr: number;
  periodDr: number;
  periodCr: number;
  closingDr: number;
  closingCr: number;
}

export interface TrialBalanceModel {
  rows: MergedTBRow[];
  sections: TBSectionGroup[];
  grandTotals: {
    openingDr: number;
    openingCr: number;
    periodDr: number;
    periodCr: number;
    closingDr: number;
    closingCr: number;
  };
}

export function buildTrialBalanceModel(openingTB: TrialBalanceRow[], periodTB: TrialBalanceRow[]): TrialBalanceModel {
  const codeMap = new Map<string, MergedTBRow>();
  for (const r of openingTB) {
    const ob = Number(r.balance || 0);
    codeMap.set(r.code, {
      ...r,
      total_debit: Number(r.total_debit || 0),
      total_credit: Number(r.total_credit || 0),
      balance: ob,
      openingDr: Math.max(0, ob),
      openingCr: Math.max(0, -ob),
      periodDr: 0,
      periodCr: 0,
      closingDr: Math.max(0, ob),
      closingCr: Math.max(0, -ob),
    });
  }
  for (const r of periodTB) {
    const pDr = Number(r.total_debit || 0);
    const pCr = Number(r.total_credit || 0);
    const bal = Number(r.balance || 0);
    const existing = codeMap.get(r.code);
    const ob = existing ? existing.openingDr - existing.openingCr : 0;
    const cb = ob + bal;
    if (existing) {
      existing.periodDr = pDr;
      existing.periodCr = pCr;
      existing.closingDr = Math.max(0, cb);
      existing.closingCr = Math.max(0, -cb);
    } else {
      codeMap.set(r.code, {
        ...r,
        total_debit: pDr,
        total_credit: pCr,
        balance: bal,
        openingDr: 0,
        openingCr: 0,
        periodDr: pDr,
        periodCr: pCr,
        closingDr: Math.max(0, bal),
        closingCr: Math.max(0, -bal),
      });
    }
  }
  const rows = Array.from(codeMap.values()).sort((a, b) => a.code.localeCompare(b.code));

  const defs: Array<{ id: string; label: string; labelId: string; match: (r: MergedTBRow) => boolean }> = [
    {
      id: 'assets',
      label: 'Assets',
      labelId: 'Aset',
      match: r => r.account_type === 'asset' || (r.account_type === 'contra' && (r.account_group?.toLowerCase().includes('asset') ?? false)),
    },
    { id: 'liabilities', label: 'Liabilities', labelId: 'Kewajiban', match: r => r.account_type === 'liability' },
    {
      id: 'equity',
      label: 'Equity',
      labelId: 'Modal',
      match: r => r.account_type === 'equity' || (r.account_type === 'contra' && r.account_group === 'Equity'),
    },
    {
      id: 'revenue',
      label: 'Revenue',
      labelId: 'Pendapatan',
      match: r => {
        const c = classifyPnLAccount(r);
        return c === 'gross_sales' || c === 'sales_discounts' || c === 'sales_returns';
      },
    },
    {
      id: 'cogs',
      label: 'Cost of Goods Sold',
      labelId: 'Harga Pokok Penjualan',
      match: r => classifyPnLAccount(r) === 'cogs',
    },
    {
      id: 'operating-expenses',
      label: 'Operating Expenses',
      labelId: 'Beban Operasional',
      match: r => classifyPnLAccount(r) === 'operating_expenses',
    },
    {
      id: 'other-income-expenses',
      label: 'Other Income and Expenses',
      labelId: 'Pendapatan & Beban Lain-lain',
      match: r => {
        const c = classifyPnLAccount(r);
        return c === 'other_income' || c === 'fx_gain' || c === 'fx_loss' || c === 'bank_charges' || c === 'other_expenses';
      },
    },
  ];

  const assigned = new Set<string>();
  const sections: TBSectionGroup[] = [];
  for (const def of defs) {
    const matched = rows.filter(r => !assigned.has(r.code) && def.match(r));
    matched.forEach(r => assigned.add(r.code));
    if (matched.length === 0) continue;
    sections.push({
      id: def.id,
      label: def.label,
      labelId: def.labelId,
      rows: matched,
      openingDr: matched.reduce((s, r) => s + r.openingDr, 0),
      openingCr: matched.reduce((s, r) => s + r.openingCr, 0),
      periodDr: matched.reduce((s, r) => s + r.periodDr, 0),
      periodCr: matched.reduce((s, r) => s + r.periodCr, 0),
      closingDr: matched.reduce((s, r) => s + r.closingDr, 0),
      closingCr: matched.reduce((s, r) => s + r.closingCr, 0),
    });
  }

  const grandTotals = rows.reduce(
    (acc, r) => ({
      openingDr: acc.openingDr + r.openingDr,
      openingCr: acc.openingCr + r.openingCr,
      periodDr: acc.periodDr + r.periodDr,
      periodCr: acc.periodCr + r.periodCr,
      closingDr: acc.closingDr + r.closingDr,
      closingCr: acc.closingCr + r.closingCr,
    }),
    { openingDr: 0, openingCr: 0, periodDr: 0, periodCr: 0, closingDr: 0, closingCr: 0 },
  );

  return { rows, sections, grandTotals };
}

export interface BSLineItem {
  code: string;
  name: string;
  amount: number;
}

export interface BalanceSheetModel {
  currentAssets: BSLineItem[];
  nonCurrentAssets: BSLineItem[];
  currentLiabilities: BSLineItem[];
  longTermLiabilities: BSLineItem[];
  equityItems: BSLineItem[];
  totalCurrentAssets: number;
  totalNonCurrentAssets: number;
  totalAssets: number;
  totalCurrentLiabilities: number;
  totalLongTermLiabilities: number;
  totalLiabilities: number;
  totalEquity: number;
  totalLiabilitiesAndEquity: number;
  balanceDifference: number;
  isBalanced: boolean;
}

const BS_LONGTERM_GROUPS = new Set(['Long-term Liabilities', 'Long Term Liabilities', 'Other Liabilities']);

export function buildBalanceSheetModel(rows: TrialBalanceRow[]): BalanceSheetModel {
  const normalized = rows.map(r => ({ ...r, balance: Number(r.balance || 0) }));
  const currentAssets = normalized
    .filter(r => (r.account_type === 'asset' || (r.account_type === 'contra' && r.account_group === 'Current Assets')) && r.account_group === 'Current Assets')
    .map(r => ({ code: r.code, name: r.name, amount: r.balance }));
  const nonCurrentAssets = normalized
    .filter(r => (r.account_type === 'asset' && r.account_group !== 'Current Assets') || (r.account_type === 'contra' && r.account_group !== 'Current Assets' && (r.account_group?.toLowerCase().includes('asset') ?? false)))
    .map(r => ({ code: r.code, name: r.name, amount: r.balance }));

  const liabRows = normalized.filter(r => r.account_type === 'liability');
  const currentLiabilities = liabRows
    .filter(r => !BS_LONGTERM_GROUPS.has(r.account_group || ''))
    .map(r => ({ code: r.code, name: r.name, amount: -r.balance }));
  const longTermLiabilities = liabRows
    .filter(r => BS_LONGTERM_GROUPS.has(r.account_group || ''))
    .map(r => ({ code: r.code, name: r.name, amount: -r.balance }));

  const equityItems = normalized
    .filter(r => r.account_type === 'equity' || (r.account_type === 'contra' && r.account_group === 'Equity'))
    .map(r => ({ code: r.code, name: r.name, amount: -r.balance }));

  const totalCurrentAssets = currentAssets.reduce((s, r) => s + r.amount, 0);
  const totalNonCurrentAssets = nonCurrentAssets.reduce((s, r) => s + r.amount, 0);
  const totalAssets = totalCurrentAssets + totalNonCurrentAssets;
  const totalCurrentLiabilities = currentLiabilities.reduce((s, r) => s + r.amount, 0);
  const totalLongTermLiabilities = longTermLiabilities.reduce((s, r) => s + r.amount, 0);
  const totalLiabilities = totalCurrentLiabilities + totalLongTermLiabilities;
  const totalEquity = equityItems.reduce((s, r) => s + r.amount, 0);
  const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;
  const balanceDifference = Math.abs(totalAssets - totalLiabilitiesAndEquity);

  return {
    currentAssets,
    nonCurrentAssets,
    currentLiabilities,
    longTermLiabilities,
    equityItems,
    totalCurrentAssets,
    totalNonCurrentAssets,
    totalAssets,
    totalCurrentLiabilities,
    totalLongTermLiabilities,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity,
    balanceDifference,
    isBalanced: balanceDifference < 0.02,
  };
}

export interface PnLLineItem {
  code: string;
  name: string;
  amount: number;
}

export interface PnLModel {
  grossSalesRows: PnLLineItem[];
  contraRevenueRows: PnLLineItem[];
  cogsRows: PnLLineItem[];
  opexRows: PnLLineItem[];
  otherIncomeRows: PnLLineItem[];
  fxGainRows: PnLLineItem[];
  fxLossRows: PnLLineItem[];
  bankChargeRows: PnLLineItem[];
  otherExpenseRows: PnLLineItem[];
  grossSales: number;
  contraRevenue: number;
  netRevenue: number;
  totalCOGS: number;
  grossProfit: number;
  totalOpex: number;
  operatingProfit: number;
  totalOtherIncome: number;
  totalFxGain: number;
  totalFxLoss: number;
  totalBankCharges: number;
  totalOtherExpenses: number;
  netOtherIncomeAndExpenses: number;
  netProfit: number;
}

export function buildPnLModel(periodTB: TrialBalanceRow[]): PnLModel {
  const byClass = new Map<PnLClass, TrialBalanceRow[]>();
  for (const r of periodTB) {
    const c = classifyPnLAccount(r);
    if (c === 'other') continue;
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c)!.push({ ...r, balance: Number(r.balance || 0) });
  }
  const get = (c: PnLClass) => byClass.get(c) || [];

  const grossSalesRows = get('gross_sales').map(r => ({ code: r.code, name: r.name, amount: -r.balance }));
  const contraRevenueRows = [...get('sales_discounts'), ...get('sales_returns')].map(r => ({ code: r.code, name: r.name, amount: -r.balance }));
  const cogsRows = get('cogs').map(r => ({ code: r.code, name: r.name, amount: r.balance }));
  const opexRows = get('operating_expenses').map(r => ({ code: r.code, name: r.name, amount: r.balance }));
  const otherIncomeRows = get('other_income').map(r => ({ code: r.code, name: r.name, amount: -r.balance }));
  const fxGainRows = get('fx_gain').map(r => ({ code: r.code, name: r.name, amount: -r.balance }));
  const fxLossRows = get('fx_loss').map(r => ({ code: r.code, name: r.name, amount: r.balance }));
  const bankChargeRows = get('bank_charges').map(r => ({ code: r.code, name: r.name, amount: r.balance }));
  const otherExpenseRows = get('other_expenses').map(r => ({ code: r.code, name: r.name, amount: r.balance }));

  const sum = (items: PnLLineItem[]) => items.reduce((s, r) => s + r.amount, 0);
  const grossSales = sum(grossSalesRows);
  const contraRevenue = sum(contraRevenueRows); // already negative
  const netRevenue = grossSales + contraRevenue;
  const totalCOGS = sum(cogsRows);
  const grossProfit = netRevenue - totalCOGS;
  const totalOpex = sum(opexRows);
  const operatingProfit = grossProfit - totalOpex;
  const totalOtherIncome = sum(otherIncomeRows);
  const totalFxGain = sum(fxGainRows);
  const totalFxLoss = sum(fxLossRows);
  const totalBankCharges = sum(bankChargeRows);
  const totalOtherExpenses = sum(otherExpenseRows);
  const netOtherIncomeAndExpenses = totalOtherIncome + totalFxGain - totalFxLoss - totalBankCharges - totalOtherExpenses;
  const netProfit = operatingProfit + netOtherIncomeAndExpenses;

  return {
    grossSalesRows,
    contraRevenueRows,
    cogsRows,
    opexRows,
    otherIncomeRows,
    fxGainRows,
    fxLossRows,
    bankChargeRows,
    otherExpenseRows,
    grossSales,
    contraRevenue,
    netRevenue,
    totalCOGS,
    grossProfit,
    totalOpex,
    operatingProfit,
    totalOtherIncome,
    totalFxGain,
    totalFxLoss,
    totalBankCharges,
    totalOtherExpenses,
    netOtherIncomeAndExpenses,
    netProfit,
  };
}
