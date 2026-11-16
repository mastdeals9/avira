import test from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import * as XLSX from 'xlsx';

test('jsPDF 4.2.1 Core API compatibility verification', () => {
  // Test PDF instantiation across orientations and formats used in SAPJ
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  assert.ok(doc, 'jsPDF instance created successfully');
  assert.equal(typeof doc.text, 'function', 'doc.text must be a function');
  assert.equal(typeof doc.setFontSize, 'function', 'doc.setFontSize must be a function');
  assert.equal(typeof doc.addPage, 'function', 'doc.addPage must be a function');
  assert.equal(typeof doc.line, 'function', 'doc.line must be a function');
  assert.equal(typeof doc.rect, 'function', 'doc.rect must be a function');
  assert.equal(typeof doc.output, 'function', 'doc.output must be a function');

  // Exercise drawing and text operations typical of Invoice, PO, and Challan generation
  doc.setFontSize(16);
  doc.text('PT Shubham Anzen Pharma Jaya', 20, 20);
  doc.setFontSize(10);
  doc.text('Tax Invoice / Faktur Penjualan', 20, 30);
  doc.line(20, 35, 190, 35);
  doc.rect(20, 40, 170, 50);

  // Verify output generation produces valid PDF bytes
  const arrayBuffer = doc.output('arraybuffer');
  assert.ok(arrayBuffer.byteLength > 0, 'Generated PDF buffer must not be empty');

  // Verify PDF header magic bytes (%PDF)
  const header = new Uint8Array(arrayBuffer.slice(0, 5));
  const headerStr = String.fromCharCode(...header);
  assert.equal(headerStr, '%PDF-', 'PDF output must start with %PDF-');
});

test('XLSX core export compatibility verification', () => {
  const wb = XLSX.utils.book_new();
  const sampleData = [
    { Code: 'EXP/26/281', Employee: 'Nia', Gross: 8120000, PPh21: 120000, Net: 8000000 },
    { Code: 'EXP/26/282', Employee: 'Chintia', Gross: 3800000, PPh21: 0, Net: 3800000 }
  ];

  const ws = XLSX.utils.json_to_sheet(sampleData);
  assert.ok(ws, 'Worksheet created successfully');
  XLSX.utils.book_append_sheet(wb, ws, 'Payroll Summary');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  assert.ok(buf.length > 0, 'Excel output buffer must not be empty');
  // Verify PK zip header for XLSX
  assert.equal(buf[0], 0x50, 'XLSX buffer must start with PK zip signature 0x50');
  assert.equal(buf[1], 0x4b, 'XLSX buffer must start with PK zip signature 0x4B');
});

