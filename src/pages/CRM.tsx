import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { Modal } from '../components/Modal';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useNavigation } from '../contexts/NavigationContext';
import { supabase } from '../lib/supabase';
import {
  Inbox,
  Table,
  Send,
  Users,
  Search,
  Plus,
  SlidersHorizontal,
  RefreshCw,
  FileText,
  Sparkles,
  LayoutDashboard,
  CheckSquare,
} from 'lucide-react';

import { CrmActivityDashboard } from '../components/crm/dashboard/CrmActivityDashboard';
import { CrmFollowupsWorkspace } from '../components/crm/followups/CrmFollowupsWorkspace';
import { CrmOmnichannelInbox } from '../components/crm/inbox/CrmOmnichannelInbox';
import { CrmInquiriesWorkspace } from '../components/crm/inquiries/CrmInquiriesWorkspace';
import { CrmInquiryDrawer } from '../components/crm/inquiries/CrmInquiryDrawer';
import { CrmCampaignsWorkspace } from '../components/crm/campaigns/CrmCampaignsWorkspace';
import { CrmCustomersWorkspace } from '../components/crm/customers/CrmCustomersWorkspace';
import { CrmCustomerDrawer, CustomerDetail } from '../components/crm/customers/CrmCustomerDrawer';
import { CrmGlobalSearchModal } from '../components/crm/search/CrmGlobalSearchModal';
import { CrmSettingsModal } from '../components/crm/settings/CrmSettingsModal';
import { ProductDocumentsPanel } from '../components/crm/ProductDocumentsPanel';
import { EnquiryControlCenter } from '../components/crm/enquiry-control-center';
import { CompactInquiryForm } from '../components/crm/CompactInquiryForm';
import { CustomerSelectionDialog } from '../components/crm/CustomerSelectionDialog';
import { CustomerConfirmationDialog } from '../components/crm/CustomerConfirmationDialog';
import { CustomerUpdateDialog } from '../components/crm/CustomerUpdateDialog';
import { registerRecentInquiryValues } from '../services/crmInquirySuggestions';
import {
  ensureUniqueCrmContactName,
  findOrCreateCrmContact,
  isDuplicateCrmContactError,
} from '../utils/customerValidation';
import { fuzzyMatchCompanyName, detectCustomerChanges, findBestMatch } from '../utils/customerMatching';
import {
  useCrmInquiries,
  CRM_INQUIRY_SELECT_FIELDS,
  type Inquiry,
} from '../components/crm/inquiries/useCrmInquiries';

export type { Inquiry };

export type CrmPrimaryTab = 'dashboard' | 'inbox' | 'followups' | 'inquiries' | 'campaigns' | 'customers' | 'documents';

