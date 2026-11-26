import ExcelJS from 'exceljs';
import type { BalanceSheetModel, PnLModel, TrialBalanceModel } from './financialReportModel';

const NUM_FMT = '#,##0;(#,##0);"-"';
const THIN_BORDER: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FF334155' } };
const DOUBLE_BORDER: Partial<ExcelJS.Border> = { style: 'double', color: { argb: 'FF0F172A' } };
const SUBTOTAL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF1F5F9' },
};
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1E293B' },
};
const SECTION_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE2E8F0' },
};

function applyHeader(
  ws: ExcelJS.Worksheet,
  cols: number,
  companyName: string,
  title: string,
  periodLabel: string,
  basisLabel: string
) {
  const lastCol = String.fromCharCode(64 + cols);
  ws.mergeCells(`A1:${lastCol}1`);
  ws.getCell('A1').value = companyName;
  ws.getCell('A1').font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF0F172A' } };
  ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 24;

  ws.mergeCells(`A2:${lastCol}2`);
  ws.getCell('A2').value = title;
  ws.getCell('A2').font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FF1E293B' } };
  ws.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(2).height = 20;

  ws.mergeCells(`A3:${lastCol}3`);
  ws.getCell('A3').value = periodLabel;
  ws.getCell('A3').font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF475569' } };
  ws.getCell('A3').alignment = { horizontal: 'center', vertical: 'middle' };

  ws.mergeCells(`A4:${lastCol}4`);
  ws.getCell('A4').value = basisLabel;
  ws.getCell('A4').font = { name: 'Calibri', size: 9, color: { argb: 'FF64748B' } };
  ws.getCell('A4').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(5).height = 10;
}

export function buildBalanceSheetWorkbook(
  model: BalanceSheetModel,
  meta: { companyName: string; asOfLabel: string; basisLabel: string }
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Balance Sheet', {
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
    },
  });

  ws.columns = [
    { width: 10 }, // A: Left Code
    { width: 34 }, // B: Left Account
    { width: 18 }, // C: Left Amount
    { width: 3 }, // D: Spacer
    { width: 10 }, // E: Right Code
    { width: 34 }, // F: Right Account
    { width: 18 }, // G: Right Amount
  ];

  applyHeader(ws, 7, meta.companyName, 'BALANCE SHEET', meta.asOfLabel, meta.basisLabel);

  // Column group headers
  ws.mergeCells('A6:C6');
  ws.getCell('A6').value = 'ASSETS';
  ws.getCell('A6').font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A6').fill = HEADER_FILL;
  ws.getCell('A6').alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  ws.mergeCells('E6:G6');
  ws.getCell('E6').value = 'LIABILITIES & EQUITY';
  ws.getCell('E6').font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getCell('E6').fill = HEADER_FILL;
  ws.getCell('E6').alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getRow(6).height = 22;

  type SideRow = {
    code: string;
    name: string;
    amount?: number;
    kind: 'section' | 'item' | 'subtotal' | 'total';
  };
  const left: SideRow[] = [
    { code: '', name: 'Current Assets', kind: 'section' },
    ...model.currentAssets.map((i) => ({
      code: i.code,
      name: i.name,
      amount: i.amount,
      kind: 'item' as const,
    })),
    { code: '', name: 'Total Current Assets', amount: model.totalCurrentAssets, kind: 'subtotal' },
    { code: '', name: 'Non-current Assets', kind: 'section' },
    ...model.nonCurrentAssets.map((i) => ({
      code: i.code,
      name: i.name,
      amount: i.amount,
      kind: 'item' as const,
    })),
    {
      code: '',
      name: 'Total Non-current Assets',
      amount: model.totalNonCurrentAssets,
      kind: 'subtotal',
    },
  ];

  const right: SideRow[] = [
    { code: '', name: 'Current Liabilities', kind: 'section' },
    ...model.currentLiabilities.map((i) => ({
      code: i.code,
      name: i.name,
      amount: i.amount,
      kind: 'item' as const,
    })),
    {
      code: '',
      name: 'Total Current Liabilities',
      amount: model.totalCurrentLiabilities,
      kind: 'subtotal',
    },
    ...(model.longTermLiabilities.length > 0
      ? [
          { code: '', name: 'Long-term Liabilities', kind: 'section' as const },
          ...model.longTermLiabilities.map((i) => ({
            code: i.code,
            name: i.name,
            amount: i.amount,
            kind: 'item' as const,
          })),
          {
            code: '',
            name: 'Total Long-term Liabilities',
            amount: model.totalLongTermLiabilities,
            kind: 'subtotal' as const,
          },
        ]
      : []),
    { code: '', name: 'Total Liabilities', amount: model.totalLiabilities, kind: 'subtotal' },
    { code: '', name: 'Equity', kind: 'section' },
    ...model.equityItems.map((i) => ({
      code: i.code,
      name: i.name,
      amount: i.amount,
      kind: 'item' as const,
    })),
    { code: '', name: 'Total Equity', amount: model.totalEquity, kind: 'subtotal' },
  ];

  const bodyCount = Math.max(left.length, right.length);
  const startRow = 7;
  for (let i = 0; i < bodyCount; i++) {
    const r = startRow + i;
    const rowObj = ws.getRow(r);
    rowObj.height = 18;
    const l = left[i];
    const rt = right[i];
    if (l) writeSideCell(ws, r, 1, l);
    if (rt) writeSideCell(ws, r, 5, rt);
  }

  const finalRow = startRow + bodyCount + 1;
  ws.getRow(finalRow).height = 22;
  writeSideCell(ws, finalRow, 1, {
    code: '',
    name: 'TOTAL ASSETS',
    amount: model.totalAssets,
    kind: 'total',
  });
  writeSideCell(ws, finalRow, 5, {
    code: '',
    name: 'TOTAL LIABILITIES & EQUITY',
    amount: model.totalLiabilitiesAndEquity,
    kind: 'total',
  });
  ws.pageSetup.printArea = `A1:G${finalRow}`;
  return wb;
}

