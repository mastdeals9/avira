import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart2,
  Calendar,
  ChevronDown,
  ChevronRight,
  Download,
  HelpCircle,
  Info,
  Layers,
  Maximize2,
  Package,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
  Truck,
  X,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { formatCurrency, formatNumber } from '../../utils/currency';
import { ExportSalesProfitModal } from '../../components/ExportSalesProfitModal';
import {
  resolveAuthoritativeInvoiceItemCOGS,
  normalizeProductProfitabilityRow,
  normalizeBatchProfitabilityRow,
} from '../../services/salesProfitabilityEngine';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CompanyProfitabilitySummary {
  gross_sales: number;
  sales_returns?: number;
  net_sales?: number;
  product_cost: number;
  return_cogs?: number;
  net_product_cost?: number;
  sales_expenses: number;
  unallocated_sales_expenses: number;
  gross_profit: number;
  profit_after_sales_expenses: number;
  profit_margin_pct: number;
  total_qty_sold: number;
  order_count: number;
  product_count: number;
  cancelled_invoices?: {
    count: number;
    total_amount: number;
    subtotal: number;
    total_qty: number;
  };
}

export interface ProductProfitabilityRow {
  product_id: string;
  product_name: string;
  product_code: string;
  product_unit: string;
  current_stock: number;
  reserved_stock?: number;
  available_stock?: number;
  sold_qty: number;
  gross_sales: number;
  product_cost: number | null;
  sales_expense: number;
  gross_profit: number | null;
  profit_after_sales_expense: number | null;
  avg_landed_cost: number | null;
  avg_selling_price: number;
  sales_expense_per_unit: number;
  net_selling_price_per_unit: number;
  profit_per_unit: number | null;
  profit_margin_pct: number | null;
  costed_lines: number;
  total_lines: number;
  has_unreported_cost: boolean;
}

export interface MonthlyProfitabilityRow {
  month_label: string;
  month_start: string;
  gross_sales: number;
  product_cost: number;
  sales_expenses: number;
  gross_profit: number;
  profit_after_sales_expenses: number;
  profit_margin_pct: number;
  total_qty_sold: number;
  order_count: number;
}

export interface ProfitabilitySummaryResponse {
  company: CompanyProfitabilitySummary;
  products: ProductProfitabilityRow[];
  monthly: MonthlyProfitabilityRow[];
}

export interface BatchProfitabilityRow {
  batch_id: string;
  batch_number: string;
  current_stock: number;
  sold_qty: number;
  cost_per_unit: number | null;
  gross_sales: number;
  product_cost: number | null;
  sales_expense: number;
  gross_profit: number | null;
  profit_after_sales_expense: number | null;
  avg_selling_price: number;
  sales_expense_per_unit: number;
  net_selling_price_per_unit: number;
  profit_per_unit: number | null;
  profit_margin_pct: number | null;
  is_imported: boolean;
  cost_breakdown: {
    is_imported: boolean;
    import_price: number | null;
    import_price_usd: number | null;
    exchange_rate: number | null;
    duty_charges: number | null;
    freight_charges: number | null;
    other_charges: number | null;
    landed_cost_per_unit: number | null;
    local_cost_per_unit: number | null;
  };
}

export interface OrderSaleRow {
  line_id: string;
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  customer_id: string;
  customer_name: string;
  sales_order_id: string | null;
  so_number: string | null;
  dc_id: string | null;
  dc_number: string | null;
  quantity: number;
  selling_price: number;
  gross_sales: number;
  unit_cost: number | null;
  line_cost: number | null;
  line_sales_expense: number;
  net_selling_realization: number;
  gross_profit: number | null;
  profit: number | null;
  profit_margin_pct: number | null;
  expenses: Array<{
    id: string;
    voucher_number: string;
    category: string;
    total_amount: number;
    description: string;
    expense_date: string;
  }>;
}

// ─── Helpers & Tooltips ──────────────────────────────────────────────────────

function TooltipHeader({ title, tooltip }: { title: string; tooltip: string }) {
  return (
    <span className="inline-flex items-center gap-1 group relative cursor-help">
      <span>{title}</span>
      <HelpCircle className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-600 transition-colors" />
      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-50 w-52 p-2 bg-gray-900 text-white text-[11px] rounded shadow-lg font-normal leading-tight text-center pointer-events-none">
        {tooltip}
        <span className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-gray-900" />
      </span>
    </span>
  );
}

