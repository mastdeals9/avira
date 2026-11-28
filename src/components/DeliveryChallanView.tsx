import { useRef, useEffect, useState } from 'react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { type CompanySnapshot } from '../types/company';
import { useResolvedCompanyLogo, waitForImages } from '../utils/companyLogoUrl';

import { DocumentHeader } from './DocumentHeader';
import { DocumentPrintStyles } from './DocumentPrintStyles';
import { ResponsiveDocumentPreview } from './ui/ResponsiveDocumentPreview';
import { SnapshotMissingError } from './SnapshotMissingError';
import { formatUnit } from '../utils/unitDisplay';
import { resolveItemPackaging } from '../utils/deliveryPackaging';
import { supabase } from '../lib/supabase';

interface ChallanItem {
  id: string;
  product_id: string;
  batch_id: string;
  quantity: number;
  pack_size: number | null;
  pack_type: string | null;
  number_of_packs: number | null;
  products?: {
    product_name: string;
    product_code: string;
    unit: string;
    per_pack_weight?: number | null;
    pack_type?: string | null;
    packaging_type?: string | null;
  } | null;
  batches?: {
    batch_number: string;
    expiry_date: string | null;
    product_sources?: { supplier_name: string | null; grade: string | null } | null;
    products?: {
      product_name: string;
      product_code: string;
      unit: string;
      per_pack_weight?: number | null;
      pack_type?: string | null;
      packaging_type?: string | null;
    } | null;
    packaging_details: string | null;
    per_pack_weight?: number | null;
    pack_type?: string | null;
  } | null;
}

interface DeliveryChallanViewProps {
  challan: {
    id: string;
    challan_number: string;
    customer_id: string;
    challan_date: string;
    delivery_address: string;
    vehicle_number: string | null;
    driver_name: string | null;
    status: string;
    notes: string | null;
    customers?: {
      company_name: string;
      address: string;
      city: string;
      phone: string;
      pbf_license: string;
    };
  };
  items: ChallanItem[];
  onClose: () => void;
  companyProfile?: CompanySnapshot | null;
}

