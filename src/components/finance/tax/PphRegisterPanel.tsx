import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, FileSpreadsheet, AlertCircle } from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '../../../lib/supabase';
import { formatFinancePeriod } from '../../../utils/financePeriod';
import { useFinance } from '../../../contexts/FinanceContext';
import { StatCard, StatCardGrid, SectionCard, StatusChip, EmptyState, taxPaymentBusinessStatus } from './TaxUI';
import { getEffectiveExpensePostingStates, isEffectiveExpensePosting } from '../../../services/expensePostingLifecycle';
import { calculateRecognizedPPh } from '../../../utils/taxCalculations';
import { showToast } from '../../ToastNotification';

type PphType = 'PPh21' | 'PPh22' | 'PPh23' | 'PPh4(2)' | 'PPh_Unifikasi';

const TABS: PphType[] = ['PPh21','PPh22','PPh23','PPh4(2)','PPh_Unifikasi'];
const CONSOLIDATED_TYPES: PphType[] = ['PPh21','PPh22','PPh23','PPh4(2)'];

function pphTabLabel(t: PphType): string {
  if (t === 'PPh21') return 'PPh21';
  if (t === 'PPh_Unifikasi') return 'All Types (Consolidated)';
  return t;
}

interface Row {
  tax_period_id: string;
  fiscal_year: number;
  period_month: number;
  tax_type: string;
  pph_total: number;
  pph_paid_total: number;
  pph_outstanding: number;
  pph_overpaid: number;
  status: string;
  payment_due_date: string | null;
  filing_due_date: string | null;
  // Derived by the engine (vw_pph_by_period_type), shared with Calendar / Period Close.
  payment_status: string | null;
  payment_source: string | null;
}

interface SourceLine {
  module: 'expense' | 'import';
  id: string;
  doc_number: string;
  doc_date: string;
  period_date: string;
  party: string;
  party_type?: 'Staff' | 'Payee' | 'Supplier' | 'Other';
  raw_nik?: string | null;
  raw_npwp?: string | null;
  gross_amount?: number;
  description: string | null;
  pph_code: string | null;
  pph_amount: number;
  payment_method: string | null;
  recon_status: string | null;
  journal_reference: string | null;
  journal_id: string | null;
  posting_date: string | null;
  journal_status: string | null;
  tax_type: string;
  source_status: string;
  is_official: boolean;
  tax_period_id: string | null;
  party_tax_id?: string | null;
  tax_id_status?: 'NPWP' | 'NIK' | 'Missing';
  dpp_amount?: number | null;
  filing_ready?: boolean;
}

interface TaxPeriodOption {
  id: string;
  fiscal_year: number;
  period_month: number;
  tax_type: string;
  status: string;
  filing_status: string;
}

