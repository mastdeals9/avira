import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  maxWidth?: string;
  maxHeight?: string;
  noPadding?: boolean;
}

export function Modal({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
  maxWidth,
  maxHeight,
  noPadding,
}: ModalProps) {
  const { t } = useLanguage();
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevIsOpenRef = useRef(false);

  // Scroll reset effect: runs ONLY when modal transitions from closed (false) to open (true).
  // It will NOT reset scrollTop on parent re-renders or onClose reference changes.
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen]);

  // Escape key handler
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-6xl',
  };

  const widthClass = maxWidth || sizeClasses[size];
  const heightClass = maxHeight || 'h-[92dvh] sm:h-auto sm:max-h-[86dvh]';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-3 lg:p-4 overflow-hidden">
      <div
        className="fixed inset-0 bg-gray-900 bg-opacity-50 transition-opacity backdrop-blur-2xs"
        onClick={onClose}
      />

      <div
        className={`relative bg-white rounded-t-2xl sm:rounded-xl shadow-2xl ${widthClass} w-full max-w-full sm:max-w-[calc(100vw-2rem)] ${heightClass} flex flex-col min-h-0 overflow-hidden z-10 sm:my-auto`}
      >
        {!noPadding && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 sm:px-4 sm:py-2.5 border-b border-gray-200 shrink-0 bg-slate-50/90 backdrop-blur-xs z-10">
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-bold text-gray-900 leading-tight truncate">{title}</h3>
              {subtitle && <div className="text-[11px] sm:text-xs text-gray-500 font-normal mt-0.5 truncate">{subtitle}</div>}
            </div>
            <button
              onClick={onClose}
              aria-label={t('common.close')}
              className="no-compact p-1.5 rounded-lg hover:bg-gray-200/60 text-gray-500 hover:text-gray-700 transition shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div
          ref={bodyRef}
          className={`flex-1 min-h-0 min-w-0 ${noPadding ? 'overflow-hidden' : 'p-3 sm:p-4 overflow-y-auto'}`}
        >
          {children}
        </div>

        {footer && (
          <div
            className="px-3 py-2 sm:px-4 sm:py-2.5 border-t border-gray-200 shrink-0 bg-gray-50/90 backdrop-blur-xs flex flex-wrap items-center justify-end gap-2 sm:gap-3 z-10"
            style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 8px)' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
