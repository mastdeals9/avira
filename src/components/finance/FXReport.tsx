import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { 
  DollarSign, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownLeft, 
  Calendar, Download, Search, AlertCircle, RefreshCw, Layers, Building2, User,
  FileText, ExternalLink, CheckCircle2
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { sanitizeExportRows } from '../../utils/csvSafe';
import { useFinance } from '../../contexts/FinanceContext';
import {
  fetchAllPages,
  summarizePostedGlFx,
  computeSupplierSettlementBridge,
  type RevaluationLineRef,
} from '../../utils/fxReportCalculations';

interface SupplierFxLine {
  id: string;
  payment_date: string;
  voucher_number: string;
  voucher_id: string;
  supplier_id: string | null;
  supplier_name: string;
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  invoice_total_usd: number;
  recognition_rate: number;
  original_idr_carrying: number;
  usd_settled: number;
  settlement_rate: number;
  is_usd_bank_settlement: boolean;
  prior_revaluation_fx: number;
  carrying_before_settlement_idr: number;
  actual_idr_paid: number;
  carrying_idr_settled: number;
  fx_gain_loss: number; // realized FX on settlement: positive = loss, negative = gain
  cumulative_historical_rate_variance: number; // analytical: actual_idr_paid - original carrying settled
  bank_charge: number;
  bank_account_name: string;
  journal_entry_id: string | null;
  journal_entry_number: string | null;
  fx_journal_id?: string | null;
  fx_journal_number?: string | null;
}

interface CustomerFxLine {
  id: string;
  receipt_date: string;
  voucher_number: string;
  voucher_id: string;
  customer_id: string | null;
  customer_name: string;
  invoice_id: string;
  invoice_number: string;
  invoice_total_usd: number;
  recognition_rate: number;
  original_idr_carrying: number;
  usd_received: number;
  receipt_rate: number;
  actual_idr_received: number;
  carrying_idr_settled: number;
  fx_gain_loss: number; // positive = gain, negative = loss
  bank_charge: number;
  bank_account_name: string;
  journal_entry_id: string | null;
  journal_entry_number: string | null;
}

interface OpenExposureLine {
  type: 'supplier_payable' | 'customer_receivable';
  party_id: string | null;
  party_name: string;
  document_id: string;
  document_number: string;
  document_date: string;
  original_usd: number;
  recognition_rate: number;
  original_idr: number;
  usd_settled: number;
  usd_remaining: number;
  carrying_idr_remaining: number;
  current_rate: number;
  unrealized_fx: number;
}

interface PostedGlFxLine {
  id: string;
  journal_entry_id: string;
  entry_number: string;
  entry_date: string;
  reference_number: string | null;
  account_code: string;
  account_name: string;
  debit: number;
  credit: number;
  description: string;
  is_revaluation: boolean;
  revaluation_number?: string | null;
}

interface MonthFxSummary {
  month_key: string;
  supplier_fx_gain: number;
  supplier_fx_loss: number;
  customer_fx_gain: number;
  customer_fx_loss: number;
  net_realized_fx: number;
  unrealized_fx: number;
  total_fx_impact: number;
}

interface PartyFxSummary {
  party_name: string;
  usd_volume: number;
  usd_settled: number;
  recognition_idr: number;
  settlement_idr: number;
  fx_gain: number;
  fx_loss: number;
  net_fx: number;
}

interface FXReportProps {
  onViewInvoice?: (invoiceId: string) => void;
  onViewJournal?: (journalId: string) => void;
  onSwitchToCommercialDashboard?: () => void;
}

const fmt = (n: number) => n.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmt2 = (n: number) => n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export function FXReport({ onViewInvoice, onViewJournal, onSwitchToCommercialDashboard }: FXReportProps) {
  const { dateRange } = useFinance();
  const [activeTab, setActiveTab] = useState<'summary' | 'supplier' | 'customer' | 'exposure' | 'monthly' | 'by_supplier' | 'posted_gl' | 'revaluations'>('summary');
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [manualMarketRate, setManualMarketRate] = useState<string>('');
  const [latestPostedRevalRate, setLatestPostedRevalRate] = useState<number | null>(null);

  const [supplierLines, setSupplierLines] = useState<SupplierFxLine[]>([]);
  const [customerLines, setCustomerLines] = useState<CustomerFxLine[]>([]);
  const [openExposures, setOpenExposures] = useState<OpenExposureLine[]>([]);
  const [postedGlLines, setPostedGlLines] = useState<PostedGlFxLine[]>([]);
  const [revaluationsList, setRevaluationsList] = useState<any[]>([]);
  const [showRevalModal, setShowRevalModal] = useState(false);
  const [revalDate, setRevalDate] = useState('2026-11-30');
  const [revalRate, setRevalRate] = useState('18200');
  const [revalSource, setRevalSource] = useState('Bank Indonesia JISDOR');
  const [revalRunning, setRevalRunning] = useState(false);
  const [revalFeedback, setRevalFeedback] = useState<any>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const startDate = dateRange?.startDate || '2025-01-01';
      const endDate = dateRange?.endDate || '2026-12-31';

      // 1. Fetch Revaluations Audit Trail FIRST (paginated)
      let revDataList: any[] = [];
      try {
        revDataList = await fetchAllPages<any>((from, to) =>
          supabase
            .from('fx_revaluations')
            .select(`
              id, revaluation_number, revaluation_date, period_name, currency, closing_rate,
              rate_source, total_gain_loss, status, journal_entry_id, created_at,
              journal_entries(entry_number, description),
              fx_revaluation_lines(
                id, purchase_invoice_id, line_type, foreign_amount, carrying_rate, carrying_amount_idr,
                revalued_rate, revalued_amount_idr, fx_difference, gain_loss_type,
                purchase_invoices(invoice_number),
                bank_accounts(account_name)
              )
            `)
            .order('revaluation_date', { ascending: false })
            .range(from, to)
        );
        setRevaluationsList(revDataList);
      } catch (revErr) {
        console.warn('Could not fetch fx_revaluations:', revErr);
      }

      const revalJeMap = new Map<string, string>();
      const piRevalLinesMap = new Map<string, RevaluationLineRef[]>();
      let latestPostedRate: number | null = null;

      for (const rev of revDataList) {
        if (rev.status === 'posted') {
          if (rev.journal_entry_id) {
            revalJeMap.set(rev.journal_entry_id, rev.revaluation_number);
          }
          if (latestPostedRate === null && (!rev.revaluation_date || rev.revaluation_date.slice(0, 10) <= endDate)) {
            latestPostedRate = Number(rev.closing_rate || 0) || null;
          }
          for (const rl of rev.fx_revaluation_lines || []) {
            if (rl.purchase_invoice_id) {
              const list = piRevalLinesMap.get(rl.purchase_invoice_id) || [];
              list.push({
                revaluation_date: rev.revaluation_date,
                status: rev.status,
                purchase_invoice_id: rl.purchase_invoice_id,
                line_type: rl.line_type,
                foreign_amount: Number(rl.foreign_amount || 0),
                carrying_rate: Number(rl.carrying_rate || 0),
                revalued_rate: Number(rl.revalued_rate || 0),
                fx_difference: Number(rl.fx_difference || 0),
                gain_loss_type: rl.gain_loss_type,
              });
              piRevalLinesMap.set(rl.purchase_invoice_id, list);
            }
          }
        }
      }
      setLatestPostedRevalRate(latestPostedRate);

      // 2. Fetch USD Purchase Invoices (paginated)
      const piData = await fetchAllPages<any>((from, to) =>
        supabase
          .from('purchase_invoices')
          .select(`
            id, invoice_number, invoice_date, currency, exchange_rate, total_amount, paid_amount, balance_amount, status,
            suppliers(id, company_name)
          `)
          .eq('currency', 'USD')
          .order('invoice_date', { ascending: true })
          .range(from, to)
      );

      // 3. Fetch ALL posted Payment Vouchers (paginated; both IDR-bank FX conversions AND USD-bank settlements)
      const pvData = await fetchAllPages<any>((from, to) =>
        supabase
          .from('payment_vouchers')
          .select(`
            id, voucher_number, voucher_date, payment_currency, exchange_rate, amount,
            converted_amount, actual_bank_debit, bank_amount, bank_charge, is_posted, journal_entry_id,
            bank_accounts(bank_name, account_name, account_number, currency),
            journal_entries(id, entry_number)
          `)
          .eq('is_posted', true)
          .order('voucher_date', { ascending: true })
          .range(from, to)
      );

      // 4. Fetch Voucher Allocations (paginated)
      const pageSize = 1000;
      const allocData = await fetchAllPages<any>((from, to) =>
        supabase
          .from('voucher_allocations')
          .select('id, allocated_amount, allocated_currency, purchase_invoice_id, payment_voucher_id, sales_invoice_id, receipt_voucher_id')
          .range(from, to)
      );

      // 5. Fetch Posted, Non-Reversed, Non-Cancelled GL lines for FX accounts 7300 and 4930 (paginated + date filtered)
      const glLines: PostedGlFxLine[] = [];
      const pvRefToFxJeMap = new Map<string, { id: string; entry_number: string; amount: number; account_code: string }>();

      const { data: coaData } = await supabase
        .from('chart_of_accounts')
        .select('id, code, name')
        .in('code', ['7300', '4930']);

      const fxCoaMap = new Map<string, { code: string; name: string }>();
      (coaData || []).forEach(c => fxCoaMap.set(c.id, { code: c.code, name: c.name }));

      if (coaData && coaData.length > 0) {
        const coaIds = coaData.map(c => c.id);
        const jeLines: any[] = [];
        let jeFrom = 0;
        while (true) {
          const { data: page, error: jelErr } = await supabase
            .from('journal_entry_lines')
            .select('id, journal_entry_id, account_id, debit, credit, description')
            .in('account_id', coaIds)
            .range(jeFrom, jeFrom + pageSize - 1);
          if (jelErr) throw jelErr;
          if (!page || page.length === 0) break;
          jeLines.push(...page);
          if (page.length < pageSize) break;
          jeFrom += pageSize;
        }

        if (jeLines.length > 0) {
          const jeIds = Array.from(new Set(jeLines.map(l => l.journal_entry_id)));
          const jeMap = new Map<string, any>();
          for (let i = 0; i < jeIds.length; i += 200) {
            const chunk = jeIds.slice(i, i + 200);
            const { data: jes, error: jesErr } = await supabase
              .from('journal_entries')
              .select('id, entry_number, entry_date, reference_number, description, is_posted, is_reversed, is_cancelled')
              .in('id', chunk)
              .eq('is_posted', true)
              .eq('is_reversed', false)
              .eq('is_cancelled', false)
              .gte('entry_date', startDate)
              .lte('entry_date', endDate);
            if (jesErr) throw jesErr;
            for (const j of jes || []) jeMap.set(j.id, j);
          }

          for (const line of jeLines) {
            const coa = fxCoaMap.get(line.account_id);
            const je = jeMap.get(line.journal_entry_id);
            if (!coa || !je) continue;

            const revalNum = revalJeMap.get(je.id) || null;
            glLines.push({
              id: line.id,
              journal_entry_id: je.id,
              entry_number: je.entry_number,
              entry_date: je.entry_date,
              reference_number: je.reference_number || null,
              account_code: coa.code,
              account_name: coa.name,
              debit: Number(line.debit || 0),
              credit: Number(line.credit || 0),
              description: line.description || je.description || '',
              is_revaluation: revalJeMap.has(je.id),
              revaluation_number: revalNum,
            });

            if (je.reference_number) {
              const netAmt = coa.code === '7300'
                ? Number(line.debit || 0) - Number(line.credit || 0)
                : Number(line.credit || 0) - Number(line.debit || 0);
              const rawRef = je.reference_number.trim();
              const baseRef = rawRef.replace(/-CORR$/i, '');
              const entry = {
                id: je.id,
                entry_number: je.entry_number,
                amount: netAmt,
                account_code: coa.code,
              };
              pvRefToFxJeMap.set(rawRef, entry);
              if (baseRef !== rawRef && !pvRefToFxJeMap.has(baseRef)) {
                pvRefToFxJeMap.set(baseRef, entry);
              }
            }
          }
        }
      }

      glLines.sort((a, b) => new Date(b.entry_date).getTime() - new Date(a.entry_date).getTime());
      setPostedGlLines(glLines);

      // Build Fast Lookup Maps
      const piMap = new Map<string, any>((piData || []).map(p => [p.id, p]));
      const pvMap = new Map<string, any>((pvData || []).map(p => [p.id, p]));

      // 6. Build Supplier FX Detail rows with Settlement Bridge
      const sLines: SupplierFxLine[] = [];
      for (const alloc of allocData) {
        if (!alloc.purchase_invoice_id || !alloc.payment_voucher_id) continue;
        const pv = pvMap.get(alloc.payment_voucher_id);
        const pi = piMap.get(alloc.purchase_invoice_id);
        if (!pv || !pi) continue;

        if (pv.voucher_date < startDate || pv.voucher_date > endDate) continue;

        const usdSettled = Number(alloc.allocated_amount || 0);
        const piRecRate = Number(pi.exchange_rate || 0);
        const pvSettleRate = Number(pv.exchange_rate || 1);
        const bankObj: any = Array.isArray(pv.bank_accounts) ? pv.bank_accounts[0] : pv.bank_accounts;
        const isUsdBank = (bankObj?.currency || '').toUpperCase() === 'USD';

        const fxJe = pvRefToFxJeMap.get(pv.voucher_number.trim());
        // For USD-bank settlements (e.g. PV/25-26/003 -> JE2611-0313), derive functional IDR bank outflow
        // from the linked FX journal when pv.exchange_rate <= 1, never assuming bank rate == PI rate.
        let actualFunctionalIdr: number | null = null;
        if (isUsdBank && pvSettleRate <= 1 && fxJe) {
          const preBridge = computeSupplierSettlementBridge({
            usdSettled,
            originalPiRate: piRecRate,
            settlementRate: pvSettleRate,
            settlementDate: pv.voucher_date,
            isUsdBankSettlement: true,
            priorRevalLines: piRevalLinesMap.get(pi.id) || [],
          });
          // 7300 debit = loss (outflow > carrying); 4930 credit = gain (outflow < carrying)
          actualFunctionalIdr =
            fxJe.account_code === '7300'
              ? preBridge.carrying_before_settlement_idr + fxJe.amount
              : preBridge.carrying_before_settlement_idr - fxJe.amount;
        }

        const bridge = computeSupplierSettlementBridge({
          usdSettled,
          originalPiRate: piRecRate,
          settlementRate: pvSettleRate,
          settlementDate: pv.voucher_date,
          isUsdBankSettlement: isUsdBank,
          priorRevalLines: piRevalLinesMap.get(pi.id) || [],
          actualFunctionalSettlementIdr: actualFunctionalIdr,
        });

        const suppObj: any = Array.isArray(pi.suppliers) ? pi.suppliers[0] : pi.suppliers;
        const bankDisplay = bankObj
          ? `${bankObj.account_name || bankObj.bank_name || 'Bank'} (${bankObj.currency || 'IDR'})`
          : 'Bank';

        const jeObj: any = Array.isArray(pv.journal_entries) ? pv.journal_entries[0] : pv.journal_entries;
        const derivedSettleRate =
          isUsdBank && pvSettleRate <= 1 && usdSettled > 0
            ? Math.round((bridge.actual_settlement_idr / usdSettled) * 100) / 100
            : pvSettleRate;

        sLines.push({
          id: alloc.id,
          payment_date: pv.voucher_date,
          voucher_number: pv.voucher_number,
          voucher_id: pv.id,
          supplier_id: suppObj?.id || null,
          supplier_name: suppObj?.company_name || 'Supplier',
          invoice_id: pi.id,
          invoice_number: pi.invoice_number,
          invoice_date: pi.invoice_date,
          invoice_total_usd: Number(pi.total_amount || 0),
          recognition_rate: piRecRate,
          original_idr_carrying: Number(pi.total_amount || 0) * piRecRate,
          usd_settled: usdSettled,
          settlement_rate: derivedSettleRate,
          is_usd_bank_settlement: isUsdBank,
          prior_revaluation_fx: bridge.prior_revaluation_fx,
          carrying_before_settlement_idr: bridge.carrying_before_settlement_idr,
          actual_idr_paid: bridge.actual_settlement_idr,
          carrying_idr_settled: bridge.carrying_before_settlement_idr,
          fx_gain_loss: bridge.realized_fx_on_settlement,
          cumulative_historical_rate_variance: bridge.cumulative_historical_rate_variance,
          bank_charge: Number(pv.bank_charge || 0),
          bank_account_name: bankDisplay,
          journal_entry_id: jeObj?.id || pv.journal_entry_id || null,
          journal_entry_number: jeObj?.entry_number || null,
          fx_journal_id: fxJe?.id || null,
          fx_journal_number: fxJe?.entry_number || null,
        });
      }

      sLines.sort((a, b) => new Date(a.payment_date).getTime() - new Date(b.payment_date).getTime());
      setSupplierLines(sLines);

      // 7. Open USD Exposure as of endDate (using carrying rate after prior posted revaluations; no hardcoded 17800)
      const parsedManualRate = parseFloat(manualMarketRate.replace(/,/g, ''));
      const effectiveValuationRate = !isNaN(parsedManualRate) && parsedManualRate > 0 ? parsedManualRate : latestPostedRate;

      const settledAsOfEndMap = new Map<string, number>();
      for (const alloc of allocData) {
        if (!alloc.purchase_invoice_id || !alloc.payment_voucher_id) continue;
        const pv = pvMap.get(alloc.payment_voucher_id);
        if (!pv || pv.voucher_date > endDate) continue;
        settledAsOfEndMap.set(
          alloc.purchase_invoice_id,
          (settledAsOfEndMap.get(alloc.purchase_invoice_id) || 0) + Number(alloc.allocated_amount || 0)
        );
      }

      const exposures: OpenExposureLine[] = [];
      for (const pi of piData || []) {
        if (pi.invoice_date > endDate) continue;
        const settledAsOf = settledAsOfEndMap.get(pi.id) || 0;
        const balanceUsd = Math.max(0, Number(pi.total_amount || 0) - settledAsOf);
        if (balanceUsd > 0.001) {
          const recRate = Number(pi.exchange_rate || 0);
          const bridgeAsOf = computeSupplierSettlementBridge({
            usdSettled: balanceUsd,
            originalPiRate: recRate,
            settlementRate: effectiveValuationRate || recRate,
            settlementDate: endDate,
            isUsdBankSettlement: false,
            priorRevalLines: piRevalLinesMap.get(pi.id) || [],
          });
          const carryingRateEff = bridgeAsOf.effective_carrying_rate_before_settlement;
          const carryingRemaining = bridgeAsOf.carrying_before_settlement_idr;
          const valRate = effectiveValuationRate || carryingRateEff;
          const unrealized = balanceUsd * (valRate - carryingRateEff);
          const suppObj: any = Array.isArray(pi.suppliers) ? pi.suppliers[0] : pi.suppliers;

          exposures.push({
            type: 'supplier_payable',
            party_id: suppObj?.id || null,
            party_name: suppObj?.company_name || 'Supplier',
            document_id: pi.id,
            document_number: pi.invoice_number,
            document_date: pi.invoice_date,
            original_usd: Number(pi.total_amount || 0),
            recognition_rate: recRate,
            original_idr: Number(pi.total_amount || 0) * recRate,
            usd_settled: settledAsOf,
            usd_remaining: balanceUsd,
            carrying_idr_remaining: carryingRemaining,
            current_rate: valRate,
            unrealized_fx: unrealized,
          });
        }
      }
      setOpenExposures(exposures);

      // 8. Customer Receipts FX (paginated; posted receipts allocated to sales invoices; USD-bank receipts use actual bank carrying / FX journals)
      const rvData = await fetchAllPages<any>((from, to) =>
        supabase
          .from('receipt_vouchers')
          .select(`
            id, voucher_number, voucher_date, payment_currency, exchange_rate, amount,
            settlement_amount, is_posted, journal_entry_id,
            customers(id, company_name),
            bank_accounts(bank_name, account_name, account_number, currency),
            journal_entries(id, entry_number)
          `)
          .eq('is_posted', true)
          .gte('voucher_date', startDate)
          .lte('voucher_date', endDate)
          .range(from, to)
      );

      const siData = await fetchAllPages<any>((from, to) =>
        supabase
          .from('sales_invoices')
          .select(`
            id, invoice_number, total_amount, subtotal, journal_entry_id,
            journal_entries(id, entry_number, exchange_rate, transaction_currency, is_posted, is_reversed, is_cancelled)
          `)
          .range(from, to)
      );

      // Fetch posted journal lines for USD-bank receipt vouchers to derive functional bank asset carrying value
      const usdBankRvJeIds = rvData
        .filter((r: any) => {
          const b: any = Array.isArray(r.bank_accounts) ? r.bank_accounts[0] : r.bank_accounts;
          return (b?.currency || '').toUpperCase() === 'USD' && Number(r.exchange_rate || 1) <= 1 && r.journal_entry_id;
        })
        .map((r: any) => r.journal_entry_id as string);

      const rvBankCarryMap = new Map<string, number>();
      if (usdBankRvJeIds.length > 0) {
        for (let i = 0; i < usdBankRvJeIds.length; i += 200) {
          const chunk = usdBankRvJeIds.slice(i, i + 200);
          const { data: rvJeLines } = await supabase
            .from('journal_entry_lines')
            .select('journal_entry_id, debit, credit, chart_of_accounts(code)')
            .in('journal_entry_id', chunk);
          for (const jl of rvJeLines || []) {
            const coaCode = (jl as any).chart_of_accounts?.code;
            // Bank asset account (e.g. 111102) debit represents functional IDR bank carrying value
            if (coaCode && coaCode.startsWith('111') && Number(jl.debit || 0) > 0) {
              rvBankCarryMap.set(jl.journal_entry_id, (rvBankCarryMap.get(jl.journal_entry_id) || 0) + Number(jl.debit));
            }
          }
        }
      }

      const siMap = new Map<string, any>(siData.map((s: any) => [s.id, s]));
      const rvMap = new Map<string, any>(rvData.map((r: any) => [r.id, r]));

      const cLines: CustomerFxLine[] = [];
      for (const alloc of allocData) {
        if (!alloc.receipt_voucher_id || !alloc.sales_invoice_id) continue;
        const rv = rvMap.get(alloc.receipt_voucher_id);
        const si = siMap.get(alloc.sales_invoice_id);
        if (!rv || !si) continue;

        const siJe: any = Array.isArray(si.journal_entries) ? si.journal_entries[0] : si.journal_entries;
        const isUsdInvoiceJe =
          siJe &&
          siJe.is_posted &&
          !siJe.is_reversed &&
          !siJe.is_cancelled &&
          (siJe.transaction_currency || '').toUpperCase() === 'USD';
        const isUsdRv =
          (rv.payment_currency || '').toUpperCase() === 'USD' ||
          (alloc.allocated_currency || '').toUpperCase() === 'USD';
        if (!isUsdRv && !isUsdInvoiceJe) continue;

        const custObj: any = Array.isArray(rv.customers) ? rv.customers[0] : rv.customers;
        const bankObj: any = Array.isArray(rv.bank_accounts) ? rv.bank_accounts[0] : rv.bank_accounts;
        const jeObj: any = Array.isArray(rv.journal_entries) ? rv.journal_entries[0] : rv.journal_entries;
        const isUsdBank = (bankObj?.currency || '').toUpperCase() === 'USD';

        const rvRate = Number(rv.exchange_rate || 1);
        const usdAmt = Number(alloc.allocated_amount || rv.amount || 0);
        // Accounting recognition rate strictly from the posted sales invoice journal (never commercial SO rate)
        const recRate = isUsdInvoiceJe && Number(siJe.exchange_rate || 0) > 1
          ? Number(siJe.exchange_rate)
          : rvRate;
        const carryingSettled = Math.round(usdAmt * recRate * 100) / 100;

        // For USD customer receipts into USD bank accounts (exchange_rate = 1), derive functional IDR
        // from actual bank asset carrying value in posted journal lines or linked FX journal (not rate=1)
        const rvFxJe = pvRefToFxJeMap.get((rv.voucher_number || '').trim());
        const bankAssetIdr = rv.journal_entry_id ? rvBankCarryMap.get(rv.journal_entry_id) : undefined;
        let actualIdr: number;
        if (isUsdBank && rvRate <= 1) {
          if (bankAssetIdr && bankAssetIdr > usdAmt) {
            const rvTotalUsd = Number(rv.amount || usdAmt) || 1;
            actualIdr = Math.round((bankAssetIdr * (usdAmt / rvTotalUsd)) * 100) / 100;
          } else if (rvFxJe) {
            actualIdr = rvFxJe.account_code === '4930'
              ? Math.round((carryingSettled + rvFxJe.amount) * 100) / 100
              : Math.round((carryingSettled - rvFxJe.amount) * 100) / 100;
          } else {
            actualIdr = carryingSettled;
          }
        } else {
          actualIdr = Math.round(usdAmt * rvRate * 100) / 100;
        }
        const effectiveReceiptRate = isUsdBank && rvRate <= 1 && usdAmt > 0
          ? Math.round((actualIdr / usdAmt) * 100) / 100
          : rvRate;
        const fxDiff = Math.round((actualIdr - carryingSettled) * 100) / 100; // > 0 is gain on receivable

        cLines.push({
          id: alloc.id,
          receipt_date: rv.voucher_date,
          voucher_number: rv.voucher_number,
          voucher_id: rv.id,
          customer_id: custObj?.id || null,
          customer_name: custObj?.company_name || 'Customer',
          invoice_id: si.id,
          invoice_number: si.invoice_number,
          invoice_total_usd: Number(si.total_amount || usdAmt),
          recognition_rate: recRate,
          original_idr_carrying: carryingSettled,
          usd_received: usdAmt,
          receipt_rate: effectiveReceiptRate,
          actual_idr_received: actualIdr,
          carrying_idr_settled: carryingSettled,
          fx_gain_loss: fxDiff,
          bank_charge: 0,
          bank_account_name: bankObj?.account_name || bankObj?.bank_name || 'Bank',
          journal_entry_id: jeObj?.id || rv.journal_entry_id || null,
          journal_entry_number: jeObj?.entry_number || null,
        });
      }
      setCustomerLines(cLines);
    } catch (err) {
      console.error('Error loading FX Report data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRunRevaluation = async () => {
    setRevalRunning(true);
    setRevalFeedback(null);
    try {
      const rateNum = parseFloat(revalRate.replace(/,/g, ''));
      if (isNaN(rateNum) || rateNum <= 0) {
        throw new Error('Please enter a valid positive exchange rate');
      }

      const { data, error } = await supabase.rpc('run_fx_month_end_revaluation', {
        p_period_date: revalDate,
        p_closing_rate: rateNum,
        p_rate_source: revalSource,
      });

      if (error) throw error;
      setRevalFeedback(data);
      await loadData();
    } catch (err: any) {
      alert(`❌ Revaluation failed: ${err.message}`);
    } finally {
      setRevalRunning(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [dateRange, manualMarketRate]);

  // ── Aggregations ────────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    let supplierLoss = 0;
    let supplierGain = 0;
    let customerLoss = 0;
    let customerGain = 0;
    let totalUsdSettled = 0;
    let totalActualIdrPaid = 0;
    let totalCarryingSettled = 0;
    let totalPriorReval = 0;
    let totalHistVariance = 0;

    for (const l of supplierLines) {
      totalUsdSettled += l.usd_settled;
      totalActualIdrPaid += l.actual_idr_paid;
      totalCarryingSettled += l.carrying_idr_settled;
      totalPriorReval += l.prior_revaluation_fx;
      totalHistVariance += l.cumulative_historical_rate_variance;
      if (l.fx_gain_loss > 0) supplierLoss += l.fx_gain_loss;
      else if (l.fx_gain_loss < 0) supplierGain += Math.abs(l.fx_gain_loss);
    }

    for (const l of customerLines) {
      if (l.fx_gain_loss > 0) customerGain += l.fx_gain_loss;
      else if (l.fx_gain_loss < 0) customerLoss += Math.abs(l.fx_gain_loss);
    }

    // Official GL FX breakdown (A..G) strictly classified by fx_revaluations.journal_entry_id
    const revalJeSet = new Set<string>(
      revaluationsList
        .filter((r) => r.status === 'posted' && r.journal_entry_id)
        .map((r) => r.journal_entry_id)
    );
    const glBreakdown = summarizePostedGlFx(postedGlLines, revalJeSet);

    const netSettlementVariance = (supplierGain + customerGain) - (supplierLoss + customerLoss);
    const totalOpenUsd = openExposures.reduce((s, e) => s + e.usd_remaining, 0);
    const totalOpenCarrying = openExposures.reduce((s, e) => s + e.carrying_idr_remaining, 0);
    const totalUnrealizedExposure = openExposures.reduce((s, e) => s + e.unrealized_fx, 0);

    return {
      supplierLoss,
      supplierGain,
      customerLoss,
      customerGain,
      totalPriorReval,
      totalHistVariance,
      postedGl7300Loss: glBreakdown.realizedLoss + glBreakdown.unrealizedLoss,
      postedGl4930Gain: glBreakdown.realizedGain + glBreakdown.unrealizedGain,
      realizedGain: glBreakdown.realizedGain,
      realizedLoss: glBreakdown.realizedLoss,
      netRealized: glBreakdown.netRealized,
      unrealizedGain: glBreakdown.unrealizedGain,
      unrealizedLoss: glBreakdown.unrealizedLoss,
      netUnrealized: glBreakdown.netUnrealized,
      totalNetAccountingFx: glBreakdown.totalNetAccountingFx,
      netSettlementVariance,
      totalUsdSettled,
      totalActualIdrPaid,
      totalCarryingSettled,
      totalOpenUsd,
      totalOpenCarrying,
      totalUnrealizedExposure,
    };
  }, [supplierLines, customerLines, openExposures, postedGlLines, revaluationsList]);

  // ── Monthly Aggregation ─────────────────────────────────────────────────────
  const monthlyData = useMemo(() => {
    const monthMap = new Map<string, MonthFxSummary>();

    for (const l of supplierLines) {
      const m = l.payment_date.substring(0, 7); // YYYY-MM
      if (!monthMap.has(m)) {
        monthMap.set(m, {
          month_key: m,
          supplier_fx_gain: 0,
          supplier_fx_loss: 0,
          customer_fx_gain: 0,
          customer_fx_loss: 0,
          net_realized_fx: 0,
          unrealized_fx: 0,
          total_fx_impact: 0,
        });
      }
      const entry = monthMap.get(m)!;
      if (l.fx_gain_loss > 0) entry.supplier_fx_loss += l.fx_gain_loss;
      else if (l.fx_gain_loss < 0) entry.supplier_fx_gain += Math.abs(l.fx_gain_loss);
    }

    const result = Array.from(monthMap.values()).map(e => {
      e.net_realized_fx = (e.supplier_fx_gain + e.customer_fx_gain) - (e.supplier_fx_loss + e.customer_fx_loss);
      e.total_fx_impact = e.net_realized_fx;
      return e;
    });

    result.sort((a, b) => a.month_key.localeCompare(b.month_key));
    return result;
  }, [supplierLines]);

  // ── Supplier Aggregation ────────────────────────────────────────────────────
  const bySupplierData = useMemo(() => {
    const map = new Map<string, PartyFxSummary>();

    for (const l of supplierLines) {
      const s = l.supplier_name || 'Other';
      if (!map.has(s)) {
        map.set(s, {
          party_name: s,
          usd_volume: 0,
          usd_settled: 0,
          recognition_idr: 0,
          settlement_idr: 0,
          fx_gain: 0,
          fx_loss: 0,
          net_fx: 0,
        });
      }
      const p = map.get(s)!;
      p.usd_settled += l.usd_settled;
      p.recognition_idr += l.carrying_idr_settled;
      p.settlement_idr += l.actual_idr_paid;
      if (l.fx_gain_loss > 0) p.fx_loss += l.fx_gain_loss;
      else if (l.fx_gain_loss < 0) p.fx_gain += Math.abs(l.fx_gain_loss);
      p.net_fx = p.fx_gain - p.fx_loss;
    }

    return Array.from(map.values());
  }, [supplierLines]);

  // ── Excel Export ────────────────────────────────────────────────────────────
  const exportToExcel = () => {
    const wb = XLSX.utils.book_new();

    // 1. Summary Sheet (Official GL A..G + Settlement Bridge)
    const summaryRows = [
      { Metric: 'Reporting Range', Value: `${dateRange.startDate} to ${dateRange.endDate}` },
      { Metric: 'A. Realized FX Gain (GL 4930)', Value: fmt(summary.realizedGain) },
      { Metric: 'B. Realized FX Loss (GL 7300)', Value: fmt(summary.realizedLoss) },
      { Metric: 'C. Net Realized FX Gain / (Loss)', Value: fmt(summary.netRealized) },
      { Metric: 'D. Unrealized FX Gain (GL 4930 - Revaluations)', Value: fmt(summary.unrealizedGain) },
      { Metric: 'E. Unrealized FX Loss (GL 7300 - Revaluations)', Value: fmt(summary.unrealizedLoss) },
      { Metric: 'F. Net Unrealized FX Gain / (Loss)', Value: fmt(summary.netUnrealized) },
      { Metric: 'G. Total Net Accounting FX Gain / (Loss)', Value: fmt(summary.totalNetAccountingFx) },
      { Metric: 'Total USD Settled', Value: fmt2(summary.totalUsdSettled) },
      { Metric: 'Pre-Settlement Carrying Value (IDR)', Value: fmt(summary.totalCarryingSettled) },
      { Metric: 'Total IDR Settlement Outflow', Value: fmt(summary.totalActualIdrPaid) },
      { Metric: 'Supplier Realized FX Loss (Bridge)', Value: fmt(summary.supplierLoss) },
      { Metric: 'Supplier Realized FX Gain (Bridge)', Value: fmt(summary.supplierGain) },
      { Metric: 'Cumulative Historical Rate Variance (Analytical)', Value: fmt(summary.totalHistVariance) },
      { Metric: 'Open USD Exposure (as of end date)', Value: fmt2(summary.totalOpenUsd) },
      { Metric: 'Open Carrying Value (IDR)', Value: fmt(summary.totalOpenCarrying) },
    ];
    const wsSummary = XLSX.utils.json_to_sheet(sanitizeExportRows(summaryRows));
    wsSummary['!cols'] = [{ wch: 44 }, { wch: 25 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, 'FX Summary');

    // 2. Supplier Detail Sheet (Settlement Bridge)
    const suppRows = supplierLines.map(l => ({
      'Payment Date': l.payment_date,
      'Voucher No': l.voucher_number,
      'Supplier': l.supplier_name,
      'Invoice No': l.invoice_number,
      'Original USD': l.invoice_total_usd,
      'Rec Rate': l.recognition_rate,
      'USD Settled': l.usd_settled,
      'Original Carrying (Settled)': Math.round(l.usd_settled * l.recognition_rate * 100) / 100,
      'Prior Reval Gain/(Loss)': l.prior_revaluation_fx,
      'Carrying Before Settlement': l.carrying_before_settlement_idr,
      'Settlement Rate': l.settlement_rate,
      'Actual Settlement (IDR)': l.actual_idr_paid,
      'Realized FX on Settlement': l.fx_gain_loss,
      'Type': l.fx_gain_loss > 0 ? 'FX LOSS' : l.fx_gain_loss < 0 ? 'FX GAIN' : 'EVEN',
      'Cumul. Historical Rate Variance': l.cumulative_historical_rate_variance,
      'Bank Charge': l.bank_charge,
      'Bank Account': l.bank_account_name,
      'Payment Journal': l.journal_entry_number || '',
      'FX Journal': l.fx_journal_number || '',
    }));
    const wsSupp = XLSX.utils.json_to_sheet(sanitizeExportRows(suppRows));
    XLSX.utils.book_append_sheet(wb, wsSupp, 'Supplier FX Detail');

    // 3. Posted GL Sheet
    const glRows = postedGlLines.map(gl => ({
      'Entry Date': gl.entry_date,
      'Journal Number': gl.entry_number,
      'Reference': gl.reference_number || '',
      'Classification': gl.is_revaluation ? `Unrealized (${gl.revaluation_number || 'Reval'})` : 'Realized',
      'Account Code': gl.account_code,
      'Account Name': gl.account_name,
      'Debit (IDR)': gl.debit,
      'Credit (IDR)': gl.credit,
      'Description': gl.description,
    }));
    const wsGl = XLSX.utils.json_to_sheet(sanitizeExportRows(glRows));
    XLSX.utils.book_append_sheet(wb, wsGl, 'Posted GL FX Activity');

    // 4. Open Exposure Sheet
    const expRows = openExposures.map(e => ({
      'Type': e.type,
      'Party': e.party_name,
      'Invoice No': e.document_number,
      'Date': e.document_date,
      'Original USD': e.original_usd,
      'Original Rate': e.recognition_rate,
      'Original IDR': e.original_idr,
      'USD Settled': e.usd_settled,
      'USD Remaining': e.usd_remaining,
      'Carrying IDR Remaining': e.carrying_idr_remaining,
      'Current Rate': e.current_rate,
      'Unrealized FX': e.unrealized_fx,
    }));
    const wsExp = XLSX.utils.json_to_sheet(sanitizeExportRows(expRows));
    XLSX.utils.book_append_sheet(wb, wsExp, 'Open USD Exposure');

    XLSX.writeFile(wb, `SAPJ_FX_Accounting_Report_${dateRange.startDate}_${dateRange.endDate}.xlsx`);
  };

  return (
    <div className="space-y-3">
      {/* 1. Single Compact Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2 border-b border-slate-200">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-slate-900 tracking-tight">
              FX Management
            </h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded-full border border-indigo-200">
              Accounting FX
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Foreign Exchange Accounting Gain & Loss (GL 7300 & 4930)
            {dateRange?.startDate && dateRange?.endDate && (
              <span className="ml-1.5 text-slate-400 font-mono text-[11px]">
                ({fmtDate(dateRange.startDate)} – {fmtDate(dateRange.endDate)})
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {onSwitchToCommercialDashboard && (
            <button
              type="button"
              onClick={onSwitchToCommercialDashboard}
              className="px-3 py-1.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5"
              title="Switch to Commercial FX Dashboard"
            >
              <TrendingUp className="w-3.5 h-3.5 text-blue-600" />
              Commercial FX
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowRevalModal(true)}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center gap-1.5 transition-colors"
            title="Run Month-End Foreign Currency Monetary Revaluation"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Revaluation
          </button>
          <button
            type="button"
            className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center gap-1.5"
          >
            <Layers className="w-3.5 h-3.5" />
            Accounting FX
          </button>
          <button
            type="button"
            onClick={exportToExcel}
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold transition-colors shadow-xs flex items-center gap-1.5"
            title="Export all records to Excel"
          >
            <Download className="w-3.5 h-3.5" />
            Excel
          </button>
          <button
            type="button"
            onClick={loadData}
            className="p-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-lg transition-colors"
            title="Refresh Data"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* 2. Compact 4-KPI Strip (~72px height) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="bg-white px-3.5 py-2 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between min-h-[72px]">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">G. Total Net Accounting FX</span>
          <div className="mt-1">
            <div className={`text-base font-bold leading-tight ${summary.totalNetAccountingFx >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
              {summary.totalNetAccountingFx < 0 ? `-Rp ${fmt(Math.abs(summary.totalNetAccountingFx))}` : `Rp ${fmt(summary.totalNetAccountingFx)}`}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">Posted GL 4930 − GL 7300</div>
          </div>
        </div>

        <div className="bg-white px-3.5 py-2 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between min-h-[72px]">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">C. Net Realized FX</span>
          <div className="mt-1">
            <div className={`text-base font-bold leading-tight ${summary.netRealized >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {summary.netRealized < 0 ? `-Rp ${fmt(Math.abs(summary.netRealized))}` : `Rp ${fmt(summary.netRealized)}`}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">Gain Rp {fmt(summary.realizedGain)} / Loss Rp {fmt(summary.realizedLoss)}</div>
          </div>
        </div>

        <div className="bg-white px-3.5 py-2 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between min-h-[72px]">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">F. Net Unrealized FX</span>
          <div className="mt-1">
            <div className={`text-base font-bold leading-tight ${summary.netUnrealized >= 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
              {summary.netUnrealized < 0 ? `-Rp ${fmt(Math.abs(summary.netUnrealized))}` : `Rp ${fmt(summary.netUnrealized)}`}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">From posted FX revaluations</div>
          </div>
        </div>

        <div className="bg-white px-3.5 py-2 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between min-h-[72px]">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Open USD Exposure</span>
          <div className="mt-1">
            <div className="text-base font-bold text-amber-800 leading-tight">${fmt2(summary.totalOpenUsd)}</div>
            <div className="text-[10px] text-slate-400 mt-0.5">Carrying: Rp {fmt(summary.totalOpenCarrying)}</div>
          </div>
        </div>
      </div>

      {/* 3. Compact Navigation Tabs */}
      <div className="flex flex-wrap border-b border-slate-200 bg-white px-2.5 pt-1.5 rounded-t-xl gap-1">
        {[
          { key: 'summary', label: '1. Summary' },
          { key: 'supplier', label: `2. Supplier Settlements (${supplierLines.length})` },
          { key: 'posted_gl', label: `3. Posted GL Activity (${postedGlLines.length})` },
          { key: 'customer', label: `4. Customer Detail (${customerLines.length})` },
          { key: 'exposure', label: `5. Open Exposure (${openExposures.length})` },
          { key: 'monthly', label: `6. By Month (${monthlyData.length})` },
          { key: 'by_supplier', label: `7. By Supplier (${bySupplierData.length})` },
          { key: 'revaluations', label: `8. Revaluations (${revaluationsList.length})` },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key as any)}
            className={`px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px transition-colors rounded-t-lg ${
              activeTab === t.key
                ? 'border-indigo-600 text-indigo-700 bg-indigo-50/50 font-bold'
                : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab 1: Summary */}
      {activeTab === 'summary' && (
        <div className="bg-white rounded-b-2xl border border-slate-200 border-t-0 p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="border border-slate-200 rounded-xl p-5 shadow-xs">
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-4">Official GL FX Summary (Accounts 4930 & 7300)</h3>
              <table className="w-full text-xs">
                <tbody className="divide-y divide-slate-100">
                  <tr>
                    <td className="py-2 text-slate-600">A. Realized FX Gain (GL 4930)</td>
                    <td className="py-2 text-right font-semibold text-emerald-600 tabular-nums">Rp {fmt(summary.realizedGain)}</td>
                  </tr>
                  <tr>
                    <td className="py-2 text-slate-600">B. Realized FX Loss (GL 7300)</td>
                    <td className="py-2 text-right font-semibold text-red-600 tabular-nums">Rp {fmt(summary.realizedLoss)}</td>
                  </tr>
                  <tr className="bg-slate-50/70 font-semibold">
                    <td className="py-2 text-slate-800">C. Net Realized FX (A &minus; B)</td>
                    <td className={`py-2 text-right tabular-nums ${summary.netRealized >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {summary.netRealized < 0 ? `(Rp ${fmt(Math.abs(summary.netRealized))})` : `Rp ${fmt(summary.netRealized)}`}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 text-slate-600">D. Unrealized FX Gain (GL 4930 &bull; Revaluations)</td>
                    <td className="py-2 text-right font-semibold text-emerald-600 tabular-nums">Rp {fmt(summary.unrealizedGain)}</td>
                  </tr>
                  <tr>
                    <td className="py-2 text-slate-600">E. Unrealized FX Loss (GL 7300 &bull; Revaluations)</td>
                    <td className="py-2 text-right font-semibold text-red-600 tabular-nums">Rp {fmt(summary.unrealizedLoss)}</td>
                  </tr>
                  <tr className="bg-slate-50/70 font-semibold">
                    <td className="py-2 text-slate-800">F. Net Unrealized FX (D &minus; E)</td>
                    <td className={`py-2 text-right tabular-nums ${summary.netUnrealized >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {summary.netUnrealized < 0 ? `(Rp ${fmt(Math.abs(summary.netUnrealized))})` : `Rp ${fmt(summary.netUnrealized)}`}
                    </td>
                  </tr>
                  <tr className="border-t-2 border-slate-300 font-bold">
                    <td className="py-3 text-slate-900 text-sm">G. Total Net Accounting FX Gain / (Loss)</td>
                    <td className={`py-3 text-right tabular-nums text-sm ${summary.totalNetAccountingFx >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {summary.totalNetAccountingFx < 0 ? `(Rp ${fmt(Math.abs(summary.totalNetAccountingFx))})` : `Rp ${fmt(summary.totalNetAccountingFx)}`}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="border border-slate-200 rounded-xl p-5 bg-slate-50/50">
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-4">Core Accounting Separation Policy</h3>
              <div className="space-y-3 text-xs text-slate-600">
                <div className="flex gap-2.5">
                  <div className="w-2 h-2 rounded-full bg-blue-600 mt-1.5 shrink-0" />
                  <p><strong>Import Rate:</strong> Establishes the IDR carrying value of USD purchase/inventory at recognition date. Never changes after invoice recognition.</p>
                </div>
                <div className="flex gap-2.5">
                  <div className="w-2 h-2 rounded-full bg-emerald-600 mt-1.5 shrink-0" />
                  <p><strong>Commercial Rate:</strong> Sales Order pricing rate used strictly for customer sales economics and gross margins. Not an accounting FX gain/loss.</p>
                </div>
                <div className="flex gap-2.5">
                  <div className="w-2 h-2 rounded-full bg-purple-600 mt-1.5 shrink-0" />
                  <p><strong>Settlement Rate:</strong> Actual bank FX rate when USD liability or receivable is settled. Difference from carrying value posts directly to Finance P&L.</p>
                </div>
                <div className="flex gap-2.5">
                  <div className="w-2 h-2 rounded-full bg-amber-600 mt-1.5 shrink-0" />
                  <p><strong>Landed Cost Protection:</strong> FX loss/gain is never mixed into product landed cost, inventory valuation, or sales revenue.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Supplier FX Detail */}
      {activeTab === 'supplier' && (
        <div className="bg-white rounded-b-2xl border border-slate-200 border-t-0 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Supplier Payments & FX Settlements</h3>
              <p className="text-[11px] text-slate-500">6 FX Payment Vouchers covering 10 settlement allocations against USD Purchase Invoices</p>
            </div>
            <span className="text-xs px-2.5 py-1 bg-indigo-50 text-indigo-700 font-semibold rounded-lg border border-indigo-100">
              {supplierLines.length} settlement allocations
            </span>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-100/90 text-slate-700 font-semibold border-b border-slate-200 text-[11px]">
                <tr>
                  <th className="py-2.5 px-3">Payment Date</th>
                  <th className="py-2.5 px-2.5">Voucher</th>
                  <th className="py-2.5 px-2.5">Supplier</th>
                  <th className="py-2.5 px-2.5">Invoice</th>
                  <th className="py-2.5 px-2.5 text-right">Settled USD</th>
                  <th className="py-2.5 px-2.5 text-right">Rec Rate</th>
                  <th className="py-2.5 px-2.5 text-right">Prior Reval</th>
                  <th className="py-2.5 px-2.5 text-right">Pre-Settle Carrying</th>
                  <th className="py-2.5 px-2.5 text-right">Settle Rate</th>
                  <th className="py-2.5 px-2.5 text-right">Actual Settlement</th>
                  <th className="py-2.5 px-3 text-right font-bold">Realized FX</th>
                  <th className="py-2.5 px-2.5 text-right" title="Analytical only: Actual Settlement minus Original PI Carrying">Hist. Variance</th>
                  <th className="py-2.5 px-2.5">Bank</th>
                  <th className="py-2.5 px-2.5 text-center">Payment JE</th>
                  <th className="py-2.5 px-2.5 text-center">FX JE</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {supplierLines.map((row) => (
                  <tr key={row.id} className="hover:bg-indigo-50/30 transition-colors">
                    <td className="py-2.5 px-3 whitespace-nowrap">{fmtDate(row.payment_date)}</td>
                    <td className="py-2.5 px-2.5 font-mono font-bold text-slate-900">{row.voucher_number}</td>
                    <td className="py-2.5 px-2.5 max-w-[140px] truncate" title={row.supplier_name}>{row.supplier_name}</td>
                    <td className="py-2.5 px-2.5">
                      <button
                        onClick={() => onViewInvoice?.(row.invoice_id)}
                        className="text-blue-600 hover:underline font-mono text-xs font-medium"
                      >
                        {row.invoice_number}
                      </button>
                    </td>
                    <td className="py-2.5 px-2.5 text-right font-mono font-medium">${fmt2(row.usd_settled)}</td>
                    <td className="py-2.5 px-2.5 text-right font-mono text-slate-600">Rp {fmt(row.recognition_rate)}</td>
                    <td className="py-2.5 px-2.5 text-right font-mono text-slate-600">
                      {row.prior_revaluation_fx !== 0 ? `${row.prior_revaluation_fx > 0 ? '+' : '-'}Rp ${fmt(Math.abs(row.prior_revaluation_fx))}` : '—'}
                    </td>
                    <td className="py-2.5 px-2.5 text-right font-mono text-slate-700">Rp {fmt(row.carrying_before_settlement_idr)}</td>
                    <td className="py-2.5 px-2.5 text-right font-mono text-slate-600">
                      {row.is_usd_bank_settlement ? <span title="Settled from USD Bank">USD Bank</span> : `Rp ${fmt(row.settlement_rate)}`}
                    </td>
                    <td className="py-2.5 px-2.5 text-right font-mono text-slate-900 font-medium">Rp {fmt(row.actual_idr_paid)}</td>
                    <td className={`py-2.5 px-3 text-right font-mono font-bold ${row.fx_gain_loss > 0 ? 'text-red-700 bg-red-50/40' : row.fx_gain_loss < 0 ? 'text-emerald-700 bg-emerald-50/40' : 'text-slate-500'}`}>
                      {row.fx_gain_loss > 0 ? `+Rp ${fmt(row.fx_gain_loss)} (Loss)` : row.fx_gain_loss < 0 ? `-Rp ${fmt(Math.abs(row.fx_gain_loss))} (Gain)` : 'Rp 0'}
                    </td>
                    <td className="py-2.5 px-2.5 text-right font-mono text-slate-500">
                      {row.cumulative_historical_rate_variance !== 0 ? `${row.cumulative_historical_rate_variance > 0 ? '+' : '-'}Rp ${fmt(Math.abs(row.cumulative_historical_rate_variance))}` : 'Rp 0'}
                    </td>
                    <td className="py-2.5 px-2.5 text-slate-600 truncate max-w-[120px]" title={row.bank_account_name}>{row.bank_account_name}</td>
                    <td className="py-2.5 px-2.5 text-center">
                      {row.journal_entry_id ? (
                        <button
                          onClick={() => onViewJournal?.(row.journal_entry_id!)}
                          className="px-2 py-0.5 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded text-[10px] font-mono border border-blue-200"
                        >
                          {row.journal_entry_number || 'View JE'}
                        </button>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="py-2.5 px-2.5 text-center">
                      {row.fx_journal_id ? (
                        <button
                          onClick={() => onViewJournal?.(row.fx_journal_id!)}
                          className="px-2 py-0.5 bg-red-50 text-red-700 hover:bg-red-100 rounded text-[10px] font-mono font-bold border border-red-200"
                          title="View Realized FX Loss Journal Entry (7300)"
                        >
                          {row.fx_journal_number}
                        </button>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-100 font-bold border-t border-slate-300 text-slate-900">
                <tr>
                  <td colSpan={4} className="py-2.5 px-3">TOTALS ({supplierLines.length} Allocations)</td>
                  <td className="py-2.5 px-2.5 text-right font-mono">${fmt2(summary.totalUsdSettled)}</td>
                  <td />
                  <td className="py-2.5 px-2.5 text-right font-mono">
                    {summary.totalPriorReval !== 0 ? `${summary.totalPriorReval > 0 ? '+' : '-'}Rp ${fmt(Math.abs(summary.totalPriorReval))}` : '—'}
                  </td>
                  <td className="py-2.5 px-2.5 text-right font-mono">Rp {fmt(summary.totalCarryingSettled)}</td>
                  <td />
                  <td className="py-2.5 px-2.5 text-right font-mono">Rp {fmt(summary.totalActualIdrPaid)}</td>
                  <td className={`py-2.5 px-3 text-right font-mono ${summary.supplierLoss - summary.supplierGain > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                    {summary.supplierLoss - summary.supplierGain >= 0
                      ? `+Rp ${fmt(summary.supplierLoss - summary.supplierGain)} (Net Loss)`
                      : `-Rp ${fmt(summary.supplierGain - summary.supplierLoss)} (Net Gain)`}
                  </td>
                  <td className="py-2.5 px-2.5 text-right font-mono text-slate-600">
                    {summary.totalHistVariance >= 0 ? `+Rp ${fmt(summary.totalHistVariance)}` : `-Rp ${fmt(Math.abs(summary.totalHistVariance))}`}
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Tab 3: Posted GL FX Activity */}
      {activeTab === 'posted_gl' && (
        <div className="bg-white rounded-b-2xl border border-slate-200 border-t-0 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Posted General Ledger FX Journal Entries</h3>
              <p className="text-[11px] text-slate-500">Official General Ledger entries affecting Accounts 7300 (Foreign Exchange Loss) & 4930 (Foreign Exchange Gain)</p>
            </div>
            <span className="text-xs px-2.5 py-1 bg-red-50 text-red-700 font-semibold rounded-lg border border-red-100">
              {postedGlLines.length} posted entries
            </span>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-100/90 text-slate-700 font-semibold border-b border-slate-200 text-[11px]">
                <tr>
                  <th className="py-2.5 px-3">Date</th>
                  <th className="py-2.5 px-2.5">Journal Number</th>
                  <th className="py-2.5 px-2.5">Reference Voucher</th>
                  <th className="py-2.5 px-2.5">Account</th>
                  <th className="py-2.5 px-3 text-right">Debit</th>
                  <th className="py-2.5 px-3 text-right">Credit</th>
                  <th className="py-2.5 px-3">Description</th>
                  <th className="py-2.5 px-2.5 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {postedGlLines.map(gl => (
                  <tr key={gl.id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3 whitespace-nowrap">{fmtDate(gl.entry_date)}</td>
                    <td className="py-2.5 px-2.5 font-mono font-bold text-slate-900">{gl.entry_number}</td>
                    <td className="py-2.5 px-2.5 font-mono text-indigo-700 font-medium">{gl.reference_number || '—'}</td>
                    <td className="py-2.5 px-2.5">
                      <span className="px-2 py-0.5 bg-slate-100 text-slate-800 rounded font-mono font-semibold">
                        {gl.account_code} - {gl.account_name}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono font-bold text-red-600">
                      {gl.debit > 0 ? `Rp ${fmt(gl.debit)}` : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-600">
                      {gl.credit > 0 ? `Rp ${fmt(gl.credit)}` : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-slate-600 max-w-md">{gl.description}</td>
                    <td className="py-2.5 px-2.5 text-center">
                      <button
                        onClick={() => onViewJournal?.(gl.journal_entry_id)}
                        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-[10px] font-semibold transition-all inline-flex items-center gap-1"
                      >
                        <ExternalLink className="w-3 h-3" /> View Entry
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 4: Customer FX Detail */}
      {activeTab === 'customer' && (
        <div className="bg-white rounded-b-2xl border border-slate-200 border-t-0 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Customer Receipts & FX Realization</h3>
            <span className="text-xs text-slate-500">{customerLines.length} records</span>
          </div>

          {customerLines.length === 0 ? (
            <div className="p-12 text-center bg-slate-50 rounded-xl border border-dashed border-slate-200">
              <p className="text-xs text-slate-500">
                No foreign currency customer receipts found for this period. All domestic sales invoices are recognized and settled in IDR.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-2.5">Voucher</th>
                    <th className="py-2.5 px-2.5">Customer</th>
                    <th className="py-2.5 px-2.5 text-right">USD Received</th>
                    <th className="py-2.5 px-2.5 text-right">Rec Rate</th>
                    <th className="py-2.5 px-2.5 text-right">Receipt Rate</th>
                    <th className="py-2.5 px-2.5 text-right">Actual IDR Received</th>
                    <th className="py-2.5 px-3 text-right font-bold">Realized FX</th>
                    <th className="py-2.5 px-2.5">Bank</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {customerLines.map(row => (
                    <tr key={row.id}>
                      <td className="py-2.5 px-3">{fmtDate(row.receipt_date)}</td>
                      <td className="py-2.5 px-2.5 font-mono font-bold">{row.voucher_number}</td>
                      <td className="py-2.5 px-2.5">{row.customer_name}</td>
                      <td className="py-2.5 px-2.5 text-right font-mono">${fmt2(row.usd_received)}</td>
                      <td className="py-2.5 px-2.5 text-right font-mono">{fmt(row.recognition_rate)}</td>
                      <td className="py-2.5 px-2.5 text-right font-mono">{fmt(row.receipt_rate)}</td>
                      <td className="py-2.5 px-2.5 text-right font-mono">Rp {fmt(row.actual_idr_received)}</td>
                      <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-700">Rp {fmt(row.fx_gain_loss)}</td>
                      <td className="py-2.5 px-2.5">{row.bank_account_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab 5: Open USD Exposure */}
      {activeTab === 'exposure' && (
        <div className="bg-white rounded-b-2xl border border-slate-200 border-t-0 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Open USD Exposure & Valuation</h3>
              <p className="text-[11px] text-slate-500">Unsettled USD purchase payables awaiting bank settlement.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs font-medium text-slate-600">
                {manualMarketRate.trim()
                  ? 'Manual Valuation Rate (Assumption):'
                  : latestPostedRevalRate
                    ? `Posted Revaluation Rate (Rp ${fmt(latestPostedRevalRate)}):`
                    : 'Manual Valuation Rate (Optional):'}
              </label>
              <input
                type="number"
                placeholder={latestPostedRevalRate ? String(latestPostedRevalRate) : 'Enter rate'}
                value={manualMarketRate}
                onChange={e => setManualMarketRate(e.target.value)}
                className="w-28 px-2 py-1 text-xs border border-slate-300 rounded-lg font-mono text-right"
              />
            </div>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200 text-[11px]">
                <tr>
                  <th className="py-2.5 px-3">Date</th>
                  <th className="py-2.5 px-2.5">Supplier / Party</th>
                  <th className="py-2.5 px-2.5">Document</th>
                  <th className="py-2.5 px-2.5 text-right">Original USD</th>
                  <th className="py-2.5 px-2.5 text-right">Rec Rate</th>
                  <th className="py-2.5 px-2.5 text-right">USD Settled</th>
                  <th className="py-2.5 px-2.5 text-right font-bold text-slate-900">USD Remaining</th>
                  <th className="py-2.5 px-2.5 text-right">Carrying IDR Remaining</th>
                  <th className="py-2.5 px-2.5 text-right">Market Spot Rate</th>
                  <th className="py-2.5 px-3 text-right font-bold">Unrealized Delta</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {openExposures.map((row, idx) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3 whitespace-nowrap">{fmtDate(row.document_date)}</td>
                    <td className="py-2.5 px-2.5 font-medium text-slate-900">{row.party_name}</td>
                    <td className="py-2.5 px-2.5 font-mono text-blue-600">
                      <button onClick={() => onViewInvoice?.(row.document_id)} className="hover:underline">
                        {row.document_number}
                      </button>
                    </td>
                    <td className="py-2.5 px-2.5 text-right font-mono">${fmt2(row.original_usd)}</td>
                    <td className="py-2.5 px-2.5 text-right font-mono text-slate-600">{fmt(row.recognition_rate)}</td>
                    <td className="py-2.5 px-2.5 text-right font-mono text-slate-500">${fmt2(row.usd_settled)}</td>
                    <td className="py-2.5 px-2.5 text-right font-mono font-bold text-indigo-700">${fmt2(row.usd_remaining)}</td>
                    <td className="py-2.5 px-2.5 text-right font-mono text-slate-800">Rp {fmt(row.carrying_idr_remaining)}</td>
                    <td className="py-2.5 px-2.5 text-right font-mono text-slate-600">{fmt(row.current_rate)}</td>
                    <td className={`py-2.5 px-3 text-right font-mono font-bold ${row.unrealized_fx > 0 ? 'text-amber-700 bg-amber-50/50' : 'text-emerald-700'}`}>
                      {row.unrealized_fx > 0 ? `+Rp ${fmt(row.unrealized_fx)}` : `Rp ${fmt(row.unrealized_fx)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-100 font-bold border-t border-slate-300 text-slate-900">
                <tr>
                  <td colSpan={6} className="py-2.5 px-3">TOTAL OPEN USD EXPOSURE</td>
                  <td className="py-2.5 px-2.5 text-right font-mono text-indigo-700">${fmt2(summary.totalOpenUsd)}</td>
                  <td className="py-2.5 px-2.5 text-right font-mono">Rp {fmt(summary.totalOpenCarrying)}</td>
                  <td />
                  <td className="py-2.5 px-3 text-right font-mono text-amber-800">Rp {fmt(summary.totalUnrealizedExposure)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Tab 6: FX by Month */}
      {activeTab === 'monthly' && (
        <div className="bg-white rounded-b-2xl border border-slate-200 border-t-0 p-5 space-y-4">
          <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Monthly Realized FX Breakdown</h3>
          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3">Month</th>
                  <th className="py-2.5 px-3 text-right">Supplier FX Loss</th>
                  <th className="py-2.5 px-3 text-right">Supplier FX Gain</th>
                  <th className="py-2.5 px-3 text-right">Customer FX Gain</th>
                  <th className="py-2.5 px-3 text-right">Customer FX Loss</th>
                  <th className="py-2.5 px-3 text-right font-bold">Net Realized FX</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {monthlyData.map(m => (
                  <tr key={m.month_key} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3 font-semibold text-slate-900">{m.month_key}</td>
                    <td className="py-2.5 px-3 text-right text-red-600">Rp {fmt(m.supplier_fx_loss)}</td>
                    <td className="py-2.5 px-3 text-right text-emerald-600">Rp {fmt(m.supplier_fx_gain)}</td>
                    <td className="py-2.5 px-3 text-right text-emerald-600">Rp {fmt(m.customer_fx_gain)}</td>
                    <td className="py-2.5 px-3 text-right text-red-600">Rp {fmt(m.customer_fx_loss)}</td>
                    <td className={`py-2.5 px-3 text-right font-bold ${m.net_realized_fx >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {m.net_realized_fx < 0 ? `(${fmt(Math.abs(m.net_realized_fx))})` : `Rp ${fmt(m.net_realized_fx)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 7: FX by Supplier */}
      {activeTab === 'by_supplier' && (
        <div className="bg-white rounded-b-2xl border border-slate-200 border-t-0 p-5 space-y-4">
          <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">FX Impact by Supplier</h3>
          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3">Supplier</th>
                  <th className="py-2.5 px-3 text-right">USD Settled</th>
                  <th className="py-2.5 px-3 text-right">Recognition IDR</th>
                  <th className="py-2.5 px-3 text-right">Settlement IDR</th>
                  <th className="py-2.5 px-3 text-right text-emerald-600">FX Gain</th>
                  <th className="py-2.5 px-3 text-right text-red-600">FX Loss</th>
                  <th className="py-2.5 px-3 text-right font-bold">Net FX Impact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {bySupplierData.map((s, idx) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3 font-semibold text-slate-900 font-sans">{s.party_name}</td>
                    <td className="py-2.5 px-3 text-right">${fmt2(s.usd_settled)}</td>
                    <td className="py-2.5 px-3 text-right">Rp {fmt(s.recognition_idr)}</td>
                    <td className="py-2.5 px-3 text-right">Rp {fmt(s.settlement_idr)}</td>
                    <td className="py-2.5 px-3 text-right text-emerald-600">Rp {fmt(s.fx_gain)}</td>
                    <td className="py-2.5 px-3 text-right text-red-600">Rp {fmt(s.fx_loss)}</td>
                    <td className={`py-2.5 px-3 text-right font-bold ${s.net_fx >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {s.net_fx < 0 ? `(${fmt(Math.abs(s.net_fx))})` : `Rp ${fmt(s.net_fx)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 8: Revaluations Audit Trail */}
      {activeTab === 'revaluations' && (
        <div className="bg-white rounded-b-2xl border border-slate-200 border-t-0 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Monetary FX Revaluations Audit Trail</h3>
              <p className="text-xs text-slate-500 mt-0.5">Authoritative month-end foreign currency valuations and journal entries</p>
            </div>
            <button
              type="button"
              onClick={() => setShowRevalModal(true)}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              New Revaluation
            </button>
          </div>

          <div className="space-y-4">
            {revaluationsList.length === 0 ? (
              <div className="text-center py-10 text-slate-500 text-xs">
                No recorded month-end revaluations found. Click "New Revaluation" to run.
              </div>
            ) : (
              revaluationsList.map((rev) => (
                <div key={rev.id} className="border border-slate-200 rounded-xl p-4 bg-slate-50/50 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900 text-sm">{rev.revaluation_number}</span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-medium">
                        Period: {rev.period_name}
                      </span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-medium uppercase">
                        {rev.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-slate-500">
                        Date: <strong className="text-slate-700">{fmtDate(rev.revaluation_date)}</strong>
                      </span>
                      <span className="text-slate-500">
                        Rate: <strong className="text-slate-700">Rp {fmt(rev.closing_rate)}/USD</strong> ({rev.rate_source})
                      </span>
                      {rev.journal_entries?.entry_number && (
                        <button
                          type="button"
                          onClick={() => onViewJournal?.(rev.journal_entry_id)}
                          className="text-indigo-600 hover:underline font-semibold flex items-center gap-1"
                        >
                          {rev.journal_entries.entry_number}
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  {rev.fx_revaluation_lines && rev.fx_revaluation_lines.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-left bg-white rounded-lg border border-slate-200">
                        <thead className="bg-slate-100 text-slate-600 font-semibold border-b border-slate-200">
                          <tr>
                            <th className="py-2 px-2.5">Type</th>
                            <th className="py-2 px-2.5">Document / Asset</th>
                            <th className="py-2 px-2.5 text-right">USD Amount</th>
                            <th className="py-2 px-2.5 text-right">Carrying Rate</th>
                            <th className="py-2 px-2.5 text-right">Carrying IDR</th>
                            <th className="py-2 px-2.5 text-right">Revalued IDR</th>
                            <th className="py-2 px-2.5 text-right">Impact</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-mono">
                          {rev.fx_revaluation_lines.map((ln: any) => (
                            <tr key={ln.id} className="hover:bg-slate-50">
                              <td className="py-2 px-2.5 font-sans capitalize text-slate-700">
                                {ln.line_type === 'bank_asset' ? 'USD Bank Asset' : 'Accounts Payable'}
                              </td>
                              <td className="py-2 px-2.5 font-sans font-medium text-slate-900">
                                {ln.purchase_invoices?.invoice_number || ln.bank_accounts?.account_name || 'Asset/Payable'}
                              </td>
                              <td className="py-2 px-2.5 text-right">${fmt2(ln.foreign_amount)}</td>
                              <td className="py-2 px-2.5 text-right">Rp {fmt(ln.carrying_rate)}</td>
                              <td className="py-2 px-2.5 text-right">Rp {fmt(ln.carrying_amount_idr)}</td>
                              <td className="py-2 px-2.5 text-right">Rp {fmt(ln.revalued_amount_idr)}</td>
                              <td className={`py-2 px-2.5 text-right font-bold ${ln.gain_loss_type === 'unrealized_gain' ? 'text-emerald-700' : 'text-red-700'}`}>
                                {ln.gain_loss_type === 'unrealized_gain' ? `+Rp ${fmt(ln.fx_difference)}` : `-Rp ${fmt(ln.fx_difference)}`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Modal: Run Month-End Revaluation */}
      {showRevalModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-5 space-y-4 border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Run Month-End FX Revaluation</h3>
                <p className="text-xs text-slate-500 mt-0.5">Calculate monetary revaluations and generate balanced GL journal</p>
              </div>
              <button
                type="button"
                onClick={() => { setShowRevalModal(false); setRevalFeedback(null); }}
                className="text-slate-400 hover:text-slate-600 text-lg font-bold"
              >
                ✕
              </button>
            </div>

            {revalFeedback ? (
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                <div className="flex items-center gap-2 text-emerald-700 font-bold text-xs">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  {revalFeedback.message}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div className="bg-white p-2 rounded border border-slate-200">
                    <span className="text-[10px] text-slate-500 block">Reval Number</span>
                    <strong>{revalFeedback.revaluation_number}</strong>
                  </div>
                  <div className="bg-white p-2 rounded border border-slate-200">
                    <span className="text-[10px] text-slate-500 block">Closing Rate</span>
                    <strong>Rp {fmt(revalFeedback.closing_rate)}/USD</strong>
                  </div>
                  {revalFeedback.unrealized_gain !== undefined && (
                    <div className="bg-white p-2 rounded border border-slate-200 text-emerald-700">
                      <span className="text-[10px] text-slate-500 block">Unrealized Gain</span>
                      <strong>Rp {fmt(revalFeedback.unrealized_gain)}</strong>
                    </div>
                  )}
                  {revalFeedback.unrealized_loss !== undefined && (
                    <div className="bg-white p-2 rounded border border-slate-200 text-red-700">
                      <span className="text-[10px] text-slate-500 block">Unrealized Loss</span>
                      <strong>Rp {fmt(revalFeedback.unrealized_loss)}</strong>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => { setShowRevalModal(false); setRevalFeedback(null); setActiveTab('revaluations'); }}
                  className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold"
                >
                  View in Revaluations List
                </button>
              </div>
            ) : (
              <div className="space-y-3 text-xs">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Period End Date</label>
                  <input
                    type="date"
                    value={revalDate}
                    onChange={(e) => setRevalDate(e.target.value)}
                    className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-blue-500"
                  />
                  <span className="text-[10px] text-slate-500 mt-0.5 block">
                    e.g. 2026-11-30. October 2026 is protected and will return authoritative JE2611-0314.
                  </span>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Closing Exchange Rate (IDR/USD)</label>
                  <input
                    type="text"
                    value={revalRate}
                    onChange={(e) => setRevalRate(e.target.value)}
                    placeholder="18200"
                    className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-mono focus:ring-1 focus:ring-blue-500"
                  />
                  <span className="text-[10px] text-slate-500 mt-0.5 block">
                    Official JISDOR or central bank reference rate
                  </span>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Rate Source Reference</label>
                  <input
                    type="text"
                    value={revalSource}
                    onChange={(e) => setRevalSource(e.target.value)}
                    className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div className="pt-2 flex items-center justify-end gap-2 border-t border-slate-200">
                  <button
                    type="button"
                    onClick={() => setShowRevalModal(false)}
                    className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={revalRunning}
                    onClick={handleRunRevaluation}
                    className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-semibold flex items-center gap-1.5"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${revalRunning ? 'animate-spin' : ''}`} />
                    {revalRunning ? 'Executing...' : 'Run Revaluation'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
