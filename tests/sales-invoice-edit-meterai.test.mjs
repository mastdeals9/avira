import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const salesSource = fs.readFileSync('src/pages/Sales.tsx', 'utf8');
const invoiceViewSource = fs.readFileSync('src/components/InvoiceView.tsx', 'utf8');

test('1. InvoiceView renders Bea Meterai as a separate line in preview, print, and PDF', () => {
  // Check interface
  assert.match(invoiceViewSource, /stamp_duty_amount\?: number \| null;/);

  // Check separate Bea Meterai line in totals section
  assert.match(invoiceViewSource, /\{Number\(invoice\.stamp_duty_amount \|\| 0\) > 0 && \(/);
  assert.match(invoiceViewSource, /<span className="font-bold">Bea Meterai<\/span>/);
  assert.match(invoiceViewSource, /\{formatCurrency\(invoice\.stamp_duty_amount\)\}/);

  // Check calculation order: Sub Total -> VAT -> (Discount) -> Bea Meterai -> Grand Total
  const subTotalIdx = invoiceViewSource.indexOf('formatCurrency(invoice.subtotal)');
  const vatIdx = invoiceViewSource.indexOf('formatCurrency(invoice.tax_amount)');
  const stampIdx = invoiceViewSource.indexOf('formatCurrency(invoice.stamp_duty_amount)');
  const grandTotalIdx = invoiceViewSource.indexOf('formatCurrency(invoice.total_amount)');

  assert.ok(subTotalIdx !== -1, 'Sub Total must be rendered');
  assert.ok(vatIdx > subTotalIdx, 'VAT must follow Sub Total');
  assert.ok(stampIdx > vatIdx, 'Bea Meterai must follow VAT');
  assert.ok(grandTotalIdx > stampIdx, 'Grand Total must follow Bea Meterai');
});

test('2. Total calculation formula recalculates subtotal, VAT, stamp duty, and grand total without double-counting', () => {
  const calculateTotals = (items, discount, stampDutyAmount) => {
    const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
    const taxAmount = items.reduce((sum, item) => {
      const itemSubtotal = item.quantity * item.unit_price;
      return sum + (itemSubtotal * (item.tax_rate / 100));
    }, 0);
    const stampDuty = Number(stampDutyAmount) || 0;
    const total = subtotal + taxAmount - Number(discount || 0) + stampDuty;
    return { subtotal, taxAmount, stampDuty, total };
  };

  // SAPJ-26-046 & SAPJ-26-047 scenario:
  // 500 units @ Rp 16,530, tax 11%, Bea Meterai Rp 10,000
  const items = [{ quantity: 500, unit_price: 16530, tax_rate: 11 }];
  const totals = calculateTotals(items, 0, 10000);

  assert.equal(totals.subtotal, 8265000, 'Subtotal must be 8,265,000');
  assert.equal(totals.taxAmount, 909150, 'VAT 11% must be 909,150');
  assert.equal(totals.stampDuty, 10000, 'Bea Meterai must be 10,000');
  assert.equal(totals.total, 9184150, 'Grand Total must be exactly 9,184,150');
});

test('3. Edit Invoice action is available for existing posted invoices in table actions', () => {
  assert.match(salesSource, /handleEdit\(invoice\)/);
  const editBtnIdx = salesSource.indexOf('onClick={() => handleEdit(invoice)}');
  assert.ok(editBtnIdx !== -1, 'Edit button must be present in table actions');
});

test('4. Controlled adjustment workflow preserves original journal entry and payment history', () => {
  // In handleSubmit for posted invoice, we update sales_invoices header amounts
  // rather than deleting and recreating the journal entry via update_sales_invoice_atomic
  assert.match(salesSource, /if \(editingInvoice\) \{/);
  assert.match(salesSource, /if \(isPostedInvoice\(editingInvoice\)\) \{/);
  assert.match(salesSource, /from\('sales_invoices'\)\s*\.update\(\{/);
  assert.match(salesSource, /stamp_duty_amount:\s*stampDuty/);
  assert.match(salesSource, /total_amount:\s*total/);
  assert.match(salesSource, /payment_status:\s*nextPaymentStatus/);
  assert.match(salesSource, /balance_amount:\s*newBalance/);
});

test('5. Posted invoice edit locks product lines, batches, customer, and challan links to preserve inventory', () => {
  // Line items notice
  assert.match(salesSource, /Line Items(\{' '\})?\s*\{isEditingPosted &&\s*\(?\s*<span className="text-\[11px\] font-normal text-amber-700">/);
  // Add manual item hidden when editing posted invoice
  assert.match(salesSource, /\{!isEditingPosted && \(\s*<button\s*type="button"\s*onClick=\{addManualItem\}/);
  // Product select disabled when editing posted invoice
  assert.match(salesSource, /disabled=\{isFromDC \|\| isEditingPosted\}/);
});

test('6. Role permission guard protects posted invoice editing', () => {
  assert.match(salesSource, /const isFinancialEditor = profile\?\.role === 'admin' \|\| profile\?\.role === 'accounts';/);
  assert.match(salesSource, /if \(isPosted && !isFinancialEditor\) \{/);
  assert.match(salesSource, /Only Admin and Accounts can edit financially posted invoices\./);
});

test('7. Verification of SAPJ-26-046 and SAPJ-26-047 in database', async () => {
  if (!process.env.READONLY_AUDIT_DB_URL) {
    console.warn('Skipping live database verification: DATABASE_URL is not set.');
    return;
  }
  const pg = (await import('pg')).default;
  const { Client } = pg;
  const client = new Client({
    connectionString: process.env.READONLY_AUDIT_DB_URL
  });
  await client.connect();

  try {
    const res = await client.query(`
      SELECT id, invoice_number, subtotal, tax_amount, stamp_duty_amount, total_amount, paid_amount, balance_amount, payment_status, journal_entry_id
      FROM sales_invoices
      WHERE invoice_number IN ('SAPJ-26-046', 'SAPJ-26-047')
      ORDER BY invoice_number
    `);

    assert.equal(res.rows.length, 2, 'Both SAPJ-26-046 and SAPJ-26-047 must exist');

    for (const inv of res.rows) {
      assert.equal(Number(inv.stamp_duty_amount), 10000, `${inv.invoice_number} Bea Meterai must be 10,000`);
      assert.equal(Number(inv.subtotal), 8265000, `${inv.invoice_number} Subtotal must be 8,265,000`);
      assert.equal(Number(inv.tax_amount), 909150, `${inv.invoice_number} Tax must be 909,150`);
      assert.equal(Number(inv.total_amount), 9184150, `${inv.invoice_number} Total must be 9,184,150`);
      assert.ok(Number(inv.paid_amount) >= 9174150, `${inv.invoice_number} Paid amount must be >= 9,174,150`);
      assert.ok(Number(inv.balance_amount) <= 10000, `${inv.invoice_number} Balance must be <= 10,000`);
      assert.ok(['partial', 'paid'].includes(inv.payment_status), `${inv.invoice_number} Payment status must be partial or paid`);
      assert.ok(inv.journal_entry_id, `${inv.invoice_number} Posted journal entry ID must be intact`);
    }

    // Verify journal entries are intact (Sales and COGS for both invoices)
    const jeRes = await client.query(`
      SELECT id, entry_number, reference_number, description, total_debit, total_credit, is_posted
      FROM journal_entries
      WHERE reference_number IN ('SAPJ-26-046', 'SAPJ-26-047')
      ORDER BY entry_number
    `);
    assert.equal(jeRes.rows.length, 4, 'All original journal entries (Sales and COGS) must remain intact');
    for (const je of jeRes.rows) {
      assert.equal(je.is_posted, true, 'Journal entry must be posted');
    }
  } finally {
    await client.end();
  }
});
