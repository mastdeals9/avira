import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';

test('1. Normal XLSX reading and writing roundtrip', () => {
  const wb = XLSX.utils.book_new();
  const sampleData = [
    { Code: 'EXP/26/281', Employee: 'Nia', Gross: 8120000, PPh21: 120000, Net: 8000000, Active: true },
    { Code: 'EXP/26/282', Employee: 'Chintia', Gross: 3800000, PPh21: 0, Net: 3800000, Active: true }
  ];

  const ws = XLSX.utils.json_to_sheet(sampleData);
  XLSX.utils.book_append_sheet(wb, ws, 'Staff Salaries');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  assert.ok(buf.length > 0, 'Workbook buffer should be generated');

  const readWb = XLSX.read(buf, { type: 'buffer' });
  assert.equal(readWb.SheetNames[0], 'Staff Salaries');
  const readData = XLSX.utils.sheet_to_json(readWb.Sheets['Staff Salaries']);

  assert.equal(readData.length, 2);
  assert.equal(readData[0].Code, 'EXP/26/281');
  assert.equal(readData[0].Gross, 8120000);
  assert.equal(readData[1].Employee, 'Chintia');
  assert.equal(readData[1].Net, 3800000);
});

test('2. Prototype-pollution payload resistance (CVE-2023-30533 / GHSA-4r6h-8v6p-xvw6)', () => {
  // Before test, confirm clean Object prototype
  assert.equal(Object.prototype.polluted, undefined, 'Clean prototype before test');
  assert.equal(Object.prototype.isAdmin, undefined, 'Clean prototype before test');

  // Construct sheet with prototype pollution attack keys
  const maliciousRows = [
    { '__proto__': { polluted: 'YES' }, 'constructor': { 'prototype': { isAdmin: true } } },
    { '__proto__.polluted': 'YES', 'constructor.prototype.isAdmin': 'YES' }
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(maliciousRows);
  XLSX.utils.book_append_sheet(wb, ws, '__proto__');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const parsedWb = XLSX.read(buf, { type: 'buffer' });
  const parsedData = XLSX.utils.sheet_to_json(parsedWb.Sheets[parsedWb.SheetNames[0]]);

  // Verify that Object prototype was NOT polluted
  assert.equal(Object.prototype.polluted, undefined, 'Object.prototype.polluted must remain undefined');
  assert.equal(Object.prototype.isAdmin, undefined, 'Object.prototype.isAdmin must remain undefined');
  assert.equal({}.polluted, undefined, 'Plain object must not have polluted property');
  assert.equal({}.isAdmin, undefined, 'Plain object must not have isAdmin property');
});

test('3. ReDoS resilience against pathological string and formula patterns', () => {
  const start = Date.now();

  // Pathological patterns within Excel 32,767 char cell limit
  const pathologicalStrings = [
    'A'.repeat(30000),
    '='.repeat(50) + 'SUM(' + 'A1,'.repeat(500) + 'A500)',
    '((((((((((((((((((((((((((((((((((((((((hello))))))))))))))))))))))))))))))))))))))))',
    '9'.repeat(1000) + '!' + 'A'.repeat(1000)
  ];

  const wb = XLSX.utils.book_new();
  const rows = pathologicalStrings.map((s, idx) => ({ id: idx, payload: s }));
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'ReDoS_Test');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const readWb = XLSX.read(buf, { type: 'buffer' });
  const readData = XLSX.utils.sheet_to_json(readWb.Sheets['ReDoS_Test']);

  const duration = Date.now() - start;
  assert.ok(duration < 2000, `Parsing should finish well under 2s without ReDoS hang (took ${duration}ms)`);
  assert.equal(readData.length, 4);
});

test('4. Malformed spreadsheets and corrupted data handling', () => {
  // Truncated / malformed binary zip
  const corruptedBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
  assert.throws(() => {
    XLSX.read(corruptedBuffer, { type: 'buffer' });
  }, /corrupted|bad|end of data|Cannot find|zip/i, 'Corrupted buffer should throw catchable error');

  // Corrupted zip with invalid central directory
  const invalidZip = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('some fake data that is not a valid zip archive')
  ]);
  assert.throws(() => {
    XLSX.read(invalidZip, { type: 'buffer' });
  }, 'Corrupted zip header should throw catchable error');
});