function writeSideCell(
  ws: ExcelJS.Worksheet,
  r: number,
  startCol: number,
  entry: {
    code: string;
    name: string;
    amount?: number;
    kind: 'section' | 'item' | 'subtotal' | 'total';
  }
) {
  const cCode = ws.getCell(r, startCol);
  const cName = ws.getCell(r, startCol + 1);
  const cAmt = ws.getCell(r, startCol + 2);
  cCode.value = entry.code || null;
  cName.value = entry.name;
  cAmt.value = entry.amount !== undefined ? entry.amount : null;

  cCode.font = { name: 'Calibri', size: 9, color: { argb: 'FF64748B' } };
  cAmt.numFmt = NUM_FMT;
  cAmt.alignment = { horizontal: 'right', vertical: 'middle' };

  if (entry.kind === 'section') {
    cName.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF1E293B' } };
    [cCode, cName, cAmt].forEach((c) => {
      c.fill = SECTION_FILL;
    });
  } else if (entry.kind === 'subtotal') {
    cName.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
    cAmt.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
    [cCode, cName, cAmt].forEach((c) => {
      c.fill = SUBTOTAL_FILL;
      c.border = { top: THIN_BORDER, bottom: THIN_BORDER };
    });
  } else if (entry.kind === 'total') {
    cName.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
    cAmt.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
    [cCode, cName, cAmt].forEach((c) => {
      c.fill = SECTION_FILL;
      c.border = { top: THIN_BORDER, bottom: DOUBLE_BORDER };
    });
  } else {
    cName.font = { name: 'Calibri', size: 10, color: { argb: 'FF1E293B' } };
    cAmt.font = { name: 'Calibri', size: 10, color: { argb: 'FF1E293B' } };
  }
}

