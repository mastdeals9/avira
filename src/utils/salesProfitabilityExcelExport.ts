import ExcelJS from 'exceljs';
import {
  fetchCanonicalSalesProfitability,
  type ReconciledSalesProfitabilityDataset,
} from '../services/salesProfitabilityEngine';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExportProgressCallback {
  (step: string, percent: number): void;
}

export interface ExportDateRangeOptions {
  mode: 'this_year' | 'specific_month' | 'custom' | 'current_screen';
  year: number;
  month?: number;
  startDate: string;
  endDate: string;
  label: string;
  exportFormat?: 'consolidated' | 'detailed';
}

// ─── Styling Constants ────────────────────────────────────────────────────────

const IDR_NUM_FMT = '#,##0.00;(#,##0.00);"-"';
const QTY_NUM_FMT = '#,##0.###;(#,##0.###);"-"';
const PCT_NUM_FMT = '0.00%;(0.00%);"-"';

const BORDER_THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
};

const BORDER_HEADER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF0F172A' } },
  left: { style: 'thin', color: { argb: 'FF334155' } },
  bottom: { style: 'medium', color: { argb: 'FF0F172A' } },
  right: { style: 'thin', color: { argb: 'FF334155' } },
};

const BORDER_TOTAL: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF94A3B8' } },
  left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  bottom: { style: 'double', color: { argb: 'FF0F172A' } },
  right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
};

const FILL_HEADER: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF0F2942' },
};

const FILL_ZEBRA: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF8FAFC' },
};

const FILL_TOTAL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF1F5F9' },
};

const FILL_HIGHLIGHT: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFECFDF5' },
};

const FONT_HEADER: Partial<ExcelJS.Font> = {
  name: 'Calibri',
  size: 10,
  bold: true,
  color: { argb: 'FFFFFFFF' },
};

const FONT_DATA: Partial<ExcelJS.Font> = {
  name: 'Calibri',
  size: 10,
  color: { argb: 'FF1E293B' },
};

const FONT_BOLD: Partial<ExcelJS.Font> = {
  name: 'Calibri',
  size: 10,
  bold: true,
  color: { argb: 'FF0F172A' },
};

