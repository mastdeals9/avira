// tests/purchase-invoice-receiving-approval-and-po-mapping.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migrationSource = readFileSync(
  new URL('../supabase/migrations/20261117131225_fix_purchase_invoice_receiving_approval_and_po_line_mapping.sql', import.meta.url),
  'utf8',
);

/**
 * Validates PO-to-PI mapping quantity rules matching create_purchase_invoice_from_po SQL implementation.
 */
function validatePoToPiLineMapping(poItems, invoiceItems) {
  const poMap = new Map(poItems.map(p => [p.id, Number(p.quantity)]));
  const totalsByPoItem = new Map();

  for (const item of invoiceItems) {
    const poItemId = item.purchase_order_item_id;
    const qty = Number(item.quantity || 0);
    totalsByPoItem.set(poItemId, (totalsByPoItem.get(poItemId) || 0) + qty);
  }

  for (const [poItemId, totalInvoiceQty] of totalsByPoItem.entries()) {
    const orderedQty = poMap.get(poItemId);
    if (orderedQty !== undefined && totalInvoiceQty > orderedQty + 0.01) {
      throw new Error(
        'Combined Purchase Invoice quantity mapped to a Purchase Order line exceeds its ordered quantity. Check duplicate-product line mapping before saving.'
      );
    }
  }
  return true;
}

/**
 * Simulates purchase invoice receiving lifecycle with reset_receiving_approval_on_item_change trigger logic.
 */
class PurchaseInvoiceReceivingHarness {
  constructor() {
    this.invoices = new Map();
    this.items = new Map();
    this.allocations = [];
    this.currentContext = {};
  }

  createInvoice({ id, invoiceNumber, receivingApprovalStatus = 'approved' }) {
    const inv = {
      id,
      invoice_number: invoiceNumber,
      receiving_approval_status: receivingApprovalStatus,
      updated_at: new Date().toISOString(),
    };
    this.invoices.set(id, inv);
    return inv;
  }

  addItem({ id, invoiceId, poItemId, quantity, batchNumber = null, batchId = null }) {
    const item = {
      id,
      purchase_invoice_id: invoiceId,
      purchase_order_item_id: poItemId,
      quantity,
      receiving_batch_number: batchNumber,
      batch_id: batchId,
      status: 'pending',
    };
    this.items.set(id, item);
    return item;
  }

  // Simulates reset_receiving_approval_on_item_change trigger
  triggerOnItemUpdate(item, changes) {
    const isInternalReceive = this.currentContext['app.internal_purchase_invoice_receive'] === 'on';
    Object.assign(item, changes);

    if (isInternalReceive) {
      // Bypass resetting approval when explicitly performed by receive_purchase_invoice_item
      return;
    }

    const inv = this.invoices.get(item.purchase_invoice_id);
    if (inv && inv.receiving_approval_status === 'approved') {
      inv.receiving_approval_status = 'pending_approval';
      inv.updated_at = new Date().toISOString();
    }
  }

  // Simulates receive_purchase_invoice_item RPC
  receiveInvoiceItem({ itemId, batchId, batchNumber, receivedQuantity }) {
    const item = this.items.get(itemId);
    if (!item) throw new Error('Item not found');
    const inv = this.invoices.get(item.purchase_invoice_id);
    if (!inv || inv.receiving_approval_status !== 'approved') {
      throw new Error('Invoice must be approved for receiving');
    }

    // Record allocation
    this.allocations.push({
      purchase_invoice_id: inv.id,
      purchase_invoice_item_id: item.id,
      batch_id: batchId,
      received_quantity: receivedQuantity,
      received_at: new Date().toISOString(),
      status: 'received',
    });

    // Set GUC context -> update item -> restore prior context
    const prevContext = this.currentContext['app.internal_purchase_invoice_receive'];
    this.currentContext['app.internal_purchase_invoice_receive'] = 'on';
    try {
      this.triggerOnItemUpdate(item, {
        batch_id: batchId,
        receiving_batch_number: batchNumber,
        status: 'received',
      });
    } finally {
      this.currentContext['app.internal_purchase_invoice_receive'] = prevContext;
    }
  }
}

