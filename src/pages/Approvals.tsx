import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { CheckCircle, XCircle, Clock, Eye, AlertCircle, Filter } from 'lucide-react';
import { Modal } from '../components/Modal';
import { FloatingField, FLOAT_TEXTAREA } from '../components/finance/FloatingField';
import { SapRow } from '../components/finance/SapLayout';
import { formatCurrency, resolveTransactionCurrency } from '../utils/currency';

interface ApprovalWorkflow {
  id: string;
  transaction_type: string;
  transaction_id: string;
  amount: number;
  quantity: number;
  status: string;
  notes?: string;
  rejection_reason?: string;
  metadata?: any;
  created_at: string;
  requested_by_profile: {
    full_name: string;
    email: string;
  };
  approved_by_profile?: {
    full_name: string;
  };
}

const getApprovalCurrency = (approval: ApprovalWorkflow): string =>
  resolveTransactionCurrency({
    transaction_currency: approval.metadata?.transaction_currency,
    currency_code: approval.metadata?.currency_code,
    payment_currency: approval.metadata?.payment_currency,
    bank_account_currency: approval.metadata?.bank_account_currency,
    currency: approval.metadata?.currency,
  });

interface TransactionDetails {
  id: string;
  [key: string]: any;
}

export default function Approvals() {
  const { user, profile: userProfile } = useAuth();
  const { t } = useLanguage();
  const [approvals, setApprovals] = useState<ApprovalWorkflow[]>([]);
  const [filteredApprovals, setFilteredApprovals] = useState<ApprovalWorkflow[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [selectedApproval, setSelectedApproval] = useState<ApprovalWorkflow | null>(null);
  const [transactionDetails, setTransactionDetails] = useState<TransactionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');

  useEffect(() => {
    fetchApprovals();
  }, []);

  useEffect(() => {
    filterApprovals();
  }, [statusFilter, typeFilter, approvals]);

  const fetchApprovals = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('approval_workflows')
        .select(`
          *,
          requested_by_profile:user_profiles!requested_by(full_name, email),
          approved_by_profile:user_profiles!approved_by(full_name)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setApprovals(data || []);
    } catch (error: any) {
      console.error('Error fetching approvals:', error);
      alert(t('errorFetchingApprovals') || 'Error fetching approvals');
    } finally {
      setLoading(false);
    }
  };

  const fetchTransactionDetails = async (approval: ApprovalWorkflow) => {
    try {
      let tableName = '';
      let selectFields = '*';

      switch (approval.transaction_type) {
        case 'material_return':
          tableName = 'material_returns';
          selectFields = '*, customer:customers(company_name)';
          break;
        case 'stock_rejection':
          tableName = 'stock_rejections';
          selectFields = '*, product:products(product_name, product_code), batch:batches(batch_number)';
          break;
        default:
          return null;
      }

      const { data, error } = await supabase
        .from(tableName)
        .select(selectFields)
        .eq('id', approval.transaction_id)
        .single();

      if (error) throw error;
      return data as unknown as TransactionDetails;
    } catch (error: any) {
      console.error('Error fetching transaction details:', error);
      return null;
    }
  };

  const filterApprovals = () => {
    let filtered = approvals;

    if (statusFilter !== 'all') {
      filtered = filtered.filter(a => a.status === statusFilter);
    }

    if (typeFilter !== 'all') {
      filtered = filtered.filter(a => a.transaction_type === typeFilter);
    }

    setFilteredApprovals(filtered);
  };

  const handleViewDetails = async (approval: ApprovalWorkflow) => {
    setSelectedApproval(approval);
    const details = await fetchTransactionDetails(approval);
    setTransactionDetails(details);
    setShowDetailsModal(true);
  };

  const handleApprove = async (approvalId: string, transactionType: string, transactionId: string) => {
    try {
      setActionLoading(true);

      await supabase
        .from('approval_workflows')
        .update({
          status: 'approved',
          approved_by: user?.id,
        })
        .eq('id', approvalId);

      const updateData: any = { status: 'approved', approved_by: user?.id };

      if (transactionType === 'material_return') {
        await supabase
          .from('material_returns')
          .update(updateData)
          .eq('id', transactionId);
      } else if (transactionType === 'stock_rejection') {
        await supabase
          .from('stock_rejections')
          .update(updateData)
          .eq('id', transactionId);
      }

      alert(t('approvalSuccessful') || 'Approval successful');
      setShowDetailsModal(false);
      fetchApprovals();
    } catch (error: any) {
      console.error('Error approving:', error);
      alert(error.message || t('errorApproving') || 'Error approving request');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async (approvalId: string, transactionType: string, transactionId: string) => {
    if (!rejectionReason.trim()) {
      alert(t('pleaseProvideReason') || 'Please provide a reason for rejection');
      return;
    }

    try {
      setActionLoading(true);

      await supabase
        .from('approval_workflows')
        .update({
          status: 'rejected',
          approved_by: user?.id,
          rejection_reason: rejectionReason,
        })
        .eq('id', approvalId);

      const updateData = {
        status: 'rejected',
        notes: rejectionReason,
      };

      if (transactionType === 'material_return') {
        await supabase
          .from('material_returns')
          .update(updateData)
          .eq('id', transactionId);
      } else if (transactionType === 'stock_rejection') {
        await supabase
          .from('stock_rejections')
          .update(updateData)
          .eq('id', transactionId);
      }

      alert(t('rejectionSuccessful') || 'Rejection successful');
      setShowDetailsModal(false);
      setRejectionReason('');
      fetchApprovals();
    } catch (error: any) {
      console.error('Error rejecting:', error);
      alert(error.message || t('errorRejecting') || 'Error rejecting request');
    } finally {
      setActionLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const styles = {
      pending: 'bg-yellow-100 text-yellow-800',
      approved: 'bg-green-100 text-green-800',
      rejected: 'bg-red-100 text-red-800',
    };

    const icons = {
      pending: <Clock className="w-3 h-3 mr-1" />,
      approved: <CheckCircle className="w-3 h-3 mr-1" />,
      rejected: <XCircle className="w-3 h-3 mr-1" />,
    };

    return (
      <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${styles[status as keyof typeof styles] || 'bg-gray-100 text-gray-800'}`}>
        {icons[status as keyof typeof icons]}
        {status.toUpperCase()}
      </span>
    );
  };

  const getTypeLabel = (type: string) => {
    const labels: { [key: string]: string } = {
      material_return: t('materialReturn') || 'Material Return',
      stock_rejection: t('stockRejection') || 'Stock Rejection',
      purchase_approval: t('purchaseApproval') || 'Purchase Approval',
      expense_approval: t('expenseApproval') || 'Expense Approval',
    };
    return labels[type] || type;
  };

  const canApprove = (approval: ApprovalWorkflow) => {
    if (approval.status !== 'pending') return false;

    const requiredRole = approval.metadata?.required_role;

    if (requiredRole === 'admin') {
      return userProfile?.role === 'admin';
    }

    return userProfile?.role === 'manager' || userProfile?.role === 'admin';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg">{t('loading') || 'Loading...'}</div>
      </div>
    );
  }

  const isManager = userProfile?.role === 'manager' || userProfile?.role === 'admin';

  if (!isManager) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            {t('accessDenied') || 'Access Denied'}
          </h2>
          <p className="text-gray-600">
            {t('managerAccessRequired') || 'Manager or Admin access required to view approvals'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 pb-2 border-b border-gray-200">
        <h1 className="text-lg sm:text-xl font-bold text-gray-900 tracking-tight">
          {t('approvalManagement') || 'Approval Management'}
        </h1>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2.5 py-0.5 bg-yellow-100 text-yellow-800 rounded-full font-semibold">
            {filteredApprovals.filter(a => a.status === 'pending').length} {t('common.pending') || 'Pending'}
          </span>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-4 mb-4">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-400" />
            <select name="status_filter" aria-label="Status Filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="all">{t('allStatuses') || 'All Statuses'}</option>
              <option value="pending">{t('pending') || 'Pending'}</option>
              <option value="approved">{t('approved') || 'Approved'}</option>
              <option value="rejected">{t('rejected') || 'Rejected'}</option>
            </select>
          </div>

          <select name="type_filter" aria-label="Type Filter"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">{t('allTypes') || 'All Types'}</option>
            <option value="material_return">{t('nav.materialReturns')}</option>
            <option value="stock_rejection">{t('nav.stockRejections')}</option>
            <option value="purchase_approval">{t('purchaseApprovals') || 'Purchase Approvals'}</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('type') || 'Type'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('requestedBy') || 'Requested By'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('amount') || 'Amount'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('quantity') || 'Quantity'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('requestDate') || 'Request Date'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('status') || 'Status'}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('actions') || 'Actions'}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredApprovals.map((approval) => (
                <tr key={approval.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {getTypeLabel(approval.transaction_type)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    <div>{approval.requested_by_profile.full_name}</div>
                    <div className="text-xs text-gray-500">{approval.requested_by_profile.email}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {formatCurrency(approval.amount, getApprovalCurrency(approval))}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {approval.quantity || '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {new Date(approval.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {getStatusBadge(approval.status)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <button
                      onClick={() => handleViewDetails(approval)}
                      className="text-blue-600 hover:text-blue-800 inline-flex items-center"
                    >
                      <Eye className="w-4 h-4 mr-1" />
                      {t('view') || 'View'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredApprovals.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              {t('noApprovalsFound') || 'No approvals found'}
            </div>
          )}
        </div>
      </div>

      {showDetailsModal && selectedApproval && (
        <Modal
          isOpen={showDetailsModal}
          onClose={() => {
            setShowDetailsModal(false);
            setSelectedApproval(null);
            setTransactionDetails(null);
            setRejectionReason('');
          }}
          title={`${getTypeLabel(selectedApproval.transaction_type)} - ${t('approvalDetails') || 'Approval Details'}`}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('requestedBy') || 'Requested By'}
                </label>
                <p className="text-sm text-gray-900">{selectedApproval.requested_by_profile.full_name}</p>
                <p className="text-xs text-gray-500">{selectedApproval.requested_by_profile.email}</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('requestDate') || 'Request Date'}
                </label>
                <p className="text-sm text-gray-900">
                  {new Date(selectedApproval.created_at).toLocaleString()}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('amount') || 'Amount'}
                </label>
                <p className="text-sm font-semibold text-gray-900">
                  {formatCurrency(selectedApproval.amount, getApprovalCurrency(selectedApproval))}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('status') || 'Status'}
                </label>
                {getStatusBadge(selectedApproval.status)}
              </div>
            </div>

            {transactionDetails && (
              <div className="border-t pt-4">
                <h3 className="text-sm font-semibold text-gray-900 mb-3">
                  {t('transactionDetails') || 'Transaction Details'}
                </h3>
                <div className="bg-gray-50 rounded-lg p-3 space-y-2 text-sm">
                  {selectedApproval.transaction_type === 'material_return' && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-600">{t('returnNumber') || 'Return #'}:</span>
                        <span className="font-medium">{transactionDetails.return_number}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">{t('customer') || 'Customer'}:</span>
                        <span className="font-medium">{transactionDetails.customer?.company_name}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">{t('returnType') || 'Return Type'}:</span>
                        <span className="font-medium">{transactionDetails.return_type}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">{t('reason') || 'Reason'}:</span>
                        <span className="font-medium">{transactionDetails.return_reason}</span>
                      </div>
                    </>
                  )}

                  {selectedApproval.transaction_type === 'stock_rejection' && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-600">{t('rejectionNumber') || 'Rejection #'}:</span>
                        <span className="font-medium">{transactionDetails.rejection_number}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">{t('product') || 'Product'}:</span>
                        <span className="font-medium">{transactionDetails.product?.product_name}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">{t('batch') || 'Batch'}:</span>
                        <span className="font-medium">{transactionDetails.batch?.batch_number}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">{t('quantityRejected') || 'Quantity Rejected'}:</span>
                        <span className="font-medium">{transactionDetails.quantity_rejected}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">{t('reason') || 'Reason'}:</span>
                        <span className="font-medium">{transactionDetails.rejection_reason}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">{t('details') || 'Details'}:</span>
                        <span className="font-medium">{transactionDetails.rejection_details}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {selectedApproval.status === 'rejected' && selectedApproval.rejection_reason && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm font-medium text-red-900 mb-1">
                  {t('rejectionReason') || 'Rejection Reason'}
                </p>
                <p className="text-sm text-red-700">{selectedApproval.rejection_reason}</p>
              </div>
            )}

            {selectedApproval.status === 'pending' && canApprove(selectedApproval) && (
              <div className="border-t pt-4 space-y-3">
                <SapRow>
                  <FloatingField
                    label={`${t('rejectionReason') || 'Rejection Reason'} (${t('ifRejecting') || 'if rejecting'})`}
                    textarea
                    filled={!!rejectionReason.trim()}
                    span={12}
                  >
                    <textarea name="t_rejectionreason_rejection_re" aria-label="{t('rejectionReason') || 'Rejection Reason'} ({t('ifRejecting') || 'if rejecting'})"
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                      rows={3}
                      placeholder={t('provideReasonForRejection') || 'Provide reason for rejection...'}
                      className={FLOAT_TEXTAREA}
                    />
                  </FloatingField>
                </SapRow>

                <div className="flex justify-end gap-2">
                  <button
                    onClick={() =>
                      handleReject(
                        selectedApproval.id,
                        selectedApproval.transaction_type,
                        selectedApproval.transaction_id
                      )
                    }
                    disabled={actionLoading}
                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 inline-flex items-center"
                  >
                    <XCircle className="w-4 h-4 mr-2" />
                    {actionLoading ? t('rejecting') || 'Rejecting...' : t('reject') || 'Reject'}
                  </button>
                  <button
                    onClick={() =>
                      handleApprove(
                        selectedApproval.id,
                        selectedApproval.transaction_type,
                        selectedApproval.transaction_id
                      )
                    }
                    disabled={actionLoading}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 inline-flex items-center"
                  >
                    <CheckCircle className="w-4 h-4 mr-2" />
                    {actionLoading ? t('approving') || 'Approving...' : t('approve') || 'Approve'}
                  </button>
                </div>
              </div>
            )}

            {selectedApproval.status === 'pending' && !canApprove(selectedApproval) && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex items-start">
                <AlertCircle className="w-5 h-5 text-yellow-600 mr-2 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-yellow-800">
                  <p className="font-medium">
                    {t('insufficientPermissions') || 'Insufficient Permissions'}
                  </p>
                  <p className="mt-1">
                    {selectedApproval.metadata?.required_role === 'admin'
                      ? t('adminApprovalRequired') || 'This request requires admin approval'
                      : t('managerApprovalRequired') || 'This request requires manager approval'}
                  </p>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
