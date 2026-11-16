import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../contexts/AuthContext';
import { showToast } from '../../ToastNotification';
import { CrmCustomerDrawer, CustomerDetail } from './CrmCustomerDrawer';
import { CustomerDatabaseExcel } from '../CustomerDatabaseExcel';
import { Customer360Panel } from '../Customer360Panel';
import { FloatingField, FLOAT_INPUT } from '../../finance/FloatingField';
import { SapRow } from '../../finance/SapLayout';
import { classifyCanonicalPhone, ISO_COUNTRY_NAMES } from '../../../services/crm/canonicalPhoneService';
import { ensureUniqueCrmContactName } from '../../../utils/customerValidation';
import {
  Users,
  Search,
  Plus,
  RefreshCw,
  Mail,
  Phone,
  Building,
  ExternalLink,
  Filter,
  CheckCircle2,
  Clock,
  ArrowUpDown,
  Send,
  MoreHorizontal,
  FolderOpen,
  Table,
  LayoutGrid,
  AlertTriangle,
} from 'lucide-react';

import {
  cleanContactPerson,
  auditCompanyPrimaryPhones,
  deduplicateCampaignEmailRecipients,
} from '../../../utils/crmContactCleaners';

interface CustomerRow extends CustomerDetail {
  openInquiriesCount: number;
  openOrdersCount: number;
  lastActivityDate: string | null;
  lastActivityLabel: string;
  assignedSalespersonName?: string;
  assignedSalesMemberId?: string;
  hasMultiplePrimary?: boolean;
  phonesCount?: number;
}

interface Props {
  onOpenInquiry?: (inquiryId: string) => void;
  onNavigateBulkEmail?: (recipients: Array<{ id: string; company_name: string; email: string; contact_person: string | null }>) => void;
}

