import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { DataTable } from '../DataTable';
import { FinanceModal as Modal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from './FloatingField';
import { SapRow } from './SapLayout';
import { Plus, Pencil as Edit, Trash2, FileText, DollarSign, Calendar, AlertCircle } from 'lucide-react';
import { formatDate } from '../../utils/dateFormat';
import { useExpenseCategories } from './useExpenseCategories';
import { useFinance } from '../../contexts/FinanceContext';
import * as XLSX from 'xlsx';

interface VendorBill {
  id: string;
  bill_number: string;
  vendor_name: string;
  vendor_id: string | null;
  bill_date: string;
  due_date: string | null;
  amount: number;
  tax_amount: number;
  total_amount: number;
  payment_status: 'pending' | 'partial' | 'paid';
  category: 'inventory' | 'expense' | 'asset' | 'other' | null;
  description: string | null;
  created_at: string;
}

interface VendorPayment {
  id: string;
  payment_number: string;
  bill_id: string;
  payment_date: string;
  amount: number;
  payment_method: string;
  bank_account_id: string | null;
  reference_number: string | null;
  notes: string | null;
  vendor_bills?: {
    bill_number: string;
    vendor_name: string;
  };
  bank_accounts?: {
    account_name: string;
    bank_name: string;
    alias: string | null;
  } | null;
}

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
  alias: string | null;
  currency: string;
}

// Outstanding expense bill from get_outstanding_expense_bills() RPC
interface OutstandingExpenseBill {
  id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string;
  due_date: string | null;
  expense_category: string;
  description: string | null;
  amount: number;
  paid_amount: number;
  balance_amount: number;
  days_overdue: number;
}

interface OutstandingPurchaseInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
  currency: string;
  exchange_rate?: number;
  status?: string;
  suppliers?: { company_name: string } | null;
}

interface ApControlCategorySummary {
  ap_category_code: string;
  ap_category_label: string;
  is_supplier_subledger: boolean;
  sort_order: number;
  line_count: number;
  total_debit: number;
  total_credit: number;
  net_ap_balance: number;
}

interface ApControlReconciliationLine {
  journal_entry_line_id: string;
  journal_entry_id: string;
  entry_number: string;
  entry_date: string;
  source_module: string;
  reference_number: string | null;
  journal_description: string | null;
  line_description: string | null;
  supplier_name: string | null;
  staff_name: string | null;
  payee_name: string | null;
  expense_voucher_number: string | null;
  debit: number;
  credit: number;
  net_ap_balance: number;
}

interface PayablesManagerProps {
  canManage: boolean;
}

type ViewMode = 'bills' | 'payments' | 'expense_bills';

