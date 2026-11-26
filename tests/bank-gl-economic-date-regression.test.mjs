import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/components/finance/BankLedger.tsx', import.meta.url), 'utf8');
assert.match(source, /bank_statement_allocations/);
assert.match(source, /calculate_bank_account_book_balance/);
assert.match(source, /bank_statement_lines/);

const effectiveDate = ({ journalDate, bankDate }) => bankDate || journalDate;

assert.equal(effectiveDate({ sourceModule: 'fund_transfers', referenceNumber: 'FT2601-0024', journalDate: '2026-01-13', bankDate: '2025-01-13' }), '2025-01-13');
assert.equal(effectiveDate({ sourceModule: 'fund_transfers', referenceNumber: 'FT2601-0025', journalDate: '2026-03-01', bankDate: '2026-03-01' }), '2026-03-01');
assert.equal(effectiveDate({ sourceModule: 'historical_repair', referenceNumber: 'HR-FX-FT2601-0024', journalDate: '2026-01-13', bankDate: '2025-01-13' }), '2025-01-13');
assert.equal(effectiveDate({ sourceModule: 'expenses', referenceNumber: 'EXP-1', journalDate: '2026-05-01', bankDate: '2025-05-01' }), '2025-05-01');
assert.equal(effectiveDate({ sourceModule: 'receipts', referenceNumber: 'RV-1', journalDate: '2026-05-01', bankDate: '2025-05-01' }), '2025-05-01');
assert.equal(effectiveDate({ sourceModule: 'expenses', referenceNumber: 'EXP-2', journalDate: '2026-05-01', bankDate: null }), '2026-05-01');

console.log('bank/GL economic-date regression checks passed');
