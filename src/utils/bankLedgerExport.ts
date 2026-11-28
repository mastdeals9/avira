import ExcelJS from 'exceljs';

function formatCurrencyDisplay(amount: number, currency: string): string {
  const upper = (currency || 'IDR').toUpperCase();
  const formatted = new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount || 0));
  if (upper === 'USD') return `$${formatted}`;
  if (upper === 'EUR') return `€${formatted}`;
  return `Rp ${formatted}`;
}

export interface BankLedgerExportEntry {
  entry_date: string;
  particulars: string;
  reference: string;
  canonical_reference?: string;
  debit: number;
  credit: number;
  running_balance: number;
}

export interface BankLedgerExportParams {
  bankName: string;
  accountNumber: string;
  currency: string;
  startDate: string;
  endDate: string;
  openingBalance: number;
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
  entries: BankLedgerExportEntry[];
}

export const BANK_LEDGER_HEADERS = [
  'Date',
  'Description / Remarks',
  'Reference No.',
  'Debit (Dr)',
  'Credit (Cr)',
  'Balance',
] as const;

/**
 * RFC-4180 CSV cell escaping: quotes any value containing comma, quote, CR, or LF.
 */
export function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Parses a single RFC-4180 CSV line into fields (used by verification tests).
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function formatDateId(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('id-ID');
}

function getExcelCurrencyFmt(currency: string): string {
  const upper = (currency || 'IDR').toUpperCase();
  if (upper === 'USD') return '"$"#,##0.00;("$"#,##0.00);"-"';
  if (upper === 'EUR') return '"€"#,##0.00;("€"#,##0.00);"-"';
  return '"Rp "#,##0.00;("Rp "#,##0.00);"-"';
}

/**
 * Builds a UTF-8 BOM, RFC-4180 compliant CSV string with properly quoted fields.
 */
export function buildBankLedgerCsv(params: BankLedgerExportParams): string {
  const {
    bankName,
    accountNumber,
    currency,
    startDate,
    endDate,
    openingBalance,
    totalDebit,
    totalCredit,
    closingBalance,
    entries,
  } = params;

  const fmt = (n: number) => formatCurrencyDisplay(n, currency);

  const metadataRows = [
    [`Bank Ledger - ${bankName} (${accountNumber})`],
    [`Currency: ${currency}`],
    [`Period: ${formatDateId(startDate)} to ${formatDateId(endDate)}`],
    [`Opening Balance: ${fmt(openingBalance)}`],
    [],
  ];

  const openingRow = [
    formatDateId(startDate),
    'Opening Balance',
    '',
    '',
    '',
    fmt(openingBalance),
  ];

  const txRows = entries.map((entry) => [
    formatDateId(entry.entry_date),
    entry.particulars || '',
    entry.canonical_reference || entry.reference || '',
    entry.debit > 0 ? fmt(entry.debit) : '',
    entry.credit > 0 ? fmt(entry.credit) : '',
    fmt(entry.running_balance),
  ]);

  const closingRow = [
    formatDateId(endDate),
    'Closing Balance',
    '',
    fmt(totalDebit),
    fmt(totalCredit),
    fmt(closingBalance),
  ];

  const allRows = [
    ...metadataRows,
    [...BANK_LEDGER_HEADERS],
    openingRow,
    ...txRows,
    closingRow,
  ];

  const csvBody = allRows
    .map((row) => row.map((cell) => escapeCsvCell(cell)).join(','))
    .join('\r\n');

  return `\uFEFF${csvBody}`;
}

/**
 * Builds an ExcelJS workbook with numeric amounts/balances and Indonesian currency formatting.
 */
