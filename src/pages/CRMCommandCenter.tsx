import { useState } from 'react';
import { Layout } from '../components/Layout';
import { EmailListPanel } from '../components/commandCenter/EmailListPanel';
import { InquiryFormPanel, InquiryFormData } from '../components/commandCenter/InquiryFormPanel';
import { QuickActionsPanel } from '../components/commandCenter/QuickActionsPanel';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import type { Email, ParsedEmailData, Inquiry } from '../types/commandCenter';
import { CheckCircle2, Zap } from 'lucide-react';

function parseDeliveryDate(dateStr: string | undefined | null): string | null {
  if (!dateStr) return null;

  const trimmed = dateStr.trim();
  if (!trimmed) return null;

  // Already in YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // Handle DD.MM.YY format (e.g., "03.04.26" -> "2026-04-03")
  const ddmmyyDot = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (ddmmyyDot) {
    const day = ddmmyyDot[1].padStart(2, '0');
    const month = ddmmyyDot[2].padStart(2, '0');
    const year = parseInt(ddmmyyDot[3]) < 50 ? `20${ddmmyyDot[3]}` : `19${ddmmyyDot[3]}`;
    return `${year}-${month}-${day}`;
  }

  // Handle DD/MM/YY format
  const ddmmyySlash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (ddmmyySlash) {
    const day = ddmmyySlash[1].padStart(2, '0');
    const month = ddmmyySlash[2].padStart(2, '0');
    const year = parseInt(ddmmyySlash[3]) < 50 ? `20${ddmmyySlash[3]}` : `19${ddmmyySlash[3]}`;
    return `${year}-${month}-${day}`;
  }

  // Handle DD/MM/YYYY format
  const ddmmyyyySlash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyySlash) {
    const day = ddmmyyyySlash[1].padStart(2, '0');
    const month = ddmmyyyySlash[2].padStart(2, '0');
    const year = ddmmyyyySlash[3];
    return `${year}-${month}-${day}`;
  }

  // Handle DD-MM-YYYY format
  const ddmmyyyyDash = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyyDash) {
    const day = ddmmyyyyDash[1].padStart(2, '0');
    const month = ddmmyyyyDash[2].padStart(2, '0');
    const year = ddmmyyyyDash[3];
    return `${year}-${month}-${day}`;
  }

  // Try parsing as ISO date
  try {
    const date = new Date(trimmed);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  } catch {
    return null;
  }

  return null;
}

