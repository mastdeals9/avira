/**
 * src/components/finance/bankStatementNormalizer.ts
 * 
 * High-performance, profile-driven normalizer for bank statements.
 * Features:
 * - Automatic format detection (Raw BCA CSV, 4-column cleaned BCA CSV, Generic CSV/Excel)
 * - Raw BCA header and footer metadata extraction (Account #, Name, Period, Opening/Closing Balances, Summary Mutasi)
 * - Direction/Amount parsing (trailing 'DB'/'CR', separate direction columns, Indonesian number formatting)
 * - Robust handling of PEND rows (flags as pending, pre-fills today's date, preserves audit trail)
 * - Strict statement-level mathematical validation (Opening + Credits - Debits = Closing)
 * - Bank account auto-identification by account number (e.g. 0930201014 <-> 0930 2010 14)
 * - Duplicate protection against existing database records
 */

export interface NormalizedBankTransaction {
  id: string;
  date: string; // ISO YYYY-MM-DD
  originalDate?: string; // e.g. "PEND" or "13/11/26"
  isPending?: boolean;
  description: string;
  reference: string;
  branchCode?: string;
  debit: number;
  credit: number;
  balance?: number;
  currency: string;
  status: 'unmatched' | 'pending_date_required' | 'duplicate' | string;
  notes?: string;
}

export interface BankStatementMetadata {
  accountNumber?: string;
  rawAccountNumber?: string;
  accountName?: string;
  period?: string;
  startDate?: string;
  endDate?: string;
  currency?: string;
  openingBalance?: number;
  closingBalance?: number;
  totalDebits?: number;
  totalCredits?: number;
  debitCountSummary?: number;
  creditCountSummary?: number;
  sourceFormat: 'bca_raw_csv' | 'bca_cleaned_csv' | 'generic_csv' | 'excel';
  hasPendingTransactions: boolean;
  pendingCount: number;
}

export interface StatementValidationResult {
  isValid: boolean;
  openingBalance: number;
  closingBalance: number;
  calculatedClosingBalance: number;
  totalDebits: number;
  totalCredits: number;
  debitCount: number;
  creditCount: number;
  discrepancy: number;
  summaryDebitsMatch: boolean;
  summaryCreditsMatch: boolean;
  message: string;
}

export interface NormalizerOptions {
  defaultYear?: number;
  todayDate?: string;
  fallbackCurrency?: string;
}

export interface BankAccountOption {
  id: string;
  account_name: string;
  bank_name: string;
  account_number: string;
  currency: string;
  alias?: string | null;
  opening_balance?: number;
}

/**
 * Normalizes header string for comparison
 */
export const normalizeHeader = (s: string): string =>
  s.toLowerCase().trim().replace(/[\s_-]+/g, ' ');

export const isDateHeader = (s: string): boolean =>
  ['tanggal', 'tgl', 'date', 'transaction date', 'trn date', 'tx date'].includes(normalizeHeader(s));

export const isDescHeader = (s: string): boolean =>
  ['keterangan', 'uraian', 'description', 'desc', 'transaction description'].includes(normalizeHeader(s));

export const isBranchHeader = (s: string): boolean =>
  ['cabang', 'branch', 'branch code'].includes(normalizeHeader(s));

export const isAmountHeader = (s: string): boolean =>
  ['mutasi', 'amount', 'total amount', 'nominal'].includes(normalizeHeader(s));

export const isDebitHeader = (s: string): boolean =>
  ['debet', 'debit', 'db', 'mutasi debet', 'mutasi debit'].includes(normalizeHeader(s));

export const isCreditHeader = (s: string): boolean =>
  ['kredit', 'credit', 'cr', 'mutasi kredit', 'mutasi credit'].includes(normalizeHeader(s));

export const isBalanceHeader = (s: string): boolean =>
  ['saldo', 'balance', 'running balance', 'saldo akhir'].includes(normalizeHeader(s));

/**
 * Fast RFC-4180 compliant CSV line parser with delimiter auto-detection
 */
export function parseCSVLine(line: string, delimiter: string = ','): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Parses full raw CSV string into 2D array of cells
 */
