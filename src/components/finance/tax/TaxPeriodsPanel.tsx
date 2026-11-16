import { Fragment, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ChevronDown, ChevronRight, ExternalLink, TrendingUp, TrendingDown, Wallet } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { formatFinancePeriod } from '../../../utils/financePeriod';
import { useFinance } from '../../../contexts/FinanceContext';
import { StatCard, StatCardGrid, SectionCard, StatusChip, EmptyState } from './TaxUI';
import { getEffectiveExpensePostingStates, isEffectiveExpensePosting } from '../../../services/expensePostingLifecycle';

interface Row {
  tax_period_id: string;
  fiscal_year: number;
  period_month: number;
  status: string;
  filing_status: string;
  input_ppn_total: number;
  output_ppn_total: number;
  carry_forward_in: number;
  net_ppn_payable: number;
  carry_forward_out: number;
  payment_due_date: string | null;
  filing_due_date: string | null;
}

interface InputLine {
  source: 'purchase_invoice' | 'expense' | 'broker' | 'pib';
  doc_number: string;
  doc_date: string;
  party: string;
  description: string | null;
  ppn_amount: number;
  tax_period_id: string;
  id: string;
}

interface OutputLine {
  source: 'sales_invoice' | 'credit_note' | 'nota_retur';
  doc_number: string;
  doc_date: string;
  customer: string;
  ppn_amount: number;
  faktur_number: string | null;
  id: string;
}

interface TaxPeriodOption {
  id: string;
  fiscal_year: number;
  period_month: number;
  status: string;
  filing_status: string;
}