function downloadWorkbookBuffer(buffer: ArrayBuffer | Uint8Array, filename: string) {
  const blob = new Blob([buffer as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

function addBanner(ws: ExcelJS.Worksheet, title: string, periodLabel: string, startDate: string, endDate: string) {
  const r1 = ws.addRow(['PT. SHUBHAM ARTHA MULIA / ANZEN ERP']);
  r1.font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FF0F2942' } };

  const r2 = ws.addRow([title]);
  r2.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF334155' } };

  const generated = new Date().toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const r3 = ws.addRow([`Period: ${periodLabel} (${startDate} to ${endDate})   |   Generated: ${generated}   |   Currency: IDR`]);
  r3.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF64748B' } };

  ws.addRow([]);
}

/**
 * Pure workbook builder — testable in Node without DOM/browser dependencies.
 * Enforces max 3 sheets: SUMMARY, PRODUCT PROFITABILITY, SALES DETAIL.
 * Throws if detail rows are missing when active invoices exist.
 */
export function buildSalesProfitabilityWorkbook(
  dataset: ReconciledSalesProfitabilityDataset,
  options: Pick<ExportDateRangeOptions, 'startDate' | 'endDate' | 'label' | 'exportFormat'>
): ExcelJS.Workbook {
  const { startDate, endDate, label, exportFormat = 'detailed' } = options;
  const { company, products, monthly, unitTotals, productsWithBatches, batchOrdersMap } = dataset;

  // Validate detail availability — never export zero-filled placeholder rows
  if ((company.order_count || 0) > 0 && products.length === 0) {
    throw new Error('Export stopped: product profitability breakdown is unavailable for this period.');
  }

  const detailRows: Array<{
    invoice_number: string;
    invoice_date: string;
    customer_name: string;
    so_number: string;
    dc_number: string;
    product_name: string;
    batch_number: string;
    unit: string;
    quantity: number;
    selling_price: number;
    gross_sales: number;
    line_cost: number | null;
    line_sales_expense: number;
    gross_profit: number | null;
    net_profit: number | null;
    margin: number | null;
  }> = [];

  productsWithBatches.forEach((pb) => {
    pb.batches.forEach((b) => {
      const orders = b.batch_id ? (batchOrdersMap.get(b.batch_id) || []) : [];
      orders.forEach((ord) => {
        const qty = Number(ord.quantity || 0);
        const grossSales = Number(ord.gross_sales ?? qty * Number(ord.selling_price || 0));
        const lineCost = ord.line_cost != null ? Number(ord.line_cost) : null;
        const salesExp = Number(ord.line_sales_expense || 0);
        const grossProfit = lineCost != null ? Math.round((grossSales - lineCost) * 100) / 100 : null;
        const netProfit = grossProfit != null ? Math.round((grossProfit - salesExp) * 100) / 100 : null;
        const margin = grossSales > 0 && netProfit != null ? netProfit / grossSales : null;

        detailRows.push({
          invoice_number: ord.invoice_number,
          invoice_date: ord.invoice_date,
          customer_name: ord.customer_name || 'Unknown Customer',
          so_number: ord.so_number || '—',
          dc_number: ord.dc_number || '—',
          product_name: pb.product.product_name,
          batch_number: b.batch_number,
          unit: pb.product.product_unit || 'kg',
          quantity: qty,
          selling_price: Number(ord.selling_price || 0),
          gross_sales: grossSales,
          line_cost: lineCost,
          line_sales_expense: salesExp,
          gross_profit: grossProfit,
          net_profit: netProfit,
          margin,
        });
      });
    });
  });

  if (exportFormat === 'detailed' && (company.order_count || 0) > 0 && detailRows.length === 0) {
    throw new Error('Export stopped: invoice-level sales detail rows could not be loaded for this period.');
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ANZEN ERP / PT. Shubham Artha Mulia';
  wb.lastModifiedBy = 'ANZEN ERP';
  wb.created = new Date();
  wb.modified = new Date();

  // ═══════════════════════════════════════════════════════════════════════════
  // SHEET 1 — SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  const wsSummary = wb.addWorksheet('SUMMARY', {
    views: [{ state: 'frozen', ySplit: 4, showGridLines: true }],
  });
  addBanner(wsSummary, 'SALES PROFITABILITY — EXECUTIVE SUMMARY', label, startDate, endDate);

  const summaryHeader = wsSummary.addRow(['Metric', 'Value', 'Notes']);
  summaryHeader.height = 22;
  summaryHeader.eachCell((cell) => {
    cell.fill = FILL_HEADER;
    cell.font = FONT_HEADER;
    cell.border = BORDER_HEADER;
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });

  const grossSales = Number(company.gross_sales || 0);
  const salesReturns = Number(company.sales_returns || 0);
  const netSales = Number(company.net_sales ?? grossSales - salesReturns);
  const productCogs = Number(company.product_cost || 0);
  const returnCogs = Number(company.return_cogs || 0);
  const netProductCost = Number(company.net_product_cost ?? productCogs - returnCogs);
  const grossProfit = Number(company.gross_profit || 0);
  const salesExpenses = Number(company.sales_expenses || 0);
  const unallocatedExp = Number(company.unallocated_sales_expenses || 0);
  const netProfit = Number(company.profit_after_sales_expenses || 0);
  const marginRatio = netSales > 0 ? netProfit / netSales : 0;

  const summaryRows: Array<[string, number | string, string, string?]> = [
    ['Reporting Period', `${startDate} to ${endDate}`, label],
    ['Gross Sales (IDR)', grossSales, 'Active posted sales invoices (ex-PPN)', IDR_NUM_FMT],
    ['Sales Returns (IDR)', -salesReturns, 'Approved credit notes deducted', IDR_NUM_FMT],
    ['Net Sales (IDR)', netSales, 'Gross Sales minus Returns', IDR_NUM_FMT],
    ['Product COGS (IDR)', productCogs, 'Reconciled saved invoice COGS (GL 5100)', IDR_NUM_FMT],
    ['Return COGS Reversal (IDR)', -returnCogs, 'Restocked COGS from approved credit notes', IDR_NUM_FMT],
    ['Net Product Cost (IDR)', netProductCost, 'Product COGS minus Return COGS', IDR_NUM_FMT],
    ['Gross Profit (IDR)', grossProfit, 'Net Sales minus Net Product Cost', IDR_NUM_FMT],
    ['Sales Expenses (IDR)', salesExpenses, 'Total attributable sales expenses', IDR_NUM_FMT],
    ['Unallocated Sales Expenses (IDR)', unallocatedExp, 'Included once in total sales expenses above', IDR_NUM_FMT],
    ['Profit After Sales Expenses (IDR)', netProfit, 'Gross Profit minus Sales Expenses', IDR_NUM_FMT],
    ['Profit Margin', marginRatio, 'Profit After Sales Expenses / Net Sales', PCT_NUM_FMT],
    ['Invoice Count', Number(company.order_count || 0), `${products.length} active products`, '#,##0'],
  ];

  unitTotals.forEach((ut) => {
    summaryRows.push([`Total Quantity Sold (${ut.unit})`, ut.quantity, `Separated unit total (${ut.unit})`, QTY_NUM_FMT]);
  });

  if (company?.cancelled_invoices && company.cancelled_invoices.count > 0) {
    summaryRows.push([
      'Excluded Cancelled Invoices',
      company.cancelled_invoices.count,
      `AUDIT DISCLOSURE: Excludes ${company.cancelled_invoices.count} cancelled sales invoice(s) totaling Rp ${Number(company.cancelled_invoices.total_amount || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`,
      '#,##0',
    ]);
  }

  summaryRows.forEach(([metric, val, note, fmt], idx) => {
    const r = wsSummary.addRow([metric, val, note]);
    r.height = 20;
    const isHighlight = metric === 'Profit After Sales Expenses (IDR)' || metric === 'Profit Margin';
    r.eachCell((cell, colNum) => {
      cell.border = BORDER_THIN;
      cell.font = isHighlight ? FONT_BOLD : FONT_DATA;
      if (isHighlight) cell.fill = FILL_HIGHLIGHT;
      else if (idx % 2 === 1) cell.fill = FILL_ZEBRA;

      if (colNum === 2 && typeof val === 'number') {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        if (fmt) cell.numFmt = fmt;
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      }
    });
  });

  if (monthly.length > 0) {
    wsSummary.addRow([]);
    const mTitle = wsSummary.addRow(['MONTHLY SALES & PROFITABILITY SUMMARY']);
    mTitle.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF0F2942' } };

    const mHeader = wsSummary.addRow([
      'Month',
      'Invoices',
      'Gross Sales (IDR)',
      'Sales Returns (IDR)',
      'Net Sales (IDR)',
      'Net COGS (IDR)',
      'Sales Expenses (IDR)',
      'Gross Profit (IDR)',
      'Net Profit (IDR)',
      'Margin',
    ]);
    mHeader.height = 22;
    mHeader.eachCell((cell) => {
      cell.fill = FILL_HEADER;
      cell.font = FONT_HEADER;
      cell.border = BORDER_HEADER;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    let sumMOrders = 0;
    let sumMGrossBeforeReturns = 0;
    let sumMReturns = 0;
    let sumMNetSales = 0;
    let sumMCogs = 0;
    let sumMExp = 0;
    let sumMGP = 0;
    let sumMNP = 0;

    monthly.forEach((m, idx) => {
      const mGrossBefore = Number(m.gross_sales || 0);
      const mRet = Number(m.sales_returns || 0);
      const mNetSales = Number(m.net_sales ?? (mGrossBefore - mRet));
      const mCogs = Number(m.product_cost || 0);
      const mExp = Number(m.sales_expenses || 0);
      const mGP = Number(m.gross_profit || 0);
      const mNet = Number(m.profit_after_sales_expenses || 0);

      sumMOrders += Number(m.order_count || 0);
      sumMGrossBeforeReturns += mGrossBefore;
      sumMReturns += mRet;
      sumMNetSales += mNetSales;
      sumMCogs += mCogs;
      sumMExp += mExp;
      sumMGP += mGP;
      sumMNP += mNet;

      const r = wsSummary.addRow([
        m.month_label,
        Number(m.order_count || 0),
        mGrossBefore,
        -mRet,
        mNetSales,
        mCogs,
        mExp,
        mGP,
        mNet,
        mNetSales > 0 ? mNet / mNetSales : 0,
      ]);
      r.height = 20;
      r.eachCell((cell, colNum) => {
        cell.border = BORDER_THIN;
        cell.font = FONT_DATA;
        if (idx % 2 === 1) cell.fill = FILL_ZEBRA;
        if (colNum === 1) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          if (colNum === 2) cell.numFmt = '#,##0';
          else if (colNum === 10) cell.numFmt = PCT_NUM_FMT;
          else cell.numFmt = IDR_NUM_FMT;
        }
      });
    });

    const mTotalRow = wsSummary.addRow([
      'MONTHLY TOTAL',
      sumMOrders,
      Math.round(sumMGrossBeforeReturns * 100) / 100,
      Math.round(-sumMReturns * 100) / 100,
      Math.round(sumMNetSales * 100) / 100,
      Math.round(sumMCogs * 100) / 100,
      Math.round(sumMExp * 100) / 100,
      Math.round(sumMGP * 100) / 100,
      Math.round(sumMNP * 100) / 100,
      sumMNetSales > 0 ? sumMNP / sumMNetSales : 0,
    ]);
    mTotalRow.height = 22;
    mTotalRow.eachCell((cell, colNum) => {
      cell.fill = FILL_TOTAL;
      cell.font = FONT_BOLD;
      cell.border = BORDER_TOTAL;
      if (colNum === 1) {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        if (colNum === 2) cell.numFmt = '#,##0';
        else if (colNum === 10) cell.numFmt = PCT_NUM_FMT;
        else cell.numFmt = IDR_NUM_FMT;
      }
    });
  }

  [36, 22, 42, 20, 20, 20, 20, 14].forEach((w, i) => {
    wsSummary.getColumn(i + 1).width = w;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SHEET 2 — PRODUCT PROFITABILITY
  // ═══════════════════════════════════════════════════════════════════════════
  const wsProd = wb.addWorksheet('PRODUCT PROFITABILITY', {
    views: [{ state: 'frozen', ySplit: 5, showGridLines: true }],
  });
  addBanner(wsProd, 'PRODUCT PROFITABILITY', label, startDate, endDate);

  const prodHeaders = [
    'Product',
    'Unit',
    'Quantity sold',
    'Average selling price',
    'Average historical COGS',
    'Net sales (after returns)',
    'Total COGS',
    'Sales expenses',
    'Gross profit',
    'Net profit',
    'Profit margin',
  ];
  const prodHeaderRow = wsProd.addRow(prodHeaders);
  prodHeaderRow.height = 24;
  prodHeaderRow.eachCell((cell) => {
    cell.fill = FILL_HEADER;
    cell.font = FONT_HEADER;
    cell.border = BORDER_HEADER;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  wsProd.autoFilter = { from: 'A5', to: `K${5 + products.length}` };

  let sumProdGrossSales = 0;
  let sumProdCogs = 0;
  let sumProdExp = 0;
  let sumProdGrossProfit = 0;
  let sumProdNetProfit = 0;

  products.forEach((p, idx) => {
    const qty = Number(p.sold_qty || 0);
    const gSales = Number(p.gross_sales || 0);
    const totalCogs = p.product_cost != null ? Number(p.product_cost) : null;
    const sExp = Number(p.sales_expense || 0);
    const gProfit = p.gross_profit != null ? Number(p.gross_profit) : null;
    const nProfit = p.profit_after_sales_expense != null ? Number(p.profit_after_sales_expense) : null;
    const avgPrice = qty > 0 ? gSales / qty : 0;
    const avgCogs = totalCogs != null && qty > 0 ? totalCogs / qty : null;
    const margin = gSales > 0 && nProfit != null ? nProfit / gSales : null;

    sumProdGrossSales += gSales;
    sumProdCogs += totalCogs ?? 0;
    sumProdExp += sExp;
    sumProdGrossProfit += gProfit ?? 0;
    sumProdNetProfit += nProfit ?? 0;

    const r = wsProd.addRow([
      p.product_name,
      p.product_unit,
      qty,
      avgPrice,
      avgCogs ?? 'Cost Unresolved',
      gSales,
      totalCogs ?? 'Cost Unresolved',
      sExp,
      gProfit ?? '—',
      nProfit ?? '—',
      margin ?? '—',
    ]);
    r.height = 20;
    r.eachCell((cell, colNum) => {
      cell.border = BORDER_THIN;
      cell.font = colNum === 10 ? FONT_BOLD : FONT_DATA;
      if (idx % 2 === 1) cell.fill = FILL_ZEBRA;
      if (colNum === 1) {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      } else if (colNum === 2) {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        if (typeof cell.value === 'number') {
          if (colNum === 3) cell.numFmt = QTY_NUM_FMT;
          else if (colNum === 11) cell.numFmt = PCT_NUM_FMT;
          else cell.numFmt = IDR_NUM_FMT;
        }
      }
    });
  });

  const prodTotalMargin = sumProdGrossSales > 0 ? sumProdNetProfit / sumProdGrossSales : 0;
  const prodUnitSummary = unitTotals.map((u) => `${u.quantity.toLocaleString('en-US')} ${u.unit}`).join(' | ');
  const prodTotalRow = wsProd.addRow([
    `TOTAL (${products.length} products)`,
    prodUnitSummary,
    '',
    '',
    '',
    Math.round(sumProdGrossSales * 100) / 100,
    Math.round(sumProdCogs * 100) / 100,
    Math.round(sumProdExp * 100) / 100,
    Math.round(sumProdGrossProfit * 100) / 100,
    Math.round(sumProdNetProfit * 100) / 100,
    prodTotalMargin,
  ]);
  prodTotalRow.height = 24;
  prodTotalRow.eachCell((cell, colNum) => {
    cell.fill = FILL_TOTAL;
    cell.font = FONT_BOLD;
    cell.border = BORDER_TOTAL;
    if (colNum <= 2) {
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
      if (typeof cell.value === 'number') {
        cell.numFmt = colNum === 11 ? PCT_NUM_FMT : IDR_NUM_FMT;
      }
    }
  });

  if (unallocatedExp > 0) {
    const unallocRow = wsProd.addRow([
      'Unallocated Sales Expenses (Company-level)',
      '',
      '',
      '',
      '',
      0,
      0,
      unallocatedExp,
      0,
      -unallocatedExp,
      '',
    ]);
    unallocRow.height = 20;
    unallocRow.eachCell((cell, colNum) => {
      cell.border = BORDER_THIN;
      cell.font = FONT_DATA;
      if (colNum >= 6 && typeof cell.value === 'number') {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        cell.numFmt = IDR_NUM_FMT;
      }
    });

    const netCoRow = wsProd.addRow([
      'NET COMPANY TOTAL (Reconciles to SUMMARY)',
      prodUnitSummary,
      '',
      '',
      '',
      netSales,
      netProductCost,
      salesExpenses,
      grossProfit,
      netProfit,
      marginRatio,
    ]);
    netCoRow.height = 24;
    netCoRow.eachCell((cell, colNum) => {
      cell.fill = FILL_HIGHLIGHT;
      cell.font = FONT_BOLD;
      cell.border = BORDER_TOTAL;
      if (colNum <= 2) {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        if (typeof cell.value === 'number') {
          cell.numFmt = colNum === 11 ? PCT_NUM_FMT : IDR_NUM_FMT;
        }
      }
    });
  }

  [38, 18, 15, 20, 22, 20, 20, 18, 20, 20, 14].forEach((w, i) => {
    wsProd.getColumn(i + 1).width = w;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SHEET 3 — SALES DETAIL (unless 'consolidated' explicitly omits line detail)
  // ═══════════════════════════════════════════════════════════════════════════
  if (exportFormat === 'detailed') {
    const wsDetail = wb.addWorksheet('SALES DETAIL', {
      views: [{ state: 'frozen', ySplit: 5, showGridLines: true }],
    });
    addBanner(wsDetail, 'SALES DETAIL — INVOICE LINE PROFITABILITY', label, startDate, endDate);

    const detailHeaders = [
      'Invoice number',
      'Invoice date',
      'Customer',
      'Sales Order',
      'Delivery Challan',
      'Product',
      'Batch',
      'Unit',
      'Quantity',
      'Selling price',
      'Gross sales',
      'Historical COGS',
      'Allocated sales expense',
      'Gross profit',
      'Net profit',
      'Margin',
    ];
    const detailHeaderRow = wsDetail.addRow(detailHeaders);
    detailHeaderRow.height = 24;
    detailHeaderRow.eachCell((cell) => {
      cell.fill = FILL_HEADER;
      cell.font = FONT_HEADER;
      cell.border = BORDER_HEADER;
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    wsDetail.autoFilter = { from: 'A5', to: `P${5 + detailRows.length}` };

    let sumDetGross = 0;
    let sumDetCogs = 0;
    let sumDetExp = 0;
    let sumDetGP = 0;
    let sumDetNP = 0;

    detailRows.forEach((d, idx) => {
      sumDetGross += d.gross_sales;
      sumDetCogs += d.line_cost ?? 0;
      sumDetExp += d.line_sales_expense;
      sumDetGP += d.gross_profit ?? 0;
      sumDetNP += d.net_profit ?? 0;

      const r = wsDetail.addRow([
        d.invoice_number,
        d.invoice_date,
        d.customer_name,
        d.so_number,
        d.dc_number,
        d.product_name,
        d.batch_number,
        d.unit,
        d.quantity,
        d.selling_price,
        d.gross_sales,
        d.line_cost ?? 'Cost Unresolved',
        d.line_sales_expense,
        d.gross_profit ?? '—',
        d.net_profit ?? '—',
        d.margin ?? '—',
      ]);
      r.height = 20;
      r.eachCell((cell, colNum) => {
        cell.border = BORDER_THIN;
        cell.font = colNum === 15 ? FONT_BOLD : FONT_DATA;
        if (idx % 2 === 1) cell.fill = FILL_ZEBRA;
        if (colNum <= 2 || colNum === 4 || colNum === 5 || colNum === 7 || colNum === 8) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else if (colNum === 3 || colNum === 6) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          if (typeof cell.value === 'number') {
            if (colNum === 9) cell.numFmt = QTY_NUM_FMT;
            else if (colNum === 16) cell.numFmt = PCT_NUM_FMT;
            else cell.numFmt = IDR_NUM_FMT;
          }
        }
      });
    });

    const detMargin = sumDetGross > 0 ? sumDetNP / sumDetGross : 0;
    const detTotalRow = wsDetail.addRow([
      'TOTAL',
      `${detailRows.length} lines`,
      '',
      '',
      '',
      '',
      '',
      prodUnitSummary,
      '',
      '',
      Math.round(sumDetGross * 100) / 100,
      Math.round(sumDetCogs * 100) / 100,
      Math.round(sumDetExp * 100) / 100,
      Math.round(sumDetGP * 100) / 100,
      Math.round(sumDetNP * 100) / 100,
      detMargin,
    ]);
    detTotalRow.height = 24;
    detTotalRow.eachCell((cell, colNum) => {
      cell.fill = FILL_TOTAL;
      cell.font = FONT_BOLD;
      cell.border = BORDER_TOTAL;
      if (colNum <= 2 || colNum === 8) {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        if (typeof cell.value === 'number') {
          cell.numFmt = colNum === 16 ? PCT_NUM_FMT : IDR_NUM_FMT;
        }
      }
    });

    if (salesReturns > 0 || unallocatedExp > 0) {
      if (salesReturns > 0) {
        const cnRow = wsDetail.addRow([
          'CREDIT NOTES',
          `${startDate}..${endDate}`,
          'Approved Credit Note Deductions',
          '—',
          '—',
          'All Returned Products',
          '—',
          '',
          '',
          '',
          -salesReturns,
          -returnCogs,
          0,
          Math.round((-salesReturns + returnCogs) * 100) / 100,
          Math.round((-salesReturns + returnCogs) * 100) / 100,
          '',
        ]);
        cnRow.height = 20;
        cnRow.eachCell((cell, colNum) => {
          cell.border = BORDER_THIN;
          cell.font = FONT_DATA;
          if (colNum >= 11 && typeof cell.value === 'number') {
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
            cell.numFmt = IDR_NUM_FMT;
          }
        });
      }
      if (unallocatedExp > 0) {
        const unRow = wsDetail.addRow([
          'UNALLOCATED',
          `${startDate}..${endDate}`,
          'Unallocated Sales Expenses',
          '—',
          '—',
          'Company-level Sales Overhead',
          '—',
          '',
          '',
          '',
          0,
          0,
          unallocatedExp,
          0,
          -unallocatedExp,
          '',
        ]);
        unRow.height = 20;
        unRow.eachCell((cell, colNum) => {
          cell.border = BORDER_THIN;
          cell.font = FONT_DATA;
          if (colNum >= 11 && typeof cell.value === 'number') {
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
            cell.numFmt = IDR_NUM_FMT;
          }
        });
      }
      const detNetRow = wsDetail.addRow([
        'NET COMPANY TOTAL',
        'Reconciled',
        '',
        '',
        '',
        '',
        '',
        prodUnitSummary,
        '',
        '',
        netSales,
        netProductCost,
        salesExpenses,
        grossProfit,
        netProfit,
        marginRatio,
      ]);
      detNetRow.height = 24;
      detNetRow.eachCell((cell, colNum) => {
        cell.fill = FILL_HIGHLIGHT;
        cell.font = FONT_BOLD;
        cell.border = BORDER_TOTAL;
        if (colNum <= 2 || colNum === 8) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          if (typeof cell.value === 'number') {
            cell.numFmt = colNum === 16 ? PCT_NUM_FMT : IDR_NUM_FMT;
          }
        }
      });
    }

    [18, 13, 30, 16, 16, 34, 18, 12, 12, 18, 20, 20, 20, 20, 20, 12].forEach((w, i) => {
      wsDetail.getColumn(i + 1).width = w;
    });
  }

  return wb;
}

// ─── Browser Export Entrypoint ───────────────────────────────────────────────

export async function generateSalesProfitabilityExcel(
  options: ExportDateRangeOptions,
  onProgress?: ExportProgressCallback
): Promise<void> {
  const { startDate, endDate, label, exportFormat = 'detailed' } = options;

  const dataset = await fetchCanonicalSalesProfitability({
    startDate,
    endDate,
    onProgress,
  });

  onProgress?.('Assembling Excel workbook...', 88);
  const wb = buildSalesProfitabilityWorkbook(dataset, { startDate, endDate, label, exportFormat });

  onProgress?.('Finalizing workbook and downloading...', 96);
  const buffer = await wb.xlsx.writeBuffer();
  const cleanLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const suffix = exportFormat === 'consolidated' ? 'Consolidated' : 'Detailed';
  const filename = `Sales_Profitability_${suffix}_${cleanLabel}_${startDate}_to_${endDate}.xlsx`;

  downloadWorkbookBuffer(buffer, filename);
  onProgress?.('Export completed successfully!', 100);
}
