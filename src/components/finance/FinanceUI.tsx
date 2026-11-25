import { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import {
  ArchiveRestore, CheckCircle2, Copy, Eye, FileClock, FileDown,
  Link2, Paperclip, Pencil, Printer, Trash2, XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  BADGE_APPROVED, BADGE_DRAFT, BADGE_INFO, BADGE_PARTIAL, BADGE_PENDING,
  BADGE_POSTED, BADGE_RECONCILED, BADGE_REJECTED, BADGE_UNPAID,
  BTN_DANGER, BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, BTN_SUCCESS,
  ICON_BTN, ICON_BTN_DANGER, ICON_BTN_INFO, ICON_BTN_SUCCESS, ICON_SIZE,
  INPUT, SELECT,
} from './uiTokens';

export const FINANCE_ACTION_ICONS = {
  view: Eye,
  edit: Pencil,
  attachment: Paperclip,
  approve: CheckCircle2,
  reject: XCircle,
  reverse: ArchiveRestore,
  delete: Trash2,
  bankLink: Link2,
  print: Printer,
  export: FileDown,
  history: FileClock,
  clone: Copy,
} satisfies Record<string, LucideIcon>;

export type FinanceButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';

const BUTTON_CLASS: Record<FinanceButtonVariant, string> = {
  primary: BTN_PRIMARY,
  secondary: BTN_SECONDARY,
  danger: BTN_DANGER,
  success: BTN_SUCCESS,
  ghost: BTN_GHOST,
};

export function FinanceButton({
  variant = 'secondary', className = '', children, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: FinanceButtonVariant;
  children: ReactNode;
}) {
  return <button className={`${BUTTON_CLASS[variant]} ${className}`} {...props}>{children}</button>;
}

export function FinanceInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input name="field" aria-label="Field" className={`${INPUT} ${className}`} {...props} />;
}

export function FinanceSelect({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select name="field" aria-label="Field" className={`${SELECT} ${className}`} {...props} />;
}

export type FinanceStatus =
  | 'posted' | 'draft' | 'approved' | 'pending' | 'rejected'
  | 'paid' | 'partial' | 'unpaid' | 'reconciled' | 'info'
  | 'reversed' | 'cancelled' | 'overdue' | 'waiting' | 'recorded' | 'reported';

const BADGE_CLASS: Record<FinanceStatus, string> = {
  posted: BADGE_POSTED,
  draft: BADGE_DRAFT,
  approved: BADGE_APPROVED,
  pending: BADGE_PENDING,
  rejected: BADGE_REJECTED,
  paid: BADGE_POSTED,
  partial: BADGE_PARTIAL,
  unpaid: BADGE_UNPAID,
  reconciled: BADGE_RECONCILED,
  info: BADGE_INFO,
  reversed: BADGE_DRAFT,
  cancelled: BADGE_DRAFT,
  overdue: BADGE_UNPAID,
  waiting: 'bg-orange-100 text-orange-700',
  recorded: 'bg-blue-100 text-blue-700',
  reported: 'bg-green-100 text-green-700',
};

export function FinanceBadge({ status, children, className = '', ...props }: HTMLAttributes<HTMLSpanElement> & {
  status: FinanceStatus;
  children?: ReactNode;
  className?: string;
}) {
  return <span data-finance-badge="true" className={`finance-badge ${BADGE_CLASS[status]} ${className}`} {...props}>{children ?? status}</span>;
}

export type FinanceAction = keyof typeof FINANCE_ACTION_ICONS;

const ACTION_CLASS: Partial<Record<FinanceAction, string>> = {
  view: ICON_BTN_INFO,
  edit: ICON_BTN_INFO,
  approve: ICON_BTN_SUCCESS,
  reject: ICON_BTN_DANGER,
  reverse: ICON_BTN,
  delete: ICON_BTN_DANGER,
  bankLink: ICON_BTN_INFO,
};

export function FinanceActionButton({ action, label, className = '', ...props }:
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> & {
    action: FinanceAction;
    label?: string;
  }) {
  const Icon = FINANCE_ACTION_ICONS[action];
  const title = label ?? `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`finance-icon-button ${ACTION_CLASS[action] ?? ICON_BTN} disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent ${className}`}
      {...props}
    >
      <Icon className={ICON_SIZE} />
    </button>
  );
}

/** Canonical table action order. Omit unavailable actions; never reorder them. */
export const FINANCE_ACTION_ORDER: readonly FinanceAction[] = [
  'view', 'edit', 'attachment', 'approve', 'reject', 'reverse', 'delete',
];
