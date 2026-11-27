import { useState, useEffect, useRef, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import {
  findOrCreateCrmContact,
} from '../../utils/customerValidation';
import { Plus, X, Search } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { SearchableSelect } from '../SearchableSelect';
import { useDebounce } from '../../hooks/useDebounce';
import {
  searchHistoricalProducts,
  searchHistoricalSpecifications,
  getHistoricalCountrySuggestions,
} from '../../services/crmInquirySuggestions';
import { FloatingField, FLOAT_INPUT, FLOAT_TEXTAREA } from '../finance/FloatingField';
import { SapRow } from '../finance/SapLayout';

interface Customer {
  id: string;
  company_name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  address: string | null;
  city: string | null;
}

interface CompactInquiryFormProps {
  onSubmit: (data: any) => Promise<void>;
  onCancel: () => void;
  initialData?: any;
  isEditing?: boolean;
}

export function CompactInquiryForm({ onSubmit, onCancel, initialData, isEditing = false }: CompactInquiryFormProps) {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [filteredCustomers, setFilteredCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [productSuggestions, setProductSuggestions] = useState<string[]>([]);
  const [specSuggestions, setSpecSuggestions] = useState<string[]>([]);
  const [countrySuggestions, setCountrySuggestions] = useState<string[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [loadingSpecs, setLoadingSpecs] = useState(false);
  const [loadingCountries, setLoadingCountries] = useState(false);

  const [formData, setFormData] = useState({
    product_name: initialData?.product_name || '',
    specification: initialData?.specification || '',
    quantity: initialData?.quantity || '',
    priority: initialData?.priority || 'medium',
    inquiry_source: initialData?.inquiry_source || 'email',
    supplier_name: initialData?.supplier_name || '',
    supplier_country: initialData?.supplier_country || '',
    crm_contact_id: initialData?.crm_contact_id || '',
    company_name: initialData?.company_name || '',
    contact_person: initialData?.contact_person || '',
    contact_email: initialData?.contact_email || '',
    contact_phone: initialData?.contact_phone || '',
    price_required: initialData?.price_required || false,
    coa_required: initialData?.coa_required || false,
    sample_required: initialData?.sample_required || false,
    agency_letter_required: initialData?.agency_letter_required || false,
    others_required: initialData?.others_required || false,
    purchase_price: initialData?.purchase_price || '',
    purchase_price_currency: initialData?.purchase_price_currency || 'USD',
    offered_price: initialData?.offered_price || '',
    offered_price_currency: initialData?.offered_price_currency || 'USD',
    delivery_date: initialData?.delivery_date || '',
    delivery_terms: initialData?.delivery_terms || '',
    aceerp_no: initialData?.aceerp_no || '',
    mail_subject: initialData?.mail_subject || '',
    pipeline_status: initialData?.pipeline_status || 'new',
    remarks: initialData?.remarks || '',
    internal_notes: initialData?.internal_notes || '',
    is_multi_product: initialData?.is_multi_product || false,
    products: initialData?.products || [],
  });

  const [newCustomer, setNewCustomer] = useState({
    company_name: '',
    contact_person: '',
    email: '',
    phone: '',
    country: 'Indonesia',
    address: '',
    city: 'Jakarta Pusat',
    npwp: '',
    pbf_license: '',
    gst_vat_type: '',
    payment_terms: '',
  });

  useEffect(() => {
    loadCustomers();
  }, []);

  const debouncedProductQuery = useDebounce(formData.product_name, 250);
  const debouncedSpecQuery = useDebounce(formData.specification, 250);
  const debouncedCountryQuery = useDebounce(formData.supplier_country, 250);

  useEffect(() => {
    let active = true;
    if (!debouncedProductQuery || debouncedProductQuery.trim().length < 1) {
      setProductSuggestions([]);
      return;
    }
    setLoadingProducts(true);
    searchHistoricalProducts(debouncedProductQuery)
      .then((res) => {
        if (active) setProductSuggestions(res);
      })
      .catch(() => {
        if (active) setProductSuggestions([]);
      })
      .finally(() => {
        if (active) setLoadingProducts(false);
      });
    return () => {
      active = false;
    };
  }, [debouncedProductQuery]);

  useEffect(() => {
    let active = true;
    if (!debouncedSpecQuery || debouncedSpecQuery.trim().length < 1) {
      setSpecSuggestions([]);
      return;
    }
    setLoadingSpecs(true);
    searchHistoricalSpecifications(debouncedSpecQuery)
      .then((res) => {
        if (active) setSpecSuggestions(res);
      })
      .catch(() => {
        if (active) setSpecSuggestions([]);
      })
      .finally(() => {
        if (active) setLoadingSpecs(false);
      });
    return () => {
      active = false;
    };
  }, [debouncedSpecQuery]);

  useEffect(() => {
    let active = true;
    setLoadingCountries(true);
    getHistoricalCountrySuggestions(debouncedCountryQuery)
      .then((res) => {
        if (active) setCountrySuggestions(res);
      })
      .catch(() => {
        if (active) setCountrySuggestions(['India', 'China']);
      })
      .finally(() => {
        if (active) setLoadingCountries(false);
      });
    return () => {
      active = false;
    };
  }, [debouncedCountryQuery]);

  const productOptions = useMemo(
    () => productSuggestions.map((name) => ({ value: name, label: name })),
    [productSuggestions]
  );
  const specOptions = useMemo(
    () => specSuggestions.map((name) => ({ value: name, label: name })),
    [specSuggestions]
  );
  const countryOptions = useMemo(
    () => countrySuggestions.map((name) => ({ value: name, label: name })),
    [countrySuggestions]
  );

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowCustomerDropdown(false);
      }
    };

    if (showCustomerDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showCustomerDropdown]);

  useEffect(() => {
    if (customerSearch) {
      const filtered = customers.filter(c =>
        c.company_name.toLowerCase().includes(customerSearch.toLowerCase())
      );
      setFilteredCustomers(filtered);
    } else {
      setFilteredCustomers(customers);
    }
  }, [customerSearch, customers]);

  const loadCustomers = async () => {
    try {
      // CRM Inquiry customer picker searches the CRM prospect master
      // (crm_contacts), not the ERP customers table.
      const { data, error } = await supabase
        .from('crm_contacts')
        .select('id, company_name, contact_person, email, phone, country, address, city')
        .eq('is_active', true)
        .order('company_name');

      if (error) throw error;
      setCustomers(data || []);
      setFilteredCustomers(data || []);
    } catch (error) {
      console.error('Error loading CRM contacts:', error);
    }
  };

  const handleCustomerSelect = (customer: Customer) => {
    setFormData({
      ...formData,
      crm_contact_id: customer.id,
      company_name: customer.company_name,
      contact_person: customer.contact_person || '',
      contact_email: customer.email || '',
      contact_phone: customer.phone || '',
    });
    setCustomerSearch(customer.company_name);
    setShowCustomerDropdown(false);
  };

  const handleAddCustomer = async () => {
    if (!newCustomer.company_name) {
      alert('Customer name is required');
      return;
    }

    try {
      // Reuse an existing crm_contacts row when the company already exists
      // (case/space-insensitive) — never create duplicates.
      const { contact, created } = await findOrCreateCrmContact({
        company_name:   newCustomer.company_name,
        contact_person: newCustomer.contact_person,
        email:          newCustomer.email,
        phone:          newCustomer.phone,
        country:        newCustomer.country,
        address:        newCustomer.address,
        city:           newCustomer.city,
      });

      await loadCustomers();
      handleCustomerSelect(contact);
      setShowAddCustomerModal(false);
      setNewCustomer({
        company_name: '',
        contact_person: '',
        email: '',
        phone: '',
        country: 'Indonesia',
        address: '',
        city: 'Jakarta Pusat',
        npwp: '',
        pbf_license: '',
        gst_vat_type: '',
        payment_terms: '',
      });
      if (!created) {
        alert(`Reusing existing CRM customer: ${contact.company_name}`);
      }
    } catch (error: any) {
      console.error('Error adding CRM contact:', error);
      alert(error?.message || 'Failed to add CRM customer');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Skip product validation for multi-product inquiries
    if (!formData.is_multi_product) {
      if (!formData.product_name || !formData.quantity || !formData.company_name) {
        alert('Please fill in all required fields: Product Name, Quantity, and Customer');
        return;
      }
    } else {
      if (!formData.company_name) {
        alert('Please fill in Customer');
        return;
      }
    }

    setSubmitting(true);
    try {
      await onSubmit(formData);
    } finally {
      setSubmitting(false);
    }
  };

  const addProduct = () => {
    setFormData({
      ...formData,
      products: [
        ...formData.products,
        {
          productName: '',
          specification: '',
          quantity: '',
          supplierName: '',
          supplierCountry: '',
          deliveryDate: '',
          deliveryTerms: ''
        }
      ]
    });
  };

  const removeProduct = (index: number) => {
    setFormData({
      ...formData,
      products: formData.products.filter((_item: (typeof formData.products)[number], i: number) => i !== index)
    });
  };

  const updateProduct = (index: number, field: string, value: string) => {
    const updatedProducts = [...formData.products];
    updatedProducts[index] = { ...updatedProducts[index], [field]: value };
    setFormData({ ...formData, products: updatedProducts });
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* AI Extraction Review Banner (highlights missing/uncertain fields before save) */}
        {initialData?.extraction_meta && (
          <div className="p-3 rounded-lg border border-indigo-200 bg-indigo-50/70 text-xs space-y-1.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="font-semibold text-indigo-900">
                AI Extraction Review ({String(initialData.extraction_meta.confidence || 'medium').toUpperCase()} confidence) — Please verify fields below before creating
              </span>
            </div>
            {(initialData.extraction_meta.missingFields?.length > 0 || initialData.extraction_meta.uncertainFields?.length > 0) && (
              <div className="text-amber-800 flex flex-wrap gap-1.5 items-center">
                <span className="font-medium">Not provided / verify:</span>
                {[...(initialData.extraction_meta.missingFields || []), ...(initialData.extraction_meta.uncertainFields || [])].map((f: string) => (
                  <span key={f} className="px-1.5 py-0.5 bg-amber-100 border border-amber-300 rounded text-[11px]">
                    {f}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Multi-Product Toggle */}
        <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg border border-blue-200">
          <input
            type="checkbox"
            id="multiProductToggle"
            checked={formData.is_multi_product}
            onChange={(e) => {
              const isMulti = e.target.checked;
              setFormData({
                ...formData,
                is_multi_product: isMulti,
                products: isMulti && formData.products.length === 0
                  ? [{
                      productName: '',
                      specification: '',
                      quantity: '',
                      supplierName: '',
                      supplierCountry: '',
                      deliveryDate: '',
                      deliveryTerms: ''
                    }]
                  : formData.products
              });
            }}
            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
          />
          <label htmlFor="multiProductToggle" className="text-sm font-medium text-gray-700 cursor-pointer">
            {t('crm.form.multiProductToggle', 'Multi-Product Inquiry (Common data will be applied to all products)')}
          </label>
        </div>

        {/* Multi-Product Products List */}
        {formData.is_multi_product && (
          <div className="space-y-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
                {t('crm.form.productsList', 'Products')} ({formData.products.length})
              </span>
              <button
                type="button"
                onClick={addProduct}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-md font-medium transition"
              >
                <Plus className="w-3.5 h-3.5" /> {t('crm.form.addAnotherProduct', 'Add Another Product')}
              </button>
            </div>

            {(formData.products as any[]).map((prod: any, index: number) => (
              <div
                key={index}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text/plain');
                  if (!text || (!text.includes('\t') && !text.includes('\n'))) return;
                  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                  if (lines.length <= 1 && !text.includes('\t')) return;
                  e.preventDefault();
                  const parsedRows = lines.map((line) => {
                    const cols = line.split('\t').map((c) => c.trim());
                    return {
                      productName: cols[0] || '',
                      specification: cols[1] || '',
                      quantity: cols[2] || '',
                      supplierName: cols[3] || '',
                      supplierCountry: cols[4] || '',
                      deliveryDate: cols[5] || '',
                      deliveryTerms: '',
                    };
                  }).filter((r) => r.productName);
                  if (parsedRows.length > 0) {
                    setFormData((prev) => ({
                      ...prev,
                      products: [...prev.products.slice(0, index), ...parsedRows, ...prev.products.slice(index + 1)],
                    }));
                  }
                }}
                className="grid grid-cols-12 gap-2 p-2 bg-white rounded border border-gray-200 items-end"
              >
                <div className="col-span-12 sm:col-span-4">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    {t('crm.form.productName', 'Product Name')} <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={prod.productName}
                    onChange={(e) => updateProduct(index, 'productName', e.target.value)}
                    placeholder="e.g., Paracetamol IP"
                    className="w-full h-8 px-2 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>
                <div className="col-span-6 sm:col-span-2">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    {t('crm.form.specification', 'Specification')}
                  </label>
                  <input
                    type="text"
                    value={prod.specification || ''}
                    onChange={(e) => updateProduct(index, 'specification', e.target.value)}
                    placeholder="USP / BP"
                    className="w-full h-8 px-2 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div className="col-span-6 sm:col-span-2">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    {t('crm.form.quantity', 'Quantity')} <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={prod.quantity}
                    onChange={(e) => updateProduct(index, 'quantity', e.target.value)}
                    placeholder="e.g., 500 KG"
                    className="w-full h-8 px-2 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>
                <div className="col-span-6 sm:col-span-2">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Manufacturer
                  </label>
                  <input
                    type="text"
                    value={prod.supplierName || ''}
                    onChange={(e) => updateProduct(index, 'supplierName', e.target.value)}
                    placeholder="Factory"
                    className="w-full h-8 px-2 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div className="col-span-5 sm:col-span-1">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Origin
                  </label>
                  <input
                    type="text"
                    value={prod.supplierCountry || ''}
                    onChange={(e) => updateProduct(index, 'supplierCountry', e.target.value)}
                    placeholder="India"
                    className="w-full h-8 px-2 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div className="col-span-1 flex justify-center pb-1">
                  {formData.products.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeProduct(index)}
                      className="text-red-500 hover:text-red-700 p-1"
                      title={t('crm.form.removeProduct', 'Remove product')}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Row: Product Name | Specification */}
        {!formData.is_multi_product && (
          <SapRow>
            <FloatingField label={t('crm.form.productName', 'Product Name')} required span={6} filled={!!formData.product_name}>
              <SearchableSelect
                id="inquiry_product_name"
                name="product_name"
                aria-label={t('crm.form.productNamePlaceholder', 'Enter product name')}
                freeSolo
                filterOptions={false}
                value={formData.product_name}
                onChange={(val) => setFormData((prev) => ({ ...prev, product_name: val }))}
                options={productOptions}
                loading={loadingProducts}
                placeholder={t('crm.form.productNamePlaceholder', 'Enter product name')}
                required
              />
            </FloatingField>
            <FloatingField label={t('crm.form.specification', 'Specification')} span={6} filled={!!formData.specification}>
              <SearchableSelect
                id="inquiry_specification"
                name="specification"
                aria-label={t('crm.form.specification', 'Specification')}
                freeSolo
                filterOptions={false}
                value={formData.specification}
                onChange={(val) => setFormData((prev) => ({ ...prev, specification: val }))}
                options={specOptions}
                loading={loadingSpecs}
                placeholder={t('crm.form.specificationPlaceholder', 'BP / USP / EP')}
              />
            </FloatingField>
          </SapRow>
        )}

        {/* Row: Quantity | Priority | Inquiry Source */}
        <SapRow>
          {!formData.is_multi_product && (
            <FloatingField label={t('crm.form.quantity', 'Quantity')} required span={4} filled={!!formData.quantity}>
              <input name="quantity" aria-label={t('crm.form.quantityPlaceholder', 'e.g., 500 KG')}
                type="text"
                value={formData.quantity}
                onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
                className={FLOAT_INPUT}
                placeholder={t('crm.form.quantityPlaceholder', 'e.g., 500 KG')}
                required
              />
            </FloatingField>
          )}
          <FloatingField label={t('crm.form.priority', 'Priority')} required span={formData.is_multi_product ? 4 : 4} filled={!!formData.priority}>
            <select name="priority" aria-label={t('crm.form.priority', 'Priority')}
              value={formData.priority}
              onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
              className={FLOAT_INPUT}
            >
              <option value="low">{t('crm.priorityLevels.low', 'Low')}</option>
              <option value="medium">{t('crm.priorityLevels.medium', 'Medium')}</option>
              <option value="high">{t('crm.priorityLevels.high', 'High')}</option>
              <option value="urgent">{t('crm.priorityLevels.urgent', 'Urgent')}</option>
            </select>
          </FloatingField>
          <FloatingField label={t('crm.form.inquirySource', 'Inquiry Source')} span={formData.is_multi_product ? 8 : 4} filled={!!formData.inquiry_source}>
            <select name="inquiry_source" aria-label={t('crm.form.inquirySource', 'Inquiry Source')}
              value={formData.inquiry_source}
              onChange={(e) => setFormData({ ...formData, inquiry_source: e.target.value })}
              className={FLOAT_INPUT}
            >
              <option value="email">{t('crm.inquirySources.email', 'Email')}</option>
              <option value="phone">{t('crm.inquirySources.phone', 'Phone')}</option>
              <option value="whatsapp">{t('crm.inquirySources.whatsapp', 'WhatsApp')}</option>
              <option value="website">{t('crm.inquirySources.website', 'Website')}</option>
              <option value="referral">{t('crm.inquirySources.referral', 'Referral')}</option>
              <option value="other">{t('crm.inquirySources.other', 'Other')}</option>
            </select>
          </FloatingField>
        </SapRow>

        {/* Row: Supplier Name | Country of Origin | Customer Dropdown */}
        <SapRow>
          <FloatingField label={t('crm.form.supplierName', 'Supplier Name')} span={4} filled={!!formData.supplier_name}>
            <input name="supplier_name" aria-label={t('crm.form.supplierName', 'Supplier Name')}
              type="text"
              value={formData.supplier_name}
              onChange={(e) => setFormData({ ...formData, supplier_name: e.target.value })}
              className={FLOAT_INPUT}
              placeholder={t('crm.form.supplierNamePlaceholder', 'Manufacturer/Supplier')}
            />
          </FloatingField>
          <FloatingField label={t('crm.form.countryOfOrigin', 'Country of Origin')} span={4} filled={!!formData.supplier_country}>
            <SearchableSelect
              id="inquiry_country_of_origin"
              name="country_of_origin"
              aria-label={t('crm.form.countryOfOrigin', 'Country of Origin')}
              freeSolo
              filterOptions={false}
              value={formData.supplier_country}
              onChange={(val) => setFormData((prev) => ({ ...prev, supplier_country: val }))}
              options={countryOptions}
              loading={loadingCountries}
              placeholder={t('crm.form.countryOfOriginPlaceholder', 'Supplier country')}
            />
          </FloatingField>
          <div ref={dropdownRef} className="relative sm:col-span-4 min-w-0">
            <FloatingField label={t('crm.form.customer', 'Customer')} required span={12} filled={!!(customerSearch || formData.company_name)}>
              <div className="relative">
                <input name="company_name" aria-label={t('crm.form.searchCustomerPlaceholder', 'Search customer...')}
                  type="text"
                  value={customerSearch || formData.company_name}
                  onChange={(e) => {
                    const val = e.target.value;
                    setCustomerSearch(val);
                    setFormData(prev => ({
                      ...prev,
                      company_name: val,
                      crm_contact_id: prev.company_name === val ? prev.crm_contact_id : '',
                    }));
                    setShowCustomerDropdown(true);
                  }}
                  onFocus={() => setShowCustomerDropdown(true)}
                  className={`${FLOAT_INPUT} pr-8`}
                  placeholder={t('crm.form.searchCustomerPlaceholder', 'Search customer...')}
                  required
                />
                <Search className="absolute right-2 top-2 w-4 h-4 text-gray-400" />
              </div>
            </FloatingField>
            {showCustomerDropdown && (
              <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {filteredCustomers.map((customer) => (
                  <div
                    key={customer.id}
                    onClick={() => handleCustomerSelect(customer)}
                    className="px-3 py-2 hover:bg-blue-50 cursor-pointer text-sm"
                  >
                    <div className="font-medium">{customer.company_name}</div>
                    {customer.contact_person && (
                      <div className="text-xs text-gray-500">{customer.contact_person}</div>
                    )}
                  </div>
                ))}
                {filteredCustomers.length === 0 && (
                  <div className="px-3 py-2 text-sm text-gray-500">{t('crm.form.noCustomersFound', 'No customers found')}</div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => setShowAddCustomerModal(true)}
              className="mt-1 text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" />
              {t('crm.form.addNewCustomer', 'Add New Customer')}
            </button>
          </div>
        </SapRow>

        {/* Row: Contact Person | Email | Phone */}
        <SapRow>
          <FloatingField label={t('crm.form.contactPerson', 'Contact Person')} span={4} filled={!!formData.contact_person}>
            <input name="contact_person" aria-label={t('crm.form.contactPerson', 'Contact Person')}
              type="text"
              value={formData.contact_person}
              onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })}
              className={FLOAT_INPUT}
              placeholder="Name"
            />
          </FloatingField>
          <FloatingField label={t('crm.form.email', 'Email')} span={4} filled={!!formData.contact_email} hint={t('crm.form.emailHint', 'Use comma (,) or semicolon (;) to separate multiple emails')}>
            <input name="email" aria-label={t('crm.form.email', 'Email')}
              type="text"
              value={formData.contact_email}
              onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })}
              className={FLOAT_INPUT}
              placeholder="email@example.com"
            />
          </FloatingField>
          <FloatingField label={t('crm.form.phone', 'Phone')} span={4} filled={!!formData.contact_phone}>
            <input name="phone" aria-label={t('crm.form.phone', 'Phone')}
              type="tel"
              value={formData.contact_phone}
              onChange={(e) => setFormData({ ...formData, contact_phone: e.target.value })}
              className={FLOAT_INPUT}
              placeholder="+62 xxx"
            />
          </FloatingField>
        </SapRow>

        {/* Mail Subject - Full Width */}
        <SapRow>
          <FloatingField label={t('crm.form.mailSubject', 'Mail Subject')} span={12} filled={!!formData.mail_subject}>
            <input name="mail_subject" aria-label={t('crm.form.mailSubject', 'Mail Subject')}
              type="text"
              value={formData.mail_subject}
              onChange={(e) => setFormData({ ...formData, mail_subject: e.target.value })}
              className={FLOAT_INPUT}
              placeholder={t('crm.form.mailSubjectPlaceholder', 'Email subject line')}
            />
          </FloatingField>
        </SapRow>

        {/* Customer Requested - 5 checkboxes in one row */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2">
            {t('crm.customerRequestedOptions.title', 'Customer Requested')}
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input name="customer_requested" aria-label={t('crm.customerRequestedOptions.price', 'Price')}
                type="checkbox"
                checked={formData.price_required}
                onChange={(e) => setFormData({ ...formData, price_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">{t('crm.customerRequestedOptions.price', 'Price')}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input name="coa_required" aria-label={t('crm.customerRequestedOptions.coa', 'COA')}
                type="checkbox"
                checked={formData.coa_required}
                onChange={(e) => setFormData({ ...formData, coa_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">{t('crm.customerRequestedOptions.coa', 'COA')}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input name="sample_required" aria-label={t('crm.customerRequestedOptions.sample', 'Sample')}
                type="checkbox"
                checked={formData.sample_required}
                onChange={(e) => setFormData({ ...formData, sample_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">{t('crm.customerRequestedOptions.sample', 'Sample')}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input name="agency_letter_required" aria-label={t('crm.customerRequestedOptions.agencyLetter', 'Agency Letter')}
                type="checkbox"
                checked={formData.agency_letter_required}
                onChange={(e) => setFormData({ ...formData, agency_letter_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">{t('crm.customerRequestedOptions.agencyLetter', 'Agency Letter')}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input name="others_required" aria-label={t('crm.customerRequestedOptions.others', 'Others')}
                type="checkbox"
                checked={formData.others_required}
                onChange={(e) => setFormData({ ...formData, others_required: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-700">{t('crm.customerRequestedOptions.others', 'Others')}</span>
            </label>
          </div>
        </div>

        <div className="border-t border-gray-200 pt-3">
          <h3 className="text-xs font-semibold text-gray-700 mb-2">{t('crm.form.pricing', 'Pricing')}</h3>

          {/* Row: Purchase Price (Admin Only) | Offered Price | Currency */}
          <SapRow>
            {profile?.role === 'admin' && (
              <>
                <FloatingField label={t('crm.form.purchasePrice', 'Purchase Price')} span={4} filled={!!formData.purchase_price}>
                  <input name="purchase_price" aria-label={t('crm.form.purchasePrice', 'Purchase Price')}
                    type="text"
                    value={formData.purchase_price}
                    onChange={(e) => setFormData({ ...formData, purchase_price: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="100.00"
                  />
                </FloatingField>
                <FloatingField label={t('crm.form.currency', 'Currency')} span={2} filled={!!formData.purchase_price_currency}>
                  <select name="currency" aria-label={t('crm.form.currency', 'Currency')}
                    value={formData.purchase_price_currency}
                    onChange={(e) => setFormData({ ...formData, purchase_price_currency: e.target.value })}
                    className={FLOAT_INPUT}
                  >
                    <option value="USD">USD</option>
                    <option value="IDR">IDR</option>
                  </select>
                </FloatingField>
              </>
            )}
            <FloatingField label={t('crm.form.offeredPrice', 'Offered Price')} span={profile?.role === 'admin' ? 4 : 8} filled={!!formData.offered_price}>
              <input name="offered_price" aria-label={t('crm.form.offeredPrice', 'Offered Price')}
                type="text"
                value={formData.offered_price}
                onChange={(e) => setFormData({ ...formData, offered_price: e.target.value })}
                className={FLOAT_INPUT}
                placeholder="150.00"
              />
            </FloatingField>
            <FloatingField label={t('crm.form.currency', 'Currency')} span={profile?.role === 'admin' ? 2 : 4} filled={!!formData.offered_price_currency}>
              <select name="currency" aria-label={t('crm.form.currency', 'Currency')}
                value={formData.offered_price_currency}
                onChange={(e) => setFormData({ ...formData, offered_price_currency: e.target.value })}
                className={FLOAT_INPUT}
              >
                <option value="USD">USD</option>
                <option value="IDR">IDR</option>
              </select>
            </FloatingField>
          </SapRow>
        </div>

        {/* Delivery Date and Terms (always shown) */}
        <SapRow>
          <FloatingField label={t('crm.form.deliveryDate', 'Delivery Date')} span={6} filled={!!formData.delivery_date}>
            <input name="delivery_date" aria-label={t('crm.form.deliveryDate', 'Delivery Date')}
              type="date"
              value={formData.delivery_date}
              onChange={(e) => setFormData({ ...formData, delivery_date: e.target.value })}
              className={FLOAT_INPUT}
            />
          </FloatingField>
          <FloatingField label={t('crm.form.deliveryTerms', 'Delivery Terms')} span={6} filled={!!formData.delivery_terms}>
            <select name="delivery_terms" aria-label={t('crm.form.deliveryTerms', 'Delivery Terms')}
              value={formData.delivery_terms}
              onChange={(e) => setFormData({ ...formData, delivery_terms: e.target.value })}
              className={FLOAT_INPUT}
            >
              <option value="">{t('crm.form.selectDeliveryTerms', 'Select...')}</option>
              <option value="FOB Jakarta">{t('crm.deliveryTermsList.fobJakarta', 'FOB Jakarta')}</option>
              <option value="CIF Jakarta">{t('crm.deliveryTermsList.cifJakarta', 'CIF Jakarta')}</option>
              <option value="FOB Surabaya">{t('crm.deliveryTermsList.fobSurabaya', 'FOB Surabaya')}</option>
              <option value="CIF Surabaya">{t('crm.deliveryTermsList.cifSurabaya', 'CIF Surabaya')}</option>
              <option value="FOB Semarang">{t('crm.deliveryTermsList.fobSemarang', 'FOB Semarang')}</option>
              <option value="CIF Semarang">{t('crm.deliveryTermsList.cifSemarang', 'CIF Semarang')}</option>
              <option value="EXW">{t('crm.deliveryTermsList.exw', 'EXW')}</option>
              <option value="DDP">{t('crm.deliveryTermsList.ddp', 'DDP')}</option>
              <option value="DAP">{t('crm.deliveryTermsList.dap', 'DAP')}</option>
              <option value="CFR">{t('crm.deliveryTermsList.cfr', 'CFR')}</option>
              <option value="FCA">{t('crm.deliveryTermsList.fca', 'FCA')}</option>
            </select>
          </FloatingField>
        </SapRow>

        {/* Row: ACE ERP No | Pipeline Status */}
        <SapRow>
          <FloatingField label={t('crm.form.aceErpNo', 'ACE ERP No')} span={6} filled={!!formData.aceerp_no}>
            <input name="ace_erp_no" aria-label={t('crm.form.aceErpNo', 'ACE ERP No')}
              type="text"
              value={formData.aceerp_no}
              onChange={(e) => setFormData({ ...formData, aceerp_no: e.target.value })}
              className={FLOAT_INPUT}
              placeholder="Optional"
            />
          </FloatingField>
          <FloatingField label={t('crm.form.pipelineStatus', 'Pipeline Status')} span={6} filled={!!formData.pipeline_status}>
            <select name="pipeline_status" aria-label={t('crm.form.pipelineStatus', 'Pipeline Status')}
              value={formData.pipeline_status}
              onChange={(e) => setFormData({ ...formData, pipeline_status: e.target.value })}
              className={FLOAT_INPUT}
            >
              <option value="new">{t('crm.pipelineStatuses.new', 'New')}</option>
              <option value="in_progress">{t('crm.pipelineStatuses.in_progress', 'In Progress')}</option>
              <option value="follow_up">{t('crm.pipelineStatuses.follow_up', 'Follow Up')}</option>
              <option value="won">{t('crm.pipelineStatuses.won', 'Won')}</option>
              <option value="lost">{t('crm.pipelineStatuses.lost', 'Lost')}</option>
              <option value="on_hold">{t('crm.pipelineStatuses.on_hold', 'On Hold')}</option>
            </select>
          </FloatingField>
        </SapRow>

        {/* Remarks - Full Width */}
        <SapRow>
          <FloatingField label={t('crm.form.remarks', 'Remarks')} textarea span={12} filled={!!formData.remarks}>
            <textarea name="remarks" aria-label={t('crm.form.remarks', 'Remarks')}
              value={formData.remarks}
              onChange={(e) => setFormData({ ...formData, remarks: e.target.value })}
              rows={2}
              className={FLOAT_TEXTAREA}
              placeholder={t('crm.form.remarksPlaceholder', 'Customer notes, special requirements...')}
            />
          </FloatingField>
        </SapRow>

        {/* Internal Notes - Full Width */}
        <SapRow>
          <FloatingField label={t('crm.form.internalNotes', 'Internal Notes')} textarea span={12} filled={!!formData.internal_notes}>
            <textarea name="internal_notes" aria-label={t('crm.form.internalNotes', 'Internal Notes')}
              value={formData.internal_notes}
              onChange={(e) => setFormData({ ...formData, internal_notes: e.target.value })}
              rows={2}
              className={FLOAT_TEXTAREA}
              placeholder={t('crm.form.internalNotesPlaceholder', 'Private notes (not visible to customer)...')}
            />
          </FloatingField>
        </SapRow>

        {/* Action Buttons — Sticky at bottom with safe-area spacing and non-obstructive padding */}
        <div className="flex justify-end gap-3 pt-3 border-t border-gray-200 sticky bottom-0 bg-white pb-[max(env(safe-area-inset-bottom),0.5rem)] z-10">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition min-h-[38px]"
            disabled={submitting}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 min-h-[38px] font-medium"
            disabled={submitting}
          >
            {submitting ? t('common.saving', 'Saving...') : (isEditing ? t('crm.form.updateInquiry', 'Update Inquiry') : t('crm.form.addInquiry', 'Add Inquiry'))}
          </button>
        </div>
      </form>

      {/* Add Customer Modal */}
      {showAddCustomerModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl p-5 sm:p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">{t('crm.form.addNewCustomer', 'Add New Customer')}</h3>
              <button
                onClick={() => setShowAddCustomerModal(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-md"
                aria-label={t('common.cancel', 'Cancel')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              <SapRow>
                <FloatingField label={t('crm.form.customer', 'Company Name')} required span={6} filled={!!newCustomer.company_name}>
                  <input name="company_name" aria-label={t('crm.form.customer', 'Company Name')}
                    type="text"
                    value={newCustomer.company_name}
                    onChange={(e) => setNewCustomer({ ...newCustomer, company_name: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder={t('crm.form.customer', 'Company name')}
                  />
                </FloatingField>
                <FloatingField label={t('crm.form.contactPerson', 'Contact Person')} span={6} filled={!!newCustomer.contact_person}>
                  <input name="contact_person" aria-label={t('crm.form.contactPerson', 'Contact Person')}
                    type="text"
                    value={newCustomer.contact_person}
                    onChange={(e) => setNewCustomer({ ...newCustomer, contact_person: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder={t('crm.form.contactPerson', 'Contact name')}
                  />
                </FloatingField>
              </SapRow>
              <SapRow>
                <FloatingField label={t('crm.form.email', 'Email')} span={6} filled={!!newCustomer.email}>
                  <input name="email" aria-label={t('crm.form.email', 'Email')}
                    type="text"
                    value={newCustomer.email}
                    onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="email@example.com"
                  />
                </FloatingField>
                <FloatingField label={t('crm.form.phone', 'Phone')} span={6} filled={!!newCustomer.phone}>
                  <input name="phone" aria-label={t('crm.form.phone', 'Phone')}
                    type="tel"
                    value={newCustomer.phone}
                    onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="+62 xxx"
                  />
                </FloatingField>
              </SapRow>
              <SapRow>
                <FloatingField label={t('crm.form.country', 'Country')} span={6} filled={!!newCustomer.country}>
                  <input name="country" aria-label={t('crm.form.country', 'Country')}
                    type="text"
                    value={newCustomer.country}
                    onChange={(e) => setNewCustomer({ ...newCustomer, country: e.target.value })}
                    className={FLOAT_INPUT}
                    placeholder="Indonesia"
                  />
                </FloatingField>
                <FloatingField label={t('crm.form.address', 'Address')} textarea span={6} filled={!!newCustomer.address}>
                  <textarea name="address" aria-label={t('crm.form.address', 'Address')}
                    value={newCustomer.address}
                    onChange={(e) => setNewCustomer({ ...newCustomer, address: e.target.value })}
                    rows={2}
                    className={FLOAT_TEXTAREA}
                    placeholder={t('crm.form.address', 'Full address')}
                  />
                </FloatingField>
              </SapRow>
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button
                type="button"
                onClick={() => setShowAddCustomerModal(false)}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition min-h-[38px]"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={handleAddCustomer}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition min-h-[38px] font-medium"
              >
                {t('crm.form.saveCustomer', 'Save Customer')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