export function parseRawCSVToRows(text: string): { rows: any[][]; detectedDelimiter: string } {
  // Auto-detect delimiter by checking first lines
  const firstLines = text.split('\n').slice(0, 10).join('\n');
  const commaCount = (firstLines.match(/,/g) || []).length;
  const semicolonCount = (firstLines.match(/;/g) || []).length;
  const detectedDelimiter = semicolonCount > commaCount ? ';' : ',';

  const rows: any[][] = [];
  let currentLine = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      currentLine += char;
    } else if (char === '\n' && !inQuotes) {
      if (currentLine.trim()) {
        rows.push(parseCSVLine(currentLine, detectedDelimiter));
      }
      currentLine = '';
    } else if (char !== '\r') {
      currentLine += char;
    }
  }

  if (currentLine.trim()) {
    rows.push(parseCSVLine(currentLine, detectedDelimiter));
  }

  return { rows, detectedDelimiter };
}

/**
 * Robust Indonesian & English financial number parser
 */
export function parseIndonesianNumber(value: any): number {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return isNaN(value) ? 0 : value;
  const str = String(value).trim();
  if (str === '') return 0;

  // Remove currency symbols and direction tags
  let cleaned = str.replace(/[^\d.,-]/g, '');
  const dotCount = (cleaned.match(/\./g) || []).length;
  const commaCount = (cleaned.match(/,/g) || []).length;
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');

  if (dotCount > 0 && commaCount > 0) {
    if (lastDot < lastComma) {
      // European/Indonesian format: 1.234.567,89
      cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.');
    } else {
      // US/Standard format: 1,234,567.89
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (dotCount > 1) {
    // 1.234.567
    cleaned = cleaned.replace(/\./g, '');
  } else if (commaCount > 1) {
    // 1,234,567
    cleaned = cleaned.replace(/,/g, '');
  } else if (dotCount === 1 && commaCount === 0) {
    const parts = cleaned.split('.');
    if (parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3) {
      // Thousands separator: 1.000
      cleaned = cleaned.replace(/\./g, '');
    }
  } else if (commaCount === 1 && dotCount === 0) {
    const parts = cleaned.split(',');
    if (parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3) {
      // Thousands separator: 1,000
      cleaned = cleaned.replace(/,/g, '');
    } else {
      // Decimal comma: 100,50 -> 100.50
      cleaned = cleaned.replace(/,/g, '.');
    }
  }

  const result = parseFloat(cleaned);
  return isNaN(result) ? 0 : result;
}

/**
 * Clean account number representation for comparison (strips whitespace, hyphens, periods)
 */
export function cleanAccountNumber(acct: string | null | undefined): string {
  if (!acct) return '';
  return String(acct).replace(/[\s\-_.]/g, '').trim();
}

/**
 * Detect statement format from rows
 */
export function detectStatementFormat(rows: any[][]): 'bca_raw_csv' | 'bca_cleaned_csv' | 'generic_csv' {
  if (!rows || rows.length === 0) return 'generic_csv';

  // Check top 10 rows for BCA raw statement signatures
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const rowStr = (rows[i] || []).join(' ').toLowerCase();
    if (
      rowStr.includes('account portfolio') ||
      rowStr.includes('transaction inquiry') ||
      rowStr.includes('account number :') ||
      rowStr.includes('nomor rekening :')
    ) {
      return 'bca_raw_csv';
    }
  }

  // Check for 4-column cleaned CSV format: Transaction Date, Description, Amount, Direction (or empty 4th)
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i] || [];
    if (row.length >= 3 && row.some(isDateHeader) && row.some(isDescHeader) && row.some(isAmountHeader)) {
      // If next row has DB or CR in 4th col or 3rd col
      const nextRow = rows[i + 1] || [];
      if (
        nextRow.length >= 4 &&
        (/^(DB|CR)$/i.test(String(nextRow[3] || '').trim()) || /^(DB|CR)$/i.test(String(nextRow[2] || '').trim()))
      ) {
        return 'bca_cleaned_csv';
      }
    }
  }

  return 'generic_csv';
}

/**
 * Extract comprehensive metadata from statement header and footer rows
 */
