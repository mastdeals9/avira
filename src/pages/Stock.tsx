import { Fragment, useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { StockMovementsModal } from '../components/StockMovementsModal';
import { useLanguage } from '../contexts/LanguageContext';
import { supabase } from '../lib/supabase';
import { Package, AlertTriangle, Search, ChevronDown, ChevronUp, History } from 'lucide-react';
import { useNavigation } from '../contexts/NavigationContext';
import { formatDate } from '../utils/dateFormat';
import { formatUnit } from '../utils/unitDisplay';
import { useErpSyncListener } from '../utils/erpSyncBus';

interface StockSummary {
  product_id: string;
  product_name: string;
  product_code: string;
  unit: string;
  category: string;
  min_stock_level: number | null;
  total_current_stock: number;
  reserved_stock: number;
  shortage_quantity: number;
  available_quantity: number;
  active_batch_count: number;
  expired_batch_count: number;
  nearest_expiry_date: string | null;
}

interface StockBatchDetail {
  id: string;
  batch_number: string;
  make_id: string | null;
  expiry_date: string | null;
  import_quantity: number;
  current_stock: number;
  reserved_stock: number;
  unit: string;
  make_name: string | null;
}

export function Stock() {
  const { t } = useLanguage();
  const { setCurrentPage } = useNavigation();
  const [stockSummary, setStockSummary] = useState<StockSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  const [expandedBatches, setExpandedBatches] = useState<StockBatchDetail[]>([]);
  const [expandedLoading, setExpandedLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [stockMovementsTarget, setStockMovementsTarget] = useState<{
    productId?: string;
    productName: string;
    productCode?: string;
    batchId?: string;
    batchNumber?: string;
    unit?: string;
  } | null>(null);

  const openBatchMovements = (batch: StockBatchDetail, product: StockSummary) => {
    setStockMovementsTarget({
      productId: product.product_id,
      productName: product.product_name,
      productCode: product.product_code,
      batchId: batch.id,
      batchNumber: batch.batch_number,
      unit: batch.unit || product.unit,
    });
  };

  const openProductMovements = (product: StockSummary) => {
    setStockMovementsTarget({
      productId: product.product_id,
      productName: product.product_name,
      productCode: product.product_code,
      unit: product.unit,
    });
  };

  useEffect(() => {
    loadStockSummary();
  }, []);

  useErpSyncListener(
    ['inventory', 'sales_orders', 'delivery_challans', 'material_returns', 'purchases'],
    () => {
      loadStockSummary();
    }
  );

  const loadStockSummary = async () => {
    try {
      const { data, error } = await supabase
        .from('inventory_v1_stock_summary')
        .select('*')
        .order('product_name');

      if (error) throw error;

      const filteredProducts = (data || []).filter(
        p => p.total_current_stock > 0 || p.reserved_stock > 0 || p.shortage_quantity > 0
      );

      setStockSummary(filteredProducts);
    } catch (error) {
      console.error('Error loading stock summary:', error);
    } finally {
      setLoading(false);
    }
  };

  const isExpired = (expiryDate: string | null) => {
    if (!expiryDate) return false;
    return new Date(expiryDate) < new Date();
  };

  const isNearExpiry = (expiryDate: string | null) => {
    if (!expiryDate) return false;
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
    return new Date(expiryDate) <= thirtyDaysFromNow && !isExpired(expiryDate);
  };

  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig?.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const loadProductBatches = async (product: StockSummary) => {
    setExpandedLoading(true);
    try {
      const { data, error } = await supabase
        .from('batches')
        .select('id,batch_number,make_id,expiry_date,import_quantity,current_stock,reserved_stock,products(unit)')
        .eq('product_id', product.product_id)
        .eq('is_active', true)
        .order('expiry_date', { ascending: true, nullsFirst: false });
      if (error) throw error;

      const rows = (data || []) as any[];
      const makeIds = Array.from(new Set(rows.map(batch => batch.make_id).filter(Boolean))) as string[];
      const { data: makes, error: makesError } = makeIds.length
        ? await supabase.from('product_sources').select('id,supplier_name').in('id', makeIds)
        : { data: [], error: null };
      if (makesError) throw makesError;
      const makeNames = new Map((makes || []).map((make: any) => [make.id, make.supplier_name || null]));

      setExpandedBatches(rows.map(batch => ({
        id: batch.id,
        batch_number: batch.batch_number,
        make_id: batch.make_id || null,
        expiry_date: batch.expiry_date || null,
        import_quantity: Number(batch.import_quantity) || 0,
        current_stock: Number(batch.current_stock) || 0,
        reserved_stock: Number(batch.reserved_stock) || 0,
        unit: batch.products?.unit || product.unit,
        make_name: batch.make_id ? makeNames.get(batch.make_id) || null : null,
      })));
    } catch (error) {
      console.error('Error loading product batches:', error);
      setExpandedBatches([]);
    } finally {
      setExpandedLoading(false);
    }
  };

  const toggleProduct = (product: StockSummary) => {
    if (expandedProductId === product.product_id) {
      setExpandedProductId(null);
      setExpandedBatches([]);
      return;
    }
    setExpandedProductId(product.product_id);
    void loadProductBatches(product);
  };

  const filteredData = (() => {
    let result = [...stockSummary];
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(item =>
        item.product_name.toLowerCase().includes(term) ||
        item.product_code?.toLowerCase().includes(term) ||
        item.category?.toLowerCase().includes(term)
      );
    }
    if (sortConfig) {
      result.sort((a, b) => {
        const aVal = (a as any)[sortConfig.key];
        const bVal = (b as any)[sortConfig.key];
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return result;
  })();

  const totalStock = stockSummary.reduce((sum, item) => sum + item.total_current_stock, 0);
  const totalProducts = stockSummary.length;
  const lowStockProducts = stockSummary.filter(item =>
    (item.min_stock_level ?? 0) > 0 && item.total_current_stock < (item.min_stock_level ?? 0)
  ).length;
  const productsWithNearExpiry = stockSummary.filter(item =>
    item.nearest_expiry_date && isNearExpiry(item.nearest_expiry_date)
  ).length;

  const SortIcon = ({ columnKey }: { columnKey: string }) => {
    if (sortConfig?.key !== columnKey) return <ChevronDown className="w-3 h-3 opacity-30 inline ml-0.5" />;
    return sortConfig.direction === 'asc'
      ? <ChevronUp className="w-3 h-3 inline ml-0.5" />
      : <ChevronDown className="w-3 h-3 inline ml-0.5" />;
  };

  return (
    <Layout>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">{t('stock.title')}</h1>
          <button
            onClick={() => setCurrentPage('batches')}
            className="flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition text-sm"
          >
            <Package className="w-4 h-4" />
            {t('stock.viewBatches')}
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs px-3.5 py-2 min-h-[64px] flex flex-col justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('stock.productsInStock')}</span>
            <div className="text-base font-bold text-gray-900 mt-0.5">{totalProducts}</div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs px-3.5 py-2 min-h-[64px] flex flex-col justify-between">
            <span className="text-[11px] font-semibold text-emerald-600 uppercase tracking-wide">{t('stock.totalStock')}</span>
            <div className="text-base font-bold text-emerald-700 mt-0.5">{totalStock.toLocaleString()}</div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs px-3.5 py-2 min-h-[64px] flex flex-col justify-between">
            <span className="text-[11px] font-semibold text-amber-600 uppercase tracking-wide">{t('stock.lowStock')}</span>
            <div className="text-base font-bold text-amber-700 mt-0.5">{lowStockProducts}</div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs px-3.5 py-2 min-h-[64px] flex flex-col justify-between">
            <span className="text-[11px] font-semibold text-red-600 uppercase tracking-wide">{t('stock.nearExpiry')}</span>
            <div className="text-base font-bold text-red-700 mt-0.5">{productsWithNearExpiry}</div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border">
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input name="search_term" aria-label="Search products..."
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search products..."
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
          </div>

          {loading ? (
            <div className="p-6 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
              <p className="mt-2 text-gray-500 text-sm">Loading...</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase cursor-pointer" onClick={() => handleSort('product_name')}>
                      Product <SortIcon columnKey="product_name" />
                    </th>
                    <th className="text-right px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase cursor-pointer" onClick={() => handleSort('total_current_stock')}>
                      Stock <SortIcon columnKey="total_current_stock" />
                    </th>
                    <th className="text-right px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase">Reserved</th>
                    <th className="text-right px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase">Available</th>
                    <th className="text-center px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase">Batches</th>
                    <th className="text-right px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase">Nearest Expiry</th>
                    <th className="text-center px-3 py-1.5 text-[11px] font-medium text-gray-500 uppercase w-24">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredData.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-gray-400 text-sm">
                        <Package className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                        No stock available
                      </td>
                    </tr>
                  ) : (
                    filteredData.map((item) => {
                      const isExpanded = expandedProductId === item.product_id;
                      const makeGroups = isExpanded
                        ? Array.from(expandedBatches.reduce((groups, batch) => {
                            const key = batch.make_id || 'not-recorded';
                            const group = groups.get(key) || { key, name: batch.make_name || 'Not recorded', batches: [] as StockBatchDetail[], stock: 0, reserved: 0 };
                            group.batches.push(batch);
                            group.stock += batch.current_stock;
                            group.reserved += batch.reserved_stock;
                            groups.set(key, group);
                            return groups;
                          }, new Map<string, { key: string; name: string; batches: StockBatchDetail[]; stock: number; reserved: number }>()).values())
                        : [];
                      return (
                      <Fragment key={item.product_id}>
                      <tr
                        onClick={() => toggleProduct(item)}
                        className="cursor-pointer hover:bg-blue-50 transition-colors group"
                        title={isExpanded ? 'Collapse batch details' : 'Expand Make and Batch details'}
                      >
                        <td className="px-3 py-2 text-sm">
                          <span className="inline-flex items-center gap-1.5 font-medium text-gray-900 group-hover:text-blue-700 transition-colors">
                            {isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-blue-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
                            {item.product_name}
                          </span>
                          <span className="text-[10px] text-gray-400 ml-1.5 capitalize">({item.category})</span>
                        </td>
                        <td className={`px-3 py-2 text-sm text-right font-semibold ${(item.total_current_stock ?? 0) === 0 ? 'text-gray-400' : (item.total_current_stock ?? 0) < 500 ? 'text-orange-600' : 'text-green-600'}`}>
                          {(item.total_current_stock ?? 0).toLocaleString()} {formatUnit(item.unit)}
                        </td>
                        <td className="px-3 py-2 text-sm text-right">
                          {(item.reserved_stock ?? 0) === 0 && !(item.shortage_quantity ?? 0) ? (
                            <span className="text-gray-300">-</span>
                          ) : (
                            <div className="flex flex-col items-end gap-0.5">
                              {(item.reserved_stock ?? 0) > 0 && (
                                <span className="text-orange-600">{(item.reserved_stock ?? 0).toLocaleString()} {formatUnit(item.unit)}</span>
                              )}
                              {(item.shortage_quantity ?? 0) > 0 && (
                                <span className="text-red-600 text-xs font-semibold">-{(item.shortage_quantity ?? 0).toLocaleString()} shortage</span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-sm text-right font-semibold text-green-600">
                          {(item.available_quantity ?? 0).toLocaleString()} {formatUnit(item.unit)}
                        </td>
                        <td className="px-3 py-2 text-sm text-center">
                          <span className="text-blue-600 font-medium">{item.active_batch_count}</span>
                          {item.expired_batch_count > 0 && (
                            <span className="text-red-500 ml-0.5 text-xs">({item.expired_batch_count} exp)</span>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-sm text-right ${
                          item.nearest_expiry_date && isExpired(item.nearest_expiry_date) ? 'text-red-700 font-semibold' :
                          item.nearest_expiry_date && isNearExpiry(item.nearest_expiry_date) ? 'text-orange-600 font-semibold' :
                          'text-gray-600'
                        }`}>
                          {item.nearest_expiry_date ? formatDate(item.nearest_expiry_date) : '-'}
                          {item.nearest_expiry_date && isNearExpiry(item.nearest_expiry_date) && (
                            <AlertTriangle className="w-3 h-3 inline ml-0.5" />
                          )}
                        </td>
                        <td className="px-3 py-2 text-sm text-center" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => openProductMovements(item)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded border border-blue-200 transition-colors"
                            title={`View all movements for ${item.product_name}`}
                          >
                            <History className="w-3 h-3" />
                            Movements
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={7} className="bg-gray-50 px-3 py-2">
                            {expandedLoading ? (
                              <div className="py-3 text-center text-xs text-gray-500">Loading Make / Batch details…</div>
                            ) : makeGroups.length === 0 ? (
                              <div className="py-3 text-center text-xs text-gray-500">No active batches recorded for this product.</div>
                            ) : (
                              <div className="overflow-x-auto rounded border border-gray-200 bg-white">
                                <table className="w-full text-xs">
                                  <thead className="bg-gray-100 border-b">
                                    <tr>
                                      <th className="text-left px-3 py-1.5 font-semibold text-gray-500 uppercase">Make</th>
                                      <th className="text-left px-3 py-1.5 font-semibold text-gray-500 uppercase">Batch</th>
                                      <th className="text-left px-3 py-1.5 font-semibold text-gray-500 uppercase">Expiry</th>
                                      <th className="text-right px-3 py-1.5 font-semibold text-gray-500 uppercase">Qty</th>
                                      <th className="text-left px-3 py-1.5 font-semibold text-gray-500 uppercase">UOM</th>
                                      <th className="text-right px-3 py-1.5 font-semibold text-gray-500 uppercase">Stock</th>
                                      <th className="text-right px-3 py-1.5 font-semibold text-gray-500 uppercase">Reserved</th>
                                      <th className="text-right px-3 py-1.5 font-semibold text-gray-500 uppercase">Available</th>
                                      <th className="text-center px-3 py-1.5 font-semibold text-gray-500 uppercase w-24">Action</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-100">
                                    {makeGroups.map(group => (
                                      <Fragment key={group.key}>
                                        {(() => {
                                          const groupAvailable = Math.max(0, Math.min((group.stock ?? 0) - (group.reserved ?? 0), item.available_quantity ?? 0));
                                          return (
                                            <tr className="bg-blue-50/60">
                                              <td className="px-3 py-1.5 font-semibold text-gray-800">{group.name}</td>
                                              <td className="px-3 py-1.5 text-gray-500" colSpan={4}>{group.batches.length} batch{group.batches.length === 1 ? '' : 'es'}</td>
                                              <td className="px-3 py-1.5 text-right font-semibold">{(group.stock ?? 0).toLocaleString()} {formatUnit(item.unit)}</td>
                                              <td className="px-3 py-1.5 text-right">
                                                {(group.reserved ?? 0) > 0 ? (
                                                  `${(group.reserved ?? 0).toLocaleString()} ${formatUnit(item.unit)}`
                                                ) : (item.reserved_stock ?? 0) > 0 ? (
                                                  <span className="text-amber-600 text-xs font-medium">0 (Pool)</span>
                                                ) : (
                                                  <span className="text-gray-300">-</span>
                                                )}
                                              </td>
                                              <td className={`px-3 py-1.5 text-right font-semibold ${groupAvailable <= 0 ? 'text-red-600 font-bold' : 'text-green-700'}`}>
                                                {groupAvailable.toLocaleString()} {formatUnit(item.unit)}
                                              </td>
                                              <td className="px-3 py-1.5"></td>
                                            </tr>
                                          );
                                        })()}
                                        {group.batches.map(batch => {
                                          const batchAvailable = Math.max(0, Math.min((batch.current_stock ?? 0) - (batch.reserved_stock ?? 0), item.available_quantity ?? 0));
                                          return (
                                            <tr
                                              key={batch.id}
                                              onClick={() => openBatchMovements(batch, item)}
                                              className="hover:bg-blue-50/60 cursor-pointer transition-colors group/batchrow"
                                              title="Click to view batch movements"
                                            >
                                              <td className="px-3 py-1.5 pl-6 text-gray-500">↳</td>
                                              <td className="px-3 py-1.5 font-mono text-blue-700 font-medium group-hover/batchrow:underline">
                                                {batch.batch_number || '—'}
                                              </td>
                                              <td className={`px-3 py-1.5 ${batch.expiry_date && isExpired(batch.expiry_date) ? 'text-red-700 font-semibold' : batch.expiry_date && isNearExpiry(batch.expiry_date) ? 'text-orange-600 font-semibold' : 'text-gray-600'}`}>{batch.expiry_date ? formatDate(batch.expiry_date) : '—'}</td>
                                              <td className="px-3 py-1.5 text-right">{(batch.import_quantity ?? 0).toLocaleString()}</td>
                                              <td className="px-3 py-1.5">{formatUnit(batch.unit)}</td>
                                              <td className="px-3 py-1.5 text-right font-semibold">{(batch.current_stock ?? 0).toLocaleString()} {formatUnit(batch.unit)}</td>
                                              <td className="px-3 py-1.5 text-right">
                                                {(batch.reserved_stock ?? 0) > 0 ? (
                                                  `${(batch.reserved_stock ?? 0).toLocaleString()} ${formatUnit(batch.unit)}`
                                                ) : (item.reserved_stock ?? 0) > 0 ? (
                                                  <span className="text-amber-600 text-xs font-medium">0 (Pool)</span>
                                                ) : (
                                                  <span className="text-gray-300">-</span>
                                                )}
                                              </td>
                                              <td className={`px-3 py-1.5 text-right font-semibold ${batchAvailable <= 0 ? 'text-red-600 font-bold' : 'text-green-700'}`}>
                                                {batchAvailable.toLocaleString()} {formatUnit(batch.unit)}
                                              </td>
                                              <td className="px-3 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                                                <button
                                                  type="button"
                                                  onClick={() => openBatchMovements(batch, item)}
                                                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded border border-blue-200 transition-colors"
                                                >
                                                  <History className="w-3 h-3" />
                                                  Movements
                                                </button>
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </Fragment>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    )})
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {stockMovementsTarget && (
        <StockMovementsModal
          isOpen={true}
          onClose={() => setStockMovementsTarget(null)}
          productId={stockMovementsTarget.productId}
          productName={stockMovementsTarget.productName}
          productCode={stockMovementsTarget.productCode}
          batchId={stockMovementsTarget.batchId}
          batchNumber={stockMovementsTarget.batchNumber}
          unit={stockMovementsTarget.unit}
        />
      )}
    </Layout>
  );
}
