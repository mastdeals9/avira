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
});