function fmt(n: number) {
  return Number(n).toLocaleString('id-ID');
}
function fmtDate(s: string) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function loadPphDetail(row: Row): Promise<SourceLine[]> {
  const yr = row.fiscal_year;
  const mo = row.period_month;
  const pphType = row.tax_type;

  // 1. Resolve target tax period IDs (for consolidated unifikasi vs single type)
  let targetPeriodIds: string[] = [row.tax_period_id];
  if (pphType === 'PPh_Unifikasi') {
    const { data: siblingPeriods } = await supabase
      .from('tax_periods')
      .select('id')
      .eq('fiscal_year', yr)
      .eq('period_month', mo)
      .neq('tax_type', 'PPN');
    if (siblingPeriods && siblingPeriods.length > 0) {
      targetPeriodIds = siblingPeriods.map(p => p.id);
    }
  }

  // 2. Query payment-level PPh allocations for the target period(s)
  const { data: allocData, error: allocErr } = await supabase
    .from('finance_expense_pph_allocations')
    .select('id, expense_id, tax_period_id, payment_source, payment_event_id, source_id, payment_date, payment_amount, recognized_pph_amount, is_reversed, notes')
    .in('tax_period_id', targetPeriodIds)
    .eq('is_reversed', false);

  if (allocErr) {
    console.error('Failed to load expense PPh allocations:', allocErr);
  }

  const allocations = (allocData ?? []) as any[];
  const allocatedExpenseIds = new Set(allocations.map(a => a.expense_id));

  // 3. Fetch expenses with PPh
  const [feRes, importRes] = await Promise.all([
    supabase
      .from('finance_expenses')
      .select('id, voucher_number, expense_date, due_date, amount, pph_amount, pph_dpp_amount, pph_treatment, ppn_amount, stamp_duty_amount, bank_charges_amount, paid_amount, originating_bank_statement_line_id, tax_period_id, pph_tax_period_id, pph_period:pph_tax_period_id(id, fiscal_year, period_month, tax_type), description, payment_method, expense_category, approval_status, pph_code:pph_code_id(code, tax_type), suppliers:supplier_id(company_name, npwp), staff:staff_id(full_name, nik, npwp), payees:payee_id(full_name, nik, npwp, business_role)')
      .gt('pph_amount', 0),
    supabase
      .from('finance_expenses')
      .select('id, voucher_number, expense_date, due_date, amount, pib_pph_amount, tax_period_id, pph_tax_period_id, pph_period:pph_tax_period_id(id, fiscal_year, period_month, tax_type), description, expense_category, approval_status, suppliers:supplier_id(company_name, npwp)')
      .in('expense_category', ['pib_import', 'pph_import']),
  ]);

  if (feRes.error) {
    console.error('Failed to load expense PPh detail:', feRes.error);
  }

  const rawFeData = (feRes.data ?? []) as any[];
  const expenseMap = new Map<string, any>(rawFeData.map(e => [e.id, e]));

  const allExpenseSources = [
    ...rawFeData,
    ...((importRes.data ?? []) as any[]),
  ];
  const expenseStates = await getEffectiveExpensePostingStates(allExpenseSources.map(expense => expense.id));
  const isEffectiveExpense = (expense: any) => {
    if (expense.approval_status === 'approved') return true;
    return isEffectiveExpensePosting(expenseStates.get(expense.id)?.effective_posting_state);
  };

  // Build lines from payment-level allocations
  const allocationLines: SourceLine[] = [];
  for (const alloc of allocations) {
    const r = expenseMap.get(alloc.expense_id);
    if (!r || !isEffectiveExpense(r)) continue;

    const codeType = r.pph_code?.tax_type ?? null;
    if (pphType !== 'PPh_Unifikasi' && codeType && codeType !== pphType) continue;

    const party = r.payees?.full_name ?? r.staff?.full_name ?? r.suppliers?.company_name ?? '—';
    const partyType: SourceLine['party_type'] = r.payees ? 'Payee' : r.staff ? 'Staff' : r.suppliers ? 'Supplier' : 'Other';
    const rawNpwp = r.payees?.npwp ?? r.staff?.npwp ?? r.suppliers?.npwp ?? null;
    const rawNik = r.payees?.nik ?? r.staff?.nik ?? null;
    const taxId = rawNpwp || rawNik || null;
    const taxIdStatus: 'NPWP' | 'NIK' | 'Missing' = rawNpwp ? 'NPWP' : rawNik ? 'NIK' : 'Missing';
    const filingReady = !!taxId;
    const gross = Number(alloc.payment_amount || 0);
    const recognizedPph = Number(alloc.recognized_pph_amount || 0);

    let dpp = gross;
    if (codeType === 'PPh21' || r.expense_category === 'non_permanent_employee_fee') {
      dpp = Math.round(gross * 0.5);
    }

    allocationLines.push({
      module: 'expense',
      id: `${r.id}_${alloc.id}`,
      doc_number: r.voucher_number ?? '—',
      doc_date: r.expense_date,
      period_date: alloc.payment_date,
      party,
      party_type: partyType,
      raw_nik: rawNik,
      raw_npwp: rawNpwp,
      gross_amount: gross,
      party_tax_id: taxId,
      tax_id_status: taxIdStatus,
      filing_ready: filingReady,
      dpp_amount: dpp,
      description: alloc.notes || r.description,
      pph_code: r.pph_code?.code ?? null,
      pph_amount: recognizedPph,
      payment_method: alloc.payment_source,
      recon_status: 'Allocated Payment',
      journal_reference: null,
      journal_id: null,
      posting_date: null,
      journal_status: 'Posted',
      tax_type: codeType || pphType,
      source_status: 'Disbursed (Allocated)',
      is_official: true,
      tax_period_id: alloc.tax_period_id,
    });
  }

  // 4. Fallback for legacy single-period expenses that do NOT have allocation rows
  const isSelectedPeriodLegacy = (expense: any): boolean => {
    if (allocatedExpenseIds.has(expense.id)) return false; // Prevent double-counting!
    if (expense.pph_tax_period_id) {
      if (pphType === 'PPh_Unifikasi') {
        if (expense.pph_period) {
          return expense.pph_period.fiscal_year === yr && expense.pph_period.period_month === mo;
        }
      } else {
        return expense.pph_tax_period_id === row.tax_period_id;
      }
    }
    return false;
  };

  const legacyExpenseData = rawFeData.filter(isEffectiveExpense).filter(isSelectedPeriodLegacy);
  const legacyImportData = ((importRes.data ?? []) as any[]).filter(isEffectiveExpense).filter(isSelectedPeriodLegacy);

  const sourceRows = [...legacyExpenseData, ...legacyImportData];
  const sourceIds = [...new Set(sourceRows.map(r => r.id).filter(Boolean))];
  const journalRes = sourceIds.length
    ? await supabase
      .from('journal_entries')
      .select('id, reference_id, entry_number, entry_date, is_posted, is_reversed, is_cancelled')
      .eq('is_posted', true)
      .eq('is_reversed', false)
      .eq('is_cancelled', false)
      .in('reference_id', sourceIds)
    : { data: [] as any[] };
  const journals = new Map<string, any>(((journalRes.data ?? []) as any[]).map(j => [j.reference_id, j]));
  const journalFields = (id: string) => {
    const journal = journals.get(id);
    return {
      journal_reference: journal?.entry_number ?? null,
      journal_id: journal?.id ?? null,
      posting_date: journal?.entry_date ?? null,
      journal_status: journal
        ? (journal.is_reversed ? 'Reversed' : journal.is_posted ? 'Posted' : 'Draft')
        : 'Not posted',
    };
  };

  const legacyExpenses: SourceLine[] = legacyExpenseData
    .filter(r => {
      if (r.expense_category === 'pib_import' || r.expense_category === 'pph_import') return false;
      const codeType = r.pph_code?.tax_type ?? null;
      return pphType === 'PPh_Unifikasi' || codeType === pphType;
    })
    .map(r => {
      const party = r.payees?.full_name ?? r.staff?.full_name ?? r.suppliers?.company_name ?? '—';
      const partyType: SourceLine['party_type'] = r.payees ? 'Payee' : r.staff ? 'Staff' : r.suppliers ? 'Supplier' : 'Other';
      const rawNpwp = r.payees?.npwp ?? r.staff?.npwp ?? r.suppliers?.npwp ?? null;
      const rawNik = r.payees?.nik ?? r.staff?.nik ?? null;
      const taxId = rawNpwp || rawNik || null;
      const taxIdStatus: 'NPWP' | 'NIK' | 'Missing' = rawNpwp ? 'NPWP' : rawNik ? 'NIK' : 'Missing';
      const filingReady = !!taxId;
      const gross = Number(r.amount || 0);
      const codeType = r.pph_code?.tax_type ?? pphType;
      let dpp = r.pph_dpp_amount ? Number(r.pph_dpp_amount) : gross;
      if (!r.pph_dpp_amount && (codeType === 'PPh21' || r.expense_category === 'non_permanent_employee_fee')) {
        dpp = Math.round(gross * 0.5);
      }

      const pphInfo = calculateRecognizedPPh(r);
      const isPaid = pphInfo.isPaid;
      const recognizedPph = pphInfo.recognizedPph;
      const isOfficial = r.approval_status === 'approved' && isPaid;

      let sourceStatus = r.approval_status === 'approved' ? 'Approved' : 'Pending Approval';
      if (!isPaid) {
        sourceStatus = 'Unpaid (Withholding Pending)';
      } else if (pphInfo.status === 'partial') {
        sourceStatus = `Partially Paid (${Math.round(pphInfo.paymentRatio * 100)}%)`;
      }

      return {
        module: 'expense' as const,
        id: r.id,
        doc_number: r.voucher_number ?? '—',
        doc_date: r.expense_date,
        period_date: r.expense_date,
        party,
        party_type: partyType,
        raw_nik: rawNik,
        raw_npwp: rawNpwp,
        gross_amount: gross,
        party_tax_id: taxId,
        tax_id_status: taxIdStatus,
        filing_ready: filingReady,
        dpp_amount: dpp,
        description: r.description,
        pph_code: r.pph_code?.code ?? null,
        pph_amount: recognizedPph,
        payment_method: r.payment_method,
        recon_status: null,
        ...journalFields(r.id),
        tax_type: codeType,
        source_status: sourceStatus,
        is_official: isOfficial,
        tax_period_id: r.pph_tax_period_id,
      };
    });

  // Import PPh 22 — only relevant to the PPh22 and consolidated tabs.
  const imports: SourceLine[] = (pphType === 'PPh22' || pphType === 'PPh_Unifikasi')
    ? legacyImportData
        .map(r => {
          const amt = r.expense_category === 'pib_import'
            ? Number(r.pib_pph_amount ?? 0)
            : Number(r.amount ?? 0);
          return { r, amt };
        })
        .filter(({ amt }) => amt > 0)
        .map(({ r, amt }) => {
          const party = r.suppliers?.company_name ?? '—';
          const taxId = r.suppliers?.npwp ?? null;
          const taxIdStatus: 'NPWP' | 'NIK' | 'Missing' = taxId ? 'NPWP' : 'Missing';
          const filingReady = !!taxId;
          const gross = Number(r.amount || 0);
          return {
            module: 'import' as const,
            id: r.id,
            doc_number: r.voucher_number ?? '—',
            doc_date: r.expense_date,
            period_date: r.expense_date,
            party,
            party_type: 'Supplier' as const,
            raw_nik: null,
            raw_npwp: taxId,
            gross_amount: gross,
            party_tax_id: taxId,
            tax_id_status: taxIdStatus,
            filing_ready: filingReady,
            dpp_amount: gross,
            description: r.description,
            pph_code: 'PPh22 Import (Prepaid)',
            pph_amount: amt,
            tax_type: 'PPh22',
            source_status: r.approval_status === 'approved' ? 'Paid at Customs' : 'Pending Approval',
            is_official: r.approval_status === 'approved',
            tax_period_id: r.pph_tax_period_id ?? null,
            payment_method: null,
            recon_status: null,
            ...journalFields(r.id),
          };
        })
    : [];

  return [...allocationLines, ...legacyExpenses, ...imports].sort((a, b) =>
    a.period_date.localeCompare(b.period_date) || a.doc_date.localeCompare(b.doc_date),
  );
}

