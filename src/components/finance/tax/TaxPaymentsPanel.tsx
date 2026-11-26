import { useEffect, useMemo, useState } from 'react';
import { Plus, Download, Trash2, Pencil, Receipt, Wallet, CheckCircle2, Clock, Paperclip, Eye } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useFinance } from '../../../contexts/FinanceContext';
import { TaxAttachments } from './TaxAttachments';
import { getPostedJournalLinesByEntryIds, writeReconciliationWorkbook, type ReconciliationSummaryRow } from '../reconciliationExport';
import { FinanceModal as Modal } from '../FinanceModal';
import { MoneyInput } from '../../MoneyInput';
import { StatCard, StatCardGrid, SectionCard, StatusChip, EmptyState, paymentStatusLabel, taxPaymentBusinessStatus } from './TaxUI';
import { formatFinancePeriod } from '../../../utils/financePeriod';
import { linkBankStatementLine } from '../../../services/financeCommands';
import { loadUnmatchedDebitBankTransactions, type BankTransactionLine } from '../bankTransactionLinking';
import { FloatingField, FLOAT_INPUT } from '../FloatingField';
import { SapRow } from '../SapLayout';

interface Period {
  id: string;
  fiscal_year: number;
  period_month: number;
  tax_type: string;
  status: string;
  paid_amount: number | null;
  outstanding_amount: number | null;
  payment_status: string | null;
}
interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
  alias: string | null;
  currency: string | null;
}
interface Payment {
  id: string;
  tax_period_id: string;
  tax_type: string;
  payment_date: string;
  amount: number;
  billing_code: string | null;
  ntpn: string | null;
  ntpn_format_valid?: boolean;
  ntpn_verified?: boolean;
  bank_verified?: boolean;
  document_attached?: boolean;
  payment_reference: string | null;
  government_reference: string | null;
  status: string;
  journal_entry_id: string | null;
  bank_account_id: string | null;
  notes: string | null;
  attachment_count?: number;
}

const KINDS = [
  { value: 'billing_code',        label: 'Billing Code (Kode Billing)' },
  { value: 'ntpn',                label: 'NTPN receipt' },
  { value: 'government_receipt',  label: 'Government receipt' },
  { value: 'bank_transfer_proof', label: 'Bank transfer proof' },
  { value: 'other',               label: 'Other' },
] as const;

function bankLabel(b: BankAccount): string {
  return b.alias || `${b.bank_name} - ${b.account_name}`;
}

interface TaxPaymentsPanelProps {
  onOpenJournal?: (journalEntryId: string) => void;
}

