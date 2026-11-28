import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useFinance } from '../contexts/FinanceContext';
import { Layout } from '../components/Layout';
import { FileText, Plus, Search, CheckCircle, XCircle, Download, Package, Trash2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import { PurchaseOrderView } from '../components/PurchaseOrderView';
import { SearchableSelect } from '../components/SearchableSelect';
import { MoneyInput } from '../components/MoneyInput';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/dateFormat';
import { useNavigation } from '../contexts/NavigationContext';
import { FinanceActionButton } from '../components/finance/FinanceUI';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../components/finance/FloatingField';
import { SapRow } from '../components/finance/SapLayout';
import { useErpSyncListener, emitErpSync } from '../utils/erpSyncBus';

interface Supplier {
  id: string;
  company_name: string;
  contact_person?: string;
  email?: string;
  phone?: string;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
  unit: string;
}

interface ProductSource {
  id: string;
  product_id: string;
  supplier_name: string | null;
  grade: string | null;
}

interface POItem {
  id?: string;
  line_number: number;
  product_id: string;
  make_id?: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  discount_percent: number;
  discount_amount: number;
  line_total: number;
  quantity_received: number;
  quantity_pending: number;
  coa_code?: string;
  specification?: string;
  notes?: string;
  products?: Product;
  product_sources?: Pick<ProductSource, 'supplier_name' | 'grade'> | null;
}

interface PurchaseOrder {
  id: string;
  po_number: string;
  po_date: string;
  supplier_id: string;
  expected_delivery_date?: string;
  delivery_address?: string;
  currency: string;
  exchange_rate: number;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  freight_amount: number;
  total_amount: number;
  status: string;
  payment_terms?: string;
  notes?: string;
  terms_conditions?: string;
  approved_by?: string;
  approved_at?: string;
  created_by: string;
  created_at: string;
  suppliers?: Supplier;
  purchase_order_items?: POItem[];
}

export default function PurchaseOrders() {
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const { dateRange } = useFinance();
  const { setCurrentPage, setNavigationData } = useNavigation();
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [filteredPOs, setFilteredPOs] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productSources, setProductSources] = useState<ProductSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showViewModal, setShowViewModal] = useState(false);
  const [selectedPO, setSelectedPO] = useState<PurchaseOrder | null>(null);
  const [editingPO, setEditingPO] = useState<PurchaseOrder | null>(null);
  const [expandedMobilePoId, setExpandedMobilePoId] = useState<string | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    supplier_id: '',
    po_date: new Date().toISOString().split('T')[0],
    expected_delivery_date: '',
    delivery_address: '',
    currency: 'IDR',
    exchange_rate: 1,
    payment_terms: 'Net 30',
    notes: '',
    terms_conditions: '',
  });
  const [poItems, setPOItems] = useState<POItem[]>([
    {
      line_number: 1,
      product_id: '',
      make_id: null,
      description: '',
      quantity: 0,
      unit: '',
      unit_price: 0,
      discount_percent: 0,
      discount_amount: 0,
      line_total: 0,
      quantity_received: 0,
      quantity_pending: 0,
      coa_code: '',
      specification: '',
    },
  ]);

  useEffect(() => {
    fetchPurchaseOrders();
    fetchSuppliers();
    fetchProducts();
    fetchProductSources();
  }, [dateRange.startDate, dateRange.endDate]);

  useErpSyncListener(
    ['purchases', 'inventory'],
    () => {
      fetchPurchaseOrders();
    }
  );

  useEffect(() => {
    filterPOs();
  }, [searchTerm, statusFilter, purchaseOrders]);

  const fetchPurchaseOrders = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('purchase_orders')
        .select(`
          *,
          suppliers (
            id,
            company_name,
            contact_person,
            email,
            phone,
            address
          ),
          purchase_order_items (
            *,
            products (
              id,
              product_name,
              product_code,
              unit
            ),
            product_sources!purchase_order_items_make_id_fkey (
              supplier_name,
              grade
            )
          )
        `)
        .gte('po_date', dateRange.startDate)
        .lte('po_date', dateRange.endDate)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setPurchaseOrders(data || []);
    } catch (error: any) {
      console.error('Error fetching purchase orders:', error.message);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToLoadPurchaseOrders') });
    } finally {
      setLoading(false);
    }
  };

  const fetchPurchaseOrderById = async (id: string): Promise<PurchaseOrder> => {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select(`*, suppliers (id, company_name, contact_person, email, phone, address), purchase_order_items (*, products (id, product_name, product_code, unit), product_sources!purchase_order_items_make_id_fkey (supplier_name, grade))`)
      .eq('id', id)
      .single();
    if (error) throw error;
    return data as PurchaseOrder;
  };

  const fetchSuppliers = async () => {
    try {
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, company_name, contact_person, email, phone')
        .eq('is_active', true)
        .order('company_name');

      if (error) throw error;
      setSuppliers(data || []);
    } catch (error: any) {
      console.error('Error fetching suppliers:', error.message);
    }
  };

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('id, product_name, product_code, unit')
        .eq('is_active', true)
        .order('product_name');

      if (error) throw error;
      setProducts(data || []);
    } catch (error: any) {
      console.error('Error fetching products:', error.message);
    }
  };

  const fetchProductSources = async () => {
    try {
      const { data, error } = await supabase
        .from('product_sources')
        .select('id, product_id, supplier_name, grade')
        .order('supplier_name');

      if (error) throw error;
      setProductSources(data || []);
    } catch (error: any) {
      console.error('Error fetching product sources:', error.message);
    }
  };

  const filterPOs = () => {
    let filtered = purchaseOrders;

    if (searchTerm) {
      filtered = filtered.filter(po =>
        po.po_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
        po.suppliers?.company_name.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    if (statusFilter !== 'all') {
      filtered = filtered.filter(po => po.status === statusFilter);
    }

    setFilteredPOs(filtered);
  };

  const getStatusBadge = (status: string) => {
    const statusConfig: Record<string, { color: string; label: string }> = {
      draft: { color: 'bg-gray-100 text-gray-800', label: t('common.draft') },
      pending_approval: { color: 'bg-yellow-100 text-yellow-800', label: t('common.pending') },
      approved: { color: 'bg-green-100 text-green-800', label: t('common.approved') },
      partially_received: { color: 'bg-blue-100 text-blue-800', label: 'Partially Received' },
      received: { color: 'bg-purple-100 text-purple-800', label: 'Received' },
      cancelled: { color: 'bg-red-100 text-red-800', label: 'Cancelled' },
    };

    const config = statusConfig[status] || statusConfig.draft;
    return (
      <span className={`px-2 py-1 text-xs font-medium rounded ${config.color}`}>
        {config.label}
      </span>
    );
  };

  const formatCurrency = (amount: number, currency: string) => {
    if (currency === 'USD') {
      return `$ ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const handleCreateNew = () => {
    setEditingPO(null);
    setFormData({
      supplier_id: '',
      po_date: new Date().toISOString().split('T')[0],
      expected_delivery_date: '',
      delivery_address: '',
      currency: 'IDR',
      exchange_rate: 1,
      payment_terms: 'Net 30',
      notes: '',
      terms_conditions: '',
    });
    setPOItems([
      {
        line_number: 1,
        product_id: '',
        make_id: null,
        description: '',
        quantity: 0,
        unit: '',
        unit_price: 0,
        discount_percent: 0,
        discount_amount: 0,
        line_total: 0,
        quantity_received: 0,
        quantity_pending: 0,
      },
    ]);
    setShowCreateModal(true);
  };

  const handleEdit = async (po: PurchaseOrder) => {
    try {
      const currentPO = await fetchPurchaseOrderById(po.id);
      setEditingPO(currentPO);
      setFormData({
        supplier_id: currentPO.supplier_id,
        po_date: currentPO.po_date,
        expected_delivery_date: currentPO.expected_delivery_date || '',
        delivery_address: currentPO.delivery_address || '',
        currency: currentPO.currency,
        exchange_rate: currentPO.exchange_rate,
        payment_terms: currentPO.payment_terms || 'Net 30',
        notes: currentPO.notes || '',
        terms_conditions: currentPO.terms_conditions || '',
      });
      setPOItems(currentPO.purchase_order_items || []);
      setShowCreateModal(true);
    } catch (error) {
      console.error('Error loading purchase order:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to load purchase order' });
    }
  };

  const handleProductChange = (index: number, productId: string) => {
    const product = products.find(p => p.id === productId);
    if (product) {
      const newItems = [...poItems];
      newItems[index] = {
        ...newItems[index],
        product_id: productId,
        make_id: productSources.some(source => source.id === newItems[index].make_id && source.product_id === productId)
          ? newItems[index].make_id
          : null,
        description: product.product_name,
        unit: product.unit,
        unit_price: 0,
      };
      calculateLineTotal(index, newItems);
      setPOItems(newItems);
    }
  };

  const calculateLineTotal = (index: number, items: POItem[]) => {
    const item = items[index];
    const subtotal = item.quantity * item.unit_price;
    const discount = (subtotal * item.discount_percent) / 100;
    items[index].discount_amount = discount;
    items[index].line_total = subtotal - discount;
  };

  const addPOItem = () => {
    setPOItems([
      ...poItems,
      {
        line_number: poItems.length + 1,
        product_id: '',
        make_id: null,
        description: '',
        quantity: 0,
        unit: '',
        unit_price: 0,
        discount_percent: 0,
        discount_amount: 0,
        line_total: 0,
        quantity_received: 0,
        quantity_pending: 0,
        coa_code: '',
        specification: '',
      },
    ]);
  };

  const removePOItem = (index: number) => {
    if (poItems.length > 1) {
      setPOItems(poItems.filter((_, i) => i !== index));
    }
  };

  const calculateTotals = () => {
    const subtotal = poItems.reduce((sum, item) => sum + item.line_total, 0);
    const tax = 0; // No tax for imports
    const total = subtotal;
    return { subtotal, tax, total };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.supplier_id) {
      showToast({ type: 'error', title: 'Error', message: t('validation.selectSupplier') });
      return;
    }

    if (!formData.po_date) {
      showToast({ type: 'error', title: 'Error', message: t('validation.selectDate') });
      return;
    }

    if (poItems.length === 0 || !poItems[0].product_id) {
      showToast({ type: 'error', title: 'Error', message: t('validation.addAtLeastOneProduct') });
      return;
    }

    for (let i = 0; i < poItems.length; i++) {
      const item = poItems[i];
      if (!item.product_id) {
        showToast({ type: 'error', title: 'Error', message: t('validation.selectProductForLine') + ` ${i + 1}` });
        return;
      }
      if (item.quantity <= 0) {
        showToast({ type: 'error', title: 'Error', message: t('validation.enterValidQuantityForLine') + ` ${i + 1}` });
        return;
      }
      if (item.unit_price <= 0) {
        showToast({ type: 'error', title: 'Error', message: t('validation.enterValidPriceForLine') + ` ${i + 1}` });
        return;
      }
    }

    try {
      const { subtotal, tax, total } = calculateTotals();

      const poData = {
        ...formData,
        subtotal,
        tax_amount: tax,
        total_amount: total,
        status: 'draft',
        created_by: user?.id,
      };

      if (editingPO) {
        // Update existing PO
        const { error: poError } = await supabase
          .from('purchase_orders')
          .update(poData)
          .eq('id', editingPO.id);

        if (poError) throw poError;

        const existingItems = editingPO.purchase_order_items || [];
        const retainedIds = poItems.map(item => item.id).filter((id): id is string => Boolean(id));
        const removedIds = existingItems
          .map(item => item.id)
          .filter((id): id is string => typeof id === 'string')
          .filter(id => !retainedIds.includes(id));
        if (removedIds.length) {
          const { data: linked, error: linkError } = await supabase.from('purchase_invoice_items').select('purchase_order_item_id').in('purchase_order_item_id', removedIds);
          if (linkError) throw linkError;
          if (linked && linked.length) throw new Error('One or more items are linked to a Purchase Invoice and cannot be removed.');
          const { error } = await supabase.from('purchase_order_items').delete().in('id', removedIds);
          if (error) throw error;
        }
        for (let index = 0; index < poItems.length; index++) {
          const item = poItems[index];
          const payload = { po_id: editingPO.id, line_number: index + 1, product_id: item.product_id, make_id: item.make_id || null, description: item.description, quantity: item.quantity, unit: item.unit, unit_price: item.unit_price, discount_percent: item.discount_percent || 0, discount_amount: item.discount_amount || 0, line_total: item.line_total, quantity_received: item.quantity_received || 0, coa_code: item.coa_code || null, specification: item.specification || null, notes: item.notes || null };
          const result = item.id
            ? await supabase.from('purchase_order_items').update(payload).eq('id', item.id)
            : await supabase.from('purchase_order_items').insert(payload);
          if (result.error) throw result.error;
        }

        showToast({ type: 'success', title: 'Success', message: t('success.saved') });
      } else {
        // Create new PO
        const { data: newPO, error: poError } = await supabase
          .from('purchase_orders')
          .insert(poData)
          .select()
          .single();

        if (poError) throw poError;

        // Insert items (exclude generated and system columns)
        const itemsToInsert = poItems.map((item, index) => ({
          po_id: newPO.id,
          line_number: index + 1,
          product_id: item.product_id,
          make_id: item.make_id || null,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          unit_price: item.unit_price,
          discount_percent: item.discount_percent || 0,
          discount_amount: item.discount_amount || 0,
          line_total: item.line_total,
          quantity_received: 0,
          coa_code: item.coa_code || null,
          specification: item.specification || null,
          notes: item.notes || null,
        }));

        const { error: itemsError } = await supabase
          .from('purchase_order_items')
          .insert(itemsToInsert);

        if (itemsError) throw itemsError;

        showToast({ type: 'success', title: 'Success', message: t('success.saved') });
      }

      setShowCreateModal(false);
      emitErpSync('purchases', editingPO ? 'updated' : 'created');
      fetchPurchaseOrders();
    } catch (error: any) {
      console.error('Error saving purchase order:', error);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToSave') + ': ' + error.message });
    }
  };

  const handleApprove = async (poId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Approve this Purchase Order?', variant: 'warning' })) return;

    try {
      const { error } = await supabase
        .from('purchase_orders')
        .update({
          status: 'approved',
          approved_by: user?.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', poId);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: t('success.saved') });
      emitErpSync('purchases', 'approved', { entityId: poId });
      fetchPurchaseOrders();
    } catch (error: any) {
      console.error('Error approving PO:', error);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToSave') + ': ' + error.message });
    }
  };

  const handleDelete = async (poId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Are you sure you want to delete this Purchase Order?', variant: 'danger', confirmLabel: 'Delete' })) return;

    try {
      const { data: linkedInvoices, error: linkError } = await supabase
        .from('purchase_invoices')
        .select('id')
        .eq('purchase_order_id', poId)
        .limit(1);
      if (linkError) throw linkError;
      if (linkedInvoices && linkedInvoices.length > 0) {
        showToast({ type: 'error', title: 'Cannot delete', message: 'This Purchase Order is linked to a Purchase Invoice.' });
        return;
      }
      const { error: itemError } = await supabase.from('purchase_order_items').delete().eq('po_id', poId);
      if (itemError) throw itemError;
      const { error } = await supabase
        .from('purchase_orders')
        .delete()
        .eq('id', poId);

      if (error) throw error;

      showToast({ type: 'success', title: 'Success', message: t('success.deleted') });
      emitErpSync('purchases', 'deleted', { entityId: poId });
      fetchPurchaseOrders();
    } catch (error: any) {
      console.error('Error deleting PO:', error);
      showToast({ type: 'error', title: 'Error', message: t('errors.failedToDelete') + ': ' + error.message });
    }
  };

  const handleView = async (po: PurchaseOrder) => {
    try {
      const currentPO = await fetchPurchaseOrderById(po.id);
      setSelectedPO(currentPO);
      setShowViewModal(true);
    } catch (error) {
      console.error('Error loading purchase order:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to load purchase order' });
    }
  };

  // Create a finance-only invoice draft from this PO.  No receiving, batch,
  // stock or accounting action occurs until the invoice is explicitly saved
  // through the existing Purchase Invoice workflow.
  const handleCreateInvoice = (po: PurchaseOrder) => {
    setNavigationData({ createPurchaseInvoice: true, purchaseOrder: po });
    setCurrentPage('finance');
  };

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading...</div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex flex-col gap-1.5 p-2 sm:p-3">
        {/* Header */}
        <div className="flex items-center justify-between h-8 px-2 bg-white border border-gray-200 rounded">
          <div>
            <h1 className="text-xs font-bold text-gray-900">Purchase Orders</h1>
            <p className="text-[10px] text-gray-400">Manage procurement from suppliers</p>
          </div>
          {profile?.role !== 'auditor_ca' && (
            <button
              onClick={handleCreateNew}
            className="inline-flex items-center gap-1 h-7 px-2 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700"
            >
              <Plus className="h-3 w-3" />
              New Purchase Order
            </button>
          )}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 min-h-8 px-2 py-1 bg-white border border-gray-200 rounded flex-wrap">
          <div className="flex-1 max-w-sm">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 h-3 w-3" />
              <input name="search_term" aria-label="Search PO number, supplier..."
                type="text"
                placeholder="Search PO number, supplier..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full h-7 pl-7 pr-2 text-xs border border-gray-300 rounded"
              />
            </div>
          </div>
          <select name="status_filter" aria-label="Status Filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-7 px-2 text-xs border border-gray-300 rounded"
          >
            <option value="all">All Status</option>
            <option value="draft">Draft</option>
            <option value="pending_approval">Pending Approval</option>
            <option value="approved">Approved</option>
            <option value="partially_received">Partially Received</option>
            <option value="received">Received</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        {/* Mobile Cards (<768px) & Desktop Table (768px+) */}
        <div className="bg-white border border-gray-200 rounded overflow-hidden">
          {filteredPOs.length === 0 ? (
            <div className="text-center py-12 px-4 text-gray-500">
              <FileText className="w-10 h-10 mx-auto mb-2 text-gray-300" />
              <p className="text-sm font-medium text-gray-700">No purchase orders found</p>
              <p className="text-xs text-gray-400 mt-0.5">Try adjusting your search or status filter, or create a new purchase order.</p>
            </div>
          ) : (
            <>
              <div className="md:hidden divide-y divide-gray-200">
                {filteredPOs.map((po) => {
                  const isExpanded = expandedMobilePoId === po.id;
                  return (
                    <div key={po.id} className="p-3 space-y-2 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-bold text-gray-900">{po.po_number}</span>
                            {getStatusBadge(po.status)}
                          </div>
                          <p className="font-medium text-gray-800 mt-0.5 truncate">{po.suppliers?.company_name || '—'}</p>
                          <p className="text-[11px] text-gray-400">{formatDate(po.po_date)}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-mono font-bold text-gray-900">
                            {formatCurrency(po.total_amount, po.currency)}
                          </div>
                        </div>
                      </div>

                      <div className="text-[11px] text-gray-600 bg-slate-50 rounded p-2 border border-slate-100">
                        {po.purchase_order_items && po.purchase_order_items.length > 0 ? (
                          <div className="space-y-0.5">
                            {po.purchase_order_items.slice(0, isExpanded ? undefined : 2).map((item, idx) => (
                              <div key={idx} className="flex items-center justify-between gap-2">
                                <span className="truncate font-medium text-gray-700">{item.products?.product_name || item.description}</span>
                                <span className="shrink-0 text-gray-500">×{item.quantity}</span>
                              </div>
                            ))}
                            {!isExpanded && po.purchase_order_items.length > 2 && (
                              <span className="text-[10px] text-blue-600 font-medium">
                                +{po.purchase_order_items.length - 2} more items
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400 italic">No items</span>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => setExpandedMobilePoId(isExpanded ? null : po.id)}
                          className="text-[11px] font-medium text-slate-600 hover:text-slate-900"
                        >
                          {isExpanded ? 'Hide Details' : 'Expand Details'}
                        </button>
                        <div className="flex items-center gap-1.5">
                          <FinanceActionButton action="view" label="View" onClick={() => void handleView(po)} />
                          {po.status !== 'cancelled' && profile?.role !== 'auditor_ca' && (
                            <button
                              type="button"
                              onClick={() => handleCreateInvoice(po)}
                              className="p-1 text-indigo-600 hover:text-indigo-800 rounded hover:bg-indigo-50"
                              title="Create Purchase Invoice"
                            >
                              <FileText className="h-4 w-4" />
                            </button>
                          )}
                          {profile?.role !== 'auditor_ca' && (
                            <>
                              <FinanceActionButton action="edit" label="Edit" onClick={(event) => { event.stopPropagation(); void handleEdit(po); }} />
                              <FinanceActionButton action="delete" label="Delete" onClick={(event) => { event.stopPropagation(); void handleDelete(po.id); }} />
                            </>
                          )}
                          {po.status === 'draft' && profile?.role === 'admin' && (
                            <button
                              type="button"
                              onClick={() => handleApprove(po.id)}
                              className="p-1 text-purple-600 hover:text-purple-800 rounded hover:bg-purple-50"
                              title="Approve"
                            >
                              <CheckCircle className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="hidden md:block overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-gray-500 uppercase">PO Number</th>
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-gray-500 uppercase">Date</th>
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-gray-500 uppercase">Supplier</th>
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-gray-500 uppercase">Products</th>
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-gray-500 uppercase">Total Amount</th>
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-gray-500 uppercase">Status</th>
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredPOs.map((po) => (
                <tr key={po.id} className="hover:bg-gray-50">
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs font-medium text-gray-900">
                    {po.po_number}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-gray-500">
                    {formatDate(po.po_date)}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-gray-500">
                    {po.suppliers?.company_name}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-gray-600">
                    <div className="flex flex-col gap-1 max-w-xs">
                      {po.purchase_order_items && po.purchase_order_items.length > 0 ? (
                        <>
                          {po.purchase_order_items.slice(0, 2).map((item, idx) => (
                            <div key={idx} className="flex items-center gap-1 text-xs">
                              <Package className="w-3 h-3 text-blue-500 flex-shrink-0" />
                              <span className="truncate">
                                <span className="block">{item.products?.product_name || item.description}</span>
                                <span className="block text-[10px] text-gray-500">Make: {item.product_sources?.supplier_name || 'Not recorded'}</span>
                                <span className="text-gray-400 ml-1">×{item.quantity}</span>
                              </span>
                            </div>
                          ))}
                          {po.purchase_order_items.length > 2 && (
                            <span className="text-xs text-gray-400 italic">
                              +{po.purchase_order_items.length - 2} more
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-400 text-xs italic">No items</span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-gray-900 font-medium">
                    {formatCurrency(po.total_amount, po.currency)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {getStatusBadge(po.status)}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-gray-500">
                    <div className="flex items-center gap-1.5">
                      <FinanceActionButton action="view" label="View" onClick={() => void handleView(po)} />
                      {po.status !== 'cancelled' && profile?.role !== 'auditor_ca' && (
                        <button
                          onClick={() => handleCreateInvoice(po)}
                          className="text-indigo-600 hover:text-indigo-800"
                          title="Create Purchase Invoice"
                        >
                          <FileText className="h-4 w-4" />
                        </button>
                      )}
                      {profile?.role !== 'auditor_ca' && (
                        <>
                          <FinanceActionButton action="edit" label="Edit" onClick={(event) => { event.stopPropagation(); void handleEdit(po); }} />
                          <FinanceActionButton action="delete" label="Delete" onClick={(event) => { event.stopPropagation(); void handleDelete(po.id); }} />
                        </>
                      )}
                      {po.status === 'draft' && profile?.role === 'admin' && (
                        <button
                          onClick={() => handleApprove(po.id)}
                          className="text-purple-600 hover:text-purple-800"
                          title="Approve"
                        >
                          <CheckCircle className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
            </>
          )}
        </div>

        {/* Create/Edit Modal */}
        {showCreateModal && (
          <Modal
            isOpen={showCreateModal}
            onClose={() => setShowCreateModal(false)}
            title={editingPO ? 'Edit Purchase Order' : 'New Purchase Order'}
            maxWidth="max-w-[90vw]"
          >
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Header Section - Compact */}
              <SapRow>
                <FloatingField label="Supplier" span={4} required filled={!!formData.supplier_id}>
                  <SearchableSelect
                    value={formData.supplier_id}
                    onChange={(value) => setFormData({ ...formData, supplier_id: value })}
                    options={suppliers.map(s => ({ value: s.id, label: s.company_name }))}
                    placeholder="Select Supplier"
                    className="text-sm"
                    required
                  />
                </FloatingField>
                <FloatingField label="PO Date" span={4} filled={!!formData.po_date}>
                  <input name="po_date" aria-label="PO Date"
                    type="date"
                    value={formData.po_date}
                    onChange={(e) => setFormData({ ...formData, po_date: e.target.value })}
                    className={FLOAT_INPUT}
                    required
                  />
                </FloatingField>
                <FloatingField label="Expected Delivery" span={4} filled={!!formData.expected_delivery_date}>
                  <input name="expected_delivery" aria-label="Expected Delivery"
                    type="date"
                    value={formData.expected_delivery_date}
                    onChange={(e) => setFormData({ ...formData, expected_delivery_date: e.target.value })}
                    className={FLOAT_INPUT}
                  />
                </FloatingField>
              </SapRow>

              {/* Currency and Payment Terms - Compact */}
              <SapRow>
                <FloatingField label="Currency" span={6} filled={!!formData.currency}>
                  <select name="currency" aria-label="Currency"
                    value={formData.currency}
                    onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                    className={FLOAT_INPUT}
                  >
                    <option value="IDR">IDR</option>
                    <option value="USD">USD</option>
                  </select>
                </FloatingField>
                <FloatingField label="Payment Terms" span={6} required filled={!!formData.payment_terms}>
                  <select name="payment_terms" aria-label="Payment Terms"
                    value={formData.payment_terms}
                    onChange={(e) => setFormData({ ...formData, payment_terms: e.target.value })}
                    className={FLOAT_INPUT}
                    required
                  >
                    <option value="Net 7">Net 7</option>
                    <option value="Net 15">Net 15</option>
                    <option value="Net 30">Net 30</option>
                    <option value="Net 45">Net 45</option>
                    <option value="Net 60">Net 60</option>
                    <option value="Net 90">Net 90</option>
                    <option value="Advance">Advance Payment</option>
                    <option value="50-50">50% Advance & 50% on Delivery</option>
                    <option value="COD">Cash on Delivery</option>
                  </select>
                </FloatingField>
              </SapRow>

              {/* Items - Compact Table */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-xs font-semibold text-gray-700">Items</label>
                  <button
                    type="button"
                    onClick={addPOItem}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                  >
                    + Add Item
                  </button>
                </div>

                {/* Compact table with minimal spacing */}
                <div className="border border-gray-300 rounded overflow-x-auto">
                  <table className="min-w-[1280px] w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '260px'}}>Product</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '220px'}}>Make / Manufacturer</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '200px'}}>Specification</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '130px'}}>COA No</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '85px'}}>Qty</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '85px'}}>Unit</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '130px'}}>Price</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '85px'}}>Disc%</th>
                        <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-600 whitespace-nowrap" style={{width: '140px'}}>Total</th>
                        <th className="px-2 py-1.5 text-center text-xs font-medium text-gray-600" style={{width: '40px'}}></th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {poItems.map((item, index) => (
                        <tr key={index} className="hover:bg-gray-50">
                          <td className="px-2 py-1">
                            <SearchableSelect
                              value={item.product_id}
                              onChange={(value) => handleProductChange(index, value)}
                              options={products.map(p => ({ value: p.id, label: p.product_name }))}
                              placeholder="Select"
                              className="text-xs"
                              required
                            />
                          </td>
                          <td className="px-2 py-1">
                            <SearchableSelect
                              value={item.make_id || ''}
                              onChange={(value) => {
                                const newItems = [...poItems];
                                newItems[index] = { ...newItems[index], make_id: value || null };
                                setPOItems(newItems);
                              }}
                              options={productSources
                                .filter(source => source.product_id === item.product_id)
                                .map(source => ({
                                  value: source.id,
                                  label: `${source.supplier_name || 'Unnamed make'}${source.grade ? ` (${source.grade})` : ''}`,
                                }))}
                              placeholder={item.product_id ? 'Select Make' : 'Select product first'}
                              className="text-xs"
                              disabled={!item.product_id}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input name="specification" aria-label="Specs"
                              type="text"
                              value={item.specification || ''}
                              onChange={(e) => {
                                const newItems = [...poItems];
                                newItems[index].specification = e.target.value;
                                setPOItems(newItems);
                              }}
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                              placeholder="Specs"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input name="coa_code" aria-label="COA"
                              type="text"
                              value={item.coa_code || ''}
                              onChange={(e) => {
                                const newItems = [...poItems];
                                newItems[index].coa_code = e.target.value;
                                setPOItems(newItems);
                              }}
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                              placeholder="COA"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input name="quantity" aria-label="Quantity"
                              type="number"
                              value={item.quantity}
                              onChange={(e) => {
                                const newItems = [...poItems];
                                newItems[index].quantity = parseFloat(e.target.value) || 0;
                                calculateLineTotal(index, newItems);
                                setPOItems(newItems);
                              }}
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 text-right"
                              required
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input name="unit" aria-label="Unit"
                              type="text"
                              value={item.unit}
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded bg-gray-50"
                              readOnly
                            />
                          </td>
                          <td className="px-2 py-1">
                            <MoneyInput
                              value={item.unit_price}
                              onChange={(amount) => {
                                const newItems = [...poItems];
                                newItems[index].unit_price = amount;
                                calculateLineTotal(index, newItems);
                                setPOItems(newItems);
                              }}
                              min={0}
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 text-right"
                              required
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input name="discount_percent" aria-label="Discount Percent"
                              type="number"
                              value={item.discount_percent}
                              onChange={(e) => {
                                const newItems = [...poItems];
                                newItems[index].discount_percent = parseFloat(e.target.value) || 0;
                                calculateLineTotal(index, newItems);
                                setPOItems(newItems);
                              }}
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 text-right"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input name="line_total" aria-label="Line Total"
                              type="text"
                              value={formatCurrency(item.line_total, formData.currency)}
                              readOnly
                              className="w-full px-1.5 py-1 text-xs border border-gray-300 rounded bg-gray-50 text-right font-medium"
                            />
                          </td>
                          <td className="px-2 py-1 text-center">
                            {poItems.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removePOItem(index)}
                                className="text-red-600 hover:text-red-800 p-0.5"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Totals - Compact */}
              <div className="border-t pt-2">
                <div className="flex justify-end">
                  <div className="w-56">
                    <div className="flex justify-between text-base font-bold bg-gray-50 px-3 py-2 rounded">
                      <span>Total:</span>
                      <span>{formatCurrency(calculateTotals().total, formData.currency)}</span>
                    </div>
                  </div>
                </div>
              </div>

              <SapRow>
                <FloatingField label="Notes" span={12} textarea filled={!!formData.notes}>
                  <textarea name="notes" aria-label="Notes"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={2}
                    className={FLOAT_TEXTAREA}
                    placeholder="Additional notes or instructions..."
                  />
                </FloatingField>
              </SapRow>

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  {editingPO ? 'Update' : 'Create'} Purchase Order
                </button>
              </div>
            </form>
          </Modal>
        )}

        {showViewModal && selectedPO && (
          <PurchaseOrderView
            purchaseOrder={selectedPO}
            items={selectedPO.purchase_order_items || []}
            onClose={() => {
              setShowViewModal(false);
              setSelectedPO(null);
            }}
            companyProfile={(selectedPO as any).company_snapshot ?? undefined}
          />
        )}
      </div>
    </Layout>
  );
}
