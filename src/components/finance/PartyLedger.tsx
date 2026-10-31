import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { type CompanySnapshot, FALLBACK_COMPANY } from '../../types/company';
import { CompanyLogo } from '../CompanyLogo';
import { SearchableSelect } from '../SearchableSelect';
import { Users, Building2, Download, Mail, RefreshCw } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { useFinance } from '../../contexts/FinanceContext';
import { FINANCE_RECONCILIATION_REFRESH_EVENT } from './bankTransactionLinking';
import { formatCurrency } from '../../utils/currency';
import { calculateCanonicalCashPayable } from '../../utils/taxCalculations';
import { getEffectiveExpensePostingStates, isEffectiveExpensePosting } from '../../services/expensePostingLifecycle';
import DirectorLedgerView from './DirectorLedgerView';

interface Party {
  id: string;
  name: string;
  type: 'customer' | 'supplier' | 'staff' | 'director';
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  npwp?: string;
}

interface LedgerEntry {
  id: string;
  entry_date: string;
  particulars: string;
  reference: string;
  debit: number;
  credit: number;
  running_balance: number;
  currency?: string;
  exchange_rate?: number | null;
  functional_amount?: number;
  functional_debit?: number;
  functional_credit?: number;
  type: 'invoice' | 'payment' | 'receipt' | 'opening';
}

interface ImportCostEntry {
  id: string;
  expense_date: string;
  voucher_number: string;
  invoice_number: string;
  category: string;
  description: string;
  bm_amount: number;
  ppn_amount: number;
  pph_amount: number;
  total_amount: number;
  paid_amount: number;
  payment_status: 'paid' | 'unpaid' | 'partial';
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (val?: string | null): boolean => Boolean(val && UUID_REGEX.test(val.trim()));

export default function PartyLedger() {
  const { dateRange: globalDateRange } = useFinance();
  const printRef = useRef<HTMLDivElement>(null);
  const [partyType, setPartyType] = useState<'customer' | 'supplier' | 'staff' | 'director'>('customer');
  const [supplierSubView, setSupplierSubView] = useState<'payable' | 'advances' | 'import_customs'>('payable');
  const [supplierCurrency, setSupplierCurrency] = useState<'USD' | 'IDR'>('IDR');
  const [parties, setParties] = useState<Party[]>([]);
  const [selectedParty, setSelectedParty] = useState<string>('');
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [importCostEntries, setImportCostEntries] = useState<ImportCostEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingImportCosts, setLoadingImportCosts] = useState(false);
  const [openingBalance, setOpeningBalance] = useState(0);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [co, setCo] = useState<CompanySnapshot>(FALLBACK_COMPANY);