test('Purchase Invoice Receiving Approval & PO Line Mapping Regression Suite', async (t) => {

  await t.test('1. Receiving one PI batch must not reset the invoice\'s approved receiving status', () => {
    const harness = new PurchaseInvoiceReceivingHarness();
    const invoice = harness.createInvoice({
      id: 'inv-4254414',
      invoiceNumber: '4254414',
      receivingApprovalStatus: 'approved',
    });

    const item1 = harness.addItem({
      id: 'item-300kg',
      invoiceId: invoice.id,
      poItemId: 'po-line-300',
      quantity: 300,
    });

    harness.addItem({
      id: 'item-25kg',
      invoiceId: invoice.id,
      poItemId: 'po-line-25',
      quantity: 25,
    });

    assert.equal(invoice.receiving_approval_status, 'approved', 'Initial state must be approved');

    // Receive first batch (300 kg MA2604120)
    harness.receiveInvoiceItem({
      itemId: item1.id,
      batchId: 'batch-ma2604120',
      batchNumber: 'MA2604120',
      receivedQuantity: 300,
    });

    assert.equal(item1.status, 'received');
    assert.equal(item1.batch_id, 'batch-ma2604120');
    assert.equal(
      invoice.receiving_approval_status,
      'approved',
      'Receiving first batch must NOT demote approved status to pending_approval'
    );
  });

  await t.test('2. A second batch on the same invoice remains independently pending', () => {
    const harness = new PurchaseInvoiceReceivingHarness();
    const invoice = harness.createInvoice({
      id: 'inv-4254414',
      invoiceNumber: '4254414',
      receivingApprovalStatus: 'approved',
    });

    const item1 = harness.addItem({
      id: 'item-300kg',
      invoiceId: invoice.id,
      poItemId: 'po-line-300',
      quantity: 300,
    });

    const item2 = harness.addItem({
      id: 'item-25kg',
      invoiceId: invoice.id,
      poItemId: 'po-line-25',
      quantity: 25,
    });

    // Receive Item 1
    harness.receiveInvoiceItem({
      itemId: item1.id,
      batchId: 'batch-ma2604120',
      batchNumber: 'MA2604120',
      receivedQuantity: 300,
    });

    // Check Item 2 remains independently pending
    assert.equal(item2.status, 'pending');
    assert.equal(item2.batch_id, null);
    assert.equal(item2.receiving_batch_number, null);

    const allocationsForItem2 = harness.allocations.filter(a => a.purchase_invoice_item_id === item2.id);
    assert.equal(allocationsForItem2.length, 0, 'No allocations should exist for unreceived second batch');

    // Receiving Item 2 subsequently succeeds because invoice is still approved
    harness.receiveInvoiceItem({
      itemId: item2.id,
      batchId: 'batch-ma2604122',
      batchNumber: 'MA2604122',
      receivedQuantity: 25,
    });

    assert.equal(item2.status, 'received');
    assert.equal(item2.batch_id, 'batch-ma2604122');
    assert.equal(invoice.receiving_approval_status, 'approved');
  });

  await t.test('3. Duplicate PO-line mapping whose total exceeds that PO line\'s ordered quantity is rejected', () => {
    const poItems = [
      { id: 'po-item-25kg', quantity: 25 },
      { id: 'po-item-300kg', quantity: 300 },
    ];

    // Erroneous mapping: both 300kg and 25kg invoice lines pointing to the 25kg PO line (total 325 kg > 25 kg)
    const invalidInvoiceItems = [
      { id: 'pi-line-1', purchase_order_item_id: 'po-item-25kg', quantity: 300 },
      { id: 'pi-line-2', purchase_order_item_id: 'po-item-25kg', quantity: 25 },
    ];

    assert.throws(
      () => validatePoToPiLineMapping(poItems, invalidInvoiceItems),
      /Combined Purchase Invoice quantity mapped to a Purchase Order line exceeds its ordered quantity/
    );
  });

  await t.test('4. Correct split batch lines mapped to their respective PO lines are accepted', () => {
    const poItems = [
      { id: 'po-item-25kg', quantity: 25 },
      { id: 'po-item-300kg', quantity: 300 },
    ];

    // Correct mapping: 300kg to 300kg PO line, 25kg to 25kg PO line
    const validInvoiceItems = [
      { id: 'pi-line-1', purchase_order_item_id: 'po-item-300kg', quantity: 300 },
      { id: 'pi-line-2', purchase_order_item_id: 'po-item-25kg', quantity: 25 },
    ];

    const result = validatePoToPiLineMapping(poItems, validInvoiceItems);
    assert.equal(result, true, 'Properly mapped lines must be accepted');

    // Also verify legitimate split batches on one PO line (e.g. 150kg + 150kg = 300kg on a 300kg PO line)
    const validSplitBatchItems = [
      { id: 'pi-line-1a', purchase_order_item_id: 'po-item-300kg', quantity: 150 },
      { id: 'pi-line-1b', purchase_order_item_id: 'po-item-300kg', quantity: 150 },
      { id: 'pi-line-2', purchase_order_item_id: 'po-item-25kg', quantity: 25 },
    ];

    const splitResult = validatePoToPiLineMapping(poItems, validSplitBatchItems);
    assert.equal(splitResult, true, 'Legitimate split batches within PO line limit must be accepted');
  });

  await t.test('5. Migration SQL structure and safety assertions verify exactly', () => {
    // 1) Trigger bypasses receiving approval reset when app.internal_purchase_invoice_receive = 'on'
    assert.match(migrationSource, /current_setting\('app\.internal_purchase_invoice_receive',\s*true\)\s*=\s*'on'/);
    // 2) RPC sets internal GUC before item update and restores prior context
    assert.match(migrationSource, /PERFORM\s+set_config\(['']+app\.internal_purchase_invoice_receive['']+,\s*['']+on['']+,\s*true\)/);
    // 3) PO-to-PI validation asserts aggregate quantity against PO line quantity
    assert.match(migrationSource, /mapped\.invoice_quantity\s*>\s*COALESCE\(poi\.quantity,\s*0\)\s*\+\s*0\.01/);
    assert.match(migrationSource, /Combined Purchase Invoice quantity mapped to a Purchase Order line exceeds its ordered quantity/);
    // 4) Repair asserts invoice 4254414 preconditions
    assert.match(migrationSource, /WHERE invoice_number = '4254414'/);
    assert.match(migrationSource, /v_pi\.purchase_order_id <> '60af1017-5144-4abf-ae46-db8b17b3205a'/);
    assert.match(migrationSource, /v_300_item\.receiving_batch_number <> 'MA2604120'/);
    assert.match(migrationSource, /v_25_item\.receiving_batch_number <> 'MA2604122'/);
    assert.match(migrationSource, /162dbeba-bea9-4230-8b68-83c1edec4bde/);
    assert.match(migrationSource, /98d99a8f-0115-4f45-aa23-3b03b606ace7/);
  });
});