export function CRMCommandCenter() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [parsedData, setParsedData] = useState<ParsedEmailData | null>(null);
  const [createdInquiry, setCreatedInquiry] = useState<Inquiry | null>(null);
  const [saving, setSaving] = useState(false);

  const handleEmailSelect = (email: Email, data: ParsedEmailData | null) => {
    setSelectedEmail(email);
    setParsedData(data);
    setCreatedInquiry(null);
  };

  const handleSave = async (formData: InquiryFormData) => {
    if (!selectedEmail || !profile) return;

    setSaving(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Check if customer exists by email or company name
      let customerId = null;
      // Use only the first email address for lookup if multiple emails provided
      const primaryEmail = formData.contactEmail.split(/[,;]/)[0].trim();

      const { data: existingCustomers, error: lookupError } = await supabase
        .from('crm_contacts')
        .select('id, company_name, email, contact_person, phone, address')
        .or(`email.eq.${primaryEmail},company_name.ilike.${formData.companyName}`)
        .limit(1)
        .maybeSingle();

      if (lookupError) {
        console.error('[CRMCommandCenter] Customer lookup error:', lookupError);
        throw lookupError;
      }

      if (existingCustomers) {
        customerId = existingCustomers.id;

        // Update customer info if we have new data
        const updates: Record<string, string> = {};
        if (formData.contactPerson && !existingCustomers.contact_person) {
          updates.contact_person = formData.contactPerson;
        }
        if (formData.contactPhone && !existingCustomers.phone) {
          updates.phone = formData.contactPhone;
        }
        if (formData.contactEmail && formData.contactEmail !== existingCustomers.email) {
          updates.email = formData.contactEmail;
        }

        if (Object.keys(updates).length > 0) {
          await supabase
            .from('crm_contacts')
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq('id', customerId);
        }
      } else {
        // Create new customer
        const { data: newCustomer, error: customerError } = await supabase
          .from('crm_contacts')
          .insert({
            company_name: formData.companyName,
            contact_person: formData.contactPerson || null,
            email: formData.contactEmail,
            phone: formData.contactPhone || null,
            is_active: true,
            created_by: user.id,
          })
          .select()
          .single();

        if (customerError) {
          console.error('[CRMCommandCenter] Customer creation error:', customerError);
          throw new Error(`Failed to create customer: ${customerError.message}`);
        }

        if (newCustomer) {
          customerId = newCustomer.id;
        }
      }

      if (!customerId) {
        throw new Error('Failed to get or create customer ID');
      }

      const inquiryData = {
        // customerId here is a crm_contacts row (see lookup / insert above),
        // so it belongs in crm_contact_id — not customer_id (which is the
        // ERP customers FK, populated only after ERP promotion).
        crm_contact_id: customerId,
        inquiry_date: new Date().toISOString().split('T')[0],
        product_name: formData.productName,
        specification: formData.specification || null,
        quantity: formData.quantity,
        supplier_name: formData.supplierName || null,
        supplier_country: formData.supplierCountry || null,
        company_name: formData.companyName,
        contact_person: formData.contactPerson || null,
        contact_email: formData.contactEmail,
        contact_phone: formData.contactPhone || null,
        mail_subject: selectedEmail.subject,
        email_body: selectedEmail.body,
        inquiry_source: 'email',
        status: 'new',
        pipeline_status: 'new',
        priority: formData.priority,
        purpose_icons: formData.purposeIcons,
        delivery_date_expected: parseDeliveryDate(formData.deliveryDateExpected),
        ai_confidence_score: parsedData?.confidenceScore || 0.0,
        auto_detected_company: parsedData?.autoDetectedCompany || false,
        auto_detected_contact: parsedData?.autoDetectedContact || false,
        coa_sent: false,
        msds_sent: false,
        sample_sent: false,
        price_quoted: false,
        // New fields for unified tracking
        price_required: formData.priceRequested,
        coa_required: formData.coaRequested,
        sample_required: formData.sampleRequested,
        agency_letter_required: formData.agencyLetterRequested || false,
        aceerp_no: formData.aceerp_no || null,
        purchase_price: formData.purchasePrice ? parseFloat(formData.purchasePrice) : null,
        purchase_price_currency: formData.purchasePriceCurrency || 'USD',
        offered_price: formData.offeredPrice ? parseFloat(formData.offeredPrice) : null,
        offered_price_currency: formData.offeredPriceCurrency || 'USD',
        delivery_date: formData.deliveryDate || null,
        delivery_terms: formData.deliveryTerms || null,
        remarks: formData.remarks || null,
        assigned_to: user.id,
        created_by: user.id,
        source: 'email',
        source_email_id: selectedEmail.id.startsWith('gmail-') ? null : selectedEmail.id,
      };

      // If multi-product, create N separate inquiries in crm_inquiries with .1, .2, .3 suffixes
      // All common fields are copied to each inquiry
      let inquiry: Inquiry | null = null;

      if (formData.isMultiProduct && formData.products && formData.products.length > 0) {
        const inquiriesToInsert = formData.products.map((product) => ({
          ...inquiryData,
          product_name: product.productName,
          specification: product.specification || null,
          quantity: product.quantity,
          supplier_name: product.supplierName || inquiryData.supplier_name || null,
          supplier_country: product.supplierCountry || inquiryData.supplier_country || null,
          delivery_date: product.deliveryDate || inquiryData.delivery_date || null,
          delivery_terms: product.deliveryTerms || inquiryData.delivery_terms || null,
          is_multi_product: false,
          has_items: false,
        }));

        const { data: inquiries, error: inquiryError } = await supabase
          .from('crm_inquiries')
          .insert(inquiriesToInsert)
          .select();

        if (inquiryError) {
          console.error('[CRMCommandCenter] Multi-product insert error:', inquiryError);
          throw inquiryError;
        }

        // Update inquiry numbers to add .1, .2, .3 suffixes
        if (inquiries && inquiries.length > 0) {
          const baseInquiryNumber = inquiries[0].inquiry_number;

          for (let i = 0; i < inquiries.length; i++) {
            await supabase
              .from('crm_inquiries')
              .update({ inquiry_number: `${baseInquiryNumber}.${i + 1}` })
              .eq('id', inquiries[i].id);
          }

          inquiry = inquiries[0];
        }
      } else {
        // Single product inquiry
        const { data: singleInquiry, error: inquiryError } = await supabase
          .from('crm_inquiries')
          .insert([{
            ...inquiryData,
            is_multi_product: false,
            has_items: false,
          }])
          .select()
          .single();

        if (inquiryError) {
          console.error('[CRMCommandCenter] Single product insert error:', inquiryError);
          throw inquiryError;
        }
        inquiry = singleInquiry;
      }

      if (!inquiry) {
        throw new Error('Inquiry creation returned no record');
      }

      await supabase
        .from('crm_email_inbox')
        .update({
          is_processed: true,
          is_inquiry: true,
          converted_to_inquiry: inquiry.id,
        })
        .eq('id', selectedEmail.id);

      if (formData.coaRequested || formData.msdsRequested || formData.sampleRequested || formData.priceRequested || formData.agencyLetterRequested) {
        const reminders = [];

        if (formData.priceRequested) {
          reminders.push({
            inquiry_id: inquiry.id,
            reminder_type: 'send_price',
            title: 'Send price quote to customer',
            due_date: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (formData.coaRequested) {
          reminders.push({
            inquiry_id: inquiry.id,
            reminder_type: 'send_coa',
            title: 'Send COA to customer',
            due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (formData.msdsRequested) {
          reminders.push({
            inquiry_id: inquiry.id,
            reminder_type: 'send_msds',
            title: 'Send MSDS to customer',
            due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (formData.sampleRequested) {
          reminders.push({
            inquiry_id: inquiry.id,
            reminder_type: 'send_sample',
            title: 'Send sample to customer',
            due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (formData.agencyLetterRequested) {
          reminders.push({
            inquiry_id: inquiry.id,
            reminder_type: 'send_agency_letter',
            title: 'Send agency letter to customer',
            due_date: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(),
            assigned_to: user.id,
            created_by: user.id,
          });
        }

        if (reminders.length > 0) {
          await supabase.from('crm_reminders').insert(reminders);
        }
      }

      setCreatedInquiry(inquiry);
      setParsedData(null);

      const successMsg = formData.isMultiProduct && formData.products
        ? `Inquiry #${inquiry.inquiry_number} created successfully with ${formData.products.length} product line items!\n\nUse Quick Actions to send documents for each product.`
        : `Inquiry #${inquiry.inquiry_number} created successfully!\n\nUse Quick Actions to send documents.`;

      alert(successMsg);
    } catch (error: unknown) {
      console.error('[CRMCommandCenter] Error creating inquiry:', error);
      console.error('[CRMCommandCenter] Error details:', JSON.stringify(error, null, 2));
      const err = error as { message?: string; details?: string; hint?: string };
      if (err.message?.includes('duplicate key')) {
        alert('This inquiry number already exists. Please use a different number.');
      } else {
        const errorMsg = err.message || err.details || err.hint || 'Unknown error';
        alert(`Failed to create inquiry: ${errorMsg}\n\nCheck console for details.`);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleActionComplete = () => {
    setCreatedInquiry(null);
    setSelectedEmail(null);
    setParsedData(null);
  };

  return (
    <Layout>
      <div className="h-screen flex flex-col">
        <div className="flex-shrink-0 bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-2 border-b border-blue-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-white" />
              <div>
                <h1 className="text-lg font-bold text-white">{t('commandCenter.title')}</h1>
                <p className="text-blue-100 text-xs">{t('commandCenter.aiPowered')}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-blue-200">{t('commandCenter.quickActions')}</p>
              <p className="text-xl font-bold text-white">{t('commandCenter.twoClicks')}</p>
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col lg:flex-row lg:overflow-hidden min-w-0">
          <div className="w-full lg:w-1/4 lg:min-w-[240px] xl:min-w-[300px] lg:max-w-[400px] min-w-0">
            <EmailListPanel
              onEmailSelect={handleEmailSelect}
              selectedEmailId={selectedEmail?.id || null}
            />
          </div>

          <div className="flex-1 min-w-0">
            <InquiryFormPanel
              email={selectedEmail}
              parsedData={parsedData}
              onSave={handleSave}
              saving={saving}
            />
          </div>

          <div className="w-full lg:w-1/4 lg:min-w-[240px] xl:min-w-[300px] lg:max-w-[400px] min-w-0">
            <QuickActionsPanel
              inquiry={createdInquiry}
              onActionComplete={handleActionComplete}
            />
          </div>
        </div>

        {createdInquiry && (
          <div className="flex-shrink-0 bg-green-50 border-t border-green-200 px-6 py-3">
            <div className="flex items-center justify-center gap-2 text-green-800">
              <CheckCircle2 className="w-5 h-5" />
              <span className="font-medium">
                Inquiry #{createdInquiry.inquiry_number} {t('commandCenter.inquiryCreated')}
              </span>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