test('5. Missing worksheets and empty column structures', () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.book_append_sheet(wb, ws, 'EmptySheet');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const readWb = XLSX.read(buf, { type: 'buffer' });
  const readData = XLSX.utils.sheet_to_json(readWb.Sheets['EmptySheet']);

  assert.deepEqual(readData, [], 'Empty sheet should parse to empty array');

  // Sheet with only header row
  const headerOnlyWs = XLSX.utils.aoa_to_sheet([['Date', 'Description', 'Amount']]);
  XLSX.utils.book_append_sheet(wb, headerOnlyWs, 'HeaderOnly');
  const buf2 = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const readWb2 = XLSX.read(buf2, { type: 'buffer' });
  const readData2 = XLSX.utils.sheet_to_json(readWb2.Sheets['HeaderOnly']);
  assert.deepEqual(readData2, [], 'Header-only sheet should parse to empty array of records');
});

test('6. High-volume synthetic dataset (10,000 rows) performance and stability', () => {
  const start = Date.now();
  const largeDataset = [];
  for (let i = 0; i < 10000; i++) {
    largeDataset.push({
      id: i + 1,
      batch: `BATCH-2026-${String(i).padStart(5, '0')}`,
      item: `Pharmaceutical API Raw Material #${(i % 100) + 1}`,
      qty: (i * 2.5) % 1000,
      price_usd: 125.50,
      total_usd: ((i * 2.5) % 1000) * 125.50
    });
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(largeDataset);
  XLSX.utils.book_append_sheet(wb, ws, 'BatchInventory');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const readWb = XLSX.read(buf, { type: 'buffer' });
  const readData = XLSX.utils.sheet_to_json(readWb.Sheets['BatchInventory']);

  const duration = Date.now() - start;
  assert.equal(readData.length, 10000, 'Should read all 10,000 rows');
  assert.ok(duration < 4000, `10,000 rows should write and parse in under 4 seconds (took ${duration}ms)`);
});

test('7. Indonesian number and date format parsing', () => {
  // Test Indonesian number strings: "1.250.000,50" -> 1250000.50
  function parseIndonesianNumber(str) {
    if (typeof str === 'number') return str;
    if (!str) return 0;
    // Replace thousands periods, then replace decimal comma with period
    const cleaned = String(str).trim().replace(/\./g, '').replace(/,/g, '.');
    return parseFloat(cleaned) || 0;
  }

  assert.equal(parseIndonesianNumber('1.250.000,50'), 1250000.5);
  assert.equal(parseIndonesianNumber('8.500.000'), 8500000);
  assert.equal(parseIndonesianNumber('767.520,00'), 767520);
  assert.equal(parseIndonesianNumber(1250000), 1250000);

  // Test Indonesian date strings
  function parseIndonesianDate(cellStr, defaultYear = 2026) {
    const s = String(cellStr).trim();
    // DD/MM/YYYY
    const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (dmy) {
      return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
    // DD/MM (typical in BCA e-statement lines)
    const dm = s.match(/^(\d{1,2})[/-](\d{1,2})$/);
    if (dm) {
      return `${defaultYear}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    }
    return s;
  }

  assert.equal(parseIndonesianDate('14/10/2026'), '2026-10-14');
  assert.equal(parseIndonesianDate('01/10'), '2026-10-01');
  assert.equal(parseIndonesianDate('31-10-2026'), '2026-10-31');
});

test('8. Synthetic BCA Bank Statement layout parsing and accuracy', () => {
  // Construct synthetic BCA statement grid mimicking BCA e-statement export
  const bcaGrid = [
    ['REKENING KORAN'],
    ['PT SHUBHAM ANZEN PHARMA JAYA'],
    ['Periode : 01/10/2026 - 31/10/2026'],
    ['Mata Uang : IDR'],
    [],
    ['Tanggal', 'Keterangan', 'CB', 'Mutasi', 'Saldo'],
    ['01/10', 'TRSF E-BANKING CR 0110/FTFVA/WS95051 BPJS KETENAGAKERJAAN', '0000', '767.520,00 DB', '1.500.232.450,00'],
    ['05/10', 'TRSF E-BANKING DB PT KALBE FARMA TBK INV-26-0091', '0000', '150.000.000,00 CR', '1.650.232.450,00'],
    ['14/10', 'BIAYA ADM', '0000', '25.000,00 DB', '1.650.207.450,00'],
    ['Saldo Awal', '1.501.000.000,00'],
    ['Total Mutasi Debet', '792.520,00'],
    ['Total Mutasi Kredit', '150.000.000,00'],
    ['Saldo Akhir', '1.650.207.450,00']
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(bcaGrid);
  XLSX.utils.book_append_sheet(wb, ws, 'BCA_Statement');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const readWb = XLSX.read(buf, { type: 'buffer' });
  const rawRows = XLSX.utils.sheet_to_json(readWb.Sheets['BCA_Statement'], { header: 1 });

  // Simulate BankReconciliationEnhanced statement parsing
  let period = '';
  let currency = '';
  let headerIdx = -1;

  for (let i = 0; i < 10; i++) {
    const row = rawRows[i] || [];
    for (const cell of row) {
      const s = String(cell || '').trim();
      const pMatch = s.match(/Periode\s*:\s*(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/i);
      if (pMatch) {
        period = `${pMatch[1]}/${pMatch[2]}/${pMatch[3]} - ${pMatch[4]}/${pMatch[5]}/${pMatch[6]}`;
      }
      const cMatch = s.match(/Mata Uang\s*:\s*([A-Z]+)/i);
      if (cMatch) {
        currency = cMatch[1];
      }
    }
    if (row.includes('Tanggal') && row.includes('Keterangan') && row.includes('Mutasi')) {
      headerIdx = i;
      break;
    }
  }

  assert.equal(period, '01/10/2026 - 31/10/2026');
  assert.equal(currency, 'IDR');
  assert.ok(headerIdx >= 0, 'Header row should be located');

  const transactions = [];
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (!r || !r[0] || String(r[0]).startsWith('Saldo') || String(r[0]).startsWith('Total')) break;

    const dateStr = r[0];
    const desc = r[1];
    const mutasi = r[3];
    const saldo = r[4];

    const isDb = String(mutasi).includes('DB');
    const isCr = String(mutasi).includes('CR');
    const amountVal = parseFloat(String(mutasi).replace(/[^\d,]/g, '').replace(',', '.')) || 0;

    transactions.push({
      date: `2026-10-${dateStr.split('/')[0].padStart(2, '0')}`,
      desc,
      debit: isDb ? amountVal : 0,
      credit: isCr ? amountVal : 0,
      balance: parseFloat(String(saldo).replace(/[^\d,]/g, '').replace(',', '.')) || 0
    });
  }

  assert.equal(transactions.length, 3);
  assert.equal(transactions[0].date, '2026-10-01');
  assert.ok(transactions[0].desc.includes('BPJS KETENAGAKERJAAN'));
  assert.equal(transactions[0].debit, 767520);
  assert.equal(transactions[0].credit, 0);

  assert.equal(transactions[1].date, '2026-10-05');
  assert.ok(transactions[1].desc.includes('KALBE FARMA'));
  assert.equal(transactions[1].debit, 0);
  assert.equal(transactions[1].credit, 150000000);
});

test('9. Synthetic Mandiri Bank Statement layout parsing and accuracy', () => {
  const mandiriGrid = [
    ['BANK MANDIRI REKENING KORAN'],
    ['Account No: 123-00-9876543-2'],
    ['Currency: IDR'],
    ['Period: 01/10/2026 - 31/10/2026'],
    [],
    ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
    ['2026-10-01', 'BPJS KETENAGAKERJAAN 26719331', 767520, 0, 999232480],
    ['2026-10-03', 'CUSTOMER PAYMENT PT KIMIA FARMA', 0, 85000000, 1084232480],
    ['2026-10-31', 'BANK ADMIN FEE', 15000, 0, 1084217480]
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(mandiriGrid);
  XLSX.utils.book_append_sheet(wb, ws, 'Mandiri');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const readWb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(readWb.Sheets['Mandiri'], { header: 1 });

  const txRows = rows.slice(6);
  assert.equal(txRows.length, 3);
  assert.equal(txRows[0][0], '2026-10-01');
  assert.equal(txRows[0][2], 767520);
  assert.equal(txRows[1][3], 85000000);
  assert.equal(txRows[2][2], 15000);
});
