import { useState, type ReactNode } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';

export interface ActiveFilterChip {
  key: string;
  label: string;
  onRemove: () => void;
}

interface ResponsiveFilterBarProps {
  /** Primary search input rendered inline on all viewports */
  searchInput?: ReactNode;
  /** Inline filter controls shown directly on md+ and inside the mobile bottom sheet on <md */
  filters: ReactNode;
  /** Optional primary/secondary action buttons (e.g. Add, Export) */
  actions?: ReactNode;
  /** Active filter chips displayed below the mobile search bar */
  activeChips?: ActiveFilterChip[];
  /** Number of active filters (defaults to activeChips.length) */
  activeCount?: number;
  /** Optional clear-all handler shown in mobile filter sheet and chips row */
  onClearAll?: () => void;
  /** Optional title for the mobile filter bottom sheet */
  sheetTitle?: string;
  /** Extra classes for outer container */
  className?: string;
  /** Breakpoint at which inline desktop filters appear (defaults to 'md') */
  breakpoint?: 'md' | 'lg';
}

export function ResponsiveFilterBar({
  searchInput,
  filters,
  actions,
  activeChips = [],
  activeCount,
  onClearAll,
  sheetTitle = 'Filters',
  className = '',
  breakpoint = 'md',
}: ResponsiveFilterBarProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const count = activeCount ?? activeChips.length;
  const desktopBarClass = breakpoint === 'lg' ? 'hidden lg:flex' : 'hidden md:flex';
  const mobileBarClass = breakpoint === 'lg' ? 'lg:hidden' : 'md:hidden';

  return (
    <div className={`min-w-0 ${className}`}>
      {/* Desktop & Tablet inline bar */}
      <div className={`${desktopBarClass} flex-wrap items-center gap-1.5 lg:gap-2 min-w-0`}>
        {searchInput && <div className="min-w-0 flex-1 max-w-xs">{searchInput}</div>}
        <div className="flex flex-wrap items-center gap-1.5 lg:gap-2 min-w-0 flex-1">
          {filters}
        </div>
        {actions && <div className="flex items-center gap-1.5 shrink-0 ml-auto">{actions}</div>}
      </div>

      {/* Mobile / Compact bar */}
      <div className={`${mobileBarClass} space-y-1.5 min-w-0`}>
        <div className="flex items-center gap-1.5 min-w-0">
          {searchInput && <div className="flex-1 min-w-0">{searchInput}</div>}
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className={`no-compact inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold shrink-0 min-h-[36px] transition ${
              count > 0
                ? 'bg-blue-50 border-blue-300 text-blue-700'
                : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Filters</span>
            {count > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-white text-[10px] font-bold">
                {count}
              </span>
            )}
          </button>
          {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
        </div>

        {/* Removable active filter chips */}
        {activeChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {activeChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[11px] font-medium max-w-full"
              >
                <span className="truncate">{chip.label}</span>
                <button
                  type="button"
                  onClick={chip.onRemove}
                  className="no-compact p-0.5 rounded-full hover:bg-blue-100 text-blue-600"
                  aria-label={`Remove ${chip.label}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            {onClearAll && (
              <button
                type="button"
                onClick={onClearAll}
                className="no-compact text-[11px] font-semibold text-gray-500 hover:text-gray-800 px-1.5 py-0.5"
              >
                Clear all
              </button>
            )}
          </div>
        )}
      </div>

      {/* Mobile Bottom Sheet Filter Drawer */}
      {sheetOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex flex-col justify-end">
          <div
            className="fixed inset-0 bg-black/45 backdrop-blur-2xs"
            onClick={() => setSheetOpen(false)}
            aria-hidden="true"
          />
          <div
            className="relative z-10 bg-white rounded-t-2xl shadow-2xl max-h-[85dvh] flex flex-col overflow-hidden"
            style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 12px)' }}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-blue-600" />
                <h3 className="text-sm font-bold text-gray-900">{sheetTitle}</h3>
                {count > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold">
                    {count} active
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="no-compact p-1.5 rounded-lg text-gray-500 hover:bg-gray-100"
                aria-label="Close filters"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {filters}
            </div>

            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-gray-200 bg-gray-50 shrink-0">
              {onClearAll ? (
                <button
                  type="button"
                  onClick={() => {
                    onClearAll();
                    setSheetOpen(false);
                  }}
                  className="no-compact px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 text-xs font-semibold min-h-[38px]"
                >
                  Clear All
                </button>
              ) : (
                <div />
              )}
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="no-compact flex-1 max-w-[180px] px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 min-h-[38px]"
              >
                Apply Filters
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
