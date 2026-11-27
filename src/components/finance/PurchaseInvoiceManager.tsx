import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Search, FileText, X, AlertCircle, CreditCard, PackageCheck, CheckCircle, Eye, Pencil, Trash2, ChevronDown } from 'lucide-react';
import { showConfirm } from '../ConfirmDialog';
import { FinanceModal as Modal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { FinanceModal } from './FinanceModal';
import { F_BTN_PRIMARY, F_BTN_SECONDARY } from './FinanceForm';
import { SAP_INPUT } from './SapLayout';
import { FloatingField, FLOAT_INPUT } from './FloatingField';
import { FinanceActionButton, FinanceBadge } from './FinanceUI';
import { SearchableSelect } from '../SearchableSelect';
import { FileUpload } from '../FileUpload';
import { showToast } from '../ToastNotification';
import { formatDate } from '../../utils/dateFormat';
import { downloadStorageDocument, openStorageDocument, resolveStorageUrlCached } from '../../utils/signedUrlCache';
import { formatCurrency } from '../../utils/currency';
import { useFinance } from '../../contexts/FinanceContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { extractPurchaseInvoicePdf, ExtractedPurchaseInvoice } from '../../utils/purchaseInvoicePdfExtractor';
import { applySettlementAdjustment } from '../../services/financeCommands';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { uploadOptimizedFile } from '../../services/storage/uploadOptimizationService';

interface Supplier {
  id: string;
  company_name: string;
  npwp: string | null;
  pkp_status: boolean;
  address: string | null;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
}

interface Product {
  id: string;
  product_name: string;
  unit: string;
  current_stock: number;
}
interface ImportContainerOption { id: string; container_ref: string; status: string | null; }

interface ChartOfAccount {
  id: string;
  code: string;
  name: string;
  account_type: string;
}

interface PurchaseInvoiceItem {
  id?: string;
  purchase_order_item_id?: string | null;
  item_type: 'inventory' | 'fixed_asset' | 'expense' | 'freight' | 'duty' | 'insurance' | 'clearing' | 'other';
  product_id: string | null;
  product_name?: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
  expense_account_id: string | null;
  asset_account_id: string | null;
  receiving_make_id?: string | null;
  receiving_make?: { supplier_name: string | null; grade: string | null } | null;
  receiving_batch_number?: string | null;
  batch_id?: string | null;
  receiving_expiry_date?: string | null;
  receiving_import_container_id?: string | null;
  receiving_notes?: string | null;
}

interface ReceivingAllocation {
  id: string;
  purchase_invoice_item_id: string;
  batch_id: string;
  received_quantity: number;
  status: string;
}

interface ReceivingDocument {
  id?: string;
  file?: File;
  file_name: string;
  file_type: string;
  file_size: number;
  file_url?: string;
}

interface PurchaseInvoice {
  id: string;
  invoice_number: string;
  supplier_id: string;
  invoice_date: string;
  due_date: string | null;
  currency: string;
  exchange_rate: number;
  subtotal: number;
  tax_amount: number;
  stamp_duty_amount: number;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
  status: string;
  faktur_pajak_number: string | null;
  notes: string | null;
  document_urls: string[] | null;
  purchase_type: string;
  requires_faktur_pajak: boolean;
  purchase_order_id?: string | null;
  suppliers?: { company_name: string; pkp_status: boolean };
  journal_entry_id?: string | null;
  receiving_approval_status?: 'draft' | 'pending_approval' | 'approved' | 'rejected';
  receiving_rejection_reason?: string | null;
}

interface PurchaseInvoiceManagerProps {
  canManage: boolean;
  onPayInvoice?: (invoice: { id: string; invoice_number: string; supplier_id: string; balance_amount: number }) => void;
  initialViewInvoiceId?: string | null;
  onInitialViewHandled?: () => void;
}

export function PurchaseInvoiceManager({ canManage, onPayInvoice, initialViewInvoiceId, onInitialViewHandled }: PurchaseInvoiceManagerProps) {
  const { profile, accessibleModules } = useAuth();
  const hasManageAccess = canManage || profile?.role === 'admin' || profile?.role === 'accounts' || profile?.role === 'manager' || accessibleModules.has('purchase-invoices') || accessibleModules.has('finance');
  const { dateRange } = useFinance();
  const { navigationData, clearNavigationData } = useNavigation();
  const { t, language } = useLanguage();
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productSources, setProductSources] = useState<Array<{ id: string; product_id: string; supplier_name: string | null; grade: string | null }>>([]);
  const [importContainers, setImportContainers] = useState<ImportContainerOption[]>([]);
  const [accounts, setAccounts] = useState<ChartOfAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedInvoiceIds, setExpandedInvoiceIds] = useState<Set<string>>(new Set());
  const toggleExpandInvoice = (id: string) => {
    setExpandedInvoiceIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const [ppnRate, setPpnRate] = useState(0); // 0 or 11
  const [stampDutyAmount, setStampDutyAmount] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModal, setViewModal] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<PurchaseInvoice | null>(null);
  const [invoiceAdjustment, setInvoiceAdjustment] = useState<any | null>(null);
  const [roundingTolerance, setRoundingTolerance] = useState<number>(100);
  const [settlingAdjustment, setSettlingAdjustment] = useState(false);
  const [viewLineItems, setViewLineItems] = useState<PurchaseInvoiceItem[]>([]);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewBlobUrl, setViewBlobUrl] = useState<string | null>(null);
  const [viewBlobLoading, setViewBlobLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [uploading, setUploading] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<PurchaseInvoice | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [receivingOpen, setReceivingOpen] = useState(false);
  const [receivingItem, setReceivingItem] = useState<PurchaseInvoiceItem | null>(null);
  const [receivingMakes, setReceivingMakes] = useState<Array<{ id: string; supplier_name: string | null; grade: string | null }>>([]);
  const [receivingBatches, setReceivingBatches] = useState<Array<{ id: string; batch_number: string; make_id: string | null; current_stock: number; import_container_id: string | null }>>([]);
  const [receivingAllocations, setReceivingAllocations] = useState<ReceivingAllocation[]>([]);
  const [productBatches, setProductBatches] = useState<Array<{ id: string; product_id: string; batch_number: string; make_id: string | null }>>([]);
  const [receivingDocuments, setReceivingDocuments] = useState<ReceivingDocument[]>([]);
  const [receivingForm, setReceivingForm] = useState({ make_id: '', batch_id: '', batch_number: '', expiry_date: '', quantity: 0, import_container_id: '' });
  const [receivingBusy, setReceivingBusy] = useState(false);
  const [purchaseOrderId, setPurchaseOrderId] = useState<string | null>(null);
  const [supplierPurchaseOrders, setSupplierPurchaseOrders] = useState<Array<{
    id: string;
    po_number: string;
    po_date: string;
    supplier_id: string;
    currency: string;
    exchange_rate: number;
    status: string;
    purchase_order_items?: Array<{
      id: string;
      product_id: string;
      make_id?: string | null;
      description?: string | null;
      quantity: number;
      unit?: string | null;
      unit_price: number;
      line_total?: number | null;
      products?: { product_name: string; unit: string } | null;
    }>;
  }>>([]);
  const [loadingSupplierPurchaseOrders, setLoadingSupplierPurchaseOrders] = useState(false);
  const [pdfExtraction, setPdfExtraction] = useState<ExtractedPurchaseInvoice | null>(null);
  const [pdfExtracting, setPdfExtracting] = useState(false);

  const [formData, setFormData] = useState({
    invoice_number: '',
    supplier_id: '',
    invoice_date: new Date().toISOString().split('T')[0],
    due_date: '',
    currency: 'IDR',
    exchange_rate: 1,
    faktur_pajak_number: '',
    notes: '',
    document_urls: [] as string[],
  });

  const [lineItems, setLineItems] = useState<PurchaseInvoiceItem[]>([
    {
      item_type: 'inventory',
      product_id: null,
      description: '',
      quantity: 1,
      unit: 'pcs',
      unit_price: 0,
      line_total: 0,
      expense_account_id: null,
      asset_account_id: null,
    },
  ]);

  useEffect(() => {
    loadInvoices();
  }, [dateRange.startDate, dateRange.endDate]);

  // A PO creates only an invoice draft. Receiving, batches and stock remain
  // explicit later actions in the existing receiving workflow.
  useEffect(() => {
    if (navigationData?.createPurchaseInvoice !== true || !navigationData.purchaseOrder) return;
    const po = navigationData.purchaseOrder as any;
    const poItems = Array.isArray(po.purchase_order_items) ? po.purchase_order_items : [];
    if (typeof po.id === 'string') {
      setSupplierPurchaseOrders(prev => prev.some(item => item.id === po.id) ? prev : [po as typeof supplierPurchaseOrders[number], ...prev]);
    }
    setEditingInvoice(null);
    setPurchaseOrderId(typeof po.id === 'string' ? po.id : null);
    setFormData(prev => ({
      ...prev,
      invoice_number: '',
      supplier_id: po.supplier_id || '',
      invoice_date: new Date().toISOString().split('T')[0],
      due_date: '',
      currency: po.currency || 'IDR',
      exchange_rate: Number(po.exchange_rate) || 1,
      notes: po.po_number ? `Created from PO ${po.po_number}` : '',
      document_urls: [],
    }));
    setPpnRate(0);
    setStampDutyAmount(0);
    const mapped = poItems.filter((item: any) => item.product_id).map((item: any) => ({
      item_type: 'inventory' as const,
      product_id: item.product_id,
      purchase_order_item_id: item.id || null,
      product_name: item.products?.product_name,
      description: item.description || item.products?.product_name || '',
      // This is an initial ordered-quantity suggestion; users may change it
      // to the supplier-billed quantity before saving the invoice.
      quantity: Number(item.quantity) || 0,
      unit: item.unit || item.products?.unit || 'pcs',
      unit_price: Number(item.unit_price) || 0,
      line_total: Number(item.line_total) || 0,
      expense_account_id: null,
      asset_account_id: null,
      receiving_make_id: item.make_id || null,
    }));
    if (mapped.length) setLineItems(mapped);
    setModalOpen(true);
    clearNavigationData();
  }, [navigationData, clearNavigationData]);

  useEffect(() => {
    supabase
      .from('app_settings')
      .select('rounding_tolerance_amount')
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.rounding_tolerance_amount) {
          setRoundingTolerance(Number(data.rounding_tolerance_amount));
        }
      });
  }, []);

  useEffect(() => {
    if (!initialViewInvoiceId || loading) return;
    const openInitialInvoice = async () => {
      const invoice = invoices.find(item => item.id === initialViewInvoiceId);
      if (invoice) {
        await handleOpenView(invoice);
      } else {
        // Journal drill-down must open the source document even when its date
        // is outside the normal, globally filtered purchase list.
        const { data, error } = await supabase
          .from('purchase_invoices')
          .select('*, suppliers(company_name, pkp_status)')
          .eq('id', initialViewInvoiceId)
          .maybeSingle();
        if (error) {
          console.error('Error opening journal source purchase invoice:', error);
        } else if (data) {
          await handleOpenView(data as PurchaseInvoice);
        }
      }
      onInitialViewHandled?.();
    };
    void openInitialInvoice();
  }, [initialViewInvoiceId, loading, invoices, onInitialViewHandled]);

  useEffect(() => {
    loadSuppliers();
    loadProducts();
    void loadProductSources();
    loadAccounts();
    void loadImportContainers();
    void loadProductBatches();
  }, []);

  const loadProductBatches = async () => {
    const { data } = await supabase
      .from('batches')
      .select('id, product_id, batch_number, make_id')
      .eq('is_active', true)
      .order('batch_number');
    setProductBatches((data || []) as typeof productBatches);
  };

  const loadProductSources = async () => {
    const { data } = await supabase.from('product_sources').select('id,product_id,supplier_name,grade').order('supplier_name');
    setProductSources((data || []) as typeof productSources);
  };

  useEffect(() => {
    void loadSupplierPurchaseOrders(formData.supplier_id);
  }, [formData.supplier_id]);

  const loadInvoices = async () => {
    try {
      const { data, error } = await supabase
        .from('purchase_invoices')
        .select('*, suppliers(company_name, pkp_status)')
        .gte('invoice_date', dateRange.startDate)
        .lte('invoice_date', dateRange.endDate)
        .order('invoice_date', { ascending: false });

      if (error) throw error;
      setInvoices(data || []);
    } catch (error) {
      console.error('Error loading invoices:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadSuppliers = async () => {
    const { data } = await supabase
      .from('suppliers')
      .select('id, company_name, npwp, pkp_status, address, contact_person, phone, email')
      .order('company_name');
    setSuppliers(data || []);
  };

  const loadProducts = async () => {
    const { data } = await supabase
      .from('products')
      .select('id, product_name, unit, current_stock')
      .order('product_name');
    setProducts(data || []);
  };

  const loadAccounts = async () => {
    const { data } = await supabase
      .from('chart_of_accounts')
      .select('id, code, name, account_type')
      .in('account_type', ['Expense', 'Asset', 'Cost of Goods Sold', 'expense', 'asset', 'cost_of_goods_sold'])
      .order('code');
    setAccounts(data || []);
  };

  const loadImportContainers = async () => {
    const { data } = await supabase.from('import_containers').select('id,container_ref,status').order('created_at', { ascending: false }).limit(200);
    setImportContainers((data || []) as ImportContainerOption[]);
  };

  const loadSupplierPurchaseOrders = async (supplierId: string) => {
    if (!supplierId) {
      setSupplierPurchaseOrders([]);
      return;
    }
    setLoadingSupplierPurchaseOrders(true);
    try {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('id,po_number,po_date,supplier_id,currency,exchange_rate,status,purchase_order_items(id,product_id,make_id,description,quantity,unit,unit_price,line_total,products(product_name,unit))')
        .eq('supplier_id', supplierId)
        .order('po_date', { ascending: false });
      if (error) throw error;
      // Normalize the generated relation shape once at the query boundary.
      // Depending on the client schema metadata, PostgREST may expose this
      // many-to-one Product relation as either an object or a one-element
      // array; the form model consistently uses a single Product object.
      const fetched = (data || [])
        .filter(po => String(po.status || '').toLowerCase() !== 'cancelled')
        .map(po => ({
          ...po,
          purchase_order_items: (po.purchase_order_items || []).map(item => ({
            ...item,
            products: Array.isArray(item.products) ? item.products[0] || null : item.products || null,
          })),
        }));
      setSupplierPurchaseOrders(prev => {
        const selected = purchaseOrderId ? prev.find(item => item.id === purchaseOrderId) : null;
        return selected && !fetched.some(item => item.id === selected.id) ? [selected, ...fetched] : fetched;
      });
    } catch (error) {
      console.error('Error loading supplier purchase orders:', error);
      setSupplierPurchaseOrders([]);
    } finally {
      setLoadingSupplierPurchaseOrders(false);
    }
  };

  const emptyInvoiceLine = (): PurchaseInvoiceItem => ({
    item_type: 'inventory',
    product_id: null,
    description: '',
    quantity: 1,
    unit: 'pcs',
    unit_price: 0,
    line_total: 0,
    expense_account_id: null,
    asset_account_id: null,
    receiving_batch_number: null,
    batch_id: null,
  });

  const mapPurchaseOrderLines = (po: (typeof supplierPurchaseOrders)[number]) =>
    (po.purchase_order_items || []).filter(item => item.product_id).map(item => ({
      item_type: 'inventory' as const,
      product_id: item.product_id,
      receiving_make_id: item.make_id || null,
      purchase_order_item_id: item.id,
      product_name: item.products?.product_name,
      description: item.description || item.products?.product_name || '',
      quantity: Number(item.quantity) || 0,
      unit: item.unit || item.products?.unit || 'pcs',
      unit_price: Number(item.unit_price) || 0,
      line_total: Number(item.line_total) || (Number(item.quantity) || 0) * (Number(item.unit_price) || 0),
      expense_account_id: null,
      asset_account_id: null,
    }));

  const handleSupplierChange = (supplierId: string) => {
    const hadSelectedPO = Boolean(purchaseOrderId);
    setFormData(prev => ({ ...prev, supplier_id: supplierId }));
    setPurchaseOrderId(null);
    if (hadSelectedPO) setLineItems([emptyInvoiceLine()]);
  };

  const handlePurchaseOrderChange = (poId: string) => {
    if (!poId) {
      setPurchaseOrderId(null);
      setLineItems([emptyInvoiceLine()]);
      return;
    }
    const po = supplierPurchaseOrders.find(item => item.id === poId);
    if (!po || String(po.status || '').toLowerCase() === 'cancelled') return;
    if (po.supplier_id !== formData.supplier_id) return;
    const mapped = mapPurchaseOrderLines(po);
    setPurchaseOrderId(po.id);
    setFormData(prev => ({
      ...prev,
      currency: editingInvoice ? prev.currency : (po.currency || prev.currency),
      exchange_rate: editingInvoice ? prev.exchange_rate : (Number(po.exchange_rate) || 1),
      // Linking a PO to an existing PI must not overwrite supplier notes.
      ...(editingInvoice ? {} : { notes: po.po_number ? `Created from PO ${po.po_number}` : prev.notes }),
    }));
    if (mapped.length) setLineItems(mapped);
  };

  const loadViewLineItems = async (invoiceId: string) => {
    setViewLoading(true);
    try {
      const { data, error } = await supabase
        .from('purchase_invoice_items')
        .select('*, products(product_name, unit), receiving_make:product_sources!purchase_invoice_items_receiving_make_id_fkey(supplier_name, grade)')
        .eq('purchase_invoice_id', invoiceId)
        .order('created_at');
      if (error) throw error;
      const items = (data || []).map((item: any) => ({
        ...item,
        products: Array.isArray(item.products) ? item.products[0] || null : item.products || null,
        product_name: (Array.isArray(item.products) ? item.products[0] : item.products)?.product_name || null,
      }));
      setViewLineItems(items);
    } catch (err) {
      console.error('Error loading line items:', err);
      setViewLineItems([]);
    } finally {
      setViewLoading(false);
    }
  };

  const loadReceivingAllocations = async (invoiceId: string) => {
    const { data } = await supabase.from('purchase_invoice_receiving_allocations').select('id,purchase_invoice_item_id,batch_id,received_quantity,status').eq('purchase_invoice_id', invoiceId).eq('status', 'received');
    setReceivingAllocations((data || []) as ReceivingAllocation[]);
  };

  const openReceiving = async (item: PurchaseInvoiceItem) => {
    if (!selectedInvoice || item.item_type !== 'inventory' || !item.product_id) return;
    const { data, error } = await supabase.from('product_sources').select('id,supplier_name,grade').eq('product_id', item.product_id).order('supplier_name');
    if (error) { showToast({ type: 'error', title: 'Error', message: error.message }); return; }
    const makes = data || [];
    const { data: batches } = await supabase.from('batches').select('id,batch_number,make_id,current_stock,import_container_id').eq('product_id', item.product_id).eq('is_active', true).order('batch_number');
    const { data: receivedTotal, error: receivedError } = await supabase.rpc('purchase_invoice_item_received_quantity', { p_item_id: item.id });
    if (receivedError) { showToast({ type: 'error', title: 'Unable to calculate receiving balance', message: receivedError.message }); return; }
    const received = Number(receivedTotal) || 0;
    setReceivingItem(item);
    setReceivingMakes(makes);
    setReceivingBatches((batches || []) as Array<{ id: string; batch_number: string; make_id: string | null; current_stock: number; import_container_id: string | null }>);
    setReceivingForm({ make_id: item.receiving_make_id || (makes.length === 1 ? makes[0].id : ''), batch_id: '', batch_number: item.receiving_batch_number || '', expiry_date: item.receiving_expiry_date || '', quantity: Math.max(0, Number(item.quantity) - received), import_container_id: item.receiving_import_container_id || '' });
    setReceivingDocuments([]);
    setReceivingOpen(true);
  };

  // Reuse the existing Batch document storage/table used by the Batches page.
  // Documents are uploaded only after the receiving RPC returns its batch id;
  // a document failure must not cause the stock receipt to be retried.
  const uploadReceivingBatchDocuments = async (batchId: string) => {
    const filesToUpload = receivingDocuments.filter(file => file.file && !file.id);
    for (const fileData of filesToUpload) {
      try {
        const fileName = `${Date.now()}_${fileData.file!.name}`;
        const filePath = `${batchId}/${fileName}`;
        const { error: uploadError, optimization } = await uploadOptimizedFile(supabase, 'batch-documents', filePath, fileData.file!);
        if (uploadError) throw uploadError;
        const { data: { publicUrl } } = supabase.storage.from('batch-documents').getPublicUrl(filePath);
        const { error: dbError } = await supabase.from('batch_documents').insert([{
          batch_id: batchId,
          file_url: publicUrl,
          file_name: fileData.file_name,
          file_type: fileData.file_type,
          file_size: optimization.optimizedSize,
        }]);
        if (dbError) throw dbError;
      } catch (error) {
        console.error('Error uploading receiving batch document:', error);
        showToast({ type: 'error', title: 'Document upload failed', message: `Could not attach ${fileData.file_name}. The receipt was saved.` });
      }
    }
  };

  const submitReceiving = async () => {
    if (!selectedInvoice || !receivingItem?.id || !receivingItem.product_id || !receivingForm.make_id || (!receivingForm.batch_id && !receivingForm.batch_number.trim()) || receivingForm.quantity <= 0) {
      showToast({ type: 'error', title: 'Incomplete receiving', message: 'Select a Make, batch number, and positive quantity.' }); return;
    }
    setReceivingBusy(true);
    try {
      const operationId = crypto.randomUUID();
      let batchId = receivingForm.batch_id || null;
      // Existing legacy invoices may have a batch number but no stored batch_id.
      // Resolve the authoritative physical batch deterministically before
      // invoking the existing receiving RPC so a duplicate batch is never
      // created for the same Product/Make/Batch number.
      if (!batchId && receivingForm.batch_number.trim()) {
        const { data: matchingBatch, error: batchLookupError } = await supabase
          .from('batches')
          .select('id')
          .eq('product_id', receivingItem.product_id)
          .eq('make_id', receivingForm.make_id)
          .eq('batch_number', receivingForm.batch_number.trim())
          .eq('is_active', true)
          .limit(1)
          .maybeSingle();
        if (batchLookupError) throw batchLookupError;
        batchId = matchingBatch?.id || null;
      }
      const { data, error } = await supabase.rpc('receive_purchase_invoice_item', {
        p_purchase_invoice_item_id: receivingItem.id,
        p_received_quantity: receivingForm.quantity,
        p_operation_id: operationId,
        p_payload: { product_id: receivingItem.product_id, make_id: receivingForm.make_id, batch_id: batchId, batch_number: receivingForm.batch_number.trim(), import_date: selectedInvoice.invoice_date, expiry_date: receivingForm.expiry_date || null, import_price: receivingItem.unit_price, import_price_usd: selectedInvoice.currency === 'USD' ? receivingItem.unit_price : null, exchange_rate_usd_to_idr: selectedInvoice.currency === 'USD' ? selectedInvoice.exchange_rate : null, import_container_id: receivingForm.import_container_id || null, packaging_details: receivingItem.unit },
      });
      if (error) throw error;
      const receivedBatchId = (data as { batch_id?: string } | null)?.batch_id;
      if (receivedBatchId && receivingDocuments.length > 0) await uploadReceivingBatchDocuments(receivedBatchId);
      showToast({ type: 'success', title: 'Inventory received', message: 'Batch and stock receipt created.' });
      setReceivingOpen(false);
      setReceivingDocuments([]);
      await loadReceivingAllocations(selectedInvoice.id);
      await loadViewLineItems(selectedInvoice.id);
    } catch (error: any) {
      showToast({ type: 'error', title: 'Receiving failed', message: error.message });
    } finally { setReceivingBusy(false); }
  };

  const handleOpenView = async (invoice: PurchaseInvoice) => {
    setSelectedInvoice(invoice);
    setViewModal(true);
    setViewBlobUrl(null);
    setInvoiceAdjustment(null);
    await loadViewLineItems(invoice.id);
    await loadReceivingAllocations(invoice.id);

    try {
      const { data: adjData, error: adjErr } = await supabase
        .from('invoice_rounding_adjustments')
        .select('id, adjustment_amount, adjustment_type, reason, created_at, journal_entries(entry_number)')
        .eq('purchase_invoice_id', invoice.id)
        .maybeSingle();
      if (!adjErr && adjData) {
        setInvoiceAdjustment(adjData);
      } else {
        setInvoiceAdjustment(null);
      }
    } catch (adjErr) {
      console.warn('Settlement adjustment not loaded (migration may be pending):', adjErr);
      setInvoiceAdjustment(null);
    }

    if (invoice.document_urls && invoice.document_urls.length > 0) {
      setViewBlobLoading(true);
      try {
        const url = invoice.document_urls[0];
        const signedUrl = await resolveStorageUrlCached(url, 3600);

        if (signedUrl.includes('/storage/v1/object/sign/') || signedUrl.includes('supabase.co/storage/v1/object/public/')) {
          // Supabase Storage URL (signed or public) — PDF viewer can load it directly
          setViewBlobUrl(signedUrl);
        } else {
          // For other URLs, try to fetch as blob
          const res = await fetch(signedUrl);
          if (res.ok) {
            const blob = await res.blob();
            setViewBlobUrl(URL.createObjectURL(blob));
          } else {
            console.error('Failed to fetch PDF:', res.status, res.statusText);
            setViewBlobUrl(null);
          }
        }
      } catch (err) {
        console.error('Error loading PDF:', err);
        setViewBlobUrl(null);
      } finally {
        setViewBlobLoading(false);
      }
    }
  };

  const handleSettleResidualRoundOff = async () => {
    if (!selectedInvoice) return;
    const balance = Number(selectedInvoice.balance_amount);
    if (balance <= 0) return;

    if (!await showConfirm({
      title: 'Settle Round-Off Adjustment',
      message: `Post residual round-off adjustment of ${formatCurrency(balance, selectedInvoice.currency)} to close purchase invoice ${selectedInvoice.invoice_number}? This will debit Accounts Payable and credit Round-Off Gain.`,
      confirmLabel: 'Settle Round-Off'
    })) return;

    setSettlingAdjustment(true);
    try {
      await applySettlementAdjustment({
        documentType: 'purchase',
        invoiceId: selectedInvoice.id,
        adjustmentType: 'rounding',
        reason: 'invoice_rounding_tolerance',
      });
      showToast({ type: 'success', title: 'Settled', message: `Round-off adjustment of ${formatCurrency(balance, selectedInvoice.currency)} posted.` });
      await loadInvoices();
      const { data: updatedInv } = await supabase.from('purchase_invoices').select('*, suppliers(company_name, pkp_status)').eq('id', selectedInvoice.id).single();
      if (updatedInv) setSelectedInvoice(updatedInv as any);
      await loadViewLineItems(selectedInvoice.id);
      try {
        const { data: adjData, error: adjErr } = await supabase
          .from('invoice_rounding_adjustments')
          .select('id, adjustment_amount, adjustment_type, reason, created_at, journal_entries(entry_number)')
          .eq('purchase_invoice_id', selectedInvoice.id)
          .maybeSingle();
        if (!adjErr && adjData) setInvoiceAdjustment(adjData);
      } catch {
        // Safe query fallback
      }
    } catch (err: any) {
      console.error('Failed to post round-off adjustment:', err);
      const msg = err?.message || 'Failed to post round-off adjustment';
      showToast({
        type: 'error',
        title: 'Settlement Failed',
        message: msg.includes('schema cache') || msg.includes('does not exist')
          ? 'Database migration pending: save_invoice_settlement_adjustment is not installed in the database yet. Please apply migration 20261019140000_invoice_rounding_and_discount_settlement.sql.'
          : msg,
      });
    } finally {
      setSettlingAdjustment(false);
    }
  };

  const updateReceivingApproval = async (invoice: PurchaseInvoice, action: 'submit' | 'approve') => {
    const rpc = action === 'submit' ? 'submit_purchase_invoice_for_receiving' : 'approve_purchase_invoice_for_receiving';
    const { error } = await supabase.rpc(rpc, { p_purchase_invoice_id: invoice.id });
    if (error) {
      showToast({ type: 'error', title: 'Approval update failed', message: error.message });
      return;
    }
    showToast({ type: 'success', title: action === 'submit' ? 'Submitted' : 'Approved', message: action === 'submit' ? 'Invoice submitted for receiving approval.' : 'Invoice approved for inward.' });
    await loadInvoices();
  };

  const handleOpenAttachment = async (url: string) => {
    try {
      await openStorageDocument(url);
    } catch (err) {
      console.error('Error opening purchase invoice attachment:', err);
      showToast({ type: 'error', title: 'Error', message: 'Unable to open attachment. Please try again.' });
    }
  };

  const handleDownloadAttachment = async (url: string) => {
    const filename = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'attachment');
    try {
      await downloadStorageDocument(url, filename);
    } catch (err) {
      console.error('Error downloading purchase invoice attachment:', err);
      showToast({ type: 'error', title: 'Error', message: 'Unable to download attachment. Please try again.' });
    }
  };

  const selectedSupplier = suppliers.find(s => s.id === formData.supplier_id);
  const selectedPurchaseOrder = purchaseOrderId
    ? supplierPurchaseOrders.find(po => po.id === purchaseOrderId) || null
    : null;

  const handleAddLine = () => {
    setLineItems([
      ...lineItems,
      emptyInvoiceLine(),
    ]);
  };

  const handleRemoveLine = (index: number) => {
    if (lineItems.length > 1) {
      setLineItems(lineItems.filter((_, i) => i !== index));
    }
  };

  const handleLineChange = (index: number, field: keyof PurchaseInvoiceItem, value: any) => {
    const newLines = [...lineItems];
    newLines[index] = { ...newLines[index], [field]: value };

    // Auto-calculate line total
    if (field === 'quantity' || field === 'unit_price') {
      newLines[index].line_total = newLines[index].quantity * newLines[index].unit_price;
    }

    // If item_type changes, clear product/account selections
    if (field === 'item_type') {
      newLines[index].purchase_order_item_id = null;
      newLines[index].product_id = null;
      newLines[index].expense_account_id = null;
      newLines[index].asset_account_id = null;
      newLines[index].description = '';
      newLines[index].receiving_make_id = null;
      newLines[index].receiving_batch_number = null;
      newLines[index].batch_id = null;
      newLines[index].receiving_expiry_date = null;
      newLines[index].receiving_import_container_id = null;
    }

    // If product changes, auto-fill details and keep purchase_order_item_id consistent
    if (field === 'product_id' && value) {
      const product = products.find(p => p.id === value);
      if (product) {
        newLines[index].unit = product.unit;
      }
      if (newLines[index].purchase_order_item_id && selectedPurchaseOrder?.purchase_order_items) {
        const currentPoItem = selectedPurchaseOrder.purchase_order_items.find(
          candidate => candidate.id === newLines[index].purchase_order_item_id
        );
        if (!currentPoItem || currentPoItem.product_id !== value) {
          const matchingPoItems = selectedPurchaseOrder.purchase_order_items.filter(
            candidate => candidate.product_id === value
          );
          newLines[index].purchase_order_item_id = matchingPoItems.length === 1 ? matchingPoItems[0].id : null;
        }
      }
      newLines[index].receiving_make_id = null;
      if (newLines[index].receiving_batch_number) {
        const matched = productBatches.find(b => b.product_id === value && b.batch_number.trim().toLowerCase() === String(newLines[index].receiving_batch_number).trim().toLowerCase());
        newLines[index].batch_id = matched ? matched.id : null;
      } else {
        newLines[index].batch_id = null;
      }
    }

    // If receiving_batch_number changes, resolve batch_id
    if (field === 'receiving_batch_number') {
      const batchNum = value ? String(value).trim() : '';
      if (batchNum && newLines[index].product_id) {
        const matched = productBatches.find(b => b.product_id === newLines[index].product_id && b.batch_number.trim().toLowerCase() === batchNum.toLowerCase());
        newLines[index].batch_id = matched ? matched.id : null;
      } else {
        newLines[index].batch_id = null;
      }
    }

    setLineItems(newLines);
  };

  const calculateTotals = () => {
    const subtotal = lineItems.reduce((sum, item) => sum + item.line_total, 0);
    const ppnAmount = Math.round(subtotal * ppnRate / 100 * 100) / 100;
    const total = subtotal + ppnAmount + stampDutyAmount;
    return { subtotal, ppnAmount, stampDutyAmount, total };
  };

  const handleOpenEdit = async (invoice: PurchaseInvoice) => {
    setEditingInvoice(invoice);
    setPurchaseOrderId(invoice.purchase_order_id || null);
    setFormData({
      invoice_number: invoice.invoice_number,
      supplier_id: invoice.supplier_id,
      invoice_date: invoice.invoice_date,
      due_date: invoice.due_date || '',
      currency: invoice.currency,
      exchange_rate: invoice.exchange_rate,
      faktur_pajak_number: invoice.faktur_pajak_number || '',
      notes: invoice.notes || '',
      document_urls: invoice.document_urls || [],
    });

    const { data } = await supabase
      .from('purchase_invoice_items')
      .select('*, products(product_name, unit)')
      .eq('purchase_invoice_id', invoice.id)
      .order('created_at');

    // Restore invoice-level PPN rate and stamp duty
    if (invoice.subtotal > 0 && invoice.tax_amount > 0) {
      const rate = Math.round((invoice.tax_amount / invoice.subtotal) * 100);
      setPpnRate(rate === 11 ? 11 : 0);
    } else {
      setPpnRate(0);
    }
    setStampDutyAmount(Number(invoice.stamp_duty_amount) || 0);

    const items = (data || []).map((item: any) => ({
      id: item.id,
      item_type: item.item_type,
      purchase_order_item_id: item.purchase_order_item_id || null,
      product_id: item.product_id,
      product_name: (Array.isArray(item.products) ? item.products[0] : item.products)?.product_name || null,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: item.line_total,
      expense_account_id: item.expense_account_id,
      asset_account_id: item.asset_account_id,
      receiving_make_id: item.receiving_make_id || null,
      receiving_batch_number: item.receiving_batch_number || null,
      batch_id: item.batch_id || null,
      receiving_expiry_date: item.receiving_expiry_date || null,
      receiving_import_container_id: item.receiving_import_container_id || null,
      receiving_notes: item.receiving_notes || null,
    }));

    setLineItems(items.length > 0 ? items : [{
      item_type: 'inventory' as const,
      product_id: null,
      description: '',
      quantity: 1,
      unit: 'pcs',
      unit_price: 0,
      line_total: 0,
      expense_account_id: null,
      asset_account_id: null,
    }]);
    setModalOpen(true);
  };

  const handleDelete = async (invoice: PurchaseInvoice) => {
    const confirmed = await showConfirm({
      title: 'Delete Purchase Invoice',
      message: `Are you sure you want to delete invoice "${invoice.invoice_number}"? This action cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    setDeleting(true);
    try {
      const { error } = await supabase.rpc('delete_purchase_invoice', { p_id: invoice.id });
      if (error) throw error;

      showToast({ type: 'success', title: 'Deleted', message: 'Purchase invoice deleted successfully.' });
      loadInvoices();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Error', message: `Error: ${error.message}` });
    } finally {
      setDeleting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!canManage) {
      showToast({ type: 'error', title: 'Error', message: 'You do not have permission to manage purchase invoices' });
      return;
    }

    if (!formData.supplier_id) {
      showToast({ type: 'error', title: 'Error', message: 'Please select a supplier' });
      return;
    }

    if (lineItems.length === 0 || lineItems.every(item => item.line_total === 0)) {
      showToast({ type: 'error', title: 'Error', message: 'Please add at least one line item' });
      return;
    }

    // Validate exchange rate for USD
    if (formData.currency === 'USD' && formData.exchange_rate <= 1) {
      showToast({ type: 'error', title: 'Error', message: 'Please enter a valid exchange rate for USD' });
      return;
    }

    // Validate required fields per item type
    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];
      if (item.item_type === 'inventory' && !item.product_id) {
        showToast({ type: 'error', title: 'Error', message: `Line ${i + 1}: Please select a product for inventory items` });
        return;
      }
      if (item.item_type === 'expense' && !item.expense_account_id) {
        showToast({ type: 'error', title: 'Error', message: `Line ${i + 1}: Please select an expense account` });
        return;
      }
      if (item.item_type === 'fixed_asset' && !item.asset_account_id) {
        showToast({ type: 'error', title: 'Error', message: `Line ${i + 1}: Please select an asset account` });
        return;
      }
      if (item.item_type !== 'inventory' && !item.description.trim()) {
        showToast({ type: 'error', title: 'Error', message: `Line ${i + 1}: Please enter a description` });
        return;
      }
      if (item.purchase_order_item_id && selectedPurchaseOrder?.purchase_order_items) {
        const poItem = selectedPurchaseOrder.purchase_order_items.find(
          candidate => candidate.id === item.purchase_order_item_id
        );
        if (poItem) {
          if (poItem.product_id && item.product_id && poItem.product_id !== item.product_id) {
            showToast({ type: 'error', title: 'Error', message: `Line ${i + 1}: Product does not match the linked Purchase Order line` });
            return;
          }
          if (
            poItem.unit &&
            item.unit &&
            poItem.unit.trim().toLowerCase() !== item.unit.trim().toLowerCase()
          ) {
            showToast({
              type: 'error',
              title: 'Error',
              message: `Line ${i + 1}: Unit (${item.unit}) does not match the linked Purchase Order line unit (${poItem.unit})`,
            });
            return;
          }
        }
      }
    }

    const totals = calculateTotals();

    try {
      const { data: userData } = await supabase.auth.getUser();
      // During edit, retain the invoice's persisted PO when the PO selector
      // has not finished rehydrating yet. This prevents an otherwise-unchanged
      // relationship being serialized as null.
      const effectivePurchaseOrderId = purchaseOrderId || editingInvoice?.purchase_order_id || null;

      const invoiceData = {
        invoice_number: formData.invoice_number.trim(),
        supplier_id: formData.supplier_id,
        invoice_date: formData.invoice_date,
        due_date: formData.due_date || null,
        currency: formData.currency,
        exchange_rate: formData.exchange_rate,
        subtotal: totals.subtotal,
        tax_amount: totals.ppnAmount,
        stamp_duty_amount: totals.stampDutyAmount,
        total_amount: totals.total,
        faktur_pajak_number: formData.faktur_pajak_number.trim() || null,
        notes: formData.notes.trim() || null,
        document_urls: formData.document_urls,
        requires_faktur_pajak: selectedSupplier?.pkp_status || false,
        ...(effectivePurchaseOrderId ? { purchase_order_id: effectivePurchaseOrderId } : {}),
      };

      const itemsData = lineItems.map(item => ({
        ...(item.id ? { id: item.id } : {}),
        item_type: item.item_type,
        product_id: item.product_id,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: item.unit_price,
        line_total: item.line_total,
        tax_amount: 0,
        expense_account_id: item.expense_account_id,
        asset_account_id: item.asset_account_id,
        receiving_make_id: item.receiving_make_id || null,
        receiving_batch_number: item.receiving_batch_number || null,
        batch_id: item.batch_id || null,
        receiving_expiry_date: item.receiving_expiry_date || null,
        receiving_import_container_id: item.receiving_import_container_id || null,
        receiving_notes: item.receiving_notes || null,
        ...(effectivePurchaseOrderId ? { purchase_order_item_id: item.purchase_order_item_id || null } : {}),
      }));

      const { error: rpcError } = await supabase.rpc('save_purchase_invoice_with_receiving_details', {
        p_invoice_id: editingInvoice ? editingInvoice.id : null,
        p_purchase_order_id: effectivePurchaseOrderId,
        p_invoice_data: invoiceData,
        p_items: itemsData,
      });
      if (rpcError) throw rpcError;

      showToast({
        type: 'success',
        title: editingInvoice ? 'Updated' : 'Success',
        message: editingInvoice
          ? 'Purchase invoice updated successfully!'
          : 'Purchase invoice created successfully!',
      });

      resetForm();
      setPurchaseOrderId(null);
      setEditingInvoice(null);
      setModalOpen(false);
      loadInvoices();
    } catch (error: any) {
      console.error('Error saving purchase invoice:', error);
      showToast({ type: 'error', title: 'Error', message: `Error: ${error.message}` });
    }
  };

  const handleFileUpload = async (files: File[]) => {
    setUploading(true);
    try {
      const uploadedUrls: string[] = [];
      let extractedDraft: ExtractedPurchaseInvoice | null = null;

      for (const file of files) {
        const fileExt = file.name.split('.').pop();
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
        const filePath = `purchase-invoices/${fileName}`;

        const { error: uploadError } = await uploadOptimizedFile(
          supabase,
          'documents',
          filePath,
          file
        );

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('documents')
          .getPublicUrl(filePath);

        uploadedUrls.push(publicUrl);
        if (!extractedDraft && file.type === 'application/pdf') {
          setPdfExtracting(true);
          try {
            extractedDraft = await extractPurchaseInvoicePdf(file);
          } catch (extractError) {
            console.warn('Supplier invoice PDF extraction unavailable:', extractError);
            showToast({ type: 'error', title: 'PDF extraction unavailable', message: 'The PDF was attached. Please enter the invoice details manually.' });
          } finally {
            setPdfExtracting(false);
          }
        }
      }

      setFormData(prev => ({
        ...prev,
        document_urls: [...prev.document_urls, ...uploadedUrls],
      }));
      if (extractedDraft) applyExtractedPurchaseInvoice(extractedDraft);
    } catch (error: any) {
      console.error('Error uploading files:', error);
      showToast({ type: 'error', title: 'Error', message: `Error uploading files: ${error.message}` });
    } finally {
      setUploading(false);
    }
  };

  const normaliseMatchText = (value: string | null | undefined) => (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const applyExtractedPurchaseInvoice = (draft: ExtractedPurchaseInvoice) => {
    const supplierCandidates = draft.supplierName
      ? suppliers.filter(s => normaliseMatchText(s.company_name) === normaliseMatchText(draft.supplierName))
      : [];
    const matchedSupplier = formData.supplier_id || (supplierCandidates.length === 1 ? supplierCandidates[0].id : '');
    if (draft.supplierName && formData.supplier_id) {
      const selectedSupplierName = suppliers.find(s => s.id === formData.supplier_id)?.company_name;
      if (selectedSupplierName && normaliseMatchText(selectedSupplierName) !== normaliseMatchText(draft.supplierName)) {
        showToast({ type: 'error', title: 'Supplier mismatch', message: `PDF supplier is ${draft.supplierName}; your selected supplier was preserved.` });
      }
    }
    setPdfExtraction(draft);
    setFormData(prev => ({
      ...prev,
      supplier_id: matchedSupplier || prev.supplier_id,
      invoice_number: draft.invoiceNumber || prev.invoice_number,
      invoice_date: draft.invoiceDate || prev.invoice_date,
      due_date: draft.dueDate || prev.due_date,
      currency: draft.currency || prev.currency,
      exchange_rate: draft.exchangeRate || prev.exchange_rate,
      faktur_pajak_number: draft.taxNumber || prev.faktur_pajak_number,
    }));
    if (draft.taxAmount && draft.subtotal) {
      const rate = Math.round((draft.taxAmount / draft.subtotal) * 100);
      if (rate === 11) setPpnRate(11);
    }

    const selectedPo = purchaseOrderId
      ? supplierPurchaseOrders.find(po => po.id === purchaseOrderId)
      : undefined;
    const matchedPo = !selectedPo && draft.poNumber
      ? supplierPurchaseOrders.find(po => normaliseMatchText(po.po_number) === normaliseMatchText(draft.poNumber) && (!matchedSupplier || po.supplier_id === matchedSupplier))
      : undefined;
    const poForLineMapping = selectedPo || matchedPo;
    if (matchedPo) {
      setPurchaseOrderId(matchedPo.id);
      setFormData(prev => ({ ...prev, notes: prev.notes || `Created from PO ${matchedPo.po_number}` }));
    }

    // PDF extraction is additive: never replace lines the user has already
    // entered (or an existing PI's persisted relationships). Populate lines
    // automatically only for a genuinely blank form.
    if (draft.lines.length > 0 && lineItems.length === 0) {
      const mappedLines = draft.lines.map((line, index) => {
        const candidates = products.filter(product => normaliseMatchText(product.product_name) === normaliseMatchText(line.description));
        const product = candidates.length === 1 ? candidates[0] : undefined;
        const poItem = (poForLineMapping?.purchase_order_items || []).find(item => product?.id === item.product_id);
        const existingLine = lineItems[index];
        const quantity = line.quantity || 0;
        const unitPrice = line.unitPrice || 0;
        return {
          item_type: 'inventory' as const,
          // Keep an existing PO-line link when PDF matching is uncertain;
          // the user can still review the Product cell before saving.
          purchase_order_item_id: poItem?.id || existingLine?.purchase_order_item_id || null,
          receiving_make_id: poItem?.make_id || existingLine?.receiving_make_id || null,
          product_id: product?.id || null,
          product_name: product?.product_name,
          description: line.description,
          receiving_batch_number: line.batchNumber || null,
          receiving_expiry_date: line.expiryDate || null,
          quantity,
          unit: line.unit || product?.unit || 'pcs',
          unit_price: unitPrice,
          line_total: line.lineTotal ?? quantity * unitPrice,
          expense_account_id: null,
          asset_account_id: null,
        };
      });
      setLineItems(mappedLines);
    }

    if (draft.poNumber && selectedPo) {
      const selected = selectedPo;
      if (selected && normaliseMatchText(selected.po_number) !== normaliseMatchText(draft.poNumber)) {
        showToast({ type: 'error', title: 'PO mismatch', message: `PDF references ${draft.poNumber}, but the selected PO is ${selected.po_number}. Your selection was preserved.` });
      }
    }
    showToast({ type: 'success', title: 'Draft extracted', message: 'Review the highlighted invoice details before creating the Purchase Invoice.' });
  };

  const handleRemoveDocument = (index: number) => {
    setFormData(prev => ({
      ...prev,
      document_urls: prev.document_urls.filter((_, i) => i !== index),
    }));
  };

  const resetForm = () => {
    setPurchaseOrderId(null);
    setFormData({
      invoice_number: '',
      supplier_id: '',
      invoice_date: new Date().toISOString().split('T')[0],
      due_date: '',
      currency: 'IDR',
      exchange_rate: 1,
      faktur_pajak_number: '',
      notes: '',
      document_urls: [],
    });
    setPpnRate(0);
    setStampDutyAmount(0);
    setLineItems([
      {
        item_type: 'inventory',
        product_id: null,
        description: '',
        quantity: 1,
        unit: 'pcs',
        unit_price: 0,
        line_total: 0,
        expense_account_id: null,
        asset_account_id: null,
      },
    ]);
  };

  const filteredInvoices = invoices.filter(inv =>
    inv.invoice_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
    inv.suppliers?.company_name?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const totals = calculateTotals();
  const receivingAlreadyReceived = receivingItem?.id
    ? receivingAllocations
      .filter(a => a.purchase_invoice_item_id === receivingItem.id)
      .reduce((sum, allocation) => sum + Number(allocation.received_quantity), 0)
    : 0;
  const receivingRemaining = receivingItem
    ? Math.max(0, Number(receivingItem.quantity) - receivingAlreadyReceived)
    : 0;

  if (loading) {
    return <div className="p-8 text-center">Loading...</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Consolidated single-line header toolbar: Purchase Invoices | Search | + New Purchase Invoice */}
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 bg-white border border-gray-200 rounded-lg min-h-[42px] flex-wrap sm:flex-nowrap">
        <div className="flex items-center gap-2 shrink-0">
          <h1 className="text-sm font-semibold text-gray-900 whitespace-nowrap">{t('purchaseInvoices.title', 'Purchase Invoices')}</h1>
        </div>
        <div className="relative flex-1 max-w-md min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 w-3.5 h-3.5" />
          <input
            name="search_term"
            aria-label={t('common.searchPlaceholder', 'Search by invoice number or supplier...')}
            type="text"
            placeholder={t('common.searchPlaceholder', 'Search by invoice number or supplier...')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ paddingLeft: '2rem' }}
            className="w-full h-8 pr-2.5 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => { resetForm(); setModalOpen(true); }}
            className="inline-flex items-center gap-1.5 h-8 px-3 bg-blue-600 text-white rounded-md text-xs font-medium hover:bg-blue-700 transition-colors shadow-xs whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t('purchaseInvoices.newInvoice', 'New Purchase Invoice')}</span>
          </button>
        )}
      </div>

      {/* Desktop Table View (>= 768px) */}
      <div className="hidden md:block bg-white rounded-lg shadow overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                {t('purchaseInvoices.invoiceNumber', 'Invoice #')}
              </th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                {t('purchaseInvoices.supplier', 'Supplier')}
              </th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                {t('purchaseInvoices.invoiceDate', 'Date')}
              </th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                {t('purchaseInvoices.currency', 'Currency')}
              </th>
              <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                {t('purchaseInvoices.total', 'Total')}
              </th>
              <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                {t('purchaseInvoices.balanceDue', 'Balance')}
              </th>
              <th className="px-3 py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                {t('purchaseInvoices.status', 'Status')}
              </th>
              <th className="px-3 py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                {t('common.actions', 'Actions')}
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filteredInvoices.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-6 py-12 text-center text-gray-500">
                  {t('purchaseInvoices.noItems', 'No purchase invoices found. Create your first one!')}
                </td>
              </tr>
            ) : (
              filteredInvoices.map((invoice) => (
                <tr key={invoice.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 whitespace-nowrap text-xs font-mono font-bold text-gray-900">
                    {invoice.invoice_number}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-900 font-medium">
                    {invoice.suppliers?.company_name || '—'}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
                    {formatDate(invoice.invoice_date)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-600">
                    <span className="font-medium">{invoice.currency}</span>
                    {invoice.currency === 'USD' && (
                      <span className="text-[11px] text-gray-400 ml-1">
                        @ {invoice.exchange_rate.toLocaleString()}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs font-mono font-bold text-right text-gray-900">
                    {formatCurrency(invoice.total_amount, invoice.currency)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs font-mono font-bold text-right">
                    <span className={invoice.balance_amount > 0 ? 'text-red-600' : 'text-emerald-600'}>
                      {formatCurrency(invoice.balance_amount, invoice.currency)}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-center">
                    <FinanceBadge status={invoice.status === 'paid' ? 'paid' : invoice.status === 'partial' ? 'partial' : 'unpaid'}>
                      {invoice.status}
                    </FinanceBadge>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-center text-xs">
                    <div className="flex items-center justify-center gap-1.5 whitespace-nowrap">
                      <FinanceActionButton action="view" label="View Details" onClick={() => handleOpenView(invoice)} />
                      {canManage && (
                        <FinanceActionButton action="edit" onClick={() => handleOpenEdit(invoice)} />
                      )}
                      {canManage && (!invoice.receiving_approval_status || invoice.receiving_approval_status === 'draft' || invoice.receiving_approval_status === 'rejected') && (
                        <button onClick={() => void updateReceivingApproval(invoice, 'submit')} className="text-blue-600 hover:text-blue-800 text-xs px-1.5 py-0.5 rounded bg-blue-50" title="Submit for inward approval">Submit</button>
                      )}
                      {canManage && invoice.receiving_approval_status === 'pending_approval' && (
                        <button onClick={() => void updateReceivingApproval(invoice, 'approve')} className="text-green-600 hover:text-green-800 text-xs px-1.5 py-0.5 rounded bg-green-50" title="Approve for inward">Approve</button>
                      )}
                      {canManage && onPayInvoice && invoice.status !== 'paid' && invoice.balance_amount > 0 && (
                        <button
                          onClick={() => onPayInvoice({ id: invoice.id, invoice_number: invoice.invoice_number, supplier_id: invoice.supplier_id, balance_amount: invoice.balance_amount })}
                          className="text-green-600 hover:text-green-800 p-1 rounded hover:bg-green-50"
                          title="Record Payment"
                        >
                          <CreditCard className="w-4 h-4" />
                        </button>
                      )}
                      {canManage && (
                        <FinanceActionButton action="delete" onClick={() => handleDelete(invoice)} disabled={deleting} />
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile App-Style Card View (< 768px) - High Density 3-Line Format */}
      <div className="block md:hidden p-2 space-y-1.5" data-testid="purchase-invoices-mobile-list">
        {filteredInvoices.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500 text-xs">
            {t('purchaseInvoices.noItems', 'No purchase invoices found. Create your first one!')}
          </div>
        ) : (
          filteredInvoices.map((invoice) => {
            const isExpanded = expandedInvoiceIds.has(invoice.id);

            return (
              <div
                key={invoice.id}
                onClick={() => toggleExpandInvoice(invoice.id)}
                className="bg-white rounded-xl border border-slate-200/90 p-2.5 space-y-1 shadow-2xs hover:border-slate-300 transition active:scale-[0.99] cursor-pointer"
              >
                {/* Line 1: Invoice # + Status Badge + Actions */}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="font-mono font-bold text-xs text-gray-900 truncate">
                      {invoice.invoice_number}
                    </span>
                    <FinanceBadge status={invoice.status === 'paid' ? 'paid' : invoice.status === 'partial' ? 'partial' : 'unpaid'}>
                      {t(`purchaseInvoices.statuses.${invoice.status}`, invoice.status)}
                    </FinanceBadge>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => handleOpenView(invoice)}
                      className="p-1 text-slate-500 hover:text-slate-800 rounded active:bg-slate-100 min-h-[32px] min-w-[32px] flex items-center justify-center"
                      title={t('common.view', 'View Invoice')}
                      aria-label={t('common.view', 'View Invoice')}
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => handleOpenEdit(invoice)}
                        className="p-1 text-blue-600 hover:text-blue-800 rounded active:bg-blue-50 min-h-[32px] min-w-[32px] flex items-center justify-center"
                        title={t('common.edit', 'Edit Invoice')}
                        aria-label={t('common.edit', 'Edit Invoice')}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => toggleExpandInvoice(invoice.id)}
                      className="p-1 text-slate-400 hover:text-slate-600 rounded active:bg-slate-100 min-h-[32px] min-w-[32px] flex items-center justify-center"
                      title={isExpanded ? 'Collapse' : 'Expand'}
                      aria-label={isExpanded ? 'Collapse' : 'Expand'}
                    >
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                    </button>
                  </div>
                </div>

                {/* Line 2: Supplier Name + Date */}
                <div className="flex items-center justify-between text-xs text-gray-600 gap-2">
                  <span className="font-medium text-gray-800 truncate min-w-0 flex-1">
                    {invoice.suppliers?.company_name || '—'}
                  </span>
                  <span className="text-[11px] text-gray-400 font-normal shrink-0">
                    {formatDate(invoice.invoice_date)}
                  </span>
                </div>

                {/* Line 3: Total Amount + Balance Due */}
                <div className="flex items-center justify-between pt-1 border-t border-slate-100 text-xs gap-2">
                  <span className="font-mono font-bold text-xs text-gray-900 truncate">
                    {formatCurrency(invoice.total_amount, invoice.currency)}
                  </span>
                  <span className={`font-mono text-xs font-semibold shrink-0 text-right ${
                    invoice.balance_amount > 0 ? 'text-red-600' : 'text-emerald-600'
                  }`}>
                    {invoice.balance_amount > 0 ? `${t('purchaseInvoices.balanceDue', 'Due')}: ${formatCurrency(invoice.balance_amount, invoice.currency)}` : t('purchaseInvoices.settled', 'Settled')}
                  </span>
                </div>

                {/* Expandable Drawer: Currency Details & Actions */}
                {isExpanded && (
                  <div
                    className="mt-2 pt-2 border-t border-dashed border-slate-200 bg-slate-50/70 p-2 rounded-lg text-xs space-y-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <span className="text-[10px] uppercase font-semibold text-gray-400 block">{t('purchaseInvoices.currency', 'Currency')} / {t('purchaseInvoices.exchangeRate', 'Rate')}</span>
                        <span className="text-gray-700 font-medium">
                          {invoice.currency} {invoice.currency === 'USD' ? `@ ${invoice.exchange_rate.toLocaleString()}` : ''}
                        </span>
                      </div>
                      <div>
                        <span className="text-[10px] uppercase font-semibold text-gray-400 block">{t('purchaseInvoices.receiving', 'Inward Status')}</span>
                        <span className="text-gray-700 font-medium capitalize">
                          {invoice.receiving_approval_status || 'Draft'}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 pt-1.5 border-t border-slate-200/80">
                      {canManage && onPayInvoice && invoice.status !== 'paid' && invoice.balance_amount > 0 && (
                        <button
                          type="button"
                          onClick={() => onPayInvoice({ id: invoice.id, invoice_number: invoice.invoice_number, supplier_id: invoice.supplier_id, balance_amount: invoice.balance_amount })}
                          className="flex-1 min-h-[32px] inline-flex items-center justify-center gap-1 px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-lg text-xs font-semibold transition"
                        >
                          <CreditCard className="w-3.5 h-3.5 text-emerald-600" />
                          <span>{t('paymentVouchers.pay', 'Pay')}</span>
                        </button>
                      )}
                      {canManage && (!invoice.receiving_approval_status || invoice.receiving_approval_status === 'draft' || invoice.receiving_approval_status === 'rejected') && (
                        <button
                          type="button"
                          onClick={() => void updateReceivingApproval(invoice, 'submit')}
                          className="flex-1 min-h-[32px] inline-flex items-center justify-center px-2 py-1 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded-lg text-xs font-semibold transition"
                        >
                          {t('purchaseInvoices.submitInward', 'Submit Inward')}
                        </button>
                      )}
                      {canManage && invoice.receiving_approval_status === 'pending_approval' && (
                        <button
                          type="button"
                          onClick={() => void updateReceivingApproval(invoice, 'approve')}
                          className="flex-1 min-h-[32px] inline-flex items-center justify-center px-2 py-1 bg-green-50 hover:bg-green-100 text-green-700 rounded-lg text-xs font-semibold transition"
                        >
                          {t('purchaseInvoices.approveInward', 'Approve Inward')}
                        </button>
                      )}
                      {canManage && (
                        <button
                          type="button"
                          onClick={() => handleDelete(invoice)}
                          disabled={deleting}
                          className="min-h-[32px] px-2.5 inline-flex items-center justify-center gap-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-xs font-semibold transition ml-auto"
                          title={t('common.delete', 'Delete Invoice')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>{t('common.delete', 'Delete')}</span>
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

      {/* Create/Edit Modal */}
      <FinanceModal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); setEditingInvoice(null); resetForm(); }}
        title={editingInvoice ? `${t('purchaseInvoices.editInvoice', 'Edit Invoice')}: ${editingInvoice.invoice_number}` : t('purchaseInvoices.newInvoice', 'New Purchase Invoice')}
        size="xl"
        maxWidth="max-w-[90vw]"
        footer={
          <>
            <button
              type="button"
              onClick={() => { setModalOpen(false); setEditingInvoice(null); resetForm(); }}
              className={F_BTN_SECONDARY}
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              form="purchase-invoice-form"
              disabled={uploading}
              className={`${F_BTN_PRIMARY} disabled:opacity-50`}
            >
              {uploading ? t('purchaseInvoices.uploading', 'Uploading...') : editingInvoice ? t('purchaseInvoices.saveChanges', 'Save Changes') : t('purchaseInvoices.createInvoice', 'Create Invoice')}
            </button>
          </>
        }
      >
        <form id="purchase-invoice-form" onSubmit={handleSubmit} className="flex flex-col gap-1">
          {/* Supplier needs the working width; currency is intentionally compact. */}
          <div className="grid grid-cols-[minmax(0,7fr)_minmax(110px,3fr)] gap-2">
            <div>
              <label className="mb-0.5 flex items-center justify-between text-xs font-medium text-gray-700">
                <span>{t('purchaseInvoices.supplier', 'Supplier')} <span className="text-red-500">*</span></span>
                {selectedSupplier?.npwp && <span className="text-[9px] text-gray-500">NPWP: {selectedSupplier.npwp}</span>}
              </label>
              <SearchableSelect
                value={formData.supplier_id}
                onChange={handleSupplierChange}
                options={suppliers.map(s => ({ value: s.id, label: `${s.company_name}${s.pkp_status ? ' (PKP)' : ''}` }))}
                placeholder={t('purchaseInvoices.selectSupplier', 'Select Supplier')}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-0.5">
                {t('purchaseInvoices.currency', 'Currency')} <span className="text-red-500">*</span>
              </label>
              <select name="currency" aria-label={t('purchaseInvoices.currency', 'Currency')} value={formData.currency}
                onChange={(e) => setFormData({ ...formData, currency: e.target.value, exchange_rate: e.target.value === 'IDR' ? 1 : formData.exchange_rate })}
                className={SAP_INPUT}>
                <option value="IDR">IDR</option>
                <option value="USD">USD</option>
              </select>
            </div>
          </div>

          {formData.supplier_id && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-0.5">{t('purchaseOrders.title', 'Purchase Order')} ({t('common.optional', 'optional')})</label>
              <select name="purchase_order_optional" aria-label={t('purchaseOrders.title', 'Purchase Order')}
                value={purchaseOrderId || ''}
                onChange={(e) => handlePurchaseOrderChange(e.target.value)}
                disabled={loadingSupplierPurchaseOrders}
                className={SAP_INPUT}
              >
                <option value="">No PO — standalone supplier invoice</option>
                {supplierPurchaseOrders.map(po => (
                  <option
                    key={po.id}
                    value={po.id}
                    hidden={Boolean(purchaseOrderId && po.id === purchaseOrderId)}
                  >
                    {po.po_number} · {po.po_date} · {po.status}
                  </option>
                ))}
              </select>
              {purchaseOrderId && supplierPurchaseOrders.find(po => po.id === purchaseOrderId) && (
                <p className="mt-0.5 text-[10px] font-medium text-blue-700">
                  PO: {supplierPurchaseOrders.find(po => po.id === purchaseOrderId)?.po_number}
                </p>
              )}
              {loadingSupplierPurchaseOrders && <p className="mt-0.5 text-[10px] text-gray-400">Loading supplier POs…</p>}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)] gap-3 items-start">
            <div className="grid grid-cols-12 gap-2">
              <FloatingField label={t('purchaseInvoices.invoiceNumber', 'Invoice #')} required span={4} filled={!!formData.invoice_number}>
                <input name="invoice_number" aria-label="INV-001" type="text" value={formData.invoice_number}
                  onChange={(e) => setFormData({ ...formData, invoice_number: e.target.value })}
                  required placeholder="INV-001" className={FLOAT_INPUT} />
              </FloatingField>
              <FloatingField label={t('purchaseInvoices.invoiceDate', 'Inv Date')} required span={4} filled={!!formData.invoice_date}>
                <input name="invoice_date" aria-label={t('purchaseInvoices.invoiceDate', 'Invoice Date')} type="date" value={formData.invoice_date}
                  onChange={(e) => setFormData({ ...formData, invoice_date: e.target.value })}
                  required className={FLOAT_INPUT} />
              </FloatingField>
              <FloatingField label={t('purchaseInvoices.dueDate', 'Due Date')} span={4} filled={!!formData.due_date}>
                <input name="due_date" aria-label={t('purchaseInvoices.dueDate', 'Due Date')} type="date" value={formData.due_date}
                  onChange={(e) => setFormData({ ...formData, due_date: e.target.value })}
                  className={FLOAT_INPUT} />
              </FloatingField>

              {formData.currency === 'USD' && (
                <FloatingField label={`${t('purchaseInvoices.exchangeRate', 'Rate')} (USD)`} required span={4} filled={!!formData.exchange_rate}>
                  <input name="exchange_rate" aria-label="15750" type="number" value={formData.exchange_rate}
                    onChange={(e) => setFormData({ ...formData, exchange_rate: parseFloat(e.target.value) || 1 })}
                    min="1" step="0.01" required placeholder="15750"
                    className={FLOAT_INPUT + ' !text-right !font-mono'} />
                </FloatingField>
              )}

              {selectedSupplier?.pkp_status && (
                <FloatingField label="Faktur Pajak" span={formData.currency === 'USD' ? 8 : 12} filled={!!formData.faktur_pajak_number}>
                  <input name="faktur_pajak_number" aria-label="010.000-00.00000000" type="text" value={formData.faktur_pajak_number}
                    onChange={(e) => setFormData({ ...formData, faktur_pajak_number: e.target.value })}
                    placeholder="010.000-00.00000000" className={FLOAT_INPUT + ' !font-mono'} />
                </FloatingField>
              )}
            </div>

            <div className="space-y-2">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-0.5">{t('salesOrders.notes', 'Notes')}</label>
                <input name="notes" aria-label="Notes" type="text" value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className={SAP_INPUT} placeholder="Supplier invoice notes..." />
              </div>
            </div>
          </div>

          {/* Line Items Section */}
          <div className="border-t pt-2">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold text-gray-600 uppercase tracking-wide">{t('purchaseInvoices.lineItems', 'Line Items')}</h3>
              <button
                type="button"
                onClick={handleAddLine}
                className="inline-flex items-center gap-1 h-7 px-2 text-xs font-semibold bg-blue-600 text-white rounded hover:bg-blue-700 min-h-[30px]"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('purchaseInvoices.addLine', 'Add Line')}
              </button>
            </div>

            <div className="max-h-[46vh] overflow-y-auto pr-1">
              {/* Desktop Inventory Table */}
              <div className="hidden md:block overflow-x-auto rounded border border-gray-200 mb-2">
                <table className="min-w-[980px] w-full text-xs">
                  <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500"><tr>
                    <th className="px-2 py-1.5 text-left">{t('purchaseInvoices.product', 'Product')}</th>
                    <th className="px-2 py-1.5 text-left">{t('purchaseInvoices.make', 'Make')}</th>
                    <th className="px-2 py-1.5 text-left">{t('purchaseInvoices.batchNumber', 'Batch No.')}</th>
                    <th className="px-2 py-1.5 text-left">{t('purchaseInvoices.expiryDate', 'Expiry')}</th>
                    <th className="px-2 py-1.5 text-right">{t('purchaseInvoices.quantity', 'Qty')}</th>
                    <th className="px-2 py-1.5 text-left">{t('purchaseInvoices.unit', 'UOM')}</th>
                    <th className="px-2 py-1.5 text-right">{t('purchaseInvoices.unitPrice', 'Unit Price')}</th>
                    <th className="px-2 py-1.5 text-right">{t('purchaseInvoices.total', 'Total')}</th>
                    <th className="px-2 py-1.5" />
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">{lineItems.map((item, index) => item.item_type === 'inventory' && <tr key={`inventory-${index}`}>
                    <td className="px-2 py-1"><select name="product_id" aria-label="Product Id" value={item.product_id || ''} onChange={(e) => handleLineChange(index, 'product_id', e.target.value)} className="w-44 px-1.5 py-1 border border-gray-300 rounded"><option value="">{t('purchaseInvoices.reviewProduct', 'Review Product')}</option>{item.product_id && item.product_name && !products.some(product => product.id === item.product_id) && <option value={item.product_id}>{item.product_name}</option>}{products.map(product => <option key={product.id} value={product.id}>{product.product_name}</option>)}</select>{!item.product_id && item.description && <div className="mt-0.5 max-w-44 truncate text-[10px] text-gray-400" title={item.description}>Supplier description: {item.description}</div>}</td>
                    <td className="px-2 py-1"><select name="receiving_make_id" aria-label="Receiving Make Id" value={item.receiving_make_id || ''} onChange={(e) => handleLineChange(index, 'receiving_make_id', e.target.value || null)} className="w-36 px-1.5 py-1 border border-gray-300 rounded"><option value="">{t('purchaseInvoices.notSpecified', 'Not specified')}</option>{productSources.filter(source => source.product_id === item.product_id).map(source => <option key={source.id} value={source.id}>{source.supplier_name || 'Unnamed'}{source.grade ? ` (${source.grade})` : ''}</option>)}</select>{(() => { const poItem = selectedPurchaseOrder?.purchase_order_items?.find(candidate => candidate.id === item.purchase_order_item_id); if (!poItem) return null; const matches = poItem.make_id === (item.receiving_make_id || null); return <div className={`mt-0.5 text-[9px] font-medium ${matches ? 'text-green-700' : 'text-amber-700'}`}>PO Make: {!poItem.make_id ? 'Not recorded' : matches ? 'Matched' : 'Review'}</div>; })()}</td>
                    <td className="px-2 py-1">
                      <input
                        name="receiving_batch_number"
                        aria-label="Optional"
                        value={item.receiving_batch_number || ''}
                        onChange={(e) => handleLineChange(index, 'receiving_batch_number', e.target.value || null)}
                        className="w-28 px-1.5 py-1 border border-gray-300 rounded"
                        placeholder="Optional"
                        list={`batch-options-${index}`}
                        autoComplete="off"
                      />
                      <datalist id={`batch-options-${index}`}>
                        {productBatches
                          .filter(b => !item.product_id || b.product_id === item.product_id)
                          .map(b => (
                            <option key={b.id} value={b.batch_number} />
                          ))}
                      </datalist>
                    </td>
                    <td className="px-2 py-1"><input name="receiving_expiry_date" aria-label="Receiving Expiry Date" type="date" value={item.receiving_expiry_date || ''} onChange={(e) => handleLineChange(index, 'receiving_expiry_date', e.target.value || null)} className="w-32 px-1.5 py-1 border border-gray-300 rounded" /></td>
                    <td className="px-2 py-1"><input name="quantity" aria-label="Quantity" type="number" min="0" step="0.01" value={item.quantity} onChange={(e) => handleLineChange(index, 'quantity', parseFloat(e.target.value) || 0)} className="w-20 px-1.5 py-1 text-right border border-gray-300 rounded" /></td>
                    <td className="px-2 py-1"><input name="unit" aria-label="Unit" value={item.unit} onChange={(e) => handleLineChange(index, 'unit', e.target.value)} className="w-16 px-1.5 py-1 border border-gray-300 rounded" /></td>
                    <td className="px-2 py-1"><MoneyInput decimal value={item.unit_price} onChange={(n) => handleLineChange(index, 'unit_price', n)} className="w-24 px-1.5 py-1 text-right border border-gray-300 rounded" /></td>
                    <td className="px-2 py-1 text-right font-medium">{item.line_total.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right">{lineItems.length > 1 && <button type="button" onClick={() => handleRemoveLine(index)} className="text-red-600"><X className="w-3.5 h-3.5" /></button>}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              {/* Responsive Cards (Mobile: all lines; Desktop: non-inventory lines) */}
              {lineItems.map((item, index) => (
                <div key={index} className={`${item.item_type === 'inventory' ? 'block md:hidden border border-gray-200 rounded p-2.5 space-y-2 bg-slate-50/50 mb-2' : 'border border-gray-200 rounded p-2.5 space-y-2 mb-2'}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">{t('purchaseInvoices.lineItems', 'Line')} {index + 1}</span>
                    {lineItems.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveLine(index)}
                        className="p-1 text-red-600 hover:text-red-800 hover:bg-red-50 rounded min-h-[32px] min-w-[32px] flex items-center justify-center"
                        title={t('common.delete', 'Remove line')}
                        aria-label={t('common.delete', 'Remove line')}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
                        {t('purchaseInvoices.itemType', 'Type')} *
                      </label>
                      <select name="type" aria-label={t('purchaseInvoices.itemType', 'Type')}
                        value={item.item_type}
                        onChange={(e) => handleLineChange(index, 'item_type', e.target.value)}
                        className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400 bg-white"
                      >
                        <option value="inventory">{t('purchaseInvoices.types.inventory', 'Inventory (Stock)')}</option>
                        <option value="fixed_asset">{t('purchaseInvoices.types.fixed_asset', 'Fixed Asset')}</option>
                        <option value="expense">{t('purchaseInvoices.types.expense', 'Expense')}</option>
                        <option value="freight">{t('purchaseInvoices.types.freight', 'Freight')}</option>
                        <option value="duty">{t('purchaseInvoices.types.duty', 'Customs Duty')}</option>
                        <option value="insurance">{t('purchaseInvoices.types.insurance', 'Insurance')}</option>
                        <option value="clearing">{t('purchaseInvoices.types.clearing', 'Clearing & Forwarding')}</option>
                        <option value="other">{t('purchaseInvoices.types.other', 'Other Cost')}</option>
                      </select>
                    </div>

                    {item.item_type === 'inventory' ? (
                      <div className="sm:col-span-2">
                        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
                          {t('purchaseInvoices.product', 'Product')} *
                        </label>
                        <select name="product" aria-label={t('purchaseInvoices.product', 'Product')}
                          value={item.product_id || ''}
                          onChange={(e) => handleLineChange(index, 'product_id', e.target.value)}
                          className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400 bg-white"
                        >
                          <option value="">{t('purchaseInvoices.reviewProduct', 'Select Product')}</option>
                          {item.product_id && item.product_name && !products.some(product => product.id === item.product_id) && (
                            <option value={item.product_id}>{item.product_name}</option>
                          )}
                          {products.map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.product_name} (Stock: {product.current_stock})
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : item.item_type === 'expense' ? (
                      <div className="col-span-2">
                        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
                          Expense Account *
                        </label>
                        <select name="expense_account" aria-label="Expense Account"
                          value={item.expense_account_id || ''}
                          onChange={(e) => handleLineChange(index, 'expense_account_id', e.target.value)}
                          className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400"
                        >
                          <option value="">Select Account</option>
                          {accounts.filter(a => a.account_type === 'Expense' || a.account_type === 'expense' || a.account_type === 'Cost of Goods Sold' || a.account_type === 'cost_of_goods_sold').map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.code} - {account.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : item.item_type === 'fixed_asset' ? (
                      <div className="col-span-2">
                        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
                          Asset Account *
                        </label>
                        <select name="asset_account" aria-label="Asset Account"
                          value={item.asset_account_id || ''}
                          onChange={(e) => handleLineChange(index, 'asset_account_id', e.target.value)}
                          className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400"
                        >
                          <option value="">Select Account</option>
                          {accounts.filter(a => a.account_type === 'Asset' || a.account_type === 'asset').map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.code} - {account.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div className="col-span-2">
                        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
                          Ledger (Optional - defaults to Inventory)
                        </label>
                        <select name="ledger_optional_defaults_to_in" aria-label="Ledger (Optional - defaults to Inventory)"
                          value={item.expense_account_id || ''}
                          onChange={(e) => handleLineChange(index, 'expense_account_id', e.target.value)}
                          className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400"
                        >
                          <option value="">Capitalize to Inventory (Default)</option>
                          {accounts.filter(a => a.account_type === 'Expense' || a.account_type === 'expense' || a.account_type === 'Cost of Goods Sold' || a.account_type === 'cost_of_goods_sold').map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.code} - {account.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
                      Description *
                    </label>
                    <input name="description" aria-label="Description"
                      type="text"
                      value={item.description}
                      onChange={(e) => handleLineChange(index, 'description', e.target.value)}
                      placeholder="Item description"
                      className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400"
                    />
                  </div>

                  {item.item_type === 'inventory' && (
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                      <div>
                        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">{t('purchaseInvoices.make', 'Make')}</label>
                        <select name="make" aria-label={t('purchaseInvoices.make', 'Make')} value={item.receiving_make_id || ''} onChange={(e) => handleLineChange(index, 'receiving_make_id', e.target.value || null)} className="w-full px-2 py-1 text-xs border border-gray-300 rounded bg-white">
                          <option value="">{t('purchaseInvoices.notSpecified', 'Not specified')}</option>
                          {productSources.filter(source => source.product_id === item.product_id).map(source => <option key={source.id} value={source.id}>{source.supplier_name || 'Unnamed make'}{source.grade ? ` (${source.grade})` : ''}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">{t('purchaseInvoices.batchNumber', 'Batch Number')}</label>
                        <input
                          name="batch_number"
                          aria-label={t('purchaseInvoices.batchNumber', 'Batch Number')}
                          value={item.receiving_batch_number || ''}
                          onChange={(e) => handleLineChange(index, 'receiving_batch_number', e.target.value || null)}
                          className="w-full px-2 py-1 text-xs border border-gray-300 rounded bg-white"
                          placeholder={t('common.optional', 'If provided')}
                          list={`mobile-batch-options-${index}`}
                          autoComplete="off"
                        />
                        <datalist id={`mobile-batch-options-${index}`}>
                          {productBatches
                            .filter(b => !item.product_id || b.product_id === item.product_id)
                            .map(b => (
                              <option key={b.id} value={b.batch_number} />
                            ))}
                        </datalist>
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">{t('purchaseInvoices.expiryDate', 'Expiry')}</label>
                        <input name="expiry" aria-label={t('purchaseInvoices.expiryDate', 'Expiry')} type="date" value={item.receiving_expiry_date || ''} onChange={(e) => handleLineChange(index, 'receiving_expiry_date', e.target.value || null)} className="w-full px-2 py-1 text-xs border border-gray-300 rounded bg-white" />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">{t('common.importContainer', 'Import Container')}</label>
                        <select name="import_container" aria-label={t('common.importContainer', 'Import Container')} value={item.receiving_import_container_id || ''} onChange={(e) => handleLineChange(index, 'receiving_import_container_id', e.target.value || null)} className="w-full px-2 py-1 text-xs border border-gray-300 rounded bg-white">
                          <option value="">{t('common.noneOrLocal', 'None / local')}</option>
                          {importContainers.map(container => <option key={container.id} value={container.id}>{container.container_ref}</option>)}
                        </select>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <div>
                      <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
                        {t('purchaseInvoices.quantity', 'Qty')} *
                      </label>
                      <input name="qty" aria-label={t('purchaseInvoices.quantity', 'Qty')}
                        type="number"
                        value={item.quantity}
                        onChange={(e) => handleLineChange(index, 'quantity', parseFloat(e.target.value) || 0)}
                        min="0"
                        step="0.01"
                        className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400 bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
                        {t('purchaseInvoices.unit', 'Unit')}
                      </label>
                      <input name="unit" aria-label={t('purchaseInvoices.unit', 'Unit')}
                        type="text"
                        value={item.unit}
                        onChange={(e) => handleLineChange(index, 'unit', e.target.value)}
                        placeholder="pcs"
                        className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400 bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
                        {t('purchaseInvoices.unitPrice', 'Rate')} *
                      </label>
                      <MoneyInput
                        decimal
                        value={item.unit_price}
                        onChange={(n) => handleLineChange(index, 'unit_price', n)}
                        placeholder="0.00"
                        className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400 bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
                        {t('purchaseInvoices.total', 'Amount')}
                      </label>
                      <input name="amount" aria-label={t('purchaseInvoices.total', 'Amount')}
                        type="text"
                        value={item.line_total.toLocaleString()}
                        readOnly
                        className="w-full px-2 py-1 text-xs border border-gray-200 rounded bg-gray-50 font-medium text-right"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Invoice-level Tax Footer */}
            <div className="mt-3 border-t pt-2 ml-auto w-full max-w-sm space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-gray-600">{t('purchaseInvoices.subtotal', 'Subtotal')}:</span>
                <span className="font-medium">{formatCurrency(totals.subtotal, formData.currency)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-gray-600">{t('purchaseInvoices.taxAmount', 'PPN')}:</span>
                  <select name="ppn_rate" aria-label="Ppn Rate"
                    value={ppnRate}
                    onChange={(e) => setPpnRate(Number(e.target.value))}
                    className="text-xs border border-gray-300 rounded px-1.5 py-0.5 focus:ring-1 focus:ring-blue-500 bg-white"
                  >
                    <option value={0}>None (0%)</option>
                    <option value={11}>11%</option>
                  </select>
                </div>
                <span className="font-medium">{formatCurrency(totals.ppnAmount, formData.currency)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-600">{t('purchaseInvoices.stampDuty', 'Bea Meterai')}:</span>
                <MoneyInput
                  value={stampDutyAmount}
                  onChange={(n) => setStampDutyAmount(n)}
                  placeholder="0"
                  className="w-28 text-right px-2 py-0.5 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 bg-white"
                />
              </div>
              <div className="flex justify-between text-sm font-bold border-t pt-1.5">
                <span>{t('purchaseInvoices.total', 'Total')}:</span>
                <span className="text-blue-600">{formatCurrency(totals.total, formData.currency)}</span>
              </div>
              {formData.currency === 'USD' && formData.exchange_rate > 1 && (
                <div className="flex justify-between text-xs text-gray-500">
                  <span>Equivalent (IDR):</span>
                  <span>IDR {(totals.total * formData.exchange_rate).toLocaleString()}</span>
                </div>
              )}
            </div>

            <div className="mt-3 border-t pt-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-gray-700">Supplier Invoice Documents</span>
                {formData.document_urls.length > 0 && <span className="text-[10px] text-gray-400">{formData.document_urls.length} file(s)</span>}
              </div>
              <FileUpload
                compact
                disabled={uploading}
                onUpload={handleFileUpload}
                accept=".pdf,.jpg,.jpeg,.png"
                multiple
              />
              {pdfExtracting && <p className="mt-1 text-[10px] text-blue-600">Reading supplier invoice PDF…</p>}
              {pdfExtraction && !pdfExtracting && (
                <div className="mt-1 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-[10px] text-blue-900">
                  <div className="font-semibold">Extracted draft — review before creating</div>
                  <div className="mt-0.5 grid grid-cols-2 gap-x-2 gap-y-0.5">
                    <span>Supplier: {pdfExtraction.supplierName || 'Not found'}{pdfExtraction.supplierName && (formData.supplier_id ? ' ✓' : ' ⚠ Review')}</span>
                    <span>PO: {pdfExtraction.poNumber || 'Not found'}{pdfExtraction.poNumber && purchaseOrderId ? (supplierPurchaseOrders.find(po => po.id === purchaseOrderId && normaliseMatchText(po.po_number) === normaliseMatchText(pdfExtraction.poNumber)) ? ' ✓ Matched' : ' ⚠ Review') : ''}</span>
                    <span>Invoice #: {pdfExtraction.invoiceNumber || 'Not found'}</span>
                    <span>Lines: {pdfExtraction.lines.length || 0}</span>
                    <span>Products: {lineItems.filter(line => line.item_type === 'inventory' && line.product_id).length} matched / {lineItems.filter(line => line.item_type === 'inventory' && !line.product_id).length} review</span>
                    <span>Makes: {lineItems.filter(line => line.item_type === 'inventory' && line.receiving_make_id).length} selected / {lineItems.filter(line => line.item_type === 'inventory' && !line.receiving_make_id).length} review</span>
                  </div>
                  {pdfExtraction.lines.length > 0 && (
                    <div className="mt-1 border-t border-blue-200 pt-1">
                      {pdfExtraction.lines.map((line, index) => (
                        <div key={`${line.description}-${index}`} className="truncate">
                          Product {index + 1}: {line.description} — {lineItems[index]?.product_id ? '✓ Matched' : '⚠ Review'}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {formData.document_urls.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {formData.document_urls.map((url, index) => (
                    <span key={index} className="inline-flex max-w-full items-center gap-1 bg-green-50 border border-green-200 rounded px-1.5 py-0.5 text-[10px] text-green-700">
                      <FileText className="w-3 h-3 shrink-0" />
                      <span className="truncate">{url.split('/').pop()}</span>
                      <button type="button" onClick={() => handleRemoveDocument(index)} className="p-0.5 text-red-600 hover:bg-red-50 rounded shrink-0" title="Remove attachment">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

        </form>
      </FinanceModal>

      {/* View Modal */}
      {selectedInvoice && (
        <Modal
          isOpen={viewModal}
          onClose={() => {
            setViewModal(false);
            setSelectedInvoice(null);
            setViewLineItems([]);
            if (viewBlobUrl) { URL.revokeObjectURL(viewBlobUrl); setViewBlobUrl(null); }
          }}
          title={`Purchase Invoice: ${selectedInvoice.invoice_number}`}
          size="xl"
        >
          <div className="space-y-5">
            {/* Header Info */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 bg-gray-50 rounded-lg p-4">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{t('purchaseInvoices.supplier', 'Supplier')}</p>
                <p className="font-semibold text-gray-900">{selectedInvoice.suppliers?.company_name || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{t('purchaseInvoices.invoiceDate', 'Invoice Date')}</p>
                <p className="font-semibold text-gray-900">{formatDate(selectedInvoice.invoice_date)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{t('purchaseInvoices.dueDate', 'Due Date')}</p>
                <p className="font-semibold text-gray-900">{selectedInvoice.due_date ? formatDate(selectedInvoice.due_date) : '—'}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{t('purchaseInvoices.status', 'Status')}</p>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  selectedInvoice.status === 'paid' ? 'bg-green-100 text-green-800'
                  : selectedInvoice.status === 'partial' ? 'bg-yellow-100 text-yellow-800'
                  : 'bg-red-100 text-red-800'
                }`}>{t(`purchaseInvoices.statuses.${selectedInvoice.status}`, selectedInvoice.status)}</span>
                <p className="mt-1 text-[10px] text-blue-700">{t('purchaseInvoices.receiving', 'Receiving')}: {selectedInvoice.receiving_approval_status || 'draft'}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{t('purchaseInvoices.currency', 'Currency')}</p>
                <p className="font-semibold text-gray-900">{selectedInvoice.currency}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{t('purchaseInvoices.subtotal', 'Subtotal')}</p>
                <p className="font-semibold text-gray-900">{formatCurrency(selectedInvoice.subtotal, selectedInvoice.currency)}</p>
                {Number(selectedInvoice.tax_amount) > 0 && (
                  <p className="text-xs text-gray-500 mt-0.5">PPN: {formatCurrency(selectedInvoice.tax_amount, selectedInvoice.currency)}</p>
                )}
                {Number(selectedInvoice.stamp_duty_amount) > 0 && (
                  <p className="text-xs text-gray-500 mt-0.5">Bea Meterai: {formatCurrency(selectedInvoice.stamp_duty_amount, selectedInvoice.currency)}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{t('purchaseInvoices.paidAmount', 'Paid Amount')}</p>
                <p className="font-semibold text-green-700">{formatCurrency(selectedInvoice.paid_amount, selectedInvoice.currency)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{t('purchaseInvoices.balanceDue', 'Balance Due')}</p>
                <p className="font-bold text-lg text-blue-700">{formatCurrency(selectedInvoice.balance_amount, selectedInvoice.currency)}</p>
                {selectedInvoice.status !== 'paid' && selectedInvoice.status !== 'cancelled' && Number(selectedInvoice.balance_amount) > 0 && Number(selectedInvoice.balance_amount) <= (Number(roundingTolerance) > 0 ? Number(roundingTolerance) : 100) && hasManageAccess && (
                  <button
                    type="button"
                    disabled={settlingAdjustment}
                    onClick={handleSettleResidualRoundOff}
                    className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold bg-amber-600 text-white rounded hover:bg-amber-700 shadow-sm transition-colors"
                    title={`Post round-off adjustment of ${formatCurrency(selectedInvoice.balance_amount, selectedInvoice.currency)} to close this invoice`}
                  >
                    <CheckCircle className="w-3 h-3" />
                    {settlingAdjustment ? 'Settling...' : t('purchaseInvoices.settleRoundOff', 'Settle Round-Off')}
                  </button>
                )}
              </div>
            </div>

            {invoiceAdjustment && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 flex items-center justify-between text-xs">
                <div>
                  <span className="font-semibold text-amber-900 capitalize">{invoiceAdjustment.adjustment_type || 'Rounding'} Adjustment: </span>
                  <span className="font-bold text-amber-800">{formatCurrency(invoiceAdjustment.adjustment_amount, selectedInvoice.currency)}</span>
                  {invoiceAdjustment.reason && <span className="text-amber-700 ml-2">({invoiceAdjustment.reason})</span>}
                </div>
                {(() => {
                  const gl = Array.isArray(invoiceAdjustment.journal_entries)
                    ? invoiceAdjustment.journal_entries[0]
                    : invoiceAdjustment.journal_entries;
                  return gl?.entry_number ? (
                    <span className="font-mono text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-medium">
                      GL #{gl.entry_number}
                    </span>
                  ) : null;
                })()}
              </div>
            )}

            {/* Line Items */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('purchaseInvoices.lineItems', 'Line Items')}</h3>
              {viewLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : viewLineItems.length === 0 ? (
                <p className="text-sm text-gray-400 italic py-4 text-center">{t('purchaseInvoices.noItems', 'No line items found')}</p>
              ) : (
                <>
                  <div className="hidden md:block overflow-x-auto rounded-lg border border-gray-200">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">#</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">{t('purchaseInvoices.product', 'Product')}</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">{t('purchaseInvoices.make', 'Make')}</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">{t('common.description', 'Description')}</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">{t('purchaseInvoices.quantity', 'Qty')}</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">{t('purchaseInvoices.received', 'Received')}</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">{t('purchaseInvoices.remaining', 'Remaining')}</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">{t('purchaseInvoices.unit', 'Unit')}</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">{t('purchaseInvoices.unitPrice', 'Rate')}</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">{t('purchaseInvoices.total', 'Amount')}</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">{t('common.actions', 'Action')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 bg-white">
                        {viewLineItems.map((item, idx) => (
                          <tr key={item.id || idx} className="hover:bg-gray-50">
                            <td className="px-3 py-2 text-gray-400">{idx + 1}</td>
                            <td className="px-3 py-2 font-medium text-gray-900">{item.product_name || <span className="text-gray-400 italic">—</span>}</td>
                            <td className="px-3 py-2 text-gray-600">{item.receiving_make?.supplier_name || <span className="text-gray-400 italic">Not recorded</span>}{item.receiving_make?.grade ? ` (${item.receiving_make.grade})` : ''}</td>
                            <td className="px-3 py-2 text-gray-600 max-w-xs">
                              <p className="truncate" title={item.description}>{item.description || '—'}</p>
                            </td>
                            <td className="px-3 py-2 text-right text-gray-900">{Number(item.quantity).toLocaleString()}</td>
                            <td className="px-3 py-2 text-right text-green-700">{receivingAllocations.filter(a => a.purchase_invoice_item_id === item.id).reduce((s, a) => s + Number(a.received_quantity), 0).toLocaleString()}</td>
                            <td className="px-3 py-2 text-right text-orange-700">{Math.max(0, Number(item.quantity) - receivingAllocations.filter(a => a.purchase_invoice_item_id === item.id).reduce((s, a) => s + Number(a.received_quantity), 0)).toLocaleString()}</td>
                            <td className="px-3 py-2 text-gray-500">{item.unit}</td>
                            <td className="px-3 py-2 text-right text-gray-900">{formatCurrency(item.unit_price, selectedInvoice.currency)}</td>
                            <td className="px-3 py-2 text-right font-medium text-gray-900">{formatCurrency(item.line_total, selectedInvoice.currency)}</td>
                            <td className="px-3 py-2 text-right">
                              {item.item_type === 'inventory' && (!selectedInvoice.receiving_approval_status || selectedInvoice.receiving_approval_status === 'approved') && Number(item.quantity) > receivingAllocations.filter(a => a.purchase_invoice_item_id === item.id).reduce((s, a) => s + Number(a.received_quantity), 0) && canManage && (
                                <button type="button" onClick={() => void openReceiving(item)} className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 min-h-[30px]"><PackageCheck className="w-3.5 h-3.5" />{t('purchaseInvoices.receive', 'Receive')}</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-gray-50">
                        <tr>
                          <td colSpan={10} className="px-3 py-2 text-right text-sm font-semibold text-gray-700">{t('purchaseInvoices.total', 'Total')}</td>
                          <td className="px-3 py-2 text-right text-sm font-bold text-gray-900">
                            {formatCurrency(selectedInvoice.total_amount, selectedInvoice.currency)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* Mobile Line Items Card View (< 768px) */}
                  <div className="block md:hidden space-y-2">
                    {viewLineItems.map((item, idx) => {
                      const received = receivingAllocations.filter(a => a.purchase_invoice_item_id === item.id).reduce((s, a) => s + Number(a.received_quantity), 0);
                      const remaining = Math.max(0, Number(item.quantity) - received);
                      return (
                        <div key={item.id || idx} className="border border-slate-200 rounded-lg p-2.5 bg-white space-y-1.5 shadow-2xs">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-gray-900">
                              #{idx + 1} {item.product_name || '—'}
                            </span>
                            <span className="text-xs font-mono font-bold text-gray-900">
                              {formatCurrency(item.line_total, selectedInvoice.currency)}
                            </span>
                          </div>
                          {item.receiving_make?.supplier_name && (
                            <p className="text-[11px] text-gray-500">
                              {t('purchaseInvoices.make', 'Make')}: {item.receiving_make.supplier_name}{item.receiving_make.grade ? ` (${item.receiving_make.grade})` : ''}
                            </p>
                          )}
                          {item.description && (
                            <p className="text-xs text-gray-600 italic">{item.description}</p>
                          )}
                          <div className="grid grid-cols-3 gap-1 pt-1 border-t border-slate-100 text-[11px]">
                            <div>
                              <span className="text-gray-400 block">{t('purchaseInvoices.quantity', 'Qty')}</span>
                              <span className="font-medium text-gray-800">{Number(item.quantity).toLocaleString()} {item.unit}</span>
                            </div>
                            <div>
                              <span className="text-gray-400 block">{t('purchaseInvoices.received', 'Received')}</span>
                              <span className="font-medium text-green-700">{received.toLocaleString()}</span>
                            </div>
                            <div>
                              <span className="text-gray-400 block">{t('purchaseInvoices.remaining', 'Remaining')}</span>
                              <span className="font-medium text-orange-700">{remaining.toLocaleString()}</span>
                            </div>
                          </div>
                          <div className="flex items-center justify-between pt-1 text-[11px] text-gray-500">
                            <span>{t('purchaseInvoices.unitPrice', 'Rate')}: {formatCurrency(item.unit_price, selectedInvoice.currency)}</span>
                            {item.item_type === 'inventory' && (!selectedInvoice.receiving_approval_status || selectedInvoice.receiving_approval_status === 'approved') && Number(item.quantity) > received && canManage && (
                              <button
                                type="button"
                                onClick={() => void openReceiving(item)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 min-h-[30px]"
                              >
                                <PackageCheck className="w-3.5 h-3.5" />
                                <span>{t('purchaseInvoices.receive', 'Receive')}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            {/* Notes */}
            {selectedInvoice.notes && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-xs font-medium text-amber-700 mb-1">Notes / Shipment Details</p>
                <p className="text-sm text-amber-900">{selectedInvoice.notes}</p>
              </div>
            )}

            {/* Attachment */}
            {selectedInvoice.document_urls && selectedInvoice.document_urls.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Attachments</h3>
                <div className="space-y-2">
                  {selectedInvoice.document_urls.map((url, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 bg-gray-50 rounded border border-gray-200">
                      <FileText className="w-4 h-4 text-red-500 flex-shrink-0" />
                      <span className="text-sm text-gray-700 flex-1 truncate">{url.split('/').pop()}</span>
                      <button type="button" onClick={() => void handleOpenAttachment(url)} className="text-xs text-blue-600 hover:underline flex-shrink-0">Open</button>
                      <button type="button" onClick={() => void handleDownloadAttachment(url)} className="text-xs text-blue-600 hover:underline flex-shrink-0">Download</button>
                    </div>
                  ))}
                </div>
                {viewBlobLoading && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
                    <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    Loading preview...
                  </div>
                )}
                {!viewBlobLoading && viewBlobUrl && (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center justify-between bg-blue-50 px-3 py-2 rounded">
                      <span className="text-sm text-gray-700">Preview</span>
                      <a
                        href={viewBlobUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline font-medium"
                      >
                        Open in New Tab
                      </a>
                    </div>
                    <object
                      data={viewBlobUrl}
                      type="application/pdf"
                      className="w-full rounded border border-gray-200"
                      style={{ height: '500px' }}
                    >
                      <div className="flex flex-col items-center justify-center h-full bg-gray-50 p-6 text-center">
                        <FileText className="w-12 h-12 text-gray-400 mb-3" />
                        <p className="text-sm text-gray-600 mb-3">
                          Your browser cannot display PDFs inline.
                        </p>
                        <a
                          href={viewBlobUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 h-7 px-2 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                        >
                          <FileText className="w-4 h-4" />
                          Open PDF in New Tab
                        </a>
                      </div>
                    </object>
                  </div>
                )}
                {!viewBlobLoading && !viewBlobUrl && selectedInvoice.document_urls && selectedInvoice.document_urls.length > 0 && (
                  <div className="mt-3 p-4 bg-amber-50 border border-amber-200 rounded">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-amber-900 mb-1">
                          PDF Preview Unavailable
                        </p>
                        <p className="text-xs text-amber-700 mb-3">
                          The file may not have been uploaded to storage yet, or the storage bucket may not be accessible. Please use the "Open" button above to download or view the file.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              const url = selectedInvoice.document_urls;
                              if (url && url.length > 0) void handleOpenAttachment(url[0]);
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-amber-300 text-amber-800 rounded hover:bg-amber-50 text-xs font-medium"
                          >
                            <FileText className="w-3.5 h-3.5" />
                            Try Opening File
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {receivingOpen && receivingItem && selectedInvoice && (
        <Modal isOpen={receivingOpen} onClose={() => setReceivingOpen(false)} title="Receive Inventory" size="md">
          <div className="space-y-3">
            <div className="rounded bg-gray-50 p-3 text-sm"><div className="font-semibold">{receivingItem.product_name || receivingItem.description}</div><div className="text-gray-500">Invoice quantity: {Number(receivingItem.quantity).toLocaleString()} {receivingItem.unit}</div><div className="text-green-700">Already received: {receivingAlreadyReceived.toLocaleString()} {receivingItem.unit}</div><div className="text-orange-700">Remaining: {receivingRemaining.toLocaleString()} {receivingItem.unit}</div></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Make / Manufacturer *</label><SearchableSelect value={receivingForm.make_id} onChange={v => setReceivingForm(f => f.make_id === v ? f : ({ ...f, make_id: v, batch_id: '', batch_number: '', import_container_id: '' }))} options={receivingMakes.map(m => ({ value: m.id, label: `${m.supplier_name || 'Unnamed make'}${m.grade ? ` (${m.grade})` : ''}` }))} placeholder={receivingMakes.length ? 'Select Make / Manufacturer' : 'No makes recorded'} /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Existing Batch (optional)</label><select name="existing_batch_optional" aria-label="Existing Batch (optional)" className={SAP_INPUT} value={receivingForm.batch_id} onChange={e => { const b = receivingBatches.find(x => x.id === e.target.value); setReceivingForm(f => ({ ...f, batch_id: e.target.value, batch_number: b?.batch_number || '', import_container_id: b?.import_container_id || '' })); }}><option value="">Create new batch</option>{receivingBatches.filter(b => b.make_id === receivingForm.make_id || b.make_id === null).map(b => <option key={b.id} value={b.id}>{b.batch_number} (stock {Number(b.current_stock).toLocaleString()}){b.make_id === null ? ' (Make not recorded)' : ''}</option>)}</select></div>
            {!receivingForm.batch_id && <div><label className="block text-xs font-medium text-gray-700 mb-1">New Batch Number *</label><input name="new_batch_number" aria-label="New Batch Number" className={SAP_INPUT} value={receivingForm.batch_number} onChange={e => setReceivingForm(f => ({ ...f, batch_number: e.target.value }))} /></div>}
            <div className="grid grid-cols-2 gap-2"><div><label className="block text-xs font-medium text-gray-700 mb-1">Quantity *</label><input name="quantity" aria-label="Quantity" type="number" min="0.01" step="0.01" className={SAP_INPUT} value={receivingForm.quantity} onChange={e => setReceivingForm(f => ({ ...f, quantity: Number(e.target.value) || 0 }))} /></div><div><label className="block text-xs font-medium text-gray-700 mb-1">Expiry</label><input name="expiry" aria-label="Expiry" type="date" className={SAP_INPUT} value={receivingForm.expiry_date} onChange={e => setReceivingForm(f => ({ ...f, expiry_date: e.target.value }))} /></div></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Import Container (optional)</label><select name="import_container_optional" aria-label="Import Container (optional)" className={SAP_INPUT} disabled={Boolean(receivingForm.batch_id)} value={receivingForm.import_container_id} onChange={e => setReceivingForm(f => ({ ...f, import_container_id: e.target.value }))}><option value="">Local purchase / no container</option>{importContainers.map(c => <option key={c.id} value={c.id}>{c.container_ref}{c.status ? ` (${c.status})` : ''}</option>)}</select>{receivingForm.batch_id && <p className="mt-1 text-[10px] text-gray-500">Existing batch container is preserved.</p>}</div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Batch Documents (optional)</label>
              <FileUpload
                compact
                accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.doc"
                multiple
                disabled={receivingBusy}
                existingFiles={receivingDocuments}
                onFilesChange={(files) => setReceivingDocuments(files as ReceivingDocument[])}
              />
              <p className="mt-1 text-[10px] text-gray-500">Attached to the received Batch using the existing Batch document system.</p>
            </div>
            <div className="flex justify-end gap-2 pt-2"><button type="button" className={F_BTN_SECONDARY} onClick={() => setReceivingOpen(false)}>Cancel</button><button type="button" className={F_BTN_PRIMARY} disabled={receivingBusy} onClick={() => void submitReceiving()}>{receivingBusy ? 'Receiving…' : 'Confirm Receiving'}</button></div>
          </div>
        </Modal>
      )}

    </div>
  );
}
