import { supabase } from '../lib/supabase';
import {
  adaptProfitabilitySummaryResponse,
  adaptProductBatchesResponse,
  adaptProductBatchEnvelope,
  adaptBatchOrdersResponse,
  summarizeQuantitiesByUnit,
  type BatchReturnDetail,
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
  has_unreported_cost?: boolean;
  unresolved_return_cogs_count?: number;
  return_cogs_allocation_mismatch_count?: number;
  credit_note_item_subtotal_mismatch_count?: number;
  has_unresolved_return_cogs?: boolean;
  has_credit_note_item_subtotal_mismatch?: boolean;
  profitability_certified?: boolean;
  certification_status?: string;
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
  batch_id: string | null;
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
  return_qty?: number;
  return_revenue?: number;
  return_cogs?: number | null;
  return_details?: BatchReturnDetail[];
  costed_lines?: number;
  total_lines?: number;
  unresolved_sales_cogs_count?: number;
  unresolved_return_cogs_count?: number;
  has_unreported_cost?: boolean;
  cost_coverage?: 'complete' | 'partial';
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
  sales_returns: number;
  net_sales: number;
  product_cost: number;
  sales_expenses: number;
  gross_profit: number;
  profit_after_sales_expenses: number;
  profit_margin_pct: number;
  total_qty_sold: number;
  order_count: number;
  has_unreported_cost?: boolean;
  unresolved_return_cogs_count?: number;
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
  _batchCostPerUnit?: number | null
): {
  unitCost: number | null;
  lineCost: number | null;
  unresolved: boolean;
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

  // Extract cogs_layer_allocations strictly as display metadata (never overrides saved snapshot)
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

  const cleanAllocs = rawAllocs.map((a: any) => {
    const cQty = Number(a.consumed_qty || a.quantity || 0);
    const uCost = Number(a.unit_cost || a.final_functional_unit_cost || 0);
    const cCost = Number(a.cost != null ? a.cost : cQty * uCost);
    return {
      layer_id: a.layer_id,
      pi_number: a.pi_number,
      receipt_date: a.receipt_date,
      consumed_qty: cQty,
      unit_cost: uCost,
      cost: cCost,
    };
  });

  // Priority 1: Saved posted invoice-line COGS total snapshot (sales_invoice_items.cogs_total_cost)
  if (sii?.cogs_total_cost != null && Number.isFinite(Number(sii.cogs_total_cost))) {
    const lCost = Number(sii.cogs_total_cost);
    const uCost = sii.cogs_unit_cost != null && Number.isFinite(Number(sii.cogs_unit_cost))
      ? Number(sii.cogs_unit_cost)
      : (qty > 0 ? lCost / qty : 0);

    return {
      unitCost: Math.round(uCost * 10000) / 10000,
      lineCost: Math.round(lCost * 100) / 100,
      unresolved: false,
      allocations: cleanAllocs,
    };
  }

  // Priority 2: Saved unit snapshot (sales_invoice_items.cogs_unit_cost * quantity)
  if (sii?.cogs_unit_cost != null && Number.isFinite(Number(sii.cogs_unit_cost))) {
    const uCost = Number(sii.cogs_unit_cost);
    const lCost = qty * uCost;
    return {
      unitCost: Math.round(uCost * 10000) / 10000,
      lineCost: Math.round(lCost * 100) / 100,
      unresolved: false,
      allocations: cleanAllocs,
    };
  }

  // Priority 3: Canonical RPC line_cost / unit_cost (authoritative database result only)
  if (ord.line_cost != null && Number.isFinite(Number(ord.line_cost))) {
    const lCost = Number(ord.line_cost);
    const uCost = ord.unit_cost != null && Number.isFinite(Number(ord.unit_cost))
      ? Number(ord.unit_cost)
      : (qty > 0 ? lCost / qty : 0);

    return {
      unitCost: Math.round(uCost * 10000) / 10000,
      lineCost: Math.round(lCost * 100) / 100,
      unresolved: false,
      allocations: cleanAllocs,
    };
  }

  // Fail closed: never fall back to current batch cost_per_unit / landed_cost_per_unit or return 0
  return {
    unitCost: null,
    lineCost: null,
    unresolved: true,
    allocations: cleanAllocs,
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

  // 2. Fetch batches for each product (RPC returns { product, batches } envelope)
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
      const envelope = adaptProductBatchEnvelope(
        bData,
        prod.product_code || prod.product_name
      );

      // Validate product-batch envelope rollup against canonical summary product within Rp0.05 and 0.001 qty
      if (envelope.product) {
        const ep = envelope.product;
        const qtyDiff = Math.abs(Number(ep.sold_qty || 0) - Number(prod.sold_qty || 0));
        const revDiff = Math.abs(Number(ep.gross_sales || 0) - Number(prod.gross_sales || 0));
        const expDiff = Math.abs(Number(ep.sales_expense || 0) - Number(prod.sales_expense || 0));
        const costDiff =
          ep.product_cost != null && prod.product_cost != null
            ? Math.abs(Number(ep.product_cost) - Number(prod.product_cost))
            : 0;

        if (qtyDiff > 0.001 || revDiff > 0.05 || expDiff > 0.05 || costDiff > 0.05) {
          throw new Error(
            `Profitability reconciliation mismatch for ${prod.product_name}: ` +
              `batch rollup (qty=${ep.sold_qty}, rev=${ep.gross_sales}, cost=${ep.product_cost}, exp=${ep.sales_expense}) ` +
              `vs summary (qty=${prod.sold_qty}, rev=${prod.gross_sales}, cost=${prod.product_cost}, exp=${prod.sales_expense}).`
          );
        }
      }

      return {
        product: prod,
        batches: envelope.batches as BatchProfitabilityRow[],
      };
    }
  );

  // 3. Collect all batches that have a non-null batch_id for invoice-line drilldown
  interface BatchTask {
    product: ProductProfitabilityRow;
    batch: BatchProfitabilityRow;
    batchId: string;
  }
  const batchTasks: BatchTask[] = [];
  productsWithBatches.forEach((pb) => {
    pb.batches.forEach((b) => {
      if (b.batch_id) {
        batchTasks.push({ product: pb.product, batch: b, batchId: b.batch_id });
      }
    });
  });

  onProgress?.(`Fetching invoice orders for ${batchTasks.length} batches...`, 50);

  // 4. Fetch orders for all batches (used strictly for invoice-line display, never overrides canonical totals)
  interface BatchWithOrders {
    product: ProductProfitabilityRow;
    batch: BatchProfitabilityRow;
    batchId: string;
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
          p_batch_id: task.batchId,
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
        batchId: task.batchId,
        orders: ordersList,
      };
    }
  );

  onProgress?.('Fetching display cost-layer metadata for invoice items...', 78);

  // 5. Fetch cogs_layer_allocations strictly for layer metadata display (does not alter canonical RPC financials)
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
        throw new Error(`Failed to fetch sales_invoice_items snapshots: ${siiErr.message}`);
      }
      (siiRows || []).forEach((row: any) => {
        siiMap.set(row.id, row);
      });
    }
  }

  onProgress?.('Finalizing canonical invoice line drilldown...', 85);

  // 6. Populate batchOrdersMap for invoice-line display only (fail closed if cost is unresolved)
  const batchOrdersMap = new Map<string, OrderSaleRow[]>();

  batchesWithOrders.forEach((bwo) => {
    const resolvedOrders = bwo.orders.map((ord) => {
      const sii = siiMap.get(ord.line_id);
      const costResolution = resolveAuthoritativeInvoiceItemCOGS(ord, sii);

      const qty = Number(ord.quantity || 0);
      const sellPrice = Number(ord.selling_price || 0);
      const grossSales = Number(ord.gross_sales ?? Math.round(qty * sellPrice * 100) / 100);
      const lineCost = costResolution.lineCost;
      const unitCost = costResolution.unitCost;
      const salesExp = Number(ord.line_sales_expense ?? 0);
      const netRealization = Math.round((grossSales - salesExp) * 100) / 100;
      const grossProfit = lineCost != null ? Math.round((grossSales - lineCost) * 100) / 100 : null;
      const netProfit = grossProfit != null ? Math.round((grossProfit - salesExp) * 100) / 100 : null;
      const marginPct = grossSales > 0 && netProfit != null ? Math.round((netProfit / grossSales) * 10000) / 100 : null;

      return {
        ...ord,
        gross_sales: grossSales,
        unit_cost: unitCost,
        line_cost: lineCost,
        line_sales_expense: salesExp,
        net_selling_realization: netRealization,
        gross_profit: grossProfit,
        profit: netProfit,
        profit_margin_pct: marginPct,
        layer_allocations: costResolution.allocations,
      };
    });

    batchOrdersMap.set(bwo.batchId, resolvedOrders);
  });

  // Canonical totals come directly from get_sales_profitability_summary & get_sales_profitability_product_batches
  const unitTotals = summarizeQuantitiesByUnit(
    rawProducts.map((p) => ({ unit: p.product_unit, quantity: p.sold_qty }))
  );

  return {
    company: rawCompany as CompanyProfitabilitySummary,
    products: rawProducts,
    monthly: adaptedSummary.monthly as MonthlyProfitabilitySummaryRow[],
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
  adaptProductBatchEnvelope,
  adaptBatchOrdersResponse,
  summarizeQuantitiesByUnit,
} from '../utils/salesProfitReportNormalizers';
