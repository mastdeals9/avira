import { supabase } from '../lib/supabase';
import {
  adaptProfitabilitySummaryResponse,
  adaptProductBatchesResponse,
  adaptBatchOrdersResponse,
  summarizeQuantitiesByUnit,
  type UnitQuantityTotal,
} from '../utils/salesProfitReportNormalizers';

// ─── Interfaces ──────────────────────────────────────────────────────────────

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
  cost_breakdown?: {
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
  layer_allocations?: Array<{
    layer_id?: string;
    pi_number?: string;
    receipt_date?: string;
    consumed_qty: number;
    unit_cost: number;
    cost: number;
  }>;
  expenses: Array<{
    id: string;
    voucher_number: string;
    category: string;
    total_amount: number;
    description: string;
    expense_date: string;
  }>;
}

export interface MonthlyProfitabilitySummaryRow {
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

export interface ReconciledSalesProfitabilityDataset {
  company: CompanyProfitabilitySummary;
  products: ProductProfitabilityRow[];
  monthly: MonthlyProfitabilitySummaryRow[];
  unitTotals: UnitQuantityTotal[];
  productsWithBatches: Array<{
    product: ProductProfitabilityRow;
    batches: BatchProfitabilityRow[];
  }>;
  batchOrdersMap: Map<string, OrderSaleRow[]>;
}

// ─── Concurrency Pool Helper ─────────────────────────────────────────────────

export async function asyncPool<T, R>(
  poolLimit: number,
  array: T[],
  iteratorFn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const ret: Promise<R>[] = [];
  const executing: Promise<any>[] = [];
  for (let i = 0; i < array.length; i++) {
    const item = array[i];
    const p = Promise.resolve().then(() => iteratorFn(item, i));
    ret.push(p);

    if (poolLimit <= array.length) {
      const e: Promise<any> = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

// ─── Shared Cost-Layer Allocation Resolver ────────────────────────────────────

interface RawSiiRecord {
  id: string;
  quantity: number;
  unit_price: number;
  cogs_unit_cost: number | null;
  cogs_total_cost: number | null;
  cogs_layer_allocations: any;
}

export function resolveAuthoritativeInvoiceItemCOGS(
  ord: OrderSaleRow,
  sii: RawSiiRecord | undefined,
  batchCostPerUnit: number | null
): {
  unitCost: number;
  lineCost: number;
  allocations: Array<{
    layer_id?: string;
    pi_number?: string;
    receipt_date?: string;
    consumed_qty: number;
    unit_cost: number;
    cost: number;
  }>;
} {
  const qty = Number(ord.quantity || 0);

  // 1. Check for explicit cogs_layer_allocations
  let rawAllocs: any[] = [];
  if (sii?.cogs_layer_allocations) {
    if (Array.isArray(sii.cogs_layer_allocations)) {
      rawAllocs = sii.cogs_layer_allocations;
    } else if (typeof sii.cogs_layer_allocations === 'string') {
      try {
        const parsed = JSON.parse(sii.cogs_layer_allocations);
        if (Array.isArray(parsed)) rawAllocs = parsed;
      } catch {
        // ignore parse error
      }
    }
  }

  if (rawAllocs.length > 0) {
    let totalAllocCost = 0;
    const cleanAllocs = rawAllocs.map((a: any) => {
      const cQty = Number(a.consumed_qty || a.quantity || 0);
      const uCost = Number(a.unit_cost || a.final_functional_unit_cost || 0);
      const cCost = Number(a.cost != null ? a.cost : cQty * uCost);
      totalAllocCost += cCost;
      return {
        layer_id: a.layer_id,
        pi_number: a.pi_number,
        receipt_date: a.receipt_date,
        consumed_qty: cQty,
        unit_cost: uCost,
        cost: cCost,
      };
    });

    if (totalAllocCost > 0) {
      const uCost = qty > 0 ? totalAllocCost / qty : cleanAllocs[0].unit_cost;
      return {
        unitCost: Math.round(uCost * 10000) / 10000,
        lineCost: Math.round(totalAllocCost * 100) / 100,
        allocations: cleanAllocs,
      };
    }
  }

  // 2. Check for exact cogs_total_cost snapshot on the item
  if (sii?.cogs_total_cost != null && Number(sii.cogs_total_cost) > 0) {
    const lCost = Number(sii.cogs_total_cost);
    const uCost = sii.cogs_unit_cost != null && Number(sii.cogs_unit_cost) > 0
      ? Number(sii.cogs_unit_cost)
      : (qty > 0 ? lCost / qty : 0);

    return {
      unitCost: Math.round(uCost * 10000) / 10000,
      lineCost: Math.round(lCost * 100) / 100,
      allocations: [],
    };
  }

  // 3. Fallback to ord.line_cost / ord.unit_cost if valid
  if (ord.line_cost != null && Number(ord.line_cost) > 0) {
    const lCost = Number(ord.line_cost);
    const uCost = ord.unit_cost != null && Number(ord.unit_cost) > 0
      ? Number(ord.unit_cost)
      : (qty > 0 ? lCost / qty : 0);

    return {
      unitCost: Math.round(uCost * 10000) / 10000,
      lineCost: Math.round(lCost * 100) / 100,
      allocations: [],
    };
  }

  // 4. Fallback to batch authoritative cost per unit
  if (batchCostPerUnit != null && batchCostPerUnit > 0) {
    return {
      unitCost: batchCostPerUnit,
      lineCost: Math.round(qty * batchCostPerUnit * 100) / 100,
      allocations: [],
    };
  }

  return {
    unitCost: 0,
    lineCost: 0,
    allocations: [],
  };
}

// ─── Canonical Sales Profitability Loader & Reconciler ───────────────────────

export async function fetchCanonicalSalesProfitability(options: {
  startDate: string;
  endDate: string;
  onProgress?: (step: string, pct: number) => void;
}): Promise<ReconciledSalesProfitabilityDataset> {
  const { startDate, endDate, onProgress } = options;

  onProgress?.('Fetching sales profitability summary & inventory stock...', 10);

  // 1. Fetch Profitability Summary & Canonical Stock
  const [{ data: summaryRes, error: summaryErr }, { data: stockData, error: stockErr }] =
    await Promise.all([
      supabase.rpc('get_sales_profitability_summary', {
        p_start_date: startDate,
        p_end_date: endDate,
      }),
      supabase
        .from('inventory_v1_stock_summary')
        .select('product_id, total_current_stock, reserved_stock, available_quantity'),
    ]);

  if (summaryErr) {
    throw new Error(`Failed to load sales profitability summary: ${summaryErr.message}`);
  }
  if (stockErr) {
    console.warn('Could not load inventory_v1_stock_summary:', stockErr);
  }

  const stockMap = new Map<string, { current: number; reserved: number; available: number }>();
  (stockData || []).forEach((row: any) => {
    stockMap.set(row.product_id, {
      current: Number(row.total_current_stock ?? 0),
      reserved: Number(row.reserved_stock ?? 0),
      available: Number(row.available_quantity ?? 0),
    });
  });

  const adaptedSummary = adaptProfitabilitySummaryResponse(summaryRes, stockMap);
  const rawCompany = adaptedSummary.company;
  const rawProducts = adaptedSummary.products as ProductProfitabilityRow[];

  onProgress?.('Fetching batch breakdowns for all products...', 25);

  // 2. Fetch batches for each product (RPC returns a JSON array directly)
  interface ProductWithBatches {
    product: ProductProfitabilityRow;
    batches: BatchProfitabilityRow[];
  }

  let batchesCompleted = 0;
  const productsWithBatches: ProductWithBatches[] = await asyncPool(
    6,
    rawProducts,
    async (prod) => {
      const { data: bData, error: bErr } = await supabase.rpc(
        'get_sales_profitability_product_batches',
        {
          p_product_id: prod.product_id,
          p_start_date: startDate,
          p_end_date: endDate,
        }
      );
      batchesCompleted++;
      const pct = 25 + Math.round((batchesCompleted / (rawProducts.length || 1)) * 25);
      onProgress?.(`Fetching batch details (${batchesCompleted}/${rawProducts.length})...`, pct);

      if (bErr) {
        throw new Error(`Failed to load batches for ${prod.product_code || prod.product_name}: ${bErr.message}`);
      }
      const normalizedBatches = adaptProductBatchesResponse(
        bData,
        prod.product_code || prod.product_name
      ) as BatchProfitabilityRow[];

      return {
        product: prod,
        batches: normalizedBatches,
      };
    }
  );

  // 3. Collect all batches
  interface BatchTask {
    product: ProductProfitabilityRow;
    batch: BatchProfitabilityRow;
  }
  const batchTasks: BatchTask[] = [];
  productsWithBatches.forEach((pb) => {
    pb.batches.forEach((b) => {
      batchTasks.push({ product: pb.product, batch: b });
    });
  });

  onProgress?.(`Fetching invoice orders for ${batchTasks.length} batches...`, 50);

  // 4. Fetch orders for all batches (RPC returns a JSON array directly)
  interface BatchWithOrders {
    product: ProductProfitabilityRow;
    batch: BatchProfitabilityRow;
    orders: OrderSaleRow[];
  }

  let ordersCompleted = 0;
  const batchesWithOrders: BatchWithOrders[] = await asyncPool(
    6,
    batchTasks,
    async (task) => {
      const { data: oData, error: oErr } = await supabase.rpc(
        'get_sales_profitability_batch_orders',
        {
          p_batch_id: task.batch.batch_id,
          p_start_date: startDate,
          p_end_date: endDate,
        }
      );
      ordersCompleted++;
      const pct = 50 + Math.round((ordersCompleted / (batchTasks.length || 1)) * 25);
      onProgress?.(`Fetching invoice order details (${ordersCompleted}/${batchTasks.length})...`, pct);

      if (oErr) {
        throw new Error(`Failed to load invoice lines for batch ${task.batch.batch_number}: ${oErr.message}`);
      }
      const ordersList = adaptBatchOrdersResponse(oData, task.batch.batch_number) as OrderSaleRow[];
      return {
        product: task.product,
        batch: task.batch,
        orders: ordersList,
      };
    }
  );

  onProgress?.('Fetching authoritative purchase cost layers for invoice items...', 76);

  // 5. Collect all line_ids to fetch cogs_layer_allocations and cogs_total_cost from sales_invoice_items
  const allLineIds: string[] = [];
  batchesWithOrders.forEach((bwo) => {
    bwo.orders.forEach((ord) => {
      if (ord.line_id) allLineIds.push(ord.line_id);
    });
  });

  const siiMap = new Map<string, RawSiiRecord>();
  if (allLineIds.length > 0) {
    const chunkSize = 200;
    for (let i = 0; i < allLineIds.length; i += chunkSize) {
      const chunk = allLineIds.slice(i, i + chunkSize);
      const { data: siiRows, error: siiErr } = await supabase
        .from('sales_invoice_items')
        .select('id, quantity, unit_price, cogs_unit_cost, cogs_total_cost, cogs_layer_allocations')
        .in('id', chunk);

      if (siiErr) {
        console.warn('Could not fetch sales_invoice_items cost layers:', siiErr);
      } else {
        (siiRows || []).forEach((row: any) => {
          siiMap.set(row.id, row);
        });
      }
    }
  }

  onProgress?.('Fetching approved credit notes for return reconciliation...', 80);

  // 5b. Fetch approved credit notes in [startDate, endDate] so product, batch, monthly, and company views reconcile identically
  const { data: cnRows, error: cnErr } = await supabase
    .from('credit_notes')
    .select(
      'id, credit_note_number, credit_note_date, credit_note_type, subtotal, credit_note_items(id, product_id, batch_id, original_invoice_item_id, quantity, total_price)'
    )
    .eq('status', 'approved')
    .gte('credit_note_date', startDate)
    .lte('credit_note_date', endDate);

  if (cnErr) {
    console.warn('Could not fetch approved credit notes for reconciliation:', cnErr);
  }

  // Also fetch unallocated approved sales expenses by month if any exist
  const { data: unallocRows } = await supabase
    .from('finance_expenses')
    .select('expense_date, amount, expense_category')
    .eq('approval_status', 'approved')
    .gte('expense_date', startDate)
    .lte('expense_date', endDate)
    .is('batch_id', null)
    .is('import_container_id', null)
    .is('delivery_challan_id', null)
    .is('sales_order_id', null)
    .is('linked_sales_invoice_id', null);

  onProgress?.('Reconciling cost-layer profitability across batches and products...', 82);

  // 6. Resolve every order line with authoritative layer allocations and compute exact financials
  const batchOrdersMap = new Map<string, OrderSaleRow[]>();
  const lineUnitCostMap = new Map<string, { unitCost: number; batchId: string }>();

  batchesWithOrders.forEach((bwo) => {
    const resolvedOrders = bwo.orders.map((ord) => {
      const sii = siiMap.get(ord.line_id);
      const costResolution = resolveAuthoritativeInvoiceItemCOGS(ord, sii, bwo.batch.cost_per_unit);

      const qty = Number(ord.quantity || 0);
      const sellPrice = Number(ord.selling_price || 0);
      const grossSales = Math.round(qty * sellPrice * 100) / 100;
      const lineCost = costResolution.lineCost;
      const unitCost = costResolution.unitCost;
      const salesExp = Number(ord.line_sales_expense || 0);
      const netRealization = Math.round((grossSales - salesExp) * 100) / 100;
      const grossProfit = Math.round((grossSales - lineCost) * 100) / 100;
      const netProfit = Math.round((grossProfit - salesExp) * 100) / 100;
      const marginPct = grossSales > 0 ? (netProfit / grossSales) * 100 : null;

      if (ord.line_id) {
        lineUnitCostMap.set(ord.line_id, { unitCost, batchId: bwo.batch.batch_id });
      }

      return {
        ...ord,
        gross_sales: grossSales,
        unit_cost: unitCost,
        line_cost: lineCost,
        line_sales_expense: salesExp,
        net_selling_realization: netRealization,
        gross_profit: grossProfit,
        profit: netProfit,
        profit_margin_pct: marginPct != null ? Math.round(marginPct * 100) / 100 : null,
        layer_allocations: costResolution.allocations,
      };
    });

    batchOrdersMap.set(bwo.batch.batch_id, resolvedOrders);
  });

  // Aggregate credit note deductions by product, batch, and month
  const prodReturnMap = new Map<string, { qty: number; revenue: number; cogs: number }>();
  const batchReturnMap = new Map<string, { qty: number; revenue: number; cogs: number }>();
  const monthReturnMap = new Map<string, { qty: number; revenue: number; cogs: number }>();

  const rawReturnCogsTotal = Number(rawCompany.return_cogs || 0);
  const rawProdReturnMap = new Map<string, { qty: number; revenue: number; cogs: number }>();
  rawProducts.forEach((rp) => {
    // Capture RPC product-level return deltas as fallback when credit note items lack original_invoice_item_id
    rawProdReturnMap.set(rp.product_id, {
      qty: Number(rp.sold_qty || 0),
      revenue: Number(rp.gross_sales || 0),
      cogs: Number(rp.product_cost || 0),
    });
  });

  let totalCnRevenue = 0;
  let totalCnCogs = 0;

  (cnRows || []).forEach((cn: any) => {
    const isCommercial = cn.credit_note_type === 'commercial_credit';
    const monthKey = String(cn.credit_note_date || '').slice(0, 7);
    const items: any[] = Array.isArray(cn.credit_note_items) ? cn.credit_note_items : [];
    items.forEach((cni) => {
      const pid = cni.product_id as string;
      const qty = isCommercial ? 0 : Number(cni.quantity || 0);
      const rev = Number(cni.total_price || 0);
      const linked = cni.original_invoice_item_id ? lineUnitCostMap.get(cni.original_invoice_item_id) : undefined;
      const batchId = (cni.batch_id as string | undefined) || linked?.batchId;
      const unitCogs = linked?.unitCost ?? 0;
      const cogs = isCommercial ? 0 : Math.round(qty * unitCogs * 100) / 100;

      totalCnRevenue += rev;
      totalCnCogs += cogs;

      if (pid) {
        const cur = prodReturnMap.get(pid) || { qty: 0, revenue: 0, cogs: 0 };
        cur.qty += qty;
        cur.revenue += rev;
        cur.cogs += cogs;
        prodReturnMap.set(pid, cur);
      }
      if (batchId) {
        const cur = batchReturnMap.get(batchId) || { qty: 0, revenue: 0, cogs: 0 };
        cur.qty += qty;
        cur.revenue += rev;
        cur.cogs += cogs;
        batchReturnMap.set(batchId, cur);
      }
      if (monthKey) {
        const cur = monthReturnMap.get(monthKey) || { qty: 0, revenue: 0, cogs: 0 };
        cur.qty += qty;
        cur.revenue += rev;
        cur.cogs += cogs;
        monthReturnMap.set(monthKey, cur);
      }
    });
  });

  // 7. Reconcile batches: ensure batch totals match sum of reconciled invoice lines minus batch returns
  productsWithBatches.forEach((pb) => {
    pb.batches = pb.batches.map((b) => {
      const bOrders = batchOrdersMap.get(b.batch_id) || [];
      if (bOrders.length === 0) {
        return b;
      }

      let bSoldQty = 0;
      let bGrossSales = 0;
      let bProductCost = 0;
      let bSalesExp = 0;

      bOrders.forEach((o) => {
        bSoldQty += Number(o.quantity || 0);
        bGrossSales += Number(o.gross_sales || 0);
        bProductCost += Number(o.line_cost || 0);
        bSalesExp += Number(o.line_sales_expense || 0);
      });

      const bRet = batchReturnMap.get(b.batch_id);
      if (bRet) {
        bSoldQty -= bRet.qty;
        bGrossSales -= bRet.revenue;
        bProductCost -= bRet.cogs;
      }

      bSoldQty = Math.round(bSoldQty * 1000) / 1000;
      bGrossSales = Math.round(bGrossSales * 100) / 100;
      bProductCost = Math.round(bProductCost * 100) / 100;
      bSalesExp = Math.round(bSalesExp * 100) / 100;

      const bGrossProfit = Math.round((bGrossSales - bProductCost) * 100) / 100;
      const bNetProfit = Math.round((bGrossProfit - bSalesExp) * 100) / 100;
      const bAvgCost = bSoldQty > 0 ? Math.round((bProductCost / bSoldQty) * 10000) / 10000 : b.cost_per_unit;
      const bAvgPrice = bSoldQty > 0 ? Math.round((bGrossSales / bSoldQty) * 100) / 100 : 0;
      const bSalesExpPerUnit = bSoldQty > 0 ? Math.round((bSalesExp / bSoldQty) * 100) / 100 : 0;
      const bNetSellingPerUnit = bAvgPrice - bSalesExpPerUnit;
      const bProfitPerUnit = bSoldQty > 0 ? Math.round((bNetProfit / bSoldQty) * 100) / 100 : null;
      const bMargin = bGrossSales > 0 ? Math.round((bNetProfit / bGrossSales) * 10000) / 100 : null;

      return {
        ...b,
        sold_qty: bSoldQty,
        gross_sales: bGrossSales,
        product_cost: bProductCost,
        sales_expense: bSalesExp,
        gross_profit: bGrossProfit,
        profit_after_sales_expense: bNetProfit,
        cost_per_unit: bAvgCost,
        avg_selling_price: bAvgPrice,
        sales_expense_per_unit: bSalesExpPerUnit,
        net_selling_price_per_unit: bNetSellingPerUnit,
        profit_per_unit: bProfitPerUnit,
        profit_margin_pct: bMargin,
      };
    });
  });

  // 8. Reconcile products: sum of invoice lines minus product credit-note deductions
  //    (so Product Profitability matches on-screen CanonicalSalesProfitReport and Company Net Sales/COGS)
  const reconciledProducts: ProductProfitabilityRow[] = productsWithBatches.map((pb) => {
    const p = pb.product;
    const batches = pb.batches;

    if (batches.length === 0) {
      return p;
    }

    let pSoldQty = 0;
    let pGrossSales = 0;
    let pProductCost = 0;
    let pSalesExp = 0;

    batches.forEach((b) => {
      const bOrders = batchOrdersMap.get(b.batch_id) || [];
      if (bOrders.length > 0) {
        bOrders.forEach((o) => {
          pSoldQty += Number(o.quantity || 0);
          pGrossSales += Number(o.gross_sales || 0);
          pProductCost += Number(o.line_cost || 0);
          pSalesExp += Number(o.line_sales_expense || 0);
        });
      } else {
        pSoldQty += Number(b.sold_qty || 0);
        pGrossSales += Number(b.gross_sales || 0);
        pProductCost += Number(b.product_cost || 0);
        pSalesExp += Number(b.sales_expense || 0);
      }
    });

    const pRet = prodReturnMap.get(p.product_id);
    if (pRet) {
      pSoldQty -= pRet.qty;
      pGrossSales -= pRet.revenue;
      pProductCost -= pRet.cogs;
    }

    pSoldQty = Math.round(pSoldQty * 1000) / 1000;
    pGrossSales = Math.round(pGrossSales * 100) / 100;
    pProductCost = Math.round(pProductCost * 100) / 100;
    pSalesExp = Math.round(pSalesExp * 100) / 100;

    const pGrossProfit = Math.round((pGrossSales - pProductCost) * 100) / 100;
    const pNetProfit = Math.round((pGrossProfit - pSalesExp) * 100) / 100;
    const pAvgCost = pSoldQty > 0 ? Math.round((pProductCost / pSoldQty) * 10000) / 10000 : p.avg_landed_cost;
    const pAvgPrice = pSoldQty > 0 ? Math.round((pGrossSales / pSoldQty) * 100) / 100 : 0;
    const pSalesExpPerUnit = pSoldQty > 0 ? Math.round((pSalesExp / pSoldQty) * 100) / 100 : 0;
    const pNetSellingPerUnit = pAvgPrice - pSalesExpPerUnit;
    const pProfitPerUnit = pSoldQty > 0 ? Math.round((pNetProfit / pSoldQty) * 100) / 100 : null;
    const pMargin = pGrossSales > 0 ? Math.round((pNetProfit / pGrossSales) * 10000) / 100 : null;

    return {
      ...p,
      sold_qty: pSoldQty,
      gross_sales: pGrossSales,
      product_cost: pProductCost,
      sales_expense: pSalesExp,
      gross_profit: pGrossProfit,
      profit_after_sales_expense: pNetProfit,
      avg_landed_cost: pAvgCost,
      avg_selling_price: pAvgPrice,
      sales_expense_per_unit: pSalesExpPerUnit,
      net_selling_price_per_unit: pNetSellingPerUnit,
      profit_per_unit: pProfitPerUnit,
      profit_margin_pct: pMargin,
    };
  });

  // 9. Reconcile Executive KPI block from invoice lines + credit notes + unallocated expenses
  let sumLineGrossSales = 0;
  let sumLineCogs = 0;
  let sumProdSalesExp = 0;
  let sumProdQty = 0;

  batchesWithOrders.forEach((bwo) => {
    const resolved = batchOrdersMap.get(bwo.batch.batch_id) || [];
    resolved.forEach((o) => {
      sumLineGrossSales += Number(o.gross_sales || 0);
      sumLineCogs += Number(o.line_cost || 0);
    });
  });

  reconciledProducts.forEach((p) => {
    sumProdSalesExp += Number(p.sales_expense || 0);
    sumProdQty += Number(p.sold_qty || 0);
  });

  sumLineGrossSales = Math.round(sumLineGrossSales * 100) / 100;
  sumLineCogs = Math.round(sumLineCogs * 100) / 100;
  sumProdSalesExp = Math.round(sumProdSalesExp * 100) / 100;
  sumProdQty = Math.round(sumProdQty * 1000) / 1000;

  const salesReturns = cnRows ? Math.round(totalCnRevenue * 100) / 100 : Number(rawCompany.sales_returns || 0);
  const returnCogs = cnRows
    ? Math.round((totalCnCogs > 0 ? totalCnCogs : rawReturnCogsTotal) * 100) / 100
    : rawReturnCogsTotal;
  const netSales = Math.round((sumLineGrossSales - salesReturns) * 100) / 100;
  const netProductCost = Math.round((sumLineCogs - returnCogs) * 100) / 100;
  const unallocatedExp = Number(rawCompany.unallocated_sales_expenses || 0);
  const totalCompanySalesExp = Math.round((sumProdSalesExp + unallocatedExp) * 100) / 100;
  const companyGrossProfit = Math.round((netSales - netProductCost) * 100) / 100;
  const companyNetProfit = Math.round((companyGrossProfit - totalCompanySalesExp) * 100) / 100;
  const companyMarginPct = netSales > 0 ? Math.round((companyNetProfit / netSales) * 10000) / 100 : 0;

  // 10. Reconcile Monthly summary from the exact same invoice lines + credit notes + unallocated expenses
  const salesCategories = new Set([
    'delivery_sales',
    'loading_sales',
    'marketing_advertising',
    'other_sales',
    'sales_distribution',
    'freight_outward',
    'delivery_expense',
    'sales_commission',
    'travel_sales',
  ]);
  const monthUnallocMap = new Map<string, number>();
  (unallocRows || []).forEach((fe: any) => {
    if (!salesCategories.has(fe.expense_category)) return;
    const mk = String(fe.expense_date || '').slice(0, 7);
    if (mk) monthUnallocMap.set(mk, (monthUnallocMap.get(mk) || 0) + Number(fe.amount || 0));
  });

  const monthBuckets = new Map<
    string,
    {
      month_start: string;
      month_label: string;
      gross_sales: number;
      product_cost: number;
      sales_expenses: number;
      total_qty_sold: number;
      invoiceIds: Set<string>;
    }
  >();

  const ensureMonthBucket = (mk: string) => {
    if (!monthBuckets.has(mk)) {
      const [y, m] = mk.split('-').map(Number);
      const dt = new Date(Date.UTC(y || 2025, (m || 1) - 1, 1));
      const label = dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
      monthBuckets.set(mk, {
        month_start: `${mk}-01`,
        month_label: label,
        gross_sales: 0,
        product_cost: 0,
        sales_expenses: 0,
        total_qty_sold: 0,
        invoiceIds: new Set<string>(),
      });
    }
    return monthBuckets.get(mk)!;
  };

  batchesWithOrders.forEach((bwo) => {
    const resolved = batchOrdersMap.get(bwo.batch.batch_id) || [];
    resolved.forEach((o) => {
      const mk = String(o.invoice_date || '').slice(0, 7);
      if (!mk) return;
      const b = ensureMonthBucket(mk);
      b.gross_sales += Number(o.gross_sales || 0);
      b.product_cost += Number(o.line_cost || 0);
      b.sales_expenses += Number(o.line_sales_expense || 0);
      b.total_qty_sold += Number(o.quantity || 0);
      if (o.invoice_id) b.invoiceIds.add(o.invoice_id);
    });
  });

  monthReturnMap.forEach((mr, mk) => {
    const b = ensureMonthBucket(mk);
    b.gross_sales -= mr.revenue;
    b.product_cost -= mr.cogs;
    b.total_qty_sold -= mr.qty;
  });

  monthUnallocMap.forEach((amt, mk) => {
    if (amt > 0) {
      const b = ensureMonthBucket(mk);
      b.sales_expenses += amt;
    }
  });

  const reconciledMonthly: MonthlyProfitabilitySummaryRow[] =
    monthBuckets.size > 0
      ? Array.from(monthBuckets.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, b]) => {
            const mSales = Math.round(b.gross_sales * 100) / 100;
            const mCogs = Math.round(b.product_cost * 100) / 100;
            const mExp = Math.round(b.sales_expenses * 100) / 100;
            const mGP = Math.round((mSales - mCogs) * 100) / 100;
            const mNP = Math.round((mGP - mExp) * 100) / 100;
            return {
              month_label: b.month_label,
              month_start: b.month_start,
              gross_sales: mSales,
              product_cost: mCogs,
              sales_expenses: mExp,
              gross_profit: mGP,
              profit_after_sales_expenses: mNP,
              profit_margin_pct: mSales > 0 ? Math.round((mNP / mSales) * 10000) / 100 : 0,
              total_qty_sold: Math.round(b.total_qty_sold * 1000) / 1000,
              order_count: b.invoiceIds.size,
            };
          })
      : adaptedSummary.monthly;

  const reconciledCompany: CompanyProfitabilitySummary = {
    ...rawCompany,
    gross_sales: sumLineGrossSales,
    sales_returns: salesReturns,
    net_sales: netSales,
    product_cost: sumLineCogs,
    return_cogs: returnCogs,
    net_product_cost: netProductCost,
    sales_expenses: totalCompanySalesExp,
    unallocated_sales_expenses: unallocatedExp,
    gross_profit: companyGrossProfit,
    profit_after_sales_expenses: companyNetProfit,
    profit_margin_pct: companyMarginPct,
    total_qty_sold: sumProdQty,
    order_count: Number(rawCompany.order_count || 0),
    product_count: reconciledProducts.length,
  };

  const unitTotals = summarizeQuantitiesByUnit(
    reconciledProducts.map((p) => ({ unit: p.product_unit, quantity: p.sold_qty }))
  );

  return {
    company: reconciledCompany,
    products: reconciledProducts,
    monthly: reconciledMonthly,
    unitTotals,
    productsWithBatches,
    batchOrdersMap,
  };
}

export {
  normalizeProductProfitabilityRow,
  normalizeBatchProfitabilityRow,
  adaptProfitabilitySummaryResponse,
  adaptProductBatchesResponse,
  adaptBatchOrdersResponse,
  summarizeQuantitiesByUnit,
} from '../utils/salesProfitReportNormalizers';
