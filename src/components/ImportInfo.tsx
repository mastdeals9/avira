import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import {
  Upload, ChevronUp, ChevronDown,
  ChevronsUpDown, X, RefreshCw, AlertCircle, FileSpreadsheet, Loader2, Plus, Trash2, Search, Calendar,
} from 'lucide-react';
import * as XLSX from 'xlsx';

interface ImportRow {
  id: string;
  date: string | null;
  hs_code: string;
  product_name: string;
  quantity: number;
  unit: string;
  unit_rate: number;
  currency: string;
  total_usd: number;
  origin: string;
  destination: string;
  exporter: string;
  importer: string;
  type: string;
}

type SortField = keyof Omit<ImportRow, 'id'>;
type SortDir = 'asc' | 'desc';

interface ColDef {
  key: SortField;
  label: string;
  defaultWidth: number;
  numeric?: boolean;
  dimHeader?: boolean;
}

const COLS: ColDef[] = [
  { key: 'date',        label: 'DATE',      defaultWidth: 90,  dimHeader: true },
  { key: 'hs_code',     label: 'HS CODE',   defaultWidth: 95,  dimHeader: true },
  { key: 'product_name',label: 'PRODUCT',   defaultWidth: 210 },
  { key: 'quantity',    label: 'QTY',       defaultWidth: 70,  numeric: true },
  { key: 'unit',        label: 'UNIT',      defaultWidth: 68,  dimHeader: true },
  { key: 'unit_rate',   label: 'RATE',      defaultWidth: 88,  numeric: true },
  { key: 'currency',    label: 'CCY',       defaultWidth: 58,  dimHeader: true },
  { key: 'total_usd',   label: 'TOTAL USD', defaultWidth: 105, numeric: true },
  { key: 'origin',      label: 'ORIGIN',    defaultWidth: 125 },
  { key: 'destination', label: 'DEST.',     defaultWidth: 105 },
  { key: 'exporter',    label: 'EXPORTER',  defaultWidth: 180 },
  { key: 'importer',    label: 'IMPORTER',  defaultWidth: 180 },
  { key: 'type',        label: 'TYPE',      defaultWidth: 125 },
];

const FILTER_FIELDS: { value: SortField; label: string }[] = [
  { value: 'product_name', label: 'Product' },
  { value: 'importer',     label: 'Importer' },
  { value: 'exporter',     label: 'Exporter' },
  { value: 'origin',       label: 'Origin' },
  { value: 'destination',  label: 'Destination' },
  { value: 'hs_code',      label: 'HS Code' },
  { value: 'type',         label: 'Type' },
  { value: 'currency',     label: 'Currency' },
];

interface FilterRow {
  id: number;
  field: SortField;
  value: string;
}

let filterIdCounter = 0;
function newFilter(field: SortField = 'product_name', value = ''): FilterRow {
  return { id: ++filterIdCounter, field, value };
}

export const COMPACT_ANALYSIS_KEYS: SortField[] = [
  'date', 'product_name', 'unit_rate', 'currency', 'origin', 'destination', 'exporter', 'type'
];

export interface ImportInfoProps {
  initialProduct?: string;
  compactAnalysis?: boolean;
  onClose?: () => void;
}