export function buildPnLWorkbook(
  model: PnLModel,
  meta: { companyName: string; periodLabel: string; basisLabel: string }
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Profit & Loss', {
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  ws.columns = [{ width: 12 }, { width: 48 }, { width: 20 }, { width: 14 }];
  applyHeader(
    ws,
    4,
    meta.companyName,
    'PROFIT & LOSS STATEMENT',
    meta.periodLabel,
    meta.basisLabel
  );

  const hdr = ws.getRow(6);
  hdr.values = ['Code', 'Description', 'Amount (Rp)', '% Net Rev'];
  hdr.height = 20;
  hdr.eachCell((c, colNumber) => {
    c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = HEADER_FILL;
    c.alignment = { horizontal: colNumber >= 3 ? 'right' : 'left', vertical: 'middle' };
  });

  let r = 7;
  const addSection = (title: string) => {
    const row = ws.getRow(r++);
    row.values = ['', title, null, null];
    row.height = 19;
    row.eachCell((c) => {
      c.fill = SECTION_FILL;
      c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF1E293B' } };
    });
  };
  const addItem = (code: string, name: string, amount: number) => {
    const row = ws.getRow(r++);
    const pct = model.netRevenue !== 0 ? amount / model.netRevenue : null;
    row.values = [code, name, amount, pct];
    row.height = 17;
    row.getCell(1).font = { name: 'Calibri', size: 9, color: { argb: 'FF64748B' } };
    row.getCell(2).font = { name: 'Calibri', size: 10, color: { argb: 'FF1E293B' } };
    row.getCell(3).numFmt = NUM_FMT;
    row.getCell(3).alignment = { horizontal: 'right' };
    row.getCell(4).numFmt = '0.0%';
    row.getCell(4).alignment = { horizontal: 'right' };
  };
  const addSubtotal = (label: string, amount: number, isFinal = false) => {
    const row = ws.getRow(r++);
    const pct = model.netRevenue !== 0 ? amount / model.netRevenue : null;
    row.values = ['', label, amount, pct];
    row.height = isFinal ? 22 : 19;
    row.eachCell((c) => {
      c.fill = isFinal ? SECTION_FILL : SUBTOTAL_FILL;
      c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
      c.border = { top: THIN_BORDER, bottom: isFinal ? DOUBLE_BORDER : THIN_BORDER };
    });
    row.getCell(3).numFmt = NUM_FMT;
    row.getCell(3).alignment = { horizontal: 'right' };
    row.getCell(4).numFmt = '0.0%';
    row.getCell(4).alignment = { horizontal: 'right' };
  };

  addSection('Revenue');
  model.grossSalesRows.forEach((i) => addItem(i.code, i.name, i.amount));
  model.contraRevenueRows.forEach((i) => addItem(i.code, `Less: ${i.name}`, i.amount));
  addSubtotal('Net Revenue', model.netRevenue);

  addSection('Cost of Goods Sold');
  model.cogsRows.forEach((i) => addItem(i.code, i.name, i.amount));
  addSubtotal('Total Cost of Goods Sold', model.totalCOGS);
  addSubtotal('Gross Profit', model.grossProfit);

  addSection('Operating Expenses');
  model.opexRows.forEach((i) => addItem(i.code, i.name, i.amount));
  addSubtotal('Total Operating Expenses', model.totalOpex);
  addSubtotal('Operating Profit / (Loss)', model.operatingProfit);

  addSection('Other Income and Expenses');
  model.otherIncomeRows.forEach((i) => addItem(i.code, i.name, i.amount));
  model.fxGainRows.forEach((i) => addItem(i.code, i.name, i.amount));
  model.fxLossRows.forEach((i) => addItem(i.code, i.name, -i.amount));
  model.bankChargeRows.forEach((i) => addItem(i.code, i.name, -i.amount));
  model.otherExpenseRows.forEach((i) => addItem(i.code, i.name, -i.amount));
  addSubtotal('Net Other Income / (Expenses)', model.netOtherIncomeAndExpenses);
  addSubtotal('Net Profit / (Loss) Before Tax', model.netProfit, true);

  ws.pageSetup.printArea = `A1:D${r - 1}`;
  return wb;
}

