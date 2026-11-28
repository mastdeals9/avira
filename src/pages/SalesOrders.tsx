import { useState, useEffect, type ComponentProps } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useFinance } from '../contexts/FinanceContext';
import { Layout } from '../components/Layout';
import { FileText, Plus, Search, Eye, Pencil as Edit, Trash2, XCircle, FileCheck, CheckCircle, Paperclip, Download, AlertTriangle, Clock, ExternalLink, Truck, DollarSign, RefreshCw, Check, ChevronDown } from 'lucide-react';
import { Modal } from '../components/Modal';
import SalesOrderForm from '../components/SalesOrderForm';
import { ProformaInvoiceView } from '../components/ProformaInvoiceView';
import { EditSalesOrderFxRateModal } from '../components/EditSalesOrderFxRateModal';
import { DeliveryChallanView } from '../components/DeliveryChallanView';
import { InvoiceView } from '../components/InvoiceView';
import { loadInvoiceDisplayItems } from '../utils/invoiceItemDisplay';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/dateFormat';
import { fetchLinkedDocumentsBundle, LinkedDocRef } from '../utils/linkedDocuments';
import { LinkedDocsCell } from '../components/LinkedDocsCell';
import { useDebounce } from '../hooks/useDebounce';
import { fetchApprovedDeliverySalesOrderIds, getDeliveryAlertForOrder } from '../utils/salesOrderDeliveryAlerts';
import { resolveStorageUrlCached } from '../utils/signedUrlCache';
import { FloatingField, FLOAT_TEXTAREA } from '../components/finance/FloatingField';
import { SapRow } from '../components/finance/SapLayout';
import { useErpSyncListener, emitErpSync } from '../utils/erpSyncBus';

interface Customer {
  id: string;
  company_name: string;
  address?: string;
  city?: string;
  phone?: string;
  npwp?: string;
  pharmacy_license?: string;
  gst_vat_type?: string;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
  unit: string;
}

interface SalesOrderItem {
  id: string;
  product_id: string;
  make_id?: string | null;
  quantity: number;
  unit_price: number;
  discount_percent: number;
  discount_amount: number;
  tax_percent: number;
  tax_amount: number;
  line_total: number;
  item_delivery_date?: string;
  notes?: string;
  delivered_quantity: number;
  quoted_usd_unit_price?: number | null;
  products?: Product;
  product_sources?: {
    supplier_name: string | null;
    grade: string | null;
  } | null;
}

interface SODeliveryInvoiceStatus {
  so_id: string;
  delivery_status: 'pending' | 'partial' | 'completed';
  invoice_status: 'pending' | 'partial' | 'completed';
  special_status: string | null;
  approved_dc_count: number;
  invoice_count: number;
}

interface SalesOrder {
  id: string;
  so_number: string;
  customer_id: string;
  customer_po_number: string;
  customer_po_date: string;
  customer_po_file_url?: string;
  so_date: string;
  currency: string;
  expected_delivery_date?: string | null;
  notes?: string | null;
  status: string;
  subtotal_amount: number;
  tax_amount: number;
  total_amount: number;
  commercial_usd_to_idr_rate?: number | null;
  created_by: string;
  created_at: string;
  inquiry_id?: string | null;
  approved_by?: string;
  approved_at?: string;
  rejected_by?: string;
  rejected_at?: string;
  rejection_reason?: string;
  customers?: Customer;
  sales_order_items?: SalesOrderItem[];
}
interface LinkedDeliveryChallan { id: string; challan_number: string; challan_date: string; status: string; total_amount: number; }
interface LinkedSalesInvoice { id: string; invoice_number: string; invoice_date: string; payment_status: string; total_amount: number; is_cancelled?: boolean; }
type SortField = 'status' | 'date' | 'so_number' | 'customer' | 'amount';
type SortDirection = 'asc' | 'desc';

