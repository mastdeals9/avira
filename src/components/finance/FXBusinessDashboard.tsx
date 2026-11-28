import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { useFinance } from '../../contexts/FinanceContext';
import { 
  DollarSign, TrendingUp, TrendingDown, ArrowRight, ArrowUpRight, ArrowDownLeft, 
  Calendar, Download, Search, AlertCircle, RefreshCw, Filter, Eye, Layers, 
  CheckCircle2, Clock, X, ExternalLink, HelpCircle
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { sanitizeExportRows } from '../../utils/csvSafe';
import { fetchAllPages } from '../../utils/fxReportCalculations';

interface FXBusinessDashboardProps {
  onSwitchToAccountingReport?: () => void;
  onViewSalesOrder?: (orderId: string) => void;
  onViewInvoice?: (invoiceId: string) => void;
  onViewPayment?: (paymentId: string) => void;
}

export interface CommercialFxTransaction {
  id: string; // unique key (so_item_id or allocation_id)
  so_id: string;
  so_number: string;
  so_date: string;
  sale_currency: 'USD' | 'IDR';
  customer_id: string | null;
  customer_name: string;
  product_id: string;
  product_name: string;
  product_unit: string;
  so_quantity: number;
  so_currency: string;
  so_rate: number | null; // Sales Order Rate (commercial_usd_to_idr_rate)
  usd_sales_amount: number | null; // null for IDR sales orders!
  idr_sales_value: number; // actual IDR value
  idr_commercial_equivalent: number | null; // USD SO amount * so_rate (for USD orders)
  actual_invoiced_idr: number | null; // actual IDR invoiced
  si_id: string | null;
  si_number: string | null;
  si_date: string | null;
  batch_id: string | null;
  batch_number: string | null;
  pi_id: string | null;
  pi_number: string | null;
  pi_date: string | null;
  supplier_id: string | null;
  supplier_name: string;
  import_rate: number | null; // Import / Purchase Rate (purchase_invoices.exchange_rate)
  pi_currency: string;
  pi_total_usd: number;
  pi_paid_usd: number;
  pi_unpaid_usd: number;
  matched_usd_cost: number;
  // Payment allocations
  va_id?: string | null;
  raw_va_usd_settled?: number;
  allocation_share_ratio?: number;
  pv_id: string | null;
  pv_number: string | null;
  pv_date: string | null;
  payment_rate: number | null; // Supplier Payment Rate (payment_vouchers.exchange_rate > 1)
  usd_settled: number;
  idr_supplier_payment: number;
  // Calculations
  rate_diff_so_payment: number | null; // SO Rate - Supplier Payment Rate
  fx_impact_so_payment: number | null; // usd_settled * (SO Rate - Supplier Payment Rate)
  commercial_spread: number | null; // SO Rate - Import Rate
  commercial_spread_value: number | null; // usd_sales_amount * commercial_spread
  // Status
  settlement_status: 'Complete' | 'Missing SO Rate' | 'Pending Payment' | 'Unmatched' | 'IDR Sale';
  is_multiple_payments: boolean;
  all_payments?: {
    pv_id: string;
    pv_number: string;
    pv_date: string;
    rate: number;
    usd_amount: number;
    idr_paid: number;
    impact: number | null;
    is_real_fx: boolean;
  }[];
}

const fmt = (n: number | null | undefined) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};

const fmt2 = (n: number | null | undefined) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtUsd = (n: number | null | undefined) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
};

