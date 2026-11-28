import { useRef, useEffect } from 'react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { type CompanySnapshot } from '../types/company';
import { useResolvedCompanyLogo, waitForImages } from '../utils/companyLogoUrl';
import { SnapshotMissingError } from './SnapshotMissingError';

import { DocumentHeader } from './DocumentHeader';
import { DocumentPrintStyles } from './DocumentPrintStyles';
import { ResponsiveDocumentPreview } from './ui/ResponsiveDocumentPreview';
interface ReturnItem {
  id?: string;
  product_id: string;
  batch_id: string | null;
  quantity_returned: number;
  original_quantity: number;
  unit_price: number;
  condition: string;
  disposition: string;
  notes?: string;
  products?: {
    product_name: string;
    product_code: string;
  };
  batches?: {
    batch_number: string;
  };
}

interface MaterialReturnViewProps {
  materialReturn: {
    id: string;
    return_number: string;
    return_date: string;
    return_type: string;
    return_reason: string;
    status: string;
    notes?: string;
    financial_impact?: number;
    restocked?: boolean;
    credit_note_number?: string | null;
    credit_note_issued?: boolean;
    credit_note_amount?: number;
    customers?: {
      company_name: string;
      address: string;
      city: string;
      phone: string;
    };
    delivery_challans?: {
      challan_number: string;
    };
    sales_invoices?: {
      invoice_number: string;
    };
  };
  items: ReturnItem[];
  onClose: () => void;
  companyProfile?: CompanySnapshot | null;
}

