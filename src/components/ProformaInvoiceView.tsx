import { useRef, useEffect, useState } from 'react';
import { DollarSign, AlertTriangle } from 'lucide-react';
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
import { supabase } from '../lib/supabase';
import { EditSalesOrderFxRateModal } from './EditSalesOrderFxRateModal';

interface SalesOrderItem {
  id?: string;
  product_id: string;
  make_id?: string | null;
  quantity: number;
  unit_price: number;
  discount_percent: number;
  discount_amount: number;
  tax_percent: number;
  tax_amount: number;
  line_total: number;
  quoted_usd_unit_price?: number | null;
  products?: {
    product_name: string;
    product_code: string;
    unit: string;
  };
  product_sources?: {
    supplier_name: string | null;
    grade: string | null;
  } | null;
}

interface ProformaInvoiceViewProps {
  salesOrder: {
    id: string;
    so_number: string;
    customer_id: string;
    customer_po_number: string;
    customer_po_date: string;
    so_date: string;
    expected_delivery_date: string | null;
    subtotal_amount: number;
    tax_amount: number;
    total_amount: number;
    notes: string | null;
    currency?: string;
    commercial_usd_to_idr_rate?: number | null;
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
  items: SalesOrderItem[];
  onClose: () => void;
  companyProfile?: CompanySnapshot | null;
  linkedDcs?: Array<{ id: string; number: string }>;
  linkedInvoices?: Array<{ id: string; number: string }>;
  onRateUpdated?: (newRate: number | null) => void;
}

export function ProformaInvoiceView({
  salesOrder,
  items,
  onClose,
  companyProfile,
  linkedDcs,
  linkedInvoices,
  onRateUpdated,
}: ProformaInvoiceViewProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const { t, language } = useLanguage();
  const companySnapshot = companyProfile ?? salesOrder.company_snapshot;
  const { ready: logoReady } = useResolvedCompanyLogo(companySnapshot?.company_logo_url);

  const [currentRate, setCurrentRate] = useState<number | null>(salesOrder.commercial_usd_to_idr_rate ?? null);
  const [showRateModal, setShowRateModal] = useState(false);
  const [linkedDcsList, setLinkedDcsList] = useState<Array<{ id: string; number: string }>>(linkedDcs || []);
  const [linkedInvoicesList, setLinkedInvoicesList] = useState<Array<{ id: string; number: string }>>(linkedInvoices || []);

  useEffect(() => {
    setCurrentRate(salesOrder.commercial_usd_to_idr_rate ?? null);
  }, [salesOrder.commercial_usd_to_idr_rate]);

  useEffect(() => {
    if (linkedDcs) {
      setLinkedDcsList(linkedDcs);
    } else if (salesOrder?.id) {
      supabase
        .from('delivery_challans')
        .select('id, challan_number')
        .eq('sales_order_id', salesOrder.id)
        .then(({ data }) => {
          if (data) setLinkedDcsList(data.map((d: any) => ({ id: d.id, number: d.challan_number })));
        });
    }
  }, [salesOrder?.id, linkedDcs]);

  useEffect(() => {
    if (linkedInvoices) {
      setLinkedInvoicesList(linkedInvoices);
    } else if (salesOrder?.id) {
      supabase
        .from('sales_invoices')
        .select('id, invoice_number')
        .eq('sales_order_id', salesOrder.id)
        .then(({ data }) => {
          if (data) setLinkedInvoicesList(data.map((i: any) => ({ id: i.id, number: i.invoice_number })));
        });
    }
  }, [salesOrder?.id, linkedInvoices]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Refuse to render with FALLBACK_COMPANY — misprinting a
  // customer document with placeholder company header would
  // misrepresent it. Backfill migration 20260714210000 restores
  // NULL snapshots in bulk; one-off legacy rows must be repaired manually.
  if (!companySnapshot) {
    return (
      <SnapshotMissingError
        documentType={"Sales Order"}
        documentNumber={salesOrder.so_number}
        onClose={onClose}
      />
    );
  }
  const co = companySnapshot;

  const currency = salesOrder.currency || 'IDR';
  const currencySymbol = currency === 'IDR' ? 'Rp' : currency === 'USD' ? '$' : currency;

  const formatCurrency = (amount: number | undefined | null) => {
    if (amount === undefined || amount === null) return `${currencySymbol} 0,00`;
    if (currency === 'IDR') {
      // Always show 2 decimal places in Indonesian format (136.125.000,00)
      return `${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `${currencySymbol} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const getSecondaryUsdUnitPrice = (item: SalesOrderItem): string | null => {
    if (currency !== 'IDR') return null; // Commercial reference is specifically for IDR Sales Orders
    let usdPrice: number | null = null;
    if (item.quoted_usd_unit_price != null && Number(item.quoted_usd_unit_price) > 0) {
      usdPrice = Number(item.quoted_usd_unit_price);
    } else if (currentRate != null && currentRate > 0 && (item.unit_price || 0) > 0) {
      usdPrice = Number(item.unit_price) / currentRate;
    }
    if (usdPrice == null) return null;
    const uom = formatUnit(item.products?.unit) || 'Unit';
    return `$${usdPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / ${uom}`;
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
          const clonedElement = clonedDoc.getElementById('proforma-print-content');
          if (clonedElement) {
            clonedElement.style.width = '210mm';
          }
          // Completely remove screen-only and print-hidden elements from PDF canvas
          const printHiddenElements = clonedDoc.querySelectorAll(
            '.printHidden, .screenOnly, .no-print, [data-screen-only="true"]'
          );
          printHiddenElements.forEach((el) => {
            (el as HTMLElement).style.setProperty('display', 'none', 'important');
          });
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

      pdf.save(`Proforma-Invoice-${salesOrder.so_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const customer = salesOrder.customers;
  const hasAnyDiscount = items.some(item => (item.discount_amount || 0) > 0);
  const hasQuotedUsdWithoutRate =
    currency === 'IDR' &&
    (currentRate == null || currentRate <= 0) &&
    items.some(item => item.quoted_usd_unit_price != null && Number(item.quoted_usd_unit_price) > 0);

  return (
    <>
      <ResponsiveDocumentPreview
        title={`${language === 'id' ? 'Faktur Proforma' : 'Proforma Invoice'} ${salesOrder.so_number}`}
        extraActions={
          <button
            type="button"
            onClick={() => setShowRateModal(true)}
            className="no-compact flex items-center gap-1 rounded-lg bg-amber-50 border border-amber-300 px-2.5 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 transition shadow-sm"
            title="Edit Commercial FX Rate (USD → IDR)"
          >
            <DollarSign className="h-3.5 w-3.5 text-amber-600" />
            <span>Edit FX Rate</span>
          </button>
        }
        onPrint={handlePrint}
        onDownloadPDF={handleDownloadPDF}
        onClose={onClose}
        disabled={!logoReady}
        disabledTitle="Loading company logo…"
        printLabel={language === 'id' ? 'Cetak' : 'Print'}
        pdfLabel="PDF"
      >

          {hasQuotedUsdWithoutRate && (
            <div className="doc-print-hide mx-6 mt-4 flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 shadow-sm">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                <span className="font-semibold">
                  USD quoted prices exist, but the commercial USD→IDR exchange rate has not been set.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowRateModal(true)}
                className="ml-3 rounded bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700 transition"
              >
                Set Rate
              </button>
            </div>
          )}

          <div id="proforma-print-content" ref={printRef} className="p-8">
            {/* Header Section - Your Company Details */}
            <DocumentHeader co={co} title={language === 'id' ? 'FAKTUR PROFORMA' : 'PROFORMA INVOICE'} />

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

                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 text-right" style={{minWidth: '240px'}}>
                  <div>
                    <span className="font-bold">{language === 'id' ? 'SO Number:' : 'SO Number:'}</span>
                    <span className="ml-2 font-semibold">{salesOrder.so_number}</span>
                  </div>
                  <div>
                    <span className="font-bold">{language === 'id' ? 'SO Date:' : 'SO Date:'}</span>
                    <span className="ml-2">{formatDate(salesOrder.so_date)}</span>
                  </div>
                  <div className="pt-0.5">
                    <span className="font-bold">Customer PO No:</span>
                    <span className="ml-2">{salesOrder.customer_po_number}</span>
                  </div>
                  <div>
                    <span className="font-bold">Customer PO Date:</span>
                    <span className="ml-2">{formatDate(salesOrder.customer_po_date)}</span>
                  </div>
                  {salesOrder.expected_delivery_date && (
                    <div>
                      <span className="font-bold">{language === 'id' ? 'Expected Delivery:' : 'Expected Delivery:'}</span>
                      <span className="ml-2">{formatDate(salesOrder.expected_delivery_date)}</span>
                    </div>
                  )}

                  {/* Commercial FX Rate (Screen Only) */}
                  <div className="printHidden screenOnly pt-1.5 border-t border-black/20 mt-1.5 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="font-bold">Exchange Rate (USD → IDR):</span>
                      <span className={`font-semibold ${currentRate != null ? 'text-gray-900' : 'text-amber-700 italic'}`}>
                        {currentRate != null
                          ? `Rp ${Number(currentRate).toLocaleString('id-ID', { maximumFractionDigits: 2 })} / USD`
                          : 'Not Set'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowRateModal(true)}
                        className="no-print ml-1 text-blue-600 hover:text-blue-800 underline text-[10px] font-semibold"
                        title="Edit Commercial FX Rate"
                      >
                        {currentRate != null ? 'Edit' : 'Set Rate'}
                      </button>
                    </div>
                    {hasQuotedUsdWithoutRate && (
                      <div className="text-[10px] text-amber-700 font-semibold mt-1">
                        USD quoted prices exist, but the commercial USD→IDR exchange rate has not been set.
                      </div>
                    )}
                    <div className="text-[9px] text-gray-500 font-normal">
                      Commercial FX Rate (pricing reference)
                    </div>
                  </div>

                  {/* Linked Documents (DC / Invoice) (Screen Only) */}
                  {(linkedDcsList.length > 0 || linkedInvoicesList.length > 0) && (
                    <div className="printHidden screenOnly pt-1 border-t border-black/10 text-[10px] text-gray-600 space-y-0.5">
                      <div>
                        <span className="font-bold">Linked DC: </span>
                        <span>
                          {linkedDcsList.length > 0
                            ? linkedDcsList.map((d) => d.number).join(', ')
                            : 'None'}
                        </span>
                      </div>
                      <div>
                        <span className="font-bold">Linked Invoice: </span>
                        <span>
                          {linkedInvoicesList.length > 0
                            ? linkedInvoicesList.map((i) => i.number).join(', ')
                            : 'None'}
                        </span>
                      </div>
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
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">{language === 'id' ? 'Total Qty' : 'Total Qty'}</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">UOM</th>
                    <th className={`border-r border-black p-1.5 text-right font-bold print:p-1 ${!hasAnyDiscount ? '' : ''}`}>{language === 'id' ? `Unit Price (${currency})` : `Unit Price (${currency})`}</th>
                    {hasAnyDiscount && (
                      <th className="border-r border-black p-1.5 text-right font-bold print:p-1">{language === 'id' ? 'Discount' : 'Discount'}</th>
                    )}
                    <th className="p-1.5 text-right font-bold print:p-1">{language === 'id' ? `Sub Total (${currency})` : `Sub Total (${currency})`}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => {
                    const quantity = item.quantity || 0;
                    const unitPrice = item.unit_price || 0;
                    const discountAmount = item.discount_amount || 0;
                    const itemSubtotal = (quantity * unitPrice) - discountAmount;

                    return (
                      <tr key={item.id || index} className="border-b border-black">
                        {/* Cell 1: No. */}
                        <td className="border-r border-black p-1.5 text-center print:p-1">{index + 1}</td>
                        {/* Cell 2: Product Name + source */}
                        <td className="border-r border-black p-1.5 print:p-1">
                          <div>{item.products?.product_name || 'Unknown Product'}</div>
                          <div className="text-[9px] leading-none text-gray-600 print:text-[8px]">
                            {item.product_sources?.supplier_name || 'Not recorded'}
                            {item.product_sources?.grade ? ` (${item.product_sources.grade})` : ''}
                          </div>
                        </td>
                        {/* Cell 3: Total Qty */}
                        <td className="border-r border-black p-1.5 text-center print:p-1">{quantity.toLocaleString()}</td>
                        {/* Cell 4: UOM — ALWAYS present, never hidden. Hiding a td breaks column alignment. */}
                        <td className="border-r border-black p-1.5 text-center print:p-1">
                          {formatUnit(item.products?.unit) || ''}
                        </td>
                        {/* Cell 5: Unit Price (IDR).
                             The USD reference sub-line is screen-only; it sits inside this td as a child
                             div with screenOnly/printHidden so the column count never changes. */}
                        <td className="border-r border-black p-1.5 text-right print:p-1">
                          <div>{formatCurrency(unitPrice)}</div>
                          {(() => {
                            const secondaryUsd = getSecondaryUsdUnitPrice(item);
                            if (!secondaryUsd) return null;
                            const isDirectQuoted = item.quoted_usd_unit_price != null && Number(item.quoted_usd_unit_price) > 0;
                            const tooltip = isDirectQuoted
                              ? currentRate != null
                                ? 'USD quoted price'
                                : 'USD quoted price (commercial USD→IDR exchange rate not set)'
                              : 'Commercial USD reference based on commercial FX rate';
                            return (
                              <div
                                className="screenOnly printHidden text-[10px] text-gray-500 font-medium whitespace-nowrap mt-0.5"
                                title={tooltip}
                              >
                                {secondaryUsd}
                              </div>
                            );
                          })()}
                        </td>
                        {/* Conditional Discount cell */}
                        {hasAnyDiscount && (
                          <td className="border-r border-black p-1.5 text-right print:p-1">{formatCurrency(discountAmount)}</td>
                        )}
                        {/* Cell 6: Sub Total */}
                        <td className="p-1.5 text-right print:p-1">{formatCurrency(itemSubtotal)}</td>
                      </tr>
                    );
                  })}

                  {items.length < 2 && Array.from({ length: 2 - items.length }).map((_, i) => (
                    <tr key={`empty-${i}`} className="border-b border-black">
                      <td className="border-r border-black p-1.5 text-center print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      {/* UOM cell must always be present — matches header column 4 */}
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      {hasAnyDiscount && (
                        <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      )}
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
                    {currency} {numberToWords(Math.round(salesOrder.total_amount))} {currency === 'IDR' ? 'RUPIAH' : currency === 'USD' ? 'DOLLARS' : ''}
                  </p>
                </div>

                <div className="w-80 text-xs p-2 print:text-[10px] print:p-1.5">
                  <div className="flex justify-between py-1 print:py-0.5">
                    <span className="font-bold">{language === 'id' ? 'Sub Total' : 'Sub Total'}</span>
                    <span className="font-bold">{formatCurrency(salesOrder.subtotal_amount)}</span>
                  </div>
                  <div className="flex justify-between border-t border-black py-1 print:py-0.5">
                    <span className="font-bold">VAT (PPN) 11%</span>
                    <span className="font-bold">{formatCurrency(salesOrder.tax_amount)}</span>
                  </div>
                  <div className="flex justify-between border-t-2 border-black py-1 print:py-0.5">
                    <span className="font-bold">{language === 'id' ? 'Grand Total' : 'Grand Total'}</span>
                    <span className="font-bold text-sm print:text-xs">{formatCurrency(salesOrder.total_amount)}</span>
                  </div>

                  {currency === 'USD' && currentRate != null && currentRate > 0 && (
                    <div className="printHidden screenOnly border-t-2 border-dashed border-black/40 mt-1.5 pt-1.5 bg-amber-50/50 p-2 rounded text-[11px] space-y-1">
                      <div className="flex justify-between text-gray-600">
                        <span>Original SO Value:</span>
                        <span className="font-semibold">${Number(salesOrder.total_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                      <div className="flex justify-between text-gray-600">
                        <span>Commercial FX Rate:</span>
                        <span className="font-semibold">Rp {Number(currentRate).toLocaleString('id-ID', { maximumFractionDigits: 2 })} / USD</span>
                      </div>
                      <div className="flex justify-between font-bold text-amber-900 border-t border-amber-200 pt-0.5">
                        <span>Commercial IDR Equivalent:</span>
                        <span>Rp {(salesOrder.total_amount * currentRate).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-0 text-xs print:text-[10px]">
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

                <div className="p-3 print:p-2">
                  <p className="font-semibold mb-1">{language === 'id' ? 'Authorized Signatory:' : 'Authorized Signatory:'}</p>
                  <p className="font-semibold mb-10 print:mb-8">{co.company_name}</p>
                  <div className="w-4/5 border-t border-black pt-1">{language === 'id' ? 'Pharmacist' : 'Pharmacist'}</div>
                </div>
              </div>
            </div>

            {salesOrder.notes && (
              <div className="border-2 border-black border-t-0 p-2 print:p-1.5">
                <p className="text-xs print:text-[10px]">
                  <span className="font-bold">{language === 'id' ? 'Notes: ' : 'Notes: '}</span>
                  <span>{salesOrder.notes}</span>
                </p>
              </div>
            )}

            <div className="border-2 border-black border-t-0 p-2.5 print:p-2">
              <p className="text-xs font-semibold text-center print:text-[10px]">
                {language === 'id'
                  ? 'Ini adalah Faktur Proforma dan bukan tagihan resmi. Faktur resmi akan diterbitkan setelah pengiriman barang.'
                  : 'This is a Proforma Invoice and not an official bill. Official invoice will be issued after delivery of goods.'}
              </p>
            </div>
          </div>
      </ResponsiveDocumentPreview>

      {showRateModal && (
        <EditSalesOrderFxRateModal
          isOpen={showRateModal}
          onClose={() => setShowRateModal(false)}
          salesOrder={{
            id: salesOrder.id,
            so_number: salesOrder.so_number,
            currency: salesOrder.currency || 'IDR',
            total_amount: salesOrder.total_amount,
            commercial_usd_to_idr_rate: currentRate,
          }}
          onSuccess={(soId, newRate) => {
            setCurrentRate(newRate);
            salesOrder.commercial_usd_to_idr_rate = newRate;
            onRateUpdated?.(newRate);
          }}
        />
      )}

      <DocumentPrintStyles contentId="proforma-print-content" />
      <style>{`
        @media screen {
          .printOnly {
            display: none !important;
          }
        }
        @media print {
          .printHidden,
          .screenOnly,
          .no-print,
          [data-screen-only="true"] {
            display: none !important;
          }
        }
      `}</style>
    </>
  );
}
