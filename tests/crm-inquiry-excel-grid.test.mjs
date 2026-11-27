import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INQUIRY_EDITABLE_COLUMNS,
  getNextCellCoord,
  parseClipboardGrid,
  buildPasteUpdates,
  groupInquiriesByCustomer,
} from '../src/components/crm/inquiries/inquiryGridUtils.ts';

test('CRM Inquiry Excel Grid — Navigation, Paste, Grouping & Autosave Architecture', async (t) => {
  const rowIds = Array.from({ length: 25 }, (_, i) => `inq-${i + 1}`);
  const editableFields = INQUIRY_EDITABLE_COLUMNS.map((c) => c.field);

  await t.test('1. Tab / Shift+Tab navigates 20+ consecutive cells across rows cleanly', () => {
    let coord = { rowId: rowIds[0], field: editableFields[0] };
    const visited = [coord];
    for (let i = 0; i < 20; i++) {
      const next = getNextCellCoord(rowIds, editableFields, coord, 'next');
      assert.ok(next, `Expected next cell at step ${i}`);
      coord = next;
      visited.push(coord);
    }
    assert.equal(visited.length, 21);
    assert.equal(visited[14].rowId, rowIds[1], '15th cell wraps to second row');
    assert.equal(visited[14].field, editableFields[0]);

    const prev = getNextCellCoord(rowIds, editableFields, visited[14], 'prev');
    assert.deepEqual(prev, visited[13], 'Shift+Tab wraps back to previous row last column');
  });

  await t.test('2. ArrowUp / ArrowDown / ArrowLeft / ArrowRight navigate 20+ rows cleanly', () => {
    let coord = { rowId: rowIds[0], field: 'product_name' };
    for (let i = 0; i < 20; i++) {
      const down = getNextCellCoord(rowIds, editableFields, coord, 'down');
      assert.ok(down);
      coord = down;
    }
    assert.equal(coord.rowId, rowIds[20]);
    assert.equal(coord.field, 'product_name');

    for (let i = 0; i < 20; i++) {
      const up = getNextCellCoord(rowIds, editableFields, coord, 'up');
      assert.ok(up);
      coord = up;
    }
    assert.equal(coord.rowId, rowIds[0]);

    const right = getNextCellCoord(rowIds, editableFields, coord, 'right');
    assert.equal(right?.field, 'specification');
    assert.ok(right);
    const left = getNextCellCoord(rowIds, editableFields, right, 'left');
    assert.equal(left?.field, 'product_name');
  });

  await t.test('3. Multi-row (10 rows x 3 cols) Excel TSV paste maps values, preserves untouched cells, and resolves existing customers', () => {
    const customers = [
      { id: 'cust-1', company_name: 'PT Kimia Farma Tbk' },
      { id: 'cust-2', company_name: 'PT Kalbe Farma Tbk' },
    ];
    const tsv = Array.from({ length: 10 }, (_, idx) =>
      `PT Kimia Farma Tbk\tParacetamol ${idx + 1}\tBP 2024`
    ).join('\n') + '\n';

    const matrix = parseClipboardGrid(tsv);
    assert.equal(matrix.length, 10);

    const { patches, errors } = buildPasteUpdates(
      rowIds,
      editableFields,
      { rowId: rowIds[0], field: 'company_name' },
      matrix,
      customers
    );

    assert.equal(errors.length, 0);
    assert.equal(patches.length, 10);
    assert.deepEqual(patches[0], {
      rowId: 'inq-1',
      patch: {
        crm_contact_id: 'cust-1',
        company_name: 'PT Kimia Farma Tbk',
        product_name: 'Paracetamol 1',
        specification: 'BP 2024',
      },
    });
    assert.equal(patches[9].rowId, 'inq-10');
    assert.equal(patches[9].patch.product_name, 'Paracetamol 10');
  });

  await t.test('4. Invalid pasted values produce explicit per-cell validation errors without silent skips', () => {
    const customers = [{ id: 'cust-1', company_name: 'PT Kimia Farma Tbk' }];
    const matrix = [
      ['Unknown Customer Co', '', '500 kg', 'bad-date', 'not-a-number'],
    ];
    const { patches, errors } = buildPasteUpdates(
      rowIds,
      ['company_name', 'product_name', 'quantity', 'delivery_date', 'purchase_price'],
      { rowId: rowIds[0], field: 'company_name' },
      matrix,
      customers
    );

    assert.equal(errors.length, 4, 'Expected 4 validation errors (unknown customer, empty product_name, bad date, invalid price)');
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].patch, { quantity: '500 kg' }, 'Only valid cells are patched');
  });

  await t.test('5. Customer grouping uses stable groupKeys and isolates unlinked inquiries', () => {
    const sample = [
      { id: 'i1', crm_contact_id: 'c1', company_name: 'PT Alpha' },
      { id: 'i2', crm_contact_id: 'c1', company_name: 'PT Alpha' },
      { id: 'i3', crm_contact_id: null, customer_id: null, company_name: '' },
      { id: 'i4', crm_contact_id: null, customer_id: null, company_name: '' },
      { id: 'i5', crm_contact_id: null, customer_id: null, company_name: 'Walk-in Co' },
    ];
    const groups = groupInquiriesByCustomer(sample);
    assert.equal(groups.length, 4);
    assert.equal(groups[0].groupKey, 'contact:c1');
    assert.equal(groups[0].items.length, 2);
    assert.equal(groups[1].groupKey, 'unlinked-id:i3');
    assert.equal(groups[2].groupKey, 'unlinked-id:i4');
    assert.equal(groups[3].groupKey, 'unlinked-name:walk-in co');
  });

  await t.test('6. InquiryTableExcel uses background autosave queue + optimistic cache update without full-table onRefresh on inline edits', () => {
    const src = readFileSync(
      new URL('../src/components/crm/InquiryTableExcel.tsx', import.meta.url),
      'utf8'
    );
    assert.ok(src.includes('updateCachedInquiry'), 'Must update cached inquiries optimistically');
    assert.ok(src.includes('saveQueueRef'), 'Must serialize per-record background saves');
    assert.ok(src.includes('SearchableSelect'), 'Must reuse existing SearchableSelect for customer editing');
    assert.ok(src.includes('onPaste={handleGridPaste}'), 'Must support multi-cell Excel paste');
    assert.ok(src.includes('Autosave active'), 'Must show subtle autosave status indicator');
  });
});