export function MaterialReturnView({ materialReturn, items, onClose, companyProfile }: MaterialReturnViewProps) {
  const printRef = useRef<HTMLDivElement>(null);
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
        documentType={"Material Return"}
        documentNumber={'—'}
        onClose={onClose}
      />
    );
  }
  const co = companyProfile;

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const day = date.getDate();
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()];
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
  };

  const formatCurrency = (amount: number | undefined | null) => {
    if (amount === undefined || amount === null) return 'Rp 0,00';
    // Always show 2 decimal places in Indonesian format (Rp 136.125.000,00)
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
          const clonedElement = clonedDoc.getElementById('return-print-content');
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

      pdf.save(`MaterialReturn-${materialReturn.return_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const customer = materialReturn.customers;

  return (
    <>
      <ResponsiveDocumentPreview
        title={`Material Return ${materialReturn.return_number}`}
        onPrint={handlePrint}
        onDownloadPDF={handleDownloadPDF}
        onClose={onClose}
        disabled={!logoReady}
        disabledTitle="Loading company logo…"
        printLabel="Print"
        pdfLabel="PDF"
      >
        <div id="return-print-content" ref={printRef} className="p-4 sm:p-8">
            <DocumentHeader co={co} title="MATERIAL RETURN" titleClassName="text-orange-600" />

            <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2">
              <div className="flex justify-between">
                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 flex-1">
                  <div>
                    <span className="font-bold">Customer:</span>
                    <span className="font-semibold"> {customer?.company_name || ''}</span>
                  </div>

                  <div className="pt-1 flex">
                    <span className="font-bold" style={{minWidth: '72px'}}>Address:</span>
                    <div>
                      <p>{customer?.address || ''}</p>
                      <p>{customer?.city || ''}</p>
                    </div>
                  </div>
                  <div className="flex pt-1">
                    <span className="font-bold" style={{minWidth: '72px'}}>Phone:</span>
                    <span>{customer?.phone || ''}</span>
                  </div>
                </div>

                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 text-right" style={{minWidth: '220px'}}>
                  <div>
                    <span className="font-bold">Return No:</span>
                    <span className="ml-2">{materialReturn.return_number}</span>
                  </div>
                  <div>
                    <span className="font-bold">Return Date:</span>
                    <span className="ml-2">{formatDate(materialReturn.return_date)}</span>
                  </div>
                  {materialReturn.delivery_challans && (
                    <div className="pt-1">
                      <span className="font-bold">Original DC:</span>
                      <span className="ml-2">{materialReturn.delivery_challans.challan_number}</span>
                    </div>
                  )}
                  {materialReturn.sales_invoices && (
                    <div className="pt-1">
                      <span className="font-bold">Original Invoice:</span>
                      <span className="ml-2">{materialReturn.sales_invoices.invoice_number}</span>
                    </div>
                  )}
                  <div className="pt-1">
                    <span className="font-bold">Return Type:</span>
                    <span className="ml-2">{materialReturn.return_type.replace('_', ' ').toUpperCase()}</span>
                  </div>
                  <div>
                    <span className="font-bold">Status:</span>
                    <span className={`ml-2 px-2 py-0.5 rounded text-xs font-semibold ${
                      materialReturn.status === 'approved' ? 'bg-green-100 text-green-800' :
                      materialReturn.status === 'rejected' ? 'bg-red-100 text-red-800' :
                      'bg-yellow-100 text-yellow-800'
                    }`}>
                      {materialReturn.status.replace('_', ' ').toUpperCase()}
                    </span>
                  </div>
                  <div className="pt-1">
                    <span className="font-bold">Inventory V1:</span>
                    <span className={`ml-2 px-2 py-0.5 rounded text-xs font-semibold ${
                      materialReturn.restocked ? 'bg-blue-100 text-blue-800' :
                      materialReturn.status === 'approved' ? 'bg-gray-100 text-gray-700' :
                      'bg-amber-50 text-amber-700'
                    }`}>
                      {materialReturn.restocked ? 'Restocked to Batches' :
                       materialReturn.status === 'approved' ? 'Scrapped (No Restock)' :
                       'Awaiting Approval'}
                    </span>
                  </div>
                  <div className="pt-1">
                    <span className="font-bold">Financial CN:</span>
                    {materialReturn.credit_note_number ? (
                      <span className="ml-2 font-mono text-emerald-800 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded text-xs font-bold">
                        {materialReturn.credit_note_number} {materialReturn.credit_note_issued ? '(AR Reversal Posted)' : '(Draft)'}
                      </span>
                    ) : (
                      <span className="ml-2 text-xs text-gray-500 italic">
                        No Credit Note linked
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div>
              <table className="w-full border-2 border-black text-xs print:text-[10px]">
                <thead>
                  <tr className="border-b-2 border-black bg-white">
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">No.</th>
                    <th className="border-r border-black p-1.5 text-left font-bold print:p-1">Product Name</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Batch No.</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Original Qty</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Return Qty</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Condition</th>
                    <th className="border-r border-black p-1.5 text-right font-bold print:p-1">Unit Price</th>
                    <th className="p-1.5 text-right font-bold print:p-1">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => {
                    const totalPrice = item.quantity_returned * item.unit_price;

                    return (
                      <tr key={item.id || index} className="border-b border-black">
                        <td className="border-r border-black p-1.5 text-center print:p-1">{index + 1}</td>
                        <td className="border-r border-black p-1.5 print:p-1">{item.products?.product_name || 'Unknown Product'}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{item.batches?.batch_number || 'N/A'}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{item.original_quantity.toLocaleString()}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{item.quantity_returned.toLocaleString()}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{item.condition.toUpperCase()}</td>
                        <td className="border-r border-black p-1.5 text-right print:p-1">{formatCurrency(item.unit_price)}</td>
                        <td className="p-1.5 text-right print:p-1">{formatCurrency(totalPrice)}</td>
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
                  <p className="text-xs font-bold print:text-[10px]">Return Reason:</p>
                  <p className="text-xs mt-0.5 print:text-[10px] print:mt-0">
                    {materialReturn.return_reason}
                  </p>
                </div>

                <div className="w-64 text-xs p-2 print:text-[10px] print:p-1.5">
                  <div className="flex justify-between border-t-2 border-black py-1 print:py-0.5">
                    <span className="font-bold">Total Value</span>
                    <span className="font-bold text-sm text-orange-600 print:text-xs">{formatCurrency(materialReturn.financial_impact || 0)}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-0 text-xs print:text-[10px]">
                <div className="p-3 border-r-2 border-black print:p-2 text-center">
                  <p className="font-semibold mb-12 print:mb-10">Prepared By</p>
                  <div className="border-t border-black pt-1 mx-4">Name & Signature</div>
                </div>

                <div className="p-3 border-r-2 border-black print:p-2 text-center">
                  <p className="font-semibold mb-12 print:mb-10">Checked By</p>
                  <div className="border-t border-black pt-1 mx-4">QC / Manager</div>
                </div>

                <div className="p-3 print:p-2 text-center">
                  <p className="font-semibold mb-1">Approved By</p>
                  <p className="font-semibold mb-9 print:mb-7">{co.company_name}</p>
                  <div className="border-t border-black pt-1 mx-4">Pharmacist</div>
                </div>
              </div>
            </div>

            {materialReturn.notes && (
              <div className="mt-3 border-2 border-black p-2 print:mt-2 print:p-1.5">
                <p className="text-xs print:text-[10px]">
                  <span className="font-bold">Additional Notes: </span>
                  <span>{materialReturn.notes}</span>
                </p>
              </div>
            )}
          </div>
      </ResponsiveDocumentPreview>

      <DocumentPrintStyles contentId="return-print-content" />
    </>
  );
}
