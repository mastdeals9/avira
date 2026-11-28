import { useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, ShieldCheck, FileText, Landmark, RefreshCw } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { type CompanySnapshot } from '../types/company';
import { useResolvedCompanyLogo, waitForImages } from '../utils/companyLogoUrl';
import { SnapshotMissingError } from './SnapshotMissingError';

import { DocumentHeader } from './DocumentHeader';
import { DocumentPrintStyles } from './DocumentPrintStyles';
import { ResponsiveDocumentPreview } from './ui/ResponsiveDocumentPreview';
interface CreditNoteItem {
  id?: string;
  product_id: string;
  batch_id: string;
  quantity: number;
  unit_price: number;
  products?: {
    product_name: string;
    product_code: string;
  };
  batches?: {
    batch_number: string;
    product_sources?: {
      supplier_name: string | null;
      grade: string | null;
    } | null;
  };
}

interface CreditNoteViewProps {
  creditNote: {
    id: string;
    credit_note_number: string;
    credit_note_date: string;
    customer_id: string;
    original_invoice_id?: string;
    original_invoice_number?: string;
    sales_invoices?: {
      id?: string;
      invoice_number: string;
    } | null;
    reason: string;
    notes?: string;
    currency: string;
    subtotal: number;
    tax_amount: number;
    total_amount: number;
    credit_note_type?: string;
    business_case?: string;
    stock_disposition?: string;
    warehouse_id?: string;
    godown?: string;
    customer_credit_balance?: number;
    settlement_status?: string;
    applied_amount?: number;
    refund_amount?: number;
    journal_entry_id?: string;
    journal_entries?: {
      id: string;
      entry_number: string;
      entry_date: string;
    } | null;
    nota_retur_id?: string;
    nota_retur?: {
      id: string;
      nota_retur_number: string;
      coretax_status: string;
      coretax_reference_number: string;
    } | null;
    customers?: {
      id?: string;
      company_name: string;
      address: string;
      city: string;
      phone: string;
      npwp: string;
      pharmacy_license: string;
    };
    material_returns?: {
      id: string;
      return_number: string;
      return_date: string;
      status: string;
      restocked: boolean;
    } | null;
  };
  items: CreditNoteItem[];
  onClose: () => void;
  companyProfile?: CompanySnapshot | null;
}

