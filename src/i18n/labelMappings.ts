/**
 * Central mapping between database enum / snake_case identifiers
 * and human-readable translated display labels (English & Bahasa Indonesia).
 */

export type SupportedLang = 'en' | 'id';

type LabelDict = Record<string, { en: string; id: string }>;

export const EXPENSE_CATEGORY_LABELS: LabelDict = {
  office: { en: 'Office & Admin', id: 'Kantor & Administrasi' },
  office_admin: { en: 'Office & Admin', id: 'Kantor & Administrasi' },
  warehouse: { en: 'Warehouse & Storage', id: 'Gudang & Penyimpanan' },
  warehouse_rent: { en: 'Warehouse Rent', id: 'Sewa Gudang' },
  transport: { en: 'Transport & Delivery', id: 'Transportasi & Pengiriman' },
  transport_delivery: { en: 'Transport & Delivery', id: 'Transportasi & Pengiriman' },
  utilities: { en: 'Utilities & Telecom', id: 'Utilitas & Telekomunikasi' },
  marketing: { en: 'Marketing & Sales', id: 'Pemasaran & Penjualan' },
  salary: { en: 'Payroll & Salary', id: 'Gaji & Tunjangan' },
  non_permanent_employee_fee: { en: 'Contract / Freelance Fee', id: 'Honor Tenaga Lepas' },
  import_broker: { en: 'Import Broker & Clearing', id: 'PPJK & Kepabeanan' },
  pib_import: { en: 'PIB Import & Customs', id: 'Impor PIB & Bea Masuk' },
  freight: { en: 'Freight & Shipping', id: 'Ongkos Angkut' },
  duty: { en: 'Customs Duty', id: 'Bea Masuk' },
  insurance: { en: 'Marine / Cargo Insurance', id: 'Asuransi Kargo' },
  clearing: { en: 'Port Clearing', id: 'Biaya Pelabuhan' },
  bpom: { en: 'BPOM & Regulatory', id: 'BPOM & Regulasi' },
  lab_testing: { en: 'Lab Testing & QC', id: 'Uji Lab & QC' },
  fixed_asset: { en: 'Fixed Asset Purchase', id: 'Pembelian Aset Tetap' },
  bank_charges: { en: 'Bank Charges', id: 'Biaya Bank' },
  tax: { en: 'Taxes & Levies', id: 'Pajak & Retribusi' },
  other: { en: 'Other Expense', id: 'Pengeluaran Lainnya' },
};

export const STATUS_LABELS: LabelDict = {
  // Payment & lifecycle
  paid: { en: 'Paid', id: 'Lunas' },
  unpaid: { en: 'Unpaid', id: 'Belum Dibayar' },
  partial: { en: 'Partial', id: 'Sebagian' },
  partially_paid: { en: 'Partially Paid', id: 'Dibayar Sebagian' },
  partially_received: { en: 'Partially Received', id: 'Diterima Sebagian' },
  received: { en: 'Received', id: 'Diterima' },
  overdue: { en: 'Overdue', id: 'Terlambat' },
  settled: { en: 'Settled', id: 'Lunas' },
  // Approval & posting
  draft: { en: 'Draft', id: 'Draf' },
  pending: { en: 'Pending', id: 'Menunggu' },
  pending_approval: { en: 'Pending Approval', id: 'Menunggu Persetujuan' },
  approved: { en: 'Approved', id: 'Disetujui' },
  rejected: { en: 'Rejected', id: 'Ditolak' },
  cancelled: { en: 'Cancelled', id: 'Dibatalkan' },
  posted: { en: 'Posted', id: 'Diposting' },
  active: { en: 'Active', id: 'Aktif' },
  reversed: { en: 'Reversed', id: 'Dibatalkan (Reversal)' },
  replaced: { en: 'Replaced', id: 'Digantikan' },
  // Reconciliation
  reconciled: { en: 'Reconciled', id: 'Terekonsiliasi' },
  matched: { en: 'Matched', id: 'Cocok' },
  partially_reconciled: { en: 'Partial', id: 'Sebagian' },
  unmatched: { en: 'Unmatched', id: 'Belum Cocok' },
  outstanding: { en: 'Outstanding', id: 'Belum Lunas' },
  suggested: { en: 'Review', id: 'Tinjau' },
  // Delivery & Stock
  delivered: { en: 'Delivered', id: 'Terkirim' },
  dispatched: { en: 'Dispatched', id: 'Dikirim' },
  processing: { en: 'Processing', id: 'Diproses' },
  completed: { en: 'Completed', id: 'Selesai' },
  shortage: { en: 'Shortage', id: 'Kurang Stok' },
  expired: { en: 'Expired', id: 'Kadaluarsa' },
  near_expiry: { en: 'Near Expiry', id: 'Mendekati Kadaluarsa' },
  low_stock: { en: 'Low Stock', id: 'Stok Rendah' },
  in_stock: { en: 'In Stock', id: 'Tersedia' },
  out_of_stock: { en: 'Out of Stock', id: 'Habis' },
  disposed: { en: 'Disposed', id: 'Dimusnahkan' },
  scrap: { en: 'Scrap', id: 'Musnahkan' },
  return_to_supplier: { en: 'Return to Supplier', id: 'Kembalikan ke Pemasok' },
  rework: { en: 'Rework', id: 'Proses Ulang' },
  // Tax / classification
  taxable: { en: 'Taxable (PKP)', id: 'Kena Pajak (PKP)' },
  non_taxable: { en: 'Non-Taxable', id: 'Tidak Kena Pajak' },
  pkp: { en: 'PKP', id: 'PKP' },
  non_pkp: { en: 'Non-PKP', id: 'Non-PKP' },
  local: { en: 'Local', id: 'Lokal' },
  import: { en: 'Import', id: 'Impor' },
  sales: { en: 'Sales', id: 'Penjualan' },
  staff: { en: 'Staff', id: 'Staf' },
  operations: { en: 'Operations', id: 'Operasional' },
  admin: { en: 'Admin', id: 'Admin' },
  operational: { en: 'Operational', id: 'Operasional' },
  // Product categories
  api: { en: 'API (Active Pharmaceutical Ingredient)', id: 'Bahan Baku Aktif (API)' },
  vitamin: { en: 'Vitamin & Nutrition', id: 'Vitamin & Nutrisi' },
  excipient: { en: 'Excipient', id: 'Eksipien' },
};

function formatHumanFallback(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getExpenseCategoryLabel(category: string | null | undefined, lang: SupportedLang = 'en'): string {
  if (!category) return lang === 'id' ? 'Lainnya' : 'Other';
  const normalized = category.trim().toLowerCase();
  const entry = EXPENSE_CATEGORY_LABELS[normalized];
  if (entry) return entry[lang];
  return formatHumanFallback(category);
}

export function getStatusLabel(status: string | null | undefined, lang: SupportedLang = 'en'): string {
  if (!status) return '—';
  const normalized = status.trim().toLowerCase();
  const entry = STATUS_LABELS[normalized];
  if (entry) return entry[lang];
  return formatHumanFallback(status);
}
