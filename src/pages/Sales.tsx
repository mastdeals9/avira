import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { InvoiceView } from '../components/InvoiceView';
import { DeliveryChallanView } from '../components/DeliveryChallanView';
import { ProformaInvoiceView } from '../components/ProformaInvoiceView';
import { DCMultiSelect } from '../components/DCMultiSelect';
import { SearchableSelect } from '../components/SearchableSelect';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useFinance } from '../contexts/FinanceContext';
import { supabase } from '../lib/supabase';
import { Plus, Pencil as Edit, Trash2, Eye, FileX, Lock, Ban, Archive } from 'lucide-react';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/dateFormat';
import { fetchLinkedDocumentsBundle, LinkedDocRef } from '../utils/linkedDocuments';
import { LinkedDocsCell } from '../components/LinkedDocsCell';
import { MoneyInput } from '../components/MoneyInput';
import { FloatingField, FLOAT_INPUT } from '../components/finance/FloatingField';
import { SapRow } from '../components/finance/SapLayout';
import { loadInvoiceDisplayItems } from '../utils/invoiceItemDisplay';
import { useErpSyncListener, emitErpSync } from '../utils/erpSyncBus';

function normalizeNestedRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

interface SalesInvoice {
  id: string;
  invoice_number: string;
  customer_id: string;
  sales_order_id?: string | null;
  invoice_date: string;
  due_date: string;
  subtotal: number;
  tax_amount: number;
  stamp_duty_amount: number;
  discount_amount: number;
  total_amount: number;
  document_status?: 'draft' | 'posted' | 'cancelled';
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  canceller_name?: string | null;
  cancellation_reason?: string | null;
  payment_status: 'pending' | 'partial' | 'paid';
  delivery_challan_number: string | null;
  po_number: string | null;
  payment_terms_days: number | null;
  notes: string | null;
  linked_challan_ids?: string[] | null;
  paid_amount?: number;
  balance_amount?: number;
  product_names?: string;
  item_count?: number;
  item_integrity_status?: 'ok' | 'missing_product_rows';
  customers?: {
    company_name: string;
    gst_vat_type: string;
  };
  sales_order?: {
    so_number: string;
    order_date: string;
  } | null;
  linked_challans?: Array<{
    id: string;
    challan_number: string;
    challan_date: string;
  }>;
  is_draft?: boolean;
  journal_entry_id?: string | null;
  faktur_pajak_number?: string | null;
}

function isCancelledInvoice(invoice: SalesInvoice): boolean {
  return Boolean(
    invoice.document_status === 'cancelled' ||
    invoice.notes?.includes('[CANCELLED') ||
    invoice.notes?.toLowerCase().startsWith('cancelled')
  );
}

function isPostedInvoice(invoice: SalesInvoice): boolean {
  if (isCancelledInvoice(invoice)) return false;
  if (invoice.document_status) {
    return invoice.document_status === 'posted';
  }
  return (
    (!invoice.is_draft ||
      Boolean(invoice.journal_entry_id) ||
      invoice.payment_status === 'paid' ||
      Number(invoice.paid_amount || 0) > 0)
  );
}

interface SOItemOption {
  product_id: string;
  product_name: string;
  unit_price: number;
  quantity: number;
  tax_percent: number;
  make_id: string | null;
  make_name: string | null;
}

interface SalesOrderOption {
  id: string;
  so_number: string;
  customer_po_number?: string | null;
  po_number?: string | null;
  total_amount: number;
  advance_payment_amount: number;
  advance_payment_status: string;
  status: string;
  items?: SOItemOption[];
}

interface InvoiceItem {
  id?: string;
  product_id: string;
  batch_id: string | null;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  total: number;
  delivery_challan_item_id?: string | null;
  challan_id?: string | null;
  dc_number?: string;
  max_quantity?: number;
  make_id?: string | null;
  make_name?: string | null;
  products?: {
    product_name: string;
    product_code: string;
  };
  batches?: {
    batch_number: string;
    product_sources?: { supplier_name: string | null; grade: string | null } | null;
  } | null;
}

interface DCItem {
  dc_item_id: string;
  product_id: string;
  product_name: string;
  batch_id: string;
  batch_number: string;
  unit: string;
  pack_size: number;
  pack_type: string;
  number_of_packs: number;
  original_quantity: number;
  remaining_quantity: number;
  purchase_price: number;
  selling_price: number;
  mrp: number;
  is_from_editing: boolean;
}

interface DCWithItems {
  challan_id: string;
  challan_number: string;
  challan_date: string;
  dc_status: string;
  items: DCItem[];
}

interface SelectedDCItem {
  dcItemId: string;
  dcNumber: string;
  selected: boolean;
  quantity: number;
}

interface Customer {
  id: string;
  company_name: string;
  gst_vat_type: string;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
}

interface Batch {
  id: string;
  batch_number: string;
  product_id: string;
  current_stock: number;
  import_price: number;
  duty_charges: number;
  freight_charges: number;
  other_charges: number;
  make_id: string | null;
  product_sources?: { supplier_name: string | null; grade: string | null } | null;
}

interface DeliveryChallan {
  id: string;
  challan_number: string;
  challan_date: string;
  delivery_address: string;
  vehicle_number: string | null;
  notes: string | null;
}

interface ChallanItem {
  product_id: string;
  batch_id: string;
  quantity: number;
  products?: {
    product_name: string;
    product_code: string;
  };
  batches?: {
    batch_number: string;
  };
}

