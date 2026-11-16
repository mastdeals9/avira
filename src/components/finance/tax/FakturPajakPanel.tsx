import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, ExternalLink, Download, FileWarning, Receipt, Upload } from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '../../../lib/supabase';
import { useFinance } from '../../../contexts/FinanceContext';
import { sanitizeExportRows } from '../../../utils/csvSafe';
import { StatCard, StatCardGrid, SectionCard, EmptyState } from './TaxUI';
import { FinanceModal } from '../FinanceModal';
import { FinanceActionButton, FinanceBadge, FinanceButton, FinanceSelect, type FinanceStatus } from '../FinanceUI';
import { FinanceTable } from '../FinanceTable';
import { F_LABEL } from '../FinanceForm';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../FloatingField';
import { SapRow } from '../SapLayout';
import { openStoredAttachment, TaxAttachments } from './TaxAttachments';
import { showToast } from '../../ToastNotification';
import { uploadOptimizedFile } from '../../../services/storage/uploadOptimizationService';

interface Customer {
  company_name: string | null;
  npwp: string | null;
}
interface SalesInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  tax_amount: number | null;
  total_amount: number;
  faktur_pajak_number: string | null;
  customer_id: string | null;
  customer: Customer | null;
}
interface FakturRow {
  id: string;
  sales_invoice_id: string;
  faktur_number: string;
  issue_date: string;
  dpp_amount: number;
  ppn_amount: number;
  status: string;
  reported_at: string | null;
  notes: string | null;
  customer_id: string | null;
  invoice_amount: number | null;
  official_djp_number: string | null;
  linked_invoice_id: string | null;
  uploaded_by: string | null;
  uploaded_at: string | null;
}

type WorkflowStatus = 'waiting' | 'recorded';

function workflowStatus(invoice: SalesInvoice, faktur?: FakturRow): WorkflowStatus {
  if (faktur && faktur.status !== 'generated' && faktur.status !== 'cancelled') return 'recorded';
  return 'waiting';
}

function workflowLabel(status: WorkflowStatus): string {
  return status === 'waiting' ? 'Waiting for Faktur' : 'Recorded';
}

function customerDisplay(c: Customer | undefined): string {
  if (!c) return '—';
  return c.company_name || '—';
}

const FAKTUR_PDF_KINDS = [{ value: 'pdf', label: 'Official PDF' }] as const;

const firstRelation = <T,>(value: T | T[] | null | undefined): T | null =>
  Array.isArray(value) ? value[0] ?? null : value ?? null;

