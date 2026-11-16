import { useEffect, useState, useRef } from 'react';
import { supabase } from '../../../lib/supabase';
import {
  Search,
  X,
  FileText,
  User,
  Building,
  Package,
  Mail,
  MessageSquare,
  ShoppingCart,
  Paperclip,
  Clock,
  ArrowRight,
} from 'lucide-react';

export interface SearchResultItem {
  id: string;
  type: 'inquiry' | 'customer' | 'product' | 'email' | 'whatsapp' | 'document' | 'order';
  title: string;
  subtitle: string;
  badge?: string;
  inquiryId?: string;
  customerId?: string;
  storagePath?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectInquiry: (inquiryId: string) => void;
  onSelectCustomer: (customerId: string) => void;
  onSelectCommunication?: (comm: { inquiryId?: string; customerId?: string }) => void;
}

export function CrmGlobalSearchModal({
  isOpen,
  onClose,
  onSelectInquiry,
  onSelectCustomer,
  onSelectCommunication,
}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery('');
      setResults([]);
    }
  }, [isOpen]);

  // Global hotkey within CRM
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        // Prevent browser default if inside CRM
      }
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      const pattern = `%${term}%`;
      const found: SearchResultItem[] = [];

      try {
        const [inqRes, custRes, msgRes, docRes, soRes] = await Promise.all([
          // Inquiries
          supabase
            .from('crm_inquiries')
            .select('id, inquiry_number, company_name, product_name, status, pipeline_status')
            .or(`inquiry_number.ilike.${pattern},company_name.ilike.${pattern},product_name.ilike.${pattern}`)
            .limit(6),

          // Customers / Contacts
          supabase
            .from('crm_contacts')
            .select('id, company_name, contact_person, email, city')
            .eq('is_active', true)
            .or(`company_name.ilike.${pattern},contact_person.ilike.${pattern},email.ilike.${pattern}`)
            .limit(6),

          // Communications (Email / WhatsApp)
          supabase
            .from('enquiry_conversation_messages')
            .select('id, channel, sender_name, sender_address, subject, body_text, conversation_id')
            .or(`subject.ilike.${pattern},body_text.ilike.${pattern},sender_name.ilike.${pattern},sender_address.ilike.${pattern}`)
            .limit(5),

          // Documents
          supabase
            .from('crm_product_documents')
            .select('id, display_file_name, original_file_name, document_type, inquiry_id, storage_path')
            .or(`display_file_name.ilike.${pattern},original_file_name.ilike.${pattern},document_type.ilike.${pattern}`)
            .limit(5),

          // Sales Orders
          supabase
            .from('sales_orders')
            .select('id, so_number, customer_id, total_amount, status')
            .ilike('so_number', pattern)
            .limit(4),
        ]);

        // 1. Inquiries
        (inqRes.data || []).forEach((i: any) => {
          found.push({
            id: i.id,
            type: 'inquiry',
            title: `${i.inquiry_number} — ${i.product_name}`,
            subtitle: i.company_name,
            badge: i.pipeline_status || i.status,
            inquiryId: i.id,
          });
        });

        // 2. Customers
        (custRes.data || []).forEach((c: any) => {
          found.push({
            id: c.id,
            type: 'customer',
            title: c.company_name,
            subtitle: [c.contact_person, c.email, c.city].filter(Boolean).join(' • '),
            customerId: c.id,
          });
        });

        // 3. Communications
        (msgRes.data || []).forEach((m: any) => {
          found.push({
            id: m.id,
            type: m.channel === 'whatsapp' ? 'whatsapp' : 'email',
            title: m.subject || (m.channel === 'whatsapp' ? 'WhatsApp Message' : 'Email Message'),
            subtitle: `${m.sender_name || m.sender_address || 'Sender'}: ${(m.body_text || '').slice(0, 70)}...`,
            badge: m.channel?.toUpperCase(),
          });
        });

        // 4. Documents
        (docRes.data || []).forEach((d: any) => {
          found.push({
            id: d.id,
            type: 'document',
            title: d.display_file_name || d.original_file_name || 'Document',
            subtitle: `Type: ${d.document_type || 'Document'}`,
            badge: d.document_type,
            inquiryId: d.inquiry_id,
            storagePath: d.storage_path,
          });
        });

        // 5. Orders
        (soRes.data || []).forEach((so: any) => {
          found.push({
            id: so.id,
            type: 'order',
            title: `Order: ${so.so_number}`,
            subtitle: `Status: ${so.status} • Total: IDR ${Number(so.total_amount || 0).toLocaleString()}`,
            badge: so.status,
            customerId: so.customer_id,
          });
        });

        setResults(found);
      } catch (err) {
        console.error('CRM Global search error:', err);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  const handleSelectResult = (item: SearchResultItem) => {
    onClose();
    if (item.type === 'inquiry' && item.inquiryId) {
      onSelectInquiry(item.inquiryId);
    } else if (item.type === 'customer' && item.customerId) {
      onSelectCustomer(item.customerId);
    } else if (item.type === 'document' && item.inquiryId) {
      onSelectInquiry(item.inquiryId);
    } else if (item.type === 'email' || item.type === 'whatsapp') {
      onSelectCommunication?.({ inquiryId: item.inquiryId, customerId: item.customerId });
    } else if (item.type === 'order' && item.customerId) {
      onSelectCustomer(item.customerId);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/40 backdrop-blur-sm flex items-start justify-center pt-20 px-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl border border-gray-200 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        
        {/* Search Input Bar */}
        <div className="relative border-b border-gray-200 p-4 flex items-center gap-3">
          <Search className="w-5 h-5 text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Inquiries, Customers, Products, Emails, WhatsApp, Documents..."
            className="w-full text-sm outline-none text-gray-900 placeholder-gray-400 bg-transparent font-medium"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="p-1 text-gray-400 hover:text-gray-600 rounded"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <kbd className="hidden sm:inline-block px-2 py-0.5 text-[10px] font-semibold text-gray-400 bg-gray-100 rounded border border-gray-200">
            ESC
          </kbd>
        </div>

        {/* Results List */}
        <div className="max-h-96 overflow-y-auto p-2 divide-y divide-gray-50">
          {loading ? (
            <div className="py-10 text-center text-xs text-gray-400 flex items-center justify-center gap-2">
              <Clock className="w-4 h-4 animate-spin text-blue-600" />
              Searching CRM records...
            </div>
          ) : query.trim().length >= 2 && results.length === 0 ? (
            <div className="py-10 text-center text-xs text-gray-400">
              No matching CRM records found for "{query}".
            </div>
          ) : query.trim().length < 2 ? (
            <div className="py-6 px-4 text-center text-xs text-gray-400">
              Type at least 2 characters to search across inquiries, customer profiles, emails, WhatsApp messages, and documents.
            </div>
          ) : (
            results.map((res) => {
              let Icon = FileText;
              let iconBg = 'bg-blue-50 text-blue-600';

              if (res.type === 'customer') {
                Icon = Building;
                iconBg = 'bg-emerald-50 text-emerald-600';
              } else if (res.type === 'email') {
                Icon = Mail;
                iconBg = 'bg-indigo-50 text-indigo-600';
              } else if (res.type === 'whatsapp') {
                Icon = MessageSquare;
                iconBg = 'bg-emerald-50 text-emerald-600';
              } else if (res.type === 'document') {
                Icon = Paperclip;
                iconBg = 'bg-purple-50 text-purple-600';
              } else if (res.type === 'order') {
                Icon = ShoppingCart;
                iconBg = 'bg-amber-50 text-amber-600';
              }

              return (
                <div
                  key={`${res.type}-${res.id}`}
                  onClick={() => handleSelectResult(res)}
                  className="p-3 hover:bg-blue-50/70 rounded-lg cursor-pointer transition flex items-center justify-between gap-3 group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs text-gray-900 truncate">
                          {res.title}
                        </span>
                        {res.badge && (
                          <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-gray-100 text-gray-600">
                            {res.badge}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-500 truncate mt-0.5">
                        {res.subtitle}
                      </div>
                    </div>
                  </div>

                  <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-blue-600 transition shrink-0" />
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="bg-slate-50 border-t border-gray-200 px-4 py-2 flex items-center justify-between text-[11px] text-gray-400">
          <span>Search inquiries, customers, messages, documents & orders</span>
          <span>Press ESC to close</span>
        </div>
      </div>
    </div>
  );
}