export function Sales() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const { navigationData, clearNavigationData, setCurrentPage } = useNavigation();
  const { dateRange } = useFinance();
  const isFinancialEditor = profile?.role === 'admin' || profile?.role === 'accounts';
  const [activeTab, setActiveTab] = useState<'active' | 'posted' | 'drafts' | 'cancelled'>('active');
  const [invoices, setInvoices] = useState<SalesInvoice[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [pendingChallans, setPendingChallans] = useState<DeliveryChallan[]>([]);
  const [pendingDCOptions, setPendingDCOptions] = useState<
    Array<{
      challan_id: string;
      challan_number: string;
      challan_date: string;
      item_count: number;
      product_names?: string;
    }>
  >([]);
  const [customerSalesOrders, setCustomerSalesOrders] = useState<SalesOrderOption[]>([]);
  const [selectedSOId, setSelectedSOId] = useState<string>('');
  const [soAutoLinked, setSoAutoLinked] = useState(false);
  const [selectedDCIds, setSelectedDCIds] = useState<string[]>([]);
  const [selectedChallanId, setSelectedChallanId] = useState<string>('');
  const [pendingDCsWithItems, setPendingDCsWithItems] = useState<DCWithItems[]>([]);
  const [selectedDCItems, setSelectedDCItems] = useState<Map<string, SelectedDCItem>>(new Map());
  const [expandedDCs, setExpandedDCs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<SalesInvoice | null>(null);
  const isEditingPosted = Boolean(editingInvoice && isPostedInvoice(editingInvoice));
  const [selectedInvoice, setSelectedInvoice] = useState<SalesInvoice | null>(null);
  const [selectedFlyChallan, setSelectedFlyChallan] = useState<any | null>(null);
  const [linkedSOPreview, setLinkedSOPreview] = useState<any | null>(null);
  const [selectedFlyChallanItems, setSelectedFlyChallanItems] = useState<any[]>([]);
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItem[]>([]);
  const [formData, setFormData] = useState({
    invoice_number: '',
    customer_id: '',
    invoice_date: new Date().toISOString().split('T')[0],
    payment_terms: '30',
    discount: 0,
    stamp_duty_amount: 0,
    delivery_challan_number: '',
    po_number: '',
    notes: '',
  });
  const [items, setItems] = useState<InvoiceItem[]>([
    {
      product_id: '',
      batch_id: null,
      quantity: 1,
      unit_price: 0,
      tax_rate: 11,
      total: 0,
    },
  ]);

  useEffect(() => {
    loadInvoices();
    loadCustomers();
    loadProducts();
    loadBatches();
  }, [dateRange.startDate, dateRange.endDate]);

  useErpSyncListener(
    ['sales_invoices', 'delivery_challans', 'credit_notes', 'vouchers'],
    () => {
      loadInvoices();
    }
  );

  useEffect(() => {
    if (navigationData?.sourceType === 'delivery_challan') {
      handleDeliveryChallanData(navigationData);
      clearNavigationData();
    }
  }, [navigationData]);

  const loadItemsFromSelectedDCs = async (challanIds: string[], customerId?: string) => {
    if (!challanIds || challanIds.length === 0) return;

    try {
      // 1. Authoritative DC items query with joined SO, SO item, batch, and product info
      const { data: dciData, error: dciError } = await supabase
        .from('delivery_challan_items')
        .select(
          `
          id,
          challan_id,
          product_id,
          batch_id,
          quantity,
          sales_order_item_id,
          delivery_challans!inner(
            id,
            challan_number,
            customer_id,
            sales_order_id,
            sales_orders(id, so_number, customer_po_number, sales_order_items(id, product_id, unit_price, tax_percent))
          ),
          sales_order_items(id, unit_price, tax_percent, product_id),
          products(product_name, product_code),
          batches(batch_number, make_id, product_sources!batches_make_id_fkey(supplier_name))
        `
        )
        .in('challan_id', challanIds);

      if (dciError) throw dciError;

      // 2. Fetch remaining quantities from pending_dc_items_by_customer view
      const effectiveCustomerId = customerId || formData.customer_id;
      let pendingQuery = supabase
        .from('pending_dc_items_by_customer')
        .select('dc_item_id, remaining_quantity, invoiced_quantity')
        .in('challan_id', challanIds);

      if (effectiveCustomerId) {
        pendingQuery = pendingQuery.eq('customer_id', effectiveCustomerId);
      }

      const { data: pendingRows } = await pendingQuery;
      const remainingQtyMap = new Map<string, number>();
      (pendingRows || []).forEach((r: any) => {
        if (r.dc_item_id != null) {
          remainingQtyMap.set(r.dc_item_id, Number(r.remaining_quantity));
        }
      });

      // 3. Resolve SO links and Customer PO Number
      const soMap = new Map<
        string,
        { id: string; so_number: string; customer_po_number: string }
      >();
      (dciData || []).forEach((dci: any) => {
        const dc = Array.isArray(dci.delivery_challans)
          ? dci.delivery_challans[0]
          : dci.delivery_challans;
        const so = Array.isArray(dc?.sales_orders) ? dc?.sales_orders[0] : dc?.sales_orders;
        if (dc?.sales_order_id && so) {
          soMap.set(dc.sales_order_id, {
            id: so.id,
            so_number: so.so_number,
            customer_po_number: so.customer_po_number || '',
          });
        }
      });

      const distinctSoList = Array.from(soMap.values());
      if (distinctSoList.length === 1) {
        const linkedSo = distinctSoList[0];
        setSelectedSOId(linkedSo.id);
        setSoAutoLinked(true);
        if (linkedSo.customer_po_number) {
          setFormData((prev) => ({ ...prev, po_number: linkedSo.customer_po_number }));
        }
      } else if (distinctSoList.length > 1) {
        setSoAutoLinked(false);
        const distinctPOs = Array.from(
          new Set(distinctSoList.map((s) => s.customer_po_number).filter(Boolean))
        );
        if (distinctPOs.length > 1) {
          showToast({
            type: 'error',
            title: 'Conflicting Sales Orders',
            message: `Selected Delivery Challans belong to different Sales Orders with conflicting customer PO numbers (${distinctPOs.join(', ')}).`,
          });
        }
      } else {
        setSoAutoLinked(false);
      }

      // 4. Construct authoritative invoice items
      const dcItems: InvoiceItem[] = (dciData || [])
        .map<InvoiceItem | null>((item: any) => {
          const dc = Array.isArray(item.delivery_challans)
            ? item.delivery_challans[0]
            : item.delivery_challans;
          const so = Array.isArray(dc?.sales_orders) ? dc?.sales_orders[0] : dc?.sales_orders;
          const soItem = Array.isArray(item.sales_order_items)
            ? item.sales_order_items[0]
            : item.sales_order_items;

          // Determine remaining quantity
          const remainingQty = remainingQtyMap.has(item.id)
            ? remainingQtyMap.get(item.id)!
            : Number(item.quantity);

          // Skip if fully invoiced
          if (remainingQty <= 0) return null;

          // Authoritative pricing:
          // 1) Direct link via sales_order_item_id
          let unitPrice = 0;
          let taxRate = 11;
          if (soItem?.unit_price != null) {
            unitPrice = Number(soItem.unit_price);
            if (soItem.tax_percent != null) taxRate = Number(soItem.tax_percent);
          } else if (so?.sales_order_items?.length) {
            // 2) Fallback to match by product_id on linked SO
            const matchingSoItems = so.sales_order_items.filter(
              (si: any) => si.product_id === item.product_id
            );
            if (matchingSoItems.length > 0) {
              unitPrice = Number(matchingSoItems[0].unit_price || 0);
              if (matchingSoItems[0].tax_percent != null)
                taxRate = Number(matchingSoItems[0].tax_percent);
            }
          }

          const batch = Array.isArray(item.batches) ? item.batches[0] : item.batches;
          const batchSource = Array.isArray(batch?.product_sources) ? batch?.product_sources[0] : batch?.product_sources;
          const fallbackBatch = batches.find((b) => b.id === item.batch_id);
          const fallbackSource = Array.isArray(fallbackBatch?.product_sources) ? fallbackBatch?.product_sources[0] : fallbackBatch?.product_sources;
          const resolvedMakeName = batchSource?.supplier_name || fallbackSource?.supplier_name || null;
          const resolvedMakeId = batch?.make_id || fallbackBatch?.make_id || null;

          return {
            product_id: item.product_id,
            batch_id: item.batch_id,
            quantity: remainingQty,
            unit_price: unitPrice,
            tax_rate: taxRate,
            total: 0,
            delivery_challan_item_id: item.id,
            challan_id: item.challan_id,
            dc_number: dc?.challan_number || '',
            max_quantity: remainingQty,
            make_id: resolvedMakeId,
            make_name: resolvedMakeName,
          };
        })
        .filter((item): item is InvoiceItem => item !== null);

      if (dcItems.length > 0) {
        setItems((previous) => {
          const existingDcItemIds = new Set(
            previous.map((item) => item.delivery_challan_item_id).filter(Boolean)
          );
          const additions = dcItems
            .filter((item) => !existingDcItemIds.has(item.delivery_challan_item_id))
            .map((item) => ({ ...item, total: calculateItemTotal(item) }));
          // Retain only authoritative DC items. Obsolete placeholder or unlinked
          // manual rows without delivery_challan_item_id must not be mixed into an SO/DC-derived invoice.
          const retained = previous.filter((item) => Boolean(item.delivery_challan_item_id));
          return additions.length > 0
            ? [...retained, ...additions]
            : retained.length > 0
              ? retained
              : additions;
        });
      }
    } catch (error) {
      console.error('Error loading DC items:', error);
    }
  };

  const handleDCMultiSelectChange = async (nextIds: string[]) => {
    const currentIds = new Set(selectedDCIds);
    const nextIdSet = new Set(nextIds);
    const removedIds = selectedDCIds.filter((id) => !nextIdSet.has(id));
    const protectedIds = new Set(
      items.map((item) => item.challan_id).filter((id): id is string => Boolean(id))
    );

    // Existing invoice lines are accounting/source records. Keep their DC link
    // immutable during edit instead of silently deleting source lines.
    if (editingInvoice && removedIds.some((id) => protectedIds.has(id))) {
      const restoredIds = [
        ...new Set([...nextIds, ...removedIds.filter((id) => protectedIds.has(id))]),
      ];
      setSelectedDCIds(restoredIds);
      showToast({
        type: 'info',
        title: 'Delivery Challan retained',
        message: 'A Delivery Challan with existing invoice lines cannot be removed while editing.',
      });
      return;
    }

    if (!editingInvoice && removedIds.length > 0) {
      setItems((previous) =>
        previous.filter((item) => !item.challan_id || !removedIds.includes(item.challan_id))
      );
    }

    setSelectedDCIds(nextIds);
    const addedIds = nextIds.filter((id) => !currentIds.has(id));
    if (addedIds.length > 0 && formData.customer_id) {
      await loadItemsFromSelectedDCs(addedIds);
    }
  };

  const loadInvoices = async () => {
    try {
      const { data, error } = await supabase
        .from('sales_invoices')
        .select(
          '*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)'
        )
        .gte('invoice_date', dateRange.startDate)
        .lte('invoice_date', dateRange.endDate)
        .order('invoice_date', { ascending: false });

      if (error) throw error;

      // Calculate paid amount and balance for each invoice (bulk aggregation
      // replicates get_invoice_paid_amount = voucher_allocations(receipt) + invoice_rounding_adjustments).
      const invoiceIdsForPaid = (data || []).map((inv) => inv.id);
      const paidById = new Map<string, number>();
      if (invoiceIdsForPaid.length > 0) {
        const [{ data: allocs }, { data: adjs }] = await Promise.all([
          supabase
            .from('voucher_allocations')
            .select('sales_invoice_id, allocated_amount')
            .in('sales_invoice_id', invoiceIdsForPaid)
            .eq('voucher_type', 'receipt'),
          supabase
            .from('invoice_rounding_adjustments')
            .select('sales_invoice_id, adjustment_amount')
            .in('sales_invoice_id', invoiceIdsForPaid),
        ]);
        for (const a of allocs || []) {
          paidById.set(
            a.sales_invoice_id,
            (paidById.get(a.sales_invoice_id) || 0) + Number(a.allocated_amount || 0)
          );
        }
        for (const a of adjs || []) {
          paidById.set(
            a.sales_invoice_id,
            (paidById.get(a.sales_invoice_id) || 0) + Number(a.adjustment_amount || 0)
          );
        }
      }

      // Resolve user profiles for verified cancelled_by attribution
      const cancellerUserIds = Array.from(
        new Set(
          (data || [])
            .map((inv: any) => inv.cancelled_by)
            .filter((id): id is string => Boolean(id))
        )
      );
      const cancellerMap = new Map<string, string>();
      if (cancellerUserIds.length > 0) {
        const { data: userProfiles } = await supabase
          .from('user_profiles')
          .select('id, full_name, email')
          .in('id', cancellerUserIds);
        (userProfiles || []).forEach((u: any) => {
          cancellerMap.set(u.id, u.full_name || u.email || 'Unknown User');
        });
      }

      const invoicesWithPayments = (data || []).map((inv) => {
        const paidAmount = paidById.get(inv.id) || 0;
        const balance = inv.total_amount - paidAmount;
        const cancellerName = inv.cancelled_by ? (cancellerMap.get(inv.cancelled_by) || null) : null;
        return {
          ...inv,
          paid_amount: paidAmount,
          balance_amount: balance,
          canceller_name: cancellerName,
        };
      });

      const itemCounts = new Map<string, number>();
      if (invoiceIdsForPaid.length > 0) {
        const { data: itemRows } = await supabase
          .from('sales_invoice_items')
          .select('invoice_id')
          .in('invoice_id', invoiceIdsForPaid);
        (itemRows || []).forEach((row: any) =>
          itemCounts.set(row.invoice_id, (itemCounts.get(row.invoice_id) || 0) + 1)
        );
      }

      const bundle = await fetchLinkedDocumentsBundle();
      const invoicesWithLinked = invoicesWithPayments.map((inv: any) => {
        const links = bundle.invMap.get(inv.id);
        return {
          ...inv,
          item_count: itemCounts.get(inv.id) || 0,
          item_integrity_status:
            Number(inv.total_amount || 0) > 0 && !(itemCounts.get(inv.id) || 0)
              ? 'missing_product_rows'
              : 'ok',
          sales_order: links?.sos?.[0] ? { so_number: links.sos[0].number } : null,
          linked_challans: (links?.dcs || []).map((d) => ({ id: d.id, challan_number: d.number })),
        };
      });

      // perf: render list immediately without the sales_invoice_items+products
      // join. Product-name search hydrates in the background so search UX is
      // preserved without blocking initial render.
      const invoicesWithProducts = invoicesWithLinked.map((inv: any) => ({
        ...inv,
        product_names: '',
      }));
      setInvoices(invoicesWithProducts);

      const invoiceIds = invoicesWithLinked.map((inv: any) => inv.id);
      if (invoiceIds.length > 0) {
        // Fire-and-forget: hydrate product_names for search after list is shown.
        (async () => {
          try {
            const { data: itemsData } = await supabase
              .from('sales_invoice_items')
              .select('invoice_id, products(product_name)')
              .in('invoice_id', invoiceIds);
            if (!itemsData) return;
            const productNamesMap = new Map<string, string>();
            (itemsData as any[]).forEach((item) => {
              const existing = productNamesMap.get(item.invoice_id) || '';
              const name = item.products?.product_name || '';
              if (name && !existing.includes(name)) {
                productNamesMap.set(item.invoice_id, existing ? `${existing}, ${name}` : name);
              }
            });
            setInvoices((prev) =>
              prev.map((inv: any) => ({
                ...inv,
                product_names: productNamesMap.get(inv.id) || inv.product_names || '',
              }))
            );
          } catch (err) {
            console.error('Error hydrating product names:', err);
          }
        })();
      }
    } catch (error) {
      console.error('Error loading invoices:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFlyChallanClick = async (challanId: string) => {
    const [{ data: challan }, { data: challanItems }] = await Promise.all([
      supabase
        .from('delivery_challans')
        .select('*, customers(company_name, address, city, phone, pbf_license)')
        .eq('id', challanId)
        .maybeSingle(),
      supabase
        .from('delivery_challan_items')
        .select(
          '*, products(id, product_name, product_code, unit, per_pack_weight, pack_type, packaging_type), batches(id, batch_number, expiry_date, packaging_details, per_pack_weight, pack_type, products(id, product_name, product_code, unit, per_pack_weight, pack_type, packaging_type), product_sources!batches_make_id_fkey(supplier_name, grade))'
        )
        .eq('challan_id', challanId),
    ]);
    if (challan) {
      setSelectedFlyChallan(challan);
      setSelectedFlyChallanItems(challanItems || []);
    }
  };

  const openLinkedSalesOrderView = async (soId: string) => {
    if (!soId) return;
    const { data } = await supabase
      .from('sales_orders')
      .select(
        `
        *,
        customers(*),
        sales_order_items(
          *,
          products(id, product_name, product_code, unit),
          product_sources!sales_order_items_make_id_fkey(supplier_name, grade)
        )
      `
      )
      .eq('id', soId)
      .maybeSingle();
    if (data) setLinkedSOPreview(data);
  };

  const generateNextInvoiceNumber = async () => {
    try {
      // Get settings for invoice prefix
      const { data: settings } = await supabase
        .from('app_settings')
        .select('invoice_prefix, invoice_start_number')
        .limit(1)
        .maybeSingle();

      const startNumber = settings?.invoice_start_number || 1;

      // Get current financial year automatically
      const { data: yearCode, error: fyError } = await supabase.rpc('get_current_financial_year');

      if (fyError) {
        console.error('Error getting financial year:', fyError);
        const fallbackYear = new Date().getFullYear().toString().slice(-2);
        return `SAPJ-${fallbackYear}-001`;
      }

      // Strip year suffix from prefix if someone saved it with year already embedded (e.g. "SAPJ-26" -> "SAPJ")
      const rawPrefix = settings?.invoice_prefix || 'SAPJ';
      const prefix = rawPrefix.replace(new RegExp(`-${yearCode}$`), '');

      // Get all invoice numbers with this prefix and year to find the highest number
      const { data: allInvoices } = await supabase
        .from('sales_invoices')
        .select('invoice_number')
        .like('invoice_number', `${prefix}-${yearCode}%`);

      let nextNumber = startNumber;

      if (allInvoices && allInvoices.length > 0) {
        // Extract all numbers and find the maximum
        const numbers = allInvoices
          .map((inv) => {
            const match = inv.invoice_number.match(/(\d+)$/);
            return match ? parseInt(match[1], 10) : 0;
          })
          .filter((num) => !isNaN(num));

        if (numbers.length > 0) {
          const maxNumber = Math.max(...numbers);
          nextNumber = maxNumber + 1;
        }
      }

      // Format with leading zeros (minimum 3 digits)
      const paddedNumber = String(nextNumber).padStart(3, '0');
      return `${prefix}-${yearCode}-${paddedNumber}`;
    } catch (error) {
      console.error('Error generating invoice number:', error);
      const fallbackYear = new Date().getFullYear().toString().slice(-2);
      return `SAPJ-${fallbackYear}-001`;
    }
  };

  const loadCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('id, company_name, gst_vat_type')
        .eq('is_active', true)
        .order('company_name');

      if (error) throw error;
      setCustomers(data || []);
    } catch (error) {
      console.error('Error loading customers:', error);
    }
  };

  const loadProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('id, product_name, product_code')
        .eq('is_active', true)
        .order('product_name');

      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error loading products:', error);
    }
  };

  const loadBatches = async () => {
    try {
      // Load ALL batches for reference (including 0 stock for delivery challan invoices)
      const { data, error } = await supabase
        .from('batches')
        .select(
          'id, batch_number, product_id, make_id, current_stock, import_price, duty_charges, freight_charges, other_charges, import_quantity, import_date, expiry_date, product_sources!batches_make_id_fkey(supplier_name, grade)'
        )
        .eq('is_active', true)
        .order('import_date', { ascending: true });

      if (error) throw error;
      setBatches(
        (data || []).map((batch) => ({
          ...batch,
          product_sources: normalizeNestedRelation(batch.product_sources),
        }))
      );
    } catch (error) {
      console.error('Error loading batches:', error);
    }
  };

  const loadPendingChallans = async (customerId: string) => {
    try {
      const { data: allChallans, error: challansError } = await supabase
        .from('delivery_challans')
        .select('id, challan_number, challan_date, delivery_address, vehicle_number, notes')
        .eq('customer_id', customerId)
        .order('challan_date', { ascending: false });

      if (challansError) throw challansError;

      const { data: invoicedChallans, error: invoicesError } = await supabase
        .from('sales_invoices')
        .select('linked_challan_ids')
        .not('linked_challan_ids', 'is', null);

      if (invoicesError) throw invoicesError;

      const linkedChallanIds = new Set<string>();
      invoicedChallans?.forEach((inv) => {
        inv.linked_challan_ids?.forEach((id: string) => linkedChallanIds.add(id));
      });

      const pending = allChallans?.filter((ch) => !linkedChallanIds.has(ch.id)) || [];
      setPendingChallans(pending);
    } catch (error) {
      console.error('Error loading pending challans:', error);
      setPendingChallans([]);
    }
  };

  const loadCustomerSalesOrders = async (customerId: string) => {
    try {
      const { data, error } = await supabase
        .from('sales_orders')
        .select(
          `
          id, so_number, customer_po_number, total_amount, advance_payment_amount, advance_payment_status, status,
          sales_order_items(product_id, quantity, unit_price, tax_percent, make_id, product_sources!sales_order_items_make_id_fkey(supplier_name, grade), products(product_name))
        `
        )
        .eq('customer_id', customerId)
        .eq('is_archived', false)
        .in('status', [
          'approved',
          'stock_reserved',
          'shortage',
          'pending_delivery',
          'partially_delivered',
          'delivered',
        ])
        .order('created_at', { ascending: false });

      if (error) throw error;

      const soOptions: SalesOrderOption[] = (data || []).map((so: any) => ({
        id: so.id,
        so_number: so.so_number,
        customer_po_number: so.customer_po_number || null,
        po_number: so.customer_po_number || null,
        total_amount: so.total_amount,
        advance_payment_amount: so.advance_payment_amount,
        advance_payment_status: so.advance_payment_status,
        status: so.status,
        items: (so.sales_order_items || []).map((item: any) => ({
          product_id: item.product_id,
          product_name: item.products?.product_name || 'Unknown',
          unit_price: item.unit_price || 0,
          quantity: Number(item.quantity) || 0,
          tax_percent: Number(item.tax_percent) || 0,
          make_id: item.make_id || null,
          make_name: item.product_sources?.supplier_name || null,
        })),
      }));

      setCustomerSalesOrders(soOptions);
    } catch (error) {
      console.error('Error loading customer sales orders:', error);
      setCustomerSalesOrders([]);
    }
  };

  const handleSalesOrderSelect = async (salesOrderId: string) => {
    setSelectedSOId(salesOrderId);
    setSoAutoLinked(false);
    if (!salesOrderId) return;

    const salesOrder = customerSalesOrders.find((order) => order.id === salesOrderId);
    const resolvedPO = salesOrder?.customer_po_number || salesOrder?.po_number || '';
    if (resolvedPO) {
      setFormData((prev) => ({ ...prev, po_number: resolvedPO }));
    }

    // A Sales Order requires an approved Delivery Challan before an invoice can be created.
    // Query approved Delivery Challans for this SO and auto-select them.
    try {
      const { data: dcs, error: dcError } = await supabase
        .from('delivery_challans')
        .select('id, challan_number, approval_status')
        .eq('sales_order_id', salesOrderId)
        .eq('approval_status', 'approved');

      if (dcError) throw dcError;

      const dcIds = (dcs || []).map((d: any) => d.id);
      if (dcIds.length === 0) {
        showToast({
          type: 'error',
          title: 'No Delivery Challan',
          message:
            'This Sales Order has no approved Delivery Challans to invoice. Every invoice line requires a source Delivery Challan.',
        });
        setItems([
          {
            product_id: '',
            batch_id: null,
            quantity: 1,
            unit_price: 0,
            tax_rate: 11,
            total: 0,
          },
        ]);
        setSelectedDCIds([]);
        return;
      }

      await ensureLinkedDCOptionsVisible(dcIds);
      setSelectedDCIds(dcIds);
      await loadItemsFromSelectedDCs(dcIds);
    } catch (error: any) {
      console.error('Error loading Delivery Challans for Sales Order:', error);
      showToast({
        type: 'error',
        title: 'Error',
        message: `Failed to load Delivery Challans for Sales Order: ${error.message || 'Unknown error'}`,
      });
    }
  };

  const loadPendingDCOptions = async (customerId: string) => {
    try {
      const { data, error } = await supabase
        .from('dc_invoicing_summary')
        .select(
          'challan_id, challan_number, challan_date, total_quantity, total_remaining_quantity'
        )
        .eq('customer_id', customerId)
        .gt('total_remaining_quantity', 0)
        .order('challan_date', { ascending: false });

      if (error) throw error;

      // Fetch product names for each DC
      const challanIds = (data || []).map((dc) => dc.challan_id);
      const productNameMap: Record<string, string> = {};
      if (challanIds.length > 0) {
        const { data: items } = await supabase
          .from('delivery_challan_items')
          .select('challan_id, products(product_name)')
          .in('challan_id', challanIds);
        if (items) {
          const grouped: Record<string, Set<string>> = {};
          items.forEach((item: any) => {
            if (!grouped[item.challan_id]) grouped[item.challan_id] = new Set();
            if (item.products?.product_name)
              grouped[item.challan_id].add(item.products.product_name);
          });
          Object.entries(grouped).forEach(([id, names]) => {
            productNameMap[id] = [...names].join(', ');
          });
        }
      }

      const options = (data || []).map((dc) => ({
        challan_id: dc.challan_id,
        challan_number: dc.challan_number,
        challan_date: dc.challan_date,
        item_count: dc.total_remaining_quantity,
        product_names: productNameMap[dc.challan_id] || '',
      }));

      setPendingDCOptions(options);
    } catch (error) {
      console.error('Error loading pending DC options:', error);
      setPendingDCOptions([]);
    }
  };

  const ensureLinkedDCOptionsVisible = async (linkedDCIds: string[]) => {
    if (!linkedDCIds || linkedDCIds.length === 0) return;

    try {
      const missingIds = linkedDCIds.filter(
        (id) => !pendingDCOptions.some((opt) => opt.challan_id === id)
      );
      if (missingIds.length === 0) return;

      const { data, error } = await supabase
        .from('delivery_challans')
        .select('id, challan_number, challan_date')
        .in('id', missingIds)
        .order('challan_date', { ascending: false });

      if (error) throw error;

      const linkedOptions = (data || []).map((dc) => ({
        challan_id: dc.id,
        challan_number: dc.challan_number,
        challan_date: dc.challan_date,
        item_count: 0,
      }));

      if (linkedOptions.length > 0) {
        setPendingDCOptions((prev) => {
          const existingIds = new Set(prev.map((opt) => opt.challan_id));
          const toAdd = linkedOptions.filter((opt) => !existingIds.has(opt.challan_id));
          return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
        });
      }
    } catch (error) {
      console.error('Error ensuring linked DC options are visible:', error);
    }
  };

  const loadPendingDCItems = async (customerId: string, excludeInvoiceId?: string) => {
    try {
      const { data, error } = await supabase.rpc('get_pending_dc_items_for_customer', {
        p_customer_id: customerId,
        p_exclude_invoice_id: excludeInvoiceId || null,
      });

      if (error) throw error;

      const dcsWithItems: DCWithItems[] = (data || []).map((dc: any) => ({
        challan_id: dc.challan_id,
        challan_number: dc.challan_number,
        challan_date: dc.challan_date,
        dc_status: dc.dc_status,
        items: dc.items || [],
      }));

      setPendingDCsWithItems(dcsWithItems);

      if (excludeInvoiceId && dcsWithItems.length > 0) {
        const newSelectedItems = new Map<string, SelectedDCItem>();
        const newExpandedDCs = new Set<string>();

        dcsWithItems.forEach((dc) => {
          dc.items.forEach((item) => {
            if (item.is_from_editing) {
              newSelectedItems.set(item.dc_item_id, {
                dcItemId: item.dc_item_id,
                dcNumber: dc.challan_number,
                selected: true,
                quantity: item.remaining_quantity,
              });
              newExpandedDCs.add(dc.challan_id);
            }
          });
        });

        setSelectedDCItems(newSelectedItems);
        setExpandedDCs(newExpandedDCs);
      }
    } catch (error) {
      console.error('Error loading pending DC items:', error);
      setPendingDCsWithItems([]);
    }
  };

  const handleDCItemToggle = (dcItem: DCItem, dcNumber: string, checked: boolean) => {
    const newSelectedItems = new Map(selectedDCItems);

    if (checked) {
      newSelectedItems.set(dcItem.dc_item_id, {
        dcItemId: dcItem.dc_item_id,
        dcNumber: dcNumber,
        selected: true,
        quantity: dcItem.remaining_quantity,
      });
    } else {
      newSelectedItems.delete(dcItem.dc_item_id);
    }

    setSelectedDCItems(newSelectedItems);
    syncItemsFromDCSelection(newSelectedItems);
  };

  const handleDCExpandToggle = (dcId: string) => {
    const newExpanded = new Set(expandedDCs);
    if (newExpanded.has(dcId)) {
      newExpanded.delete(dcId);
    } else {
      newExpanded.add(dcId);
    }
    setExpandedDCs(newExpanded);
  };

  const handleDCSelectAll = (
    dcId: string,
    dcItems: DCItem[],
    dcNumber: string,
    checked: boolean
  ) => {
    const newSelectedItems = new Map(selectedDCItems);

    if (checked) {
      dcItems.forEach((item) => {
        newSelectedItems.set(item.dc_item_id, {
          dcItemId: item.dc_item_id,
          dcNumber: dcNumber,
          selected: true,
          quantity: item.remaining_quantity,
        });
      });
      const newExpanded = new Set(expandedDCs);
      newExpanded.add(dcId);
      setExpandedDCs(newExpanded);
    } else {
      dcItems.forEach((item) => {
        newSelectedItems.delete(item.dc_item_id);
      });
    }

    setSelectedDCItems(newSelectedItems);
    syncItemsFromDCSelection(newSelectedItems);
  };

  const syncItemsFromDCSelection = (selectedDCMap: Map<string, SelectedDCItem>) => {
    const dcItems: InvoiceItem[] = [];

    pendingDCsWithItems.forEach((dc) => {
      dc.items.forEach((dcItem) => {
        const selected = selectedDCMap.get(dcItem.dc_item_id);
        if (selected) {
          dcItems.push({
            product_id: dcItem.product_id,
            batch_id: dcItem.batch_id,
            quantity: dcItem.remaining_quantity,
            unit_price: dcItem.selling_price,
            tax_rate: 11,
            total: dcItem.remaining_quantity * dcItem.selling_price * 1.11,
            delivery_challan_item_id: dcItem.dc_item_id,
            dc_number: dc.challan_number,
            max_quantity: dcItem.remaining_quantity,
          });
        }
      });
    });

    if (dcItems.length > 0) {
      setItems(dcItems);
    } else {
      const manualItems = items.filter((item) => !item.delivery_challan_item_id);
      setItems(
        manualItems.length > 0
          ? manualItems
          : [
              {
                product_id: '',
                batch_id: null,
                quantity: 1,
                unit_price: 0,
                tax_rate: 11,
                total: 0,
                delivery_challan_item_id: null,
              },
            ]
      );
    }
  };

  const addManualItem = () => {
    setItems([
      ...items,
      {
        product_id: '',
        batch_id: null,
        quantity: 1,
        unit_price: 0,
        tax_rate: 11,
        total: 0,
        delivery_challan_item_id: null,
      },
    ]);
  };

  const handleChallanSelect = async (challanId: string) => {
    if (!challanId) {
      setSelectedChallanId('');
      setItems([
        {
          product_id: '',
          batch_id: null,
          quantity: 1,
          unit_price: 0,
          tax_rate: 11,
          total: 0,
        },
      ]);
      return;
    }

    setSelectedChallanId(challanId);
    setSelectedDCIds([challanId]);

    try {
      const selectedChallan = pendingChallans.find((ch) => ch.id === challanId);
      if (!selectedChallan) {
        console.error('Selected challan not found in pending challans list');
        showToast({
          type: 'error',
          title: 'Error',
          message: 'Selected delivery challan not found. Please refresh and try again.',
        });
        return;
      }

      setFormData((prev) => ({
        ...prev,
        delivery_challan_number: selectedChallan.challan_number,
      }));

      const { data: challanItems, error } = await supabase
        .from('delivery_challan_items')
        .select(
          'id, product_id, batch_id, quantity, products(product_name, product_code), batches(batch_number, import_price, duty_charges, freight_charges, other_charges, import_quantity, make_id, product_sources!batches_make_id_fkey(supplier_name, grade))'
        )
        .eq('challan_id', challanId);

      if (error) {
        console.error('Database error loading challan items:', error);
        throw error;
      }

      if (!challanItems || challanItems.length === 0) {
        console.warn('No items found for this delivery challan');
        showToast({
          type: 'info',
          title: 'Info',
          message: 'This delivery challan has no items. Please add items manually.',
        });
        return;
      }

      const invoiceItems: InvoiceItem[] = [];

      for (const item of challanItems) {
        if (!item.product_id) {
          console.warn('Skipping item with missing product_id');
          continue;
        }

        let unitPrice = 0;

        if (item.batch_id) {
          const batch = batches.find((b) => b.id === item.batch_id);
          if (batch) {
            const costPerUnit =
              (batch.import_price +
                batch.duty_charges +
                batch.freight_charges +
                batch.other_charges) /
              (batch as any).import_quantity;
            unitPrice = Math.round(costPerUnit * 1.25);
          } else {
            console.warn(`Batch ${item.batch_id} not found in loaded batches`);
          }
        }

        const batch = normalizeNestedRelation(item.batches);
        invoiceItems.push({
          product_id: item.product_id,
          batch_id: item.batch_id,
          quantity: item.quantity,
          unit_price: unitPrice,
          tax_rate: 11,
          total: item.quantity * unitPrice * 1.11,
          delivery_challan_item_id: (item as any).id || null,
          challan_id: challanId,
          dc_number: selectedChallan.challan_number,
          make_id: batch?.make_id || null,
          make_name: normalizeNestedRelation(batch?.product_sources)?.supplier_name || null,
        });
      }

      if (invoiceItems.length === 0) {
        showToast({
          type: 'error',
          title: 'Error',
          message: 'Could not load items from delivery challan. Please add items manually.',
        });
        return;
      }

      setItems(invoiceItems);
    } catch (error: any) {
      console.error('Error loading challan items:', error);
      showToast({
        type: 'error',
        title: 'Error',
        message: `Failed to load delivery challan items: ${error.message || 'Unknown error'}. Please try again or add items manually.`,
      });
    }
  };

  const getFIFOBatch = (productId: string) => {
    const now = new Date();
    const productBatches = batches
      .filter((b) => {
        if (b.product_id !== productId) return false;
        if (!(b as any).expiry_date) return true;
        return new Date((b as any).expiry_date) > now;
      })
      .sort((a, b) => {
        const dateA = new Date((a as any).import_date).getTime();
        const dateB = new Date((b as any).import_date).getTime();
        return dateA - dateB;
      });
    return productBatches[0] || null;
  };

  const handleDeliveryChallanData = async (data: any) => {
    const nextInvoiceNumber = await generateNextInvoiceNumber();

    setFormData({
      invoice_number: nextInvoiceNumber,
      customer_id: data.customerId,
      invoice_date: new Date().toISOString().split('T')[0],
      payment_terms: '30',
      discount: 0,
      stamp_duty_amount: 0,
      delivery_challan_number: data.challanNumber,
      po_number: '',
      notes: `Created from Delivery Challan: ${data.challanNumber}`,
    });

    if (data.customerId) {
      await loadPendingDCOptions(data.customerId);
      await loadCustomerSalesOrders(data.customerId);
      await loadPendingChallans(data.customerId);
    }

    if (data.challanId) {
      await ensureLinkedDCOptionsVisible([data.challanId]);
      setSelectedDCIds([data.challanId]);
      const { data: sourceChallan } = await supabase
        .from('delivery_challans')
        .select('sales_order_id')
        .eq('id', data.challanId)
        .maybeSingle();
      setSelectedSOId(sourceChallan?.sales_order_id || null);
      setSoAutoLinked(Boolean(sourceChallan?.sales_order_id));
      if (sourceChallan?.sales_order_id) {
        const { data: linkedSO } = await supabase
          .from('sales_orders')
          .select('customer_po_number')
          .eq('id', sourceChallan.sales_order_id)
          .maybeSingle();
        if (linkedSO?.customer_po_number) {
          setFormData((prev) => ({ ...prev, po_number: linkedSO.customer_po_number }));
        }
      }
      await loadItemsFromSelectedDCs([data.challanId], data.customerId);
    }

    setModalOpen(true);
  };

  const loadInvoiceItems = async (invoiceId: string) => {
    try {
      const itemsWithDCInfo = await loadInvoiceDisplayItems(supabase, invoiceId);
      const mappedItems: InvoiceItem[] = itemsWithDCInfo.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        batch_id: item.batch_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
        total:
          item.line_total ??
          item.total ??
          item.quantity * item.unit_price * (1 + item.tax_rate / 100),
        delivery_challan_item_id: item.delivery_challan_item_id,
        challan_id: item.challan_id,
        dc_number: item.dc_number,
        products: item.products,
        batches: item.batches,
        make_name: item.batches?.product_sources?.supplier_name || null,
      }));

      setInvoiceItems(mappedItems);
      return mappedItems;
    } catch (error) {
      console.error('Error loading invoice items:', error);
      return [];
    }
  };

  const calculateItemTotal = (item: InvoiceItem) => {
    const subtotal = item.quantity * item.unit_price;
    const tax = subtotal * (item.tax_rate / 100);
    return subtotal + tax;
  };

  // Item-level Delivery Challan links are authoritative. Resolve the header
  // source links from them before saving so invoices created from a DC cannot
  // lose their Sales Order/DC provenance. Conflicting Sales Orders are
  // surfaced instead of being guessed or silently overwritten.
  const resolveInvoiceSourceLinks = async (sourceItems: InvoiceItem[]) => {
    const dcItemIds = [
      ...new Set(
        sourceItems
          .map((item) => item.delivery_challan_item_id)
          .filter((id): id is string => Boolean(id))
      ),
    ];
    if (!dcItemIds.length)
      return { challanIds: [...new Set(selectedDCIds)], salesOrderId: selectedSOId || null };

    const { data, error } = await supabase
      .from('delivery_challan_items')
      .select(
        'id, challan_id, delivery_challans(id, sales_order_id, challan_number, sales_orders(id, customer_po_number))'
      )
      .in('id', dcItemIds);
    if (error) throw error;

    const rows = (data || []).map((row: any) => {
      const dc = Array.isArray(row.delivery_challans)
        ? row.delivery_challans[0]
        : row.delivery_challans;
      const so = Array.isArray(dc?.sales_orders) ? dc?.sales_orders[0] : dc?.sales_orders;
      return {
        challanId: row.challan_id as string,
        salesOrderId: dc?.sales_order_id as string | undefined,
        poNumber: (so?.customer_po_number || '') as string,
      };
    });
    const resolvedChallanIds = [...new Set(rows.map((row) => row.challanId).filter(Boolean))];
    const resolvedSoIds = [...new Set(rows.map((row) => row.salesOrderId).filter(Boolean))];
    const resolvedPos = [
      ...new Set(
        rows.map((row) => row.poNumber).filter((po): po is string => Boolean(po && po.trim()))
      ),
    ];
    if (resolvedSoIds.length > 1) {
      if (resolvedPos.length > 1) {
        throw new Error(
          `The selected Delivery Challans belong to different Sales Orders with conflicting customer PO numbers (${resolvedPos.join(', ')}). Resolve the conflict before saving this invoice.`
        );
      }
      throw new Error(
        'The selected Delivery Challans belong to different Sales Orders. Resolve the conflict before saving this invoice.'
      );
    }
    return {
      challanIds: [...new Set([...selectedDCIds, ...resolvedChallanIds])],
      salesOrderId: resolvedSoIds[0] || selectedSOId || null,
    };
  };

  const getBatchCostPerUnit = (batchId: string | null): number => {
    if (!batchId) return 0;
    const batch = batches.find((b) => b.id === batchId) as any;
    if (!batch || !batch.import_quantity) return 0;
    const totalCost =
      batch.import_price + batch.duty_charges + batch.freight_charges + batch.other_charges;
    return totalCost / batch.import_quantity;
  };

  const calculateMargin = (unitPrice: number, costPerUnit: number): number => {
    if (costPerUnit === 0) return 0;
    return ((unitPrice - costPerUnit) / unitPrice) * 100;
  };

  const getSuggestedPrice = (batchId: string | null, markup: number = 25): number => {
    const cost = getBatchCostPerUnit(batchId);
    return Math.round(cost * (1 + markup / 100));
  };

  const getLineItemMakeName = (item: InvoiceItem): string => {
    if (item.make_name) return item.make_name;
    if (item.batch_id) {
      const b = batches.find((candidate) => candidate.id === item.batch_id);
      const bSource = Array.isArray(b?.product_sources) ? b.product_sources[0] : b?.product_sources;
      if (bSource?.supplier_name) return bSource.supplier_name;
    }
    const itemBatches = Array.isArray(item.batches) ? item.batches[0] : item.batches;
    const batchSources = Array.isArray(itemBatches?.product_sources) ? itemBatches.product_sources[0] : itemBatches?.product_sources;
    if (batchSources?.supplier_name) return batchSources.supplier_name;
    return '';
  };

  const updateItemTotal = (index: number, updatedItem: InvoiceItem) => {
    const total = calculateItemTotal(updatedItem);
    const newItems = [...items];
    newItems[index] = { ...updatedItem, total };
    setItems(newItems);
  };

  const addItem = () => {
    setItems([
      ...items,
      {
        product_id: '',
        batch_id: null,
        quantity: 1,
        unit_price: 0,
        tax_rate: 11,
        total: 0,
      },
    ]);
  };

  const removeItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const calculateTotals = () => {
    const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
    const taxAmount = items.reduce((sum, item) => {
      const itemSubtotal = item.quantity * item.unit_price;
      return sum + itemSubtotal * (item.tax_rate / 100);
    }, 0);
    const stampDuty = formData.stamp_duty_amount || 0;
    const total = subtotal + taxAmount - formData.discount + stampDuty;
    return { subtotal, taxAmount, stampDuty, total };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const sourceLinks = await resolveInvoiceSourceLinks(items);
      const sourceDCIds = sourceLinks.challanIds;
      const sourceSOId = sourceLinks.salesOrderId;
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Validate that invoice has at least one item with a product selected
      const validItems = items.filter((item) => item.product_id && item.product_id.trim() !== '');
      if (validItems.length === 0) {
        showToast({
          type: 'error',
          title: 'Error',
          message:
            'Invoice cannot be saved because its product table is empty. Select an approved Delivery Challan item or add a product line.',
        });
        return;
      }

      const totals = calculateTotals();

      // Calculate due date based on payment terms
      const invoiceDate = new Date(formData.invoice_date);
      const dueDate = new Date(invoiceDate);
      let paymentTermsDays = 30;

      if (formData.payment_terms === 'advance' || formData.payment_terms === '50-50') {
        paymentTermsDays = 0;
      } else {
        paymentTermsDays = parseInt(formData.payment_terms);
        if (!isNaN(paymentTermsDays)) {
          dueDate.setDate(dueDate.getDate() + paymentTermsDays);
        }
      }

      let invoice: any;

      if (editingInvoice) {
        if (isCancelledInvoice(editingInvoice)) {
          showToast({
            type: 'error',
            title: 'Action Prohibited',
            message: 'Cancelled invoices cannot be edited. Cancellation is terminal.',
          });
          return;
        }

        if (isPostedInvoice(editingInvoice)) {
          if (!isFinancialEditor) {
            showToast({
              type: 'error',
              title: 'Permission Denied',
              message: 'Only Admin and Accounts can edit financially posted invoices.',
            });
            return;
          }

          // Controlled posted invoice adjustment:
          // Keep products, batches, quantities, and DC links intact to protect physical warehouse stock.
          // Recalculate financial totals and synchronize GL revenue entries consistently.
          const subtotal =
            validItems.length > 0
              ? items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
              : Number(editingInvoice.subtotal || 0);
          const taxAmount =
            validItems.length > 0
              ? items.reduce(
                  (sum, item) => sum + item.quantity * item.unit_price * (item.tax_rate / 100),
                  0
                )
              : Number(editingInvoice.tax_amount || 0);
          const stampDuty = Number(formData.stamp_duty_amount) || 0;
          const discount = Number(formData.discount) || 0;
          const total = subtotal + taxAmount - discount + stampDuty;

          const currentPaid = Number(editingInvoice.paid_amount || 0);
          if (total < currentPaid - 0.01) {
            showToast({
              type: 'error',
              title: 'Revision Conflict',
              message: `Revised invoice total (${total.toLocaleString()}) cannot be less than already collected payments (${currentPaid.toLocaleString()}).`,
            });
            return;
          }

          const newBalance = Math.max(0, total - currentPaid);
          let nextPaymentStatus: 'pending' | 'partial' | 'paid' = 'pending';
          if (newBalance <= 0.01 && currentPaid > 0) {
            nextPaymentStatus = 'paid';
          } else if (currentPaid > 0.01) {
            nextPaymentStatus = 'partial';
          } else {
            nextPaymentStatus = 'pending';
          }

          // 1. Update sales invoice items with revised quantities and unit prices
          for (const item of items) {
            if (item.id) {
              const newQty = Number(item.quantity);

              // If linked to a DC item, validate that invoice quantity does not exceed approved DC dispatched quantity
              if (item.delivery_challan_item_id) {
                const { data: dcItem } = await supabase
                  .from('delivery_challan_items')
                  .select('quantity, delivery_challans(challan_number)')
                  .eq('id', item.delivery_challan_item_id)
                  .maybeSingle();

                const maxQty = Number(dcItem?.quantity || 0);
                if (maxQty > 0 && newQty > maxQty + 0.0001) {
                  showToast({
                    type: 'error',
                    title: 'Quantity Exceeds Delivery',
                    message: `Invoice quantity (${newQty}) cannot exceed Delivery Challan ${(dcItem?.delivery_challans as any)?.challan_number || ''} dispatched quantity (${maxQty}). To bill additional stock, dispatch another Delivery Challan first.`,
                  });
                  return;
                }
              }

              const { error: itemUpdateError } = await supabase
                .from('sales_invoice_items')
                .update({
                  quantity: newQty,
                  unit_price: item.unit_price,
                  tax_rate: item.tax_rate,
                  total_amount: newQty * item.unit_price,
                })
                .eq('id', item.id);
              if (itemUpdateError) throw itemUpdateError;
            }
          }

          // 2. Update sales invoice header
          const { error: updateError } = await supabase
            .from('sales_invoices')
            .update({
              stamp_duty_amount: stampDuty,
              total_amount: total,
              subtotal,
              tax_amount: taxAmount,
              discount_amount: discount,
              due_date: dueDate.toISOString().split('T')[0],
              payment_terms_days: paymentTermsDays,
              po_number: formData.po_number || null,
              notes: formData.notes || null,
              payment_status: nextPaymentStatus,
              balance_amount: newBalance,
              updated_at: new Date().toISOString(),
            })
            .eq('id', editingInvoice.id);

          if (updateError) throw updateError;

          // Revenue, A/R (1120), Output VAT (2130), Bea Meterai (6950), and
          // Sales Discount (4200) journal synchronization plus header-total
          // derivation are handled atomically by database triggers
          // (post_sales_invoice_journal, validate_sales_invoice_amount_equation,
          // and derive_journal_header_totals_from_lines) on sales_invoices UPDATE.

          // 3. Synchronize General Ledger (COGS Journal Entry lines if present)
          const { data: cogsJe, error: cogsFetchError } = await supabase
            .from('journal_entries')
            .select('id')
            .eq('source_module', 'sales_invoice_cogs')
            .eq('reference_id', editingInvoice.id)
            .maybeSingle();
          if (cogsFetchError) throw cogsFetchError;

          if (cogsJe) {
            let totalCogs = 0;
            for (const item of items) {
              const unitCost = getBatchCostPerUnit(item.batch_id);
              totalCogs += (Number(item.quantity) || 0) * unitCost;
            }

            if (totalCogs > 0) {
              const { data: cogsLines, error: cogsLinesFetchError } = await supabase
                .from('journal_entry_lines')
                .select('id, account_id, chart_of_accounts(code)')
                .eq('journal_entry_id', cogsJe.id);
              if (cogsLinesFetchError) throw cogsLinesFetchError;

              for (const line of cogsLines || []) {
                const coaCode = (line.chart_of_accounts as any)?.code;
                if (coaCode === '5100') {
                  const { error: cogsDebitErr } = await supabase
                    .from('journal_entry_lines')
                    .update({ debit: totalCogs, credit: 0 })
                    .eq('id', line.id);
                  if (cogsDebitErr) throw cogsDebitErr;
                } else if (coaCode === '1130') {
                  const { error: cogsCreditErr } = await supabase
                    .from('journal_entry_lines')
                    .update({ debit: 0, credit: totalCogs })
                    .eq('id', line.id);
                  if (cogsCreditErr) throw cogsCreditErr;
                }
              }

              const { error: cogsHeaderErr } = await supabase
                .from('journal_entries')
                .update({
                  total_debit: totalCogs,
                  total_credit: totalCogs,
                })
                .eq('id', cogsJe.id);
              if (cogsHeaderErr) throw cogsHeaderErr;
            }
          }

          // 4. Audit Log entry for the posted invoice correction
          await Promise.resolve(
            supabase.from('audit_logs').insert({
              table_name: 'sales_invoices',
              record_id: editingInvoice.id,
              action: 'POSTED_INVOICE_CORRECTION',
              user_id: profile?.id || null,
              details: {
                invoice_number: editingInvoice.invoice_number,
                old_total: editingInvoice.total_amount,
                new_total: total,
                old_subtotal: editingInvoice.subtotal,
                new_subtotal: subtotal,
                revised_items: items.map((i) => ({
                  product_id: i.product_id,
                  quantity: i.quantity,
                  unit_price: i.unit_price,
                  total: i.total,
                })),
                notes: formData.notes || 'Controlled posted invoice correction',
              },
            })
          ).catch(() => {});

          showToast({
            type: 'success',
            title: 'Invoice Corrected',
            message: `Invoice ${editingInvoice.invoice_number} corrected successfully. Accounting postings and stock synchronized.`,
          });

          emitErpSync('sales_invoices', 'updated', { entityId: editingInvoice.id });
          emitErpSync('sales_orders', 'updated');
          emitErpSync('inventory', 'updated');
          await loadInvoices();
          setModalOpen(false);
          resetForm();
          return;
        }

        // HARDENING FIX #1: Use atomic RPC to prevent race conditions
        // All operations (delete + update + insert) happen in single transaction

        // Deduplicate items before sending (in case of UI state issues)
        const itemsMap = new Map();
        items
          .filter((item) => item.product_id && item.product_id.trim() !== '')
          .forEach((item) => {
            const key = `${item.product_id}-${item.batch_id}-${item.delivery_challan_item_id || 'manual'}`;
            if (!itemsMap.has(key)) {
              itemsMap.set(key, {
                product_id: item.product_id,
                batch_id: item.batch_id,
                quantity: item.quantity,
                unit_price: item.unit_price,
                tax_rate: item.tax_rate,
                total_amount: item.total,
                delivery_challan_item_id: item.delivery_challan_item_id || null,
                max_quantity: item.max_quantity || null,
              });
            }
          });

        const atomicItems = Array.from(itemsMap.values());

        const { data: invoiceId, error: rpcError } = await supabase.rpc(
          'update_sales_invoice_atomic',
          {
            p_invoice_id: editingInvoice.id,
            p_invoice_updates: {
              invoice_date: formData.invoice_date,
              due_date: dueDate.toISOString().split('T')[0],
              customer_id: formData.customer_id,
              subtotal: totals.subtotal,
              tax_amount: totals.taxAmount,
              stamp_duty_amount: totals.stampDuty,
              linked_challan_ids: sourceDCIds.length > 0 ? sourceDCIds : null,
              total_amount: totals.total,
              discount_amount: formData.discount,
              po_number: formData.po_number || null,
              payment_terms_days: paymentTermsDays,
              notes: formData.notes || null,
            },
            p_new_items: atomicItems,
          }
        );

        if (rpcError) throw rpcError;

        // Fetch updated invoice for return
        const { data: updatedInvoice, error: fetchError } = await supabase
          .from('sales_invoices')
          .select()
          .eq('id', editingInvoice.id)
          .single();

        if (fetchError) throw fetchError;
        invoice = updatedInvoice;
      } else {
        // Check if invoice number already exists and regenerate if needed
        let invoiceNumber = formData.invoice_number;
        const { data: existingInvoice } = await supabase
          .from('sales_invoices')
          .select('invoice_number')
          .eq('invoice_number', invoiceNumber)
          .maybeSingle();

        if (existingInvoice) {
          // Invoice number already exists, generate a new one
          invoiceNumber = await generateNextInvoiceNumber();
          setFormData((prev) => ({ ...prev, invoice_number: invoiceNumber }));
        }

        // Filter and map only valid items (with product_id)
        const invoiceItemsData = items
          .filter((item) => item.product_id && item.product_id.trim() !== '')
          .map((item) => {
            if (!item.delivery_challan_item_id) {
              throw new Error(
                'Every invoice line must have a source Delivery Challan item. Select the Delivery Challan item again before saving.'
              );
            }

            return {
              product_id: item.product_id,
              batch_id: item.batch_id,
              quantity: item.quantity,
              unit_price: item.unit_price,
              tax_rate: item.tax_rate,
              delivery_challan_item_id: item.delivery_challan_item_id,
            };
          });

        if (invoiceItemsData.length === 0)
          throw new Error('Invoice product rows were empty; no invoice was created.');

        // New invoices are created in one database transaction. The RPC
        // derives totals from the persisted source lines and rolls back the
        // header, items, journal, and links if any validation fails.
        const { data: newInvoiceId, error: invoiceError } = await supabase.rpc(
          'create_sales_invoice_atomic',
          {
            p_invoice: {
              invoice_number: invoiceNumber,
              customer_id: formData.customer_id,
              // sales_order_id: selectedSOId is resolved from authoritative DC items above.
              sales_order_id: sourceSOId,
              invoice_date: formData.invoice_date,
              due_date: dueDate.toISOString().split('T')[0],
              discount_amount: formData.discount,
              po_number: formData.po_number || null,
              payment_terms_days: paymentTermsDays,
              notes: formData.notes || null,
              subtotal: totals.subtotal,
              tax_amount: totals.taxAmount,
              stamp_duty_amount: totals.stampDuty,
              total_amount: totals.total,
              created_by: user.id,
              linked_challan_ids: sourceDCIds.length > 0 ? sourceDCIds : null,
            },
            p_items: invoiceItemsData,
          }
        );
        if (invoiceError) throw invoiceError;
        const { data: newInvoice, error: fetchInvoiceError } = await supabase
          .from('sales_invoices')
          .select()
          .eq('id', newInvoiceId)
          .single();
        if (fetchInvoiceError) throw fetchInvoiceError;
        invoice = newInvoice;
      }

      // Stock deduction and inventory transactions are handled automatically by database trigger

      emitErpSync('sales_invoices', editingInvoice ? 'updated' : 'created', { entityId: invoice?.id });
      emitErpSync('sales_orders', 'updated');
      emitErpSync('inventory', 'updated');
      await loadInvoices();
      await loadBatches();

      // Notify warehouse staff on new invoice (non-blocking)
      if (!editingInvoice && invoice?.id) {
        supabase.functions
          .invoke('send-app-notifications', {
            body: { type: 'invoice_created', data: { invoice_id: invoice.id } },
          })
          .catch(() => {});
      }

      setModalOpen(false);
      resetForm();
    } catch (error: any) {
      console.error('Error saving invoice:', error);
      showToast({
        type: 'error',
        title: 'Error',
        message: `Failed to save invoice: ${error.message || 'Unknown error'}. Please check console for details.`,
      });
    }
  };

  const handleView = async (invoice: SalesInvoice) => {
    setSelectedInvoice(invoice);
    const items = await loadInvoiceItems(invoice.id);
    setViewModalOpen(true);
  };

  useEffect(() => {
    if (navigationData?.sourceType !== 'sales_invoice' || !navigationData.invoiceId) return;
    const openSourceInvoice = async () => {
      const { data, error } = await supabase
        .from('sales_invoices')
        .select('*, customers(company_name)')
        .eq('id', String(navigationData.invoiceId))
        .maybeSingle();
      if (error) {
        console.error('Error opening journal source sales invoice:', error);
      } else if (data) {
        await handleView(data as SalesInvoice);
      }
      clearNavigationData();
    };
    void openSourceInvoice();
  }, [navigationData, clearNavigationData]);

  const handleEdit = async (invoice: SalesInvoice) => {
    const isPosted = isPostedInvoice(invoice);
    if (isPosted && !isFinancialEditor) {
      showToast({
        type: 'warning',
        title: 'Permission Denied',
        message: 'Only Admin and Accounts can edit financially posted invoices.',
      });
      return;
    }
    setEditingInvoice(invoice);
    setFormData({
      invoice_number: invoice.invoice_number,
      customer_id: invoice.customer_id,
      invoice_date: invoice.invoice_date,
      payment_terms: String(invoice.payment_terms_days || 30),
      discount: invoice.discount_amount || 0,
      stamp_duty_amount: Number(invoice.stamp_duty_amount) || 0,
      delivery_challan_number: invoice.delivery_challan_number || '',
      po_number: invoice.po_number || '',
      notes: invoice.notes || '',
    });

    const loadedItems = await loadInvoiceItems(invoice.id);

    if (loadedItems.length > 0) {
      setItems(
        loadedItems.map((item) => {
          const mappedItem = {
            id: item.id,
            product_id: item.product_id,
            batch_id: item.batch_id,
            quantity: item.quantity,
            unit_price: item.unit_price,
            tax_rate: item.tax_rate,
            total: 0,
            delivery_challan_item_id: item.delivery_challan_item_id,
            challan_id: item.challan_id,
            dc_number: item.dc_number,
          };
          return {
            ...mappedItem,
            total: calculateItemTotal(mappedItem),
          };
        })
      );
    }

    await loadPendingDCOptions(invoice.customer_id);

    const linkedDCIds = [
      ...new Set([
        ...loadedItems.map((item: any) => item.challan_id).filter(Boolean),
        ...(invoice.linked_challan_ids ?? []),
      ]),
    ] as string[];
    setSelectedDCIds(linkedDCIds);
    await ensureLinkedDCOptionsVisible(linkedDCIds);

    setModalOpen(true);
  };

  const handleCancelInvoice = async (invoice: SalesInvoice) => {
    if (!isFinancialEditor) {
      showToast({
        type: 'warning',
        title: 'Permission Denied',
        message: 'Only Admin and Accounts can cancel financially posted invoices.',
      });
      return;
    }

    const isAlreadyMarkedCancelled = isCancelledInvoice(invoice);

    const paidAmt = Number(invoice.paid_amount || 0);
    if (paidAmt > 0.01) {
      showToast({
        type: 'error',
        title: 'Payment Allocated',
        message: `Cannot cancel invoice ${invoice.invoice_number}: payments totaling Rp ${paidAmt.toLocaleString('id-ID')} are allocated. Unallocate or reverse the receipts in Payment Receipts before cancelling.`,
      });
      return;
    }

    const confirmed = await showConfirm({
      title: isAlreadyMarkedCancelled ? 'Complete Financial Reversal' : 'Cancel Posted Invoice',
      message: isAlreadyMarkedCancelled
        ? `Invoice ${invoice.invoice_number} is marked as cancelled, but may have unreversed General Ledger postings (A/R, Revenue, Tax, or COGS).\n\nDo you want to verify and complete the financial reversal now?`
        : `Cancel invoice ${invoice.invoice_number}?\n\nThis will:\n- Reverse General Ledger postings (A/R, Revenue, Tax, and COGS)\n- Release linked Delivery Challans so they can be adjusted or re-invoiced\n- Preserve invoice number and audit logs\n\nAre you sure you want to proceed?`,
      variant: 'danger',
      confirmLabel: isAlreadyMarkedCancelled ? 'Reverse Postings' : 'Cancel Invoice',
    });
    if (!confirmed) return;

    try {
      const cancelDate = new Date().toISOString().split('T')[0];
      const cancelUser = profile?.full_name || profile?.email || 'Admin';
      const reasonTag = `[CANCELLED on ${cancelDate} by ${cancelUser}]`;

      // Try atomic transactional server RPC first if migration is applied
      let rpcHandled = false;
      try {
        const { data: rpcResult, error: rpcError } = await supabase.rpc('cancel_sales_invoice', {
          p_invoice_id: invoice.id,
          p_reason: reasonTag,
          p_actor: profile?.id || null,
        });
        if (rpcError) {
          const isMissingRpc =
            rpcError.code === 'PGRST202' ||
            rpcError.message?.toLowerCase().includes('function') ||
            rpcError.message?.toLowerCase().includes('not found');
          if (isMissingRpc) {
            console.warn('cancel_sales_invoice RPC not found, falling back to direct reversal:', rpcError);
          } else {
            throw rpcError;
          }
        } else if ((rpcResult as any)?.success) {
          rpcHandled = true;
        }
      } catch (rpcErr: any) {
        if (
          rpcErr?.code !== 'PGRST202' &&
          !rpcErr?.message?.toLowerCase().includes('not found') &&
          !rpcErr?.message?.toLowerCase().includes('function')
        ) {
          throw rpcErr;
        }
      }

      if (!rpcHandled) {
        // 1. Reverse Revenue Journal Entry
        const revenueJeIds: string[] = [];
        if (invoice.journal_entry_id) {
          revenueJeIds.push(invoice.journal_entry_id);
        }

        // Comprehensive search: match by reference_id OR reference_number across known revenue modules
        const { data: foundRevenueJes, error: revSearchErr } = await supabase
          .from('journal_entries')
          .select('id, entry_number, is_reversed')
          .in('source_module', ['sales_invoice', 'sales', 'sales_invoices'])
          .or(`reference_id.eq.${invoice.id},reference_number.eq.${invoice.invoice_number}`);

        if (revSearchErr) console.warn('Warning querying revenue journals:', revSearchErr);
        if (foundRevenueJes) {
          for (const je of foundRevenueJes) {
            if (!revenueJeIds.includes(je.id)) revenueJeIds.push(je.id);
          }
        }

        for (const jeId of revenueJeIds) {
          const { error: revUpdateErr } = await supabase
            .from('journal_entries')
            .update({
              is_reversed: true,
              reversed_by_id: null,
              description: `${reasonTag} ${invoice.invoice_number}`,
            })
            .eq('id', jeId)
            .eq('is_reversed', false);

          if (revUpdateErr) {
            throw new Error(
              `Failed to reverse revenue journal entry (${jeId}): ${revUpdateErr.message}`
            );
          }
        }

        // 2. Reverse COGS Journal Entry if present
        const { data: cogsJes, error: cogsSearchErr } = await supabase
          .from('journal_entries')
          .select('id, entry_number, is_reversed')
          .eq('source_module', 'sales_invoice_cogs')
          .or(`reference_id.eq.${invoice.id},reference_number.eq.${invoice.invoice_number}`);

        if (cogsSearchErr) console.warn('Warning querying COGS journals:', cogsSearchErr);
        if (cogsJes) {
          for (const cogsJe of cogsJes) {
            const { error: cogsUpdateErr } = await supabase
              .from('journal_entries')
              .update({
                is_reversed: true,
                reversed_by_id: null,
                description: `${reasonTag} ${invoice.invoice_number} COGS`,
              })
              .eq('id', cogsJe.id)
              .eq('is_reversed', false);

            if (cogsUpdateErr) {
              throw new Error(
                `Failed to reverse COGS journal entry (${cogsJe.id}): ${cogsUpdateErr.message}`
              );
            }
          }
        }

        // 3. Unlink invoice items from Delivery Challan items (so DC is unbilled and can be reversed or adjusted)
        await Promise.resolve(
          supabase
            .from('sales_invoice_items')
            .update({ delivery_challan_item_id: null })
            .eq('invoice_id', invoice.id)
        ).catch(() => {});

        // 4. Update sales invoice header to record cancellation
        const updatedNotes = invoice.notes
          ? invoice.notes.includes('[CANCELLED')
            ? invoice.notes
            : `${reasonTag}\n${invoice.notes}`
          : reasonTag;

        const { error: invError } = await supabase
          .from('sales_invoices')
          .update({
            notes: updatedNotes,
            balance_amount: 0,
            updated_at: new Date().toISOString(),
          })
          .eq('id', invoice.id);

        if (invError) throw invError;

        // 5. Update Faktur Pajak status to cancelled if exists (Indonesian Coretax requirement)
        await Promise.resolve(
          supabase
            .from('faktur_pajak')
            .update({
              status: 'cancelled',
              notes: `${reasonTag} Sales Invoice cancelled`,
              updated_at: new Date().toISOString(),
            })
            .eq('sales_invoice_id', invoice.id)
        ).catch(() => {});

        // 6. Record detailed audit log
        await Promise.resolve(
          supabase.from('audit_logs').insert({
            table_name: 'sales_invoices',
            record_id: invoice.id,
            action: 'INVOICE_CANCELLED',
            user_id: profile?.id || null,
            details: {
              invoice_number: invoice.invoice_number,
              original_total: invoice.total_amount,
              cancelled_at: new Date().toISOString(),
              cancelled_by: profile?.id || null,
              faktur_pajak_number: invoice.faktur_pajak_number || null,
              revenue_journal_ids: revenueJeIds,
              cogs_journal_ids: (cogsJes || []).map((j) => j.id),
            },
          })
        ).catch(() => {});
      }

      showToast({
        type: 'success',
        title: isAlreadyMarkedCancelled ? 'Reversal Completed' : 'Invoice Cancelled',
        message: `Invoice ${invoice.invoice_number} has been cancelled. Accounting entries reversed and linked Delivery Challan released.`,
      });

      emitErpSync('sales_invoices', 'cancelled', { entityId: invoice?.id });
      emitErpSync('sales_orders', 'updated');
      emitErpSync('inventory', 'updated');
      await loadInvoices();
    } catch (error: any) {
      console.error('Error cancelling invoice:', error);
      showToast({
        type: 'error',
        title: 'Cancellation Failed',
        message: error.message || 'Failed to cancel invoice. Please try again.',
      });
    }
  };

  const handleDelete = async (id: string) => {
    const targetInvoice = invoices.find((inv) => inv.id === id);
    if (!targetInvoice) return;

    if (isPostedInvoice(targetInvoice)) {
      await handleCancelInvoice(targetInvoice);
      return;
    }

    if (
      !(await showConfirm({
        title: 'Confirm',
        message: 'Are you sure you want to delete this draft invoice?',
        variant: 'danger',
        confirmLabel: 'Delete',
      }))
    )
      return;

    try {
      // Delete child sales_invoice_items first to satisfy guard_posted_sales_invoice_delete trigger
      await supabase.from('sales_invoice_items').delete().eq('invoice_id', id);

      const { error } = await supabase.from('sales_invoices').delete().eq('id', id);

      if (error) throw error;
      emitErpSync('sales_invoices', 'deleted', { entityId: id });
      loadInvoices();
      showToast({
        type: 'success',
        title: 'Success',
        message: 'Draft invoice deleted successfully.',
      });
    } catch (error: any) {
      console.error('Error deleting invoice:', error);
      showToast({
        type: 'error',
        title: 'Error',
        message: error.message || 'Failed to delete invoice. Please try again.',
      });
    }
  };

  const updatePaymentStatus = async (
    invoice: SalesInvoice,
    newStatus: SalesInvoice['payment_status']
  ) => {
    try {
      const { error } = await supabase
        .from('sales_invoices')
        .update({ payment_status: newStatus })
        .eq('id', invoice.id);

      if (error) throw error;
      loadInvoices();
    } catch (error) {
      console.error('Error updating payment status:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to update payment status.' });
    }
  };

  const resetForm = () => {
    setEditingInvoice(null);
    setSelectedChallanId('');
    setPendingChallans([]);
    setPendingDCOptions([]);
    setSelectedDCIds([]);
    setSelectedSOId('');
    setSoAutoLinked(false);
    setCustomerSalesOrders([]);
    setFormData({
      invoice_number: '',
      customer_id: '',
      invoice_date: new Date().toISOString().split('T')[0],
      payment_terms: '30',
      discount: 0,
      stamp_duty_amount: 0,
      delivery_challan_number: '',
      po_number: '',
      notes: '',
    });
    setItems([
      {
        product_id: '',
        batch_id: null,
        quantity: 1,
        unit_price: 0,
        tax_rate: 11,
        total: 0,
      },
    ]);
  };

  const columns = [
    {
      key: 'invoice_date',
      label: t('common.date'),
      render: (value: any, inv: SalesInvoice) => formatDate(inv.invoice_date),
    },
    {
      key: 'invoice_number',
      label: t('sales.invoiceNumber'),
      render: (value: any, inv: SalesInvoice) => (
        <div>
          <div>{inv.invoice_number}</div>
          {inv.item_integrity_status === 'missing_product_rows' && (
            <div className="text-[10px] font-semibold text-red-700">Missing product rows</div>
          )}
        </div>
      ),
    },
    {
      key: 'customer',
      label: t('sales.customer'),
      render: (value: any, inv: SalesInvoice) => (
        <div className="font-medium">{inv.customers?.company_name}</div>
      ),
    },
    {
      key: 'total_amount',
      label: t('common.total'),
      render: (value: any, inv: SalesInvoice) => (
        <span className="font-medium text-sm">
          Rp{' '}
          {inv.total_amount.toLocaleString('id-ID', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          })}
        </span>
      ),
    },
    {
      key: 'payment_status',
      label: t('sales.paymentStatus'),
      render: (value: any, inv: SalesInvoice) => {
        if (isCancelledInvoice(inv)) {
          return (
            <span className="inline-block px-1.5 py-0.5 rounded-full text-[11px] leading-tight font-medium bg-gray-200 text-gray-700">
              Cancelled
            </span>
          );
        }
        return (
          <span
            className={`inline-block px-1.5 py-0.5 rounded-full text-[11px] leading-tight font-medium ${
              inv.payment_status === 'paid'
                ? 'bg-green-100 text-green-800'
                : inv.payment_status === 'partial'
                  ? 'bg-yellow-100 text-yellow-800'
                  : 'bg-red-100 text-red-800'
            }`}
          >
            {inv.payment_status === 'pending'
              ? t('common.unpaid')
              : inv.payment_status === 'partial'
                ? t('common.partial')
                : t('common.paid')}
          </span>
        );
      },
    },
    {
      key: 'balance_amount',
      label: t('sales.balance'),
      render: (value: any, inv: SalesInvoice) => (
        <span
          className={`font-medium ${
            (inv.balance_amount || 0) === 0 ? 'text-gray-400' : 'text-orange-600'
          }`}
        >
          Rp{' '}
          {(inv.balance_amount || 0).toLocaleString('id-ID', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          })}
        </span>
      ),
    },
    {
      key: 'so_dc_link',
      label: 'Linked Docs',
      thClassName: 'min-w-[150px]',
      tdClassName: 'min-w-[150px]',
      render: (_value: any, inv: SalesInvoice) => (
        <LinkedDocsCell
          sos={
            inv.sales_order?.so_number
              ? [{ id: inv.sales_order_id || '', number: inv.sales_order.so_number, type: 'so' }]
              : []
          }
          dcs={(inv.linked_challans || []).map((dc) => ({
            id: dc.id,
            number: dc.challan_number,
            type: 'dc' as const,
          }))}
          invs={[]}
          show={{ inv: false }}
          onClick={(doc: LinkedDocRef) => {
            if (doc.type === 'dc') handleFlyChallanClick(doc.id);
            if (doc.type === 'so') openLinkedSalesOrderView(doc.id);
          }}
        />
      ),
    },
    {
      key: 'due_date',
      label: 'Due Date',
      thClassName: 'min-w-[120px]',
      render: (value: any, inv: SalesInvoice) => {
        if (!inv.due_date || inv.payment_status === 'paid') {
          return <span className="text-gray-400">—</span>;
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const due = new Date(inv.due_date);
        due.setHours(0, 0, 0, 0);
        const daysUntilDue = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        const isUrgent = daysUntilDue <= 7;
        const isOverdue = daysUntilDue < 0;
        return (
          <span
            className={`font-medium ${
              isOverdue ? 'text-red-700' : isUrgent ? 'text-red-500' : 'text-gray-700'
            }`}
          >
            {formatDate(inv.due_date)}
            {isOverdue && (
              <span className="ml-1 text-[11px] bg-red-100 text-red-700 px-1 py-0.5 rounded">
                Overdue
              </span>
            )}
            {!isOverdue && isUrgent && (
              <span className="ml-1 text-[11px] bg-red-50 text-red-500 px-1 py-0.5 rounded">
                {daysUntilDue}d left
              </span>
            )}
          </span>
        );
      },
    },
  ];

  const cancelledColumns = [
    {
      key: 'invoice_date',
      label: t('common.date'),
      render: (value: any, inv: SalesInvoice) => formatDate(inv.invoice_date),
    },
    {
      key: 'invoice_number',
      label: t('sales.invoiceNumber'),
      render: (value: any, inv: SalesInvoice) => (
        <div className="font-semibold text-gray-800">{inv.invoice_number}</div>
      ),
    },
    {
      key: 'customer',
      label: t('sales.customer'),
      render: (value: any, inv: SalesInvoice) => (
        <div className="font-medium text-gray-800">{inv.customers?.company_name}</div>
      ),
    },
    {
      key: 'total_amount',
      label: 'Original Amount',
      render: (value: any, inv: SalesInvoice) => (
        <span className="font-medium text-sm text-gray-500 line-through">
          Rp{' '}
          {inv.total_amount.toLocaleString('id-ID', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          })}
        </span>
      ),
    },
    {
      key: 'cancellation_status',
      label: 'Status',
      render: () => (
        <span className="inline-block px-2 py-0.5 rounded-full text-[11px] leading-tight font-medium bg-rose-100 text-rose-800 border border-rose-200">
          Cancelled (Archived)
        </span>
      ),
    },
    {
      key: 'cancellation_details',
      label: 'Cancellation Reason & Attribution',
      thClassName: 'min-w-[250px]',
      tdClassName: 'min-w-[250px]',
      render: (value: any, inv: SalesInvoice) => {
        const reason = inv.cancellation_reason || inv.notes || null;
        const displayReason = reason ? reason.split('\n')[0] : 'No reason recorded';
        const hasVerifiedAuthor = Boolean(inv.cancelled_by && inv.canceller_name);

        return (
          <div className="text-xs text-rose-950 bg-rose-50/80 border border-rose-200/80 rounded px-2.5 py-1.5 space-y-0.5" title={reason || undefined}>
            <div className="truncate font-semibold text-[11px]">{displayReason}</div>
            <div className="text-[10px] text-gray-600 flex flex-wrap items-center gap-x-2">
              {inv.cancelled_at && (
                <span>Cancelled: {formatDate(inv.cancelled_at.split('T')[0])}</span>
              )}
              <span>
                By:{' '}
                {hasVerifiedAuthor ? (
                  <span className="font-semibold text-gray-900">{inv.canceller_name}</span>
                ) : (
                  <span className="italic text-gray-500">Unknown (historical record)</span>
                )}
              </span>
            </div>
          </div>
        );
      },
    },
    {
      key: 'so_dc_link',
      label: 'Linked Docs',
      thClassName: 'min-w-[150px]',
      tdClassName: 'min-w-[150px]',
      render: (_value: any, inv: SalesInvoice) => (
        <LinkedDocsCell
          sos={
            inv.sales_order?.so_number
              ? [{ id: inv.sales_order_id || '', number: inv.sales_order.so_number, type: 'so' }]
              : []
          }
          dcs={(inv.linked_challans || []).map((dc) => ({
            id: dc.id,
            number: dc.challan_number,
            type: 'dc' as const,
          }))}
          invs={[]}
          show={{ inv: false }}
          onClick={(doc: LinkedDocRef) => {
            if (doc.type === 'dc') handleFlyChallanClick(doc.id);
            if (doc.type === 'so') openLinkedSalesOrderView(doc.id);
          }}
        />
      ),
    },
  ];

  const canManage =
    profile?.role === 'admin' ||
    profile?.role === 'accounts' ||
    profile?.role === 'sales' ||
    profile?.role === 'warehouse';

  const isAdmin = profile?.role === 'admin';

  const activeInvoices = invoices.filter((inv) => !isCancelledInvoice(inv));
  const postedInvoices = invoices.filter((inv) => isPostedInvoice(inv));
  const draftInvoices = invoices.filter((inv) => !isCancelledInvoice(inv) && !isPostedInvoice(inv));
  const cancelledInvoices = invoices.filter((inv) => isCancelledInvoice(inv));

  const displayedInvoices =
    activeTab === 'posted'
      ? postedInvoices
      : activeTab === 'drafts'
        ? draftInvoices
        : activeTab === 'cancelled'
          ? cancelledInvoices
          : activeInvoices;

  // 1. Recognized sales: calculated strictly from POSTED, non-cancelled invoices
  const postedCount = postedInvoices.length;
  const postedRevenue = postedInvoices.reduce((sum, inv) => sum + (Number(inv.total_amount) || 0), 0);
  const pendingInvoices = postedInvoices.filter((inv) => inv.payment_status === 'pending' || inv.payment_status === 'partial');
  const pendingCount = pendingInvoices.length;
  const pendingValue = postedInvoices.reduce((sum, inv) => sum + (Number(inv.balance_amount) || 0), 0);
  const paidInvoices = postedInvoices.filter((inv) => inv.payment_status === 'paid');
  const paidCount = paidInvoices.length;
  const paidValue = postedInvoices.reduce((sum, inv) => sum + (Number(inv.paid_amount) || 0), 0);

  // 2. Draft metrics: segregated from recognized sales revenue
  const draftCount = draftInvoices.length;
  const draftValue = draftInvoices.reduce((sum, inv) => sum + (Number(inv.total_amount) || 0), 0);

  // 3. Cancelled metrics: archived totals
  const cancelledCount = cancelledInvoices.length;
  const cancelledValue = cancelledInvoices.reduce((sum, inv) => sum + (Number(inv.total_amount) || 0), 0);

  const stats = {
    total: activeInvoices.length,
    postedCount,
    totalRevenue: postedRevenue,
    pending: pendingCount,
    pendingValue,
    paid: paidCount,
    paidValue,
    draftCount,
    draftValue,
    cancelled: cancelledCount,
    cancelledValue,
    activeCount: activeInvoices.length,
  };

  return (
    <Layout>
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2 border-b border-gray-200">
          <div>
            <h1 className="text-lg sm:text-xl font-bold text-gray-900 tracking-tight">
              {t('sales.title')}
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">{t('sales.invoices')}</p>
          </div>
          {canManage && (
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  resetForm();
                  const nextInvoiceNumber = await generateNextInvoiceNumber();
                  setFormData((prev) => ({ ...prev, invoice_number: nextInvoiceNumber }));
                  setModalOpen(true);
                }}
                className="flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-blue-700 shadow-xs transition"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('sales.createInvoice')}
              </button>
              <button
                onClick={() => {
                  setCurrentPage('credit-notes');
                }}
                className="flex items-center gap-1.5 bg-red-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-red-700 shadow-xs transition"
              >
                <FileX className="w-3.5 h-3.5" />
                {t('nav.creditNotes')}
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs px-3.5 py-2 min-h-[64px] flex flex-col justify-between">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
              Posted Invoices
            </span>
            <div className="mt-0.5 flex items-baseline justify-between">
              <span className="text-base font-bold text-gray-900">{stats.postedCount}</span>
              {stats.draftCount > 0 && (
                <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded font-medium" title="Unposted draft documents">
                  +{stats.draftCount} draft{stats.draftCount > 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
          {isAdmin && (
            <div className="bg-white rounded-xl border border-blue-200 shadow-xs px-3.5 py-2 min-h-[64px] flex flex-col justify-between">
              <span className="text-[11px] font-semibold text-blue-600 uppercase tracking-wide">
                Recognized Revenue
              </span>
              <div className="text-base font-bold text-blue-700 mt-0.5 leading-tight">
                Rp {stats.totalRevenue.toLocaleString('id-ID', { maximumFractionDigits: 0 })}
              </div>
            </div>
          )}
          <div className="bg-white rounded-xl border border-red-200 shadow-xs px-3.5 py-2 min-h-[64px] flex flex-col justify-between">
            <span className="text-[11px] font-semibold text-red-600 uppercase tracking-wide">
              {t('common.pending')} Receivables
            </span>
            <div className="mt-0.5">
              <span className="text-base font-bold text-red-600">{stats.pending}</span>
              <span className="text-[10px] text-red-500 ml-1.5 font-medium">
                (Rp {stats.pendingValue.toLocaleString('id-ID', { maximumFractionDigits: 0 })})
              </span>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-green-200 shadow-xs px-3.5 py-2 min-h-[64px] flex flex-col justify-between">
            <span className="text-[11px] font-semibold text-green-600 uppercase tracking-wide">
              {t('common.paid')} Received
            </span>
            <div className="mt-0.5">
              <span className="text-base font-bold text-green-600">{stats.paid}</span>
              <span className="text-[10px] text-green-500 ml-1.5 font-medium">
                (Rp {stats.paidValue.toLocaleString('id-ID', { maximumFractionDigits: 0 })})
              </span>
            </div>
          </div>
        </div>

        {stats.draftCount > 0 && (
          <div className="bg-amber-50/70 border border-amber-200 rounded-lg px-3 py-1.5 text-xs text-amber-900 flex flex-wrap items-center justify-between gap-1">
            <span className="font-medium">
              Unposted Draft Invoices: <strong>{stats.draftCount} draft{stats.draftCount > 1 ? 's' : ''}</strong> (totaling Rp {stats.draftValue.toLocaleString('id-ID', { maximumFractionDigits: 0 })})
            </span>
            <span className="text-[11px] text-amber-700 italic">
              Excluded from recognized sales revenue, receivables, and accounting ledger until posted.
            </span>
          </div>
        )}

        {/* Tab Navigation: All Active, Posted, Drafts, Cancelled Archive */}
        <div className="flex items-center gap-1.5 border-b border-gray-200 pb-2">
          <button
            onClick={() => setActiveTab('active')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              activeTab === 'active'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            All Active ({activeInvoices.length})
          </button>
          <button
            onClick={() => setActiveTab('posted')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              activeTab === 'posted'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            Posted ({postedInvoices.length})
          </button>
          <button
            onClick={() => setActiveTab('drafts')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              activeTab === 'drafts'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            Drafts ({draftInvoices.length})
          </button>
          <button
            onClick={() => setActiveTab('cancelled')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
              activeTab === 'cancelled'
                ? 'bg-rose-700 text-white shadow-xs'
                : 'text-rose-700 hover:bg-rose-50 border border-rose-200'
            }`}
          >
            <Archive className="w-3.5 h-3.5" />
            Cancelled Archive ({cancelledInvoices.length})
          </button>
        </div>

        <DataTable
          columns={activeTab === 'cancelled' ? cancelledColumns : columns}
          data={displayedInvoices}
          loading={loading}
          compact
          tableClassName="w-full min-w-[1200px]"
          actions={(invoice) => (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleView(invoice)}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                title={t('common.view')}
              >
                <Eye className="w-4 h-4" />
              </button>
              {canManage && activeTab !== 'cancelled' && (
                <>
                  {!isCancelledInvoice(invoice) && (
                    <button
                      onClick={() => handleEdit(invoice)}
                      className="p-1 text-indigo-600 hover:bg-indigo-50 rounded"
                      title={t('common.edit')}
                    >
                      <Edit className="w-4 h-4" />
                    </button>
                  )}
                  {isCancelledInvoice(invoice) ? (
                    <span
                      className={`inline-flex items-center gap-1 text-[11px] font-medium text-gray-500 bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded ${isFinancialEditor ? 'cursor-pointer hover:bg-gray-200' : 'cursor-help'}`}
                      title={
                        isFinancialEditor
                          ? `${invoice.notes?.split('\n')[0] || 'Cancelled Invoice'}. Click to verify or complete financial reversal.`
                          : invoice.notes?.split('\n')[0] || 'Cancelled Invoice'
                      }
                      onClick={() => isFinancialEditor && handleCancelInvoice(invoice)}
                    >
                      <Ban className="w-3 h-3 text-gray-400" />
                      Cancelled
                    </span>
                  ) : !isPostedInvoice(invoice) ? (
                    <button
                      onClick={() => handleDelete(invoice.id)}
                      className="p-1 text-red-600 hover:bg-red-50 rounded"
                      title={t('common.delete')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  ) : (
                    <button
                      onClick={() => handleCancelInvoice(invoice)}
                      className="p-1 text-red-600 hover:bg-red-50 rounded transition-colors"
                      title="Cancel Posted Invoice (Reverse Accounting & Unbill Challan)"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        />

        <Modal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            resetForm();
          }}
          title={
            editingInvoice
              ? `${isEditingPosted ? 'Edit Invoice (Posted)' : t('sales.editInvoice')}: ${editingInvoice.invoice_number}`
              : t('sales.createInvoice')
          }
          size="xl"
        >
          <form onSubmit={handleSubmit} className="space-y-3">
            {isEditingPosted && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start gap-2">
                <Lock className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-amber-900">
                    Financially Posted Invoice — Controlled Revision Mode
                  </div>
                  <div>
                    {isFinancialEditor
                      ? 'Authorized revision: You can update Quantities, Unit Prices, Tax %, Bea Meterai, Terms, PO Number, and Notes. Warehouse stock and General Ledger postings will be synchronized automatically.'
                      : 'Financially posted invoices are locked. Contact an Administrator or Accounts manager to revise commercial terms.'}
                  </div>
                </div>
              </div>
            )}
            <div className="space-y-2">
              <SapRow>
                <FloatingField
                  label={t('sales.invoiceNumber')}
                  required
                  span={4}
                  filled={!!formData.invoice_number}
                >
                  <input
                    name="t_sales_invoicenumber"
                    aria-label="{t('sales.invoiceNumber')}"
                    type="text"
                    value={formData.invoice_number}
                    className={FLOAT_INPUT + ' bg-gray-100'}
                    required
                    readOnly
                    disabled
                  />
                </FloatingField>
                <FloatingField
                  label="Invoice Date"
                  required
                  span={4}
                  filled={!!formData.invoice_date}
                >
                  <input
                    name="invoice_date"
                    aria-label="Invoice Date"
                    type="date"
                    value={formData.invoice_date}
                    onChange={(e) => setFormData({ ...formData, invoice_date: e.target.value })}
                    className={FLOAT_INPUT}
                    required
                  />
                </FloatingField>
                <FloatingField
                  label="Payment Terms"
                  required
                  span={4}
                  filled={!!formData.payment_terms}
                >
                  <select
                    name="payment_terms"
                    aria-label="Payment Terms"
                    value={formData.payment_terms}
                    onChange={(e) => setFormData({ ...formData, payment_terms: e.target.value })}
                    className={FLOAT_INPUT}
                    required
                  >
                    <option value="0">Immediate</option>
                    <option value="15">15 Days</option>
                    <option value="30">30 Days</option>
                    <option value="45">45 Days</option>
                    <option value="60">60 Days</option>
                    <option value="advance">Advance</option>
                    <option value="50-50">50% Adv & 50% on Delivery</option>
                  </select>
                </FloatingField>
              </SapRow>

              <SapRow>
                <FloatingField label="Customer" required span={4} filled={!!formData.customer_id}>
                  {isEditingPosted ? (
                    <input
                      type="text"
                      value={
                        customers.find((c) => c.id === formData.customer_id)?.company_name ||
                        editingInvoice?.customers?.company_name ||
                        'Customer'
                      }
                      className={
                        FLOAT_INPUT + ' bg-gray-100 text-gray-700 font-medium cursor-not-allowed'
                      }
                      readOnly
                      disabled
                    />
                  ) : (
                    <SearchableSelect
                      value={formData.customer_id}
                      onChange={(customerId) => {
                        setFormData({ ...formData, customer_id: customerId });
                        setSelectedChallanId('');
                        setPendingChallans([]);
                        setSelectedDCIds([]);
                        setSelectedSOId('');
                        setSoAutoLinked(false);
                        setCustomerSalesOrders([]);
                        setItems([
                          {
                            product_id: '',
                            batch_id: null,
                            quantity: 1,
                            unit_price: 0,
                            tax_rate: 11,
                            total: 0,
                          },
                        ]);
                        if (customerId) {
                          loadPendingDCOptions(customerId);
                          loadCustomerSalesOrders(customerId);
                        } else {
                          setPendingDCOptions([]);
                          setCustomerSalesOrders([]);
                        }
                      }}
                      options={customers.map((c) => ({ value: c.id, label: c.company_name }))}
                      placeholder="Select Customer"
                      className="text-sm"
                      required
                    />
                  )}
                </FloatingField>
                <FloatingField label="Delivery Challans" span={4} filled={selectedDCIds.length > 0}>
                  {isEditingPosted ? (
                    <input
                      type="text"
                      value={
                        editingInvoice?.delivery_challan_number ||
                        editingInvoice?.linked_challans?.map((c) => c.challan_number).join(', ') ||
                        'Linked Delivery Challans'
                      }
                      className={
                        FLOAT_INPUT + ' bg-gray-100 text-gray-700 font-medium cursor-not-allowed'
                      }
                      readOnly
                      disabled
                    />
                  ) : (
                    <DCMultiSelect
                      options={pendingDCOptions}
                      selectedDCIds={selectedDCIds}
                      onChange={(ids) => {
                        if (ids.length === 0) {
                          setSoAutoLinked(false);
                          setSelectedSOId('');
                        }
                        void handleDCMultiSelectChange(ids);
                      }}
                      placeholder="Select DCs"
                    />
                  )}
                </FloatingField>
                <FloatingField label="PO Number" span={4} filled={!!formData.po_number}>
                  <input
                    name="po_number"
                    aria-label="PO Number"
                    type="text"
                    value={formData.po_number}
                    onChange={(e) => setFormData({ ...formData, po_number: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="Customer PO Number"
                  />
                </FloatingField>
              </SapRow>

              {customerSalesOrders.length > 0 && !editingInvoice && (
                <div
                  className={`p-3 rounded-lg border-2 ${soAutoLinked ? 'bg-green-50 border-green-300' : 'bg-blue-50 border-blue-200'}`}
                >
                  <label
                    className={`block text-sm font-bold mb-2 ${soAutoLinked ? 'text-green-900' : 'text-blue-900'}`}
                  >
                    Link to Sales Order{' '}
                    {soAutoLinked ? '(auto-linked from DC)' : '(for advance payment tracking)'}
                  </label>
                  {soAutoLinked ? (
                    <div className="flex items-center justify-between">
                      <div>
                        {(() => {
                          const so = customerSalesOrders.find((s) => s.id === selectedSOId);
                          return so ? (
                            <div>
                              <p className="text-sm font-semibold text-green-800">{so.so_number}</p>
                              {so.items && so.items.length > 0 && (
                                <p className="text-xs text-green-700 mt-0.5">
                                  Products: {so.items.map((i) => i.product_name).join(', ')}
                                </p>
                              )}
                              {so.advance_payment_amount > 0 && (
                                <p className="text-xs text-green-700 mt-0.5">
                                  Advance: Rp {so.advance_payment_amount.toLocaleString('id-ID')}
                                </p>
                              )}
                            </div>
                          ) : null;
                        })()}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSOId('');
                          setSoAutoLinked(false);
                        }}
                        className="text-xs text-green-700 underline hover:text-green-900"
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                    <select
                      name="s_o_id"
                      aria-label="S O Id"
                      value={selectedSOId}
                      onChange={(e) => handleSalesOrderSelect(e.target.value)}
                      className="w-full px-3 py-2 text-sm border-2 border-blue-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white font-medium"
                    >
                      <option value="">
                        -- Select Sales Order (if this invoice is from an SO) --
                      </option>
                      {customerSalesOrders.map((so) => {
                        const productNames =
                          so.items && so.items.length > 0
                            ? so.items.map((i) => i.product_name).join(', ')
                            : `Rp ${so.total_amount.toLocaleString('id-ID')}`;
                        const advanceLabel =
                          so.advance_payment_amount > 0
                            ? ` | Advance: Rp ${so.advance_payment_amount.toLocaleString('id-ID')}`
                            : '';
                        return (
                          <option key={so.id} value={so.id}>
                            {so.so_number} — {productNames}
                            {advanceLabel}
                          </option>
                        );
                      })}
                    </select>
                  )}
                  {selectedSOId &&
                    !soAutoLinked &&
                    (() => {
                      const so = customerSalesOrders.find((s) => s.id === selectedSOId);
                      if (so && so.advance_payment_amount > 0) {
                        return (
                          <div className="mt-2 p-2 bg-green-100 border border-green-300 rounded">
                            <p className="text-sm font-bold text-green-800">
                              Advance Payment: Rp{' '}
                              {so.advance_payment_amount.toLocaleString('id-ID')} will be
                              automatically applied to this invoice
                            </p>
                            <p className="text-xs text-green-700 mt-1">
                              The invoice payment status will be updated automatically after saving.
                            </p>
                          </div>
                        );
                      }
                      if (selectedSOId) {
                        return (
                          <p className="text-xs text-blue-600 mt-2">
                            This SO has no advance payment recorded.
                          </p>
                        );
                      }
                      return null;
                    })()}
                  {customerSalesOrders.some((so) => so.advance_payment_amount > 0) &&
                    !selectedSOId &&
                    !soAutoLinked && (
                      <div className="mt-2 p-2 bg-amber-50 border border-amber-300 rounded">
                        <p className="text-xs font-medium text-amber-800">
                          This customer has Sales Orders with advance payments. Select the correct
                          SO above to apply advance payment to this invoice.
                        </p>
                      </div>
                    )}
                </div>
              )}

              <SapRow>
                <FloatingField label="Notes" span={6} filled={!!formData.notes}>
                  <input
                    name="notes"
                    aria-label="Notes"
                    type="text"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="Additional notes"
                  />
                </FloatingField>
                <FloatingField label="Discount (Rp)" span={6} filled={!!formData.discount}>
                  <MoneyInput
                    value={formData.discount}
                    onChange={(amount) => setFormData({ ...formData, discount: amount })}
                    className={FLOAT_INPUT}
                    min="0"
                    placeholder="0"
                  />
                </FloatingField>
              </SapRow>
            </div>

            <div className="border-t pt-3">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-gray-900">
                  Line Items{' '}
                  {isEditingPosted && (
                    <span className="text-[11px] font-normal text-amber-700">
                      (Quantities & Unit Prices editable by Accounts/Admin — Stock & GL auto-synced)
                    </span>
                  )}
                </h4>
                {!isEditingPosted && (
                  <button
                    type="button"
                    onClick={addManualItem}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                  >
                    + Add Manual Item
                  </button>
                )}
              </div>

              <div className="space-y-1.5">
                {items.map((item, index) => {
                  const availableBatches = batches.filter((b) => b.product_id === item.product_id);
                  const costPerUnit = getBatchCostPerUnit(item.batch_id);
                  const margin = calculateMargin(item.unit_price, costPerUnit);
                  const suggestedPrice = getSuggestedPrice(item.batch_id);

                  const isFromDC = !!item.delivery_challan_item_id;

                  return (
                    <div
                      key={index}
                      className="p-2 bg-gray-50 rounded space-y-1 border-l-2"
                      style={{ borderLeftColor: isFromDC ? '#3b82f6' : '#10b981' }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          {isFromDC ? (
                            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 rounded">
                              From DC: {item.dc_number}
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-700 rounded">
                              Manual Item
                            </span>
                          )}
                          {isFromDC && item.max_quantity && (
                            <span className="text-[10px] text-gray-500">
                              Max: {item.max_quantity} units
                            </span>
                          )}
                        </div>
                        {!isFromDC && !isEditingPosted && items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeItem(index)}
                            className="text-red-600 hover:text-red-700"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      <div className="overflow-x-auto">
                        <div className="grid grid-cols-12 gap-2 items-end min-w-[700px]">
                          <div className="col-span-3">
                            <label className="block text-xs text-gray-600 mb-1">Product *</label>
                            <select
                              name="product"
                              aria-label="Product"
                              value={item.product_id}
                              onChange={(e) =>
                                updateItemTotal(index, {
                                  ...item,
                                  product_id: e.target.value,
                                  batch_id: null,
                                })
                              }
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              disabled={isFromDC || isEditingPosted}
                              required
                            >
                              <option value="">Select Product</option>
                              {products.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.product_name}
                                </option>
                              ))}
                            </select>
                            <div className="mt-0.5 truncate text-[10px] text-gray-500">
                              Make:{' '}
                              {getLineItemMakeName(item) || 'Not recorded'}
                            </div>
                          </div>

                          <div className="col-span-2">
                            <label className="block text-xs text-gray-600 mb-1">Batch</label>
                            <select
                              name="batch"
                              aria-label="Batch"
                              value={item.batch_id || ''}
                              onChange={(e) => {
                                const batchId = e.target.value || null;
                                const suggested = getSuggestedPrice(batchId);
                                const foundBatch = batches.find((b) => b.id === batchId);
                                const batchSources = Array.isArray(foundBatch?.product_sources)
                                  ? foundBatch.product_sources[0]
                                  : foundBatch?.product_sources;
                                const resolvedMakeName = batchSources?.supplier_name || null;
                                updateItemTotal(index, {
                                  ...item,
                                  batch_id: batchId,
                                  unit_price: suggested,
                                  make_id: foundBatch?.make_id || null,
                                  make_name: resolvedMakeName,
                                });
                              }}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              disabled={
                                !item.product_id ||
                                selectedChallanId !== '' ||
                                isFromDC ||
                                isEditingPosted
                              }
                            >
                              <option value="">Select Batch</option>
                              {/* Show only batches with stock > 0 for manual selection */}
                              {availableBatches
                                .filter((b) => b.current_stock > 0)
                                .map((b) => (
                                  <option key={b.id} value={b.id}>
                                    {b.batch_number} ({b.current_stock} stock)
                                  </option>
                                ))}
                              {/* Show selected batch even if stock is 0 (from delivery challan) */}
                              {item.batch_id &&
                                availableBatches.find(
                                  (b) => b.id === item.batch_id && b.current_stock === 0
                                ) && (
                                  <option key={item.batch_id} value={item.batch_id}>
                                    {
                                      availableBatches.find((b) => b.id === item.batch_id)
                                        ?.batch_number
                                    }{' '}
                                    (from challan)
                                  </option>
                                )}
                            </select>
                          </div>

                          <div className="col-span-2">
                            <label className="block text-xs text-gray-600 mb-1">Quantity *</label>
                            <input
                              name="quantity"
                              aria-label="Quantity"
                              type="number"
                              value={item.quantity === 0 ? '' : item.quantity}
                              onChange={(e) =>
                                updateItemTotal(index, {
                                  ...item,
                                  quantity: e.target.value === '' ? 1 : Number(e.target.value),
                                })
                              }
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              required
                              min="0.001"
                              step="0.001"
                              placeholder="0.25"
                              disabled={isEditingPosted && !isFinancialEditor}
                            />
                          </div>

                          <div className="col-span-2">
                            <label className="block text-xs text-gray-600 mb-1">Unit Price *</label>
                            <MoneyInput
                              value={item.unit_price}
                              onChange={(amount) =>
                                updateItemTotal(index, { ...item, unit_price: amount })
                              }
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              required
                              min="0"
                              placeholder="0"
                              disabled={isEditingPosted && !isFinancialEditor}
                            />
                          </div>

                          <div className="col-span-1">
                            <label className="block text-xs text-gray-600 mb-1">Tax %</label>
                            <input
                              name="tax"
                              aria-label="Tax %"
                              type="number"
                              value={item.tax_rate === 0 ? '' : item.tax_rate}
                              onChange={(e) =>
                                updateItemTotal(index, {
                                  ...item,
                                  tax_rate: e.target.value === '' ? 0 : Number(e.target.value),
                                })
                              }
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              min="0"
                              placeholder="11"
                              disabled={isEditingPosted && !isFinancialEditor}
                            />
                          </div>

                          <div className="col-span-2 flex items-end gap-2">
                            <div className="flex-1">
                              <label className="block text-xs text-gray-600 mb-1">Total</label>
                              <input
                                name="total"
                                aria-label="Total"
                                type="text"
                                value={(item.total || 0).toFixed(2)}
                                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded bg-gray-100"
                                disabled
                              />
                            </div>
                            {items.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeItem(index)}
                                className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                                title="Remove Item"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {item.batch_id && costPerUnit > 0 && (
                        <div className="flex items-center gap-2 text-[10px] px-2 py-1 bg-white rounded border border-gray-200">
                          <div className="flex items-center gap-1">
                            <span className="text-gray-600">Cost/Unit:</span>
                            <span className="font-semibold text-gray-900">
                              Rp{' '}
                              {costPerUnit.toLocaleString('id-ID', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          <div className="h-3 w-px bg-gray-300" />
                          <div className="flex items-center gap-1">
                            <span className="text-gray-600">Suggested Price (25%):</span>
                            <span className="font-semibold text-blue-600">
                              Rp{' '}
                              {suggestedPrice.toLocaleString('id-ID', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          <div className="h-3 w-px bg-gray-300" />
                          <div className="flex items-center gap-1">
                            <span className="text-gray-600">
                              Margin <span className="text-xs italic">(Provisional)</span>:
                            </span>
                            <span
                              className={`font-semibold ${
                                margin >= 20
                                  ? 'text-green-600'
                                  : margin >= 10
                                    ? 'text-yellow-600'
                                    : 'text-red-600'
                              }`}
                            >
                              {margin.toFixed(1)}%
                            </span>
                          </div>
                          <div className="h-3 w-px bg-gray-300" />
                          <div className="flex items-center gap-1">
                            <span className="text-gray-600">
                              Profit/Unit <span className="text-xs italic">(Provisional)</span>:
                            </span>
                            <span
                              className={`font-semibold ${
                                item.unit_price > costPerUnit ? 'text-green-600' : 'text-red-600'
                              }`}
                            >
                              Rp{' '}
                              {(item.unit_price - costPerUnit).toLocaleString('id-ID', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-2 p-2 bg-blue-50 rounded">
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span>Subtotal:</span>
                    <span className="font-medium">
                      Rp{' '}
                      {calculateTotals().subtotal.toLocaleString('id-ID', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Tax:</span>
                    <span className="font-medium">
                      Rp{' '}
                      {calculateTotals().taxAmount.toLocaleString('id-ID', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Discount:</span>
                    <span className="font-medium">
                      -Rp{' '}
                      {formData.discount.toLocaleString('id-ID', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Bea Meterai:</span>
                    <MoneyInput
                      min="0"
                      value={formData.stamp_duty_amount}
                      onChange={(amount) =>
                        setFormData((prev) => ({ ...prev, stamp_duty_amount: amount }))
                      }
                      placeholder="0"
                      className="w-28 text-right px-1.5 py-0.5 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex justify-between text-sm font-bold border-t pt-1">
                    <span>Total:</span>
                    <span className="text-blue-600">
                      Rp{' '}
                      {calculateTotals().total.toLocaleString('id-ID', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  resetForm();
                }}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition"
              >
                {editingInvoice ? 'Update Invoice' : 'Create Invoice'}
              </button>
            </div>
          </form>
        </Modal>

        {linkedSOPreview && (
          <ProformaInvoiceView
            salesOrder={linkedSOPreview}
            items={linkedSOPreview.sales_order_items || []}
            onClose={() => setLinkedSOPreview(null)}
            companyProfile={(linkedSOPreview as any).company_snapshot ?? undefined}
          />
        )}

        {selectedFlyChallan && (
          <DeliveryChallanView
            challan={selectedFlyChallan}
            items={selectedFlyChallanItems}
            onClose={() => {
              setSelectedFlyChallan(null);
              setSelectedFlyChallanItems([]);
            }}
            companyProfile={(selectedFlyChallan as any).company_snapshot ?? undefined}
          />
        )}

        {viewModalOpen && selectedInvoice && (
          <InvoiceView
            invoice={selectedInvoice as any}
            items={invoiceItems as any}
            onClose={() => {
              setViewModalOpen(false);
              setSelectedInvoice(null);
              setInvoiceItems([]);
            }}
            companyProfile={(selectedInvoice as any).company_snapshot ?? undefined}
          />
        )}
      </div>
    </Layout>
  );
}
