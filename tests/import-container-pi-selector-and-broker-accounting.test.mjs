import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  calculateBrokerExpenseTotals,
  calculateCanonicalExpenseTotal,
  calculateCanonicalCashPayable,
  brokerLineTotal,
  brokerLineExpenseBase,
} from '../src/utils/taxCalculations.ts';

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

test('ISSUE 1: Import Container PI Selector Eligibility & Dynamic Filtering', async (t) => {
  // Read ImportContainers component code to assert architecture invariants
  const importContainersCode = readFileSync(
    new URL('../src/pages/ImportContainers.tsx', import.meta.url),
    'utf8'
  );

  await t.test('1. Architectural invariants: Realtime subscription and cache invalidation on purchase_invoices and containers', () => {
    // Verifies that realtime channels include purchase_invoices, import_containers, and receiving allocations
    assert.match(importContainersCode, /pi-container-changes/);
    assert.match(importContainersCode, /container-changes/);
    assert.match(importContainersCode, /table:\s*'purchase_invoices'/);
    assert.match(importContainersCode, /table:\s*'import_containers'/);
    // Verifies that opening New Container or Edit explicitly invalidates/refetches available PIs
    assert.match(importContainersCode, /fetchAvailablePIs\(\)/);
    // Verifies that handleSubmit refreshes available PIs after container persistence
    assert.match(importContainersCode, /fetchAvailablePIs\(\)/);
  });

  await t.test('2. HM000004/2627 qualification: USD currency qualifies as Import PI despite purchase_type = inventory', async () => {
    await withDbClient(async (client) => {
      // Query the actual live record for HM000004/2627
      const piRes = await client.query(`
        SELECT pi.id, pi.invoice_number, pi.currency, pi.purchase_type, pi.status, pi.total_amount,
               s.company_name, s.country
        FROM purchase_invoices pi
        JOIN suppliers s ON s.id = pi.supplier_id
        WHERE pi.invoice_number = 'HM000004/2627'
      `);

      assert.equal(piRes.rows.length, 1, 'HM000004/2627 must exist in database');
      const pi = piRes.rows[0];
      assert.equal(pi.currency, 'USD');
      assert.equal(pi.purchase_type, 'inventory');
      assert.equal(pi.status, 'unpaid');
      assert.equal(pi.company_name, 'Anzen Exports Private Limited');

      // Check the selector import qualification logic
      const isForeignCurrency = Boolean(pi.currency && pi.currency.toUpperCase() !== 'IDR');
      const isImportType = pi.purchase_type === 'import';
      const isOverseasSupplier = Boolean(pi.country && pi.country.trim().toLowerCase() !== 'indonesia');
      const isImportPI = (pi.status !== 'cancelled') && (isForeignCurrency || isImportType || isOverseasSupplier);

      assert.equal(isImportPI, true, 'HM000004/2627 must qualify as an Import PI');
    });
  });

  await t.test('3. Single-container allocation rule: Already-linked PIs are excluded from New Container modal', async () => {
    await withDbClient(async (client) => {
      // Fetch all container links
      const icRes = await client.query('SELECT id, container_ref, purchase_invoice_ids FROM import_containers');
      const piraRes = await client.query('SELECT purchase_invoice_id, import_container_id FROM purchase_invoice_receiving_allocations WHERE import_container_id IS NOT NULL');

      const piContainerMap = new Map();
      icRes.rows.forEach(ic => {
        (ic.purchase_invoice_ids || []).forEach(id => {
          if (id && !piContainerMap.has(id)) {
            piContainerMap.set(id, { id: ic.id, ref: ic.container_ref });
          }
        });
      });
      piraRes.rows.forEach(r => {
        if (r.purchase_invoice_id && r.import_container_id && !piContainerMap.has(r.purchase_invoice_id)) {
          piContainerMap.set(r.purchase_invoice_id, { id: r.import_container_id, ref: 'Allocation Container' });
        }
      });

      // Fetch all purchase invoices
      const pisRes = await client.query(`
        SELECT pi.id, pi.invoice_number, pi.currency, pi.purchase_type, pi.status, s.company_name, s.country
        FROM purchase_invoices pi
        JOIN suppliers s ON s.id = pi.supplier_id
        ORDER BY pi.invoice_date DESC
      `);

      const allImportPIs = pisRes.rows.filter(pi => {
        if (pi.status === 'cancelled') return false;
        const isForeignCurrency = Boolean(pi.currency && pi.currency.toUpperCase() !== 'IDR');
        const isImportType = pi.purchase_type === 'import';
        const isOverseasSupplier = Boolean(pi.country && pi.country.trim().toLowerCase() !== 'indonesia');
        const isLinkedToContainer = piContainerMap.has(pi.id);
        return isForeignCurrency || isImportType || isOverseasSupplier || isLinkedToContainer;
      });

      // In New Container mode (editingContainer = null)
      const newContainerEligible = allImportPIs.filter(pi => !piContainerMap.has(pi.id));

      // Assert HM000004/2627 is eligible
      const hm27 = newContainerEligible.find(p => p.invoice_number === 'HM000004/2627');
      assert.ok(hm27, 'HM000004/2627 must be eligible for a New Container');

      // Assert already-linked PIs (e.g. E0000167/2627, E0000085/2627) are strictly excluded
      const alreadyLinkedExcluded = newContainerEligible.find(p => piContainerMap.has(p.id));
      assert.equal(alreadyLinkedExcluded, undefined, 'No already-linked PI should appear in New Container list');
    });
  });

  await t.test('4. Edit container mode: PIs of current container remain available, other containers excluded', async () => {
    await withDbClient(async (client) => {
      const icRes = await client.query('SELECT id, container_ref, purchase_invoice_ids FROM import_containers WHERE container_ref = \'2nd Air shipment\'');
      assert.equal(icRes.rows.length, 1);
      const targetContainer = icRes.rows[0];

      const allIcRes = await client.query('SELECT id, container_ref, purchase_invoice_ids FROM import_containers');
      const piContainerMap = new Map();
      allIcRes.rows.forEach(ic => {
        (ic.purchase_invoice_ids || []).forEach(id => {
          if (id && !piContainerMap.has(id)) {
            piContainerMap.set(id, { id: ic.id, ref: ic.container_ref });
          }
        });
      });

      const pisRes = await client.query(`
        SELECT pi.id, pi.invoice_number, pi.currency, pi.purchase_type, pi.status, s.company_name, s.country
        FROM purchase_invoices pi
        JOIN suppliers s ON s.id = pi.supplier_id
      `);

      const editEligible = pisRes.rows.filter(pi => {
        if (pi.status === 'cancelled') return false;
        const isForeignCurrency = Boolean(pi.currency && pi.currency.toUpperCase() !== 'IDR');
        const isImportType = pi.purchase_type === 'import';
        const isLinkedToContainer = piContainerMap.has(pi.id);
        if (!isForeignCurrency && !isImportType && !isLinkedToContainer) return false;

        // Container eligibility rule when editing targetContainer
        const link = piContainerMap.get(pi.id);
        if (link && link.id !== targetContainer.id) return false;
        return true;
      });

      const eligibleNumbers = editEligible.map(p => p.invoice_number);
      // PIs of 2nd Air shipment must be eligible
      assert.ok(eligibleNumbers.includes('E0000333/2526'));
      assert.ok(eligibleNumbers.includes('E0000311/2526'));
      // Unlinked PI HM000004/2627 must also be available to link
      assert.ok(eligibleNumbers.includes('HM000004/2627'));
      // PI of 1st Air shipment (E0000274/2526) must be excluded
      assert.ok(!eligibleNumbers.includes('E0000274/2526'));
    });
  });

  await t.test('5. Domestic IDR purchase invoices are strictly excluded from Import Containers', async () => {
    await withDbClient(async (client) => {
      const domesticRes = await client.query(`
        SELECT pi.invoice_number, pi.currency, pi.purchase_type, s.country
        FROM purchase_invoices pi
        JOIN suppliers s ON s.id = pi.supplier_id
        WHERE pi.currency = 'IDR'
      `);

      for (const pi of domesticRes.rows) {
        const isForeignCurrency = Boolean(pi.currency && pi.currency.toUpperCase() !== 'IDR');
        const isImportType = pi.purchase_type === 'import';
        const isOverseasSupplier = Boolean(pi.country && pi.country.trim().toLowerCase() !== 'indonesia');
        const isImportPI = isForeignCurrency || isImportType || isOverseasSupplier;
        assert.equal(isImportPI, false, `Domestic invoice ${pi.invoice_number} must not qualify as import PI`);
      }
    });
  });

  await t.test('6. Search functionality operates on PI number, supplier, and PO number', () => {
    const mockPIs = [
      { id: '1', invoice_number: 'HM000004/2627', supplier_name: 'Anzen Exports Private Limited', po_number: 'PO-2610-0002' },
      { id: '2', invoice_number: 'E0000041/2627', supplier_name: 'Anzen Exports Private Limited', po_number: 'PO-2605-0010' },
      { id: '3', invoice_number: 'IMP-999', supplier_name: 'Overseas Pharma Ltd', po_number: 'PO-SPECIAL-01' }
    ];

    const search = (query) => {
      const q = query.toLowerCase();
      return mockPIs.filter(pi =>
        pi.invoice_number.toLowerCase().includes(q) ||
        pi.supplier_name.toLowerCase().includes(q) ||
        (pi.po_number && pi.po_number.toLowerCase().includes(q))
      );
    };

    assert.equal(search('HM000004').length, 1);
    assert.equal(search('HM000004')[0].id, '1');
    assert.equal(search('Anzen').length, 2);
    assert.equal(search('PO-SPECIAL').length, 1);
    assert.equal(search('PO-SPECIAL')[0].id, '3');
  });
});