export function CrmCustomersWorkspace({
  onOpenInquiry,
  onNavigateBulkEmail,
}: Props) {
  const { profile } = useAuth();
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'active' | 'inquiries' | 'orders' | 'dormant'>('active');
  const [classificationFilter, setClassificationFilter] = useState<string>('all');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedCustomerForDrawer, setSelectedCustomerForDrawer] = useState<CustomerDetail | null>(null);
  const [viewMode, setViewMode] = useState<'directory' | 'excel' | '360'>('excel');
  const [excelRefreshKey, setExcelRefreshKey] = useState(0);

  // Checkbox selections for bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Sales team & assignment states
  const [salesMembers, setSalesMembers] = useState<any[]>([]);
  const [salespersonFilter, setSalespersonFilter] = useState<string>('all');
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [targetSalesMemberId, setTargetSalesMemberId] = useState<string>('');
  const [assignNotes, setAssignNotes] = useState('');
  const [assigning, setAssigning] = useState(false);

  // New Customer Modal
  const [showNewModal, setShowNewModal] = useState(false);
  const [newCompany, setNewCompany] = useState('');
  const [newContact, setNewContact] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newCountry, setNewCountry] = useState('ID');
  const [newCity, setNewCity] = useState('');
  const [newType, setNewType] = useState('Pharma Manufacturer');
  const [savingNew, setSavingNew] = useState(false);

  useEffect(() => {
    loadCustomers();
  }, []);

  const loadCustomers = async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Fetch CRM contacts and phone records
      const [{ data: contactRows, error: contactErr }, { data: phoneRows }] = await Promise.all([
        supabase
          .from('crm_contacts')
          .select('*')
          .order('company_name'),
        supabase
          .from('crm_contact_phones')
          .select('id, contact_id, raw_phone, normalized_phone, is_primary, is_whatsapp_eligible, phone_type'),
      ]);

      if (contactErr) throw contactErr;
      const contacts = contactRows || [];

      // Group phones by contact_id to detect multi-primary records safely
      const phonesByContact = new Map<string, any[]>();
      (phoneRows || []).forEach((p: any) => {
        if (p.contact_id) {
          const list = phonesByContact.get(p.contact_id) || [];
          list.push(p);
          phonesByContact.set(p.contact_id, list);
        }
      });

      // 2. Fetch all ERP customers to match and check open orders
      const { data: erpCustomers } = await supabase
        .from('customers')
        .select('id, company_name, is_active')
        .eq('is_active', true);

      const erpCustMap = new Map((erpCustomers || []).map((c: any) => [c.company_name.toLowerCase().trim(), c.id]));

      // 3. Fetch active inquiries summary
      const { data: inqSummary } = await supabase
        .from('crm_inquiries')
        .select('id, company_name, crm_contact_id, customer_id, created_at, status, pipeline_status')
        .order('created_at', { ascending: false });

      // Group inquiries by contact_id and normalized company_name
      const inquiriesByContact = new Map<string, any[]>();
      const inquiriesByName = new Map<string, any[]>();

      (inqSummary || []).forEach((inq: any) => {
        if (inq.crm_contact_id) {
          const list = inquiriesByContact.get(inq.crm_contact_id) || [];
          list.push(inq);
          inquiriesByContact.set(inq.crm_contact_id, list);
        }
        const normName = (inq.company_name || '').toLowerCase().trim();
        if (normName) {
          const list = inquiriesByName.get(normName) || [];
          list.push(inq);
          inquiriesByName.set(normName, list);
        }
      });

      // 4. Fetch open sales orders
      const { data: openOrders } = await supabase
        .from('sales_orders')
        .select('id, customer_id, status, so_date')
        .not('status', 'in', '(closed,cancelled,rejected)');

      const openOrdersByCust = new Map<string, number>();
      (openOrders || []).forEach((so: any) => {
        openOrdersByCust.set(so.customer_id, (openOrdersByCust.get(so.customer_id) || 0) + 1);
      });

      // 5. Fetch sales team members and customer assignments
      const { data: teamMembers } = await supabase
        .from('sales_team_members')
        .select('id, name, email')
        .eq('is_active', true)
        .order('name');
      setSalesMembers(teamMembers || []);

      const { data: assignments } = await supabase
        .from('customer_assignments')
        .select(`
          crm_contact_id,
          customer_id,
          sales_member_id,
          sales_team_members:sales_member_id (
            id,
            name
          )
        `)
        .eq('is_active', true);

      const assignmentMap = new Map<string, { id: string; name: string }>();
      (assignments || []).forEach((a: any) => {
        const memberName = a.sales_team_members?.name || 'Assigned';
        if (a.crm_contact_id) {
          assignmentMap.set(a.crm_contact_id, { id: a.sales_member_id, name: memberName });
        }
        if (a.customer_id) {
          assignmentMap.set(a.customer_id, { id: a.sales_member_id, name: memberName });
        }
      });

      // Assemble CustomerRow
      const assembled: CustomerRow[] = contacts.map((c: any) => {
        const normName = (c.company_name || '').toLowerCase().trim();
        const contactInquiries = inquiriesByContact.get(c.id) || inquiriesByName.get(normName) || [];
        
        const openInquiries = contactInquiries.filter(
          (i: any) => !['won', 'lost', 'closed', 'rejected', 'archived'].includes((i.pipeline_status || i.status || '').toLowerCase())
        );

        const erpId = erpCustMap.get(normName) || null;
        const openOrdersCount = erpId ? (openOrdersByCust.get(erpId) || 0) : 0;

        const latestInqDate = contactInquiries[0]?.created_at || null;
        const lastActivityDate = latestInqDate || c.created_at;

        let lastActivityLabel = 'No recent activity';
        if (lastActivityDate) {
          const days = Math.max(0, Math.floor((Date.now() - new Date(lastActivityDate).getTime()) / 86400000));
          lastActivityLabel = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days}d ago`;
        }

        const assignment = assignmentMap.get(c.id) || (erpId ? assignmentMap.get(erpId) : undefined);
        const contactPhones = phonesByContact.get(c.id) || [];
        const phoneAudit = auditCompanyPrimaryPhones(contactPhones);

        return {
          id: c.id,
          company_name: c.company_name,
          contact_person: cleanContactPerson(c.contact_person, c.company_name),
          designation: c.designation,
          email: c.email,
          phone: c.phone,
          mobile: c.mobile,
          landline: c.landline,
          address: c.address,
          city: c.city,
          country: c.country,
          website: c.website,
          company_type: c.company_type,
          customer_type: c.customer_type,
          notes: c.notes,
          is_active: c.is_active,
          erp_customer_id: erpId,
          openInquiriesCount: openInquiries.length,
          openOrdersCount,
          lastActivityDate,
          lastActivityLabel,
          assignedSalespersonName: assignment?.name || undefined,
          assignedSalesMemberId: assignment?.id || undefined,
          hasMultiplePrimary: phoneAudit.hasMultiplePrimary,
          phonesCount: contactPhones.length,
        };
      });

      setCustomers(assembled);
    } catch (err: any) {
      console.error('Failed to load customers:', err);
      setError(err.message || 'Error loading customers.');
      showToast({ type: 'error', title: 'Customer Database', message: err.message || 'Error loading customers.' });
    } finally {
      setLoading(false);
    }
  };

  const handleAssignSalesperson = async () => {
    if (!targetSalesMemberId || selectedIds.size === 0) {
      showToast({ type: 'error', title: 'Selection Required', message: 'Please select a salesperson.' });
      return;
    }

    setAssigning(true);
    try {
      const targetMember = salesMembers.find(m => m.id === targetSalesMemberId);
      const memberName = targetMember?.name || 'Sales Representative';

      for (const contactId of selectedIds) {
        // Upsert into customer_assignments on (crm_contact_id, sales_member_id)
        await supabase
          .from('customer_assignments')
          .upsert({
            crm_contact_id: contactId,
            sales_member_id: targetSalesMemberId,
            notes: assignNotes.trim() || 'Team Sales Workload Allocation',
            is_active: true,
            assigned_at: new Date().toISOString(),
          }, { onConflict: 'crm_contact_id, sales_member_id' });
      }

      showToast({
        type: 'success',
        title: 'Team Assignment Complete',
        message: `Successfully assigned ${selectedIds.size} companies to ${memberName}.`,
      });

      setShowAssignModal(false);
      setSelectedIds(new Set());
      setAssignNotes('');
      loadCustomers();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Assignment Failed', message: err.message });
    } finally {
      setAssigning(false);
    }
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCompany.trim()) {
      showToast({ type: 'error', title: 'Required Field', message: 'Company name is required.' });
      return;
    }
    setSavingNew(true);
    try {
      // 1. Phone number normalisation & classification
      const rawPhone = newPhone.trim();
      let normalizedPhone: string | null = null;
      let phoneCallingCode = '+62';
      let phoneCountryName = 'Indonesia';
      let phoneType = 'unknown';
      let isWhatsAppEligible = false;

      if (rawPhone) {
        const classified = classifyCanonicalPhone(rawPhone, {
          trustedRegion: newCountry === 'OTHER' ? undefined : newCountry,
          companyCity: newCity.trim() || null,
        });
        normalizedPhone = classified.e164;
        phoneCallingCode = classified.callingCode || '+62';
        phoneCountryName = classified.phoneCountryName || 'Indonesia';
        phoneType = classified.phoneType === 'mobile' ? 'valid_mobile' : classified.phoneType === 'fixed_line' ? 'landline' : 'unknown';
        isWhatsAppEligible = classified.isWhatsAppEligibleCandidate;
      }

      const countryName = ISO_COUNTRY_NAMES[newCountry]?.name || (newCountry === 'OTHER' ? 'International' : 'Indonesia');
      const phoneToSave = normalizedPhone || rawPhone || null;

      // Duplicate check (checks active and archived records)
      await ensureUniqueCrmContactName(newCompany.trim());

      // 2. Insert into crm_contacts with audit trail fields
      const now = new Date().toISOString();
      const actorId = profile?.id || null;
      const { data, error } = await supabase.from('crm_contacts').insert({
        company_name: newCompany.trim(),
        contact_person: newContact.trim() || null,
        email: newEmail.trim() || null,
        phone: phoneToSave,
        mobile: phoneType === 'valid_mobile' ? phoneToSave : null,
        city: newCity.trim() || null,
        country: countryName,
        company_type: newType,
        customer_type: 'prospect',
        is_active: true,
        created_at: now,
        created_by: actorId,
        updated_at: now,
        updated_by: actorId,
      }).select().single();

      if (error) throw error;

      // 3. Insert into crm_contact_phones to sync with WhatsApp bulk sender & CRM phones
      if (data && rawPhone) {
        const { error: phoneErr } = await supabase.from('crm_contact_phones').insert({
          contact_id: data.id,
          company_name: data.company_name,
          contact_person: newContact.trim() || null,
          department: 'Purchasing',
          raw_phone: rawPhone,
          normalized_phone: normalizedPhone || rawPhone,
          country_code: phoneCallingCode,
          country_name: phoneCountryName,
          phone_type: phoneType,
          is_whatsapp_eligible: isWhatsAppEligible,
          is_primary: true,
          consent_status: 'pending',
        });

        if (phoneErr && !phoneErr.message.includes('duplicate')) {
          console.warn('Could not insert crm_contact_phones record:', phoneErr);
        }
      }

      showToast({ type: 'success', title: 'Customer Created', message: `${newCompany} added to customer database.` });
      setShowNewModal(false);
      setNewCompany('');
      setNewContact('');
      setNewEmail('');
      setNewPhone('');
      setNewCountry('ID');
      setNewCity('');
      setNewType('Pharma Manufacturer');
      loadCustomers();
      setExcelRefreshKey(k => k + 1);

      if (data) {
        setSelectedCustomerForDrawer(data as CustomerDetail);
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Creation Failed', message: err.message });
    } finally {
      setSavingNew(false);
    }
  };

  const filteredCustomers = useMemo(() => {
    let list = customers;

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        c =>
          c.company_name.toLowerCase().includes(q) ||
          (c.contact_person && c.contact_person.toLowerCase().includes(q)) ||
          (c.email && c.email.toLowerCase().includes(q)) ||
          (c.phone && c.phone.includes(q)) ||
          (c.city && c.city.toLowerCase().includes(q))
      );
    }

    // Filter type
    if (filterType === 'active') {
      list = list.filter(c => c.is_active !== false);
    } else if (filterType === 'inquiries') {
      list = list.filter(c => c.openInquiriesCount > 0);
    } else if (filterType === 'orders') {
      list = list.filter(c => c.openOrdersCount > 0);
    } else if (filterType === 'dormant') {
      list = list.filter(c => c.openInquiriesCount === 0 && c.openOrdersCount === 0);
    }

    // Classification filter (Target Customer 400 Programme)
    if (classificationFilter !== 'all') {
      list = list.filter((c) => {
        const type = (c.customer_type || (c as any).company_type || (c as any).industry || '').toLowerCase();
        if (classificationFilter === 'pharma_mfr') {
          return type.includes('pharma') || type.includes('manufacturer') || type.includes('mfr') || type.includes('pabrik');
        } else if (classificationFilter === 'api_mfr') {
          return type.includes('api') || type.includes('active pharmaceutical');
        } else if (classificationFilter === 'distributor') {
          return type.includes('distributor') || type.includes('trader') || type.includes('wholesaler') || type.includes('pbf');
        } else if (classificationFilter === 'food_nutra') {
          return type.includes('food') || type.includes('nutra') || type.includes('makanan');
        }
        return true;
      });
    }

    // Salesperson filter
    if (salespersonFilter !== 'all') {
      if (salespersonFilter === 'unassigned') {
        list = list.filter(c => !c.assignedSalesMemberId);
      } else {
        list = list.filter(c => c.assignedSalesMemberId === salespersonFilter);
      }
    }

    return list;
  }, [customers, searchQuery, filterType, classificationFilter, salespersonFilter]);

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(filteredCustomers.map(c => c.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleToggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleStartBulkEmail = () => {
    const activeSelected = customers
      .filter(c => selectedIds.has(c.id) && c.email && c.is_active !== false)
      .map(c => ({
        id: c.id,
        company_name: c.company_name,
        email: c.email!,
        contact_person: cleanContactPerson(c.contact_person, c.company_name) || null,
      }));

    if (activeSelected.length === 0) {
      showToast({ type: 'warning', title: 'No Valid Emails', message: 'None of the selected active customers have a valid email address.' });
      return;
    }

    const { unique, duplicateCount } = deduplicateCampaignEmailRecipients(activeSelected);
    if (duplicateCount > 0) {
      showToast({
        type: 'info',
        title: 'Duplicate Emails Excluded',
        message: `Excluded ${duplicateCount} duplicate email address(es) from bulk campaign staging.`,
      });
    }

    onNavigateBulkEmail?.(unique);
  };

  return (
    <div className="space-y-2.5">
      {/* Top Workspace Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 bg-white p-2.5 rounded-xl border border-slate-200/90 shadow-2xs">
        <div className="flex items-center gap-2 flex-1 max-w-xl">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search customers by company, contact person, email, phone or city..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 focus:bg-white transition"
            />
          </div>

          <button
            onClick={() => {
              loadCustomers();
              setExcelRefreshKey(k => k + 1);
            }}
            disabled={loading}
            className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg border border-slate-200 transition"
            title="Refresh Customers"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {/* Prospect Classification Filter */}
          <select
            value={classificationFilter}
            onChange={(e) => setClassificationFilter(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-slate-50 font-medium text-slate-700 hover:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            title="Filter by Industry / Customer Classification"
          >
            <option value="all">All Classifications</option>
            <option value="pharma_mfr">Pharma Manufacturer</option>
            <option value="api_mfr">API Manufacturer</option>
            <option value="distributor">Distributor / PBF</option>
            <option value="food_nutra">Food & Nutraceuticals</option>
          </select>

          {/* Assigned Salesperson Filter */}
          <select
            value={salespersonFilter}
            onChange={(e) => setSalespersonFilter(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-slate-50 font-medium text-slate-700 hover:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            title="Filter companies by assigned salesperson"
          >
            <option value="all">All Sales Reps</option>
            <option value="unassigned">Unassigned</option>
            {salesMembers.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* View Toggle */}
          <div className="flex items-center bg-slate-100/80 p-0.5 rounded-lg border border-slate-200/60">
            <button
              type="button"
              onClick={() => setViewMode('directory')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md transition ${
                viewMode === 'directory'
                  ? 'bg-white text-slate-900 shadow-2xs font-bold border border-slate-200/70'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
              title="Directory View"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>Directory</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('excel')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md transition ${
                viewMode === 'excel'
                  ? 'bg-white text-blue-700 shadow-2xs font-bold border border-slate-200/70'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
              title="Excel Spreadsheet View"
            >
              <Table className="w-3.5 h-3.5" />
              <span>Excel Spreadsheet</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('360')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md transition ${
                viewMode === '360'
                  ? 'bg-white text-blue-700 shadow-2xs font-bold border border-slate-200/70'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
              title="Customer 360 & Timeline View"
            >
              <Users className="w-3.5 h-3.5 text-blue-600" />
              <span>Customer 360</span>
            </button>
          </div>

          {viewMode === 'directory' && selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setTargetSalesMemberId(salesMembers[0]?.id || '');
                  setShowAssignModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-50 text-purple-700 border border-purple-200 rounded-lg text-xs font-semibold hover:bg-purple-100 transition shadow-2xs"
              >
                <Users className="w-3.5 h-3.5" />
                Assign Salesperson ({selectedIds.size})
              </button>
              <button
                onClick={handleStartBulkEmail}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg text-xs font-semibold hover:bg-indigo-100 transition"
              >
                <Send className="w-3.5 h-3.5" />
                Send Bulk Email ({selectedIds.size})
              </button>
            </div>
          )}

          <button
            onClick={() => setShowNewModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 shadow-2xs transition"
          >
            <Plus className="w-3.5 h-3.5" />
            New Customer
          </button>
        </div>
      </div>

      {/* Directory View */}
      <div className={viewMode === 'directory' ? 'space-y-4' : 'hidden'}>
          {/* Quick Filters */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
            {(
              [
                ['all', `All Customers (${customers.length})`],
                ['active', `Active (${customers.filter(c => c.is_active !== false).length})`],
                ['inquiries', `With Open Inquiries (${customers.filter(c => c.openInquiriesCount > 0).length})`],
                ['orders', `With Open Orders (${customers.filter(c => c.openOrdersCount > 0).length})`],
                ['dormant', `Dormant / No Open Action (${customers.filter(c => c.openInquiriesCount === 0 && c.openOrdersCount === 0).length})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilterType(key)}
                className={`px-3 py-1.5 rounded-full font-medium transition whitespace-nowrap ${
                  filterType === key
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Master Customer Table */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-gray-200 text-gray-500 font-semibold uppercase tracking-wider">
                <th className="py-2.5 px-3 w-8 text-center">
                  <input
                    type="checkbox"
                    checked={filteredCustomers.length > 0 && selectedIds.size === filteredCustomers.length}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-0"
                  />
                </th>
                <th className="py-2.5 px-3">Company</th>
                <th className="py-2.5 px-3">Contact</th>
                <th className="py-2.5 px-3">Email</th>
                <th className="py-2.5 px-3">Phone</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3">Last Activity</th>
                <th className="py-2.5 px-3 text-center">Open Inq</th>
                <th className="py-2.5 px-3 text-center">Open Orders</th>
                <th className="py-2.5 px-3">Sales Rep</th>
                <th className="py-2.5 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-gray-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-600" />
                    Loading customer directory...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center bg-red-50/40">
                    <AlertTriangle className="w-6 h-6 text-red-500 mx-auto mb-2" />
                    <p className="text-sm font-semibold text-red-800 mb-1">Failed to load customer directory</p>
                    <p className="text-xs text-red-600 mb-3">{error}</p>
                    <button
                      onClick={loadCustomers}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded text-xs font-semibold hover:bg-red-700 transition"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> Retry
                    </button>
                  </td>
                </tr>
              ) : filteredCustomers.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-gray-400">
                    No customers found matching current filters.
                  </td>
                </tr>
              ) : (
                filteredCustomers.map((cust) => {
                  const isSelected = selectedIds.has(cust.id);
                  return (
                    <tr
                      key={cust.id}
                      onClick={() => setSelectedCustomerForDrawer(cust)}
                      className={`hover:bg-blue-50/50 cursor-pointer transition ${
                        isSelected ? 'bg-blue-50/30' : ''
                      }`}
                    >
                      <td className="py-2.5 px-3 text-center" onClick={(e) => handleToggleSelect(cust.id, e)}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          className="rounded border-gray-300 text-blue-600 focus:ring-0"
                        />
                      </td>

                      {/* Company */}
                      <td className="py-2.5 px-3 font-semibold text-gray-900">
                        <div className="flex items-center gap-1.5">
                          <span className="hover:text-blue-600">{cust.company_name}</span>
                          {cust.erp_customer_id && (
                            <span className="px-1.5 py-0.2 text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 rounded">
                              ERP
                            </span>
                          )}
                        </div>
                        {cust.city && <div className="text-[11px] font-normal text-gray-400">{cust.city}</div>}
                      </td>

                      {/* Contact */}
                      <td className="py-2.5 px-3 text-gray-700">
                        <div>{cleanContactPerson(cust.contact_person, cust.company_name) || '—'}</div>
                        {cust.designation && <div className="text-[11px] text-gray-400">{cust.designation}</div>}
                      </td>

                      {/* Email */}
                      <td className="py-2.5 px-3 text-gray-600">
                        {cust.email ? (
                          <a
                            href={`mailto:${cust.email}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-blue-600 hover:underline"
                          >
                            {cust.email}
                          </a>
                        ) : '—'}
                      </td>

                      {/* Phone */}
                      <td className="py-2.5 px-3 text-gray-600">
                        {cust.phone || cust.mobile ? (
                          <div className="flex items-center gap-1.5">
                            <a
                              href={`tel:${cust.phone || cust.mobile}`}
                              onClick={(e) => e.stopPropagation()}
                              className="hover:text-emerald-600"
                            >
                              {cust.phone || cust.mobile}
                            </a>
                            {cust.phonesCount && cust.phonesCount > 1 ? (
                              <span className="text-[10px] text-gray-400 font-mono" title={`${cust.phonesCount} phone numbers on record`}>
                                (+{cust.phonesCount - 1})
                              </span>
                            ) : null}
                            {cust.hasMultiplePrimary && (
                              <span
                                className="px-1.5 py-0.2 text-[9px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 rounded shrink-0"
                                title="Company has multiple primary phone records configured (needs review)"
                              >
                                Multi-Primary
                              </span>
                            )}
                          </div>
                        ) : '—'}
                      </td>

                      {/* Status */}
                      <td className="py-2.5 px-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                          cust.is_active !== false ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-gray-100 text-gray-600'
                        }`}>
                          {cust.is_active !== false ? 'Active' : 'Inactive'}
                        </span>
                      </td>

                      {/* Last Activity */}
                      <td className="py-2.5 px-3 text-gray-500 whitespace-nowrap">
                        {cust.lastActivityLabel}
                      </td>

                      {/* Open Inquiries */}
                      <td className="py-2.5 px-3 text-center">
                        {cust.openInquiriesCount > 0 ? (
                          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-bold text-xs">
                            {cust.openInquiriesCount}
                          </span>
                        ) : (
                          <span className="text-gray-300">0</span>
                        )}
                      </td>

                      {/* Open Orders */}
                      <td className="py-2.5 px-3 text-center">
                        {cust.openOrdersCount > 0 ? (
                          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 font-bold text-xs">
                            {cust.openOrdersCount}
                          </span>
                        ) : (
                          <span className="text-gray-300">0</span>
                        )}
                      </td>

                      {/* Sales Rep */}
                      <td className="py-2.5 px-3">
                        {cust.assignedSalespersonName ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">
                            <Users className="w-2.5 h-2.5" />
                            {cust.assignedSalespersonName}
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-400 italic">Unassigned</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-2.5 px-3 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedCustomerForDrawer(cust);
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-100 rounded transition inline-flex items-center gap-1"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          View
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      </div>

      {/* Excel Spreadsheet View */}
      <div className={viewMode === 'excel' ? 'bg-white rounded-lg border border-gray-200 shadow-sm p-3' : 'hidden'}>
        <CustomerDatabaseExcel
          externalSearch={searchQuery}
          refreshTrigger={excelRefreshKey}
        />
      </div>

      {/* Customer 360 & Timeline View */}
      <div className={viewMode === '360' ? 'block' : 'hidden'}>
        <Customer360Panel
          initialCustomerId={selectedCustomerForDrawer?.id}
          onOpenInquiry={onOpenInquiry}
        />
      </div>

      {/* Customer Right-Side Drawer */}
      <CrmCustomerDrawer
        isOpen={!!selectedCustomerForDrawer}
        onClose={() => setSelectedCustomerForDrawer(null)}
        customer={selectedCustomerForDrawer}
        onOpenInquiry={(inqId) => {
          setSelectedCustomerForDrawer(null);
          onOpenInquiry?.(inqId);
        }}
        onRefresh={loadCustomers}
      />

      {/* New Customer Modal */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 border border-gray-200">
            <h3 className="text-base font-bold text-gray-900 mb-4">Add New Customer / Prospect</h3>
            <form onSubmit={handleCreateCustomer} className="space-y-3 text-xs">
              <SapRow>
                <FloatingField label="Company Name" required span={12} filled={!!newCompany}>
                  <input
                    type="text"
                    required
                    value={newCompany}
                    onChange={(e) => setNewCompany(e.target.value)}
                    placeholder="e.g. PT Kalbe Farma"
                    className={FLOAT_INPUT}
                  />
                </FloatingField>
              </SapRow>

              <SapRow>
                <FloatingField label="Contact Person" span={12} filled={!!newContact}>
                  <input
                    type="text"
                    value={newContact}
                    onChange={(e) => setNewContact(e.target.value)}
                    placeholder="e.g. Dr. Budi Santoso"
                    className={FLOAT_INPUT}
                  />
                </FloatingField>
              </SapRow>

              <SapRow>
                <FloatingField label="Email" span={6} filled={!!newEmail}>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="contact@company.com"
                    className={FLOAT_INPUT}
                  />
                </FloatingField>

                <FloatingField label="Phone / Mobile" span={6} filled={!!newPhone}>
                  <input
                    type="tel"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    placeholder="0811... or +62..."
                    className={FLOAT_INPUT}
                  />
                </FloatingField>
              </SapRow>

              <SapRow>
                <FloatingField label="Country" span={6} filled={!!newCountry}>
                  <select
                    value={newCountry}
                    onChange={(e) => setNewCountry(e.target.value)}
                    className={FLOAT_INPUT}
                  >
                    <option value="ID">🇮🇩 Indonesia (+62)</option>
                    <option value="IN">🇮🇳 India (+91)</option>
                    <option value="SG">🇸🇬 Singapore (+65)</option>
                    <option value="MY">🇲🇾 Malaysia (+60)</option>
                    <option value="CN">🇨🇳 China (+86)</option>
                    <option value="US">🇺🇸 United States (+1)</option>
                    <option value="GB">🇬🇧 United Kingdom (+44)</option>
                    <option value="DE">🇩🇪 Germany (+49)</option>
                    <option value="VN">🇻🇳 Vietnam (+84)</option>
                    <option value="TH">🇹🇭 Thailand (+66)</option>
                    <option value="KR">🇰🇷 South Korea (+82)</option>
                    <option value="JP">🇯🇵 Japan (+81)</option>
                    <option value="AU">🇦🇺 Australia (+61)</option>
                    <option value="OTHER">🌐 Other / International</option>
                  </select>
                </FloatingField>

                <FloatingField label="City" span={6} filled={!!newCity}>
                  <input
                    type="text"
                    value={newCity}
                    onChange={(e) => setNewCity(e.target.value)}
                    placeholder="Jakarta"
                    className={FLOAT_INPUT}
                  />
                </FloatingField>
              </SapRow>

              <SapRow>
                <FloatingField label="Customer Type (Classification)" span={12} filled={!!newType}>
                  <select
                    value={newType}
                    onChange={(e) => setNewType(e.target.value)}
                    className={FLOAT_INPUT}
                  >
                    <option value="Pharma Manufacturer">Pharma Manufacturer</option>
                    <option value="Food & Bev Manufacturer">Food & Bev Manufacturer</option>
                    <option value="Cosmetics Manufacturer">Cosmetics Manufacturer</option>
                    <option value="Distributor / Trader">Distributor / Trader</option>
                    <option value="Other">Other</option>
                  </select>
                </FloatingField>
              </SapRow>

              <div className="flex justify-end gap-2 pt-3 border-t border-gray-200 mt-4">
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="px-3 py-1.5 text-gray-600 hover:bg-gray-100 rounded-md text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingNew}
                  className="px-4 py-1.5 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingNew ? 'Saving...' : 'Create Customer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Assign Salesperson Modal */}
      {showAssignModal && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 border border-slate-200 animate-in fade-in zoom-in-95 duration-100">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-purple-600" />
                <h3 className="text-base font-bold text-slate-900">
                  Assign {selectedIds.size} Companies to Salesperson
                </h3>
              </div>
              <button
                onClick={() => setShowAssignModal(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Select Sales Team Member *
                </label>
                <select
                  value={targetSalesMemberId}
                  onChange={(e) => setTargetSalesMemberId(e.target.value)}
                  className="w-full text-xs font-semibold border border-slate-300 rounded-lg p-2.5 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-purple-500"
                >
                  <option value="" disabled>Choose Sales Representative...</option>
                  {salesMembers.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.email || 'Sales Team'})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Allocation Notes / Target Sector (Optional)
                </label>
                <input
                  type="text"
                  value={assignNotes}
                  onChange={(e) => setAssignNotes(e.target.value)}
                  placeholder="e.g. Q4 Target Pharma Outbound Campaign"
                  className="w-full text-xs border border-slate-300 rounded-lg p-2.5 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
              </div>

              <div className="p-3 bg-purple-50 rounded-lg border border-purple-100 text-xs text-purple-900">
                <p className="font-semibold">Team Assignment Policy:</p>
                <p className="text-[11px] text-purple-700 mt-0.5">
                  Assigning these {selectedIds.size} accounts sets workload ownership in PostgreSQL without modifying or duplicating ERP financial records.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowAssignModal(false)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={assigning || !targetSalesMemberId}
                  onClick={handleAssignSalesperson}
                  className="px-4 py-1.5 text-xs font-bold bg-purple-600 hover:bg-purple-700 text-white rounded-lg shadow-2xs transition disabled:opacity-50"
                >
                  {assigning ? 'Assigning...' : `Assign ${selectedIds.size} Companies`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