export function TaxPaymentsPanel({ onOpenJournal }: TaxPaymentsPanelProps) {
  const { dateRange } = useFinance();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Payment | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyDeleteId, setBusyDeleteId] = useState<string | null>(null);
  const [bslPickerPayment, setBslPickerPayment] = useState<Payment | null>(null);
  const [bslCandidates, setBslCandidates] = useState<BankTransactionLine[]>([]);
  const [bslPickerLoading, setBslPickerLoading] = useState(false);
  const [bslLinking, setBslLinking] = useState(false);
  const [typeFilter, setTypeFilter] = useState('all');

  const emptyForm = {
    tax_period_id: '',
    tax_type: 'PPN',
    payment_date: new Date().toISOString().slice(0, 10),
    amount: '',
    bank_account_id: '',
    billing_code: '',
    ntpn: '',
    payment_reference: '',
    government_reference: '',
    notes: '',
  };
  const [form, setForm] = useState(emptyForm);

  async function refresh() {
    setLoading(true);
    const [ppnPeriods, pphPeriods, b, tp] = await Promise.all([
      supabase.from('vw_tax_period_status')
        .select('id, fiscal_year, period_month, tax_type, status, paid_amount, outstanding_amount, payment_status')
        .eq('tax_type', 'PPN'),
      // The PPh Register is the authoritative source for PPh periods. Use its
      // exact rows here so status/outstanding cannot diverge between screens.
      supabase.from('vw_pph_by_period_type')
        .select('tax_period_id, fiscal_year, period_month, tax_type, status, pph_paid_total, pph_outstanding, payment_status'),

      supabase.from('bank_accounts')
        .select('id, account_name, bank_name, alias, currency')
        .eq('is_active', true)
        .order('alias', { nullsFirst: false })
        .order('account_name'),
      supabase.from('tax_payments')
        .select('id, tax_period_id, tax_type, payment_date, amount, billing_code, ntpn, ntpn_format_valid, ntpn_verified, bank_verified, document_attached, payment_reference, government_reference, status, journal_entry_id, bank_account_id, notes')
        .order('payment_date', { ascending: false })
        .limit(500),
    ]);
    const ppn = ((ppnPeriods.data as any[] | null) ?? []).map(p => ({ ...p, paid_amount: Number(p.paid_amount ?? 0), outstanding_amount: Number(p.outstanding_amount ?? 0) }));
    const pph = ((pphPeriods.data as any[] | null) ?? []).map(p => ({
      id: p.tax_period_id,
      fiscal_year: p.fiscal_year,
      period_month: p.period_month,
      tax_type: p.tax_type,
      status: p.status,
      paid_amount: Number(p.pph_paid_total ?? 0),
      outstanding_amount: Number(p.pph_outstanding ?? 0),
      payment_status: p.payment_status,
    }));
    setPeriods([...ppn, ...pph].sort((a, b) => b.fiscal_year - a.fiscal_year || b.period_month - a.period_month));
    setBanks((b.data as BankAccount[] | null) ?? []);
    const paymentRows = (tp.data as Payment[] | null) ?? [];
    const { data: files } = await supabase.from('tax_payment_files').select('tax_payment_id');
    const counts = new Map<string, number>();
    (files ?? []).forEach((file: { tax_payment_id: string }) => counts.set(file.tax_payment_id, (counts.get(file.tax_payment_id) ?? 0) + 1));
    setPayments(paymentRows.map(payment => ({ ...payment, attachment_count: counts.get(payment.id) ?? 0 })));
    setLoading(false);
  }
  useEffect(() => { void refresh(); }, []);

  const matchingPeriods = useMemo(
    () => periods.filter(p => p.tax_type === form.tax_type),
    [periods, form.tax_type]
  );

  const selectedPeriod = useMemo(
    () => periods.find(period => period.id === form.tax_period_id) ?? null,
    [periods, form.tax_period_id],
  );

  const selectedOutstanding = Number(selectedPeriod?.outstanding_amount ?? 0);
  const selectedPaid = Number(selectedPeriod?.paid_amount ?? 0);

  // Exactly the engine-derived status the Tax Register shows
  // (vw_tax_period_status.payment_status) — never a locally recomputed label,
  // never raw internal values. Partial payments remain visible through the
  // Outstanding/Paid hint under the select.
  function paymentLabel(period: Period): string {
    return paymentStatusLabel(taxPaymentBusinessStatus({
      paymentStatus: period.payment_status,
      paidAmount: period.paid_amount,
      outstandingAmount: period.outstanding_amount,
    }));
  }

  const filteredPayments = useMemo(() => {
    return payments.filter(p =>
      (!dateRange?.startDate || !dateRange?.endDate || (p.payment_date >= dateRange.startDate && p.payment_date <= dateRange.endDate))
      && (typeFilter === 'all' || p.tax_type === typeFilter)
    );
  }, [payments, dateRange, typeFilter]);

  const taxTypes = useMemo(() => [...new Set([...periods.map(p => p.tax_type), ...payments.map(p => p.tax_type)])].sort(), [periods, payments]);

  const bankById = useMemo(() => {
    const map = new Map<string, BankAccount>();
    for (const b of banks) map.set(b.id, b);
    return map;
  }, [banks]);

  const periodLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of periods) map.set(p.id, formatFinancePeriod(p.fiscal_year, p.period_month));
    return map;
  }, [periods]);

  const totals = useMemo(() => {
    let total = 0, reconciled = 0, pending = 0;
    for (const p of filteredPayments) {
      total += Number(p.amount ?? 0);
      if (p.status === 'reconciled') reconciled += Number(p.amount ?? 0);
      else pending += Number(p.amount ?? 0);
    }
    return { total, reconciled, pending, count: filteredPayments.length };
  }, [filteredPayments]);

  function startEdit(p: Payment) {
    setEditingId(p.id);
    setForm({
      tax_period_id: p.tax_period_id,
      tax_type: p.tax_type,
      payment_date: p.payment_date,
      amount: String(p.amount),
      bank_account_id: p.bank_account_id ?? '',
      billing_code: p.billing_code ?? '',
      ntpn: p.ntpn ?? '',
      payment_reference: p.payment_reference ?? '',
      government_reference: p.government_reference ?? '',
      notes: p.notes ?? '',
    });
    setShowForm(true);
  }

  function cancelForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.tax_period_id || !form.bank_account_id || !form.amount) {
      alert('Period, bank account and amount are required.');
      return;
    }
    if (!editingId && selectedOutstanding <= 0.01) {
      alert('This tax period has no outstanding amount and cannot be paid again.');
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        const { error } = await supabase.rpc('update_tax_payment', {
          p_id: editingId,
          p_payment_date: form.payment_date,
          p_amount: Number(form.amount),
          p_bank_account_id: form.bank_account_id,
          p_billing_code: form.billing_code || null,
          p_ntpn: form.ntpn || null,
          p_government_reference: form.government_reference || null,
          p_notes: form.notes || null,
          p_payment_reference: form.payment_reference || null,
        });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.rpc('record_tax_payment', {
          p_tax_period_id: form.tax_period_id,
          p_tax_type: form.tax_type,
          p_payment_date: form.payment_date,
          p_amount: Number(form.amount),
          p_bank_account_id: form.bank_account_id,
          p_billing_code: form.billing_code || null,
          p_ntpn: form.ntpn || null,
          p_government_reference: form.government_reference || null,
          p_notes: form.notes || null,
          p_payment_reference: form.payment_reference || null,
        });
        if (error) throw error;
        const newId = data as string;
        await refresh();
        cancelForm();
        // After refresh, open BSL picker for the newly created payment
        const { data: newPmt } = await supabase
          .from('tax_payments')
          .select('id, tax_type, payment_date, amount, bank_account_id, journal_entry_id, status, billing_code, ntpn, payment_reference, notes, tax_period_id')
          .eq('id', newId)
          .maybeSingle();
        if (newPmt) void openBslPicker(newPmt as Payment);
        return;
      }
      await refresh();
      cancelForm();
    } catch (err) {
      alert((editingId ? 'Failed to update' : 'Failed to record') + ' tax payment: ' + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function del(p: Payment) {
    if (!confirm(`Delete ${p.tax_type} tax payment of Rp ${Number(p.amount).toLocaleString('id-ID')} on ${p.payment_date}?\n\nThis reverses the journal entry, releases any bank reconciliation match, and removes attachments. The delete is safe: any orphan will abort the operation.`)) return;
    setBusyDeleteId(p.id);
    try {
      const { error } = await supabase.rpc('delete_tax_payment', { p_id: p.id });
      if (error) throw error;
      if (selected?.id === p.id) setSelected(null);
      await refresh();
    } catch (err) {
      alert('Failed to delete tax payment: ' + (err as Error).message);
    } finally {
      setBusyDeleteId(null);
    }
  }

  async function loadBslCandidates(p: Payment) {
    setBslPickerPayment(p);
    setBslCandidates([]);
    setBslPickerLoading(true);
    try {
      if (!p.bank_account_id) throw new Error('Tax payment has no bank account.');
      const data = await loadUnmatchedDebitBankTransactions({
        bankAccountId: p.bank_account_id,
        direction: 'debit',
      });
      const amount = Number(p.amount);
      const payDate = new Date(p.payment_date).getTime();
      const scored = data.map((b) => ({
        row: b,
        amountDiff: Math.abs(Number(b.remainingAmount ?? b.debit_amount) - amount),
        dateDiff: Math.abs(new Date(b.transaction_date).getTime() - payDate),
      }));
      scored.sort((a, b) => {
        // Exact-amount matches first, then closest date.
        const aExact = a.amountDiff < 1 ? 0 : 1;
        const bExact = b.amountDiff < 1 ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        if (a.dateDiff !== b.dateDiff) return a.dateDiff - b.dateDiff;
        return a.amountDiff - b.amountDiff;
      });
      setBslCandidates(scored
        .slice(0, 50)
        .map((candidate) => candidate.row));
    } catch (err) {
      console.error('Error fetching BSL candidates:', err);
      alert('Failed to load available bank statement lines: ' + (err as Error).message);
    } finally {
      setBslPickerLoading(false);
    }
  }

  async function openBslPicker(p: Payment) {
    await loadBslCandidates(p);
  }

  async function linkBsl(bankLine: BankTransactionLine) {
    if (!bslPickerPayment?.journal_entry_id) {
      alert('❌ Tax payment has no journal entry. Record it again if needed.');
      return;
    }
    setBslLinking(true);
    try {
      const allocationAmount = Math.min(
        Number(bankLine.remainingAmount ?? bankLine.debit_amount),
        Number(bslPickerPayment.amount),
      );
      await linkBankStatementLine(bankLine.id, 'tax_payment', bslPickerPayment.id, 'supplier', allocationAmount);
      setBslPickerPayment(null);
      setBslCandidates([]);
      await refresh();
      alert('Bank statement linked. Tax payment status updated to Reconciled.');
    } catch (err: any) {
      alert('Error linking bank statement: ' + err.message);
    } finally {
      setBslLinking(false);
    }
  }

  async function exportExcel() {
    const journalIds = filteredPayments.map((payment) => payment.journal_entry_id).filter((id): id is string => Boolean(id));
    const paymentByJournalId = Object.fromEntries(filteredPayments.filter((payment) => payment.journal_entry_id).map((payment) => [payment.journal_entry_id!, payment]));
    const bankByJournalId = Object.fromEntries(filteredPayments.filter((payment) => payment.journal_entry_id).map((payment) => [payment.journal_entry_id!, payment.bank_account_id && bankById.get(payment.bank_account_id) ? bankLabel(bankById.get(payment.bank_account_id)!) : '']));
    const periodByJournalId = Object.fromEntries(filteredPayments.filter((payment) => payment.journal_entry_id).map((payment) => [payment.journal_entry_id!, periodLabelById.get(payment.tax_period_id) ?? '']));
    try {
      const journalLines = await getPostedJournalLinesByEntryIds(
        journalIds,
        'Tax',
        Object.fromEntries(Object.entries(paymentByJournalId).map(([journalId, payment]) => [journalId, payment.payment_reference || payment.id])),
        bankByJournalId,
        periodByJournalId,
      );
      const primaryByJournalId = new Map<string, { code: string; name: string }>();
      const journalMetaByDocument = new Map<string, { number: string; date: string }>();
      for (const payment of filteredPayments) {
        if (!payment.journal_entry_id) continue;
        const line = journalLines.find((item) => item['Journal Number'] && item['Document Number'] === (payment.payment_reference || payment.id) && item.Debit > 0) || journalLines.find((item) => item['Document Number'] === (payment.payment_reference || payment.id));
        if (line) primaryByJournalId.set(payment.journal_entry_id, { code: line['COA Code'], name: line['COA Name'] });
        if (line) journalMetaByDocument.set(payment.payment_reference || payment.id, { number: line['Journal Number'], date: line['Journal Date'] });
      }
      const rows: ReconciliationSummaryRow[] = filteredPayments.map((payment) => {
        const bank = payment.bank_account_id ? bankById.get(payment.bank_account_id) : undefined;
        const primary = payment.journal_entry_id ? primaryByJournalId.get(payment.journal_entry_id) : undefined;
        const journalMeta = journalMetaByDocument.get(payment.payment_reference || payment.id);
        return {
          'Source Module': 'Tax', 'Document Type': 'Tax Payment', 'Document Number': payment.payment_reference || payment.id,
          'Document Date': payment.payment_date, 'Posting Date': journalMeta?.date || '', 'Journal Number': journalMeta?.number || '', 'Journal Status': journalMeta ? 'Posted' : 'Not posted',
          'Approval Status': '', 'Payment Status': payment.status, 'Reconciliation Status': '', 'Party Type': 'Tax Authority', 'Party Name': '',
          'Category Parent': '', 'Leaf Category': payment.tax_type, Currency: bank?.currency || 'IDR', 'Exchange Rate': 1,
          'Gross Amount': Number(payment.amount), Discount: '', 'DPP / Tax Base': '', PPN: payment.tax_type.toUpperCase() === 'PPN' ? Number(payment.amount) : '',
          PPh21: payment.tax_type.toUpperCase() === 'PPH21' ? Number(payment.amount) : '', PPh22: payment.tax_type.toUpperCase() === 'PPH22' ? Number(payment.amount) : '',
          PPh23: payment.tax_type.toUpperCase() === 'PPH23' ? Number(payment.amount) : '', 'PPh4(2)': /PPH\s*4\s*\(?2\)?/i.test(payment.tax_type) ? Number(payment.amount) : '',
          'Other Taxes': !/^(PPN|PPH21|PPH22|PPH23|PPH\s*4\s*\(?2\)?)$/i.test(payment.tax_type) ? Number(payment.amount) : '',
          'Bank Charges': '', 'Salary Advance': '', 'Other Deductions': '', 'Net Settlement Amount': Number(payment.amount), 'Actual Bank Amount': '', 'Settlement Difference': '',
          'Primary COA Code': primary?.code || '', 'Primary COA Name': primary?.name || '', 'Bank Account': bank ? bankLabel(bank) : '', 'Bank Statement Reference': '',
          'Tax Period': periodLabelById.get(payment.tax_period_id) ?? '', 'Tax Reference / NTPN (where applicable)': payment.ntpn || payment.billing_code || '', Remarks: payment.notes || '',
        };
      });
      writeReconciliationWorkbook(rows, journalLines, `Tax_Payments_${dateRange.startDate}_${dateRange.endDate}.xlsx`);
    } catch (error) {
      console.error('Tax export failed', error);
      alert('Unable to resolve posted journal lines for this export.');
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <select name="type_filter" value={typeFilter} onChange={event => setTypeFilter(event.target.value)} className="h-7 rounded border px-2 text-xs" aria-label="Tax payment type filter">
            <option value="all">All types</option>
            {taxTypes.map(type => <option key={type} value={type}>{type}</option>)}
          </select>
          <span className="text-xs text-gray-500 hidden md:inline">
            {dateRange?.startDate ?? '—'} → {dateRange?.endDate ?? '—'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={exportExcel}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border rounded-md hover:bg-gray-50"
          >
            <Download className="w-3.5 h-3.5" /> Excel
          </button>
          <button
            onClick={() => { if (showForm) cancelForm(); else setShowForm(true); }}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            <Plus className="w-3.5 h-3.5" /> Record Tax Payment
          </button>
        </div>
      </div>

      <Modal
        isOpen={showForm}
        onClose={cancelForm}
        title={editingId ? 'Edit Tax Payment' : 'Record Tax Payment'}
        size="lg"
      >
        <form onSubmit={submit} className="space-y-3">
          {editingId && (
            <p className="text-xs text-blue-800 font-medium">
              Editing existing tax payment — this reverses the current journal entry and posts a fresh one.
            </p>
          )}
          <SapRow>
            <FloatingField label="Tax Type" span={4} filled={!!form.tax_type}>
              <select className={FLOAT_INPUT} name="tax_type" aria-label="Tax Type"
                value={form.tax_type}
                onChange={e => setForm(f => ({ ...f, tax_type: e.target.value, tax_period_id: editingId ? f.tax_period_id : '', amount: editingId ? f.amount : '' }))}
                disabled={!!editingId}
              >
                {taxTypes.map(t => (
                  <option key={t} value={t}>
                    {t === 'PPh21' ? 'PPh21' : t === 'PPh_Unifikasi' ? 'PPh Unifikasi (Consolidated)' : t}
                  </option>
                ))}
              </select>
            </FloatingField>
            <div className="sm:col-span-4 min-w-0">
              <FloatingField label="Tax Period" span={12} filled={!!form.tax_period_id} required>
                <select className={FLOAT_INPUT} name="tax_period_id" aria-label="Tax Period Id"
                  value={form.tax_period_id}
                  onChange={e => {
                    const period = periods.find(item => item.id === e.target.value);
                    setForm(f => ({
                      ...f,
                      tax_period_id: e.target.value,
                      amount: editingId ? f.amount : period ? String(Math.max(0, Number(period.outstanding_amount ?? 0))) : '',
                    }));
                  }}
                  required
                  disabled={!!editingId}
                >
                  <option value="">— select —</option>
                  {matchingPeriods.map(p => (
                    <option key={p.id} value={p.id}>
                      {formatFinancePeriod(p.fiscal_year, p.period_month)} ({paymentLabel(p)}) · Outstanding Rp {Math.max(0, Number(p.outstanding_amount ?? 0)).toLocaleString('id-ID')}
                    </option>
                  ))}
                </select>
              </FloatingField>
              {selectedPeriod && (
                <span className={`mt-0.5 block text-xs ${selectedOutstanding <= 0.01 ? 'text-emerald-700' : 'text-amber-700'}`}>
                  Outstanding: Rp {selectedOutstanding.toLocaleString('id-ID')}
                  {selectedPaid > 0.01 && selectedOutstanding > 0.01 ? ` · Paid: Rp ${selectedPaid.toLocaleString('id-ID')}` : ''}
                </span>
              )}
            </div>
            <FloatingField label="Payment Date" span={4} filled={!!form.payment_date} required>
              <input className={FLOAT_INPUT} name="payment_date" aria-label="Payment Date"
                type="date"
                value={form.payment_date}
                onChange={e => setForm(f => ({ ...f, payment_date: e.target.value }))}
                required
              />
            </FloatingField>
          </SapRow>
          <SapRow>
            <FloatingField label="Amount (Rp)" span={4} filled={!!form.amount} required>
              <MoneyInput
                value={form.amount === '' ? 0 : Number(form.amount)}
                onChange={n => setForm(f => ({ ...f, amount: n ? String(n) : '' }))}
                className={FLOAT_INPUT}
                required
              />
            </FloatingField>
            <FloatingField label="Bank Account" span={4} filled={!!form.bank_account_id} required>
              <select className={FLOAT_INPUT} name="bank_account_id" aria-label="Bank Account Id"
                value={form.bank_account_id}
                onChange={e => setForm(f => ({ ...f, bank_account_id: e.target.value }))}
                required
              >
                <option value="">— select —</option>
                {banks.map(b => (
                  <option key={b.id} value={b.id}>
                    {bankLabel(b)}{b.currency ? ` (${b.currency})` : ''}
                  </option>
                ))}
              </select>
            </FloatingField>
            <FloatingField label="Billing Code (Kode Billing)" span={4} filled={!!form.billing_code}>
              <input className={FLOAT_INPUT} name="billing_code" aria-label="e.g. 820260713000123"
                value={form.billing_code}
                onChange={e => setForm(f => ({ ...f, billing_code: e.target.value }))}
                placeholder="e.g. 820260713000123"
              />
            </FloatingField>
          </SapRow>
          <SapRow>
            <FloatingField label="NTPN" span={4} filled={!!form.ntpn}>
              <input className={FLOAT_INPUT} name="ntpn" aria-label="16-char DJP reference"
                value={form.ntpn}
                onChange={e => setForm(f => ({ ...f, ntpn: e.target.value }))}
                placeholder="16-char DJP reference"
              />
            </FloatingField>
            <FloatingField label="Government Reference" span={4} filled={!!form.government_reference}>
              <input className={FLOAT_INPUT} name="government_reference" aria-label="Government Reference" value={form.government_reference} onChange={e => setForm(f => ({ ...f, government_reference: e.target.value }))} />
            </FloatingField>
            <FloatingField label="Payment Reference" span={4} filled={!!form.payment_reference}>
              <input className={FLOAT_INPUT} name="payment_reference" aria-label="Bank transfer reference"
                value={form.payment_reference}
                onChange={e => setForm(f => ({ ...f, payment_reference: e.target.value }))}
                placeholder="Bank transfer reference"
              />
            </FloatingField>
          </SapRow>
          <SapRow>
            <FloatingField label="Notes" span={12} filled={!!form.notes}>
              <input className={FLOAT_INPUT} name="notes" aria-label="Notes"
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              />
            </FloatingField>
          </SapRow>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={cancelForm} className="px-3 py-1.5 text-sm border rounded">Cancel</button>
            <button
              type="submit"
              disabled={saving || (!editingId && (!selectedPeriod || selectedOutstanding <= 0.01))}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? (editingId ? 'Updating…' : 'Posting…') : (!editingId && selectedPeriod && selectedOutstanding <= 0.01 ? 'Already Paid' : editingId ? 'Update & Repost' : 'Post & Journal')}
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Posts <b>Dr Tax Payable · Cr Bank</b> via the shared journal engine. The resulting entry
            appears in Bank Reconciliation and auto-flips this payment to "reconciled" once matched.
          </p>
        </form>
      </Modal>

      {!loading && filteredPayments.length > 0 && (
        <StatCardGrid cols={4}>
          <StatCard label="Payments" value={totals.count} money={false} tone="blue" icon={<Receipt className="w-4 h-4" />} />
          <StatCard label="Total paid" value={totals.total} tone="green" icon={<Wallet className="w-4 h-4" />} />
          <StatCard label="Reconciled" value={totals.reconciled} tone="green" icon={<CheckCircle2 className="w-4 h-4" />} />
          <StatCard label="Awaiting reconcile" value={totals.pending} tone={totals.pending > 0 ? 'orange' : 'gray'} icon={<Clock className="w-4 h-4" />} />
        </StatCardGrid>
      )}

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : filteredPayments.length === 0 ? (
        <SectionCard><EmptyState icon={<Receipt className="w-6 h-6" />} title="No tax payments in the selected date range" hint="Record a tax payment with the button above, or widen the date range." /></SectionCard>
      ) : (
        <SectionCard>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-2.5 py-1.5">Date</th>
                <th className="text-left px-2.5 py-1.5">Type</th>
                <th className="text-left px-2.5 py-1.5">Period</th>
                <th className="text-left px-2.5 py-1.5">Bank</th>
                <th className="text-right px-2.5 py-1.5">Amount</th>
                <th className="text-left px-2.5 py-1.5">NTPN / Billing / Ref</th>
                <th className="text-left px-2.5 py-1.5">Status</th>
                <th className="text-center px-2.5 py-1.5">Files</th>
                <th className="px-2.5 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {filteredPayments.map(p => {
                const bank = p.bank_account_id ? bankById.get(p.bank_account_id) : null;
                return (
                  <tr key={p.id} className={`border-t ${selected?.id === p.id ? 'bg-blue-50' : ''}`}>
                    <td className="px-2.5 py-1.5 whitespace-nowrap">{p.payment_date}</td>
                    <td className="px-2.5 py-1.5">{p.tax_type}</td>
                    <td className="px-2.5 py-1.5">{periodLabelById.get(p.tax_period_id) ?? '—'}</td>
                    <td className="px-2.5 py-1.5">{bank ? bankLabel(bank) : '—'}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">Rp {Number(p.amount).toLocaleString('id-ID')}</td>
                    <td className="px-2.5 py-1.5 text-[11px]">
                      {p.ntpn && (
                        <div>
                          <span className="text-gray-400">NTPN:</span> {p.ntpn}{' '}
                          <span className={p.ntpn_verified ? 'text-emerald-700 font-medium' : 'text-amber-700'}>
                            ({p.ntpn_verified ? 'DJP Verified' : p.ntpn_format_valid ? 'Format Valid · Pending Evidence' : 'Pending Evidence'})
                          </span>
                        </div>
                      )}
                      {!p.ntpn && <div className="text-amber-700">NTPN: Pending Evidence</div>}
                      {p.billing_code && <div><span className="text-gray-400">Billing:</span> {p.billing_code}</div>}
                      {p.payment_reference && <div><span className="text-gray-400">Ref:</span> {p.payment_reference}</div>}
                      {!p.ntpn && !p.billing_code && !p.payment_reference && '—'}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span title={p.status === 'posted' ? 'Awaiting bank reconciliation — use "Link Bank Stmt" to match' : undefined}>
                        <StatusChip status={p.status} />
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-center">
                      <button onClick={() => setSelected(p)} title={p.attachment_count ? `${p.attachment_count} attachment(s)` : 'No attachments'} className="inline-flex items-center gap-1 text-[11px] text-gray-600 hover:text-blue-700">
                        <Paperclip className={`w-3.5 h-3.5 ${p.attachment_count ? 'text-blue-600' : 'text-gray-300'}`} />{p.attachment_count || '—'}
                      </button>
                    </td>
                    <td className="px-2.5 py-1.5 text-right whitespace-nowrap space-x-1">
                      <button onClick={() => setSelected(p)} className="text-[11px] px-1.5 py-0.5 border rounded hover:bg-gray-50" title="View tax payment details"><Eye className="w-3 h-3" /></button>
                      {p.journal_entry_id && (
                        <button
                          onClick={() => onOpenJournal?.(p.journal_entry_id!)}
                          className="text-[11px] px-1.5 py-0.5 border rounded hover:bg-blue-50 text-blue-700 border-blue-200 inline-flex items-center gap-1"
                          title="Open the posted journal entry"
                        >
                          Journal
                        </button>
                      )}
                      {p.status === 'posted' && p.journal_entry_id && (
                        <button
                          onClick={() => void openBslPicker(p)}
                          className="text-[11px] px-1.5 py-0.5 border rounded hover:bg-purple-50 text-purple-700 border-purple-200 inline-flex items-center gap-1"
                          title="Link a bank statement line to reconcile this payment"
                        >
                          Link Bank
                        </button>
                      )}
                      <button
                        onClick={() => startEdit(p)}
                        disabled={p.status === 'reconciled'}
                        className="text-[11px] px-1.5 py-0.5 border rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
                        title={p.status === 'reconciled' ? 'Unmatch in Bank Reconciliation first (admin can override)' : 'Edit — reverses & reposts JE'}
                      >
                        <Pencil className="w-3 h-3" /> Edit
                      </button>
                      <button
                        onClick={() => void del(p)}
                        disabled={busyDeleteId === p.id}
                        className="text-[11px] px-1.5 py-0.5 border rounded hover:bg-red-50 text-red-600 disabled:opacity-40 inline-flex items-center gap-1"
                        title="Delete — reverses JE and releases bank reconciliation"
                      >
                        <Trash2 className="w-3 h-3" />
                        {busyDeleteId === p.id ? '…' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </SectionCard>
      )}

      {selected && (
        <Modal isOpen={!!selected} onClose={() => setSelected(null)} title="Tax Payment Details" size="xl">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-sm">{selected.tax_type} · {periodLabelById.get(selected.tax_period_id) ?? '—'}</h4>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
            <div><span className="text-gray-500">Payment date</span><div>{selected.payment_date}</div></div>
            <div><span className="text-gray-500">Amount</span><div>Rp {Number(selected.amount).toLocaleString('id-ID')}</div></div>
            <div><span className="text-gray-500">Bank account</span><div>{selected.bank_account_id && bankById.get(selected.bank_account_id) ? bankLabel(bankById.get(selected.bank_account_id)!) : '—'}</div></div>
            <div><span className="text-gray-500">Billing code</span><div>{selected.billing_code || '—'}</div></div>
            <div><span className="text-gray-500">NTPN</span><div>{selected.ntpn || '—'}</div></div>
            <div><span className="text-gray-500">Government reference</span><div>{selected.government_reference || '—'}</div></div>
            <div><span className="text-gray-500">Payment reference</span><div>{selected.payment_reference || '—'}</div></div>
            <div><span className="text-gray-500">Reconciliation status</span><div><StatusChip status={selected.status} /></div></div>
            <div><span className="text-gray-500">Journal</span><div className="font-mono">{selected.journal_entry_id || '—'}</div></div>
          </div>
          <div className="border-t pt-3"><h5 className="font-medium text-sm mb-2">Attachments ({selected.attachment_count ?? 0})</h5>
          <TaxAttachments
            table="tax_payment_files"
            parentId={selected.id}
            storagePrefix="tax_payments"
            allowedKinds={KINDS}
          />
          </div>
        </div>
        </Modal>
      )}

      <Modal
        isOpen={!!bslPickerPayment}
        onClose={() => setBslPickerPayment(null)}
        title="Link Bank Statement Line"
        size="2xl"
      >
        {bslPickerPayment && (
          <div>
            <p className="text-xs text-gray-500 mb-4">
              Tax payment: <span className="font-medium text-purple-700">{bslPickerPayment.tax_type}</span> ·{' '}
              Rp {Number(bslPickerPayment.amount).toLocaleString('id-ID')} · {bslPickerPayment.payment_date}
              {bslPickerPayment.bank_account_id && bankById.get(bslPickerPayment.bank_account_id) && (
                <> · <span className="text-gray-600">{bankLabel(bankById.get(bslPickerPayment.bank_account_id)!)}</span></>
              )}
            </p>
            {bslPickerLoading ? (
              <div className="flex justify-center py-6"><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-purple-600" /></div>
            ) : bslCandidates.length === 0 ? (
              <div className="text-sm text-gray-500 text-center py-4 border rounded-lg bg-gray-50">
                No unmatched bank statement lines available on this account.
                <div className="mt-2 text-xs text-gray-400">Import the bank statement first, then return here to link.</div>
              </div>
            ) : (
              <>
              <div className="space-y-1 max-h-[60vh] overflow-y-auto border rounded-lg divide-y">
                {bslCandidates.map((b) => {
                  const available = Number(b.remainingAmount ?? b.debit_amount);
                  const exact = Math.abs(available - Number(bslPickerPayment.amount)) < 1;
                  return (
                    <button
                      key={b.id}
                      onClick={() => void linkBsl(b)}
                      disabled={bslLinking}
                      className={`w-full p-3 text-left hover:bg-purple-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm grid grid-cols-[minmax(0,1fr)_auto] gap-4 items-center ${exact ? 'bg-emerald-50/50' : ''}`}
                    >
                      <div>
                        <div className="font-medium text-gray-800 break-words">{b.description || '— no description —'}</div>
                        <div className="text-xs text-gray-400">
                          {new Date(b.transaction_date).toLocaleDateString('id-ID')}
                          {b.reference && <> · Ref: {b.reference}</>}
                          {exact ? <span className="ml-2 text-emerald-700 font-medium">Exact amount</span> : null}
                        </div>
                      </div>
                      <div className="font-medium text-red-600 text-sm">
                        Rp {Number(b.debit_amount).toLocaleString('id-ID')}
                        {Number(b.allocatedAmount || 0) > 0 && (
                          <div className="text-xs text-amber-700">Remaining Rp {available.toLocaleString('id-ID')}</div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
              </>
            )}
            <div className="mt-4 flex justify-end">
              <button onClick={() => setBslPickerPayment(null)} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">
                Skip for now
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