export function extractStatementMetadata(
  rows: any[][],
  format: 'bca_raw_csv' | 'bca_cleaned_csv' | 'generic_csv' = 'generic_csv'
): BankStatementMetadata {
  const metadata: BankStatementMetadata = {
    sourceFormat: format,
    hasPendingTransactions: false,
    pendingCount: 0,
  };

  // Pre-scan top rows for Account Number, Name, Period, Currency
  for (let i = 0; i < Math.min(25, rows.length); i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] || '').trim();
      if (!cell) continue;

      // Account number
      const acctMatch = cell.match(/(?:Account Number|Nomor Rekening|No\.?\s*Rekening)\s*[:=]?\s*([0-9\s\-_.]+)/i);
      if (acctMatch && !metadata.accountNumber) {
        metadata.rawAccountNumber = acctMatch[1].trim();
        metadata.accountNumber = cleanAccountNumber(acctMatch[1]);
      }

      // Name
      const nameMatch = cell.match(/(?:Name|Nama|Account Name)\s*[:=]\s*(.+)$/i);
      if (nameMatch && !metadata.accountName) {
        metadata.accountName = nameMatch[1].trim();
      }

      // Period
      const pMatch = cell.match(
        /Period(?:e)?\s*[:=]?\s*(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})\s*-\s*(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/i
      );
      if (pMatch && !metadata.startDate) {
        const sDay = parseInt(pMatch[1]), sMon = parseInt(pMatch[2]);
        let sYr = parseInt(pMatch[3]);
        const eDay = parseInt(pMatch[4]), eMon = parseInt(pMatch[5]);
        let eYr = parseInt(pMatch[6]);
        if (sYr < 100) sYr += 2000;
        if (eYr < 100) eYr += 2000;
        metadata.startDate = `${sYr}-${String(sMon).padStart(2, '0')}-${String(sDay).padStart(2, '0')}`;
        metadata.endDate = `${eYr}-${String(eMon).padStart(2, '0')}-${String(eDay).padStart(2, '0')}`;
        metadata.period = `${String(sDay).padStart(2, '0')}/${String(sMon).padStart(2, '0')}/${sYr} - ${String(eDay).padStart(2, '0')}/${String(eMon).padStart(2, '0')}/${eYr}`;
      }

      // Currency
      const cMatch = cell.match(/(?:Currency Code|Mata Uang)\s*[:=]?\s*([A-Za-z]+)/i);
      if (cMatch && !metadata.currency) {
        const rawC = cMatch[1].toUpperCase().trim();
        metadata.currency = rawC === 'RP' ? 'IDR' : rawC;
      }
    }
  }

  // Scan footer rows for opening/closing balances and mutasi totals
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const rowJoined = row.map((c) => String(c || '').trim()).join(' ');

    const mStart = rowJoined.match(/(?:Saldo\s*Awal|Start\s*Balance|Opening\s*Balance)\s*[:=]?\s*([\d,.]+)/i);
    if (mStart && metadata.openingBalance === undefined) {
      metadata.openingBalance = parseIndonesianNumber(mStart[1]);
    }

    const mDebit = rowJoined.match(/(?:Mutasi\s*Deb[ei]t|Mutasi\s*DB)\s*[:=]?\s*([\d,.]+)/i);
    if (mDebit && metadata.totalDebits === undefined) {
      metadata.totalDebits = parseIndonesianNumber(mDebit[1]);
      // Check if count is present in cell 1 (e.g. ["Mutasi Debit : 1,144,052,374.00", "56"])
      if (row.length > 1 && /^\d+$/.test(String(row[1] || '').trim())) {
        metadata.debitCountSummary = parseInt(String(row[1]).trim());
      }
    }

    const mCredit = rowJoined.match(/(?:Mutasi\s*Kredit|Mutasi\s*Credit|Mutasi\s*CR)\s*[:=]?\s*([\d,.]+)/i);
    if (mCredit && metadata.totalCredits === undefined) {
      metadata.totalCredits = parseIndonesianNumber(mCredit[1]);
      if (row.length > 1 && /^\d+$/.test(String(row[1] || '').trim())) {
        metadata.creditCountSummary = parseInt(String(row[1]).trim());
      }
    }

    const mLast = rowJoined.match(
      /(?:Saldo\s*Akhir|Last\s*Balance|Ending\s*Balance|Closing\s*Balance)\s*[:=]?\s*([\d,.]+)/i
    );
    if (mLast && metadata.closingBalance === undefined) {
      metadata.closingBalance = parseIndonesianNumber(mLast[1]);
    }
  }

  return metadata;
}

