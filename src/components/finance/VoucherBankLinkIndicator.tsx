import React, { useState, useRef, useEffect } from 'react';
import { Link2, Unlink, AlertTriangle, ExternalLink, X } from 'lucide-react';
import { formatCurrency } from '../../utils/currency';
import type { VoucherBankLinkEvaluation } from '../../utils/voucherBankLinks';

export interface VoucherBankLinkIndicatorProps {
  voucherNumber: string;
  evaluation?: VoucherBankLinkEvaluation | null;
  bankAccountId?: string | null;
  onOpenBankReconciliation?: (bankAccountId?: string, statementLineId?: string) => void;
  onDirectLink?: () => void;
  className?: string;
}

export function VoucherBankLinkIndicator({
  voucherNumber,
  evaluation,
  bankAccountId,
  onOpenBankReconciliation,
  onDirectLink,
  className = '',
}: VoucherBankLinkIndicatorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close popover when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const status = evaluation?.status || 'unlinked';
  const ccy = evaluation?.currency || 'IDR';
  const primaryAllocation = evaluation?.allocations?.[0];
  const primaryLine = primaryAllocation?.bank_statement_lines;

  // Build descriptive hover tooltip text
  let hoverTooltip = '';
  if (status === 'unlinked') {
    hoverTooltip = 'Not linked to a bank transaction · Click to check details';
  } else if (status === 'needs_review') {
    hoverTooltip = `Data integrity issue: ${evaluation?.conflictReason || 'Reconciliation data integrity error.'}`;
  } else {
    const isPartial = status === 'partial';
    const amountStr = isPartial
      ? `${formatCurrency(evaluation?.canonicalAmount || 0, ccy)} of ${formatCurrency(evaluation?.expectedAmount || 0, ccy)}`
      : formatCurrency(evaluation?.canonicalAmount || 0, ccy);
    
    hoverTooltip = `${evaluation?.statusLabel || 'Linked'} · ${amountStr}`;
    if (primaryLine) {
      if (primaryLine.transaction_date) {
        hoverTooltip += `\nDate: ${new Date(primaryLine.transaction_date).toLocaleDateString('id-ID')}`;
      }
      if (primaryLine.description) {
        hoverTooltip += `\nDesc: ${primaryLine.description}`;
      }
      const lineAmt = Number(primaryLine.debit_amount || primaryLine.credit_amount || 0);
      if (lineAmt > 0) {
        hoverTooltip += `\nAmount: ${formatCurrency(lineAmt, ccy)}`;
      }
      if (primaryLine.reference) {
        hoverTooltip += `\nRef: ${primaryLine.reference}`;
      }
    }
  }

  // Visual styling mapped to the 4 states (matching Expense Recon icon)
  let iconElement: React.ReactNode;
  let buttonClasses = '';

  switch (status) {
    case 'linked':
      iconElement = <Link2 className="w-3.5 h-3.5 shrink-0" />;
      buttonClasses = 'text-green-700 hover:bg-green-50';
      break;
    case 'partial':
      iconElement = <Link2 className="w-3.5 h-3.5 shrink-0" />;
      buttonClasses = 'text-amber-700 hover:bg-amber-50';
      break;
    case 'needs_review':
      iconElement = <AlertTriangle className="w-3.5 h-3.5 shrink-0" />;
      buttonClasses = 'text-amber-600 hover:bg-amber-50';
      break;
    case 'unlinked':
    default:
      iconElement = <Unlink className="w-3.5 h-3.5 shrink-0" />;
      buttonClasses = 'text-gray-400 hover:text-red-600 hover:bg-red-50';
      break;
  }

  const handleNavigateToBankRecon = () => {
    setIsOpen(false);
    const targetLineId = primaryLine?.id || primaryAllocation?.bank_statement_line_id || evaluation?.legacyLinks?.[0]?.bank_statement_line_id;
    onOpenBankReconciliation?.(bankAccountId || undefined, targetLineId || undefined);
  };

  return (
    <div ref={containerRef} className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        title={hoverTooltip}
        aria-label={`Bank reconciliation status for ${voucherNumber}: ${status}`}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(prev => !prev);
        }}
        className={`no-compact !p-0 inline-flex h-6 w-6 items-center justify-center rounded transition-colors focus:outline-none focus:ring-2 focus:ring-blue-300 ${buttonClasses}`}
      >
        {iconElement}
      </button>

      {/* Interactive popover */}
      {isOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full mt-1 z-50 w-72 max-w-sm rounded-lg bg-white p-3 text-left text-xs shadow-xl ring-1 ring-black/10"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b pb-2 mb-2">
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-semibold text-gray-800">{voucherNumber}</span>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                  status === 'linked'
                    ? 'bg-green-100 text-green-800'
                    : status === 'partial'
                      ? 'bg-yellow-100 text-yellow-800'
                      : status === 'needs_review'
                        ? 'bg-amber-100 text-amber-900 border border-amber-300'
                        : 'bg-gray-100 text-gray-700'
                }`}
              >
                {evaluation?.statusLabel || 'Unlinked'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="text-gray-400 hover:text-gray-600 p-0.5 rounded hover:bg-gray-100"
              title="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Amount summary */}
          <div className="grid grid-cols-2 gap-2 text-[11px] bg-gray-50 rounded p-1.5 mb-2">
            <div>
              <span className="text-gray-500 block">Voucher Amount:</span>
              <span className="font-semibold text-gray-800">
                {formatCurrency(evaluation?.expectedAmount || 0, ccy)}
              </span>
            </div>
            <div>
              <span className="text-gray-500 block">Bank Allocated:</span>
              <span
                className={`font-semibold ${
                  status === 'linked'
                    ? 'text-green-700'
                    : status === 'partial'
                      ? 'text-amber-700'
                      : 'text-gray-700'
                }`}
              >
                {formatCurrency(evaluation?.canonicalAmount || 0, ccy)}
              </span>
            </div>
          </div>

          {/* Needs Review Alert */}
          {status === 'needs_review' && (
            <div className="mb-2 p-2 rounded bg-amber-50 border border-amber-200 text-amber-900 text-[11px] leading-relaxed">
              <div className="flex items-center gap-1 font-semibold text-amber-800 mb-0.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>Link Conflict Detected</span>
              </div>
              <p>{evaluation?.conflictReason}</p>
            </div>
          )}

          {/* Linked transactions list */}
          {evaluation?.allocations && evaluation.allocations.length > 0 ? (
            <div className="space-y-1.5 mb-2 max-h-40 overflow-y-auto">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide block">
                Linked Statement Transactions ({evaluation.allocations.length})
              </span>
              {evaluation.allocations.map((alloc, idx) => {
                const line = alloc.bank_statement_lines;
                const lineAmount = Number(line?.debit_amount || line?.credit_amount || 0);
                return (
                  <div key={alloc.id || idx} className="border border-gray-200 rounded p-1.5 bg-gray-50/50 space-y-0.5 text-[11px]">
                    <div className="flex justify-between items-center font-medium">
                      <span className="text-gray-800">
                        {line?.transaction_date
                          ? new Date(line.transaction_date).toLocaleDateString('id-ID')
                          : 'Date —'}
                      </span>
                      <span className="text-blue-700 font-mono">
                        {formatCurrency(alloc.allocation_amount, ccy)}
                      </span>
                    </div>
                    {line?.description && (
                      <p className="text-gray-600 truncate" title={line.description}>
                        {line.description}
                      </p>
                    )}
                    <div className="flex justify-between text-[10px] text-gray-500">
                      <span>Ref: {line?.reference || '—'}</span>
                      {lineAmount > alloc.allocation_amount && (
                        <span>Line Total: {formatCurrency(lineAmount, ccy)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            status !== 'needs_review' && (
              <div className="py-2 text-center text-gray-500 italic text-xs mb-2">
                No bank statement transaction linked.
              </div>
            )
          )}

          {/* Direct Linking Popup or Action button to Bank Reconciliation */}
          {onDirectLink && status !== 'linked' ? (
            <div className="pt-1.5 border-t border-gray-100">
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  onDirectLink();
                }}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 px-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded shadow-xs transition-colors"
              >
                <Link2 className="w-3.5 h-3.5" />
                <span>Link to Bank Deposit</span>
              </button>
            </div>
          ) : onOpenBankReconciliation ? (
            <div className="pt-1.5 border-t border-gray-100">
              <button
                type="button"
                onClick={handleNavigateToBankRecon}
                className="w-full flex items-center justify-center gap-1.5 py-1 px-2 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded border border-blue-200 transition-colors"
              >
                <span>
                  {status === 'linked' ? 'View in Bank Reconciliation' : 'Go to Bank Reconciliation'}
                </span>
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