function MarginBadge({ pct }: { pct: number | null }) {
  if (pct == null) {
    return <span className="text-xs text-amber-700 font-medium">Cost unavailable</span>;
  }
  // Safety guard: margin > 100% indicates anomalous negative COGS on positive sales
  if (pct > 100) {
    return <span className="text-xs text-amber-700 font-medium">Cost anomaly</span>;
  }
  const isGood = pct >= 15;
  const isPositive = pct >= 0;
  const badgeCls = isGood
    ? 'bg-green-100 text-green-800'
    : isPositive
    ? 'bg-emerald-50 text-emerald-700'
    : 'bg-red-100 text-red-700';

  const Icon = isPositive ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${badgeCls}`}>
      <Icon className="w-3 h-3" />
      {formatNumber(pct, 1)}%
    </span>
  );
}

// ─── Date Presets ────────────────────────────────────────────────────────────

function getDatePreset(preset: string): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  const toYMD = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  switch (preset) {
    case 'today':
      return { start: toYMD(now), end: toYMD(now) };
    case 'this_month': {
      const start = new Date(year, month, 1);
      const end = new Date(year, month + 1, 0);
      return { start: toYMD(start), end: toYMD(end) };
    }
    case 'last_month': {
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0);
      return { start: toYMD(start), end: toYMD(end) };
    }
    case 'this_quarter': {
      const qStartMonth = Math.floor(month / 3) * 3;
      const start = new Date(year, qStartMonth, 1);
      const end = new Date(year, qStartMonth + 3, 0);
      return { start: toYMD(start), end: toYMD(end) };
    }
    case 'this_year': {
      const start = new Date(year, 0, 1);
      const end = new Date(year, 11, 31);
      return { start: toYMD(start), end: toYMD(end) };
    }
    case 'last_year': {
      const start = new Date(year - 1, 0, 1);
      const end = new Date(year - 1, 11, 31);
      return { start: toYMD(start), end: toYMD(end) };
    }
    case 'all_time':
    default:
      return { start: '2025-01-01', end: toYMD(now) };
  }
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function CanonicalSalesProfitReport() {
  const [datePreset, setDatePreset] = useState<string>('this_year');
  const [startDate, setStartDate] = useState<string>('2026-01-01');
  const [endDate, setEndDate] = useState<string>('2026-12-31');

  const [data, setData] = useState<ProfitabilitySummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Inline drilldown states
  const [expandedProductIds, setExpandedProductIds] = useState<Set<string>>(new Set());
  const [expandedBatchIds, setExpandedBatchIds] = useState<Set<string>>(new Set());
  const [batchesCache, setBatchesCache] = useState<Record<string, BatchProfitabilityRow[]>>({});
  const [ordersCache, setOrdersCache] = useState<Record<string, OrderSaleRow[]>>({});
  const [loadingBatchesMap, setLoadingBatchesMap] = useState<Record<string, boolean>>({});
  const [loadingOrdersMap, setLoadingOrdersMap] = useState<Record<string, boolean>>({});

  // Centered In-screen Pop-up Modal states
  const [selectedProduct, setSelectedProduct] = useState<ProductProfitabilityRow | null>(null);
  const [modalProductBatches, setModalProductBatches] = useState<BatchProfitabilityRow[]>([]);
  const [loadingModalBatches, setLoadingModalBatches] = useState(false);
  const [modalExpandedBatchId, setModalExpandedBatchId] = useState<string | null>(null);

  // Excel Export Modal state
  const [showExportModal, setShowExportModal] = useState(false);

  // Load summary data
  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ data: res, error: rpcErr }, { data: stockData, error: stockErr }] = await Promise.all([
        supabase.rpc('get_sales_profitability_summary', {
          p_start_date: startDate,
          p_end_date: endDate,
        }),
        supabase
          .from('inventory_v1_stock_summary')
          .select('product_id, total_current_stock, reserved_stock, available_quantity'),
      ]);

      if (rpcErr) throw rpcErr;
      if (stockErr) console.warn('Could not load inventory_v1_stock_summary:', stockErr);

      const stockMap = new Map<string, { current: number; reserved: number; available: number }>();
      (stockData || []).forEach((row: any) => {
        stockMap.set(row.product_id, {
          current: Number(row.total_current_stock ?? 0),
          reserved: Number(row.reserved_stock ?? 0),
          available: Number(row.available_quantity ?? 0),
        });
      });

      const rawSummary = res as any;
      if (rawSummary?.products) {
        rawSummary.products = rawSummary.products.map((p: any) => {
          const canonical = stockMap.get(p.product_id);
          return normalizeProductProfitabilityRow(p, canonical);
        });
      }

      setData(rawSummary as ProfitabilitySummaryResponse);
    } catch (err: any) {
      console.error('Error loading sales profitability summary:', err);
      setError(err.message || 'Failed to load profitability summary');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  // Reset caches on date range change
  useEffect(() => {
    setBatchesCache({});
    setOrdersCache({});
    setExpandedProductIds(new Set());
    setExpandedBatchIds(new Set());
  }, [startDate, endDate]);

  // Handle preset change
  const handlePresetChange = (preset: string) => {
    setDatePreset(preset);
    if (preset !== 'custom') {
      const { start, end } = getDatePreset(preset);
      setStartDate(start);
      setEndDate(end);
    }
  };

  const fetchProductBatches = useCallback(async (productId: string) => {
    if (batchesCache[productId]) return batchesCache[productId];
    setLoadingBatchesMap(prev => ({ ...prev, [productId]: true }));
    try {
      const { data: res, error: rpcErr } = await supabase.rpc('get_sales_profitability_product_batches', {
        p_product_id: productId,
        p_start_date: startDate,
        p_end_date: endDate,
      });
      if (rpcErr) throw rpcErr;
      const rawBatches = Array.isArray(res) ? res : (res?.batches || []);
      const bList = rawBatches.map(normalizeBatchProfitabilityRow);
      setBatchesCache(prev => ({ ...prev, [productId]: bList }));
      return bList;
    } catch (err: any) {
      console.error('Error loading product batches:', err);
      return [];
    } finally {
      setLoadingBatchesMap(prev => ({ ...prev, [productId]: false }));
    }
  }, [startDate, endDate, batchesCache]);

  const fetchBatchOrders = useCallback(async (batchId: string) => {
    if (!batchId || ordersCache[batchId]) return ordersCache[batchId] || [];
    setLoadingOrdersMap(prev => ({ ...prev, [batchId]: true }));
    try {
      const { data: res, error: rpcErr } = await supabase.rpc('get_sales_profitability_batch_orders', {
        p_batch_id: batchId,
        p_start_date: startDate,
        p_end_date: endDate,
      });
      if (rpcErr) throw rpcErr;
      const rawOrders = (Array.isArray(res) ? res : (res?.orders || [])) as any[];

      // Resolve authoritative cost layer allocations
      const lineIds = rawOrders.map(o => o.line_id).filter(Boolean);
      const siiMap = new Map<string, any>();
      if (lineIds.length > 0) {
        const { data: siiRows } = await supabase
          .from('sales_invoice_items')
          .select('id, quantity, unit_price, cogs_unit_cost, cogs_total_cost, cogs_layer_allocations')
          .in('id', lineIds);
        (siiRows || []).forEach((row: any) => siiMap.set(row.id, row));
      }

      const oList: OrderSaleRow[] = rawOrders.map(ord => {
        const sii = siiMap.get(ord.line_id);
        const grossSales = Number(ord.gross_sales ?? ((Number(ord.quantity) || 0) * (Number(ord.selling_price) || 0)));
        const fallbackUnitCost = ord.unit_cost != null ? Number(ord.unit_cost) : null;
        const costResolution = resolveAuthoritativeInvoiceItemCOGS(ord, sii, fallbackUnitCost);
        const lineCost = costResolution.lineCost;
        const unitCost = costResolution.unitCost;
        const salesExp = Number(ord.line_sales_expense ?? ord.sales_expense ?? 0);
        const netRealization = Math.round((grossSales - salesExp) * 100) / 100;
        const grossProfit = lineCost != null ? Math.round((grossSales - lineCost) * 100) / 100 : null;
        const netProfit = grossProfit != null ? Math.round((grossProfit - salesExp) * 100) / 100 : null;
        const marginPct = (grossSales > 0 && netProfit != null) ? (netProfit / grossSales) * 100 : null;

        return {
          line_id: ord.line_id,
          invoice_id: ord.invoice_id,
          invoice_number: ord.invoice_number,
          invoice_date: ord.invoice_date,
          customer_id: ord.customer_id,
          customer_name: ord.customer_name || 'Unknown Customer',
          sales_order_id: ord.sales_order_id || null,
          so_number: ord.so_number || null,
          dc_id: ord.dc_id || null,
          dc_number: ord.dc_number || null,
          quantity: Number(ord.quantity || 0),
          selling_price: Number(ord.selling_price || 0),
          gross_sales: grossSales,
          unit_cost: unitCost,
          line_cost: lineCost,
          line_sales_expense: salesExp,
          net_selling_realization: netRealization,
          gross_profit: grossProfit,
          profit: netProfit,
          profit_margin_pct: marginPct != null ? Math.round(marginPct * 100) / 100 : null,
          expenses: Array.isArray(ord.expenses) ? ord.expenses : [],
        };
      });

      setOrdersCache(prev => ({ ...prev, [batchId]: oList }));
      return oList;
    } catch (err: any) {
      console.error('Error loading batch orders:', err);
      return [];
    } finally {
      setLoadingOrdersMap(prev => ({ ...prev, [batchId]: false }));
    }
  }, [startDate, endDate, ordersCache]);

  const toggleProductExpand = useCallback((productId: string) => {
    setExpandedProductIds(prev => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
        void fetchProductBatches(productId);
      }
      return next;
    });
  }, [fetchProductBatches]);

  const toggleBatchExpand = useCallback((batchId: string) => {
    setExpandedBatchIds(prev => {
      const next = new Set(prev);
      if (next.has(batchId)) {
        next.delete(batchId);
      } else {
        next.add(batchId);
        void fetchBatchOrders(batchId);
      }
      return next;
    });
  }, [fetchBatchOrders]);

  // Open Product Drilldown Modal
  const handleOpenProduct = async (prod: ProductProfitabilityRow) => {
    setSelectedProduct(prod);
    setModalExpandedBatchId(null);
    setLoadingModalBatches(true);
    try {
      const bList = await fetchProductBatches(prod.product_id);
      setModalProductBatches(bList);
    } catch (err: any) {
      console.error('Error loading product batches:', err);
    } finally {
      setLoadingModalBatches(false);
    }
  };

  const toggleModalBatchExpand = async (batchId: string) => {
    if (modalExpandedBatchId === batchId) {
      setModalExpandedBatchId(null);
    } else {
      setModalExpandedBatchId(batchId);
      void fetchBatchOrders(batchId);
    }
  };

  const filteredProducts = useMemo(() => {
    if (!data?.products) return [];
    if (!search.trim()) return data.products;
    const q = search.toLowerCase();
    return data.products.filter(
      p => p.product_name.toLowerCase().includes(q) || p.product_code.toLowerCase().includes(q)
    );
  }, [data?.products, search]);

  const company = data?.company;

  return (
    <div className="space-y-3">
      {/* ─── Compact Header & Date Filter Bar ─── */}
      <div className="bg-white border border-gray-200 rounded-xl px-4 py-2.5 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-base font-bold text-gray-900 tracking-tight leading-none whitespace-nowrap">
            Sales Profitability
          </h1>

          {/* Date Presets */}
          <div className="inline-flex rounded-lg bg-gray-100 p-0.5 text-xs font-medium text-gray-600">
            {[
              { id: 'this_month', label: 'This Month' },
              { id: 'last_month', label: 'Last Month' },
              { id: 'this_quarter', label: 'Quarter' },
              { id: 'this_year', label: 'Year (2026)' },
              { id: 'last_year', label: '2025' },
              { id: 'all_time', label: 'All Time' },
              { id: 'custom', label: 'Custom' },
            ].map(p => (
              <button
                key={p.id}
                onClick={() => handlePresetChange(p.id)}
                className={`px-2.5 py-1 rounded-md transition text-[11px] ${
                  datePreset === p.id ? 'bg-white text-gray-900 shadow-sm font-semibold' : 'hover:text-gray-900'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Date Picker */}
          <div className="flex items-center gap-1.5 text-xs bg-gray-50 border border-gray-200 px-2 py-1 rounded-md">
            <Calendar className="w-3.5 h-3.5 text-gray-400" />
            <input name="start_date" aria-label="Start Date"
              type="date"
              value={startDate}
              onChange={e => {
                setStartDate(e.target.value);
                setDatePreset('custom');
              }}
              className="bg-transparent border-0 p-0 text-xs text-gray-700 w-24 focus:ring-0"
            />
            <span className="text-gray-400 text-[10px]">—</span>
            <input name="end_date" aria-label="End Date"
              type="date"
              value={endDate}
              onChange={e => {
                setEndDate(e.target.value);
                setDatePreset('custom');
              }}
              className="bg-transparent border-0 p-0 text-xs text-gray-700 w-24 focus:ring-0"
            />
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 self-end md:self-auto">
          <button
            onClick={() => setShowExportModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-300 rounded-lg hover:bg-emerald-100 shadow-sm transition"
            title="Export Sales Profitability Report to Excel"
          >
            <Download className="w-3.5 h-3.5 text-emerald-700" />
            Export to Excel
          </button>
          <button
            onClick={loadSummary}
            disabled={loading}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 shadow-sm transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-800 text-xs">
          <p className="font-semibold">Failed to load profitability data</p>
          <p className="mt-0.5">{error}</p>
        </div>
      )}

      {/* ─── Return-Aware Financial Lineage Banner (if returns exist) ─── */}
      {Boolean(company?.sales_returns && company.sales_returns > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900 flex flex-wrap items-center justify-between gap-2 shadow-sm">
          <div className="flex items-center gap-1.5 font-medium">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500"></span>
            <span>Sales Returns Deducted:</span>
            <span className="font-bold text-amber-950">-{formatCurrency(company?.sales_returns || 0)}</span>
            <span className="text-amber-700">from revenue</span>
            {Boolean(company?.return_cogs && company.return_cogs > 0) && (
              <>
                <span className="text-amber-300">|</span>
                <span>Restocked COGS Credit:</span>
                <span className="font-bold text-emerald-800">-{formatCurrency(company?.return_cogs || 0)}</span>
                <span className="text-emerald-700">from product cost</span>
              </>
            )}
          </div>
          <div className="text-[11px] text-amber-800 bg-amber-100/70 px-2 py-0.5 rounded font-mono">
            Net Sales: {formatCurrency(company?.net_sales || (company?.gross_sales || 0) - (company?.sales_returns || 0))} &minus; Net Cost: {formatCurrency(company?.net_product_cost || (company?.product_cost || 0) - (company?.return_cogs || 0))} = GP: {formatCurrency(company?.gross_profit || 0)}
          </div>
        </div>
      )}

      {/* ─── Cancelled Sales Invoices Audit Disclosure Banner ─── */}
      {Boolean(company?.cancelled_invoices && company.cancelled_invoices.count > 0) && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 flex flex-wrap items-center justify-between gap-2 shadow-sm">
          <div className="flex items-center gap-1.5 font-medium">
            <span className="inline-block w-2 h-2 rounded-full bg-slate-400"></span>
            <span>Excluded Cancelled Invoices:</span>
            <span className="font-bold text-slate-900">{company?.cancelled_invoices?.count} invoice(s)</span>
            <span className="text-slate-600">({formatCurrency(company?.cancelled_invoices?.total_amount || 0)})</span>
            <span className="text-slate-500 font-normal">&bull; segregated from active sales revenue, inventory COGS, and profit</span>
          </div>
          <div className="text-[11px] text-slate-600 bg-slate-200/70 px-2 py-0.5 rounded font-mono">
            Qty: {formatNumber(company?.cancelled_invoices?.total_qty || 0, 2)} units
          </div>
        </div>
      )}

      {/* ─── Compact Company Summary KPIs ─── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {/* Gross Sales */}
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 shadow-sm">
          <p className="text-[11px] text-gray-500 font-medium flex items-center justify-between">
            <TooltipHeader title="Gross Sales" tooltip="Total realized sales revenue from finalized sales invoices (ex-PPN)." />
            <span className="text-[10px] text-gray-400">{company?.order_count || 0} inv</span>
          </p>
          <p className="text-sm lg:text-base font-bold text-gray-900 mt-0.5 leading-tight">
            {formatCurrency(company?.gross_sales || 0)}
          </p>
          {Boolean(company?.sales_returns && company.sales_returns > 0) && (
            <p className="text-[10px] text-amber-700 font-medium mt-0.5 truncate" title={`Less Returns: -${formatCurrency(company?.sales_returns || 0)}`}>
              Net: {formatCurrency(company?.net_sales || (company?.gross_sales || 0) - (company?.sales_returns || 0))}
            </p>
          )}
        </div>

        {/* Product Cost */}
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 shadow-sm">
          <p className="text-[11px] text-gray-500 font-medium flex items-center justify-between">
            <TooltipHeader title="Posted COGS (GL 5100)" tooltip="Posted COGS recorded in the sales invoice's GL 5100 journal." />
            <span className="text-[10px] text-gray-400">GL 5100</span>
          </p>
          <p className="text-sm lg:text-base font-bold text-gray-800 mt-0.5 leading-tight">
            {formatCurrency(company?.product_cost || 0)}
          </p>
          {Boolean(company?.return_cogs && company.return_cogs > 0) && (
            <p className="text-[10px] text-emerald-700 font-medium mt-0.5 truncate" title={`Less Return COGS: -${formatCurrency(company?.return_cogs || 0)}`}>
              Net: {formatCurrency(company?.net_product_cost || (company?.product_cost || 0) - (company?.return_cogs || 0))}
            </p>
          )}
        </div>

        {/* Sales Expenses */}
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 shadow-sm">
          <p className="text-[11px] text-gray-500 font-medium flex items-center justify-between">
            <TooltipHeader title="Sales Expenses" tooltip="Attributable sales expenses (delivery, loading, commission/marketing) allocated to Delivery Challans." />
            <span className="text-[10px] text-gray-400 truncate">Delivery/Sales</span>
          </p>
          <p className="text-sm lg:text-base font-bold text-amber-700 mt-0.5 leading-tight">
            {formatCurrency(company?.sales_expenses || 0)}
          </p>
        </div>

        {/* Gross Profit */}
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 shadow-sm">
          <p className="text-[11px] text-gray-500 font-medium flex items-center justify-between">
            <TooltipHeader title="Gross Profit" tooltip="Net Sales (Gross Sales minus Sales Returns) minus Net Product Cost (Product Cost minus Return COGS)." />
            <span className="text-[10px] text-gray-400">{company?.sales_returns && company.sales_returns > 0 ? 'Net GP' : 'Pre-exp'}</span>
          </p>
          <p className={`text-sm lg:text-base font-bold mt-0.5 leading-tight ${(company?.gross_profit || 0) >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
            {formatCurrency(company?.gross_profit || 0)}
          </p>
        </div>

        {/* Profit After Sales Expenses — Highlight KPI */}
        <div className="bg-emerald-50/70 border-2 border-emerald-500 rounded-lg px-3 py-2 shadow-sm">
          <p className="text-[11px] font-semibold text-emerald-900 flex items-center justify-between">
            <TooltipHeader title="Profit After Expenses" tooltip="Primary bottom line: Net Sales minus Net Product Cost minus Attributable Sales Expenses." />
            <span className="text-[10px] text-emerald-700 font-medium">Net</span>
          </p>
          <p className={`text-sm lg:text-base font-extrabold mt-0.5 leading-tight ${(company?.profit_after_sales_expenses || 0) >= 0 ? 'text-emerald-800' : 'text-red-600'}`}>
            {formatCurrency(company?.profit_after_sales_expenses || 0)}
          </p>
        </div>

        {/* Profit Margin % */}
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-[11px] text-gray-500 font-medium">
              <TooltipHeader title="Profit Margin" tooltip="Profit After Sales Expenses divided by Net Sales × 100." />
            </p>
            <p className="text-[10px] text-gray-400 mt-0.5">{formatNumber(company?.total_qty_sold || 0, 0)} units sold</p>
          </div>
          <div>
            <MarginBadge pct={company?.profit_margin_pct ?? null} />
          </div>
        </div>
      </div>

      {/* ─── Main Product Profitability Table ─── */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between gap-3 bg-gray-50/70">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-bold text-gray-800 uppercase tracking-wider">Product Profitability</h2>
            <span className="text-[11px] text-gray-400 font-normal">({filteredProducts.length} items)</span>
          </div>
          <div className="relative w-56">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input name="search" aria-label="Search product..."
              type="text"
              placeholder="Search product..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1 border border-gray-300 rounded-md text-xs focus:ring-1 focus:ring-blue-500 bg-white"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-gray-50 text-gray-600 font-semibold border-b border-gray-200 select-none">
              <tr>
                <th className="px-4 py-3 min-w-[200px]">Product</th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Stock (Cur / Res / Avail)" tooltip="Canonical inventory: Current physical stock, active order reservations, and net available stock." />
                </th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Sold Qty" tooltip="Total quantity sold on finalized invoices in the selected date range." />
                </th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Avg Landed Cost" tooltip="Weighted average product landed cost: SUM(qty × batch cost) / SUM(qty)." />
                </th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Avg Selling Price" tooltip="Weighted average realized selling price: SUM(qty × price) / SUM(qty)." />
                </th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Sales Exp / Unit" tooltip="Allocated sales expense (delivery, loading, commission) per sold unit." />
                </th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Net Realization" tooltip="Avg Selling Price minus Sales Expense per unit." />
                </th>
                <th className="px-3 py-3 text-right">
                  <TooltipHeader title="Profit / Unit" tooltip="Profit after sales expenses per unit: Net Selling Price minus Landed Cost." />
                </th>
                <th className="px-3 py-3 text-right">Margin</th>
                <th className="px-4 py-3 text-right font-bold text-gray-900">Total Profit</th>
                <th className="px-3 py-3 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && !data ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-gray-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-500" />
                    Loading profitability data...
                  </td>
                </tr>
              ) : filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-gray-400">
                    <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    No product sales found for the selected date range.
                  </td>
                </tr>
              ) : (
                filteredProducts.map(p => {
                  const hasFullCostCoverage = p.costed_lines === p.total_lines;
                  const hasPartialCostCoverage = p.costed_lines > 0 && !hasFullCostCoverage;
                  const isPositive = (p.profit_after_sales_expense ?? 0) >= 0;
                  const isExpanded = expandedProductIds.has(p.product_id);
                  const pBatches = batchesCache[p.product_id] || [];
                  const isBatchesLoading = !!loadingBatchesMap[p.product_id];

                  return (
                    <Fragment key={p.product_id}>
                      <tr
                        onClick={() => toggleProductExpand(p.product_id)}
                        className={`hover:bg-blue-50/40 cursor-pointer transition-colors group ${isExpanded ? 'bg-blue-50/25' : ''}`}
                      >
                        <td className="px-4 py-3 font-medium text-gray-900">
                          <div className="flex items-center gap-1.5 font-semibold text-blue-900 group-hover:text-blue-600 transition-colors">
                            {isExpanded ? (
                              <ChevronDown className="w-4 h-4 text-blue-600 shrink-0" />
                            ) : (
                              <ChevronRight className="w-4 h-4 text-gray-400 group-hover:text-blue-600 shrink-0" />
                            )}
                            <span>{p.product_name}</span>
                          </div>
                          <div className="text-[11px] text-gray-400 pl-5">{p.product_code || '—'}</div>
                        </td>
                        <td className="px-3 py-3 text-right font-medium text-gray-700">
                          <div className="font-semibold text-gray-900">
                            {formatNumber(p.current_stock, 0)} {p.product_unit}
                          </div>
                          <div className="text-[11px] text-gray-500 whitespace-nowrap mt-0.5">
                            <span className="text-amber-700 font-medium">Res: {formatNumber(p.reserved_stock || 0, 0)}</span>
                            <span className="mx-1 text-gray-300">|</span>
                            <span className="text-emerald-700 font-medium">Avail: {formatNumber(p.available_stock ?? (p.current_stock - (p.reserved_stock || 0)), 0)}</span>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right font-semibold text-gray-900">
                          {formatNumber(p.sold_qty, 0)} {p.product_unit}
                        </td>
                        <td className="px-3 py-3 text-right text-gray-700">
                          {p.costed_lines === 0 ? (
                            <span className="text-amber-700">Cost unavailable</span>
                          ) : hasPartialCostCoverage ? (
                            <div>
                              <span className="font-medium">{formatCurrency(p.avg_landed_cost)}</span>
                              <div className="text-[10px] text-amber-700 font-normal">
                                Known {formatCurrency(p.product_cost ?? 0)} ({p.costed_lines}/{p.total_lines} lines)
                              </div>
                            </div>
                          ) : (
                            formatCurrency(p.avg_landed_cost)
                          )}
                        </td>
                        <td className="px-3 py-3 text-right text-gray-900 font-medium">
                          {formatCurrency(p.avg_selling_price)}
                        </td>
                        <td className="px-3 py-3 text-right text-amber-700">
                          {p.sales_expense > 0 ? formatCurrency(p.sales_expense_per_unit) : '—'}
                        </td>
                        <td className="px-3 py-3 text-right text-gray-800">
                          {formatCurrency(p.net_selling_price_per_unit)}
                        </td>
                        <td className={`px-3 py-3 text-right font-medium ${isPositive ? 'text-green-700' : 'text-red-600'}`}>
                          {p.profit_per_unit != null ? (
                            <div>
                              <span>{formatCurrency(p.profit_per_unit)}</span>
                              {hasPartialCostCoverage && <div className="text-[10px] text-amber-600 font-normal">(costed vol)</div>}
                            </div>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {p.profit_margin_pct != null ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <MarginBadge pct={p.profit_margin_pct} />
                              {hasPartialCostCoverage && <span className="text-[10px] text-amber-600 font-medium">Partial coverage</span>}
                            </div>
                          ) : (
                            <span className="text-xs text-amber-700 font-medium">Cost unavailable</span>
                          )}
                        </td>
                        <td className={`px-4 py-3 text-right font-bold text-sm ${isPositive ? 'text-green-700' : 'text-red-600'}`}>
                          {p.profit_after_sales_expense != null ? (
                            <div>
                              <span>{formatCurrency(p.profit_after_sales_expense)}</span>
                              {hasPartialCostCoverage && (
                                <div className="text-[10px] text-amber-700 font-normal font-sans">
                                  Known {p.costed_lines}/{p.total_lines} lines
                                </div>
                              )}
                            </div>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-3 text-center">
                          <div className="inline-flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                            <button
                              onClick={() => toggleProductExpand(p.product_id)}
                              className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-800 hover:underline"
                            >
                              {isExpanded ? 'Hide' : 'Batches'}
                              {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                            </button>
                            <button
                              onClick={() => handleOpenProduct(p)}
                              title="Open Pop-up View"
                              className="p-1 rounded text-gray-400 hover:text-blue-700 hover:bg-blue-50 transition"
                            >
                              <Maximize2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* ─── Inline Batches Subtable ─── */}
                      {isExpanded && (
                        <tr className="bg-slate-50/70">
                          <td colSpan={11} className="p-3 sm:p-4 border-b border-gray-200">
                            <div className="bg-white rounded-xl border border-gray-200 shadow-xs overflow-hidden">
                              {/* Subtable Header */}
                              <div className="p-3 bg-gray-50/80 border-b border-gray-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  <Layers className="w-4 h-4 text-blue-600" />
                                  <span className="text-xs font-bold text-gray-900">
                                    Batch Breakdown — {p.product_name}
                                  </span>
                                  <span className="text-[11px] text-gray-500">
                                    ({pBatches.length} {pBatches.length === 1 ? 'batch' : 'batches'})
                                  </span>
                                </div>
                                <button
                                  onClick={() => handleOpenProduct(p)}
                                  className="inline-flex items-center gap-1 self-start sm:self-auto px-2.5 py-1 text-[11px] font-medium text-blue-700 bg-white border border-blue-200 rounded-lg hover:bg-blue-50 shadow-xs transition"
                                >
                                  <Maximize2 className="w-3 h-3" />
                                  Open Pop-up View
                                </button>
                              </div>

                              {/* Subtable Body */}
                              {isBatchesLoading ? (
                                <div className="py-10 text-center text-gray-400 text-xs">
                                  <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2 text-blue-500" />
                                  Loading batch profitability...
                                </div>
                              ) : pBatches.length === 0 ? (
                                <div className="py-8 text-center text-gray-400 text-xs">
                                  No batch sales records found for this product in the selected period.
                                </div>
                              ) : (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs text-left">
                                    <thead className="bg-gray-50 text-gray-600 font-semibold border-b border-gray-200">
                                      <tr>
                                        <th className="px-3 py-2.5">Batch Number</th>
                                        <th className="px-3 py-2.5 text-right">Batch Physical Stock</th>
                                        <th className="px-3 py-2.5 text-right">Sold Qty</th>
                                        <th className="px-3 py-2.5 text-right">Landed Cost/Unit</th>
                                        <th className="px-3 py-2.5 text-right">Avg Sell Price</th>
                                        <th className="px-3 py-2.5 text-right">Sales Exp/Unit</th>
                                        <th className="px-3 py-2.5 text-right">Profit/Unit</th>
                                        <th className="px-3 py-2.5 text-right">Margin</th>
                                        <th className="px-3 py-2.5 text-right font-bold">Total Profit</th>
                                        <th className="px-3 py-2.5 text-center">Orders</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                      {pBatches.map(b => {
                                        const isBatchExpanded = expandedBatchIds.has(b.batch_id);
                                        const bOrders = ordersCache[b.batch_id] || [];
                                        const isOrdersLoading = !!loadingOrdersMap[b.batch_id];

                                        return (
                                          <Fragment key={b.batch_id}>
                                            <tr
                                              onClick={() => toggleBatchExpand(b.batch_id)}
                                              className={`hover:bg-blue-50/40 cursor-pointer transition group ${isBatchExpanded ? 'bg-blue-50/25' : ''}`}
                                            >
                                              <td className="px-3 py-2.5 font-mono font-bold text-blue-900 group-hover:text-blue-600">
                                                <span className="inline-flex items-center gap-1">
                                                  {isBatchExpanded ? (
                                                    <ChevronDown className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                                                  ) : (
                                                    <ChevronRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-600 shrink-0" />
                                                  )}
                                                  {b.batch_number}
                                                </span>
                                                <span className="ml-1.5 text-[10px] font-sans font-normal px-1.5 py-0.2 rounded bg-gray-100 text-gray-600">
                                                  {b.is_imported ? 'Import' : 'Local'}
                                                </span>
                                              </td>
                                              <td className="px-3 py-2.5 text-right font-medium text-gray-700">
                                                {formatNumber(b.current_stock, 0)}
                                              </td>
                                              <td className="px-3 py-2.5 text-right font-semibold text-gray-900">
                                                {formatNumber(b.sold_qty, 0)}
                                              </td>
                                              <td className="px-3 py-2.5 text-right text-gray-700 font-medium">
                                                {b.cost_per_unit == null ? <span className="text-amber-700">Cost unavailable</span> : formatCurrency(b.cost_per_unit)}
                                              </td>
                                              <td className="px-3 py-2.5 text-right text-gray-900">
                                                {formatCurrency(b.avg_selling_price)}
                                              </td>
                                              <td className="px-3 py-2.5 text-right text-amber-700">
                                                {b.sales_expense > 0 ? formatCurrency(b.sales_expense_per_unit) : '—'}
                                              </td>
                                              <td className={`px-3 py-2.5 text-right font-medium ${(b.profit_after_sales_expense ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                                                {b.profit_per_unit == null ? '—' : formatCurrency(b.profit_per_unit)}
                                              </td>
                                              <td className="px-3 py-2.5 text-right">
                                                <MarginBadge pct={b.profit_margin_pct} />
                                              </td>
                                              <td className={`px-3 py-2.5 text-right font-bold ${(b.profit_after_sales_expense ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                                                {b.profit_after_sales_expense == null ? '—' : formatCurrency(b.profit_after_sales_expense)}
                                              </td>
                                              <td className="px-3 py-2.5 text-center">
                                                <span className="text-blue-600 font-medium text-xs group-hover:underline inline-flex items-center gap-0.5">
                                                  {isBatchExpanded ? 'Hide' : 'View'} Orders
                                                </span>
                                              </td>
                                            </tr>

                                            {/* ─── Inner Subtable: Batch Orders & Landed Cost Breakdown ─── */}
                                            {isBatchExpanded && (
                                              <tr className="bg-slate-50/90">
                                                <td colSpan={10} className="p-3 sm:p-4 border-b border-gray-200 space-y-3">
                                                  {/* Cost Breakdown Card */}
                                                  <div className="p-3 bg-white border border-gray-200 rounded-lg space-y-2">
                                                    <h4 className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
                                                      <Info className="w-3.5 h-3.5 text-blue-600" />
                                                      Landed / Product Cost Breakdown — {b.batch_number}
                                                    </h4>
                                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                                                      {b.is_imported ? (
                                                        <>
                                                          <div className="bg-gray-50 p-2 rounded border border-gray-200">
                                                            <span className="text-gray-400 block text-[10px]">Import FOB Price</span>
                                                            <span className="font-semibold text-gray-900">
                                                              {b.cost_breakdown.import_price_usd ? `$${b.cost_breakdown.import_price_usd} (Rp ${formatNumber(b.cost_breakdown.import_price || 0, 0)})` : '—'}
                                                            </span>
                                                          </div>
                                                          <div className="bg-gray-50 p-2 rounded border border-gray-200">
                                                            <span className="text-gray-400 block text-[10px]">Duty Charges</span>
                                                            <span className="font-semibold text-gray-900">
                                                              {b.cost_breakdown.duty_charges ? formatCurrency(b.cost_breakdown.duty_charges) : 'Rp 0'}
                                                            </span>
                                                          </div>
                                                          <div className="bg-gray-50 p-2 rounded border border-gray-200">
                                                            <span className="text-gray-400 block text-[10px]">Freight &amp; Port</span>
                                                            <span className="font-semibold text-gray-900">
                                                              {(b.cost_breakdown.freight_charges || 0) + (b.cost_breakdown.other_charges || 0) > 0
                                                                ? formatCurrency((b.cost_breakdown.freight_charges || 0) + (b.cost_breakdown.other_charges || 0))
                                                                : 'Rp 0'}
                                                            </span>
                                                          </div>
                                                          <div className="bg-blue-50 p-2 rounded border border-blue-200 font-bold">
                                                            <span className="text-blue-700 block text-[10px]">Final Landed Cost/Unit</span>
                                                            <span className="text-blue-950 text-sm">
                                                              {b.cost_per_unit == null ? 'Cost unavailable' : formatCurrency(b.cost_per_unit)}
                                                            </span>
                                                          </div>
                                                        </>
                                                      ) : (
                                                        <>
                                                          <div className="bg-gray-50 p-2 rounded border border-gray-200">
                                                            <span className="text-gray-400 block text-[10px]">Purchase Type</span>
                                                            <span className="font-semibold text-gray-900">Local Purchase</span>
                                                          </div>
                                                          <div className="bg-blue-50 p-2 rounded border border-blue-200 font-bold col-span-2">
                                                            <span className="text-blue-700 block text-[10px]">Actual Local Purchase Cost/Unit</span>
                                                            <span className="text-blue-950 text-sm">
                                                              {b.cost_per_unit == null ? 'Cost unavailable' : formatCurrency(b.cost_per_unit)}
                                                            </span>
                                                          </div>
                                                        </>
                                                      )}
                                                    </div>
                                                  </div>

                                                  {/* Realized Orders Table */}
                                                  <div>
                                                    <div className="flex items-center justify-between mb-1.5">
                                                      <h4 className="text-xs font-bold text-gray-800">
                                                        Realized Customer Orders ({bOrders.length})
                                                      </h4>
                                                      <span className="text-[11px] text-gray-500">
                                                        Sales invoices selling from batch {b.batch_number}
                                                      </span>
                                                    </div>

                                                    {isOrdersLoading ? (
                                                      <div className="py-6 text-center text-gray-400 text-xs">
                                                        <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-1 text-blue-500" />
                                                        Loading customer order lines...
                                                      </div>
                                                    ) : bOrders.length === 0 ? (
                                                      <div className="py-4 text-center text-gray-400 text-xs bg-white rounded border border-gray-200">
                                                        No sales invoice lines found for this batch in the selected period.
                                                      </div>
                                                    ) : (
                                                      <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white shadow-xs">
                                                        <table className="w-full text-xs text-left">
                                                          <thead className="bg-gray-50 text-gray-600 font-semibold border-b border-gray-200">
                                                            <tr>
                                                              <th className="px-3 py-2">Invoice &amp; Date</th>
                                                              <th className="px-3 py-2">Customer</th>
                                                              <th className="px-2 py-2">SO / DC</th>
                                                              <th className="px-2 py-2 text-right">Qty</th>
                                                              <th className="px-2 py-2 text-right">Sell Price</th>
                                                              <th className="px-2 py-2 text-right">Gross Sales</th>
                                                              <th className="px-2 py-2 text-right">Product Cost</th>
                                                              <th className="px-2 py-2 text-right">Sales Exp</th>
                                                              <th className="px-2 py-2 text-right">Net Realization</th>
                                                              <th className="px-3 py-2 text-right font-bold">Profit</th>
                                                            </tr>
                                                          </thead>
                                                          <tbody className="divide-y divide-gray-100">
                                                            {bOrders.map(o => (
                                                              <tr key={o.line_id} className="hover:bg-gray-50/70 transition">
                                                                <td className="px-3 py-2 whitespace-nowrap">
                                                                  <span className="font-mono font-bold text-blue-700 block">{o.invoice_number}</span>
                                                                  <span className="text-[10px] text-gray-400">{o.invoice_date}</span>
                                                                </td>
                                                                <td className="px-3 py-2 font-medium text-gray-800 max-w-[140px] truncate" title={o.customer_name}>
                                                                  {o.customer_name}
                                                                </td>
                                                                <td className="px-2 py-2 text-[11px] text-gray-500 font-mono whitespace-nowrap">
                                                                  <div>{o.so_number || '—'}</div>
                                                                  <div className="text-[10px] text-gray-400">{o.dc_number || '—'}</div>
                                                                </td>
                                                                <td className="px-2 py-2 text-right font-semibold text-gray-900">
                                                                  {formatNumber(o.quantity, 0)}
                                                                </td>
                                                                <td className="px-2 py-2 text-right text-gray-800">
                                                                  {formatCurrency(o.selling_price)}
                                                                </td>
                                                                <td className="px-2 py-2 text-right font-medium text-gray-900">
                                                                  {formatCurrency(o.gross_sales)}
                                                                </td>
                                                                <td className="px-2 py-2 text-right text-gray-600">
                                                                  {o.line_cost == null ? <span className="text-amber-700">Cost unavailable</span> : formatCurrency(o.line_cost)}
                                                                </td>
                                                                <td className="px-2 py-2 text-right text-amber-700">
                                                                  {o.line_sales_expense > 0 ? (
                                                                    <span
                                                                      className="underline decoration-dotted cursor-help"
                                                                      title={o.expenses.map(e => `${e.voucher_number} (${e.category}): ${formatCurrency(e.total_amount)}`).join('\n')}
                                                                    >
                                                                      {formatCurrency(o.line_sales_expense)}
                                                                    </span>
                                                                  ) : (
                                                                    '—'
                                                                  )}
                                                                </td>
                                                                <td className="px-2 py-2 text-right text-gray-800">
                                                                  {formatCurrency(o.net_selling_realization)}
                                                                </td>
                                                                <td className={`px-3 py-2 text-right font-bold ${(o.profit ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                                                                  {o.profit == null ? '—' : formatCurrency(o.profit)}
                                                                  {o.profit_margin_pct != null && (
                                                                    <div className="text-[10px] font-normal text-gray-400">
                                                                      {formatNumber(o.profit_margin_pct, 1)}%
                                                                    </div>
                                                                  )}
                                                                </td>
                                                              </tr>
                                                            ))}
                                                          </tbody>
                                                        </table>
                                                      </div>
                                                    )}
                                                  </div>
                                                </td>
                                              </tr>
                                            )}
                                          </Fragment>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
            {data && data.products.length > 0 && (
              <tfoot className="bg-gray-100/80 font-bold text-gray-900 border-t-2 border-gray-300">
                <tr>
                  <td className="px-4 py-3">TOTAL ({filteredProducts.length} products)</td>
                  <td className="px-3 py-3 text-right">
                    <div>{formatNumber(filteredProducts.reduce((s, p) => s + p.current_stock, 0), 0)}</div>
                    <div className="text-[10px] font-normal text-gray-500 whitespace-nowrap">
                      <span className="text-amber-700">Res: {formatNumber(filteredProducts.reduce((s, p) => s + (p.reserved_stock || 0), 0), 0)}</span>
                      <span className="mx-1 text-gray-300">|</span>
                      <span className="text-emerald-700">Avail: {formatNumber(filteredProducts.reduce((s, p) => s + (p.available_stock ?? p.current_stock), 0), 0)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right">
                    {formatNumber(filteredProducts.reduce((s, p) => s + p.sold_qty, 0), 0)}
                  </td>
                  <td className="px-3 py-3 text-right">—</td>
                  <td className="px-3 py-3 text-right">—</td>
                  <td className="px-3 py-3 text-right text-amber-800">
                    <div>{formatCurrency(filteredProducts.reduce((s, p) => s + p.sales_expense, 0))}</div>
                    {(company?.unallocated_sales_expenses || 0) > 0 && (
                      <div className="text-[10px] font-normal text-gray-500">
                        + {formatCurrency(company?.unallocated_sales_expenses || 0)} unallocated
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">—</td>
                  <td className="px-3 py-3 text-right">—</td>
                  <td className="px-3 py-3 text-right">
                    <MarginBadge pct={company?.profit_margin_pct ?? null} />
                  </td>
                  <td className={`px-4 py-3 text-right text-sm ${(company?.profit_after_sales_expenses || 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                    <div>{formatCurrency(filteredProducts.reduce((s, p) => s + (p.profit_after_sales_expense ?? 0), 0))}</div>
                    {(company?.unallocated_sales_expenses || 0) > 0 && (
                      <div className="text-[10px] font-normal text-gray-500">
                        Net Co: {formatCurrency(company?.profit_after_sales_expenses || 0)}
                      </div>
                    )}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* ─── Monthly Trend Summary ─── */}
      {data?.monthly && data.monthly.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-gray-900 flex items-center gap-1.5">
              <BarChart2 className="w-4 h-4 text-blue-600" />
              Monthly Profitability Rollup
            </h3>
            <span className="text-xs text-gray-400">Click any month to inspect that period</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {data.monthly.map(m => (
              <div
                key={m.month_start}
                onClick={() => {
                  const ym = m.month_start.slice(0, 7);
                  const [y, mon] = ym.split('-').map(Number);
                  const start = new Date(y, mon - 1, 1).toISOString().split('T')[0];
                  const end = new Date(y, mon, 0).toISOString().split('T')[0];
                  setStartDate(start);
                  setEndDate(end);
                  setDatePreset('custom');
                }}
                className="border border-gray-200 hover:border-blue-400 rounded-lg p-3 bg-gray-50/50 hover:bg-blue-50/30 cursor-pointer transition shadow-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-gray-900">{m.month_label}</span>
                  <MarginBadge pct={m.profit_margin_pct} />
                </div>
                <div className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between text-gray-500">
                    <span>Revenue:</span>
                    <span className="font-medium text-gray-800">{formatCurrency(m.gross_sales)}</span>
                  </div>
                  <div className="flex justify-between text-gray-500">
                    <span>Product Cost:</span>
                    <span className="text-gray-700">{formatCurrency(m.product_cost)}</span>
                  </div>
                  <div className="flex justify-between text-gray-500">
                    <span>Sales Expenses:</span>
                    <span className="text-amber-700">{formatCurrency(m.sales_expenses)}</span>
                  </div>
                  <div className="flex justify-between font-bold border-t pt-1">
                    <span>Profit:</span>
                    <span className={m.profit_after_sales_expenses >= 0 ? 'text-green-700' : 'text-red-600'}>
                      {formatCurrency(m.profit_after_sales_expenses)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Product Drilldown Pop-up Modal (Centered, Wide & Responsive) ─── */}
      {selectedProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-gray-900/60 backdrop-blur-xs overflow-y-auto">
          <div className="w-full max-w-6xl bg-white rounded-2xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden border border-gray-200 animate-in fade-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="p-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider">Product Drilldown Pop-up</p>
                <h2 className="text-lg font-bold text-gray-900 mt-0.5">{selectedProduct.product_name}</h2>
                <p className="text-xs text-gray-500">{selectedProduct.product_code || 'No Product Code'}</p>
              </div>
              <button
                onClick={() => setSelectedProduct(null)}
                className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-500 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Product Summary Ribbon */}
            <div className="grid grid-cols-2 sm:grid-cols-8 divide-x divide-gray-200 border-b border-gray-200 bg-white text-xs">
              <div className="p-3 text-center">
                <span className="text-gray-500 block">Current Stock</span>
                <span className="font-bold text-gray-900 text-sm mt-0.5">
                  {formatNumber(selectedProduct.current_stock, 0)} {selectedProduct.product_unit}
                </span>
              </div>
              <div className="p-3 text-center">
                <span className="text-amber-600 block font-medium">Reserved</span>
                <span className="font-bold text-amber-700 text-sm mt-0.5">
                  {formatNumber(selectedProduct.reserved_stock || 0, 0)} {selectedProduct.product_unit}
                </span>
              </div>
              <div className="p-3 text-center">
                <span className="text-emerald-600 block font-medium">Available</span>
                <span className="font-bold text-emerald-700 text-sm mt-0.5">
                  {formatNumber(selectedProduct.available_stock ?? selectedProduct.current_stock, 0)} {selectedProduct.product_unit}
                </span>
              </div>
              <div className="p-3 text-center">
                <span className="text-gray-500 block">Sold Qty</span>
                <span className="font-bold text-gray-900 text-sm mt-0.5">
                  {formatNumber(selectedProduct.sold_qty, 0)} {selectedProduct.product_unit}
                </span>
              </div>
              <div className="p-3 text-center">
                <span className="text-gray-500 block">Avg Landed Cost</span>
                <span className="font-bold text-gray-800 text-sm mt-0.5">
                  {selectedProduct.costed_lines === selectedProduct.total_lines
                    ? formatCurrency(selectedProduct.avg_landed_cost)
                    : selectedProduct.costed_lines > 0
                    ? `${formatCurrency(selectedProduct.avg_landed_cost)} · Partial (${selectedProduct.costed_lines}/${selectedProduct.total_lines})`
                    : 'Cost unavailable'}
                </span>
              </div>
              <div className="p-3 text-center">
                <span className="text-gray-500 block">Avg Selling Price</span>
                <span className="font-bold text-gray-800 text-sm mt-0.5">
                  {formatCurrency(selectedProduct.avg_selling_price)}
                </span>
              </div>
              <div className="p-3 text-center">
                <span className="text-gray-500 block">Sales Expense</span>
                <span className="font-bold text-amber-700 text-sm mt-0.5">
                  {formatCurrency(selectedProduct.sales_expense)}
                </span>
              </div>
              <div className="p-3 text-center bg-blue-50/50">
                <span className="text-blue-900 font-semibold block">Total Profit</span>
                <span className={`font-bold text-sm mt-0.5 ${(selectedProduct.profit_after_sales_expense ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                  {selectedProduct.profit_after_sales_expense != null
                    ? `${formatCurrency(selectedProduct.profit_after_sales_expense)}${selectedProduct.costed_lines < selectedProduct.total_lines ? ' (partial)' : ''}`
                    : '—'}
                </span>
              </div>
            </div>

            {/* Modal Body with Batches and Expandable Orders */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-gray-900">Batch Breakdown</h3>
                  <p className="text-xs text-gray-500">
                    Click any batch row to inspect its landed cost details and realized customer orders below it.
                  </p>
                </div>
                <span className="text-xs font-semibold text-gray-500">
                  {modalProductBatches.length} {modalProductBatches.length === 1 ? 'batch' : 'batches'}
                </span>
              </div>

              {loadingModalBatches ? (
                <div className="py-16 text-center text-gray-400">
                  <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-500" />
                  Loading batches...
                </div>
              ) : modalProductBatches.length === 0 ? (
                <div className="py-12 text-center text-gray-400 text-xs">
                  No batch sales records found for this product in the selected period.
                </div>
              ) : (
                <div className="border border-gray-200 rounded-lg overflow-x-auto shadow-xs">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-gray-50 text-gray-600 font-semibold border-b border-gray-200">
                      <tr>
                        <th className="px-3 py-2.5">Batch Number</th>
                        <th className="px-3 py-2.5 text-right">Batch Physical Stock</th>
                        <th className="px-3 py-2.5 text-right">Sold Qty</th>
                        <th className="px-3 py-2.5 text-right">Landed Cost/Unit</th>
                        <th className="px-3 py-2.5 text-right">Avg Sell Price</th>
                        <th className="px-3 py-2.5 text-right">Sales Exp/Unit</th>
                        <th className="px-3 py-2.5 text-right">Profit/Unit</th>
                        <th className="px-3 py-2.5 text-right">Margin</th>
                        <th className="px-3 py-2.5 text-right font-bold">Total Profit</th>
                        <th className="px-2 py-2.5 text-center">Orders</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {modalProductBatches.map(b => {
                        const isBatchExpanded = modalExpandedBatchId === b.batch_id;
                        const bOrders = ordersCache[b.batch_id] || [];
                        const isOrdersLoading = !!loadingOrdersMap[b.batch_id];

                        return (
                          <Fragment key={b.batch_id}>
                            <tr
                              onClick={() => toggleModalBatchExpand(b.batch_id)}
                              className={`hover:bg-blue-50/50 cursor-pointer transition group ${isBatchExpanded ? 'bg-blue-50/30' : ''}`}
                            >
                              <td className="px-3 py-2.5 font-mono font-bold text-blue-900 group-hover:text-blue-600">
                                <span className="inline-flex items-center gap-1">
                                  {isBatchExpanded ? (
                                    <ChevronDown className="w-3.5 h-3.5 text-blue-600" />
                                  ) : (
                                    <ChevronRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-600" />
                                  )}
                                  {b.batch_number}
                                </span>
                                <span className="ml-1.5 text-[10px] font-sans px-1.5 py-0.2 rounded bg-gray-100 text-gray-600 font-normal">
                                  {b.is_imported ? 'Import' : 'Local'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-right font-medium text-gray-700">
                                {formatNumber(b.current_stock, 0)}
                              </td>
                              <td className="px-3 py-2.5 text-right font-semibold text-gray-900">
                                {formatNumber(b.sold_qty, 0)}
                              </td>
                              <td className="px-3 py-2.5 text-right text-gray-700 font-medium">
                                {b.cost_per_unit == null ? <span className="text-amber-700">Cost unavailable</span> : formatCurrency(b.cost_per_unit)}
                              </td>
                              <td className="px-3 py-2.5 text-right text-gray-900">
                                {formatCurrency(b.avg_selling_price)}
                              </td>
                              <td className="px-3 py-2.5 text-right text-amber-700">
                                {b.sales_expense > 0 ? formatCurrency(b.sales_expense_per_unit) : '—'}
                              </td>
                              <td className={`px-3 py-2.5 text-right font-medium ${(b.profit_after_sales_expense ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                                {b.profit_per_unit == null ? '—' : formatCurrency(b.profit_per_unit)}
                              </td>
                              <td className="px-3 py-2.5 text-right">
                                <MarginBadge pct={b.profit_margin_pct} />
                              </td>
                              <td className={`px-3 py-2.5 text-right font-bold ${(b.profit_after_sales_expense ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                                {b.profit_after_sales_expense == null ? '—' : formatCurrency(b.profit_after_sales_expense)}
                              </td>
                              <td className="px-2 py-2.5 text-center">
                                <span className="text-blue-600 font-medium text-xs group-hover:underline inline-flex items-center gap-0.5">
                                  {isBatchExpanded ? 'Hide' : 'View'} Orders
                                </span>
                              </td>
                            </tr>

                            {/* Modal Inner Batch Orders & Landed Cost Breakdown */}
                            {isBatchExpanded && (
                              <tr className="bg-slate-50/70">
                                <td colSpan={10} className="p-3.5 pl-6 border-b border-gray-200 space-y-3">
                                  {/* Landed / Product Cost Breakdown Banner */}
                                  <div className="p-3 bg-white border border-gray-200 rounded-lg space-y-2">
                                    <h4 className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
                                      <Info className="w-3.5 h-3.5 text-blue-600" />
                                      Landed / Product Cost Breakdown — {b.batch_number}
                                    </h4>
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                                      {b.is_imported ? (
                                        <>
                                          <div className="bg-gray-50 p-2 rounded border border-gray-200">
                                            <span className="text-gray-400 block text-[10px]">Import FOB Price</span>
                                            <span className="font-semibold text-gray-900">
                                              {b.cost_breakdown.import_price_usd ? `$${b.cost_breakdown.import_price_usd} (Rp ${formatNumber(b.cost_breakdown.import_price || 0, 0)})` : '—'}
                                            </span>
                                          </div>
                                          <div className="bg-gray-50 p-2 rounded border border-gray-200">
                                            <span className="text-gray-400 block text-[10px]">Duty Charges</span>
                                            <span className="font-semibold text-gray-900">
                                              {b.cost_breakdown.duty_charges ? formatCurrency(b.cost_breakdown.duty_charges) : 'Rp 0'}
                                            </span>
                                          </div>
                                          <div className="bg-gray-50 p-2 rounded border border-gray-200">
                                            <span className="text-gray-400 block text-[10px]">Freight &amp; Port</span>
                                            <span className="font-semibold text-gray-900">
                                              {(b.cost_breakdown.freight_charges || 0) + (b.cost_breakdown.other_charges || 0) > 0
                                                ? formatCurrency((b.cost_breakdown.freight_charges || 0) + (b.cost_breakdown.other_charges || 0))
                                                : 'Rp 0'}
                                            </span>
                                          </div>
                                          <div className="bg-blue-50 p-2 rounded border border-blue-200 font-bold">
                                            <span className="text-blue-700 block text-[10px]">Final Landed Cost/Unit</span>
                                            <span className="text-blue-950 text-sm">
                                              {b.cost_per_unit == null ? 'Cost unavailable' : formatCurrency(b.cost_per_unit)}
                                            </span>
                                          </div>
                                        </>
                                      ) : (
                                        <>
                                          <div className="bg-gray-50 p-2 rounded border border-gray-200">
                                            <span className="text-gray-400 block text-[10px]">Purchase Type</span>
                                            <span className="font-semibold text-gray-900">Local Purchase</span>
                                          </div>
                                          <div className="bg-blue-50 p-2 rounded border border-blue-200 font-bold col-span-2">
                                            <span className="text-blue-700 block text-[10px]">Actual Local Purchase Cost/Unit</span>
                                            <span className="text-blue-950 text-sm">
                                              {b.cost_per_unit == null ? 'Cost unavailable' : formatCurrency(b.cost_per_unit)}
                                            </span>
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  </div>

                                  {/* Orders Table */}
                                  <div>
                                    <div className="flex items-center justify-between mb-1.5">
                                      <h4 className="text-xs font-bold text-gray-800">
                                        Realized Customer Orders ({bOrders.length})
                                      </h4>
                                      <span className="text-[11px] text-gray-500">
                                        Invoices selling from batch {b.batch_number}
                                      </span>
                                    </div>

                                    {isOrdersLoading ? (
                                      <div className="py-6 text-center text-gray-400 text-xs">
                                        <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-1 text-blue-500" />
                                        Loading customer order lines...
                                      </div>
                                    ) : bOrders.length === 0 ? (
                                      <div className="py-4 text-center text-gray-400 text-xs bg-white rounded border border-gray-200">
                                        No sales invoice lines found for this batch in the selected period.
                                      </div>
                                    ) : (
                                      <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white shadow-xs">
                                        <table className="w-full text-xs text-left">
                                          <thead className="bg-gray-50 text-gray-600 font-semibold border-b border-gray-200">
                                            <tr>
                                              <th className="px-3 py-2">Invoice &amp; Date</th>
                                              <th className="px-3 py-2">Customer</th>
                                              <th className="px-2 py-2">SO / DC</th>
                                              <th className="px-2 py-2 text-right">Qty</th>
                                              <th className="px-2 py-2 text-right">Sell Price</th>
                                              <th className="px-2 py-2 text-right">Gross Sales</th>
                                              <th className="px-2 py-2 text-right">Product Cost</th>
                                              <th className="px-2 py-2 text-right">Sales Exp</th>
                                              <th className="px-2 py-2 text-right">Net Realization</th>
                                              <th className="px-3 py-2 text-right font-bold">Profit</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-gray-100">
                                            {bOrders.map(o => (
                                              <tr key={o.line_id} className="hover:bg-gray-50/70 transition">
                                                <td className="px-3 py-2 whitespace-nowrap">
                                                  <span className="font-mono font-bold text-blue-700 block">{o.invoice_number}</span>
                                                  <span className="text-[10px] text-gray-400">{o.invoice_date}</span>
                                                </td>
                                                <td className="px-3 py-2 font-medium text-gray-800 max-w-[140px] truncate" title={o.customer_name}>
                                                  {o.customer_name}
                                                </td>
                                                <td className="px-2 py-2 text-[11px] text-gray-500 font-mono whitespace-nowrap">
                                                  <div>{o.so_number || '—'}</div>
                                                  <div className="text-[10px] text-gray-400">{o.dc_number || '—'}</div>
                                                </td>
                                                <td className="px-2 py-2 text-right font-semibold text-gray-900">
                                                  {formatNumber(o.quantity, 0)}
                                                </td>
                                                <td className="px-2 py-2 text-right text-gray-800">
                                                  {formatCurrency(o.selling_price)}
                                                </td>
                                                <td className="px-2 py-2 text-right font-medium text-gray-900">
                                                  {formatCurrency(o.gross_sales)}
                                                </td>
                                                <td className="px-2 py-2 text-right text-gray-600">
                                                  {o.line_cost == null ? <span className="text-amber-700">Cost unavailable</span> : formatCurrency(o.line_cost)}
                                                </td>
                                                <td className="px-2 py-2 text-right text-amber-700">
                                                  {o.line_sales_expense > 0 ? (
                                                    <span
                                                      className="underline decoration-dotted cursor-help"
                                                      title={o.expenses.map(e => `${e.voucher_number} (${e.category}): ${formatCurrency(e.total_amount)}`).join('\n')}
                                                    >
                                                      {formatCurrency(o.line_sales_expense)}
                                                    </span>
                                                  ) : (
                                                    '—'
                                                  )}
                                                </td>
                                                <td className="px-2 py-2 text-right text-gray-800">
                                                  {formatCurrency(o.net_selling_realization)}
                                                </td>
                                                <td className={`px-3 py-2 text-right font-bold ${(o.profit ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                                                  {o.profit == null ? '—' : formatCurrency(o.profit)}
                                                  {o.profit_margin_pct != null && (
                                                    <div className="text-[10px] font-normal text-gray-400">
                                                      {formatNumber(o.profit_margin_pct, 1)}%
                                                    </div>
                                                  )}
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Export to Excel Modal */}
      <ExportSalesProfitModal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
        currentStartDate={startDate}
        currentEndDate={endDate}
      />
    </div>
  );
}