  useEffect(() => {
    supabase
      .from('company_profiles')
      .select('company_name, company_address, company_phone, company_email, company_tax_id, company_logo_url, pbf_license, cdob_certificate')
      .lte('effective_from', new Date().toISOString().split('T')[0])
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => { if (data) setCo(data as CompanySnapshot); });
  }, []);

  useEffect(() => {
    loadParties();
  }, [partyType]);

  useEffect(() => {
    if (selectedParty) {
      loadLedgerEntries();
      if (partyType === 'supplier' && supplierSubView === 'import_customs') {
        loadImportCosts();
      }
    } else {
      setLedgerEntries([]);
      setOpeningBalance(0);
      setImportCostEntries([]);
    }
  }, [selectedParty, globalDateRange.startDate, globalDateRange.endDate, partyType, supplierSubView]);

  useEffect(() => {
    const refresh = () => {
      if (selectedParty) {
        void loadLedgerEntries();
        if (partyType === 'supplier') void loadImportCosts();
      }
    };
    window.addEventListener(FINANCE_RECONCILIATION_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(FINANCE_RECONCILIATION_REFRESH_EVENT, refresh);
  });

  const loadParties = async () => {
    if (partyType === 'director') {
      const { data } = await supabase
        .from('loans')
        .select('counterparty_name, counterparty_type')
        .order('counterparty_name');
      if (data) {
        const uniqueNames = Array.from(new Set(data.map(d => d.counterparty_name).filter(Boolean)));
        setParties(uniqueNames.map(name => ({
          id: name,
          name: `${name} (Director / Loan)`,
          type: 'director' as const,
        })));
      }
      setSelectedParty('');
      return;
    }

    if (partyType === 'staff') {
      const { data } = await supabase
        .from('finance_staff_master')
        .select('id, full_name, employee_code, department, npwp')
        .order('full_name');
      if (data) {
        setParties(data.map(p => ({
          id: p.id,
          name: p.employee_code ? `${p.full_name} (${p.employee_code})` : p.full_name,
          type: 'staff' as const,
          address: p.department || undefined,
          npwp: p.npwp || undefined,
        })));
      }
      setSelectedParty('');
      return;
    }

    const tableName = partyType === 'customer' ? 'customers' : 'suppliers';

    const { data } = await supabase
      .from(tableName)
      .select('id, company_name, email, phone, address, city, npwp')
      .order('company_name');

    if (data) {
      setParties(data.map(p => ({
        ...p,
        name: p.company_name,
        type: partyType
      })));
    }
    setSelectedParty('');
  };

  const loadImportCosts = async () => {
    if (!selectedParty || partyType !== 'supplier') return;
    setLoadingImportCosts(true);
    try {
      const { data, error } = await supabase
        .from('finance_expenses')
        .select('id, expense_date, voucher_number, invoice_number, description, amount, pib_bm_amount, ppn_amount, pib_ppn_amount, pph_amount, pib_pph_amount, expense_category, paid_amount, approval_status, payment_method')
        .eq('supplier_id', selectedParty)
        .in('expense_category', ['pib_import', 'import_broker', 'loading_import', 'port_charges'])
        .order('expense_date', { ascending: false });

      if (error) {
        console.error('Error loading import costs:', error);
        return;
      }

      if (data) {
        setImportCostEntries(data.map(d => ({
          id: d.id,
          expense_date: d.expense_date,
          voucher_number: d.voucher_number || '',
          invoice_number: (!d.invoice_number || isUuid(d.invoice_number)) ? (d.voucher_number || '') : d.invoice_number,
          category: d.expense_category,
          description: d.description || '',
          bm_amount: Number(d.pib_bm_amount || 0),
          ppn_amount: Number(d.ppn_amount || d.pib_ppn_amount || 0),
          pph_amount: Number(d.pph_amount || d.pib_pph_amount || 0),
          total_amount: Number(d.amount || 0),
          paid_amount: Number(d.paid_amount || 0),
          payment_status: (Number(d.paid_amount || 0) >= Number(d.amount || 0) - 0.01) ? 'paid' : (Number(d.paid_amount || 0) > 0 ? 'partial' : 'unpaid'),
        })));
      }
    } finally {
      setLoadingImportCosts(false);
    }
  };

  // Fetch ledger entries for [fromDate, toDate]. fromDate null = from the
  // beginning of time (used to compute the opening balance before the period).
  const fetchEntries = async (fromDate: string | null, toDate: string): Promise<LedgerEntry[]> => {
    const entries: LedgerEntry[] = [];
    const toFunctionalIDR = (amount: number, currency?: string | null, rate?: number | null) =>
      currency === 'USD' ? (rate && rate > 0 ? amount * rate : 0) : amount;
    const currencyDetail = (amount: number, currency?: string | null, rate?: number | null) =>
      currency === 'USD'
        ? ` (${formatCurrency(amount, 'USD')}${rate && rate > 0 ? ` @ ${formatCurrency(rate, 'IDR')}/USD` : ' — exchange rate missing'})`
        : '';
    const dateRange = <T,>(q: T, col: string): T => {
      let qq = (q as any).lte(col, toDate);
      if (fromDate) qq = qq.gte(col, fromDate);
      return qq;
    };
    const onlyEffectiveExpenses = async <T extends { id: string }>(rows: T[] | null): Promise<T[]> => {
      if (!rows?.length) return [];
      const states = await getEffectiveExpensePostingStates(rows.map(row => row.id));
      return rows.filter(row => isEffectiveExpensePosting(states.get(row.id)?.effective_posting_state));
    };

    if (partyType === 'customer') {
      const { data: invoices } = await dateRange(
        supabase
          .from('sales_invoices')
          .select('id, invoice_date, invoice_number, total_amount, payment_status, notes')
          .eq('customer_id', selectedParty),
        'invoice_date',
      ).order('invoice_date');

      if (invoices) {
        invoices
          .filter(inv => !inv.notes?.includes('[CANCELLED') && !inv.notes?.toLowerCase().startsWith('cancelled'))
          .forEach(inv => {
            entries.push({
              id: inv.id,
              entry_date: inv.invoice_date,
              particulars: `Sales Invoice - ${inv.payment_status || 'Unpaid'}`,
              reference: inv.invoice_number,
              debit: inv.total_amount,
              credit: 0,
              running_balance: 0,
              type: 'invoice',
            });
          });
      }

      const { data: receipts } = await dateRange(
        supabase
          .from('receipt_vouchers')
          .select('id, voucher_date, voucher_number, amount, description, transaction_currency, currency_code, exchange_rate')
          .eq('customer_id', selectedParty)
          .eq('is_posted', true),
        'voucher_date',
      ).order('voucher_date');

      if (receipts) {
        receipts.forEach(rec => {
          const currency = rec.transaction_currency || rec.currency_code || 'IDR';
          entries.push({
            id: rec.id,
            entry_date: rec.voucher_date,
            particulars: `${rec.description || 'Receipt'}${currencyDetail(rec.amount, currency, rec.exchange_rate)}`,
            reference: rec.voucher_number,
            debit: 0,
            credit: toFunctionalIDR(rec.amount, currency, rec.exchange_rate),
            running_balance: 0,
            type: 'receipt',
          });
        });
      }

      const { data: creditNotes } = await dateRange(
        supabase
          .from('credit_notes')
          .select(`
            id, credit_note_date, credit_note_number, total_amount, original_invoice_id,
            sales_invoices:original_invoice_id(invoice_number),
            credit_note_items(quantity, products(product_name))
          `)
          .eq('customer_id', selectedParty)
          .eq('status', 'approved'),
        'credit_note_date',
      ).order('credit_note_date');

      if (creditNotes) {
        creditNotes.forEach((cn: any) => {
          const invNum = cn.sales_invoices?.invoice_number;
          const totalQty = (cn.credit_note_items || []).reduce((sum: number, it: any) => sum + (Number(it.quantity) || 0), 0);
          const qtyStr = totalQty > 0 ? ` (${totalQty.toLocaleString('id-ID')} kg)` : '';
          const invStr = invNum ? ` - Inv: ${invNum}` : '';

          entries.push({
            id: cn.id,
            entry_date: cn.credit_note_date,
            particulars: `Credit Note${invStr}${qtyStr}`,
            reference: cn.credit_note_number,
            debit: 0,
            credit: cn.total_amount,
            running_balance: 0,
            type: 'receipt',
          });
        });
      }

      // Customer Refunds Paid (Money OUT to Customer - Debits Customer Ledger)
      const { data: customerRefunds } = await dateRange(
        supabase
          .from('payment_vouchers')
          .select('id, voucher_date, voucher_number, amount, description, payment_purpose, transaction_currency, payment_currency, currency_code, exchange_rate')
          .eq('customer_id', selectedParty)
          .eq('is_posted', true),
        'voucher_date',
      ).order('voucher_date');

      if (customerRefunds) {
        customerRefunds.forEach(ref => {
          const currency = ref.transaction_currency || ref.payment_currency || ref.currency_code || 'IDR';
          const primaryAmount = Number(ref.amount || 0);
          entries.push({
            id: ref.id,
            entry_date: ref.voucher_date,
            particulars: `Customer Refund Paid - ${ref.description || ref.payment_purpose || 'Refund'}${currencyDetail(primaryAmount, currency, ref.exchange_rate)}`,
            reference: ref.voucher_number,
            debit: toFunctionalIDR(primaryAmount, currency, ref.exchange_rate),
            credit: 0,
            running_balance: 0,
            type: 'payment',
          });
        });
      }
    } else if (partyType === 'supplier' && supplierSubView === 'advances') {
      const advQuery = supabase
        .from('journal_entry_lines')
        .select('id, debit, credit, description, journal_entry_id, transaction_currency, exchange_rate, journal_entries!inner(id, reference_id, reference_number, entry_number, entry_date, source_module, is_posted, is_reversed), chart_of_accounts!inner(code)')
        .eq('supplier_id', selectedParty)
        .eq('chart_of_accounts.code', '1170')
        .eq('journal_entries.is_posted', true)
        .eq('journal_entries.is_reversed', false);
      const advLines = await dateRange(advQuery, 'journal_entries.entry_date');
      if (advLines.data) {
        advLines.data.forEach((line: any) => {
          const debit = Number(line.debit || 0);
          const credit = Number(line.credit || 0);
          const fxRate = Number(line.exchange_rate || 1);
          entries.push({
            id: line.id,
            entry_date: line.journal_entries?.entry_date || '',
            particulars: line.description || (debit > 0 ? 'Supplier Advance Paid' : 'Supplier Advance Refund / Offset'),
            reference: line.journal_entries?.reference_number || line.journal_entries?.entry_number || '',
            currency: line.transaction_currency || 'IDR',
            debit,
            credit,
            exchange_rate: fxRate > 0 ? fxRate : null,
            functional_amount: debit > 0 ? debit : credit,
            functional_debit: debit,
            functional_credit: credit,
            running_balance: 0,
            type: debit > 0 ? 'payment' : 'receipt',
          });
        });
      }
      return entries;
    } else if (partyType === 'supplier') {
      // 1. Detect if this supplier is foreign currency (USD)
      const { data: usdCheck } = await supabase
        .from('purchase_invoices')
        .select('id, currency')
        .eq('supplier_id', selectedParty)
        .eq('currency', 'USD')
        .limit(1);
      const isUsdSupplier = Boolean(usdCheck && usdCheck.length > 0);

      // 2. Fetch purchase invoices (Supplier AP Credit)
      const { data: invoices } = await dateRange(
        supabase
          .from('purchase_invoices')
          .select('id, invoice_date, invoice_number, total_amount, paid_amount, balance_amount, status, currency, exchange_rate')
          .eq('supplier_id', selectedParty),
        'invoice_date',
      ).order('invoice_date');

      if (invoices) {
        invoices.forEach(inv => {
          const invCurr = inv.currency || (isUsdSupplier ? 'USD' : 'IDR');
          const isUsd = invCurr === 'USD';
          const primaryAmount = Number(inv.total_amount || 0);
          const fxRate = Number(inv.exchange_rate || 0);
          const functionalAmount = isUsd
            ? (fxRate > 0 ? primaryAmount * fxRate : 0)
            : primaryAmount;

          entries.push({
            id: inv.id,
            entry_date: inv.invoice_date,
            particulars: `Purchase Invoice - ${inv.status || 'Unpaid'}`,
            reference: inv.invoice_number,
            currency: invCurr,
            debit: 0,
            credit: primaryAmount,
            exchange_rate: fxRate > 0 ? fxRate : null,
            functional_amount: functionalAmount,
            functional_debit: 0,
            functional_credit: functionalAmount,
            running_balance: 0,
            type: 'invoice',
          });
        });
      }

      // 3. Genuine non-import expense bills (A/P): approved vendor bills booked
      // against this supplier (e.g. professional services, maintenance).
      // PIB import expenses, customs broker, and port/clearing charges are
      // 100% EXCLUDED from the supplier payable ledger.
      const { data: expenseBills } = await dateRange(
        supabase
          .from('finance_expenses')
          .select('id, expense_date, invoice_number, voucher_number, amount, expense_category, ppn_amount, pph_amount, stamp_duty_amount, bank_charges_amount, broker_items, paid_amount, transaction_currency, currency_code, exchange_rate')
          .eq('supplier_id', selectedParty)
          .not('expense_category', 'in', '("pib_import","import_broker","loading_import","port_charges")')
          .is('payment_method', null)
          .eq('approval_status', 'approved'),
        'expense_date',
      ).order('expense_date');

      const effectiveExpenseBills = await onlyEffectiveExpenses(expenseBills);
      if (effectiveExpenseBills.length) {
        effectiveExpenseBills.forEach(bill => {
          const payable = calculateCanonicalCashPayable(bill);
          const outstanding = payable - (bill.paid_amount ?? 0);
          const currency = bill.transaction_currency || bill.currency_code || 'IDR';
          const isUsd = currency === 'USD';
          const fxRate = Number(bill.exchange_rate || 0);
          const functionalAmount = isUsd
            ? (fxRate > 0 ? payable * fxRate : 0)
            : payable;

          entries.push({
            id: bill.id,
            entry_date: bill.expense_date,
            particulars: `Expense Bill - ${(bill.expense_category || '').replace(/_/g, ' ')}${outstanding <= 0.01 ? ' (Paid)' : ''}`,
            reference: (!bill.invoice_number || isUuid(bill.invoice_number)) ? (bill.voucher_number || '') : (bill.voucher_number || bill.invoice_number || ''),
            currency,
            debit: 0,
            credit: payable,
            exchange_rate: fxRate > 0 ? fxRate : null,
            functional_amount: functionalAmount,
            functional_debit: 0,
            functional_credit: functionalAmount,
            running_balance: 0,
            type: 'invoice',
          });
        });
      }

      // 4. Supplier Payment Vouchers (Supplier AP Debit)
      const { data: payments } = await dateRange(
        supabase
          .from('payment_vouchers')
          .select('id, voucher_date, voucher_number, amount, description, transaction_currency, payment_currency, currency_code, exchange_rate, journal_entry_id, payment_purpose, settlement_against')
          .eq('supplier_id', selectedParty)
          .eq('is_posted', true),
        'voucher_date',
      ).order('voucher_date');

      const pvJeIds = new Set<string>();
      const pvVoucherNos = new Set<string>();

      if (payments) {
        payments.forEach(pay => {
          if (pay.payment_purpose === 'supplier_advance' || pay.settlement_against === 'advance') return;
          if (pay.journal_entry_id) pvJeIds.add(pay.journal_entry_id);
          if (pay.voucher_number) pvVoucherNos.add(pay.voucher_number);

          const payCurr = pay.transaction_currency || (isUsdSupplier ? 'USD' : (pay.payment_currency || pay.currency_code || 'IDR'));
          const isUsd = isUsdSupplier || payCurr === 'USD';
          const primaryAmount = Number(pay.amount || 0);
          const fxRate = Number(pay.exchange_rate || 0);
          const functionalAmount = isUsd
            ? (fxRate > 0 ? primaryAmount * fxRate : (pay.payment_currency === 'IDR' ? primaryAmount : 0))
            : primaryAmount;

          let particulars = pay.description || 'Payment';
          if (isUsd && pay.payment_currency === 'IDR' && fxRate > 1) {
            particulars += ` (Bank settlement: ${formatCurrency(functionalAmount, 'IDR')})`;
          }

          entries.push({
            id: pay.id,
            entry_date: pay.voucher_date,
            particulars,
            reference: pay.voucher_number,
            currency: isUsd ? 'USD' : payCurr,
            debit: primaryAmount,
            credit: 0,
            exchange_rate: fxRate > 0 ? fxRate : null,
            functional_amount: functionalAmount,
            functional_debit: functionalAmount,
            functional_credit: 0,
            running_balance: 0,
            type: 'payment',
          });
        });
      }

      // 4b. Supplier Refund Receipts (Supplier AP Credit / Advance Recovery)
      const { data: supplierRefunds } = await dateRange(
        supabase
          .from('receipt_vouchers')
          .select('id, voucher_date, voucher_number, amount, description, payment_purpose, transaction_currency, currency_code, exchange_rate, settlement_discount, adjustment_reason, journal_entry_id')
          .eq('supplier_id', selectedParty)
          .eq('is_posted', true),
        'voucher_date',
      ).order('voucher_date');

      const rvJeIds = new Set<string>();
      const rvVoucherNos = new Set<string>();

      if (supplierRefunds) {
        supplierRefunds.forEach(ref => {
          if (ref.payment_purpose === 'supplier_refund') return;
          if (ref.journal_entry_id) rvJeIds.add(ref.journal_entry_id);
          if (ref.voucher_number) rvVoucherNos.add(ref.voucher_number);

          const currency = ref.transaction_currency || ref.currency_code || (isUsdSupplier ? 'USD' : 'IDR');
          const isUsd = currency === 'USD';
          const refundAmount = Number(ref.amount || 0);
          const discountDiff = Number(ref.settlement_discount || 0);
          const totalSettled = refundAmount + discountDiff;
          const fxRate = Number(ref.exchange_rate || 0);
          const functionalAmount = isUsd ? (fxRate > 0 ? totalSettled * fxRate : 0) : totalSettled;

          let particulars = `Supplier Refund Received${discountDiff > 0 ? ` (Settled: ${formatCurrency(totalSettled, currency)}, Write-off: ${formatCurrency(discountDiff, currency)})` : ''}`;
          if (ref.description) {
            particulars += ` - ${ref.description}`;
          }

          entries.push({
            id: ref.id,
            entry_date: ref.voucher_date,
            particulars,
            reference: ref.voucher_number,
            currency: isUsd ? 'USD' : currency,
            debit: 0,
            credit: totalSettled,
            exchange_rate: fxRate > 0 ? fxRate : null,
            functional_amount: functionalAmount,
            functional_debit: 0,
            functional_credit: functionalAmount,
            running_balance: 0,
            type: 'receipt',
          });
        });
      }

      // 5. Customs broker bills & direct GL 2110 settlements (bank recon payments, historical repairs, adjustments)
      // Any GL line on Account 2110 for this supplier that is not already captured by purchase invoices,
      // non-import expense bills, or payment vouchers is included here to ensure ledger and GL agree.
      if (!isUsdSupplier) {
        const apLinesQuery = supabase
          .from('journal_entry_lines')
          .select('id, entry_date:journal_entries!inner(entry_date), debit, credit, description, journal_entry_id, journal_entries!inner(id, reference_id, reference_number, entry_number, source_module, transaction_category, is_posted, is_reversed), chart_of_accounts!inner(code)')
          .eq('supplier_id', selectedParty)
          .eq('chart_of_accounts.code', '2110')
          .eq('journal_entries.is_posted', true)
          .eq('journal_entries.is_reversed', false);
        const apLines = await dateRange(apLinesQuery, 'journal_entries.entry_date');
        if (apLines.data) {
          const piIds = new Set<string>((invoices || []).map(p => p.id).filter(Boolean));
          const piNos = new Set<string>((invoices || []).map(p => p.invoice_number).filter(Boolean));
          const expIds = new Set<string>((effectiveExpenseBills || []).map(b => b.id).filter(Boolean));
          const expVoucherNos = new Set<string>((effectiveExpenseBills || []).map(b => b.voucher_number).filter(Boolean));

          interface ApJournalLine {
            id: string;
            debit: number | string | null;
            credit: number | string | null;
            description: string | null;
            journal_entry_id: string;
            entry_date?: { entry_date?: string };
            journal_entries?: {
              id: string;
              entry_date?: string;
              reference_id?: string | null;
              reference_number?: string | null;
              entry_number?: string | null;
              source_module?: string | null;
              transaction_category?: string | null;
              is_posted: boolean;
              is_reversed: boolean;
            };
          }

          const otherApLines = (apLines.data as unknown as ApJournalLine[]).filter((line: ApJournalLine) => {
            const je = line.journal_entries;
            if (!je) return false;
            if (pvJeIds.has(line.journal_entry_id) || pvJeIds.has(je.id) || (je.reference_number && pvVoucherNos.has(je.reference_number))) return false;
            if (rvJeIds.has(line.journal_entry_id) || rvJeIds.has(je.id) || (je.reference_number && rvVoucherNos.has(je.reference_number))) return false;
            if ((je.reference_id && piIds.has(je.reference_id)) || (je.reference_number && piNos.has(je.reference_number))) return false;
            const rawRef = je.reference_number || '';
            const refExpId = rawRef.startsWith('EXP-') ? rawRef.substring(4) : '';
            if ((je.reference_id && expIds.has(je.reference_id)) || (refExpId && expIds.has(refExpId)) || expVoucherNos.has(rawRef)) return false;
            return true;
          });

          const candidateExpIds = Array.from(new Set(
            otherApLines
              .map((line: ApJournalLine) => {
                const rawRef = line.journal_entries?.reference_number || '';
                if (rawRef.startsWith('EXP-')) {
                  const sub = rawRef.substring(4);
                  if (isUuid(sub)) return sub;
                }
                if (line.journal_entries?.reference_id && isUuid(line.journal_entries.reference_id)) {
                  return line.journal_entries.reference_id;
                }
                return null;
              })
              .filter(Boolean)
          )) as string[];

          let expVoucherMap: Record<string, string> = {};
          if (candidateExpIds.length > 0) {
            const { data: bExps } = await supabase
              .from('finance_expenses')
              .select('id, voucher_number, invoice_number')
              .in('id', candidateExpIds);
            if (bExps) {
              expVoucherMap = Object.fromEntries(
                bExps.map((e: { id: string; voucher_number?: string | null; invoice_number?: string | null }) => [
                  e.id,
                  e.voucher_number || (!isUuid(e.invoice_number) ? e.invoice_number : '') || ''
                ])
              );
            }
          }

          otherApLines.forEach((line: ApJournalLine) => {
            const entryDate = line.entry_date?.entry_date || line.journal_entries?.entry_date || '';
            const lineDebit = Number(line.debit || 0);
            const lineCredit = Number(line.credit || 0);
            const rawRef = line.journal_entries?.reference_number || '';
            const refId = line.journal_entries?.reference_id || '';
            let lineRef = '';
            if (rawRef.startsWith('PV/') || rawRef.startsWith('EXP/')) {
              lineRef = rawRef;
            } else if (refId && expVoucherMap[refId]) {
              lineRef = expVoucherMap[refId];
            } else if (rawRef.startsWith('EXP-')) {
              const sub = rawRef.substring(4);
              if (expVoucherMap[sub]) {
                lineRef = expVoucherMap[sub];
              } else if (sub.startsWith('PAY-')) {
                const payId = sub.substring(4);
                lineRef = (refId && expVoucherMap[refId]) || (isUuid(payId) ? '' : sub) || line.journal_entries?.entry_number || '';
              } else if (!isUuid(sub)) {
                lineRef = sub;
              } else {
                lineRef = line.journal_entries?.entry_number || '';
              }
            } else if (rawRef.startsWith('HR-PAY-') || rawRef.startsWith('HR-')) {
              lineRef = (refId && expVoucherMap[refId]) || line.journal_entries?.entry_number || '';
            } else if (isUuid(rawRef)) {
              lineRef = expVoucherMap[rawRef] || line.journal_entries?.entry_number || '';
            } else if (rawRef) {
              lineRef = rawRef;
            } else {
              lineRef = line.journal_entries?.entry_number || '';
            }

            const isCredit = lineCredit > 0;
            const defaultParticulars = isCredit
              ? (line.journal_entries?.transaction_category === 'import_broker' ? 'Customs Broker Invoice' : 'Supplier Invoice')
              : (line.journal_entries?.source_module === 'expense_payment' ? 'Expense Bank Payment' : 'Supplier Payment');

            entries.push({
              id: `${line.journal_entry_id}:${line.id}`,
              entry_date: entryDate,
              particulars: line.description || defaultParticulars,
              reference: lineRef,
              currency: 'IDR',
              debit: lineDebit,
              credit: lineCredit,
              exchange_rate: 1,
              functional_amount: lineDebit || lineCredit,
              functional_debit: lineDebit,
              functional_credit: lineCredit,
              running_balance: 0,
              type: isCredit ? 'invoice' : 'payment',
            });
          });
        }
      }
    } else if (partyType === 'staff') {
      // Staff ledger — one running account per staff member:
      //   Cr  salary / staff bills recorded as outstanding (company owes staff)
      //   Dr  salary advance applications and final payments
      // Salary Advance issuance is an asset movement, not a reduction of the
      // employee salary payable, so it is omitted from this payable ledger.
      const { data: bills } = await dateRange(
        supabase
          .from('finance_expenses')
          .select('id, expense_date, invoice_number, voucher_number, amount, expense_category, ppn_amount, pph_amount, stamp_duty_amount, bank_charges_amount, broker_items, paid_amount, transaction_currency, currency_code, exchange_rate')
          .eq('staff_id', selectedParty)
          .neq('expense_category', 'staff_advance')
          .is('payment_method', null)
          .eq('approval_status', 'approved'),
        'expense_date',
      ).order('expense_date');

      const effectiveBills = await onlyEffectiveExpenses(bills);
      if (effectiveBills.length) {
        effectiveBills.forEach(bill => {
          const payable = calculateCanonicalCashPayable(bill);
          const outstanding = payable - (bill.paid_amount ?? 0);
          const currency = bill.transaction_currency || bill.currency_code || 'IDR';
          entries.push({
            id: bill.id,
            entry_date: bill.expense_date,
            particulars: `${(bill.expense_category || '').replace(/_/g, ' ')} Bill${outstanding <= 0.01 ? ' (Paid)' : ''}${currencyDetail(payable, currency, bill.exchange_rate)}`,
            reference: (!bill.invoice_number || isUuid(bill.invoice_number)) ? (bill.voucher_number || '') : (bill.voucher_number || bill.invoice_number || ''),
            debit: 0,
            credit: toFunctionalIDR(payable, currency, bill.exchange_rate),
            running_balance: 0,
            type: 'invoice',
          });
        });
      }

      const { data: advances } = await dateRange(
        supabase
          .from('finance_expenses')
          .select('id, expense_date, invoice_number, voucher_number, amount, transaction_currency, currency_code, exchange_rate')
          .eq('staff_id', selectedParty)
          .eq('expense_category', 'staff_advance')
          .not('payment_method', 'is', null)
          .eq('approval_status', 'approved'),
        'expense_date',
      ).order('expense_date');

      const effectiveAdvances = await onlyEffectiveExpenses(advances);
      if (effectiveAdvances.length) {
        effectiveAdvances.forEach(adv => {
          const currency = adv.transaction_currency || adv.currency_code || 'IDR';
          entries.push({
            id: adv.id,
            entry_date: adv.expense_date,
            particulars: `Staff Advance Given${currencyDetail(adv.amount, currency, adv.exchange_rate)}`,
            reference: (!adv.invoice_number || isUuid(adv.invoice_number)) ? (adv.voucher_number || '') : (adv.voucher_number || adv.invoice_number || ''),
            debit: toFunctionalIDR(adv.amount, currency, adv.exchange_rate),
            credit: 0,
            running_balance: 0,
            type: 'payment',
          });
        });
      }

      const { data: vouchers } = await dateRange(
        supabase
          .from('payment_vouchers')
          .select('id, voucher_date, voucher_number, amount, description, payment_method, payment_purpose, transaction_currency, payment_currency, currency_code, exchange_rate')
          .eq('staff_id', selectedParty)
          .eq('is_posted', true),
        'voucher_date',
      ).order('voucher_date');

      if (vouchers) {
        vouchers.forEach(pv => {
          const isAdjustment = pv.payment_method === 'advance_adjustment';
          if (pv.payment_purpose === 'salary_advance') return;
          const currency = pv.transaction_currency || pv.payment_currency || pv.currency_code || 'IDR';
          const functionalAmount = toFunctionalIDR(pv.amount, currency, pv.exchange_rate);
          entries.push({
            id: pv.id,
            entry_date: pv.voucher_date,
            particulars: isAdjustment
              ? `Less Salary Advance${currencyDetail(pv.amount, currency, pv.exchange_rate)}`
              : `${pv.description || 'Payment to Staff'}${currencyDetail(pv.amount, currency, pv.exchange_rate)}`,
            reference: (!pv.voucher_number || isUuid(pv.voucher_number)) ? '' : pv.voucher_number,
            debit: functionalAmount,
            credit: 0,
            running_balance: 0,
            type: 'payment',
          });
        });
      }
    } else if (partyType === 'director') {
      const { data: loanRows } = await dateRange(
        supabase
          .from('loans')
          .select('id, loan_number, loan_date, loan_type, principal_amount, currency, transaction_currency, exchange_rate, description, status')
          .eq('counterparty_name', selectedParty),
        'loan_date',
      ).order('loan_date');

      if (loanRows) {
        loanRows.forEach(loan => {
          const currency = loan.transaction_currency || loan.currency || 'IDR';
          const functionalAmount = toFunctionalIDR(Number(loan.principal_amount || 0), currency, loan.exchange_rate);
          const isTaken = loan.loan_type === 'taken';
          entries.push({
            id: `loan-${loan.id}`,
            entry_date: loan.loan_date,
            particulars: `Loan ${isTaken ? 'Taken (Received)' : 'Given (Disbursed)'} - ${loan.description || loan.loan_number}`,
            reference: loan.loan_number,
            debit: isTaken ? 0 : functionalAmount,
            credit: isTaken ? functionalAmount : 0,
            running_balance: 0,
            type: isTaken ? 'receipt' : 'payment',
          });
        });
      }

      const { data: txRows } = await dateRange(
        supabase
          .from('loan_transactions')
          .select('id, transaction_number, transaction_date, transaction_type, amount, principal_amount, transaction_currency, exchange_rate, description, status, loans!inner(counterparty_name, loan_type, loan_number)')
          .eq('loans.counterparty_name', selectedParty)
          .eq('status', 'posted'),
        'transaction_date',
      ).order('transaction_date');

      if (txRows) {
        txRows.forEach((tx: any) => {
          const loan = Array.isArray(tx.loans) ? tx.loans[0] : tx.loans;
          const currency = tx.transaction_currency || 'IDR';
          const amount = Number(tx.principal_amount || tx.amount || 0);
          const functionalAmount = toFunctionalIDR(amount, currency, tx.exchange_rate);
          const wasTaken = loan?.loan_type === 'taken';
          entries.push({
            id: `loan-tx-${tx.id}`,
            entry_date: tx.transaction_date,
            particulars: `Loan Repayment - ${tx.description || tx.transaction_number} (${loan?.loan_number || ''})`,
            reference: tx.transaction_number,
            debit: wasTaken ? functionalAmount : 0,
            credit: wasTaken ? 0 : functionalAmount,
            running_balance: 0,
            type: wasTaken ? 'payment' : 'receipt',
          });
        });
      }
    }

    entries.sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());
    return resolveCanonicalReferences(entries);
  };

  const resolveCanonicalReferences = async (entries: LedgerEntry[]): Promise<LedgerEntry[]> => {
    if (!entries.length) return entries;

    const expenseUuids = new Set<string>();
    const paymentUuids = new Set<string>();
    const invoiceUuids = new Set<string>();

    entries.forEach(entry => {
      const ref = (entry.reference || '').trim();
      if (!ref) return;
      if (ref.startsWith('EXP-')) {
        const idPart = ref.substring(4);
        if (isUuid(idPart)) expenseUuids.add(idPart);
      } else if (ref.startsWith('PV-')) {
        const idPart = ref.substring(3);
        if (isUuid(idPart)) paymentUuids.add(idPart);
      } else if (isUuid(ref)) {
        if (entry.type === 'payment') {
          paymentUuids.add(ref);
          expenseUuids.add(ref);
        } else {
          expenseUuids.add(ref);
          invoiceUuids.add(ref);
        }
      }
    });

    const [expMap, pvMap, piMap, siMap] = await Promise.all([
      expenseUuids.size > 0
        ? supabase
            .from('finance_expenses')
            .select('id, voucher_number, invoice_number')
            .in('id', Array.from(expenseUuids))
            .then(res => Object.fromEntries((res.data || []).map((x: any) => [x.id, x.voucher_number || (!isUuid(x.invoice_number) ? x.invoice_number : '') || ''])))
        : Promise.resolve({} as Record<string, string>),
      paymentUuids.size > 0
        ? supabase
            .from('payment_vouchers')
            .select('id, voucher_number')
            .in('id', Array.from(paymentUuids))
            .then(res => Object.fromEntries((res.data || []).map((x: any) => [x.id, x.voucher_number || ''])))
        : Promise.resolve({} as Record<string, string>),
      invoiceUuids.size > 0
        ? supabase
            .from('purchase_invoices')
            .select('id, invoice_number')
            .in('id', Array.from(invoiceUuids))
            .then(res => Object.fromEntries((res.data || []).map((x: any) => [x.id, x.invoice_number || ''])))
        : Promise.resolve({} as Record<string, string>),
      invoiceUuids.size > 0
        ? supabase
            .from('sales_invoices')
            .select('id, invoice_number')
            .in('id', Array.from(invoiceUuids))
            .then(res => Object.fromEntries((res.data || []).map((x: any) => [x.id, x.invoice_number || ''])))
        : Promise.resolve({} as Record<string, string>),
    ]);

    return entries.map(entry => {
      let ref = (entry.reference || '').trim();
      if (ref.startsWith('EXP-')) {
        const idPart = ref.substring(4);
        if (isUuid(idPart) && expMap[idPart]) {
          ref = expMap[idPart];
        }
      } else if (ref.startsWith('PV-')) {
        const idPart = ref.substring(3);
        if (isUuid(idPart) && pvMap[idPart]) {
          ref = pvMap[idPart];
        }
      } else if (isUuid(ref)) {
        ref = expMap[ref] || pvMap[ref] || piMap[ref] || siMap[ref] || '';
      }

      let particulars = entry.particulars;
      if (particulars && particulars.includes('Salary Advance Recovery - ')) {
        const parts = particulars.split('Salary Advance Recovery - ');
        const candidateUuid = parts[1]?.trim();
        if (isUuid(candidateUuid) && expMap[candidateUuid]) {
          particulars = `${parts[0]}Salary Advance Recovery - ${expMap[candidateUuid]}`;
        }
      }

      return {
        ...entry,
        reference: ref,
        particulars,
      };
    });
  };

  const loadLedgerEntries = async () => {
    if (!selectedParty) return;

    setLoading(true);
    try {
      let detectedCurrency: 'USD' | 'IDR' = 'IDR';
      if (partyType === 'supplier') {
        const { data: usdCheck } = await supabase
          .from('purchase_invoices')
          .select('id, currency')
          .eq('supplier_id', selectedParty)
          .eq('currency', 'USD')
          .limit(1);
        if (usdCheck && usdCheck.length > 0) {
          detectedCurrency = 'USD';
        }
        setSupplierCurrency(detectedCurrency);
      }

      // Opening balance = net of all transactions before the period start.
      const before = new Date(globalDateRange.startDate);
      before.setDate(before.getDate() - 1);
      const priorEntries = await fetchEntries(null, before.toISOString().split('T')[0]);
      const opening = priorEntries.reduce((s, e) => s + e.debit - e.credit, 0);
      setOpeningBalance(opening);

      const entries = await fetchEntries(globalDateRange.startDate, globalDateRange.endDate);

      let runningBalance = opening;
      entries.forEach(entry => {
        runningBalance += entry.debit - entry.credit;
        entry.running_balance = runningBalance;
      });

      setLedgerEntries(entries);
    } catch (err) {
      console.error('Error loading ledger:', err);
      alert('Failed to load ledger data. Please check console for details.');
    } finally {
      setLoading(false);
    }
  };

  const formatAmount = (amount: number, curr = (partyType === 'supplier' ? supplierCurrency : 'IDR')) => {
    return formatCurrency(amount, curr, { zeroAsDash: true });
  };

  const formatBalance = (balance: number, curr = (partyType === 'supplier' ? supplierCurrency : 'IDR')) => {
    const absBalance = Math.abs(balance);
    if (absBalance < 0.005) {
      return formatCurrency(0, curr);
    }
    const label = balance > 0 ? 'Dr' : 'Cr';
    return `${formatCurrency(absBalance, curr)} ${label}`;
  };

  const totalDebit = ledgerEntries.reduce((sum, e) => sum + e.debit, 0);
  const totalCredit = ledgerEntries.reduce((sum, e) => sum + e.credit, 0);
  const closingBalance = openingBalance + totalDebit - totalCredit;
  const _outstanding = Math.abs(closingBalance);

  const totalFunctionalDebit = ledgerEntries.reduce((sum, e) => sum + (e.functional_debit ?? (e.currency === 'USD' && e.exchange_rate ? e.debit * e.exchange_rate : e.debit)), 0);
  const totalFunctionalCredit = ledgerEntries.reduce((sum, e) => sum + (e.functional_credit ?? (e.currency === 'USD' && e.exchange_rate ? e.credit * e.exchange_rate : e.credit)), 0);

  const exportToPDF = async () => {
    if (!printRef.current) return;

    try {
      const canvas = await html2canvas(printRef.current, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: '#ffffff',
      });

      const imgData = canvas.toDataURL('image/png', 1.0);
      const pdf = new jsPDF('p', 'mm', 'a4');

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = canvas.width;
      const imgHeight = canvas.height;
      const ratio = pdfWidth / imgWidth;
      const scaledHeight = imgHeight * ratio;

      if (scaledHeight > pdfHeight) {
        let position = 0;
        let remainingHeight = scaledHeight;

        while (remainingHeight > 0) {
          pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, scaledHeight);
          remainingHeight -= pdfHeight;
          position -= pdfHeight;

          if (remainingHeight > 0) {
            pdf.addPage();
          }
        }
      } else {
        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, scaledHeight);
      }

      const selectedPartyData = parties.find(p => p.id === selectedParty);
      const docPrefix = partyType === 'supplier' ? 'Supplier_Payable_Ledger' : `${partyType}_Ledger`;
      pdf.save(`${docPrefix}_${selectedPartyData?.name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const sendStatementOfAccount = async () => {
    const selectedPartyData = parties.find(p => p.id === selectedParty);
    if (!selectedPartyData || !selectedPartyData.email) {
      alert('No email address found for this party');
      return;
    }

    if (!confirm(`Send Statement of Account to ${selectedPartyData.email}?`)) {
      return;
    }

    setSendingEmail(true);
    await exportToPDF();
    alert(`PDF downloaded. Please attach and send to ${selectedPartyData.email}`);
    setSendingEmail(false);
  };

  const selectedPartyData = parties.find(p => p.id === selectedParty);

  return (
    <div className="flex flex-col gap-1.5">
      {/* Shared title strip — matches every other Finance page */}
      <div className="flex items-center justify-between h-8 px-2 bg-white border border-gray-200 rounded">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-xs font-bold text-gray-900 truncate flex items-center gap-1.5">
            {partyType === 'customer'
              ? <Users className="w-3 h-3 text-blue-600" />
              : <Building2 className="w-3 h-3 text-purple-600" />}
            {partyType === 'customer'
              ? 'Customer Ledger'
              : partyType === 'supplier'
                ? (supplierSubView === 'payable' ? 'Supplier Payable Ledger' : 'Import / Customs Costs')
                : partyType === 'staff'
                  ? 'Staff Ledger'
                  : 'Director / Loan Subledger'}
          </h1>
          {partyType === 'supplier' && selectedPartyData && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-800">
              Currency: {supplierCurrency}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              void loadLedgerEntries();
              if (partyType === 'supplier') void loadImportCosts();
            }}
            disabled={!selectedParty || loading}
            className="inline-flex items-center gap-1 h-7 px-2 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-3 h-3 ${loading || loadingImportCosts ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={exportToPDF}
            disabled={!selectedParty || ledgerEntries.length === 0}
            className="inline-flex items-center gap-1 h-7 px-2 bg-green-600 text-white rounded text-xs font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-3 h-3" />
            Export PDF
          </button>
          <button
            onClick={sendStatementOfAccount}
            disabled={!selectedParty || ledgerEntries.length === 0 || sendingEmail}
            className="inline-flex items-center gap-1 h-7 px-2 bg-purple-600 text-white rounded text-xs font-semibold hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Mail className="w-3 h-3" />
            {sendingEmail ? 'Sending...' : 'Email SOA'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Party Type</label>
            <select name="party_type" aria-label="Party Type"
              value={partyType}
              onChange={(e) => {
                setPartyType(e.target.value as 'customer' | 'supplier' | 'staff' | 'director');
                setSelectedParty('');
                setSupplierSubView('payable');
              }}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            >
              <option value="customer">Customer (Debtor)</option>
              <option value="supplier">Supplier Payable Ledger</option>
              <option value="staff">Staff (Employee)</option>
              <option value="director">Director / Related Party</option>
            </select>
          </div>
          {partyType !== 'director' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Select {partyType === 'customer' ? 'Customer' : partyType === 'supplier' ? 'Supplier' : 'Staff Member'}
                </label>
                <SearchableSelect
                  id="party_ledger_select_party"
                  name="select_partytype_customer_cust"
                  aria-label="Select Party"
                  value={selectedParty}
                  onChange={(val) => setSelectedParty(val)}
                  options={parties.map(party => ({
                    value: party.id,
                    label: party.name,
                    keywords: party.npwp ? [party.npwp] : undefined,
                  }))}
                  placeholder={`Select ${partyType === 'customer' ? 'Customer' : partyType === 'supplier' ? 'Supplier' : 'Staff Member'}`}
                />
              </div>
              <div className="col-span-2 flex items-center justify-between">
                <p className="text-xs text-gray-500 mt-6">Period is controlled by global date range at top</p>
                {partyType === 'supplier' && selectedParty && (
                  <div className="flex items-center gap-1.5 mt-4">
                    <button
                      type="button"
                      onClick={() => setSupplierSubView('payable')}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors ${
                        supplierSubView === 'payable'
                          ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                          : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      Trade Payables (2110)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSupplierSubView('advances')}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors ${
                        supplierSubView === 'advances'
                          ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                          : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      Advances & Deposits (1170)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSupplierSubView('import_customs')}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors flex items-center gap-1 ${
                        supplierSubView === 'import_customs'
                          ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                          : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <span>Import / Customs Costs</span>
                      {importCostEntries.length > 0 && (
                        <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                          supplierSubView === 'import_customs' ? 'bg-blue-800 text-white' : 'bg-gray-200 text-gray-800'
                        }`}>
                          {importCostEntries.length}
                        </span>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {partyType !== 'director' && selectedPartyData && (
          partyType === 'supplier' && supplierSubView === 'import_customs' ? (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-lg">
              <div>
                <p className="text-xs font-medium text-gray-600 uppercase">Total Import Incurred</p>
                <p className="text-lg font-bold text-gray-900">
                  {formatCurrency(importCostEntries.reduce((s, e) => s + e.total_amount, 0), 'IDR')}
                </p>
                <p className="text-[10px] text-gray-500">Operational cargo & tax costs</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-600 uppercase">Import VAT (PPN 1150)</p>
                <p className="text-lg font-bold text-blue-700">
                  {formatCurrency(importCostEntries.reduce((s, e) => s + e.ppn_amount, 0), 'IDR')}
                </p>
                <p className="text-[10px] text-gray-500">Prepaid Input Tax</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-600 uppercase">PPh 22 Import (1155)</p>
                <p className="text-lg font-bold text-purple-700">
                  {formatCurrency(importCostEntries.reduce((s, e) => s + e.pph_amount, 0), 'IDR')}
                </p>
                <p className="text-[10px] text-gray-500">Prepaid Income Tax</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-600 uppercase">Customs Duty (BM)</p>
                <p className="text-lg font-bold text-amber-700">
                  {formatCurrency(importCostEntries.reduce((s, e) => s + e.bm_amount, 0), 'IDR')}
                </p>
                <p className="text-[10px] text-gray-500">Landed Cost / Bea Masuk</p>
              </div>
            </div>
          ) : ledgerEntries.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg">
              <div>
                <p className="text-xs font-medium text-gray-600 uppercase">Opening Balance</p>
                <p className="text-lg font-bold text-gray-900">{formatBalance(openingBalance)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-600 uppercase">
                  {partyType === 'supplier' ? 'Total Debits (Payments)' : 'Total Debit'}
                </p>
                <p className="text-lg font-bold text-red-600">{formatAmount(totalDebit)}</p>
                {partyType === 'supplier' && supplierCurrency === 'USD' && (
                  <p className="text-[10px] text-gray-500">Functional: {formatCurrency(totalFunctionalDebit, 'IDR')}</p>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-gray-600 uppercase">
                  {partyType === 'supplier' ? 'Total Credits (Invoices)' : 'Total Credit'}
                </p>
                <p className="text-lg font-bold text-green-600">{formatAmount(totalCredit)}</p>
                {partyType === 'supplier' && supplierCurrency === 'USD' && (
                  <p className="text-[10px] text-gray-500">Functional: {formatCurrency(totalFunctionalCredit, 'IDR')}</p>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-gray-600 uppercase">Outstanding Balance</p>
                <p className="text-lg font-bold text-orange-600">{formatBalance(closingBalance)}</p>
                {partyType === 'supplier' && supplierCurrency === 'USD' && (
                  <p className="text-[10px] text-gray-500">
                    Functional: {formatCurrency(Math.abs(totalFunctionalDebit - totalFunctionalCredit), 'IDR')} {totalFunctionalDebit >= totalFunctionalCredit ? 'Dr' : 'Cr'}
                  </p>
                )}
              </div>
            </div>
          )
        )}
      </div>

      {partyType === 'director' ? (
        <DirectorLedgerView />
      ) : (
        selectedParty && (
        <>
          {partyType === 'supplier' && supplierSubView === 'import_customs' ? (
            /* Import & Customs Operational Ledger */
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
              <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold text-amber-900">
                    Import & Customs Costs — {selectedPartyData?.name}
                  </h3>
                  <p className="text-[11px] text-amber-700">
                    Operational cargo & landed cost traceability (PIB Import, Bea Masuk, PPN 1150, PPh 22 1155). These are tax/clearing expenses and do NOT affect the supplier payable balance.
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-700 uppercase">Date</th>
                      <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-700 uppercase">Voucher No</th>
                      <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-700 uppercase">Invoice / Cargo Ref</th>
                      <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-700 uppercase">Category</th>
                      <th className="px-2 py-1.5 text-left text-xs font-medium text-gray-700 uppercase">Description</th>
                      <th className="px-2 py-1.5 text-right text-xs font-medium text-gray-700 uppercase">Bea Masuk (BM)</th>
                      <th className="px-2 py-1.5 text-right text-xs font-medium text-gray-700 uppercase">PPN Masukan (1150)</th>
                      <th className="px-2 py-1.5 text-right text-xs font-medium text-gray-700 uppercase">PPh 22 (1155)</th>
                      <th className="px-2 py-1.5 text-right text-xs font-medium text-gray-700 uppercase">Total Cost (IDR)</th>
                      <th className="px-2 py-1.5 text-center text-xs font-medium text-gray-700 uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {loadingImportCosts ? (
                      <tr>
                        <td colSpan={10} className="px-3 py-8 text-center text-gray-500">
                          Loading import & customs records...
                        </td>
                      </tr>
                    ) : importCostEntries.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-3 py-8 text-center text-gray-500">
                          No import or customs expense records found for this supplier
                        </td>
                      </tr>
                    ) : (
                      importCostEntries.map(entry => (
                        <tr key={entry.id} className="hover:bg-gray-50">
                          <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900">
                            {new Date(entry.expense_date).toLocaleDateString('id-ID')}
                          </td>
                          <td className="px-2 py-1 text-xs text-gray-900 font-mono font-medium">
                            {entry.voucher_number}
                          </td>
                          <td className="px-2 py-1 text-xs text-gray-600 font-mono">
                            {entry.invoice_number || '-'}
                          </td>
                          <td className="px-2 py-1 text-xs text-gray-700 capitalize">
                            {entry.category.replace(/_/g, ' ')}
                          </td>
                          <td className="px-2 py-1 text-xs text-gray-800">
                            {entry.description}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-700 text-right">
                            {entry.bm_amount > 0 ? formatCurrency(entry.bm_amount, 'IDR') : '-'}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-xs text-blue-700 text-right">
                            {entry.ppn_amount > 0 ? formatCurrency(entry.ppn_amount, 'IDR') : '-'}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-xs text-purple-700 text-right">
                            {entry.pph_amount > 0 ? formatCurrency(entry.pph_amount, 'IDR') : '-'}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-xs font-semibold text-gray-900 text-right">
                            {formatCurrency(entry.total_amount, 'IDR')}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-xs text-center">
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              entry.payment_status === 'paid'
                                ? 'bg-green-100 text-green-800'
                                : entry.payment_status === 'partial'
                                  ? 'bg-amber-100 text-amber-800'
                                  : 'bg-red-100 text-red-800'
                            }`}>
                              {entry.payment_status.toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            /* Primary Party Ledger / Supplier Payable Ledger */
            <div className="bg-white rounded-lg shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-1 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Date
                      </th>
                      <th className="px-2 py-1 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Particulars
                      </th>
                      <th className="px-2 py-1 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Ref No
                      </th>
                      {partyType === 'supplier' && (
                        <th className="px-2 py-1 text-center text-xs font-medium text-gray-700 uppercase tracking-wider">
                          Curr
                        </th>
                      )}
                      <th className="px-2 py-1 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                        {partyType === 'supplier' ? 'Debit (Payment)' : 'Debit (Dr)'}
                      </th>
                      <th className="px-2 py-1 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                        {partyType === 'supplier' ? 'Credit (Invoice)' : 'Credit (Cr)'}
                      </th>
                      <th className="px-2 py-1 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Balance
                      </th>
                      {partyType === 'supplier' && (
                        <>
                          <th className="px-2 py-1 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                            FX Rate
                          </th>
                          <th className="px-2 py-1 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                            Functional (IDR)
                          </th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    <tr className="bg-blue-50 font-semibold">
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900" colSpan={partyType === 'supplier' ? 4 : 3}>
                        Opening Balance
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right">-</td>
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right">-</td>
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right font-bold">
                        {formatBalance(openingBalance)}
                      </td>
                      {partyType === 'supplier' && (
                        <>
                          <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right">-</td>
                          <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right">-</td>
                        </>
                      )}
                    </tr>

                    {loading ? (
                      <tr>
                        <td colSpan={partyType === 'supplier' ? 9 : 6} className="px-3 py-8 text-center text-gray-500">
                          Loading entries...
                        </td>
                      </tr>
                    ) : ledgerEntries.length === 0 ? (
                      <tr>
                        <td colSpan={partyType === 'supplier' ? 9 : 6} className="px-3 py-8 text-center text-gray-500">
                          No transactions found for this period
                        </td>
                      </tr>
                    ) : (
                      ledgerEntries.map(entry => (
                        <tr key={entry.id} className="hover:bg-gray-50">
                          <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900">
                            {new Date(entry.entry_date).toLocaleDateString('id-ID')}
                          </td>
                          <td className="px-2 py-1 text-xs text-gray-900">
                            {entry.particulars}
                          </td>
                          <td className="px-2 py-1 text-xs text-gray-600 font-mono">
                            {entry.reference}
                          </td>
                          {partyType === 'supplier' && (
                            <td className="px-2 py-1 text-center whitespace-nowrap text-xs font-semibold text-gray-600">
                              {entry.currency || supplierCurrency}
                            </td>
                          )}
                          <td className="px-2 py-1 whitespace-nowrap text-xs text-red-600 text-right font-medium">
                            {entry.debit > 0 ? formatAmount(entry.debit) : '-'}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-xs text-green-600 text-right font-medium">
                            {entry.credit > 0 ? formatAmount(entry.credit) : '-'}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right font-semibold">
                            {formatBalance(entry.running_balance)}
                          </td>
                          {partyType === 'supplier' && (
                            <>
                              <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-600 text-right">
                                {entry.exchange_rate ? Number(entry.exchange_rate).toLocaleString('id-ID') : '-'}
                              </td>
                              <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-700 text-right font-medium">
                                {entry.functional_amount ? formatCurrency(entry.functional_amount, 'IDR') : '-'}
                              </td>
                            </>
                          )}
                        </tr>
                      ))
                    )}

                    {ledgerEntries.length > 0 && (
                      <tr className="bg-gray-100 font-semibold border-t-2 border-gray-300">
                        <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900" colSpan={partyType === 'supplier' ? 4 : 3}>
                          Closing Balance
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap text-xs text-red-600 text-right font-bold">
                          {formatAmount(totalDebit)}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap text-xs text-green-600 text-right font-bold">
                          {formatAmount(totalCredit)}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right font-bold">
                          {formatBalance(closingBalance)}
                        </td>
                        {partyType === 'supplier' && (
                          <>
                            <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right">-</td>
                            <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right font-bold">
                              {formatCurrency(Math.abs(totalFunctionalDebit - totalFunctionalCredit), 'IDR')} {totalFunctionalDebit >= totalFunctionalCredit ? 'Dr' : 'Cr'}
                            </td>
                          </>
                        )}
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* PDF Print Content - Hidden */}
          {selectedPartyData && ledgerEntries.length > 0 && (
            <div style={{ position: 'absolute', left: '-9999px', top: 0 }}>
              <div ref={printRef} style={{ width: '210mm', padding: '20mm', backgroundColor: '#ffffff' }}>
                {/* Header with Company Logo */}
                <div style={{ marginBottom: '15px', borderWidth: '2px', borderColor: '#000', borderStyle: 'solid', padding: '15px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '15px' }}>
                      <div style={{ width: '60px', height: '60px', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' }}>
                        <CompanyLogo logoUrl={co.company_logo_url} alt={co.company_name} className="w-full h-full" />
                      </div>
                      <div>
                        <h1 style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '5px' }}>{co.company_name}</h1>
                        {co.company_address && <p style={{ fontSize: '11px', margin: '2px 0' }}>{co.company_address}</p>}
                        {co.company_phone && <p style={{ fontSize: '11px', margin: '2px 0' }}>Telp: {co.company_phone}</p>}
                        {co.company_tax_id && <p style={{ fontSize: '11px', margin: '2px 0' }}>NPWP: {co.company_tax_id}</p>}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Document Title */}
                <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                  <h2 style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '5px' }}>
                    {partyType === 'supplier' ? 'SUPPLIER PAYABLE STATEMENT OF ACCOUNT' : 'STATEMENT OF ACCOUNT'}
                  </h2>
                  <p style={{ fontSize: '12px', color: '#666' }}>
                    Period: {new Date(globalDateRange.startDate).toLocaleDateString('id-ID')} to {new Date(globalDateRange.endDate).toLocaleDateString('id-ID')}
                  </p>
                  {partyType === 'supplier' && (
                    <p style={{ fontSize: '11px', fontWeight: 'bold', color: '#2563eb', marginTop: '3px' }}>
                      Primary Currency: {supplierCurrency}
                    </p>
                  )}
                </div>

                {/* Party Details */}
                <div style={{ marginBottom: '20px', padding: '12px', backgroundColor: '#f3f4f6', borderRadius: '8px' }}>
                  <p style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '5px' }}>
                    {partyType === 'customer' ? 'Customer:' : partyType === 'supplier' ? 'Supplier:' : 'Staff:'} {selectedPartyData.name}
                  </p>
                  {selectedPartyData.address && (
                    <p style={{ fontSize: '11px', margin: '2px 0' }}>{selectedPartyData.address}</p>
                  )}
                  {selectedPartyData.city && (
                    <p style={{ fontSize: '11px', margin: '2px 0' }}>{selectedPartyData.city}</p>
                  )}
                  {selectedPartyData.phone && (
                    <p style={{ fontSize: '11px', margin: '2px 0' }}>Phone: {selectedPartyData.phone}</p>
                  )}
                  {selectedPartyData.npwp && (
                    <p style={{ fontSize: '11px', margin: '2px 0' }}>NPWP: {selectedPartyData.npwp}</p>
                  )}
                </div>

                {/* Summary */}
                <div style={{ marginBottom: '15px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
                  <div style={{ padding: '10px', backgroundColor: '#eff6ff', borderRadius: '6px' }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: '#666', marginBottom: '3px' }}>OPENING BALANCE</p>
                    <p style={{ fontSize: '13px', fontWeight: 'bold' }}>{formatBalance(openingBalance)}</p>
                  </div>
                  <div style={{ padding: '10px', backgroundColor: '#fef2f2', borderRadius: '6px' }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: '#666', marginBottom: '3px' }}>
                      {partyType === 'supplier' ? 'TOTAL DEBITS (PAYMENTS)' : 'TOTAL DEBIT'}
                    </p>
                    <p style={{ fontSize: '13px', fontWeight: 'bold', color: '#dc2626' }}>{formatAmount(totalDebit)}</p>
                  </div>
                  <div style={{ padding: '10px', backgroundColor: '#f0fdf4', borderRadius: '6px' }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: '#666', marginBottom: '3px' }}>
                      {partyType === 'supplier' ? 'TOTAL CREDITS (INVOICES)' : 'TOTAL CREDIT'}
                    </p>
                    <p style={{ fontSize: '13px', fontWeight: 'bold', color: '#16a34a' }}>{formatAmount(totalCredit)}</p>
                  </div>
                  <div style={{ padding: '10px', backgroundColor: '#fff7ed', borderRadius: '6px' }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: '#666', marginBottom: '3px' }}>OUTSTANDING</p>
                    <p style={{ fontSize: '13px', fontWeight: 'bold', color: '#ea580c' }}>{formatBalance(closingBalance)}</p>
                  </div>
                </div>

                {/* Ledger Table */}
                <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '20px' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #000' }}>
                      <th style={{ padding: '8px', textAlign: 'left', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Date</th>
                      <th style={{ padding: '8px', textAlign: 'left', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Particulars</th>
                      <th style={{ padding: '8px', textAlign: 'left', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Ref No</th>
                      {partyType === 'supplier' && (
                        <th style={{ padding: '8px', textAlign: 'center', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Curr</th>
                      )}
                      <th style={{ padding: '8px', textAlign: 'right', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>
                        {partyType === 'supplier' ? 'Debit (Payment)' : 'Debit (Dr)'}
                      </th>
                      <th style={{ padding: '8px', textAlign: 'right', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>
                        {partyType === 'supplier' ? 'Credit (Invoice)' : 'Credit (Cr)'}
                      </th>
                      <th style={{ padding: '8px', textAlign: 'right', fontSize: '10px', fontWeight: '600' }}>Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ backgroundColor: '#eff6ff', borderBottom: '1px solid #e5e7eb' }}>
                      <td colSpan={partyType === 'supplier' ? 4 : 3} style={{ padding: '6px 8px', fontSize: '11px', fontWeight: '600' }}>Opening Balance</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px' }}>-</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px' }}>-</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold' }}>{formatBalance(openingBalance)}</td>
                    </tr>
                    {ledgerEntries.map(entry => (
                      <tr key={entry.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                        <td style={{ padding: '6px 8px', fontSize: '10px' }}>{new Date(entry.entry_date).toLocaleDateString('id-ID')}</td>
                        <td style={{ padding: '6px 8px', fontSize: '10px' }}>{entry.particulars}</td>
                        <td style={{ padding: '6px 8px', fontSize: '10px', fontFamily: 'monospace' }}>{entry.reference}</td>
                        {partyType === 'supplier' && (
                          <td style={{ padding: '6px 8px', fontSize: '10px', textAlign: 'center', fontWeight: '600' }}>
                            {entry.currency || supplierCurrency}
                          </td>
                        )}
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '10px', color: entry.debit > 0 ? '#dc2626' : '#000' }}>
                          {entry.debit > 0 ? formatAmount(entry.debit) : '-'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '10px', color: entry.credit > 0 ? '#16a34a' : '#000' }}>
                          {entry.credit > 0 ? formatAmount(entry.credit) : '-'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '10px', fontWeight: '600' }}>{formatBalance(entry.running_balance)}</td>
                      </tr>
                    ))}
                    <tr style={{ backgroundColor: '#f3f4f6', borderTop: '2px solid #000', borderBottom: '2px solid #000' }}>
                      <td colSpan={partyType === 'supplier' ? 4 : 3} style={{ padding: '8px', fontSize: '11px', fontWeight: 'bold' }}>Closing Balance</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold', color: '#dc2626' }}>{formatAmount(totalDebit)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold', color: '#16a34a' }}>{formatAmount(totalCredit)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold' }}>{formatBalance(closingBalance)}</td>
                    </tr>
                  </tbody>
                </table>

                {/* Footer Note */}
                <div style={{ marginTop: '30px', padding: '12px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
                  <p style={{ fontSize: '11px', color: '#666', marginBottom: '8px' }}>
                    <strong>Note:</strong> This is a computer-generated statement of account.
                  </p>
                  <p style={{ fontSize: '11px', color: '#666' }}>
                    Please review the above transactions and confirm. If you have any questions or discrepancies, please contact us immediately.
                  </p>
                </div>

                {/* Footer */}
                <div style={{ marginTop: '20px', textAlign: 'center', borderTop: '1px solid #e5e7eb', paddingTop: '10px' }}>
                  <p style={{ fontSize: '10px', color: '#999' }}>Generated on {new Date().toLocaleString('id-ID')}</p>
                  <p style={{ fontSize: '10px', color: '#999' }}>{co.company_name}</p>
                </div>
              </div>
            </div>
          )}
        </>
      ))}
    </div>
  );
}
