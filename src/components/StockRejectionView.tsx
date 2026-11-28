import { useRef, useEffect } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { type CompanySnapshot } from '../types/company';
import { useResolvedCompanyLogo, waitForImages } from '../utils/companyLogoUrl';
import { SnapshotMissingError } from './SnapshotMissingError';

import { DocumentHeader } from './DocumentHeader';
import { DocumentPrintStyles } from './DocumentPrintStyles';
import { ResponsiveDocumentPreview } from './ui/ResponsiveDocumentPreview';
interface StockRejectionViewProps {
  rejection: {
    id: string;
    rejection_number: string;
    rejection_date: string;
    quantity_rejected: number;
    rejection_reason: string;
    rejection_details: string;
    status: string;
    financial_loss: number;
    disposition: string;
    inspection_report?: string | null;
    unit_cost: number;
    photos?: any[];
    product: {
      product_name: string;
      product_code: string;
      unit: string;
    };
    batch: {
      batch_number: string;
      current_stock: number;
    };
  };
  onClose: () => void;
  companyProfile?: CompanySnapshot | null;
}

export function StockRejectionView({ rejection, onClose, companyProfile }: StockRejectionViewProps) {
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
        documentType={"Stock Rejection"}
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
          const clonedElement = clonedDoc.getElementById('rejection-print-content');
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

      pdf.save(`StockRejection-${rejection.rejection_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  return (
    <>
      <ResponsiveDocumentPreview
        title={`Stock Rejection ${rejection.rejection_number}`}
        onPrint={handlePrint}
        onDownloadPDF={handleDownloadPDF}
        onClose={onClose}
        disabled={!logoReady}
        disabledTitle="Loading company logo…"
        printLabel="Print"
        pdfLabel="PDF"
      >
        <div id="rejection-print-content" ref={printRef} className="p-4 sm:p-8">
            <DocumentHeader co={co} title="STOCK REJECTION" titleClassName="text-red-600" />

            <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2">
              <div className="flex justify-between">
                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 flex-1">
                  <div>
                    <span className="font-bold">Product:</span>
                    <span className="font-semibold"> {rejection.product.product_name}</span>
                  </div>
                  <div>
                    <span className="font-bold">Product Code:</span>
                    <span className="ml-2">{rejection.product.product_code}</span>
                  </div>
                  <div className="pt-1">
                    <span className="font-bold">Batch Number:</span>
                    <span className="ml-2">{rejection.batch.batch_number}</span>
                  </div>
                  <div>
                    <span className="font-bold">Batch Stock:</span>
                    <span className="ml-2">{rejection.batch.current_stock.toLocaleString()} {rejection.product.unit}</span>
                  </div>
                </div>

                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 text-right" style={{minWidth: '220px'}}>
                  <div>
                    <span className="font-bold">Rejection No:</span>
                    <span className="ml-2">{rejection.rejection_number}</span>
                  </div>
                  <div>
                    <span className="font-bold">Date:</span>
                    <span className="ml-2">{formatDate(rejection.rejection_date)}</span>
                  </div>
                  <div className="pt-1">
                    <span className="font-bold">Qty Rejected:</span>
                    <span className="ml-2 text-red-600 font-semibold">{rejection.quantity_rejected.toLocaleString()} {rejection.product.unit}</span>
                  </div>
                  <div>
                    <span className="font-bold">Status:</span>
                    <span className={`ml-2 px-2 py-0.5 rounded text-xs font-semibold ${
                      rejection.status === 'approved' ? 'bg-green-100 text-green-800' :
                      rejection.status === 'rejected' ? 'bg-red-100 text-red-800' :
                      rejection.status === 'disposed' ? 'bg-gray-100 text-gray-800' :
                      'bg-yellow-100 text-yellow-800'
                    }`}>
                      {rejection.status.replace('_', ' ').toUpperCase()}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="mb-3 border-2 border-black print:mb-2">
              <table className="w-full text-xs print:text-[10px]">
                <thead>
                  <tr className="border-b-2 border-black bg-white">
                    <th className="border-r border-black p-2 text-left font-bold print:p-1">Rejection Details</th>
                    <th className="p-2 text-left font-bold print:p-1">Financial Impact</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="border-r border-black p-2 print:p-1 align-top">
                      <div className="space-y-2">
                        <div>
                          <span className="font-bold">Reason: </span>
                          <span className="uppercase">{rejection.rejection_reason.replace('_', ' ')}</span>
                        </div>
                        <div>
                          <span className="font-bold">Details: </span>
                          <p className="mt-1">{rejection.rejection_details}</p>
                        </div>
                        {rejection.inspection_report && (
                          <div>
                            <span className="font-bold">Inspection Report: </span>
                            <p className="mt-1">{rejection.inspection_report}</p>
                          </div>
                        )}
                        <div>
                          <span className="font-bold">Disposition: </span>
                          <span className="uppercase">{rejection.disposition.replace('_', ' ')}</span>
                        </div>
                      </div>
                    </td>
                    <td className="p-2 print:p-1 align-top">
                      <div className="space-y-1">
                        <div className="flex justify-between">
                          <span>Unit Cost:</span>
                          <span className="font-semibold">{formatCurrency(rejection.unit_cost)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Quantity:</span>
                          <span className="font-semibold">{rejection.quantity_rejected.toLocaleString()} {rejection.product.unit}</span>
                        </div>
                        <div className="flex justify-between pt-1 border-t-2 border-black">
                          <span className="font-bold">Total Loss:</span>
                          <span className="font-bold text-red-600">{formatCurrency(rejection.financial_loss)}</span>
                        </div>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {rejection.photos && rejection.photos.length > 0 && (
              <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2 print:hidden">
                <h3 className="text-sm font-bold mb-2">Rejection Photos</h3>
                <div className="grid grid-cols-3 gap-2">
                  {rejection.photos.map((photo: any, index: number) => (
                    <div key={index} className="border border-gray-300 rounded overflow-hidden">
                      <img
                        src={photo.url}
                        alt={`Rejection photo ${index + 1}`}
                        className="w-full h-32 object-cover"
                      />
                      <div className="text-xs p-1 bg-gray-50 text-center">
                        Photo {index + 1}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="border-2 border-black">
              <div className="grid grid-cols-3 gap-0 text-xs print:text-[10px]">
                <div className="p-3 border-r-2 border-black print:p-2 text-center">
                  <p className="font-semibold mb-12 print:mb-10">Inspected By</p>
                  <div className="border-t border-black pt-1 mx-4">QC Inspector</div>
                </div>

                <div className="p-3 border-r-2 border-black print:p-2 text-center">
                  <p className="font-semibold mb-12 print:mb-10">Reviewed By</p>
                  <div className="border-t border-black pt-1 mx-4">QC Manager</div>
                </div>

                <div className="p-3 print:p-2 text-center">
                  <p className="font-semibold mb-1">Approved By</p>
                  <p className="font-semibold mb-9 print:mb-7">{co.company_name}</p>
                  <div className="border-t border-black pt-1 mx-4">Management</div>
                </div>
              </div>
            </div>
          </div>
      </ResponsiveDocumentPreview>

      <DocumentPrintStyles contentId="rejection-print-content" />
    </>
  );
}