export function CRM() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const { navigationData, clearNavigationData } = useNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Helper to resolve active tab from URL path (/crm/customers) or query param (?tab=customers)
  const resolveActiveTabFromUrl = useCallback((): CrmPrimaryTab => {
    const pathParts = location.pathname.split('/').filter(Boolean);
    if (pathParts[0] === 'crm' && pathParts[1]) {
      const sub = pathParts[1].toLowerCase();
      if (sub === 'dashboard') return 'dashboard';
      if (sub === 'followups' || sub === 'follow-ups' || sub === 'todo' || sub === 'meetings') return 'followups';
      if (sub === 'customers') return 'customers';
      if (sub === 'documents' || sub === 'document-bank') return 'documents';
      if (sub === 'inquiries' || sub === 'control-center') return 'inquiries';
      if (sub === 'campaigns' || sub === 'bulk-email' || sub === 'bulk_email') return 'campaigns';
      if (sub === 'inbox') return 'inbox';
    }
    const tabParam = searchParams.get('tab')?.toLowerCase();
    if (tabParam) {
      if (tabParam === 'dashboard') return 'dashboard';
      if (tabParam === 'followups' || tabParam === 'follow-ups' || tabParam === 'todo' || tabParam === 'meetings') return 'followups';
      if (tabParam === 'customers') return 'customers';
      if (tabParam === 'documents' || tabParam === 'document-bank') return 'documents';
      if (tabParam === 'inquiries' || tabParam === 'control-center') return 'inquiries';
      if (tabParam === 'campaigns' || tabParam === 'bulk-email' || tabParam === 'bulk_email') return 'campaigns';
      if (tabParam === 'inbox') return 'inbox';
    }
    return 'dashboard';
  }, [location.pathname, searchParams]);

  // Primary CRM destination initialized from URL
  const [activeTab, setActiveTab] = useState<CrmPrimaryTab>(resolveActiveTabFromUrl);

  const handleTabChange = useCallback((newTab: CrmPrimaryTab) => {
    setActiveTab(newTab);
    const newParams = new URLSearchParams(searchParams);
    // Remove tab-specific IDs when switching main tab
    newParams.delete('inquiryId');
    newParams.delete('customerId');
    newParams.delete('id');
    const paramStr = newParams.toString() ? `?${newParams.toString()}` : '';
    navigate(`/crm/${newTab}${paramStr}`);
  }, [navigate, searchParams]);

  // Synchronize activeTab with URL when navigating back/forward or externally
  useEffect(() => {
    const resolved = resolveActiveTabFromUrl();
    if (resolved !== activeTab) {
      setActiveTab(resolved);
    }
  }, [resolveActiveTabFromUrl, activeTab]);

  const { inquiries, loading, error: crmError, refresh: loadInquiries } = useCrmInquiries();
  const error = crmError ? t('errors.failedToLoadInquiries') : null;

  // Inquiry Drawer & Modals
  const [targetInquiryId, setTargetInquiryId] = useState<string | null>(null);
  const [selectedInquiryForDrawer, setSelectedInquiryForDrawer] = useState<any>(null);
  const [isInquiryDrawerOpen, setIsInquiryDrawerOpen] = useState(false);

  // Customer Drawer
  const [selectedCustomerForDrawer, setSelectedCustomerForDrawer] = useState<CustomerDetail | null>(null);

  // Global Search Modal (Cmd+K)
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Settings / Control Center / Connection Health Modal
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // New / Edit Inquiry Form Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingInquiry, setEditingInquiry] = useState<Inquiry | null>(null);
  const [prefillInquiry, setPrefillInquiry] = useState<any>(null);

  // Bulk Email Handover State
  const [stagedBulkRecipients, setStagedBulkRecipients] = useState<any[]>([]);

  // Customer deduplication / selection state
  const [pendingFormData, setPendingFormData] = useState<any>(null);
  const [customerMatches, setCustomerMatches] = useState<any[]>([]);
  const [showCustomerSelectionDialog, setShowCustomerSelectionDialog] = useState(false);
  const [showCustomerConfirmationDialog, setShowCustomerConfirmationDialog] = useState(false);
  const [showCustomerUpdateDialog, setShowCustomerUpdateDialog] = useState(false);
  const [customerChanges, setCustomerChanges] = useState<any>(null);
  const [inquiryCounts, setInquiryCounts] = useState<Record<string, number>>({});



  // Global Hotkey (Cmd/Ctrl+K) for CRM Global Search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Handle external deep-link navigation (e.g. from Pricing Worksheet or Global Search)
  useEffect(() => {
    const targetId = navigationData?.crmInquiryId;
    if (!targetId || typeof targetId !== 'string' || inquiries.length === 0) return;
    const target = inquiries.find((inquiry) => inquiry.id === targetId);
    if (!target) return;
    setActiveTab('inquiries');
    setTargetInquiryId(targetId);
    setSelectedInquiryForDrawer(target);
    setIsInquiryDrawerOpen(true);
    clearNavigationData();
  }, [clearNavigationData, inquiries, navigationData]);

  // Handle external "Create New Inquiry" prefill
  useEffect(() => {
    const create = navigationData?.crmCreateInquiry as any;
    if (!create || typeof create !== 'object') return;
    setEditingInquiry(null);
    setPrefillInquiry({
      product_name: create.product_name || '',
      company_name: create.company_name || '',
      supplier_name: create.supplier_name || '',
      quantity: create.quantity || '',
      purchase_price: create.purchase_price ?? '',
      purchase_price_currency: create.purchase_price_currency || 'USD',
      offered_price: create.offered_price ?? '',
      offered_price_currency: create.offered_price_currency || 'IDR',
      remarks: create.remarks || '',
      internal_notes: create.internal_notes || '',
    });
    setModalOpen(true);
    clearNavigationData();
  }, [clearNavigationData, navigationData]);

  const handleOpenInquiry = async (inquiryId: string) => {
    // Preserve URL state for refresh retention
    const newParams = new URLSearchParams(searchParams);
    newParams.set('inquiryId', inquiryId);
    setSearchParams(newParams, { replace: true });

    const found = inquiries.find((i) => i.id === inquiryId);
    if (found) {
      setSelectedInquiryForDrawer(found);
      setIsInquiryDrawerOpen(true);
    } else {
      const { data } = await supabase
        .from('crm_inquiries')
        .select(CRM_INQUIRY_SELECT_FIELDS)
        .eq('id', inquiryId)
        .maybeSingle();

      if (data) {
        setSelectedInquiryForDrawer(data);
        setIsInquiryDrawerOpen(true);
      }
    }
  };

  const handleCloseInquiryDrawer = () => {
    setIsInquiryDrawerOpen(false);
    setSelectedInquiryForDrawer(null);
    const newParams = new URLSearchParams(searchParams);
    newParams.delete('inquiryId');
    newParams.delete('id');
    setSearchParams(newParams, { replace: true });
  };

  const handleOpenCustomer = async (customerId: string) => {
    // Preserve URL state for refresh retention
    const newParams = new URLSearchParams(searchParams);
    newParams.set('customerId', customerId);
    setSearchParams(newParams, { replace: true });

    const { data } = await supabase
      .from('crm_contacts')
      .select('*')
      .eq('id', customerId)
      .maybeSingle();

    if (data) {
      setSelectedCustomerForDrawer(data as CustomerDetail);
    }
  };

  const handleCloseCustomerDrawer = () => {
    setSelectedCustomerForDrawer(null);
    const newParams = new URLSearchParams(searchParams);
    newParams.delete('customerId');
    newParams.delete('id');
    setSearchParams(newParams, { replace: true });
  };

  // Deep-linking & page-refresh retention for Inquiry and Customer drawers
  useEffect(() => {
    const inquiryId = searchParams.get('inquiryId') || (activeTab === 'inquiries' ? searchParams.get('id') : null);
    if (inquiryId && (!selectedInquiryForDrawer || selectedInquiryForDrawer.id !== inquiryId)) {
      handleOpenInquiry(inquiryId);
    }
  }, [searchParams, activeTab, inquiries]);

  useEffect(() => {
    const customerId = searchParams.get('customerId') || (activeTab === 'customers' ? searchParams.get('id') : null);
    if (customerId && (!selectedCustomerForDrawer || selectedCustomerForDrawer.id !== customerId)) {
      handleOpenCustomer(customerId);
    }
  }, [searchParams, activeTab]);

  const handleCreateInquiryFromMessage = async (
    msg: {
      subject: string;
      body: string;
      fromEmail: string;
      fromName: string;
      id?: string;
    },
    parsed?: any,
  ) => {
    if (msg.id) {
      const { data: existing } = await supabase
        .from('crm_inquiries')
        .select('id, inquiry_number')
        .eq('source_email_id', msg.id)
        .limit(1)
        .maybeSingle();
      if (existing?.id) {
        handleOpenInquiry(existing.id);
        return;
      }
    }

    setEditingInquiry(null);
    const products = Array.isArray(parsed?.products) ? parsed.products : [];
    const firstProd = products[0] || {};
    const safeCompany =
      parsed?.companyName &&
      !['email sender', 'unknown', 'unknown company'].includes(String(parsed.companyName).trim().toLowerCase())
        ? parsed.companyName
        : (msg.fromName && msg.fromName !== 'Email Sender' && !msg.fromName.includes('@') ? msg.fromName : '');

    setPrefillInquiry({
      company_name: safeCompany,
      contact_person: parsed?.contactPerson || (msg.fromName && msg.fromName !== 'Email Sender' && !msg.fromName.includes('@') ? msg.fromName : ''),
      contact_email: parsed?.contactEmail || msg.fromEmail || '',
      contact_phone: parsed?.contactPhone || '',
      product_name: parsed?.productName || firstProd.productName || '',
      specification: parsed?.specification || firstProd.specification || '',
      quantity: parsed?.quantity || firstProd.quantity || '',
      supplier_name: parsed?.supplierName || firstProd.supplierName || firstProd.make || '',
      supplier_country: parsed?.supplierCountry || firstProd.supplierCountry || '',
      purchase_price: parsed?.purchasePrice || firstProd.purchasePrice || '',
      purchase_price_currency: parsed?.purchasePriceCurrency || firstProd.purchasePriceCurrency || 'USD',
      offered_price: parsed?.offeredPrice || firstProd.offeredPrice || '',
      offered_price_currency: parsed?.offeredPriceCurrency || firstProd.offeredPriceCurrency || 'USD',
      coa_required: Boolean(parsed?.coaRequested),
      msds_required: Boolean(parsed?.msdsRequested),
      sample_required: Boolean(parsed?.sampleRequested),
      price_required: parsed?.priceRequested ?? true,
      agency_letter_required: Boolean(parsed?.agencyLetterRequested),
      others_required: Boolean(parsed?.otherRequests),
      delivery_date: parsed?.deliveryDateExpected || firstProd.deliveryDate || '',
      delivery_terms: parsed?.deliveryTerms || firstProd.deliveryTerms || '',
      priority: parsed?.urgency || 'medium',
      pipeline_status: 'new',
      inquiry_source: 'email',
      mail_subject: msg.subject || '',
      email_body: msg.body || null,
      remarks: parsed?.remarks || '',
      source_email_id: msg.id || null,
      is_multi_product: products.length > 1,
      products: products.map((p: any) => ({
        productName: p.productName || '',
        specification: p.specification || '',
        quantity: p.quantity || '',
        supplierName: p.supplierName || p.make || '',
        supplierCountry: p.supplierCountry || '',
        deliveryDate: p.deliveryDate || '',
        deliveryTerms: p.deliveryTerms || '',
      })),
      extraction_meta: parsed
        ? {
            confidence: parsed.confidence || 'medium',
            missingFields: Array.isArray(parsed.missingFields) ? parsed.missingFields : [],
            uncertainFields: Array.isArray(parsed.uncertainFields) ? parsed.uncertainFields : [],
          }
        : null,
    });
    setModalOpen(true);
  };

  // Form submission and customer relationship handling
  const handleFormSubmit = async (formData: any) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('User not authenticated');

      if (!editingInquiry && !formData.crm_contact_id) {
        const { data: existingCustomers } = await supabase
          .from('crm_contacts')
          .select('id, company_name, contact_person, email, phone, city, address')
          .eq('is_active', true);

        if (existingCustomers && existingCustomers.length > 0) {
          const matchResult = findBestMatch(formData.company_name, existingCustomers);
          if (matchResult && matchResult.score >= 85) {
            setPendingFormData(formData);
            const counts: Record<string, number> = {};
            const { data: countData } = await supabase
              .from('crm_inquiries')
              .select('crm_contact_id')
              .in('crm_contact_id', [matchResult.customer.id]);

            if (countData) {
              countData.forEach((row) => {
                if (row.crm_contact_id) {
                  counts[row.crm_contact_id] = (counts[row.crm_contact_id] || 0) + 1;
                }
              });
            }

            setInquiryCounts(counts);
            setCustomerMatches([
              {
                ...matchResult.customer,
                similarity: matchResult.score / 100,
                matchType: matchResult.matchType,
              },
            ]);
            setShowCustomerSelectionDialog(true);
            return;
          }
        }
      }

      const sanitizeFormData = (data: any) => {
        const sanitized: any = {};
        const emptyToNull = (val: any) => (val === '' || val === undefined ? null : val);

        // Fields that should never be sent to the crm_inquiries table
        const excludedFields = new Set(['products', 'items']);

        // UUID, date, timestamp, and numeric fields that must be null if empty string
        const nullableFields = new Set([
          'crm_contact_id',
          'customer_id',
          'assigned_to',
          'created_by',
          'sales_member_id',
          'source_email_id',
          'converted_to_quotation',
          'converted_to_order',
          'delivery_date',
          'delivery_date_expected',
          'next_follow_up',
          'last_contact_date',
          'coa_sent_date',
          'msds_sent_date',
          'sample_sent_date',
          'price_quoted_date',
          'lost_at',
          'closed_at',
          'purchase_price',
          'offered_price',
          'purchase_price_currency',
          'offered_price_currency',
        ]);

        Object.keys(data).forEach((key) => {
          if (excludedFields.has(key)) {
            return;
          }
          if (nullableFields.has(key)) {
            sanitized[key] = emptyToNull(data[key]);
          } else {
            sanitized[key] = data[key];
          }
        });
        return sanitized;
      };

      if (editingInquiry) {
        const updatePayload = sanitizeFormData(formData);
        const { error } = await supabase
          .from('crm_inquiries')
          .update(updatePayload)
          .eq('id', editingInquiry.id);

        if (error) throw error;
      } else {
        const { items, products, is_multi_product, ...restFormData } = formData;
        const multiProducts = (items && items.length > 0) ? items : (products && products.length > 0 ? products : []);

        let createdInquiryId: string | null = null;

        if (is_multi_product && multiProducts.length > 0) {
          const inquiriesToInsert = multiProducts.map((item: any) =>
            sanitizeFormData({
              ...restFormData,
              product_name: item.product_name || item.productName,
              specification: item.specification || null,
              quantity: item.quantity,
              supplier_name: item.supplier_name || item.supplierName || restFormData.supplier_name || null,
              supplier_country: item.supplier_country || item.supplierCountry || restFormData.supplier_country || null,
              delivery_date: item.delivery_date || item.deliveryDate || restFormData.delivery_date || null,
              delivery_terms: item.delivery_terms || item.deliveryTerms || restFormData.delivery_terms || null,
              inquiry_date: new Date().toISOString().split('T')[0],
              assigned_to: user.id,
              created_by: user.id,
              purchase_price: item.purchase_price && !isNaN(parseFloat(item.purchase_price)) ? parseFloat(item.purchase_price) : null,
              offered_price: item.offered_price && !isNaN(parseFloat(item.offered_price)) ? parseFloat(item.offered_price) : null,
              is_multi_product: true,
              has_items: true,
            })
          );

          const { data: insertedInquiries, error } = await supabase
            .from('crm_inquiries')
            .insert(inquiriesToInsert)
            .select();

          if (error) throw error;

          if (insertedInquiries && insertedInquiries.length > 0) {
            createdInquiryId = insertedInquiries[0].id;
            const baseInquiryNumber = insertedInquiries[0].inquiry_number;
            for (let i = 0; i < insertedInquiries.length; i++) {
              await supabase
                .from('crm_inquiries')
                .update({ inquiry_number: `${baseInquiryNumber}.${i + 1}` })
                .eq('id', insertedInquiries[i].id);
            }
          }
        } else {
          const insertData: any = sanitizeFormData({
            ...restFormData,
            specification: formData.specification || null,
            inquiry_date: new Date().toISOString().split('T')[0],
            assigned_to: user.id,
            created_by: user.id,
            purchase_price: formData.purchase_price && !isNaN(parseFloat(formData.purchase_price)) ? parseFloat(formData.purchase_price) : null,
            offered_price: formData.offered_price && !isNaN(parseFloat(formData.offered_price)) ? parseFloat(formData.offered_price) : null,
            is_multi_product: false,
            has_items: false,
          });

          const { data: insertedRows, error, status } = await supabase
            .from('crm_inquiries')
            .insert([insertData])
            .select('id, inquiry_number');

          if (error) {
            console.error('[CRM_INQUIRY_INSERT_ERROR]', {
              message: error.message,
              code: error.code,
              details: error.details,
              hint: error.hint,
              status,
              payloadKeys: Object.keys(insertData),
            });
            throw error;
          }

          createdInquiryId = insertedRows?.[0]?.id || null;
        }

        const sourceEmailId = formData.source_email_id || prefillInquiry?.source_email_id;
        if (sourceEmailId && createdInquiryId) {
          try {
            await supabase
              .from('crm_email_inbox')
              .update({
                converted_to_inquiry: createdInquiryId,
                is_processed: true,
                is_inquiry: true,
              })
              .eq('id', sourceEmailId);
          } catch (e) {
            console.warn('Failed linking source email to new inquiry:', e);
          }
        }
      }

      registerRecentInquiryValues({
        product_name: formData.product_name,
        specification: formData.specification,
        supplier_country: formData.supplier_country,
      });

      setModalOpen(false);
      setEditingInquiry(null);
      setPrefillInquiry(null);
      loadInquiries();
    } catch (error: any) {
      console.error('Error saving inquiry:', {
        message: error?.message,
        code: error?.code,
        details: error?.details,
        hint: error?.hint,
      });
      alert(t('errors.failedToSaveInquiry'));
    }
  };

  const handleCustomerSelect = (customer: any) => {
    if (pendingFormData) {
      pendingFormData.crm_contact_id = customer.id;
      setShowCustomerSelectionDialog(false);
      handleFormSubmit(pendingFormData);
    }
  };

  const handleCreateNewCustomer = async (customerData: any) => {
    try {
      const { contact } = await findOrCreateCrmContact({
        company_name: customerData.company_name,
        contact_person: customerData.contact_person,
        email: customerData.email,
        phone: customerData.phone,
        country: customerData.country,
        address: customerData.address,
        city: customerData.city,
      });

      if (pendingFormData) {
        pendingFormData.crm_contact_id = contact.id;
        setShowCustomerConfirmationDialog(false);
        handleFormSubmit(pendingFormData);
      }
    } catch (error: any) {
      console.error('Error creating CRM contact:', error);
      throw error;
    }
  };

  const handleUpdateCustomer = async () => {
    if (!customerChanges || !customerChanges.customer) return;
    try {
      const updateData: any = {};
      customerChanges.changedFields.forEach((field: string) => {
        updateData[field] = customerChanges.newValues[field];
      });

      if (updateData.company_name) {
        await ensureUniqueCrmContactName(updateData.company_name, customerChanges.customer.id);
      }

      updateData.updated_at = new Date().toISOString();
      updateData.updated_by = profile?.id || null;

      const { error } = await supabase
        .from('crm_contacts')
        .update(updateData)
        .eq('id', customerChanges.customer.id);

      if (error) throw error;

      setShowCustomerUpdateDialog(false);
      if (pendingFormData) {
        handleFormSubmit(pendingFormData);
      }
    } catch (error: any) {
      console.error('Error updating CRM contact:', error);
      alert(
        isDuplicateCrmContactError(error)
          ? 'A CRM customer with this name already exists.'
          : error?.message || t('errors.failedToUpdateCustomer')
      );
    }
  };

  const canManage = profile?.role === 'admin' || profile?.role === 'sales';

  return (
    <Layout>
      <div className="space-y-2.5">
        {/* Top Consolidated CRM Bar: 7 Primary Destinations + Quick Actions */}
        <div className="bg-white rounded-xl border border-slate-200/90 shadow-2xs px-2.5 sm:px-3 py-2 flex flex-wrap items-center justify-between gap-2 sm:gap-3 min-w-0">
          
          {/* PRIMARY CRM DESTINATIONS (CONSOLIDATED INTO EXACTLY 7) */}
          <div className="flex items-center gap-1 bg-slate-100/80 p-0.5 rounded-lg border border-slate-200/60 overflow-x-auto min-w-0 max-w-full">
            {(
              [
                ['dashboard', LayoutDashboard, 'DASHBOARD'],
                ['inbox', Inbox, 'INBOX'],
                ['followups', CheckSquare, 'FOLLOW-UPS'],
                ['inquiries', Table, 'INQUIRIES'],
                ['campaigns', Send, 'CAMPAIGNS'],
                ['customers', Users, 'CUSTOMERS'],
                ['documents', FileText, 'DOCUMENT BANK'],
              ] as const
            ).map(([tabKey, Icon, label]) => {
              const isActive = activeTab === tabKey;
              return (
                <button
                  key={tabKey}
                  onClick={() => handleTabChange(tabKey as CrmPrimaryTab)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition whitespace-nowrap ${
                    isActive
                      ? 'bg-white text-slate-900 shadow-2xs font-bold border border-slate-200/70'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
                  }`}
                >
                  <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-blue-600' : 'text-slate-500'}`} />
                  {label}
                </button>
              );
            })}
          </div>

          {/* Quick Header Utilities */}
          <div className="flex items-center gap-2">
            {/* Global Search Trigger (Cmd+K) */}
            <button
              onClick={() => setIsSearchOpen(true)}
              className="inline-flex items-center gap-2 px-2.5 py-1 bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200 rounded-md text-xs transition"
              title="Global CRM Search (Cmd+K)"
            >
              <Search className="w-3.5 h-3.5 text-slate-400" />
              <span className="hidden md:inline font-medium">Search CRM...</span>
              <kbd className="hidden sm:inline-block px-1.5 py-0.2 text-[10px] font-semibold text-slate-500 bg-white rounded border border-slate-200">
                ⌘K
              </kbd>
            </button>

            {/* Integration Health & Settings */}
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md border border-slate-200 transition"
              title="Integration Health & Settings (Gmail / WhatsApp)"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>

            {/* New Inquiry Action */}
            <button
              onClick={() => {
                setEditingInquiry(null);
                setPrefillInquiry(null);
                setModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 shadow-2xs transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Inquiry</span>
            </button>
          </div>
        </div>

        {/* Error Notification */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center justify-between text-xs text-red-700">
            <span>{error}</span>
            <button
              onClick={() => loadInquiries()}
              className="px-2.5 py-1 bg-red-600 text-white rounded hover:bg-red-700 transition"
            >
              {t('crm.retry')}
            </button>
          </div>
        )}

        {/* 1. DASHBOARD DESTINATION */}
        {activeTab === 'dashboard' && (
          <CrmActivityDashboard
            onOpenInquiry={handleOpenInquiry}
            onOpenCustomer={handleOpenCustomer}
            onNavigateTab={(tab, params) => {
              if (params?.view) {
                const newParams = new URLSearchParams(searchParams);
                newParams.set('view', params.view);
                navigate(`/crm/${tab}?${newParams.toString()}`);
                setActiveTab(tab as any);
                return;
              }
              if (tab === 'followups') handleTabChange('followups');
              else if (tab === 'inbox') handleTabChange('inbox');
              else if (tab === 'inquiries') handleTabChange('inquiries');
              else if (tab === 'customers') handleTabChange('customers');
            }}
          />
        )}

        {/* 2. INBOX DESTINATION */}
        {activeTab === 'inbox' && (
          <CrmOmnichannelInbox
            onOpenInquiry={handleOpenInquiry}
            onOpenCustomer={handleOpenCustomer}
            onCreateInquiryFromMessage={handleCreateInquiryFromMessage}
          />
        )}

        {/* 3. FOLLOW-UPS DESTINATION */}
        {activeTab === 'followups' && (
          <CrmFollowupsWorkspace
            initialTab={
              location.pathname.includes('meetings') || searchParams.get('view') === 'meetings'
                ? 'meetings'
                : 'todo'
            }
            onOpenInquiry={handleOpenInquiry}
            onOpenCustomer={handleOpenCustomer}
            onNavigateTab={(tab) => {
              if (tab === 'inbox') handleTabChange('inbox');
              else if (tab === 'inquiries') handleTabChange('inquiries');
              else if (tab === 'customers') handleTabChange('customers');
            }}
          />
        )}

        {/* 4. INQUIRIES DESTINATION (OPERATIONAL CENTER) */}
        {activeTab === 'inquiries' && (
          <CrmInquiriesWorkspace
            canManage={canManage}
            onAddInquiry={() => {
              setEditingInquiry(null);
              setPrefillInquiry(null);
              setModalOpen(true);
            }}
            onOpenCustomer={handleOpenCustomer}
            initialInquiryId={targetInquiryId}
          />
        )}

        {/* 5. CAMPAIGNS & BULK OUTREACH DESTINATION */}
        {activeTab === 'campaigns' && (
          <CrmCampaignsWorkspace initialRecipients={stagedBulkRecipients} />
        )}

        {/* 6. CUSTOMERS DESTINATION (CUSTOMER 360) */}
        {activeTab === 'customers' && (
          <CrmCustomersWorkspace
            onOpenInquiry={handleOpenInquiry}
            onNavigateBulkEmail={(recipients) => {
              setStagedBulkRecipients(recipients);
              handleTabChange('campaigns');
            }}
          />
        )}

        {/* 7. DOCUMENT BANK DESTINATION (STANDALONE PRIMARY DESTINATION) */}
        {activeTab === 'documents' && (
          <ProductDocumentsPanel />
        )}

        {/* Re-homed legacy Control Center fallback & regression contract:
            ['control-center', Sparkles, 'CONTROL CENTER']
            activeTab === 'control-center' && (
              <EnquiryControlCenter canManage={canManage} />
            )
        */}

        {/* Contextual Inquiry Drawer (Overlay) */}
        <CrmInquiryDrawer
          isOpen={isInquiryDrawerOpen}
          onClose={handleCloseInquiryDrawer}
          inquiry={selectedInquiryForDrawer}
          onRefresh={loadInquiries}
          onOpenCustomer={(cid: string) => {
            handleCloseInquiryDrawer();
            handleOpenCustomer(cid);
          }}
        />

        {/* Contextual Customer Drawer (Overlay) */}
        <CrmCustomerDrawer
          isOpen={!!selectedCustomerForDrawer}
          onClose={handleCloseCustomerDrawer}
          customer={selectedCustomerForDrawer}
          onOpenInquiry={(inqId) => {
            handleCloseCustomerDrawer();
            handleOpenInquiry(inqId);
          }}
          onRefresh={loadInquiries}
        />

        {/* Global CRM Search Modal (Cmd+K) */}
        <CrmGlobalSearchModal
          isOpen={isSearchOpen}
          onClose={() => setIsSearchOpen(false)}
          onSelectInquiry={handleOpenInquiry}
          onSelectCustomer={handleOpenCustomer}
          onSelectCommunication={(comm) => {
            if (comm.inquiryId) handleOpenInquiry(comm.inquiryId);
            else if (comm.customerId) handleOpenCustomer(comm.customerId);
            else handleTabChange('inbox');
          }}
        />

        {/* Settings & Integration Health Modal */}
        <CrmSettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          canManage={canManage}
        />

        {/* Create / Edit Inquiry Modal */}
        <Modal
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            setEditingInquiry(null);
            setPrefillInquiry(null);
          }}
          title={editingInquiry ? t('crm.editInquiry') : t('crm.addNewInquiry')}
        >
          <CompactInquiryForm
            onSubmit={handleFormSubmit}
            onCancel={() => {
              setModalOpen(false);
              setEditingInquiry(null);
              setPrefillInquiry(null);
            }}
            initialData={editingInquiry || prefillInquiry}
            isEditing={!!editingInquiry}
          />
        </Modal>

        {/* Customer Deduplication & Matching Dialogs */}
        <CustomerSelectionDialog
          isOpen={showCustomerSelectionDialog}
          matches={customerMatches}
          searchTerm={pendingFormData?.company_name || ''}
          onSelect={handleCustomerSelect}
          onCreateNew={() => {
            if (pendingFormData) {
              pendingFormData.crm_contact_id = null;
              setShowCustomerSelectionDialog(false);
              handleFormSubmit(pendingFormData);
            }
          }}
          onCancel={() => {
            setShowCustomerSelectionDialog(false);
            setPendingFormData(null);
          }}
          inquiryCounts={inquiryCounts}
        />

        <CustomerConfirmationDialog
          isOpen={showCustomerConfirmationDialog}
          initialData={{
            company_name: pendingFormData?.company_name || '',
            contact_person: pendingFormData?.contact_person || '',
            email: pendingFormData?.contact_email || '',
            phone: pendingFormData?.contact_phone || '',
            country: pendingFormData?.supplier_country || 'Indonesia',
          }}
          onConfirm={handleCreateNewCustomer}
          onCancel={() => {
            if (pendingFormData) {
              pendingFormData.crm_contact_id = null;
              setShowCustomerConfirmationDialog(false);
              handleFormSubmit(pendingFormData);
            } else {
              setShowCustomerConfirmationDialog(false);
            }
          }}
        />

        <CustomerUpdateDialog
          isOpen={showCustomerUpdateDialog}
          customerName={customerChanges?.customer?.company_name || ''}
          changedFields={customerChanges?.changedFields || []}
          oldValues={customerChanges?.oldValues || {}}
          newValues={customerChanges?.newValues || {}}
          onUpdateCustomer={handleUpdateCustomer}
          onKeepExisting={() => {
            setShowCustomerUpdateDialog(false);
            if (pendingFormData) handleFormSubmit(pendingFormData);
          }}
          onCancel={() => {
            setShowCustomerUpdateDialog(false);
            setPendingFormData(null);
          }}
        />
      </div>
    </Layout>
  );
}