function fmt(n: number) { return Number(n).toLocaleString('id-ID'); }
function fmtDate(s: string) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Mirror compute_period_ppn EXACTLY so the listed documents
// sum to the engine's input_ppn_total / output_ppn_total. Attribution is by
// tax_period_id (the same key the engine uses), NOT by date. Input PPN =
// purchase_invoices + finance_expenses.ppn_amount (rows WITHOUT broker PPN) +
// broker_items[].ppn_amount + pib_ppn_amount. Output PPN = sales_invoices −
// approved credit_notes − approved/submitted nota_retur (deduplicated against linked credit notes).
async function loadDetail(row: Row): Promise<{ input: InputLine[]; output: OutputLine[] }> {
  const periodId = row.tax_period_id;

  const [piRes, feRes, siRes, cnRes, nrRes] = await Promise.all([
    supabase
      .from('purchase_invoices')
      .select('id, invoice_number, invoice_date, tax_amount, suppliers:supplier_id(company_name), notes')
      .eq('tax_period_id', periodId)
      .gt('tax_amount', 0),
    supabase
      .from('finance_expenses')
      .select('id, voucher_number, expense_date, ppn_amount, pib_ppn_amount, broker_items, suppliers:supplier_id(company_name), description')
      .eq('tax_period_id', periodId),
    supabase
      .from('sales_invoices')
      .select('id, invoice_number, invoice_date, tax_amount, customers:customer_id(company_name), faktur_pajak_number, document_status, cancelled_at')
      .eq('tax_period_id', periodId)
      .gt('tax_amount', 0)
      .neq('document_status', 'cancelled')
      .is('cancelled_at', null),
    supabase
      .from('credit_notes')
      .select('id, credit_note_number, credit_note_date, tax_amount, customers:customer_id(company_name), nota_retur_id')
      .eq('tax_period_id', periodId)
      .eq('status', 'approved')
      .gt('tax_amount', 0),
    supabase
      .from('nota_retur')
      .select('id, nota_retur_number, return_date, ppn_amount, customer_name, customers:customer_id(company_name), original_faktur_pajak_number, credit_note_id')
      .eq('tax_period_id', periodId)
      .in('status', ['submitted', 'approved'])
      .gt('ppn_amount', 0),
  ]);

  const input: InputLine[] = [
    ...((piRes.data ?? []) as any[]).map(r => ({
      source: 'purchase_invoice' as const,
      id: r.id,
      doc_number: r.invoice_number ?? '—',
      doc_date: r.invoice_date,
      party: r.suppliers?.company_name ?? '—',
      description: r.notes,
      ppn_amount: Number(r.tax_amount),
      tax_period_id: periodId,
    })),
  ];

  const expenseStates = await getEffectiveExpensePostingStates(((feRes.data ?? []) as any[]).map(expense => expense.id));
  const effectiveExpenseRows = ((feRes.data ?? []) as any[])
    .filter(expense => isEffectiveExpensePosting(expenseStates.get(expense.id)?.effective_posting_state));

  // finance_expenses: broker-line PPN and PIB PPN are additive; the regular
  // ppn_amount is counted ONLY on rows that carry no broker-line PPN (exactly
  // the engine's NOT EXISTS guard), to avoid double-counting.
  for (const r of effectiveExpenseRows) {
    const brokerItems: any[] = Array.isArray(r.broker_items) ? r.broker_items : [];
    const hasBrokerPpn = brokerItems.some(it => Number(it?.ppn_amount ?? 0) > 0);
    const supplier = r.suppliers?.company_name ?? '—';

    if (!hasBrokerPpn && Number(r.ppn_amount) > 0) {
      input.push({
        source: 'expense',
        id: r.id,
        doc_number: r.voucher_number ?? '—',
        doc_date: r.expense_date,
        party: supplier,
        description: r.description,
        ppn_amount: Number(r.ppn_amount),
        tax_period_id: periodId,
      });
    }

    brokerItems.forEach((it, idx) => {
      const amt = Number(it?.ppn_amount ?? 0);
      if (amt > 0) {
        input.push({
          source: 'broker',
          id: `${r.id}-broker-${idx}`,
          doc_number: r.voucher_number ?? '—',
          doc_date: r.expense_date,
          party: supplier,
          description: it?.description ?? r.description,
          ppn_amount: amt,
          tax_period_id: periodId,
        });
      }
    });

    if (Number(r.pib_ppn_amount) > 0) {
      input.push({
        source: 'pib',
        id: `${r.id}-pib`,
        doc_number: r.voucher_number ?? '—',
        doc_date: r.expense_date,
        party: supplier,
        description: r.description,
        ppn_amount: Number(r.pib_ppn_amount),
        tax_period_id: periodId,
      });
    }
  }

  const approvedNrCnIds = new Set(((nrRes.data ?? []) as any[]).map(nr => nr.credit_note_id).filter(Boolean));

  const output: OutputLine[] = [
    ...((siRes.data ?? []) as any[])
      .filter(r => r.document_status !== 'cancelled' && !r.cancelled_at)
      .map(r => ({
      source: 'sales_invoice' as const,
      id: r.id,
      doc_number: r.invoice_number ?? '—',
      doc_date: r.invoice_date,
      customer: r.customers?.company_name || '—',
      ppn_amount: Number(r.tax_amount),
      faktur_number: r.faktur_pajak_number ?? null,
    })),
    // Approved credit notes reduce Output PPN — deduplicated against linked Nota Retur
    ...((cnRes.data ?? []) as any[])
      .filter(r => !r.nota_retur_id && !approvedNrCnIds.has(r.id))
      .map(r => ({
        source: 'credit_note' as const,
        id: r.id,
        doc_number: r.credit_note_number ?? '—',
        doc_date: r.credit_note_date,
        customer: r.customers?.company_name || r.customers?.customer_name || '—',
        ppn_amount: -Number(r.tax_amount),
        faktur_number: null,
      })),
    // Approved/submitted Nota Retur reduces Output PPN
    ...((nrRes.data ?? []) as any[]).map(r => ({
      source: 'nota_retur' as const,
      id: r.id,
      doc_number: r.nota_retur_number ?? '—',
      doc_date: r.return_date,
      customer: r.customer_name || r.customers?.company_name || '—',
      ppn_amount: -Number(r.ppn_amount),
      faktur_number: r.original_faktur_pajak_number ?? null,
    })),
  ];

  return { input, output };
}