export default function SalesOrders() {
  const { profile } = useAuth();
  const { navigationData, clearNavigationData, setNavigationData, setCurrentPage } = useNavigation();
  const { t } = useLanguage();
  const { dateRange } = useFinance();
  const [activeTab, setActiveTab] = useState<'active' | 'archived' | 'fx_backfill'>('active');
  const [expandedOrderIds, setExpandedOrderIds] = useState<Set<string>>(new Set());
  const toggleExpandOrder = (id: string) => {
    setExpandedOrderIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>([]);
  const [filteredOrders, setFilteredOrders] = useState<SalesOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [mobileExpandedKpis, setMobileExpandedKpis] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingOrder, setEditingOrder] = useState<SalesOrder | null>(null);
  const [editingFxRateOrder, setEditingFxRateOrder] = useState<SalesOrder | null>(null);
  const [backfillRates, setBackfillRates] = useState<Record<string, string>>({});
  const [backfillSaving, setBackfillSaving] = useState<Record<string, boolean>>({});
  const [backfillFilter, setBackfillFilter] = useState<'all' | 'missing' | 'set'>('all');
  const [backfillAllDates, setBackfillAllDates] = useState(true);
  const [createPrefill, setCreatePrefill] = useState<ComponentProps<typeof SalesOrderForm>['prefill']>();
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [orderToReject, setOrderToReject] = useState<string | null>(null);
  const [showPOModal, setShowPOModal] = useState(false);
  const [selectedPOUrl, setSelectedPOUrl] = useState<string | null>(null);
  const [poBlobUrl, setPoBlobUrl] = useState<string | null>(null);
  const [poLoading, setPoLoading] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [orderToArchive, setOrderToArchive] = useState<string | null>(null);
  const [showProformaModal, setShowProformaModal] = useState(false);
  const [proformaOrder, setProformaOrder] = useState<SalesOrder | null>(null);
  const [soStatuses, setSoStatuses] = useState<Map<string, SODeliveryInvoiceStatus>>(new Map());
  const [approvedDeliverySoIds, setApprovedDeliverySoIds] = useState<Set<string>>(new Set());
  const [soLinkedChallans, setSoLinkedChallans] = useState<Map<string, LinkedDeliveryChallan[]>>(new Map());
  const [soLinkedInvoices, setSoLinkedInvoices] = useState<Map<string, LinkedSalesInvoice[]>>(new Map());
  const [linkedChallanPreview, setLinkedChallanPreview] = useState<any | null>(null);
  const [linkedChallanItems, setLinkedChallanItems] = useState<any[]>([]);
  const [linkedInvoicePreview, setLinkedInvoicePreview] = useState<any | null>(null);
  const [linkedInvoiceItems, setLinkedInvoiceItems] = useState<any[]>([]);
  const [sortConfig, setSortConfig] = useState<{ field: SortField; direction: SortDirection }>({ field: 'date', direction: 'desc' });
  const debouncedSearchTerm = useDebounce(searchTerm, 250);

  useEffect(() => {
    fetchSalesOrders();
  }, [activeTab, dateRange.startDate, dateRange.endDate, backfillAllDates]);

  useErpSyncListener(
    ['sales_orders', 'inventory', 'delivery_challans', 'sales_invoices'],
    () => {
      fetchSalesOrders();
    }
  );

  useEffect(() => {
    filterOrders();
  }, [debouncedSearchTerm, statusFilter, salesOrders, activeTab, soStatuses, approvedDeliverySoIds, sortConfig, backfillFilter]);

  useEffect(() => {
    const requestedId = navigationData?.salesOrderId;
    if (typeof requestedId !== 'string' || !salesOrders.length) return;
    const requestedOrder = salesOrders.find((order) => order.id === requestedId);
    if (requestedOrder) {
      setProformaOrder(requestedOrder);
      setShowProformaModal(true);
      clearNavigationData();
    }
  }, [navigationData, salesOrders, clearNavigationData]);

  useEffect(() => {
    if (navigationData?.createSalesOrder !== true) return;
    const prefill = navigationData.salesOrderPrefill;
    setEditingOrder(null);
    setCreatePrefill(prefill && typeof prefill === 'object' ? prefill as ComponentProps<typeof SalesOrderForm>['prefill'] : undefined);
    setShowCreateModal(true);
    clearNavigationData();
  }, [navigationData, clearNavigationData]);

  useEffect(() => {
    const editId = navigationData?.editSalesOrderId;
    if (typeof editId !== 'string') return;
    const order = salesOrders.find((o) => o.id === editId);
    if (order) {
      setEditingOrder(order);
      setShowCreateModal(true);
      clearNavigationData();
    } else if (!loading) {
      supabase
        .from('sales_orders')
        .select(`
          *,
          customers(id, company_name),
          sales_order_items(
            *,
            products(product_name, product_code, unit)
          )
        `)
        .eq('id', editId)
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            setEditingOrder(data as any);
            setShowCreateModal(true);
          }
          clearNavigationData();
        });
    }
  }, [navigationData, salesOrders, loading, clearNavigationData]);

  const fetchSOStatuses = async (orderIds: string[]) => {
    if (orderIds.length === 0) return;
    try {
      const { data, error } = await supabase
        .from('so_delivery_invoice_status')
        .select('*')
        .in('so_id', orderIds);
      if (error) throw error;
      const map = new Map<string, SODeliveryInvoiceStatus>();
      (data || []).forEach((row: SODeliveryInvoiceStatus) => map.set(row.so_id, row));
      setSoStatuses(map);
    } catch (err) {
      console.error('Error fetching SO statuses:', err);
    }
  };

  const fetchSalesOrders = async () => {
    try {
      setLoading(true);
      let query = supabase
        .from('sales_orders')
        .select(`
          *,
          customers (
            id,
            company_name,
            address,
            city,
            phone,
            npwp,
            pharmacy_license,
            gst_vat_type
          ),
          sales_order_items (
            id,
            product_id,
            quantity,
            unit_price,
            discount_percent,
            discount_amount,
            tax_percent,
            tax_amount,
            line_total,
            make_id,
            item_delivery_date,
            notes,
            delivered_quantity,
            quoted_usd_unit_price,
            product_sources!sales_order_items_make_id_fkey (
              supplier_name,
              grade
            ),
            products (
              id,
              product_name,
              product_code,
              unit
            )
          )
        `);

      if (activeTab === 'active') {
        query = query.eq('is_archived', false);
      } else if (activeTab === 'archived') {
        query = query.eq('is_archived', true);
      }

      if (activeTab !== 'fx_backfill' || !backfillAllDates) {
        query = query
          .gte('so_date', dateRange.startDate)
          .lte('so_date', dateRange.endDate);
      }

      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) throw error;
      setSalesOrders(data || []);
      const orderIds = (data || []).map((o: SalesOrder) => o.id);
      fetchSOStatuses(orderIds);
      fetchLinkedDocuments(orderIds);
      fetchApprovedDeliverySalesOrderIds(orderIds)
        .then(setApprovedDeliverySoIds)
        .catch((err) => {
          console.error('Error fetching approved delivery links:', err);
          setApprovedDeliverySoIds(new Set());
        });
    } catch (error: any) {
      console.error('Error fetching sales orders:', error.message);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToLoadSalesOrders') });
    } finally {
      setLoading(false);
    }
  };
  const fetchLinkedDocuments = async (orderIds: string[]) => {
    if (orderIds.length === 0) return;
    try {
      const { soMap } = await fetchLinkedDocumentsBundle();
      const dcMap = new Map<string, LinkedDeliveryChallan[]>();
      const invMap = new Map<string, LinkedSalesInvoice[]>();
      orderIds.forEach((id) => {
        const linked = soMap.get(id);
        dcMap.set(id, (linked?.dcs || []).map((dc) => ({ id: dc.id, challan_number: dc.number, challan_date: '', status: '', total_amount: 0 })));
        invMap.set(id, (linked?.invs || []).map((inv) => ({ id: inv.id, invoice_number: inv.number, invoice_date: '', payment_status: '', total_amount: 0, is_cancelled: inv.isCancelled })));
      });
      setSoLinkedChallans(dcMap);
      setSoLinkedInvoices(invMap);
    } catch (err) {
      console.error('Error fetching linked SO docs:', err);
    }
  };


  const openLinkedChallanView = async (challanId: string) => {
    const [{ data: challan }, { data: items }] = await Promise.all([
      supabase.from('delivery_challans').select('*, customers(company_name, address, city, phone, pbf_license)').eq('id', challanId).maybeSingle(),
      supabase.from('delivery_challan_items').select('*, products(id, product_name, product_code, unit, per_pack_weight, pack_type, packaging_type), batches(id, batch_number, expiry_date, packaging_details, per_pack_weight, pack_type, products(id, product_name, product_code, unit, per_pack_weight, pack_type, packaging_type), product_sources!batches_make_id_fkey(supplier_name, grade))').eq('challan_id', challanId)
    ]);
    if (!challan) return;
    setLinkedChallanPreview(challan);
    setLinkedChallanItems(items || []);
  };

  const openLinkedInvoiceView = async (invoiceId: string) => {
    const { data: invoice } = await supabase
      .from('sales_invoices')
      .select('*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)')
      .eq('id', invoiceId)
      .maybeSingle();
    if (!invoice) return;
    const items = await loadInvoiceDisplayItems(supabase, invoice.id);
    setLinkedInvoicePreview(invoice);
    setLinkedInvoiceItems(items || []);
  };

  const formatCurrency = (amount: number, currency: string) => {
    if (currency === 'USD') {
      return `$ ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  type BusinessStatus = 'pending' | 'processing' | 'shortage' | 'delivered' | 'completed' | 'rejected' | 'cancelled';

  const businessStatusConfig: Record<BusinessStatus, { label: string; color: string }> = {
    pending: { label: 'Pending', color: 'bg-gray-100 text-gray-700' },
    processing: { label: 'Processing', color: 'bg-blue-100 text-blue-700' },
    shortage: { label: 'Shortage', color: 'bg-orange-100 text-orange-800' },
    delivered: { label: 'Delivered', color: 'bg-teal-100 text-teal-800' },
    completed: { label: 'Completed', color: 'bg-green-100 text-green-800' },
    rejected: { label: 'Rejected', color: 'bg-red-100 text-red-800' },
    cancelled: { label: 'Cancelled', color: 'bg-red-100 text-red-800' },
  };

  const getBusinessStatus = (order: SalesOrder): BusinessStatus => {
    if (order.status === 'cancelled') return 'cancelled';
    if (order.status === 'rejected') return 'rejected';
    if (order.status === 'shortage') return 'shortage';
    if (order.status === 'closed') return 'completed';
    if (order.status === 'delivered' || order.status === 'partially_delivered') return 'delivered';
    if (order.status === 'draft' || order.status === 'pending_approval') return 'pending';

    const s = soStatuses.get(order.id);
    if (s?.delivery_status === 'completed' && s?.invoice_status === 'completed') return 'completed';
    if (s?.delivery_status === 'completed') return 'delivered';
    if ((s?.approved_dc_count || 0) > 0 || (s?.invoice_count || 0) > 0) return 'processing';

    return 'processing';
  };

  const getOrderStatusBadge = (order: SalesOrder) => {
    const status = getBusinessStatus(order);
    const config = businessStatusConfig[status];
    return (
      <span className={`px-1.5 py-0.5 text-[11px] leading-tight font-semibold rounded-full ${config.color}`}>
        {config.label}
      </span>
    );
  };

  const statusSortRank: Record<BusinessStatus, number> = {
    pending: 1,
    processing: 2,
    shortage: 3,
    delivered: 4,
    completed: 5,
    rejected: 6,
    cancelled: 7,
  };

  const handleSort = (field: SortField) => {
    setSortConfig(current => ({
      field,
      direction: current.field === field && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const sortIndicator = (field: SortField) => (
    sortConfig.field === field ? <span className="ml-1 text-blue-600">{sortConfig.direction === 'asc' ? '^' : 'v'}</span> : null
  );

  const sortableHeader = (field: SortField, label: string, className = 'px-3 py-2 text-left') => (
    <th className={`${className} text-xs font-medium text-gray-500 uppercase`}>
      <button
        type="button"
        onClick={() => handleSort(field)}
        className="inline-flex items-center gap-1 hover:text-gray-800"
      >
        {label}
        {sortIndicator(field)}
      </button>
    </th>
  );

  const filterOrders = () => {
    let filtered = salesOrders;

    if (debouncedSearchTerm) {
      const term = debouncedSearchTerm.toLowerCase().trim();
      filtered = filtered.filter(order =>
        order.so_number?.toLowerCase().includes(term) ||
        order.customer_po_number?.toLowerCase().includes(term) ||
        order.customers?.company_name?.toLowerCase().includes(term) ||
        order.sales_order_items?.some(item =>
          item.products?.product_name?.toLowerCase().includes(term) ||
          item.products?.product_code?.toLowerCase().includes(term)
        )
      );
    }

    if (statusFilter !== 'all') {
      filtered = filtered.filter(order => (
        statusFilter === 'overdue'
          ? getDeliveryAlert(order)?.level === 'overdue'
          : getBusinessStatus(order) === statusFilter
      ));
    }

    if (activeTab === 'fx_backfill') {
      if (backfillFilter === 'missing') {
        filtered = filtered.filter(order => !order.commercial_usd_to_idr_rate || Number(order.commercial_usd_to_idr_rate) <= 0);
      } else if (backfillFilter === 'set') {
        filtered = filtered.filter(order => order.commercial_usd_to_idr_rate && Number(order.commercial_usd_to_idr_rate) > 0);
      }
    }

    filtered = [...filtered].sort((a, b) => {
      let result = 0;
      if (sortConfig.field === 'status') {
        result = statusSortRank[getBusinessStatus(a)] - statusSortRank[getBusinessStatus(b)];
      } else if (sortConfig.field === 'date') {
        result = new Date(a.so_date || '').getTime() - new Date(b.so_date || '').getTime();
      } else if (sortConfig.field === 'so_number') {
        result = (a.so_number || '').localeCompare(b.so_number || '', undefined, { numeric: true, sensitivity: 'base' });
      } else if (sortConfig.field === 'customer') {
        result = (a.customers?.company_name || '').localeCompare(b.customers?.company_name || '', undefined, { sensitivity: 'base' });
      } else if (sortConfig.field === 'amount') {
        result = Number(a.total_amount || 0) - Number(b.total_amount || 0);
      }
      if (result === 0) {
        result = (a.so_number || '').localeCompare(b.so_number || '', undefined, { numeric: true, sensitivity: 'base' });
      }
      return sortConfig.direction === 'asc' ? result : -result;
    });

    setFilteredOrders(filtered);
  };

  const handleSaveBackfillRate = async (order: SalesOrder) => {
    const rawVal = backfillRates[order.id];
    if (!rawVal || !rawVal.trim()) {
      showToast({ type: 'error', title: 'Missing Rate', message: 'Please enter a numeric exchange rate to save' });
      return;
    }
    const num = parseFloat(rawVal.replace(/,/g, ''));
    if (isNaN(num) || num <= 0) {
      showToast({ type: 'error', title: 'Invalid Rate', message: 'Please enter a valid positive exchange rate' });
      return;
    }

    setBackfillSaving((prev) => ({ ...prev, [order.id]: true }));
    try {
      const { data, error } = await supabase.rpc('update_sales_order_commercial_rate', {
        p_so_id: order.id,
        p_new_rate: num,
        p_reason: 'Historical commercial FX rate backfill',
      });

      if (error) throw error;
      if (data && !data.success) {
        throw new Error(data.message || 'Failed to update rate');
      }

      showToast({
        type: 'success',
        title: 'Rate Saved',
        message: `Exchange rate for ${order.so_number} updated to Rp ${num.toLocaleString('id-ID')} / USD`,
      });

      setSalesOrders((prev) =>
        prev.map((o) => (o.id === order.id ? { ...o, commercial_usd_to_idr_rate: num } : o))
      );
      setBackfillRates((prev) => {
        const next = { ...prev };
        delete next[order.id];
        return next;
      });
    } catch (err: any) {
      console.error('Error saving backfill rate:', err);
      showToast({ type: 'error', title: 'Save Failed', message: err.message || 'Could not update exchange rate' });
    } finally {
      setBackfillSaving((prev) => ({ ...prev, [order.id]: false }));
    }
  };

  const getDeliveryAlert = (order: SalesOrder) => {
    const status = soStatuses.get(order.id);
    return getDeliveryAlertForOrder({
      id: order.id,
      so_number: order.so_number,
      expected_delivery_date: order.expected_delivery_date || null,
      status: order.status,
      customers: order.customers || null,
    }, Number(status?.approved_dc_count || 0) > 0 || approvedDeliverySoIds.has(order.id));
  };

  const getDeliveryDueBadge = (order: SalesOrder) => {
    const alert = getDeliveryAlert(order);
    if (!alert) return null;

    if (alert.level === 'overdue') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 mt-1 text-[11px] leading-tight font-medium rounded-full bg-red-100 text-red-700">
          <AlertTriangle className="w-3 h-3" />
          Overdue
        </span>
      );
    }

    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 mt-1 text-[11px] leading-tight font-medium rounded-full bg-yellow-100 text-yellow-700">
        <Clock className="w-3 h-3" />
        Due Soon
      </span>
    );
  };

  const handleSubmitForApproval = async (orderId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: t('salesOrders.submitForApproval') + '?', variant: 'warning' })) return;

    try {
      const { error } = await supabase
        .from('sales_orders')
        .update({ status: 'pending_approval', updated_at: new Date().toISOString() })
        .eq('id', orderId);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: t('success.salesOrderSubmitted') });
      emitErpSync('sales_orders', 'updated', { entityId: orderId });
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error submitting for approval:', error.message);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToUpdate') });
    }
  };

  const handleArchiveOrder = async () => {
    if (!orderToArchive || !archiveReason.trim()) {
      showToast({ type: 'error', title: 'Error', message: t('validation.enterArchiveReason') });
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('sales_orders')
        .update({
          is_archived: true,
          archived_at: new Date().toISOString(),
          archived_by: user.id,
          archive_reason: archiveReason,
          updated_at: new Date().toISOString()
        })
        .eq('id', orderToArchive);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: t('success.salesOrderArchived') });
      setShowArchiveModal(false);
      setArchiveReason('');
      setOrderToArchive(null);
      emitErpSync('sales_orders', 'updated', { entityId: orderToArchive });
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error archiving order:', error.message);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToUpdate') });
    }
  };

  const handleUnarchiveOrder = async (orderId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: t('common.unarchive') + '?', variant: 'warning' })) return;

    try {
      const { error } = await supabase
        .from('sales_orders')
        .update({
          is_archived: false,
          archived_at: null,
          archived_by: null,
          archive_reason: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: t('success.salesOrderUnarchived') });
      emitErpSync('sales_orders', 'updated', { entityId: orderId });
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error unarchiving order:', error.message);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToUpdate') });
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    const reason = prompt('Enter cancellation reason:');
    if (!reason) return;

    try {
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      if (!currentUser) throw new Error('Not authenticated');

      const { error } = await supabase.rpc('fn_cancel_sales_order', {
        p_so_id: orderId,
        p_canceller_id: currentUser.id,
        p_reason: reason
      });

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: t('success.salesOrderCancelled') });
      emitErpSync('sales_orders', 'cancelled', { entityId: orderId });
      emitErpSync('inventory', 'updated');
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error cancelling order:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to cancel order' });
    }
  };

  const handleDeleteOrder = async (orderId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this sales order?', variant: 'danger', confirmLabel: 'Delete' })) return;

    try {
      const { error } = await supabase
        .from('sales_orders')
        .delete()
        .eq('id', orderId);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: 'Sales order deleted successfully!' });
      emitErpSync('sales_orders', 'deleted', { entityId: orderId });
      emitErpSync('inventory', 'updated');
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error deleting order:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to delete order' });
    }
  };

  const handleViewOrder = (order: SalesOrder) => {
    setProformaOrder(order);
    setShowProformaModal(true);
  };

  const handleEditOrder = (order: SalesOrder) => {
    setEditingOrder(order);
    setShowCreateModal(true);
  };

  const handleApproveOrder = async (orderId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Approve this sales order? Stock will be reserved automatically.', variant: 'warning' })) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const targetOrder = salesOrders.find(o => o.id === orderId);
      if (targetOrder && targetOrder.currency === 'IDR' && (targetOrder.commercial_usd_to_idr_rate == null || targetOrder.commercial_usd_to_idr_rate <= 0)) {
        const hasQuotedUsd = targetOrder.sales_order_items?.some(
          (item: any) => item.quoted_usd_unit_price != null && Number(item.quoted_usd_unit_price) > 0
        );
        if (hasQuotedUsd) {
          showToast({
            type: 'error',
            title: 'FX Rate Required',
            message: 'Set the commercial USD→IDR exchange rate before approving this Sales Order.',
          });
          return;
        }
      }

      const { data: reserveResult, error: reserveError } = await supabase
        .rpc('approve_sales_order_product_reservation_v2', {
          p_so_id: orderId,
          p_approved_by: user.id,
        });

      if (reserveError) {
        console.error('Error approving and reserving stock:', reserveError);
        console.error('Supabase request failed', reserveError);
        throw reserveError;
      } else if (reserveResult && reserveResult.length > 0) {
        const result = reserveResult[0];
        if (result.success) {
          showToast({ type: 'success', title: 'Success', message: 'Sales order approved and stock fully reserved!' });
        } else {
          showToast({ type: 'warning', title: 'Warning', message: 'Order approved with stock shortage.\n\n' + result.message + '\n\nImport requirements have been created automatically.' });
        }
      } else {
        showToast({ type: 'success', title: 'Success', message: 'Sales order approved!' });
      }

      emitErpSync('sales_orders', 'approved', { entityId: orderId });
      emitErpSync('inventory', 'updated');
      fetchSalesOrders();

      // Fire email notification (non-blocking — don't fail if it errors)
      supabase.functions.invoke('send-app-notifications', {
        body: { type: 'so_approved', data: { so_id: orderId } }
      }).catch(() => {});

    } catch (error: any) {
      const msg = error?.message || (error instanceof Error ? error.message : 'Unknown error');
      console.error('Error approving order:', msg);
      showToast({ type: 'error', title: 'Error', message: msg || 'Failed to approve order' });
    }
  };

  const handleRecheckShortage = async (orderId: string) => {
    try {
      setLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      const { data: reserveResult, error: reserveError } = await supabase
        .rpc('approve_sales_order_product_reservation_v2', {
          p_so_id: orderId,
          p_approved_by: user?.id || null,
        });

      if (reserveError) {
        showToast({ type: 'error', title: 'Error', message: reserveError.message || 'Failed to re-check stock reservation' });
      } else if (reserveResult && reserveResult.length > 0) {
        const result = reserveResult[0];
        if (result.success) {
          showToast({ type: 'success', title: 'Stock Allocated', message: 'Available stock allocated successfully! Sales order is now reserved.' });
          emitErpSync('sales_orders', 'updated', { entityId: orderId });
          emitErpSync('inventory', 'updated');
        } else {
          showToast({ type: 'warning', title: 'Still in Shortage', message: result.message || 'Insufficient unreserved stock available.' });
        }
      }
      await fetchSalesOrders();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Error', message: err?.message || 'Error reconciling shortage' });
    } finally {
      setLoading(false);
    }
  };

  const handleRejectOrder = async () => {
    if (!orderToReject || !rejectionReason.trim()) {
      showToast({ type: 'error', title: 'Error', message: 'Please enter a rejection reason' });
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('sales_orders')
        .update({
          status: 'rejected',
          rejected_by: user.id,
          rejected_at: new Date().toISOString(),
          rejection_reason: rejectionReason,
          updated_at: new Date().toISOString()
        })
        .eq('id', orderToReject);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: 'Sales order rejected' });
      setShowRejectModal(false);
      setRejectionReason('');
      setOrderToReject(null);
      emitErpSync('sales_orders', 'rejected', { entityId: orderToReject });
      emitErpSync('inventory', 'updated');
      fetchSalesOrders();
    } catch (error: any) {
      console.error('Error rejecting order:', error.message);
      showToast({ type: 'error', title: 'Error', message: 'Failed to reject order' });
    }
  };

  const handleViewPO = async (poUrl: string) => {
    const signedUrl = await resolveStorageUrlCached(poUrl, 3600);
    setSelectedPOUrl(signedUrl);
    setShowPOModal(true);
    setPoLoading(true);
    setPoBlobUrl(null);
    try {
      const res = await fetch(signedUrl);
      if (!res.ok) {
        // Bucket missing or file deleted — show fallback, don't render error JSON
        setPoBlobUrl(null);
        return;
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      setPoBlobUrl(blobUrl);
    } catch {
      setPoBlobUrl(null);
    } finally {
      setPoLoading(false);
    }
  };

  const handleDownloadPO = async (poUrl: string, filename?: string) => {
    try {
      const signedUrl = await resolveStorageUrlCached(poUrl, 3600);
      const res = await fetch(signedUrl);
      if (!res.ok) {
        showToast({ type: 'error', title: 'Download Failed', message: 'File not found. The storage bucket may not be set up yet.' });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Try to get filename from URL, fallback to provided name or generic name
      const urlFilename = poUrl.split('/').pop()?.split('?')[0] || 'customer-po';
      a.download = filename || urlFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      showToast({ type: 'error', title: 'Download Failed', message: 'Could not download the file.' });
    }
  };

  const stats = {
    total: salesOrders.length,
    processing: salesOrders.filter(o => getBusinessStatus(o) === 'processing').length,
    shortage: salesOrders.filter(o => getBusinessStatus(o) === 'shortage').length,
    completed: salesOrders.filter(o => getBusinessStatus(o) === 'completed').length,
    overdue: salesOrders.filter(o => getDeliveryAlert(o)?.level === 'overdue').length,
  };

  const summaryCards: Array<{
    key: BusinessStatus | 'all' | 'overdue';
    label: string;
    value: number;
    valueClass: string;
  }> = [
    { key: 'all', label: t('salesOrders.totalOrders'), value: stats.total, valueClass: 'text-gray-900' },
    { key: 'processing', label: t('salesOrders.processing'), value: stats.processing, valueClass: 'text-blue-600' },
    { key: 'shortage', label: t('salesOrders.shortage'), value: stats.shortage, valueClass: 'text-orange-600' },
    { key: 'completed', label: t('salesOrders.completed'), value: stats.completed, valueClass: 'text-green-600' },
    { key: 'overdue', label: t('salesOrders.overdue'), value: stats.overdue, valueClass: 'text-red-600' },
  ];

  return (
    <Layout>
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2 border-b border-gray-200">
          <div>
            <h1 className="text-lg sm:text-xl font-bold text-gray-900 tracking-tight">{t('salesOrders.title')}</h1>
            <p className="text-xs text-gray-500 mt-0.5">Manage customer purchase orders and track delivery</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('fx_backfill')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold transition shadow-xs text-xs ${
                activeTab === 'fx_backfill'
                  ? 'bg-amber-700 text-white'
                  : 'bg-amber-600 hover:bg-amber-700 text-white'
              }`}
              title="Open Historical Exchange Rate Backfill"
            >
              <DollarSign className="w-3.5 h-3.5" />
              Backfill FX Rates
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-blue-700 shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('salesOrders.createSalesOrder')}
            </button>
          </div>
        </div>

        <div className="border-b border-gray-200">
          <nav className="flex gap-2">
          <button
            onClick={() => setActiveTab('active')}
            className={`px-4 py-2 font-medium border-b-2 transition ${
              activeTab === 'active'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            {t('salesOrders.activeOrders')}
          </button>
          <button
            onClick={() => setActiveTab('archived')}
            className={`px-4 py-2 font-medium border-b-2 transition ${
              activeTab === 'archived'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            {t('salesOrders.archivedOrders')}
          </button>
          <button
            onClick={() => setActiveTab('fx_backfill')}
            className={`px-4 py-2 font-medium border-b-2 transition flex items-center gap-2 ${
              activeTab === 'fx_backfill'
                ? 'border-amber-600 text-amber-700 font-semibold'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            <span>Exchange Rate Backfill</span>
            {salesOrders.some((o) => !o.commercial_usd_to_idr_rate || Number(o.commercial_usd_to_idr_rate) <= 0) && (
              <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-800 border border-amber-300">
                {salesOrders.filter((o) => !o.commercial_usd_to_idr_rate || Number(o.commercial_usd_to_idr_rate) <= 0).length} Missing
              </span>
            )}
          </button>
        </nav>
      </div>

      <div className="space-y-1.5">
        <div className="grid grid-cols-3 md:grid-cols-3 lg:grid-cols-5 gap-2">
          {summaryCards.map((card, idx) => {
            const isActive = statusFilter === card.key;
            const visibleOnMobile = idx < 3 || mobileExpandedKpis;
            return (
              <button
                key={card.key}
                type="button"
                onClick={() => setStatusFilter(card.key)}
                className={`${visibleOnMobile ? 'flex' : 'hidden md:flex'} bg-white px-2.5 sm:px-3 py-2 rounded-xl border border-slate-200 shadow-xs text-left transition hover:border-slate-300 min-h-[60px] flex-col justify-between focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                  isActive ? 'ring-1 ring-blue-500 bg-blue-50/50 border-blue-300' : ''
                }`}
              >
                <div className="text-[10.5px] sm:text-[11px] font-semibold text-gray-500 uppercase tracking-wide truncate">{card.label}</div>
                <div className={`text-sm sm:text-base font-bold ${card.valueClass}`}>{card.value}</div>
              </button>
            );
          })}
        </div>
        {summaryCards.length > 3 && (
          <div className="md:hidden flex justify-end">
            <button
              type="button"
              onClick={() => setMobileExpandedKpis((v) => !v)}
              className="text-[11px] font-semibold text-blue-600 hover:text-blue-800"
            >
              {mobileExpandedKpis ? 'Show fewer metrics' : `Show ${summaryCards.length - 3} more metrics`}
            </button>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg shadow mb-4 sales-transaction-table">
        <div className="p-2 border-b flex flex-col md:flex-row gap-2">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4 pointer-events-none" />
            <input name="search_term" aria-label="Search by SO number, PO number, customer, or product..."
              type="text"
              placeholder="Search by SO number, PO number, customer, or product..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ paddingLeft: '2.5rem' }}
              className="w-full pr-3 py-1.5 text-sm border rounded-lg focus:outline-hidden focus:ring-1 focus:ring-blue-500"
            />
          </div>
          {activeTab === 'fx_backfill' ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Backfill Filter"
                value={backfillFilter}
                onChange={(e) => setBackfillFilter(e.target.value as any)}
                className="border rounded-lg px-3 py-1.5 text-sm bg-white"
              >
                <option value="all">All Orders</option>
                <option value="missing">Missing Rate Only</option>
                <option value="set">Rate Already Set</option>
              </select>
              <label className="flex items-center gap-1.5 text-xs text-gray-700 font-medium px-2 py-1.5 bg-gray-50 border rounded-lg cursor-pointer whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={backfillAllDates}
                  onChange={(e) => setBackfillAllDates(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span>All Historical Dates</span>
              </label>
            </div>
          ) : (
            <select name="status_filter" aria-label="Status Filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border rounded-lg px-3 py-1.5 text-sm"
            >
              <option value="all">All Status</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="shortage">Shortage</option>
              <option value="delivered">Delivered</option>
              <option value="completed">Completed</option>
              <option value="overdue">Overdue</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </select>
          )}
        </div>

        {activeTab === 'fx_backfill' ? (
          <div className="overflow-x-auto">
            <div className="p-3 bg-amber-50 border-b border-amber-200 text-xs text-amber-900">
              <span className="font-semibold text-amber-950">Commercial Exchange Rate Backfill:</span> Enter historical USD → IDR exchange rates used for customer commercial pricing agreements. This field serves as a commercial pricing reference and feeds the FX Business Dashboard; it never modifies issued sales invoices, delivery challans, accounting journals, or inventory COGS.
            </div>
            <table className="w-full min-w-[1200px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">SO Number</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">SO Date</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Customer</th>
                  <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-700 uppercase tracking-wider">Currency</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Current Exchange Rate</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">New Exchange Rate</th>
                  <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-700 uppercase tracking-wider">Status</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Linked DC</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Linked Invoice</th>
                  <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-700 uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {loading ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-gray-500">
                      <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-600" />
                      Loading sales orders...
                    </td>
                  </tr>
                ) : filteredOrders.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-gray-500">
                      No matching sales orders found
                    </td>
                  </tr>
                ) : (
                  filteredOrders.map((order) => {
                    const currentRateNum = order.commercial_usd_to_idr_rate ? Number(order.commercial_usd_to_idr_rate) : null;
                    const dcs = soLinkedChallans.get(order.id) || [];
                    const invs = soLinkedInvoices.get(order.id) || [];
                    const isSaving = !!backfillSaving[order.id];
                    const inputVal = backfillRates[order.id] !== undefined ? backfillRates[order.id] : '';

                    return (
                      <tr key={order.id} className="hover:bg-gray-50">
                        {/* 1. SO Number */}
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => handleViewOrder(order)}
                            className="font-medium text-blue-600 hover:text-blue-800 text-xs font-mono underline"
                            title="View Sales Order Proforma"
                          >
                            {order.so_number}
                          </button>
                        </td>

                        {/* 2. SO Date */}
                        <td className="px-3 py-2.5 whitespace-nowrap text-xs text-gray-600">
                          {formatDate(order.so_date)}
                        </td>

                        {/* 3. Customer */}
                        <td className="px-3 py-2.5 whitespace-nowrap text-xs text-gray-900 font-medium max-w-[200px] truncate" title={order.customers?.company_name}>
                          {order.customers?.company_name || '-'}
                        </td>

                        {/* 4. Currency */}
                        <td className="px-3 py-2.5 whitespace-nowrap text-center">
                          <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${order.currency === 'USD' ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-gray-100 text-gray-700'}`}>
                            {order.currency || 'IDR'}
                          </span>
                        </td>

                        {/* 5. Current Exchange Rate */}
                        <td className="px-3 py-2.5 whitespace-nowrap text-xs">
                          {currentRateNum && currentRateNum > 0 ? (
                            <span className="font-mono font-medium text-gray-800">
                              Rp {currentRateNum.toLocaleString('id-ID', { maximumFractionDigits: 2 })} / USD
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-800 border border-amber-300">
                              Missing
                            </span>
                          )}
                        </td>

                        {/* 6. New Exchange Rate */}
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="relative w-36">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs font-mono">Rp</span>
                            <input
                              type="text"
                              inputMode="decimal"
                              placeholder={currentRateNum ? String(currentRateNum) : "e.g. 17735"}
                              value={inputVal}
                              onChange={(e) => {
                                const val = e.target.value;
                                setBackfillRates((prev) => ({ ...prev, [order.id]: val }));
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  handleSaveBackfillRate(order);
                                }
                              }}
                              className="w-full pl-8 pr-2 py-1 text-xs font-mono border rounded border-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                            />
                          </div>
                        </td>

                        {/* 7. Status */}
                        <td className="px-3 py-2.5 whitespace-nowrap text-center">
                          {getOrderStatusBadge(order)}
                        </td>

                        {/* 8. Linked DC */}
                        <td className="px-3 py-2.5 text-xs">
                          {dcs.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {dcs.map((dc) => (
                                <button
                                  key={dc.id}
                                  type="button"
                                  onClick={() => openLinkedChallanView(dc.id)}
                                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200"
                                  title="View Delivery Challan"
                                >
                                  {dc.challan_number}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <span className="text-gray-400 text-xs">-</span>
                          )}
                        </td>

                        {/* 9. Linked Invoice */}
                        <td className="px-3 py-2.5 text-xs">
                          {invs.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {invs.map((inv) => (
                                <button
                                  key={inv.id}
                                  type="button"
                                  onClick={() => openLinkedInvoiceView(inv.id)}
                                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200"
                                  title="View Sales Invoice"
                                >
                                  {inv.invoice_number}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <span className="text-gray-400 text-xs">-</span>
                          )}
                        </td>

                        {/* 10. Action */}
                        <td className="px-3 py-2.5 whitespace-nowrap text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleSaveBackfillRate(order)}
                              disabled={isSaving || !inputVal.trim()}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded transition shadow-sm ${
                                inputVal.trim()
                                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                              }`}
                              title="Save Exchange Rate"
                            >
                              {isSaving ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Check className="w-3.5 h-3.5" />
                              )}
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => handleViewOrder(order)}
                              className="p-1 text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded"
                              title="Open/View Sales Order"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingFxRateOrder(order)}
                              className="p-1 text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50 rounded"
                              title="Edit Rate (with audit reason)"
                            >
                              <DollarSign className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full min-w-[1200px]">
              <thead className="bg-gray-50">
                <tr>
                  {sortableHeader('so_number', 'SO Number')}
                  {sortableHeader('customer', 'Customer')}
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">PO Number</th>
                  {sortableHeader('date', 'SO Date')}
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Delivery Date</th>
                  {sortableHeader('amount', 'Amount', 'px-4 py-2 text-left')}
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase min-w-[150px]">Linked Docs</th>
                  {sortableHeader('status', 'Order Status', 'px-3 py-2 text-center')}
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-2 text-center text-gray-500">
                      Loading...
                    </td>
                  </tr>
                ) : filteredOrders.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-2 text-center text-gray-500">
                      No sales orders found
                    </td>
                  </tr>
                ) : (
                  filteredOrders.map((order) => (
                    <tr key={order.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{order.so_number}</div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{order.customers?.company_name}</div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <div className="text-sm text-gray-900">{order.customer_po_number}</div>
                          {order.customer_po_file_url && (
                            <>
                              <button
                                onClick={() => handleViewPO(order.customer_po_file_url!)}
                                className="text-blue-600 hover:text-blue-800"
                                title="View uploaded PO"
                                type="button"
                              >
                                <Paperclip className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleDownloadPO(order.customer_po_file_url!, order.customer_po_number || 'customer-po')}
                                className="text-gray-500 hover:text-gray-700"
                                title="Download uploaded PO"
                                type="button"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                        <div className="text-xs text-gray-500">{formatDate(order.customer_po_date)}</div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-500">
                        {formatDate(order.so_date)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-500">
                        <div>{order.expected_delivery_date ? formatDate(order.expected_delivery_date) : '-'}</div>
                        {getDeliveryDueBadge(order)}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs font-medium text-gray-900">{formatCurrency(order.total_amount, order.currency || 'IDR')}</td>
                      <td className="px-3 py-2 min-w-[150px]">
                        <LinkedDocsCell
                          sos={[]}
                          dcs={(soLinkedChallans.get(order.id) || []).map((dc) => ({ id: dc.id, number: dc.challan_number, type: 'dc' as const }))}
                          invs={(soLinkedInvoices.get(order.id) || []).map((inv) => ({ id: inv.id, number: inv.invoice_number, type: 'inv' as const, isCancelled: inv.is_cancelled }))}
                          show={{ so: false }}
                          onClick={(doc: LinkedDocRef) => { if (doc.type === 'dc') openLinkedChallanView(doc.id); if (doc.type === 'inv') openLinkedInvoiceView(doc.id); }}
                        />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="flex flex-col items-center gap-1">
                          {getOrderStatusBadge(order)}
                          {order.status === 'pending_approval' && (
                            <span className="text-[11px] text-yellow-700">Awaiting approval</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm">
                        <div className="flex items-center gap-2">
                          {order.status === 'pending_approval' && profile?.role === 'admin' && (
                            <>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleApproveOrder(order.id);
                                }}
                                className="inline-flex items-center gap-1 px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700"
                                title="Approve Sales Order"
                              >
                                <CheckCircle className="w-3.5 h-3.5" />
                                Approve
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOrderToReject(order.id);
                                  setShowRejectModal(true);
                                }}
                                className="inline-flex items-center gap-1 px-2 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700"
                                title="Reject Sales Order"
                              >
                                <XCircle className="w-3.5 h-3.5" />
                                Reject
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => handleViewOrder(order)}
                            className="text-blue-600 hover:text-blue-800"
                            title="View Sales Order"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setEditingFxRateOrder(order)}
                            className="text-emerald-600 hover:text-emerald-800 p-0.5 hover:bg-emerald-50 rounded"
                            title="Edit Commercial FX Rate"
                          >
                            <DollarSign className="w-4 h-4" />
                          </button>
                          {order.status === 'shortage' && (
                            <button
                              onClick={() => handleRecheckShortage(order.id)}
                              className="text-amber-600 hover:text-amber-800 p-0.5 hover:bg-amber-50 rounded"
                              title="Re-check Stock & Allocate Available"
                            >
                              <RefreshCw className="w-4 h-4" />
                            </button>
                          )}
                          {((profile?.role === 'admin' && !['closed', 'cancelled'].includes(order.status)) ||
                            (!['delivered', 'closed', 'cancelled', 'partially_delivered', 'pending_delivery', 'approved', 'stock_reserved', 'shortage'].includes(order.status))) && (
                            <button
                              onClick={() => handleEditOrder(order)}
                              className="text-indigo-600 hover:text-indigo-800"
                              title={profile?.role === 'admin' ? 'Edit (Admin)' : 'Edit'}
                            >
                              <Edit className="w-4 h-4" />
                            </button>
                          )}
                          {order.status === 'draft' && (
                            <>
                              <button
                                onClick={() => handleSubmitForApproval(order.id)}
                                className="text-green-600 hover:text-green-800"
                                title="Submit for Approval"
                              >
                                <FileCheck className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDeleteOrder(order.id)}
                                className="text-red-600 hover:text-red-800"
                                title="Delete"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          )}
                          {!['cancelled', 'closed', 'delivered', 'rejected'].includes(order.status) &&
                            activeTab === 'active' &&
                            (!['approved', 'stock_reserved', 'shortage', 'pending_delivery'].includes(order.status) || profile?.role === 'admin') && (
                            <button
                              onClick={() => handleCancelOrder(order.id)}
                              className="text-orange-600 hover:text-orange-800"
                              title="Cancel"
                            >
                              <XCircle className="w-4 h-4" />
                            </button>
                          )}
                          {['approved', 'stock_reserved', 'pending_delivery', 'partially_delivered'].includes(order.status)
                            && !approvedDeliverySoIds.has(order.id) && (
                            <button
                              onClick={() => {
                                setNavigationData({ createDeliveryChallanFromSO: order.id });
                                setCurrentPage('delivery-challan');
                              }}
                              className="text-green-600 hover:text-green-800"
                              title="Create Delivery Challan"
                            >
                              <Truck className="w-4 h-4" />
                            </button>
                          )}
                          {activeTab === 'active' && ['admin', 'sales'].includes(profile?.role || '') && ['delivered', 'cancelled'].includes(order.status) && (
                            <button
                              onClick={() => {
                                setOrderToArchive(order.id);
                                setShowArchiveModal(true);
                              }}
                              className="text-gray-600 hover:text-gray-800"
                              title="Archive Order"
                            >
                              <FileText className="w-4 h-4" />
                            </button>
                          )}
                          {activeTab === 'archived' && ['admin', 'sales'].includes(profile?.role || '') && (
                            <button
                              onClick={() => handleUnarchiveOrder(order.id)}
                              className="text-green-600 hover:text-green-800"
                              title="Unarchive Order"
                            >
                              <FileCheck className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>

            {/* Mobile Card View (< 768px) - High Density 3-Line Format */}
            <div className="block md:hidden p-2 space-y-1.5">
              {loading ? (
                <div className="py-8 text-center text-xs text-gray-500">Loading...</div>
              ) : filteredOrders.length === 0 ? (
                <div className="py-8 text-center text-xs text-gray-500">No sales orders found</div>
              ) : (
                filteredOrders.map((order) => {
                  const isExpanded = expandedOrderIds.has(order.id);

                  return (
                    <div
                      key={order.id}
                      onClick={() => toggleExpandOrder(order.id)}
                      className="bg-white rounded-xl border border-slate-200/90 p-2.5 space-y-1 shadow-2xs hover:border-slate-300 transition active:scale-[0.99] cursor-pointer"
                    >
                      {/* Line 1: SO Number + Status Badge + Actions */}
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <span className="font-mono font-bold text-xs text-gray-900 truncate">
                            {order.so_number}
                          </span>
                          <div className="shrink-0 scale-90 origin-left">
                            {getOrderStatusBadge(order)}
                          </div>
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => handleViewOrder(order)}
                            className="p-1 text-slate-500 hover:text-slate-800 rounded active:bg-slate-100"
                            title="View Order"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          {((profile?.role === 'admin' && !['closed', 'cancelled'].includes(order.status)) ||
                            (!['delivered', 'closed', 'cancelled', 'partially_delivered', 'pending_delivery', 'approved', 'stock_reserved', 'shortage'].includes(order.status))) && (
                            <button
                              onClick={() => handleEditOrder(order)}
                              className="p-1 text-blue-600 hover:text-blue-800 rounded active:bg-blue-50"
                              title="Edit"
                            >
                              <Edit className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => toggleExpandOrder(order.id)}
                            className="p-1 text-slate-400 hover:text-slate-600 rounded active:bg-slate-100"
                            title={isExpanded ? 'Collapse' : 'Expand'}
                          >
                            <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                          </button>
                        </div>
                      </div>

                      {/* Line 2: Customer Name + SO Date */}
                      <div className="flex items-center justify-between text-xs text-gray-600 gap-2">
                        <span className="font-medium text-gray-800 truncate min-w-0 flex-1">
                          {order.customers?.company_name || '—'}
                        </span>
                        <span className="text-[11px] text-gray-400 font-normal shrink-0">
                          {formatDate(order.so_date)}
                        </span>
                      </div>

                      {/* Line 3: Total Amount + PO/Delivery Due */}
                      <div className="flex items-center justify-between pt-1 border-t border-slate-100 text-xs gap-2">
                        <span className="font-mono font-bold text-xs text-gray-900 truncate">
                          {formatCurrency(order.total_amount, order.currency || 'IDR')}
                        </span>
                        <span className="text-[11px] text-gray-500 truncate text-right">
                          {order.customer_po_number ? `PO: ${order.customer_po_number}` : (order.expected_delivery_date ? `Due: ${formatDate(order.expected_delivery_date)}` : '')}
                        </span>
                      </div>

                      {/* Expandable Drawer: Linked Documents, Rates, Actions */}
                      {isExpanded && (
                        <div
                          className="mt-2 pt-2 border-t border-dashed border-slate-200 bg-slate-50/70 p-2 rounded-lg text-xs space-y-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div>
                            <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wider block mb-1">Linked Documents</span>
                            <LinkedDocsCell
                              sos={[]}
                              dcs={(soLinkedChallans.get(order.id) || []).map((dc) => ({ id: dc.id, number: dc.challan_number, type: 'dc' as const }))}
                              invs={(soLinkedInvoices.get(order.id) || []).map((inv) => ({ id: inv.id, number: inv.invoice_number, type: 'inv' as const, isCancelled: inv.is_cancelled }))}
                              show={{ so: false }}
                              onClick={(doc: LinkedDocRef) => { if (doc.type === 'dc') openLinkedChallanView(doc.id); if (doc.type === 'inv') openLinkedInvoiceView(doc.id); }}
                            />
                          </div>

                          <div className="flex items-center gap-1.5 pt-1.5 border-t border-slate-200/80">
                            <button
                              onClick={() => setEditingFxRateOrder(order)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-emerald-700 bg-emerald-50 hover:bg-emerald-100 text-xs font-semibold"
                            >
                              <DollarSign className="w-3.5 h-3.5" />
                              <span>FX Rate</span>
                            </button>
                            {['approved', 'stock_reserved', 'pending_delivery', 'partially_delivered'].includes(order.status)
                              && !approvedDeliverySoIds.has(order.id) && (
                              <button
                                onClick={() => {
                                  setNavigationData({ createDeliveryChallanFromSO: order.id });
                                  setCurrentPage('delivery-challan');
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-green-600 text-white text-xs font-semibold hover:bg-green-700"
                              >
                                <Truck className="w-3.5 h-3.5" />
                                <span>Create DC</span>
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>

      {showCreateModal && (
        <Modal
          isOpen={showCreateModal}
          onClose={() => {
            setShowCreateModal(false);
            setEditingOrder(null);
          }}
          title={editingOrder ? "Edit Sales Order" : "Create Sales Order"}
          maxWidth="max-w-[90vw]"
        >
          <SalesOrderForm
            existingOrder={(editingOrder as any) || undefined}
            prefill={!editingOrder ? createPrefill : undefined}
            onSuccess={() => {
              setShowCreateModal(false);
              setEditingOrder(null);
              setCreatePrefill(undefined);
              emitErpSync('sales_orders', editingOrder ? 'updated' : 'created');
              fetchSalesOrders();
            }}
            onCancel={() => {
              setShowCreateModal(false);
              setEditingOrder(null);
              setCreatePrefill(undefined);
            }}
          />
        </Modal>
      )}

      {showRejectModal && (
        <Modal
          isOpen={showRejectModal}
          onClose={() => {
            setShowRejectModal(false);
            setRejectionReason('');
            setOrderToReject(null);
          }}
          title="Reject Sales Order"
        >
          <div className="space-y-4">
            <SapRow>
              <FloatingField label="Rejection Reason" required span={12} textarea filled={!!rejectionReason}>
                <textarea name="rejection_reason" aria-label="Enter reason for rejecting this sales order..."
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  rows={4}
                  className={FLOAT_TEXTAREA}
                  placeholder="Enter reason for rejecting this sales order..."
                />
              </FloatingField>
            </SapRow>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowRejectModal(false);
                  setRejectionReason('');
                  setOrderToReject(null);
                }}
                className="px-4 py-2 border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRejectOrder}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                disabled={!rejectionReason.trim()}
              >
                Reject Order
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showArchiveModal && (
        <Modal
          isOpen={showArchiveModal}
          onClose={() => {
            setShowArchiveModal(false);
            setArchiveReason('');
            setOrderToArchive(null);
          }}
          title="Archive Sales Order"
        >
          <div className="space-y-4">
            <SapRow>
              <FloatingField label="Archive Reason" required span={12} textarea filled={!!archiveReason}>
                <textarea name="archive_reason" aria-label="Enter reason for archiving this sales order (e.g., Completed and delivered, Cancelled by customer)..."
                  value={archiveReason}
                  onChange={(e) => setArchiveReason(e.target.value)}
                  rows={4}
                  className={FLOAT_TEXTAREA}
                  placeholder="Enter reason for archiving this sales order (e.g., Completed and delivered, Cancelled by customer)..."
                />
              </FloatingField>
            </SapRow>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowArchiveModal(false);
                  setArchiveReason('');
                  setOrderToArchive(null);
                }}
                className="px-4 py-2 border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleArchiveOrder}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                disabled={!archiveReason.trim()}
              >
                Archive Order
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showPOModal && selectedPOUrl && (
        <Modal
          isOpen={showPOModal}
          onClose={() => {
            setShowPOModal(false);
            setSelectedPOUrl(null);
            if (poBlobUrl) { URL.revokeObjectURL(poBlobUrl); setPoBlobUrl(null); }
          }}
          title="Customer Purchase Order"
          size="xl"
        >
          <div className="flex flex-col gap-2" style={{ height: '75vh' }}>
            {/* Action bar — always visible */}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => handleDownloadPO(selectedPOUrl!)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-green-700 border border-green-200 rounded-lg hover:bg-green-50 transition"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </button>
              <a
                href={selectedPOUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open in new tab
              </a>
            </div>

            {poLoading && (
              <div className="flex-1 flex items-center justify-center bg-gray-50 rounded-lg border border-gray-200">
                <div className="text-center text-gray-500">
                  <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-sm">Loading document...</p>
                </div>
              </div>
            )}
            {!poLoading && poBlobUrl && (
              <iframe
                src={poBlobUrl}
                className="flex-1 w-full rounded-lg border border-gray-200"
                title="Customer Purchase Order"
              />
            )}
            {!poLoading && !poBlobUrl && (
              <div className="flex-1 flex items-center justify-center bg-gray-50 rounded-lg border border-gray-200">
                <div className="text-center text-gray-500 px-6">
                  <FileText className="w-10 h-10 mx-auto mb-3 text-gray-400" />
                  <p className="text-sm font-medium mb-2">Document cannot be previewed</p>
                  <p className="text-xs text-gray-400 mb-1">This usually means the storage bucket is not set up in Supabase.</p>
                  <p className="text-xs text-gray-400 mb-5">Please run the storage setup migration, then re-upload the file.</p>
                  <div className="flex justify-center gap-3">
                    <button
                      onClick={() => handleDownloadPO(selectedPOUrl!)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition"
                    >
                      <Download className="w-4 h-4" />
                      Try Download
                    </button>
                    <a
                      href={selectedPOUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Open in new tab
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {showProformaModal && proformaOrder && (
        <ProformaInvoiceView
          salesOrder={proformaOrder as any}
          items={(proformaOrder.sales_order_items || []) as any}
          onClose={() => {
            setShowProformaModal(false);
            setProformaOrder(null);
          }}
          companyProfile={(proformaOrder as any).company_snapshot ?? undefined}
          linkedDcs={(soLinkedChallans.get(proformaOrder.id) || []).map((dc) => ({ id: dc.id, number: dc.challan_number }))}
          linkedInvoices={(soLinkedInvoices.get(proformaOrder.id) || []).map((inv) => ({ id: inv.id, number: inv.invoice_number }))}
          onRateUpdated={(newRate: number | null) => {
            setSalesOrders((prev) =>
              prev.map((o) => (o.id === proformaOrder.id ? { ...o, commercial_usd_to_idr_rate: newRate } : o))
            );
            setProformaOrder((prev) => (prev ? { ...prev, commercial_usd_to_idr_rate: newRate } : null));
          }}
        />
      )}

      {editingFxRateOrder && (
        <EditSalesOrderFxRateModal
          isOpen={!!editingFxRateOrder}
          onClose={() => setEditingFxRateOrder(null)}
          salesOrder={editingFxRateOrder}
          onSuccess={(soId: string, newRate: number | null) => {
            setSalesOrders((prev) =>
              prev.map((o) => (o.id === soId ? { ...o, commercial_usd_to_idr_rate: newRate } : o))
            );
            if (proformaOrder?.id === soId) {
              setProformaOrder((prev) => (prev ? { ...prev, commercial_usd_to_idr_rate: newRate } : null));
            }
          }}
        />
      )}
      {linkedChallanPreview && (
        <DeliveryChallanView
          challan={linkedChallanPreview}
          items={linkedChallanItems}
          onClose={() => {
            setLinkedChallanPreview(null);
            setLinkedChallanItems([]);
          }}
          companyProfile={(linkedChallanPreview as any).company_snapshot ?? undefined}
        />
      )}

      {linkedInvoicePreview && (
        <InvoiceView
          invoice={linkedInvoicePreview}
          items={linkedInvoiceItems}
          onClose={() => {
            setLinkedInvoicePreview(null);
            setLinkedInvoiceItems([]);
          }}
        />
      )}

      </div>
    </Layout>
  );
}
