import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../../lib/supabase';
import { useFinance } from '../../contexts/FinanceContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { saveFinanceJournal, linkBankStatementLine } from '../../services/financeCommands';
import {
  Plus, Trash2, Search, BookOpen, FileText,
  ChevronDown, X, Loader2, Save, RotateCcw,
  Landmark, Link2, CheckCircle2
} from 'lucide-react';
import { showToast } from '../ToastNotification';
import { FinanceModal as Modal } from './FinanceModal';
import { FinanceActionButton } from './FinanceUI';
import { SapRow } from './SapLayout';
import { FloatingField, FLOAT_INPUT } from './FloatingField';
import { MoneyInput } from '../MoneyInput';
import {
  loadUnmatchedDebitBankTransactions,
  notifyFinanceReconciliationRefresh,
  rankCandidateLines,
  type BankTransactionLine
} from './bankTransactionLinking';

interface BankAccount {
  id: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  currency: string;
  coa_id: string;
}

interface LinkedBankAllocation {
  id: string;
  allocation_amount: number;
  payment_kind: string;
  created_at: string;
  totalLineAmount?: number;
  totalAllocated?: number;
  remainingUnallocated?: number;
  bank_statement_lines?: {
    id: string;
    transaction_date: string;
    description: string;
    reference: string;
    debit_amount: number;
    credit_amount: number;
    reconciliation_status: string;
    matching_status?: string;
    bank_account_id: string;
    bank_accounts?: {
      id: string;
      bank_name: string;
      account_name: string;
      account_number: string;
      currency: string;
      coa_id: string;
    };
  };
}

interface Account {
  id: string;
  code: string;
  name: string;
  account_type: string;
  normal_balance: string;
}

interface JournalLine {
  key: string;
  account_id: string;
  account_code: string;
  account_name: string;
  description: string;
  debit: number;
  credit: number;
}

interface JournalEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  source_module: string;
  total_debit: number;
  total_credit: number;
  is_posted: boolean;
  is_reversed?: boolean;
  is_cancelled?: boolean;
  cancellation_reason?: string | null;
  created_at: string;
}

interface JournalEntryDetail extends JournalEntry {
  lines: {
    line_number: number;
    account_id: string;
    description: string;
    debit: number;
    credit: number;
    chart_of_accounts: { code: string; name: string } | null;
  }[];
}

interface Template {
  name: string;
  description: string;
  lines: { accountCode: string; side: 'debit' | 'credit'; label: string }[];
}

interface GeneralJournalEntryProps {
  canManage: boolean;
  onNavigateToLedger: () => void;
  initialEditEntryId?: string | null;
  onEditComplete?: () => void;
}

const TEMPLATES: Template[] = [
  {
    name: 'Loan Received',
    description: 'Bank loan received into account',
    lines: [
      { accountCode: '111101', side: 'debit', label: 'Bank BCA - IDR' },
      { accountCode: '2210', side: 'credit', label: 'Bank Loans' },
    ],
  },
  {
    name: 'Loan Repayment',
    description: 'Repay bank loan from account',
    lines: [
      { accountCode: '2210', side: 'debit', label: 'Bank Loans' },
      { accountCode: '111101', side: 'credit', label: 'Bank BCA - IDR' },
    ],
  },
  {
    name: 'Loan Given',
    description: 'Loan given to external party',
    lines: [
      { accountCode: '1310', side: 'debit', label: 'Loan Receivable' },
      { accountCode: '111101', side: 'credit', label: 'Bank BCA - IDR' },
    ],
  },
  {
    name: 'Director Loan',
    description: 'Loan from director/owner',
    lines: [
      { accountCode: '111101', side: 'debit', label: 'Bank BCA - IDR' },
      { accountCode: '2220', side: 'credit', label: 'Loan from Vijay Lunkad' },
    ],
  },
  {
    name: 'Owner Contribution',
    description: 'Capital injected by owner into the business bank account',
    lines: [
      { accountCode: '111101', side: 'debit', label: 'Bank BCA - IDR' },
      { accountCode: '3100', side: 'credit', label: 'Owner Capital' },
    ],
  },
  {
    name: 'Staff Advance',
    description: 'Advance given to staff',
    lines: [
      { accountCode: '1160', side: 'debit', label: 'Staff Advances & Loans' },
      { accountCode: '1102', side: 'credit', label: 'Petty Cash' },
    ],
  },
  {
    name: 'Advance Recovery',
    description: 'Recover advance from staff salary',
    lines: [
      { accountCode: '6100', side: 'debit', label: 'Salaries & Wages' },
      { accountCode: '1160', side: 'credit', label: 'Staff Advances & Loans' },
    ],
  },
  {
    name: 'Salary Adjustment',
    description: 'Adjust salary or bonus entries',
    lines: [
      { accountCode: '6100', side: 'debit', label: 'Salaries & Wages' },
      { accountCode: '111101', side: 'credit', label: 'Bank BCA - IDR' },
    ],
  },
  {
    name: 'Interest Payment',
    description: 'Pay interest on loan',
    lines: [
      { accountCode: '7200', side: 'debit', label: 'Interest Expense' },
      { accountCode: '111101', side: 'credit', label: 'Bank BCA - IDR' },
    ],
  },
];

function createEmptyLine(): JournalLine {
  return {
    key: crypto.randomUUID(),
    account_id: '',
    account_code: '',
    account_name: '',
    description: '',
    debit: 0,
    credit: 0,
  };
}