export function TaxPeriodsPanel() {
  const { dateRange } = useFinance();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ input: InputLine[]; output: OutputLine[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [periodOptions, setPeriodOptions] = useState<TaxPeriodOption[]>([]);
  const [editingDocumentId, setEditingDocumentId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    const { data, error } = await supabase
      .from('vw_ppn_net_by_period')
      .select('*')
      .order('fiscal_year', { ascending: false })
      .order('period_month', { ascending: false })
      .limit(120);
    if (!error && data) setRows(data as Row[]);
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.from('tax_periods')
        .select('id, fiscal_year, period_month, status, filing_status')
        .eq('tax_type', 'PPN')
        .order('fiscal_year', { ascending: false })
        .order('period_month', { ascending: false });
      setPeriodOptions((data as TaxPeriodOption[] | null) ?? []);
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
      input: a.input + Number(r.input_ppn_total || 0),
      output: a.output + Number(r.output_ppn_total || 0),
      net: a.net + Number(r.net_ppn_payable || 0),
      cfOut: a.cfOut + Number(r.carry_forward_out || 0),
    }),
    { input: 0, output: 0, net: 0, cfOut: 0 },
  ), [filtered]);

  async function recompute(id: string) {
    setBusyId(id);
    try {
      const { error } = await supabase.rpc('compute_period_ppn', { p_period_id: id });
      if (error) throw error;
      await refresh();
    } catch (err) {
      alert('Recompute failed: ' + (err as Error).message);
    } finally {
      setBusyId(null);
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
      const d = await loadDetail(row);
      setDetail(d);
    } finally {
      setDetailLoading(false);
    }
  }

  async function saveDocumentPeriod(source: InputLine['source'] | OutputLine['source'], id: string, taxPeriodId: string) {
    if (source === 'broker' || source === 'pib') return;
    setEditingDocumentId(id);
    try {
      if (source === 'nota_retur') {
        const { error } = await supabase.from('nota_retur').update({ tax_period_id: taxPeriodId }).eq('id', id);
        if (error) throw error;
      } else {
        const pSource = source === 'expense' ? 'finance_expense_ppn' : source;
        const { error } = await supabase.rpc('reassign_tax_document_period', {
          p_source: pSource,
          p_document_id: id,
          p_tax_period_id: taxPeriodId,
        });
        if (error) throw error;
      }
      await refresh();
      setExpandedId(null);
      setDetail(null);
    } catch (error) {
      alert('Tax period update failed: ' + (error as Error).message);
    } finally {
      setEditingDocumentId(null);
    }
  }

  function periodEditor(source: InputLine['source'] | OutputLine['source'], id: string, currentPeriodId: string, locked: boolean) {
    if (source === 'broker' || source === 'pib') return <span className="text-gray-400">Same as expense</span>;
    return (
      <select name="period_id"
        aria-label="Tax period"
        value={currentPeriodId}
        disabled={locked || editingDocumentId === id}
        onClick={event => event.stopPropagation()}
        onChange={event => void saveDocumentPeriod(source, id, event.target.value)}
        className="max-w-28 rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] disabled:opacity-50"
      >
        {periodOptions.map(period => (
          <option key={period.id} value={period.id} disabled={period.status === 'closed' || period.status === 'filed' || period.filing_status === 'filed'}>
            {formatFinancePeriod(period.fiscal_year, period.period_month)}{period.status === 'closed' || period.status === 'filed' || period.filing_status === 'filed' ? ' (locked)' : ''}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500 hidden md:inline">
          {dateRange?.startDate ?? '—'} → {dateRange?.endDate ?? '—'}
        </span>
      </div>

      {!loading && filtered.length > 0 && (
        <StatCardGrid cols={4}>
          <StatCard label="Input PPN (Masukan)" value={totals.input} tone="red" icon={<TrendingDown className="w-4 h-4" />} hint="Tax credit on purchases/imports" />
          <StatCard label="Output PPN (Keluaran)" value={totals.output} tone="green" icon={<TrendingUp className="w-4 h-4" />} hint="Collected on sales, net of credit notes" />
          <StatCard label="Net PPN Payable" value={totals.net} tone="blue" icon={<Wallet className="w-4 h-4" />} hint="Across periods in range" />
          <StatCard label="Carry Forward Out" value={totals.cfOut} tone="gray" hint="Excess input carried to next period" />
        </StatCardGrid>
      )}

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <SectionCard>
          <EmptyState
            title="No PPN periods in the selected date range"
            hint="Periods are created automatically when a Sales Invoice, Purchase Invoice, or Expense with PPN is posted. Try widening the date range."
          />
        </SectionCard>
      ) : (
        <SectionCard>
          <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-2.5 py-1.5 w-6"></th>
                <th className="text-left px-2.5 py-1.5">Period</th>
                <th className="text-left px-2.5 py-1.5">Status</th>
                <th className="text-right px-2.5 py-1.5">Input PPN</th>
                <th className="text-right px-2.5 py-1.5">Output PPN</th>
                <th className="text-right px-2.5 py-1.5">Carry Fwd In</th>
                <th className="text-right px-2.5 py-1.5">Net Payable</th>
                <th className="text-right px-2.5 py-1.5">Carry Fwd Out</th>
                <th className="px-2.5 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const isOpen = expandedId === r.tax_period_id;
                return (
                  <Fragment key={r.tax_period_id}>
                    <tr
                      key={r.tax_period_id}
                      className={`border-t cursor-pointer select-none ${isOpen ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                      onClick={() => void toggleExpand(r)}
                    >
                      <td className="px-2.5 py-1.5 text-gray-400">
                        {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </td>
                      <td className="px-2.5 py-1.5 font-medium">{formatFinancePeriod(r.fiscal_year, r.period_month)}</td>
                      <td className="px-2.5 py-1.5"><StatusChip status={r.status} /></td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-red-700">{fmt(r.input_ppn_total)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-green-700">{fmt(r.output_ppn_total)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{fmt(r.carry_forward_in)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums font-semibold">Rp {fmt(r.net_ppn_payable)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{fmt(r.carry_forward_out)}</td>
                      <td className="px-2.5 py-1.5 text-right" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => void recompute(r.tax_period_id)}
                          disabled={busyId === r.tax_period_id || r.status === 'closed'}
                          className="text-[11px] px-1.5 py-0.5 border rounded hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-1"
                        >
                          <RefreshCw className={`w-3 h-3 ${busyId === r.tax_period_id ? 'animate-spin' : ''}`} />
                          Recompute
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${r.tax_period_id}-detail`} className="bg-blue-50/40">
                        <td colSpan={9} className="px-4 pb-4 pt-1">
                          {detailLoading ? (
                            <p className="text-xs text-gray-500 py-2">Loading source documents…</p>
                          ) : detail ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              {/* Input PPN */}
                              <div>
                                <h4 className="text-xs font-semibold text-red-700 mb-1 uppercase tracking-wide">
                                  Input PPN — {detail.input.length} documents
                                </h4>
                                {detail.input.length === 0 ? (
                                  <p className="text-xs text-gray-400">No input PPN documents this period.</p>
                                ) : (
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-gray-500 border-b">
                                        <th className="text-left py-1">Doc</th>
                                        <th className="text-left py-1">Date</th>
                                        <th className="text-left py-1">Supplier</th>
                                        <th className="text-left py-1">Tax Period</th>
                                        <th className="text-right py-1">PPN</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {detail.input.map(l => (
                                        <tr key={l.id} className="border-b border-gray-100">
                                          <td className="py-1 pr-2 font-mono">
                                            <span className="text-[10px] text-gray-400 mr-1">
                                              {l.source === 'purchase_invoice' ? 'PI'
                                                : l.source === 'broker' ? 'BRK'
                                                : l.source === 'pib' ? 'PIB'
                                                : 'EXP'}
                                            </span>
                                            {l.doc_number}
                                          </td>
                                          <td className="py-1 pr-2 whitespace-nowrap">{fmtDate(l.doc_date)}</td>
                                          <td className="py-1 pr-2 text-gray-600 max-w-[140px] truncate" title={l.party}>{l.party}</td>
                                          <td className="py-1 pr-2">{periodEditor(l.source, l.id, l.tax_period_id, r.status === 'closed' || r.status === 'filed' || r.filing_status === 'filed')}</td>
                                          <td className="py-1 text-right text-red-700 font-mono">{fmt(l.ppn_amount)}</td>
                                        </tr>
                                      ))}
                                      <tr className="font-semibold">
                                        <td colSpan={4} className="py-1 text-right text-xs text-gray-500">Total Input PPN</td>
                                        <td className="py-1 text-right text-red-700 font-mono">
                                          {fmt(detail.input.reduce((s, l) => s + l.ppn_amount, 0))}
                                        </td>
                                      </tr>
                                    </tbody>
                                  </table>
                                )}
                              </div>
                              {/* Output PPN */}
                              <div>
                                <h4 className="text-xs font-semibold text-green-700 mb-1 uppercase tracking-wide">
                                  Output PPN — {detail.output.length} documents
                                </h4>
                                {detail.output.length === 0 ? (
                                  <p className="text-xs text-gray-400">No output PPN documents this period.</p>
                                ) : (
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-gray-500 border-b">
                                        <th className="text-left py-1">Invoice</th>
                                        <th className="text-left py-1">Date</th>
                                        <th className="text-left py-1">Customer</th>
                                        <th className="text-left py-1">Faktur</th>
                                        <th className="text-left py-1">Tax Period</th>
                                        <th className="text-right py-1">PPN</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {detail.output.map(l => (
                                        <tr key={l.id} className="border-b border-gray-100">
                                          <td className="py-1 pr-2 font-mono">
                                            {l.source === 'credit_note' && (
                                              <span className="text-[10px] text-red-500 mr-1">CN</span>
                                            )}
                                            {l.source === 'nota_retur' && (
                                              <span className="text-[10px] text-amber-600 mr-1">NR</span>
                                            )}
                                            {l.doc_number}
                                          </td>
                                          <td className="py-1 pr-2 whitespace-nowrap">{fmtDate(l.doc_date)}</td>
                                          <td className="py-1 pr-2 text-gray-600 max-w-[120px] truncate" title={l.customer}>{l.customer}</td>
                                          <td className="py-1 pr-2">
                                            {l.source === 'credit_note'
                                              ? <span className="text-red-500 text-[10px]">Reversal</span>
                                              : l.source === 'nota_retur'
                                                ? <span className="text-amber-600 font-mono text-[10px]">{l.faktur_number ? `Retur FP: ${l.faktur_number}` : 'Nota Retur'}</span>
                                                : l.faktur_number
                                                  ? <span className="text-green-700 font-mono">{l.faktur_number}</span>
                                                  : <span className="text-orange-500 text-[10px]">Waiting for Faktur</span>}
                                          </td>
                                          <td className="py-1 pr-2">{periodEditor(l.source, l.id, r.tax_period_id, r.status === 'closed' || r.status === 'filed' || r.filing_status === 'filed')}</td>
                                          <td className={`py-1 text-right font-mono ${l.ppn_amount < 0 ? 'text-red-600' : 'text-green-700'}`}>{fmt(l.ppn_amount)}</td>
                                        </tr>
                                      ))}
                                      <tr className="font-semibold">
                                        <td colSpan={5} className="py-1 text-right text-xs text-gray-500">Total Output PPN</td>
                                        <td className="py-1 text-right text-green-700 font-mono">
                                          {fmt(detail.output.reduce((s, l) => s + l.ppn_amount, 0))}
                                        </td>
                                      </tr>
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            </div>
                          ) : null}
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
