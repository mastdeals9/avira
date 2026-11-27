import { useEffect, useMemo, useRef, useState } from 'react';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { FileUpload } from '../components/FileUpload';
import { SearchableSelect } from '../components/SearchableSelect';
import { StockMovementsModal } from '../components/StockMovementsModal';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Plus, Pencil as Edit, Trash2, AlertTriangle, Package, DollarSign, FileText, ExternalLink, Search, ChevronDown, ChevronRight, Archive, Eye, EyeOff, ExternalLink as LinkIcon } from 'lucide-react';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/dateFormat';
import { MoneyInput } from '../components/MoneyInput';
import { FloatingField, FLOAT_INPUT } from '../components/finance/FloatingField';
import { SapRow } from '../components/finance/SapLayout';
import { canSeeInventoryCosting } from '../utils/permissions';
import { resolveStorageUrlCached } from '../utils/signedUrlCache';
import { formatUnit, abbreviateUnit, formatPackagingDetails } from '../utils/unitDisplay';
import { PACKAGING_TYPES, normalizePackagingType } from '../constants/masterData';
import { useErpSyncListener, emitErpSync } from '../utils/erpSyncBus';
import { uploadOptimizedFile } from '../services/storage/uploadOptimizationService';
import { AttachFromDocumentBankModal } from '../components/documents/AttachFromDocumentBankModal';
import { linkUniversalDocument } from '../services/documents/universalDocumentBankService';

interface Batch {
  id: string;
  batch_number: string;
  product_id: string;
  make_id: string | null;
  import_date: string;
  import_quantity: number;
  current_stock: number;
  reserved_stock: number;
  packaging_details: string;
  import_price: number;
  import_price_usd: number | null;
  import_price_per_unit: number | null;
  exchange_rate_usd_to_idr: number | null;
  customs_ndpbm_rate?: number | null;
  customs_assessable_value_idr?: number | null;
  estimated_duty_charges?: number | null;
  actual_duty_charges?: number | null;
  duty_charges: number;
  duty_percent: number | null;
  duty_charge_type?: 'percentage' | 'fixed' | null;
  freight_charges: number;
  other_charges: number;
  expiry_date: string;
  is_active: boolean;
  import_cost_allocated: number | null;
  final_landed_cost: number | null;
  landed_cost_per_unit: number | null;
  import_container_id: string | null;
  cost_locked: boolean | null;
  products?: {
    product_name: string;
    product_code: string;
    unit: string;
  };
  product_sources?: { supplier_name: string | null; grade: string | null } | null;
  import_containers?: {
    container_ref: string;
    customs_ndpbm_rate?: number | null;
  };
  document_count?: number;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
  unit: string;
  duty_percent: number;
  packaging_type?: string | null;
  pack_type?: string | null;
  per_pack_weight?: number | null;
}

interface ImportContainer {
  id: string;
  container_ref: string;
  status: string;
  customs_ndpbm_rate?: number | null;
}

interface BatchDocument {
  id: string;
  file_url: string;
  file_name: string;
  file_type: string;
  file_size: number;
  uploaded_at: string;
}

interface PendingInward {
  invoice_id: string;
  invoice_number: string;
  item_id: string;
  product_id: string;
  make_id: string | null;
  import_container_id: string | null;
  invoice_date: string;
  currency: string;
  exchange_rate: number;
  unit: string;
  unit_price: number;
  supplier_name: string;
  product_name: string;
  quantity: number;
  received: number;
  pending: number;
  make_name: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  container_ref: string | null;
}