function consolidateRows(rows: Row[]): Row[] {
  const grouped = new Map<string, Row>();
  for (const row of rows) {
    const key = `${row.fiscal_year}-${row.period_month}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...row, tax_period_id: key, tax_type: 'PPh_Unifikasi' });
      continue;
    }
    existing.pph_total += Number(row.pph_total || 0);
    existing.pph_paid_total += Number(row.pph_paid_total || 0);
    existing.pph_outstanding += Number(row.pph_outstanding || 0);
    existing.pph_overpaid += Number(row.pph_overpaid || 0);
    if (row.payment_status === 'overdue') existing.payment_status = 'overdue';
  }
  return [...grouped.values()].sort((a, b) => b.fiscal_year - a.fiscal_year || b.period_month - a.period_month);
}

function exportPphReturnExcel(row: Row, lines: SourceLine[]) {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Withholding Schedule
  const detailData = lines.map((l, idx) => ({
    'No': idx + 1,
    'No Bukti / Voucher': l.doc_number,
    'Tanggal Transaksi': l.doc_date,
    'Masa Pajak': formatFinancePeriod(row.fiscal_year, row.period_month),
    'Jenis PPh': l.tax_type,
    'Kode Objek Pajak': l.pph_code || '—',
    'Nama Penerima Penghasilan': l.party,
    'Kategori Penerima': l.party_type || '—',
    'Jenis Identitas': l.tax_id_status || 'Missing',
    'Nomor NIK (KTP/Akte)': l.raw_nik || '',
    'Nomor NPWP': l.raw_npwp || '',
    'Penghasilan Bruto (Rp)': Number(l.gross_amount || 0),
    'Dasar Pengenaan Pajak / DPP (Rp)': Number(l.dpp_amount || 0),
    'Jumlah PPh Dipotong (Rp)': Number(l.pph_amount || 0),
    'Jumlah Netto Dibayarkan (Rp)': Number((l.gross_amount || 0) - (l.pph_amount || 0)),
    'Metode Pembayaran': l.payment_method || '—',
    'No Jurnal Akuntansi': l.journal_reference || '—',
    'Status Dokumen': l.source_status,
    'Kesiapan Filing e-Bupot': l.filing_ready ? 'READY' : '⚠️ BUTUH NIK/NPWP',
    'Keterangan / Keperluan': l.description || '',
  }));

  const wsDetail = XLSX.utils.json_to_sheet(detailData);
  wsDetail['!cols'] = [
    { wch: 5 },  // No
    { wch: 16 }, // Voucher
    { wch: 14 }, // Date
    { wch: 12 }, // Period
    { wch: 10 }, // Tax Type
    { wch: 14 }, // Tax Code
    { wch: 28 }, // Party Name
    { wch: 16 }, // Party Category
    { wch: 14 }, // ID Type
    { wch: 20 }, // NIK
    { wch: 20 }, // NPWP
    { wch: 18 }, // Gross
    { wch: 18 }, // DPP
    { wch: 18 }, // PPh
    { wch: 18 }, // Net
    { wch: 16 }, // Payment Method
    { wch: 16 }, // Journal
    { wch: 12 }, // Status
    { wch: 22 }, // Filing Status
    { wch: 30 }, // Description
  ];
  XLSX.utils.book_append_sheet(wb, wsDetail, 'Bukti_Potong_Detail');

  // Sheet 2: Summary / Rekapitulasi Masa Pajak
  const summaryData = [
    { 'Keterangan': 'Masa Pajak', 'Nilai': formatFinancePeriod(row.fiscal_year, row.period_month) },
    { 'Keterangan': 'Jenis Pajak Penghasilan', 'Nilai': row.tax_type },
    { 'Keterangan': 'Status Masa Pajak', 'Nilai': row.status },
    { 'Keterangan': 'Jumlah Bukti Transaksi', 'Nilai': lines.length },
    { 'Keterangan': 'Total Penghasilan Bruto (Rp)', 'Nilai': lines.reduce((s, l) => s + Number(l.gross_amount || 0), 0) },
    { 'Keterangan': 'Total DPP (Rp)', 'Nilai': lines.reduce((s, l) => s + Number(l.dpp_amount || 0), 0) },
    { 'Keterangan': 'Total PPh Dipotong (Rp)', 'Nilai': Number(row.pph_total || 0) },
    { 'Keterangan': 'Total PPh Sudah Disetor (Rp)', 'Nilai': Number(row.pph_paid_total || 0) },
    { 'Keterangan': 'Sisa PPh Kurang Bayar (Rp)', 'Nilai': Number(row.pph_outstanding || 0) },
    { 'Keterangan': 'Kelebihan Bayar / Kompensasi (Rp)', 'Nilai': Number(row.pph_overpaid || 0) },
    { 'Keterangan': 'Batas Waktu Penyetoran (Payment Due)', 'Nilai': row.payment_due_date || '—' },
    { 'Keterangan': 'Batas Waktu Pelaporan (Filing Due)', 'Nilai': row.filing_due_date || '—' },
  ];
  const wsSummary = XLSX.utils.json_to_sheet(summaryData);
  wsSummary['!cols'] = [{ wch: 36 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Rekap_Masa_Pajak');

  const filename = `PPh_${row.tax_type}_${formatFinancePeriod(row.fiscal_year, row.period_month).replace(/\s+/g, '_')}_CA_Package.xlsx`;
  XLSX.writeFile(wb, filename);

  showToast({
    type: 'success',
    title: 'CA Package Exported',
    message: `${filename} downloaded with ${lines.length} withholding records.`,
  });
}

function exportEBupotCsv(row: Row, lines: SourceLine[]) {
  const missing = lines.filter(d => !d.filing_ready);
  if (missing.length > 0) {
    showToast({
      type: 'warning',
      title: 'e-Bupot Warning: Missing NIK/NPWP',
      message: `${missing.length} record(s) lack NIK/NPWP. Exported file marked for review before final submission.`,
    });
  }

  const rows = [
    ['Document No', 'Document Date', 'Tax Period', 'Party / Payee', 'Party Category', 'Tax ID Type', 'Tax ID (NIK/NPWP)', 'PPh Code', 'DPP Amount', 'PPh Withheld', 'Net Amount', 'Filing Status'],
    ...lines.map(d => [
      d.doc_number,
      d.doc_date,
      formatFinancePeriod(row.fiscal_year, row.period_month),
      `"${d.party.replace(/"/g, '""')}"`,
      d.party_type || '—',
      d.tax_id_status || 'Missing',
      `'${d.party_tax_id || ''}`,
      d.pph_code || '',
      d.dpp_amount || 0,
      d.pph_amount,
      (d.gross_amount || 0) - d.pph_amount,
      d.filing_ready ? 'READY' : 'MISSING_ID',
    ])
  ];
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ebupot_withholding_${row.tax_type}_${row.fiscal_year}_${String(row.period_month).padStart(2, '0')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

interface Props {
  onOpenExpense?: (id: string) => void;
  onOpenPayment?: (id: string) => void;
  onOpenJournal?: (id: string) => void;
}

export function PphRegisterPanel({ onOpenExpense, onOpenPayment, onOpenJournal }: Props) {
  const { dateRange } = useFinance();
  const [active, setActive] = useState<PphType>('PPh21');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SourceLine[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [periods, setPeriods] = useState<TaxPeriodOption[]>([]);
  const [editingPeriodId, setEditingPeriodId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [exportingPeriodId, setExportingPeriodId] = useState<string | null>(null);
  const [exportingAll, setExportingAll] = useState(false);
  const [importAdvanceData, setImportAdvanceData] = useState<{ expense_date: string; pph22_amount: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    setExpandedId(null);
    setDetail(null);
    (async () => {
      setLoading(true);
      let query = supabase
        .from('vw_pph_by_period_type')
        .select('*')
        .order('fiscal_year', { ascending: false })
        .order('period_month', { ascending: false })
        .limit(active === 'PPh_Unifikasi' ? 240 : 60);
      query = active === 'PPh_Unifikasi'
        ? query.in('tax_type', CONSOLIDATED_TYPES)
        : query.eq('tax_type', active);
      const { data } = await query;
      if (!cancelled) {
        const sourceRows = (data as Row[] | null) ?? [];
        setRows(active === 'PPh_Unifikasi' ? consolidateRows(sourceRows) : sourceRows);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [active, reloadKey]);

  useEffect(() => {
    if (active !== 'PPh22' && active !== 'PPh_Unifikasi') {
      setImportAdvanceData([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('vw_pph22_advance_tax_report')
        .select('expense_date, pph22_amount');
      if (!cancelled && data) {
        setImportAdvanceData((data as any[]).map(d => ({
          expense_date: d.expense_date,
          pph22_amount: Number(d.pph22_amount || 0),
        })));
      }
    })();
    return () => { cancelled = true; };
  }, [active, reloadKey]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.from('tax_periods')
        .select('id, fiscal_year, period_month, tax_type, status, filing_status')
        .neq('tax_type', 'PPN')
        .order('fiscal_year', { ascending: false })
        .order('period_month', { ascending: false });
      setPeriods((data as TaxPeriodOption[] | null) ?? []);
    })();
  }, []);

  const filtered = useMemo(() => {
    if (!dateRange?.startDate || !dateRange?.endDate) return rows;
    const start = new Date(dateRange.startDate);
    const end = new Date(dateRange.endDate);
    return rows.filter(r => {
      const first = new Date(r.fiscal_year, r.period_month - 1, 1);
      const last  = new Date(r.fiscal_year, r.period_month, 0);
      return last >= start && first <= end;
    });
  }, [rows, dateRange]);

  const totals = useMemo(() => filtered.reduce(
    (a, r) => ({
      total: a.total + Number(r.pph_total || 0),
      paid: a.paid + Number(r.pph_paid_total || 0),
      outstanding: a.outstanding + Number(r.pph_outstanding || 0),
      overpaid: a.overpaid + Number(r.pph_overpaid || 0),
    }),
    { total: 0, paid: 0, outstanding: 0, overpaid: 0 },
  ), [filtered]);

  const importAdvanceByPeriod = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of importAdvanceData) {
      if (!d.expense_date) continue;
      const parts = d.expense_date.split('-');
      const yr = Number(parts[0]);
      const mo = Number(parts[1]);
      if (!isNaN(yr) && !isNaN(mo)) {
        const key = `${yr}-${mo}`;
        map.set(key, (map.get(key) || 0) + d.pph22_amount);
      }
    }
    return map;
  }, [importAdvanceData]);

  const importAdvanceTaxTotal = useMemo(() => {
    if ((active !== 'PPh22' && active !== 'PPh_Unifikasi') || importAdvanceData.length === 0) return 0;
    const activePeriodKeys = new Set(filtered.map(r => `${r.fiscal_year}-${r.period_month}`));
    let sum = 0;
    for (const [key, amt] of importAdvanceByPeriod.entries()) {
      if (activePeriodKeys.has(key)) {
        sum += amt;
      }
    }
    return sum;
  }, [active, importAdvanceByPeriod, filtered]);

  async function saveDocumentPeriod(line: SourceLine, periodId: string) {
    const source = 'finance_expense_pph';
    setEditingPeriodId(line.id);
    try {
      const { error } = await supabase.rpc('reassign_tax_document_period', {
        p_source: source,
        p_document_id: line.id,
        p_tax_period_id: periodId,
      });
      if (error) throw error;
      setReloadKey(key => key + 1);
      setExpandedId(null);
      setDetail(null);
    } catch (error) {
      alert('Tax period update failed: ' + (error as Error).message);
    } finally {
      setEditingPeriodId(null);
    }
  }

  async function toggleExpand(row: Row) {
    if (expandedId === row.tax_period_id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(row.tax_period_id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const lines = await loadPphDetail(row);
      setDetail(lines);
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleExportRow(r: Row) {
    setExportingPeriodId(r.tax_period_id);
    try {
      let lines = detail;
      if (expandedId !== r.tax_period_id || !lines) {
        lines = await loadPphDetail(r);
      }
      const official = lines.filter(l => l.is_official);
      exportPphReturnExcel(r, official.length > 0 ? official : lines);
    } catch (err: any) {
      showToast({ type: 'error', title: 'Export Failed', message: err.message || 'Failed to export' });
    } finally {
      setExportingPeriodId(null);
    }
  }

  async function handleExportAll() {
    if (filtered.length === 0) return;
    setExportingAll(true);
    try {
      showToast({ type: 'info', title: 'Preparing Export', message: `Compiling data for ${filtered.length} period(s)...` });
      const allLinesByPeriod: { row: Row; lines: SourceLine[] }[] = [];
      for (const r of filtered) {
        const lines = await loadPphDetail(r);
        allLinesByPeriod.push({ row: r, lines: lines.filter(l => l.is_official) });
      }

      const wb = XLSX.utils.book_new();

      // Master Register Sheet
      const masterRows: any[] = [];
      allLinesByPeriod.forEach(({ row, lines }) => {
        lines.forEach((l, idx) => {
          masterRows.push({
            'No': masterRows.length + 1,
            'Masa Pajak': formatFinancePeriod(row.fiscal_year, row.period_month),
            'No Bukti / Voucher': l.doc_number,
            'Tanggal Transaksi': l.doc_date,
            'Jenis PPh': l.tax_type,
            'Kode Objek Pajak': l.pph_code || '—',
            'Nama Penerima Penghasilan': l.party,
            'Kategori Penerima': l.party_type || '—',
            'Jenis Identitas': l.tax_id_status || 'Missing',
            'Nomor NIK (KTP/Akte)': l.raw_nik || '',
            'Nomor NPWP': l.raw_npwp || '',
            'Penghasilan Bruto (Rp)': Number(l.gross_amount || 0),
            'Dasar Pengenaan Pajak / DPP (Rp)': Number(l.dpp_amount || 0),
            'Jumlah PPh Dipotong (Rp)': Number(l.pph_amount || 0),
            'Jumlah Netto Dibayarkan (Rp)': Number((l.gross_amount || 0) - (l.pph_amount || 0)),
            'Metode Pembayaran': l.payment_method || '—',
            'No Jurnal Akuntansi': l.journal_reference || '—',
            'Status Dokumen': l.source_status,
            'Kesiapan Filing e-Bupot': l.filing_ready ? 'READY' : '⚠️ BUTUH NIK/NPWP',
            'Keterangan': l.description || '',
          });
        });
      });

      const wsMaster = XLSX.utils.json_to_sheet(masterRows);
      wsMaster['!cols'] = [
        { wch: 5 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 14 },
        { wch: 28 }, { wch: 16 }, { wch: 14 }, { wch: 20 }, { wch: 20 },
        { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 16 },
        { wch: 12 }, { wch: 22 }, { wch: 30 }
      ];
      XLSX.utils.book_append_sheet(wb, wsMaster, 'All_Withholdings');

      // Periods Summary Sheet
      const summaryRows = filtered.map(r => ({
        'Period': formatFinancePeriod(r.fiscal_year, r.period_month),
        'Jenis Pajak': r.tax_type,
        'Status Masa': r.status,
        'Total PPh Dipotong (Rp)': Number(r.pph_total || 0),
        'Total Disetor (Rp)': Number(r.pph_paid_total || 0),
        'Sisa Kurang Bayar (Rp)': Number(r.pph_outstanding || 0),
        'Lebih Bayar (Rp)': Number(r.pph_overpaid || 0),
        'Batas Setor': r.payment_due_date || '—',
        'Batas Lapor': r.filing_due_date || '—',
      }));
      const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
      wsSummary['!cols'] = [
        { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 22 }, { wch: 20 },
        { wch: 22 }, { wch: 16 }, { wch: 14 }, { wch: 14 }
      ];
      XLSX.utils.book_append_sheet(wb, wsSummary, 'Rekap_Semua_Masa');

      const filename = `Consolidated_PPh_${pphTabLabel(active).replace(/\s+/g, '_')}_CA_Package.xlsx`;
      XLSX.writeFile(wb, filename);

      showToast({
        type: 'success',
        title: 'Master CA Package Exported',
        message: `${filename} downloaded with ${masterRows.length} transactions across ${filtered.length} periods.`,
      });
    } catch (err: any) {
      showToast({ type: 'error', title: 'Export Failed', message: err.message || 'Failed to export' });
    } finally {
      setExportingAll(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-1.5 flex-wrap">
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setActive(t)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition ${active === t ? 'bg-blue-600 text-white border-blue-600' : 'bg-white hover:bg-gray-50 border-gray-200'}`}
            >
              {pphTabLabel(t)}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={exportingAll || filtered.length === 0}
          onClick={handleExportAll}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 rounded-lg shadow-xs transition disabled:opacity-50"
          title="Export all periods in current view to a consolidated CA Excel workbook"
        >
          <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
          <span>{exportingAll ? 'Preparing Export...' : `Export All ${pphTabLabel(active)} (.xlsx)`}</span>
        </button>
      </div>

      {!loading && filtered.length > 0 && (
        <div className="space-y-3">
          {active === 'PPh22' && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/80 p-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-600"></span>
                    <span className="text-xs font-bold text-emerald-900 uppercase tracking-wide">
                      Prepaid Import PPh 22 (Pajak Dibayar di Muka / Kredit Pajak)
                    </span>
                    <span className="text-[10px] font-semibold text-emerald-800 bg-emerald-200/70 px-1.5 py-0.5 rounded">
                      COA 1155
                    </span>
                  </div>
                  <p className="text-[11px] text-emerald-700">
                    Paid directly to Customs / State Treasury via PIB bank clearance. Creditable against Annual Corporate Income Tax (SPT Tahunan PPh Badan Form 1771 Lampiran III). Not a monthly withholding liability and not payable to DJP.
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-emerald-700 font-medium">Prepaid Import Tax (In Range)</div>
                  <div className="text-base font-bold text-emerald-900 font-mono">
                    Rp {fmt(importAdvanceTaxTotal)}
                  </div>
                </div>
              </div>
            </div>
          )}

          <StatCardGrid cols={4}>
            {active === 'PPh22' ? (
              <>
                <StatCard
                  label="Prepaid Import PPh 22"
                  value={importAdvanceTaxTotal}
                  tone="green"
                  hint="Debited to COA 1155 (Asset in range)"
                />
                <StatCard
                  label="Annual Tax Credit (SPT Badan)"
                  value={importAdvanceTaxTotal}
                  tone="blue"
                  hint="Form 1771 Lampiran III credit"
                />
                <StatCard
                  label="Withheld PPh 22 (Payable)"
                  value={totals.total}
                  tone="orange"
                  hint="Zero domestic withholding liability"
                />
                <StatCard
                  label="Payable to DJP"
                  value={totals.outstanding}
                  tone="green"
                  hint="Already paid at customs clearance"
                />
              </>
            ) : (
              <>
                <StatCard
                  label={`Total ${pphTabLabel(active)} Withheld`}
                  value={totals.total}
                  tone="orange"
                  hint="Across periods in range"
                />
                <StatCard label="Paid to Tax Office" value={totals.paid} tone="green" hint="Remitted via Tax Payment NTPN" />
                <StatCard
                  label="Outstanding"
                  value={totals.outstanding}
                  tone="red"
                  hint="Not yet remitted"
                />
                <StatCard label="Overpaid / Credit" value={totals.overpaid} tone="blue" hint="Not allocated to another period" />
              </>
            )}
          </StatCardGrid>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <SectionCard>
          <EmptyState
            title={`No ${active} periods in the selected date range`}
            hint="PPh periods are created automatically once expenses, vouchers, or imports with PPh are approved. Try widening the date range."
          />
        </SectionCard>
      ) : (
        <SectionCard>
          <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="w-6 px-2 py-1.5"></th>
                <th className="text-left px-2.5 py-1.5">Period</th>
                <th className="text-left px-2.5 py-1.5">Status</th>
                {active === 'PPh22' && (
                  <th className="text-right px-2.5 py-1.5 bg-emerald-50 text-emerald-900 font-semibold border-x border-emerald-200">
                    Prepaid Import PPh 22 (COA 1155)
                  </th>
                )}
                <th className="text-right px-2.5 py-1.5">{active === 'PPh22' ? 'Withheld PPh 22 (Liability)' : 'Total PPh'}</th>
                <th className="text-right px-2.5 py-1.5">Paid</th>
                <th className="text-right px-2.5 py-1.5">Outstanding</th>
                <th className="text-right px-2.5 py-1.5">Overpaid / Credit</th>
                <th className="text-left px-2.5 py-1.5">Payment Due</th>
                <th className="text-left px-2.5 py-1.5">Filing Due</th>
                <th className="text-center px-2.5 py-1.5 w-24">CA Export</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const isOpen = expandedId === r.tax_period_id;
                const businessStatus = taxPaymentBusinessStatus({
                  paymentStatus: r.payment_status,
                  totalAmount: r.pph_total,
                  paidAmount: r.pph_paid_total,
                  outstandingAmount: r.pph_outstanding,
                });
                const officialDetail = isOpen && detail ? detail.filter(line => line.is_official) : [];
                const pendingDetail = isOpen && detail ? detail.filter(line => !line.is_official) : [];
                const missingJournalDetail = officialDetail.filter(line => !line.journal_id);
                const withheldDetail = officialDetail.filter(line => line.module === 'expense');
                const importDetail = officialDetail.filter(line => line.module === 'import');
                const withheldTotal = withheldDetail.reduce((sum, line) => sum + line.pph_amount, 0);
                const importTotal = importDetail.reduce((sum, line) => sum + line.pph_amount, 0);
                const traceDifference = withheldTotal - Number(r.pph_total || 0);
                return (
                  <Fragment key={r.tax_period_id}>
                    <tr
                      key={r.tax_period_id}
                      className={`border-t cursor-pointer select-none ${isOpen ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                      onClick={() => void toggleExpand(r)}
                    >
                      <td className="px-2 py-1.5 text-gray-400">
                        {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </td>
                      <td className="px-2.5 py-1.5 font-medium">{formatFinancePeriod(r.fiscal_year, r.period_month)}</td>
                      <td className="px-2.5 py-1.5">
                        <StatusChip status={businessStatus} />
                      </td>
                      {active === 'PPh22' && (
                        <td className="px-2.5 py-1.5 text-right font-mono font-bold text-emerald-800 bg-emerald-50/40 border-x border-emerald-100">
                          Rp {fmt(importAdvanceByPeriod.get(`${r.fiscal_year}-${r.period_month}`) || 0)}
                        </td>
                      )}
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{fmt(r.pph_total)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-green-700">{fmt(r.pph_paid_total)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums font-semibold text-orange-700">
                        {fmt(r.pph_outstanding)}
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums font-semibold text-blue-700">{fmt(r.pph_overpaid)}</td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap">{r.payment_due_date ?? '—'}</td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap">{r.filing_due_date ?? '—'}</td>
                      <td className="px-2.5 py-1.5 text-center" onClick={e => e.stopPropagation()}>
                        <button
                          type="button"
                          disabled={exportingPeriodId === r.tax_period_id}
                          onClick={() => void handleExportRow(r)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded transition disabled:opacity-50"
                          title="Export CA Tax Package (.xlsx) for this period"
                        >
                          <FileSpreadsheet className="w-3 h-3 text-emerald-600" />
                          <span>{exportingPeriodId === r.tax_period_id ? '...' : 'Excel'}</span>
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${r.tax_period_id}-detail`} className="bg-blue-50/30">
                        <td colSpan={active === 'PPh22' ? 13 : 12} className="px-6 pb-4 pt-2">
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                              Source Documents — {active === 'PPh22' ? `PPh 22 Documents in ${formatFinancePeriod(r.fiscal_year, r.period_month)}` : `${pphTabLabel(active)} withheld in ${formatFinancePeriod(r.fiscal_year, r.period_month)}`}
                            </h4>
                            {officialDetail.length > 0 && (
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => exportPphReturnExcel(r, officialDetail)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 rounded shadow-xs transition"
                                  title="Export complete CA Tax Package Excel Workbook"
                                >
                                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" /> Export CA Package (.xlsx)
                                </button>
                                <button
                                  type="button"
                                  onClick={() => exportEBupotCsv(r, officialDetail)}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-700 bg-white hover:bg-blue-50 border border-blue-300 rounded transition"
                                  title="Export DJP-compliant e-Bupot CSV"
                                >
                                  <Download className="w-3.5 h-3.5" /> Export e-Bupot CSV
                                </button>
                              </div>
                            )}
                          </div>
                          {detailLoading ? (
                            <p className="text-xs text-gray-500">Loading source documents…</p>
                          ) : officialDetail.length === 0 && Number(r.pph_total || 0) > 0 ? (
                            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                              <p className="font-medium">No source expense was found for this registered withholding amount.</p>
                              <p className="mt-0.5">PPh {pphTabLabel(active)} · {formatFinancePeriod(r.fiscal_year, r.period_month)} · Rp {fmt(r.pph_total)}</p>
                              <p className="mt-0.5 text-[11px]">No synthetic source or tax-payment document is shown. Review the underlying expense/source-document records before reposting.</p>
                            </div>
                          ) : officialDetail.length > 0 ? (
                            <>
                            {missingJournalDetail.length > 0 && (
                              <div className="mb-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                                Accounting warning: {missingJournalDetail.length} approved source document{missingJournalDetail.length === 1 ? '' : 's'} {missingJournalDetail.length === 1 ? 'has' : 'have'} no active posted journal. The withholding remains in the official Register; open the document to correct its journal lifecycle.
                              </div>
                            )}
                            {Math.abs(traceDifference) > 0.01 && (
                              <div className="mb-2 rounded border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
                                <div className="font-semibold flex items-center justify-between">
                                  <span>Reconciliation Note: Filed Return vs. Current Linked Source Documents</span>
                                  <span className="text-[10px] px-2 py-0.5 rounded bg-amber-200 text-amber-900 font-mono font-bold">
                                    Variance: Rp {fmt(Math.abs(traceDifference))}
                                  </span>
                                </div>
                                <p className="mt-1 text-[11px] text-amber-800 leading-relaxed">
                                  The filed government return total (<strong>Rp {fmt(r.pph_total)}</strong>) is an immutable snapshot protected from modification.
                                  Current linked source documents total <strong>Rp {fmt(withheldTotal)}</strong>.
                                  {r.fiscal_year === 2026 && r.period_month === 8 ? (
                                    <span> This Rp 100,000 difference is a filed-return versus linked-source-document variance requiring reconciliation (filed return total: Rp 1,129,500; linked source documents: Rp 1,029,500).</span>
                                  ) : (
                                    <span> Any difference between filed returns and current documents is preserved as a filed-return versus linked-source-document variance requiring reconciliation.</span>
                                  )}
                                </p>
                              </div>
                            )}
                            <table className="w-full text-xs border-collapse">
                              <thead>
                                <tr className="text-gray-500 border-b">
                                  <th className="text-left py-1 pr-3">Module</th>
                                  <th className="text-left py-1 pr-3">Tax Type</th>
                                  <th className="text-left py-1 pr-3">Document</th>
                                  <th className="text-left py-1 pr-3">Document Date</th>
                                  <th className="text-left py-1 pr-3">PPh Period Date</th>
                                  <th className="text-left py-1 pr-3">Tax Period</th>
                                  <th className="text-left py-1 pr-3">Party / Payee</th>
                                  <th className="text-left py-1 pr-3">Category</th>
                                  <th className="text-left py-1 pr-3">Tax ID / Status</th>
                                  <th className="text-left py-1 pr-3">Readiness</th>
                                  <th className="text-left py-1 pr-3">PPh Code</th>
                                  <th className="text-left py-1 pr-3">Posting Date</th>
                                  <th className="text-left py-1 pr-3">Journal Ref</th>
                                  <th className="text-left py-1 pr-3">Status</th>
                                  <th className="text-right py-1">{active === 'PPh22' ? 'Tax Amount' : 'PPh Withheld'}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {officialDetail.map(l => (
                                  <tr key={l.id} className="border-b border-gray-100 hover:bg-white">
                                    <td className="py-1.5 pr-3">
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                        l.module === 'expense' ? 'bg-orange-100 text-orange-700'
                                          : 'bg-emerald-100 text-emerald-800'
                                      }`}>
                                        {l.module === 'expense' ? 'Expense Withholding'
                                          : 'Import PPh22 (Prepaid)'}
                                      </span>
                                    </td>
                                    <td className="py-1.5 pr-3 font-semibold">{l.tax_type}</td>
                                    <td className="py-1.5 pr-3 font-mono font-semibold">
                                      <button type="button" className="text-blue-700 hover:underline" onClick={() => onOpenExpense?.(l.id)}>{l.doc_number}</button>
                                    </td>
                                    <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDate(l.doc_date)}</td>
                                    <td className="py-1.5 pr-3 whitespace-nowrap font-medium text-blue-700">{fmtDate(l.period_date)}</td>
                                    <td className="py-1.5 pr-3" onClick={event => event.stopPropagation()}>
                                      {l.module === 'import' ? (
                                        <span className="text-gray-400">Derived import period</span>
                                      ) : (
                                        <select name="tax_period_id"
                                          aria-label={`Tax period for ${l.doc_number}`}
                                          value={l.tax_period_id ?? r.tax_period_id}
                                          disabled={editingPeriodId === l.id || r.status === 'closed' || r.status === 'filed'}
                                          onChange={event => void saveDocumentPeriod(l, event.target.value)}
                                          className="max-w-28 rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] disabled:opacity-50"
                                        >
                                          {periods.filter(period => period.tax_type === l.tax_type).map(period => (
                                            <option key={period.id} value={period.id} disabled={period.status === 'closed' || period.status === 'filed' || period.filing_status === 'filed'}>
                                              {formatFinancePeriod(period.fiscal_year, period.period_month)}{period.status === 'closed' || period.status === 'filed' || period.filing_status === 'filed' ? ' (locked)' : ''}
                                            </option>
                                          ))}
                                        </select>
                                      )}
                                    </td>
                                    <td className="py-1.5 pr-3 max-w-[140px] truncate text-gray-800 font-medium" title={l.party}>{l.party}</td>
                                    <td className="py-1.5 pr-3 whitespace-nowrap text-gray-500">{l.party_type || '—'}</td>
                                    <td className="py-1.5 pr-3 whitespace-nowrap">
                                      {l.party_tax_id ? (
                                        <div className="font-mono text-[11px] text-gray-700">
                                          <span className="text-[9px] text-gray-400 mr-1">{l.tax_id_status}:</span>
                                          {l.party_tax_id}
                                        </div>
                                      ) : (
                                        <span className="text-[10px] text-amber-700 bg-amber-50 px-1 py-0.5 rounded font-medium">No NIK/NPWP</span>
                                      )}
                                    </td>
                                    <td className="py-1.5 pr-3 whitespace-nowrap">
                                      {l.filing_ready ? (
                                        <span className="text-[10px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded font-medium">Ready</span>
                                      ) : (
                                        <span className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded font-medium">Need ID</span>
                                      )}
                                    </td>
                                    <td className="py-1.5 pr-3">
                                      {l.pph_code
                                        ? <span className="font-mono text-blue-700">{l.pph_code}</span>
                                        : <span className="text-orange-500 italic">⚠ No code</span>}
                                    </td>
                                    <td className="py-1.5 pr-3 whitespace-nowrap">{l.posting_date ? fmtDate(l.posting_date) : '—'}</td>
                                    <td className="py-1.5 pr-3 font-mono">
                                      {l.journal_id
                                        ? <button type="button" className="text-blue-700 hover:underline" onClick={() => onOpenJournal?.(l.journal_id!)}>{l.journal_reference}</button>
                                        : '—'}
                                    </td>
                                    <td className="py-1.5 pr-3" title={`Journal: ${l.journal_status ?? '—'}`}>
                                      {l.module === 'import' ? (
                                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                                          Paid at Customs
                                        </span>
                                      ) : (
                                        <StatusChip status={businessStatus} />
                                      )}
                                      <div className="mt-0.5 text-[10px] text-gray-500">{l.source_status}</div>
                                    </td>
                                    <td className={`py-1.5 text-right font-mono font-semibold ${l.module === 'import' ? 'text-emerald-800' : 'text-orange-700'}`}>
                                      Rp {fmt(l.pph_amount)}
                                    </td>
                                  </tr>
                                ))}
                                {importDetail.length > 0 && (
                                  <tr className="font-semibold border-t border-gray-200 bg-emerald-50/50">
                                    <td colSpan={14} className="py-1.5 pr-3 text-right text-xs text-emerald-800">
                                      Total Import PPh 22 Paid at Customs (Creditable Advance Tax)
                                    </td>
                                    <td className="py-1.5 text-right font-mono text-emerald-800">
                                      Rp {fmt(importTotal)}
                                    </td>
                                  </tr>
                                )}
                                <tr className="font-semibold border-t-2 border-gray-300 bg-gray-50">
                                  <td colSpan={14} className="py-1.5 pr-3 text-right text-xs text-gray-500">
                                    Total {pphTabLabel(active)} Withheld (Payable to Tax Office)
                                  </td>
                                  <td className="py-1.5 text-right font-mono text-orange-700">
                                    Rp {fmt(withheldTotal)}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                            </>
                          ) : (
                            <div className="py-2.5 text-center text-xs text-gray-500 italic">
                              No {active === 'PPh22' ? 'PPh 22 documents' : `${pphTabLabel(active)} source documents`} recorded for {formatFinancePeriod(r.fiscal_year, r.period_month)}.
                            </div>
                          )}

                          {!detailLoading && pendingDetail.length > 0 && (
                            <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3">
                              <h5 className="text-xs font-semibold text-amber-900">Pending Approval / Unpaid Withholding</h5>
                              <p className="mb-2 text-[11px] text-amber-800">
                                These transactions are pending approval or unpaid, and are excluded from the official Register until the payment/withholding event occurs.
                              </p>
                              <table className="w-full text-xs border-collapse bg-white">
                                <thead>
                                  <tr className="border-b text-gray-500">
                                    <th className="p-1.5 text-left">Document No.</th>
                                    <th className="p-1.5 text-left">Module</th>
                                    <th className="p-1.5 text-left">Employee / Supplier</th>
                                    <th className="p-1.5 text-left">Tax Type</th>
                                    <th className="p-1.5 text-right">Tax Amount</th>
                                    <th className="p-1.5 text-left">Status</th>
                                    <th className="p-1.5 text-left">Expected Posting Date</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {pendingDetail.map(line => (
                                    <tr key={`pending-${line.module}-${line.id}`} className="border-b border-gray-100">
                                      <td className="p-1.5 font-mono font-semibold">
                                        <button type="button" className="text-blue-700 hover:underline" onClick={() => {
                                          onOpenExpense?.(line.id);
                                        }}>{line.doc_number}</button>
                                      </td>
                                      <td className="p-1.5">{line.module === 'import' ? 'Import PPh22' : 'Expense'}</td>
                                      <td className="p-1.5">{line.party}</td>
                                      <td className="p-1.5 font-medium">{line.tax_type}</td>
                                      <td className="p-1.5 text-right font-mono">Rp {fmt(line.pph_amount)}</td>
                                      <td className="p-1.5">{line.source_status}</td>
                                      <td className="p-1.5 whitespace-nowrap">{fmtDate(line.doc_date)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