function RecordFakturModal({
  invoice, existing, busy, onClose, onSave,
}: {
  invoice: SalesInvoice;
  existing?: FakturRow;
  busy: boolean;
  onClose: () => void;
  onSave: (data: { invoice: SalesInvoice; number: string; date: string; notes: string; pdf: File | null }) => Promise<void>;
}) {
  const [number, setNumber] = useState(existing?.faktur_number ?? invoice.faktur_pajak_number ?? '');
  const [date, setDate] = useState(existing?.issue_date ?? invoice.invoice_date);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [pdf, setPdf] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [showMismatchWarning, setShowMismatchWarning] = useState(false);

  const invoiceDpp = Math.max(Number(invoice.total_amount ?? 0) - Number(invoice.tax_amount ?? 0), 0);
  const invoicePpn = Number(invoice.tax_amount ?? 0);
  const hasMismatch = Boolean(existing && (
    (existing.customer_id ?? invoice.customer_id) !== invoice.customer_id
    || Math.abs(Number(existing.invoice_amount ?? Number(existing.dpp_amount) + Number(existing.ppn_amount)) - Number(invoice.total_amount)) > 0.01
    || Math.abs(Number(existing.dpp_amount) - invoiceDpp) > 0.01
    || Math.abs(Number(existing.ppn_amount) - invoicePpn) > 0.01
  ));

  function saveAfterValidation() {
    setShowMismatchWarning(false);
    void onSave({ invoice, number, date, notes, pdf });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!number.trim()) {
      setError('Official DJP Faktur Number is required.');
      return;
    }
    if (!date) {
      setError('Faktur Date is required.');
      return;
    }
    if (!existing && !pdf) {
      setError('Upload the official PDF Faktur Pajak received from the CA.');
      return;
    }
    if (hasMismatch) {
      setShowMismatchWarning(true);
      return;
    }
    saveAfterValidation();
  }

  return (
    <FinanceModal
      isOpen
      onClose={onClose}
      title={existing ? 'Edit Recorded Faktur' : 'Record Faktur'}
      subtitle="Record the official DJP document received from the CA"
      size="lg"
      footer={(
        <>
          <FinanceButton type="button" onClick={onClose} disabled={busy}>Cancel</FinanceButton>
          <FinanceButton type="submit" form="record-faktur-form" variant="primary" disabled={busy}>
            <Upload className="h-4 w-4" /> {busy ? 'Saving…' : 'Save'}
          </FinanceButton>
        </>
      )}
    >
      <form id="record-faktur-form" onSubmit={handleSubmit} className="space-y-5">
        <div className="rounded-md border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          This ERP records the official Faktur Pajak issued by the external CA. It never issues the legal DJP number.
        </div>

        <section className="space-y-4">
          <h4 className="border-b border-gray-200 pb-2 text-sm font-semibold text-gray-700">Sales Invoice</h4>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div><span className={F_LABEL}>Sales Invoice</span><div className="h-10 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800">{invoice.invoice_number}</div></div>
            <div><span className={F_LABEL}>Customer</span><div className="h-10 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800">{customerDisplay(invoice.customer ?? undefined)}</div></div>
            <div><span className={F_LABEL}>ERP Reference</span><div className="h-10 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-mono text-gray-800">{invoice.invoice_number}</div></div>
            <div><span className={F_LABEL}>Invoice Amount</span><div className="h-10 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-right text-sm font-mono text-gray-800">Rp {Number(invoice.total_amount ?? 0).toLocaleString('id-ID')}</div></div>
            <div><span className={F_LABEL}>DPP</span><div className="h-10 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-right text-sm font-mono text-gray-800">Rp {invoiceDpp.toLocaleString('id-ID')}</div></div>
            <div><span className={F_LABEL}>PPN</span><div className="h-10 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-right text-sm font-mono text-gray-800">Rp {invoicePpn.toLocaleString('id-ID')}</div></div>
          </div>
        </section>

        <section className="space-y-4">
          <h4 className="border-b border-gray-200 pb-2 text-sm font-semibold text-gray-700">Official Faktur Details</h4>
          <SapRow>
            <FloatingField label="Official DJP Faktur" span={6} filled={!!number} required>
              <input className={FLOAT_INPUT} id="official-faktur-number" value={number} onChange={e => setNumber(e.target.value)} placeholder="Enter number from CA" autoFocus />
            </FloatingField>
            <FloatingField label="Faktur Date" span={6} filled={!!date} required>
              <input className={FLOAT_INPUT} id="faktur-date" type="date" value={date} onChange={e => setDate(e.target.value)} />
            </FloatingField>
          </SapRow>
          <SapRow>
            <FloatingField label="Official PDF Faktur Pajak" span={12} filled={!!pdf} required={!existing} staticLabel>
              <label htmlFor="faktur-pdf" className="flex min-h-16 cursor-pointer items-center gap-3 rounded-md border border-dashed border-gray-300 bg-gray-50 px-4 py-3 hover:border-blue-400 hover:bg-blue-50">
                <Upload className="h-5 w-5 text-gray-500" />
                <span className="min-w-0 text-sm text-gray-700">{pdf ? pdf.name : existing ? 'Choose a replacement PDF' : 'Choose the official PDF received from the CA'}</span>
                <input id="faktur-pdf" type="file" accept="application/pdf,.pdf" className="sr-only" onChange={e => {
                  const file = e.target.files?.[0] ?? null;
                  if (file && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
                    setError('Only PDF files are accepted.');
                    setPdf(null);
                    return;
                  }
                  if (file && file.size > 10 * 1024 * 1024) {
                    setError('The PDF must be 10 MB or smaller.');
                    setPdf(null);
                    return;
                  }
                  setError('');
                  setPdf(file);
                }} />
              </label>
            </FloatingField>
          </SapRow>
          {existing && <p className="text-xs text-gray-500">A recorded PDF is already stored. Upload a new file only if it should be replaced or supplemented.</p>}
          {existing && (
            <div>
              <span className={F_LABEL}>Stored PDF history</span>
              <TaxAttachments
                table="faktur_pajak_files"
                parentId={existing.id}
                storagePrefix="faktur_pajak"
                allowedKinds={FAKTUR_PDF_KINDS}
                showUploader={false}
                allowDelete={false}
              />
            </div>
          )}
          <SapRow>
            <FloatingField label="Notes" span={12} filled={!!notes} textarea>
              <textarea className={FLOAT_TEXTAREA} id="faktur-notes" rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional CA reference or audit note" />
            </FloatingField>
          </SapRow>
        </section>
        {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      </form>
      <FinanceModal
        isOpen={showMismatchWarning}
        onClose={() => setShowMismatchWarning(false)}
        title="Confirm Faktur Difference"
        subtitle="Accountant override required"
        size="sm"
        footer={(
          <>
            <FinanceButton type="button" onClick={() => setShowMismatchWarning(false)}>Cancel</FinanceButton>
            <FinanceButton type="button" variant="primary" onClick={saveAfterValidation}>Continue anyway</FinanceButton>
          </>
        )}
      >
        <p className="text-sm text-gray-700">The uploaded Faktur differs from the Sales Invoice. Continue anyway?</p>
      </FinanceModal>
    </FinanceModal>
  );
}