/**
 * Matches an extracted account number against a list of configured ERP bank accounts.
 * Strips whitespace, hyphens, and periods to ensure 0930201014 matches 0930 2010 14.
 */
export function matchConfiguredBankAccount(
  extractedAccountNumber: string | undefined,
  bankAccounts: BankAccountOption[]
): BankAccountOption | null {
  if (!extractedAccountNumber || !bankAccounts || bankAccounts.length === 0) return null;
  const cleanTarget = cleanAccountNumber(extractedAccountNumber);
  if (!cleanTarget) return null;

  return bankAccounts.find((acc) => cleanAccountNumber(acc.account_number) === cleanTarget) || null;
}

/**
 * Returns a date formatted as YYYY-MM-DD in Asia/Jakarta time (WIB, UTC+7).
 */
export function getJakartaDateString(date: Date = new Date()): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(date);
  } catch (_e) {
    const jakartaTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
    return jakartaTime.toISOString().split('T')[0];
  }
}

/**
 * Returns today's date formatted as YYYY-MM-DD in Asia/Jakarta time (WIB, UTC+7).
 */
export function getJakartaTodayString(): string {
  return getJakartaDateString(new Date());
}

/**
 * Core Parser and Normalizer
 * Transforms any supported CSV / Excel 2D array into canonical NormalizedBankTransactions,
 * extracting metadata, PEND rows, and running validation.
 */
