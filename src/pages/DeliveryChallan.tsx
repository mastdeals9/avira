import { useEffect, useRef, useState, useMemo } from 'react';
import { Layout } from '../components/Layout';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { DeliveryChallanView } from '../components/DeliveryChallanView';
import { InvoiceView } from '../components/InvoiceView';
import { ProformaInvoiceView } from '../components/ProformaInvoiceView';
import { SearchableSelect } from '../components/SearchableSelect';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useFinance } from '../contexts/FinanceContext';
import { supabase } from '../lib/supabase';
import { Plus, Trash2, Eye, Pencil as Edit, FileText, CheckCircle, XCircle, Lock, RotateCcw, AlertTriangle, ExternalLink } from 'lucide-react';
import { showToast } from '../components/ToastNotification';
import { showConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/dateFormat';
import { fetchLinkedDocumentsBundle, LinkedDocRef } from '../utils/linkedDocuments';
import { LinkedDocsCell } from '../components/LinkedDocsCell';
import { loadInvoiceDisplayItems } from '../utils/invoiceItemDisplay';
import { formatUnit } from '../utils/unitDisplay';
import { formatPackTypeForDisplay } from '../utils/deliveryPackaging';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../components/finance/FloatingField';
import { SapRow } from '../components/finance/SapLayout';
import { useErpSyncListener, emitErpSync } from '../utils/erpSyncBus';

function normalizeNestedRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

interface DeliveryChallan {
  id: string;
  challan_number: string;
  customer_id: string;
  challan_date: string;
  delivery_address: string;
  vehicle_number: string | null;
  driver_name: string | null;
  notes: string | null;
  approval_status: 'pending_approval' | 'approved' | 'rejected' | 'cancelled';
  status?: string;
  sales_order_id?: string | null;
  invoicing_status?: 'not_invoiced' | 'partially_invoiced' | 'fully_invoiced';
  total_items?: number;
  invoiced_items?: number;
  /** Quantity still available to invoice, supplied by dc_invoicing_summary. */
  total_remaining_quantity?: number | null;
  linked_invoices?: string[];
  product_names?: string;
  sales_orders?: {
    so_number: string;
    so_date?: string;
  } | null;
  customers?: {
    company_name: string;
    address: string;
    city: string;
    phone: string;
    pbf_license: string;
  };
}

interface ChallanItem {
  id?: string;
  sales_order_item_id?: string | null;
  product_id: string;
  batch_id: string;
  quantity: number;
  pack_size: number | null;
  pack_type: string | null;
  number_of_packs: number | null;
  products?: {
    id?: string;
    product_name: string;
    product_code?: string;
    unit: string;
    per_pack_weight?: number | null;
    pack_type?: string | null;
    packaging_type?: string | null;
  } | null;
  batches?: {
    id?: string;
    batch_number: string;
    expiry_date: string | null;
    current_stock: number;
    packaging_details: string | null;
    per_pack_weight?: number | null;
    pack_type?: string | null;
    make_id?: string | null;
    product_sources?: { supplier_name: string | null; grade: string | null } | null;
    products?: {
      id?: string;
      product_name: string;
      product_code?: string;
      unit: string;
      per_pack_weight?: number | null;
      pack_type?: string | null;
      packaging_type?: string | null;
    } | null;
  };
}

interface Customer {
  id: string;
  company_name: string;
  address: string;
  city: string;
}

interface Product {
  id: string;
  product_name: string;
  product_code: string;
  unit: string;
  per_pack_weight?: number | null;
  pack_type?: string | null;
  packaging_type?: string | null;
}

interface SalesOrderItemSource {
  id: string;
  product_id: string;
  make_id: string | null;
  quantity: number;
  delivered_quantity: number;
  unit_price: number;
  products?: { product_name: string; unit: string } | null;
}

interface Batch {
  id: string;
  batch_number: string;
  product_id: string;
  current_stock: number;
  reserved_stock: number;
  expiry_date: string | null;
  packaging_details: string | null;
  per_pack_weight?: number | null;
  pack_type?: string | null;
  import_date: string | null;
  make_id: string | null;
  product_sources?: { supplier_name: string | null; grade: string | null } | null;
}

const isExpired = (expiryDate: string | null): boolean => {
  if (!expiryDate) return false;
  return new Date(expiryDate) < new Date();
};

export function DeliveryChallan() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const { navigationData, clearNavigationData, setCurrentPage, setNavigationData } = useNavigation();
  const { dateRange } = useFinance();
  const [challans, setChallans] = useState<DeliveryChallan[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedChallan, setSelectedChallan] = useState<DeliveryChallan | null>(null);
  const [challanItems, setChallanItems] = useState<ChallanItem[]>([]);
  const [editingChallan, setEditingChallan] = useState<DeliveryChallan | null>(null);
  const [originalItems, setOriginalItems] = useState<ChallanItem[]>([]);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [challanToReject, setChallanToReject] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    challan_number: '',
    customer_id: '',
    sales_order_id: '',
    challan_date: new Date().toISOString().split('T')[0],
    delivery_address: '',
    vehicle_number: '',
    driver_name: '',
    notes: '',
  });

  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const approvalOperationIdsRef = useRef<Record<string, string>>({});
  const [soReservations, setSoReservations] = useState<Map<string, number>>(new Map());
  const [soReservationLoadState, setSoReservationLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [linkedInvoicePreview, setLinkedInvoicePreview] = useState<any | null>(null);
  const [linkedInvoiceItems, setLinkedInvoiceItems] = useState<any[]>([]);
  const [linkedSOPreview, setLinkedSOPreview] = useState<any | null>(null);
  const [salesOrderItemSources, setSalesOrderItemSources] = useState<SalesOrderItemSource[]>([]);
  const [items, setItems] = useState<ChallanItem[]>([{
    product_id: '',
    batch_id: '',
    quantity: 0,
    pack_size: null,
    pack_type: null,
    number_of_packs: null,
  }]);

  useEffect(() => {
    loadChallans();
    loadCustomers();
    loadProducts();
    loadBatches();
  }, [dateRange.startDate, dateRange.endDate]);

  useErpSyncListener(
    ['delivery_challans', 'sales_orders', 'inventory'],
    () => {
      loadChallans();
    }
  );

  const loadSalesOrders = async (customerId?: string) => {
    try {
      let query = supabase
        .from('sales_orders')
        .select(`
          id,
          so_number,
          customer_id,
          status,
          customers(company_name),
          sales_order_items(products(product_name))
        `)
        .in('status', ['approved', 'stock_reserved', 'shortage', 'pending_delivery', 'partially_delivered'])
        .eq('is_archived', false)
        .order('so_date', { ascending: false });

      if (customerId) {
        query = query.eq('customer_id', customerId);
      }

      const { data, error } = await query;

      if (error) throw error;
      setSalesOrders(data || []);
    } catch (error) {
      console.error('Error loading sales orders:', error);
    }
  };

  const loadChallans = async () => {
    try {
      const { data, error } = await supabase
        .from('delivery_challans')
        .select('*, customers(company_name, address, city, phone, pbf_license), sales_orders(so_number, so_date)')
        .gte('challan_date', dateRange.startDate)
        .lte('challan_date', dateRange.endDate)
        .order('challan_date', { ascending: false });

      if (error) throw error;

      const { data: invoicingData, error: invError } = await supabase
        .from('dc_invoicing_summary')
        .select('*');

      if (invError) {
        console.error('Error loading invoicing status:', invError);
      }

      const invStatusMap = new Map();
      (invoicingData || []).forEach((inv: any) => {
        invStatusMap.set(inv.challan_id, {
          status: inv.dc_status,
          total_items: inv.total_items,
          not_invoiced_items: inv.not_invoiced_items,
          partially_invoiced_items: inv.partially_invoiced_items,
          fully_invoiced_items: inv.fully_invoiced_items,
          total_remaining_quantity: inv.total_remaining_quantity,
          linked_invoices: inv.linked_invoices || inv.linked_invoice_numbers || []
        });
      });

      const challansWithStatus = (data || []).map(challan => {
        const invStatus = invStatusMap.get(challan.id);
        return {
          ...challan,
          invoicing_status: invStatus?.status || 'not_invoiced',
          total_items: invStatus?.total_items || 0,
          invoiced_items: (invStatus?.fully_invoiced_items || 0) + (invStatus?.partially_invoiced_items || 0),
          total_remaining_quantity: invStatus?.total_remaining_quantity ?? null,
          linked_invoices: invStatus?.linked_invoices || []
        };
      });


      const bundle = await fetchLinkedDocumentsBundle();
      const enrichedBase = challansWithStatus.map((c: any) => {
        const l = bundle.dcMap.get(c.id);
        const invs = l?.invs || [];
        const allInvoicesCancelled = invs.length > 0 && invs.every((i: any) => i.isCancelled);

        // If all linked invoices are cancelled, the DC is unbilled and available for re-invoicing
        const resolvedInvoicingStatus = allInvoicesCancelled
          ? 'not_invoiced'
          : c.invoicing_status;

        return {
          ...c,
          invoicing_status: resolvedInvoicingStatus,
          linked_so_number: l?.sos?.[0]?.number || c.sales_orders?.so_number || null,
          linked_invoices: invs.map((i) => i.number)
        };
      });

      // Fetch product names for all challans so search by product name works
      const challanIds = enrichedBase.map((c: any) => c.id);
      const productNamesMap = new Map<string, string>();
      if (challanIds.length > 0) {
        const { data: itemsData } = await supabase
          .from('delivery_challan_items')
          .select('challan_id, products(product_name)')
          .in('challan_id', challanIds);
        (itemsData || []).forEach((item: any) => {
          const existing = productNamesMap.get(item.challan_id) || '';
          const name = item.products?.product_name || '';
          if (name && !existing.includes(name)) {
            productNamesMap.set(item.challan_id, existing ? `${existing}, ${name}` : name);
          }
        });
      }

      const enriched = enrichedBase.map((c: any) => ({
        ...c,
        product_names: productNamesMap.get(c.id) || ''
      }));

      setChallans(enriched);

    } catch (error) {
      console.error('Error loading challans:', error);
    } finally {
      setLoading(false);
    }
  };

  const openChallanPreview = async (challan: DeliveryChallan) => {
    const items = await loadChallanItems(challan.id);
    setSelectedChallan(challan);
    setChallanItems(items);
    setViewModalOpen(true);
  };

  useEffect(() => {
    const requestedId = navigationData?.challanId;
    if (typeof requestedId !== 'string') return;
    const openRequested = async () => {
      const inList = challans.find(challan => challan.id === requestedId);
      if (inList) {
        await openChallanPreview(inList);
      } else {
        const { data } = await supabase
          .from('delivery_challans')
          .select('*, customers(company_name, address, city, phone, pbf_license), sales_orders(so_number, so_date)')
          .eq('id', requestedId)
          .maybeSingle();
        if (data) await openChallanPreview(data as DeliveryChallan);
      }
      clearNavigationData();
    };
    void openRequested();
  }, [navigationData, challans, clearNavigationData]);

  const openSalesOrderPreview = async (soId: string) => {
    if (!soId) return;
    const { data } = await supabase
      .from('sales_orders')
      .select(`
        *,
        customers(*),
        sales_order_items(
          *,
          products(id, product_name, product_code, unit),
          product_sources!sales_order_items_make_id_fkey(supplier_name, grade)
        )
      `)
      .eq('id', soId)
      .maybeSingle();
    if (data) setLinkedSOPreview(data);
  };

  const openInvoicePreview = async (invoiceNumber: string) => {
    const { data: invoice } = await supabase
      .from('sales_invoices')
      .select('*, customers(company_name, address, city, phone, npwp, pharmacy_license, gst_vat_type)')
      .eq('invoice_number', invoiceNumber)
      .maybeSingle();
    if (!invoice) return;
    const items = await loadInvoiceDisplayItems(supabase, invoice.id);
    setLinkedInvoicePreview(invoice);
    setLinkedInvoiceItems(items || []);
  };

  const generateNextChallanNumber = async () => {
    try {
      // Get current financial year automatically
      const { data: yearCode, error: fyError } = await supabase
        .rpc('get_current_financial_year');

      if (fyError) {
        console.error('Error getting financial year:', fyError);
        const fallbackYear = new Date().getFullYear().toString().slice(-2);
        return `DO-${fallbackYear}-0001`;
      }

      const prefix = 'DO';

      // Get all challan numbers with this prefix and year to find the highest number
      const { data: allChallans } = await supabase
        .from('delivery_challans')
        .select('challan_number')
        .or(`challan_number.like.DO-${yearCode}%,challan_number.like.DC-${yearCode}%`);

      let nextNumber = 1;

      if (allChallans && allChallans.length > 0) {
        // Extract all numbers and find the maximum
        const numbers = allChallans
          .map(challan => {
            const match = challan.challan_number.match(/(\d+)$/);
            return match ? parseInt(match[1], 10) : 0;
          })
          .filter(num => !isNaN(num));

        if (numbers.length > 0) {
          const maxNumber = Math.max(...numbers);
          nextNumber = maxNumber + 1;
        }
      }

      const paddedNumber = String(nextNumber).padStart(4, '0');
      return `${prefix}-${yearCode}-${paddedNumber}`;
    } catch (error) {
      console.error('Error generating challan number:', error);
      const fallbackYear = new Date().getFullYear().toString().slice(-2);
      return `DO-${fallbackYear}-0001`;
    }
  };

  const loadCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('id, company_name, address, city')
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
        .select('id, product_name, product_code, unit, per_pack_weight, pack_type, packaging_type')
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
      const { data, error } = await supabase
        .from('batches')
        .select('id, batch_number, product_id, make_id, current_stock, reserved_stock, expiry_date, packaging_details, per_pack_weight, pack_type, import_date, product_sources!batches_make_id_fkey(supplier_name, grade)')
        .eq('is_active', true)
        .gt('current_stock', 0)
        .order('import_date', { ascending: true });

      if (error) throw error;
      setBatches((data || []).map(batch => ({
        ...batch,
        product_sources: normalizeNestedRelation(batch.product_sources),
      })));
    } catch (error) {
      console.error('Error loading batches:', error);
    }
  };

  const loadChallanItems = async (challanId: string) => {
    try {
      const { data, error } = await supabase
        .from('delivery_challan_items')
        .select(`
          *,
          products(id, product_name, product_code, unit, per_pack_weight, pack_type, packaging_type),
          batches(
            id, batch_number, expiry_date, packaging_details, per_pack_weight, pack_type, current_stock, make_id,
            products(id, product_name, product_code, unit, per_pack_weight, pack_type, packaging_type),
            product_sources!batches_make_id_fkey(supplier_name, grade)
          )
        `)
        .eq('challan_id', challanId);

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error loading challan items:', error);
      return [];
    }
  };

  const getFIFOBatch = (productId: string, makeId?: string | null) => {
    const productBatches = batches
      .filter(b => b.product_id === productId && (!makeId || b.make_id === makeId) && !isExpired(b.expiry_date) && getAvailableStock(b) > 0)
      .sort((a, b) => {
        const ea = a.expiry_date ? new Date(a.expiry_date).getTime() : Number.MAX_SAFE_INTEGER;
        const eb = b.expiry_date ? new Date(b.expiry_date).getTime() : Number.MAX_SAFE_INTEGER;
        return ea - eb || (a.import_date ? new Date(a.import_date).getTime() : 0) - (b.import_date ? new Date(b.import_date).getTime() : 0);
      });
    return productBatches[0] || null;
  };

  const handleCustomerChange = (customerId: string) => {
    const customer = customers.find(c => c.id === customerId);
    if (customer) {
      setFormData({
        ...formData,
        customer_id: customerId,
        sales_order_id: '',
        delivery_address: `${customer.address}, ${customer.city}`,
      });
      loadSalesOrders(customerId);
    }
  };

  const getAvailableStock = (batch: Batch) => {
    return batch.current_stock;
  };

  const handleSalesOrderChange = async (soId: string, sourceOrder?: { id: string; customer_id: string }) => {
    setFormData(prev => ({ ...prev, sales_order_id: soId, customer_id: sourceOrder?.customer_id || prev.customer_id }));

    if (soId) {
      setSoReservations(new Map());
      setSoReservationLoadState('loading');
      const so = sourceOrder || salesOrders.find(s => s.id === soId);
      if (so) {
        setFormData(prev => ({ ...prev, customer_id: so.customer_id }));

        try {
          const [soItemsResult, reservationsResult] = await Promise.all([
            supabase
              .from('sales_order_items')
              .select(`id, product_id, make_id, quantity, delivered_quantity, unit_price, products(product_name, unit)`)
              .eq('sales_order_id', soId),
            supabase
              .from('so_product_reservation_status')
              .select('sales_order_item_id, reserved_quantity')
              .eq('sales_order_id', soId)
          ]);

          if (soItemsResult.error) throw soItemsResult.error;
          if (reservationsResult.error) throw reservationsResult.error;

          const resMap = new Map<string, number>();
          (reservationsResult.data || []).forEach((r: any) => {
            resMap.set(r.sales_order_item_id, parseFloat(r.reserved_quantity));
          });
          setSoReservations(resMap);
          setSoReservationLoadState('ready');

          const soItems = soItemsResult.data;
          const normalizedSoItems = (soItems || []).map((item: any) => ({
            ...item,
            products: Array.isArray(item.products) ? (item.products[0] || null) : item.products,
          })) as SalesOrderItemSource[];
          setSalesOrderItemSources(normalizedSoItems);
          if (normalizedSoItems && normalizedSoItems.length > 0) {
            const newItems: ChallanItem[] = [];
            const allocatedBatchUsage = new Map<string, number>();

            for (const item of normalizedSoItems) {
              const remainingNeeded = Math.max(0, Number(item.quantity) - Number(item.delivered_quantity || 0));
              let neededQty = remainingNeeded > 0 ? remainingNeeded : (parseFloat(String(item.quantity)) || 0);

              const productBatches = batches
                .filter(b => {
                  return b.product_id === item.product_id && (!item.make_id || b.make_id === item.make_id) && !isExpired(b.expiry_date);
                })
                .sort((a, b) => {
                  const ea = a.expiry_date ? new Date(a.expiry_date).getTime() : Number.MAX_SAFE_INTEGER;
                  const eb = b.expiry_date ? new Date(b.expiry_date).getTime() : Number.MAX_SAFE_INTEGER;
                  return ea - eb || (a.import_date ? new Date(a.import_date).getTime() : 0) - (b.import_date ? new Date(b.import_date).getTime() : 0);
                });

              let hasAllocated = false;
              for (const batch of productBatches) {
                if (neededQty <= 0) break;
                const baseStock = getAvailableStock(batch);
                const used = allocatedBatchUsage.get(batch.id) || 0;
                const available = baseStock - used;
                if (available <= 0) continue;

                let packSize: number | null = null;
                let packType: string | null = null;
                let numberOfPacks: number | null = null;
                let lineQty = 0;

                if (batch.per_pack_weight && Number(batch.per_pack_weight) > 0 && batch.pack_type) {
                  packSize = Number(batch.per_pack_weight);
                  packType = formatPackTypeForDisplay(batch.pack_type);
                } else if (batch.packaging_details) {
                  const match = batch.packaging_details.match(/(\d+)\s+(\w+)s?\s+x\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/i);
                  if (match) {
                    packType = formatPackTypeForDisplay(match[2]);
                    packSize = parseFloat(match[3]);
                  }
                }

                if (!packSize || !packType) {
                  const prod = products.find(p => p.id === item.product_id) || (item.products as any);
                  const pWeight = Number(prod?.per_pack_weight);
                  const pType = prod?.pack_type || prod?.packaging_type;
                  if (pWeight > 0 && pType) {
                    packSize = packSize || pWeight;
                    packType = packType || formatPackTypeForDisplay(pType);
                  }
                }

                if (packSize && packSize > 0) {
                  const maxPacksInBatch = Math.floor(available / packSize);
                  if (maxPacksInBatch <= 0) continue;
                  const packsNeeded = Math.ceil(neededQty / packSize);
                  numberOfPacks = Math.min(maxPacksInBatch, packsNeeded);
                  lineQty = numberOfPacks * packSize;
                } else {
                  lineQty = Math.min(available, neededQty);
                }

                if (lineQty <= 0) continue;

                allocatedBatchUsage.set(batch.id, used + lineQty);
                neededQty = Math.max(0, neededQty - lineQty);
                hasAllocated = true;

                const matchingOrig = originalItems.find(oi => oi.product_id === item.product_id && oi.batch_id === batch.id)
                  || originalItems.find(oi => oi.product_id === item.product_id);
                newItems.push({
                  id: matchingOrig?.id,
                  sales_order_item_id: item.id,
                  product_id: item.product_id,
                  batch_id: batch.id,
                  quantity: lineQty,
                  pack_size: packSize,
                  pack_type: packType,
                  number_of_packs: numberOfPacks || 1,
                  products: item.products,
                  batches: batch,
                });
              }

              // If no stock was allocated for this SO item, add a placeholder row so user can see it
              if (!hasAllocated) {
                const prod = products.find(p => p.id === item.product_id) || (item.products as any);
                const pWeight = Number(prod?.per_pack_weight);
                const pType = prod?.pack_type || prod?.packaging_type;
                const phPackSize = pWeight > 0 ? pWeight : null;
                const phPackType = (pWeight > 0 && pType) ? formatPackTypeForDisplay(pType) : null;
                const phPacks = (phPackSize && neededQty > 0) ? Math.ceil(neededQty / phPackSize) : null;
                const matchingOrig = originalItems.find(oi => oi.product_id === item.product_id);
                newItems.push({
                  id: matchingOrig?.id,
                  sales_order_item_id: item.id,
                  product_id: item.product_id,
                  batch_id: matchingOrig?.batch_id || '',
                  quantity: neededQty,
                  pack_size: phPackSize,
                  pack_type: phPackType,
                  number_of_packs: phPacks,
                  products: item.products,
                });
              }
            }

            setItems(newItems.length > 0 ? newItems : [{
              product_id: '',
              batch_id: '',
              quantity: 0,
              pack_size: null,
              pack_type: null,
              number_of_packs: null,
            }]);
          }
        } catch (error) {
          console.error('Error loading SO items:', error);
          setSoReservations(new Map());
          setSoReservationLoadState('error');
          showToast({ type: 'error', title: 'Error', message: 'Failed to load Sales Order reservation data. Delivery Challan quantities cannot be validated; please try again.' });
        }
      } else {
        setSoReservationLoadState('error');
      }
    } else {
      setSoReservations(new Map());
      setSoReservationLoadState('idle');
      setSalesOrderItemSources([]);
      setItems([{
        product_id: '',
        batch_id: '',
        quantity: 0,
        pack_size: null,
        pack_type: null,
        number_of_packs: null,
      }]);
    }
  };

  useEffect(() => {
    const requestedSoId = navigationData?.createDeliveryChallanFromSO;
    if (typeof requestedSoId !== 'string' || !batches.length || !customers.length) return;
    let cancelled = false;
    const openPrefilledChallan = async () => {
      const { data: so, error } = await supabase
        .from('sales_orders')
        .select('id,customer_id')
        .eq('id', requestedSoId)
        .maybeSingle();
      if (cancelled) return;
      if (error || !so) {
        console.error('Unable to load Sales Order for Delivery Challan:', error);
        showToast({ type: 'error', title: 'Delivery Challan', message: 'The Sales Order could not be loaded.' });
        clearNavigationData();
        return;
      }
      resetForm();
      setModalOpen(true);
      // Load the customer-scoped choices for the form, then hydrate the SO
      // lines/reservations directly by ID. This avoids falling back to the DC
      // list when the SO is outside the currently loaded list.
      void loadSalesOrders(so.customer_id);
      await handleSalesOrderChange(requestedSoId, so);
      if (!cancelled) clearNavigationData();
    };
    void openPrefilledChallan();
    return () => { cancelled = true; };
  }, [navigationData, batches, customers, clearNavigationData]);

  const handleBatchChange = (index: number, batchId: string) => {
    const batch = batches.find(b => b.id === batchId);
    if (batch) {
      const newItems = [...items];
      const currentItem = newItems[index];

      // Auto-assign sales_order_item_id if missing but SO items are loaded
      let soItemId = currentItem.sales_order_item_id;
      if (!soItemId && formData.sales_order_id && salesOrderItemSources.length > 0) {
        const matchingSource = salesOrderItemSources.find(s => s.product_id === batch.product_id && (!s.make_id || s.make_id === batch.make_id))
          || salesOrderItemSources.find(s => s.product_id === batch.product_id);
        if (matchingSource) {
          soItemId = matchingSource.id;
        }
      }

      let packSize: number | null = null;
      let packType: string | null = null;
      let numberOfPacks: number | null = null;

      // Extract packaging details: Batch structured -> Batch regex -> Product Master
      if (batch.per_pack_weight && Number(batch.per_pack_weight) > 0 && batch.pack_type) {
        packSize = Number(batch.per_pack_weight);
        packType = formatPackTypeForDisplay(batch.pack_type);
      } else if (batch.packaging_details) {
        const match = batch.packaging_details.match(/(\d+)\s+(\w+)s?\s+x\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/i);
        if (match) {
          packType = formatPackTypeForDisplay(match[2]);
          packSize = parseFloat(match[3]);
        }
      }

      if (!packSize || !packType) {
        const prod = products.find(p => p.id === batch.product_id);
        const pWeight = Number(prod?.per_pack_weight);
        const pType = prod?.pack_type || prod?.packaging_type;
        if (pWeight > 0 && pType) {
          packSize = packSize || pWeight;
          packType = packType || formatPackTypeForDisplay(pType);
        }
      }

      // Calculate available stock minus usage in other rows of this form
      let usedInOtherRows = 0;
      items.forEach((it, i) => {
        if (i !== index && it.batch_id === batchId) {
          usedInOtherRows += it.quantity || 0;
        }
      });
      const availableStock = Math.max(0, getAvailableStock(batch) - usedInOtherRows);

      // Determine needed quantity for this SO item
      let neededQty = 0;
      if (soItemId) {
        const sourceItem = salesOrderItemSources.find(s => s.id === soItemId);
        if (sourceItem) {
          const totalTarget = Math.max(0, Number(sourceItem.quantity) - Number(sourceItem.delivered_quantity || 0));
          let otherRowsQty = 0;
          items.forEach((it, i) => {
            if (i !== index && it.sales_order_item_id === soItemId) {
              otherRowsQty += it.quantity || 0;
            }
          });
          neededQty = Math.max(0, totalTarget - otherRowsQty);
        }
      }

      if (packSize && packSize > 0) {
        const maxPacks = Math.floor(availableStock / packSize);
        if (neededQty > 0) {
          const neededPacks = Math.ceil(neededQty / packSize);
          numberOfPacks = Math.min(maxPacks, neededPacks);
        } else {
          numberOfPacks = maxPacks >= 1 ? 1 : 0;
        }
      } else {
        numberOfPacks = currentItem.number_of_packs || 1;
      }

      const quantity = packSize && numberOfPacks ? packSize * numberOfPacks : (neededQty > 0 ? neededQty : (currentItem.quantity || 0));

      newItems[index] = {
        ...newItems[index],
        sales_order_item_id: soItemId,
        product_id: batch.product_id,
        batch_id: batchId,
        pack_size: packSize,
        pack_type: packType,
        number_of_packs: numberOfPacks || 1,
        quantity: quantity,
      };
      setItems(newItems);
    }
  };

  const updatePackQuantity = (index: number, packs: number) => {
    const newItems = [...items];
    const item = newItems[index];
    if (item.pack_size) {
      newItems[index] = {
        ...item,
        number_of_packs: packs,
        quantity: item.pack_size * packs,
      };
      setItems(newItems);
    }
  };

  const addItem = () => {
    // If there is an SO selected with source items, default sales_order_item_id and product_id to the first source
    const defaultSource = salesOrderItemSources.length === 1 ? salesOrderItemSources[0] : null;
    setItems([...items, {
      sales_order_item_id: defaultSource?.id || null,
      product_id: defaultSource?.product_id || '',
      batch_id: '',
      quantity: 0,
      pack_size: null,
      pack_type: null,
      number_of_packs: null,
    }]);
  };

  const removeItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const quantityViolations = useMemo(() => {
    if (!formData.sales_order_id || !salesOrderItemSources.length) return [];
    const sourceMap = new Map(salesOrderItemSources.map(s => [s.id, s]));
    const qtyBySoItem = new Map<string, number>();
    items.forEach(item => {
      if (item.sales_order_item_id) {
        const prev = qtyBySoItem.get(item.sales_order_item_id) || 0;
        qtyBySoItem.set(item.sales_order_item_id, prev + (Number(item.quantity) || 0));
      }
    });

    const violations: Array<{
      soItemId: string;
      productId: string;
      productName: string;
      unit: string;
      requestedQty: number;
      orderedQty: number;
      deliveredQty: number;
      remainingQty: number;
      soNumber: string;
      soId: string;
    }> = [];

    const currentSO = salesOrders.find(so => so.id === formData.sales_order_id);
    const soNumber = currentSO?.so_number || 'Sales Order';

    for (const [soItemId, requestedQty] of qtyBySoItem.entries()) {
      const source = sourceMap.get(soItemId);
      if (!source) continue;
      const orderedQty = Number(source.quantity) || 0;
      const deliveredQty = Number(source.delivered_quantity || 0);
      const remainingQty = Math.max(0, orderedQty - deliveredQty);
      if (requestedQty > remainingQty + 0.0001) {
        const prod = products.find(p => p.id === source.product_id);
        const prodName = source.products?.product_name || prod?.product_name || 'Product';
        const unit = formatUnit(source.products?.unit || prod?.unit || '');
        violations.push({
          soItemId,
          productId: source.product_id,
          productName: prodName,
          unit,
          requestedQty,
          orderedQty,
          deliveredQty,
          remainingQty,
          soNumber,
          soId: formData.sales_order_id,
        });
      }
    }
    return violations;
  }, [formData.sales_order_id, salesOrderItemSources, items, salesOrders, products]);

  const alternateSalesOrders = useMemo(() => {
    if (!formData.customer_id) return [];
    return salesOrders.filter(so => so.id !== formData.sales_order_id);
  }, [salesOrders, formData.customer_id, formData.sales_order_id]);

  const handleNavigateToEditSO = (soId: string) => {
    setModalOpen(false);
    resetForm();
    setNavigationData({ editSalesOrderId: soId });
    setCurrentPage('sales-orders');
  };

  const handleCapQuantityToRemaining = (soItemId: string, remainingQty: number) => {
    const itemIndex = items.findIndex(it => it.sales_order_item_id === soItemId);
    if (itemIndex === -1) return;
    const targetItem = items[itemIndex];
    const packSize = targetItem.pack_size ? Number(targetItem.pack_size) : null;
    let finalQty = remainingQty;
    let finalPacks = targetItem.number_of_packs;

    if (packSize && packSize > 0) {
      finalPacks = Math.max(1, Math.floor(remainingQty / packSize));
      finalQty = finalPacks * packSize;
    }

    const nextItems = [...items];
    nextItems[itemIndex] = {
      ...targetItem,
      quantity: finalQty,
      number_of_packs: finalPacks,
    };
    setItems(nextItems);
  };

  const handleEdit = async (challan: DeliveryChallan) => {
    if (challan.approval_status === 'approved') {
      showToast({
        type: 'warning',
        title: 'Approved DC Locked',
        message: 'Approved Delivery Challans cannot be edited directly because inventory has already been posted. To correct, an admin must cancel/reverse this DC.',
      });
      return;
    }
    // Load full challan with sales_order_id
    const { data: fullChallan } = await supabase
      .from('delivery_challans')
      .select('*')
      .eq('id', challan.id)
      .single();

    setEditingChallan(challan);
    const targetCustomerId = fullChallan?.customer_id || challan.customer_id;
    const targetSoId = fullChallan?.sales_order_id || '';

    setFormData({
      challan_number: challan.challan_number,
      customer_id: targetCustomerId,
      sales_order_id: targetSoId,
      challan_date: challan.challan_date,
      delivery_address: challan.delivery_address,
      vehicle_number: challan.vehicle_number || '',
      driver_name: challan.driver_name || '',
      notes: challan.notes || '',
    });

    // Populate Sales Orders for this customer so the dropdown is ready for relinking
    await loadSalesOrders(targetCustomerId);

    // If linked to a Sales Order, hydrate SO items and reservation status
    let loadedSources: SalesOrderItemSource[] = [];
    if (targetSoId) {
      try {
        const [soItemsResult, reservationsResult] = await Promise.all([
          supabase
            .from('sales_order_items')
            .select(`id, product_id, make_id, quantity, delivered_quantity, unit_price, products(product_name, unit)`)
            .eq('sales_order_id', targetSoId),
          supabase
            .from('so_product_reservation_status')
            .select('sales_order_item_id, reserved_quantity')
            .eq('sales_order_id', targetSoId)
        ]);

        if (soItemsResult.data) {
          const normalized = soItemsResult.data.map((item: any) => ({
            ...item,
            products: Array.isArray(item.products) ? (item.products[0] || null) : item.products,
          })) as SalesOrderItemSource[];
          setSalesOrderItemSources(normalized);
          loadedSources = normalized;
        }
        if (reservationsResult.data) {
          const resMap = new Map<string, number>();
          reservationsResult.data.forEach((r: any) => {
            resMap.set(r.sales_order_item_id, parseFloat(r.reserved_quantity));
          });
          setSoReservations(resMap);
          setSoReservationLoadState('ready');
        }
      } catch (err) {
        console.error('Error hydrating SO sources for DC edit:', err);
      }
    }

    const loadedItems = await loadChallanItems(challan.id);
    setOriginalItems(loadedItems);

    if (loadedItems.length > 0) {
      setItems(loadedItems.map(item => {
        let soItemId = item.sales_order_item_id || null;
        if (!soItemId && loadedSources.length > 0) {
          const match = loadedSources.find(s => s.product_id === item.product_id);
          if (match) soItemId = match.id;
        }
        return {
          id: item.id,
          product_id: item.product_id,
          sales_order_item_id: soItemId,
          batch_id: item.batch_id,
          quantity: parseFloat(String(item.quantity)) || 0,
          pack_size: item.pack_size ? parseFloat(String(item.pack_size)) : null,
          pack_type: item.pack_type,
          number_of_packs: item.number_of_packs ? parseInt(String(item.number_of_packs), 10) : null,
        };
      }));
    }

    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (items.length === 0) {
      showToast({ type: 'error', title: 'Error', message: 'Please add at least one item to the Delivery Challan.' });
      return;
    }

    const invalidItems = items.filter(item => !item.product_id || !item.batch_id || item.quantity <= 0);
    if (invalidItems.length > 0) {
      showToast({ type: 'error', title: 'Error', message: 'Please select product, batch, and enter quantity for all items before saving.' });
      return;
    }

    const emptyBatches = items.filter(item => !item.batch_id || item.batch_id === '');
    if (emptyBatches.length > 0) {
      showToast({ type: 'error', title: 'Error', message: 'Some items do not have a batch selected. Please select a batch for all items.' });
      return;
    }

    const emptyProducts = items.filter(item => !item.product_id || item.product_id === '');
    if (emptyProducts.length > 0) {
      showToast({ type: 'error', title: 'Error', message: 'Some items do not have a product selected. Please select a product for all items.' });
      return;
    }

    const batchUsage = new Map<string, number>();
    for (const item of items) {
      const currentUsage = batchUsage.get(item.batch_id) || 0;
      batchUsage.set(item.batch_id, currentUsage + item.quantity);
    }

    for (const [batchId, totalQuantity] of batchUsage.entries()) {
      const batch = batches.find(b => b.id === batchId);
      if (batch) {
        let availableStock = getAvailableStock(batch);

        if (editingChallan) {
          const originalQtyInThisBatch = originalItems
            .filter(oi => oi.batch_id === batchId)
            .reduce((sum, oi) => sum + oi.quantity, 0);
          availableStock += originalQtyInThisBatch;
        }

        if (totalQuantity > availableStock) {
          const product = products.find(p => p.id === items.find(i => i.batch_id === batchId)?.product_id);
          const unit = formatUnit(product?.unit);
          showToast({ type: 'error', title: 'Error', message: `Insufficient available stock for batch ${batch.batch_number}!\n\nProduct: ${product?.product_name || 'Unknown'}\nBatch: ${batch.batch_number}\nAvailable: ${availableStock} ${unit}\nTotal Requested (across all items): ${totalQuantity} ${unit}\n\nYou are using this batch in multiple items. Please reduce quantities or select different batches.` });
          return;
        }
      }
    }

    if (!editingChallan && !formData.sales_order_id) {
      showToast({ type: 'error', title: 'Error', message: 'Sales Order is required to create a Delivery Challan.' });
      return;
    }

    if (formData.sales_order_id) {
      const { data: sourceOrder, error: sourceError } = await supabase
        .from('sales_orders')
        .select('id, customer_id, status')
        .eq('id', formData.sales_order_id)
        .maybeSingle();
      if (sourceError || !sourceOrder) {
        showToast({ type: 'error', title: 'Delivery Challan', message: 'The selected Sales Order no longer exists.' });
        return;
      }
      if (sourceOrder.customer_id !== formData.customer_id) {
        showToast({ type: 'error', title: 'Delivery Challan', message: 'Customer does not match the selected Sales Order.' });
        return;
      }
      const { data: sourceItems, error: sourceItemsError } = await supabase
        .from('sales_order_items')
        .select('id, product_id, quantity, delivered_quantity')
        .eq('sales_order_id', formData.sales_order_id);
      if (sourceItemsError) throw sourceItemsError;
      const sourceMap = new Map((sourceItems || []).map((row: any) => [row.id, row]));
      const qtyBySoItem = new Map<string, number>();

      for (const item of items) {
        if (!item.sales_order_item_id || !sourceMap.has(item.sales_order_item_id)) {
          showToast({ type: 'error', title: 'Delivery Challan', message: 'Every item must come from the selected Sales Order.' });
          return;
        }
        const source = sourceMap.get(item.sales_order_item_id) as any;
        if (source.product_id !== item.product_id) {
          showToast({ type: 'error', title: 'Delivery Challan', message: 'A selected product does not match its Sales Order item.' });
          return;
        }
        if (item.quantity <= 0) {
          showToast({ type: 'error', title: 'Delivery Challan', message: 'Item quantity must be greater than zero.' });
          return;
        }
        const prev = qtyBySoItem.get(item.sales_order_item_id) || 0;
        qtyBySoItem.set(item.sales_order_item_id, prev + item.quantity);
      }

      for (const [soItemId, totalQty] of qtyBySoItem.entries()) {
        const source = sourceMap.get(soItemId) as any;
        const maxRemaining = Number(source.quantity) - Number(source.delivered_quantity || 0);
        if (totalQty > maxRemaining + 0.0001) {
          const prodName = products.find(p => p.id === source.product_id)?.product_name || 'Product';
          const soNumber = salesOrders.find(s => s.id === formData.sales_order_id)?.so_number || 'Sales Order';
          showToast({
            type: 'error',
            title: 'Sales Order Quantity Constraint',
            message: `Delivery quantity (${totalQty}) exceeds the remaining Sales Order quantity (${maxRemaining}) for ${prodName} on ${soNumber}. Edit the Sales Order to increase quantity, select another order, or adjust the delivery quantity to ${maxRemaining}.`,
          });
          return;
        }
      }
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let challanId: string;

      if (editingChallan) {
        // Approved allocations have already posted physical stock.  Reject
        // before writing even header fields: the old ordering updated the
        // header in one request and only then rejected the item edit, leaving
        // an approved DC partially changed despite the error shown to users.
        if (editingChallan.approval_status === 'approved') {
          throw new Error('Approved Delivery Challans cannot be edited. Reject/cancel the DC to reverse its allocation, then create a corrected DC.');
        }

        const isReactivating = editingChallan.approval_status === 'rejected' || editingChallan.approval_status === 'cancelled';
        const updateData: Record<string, any> = {
          customer_id: formData.customer_id,
          sales_order_id: formData.sales_order_id || null,
          challan_date: formData.challan_date,
          delivery_address: formData.delivery_address,
          vehicle_number: formData.vehicle_number || null,
          driver_name: formData.driver_name || null,
          notes: formData.notes || null,
        };

        if (isReactivating) {
          updateData.approval_status = 'pending_approval';
          updateData.rejection_reason = null;
          updateData.rejected_by = null;
          updateData.rejected_at = null;
          updateData.approved_at = null;
          updateData.approved_by = null;
        }

        const prepareItemsWithPackaging = (rawItems: ChallanItem[]) => {
          return rawItems.map(item => {
            let packSize = item.pack_size ? parseFloat(String(item.pack_size)) : null;
            let packType = item.pack_type || null;
            let numberOfPacks = item.number_of_packs ? parseInt(String(item.number_of_packs), 10) : null;
            const qty = parseFloat(String(item.quantity)) || 0;

            if (!packSize || !packType) {
              const batch = batches.find(b => b.id === item.batch_id);
              if (batch?.per_pack_weight && Number(batch.per_pack_weight) > 0 && batch.pack_type) {
                packSize = Number(batch.per_pack_weight);
                packType = formatPackTypeForDisplay(batch.pack_type);
              } else if (batch?.packaging_details) {
                const match = batch.packaging_details.match(/(\d+)\s+(\w+)s?\s+x\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/i);
                if (match) {
                  packType = formatPackTypeForDisplay(match[2]);
                  packSize = parseFloat(match[3]);
                }
              }
            }

            if (!packSize || !packType) {
              const prod = products.find(p => p.id === item.product_id);
              const pWeight = Number(prod?.per_pack_weight);
              const pType = prod?.pack_type || prod?.packaging_type;
              if (pWeight > 0 && pType) {
                packSize = packSize || pWeight;
                packType = packType || formatPackTypeForDisplay(pType);
              }
            }

            if (packSize && packSize > 0) {
              const calcPacks = Math.round(qty / packSize);
              if (!numberOfPacks || Math.abs(numberOfPacks * packSize - qty) > 0.01) {
                numberOfPacks = calcPacks > 0 ? calcPacks : (numberOfPacks || 1);
              }
            }

            return {
              ...item,
              quantity: qty,
              pack_size: packSize,
              pack_type: packType,
              number_of_packs: numberOfPacks,
            };
          });
        };

        const preparedItems = prepareItemsWithPackaging(items);

        // Approved allocations are immutable. Corrections must use the
        // canonical rejection/cancellation reversal and a replacement DC.
        const itemsForRpc = preparedItems.map(item => ({
          id: item.id || null,
          product_id: item.product_id,
          batch_id: item.batch_id,
          sales_order_item_id: item.sales_order_item_id || null,
          quantity: item.quantity,
          pack_size: item.pack_size,
          pack_type: item.pack_type,
          number_of_packs: item.number_of_packs,
        }));

        const { data: rpcResult, error: rpcError } = await supabase.rpc('edit_delivery_challan', {
          p_challan_id: editingChallan.id,
          p_new_items: itemsForRpc,
          p_header: updateData,
        });
        if (rpcError) {
          console.error('RPC Error:', rpcError);
          throw new Error(`Failed to update DC: ${rpcError.message}`);
        }
        if (!rpcResult?.success) {
          console.error('RPC Result Error:', rpcResult?.error);
          throw new Error(rpcResult?.error || 'Failed to update DC items');
        }

        challanId = editingChallan.id;
      } else {
        // When creating new, include all fields including challan_number
        const challanData = {
          challan_number: formData.challan_number,
          customer_id: formData.customer_id,
          sales_order_id: formData.sales_order_id || null,
          challan_date: formData.challan_date,
          delivery_address: formData.delivery_address,
          vehicle_number: formData.vehicle_number || null,
          driver_name: formData.driver_name || null,
          notes: formData.notes || null,
          approval_status: 'pending_approval',
          created_by: user.id,
        };

        const { data: newChallan, error: challanError } = await supabase
          .from('delivery_challans')
          .insert([challanData])
          .select()
          .single();

        if (challanError) throw challanError;
        challanId = newChallan.id;
      }

      if (!editingChallan) {
        const prepareItemsWithPackaging = (rawItems: ChallanItem[]) => {
          return rawItems.map(item => {
            let packSize = item.pack_size ? parseFloat(String(item.pack_size)) : null;
            let packType = item.pack_type || null;
            let numberOfPacks = item.number_of_packs ? parseInt(String(item.number_of_packs), 10) : null;
            const qty = parseFloat(String(item.quantity)) || 0;

            if (!packSize || !packType) {
              const batch = batches.find(b => b.id === item.batch_id);
              if (batch?.per_pack_weight && Number(batch.per_pack_weight) > 0 && batch.pack_type) {
                packSize = Number(batch.per_pack_weight);
                packType = formatPackTypeForDisplay(batch.pack_type);
              } else if (batch?.packaging_details) {
                const match = batch.packaging_details.match(/(\d+)\s+(\w+)s?\s+x\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/i);
                if (match) {
                  packType = formatPackTypeForDisplay(match[2]);
                  packSize = parseFloat(match[3]);
                }
              }
            }

            if (!packSize || !packType) {
              const prod = products.find(p => p.id === item.product_id);
              const pWeight = Number(prod?.per_pack_weight);
              const pType = prod?.pack_type || prod?.packaging_type;
              if (pWeight > 0 && pType) {
                packSize = packSize || pWeight;
                packType = packType || formatPackTypeForDisplay(pType);
              }
            }

            if (packSize && packSize > 0) {
              const calcPacks = Math.round(qty / packSize);
              if (!numberOfPacks || Math.abs(numberOfPacks * packSize - qty) > 0.01) {
                numberOfPacks = calcPacks > 0 ? calcPacks : (numberOfPacks || 1);
              }
            }

            return {
              ...item,
              quantity: qty,
              pack_size: packSize,
              pack_type: packType,
              number_of_packs: numberOfPacks,
            };
          });
        };

        const preparedNewItems = prepareItemsWithPackaging(items);
        const challanItemsData = preparedNewItems.map(item => ({
          challan_id: challanId,
          product_id: item.product_id,
          batch_id: item.batch_id,
          sales_order_item_id: item.sales_order_item_id || null,
          quantity: item.quantity,
          pack_size: item.pack_size,
          pack_type: item.pack_type,
          number_of_packs: item.number_of_packs,
        }));

        if (challanItemsData.length === 0) {
          await supabase.from('delivery_challans').delete().eq('id', challanId);
          throw new Error('No items to save. Please add at least one item.');
        }

        const { data: insertedItems, error: itemsError } = await supabase
          .from('delivery_challan_items')
          .insert(challanItemsData)
          .select('id');

        if (itemsError) {
          await supabase.from('delivery_challans').delete().eq('id', challanId);
          throw itemsError;
        }

        if (!insertedItems || insertedItems.length === 0) {
          await supabase.from('delivery_challans').delete().eq('id', challanId);
          throw new Error('Items failed to save. The Delivery Challan was not created. Please try again.');
        }

      }

      // Pending DCs are not deliveries. The approval trigger recomputes the SO
      // only after reservation consumption, batch allocation, and physical
      // stock movement succeed in the same database transaction.

      setModalOpen(false);
      resetForm();
      emitErpSync('delivery_challans', editingChallan ? 'updated' : 'created');
      emitErpSync('sales_orders', 'updated');
      loadChallans();
      loadBatches();
      const isReactivated = editingChallan && (editingChallan.approval_status === 'rejected' || editingChallan.approval_status === 'cancelled');
      showToast({
        type: 'success',
        title: 'Success',
        message: editingChallan
          ? (isReactivated
              ? 'Delivery Challan updated and submitted for approval. You can now re-approve it.'
              : 'Delivery Challan updated successfully!')
          : 'Delivery Challan created successfully!'
      });
    } catch (error: any) {
      console.error('Error saving challan:', error);
      console.error('Full error object:', JSON.stringify(error, null, 2));
      const errorMessage = error?.message || error?.error_description || error?.msg || 'Unknown error occurred';

      if (errorMessage.toLowerCase().includes('insufficient stock')) {
        showToast({ type: 'error', title: 'Error', message: `Cannot save: ${errorMessage}\n\nPlease reduce quantities or select different batches with more stock.` });
      } else if (errorMessage.includes('batch_id')) {
        showToast({ type: 'error', title: 'Error', message: `Error: Invalid batch selection.\n\n${errorMessage}\n\nPlease ensure all items have a valid batch selected.` });
      } else if (errorMessage.includes('foreign key')) {
        showToast({ type: 'error', title: 'Error', message: `Error: Invalid product or batch selection.\n\n${errorMessage}\n\nPlease check your selections.` });
      } else {
        showToast({ type: 'error', title: 'Error', message: `Failed to save challan:\n\n${errorMessage}` });
      }
    }
  };

  const handleDelete = async (id: string) => {
    const challan = challans.find(c => c.id === id);
    if (challan?.approval_status === 'approved') {
      showToast({
        type: 'warning',
        title: 'Approved DC Locked',
        message: 'Approved Delivery Challans cannot be deleted directly. Use admin cancellation/reversal to reverse inventory movements.',
      });
      return;
    }
    if (!await showConfirm({
      title: 'Confirm Deletion',
      message: 'Are you sure you want to delete this delivery challan? Unapproved draft records will be permanently removed.',
      variant: 'danger',
      confirmLabel: 'Delete'
    })) return;

    try {
      const { data: dcData } = await supabase
        .from('delivery_challans')
        .select('sales_order_id, id, challan_number, approval_status')
        .eq('id', id)
        .single();

      const { error, count } = await supabase
        .from('delivery_challans')
        .delete({ count: 'exact' })
        .eq('id', id);

      if (error) {
        if (error.message?.includes('canonical stock history') || error.message?.includes('cannot be deleted')) {
          showToast({
            type: 'warning',
            title: 'Audit Record Preserved',
            message: `Delivery Challan ${dcData?.challan_number || ''} has posted inventory history and cannot be deleted from the database. It is preserved as ${dcData?.approval_status === 'rejected' ? 'Rejected' : 'Cancelled'} for audit tracking. To correct it, use Edit.`,
          });
          loadChallans();
          return;
        }
        throw error;
      }

      if (count === 0) {
        showToast({
          type: 'warning',
          title: 'Not Deleted',
          message: `Delivery Challan ${dcData?.challan_number || ''} was not deleted. Historical audit records with inventory movements are preserved. Use Edit to recover or correct it.`,
        });
        loadChallans();
        return;
      }

      if (dcData?.sales_order_id) {
        try {
          await supabase.rpc('fn_recompute_so_status', { p_so_id: dcData.sales_order_id });
        } catch (statusErr) {
          console.warn('Failed to recompute SO status after draft DC deletion:', statusErr);
        }
      }

      emitErpSync('delivery_challans', 'deleted');
      emitErpSync('sales_orders', 'updated');
      loadChallans();
      showToast({
        type: 'success',
        title: 'Deleted',
        message: 'Delivery Challan draft deleted successfully.'
      });
    } catch (error: any) {
      console.error('Error deleting challan:', error);
      showToast({
        type: 'error',
        title: 'Error',
        message: error?.message || 'Failed to delete challan. Please try again.'
      });
    }
  };

  const handleApproveChallan = async (challanId: string) => {
    if (!await showConfirm({ title: 'Confirm', message: 'Approve this Delivery Challan? Stock will be deducted and it will be available for invoice creation.', variant: 'warning' })) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const operationId = approvalOperationIdsRef.current[challanId] || crypto.randomUUID();
      approvalOperationIdsRef.current[challanId] = operationId;

      const { error } = await supabase
        .from('delivery_challans')
        .update({
          approval_status: 'approved',
          approval_operation_id: operationId,
          approved_by: user.id,
          approved_at: new Date().toISOString()
        })
        .eq('id', challanId);

      if (error) {
        console.error('Approval error:', error);
        const errorMsg = error.message || error.hint || 'Unknown error';
        throw new Error(errorMsg);
      }

      showToast({ type: 'success', title: 'Success', message: 'Delivery Challan approved successfully!' });
      delete approvalOperationIdsRef.current[challanId];
      emitErpSync('delivery_challans', 'approved', { entityId: challanId });
      emitErpSync('sales_orders', 'updated');
      emitErpSync('inventory', 'updated');
      loadChallans();

      // Notify warehouse staff (non-blocking)
      supabase.functions.invoke('send-app-notifications', {
        body: { type: 'dc_approved', data: { dc_id: challanId } }
      }).catch(() => {});
    } catch (error: any) {
      console.error('Error approving challan:', error);
      const errorMessage = error?.message || 'Unknown error';

      if (errorMessage.toLowerCase().includes('insufficient stock')) {
        showToast({ type: 'error', title: 'Error', message: `Cannot approve - Insufficient Stock!\n\n${errorMessage}\n\nPlease edit the DC and reduce quantities or select different batches.` });
      } else {
        showToast({ type: 'error', title: 'Error', message: `Failed to approve challan:\n\n${errorMessage}` });
      }
    }
  };

  const handleRejectChallan = async () => {
    if (!challanToReject || !rejectionReason.trim()) {
      showToast({ type: 'error', title: 'Error', message: 'Please enter a rejection reason' });
      return;
    }

    const targetChallan = challans.find(c => c.id === challanToReject);
    const wasApproved = targetChallan?.approval_status === 'approved';

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('delivery_challans')
        .update({
          approval_status: 'rejected',
          rejected_by: user.id,
          rejected_at: new Date().toISOString(),
          rejection_reason: rejectionReason
        })
        .eq('id', challanToReject);

      if (error) throw error;

      showToast({
        type: 'success',
        title: 'Success',
        message: wasApproved
          ? 'Approved Delivery Challan reversed and stock restored successfully'
          : 'Delivery Challan rejected'
      });
      setShowRejectModal(false);
      setRejectionReason('');
      setChallanToReject(null);
      emitErpSync('delivery_challans', 'rejected', { entityId: challanToReject });
      emitErpSync('sales_orders', 'updated');
      if (wasApproved) {
        emitErpSync('inventory', 'updated');
      }
      loadChallans();
    } catch (error: any) {
      console.error('Error rejecting challan:', error.message);
      showToast({ type: 'error', title: 'Error', message: error?.message || 'Failed to reject challan' });
    }
  };

  const resetForm = () => {
    setEditingChallan(null);
    setOriginalItems([]);
    setSalesOrderItemSources([]);
    setFormData({
      challan_number: '',
      customer_id: '',
      sales_order_id: '',
      challan_date: new Date().toISOString().split('T')[0],
      delivery_address: '',
      vehicle_number: '',
      driver_name: '',
      notes: '',
    });
    setItems([{
      product_id: '',
      batch_id: '',
      quantity: 0,
      pack_size: null,
      pack_type: null,
      number_of_packs: null,
    }]);
  };

  const columns = [
    {
      key: 'challan_number',
      label: 'DO Number',
      render: (value: any, _challan: DeliveryChallan) => (
        <span className="text-xs font-medium text-gray-700 tracking-wide">{value}</span>
      )
    },
    {
      key: 'customer',
      label: 'Customer',
      render: (value: any, challan: DeliveryChallan) => (
        <div className="font-medium">{challan.customers?.company_name}</div>
      )
    },
    {
      key: 'challan_date',
      label: 'Date',
      render: (value: any, challan: DeliveryChallan) => formatDate(challan.challan_date)
    },
    {
      key: 'approval_status',
      label: 'Status / Approval',
      render: (value: any, challan: DeliveryChallan) => {
        const statusColors: Record<string, string> = {
          pending_approval: 'bg-yellow-100 text-yellow-800 border border-yellow-300',
          approved: 'bg-green-100 text-green-800 border border-green-300',
          rejected: 'bg-red-100 text-red-800 border border-red-300',
          cancelled: 'bg-red-100 text-red-800 border border-red-300',
        };
        const statusLabels: Record<string, string> = {
          pending_approval: 'Draft / Pending',
          approved: 'Approved (Stock Posted)',
          rejected: 'Cancelled / Rejected',
          cancelled: 'Cancelled / Rejected',
        };
        return (
          <div className="flex items-center justify-center gap-2">
            <span className={`px-1.5 py-0.5 rounded-full text-[11px] leading-tight font-medium ${statusColors[challan.approval_status]}`}>
              <span className="inline md:hidden">
                {challan.approval_status === 'approved' ? 'Approved' : challan.approval_status === 'pending_approval' ? 'Draft' : 'Cancelled'}
              </span>
              <span className="hidden md:inline">
                {statusLabels[challan.approval_status]}
              </span>
            </span>
            {challan.approval_status === 'pending_approval' && profile?.role === 'admin' && (
              <div className="flex items-center gap-1 ml-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleApproveChallan(challan.id);
                  }}
                  className="p-1 bg-green-100 hover:bg-green-200 rounded-lg transition-colors"
                  title="Approve Delivery Challan"
                >
                  <CheckCircle className="w-4 h-4 text-green-600" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setChallanToReject(challan.id);
                    setShowRejectModal(true);
                  }}
                  className="p-1 bg-red-100 hover:bg-red-200 rounded-lg transition-colors"
                  title="Reject Delivery Challan"
                >
                  <XCircle className="w-4 h-4 text-red-600" />
                </button>
              </div>
            )}
            {challan.approval_status === 'approved' && (
              <span title="Approved" className="hidden md:inline">
                <CheckCircle className="w-4 h-4 text-green-600 ml-1" />
              </span>
            )}
            {challan.approval_status === 'rejected' && (
              <span title="Rejected" className="hidden md:inline">
                <XCircle className="w-4 h-4 text-red-600 ml-1" />
              </span>
            )}
          </div>
        );
      }
    },
    {
      key: 'so_dc_link',
      label: 'Linked Docs',
      thClassName: 'min-w-[130px]',
      tdClassName: 'min-w-[130px]',
      render: (_value: any, challan: DeliveryChallan) => (
        <LinkedDocsCell
          sos={(challan as any).linked_so_number ? [{ id: challan.sales_order_id || '', number: (challan as any).linked_so_number, type: 'so' }] : []}
          dcs={[]}
          invs={((challan as any).linked_invoices || []).map((n: string, i: number) => ({ id: `${challan.id}-${i}`, number: n, type: 'inv' as const }))}
          show={{ dc: false }}
          onClick={(doc: LinkedDocRef) => {
            if (doc.type === 'so') openSalesOrderPreview(doc.id);
            if (doc.type === 'inv') openInvoicePreview(doc.number);
          }}
        />
      )
    },
    {
      key: 'invoicing_status',
      label: 'Invoicing Status',
      render: (value: any, challan: DeliveryChallan) => {
        const statusColors = {
          not_invoiced: 'bg-gray-100 text-gray-700',
          partially_invoiced: 'bg-yellow-100 text-yellow-700',
          fully_invoiced: 'bg-blue-100 text-blue-700'
        };
        const statusLabels = {
          not_invoiced: 'Not Invoiced',
          partially_invoiced: 'Partially Invoiced',
          fully_invoiced: 'Fully Invoiced'
        };
        const status = challan.invoicing_status || 'not_invoiced';
        return (
          <div className="space-y-1">
            <span className={`inline-block px-1.5 py-0.5 rounded-full text-[11px] leading-tight font-medium ${statusColors[status]}`}>
              {statusLabels[status]}
            </span>
            {(challan.total_items ?? 0) > 0 && status !== 'fully_invoiced' && (
              <div className="text-xs text-gray-500">
                {challan.invoiced_items || 0}/{challan.total_items} items invoiced
              </div>
            )}
            {challan.linked_invoices && challan.linked_invoices.length > 0 && (
              <div className="text-xs text-blue-600 font-medium">
                {challan.linked_invoices.join(', ')}
              </div>
            )}
          </div>
        );
      }
    },
  ];

  const canManage = profile?.role === 'admin' || profile?.role === 'accounts' || profile?.role === 'sales' || profile?.role === 'warehouse';

  const stats = {
    total: challans.length,
  };

  return (
    <Layout>
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2 border-b border-gray-200">
          <div>
            <h1 className="text-lg sm:text-xl font-bold text-gray-900 tracking-tight">{t('deliveryChallan.title')}</h1>
            <p className="text-xs text-gray-500 mt-0.5">{t('deliveryChallan.manageSubtitle')}</p>
          </div>
          {canManage && (
            <button
              onClick={async () => {
                resetForm();
                const nextChallanNumber = await generateNextChallanNumber();
                setFormData(prev => ({ ...prev, challan_number: nextChallanNumber }));
                setModalOpen(true);
              }}
              className="flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-blue-700 shadow-xs transition"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('deliveryChallan.createDC')}
            </button>
          )}
        </div>

        <>
        <div className="bg-white rounded-xl border border-slate-200 shadow-xs px-3.5 py-2 min-h-[64px] flex flex-col justify-between max-w-xs">
          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t('deliveryChallan.totalChallans')}</span>
          <div className="text-base font-bold text-gray-900 mt-0.5">{stats.total}</div>
        </div>

        <DataTable
          columns={columns}
          data={challans}
          loading={loading}
          compact
          tableClassName="w-full min-w-[1050px]"
          actions={(challan) => (
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  await openChallanPreview(challan);
                }}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                title="View Challan"
              >
                <Eye className="w-4 h-4" />
              </button>
              {canManage && (
                <>
                  {challan.approval_status === 'approved' &&
                    // The summary view is the source of truth for invoiceable quantity.
                    // Keep the status fallback for older/temporarily unavailable view rows.
                    (challan.total_remaining_quantity == null
                      ? challan.invoicing_status !== 'fully_invoiced'
                      : Number(challan.total_remaining_quantity) > 0) && <button
                    onClick={async () => {
                      const items = await loadChallanItems(challan.id);
                      setNavigationData({
                        sourceType: 'delivery_challan',
                        customerId: challan.customer_id,
                        challanNumber: challan.challan_number,
                        challanId: challan.id,
                        items: items
                      });
                      setCurrentPage('sales');
                    }}
                    className="p-1 text-purple-600 hover:bg-purple-50 rounded"
                    title="Create Invoice"
                  >
                    <FileText className="w-4 h-4" />
                  </button>}
                  {/* Approved DCs are immutable; use the canonical reversal path. */}
                  {challan.approval_status !== 'approved' ? (
                    <>
                      <button
                        onClick={() => handleEdit(challan)}
                        className="p-1 text-indigo-600 hover:bg-indigo-50 rounded"
                        title={challan.approval_status === 'rejected' ? 'Recover & Edit Challan' : (challan.approval_status === 'cancelled' ? 'Edit Cancelled Challan' : 'Edit Draft Challan')}
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(challan.id)}
                        className="p-1 text-red-600 hover:bg-red-50 rounded"
                        title="Delete Draft Challan"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <div className="flex items-center gap-1">
                      <span
                        className="hidden sm:inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded cursor-help"
                        title="Approved DC has posted physical stock and is immutable."
                      >
                        <Lock className="w-3 h-3 text-emerald-600" />
                        Approved
                      </span>
                      {profile?.role === 'admin' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setChallanToReject(challan.id);
                            setShowRejectModal(true);
                          }}
                          className="p-1 text-amber-600 hover:bg-amber-50 rounded transition-colors"
                          title="Admin Correction: Cancel/Reverse approved DC (restores stock)"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
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
          title={editingChallan?.approval_status === 'approved' ? `Delivery Challan (Approved & Locked) - ${formData.challan_number}` : editingChallan ? `Edit Draft DC - ${formData.challan_number}` : `Create DC - ${formData.challan_number}`}
          size="xl"
          maxWidth="max-w-[90vw]"
        >
          <form onSubmit={handleSubmit} className="space-y-3">
            <SapRow>
              <FloatingField label="Customer" filled={!!formData.customer_id} required span={6}>
                <SearchableSelect
                  value={formData.customer_id}
                  onChange={handleCustomerChange}
                  options={customers.map(c => ({ value: c.id, label: c.company_name }))}
                  placeholder="Select Customer"
                  required
                  disabled={!!formData.sales_order_id}
                />
              </FloatingField>

              <div className="sm:col-span-6 min-w-0">
                <FloatingField label="Sales Order" filled={!!formData.sales_order_id} required={!editingChallan} span={12}>
                  <SearchableSelect
                    value={formData.sales_order_id}
                    onChange={handleSalesOrderChange}
                    options={salesOrders.map((so: any) => {
                      const productNames = [...new Set(
                        (so.sales_order_items || [])
                          .map((i: any) => i.products?.product_name)
                          .filter(Boolean)
                      )].join(', ');
                      const statusLabel = so.status === 'partially_delivered' ? 'partial' : so.status.replace('_', ' ');
                      return {
                        value: so.id,
                        label: productNames
                          ? `${so.so_number} — ${productNames} (${statusLabel})`
                          : `${so.so_number} (${statusLabel})`
                      };
                    })}
                    placeholder={formData.customer_id ? 'Select Sales Order' : 'Select a customer first'}
                    disabled={!formData.customer_id}
                  />
                </FloatingField>
                {!formData.customer_id && (
                  <p className="text-[10px] text-gray-500 mt-0.5">Select a customer first to see available Sales Orders</p>
                )}
                {formData.customer_id && salesOrders.length === 0 && (
                  <p className="text-[10px] text-red-600 mt-0.5 font-medium">
                    No active Sales Orders for this customer. Please create a Sales Order first before creating a Delivery Challan.
                  </p>
                )}
                {formData.customer_id && salesOrders.length > 0 && !formData.sales_order_id && !editingChallan && (
                  <p className="text-[10px] text-amber-600 mt-0.5">
                    Please create or select a Sales Order before creating Delivery Challan
                  </p>
                )}
              </div>
            </SapRow>

            <SapRow>
              <FloatingField label="Vehicle Number" filled={!!formData.vehicle_number} span={4}>
                <input name="vehicle_number" aria-label="Vehicle Number"
                  type="text"
                  value={formData.vehicle_number}
                  onChange={(e) => setFormData({ ...formData, vehicle_number: e.target.value })}
                  className={FLOAT_INPUT}
                  placeholder="B 1234 XYZ"
                />
              </FloatingField>

              <FloatingField label="Driver Name" filled={!!formData.driver_name} span={4}>
                <input name="driver_name" aria-label="Driver Name"
                  type="text"
                  value={formData.driver_name}
                  onChange={(e) => setFormData({ ...formData, driver_name: e.target.value })}
                  className={FLOAT_INPUT}
                  placeholder="Driver name"
                />
              </FloatingField>

              <FloatingField label="Date" filled={!!formData.challan_date} required span={4}>
                <input name="date" aria-label="Date"
                  type="date"
                  value={formData.challan_date}
                  onChange={(e) => setFormData({ ...formData, challan_date: e.target.value })}
                  className={FLOAT_INPUT}
                  required
                />
              </FloatingField>
            </SapRow>

            <SapRow>
              <FloatingField label="Delivery Address" filled={!!formData.delivery_address} required textarea span={6}>
                <textarea name="delivery_address" aria-label="Delivery Address"
                  value={formData.delivery_address}
                  onChange={(e) => setFormData({ ...formData, delivery_address: e.target.value })}
                  className={FLOAT_TEXTAREA}
                  rows={2}
                  required
                />
              </FloatingField>
              <FloatingField label="Notes" filled={!!formData.notes} textarea span={6}>
                <textarea name="notes" aria-label="Notes"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className={FLOAT_TEXTAREA}
                  rows={2}
                  placeholder="Additional notes..."
                />
              </FloatingField>
            </SapRow>

            <div className="border-t pt-3 mt-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-700">Items to Dispatch</h3>
                {editingChallan?.approval_status !== 'approved' && (
                  <button
                    type="button"
                    onClick={addItem}
                    className="text-sm px-3 py-1 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg font-medium transition-colors"
                  >
                    + Add Item
                  </button>
                )}
              </div>

              {formData.sales_order_id && salesOrderItemSources.length > 0 && (
                <div className="mb-3 rounded border border-blue-200 bg-blue-50 p-2 text-xs text-blue-900">
                  <div className="font-semibold mb-1">Sales Order source and remaining quantities</div>
                  <div className="space-y-1">
                    {salesOrderItemSources.map(source => (
                      <div key={source.id} className="flex justify-between gap-3">
                        <span>{source.products?.product_name || source.product_id}</span>
                        <span>
                          Ordered {source.quantity} · Delivered {source.delivered_quantity || 0} · Reserved{' '}
                          {soReservationLoadState === 'loading'
                            ? 'Loading…'
                            : soReservationLoadState === 'error'
                              ? 'Unavailable (reservation query failed)'
                              : (soReservations.get(source.id) ?? 0)}{' '}
                          · Remaining {Math.max(0, Number(source.quantity) - Number(source.delivered_quantity || 0))} {source.products?.unit || ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {quantityViolations.length > 0 && (
                <div className="mb-3 rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-xs text-amber-950 shadow-sm animate-fade-in">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    <div className="space-y-1.5 flex-1">
                      <div className="font-bold text-amber-900 text-sm">
                        Sales Order Delivery Quantity Constraint Detected
                      </div>
                      {quantityViolations.map((v, i) => (
                        <div key={i} className="text-amber-900">
                          Requested delivery quantity <strong>{v.requestedQty} {v.unit}</strong> exceeds remaining order quantity <strong>{v.remainingQty} {v.unit}</strong> on Sales Order <strong>{v.soNumber}</strong> (Ordered: {v.orderedQty} {v.unit}, Delivered: {v.deliveredQty} {v.unit}).
                        </div>
                      ))}
                      <p className="text-amber-800 text-[11px]">
                        SAPJ ERP requires that Delivery Challan items do not exceed the authorized Sales Order quantities. You can either increase the Sales Order quantity through its authorized approval process, select another eligible Sales Order with sufficient remaining quantity, or adjust the delivery quantity to match the remaining order.
                      </p>
                      <div className="pt-2 flex flex-wrap items-center gap-2 border-t border-amber-200 mt-2">
                        <button
                          type="button"
                          onClick={() => handleNavigateToEditSO(formData.sales_order_id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-md shadow-xs transition-colors text-xs"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          Edit Sales Order ({quantityViolations[0]?.soNumber}) to Increase Quantity
                        </button>
                        {alternateSalesOrders.length > 0 && (
                          <div className="inline-flex items-center gap-1">
                            <span className="text-[11px] text-amber-800 font-medium">Or switch to:</span>
                            <select
                              className="text-xs border border-amber-300 rounded px-2 py-1 bg-white text-gray-800"
                              onChange={(e) => {
                                if (e.target.value) handleSalesOrderChange(e.target.value);
                              }}
                              defaultValue=""
                            >
                              <option value="" disabled>Select alternative SO...</option>
                              {alternateSalesOrders.map((altSo: any) => (
                                <option key={altSo.id} value={altSo.id}>
                                  {altSo.so_number} ({altSo.status})
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {quantityViolations.map((v, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => handleCapQuantityToRemaining(v.soItemId, v.remainingQty)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 bg-white hover:bg-amber-100 border border-amber-300 text-amber-900 font-medium rounded-md shadow-xs transition-colors text-xs"
                          >
                            Set Quantity to Remaining ({v.remainingQty} {v.unit})
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {editingChallan?.approval_status === 'approved' && (
                <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 flex items-center gap-2">
                  <span className="text-amber-500">!</span>
                  Approved Delivery Challans are immutable. Reject/cancel this DC to reverse its allocation, then create a corrected DC.
                </div>
              )}

              {/* Mobile Item Entry Cards (<768px) */}
              <div className="md:hidden space-y-2.5">
                {items.map((item, index) => {
                  const batchUsageInForm = new Map<string, number>();
                  items.forEach((formItem, formIndex) => {
                    if (formIndex !== index && formItem.batch_id) {
                      const currentUsage = batchUsageInForm.get(formItem.batch_id) || 0;
                      batchUsageInForm.set(formItem.batch_id, currentUsage + formItem.quantity);
                    }
                  });
                  const availableBatches = batches.filter(b => {
                    const baseAvailable = getAvailableStock(b);
                    const usedInOtherItems = batchUsageInForm.get(b.id) || 0;
                    const sourceMake = salesOrderItemSources.find(source => source.id === item.sales_order_item_id)?.make_id || null;
                    return b.product_id === item.product_id && (!sourceMake || b.make_id === sourceMake) && (baseAvailable - usedInOtherItems) > 0;
                  });
                  const selectedBatch = batches.find(b => b.id === item.batch_id);
                  const unitLabel = formatUnit(item.products?.unit || (selectedBatch?.product_id && products.find(p => p.id === selectedBatch.product_id)?.unit) || '');

                  return (
                    <div key={index} className="bg-gray-50/70 border border-gray-200 rounded-xl p-2.5 space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-bold text-gray-500 uppercase">Item #{index + 1}</span>
                        {items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeItem(index)}
                            className="no-compact p-1 text-red-600 hover:bg-red-50 rounded"
                            title="Remove item"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-gray-600 mb-0.5">Product</label>
                        <SearchableSelect
                          value={item.product_id}
                          onChange={(value) => {
                            const matchingSource = salesOrderItemSources.find(s => s.product_id === value);
                            const newItems = [...items];
                            newItems[index] = {
                              ...newItems[index],
                              product_id: value,
                              sales_order_item_id: matchingSource?.id || newItems[index].sales_order_item_id || null,
                              batch_id: '',
                              quantity: 0,
                              pack_size: null,
                              pack_type: null,
                              number_of_packs: null,
                            };
                            setItems(newItems);
                          }}
                          options={products.map(p => ({ value: p.id, label: p.product_name }))}
                          placeholder="Select Product"
                          className="text-xs"
                          required
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-0.5">
                          <label className="text-[11px] font-semibold text-gray-600">Batch</label>
                          {item.product_id && availableBatches.length > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                const sourceMake = salesOrderItemSources.find(source => source.id === item.sales_order_item_id)?.make_id || null;
                                const fifoBatch = getFIFOBatch(item.product_id, sourceMake);
                                if (fifoBatch) handleBatchChange(index, fifoBatch.id);
                              }}
                              className="no-compact text-[11px] text-blue-600 font-semibold"
                            >
                              Use FIFO
                            </button>
                          )}
                        </div>
                        {!item.product_id ? (
                          <div className="text-gray-400 text-[11px] py-1">Select product first</div>
                        ) : availableBatches.length > 0 ? (
                          <SearchableSelect
                            value={item.batch_id}
                            onChange={(value) => handleBatchChange(index, value)}
                            options={availableBatches.map((b, idx) => ({
                              value: b.id,
                              label: `${b.batch_number} (Avl: ${getAvailableStock(b) - (batchUsageInForm.get(b.id) || 0)} ${unitLabel})${idx === 0 ? ' 🔄' : ''}`,
                            }))}
                            placeholder="Select Batch"
                            className="text-xs"
                            required
                          />
                        ) : (
                          <div className="text-red-600 text-[11px] py-1">No stock available</div>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] font-semibold text-gray-600 mb-0.5">
                            Qty {unitLabel ? `(${unitLabel})` : ''}
                          </label>
                          {item.pack_size ? (
                            <input
                              type="text"
                              value={item.quantity || 0}
                              className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-gray-100 text-right"
                              disabled
                            />
                          ) : (
                            <input
                              type="number"
                              min="0.01"
                              step="0.01"
                              value={item.quantity || ''}
                              onChange={(e) => {
                                const next = [...items];
                                next[index] = { ...next[index], quantity: Number(e.target.value) || 0 };
                                setItems(next);
                              }}
                              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg bg-white text-right"
                              required
                            />
                          )}
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-gray-600 mb-0.5">
                            {item.pack_size ? 'Packs' : 'Available'}
                          </label>
                          {item.pack_size ? (
                            <input
                              type="number"
                              min="1"
                              value={item.number_of_packs || ''}
                              onChange={(e) => updatePackQuantity(index, Number(e.target.value))}
                              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg bg-white text-right"
                              required
                            />
                          ) : (
                            <div className="px-2 py-1.5 text-xs font-semibold text-green-700 bg-white border border-gray-200 rounded-lg text-right">
                              {selectedBatch ? `${(getAvailableStock(selectedBatch) - (batchUsageInForm.get(selectedBatch.id) || 0)).toLocaleString()} ${unitLabel}` : '—'}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Desktop Item Table (md+) */}
              <div className="hidden md:block overflow-x-auto max-h-96 rounded border border-gray-200">
                <table className="min-w-[1220px] w-full text-xs">
                  <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-2 py-1.5 text-left w-52">Product</th>
                      <th className="px-2 py-1.5 text-left w-40">Make / Manufacturer</th>
                      <th className="px-2 py-1.5 text-left w-48">Batch</th>
                      <th className="px-2 py-1.5 text-left w-28">Expiry</th>
                      <th className="px-2 py-1.5 text-left w-36">Packaging</th>
                      <th className="px-2 py-1.5 text-right w-24">Qty</th>
                      <th className="px-2 py-1.5 text-left w-16">UOM</th>
                      <th className="px-2 py-1.5 text-right w-24">Available</th>
                      <th className="px-2 py-1.5 text-right w-20">Packs</th>
                      <th className="px-2 py-1.5 w-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                {items.map((item, index) => {
                  const batchUsageInForm = new Map<string, number>();
                  items.forEach((formItem, formIndex) => {
                    if (formIndex !== index && formItem.batch_id) {
                      const currentUsage = batchUsageInForm.get(formItem.batch_id) || 0;
                      batchUsageInForm.set(formItem.batch_id, currentUsage + formItem.quantity);
                    }
                  });

                  const availableBatches = batches.filter(b => {
                    const baseAvailable = getAvailableStock(b);
                    const usedInOtherItems = batchUsageInForm.get(b.id) || 0;
                    const sourceMake = salesOrderItemSources.find(source => source.id === item.sales_order_item_id)?.make_id || null;
                    return b.product_id === item.product_id && (!sourceMake || b.make_id === sourceMake) && (baseAvailable - usedInOtherItems) > 0;
                  });
                  const selectedBatch = batches.find(b => b.id === item.batch_id);

                  return (
                    <tr key={index} className="bg-white hover:bg-blue-50/40 align-top">
                      <td className="px-2 py-1">
                        <SearchableSelect
                            value={item.product_id}
                            onChange={(value) => {
                              const matchingSource = salesOrderItemSources.find(s => s.product_id === value);
                              const newItems = [...items];
                              newItems[index] = {
                                ...newItems[index],
                                product_id: value,
                                sales_order_item_id: matchingSource?.id || newItems[index].sales_order_item_id || null,
                                batch_id: '',
                                quantity: 0,
                                pack_size: null,
                                pack_type: null,
                                number_of_packs: null,
                              };
                              setItems(newItems);
                            }}
                            options={products.map(p => ({ value: p.id, label: p.product_name }))}
                            placeholder="Select Product"
                            className="text-xs"
                            required
                          />
                      </td>
                      <td className="px-2 py-1 text-gray-600">{selectedBatch?.product_sources?.supplier_name || 'Not recorded'}</td>
                      <td className="px-2 py-1">
                        {!item.product_id ? <span className="text-gray-400">Select product first</span> : availableBatches.length > 0 ? <div className="flex items-center gap-1"><SearchableSelect value={item.batch_id} onChange={(value) => handleBatchChange(index, value)} options={availableBatches.map((b, idx) => ({ value: b.id, label: `${b.batch_number} (Avl: ${getAvailableStock(b) - (batchUsageInForm.get(b.id) || 0)} ${formatUnit(products.find(p => p.id === item.product_id)?.unit)})${idx === 0 ? ' 🔄' : ''}` }))} placeholder="Select Batch" className="text-xs flex-1" required /><button type="button" onClick={() => { const sourceMake = salesOrderItemSources.find(source => source.id === item.sales_order_item_id)?.make_id || null; const fifoBatch = getFIFOBatch(item.product_id, sourceMake); if (fifoBatch) handleBatchChange(index, fifoBatch.id); }} className="shrink-0 text-[10px] text-blue-600 hover:text-blue-700 font-medium" title="Select oldest batch (FIFO)">FIFO</button></div> : <span className="text-red-600">No stock available</span>}
                      </td>
                      <td className="px-2 py-1 text-gray-600">{selectedBatch?.expiry_date ? new Date(selectedBatch.expiry_date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—'}</td>
                      <td className="px-2 py-1 text-gray-600 truncate max-w-36">{selectedBatch?.packaging_details || '—'}</td>
                      <td className="px-2 py-1">
                        {item.pack_size ? (
                          <input
                            name="quantity"
                            aria-label="Quantity"
                            type="text"
                            value={item.quantity || 0}
                            className={`w-full px-2 py-1 text-xs border rounded bg-gray-100 text-right ${
                              quantityViolations.some(v => v.soItemId === item.sales_order_item_id)
                                ? 'border-amber-500 font-semibold text-amber-900 bg-amber-50/50'
                                : 'border-gray-200'
                            }`}
                            disabled
                          />
                        ) : (
                          <input
                            name="quantity"
                            aria-label="Quantity"
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={item.quantity || ''}
                            onChange={(e) => {
                              const next = [...items];
                              next[index] = { ...next[index], quantity: Number(e.target.value) || 0 };
                              setItems(next);
                            }}
                            className={`w-full px-2 py-1 text-xs border rounded text-right ${
                              quantityViolations.some(v => v.soItemId === item.sales_order_item_id)
                                ? 'border-amber-500 font-semibold text-amber-900 ring-1 ring-amber-400 bg-amber-50/50'
                                : 'border-gray-300'
                            }`}
                            required
                          />
                        )}
                      </td>
                      <td className="px-2 py-1 text-gray-600">{formatUnit(item.products?.unit || (selectedBatch?.product_id && products.find(p => p.id === selectedBatch.product_id)?.unit) || '')}</td>
                      <td className="px-2 py-1 text-right font-semibold text-green-700">{selectedBatch ? `${(getAvailableStock(selectedBatch) - (batchUsageInForm.get(selectedBatch.id) || 0)).toLocaleString()} ${formatUnit(products.find(p => p.id === item.product_id)?.unit)}` : '—'}</td>
                      <td className="px-2 py-1">
                        {item.pack_size ? (
                          <input
                            name="number_of_packs"
                            aria-label="Number Of Packs"
                            type="number"
                            min="1"
                            value={item.number_of_packs || ''}
                            onChange={(e) => updatePackQuantity(index, Number(e.target.value))}
                            className={`w-full min-w-[4.5rem] appearance-none px-1.5 py-1 text-xs border rounded text-right [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
                              quantityViolations.some(v => v.soItemId === item.sales_order_item_id)
                                ? 'border-amber-500 font-semibold text-amber-900 ring-1 ring-amber-400 bg-amber-50/50'
                                : 'border-gray-300'
                            }`}
                            required
                          />
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-center">{items.length > 1 && <button type="button" onClick={() => removeItem(index)} className="p-1 text-red-600 hover:bg-red-50 rounded" title="Remove item"><Trash2 className="w-3.5 h-3.5" /></button>}</td>
                    </tr>
                  );
                })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-3 border-t mt-3">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  resetForm();
                }}
                className="px-5 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium shadow-sm"
              >
                {editingChallan ? 'Update Challan' : 'Create Challan'}
              </button>
            </div>
          </form>
        </Modal>

        {viewModalOpen && selectedChallan && (
          <DeliveryChallanView
            challan={selectedChallan as any}
            items={challanItems as any}
            onClose={() => setViewModalOpen(false)}
            companyProfile={(selectedChallan as any).company_snapshot ?? undefined}
          />
        )}
        {linkedSOPreview && (
          <ProformaInvoiceView
            salesOrder={linkedSOPreview}
            items={linkedSOPreview.sales_order_items || []}
            onClose={() => setLinkedSOPreview(null)}
            companyProfile={linkedSOPreview.company_snapshot ?? undefined}
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
            companyProfile={linkedInvoicePreview.company_snapshot ?? undefined}
          />
        )}

        {showRejectModal && (() => {
          const target = challans.find(c => c.id === challanToReject);
          const wasApproved = target?.approval_status === 'approved';
          return (
            <Modal
              isOpen={showRejectModal}
              onClose={() => {
                setShowRejectModal(false);
                setRejectionReason('');
                setChallanToReject(null);
              }}
              title={wasApproved ? "Admin Correction: Reverse Approved Delivery Challan" : "Reject Delivery Challan"}
            >
              <div className="space-y-4">
                {wasApproved && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 space-y-1">
                    <p className="font-semibold">Attention: Stock & Sales Order Reversal</p>
                    <p>Reversing this approved delivery challan will restore physical batch stock, recompute sales order delivered quantities, and restore sales order reservations. Active (uncancelled) invoices must be cancelled first.</p>
                  </div>
                )}
                <SapRow>
                  <FloatingField
                    label={wasApproved ? "Reversal Reason" : "Rejection Reason"}
                    filled={!!rejectionReason}
                    required
                    textarea
                    span={12}
                  >
                    <textarea
                      name="rejection_reason"
                      aria-label="Enter reason..."
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                      rows={4}
                      className={FLOAT_TEXTAREA}
                      placeholder={
                        wasApproved
                          ? "Enter reason for reversing this approved delivery challan..."
                          : "Enter reason for rejecting this delivery challan..."
                      }
                    />
                  </FloatingField>
                </SapRow>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => {
                      setShowRejectModal(false);
                      setRejectionReason('');
                      setChallanToReject(null);
                    }}
                    className="px-4 py-2 border rounded-lg hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRejectChallan}
                    className={`px-4 py-2 text-white rounded-lg ${
                      wasApproved
                        ? 'bg-amber-600 hover:bg-amber-700'
                        : 'bg-red-600 hover:bg-red-700'
                    }`}
                    disabled={!rejectionReason.trim()}
                  >
                    {wasApproved ? 'Confirm Reversal' : 'Reject Challan'}
                  </button>
                </div>
              </div>
            </Modal>
          );
        })()}
        </>
      </div>
    </Layout>
  );
}