export function PayablesManager({ canManage }: PayablesManagerProps) {
  const { profile } = useAuth();
  const { dateRange } = useFinance();
  const { categories: expenseCategories } = useExpenseCategories();
  const [viewMode, setViewMode] = useState<ViewMode>('expense_bills');
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [payments, setPayments] = useState<VendorPayment[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [outstandingExpenseBills, setOutstandingExpenseBills] = useState<OutstandingExpenseBill[]>([]);
  const [outstandingPurchaseInvoices, setOutstandingPurchaseInvoices] = useState<OutstandingPurchaseInvoice[]>([]);
  const [apReconciliationSummary, setApReconciliationSummary] = useState<ApControlCategorySummary[]>([]);
  const [apDrilldownCategory, setApDrilldownCategory] = useState<ApControlCategorySummary | null>(null);
  const [apDrilldownLines, setApDrilldownLines] = useState<ApControlReconciliationLine[]>([]);
  const [loadingApDrilldown, setLoadingApDrilldown] = useState(false);
  const [loading, setLoading] = useState(true);
  const [billModalOpen, setBillModalOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [editingBill, setEditingBill] = useState<VendorBill | null>(null);
  const [editingPayment, setEditingPayment] = useState<VendorPayment | null>(null);
  const [billFormData, setBillFormData] = useState({
    bill_number: '',
    vendor_name: '',
    vendor_id: '',
    bill_date: new Date().toISOString().split('T')[0],
    due_date: '',
    amount: 0,
    tax_amount: 0,
    category: 'expense' as VendorBill['category'],
    description: '',
  });
  const [paymentFormData, setPaymentFormData] = useState({
    bill_id: '',
    payment_date: new Date().toISOString().split('T')[0],
    amount: 0,
    payment_method: 'bank_transfer',
    bank_account_id: '',
    reference_number: '',
    notes: '',
  });

  useEffect(() => {
    loadData();
  }, [dateRange.startDate, dateRange.endDate]);

  const loadData = async () => {
    setLoading(true);
    await Promise.all([
      loadBills(),
      loadPayments(),
      loadBankAccounts(),
      loadOutstandingExpenseBills(),
      loadOutstandingPurchaseInvoices(),
      loadApReconciliationSummary(),
    ]);
    setLoading(false);
  };

  const loadApReconciliationSummary = async () => {
    try {
      const { data, error } = await supabase.rpc('get_ap_control_reconciliation_summary', {
        p_as_of_date: dateRange.endDate,
      });
      if (error) throw error;
      setApReconciliationSummary((data || []) as ApControlCategorySummary[]);
    } catch (error) {
      console.warn('AP control reconciliation summary unavailable:', error);
      setApReconciliationSummary([]);
    }
  };

  const openApCategoryDrilldown = async (category: ApControlCategorySummary) => {
    setApDrilldownCategory(category);
    setLoadingApDrilldown(true);
    try {
      const { data, error } = await supabase
        .from('vw_ap_control_reconciliation')
        .select(
          'journal_entry_line_id, journal_entry_id, entry_number, entry_date, source_module, reference_number, journal_description, line_description, supplier_name, staff_name, payee_name, expense_voucher_number, debit, credit, net_ap_balance'
        )
        .eq('ap_category_code', category.ap_category_code)
        .lte('entry_date', dateRange.endDate)
        .order('entry_date', { ascending: false })
        .limit(200);
      if (error) throw error;
      setApDrilldownLines((data || []) as ApControlReconciliationLine[]);
    } catch (error) {
      console.error('Error loading AP control drilldown lines:', error);
      setApDrilldownLines([]);
    } finally {
      setLoadingApDrilldown(false);
    }
  };

  const loadOutstandingExpenseBills = async () => {
    try {
      const { data, error } = await supabase.rpc('get_outstanding_expense_bills', { p_as_of_date: dateRange.endDate });
      if (error) throw error;
      setOutstandingExpenseBills(data || []);
    } catch (error) {
      console.error('Error loading outstanding expense bills:', error);
    }
  };

  const loadOutstandingPurchaseInvoices = async () => {
    try {
      const { data, error } = await supabase
        .from('purchase_invoices')
        .select('id, invoice_number, invoice_date, due_date, total_amount, paid_amount, balance_amount, currency, exchange_rate, status, suppliers(company_name)')
        .in('status', ['unpaid', 'pending', 'partial'])
        .gt('balance_amount', 0)
        .lte('invoice_date', dateRange.endDate)
        .order('due_date', { ascending: true });
      if (error) throw error;
      setOutstandingPurchaseInvoices((data || []).map(invoice => ({
        ...invoice,
        suppliers: Array.isArray(invoice.suppliers) ? invoice.suppliers[0] || null : invoice.suppliers,
      })) as OutstandingPurchaseInvoice[]);
    } catch (error) {
      console.error('Error loading outstanding purchase invoices:', error);
    }
  };

  const loadBills = async () => {
    try {
      const { data, error } = await supabase
        .from('vendor_bills')
        .select('*')
        .gte('bill_date', dateRange.startDate)
        .lte('bill_date', dateRange.endDate)
        .order('bill_date', { ascending: false });

      if (error) throw error;
      setBills(data || []);
    } catch (error) {
      console.error('Error loading bills:', error);
    }
  };

  const loadPayments = async () => {
    try {
      const { data, error } = await supabase
        .from('vendor_payments')
        .select(`
          *,
          vendor_bills (
            bill_number,
            vendor_name
          ),
          bank_accounts (
            account_name,
            bank_name,
            alias
          )
        `)
        .gte('payment_date', dateRange.startDate)
        .lte('payment_date', dateRange.endDate)
        .order('payment_date', { ascending: false });

      if (error) throw error;
      setPayments(data || []);
    } catch (error) {
      console.error('Error loading payments:', error);
    }
  };

  const loadBankAccounts = async () => {
    try {
      const { data, error } = await supabase
        .from('bank_accounts')
        .select('id, account_name, bank_name, alias, currency')
        .eq('is_active', true)
        .order('account_name');

      if (error) throw error;
      setBankAccounts(data || []);
    } catch (error) {
      console.error('Error loading bank accounts:', error);
    }
  };

  const generateBillNumber = async () => {
    const prefix = 'BILL';
    const year = new Date().getFullYear();

    const { data } = await supabase
      .from('vendor_bills')
      .select('bill_number')
      .like('bill_number', `${prefix}-${year}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.bill_number) {
      const lastNumber = parseInt(data.bill_number.split('-')[2]);
      return `${prefix}-${year}-${String(lastNumber + 1).padStart(5, '0')}`;
    }

    return `${prefix}-${year}-00001`;
  };

  const generatePaymentNumber = async () => {
    const prefix = 'VPAY';
    const year = new Date().getFullYear();

    const { data } = await supabase
      .from('vendor_payments')
      .select('payment_number')
      .like('payment_number', `${prefix}-${year}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data?.payment_number) {
      const lastNumber = parseInt(data.payment_number.split('-')[2]);
      return `${prefix}-${year}-${String(lastNumber + 1).padStart(5, '0')}`;
    }

    return `${prefix}-${year}-00001`;
  };

  const handleBillSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const totalAmount = billFormData.amount + billFormData.tax_amount;

      if (editingBill) {
        const { error } = await supabase
          .from('vendor_bills')
          .update({
            vendor_name: billFormData.vendor_name,
            vendor_id: billFormData.vendor_id || null,
            bill_date: billFormData.bill_date,
            due_date: billFormData.due_date || null,
            amount: billFormData.amount,
            tax_amount: billFormData.tax_amount,
            total_amount: totalAmount,
            category: billFormData.category,
            description: billFormData.description || null,
          })
          .eq('id', editingBill.id);

        if (error) throw error;
      } else {
        const billNumber = await generateBillNumber();

        const { error } = await supabase
          .from('vendor_bills')
          .insert([{
            bill_number: billNumber,
            vendor_name: billFormData.vendor_name,
            vendor_id: billFormData.vendor_id || null,
            bill_date: billFormData.bill_date,
            due_date: billFormData.due_date || null,
            amount: billFormData.amount,
            tax_amount: billFormData.tax_amount,
            total_amount: totalAmount,
            category: billFormData.category,
            description: billFormData.description || null,
            created_by: user.id,
          }]);

        if (error) throw error;
      }

      setBillModalOpen(false);
      resetBillForm();
      loadBills();
    } catch (error) {
      console.error('Error saving bill:', error);
      alert('Failed to save bill. Please try again.');
    }
  };

  const handlePaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (editingPayment) {
        const { error } = await supabase
          .from('vendor_payments')
          .update({
            payment_date: paymentFormData.payment_date,
            amount: paymentFormData.amount,
            payment_method: paymentFormData.payment_method,
            bank_account_id: paymentFormData.bank_account_id || null,
            reference_number: paymentFormData.reference_number || null,
            notes: paymentFormData.notes || null,
          })
          .eq('id', editingPayment.id);

        if (error) throw error;
      } else {
        const paymentNumber = await generatePaymentNumber();

        const { error } = await supabase
          .from('vendor_payments')
          .insert([{
            payment_number: paymentNumber,
            bill_id: paymentFormData.bill_id,
            payment_date: paymentFormData.payment_date,
            amount: paymentFormData.amount,
            payment_method: paymentFormData.payment_method,
            bank_account_id: paymentFormData.bank_account_id || null,
            reference_number: paymentFormData.reference_number || null,
            notes: paymentFormData.notes || null,
            created_by: user.id,
          }]);

        if (error) throw error;
      }

      setPaymentModalOpen(false);
      resetPaymentForm();
      loadPayments();
      loadBills();
    } catch (error) {
      console.error('Error saving payment:', error);
      alert('Failed to save payment. Please try again.');
    }
  };

  const handleEditBill = (bill: VendorBill) => {
    setEditingBill(bill);
    setBillFormData({
      bill_number: bill.bill_number,
      vendor_name: bill.vendor_name,
      vendor_id: bill.vendor_id || '',
      bill_date: bill.bill_date,
      due_date: bill.due_date || '',
      amount: bill.amount,
      tax_amount: bill.tax_amount,
      category: bill.category,
      description: bill.description || '',
    });
    setBillModalOpen(true);
  };

  const handleEditPayment = (payment: VendorPayment) => {
    setEditingPayment(payment);
    setPaymentFormData({
      bill_id: payment.bill_id,
      payment_date: payment.payment_date,
      amount: payment.amount,
      payment_method: payment.payment_method,
      bank_account_id: payment.bank_account_id || '',
      reference_number: payment.reference_number || '',
      notes: payment.notes || '',
    });
    setPaymentModalOpen(true);
  };

  const handleDeleteBill = async (id: string) => {
    if (!confirm('Are you sure you want to delete this bill?')) return;

    try {
      const { error } = await supabase
        .from('vendor_bills')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadBills();
    } catch (error) {
      console.error('Error deleting bill:', error);
      alert('Failed to delete bill. Please try again.');
    }
  };

  const handleDeletePayment = async (id: string) => {
    if (!confirm('Are you sure you want to delete this payment?')) return;

    try {
      const { error } = await supabase
        .from('vendor_payments')
        .delete()
        .eq('id', id);

      if (error) throw error;
      loadPayments();
      loadBills();
    } catch (error) {
      console.error('Error deleting payment:', error);
      alert('Failed to delete payment. Please try again.');
    }
  };

  const resetBillForm = () => {
    setEditingBill(null);
    setBillFormData({
      bill_number: '',
      vendor_name: '',
      vendor_id: '',
      bill_date: new Date().toISOString().split('T')[0],
      due_date: '',
      amount: 0,
      tax_amount: 0,
      category: 'expense',
      description: '',
    });
  };

  const resetPaymentForm = () => {
    setEditingPayment(null);
    setPaymentFormData({
      bill_id: '',
      payment_date: new Date().toISOString().split('T')[0],
      amount: 0,
      payment_method: 'bank_transfer',
      bank_account_id: '',
      reference_number: '',
      notes: '',
    });
  };

  const getPaymentStatusColor = (status: string) => {
    switch (status) {
      case 'paid':
        return 'bg-green-100 text-green-800';
      case 'partial':
        return 'bg-yellow-100 text-yellow-800';
      case 'pending':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getCategoryLabel = (category: string | null) => {
    const labels: Record<string, string> = {
      inventory: 'Inventory',
      expense: 'Expense',
      asset: 'Asset',
      other: 'Other',
    };
    return category ? labels[category] || category : 'N/A';
  };

  const getPaymentMethodLabel = (method: string) => {
    const labels: Record<string, string> = {
      cash: 'Cash',
      bank_transfer: 'Bank Transfer',
      cheque: 'Cheque',
      credit_card: 'Credit Card',
      other: 'Other',
    };
    return labels[method] || method;
  };

  const totalPayable = bills
    .filter(b => b.payment_status !== 'paid')
    .reduce((sum, b) => sum + b.total_amount, 0);

  const totalExpenseBillsPayable = outstandingExpenseBills.reduce((sum, b) => sum + b.balance_amount, 0);
  const totalPurchaseInvoicesPayable = outstandingPurchaseInvoices.reduce((sum, invoice) => {
    const isUSD = (invoice.currency || 'IDR').toUpperCase() === 'USD';
    const rate = Number(invoice.exchange_rate) || 1;
    const functionalBal = isUSD ? Number(invoice.balance_amount || 0) * rate : Number(invoice.balance_amount || 0);
    return sum + functionalBal;
  }, 0);

  // The AP headline is the canonical as-of view: purchase invoices plus
  // expense bills. Legacy vendor_bills remain available separately and are
  // intentionally not mixed into this accounting answer.
  const totalCombinedPayable = totalExpenseBillsPayable + totalPurchaseInvoicesPayable;

  const exportPayables = () => {
    const rows = [
      ...outstandingPurchaseInvoices.map(i => {
        const isUSD = (i.currency || 'IDR').toUpperCase() === 'USD';
        const rate = Number(i.exchange_rate) || 1;
        const functionalBal = isUSD ? Number(i.balance_amount || 0) * rate : Number(i.balance_amount || 0);
        return {
          Supplier: i.suppliers?.company_name || '', 'Invoice / Expense No.': i.invoice_number,
          'Document Type': 'Purchase Invoice', 'Invoice Date': i.invoice_date, 'Due Date': i.due_date || '',
          'Original Amount': Number(i.total_amount), 'Paid Amount': Number(i.paid_amount), 'Outstanding Balance': Number(i.balance_amount),
          Currency: i.currency || 'IDR', 'Exchange Rate': rate, 'Functional Outstanding Balance (IDR)': functionalBal,
          'Payment Status': Number(i.balance_amount) > 0 && Number(i.paid_amount) > 0 ? 'Partial' : 'Unpaid',
          'Related Purchase Invoice': i.invoice_number, Reference: i.id,
        };
      }),
      ...outstandingExpenseBills.map(e => ({
        Supplier: e.supplier_name || '', 'Invoice / Expense No.': e.invoice_number || e.id,
        'Document Type': 'Supplier Expense', 'Invoice Date': e.invoice_date, 'Due Date': e.due_date || '',
        Category: categoryLabel(e.expense_category), Description: e.description || '', 'Original Amount': Number(e.amount),
        'Paid Amount': Number(e.paid_amount), 'Outstanding Balance': Number(e.balance_amount), Currency: 'IDR',
        'Exchange Rate': 1, 'Functional Outstanding Balance (IDR)': Number(e.balance_amount),
        'Payment Status': Number(e.paid_amount) > 0 ? 'Partial' : 'Unpaid', 'Days Overdue': Number(e.days_overdue || 0),
        Reference: e.id,
      })),
    ];
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    ws['!autofilter'] = { ref: ws['!ref'] || 'A1' };
    ws['!cols'] = Object.keys(rows[0] || {}).map(k => ({ wch: Math.min(32, Math.max(14, k.length + 2)) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Payables');
    XLSX.writeFile(wb, `Payables_${dateRange.startDate}_${dateRange.endDate}.xlsx`);
  };

  const overdueExpenseBills = outstandingExpenseBills.filter(b => b.days_overdue > 0);
  const overduePurchaseInvoices = outstandingPurchaseInvoices.filter(invoice => invoice.due_date && new Date(invoice.due_date) < new Date(`${dateRange.endDate}T00:00:00`));

  const categoryLabel = (cat: string) =>
    expenseCategories.find(category => category.value === cat)?.label
    || cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const billColumns = [
    {
      key: 'bill_number',
      label: 'Bill Number',
      render: (bill: VendorBill) => (
        <span className="font-medium text-gray-900">{bill.bill_number}</span>
      )
    },
    {
      key: 'vendor_name',
      label: 'Vendor',
      render: (bill: VendorBill) => bill.vendor_name
    },
    {
      key: 'bill_date',
      label: 'Bill Date',
      render: (bill: VendorBill) => formatDate(bill.bill_date)
    },
    {
      key: 'due_date',
      label: 'Due Date',
      render: (bill: VendorBill) => {
        if (!bill.due_date) return 'N/A';
        const dueDate = new Date(bill.due_date);
        const isOverdue = dueDate < new Date() && bill.payment_status !== 'paid';
        return (
          <span className={isOverdue ? 'text-red-600 font-medium' : ''}>
            {formatDate(bill.due_date)}
            {isOverdue && <AlertCircle className="w-3 h-3 inline ml-1" />}
          </span>
        );
      }
    },
    {
      key: 'category',
      label: 'Category',
      render: (bill: VendorBill) => getCategoryLabel(bill.category)
    },
    {
      key: 'total_amount',
      label: 'Total Amount',
      render: (bill: VendorBill) => (
        <span className="font-semibold text-red-600">
          Rp {bill.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      )
    },
    {
      key: 'payment_status',
      label: 'Status',
      render: (bill: VendorBill) => (
        <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${getPaymentStatusColor(bill.payment_status)}`}>
          {bill.payment_status.toUpperCase()}
        </span>
      )
    },
  ];

  const paymentColumns = [
    {
      key: 'payment_number',
      label: 'Payment Number',
      render: (payment: VendorPayment) => (
        <span className="font-medium text-gray-900">{payment.payment_number}</span>
      )
    },
    {
      key: 'bill',
      label: 'Bill Number',
      render: (payment: VendorPayment) => payment.vendor_bills?.bill_number || 'N/A'
    },
    {
      key: 'vendor',
      label: 'Vendor',
      render: (payment: VendorPayment) => payment.vendor_bills?.vendor_name || 'N/A'
    },
    {
      key: 'payment_date',
      label: 'Payment Date',
      render: (payment: VendorPayment) => formatDate(payment.payment_date)
    },
    {
      key: 'amount',
      label: 'Amount',
      render: (payment: VendorPayment) => (
        <span className="font-semibold text-green-600">
          Rp {payment.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      )
    },
    {
      key: 'payment_method',
      label: 'Method',
      render: (payment: VendorPayment) => getPaymentMethodLabel(payment.payment_method)
    },
    {
      key: 'bank_account',
      label: 'Bank Account',
      render: (payment: VendorPayment) =>
        payment.bank_accounts
          ? (payment.bank_accounts.alias || `${payment.bank_accounts.account_name} - ${payment.bank_accounts.bank_name}`)
          : 'N/A'
    },
  ];

  const unpaidBills = bills.filter(b => b.payment_status !== 'paid');

  return (
    <div className="space-y-2">
      {/* Compact KPI strip — one row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
        <div className="bg-gradient-to-br from-red-500 to-red-600 rounded px-2 py-1.5 text-white">
          <div className="flex items-center justify-between gap-1">
            <div>
              <p className="text-[9px] text-red-100 uppercase tracking-wide">AP Outstanding</p>
              <p className="text-sm font-bold font-mono">Rp {totalCombinedPayable.toLocaleString('id-ID', { maximumFractionDigits: 0 })}</p>
            </div>
            <DollarSign className="w-4 h-4 text-red-200 shrink-0" />
          </div>
        </div>
        <div className="bg-orange-50 border border-orange-200 rounded px-2 py-1.5">
          <div className="flex items-center justify-between gap-1">
            <div>
              <p className="text-[9px] text-orange-600 uppercase tracking-wide">Overdue</p>
              <p className="text-sm font-bold text-orange-700 font-mono">{overdueExpenseBills.length + overduePurchaseInvoices.length}</p>
            </div>
            <AlertCircle className="w-4 h-4 text-orange-400 shrink-0" />
          </div>
        </div>
        <div className="bg-purple-50 border border-purple-200 rounded px-2 py-1.5">
          <div className="flex items-center justify-between gap-1">
            <div>
              <p className="text-[9px] text-purple-600 uppercase tracking-wide">Expense Bills</p>
              <p className="text-sm font-bold text-purple-700 font-mono">Rp {totalExpenseBillsPayable.toLocaleString('id-ID', { maximumFractionDigits: 0 })}</p>
            </div>
            <FileText className="w-4 h-4 text-purple-400 shrink-0" />
          </div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded px-2 py-1.5">
          <div className="flex items-center justify-between gap-1">
            <div>
              <p className="text-[9px] text-blue-600 uppercase tracking-wide">Legacy Bills</p>
              <p className="text-sm font-bold text-blue-700 font-mono">Rp {totalPayable.toLocaleString('id-ID', { maximumFractionDigits: 0 })}</p>
            </div>
            <FileText className="w-4 h-4 text-blue-400 shrink-0" />
          </div>
        </div>
      </div>

      {/* GL 2110 AP Control Reconciliation Summary */}
      {apReconciliationSummary.length > 0 && (() => {
        const gl2110Total = apReconciliationSummary.reduce((sum, r) => sum + Number(r.net_ap_balance || 0), 0);
        const supplierTradeAp = apReconciliationSummary
          .filter(r => r.is_supplier_subledger)
          .reduce((sum, r) => sum + Number(r.net_ap_balance || 0), 0);
        const unassignedAp = Number(
          apReconciliationSummary.find(r => r.ap_category_code === '7_other_unassigned_ap')?.net_ap_balance || 0
        );
        const nonSupplierAp = gl2110Total - supplierTradeAp - unassignedAp;
        const formatRp = (val: number) =>
          `Rp ${val.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        return (
          <div className="bg-white rounded-lg border border-gray-200 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold text-gray-800 uppercase tracking-wide">
                  AP Control Reconciliation (GL 2110 as of {dateRange.endDate})
                </h3>
                <p className="text-[11px] text-gray-500">
                  Reconciles full GL 2110 control balance across Supplier Trade AP and Non-Supplier / Statutory AP.
                </p>
              </div>
              <div className="flex flex-wrap gap-3 text-xs">
                <div className="bg-slate-50 border border-slate-200 rounded px-2.5 py-1">
                  <span className="text-[10px] text-slate-500 block">GL 2110 Control</span>
                  <span className="font-mono font-semibold text-slate-900">{formatRp(gl2110Total)}</span>
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded px-2.5 py-1">
                  <span className="text-[10px] text-blue-600 block">Supplier Trade AP</span>
                  <span className="font-mono font-semibold text-blue-800">{formatRp(supplierTradeAp)}</span>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded px-2.5 py-1">
                  <span className="text-[10px] text-amber-700 block">Non-Supplier AP</span>
                  <span className="font-mono font-semibold text-amber-800">{formatRp(nonSupplierAp)}</span>
                </div>
                <div className={`border rounded px-2.5 py-1 ${Math.abs(unassignedAp) < 0.01 ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                  <span className={`text-[10px] block ${Math.abs(unassignedAp) < 0.01 ? 'text-emerald-700' : 'text-red-700'}`}>Unassigned</span>
                  <span className={`font-mono font-semibold ${Math.abs(unassignedAp) < 0.01 ? 'text-emerald-800' : 'text-red-800'}`}>{formatRp(unassignedAp)}</span>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 border-y border-gray-200">
                  <tr>
                    <th className="px-2 py-1 text-left font-semibold text-gray-600">Category</th>
                    <th className="px-2 py-1 text-right font-semibold text-gray-600">Lines</th>
                    <th className="px-2 py-1 text-right font-semibold text-gray-600">Net GL 2110</th>
                    <th className="px-2 py-1 text-right font-semibold text-gray-600">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {apReconciliationSummary.map((cat) => (
                    <tr key={cat.ap_category_code} className="hover:bg-gray-50">
                      <td className="px-2 py-1 text-gray-800 font-medium">{cat.ap_category_label}</td>
                      <td className="px-2 py-1 text-right font-mono text-gray-600">{cat.line_count}</td>
                      <td className="px-2 py-1 text-right font-mono font-semibold text-gray-900">
                        {formatRp(Number(cat.net_ap_balance || 0))}
                      </td>
                      <td className="px-2 py-1 text-right">
                        <button
                          type="button"
                          onClick={() => openApCategoryDrilldown(cat)}
                          disabled={Number(cat.line_count) === 0}
                          className="text-[11px] font-medium text-blue-600 hover:text-blue-800 disabled:text-gray-400"
                        >
                          Drill Down
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* Compact tab strip */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-0.5">
          <button
            onClick={() => setViewMode('expense_bills')}
            className={`inline-flex items-center gap-1 h-7 px-2 rounded text-[11px] font-medium transition-colors ${
              viewMode === 'expense_bills' ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <FileText className="w-3 h-3" />
            Outstanding (AP)
            {(outstandingExpenseBills.length + outstandingPurchaseInvoices.length) > 0 && (
              <span className={`ml-1 px-1 py-0 rounded text-[10px] font-semibold ${viewMode === 'expense_bills' ? 'bg-purple-800 text-purple-50' : 'bg-purple-200 text-purple-800'}`}>
                {outstandingExpenseBills.length + outstandingPurchaseInvoices.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setViewMode('bills')}
            className={`inline-flex items-center gap-1 h-7 px-2 rounded text-[11px] font-medium transition-colors ${
              viewMode === 'bills' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <FileText className="w-3 h-3" />
            Legacy Bills
          </button>
          <button
            onClick={() => setViewMode('payments')}
            className={`inline-flex items-center gap-1 h-7 px-2 rounded text-[11px] font-medium transition-colors ${
              viewMode === 'payments' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <DollarSign className="w-3 h-3" />
            Payments
          </button>
        </div>

        {canManage && (
          <div className="flex gap-1">
            <button onClick={exportPayables} disabled={totalCombinedPayable <= 0} className="inline-flex items-center gap-1 h-7 px-2 bg-emerald-600 text-white rounded text-[11px] font-semibold hover:bg-emerald-700 disabled:opacity-50">Export Excel</button>
            {viewMode === 'bills' && (
              <button
                onClick={() => { resetBillForm(); setBillModalOpen(true); }}
                className="inline-flex items-center gap-1 h-7 px-2 bg-blue-600 text-white rounded text-[11px] font-semibold hover:bg-blue-700"
              >
                <Plus className="w-3 h-3" /> Add Bill
              </button>
            )}
            {viewMode === 'payments' && (
              <button
                onClick={() => { resetPaymentForm(); setPaymentModalOpen(true); }}
                className="inline-flex items-center gap-1 h-7 px-2 bg-green-600 text-white rounded text-[11px] font-semibold hover:bg-green-700"
              >
                <Plus className="w-3 h-3" /> Record Payment
              </button>
            )}
          </div>
        )}
      </div>

      {viewMode === 'expense_bills' ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
          {!loading && outstandingPurchaseInvoices.length > 0 && (
            <div className="border-b border-gray-200">
              <div className="px-3 py-2 bg-blue-50 text-xs font-semibold text-blue-800">
                Purchase Invoices outstanding as of {dateRange.endDate}
              </div>
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Supplier</th>
                    <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Invoice #</th>
                    <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Invoice Date</th>
                    <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Due Date</th>
                    <th className="px-1.5 py-1 text-right text-xs font-semibold text-gray-600">Total</th>
                    <th className="px-1.5 py-1 text-right text-xs font-semibold text-gray-600">Paid</th>
                    <th className="px-1.5 py-1 text-right text-xs font-semibold text-gray-600">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {outstandingPurchaseInvoices.map(invoice => {
                    const isUSD = (invoice.currency || 'IDR').toUpperCase() === 'USD';
                    const rate = Number(invoice.exchange_rate) || 1;
                    const functionalBal = isUSD ? Number(invoice.balance_amount || 0) * rate : Number(invoice.balance_amount || 0);
                    return (
                      <tr key={invoice.id} className="hover:bg-blue-50/40">
                        <td className="px-1.5 py-1 text-xs text-gray-900">{invoice.suppliers?.company_name || '—'}</td>
                        <td className="px-1.5 py-1 text-xs font-mono text-gray-700">
                          {invoice.invoice_number}
                          {isUSD && (
                            <span className="ml-1.5 px-1 py-0.2 text-[9px] font-semibold bg-blue-100 text-blue-800 rounded">USD</span>
                          )}
                        </td>
                        <td className="px-1.5 py-1 text-xs text-gray-700">{formatDate(invoice.invoice_date)}</td>
                        <td className="px-1.5 py-1 text-xs text-gray-700">{invoice.due_date ? formatDate(invoice.due_date) : '—'}</td>
                        <td className="px-1.5 py-1 text-right text-xs text-gray-700 font-mono">
                          {isUSD ? `$ ${Number(invoice.total_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `Rp ${Number(invoice.total_amount).toLocaleString('id-ID')}`}
                        </td>
                        <td className="px-1.5 py-1 text-right text-xs text-green-700 font-mono">
                          {isUSD ? `$ ${Number(invoice.paid_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `Rp ${Number(invoice.paid_amount).toLocaleString('id-ID')}`}
                        </td>
                        <td className="px-1.5 py-1 text-right text-xs font-semibold text-red-600 font-mono">
                          <div>{isUSD ? `$ ${Number(invoice.balance_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `Rp ${Number(invoice.balance_amount).toLocaleString('id-ID')}`}</div>
                          {isUSD && (
                            <div className="text-[10px] text-gray-500 font-normal">Functional: Rp {Math.round(functionalBal).toLocaleString('id-ID')}</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-blue-50 border-t border-blue-200">
                  <tr>
                    <td colSpan={6} className="px-1.5 py-1 text-right text-xs font-bold">
                      Purchase invoice balance (Functional IDR):
                    </td>
                    <td className="px-1.5 py-1 text-right text-xs font-bold text-red-700 font-mono">
                      Rp {totalPurchaseInvoicesPayable.toLocaleString('id-ID', { maximumFractionDigits: 0 })}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {loading ? (
            <div className="px-6 py-8 text-center text-gray-500">Loading...</div>
          ) : outstandingExpenseBills.length === 0 && outstandingPurchaseInvoices.length === 0 ? (
            <div className="px-6 py-8 text-center text-gray-500">
              <FileText className="w-10 h-10 mx-auto text-gray-300 mb-3" />
              <p className="text-sm font-medium text-gray-600">No outstanding purchase invoices or expense bills</p>
              <p className="text-xs text-gray-500 mt-1">
                Expense bills recorded as "Outstanding (A/P)" in the Expense module will appear here.
              </p>
            </div>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Supplier</th>
                  <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Invoice #</th>
                  <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Category</th>
                  <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Description</th>
                  <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Invoice Date</th>
                  <th className="px-1.5 py-1 text-left text-xs font-semibold text-gray-600">Due Date</th>
                  <th className="px-1.5 py-1 text-right text-xs font-semibold text-gray-600">Amount</th>
                  <th className="px-1.5 py-1 text-right text-xs font-semibold text-gray-600">Paid</th>
                  <th className="px-1.5 py-1 text-right text-xs font-semibold text-gray-600">Balance</th>
                  <th className="px-1.5 py-1 text-center text-xs font-semibold text-gray-600">Aging</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {outstandingExpenseBills.map(bill => {
                  const isOverdue = bill.days_overdue > 0;
                  return (
                    <tr key={bill.id} className={`hover:bg-purple-50/40 ${isOverdue ? 'bg-red-50/30' : ''}`}>
                      <td className="px-1.5 py-1">
                        <span className="font-medium text-gray-900 text-xs">
                          {bill.supplier_name || <span className="text-gray-400 italic">No Supplier</span>}
                        </span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="font-mono text-xs text-gray-600">
                          {bill.invoice_number || '—'}
                        </span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="text-xs text-gray-700">{categoryLabel(bill.expense_category)}</span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="text-xs text-gray-600 line-clamp-1">{bill.description || '—'}</span>
                      </td>
                      <td className="px-1.5 py-1 whitespace-nowrap">
                        <span className="text-xs text-gray-700">
                          {new Date(bill.invoice_date).toLocaleDateString('en-GB')}
                        </span>
                      </td>
                      <td className="px-1.5 py-1 whitespace-nowrap">
                        {bill.due_date ? (
                          <span className={`text-xs font-medium ${isOverdue ? 'text-red-600' : 'text-gray-700'}`}>
                            {new Date(bill.due_date).toLocaleDateString('en-GB')}
                            {isOverdue && <AlertCircle className="w-3 h-3 inline ml-1" />}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-1.5 py-1 text-right whitespace-nowrap">
                        <span className="text-xs text-gray-700">Rp {bill.amount.toLocaleString('id-ID')}</span>
                      </td>
                      <td className="px-1.5 py-1 text-right whitespace-nowrap">
                        <span className="text-xs text-green-700">Rp {bill.paid_amount.toLocaleString('id-ID')}</span>
                      </td>
                      <td className="px-1.5 py-1 text-right whitespace-nowrap">
                        <span className="text-xs font-semibold text-red-600">Rp {bill.balance_amount.toLocaleString('id-ID')}</span>
                      </td>
                      <td className="px-1.5 py-1 text-center">
                        {isOverdue ? (
                          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold text-red-700 bg-red-100 border border-red-200 rounded">
                            {bill.days_overdue}d overdue
                          </span>
                        ) : bill.due_date ? (
                          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium text-green-700 bg-green-50 border border-green-200 rounded">
                            Current
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">No due date</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {/* Totals row */}
                <tr className="bg-purple-50 border-t-2 border-purple-200 font-bold">
                  <td colSpan={6} className="px-1.5 py-1 text-right text-xs text-gray-700">
                    TOTAL ({outstandingExpenseBills.length} bills):
                  </td>
                  <td className="px-1.5 py-1 text-right text-xs text-gray-700">
                    Rp {outstandingExpenseBills.reduce((s, b) => s + b.amount, 0).toLocaleString('id-ID')}
                  </td>
                  <td className="px-1.5 py-1 text-right text-xs text-green-700">
                    Rp {outstandingExpenseBills.reduce((s, b) => s + b.paid_amount, 0).toLocaleString('id-ID')}
                  </td>
                  <td className="px-1.5 py-1 text-right text-sm text-red-700 font-bold">
                    Rp {totalExpenseBillsPayable.toLocaleString('id-ID')}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          )}
        </div>
      ) : viewMode === 'bills' ? (
        <DataTable
          columns={billColumns}
          data={bills}
          loading={loading}
          actions={canManage ? (bill) => (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleEditBill(bill)}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
              >
                <Edit className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleDeleteBill(bill.id)}
                className="p-1 text-red-600 hover:bg-red-50 rounded"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ) : undefined}
        />
      ) : (
        <DataTable
          columns={paymentColumns}
          data={payments}
          loading={loading}
          actions={canManage ? (payment) => (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleEditPayment(payment)}
                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
              >
                <Edit className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleDeletePayment(payment.id)}
                className="p-1 text-red-600 hover:bg-red-50 rounded"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ) : undefined}
        />
      )}

      <Modal
        isOpen={billModalOpen}
        onClose={() => {
          setBillModalOpen(false);
          resetBillForm();
        }}
        title={editingBill ? 'Edit Vendor Bill' : 'Add Vendor Bill'}
      >
        <form onSubmit={handleBillSubmit} className="space-y-1">
          <SapRow>
            <FloatingField label="Vendor Name" required span={12} filled={!!billFormData.vendor_name}>
              <input name="vendor_name" aria-label="Vendor Name"
                type="text"
                value={billFormData.vendor_name}
                onChange={(e) => setBillFormData({ ...billFormData, vendor_name: e.target.value })}
                className={FLOAT_INPUT}
                required
              />
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Vendor ID (Optional)" span={6} filled={!!billFormData.vendor_id}>
              <input name="vendor_id_optional" aria-label="Vendor ID (Optional)"
                type="text"
                value={billFormData.vendor_id}
                onChange={(e) => setBillFormData({ ...billFormData, vendor_id: e.target.value })}
                className={FLOAT_INPUT}
              />
            </FloatingField>
            <FloatingField label="Category" required span={6} filled={!!billFormData.category}>
              <select name="category" aria-label="Category"
                value={billFormData.category || ''}
                onChange={(e) => setBillFormData({ ...billFormData, category: e.target.value as VendorBill['category'] })}
                className={FLOAT_INPUT}
                required
              >
                <option value="expense">Expense</option>
                <option value="inventory">Inventory</option>
                <option value="asset">Asset</option>
                <option value="other">Other</option>
              </select>
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Bill Date" required span={6} filled={!!billFormData.bill_date}>
              <input name="bill_date" aria-label="Bill Date"
                type="date"
                value={billFormData.bill_date}
                onChange={(e) => setBillFormData({ ...billFormData, bill_date: e.target.value })}
                className={FLOAT_INPUT}
                required
              />
            </FloatingField>
            <FloatingField label="Due Date" span={6} filled={!!billFormData.due_date}>
              <input name="due_date" aria-label="Due Date"
                type="date"
                value={billFormData.due_date}
                onChange={(e) => setBillFormData({ ...billFormData, due_date: e.target.value })}
                className={FLOAT_INPUT}
              />
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Amount (Rp)" required span={6} filled={!!billFormData.amount}>
              <MoneyInput
                decimal
                value={billFormData.amount}
                onChange={(n) => setBillFormData({ ...billFormData, amount: n })}
                className={FLOAT_INPUT}
                required
              />
            </FloatingField>
            <FloatingField label="Tax Amount (Rp)" span={6} filled={!!billFormData.tax_amount}>
              <MoneyInput
                decimal
                value={billFormData.tax_amount}
                onChange={(n) => setBillFormData({ ...billFormData, tax_amount: n })}
                className={FLOAT_INPUT}
              />
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Total Amount" span={12} staticLabel>
              <div className={FLOAT_INPUT + ' !text-2xl !font-bold text-gray-900'}>
                Rp {(billFormData.amount + billFormData.tax_amount).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Description" span={12} textarea filled={!!billFormData.description}>
              <textarea name="description" aria-label="Description"
                value={billFormData.description}
                onChange={(e) => setBillFormData({ ...billFormData, description: e.target.value })}
                className={FLOAT_TEXTAREA}
                rows={3}
              />
            </FloatingField>
          </SapRow>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => {
                setBillModalOpen(false);
                resetBillForm();
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="h-7 px-2 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition"
            >
              {editingBill ? 'Update Bill' : 'Add Bill'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={paymentModalOpen}
        onClose={() => {
          setPaymentModalOpen(false);
          resetPaymentForm();
        }}
        title={editingPayment ? 'Edit Payment' : 'Record Payment'}
      >
        <form onSubmit={handlePaymentSubmit} className="space-y-1">
          <SapRow>
            <FloatingField label="Bill" required span={12} filled={!!paymentFormData.bill_id}>
              <select name="bill" aria-label="Bill"
                value={paymentFormData.bill_id}
                onChange={(e) => {
                  const billId = e.target.value;
                  const bill = unpaidBills.find(b => b.id === billId);
                  setPaymentFormData({
                    ...paymentFormData,
                    bill_id: billId,
                    amount: bill ? bill.total_amount : 0
                  });
                }}
                className={FLOAT_INPUT}
                required
                disabled={!!editingPayment}
              >
                <option value="">Select a bill</option>
                {unpaidBills.map((bill) => (
                  <option key={bill.id} value={bill.id}>
                    {bill.bill_number} - {bill.vendor_name} (Rp {bill.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
                  </option>
                ))}
              </select>
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Payment Date" required span={6} filled={!!paymentFormData.payment_date}>
              <input name="payment_date" aria-label="Payment Date"
                type="date"
                value={paymentFormData.payment_date}
                onChange={(e) => setPaymentFormData({ ...paymentFormData, payment_date: e.target.value })}
                className={FLOAT_INPUT}
                required
              />
            </FloatingField>
            <FloatingField label="Amount (Rp)" required span={6} filled={!!paymentFormData.amount}>
              <MoneyInput
                decimal
                value={paymentFormData.amount}
                onChange={(n) => setPaymentFormData({ ...paymentFormData, amount: n })}
                className={FLOAT_INPUT}
                required
              />
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Payment Method" required span={6} filled={!!paymentFormData.payment_method}>
              <select name="payment_method" aria-label="Payment Method"
                value={paymentFormData.payment_method}
                onChange={(e) => setPaymentFormData({ ...paymentFormData, payment_method: e.target.value })}
                className={FLOAT_INPUT}
                required
              >
                <option value="bank_transfer">Bank Transfer</option>
                <option value="cash">Cash</option>
                <option value="cheque">Cheque</option>
                <option value="credit_card">Credit Card</option>
                <option value="other">Other</option>
              </select>
            </FloatingField>
            <FloatingField label="Bank Account" span={6} filled={!!paymentFormData.bank_account_id}>
              <select name="bank_account" aria-label="Bank Account"
                value={paymentFormData.bank_account_id}
                onChange={(e) => setPaymentFormData({ ...paymentFormData, bank_account_id: e.target.value })}
                className={FLOAT_INPUT}
              >
                <option value="">Select bank account</option>
                {bankAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.alias || `${account.account_name} - ${account.bank_name}`} ({account.currency || 'IDR'})
                  </option>
                ))}
              </select>
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Reference Number" span={12} filled={!!paymentFormData.reference_number}>
              <input name="reference_number" aria-label="Reference Number"
                type="text"
                value={paymentFormData.reference_number}
                onChange={(e) => setPaymentFormData({ ...paymentFormData, reference_number: e.target.value })}
                className={FLOAT_INPUT}
                placeholder="Transaction/Check number"
              />
            </FloatingField>
          </SapRow>

          <SapRow>
            <FloatingField label="Notes" span={12} textarea filled={!!paymentFormData.notes}>
              <textarea name="notes" aria-label="Notes"
                value={paymentFormData.notes}
                onChange={(e) => setPaymentFormData({ ...paymentFormData, notes: e.target.value })}
                className={FLOAT_TEXTAREA}
                rows={3}
              />
            </FloatingField>
          </SapRow>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => {
                setPaymentModalOpen(false);
                resetPaymentForm();
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
            >
              {editingPayment ? 'Update Payment' : 'Record Payment'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!apDrilldownCategory}
        onClose={() => {
          setApDrilldownCategory(null);
          setApDrilldownLines([]);
        }}
        title={apDrilldownCategory ? `GL 2110 Drill-Down — ${apDrilldownCategory.ap_category_label}` : 'GL 2110 Drill-Down'}
      >
        <div className="space-y-3">
          {loadingApDrilldown ? (
            <p className="text-xs text-gray-500">Loading journal lines...</p>
          ) : apDrilldownLines.length === 0 ? (
            <p className="text-xs text-gray-500">No journal lines found for this category.</p>
          ) : (
            <div className="max-h-96 overflow-auto border border-gray-200 rounded">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Date</th>
                    <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Journal</th>
                    <th className="px-2 py-1.5 text-left font-semibold text-gray-600">Source / Party</th>
                    <th className="px-2 py-1.5 text-right font-semibold text-gray-600">Net GL 2110</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {apDrilldownLines.map((line) => (
                    <tr key={line.journal_entry_line_id}>
                      <td className="px-2 py-1 whitespace-nowrap text-gray-600">{formatDate(line.entry_date)}</td>
                      <td className="px-2 py-1">
                        <div className="font-mono font-medium text-gray-900">{line.entry_number}</div>
                        <div className="text-[11px] text-gray-500">{line.reference_number || line.expense_voucher_number || line.source_module}</div>
                      </td>
                      <td className="px-2 py-1 text-gray-700">
                        <div>{line.supplier_name || line.staff_name || line.payee_name || line.source_module}</div>
                        <div className="text-[11px] text-gray-500 truncate max-w-xs">{line.line_description || line.journal_description}</div>
                      </td>
                      <td className="px-2 py-1 text-right font-mono font-semibold text-gray-900 whitespace-nowrap">
                        Rp {Number(line.net_ap_balance || 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