export function DeliveryChallanView({ challan, items, onClose, companyProfile }: DeliveryChallanViewProps) {
  const printRef = useRef<HTMLDivElement>(null);
  // useResolvedCompanyLogo runs unconditionally so React hook order stays
  // stable when we early-return below. It's cheap when logoUrl is null.
  const { ready: logoReady } = useResolvedCompanyLogo(companyProfile?.company_logo_url);

  // Maintain local state to enrich items from product master if caller passed minimal fields
  const [enrichedItems, setEnrichedItems] = useState<ChallanItem[]>(items);

  useEffect(() => {
    setEnrichedItems(items);
    const missingProductIds = items
      .filter(it => (!it.pack_size || !it.pack_type) && !it.products?.per_pack_weight && it.product_id)
      .map(it => it.product_id);

    if (missingProductIds.length === 0) return;

    let isMounted = true;
    (async () => {
      try {
        const { data: prods } = await supabase
          .from('products')
          .select('id, per_pack_weight, pack_type, packaging_type, unit')
          .in('id', Array.from(new Set(missingProductIds)));

        if (!isMounted || !prods || prods.length === 0) return;

        const prodMap = new Map(prods.map(p => [p.id, p]));
        setEnrichedItems(prev => prev.map(it => {
          const pm = prodMap.get(it.product_id);
          if (!pm) return it;
          return {
            ...it,
            products: {
              ...(it.products || { product_name: '', product_code: '', unit: pm.unit || '' }),
              per_pack_weight: it.products?.per_pack_weight ?? pm.per_pack_weight,
              pack_type: it.products?.pack_type ?? pm.pack_type,
              packaging_type: it.products?.packaging_type ?? pm.packaging_type,
            }
          };
        }));
      } catch (err) {
        console.error('Failed to enrich packaging from product master:', err);
      }
    })();

    return () => { isMounted = false; };
  }, [items]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Refuse to render with FALLBACK_COMPANY — misprinting the customer's
  // copy with a placeholder company header would misrepresent the
  // document. Backfill migration 20260714210000 restores NULL snapshots
  // in bulk; one-off legacy rows should be repaired manually.
  if (!companyProfile) {
    return (
      <SnapshotMissingError
        documentType="Delivery Challan"
        documentNumber={challan.challan_number}
        onClose={onClose}
      />
    );
  }
  const co = companyProfile;

  const handlePrint = async () => {
    // Wait for the resolved logo (and every other <img> in the printable
    // subtree) before the browser paints the print page — otherwise the
    // header logo can print blank when signed-URL resolution is still in
    // flight. Bounded 5s timeout inside waitForImages.
    if (printRef.current) await waitForImages(printRef.current);
    window.print();
  };

  const handleDownloadPDF = async () => {
    if (!printRef.current) return;
    // Same reason as handlePrint: html2canvas rasterises the current DOM
    // and won't wait for the signed URL to resolve.
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
          const clonedElement = clonedDoc.getElementById('challan-print-content');
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

      pdf.save(`Delivery-Challan-${challan.challan_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const year = date.getFullYear();
    return `${day.toString().padStart(2, '0')}-${month.toString().padStart(2, '0')}-${year}`;
  };

  const formatExpiryDate = (dateString: string) => {
    const date = new Date(dateString);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    return `${month} ${year}`;
  };

  const itemsToDisplay = enrichedItems;
  const totalQuantity = itemsToDisplay.reduce((sum, item) => sum + item.quantity, 0);
  // Authoritative inventory/base unit from product master
  const firstItemUnit = formatUnit(itemsToDisplay[0]?.products?.unit || itemsToDisplay[0]?.batches?.products?.unit);

  return (
    <>
      <ResponsiveDocumentPreview
        title={`Surat Jalan ${challan.challan_number}`}
        onPrint={handlePrint}
        onDownloadPDF={handleDownloadPDF}
        onClose={onClose}
        disabled={!logoReady}
        disabledTitle="Loading company logo…"
        printLabel="Cetak"
        pdfLabel="PDF"
      >
        {/* Challan Content */}
        <div id="challan-print-content" ref={printRef} className="p-4 sm:p-8">
            {/* Header Section - Company Details */}
            <DocumentHeader co={co} title="SURAT JALAN" />

            {/* Customer and Challan Details */}
            <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2">
              <div className="flex justify-between">
                {/* Left - Customer Details */}
                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 flex-1">
                  <div className="mb-1">
                    <span className="font-bold">Company Name:</span>
                  </div>
                  <div className="ml-4 mb-2">
                    <p className="font-semibold">{challan.customers?.company_name || ''}</p>
                  </div>
                  <div className="mb-1">
                    <span className="font-bold">Address:</span>
                  </div>
                  <div className="ml-4 mb-2">
                    <p>{challan.delivery_address || ''}</p>
                    <p>{challan.customers?.city || ''}</p>
                  </div>
                  <div className="mb-1">
                    <span className="font-bold">Phone:</span>
                    <span className="ml-2">{challan.customers?.phone || '-'}</span>
                  </div>
                  <div>
                    <span className="font-bold">No.Izin PBF:</span>
                    <span className="ml-2">{challan.customers?.pbf_license || '-'}</span>
                  </div>
                </div>

                {/* Right - Challan Details */}
                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 text-right w-64">
                  <div className="mb-1">
                    <span className="font-bold">Challan No: </span>
                    <span>{challan.challan_number}</span>
                  </div>
                  <div className="mb-1">
                    <span className="font-bold">Challan Date: </span>
                    <span>{formatDate(challan.challan_date)}</span>
                  </div>
                  {challan.vehicle_number && (
                    <div>
                      <span className="font-bold">Vehicle No: </span>
                      <span>{challan.vehicle_number}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Items Table */}
            <div className="mb-2 border-2 border-black print:mb-1.5">
              <table className="w-full border-collapse text-[9px] print:text-[8px]">
                <thead>
                  <tr className="border-b-2 border-black">
                    <th className="border-r border-black px-1 py-1.5 text-center font-bold print:px-0.5 print:py-1" style={{ width: '3%' }}>No</th>
                    <th className="border-r border-black px-1 py-1.5 text-left font-bold print:px-0.5 print:py-1" style={{ width: '27%' }}>Nama Produk<br/>Product Name</th>
                    <th className="border-r border-black px-1 py-1.5 text-center font-bold print:px-0.5 print:py-1" style={{ width: '13%' }}>No Batch<br/>Batch No</th>
                    <th className="border-r border-black px-1 py-1.5 text-center font-bold print:px-0.5 print:py-1" style={{ width: '8%' }}>Exp.<br/>Date</th>
                    <th className="border-r border-black px-1 py-1.5 text-center font-bold print:px-0.5 print:py-1" style={{ width: '15%' }}>Kemasan<br/>Packaging</th>
                    <th className="border-r border-black px-1 py-1.5 text-center font-bold print:px-0.5 print:py-1" style={{ width: '6%' }}>Jml<br/>Packs</th>
                    <th className="px-1 py-1.5 text-center font-bold print:px-0.5 print:py-1" style={{ width: '10%' }}>Kuantitas<br/>Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {itemsToDisplay.map((item, index) => {
                    const resolved = resolveItemPackaging(item, firstItemUnit);
                    return (
                      <tr key={item.id} className="border-b border-black">
                        <td className="border-r border-black px-1 py-1 text-center print:px-0.5 print:py-0.5">{index + 1}</td>
                        <td className="border-r border-black px-1 py-1 print:px-0.5 print:py-0.5">{item.products?.product_name || item.batches?.products?.product_name || '-'}</td>
                        <td className="border-r border-black px-1 py-1 text-center print:px-0.5 print:py-0.5">{item.batches?.batch_number}<br/><span className="text-[8px]">{item.batches?.product_sources?.supplier_name || 'Not recorded'}</span></td>
                        <td className="border-r border-black px-1 py-1 text-center print:px-0.5 print:py-0.5">
                          {item.batches?.expiry_date ? formatExpiryDate(item.batches.expiry_date) : '-'}
                        </td>
                        <td className="border-r border-black px-1 py-1 text-center print:px-0.5 print:py-0.5">
                          {resolved.displayPackaging}
                        </td>
                        <td className="border-r border-black px-1 py-1 text-center print:px-0.5 print:py-0.5">
                          {resolved.displayPacks}
                        </td>
                        <td className="px-1 py-1 text-center print:px-0.5 print:py-0.5">{item.quantity.toLocaleString()} {formatUnit(item.products?.unit || item.batches?.products?.unit || firstItemUnit)}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-black bg-gray-50 font-bold">
                    <td colSpan={6} className="border-r border-black px-1 py-1 text-right print:px-0.5 print:py-0.5">
                      Total Kuantitas / Total Quantity:
                    </td>
                    <td className="px-1 py-1 text-center print:px-0.5 print:py-0.5">
                      {totalQuantity.toLocaleString()} {firstItemUnit}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Notes Section */}
            <div className="mb-2 p-1.5 print:mb-1.5 print:p-1">
              <p className="text-[9px] font-semibold print:text-[8px]">Catatan / Notes:</p>
              {challan.notes ? (
                <p className="text-[9px] print:text-[8px] mt-0.5">{challan.notes}</p>
              ) : (
                <p className="text-[9px] print:text-[8px] mt-0.5">Produk dikirim dalam kondisi sesuai persyaratan penyimpanan / Goods are delivered under controlled storage conditions.</p>
              )}
            </div>

            {/* Signature Section */}
            <div className="grid grid-cols-4 gap-2 print:gap-1.5">
              <div className="border-2 border-black p-1.5 text-center print:p-1">
                <div className="mb-1.5 text-[9px] font-semibold print:mb-1 print:text-[8px]">
                  Disiapkan Oleh<br/>Prepared By
                </div>
                <div className="mb-8 print:mb-6">
                  <div className="h-10 print:h-8"></div>
                </div>
                <div className="border-t-2 border-black pt-1.5 print:pt-1">
                  <p className="text-[9px] print:text-[8px]">Tanda Tangan & Tanggal</p>
                  <p className="text-[9px] print:text-[8px]">Signature & Date</p>
                  <p className="text-[8px] font-semibold mt-0.5 print:text-[7px] print:mt-0">{co.company_name}</p>
                </div>
              </div>
              <div className="border-2 border-black p-1.5 text-center print:p-1">
                <div className="mb-1.5 text-[9px] font-semibold print:mb-1 print:text-[8px]">
                  Dikirim Oleh<br/>Delivered By
                </div>
                <div className="mb-8 print:mb-6">
                  <div className="h-10 print:h-8"></div>
                </div>
                <div className="border-t-2 border-black pt-1.5 print:pt-1">
                  <p className="text-[9px] print:text-[8px]">Tanda Tangan & Tanggal</p>
                  <p className="text-[9px] print:text-[8px]">Signature & Date</p>
                  <p className="text-[8px] font-semibold mt-0.5 print:text-[7px] print:mt-0">{co.company_name}</p>
                </div>
              </div>
              <div className="border-2 border-black p-1.5 text-center print:p-1">
                <div className="mb-1.5 text-[9px] font-semibold print:mb-1 print:text-[8px]">
                  Farmasi<br/>Pharmacist
                </div>
                <div className="mb-8 print:mb-6">
                  <div className="h-10 print:h-8"></div>
                </div>
                <div className="border-t-2 border-black pt-1.5 print:pt-1">
                  <p className="text-[9px] print:text-[8px]">Tanda Tangan & Tanggal</p>
                  <p className="text-[9px] print:text-[8px]">Signature & Date</p>
                  <p className="text-[8px] font-semibold mt-0.5 print:text-[7px] print:mt-0">{co.company_name}</p>
                </div>
              </div>
              <div className="border-2 border-black p-1.5 text-center print:p-1">
                <div className="mb-1.5 text-[9px] font-semibold print:mb-1 print:text-[8px]">
                  Diterima Oleh<br/>Received By
                </div>
                <div className="mb-8 print:mb-6">
                  <div className="h-10 print:h-8"></div>
                </div>
                <div className="border-t-2 border-black pt-1.5 print:pt-1">
                  <p className="text-[9px] print:text-[8px]">Tanda Tangan & Tanggal</p>
                  <p className="text-[9px] print:text-[8px]">Signature & Date</p>
                  <p className="text-[8px] font-semibold mt-0.5 print:text-[7px] print:mt-0">{challan.customers?.company_name || ''}</p>
                </div>
              </div>
            </div>
          </div>
      </ResponsiveDocumentPreview>

      <DocumentPrintStyles contentId="challan-print-content" />
    </>
  );
}
