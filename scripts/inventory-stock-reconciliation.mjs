#!/usr/bin/env node

/**
 * SAPJ Inventory Stock Reconciliation — READ ONLY
 *
 * Required:
 *   SUPABASE_URL (or VITE_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Run:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/inventory-stock-reconciliation.mjs
 *
 * This script performs SELECT requests only. It has no repair/apply mode.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const EPSILON = 0.001;
const PAGE_SIZE = 1000;
const OUTPUT_DIR = path.resolve(
  process.cwd(),
  process.env.INVENTORY_RECONCILIATION_OUTPUT_DIR ||
    'audit-reports/inventory-reconciliation',
);

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.error(
    'Missing SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY. ' +
      'A service-role key is required because anonymous RLS visibility is incomplete.',
  );
  process.exit(2);
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nearlyEqual(left, right) {
  return Math.abs(number(left) - number(right)) <= EPSILON;
}

function round(value) {
  return Math.round((number(value) + Number.EPSILON) * 1000) / 1000;
}

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizedReference(value) {
  return lower(value).replace(/[^a-z0-9]/g, '');
}

function isTruthy(value) {
  return value === true || ['true', 't', '1', 'yes'].includes(lower(value));
}

function isSuperseded(transaction) {
  return isTruthy(transaction?.metadata?.superseded);
}

function dateValue(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function daysApart(left, right) {
  const leftDate = dateValue(left);
  const rightDate = dateValue(right);
  if (leftDate === null || rightDate === null) return Number.POSITIVE_INFINITY;
  return Math.abs(leftDate - rightDate) / 86_400_000;
}

function movementMagnitude(movement) {
  return Math.abs(number(movement.quantity));
}

function movementSignedDelta(movement) {
  const result = transactionDelta(movement);
  if (result.deterministic) return result;

  const type = lower(movement.transaction_type);
  const quantity = movementMagnitude(movement);
  if (['sale', 'delivery_challan', 'rejection'].includes(type)) {
    return {
      deterministic: true,
      delta: -quantity,
      evidence: `${type} outbound direction`,
    };
  }
  if (['purchase', 'return'].includes(type)) {
    return {
      deterministic: true,
      delta: quantity,
      evidence: `${type} inbound direction`,
    };
  }
  return result;
}

function movementSummary(movement) {
  return {
    id: movement.id,
    transaction_type: movement.transaction_type,
    quantity: round(movement.quantity),
    transaction_date: movement.transaction_date,
    created_at: movement.created_at,
    reference_type: movement.reference_type,
    reference_id: movement.reference_id,
    reference_number: movement.reference_number,
    stock_before: movement.stock_before,
    stock_after: movement.stock_after,
    notes: movement.notes,
    superseded: isSuperseded(movement),
    superseded_reason: movement?.metadata?.superseded_reason || null,
  };
}

function sum(rows, getter) {
  return round(rows.reduce((total, row) => total + number(getter(row)), 0));
}

function groupBy(rows, getter) {
  const grouped = new Map();
  for (const row of rows) {
    const key = getter(row);
    if (!key) continue;
    const existing = grouped.get(key) || [];
    existing.push(row);
    grouped.set(key, existing);
  }
  return grouped;
}

async function fetchAll(table) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Cannot read ${table}: ${error.message}`);
    }

    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value)
    ? value.join(' | ')
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(rows, columns) {
  const header = columns.map(({ label }) => csvCell(label)).join(',');
  const body = rows.map((row) =>
    columns.map(({ key }) => csvCell(row[key])).join(','),
  );
  return `${[header, ...body].join('\n')}\n`;
}

function transactionDelta(transaction) {
  const quantity = number(transaction.quantity);
  const before = Number(transaction.stock_before);
  const after = Number(transaction.stock_after);

  if (Number.isFinite(before) && Number.isFinite(after)) {
    const delta = round(after - before);
    if (
      nearlyEqual(Math.abs(delta), Math.abs(quantity)) ||
      nearlyEqual(delta, quantity)
    ) {
      return { deterministic: true, delta, evidence: 'stock_before/stock_after' };
    }
  }

  if (quantity < 0) {
    return { deterministic: true, delta: quantity, evidence: 'negative signed quantity' };
  }

  if (quantity === 0) {
    return { deterministic: true, delta: 0, evidence: 'zero quantity' };
  }

  return {
    deterministic: false,
    delta: null,
    evidence: 'positive quantity without reliable before/after evidence',
  };
}

function isSystemAdjustment(transaction) {
  const context = [
    transaction.reference_type,
    transaction.reference_number,
    transaction.notes,
  ]
    .map(lower)
    .join(' ');

  return (
    context.includes('credit_note') ||
    context.includes('credit note') ||
    context.includes('material_return') ||
    context.includes('material return') ||
    context.includes('stock_rejection') ||
    context.includes('stock rejection') ||
    context.includes('return reversed')
  );
}

const [
  batches,
  products,
  movements,
  reservations,
  deliveryChallans,
  deliveryChallanItems,
  salesOrders,
  salesOrderItems,
  salesInvoices,
  salesInvoiceItems,
  materialReturns,
  materialReturnItems,
  stockRejections,
  creditNotes,
  creditNoteItems,
] = await Promise.all([
  fetchAll('batches'),
  fetchAll('products'),
  fetchAll('inventory_transactions'),
  fetchAll('stock_reservations'),
  fetchAll('delivery_challans'),
  fetchAll('delivery_challan_items'),
  fetchAll('sales_orders'),
  fetchAll('sales_order_items'),
  fetchAll('sales_invoices'),
  fetchAll('sales_invoice_items'),
  fetchAll('material_returns'),
  fetchAll('material_return_items'),
  fetchAll('stock_rejections'),
  fetchAll('credit_notes'),
  fetchAll('credit_note_items'),
]);

if (batches.length === 0) {
  throw new Error(
    'Authenticated query returned zero batches. Refusing to generate an empty certification report.',
  );
}

const productById = new Map(products.map((row) => [row.id, row]));
const movementsByBatch = groupBy(movements, (row) => row.batch_id);
const reservationsByBatch = groupBy(reservations, (row) => row.batch_id);
const dcById = new Map(deliveryChallans.map((row) => [row.id, row]));
const dcByNumber = new Map(
  deliveryChallans.map((row) => [normalizedReference(row.challan_number), row]),
);
const dcItemsByBatch = groupBy(deliveryChallanItems, (row) => row.batch_id);
const dcItemById = new Map(deliveryChallanItems.map((row) => [row.id, row]));
const soById = new Map(salesOrders.map((row) => [row.id, row]));
const soItemsByOrder = groupBy(salesOrderItems, (row) => row.sales_order_id);
const invoiceById = new Map(salesInvoices.map((row) => [row.id, row]));
const invoicesByNumber = groupBy(
  salesInvoices,
  (row) => normalizedReference(row.invoice_number),
);
const invoiceItemById = new Map(salesInvoiceItems.map((row) => [row.id, row]));
const invoiceItemsByBatch = groupBy(salesInvoiceItems, (row) => row.batch_id);
const materialReturnById = new Map(materialReturns.map((row) => [row.id, row]));
const materialReturnItemsByBatch = groupBy(
  materialReturnItems,
  (row) => row.batch_id,
);
const rejectionByBatch = groupBy(stockRejections, (row) => row.batch_id);
const creditNoteById = new Map(creditNotes.map((row) => [row.id, row]));
const creditNoteItemsByBatch = groupBy(creditNoteItems, (row) => row.batch_id);

function approvedDcItemEvidence(item) {
  const dc = dcById.get(item.challan_id);
  if (!dc || lower(dc.approval_status) !== 'approved') return null;
  const so = dc.sales_order_id ? soById.get(dc.sales_order_id) : null;
  return {
    item,
    dc,
    so,
    document_number: dc.challan_number,
    document_date: dc.challan_date,
  };
}

function invoiceItemEvidence(item) {
  const invoice = invoiceById.get(item.invoice_id);
  if (!invoice) return null;
  const directDcItem = item.delivery_challan_item_id
    ? dcItemById.get(item.delivery_challan_item_id)
    : null;
  const linkedDcIds = new Set(invoice.linked_challan_ids || []);
  if (directDcItem) linkedDcIds.add(directDcItem.challan_id);
  const linkedApprovedDcItems = deliveryChallanItems
    .filter(
      (dcItem) =>
        dcItem.batch_id === item.batch_id &&
        linkedDcIds.has(dcItem.challan_id) &&
        lower(dcById.get(dcItem.challan_id)?.approval_status) === 'approved',
    )
    .map(approvedDcItemEvidence)
    .filter(Boolean);

  return {
    item,
    invoice,
    direct_dc_item: directDcItem,
    direct_dc: directDcItem ? dcById.get(directDcItem.challan_id) : null,
    linked_approved_dc_items: linkedApprovedDcItems,
  };
}

function matchSaleMovement(movement, batchInvoiceItems, approvedDcEvidence) {
  const quantity = movementMagnitude(movement);
  const directItem = invoiceItemById.get(movement.reference_id);
  let candidates = [];
  let confidence = null;

  if (directItem && directItem.batch_id === movement.batch_id) {
    candidates = [directItem];
    confidence = 'direct sales_invoice_item reference_id';
  } else {
    const referencedInvoices =
      invoicesByNumber.get(normalizedReference(movement.reference_number)) || [];
    candidates = batchInvoiceItems.filter(
      (item) =>
        referencedInvoices.some((invoice) => invoice.id === item.invoice_id) &&
        nearlyEqual(item.quantity, quantity),
    );
    if (candidates.length === 1) {
      confidence = 'unique invoice number + batch + quantity';
    }
  }

  if (candidates.length === 1) {
    const evidence = invoiceItemEvidence(candidates[0]);
    const linkedDcEvidence = evidence
      ? [
          evidence.direct_dc_item
            ? approvedDcItemEvidence(evidence.direct_dc_item)
            : null,
          ...evidence.linked_approved_dc_items,
        ].filter(Boolean)
      : [];
    const exactDc = linkedDcEvidence.find(
      (entry) =>
        entry.item.batch_id === movement.batch_id &&
        nearlyEqual(entry.item.quantity, quantity),
    );

    if (exactDc) {
      return {
        status: 'MATCHED_DC_INVOICE',
        confidence,
        invoice_item_id: candidates[0].id,
        invoice_id: evidence.invoice.id,
        invoice_number: evidence.invoice.invoice_number,
        dc_item_id: exactDc.item.id,
        dc_id: exactDc.dc.id,
        dc_number: exactDc.dc.challan_number,
        sales_order_id: exactDc.so?.id || null,
        sales_order_number: exactDc.so?.so_number || null,
      };
    }

    return {
      status: 'MATCHED_LEGACY_INVOICE',
      confidence,
      invoice_item_id: candidates[0].id,
      invoice_id: evidence.invoice.id,
      invoice_number: evidence.invoice.invoice_number,
      dc_item_id: null,
      dc_id: null,
      dc_number: null,
      sales_order_id: evidence.invoice.sales_order_id || null,
      sales_order_number: evidence.invoice.sales_order_id
        ? soById.get(evidence.invoice.sales_order_id)?.so_number || null
        : null,
    };
  }

  if (candidates.length > 1) {
    return {
      status: 'AMBIGUOUS_INVOICE',
      confidence: 'multiple invoice items match invoice number + batch + quantity',
      candidate_ids: candidates.map((item) => item.id),
    };
  }

  const directDcItem = dcItemById.get(movement.reference_id);
  const directDc =
    dcById.get(movement.reference_id) ||
    (directDcItem ? dcById.get(directDcItem.challan_id) : null) ||
    dcByNumber.get(normalizedReference(movement.reference_number));
  let dcCandidates = approvedDcEvidence.filter(
    (entry) =>
      nearlyEqual(entry.item.quantity, quantity) &&
      (!directDc || entry.dc.id === directDc.id),
  );

  if (!directDc) {
    const dateCandidates = dcCandidates.filter(
      (entry) =>
        daysApart(movement.transaction_date, entry.dc.challan_date) <= 7,
    );
    if (dateCandidates.length > 0) dcCandidates = dateCandidates;
  }

  if (dcCandidates.length === 1) {
    const entry = dcCandidates[0];
    return {
      status: 'MATCHED_DC_LEGACY',
      confidence: directDc
        ? 'direct DC reference + batch + quantity'
        : 'unique batch + quantity + date-window DC match',
      invoice_item_id: null,
      invoice_id: null,
      invoice_number: null,
      dc_item_id: entry.item.id,
      dc_id: entry.dc.id,
      dc_number: entry.dc.challan_number,
      sales_order_id: entry.so?.id || null,
      sales_order_number: entry.so?.so_number || null,
    };
  }

  return {
    status: dcCandidates.length > 1 ? 'AMBIGUOUS_DC' : 'ORPHAN_SALE',
    confidence:
      dcCandidates.length > 1
        ? 'multiple DC items match batch + quantity + date'
        : 'no invoice item or approved DC item supports this sale movement',
    candidate_ids: dcCandidates.map((entry) => entry.item.id),
  };
}

function matchDcMovement(movement, approvedDcEvidence) {
  const quantity = movementMagnitude(movement);
  const directItem = dcItemById.get(movement.reference_id);
  const directDc =
    dcById.get(movement.reference_id) ||
    (directItem ? dcById.get(directItem.challan_id) : null) ||
    dcByNumber.get(normalizedReference(movement.reference_number));
  let candidates = approvedDcEvidence.filter(
    (entry) =>
      nearlyEqual(entry.item.quantity, quantity) &&
      (!directDc || entry.dc.id === directDc.id),
  );

  if (candidates.length === 0 && directDc) {
    const directBatchCandidates = approvedDcEvidence.filter(
      (entry) => entry.dc.id === directDc.id,
    );
    if (directBatchCandidates.length === 1) {
      const entry = directBatchCandidates[0];
      return {
        status: 'MATCHED_DC',
        confidence: 'direct DC reference + batch (DC item quantity adjusted)',
        dc_item_id: entry.item.id,
        dc_id: entry.dc.id,
        dc_number: entry.dc.challan_number,
        sales_order_id: entry.so?.id || null,
        sales_order_number: entry.so?.so_number || null,
      };
    }
  }

  if (!directDc) {
    const dateCandidates = candidates.filter(
      (entry) =>
        daysApart(movement.transaction_date, entry.dc.challan_date) <= 7,
    );
    if (dateCandidates.length > 0) candidates = dateCandidates;
  }

  if (candidates.length === 1) {
    const entry = candidates[0];
    return {
      status: 'MATCHED_DC',
      confidence: directDc
        ? 'direct DC reference + batch + quantity'
        : 'unique batch + quantity + date-window DC match',
      dc_item_id: entry.item.id,
      dc_id: entry.dc.id,
      dc_number: entry.dc.challan_number,
      sales_order_id: entry.so?.id || null,
      sales_order_number: entry.so?.so_number || null,
    };
  }

  return {
    status: candidates.length > 1 ? 'AMBIGUOUS_DC' : 'ORPHAN_DC_MOVEMENT',
    confidence:
      candidates.length > 1
        ? 'multiple approved DC items match'
        : 'no approved DC item supports this movement',
    candidate_ids: candidates.map((entry) => entry.item.id),
  };
}

const rows = batches.map((batch) => {
  const reviewReasons = [];
  const repairReasons = [];
  const safeRepairProposals = [];
  const legacyEvidence = [];
  const chainEvidence = [];
  const batchMovements = movementsByBatch.get(batch.id) || [];
  const effectiveMovements = batchMovements.filter(
    (movement) => !isSuperseded(movement),
  );
  const supersededMovements = batchMovements.filter(isSuperseded);
  const batchReservations = reservationsByBatch.get(batch.id) || [];
  const batchDcItems = dcItemsByBatch.get(batch.id) || [];
  const batchInvoiceItems = invoiceItemsByBatch.get(batch.id) || [];
  const batchMaterialReturnItems = materialReturnItemsByBatch.get(batch.id) || [];
  const batchRejections = rejectionByBatch.get(batch.id) || [];
  const batchCreditNoteItems = creditNoteItemsByBatch.get(batch.id) || [];

  const activeReservations = batchReservations.filter((reservation) => {
    const status = lower(reservation.status);
    return (
      (status === 'active' || status === '') &&
      reservation.is_released !== true
    );
  });
  const reservedQuantity = sum(
    activeReservations,
    (reservation) => reservation.reserved_quantity,
  );
  const storedReservedQuantity = number(batch.reserved_stock);
  if (!nearlyEqual(reservedQuantity, storedReservedQuantity)) {
    reviewReasons.push(
      `stored reserved_stock ${round(storedReservedQuantity)} differs from active reservations ${reservedQuantity}`,
    );
  }

  const approvedDcEvidence = batchDcItems
    .map(approvedDcItemEvidence)
    .filter(Boolean);
  const deliveryChallanOutboundQuantity = sum(
    approvedDcEvidence,
    (entry) => entry.item.quantity,
  );

  const saleMovements = batchMovements.filter(
    (movement) => lower(movement.transaction_type) === 'sale',
  );
  const allAdjustmentMovements = batchMovements.filter(
    (movement) => lower(movement.transaction_type) === 'adjustment',
  );
  const saleMatches = saleMovements.map((movement) => ({
    movement,
    match: matchSaleMovement(
      movement,
      batchInvoiceItems,
      approvedDcEvidence,
    ),
  }));

  const usedSaleReversalIds = new Set();
  for (const entry of saleMatches) {
    if (
      !['ORPHAN_SALE', 'AMBIGUOUS_DC', 'AMBIGUOUS_INVOICE'].includes(
        entry.match.status,
      )
    ) {
      continue;
    }

    const saleReference = normalizedReference(entry.movement.reference_number);
    const candidates = allAdjustmentMovements.filter((adjustment) => {
      if (isSuperseded(adjustment) || usedSaleReversalIds.has(adjustment.id)) {
        return false;
      }
      const result = transactionDelta(adjustment);
      if (!result.deterministic || result.delta <= 0) return false;
      if (!nearlyEqual(result.delta, movementMagnitude(entry.movement))) {
        return false;
      }
      const context = lower(
        [
          adjustment.reference_type,
          adjustment.reference_number,
          adjustment.notes,
        ].join(' '),
      );
      if (
        !context.includes('deleted manual invoice item') &&
        !context.includes('reversed direct sale')
      ) {
        return false;
      }
      const adjustmentReference = normalizedReference(
        adjustment.reference_number,
      ).replace(/reversed$/, '');
      const referenceCompatible =
        !saleReference ||
        !adjustmentReference ||
        saleReference === adjustmentReference;
      return (
        referenceCompatible &&
        dateValue(adjustment.created_at) >= dateValue(entry.movement.created_at)
      );
    });

    if (candidates.length > 0) {
      candidates.sort(
        (left, right) =>
          dateValue(left.created_at) - dateValue(right.created_at),
      );
      const selected = candidates[0];
      usedSaleReversalIds.add(selected.id);
      entry.match = {
        status: 'MATCHED_LEGACY_REVERSAL',
        confidence:
          'sale quantity is exactly reversed by the earliest compatible later invoice-delete adjustment',
        reversal_adjustment_id: selected.id,
        reversal_quantity: round(
          transactionDelta(selected).delta,
        ),
        reference_number:
          entry.movement.reference_number ||
          selected.reference_number ||
          null,
      };
    }
  }

  for (const { movement, match } of saleMatches) {
    chainEvidence.push({
      movement: movementSummary(movement),
      match,
    });
    if (
      ['MATCHED_DC_INVOICE', 'MATCHED_DC_LEGACY'].includes(match.status)
    ) {
      legacyEvidence.push(
        `${movement.reference_number || movement.id}: legacy sale matched to ${match.dc_number}${match.invoice_number ? ` through ${match.invoice_number}` : ''} (${match.confidence})`,
      );
    } else if (match.status === 'MATCHED_LEGACY_INVOICE') {
      legacyEvidence.push(
        `${movement.reference_number || movement.id}: legacy direct-invoice movement supported by invoice ${match.invoice_number}`,
      );
    } else if (match.status === 'MATCHED_LEGACY_REVERSAL') {
      legacyEvidence.push(
        `${movement.reference_number || movement.id}: legacy direct sale is exactly reversed by adjustment ${match.reversal_adjustment_id}`,
      );
    } else if (match.status.startsWith('AMBIGUOUS')) {
      reviewReasons.push(
        `${movement.id}: ${match.status} — ${match.confidence}`,
      );
    } else {
      reviewReasons.push(
        `${movement.id}: orphan sale movement — ${match.confidence}`,
      );
    }
  }

  const dcMovements = batchMovements.filter(
    (movement) => lower(movement.transaction_type) === 'delivery_challan',
  );
  const dcMatches = dcMovements.map((movement) => ({
    movement,
    match: matchDcMovement(movement, approvedDcEvidence),
  }));
  for (const { movement, match } of dcMatches) {
    chainEvidence.push({
      movement: movementSummary(movement),
      match,
    });
    if (match.status === 'MATCHED_DC') continue;
    if (match.status === 'AMBIGUOUS_DC') {
      reviewReasons.push(`${movement.id}: ambiguous DC movement match`);
    } else if (!isSuperseded(movement)) {
      reviewReasons.push(
        `${movement.id}: DC movement has no surviving approved DC document`,
      );
    }
  }

  const purchaseMovements = effectiveMovements.filter(
    (movement) => lower(movement.transaction_type) === 'purchase',
  );
  const openingMovementQuantity = sum(
    purchaseMovements,
    movementMagnitude,
  );
  if (
    purchaseMovements.length !== 1 ||
    !nearlyEqual(openingMovementQuantity, batch.import_quantity)
  ) {
    legacyEvidence.push(
      `legacy Batch Creation ledger gap: ${purchaseMovements.length} effective row(s), movement quantity ${openingMovementQuantity}, batch import_quantity ${round(batch.import_quantity)}`,
    );
  }

  const confirmedMaterialReturnQuantity = sum(
    batchMaterialReturnItems.filter((item) => {
      const source = materialReturnById.get(item.return_id);
      return (
        source &&
        ['approved', 'completed'].includes(lower(source.status)) &&
        source.restocked === true &&
        lower(item.disposition) === 'restock'
      );
    }),
    (item) => item.quantity_returned,
  );
  const pendingMaterialReturnQuantity = sum(
    batchMaterialReturnItems.filter((item) => {
      const source = materialReturnById.get(item.return_id);
      return (
        source &&
        ['approved', 'completed'].includes(lower(source.status)) &&
        source.restocked !== true &&
        lower(item.disposition) === 'restock'
      );
    }),
    (item) => item.quantity_returned,
  );
  if (pendingMaterialReturnQuantity > 0) {
    reviewReasons.push(
      `approved/completed Material Return marked restock but restocked is not true: ${pendingMaterialReturnQuantity}`,
    );
  }

  const approvedCreditNoteQuantity = sum(
    batchCreditNoteItems.filter((item) => {
      const source = creditNoteById.get(item.credit_note_id);
      return source && lower(source.status) === 'approved';
    }),
    (item) => item.quantity,
  );
  if (
    confirmedMaterialReturnQuantity > 0 &&
    approvedCreditNoteQuantity > 0
  ) {
    reviewReasons.push(
      'both Material Return and Credit Note return sources exist without enough linkage to prove separate physical returns',
    );
  }
  const sourceReturnsCandidate = round(
    confirmedMaterialReturnQuantity + approvedCreditNoteQuantity,
  );

  const approvedRejectionQuantity = sum(
    batchRejections.filter((rejection) =>
      ['approved', 'disposed'].includes(lower(rejection.status)),
    ),
    (rejection) => rejection.quantity_rejected,
  );

  const reservationMovementTypes = new Set(['delivery_challan_reserved']);
  const reservationMovements = batchMovements.filter((movement) =>
    reservationMovementTypes.has(lower(movement.transaction_type)),
  );
  if (reservationMovements.length > 0) {
    legacyEvidence.push(
      `${reservationMovements.length} legacy delivery_challan_reserved row(s) treated as reservation history only`,
    );
  }

  let deterministicAdjustmentQuantity = 0;
  let ambiguousAdjustmentQuantity = 0;
  const adjustmentMovements = effectiveMovements.filter(
    (movement) => lower(movement.transaction_type) === 'adjustment',
  );
  for (const movement of adjustmentMovements) {
    if (usedSaleReversalIds.has(movement.id)) {
      legacyEvidence.push(
        `${movement.id}: paired reversal of a legacy direct-invoice movement`,
      );
      continue;
    }
    const context = lower(
      [
        movement.reference_type,
        movement.reference_number,
        movement.notes,
      ].join(' '),
    );
    const reservationOnly =
      context.includes('reserved for dc') ||
      context.includes('released reservation') ||
      context.includes('pending dc item');
    const dcLifecycleOnly =
      context.includes('reversed delivery from deleted dc item') ||
      lower(movement.reference_type) === 'dc_item_delete';
    const returnOrRejectionSystem = isSystemAdjustment(movement);

    if (reservationOnly || dcLifecycleOnly || returnOrRejectionSystem) {
      legacyEvidence.push(
        `${movement.id}: legacy system adjustment treated as document lifecycle evidence, not an independent current movement`,
      );
      continue;
    }

    const result = transactionDelta(movement);
    if (!result.deterministic) {
      ambiguousAdjustmentQuantity += movementMagnitude(movement);
      reviewReasons.push(
        `ambiguous adjustment ${movement.id}: ${result.evidence}`,
      );
      continue;
    }
    deterministicAdjustmentQuantity += result.delta;
    legacyEvidence.push(
      `${movement.id}: deterministic historical adjustment ${round(result.delta)} (${result.evidence})`,
    );
  }
  deterministicAdjustmentQuantity = round(deterministicAdjustmentQuantity);
  ambiguousAdjustmentQuantity = round(ambiguousAdjustmentQuantity);

  const canonicalDocumentExpected = round(
    number(batch.import_quantity) -
      deliveryChallanOutboundQuantity +
      sourceReturnsCandidate -
      approvedRejectionQuantity,
  );
  const adjustedDocumentExpected = round(
    canonicalDocumentExpected + deterministicAdjustmentQuantity,
  );

  let replayQuantity = 0;
  let replayDeterministic = true;
  for (const movement of effectiveMovements) {
    const type = lower(movement.transaction_type);
    if (reservationMovementTypes.has(type)) continue;
    const result = movementSignedDelta(movement);
    if (!result.deterministic) {
      replayDeterministic = false;
      continue;
    }
    replayQuantity += result.delta;
  }
  const expectedFromEffectiveMovementReplay = round(replayQuantity);

  const currentBatchQuantity = round(batch.current_stock);
  const canonicalMatches = nearlyEqual(
    currentBatchQuantity,
    canonicalDocumentExpected,
  );
  const adjustedMatches = nearlyEqual(
    currentBatchQuantity,
    adjustedDocumentExpected,
  );
  const replayMatches =
    replayDeterministic &&
    nearlyEqual(currentBatchQuantity, expectedFromEffectiveMovementReplay);

  let finalExpectedBalance = canonicalDocumentExpected;
  let reconciliationBasis = 'canonical document chain';
  if (!canonicalMatches && adjustedMatches) {
    finalExpectedBalance = adjustedDocumentExpected;
    reconciliationBasis = 'canonical document chain + deterministic adjustment';
  } else if (!canonicalMatches && !adjustedMatches && replayMatches) {
    finalExpectedBalance = expectedFromEffectiveMovementReplay;
    reconciliationBasis = 'complete effective legacy movement replay';
  }

  const unresolvedEvidence = reviewReasons.length > 0;
  const hasLegacy =
    supersededMovements.length > 0 ||
    saleMovements.length > 0 ||
    reservationMovements.length > 0 ||
    legacyEvidence.length > 0;
  const mathematicallyExplained =
    canonicalMatches || adjustedMatches || replayMatches;

  if (!mathematicallyExplained && !unresolvedEvidence) {
    repairReasons.push(
      `current stock ${currentBatchQuantity} differs from canonical documents ${canonicalDocumentExpected}, adjusted documents ${adjustedDocumentExpected}, and effective movement replay ${expectedFromEffectiveMovementReplay}`,
    );
  }

  const duplicateDcGroups = groupBy(
    dcMatches.filter(
      ({ movement, match }) =>
        !isSuperseded(movement) && match.status === 'MATCHED_DC',
    ),
    ({ match }) => match.dc_item_id,
  );
  const usedDcReversalIds = new Set();
  for (const [dcItemId, matches] of duplicateDcGroups) {
    if (matches.length <= 1) continue;
    const dcItem = dcItemById.get(dcItemId);
    const rankedMatches = [...matches].sort((left, right) => {
      const leftDirect =
        left.movement.reference_id === dcItemId ||
        left.movement.reference_id === left.match.dc_id;
      const rightDirect =
        right.movement.reference_id === dcItemId ||
        right.movement.reference_id === right.match.dc_id;
      if (leftDirect !== rightDirect) return leftDirect ? -1 : 1;
      return (
        dateValue(right.movement.created_at) -
        dateValue(left.movement.created_at)
      );
    });
    const historicalDuplicates = rankedMatches.slice(1);
    const unpairedDuplicates = [];

    for (const duplicate of historicalDuplicates) {
      const duplicateReference = normalizedReference(
        duplicate.movement.reference_number,
      );
      const reversalCandidates = allAdjustmentMovements.filter((adjustment) => {
        if (
          isSuperseded(adjustment) ||
          usedDcReversalIds.has(adjustment.id) ||
          usedSaleReversalIds.has(adjustment.id)
        ) {
          return false;
        }
        const result = transactionDelta(adjustment);
        if (
          !result.deterministic ||
          result.delta <= 0 ||
          !nearlyEqual(result.delta, movementMagnitude(duplicate.movement))
        ) {
          return false;
        }
        const context = lower(
          [
            adjustment.reference_type,
            adjustment.reference_number,
            adjustment.notes,
          ].join(' '),
        );
        if (
          !context.includes('reversed delivery') &&
          !context.includes('deleted dc item')
        ) {
          return false;
        }
        const adjustmentReference = normalizedReference(
          adjustment.reference_number,
        );
        return (
          (!duplicateReference ||
            !adjustmentReference ||
            duplicateReference === adjustmentReference) &&
          dateValue(adjustment.created_at) >=
            dateValue(duplicate.movement.created_at)
        );
      });

      if (reversalCandidates.length > 0) {
        reversalCandidates.sort(
          (left, right) =>
            dateValue(left.created_at) - dateValue(right.created_at),
        );
        const selected = reversalCandidates[0];
        usedDcReversalIds.add(selected.id);
        legacyEvidence.push(
          `${duplicate.movement.id}: historical duplicate DC row is exactly reversed by adjustment ${selected.id}`,
        );
      } else {
        unpairedDuplicates.push(duplicate);
      }
    }

    if (dcItem && unpairedDuplicates.length > 0) {
      const postedQuantity = sum(matches, ({ movement }) =>
        movementSignedDelta(movement).delta,
      );
      repairReasons.push(
        `${matches.length} effective DC movement rows post ${round(postedQuantity)} against DC item ${dcItemId} quantity ${round(dcItem.quantity)}; ${unpairedDuplicates.length} duplicate row(s) have no provable reversal`,
      );
      safeRepairProposals.push({
        action: 'MARK_DUPLICATE_MOVEMENT_SUPERSEDED',
        target_table: 'inventory_transactions',
        target_ids: unpairedDuplicates.map(({ movement }) => movement.id),
        retained_movement_id: rankedMatches[0].movement.id,
        source_document_type: 'delivery_challan_item',
        source_document_id: dcItemId,
        source_document_quantity: round(dcItem.quantity),
        stock_update_required: false,
        proposal_only: true,
        preconditions: [
          `batch current_stock remains ${currentBatchQuantity}`,
          `canonical document expectation remains ${canonicalDocumentExpected}`,
          `approved Delivery Challan item ${dcItemId} remains quantity ${round(dcItem.quantity)}`,
          `retained movement ${rankedMatches[0].movement.id} remains the sole effective DC movement for this item`,
        ],
        rationale:
          'The approved DC document and current batch balance are correct. Only duplicate audit rows should be marked superseded; batch quantity and source documents must not change.',
      });
    } else {
      legacyEvidence.push(
        `${matches.length} historical DC rows resolve to one current DC item ${dcItemId} after lifecycle reversals`,
      );
    }
  }

  let reconciliationStatus;
  if (unresolvedEvidence) {
    reconciliationStatus = 'MANUAL REVIEW';
  } else if (repairReasons.length > 0) {
    reconciliationStatus = 'REPAIR REQUIRED';
  } else if (hasLegacy) {
    reconciliationStatus = 'LEGACY VERIFIED';
  } else {
    reconciliationStatus = 'VERIFIED';
  }

  const product = productById.get(batch.product_id);
  const availableQuantity = round(currentBatchQuantity - reservedQuantity);
  const expectedAvailableQuantity = round(
    finalExpectedBalance - reservedQuantity,
  );
  const matchedLegacySaleQuantity = sum(
    saleMatches.filter(({ match }) =>
      ['MATCHED_DC_INVOICE', 'MATCHED_DC_LEGACY'].includes(match.status),
    ),
    ({ movement }) => movementMagnitude(movement),
  );
  const unmatchedSaleQuantity = sum(
    saleMatches.filter(({ match }) =>
      ['ORPHAN_SALE', 'AMBIGUOUS_DC', 'AMBIGUOUS_INVOICE'].includes(
        match.status,
      ),
    ),
    ({ movement }) => movementMagnitude(movement),
  );

  return {
    batch_id: batch.id,
    batch_number: batch.batch_number,
    product_id: batch.product_id,
    product_code: product?.product_code || '',
    product_name: product?.product_name || '',
    is_active: batch.is_active,
    current_batch_quantity: currentBatchQuantity,
    expected_quantity_from_canonical_movements:
      expectedFromEffectiveMovementReplay,
    canonical_document_expected_quantity: canonicalDocumentExpected,
    adjusted_document_expected_quantity: adjustedDocumentExpected,
    reserved_quantity: reservedQuantity,
    stored_reserved_quantity: round(storedReservedQuantity),
    available_quantity: availableQuantity,
    expected_available_quantity: expectedAvailableQuantity,
    delivery_challan_outbound_quantity: deliveryChallanOutboundQuantity,
    sales_invoice_physical_movement_quantity: sum(
      saleMovements.filter((movement) => !isSuperseded(movement)),
      movementMagnitude,
    ),
    legacy_sale_movement_quantity: sum(saleMovements, movementMagnitude),
    matched_legacy_sale_quantity: matchedLegacySaleQuantity,
    unlinked_sale_movement_quantity: unmatchedSaleQuantity,
    returns_quantity: sourceReturnsCandidate,
    approved_return_document_candidate_quantity: sourceReturnsCandidate,
    manual_adjustments: deterministicAdjustmentQuantity,
    ambiguous_adjustment_quantity: ambiguousAdjustmentQuantity,
    stock_rejections: approvedRejectionQuantity,
    batch_creation_quantity: round(batch.import_quantity),
    batch_creation_movement_quantity: openingMovementQuantity,
    effective_movement_replay_quantity: expectedFromEffectiveMovementReplay,
    replay_is_deterministic: replayDeterministic,
    final_expected_balance: finalExpectedBalance,
    reconciliation_basis: reconciliationBasis,
    current_vs_final_variance: round(
      currentBatchQuantity - finalExpectedBalance,
    ),
    movement_vs_source_variance: round(
      expectedFromEffectiveMovementReplay - canonicalDocumentExpected,
    ),
    reconciliation_status: reconciliationStatus,
    manual_review_reasons: reviewReasons,
    repair_required_reasons: repairReasons,
    safe_repair_proposals: safeRepairProposals,
    legacy_evidence: legacyEvidence,
    document_chain_evidence: chainEvidence,
    sales_order_documents: [
      ...new Map(
        approvedDcEvidence
          .filter((entry) => entry.so)
          .map((entry) => [
            entry.so.id,
            {
              id: entry.so.id,
              number: entry.so.so_number,
              status: entry.so.status,
              item_count: (soItemsByOrder.get(entry.so.id) || []).length,
            },
          ]),
      ).values(),
    ],
    delivery_challan_documents: approvedDcEvidence.map((entry) => ({
      id: entry.dc.id,
      number: entry.dc.challan_number,
      date: entry.dc.challan_date,
      status: entry.dc.approval_status,
      item_id: entry.item.id,
      quantity: round(entry.item.quantity),
      sales_order_id: entry.dc.sales_order_id,
    })),
    sales_invoice_documents: batchInvoiceItems
      .map(invoiceItemEvidence)
      .filter(Boolean)
      .map((entry) => ({
        id: entry.invoice.id,
        number: entry.invoice.invoice_number,
        date: entry.invoice.invoice_date,
        is_draft: entry.invoice.is_draft,
        item_id: entry.item.id,
        quantity: round(entry.item.quantity),
        delivery_challan_item_id: entry.item.delivery_challan_item_id,
        linked_challan_ids: entry.invoice.linked_challan_ids || [],
      })),
  };
});

rows.sort((left, right) =>
  String(left.batch_number).localeCompare(String(right.batch_number)),
);

const manualReviewRows = rows.filter(
  (row) => row.reconciliation_status === 'MANUAL REVIEW',
);
const repairRequiredRows = rows.filter(
  (row) => row.reconciliation_status === 'REPAIR REQUIRED',
);
const verifiedRows = rows.filter(
  (row) => row.reconciliation_status === 'VERIFIED',
);
const legacyVerifiedRows = rows.filter(
  (row) => row.reconciliation_status === 'LEGACY VERIFIED',
);
const safeRepairProposals = repairRequiredRows.flatMap((row) =>
  row.safe_repair_proposals.map((proposal) => ({
    batch_id: row.batch_id,
    batch_number: row.batch_number,
    product_name: row.product_name,
    current_batch_quantity: row.current_batch_quantity,
    canonical_document_expected_quantity:
      row.canonical_document_expected_quantity,
    ...proposal,
  })),
);

const columns = [
  { key: 'batch_id', label: 'Batch ID' },
  { key: 'batch_number', label: 'Batch Number' },
  { key: 'product_code', label: 'Product Code' },
  { key: 'product_name', label: 'Product Name' },
  { key: 'current_batch_quantity', label: 'Current Batch Quantity' },
  {
    key: 'expected_quantity_from_canonical_movements',
    label: 'Expected Quantity from Effective Inventory Movement Replay',
  },
  {
    key: 'canonical_document_expected_quantity',
    label: 'Expected Quantity from Canonical Document Chain',
  },
  { key: 'reserved_quantity', label: 'Reserved Quantity' },
  { key: 'available_quantity', label: 'Available Quantity' },
  {
    key: 'delivery_challan_outbound_quantity',
    label: 'Delivery Challan Outbound Quantity',
  },
  {
    key: 'sales_invoice_physical_movement_quantity',
    label: 'Sales Invoice Quantity (Physical Movement; Must Be Zero)',
  },
  { key: 'returns_quantity', label: 'Returns Quantity' },
  { key: 'manual_adjustments', label: 'Manual Adjustments' },
  { key: 'stock_rejections', label: 'Stock Rejections' },
  { key: 'final_expected_balance', label: 'Final Expected Balance' },
  { key: 'current_vs_final_variance', label: 'Current vs Final Variance' },
  {
    key: 'movement_vs_source_variance',
    label: 'Movement vs Source Variance',
  },
  { key: 'reconciliation_status', label: 'Reconciliation Status' },
  { key: 'manual_review_reasons', label: 'Manual Review Reasons' },
  { key: 'repair_required_reasons', label: 'Repair Required Reasons' },
  { key: 'safe_repair_proposals', label: 'Safe Repair Proposals' },
  { key: 'reconciliation_basis', label: 'Reconciliation Basis' },
  { key: 'legacy_evidence', label: 'Legacy Evidence' },
  { key: 'document_chain_evidence', label: 'Document Chain Evidence' },
  { key: 'stored_reserved_quantity', label: 'Stored Reserved Quantity' },
  {
    key: 'expected_available_quantity',
    label: 'Expected Available Quantity',
  },
  {
    key: 'approved_return_document_candidate_quantity',
    label: 'Approved Return Document Candidate Quantity',
  },
  {
    key: 'stock_rejection_movement_quantity',
    label: 'Stock Rejection Movement Quantity',
  },
  {
    key: 'batch_creation_quantity',
    label: 'Batch Creation Quantity',
  },
  {
    key: 'batch_creation_movement_quantity',
    label: 'Batch Creation Movement Quantity',
  },
  {
    key: 'ambiguous_adjustment_quantity',
    label: 'Ambiguous Adjustment Quantity',
  },
  {
    key: 'unlinked_sale_movement_quantity',
    label: 'Unlinked Sale Movement Quantity',
  },
  {
    key: 'matched_legacy_sale_quantity',
    label: 'Matched Legacy Sale Movement Quantity',
  },
];

const generatedAt = new Date().toISOString();
const repairProposalSummary =
  safeRepairProposals.length === 0
    ? 'No mathematically provable safe repair is proposed.'
    : safeRepairProposals
        .map(
          (proposal) =>
            `- **${proposal.batch_number}**: mark movement row(s) \`${proposal.target_ids.join('`, `')}\` superseded; retain \`${proposal.retained_movement_id}\`. No stock quantity or source document change.`,
        )
        .join('\n');
const manualReviewSummary =
  manualReviewRows.length === 0
    ? 'No batches require manual review.'
    : manualReviewRows
        .map(
          (row) =>
            `- **${row.batch_number}**: ${row.manual_review_reasons.join('; ')}`,
        )
        .join('\n');
const summary = `# SAPJ Inventory Batch Reconciliation

Generated: ${generatedAt}

Mode: **read only**. No historical stock, movements, reservations, or source
documents were modified.

## Result

| Classification | Batches |
|---|---:|
| Verified | ${verifiedRows.length} |
| Legacy Verified | ${legacyVerifiedRows.length} |
| Manual review required | ${manualReviewRows.length} |
| Repair required | ${repairRequiredRows.length} |
| **Total batches** | **${rows.length}** |

## Safe repair proposals

${repairProposalSummary}

These proposals are not executable output. They do not authorize changes and
must be revalidated immediately before any later repair.

## Manual review

${manualReviewSummary}

## Rules applied

- Batch Creation is the only inbound stock source.
- Approved Delivery Challan is the only normal outbound stock source.
- Sales Invoice is accounting-only in the canonical architecture.
- Historical \`sale\` rows are traced through invoice items, linked Delivery
  Challan items, Delivery Challans, and Sales Orders before classification.
- Explicitly superseded movements remain visible as audit evidence but are
  excluded from effective physical stock.
- A unique direct-reference or document-number/batch/quantity/date match may
  verify a legacy row. Multiple candidates remain Manual Review.
- \`delivery_challan_reserved\` rows are reservation history, not physical
  movement.
- Active, unreleased reservations determine Reserved Quantity.
- Approved/restocked Material Returns and approved Credit Notes are return
  candidates. Where their relationship cannot be proven, the batch is sent to
  manual review.
- Signed adjustments are accepted only when their direction is mathematically
  supported by their sign or stock-before/stock-after values.
- Positive adjustments without reliable before/after evidence are ambiguous
  because the current adjustment RPC can lose an outbound sign.
- No repair is proposed for a Manual Review batch.

## Repair gate

Only rows classified as \`REPAIR REQUIRED\` are eligible for a proposed repair,
and only where the contradiction is mathematically provable. This report does
not perform or authorize repair. Every \`MANUAL REVIEW\` row requires
documentary investigation first.
`;

await mkdir(OUTPUT_DIR, { recursive: true });
await Promise.all([
  writeFile(
    path.join(OUTPUT_DIR, 'batch-reconciliation.csv'),
    toCsv(rows, columns),
    'utf8',
  ),
  writeFile(
    path.join(OUTPUT_DIR, 'manual-review.csv'),
    toCsv(manualReviewRows, columns),
    'utf8',
  ),
  writeFile(
    path.join(OUTPUT_DIR, 'repair-required.csv'),
    toCsv(repairRequiredRows, columns),
    'utf8',
  ),
  writeFile(
    path.join(OUTPUT_DIR, 'legacy-verified.csv'),
    toCsv(legacyVerifiedRows, columns),
    'utf8',
  ),
  writeFile(
    path.join(OUTPUT_DIR, 'safe-repair-proposals.json'),
    `${JSON.stringify(
      {
        generated_at: generatedAt,
        read_only: true,
        proposals: safeRepairProposals,
      },
      null,
      2,
    )}\n`,
    'utf8',
  ),
  writeFile(
    path.join(OUTPUT_DIR, 'batch-reconciliation.json'),
    `${JSON.stringify({ generated_at: generatedAt, rows }, null, 2)}\n`,
    'utf8',
  ),
  writeFile(
    path.join(OUTPUT_DIR, 'RECONCILIATION_SUMMARY.md'),
    summary,
    'utf8',
  ),
]);

console.log(
  JSON.stringify(
    {
      output_directory: OUTPUT_DIR,
      total_batches: rows.length,
      verified: verifiedRows.length,
      legacy_verified: legacyVerifiedRows.length,
      repair_required: repairRequiredRows.length,
      manual_review: manualReviewRows.length,
      read_only: true,
    },
    null,
    2,
  ),
);