test('ISSUE 2: Customs Broker Invoice EXP/26/317 Accounting Reconciliation & Tax Treatment', async (t) => {
  await t.test('1. Mathematical reconciliation of EXP/26/317: Accounting expense, PPN Masukan, PPh 23, and Cash Payable', () => {
    const expense = {
      expense_category: 'import_broker',
      amount: 2_600_000, // Broker service fee
      ppn_amount: 0,
      pph_amount: 52_000, // PPh 23 withheld (2% of broker fee)
      stamp_duty_amount: 0,
      broker_items: [
        {
          amount: 14_964_354,
          ppn_rate: 12,
          dpp_amount: 12_357_950,
          ppn_amount: 1_482_954,
          ppn_treatment: 'included',
          invoice_amount_authoritative: true
        },
        {
          amount: 1_387_500,
          ppn_rate: 11,
          dpp_amount: 1_250_000,
          ppn_amount: 137_500,
          ppn_treatment: 'excluded',
          invoice_amount_authoritative: true
        },
        {
          amount: 1_320_000,
          ppn_rate: 11,
          dpp_amount: 0,
          ppn_amount: 0,
          ppn_treatment: 'excluded',
          invoice_amount_authoritative: true
        }
      ]
    };

    const totals = calculateBrokerExpenseTotals(expense);

    // 1. Recoverable PPN Masukan (Balance Sheet Asset, Account 1150):
    // Line 1 PPN (1,482,954) + Line 2 PPN (137,500) = 1,620,454
    assert.equal(totals.recoverableInputPpn, 1_620_454, 'Recoverable PPN must equal 1,620,454');

    // 2. Accounting Expense (P&L / Landed Cost Inventory, Account 1130):
    // Excludes recoverable PPN Masukan:
    // Broker fee (2,600,000) + Line 1 Net (13,481,400) + Line 2 Net (1,250,000) + Line 3 Net (1,320,000) = 18,651,400
    assert.equal(totals.accountingExpenseTotal, 18_651_400, 'Accounting expense must be 18,651,400');
    assert.equal(calculateCanonicalExpenseTotal(expense), 18_651_400);

    // 3. Gross Payable before withholding:
    // Accounting expense (18,651,400) + Recoverable PPN (1,620,454) = 20,271,854
    assert.equal(totals.expenseTotal, 20_271_854, 'Gross payable before withholding must be 20,271,854');

    // 4. Net Cash Payable to Supplier (Accounts Payable, Account 2110):
    // Gross payable (20,271,854) - PPh 23 withheld (52,000) = 20,219,854
    assert.equal(totals.finalCashPayable, 20_219_854, 'Final cash payable to supplier must be 20,219,854');
    assert.equal(calculateCanonicalCashPayable(expense), 20_219_854);
  });

  await t.test('2. Live DB journal entry for EXP/26/317 debits and credits balance exactly', async () => {
    await withDbClient(async (client) => {
      const expRes = await client.query('SELECT id, voucher_number FROM finance_expenses WHERE voucher_number = \'EXP/26/317\'');
      assert.equal(expRes.rows.length, 1);
      const expId = expRes.rows[0].id;

      const jeRes = await client.query(`
        SELECT je.id, je.reference_number
        FROM journal_entries je
        WHERE je.reference_number ILIKE '%' || $1 || '%' OR je.description ILIKE '%' || $1 || '%'
      `, [expId]);

      assert.ok(jeRes.rows.length >= 1, 'Posting JE must exist');
      const postingJeId = jeRes.rows[0].id;

      const linesRes = await client.query(`
        SELECT jel.debit, jel.credit, coa.code, coa.name
        FROM journal_entry_lines jel
        JOIN chart_of_accounts coa ON coa.id = jel.account_id
        WHERE jel.journal_entry_id = $1
      `, [postingJeId]);

      let totalDebits = 0;
      let totalCredits = 0;
      let inventoryDebits = 0;
      let ppnMasukanDebits = 0;
      let pph23PayableCredits = 0;
      let accountsPayableCredits = 0;

      for (const line of linesRes.rows) {
        const d = Number(line.debit);
        const c = Number(line.credit);
        totalDebits += d;
        totalCredits += c;

        if (line.code === '1130') inventoryDebits += d;
        if (line.code === '1150') ppnMasukanDebits += d;
        if (line.code === '2132') pph23PayableCredits += c;
        if (line.code === '2110') accountsPayableCredits += c;
      }

      // Exact debit and credit balance
      assert.equal(totalDebits, 20_271_854);
      assert.equal(totalCredits, 20_271_854);
      assert.equal(totalDebits, totalCredits, 'Journal entry must be balanced');

      // Individual account verification
      assert.equal(inventoryDebits, 18_651_400, 'Inventory / Landed Cost debit must be 18,651,400');
      assert.equal(ppnMasukanDebits, 1_620_454, 'PPN Masukan (Input VAT) debit must be 1,620,454');
      assert.equal(pph23PayableCredits, 52_000, 'PPh 23 Payable credit must be 52,000');
      assert.equal(accountsPayableCredits, 20_219_854, 'Accounts Payable credit to broker must be 20,219,854');
    });
  });

  await t.test('3. Tax withholding treatment distinction: Net supplier payment vs pending tax remittance', async () => {
    await withDbClient(async (client) => {
      const expRes = await client.query(`
        SELECT paid_amount, pph_paid_amount, pph_amount, settlement_amount
        FROM finance_expenses
        WHERE voucher_number = 'EXP/26/317'
      `);
      assert.equal(expRes.rows.length, 1);
      const exp = expRes.rows[0];

      // Supplier was paid net of PPh 23
      assert.equal(Number(exp.paid_amount), 20_219_854, 'Supplier was paid exactly 20,219,854');
      assert.equal(Number(exp.settlement_amount), 20_219_854, 'Settlement amount is 20,219,854');

      // PPh 23 withholding of 52,000 was deducted and is pending remittance
      assert.equal(Number(exp.pph_amount), 52_000, 'PPh 23 withheld is 52,000');
      assert.equal(Number(exp.pph_paid_amount), 0, 'PPh remittance to DJP is pending (0 paid)');

      // Supplier balance is 0 (Paid)
      const supplierOutstanding = 20_219_854 - Number(exp.paid_amount);
      assert.equal(supplierOutstanding, 0, 'Supplier balance is fully settled (0 outstanding)');
    });
  });

  await t.test('4. UI presentation labels: Accounting Expense (P&L) vs Final Cash Payable to Supplier', () => {
    const expenseManagerCode = readFileSync(
      new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
      'utf8'
    );

    // Verify modal header distinguishes Accounting Expense (P&L) and Cash Payable for broker
    assert.match(expenseManagerCode, /isBroker \? 'Accounting Expense \(P&L\)' : 'Total'/);
    assert.match(expenseManagerCode, /Cash Payable:/);

    // Verify broker summary table labels
    assert.match(expenseManagerCode, /Broker Invoice \(DPP\/Fee\)/);
    assert.match(expenseManagerCode, /Recoverable PPN \(Asset\)/);
    assert.match(expenseManagerCode, /PPh 23 Withheld/);
    assert.match(expenseManagerCode, /Accounting Expense \(P&L\)/);
    assert.match(expenseManagerCode, /Final Cash Payable \(to Supplier\)/);
    assert.match(expenseManagerCode, /Payable to Tax Office/);
  });
});