export function parseAndNormalizeStatement(
  rows: any[][],
  options: NormalizerOptions = {}
): {
  lines: NormalizedBankTransaction[];
  metadata: BankStatementMetadata;
  validation: StatementValidationResult;
} {
  const format = detectStatementFormat(rows);
  const metadata = extractStatementMetadata(rows, format);

  const todayStr = options.todayDate || getJakartaTodayString();
  let defaultYear = options.defaultYear;

  // Derive defaultYear from period if available
  if (!defaultYear && metadata.startDate) {
    defaultYear = parseInt(metadata.startDate.substring(0, 4));
  }
  if (!defaultYear) {
    defaultYear = new Date().getFullYear();
  }

  // 1. Locate header row
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(25, rows.length); i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    if (
      row.some(isDateHeader) &&
      (row.some(isDescHeader) || row.some(isAmountHeader) || row.some(isDebitHeader))
    ) {
      headerRowIdx = i;
      break;
    }
  }

  if (headerRowIdx === -1) {
    throw new Error('Could not find transaction header row (Transaction Date, Description, Amount).');
  }

  const headerRow = rows[headerRowIdx];
  let dateCol = -1,
    descCol = -1,
    branchCol = -1,
    amountCol = -1,
    balanceCol = -1,
    debitCol = -1,
    creditCol = -1,
    dirCol = -1;

  headerRow.forEach((cell: any, idx: number) => {
    const s = String(cell || '');
    if (isDateHeader(s)) dateCol = idx;
    else if (isDescHeader(s)) descCol = idx;
    else if (isBranchHeader(s)) branchCol = idx;
    else if (isDebitHeader(s)) debitCol = idx;
    else if (isCreditHeader(s)) creditCol = idx;
    else if (isAmountHeader(s)) amountCol = idx;
    else if (isBalanceHeader(s)) balanceCol = idx;
    else if (normalizeHeader(s) === 'direction' || normalizeHeader(s) === 'dir') dirCol = idx;
  });

  // If 4-column cleaned CSV with no header in col 3 (e.g. Transaction Date, Description, Amount, "")
  if (dirCol === -1 && amountCol >= 0 && headerRow.length > amountCol + 1) {
    // Check if subsequent rows have DB/CR in the adjacent column
    for (let i = headerRowIdx + 1; i < Math.min(headerRowIdx + 5, rows.length); i++) {
      const val = String(rows[i]?.[amountCol + 1] || '').trim().toUpperCase();
      if (val === 'DB' || val === 'CR') {
        dirCol = amountCol + 1;
        break;
      }
    }
  }

  if (dateCol === -1) {
    throw new Error('Date column could not be identified in the transaction header.');
  }

  const lines: NormalizedBankTransaction[] = [];
  let pendingCount = 0;

  // 2. Process data rows
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0 || row.every((c) => !String(c || '').trim())) continue;

    const rowText = row
      .map((c) => String(c || '').toUpperCase().trim())
      .join(' ');

    // Detect summary footers
    if (
      rowText.includes('SALDO AWAL') ||
      rowText.includes('START BALANCE') ||
      rowText.includes('OPENING BALANCE')
    ) {
      continue;
    }

    if (
      rowText.includes('MUTASI DEBET') ||
      rowText.includes('MUTASI DEBIT') ||
      rowText.includes('MUTASI KREDIT') ||
      rowText.includes('MUTASI CREDIT') ||
      rowText.includes('MUTASI DB') ||
      rowText.includes('MUTASI CR') ||
      rowText.includes('SALDO AKHIR') ||
      rowText.includes('LAST BALANCE') ||
      rowText.includes('CLOSING BALANCE') ||
      rowText.includes('ENDING BALANCE')
    ) {
      break;
    }

    const rawDateVal = String(row[dateCol] || '').trim();
    if (!rawDateVal) continue;

    let parsedDate = '';
    let isPending = false;
    const originalDate = rawDateVal;

    // Check for PEND rows
    if (rawDateVal.toUpperCase() === 'PEND') {
      isPending = true;
      pendingCount++;
      parsedDate = todayStr; // Pre-fill with today's date
    } else {
      // Normal date parsing
      const fullDateMatch = rawDateVal.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
      const numericMatch = rawDateVal.match(/^(\d{1,2})[.\-/](\d{1,2})$/);
      const namedMatch = rawDateVal.match(/^(\d{1,2})[-\s]([A-Za-z]{3,4})(?:[-\s](\d{2,4}))?$/);

      const monthNames: Record<string, number> = {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5,
        jun: 6, jul: 7, aug: 8, agu: 8, ags: 8, sep: 9,
        oct: 10, okt: 10, nov: 11, dec: 12, des: 12,
      };

      let day = 0, mon = 0, yr = defaultYear;

      if (fullDateMatch) {
        day = parseInt(fullDateMatch[1]);
        mon = parseInt(fullDateMatch[2]);
        const rawYr = parseInt(fullDateMatch[3]);
        yr = rawYr < 100 ? (rawYr < 70 ? 2000 + rawYr : 1900 + rawYr) : rawYr;
      } else if (numericMatch) {
        day = parseInt(numericMatch[1]);
        mon = parseInt(numericMatch[2]);
      } else if (namedMatch) {
        day = parseInt(namedMatch[1]);
        mon = monthNames[namedMatch[2].toLowerCase()] || 0;
        if (namedMatch[3]) {
          const rawYr = parseInt(namedMatch[3]);
          yr = rawYr < 100 ? (rawYr < 70 ? 2000 + rawYr : 1900 + rawYr) : rawYr;
        }
      }

      if (day < 1 || day > 31 || mon < 1 || mon > 12) {
        // Not a valid date row, skip
        continue;
      }

      parsedDate = `${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    // Amount & Direction extraction
    let debit = 0;
    let credit = 0;

    if (debitCol >= 0 && creditCol >= 0) {
      const debitStr = String(row[debitCol] || '').trim();
      const creditStr = String(row[creditCol] || '').trim();
      debit = parseIndonesianNumber(debitStr);
      credit = parseIndonesianNumber(creditStr);
    } else if (amountCol >= 0) {
      const rawAmountStr = String(row[amountCol] || '').trim();
      let isCR = /\bCR\b/i.test(rawAmountStr);
      let isDB = /\bDB\b/i.test(rawAmountStr);

      if (!isCR && !isDB) {
        if (dirCol >= 0 && row[dirCol] !== undefined) {
          const dirVal = String(row[dirCol] || '').trim().toUpperCase();
          if (dirVal === 'CR') isCR = true;
          else if (dirVal === 'DB') isDB = true;
        }
      }

      // Check other unassigned columns for standalone CR/DB
      if (!isCR && !isDB) {
        for (let c = 0; c < row.length; c++) {
          if (c === amountCol || c === dateCol || c === descCol || c === branchCol || c === balanceCol) continue;
          const val = String(row[c] || '').trim().toUpperCase();
          if (val === 'CR') {
            isCR = true;
            break;
          }
          if (val === 'DB') {
            isDB = true;
            break;
          }
        }
      }

      const cleanAmountStr = rawAmountStr.replace(/\b(CR|DB)\b/gi, '').trim();
      const amount = parseIndonesianNumber(cleanAmountStr);

      if (isCR) {
        credit = amount;
        debit = 0;
      } else if (isDB) {
        debit = amount;
        credit = 0;
      }
    }

    // Running Balance (never imported as income/expense)
    let balance = 0;
    if (balanceCol >= 0 && row[balanceCol] !== undefined && row[balanceCol] !== null) {
      balance = parseIndonesianNumber(row[balanceCol]);
    }

    // Description: Preserve original description without modifications
    const primaryDesc = descCol >= 0 ? String(row[descCol] || '').trim() : '';
    const descParts: string[] = primaryDesc ? [primaryDesc] : [];

    // Check for supplementary description tokens in unmapped columns
    let extraRef = '';
    for (let c = 0; c < row.length; c++) {
      if (
        c === descCol ||
        c === dateCol ||
        c === branchCol ||
        c === debitCol ||
        c === creditCol ||
        c === amountCol ||
        c === balanceCol ||
        c === dirCol
      ) {
        continue;
      }

      const cellVal = String(row[c] || '').trim();
      if (!cellVal) continue;
      if (/^(CR|DB)$/i.test(cellVal)) continue;

      if (/^\d{6,10}-\d+$/.test(cellVal) && !extraRef) {
        extraRef = cellVal;
      }

      descParts.push(cellVal);
    }

    const description = descParts.join(' ').replace(/\s+/g, ' ').trim();
    const branch = branchCol >= 0 ? String(row[branchCol] || '').trim() : '';

    let reference = branch || extraRef;
    if (!reference) {
      const refMatch = description.match(/\b(\d{4}\/[A-Z0-9]+\/[A-Z0-9]+)\b/);
      if (refMatch) {
        reference = refMatch[1];
      }
    }

    const numDebit = Number(debit) || 0;
    const numCredit = Number(credit) || 0;

    const isValid = (numDebit > 0 && numCredit === 0) || (numCredit > 0 && numDebit === 0);
    if (!isValid) {
      throw new Error(
        `Bank statement line at row ${i + 1} (${parsedDate}) must have exactly one positive debit or credit amount. Found debit=${numDebit}, credit=${numCredit}. Description: "${description}"`
      );
    }

    lines.push({
      id: `parsed-${i}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      date: parsedDate,
      originalDate: isPending ? 'PEND' : originalDate,
      isPending,
      description,
      reference,
      branchCode: branch || undefined,
      debit: numDebit,
      credit: numCredit,
      balance,
      currency: metadata.currency || options.fallbackCurrency || 'IDR',
      status: isPending ? 'pending_date_required' : 'unmatched',
      notes: isPending ? '[BCA Source: PEND]' : undefined,
    });
  }

  metadata.hasPendingTransactions = pendingCount > 0;
  metadata.pendingCount = pendingCount;

  // Run statement validation
  const validation = validateStatementTotals(lines, metadata);

  return { lines, metadata, validation };
}

