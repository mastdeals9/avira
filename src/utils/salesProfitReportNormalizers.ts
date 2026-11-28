// Normalization helpers for Sales Profitability reports and drill-downs

export interface NormalizedProductProfitabilityRow {
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

export interface BatchReturnDetail {
  credit_note_item_id: string;
  credit_note_number: string;
  credit_note_date: string;
  credit_note_type: string;
  quantity: number;
  return_qty: number;
  return_revenue: number;
  return_cogs: number | null;
  has_unresolved_cogs: boolean;
}

export interface NormalizedBatchProfitabilityRow {
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

export interface NormalizedOrderSaleRow {
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
  expenses: Array<{
    id: string;
    voucher_number: string;
    category: string;
    total_amount: number;
    description: string;
    expense_date: string;
  }>;
}

export function normalizeProductProfitabilityRow(
  raw: any,
  canonicalStock?: { current: number; reserved: number; available: number }
): NormalizedProductProfitabilityRow {
  const soldQty = Number(raw.sold_qty ?? raw.total_qty_sold ?? 0);
  const grossSales = Number(raw.gross_sales ?? raw.total_revenue ?? 0);
  const productCost = raw.product_cost != null
    ? Number(raw.product_cost)
    : (raw.total_cogs != null ? Number(raw.total_cogs) : null);
  const safeProductCost = productCost != null && productCost < 0 ? null : productCost;
  const salesExpense = Number(raw.sales_expense ?? raw.total_sales_expenses ?? raw.sales_expenses ?? 0);
  const grossProfit = raw.gross_profit != null
    ? Number(raw.gross_profit)
    : (safeProductCost != null ? grossSales - safeProductCost : null);
  const profitAfterExpense = raw.profit_after_sales_expense != null
    ? Number(raw.profit_after_sales_expense)
    : (raw.profit_after_sales_expenses != null
        ? Number(raw.profit_after_sales_expenses)
        : (grossProfit != null ? grossProfit - salesExpense : null));

  const avgLandedCost = raw.avg_landed_cost != null && raw.avg_landed_cost >= 0
    ? Number(raw.avg_landed_cost)
    : (safeProductCost != null && soldQty > 0 ? Number((safeProductCost / soldQty).toFixed(2)) : null);

  const avgSellingPrice = raw.avg_selling_price != null
    ? Number(raw.avg_selling_price)
    : (soldQty > 0 ? Number((grossSales / soldQty).toFixed(2)) : 0);

  const salesExpensePerUnit = raw.sales_expense_per_unit != null
    ? Number(raw.sales_expense_per_unit)
    : (soldQty > 0 ? Number((salesExpense / soldQty).toFixed(2)) : 0);

  const netSellingPricePerUnit = raw.net_selling_price_per_unit != null
    ? Number(raw.net_selling_price_per_unit)
    : (soldQty > 0 ? Number(((grossSales - salesExpense) / soldQty).toFixed(2)) : 0);

  const profitPerUnit = raw.profit_per_unit != null
    ? Number(raw.profit_per_unit)
    : (soldQty > 0 && profitAfterExpense != null ? Number((profitAfterExpense / soldQty).toFixed(2)) : null);

  const profitMarginPct = raw.profit_margin_pct != null
    ? Number(raw.profit_margin_pct)
    : (grossSales > 0 && profitAfterExpense != null ? Number(((profitAfterExpense / grossSales) * 100).toFixed(2)) : null);

  const currentStock = canonicalStock ? canonicalStock.current : Number(raw.current_stock || 0);
  const reservedStock = canonicalStock ? canonicalStock.reserved : Number(raw.reserved_stock || 0);
  const availableStock = canonicalStock ? canonicalStock.available : (raw.available_stock ?? (currentStock - reservedStock));

  return {
    product_id: raw.product_id,
    product_name: raw.product_name,
    product_code: raw.product_code || '',
    product_unit: raw.product_unit || 'kg',
    current_stock: currentStock,
    reserved_stock: reservedStock,
    available_stock: availableStock,
    sold_qty: soldQty,
    gross_sales: grossSales,
    product_cost: safeProductCost,
    sales_expense: salesExpense,
    gross_profit: grossProfit,
    profit_after_sales_expense: profitAfterExpense,
    avg_landed_cost: avgLandedCost,
    avg_selling_price: avgSellingPrice,
    sales_expense_per_unit: salesExpensePerUnit,
    net_selling_price_per_unit: netSellingPricePerUnit,
    profit_per_unit: profitPerUnit,
    profit_margin_pct: profitMarginPct,
    costed_lines: Number(raw.costed_lines ?? 0),
    total_lines: Number(raw.total_lines ?? 0),
    has_unreported_cost: Boolean(raw.has_unreported_cost),
  };
}

export function normalizeBatchProfitabilityRow(raw: any): NormalizedBatchProfitabilityRow {
  const soldQty = Number(raw.sold_qty ?? raw.quantity_sold ?? 0);
  const grossSales = Number(raw.gross_sales ?? 0);
  const productCost = raw.product_cost != null ? Number(raw.product_cost) : null;
  const salesExpense = Number(raw.sales_expense ?? raw.sales_expenses ?? 0);
  const grossProfit = raw.gross_profit != null
    ? Number(raw.gross_profit)
    : (productCost != null ? grossSales - productCost : null);
  const profitAfterExpense = raw.profit_after_sales_expense != null
    ? Number(raw.profit_after_sales_expense)
    : (raw.net_profit != null
        ? Number(raw.net_profit)
        : (grossProfit != null ? grossProfit - salesExpense : null));

  const costPerUnit = raw.cost_per_unit != null
    ? Number(raw.cost_per_unit)
    : (raw.landed_cost_per_unit != null
        ? Number(raw.landed_cost_per_unit)
        : (raw.authoritative_unit_cogs != null
            ? Number(raw.authoritative_unit_cogs)
            : (productCost != null && soldQty > 0 ? Number((productCost / soldQty).toFixed(2)) : null)));

  const avgSellingPrice = raw.avg_selling_price != null
    ? Number(raw.avg_selling_price)
    : (soldQty > 0 ? Number((grossSales / soldQty).toFixed(2)) : 0);

  const salesExpensePerUnit = raw.sales_expense_per_unit != null
    ? Number(raw.sales_expense_per_unit)
    : (soldQty > 0 ? Number((salesExpense / soldQty).toFixed(2)) : 0);

  const netSellingPricePerUnit = raw.net_selling_price_per_unit != null
    ? Number(raw.net_selling_price_per_unit)
    : (soldQty > 0 ? Number(((grossSales - salesExpense) / soldQty).toFixed(2)) : 0);

  const profitPerUnit = raw.profit_per_unit != null
    ? Number(raw.profit_per_unit)
    : (soldQty > 0 && profitAfterExpense != null ? Number((profitAfterExpense / soldQty).toFixed(2)) : null);

  const profitMarginPct = raw.profit_margin_pct != null
    ? Number(raw.profit_margin_pct)
    : (raw.margin_percentage != null
        ? Number(raw.margin_percentage)
        : (grossSales > 0 && profitAfterExpense != null ? Number(((profitAfterExpense / grossSales) * 100).toFixed(2)) : null));

  const isImported = Boolean(
    raw.is_imported ??
    raw.cost_breakdown?.is_imported ??
    (raw.import_price != null && Number(raw.import_price) > 0) ??
    (raw.import_price_usd != null && Number(raw.import_price_usd) > 0)
  );

  const costBreakdown = raw.cost_breakdown ?? {
    is_imported: isImported,
    import_price: raw.import_price != null ? Number(raw.import_price) : null,
    import_price_usd: raw.import_price_usd != null ? Number(raw.import_price_usd) : null,
    exchange_rate: raw.exchange_rate_usd_to_idr != null ? Number(raw.exchange_rate_usd_to_idr) : (raw.exchange_rate != null ? Number(raw.exchange_rate) : null),
    duty_charges: raw.duty_charges != null ? Number(raw.duty_charges) : null,
    freight_charges: raw.freight_charges != null ? Number(raw.freight_charges) : null,
    other_charges: raw.other_charges != null ? Number(raw.other_charges) : null,
    landed_cost_per_unit: raw.landed_cost_per_unit != null ? Number(raw.landed_cost_per_unit) : null,
    local_cost_per_unit: raw.cost_per_unit != null ? Number(raw.cost_per_unit) : null,
  };

  return {
    batch_id: raw.batch_id ?? null,
    batch_number: raw.batch_number || 'Unassigned Batch',
    current_stock: Number(raw.current_stock ?? 0),
    sold_qty: soldQty,
    cost_per_unit: costPerUnit,
    gross_sales: grossSales,
    product_cost: productCost,
    sales_expense: salesExpense,
    gross_profit: grossProfit,
    profit_after_sales_expense: profitAfterExpense,
    avg_selling_price: avgSellingPrice,
    sales_expense_per_unit: salesExpensePerUnit,
    net_selling_price_per_unit: netSellingPricePerUnit,
    profit_per_unit: profitPerUnit,
    profit_margin_pct: profitMarginPct,
    is_imported: isImported,
    return_qty: Number(raw.return_qty ?? 0),
    return_revenue: Number(raw.return_revenue ?? 0),
    return_cogs: raw.return_cogs != null ? Number(raw.return_cogs) : (raw.resolved_return_cogs != null ? Number(raw.resolved_return_cogs) : null),
    return_details: Array.isArray(raw.return_details) ? raw.return_details : [],
    costed_lines: Number(raw.costed_lines ?? 0),
    total_lines: Number(raw.total_lines ?? 0),
    unresolved_sales_cogs_count: Number(raw.unresolved_sales_cogs_count ?? 0),
    unresolved_return_cogs_count: Number(raw.unresolved_return_cogs_count ?? 0),
    has_unreported_cost: Boolean(raw.has_unreported_cost),
    cost_coverage: raw.cost_coverage === 'partial' ? 'partial' : 'complete',
    cost_breakdown: costBreakdown,
  };
}

export interface UnitQuantityTotal {
  unit: string;
  quantity: number;
}

export function summarizeQuantitiesByUnit(
  items: Array<{ unit?: string | null; quantity: number }>
): UnitQuantityTotal[] {
  const map = new Map<string, number>();
  for (const item of items) {
    const unit = (item.unit || 'kg').trim().toLowerCase();
    const prev = map.get(unit) ?? 0;
    map.set(unit, Math.round((prev + Number(item.quantity || 0)) * 1000) / 1000);
  }
  return Array.from(map.entries()).map(([unit, quantity]) => ({ unit, quantity }));
}

function assertFiniteNumber(value: unknown, fieldName: string): number {
  if (value === null || value === undefined || value === '') {
    throw new Error(`Invalid profitability RPC response: missing required numeric field "${fieldName}"`);
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid profitability RPC response: field "${fieldName}" is not a finite number`);
  }
  return num;
}

export function adaptProfitabilitySummaryResponse(
  raw: unknown,
  stockMap?: Map<string, { current: number; reserved: number; available: number }>
): {
  company: {
    gross_sales: number;
    sales_returns: number;
    net_sales: number;
    product_cost: number;
    return_cogs: number;
    net_product_cost: number;
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
  };
  products: NormalizedProductProfitabilityRow[];
  monthly: Array<{
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
  }>;
} {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid profitability summary response: expected a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (!obj.company || typeof obj.company !== 'object') {
    throw new Error('Invalid profitability summary response: missing "company" object');
  }
  if (!Array.isArray(obj.products)) {
    throw new Error('Invalid profitability summary response: missing "products" array');
  }

  const c = obj.company as Record<string, unknown>;
  const grossSales = assertFiniteNumber(c.gross_sales, 'company.gross_sales');
  const productCost = assertFiniteNumber(c.product_cost, 'company.product_cost');
  const salesExpenses = assertFiniteNumber(c.sales_expenses, 'company.sales_expenses');
  const grossProfit = assertFiniteNumber(c.gross_profit, 'company.gross_profit');
  const profitAfterExpenses = assertFiniteNumber(c.profit_after_sales_expenses, 'company.profit_after_sales_expenses');
  const orderCount = assertFiniteNumber(c.order_count, 'company.order_count');

  const salesReturns = c.sales_returns != null ? assertFiniteNumber(c.sales_returns, 'company.sales_returns') : 0;
  const returnCogs = c.return_cogs != null ? assertFiniteNumber(c.return_cogs, 'company.return_cogs') : 0;
  const netSales = c.net_sales != null ? assertFiniteNumber(c.net_sales, 'company.net_sales') : Math.round((grossSales - salesReturns) * 100) / 100;
  const netProductCost = c.net_product_cost != null ? assertFiniteNumber(c.net_product_cost, 'company.net_product_cost') : Math.round((productCost - returnCogs) * 100) / 100;
  const unallocatedExp = c.unallocated_sales_expenses != null ? assertFiniteNumber(c.unallocated_sales_expenses, 'company.unallocated_sales_expenses') : 0;
  const marginPct = c.profit_margin_pct != null ? Number(c.profit_margin_pct) : (netSales > 0 ? Math.round((profitAfterExpenses / netSales) * 10000) / 100 : 0);
  const totalQtySold = c.total_qty_sold != null ? Number(c.total_qty_sold) : 0;
  const productCount = c.product_count != null ? Number(c.product_count) : obj.products.length;

  const products = obj.products.map((rawProd: unknown, idx: number) => {
    if (!rawProd || typeof rawProd !== 'object') {
      throw new Error(`Invalid profitability summary response: products[${idx}] is not an object`);
    }
    const rp = rawProd as Record<string, unknown>;
    if (!rp.product_id || !rp.product_name) {
      throw new Error(`Invalid profitability summary response: products[${idx}] missing product_id or product_name`);
    }
    if (rp.sold_qty === undefined && rp.total_qty_sold === undefined) {
      throw new Error(`Invalid profitability summary response: products[${idx}] missing sold_qty / total_qty_sold`);
    }
    if (rp.gross_sales === undefined && rp.total_revenue === undefined) {
      throw new Error(`Invalid profitability summary response: products[${idx}] missing gross_sales / total_revenue`);
    }
    const canonical = stockMap?.get(String(rp.product_id));
    return normalizeProductProfitabilityRow(rp, canonical);
  });

  const monthly = Array.isArray(obj.monthly)
    ? obj.monthly.map((m: any) => {
        const grossBeforeReturns = Number(m.gross_sales_before_returns ?? m.gross_sales ?? 0);
        const salesRet = Number(m.sales_returns ?? 0);
        const netSalesVal = m.net_sales != null ? Number(m.net_sales) : Math.round((grossBeforeReturns - salesRet) * 100) / 100;
        return {
          month_label: String(m.month_label || ''),
          month_start: String(m.month_start || ''),
          gross_sales: grossBeforeReturns,
          sales_returns: salesRet,
          net_sales: netSalesVal,
          product_cost: Number(m.product_cost ?? 0),
          sales_expenses: Number(m.sales_expenses ?? 0),
          gross_profit: Number(m.gross_profit ?? 0),
          profit_after_sales_expenses: Number(m.profit_after_sales_expenses ?? 0),
          profit_margin_pct: Number(m.profit_margin_pct ?? 0),
          total_qty_sold: Number(m.total_qty_sold ?? 0),
          order_count: Number(m.order_count ?? 0),
          has_unreported_cost: Boolean(m.has_unreported_cost),
          unresolved_return_cogs_count: Number(m.unresolved_return_cogs_count ?? 0),
        };
      })
    : [];

  return {
    company: {
      gross_sales: grossSales,
      sales_returns: salesReturns,
      net_sales: netSales,
      product_cost: productCost,
      return_cogs: returnCogs,
      net_product_cost: netProductCost,
      sales_expenses: salesExpenses,
      unallocated_sales_expenses: unallocatedExp,
      gross_profit: grossProfit,
      profit_after_sales_expenses: profitAfterExpenses,
      profit_margin_pct: marginPct,
      total_qty_sold: totalQtySold,
      order_count: orderCount,
      product_count: productCount,
      has_unreported_cost: Boolean(c.has_unreported_cost),
      unresolved_return_cogs_count: Number(c.unresolved_return_cogs_count ?? 0),
      return_cogs_allocation_mismatch_count: Number(c.return_cogs_allocation_mismatch_count ?? 0),
      credit_note_item_subtotal_mismatch_count: Number(c.credit_note_item_subtotal_mismatch_count ?? 0),
      has_unresolved_return_cogs: Boolean(c.has_unresolved_return_cogs),
      has_credit_note_item_subtotal_mismatch: Boolean(c.has_credit_note_item_subtotal_mismatch),
      profitability_certified: c.profitability_certified !== undefined ? Boolean(c.profitability_certified) : undefined,
      certification_status: c.certification_status ? String(c.certification_status) : undefined,
      cancelled_invoices: c.cancelled_invoices as any,
    },
    products,
    monthly,
  };
}

export function adaptProductBatchEnvelope(
  raw: unknown,
  contextLabel = 'product'
): {
  product: NormalizedProductProfitabilityRow | null;
  batches: NormalizedBatchProfitabilityRow[];
} {
  if (Array.isArray(raw)) {
    return { product: null, batches: raw.map(normalizeBatchProfitabilityRow) };
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).batches)) {
    const obj = raw as Record<string, unknown>;
    const product = obj.product && typeof obj.product === 'object'
      ? normalizeProductProfitabilityRow(obj.product)
      : null;
    const batches = (obj.batches as unknown[]).map(normalizeBatchProfitabilityRow);
    return { product, batches };
  }
  throw new Error(`Invalid product batches RPC response for ${contextLabel}: expected { product, batches } or JSON array`);
}

export function adaptProductBatchesResponse(
  raw: unknown,
  contextLabel = 'product'
): NormalizedBatchProfitabilityRow[] {
  let list: unknown[];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).batches)) {
    list = (raw as Record<string, unknown>).batches as unknown[];
  } else {
    throw new Error(`Invalid product batches RPC response for ${contextLabel}: expected JSON array`);
  }
  return list.map(normalizeBatchProfitabilityRow);
}

export function adaptBatchOrdersResponse(
  raw: unknown,
  contextLabel = 'batch'
): NormalizedOrderSaleRow[] {
  if (Array.isArray(raw)) {
    return raw as NormalizedOrderSaleRow[];
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).orders)) {
    return (raw as Record<string, unknown>).orders as NormalizedOrderSaleRow[];
  }
  throw new Error(`Invalid batch orders RPC response for ${contextLabel}: expected JSON array`);
}
