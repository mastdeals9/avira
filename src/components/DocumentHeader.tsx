import { CompanyLogo } from './CompanyLogo';
import { type CompanySnapshot } from '../types/company';

interface DocumentHeaderProps {
  co: CompanySnapshot;
  /** Document title, e.g. "INVOICE", "SURAT JALAN". */
  title: string;
  /** Optional extra classes for the title (used for color accents, e.g. red Credit Note). */
  titleClassName?: string;
}

// Shared boxed header used by every printable business document
// (Invoice, Proforma, Delivery Challan, Purchase Order, Credit Note,
// Material Return, Stock Rejection). Centralises the company logo,
// company identity block, document title and PBF/CDOB licence lines so
// they render identically on screen, print preview, print and PDF export
// across Chrome, Safari and Edge.
//
// Layout contract:
//   • Logo lives in ONE fixed 80×80px container, object-fit: contain,
//     centered — it never stretches or crops regardless of the source
//     aspect ratio. The size is identical on screen and print so View /
//     Print / PDF match exactly.
//   • The company identity block is a fixed-max-width column that wraps
//     naturally (overflow-wrap) and can shrink (min-w-0) so long addresses
//     never overlap the right-aligned title.
//   • The title is flex-shrink-0 so it always keeps its width.
export function DocumentHeader({ co, title, titleClassName = '' }: DocumentHeaderProps) {
  return (
    <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2">
      <div className="mb-2 flex items-start justify-between gap-4">
        {/* Company Logo + Identity */}
        <div className="flex min-w-0 items-start gap-3">
          <div
            className="flex items-center justify-center"
            style={{ width: '80px', height: '80px', flexShrink: 0, backgroundColor: '#fff' }}
          >
            <CompanyLogo
              logoUrl={co.company_logo_url}
              alt={co.company_name}
              style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' }}
            />
          </div>
          <div className="min-w-0" style={{ maxWidth: '340px' }}>
            <h1 className="text-base font-bold print:text-sm" style={{ overflowWrap: 'break-word' }}>
              {co.company_name}
            </h1>
            {co.company_address && (
              <p className="text-xs print:text-[10px]" style={{ overflowWrap: 'break-word', whiteSpace: 'normal' }}>
                {co.company_address}
              </p>
            )}
            {co.company_phone && <p className="text-xs print:text-[10px]">Telp: {co.company_phone}</p>}
          </div>
        </div>

        {/* Document Title */}
        <div className="flex-shrink-0 text-right">
          <h2 className={`text-3xl font-bold print:text-2xl ${titleClassName}`}>{title}</h2>
        </div>
      </div>

      {/* Company Licenses */}
      <div className="text-xs space-y-0.5 print:text-[10px] print:space-y-0">
        <div>
          <span className="font-semibold">No izin PBF</span>
          <span className="ml-16">: {co.pbf_license?.replace(/^No izin PBF:\s*/i, '') ?? '—'}</span>
        </div>
        <div>
          <span className="font-semibold">No Sertifikasi CDOB</span>
          <span className="ml-4">: {co.cdob_certificate?.replace(/^No Sertifikasi CDOB:\s*/i, '') ?? '—'}</span>
        </div>
      </div>
    </div>
  );
}