export function Batches() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const canViewCosting = canSeeInventoryCosting(profile?.role);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productMakes, setProductMakes] = useState<Array<{ id: string; supplier_name: string | null; grade: string | null }>>([]);
  const [importContainers, setImportContainers] = useState<ImportContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [documentsModalOpen, setDocumentsModalOpen] = useState(false);
  const [batchBankAttachOpen, setBatchBankAttachOpen] = useState(false);
  const [transactionHistoryModal, setTransactionHistoryModal] = useState(false);
  const [selectedBatchDocs, setSelectedBatchDocs] = useState<BatchDocument[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [signedUrlCache, setSignedUrlCache] = useState<Record<string, string>>({});
  const [selectedProductForHistory, setSelectedProductForHistory] = useState<{id: string; name: string; code: string; batchId?: string; batchNumber?: string; unit?: string} | null>(null);
  const [productReservationsMap, setProductReservationsMap] = useState<Map<string, number>>(new Map());
  const [productAtpMap, setProductAtpMap] = useState<Map<string, number>>(new Map());
  const [productShortageMap, setProductShortageMap] = useState<Map<string, number>>(new Map());
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([]);
  const [batchSearch, setBatchSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set());
  const [pendingInwards, setPendingInwards] = useState<PendingInward[]>([]);
  const containerMap = useMemo(() => {
    const map = new Map<string, string>();
    importContainers.forEach(c => {
      if (c.id && c.container_ref) {
        map.set(c.id, c.container_ref);
      }
    });
    return map;
  }, [importContainers]);
  const [pendingInwardContext, setPendingInwardContext] = useState<{ invoice_id: string; item_id: string } | null>(null);
  const [companySettings, setCompanySettings] = useState<any>(null);
  const batchOperationIdRef = useRef<string | null>(null);
  const priceFieldRef = useRef<'usd' | 'idr' | null>(null);
  const [formData, setFormData] = useState({
    batch_number: '',
    product_id: '',
    make_id: '',
    import_container_id: '',
    import_date: '',
    import_quantity: 0,
    packaging_details: '',
    import_price_usd: 0,
    import_price_idr: 0,
    exchange_rate_usd_to_idr: 0,
    customs_ndpbm_rate: null as number | null,
    duty_charges: 0,
    duty_percent: 0,
    duty_charge_type: 'fixed' as 'percentage' | 'fixed',
    freight_charges: 0,
    freight_charge_type: 'fixed' as 'percentage' | 'fixed',
    other_charges: 0,
    other_charge_type: 'fixed' as 'percentage' | 'fixed',
    expiry_date: '',
    per_pack_weight: '',
    pack_type: 'bag',
  });

  useEffect(() => {
    loadBatches();
    loadProducts();
    loadImportContainers();
    loadCompanySettings();
    loadPendingInwards();
  }, [canViewCosting]);

  useErpSyncListener(
    ['inventory', 'sales_orders', 'delivery_challans', 'material_returns', 'purchases'],
    () => {
      loadBatches();
      loadPendingInwards();
    }
  );

  const loadPendingInwards = async () => {
    const { data, error } = await supabase.from('purchase_invoices').select('*,suppliers(company_name),purchase_invoice_items(*,products(product_name, unit))');
    if (error) {
      console.error('Error loading pending inwards:', error);
      setPendingInwards([]);
      return;
    }
    const rows = (data || []).filter((invoice: any) => invoice.receiving_approval_status === 'approved').flatMap((invoice: any) => (invoice.purchase_invoice_items || [])
      .filter((item: any) => item.item_type === 'inventory')
      .map((item: any) => ({
        invoice_id: invoice.id, invoice_number: invoice.invoice_number, item_id: item.id,
        product_id: item.product_id, make_id: item.receiving_make_id || null,
        import_container_id: item.receiving_import_container_id || null,
        invoice_date: invoice.invoice_date, currency: invoice.currency || 'IDR', exchange_rate: Number(invoice.exchange_rate) || 1,
        unit: item.products?.unit || item.unit || '', unit_price: Number(item.unit_price) || 0,
        supplier_name: invoice.suppliers?.company_name || '—',
        product_name: item.products?.product_name || item.description || '—',
        quantity: Number(item.quantity) || 0, received: 0, pending: Number(item.quantity) || 0,
        make_name: null,
        batch_number: item.receiving_batch_number || null, expiry_date: item.receiving_expiry_date || null,
        container_ref: null,
      })));
    const makeIds = Array.from(new Set(rows.map((r: PendingInward) => r.make_id).filter(Boolean))) as string[];
    const containerIds = Array.from(new Set(rows.map((r: PendingInward) => r.import_container_id).filter(Boolean))) as string[];
    const [makeResult, containerResult] = await Promise.all([
      makeIds.length ? supabase.from('product_sources').select('id,supplier_name').in('id', makeIds) : Promise.resolve({ data: [], error: null }),
      containerIds.length ? supabase.from('import_containers').select('id,container_ref').in('id', containerIds) : Promise.resolve({ data: [], error: null }),
    ]);
    const makeNames = new Map((makeResult.data || []).map((m: any) => [m.id, m.supplier_name]));
    const containerRefs = new Map((containerResult.data || []).map((c: any) => [c.id, c.container_ref]));
    rows.forEach((r: PendingInward) => {
      r.make_name = r.make_id ? makeNames.get(r.make_id) || null : null;
      r.container_ref = r.import_container_id ? containerRefs.get(r.import_container_id) || null : null;
    });
    const itemIds = rows.map((r: PendingInward) => r.item_id);
    if (itemIds.length) {
      const { data: receivedTotals, error: totalsError } = await supabase.rpc('purchase_invoice_item_received_totals', { p_item_ids: itemIds });
      if (totalsError) throw totalsError;
      const totals = (receivedTotals || []).reduce((acc: Record<string, number>, a: any) => {
        acc[a.purchase_invoice_item_id] = Number(a.received_quantity) || 0;
        return acc;
      }, {});
      rows.forEach((r: PendingInward) => {
        r.received = totals[r.item_id] || 0;
        r.pending = Math.max(0, r.quantity - r.received);
      });
    }
    setPendingInwards(rows.filter((r: PendingInward) => r.pending > 0));
  };

  const openPendingInward = async (row: PendingInward) => {
    if (!canEdit || !row.product_id) return;
    const { data: makes, error: makesError } = await supabase
      .from('product_sources')
      .select('id,supplier_name,grade')
      .eq('product_id', row.product_id)
      .order('supplier_name');
    if (makesError) {
      showToast({ type: 'error', title: 'Unable to open inward', message: makesError.message });
      return;
    }

    const product = products.find(p => p.id === row.product_id);
    const rawPackType = product?.pack_type || product?.packaging_type;
    const defaultPackType = (normalizePackagingType(rawPackType) || 'Bag').toLowerCase();
    const defaultPerPack = product?.per_pack_weight != null ? String(product.per_pack_weight) : '';
    let packagingDetails = '';
    if (row.pending && defaultPerPack) {
      const perPack = parseFloat(defaultPerPack);
      if (perPack > 0) {
        const packs = (row.pending / perPack).toFixed(0);
        const inwardUnit = abbreviateUnit(product?.unit || row.unit || '');
        packagingDetails = `${packs} ${defaultPackType}${parseInt(packs) !== 1 ? 's' : ''} x ${perPack}${inwardUnit}`;
      }
    }

    setEditingBatch(null);
    setPendingInwardContext({ invoice_id: row.invoice_id, item_id: row.item_id });
    setProductMakes(makes || []);
    setUploadedFiles([]);
    const linkedContainer = importContainers.find(c => c.id === row.import_container_id);
    setFormData({
      batch_number: row.batch_number || '',
      product_id: row.product_id,
      make_id: row.make_id || (makes?.length === 1 ? makes[0].id : ''),
      import_container_id: row.import_container_id || '',
      import_date: new Date().toISOString().split('T')[0],
      import_quantity: row.pending,
      packaging_details: packagingDetails,
      import_price_usd: row.currency === 'USD' ? row.unit_price : 0,
      import_price_idr: row.currency === 'USD' ? 0 : row.unit_price,
      exchange_rate_usd_to_idr: row.currency === 'USD' ? row.exchange_rate : 0,
      customs_ndpbm_rate: linkedContainer?.customs_ndpbm_rate ?? null,
      duty_charges: 0,
      duty_percent: product?.duty_percent || 0,
      duty_charge_type: 'percentage',
      freight_charges: 0,
      freight_charge_type: 'fixed',
      other_charges: 0,
      other_charge_type: 'fixed',
      expiry_date: row.expiry_date || '',
      per_pack_weight: defaultPerPack,
      pack_type: defaultPackType,
    });
    setModalOpen(true);
  };

  const rejectPendingInward = async (row: PendingInward) => {
    const reason = window.prompt('Rejection reason (required):')?.trim();
    if (!reason) return;
    const { error } = await supabase.rpc('reject_purchase_invoice_inward', {
      p_purchase_invoice_id: row.invoice_id,
      p_purchase_invoice_item_id: row.item_id,
      p_reason: reason,
    });
    if (error) { showToast({ type: 'error', title: 'Reject failed', message: error.message }); return; }
    showToast({ type: 'success', title: 'Rejected', message: 'Correct and resubmit the Purchase Invoice for approval.' });
    await loadPendingInwards();
  };

  const loadCompanySettings = async () => {
    const { data } = await supabase.from('app_settings').select('*').maybeSingle();
    if (data) setCompanySettings(data);
  };

  const handleUSDChange = (usd: number) => {
    priceFieldRef.current = 'usd';
    const rate = formData.exchange_rate_usd_to_idr;
    const idr = rate > 0 ? usd * rate : formData.import_price_idr;
    setFormData(prev => ({ ...prev, import_price_usd: usd, import_price_idr: idr }));
  };

  const handleIDRChange = (idr: number) => {
    priceFieldRef.current = 'idr';
    const rate = formData.exchange_rate_usd_to_idr;
    const usd = rate > 0 ? idr / rate : formData.import_price_usd;
    setFormData(prev => ({ ...prev, import_price_idr: idr, import_price_usd: rate > 0 ? Number(usd.toFixed(4)) : usd }));
  };

  const handleExchangeRateChange = (rate: number) => {
    const activeField = priceFieldRef.current;
    if (activeField === 'idr' && rate > 0) {
      const usd = formData.import_price_idr / rate;
      setFormData(prev => ({ ...prev, exchange_rate_usd_to_idr: rate, import_price_usd: Number(usd.toFixed(4)) }));
    } else if (activeField === 'usd' && rate > 0) {
      const idr = formData.import_price_usd * rate;
      setFormData(prev => ({ ...prev, exchange_rate_usd_to_idr: rate, import_price_idr: idr }));
    } else {
      setFormData(prev => ({ ...prev, exchange_rate_usd_to_idr: rate }));
    }
  };

  const loadBatches = async () => {
    try {
      const batchColumns = canViewCosting
        ? '*'
        : `
          id,
          batch_number,
          product_id,
          make_id,
          import_date,
          import_quantity,
          current_stock,
          reserved_stock,
          packaging_details,
          expiry_date,
          is_active,
          import_container_id,
          cost_locked
        `;
      const query = supabase
        .from('batches')
        .select(`
          ${batchColumns},
          products(product_name, product_code, unit),
          product_sources!batches_make_id_fkey(supplier_name, grade),
          import_containers(container_ref, customs_ndpbm_rate),
          stock_reservations(id, reserved_quantity, status, sales_orders(so_number))
        `)
        .order('import_date', { ascending: false });

      const [batchRes, stockSummaryRes] = await Promise.all([
        query,
        supabase
          .from('inventory_v1_stock_summary')
          .select('product_id, total_current_stock, reserved_stock, available_quantity, shortage_quantity')
      ]);

      if (batchRes.error) throw batchRes.error;

      const pMap = new Map<string, number>();
      const atpMap = new Map<string, number>();
      const shortageMap = new Map<string, number>();
      (stockSummaryRes.data || []).forEach((row: any) => {
        if (row.product_id) {
          pMap.set(row.product_id, Number(row.reserved_stock) || 0);
          atpMap.set(row.product_id, Number(row.available_quantity) || 0);
          shortageMap.set(row.product_id, Number(row.shortage_quantity) || 0);
        }
      });
      setProductReservationsMap(pMap);
      setProductAtpMap(atpMap);
      setProductShortageMap(shortageMap);

      const batchRows = (batchRes.data ?? []) as unknown as Array<Record<string, any> & {
        id: string;
        stock_reservations?: Array<{ status: string }>;
      }>;
      const batchesWithDocCount = await Promise.all(
        batchRows.map(async (batch) => {
          const { count } = await supabase
            .from('batch_documents')
            .select('*', { count: 'exact', head: true })
            .eq('batch_id', batch.id);

          const activeReservations = (batch.stock_reservations || []).filter((r: any) => r.status === 'active');

          return { ...batch, document_count: count || 0, active_reservations: activeReservations };
        })
      );

      setBatches(batchesWithDocCount as unknown as Batch[]);
    } catch (error) {
      console.error('Error loading batches:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('id, product_name, product_code, unit, duty_percent, packaging_type, pack_type, per_pack_weight')
        .eq('is_active', true)
        .order('product_name');

      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error loading products:', error);
    }
  };

  const loadProductMakes = async (productId: string, autoSelectSingle = true) => {
    if (!productId) { setProductMakes([]); return; }
    const { data, error } = await supabase
      .from('product_sources')
      .select('id, supplier_name, grade')
      .eq('product_id', productId)
      .order('supplier_name');
    if (error) throw error;
    const makes = data || [];
    setProductMakes(makes);
    if (autoSelectSingle && !editingBatch && makes.length === 1) {
      setFormData(current => current.product_id === productId ? { ...current, make_id: makes[0].id } : current);
    }
  };

  const loadImportContainers = async () => {
    try {
      const { data, error } = await supabase
        .from('import_containers')
        .select('id, container_ref, status, customs_ndpbm_rate')
        .order('container_ref', { ascending: false });

      if (error) throw error;
      setImportContainers(data || []);
    } catch (error) {
      console.error('Error loading import containers:', error);
    }
  };


  const loadBatchDocuments = async (batchId: string) => {
    try {
      const { data, error } = await supabase
        .from('batch_documents')
        .select('*')
        .eq('batch_id', batchId)
        .order('uploaded_at', { ascending: false });

      if (error) throw error;
      setSelectedBatchDocs(data || []);
      setSelectedBatchId(batchId);
      setDocumentsModalOpen(true);
      if (data && data.length > 0) {
        Promise.all(
          data.map(async (doc: any) => [doc.file_url, await resolveStorageUrlCached(doc.file_url, 3600)] as [string, string])
        ).then((entries) => setSignedUrlCache((prev) => ({ ...prev, ...Object.fromEntries(entries) })));
      }
    } catch (error) {
      console.error('Error loading documents:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to load documents' });
    }
  };

  const handleAttachBatchDocFromBank = async (doc: any) => {
    if (!selectedBatchId) return;
    try {
      const currentBatch = batches.find(b => b.id === selectedBatchId);
      await linkUniversalDocument({
        documentId: doc.id,
        entityType: 'batch',
        entityId: selectedBatchId,
        batchId: selectedBatchId,
        productId: currentBatch?.product_id || null,
        batchNumber: currentBatch?.batch_number || null,
      });
      await supabase.from('batch_documents').insert({
        batch_id: selectedBatchId,
        file_name: doc.original_file_name || doc.title,
        file_type: doc.document_type?.toLowerCase() || 'other',
        file_url: doc.file_url,
        file_size: doc.file_size,
      });
      showToast({ type: 'success', title: 'Document Attached', message: `Linked "${doc.title}" to Batch` });
      await loadBatchDocuments(selectedBatchId);
    } catch (err: any) {
      showToast({ type: 'error', title: 'Error', message: err.message });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (canViewCosting && formData.import_price_usd > 0 && formData.exchange_rate_usd_to_idr <= 0) {
      showToast({ type: 'error', title: 'Error', message: 'Please enter a valid exchange rate' });
      return;
    }

    try {
      if (!editingBatch && !formData.make_id) {
        showToast({ type: 'error', title: 'Make required', message: 'Create or select a Make / Manufacturer for new inventory batches.' });
        return;
      }
      // Use the IDR price directly if the user entered IDR (local purchase),
      // otherwise derive IDR from USD × exchange rate (import purchase).
      const importPriceIDR = canViewCosting
        ? (formData.import_price_idr > 0 && formData.import_price_usd <= 0
            ? formData.import_price_idr
            : formData.import_price_usd * formData.exchange_rate_usd_to_idr)
        : 0;

      // Calculate actual charge amounts based on type
      const calculateCharge = (amount: number, type: 'percentage' | 'fixed', basePrice: number) => {
        if (type === 'percentage') {
          return (basePrice * amount) / 100;
        }
        return amount;
      };

      // Duty is dynamically calculated from USD assessable value × Customs NDPBM FX × Duty %
      // Incorporates official Indonesian Customs (DJBC) thousand-rupiah billing rounding
      const dutyDetails = getDutyDetails();
      const dutyAmount = dutyDetails.perUnit;
      const totalDuty = dutyDetails.total;
      const freightAmount = calculateCharge(formData.freight_charges, formData.freight_charge_type, importPriceIDR);
      const otherAmount = calculateCharge(formData.other_charges, formData.other_charge_type, importPriceIDR);

      const batchPayload = {
        batch_number: formData.batch_number,
        product_id: formData.product_id,
        make_id: formData.make_id || null,
        import_container_id: formData.import_container_id && formData.import_container_id.trim() !== '' ? formData.import_container_id : null,
        import_date: formData.import_date,
        import_quantity: formData.import_quantity,
        packaging_details: formData.packaging_details,
        import_price: canViewCosting ? importPriceIDR : editingBatch?.import_price || 0,
        import_price_usd: canViewCosting ? formData.import_price_usd || null : editingBatch?.import_price_usd || null,
        exchange_rate_usd_to_idr: canViewCosting ? formData.exchange_rate_usd_to_idr || null : editingBatch?.exchange_rate_usd_to_idr || null,
        duty_percent: canViewCosting ? formData.duty_percent || 0 : editingBatch?.duty_percent || 0,
        duty_charges: canViewCosting ? dutyAmount : editingBatch?.duty_charges || 0,
        duty_charge_type: 'percentage',
        freight_charges: canViewCosting ? freightAmount : editingBatch?.freight_charges || 0,
        freight_charge_type: canViewCosting ? formData.freight_charge_type : 'fixed',
        other_charges: canViewCosting ? otherAmount : editingBatch?.other_charges || 0,
        other_charge_type: canViewCosting ? formData.other_charge_type : 'fixed',
        expiry_date: formData.expiry_date || null,
      };
      const operationId = batchOperationIdRef.current || crypto.randomUUID();
      batchOperationIdRef.current = operationId;

      const { data: result, error } = pendingInwardContext
        ? await supabase.rpc('receive_purchase_invoice_item', {
            p_purchase_invoice_item_id: pendingInwardContext.item_id,
            p_received_quantity: formData.import_quantity,
            p_operation_id: operationId,
            p_payload: batchPayload,
          })
        : await supabase.rpc('save_batch_inventory_v1', {
            p_batch_id: editingBatch?.id || null,
            p_payload: batchPayload,
            p_operation_id: operationId,
          });

      if (error) throw error;
      if (!result?.success || !result?.batch_id) {
        throw new Error(result?.error || 'Canonical batch save failed');
      }
      const batchId = result.batch_id as string;

      if (canViewCosting) {
        const assessableValueIdr = (formData.import_price_usd > 0 && formData.customs_ndpbm_rate && formData.customs_ndpbm_rate > 0)
          ? formData.import_price_usd * formData.customs_ndpbm_rate * (Number(formData.import_quantity) || 1)
          : null;

        await supabase.from('batches').update({
          customs_ndpbm_rate: formData.customs_ndpbm_rate ? Number(formData.customs_ndpbm_rate) : null,
          duty_charges: dutyAmount,
          actual_duty_charges: totalDuty,
          estimated_duty_charges: totalDuty,
          customs_assessable_value_idr: assessableValueIdr,
        }).eq('id', batchId);

        // Propagate cost changes dynamically through container, layers, inventory, and COGS
        // (Standalone batch cost updates propagate automatically via trg_batches_propagate_cost_change)
        if (formData.import_container_id) {
          await supabase.rpc('reallocate_container_costs', { p_container_id: formData.import_container_id });
        }
      }

      await uploadFilesToBatch(batchId);

      batchOperationIdRef.current = null;
      setModalOpen(false);
      resetForm();
      emitErpSync('inventory', 'updated');
      await Promise.all([loadBatches(), loadPendingInwards()]);
    } catch (error: any) {
      console.error('Error saving batch:', error);
      let msg = 'Failed to save batch. Please try again.';
      if (error?.message?.includes('duplicate') || error?.code === '23505') {
        msg = 'A batch with this batch number already exists. Please use a different batch number.';
      } else if (error?.message) {
        msg = error.message;
      }
      showToast({ type: 'error', title: 'Error', message: msg });
    }
  };

  const uploadFilesToBatch = async (batchId: string) => {
    const filesToUpload = uploadedFiles.filter(f => f.file && !f.id);

    for (const fileData of filesToUpload) {
      try {
        const fileName = `${Date.now()}_${fileData.file.name}`;
        const filePath = `${batchId}/${fileName}`;

        const { error: uploadError, optimization } = await uploadOptimizedFile(
          supabase,
          'batch-documents',
          filePath,
          fileData.file
        );

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('batch-documents')
          .getPublicUrl(filePath);

        const { error: dbError } = await supabase
          .from('batch_documents')
          .insert([{
            batch_id: batchId,
            file_url: publicUrl,
            file_name: fileData.file.name,
            file_type: fileData.file_type,
            file_size: optimization.optimizedSize,
          }]);

        if (dbError) throw dbError;
      } catch (error) {
        console.error('Error uploading file:', error);
      }
    }
  };

  const handleEdit = async (batch: Batch) => {
    setEditingBatch(batch);

    // Parse packaging details to extract per_pack_weight and pack_type
    let perPackWeight = '';
    let packType = 'bag';
    if (batch.packaging_details) {
      const match = batch.packaging_details.match(/(\d+)\s+(\w+)s?\s+x\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/);
      if (match) {
        perPackWeight = match[3];
        packType = match[2].toLowerCase();
      }
    }

    // Product duty is only the default for a new batch. Existing batches
    // must load and preserve their own saved duty percentage.
    const selectedProduct = products.find(p => p.id === batch.product_id);
    const productDutyPercent = selectedProduct?.duty_percent || 0;
    const batchUnit = selectedProduct?.unit || (batch as any).products?.unit;
    const sanitizedPackaging = formatPackagingDetails(batch.packaging_details, batchUnit);
    const linkedContainer = importContainers.find(c => c.id === batch.import_container_id);
    const resolvedNdpbm = batch.customs_ndpbm_rate ?? batch.import_containers?.customs_ndpbm_rate ?? linkedContainer?.customs_ndpbm_rate ?? null;

    setFormData({
      batch_number: batch.batch_number,
      product_id: batch.product_id,
      make_id: batch.make_id || '',
      import_container_id: batch.import_container_id || '',
      import_date: batch.import_date,
      import_quantity: batch.import_quantity,
      packaging_details: sanitizedPackaging,
      import_price_usd: batch.import_price_usd || 0,
      import_price_idr: batch.import_price || 0,
      exchange_rate_usd_to_idr: batch.exchange_rate_usd_to_idr || 0,
      customs_ndpbm_rate: resolvedNdpbm ? Number(resolvedNdpbm) : null,
      duty_percent: batch.duty_percent ?? productDutyPercent,
      duty_charges: batch.duty_charges,
      duty_charge_type: batch.duty_charge_type ?? 'percentage',
      freight_charges: batch.freight_charges,
      freight_charge_type: 'fixed',
      other_charges: batch.other_charges,
      other_charge_type: 'fixed',
      expiry_date: batch.expiry_date,
      per_pack_weight: perPackWeight,
      pack_type: packType,
    });
    await loadProductMakes(batch.product_id, false);

    const { data: docs } = await supabase
      .from('batch_documents')
      .select('*')
      .eq('batch_id', batch.id);

    setUploadedFiles(docs || []);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    const role = profile?.role;
    const isAdmin = role === 'admin' || role === 'accounts';
    const isWarehouse = role === 'warehouse';

    if (!isAdmin && !isWarehouse) {
      showToast({ type: 'error', title: 'Access Denied', message: 'You do not have permission to delete or archive batches.' });
      return;
    }

    const batch = batches.find(b => b.id === id);
    const batchLabel = batch?.batch_number ? `Batch ${batch.batch_number}` : 'This batch';

    try {
      // --- Common link checks (block all roles) ---

      const { data: salesItems } = await supabase
        .from('sales_invoice_items')
        .select('id, sales_invoices(invoice_number)')
        .eq('batch_id', id)
        .limit(1);

      if (salesItems && salesItems.length > 0) {
        const inv = (salesItems[0] as any).sales_invoices?.invoice_number;
        showToast({ type: 'error', title: 'Cannot Delete', message: `${batchLabel} is linked to invoice${inv ? ` ${inv}` : ''}. Delete the invoice first or contact your administrator.` });
        return;
      }

      const { data: challanItems } = await supabase
        .from('delivery_challan_items')
        .select('id')
        .eq('batch_id', id)
        .limit(1);

      if (challanItems && challanItems.length > 0) {
        showToast({ type: 'error', title: 'Cannot Delete', message: `${batchLabel} is linked to a delivery challan. Delete the challan first.` });
        return;
      }

      const { data: activeReservations } = await supabase
        .from('stock_reservations')
        .select('id, sales_orders(so_number)')
        .eq('batch_id', id)
        .eq('is_released', false)
        .limit(1);

      if (activeReservations && activeReservations.length > 0) {
        const soNum = (activeReservations[0] as any).sales_orders?.so_number;
        showToast({ type: 'error', title: 'Cannot Delete', message: `${batchLabel} has an active stock reservation${soNum ? ` for SO ${soNum}` : ''}. Release the reservation first.` });
        return;
      }

      const confirmed = await showConfirm({
        title: 'Archive Batch',
        message: `Archive ${batchLabel}? Inventory history will be preserved. A batch can only be archived after its stock and active reservations are zero.`,
        variant: 'warning',
        confirmLabel: 'Archive',
      });
      if (!confirmed) return;

      const { data: result, error: rpcError } = await supabase
        .rpc('archive_batch_inventory_v1', { p_batch_id: id });

      if (rpcError) {
        console.error('[Batch archive] RPC error:', rpcError);
        throw rpcError;
      }

      if (!result?.archived) {
        const reason = result?.reason || 'Archive blocked by policy.';
        console.error('[Batch archive] RPC returned archived=false:', reason, 'batch id:', id);
        showToast({ type: 'error', title: 'Archive Failed', message: reason });
        return;
      }

      showToast({ type: 'success', title: 'Archived', message: `${batchLabel} archived. All inventory history was preserved.` });
      emitErpSync('inventory', 'updated');
      await loadBatches();
    } catch (error: any) {
      console.error('[Batch delete] Unexpected error:', error);
      showToast({ type: 'error', title: 'Error', message: error?.message || 'Failed to delete batch.' });
    }
  };

  const resetForm = () => {
    batchOperationIdRef.current = null;
    setPendingInwardContext(null);
    setEditingBatch(null);
    setUploadedFiles([]);
    setProductMakes([]);
    setFormData({
      batch_number: '',
      product_id: '',
      make_id: '',
      import_container_id: '',
      import_date: '',
      import_quantity: 0,
      packaging_details: '',
      import_price_usd: 0,
      import_price_idr: 0,
      exchange_rate_usd_to_idr: 0,
      customs_ndpbm_rate: null,
      duty_percent: 0,
      duty_charges: 0,
      duty_charge_type: 'fixed',
      freight_charges: 0,
      freight_charge_type: 'fixed',
      other_charges: 0,
      other_charge_type: 'fixed',
      expiry_date: '',
      per_pack_weight: '',
      pack_type: 'bag',
    });
    priceFieldRef.current = null;
  };

  const showTransactionHistory = (productId: string, productName: string, productCode: string, batchId?: string, batchNumber?: string, unit?: string) => {
    setSelectedProductForHistory({ id: productId, name: productName, code: productCode, batchId, batchNumber, unit: unit || '' });
    setTransactionHistoryModal(true);
  };

  const toggleProduct = (productId: string) => {
    setExpandedProducts(prev => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const handleArchiveBatch = async (batchId: string) => {
    const confirmed = await showConfirm({
      title: 'Archive Batch',
      message: 'This batch has 0 stock. Archive it to hide from the active list?',
      confirmLabel: 'Archive',
    });
    if (!confirmed) return;
    try {
      const { data: result, error } = await supabase
        .rpc('archive_batch_inventory_v1', { p_batch_id: batchId });
      if (error) throw error;

      if (!result?.archived) {
        showToast({
          type: 'error',
          title: 'Archive Failed',
          message: result?.reason || 'Archive blocked by policy.',
        });
        return;
      }

      showToast({ type: 'success', title: 'Archived', message: 'Batch archived. Toggle "Show Archived" to view it.' });
      emitErpSync('inventory', 'updated');
      await loadBatches();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Error', message: error?.message || 'Failed to archive batch' });
    }
  };

  const handleUnarchiveBatch = async (batchId: string) => {
    try {
      const { error } = await supabase
        .from('batches')
        .update({ is_active: true })
        .eq('id', batchId);
      if (error) throw error;
      showToast({ type: 'success', title: 'Restored', message: 'Batch restored successfully' });
      emitErpSync('inventory', 'updated');
      await loadBatches();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Error', message: error?.message || 'Failed to restore batch' });
    }
  };

  const isLowStock = (batch: Batch) => batch.current_stock < batch.import_quantity * 0.2;
  const isExpired = (batch: Batch) => {
    if (!batch.expiry_date) return false;
    return new Date(batch.expiry_date) < new Date();
  };
  const isNearExpiry = (batch: Batch) => {
    if (!batch.expiry_date) return false;
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
    return new Date(batch.expiry_date) <= thirtyDaysFromNow && !isExpired(batch);
  };

  // Simplified dynamic duty calculation: USD assessable value × NDPBM FX × Duty %
  // Incorporates official Indonesian Customs (DJBC) thousand-rupiah billing rounding
  const getDutyDetails = () => {
    const assessableUsd = Number(formData.import_price_usd) || 0;
    const ndpbm = Number(formData.customs_ndpbm_rate) || 0;
    const dutyPercent = Number(formData.duty_percent) || 0;
    const qty = Number(formData.import_quantity) || 1;

    if (dutyPercent <= 0 || assessableUsd <= 0 || ndpbm <= 0) {
      return { perUnit: 0, total: 0, formula: '', roundingDiff: 0 };
    }

    const rawTotal = assessableUsd * qty * ndpbm * (dutyPercent / 100);
    // Official Indonesian Customs DJBC rule: Billing Bea Masuk is rounded up to the nearest thousand IDR
    const customsTotal = Math.ceil(rawTotal / 1000) * 1000;
    const roundingDiff = Number((customsTotal - rawTotal).toFixed(2));
    const perUnit = qty > 0 ? customsTotal / qty : 0;
    const formula = `${formatCurrency(assessableUsd, 'USD')} × Rp ${ndpbm.toLocaleString()} × ${dutyPercent}%`;

    return { perUnit, total: customsTotal, formula, roundingDiff };
  };

  const getDutyPerUnit = (): number => {
    return getDutyDetails().perUnit;
  };

  const calculateTotalCostIDR = () => {
    const importPriceIDR = formData.import_price_idr > 0 && formData.import_price_usd <= 0
      ? formData.import_price_idr
      : formData.import_price_usd * formData.exchange_rate_usd_to_idr;

    const calculateCharge = (amount: number, type: 'percentage' | 'fixed') => {
      if (type === 'percentage') {
        return (importPriceIDR * amount) / 100;
      }
      return amount;
    };

    const dutyAmount = getDutyPerUnit();
    const freightAmount = calculateCharge(formData.freight_charges, formData.freight_charge_type);
    const otherAmount = calculateCharge(formData.other_charges, formData.other_charge_type);

    return importPriceIDR + dutyAmount + freightAmount + otherAmount;
  };

  const getChargeAmount = (amount: number, type: 'percentage' | 'fixed') => {
    const importPriceIDR = formData.import_price_idr > 0 && formData.import_price_usd <= 0
      ? formData.import_price_idr
      : formData.import_price_usd * formData.exchange_rate_usd_to_idr;
    if (type === 'percentage') {
      return (importPriceIDR * amount) / 100;
    }
    return amount;
  };

  const formatCurrency = (amount: number, currency: 'USD' | 'IDR' = 'IDR') => {
    if (currency === 'USD') {
      return `$ ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const canEdit = profile?.role === 'admin' || profile?.role === 'warehouse' || profile?.role === 'accounts';

  const modalProduct = products.find(p => p.id === formData.product_id);
  const rawModalUnit = modalProduct?.unit || (editingBatch as any)?.products?.unit;
  const modalPackUnit = abbreviateUnit(rawModalUnit);
  const modalProductDisplayUnit = formatUnit(rawModalUnit);

  return (
    <Layout>
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2 border-b border-gray-200">
          <div>
            <h1 className="text-lg sm:text-xl font-bold text-gray-900 tracking-tight">{t('batches.title')}</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {canViewCosting ? 'Manage import batches with USD pricing and document tracking' : 'Manage import batches and document tracking'}
            </p>
          </div>
          {canEdit && (
            <button
              onClick={() => {
                resetForm();
                setModalOpen(true);
              }}
              className="flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-blue-700 shadow-xs transition"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('batches.addBatch')}
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs px-3.5 py-2 min-h-[64px] flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('batches.activeBatches')}</p>
              <p className="text-base font-bold text-gray-900 mt-0.5">{batches.filter(b => b.is_active).length}</p>
            </div>
            <Package className="w-4 h-4 text-blue-600" />
          </div>
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs px-3.5 py-2 min-h-[64px] flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('batches.soldOut')}</p>
              <p className="text-base font-bold text-orange-600 mt-0.5">{batches.filter(b => b.is_active && b.current_stock <= 0).length}</p>
            </div>
            <Archive className="w-4 h-4 text-orange-500" />
          </div>
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs px-3.5 py-2 min-h-[64px] flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('batches.lowStock')}</p>
              <p className="text-base font-bold text-amber-600 mt-0.5">{batches.filter(b => b.is_active && isLowStock(b) && b.current_stock > 0).length}</p>
            </div>
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          </div>
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs px-3.5 py-2 min-h-[64px] flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('batches.nearExpiry')}</p>
              <p className="text-base font-bold text-red-600 mt-0.5">{batches.filter(b => b.is_active && isNearExpiry(b)).length}</p>
            </div>
            <AlertTriangle className="w-4 h-4 text-red-500" />
          </div>
        </div>

        <div className="bg-white rounded-lg shadow">
          <div className="p-3 border-b border-gray-200 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">Inward Pending</h2>
            <span className="text-xs text-gray-500">Approved Purchase Invoice receipts awaiting physical arrival</span>
          </div>
          {pendingInwards.length === 0 ? <p className="p-4 text-sm text-gray-400">No approved receipts pending inward.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-50"><tr>
              <th className="px-3 py-2 text-left text-xs text-gray-500">Supplier / Invoice</th><th className="px-3 py-2 text-left text-xs text-gray-500">Product</th><th className="px-3 py-2 text-left text-xs text-gray-500">Make / Batch</th><th className="px-3 py-2 text-right text-xs text-gray-500">Pending</th><th className="px-3 py-2 text-right text-xs text-gray-500">Action</th>
            </tr></thead><tbody className="divide-y divide-gray-100">{pendingInwards.map(row => <tr key={row.item_id}>
              <td className="px-3 py-2">{row.supplier_name}<div className="text-xs text-gray-400">{row.invoice_number}</div></td><td className="px-3 py-2">{row.product_name}</td><td className="px-3 py-2">{row.make_name || 'Not specified'}<div className="text-xs text-gray-400">{row.batch_number || 'Batch at inward'}</div></td><td className="px-3 py-2 text-right font-semibold text-orange-700">{row.pending.toLocaleString()} {formatUnit(row.unit)}</td><td className="px-3 py-2 text-right"><button className="text-blue-600 hover:underline text-xs mr-2" onClick={() => { window.location.href = `/finance/purchase?document=${row.invoice_id}`; }}>Edit</button>{canEdit && <button className="text-green-600 hover:underline text-xs mr-2" onClick={() => void openPendingInward(row)}>Inward</button>}<button className="text-red-600 hover:underline text-xs" onClick={() => void rejectPendingInward(row)}>Reject</button></td>
            </tr>)}</tbody></table></div>
          )}
        </div>

        {/* Batches Table - Grouped by Product */}
        <div className="bg-white rounded-lg shadow">
          <div className="p-3 border-b border-gray-200 flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input name="batch_search" aria-label="Search by batch #, product, or import container..."
                type="text"
                value={batchSearch}
                onChange={(e) => setBatchSearch(e.target.value)}
                placeholder="Search by batch #, product, or import container..."
                className="w-full pl-9 pr-4 py-1.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
              />
            </div>
            <button
              onClick={() => setShowArchived(!showArchived)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${showArchived ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {showArchived ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {showArchived ? 'Hide Archived' : 'Show Archived'}
            </button>
            <button
              onClick={() => {
                if (expandedProducts.size > 0) setExpandedProducts(new Set());
                else {
                  const allIds = new Set(batches.map(b => b.product_id));
                  setExpandedProducts(allIds);
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition"
            >
              {expandedProducts.size > 0 ? 'Collapse All' : 'Expand All'}
            </button>
          </div>

          {loading ? (
            <div className="p-8 text-center">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mx-auto" />
              <p className="mt-3 text-gray-500 text-sm">Loading batches...</p>
            </div>
          ) : (() => {
            const q = batchSearch.trim().toLowerCase().replace(/\s+/g, ' ');
            const filtered = batches.filter(batch => {
              const isArchived = !batch.is_active;
              if (!showArchived && isArchived) return false;
              if (!q) return true;

              const batchNo = (batch.batch_number || '').toLowerCase();
              const prodName = (batch.products?.product_name || '').toLowerCase();
              const prodCode = (batch.products?.product_code || '').toLowerCase();
              const supplier = (batch.product_sources?.supplier_name || '').toLowerCase();
              const containerRef = (
                batch.import_containers?.container_ref ||
                (batch.import_container_id ? containerMap.get(batch.import_container_id) : '') ||
                ''
              ).toLowerCase();

              // 1. Direct match on any of the unified search dimensions (Batch #, Product, or Container)
              if (
                batchNo.includes(q) ||
                prodName.includes(q) ||
                prodCode.includes(q) ||
                supplier.includes(q) ||
                containerRef.includes(q)
              ) {
                return true;
              }

              // 2. Multi-word keyword match across combined batch identity
              if (q.includes(' ')) {
                const combined = `${batchNo} ${prodName} ${prodCode} ${supplier} ${containerRef}`;
                return q.split(' ').every(word => combined.includes(word));
              }

              return false;
            });

            const grouped = new Map<string, { productName: string; productCode: string; unit: string; productId: string; batches: typeof filtered }>();
            filtered.forEach(batch => {
              const key = batch.product_id;
              if (!grouped.has(key)) {
                grouped.set(key, {
                  productName: batch.products?.product_name || '',
                  productCode: batch.products?.product_code || '',
                  unit: batch.products?.unit || '',
                  productId: key,
                  batches: [],
                });
              }
              grouped.get(key)!.batches.push(batch);
            });

            const sortedGroups = Array.from(grouped.values()).sort((a, b) => {
              const aStock = a.batches.reduce((s, bt) => s + bt.current_stock, 0);
              const bStock = b.batches.reduce((s, bt) => s + bt.current_stock, 0);
              if (aStock > 0 && bStock <= 0) return -1;
              if (aStock <= 0 && bStock > 0) return 1;
              return a.productName.localeCompare(b.productName);
            });

            if (sortedGroups.length === 0) {
              return (
                <div className="px-6 py-8 text-center text-gray-400 text-sm">
                  {batchSearch ? 'No batches match your search.' : 'No batches found.'}
                </div>
              );
            }

            return (
              <div>
                <table className="hidden md:table w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="pl-3 pr-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-8"></th>
                      <th className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Product Name</th>
                      <th className="px-2 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-28">Code</th>
                      <th className="px-2 py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider w-20">Batches</th>
                      <th className="px-2 py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider w-28">Sold / Res</th>
                      <th className="px-2 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider w-28 pr-3">Stock</th>
                    </tr>
                  </thead>
                </table>
                {sortedGroups.map(group => {
                  const isExpanded = expandedProducts.has(group.productId) || !!batchSearch;
                  const totalStock = group.batches.reduce((s, b) => s + b.current_stock, 0);
                  const activeBatches = group.batches.filter(b => b.is_active);
                  const totalSold = group.batches.reduce((s, b) => s + (b.import_quantity - b.current_stock), 0);
                  const productRes = productReservationsMap.get(group.productId) || 0;
                  const productATP = productAtpMap.get(group.productId) ?? Math.max(0, totalStock - productRes);
                  const productShortage = productShortageMap.get(group.productId) || 0;
                  const legacyBatchRes = group.batches.reduce((s, b) => s + (b.reserved_stock || 0), 0);
                  const totalReserved = Math.max(productRes, legacyBatchRes);
                  const zeroStockActive = activeBatches.filter(b => b.current_stock <= 0).length;

                  return (
                    <div key={group.productId} className="border-b border-gray-200 last:border-b-0">
                      <button
                        onClick={() => toggleProduct(group.productId)}
                        className="w-full hover:bg-gray-50 transition text-left"
                      >
                        {/* Desktop Product Group Row */}
                        <table className="hidden md:table w-full text-sm">
                          <tbody>
                            <tr>
                              <td className="pl-3 pr-2 py-2 w-8">
                                {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                              </td>
                              <td className="px-2 py-2">
                                <span className="font-semibold text-gray-900">{group.productName}</span>
                              </td>
                              <td className="px-2 py-2 w-28 text-xs text-gray-400">{group.productCode}</td>
                              <td className="px-2 py-2 w-20 text-center">
                                <span className="text-xs text-blue-700 font-medium">{activeBatches.length}</span>
                                {zeroStockActive > 0 && (
                                  <span className="text-[10px] text-orange-500 ml-1">({zeroStockActive} out)</span>
                                )}
                              </td>
                              <td className="px-2 py-2 w-28 text-center">
                                <span className="text-xs text-gray-600">{totalSold.toLocaleString()}</span>
                                {totalReserved > 0 && (
                                  <span className="text-xs text-amber-600 ml-1">/ {totalReserved.toLocaleString()}</span>
                                )}
                                {productShortage > 0 && (
                                  <span className="text-[10px] text-red-600 font-semibold ml-1">(-{productShortage.toLocaleString()})</span>
                                )}
                              </td>
                              <td className={`px-2 py-2 w-28 text-right pr-3 text-sm font-semibold ${totalStock > 0 ? 'text-gray-900' : 'text-red-500'}`}>
                                {totalStock.toLocaleString()} {formatUnit(group.unit)}
                              </td>
                            </tr>
                          </tbody>
                        </table>

                        {/* Mobile Product Group Header Card */}
                        <div className="block md:hidden p-3 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
                            <div className="min-w-0">
                              <p className="font-semibold text-gray-900 text-sm truncate">{group.productName}</p>
                              <div className="flex items-center gap-1.5 text-xs text-gray-500 mt-0.5">
                                <span className="font-mono text-[11px] text-gray-400">{group.productCode}</span>
                                <span>•</span>
                                <span className="text-blue-700 font-medium">{activeBatches.length} batches</span>
                                {zeroStockActive > 0 && (
                                  <span className="text-[10px] text-orange-500 font-medium">({zeroStockActive} out)</span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p className={`text-sm font-bold ${totalStock > 0 ? 'text-gray-900' : 'text-red-500'}`}>
                              {totalStock.toLocaleString()} <span className="text-xs font-normal text-gray-500">{formatUnit(group.unit)}</span>
                            </p>
                            <p className="text-[10px] text-gray-500 mt-0.5">
                              {totalSold.toLocaleString()} sold {totalReserved > 0 ? `/ ${totalReserved.toLocaleString()} res` : ''}
                            </p>
                          </div>
                        </div>
                      </button>

                      {isExpanded && (
                        <div>
                          <div className="hidden md:block overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-3 py-1.5 text-left font-semibold text-gray-500 uppercase tracking-wider">Batch #</th>
                                <th className="px-3 py-1.5 text-left font-semibold text-gray-500 uppercase tracking-wider">Make / Manufacturer</th>
                                <th className="px-3 py-1.5 text-left font-semibold text-gray-500 uppercase tracking-wider w-24">Import</th>
                                <th className="px-3 py-1.5 text-right font-semibold text-gray-500 uppercase tracking-wider w-20">Stock</th>
                                <th className="px-3 py-1.5 text-right font-semibold text-gray-500 uppercase tracking-wider w-16">Res</th>
                                <th className="px-3 py-1.5 text-right font-semibold text-gray-500 uppercase tracking-wider w-16">Free</th>
                                {canViewCosting && (
                                  <>
                                    <th className="px-3 py-1.5 text-right font-semibold text-gray-500 uppercase tracking-wider w-32">Price/unit</th>
                                    <th className="px-3 py-1.5 text-right font-semibold text-gray-500 uppercase tracking-wider w-36">Landed/unit</th>
                                  </>
                                )}
                                <th className="px-3 py-1.5 text-left font-semibold text-gray-500 uppercase tracking-wider w-24">Expiry</th>
                                <th className="px-3 py-1.5 text-center font-semibold text-gray-500 uppercase tracking-wider w-10">D</th>
                                <th className="px-3 py-1.5 text-right font-semibold text-gray-500 uppercase tracking-wider">Container</th>
                                {canEdit && <th className="px-3 py-1.5 text-center font-semibold text-gray-500 uppercase tracking-wider w-24"></th>}
                              </tr>
                            </thead>
                            <tbody>
                              {group.batches
                                .sort((a, b) => new Date(b.import_date).getTime() - new Date(a.import_date).getTime())
                                .map(batch => {
                                  const batchAllocated = batch.reserved_stock || 0;
                                  const freeStock = Math.max(0, Math.min(batch.current_stock - batchAllocated, productATP));
                                  const landedCostPerUnit = batch.landed_cost_per_unit || batch.import_price;
                                  const containerPerUnit = (batch.import_cost_allocated && batch.import_quantity > 0) ? batch.import_cost_allocated / batch.import_quantity : 0;
                                  const fullLandedIDR = landedCostPerUnit;
                                  const hasUSD = batch.import_price_usd && batch.exchange_rate_usd_to_idr;
                                  const isArchived = !batch.is_active;
                                  const isSoldOut = batch.current_stock <= 0 && batch.is_active;

                                  return (
                                    <tr key={batch.id} className={`border-t border-gray-100 hover:bg-gray-50 ${isArchived ? 'opacity-50 bg-gray-50' : isSoldOut ? 'bg-orange-50/30' : ''}`}>
                                      <td className="px-3 py-1.5">
                                        <button
                                          onClick={() => showTransactionHistory(batch.product_id, batch.products?.product_name || '', batch.products?.product_code || '', batch.id, batch.batch_number, batch.products?.unit || '')}
                                          className="font-mono text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
                                        >
                                          {batch.batch_number}
                                        </button>
                                        {isArchived && <span className="ml-1.5 text-[10px] text-gray-400 bg-gray-200 px-1 rounded">archived</span>}
                                      </td>
                                      <td className="px-3 py-1.5 text-gray-600">{batch.product_sources?.supplier_name || 'Not recorded'}</td>
                                      <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{formatDate(batch.import_date)}</td>
                                      <td className="px-3 py-1.5 text-right">
                                        <span className={`font-semibold ${batch.current_stock <= 0 ? 'text-red-500' : isLowStock(batch) ? 'text-orange-600' : 'text-gray-900'}`}>
                                          {batch.current_stock.toLocaleString()}
                                        </span>
                                      </td>
                                      <td className="px-3 py-1.5 text-right">
                                        {batchAllocated > 0 ? (
                                          <span className="text-amber-600 font-medium">{batchAllocated.toLocaleString()}</span>
                                        ) : productRes > 0 ? (
                                          <span className="text-amber-600/80 text-[10px] font-medium" title={`Product pool has ${productRes.toLocaleString()} reserved across orders`}>pool</span>
                                        ) : (
                                          <span className="text-gray-300">-</span>
                                        )}
                                      </td>
                                      <td className="px-3 py-1.5 text-right">
                                        <span className={`font-semibold ${freeStock <= 0 ? 'text-red-500' : 'text-green-600'}`}>
                                          {freeStock.toLocaleString()}
                                        </span>
                                      </td>
                                      {canViewCosting && (
                                        <>
                                          <td className="px-3 py-1.5 text-right">
                                            {hasUSD ? (
                                              <div>
                                                <span className="text-green-700 font-medium">{formatCurrency(batch.import_price_usd!, 'USD')}</span>
                                                <div className="text-[10px] text-gray-400">{formatCurrency(batch.import_price)} @ {batch.exchange_rate_usd_to_idr!.toLocaleString('id-ID')}</div>
                                              </div>
                                            ) : (
                                              <span className="text-gray-700 font-medium">{formatCurrency(batch.import_price)}</span>
                                            )}
                                          </td>
                                          <td className="px-3 py-1.5 text-right">
                                            {hasUSD ? (
                                              <div>
                                                <span className="text-blue-700 font-medium">{formatCurrency(fullLandedIDR / batch.exchange_rate_usd_to_idr!, 'USD')}</span>
                                                <div className="text-[10px] text-gray-500">{formatCurrency(fullLandedIDR)}</div>
                                                {containerPerUnit > 0 && (
                                                  <div className="text-[10px] text-gray-400">incl. ctr {formatCurrency(containerPerUnit)}/u</div>
                                                )}
                                              </div>
                                            ) : (
                                              <div>
                                                <span className="text-blue-700 font-medium">{formatCurrency(fullLandedIDR)}</span>
                                                {containerPerUnit > 0 && (
                                                  <div className="text-[10px] text-gray-400">incl. ctr {formatCurrency(containerPerUnit)}/u</div>
                                                )}
                                              </div>
                                            )}
                                          </td>
                                        </>
                                      )}
                                      <td className="px-3 py-1.5 whitespace-nowrap">
                                        <span className={isExpired(batch) ? 'text-red-600 font-semibold' : isNearExpiry(batch) ? 'text-orange-500 font-semibold' : 'text-gray-600'}>
                                          {batch.expiry_date ? formatDate(batch.expiry_date) : '—'}
                                        </span>
                                      </td>
                                      <td className="px-3 py-1.5 text-center">
                                        <button onClick={() => loadBatchDocuments(batch.id)} className="text-blue-600 hover:text-blue-800" title="Documents">
                                          <FileText className="w-3 h-3 inline" />
                                          <span className="ml-0.5">{batch.document_count || 0}</span>
                                        </button>
                                      </td>
                                      <td className="px-3 py-1.5 text-right text-gray-400 text-[10px] truncate max-w-[130px]" title={batch.import_containers?.container_ref || (batch.import_container_id ? containerMap.get(batch.import_container_id) : '') || undefined}>
                                        {batch.import_containers?.container_ref || (batch.import_container_id ? containerMap.get(batch.import_container_id) : '') || '—'}
                                      </td>
                                      {canEdit && (
                                        <td className="px-3 py-1.5 text-center">
                                          <div className="flex items-center justify-center gap-0.5">
                                            <button onClick={() => handleEdit(batch)} className="p-1 text-blue-600 hover:bg-blue-50 rounded" title="Edit">
                                              <Edit className="w-3 h-3" />
                                            </button>
                                            {isSoldOut && (
                                              <button onClick={() => handleArchiveBatch(batch.id)} className="p-1 text-gray-500 hover:bg-gray-100 rounded" title="Archive">
                                                <Archive className="w-3 h-3" />
                                              </button>
                                            )}
                                            {isArchived && (
                                              <button onClick={() => handleUnarchiveBatch(batch.id)} className="p-1 text-green-600 hover:bg-green-50 rounded" title="Restore">
                                                <Eye className="w-3 h-3" />
                                              </button>
                                            )}
                                            <button onClick={() => handleDelete(batch.id)} className="p-1 text-red-600 hover:bg-red-50 rounded" title="Delete">
                                              <Trash2 className="w-3 h-3" />
                                            </button>
                                          </div>
                                        </td>
                                      )}
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                        </div>

                        {/* Mobile Native Card View */}
                        <div className="block md:hidden divide-y divide-gray-100 p-2 space-y-2 bg-slate-50/70">
                          {group.batches
                            .sort((a, b) => new Date(b.import_date).getTime() - new Date(a.import_date).getTime())
                            .map(batch => {
                              const batchAllocated = batch.reserved_stock || 0;
                              const freeStock = Math.max(0, Math.min(batch.current_stock - batchAllocated, productATP));
                              const landedCostPerUnit = batch.landed_cost_per_unit || batch.import_price;
                              const fullLandedIDR = landedCostPerUnit;
                              const isArchived = !batch.is_active;
                              const isSoldOut = batch.current_stock <= 0 && batch.is_active;

                              return (
                                <div key={batch.id} className="bg-white rounded-xl border border-slate-200/90 shadow-2xs p-2.5 space-y-1.5 hover:border-slate-300 transition">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <button
                                        onClick={() => showTransactionHistory(batch.product_id, batch.products?.product_name || '', batch.products?.product_code || '', batch.id, batch.batch_number, batch.products?.unit || '')}
                                        className="font-mono text-xs font-bold text-blue-600 hover:text-blue-800 underline"
                                      >
                                        {batch.batch_number}
                                      </button>
                                      {isArchived && <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded font-medium">Archived</span>}
                                      {isSoldOut && <span className="text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-medium">Sold Out</span>}
                                      {isExpired(batch) ? (
                                        <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">Expired</span>
                                      ) : isNearExpiry(batch) ? (
                                        <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">Near Expiry</span>
                                      ) : null}
                                    </div>
                                    {canEdit && (
                                      <div className="flex items-center gap-1">
                                        <button onClick={() => handleEdit(batch)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="Edit">
                                          <Edit className="w-3.5 h-3.5" />
                                        </button>
                                        {isSoldOut && (
                                          <button onClick={() => handleArchiveBatch(batch.id)} className="p-1.5 text-gray-500 hover:bg-gray-100 rounded" title="Archive">
                                            <Archive className="w-3.5 h-3.5" />
                                          </button>
                                        )}
                                        {isArchived && (
                                          <button onClick={() => handleUnarchiveBatch(batch.id)} className="p-1.5 text-green-600 hover:bg-green-50 rounded" title="Restore">
                                            <Eye className="w-3.5 h-3.5" />
                                          </button>
                                        )}
                                        <button onClick={() => handleDelete(batch.id)} className="p-1.5 text-red-600 hover:bg-red-50 rounded" title="Delete">
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                    )}
                                  </div>

                                  {/* 3-Column Stock Metric Grid */}
                                  <div className="grid grid-cols-3 gap-2 bg-slate-50 p-2 rounded-lg border border-slate-100 text-center">
                                    <div>
                                      <p className="text-[10px] text-gray-500 font-medium uppercase">Current</p>
                                      <p className={`text-xs font-bold ${batch.current_stock <= 0 ? 'text-red-500' : isLowStock(batch) ? 'text-orange-600' : 'text-gray-900'}`}>
                                        {batch.current_stock.toLocaleString()}
                                      </p>
                                    </div>
                                    <div>
                                      <p className="text-[10px] text-gray-500 font-medium uppercase">Reserved</p>
                                      <p className="text-xs font-semibold text-amber-600">
                                        {batchAllocated > 0 ? batchAllocated.toLocaleString() : '-'}
                                      </p>
                                    </div>
                                    <div>
                                      <p className="text-[10px] text-gray-500 font-medium uppercase">Available</p>
                                      <p className={`text-xs font-bold ${freeStock <= 0 ? 'text-red-500' : 'text-green-600'}`}>
                                        {freeStock.toLocaleString()}
                                      </p>
                                    </div>
                                  </div>

                                  {/* Details Grid */}
                                  <div className="grid grid-cols-2 gap-1.5 text-[11px] text-gray-600 pt-1 border-t border-slate-100">
                                    <div>
                                      <span className="text-gray-400">Maker: </span>
                                      <span className="font-medium truncate">{batch.product_sources?.supplier_name || '—'}</span>
                                    </div>
                                    <div>
                                      <span className="text-gray-400">Import: </span>
                                      <span>{formatDate(batch.import_date)}</span>
                                    </div>
                                    <div>
                                      <span className="text-gray-400">Expiry: </span>
                                      <span className={isExpired(batch) ? 'text-red-600 font-semibold' : ''}>{batch.expiry_date ? formatDate(batch.expiry_date) : '—'}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <div className="truncate">
                                        <span className="text-gray-400">Ctr: </span>
                                        <span className="truncate">{batch.import_containers?.container_ref || (batch.import_container_id ? containerMap.get(batch.import_container_id) : '') || '—'}</span>
                                      </div>
                                      <button onClick={() => loadBatchDocuments(batch.id)} className="text-blue-600 hover:text-blue-800 flex items-center gap-0.5 ml-1" title="Documents">
                                        <FileText className="w-3 h-3 inline" />
                                        <span className="text-[10px] font-medium">{batch.document_count || 0}</span>
                                      </button>
                                    </div>
                                  </div>

                                  {/* Costing Section */}
                                  {canViewCosting && (
                                    <div className="bg-blue-50/60 p-2 rounded-lg border border-blue-100/70 text-[11px] flex items-center justify-between">
                                      <div>
                                        <span className="text-gray-500">Price/u: </span>
                                        <span className="font-semibold text-gray-900">{formatCurrency(batch.import_price)}</span>
                                      </div>
                                      <div>
                                        <span className="text-gray-500">Landed/u: </span>
                                        <span className="font-semibold text-blue-700">{formatCurrency(fullLandedIDR)}</span>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* Summary Section */}
        {canViewCosting && batches.length > 0 && (
          <div className="bg-white rounded-xl shadow-xs p-3.5 border border-slate-200">
            <h3 className="text-sm font-bold text-gray-900 mb-2.5 flex items-center gap-1.5">
              <DollarSign className="w-4 h-4 text-blue-600" />
              Total Import Value Summary
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                <p className="text-xs text-gray-500 font-medium">Total Value (USD)</p>
                <p className="text-lg font-bold text-green-700 mt-0.5">
                  {formatCurrency(
                    batches.reduce((sum, batch) => {
                      const totalUSD = batch.import_price_usd ? batch.import_price_usd * batch.import_quantity : 0;
                      return sum + totalUSD;
                    }, 0),
                    'USD'
                  )}
                </p>
              </div>
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                <p className="text-xs text-gray-500 font-medium">Total Value (IDR)</p>
                <p className="text-lg font-bold text-blue-700 mt-0.5">
                  {formatCurrency(
                    batches.reduce((sum, batch) => {
                      const totalIDR = batch.import_price * batch.import_quantity;
                      return sum + totalIDR;
                    }, 0)
                  )}
                </p>
              </div>
            </div>
            {/* Stock in Hand Value at Landed Cost */}
            <div className="mt-3 pt-3 border-t border-slate-100">
              <h4 className="text-xs font-bold text-gray-700 mb-2 flex items-center gap-1">
                <Package className="w-4 h-4 text-gray-500" />
                Stock in Hand Value (at Landed Cost)
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div className="bg-white rounded-lg p-3 border border-blue-100">
                  <p className="text-xs text-gray-500 mb-1">Stock in Hand Value (IDR)</p>
                  <p className="text-xl font-bold text-gray-800">
                    {formatCurrency(
                      batches.reduce((sum, batch) => {
                        const landedCostPerUnit = batch.landed_cost_per_unit ?? batch.import_price;
                        return sum + (batch.current_stock * landedCostPerUnit);
                      }, 0)
                    )}
                  </p>
                </div>
                <div className="bg-white rounded-lg p-3 border border-blue-100">
                  <p className="text-xs text-gray-500 mb-1">Stock in Hand Quantity</p>
                  <p className="text-xl font-bold text-gray-800">
                    {batches.reduce((sum, batch) => sum + batch.current_stock, 0).toLocaleString()}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    of {batches.reduce((sum, batch) => sum + batch.import_quantity, 0).toLocaleString()} imported
                  </p>
                </div>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-600">Total Batches:</span>
                <span className="font-semibold text-gray-900">{batches.length}</span>
              </div>
              <div className="flex justify-between items-center text-sm mt-1">
                <span className="text-gray-600">Total Import Quantity:</span>
                <span className="font-semibold text-gray-900">
                  {batches.reduce((sum, batch) => sum + batch.import_quantity, 0).toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        )}

        <Modal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            resetForm();
          }}
          title={pendingInwardContext ? 'Approve Inward — Batch Details' : editingBatch ? 'Edit Batch' : 'Add New Batch'}
          size="xl"
        >
          <form onSubmit={handleSubmit} className="space-y-2">
            <div className="border-b pb-1.5">
              <h3 className="text-xs font-semibold text-gray-900 mb-1.5">Basic Information</h3>
              <SapRow>
                <FloatingField label="Batch Number" filled={!!formData.batch_number} required span={6}>
                  <input name="batch_number" aria-label="Batch Number"
                    type="text"
                    value={formData.batch_number}
                    onChange={(e) => setFormData({ ...formData, batch_number: e.target.value })}
                    className={FLOAT_INPUT}
                    required
                  />
                </FloatingField>

                <FloatingField label="Import Date" filled={!!formData.import_date} required span={3}>
                  <input name="import_date" aria-label="Import Date"
                    type="date"
                    value={formData.import_date}
                    onChange={(e) => setFormData({ ...formData, import_date: e.target.value })}
                    className={FLOAT_INPUT}
                    required
                  />
                </FloatingField>

                <FloatingField label="Expiry Date" filled={!!formData.expiry_date} span={3}>
                  <input name="expiry_date" aria-label="Expiry Date"
                    type="date"
                    value={formData.expiry_date}
                    onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })}
                    className={FLOAT_INPUT}
                  />
                </FloatingField>
              </SapRow>

              <SapRow>
                <FloatingField label="Product" filled={!!formData.product_id} required span={4}>
                  <SearchableSelect
                    value={formData.product_id}
                    onChange={async (value) => {
                      const selectedProduct = products.find(p => p.id === value);
                      const rawPackType = selectedProduct?.pack_type || selectedProduct?.packaging_type;
                      const normPackType = (normalizePackagingType(rawPackType) || 'Bag').toLowerCase();
                      const defaultPerPack = selectedProduct?.per_pack_weight != null ? String(selectedProduct.per_pack_weight) : '';

                      const newFormData = {
                        ...formData,
                        product_id: value,
                        make_id: '',
                        duty_percent: selectedProduct?.duty_percent || 0,
                        pack_type: normPackType,
                        per_pack_weight: defaultPerPack,
                      };

                      if (formData.import_quantity && defaultPerPack) {
                        const perPack = parseFloat(defaultPerPack);
                        if (perPack > 0) {
                          const packs = (formData.import_quantity / perPack).toFixed(0);
                          const prodUnit = abbreviateUnit(selectedProduct?.unit || '');
                          newFormData.packaging_details = `${packs} ${normPackType}${parseInt(packs) !== 1 ? 's' : ''} x ${perPack}${prodUnit}`;
                        }
                      }

                      setFormData(newFormData);
                      await loadProductMakes(value);
                    }}
                    options={products.map(p => ({
                      value: p.id,
                      label: `${p.product_name}${p.product_code ? ` (${p.product_code})` : ''}`
                    }))}
                    placeholder="Select Product"
                    className="text-sm"
                    required
                  />
                </FloatingField>

                <FloatingField label={`Make / Manufacturer${editingBatch ? '' : ''}`} filled={!!formData.make_id} required={!editingBatch} span={4}>
                  <SearchableSelect
                    value={formData.make_id}
                    onChange={(value) => setFormData({ ...formData, make_id: value })}
                    options={productMakes.map(m => ({ value: m.id, label: `${m.supplier_name || 'Unnamed make'}${m.grade ? ` (${m.grade})` : ''}` }))}
                    placeholder={productMakes.length ? 'Select Make / Manufacturer' : 'No makes recorded'}
                    className="text-sm"
                    required={!editingBatch}
                  />
                </FloatingField>
                {!productMakes.length && <div className="sm:col-span-12"><p className="text-xs text-amber-600 mt-0.5">Add a Make / Manufacturer in the Product record first.</p></div>}

                <FloatingField label="Import Container (Optional)" filled={!!formData.import_container_id} span={4}>
                  <SearchableSelect
                    value={formData.import_container_id}
                    onChange={(value) => {
                      const selectedContainer = importContainers.find(c => c.id === value);
                      setFormData(prev => ({
                        ...prev,
                        import_container_id: value,
                        customs_ndpbm_rate: prev.customs_ndpbm_rate || selectedContainer?.customs_ndpbm_rate || null,
                      }));
                    }}
                    options={[
                      { value: '', label: 'Select Container (Optional)' },
                      ...importContainers.map(c => ({
                        value: c.id,
                        label: `${c.container_ref} (${c.status})`
                      }))
                    ]}
                    placeholder="Select Container"
                    className="text-sm"
                  />
                </FloatingField>
              </SapRow>
              <p className="text-xs text-gray-500 mt-0.5">Link batch to import container for cost allocation</p>
            </div>

            <div className="border-b pb-1.5">
              <h3 className="text-xs font-semibold text-gray-900 mb-1.5">Quantity</h3>
              <SapRow>
                <FloatingField label={`Import Quantity ${modalProductDisplayUnit ? `(${modalProductDisplayUnit})` : ''}`} filled={!!formData.import_quantity} required span={6}>
                  <input name="import_quantity" aria-label="Import Quantity"
                    type="number"
                    value={formData.import_quantity === 0 ? '' : formData.import_quantity}
                    onChange={(e) => setFormData({ ...formData, import_quantity: e.target.value === '' ? 0 : Number(e.target.value) })}
                    className={FLOAT_INPUT}
                    required
                    min="0"
                    step="0.001"
                    placeholder="0"
                  />
                </FloatingField>

                {editingBatch && (
                  <FloatingField label={`Current Stock ${modalProductDisplayUnit ? `(${modalProductDisplayUnit})` : ''}`} filled={!!editingBatch.current_stock} span={6} staticLabel>
                    <div className={FLOAT_INPUT + ' flex items-center font-medium text-gray-700'}>
                      <span>
                        {editingBatch.current_stock.toLocaleString()}{modalProductDisplayUnit ? ` ${modalProductDisplayUnit}` : ''}
                      </span>
                    </div>
                  </FloatingField>
                )}
              </SapRow>
              <p className="text-xs text-gray-500 mt-0.5">Total quantity being imported</p>
              {editingBatch && (
                <p className="text-xs text-gray-500 mt-0.5">
                  Available: {editingBatch.current_stock.toLocaleString()}{modalProductDisplayUnit ? ` ${modalProductDisplayUnit}` : ''} |
                  Sold: {(editingBatch.import_quantity - editingBatch.current_stock).toLocaleString()}{modalProductDisplayUnit ? ` ${modalProductDisplayUnit}` : ''}
                </p>
              )}
            </div>

            <div className="border-b pb-1.5">
              <h3 className="text-xs font-semibold text-gray-900 mb-1 flex items-center gap-1.5">
                <Package className="w-3.5 h-3.5" />
                Packaging Details (Optional)
              </h3>
              <SapRow>
                <FloatingField label="Per Pack Weight" filled={!!formData.per_pack_weight} span={4}>
                  <input name="per_pack_weight" aria-label="Per Pack Weight"
                    type="number"
                    step="0.001"
                    value={formData.per_pack_weight}
                    onChange={(e) => {
                      const newFormData = { ...formData, per_pack_weight: e.target.value };
                      if (formData.import_quantity && e.target.value) {
                        const perPack = parseFloat(e.target.value);
                        if (perPack) {
                          const packs = (formData.import_quantity / perPack).toFixed(0);
                          newFormData.packaging_details = `${packs} ${formData.pack_type}${parseInt(packs) !== 1 ? 's' : ''} x ${perPack}${modalPackUnit}`;
                        }
                      }
                      setFormData(newFormData);
                    }}
                    placeholder="e.g., 25"
                    className={FLOAT_INPUT}
                  />
                </FloatingField>

                <FloatingField label="Pack Type" filled={!!formData.pack_type} span={4}>
                  <select name="pack_type" aria-label="Pack Type"
                    value={formData.pack_type}
                    onChange={(e) => {
                      const newFormData = { ...formData, pack_type: e.target.value };
                      if (formData.import_quantity && formData.per_pack_weight) {
                        const perPack = parseFloat(formData.per_pack_weight);
                        if (perPack) {
                          const packs = (formData.import_quantity / perPack).toFixed(0);
                          newFormData.packaging_details = `${packs} ${e.target.value}${parseInt(packs) !== 1 ? 's' : ''} x ${perPack}${modalPackUnit}`;
                        }
                      }
                      setFormData(newFormData);
                    }}
                    className={FLOAT_INPUT}
                  >
                    {PACKAGING_TYPES.map(type => (
                      <option key={type} value={type.toLowerCase()}>{type}</option>
                    ))}
                  </select>
                </FloatingField>

                <FloatingField label="Calculated Packs" filled={!!(formData.import_quantity && formData.per_pack_weight)} span={4} staticLabel>
                  <div className={FLOAT_INPUT + ' flex items-center font-medium text-gray-700'}>
                    <span>
                      {formData.import_quantity && formData.per_pack_weight
                        ? Math.ceil(formData.import_quantity / parseFloat(formData.per_pack_weight))
                        : '-'}
                    </span>
                  </div>
                </FloatingField>
              </SapRow>
              <p className="text-xs text-gray-500 mt-0.5">{modalPackUnit ? `${modalPackUnit} per pack` : 'per pack'} · Total packs</p>

              {formData.packaging_details && (
                <div className="mt-1 p-1.5 bg-blue-50 border border-blue-200 rounded">
                  <p className="text-xs text-blue-900">
                    <span className="font-semibold">Packaging: </span>
                    {formatPackagingDetails(formData.packaging_details, rawModalUnit)}
                  </p>
                </div>
              )}
            </div>

            {canViewCosting && (
              <>
                <div className="border-b pb-1.5">
                  <h3 className="text-xs font-semibold text-gray-900 mb-1 flex items-center gap-1.5">
                    <DollarSign className="w-3.5 h-3.5 text-green-600" />
                    Purchase Price
                  </h3>
                  <SapRow>
                    <FloatingField label="Purchase Price (USD)" filled={!!formData.import_price_usd} span={4}>
                      <MoneyInput
                        value={formData.import_price_usd}
                        onChange={handleUSDChange}
                        className={FLOAT_INPUT}
                        min="0"
                        placeholder="0.00"
                        maximumFractionDigits={4}
                      />
                    </FloatingField>

                    <FloatingField label="Purchase Price (IDR)" filled={!!formData.import_price_idr} span={4}>
                      <MoneyInput
                        value={formData.import_price_idr}
                        onChange={handleIDRChange}
                        className={FLOAT_INPUT}
                        min="0"
                        placeholder="0"
                      />
                    </FloatingField>

                    <FloatingField label="Exchange Rate (IDR per USD)" filled={!!formData.exchange_rate_usd_to_idr} span={4}>
                      <input name="exchange_rate_idr_per_usd" aria-label="Exchange Rate (IDR per USD)"
                        type="number"
                        value={formData.exchange_rate_usd_to_idr === 0 ? '' : formData.exchange_rate_usd_to_idr}
                        onChange={(e) => handleExchangeRateChange(e.target.value === '' ? 0 : Number(e.target.value))}
                        className={FLOAT_INPUT}
                        min="0"
                        step="0.0001"
                        placeholder="17000"
                      />
                    </FloatingField>
                  </SapRow>
                  <p className="text-xs text-gray-500 mt-0.5">
                    1 USD = {formData.exchange_rate_usd_to_idr.toLocaleString()} IDR
                  </p>

                  {((formData.import_price_usd > 0 || formData.import_price_idr > 0) && formData.exchange_rate_usd_to_idr > 0) && (
                    <div className="mt-1 p-1.5 bg-green-50 border border-green-200 rounded">
                      <p className="text-xs text-green-800">
                        <span className="font-semibold">Purchase Price (IDR):</span>{' '}
                        {formatCurrency(formData.import_price_usd > 0 ? formData.import_price_usd * formData.exchange_rate_usd_to_idr : formData.import_price_idr)}
                      </p>
                      {formData.import_price_usd > 0 && (
                        <p className="text-xs text-green-600 mt-0.5">
                          {formatCurrency(formData.import_price_usd, 'USD')} × {formData.exchange_rate_usd_to_idr.toLocaleString()} = {formatCurrency(formData.import_price_usd * formData.exchange_rate_usd_to_idr)}
                        </p>
                      )}
                      {formData.import_price_idr > 0 && formData.import_price_usd <= 0 && (
                        <p className="text-xs text-green-600 mt-0.5">
                          {formatCurrency(formData.import_price_idr)} ÷ {formData.exchange_rate_usd_to_idr.toLocaleString()} = {formatCurrency(formData.import_price_idr / formData.exchange_rate_usd_to_idr, 'USD')}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-b pb-1.5">
                  <h3 className="text-xs font-semibold text-gray-900 mb-1">Additional Charges</h3>
                  <SapRow>
                    <FloatingField label="Duty (Form A1 %)" filled={!!formData.duty_percent} span={3}
                      right={<div className="text-xs text-gray-500 flex items-center px-1">%</div>}>
                      <input name="duty_form_a1" aria-label="Duty (Form A1 %)"
                        type="number"
                        value={formData.duty_percent === 0 ? '' : formData.duty_percent}
                        onChange={(e) => setFormData({ ...formData, duty_percent: e.target.value === '' ? 0 : Number(e.target.value) })}
                        className={FLOAT_INPUT}
                        min="0"
                        max="100"
                        step="0.01"
                        placeholder="Auto from product"
                      />
                    </FloatingField>

                    <FloatingField
                      label="Customs NDPBM (IDR per USD)"
                      filled={formData.customs_ndpbm_rate !== null && formData.customs_ndpbm_rate !== undefined && formData.customs_ndpbm_rate > 0}
                      span={3}
                      hint={formData.import_container_id ? 'Auto from linked container' : 'PIB Customs Duty FX Rate'}
                    >
                      <input
                        name="customs_ndpbm_rate"
                        aria-label="Customs NDPBM (IDR per USD)"
                        type="number"
                        value={formData.customs_ndpbm_rate === 0 || !formData.customs_ndpbm_rate ? '' : formData.customs_ndpbm_rate}
                        onChange={(e) => setFormData({ ...formData, customs_ndpbm_rate: e.target.value === '' ? null : Number(e.target.value) })}
                        className={FLOAT_INPUT}
                        min="0"
                        step="0.0001"
                        placeholder="e.g. 16813.00"
                      />
                    </FloatingField>

                    <FloatingField label="Freight" filled={!!formData.freight_charges} span={3}
                      right={
                        <select name="freight_charge_type" aria-label="Freight Charge Type"
                          value={formData.freight_charge_type}
                          onChange={(e) => setFormData({ ...formData, freight_charge_type: e.target.value as 'percentage' | 'fixed' })}
                          className="w-12 px-0.5 py-0 text-xs border-0 border-l border-gray-300 rounded-l bg-transparent focus:outline-none h-full"
                        >
                          <option value="percentage">%</option>
                          <option value="fixed">Rp</option>
                        </select>
                      }>
                      {formData.freight_charge_type === 'fixed' ? (
                        <MoneyInput
                          value={formData.freight_charges}
                          onChange={(amount) => setFormData({ ...formData, freight_charges: amount })}
                          className={FLOAT_INPUT}
                          min="0"
                          placeholder="0"
                          maximumFractionDigits={4}
                        />
                      ) : (
                        <input name="freight_charges" aria-label="Freight charges"
                          data-non-currency="percentage"
                          type="number"
                          value={formData.freight_charges === 0 ? '' : formData.freight_charges}
                          onChange={(e) => setFormData({ ...formData, freight_charges: e.target.value === '' ? 0 : Number(e.target.value) })}
                          className={FLOAT_INPUT}
                          min="0"
                          step="0.01"
                          placeholder="0"
                        />
                      )}
                    </FloatingField>

                    <FloatingField label="Other" filled={!!formData.other_charges} span={3}
                      right={
                        <select name="other_charge_type" aria-label="Other Charge Type"
                          value={formData.other_charge_type}
                          onChange={(e) => setFormData({ ...formData, other_charge_type: e.target.value as 'percentage' | 'fixed' })}
                          className="w-12 px-0.5 py-0 text-xs border-0 border-l border-gray-300 rounded-l bg-transparent focus:outline-none h-full"
                        >
                          <option value="percentage">%</option>
                          <option value="fixed">Rp</option>
                        </select>
                      }>
                      {formData.other_charge_type === 'fixed' ? (
                        <MoneyInput
                          value={formData.other_charges}
                          onChange={(amount) => setFormData({ ...formData, other_charges: amount })}
                          className={FLOAT_INPUT}
                          min="0"
                          placeholder="0"
                          maximumFractionDigits={4}
                        />
                      ) : (
                        <input name="other_charges" aria-label="Other charges"
                          data-non-currency="percentage"
                          type="number"
                          value={formData.other_charges === 0 ? '' : formData.other_charges}
                          onChange={(e) => setFormData({ ...formData, other_charges: e.target.value === '' ? 0 : Number(e.target.value) })}
                          className={FLOAT_INPUT}
                          min="0"
                          step="0.01"
                          placeholder="0"
                        />
                      )}
                    </FloatingField>
                  </SapRow>

                  {/* Missing NDPBM Warning if container linked but no NDPBM */}
                  {formData.import_container_id && (!formData.customs_ndpbm_rate || formData.customs_ndpbm_rate <= 0) && (
                    <div className="mt-2 p-2 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900 flex items-start gap-1.5">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold">Missing Customs NDPBM Rate:</span> The linked import container has no saved Customs Duty FX Rate (NDPBM). Duty cannot be calculated without an official NDPBM rate. Supplier Purchase FX will not be used as fallback.
                      </div>
                    </div>
                  )}

                  {/* Simplified Duty Calculation Display */}
                  {(formData.duty_percent > 0 || (formData.customs_ndpbm_rate && formData.customs_ndpbm_rate > 0)) && (
                    <div className="mt-1.5 px-2.5 py-1.5 bg-blue-50 border border-blue-200 rounded text-xs flex flex-wrap items-center justify-between gap-1 text-blue-900">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-blue-950">Calculated Duty:</span>
                        <span className="font-mono font-bold text-blue-900">
                          {formatCurrency(getDutyPerUnit())} {modalProductDisplayUnit ? `/ ${modalProductDisplayUnit}` : '/ unit'}
                        </span>
                        {getDutyDetails().formula && (
                          <span className="text-blue-600 text-[11px]">
                            ({getDutyDetails().formula})
                          </span>
                        )}
                      </div>
                      <div className="text-right">
                        <span className="text-blue-700 font-medium">Total Duty: </span>
                        <span className="font-mono font-bold text-blue-950">
                          {formatCurrency(getDutyDetails().total)}
                        </span>
                        {getDutyDetails().roundingDiff > 0 && (
                          <span className="text-blue-500 text-[10px] ml-1">
                            (DJBC +{formatCurrency(getDutyDetails().roundingDiff)})
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {formData.freight_charges > 0 && (
                    <p className="text-xs text-gray-600 mt-0.5">
                      Freight: = {formatCurrency(getChargeAmount(formData.freight_charges, formData.freight_charge_type))}
                    </p>
                  )}
                  {formData.other_charges > 0 && (
                    <p className="text-xs text-gray-600 mt-0.5">
                      Other: = {formatCurrency(getChargeAmount(formData.other_charges, formData.other_charge_type))}
                    </p>
                  )}
                </div>
              </>
            )}

            {canViewCosting && (
              <div className="bg-blue-50 border border-blue-200 rounded p-2">
              <h3 className="text-xs font-semibold text-blue-900 mb-1.5">Total Cost Summary</h3>
              <div className="space-y-0.5 text-xs text-blue-800">
                <div className="flex justify-between">
                  <span>Purchase Price (per unit):</span>
                  <span className="font-medium">
                    {formatCurrency(formData.import_price_idr > 0 && formData.import_price_usd <= 0 ? formData.import_price_idr : formData.import_price_usd * formData.exchange_rate_usd_to_idr)}
                  </span>
                </div>
                <div className="flex justify-between items-start">
                  <div>
                    <span>Duty (Form A1):</span>
                    {formData.duty_percent > 0 && (
                      <span className="text-xs ml-1 font-normal">({formData.duty_percent}%)</span>
                    )}
                    {getDutyPerUnit() > 0 && (
                      <div className="text-[10px] text-blue-600 font-normal">
                        Total: {formatCurrency(getDutyDetails().total)} at NDPBM Rp {Number(formData.customs_ndpbm_rate).toLocaleString()}
                      </div>
                    )}
                    {formData.duty_percent > 0 && (!formData.customs_ndpbm_rate || formData.customs_ndpbm_rate <= 0) && (
                      <div className="text-[10px] text-amber-600 font-normal">
                        (Missing NDPBM rate — duty not capitalized)
                      </div>
                    )}
                  </div>
                  <span className="font-medium text-right">
                    {formatCurrency(getDutyPerUnit())}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Freight Charges:</span>
                  <span className="font-medium">
                    {formatCurrency(getChargeAmount(formData.freight_charges, formData.freight_charge_type))}
                    {formData.freight_charge_type === 'percentage' && formData.freight_charges > 0 && (
                      <span className="text-xs ml-1">({formData.freight_charges}%)</span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Other Charges:</span>
                  <span className="font-medium">
                    {formatCurrency(getChargeAmount(formData.other_charges, formData.other_charge_type))}
                    {formData.other_charge_type === 'percentage' && formData.other_charges > 0 && (
                      <span className="text-xs ml-1">({formData.other_charges}%)</span>
                    )}
                  </span>
                </div>
                <div className="border-t border-blue-300 pt-1.5 mt-1.5 space-y-1">
                  <div className="flex justify-between">
                    <span className="font-bold">Total Cost (IDR):</span>
                    <span className="font-bold text-sm">{formatCurrency(calculateTotalCostIDR())}</span>
                  </div>
                  {formData.import_quantity > 0 && (
                    <div className="bg-green-50 border border-green-200 rounded px-2 py-1.5 mt-2">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-green-900">Total Batch Cost:</span>
                        <div className="text-right">
                          {formData.import_price_usd > 0 && (
                            <div className="font-bold text-green-700">
                              {formatCurrency(formData.import_price_usd * formData.import_quantity, 'USD')}
                            </div>
                          )}
                          <div className="text-xs text-green-600">
                            {formatCurrency(calculateTotalCostIDR() * formData.import_quantity)}
                          </div>
                        </div>
                      </div>
                      {formData.import_price_usd > 0 && (
                        <div className="text-xs text-green-700 mt-0.5">
                          {formatCurrency(formData.import_price_usd, 'USD')} × {formData.import_quantity} = {formatCurrency(formData.import_price_usd * formData.import_quantity, 'USD')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              </div>
            )}

            <div className="border-t pt-1.5">
              <h3 className="text-xs font-semibold text-gray-900 mb-1 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" />
                Import Documents
              </h3>
              <FileUpload
                batchId={editingBatch?.id}
                existingFiles={uploadedFiles}
                onFilesChange={setUploadedFiles}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  resetForm();
                }}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition"
              >
                {pendingInwardContext ? 'Approve Inward' : editingBatch ? 'Update Batch' : 'Add Batch'}
              </button>
            </div>
          </form>
        </Modal>

        <Modal
          isOpen={documentsModalOpen}
          onClose={() => {
            setDocumentsModalOpen(false);
            setSelectedBatchDocs([]);
            setSelectedBatchId(null);
          }}
          title="Batch Documents"
        >
          <div className="space-y-3">
            <div className="flex justify-end pb-1 border-b border-gray-100">
              <button
                type="button"
                onClick={() => setBatchBankAttachOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" /> Attach from Document Bank
              </button>
            </div>
            {selectedBatchDocs.length > 0 ? (
              selectedBatchDocs.map((doc) => (
                <a
                  key={doc.id}
                  href={signedUrlCache[doc.file_url] || doc.file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200 hover:bg-blue-50 hover:border-blue-300 transition"
                >
                  <FileText className="w-5 h-5 text-blue-600 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{doc.file_name}</p>
                    <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
                      <span className="capitalize">{doc.file_type.replace('_', ' ')}</span>
                      <span>•</span>
                      <span>{(doc.file_size / 1024).toFixed(1)} KB</span>
                      <span>•</span>
                      <span>{formatDate(doc.uploaded_at)}</span>
                    </div>
                  </div>
                  <ExternalLink className="w-4 h-4 text-gray-400 flex-shrink-0" />
                </a>
              ))
            ) : (
              <div className="text-center py-8 text-gray-500">
                <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p>No documents uploaded for this batch</p>
              </div>
            )}
          </div>
        </Modal>

        {/* Attach from Universal Document Bank */}
        {batchBankAttachOpen && selectedBatchId && (
          <AttachFromDocumentBankModal
            isOpen={batchBankAttachOpen}
            onClose={() => setBatchBankAttachOpen(false)}
            initialProductId={batches.find(b => b.id === selectedBatchId)?.product_id || null}
            initialBatchNumber={batches.find(b => b.id === selectedBatchId)?.batch_number || null}
            title="Attach Document to Batch"
            onDocumentSelected={handleAttachBatchDocFromBank}
          />
        )}

        {/* Stock Movements Ledger Modal */}
        <StockMovementsModal
          isOpen={transactionHistoryModal}
          onClose={() => {
            setTransactionHistoryModal(false);
            setSelectedProductForHistory(null);
          }}
          productId={selectedProductForHistory?.id}
          productName={selectedProductForHistory?.name}
          productCode={selectedProductForHistory?.code}
          batchId={selectedProductForHistory?.batchId}
          batchNumber={selectedProductForHistory?.batchNumber}
          unit={selectedProductForHistory?.unit}
        />
      </div>
    </Layout>
  );
}