export function buildTrialBalanceWorkbook(
  model: TrialBalanceModel,
  meta: { companyName: string; periodLabel: string; basisLabel: string }
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Trial Balance', {
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
    views: [{ state: 'frozen', ySplit: 6 }],
  });
  ws.columns = [
    { width: 12 },
    { width: 42 },
    { width: 17 },
    { width: 17 },
    { width: 17 },
    { width: 17 },
    { width: 17 },
    { width: 17 },
  ];
  applyHeader(ws, 8, meta.companyName, 'TRIAL BALANCE', meta.periodLabel, meta.basisLabel);

  const hdr = ws.getRow(6);
  hdr.values = [
    'Account Code',
    'Account Name',
    'Opening Debit',
    'Opening Credit',
    'Period Debit',
    'Period Credit',
    'Closing Debit',
    'Closing Credit',
  ];
  hdr.height = 22;
  hdr.eachCell((c, colNumber) => {
    c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = HEADER_FILL;
    c.alignment = { horizontal: colNumber >= 3 ? 'right' : 'left', vertical: 'middle' };
  });

  let r = 7;
  for (const sec of model.sections) {
    const sRow = ws.getRow(r++);
    sRow.values = ['', sec.label, null, null, null, null, null, null];
    sRow.height = 18;
    sRow.eachCell((c) => {
      c.fill = SECTION_FILL;
      c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF1E293B' } };
    });

    for (const item of sec.rows) {
      const row = ws.getRow(r++);
      row.values = [
        item.code,
        item.name,
        item.openingDr || 0,
        item.openingCr || 0,
        item.periodDr || 0,
        item.periodCr || 0,
        item.closingDr || 0,
        item.closingCr || 0,
      ];
      row.height = 17;
      for (let c = 3; c <= 8; c++) {
        row.getCell(c).numFmt = NUM_FMT;
        row.getCell(c).alignment = { horizontal: 'right' };
      }
    }

    const sub = ws.getRow(r++);
    sub.values = [
      '',
      `Total ${sec.label}`,
      sec.openingDr,
      sec.openingCr,
      sec.periodDr,
      sec.periodCr,
      sec.closingDr,
      sec.closingCr,
    ];
    sub.height = 19;
    sub.eachCell((c) => {
      c.fill = SUBTOTAL_FILL;
      c.font = { name: 'Calibri', size: 10, bold: true };
      c.border = { top: THIN_BORDER, bottom: THIN_BORDER };
    });
    for (let c = 3; c <= 8; c++) {
      sub.getCell(c).numFmt = NUM_FMT;
      sub.getCell(c).alignment = { horizontal: 'right' };
    }
  }

  const gt = ws.getRow(r++);
  const g = model.grandTotals;
  gt.values = [
    '',
    'GRAND TOTAL',
    g.openingDr,
    g.openingCr,
    g.periodDr,
    g.periodCr,
    g.closingDr,
    g.closingCr,
  ];
  gt.height = 22;
  gt.eachCell((c) => {
    c.fill = SECTION_FILL;
    c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
    c.border = { top: THIN_BORDER, bottom: DOUBLE_BORDER };
  });
  for (let c = 3; c <= 8; c++) {
    gt.getCell(c).numFmt = NUM_FMT;
    gt.getCell(c).alignment = { horizontal: 'right' };
  }

  ws.autoFilter = { from: 'A6', to: `H${r - 1}` };
  ws.pageSetup.printArea = `A1:H${r - 1}`;
  return wb;
}

export async function downloadWorkbook(wb: ExcelJS.Workbook, filename: string): Promise<void> {
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
