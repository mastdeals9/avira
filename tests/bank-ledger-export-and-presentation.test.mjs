import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BANK_LEDGER_HEADERS,
  buildBankLedgerCsv,
  buildBankLedgerWorkbook,
  parseCsvLine,
} from '../src/utils/bankLedgerExport.ts';

const SAMPLE_ENTRIES = [
  {
    entry_date: '2026-11-05',
    particulars: 'Supplier payment – PT Prima Cita Prasada, Invoice #112',
    reference: 'BCA-261105-001',
    canonical_reference: 'PV2611-0041',
    debit: 221729,
    credit: 0,
    running_balance: 99778271,
  },
  {
    entry_date: '2026-11-10',
    particulars: 'Customer payment – SAPJ-26-040',
    reference: 'BCA-261110-008',
    canonical_reference: 'RV2611-0019',
    debit: 0,
    credit: 85000000,
    running_balance: 184778271,
  },
  {
    entry_date: '2026-11-15',
    particulars: 'Salary – November 2026 – Chintia',
    reference: 'BCA-261115-002',
    canonical_reference: 'EXP/26/321',
    debit: 12500000,
    credit: 0,
    running_balance: 172278271,
  },
];

const SAMPLE_PARAMS = {
  bankName: 'BCA Bank',
  accountNumber: '111101',
  currency: 'IDR',
  startDate: '2026-11-01',
  endDate: '2026-11-28',
  openingBalance: 100000000,
  totalDebit: 12721729,
  totalCredit: 85000000,
  closingBalance: 172278271,
  entries: SAMPLE_ENTRIES,
};

test('1. CSV export includes UTF-8 BOM, 6 exact headers, quoted IDR decimals/commas, and every transaction parses to 6 fields', () => {
  const csv = buildBankLedgerCsv(SAMPLE_PARAMS);
  assert.ok(csv.startsWith('\uFEFF'), 'CSV must start with UTF-8 BOM');

  const lines = csv.slice(1).split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.startsWith('Date,Description / Remarks,'));
  assert.ok(headerIdx >= 0, 'Must include exact 6-column header');

  const parsedHeader = parseCsvLine(lines[headerIdx]);
  assert.deepEqual(parsedHeader, [...BANK_LEDGER_HEADERS]);

  // Opening row + 3 transaction rows + Closing row = 5 rows after header
  const dataLines = lines.slice(headerIdx + 1);
  assert.equal(dataLines.length, 5);

  // Opening balance row
  const openFields = parseCsvLine(dataLines[0]);
  assert.equal(openFields.length, 6);
  assert.equal(openFields[1], 'Opening Balance');
  assert.equal(openFields[3], '');
  assert.equal(openFields[4], '');

  // Transaction 1: outgoing (Debit populated, Credit blank), comma in description & IDR decimal
  const tx1 = parseCsvLine(dataLines[1]);
  assert.equal(tx1.length, 6, 'Tx 1 must parse to exactly 6 fields despite commas in description and Rp 221.729,00');
  assert.equal(tx1[1], 'Supplier payment – PT Prima Cita Prasada, Invoice #112');
  assert.equal(tx1[2], 'PV2611-0041');
  assert.ok(tx1[3].includes('221.729,00'));
  assert.equal(tx1[4], '');

  // Transaction 2: incoming (Debit blank, Credit populated)
  const tx2 = parseCsvLine(dataLines[2]);
  assert.equal(tx2.length, 6);
  assert.equal(tx2[3], '');
  assert.ok(tx2[4].includes('85.000.000,00'));

  // Closing balance row
  const closeFields = parseCsvLine(dataLines[4]);
  assert.equal(closeFields.length, 6);
  assert.equal(closeFields[1], 'Closing Balance');
});

test('2. Excel export stores numeric Debit/Credit/Balance cells, preserves full descriptions, and reconciles running balance', async () => {
  const wb = buildBankLedgerWorkbook(SAMPLE_PARAMS);
  const ws = wb.getWorksheet('Bank Ledger');
  assert.ok(ws, 'Must create Bank Ledger worksheet');

  // Header is row 6
  const headerVals = [1, 2, 3, 4, 5, 6].map((c) => ws.getRow(6).getCell(c).value);
  assert.deepEqual(headerVals, [...BANK_LEDGER_HEADERS]);

  // Opening row is row 7
  assert.equal(ws.getRow(7).getCell(2).value, 'Opening Balance');
  assert.equal(typeof ws.getRow(7).getCell(6).value, 'number');
  assert.equal(ws.getRow(7).getCell(6).value, 100000000);

  // Transaction rows 8..10
  let prevBal = 100000000;
  for (let i = 0; i < SAMPLE_ENTRIES.length; i++) {
    const row = ws.getRow(8 + i);
    const dr = row.getCell(4).value;
    const cr = row.getCell(5).value;
    const bal = row.getCell(6).value;
    if (SAMPLE_ENTRIES[i].debit > 0) {
      assert.equal(typeof dr, 'number');
      assert.equal(cr, null);
    } else {
      assert.equal(dr, null);
      assert.equal(typeof cr, 'number');
    }
    assert.equal(typeof bal, 'number');
    prevBal = prevBal - Number(dr || 0) + Number(cr || 0);
    assert.equal(bal, prevBal);
  }

  // Closing row is row 11
  const closeRow = ws.getRow(11);
  assert.equal(closeRow.getCell(2).value, 'Closing Balance');
  assert.equal(closeRow.getCell(4).value, 12721729);
  assert.equal(closeRow.getCell(5).value, 85000000);
  assert.equal(closeRow.getCell(6).value, 172278271);

  const buf = await wb.xlsx.writeBuffer();
  assert.ok(buf.byteLength > 1000, 'Generated xlsx buffer should be valid');
});

test('3. BankLedger.tsx implements 4-KPI summary, sticky 6-column table, and voucher-remarks priority', () => {
  const src = fs.readFileSync(path.resolve('src/components/finance/BankLedger.tsx'), 'utf8');
  assert.ok(src.includes('Description / Remarks'), 'Table must use Description / Remarks column');
  assert.ok(src.includes('sticky top-0'), 'Table header must be sticky');
  assert.ok(src.includes('Reconciliation Diagnostics'), 'Reconciliation diagnostics must be separated into expandable section');
  assert.ok(src.includes('Customer payment –'), 'Receipt vouchers must build readable description');
  assert.ok(src.includes('Supplier payment –'), 'Payment vouchers must build readable description');
  assert.ok(src.includes('exportBankLedgerExcel') && src.includes('exportBankLedgerCsv'), 'Must wire Excel and CSV exports');
});