/**
 * Validates statement totals using the fundamental equation:
 * Opening Balance + Total Credits - Total Debits = Closing Balance
 */
export function validateStatementTotals(
  lines: NormalizedBankTransaction[],
  metadata: BankStatementMetadata
): StatementValidationResult {
  const debitLines = lines.filter((l) => l.debit > 0);
  const creditLines = lines.filter((l) => l.credit > 0);

  const totalDebits = debitLines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  const totalCredits = creditLines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0);

  const openingBalance = Number(metadata.openingBalance || 0);
  const closingBalance =
    metadata.closingBalance !== undefined && metadata.closingBalance !== null
      ? Number(metadata.closingBalance)
      : lines.length > 0 && lines[lines.length - 1].balance
        ? Number(lines[lines.length - 1].balance)
        : openingBalance + totalCredits - totalDebits;

  const calculatedClosingBalance = openingBalance + totalCredits - totalDebits;
  const discrepancy = Math.abs(calculatedClosingBalance - closingBalance);

  // Check if mutasi summary totals from footer match computed sums
  const summaryDebitsMatch =
    metadata.totalDebits !== undefined ? Math.abs(metadata.totalDebits - totalDebits) < 0.05 : true;
  const summaryCreditsMatch =
    metadata.totalCredits !== undefined ? Math.abs(metadata.totalCredits - totalCredits) < 0.05 : true;

  const isReconciled =
    (metadata.openingBalance === undefined && metadata.closingBalance === undefined) ||
    discrepancy < 0.05;

  let message = '';
  if (isReconciled && summaryDebitsMatch && summaryCreditsMatch) {
    message = 'Statement reconciled perfectly (Opening + Credits - Debits = Closing)';
  } else if (!isReconciled) {
    message = `Balance discrepancy: Opening (${openingBalance.toLocaleString()}) + Credits (${totalCredits.toLocaleString()}) - Debits (${totalDebits.toLocaleString()}) = Calculated (${calculatedClosingBalance.toLocaleString()}) vs Reported Closing (${closingBalance.toLocaleString()}) (Diff: Rp ${discrepancy.toLocaleString()})`;
  } else {
    message = `Mutasi discrepancy with statement summary: computed Debits=${totalDebits.toLocaleString()} (summary=${metadata.totalDebits?.toLocaleString()}), Credits=${totalCredits.toLocaleString()} (summary=${metadata.totalCredits?.toLocaleString()})`;
  }

  return {
    isValid: isReconciled && summaryDebitsMatch && summaryCreditsMatch,
    openingBalance,
    closingBalance,
    calculatedClosingBalance,
    totalDebits,
    totalCredits,
    debitCount: debitLines.length,
    creditCount: creditLines.length,
    discrepancy,
    summaryDebitsMatch,
    summaryCreditsMatch,
    message,
  };
}