export function buildBankLedgerWorkbook(params: BankLedgerExportParams): ExcelJS.Workbook {
  const {
    bankName,
    accountNumber,
    currency,
    startDate,
    endDate,
    openingBalance,
    totalDebit,
    totalCredit,
    closingBalance,
    entries,
  } = params;

  const numFmt = getExcelCurrencyFmt(currency);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ANZEN ERP';
  wb.created = new Date();

  const ws = wb.addWorksheet('Bank Ledger', {
    views: [{ state: 'frozen', ySplit: 6, showGridLines: true }],
  });

  const titleRow = ws.addRow([`Bank Ledger — ${bankName} (${accountNumber})`]);
  titleRow.font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FF0F2942' } };

  const metaRow1 = ws.addRow([`Currency: ${currency}   |   Period: ${formatDateId(startDate)} to ${formatDateId(endDate)}`]);
  metaRow1.font = { name: 'Calibri', size: 10, color: { argb: 'FF475569' } };

  const metaRow2 = ws.addRow(['Opening Balance:', Number(openingBalance)]);
  metaRow2.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
  metaRow2.getCell(2).numFmt = numFmt;

  const metaRow3 = ws.addRow(['Closing Balance:', Number(closingBalance)]);
  metaRow3.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
  metaRow3.getCell(2).numFmt = numFmt;

  ws.addRow([]);

  const headerRow = ws.addRow([...BANK_LEDGER_HEADERS]);
  headerRow.height = 22;
  headerRow.eachCell((cell, colNum) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2942' } };
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: colNum >= 4 ? 'right' : 'left' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF0F172A' } },
      bottom: { style: 'medium', color: { argb: 'FF0F172A' } },
      left: { style: 'thin', color: { argb: 'FF334155' } },
      right: { style: 'thin', color: { argb: 'FF334155' } },
    };
  });

  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  };

  // Opening Balance row
  const openRow = ws.addRow([
    formatDateId(startDate),
    'Opening Balance',
    '',
    null,
    null,
    Number(openingBalance),
  ]);
  openRow.eachCell((cell, colNum) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
    cell.border = thinBorder;
    if (colNum >= 4) {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
      if (typeof cell.value === 'number') cell.numFmt = numFmt;
    }
  });

  // Transaction rows
  entries.forEach((entry, idx) => {
    const r = ws.addRow([
      formatDateId(entry.entry_date),
      entry.particulars || '',
      entry.canonical_reference || entry.reference || '',
      entry.debit > 0 ? Number(entry.debit) : null,
      entry.credit > 0 ? Number(entry.credit) : null,
      Number(entry.running_balance),
    ]);
    r.eachCell((cell, colNum) => {
      cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF1E293B' } };
      if (idx % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      }
      cell.border = thinBorder;
      if (colNum === 2 || colNum === 3) {
        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      } else if (colNum >= 4) {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        if (typeof cell.value === 'number') cell.numFmt = numFmt;
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      }
    });
  });

  // Closing Balance row
  const closeRow = ws.addRow([
    formatDateId(endDate),
    'Closing Balance',
    '',
    Number(totalDebit),
    Number(totalCredit),
    Number(closingBalance),
  ]);
  closeRow.height = 22;
  closeRow.eachCell((cell, colNum) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF94A3B8' } },
      bottom: { style: 'double', color: { argb: 'FF0F172A' } },
      left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    };
    if (colNum >= 4) {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
      if (typeof cell.value === 'number') cell.numFmt = numFmt;
    }
  });

  ws.autoFilter = { from: 'A6', to: `F${6 + 1 + entries.length}` };
  [14, 48, 28, 20, 20, 22].forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  return wb;
}

export async function exportBankLedgerExcel(params: BankLedgerExportParams): Promise<void> {
  const wb = buildBankLedgerWorkbook(params);
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const safeBank = params.bankName.replace(/[^a-zA-Z0-9_-]/g, '_');
  link.download = `bank_ledger_${safeBank}_${params.startDate}_to_${params.endDate}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportBankLedgerCsv(params: BankLedgerExportParams): void {
  const csv = buildBankLedgerCsv(params);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const safeBank = params.bankName.replace(/[^a-zA-Z0-9_-]/g, '_');
  link.download = `bank_ledger_${safeBank}_${params.startDate}_to_${params.endDate}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
