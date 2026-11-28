import { useState, type ReactNode } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Printer, Download, X } from 'lucide-react';

interface ResponsiveDocumentPreviewProps {
  title: ReactNode;
  badge?: ReactNode;
  extraActions?: ReactNode;
  onPrint: () => void;
  onDownloadPDF?: () => void;
  onClose: () => void;
  disabled?: boolean;
  disabledTitle?: string;
  printLabel?: string;
  pdfLabel?: string;
  children: ReactNode;
}

export function ResponsiveDocumentPreview({
  title,
  badge,
  extraActions,
  onPrint,
  onDownloadPDF,
  onClose,
  disabled = false,
  disabledTitle,
  printLabel = 'Print',
  pdfLabel = 'PDF',
  children,
}: ResponsiveDocumentPreviewProps) {
  const [zoom, setZoom] = useState<'fit' | 75 | 100 | 125>('fit');

  const zoomScale =
    zoom === 75 ? 0.75 : zoom === 100 ? 1 : zoom === 125 ? 1.25 : undefined;

  return (
    <div className="doc-print-root fixed inset-0 z-50 overflow-y-auto bg-gray-900/75 print:static print:bg-white print:overflow-visible">
      <div className="doc-print-scroll flex min-h-screen items-start justify-center p-1.5 sm:p-4 sm:pt-8 print:p-0 print:min-h-0 print:block">
        <div className="doc-print-sheet relative w-full max-w-5xl bg-white shadow-xl rounded-lg sm:rounded-xl overflow-hidden print:shadow-none print:max-w-full print:rounded-none">
          {/* Action Toolbar — Hidden on print */}
          <div
            className="doc-print-hide sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-white px-3 py-2 sm:px-5 sm:py-3"
            style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-sm sm:text-lg font-bold text-gray-900 truncate">{title}</h2>
              {badge}
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
              {extraActions}
              {/* Mobile/Tablet Zoom Controls */}
              <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5 text-[11px] font-semibold">
                <button
                  type="button"
                  onClick={() => setZoom('fit')}
                  className={`no-compact px-2 py-1 rounded-md transition ${
                    zoom === 'fit' ? 'bg-white text-blue-600 shadow-2xs' : 'text-gray-600 hover:text-gray-900'
                  }`}
                  title="Fit to screen"
                >
                  <span className="inline-flex items-center gap-1">
                    <Maximize2 className="w-3 h-3" />
                    <span className="hidden xs:inline">Fit</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setZoom(75)}
                  className={`no-compact px-1.5 py-1 rounded-md transition ${
                    zoom === 75 ? 'bg-white text-blue-600 shadow-2xs' : 'text-gray-600 hover:text-gray-900'
                  }`}
                  title="75% zoom"
                >
                  <ZoomOut className="w-3 h-3 inline sm:hidden" />
                  <span className="hidden sm:inline">75%</span>
                </button>
                <button
                  type="button"
                  onClick={() => setZoom(100)}
                  className={`no-compact px-1.5 py-1 rounded-md transition ${
                    zoom === 100 ? 'bg-white text-blue-600 shadow-2xs' : 'text-gray-600 hover:text-gray-900'
                  }`}
                  title="100% zoom"
                >
                  100%
                </button>
                <button
                  type="button"
                  onClick={() => setZoom(125)}
                  className={`no-compact hidden sm:inline-block px-1.5 py-1 rounded-md transition ${
                    zoom === 125 ? 'bg-white text-blue-600 shadow-2xs' : 'text-gray-600 hover:text-gray-900'
                  }`}
                  title="125% zoom"
                >
                  <ZoomIn className="w-3 h-3 inline mr-0.5" />
                  125%
                </button>
              </div>

              <button
                type="button"
                onClick={onPrint}
                disabled={disabled}
                title={disabled ? disabledTitle : printLabel}
                className="no-compact inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 sm:px-3.5 py-1.5 text-xs sm:text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-wait"
              >
                <Printer className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <span>{printLabel}</span>
              </button>

              {onDownloadPDF && (
                <button
                  type="button"
                  onClick={onDownloadPDF}
                  disabled={disabled}
                  title={disabled ? disabledTitle : pdfLabel}
                  className="no-compact inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-2.5 sm:px-3.5 py-1.5 text-xs sm:text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-wait"
                >
                  <Download className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span>{pdfLabel}</span>
                </button>
              )}

              <button
                type="button"
                onClick={onClose}
                className="no-compact rounded-lg bg-gray-100 p-1.5 sm:p-2 text-gray-600 hover:bg-gray-200"
                aria-label="Close preview"
              >
                <X className="h-4 w-4 sm:h-5 sm:w-5" />
              </button>
            </div>
          </div>

          {/* Scrollable / Zoomable Preview Viewport (Print layout preserved unmodified) */}
          <div className="w-full overflow-x-auto overscroll-x-contain print:overflow-visible">
            <div
              className="origin-top-left print:!transform-none print:!w-full"
              style={
                zoomScale
                  ? { transform: `scale(${zoomScale})`, width: `${100 / zoomScale}%` }
                  : undefined
              }
            >
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
