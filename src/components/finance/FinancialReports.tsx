import { Fragment, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Download, ChevronDown, ChevronRight, Printer } from 'lucide-react';
import { useFinance } from '../../contexts/FinanceContext';
import {
  buildBalanceSheetModel,
  buildPnLModel,
  buildTrialBalanceModel,
  fmtAccounting,
  type BSLineItem,
  type DetailedPnLSummary,
  type PnLLineItem,
  type TrialBalanceRow,
} from '../../utils/financialReportModel';
import {
  buildBalanceSheetWorkbook,
  buildPnLWorkbook,
  buildTrialBalanceWorkbook,
  downloadWorkbook,
} from '../../utils/financialReportExcel';

type ReportType = 'trial_balance' | 'pnl' | 'balance_sheet';

interface FinancialReportsProps {
  initialReport?: ReportType;
  onDrillDown?: (code: string, name: string) => void;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
const pctStr = (n: number, base: number) =>
  base !== 0 ? ((n / base) * 100).toFixed(1) + '%' : '—';
const prevDay = (iso: string) => {
  const d = new Date(iso);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
};

export function FinancialReports({ initialReport = 'trial_balance', onDrillDown }: FinancialReportsProps) {
  const { dateRange } = useFinance();
  const [reportType, setReportType] = useState<ReportType>(initialReport);
  const [loading, setLoading] = useState(false);
  const [companyName, setCompanyName] = useState('PT. Shubham Anzen Pharma Jaya');
  const [usdRate, setUsdRate] = useState<number>(16000);
  const [usdRateInput, setUsdRateInput] = useState<string>('16000');

  const [openingTB, setOpeningTB] = useState<TrialBalanceRow[]>([]);
  const [periodTB, setPeriodTB] = useState<TrialBalanceRow[]>([]);
  const [balanceSheetData, setBalanceSheetData] = useState<TrialBalanceRow[]>([]);
  const [detailedPnL, setDetailedPnL] = useState<DetailedPnLSummary | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  useEffect(() => {
    supabase.rpc('get_reporting_usd_rate').then(({ data }) => {
      if (data && Number(data) > 1) {
        setUsdRate(Number(data));
        setUsdRateInput(String(Number(data)));
      }
    });
    supabase
      .from('company_profiles')
      .select('company_name, company_legal_name')
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        const name = (data as { company_legal_name?: string | null; company_name?: string | null } | null)?.company_legal_name
          || (data as { company_name?: string | null } | null)?.company_name;
        if (name) setCompanyName(name);
      });
  }, []);

  useEffect(() => { setReportType(initialReport); }, [initialReport]);
  useEffect(() => { loadReport(); }, [reportType, dateRange, usdRate]);

  // Dynamic @page orientation per report type for Safari & Chromium print
  useEffect(() => {
    const id = 'sapj-report-page-orientation';
    let styleEl = document.getElementById(id) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = id;
      document.head.appendChild(styleEl);
    }
    const orientation = reportType === 'trial_balance' ? 'A4 landscape' : 'A4 portrait';
    styleEl.textContent = `@media print { @page { size: ${orientation}; margin: 10mm; } }`;
    return () => {
      styleEl?.remove();
    };
  }, [reportType]);

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
          p_end_date: dateRange.endDate,
          p_usd_rate: usdRate,
        }),
        supabase.rpc('get_trial_balance', {
          p_start_date: '2000-01-01',
          p_end_date: prevDay(dateRange.startDate),
          p_usd_rate: usdRate,
        }),
      ]);
      setPeriodTB((periodRes.data || []) as TrialBalanceRow[]);
      setOpeningTB((openingRes.data || []) as TrialBalanceRow[]);

      if (reportType === 'balance_sheet') {
        const { data: bsData } = await supabase.rpc('get_balance_sheet', {
          p_as_of_date: dateRange.endDate,
          p_usd_rate: usdRate,
        });
        setBalanceSheetData((bsData || []) as TrialBalanceRow[]);
      }

      if (reportType === 'pnl') {
        const { data: pnlData } = await supabase.rpc('get_pnl_summary_detailed', {
          p_start_date: dateRange.startDate,
          p_end_date: dateRange.endDate,
          p_usd_rate: usdRate,
        });
        if (pnlData && Array.isArray(pnlData) && pnlData.length > 0) {
          const row = pnlData[0] as Record<string, unknown>;
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

  const tbModel = useMemo(() => buildTrialBalanceModel(openingTB, periodTB), [openingTB, periodTB]);
  const bsModel = useMemo(() => buildBalanceSheetModel(balanceSheetData), [balanceSheetData]);
  const pnlModel = useMemo(() => buildPnLModel(periodTB), [periodTB]);

  const basisLabel = `Reporting Basis: Functional IDR (Reference USD Rate: 1 USD = Rp ${fmtAccounting(usdRate)})`;

  const toggleSection = (id: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePrint = () => {
    // Expand any collapsed sections before printing so PDF never omits rows
    setCollapsedSections(new Set());
    requestAnimationFrame(() => {
      window.print();
    });
  };

  const exportTrialBalance = async () => {
    const wb = buildTrialBalanceWorkbook(tbModel, {
      companyName,
      periodLabel: `For the period ${fmtDate(dateRange.startDate)} to ${fmtDate(dateRange.endDate)}`,
      basisLabel,
    });
    await downloadWorkbook(wb, `Trial_Balance_${dateRange.startDate}_${dateRange.endDate}.xlsx`);
  };

  const exportPnL = async () => {
    const wb = buildPnLWorkbook(pnlModel, {
      companyName,
      periodLabel: `For the period ${fmtDate(dateRange.startDate)} to ${fmtDate(dateRange.endDate)}`,
      basisLabel,
    });
    await downloadWorkbook(wb, `PnL_${dateRange.startDate}_${dateRange.endDate}.xlsx`);
  };

  const exportBalanceSheet = async () => {
    const wb = buildBalanceSheetWorkbook(bsModel, {
      companyName,
      asOfLabel: `As of ${fmtDate(dateRange.endDate)}`,
      basisLabel,
    });
    await downloadWorkbook(wb, `BalanceSheet_${dateRange.endDate}.xlsx`);
  };

  const ReportToolbar = () => (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-slate-50 border-b border-gray-200 print:hidden">
      <div className="flex items-center gap-3 text-[11px] text-slate-600">
        <span>Basis: <strong className="text-slate-900">Functional IDR</strong></span>
        <span className="text-slate-300">|</span>
        <label className="flex items-center gap-1.5">
          <span>Ref USD Rate:</span>
          <input
            name="usd_rate_input"
            aria-label="Usd Rate Input"
            type="text"
            value={usdRateInput}
            onChange={e => handleRateChange(e.target.value)}
            onBlur={() => setUsdRateInput(fmtAccounting(usdRate))}
            className="w-24 px-1.5 py-0.5 rounded text-[11px] bg-white border border-gray-300 text-slate-900 text-right tabular-nums"
          />
          <span>IDR</span>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded text-white">
          <Printer className="w-3.5 h-3.5" /> Print / PDF
        </button>
        <button
          onClick={reportType === 'trial_balance' ? exportTrialBalance : reportType === 'pnl' ? exportPnL : exportBalanceSheet}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-emerald-700 hover:bg-emerald-600 rounded text-white"
        >
          <Download className="w-3.5 h-3.5" /> Excel
        </button>
      </div>
    </div>
  );

  const StatementHeader = ({ title, subtitle }: { title: string; subtitle: string }) => (
    <div className="px-6 py-4 bg-white border-b-2 border-slate-800 text-center print:py-2">
      <p className="text-sm font-bold tracking-wide text-slate-900 uppercase">{companyName}</p>
      <h2 className="text-base font-bold text-slate-900 mt-0.5 tracking-wider uppercase">{title}</h2>
      <p className="text-xs text-slate-600 mt-0.5">{subtitle}</p>
      <p className="text-[10px] text-slate-500 mt-0.5">{basisLabel}</p>
    </div>
  );

  const DrillLink = ({ code, name }: { code: string; name: string }) =>
    onDrillDown ? (
      <button onClick={() => onDrillDown(code, name)} className="hover:text-blue-700 hover:underline text-left print:no-underline print:text-slate-900">
        {name}
      </button>
    ) : (
      <span>{name}</span>
    );

  const renderBSColumnRow = (item: BSLineItem) => (
    <tr key={item.code} className="hover:bg-slate-50 border-b border-gray-100">
      <td className="py-1 pl-4 pr-2 font-mono text-[10px] text-slate-500 w-16 align-top">{item.code}</td>
      <td className="py-1 px-2 text-xs text-slate-800"><DrillLink code={item.code} name={item.name} /></td>
      <td className={`py-1 pl-2 pr-3 text-right text-xs tabular-nums whitespace-nowrap w-36 ${item.amount < 0 ? 'text-red-700' : 'text-slate-900'}`}>
        {fmtAccounting(item.amount)}
      </td>
    </tr>
  );

  const renderPnLRow = (item: PnLLineItem, displayAmount = item.amount) => (
    <tr key={item.code} className="hover:bg-slate-50 border-b border-gray-100">
      <td className="py-1 pl-6 pr-2 font-mono text-[10px] text-slate-500 w-16">{item.code}</td>
      <td className="py-1 px-2 text-xs text-slate-800"><DrillLink code={item.code} name={item.name} /></td>
      <td className={`py-1 px-3 text-right text-xs tabular-nums whitespace-nowrap w-40 ${displayAmount < 0 ? 'text-red-700' : 'text-slate-900'}`}>
        {fmtAccounting(displayAmount)}
      </td>
      <td className="py-1 px-3 text-right text-[10px] text-slate-500 tabular-nums w-20">
        {pctStr(Math.abs(displayAmount), pnlModel.netRevenue)}
      </td>
    </tr>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-0 print:space-y-0">
      {/* ═══════════════════════════════════════════════════════════════════
          TRIAL BALANCE (Tally-Style 8 Columns)
      ═══════════════════════════════════════════════════════════════════ */}
      {reportType === 'trial_balance' && (
        <div className="bg-white rounded border border-gray-200 overflow-hidden print:border-0 print:rounded-none">
          <ReportToolbar />
          <StatementHeader
            title="Trial Balance"
            subtitle={`For the period ${fmtDate(dateRange.startDate)} to ${fmtDate(dateRange.endDate)}`}
          />
          <div className="overflow-x-auto print:overflow-visible">
            <table className="w-full text-xs border-collapse print:text-[9px]">
              <thead className="bg-slate-800 text-white print:bg-slate-100 print:text-slate-900 print:border-y print:border-slate-800">
                <tr>
                  <th className="px-2 py-1.5 text-left font-semibold w-16 print:py-1">Code</th>
                  <th className="px-2 py-1.5 text-left font-semibold print:py-1">Account Name</th>
                  <th className="px-2 py-1.5 text-right font-semibold" colSpan={2}>Opening Balance</th>
                  <th className="px-2 py-1.5 text-right font-semibold" colSpan={2}>Period Movements</th>
                  <th className="px-2 py-1.5 text-right font-semibold" colSpan={2}>Closing Balance</th>
                </tr>
                <tr className="bg-slate-700 text-slate-200 print:bg-slate-50 print:text-slate-700 print:border-b print:border-slate-400">
                  <th className="px-2 py-1" />
                  <th className="px-2 py-1" />
                  <th className="px-2 py-1 text-right font-medium w-28">Debit</th>
                  <th className="px-2 py-1 text-right font-medium w-28">Credit</th>
                  <th className="px-2 py-1 text-right font-medium w-28">Debit</th>
                  <th className="px-2 py-1 text-right font-medium w-28">Credit</th>
                  <th className="px-2 py-1 text-right font-medium w-28">Debit</th>
                  <th className="px-2 py-1 text-right font-medium w-28">Credit</th>
                </tr>
              </thead>
              <tbody>
                {tbModel.sections.map(sec => {
                  const isCollapsed = collapsedSections.has(sec.id);
                  return (
                    <Fragment key={sec.id}>
                      <tr className="bg-slate-100 text-slate-900 cursor-pointer select-none border-t border-slate-300" onClick={() => toggleSection(sec.id)}>
                        <td className="px-2 py-1.5 font-bold uppercase tracking-wider text-[10px]" colSpan={2}>
                          <span className="inline-flex items-center gap-1">
                            <span className="print:hidden">
                              {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                            </span>
                            {sec.label}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-[10px] text-slate-500">{isCollapsed ? fmtAccounting(sec.openingDr) : ''}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-[10px] text-slate-500">{isCollapsed ? fmtAccounting(sec.openingCr) : ''}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-[10px] text-slate-500">{isCollapsed ? fmtAccounting(sec.periodDr) : ''}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-[10px] text-slate-500">{isCollapsed ? fmtAccounting(sec.periodCr) : ''}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-[10px] text-slate-500">{isCollapsed ? fmtAccounting(sec.closingDr) : ''}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-[10px] text-slate-500">{isCollapsed ? fmtAccounting(sec.closingCr) : ''}</td>
                      </tr>
                      {!isCollapsed && sec.rows.map(r => (
                        <tr key={r.code} className="hover:bg-slate-50 border-t border-gray-100">
                          <td className="px-2 py-1 font-mono text-[10px] text-slate-500">{r.code}</td>
                          <td className="px-2 py-1 text-slate-800"><DrillLink code={r.code} name={r.name} /></td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtAccounting(r.openingDr)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtAccounting(r.openingCr)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtAccounting(r.periodDr)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtAccounting(r.periodCr)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtAccounting(r.closingDr)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtAccounting(r.closingCr)}</td>
                        </tr>
                      ))}
                      {!isCollapsed && (
                        <tr className="bg-slate-50 font-semibold border-t border-slate-300">
                          <td className="px-2 py-1.5 text-right text-[10px] uppercase" colSpan={2}>Total {sec.label}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtAccounting(sec.openingDr)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtAccounting(sec.openingCr)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtAccounting(sec.periodDr)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtAccounting(sec.periodCr)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtAccounting(sec.closingDr)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmtAccounting(sec.closingCr)}</td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-slate-800 text-white font-bold border-t-2 border-slate-900 print:bg-slate-100 print:text-slate-900 print:border-y-2 print:border-slate-900">
                  <td className="px-2 py-2 text-right uppercase tracking-wider" colSpan={2}>GRAND TOTAL</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtAccounting(tbModel.grandTotals.openingDr)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtAccounting(tbModel.grandTotals.openingCr)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtAccounting(tbModel.grandTotals.periodDr)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtAccounting(tbModel.grandTotals.periodCr)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtAccounting(tbModel.grandTotals.closingDr)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtAccounting(tbModel.grandTotals.closingCr)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          PROFIT & LOSS STATEMENT (Vertical Accountant Format)
      ═══════════════════════════════════════════════════════════════════ */}
      {reportType === 'pnl' && (
        <div className="bg-white rounded border border-gray-200 overflow-hidden print:border-0 print:rounded-none">
          <ReportToolbar />
          <StatementHeader
            title="Profit & Loss Statement"
            subtitle={`For the period ${fmtDate(dateRange.startDate)} to ${fmtDate(dateRange.endDate)}`}
          />

          {/* Compact 4-card summary band on screen only */}
          <div className="p-3 bg-slate-50 border-b border-gray-200 print:hidden">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
              <div className="p-2.5 bg-white rounded border border-gray-200 min-w-[180px]">
                <p className="text-[10px] text-slate-500 uppercase font-semibold">Net Commercial Sales</p>
                <p className="text-sm font-bold text-slate-900 mt-0.5 tabular-nums whitespace-nowrap">
                  {fmtAccounting(detailedPnL?.net_commercial_sales ?? pnlModel.netRevenue, { currency: true })}
                </p>
              </div>
              <div className="p-2.5 bg-white rounded border border-gray-200 min-w-[180px]">
                <p className="text-[10px] text-slate-500 uppercase font-semibold">Gross Profit</p>
                <p className="text-sm font-bold text-slate-900 mt-0.5 tabular-nums whitespace-nowrap">
                  {fmtAccounting(pnlModel.grossProfit, { currency: true })}
                </p>
              </div>
              <div className="p-2.5 bg-white rounded border border-gray-200 min-w-[180px]">
                <p className="text-[10px] text-slate-500 uppercase font-semibold">Operating Expenses</p>
                <p className="text-sm font-bold text-slate-900 mt-0.5 tabular-nums whitespace-nowrap">
                  {fmtAccounting(detailedPnL?.operating_expenses ?? pnlModel.totalOpex, { currency: true })}
                </p>
              </div>
              <div className={`p-2.5 rounded border min-w-[180px] ${(detailedPnL?.net_income ?? pnlModel.netProfit) >= 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
                <p className="text-[10px] text-slate-600 uppercase font-semibold">Net Profit / (Loss)</p>
                <p className={`text-sm font-bold mt-0.5 tabular-nums whitespace-nowrap ${(detailedPnL?.net_income ?? pnlModel.netProfit) >= 0 ? 'text-emerald-800' : 'text-rose-800'}`}>
                  {fmtAccounting(detailedPnL?.net_income ?? pnlModel.netProfit, { currency: true })}
                </p>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto print:overflow-visible">
            <table className="w-full text-xs border-collapse">
              <thead className="bg-slate-800 text-white print:bg-slate-100 print:text-slate-900 print:border-y print:border-slate-800">
                <tr>
                  <th className="px-2 py-1.5 text-left w-16">Code</th>
                  <th className="px-2 py-1.5 text-left">Description</th>
                  <th className="px-3 py-1.5 text-right w-40">Amount (Rp)</th>
                  <th className="px-3 py-1.5 text-right w-20">% Rev</th>
                </tr>
              </thead>
              <tbody>
                <tr className="bg-slate-100 font-bold text-slate-900 border-t border-slate-300">
                  <td colSpan={4} className="px-3 py-1.5 text-[10px] uppercase tracking-wider">Revenue</td>
                </tr>
                {pnlModel.grossSalesRows.map(r => renderPnLRow(r))}
                {pnlModel.contraRevenueRows.map(r => renderPnLRow({ ...r, name: `Less: ${r.name}` }))}
                <tr className="bg-slate-50 font-bold border-t border-slate-400">
                  <td />
                  <td className="px-2 py-1.5 text-slate-900">Net Revenue</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtAccounting(pnlModel.netRevenue)}</td>
                  <td className="px-3 py-1.5 text-right text-[10px]">100.0%</td>
                </tr>

                <tr className="bg-slate-100 font-bold text-slate-900 border-t border-slate-300">
                  <td colSpan={4} className="px-3 py-1.5 text-[10px] uppercase tracking-wider">Cost of Goods Sold</td>
                </tr>
                {pnlModel.cogsRows.map(r => renderPnLRow(r))}
                <tr className="bg-slate-50 font-semibold border-t border-slate-300">
                  <td />
                  <td className="px-2 py-1.5">Total Cost of Goods Sold</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtAccounting(-pnlModel.totalCOGS)}</td>
                  <td className="px-3 py-1.5 text-right text-[10px]">{pctStr(pnlModel.totalCOGS, pnlModel.netRevenue)}</td>
                </tr>
                <tr className="bg-slate-100 font-bold border-t border-slate-700">
                  <td />
                  <td className="px-2 py-2 text-slate-900">Gross Profit</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtAccounting(pnlModel.grossProfit)}</td>
                  <td className="px-3 py-2 text-right text-[10px]">{pctStr(pnlModel.grossProfit, pnlModel.netRevenue)}</td>
                </tr>

                <tr className="bg-slate-100 font-bold text-slate-900 border-t border-slate-300">
                  <td colSpan={4} className="px-3 py-1.5 text-[10px] uppercase tracking-wider">Operating Expenses</td>
                </tr>
                {pnlModel.opexRows.map(r => renderPnLRow(r))}
                <tr className="bg-slate-50 font-semibold border-t border-slate-300">
                  <td />
                  <td className="px-2 py-1.5">Total Operating Expenses</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtAccounting(-pnlModel.totalOpex)}</td>
                  <td className="px-3 py-1.5 text-right text-[10px]">{pctStr(pnlModel.totalOpex, pnlModel.netRevenue)}</td>
                </tr>
                <tr className="bg-slate-100 font-bold border-t border-slate-700">
                  <td />
                  <td className="px-2 py-2 text-slate-900">Operating Profit / (Loss)</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${pnlModel.operatingProfit < 0 ? 'text-red-700' : 'text-slate-900'}`}>
                    {fmtAccounting(pnlModel.operatingProfit)}
                  </td>
                  <td className="px-3 py-2 text-right text-[10px]">{pctStr(pnlModel.operatingProfit, pnlModel.netRevenue)}</td>
                </tr>

                <tr className="bg-slate-100 font-bold text-slate-900 border-t border-slate-300">
                  <td colSpan={4} className="px-3 py-1.5 text-[10px] uppercase tracking-wider">Other Income and Expenses</td>
                </tr>
                {pnlModel.otherIncomeRows.map(r => renderPnLRow(r))}
                {pnlModel.fxGainRows.map(r => renderPnLRow(r))}
                {pnlModel.fxLossRows.map(r => renderPnLRow(r, -r.amount))}
                {pnlModel.bankChargeRows.map(r => renderPnLRow(r, -r.amount))}
                {pnlModel.otherExpenseRows.map(r => renderPnLRow(r, -r.amount))}
                <tr className="bg-slate-50 font-semibold border-t border-slate-300">
                  <td />
                  <td className="px-2 py-1.5">Net Other Income / (Expenses)</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${pnlModel.netOtherIncomeAndExpenses < 0 ? 'text-red-700' : 'text-slate-900'}`}>
                    {fmtAccounting(pnlModel.netOtherIncomeAndExpenses)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-[10px]">{pctStr(pnlModel.netOtherIncomeAndExpenses, pnlModel.netRevenue)}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr className="bg-slate-100 font-bold text-slate-900 border-t-2 border-slate-800 border-b-4 border-double">
                  <td colSpan={2} className="px-3 py-2.5 text-sm uppercase tracking-wide">Net Profit / (Loss) Before Tax</td>
                  <td className={`px-3 py-2.5 text-right text-sm tabular-nums ${pnlModel.netProfit < 0 ? 'text-red-700' : 'text-slate-900'}`}>
                    {fmtAccounting(pnlModel.netProfit, { currency: true })}
                  </td>
                  <td className="px-3 py-2.5 text-right text-xs">{pctStr(pnlModel.netProfit, pnlModel.netRevenue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          BALANCE SHEET (Two-Column Side-by-Side Professional Statement)
      ═══════════════════════════════════════════════════════════════════ */}
      {reportType === 'balance_sheet' && (
        <div className="bg-white rounded border border-gray-200 overflow-hidden print:border-0 print:rounded-none">
          <ReportToolbar />
          <StatementHeader title="Balance Sheet" subtitle={`As of ${fmtDate(dateRange.endDate)}`} />

          <div className="p-4 print:p-0 print:pt-2">
            <div className="grid grid-cols-1 lg:grid-cols-2 print:grid-cols-2 gap-6 print:gap-4 items-start">
              {/* LEFT COLUMN — ASSETS */}
              <div className="border border-slate-300 print:border-slate-400">
                <div className="bg-slate-800 text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider print:bg-slate-100 print:text-slate-900 print:border-b print:border-slate-800">
                  Assets
                </div>
                <table className="w-full text-xs border-collapse">
                  <tbody>
                    <tr className="bg-slate-100 border-b border-slate-300">
                      <td colSpan={3} className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-800">Current Assets</td>
                    </tr>
                    {bsModel.currentAssets.map(renderBSColumnRow)}
                    <tr className="bg-slate-50 font-semibold border-t border-slate-400 border-b border-slate-300">
                      <td />
                      <td className="px-2 py-1.5 text-slate-900">Total Current Assets</td>
                      <td className={`pl-2 pr-3 py-1.5 text-right tabular-nums whitespace-nowrap ${bsModel.totalCurrentAssets < 0 ? 'text-red-700' : 'text-slate-900'}`}>
                        {fmtAccounting(bsModel.totalCurrentAssets)}
                      </td>
                    </tr>

                    {bsModel.nonCurrentAssets.length > 0 && (
                      <>
                        <tr className="bg-slate-100 border-b border-slate-300">
                          <td colSpan={3} className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-800">Non-current Assets</td>
                        </tr>
                        {bsModel.nonCurrentAssets.map(renderBSColumnRow)}
                        <tr className="bg-slate-50 font-semibold border-t border-slate-400 border-b border-slate-300">
                          <td />
                          <td className="px-2 py-1.5 text-slate-900">Total Non-current Assets</td>
                          <td className={`pl-2 pr-3 py-1.5 text-right tabular-nums whitespace-nowrap ${bsModel.totalNonCurrentAssets < 0 ? 'text-red-700' : 'text-slate-900'}`}>
                            {fmtAccounting(bsModel.totalNonCurrentAssets)}
                          </td>
                        </tr>
                      </>
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-100 font-bold text-slate-900 border-t-2 border-slate-800 border-b-4 border-double">
                      <td colSpan={2} className="px-3 py-2 uppercase tracking-wide">Total Assets</td>
                      <td className="pl-2 pr-3 py-2 text-right tabular-nums whitespace-nowrap">
                        {fmtAccounting(bsModel.totalAssets, { currency: true })}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* RIGHT COLUMN — LIABILITIES & EQUITY */}
              <div className="border border-slate-300 print:border-slate-400">
                <div className="bg-slate-800 text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider print:bg-slate-100 print:text-slate-900 print:border-b print:border-slate-800">
                  Liabilities & Equity
                </div>
                <table className="w-full text-xs border-collapse">
                  <tbody>
                    <tr className="bg-slate-100 border-b border-slate-300">
                      <td colSpan={3} className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-800">Current Liabilities</td>
                    </tr>
                    {bsModel.currentLiabilities.map(renderBSColumnRow)}
                    <tr className="bg-slate-50 font-semibold border-t border-slate-400 border-b border-slate-300">
                      <td />
                      <td className="px-2 py-1.5 text-slate-900">Total Current Liabilities</td>
                      <td className="pl-2 pr-3 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtAccounting(bsModel.totalCurrentLiabilities)}</td>
                    </tr>

                    {bsModel.longTermLiabilities.length > 0 && (
                      <>
                        <tr className="bg-slate-100 border-b border-slate-300">
                          <td colSpan={3} className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-800">Long-term Liabilities</td>
                        </tr>
                        {bsModel.longTermLiabilities.map(renderBSColumnRow)}
                        <tr className="bg-slate-50 font-semibold border-t border-slate-400 border-b border-slate-300">
                          <td />
                          <td className="px-2 py-1.5 text-slate-900">Total Long-term Liabilities</td>
                          <td className="pl-2 pr-3 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtAccounting(bsModel.totalLongTermLiabilities)}</td>
                        </tr>
                      </>
                    )}

                    <tr className="bg-slate-100 font-bold border-t border-slate-500 border-b border-slate-300">
                      <td colSpan={2} className="px-3 py-1.5 text-slate-900">Total Liabilities</td>
                      <td className="pl-2 pr-3 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtAccounting(bsModel.totalLiabilities)}</td>
                    </tr>

                    <tr className="bg-slate-100 border-b border-slate-300">
                      <td colSpan={3} className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-800">Equity</td>
                    </tr>
                    {bsModel.equityItems.map(renderBSColumnRow)}
                    <tr className="bg-slate-50 font-semibold border-t border-slate-400 border-b border-slate-300">
                      <td />
                      <td className="px-2 py-1.5 text-slate-900">Total Equity</td>
                      <td className={`pl-2 pr-3 py-1.5 text-right tabular-nums whitespace-nowrap ${bsModel.totalEquity < 0 ? 'text-red-700' : 'text-slate-900'}`}>
                        {fmtAccounting(bsModel.totalEquity)}
                      </td>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-100 font-bold text-slate-900 border-t-2 border-slate-800 border-b-4 border-double">
                      <td colSpan={2} className="px-3 py-2 uppercase tracking-wide">Total Liabilities & Equity</td>
                      <td className="pl-2 pr-3 py-2 text-right tabular-nums whitespace-nowrap">
                        {fmtAccounting(bsModel.totalLiabilitiesAndEquity, { currency: true })}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Accounting equation verification strip */}
            <div className={`mt-3 px-4 py-1.5 rounded text-center text-xs font-medium print:mt-2 ${bsModel.isBalanced ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-800 border border-rose-300'}`}>
              {bsModel.isBalanced
                ? `Reconciled — Total Assets (${fmtAccounting(bsModel.totalAssets, { currency: true })}) = Total Liabilities & Equity (${fmtAccounting(bsModel.totalLiabilitiesAndEquity, { currency: true })})`
                : `Out of Balance — Difference: ${fmtAccounting(bsModel.balanceDifference, { currency: true, decimals: 2 })}`}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