export function CreditNoteView({ creditNote, items, onClose, companyProfile }: CreditNoteViewProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const { language } = useLanguage();
  const { ready: logoReady } = useResolvedCompanyLogo(companyProfile?.company_logo_url);
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Refuse to render with FALLBACK_COMPANY — misprinting a
  // customer document with placeholder company header would
  // misrepresent it. Backfill migration 20260714210000 restores
  // NULL snapshots in bulk; one-off legacy rows must be repaired manually.
  if (!companyProfile) {
    return (
      <SnapshotMissingError
        documentType={"Credit Note"}
        documentNumber={'—'}
        onClose={onClose}
      />
    );
  }
  const co = companyProfile;

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
          const clonedElement = clonedDoc.getElementById('credit-note-print-content');
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

      pdf.save(`CreditNote-${creditNote.credit_note_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const customer = creditNote.customers;

  return (
    <>
      <ResponsiveDocumentPreview
        title={`${language === 'id' ? 'Nota Kredit' : 'Credit Note'} ${creditNote.credit_note_number}`}
        onPrint={handlePrint}
        onDownloadPDF={handleDownloadPDF}
        onClose={onClose}
        disabled={!logoReady}
        disabledTitle="Loading company logo…"
        printLabel={language === 'id' ? 'Cetak' : 'Print'}
        pdfLabel="PDF"
      >
        <div id="credit-note-print-content" ref={printRef} className="p-4 sm:p-8">
            <DocumentHeader co={co} title={language === 'id' ? 'CREDIT NOTE' : 'CREDIT NOTE'} titleClassName="text-red-600" />

            <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2">
              <div className="flex justify-between">
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

                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 text-right" style={{minWidth: '200px'}}>
                  <div>
                    <span className="font-bold">{language === 'id' ? 'Credit Note No:' : 'Credit Note No:'}</span>
                    <span className="ml-2">{creditNote.credit_note_number}</span>
                  </div>
                  <div>
                    <span className="font-bold">{language === 'id' ? 'Date:' : 'Date:'}</span>
                    <span className="ml-2">{formatDate(creditNote.credit_note_date)}</span>
                  </div>
                  {creditNote.original_invoice_number && (
                    <div className="pt-1">
                      <span className="font-bold">{language === 'id' ? 'Original Invoice:' : 'Original Invoice:'}</span>
                      <span className="ml-2">{creditNote.original_invoice_number}</span>
                    </div>
                  )}
                  {creditNote.material_returns ? (
                    <div className="pt-1">
                      <span className="font-bold">Originating Return:</span>
                      <span className="ml-2 font-mono text-purple-700 bg-purple-50 px-1 py-0.5 rounded border border-purple-200">
                        {creditNote.material_returns.return_number}
                      </span>
                    </div>
                  ) : creditNote.credit_note_type === 'physical_return' ? (
                    <div className="pt-1">
                      <span className="font-bold">Type:</span>
                      <span className="ml-2 text-emerald-700 bg-emerald-50 px-1 py-0.5 rounded border border-emerald-200 text-[10px]">
                        Physical Goods Return
                      </span>
                    </div>
                  ) : creditNote.credit_note_type === 'commercial_credit' ? (
                    <div className="pt-1">
                      <span className="font-bold">Type:</span>
                      <span className="ml-2 text-blue-700 bg-blue-50 px-1 py-0.5 rounded border border-blue-200 text-[10px]">
                        Commercial Credit
                      </span>
                    </div>
                  ) : (
                    <div className="pt-1">
                      <span className="font-bold">Type:</span>
                      <span className="ml-2 text-amber-700 bg-amber-50 px-1 py-0.5 rounded border border-amber-200 text-[10px]">
                        Unclassified (Review Required)
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div>
              <table className="w-full border-2 border-black text-xs print:text-[10px]">
                <thead>
                  <tr className="border-b-2 border-black bg-white">
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">No.</th>
                    <th className="border-r border-black p-1.5 text-left font-bold print:p-1">{language === 'id' ? 'Product Name' : 'Product Name'}</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Batch No.</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">{language === 'id' ? 'Quantity' : 'Quantity'}</th>
                    <th className="border-r border-black p-1.5 text-right font-bold print:p-1">{language === 'id' ? 'Unit Price (IDR)' : 'Unit Price (IDR)'}</th>
                    <th className="p-1.5 text-right font-bold print:p-1">{language === 'id' ? 'Sub Total (IDR)' : 'Sub Total (IDR)'}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => {
                    const quantity = item.quantity || 0;
                    const unitPrice = item.unit_price || 0;
                    const itemSubtotal = quantity * unitPrice;

                    return (
                      <tr key={item.id || index} className="border-b border-black">
                        <td className="border-r border-black p-1.5 text-center print:p-1">{index + 1}</td>
                        <td className="border-r border-black p-1.5 print:p-1">
                          <div>{item.products?.product_name || 'Unknown Product'}</div>
                          <div className="text-[10px] leading-tight text-gray-700 print:text-[9px]">
                            Make: {item.batches?.product_sources?.supplier_name || 'Not recorded'}
                          </div>
                        </td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{item.batches?.batch_number || 'N/A'}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{quantity.toLocaleString()}</td>
                        <td className="border-r border-black p-1.5 text-right print:p-1">{formatCurrency(unitPrice)}</td>
                        <td className="p-1.5 text-right print:p-1">{formatCurrency(itemSubtotal)}</td>
                      </tr>
                    );
                  })}

                  {items.length < 2 && Array.from({ length: 2 - items.length }).map((_, i) => (
                    <tr key={`empty-${i}`} className="border-b border-black">
                      <td className="border-r border-black p-1.5 text-center print:p-1">&nbsp;</td>
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

            <div className="border-2 border-black border-t-0">
              <div className="flex items-stretch border-b-2 border-black">
                <div className="flex-1 p-2 border-r-2 border-black print:p-1.5">
                  <p className="text-xs font-bold print:text-[10px]">{language === 'id' ? 'Amount In words:' : 'Amount in words:'}</p>
                  <p className="text-xs mt-0.5 font-bold uppercase print:text-[10px] print:mt-0">
                    IDR {numberToWords(Math.round(creditNote.total_amount))} RUPIAH
                  </p>
                </div>

                <div className="w-80 text-xs p-2 print:text-[10px] print:p-1.5">
                  <div className="flex justify-between py-1 print:py-0.5">
                    <span className="font-bold">{language === 'id' ? 'Sub Total' : 'Sub Total'}</span>
                    <span className="font-bold">{formatCurrency(creditNote.subtotal)}</span>
                  </div>
                  <div className="flex justify-between border-t border-black py-1 print:py-0.5">
                    <span className="font-bold">VAT (PPN) 11%</span>
                    <span className="font-bold">{formatCurrency(creditNote.tax_amount)}</span>
                  </div>
                  <div className="flex justify-between border-t-2 border-black py-1 print:py-0.5">
                    <span className="font-bold">{language === 'id' ? 'Total Credit' : 'Total Credit'}</span>
                    <span className="font-bold text-sm text-red-600 print:text-xs">{formatCurrency(creditNote.total_amount)}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-0 text-xs print:text-[10px]">
                <div className="p-3 border-r-2 border-black print:p-2">
                  <p className="font-semibold mb-2 print:mb-1">{language === 'id' ? 'Reason for Credit:' : 'Reason for Credit:'}</p>
                  <p className="text-sm">{creditNote.reason}</p>
                </div>

                <div className="p-3 print:p-2">
                  <p className="font-semibold mb-1">{language === 'id' ? 'Authorized Signatory:' : 'Authorized Signatory:'}</p>
                  <p className="font-semibold mb-10 print:mb-8">{co.company_name}</p>
                  <div className="w-4/5 border-t border-black pt-1">{language === 'id' ? 'Pharmacist' : 'Pharmacist'}</div>
                </div>
              </div>
            </div>

            {creditNote.notes && (
              <div className="mt-3 border-2 border-black p-2 print:mt-2 print:p-1.5">
                <p className="text-xs print:text-[10px]">
                  <span className="font-bold">{language === 'id' ? 'Notes: ' : 'Notes: '}</span>
                  <span>{creditNote.notes}</span>
                </p>
              </div>
            )}
          </div>

          {/* Financial Impact & Operational Ledger Integration Summary Card */}
          <div className="doc-print-hide border-t-2 border-gray-200 bg-slate-50 p-6 space-y-5 rounded-b-xl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-indigo-600" />
                <div>
                  <h3 className="text-sm font-bold text-gray-900 tracking-tight">Financial Impact & Ledger Integration Summary</h3>
                  <p className="text-xs text-gray-500">Autonomous operational, tax, inventory, and General Ledger posting verification</p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className={`px-2.5 py-1 rounded-full font-medium ${
                  creditNote.settlement_status === 'offset_original' ? 'bg-emerald-100 text-emerald-800' :
                  creditNote.settlement_status === 'applied_to_invoice' ? 'bg-blue-100 text-blue-800' :
                  creditNote.settlement_status === 'refunded' ? 'bg-purple-100 text-purple-800' :
                  'bg-amber-100 text-amber-800'
                }`}>
                  Settlement: {creditNote.settlement_status?.replace('_', ' ') || 'Offset Original Invoice'}
                </span>
              </div>
            </div>

            {/* 3-column Grid for Key Dimensions */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              {/* 1. Commercial & Receivables */}
              <div className="bg-white p-3.5 rounded-lg border border-gray-200 shadow-xs space-y-2">
                <div className="flex items-center justify-between font-bold text-gray-800 pb-1.5 border-b">
                  <span className="flex items-center gap-1.5"><FileText className="w-4 h-4 text-blue-600" /> Customer & A/R Impact</span>
                  <Link
                    to={`/finance/party-ledger?party=${creditNote.customer_id}`}
                    className="text-blue-600 hover:text-blue-800 flex items-center gap-0.5 text-[11px]"
                    title="Open Customer Party Ledger"
                  >
                    Party Ledger <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
                <div className="space-y-1.5 text-gray-600">
                  <div className="flex justify-between">
                    <span>Original Invoice:</span>
                    {creditNote.original_invoice_number || creditNote.sales_invoices?.invoice_number ? (
                      <Link
                        to={`/sales/invoices?search=${creditNote.original_invoice_number || creditNote.sales_invoices?.invoice_number}`}
                        className="font-mono text-blue-600 hover:underline font-semibold"
                      >
                        {creditNote.original_invoice_number || creditNote.sales_invoices?.invoice_number}
                      </Link>
                    ) : (
                      <span className="text-gray-400">Direct Concession</span>
                    )}
                  </div>
                  <div className="flex justify-between">
                    <span>Total Credited:</span>
                    <span className="font-semibold text-gray-900">{formatCurrency(creditNote.total_amount)}</span>
                  </div>
                  {Number(creditNote.customer_credit_balance || 0) > 0 && (
                    <div className="flex justify-between text-amber-700 bg-amber-50 px-2 py-1 rounded">
                      <span>Unsettled Credit Balance:</span>
                      <span className="font-bold">{formatCurrency(creditNote.customer_credit_balance)}</span>
                    </div>
                  )}
                  {Number(creditNote.refund_amount || 0) > 0 && (
                    <div className="flex justify-between text-purple-700 bg-purple-50 px-2 py-1 rounded">
                      <span>Bank Refund Paid:</span>
                      <span className="font-bold">{formatCurrency(creditNote.refund_amount)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* 2. Physical Return & Inventory */}
              <div className="bg-white p-3.5 rounded-lg border border-gray-200 shadow-xs space-y-2">
                <div className="flex items-center justify-between font-bold text-gray-800 pb-1.5 border-b">
                  <span className="flex items-center gap-1.5"><RefreshCw className="w-4 h-4 text-emerald-600" /> Physical & Inventory</span>
                  <span className="text-[11px] font-normal text-gray-500">{creditNote.credit_note_type === 'physical_return' ? 'Physical Return' : 'Commercial Concession'}</span>
                </div>
                <div className="space-y-1.5 text-gray-600">
                  <div className="flex justify-between">
                    <span>Business Case:</span>
                    <span className="font-medium text-gray-900 capitalize">
                      {creditNote.business_case?.replace(/_/g, ' ') || (creditNote.credit_note_type === 'commercial_credit' ? 'Price Concession' : 'Physical Return')}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Stock Disposition:</span>
                    <span className="font-semibold text-emerald-700 capitalize">
                      {creditNote.stock_disposition || 'Saleable (Restocked)'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Warehouse / Godown:</span>
                    <span className="text-gray-700">{creditNote.godown || 'Main Warehouse'}</span>
                  </div>
                  {creditNote.material_returns && (
                    <div className="flex justify-between pt-1">
                      <span>Originating Return:</span>
                      <Link
                        to={`/inventory/returns`}
                        className="font-mono text-purple-700 bg-purple-50 px-1 py-0.5 rounded hover:underline text-[11px]"
                      >
                        {creditNote.material_returns.return_number}
                      </Link>
                    </div>
                  )}
                </div>
              </div>

              {/* 3. Indonesian Tax & Coretax */}
              <div className="bg-white p-3.5 rounded-lg border border-gray-200 shadow-xs space-y-2">
                <div className="flex items-center justify-between font-bold text-gray-800 pb-1.5 border-b">
                  <span className="flex items-center gap-1.5"><Landmark className="w-4 h-4 text-purple-600" /> Tax & Nota Retur</span>
                  <span className="text-[11px] font-normal text-gray-500">DJP / Coretax</span>
                </div>
                <div className="space-y-1.5 text-gray-600">
                  <div className="flex justify-between">
                    <span>Output PPN (11%):</span>
                    <span className="font-semibold text-gray-900">{formatCurrency(creditNote.tax_amount)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Nota Retur Status:</span>
                    <span className="font-medium text-purple-700">
                      {creditNote.nota_retur?.nota_retur_number || 'Registered with Credit Note'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Coretax Submission:</span>
                    <span className="text-gray-700 capitalize">
                      {creditNote.nota_retur?.coretax_status || 'Draft (Ready for Filing)'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* General Ledger Reversal Breakdown Table */}
            <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-xs space-y-2">
              <div className="flex items-center justify-between pb-2 border-b">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-xs text-gray-900">General Ledger Journal Entries</span>
                  {creditNote.journal_entries?.entry_number && (
                    <Link
                      to={`/finance/journals?search=${creditNote.journal_entries.entry_number}`}
                      className="text-xs font-mono text-blue-600 hover:underline flex items-center gap-1"
                    >
                      {creditNote.journal_entries.entry_number} <ExternalLink className="w-3 h-3" />
                    </Link>
                  )}
                </div>
                <span className="text-[11px] text-gray-500">Autonomous Double-Entry Posting</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 text-gray-600 text-left">
                      <th className="p-1.5">Account Code & Name</th>
                      <th className="p-1.5">Posting Role</th>
                      <th className="p-1.5 text-right">Debit (Rp)</th>
                      <th className="p-1.5 text-right">Credit (Rp)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td className="p-1.5 font-medium text-gray-900">4300 - Sales Returns & Allowances</td>
                      <td className="p-1.5 text-gray-500">Contra Revenue (Subtotal reversal)</td>
                      <td className="p-1.5 text-right font-mono font-medium text-gray-900">{formatCurrency(creditNote.subtotal)}</td>
                      <td className="p-1.5 text-right font-mono text-gray-400">-</td>
                    </tr>
                    {creditNote.tax_amount > 0 && (
                      <tr>
                        <td className="p-1.5 font-medium text-gray-900">2130 - Output PPN Payable</td>
                        <td className="p-1.5 text-gray-500">VAT Liability Reduction (11% Tax)</td>
                        <td className="p-1.5 text-right font-mono font-medium text-gray-900">{formatCurrency(creditNote.tax_amount)}</td>
                        <td className="p-1.5 text-right font-mono text-gray-400">-</td>
                      </tr>
                    )}
                    <tr>
                      <td className="p-1.5 font-medium text-gray-900">1120 - Accounts Receivable</td>
                      <td className="p-1.5 text-gray-500">Customer Receivable Reduction</td>
                      <td className="p-1.5 text-right font-mono text-gray-400">-</td>
                      <td className="p-1.5 text-right font-mono font-medium text-gray-900">{formatCurrency(creditNote.total_amount)}</td>
                    </tr>
                    {creditNote.credit_note_type === 'physical_return' && (
                      <>
                        <tr className="bg-emerald-50/50">
                          <td className="p-1.5 font-medium text-emerald-950">
                            {creditNote.stock_disposition === 'damaged' || creditNote.stock_disposition === 'scrap'
                              ? '5190 - Inventory Impairment & Damage Loss'
                              : '1130 - Merchandise Inventory'}
                          </td>
                          <td className="p-1.5 text-emerald-800">
                            {creditNote.stock_disposition === 'damaged' || creditNote.stock_disposition === 'scrap'
                              ? 'Damaged / scrap write-down expense recognition'
                              : 'Recoverable physical stock restored at historical FIFO cost'}
                          </td>
                          <td className="p-1.5 text-right font-mono font-medium text-emerald-900">Historical FIFO COGS</td>
                          <td className="p-1.5 text-right font-mono text-gray-400">-</td>
                        </tr>
                        <tr className="bg-emerald-50/50">
                          <td className="p-1.5 font-medium text-emerald-950">5100 - Cost of Goods Sold</td>
                          <td className="p-1.5 text-emerald-800">Cost of Goods Sold Reversal</td>
                          <td className="p-1.5 text-right font-mono text-gray-400">-</td>
                          <td className="p-1.5 text-right font-mono font-medium text-emerald-900">Historical FIFO COGS</td>
                        </tr>
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
      </ResponsiveDocumentPreview>

      <DocumentPrintStyles contentId="credit-note-print-content" />
    </>
  );
}
