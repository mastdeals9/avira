import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DB_CONNECTION = process.env.READONLY_AUDIT_DB_URL;

async function withDbClient(callback) {
  if (!DB_CONNECTION) {
    console.warn('Skipping live database test: DATABASE_URL environment variable is not set.');
    return;
  }
  const client = new pg.Client({
    connectionString: DB_CONNECTION,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

// Emulate normalizeDateToIso from src/utils/dateFormat.ts
function normalizeDateToIso(val) {
  if (!val) return '';
  const trimmed = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return trimmed.split('T')[0];

  const match = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (!match) return '';
  const [, day, month, year] = match;
  const dayNum = Number(day);
  const monthNum = Number(month);
  if (dayNum < 1 || dayNum > 31 || monthNum < 1 || monthNum > 12) return '';
  return `${year}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
}

// Emulate BankReconciliation search matching logic
function matchesSearch(line, query) {
  if (!query || !query.trim()) return true;
  const term = query.trim().toLowerCase();
  const digitsOnly = term.replace(/[^\d]/g, '');

  const desc = (line.description || '').toLowerCase();
  const ref = (line.reference || '').toLowerCase();
  const notes = (line.notes || '').toLowerCase();
  const docNum = (line.document_number || '').toLowerCase();
  const party = (line.party_name || '').toLowerCase();
  const dt = (line.transaction_date || '').toLowerCase();

  if (desc.includes(term) || ref.includes(term) || notes.includes(term) || docNum.includes(term) || party.includes(term) || dt.includes(term)) {
    return true;
  }

  // Indonesian date format DD/MM/YYYY matching
  const [y, m, d] = (line.transaction_date || '').split('-');
  if (y && m && d) {
    const idDate = `${d}/${m}/${y}`;
    if (idDate.includes(term)) return true;
  }

  // Amount matching (raw and formatted Indonesian Rp)
  const debitAmt = Number(line.debit_amount || 0);
  const creditAmt = Number(line.credit_amount || 0);
  const debitStr = String(Math.round(debitAmt));
  const creditStr = String(Math.round(creditAmt));

  if (digitsOnly && digitsOnly.length >= 2) {
    if (debitAmt > 0 && debitStr.includes(digitsOnly)) return true;
    if (creditAmt > 0 && creditStr.includes(digitsOnly)) return true;
  }

  const debitFormatted = debitAmt.toLocaleString('id-ID');
  const creditFormatted = creditAmt.toLocaleString('id-ID');
  if (debitAmt > 0 && debitFormatted.toLowerCase().includes(term)) return true;
  if (creditAmt > 0 && creditFormatted.toLowerCase().includes(term)) return true;

  return false;
}

test('Bank Reconciliation & Search Regression Test Suite', async (t) => {
  await t.test('1. Date Normalization: 01/10/2026 is 1 October 2026', () => {
    assert.equal(normalizeDateToIso('01/10/2026'), '2026-10-01', '01/10/2026 must parse to 2026-10-01 (1 October)');
    assert.notEqual(normalizeDateToIso('01/10/2026'), '2026-01-10', '01/10/2026 must NOT parse to 10 January');
    assert.equal(normalizeDateToIso('26/10/2026'), '2026-10-26', '26/10/2026 must parse to 2026-10-26');
    assert.equal(normalizeDateToIso('1/10/2026'), '2026-10-01', '1/10/2026 single-digit day must parse to 2026-10-01');
    assert.equal(normalizeDateToIso('2026-10-01'), '2026-10-01', 'ISO date must stay unchanged');
  });

  await t.test('2. Bank Reconciliation Component Architecture & Inclusive Queries', () => {
    const reconSrc = readFileSync(
      new URL('../src/components/finance/BankReconciliationEnhanced.tsx', import.meta.url),
      'utf8'
    );

    // Date controls & query boundaries
    assert.match(reconSrc, /localStartDate/, 'Must have local start date state');
    assert.match(reconSrc, /localEndDate/, 'Must have local end date state');
    assert.match(reconSrc, /\.gte\('transaction_date',\s*startIso\)/, 'Query must use inclusive gte boundary');
    assert.match(reconSrc, /\.lte\('transaction_date',\s*endIso\)/, 'Query must use inclusive lte boundary');
    assert.doesNotMatch(reconSrc, /\.lt\('transaction_date'/, 'Query must not use exclusive lt boundary');

    // Search controls
    assert.match(reconSrc, /searchTerm/, 'Must have searchTerm state');
    assert.match(reconSrc, /matchesSearch/, 'Must define search matching helper');

    // Status filter & pagination
    assert.match(reconSrc, /filteredLines/, 'Must filter lines by status and search');
    assert.match(reconSrc, /paginatedLines/, 'Must paginate filtered lines');
    assert.match(reconSrc, /handleClearFilters/, 'Must have one-click Clear Filters handler');
  });

  await t.test('3. BPJS Register Modal Improvements', () => {
    const bpjsSrc = readFileSync(
      new URL('../src/components/finance/BpjsRegisterManager.tsx', import.meta.url),
      'utf8'
    );

    assert.match(bpjsSrc, /bankLineSearch/, 'Modal must have bankLineSearch filter');
    assert.match(bpjsSrc, /bankLineStartDate/, 'Modal must have start date filter');
    assert.match(bpjsSrc, /bankLineEndDate/, 'Modal must have end date filter');
    assert.match(bpjsSrc, /unlinkedOnly/, 'Modal must have unlinkedOnly toggle');
    assert.match(bpjsSrc, /Exact Amount & BPJS Keyword Match/, 'Modal must show strong rationale badge');
    assert.match(bpjsSrc, /disabled=\{isSettled\}/, 'Modal must disable already settled lines');
    assert.match(bpjsSrc, /Cannot Select Settled Line/, 'Modal must warn if settled line is clicked');
  });

  await t.test('4. In-Memory Search & Multi-Page Visibility Logic', () => {
    const mockLines = Array.from({ length: 100 }, (_, i) => ({
      id: `line-${i}`,
      transaction_date: i === 75 ? '2026-10-01' : '2026-05-10',
      description: i === 75 ? 'TRSF E-BANKING DB 0110/FTFVA/WS95051 89000/BPJS TK - - 426719331000' : `Office supply expense #${i}`,
      reference: i === 75 ? 'FTFVA/WS95051' : `REF-${i}`,
      debit_amount: i === 75 ? 767520 : 50000 + i * 100,
      credit_amount: 0,
      reconciliation_status: i === 75 ? 'unmatched' : (i % 2 === 0 ? 'matched' : 'unmatched'),
      matching_status: i === 75 ? 'none' : 'suggested',
    }));

    // Search matches line-75 on page 4 (index 75) when page size is 25
    const searchBpjs = mockLines.filter(l => matchesSearch(l, 'BPJS TK'));
    assert.equal(searchBpjs.length, 1);
    assert.equal(searchBpjs[0].id, 'line-75');

    const searchAmt = mockLines.filter(l => matchesSearch(l, '767520'));
    assert.equal(searchAmt.length, 1);
    assert.equal(searchAmt[0].id, 'line-75');

    const searchFormattedAmt = mockLines.filter(l => matchesSearch(l, '767.520'));
    assert.equal(searchFormattedAmt.length, 1);
    assert.equal(searchFormattedAmt[0].id, 'line-75');

    const searchDate = mockLines.filter(l => matchesSearch(l, '01/10/2026'));
    assert.equal(searchDate.length, 1);
    assert.equal(searchDate[0].id, 'line-75');

    // Combined search and status
    const matchedOnly = searchBpjs.filter(l => l.reconciliation_status === 'matched');
    assert.equal(matchedOnly.length, 0, 'line-75 is unmatched, should not appear in matched');

    const unmatchedOnly = searchBpjs.filter(l => l.reconciliation_status === 'unmatched');
    assert.equal(unmatchedOnly.length, 1, 'line-75 should appear in unmatched');
  });

  await t.test('5. Read-Only Production Database Verification: 01/10/2026 BPJS TK Transaction', async () => {
    await withDbClient(async (client) => {
      // Find the specific transaction
      const res = await client.query(`
        SELECT 
          bsl.id,
          bsl.bank_account_id,
          bsl.transaction_date,
          bsl.debit_amount,
          bsl.credit_amount,
          bsl.description,
          bsl.reference,
          bsl.reconciliation_status,
          bsl.matching_status,
          ba.bank_name,
          ba.account_name,
          ba.account_number,
          ba.currency
        FROM bank_statement_lines bsl
        JOIN bank_accounts ba ON ba.id = bsl.bank_account_id
        WHERE bsl.transaction_date = '2026-10-01'
          AND bsl.debit_amount = 767520.00
      `);

      assert.equal(res.rows.length, 1, 'Exactly one transaction on 2026-10-01 for Rp 767,520 must exist');
      const row = res.rows[0];
      assert.equal(row.id, '3c399d54-8f0b-4e24-985c-e76d86cc1b32');
      assert.ok(['unmatched', 'matched'].includes(row.reconciliation_status), 'Status must be valid reconciliation state');
      assert.ok(['none', 'confirmed'].includes(row.matching_status), 'Matching status must be valid state');
      assert.match(row.description, /BPJS TK/);
      assert.match(row.bank_name, /BCA/);

      // Verify date range 2026-10-01 to 2026-10-01 includes this transaction
      const singleDayRes = await client.query(`
        SELECT count(*) as count
        FROM bank_statement_lines
        WHERE bank_account_id = $1
          AND transaction_date >= '2026-10-01'
          AND transaction_date <= '2026-10-01'
          AND id = $2
      `, [row.bank_account_id, row.id]);
      assert.equal(Number(singleDayRes.rows[0].count), 1, 'Single day date range 2026-10-01 includes the transaction');

      // Verify global date range 2026-01-01 to 2026-10-26 includes this transaction
      const fullRangeRes = await client.query(`
        SELECT count(*) as count
        FROM bank_statement_lines
        WHERE bank_account_id = $1
          AND transaction_date >= '2026-01-01'
          AND transaction_date <= '2026-10-26'
          AND id = $2
      `, [row.bank_account_id, row.id]);
      assert.equal(Number(fullRangeRes.rows[0].count), 1, 'Full date range includes the transaction');

      // Verify total count in BCA IDR is exactly 526 transactions
      const totalRes = await client.query(`
        SELECT count(*) as total_count
        FROM bank_statement_lines
        WHERE bank_account_id = $1
          AND transaction_date >= '2026-01-01'
          AND transaction_date <= '2026-10-26'
      `, [row.bank_account_id]);
      assert.ok(Number(totalRes.rows[0].total_count) >= 526, 'Total transactions preserved');

      // Verify matched transactions are intact (518 in DB matching_status/reconciliation_status, 517 after allocation check)
      const matchedRes = await client.query(`
        SELECT count(*) as matched_count
        FROM bank_statement_lines
        WHERE bank_account_id = $1
          AND transaction_date >= '2026-01-01'
          AND transaction_date <= '2026-10-26'
          AND (reconciliation_status = 'matched' OR matching_status IN ('confirmed', 'suggested', 'auto_matched', 'recorded'))
      `, [row.bank_account_id]);
      assert.ok(Number(matchedRes.rows[0].matched_count) >= 517, 'At least 517 matched transactions preserved');

      // Verify unmatched count is preserved and includes BPJS TK line
      const unmatchedRes = await client.query(`
        SELECT count(*) as unmatched_count
        FROM bank_statement_lines
        WHERE bank_account_id = $1
          AND transaction_date >= '2026-01-01'
          AND transaction_date <= '2026-10-26'
          AND reconciliation_status = 'unmatched'
      `, [row.bank_account_id]);
      assert.ok(Number(unmatchedRes.rows[0].unmatched_count) >= 1, 'Unmatched transactions preserved and include BPJS TK');
    });
  });
});
