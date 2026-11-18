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

export interface NormalizedBatchProfitabilityRow {
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
    batch_id: raw.batch_id,
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
    cost_breakdown: costBreakdown,
  };
}
