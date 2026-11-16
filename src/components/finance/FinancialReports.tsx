import { Fragment, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Download, ChevronDown, ChevronRight, Printer } from 'lucide-react';
import * as XLSX from 'xlsx';
import { useFinance } from '../../contexts/FinanceContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { sanitizeExportRows } from '../../utils/csvSafe';

interface TrialBalanceRow {
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

interface MergedTBRow extends TrialBalanceRow {
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

type ReportType = 'trial_balance' | 'pnl' | 'balance_sheet';

interface FinancialReportsProps {
  initialReport?: ReportType;
  onDrillDown?: (code: string, name: string) => void;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────
const fmt = (n: number) => n.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmt2 = (n: number) => n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
const pctStr = (n: number, base: number) =>
  base !== 0 ? ((n / base) * 100).toFixed(1) + '%' : '—';
const prevDay = (iso: string) => {
  const d = new Date(iso);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
};

function groupBy<T>(arr: T[], key: (r: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

// ─── TB section definitions ───────────────────────────────────────────────────
const TB_SECTIONS = [
  { id: 'current-assets',     label: 'Assets — Current',       labelId: 'Aset Lancar',           color: 'blue',   filter: (r: MergedTBRow) => r.account_type === 'asset' && (r.account_group === 'Current Assets' || (!r.account_group && r.code < '1200')) },
  { id: 'fixed-assets',       label: 'Assets — Non-current',   labelId: 'Aset Tidak Lancar',     color: 'blue',   filter: (r: MergedTBRow) => r.account_type === 'asset' && r.account_group !== 'Current Assets' && !(!r.account_group && r.code < '1200') },
  { id: 'liability',          label: 'Liabilities',            labelId: 'Kewajiban',             color: 'red',    filter: (r: MergedTBRow) => r.account_type === 'liability' },
  { id: 'equity',             label: 'Equity',                 labelId: 'Modal',                 color: 'purple', filter: (r: MergedTBRow) => r.account_type === 'equity' },
  { id: 'revenue',            label: 'Revenue',                labelId: 'Pendapatan',            color: 'green',  filter: (r: MergedTBRow) => r.account_type === 'revenue' },
  { id: 'cogs',               label: 'Cost of Goods Sold',     labelId: 'Harga Pokok Penjualan', color: 'orange', filter: (r: MergedTBRow) => r.account_type === 'expense' && r.account_group === 'COGS' },
  { id: 'operating-expenses', label: 'Operating Expenses',     labelId: 'Beban Operasional',     color: 'orange', filter: (r: MergedTBRow) => r.account_type === 'expense' && r.account_group === 'Operating Expenses' },
  { id: 'other-expenses',     label: 'Other Expenses',         labelId: 'Beban Lain-lain',       color: 'orange', filter: (r: MergedTBRow) => r.account_type === 'expense' && r.account_group !== 'COGS' && r.account_group !== 'Operating Expenses' },
  { id: 'contra',             label: 'Contra Accounts',        labelId: 'Akun Kontra',           color: 'gray',   filter: (r: MergedTBRow) => r.account_type === 'contra' },
] as const;

const SECTION_BG: Record<string, string> = {
  blue: 'bg-blue-50 text-blue-900',
  red: 'bg-red-50 text-red-900',
  purple: 'bg-purple-50 text-purple-900',
  green: 'bg-green-50 text-green-900',
  orange: 'bg-orange-50 text-orange-900',
  gray: 'bg-gray-50 text-gray-700',
};
const SECTION_TOTAL_BG: Record<string, string> = {
  blue: 'bg-blue-100 text-blue-900',
  red: 'bg-red-100 text-red-900',
  purple: 'bg-purple-100 text-purple-900',
  green: 'bg-green-100 text-green-900',
  orange: 'bg-orange-100 text-orange-900',
  gray: 'bg-gray-100 text-gray-800',
};

// ─── BS classification ────────────────────────────────────────────────────────
const BS_ASSET_CURRENT  = ['Current Assets'];
const BS_LIAB_CURRENT   = ['Current Liabilities'];
const BS_LIAB_LONGTERM  = ['Long-term Liabilities', 'Long Term Liabilities', 'Other Liabilities'];

export function FinancialReports({ initialReport = 'trial_balance', onDrillDown }: FinancialReportsProps) {
  const { dateRange } = useFinance();
  const { t } = useLanguage();
  const [reportType, setReportType] = useState<ReportType>(initialReport);
  const [loading, setLoading] = useState(false);
  const [usdRate, setUsdRate] = useState<number>(16000);
  const [usdRateInput, setUsdRateInput] = useState<string>('16000');

  const [openingTB, setOpeningTB]         = useState<TrialBalanceRow[]>([]);
  const [periodTB, setPeriodTB]           = useState<TrialBalanceRow[]>([]);
  const [balanceSheetData, setBalanceSheetData] = useState<TrialBalanceRow[]>([]);
  const [detailedPnL, setDetailedPnL]     = useState<DetailedPnLSummary | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  // Fetch the system's latest USD→IDR rate on mount
  useEffect(() => {
    supabase.rpc('get_reporting_usd_rate').then(({ data }) => {
      if (data && Number(data) > 1) {
        setUsdRate(Number(data));
        setUsdRateInput(String(Number(data)));
      }
    });
  }, []);

  useEffect(() => { setReportType(initialReport); }, [initialReport]);
  useEffect(() => { loadReport(); }, [reportType, dateRange, usdRate]);

  const handleRateChange = (val: string) => {
    setUsdRateInput(val);
    const n = parseFloat(val.replace(/,/g, ''));
    if (!isNaN(n) && n > 100) setUsdRate(n);
  };

  const loadReport = async () => {
    setLoading(true);
    try {
      const [periodRes, openingRes] = await Promise.all([
        supabase.rpc('get_trial_balance', {
          p_start_date: dateRange.startDate,
          p_end_date:   dateRange.endDate,
          p_usd_rate:   usdRate,
        }),
        supabase.rpc('get_trial_balance', {
          p_start_date: '2000-01-01',
          p_end_date:   prevDay(dateRange.startDate),
          p_usd_rate:   usdRate,
        }),
      ]);
      setPeriodTB((periodRes.data || []) as TrialBalanceRow[]);
      setOpeningTB((openingRes.data || []) as TrialBalanceRow[]);

      if (reportType === 'balance_sheet') {
        const { data: bsData } = await supabase.rpc('get_balance_sheet', {
          p_as_of_date: dateRange.endDate,
          p_usd_rate:   usdRate,
        });
        setBalanceSheetData((bsData || []) as TrialBalanceRow[]);
      }

      if (reportType === 'pnl') {
        const { data: pnlData } = await supabase.rpc('get_pnl_summary_detailed', {
          p_start_date: dateRange.startDate,
          p_end_date:   dateRange.endDate,
          p_usd_rate:   usdRate,
        });
        if (pnlData && Array.isArray(pnlData) && pnlData.length > 0) {
          const row = pnlData[0] as any;
          setDetailedPnL({
            gross_commercial_sales: Number(row.gross_commercial_sales || 0),
            sales_discounts: Number(row.sales_discounts || 0),
            sales_returns: Number(row.sales_returns || 0),
            net_commercial_sales: Number(row.net_commercial_sales || 0),
            other_income: Number(row.other_income || 0),
            fx_gain: Number(row.fx_gain || 0),
            cogs: Number(row.cogs || 0),
            operating_expenses: Number(row.operating_expenses || 0),
            other_expenses: Number(row.other_expenses || 0),
            bank_charges: Number(row.bank_charges || 0),
            fx_loss: Number(row.fx_loss || 0),
            total_expenses: Number(row.total_expenses || 0),
            total_income: Number(row.total_income || 0),
            net_income: Number(row.net_income || 0),
          });
        }
      }
    } catch (err) {
      console.error('Error loading financial report:', err);
    } finally {
      setLoading(false);
    }
  };

  // ── Merged TB rows (Opening + Period → Closing) ───────────────────────────
  const mergedTB = useMemo((): MergedTBRow[] => {
    const codeMap = new Map<string, MergedTBRow>();
    for (const r of openingTB) {
      const ob = r.balance;
      codeMap.set(r.code, {
        ...r,
        openingDr: Math.max(0, ob),
        openingCr: Math.max(0, -ob),
        periodDr: 0,
        periodCr: 0,
        closingDr: Math.max(0, ob),
        closingCr: Math.max(0, -ob),
      });
    }
    for (const r of periodTB) {
      const existing = codeMap.get(r.code);
      const ob = existing ? (existing.openingDr - existing.openingCr) : 0;
      const cb = ob + r.balance;
      if (existing) {
        existing.periodDr  = r.total_debit;
        existing.periodCr  = r.total_credit;
        existing.closingDr = Math.max(0, cb);
        existing.closingCr = Math.max(0, -cb);
      } else {
        codeMap.set(r.code, {
          ...r,
          openingDr: 0,
          openingCr: 0,
          periodDr:  r.total_debit,
          periodCr:  r.total_credit,
          closingDr: Math.max(0, r.balance),
          closingCr: Math.max(0, -r.balance),
        });
      }
    }
    return Array.from(codeMap.values()).sort((a, b) => a.code.localeCompare(b.code));
  }, [openingTB, periodTB]);

  // ── P&L calculations (separate commercial operations from FX) ───────────
  const revenueRows   = useMemo(() => periodTB.filter(r => r.account_type === 'revenue' && r.account_group !== 'Other Income' && r.code !== '4930'), [periodTB]);
  const otherIncRows  = useMemo(() => periodTB.filter(r => r.account_type === 'revenue' && r.account_group === 'Other Income' && r.code !== '4930'), [periodTB]);
  const contraRevRows = useMemo(() => periodTB.filter(r => r.account_type === 'contra' && r.account_group === 'Revenue'), [periodTB]);
  const cogsRows      = useMemo(() => periodTB.filter(r => r.account_type === 'expense' && r.account_group === 'COGS'), [periodTB]);
  const opexRows      = useMemo(() => periodTB.filter(r => r.account_type === 'expense' && r.account_group === 'Operating Expenses'), [periodTB]);
  const fxGainRows    = useMemo(() => periodTB.filter(r => r.code === '4930' || r.name.toLowerCase().includes('foreign exchange gain')), [periodTB]);
  const fxLossRows    = useMemo(() => periodTB.filter(r => r.code === '7300' || r.name.toLowerCase().includes('foreign exchange loss')), [periodTB]);
  const otherExpRows  = useMemo(() => periodTB.filter(r => r.account_type === 'expense' && r.account_group !== 'COGS' && r.account_group !== 'Operating Expenses' && r.code !== '7300' && !r.name.toLowerCase().includes('foreign exchange loss')), [periodTB]);

  const totalRevenue    = revenueRows.reduce((s, r) => s + Math.abs(r.balance), 0);
  const totalContraRev  = contraRevRows.reduce((s, r) => s + Math.abs(r.balance), 0);
  const netRevenue      = totalRevenue - totalContraRev;
  const totalCOGS       = cogsRows.reduce((s, r) => s + r.balance, 0);
  const grossProfit     = netRevenue - totalCOGS;
  const totalOpex       = opexRows.reduce((s, r) => s + r.balance, 0);
  const operatingIncome = grossProfit - totalOpex;
  const totalFxGain     = fxGainRows.reduce((s, r) => s + Math.abs(r.balance), 0);
  const totalFxLoss     = fxLossRows.reduce((s, r) => s + r.balance, 0);
  const netFxImpact     = totalFxGain - totalFxLoss;
  const totalOtherInc   = otherIncRows.reduce((s, r) => s + Math.abs(r.balance), 0);
  const totalOtherExp   = otherExpRows.reduce((s, r) => s + r.balance, 0);
  const profitBeforeTax = operatingIncome + netFxImpact + totalOtherInc - totalOtherExp;
  const netIncome       = profitBeforeTax;

  // ── Balance Sheet calculations ───────────────────────────────────────────
  const bsAssetRows     = useMemo(() => balanceSheetData.filter(r => r.account_type === 'asset'), [balanceSheetData]);
  const bsContraAssets  = useMemo(() => balanceSheetData.filter(r => r.account_type === 'contra' && r.account_group?.toLowerCase().includes('asset')), [balanceSheetData]);
  const bsLiabRows      = useMemo(() => balanceSheetData.filter(r => r.account_type === 'liability'), [balanceSheetData]);
  const bsEquityRawRows = useMemo(() => balanceSheetData.filter(r => r.account_type === 'equity' || (r.account_type === 'contra' && r.account_group === 'Equity')), [balanceSheetData]);
  const bsContraRevenue = useMemo(() => balanceSheetData.filter(r => r.account_type === 'contra' && r.account_group === 'Revenue'), [balanceSheetData]);
  const totalContraRevDebit = useMemo(() => bsContraRevenue.reduce((s, r) => s + r.balance, 0), [bsContraRevenue]);

  // If get_balance_sheet() returned contra-revenue rows (e.g. 4300 Sales Returns) separately
  // without deducting them from Current Year Earnings (3300), true up Account 3300 so that
  // Net Income flow to Equity balances with the General Ledger.
  const bsEquityRows = useMemo(() => {
    if (totalContraRevDebit === 0) return bsEquityRawRows;
    return bsEquityRawRows.map(r => {
      if (r.code === '3300') {
        return {
          ...r,
          balance: r.balance + totalContraRevDebit,
        };
      }
      return r;
    });
  }, [bsEquityRawRows, totalContraRevDebit]);

  // get_balance_sheet() returns the journal-native signed balance
  // (debit - credit). Present each section using its accounting normal side;
  // never abs() a debit-balance liability/equity and never add period P&L a
  // second time: Current Year Earnings is already returned by the RPC.
  const totalAssets      = bsAssetRows.reduce((s, r) => s + r.balance, 0) + bsContraAssets.reduce((s, r) => s + r.balance, 0);
  const totalLiabilities = bsLiabRows.reduce((s, r) => s - r.balance, 0);
  const totalEquity      = bsEquityRows.reduce((s, r) => s - r.balance, 0);
  const totalLiabEquity  = totalLiabilities + totalEquity;
  const balanceCheck     = Math.abs(totalAssets - totalLiabEquity);

  const assetCurrentRows  = bsAssetRows.filter(r => BS_ASSET_CURRENT.includes(r.account_group || ''));
  const assetNonCurrRows  = bsAssetRows.filter(r => !BS_ASSET_CURRENT.includes(r.account_group || ''));
  const liabCurrentRows   = bsLiabRows.filter(r => BS_LIAB_CURRENT.includes(r.account_group || '') || !BS_LIAB_LONGTERM.includes(r.account_group || ''));
  const liabLongtermRows  = bsLiabRows.filter(r => BS_LIAB_LONGTERM.includes(r.account_group || ''));

  const totalCurrentAssets   = assetCurrentRows.reduce((s, r) => s + r.balance, 0);
  const totalNonCurrAssets   = assetNonCurrRows.reduce((s, r) => s + r.balance, 0) + bsContraAssets.reduce((s, r) => s + r.balance, 0);
  const totalCurrentLiab     = liabCurrentRows.reduce((s, r) => s - r.balance, 0);
  const totalLongtermLiab    = liabLongtermRows.reduce((s, r) => s - r.balance, 0);

  // ── TB grand totals ───────────────────────────────────────────────────────
  const tbGrandTotals = useMemo(() => mergedTB.reduce(
    (acc, r) => ({
      openingDr: acc.openingDr + r.openingDr,
      openingCr: acc.openingCr + r.openingCr,
      periodDr:  acc.periodDr  + r.periodDr,
      periodCr:  acc.periodCr  + r.periodCr,
      closingDr: acc.closingDr + r.closingDr,
      closingCr: acc.closingCr + r.closingCr,
    }),
    { openingDr: 0, openingCr: 0, periodDr: 0, periodCr: 0, closingDr: 0, closingCr: 0 }
  ), [mergedTB]);

  // ── Toggle section collapse ───────────────────────────────────────────────
  const toggleSection = (id: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Excel exports ─────────────────────────────────────────────────────────
  const exportTrialBalance = () => {
    const rows: Record<string, string | number>[] = [
      { 'Code': '', 'Account': `Trial Balance — ${fmtDate(dateRange.startDate)} to ${fmtDate(dateRange.endDate)}`, 'Opening Dr': '', 'Opening Cr': '', 'Period Dr': '', 'Period Cr': '', 'Closing Dr': '', 'Closing Cr': '' },
      { 'Code': '', 'Account': `Reporting basis: Functional IDR (USD transaction amounts are not converted or mixed) | Reference rate: 1 USD = Rp ${fmt(usdRate)}`, 'Opening Dr': '', 'Opening Cr': '', 'Period Dr': '', 'Period Cr': '', 'Closing Dr': '', 'Closing Cr': '' },
      { 'Code': '', 'Account': '', 'Opening Dr': '', 'Opening Cr': '', 'Period Dr': '', 'Period Cr': '', 'Closing Dr': '', 'Closing Cr': '' },
    ];
    for (const section of TB_SECTIONS) {
      const sectionRows = mergedTB.filter(section.filter as (r: MergedTBRow) => boolean);
      if (sectionRows.length === 0) continue;
      rows.push({ 'Code': '', 'Account': section.label, 'Opening Dr': '', 'Opening Cr': '', 'Period Dr': '', 'Period Cr': '', 'Closing Dr': '', 'Closing Cr': '' });
      let sDr = 0, sCr = 0, pDr = 0, pCr = 0, cDr = 0, cCr = 0;
      for (const r of sectionRows) {
        rows.push({ 'Code': r.code, 'Account': r.name, 'Opening Dr': r.openingDr || '', 'Opening Cr': r.openingCr || '', 'Period Dr': r.periodDr || '', 'Period Cr': r.periodCr || '', 'Closing Dr': r.closingDr || '', 'Closing Cr': r.closingCr || '' });
        sDr += r.openingDr; sCr += r.openingCr; pDr += r.periodDr; pCr += r.periodCr; cDr += r.closingDr; cCr += r.closingCr;
      }
      rows.push({ 'Code': '', 'Account': `Total ${section.label}`, 'Opening Dr': sDr, 'Opening Cr': sCr, 'Period Dr': pDr, 'Period Cr': pCr, 'Closing Dr': cDr, 'Closing Cr': cCr });
      rows.push({ 'Code': '', 'Account': '', 'Opening Dr': '', 'Opening Cr': '', 'Period Dr': '', 'Period Cr': '', 'Closing Dr': '', 'Closing Cr': '' });
    }
    rows.push({ 'Code': '', 'Account': 'GRAND TOTAL', 'Opening Dr': tbGrandTotals.openingDr, 'Opening Cr': tbGrandTotals.openingCr, 'Period Dr': tbGrandTotals.periodDr, 'Period Cr': tbGrandTotals.periodCr, 'Closing Dr': tbGrandTotals.closingDr, 'Closing Cr': tbGrandTotals.closingCr });
    const ws = XLSX.utils.json_to_sheet(sanitizeExportRows(rows));
    ws['!cols'] = [{ wch: 10 }, { wch: 50 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Trial Balance');
    XLSX.writeFile(wb, `Trial_Balance_${dateRange.startDate}_${dateRange.endDate}.xlsx`);
  };

  const exportPnL = () => {
    const rows: Record<string, string | number>[] = [
      { 'Section': `Profit & Loss — ${fmtDate(dateRange.startDate)} to ${fmtDate(dateRange.endDate)}`, 'Code': '', 'Account': '', 'Amount (Rp)': '', '% of Revenue': '' },
      { 'Section': `Reporting basis: Functional IDR (USD transaction amounts are not converted or mixed) | Reference rate: 1 USD = Rp ${fmt(usdRate)}`, 'Code': '', 'Account': '', 'Amount (Rp)': '', '% of Revenue': '' },
      { 'Section': '', 'Code': '', 'Account': '', 'Amount (Rp)': '', '% of Revenue': '' },
    ];
    const add = (label: string, items: TrialBalanceRow[], getAmt: (r: TrialBalanceRow) => number) => {
      rows.push({ 'Section': label, 'Code': '', 'Account': '', 'Amount (Rp)': '', '% of Revenue': '' });
      items.forEach(r => { const a = getAmt(r); rows.push({ 'Section': '', 'Code': r.code, 'Account': r.name, 'Amount (Rp)': a, '% of Revenue': netRevenue > 0 ? ((a / netRevenue) * 100).toFixed(1) + '%' : '' }); });
    };
    const addTotal = (label: string, amount: number) => {
      rows.push({ 'Section': label, 'Code': '', 'Account': '', 'Amount (Rp)': amount, '% of Revenue': netRevenue > 0 ? ((amount / netRevenue) * 100).toFixed(1) + '%' : '' });
      rows.push({ 'Section': '', 'Code': '', 'Account': '', 'Amount (Rp)': '', '% of Revenue': '' });
    };
    add('Revenue', revenueRows, r => Math.abs(r.balance));
    if (contraRevRows.length) add('Less: Returns & Discounts', contraRevRows, r => -Math.abs(r.balance));
    addTotal('NET REVENUE', netRevenue);
    add('Cost of Goods Sold', cogsRows, r => r.balance);
    addTotal('GROSS PROFIT', grossProfit);
    add('Operating Expenses', opexRows, r => r.balance);
    addTotal('OPERATING INCOME', operatingIncome);
    if (fxGainRows.length) add('Foreign Exchange Gain', fxGainRows, r => Math.abs(r.balance));
    if (fxLossRows.length) add('Foreign Exchange Loss', fxLossRows, r => r.balance);
    if (fxGainRows.length || fxLossRows.length) addTotal('NET FOREIGN EXCHANGE', netFxImpact);
    if (otherIncRows.length) add('Other Income', otherIncRows, r => Math.abs(r.balance));
    if (otherExpRows.length) { add('Other Expenses', otherExpRows, r => r.balance); }
    addTotal('PROFIT BEFORE TAX / NET INCOME', netIncome);
    const ws = XLSX.utils.json_to_sheet(sanitizeExportRows(rows));
    ws['!cols'] = [{ wch: 35 }, { wch: 10 }, { wch: 45 }, { wch: 20 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'P&L');
    XLSX.writeFile(wb, `PnL_${dateRange.startDate}_${dateRange.endDate}.xlsx`);
  };

  const exportBalanceSheet = () => {
    const rows: Record<string, string | number>[] = [
      { 'Section': `Balance Sheet — As of ${fmtDate(dateRange.endDate)}`, 'Code': '', 'Account': '', 'Amount (Rp)': '' },
      { 'Section': `Reporting basis: Functional IDR (USD transaction amounts are not converted or mixed) | Reference rate: 1 USD = Rp ${fmt(usdRate)}`, 'Code': '', 'Account': '', 'Amount (Rp)': '' },
      { 'Section': '', 'Code': '', 'Account': '', 'Amount (Rp)': '' },
    ];
    const addGroup = (label: string, items: TrialBalanceRow[], getAmt: (r: TrialBalanceRow) => number, total: number, totalLabel: string) => {
      rows.push({ 'Section': label, 'Code': '', 'Account': '', 'Amount (Rp)': '' });
      items.forEach(r => rows.push({ 'Section': '', 'Code': r.code, 'Account': r.name, 'Amount (Rp)': getAmt(r) }));
      rows.push({ 'Section': totalLabel, 'Code': '', 'Account': '', 'Amount (Rp)': total });
      rows.push({ 'Section': '', 'Code': '', 'Account': '', 'Amount (Rp)': '' });
    };
    addGroup('CURRENT ASSETS', assetCurrentRows, r => r.balance, totalCurrentAssets, 'Total Current Assets');
    addGroup('NON-CURRENT ASSETS', assetNonCurrRows, r => r.balance, totalNonCurrAssets, 'Total Non-current Assets');
    rows.push({ 'Section': 'TOTAL ASSETS', 'Code': '', 'Account': '', 'Amount (Rp)': totalAssets });
    rows.push({ 'Section': '', 'Code': '', 'Account': '', 'Amount (Rp)': '' });
    addGroup('CURRENT LIABILITIES', liabCurrentRows, r => -r.balance, totalCurrentLiab, 'Total Current Liabilities');
    if (liabLongtermRows.length) addGroup('LONG-TERM LIABILITIES', liabLongtermRows, r => -r.balance, totalLongtermLiab, 'Total Long-term Liabilities');
    rows.push({ 'Section': 'TOTAL LIABILITIES', 'Code': '', 'Account': '', 'Amount (Rp)': totalLiabilities });
    rows.push({ 'Section': '', 'Code': '', 'Account': '', 'Amount (Rp)': '' });
    rows.push({ 'Section': 'EQUITY', 'Code': '', 'Account': '', 'Amount (Rp)': '' });
    bsEquityRows.forEach(r => rows.push({ 'Section': '', 'Code': r.code, 'Account': r.name, 'Amount (Rp)': -r.balance }));
    rows.push({ 'Section': 'TOTAL EQUITY', 'Code': '', 'Account': '', 'Amount (Rp)': totalEquity });
    rows.push({ 'Section': '', 'Code': '', 'Account': '', 'Amount (Rp)': '' });
    rows.push({ 'Section': 'TOTAL LIABILITIES + EQUITY', 'Code': '', 'Account': '', 'Amount (Rp)': totalLiabEquity });
    rows.push({ 'Section': balanceCheck < 0.02 ? 'BALANCED ✓' : `OUT OF BALANCE ⚠ Diff: ${fmt2(balanceCheck)}`, 'Code': '', 'Account': '', 'Amount (Rp)': '' });
    const ws = XLSX.utils.json_to_sheet(sanitizeExportRows(rows));
    ws['!cols'] = [{ wch: 35 }, { wch: 10 }, { wch: 45 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Balance Sheet');
    XLSX.writeFile(wb, `BalanceSheet_${dateRange.endDate}.xlsx`);
  };

  // ── Shared sub-components ─────────────────────────────────────────────────
  const AmtCell = ({ value, className = '' }: { value: number; className?: string }) => (
    <td className={`px-3 py-1.5 text-right tabular-nums text-xs ${value === 0 ? 'text-gray-300' : 'text-gray-800'} ${className}`}>
      {value !== 0 ? fmt(value) : '—'}
    </td>
  );

  const PnLAccountRow = ({ row, getAmt }: { row: TrialBalanceRow; getAmt: (r: TrialBalanceRow) => number }) => {
    const amount = getAmt(row);
    return (
      <tr className="hover:bg-gray-50 group">
        <td className="pl-8 pr-2 py-1 text-[10px] font-mono text-gray-400 w-16">{row.code}</td>
        <td className="px-2 py-1 text-xs text-gray-700">
          {onDrillDown ? (
            <button onClick={() => onDrillDown(row.code, row.name)} className="hover:text-blue-600 hover:underline text-left">
              {row.name}
            </button>
          ) : row.name}
        </td>
        <td className="px-3 py-1 text-right text-xs tabular-nums text-gray-800 w-36">{amount !== 0 ? `Rp ${fmt(amount)}` : '—'}</td>
        <td className="px-3 py-1 text-right text-[10px] text-gray-400 w-20">{pctStr(Math.abs(amount), netRevenue)}</td>
      </tr>
    );
  };

  const BSRow = ({ row, amount }: { row: TrialBalanceRow; amount: number }) => (
    <tr className="hover:bg-gray-50">
      <td className="pl-10 pr-2 py-1 text-[10px] font-mono text-gray-400 w-16">{row.code}</td>
      <td className="px-2 py-1 text-xs text-gray-700">
        {onDrillDown ? (
          <button onClick={() => onDrillDown(row.code, row.name)} className="hover:text-blue-600 hover:underline text-left">
            {row.name}
          </button>
        ) : row.name}
      </td>
      <td className={`px-4 py-1 text-right text-xs tabular-nums w-44 ${amount < 0 ? 'text-red-600' : 'text-gray-800'}`}>
        {amount < 0 ? `(Rp ${fmt(Math.abs(amount))})` : `Rp ${fmt(amount)}`}
      </td>
    </tr>
  );

  // Shared currency info bar shown in every report header
  const CurrencyBar = () => (
    <div className="flex items-center gap-4 mt-1.5 print:hidden">
      <span className="text-[10px] text-slate-300">Reporting basis: <span className="font-semibold text-white">Functional IDR</span></span>
      <span className="text-slate-500 text-[10px]">|</span>
      <span className="text-[10px] text-slate-300 flex items-center gap-1.5">
        Reference USD Rate (not applied):
        <span className="text-[10px] text-slate-400">1 USD =</span>
        <input name="usd_rate_input" aria-label="Usd Rate Input"
          type="text"
          value={usdRateInput}
          onChange={e => handleRateChange(e.target.value)}
          onBlur={() => setUsdRateInput(fmt(usdRate))}
          className="w-24 px-1.5 py-0.5 rounded text-[10px] bg-slate-700 border border-slate-500 text-white text-right tabular-nums focus:outline-none focus:border-blue-400"
        />
        <span className="text-slate-400 text-[10px]">IDR</span>
      </span>
    </div>
  );

  // Print-only currency info
  const CurrencyBarPrint = () => (
    <div className="hidden print:block text-[9px] text-gray-500 mt-0.5">
      Reporting basis: Functional IDR (USD transaction amounts are not converted or mixed) &nbsp;|&nbsp; Reference rate: 1 USD = Rp {fmt(usdRate)}
    </div>
  );

  if (loading) return (
    <div className="flex items-center justify-center py-16">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
    </div>
  );

  return (
    <div className="space-y-0 print:space-y-4">

      {/* ═══════════════════════════════════════════════════════════════════
          TRIAL BALANCE
      ═══════════════════════════════════════════════════════════════════ */}
      {reportType === 'trial_balance' && (
        <div className="bg-white rounded border border-gray-200 overflow-hidden print:shadow-none print:border-0">
          {/* Report Header */}
          <div className="bg-slate-800 text-white px-5 py-3 print:bg-white print:text-gray-900 print:border-b-2 print:border-gray-800">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-slate-400 print:text-gray-500">PT Anzen Koorporasi Indonesia</p>
                <h2 className="text-base font-bold mt-0.5">Trial Balance</h2>
                <p className="text-xs text-slate-300 print:text-gray-600">
                  For the period {fmtDate(dateRange.startDate)} to {fmtDate(dateRange.endDate)}
                </p>
                <CurrencyBar />
                <CurrencyBarPrint />
              </div>
              <div className="flex items-center gap-2 print:hidden">
                <button onClick={() => window.print()} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded text-white">
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
                <button onClick={exportTrialBalance} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-green-700 hover:bg-green-600 rounded text-white">
                  <Download className="w-3.5 h-3.5" /> Excel
                </button>
              </div>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-700 text-white">
                  <th className="px-1.5 py-1 text-left font-semibold w-20 text-[10px] uppercase tracking-wide">Code</th>
                  <th className="px-1.5 py-1 text-left font-semibold text-[10px] uppercase tracking-wide">Account Name</th>
                  <th className="px-1.5 py-1 text-right font-semibold text-[10px] uppercase tracking-wide w-32" colSpan={2}>Opening Balance</th>
                  <th className="px-1.5 py-1 text-right font-semibold text-[10px] uppercase tracking-wide w-32" colSpan={2}>Period Movements</th>
                  <th className="px-1.5 py-1 text-right font-semibold text-[10px] uppercase tracking-wide w-32" colSpan={2}>Closing Balance</th>
                </tr>
                <tr className="bg-slate-600 text-slate-200">
                  <th className="px-3 py-1" />
                  <th className="px-3 py-1" />
                  <th className="px-3 py-1 text-right text-[10px] font-medium w-32">Debit</th>
                  <th className="px-3 py-1 text-right text-[10px] font-medium w-32">Credit</th>
                  <th className="px-3 py-1 text-right text-[10px] font-medium w-32">Debit</th>
                  <th className="px-3 py-1 text-right text-[10px] font-medium w-32">Credit</th>
                  <th className="px-3 py-1 text-right text-[10px] font-medium w-32">Debit</th>
                  <th className="px-3 py-1 text-right text-[10px] font-medium w-32">Credit</th>
                </tr>
              </thead>
              <tbody>
                {TB_SECTIONS.map(section => {
                  const rows = mergedTB.filter(section.filter as (r: MergedTBRow) => boolean);
                  if (rows.length === 0) return null;
                  const isCollapsed = collapsedSections.has(section.id);
                  const sDr = rows.reduce((s, r) => s + r.openingDr, 0);
                  const sCr = rows.reduce((s, r) => s + r.openingCr, 0);
                  const pDr = rows.reduce((s, r) => s + r.periodDr, 0);
                  const pCr = rows.reduce((s, r) => s + r.periodCr, 0);
                  const cDr = rows.reduce((s, r) => s + r.closingDr, 0);
                  const cCr = rows.reduce((s, r) => s + r.closingCr, 0);
                  const bgClass = SECTION_BG[section.color] || 'bg-gray-50 text-gray-700';
                  const totalBgClass = SECTION_TOTAL_BG[section.color] || 'bg-gray-100 text-gray-800';
                  return (
                    <Fragment key={section.id}>
                      {/* Section header */}
                      <tr
                        className={`${bgClass} cursor-pointer select-none`}
                        onClick={() => toggleSection(section.id)}
                      >
                        <td className="px-1.5 py-1" colSpan={2}>
                          <div className="flex items-center gap-1.5">
                            {isCollapsed
                              ? <ChevronRight className="w-3.5 h-3.5 opacity-60" />
                              : <ChevronDown className="w-3.5 h-3.5 opacity-60" />}
                            <span className="text-[10px] font-bold uppercase tracking-widest">{section.label}</span>
                            <span className="text-[9px] opacity-60 ml-1">/ {section.labelId}</span>
                            {isCollapsed && <span className="text-[9px] opacity-50 ml-2">({rows.length} accounts)</span>}
                          </div>
                        </td>
                        <AmtCell value={isCollapsed ? sDr : 0} className="opacity-60" />
                        <AmtCell value={isCollapsed ? sCr : 0} className="opacity-60" />
                        <AmtCell value={isCollapsed ? pDr : 0} className="opacity-60" />
                        <AmtCell value={isCollapsed ? pCr : 0} className="opacity-60" />
                        <AmtCell value={isCollapsed ? cDr : 0} className="opacity-60" />
                        <AmtCell value={isCollapsed ? cCr : 0} className="opacity-60" />
                      </tr>

                      {/* Account rows */}
                      {!isCollapsed && rows.map(r => (
                        <tr key={r.code} className="hover:bg-slate-50 border-t border-gray-50">
                          <td className="px-3 py-1.5 font-mono text-[10px] text-gray-400">{r.code}</td>
                          <td className="pl-6 pr-3 py-1.5 text-xs text-gray-700">
                            {onDrillDown ? (
                              <button onClick={() => onDrillDown(r.code, r.name)} className="hover:text-blue-600 hover:underline text-left">
                                {r.name}
                                {r.name_id && <span className="text-[10px] text-gray-400 ml-1.5">({r.name_id})</span>}
                              </button>
                            ) : (
                              <>
                                {r.name}
                                {r.name_id && <span className="text-[10px] text-gray-400 ml-1.5">({r.name_id})</span>}
                              </>
                            )}
                          </td>
                          <AmtCell value={r.openingDr} />
                          <AmtCell value={r.openingCr} />
                          <AmtCell value={r.periodDr} />
                          <AmtCell value={r.periodCr} />
                          <AmtCell value={r.closingDr} />
                          <AmtCell value={r.closingCr} />
                        </tr>
                      ))}

                      {/* Section subtotal */}
                      {!isCollapsed && (
                        <tr className={totalBgClass}>
                          <td className="px-3 py-1.5 text-right font-bold text-[10px] uppercase tracking-wide" colSpan={2}>
                            Total {section.label}
                          </td>
                          {[sDr, sCr, pDr, pCr, cDr, cCr].map((v, i) => (
                            <td key={i} className="px-3 py-1.5 text-right text-xs font-bold tabular-nums">{v ? fmt(v) : '—'}</td>
                          ))}
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>

              {/* Grand Total */}
              <tfoot>
                <tr className="bg-slate-800 text-white font-bold border-t-2 border-slate-600">
                  <td className="px-1.5 py-1 text-right text-[10px] uppercase tracking-widest" colSpan={2}>GRAND TOTAL</td>
                  {[tbGrandTotals.openingDr, tbGrandTotals.openingCr, tbGrandTotals.periodDr, tbGrandTotals.periodCr, tbGrandTotals.closingDr, tbGrandTotals.closingCr].map((v, i) => (
                    <td key={i} className="px-1.5 py-1 text-right text-xs tabular-nums">{fmt(v)}</td>
                  ))}
                </tr>
                {(() => {
                  const closingDiff = Math.abs(tbGrandTotals.closingDr - tbGrandTotals.closingCr);
                  return closingDiff > 0.5 ? (
                    <tr className="bg-red-700 text-white text-center">
                      <td colSpan={8} className="py-1.5 text-[10px] font-medium">
                        ⚠ Closing balance out of balance — difference: Rp {fmt2(closingDiff)}
                      </td>
                    </tr>
                  ) : (
                    <tr className="bg-green-700 text-white text-center">
                      <td colSpan={8} className="py-1.5 text-[10px] font-medium">
                        ✓ Trial Balance is balanced — Closing Dr = Closing Cr
                      </td>
                    </tr>
                  );
                })()}
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          PROFIT & LOSS
      ═══════════════════════════════════════════════════════════════════ */}
      {reportType === 'pnl' && (
        <div className="bg-white rounded border border-gray-200 overflow-hidden print:shadow-none print:border-0">
          <div className="bg-slate-800 text-white px-5 py-3 print:bg-white print:text-gray-900 print:border-b-2 print:border-gray-800">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-slate-400 print:text-gray-500">PT Anzen Koorporasi Indonesia</p>
                <h2 className="text-base font-bold mt-0.5">Profit & Loss Statement</h2>
                <p className="text-xs text-slate-300 print:text-gray-600">
                  For the period {fmtDate(dateRange.startDate)} to {fmtDate(dateRange.endDate)}
                </p>
                <CurrencyBar />
                <CurrencyBarPrint />
              </div>
              <div className="flex items-center gap-2 print:hidden">
                <button onClick={() => window.print()} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded text-white">
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
                <button onClick={exportPnL} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-green-700 hover:bg-green-600 rounded text-white">
                  <Download className="w-3.5 h-3.5" /> Excel
                </button>
              </div>
            </div>
          </div>

          {detailedPnL && (
            <div className="p-4 bg-slate-50 border-b border-gray-200 print:bg-white print:border-b">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">Canonical Financial Summary (RPC get_pnl_summary_detailed)</h3>
                <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium">Canonical Source of Truth</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2 text-xs mb-2">
                <div className="p-2 bg-white rounded border border-gray-200 shadow-xs">
                  <p className="text-[9px] text-gray-500 uppercase font-medium">1. Gross Commercial Sales</p>
                  <p className="font-bold text-gray-900 mt-0.5 tabular-nums">Rp {fmt(detailedPnL.gross_commercial_sales)}</p>
                </div>
                <div className="p-2 bg-white rounded border border-gray-200 shadow-xs">
                  <p className="text-[9px] text-gray-500 uppercase font-medium">2. Sales Discounts</p>
                  <p className="font-bold text-gray-900 mt-0.5 tabular-nums">Rp {fmt(detailedPnL.sales_discounts)}</p>
                </div>
                <div className="p-2 bg-white rounded border border-gray-200 shadow-xs">
                  <p className="text-[9px] text-gray-500 uppercase font-medium">3. Sales Returns</p>
                  <p className="font-bold text-gray-900 mt-0.5 tabular-nums">Rp {fmt(detailedPnL.sales_returns)}</p>
                </div>
                <div className="p-2 bg-emerald-50/50 rounded border border-emerald-200 shadow-xs">
                  <p className="text-[9px] text-emerald-800 uppercase font-semibold">4. Net Commercial Sales</p>
                  <p className="font-bold text-emerald-900 mt-0.5 tabular-nums">Rp {fmt(detailedPnL.net_commercial_sales)}</p>
                </div>
                <div className="p-2 bg-white rounded border border-gray-200 shadow-xs">
                  <p className="text-[9px] text-gray-500 uppercase font-medium">5. Other Income</p>
                  <p className="font-bold text-gray-900 mt-0.5 tabular-nums">Rp {fmt(detailedPnL.other_income)}</p>
                </div>
                <div className="p-2 bg-amber-50/50 rounded border border-amber-200 shadow-xs">
                  <p className="text-[9px] text-amber-800 uppercase font-semibold">6. Foreign Exchange Gain</p>
                  <p className="font-bold text-amber-900 mt-0.5 tabular-nums">Rp {fmt(detailedPnL.fx_gain)}</p>
                </div>
                <div className="p-2 bg-orange-50/50 rounded border border-orange-200 shadow-xs">
                  <p className="text-[9px] text-orange-800 uppercase font-semibold">7. COGS</p>
                  <p className="font-bold text-orange-900 mt-0.5 tabular-nums">Rp {fmt(detailedPnL.cogs)}</p>
                </div>
                <div className="p-2 bg-white rounded border border-gray-200 shadow-xs">
                  <p className="text-[9px] text-gray-500 uppercase font-medium">8. Operating Expenses</p>
                  <p className="font-bold text-gray-900 mt-0.5 tabular-nums">Rp {fmt(detailedPnL.operating_expenses)}</p>
                </div>
                <div className="p-2 bg-white rounded border border-gray-200 shadow-xs">
                  <p className="text-[9px] text-gray-500 uppercase font-medium">9. Other Expenses</p>
                  <p className="font-bold text-gray-900 mt-0.5 tabular-nums">Rp {fmt(detailedPnL.other_expenses)}</p>
                </div>
                <div className="p-2 bg-white rounded border border-gray-200 shadow-xs">
                  <p className="text-[9px] text-gray-500 uppercase font-medium">10. Bank Charges</p>
                  <p className="font-bold text-gray-900 mt-0.5 tabular-nums">Rp {fmt(detailedPnL.bank_charges)}</p>
                </div>
                <div className="p-2 bg-red-50/50 rounded border border-red-200 shadow-xs">
                  <p className="text-[9px] text-red-800 uppercase font-semibold">11. Foreign Exchange Loss</p>
                  <p className="font-bold text-red-900 mt-0.5 tabular-nums">Rp {fmt(detailedPnL.fx_loss)}</p>
                </div>
                <div className="p-2 bg-red-100/50 rounded border border-red-300 shadow-xs">
                  <p className="text-[9px] text-red-900 uppercase font-bold">12. Total Expenses</p>
                  <p className="font-bold text-red-950 mt-0.5 tabular-nums">Rp {fmt(detailedPnL.total_expenses)}</p>
                </div>
              </div>
              <div className={`px-3 py-2 rounded border flex items-center justify-between ${detailedPnL.net_income >= 0 ? 'bg-emerald-50 border-emerald-300 text-emerald-900' : 'bg-rose-50 border-rose-300 text-rose-900'}`}>
                <span className="font-bold uppercase tracking-wider text-xs">13. Canonical Net Income / (Loss)</span>
                <span className="text-sm font-bold tabular-nums">
                  {detailedPnL.net_income >= 0 ? `Rp ${fmt(detailedPnL.net_income)}` : `(Rp ${fmt(Math.abs(detailedPnL.net_income))})`}
                </span>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-slate-700 text-white">
                <tr>
                  <th className="px-1.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide w-16">Code</th>
                  <th className="px-1.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide">Description</th>
                  <th className="px-1.5 py-1 text-right text-[10px] font-semibold uppercase tracking-wide w-40">Amount (Rp)</th>
                  <th className="px-1.5 py-1 text-right text-[10px] font-semibold uppercase tracking-wide w-20">% Rev</th>
                </tr>
              </thead>
              <tbody>

                {/* REVENUE */}
                <tr className="bg-green-50 cursor-pointer select-none" onClick={() => toggleSection('pnl-revenue')}>
                  <td colSpan={4} className="px-1.5 py-1">
                    <div className="flex items-center gap-1.5">
                      {collapsedSections.has('pnl-revenue') ? <ChevronRight className="w-3.5 h-3.5 text-green-600 opacity-70" /> : <ChevronDown className="w-3.5 h-3.5 text-green-600 opacity-70" />}
                      <span className="text-[10px] font-bold uppercase tracking-widest text-green-800">Revenue (Pendapatan)</span>
                    </div>
                  </td>
                </tr>
                {!collapsedSections.has('pnl-revenue') && revenueRows.map(r => <PnLAccountRow key={r.code} row={r} getAmt={r => Math.abs(r.balance)} />)}
                {!collapsedSections.has('pnl-revenue') && contraRevRows.length > 0 && contraRevRows.map(r => <PnLAccountRow key={r.code} row={r} getAmt={r => -Math.abs(r.balance)} />)}

                {/* NET REVENUE subtotal */}
                <tr className="bg-green-100 border-t border-green-300">
                  <td />
                  <td className="px-1.5 py-1 text-xs font-bold text-green-900">Net Revenue</td>
                  <td className="px-1.5 py-1 text-right text-xs font-bold text-green-900 tabular-nums">Rp {fmt(netRevenue)}</td>
                  <td className="px-1.5 py-1 text-right text-[10px] text-green-700">100.0%</td>
                </tr>

                {/* COGS */}
                {cogsRows.length > 0 && (
                  <>
                    <tr className="bg-orange-50 cursor-pointer select-none" onClick={() => toggleSection('pnl-cogs')}>
                      <td colSpan={4} className="px-1.5 py-1">
                        <div className="flex items-center gap-1.5">
                          {collapsedSections.has('pnl-cogs') ? <ChevronRight className="w-3.5 h-3.5 text-orange-600 opacity-70" /> : <ChevronDown className="w-3.5 h-3.5 text-orange-600 opacity-70" />}
                          <span className="text-[10px] font-bold uppercase tracking-widest text-orange-800">Less: Cost of Goods Sold (HPP)</span>
                        </div>
                      </td>
                    </tr>
                    {!collapsedSections.has('pnl-cogs') && cogsRows.map(r => <PnLAccountRow key={r.code} row={r} getAmt={r => r.balance} />)}
                    <tr className="bg-orange-50 border-t border-orange-200">
                      <td />
                      <td className="px-1.5 py-1 text-xs font-semibold text-orange-900">Total COGS</td>
                      <td className="px-1.5 py-1 text-right text-xs font-semibold text-orange-900 tabular-nums">({fmt(totalCOGS)})</td>
                      <td className="px-1.5 py-1 text-right text-[10px] text-orange-700">{pctStr(totalCOGS, netRevenue)}</td>
                    </tr>
                  </>
                )}

                {/* GROSS PROFIT */}
                <tr className={`border-t-2 ${grossProfit >= 0 ? 'bg-blue-100 border-blue-400' : 'bg-red-100 border-red-400'}`}>
                  <td colSpan={2} className={`px-2 py-1.5 text-sm font-bold ${grossProfit >= 0 ? 'text-blue-900' : 'text-red-900'}`}>
                    Gross Profit (Laba Kotor)
                  </td>
                  <td className={`px-2 py-1.5 text-right text-sm font-bold tabular-nums ${grossProfit >= 0 ? 'text-blue-900' : 'text-red-900'}`}>
                    Rp {fmt(grossProfit)}
                  </td>
                  <td className={`px-2 py-1.5 text-right text-[10px] font-semibold ${grossProfit >= 0 ? 'text-blue-700' : 'text-red-700'}`}>
                    {pctStr(grossProfit, netRevenue)}
                  </td>
                </tr>

                {/* OPERATING EXPENSES */}
                {opexRows.length > 0 && (
                  <>
                    <tr className="bg-red-50 cursor-pointer select-none" onClick={() => toggleSection('pnl-opex')}>
                      <td colSpan={4} className="px-1.5 py-1">
                        <div className="flex items-center gap-1.5">
                          {collapsedSections.has('pnl-opex') ? <ChevronRight className="w-3.5 h-3.5 text-red-500 opacity-70" /> : <ChevronDown className="w-3.5 h-3.5 text-red-500 opacity-70" />}
                          <span className="text-[10px] font-bold uppercase tracking-widest text-red-800">Less: Operating Expenses (Beban Operasional)</span>
                        </div>
                      </td>
                    </tr>
                    {!collapsedSections.has('pnl-opex') && opexRows.map(r => <PnLAccountRow key={r.code} row={r} getAmt={r => r.balance} />)}
                    <tr className="bg-red-50 border-t border-red-200">
                      <td />
                      <td className="px-1.5 py-1 text-xs font-semibold text-red-900">Total Operating Expenses</td>
                      <td className="px-1.5 py-1 text-right text-xs font-semibold text-red-900 tabular-nums">({fmt(totalOpex)})</td>
                      <td className="px-1.5 py-1 text-right text-[10px] text-red-700">{pctStr(totalOpex, netRevenue)}</td>
                    </tr>
                  </>
                )}

                {/* OPERATING INCOME */}
                <tr className={`border-t-2 ${operatingIncome >= 0 ? 'bg-indigo-100 border-indigo-400' : 'bg-red-100 border-red-400'}`}>
                  <td colSpan={2} className={`px-3 py-2 text-xs font-bold ${operatingIncome >= 0 ? 'text-indigo-900' : 'text-red-900'}`}>
                    Operating Income (Laba Usaha)
                  </td>
                  <td className={`px-3 py-2 text-right text-sm font-bold tabular-nums ${operatingIncome >= 0 ? 'text-indigo-900' : 'text-red-900'}`}>
                    Rp {fmt(operatingIncome)}
                  </td>
                  <td className={`px-3 py-2 text-right text-[10px] font-semibold ${operatingIncome >= 0 ? 'text-indigo-700' : 'text-red-700'}`}>
                    {pctStr(operatingIncome, netRevenue)}
                  </td>
                </tr>

                {/* FOREIGN EXCHANGE GAIN & LOSS */}
                {(fxGainRows.length > 0 || fxLossRows.length > 0) && (
                  <>
                    <tr className="bg-amber-50/70 cursor-pointer select-none" onClick={() => toggleSection('pnl-fx')}>
                      <td colSpan={4} className="px-1.5 py-1">
                        <div className="flex items-center gap-1.5">
                          {collapsedSections.has('pnl-fx') ? <ChevronRight className="w-3.5 h-3.5 text-amber-700 opacity-70" /> : <ChevronDown className="w-3.5 h-3.5 text-amber-700 opacity-70" />}
                          <span className="text-[10px] font-bold uppercase tracking-widest text-amber-900">Foreign Exchange Gain / Loss (Selisih Kurs)</span>
                        </div>
                      </td>
                    </tr>
                    {!collapsedSections.has('pnl-fx') && (
                      <>
                        {fxGainRows.map(r => <PnLAccountRow key={r.code} row={r} getAmt={r => Math.abs(r.balance)} />)}
                        {fxLossRows.map(r => <PnLAccountRow key={r.code} row={r} getAmt={r => -r.balance} />)}
                      </>
                    )}
                    <tr className="bg-amber-50/40 border-t border-amber-200">
                      <td />
                      <td className="px-1.5 py-1 text-xs font-semibold text-amber-900">Net Foreign Exchange Result</td>
                      <td className={`px-1.5 py-1 text-right text-xs font-semibold tabular-nums ${netFxImpact >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                        {netFxImpact < 0 ? `(${fmt(Math.abs(netFxImpact))})` : `Rp ${fmt(netFxImpact)}`}
                      </td>
                      <td className="px-1.5 py-1 text-right text-[10px] text-amber-800">{pctStr(netFxImpact, netRevenue)}</td>
                    </tr>
                  </>
                )}

                {/* OTHER INCOME */}
                {otherIncRows.length > 0 && (
                  <>
                    <tr className="bg-gray-50 cursor-pointer select-none" onClick={() => toggleSection('pnl-other-inc')}>
                      <td colSpan={4} className="px-1.5 py-1">
                        <div className="flex items-center gap-1.5">
                          {collapsedSections.has('pnl-other-inc') ? <ChevronRight className="w-3.5 h-3.5 text-gray-500 opacity-70" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500 opacity-70" />}
                          <span className="text-[10px] font-bold uppercase tracking-widest text-gray-700">Other Income (Pendapatan Lain-lain)</span>
                        </div>
                      </td>
                    </tr>
                    {!collapsedSections.has('pnl-other-inc') && otherIncRows.map(r => <PnLAccountRow key={r.code} row={r} getAmt={r => Math.abs(r.balance)} />)}
                    <tr className="bg-gray-50 border-t border-gray-200">
                      <td />
                      <td className="px-1.5 py-1 text-xs font-semibold text-gray-700">Total Other Income</td>
                      <td className="px-1.5 py-1 text-right text-xs font-semibold text-gray-700 tabular-nums">Rp {fmt(totalOtherInc)}</td>
                      <td className="px-1.5 py-1 text-right text-[10px] text-gray-500">{pctStr(totalOtherInc, netRevenue)}</td>
                    </tr>
                  </>
                )}

                {/* OTHER EXPENSES */}
                {otherExpRows.length > 0 && (
                  <>
                    <tr className="bg-gray-50 cursor-pointer select-none" onClick={() => toggleSection('pnl-other')}>
                      <td colSpan={4} className="px-1.5 py-1">
                        <div className="flex items-center gap-1.5">
                          {collapsedSections.has('pnl-other') ? <ChevronRight className="w-3.5 h-3.5 text-gray-500 opacity-70" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500 opacity-70" />}
                          <span className="text-[10px] font-bold uppercase tracking-widest text-gray-700">Less: Other Expenses (Beban Lain-lain)</span>
                        </div>
                      </td>
                    </tr>
                    {!collapsedSections.has('pnl-other') && otherExpRows.map(r => <PnLAccountRow key={r.code} row={r} getAmt={r => r.balance} />)}
                    <tr className="bg-gray-50 border-t border-gray-200">
                      <td />
                      <td className="px-1.5 py-1 text-xs font-semibold text-gray-700">Total Other Expenses</td>
                      <td className="px-1.5 py-1 text-right text-xs font-semibold text-gray-700 tabular-nums">({fmt(totalOtherExp)})</td>
                      <td className="px-1.5 py-1 text-right text-[10px] text-gray-500">{pctStr(totalOtherExp, netRevenue)}</td>
                    </tr>
                  </>
                )}

              </tbody>

              {/* NET INCOME footer */}
              <tfoot>
                <tr className={`border-t-2 ${netIncome >= 0 ? 'bg-green-700 border-green-500' : 'bg-red-700 border-red-500'} text-white`}>
                  <td colSpan={2} className="px-1.5 py-1 text-sm font-bold uppercase tracking-wide">
                    Net Income — Provisional
                    <span className="block text-[10px] font-normal opacity-75">Laba Bersih (Sementara)</span>
                  </td>
                  <td className="px-1.5 py-1 text-right text-base font-bold tabular-nums">
                    Rp {fmt(netIncome)}
                  </td>
                  <td className="px-1.5 py-1 text-right text-xs font-semibold">
                    {pctStr(netIncome, netRevenue)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          BALANCE SHEET
      ═══════════════════════════════════════════════════════════════════ */}
      {reportType === 'balance_sheet' && (
        <div className="bg-white rounded border border-gray-200 overflow-hidden print:shadow-none print:border-0">
          <div className="bg-slate-800 text-white px-5 py-3 print:bg-white print:text-gray-900 print:border-b-2 print:border-gray-800">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-slate-400 print:text-gray-500">PT Anzen Koorporasi Indonesia</p>
                <h2 className="text-base font-bold mt-0.5">Balance Sheet</h2>
                <p className="text-xs text-slate-300 print:text-gray-600">As at {fmtDate(dateRange.endDate)}</p>
                <CurrencyBar />
                <CurrencyBarPrint />
              </div>
              <div className="flex items-center gap-2 print:hidden">
                <button onClick={() => window.print()} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded text-white">
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
                <button onClick={exportBalanceSheet} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-green-700 hover:bg-green-600 rounded text-white">
                  <Download className="w-3.5 h-3.5" /> Excel
                </button>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <colgroup>
                <col className="w-16" />
                <col />
                <col className="w-48" />
              </colgroup>
              <tbody>

                {/* ── ASSETS ─────────────────────────────────────────── */}
                <tr className="bg-slate-700 text-white">
                  <td colSpan={3} className="px-5 py-2 text-[10px] font-bold uppercase tracking-widest">ASSETS (ASET)</td>
                </tr>

                {/* Current Assets */}
                <tr className="bg-blue-50 cursor-pointer" onClick={() => toggleSection('bs-current-assets')}>
                  <td colSpan={3} className="px-4 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {collapsedSections.has('bs-current-assets') ? <ChevronRight className="w-3.5 h-3.5 text-blue-600 opacity-70" /> : <ChevronDown className="w-3.5 h-3.5 text-blue-600 opacity-70" />}
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-800">Current Assets (Aset Lancar)</span>
                    </div>
                  </td>
                </tr>
                {!collapsedSections.has('bs-current-assets') && assetCurrentRows.map(r => <BSRow key={r.code} row={r} amount={r.balance} />)}
                <tr className="bg-blue-100 border-t border-blue-300">
                  <td />
                  <td className="px-2 py-2 text-xs font-bold text-blue-900">Total Current Assets</td>
                  <td className={`px-4 py-2 text-right text-xs font-bold tabular-nums ${totalCurrentAssets < 0 ? 'text-red-700' : 'text-blue-900'}`}>
                    {totalCurrentAssets < 0 ? `(Rp ${fmt(Math.abs(totalCurrentAssets))})` : `Rp ${fmt(totalCurrentAssets)}`}
                  </td>
                </tr>

                {/* Non-current Assets */}
                {assetNonCurrRows.length > 0 && (
                  <>
                    <tr className="bg-blue-50 cursor-pointer" onClick={() => toggleSection('bs-noncurr-assets')}>
                      <td colSpan={3} className="px-4 py-1.5">
                        <div className="flex items-center gap-1.5">
                          {collapsedSections.has('bs-noncurr-assets') ? <ChevronRight className="w-3.5 h-3.5 text-blue-600 opacity-70" /> : <ChevronDown className="w-3.5 h-3.5 text-blue-600 opacity-70" />}
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-800">Non-current Assets (Aset Tidak Lancar)</span>
                        </div>
                      </td>
                    </tr>
                    {!collapsedSections.has('bs-noncurr-assets') && assetNonCurrRows.map(r => <BSRow key={r.code} row={r} amount={r.balance} />)}
                    {!collapsedSections.has('bs-noncurr-assets') && bsContraAssets.map(r => <BSRow key={r.code} row={r} amount={r.balance} />)}
                    <tr className="bg-blue-100 border-t border-blue-300">
                      <td />
                      <td className="px-2 py-2 text-xs font-bold text-blue-900">Total Non-current Assets</td>
                      <td className={`px-4 py-2 text-right text-xs font-bold tabular-nums ${totalNonCurrAssets < 0 ? 'text-red-700' : 'text-blue-900'}`}>
                        {totalNonCurrAssets < 0 ? `(Rp ${fmt(Math.abs(totalNonCurrAssets))})` : `Rp ${fmt(totalNonCurrAssets)}`}
                      </td>
                    </tr>
                  </>
                )}

                {/* Total Assets */}
                <tr className="bg-blue-900 text-white border-t-2 border-blue-700">
                  <td colSpan={2} className="px-5 py-2.5 text-xs font-bold uppercase tracking-wide">TOTAL ASSETS</td>
                  <td className="px-1.5 py-1 text-right text-sm font-bold tabular-nums">Rp {fmt(totalAssets)}</td>
                </tr>

                {/* Spacer */}
                <tr><td colSpan={3} className="py-1 bg-gray-50 border-t border-gray-200" /></tr>

                {/* ── LIABILITIES ──────────────────────────────────── */}
                <tr className="bg-slate-700 text-white">
                  <td colSpan={3} className="px-5 py-2 text-[10px] font-bold uppercase tracking-widest">LIABILITIES (KEWAJIBAN)</td>
                </tr>

                {/* Current Liabilities */}
                {liabCurrentRows.length > 0 && (
                  <>
                    <tr className="bg-red-50 cursor-pointer" onClick={() => toggleSection('bs-curr-liab')}>
                      <td colSpan={3} className="px-4 py-1.5">
                        <div className="flex items-center gap-1.5">
                          {collapsedSections.has('bs-curr-liab') ? <ChevronRight className="w-3.5 h-3.5 text-red-500 opacity-70" /> : <ChevronDown className="w-3.5 h-3.5 text-red-500 opacity-70" />}
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-red-800">Current Liabilities (Kewajiban Lancar)</span>
                        </div>
                      </td>
                    </tr>
                    {!collapsedSections.has('bs-curr-liab') && liabCurrentRows.map(r => <BSRow key={r.code} row={r} amount={-r.balance} />)}
                    <tr className="bg-red-100 border-t border-red-300">
                      <td />
                      <td className="px-2 py-2 text-xs font-bold text-red-900">Total Current Liabilities</td>
                      <td className="px-4 py-2 text-right text-xs font-bold text-red-900 tabular-nums">Rp {fmt(totalCurrentLiab)}</td>
                    </tr>
                  </>
                )}

                {/* Long-term Liabilities */}
                {liabLongtermRows.length > 0 && (
                  <>
                    <tr className="bg-red-50 cursor-pointer" onClick={() => toggleSection('bs-lt-liab')}>
                      <td colSpan={3} className="px-4 py-1.5">
                        <div className="flex items-center gap-1.5">
                          {collapsedSections.has('bs-lt-liab') ? <ChevronRight className="w-3.5 h-3.5 text-red-500 opacity-70" /> : <ChevronDown className="w-3.5 h-3.5 text-red-500 opacity-70" />}
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-red-800">Long-term Liabilities (Kewajiban Jangka Panjang)</span>
                        </div>
                      </td>
                    </tr>
                    {!collapsedSections.has('bs-lt-liab') && liabLongtermRows.map(r => <BSRow key={r.code} row={r} amount={-r.balance} />)}
                    <tr className="bg-red-100 border-t border-red-300">
                      <td />
                      <td className="px-2 py-2 text-xs font-bold text-red-900">Total Long-term Liabilities</td>
                      <td className="px-4 py-2 text-right text-xs font-bold text-red-900 tabular-nums">Rp {fmt(totalLongtermLiab)}</td>
                    </tr>
                  </>
                )}

                {/* Total Liabilities */}
                <tr className="bg-red-900 text-white border-t-2 border-red-700">
                  <td colSpan={2} className="px-5 py-2.5 text-xs font-bold uppercase tracking-wide">TOTAL LIABILITIES</td>
                  <td className="px-1.5 py-1 text-right text-sm font-bold tabular-nums">Rp {fmt(totalLiabilities)}</td>
                </tr>

                <tr><td colSpan={3} className="py-1 bg-gray-50 border-t border-gray-200" /></tr>

                {/* ── EQUITY ────────────────────────────────────────── */}
                <tr className="bg-slate-700 text-white">
                  <td colSpan={3} className="px-5 py-2 text-[10px] font-bold uppercase tracking-widest">EQUITY (MODAL)</td>
                </tr>

                <tr className="bg-purple-50 cursor-pointer" onClick={() => toggleSection('bs-equity')}>
                  <td colSpan={3} className="px-4 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {collapsedSections.has('bs-equity') ? <ChevronRight className="w-3.5 h-3.5 text-purple-500 opacity-70" /> : <ChevronDown className="w-3.5 h-3.5 text-purple-500 opacity-70" />}
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-purple-800">Equity Components</span>
                    </div>
                  </td>
                </tr>
                {!collapsedSections.has('bs-equity') && bsEquityRows.map(r => <BSRow key={r.code} row={r} amount={-r.balance} />)}
                <tr className="bg-purple-100 border-t border-purple-300">
                  <td />
                  <td className="px-2 py-2 text-xs font-bold text-purple-900">Total Equity</td>
                  <td className={`px-4 py-2 text-right text-xs font-bold tabular-nums ${totalEquity < 0 ? 'text-red-700' : 'text-purple-900'}`}>
                    {totalEquity < 0 ? `(Rp ${fmt(Math.abs(totalEquity))})` : `Rp ${fmt(totalEquity)}`}
                  </td>
                </tr>

                {/* Total Liabilities + Equity */}
                <tr className="bg-purple-900 text-white border-t-2 border-purple-700">
                  <td colSpan={2} className="px-5 py-2.5 text-xs font-bold uppercase tracking-wide">TOTAL LIABILITIES + EQUITY</td>
                  <td className="px-1.5 py-1 text-right text-sm font-bold tabular-nums">Rp {fmt(totalLiabEquity)}</td>
                </tr>

                {/* Balance Check */}
                <tr className={balanceCheck < 0.5 ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}>
                  <td colSpan={3} className="px-5 py-2 text-center text-xs font-medium">
                    {balanceCheck < 0.5
                      ? `✓ Balanced — Assets (Rp ${fmt(totalAssets)}) = Liabilities + Equity (Rp ${fmt(totalLiabEquity)})`
                      : `⚠ Out of balance — Difference: Rp ${fmt2(balanceCheck)}`}
                  </td>
                </tr>

              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}
