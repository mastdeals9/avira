import { useRef, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../contexts/LanguageContext';
import { type CompanySnapshot } from '../types/company';
import { useResolvedCompanyLogo, waitForImages } from '../utils/companyLogoUrl';
import { SnapshotMissingError } from './SnapshotMissingError';
import { DocumentHeader } from './DocumentHeader';
import { DocumentPrintStyles } from './DocumentPrintStyles';
import { ResponsiveDocumentPreview } from './ui/ResponsiveDocumentPreview';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { formatUnit } from '../utils/unitDisplay';

interface InvoiceItem {
  id?: string;
  product_id: string;
  batch_id: string | null;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  tax_amount?: number;
  line_total?: number;
  dc_number?: string;
  total?: number;
  products?: {
    product_name: string;
    product_code: string;
    unit: string;
  };
  batches?: {
    batch_number: string;
    expiry_date: string | null;
    product_sources?: { supplier_name: string | null; grade: string | null } | null;
  } | null;
}

interface InvoiceViewProps {
  invoice: {
    id: string;
    invoice_number: string;
    customer_id: string;
    invoice_date: string;
    due_date: string;
    subtotal: number;
    tax_amount: number;
    stamp_duty_amount?: number | null;
    discount_amount: number;
    total_amount: number;
    payment_status: 'pending' | 'partial' | 'paid';
    delivery_challan_number: string | null;
    notes: string | null;
    po_number?: string | null;
    payment_terms_days?: number | null;
    company_snapshot?: CompanySnapshot | null;
    customers?: {
      company_name: string;
      address: string;
      city: string;
      phone: string;
      npwp: string;
      pharmacy_license: string;
      gst_vat_type: string;
    };
  };
  items: InvoiceItem[];
  onClose: () => void;
  companyProfile?: CompanySnapshot | null;
}

export function InvoiceView({ invoice, items, onClose, companyProfile }: InvoiceViewProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const { t, language } = useLanguage();
  const companySnapshot = companyProfile ?? invoice.company_snapshot;
  const { ready: logoReady } = useResolvedCompanyLogo(companySnapshot?.company_logo_url);

  const [traceability, setTraceability] = useState<{
    fakturPajakNumber: string | null;
    materialReturns: Array<{ id: string; return_number: string; status: string; return_date: string }>;
    creditNotes: Array<{ id: string; credit_note_number: string; status: string; total_amount: number }>;
    notaReturs: Array<{ id: string; nota_retur_number: string; status: string; total_amount: number; coretax_status: string | null }>;
  }>({
    fakturPajakNumber: null,
    materialReturns: [],
    creditNotes: [],
    notaReturs: [],
  });

  useEffect(() => {
    if (!invoice?.id) return;
    async function loadTraceability() {
      try {
        const [invRes, mrRes, cnRes, nrRes] = await Promise.all([
          supabase.from('sales_invoices').select('faktur_pajak_number').eq('id', invoice.id).maybeSingle(),
          supabase.from('material_returns').select('id, return_number, status, return_date').eq('original_invoice_id', invoice.id),
          supabase.from('credit_notes').select('id, credit_note_number, status, total_amount').eq('original_invoice_id', invoice.id),
          supabase.from('nota_retur').select('id, nota_retur_number, status, total_amount, coretax_status').eq('sales_invoice_id', invoice.id),
        ]);

        setTraceability({
          fakturPajakNumber: invRes.data?.faktur_pajak_number || null,
          materialReturns: (mrRes.data as any[]) || [],
          creditNotes: (cnRes.data as any[]) || [],
          notaReturs: (nrRes.data as any[]) || [],
        });
      } catch (e) {
        console.error('Failed to load invoice traceability:', e);
      }
    }
    void loadTraceability();
  }, [invoice?.id]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Refuse to render with FALLBACK_COMPANY — misprinting a customer
  // invoice with placeholder company header would misrepresent the
  // legal document. Backfill migration 20260714210000 restores NULL
  // snapshots in bulk; one-off legacy rows must be repaired manually.
  if (!companySnapshot) {
    return (
      <SnapshotMissingError
        documentType="Sales Invoice"
        documentNumber={invoice.invoice_number}
        onClose={onClose}
      />
    );
  }
  const co = companySnapshot;

  const formatCurrency = (amount: number | undefined | null) => {
    if (amount === undefined || amount === null) return 'Rp 0,00';
    // Always show 2 decimal places in Indonesian format (Rp 136.125.000,00)
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const months = language === 'id'
      ? ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des']
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();

    return `${day} ${month} ${year}`;
  };

  const formatExpiryDate = (dateString: string) => {
    const date = new Date(dateString);
    const months = language === 'id'
      ? ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des']
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const month = months[date.getMonth()];
    const year = date.getFullYear();

    return `${month} ${year}`;
  };

  const numberToWords = (num: number): string => {
    if (language === 'id') {
      return numberToWordsIndonesian(num);
    } else {
      return numberToWordsEnglish(num);
    }
  };

  const numberToWordsIndonesian = (num: number): string => {
    if (num === 0) return 'Nol';

    const ones = ['', 'Satu', 'Dua', 'Tiga', 'Empat', 'Lima', 'Enam', 'Tujuh', 'Delapan', 'Sembilan'];
    const teens = ['Sepuluh', 'Sebelas', 'Dua Belas', 'Tiga Belas', 'Empat Belas', 'Lima Belas', 'Enam Belas', 'Tujuh Belas', 'Delapan Belas', 'Sembilan Belas'];
    const tens = ['', '', 'Dua Puluh', 'Tiga Puluh', 'Empat Puluh', 'Lima Puluh', 'Enam Puluh', 'Tujuh Puluh', 'Delapan Puluh', 'Sembilan Puluh'];

    const convertLessThanThousand = (n: number): string => {
      if (n === 0) return '';
      if (n < 10) return ones[n];
      if (n >= 10 && n < 20) return teens[n - 10];
      if (n < 100) {
        const ten = Math.floor(n / 10);
        const one = n % 10;
        return tens[ten] + (one > 0 ? ' ' + ones[one] : '');
      }
      const hundred = Math.floor(n / 100);
      const rest = n % 100;
      const hundredWord = hundred === 1 ? 'Seratus' : ones[hundred] + ' Ratus';
      return hundredWord + (rest > 0 ? ' ' + convertLessThanThousand(rest) : '');
    };

    if (num < 1000) return convertLessThanThousand(num);
    if (num < 1000000) {
      const thousands = Math.floor(num / 1000);
      const rest = num % 1000;
      const thousandWord = thousands === 1 ? 'Seribu' : convertLessThanThousand(thousands) + ' Ribu';
      return thousandWord + (rest > 0 ? ' ' + convertLessThanThousand(rest) : '');
    }
    if (num < 1000000000) {
      const millions = Math.floor(num / 1000000);
      const rest = num % 1000000;
      const millionWord = convertLessThanThousand(millions) + ' Juta';
      const restWord = rest >= 1000
        ? (Math.floor(rest / 1000) === 1 ? 'Seribu' : convertLessThanThousand(Math.floor(rest / 1000)) + ' Ribu') + (rest % 1000 > 0 ? ' ' + convertLessThanThousand(rest % 1000) : '')
        : (rest > 0 ? convertLessThanThousand(rest) : '');
      return millionWord + (restWord ? ' ' + restWord : '');
    }
    return num.toString();
  };

  const numberToWordsEnglish = (num: number): string => {
    if (num === 0) return 'Zero';

    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    const convertLessThanThousand = (n: number): string => {
      if (n === 0) return '';
      if (n < 10) return ones[n];
      if (n >= 10 && n < 20) return teens[n - 10];
      if (n < 100) {
        const ten = Math.floor(n / 10);
        const one = n % 10;
        return tens[ten] + (one > 0 ? ' ' + ones[one] : '');
      }
      const hundred = Math.floor(n / 100);
      const rest = n % 100;
      return ones[hundred] + ' Hundred' + (rest > 0 ? ' ' + convertLessThanThousand(rest) : '');
    };

    if (num < 1000) return convertLessThanThousand(num);
    if (num < 1000000) {
      const thousands = Math.floor(num / 1000);
      const rest = num % 1000;
      return convertLessThanThousand(thousands) + ' Thousand' + (rest > 0 ? ' ' + convertLessThanThousand(rest) : '');
    }
    if (num < 1000000000) {
      const millions = Math.floor(num / 1000000);
      const rest = num % 1000000;
      const restWord = rest >= 1000
        ? convertLessThanThousand(Math.floor(rest / 1000)) + ' Thousand' + (rest % 1000 > 0 ? ' ' + convertLessThanThousand(rest % 1000) : '')
        : (rest > 0 ? convertLessThanThousand(rest) : '');
      return convertLessThanThousand(millions) + ' Million' + (restWord ? ' ' + restWord : '');
    }
    return num.toString();
  };

  const handlePrint = async () => {
    if (printRef.current) await waitForImages(printRef.current);
    window.print();
  };

  const handleDownloadPDF = async () => {
    if (!printRef.current) return;
    await waitForImages(printRef.current);

    try {
      const canvas = await html2canvas(printRef.current, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: printRef.current.scrollWidth,
        windowHeight: printRef.current.scrollHeight,
        onclone: (clonedDoc) => {
          const clonedElement = clonedDoc.getElementById('invoice-print-content');
          if (clonedElement) {
            clonedElement.style.width = '210mm';
          }
        }
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.85);
      const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true });

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
          pdf.addImage(imgData, 'JPEG', 0, position, pdfWidth, scaledHeight);
          remainingHeight -= pdfHeight;
          position -= pdfHeight;

          if (remainingHeight > 0) {
            pdf.addPage();
          }
        }
      } else {
        pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, scaledHeight);
      }

      pdf.save(`Invoice-${invoice.invoice_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const customer = invoice.customers;
  const paymentTermsDays = invoice.payment_terms_days || 30;

  const isCancelled = Boolean(
    invoice.notes?.includes('[CANCELLED') ||
    invoice.notes?.toLowerCase().startsWith('cancelled')
  );

  const cancellationDateMatch = invoice.notes?.match(/\[CANCELLED on ([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
  const cancellationDate = cancellationDateMatch ? cancellationDateMatch[1] : null;
  const cancellationUserMatch = invoice.notes?.match(/\[CANCELLED on [0-9]{4}-[0-9]{2}-[0-9]{2} by ([^\]]+)\]/i);
  const cancellationActor = cancellationUserMatch ? cancellationUserMatch[1] : null;
  const cancellationNoteLine = isCancelled ? invoice.notes?.split('\n')[0] : null;

  const getPaymentTermsText = () => {
    if (paymentTermsDays === 0) {
      return language === 'id' ? 'Advance / Immediate' : 'Advance / Immediate';
    }
    return `${paymentTermsDays} ${language === 'id' ? 'Hari' : 'Days'}`;
  };

  return (
    <>
      <ResponsiveDocumentPreview
        title={`${language === 'id' ? 'Faktur' : 'Invoice'} ${invoice.invoice_number}`}
        badge={
          isCancelled ? (
            <span className="px-2 py-0.5 rounded text-[10px] sm:text-xs font-bold uppercase bg-red-100 text-red-700 border border-red-300">
              CANCELLED
            </span>
          ) : undefined
        }
        onPrint={handlePrint}
        onDownloadPDF={handleDownloadPDF}
        onClose={onClose}
        disabled={!logoReady}
        disabledTitle="Loading company logo…"
        printLabel={language === 'id' ? 'Cetak' : 'Print'}
        pdfLabel="PDF"
      >
        {/* Invoice Content */}
        <div id="invoice-print-content" ref={printRef} className="p-4 sm:p-8 relative overflow-hidden">
            {/* Prominent Diagonal CANCELLED Watermark */}
            {isCancelled && (
              <div
                className="pointer-events-none absolute inset-0 flex items-center justify-center select-none z-10"
                style={{ overflow: 'hidden' }}
                aria-hidden="true"
              >
                <div
                  className="border-8 border-red-500 text-red-500 font-extrabold tracking-widest uppercase rounded-3xl p-8 select-none print:border-red-600 print:text-red-600"
                  style={{
                    fontSize: '7rem',
                    lineHeight: '1',
                    opacity: 0.16,
                    letterSpacing: '0.25em',
                    transform: 'rotate(-30deg)',
                    WebkitPrintColorAdjust: 'exact',
                    printColorAdjust: 'exact',
                  }}
                >
                  CANCELLED
                </div>
              </div>
            )}

            {/* Prominent Cancellation Banner */}
            {isCancelled && (
              <div
                className="mb-3 p-3 bg-red-50 border-2 border-red-500 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-red-900 print:mb-2 print:p-2 print:border-red-600 print:bg-red-50"
                style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' }}
              >
                <div className="flex items-center gap-2.5">
                  <span className="px-2.5 py-1 bg-red-600 text-white font-bold text-xs rounded tracking-wider uppercase shrink-0">
                    VOID / CANCELLED
                  </span>
                  <div className="text-xs">
                    <span className="font-bold">INVOICE CANCELLED & VOID</span>
                    {cancellationDate && (
                      <span className="ml-1.5 font-medium text-red-800">
                        ({formatDate(cancellationDate)}{cancellationActor ? ` by ${cancellationActor}` : ''})
                      </span>
                    )}
                    <p className="text-[11px] text-red-600 mt-0.5">
                      Accounting journals reversed. Not valid for commercial payment or tax deduction.
                    </p>
                  </div>
                </div>
                {cancellationNoteLine && (
                  <div className="text-right text-[11px] font-mono text-red-700 shrink-0">
                    {cancellationNoteLine}
                  </div>
                )}
              </div>
            )}

            {/* Header Section - Your Company Details */}
            <DocumentHeader co={co} title={language === 'id' ? 'INVOICE' : 'INVOICE'} />

            {/* Customer and Invoice Details */}
            <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2">
              <div className="flex justify-between">
                {/* Left - Customer Details */}
                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 flex-1">
                  <div>
                    <span className="font-bold">{language === 'id' ? 'Company Name:' : 'Company Name:'}</span>
                    <span className="font-semibold"> {customer?.company_name || ''}</span>
                  </div>

                  <div className="pt-1 flex">
                    <span className="font-bold" style={{minWidth: '72px'}}>{language === 'id' ? 'Address:' : 'Address:'}</span>
                    <div>
                      <p>{customer?.address || ''}</p>
                      <p>{customer?.city || ''}</p>
                    </div>
                  </div>
                  <div className="flex pt-1">
                    <span className="font-bold" style={{minWidth: '72px'}}>{language === 'id' ? 'Phone:' : 'Phone:'}</span>
                    <span>{customer?.phone || ''}</span>
                  </div>
                  <div className="flex">
                    <span className="font-bold" style={{minWidth: '72px'}}>NPWP:</span>
                    <span>{customer?.npwp || ''}</span>
                  </div>
                </div>

                {/* Right - Invoice Details */}
                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 text-right" style={{minWidth: '200px'}}>
                  <div>
                    <span className="font-bold">{language === 'id' ? 'Invoice No:' : 'Invoice No:'}</span>
                    <span className="ml-2">{invoice.invoice_number}</span>
                  </div>
                  <div>
                    <span className="font-bold">{language === 'id' ? 'Invoice Date:' : 'Invoice Date:'}</span>
                    <span className="ml-2">{formatDate(invoice.invoice_date)}</span>
                  </div>
                  <div className="pt-1">
                    <span className="font-bold">Po No:</span>
                    <span className="ml-2">{invoice.po_number || 'N/A'}</span>
                  </div>
                  <div>
                    <span className="font-bold">{language === 'id' ? 'Payment Terms:' : 'Payment Terms:'}</span>
                    <span className="ml-2">{getPaymentTermsText()}</span>
                  </div>
                  {isCancelled && (
                    <div className="pt-1 text-red-600 font-bold">
                      <span>Status:</span>
                      <span className="ml-2 uppercase tracking-wide">Cancelled</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Items Table */}
            <div>
              <table className="w-full border-2 border-black text-xs print:text-[10px]">
                <thead>
                  <tr className="border-b-2 border-black bg-white">
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">No.</th>
                    <th className="border-r border-black p-1.5 text-left font-bold print:p-1">{language === 'id' ? 'Product Name' : 'Product Name'}</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Batch No.</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">{language === 'id' ? 'Exp. Date' : 'Exp. Date'}</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">{language === 'id' ? 'Total Qty' : 'Total Qty'}</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">UOM</th>
                    <th className="border-r border-black p-1.5 text-right font-bold print:p-1">{language === 'id' ? 'Unit Price (IDR)' : 'Unit Price (IDR)'}</th>
                    <th className="p-1.5 text-right font-bold print:p-1">{language === 'id' ? 'Sub Total (IDR)' : 'Sub Total (IDR)'}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => {
                    const quantity = item.quantity || 0;
                    const unitPrice = item.unit_price || 0;
                    const itemSubtotal = quantity * unitPrice;
                    const expDate = item.batches?.expiry_date ? formatExpiryDate(item.batches.expiry_date) : '-';

                    return (
                      <tr key={item.id || index} className="border-b border-black">
                        <td className="border-r border-black p-1.5 text-center print:p-1">{index + 1}</td>
                        <td className="border-r border-black p-1.5 print:p-1">
                          <div>{item.products?.product_name || 'Unknown Product'}</div>
                          <div className="text-[10px] text-gray-600 print:text-[9px]">DC: {item.dc_number || '-'}</div>
                        </td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{item.batches?.batch_number || 'N/A'}<br/><span className="text-[9px] leading-tight">{item.batches?.product_sources?.supplier_name || 'Not recorded'}</span></td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{expDate}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{quantity.toLocaleString()}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{formatUnit(item.products?.unit)}</td>
                        <td className="border-r border-black p-1.5 text-right print:p-1">{formatCurrency(unitPrice)}</td>
                        <td className="p-1.5 text-right print:p-1">
                          {formatCurrency(itemSubtotal)}
                        </td>
                      </tr>
                    );
                  })}

                  {/* Empty rows for spacing */}
                  {items.length < 2 && Array.from({ length: 2 - items.length }).map((_, i) => (
                    <tr key={`empty-${i}`} className="border-b border-black">
                      <td className="border-r border-black p-1.5 text-center print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="p-1.5 print:p-1">&nbsp;</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Combined Section: Amount in Words + Totals + Bank Details + Signatures */}
            <div className="border-2 border-black border-t-0">
              {/* Top Row: Amount in Words + Totals */}
              <div className="flex items-stretch border-b-2 border-black">
                {/* Left - Amount in Words */}
                <div className="flex-1 p-2 border-r-2 border-black print:p-1.5">
                  <p className="text-xs font-bold print:text-[10px]">{language === 'id' ? 'Amount In words:' : 'Amount in words:'}</p>
                  <p className="text-xs mt-0.5 font-bold uppercase print:text-[10px] print:mt-0">
                    IDR {numberToWords(Math.round(invoice.total_amount))} RUPIAH
                  </p>
                </div>

                {/* Right - Totals */}
                <div className="w-80 text-xs p-2 print:text-[10px] print:p-1.5">
                  <div className="flex justify-between py-1 print:py-0.5">
                    <span className="font-bold">{language === 'id' ? 'Sub Total' : 'Sub Total'}</span>
                    <span className="font-bold">{formatCurrency(invoice.subtotal)}</span>
                  </div>
                  <div className="flex justify-between border-t border-black py-1 print:py-0.5">
                    <span className="font-bold">VAT (PPN) 11%</span>
                    <span className="font-bold">{formatCurrency(invoice.tax_amount)}</span>
                  </div>
                  {Number(invoice.discount_amount || 0) > 0 && (
                    <div className="flex justify-between border-t border-black py-1 print:py-0.5 text-red-600">
                      <span className="font-bold">{language === 'id' ? 'Diskon' : 'Discount'}</span>
                      <span className="font-bold">-{formatCurrency(invoice.discount_amount)}</span>
                    </div>
                  )}
                  {Number(invoice.stamp_duty_amount || 0) > 0 && (
                    <div className="flex justify-between border-t border-black py-1 print:py-0.5">
                      <span className="font-bold">Bea Meterai</span>
                      <span className="font-bold">{formatCurrency(invoice.stamp_duty_amount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between border-t-2 border-black py-1 print:py-0.5">
                    <span className="font-bold">{language === 'id' ? 'Grand Total' : 'Grand Total'}</span>
                    <span className="font-bold text-sm print:text-xs">{formatCurrency(invoice.total_amount)}</span>
                  </div>
                </div>
              </div>

              {/* Bottom Row: Bank Details + Authorized Signatory */}
              <div className="grid grid-cols-2 gap-0 text-xs print:text-[10px]">
                {/* Column 1 - Bank Details */}
                <div className="p-3 border-r-2 border-black print:p-2">
                  <p className="font-semibold mb-2 print:mb-1">{language === 'id' ? 'Bank Details:' : 'Bank Details:'}</p>
                  <div className="space-y-0.5 print:space-y-0">
                    <div className="flex">
                      <span className="font-semibold" style={{minWidth: '95px'}}>{language === 'id' ? 'Bank Name' : 'Bank Name'}</span>
                      <span className="mr-2">:</span>
                      <span>BCA</span>
                    </div>
                    <div className="flex">
                      <span className="font-semibold" style={{minWidth: '95px'}}>{language === 'id' ? 'Branch' : 'Branch'}</span>
                      <span className="mr-2">:</span>
                      <span>Sunter Mall, Jakarta</span>
                    </div>
                    <div className="flex">
                      <span className="font-semibold" style={{minWidth: '95px'}}>{language === 'id' ? 'Account Name' : 'Account Name'}</span>
                      <span className="mr-2">:</span>
                      <span className="whitespace-nowrap">{co.company_name}</span>
                    </div>
                    <div className="flex">
                      <span className="font-semibold" style={{minWidth: '95px'}}>{language === 'id' ? 'Account No.' : 'Account No.'}</span>
                      <span className="mr-2">:</span>
                      <span>0930 2010 14 (IDR)</span>
                    </div>
                  </div>
                </div>

                {/* Column 2 - Authorized Signatory */}
                <div className="p-3 print:p-2">
                  <p className="font-semibold mb-1">{language === 'id' ? 'Authorized Signatory:' : 'Authorized Signatory:'}</p>
                  <p className="font-semibold mb-10 print:mb-8">{co.company_name}</p>
                  <div className="w-4/5 border-t border-black pt-1">{language === 'id' ? 'Pharmacist' : 'Pharmacist'}</div>
                </div>
              </div>
            </div>

            {/* Payment Terms Notice */}
            <div className="border-2 border-black border-t-0 p-2.5 print:p-2">
              <p className="text-xs font-semibold text-center print:text-[10px]">
                {language === 'id'
                  ? `Pembayaran jatuh tempo dalam ${getPaymentTermsText()} sejak tanggal barang dikirim.`
                  : `Payment is due within ${getPaymentTermsText()} from the date on which the goods are delivered.`
                }
              </p>
            </div>

            {/* Additional Notes */}
            {invoice.notes && (
              <div className="mt-3 border-2 border-black p-2 print:mt-2 print:p-1.5">
                <p className="text-xs print:text-[10px]">
                  <span className="font-bold">{language === 'id' ? 'Notes: ' : 'Notes: '}</span>
                  <span>{invoice.notes}</span>
                </p>
              </div>
            )}
          </div>

          {/* COST ANALYSIS SECTION - NOT PRINTED */}
          <div className="mt-6 p-6 bg-blue-50 border-2 border-blue-200 rounded-lg print:hidden">
            <h3 className="text-lg font-bold text-blue-900 mb-4">Cost Analysis & Profitability (Internal Use Only)</h3>

            <div className="bg-white rounded-lg p-4 shadow-sm">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-semibold text-gray-700">Product</th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-gray-700">Qty</th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-gray-700">Selling Price</th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-gray-700">Revenue</th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-gray-700">COGS/Unit</th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-gray-700">Total COGS</th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-gray-700">Gross Profit</th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-gray-700">Margin %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {items.map((item, index) => {
                    const quantity = item.quantity || 0;
                    const unitPrice = item.unit_price || 0;
                    const revenue = quantity * unitPrice;

                    const cogs = 0;
                    const totalCogs = cogs * quantity;
                    const grossProfit = revenue - totalCogs;
                    const marginPercent = revenue > 0 ? (grossProfit / revenue) * 100 : 0;

                    return (
                      <tr key={index} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-900">
                          <div className="font-medium">{item.products?.product_name}</div>
                          {item.batches && (
                            <div className="text-xs text-gray-500">Batch: {item.batches.batch_number}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-right text-gray-900">{quantity}</td>
                        <td className="px-4 py-3 text-sm text-right text-gray-900">{formatCurrency(unitPrice)}</td>
                        <td className="px-4 py-3 text-sm text-right font-medium text-gray-900">{formatCurrency(revenue)}</td>
                        <td className="px-4 py-3 text-sm text-right text-gray-600">
                          <span className="text-orange-600 font-medium">{formatCurrency(cogs)}</span>
                        </td>
                        <td className="px-4 py-3 text-sm text-right font-medium text-orange-600">
                          {formatCurrency(totalCogs)}
                        </td>
                        <td className="px-4 py-3 text-sm text-right font-semibold text-green-600">
                          {formatCurrency(grossProfit)}
                        </td>
                        <td className="px-4 py-3 text-sm text-right">
                          <span className={`font-semibold ${marginPercent >= 20 ? 'text-green-600' : marginPercent >= 10 ? 'text-yellow-600' : 'text-red-600'}`}>
                            {marginPercent.toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                  <tr>
                    <td colSpan={3} className="px-4 py-3 text-sm font-bold text-gray-900 text-right">TOTALS:</td>
                    <td className="px-4 py-3 text-sm font-bold text-gray-900 text-right">
                      {formatCurrency(invoice.subtotal)}
                    </td>
                    <td></td>
                    <td className="px-4 py-3 text-sm font-bold text-orange-600 text-right">
                      {formatCurrency(0)}
                    </td>
                    <td className="px-4 py-3 text-sm font-bold text-green-600 text-right">
                      {formatCurrency(invoice.subtotal - 0)}
                    </td>
                    <td className="px-4 py-3 text-sm font-bold text-right">
                      <span className={`${(invoice.subtotal > 0 ? ((invoice.subtotal - 0) / invoice.subtotal * 100) : 0) >= 20 ? 'text-green-600' : 'text-yellow-600'}`}>
                        {(invoice.subtotal > 0 ? ((invoice.subtotal - 0) / invoice.subtotal * 100) : 0).toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                </tfoot>
              </table>

              <div className="mt-6 grid grid-cols-3 gap-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <div className="text-xs font-medium text-blue-700 mb-1">Total Revenue (excl. Tax)</div>
                  <div className="text-xl font-bold text-blue-900">{formatCurrency(invoice.subtotal)}</div>
                </div>
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
                  <div className="text-xs font-medium text-orange-700 mb-1">Total COGS</div>
                  <div className="text-xl font-bold text-orange-900">{formatCurrency(0)}</div>
                  <div className="text-xs text-orange-600 mt-1">Cost of goods sold</div>
                </div>
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="text-xs font-medium text-green-700 mb-1">Gross Profit</div>
                  <div className="text-xl font-bold text-green-900">{formatCurrency(invoice.subtotal - 0)}</div>
                  <div className="text-xs text-green-600 mt-1">
                    Margin: {(invoice.subtotal > 0 ? ((invoice.subtotal - 0) / invoice.subtotal * 100) : 0).toFixed(1)}%
                  </div>
                </div>
              </div>

              {/* Document Lifecycle & Return Traceability Flow */}
              <div className="mt-5 bg-slate-50 border border-slate-200 rounded-lg p-3.5">
                <div className="text-xs font-bold text-slate-800 uppercase tracking-wide mb-2.5 flex items-center justify-between">
                  <span>Document Lifecycle & Return Traceability</span>
                  <span className="text-[10px] text-slate-500 font-normal">Indonesian PPN / Coretax Compliance Chain</span>
                </div>

                <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-2 text-xs">
                  {/* Original Invoice */}
                  <div className="flex-1 bg-white border border-slate-300 rounded p-2 shadow-2xs">
                    <div className="text-[10px] text-slate-500 uppercase font-semibold">1. Original Invoice</div>
                    <div className="font-mono font-bold text-slate-900 mt-0.5">{invoice.invoice_number}</div>
                    <div className="text-[11px] text-slate-600 mt-0.5">{formatCurrency(invoice.total_amount)}</div>
                  </div>

                  <div className="text-slate-400 font-bold self-center">→</div>

                  {/* Faktur Pajak */}
                  <div className="flex-1 bg-white border border-slate-300 rounded p-2 shadow-2xs">
                    <div className="text-[10px] text-slate-500 uppercase font-semibold">2. Faktur Pajak</div>
                    <div className="font-mono font-bold text-slate-900 mt-0.5">
                      {traceability.fakturPajakNumber || 'Belum Terbit'}
                    </div>
                    <div className="text-[11px] text-slate-600 mt-0.5">PPN: {formatCurrency(invoice.tax_amount)}</div>
                  </div>

                  <div className="text-slate-400 font-bold self-center">→</div>

                  {/* Material Return */}
                  <div className="flex-1 bg-white border border-slate-300 rounded p-2 shadow-2xs">
                    <div className="text-[10px] text-slate-500 uppercase font-semibold">3. Material Return</div>
                    {traceability.materialReturns.length > 0 ? (
                      traceability.materialReturns.map(mr => (
                        <div key={mr.id} className="mt-0.5">
                          <span className="font-mono font-bold text-slate-900">{mr.return_number}</span>
                          <span className="ml-1 text-[10px] px-1 rounded bg-amber-100 text-amber-800 capitalize">{mr.status}</span>
                        </div>
                      ))
                    ) : (
                      <div className="text-slate-400 mt-0.5 italic text-[11px]">No return event</div>
                    )}
                  </div>

                  <div className="text-slate-400 font-bold self-center">→</div>

                  {/* Credit Note */}
                  <div className="flex-1 bg-white border border-slate-300 rounded p-2 shadow-2xs">
                    <div className="text-[10px] text-slate-500 uppercase font-semibold">4. Credit Note</div>
                    {traceability.creditNotes.length > 0 ? (
                      traceability.creditNotes.map(cn => (
                        <div key={cn.id} className="mt-0.5">
                          <span className="font-mono font-bold text-slate-900">{cn.credit_note_number}</span>
                          <div className="text-[11px] text-slate-600">{formatCurrency(cn.total_amount)}</div>
                        </div>
                      ))
                    ) : (
                      <div className="text-slate-400 mt-0.5 italic text-[11px]">No commercial CN</div>
                    )}
                  </div>

                  <div className="text-slate-400 font-bold self-center">→</div>

                  {/* Nota Retur */}
                  <div className="flex-1 bg-white border border-slate-300 rounded p-2 shadow-2xs">
                    <div className="text-[10px] text-slate-500 uppercase font-semibold">5. Nota Retur</div>
                    {traceability.notaReturs.length > 0 ? (
                      traceability.notaReturs.map(nr => (
                        <div key={nr.id} className="mt-0.5">
                          <span className="font-mono font-bold text-emerald-800">{nr.nota_retur_number}</span>
                          <div className="text-[10px] text-emerald-700">Coretax: {nr.coretax_status || nr.status}</div>
                        </div>
                      ))
                    ) : (
                      <div className="text-slate-400 mt-0.5 italic text-[11px]">No tax return doc</div>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <svg className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  <div className="text-xs text-yellow-800">
                    <p className="font-semibold">Note:</p>
                    <p className="mt-1">This cost analysis is for internal management use only. COGS data is pulled from batch landed costs (including import costs). This section will NOT appear when printing the invoice.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
      </ResponsiveDocumentPreview>

      <DocumentPrintStyles contentId="invoice-print-content" />
    </>
  );
}