const DEFAULT_PAGE_SIZE = 200;
const PAGE_SIZE_OPTIONS = [100, 200, 500] as const;
const YEARS = ['2026', '2025', '2024', '2023', '2022', '2021', '2020'];
const MONTH_OPTIONS = [
  { value: '01', label: 'January' },
  { value: '02', label: 'February' },
  { value: '03', label: 'March' },
  { value: '04', label: 'April' },
  { value: '05', label: 'May' },
  { value: '06', label: 'June' },
  { value: '07', label: 'July' },
  { value: '08', label: 'August' },
  { value: '09', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
];

function getMonthDays(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDateDisplay(d: string | null): string {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function formatDateRangeLabel(from: string | null, to: string | null, year: string, month: string): string {
  if (!from && !to) return 'All Dates';
  if (year && month && from === `${year}-${month}-01`) {
    const monthLabel = MONTH_OPTIONS.find(m => m.value === month)?.label || month;
    return `${monthLabel} ${year} (${formatDateDisplay(from)} → ${formatDateDisplay(to)})`;
  }
  if (year && !month && from === `${year}-01-01` && to === `${year}-12-31`) {
    return `Full Year ${year} (${formatDateDisplay(from)} → ${formatDateDisplay(to)})`;
  }
  if (from && to) return `${formatDateDisplay(from)} → ${formatDateDisplay(to)}`;
  if (from) return `From ${formatDateDisplay(from)}`;
  if (to) return `Until ${formatDateDisplay(to)}`;
  return 'Custom Date';
}

const TYPE_COLORS: Record<string, string> = {
  'API': 'bg-blue-100 text-blue-800',
  'Finished Product': 'bg-green-100 text-green-800',
  'Excipient': 'bg-amber-100 text-amber-800',
  'Flavor / Fragrance': 'bg-pink-100 text-pink-800',
  'Agrochemical': 'bg-lime-100 text-lime-800',
  'Medical Device / Dental': 'bg-cyan-100 text-cyan-800',
};

function getTypeColor(t: string) { return TYPE_COLORS[t] || 'bg-gray-100 text-gray-700'; }

function abbreviateUnit(u: string): string {
  const map: Record<string, string> = {
    'kilogram': 'KG', 'kilograms': 'KG', 'kg': 'KG',
    'gram': 'G', 'grams': 'G',
    'liter': 'L', 'liters': 'L', 'litre': 'L', 'litres': 'L',
    'milliliter': 'ML', 'milliliters': 'ML', 'ml': 'ML',
    'piece': 'PCS', 'pieces': 'PCS', 'pcs': 'PCS', 'pc': 'PCS',
    'unit': 'PCS', 'units': 'PCS',
    'tablet': 'TAB', 'tablets': 'TAB',
    'capsule': 'CAP', 'capsules': 'CAP',
    'bottle': 'BTL', 'bottles': 'BTL',
    'box': 'BOX', 'boxes': 'BOX',
    'bag': 'BAG', 'bags': 'BAG',
    'drum': 'DRM', 'drums': 'DRM',
    'ton': 'TON', 'tons': 'TON', 'tonne': 'TON', 'tonnes': 'TON', 'mt': 'MT',
    'milligram': 'MG', 'milligrams': 'MG', 'mg': 'MG',
  };
  return map[u.toLowerCase().trim()] || u;
}

function parseDate(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  if (typeof val === 'string') {
    const c = val.trim();
    const p = c.match(/(\d{1,2})[\/\-\.](\w+)[\/\-\.](\d{2,4})/);
    if (p) {
      const mo: Record<string, string> = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
      return `${p[3].length===2?`20${p[3]}`:p[3]}-${mo[p[2].toLowerCase()]||p[2].padStart(2,'0')}-${p[1].padStart(2,'0')}`;
    }
    const d = new Date(c);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function fmtDate(v: string | null) {
  if (!v) return '-';
  const d = new Date(v + 'T00:00:00');
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()}-${m[d.getMonth()]}-${d.getFullYear()}`;
}

function fmtNum(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ImportInfo({ initialProduct, compactAnalysis = false, onClose }: ImportInfoProps = {}) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(false);

  // Date filter state
  const [datePreset, setDatePreset] = useState<'all' | '2026' | 'august_2026' | 'this_year' | 'this_month' | 'last_month' | 'custom'>('all');
  const [filterYear, setFilterYear] = useState<string>('');
  const [filterMonth, setFilterMonth] = useState<string>('');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [appliedDateRange, setAppliedDateRange] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });

  const [showAllColumns, setShowAllColumns] = useState(false);
  const isCompact = compactAnalysis && !showAllColumns;

  const activeCols = useMemo(() => {
    if (!isCompact) return COLS;
    return COLS.filter(c => COMPACT_ANALYSIS_KEYS.includes(c.key));
  }, [isCompact]);

  const [filters, setFilters] = useState<FilterRow[]>(() => [
    newFilter('product_name', initialProduct || '')
  ]);
  const [activeFilters, setActiveFilters] = useState<FilterRow[]>(() =>
    initialProduct && initialProduct.trim() ? [newFilter('product_name', initialProduct.trim())] : []
  );

  useEffect(() => {
    if (initialProduct !== undefined) {
      const trimmed = initialProduct.trim();
      const f = [newFilter('product_name', trimmed)];
      setFilters(f);
      setActiveFilters(trimmed ? f : []);
      setPage(0);
    }
  }, [initialProduct]);

  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const [colWidths, setColWidths] = useState<Record<string, number>>(
    () => Object.fromEntries(COLS.map(c => [c.key, c.defaultWidth]))
  );

  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showClear, setShowClear] = useState(false);
  const [userRole, setUserRole] = useState('');

  const fileRef = useRef<HTMLInputElement>(null);
  const resizingRef = useRef<{ key: string; startX: number; startW: number } | null>(null);

  useEffect(() => {
    supabase.from('user_profiles').select('role').maybeSingle().then(({ data }) => {
      if (data) setUserRole(data.role || '');
    });
  }, []);

  const fetchPage = useCallback(async (
    pg: number,
    af: FilterRow[],
    fromDate: string | null,
    toDate: string | null,
    ps: number
  ) => {
    setLoading(true);
    try {
      let q = supabase
        .from('import_data')
        .select('id,date,hs_code,product_name,quantity,unit,unit_rate,currency,total_usd,origin,destination,exporter,importer,type', { count: 'exact' });

      const active = af.filter(f => f.value.trim() !== '');
      for (const f of active) {
        q = q.ilike(f.field as string, `%${f.value.trim()}%`);
      }

      if (fromDate) {
        q = q.gte('date', fromDate);
      }
      if (toDate) {
        q = q.lte('date', toDate);
      }

      q = q.order(sortField as string, { ascending: sortDir === 'asc' });
      q = q.range(pg * ps, (pg + 1) * ps - 1);

      const { data, count, error } = await q;
      if (error) throw error;
      setRows((data as ImportRow[]) || []);
      setTotal(count || 0);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [sortField, sortDir]);

  useEffect(() => {
    fetchPage(page, activeFilters, appliedDateRange.from, appliedDateRange.to, pageSize);
  }, [fetchPage, page, activeFilters, appliedDateRange.from, appliedDateRange.to, pageSize]);

  function handlePageSizeChange(newSize: number) {
    const validSize = Math.min(500, Math.max(100, newSize));
    setPageSize(validSize);
    setPage(0);
  }

  function handleDatePreset(preset: 'all' | '2026' | 'august_2026' | 'this_year' | 'this_month' | 'last_month') {
    setDatePreset(preset);
    if (preset === 'all') {
      setFilterYear('');
      setFilterMonth('');
      setCustomFrom('');
      setCustomTo('');
      setAppliedDateRange({ from: null, to: null });
    } else if (preset === '2026') {
      setFilterYear('2026');
      setFilterMonth('');
      setCustomFrom('');
      setCustomTo('');
      setAppliedDateRange({ from: '2026-01-01', to: '2026-12-31' });
    } else if (preset === 'august_2026') {
      setFilterYear('2026');
      setFilterMonth('08');
      setCustomFrom('');
      setCustomTo('');
      setAppliedDateRange({ from: '2026-08-01', to: '2026-08-31' });
    } else if (preset === 'this_year') {
      const y = String(new Date().getFullYear());
      setFilterYear(y);
      setFilterMonth('');
      setCustomFrom('');
      setCustomTo('');
      setAppliedDateRange({ from: `${y}-01-01`, to: `${y}-12-31` });
    } else if (preset === 'this_month') {
      const now = new Date();
      const y = String(now.getFullYear());
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const lastDay = getMonthDays(Number(y), Number(m));
      setFilterYear(y);
      setFilterMonth(m);
      setCustomFrom('');
      setCustomTo('');
      setAppliedDateRange({ from: `${y}-${m}-01`, to: `${y}-${m}-${String(lastDay).padStart(2, '0')}` });
    } else if (preset === 'last_month') {
      const now = new Date();
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const y = String(prev.getFullYear());
      const m = String(prev.getMonth() + 1).padStart(2, '0');
      const lastDay = getMonthDays(Number(y), Number(m));
      setFilterYear(y);
      setFilterMonth(m);
      setCustomFrom('');
      setCustomTo('');
      setAppliedDateRange({ from: `${y}-${m}-01`, to: `${y}-${m}-${String(lastDay).padStart(2, '0')}` });
    }
    setPage(0);
  }

  function handleYearChange(year: string) {
    setFilterYear(year);
    setDatePreset('custom');
    if (!year) {
      if (!filterMonth) {
        setAppliedDateRange({ from: null, to: null });
      }
      setPage(0);
      return;
    }
    if (filterMonth) {
      const m = Number(filterMonth);
      const lastDay = getMonthDays(Number(year), m);
      setAppliedDateRange({
        from: `${year}-${filterMonth}-01`,
        to: `${year}-${filterMonth}-${String(lastDay).padStart(2, '0')}`
      });
    } else {
      setAppliedDateRange({
        from: `${year}-01-01`,
        to: `${year}-12-31`
      });
    }
    setPage(0);
  }

  function handleMonthChange(month: string) {
    setFilterMonth(month);
    setDatePreset('custom');
    const yearToUse = filterYear || '2026';
    if (!filterYear) setFilterYear(yearToUse);

    if (month) {
      const m = Number(month);
      const lastDay = getMonthDays(Number(yearToUse), m);
      setAppliedDateRange({
        from: `${yearToUse}-${month}-01`,
        to: `${yearToUse}-${month}-${String(lastDay).padStart(2, '0')}`
      });
    } else {
      setAppliedDateRange({
        from: `${yearToUse}-01-01`,
        to: `${yearToUse}-12-31`
      });
    }
    setPage(0);
  }

  function handleApplyCustomDate() {
    setDatePreset('custom');
    setFilterYear('');
    setFilterMonth('');
    setAppliedDateRange({
      from: customFrom || null,
      to: customTo || null,
    });
    setPage(0);
  }

  function handleClearDate() {
    handleDatePreset('all');
  }

  function handleSearch() {
    setActiveFilters([...filters]);
    setPage(0);
  }

  function handleReset() {
    const fresh = [newFilter('product_name')];
    setFilters(fresh);
    setActiveFilters([]);
    handleDatePreset('all');
    setPage(0);
  }

  function setFilterField(id: number, field: SortField) {
    setFilters(prev => prev.map(f => f.id === id ? { ...f, field } : f));
  }

  function setFilterValue(id: number, value: string) {
    setFilters(prev => prev.map(f => f.id === id ? { ...f, value } : f));
  }

  function addFilter() {
    const usedFields = filters.map(f => f.field);
    const next = FILTER_FIELDS.find(ff => !usedFields.includes(ff.value));
    setFilters(prev => [...prev, newFilter(next?.value || 'importer')]);
  }

  function removeFilter(id: number) {
    setFilters(prev => prev.length > 1 ? prev.filter(f => f.id !== id) : prev);
  }

  function handleSort(field: SortField) {
    const newDir = sortField === field ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
    setSortField(field);
    setSortDir(newDir);
    setPage(0);
  }

  function onResizeMouseDown(e: React.MouseEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = { key, startX: e.clientX, startW: colWidths[key] };
    function onMove(ev: MouseEvent) {
      const r = resizingRef.current;
      if (!r) return;
      setColWidths(prev => ({ ...prev, [r.key]: Math.max(36, r.startW + ev.clientX - r.startX) }));
    }
    function onUp() { resizingRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      setUploadMsg({ type: 'error', text: 'File exceeds maximum supported size of 25MB.' });
      return;
    }
    setUploading(true); setUploadMsg(null);
    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { type: 'array', cellDates: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
      if (!raw.length) { setUploadMsg({ type: 'error', text: 'No data found in file.' }); return; }

      const hmap: Record<string, SortField> = {
        date:'date','hs code':'hs_code',hs_code:'hs_code',hscode:'hs_code',
        product:'product_name','product name':'product_name',product_name:'product_name',
        quantity:'quantity',qty:'quantity',unit:'unit',
        'unit rate':'unit_rate',unit_rate:'unit_rate',unitrate:'unit_rate',rate:'unit_rate',
        currency:'currency','total usd':'total_usd',total_usd:'total_usd',totalusd:'total_usd','total (usd)':'total_usd',
        origin:'origin',destination:'destination',exporter:'exporter',importer:'importer',type:'type',
      };

      const keyMap: Record<string, SortField> = {};
      Object.keys(raw[0]).forEach(k => { const m = hmap[k.toLowerCase().trim()]; if (m) keyMap[k] = m; });

      const batch = raw.map(r => {
        const obj: Record<string, unknown> = {};
        Object.entries(keyMap).forEach(([rk, dk]) => {
          const v = r[rk];
          if (dk === 'date') obj[dk] = parseDate(v);
          else if (dk === 'quantity' || dk === 'unit_rate' || dk === 'total_usd') obj[dk] = parseFloat(String(v).replace(/,/g,'')) || 0;
          else obj[dk] = String(v ?? '').trim();
        });
        return obj;
      });

      let inserted = 0;
      for (let i = 0; i < batch.length; i += 500) {
        const { error } = await supabase.from('import_data').insert(batch.slice(i, i + 500));
        if (error) throw error;
        inserted += Math.min(500, batch.length - i);
      }
      setUploadMsg({ type: 'success', text: `Imported ${inserted.toLocaleString()} records.` });
      handleReset();
    } catch (err) {
      setUploadMsg({ type: 'error', text: err instanceof Error ? err.message : 'Upload failed' });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleClear() {
    await supabase.from('import_data').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    setRows([]); setTotal(0); setShowClear(false);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasActiveFilters = activeFilters.some(f => f.value.trim() !== '');
  const hasActiveDateFilter = Boolean(appliedDateRange.from || appliedDateRange.to);
  const tableW = useMemo(() => activeCols.reduce((s, c) => s + (colWidths[c.key] || c.defaultWidth), 0), [activeCols, colWidths]);

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 210px)', minHeight: 480 }}>

      {/* ── Optional Modal Header ── */}
      {onClose && (
        <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-blue-600" />
            <span className="font-bold text-sm text-gray-800">
              Import Data Analysis {initialProduct ? `— ${initialProduct}` : ''}
            </span>
            {isCompact && (
              <span className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded font-medium">
                Compact Pricing Analysis
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100 cursor-pointer"
            title="Close Import Data"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Date Filter Bar ── */}
      <div className="flex flex-col gap-2 mb-2 flex-shrink-0 bg-blue-50/60 border border-blue-200 rounded-lg p-2.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-800">
            <Calendar className="w-4 h-4 text-blue-600" />
            <span>Date Filter:</span>
          </div>

          {/* Quick presets */}
          <div className="flex items-center gap-1 flex-wrap text-xs">
            <button
              type="button"
              onClick={() => handleDatePreset('all')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors cursor-pointer ${
                datePreset === 'all' && !hasActiveDateFilter
                  ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'
              }`}
            >
              All Dates
            </button>
            <button
              type="button"
              onClick={() => handleDatePreset('2026')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors cursor-pointer ${
                datePreset === '2026'
                  ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'
              }`}
            >
              2026
            </button>
            <button
              type="button"
              onClick={() => handleDatePreset('august_2026')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors cursor-pointer ${
                datePreset === 'august_2026'
                  ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'
              }`}
            >
              August 2026
            </button>
            <button
              type="button"
              onClick={() => handleDatePreset('this_year')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors cursor-pointer ${
                datePreset === 'this_year'
                  ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'
              }`}
            >
              This Year
            </button>
            <button
              type="button"
              onClick={() => handleDatePreset('this_month')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors cursor-pointer ${
                datePreset === 'this_month'
                  ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'
              }`}
            >
              This Month
            </button>
            <button
              type="button"
              onClick={() => handleDatePreset('last_month')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors cursor-pointer ${
                datePreset === 'last_month'
                  ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'
              }`}
            >
              Last Month
            </button>
          </div>
        </div>

        {/* Year, Month and Custom Range selectors */}
        <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-blue-200/50 text-xs">
          {/* Year selector */}
          <div className="flex items-center gap-1">
            <label className="text-[11px] text-gray-500 font-medium">Year:</label>
            <select
              value={filterYear}
              onChange={e => handleYearChange(e.target.value)}
              className="px-2 py-1 text-xs border border-gray-300 rounded bg-white text-gray-800 font-medium focus:outline-none focus:ring-1 focus:ring-blue-400 cursor-pointer"
            >
              <option value="">All Years</option>
              {YEARS.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>

          {/* Month selector */}
          <div className="flex items-center gap-1">
            <label className="text-[11px] text-gray-500 font-medium">Month:</label>
            <select
              value={filterMonth}
              onChange={e => handleMonthChange(e.target.value)}
              className="px-2 py-1 text-xs border border-gray-300 rounded bg-white text-gray-800 font-medium focus:outline-none focus:ring-1 focus:ring-blue-400 cursor-pointer"
            >
              <option value="">All Months</option>
              {MONTH_OPTIONS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          {/* Custom Date Range */}
          <div className="flex items-center gap-1.5 ml-auto flex-wrap">
            <span className="text-[11px] text-gray-500 font-medium">Custom Range:</span>
            <input
              type="date"
              value={customFrom}
              onChange={e => setCustomFrom(e.target.value)}
              className="px-1.5 py-1 text-xs border border-gray-300 rounded bg-white text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-400"
              title="From Date"
            />
            <span className="text-gray-400 text-xs">→</span>
            <input
              type="date"
              value={customTo}
              onChange={e => setCustomTo(e.target.value)}
              className="px-1.5 py-1 text-xs border border-gray-300 rounded bg-white text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-400"
              title="To Date"
            />
            <button
              type="button"
              onClick={handleApplyCustomDate}
              disabled={!customFrom && !customTo}
              className="px-2.5 py-1 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40 transition-colors cursor-pointer"
            >
              Apply
            </button>
            {hasActiveDateFilter && (
              <button
                type="button"
                onClick={handleClearDate}
                className="px-2 py-1 text-xs text-gray-600 border border-gray-300 bg-white rounded hover:bg-gray-100 transition-colors cursor-pointer"
                title="Clear date filter"
              >
                Clear Date
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Filter Builder ── */}
      <div className="flex flex-col gap-1.5 mb-2 flex-shrink-0 bg-gray-50 border border-gray-200 rounded-lg p-2">
        {/* Filter rows */}
        {filters.map((f) => (
          <div key={f.id} className="flex items-center gap-1.5">
            <select name="field" aria-label="Field"
              value={f.field}
              onChange={e => setFilterField(f.id, e.target.value as SortField)}
              className="w-28 px-1.5 py-1 text-xs border border-gray-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 text-gray-700 font-medium flex-shrink-0"
            >
              {FILTER_FIELDS.map(ff => (
                <option key={ff.value} value={ff.value}>{ff.label}</option>
              ))}
            </select>

            <span className="text-[10px] text-gray-400 select-none flex-shrink-0">contains</span>

            <div className="relative flex-1 min-w-0">
              <input name="value" aria-label={`${FILTER_FIELDS.find(ff => ff.value === f.field)?.label ?? f.field}…`}
                type="text"
                value={f.value}
                onChange={e => setFilterValue(f.id, e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
                placeholder={`${FILTER_FIELDS.find(ff => ff.value === f.field)?.label ?? f.field}…`}
                className="w-full px-2 py-1 text-xs border border-gray-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 text-gray-800"
              />
              {f.value && (
                <button onClick={() => setFilterValue(f.id, '')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <button
              onClick={() => removeFilter(f.id)}
              disabled={filters.length === 1}
              className="p-0.5 text-gray-300 hover:text-red-400 disabled:opacity-0 transition-colors flex-shrink-0 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}

        {/* Bottom bar: add condition + actions */}
        <div className="flex items-center gap-2 pt-0.5">
          <button
            onClick={addFilter}
            disabled={filters.length >= FILTER_FIELDS.length}
            className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700 disabled:opacity-30 cursor-pointer"
          >
            <Plus className="w-3 h-3" />
            Add condition
          </button>

          <div className="flex-1" />

          <button
            onClick={handleSearch}
            className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors cursor-pointer"
          >
            <Search className="w-3 h-3" />
            Search
          </button>
          <button
            onClick={handleReset}
            className="px-3 py-1 text-xs font-medium border border-gray-300 bg-white text-gray-600 rounded hover:bg-gray-100 transition-colors cursor-pointer"
          >
            Reset
          </button>
          <label className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-white border border-gray-300 text-gray-600 rounded hover:bg-gray-100 cursor-pointer transition-colors whitespace-nowrap">
            <Upload className="w-3 h-3" />
            {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Upload'}
            <input name="file_upload" aria-label="Upload file" ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleUpload} className="hidden" disabled={uploading} />
          </label>
          {(userRole === 'admin' || userRole === 'manager') && (
            <button onClick={() => setShowClear(true)} className="p-1 text-red-400 hover:text-red-600 transition-colors cursor-pointer" title="Clear all data">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Active filter chips */}
      {(hasActiveFilters || hasActiveDateFilter) && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2 flex-shrink-0">
          {hasActiveDateFilter && (
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 text-[10.5px] bg-blue-100 text-blue-800 rounded-full border border-blue-300 font-medium">
              <Calendar className="w-3 h-3 text-blue-600" />
              <span>Date:</span>
              <span className="font-semibold">{formatDateRangeLabel(appliedDateRange.from, appliedDateRange.to, filterYear, filterMonth)}</span>
              <button
                type="button"
                onClick={handleClearDate}
                className="text-blue-500 hover:text-blue-700 ml-0.5 cursor-pointer"
                title="Remove date filter"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          {activeFilters.filter(f => f.value.trim()).map(f => (
            <span key={f.id} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10.5px] bg-blue-100 text-blue-800 rounded-full border border-blue-200">
              <span className="font-semibold">{FILTER_FIELDS.find(ff => ff.value === f.field)?.label}</span>
              <span className="text-blue-500">·</span>
              {f.value}
            </span>
          ))}
          <button onClick={handleReset} className="inline-flex items-center gap-0.5 px-2 py-0.5 text-[10.5px] bg-gray-100 text-gray-500 rounded-full hover:bg-gray-200 border border-gray-200 cursor-pointer">
            <X className="w-2.5 h-2.5" /> Clear All
          </button>
        </div>
      )}

      {/* Upload message */}
      {uploadMsg && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs mb-2 flex-shrink-0 ${uploadMsg.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
          {uploadMsg.type === 'error' && <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />}
          {uploadMsg.text}
          <button onClick={() => setUploadMsg(null)} className="ml-auto"><X className="w-3 h-3" /></button>
        </div>
      )}

      {/* Stats + pagination */}
      <div className="flex items-center gap-3 mb-2 flex-shrink-0 text-xs text-gray-500 flex-wrap">
        <span>
          Showing <span className="font-semibold text-gray-800">{total === 0 ? '0' : (page * pageSize + 1).toLocaleString()}–{Math.min((page + 1) * pageSize, total).toLocaleString()}</span> of{' '}
          <span className="font-semibold text-gray-800">{total.toLocaleString()}</span> records
          {totalPages > 1 && <span className="text-gray-400"> · page {page + 1} of {totalPages}</span>}
        </span>

        {/* Page size selector */}
        <div className="flex items-center gap-1 ml-1 text-xs">
          <label className="text-gray-400 text-[11px]">Show:</label>
          <select
            value={pageSize}
            onChange={e => handlePageSizeChange(Number(e.target.value))}
            className="px-1.5 py-0.5 text-xs border border-gray-300 rounded bg-white text-gray-700 font-medium focus:outline-none focus:ring-1 focus:ring-blue-400 cursor-pointer"
          >
            {PAGE_SIZE_OPTIONS.map(sz => (
              <option key={sz} value={sz}>{sz} / page</option>
            ))}
          </select>
        </div>

        {compactAnalysis && (
          <button
            type="button"
            onClick={() => setShowAllColumns(!showAllColumns)}
            className="text-[11px] text-blue-600 hover:text-blue-800 underline font-medium cursor-pointer"
          >
            {showAllColumns ? 'Compact Analysis View' : 'Show All Columns'}
          </button>
        )}
        {totalPages > 1 && (
          <div className="flex items-center gap-1 ml-2">
            <button onClick={() => setPage(0)} disabled={page === 0} className="px-1.5 py-0.5 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50 cursor-pointer" title="First page">«</button>
            <button onClick={() => setPage(p => p - 1)} disabled={page === 0} className="px-1.5 py-0.5 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50 cursor-pointer" title="Previous page">‹</button>
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white font-medium">{page + 1}</span>
            <button onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1} className="px-1.5 py-0.5 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50 cursor-pointer" title="Next page">›</button>
            <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1} className="px-1.5 py-0.5 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50 cursor-pointer" title="Last page">»</button>
          </div>
        )}
        <button onClick={() => fetchPage(page, activeFilters, appliedDateRange.from, appliedDateRange.to, pageSize)} className="ml-auto flex items-center gap-1 hover:text-gray-700 text-gray-400 cursor-pointer">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Table */}
      {total === 0 && !loading ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-16 text-gray-400">
          <FileSpreadsheet className="w-12 h-12 mb-3 opacity-30" />
          <p className="font-medium text-gray-500 mb-1">{hasActiveFilters ? 'No records match your filters' : 'No import data yet'}</p>
          {!hasActiveFilters && <p className="text-sm">Upload a CSV or Excel file to get started</p>}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-gray-200 shadow-sm" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity 0.15s' }}>
          <table className="border-collapse" style={{ tableLayout: 'fixed', width: tableW, fontSize: '11px' }}>
            <thead className="sticky top-0 z-20">
              <tr className="bg-gray-700 text-white">
                {activeCols.map(col => (
                  <th key={col.key} style={{ width: colWidths[col.key], minWidth: 36, position: 'relative' }}
                    className="px-0 py-0 text-left font-semibold border-r border-gray-600 last:border-r-0 overflow-hidden">
                    <button onClick={() => handleSort(col.key)}
                      className="flex items-center gap-1 px-2 py-1.5 hover:text-blue-300 text-left w-full overflow-hidden" title={col.label}>
                      <span className={`truncate ${col.dimHeader ? 'text-[9.5px] text-gray-300 font-medium tracking-wide' : 'text-[10.5px]'}`}>
                        {col.label}
                      </span>
                      {sortField === col.key
                        ? (sortDir === 'asc' ? <ChevronUp className="w-2.5 h-2.5 flex-shrink-0 text-blue-300" /> : <ChevronDown className="w-2.5 h-2.5 flex-shrink-0 text-blue-300" />)
                        : <ChevronsUpDown className="w-2.5 h-2.5 flex-shrink-0 text-gray-500" />}
                    </button>
                    <div onMouseDown={e => onResizeMouseDown(e, col.key)}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize z-10"
                      style={{ background: 'transparent' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(96,165,250,0.6)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.id} className={`border-b border-gray-100 hover:bg-blue-50 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}`}>
                  {activeCols.some(c => c.key === 'date') && (
                    <td style={{ width: colWidths.date }} className="px-2 py-1 border-r border-gray-100 overflow-hidden whitespace-nowrap text-gray-500 text-[10.5px]">{fmtDate(row.date)}</td>
                  )}
                  {activeCols.some(c => c.key === 'hs_code') && (
                    <td style={{ width: colWidths.hs_code }} className="px-2 py-1 border-r border-gray-100 overflow-hidden whitespace-nowrap font-mono text-gray-500 text-[10px]">{row.hs_code}</td>
                  )}
                  {activeCols.some(c => c.key === 'product_name') && (
                    <td style={{ width: colWidths.product_name }} className="px-2 py-1 border-r border-gray-100 overflow-hidden font-medium text-gray-900 text-[11px]" title={row.product_name}><div className="truncate">{row.product_name}</div></td>
                  )}
                  {activeCols.some(c => c.key === 'quantity') && (
                    <td style={{ width: colWidths.quantity }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-right whitespace-nowrap text-gray-700 text-[10.5px]">{row.quantity.toLocaleString()}</td>
                  )}
                  {activeCols.some(c => c.key === 'unit') && (
                    <td style={{ width: colWidths.unit }} className="px-2 py-1 border-r border-gray-100 overflow-hidden whitespace-nowrap text-gray-500 text-[10px] uppercase">{abbreviateUnit(row.unit)}</td>
                  )}
                  {activeCols.some(c => c.key === 'unit_rate') && (
                    <td style={{ width: colWidths.unit_rate }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-right whitespace-nowrap font-medium text-emerald-700 text-[10.5px]">{fmtNum(row.unit_rate)}</td>
                  )}
                  {activeCols.some(c => c.key === 'currency') && (
                    <td style={{ width: colWidths.currency }} className="px-2 py-1 border-r border-gray-100 overflow-hidden whitespace-nowrap text-gray-500 text-[10px] font-mono">{row.currency}</td>
                  )}
                  {activeCols.some(c => c.key === 'total_usd') && (
                    <td style={{ width: colWidths.total_usd }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-right whitespace-nowrap font-medium text-blue-700 text-[10.5px]">{fmtNum(row.total_usd)}</td>
                  )}
                  {activeCols.some(c => c.key === 'origin') && (
                    <td style={{ width: colWidths.origin }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-gray-600 text-[10.5px]" title={row.origin}><div className="truncate">{row.origin}</div></td>
                  )}
                  {activeCols.some(c => c.key === 'destination') && (
                    <td style={{ width: colWidths.destination }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-gray-600 text-[10.5px]" title={row.destination}><div className="truncate">{row.destination}</div></td>
                  )}
                  {activeCols.some(c => c.key === 'exporter') && (
                    <td style={{ width: colWidths.exporter }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-gray-700 text-[10.5px]" title={row.exporter}><div className="truncate">{row.exporter}</div></td>
                  )}
                  {activeCols.some(c => c.key === 'importer') && (
                    <td style={{ width: colWidths.importer }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-gray-700 text-[10.5px]" title={row.importer}><div className="truncate">{row.importer}</div></td>
                  )}
                  {activeCols.some(c => c.key === 'type') && (
                    <td style={{ width: colWidths.type }} className="px-2 py-1 overflow-hidden">
                      {row.type ? <span className={`inline-block px-1.5 py-0.5 rounded-full text-[9px] font-medium whitespace-nowrap ${getTypeColor(row.type)}`}>{row.type}</span> : '-'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Clear confirm */}
      {showClear && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <AlertCircle className="w-6 h-6 text-red-500 flex-shrink-0" />
              <h3 className="font-semibold text-gray-900">Clear all import data?</h3>
            </div>
            <p className="text-sm text-gray-600 mb-5">This permanently deletes all {total.toLocaleString()} records and cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowClear(false)} className="flex-1 px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleClear} className="flex-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Delete All</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
