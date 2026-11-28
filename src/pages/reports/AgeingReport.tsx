import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { FALLBACK_COMPANY } from '../../types/company';
import { FileDown, ChevronDown, ChevronUp, AlertTriangle, Mail, CheckSquare, X, Send, Loader, MessageCircle } from 'lucide-react';
import { useLanguage } from '../../contexts/LanguageContext';
import { useAuth } from '../../contexts/AuthContext';
import { useFinance } from '../../contexts/FinanceContext';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../../components/finance/FloatingField';
import { SapRow } from '../../components/finance/SapLayout';

interface InvoiceDetail {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  total_amount: number;
  paid_amount: number;
  balance: number;
  days_overdue: number;
}

interface CustomerAgeing {
  customer_id: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  total_outstanding: number;
  invoice_count: number;
  oldest_overdue_days: number;
  invoices: InvoiceDetail[];
}

interface ReminderModal {
  customer: CustomerAgeing;
}

interface TaskModal {
  customer: CustomerAgeing;
}

export function AgeingReport() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  const { dateRange } = useFinance();
  const [ageingData, setAgeingData] = useState<CustomerAgeing[]>([]);
  const [loading, setLoading] = useState(true);
  const [asOfDate, setAsOfDate] = useState(dateRange.endDate);
  const [expandedCustomers, setExpandedCustomers] = useState<Set<string>>(new Set());
  const [reminderModal, setReminderModal] = useState<ReminderModal | null>(null);
  const [taskModal, setTaskModal] = useState<TaskModal | null>(null);
  const [reminderSending, setReminderSending] = useState(false);
  const [taskSaving, setTaskSaving] = useState(false);
  const [companyName, setCompanyName] = useState(FALLBACK_COMPANY.company_name);
  const [reminderNote, setReminderNote] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDeadline, setTaskDeadline] = useState('');
  const [taskPriority, setTaskPriority] = useState<'low' | 'medium' | 'high'>('high');

  useEffect(() => {
    loadAgeingData();
  }, [asOfDate]);

  // Keep the dedicated ageing report aligned with Finance's global reporting
  // period when the user changes the end date. The local control remains
  // available for an explicit as-of override within the report.
  useEffect(() => {
    setAsOfDate(dateRange.endDate);
  }, [dateRange.endDate]);

  useEffect(() => {
    supabase
      .from('company_profiles')
      .select('company_name')
      .lte('effective_from', new Date().toISOString().split('T')[0])
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => { if (data?.company_name) setCompanyName(data.company_name); });
  }, []);

  const loadAgeingData = async () => {
    try {
      setLoading(true);

      const { data: invoices, error } = await supabase
        .from('sales_invoices')
        .select('*, customers(company_name, email, phone)')
        .in('payment_status', ['pending', 'partial'])
        .order('due_date');

      if (error) throw error;

      const activePostedInvoices = (invoices || []).filter((inv: any) => {
        if (inv.document_status === 'cancelled' || inv.document_status === 'draft') return false;
        if (inv.is_draft) return false;
        if (inv.notes?.includes('[CANCELLED') || inv.notes?.toLowerCase().startsWith('cancelled')) return false;
        return true;
      });

      const invoicesWithBalances = await Promise.all(
        activePostedInvoices.map(async (inv) => {
          const { data: paidData } = await supabase
            .rpc('get_invoice_paid_amount', { p_invoice_id: inv.id });

          const paidAmount = paidData || 0;
          const balance = inv.total_amount - paidAmount;

          const dueDate = new Date(inv.due_date);
          const today = new Date(asOfDate);
          const daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));

          return {
            id: inv.id,
            customer_id: inv.customer_id,
            customer_name: inv.customers?.company_name || 'Unknown',
            customer_email: inv.customers?.email || '',
            customer_phone: inv.customers?.phone || '',
            invoice_number: inv.invoice_number,
            invoice_date: inv.invoice_date,
            due_date: inv.due_date,
            total_amount: inv.total_amount,
            paid_amount: paidAmount,
            balance,
            days_overdue: daysOverdue
          };
        })
      );

      const customerMap = new Map<string, CustomerAgeing>();

      invoicesWithBalances.forEach(inv => {
        const customerId = inv.customer_id;

        if (!customerMap.has(customerId)) {
          customerMap.set(customerId, {
            customer_id: customerId,
            customer_name: inv.customer_name,
            customer_email: inv.customer_email,
            customer_phone: inv.customer_phone,
            total_outstanding: 0,
            invoice_count: 0,
            oldest_overdue_days: -999,
            invoices: []
          });
        }

        const data = customerMap.get(customerId)!;
        data.total_outstanding += inv.balance;
        data.invoice_count += 1;
        data.oldest_overdue_days = Math.max(data.oldest_overdue_days, inv.days_overdue);
        data.invoices.push(inv);
      });

      const sortedData = Array.from(customerMap.values()).sort((a, b) => {
        if (a.oldest_overdue_days !== b.oldest_overdue_days) {
          return b.oldest_overdue_days - a.oldest_overdue_days;
        }
        return b.total_outstanding - a.total_outstanding;
      });

      setAgeingData(sortedData);
    } catch (error) {
      console.error('Error loading ageing data:', error);
    } finally {
      setLoading(false);
    }
  };

  const toggleCustomer = (customerId: string) => {
    const newExpanded = new Set(expandedCustomers);
    if (newExpanded.has(customerId)) {
      newExpanded.delete(customerId);
    } else {
      newExpanded.add(customerId);
    }
    setExpandedCustomers(newExpanded);
  };

  const exportToCSV = () => {
    const rows: string[][] = [];
    rows.push(['Customer', 'Total Outstanding', 'Invoices', 'Oldest Overdue (Days)', 'Status']);

    ageingData.forEach(customer => {
      rows.push([
        customer.customer_name,
        customer.total_outstanding.toString(),
        customer.invoice_count.toString(),
        customer.oldest_overdue_days.toString(),
        customer.oldest_overdue_days > 90 ? 'CRITICAL' : customer.oldest_overdue_days > 0 ? 'OVERDUE' : 'CURRENT'
      ]);

      rows.push(['', 'Invoice #', 'Invoice Date', 'Due Date', 'Amount', 'Paid', 'Balance', 'Days Overdue']);
      customer.invoices.forEach(inv => {
        rows.push([
          '',
          inv.invoice_number,
          inv.invoice_date,
          inv.due_date,
          inv.total_amount.toString(),
          inv.paid_amount.toString(),
          inv.balance.toString(),
          inv.days_overdue.toString()
        ]);
      });
      rows.push(['']);
    });

    const csvContent = rows.map(row => row.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ageing_report_${asOfDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openReminderModal = (customer: CustomerAgeing) => {
    const overdueList = customer.invoices
      .filter(i => i.days_overdue > 0)
      .map(i => `- Invoice ${i.invoice_number} (${i.days_overdue} days overdue, balance: Rp ${i.balance.toLocaleString('id-ID')})`)
      .join('\n');

    setReminderNote(
      `Dear ${customer.customer_name},\n\nThis is a payment reminder for the following outstanding invoices:\n\n${overdueList}\n\nTotal Outstanding: Rp ${customer.total_outstanding.toLocaleString('id-ID')}\n\nKindly arrange payment at your earliest convenience.\n\nThank you.`
    );
    setReminderModal({ customer });
  };

  const handleSendReminder = async () => {
    if (!reminderModal) return;

    const customerEmail = reminderModal.customer.customer_email;
    if (!customerEmail) {
      alert('This customer has no email address on file. Please update the customer record first.');
      return;
    }

    setReminderSending(true);
    try {
      const { data: result, error } = await supabase.functions.invoke('send-app-notifications', {
        body: {
          type: 'payment_reminder',
          sender_user_id: profile?.id,
          data: {
            customer_email: customerEmail,
            customer_name: reminderModal.customer.customer_name,
            customer_id: reminderModal.customer.customer_id,
            reminder_body: reminderNote,
          }
        }
      });

      if (error) throw error;

      if (result?.result?.error) {
        throw new Error(result.result.error as string);
      }

      alert(`Reminder sent successfully from ${result?.result?.sender ?? 'your Gmail account'}.`);
      setReminderModal(null);
      setReminderNote('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Failed to send reminder:', msg);
      alert(`Failed to send reminder: ${msg}\n\nMake sure your Gmail account is connected in CRM → Gmail Settings.`);
    } finally {
      setReminderSending(false);
    }
  };

  const handleWhatsAppReminder = (customer: CustomerAgeing) => {
    if (!customer.customer_phone) {
      alert('This customer has no phone number on file. Please update the customer record first.');
      return;
    }

    const overdueInvoices = customer.invoices.filter(i => i.days_overdue > 0);
    const invoiceLines = overdueInvoices
      .map(i => `• ${i.invoice_number} — Rp ${i.balance.toLocaleString('id-ID')} (${i.days_overdue}d overdue)`)
      .join('\n');

    const message = `Dear ${customer.customer_name},\n\nThis is a payment reminder for the following outstanding invoices:\n\n${invoiceLines}\n\nTotal Outstanding: Rp ${customer.total_outstanding.toLocaleString('id-ID')}\n\nKindly arrange payment at your earliest convenience.\n\nThank you,\n${companyName}`;

    const phone = customer.customer_phone.replace(/\D/g, '');
    const formattedPhone = phone.startsWith('0') ? `62${phone.slice(1)}` : phone.startsWith('62') ? phone : `62${phone}`;
    const url = `https://wa.me/${formattedPhone}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  };

  const openTaskModal = (customer: CustomerAgeing) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setTaskTitle(`Follow up payment – ${customer.customer_name} (Rp ${customer.total_outstanding.toLocaleString('id-ID')} outstanding)`);
    setTaskDeadline(tomorrow.toISOString().split('T')[0]);
    setTaskPriority(customer.oldest_overdue_days > 60 ? 'high' : 'medium');
    setTaskModal({ customer });
  };

  const handleCreateTask = async () => {
    if (!taskModal || !taskTitle.trim()) return;
    setTaskSaving(true);
    try {
      const { error } = await supabase.from('tasks').insert({
        title: taskTitle.trim(),
        description: `Outstanding balance: Rp ${taskModal.customer.total_outstanding.toLocaleString('id-ID')}\nOldest overdue: ${taskModal.customer.oldest_overdue_days} days\n\nInvoices:\n${taskModal.customer.invoices.map(i => `${i.invoice_number}: Rp ${i.balance.toLocaleString('id-ID')} (${i.days_overdue}d)`).join('\n')}`,
        deadline: taskDeadline ? new Date(taskDeadline).toISOString() : null,
        priority: taskPriority,
        status: 'pending',
        customer_id: taskModal.customer.customer_id,
        created_by: profile?.id,
        assigned_users: profile?.id ? [profile.id] : []
      });

      if (error) throw error;

      setTaskModal(null);
      setTaskTitle('');
    } catch (err) {
      console.error('Failed to create task:', err);
      alert('Failed to create task. Please try again.');
    } finally {
      setTaskSaving(false);
    }
  };

  const getDaysOverdueColor = (days: number) => {
    if (days < 0) return 'text-green-600';
    if (days === 0) return 'text-gray-600';
    if (days <= 30) return 'text-yellow-600';
    if (days <= 60) return 'text-orange-600';
    if (days <= 90) return 'text-red-600';
    return 'text-red-900 font-bold';
  };

  const getDaysOverdueBadge = (days: number) => {
    if (days < 0) return { text: t('not_due', 'Not Due'), color: 'bg-green-100 text-green-800' };
    if (days === 0) return { text: t('due_today', 'Due Today'), color: 'bg-gray-100 text-gray-800' };
    if (days <= 30) return { text: `${days}d ${t('overdue', 'Overdue')}`, color: 'bg-yellow-100 text-yellow-800' };
    if (days <= 60) return { text: `${days}d ${t('overdue', 'Overdue')}`, color: 'bg-orange-100 text-orange-800' };
    if (days <= 90) return { text: `${days}d ${t('overdue', 'Overdue')}`, color: 'bg-red-100 text-red-800' };
    return { text: `${days}d ${t('critical', 'CRITICAL')}`, color: 'bg-red-200 text-red-900 font-bold' };
  };

  const totalOutstanding = ageingData.reduce((sum, c) => sum + c.total_outstanding, 0);
  const totalInvoices = ageingData.reduce((sum, c) => sum + c.invoice_count, 0);
  const criticalCustomers = ageingData.filter(c => c.oldest_overdue_days > 90).length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 bg-white rounded-lg border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium text-gray-700">As of:</div>
          <input name="as_of_date" aria-label="As Of Date"
            type="date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            className="h-10 border border-gray-300 rounded-md px-3 text-sm focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <button
          onClick={exportToCSV}
          disabled={ageingData.length === 0}
          className="inline-flex min-h-[38px] items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-green-700 transition disabled:opacity-50"
        >
          <FileDown className="w-3.5 h-3.5" />
          {t('export_csv', 'Export CSV')}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white rounded-lg shadow-sm p-4 border-l-4 border-blue-500">
          <p className="text-[10px] text-gray-600">{t('total_outstanding', 'Total Outstanding')}</p>
          <p className="text-base font-bold text-gray-900 mt-0.5">
            Rp {totalOutstanding.toLocaleString('id-ID', { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-4 border-l-4 border-gray-400">
          <p className="text-[10px] text-gray-600">{t('total_invoices', 'Total Invoices')}</p>
          <p className="text-base font-bold text-gray-900 mt-0.5">{totalInvoices}</p>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-4 border-l-4 border-orange-500">
          <p className="text-[10px] text-gray-600">{t('nav.customers')}</p>
          <p className="text-base font-bold text-gray-900 mt-0.5">{ageingData.length}</p>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-4 border-l-4 border-red-600">
          <p className="text-[10px] text-gray-600 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-red-600" />
            {t('critical_90_days', 'Critical (90+ days)')}
          </p>
          <p className="text-base font-bold text-red-900 mt-0.5">{criticalCustomers}</p>
        </div>
      </div>

      {/* Data Table */}
      <div className="bg-white rounded border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center">
            <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
            <p className="mt-2 text-sm text-gray-500">{t('loading', 'Loading ageing data')}...</p>
          </div>
        ) : ageingData.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <p className="text-sm font-medium">{t('no_outstanding', 'No Outstanding Invoices')}</p>
            <p className="text-xs mt-1">{t('all_paid', 'All invoices are fully paid!')}</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {ageingData.map((customer) => {
              const isExpanded = expandedCustomers.has(customer.customer_id);
              const badge = getDaysOverdueBadge(customer.oldest_overdue_days);

              return (
                <div key={customer.customer_id}>
                  <div className="min-h-14 px-4 py-3 hover:bg-gray-50 flex items-center justify-between gap-3">
                    <div
                      className="flex-1 flex items-center gap-3 cursor-pointer"
                      onClick={() => toggleCustomer(customer.customer_id)}
                    >
                      <button className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm text-gray-900 truncate">{customer.customer_name}</p>
                        <p className="text-xs text-gray-500">{customer.invoice_count} {t('invoices', 'invoice(s)')}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div className="text-right hidden sm:block">
                        <p className="font-bold text-sm text-gray-900">
                          Rp {customer.total_outstanding.toLocaleString('id-ID', { minimumFractionDigits: 2 })}
                        </p>
                      </div>
                      <div className="hidden md:block w-28">
                        <span className={`inline-flex h-6 items-center px-2.5 rounded-full text-xs font-semibold whitespace-nowrap ${badge.color}`}>
                          {badge.text}
                        </span>
                      </div>

                      {/* Action Buttons */}
                      <button
                        onClick={(e) => { e.stopPropagation(); openReminderModal(customer); }}
                        className="flex items-center gap-1 px-2 py-1 text-[11px] bg-blue-50 text-blue-700 rounded hover:bg-blue-100 transition border border-blue-200"
                        title="Send payment reminder via Gmail"
                      >
                        <Mail className="w-3 h-3" />
                        <span className="hidden sm:inline">Email</span>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleWhatsAppReminder(customer); }}
                        className="flex items-center gap-1 px-2 py-1 text-[11px] bg-green-50 text-green-700 rounded hover:bg-green-100 transition border border-green-200"
                        title="Send payment reminder via WhatsApp"
                      >
                        <MessageCircle className="w-3 h-3" />
                        <span className="hidden sm:inline">WA</span>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); openTaskModal(customer); }}
                        className="flex items-center gap-1 px-2 py-1 text-[11px] bg-orange-50 text-orange-700 rounded hover:bg-orange-100 transition border border-orange-200"
                        title="Create follow-up task"
                      >
                        <CheckSquare className="w-3 h-3" />
                        <span className="hidden sm:inline">Task</span>
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="bg-gray-50 px-3 pb-3">
                      <div className="block sm:hidden mb-2">
                        <p className="text-xs font-medium text-gray-700">
                          Total: Rp {customer.total_outstanding.toLocaleString('id-ID', { minimumFractionDigits: 2 })}
                          <span className={`ml-2 inline-flex h-6 items-center px-2.5 rounded-full text-xs font-semibold whitespace-nowrap ${badge.color}`}>
                            {badge.text}
                          </span>
                        </p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="border-b border-gray-300">
                            <tr className="text-[10px] text-gray-600">
                              <th className="text-left py-1.5 px-2">{t('invoice_number', 'Invoice #')}</th>
                              <th className="text-left py-1.5 px-2">{t('invoice_date', 'Invoice Date')}</th>
                              <th className="text-left py-1.5 px-2">{t('due_date', 'Due Date')}</th>
                              <th className="text-right py-1.5 px-2">{t('amount', 'Amount')}</th>
                              <th className="text-right py-1.5 px-2">{t('paid', 'Paid')}</th>
                              <th className="text-right py-1.5 px-2">{t('balance', 'Balance')}</th>
                              <th className="text-center py-1.5 px-2">{t('days_overdue', 'Days Overdue')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200">
                            {customer.invoices.map((invoice) => (
                              <tr key={invoice.id} className="hover:bg-gray-100">
                                <td className="py-1.5 px-2 font-mono text-blue-600">{invoice.invoice_number}</td>
                                <td className="py-1.5 px-2">{new Date(invoice.invoice_date).toLocaleDateString('id-ID')}</td>
                                <td className="py-1.5 px-2">{new Date(invoice.due_date).toLocaleDateString('id-ID')}</td>
                                <td className="py-1.5 px-2 text-right">
                                  Rp {invoice.total_amount.toLocaleString('id-ID', { minimumFractionDigits: 2 })}
                                </td>
                                <td className="py-1.5 px-2 text-right text-green-600">
                                  Rp {invoice.paid_amount.toLocaleString('id-ID', { minimumFractionDigits: 2 })}
                                </td>
                                <td className="py-1.5 px-2 text-right font-medium">
                                  Rp {invoice.balance.toLocaleString('id-ID', { minimumFractionDigits: 2 })}
                                </td>
                                <td className="py-1.5 px-2 text-center">
                                  <span className={`font-medium ${getDaysOverdueColor(invoice.days_overdue)}`}>
                                    {invoice.days_overdue < 0 ? `${t('due_in', 'Due in')} ${Math.abs(invoice.days_overdue)}d` : invoice.days_overdue === 0 ? t('today', 'Today') : `${invoice.days_overdue}d`}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Send Reminder Modal */}
      {reminderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-blue-600" />
                <h3 className="font-semibold text-gray-900 text-sm">Send Payment Reminder</h3>
              </div>
              <button onClick={() => setReminderModal(null)} className="p-1 rounded hover:bg-gray-100">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-800">
                <p className="font-medium">{reminderModal.customer.customer_name}</p>
                {reminderModal.customer.customer_email ? (
                  <p className="text-blue-600 mt-0.5">{reminderModal.customer.customer_email}</p>
                ) : (
                  <p className="text-red-600 mt-0.5">No email address on file</p>
                )}
                <p className="mt-1">Outstanding: <strong>Rp {reminderModal.customer.total_outstanding.toLocaleString('id-ID')}</strong></p>
              </div>
              <SapRow>
                <FloatingField label="Email Message" span={12} textarea filled={!!reminderNote}>
                  <textarea name="email_message" aria-label="Email Message"
                    value={reminderNote}
                    onChange={(e) => setReminderNote(e.target.value)}
                    rows={8}
                    className={FLOAT_TEXTAREA}
                  />
                </FloatingField>
              </SapRow>
            </div>
            <div className="flex justify-end gap-2 px-4 pb-4">
              <button
                onClick={() => setReminderModal(null)}
                className="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSendReminder}
                disabled={reminderSending || !reminderModal.customer.customer_email}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {reminderSending ? <Loader className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                {reminderSending ? 'Sending...' : 'Send Reminder'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Task Modal */}
      {taskModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-orange-600" />
                <h3 className="font-semibold text-gray-900 text-sm">Create Follow-up Task</h3>
              </div>
              <button onClick={() => setTaskModal(null)} className="p-1 rounded hover:bg-gray-100">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="bg-orange-50 rounded-lg p-3 text-xs text-orange-800">
                <p className="font-medium">{taskModal.customer.customer_name}</p>
                <p className="mt-0.5">Outstanding: <strong>Rp {taskModal.customer.total_outstanding.toLocaleString('id-ID')}</strong></p>
                <p className="mt-0.5">Oldest overdue: <strong>{taskModal.customer.oldest_overdue_days} days</strong></p>
              </div>
              <SapRow>
                <FloatingField label="Task Title" span={12} filled={!!taskTitle}>
                  <input name="task_title" aria-label="Task Title"
                    type="text"
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    className={FLOAT_INPUT}
                  />
                </FloatingField>
                <FloatingField label="Deadline" span={6} filled={!!taskDeadline}>
                  <input name="deadline" aria-label="Deadline"
                    type="date"
                    value={taskDeadline}
                    onChange={(e) => setTaskDeadline(e.target.value)}
                    className={FLOAT_INPUT}
                  />
                </FloatingField>
                <FloatingField label="Priority" span={6} filled={!!taskPriority}>
                  <select name="priority" aria-label="Priority"
                    value={taskPriority}
                    onChange={(e) => setTaskPriority(e.target.value as 'low' | 'medium' | 'high')}
                    className={FLOAT_INPUT}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </FloatingField>
              </SapRow>
            </div>
            <div className="flex justify-end gap-2 px-4 pb-4">
              <button
                onClick={() => setTaskModal(null)}
                className="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateTask}
                disabled={taskSaving || !taskTitle.trim()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50"
              >
                {taskSaving ? <Loader className="w-3 h-3 animate-spin" /> : <CheckSquare className="w-3 h-3" />}
                {taskSaving ? 'Creating...' : 'Create Task'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
