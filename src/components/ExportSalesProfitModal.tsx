import { useState } from 'react';
import { Calendar, CheckCircle2, Download, FileSpreadsheet, Layers, Loader2, X } from 'lucide-react';
import { ExportDateRangeOptions, generateSalesProfitabilityExcel } from '../utils/salesProfitabilityExcelExport';

interface ExportSalesProfitModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentStartDate: string;
  currentEndDate: string;
}

const MONTHS = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
];

const YEARS = [2027, 2026, 2025, 2024];

export function ExportSalesProfitModal({
  isOpen,
  onClose,
  currentStartDate,
  currentEndDate,
}: ExportSalesProfitModalProps) {
  const [exportFormat, setExportFormat] = useState<'consolidated' | 'detailed'>('detailed');
  const [exportMode, setExportMode] = useState<'this_year' | 'specific_month' | 'custom' | 'current_screen'>('current_screen');
  const [selectedYear, setSelectedYear] = useState<number>(2026);
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1);
  const [customStart, setCustomStart] = useState<string>(currentStartDate || '2026-01-01');
  const [customEnd, setCustomEnd] = useState<string>(currentEndDate || '2026-12-31');

  const [loading, setLoading] = useState<boolean>(false);
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [progressPct, setProgressPct] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  // Resolve effective date range based on selection
  const resolveDateRange = (): ExportDateRangeOptions => {
    let modeLabel = '';
    let start = '';
    let end = '';

    if (exportMode === 'this_year') {
      start = `${selectedYear}-01-01`;
      end = `${selectedYear}-12-31`;
      modeLabel = `Full_Year_${selectedYear}`;
    } else if (exportMode === 'specific_month') {
      const monthStr = String(selectedMonth).padStart(2, '0');
      start = `${selectedYear}-${monthStr}-01`;
      const lastDay = new Date(selectedYear, selectedMonth, 0).getDate();
      end = `${selectedYear}-${monthStr}-${String(lastDay).padStart(2, '0')}`;
      const mName = MONTHS.find(m => m.value === selectedMonth)?.label || monthStr;
      modeLabel = `${mName}_${selectedYear}`;
    } else if (exportMode === 'current_screen') {
      start = currentStartDate;
      end = currentEndDate;
      modeLabel = 'Screen_Range';
    } else {
      start = customStart;
      end = customEnd;
      modeLabel = 'Custom_Range';
    }

    return {
      mode: exportMode,
      year: selectedYear,
      month: selectedMonth,
      startDate: start,
      endDate: end,
      label: modeLabel,
      exportFormat,
    };
  };

  const resolved = resolveDateRange();

  const handleStartExport = async () => {
    setLoading(true);
    setError(null);
    setProgressPct(0);
    setProgressMsg('Preparing Excel workbook...');

    try {
      await generateSalesProfitabilityExcel(resolved, (step, pct) => {
        setProgressMsg(step);
        setProgressPct(pct);
      });
      setTimeout(() => {
        setLoading(false);
        onClose();
      }, 500);
    } catch (err: any) {
      console.error('Export error:', err);
      setError(err.message || 'Failed to export report');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-4">
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-gray-900 bg-opacity-60 transition-opacity backdrop-blur-sm"
          onClick={() => !loading && onClose()}
        />

        {/* Modal Window */}
        <div className="relative bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden border border-gray-100 animate-in fade-in zoom-in-95 duration-200">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 bg-gradient-to-r from-emerald-700 to-teal-800 text-white">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-white/10 rounded-lg backdrop-blur-md">
                <FileSpreadsheet className="w-5 h-5 text-emerald-200" />
              </div>
              <div>
                <h3 className="text-sm font-bold tracking-tight">Export Sales Profitability</h3>
                <p className="text-[11px] text-emerald-100">Professional formatted report with borders & currency alignment</p>
              </div>
            </div>
            {!loading && (
              <button
                onClick={onClose}
                className="p-1 rounded-lg text-emerald-100 hover:text-white hover:bg-white/10 transition"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Body */}
          <div className="p-5 space-y-4">
            {/* 1. Detail Level Selector */}
            <div>
              <label className="block text-[11px] font-bold text-gray-700 uppercase tracking-wider mb-2">
                1. Select Report Content Format
              </label>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => setExportFormat('consolidated')}
                  className={`text-left p-3 rounded-lg border text-xs transition relative ${
                    exportFormat === 'consolidated'
                      ? 'border-emerald-600 bg-emerald-50/60 ring-1 ring-emerald-600 text-emerald-950 font-medium'
                      : 'border-gray-200 hover:border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-bold text-sm text-gray-900">
                      <Layers className="w-4 h-4 text-emerald-600" />
                      Consolidated
                    </div>
                    <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-emerald-100 text-emerald-800 uppercase tracking-wider">
                      Screen View
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-500 mt-1">
                    Summary + Product Profitability sheets. Clean, fast executive view.
                  </div>
                </button>

                <button
                  type="button"
                  disabled={loading}
                  onClick={() => setExportFormat('detailed')}
                  className={`text-left p-3 rounded-lg border text-xs transition relative ${
                    exportFormat === 'detailed'
                      ? 'border-emerald-600 bg-emerald-50/60 ring-1 ring-emerald-600 text-emerald-950 font-medium'
                      : 'border-gray-200 hover:border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-bold text-sm text-gray-900">
                      <FileSpreadsheet className="w-4 h-4 text-teal-600" />
                      Full Detail
                    </div>
                    <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-gray-100 text-gray-600">
                      3 Sheets
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-500 mt-1">
                    SUMMARY, PRODUCT PROFITABILITY, and invoice-level SALES DETAIL.
                  </div>
                </button>
              </div>
            </div>

            {/* 2. Scope Selection */}
            <div>
              <label className="block text-[11px] font-bold text-gray-700 uppercase tracking-wider mb-2">
                2. Select Date Period Scope
              </label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'current_screen', title: 'Current Screen', desc: `${currentStartDate} to ${currentEndDate}` },
                  { id: 'this_year', title: 'Full Year', desc: `All 12 months (${selectedYear})` },
                  { id: 'specific_month', title: 'Specific Month', desc: 'Full single month' },
                  { id: 'custom', title: 'Custom Date', desc: 'Choose custom start & end' },
                ].map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={loading}
                    onClick={() => setExportMode(opt.id as any)}
                    className={`text-left p-2.5 rounded-lg border text-xs transition relative ${
                      exportMode === opt.id
                        ? 'border-emerald-600 bg-emerald-50/60 ring-1 ring-emerald-600 text-emerald-950 font-medium'
                        : 'border-gray-200 hover:border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <div className="font-semibold text-xs text-gray-900">{opt.title}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5 truncate">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Scope Options Card */}
            <div className="bg-gray-50/80 rounded-lg p-3.5 border border-gray-200 space-y-2.5">
              {/* Year Selector */}
              {(exportMode === 'this_year' || exportMode === 'specific_month') && (
                <div>
                  <label className="block text-[11px] font-medium text-gray-700 mb-1">Target Year</label>
                  <select name="target_year" aria-label="Target Year"
                    value={selectedYear}
                    disabled={loading}
                    onChange={e => setSelectedYear(Number(e.target.value))}
                    className="w-full text-xs px-3 py-1.5 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    {YEARS.map(y => (
                      <option key={y} value={y}>
                        Year {y}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Month Selector */}
              {exportMode === 'specific_month' && (
                <div>
                  <label className="block text-[11px] font-medium text-gray-700 mb-1">Target Month</label>
                  <select name="target_month" aria-label="Target Month"
                    value={selectedMonth}
                    disabled={loading}
                    onChange={e => setSelectedMonth(Number(e.target.value))}
                    className="w-full text-xs px-3 py-1.5 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    {MONTHS.map(m => (
                      <option key={m.value} value={m.value}>
                        {m.label} ({selectedYear})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Custom Date Pickers */}
              {exportMode === 'custom' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-medium text-gray-700 mb-1">Start Date</label>
                    <input name="start_date" aria-label="Start Date"
                      type="date"
                      value={customStart}
                      disabled={loading}
                      onChange={e => setCustomStart(e.target.value)}
                      className="w-full text-xs px-2.5 py-1.5 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-gray-700 mb-1">End Date</label>
                    <input name="end_date" aria-label="End Date"
                      type="date"
                      value={customEnd}
                      disabled={loading}
                      onChange={e => setCustomEnd(e.target.value)}
                      className="w-full text-xs px-2.5 py-1.5 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                </div>
              )}

              {/* Range Confirmation Summary */}
              <div className="pt-2 border-t border-gray-200 flex items-center justify-between text-xs text-gray-600">
                <span className="flex items-center gap-1 text-[11px]">
                  <Calendar className="w-3.5 h-3.5 text-gray-400" />
                  Resolved Period:
                </span>
                <span className="font-mono font-semibold text-xs text-gray-900">
                  {resolved.startDate} → {resolved.endDate}
                </span>
              </div>
            </div>

            {/* Excel Structure Info Callout */}
            <div className="bg-emerald-50/70 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900 space-y-1">
              <div className="font-semibold flex items-center gap-1.5 text-xs text-emerald-950">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                {exportFormat === 'consolidated'
                  ? 'Consolidated Report Format (2 Sheets):'
                  : 'Complete Sales Profitability Workbook (3 Sheets):'}
              </div>
              <p className="text-[11px] text-emerald-800 leading-normal">
                {exportFormat === 'consolidated'
                  ? 'Exports SUMMARY (executive metrics & monthly trend) and PRODUCT PROFITABILITY with IDR formatting, frozen headers, and filters.'
                  : 'Exports SUMMARY, PRODUCT PROFITABILITY, and SALES DETAIL (one row per invoice item) with IDR formatting, frozen headers, and filters.'}
              </p>
              <p className="text-[10px] text-emerald-700/90 pt-0.5">
                Audit Safe: Cancelled sales invoices are automatically excluded from revenue, COGS, and sales totals.
              </p>
            </div>

            {/* Error Message */}
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                <strong>Export Error:</strong> {error}
              </div>
            )}

            {/* Progress Bar during loading */}
            {loading && (
              <div className="space-y-1.5 pt-1">
                <div className="flex justify-between text-xs text-gray-600">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600" />
                    {progressMsg || 'Processing...'}
                  </span>
                  <span className="font-mono font-semibold">{progressPct}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-emerald-600 h-1.5 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-end gap-2.5">
            <button
              type="button"
              disabled={loading}
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 transition disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={handleStartExport}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-sm transition disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Exporting Report...
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5" />
                  {exportFormat === 'consolidated' ? 'Export Consolidated Excel' : 'Generate Full Drill-Down'}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