export function GeneralJournalEntry({ canManage, onNavigateToLedger, initialEditEntryId, onEditComplete }: GeneralJournalEntryProps) {
  const { dateRange, triggerRefresh, refreshTrigger } = useFinance();
  const { t } = useLanguage();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [entryDate, setEntryDate] = useState(new Date().toISOString().split('T')[0]);
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<JournalLine[]>([createEmptyLine(), createEmptyLine()]);

  const [searchOpen, setSearchOpen] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dropdownPosition, setDropdownPosition] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const [viewEntry, setViewEntry] = useState<JournalEntryDetail | null>(null);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);

  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [hasBankGlMap, setHasBankGlMap] = useState<Map<string, boolean>>(new Map());
  const [bankAllocations, setBankAllocations] = useState<LinkedBankAllocation[]>([]);
  const [loadingBankAllocations, setLoadingBankAllocations] = useState(false);

  // Link bank modal state
  const [showLinkBankModal, setShowLinkBankModal] = useState(false);
  const [candidateBankLines, setCandidateBankLines] = useState<BankTransactionLine[]>([]);
  const [candidateSearchTerm, setCandidateSearchTerm] = useState('');
  const [selectedCandidateBankLineId, setSelectedCandidateBankLineId] = useState('');
  const [linkingBankAllocationAmount, setLinkingBankAllocationAmount] = useState<number>(0);
  const [loadingCandidateBankLines, setLoadingCandidateBankLines] = useState(false);
  const [submittingBankLink, setSubmittingBankLink] = useState(false);
  const [targetBankLinkEntry, setTargetBankLinkEntry] = useState<JournalEntryDetail | JournalEntry | null>(null);
  const [targetBankLinkEligible, setTargetBankLinkEligible] = useState<{
    bankAccount: BankAccount;
    isCredit: boolean;
    amount: number;
  } | null>(null);

  const [templateOpen, setTemplateOpen] = useState(false);
  const templateRef = useRef<HTMLDivElement>(null);

  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const isBalanced = totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.01;
  const hasAccounts = lines.filter(l => l.account_id).length >= 2;

  const loadAccounts = useCallback(async () => {
    const { data } = await supabase
      .from('chart_of_accounts')
      .select('id, code, name, account_type, normal_balance')
      .eq('is_header', false)
      .eq('is_active', true)
      .order('code');
    if (data) setAccounts(data);
  }, []);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    const { data: bData } = await supabase
      .from('bank_accounts')
      .select('id, bank_name, account_name, account_number, currency, coa_id')
      .eq('is_active', true);
    const activeBanks = bData || [];
    setBankAccounts(activeBanks);

    const { data } = await supabase
      .from('journal_entries')
      .select('id, entry_number, entry_date, description, source_module, total_debit, total_credit, is_posted, is_reversed, is_cancelled, cancellation_reason, created_at')
      .eq('source_module', 'manual')
      .gte('entry_date', dateRange.startDate)
      .lte('entry_date', dateRange.endDate)
      .order('created_at', { ascending: false });

    if (data) {
      setEntries(data);
      const entryIds = data.map((e) => e.id);
      const glMap = new Map<string, boolean>();
      if (entryIds.length > 0 && activeBanks.length > 0) {
        const bankCoaIds = new Set(activeBanks.map((b) => b.coa_id));
        const { data: linesData } = await supabase
          .from('journal_entry_lines')
          .select('journal_entry_id, account_id')
          .in('journal_entry_id', entryIds);
        (linesData || []).forEach((l) => {
          if (bankCoaIds.has(l.account_id)) {
            glMap.set(l.journal_entry_id, true);
          }
        });
      }
      setHasBankGlMap(glMap);
    }
    setLoading(false);
  }, [dateRange]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { loadEntries(); }, [loadEntries, refreshTrigger]);

  const updateDropdownPosition = useCallback(() => {
    if (searchOpen === null) return;
    const targetEl = searchContainerRef.current || triggerRefs.current[searchOpen];
    if (!targetEl) return;

    const rect = targetEl.getBoundingClientRect();
    const windowHeight = window.innerHeight;
    const windowWidth = window.innerWidth;

    // Check if scrolled completely out of view
    if (rect.bottom < 0 || rect.top > windowHeight) {
      setSearchOpen(null);
      return;
    }

    const spaceBelow = windowHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    // Open upward if space below is tight (<220px) and above has more room
    const openUpward = spaceBelow < 220 && spaceAbove > spaceBelow;

    const desiredWidth = Math.max(rect.width, 380);
    const minLeft = 8;
    const maxLeft = Math.max(minLeft, windowWidth - desiredWidth - 8);
    const left = Math.max(minLeft, Math.min(rect.left, maxLeft));
    const width = Math.min(desiredWidth, windowWidth - 16);

    if (openUpward) {
      setDropdownPosition({
        bottom: windowHeight - rect.top + 4,
        left,
        width,
        maxHeight: Math.min(260, Math.max(120, spaceAbove - 12)),
      });
    } else {
      setDropdownPosition({
        top: rect.bottom + 4,
        left,
        width,
        maxHeight: Math.min(260, Math.max(120, spaceBelow - 12)),
      });
    }
  }, [searchOpen]);

  useEffect(() => {
    if (searchOpen === null) {
      setDropdownPosition(null);
      return;
    }

    updateDropdownPosition();
    window.addEventListener('scroll', updateDropdownPosition, true);
    window.addEventListener('resize', updateDropdownPosition);
    return () => {
      window.removeEventListener('scroll', updateDropdownPosition, true);
      window.removeEventListener('resize', updateDropdownPosition);
    };
  }, [searchOpen, updateDropdownPosition]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (searchOpen !== null) {
        const inSearchContainer = searchContainerRef.current?.contains(target);
        const inDropdown = dropdownRef.current?.contains(target);
        const inTrigger = triggerRefs.current[searchOpen]?.contains(target);
        if (!inSearchContainer && !inDropdown && !inTrigger) {
          setSearchOpen(null);
          setSearchTerm('');
        }
      }
      if (templateRef.current && !templateRef.current.contains(target)) {
        setTemplateOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [searchOpen]);

  useEffect(() => {
    if (searchOpen !== null && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  const scrollItemIntoView = (index: number) => {
    if (!listRef.current) return;
    const buttons = listRef.current.querySelectorAll<HTMLButtonElement>('button');
    const target = buttons[index];
    if (target) {
      target.scrollIntoView({ block: 'nearest' });
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setSearchOpen(null);
      setSearchTerm('');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(prev => {
        const next = prev < filteredAccounts.length - 1 ? prev + 1 : 0;
        scrollItemIntoView(next);
        return next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => {
        const next = prev > 0 ? prev - 1 : Math.max(0, filteredAccounts.length - 1);
        scrollItemIntoView(next);
        return next;
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredAccounts[highlightedIndex] && searchOpen !== null) {
        selectAccount(searchOpen, filteredAccounts[highlightedIndex]);
      }
    }
  };

  const openAccountSearch = (idx: number) => {
    setSearchOpen(idx);
    setSearchTerm('');
    setHighlightedIndex(0);
  };

  const filteredAccounts = accounts.filter(a => {
    if (!searchTerm) return true;
    const q = searchTerm.toLowerCase();
    return a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
  });

  const updateLine = (index: number, field: keyof JournalLine, value: string | number) => {
    setLines(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      if (field === 'debit' && (value as number) > 0) {
        updated[index].credit = 0;
      } else if (field === 'credit' && (value as number) > 0) {
        updated[index].debit = 0;
      }
      return updated;
    });
  };

  const selectAccount = (index: number, account: Account) => {
    setLines(prev => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        account_id: account.id,
        account_code: account.code,
        account_name: account.name,
      };
      return updated;
    });
    setSearchOpen(null);
    setSearchTerm('');
    setHighlightedIndex(0);
  };

  const removeLine = (index: number) => {
    if (lines.length <= 2) return;
    setLines(prev => prev.filter((_, i) => i !== index));
  };

  const addLine = () => {
    setLines(prev => [...prev, createEmptyLine()]);
  };

  const resetForm = () => {
    setEntryDate(new Date().toISOString().split('T')[0]);
    setNarration('');
    setLines([createEmptyLine(), createEmptyLine()]);
    setEditingEntryId(null);
  };

  const applyTemplate = (template: Template) => {
    const newLines: JournalLine[] = template.lines.map(tl => {
      const acc = accounts.find(a => a.code === tl.accountCode);
      return {
        key: crypto.randomUUID(),
        account_id: acc?.id || '',
        account_code: acc?.code || tl.accountCode,
        account_name: acc?.name || tl.label,
        description: '',
        debit: tl.side === 'debit' ? 0 : 0,
        credit: tl.side === 'credit' ? 0 : 0,
      };
    });
    setNarration(template.description);
    setLines(newLines);
    setTemplateOpen(false);
  };

  const validateBeforePost = (): string | null => {
    if (!hasAccounts) return 'Please select an account for each journal line with an amount';
    if (totalDebit <= 0 && totalCredit <= 0) return 'Please enter at least one debit/credit amount';
    if (!isBalanced) return `Journal is unbalanced. Debit ${formatCurrency(totalDebit)} must equal Credit ${formatCurrency(totalCredit)}`;
    return null;
  };

  const handlePost = async () => {
    const validationError = validateBeforePost();
    if (validationError) {
      showToast({ type: 'error', title: 'Validation Failed', message: validationError });
      return;
    }

    setSaving(true);

    try {
      const entryId = await saveFinanceJournal(
        editingEntryId,
        entryDate,
        narration || null,
        lines
          .filter(l => l.account_id && (l.debit > 0 || l.credit > 0))
          .map(l => ({
            account_id: l.account_id,
            description: l.description || null,
            debit: l.debit || 0,
            credit: l.credit || 0,
          })),
        'IDR',
        1,
      );

      const { data: savedEntry } = await supabase
        .from('journal_entries')
        .select('entry_number')
        .eq('id', entryId)
        .single();
      showToast({
        type: 'success',
        title: editingEntryId ? 'Journal Updated' : 'Journal Posted',
        message: editingEntryId ? 'Entry updated successfully' : `Entry ${savedEntry?.entry_number || ''} posted successfully`,
      });
      resetForm();
      triggerRefresh();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Posting Failed', message: err.message || 'Could not post journal entry' });
    } finally {
      setSaving(false);
    }
  };

  const loadBankAllocationsForEntry = async (entryId: string) => {
    setLoadingBankAllocations(true);
    try {
      const { data, error } = await supabase
        .from('bank_statement_allocations')
        .select(`
          id,
          allocation_amount,
          payment_kind,
          created_at,
          bank_statement_lines (
            id,
            transaction_date,
            description,
            reference,
            debit_amount,
            credit_amount,
            reconciliation_status,
            matching_status,
            bank_account_id,
            bank_accounts (
              id,
              bank_name,
              account_name,
              account_number,
              currency,
              coa_id
            )
          )
        `)
        .or(`journal_entry_id.eq.${entryId},and(document_type.eq.journal,document_id.eq.${entryId})`);

      if (error) throw error;
      const rawAllocs = (data as unknown as LinkedBankAllocation[]) || [];

      const bslIds = [...new Set(rawAllocs.map((a) => a.bank_statement_lines?.id).filter((id): id is string => Boolean(id)))];
      const lineTotalsMap = new Map<string, number>();
      if (bslIds.length > 0) {
        const { data: allLineAllocs } = await supabase
          .from('bank_statement_allocations')
          .select('bank_statement_line_id, allocation_amount, journal_entries(is_posted, is_reversed)')
          .in('bank_statement_line_id', bslIds);

        (allLineAllocs || []).forEach((item: any) => {
          const je = Array.isArray(item.journal_entries) ? item.journal_entries[0] : item.journal_entries;
          if (je && (!je.is_posted || je.is_reversed || je.is_cancelled)) return;
          lineTotalsMap.set(
            item.bank_statement_line_id,
            (lineTotalsMap.get(item.bank_statement_line_id) || 0) + Number(item.allocation_amount || 0)
          );
        });
      }

      const enriched = rawAllocs.map((alloc) => {
        const line = alloc.bank_statement_lines;
        const totalLineAmount = line
          ? Number(line.debit_amount || 0) > 0
            ? Number(line.debit_amount)
            : Number(line.credit_amount || 0)
          : 0;
        const totalAllocated = line ? lineTotalsMap.get(line.id) || Number(alloc.allocation_amount || 0) : 0;
        const remainingUnallocated = Math.max(0, totalLineAmount - totalAllocated);
        return {
          ...alloc,
          totalLineAmount,
          totalAllocated,
          remainingUnallocated,
        };
      });

      setBankAllocations(enriched);
    } catch (err) {
      console.error('Error loading bank allocations for journal entry:', err);
      setBankAllocations([]);
    } finally {
      setLoadingBankAllocations(false);
    }
  };

  const eligibleBankLineForView = useMemo(() => {
    if (!viewEntry || !viewEntry.is_posted || viewEntry.is_reversed || viewEntry.is_cancelled) return null;

    for (const line of viewEntry.lines) {
      const bank = bankAccounts.find((b) => b.coa_id === line.account_id);
      if (bank) {
        const isCredit = Number(line.credit || 0) > 0;
        const lineAmount = isCredit ? Number(line.credit) : Number(line.debit || 0);
        const totalAllocated = bankAllocations.reduce((sum, a) => sum + Number(a.allocation_amount || 0), 0);
        const remainingToAllocate = Math.max(0, lineAmount - totalAllocated);
        if (remainingToAllocate > 0.01) {
          return { bankAccount: bank, isCredit, amount: remainingToAllocate };
        }
      }
    }
    return null;
  }, [viewEntry, bankAllocations, bankAccounts]);

  const openLinkBankModal = async (
    entry: JournalEntry | JournalEntryDetail,
    eligible?: { bankAccount: BankAccount; isCredit: boolean; amount: number } | null
  ) => {
    try {
      let activeEligible = eligible;
      let targetDetail: JournalEntryDetail;

      if ('lines' in entry && entry.lines && entry.lines.length > 0) {
        targetDetail = entry as JournalEntryDetail;
      } else {
        const { data: lineData } = await supabase
          .from('journal_entry_lines')
          .select('line_number, account_id, description, debit, credit, chart_of_accounts(code, name)')
          .eq('journal_entry_id', entry.id)
          .order('line_number');
        targetDetail = { ...entry, lines: (lineData || []) as any };
      }

      if (!activeEligible) {
        for (const line of targetDetail.lines) {
          const bank = bankAccounts.find((b) => b.coa_id === line.account_id);
          if (bank) {
            const isCredit = Number(line.credit || 0) > 0;
            const lineAmount = isCredit ? Number(line.credit) : Number(line.debit || 0);
            if (lineAmount > 0.01) {
              activeEligible = { bankAccount: bank, isCredit, amount: lineAmount };
              break;
            }
          }
        }
      }

      if (!activeEligible) {
        showToast({
          type: 'info',
          title: 'No Bank Movement',
          message: 'No bank account line found on this journal entry to reconcile.',
        });
        return;
      }

      setTargetBankLinkEntry(targetDetail);
      setTargetBankLinkEligible(activeEligible);
      setCandidateSearchTerm('');
      setSelectedCandidateBankLineId('');
      setLoadingCandidateBankLines(true);
      setShowLinkBankModal(true);

      const direction = activeEligible.isCredit ? 'debit' : 'credit';
      const rawCandidates = await loadUnmatchedDebitBankTransactions({
        bankAccountId: activeEligible.bankAccount.id,
        direction,
        includeLinked: false,
      });

      const ranked = rankCandidateLines(rawCandidates, activeEligible.amount, targetDetail.entry_date);
      setCandidateBankLines(ranked);
      if (ranked.length > 0) {
        const best = ranked[0];
        setSelectedCandidateBankLineId(best.id);
        const maxAlloc = Math.min(best.remainingAmount ?? 0, activeEligible.amount);
        setLinkingBankAllocationAmount(maxAlloc);
      }
    } catch (err: any) {
      console.error('Error preparing bank statement link:', err);
      showToast({ type: 'error', title: 'Error', message: err?.message || 'Could not load candidate bank transactions' });
    } finally {
      setLoadingCandidateBankLines(false);
    }
  };

  const filteredCandidateBankLines = useMemo(() => {
    if (!candidateSearchTerm.trim()) return candidateBankLines;
    const term = candidateSearchTerm.trim().toLowerCase();
    return candidateBankLines.filter((l) => {
      const desc = (l.description || '').toLowerCase();
      const ref = (l.reference || '').toLowerCase();
      const date = (l.transaction_date || '').toLowerCase();
      const amountStr = String(l.debit_amount || l.credit_amount || '');
      const remStr = String(l.remainingAmount || '');
      return (
        desc.includes(term) ||
        ref.includes(term) ||
        date.includes(term) ||
        amountStr.includes(term) ||
        remStr.includes(term)
      );
    });
  }, [candidateBankLines, candidateSearchTerm]);

  const handleConfirmBankLink = async () => {
    if (!selectedCandidateBankLineId || !targetBankLinkEntry || linkingBankAllocationAmount <= 0.01) return;
    setSubmittingBankLink(true);
    try {
      await linkBankStatementLine(
        selectedCandidateBankLineId,
        'journal',
        targetBankLinkEntry.id,
        'other',
        linkingBankAllocationAmount
      );
      setShowLinkBankModal(false);
      if (viewModalOpen && viewEntry?.id === targetBankLinkEntry.id) {
        await loadBankAllocationsForEntry(targetBankLinkEntry.id);
      }
      await loadEntries();
      notifyFinanceReconciliationRefresh();
      showToast({ type: 'success', title: 'Bank Linked', message: 'Bank statement linked successfully' });
    } catch (err: any) {
      console.error('Error linking bank statement:', err);
      showToast({ type: 'error', title: 'Link Failed', message: err?.message || 'Unknown error linking bank statement' });
    } finally {
      setSubmittingBankLink(false);
    }
  };

  const viewEntryDetail = async (entry: JournalEntry) => {
    const { data } = await supabase
      .from('journal_entry_lines')
      .select('line_number, account_id, description, debit, credit, chart_of_accounts(code, name)')
      .eq('journal_entry_id', entry.id)
      .order('line_number');

    setViewEntry({ ...entry, lines: (data || []) as any });
    setViewModalOpen(true);
    await loadBankAllocationsForEntry(entry.id);
  };

  const handleEditEntry = async (entry: JournalEntry) => {
    if (entry.is_posted) {
      showToast({
        type: 'error',
        title: 'Cannot Edit',
        message: 'Posted journal entries cannot be edited. Please reverse the entry if corrections are required.',
      });
      return;
    }

    const { data: lineData } = await supabase
      .from('journal_entry_lines')
      .select('line_number, account_id, description, debit, credit, chart_of_accounts(code, name)')
      .eq('journal_entry_id', entry.id)
      .order('line_number');

    if (lineData && lineData.length > 0) {
      setEntryDate(entry.entry_date);
      setNarration(entry.description || '');
      setLines(lineData.map((l: any) => ({
        key: crypto.randomUUID(),
        account_id: l.account_id,
        account_code: l.chart_of_accounts?.code || '',
        account_name: l.chart_of_accounts?.name || '',
        description: l.description || '',
        debit: l.debit || 0,
        credit: l.credit || 0,
      })));
      setEditingEntryId(entry.id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  useEffect(() => {
    if (initialEditEntryId && entries.length > 0) {
      const entry = entries.find(e => e.id === initialEditEntryId);
      if (entry) {
        handleEditEntry(entry);
        onEditComplete?.();
      }
    }
  }, [initialEditEntryId, entries]);

  const handleDeleteEntry = async (entryId: string) => {
    const { showConfirm } = await import('../ConfirmDialog');
    const confirmed = await showConfirm({
      title: 'Delete Journal Entry',
      message: 'Are you sure you want to delete this manual journal entry? This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      const { data: bankLinks } = await supabase
        .from('bank_statement_lines')
        .select('id')
        .eq('matched_entry_id', entryId)
        .limit(1);

      if (bankLinks && bankLinks.length > 0) {
        showToast({ type: 'error', title: 'Cannot Delete', message: 'This entry is linked to a bank statement. Unlink it first from Bank Reconciliation.' });
        return;
      }

      const { error: linesError } = await supabase
        .from('journal_entry_lines')
        .delete()
        .eq('journal_entry_id', entryId);
      if (linesError) throw linesError;

      const { error: entryError } = await supabase
        .from('journal_entries')
        .delete()
        .eq('id', entryId)
        .eq('source_module', 'manual');
      if (entryError) throw entryError;

      showToast({ type: 'success', title: 'Journal Deleted', message: 'Journal entry deleted successfully' });
      loadEntries();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Delete Failed', message: error.message });
    }
  };

  const formatCurrency = (val: number | null | undefined, cur: string = 'IDR') => {
    if (val === null || val === undefined || isNaN(Number(val))) return '-';
    return new Intl.NumberFormat(cur === 'IDR' ? 'id-ID' : 'en-US', {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(Number(val));
  };

  return (
    <div className="flex flex-col gap-1">
      {/* Shared title strip — matches every other Finance page */}
      <div className="flex items-center justify-between h-8 px-2 bg-white border border-gray-200 rounded">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-xs font-bold text-gray-900 truncate">Journal Voucher</h1>
          <span className="text-[10px] text-gray-400 truncate">Manual double-entry journal posting</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <div className="relative" ref={templateRef}>
            <button
              onClick={() => setTemplateOpen(!templateOpen)}
              className="inline-flex items-center gap-1 h-7 px-2 text-xs bg-white hover:bg-gray-50 text-gray-700 rounded border border-gray-300"
            >
              <FileText className="w-3 h-3" />
              Templates
              <ChevronDown className="w-3 h-3" />
            </button>
            {templateOpen && (
              <div className="absolute right-0 top-full mt-1 w-72 bg-white rounded-lg shadow-xl border border-gray-200 z-50 py-1 max-h-80 overflow-y-auto">
                {TEMPLATES.map(t => (
                  <button
                    key={t.name}
                    onClick={() => applyTemplate(t)}
                    className="w-full text-left px-2 py-1.5 hover:bg-blue-50 transition-colors"
                  >
                    <div className="text-xs font-medium text-gray-900">{t.name}</div>
                    <div className="text-[10px] text-gray-500">{t.description}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {canManage && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
          {/* Entry header — SAP B1 layout */}
          <div className="p-2 border-b border-gray-100">
            <SapRow>
              <FloatingField label="Date" required span={4} filled={!!entryDate}>
                <input name="entry_date" aria-label="Entry Date" type="date" value={entryDate}
                  onChange={e => setEntryDate(e.target.value)}
                  className={FLOAT_INPUT} />
              </FloatingField>
              <FloatingField label="Narration" span={8} filled={!!narration}>
                <input name="narration" aria-label="{t.finance.journalNarrationPlaceholder}" type="text" value={narration}
                  onChange={e => setNarration(e.target.value)}
                  placeholder={t.finance.journalNarrationPlaceholder}
                  className={FLOAT_INPUT} />
              </FloatingField>
            </SapRow>
          </div>

          {/* Journal lines grid */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600">
                  <th className="text-center px-2 py-1.5 font-medium w-10">#</th>
                  <th className="text-left px-2 py-1.5 font-medium min-w-[280px]">Account</th>
                  <th className="text-left px-2 py-1.5 font-medium min-w-[160px]">Line Narration</th>
                  <th className="text-right px-2 py-1.5 font-medium w-36">Debit</th>
                  <th className="text-right px-2 py-1.5 font-medium w-36">Credit</th>
                  <th className="text-center px-2 py-1.5 font-medium w-16">Actions</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={line.key} className="border-t border-gray-100 hover:bg-gray-50/50">
                    <td className="px-2 py-1.5 text-gray-400 text-xs text-center align-middle">{idx + 1}</td>
                    <td className="px-2 py-1.5 align-middle">
                      {searchOpen === idx ? (
                        <div
                          ref={searchContainerRef}
                          className="flex items-center h-[34px] border border-blue-500 ring-1 ring-blue-500 rounded-lg bg-white px-2 shadow-sm"
                        >
                          <Search className="w-3.5 h-3.5 text-blue-500 mr-1.5 shrink-0" />
                          <input
                            name="account_search"
                            aria-label="Search account..."
                            ref={searchInputRef}
                            type="text"
                            value={searchTerm}
                            onChange={e => {
                              setSearchTerm(e.target.value);
                              setHighlightedIndex(0);
                            }}
                            onKeyDown={handleSearchKeyDown}
                            placeholder="Search by code or name..."
                            className="w-full h-full text-xs sm:text-sm border-0 p-0 focus:ring-0 focus:outline-none bg-transparent"
                          />
                          <button
                            type="button"
                            onClick={() => { setSearchOpen(null); setSearchTerm(''); }}
                            className="p-0.5 text-gray-400 hover:text-gray-600 shrink-0"
                            title="Close search"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <button
                            ref={el => { triggerRefs.current[idx] = el; }}
                            type="button"
                            onClick={() => openAccountSearch(idx)}
                            className={`flex-1 h-[34px] text-left px-2.5 rounded-lg border transition-colors text-xs sm:text-sm flex items-center justify-between gap-2 ${
                              line.account_id
                                ? 'border-gray-200 bg-white hover:border-gray-300'
                                : 'border-dashed border-gray-300 text-gray-400 hover:border-blue-400 hover:text-blue-500'
                            }`}
                          >
                            {line.account_id ? (
                              <span className="truncate flex items-center gap-1.5">
                                <span className="font-mono text-blue-600 font-medium shrink-0">{line.account_code}</span>
                                <span className="truncate text-gray-800">{line.account_name}</span>
                              </span>
                            ) : (
                              <span className="text-gray-400">Select account...</span>
                            )}
                            <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                          </button>
                          {line.account_id && (
                            <button
                              type="button"
                              onClick={onNavigateToLedger}
                              title="View Ledger"
                              className="p-1 h-[34px] w-[34px] inline-flex items-center justify-center text-gray-400 hover:text-blue-600 rounded-lg hover:bg-gray-100 transition-colors shrink-0"
                            >
                              <BookOpen className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 align-middle">
                      <input
                        name="line"
                        aria-label="Optional line narration"
                        type="text"
                        value={line.description}
                        onChange={e => updateLine(idx, 'description', e.target.value)}
                        placeholder="Optional"
                        className="w-full h-[34px] px-2.5 text-xs sm:text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                      />
                    </td>
                    <td className="px-2 py-1.5 align-middle">
                      <MoneyInput
                        decimal
                        value={line.debit}
                        onChange={amount => updateLine(idx, 'debit', amount)}
                        placeholder="0"
                        className="w-full h-[34px] px-2.5 text-xs sm:text-sm text-right border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 tabular-nums bg-white"
                      />
                    </td>
                    <td className="px-2 py-1.5 align-middle">
                      <MoneyInput
                        decimal
                        value={line.credit}
                        onChange={amount => updateLine(idx, 'credit', amount)}
                        placeholder="0"
                        className="w-full h-[34px] px-2.5 text-xs sm:text-sm text-right border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 tabular-nums bg-white"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center align-middle">
                      <button
                        type="button"
                        onClick={() => removeLine(idx)}
                        disabled={lines.length <= 2}
                        className="p-1 h-[34px] w-[34px] inline-flex items-center justify-center text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors rounded-lg hover:bg-red-50"
                        title={lines.length <= 2 ? 'Minimum 2 lines required' : 'Remove line'}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold text-xs sm:text-sm">
                  <td className="px-2 py-2" colSpan={3}>
                    <button
                      type="button"
                      onClick={addLine}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs sm:text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-md transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add Row
                    </button>
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${totalDebit !== totalCredit ? 'text-red-600' : 'text-gray-900'}`}>
                    {formatCurrency(totalDebit)}
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${totalDebit !== totalCredit ? 'text-red-600' : 'text-gray-900'}`}>
                    {formatCurrency(totalCredit)}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Difference indicator + actions */}
          <div className="px-3 py-2.5 border-t border-gray-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 bg-gray-50/40 rounded-b-xl">
            <div className="text-xs">
              {totalDebit > 0 && !isBalanced && (
                <span className="text-xs text-red-600 font-medium">
                  Difference: {formatCurrency(Math.abs(totalDebit - totalCredit))} {totalDebit > totalCredit ? '(Debit excess)' : '(Credit excess)'}
                </span>
              )}
              {isBalanced && hasAccounts && !editingEntryId && (
                <span className="text-xs text-green-600 font-medium">Balanced - ready to post</span>
              )}
              {editingEntryId && (
                <span className="text-xs text-orange-600 font-medium">Editing mode - make changes and click Update Journal</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={resetForm}
                className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium text-gray-700 hover:text-gray-900 border border-gray-300 rounded-lg hover:bg-gray-100 bg-white transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Clear
              </button>
              <button
                type="button"
                onClick={handlePost}
                disabled={!isBalanced || !hasAccounts || saving}
                className="inline-flex items-center gap-1.5 h-8 px-4 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {saving ? (editingEntryId ? 'Updating...' : 'Posting...') : (editingEntryId ? 'Update Journal' : 'Post Journal')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Existing entries list */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-2 py-1.5 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">{t.finance.journalEntry}</h3>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">
            No manual journal entries in selected date range
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-xs uppercase">
                  <th className="text-left px-2 py-1.5 font-medium">Entry #</th>
                  <th className="text-left px-2 py-1.5 font-medium">Date</th>
                  <th className="text-left px-2 py-1.5 font-medium">Description</th>
                  <th className="text-right px-2 py-1.5 font-medium">Debit</th>
                  <th className="text-right px-2 py-1.5 font-medium">Credit</th>
                  <th className="text-center px-2 py-1.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.id} className="border-t border-gray-100 hover:bg-gray-50/80 transition-colors">
                    <td className="px-2 py-1.5 font-mono text-blue-700 font-medium">
                      <span>{e.entry_number}</span>
                      {e.is_cancelled && (
                        <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold bg-rose-100 text-rose-800 rounded border border-rose-200" title={e.cancellation_reason || 'Cancelled'}>
                          Cancelled
                        </span>
                      )}
                      {e.is_reversed && !e.is_cancelled && (
                        <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800 rounded border border-amber-200">
                          Reversed
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-gray-600">{new Date(e.entry_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                    <td className="px-2 py-1.5 text-gray-800 max-w-xs truncate">{e.description || '-'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(e.total_debit)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(e.total_credit)}</td>
                    <td className="px-2 py-1.5 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <FinanceActionButton
                          action="view"
                          label="View entry details"
                          onClick={() => viewEntryDetail(e)}
                        />
                        {canManage && (
                          <>
                            <FinanceActionButton
                              action="edit"
                              label={e.is_posted ? "Posted journal cannot be edited" : "Edit draft journal entry"}
                              disabled={e.is_posted}
                              onClick={() => !e.is_posted && handleEditEntry(e)}
                            />
                            <FinanceActionButton
                              action="delete"
                              label={e.is_posted ? "Posted journal cannot be deleted" : "Delete draft journal entry"}
                              disabled={e.is_posted}
                              onClick={() => !e.is_posted && handleDeleteEntry(e.id)}
                            />
                          </>
                        )}
                        {canManage && e.is_posted && !e.is_reversed && hasBankGlMap.get(e.id) && (
                          <FinanceActionButton
                            action="bankLink"
                            label="Link Bank Statement"
                            onClick={() => openLinkBankModal(e)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* View detail modal */}
      {viewEntry && (
        <Modal isOpen={viewModalOpen} title={`Journal Entry: ${viewEntry.entry_number}`} onClose={() => setViewModalOpen(false)} size="lg">
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Date:</span>{' '}
                <span className="font-medium">{new Date(viewEntry.entry_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
              </div>
              <div>
                <span className="text-gray-500">Status:</span>{' '}
                <span className={`inline-flex px-2 py-0.5 text-xs rounded-full font-medium ${viewEntry.is_posted ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                  {viewEntry.is_posted ? 'Posted' : 'Draft'}
                </span>
              </div>
            </div>
            {viewEntry.description && (
              <div className="text-sm">
                <span className="text-gray-500">Description:</span>{' '}
                <span className="text-gray-800">{viewEntry.description}</span>
              </div>
            )}

            {/* Bank Reconciliation Section */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                  <Landmark className="w-4 h-4 text-blue-600" />
                  <span>Bank Reconciliation</span>
                </div>
                {bankAllocations.length > 0 ? (
                  <span className="px-2 py-0.5 rounded-full font-medium bg-emerald-100 text-emerald-800 text-[11px] flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Linked to Bank Statement ({bankAllocations.length})
                  </span>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full font-medium bg-slate-200 text-slate-700 text-[11px]">
                      Not Linked
                    </span>
                    {eligibleBankLineForView && canManage && (
                      <button
                        type="button"
                        onClick={() => openLinkBankModal(viewEntry, eligibleBankLineForView)}
                        className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded text-xs flex items-center gap-1 shadow-sm transition-colors"
                      >
                        <Link2 className="w-3.5 h-3.5" />
                        Link Bank Statement
                      </button>
                    )}
                  </div>
                )}
              </div>

              {loadingBankAllocations ? (
                <div className="text-slate-500 text-[11px] py-1">Loading bank reconciliation details...</div>
              ) : bankAllocations.length > 0 ? (
                <div className="space-y-2 pt-1 border-t border-slate-200">
                  {bankAllocations.map((alloc) => {
                    const line = alloc.bank_statement_lines;
                    const bank = line?.bank_accounts;
                    const totalStatementAmount = alloc.totalLineAmount ?? (line
                      ? Number(line.debit_amount || 0) > 0
                        ? Number(line.debit_amount)
                        : Number(line.credit_amount || 0)
                      : 0);
                    const remaining = alloc.remainingUnallocated ?? Math.max(0, totalStatementAmount - Number(alloc.allocation_amount || 0));
                    const currency = bank?.currency || 'IDR';

                    return (
                      <div key={alloc.id} className="bg-white p-3 rounded border border-slate-200 space-y-2 shadow-2xs">
                        <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                          <div>
                            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Bank Account</span>
                            <div className="font-semibold text-slate-900">
                              {bank ? `${bank.bank_name} - ${bank.account_name} (${bank.account_number})` : 'Bank Account'}
                            </div>
                          </div>
                          <div className="text-right">
                            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Statement Date</span>
                            <div className="font-medium text-slate-900">
                              {line?.transaction_date ? new Date(line.transaction_date).toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric' }) : '-'}
                            </div>
                          </div>
                        </div>

                        <div>
                          <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Statement Narration & Reference</span>
                          <div className="text-slate-800 font-mono text-[11px] bg-slate-50 p-2 rounded mt-0.5 border border-slate-100 flex items-start justify-between gap-2">
                            <span className="break-words">{line?.description || '-'}</span>
                            {line?.reference && (
                              <span className="shrink-0 bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded text-[10px] font-semibold border border-blue-200">
                                Ref: {line.reference}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 border-t border-slate-100 text-[11px]">
                          <div>
                            <span className="text-[10px] text-gray-500 uppercase font-medium">Statement Total</span>
                            <div className="font-mono font-semibold text-slate-800">
                              {formatCurrency(totalStatementAmount, currency)}
                            </div>
                          </div>
                          <div>
                            <span className="text-[10px] text-gray-500 uppercase font-medium">Allocated to Journal</span>
                            <div className="font-mono font-semibold text-emerald-700">
                              {formatCurrency(alloc.allocation_amount, currency)}
                            </div>
                          </div>
                          <div>
                            <span className="text-[10px] text-gray-500 uppercase font-medium">Remaining Unallocated</span>
                            <div className={`font-mono font-semibold ${remaining <= 0.01 ? 'text-emerald-600' : 'text-amber-600'}`}>
                              {remaining <= 0.01 ? `${formatCurrency(0, currency)} (Fully Reconciled)` : formatCurrency(remaining, currency)}
                            </div>
                          </div>
                          <div>
                            <span className="text-[10px] text-gray-500 uppercase font-medium">Reconciliation Status</span>
                            <div>
                              <span
                                className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                  line?.reconciliation_status === 'matched'
                                    ? 'bg-green-100 text-green-800 border border-green-200'
                                    : 'bg-amber-100 text-amber-800 border border-amber-200'
                                }`}
                              >
                                {line?.reconciliation_status === 'matched' ? 'Matched' : 'Partially Reconciled'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {line?.id && (
                          <div className="text-[10px] text-slate-400 flex items-center justify-between pt-1 border-t border-slate-55">
                            <span>Transaction Line ID: <code className="text-slate-600 font-mono">{line.id}</code></span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-slate-500 text-[11px]">
                  {eligibleBankLineForView
                    ? `Contains bank movement for ${eligibleBankLineForView.bankAccount.bank_name} (${formatCurrency(eligibleBankLineForView.amount, eligibleBankLineForView.bankAccount.currency)}). Click "Link Bank Statement" to reconcile.`
                    : 'No bank account movement in this journal entry.'}
                </div>
              )}
            </div>
            <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-gray-50 text-gray-600">
                  <th className="text-left px-4 py-2 font-medium">#</th>
                  <th className="text-left px-4 py-2 font-medium">Account</th>
                  <th className="text-left px-4 py-2 font-medium">Description</th>
                  <th className="text-right px-4 py-2 font-medium">Debit</th>
                  <th className="text-right px-4 py-2 font-medium">Credit</th>
                </tr>
              </thead>
              <tbody>
                {viewEntry.lines.map(l => (
                  <tr key={l.line_number} className="border-t border-gray-100">
                    <td className="px-4 py-2 text-gray-400">{l.line_number}</td>
                    <td className="px-4 py-2">
                      <span className="font-mono text-blue-600 mr-1">{l.chart_of_accounts?.code}</span>
                      {l.chart_of_accounts?.name}
                    </td>
                    <td className="px-4 py-2 text-gray-600">{l.description || '-'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{l.debit > 0 ? formatCurrency(l.debit) : '-'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{l.credit > 0 ? formatCurrency(l.credit) : '-'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                  <td colSpan={3} className="px-4 py-2 text-right">Total</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(viewEntry.total_debit)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(viewEntry.total_credit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Modal>
      )}

      {/* Link Bank Statement Modal */}
      <Modal
        isOpen={showLinkBankModal}
        onClose={() => setShowLinkBankModal(false)}
        title={`Link Bank Statement: ${targetBankLinkEntry?.entry_number || ''}`}
        size="lg"
      >
        <div className="space-y-3 text-xs">
          {targetBankLinkEligible && (
            <div className="p-2.5 bg-blue-50 border border-blue-200 rounded-lg flex items-center justify-between">
              <div>
                <span className="text-blue-900 font-medium">
                  {targetBankLinkEligible.bankAccount.bank_name} ({targetBankLinkEligible.bankAccount.account_number})
                </span>
                <div className="text-blue-700 text-[11px]">
                  Side: <strong>{targetBankLinkEligible.isCredit ? 'Credit (Bank Withdrawal)' : 'Debit (Bank Deposit)'}</strong>
                </div>
              </div>
              <div className="text-right">
                <span className="text-[10px] text-blue-600 uppercase font-semibold">Target Amount</span>
                <div className="font-mono font-bold text-blue-900 text-sm">
                  {formatCurrency(targetBankLinkEligible.amount, targetBankLinkEligible.bankAccount.currency)}
                </div>
              </div>
            </div>
          )}

          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-gray-400" />
            <input
              type="text"
              placeholder="Search candidate statement lines by narration, reference, or amount..."
              value={candidateSearchTerm}
              onChange={(e) => setCandidateSearchTerm(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 border rounded text-xs"
            />
          </div>

          {loadingCandidateBankLines ? (
            <div className="text-center py-6 text-gray-500">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-1 text-blue-600" />
              Loading candidate statement lines...
            </div>
          ) : filteredCandidateBankLines.length === 0 ? (
            <div className="text-center py-6 text-gray-500 border rounded-lg bg-gray-50">
              No unmatched bank statement lines found matching criteria.
            </div>
          ) : (
            <div className="max-h-60 overflow-y-auto border rounded-lg divide-y">
              {filteredCandidateBankLines.map((line) => {
                const isSelected = selectedCandidateBankLineId === line.id;
                const rem = line.remainingAmount ?? 0;
                const isExact = targetBankLinkEligible && Math.abs(rem - targetBankLinkEligible.amount) < 0.01;
                return (
                  <div
                    key={line.id}
                    onClick={() => {
                      setSelectedCandidateBankLineId(line.id);
                      if (targetBankLinkEligible) {
                        setLinkingBankAllocationAmount(Math.min(rem, targetBankLinkEligible.amount));
                      }
                    }}
                    className={`p-2.5 cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-50 border-l-4 border-blue-600' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-gray-900 font-mono text-[11px]">{line.description}</span>
                          {isExact && (
                            <span className="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                              Exact Match
                            </span>
                          )}
                        </div>
                        <div className="text-gray-500 text-[10px]">
                          {new Date(line.transaction_date).toLocaleDateString('id-ID')}
                          {line.reference ? ` • Ref: ${line.reference}` : ''}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono font-semibold text-gray-900">
                          {formatCurrency(line.debit_amount || line.credit_amount, targetBankLinkEligible?.bankAccount.currency || 'IDR')}
                        </div>
                        <div className="text-[10px] text-amber-700 font-medium">
                          Rem: {formatCurrency(rem, targetBankLinkEligible?.bankAccount.currency || 'IDR')}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {selectedCandidateBankLineId && targetBankLinkEligible && (
            <div className="p-2.5 bg-gray-50 border rounded-lg space-y-2">
              <div className="flex justify-between items-center">
                <span className="font-medium text-gray-700">Allocation Amount:</span>
                <span className="text-gray-500 text-[11px]">
                  Max: <strong className="font-mono text-blue-700">
                    {(() => {
                      const sel = candidateBankLines.find((l) => l.id === selectedCandidateBankLineId);
                      return formatCurrency(Math.min(sel?.remainingAmount || 0, targetBankLinkEligible.amount), targetBankLinkEligible.bankAccount.currency);
                    })()}
                  </strong>
                </span>
              </div>
              <input
                type="number"
                min="1"
                step="any"
                value={linkingBankAllocationAmount || ''}
                onChange={(e) => {
                  const sel = candidateBankLines.find((l) => l.id === selectedCandidateBankLineId);
                  const max = Math.min(sel?.remainingAmount || 0, targetBankLinkEligible.amount);
                  setLinkingBankAllocationAmount(Math.min(parseFloat(e.target.value) || 0, max));
                }}
                className="w-full px-2.5 py-1.5 border rounded text-xs font-mono font-medium"
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowLinkBankModal(false)}
              className="px-3 py-1.5 border rounded text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={submittingBankLink || !selectedCandidateBankLineId || linkingBankAllocationAmount <= 0.01}
              onClick={handleConfirmBankLink}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded font-medium shadow-sm"
            >
              {submittingBankLink ? 'Linking…' : 'Link Statement'}
            </button>
          </div>
        </div>
      </Modal>
      {/* Account selection portal dropdown */}
      {searchOpen !== null && dropdownPosition && createPortal(
        <div
          ref={dropdownRef}
          data-journal-account-dropdown
          style={{
            position: 'fixed',
            ...(dropdownPosition.top !== undefined ? { top: `${dropdownPosition.top}px` } : {}),
            ...(dropdownPosition.bottom !== undefined ? { bottom: `${dropdownPosition.bottom}px` } : {}),
            left: `${dropdownPosition.left}px`,
            width: `${dropdownPosition.width}px`,
            zIndex: 9999,
          }}
          className="bg-white rounded-lg shadow-2xl border border-gray-200 overflow-hidden flex flex-col"
        >
          <div className="px-2.5 py-1 bg-gray-50 border-b border-gray-100 flex items-center justify-between text-[11px] text-gray-500 select-none">
            <span>{filteredAccounts.length} account{filteredAccounts.length === 1 ? '' : 's'}</span>
            <span className="text-[10px] text-gray-400">↑↓ to navigate · Enter to select · Esc to close</span>
          </div>
          <div
            ref={listRef}
            style={{ maxHeight: `${dropdownPosition.maxHeight}px` }}
            className="overflow-y-auto divide-y divide-gray-50"
          >
            {filteredAccounts.length === 0 ? (
              <div className="px-3 py-3 text-xs text-gray-400 text-center">
                No accounts found{searchTerm ? ` matching "${searchTerm}"` : ''}
              </div>
            ) : (
              filteredAccounts.map((acc, accIdx) => {
                const isHighlighted = accIdx === highlightedIndex;
                return (
                  <button
                    key={acc.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectAccount(searchOpen, acc);
                    }}
                    onMouseEnter={() => setHighlightedIndex(accIdx)}
                    className={`w-full text-left px-2.5 py-1.5 min-h-[34px] flex items-center gap-2 transition-colors ${
                      isHighlighted ? 'bg-blue-50 text-blue-900' : 'hover:bg-gray-50 text-gray-800'
                    }`}
                  >
                    <span className="text-xs font-mono font-medium text-blue-600 bg-blue-50/80 border border-blue-200/60 px-1.5 py-0.5 rounded shrink-0">
                      {acc.code}
                    </span>
                    <span className="text-xs sm:text-sm font-medium truncate flex-1">
                      {acc.name}
                    </span>
                    <span className="text-[11px] text-gray-400 bg-gray-100/80 px-1.5 py-0.5 rounded shrink-0 font-normal">
                      {acc.account_type}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