export function FakturPajakPanel() {
  const { dateRange } = useFinance();
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState<SalesInvoice[]>([]);
  const [fakturs, setFakturs] = useState<Record<string, FakturRow>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [recording, setRecording] = useState<SalesInvoice | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'waiting' | 'recorded'>('all');

  async function refresh() {
    setLoading(true);
    // Single query with nested customer join — same pattern as TaxReportsPanel faktur_register.
    // This avoids a separate customer lookup and works even when customer_id is set but the
    // two-pass lookup fails due to schema cache issues.
    let q = supabase
      .from('sales_invoices')
      .select('id, invoice_number, invoice_date, tax_amount, total_amount, faktur_pajak_number, customer_id, customer:customer_id(company_name, npwp), document_status, cancelled_at')
      .gt('tax_amount', 0)
      .neq('document_status', 'cancelled')
      .is('cancelled_at', null);
    if (dateRange?.startDate) q = q.gte('invoice_date', dateRange.startDate);
    if (dateRange?.endDate) q = q.lte('invoice_date', dateRange.endDate);
    const { data: inv, error: invErr } = await q.order('invoice_date', { ascending: false }).limit(500);
    if (invErr) {
      setLoading(false);
      alert('Failed to load Faktur Pajak invoices: ' + invErr.message);
      return;
    }
    const loaded = ((inv ?? []) as unknown as Array<Omit<SalesInvoice, 'customer'> & {
      customer: Customer | Customer[] | null;
      document_status?: string | null;
      cancelled_at?: string | null;
    }>)
      .filter(i => i.document_status !== 'cancelled' && !i.cancelled_at)
      .map(invoice => ({
        ...invoice,
        customer: firstRelation(invoice.customer),
      }));
    setInvoices(loaded);

    const invIds = loaded.map(i => i.id);
    if (invIds.length) {
      let { data: fs, error: fakturError } = await supabase
        .from('faktur_pajak')
        .select('id, sales_invoice_id, linked_invoice_id, faktur_number, official_djp_number, issue_date, customer_id, invoice_amount, dpp_amount, ppn_amount, status, reported_at, notes, uploaded_by, uploaded_at')
        .in('sales_invoice_id', invIds);
      // Keep the UI readable while an environment is between application and
      // migration deployment; the new save path requires the migration.
      if (fakturError) {
        const legacy = await supabase
          .from('faktur_pajak')
          .select('id, sales_invoice_id, faktur_number, issue_date, customer_id, dpp_amount, ppn_amount, status, reported_at, notes')
          .in('sales_invoice_id', invIds);
        fs = (legacy.data ?? []).map(row => ({
          ...row,
          linked_invoice_id: null,
          official_djp_number: null,
          invoice_amount: null,
          uploaded_by: null,
          uploaded_at: null,
        }));
        fakturError = legacy.error;
      }
      if (fakturError) alert('Failed to load recorded Faktur: ' + fakturError.message);
      setFakturs(Object.fromEntries(((fs as FakturRow[] | null) ?? []).map(f => [f.sales_invoice_id, f])));
    } else {
      setFakturs({});
    }
    setLoading(false);
  }
  useEffect(() => { void refresh();   }, [dateRange?.startDate, dateRange?.endDate]);

  const waitingCount = useMemo(
    () => invoices.filter(i => workflowStatus(i, fakturs[i.id]) === 'waiting').length,
    [invoices, fakturs]
  );

  const totals = useMemo(() => {
    let ppn = 0;
    for (const i of invoices) {
      ppn += Number(i.tax_amount ?? 0);
    }
    return { ppn, count: invoices.length };
  }, [invoices]);

  const filteredInvoices = useMemo(() => {
    if (statusFilter === 'all') return invoices;
    return invoices.filter(i => workflowStatus(i, fakturs[i.id]) === statusFilter);
  }, [invoices, fakturs, statusFilter]);

  async function viewAttachments(invoice: SalesInvoice) {
    const faktur = fakturs[invoice.id];
    if (!faktur) {
      setRecording(invoice);
      return;
    }
    const { data, error } = await supabase
      .from('faktur_pajak_files')
      .select('file_url')
      .eq('faktur_pajak_id', faktur.id)
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data?.file_url) {
      setRecording(invoice);
      return;
    }
    await openStoredAttachment(data.file_url);
  }

  async function saveRecordedFaktur({ invoice, number, date, notes, pdf }: {
    invoice: SalesInvoice;
    number: string;
    date: string;
    notes: string;
    pdf: File | null;
  }) {
    setBusyId(invoice.id);
    try {
      const existing = fakturs[invoice.id];
      // Preserve historical database values, but all new saves use the
      // two-state business workflow exposed by this screen.
      const status = existing?.status === 'reported' ? 'reported' : 'recorded';
      const { data: authData } = await supabase.auth.getUser();
      const uploadedAt = pdf ? new Date().toISOString() : (existing?.uploaded_at ?? new Date().toISOString());
      const uploadedBy = pdf ? (authData.user?.id ?? null) : (existing?.uploaded_by ?? authData.user?.id ?? null);
      const dpp = Math.max(Number(invoice.total_amount ?? 0) - Number(invoice.tax_amount ?? 0), 0);
      const ppn = Number(invoice.tax_amount ?? 0);
      const { data: saved, error } = await supabase
        .from('faktur_pajak')
        .upsert({
          ...(existing?.id ? { id: existing.id } : {}),
          sales_invoice_id: invoice.id,
          linked_invoice_id: invoice.id,
          faktur_number: number.trim(),
          official_djp_number: number.trim(),
          issue_date: date,
          customer_id: invoice.customer_id,
          invoice_amount: Number(invoice.total_amount ?? 0),
          dpp_amount: dpp,
          ppn_amount: ppn,
          status,
          reported_at: existing?.status === 'reported' ? existing.reported_at : null,
          uploaded_by: uploadedBy,
          uploaded_at: uploadedAt,
          notes: notes.trim() || null,
        }, { onConflict: 'sales_invoice_id' })
        .select('id')
        .single();
      if (error || !saved) throw error ?? new Error('Faktur record was not saved');

      const { error: invoiceError } = await supabase
        .from('sales_invoices')
        .update({ faktur_pajak_number: number.trim() })
        .eq('id', invoice.id);
      if (invoiceError) throw invoiceError;

      if (pdf) {
        const safeName = pdf.name.replace(/[^\w.-]/g, '_');
        const path = `faktur_pajak/${saved.id}/${Date.now()}-${safeName}`;
        const { error: uploadError, optimization } = await uploadOptimizedFile(
          supabase,
          'documents',
          path,
          pdf,
          { upsert: false, contentType: 'application/pdf' }
        );
        if (uploadError) throw uploadError;
        const { error: fileError } = await supabase.from('faktur_pajak_files').insert({
          faktur_pajak_id: saved.id,
          file_url: path,
          file_name: pdf.name,
          file_type: optimization.mimeType || pdf.type || 'application/pdf',
          file_size: optimization.optimizedSize || pdf.size,
          kind: 'pdf',
          uploaded_by: authData.user?.id ?? null,
          uploaded_at: uploadedAt,
        });
        if (fileError) throw fileError;
      }

      await refresh();
      setRecording(null);
      showToast({ type: 'success', title: 'Success', message: 'Faktur recorded successfully.' });
    } catch (err) {
      alert('Failed to record Faktur Pajak: ' + (err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function drillIntoInvoice(inv: SalesInvoice) {
    // Navigate to the sales page; the invoice number is copied to the clipboard
    // so the user can paste-search the list.
    void navigator.clipboard?.writeText(inv.invoice_number);
    navigate(`/sales?invoice=${encodeURIComponent(inv.invoice_number)}`);
  }

  function exportExcel() {
    const rows = filteredInvoices.map(inv => {
      const fak = fakturs[inv.id];
      const cust = inv.customer ?? undefined;
      const dpp = fak?.dpp_amount ?? Math.max((inv.total_amount ?? 0) - (inv.tax_amount ?? 0), 0);
      const ppn = fak?.ppn_amount ?? (inv.tax_amount ?? 0);
      return {
        'Invoice #': inv.invoice_number,
        'Invoice Date': inv.invoice_date,
        'Customer': customerDisplay(cust),
        'Customer NPWP': cust?.npwp ?? '',
        'DPP (Rp)': Number(dpp),
        'PPN (Rp)': Number(ppn),
        'ERP Reference': inv.invoice_number,
        'Official DJP Faktur': fak?.official_djp_number ?? fak?.faktur_number ?? '',
        'Status': workflowLabel(workflowStatus(inv, fak)),
      };
    });
    const ws = XLSX.utils.json_to_sheet(sanitizeExportRows(rows));
    ws['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 40 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 24 }, { wch: 12 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Faktur Pajak');
    XLSX.writeFile(wb, `Faktur_Pajak_${dateRange.startDate}_${dateRange.endDate}.xlsx`);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-gray-500" />
          <span className="text-xs text-gray-500 hidden md:inline">
            {dateRange?.startDate ?? '—'} → {dateRange?.endDate ?? '—'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <FinanceSelect
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
          >
            <option value="all">All ({invoices.length})</option>
            <option value="waiting">Waiting ({waitingCount})</option>
            <option value="recorded">Recorded</option>
          </FinanceSelect>
          <FinanceButton type="button" onClick={exportExcel}>
            <Download className="w-3.5 h-3.5" /> Excel
          </FinanceButton>
        </div>
      </div>

      {!loading && invoices.length > 0 && (
        <StatCardGrid cols={3}>
          <StatCard label="Taxable invoices" value={totals.count} money={false} tone="blue" icon={<Receipt className="w-4 h-4" />} />
          <StatCard label="Invoiced PPN" value={totals.ppn} tone="green" icon={<FileText className="w-4 h-4" />} hint="Gross PPN from taxable sales invoices, before credit note adjustments" />
          <StatCard label="Waiting for Faktur" value={waitingCount} money={false} tone={waitingCount > 0 ? 'orange' : 'gray'} icon={<FileWarning className="w-4 h-4" />} />
        </StatCardGrid>
      )}

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : filteredInvoices.length === 0 ? (
        <SectionCard>
          <EmptyState
            icon={<FileWarning className="w-6 h-6" />}
            title="No sales invoices with PPN in the selected date range"
            hint={`Range ${dateRange?.startDate ?? '—'} to ${dateRange?.endDate ?? '—'} · Filter ${statusFilter === 'all' ? 'All' : statusFilter}. Faktur Pajak only lists taxable Sales Invoices (tax_amount > 0). Widen the date range or check that the invoice actually has PPN.`}
          />
        </SectionCard>
      ) : (
        <SectionCard>
        <FinanceTable
          rows={filteredInvoices}
          rowKey={inv => inv.id}
          loading={loading}
          empty="No taxable Sales Invoices in this view."
          columns={[
            { header: 'ERP Reference', cell: inv => <FinanceButton type="button" variant="ghost" onClick={() => drillIntoInvoice(inv)} className="text-blue-600 hover:underline inline-flex items-center gap-1 font-medium">{inv.invoice_number}<ExternalLink className="w-3 h-3" /></FinanceButton> },
            { header: 'Date', cell: inv => inv.invoice_date },
            { header: 'Customer', cell: inv => <div><div className="font-medium">{customerDisplay(inv.customer ?? undefined)}</div>{inv.customer?.npwp && <div className="text-[10px] text-gray-500">NPWP: {inv.customer.npwp}</div>}</div> },
            { header: 'DPP', align: 'right' as const, cell: inv => Number((inv.total_amount ?? 0) - (inv.tax_amount ?? 0)).toLocaleString('id-ID') },
            { header: 'PPN', align: 'right' as const, cell: inv => Number(inv.tax_amount ?? 0).toLocaleString('id-ID') },
            { header: 'Official DJP Faktur', cell: inv => fakturs[inv.id]?.official_djp_number ?? fakturs[inv.id]?.faktur_number ?? '—' },
            { header: 'Status', cell: inv => { const status = workflowStatus(inv, fakturs[inv.id]); return <FinanceBadge status={status as FinanceStatus}>{workflowLabel(status)}</FinanceBadge>; } },
            { header: 'Actions', align: 'center' as const, cell: inv => { const fak = fakturs[inv.id]; return <div className="flex items-center justify-center gap-0.5"><FinanceActionButton action="edit" label={fak ? 'Edit Faktur' : 'Record Faktur'} onClick={() => setRecording(inv)} disabled={busyId === inv.id} /><FinanceActionButton action="attachment" label="View Attachments" onClick={() => void viewAttachments(inv)} /></div>; } },
          ]}
        />
        </SectionCard>
      )}

      {recording && (
        <RecordFakturModal
          invoice={recording}
          existing={fakturs[recording.id]}
          busy={busyId === recording.id}
          onClose={() => setRecording(null)}
          onSave={saveRecordedFaktur}
        />
      )}
    </div>
  );
}
