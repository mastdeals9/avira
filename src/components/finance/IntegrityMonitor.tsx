import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, ShieldCheck, ExternalLink } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { FinancePage } from './FinancePage';
import { FinanceModal } from './FinanceModal';
import { FinanceBadge, FinanceButton } from './FinanceUI';

type IntegrityKey =
  | 'unbalanced_journals'
  | 'duplicate_postings'
  | 'orphan_lines'
  | 'missing_petty_cash_links'
  | 'negative_cash_anomalies';

interface IntegrityMetric {
  key: IntegrityKey;
  label: string;
  viewName: string;
  count: number;
  historicalOnly?: boolean;
}

const INITIAL_METRICS: IntegrityMetric[] = [
  { key: 'unbalanced_journals', label: 'Unbalanced Journals', viewName: 'unbalanced_journal_entries', count: 0 },
  { key: 'duplicate_postings', label: 'Duplicate Postings', viewName: 'duplicate_postings', count: 0 },
  { key: 'orphan_lines', label: 'Orphan Lines', viewName: 'orphan_journal_lines', count: 0 },
  { key: 'missing_petty_cash_links', label: 'Missing Petty Cash Links', viewName: 'missing_petty_cash_links', count: 0 },
  { key: 'negative_cash_anomalies', label: 'Negative Cash Anomalies', viewName: 'negative_cash_anomalies', count: 0 },
];

export function IntegrityMonitor() {
  const [metrics, setMetrics] = useState<IntegrityMetric[]>(INITIAL_METRICS);
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = useState<IntegrityMetric | null>(null);
  const [detailRows, setDetailRows] = useState<Record<string, unknown>[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const results = await Promise.all(
        INITIAL_METRICS.map(async metric => {
          const { count, error: queryError } = await supabase
            .from(metric.viewName)
            .select('*', { count: 'exact', head: true });

          if (queryError) {
            throw new Error(`Failed loading ${metric.label}: ${queryError.message}`);
          }

          let historicalOnly = false;
          if (metric.key === 'negative_cash_anomalies' && (count ?? 0) > 0) {
            const { count: currentDeficitCount } = await supabase
              .from(metric.viewName)
              .select('*', { count: 'exact', head: true })
              .eq('is_current_closing_deficit', true);
            historicalOnly = (currentDeficitCount ?? 0) === 0;
          }

          return { ...metric, count: count ?? 0, historicalOnly };
        })
      );

      setMetrics(results);
      setLastRefreshed(new Date().toISOString());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load integrity checks';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const openDetails = useCallback(async (metric: IntegrityMetric) => {
    if (metric.count === 0) return;
    setSelectedMetric(metric);
    setDetailRows([]);
    setDetailError(null);
    setDetailLoading(true);
    const { data, error: queryError } = await supabase
      .from(metric.viewName)
      .select('*')
      .limit(100);
    if (queryError) {
      setDetailError('Unable to load the underlying records. Please try again.');
    } else {
      setDetailRows((data ?? []) as Record<string, unknown>[]);
    }
    setDetailLoading(false);
  }, []);

  const detailHref = (row: Record<string, unknown>) => {
    const journalId = row.journal_entry_id;
    const pettyCashId = row.petty_cash_transaction_id;
    if (journalId) return `/finance/journal-register?journal=${encodeURIComponent(String(journalId))}`;
    if (pettyCashId) return `/finance/petty-cash?document=${encodeURIComponent(String(pettyCashId))}`;
    return null;
  };

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  return (
    <FinancePage
      title="Integrity Monitor"
      subtitle="Read-only finance integrity checks"
      actions={(
        <FinanceButton
          onClick={loadMetrics}
          disabled={loading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </FinanceButton>
      )}
    >

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Check</th>
              <th className="px-2 py-1.5 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Count</th>
              <th className="px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {metrics.map(metric => {
              const hasIssue = metric.count > 0;
              return (
                <tr key={metric.key}>
                  <td className="px-2 py-1.5 text-sm text-gray-900">
                    {hasIssue ? (
                      <button type="button" onClick={() => openDetails(metric)} className="font-medium text-blue-700 underline-offset-2 hover:underline">
                        {metric.label}
                      </button>
                    ) : metric.label}
                  </td>
                  <td className="px-2 py-1.5 text-right text-sm font-semibold text-gray-900">{metric.count || 'No records found'}</td>
                  <td className="px-2 py-1.5 text-sm">
                    <FinanceBadge status={hasIssue ? (metric.historicalOnly ? 'info' : 'pending') : 'approved'}>
                      {hasIssue ? <AlertTriangle className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
                      {hasIssue
                        ? metric.historicalOnly
                          ? 'Historical warning (closing positive)'
                          : 'Issue detected'
                        : 'No records found'}
                    </FinanceBadge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedMetric && (
        <FinanceModal isOpen title={`${selectedMetric.label} Details`} onClose={() => setSelectedMetric(null)} size="lg">
          {detailLoading && <p className="p-3 text-sm text-gray-500">Loading records…</p>}
          {detailError && <p className="p-3 text-sm text-red-700">{detailError}</p>}
          {!detailLoading && !detailError && detailRows.length === 0 && <p className="p-3 text-sm text-gray-500">No records found</p>}
          {!detailLoading && !detailError && detailRows.length > 0 && (
            <div className="max-h-80 overflow-auto">
              <table className="min-w-full divide-y divide-gray-200 text-xs">
                <thead className="sticky top-0 bg-gray-50"><tr><th className="px-2 py-1 text-left font-medium text-gray-500">Record</th><th className="px-2 py-1 text-left font-medium text-gray-500">Details</th><th className="px-2 py-1 text-left font-medium text-gray-500">Open</th></tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {detailRows.map((row, index) => {
                    const href = detailHref(row);
                    const record = row.entry_number || row.transaction_number || row.journal_entry_id || row.journal_line_id || `Record ${index + 1}`;
                    const summary = row.diagnostic_scope
                      ? `${row.code ?? ''} (${row.diagnostic_scope === 'historical_running_balance_warning' ? 'Historical running-balance event; current closing positive' : 'Current closing deficit'})`
                      : (row.description || row.reference_number || row.source_module || '');
                    return <tr key={String(row.journal_line_id || row.journal_entry_id || row.petty_cash_transaction_id || index)}><td className="px-2 py-1.5 text-gray-900">{String(record)}</td><td className="max-w-xs px-2 py-1.5 text-gray-600">{String(summary)}</td><td className="px-2 py-1.5">{href ? <a href={href} className="inline-flex items-center gap-1 text-blue-700 hover:underline" title="Open underlying record">Open <ExternalLink className="h-3 w-3" /></a> : <span className="text-gray-400">—</span>}</td></tr>;
                  })}
                </tbody>
              </table>
            </div>
          )}
        </FinanceModal>
      )}

      {lastRefreshed && (
        <p className="text-xs text-gray-500">Last refreshed: {new Date(lastRefreshed).toLocaleString()}</p>
      )}
    </FinancePage>
  );
}