export function FXBusinessDashboard({
  onSwitchToAccountingReport,
  onViewSalesOrder,
  onViewInvoice,
  onViewPayment,
}: FXBusinessDashboardProps) {
  const { dateRange } = useFinance();
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [currencyFilter, setCurrencyFilter] = useState<'all' | 'USD' | 'IDR'>('USD');
  const [statusFilter, setStatusFilter] = useState<'all' | 'complete' | 'missing_so_rate' | 'pending_payment' | 'unmatched' | 'idr_sale'>('all');
  const [customerFilter, setCustomerFilter] = useState<string>('all');
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  const [productFilter, setProductFilter] = useState<string>('all');
  const [showMoreFilters, setShowMoreFilters] = useState(false);

  const [transactions, setTransactions] = useState<CommercialFxTransaction[]>([]);
  const [unmatchedPiExposures, setUnmatchedPiExposures] = useState<Array<{
    pi_id: string;
    pi_number: string;
    supplier_name: string;
    pi_total_usd: number;
    allocated_to_so_usd: number;
    unsold_unmatched_usd: number;
    pi_unpaid_usd: number;
    unallocated_share_pct: number;
  }>>([]);
  const [selectedTx, setSelectedTx] = useState<CommercialFxTransaction | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      // 1. Fetch Sales Orders with items & customer (paginated)
      const soData = await fetchAllPages<any>((from, to) =>
        supabase
          .from('sales_orders')
          .select(`
            id, so_number, so_date, currency, commercial_usd_to_idr_rate, total_amount, subtotal_amount,
            customers(id, company_name),
            sales_order_items(
              id, product_id, quantity, unit_price, quoted_usd_unit_price, line_total,
              products(id, product_name, product_code, unit)
            )
          `)
          .order('so_date', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to)
      );

      // 2. Fetch Sales Invoices & items (paginated)
      const siData = await fetchAllPages<any>((from, to) =>
        supabase
          .from('sales_invoices')
          .select(`
            id, invoice_number, invoice_date, sales_order_id, total_amount, subtotal,
            sales_invoice_items(
              id, product_id, batch_id, quantity, unit_price, line_total
            )
          `)
          .order('id', { ascending: true })
          .range(from, to)
      );

      // 3. Fetch Batches (paginated)
      const batchData = await fetchAllPages<any>((from, to) =>
        supabase
          .from('batches')
          .select('id, batch_number, import_quantity, import_price_usd, purchase_invoice_id')
          .order('id', { ascending: true })
          .range(from, to)
      );

      // 4. Fetch Purchase Invoices with suppliers (paginated)
      const piData = await fetchAllPages<any>((from, to) =>
        supabase
          .from('purchase_invoices')
          .select(`
            id, invoice_number, invoice_date, currency, exchange_rate, total_amount, paid_amount, balance_amount,
            suppliers(id, company_name)
          `)
          .order('id', { ascending: true })
          .range(from, to)
      );

      // 5. Fetch Payment Voucher Allocations & Payment Vouchers (paginated)
      const vaData = await fetchAllPages<any>((from, to) =>
        supabase
          .from('voucher_allocations')
          .select(`
            id, purchase_invoice_id, payment_voucher_id, allocated_amount, allocated_currency,
            payment_vouchers(
              id, voucher_number, voucher_date, payment_currency, exchange_rate, amount,
              bank_accounts(bank_name, account_name, account_number, currency)
            )
          `)
          .order('id', { ascending: true })
          .range(from, to)
      );

      // Build Fast Lookup Maps
      const batchMap = new Map<string, any>((batchData || []).map(b => [b.id, b]));
      const piMap = new Map<string, any>((piData || []).map(p => [p.id, p]));

      // Map SO ID -> array of invoice items
      const soInvoicesMap = new Map<string, any[]>();
      for (const si of siData || []) {
        if (!si.sales_order_id) continue;
        const list = soInvoicesMap.get(si.sales_order_id) || [];
        for (const item of si.sales_invoice_items || []) {
          list.push({
            si_id: si.id,
            si_number: si.invoice_number,
            si_date: si.invoice_date,
            product_id: item.product_id,
            batch_id: item.batch_id,
            quantity: Number(item.quantity || 0),
            line_total: Number(item.line_total || 0),
          });
        }
        soInvoicesMap.set(si.sales_order_id, list);
      }

      // Map PI ID -> array of voucher allocations
      const piAllocationsMap = new Map<string, any[]>();
      for (const va of vaData || []) {
        if (!va.purchase_invoice_id || !va.payment_vouchers) continue;
        const list = piAllocationsMap.get(va.purchase_invoice_id) || [];
        list.push({
          va_id: va.id,
          pv: va.payment_vouchers,
          allocated_usd: Number(va.allocated_amount || 0),
          allocated_currency: va.allocated_currency || 'USD',
        });
        piAllocationsMap.set(va.purchase_invoice_id, list);
      }

      // Build Transaction Trace Rows
      const txRows: CommercialFxTransaction[] = [];

      for (const so of soData || []) {
        const customerObj: any = Array.isArray(so.customers) ? so.customers[0] : so.customers;
        const customerName = customerObj?.company_name || 'Direct Customer';
        const rawCurrency = (so.currency || 'IDR').toUpperCase();
        const saleCurrency: 'USD' | 'IDR' = rawCurrency === 'USD' ? 'USD' : 'IDR';
        const isUsdSale = saleCurrency === 'USD';
        const soRate = so.commercial_usd_to_idr_rate ? Number(so.commercial_usd_to_idr_rate) : null;
        const linkedInvoices = soInvoicesMap.get(so.id) || [];

        for (const soi of so.sales_order_items || []) {
          const productObj: any = Array.isArray(soi.products) ? soi.products[0] : soi.products;
          const productName = productObj?.product_name || 'Inventory Product';
          const productUnit = productObj?.unit || 'kg';
          const soQty = Number(soi.quantity || 0);

          // Find linked batch & sales invoice
          const matchingInvs = linkedInvoices.filter(i => i.product_id === soi.product_id);
          const matchedInvoice = matchingInvs.length > 0 ? matchingInvs[0] : null;
          const matchedBatchId = matchedInvoice?.batch_id || null;
          const matchedBatch = matchedBatchId ? batchMap.get(matchedBatchId) : null;
          const batchNumber = matchedBatch?.batch_number || null;
          const actualInvoicedIdr = matchedInvoice ? Number(matchedInvoice.line_total || 0) : null;

          // Find Purchase Invoice
          const piId = matchedBatch?.purchase_invoice_id || null;
          const pi = piId ? piMap.get(piId) : null;
          const supplierObj: any = pi ? (Array.isArray(pi.suppliers) ? pi.suppliers[0] : pi.suppliers) : null;
          const supplierName = supplierObj?.company_name || (!pi ? 'Unmatched Supplier' : 'Direct Supplier');
          const importRate = pi ? (pi.currency === 'IDR' ? 1 : Number(pi.exchange_rate || 0)) : null;

          const piTotalUsd = pi ? Number(pi.total_amount || 0) : 0;
          const piPaidUsd = pi ? Number(pi.paid_amount || 0) : 0;
          const piUnpaidUsd = pi ? Number(pi.balance_amount || 0) : 0;
          const batchUnitCostUsd = matchedBatch?.import_price_usd ? Number(matchedBatch.import_price_usd) : 0;

          // Inclusion rule:
          // Include genuine USD sales orders OR sales orders with commercial FX quotation rate or quoted USD price
          const isFxRelevant = isUsdSale || (soRate !== null && soRate > 0) || Boolean(soi.quoted_usd_unit_price);
          if (!isFxRelevant) continue;

          if (!isUsdSale) {
            // ==================================================
            // 1. IDR SALES ORDER (e.g. SO-2026-0077, SO-2026-0078)
            // ==================================================
            // - SO currency = IDR
            // - SO amount is already IDR
            // - DO NOT derive/display "USD Sales" (usd_sales_amount = null)
            // - DO NOT calculate SO -> Payment FX Impact (fx_impact_so_payment = null)
            // - Do not attach supplier payment FX to customer commercial FX calculation
            const idrSalesValue = Number(soi.line_total || soi.unit_price * soQty || 0);

            txRows.push({
              id: `${soi.id}-idr`,
              so_id: so.id,
              so_number: so.so_number,
              so_date: so.so_date,
              sale_currency: 'IDR',
              customer_id: customerObj?.id || null,
              customer_name: customerName,
              product_id: soi.product_id,
              product_name: productName,
              product_unit: productUnit,
              so_quantity: soQty,
              so_currency: 'IDR',
              so_rate: soRate, // Shown as reference rate if entered
              usd_sales_amount: null, // NEVER derive fake USD sales!
              idr_sales_value: idrSalesValue,
              idr_commercial_equivalent: null,
              actual_invoiced_idr: actualInvoicedIdr,
              si_id: matchedInvoice?.si_id || null,
              si_number: matchedInvoice?.si_number || null,
              si_date: matchedInvoice?.si_date || null,
              batch_id: matchedBatchId,
              batch_number: batchNumber,
              pi_id: piId,
              pi_number: pi?.invoice_number || null,
              pi_date: pi?.invoice_date || null,
              supplier_id: supplierObj?.id || null,
              supplier_name: supplierName,
              import_rate: importRate,
              pi_currency: pi?.currency || 'USD',
              pi_total_usd: piTotalUsd,
              pi_paid_usd: piPaidUsd,
              pi_unpaid_usd: piUnpaidUsd,
              matched_usd_cost: 0,
              pv_id: null,
              pv_number: null,
              pv_date: null,
              payment_rate: null,
              usd_settled: 0,
              idr_supplier_payment: 0,
              rate_diff_so_payment: null,
              fx_impact_so_payment: null, // N/A
              commercial_spread: null, // N/A
              commercial_spread_value: null, // N/A
              settlement_status: 'IDR Sale',
              is_multiple_payments: false,
              all_payments: [],
            });
          } else {
            // ==================================================
            // 2. GENUINE USD SALES ORDER (e.g. SO-2026-0001, etc.)
            // ==================================================
            // - SO currency = USD
            // - SO amount remains USD
            // - commercial_usd_to_idr_rate is the commercial quotation rate
            // - Commercial IDR equivalent = USD SO amount * SO rate
            // - Actual IDR invoiced is from linked sales invoice
            const usdSalesAmount = Number(soi.line_total || soi.unit_price * soQty || 0);
            const idrCommercialEquivalent = (soRate && soRate > 0) ? usdSalesAmount * soRate : null;
            const idrSalesValue = idrCommercialEquivalent ?? (actualInvoicedIdr || 0);
            const matchedUsdCost = batchUnitCostUsd > 0 ? batchUnitCostUsd * soQty : usdSalesAmount;

            const commSpread = (soRate !== null && importRate !== null && importRate > 1) ? soRate - importRate : null;
            const commSpreadVal = (commSpread !== null && usdSalesAmount > 0) ? usdSalesAmount * commSpread : null;

            // Find Payment Vouchers allocated to this Purchase Invoice
            const allocations = piId ? (piAllocationsMap.get(piId) || []) : [];

            if (allocations.length === 0) {
              let status: 'Complete' | 'Missing SO Rate' | 'Pending Payment' | 'Unmatched';
              if (!pi && !matchedBatchId) {
                status = 'Unmatched';
              } else if (!soRate) {
                status = 'Missing SO Rate';
              } else {
                status = 'Pending Payment';
              }

              txRows.push({
                id: `${soi.id}-unpaid`,
                so_id: so.id,
                so_number: so.so_number,
                so_date: so.so_date,
                sale_currency: 'USD',
                customer_id: customerObj?.id || null,
                customer_name: customerName,
                product_id: soi.product_id,
                product_name: productName,
                product_unit: productUnit,
                so_quantity: soQty,
                so_currency: 'USD',
                so_rate: soRate,
                usd_sales_amount: usdSalesAmount,
                idr_sales_value: idrSalesValue,
                idr_commercial_equivalent: idrCommercialEquivalent,
                actual_invoiced_idr: actualInvoicedIdr,
                si_id: matchedInvoice?.si_id || null,
                si_number: matchedInvoice?.si_number || null,
                si_date: matchedInvoice?.si_date || null,
                batch_id: matchedBatchId,
                batch_number: batchNumber,
                pi_id: piId,
                pi_number: pi?.invoice_number || null,
                pi_date: pi?.invoice_date || null,
                supplier_id: supplierObj?.id || null,
                supplier_name: supplierName,
                import_rate: importRate,
                pi_currency: pi?.currency || 'USD',
                pi_total_usd: piTotalUsd,
                pi_paid_usd: piPaidUsd,
                pi_unpaid_usd: piUnpaidUsd,
                matched_usd_cost: matchedUsdCost,
                pv_id: null,
                pv_number: null,
                pv_date: null,
                payment_rate: null,
                usd_settled: 0,
                idr_supplier_payment: 0,
                rate_diff_so_payment: null,
                fx_impact_so_payment: null,
                commercial_spread: commSpread,
                commercial_spread_value: commSpreadVal,
                settlement_status: status,
                is_multiple_payments: false,
                all_payments: [],
              });
            } else {
              // Build all payments summary
              const allPaymentsList = allocations.map(a => {
                const pvRate = Number(a.pv.exchange_rate || 1);
                const usdAmt = Number(a.allocated_usd || 0);
                const isRealFx = pvRate > 1;
                const canCalc = isRealFx && soRate !== null && soRate > 0;
                const rateDiff = canCalc ? soRate - pvRate : null;
                const impact = canCalc ? usdAmt * (soRate - pvRate) : null;
                return {
                  pv_id: a.pv.id,
                  pv_number: a.pv.voucher_number,
                  pv_date: a.pv.voucher_date,
                  rate: pvRate,
                  usd_amount: usdAmt,
                  idr_paid: isRealFx ? usdAmt * pvRate : 0,
                  impact: impact,
                  is_real_fx: isRealFx,
                };
              });

              allocations.forEach((alloc, idx) => {
                const pv = alloc.pv;
                const rawPvRate = Number(pv.exchange_rate || 1);
                const bankCurr = (pv.bank_accounts?.currency || '').toUpperCase();
                const isRealFx = rawPvRate > 1 && bankCurr !== 'USD';
                const rawAllocatedUsd = Number(alloc.allocated_usd || 0);
                // Attribute only this SO item's batch/cost share of the PI so shared PIs never repeat full payment
                const shareRatio = piTotalUsd > 0 ? Math.min(1, Math.max(0, matchedUsdCost / piTotalUsd)) : 1;
                const usdSettled = Math.round(rawAllocatedUsd * shareRatio * 100) / 100;
                const idrPaid = isRealFx ? Math.round(usdSettled * rawPvRate * 100) / 100 : 0;
                const effectivePvRate = isRealFx ? rawPvRate : null;

                const canCalc = isRealFx && soRate !== null && soRate > 0 && usdSettled > 0;
                const rateDiff = canCalc ? soRate - rawPvRate : null;
                const impact = canCalc ? Math.round(usdSettled * (soRate - rawPvRate) * 100) / 100 : null;

                let status: 'Complete' | 'Missing SO Rate' | 'Pending Payment' | 'Unmatched';
                if (!soRate) {
                  status = 'Missing SO Rate';
                } else {
                  status = 'Complete';
                }

                txRows.push({
                  id: `${soi.id}-${alloc.va_id || idx}`,
                  so_id: so.id,
                  so_number: so.so_number,
                  so_date: so.so_date,
                  sale_currency: 'USD',
                  customer_id: customerObj?.id || null,
                  customer_name: customerName,
                  product_id: soi.product_id,
                  product_name: productName,
                  product_unit: productUnit,
                  so_quantity: soQty,
                  so_currency: 'USD',
                  so_rate: soRate,
                  usd_sales_amount: usdSalesAmount,
                  idr_sales_value: idrSalesValue,
                  idr_commercial_equivalent: idrCommercialEquivalent,
                  actual_invoiced_idr: actualInvoicedIdr,
                  si_id: matchedInvoice?.si_id || null,
                  si_number: matchedInvoice?.si_number || null,
                  si_date: matchedInvoice?.si_date || null,
                  batch_id: matchedBatchId,
                  batch_number: batchNumber,
                  pi_id: piId,
                  pi_number: pi?.invoice_number || null,
                  pi_date: pi?.invoice_date || null,
                  supplier_id: supplierObj?.id || null,
                  supplier_name: supplierName,
                  import_rate: importRate,
                  pi_currency: pi?.currency || 'USD',
                  pi_total_usd: piTotalUsd,
                  pi_paid_usd: piPaidUsd,
                  pi_unpaid_usd: piUnpaidUsd,
                  matched_usd_cost: matchedUsdCost,
                  va_id: alloc.va_id || null,
                  raw_va_usd_settled: rawAllocatedUsd,
                  allocation_share_ratio: shareRatio,
                  pv_id: pv.id,
                  pv_number: pv.voucher_number,
                  pv_date: pv.voucher_date,
                  payment_rate: effectivePvRate,
                  usd_settled: usdSettled,
                  idr_supplier_payment: idrPaid,
                  rate_diff_so_payment: rateDiff,
                  fx_impact_so_payment: impact,
                  commercial_spread: commSpread,
                  commercial_spread_value: commSpreadVal,
                  settlement_status: status,
                  is_multiple_payments: allocations.length > 1,
                  all_payments: allPaymentsList,
                });
              });
            }
          }
        }
      }

      // Sort by SO Date descending
      txRows.sort((a, b) => new Date(b.so_date).getTime() - new Date(a.so_date).getTime());
      setTransactions(txRows);

      // Compute remaining unallocated share per USD Purchase Invoice as explicit Unsold / Unmatched Exposure
      const allocatedUsdByPi = new Map<string, number>();
      const seenSoProd = new Set<string>();
      for (const row of txRows) {
        if (!row.pi_id) continue;
        const k = `${row.so_id}-${row.product_id}-${row.pi_id}`;
        if (seenSoProd.has(k)) continue;
        seenSoProd.add(k);
        allocatedUsdByPi.set(row.pi_id, (allocatedUsdByPi.get(row.pi_id) || 0) + Number(row.matched_usd_cost || 0));
      }

      const unmatchedList: typeof unmatchedPiExposures = [];
      for (const pi of piData || []) {
        if ((pi.currency || '').toUpperCase() !== 'USD') continue;
        const piTotal = Number(pi.total_amount || 0);
        if (piTotal <= 0) continue;
        const allocated = Math.min(piTotal, allocatedUsdByPi.get(pi.id) || 0);
        const unsold = Math.max(0, Math.round((piTotal - allocated) * 100) / 100);
        if (unsold > 0.01) {
          const suppObj: any = Array.isArray(pi.suppliers) ? pi.suppliers[0] : pi.suppliers;
          unmatchedList.push({
            pi_id: pi.id,
            pi_number: pi.invoice_number,
            supplier_name: suppObj?.company_name || 'Supplier',
            pi_total_usd: piTotal,
            allocated_to_so_usd: Math.round(allocated * 100) / 100,
            unsold_unmatched_usd: unsold,
            pi_unpaid_usd: Number(pi.balance_amount || 0),
            unallocated_share_pct: Math.round((unsold / piTotal) * 10000) / 100,
          });
        }
      }
      setUnmatchedPiExposures(unmatchedList);
    } catch (err: any) {
      console.error('Failed to load FX Business Dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Filter Options
  const customersList = useMemo(() => {
    const set = new Set<string>();
    transactions.forEach(t => { if (t.customer_name) set.add(t.customer_name); });
    return Array.from(set).sort();
  }, [transactions]);

  const suppliersList = useMemo(() => {
    const set = new Set<string>();
    transactions.forEach(t => { if (t.supplier_name && t.supplier_name !== 'Unmatched Supplier') set.add(t.supplier_name); });
    return Array.from(set).sort();
  }, [transactions]);

  const productsList = useMemo(() => {
    const set = new Set<string>();
    transactions.forEach(t => { if (t.product_name) set.add(t.product_name); });
    return Array.from(set).sort();
  }, [transactions]);

  // Filtered Rows
  const filteredTransactions = useMemo(() => {
    return transactions.filter(t => {
      // Date filter (based on SO Date)
      if (dateRange?.startDate && t.so_date < dateRange.startDate) return false;
      if (dateRange?.endDate && t.so_date > dateRange.endDate) return false;

      // Currency filter
      if (currencyFilter !== 'all' && t.sale_currency !== currencyFilter) return false;

      // Status filter
      if (statusFilter === 'complete' && t.settlement_status !== 'Complete') return false;
      if (statusFilter === 'missing_so_rate' && t.settlement_status !== 'Missing SO Rate') return false;
      if (statusFilter === 'pending_payment' && t.settlement_status !== 'Pending Payment') return false;
      if (statusFilter === 'unmatched' && t.settlement_status !== 'Unmatched') return false;
      if (statusFilter === 'idr_sale' && t.settlement_status !== 'IDR Sale') return false;

      // Dropdown filters
      if (customerFilter !== 'all' && t.customer_name !== customerFilter) return false;
      if (supplierFilter !== 'all' && t.supplier_name !== supplierFilter) return false;
      if (productFilter !== 'all' && t.product_name !== productFilter) return false;

      // Text search
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const match =
          t.so_number.toLowerCase().includes(q) ||
          t.customer_name.toLowerCase().includes(q) ||
          t.product_name.toLowerCase().includes(q) ||
          (t.si_number && t.si_number.toLowerCase().includes(q)) ||
          (t.pi_number && t.pi_number.toLowerCase().includes(q)) ||
          t.supplier_name.toLowerCase().includes(q) ||
          (t.pv_number && t.pv_number.toLowerCase().includes(q)) ||
          (t.batch_number && t.batch_number.toLowerCase().includes(q));
        if (!match) return false;
      }

      return true;
    });
  }, [transactions, dateRange, currencyFilter, statusFilter, customerFilter, supplierFilter, productFilter, searchTerm]);

  // Top KPIs
  const kpis = useMemo(() => {
    let totalUsdSold = 0;
    let totalUsdPaid = 0;
    let totalFxImpact = 0;
    let hasValidImpact = false;
    let weightedImportRateSum = 0;
    let importWeight = 0;
    let weightedSoRateSum = 0;
    let soWeight = 0;
    let totalIdrSettlementValue = 0;
    let totalUsdActuallySettled = 0;
    let totalUnpaidUsd = 0;
    let missingSoRateCount = 0;
    let completedCount = 0;

    // Track unique SO items, unique payment allocations (va_id), and unique purchase invoices (pi_id)
    const seenSoItems = new Set<string>();
    const seenVaIds = new Set<string>();
    const seenPiIds = new Set<string>();

    filteredTransactions.forEach(t => {
      const soItemKey = `${t.so_id}-${t.product_id}`;
      if (!seenSoItems.has(soItemKey)) {
        seenSoItems.add(soItemKey);

        // ONLY genuine USD sales orders contribute to USD Sold & Avg SO Rate!
        if (t.sale_currency === 'USD') {
          if (t.usd_sales_amount !== null && t.usd_sales_amount > 0) {
            totalUsdSold += t.usd_sales_amount;
          }
          if (t.so_rate && t.so_rate > 0 && t.usd_sales_amount) {
            weightedSoRateSum += t.so_rate * t.usd_sales_amount;
            soWeight += t.usd_sales_amount;
          } else {
            missingSoRateCount++;
          }
        }
      }

      if (t.settlement_status === 'Complete') {
        completedCount++;
      }

      // Only genuine USD transactions with actual import rate > 1
      if (t.sale_currency === 'USD' && t.import_rate && t.import_rate > 1) {
        const weight = t.usd_settled > 0 ? t.usd_settled : (t.usd_sales_amount || 1);
        weightedImportRateSum += t.import_rate * weight;
        importWeight += weight;
      }

      // Count each unique voucher_allocation ONLY ONCE in consolidated settlement KPIs
      if (t.sale_currency === 'USD' && t.payment_rate && t.payment_rate > 1) {
        const vaKey = t.va_id || t.id;
        if (!seenVaIds.has(vaKey)) {
          seenVaIds.add(vaKey);
          const uniqueSettled = Number(t.raw_va_usd_settled ?? t.usd_settled ?? 0);
          if (uniqueSettled > 0) {
            totalUsdPaid += uniqueSettled;
            totalIdrSettlementValue += uniqueSettled * t.payment_rate;
            totalUsdActuallySettled += uniqueSettled;
          }
        }
      }

      // SO -> Payment Commercial FX Impact (already proportionally allocated per SO item)
      if (t.sale_currency === 'USD' && t.fx_impact_so_payment !== null) {
        totalFxImpact += t.fx_impact_so_payment;
        hasValidImpact = true;
      }

      // Count each unique Purchase Invoice unpaid exposure ONLY ONCE
      if (t.sale_currency === 'USD' && t.pi_id && t.pi_unpaid_usd > 0 && !seenPiIds.has(t.pi_id)) {
        seenPiIds.add(t.pi_id);
        totalUnpaidUsd += t.pi_unpaid_usd;
      }
    });

    const avgImportRate = importWeight > 0 ? weightedImportRateSum / importWeight : 0;
    const avgSoRate = soWeight > 0 ? weightedSoRateSum / soWeight : 0;
    // Weighted effective rate: Total IDR settlement value / Total USD actually settled
    const avgPvRate = totalUsdActuallySettled > 0 ? totalIdrSettlementValue / totalUsdActuallySettled : 0;

    return {
      totalUsdSold,
      totalUsdPaid,
      avgImportRate,
      avgSoRate,
      avgPvRate,
      totalFxImpact,
      hasValidImpact,
      totalUnpaidUsd,
      missingSoRateCount,
      completedCount,
    };
  }, [filteredTransactions]);

  // Export to Excel
  const handleExportExcel = () => {
    const exportData = filteredTransactions.map(t => ({
      'SO Number': t.so_number,
      'SO Date': t.so_date,
      'Sale Currency': t.sale_currency,
      'Customer': t.customer_name,
      'Product': t.product_name,
      'Quantity': `${t.so_quantity} ${t.product_unit}`,
      'Original SO USD': t.sale_currency === 'USD' ? (t.usd_sales_amount !== null ? t.usd_sales_amount : '—') : '—',
      'SO Rate (Commercial)': t.so_rate || '—',
      'Commercial IDR Equivalent': t.idr_commercial_equivalent !== null ? t.idr_commercial_equivalent : '—',
      'Actual IDR Invoiced': t.actual_invoiced_idr !== null ? t.actual_invoiced_idr : '—',
      'SO Value (IDR)': t.idr_sales_value,
      'Sales Invoice': t.si_number || '—',
      'Batch Number': t.batch_number || '—',
      'Supplier': t.supplier_name,
      'Supplier Invoice': t.pi_number || '—',
      'PI Date': t.pi_date || '—',
      'Import Rate': t.import_rate || '—',
      'Payment Voucher': t.pv_number || 'Pending',
      'Payment Date': t.pv_date || '—',
      'Supplier Payment Rate': t.payment_rate || '—',
      'USD Settled': t.usd_settled > 0 ? t.usd_settled : '—',
      'IDR Supplier Payment': t.idr_supplier_payment > 0 ? t.idr_supplier_payment : '—',
      'SO -> Payment Rate Difference': t.rate_diff_so_payment !== null ? t.rate_diff_so_payment : '—',
      'SO -> Payment FX Impact (IDR)': t.sale_currency === 'IDR' ? 'N/A' : (t.fx_impact_so_payment !== null ? t.fx_impact_so_payment : 'Pending'),
      'Settlement Status': t.settlement_status,
    }));

    const sanitized = sanitizeExportRows(exportData);
    const ws = XLSX.utils.json_to_sheet(sanitized);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'FX Business Analysis');
    XLSX.writeFile(wb, `FX_Business_Dashboard_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="space-y-3">
      {/* 1. Single Compact Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2 border-b border-slate-200">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-slate-900 tracking-tight">
              FX Management
            </h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full border border-blue-200">
              Commercial FX
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Commercial FX — Sell Rate vs Supplier Payment Rate
            {dateRange?.startDate && dateRange?.endDate && (
              <span className="ml-1.5 text-slate-400 font-mono text-[11px]">
                ({fmtDate(dateRange.startDate)} – {fmtDate(dateRange.endDate)})
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center gap-1.5"
          >
            <TrendingUp className="w-3.5 h-3.5" />
            Commercial FX
          </button>
          {onSwitchToAccountingReport && (
            <button
              type="button"
              onClick={onSwitchToAccountingReport}
              className="px-3 py-1.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5"
              title="Open official Accounting FX Report"
            >
              <Layers className="w-3.5 h-3.5 text-indigo-600" />
              Accounting FX
            </button>
          )}
          <button
            type="button"
            onClick={handleExportExcel}
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold transition-colors shadow-xs flex items-center gap-1.5"
            title="Export all records with full trace metadata to Excel"
          >
            <Download className="w-3.5 h-3.5" />
            Excel
          </button>
          <button
            type="button"
            onClick={loadData}
            className="p-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-lg transition-colors"
            title="Refresh Data"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* 2. Compact 5-KPI Strip (~75px height) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5">
        {/* 1. USD Sold */}
        <div className="bg-white px-3.5 py-2 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between min-h-[72px]">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">USD Sold</span>
          <div className="mt-1">
            <div className="text-base font-bold text-slate-900 leading-tight">{fmtUsd(kpis.totalUsdSold)}</div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              Unpaid PI: {fmtUsd(kpis.totalUnpaidUsd)}
              {unmatchedPiExposures.length > 0 && (
                <span className="ml-1 text-amber-700 font-medium">
                  &bull; Unsold: {fmtUsd(unmatchedPiExposures.reduce((s, u) => s + u.unsold_unmatched_usd, 0))}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 2. Avg Sell Rate */}
        <div className="bg-white px-3.5 py-2 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between min-h-[72px]">
          <span className="text-[11px] font-semibold text-blue-600 uppercase tracking-wide">Avg Sell Rate</span>
          <div className="mt-1">
            <div className="text-base font-bold text-blue-900 leading-tight">
              {kpis.avgSoRate > 0 ? `Rp ${fmt(kpis.avgSoRate)}` : '—'}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              {kpis.missingSoRateCount > 0 ? `${kpis.missingSoRateCount} pending rate` : 'Customer quotation'}
            </div>
          </div>
        </div>

        {/* 3. Avg Payment Rate */}
        <div className="bg-white px-3.5 py-2 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between min-h-[72px]">
          <span className="text-[11px] font-semibold text-emerald-600 uppercase tracking-wide">Avg Payment Rate</span>
          <div className="mt-1">
            <div className="text-base font-bold text-emerald-900 leading-tight">
              {kpis.avgPvRate > 0 ? `Rp ${fmt(kpis.avgPvRate)}` : '—'}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">Settled: {fmtUsd(kpis.totalUsdPaid)}</div>
          </div>
        </div>

        {/* 4. Rate Difference */}
        <div className="bg-white px-3.5 py-2 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between min-h-[72px]">
          <span className="text-[11px] font-semibold text-indigo-600 uppercase tracking-wide">Rate Difference</span>
          <div className="mt-1">
            <div className={`text-base font-bold leading-tight ${
              kpis.avgSoRate > 0 && kpis.avgPvRate > 0
                ? (kpis.avgSoRate - kpis.avgPvRate >= 0 ? 'text-emerald-700' : 'text-rose-700')
                : 'text-slate-400'
            }`}>
              {kpis.avgSoRate > 0 && kpis.avgPvRate > 0
                ? `${kpis.avgSoRate - kpis.avgPvRate >= 0 ? '+' : ''}Rp ${fmt(kpis.avgSoRate - kpis.avgPvRate)}`
                : '—'}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">Sell Rate - Payment Rate</div>
          </div>
        </div>

        {/* 5. FX Impact */}
        <div className={`px-3.5 py-2 rounded-xl border shadow-xs flex flex-col justify-between min-h-[72px] col-span-2 sm:col-span-1 ${
          !kpis.hasValidImpact 
            ? 'bg-white border-slate-200' 
            : kpis.totalFxImpact >= 0 
            ? 'bg-emerald-50/70 border-emerald-200' 
            : 'bg-rose-50/70 border-rose-200'
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-700">FX Impact</span>
            {kpis.hasValidImpact && (
              <span className={`text-[10px] font-bold px-1.5 py-0.2 rounded ${
                kpis.totalFxImpact >= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
              }`}>
                {kpis.totalFxImpact >= 0 ? 'Favorable' : 'Unfavorable'}
              </span>
            )}
          </div>
          <div className="mt-1">
            <div className={`text-base font-bold leading-tight ${
              !kpis.hasValidImpact ? 'text-slate-400' : kpis.totalFxImpact >= 0 ? 'text-emerald-700' : 'text-rose-700'
            }`}>
              {kpis.hasValidImpact ? `${kpis.totalFxImpact >= 0 ? '+' : ''}Rp ${fmt(kpis.totalFxImpact)}` : 'Pending'}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">Settlement FX impact</div>
          </div>
        </div>
      </div>

      {/* 3. Compact Filter Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 shadow-xs space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Search Box */}
            <div className="relative w-44 sm:w-56">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search SO, customer, product..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-8 pr-2 py-1 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {/* Currency Scope Selector */}
            <div className="flex items-center bg-slate-100 p-0.5 rounded-lg text-xs font-semibold">
              <button
                type="button"
                onClick={() => setCurrencyFilter('USD')}
                className={`px-2.5 py-0.5 rounded-md transition-all ${
                  currencyFilter === 'USD'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                USD Sales ({transactions.filter(t => t.sale_currency === 'USD').length})
              </button>
              <button
                type="button"
                onClick={() => setCurrencyFilter('IDR')}
                className={`px-2.5 py-0.5 rounded-md transition-all ${
                  currencyFilter === 'IDR'
                    ? 'bg-slate-800 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                IDR Sales ({transactions.filter(t => t.sale_currency === 'IDR').length})
              </button>
              <button
                type="button"
                onClick={() => setCurrencyFilter('all')}
                className={`px-2.5 py-0.5 rounded-md transition-all ${
                  currencyFilter === 'all'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                All ({transactions.length})
              </button>
            </div>

            {/* Status Selector */}
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as any)}
              className="px-2.5 py-1 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-700 font-medium focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All Statuses</option>
              <option value="complete">Complete</option>
              <option value="pending_payment">Pending Payment</option>
              <option value="missing_so_rate">Missing SO Rate</option>
              <option value="unmatched">Unmatched</option>
              <option value="idr_sale">IDR Orders</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowMoreFilters(!showMoreFilters)}
              className={`px-2.5 py-1 text-xs rounded-lg border transition-colors flex items-center gap-1.5 ${
                showMoreFilters || customerFilter !== 'all' || supplierFilter !== 'all' || productFilter !== 'all'
                  ? 'bg-blue-50 text-blue-700 border-blue-200 font-semibold'
                  : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100 font-medium'
              }`}
            >
              <Filter className="w-3 h-3" />
              <span>More Filters</span>
              {(customerFilter !== 'all' || supplierFilter !== 'all' || productFilter !== 'all') && (
                <span className="w-1.5 h-1.5 rounded-full bg-blue-600" />
              )}
            </button>
            <span className="text-xs text-slate-400 font-medium">
              {filteredTransactions.length} records
            </span>
          </div>
        </div>

        {/* Collapsible Secondary Filters */}
        {showMoreFilters && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2 border-t border-slate-100 text-xs">
            <select
              value={customerFilter}
              onChange={e => setCustomerFilter(e.target.value)}
              className="px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 focus:bg-white focus:outline-none"
            >
              <option value="all">All Customers ({customersList.length})</option>
              {customersList.map(c => <option key={c} value={c}>{c}</option>)}
            </select>

            <select
              value={supplierFilter}
              onChange={e => setSupplierFilter(e.target.value)}
              className="px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 focus:bg-white focus:outline-none"
            >
              <option value="all">All Suppliers ({suppliersList.length})</option>
              {suppliersList.map(s => <option key={s} value={s}>{s}</option>)}
            </select>

            <select
              value={productFilter}
              onChange={e => setProductFilter(e.target.value)}
              className="px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 focus:bg-white focus:outline-none"
            >
              <option value="all">All Products ({productsList.length})</option>
              {productsList.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* 4. Primary Report Table (Optimized for 14-inch laptop) */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-slate-400 text-xs flex flex-col items-center gap-2">
            <RefreshCw className="w-6 h-6 animate-spin text-blue-500" />
            Loading and tracing FX transactions...
          </div>
        ) : filteredTransactions.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-xs">
            No transactions matched the selected filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50/80 text-slate-600 border-b border-slate-200 uppercase tracking-wider font-semibold text-[11px]">
                  <th className="py-2.5 px-3 whitespace-nowrap">SO / Date</th>
                  <th className="py-2.5 px-3">Customer / Product</th>
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">Sale</th>
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">Sell Rate</th>
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">Payment Rate</th>
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">Rate Diff</th>
                  <th className="py-2.5 px-3 text-right font-bold text-slate-900 whitespace-nowrap">FX Impact</th>
                  <th className="py-2.5 px-3 text-center whitespace-nowrap">Status</th>
                  <th className="py-2.5 px-2 text-center w-16 whitespace-nowrap">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredTransactions.map(tx => {
                  const isPositive = (tx.fx_impact_so_payment || 0) >= 0;
                  const isIdr = tx.sale_currency === 'IDR';

                  return (
                    <tr 
                      key={tx.id}
                      onClick={() => setSelectedTx(tx)}
                      className="hover:bg-blue-50/40 cursor-pointer transition-colors group"
                    >
                      {/* SO / Date */}
                      <td className="py-2 px-3 whitespace-nowrap">
                        <span className="font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                          {tx.so_number}
                        </span>
                        <div className="text-[10px] text-slate-400">{fmtDate(tx.so_date)}</div>
                      </td>

                      {/* Customer / Product */}
                      <td className="py-2 px-3 max-w-[220px]">
                        <div className="font-semibold text-slate-900 truncate" title={tx.customer_name}>
                          {tx.customer_name}
                        </div>
                        <div className="text-slate-500 text-[11px] truncate mt-0.5" title={tx.product_name}>
                          {tx.product_name} <span className="text-slate-400">({fmt(tx.so_quantity)} {tx.product_unit})</span>
                        </div>
                      </td>

                      {/* Sale */}
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        {isIdr ? (
                          <span className="font-bold text-slate-800">Rp {fmt(tx.idr_sales_value)}</span>
                        ) : (
                          <span className="font-bold text-blue-900">{fmtUsd(tx.usd_sales_amount)}</span>
                        )}
                      </td>

                      {/* Sell Rate */}
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        {isIdr ? (
                          tx.so_rate ? (
                            <span className="text-slate-700 font-medium">Rp {fmt(tx.so_rate)}</span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )
                        ) : tx.so_rate ? (
                          <span className="font-semibold text-blue-900">
                            Rp {fmt(tx.so_rate)}
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 font-bold rounded text-[10px] border border-amber-200">
                            Missing
                          </span>
                        )}
                      </td>

                      {/* Payment Rate */}
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        {isIdr ? (
                          <span className="text-slate-400">—</span>
                        ) : tx.payment_rate ? (
                          <span className="font-semibold text-emerald-800">
                            Rp {fmt(tx.payment_rate)}
                          </span>
                        ) : (
                          <span className="text-slate-400 italic text-[11px]">Pending</span>
                        )}
                      </td>

                      {/* Rate Diff */}
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        {isIdr ? (
                          <span className="text-slate-400">—</span>
                        ) : tx.rate_diff_so_payment !== null ? (
                          <span className={`font-bold ${
                            tx.rate_diff_so_payment >= 0 ? 'text-emerald-700' : 'text-rose-700'
                          }`}>
                            {tx.rate_diff_so_payment >= 0 ? '+' : ''}Rp {fmt(tx.rate_diff_so_payment)}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      {/* FX Impact */}
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        {isIdr ? (
                          <span className="text-slate-400 text-xs">N/A</span>
                        ) : tx.fx_impact_so_payment !== null ? (
                          <span className={`px-2 py-0.5 rounded font-bold text-xs ${
                            isPositive 
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                              : 'bg-rose-50 text-rose-700 border border-rose-200'
                          }`}>
                            {isPositive ? '+' : ''}Rp {fmt(tx.fx_impact_so_payment)}
                          </span>
                        ) : (
                          <span className="text-slate-400 italic text-[11px]">Pending</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="py-2 px-3 text-center whitespace-nowrap">
                        {tx.settlement_status === 'IDR Sale' && (
                          <span className="px-2 py-0.5 bg-slate-100 text-slate-700 border border-slate-200 rounded-full text-[10px] font-semibold">
                            IDR Order
                          </span>
                        )}
                        {tx.settlement_status === 'Complete' && (
                          <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-full text-[10px] font-bold">
                            Complete
                          </span>
                        )}
                        {tx.settlement_status === 'Missing SO Rate' && (
                          <span className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded-full text-[10px] font-bold">
                            Missing SO Rate
                          </span>
                        )}
                        {tx.settlement_status === 'Pending Payment' && (
                          <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full text-[10px] font-medium">
                            Pending Payment
                          </span>
                        )}
                        {tx.settlement_status === 'Unmatched' && (
                          <span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded-full text-[10px] font-medium">
                            Unmatched
                          </span>
                        )}
                      </td>

                      {/* Details Action */}
                      <td className="py-2 px-2 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => setSelectedTx(tx)}
                          className="px-2 py-0.5 bg-slate-50 hover:bg-blue-50 text-blue-700 hover:text-blue-800 rounded border border-slate-200 hover:border-blue-300 text-[11px] font-semibold transition-colors inline-flex items-center gap-1"
                        >
                          <Eye className="w-3 h-3" />
                          View
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 5. Compact Expandable Details Modal */}
      {selectedTx && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-3xl rounded-xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[85vh]">
            {/* Modal Header */}
            <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${
                    selectedTx.sale_currency === 'USD'
                      ? 'bg-blue-500/30 text-blue-300 border-blue-400/40'
                      : 'bg-slate-700 text-slate-200 border-slate-600'
                  }`}>
                    {selectedTx.sale_currency === 'USD' ? 'USD Commercial FX' : 'IDR Order'}
                  </span>
                  <span className="text-xs text-slate-300 font-medium">
                    {selectedTx.customer_name} · {selectedTx.product_name}
                  </span>
                </div>
                <h3 className="text-base font-bold mt-0.5">
                  Details: {selectedTx.so_number}
                </h3>
              </div>
              <button
                onClick={() => setSelectedTx(null)}
                className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-slate-300 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-3.5 text-xs">
              {/* IDR Order Notice */}
              {selectedTx.sale_currency === 'IDR' ? (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-1.5">
                  <div className="flex items-center gap-2 text-slate-900 font-bold text-xs">
                    <CheckCircle2 className="w-4 h-4 text-blue-600 flex-shrink-0" />
                    Domestic IDR Customer Sale — Commercial FX Impact is N/A
                  </div>
                  <p className="text-[11px] text-slate-600 leading-relaxed">
                    This order (<strong>{selectedTx.so_number}</strong>) was quoted and invoiced in domestic Indonesian Rupiah (<strong>Rp {fmt(selectedTx.idr_sales_value)}</strong>).
                    It bears zero USD customer FX exposure. Any supplier import FX is tracked separately in the purchase accounting flow.
                  </p>
                </div>
              ) : null}

              {/* 4-Section Structured Grid matching user spec */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* 1. SALES */}
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                  <div className="flex items-center justify-between font-bold text-slate-800 border-b border-slate-200 pb-1">
                    <span className="uppercase text-[11px] tracking-wide text-blue-700">Sales</span>
                    {onViewSalesOrder && (
                      <button onClick={() => onViewSalesOrder(selectedTx.so_id)} className="text-blue-600 hover:underline flex items-center gap-0.5 text-[11px]">
                        Open SO <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1 pt-0.5">
                    <div>SO Number: <strong className="text-slate-800">{selectedTx.so_number}</strong></div>
                    <div>SO Date: <span className="text-slate-700">{fmtDate(selectedTx.so_date)}</span></div>
                    <div>Customer: <span className="text-slate-700">{selectedTx.customer_name}</span></div>
                    <div>Product: <span className="text-slate-700">{selectedTx.product_name}</span></div>
                    <div>Quantity: <span className="text-slate-700">{fmt(selectedTx.so_quantity)} {selectedTx.product_unit}</span></div>
                    <div>Currency: <strong className="text-slate-900">{selectedTx.sale_currency}</strong></div>
                    {selectedTx.sale_currency === 'USD' ? (
                      <>
                        <div>USD Amount: <strong className="text-blue-900">{fmtUsd(selectedTx.usd_sales_amount)}</strong></div>
                        <div>Sell Rate: <strong className="text-blue-900">{selectedTx.so_rate ? `Rp ${fmt(selectedTx.so_rate)}` : 'Missing'}</strong></div>
                        <div>Commercial IDR: <span className="text-slate-700">{selectedTx.idr_commercial_equivalent ? `Rp ${fmt(selectedTx.idr_commercial_equivalent)}` : '—'}</span></div>
                        <div>Invoiced IDR: <span className="text-slate-700">{selectedTx.actual_invoiced_idr ? `Rp ${fmt(selectedTx.actual_invoiced_idr)}` : '—'}</span></div>
                      </>
                    ) : (
                      <div>IDR Value: <strong className="text-slate-900">Rp {fmt(selectedTx.idr_sales_value)}</strong></div>
                    )}
                  </div>
                </div>

                {/* 2. SUPPLIER SETTLEMENT */}
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                  <div className="flex items-center justify-between font-bold text-slate-800 border-b border-slate-200 pb-1">
                    <span className="uppercase text-[11px] tracking-wide text-emerald-700">Supplier Settlement</span>
                    {selectedTx.pv_id && onViewPayment && (
                      <button onClick={() => onViewPayment(selectedTx.pv_id!)} className="text-blue-600 hover:underline flex items-center gap-0.5 text-[11px]">
                        Open PV <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  {selectedTx.sale_currency === 'IDR' ? (
                    <div className="text-slate-500 italic py-2">
                      Supplier payment vouchers are tracked separately in the purchase accounting flow.
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-1 pt-0.5">
                      <div>Supplier: <span className="text-slate-700">{selectedTx.supplier_name}</span></div>
                      <div>PI Number: <span className="text-slate-700">{selectedTx.pi_number || 'Unlinked'}</span></div>
                      <div>Payment Voucher: <strong className="text-slate-800">{selectedTx.pv_number || 'Pending'}</strong></div>
                      <div>Voucher Date: <span className="text-slate-700">{fmtDate(selectedTx.pv_date)}</span></div>
                      <div>USD Settled: <strong className="text-slate-900">{fmtUsd(selectedTx.usd_settled)}</strong></div>
                      <div>Payment Rate: <strong className="text-emerald-800">{selectedTx.payment_rate ? `Rp ${fmt(selectedTx.payment_rate)}` : 'Pending'}</strong></div>
                      <div>Actual IDR Paid: <span className="text-slate-700">{selectedTx.idr_supplier_payment > 0 ? `Rp ${fmt(selectedTx.idr_supplier_payment)}` : '—'}</span></div>
                      <div>Status: <span className="font-semibold text-slate-800">{selectedTx.settlement_status}</span></div>
                    </div>
                  )}
                </div>

                {/* 3. TRACE */}
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                  <div className="flex items-center justify-between font-bold text-slate-800 border-b border-slate-200 pb-1">
                    <span className="uppercase text-[11px] tracking-wide text-slate-700">Trace</span>
                    {selectedTx.pi_id && onViewInvoice && (
                      <button onClick={() => onViewInvoice(selectedTx.pi_id!)} className="text-blue-600 hover:underline flex items-center gap-0.5 text-[11px]">
                        Open PI <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1 pt-0.5">
                    <div>Batch: <span className="font-mono text-slate-800">{selectedTx.batch_number || '—'}</span></div>
                    <div>Sales Invoice: <span className="text-slate-700">{selectedTx.si_number || '—'}</span></div>
                    <div>Purchase Invoice: <span className="text-slate-700">{selectedTx.pi_number || '—'}</span></div>
                    <div>Import Rate: <span className="text-slate-700">{selectedTx.import_rate && selectedTx.import_rate > 1 ? `Rp ${fmt(selectedTx.import_rate)}` : '—'}</span></div>
                  </div>
                </div>

                {/* 4. CALCULATION */}
                <div className={`p-3 rounded-xl border space-y-1.5 ${
                  selectedTx.sale_currency === 'IDR'
                    ? 'bg-slate-50 border-slate-200'
                    : selectedTx.fx_impact_so_payment !== null && selectedTx.fx_impact_so_payment >= 0
                    ? 'bg-emerald-50/60 border-emerald-200'
                    : selectedTx.fx_impact_so_payment !== null
                    ? 'bg-rose-50/60 border-rose-200'
                    : 'bg-slate-50 border-slate-200'
                }`}>
                  <div className="font-bold text-slate-800 border-b border-slate-200 pb-1 uppercase text-[11px] tracking-wide">
                    Calculation
                  </div>
                  {selectedTx.sale_currency === 'IDR' ? (
                    <div className="text-slate-500 italic py-2">
                      FX Impact is N/A for domestic IDR sales.
                    </div>
                  ) : (
                    <div className="space-y-1 pt-0.5">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Sell Rate:</span>
                        <strong className="text-blue-900">{selectedTx.so_rate ? `Rp ${fmt(selectedTx.so_rate)}` : 'Missing'}</strong>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Payment Rate:</span>
                        <strong className="text-emerald-900">{selectedTx.payment_rate ? `Rp ${fmt(selectedTx.payment_rate)}` : 'Pending'}</strong>
                      </div>
                      <div className="flex justify-between pt-0.5 border-t border-slate-200">
                        <span className="text-slate-600 font-semibold">Rate Difference:</span>
                        <strong className={selectedTx.rate_diff_so_payment !== null && selectedTx.rate_diff_so_payment >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                          {selectedTx.rate_diff_so_payment !== null ? `${selectedTx.rate_diff_so_payment >= 0 ? '+' : ''}Rp ${fmt(selectedTx.rate_diff_so_payment)} / USD` : '—'}
                        </strong>
                      </div>
                      <div className="flex justify-between items-center pt-1 border-t border-slate-200">
                        <span className="font-bold text-slate-800">FX Impact:</span>
                        <span className={`text-sm font-black ${
                          selectedTx.fx_impact_so_payment !== null
                            ? selectedTx.fx_impact_so_payment >= 0 ? 'text-emerald-700' : 'text-rose-700'
                            : 'text-slate-400'
                        }`}>
                          {selectedTx.fx_impact_so_payment !== null ? `${selectedTx.fx_impact_so_payment >= 0 ? '+' : ''}Rp ${fmt(selectedTx.fx_impact_so_payment)}` : 'Pending'}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Multi-Payment Table (if multiple payments) */}
              {selectedTx.is_multiple_payments && selectedTx.all_payments && selectedTx.all_payments.length > 1 && (
                <div className="bg-white border border-indigo-200 rounded-xl p-3 shadow-xs">
                  <h4 className="text-[11px] font-bold text-indigo-900 uppercase tracking-wider mb-2">
                    Payment Voucher Allocations ({selectedTx.all_payments.length} Payments)
                  </h4>
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b text-slate-500 font-semibold">
                        <th className="py-1.5">Voucher</th>
                        <th className="py-1.5">Date</th>
                        <th className="py-1.5 text-right">Payment Rate</th>
                        <th className="py-1.5 text-right">USD Amount</th>
                        <th className="py-1.5 text-right">IDR Paid</th>
                        <th className="py-1.5 text-right">FX Impact</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedTx.all_payments.map((p, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="py-1.5 font-bold text-slate-800">{p.pv_number}</td>
                          <td className="py-1.5 text-slate-500">{fmtDate(p.pv_date)}</td>
                          <td className="py-1.5 text-right font-semibold text-emerald-800">
                            {p.is_real_fx ? `Rp ${fmt(p.rate)}` : '1.00'}
                          </td>
                          <td className="py-1.5 text-right font-medium">{fmtUsd(p.usd_amount)}</td>
                          <td className="py-1.5 text-right text-slate-600">
                            {p.is_real_fx ? `Rp ${fmt(p.idr_paid)}` : '—'}
                          </td>
                          <td className="py-1.5 text-right font-bold">
                            {p.impact !== null ? (
                              <span className={p.impact >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                                {p.impact >= 0 ? '+' : ''}Rp {fmt(p.impact)}
                              </span>
                            ) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-2.5 bg-slate-50 border-t border-slate-200 flex items-center justify-end">
              <button
                onClick={() => setSelectedTx(null)}
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-semibold transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