/**
 * Checks for duplicates against existing database lines using canonical composite key.
 * If pendingDates mapping is supplied, uses confirmed effective dates for pending lines.
 */
export function checkStatementDuplicates(
  lines: NormalizedBankTransaction[],
  existingLines: any[],
  pendingDates?: Record<string, string>
): {
  newLines: NormalizedBankTransaction[];
  duplicateLines: NormalizedBankTransaction[];
  duplicateCount: number;
} {
  const normalizeDesc = (desc: string) => (desc || '').toLowerCase().replace(/\s+/g, ' ').trim();

  const dbKeyCounts = new Map<string, number>();
  (existingLines || []).forEach((e) => {
    const k = `${e.transaction_date}|${Number(e.debit_amount) || 0}|${Number(e.credit_amount) || 0}|${(e.reference || '').trim().toLowerCase()}|${normalizeDesc(e.description || '')}`;
    dbKeyCounts.set(k, (dbKeyCounts.get(k) || 0) + 1);
  });

  const csvKeyCounts = new Map<string, number>();
  const newLines: NormalizedBankTransaction[] = [];
  const duplicateLines: NormalizedBankTransaction[] = [];

  lines.forEach((line) => {
    // If pending and a confirmed date is supplied, evaluate duplicate matching with confirmed date
    const effectiveDate =
      line.isPending && pendingDates && pendingDates[line.id]
        ? pendingDates[line.id]
        : line.date;

    const key = `${effectiveDate}|${Number(line.debit) || 0}|${Number(line.credit) || 0}|${(line.reference || '').trim().toLowerCase()}|${normalizeDesc(line.description || '')}`;
    const csvOccurrence = csvKeyCounts.get(key) || 0;
    csvKeyCounts.set(key, csvOccurrence + 1);
    const dbCount = dbKeyCounts.get(key) || 0;

    if (csvOccurrence < dbCount) {
      duplicateLines.push({ ...line, date: effectiveDate, status: 'duplicate' });
    } else {
      newLines.push({ ...line, date: effectiveDate });
    }
  });

  return {
    newLines,
    duplicateLines,
    duplicateCount: duplicateLines.length,
  };
}
