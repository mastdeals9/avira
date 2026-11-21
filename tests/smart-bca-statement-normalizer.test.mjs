#!/usr/bin/env node
/**
 * tests/smart-bca-statement-normalizer.test.mjs
 * 
 * Verifies Smart BCA Statement Importer and Normalizer against the exact user-supplied files:
 * 1. Raw original BCA export: CorpAcctTrxn2026112092828187.csv (75 lines, 63 txns, 1 PEND row)
 * 2. Manually cleaned 4-column CSV: CorpAcctTrxn2026111723947226.csv (26 txns)
 * 
 * Tests Section 12 Criteria:
 * 1. Raw BCA CSV uploads without manual editing.
 * 2. Cleaned four-column CSV still uploads.
 * 3. All 26 cleaned-file rows match the corresponding raw source rows.
 * 4. All 63 raw transaction/pending rows are recognised.
 * 5. 56 DB and 7 CR totals/counts are correct.
 * 6. Opening and closing balance validation passes.
 * 7. PEND row is not silently dropped (flagged, prefilled today's date, date required).
 * 8. Re-uploading the same statement does not duplicate transactions.
 * 9. Account number correctly identifies BCA IDR (0930201014 <-> 0930 2010 14).
 * 10. Existing bank reconciliation matching remains functional.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Import normalizer functions
import {
  parseRawCSVToRows,
  detectStatementFormat,
  extractStatementMetadata,
  matchConfiguredBankAccount,
  parseAndNormalizeStatement,
  validateStatementTotals,
  checkStatementDuplicates,
  fetchExistingBankStatementLinesSafe,
  getJakartaDateString,
  getJakartaTodayString,
  KNOWN_BCA_BRANCH_CODES,
  isLegacyBranchReference,
} from '../src/components/finance/bankStatementNormalizer.ts';

test('Smart BCA Statement Importer & Automatic Normalization Suite', async (t) => {
  const rawFilePath = path.join(projectRoot, 'tests', 'fixtures', 'CorpAcctTrxn2026112092828187.csv');
  const cleanFilePath = path.join(projectRoot, 'tests', 'fixtures', 'CorpAcctTrxn2026111723947226.csv');

  assert.ok(fs.existsSync(rawFilePath), 'Raw BCA test fixture must exist');
  assert.ok(fs.existsSync(cleanFilePath), 'Cleaned BCA test fixture must exist');

  const rawCSV = fs.readFileSync(rawFilePath, 'utf8');
  const cleanCSV = fs.readFileSync(cleanFilePath, 'utf8');

  // Test 1: Raw BCA CSV uploads and parses without manual editing
  await t.test('1. Raw BCA CSV uploads without manual editing', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const format = detectStatementFormat(rows);
    assert.equal(format, 'bca_raw_csv', 'Format must be detected as bca_raw_csv');

    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });
    assert.ok(result.lines.length > 0, 'Must parse lines from raw BCA CSV without errors');
  });

  // Test 2: Cleaned four-column CSV still uploads
  await t.test('2. Cleaned four-column CSV still uploads', () => {
    const { rows } = parseRawCSVToRows(cleanCSV);
    const format = detectStatementFormat(rows);
    assert.equal(format, 'bca_cleaned_csv', 'Format must be detected as bca_cleaned_csv');

    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });
    assert.equal(result.lines.length, 26, 'Cleaned file must parse exactly 26 transaction rows');
  });

  // Test 3: All 26 cleaned-file rows match the corresponding raw source rows
  await t.test('3. All 26 cleaned-file rows match the corresponding raw source rows', () => {
    const { rows: rawRows } = parseRawCSVToRows(rawCSV);
    const { rows: cleanRows } = parseRawCSVToRows(cleanCSV);

    const rawResult = parseAndNormalizeStatement(rawRows, { defaultYear: 2026 });
    const cleanResult = parseAndNormalizeStatement(cleanRows, { defaultYear: 2026 });

    assert.equal(cleanResult.lines.length, 26, 'Clean file must yield 26 rows');

    cleanResult.lines.forEach((cLine, idx) => {
      const match = rawResult.lines.find(
        (r) =>
          r.date === cLine.date &&
          r.description === cLine.description &&
          Math.abs(r.debit - cLine.debit) < 0.01 &&
          Math.abs(r.credit - cLine.credit) < 0.01
      );
      assert.ok(
        match,
        `Clean row ${idx + 1} (${cLine.date} ${cLine.description} debit=${cLine.debit} credit=${cLine.credit}) must match a raw transaction`
      );
    });
  });

  // Test 4: All 63 raw transaction/pending rows are recognised
  await t.test('4. All 63 raw transaction/pending rows are recognised', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });

    assert.equal(result.lines.length, 63, 'Must recognise exactly 63 transaction rows (56 debits + 7 credits)');
  });

  // Test 5: 56 DB and 7 CR totals/counts are correct
  await t.test('5. 56 DB and 7 CR totals/counts are correct', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });

    assert.equal(result.validation.debitCount, 56, 'Must have exactly 56 debit rows');
    assert.equal(result.validation.creditCount, 7, 'Must have exactly 7 credit rows');
    assert.equal(result.validation.totalDebits, 1144052374, 'Debit total must match Rp 1,144,052,374');
    assert.equal(result.validation.totalCredits, 912788025, 'Credit total must match Rp 912,788,025');
  });

  // Test 6: Opening and closing balance validation passes
  await t.test('6. Opening and closing balance validation passes', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });

    assert.equal(result.metadata.openingBalance, 988465151.11, 'Opening balance must be Rp 988,465,151.11');
    assert.equal(result.metadata.closingBalance, 757200802.11, 'Closing balance must be Rp 757,200,802.11');
    assert.ok(result.validation.isValid, 'Statement validation must pass');
    assert.ok(result.validation.discrepancy < 0.05, 'Discrepancy must be practically 0');
  });

  // Test 7: PEND row is not silently dropped and requires date
  await t.test('7. PEND row is not silently dropped (flagged, prefilled today date)', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const todayStr = '2026-11-20';
    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026, todayDate: todayStr });

    assert.equal(result.metadata.pendingCount, 1, 'Must detect 1 pending transaction');
    assert.ok(result.metadata.hasPendingTransactions, 'hasPendingTransactions must be true');

    const pendLine = result.lines.find((l) => l.isPending);
    assert.ok(pendLine, 'Pending row must exist in parsed lines');
    assert.equal(pendLine.originalDate, 'PEND', 'originalDate must be PEND');
    assert.equal(pendLine.date, todayStr, 'Date must be prefilled with today date');
    assert.equal(pendLine.debit, 1001900, 'Pending amount must be Rp 1,001,900 DB');
    assert.equal(pendLine.credit, 0, 'Pending credit must be 0');
    assert.equal(pendLine.status, 'pending_date_required', 'Status must be pending_date_required');
    assert.ok(pendLine.description.includes('GOPAY'), 'Description must match GOPAY transaction');
    assert.equal(pendLine.notes, '[BCA Source: PEND]', 'Notes must record original PEND origin');
  });

  // Test 8: Re-uploading the same statement does not duplicate transactions
  await t.test('8. Re-uploading the same statement does not duplicate transactions', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });

    // Mock DB existing lines containing all 63 rows
    const mockExistingLines = result.lines.map((l) => ({
      transaction_date: l.date,
      description: l.description,
      reference: l.reference,
      debit_amount: l.debit,
      credit_amount: l.credit,
    }));

    const dupCheck = checkStatementDuplicates(result.lines, mockExistingLines);
    assert.equal(dupCheck.duplicateCount, 63, 'All 63 lines must be detected as duplicates on re-upload');
    assert.equal(dupCheck.newLines.length, 0, '0 new lines should be imported on exact re-upload');

    // Partial re-upload test: DB has 10 lines, CSV has 63
    const partialExisting = mockExistingLines.slice(0, 10);
    const partialCheck = checkStatementDuplicates(result.lines, partialExisting);
    assert.equal(partialCheck.duplicateCount, 10, 'Must detect exactly 10 duplicates');
    assert.equal(partialCheck.newLines.length, 53, 'Must identify 53 new lines to import');
  });

  // Test 9: Account number correctly identifies BCA IDR
  await t.test('9. Account number correctly identifies BCA IDR (0930201014 <-> 0930 2010 14)', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const metadata = extractStatementMetadata(rows);

    assert.equal(metadata.accountNumber, '0930201014', 'Extracted account number must be 0930201014');
    assert.equal(metadata.accountName, 'SHUBHAM ANZEN PHARMA JAY', 'Extracted name must match');
    assert.equal(metadata.currency, 'IDR', 'Currency Rp must normalize to IDR');

    const bankAccounts = [
      {
        id: 'acc-bca-idr',
        account_name: 'BCA IDR',
        bank_name: 'BCA Bank',
        account_number: '0930 2010 14', // Note spaces
        currency: 'IDR',
        alias: 'BCA Main Operating',
      },
      {
        id: 'acc-bca-usd',
        account_name: 'BCA USD',
        bank_name: 'BCA Bank',
        account_number: '0930 2010 22',
        currency: 'USD',
        alias: 'BCA USD Account',
      },
      {
        id: 'acc-mandiri',
        account_name: 'Mandiri IDR',
        bank_name: 'Bank Mandiri',
        account_number: '123-456-7890',
        currency: 'IDR',
        alias: 'Mandiri Payroll',
      },
    ];

    const matched = matchConfiguredBankAccount(metadata.accountNumber, bankAccounts);
    assert.ok(matched, 'Must find matching bank account');
    assert.equal(matched.id, 'acc-bca-idr', 'Must match BCA IDR account');
    assert.equal(matched.account_name, 'BCA IDR');
  });

  // Test 10: Reconciliation and candidate ranking compatibility
  await t.test('10. Normalized lines integrate with bank reconciliation matching and candidate ranking', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });

    // Verify properties needed by reconciliation engine
    result.lines.forEach((line) => {
      assert.ok(typeof line.id === 'string' && line.id.length > 0, 'Line id must be string');
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(line.date), `Date ${line.date} must be ISO YYYY-MM-DD`);
      assert.ok(typeof line.description === 'string', 'Description must be string');
      assert.ok(typeof line.debit === 'number', 'Debit must be number');
      assert.ok(typeof line.credit === 'number', 'Credit must be number');
      assert.ok(
        (line.debit > 0 && line.credit === 0) || (line.credit > 0 && line.debit === 0),
        'Exactly one of debit or credit must be positive'
      );
    });
  });

  // Test 11: Indonesian local date calculation (Asia/Jakarta) for PEND defaults
  await t.test('11. Indonesian local date calculation (Asia/Jakarta) for PEND defaults', () => {
    const jakartaToday = getJakartaTodayString();
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(jakartaToday), 'Jakarta today must be formatted as YYYY-MM-DD');

    // Test specific date conversion at late UTC hour
    // 2026-11-19 23:30:00 UTC is 2026-11-20 06:30:00 in Asia/Jakarta (UTC+7)
    const lateUtcDate = new Date('2026-11-19T23:30:00Z');
    const jakartaDate = getJakartaDateString(lateUtcDate);
    assert.equal(
      jakartaDate,
      '2026-11-20',
      'Late UTC hour on 19th must correctly resolve to 20th in Asia/Jakarta (WIB)'
    );

    // Verify parseAndNormalizeStatement defaults to Jakarta today without explicit todayDate
    const { rows } = parseRawCSVToRows(rawCSV);
    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });
    const pendLine = result.lines.find((l) => l.isPending);
    assert.ok(pendLine, 'Pending line must be parsed');
    assert.equal(pendLine.date, jakartaToday, 'Default pending date must match Asia/Jakarta today string');
  });

  // Test 12: Raw BCA fixture with PEND date left at today\'s Indonesian date
  await t.test('12. Raw BCA fixture with PEND date left at today\'s Indonesian date', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const jakartaToday = getJakartaTodayString();
    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });

    const pendLine = result.lines.find((l) => l.isPending);
    assert.ok(pendLine, 'Pending row must exist');

    // Initial pendingDates dictionary with Jakarta today
    const pendingDates = { [pendLine.id]: jakartaToday };

    // Initial DB is empty
    const dupCheck = checkStatementDuplicates(result.lines, [], pendingDates);
    assert.equal(dupCheck.duplicateCount, 0, 'No duplicates in empty DB');
    assert.equal(dupCheck.newLines.length, 63, 'All 63 lines are new');

    const confirmedPendLine = dupCheck.newLines.find((l) => l.isPending);
    assert.ok(confirmedPendLine, 'Confirmed pending line must be in newLines');
    assert.equal(confirmedPendLine.date, jakartaToday, 'Confirmed line date must be Jakarta today');
  });

  // Test 13: Raw BCA fixture after changing PEND date to another date
  await t.test('13. Raw BCA fixture after changing PEND date to another date', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });

    const pendLine = result.lines.find((l) => l.isPending);
    assert.ok(pendLine, 'Pending row must exist');

    // User edits the date to 2026-11-21
    const changedDate = '2026-11-21';
    const updatedPendingDates = { [pendLine.id]: changedDate };

    const dupCheck = checkStatementDuplicates(result.lines, [], updatedPendingDates);
    assert.equal(dupCheck.newLines.length, 63, 'All 63 lines are new');

    const confirmedPendLine = dupCheck.newLines.find((l) => l.isPending);
    assert.ok(confirmedPendLine, 'Confirmed pending line must be in newLines');
    assert.equal(confirmedPendLine.date, changedDate, 'Confirmed line date must reflect the user-edited date');
  });

  // Test 14: Recalculate duplicates after PEND date confirmation (duplicate detected on confirmed date)
  await t.test('14. Recalculate duplicates after PEND date confirmation', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });

    const pendLine = result.lines.find((l) => l.isPending);
    assert.ok(pendLine, 'Pending row must exist');

    // Case A: Suppose DB already has this GOPAY transaction on 2026-11-18
    const existingDbLines = [
      {
        transaction_date: '2026-11-18',
        description: pendLine.description,
        reference: pendLine.reference || '',
        debit_amount: 1001900,
        credit_amount: 0,
      },
    ];

    // When PEND date is initially today (2026-11-20), DB has no record on 2026-11-20 -> Not a duplicate
    const initialDates = { [pendLine.id]: '2026-11-20' };
    const checkInitial = checkStatementDuplicates(result.lines, existingDbLines, initialDates);
    assert.equal(checkInitial.duplicateCount, 0, 'On 2026-11-20, no duplicate exists in DB');
    assert.equal(checkInitial.newLines.length, 63, 'All 63 lines are new on initial date');

    // User changes PEND date to 2026-11-18 (the date already recorded in DB)
    const confirmedDates = { [pendLine.id]: '2026-11-18' };
    const checkRecalculated = checkStatementDuplicates(result.lines, existingDbLines, confirmedDates);

    // Duplicate detection re-evaluates with confirmed date:
    assert.equal(checkRecalculated.duplicateCount, 1, 'Must detect 1 duplicate on confirmed date 2026-11-18');
    assert.equal(checkRecalculated.newLines.length, 62, 'New lines must decrease from 63 to 62');

    const dupPend = checkRecalculated.duplicateLines.find((l) => l.id === pendLine.id);
    assert.ok(dupPend, 'Pending line must be classified as duplicate');
    assert.equal(dupPend.date, '2026-11-18', 'Duplicate line date must be the confirmed date');
    assert.equal(dupPend.status, 'duplicate', 'Status must be duplicate');

    // Case B: User realizes mistake and adjusts date to 2026-11-19 (not in DB)
    const correctedDates = { [pendLine.id]: '2026-11-19' };
    const checkCorrected = checkStatementDuplicates(result.lines, existingDbLines, correctedDates);
    assert.equal(checkCorrected.duplicateCount, 0, 'On 2026-11-19, no duplicate in DB');
    assert.equal(checkCorrected.newLines.length, 63, 'New lines restored to 63');

    const newPend = checkCorrected.newLines.find((l) => l.id === pendLine.id);
    assert.ok(newPend, 'Pending line is now classified as new');
    assert.equal(newPend.date, '2026-11-19', 'Effective date must be 2026-11-19');
  });

  // Test 15: Completely ignore BCA Branch column and do not populate branchCode
  await t.test('15. Completely ignore BCA Branch column and do not populate branchCode', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });

    result.lines.forEach((line) => {
      assert.equal(line.branchCode, undefined, `Line ${line.id} branchCode must not be populated from BCA Branch`);
    });
  });

  // Test 16: Never use Branch as reference, extract genuine reference only from transaction data
  await t.test('16. Never use Branch as reference, extract genuine reference only from transaction data', () => {
    const { rows } = parseRawCSVToRows(rawCSV);
    const result = parseAndNormalizeStatement(rows, { defaultYear: 2026 });

    result.lines.forEach((line) => {
      assert.notEqual(line.reference, '0000', `Line ${line.id} must NEVER have branch '0000' as reference`);
      if (line.reference) {
        assert.ok(
          line.description.includes(line.reference) || /^\d{6,10}-\d+$/.test(line.reference),
          `Reference '${line.reference}' must genuinely exist in transaction data for line ${line.id}`
        );
      }
    });
  });

  // Test 17: All 26 overlapping transactions match as duplicates using ERP checkStatementDuplicates
  await t.test('17. All 26 overlapping transactions match as duplicates between raw BCA CSV and cleaned CSV', () => {
    const { rows: rawRows } = parseRawCSVToRows(rawCSV);
    const { rows: cleanRows } = parseRawCSVToRows(cleanCSV);

    const rawResult = parseAndNormalizeStatement(rawRows, { defaultYear: 2026 });
    const cleanResult = parseAndNormalizeStatement(cleanRows, { defaultYear: 2026 });

    assert.equal(cleanResult.lines.length, 26, 'Cleaned fixture must produce 26 transactions');
    assert.equal(rawResult.lines.length, 63, 'Raw fixture must produce 63 transactions');

    // Scenario A: Raw file already imported in DB -> Clean file uploaded
    const mockDbFromRaw = rawResult.lines.map((l) => ({
      transaction_date: l.date,
      description: l.description,
      reference: l.reference || '',
      debit_amount: l.debit,
      credit_amount: l.credit,
    }));

    const cleanDupCheck = checkStatementDuplicates(cleanResult.lines, mockDbFromRaw);
    assert.equal(
      cleanDupCheck.duplicateCount,
      26,
      'All 26 cleaned CSV transactions must be identified as duplicates against raw BCA DB records'
    );
    assert.equal(cleanDupCheck.newLines.length, 0, '0 new lines should be imported from the cleaned file');

    // Scenario B: Clean file already imported in DB -> Raw file uploaded
    const mockDbFromClean = cleanResult.lines.map((l) => ({
      transaction_date: l.date,
      description: l.description,
      reference: l.reference || '',
      debit_amount: l.debit,
      credit_amount: l.credit,
    }));

    const rawDupCheck = checkStatementDuplicates(rawResult.lines, mockDbFromClean);
    assert.equal(
      rawDupCheck.duplicateCount,
      26,
      'Exactly 26 overlapping transactions must be identified as duplicates in the raw file'
    );
    assert.equal(
      rawDupCheck.newLines.length,
      37,
      'Exactly 37 new transactions (63 - 26) must be identified for import from raw file'
    );

    // Scenario C: Re-uploading raw file against itself
    const exactReupload = checkStatementDuplicates(rawResult.lines, mockDbFromRaw);
    assert.equal(exactReupload.duplicateCount, 63, 'Exact raw re-upload must identify all 63 duplicates');
    assert.equal(exactReupload.newLines.length, 0, 'Exact raw re-upload must have 0 new lines');
  });

  // Test 18: Preserve occurrence counting for genuinely repeated identical transactions
  await t.test('18. Preserve occurrence counting for genuinely repeated identical transactions', () => {
    const { rows: rawRows } = parseRawCSVToRows(rawCSV);
    const rawResult = parseAndNormalizeStatement(rawRows, { defaultYear: 2026 });

    // On 2026-11-03, there are multiple identical "BYR VIA E-BANKING ... 50000" rows
    const repeatedLines = rawResult.lines.filter(
      (l) => l.date === '2026-11-03' && l.debit === 50000 && l.description.includes('PENERIMAAN NEGARA')
    );
    assert.ok(repeatedLines.length >= 6, `Must find at least 6 repeated tax payments on 2026-11-03 (found ${repeatedLines.length})`);

    // Suppose DB only has 2 of these tax payments
    const partialDb = repeatedLines.slice(0, 2).map((l) => ({
      transaction_date: l.date,
      description: l.description,
      reference: l.reference || '',
      debit_amount: l.debit,
      credit_amount: l.credit,
    }));

    const occCheck = checkStatementDuplicates(repeatedLines, partialDb);
    assert.equal(occCheck.duplicateCount, 2, 'Only the 2 existing occurrences should be flagged as duplicates');
    assert.equal(
      occCheck.newLines.length,
      repeatedLines.length - 2,
      `Remaining ${repeatedLines.length - 2} occurrences must be preserved as new transactions`
    );
  });

  // Test 19: Backward-compatibility: detect duplicates against legacy database records with BCA branch references
  await t.test(
    '19. Backward-compatibility: detect duplicates against legacy DB records with BCA branch references (0000, 0386, 0093, 0998)',
    () => {
      const { rows: rawRows } = parseRawCSVToRows(rawCSV);
      const { rows: cleanRows } = parseRawCSVToRows(cleanCSV);

      const rawResult = parseAndNormalizeStatement(rawRows, { defaultYear: 2026 });
      const cleanResult = parseAndNormalizeStatement(cleanRows, { defaultYear: 2026 });

      // Build simulated legacy DB records created by previous importer
      // where `reference` was populated with the raw BCA Branch column value
      const legacyBranchValues = new Set();
      const legacyDbLines = rawResult.lines.map((line, idx) => {
        const rawBranch = String(rawRows[idx + 6]?.[2] || '0000').trim();
        legacyBranchValues.add(rawBranch);
        return {
          transaction_date: line.date,
          description: line.description,
          reference: rawBranch, // 0000, 0386, 0093, 0998 saved in DB reference!
          debit_amount: line.debit,
          credit_amount: line.credit,
        };
      });

      // Verify all known legacy branch codes are represented in the test fixture
      assert.ok(legacyBranchValues.has('0000'), 'Must contain 0000');
      assert.ok(legacyBranchValues.has('0386'), 'Must contain 0386');
      assert.ok(legacyBranchValues.has('0093'), 'Must contain 0093');
      assert.ok(legacyBranchValues.has('0998'), 'Must contain 0998');

      // Test A: Newly normalized raw lines (which extract genuine references like 1311/FTSCY/WS95051)
      // must match legacy DB records as duplicates
      const rawVsLegacyCheck = checkStatementDuplicates(rawResult.lines, legacyDbLines);
      assert.equal(
        rawVsLegacyCheck.duplicateCount,
        63,
        'All 63 newly parsed raw transactions must match legacy DB records as duplicates'
      );
      assert.equal(rawVsLegacyCheck.newLines.length, 0, '0 new lines should be imported when legacy records exist');

      // Verify individual known branch cases
      const lapiRow = rawResult.lines.find((l) => l.description.includes('PT.LAPI'));
      assert.ok(lapiRow, 'PT.LAPI row must exist');
      const isLapiDup = rawVsLegacyCheck.duplicateLines.some((d) => d.id === lapiRow.id);
      assert.ok(isLapiDup, 'PT.LAPI (legacy branch 0386) must match as duplicate');

      const tarikanRow = rawResult.lines.find((l) => l.description.includes('0516992-0'));
      assert.ok(tarikanRow, 'Tarikan tunai row must exist');
      const isTarikanDup = rawVsLegacyCheck.duplicateLines.some((d) => d.id === tarikanRow.id);
      assert.ok(isTarikanDup, 'Tarikan tunai (legacy branch 0093) must match as duplicate');

      const admRow = rawResult.lines.find((l) => l.description.includes('BIAYA ADM'));
      assert.ok(admRow, 'Biaya adm row must exist');
      const isAdmDup = rawVsLegacyCheck.duplicateLines.some((d) => d.id === admRow.id);
      assert.ok(isAdmDup, 'Biaya adm (legacy branch 0998) must match as duplicate');

      const transferRow = rawResult.lines.find((l) => l.reference === '1311/FTSCY/WS95051');
      assert.ok(transferRow, 'Transfer row with genuine reference must exist');
      const isTransferDup = rawVsLegacyCheck.duplicateLines.some((d) => d.id === transferRow.id);
      assert.ok(isTransferDup, 'Transfer row with genuine reference must match legacy 0000 DB record as duplicate');

      // Test B: Cleaned CSV (26 rows) must also match legacy DB records as duplicates
      const cleanVsLegacyCheck = checkStatementDuplicates(cleanResult.lines, legacyDbLines);
      assert.equal(
        cleanVsLegacyCheck.duplicateCount,
        26,
        'All 26 cleaned CSV transactions must match legacy DB records as duplicates'
      );
      assert.equal(cleanVsLegacyCheck.newLines.length, 0, '0 new lines from cleaned file against legacy DB');
    }
  );

  // Test 20: Backward-compatibility: occurrence counting preserved with legacy branch records
  await t.test(
    '20. Backward-compatibility: preserve occurrence counting with legacy branch records',
    () => {
      const { rows: rawRows } = parseRawCSVToRows(rawCSV);
      const rawResult = parseAndNormalizeStatement(rawRows, { defaultYear: 2026 });

      const repeatedTaxLines = rawResult.lines.filter(
        (l) => l.date === '2026-11-03' && l.debit === 50000 && l.description.includes('PENERIMAAN NEGARA')
      );
      assert.equal(repeatedTaxLines.length, 7, 'Must have 7 repeated tax payments on 2026-11-03');

      // Suppose legacy DB only has 3 of these rows with reference = '0000'
      const legacyPartialDb = repeatedTaxLines.slice(0, 3).map((l) => ({
        transaction_date: l.date,
        description: l.description,
        reference: '0000', // Legacy branch code
        debit_amount: l.debit,
        credit_amount: l.credit,
      }));

      const occCheck = checkStatementDuplicates(repeatedTaxLines, legacyPartialDb);
      assert.equal(occCheck.duplicateCount, 3, 'Exactly 3 occurrences must match legacy DB records as duplicates');
      assert.equal(occCheck.newLines.length, 4, 'Remaining 4 occurrences must be preserved as new transactions');
    }
  );

  // Test 21: Fail-safe duplicate checking with fetchExistingBankStatementLinesSafe
  await t.test(
    '21. Fail-safe duplicate checking: fetchExistingBankStatementLinesSafe handles errors and pagination',
    async () => {
      // Case A: Query failure throws an explicit error and NEVER returns empty array
      const failingClient = {
        from: () => ({
          select: () => ({
            eq: () => ({
              gte: () => ({
                lte: () => ({
                  range: () => ({
                    order: async () => ({
                      data: null,
                      error: { message: 'Connection reset by peer' },
                    }),
                  }),
                }),
              }),
              range: () => ({
                order: async () => ({
                  data: null,
                  error: { message: 'Connection reset by peer' },
                }),
              }),
            }),
          }),
        }),
      };

      await assert.rejects(
        async () => {
          await fetchExistingBankStatementLinesSafe(failingClient, 'mock-bank-id', ['2026-11-10']);
        },
        /Database error querying bank statement records: Connection reset by peer/,
        'Must reject with explicit database error message when query fails'
      );

      // Case B: Client requires bankAccountId
      await assert.rejects(
        async () => {
          await fetchExistingBankStatementLinesSafe(failingClient, '', ['2026-11-10']);
        },
        /Bank account ID is required/,
        'Must reject when bankAccountId is missing'
      );

      // Case C: Pagination handles >1000 items across multiple pages
      let pageCallCount = 0;
      const paginatedClient = {
        from: () => ({
          select: () => ({
            eq: () => ({
              gte: () => ({
                lte: () => ({
                  range: (from, to) => ({
                    order: async () => {
                      pageCallCount++;
                      if (from === 0) {
                        // Page 1: 1000 items
                        const p1 = Array.from({ length: 1000 }, (_, i) => ({
                          transaction_date: '2026-11-10',
                          description: `Txn ${i}`,
                          reference: `ref-${i}`,
                          debit_amount: 100,
                          credit_amount: 0,
                        }));
                        return { data: p1, error: null };
                      } else {
                        // Page 2: 250 items (less than 1000 -> final page)
                        const p2 = Array.from({ length: 250 }, (_, i) => ({
                          transaction_date: '2026-11-11',
                          description: `Txn 1000+${i}`,
                          reference: `ref-1000+${i}`,
                          debit_amount: 200,
                          credit_amount: 0,
                        }));
                        return { data: p2, error: null };
                      }
                    },
                  }),
                }),
              }),
            }),
          }),
        }),
      };

      const paginatedResult = await fetchExistingBankStatementLinesSafe(paginatedClient, 'mock-bank-id', [
        '2026-11-10',
        '2026-11-11',
      ]);
      assert.equal(pageCallCount, 2, 'Must fetch exactly 2 pages');
      assert.equal(paginatedResult.length, 1250, 'Must return all 1250 items without omission');
    }
  );
});
